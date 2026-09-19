import hashlib
import json
import os
import unittest
from decimal import Decimal
from unittest.mock import patch

import httpx
from fastapi.testclient import TestClient

from backend.billing import calculate_cost, estimate_reservation
from backend.main import UserCreate, app
from pydantic import ValidationError

PRICE = {'provider': 'openai', 'input': Decimal('2'), 'cached_input': Decimal('0.5'), 'output': Decimal('8')}


class BillingTests(unittest.TestCase):
    def test_vpn_address_requires_valid_ip_and_prefix(self):
        user = UserCreate(name='Test User', email='TEST@example.com', department='Engineering', vpn_cidr='10.10.9.7/255.255.255.0', monthly_limit=10)
        self.assertEqual(user.vpn_cidr, '10.10.9.7/24')
        with self.assertRaises(ValidationError):
            UserCreate(name='Test User', email='test@example.com', department='Engineering', vpn_cidr='10.10.999.7/24', monthly_limit=10)

    def test_openai_cached_tokens_are_not_double_charged(self):
        i, o, cost = calculate_cost('openai', {'prompt_tokens': 1000, 'completion_tokens': 200, 'prompt_tokens_details': {'cached_tokens': 600}}, PRICE)
        self.assertEqual((i, o, cost), (1000, 200, Decimal('0.00270000')))

    def test_anthropic_cached_input_is_additional(self):
        self.assertEqual(calculate_cost('anthropic', {'input_tokens': 400, 'output_tokens': 200, 'cache_read_input_tokens': 600}, PRICE), (1000, 200, Decimal('0.00270000')))

    def test_missing_or_invalid_usage_never_becomes_zero_cost(self):
        for usage in ({}, {'prompt_tokens': -1, 'completion_tokens': 2}, {'prompt_tokens': 1, 'completion_tokens': True}, {'prompt_tokens': 2, 'completion_tokens': 1, 'prompt_tokens_details': {'cached_tokens': 3}}):
            with self.assertRaises((KeyError, ValueError)):
                calculate_cost('openai', usage, PRICE)
        with self.assertRaises(ValueError):
            calculate_cost('anthropic', {'input_tokens': 5, 'output_tokens': 3, 'cache_creation_input_tokens': 50}, PRICE)

    def test_reserve_accounts_for_utf8_and_output_limit(self):
        amount = estimate_reservation([{'role': 'user', 'content': 'Привет'}], None, 100, PRICE)
        self.assertEqual(amount, Decimal('0.00140000'))


class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.reject = None
        self.upstream_mode = 'success'
        self.settlement_failure = False
        self.env = patch.dict(os.environ, {'SUPABASE_URL': 'https://example.supabase.co', 'SUPABASE_KEY': 'server-secret', 'OPENAI_API_KEY': 'master-secret', 'ANTHROPIC_API_KEY': 'anthropic-secret'})
        self.env.start()
        self.client = TestClient(app, client=('10.10.9.7', 50000))
        self.client.__enter__()
        self.original_client = app.state.client
        app.state.client = httpx.AsyncClient(transport=httpx.MockTransport(self.handler))
        app.state.prices = {'test-model': PRICE, 'test-claude': {**PRICE, 'provider': 'anthropic'}}

    def tearDown(self):
        self.client.portal.call(self.original_client.aclose)
        self.client.__exit__(None, None, None)
        self.env.stop()

    def handler(self, req):
        body = json.loads(req.content) if req.content else {}
        self.calls.append((str(req.url), dict(req.headers), body))
        if req.url.path == '/auth/v1/user':
            role = 'admin' if req.headers.get('authorization') == 'Bearer admin-token' else 'member'
            return httpx.Response(200, json={'app_metadata': {'role': role}, 'user_metadata': {'role': 'admin'}})
        if req.url.path.endswith('/reserve_request'):
            if self.reject:
                return httpx.Response(400, json={'message': self.reject})
            return httpx.Response(200, json='00000000-0000-0000-0000-000000000001')
        if req.url.path.endswith('/settle_request'):
            return httpx.Response(503 if self.settlement_failure else 200, json={} if self.settlement_failure else None)
        if req.url.host == 'api.anthropic.com':
            return httpx.Response(200, json={'content': [{'type': 'text', 'text': 'Hello'}], 'usage': {'input_tokens': 400, 'output_tokens': 200, 'cache_read_input_tokens': 600}})
        if req.url.host == 'api.openai.com':
            if self.upstream_mode == 'timeout':
                raise httpx.ReadTimeout('sensitive-provider-error', request=req)
            if self.upstream_mode == 'error':
                return httpx.Response(400, json={'error': 'prompt and master-secret'})
            if self.upstream_mode == 'server_error':
                return httpx.Response(500, json={'error': 'master-secret'})
            if self.upstream_mode == 'provider_timeout':
                return httpx.Response(408, json={'error': 'master-secret'})
            if self.upstream_mode == 'missing_usage':
                return httpx.Response(200, json={'choices': [{'message': {'content': 'Hello'}}]})
            return httpx.Response(200, json={'choices': [{'message': {'content': 'Hello'}}], 'usage': {'prompt_tokens': 1000, 'completion_tokens': 200}}, headers={'x-request-id': 'provider-123'})
        return httpx.Response(200, json=[])

    def post(self, **overrides):
        return self.client.post('/v1/chat/completions', headers={'Authorization': 'Bearer act_virtual-secret'}, json={'model': 'test-model', 'messages': [{'role': 'user', 'content': 'private prompt'}], 'max_completion_tokens': 256, **overrides})

    def test_proxy_substitutes_key_and_persists_only_metadata(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['x-accounting-status'], 'settled')
        self.assertEqual(response.json()['choices'][0]['message']['content'], 'Hello')
        provider = next(c for c in self.calls if 'api.openai.com' in c[0])
        self.assertEqual(provider[1]['authorization'], 'Bearer master-secret')
        self.assertFalse(provider[2]['store'])
        db_calls = [c for c in self.calls if 'supabase' in c[0]]
        stored = json.dumps([c[2] for c in db_calls])
        self.assertNotIn('private prompt', stored)
        self.assertNotIn('virtual-secret', stored)
        self.assertNotIn('master-secret', stored)
        self.assertEqual(db_calls[0][2]['p_key_hash'], hashlib.sha256(b'act_virtual-secret').hexdigest())
        self.assertEqual(db_calls[0][2]['p_source_ip'], '10.10.9.7')
        self.assertEqual(Decimal(db_calls[-1][2]['p_cost']), Decimal('0.00360000'))

    def test_quarantine_budget_and_invalid_key_block_before_provider(self):
        for error, expected in [('quarantined', 403), ('budget_exceeded', 429), ('invalid_key', 401), ('ip_not_allowed', 403), ('vpn_not_configured', 403)]:
            self.calls.clear(); self.reject = error
            self.assertEqual(self.post().status_code, expected)
            self.assertFalse(any('api.openai.com' in c[0] for c in self.calls))

    def test_unsupported_requests_are_rejected_without_reflecting_prompt(self):
        for body in ({'stream': True}, {'tools': []}, {'model': 'unknown'}, {'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': 'private prompt'}]}]}, {'max_tokens': 30}):
            self.calls.clear()
            response = self.post(**body)
            self.assertIn(response.status_code, [400, 422])
            self.assertNotIn('private prompt', response.text)
            self.assertEqual(self.calls, [])

    def test_timeout_and_uncertain_usage_retain_reservation(self):
        for mode, expected in [('timeout', 504), ('server_error', 502), ('provider_timeout', 502), ('missing_usage', 200)]:
            self.calls.clear(); self.upstream_mode = mode
            response = self.post()
            self.assertEqual(response.status_code, expected)
            self.assertEqual(response.headers['x-accounting-status'], 'pending')
            self.assertFalse(any('settle_request' in c[0] for c in self.calls))
            self.assertNotIn('master-secret', response.text)

    def test_explicit_provider_rejection_releases_reservation_and_redacts_error(self):
        self.upstream_mode = 'error'
        response = self.post()
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('master-secret', response.text)
        self.assertEqual(self.calls[-1][2]['p_status'], 'error')
        self.assertEqual(self.calls[-1][2]['p_cost'], '0')

    def test_settlement_failure_returns_original_response_with_pending_header(self):
        self.settlement_failure = True
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['x-accounting-status'], 'pending')

    def test_admin_requires_trusted_app_metadata(self):
        self.assertEqual(self.client.get('/api/dashboard').status_code, 401)
        self.assertEqual(self.client.get('/api/dashboard', headers={'Authorization': 'Bearer member-token'}).status_code, 403)
        self.assertEqual(self.client.get('/api/dashboard', headers={'Authorization': 'Bearer admin-token'}).status_code, 200)

    def test_request_body_limit(self):
        response = self.post(messages=[{'role': 'user', 'content': 'x' * 270000}])
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.calls, [])

    def test_anthropic_uses_provider_headers_and_cached_usage(self):
        response = self.client.post('/v1/messages', headers={'x-api-key': 'act_virtual-secret'}, json={
            'model': 'test-claude', 'system': 'private system', 'messages': [{'role': 'user', 'content': 'private prompt'}], 'max_tokens': 256})
        self.assertEqual(response.status_code, 200)
        provider = next(c for c in self.calls if 'api.anthropic.com' in c[0])
        self.assertEqual(provider[1]['x-api-key'], 'anthropic-secret')
        self.assertEqual(provider[1]['anthropic-version'], '2023-06-01')
        self.assertNotIn('authorization', provider[1])
        self.assertEqual(self.calls[-1][2]['p_input'], 1000)
        self.assertEqual(Decimal(self.calls[-1][2]['p_cost']), Decimal('0.00270000'))
        self.assertNotIn('private', json.dumps(self.calls[-1][2]))

    def test_anthropic_rejects_invalid_roles_before_reserving(self):
        response = self.client.post('/v1/messages', headers={'x-api-key': 'act_virtual-secret'}, json={
            'model': 'test-claude', 'messages': [{'role': 'system', 'content': 'private system'}], 'max_tokens': 256})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()

import asyncio
import hashlib
import json
import logging
import os
import secrets
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from ipaddress import ip_address, ip_interface, ip_network
from pathlib import Path
from typing import Literal
from uuid import UUID, uuid4

import httpx
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator

try:
    from .billing import calculate_cost, estimate_reservation
except ImportError:
    from billing import calculate_cost, estimate_reservation

BASE = Path(__file__).resolve().parent
load_dotenv(BASE / '.env')
logger = logging.getLogger('ai_cost_tracker')
# HTTP client debug logging can contain auth URLs; keep application logs metadata-only.
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)


def load_prices() -> dict:
    path = BASE / os.getenv('PRICING_FILE', 'pricing.json')
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding='utf-8-sig'))
    prices = {}
    for model, rate in data.items():
        if rate['provider'] not in ('openai', 'anthropic') or not isinstance(model, str):
            raise ValueError('Invalid pricing configuration')
        prices[model] = {'provider': rate['provider']}
        for key in ('input', 'cached_input', 'output'):
            value = Decimal(str(rate[key]))
            if not value.is_finite() or value < 0:
                raise ValueError('Rates must be finite and non-negative')
            prices[model][key] = value
    return prices


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.prices = load_prices()
    app.state.client = httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10), follow_redirects=False)
    yield
    await app.state.client.aclose()


app = FastAPI(title='AI Cost Tracker', version='0.1.0', lifespan=lifespan)
app.add_middleware(CORSMiddleware,
    allow_origins=[s.strip() for s in os.getenv('CORS_ORIGINS', 'http://localhost:5173,http://127.0.0.1:5173').split(',') if s.strip()],
    allow_methods=['GET', 'POST', 'PATCH'], allow_headers=['Authorization', 'Content-Type', 'x-api-key', 'anthropic-version'],
    expose_headers=['X-Request-ID', 'X-Accounting-Status'])


class BodySizeLimit:
    """Enforce the actual streamed size before JSON parsing, including chunked bodies."""
    def __init__(self, app, limit=262144):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http' or scope['method'] not in ('POST', 'PATCH'):
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            size += len(message.get('body', b''))
            if size > self.limit:
                return await JSONResponse({'detail': 'Максимальный размер запроса — 256 КБ.'}, 413)(scope, receive, send)
            chunks.append(message)
            if not message.get('more_body', False):
                break
        async def replay():
            return chunks.pop(0) if chunks else await receive()
        await self.app(scope, replay, send)


app.add_middleware(BodySizeLimit)


@app.exception_handler(RequestValidationError)
async def validation_error(_request, _error):
    # Pydantic errors normally echo invalid input (possibly a prompt or key).
    return JSONResponse({'detail': 'Некорректный формат запроса. Проверьте /docs. Поддерживаются только текстовые сообщения без stream и tools.'}, 422)


def config() -> tuple[str, str]:
    url, key = os.getenv('SUPABASE_URL', '').rstrip('/'), os.getenv('SUPABASE_KEY', '')
    if not url or not key:
        raise HTTPException(503, 'Supabase ещё не настроен на сервере.')
    if not url.startswith('https://') and not url.startswith(('http://127.0.0.1:', 'http://localhost:')):
        raise HTTPException(503, 'SUPABASE_URL должен использовать HTTPS.')
    return url, key


async def db(method: str, path: str, *, params=None, body=None):
    url, key = config()
    try:
        response = await app.state.client.request(method, f'{url}/rest/v1/{path}',
            headers={'apikey': key, 'Authorization': f'Bearer {key}', 'Prefer': 'return=representation'},
            params=params, json=body, timeout=20)
    except httpx.RequestError:
        raise HTTPException(503, 'База данных временно недоступна.') from None
    if response.is_error:
        # Only match our fixed database exception codes; never reflect database text.
        code = response.json().get('message', '') if response.headers.get('content-type', '').startswith('application/json') else ''
        if code == 'invalid_key':
            raise HTTPException(401, 'Виртуальный ключ недействителен.')
        if code == 'quarantined':
            raise HTTPException(403, 'Ключ отключён администратором.')
        if code == 'vpn_not_configured':
            raise HTTPException(403, 'Для сотрудника не настроен VPN IP.')
        if code == 'ip_not_allowed':
            raise HTTPException(403, 'Запрос отклонён: IP-адрес не совпадает с VPN IP сотрудника.')
        if code == 'budget_exceeded':
            raise HTTPException(429, 'Недостаточно месячного бюджета для резерва запроса.')
        if response.status_code == 409:
            raise HTTPException(409, 'Запись уже существует.')
        raise HTTPException(503, 'Не удалось выполнить операцию с базой данных.')
    return response.json() if response.content else None


async def admin(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith('Bearer '):
        raise HTTPException(401, 'Требуется вход администратора.')
    url, key = config()
    try:
        response = await app.state.client.get(f'{url}/auth/v1/user', headers={'apikey': key, 'Authorization': authorization}, timeout=15)
    except httpx.RequestError:
        raise HTTPException(503, 'Сервис авторизации временно недоступен.') from None
    if response.status_code != 200:
        raise HTTPException(401, 'Сессия истекла. Войдите снова.')
    if response.json().get('app_metadata', {}).get('role') != 'admin':
        raise HTTPException(403, 'Для доступа требуется роль admin в app_metadata.')


def normalize_vpn_cidr(value: str) -> str:
    try:
        return str(ip_interface(value))
    except ValueError:
        raise ValueError('VPN IP должен содержать корректный адрес и маску, например 10.10.9.7/24.') from None


def normalize_company_range(value: str) -> str:
    try:
        return str(ip_network(value, strict=False))
    except ValueError:
        raise ValueError('Диапазон VPN должен быть в формате сети, например 10.10.9.0/24.') from None


class VpnSettings(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    vpn_cidr: str = Field(min_length=3, max_length=49)

    _normalize = field_validator('vpn_cidr')(normalize_company_range)


async def company_range() -> str | None:
    rows = await db('GET', 'app_settings', params={'select': 'vpn_cidr', 'id': 'eq.true'})
    return rows[0]['vpn_cidr'] if rows else None


async def check_in_company_range(vpn_cidr: str):
    network = await company_range()
    if network is None:
        raise HTTPException(422, 'Сначала задайте диапазон VPN компании.')
    if ip_interface(vpn_cidr).ip not in ip_network(network):
        raise HTTPException(422, f'VPN IP сотрудника должен входить в диапазон компании {network}.')


class UserCreate(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    name: str = Field(min_length=2, max_length=100)
    email: str = Field(min_length=3, max_length=254, pattern=r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
    department: str = Field(min_length=1, max_length=80)
    vpn_cidr: str | None = Field(default=None, min_length=3, max_length=49)
    monthly_limit: Decimal = Field(ge=0, le=1_000_000, max_digits=12, decimal_places=2)

    @field_validator('email')
    @classmethod
    def lower_email(cls, value):
        return value.lower()

    _normalize_vpn_cidr = field_validator('vpn_cidr')(lambda value: value if value is None else normalize_vpn_cidr(value))


class UserPatch(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    status: Literal['active', 'quarantined'] | None = None
    vpn_cidr: str | None = Field(default=None, min_length=3, max_length=49)
    monthly_limit: Decimal | None = Field(default=None, ge=0, le=1_000_000, max_digits=12, decimal_places=2)

    _normalize_vpn_cidr = field_validator('vpn_cidr')(normalize_vpn_cidr)


@app.get('/health')
async def health():
    return {'status': 'ok'}


async def read_pages(path, params, limit=20000):
    rows = []
    while len(rows) < limit:
        batch = await db('GET', path, params={**params, 'offset': len(rows), 'limit': min(1000, limit - len(rows))})
        rows.extend(batch)
        # Supabase may impose a lower max-rows; paginate until an empty page.
        if not batch:
            return rows, False
    return rows, True


@app.get('/api/dashboard', dependencies=[Depends(admin)])
async def dashboard():
    start = (datetime.now(timezone.utc) - timedelta(days=59)).replace(hour=0, minute=0, second=0, microsecond=0)
    (users, users_truncated), (logs, logs_truncated) = await asyncio.gather(
        read_pages('user_finances', {'select': '*', 'order': 'created_at.desc,id.desc'}, 5000),
        read_pages('api_logs', {'select': 'id,user_id,provider,model,input_tokens,output_tokens,cost_usd,status,created_at,latency_ms', 'created_at': f'gte.{start.isoformat()}', 'order': 'created_at.desc,id.desc'}))
    settings = {'vpn_cidr': await company_range()}
    return {'users': users, 'logs': logs, 'settings': settings, 'prices': [dict(model=model, **rate) for model, rate in app.state.prices.items()],
        'providers': {'openai': bool(os.getenv('OPENAI_API_KEY')), 'anthropic': bool(os.getenv('ANTHROPIC_API_KEY'))},
        'truncated': users_truncated or logs_truncated}


@app.post('/api/users', dependencies=[Depends(admin)], status_code=201)
async def create_user(body: UserCreate):
    if body.vpn_cidr:
        await check_in_company_range(body.vpn_cidr)
    key = 'act_' + secrets.token_urlsafe(32)
    data = jsonable_encoder(body, exclude_none=True)
    data.update(key_hash=hashlib.sha256(key.encode()).hexdigest(), key_prefix=key[:12])
    result = await db('POST', 'users', body=data)
    rows = await db('GET', 'user_finances', params={'id': f'eq.{result[0]["id"]}'})
    return JSONResponse(jsonable_encoder({'user': rows[0], 'key': key}), status_code=201, headers={'Cache-Control': 'no-store'})


@app.patch('/api/settings/vpn', dependencies=[Depends(admin)])
async def update_vpn_settings(body: VpnSettings):
    rows = await db('POST', 'app_settings', params={'on_conflict': 'id'}, body={'id': True, 'vpn_cidr': body.vpn_cidr, 'updated_at': datetime.now(timezone.utc).isoformat()})
    return {'vpn_cidr': rows[0]['vpn_cidr']}


@app.patch('/api/users/{user_id}', dependencies=[Depends(admin)])
async def patch_user(user_id: UUID, body: UserPatch):
    patch = jsonable_encoder(body.model_dump(exclude_none=True))
    if not patch:
        raise HTTPException(422, 'Укажите статус, VPN IP или лимит.')
    if 'vpn_cidr' in patch:
        await check_in_company_range(patch['vpn_cidr'])
    rows = await db('PATCH', 'users', params={'id': f'eq.{user_id}', 'select': 'id'}, body=patch)
    if not rows:
        raise HTTPException(404, 'Сотрудник не найден.')
    return (await db('GET', 'user_finances', params={'id': f'eq.{user_id}'}))[0]


class Message(BaseModel):
    model_config = ConfigDict(extra='forbid')
    role: Literal['system', 'developer', 'user', 'assistant']
    content: str = Field(max_length=200000)


class Completion(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model: str = Field(min_length=1, max_length=150, pattern=r'^[A-Za-z0-9._:-]+$')
    messages: list[Message] = Field(min_length=1, max_length=100)
    stream: Literal[False] = False
    max_completion_tokens: int | None = Field(default=None, ge=1, le=16384, strict=True)
    max_tokens: int | None = Field(default=None, ge=1, le=16384, strict=True)
    temperature: float | None = Field(default=None, ge=0, le=2)
    system: str | None = Field(default=None, max_length=200000)


async def finalize(request_id: str, status: str, input_tokens=0, output_tokens=0, cost=Decimal(0), latency_ms=0, provider_request_id=None) -> bool:
    try:
        await db('POST', 'rpc/settle_request', body={'p_id': request_id, 'p_status': status,
            'p_input': input_tokens, 'p_output': output_tokens, 'p_cost': str(cost),
            'p_latency': latency_ms, 'p_provider_request_id': provider_request_id})
        return True
    except HTTPException:
        logger.error('accounting_pending request_id=%s', request_id)
        return False


async def proxy(provider: str, body: Completion, source_ip: str, authorization: str | None, x_api_key: str | None = None):
    key = authorization.removeprefix('Bearer ') if authorization and authorization.startswith('Bearer ') else x_api_key
    if not key or not key.startswith('act_') or len(key) > 128:
        raise HTTPException(401, 'Укажите виртуальный ключ act_ в Authorization: Bearer или x-api-key.')
    price = app.state.prices.get(body.model)
    if not price or price['provider'] != provider:
        raise HTTPException(400, 'Модель отсутствует в настроенных тарифах этого провайдера.')
    master_key = os.getenv('OPENAI_API_KEY' if provider == 'openai' else 'ANTHROPIC_API_KEY')
    if not master_key:
        raise HTTPException(503, 'Провайдер ещё не настроен.')
    if body.max_tokens is not None and body.max_completion_tokens is not None:
        raise HTTPException(422, 'Укажите только один лимит выходных токенов.')
    payload = body.model_dump(exclude_none=True)
    output_limit = body.max_completion_tokens or body.max_tokens or 1024
    if provider == 'openai':
        if body.system is not None:
            raise HTTPException(422, 'Для OpenAI передайте system как сообщение.')
        if body.max_tokens is None:
            payload['max_completion_tokens'] = output_limit
        payload['store'] = False
        url = 'https://api.openai.com/v1/chat/completions'
        headers = {'Authorization': f'Bearer {master_key}'}
    else:
        if body.max_completion_tokens is not None or any(m.role not in ('user', 'assistant') for m in body.messages) or (body.temperature is not None and body.temperature > 1):
            raise HTTPException(422, 'Anthropic: используйте max_tokens, system отдельно и роли user/assistant; temperature ≤ 1.')
        payload['max_tokens'] = output_limit
        url = 'https://api.anthropic.com/v1/messages'
        headers = {'x-api-key': master_key, 'anthropic-version': '2023-06-01'}
    request_id = str(uuid4())
    reservation = estimate_reservation(payload['messages'], body.system, output_limit, price)
    await db('POST', 'rpc/reserve_request', body={'p_key_hash': hashlib.sha256(key.encode()).hexdigest(),
        'p_id': request_id, 'p_provider': provider, 'p_model': body.model, 'p_reserve': str(reservation),
        'p_rates': {k: str(v) for k, v in price.items() if k != 'provider'}, 'p_source_ip': source_ip})
    start = time.monotonic()
    try:
        upstream = await app.state.client.post(url, headers=headers, json=payload)
    except httpx.RequestError:
        # The provider may have accepted the request: retain the reservation.
        logger.warning('upstream_outcome_unknown request_id=%s', request_id)
        return JSONResponse({'error': {'message': 'Ответ провайдера не получен. Резерв сохранён до сверки; повторный запрос может списать средства повторно.', 'request_id': request_id}}, 504,
            headers={'X-Request-ID': request_id, 'X-Accounting-Status': 'pending'})
    latency = round((time.monotonic() - start) * 1000)
    provider_id = upstream.headers.get('x-request-id') or upstream.headers.get('request-id')
    response_headers = {'X-Request-ID': request_id, 'Cache-Control': 'no-store'}
    if upstream.status_code >= 300:
        # Only explicit client rejections are safe to release. 5xx can be ambiguous.
        released = False
        if 400 <= upstream.status_code < 500 and upstream.status_code != 408:
            released = await finalize(request_id, 'error', latency_ms=latency, provider_request_id=provider_id)
        response_headers['X-Accounting-Status'] = 'settled' if released else 'pending'
        status_code = 429 if upstream.status_code == 429 else 502
        return JSONResponse({'error': {'message': 'Провайдер отклонил запрос или недоступен.', 'request_id': request_id, 'provider_status': upstream.status_code}}, status_code, headers=response_headers)
    try:
        result = upstream.json()
        input_tokens, output_tokens, cost = calculate_cost(provider, result['usage'], price)
        settled = await finalize(request_id, 'success', input_tokens, output_tokens, cost, latency, provider_id)
    except (ValueError, KeyError, TypeError, AttributeError):
        # Never treat absent or unrecognised usage as zero spend.
        settled = False
        logger.warning('usage_requires_reconciliation request_id=%s', request_id)
    response_headers['X-Accounting-Status'] = 'settled' if settled else 'pending'
    return Response(content=upstream.content, media_type='application/json', headers=response_headers, status_code=upstream.status_code)


@app.post('/v1/chat/completions')
async def chat_completions(body: Completion, request: Request, authorization: str | None = Header(default=None)):
    try:
        source_ip = str(ip_address(request.client.host if request.client else ''))
    except ValueError:
        raise HTTPException(403, 'Не удалось определить IP-адрес подключения.') from None
    return await proxy('openai', body, source_ip, authorization)


@app.post('/v1/messages')
async def messages(body: Completion, request: Request, authorization: str | None = Header(default=None), x_api_key: str | None = Header(default=None)):
    try:
        source_ip = str(ip_address(request.client.host if request.client else ''))
    except ValueError:
        raise HTTPException(403, 'Не удалось определить IP-адрес подключения.') from None
    return await proxy('anthropic', body, source_ip, authorization, x_api_key)

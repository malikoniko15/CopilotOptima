"""Money is Decimal throughout; example rates are never loaded automatically."""
from decimal import Decimal, ROUND_CEILING, ROUND_HALF_UP

MILLION = Decimal(1_000_000)
PRECISION = Decimal('0.00000001')


def token_count(value: object) -> int:
    if type(value) is not int or value < 0:
        raise ValueError('Invalid token usage')
    return value


def calculate_cost(provider: str, usage: dict, price: dict) -> tuple[int, int, Decimal]:
    if provider == 'openai':
        input_tokens = token_count(usage['prompt_tokens'])
        output_tokens = token_count(usage['completion_tokens'])
        cached = token_count((usage.get('prompt_tokens_details') or {}).get('cached_tokens', 0))
        if cached > input_tokens:
            raise ValueError('Cached tokens exceed input')
        standard = input_tokens - cached
    else:
        standard = token_count(usage['input_tokens'])
        output_tokens = token_count(usage['output_tokens'])
        cached = token_count(usage.get('cache_read_input_tokens', 0))
        # This MVP cannot request cache writes. Never silently underbill unknown usage.
        if token_count(usage.get('cache_creation_input_tokens', 0)):
            raise ValueError('Cache creation requires reconciliation')
        input_tokens = standard + cached
    amount = (standard * price['input'] + cached * price['cached_input'] + output_tokens * price['output']) / MILLION
    return input_tokens, output_tokens, amount.quantize(PRECISION, rounding=ROUND_HALF_UP)


def estimate_reservation(messages: list[dict], system: str | None, output_limit: int, price: dict) -> Decimal:
    # Conservative estimate for plain text only; not a tokenizer guarantee.
    input_estimate = 256 + sum(len(m['content'].encode('utf-8')) + 32 for m in messages)
    if system:
        input_estimate += len(system.encode('utf-8')) + 32
    return ((input_estimate * max(price['input'], price['cached_input']) + output_limit * price['output']) / MILLION).quantize(PRECISION, rounding=ROUND_CEILING)

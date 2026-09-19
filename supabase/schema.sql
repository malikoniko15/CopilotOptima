-- Run once in the Supabase SQL Editor, using the postgres role.
begin;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 100),
  email text not null unique,
  department text not null,
  key_hash text not null unique check (char_length(key_hash) = 64),
  key_prefix text not null,
  vpn_cidr inet,
  status text not null default 'active' check (status in ('active', 'quarantined')),
  monthly_limit numeric(14,2) not null default 100 check (monthly_limit >= 0),
  created_at timestamptz not null default now()
);

create table public.api_logs (
  id uuid primary key,
  user_id uuid not null references public.users(id),
  provider text not null check (provider in ('openai', 'anthropic')),
  model text not null,
  input_tokens bigint not null default 0 check (input_tokens >= 0),
  output_tokens bigint not null default 0 check (output_tokens >= 0),
  cost_usd numeric(20,8) not null default 0 check (cost_usd >= 0),
  reserved_usd numeric(20,8) not null check (reserved_usd >= 0),
  status text not null default 'pending' check (status in ('pending', 'success', 'error')),
  rates jsonb not null,
  provider_request_id text,
  latency_ms integer not null default 0 check (latency_ms >= 0),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index api_logs_user_time on public.api_logs(user_id, created_at desc);
create index api_logs_time on public.api_logs(created_at desc, id desc);
create index api_logs_pending on public.api_logs(user_id) where status = 'pending';

alter table public.users enable row level security;
alter table public.api_logs enable row level security;
-- Browser clients have no direct table access, including authenticated admins.
-- Company-wide VPN range; employee VPN IPs must fall inside it.
create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  vpn_cidr cidr,
  updated_at timestamptz not null default now()
);
insert into public.app_settings(id) values (true) on conflict do nothing;
revoke all on public.app_settings from anon, authenticated;
grant select, insert, update on public.app_settings to service_role;

-- The backend verifies Supabase Auth before using service_role.
revoke all on public.users, public.api_logs from anon, authenticated;
grant select, insert, update on public.users, public.api_logs to service_role;

create view public.user_finances with (security_invoker = true) as
select u.id, u.name, u.email, u.department, u.key_prefix, u.vpn_cidr, u.status, u.monthly_limit, u.created_at,
  coalesce(sum(l.cost_usd) filter (where l.status = 'success' and l.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'), 0) as monthly_spend,
  coalesce(sum(l.reserved_usd) filter (where l.status = 'pending'), 0) as reserved,
  max(l.created_at) as last_active
from public.users u left join public.api_logs l on l.user_id = u.id
group by u.id;
revoke all on public.user_finances from anon, authenticated;
grant select on public.user_finances to service_role;

create function public.reserve_request(p_key_hash text, p_id uuid, p_provider text, p_model text, p_reserve numeric, p_rates jsonb, p_source_ip inet)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  employee public.users%rowtype;
  committed numeric;
begin
  if p_reserve < 0 or p_reserve is null then raise exception 'invalid_reserve'; end if;
  -- Every admission and settlement locks the same employee row.
  select * into employee from public.users where key_hash = p_key_hash for update;
  if not found then raise exception 'invalid_key'; end if;
  if employee.status <> 'active' then raise exception 'quarantined'; end if;
  if employee.vpn_cidr is null then raise exception 'vpn_not_configured'; end if;
  if p_source_ip is null or host(p_source_ip) <> host(employee.vpn_cidr) then raise exception 'ip_not_allowed'; end if;
  select coalesce(sum(case
    when status = 'pending' then reserved_usd
    when status = 'success' and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' then cost_usd
    else 0 end), 0) into committed from public.api_logs where user_id = employee.id;
  if employee.monthly_limit <= 0 or committed + p_reserve > employee.monthly_limit then
    raise exception 'budget_exceeded';
  end if;
  insert into public.api_logs(id, user_id, provider, model, reserved_usd, rates)
    values (p_id, employee.id, p_provider, p_model, p_reserve, p_rates);
  return employee.id;
end;
$$;

create function public.settle_request(p_id uuid, p_status text, p_input bigint, p_output bigint, p_cost numeric, p_latency integer, p_provider_request_id text)
returns void language plpgsql security invoker set search_path = '' as $$
declare employee_id uuid;
begin
  if p_status not in ('success', 'error') or p_status is null or p_cost < 0 or p_cost is null or p_input < 0 or p_output < 0 then
    raise exception 'invalid_settlement';
  end if;
  select user_id into employee_id from public.api_logs where id = p_id;
  if not found then raise exception 'unknown_request'; end if;
  perform id from public.users where id = employee_id for update;
  -- Idempotent settlement: retries can never double-charge.
  update public.api_logs set status = p_status, input_tokens = p_input, output_tokens = p_output,
    cost_usd = p_cost, reserved_usd = 0, latency_ms = p_latency,
    provider_request_id = p_provider_request_id, settled_at = now()
  where id = p_id and status = 'pending';
end;
$$;

revoke all on function public.reserve_request(text, uuid, text, text, numeric, jsonb, inet) from public, anon, authenticated;
revoke all on function public.settle_request(uuid, text, bigint, bigint, numeric, integer, text) from public, anon, authenticated;
grant execute on function public.reserve_request(text, uuid, text, text, numeric, jsonb, inet) to service_role;
grant execute on function public.settle_request(uuid, text, bigint, bigint, numeric, integer, text) to service_role;

commit;

-- Create an admin in Authentication > Users, then run (replace the email):
-- update auth.users set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
--   || '{"role":"admin"}'::jsonb where email = 'admin@your-company.com';
-- Sign out/in after assigning the role. Never assign it via raw_user_meta_data.

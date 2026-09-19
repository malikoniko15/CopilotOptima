-- Run once for an existing installation created before VPN IP checks were added.
-- Existing employees are blocked from new LLM requests until vpn_cidr is configured.
begin;

alter table public.users add column if not exists vpn_cidr inet;

create table if not exists public.app_settings (
  id boolean primary key default true check (id),
  vpn_cidr cidr,
  updated_at timestamptz not null default now()
);
insert into public.app_settings(id) values (true) on conflict do nothing;
revoke all on public.app_settings from anon, authenticated;
grant select, insert, update on public.app_settings to service_role;


drop view if exists public.user_finances;
create view public.user_finances with (security_invoker = true) as
select u.id, u.name, u.email, u.department, u.key_prefix, u.status, u.monthly_limit, u.created_at,
  coalesce(sum(l.cost_usd) filter (where l.status = 'success' and l.created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'), 0) as monthly_spend,
  coalesce(sum(l.reserved_usd) filter (where l.status = 'pending'), 0) as reserved,
  max(l.created_at) as last_active,
  u.vpn_cidr
from public.users u left join public.api_logs l on l.user_id = u.id
group by u.id;
revoke all on public.user_finances from anon, authenticated;
grant select on public.user_finances to service_role;

drop function if exists public.reserve_request(text, uuid, text, text, numeric, jsonb);

create function public.reserve_request(p_key_hash text, p_id uuid, p_provider text, p_model text, p_reserve numeric, p_rates jsonb, p_source_ip inet)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  employee public.users%rowtype;
  committed numeric;
begin
  if p_reserve < 0 or p_reserve is null then raise exception 'invalid_reserve'; end if;
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

revoke all on function public.reserve_request(text, uuid, text, text, numeric, jsonb, inet) from public, anon, authenticated;
grant execute on function public.reserve_request(text, uuid, text, text, numeric, jsonb, inet) to service_role;

commit;

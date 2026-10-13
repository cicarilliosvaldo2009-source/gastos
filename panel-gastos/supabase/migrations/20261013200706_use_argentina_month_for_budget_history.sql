create or replace function gastos.capture_monthly_budget()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into gastos.monthly_budgets (user_id, month_start, monthly_limit)
  values (
    new.user_id,
    date_trunc('month', now() at time zone 'America/Argentina/Buenos_Aires')::date,
    new.monthly_limit
  )
  on conflict (user_id, month_start)
  do update set monthly_limit = excluded.monthly_limit, updated_at = now();
  return new;
end;
$$;

revoke all on function gastos.capture_monthly_budget() from public, anon, authenticated;
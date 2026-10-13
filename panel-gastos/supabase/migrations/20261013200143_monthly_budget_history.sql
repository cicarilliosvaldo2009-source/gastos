create table gastos.monthly_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  month_start date not null check (extract(day from month_start) = 1),
  monthly_limit numeric not null check (monthly_limit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month_start)
);

alter table gastos.monthly_budgets enable row level security;

create policy "select propios presupuestos mensuales" on gastos.monthly_budgets
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert propios presupuestos mensuales" on gastos.monthly_budgets
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "update propios presupuestos mensuales" on gastos.monthly_budgets
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

grant select, insert, update on table gastos.monthly_budgets to authenticated;

create or replace function gastos.capture_monthly_budget()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into gastos.monthly_budgets (user_id, month_start, monthly_limit)
  values (new.user_id, date_trunc('month', current_date)::date, new.monthly_limit)
  on conflict (user_id, month_start)
  do update set monthly_limit = excluded.monthly_limit, updated_at = now();
  return new;
end;
$$;

revoke all on function gastos.capture_monthly_budget() from public, anon, authenticated;

create trigger settings_capture_monthly_budget
  after insert or update of monthly_limit on gastos.settings
  for each row execute function gastos.capture_monthly_budget();

insert into gastos.monthly_budgets (user_id, month_start, monthly_limit)
select user_id, date_trunc('month', current_date)::date, monthly_limit
from gastos.settings
on conflict (user_id, month_start) do nothing;

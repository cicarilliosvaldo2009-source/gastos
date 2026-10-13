-- Ejecutá este script en el SQL Editor de tu proyecto de Supabase EXISTENTE
-- (el mismo que ya usás para la cursada, por ejemplo). Todo lo de esta app
-- vive en su propio esquema "gastos", separado de tus otras tablas, así que
-- no hay riesgo de choque de nombres ni de tocar nada de la otra app.

create extension if not exists "pgcrypto";

create schema if not exists gastos;

-- Categorías de gasto (con su presupuesto mensual)
create table if not exists gastos.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null,
  icon text not null,
  color text not null,
  budget numeric not null default 0,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

-- Débitos mensuales sin fecha de finalización, pausables por el usuario.
create table if not exists gastos.recurring_expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id uuid references gastos.categories (id) on delete set null,
  description text not null,
  amount numeric not null check (amount > 0),
  start_month date not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Gastos individuales
create table if not exists gastos.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id uuid references gastos.categories (id) on delete set null,
  description text not null,
  amount numeric not null check (amount > 0),
  date date not null,
  -- Identificador del movimiento de Mercado Pago, para impedir importaciones duplicadas.
  external_id text,
  -- Los movimientos de negocio se conservan, pero pueden excluirse del presupuesto personal.
  excluded_from_budget boolean not null default false,
  -- Los movimientos automáticos sin categoría confiable pasan a la bandeja de revisión.
  needs_review boolean not null default false,
  installment_plan_id uuid,
  installment_number integer,
  installment_total integer,
  recurring_expense_id uuid references gastos.recurring_expenses (id) on delete set null,
  -- Origen: carga manual, Mercado Pago, cuotas de tarjeta o débito automático.
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

-- Aplicable también sobre instalaciones existentes. Los valores NULL de gastos
-- anteriores/manuales pueden coexistir; los movimientos de MP se identifican.
alter table gastos.transactions add column if not exists external_id text;
alter table gastos.transactions add column if not exists excluded_from_budget boolean not null default false;
alter table gastos.transactions add column if not exists needs_review boolean not null default false;
alter table gastos.transactions add column if not exists installment_plan_id uuid;
alter table gastos.transactions add column if not exists installment_number integer;
alter table gastos.transactions add column if not exists installment_total integer;
alter table gastos.transactions add column if not exists recurring_expense_id uuid references gastos.recurring_expenses (id) on delete set null;
create unique index if not exists transactions_user_external_id_uidx
  on gastos.transactions (user_id, external_id);

-- Reglas de categorización automática: si la descripción de un gasto
-- contiene "keyword", se le asigna category_id sola.
create table if not exists gastos.category_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  keyword text not null,
  category_id uuid not null references gastos.categories (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Guarda qué reporte de Mercado Pago fue el último ya procesado.
create table if not exists gastos.sync_state (
  id text primary key,
  last_file_name text,
  synced_at timestamptz
);

-- Límite mensual global de gastos, configurable por cada usuario.
create table if not exists gastos.settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  monthly_limit numeric not null check (monthly_limit > 0),
  created_at timestamptz not null default now(),
  unique (user_id)
);

-- Historial del límite mensual para que los sobrantes pasados no cambien.
create table if not exists gastos.monthly_budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  month_start date not null check (extract(day from month_start) = 1),
  monthly_limit numeric not null check (monthly_limit > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, month_start)
);

alter table gastos.categories enable row level security;
alter table gastos.transactions enable row level security;
alter table gastos.category_rules enable row level security;
alter table gastos.sync_state enable row level security;
alter table gastos.settings enable row level security;
alter table gastos.monthly_budgets enable row level security;
alter table gastos.recurring_expenses enable row level security;

create policy "select propias categorias" on gastos.categories
  for select using (auth.uid() = user_id);
create policy "insert propias categorias" on gastos.categories
  for insert with check (auth.uid() = user_id);
create policy "update propias categorias" on gastos.categories
  for update using (auth.uid() = user_id);
create policy "delete propias categorias" on gastos.categories
  for delete using (auth.uid() = user_id);

create policy "select propios gastos" on gastos.transactions
  for select using (auth.uid() = user_id);
create policy "insert propios gastos" on gastos.transactions
  for insert with check (auth.uid() = user_id);
create policy "update propios gastos" on gastos.transactions
  for update using (auth.uid() = user_id);
create policy "delete propios gastos" on gastos.transactions
  for delete using (auth.uid() = user_id);

create policy "select propias reglas" on gastos.category_rules
  for select using (auth.uid() = user_id);
create policy "insert propias reglas" on gastos.category_rules
  for insert with check (auth.uid() = user_id);
create policy "delete propias reglas" on gastos.category_rules
  for delete using (auth.uid() = user_id);

create policy "select propia configuracion" on gastos.settings
  for select using (auth.uid() = user_id);
create policy "insert propia configuracion" on gastos.settings
  for insert with check (auth.uid() = user_id);
create policy "update propia configuracion" on gastos.settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "select propios presupuestos mensuales" on gastos.monthly_budgets
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "insert propios presupuestos mensuales" on gastos.monthly_budgets
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "update propios presupuestos mensuales" on gastos.monthly_budgets
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "select propios debitos automaticos" on gastos.recurring_expenses
  for select using (auth.uid() = user_id);
create policy "insert propios debitos automaticos" on gastos.recurring_expenses
  for insert with check (auth.uid() = user_id);
create policy "update propios debitos automaticos" on gastos.recurring_expenses
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- sync_state no tiene políticas: solo la Edge Function (service role,
-- que ignora RLS) la lee y escribe.

-- Supabase solo expone por la Data API lo que tiene permisos explícitos
-- de Postgres (esto es obligatorio para cualquier esquema que no sea
-- "public", y desde fines de 2026 también para proyectos existentes).
grant usage on schema gastos to anon, authenticated, service_role;
grant all on all tables in schema gastos to anon, authenticated, service_role;

grant select, insert, update on table gastos.monthly_budgets to authenticated;

create or replace function gastos.capture_monthly_budget()
returns trigger
language plpgsql
set search_path = ''
as $
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
$;

revoke all on function gastos.capture_monthly_budget() from public, anon, authenticated;

create trigger settings_capture_monthly_budget
  after insert or update of monthly_limit on gastos.settings
  for each row execute function gastos.capture_monthly_budget();

insert into gastos.monthly_budgets (user_id, month_start, monthly_limit)
select user_id, date_trunc('month', current_date)::date, monthly_limit
from gastos.settings
on conflict (user_id, month_start) do nothing;


grant all on all sequences in schema gastos to anon, authenticated, service_role;
alter default privileges in schema gastos grant all on tables to anon, authenticated, service_role;
alter default privileges in schema gastos grant all on sequences to anon, authenticated, service_role;

-- Nota: las categorías por defecto (Comida, Transporte, Servicios, Ocio,
-- Salud, Otros) las crea la propia app la primera vez que entrás, si
-- todavía no tenés ninguna cargada. No hace falta insertarlas a mano acá.

-- ============================================================
-- Fase 2: sincronización automática con Mercado Pago
-- ============================================================
-- Ejecutá esto DESPUÉS de deployar la Edge Function "sync-mercadopago"
-- (supabase functions deploy sync-mercadopago), reemplazando:
--   <PROJECT_REF>      por el ID de tu proyecto (está en la URL del panel)
--   <SERVICE_ROLE_KEY>  por la "service_role" key de Settings > API
-- para que se ejecute sola todos los días a las 8am (hora de Argentina),
-- dos horas después de la generación configurada en Mercado Pago.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Reemplaza una programación previa del mismo nombre si ya existía.
select cron.unschedule(jobid)
from cron.job
where jobname = 'sync-mercadopago-daily';

select cron.schedule(
  'sync-mercadopago-daily',
  '0 11 * * *',
  $$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-mercadopago',
    headers := jsonb_build_object(
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Para desactivarlo más adelante: select cron.unschedule('sync-mercadopago-daily');

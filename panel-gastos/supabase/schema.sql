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

-- Gastos individuales
create table if not exists gastos.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id uuid references gastos.categories (id) on delete set null,
  description text not null,
  amount numeric not null check (amount > 0),
  date date not null,
  -- 'manual' = lo cargaste vos con el botón +
  -- 'mercadopago' = lo insertó la sincronización automática (fase 2)
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

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

alter table gastos.categories enable row level security;
alter table gastos.transactions enable row level security;
alter table gastos.category_rules enable row level security;
alter table gastos.sync_state enable row level security;

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

-- sync_state no tiene políticas: solo la Edge Function (service role,
-- que ignora RLS) la lee y escribe.

-- Supabase solo expone por la Data API lo que tiene permisos explícitos
-- de Postgres (esto es obligatorio para cualquier esquema que no sea
-- "public", y desde fines de 2026 también para proyectos existentes).
grant usage on schema gastos to anon, authenticated, service_role;
grant all on all tables in schema gastos to anon, authenticated, service_role;
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
-- para que se ejecute sola todos los días a las 9am (hora UTC).

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sync-mercadopago-daily',
  '0 9 * * *',
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

-- Ejecutar este script una vez en el SQL Editor de tu proyecto de Supabase.

create extension if not exists "pgcrypto";

-- Categorías de gasto (con su presupuesto mensual)
create table if not exists categories (
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
create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category_id uuid references categories (id) on delete set null,
  description text not null,
  amount numeric not null check (amount > 0),
  date date not null,
  -- 'manual' = lo cargaste vos con el botón +
  -- 'mercadopago' = lo va a insertar la sincronización automática (fase 2)
  source text not null default 'manual',
  created_at timestamptz not null default now()
);

alter table categories enable row level security;
alter table transactions enable row level security;

create policy "select propias categorias" on categories
  for select using (auth.uid() = user_id);
create policy "insert propias categorias" on categories
  for insert with check (auth.uid() = user_id);
create policy "update propias categorias" on categories
  for update using (auth.uid() = user_id);
create policy "delete propias categorias" on categories
  for delete using (auth.uid() = user_id);

create policy "select propios gastos" on transactions
  for select using (auth.uid() = user_id);
create policy "insert propios gastos" on transactions
  for insert with check (auth.uid() = user_id);
create policy "update propios gastos" on transactions
  for update using (auth.uid() = user_id);
create policy "delete propios gastos" on transactions
  for delete using (auth.uid() = user_id);

-- Reglas de categorización automática: si la descripción de un gasto
-- contiene "keyword", se le asigna category_id solo (se puede cambiar
-- a mano después desde la app).
create table if not exists category_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  keyword text not null,
  category_id uuid not null references categories (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table category_rules enable row level security;

create policy "select propias reglas" on category_rules
  for select using (auth.uid() = user_id);
create policy "insert propias reglas" on category_rules
  for insert with check (auth.uid() = user_id);
create policy "delete propias reglas" on category_rules
  for delete using (auth.uid() = user_id);

-- Nota: las categorías por defecto (Comida, Transporte, Servicios, Ocio, Salud,
-- Otros) las crea la propia app la primera vez que entrás, si todavía no tenés
-- ninguna cargada. No hace falta insertarlas a mano acá.

-- ============================================================
-- Fase 2: sincronización automática con Mercado Pago
-- ============================================================

-- Guarda qué reporte de Mercado Pago fue el último que ya procesamos,
-- para no cargar los mismos gastos dos veces.
create table if not exists sync_state (
  id text primary key,
  last_file_name text,
  synced_at timestamptz
);
alter table sync_state enable row level security;
-- Sin políticas: solo la Edge Function (que usa la service role key,
-- que ignora RLS) puede leer o escribir acá.

-- Ejecutá esto DESPUÉS de deployar la Edge Function "sync-mercadopago"
-- (supabase functions deploy sync-mercadopago), reemplazando:
--   <PROJECT_REF>    por el ID de tu proyecto (está en la URL del panel)
--   <SERVICE_ROLE_KEY> por la "service_role" key de Settings > API
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

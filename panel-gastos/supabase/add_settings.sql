-- Crear la configuración de presupuesto por usuario si todavía no existe.
create table if not exists gastos.settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  monthly_limit numeric not null check (monthly_limit > 0),
  created_at timestamptz not null default now(),
  unique (user_id)
);

alter table gastos.settings enable row level security;

drop policy if exists "select propia configuracion" on gastos.settings;
create policy "select propia configuracion" on gastos.settings
  for select using (auth.uid() = user_id);

drop policy if exists "insert propia configuracion" on gastos.settings;
create policy "insert propia configuracion" on gastos.settings
  for insert with check (auth.uid() = user_id);

drop policy if exists "update propia configuracion" on gastos.settings;
create policy "update propia configuracion" on gastos.settings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant all on gastos.settings to anon, authenticated, service_role;

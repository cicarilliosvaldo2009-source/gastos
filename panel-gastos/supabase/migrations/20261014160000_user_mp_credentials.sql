-- Store each user's Mercado Pago token where the browser cannot read it.
create table if not exists gastos.mercadopago_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  access_token text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table gastos.mercadopago_credentials enable row level security;
revoke all on table gastos.mercadopago_credentials from public, anon, authenticated;
grant select, insert, update, delete on table gastos.mercadopago_credentials to service_role;

-- The sync status is readable only by its owner and writable only by the Edge Function.
create table if not exists gastos.mercadopago_sync_status (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_checked_at timestamptz,
  last_status text not null default 'unknown'
    check (last_status in ('unknown', 'success', 'error')),
  imported_count integer not null default 0 check (imported_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  last_message text,
  updated_at timestamptz not null default now()
);

alter table gastos.mercadopago_sync_status enable row level security;
revoke all on table gastos.mercadopago_sync_status from public, anon, authenticated;
grant select on table gastos.mercadopago_sync_status to authenticated;
grant select, insert, update on table gastos.mercadopago_sync_status to service_role;

drop policy if exists "Users can view their own Mercado Pago sync status"
  on gastos.mercadopago_sync_status;
create policy "Users can view their own Mercado Pago sync status"
  on gastos.mercadopago_sync_status
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

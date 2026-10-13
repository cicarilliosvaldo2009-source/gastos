-- Ejecutar una vez en el SQL Editor de Supabase para actualizar una instalación
-- existente. Permite que la carga manual y la sincronización automática
-- identifiquen cada movimiento y eviten duplicados.
alter table gastos.transactions
  add column if not exists external_id text;

create unique index if not exists transactions_user_external_id_uidx
  on gastos.transactions (user_id, external_id);

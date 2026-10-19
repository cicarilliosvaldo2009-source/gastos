alter table gastos.transactions
  add column if not exists occurred_at timestamptz,
  add column if not exists counterpart_account text,
  add column if not exists mp_external_reference text;

comment on column gastos.transactions.occurred_at is
  'Fecha y hora original del movimiento, recibida de Mercado Pago.';
comment on column gastos.transactions.counterpart_account is
  'Datos de la cuenta de destino informados por el reporte de retiros de Mercado Pago.';
comment on column gastos.transactions.mp_external_reference is
  'Referencia externa de Mercado Pago para enriquecer datos del movimiento.';

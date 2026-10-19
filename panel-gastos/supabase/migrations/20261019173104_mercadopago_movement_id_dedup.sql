alter table gastos.mercadopago_omitted_rows
  drop constraint if exists mercadopago_omitted_rows_omission_reason_check;

alter table gastos.mercadopago_omitted_rows
  add constraint mercadopago_omitted_rows_omission_reason_check
  check (omission_reason in (
    'non_expense',
    'invalid_amount',
    'invalid_date',
    'missing_operation_id',
    'duplicate_operation_id'
  ));

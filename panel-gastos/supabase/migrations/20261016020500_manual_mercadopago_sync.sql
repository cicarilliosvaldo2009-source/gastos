create extension if not exists supabase_vault with schema vault;

create table if not exists gastos.mercadopago_manual_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id bigint,
  requested_at timestamptz not null default now(),
  begin_date timestamptz not null,
  end_date timestamptz not null,
  ready_at timestamptz,
  processed_at timestamptz,
  status text not null default 'requesting'
    check (status in ('requesting', 'pending', 'processing', 'completed', 'failed')),
  imported_count integer not null default 0 check (imported_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  last_message text,
  updated_at timestamptz not null default now(),
  constraint mercadopago_manual_sync_jobs_user_task_key unique (user_id, task_id),
  constraint mercadopago_manual_sync_jobs_date_range_check check (end_date >= begin_date)
);

create unique index if not exists mercadopago_manual_sync_jobs_one_active_per_user
  on gastos.mercadopago_manual_sync_jobs(user_id)
  where status in ('requesting', 'pending', 'processing');

create index if not exists mercadopago_manual_sync_jobs_due_idx
  on gastos.mercadopago_manual_sync_jobs(status, ready_at)
  where status in ('pending', 'processing');

alter table gastos.mercadopago_manual_sync_jobs enable row level security;
revoke all on gastos.mercadopago_manual_sync_jobs from public, anon, authenticated;
grant all on gastos.mercadopago_manual_sync_jobs to service_role;

do $setup$
declare
  service_key text;
begin
  if not exists (
    select 1 from vault.secrets
    where name = 'gastos_manual_sync_service_role_key'
  ) then
    select (regexp_match(command, $$'Authorization',\s*'Bearer\s+([^']+)'$$))[1]
      into service_key
    from cron.job
    where jobname = 'sync-mercadopago-daily'
      and active
    limit 1;

    if service_key is null then
      raise exception 'No se encontró el token interno del job diario de sincronización.';
    end if;

    perform vault.create_secret(
      service_key,
      'gastos_manual_sync_service_role_key',
      'Token interno para ejecutar las tareas manuales de Mercado Pago.'
    );
  end if;
end
$setup$;

do $schedule$
begin
  perform cron.unschedule(jobid)
  from cron.job
  where jobname = 'sync-mercadopago-manual-worker';

  perform cron.schedule(
    'sync-mercadopago-manual-worker',
    '* * * * *',
    $job$
      select net.http_post(
        url := 'https://mdywfsrpiyhdnnjqteay.supabase.co/functions/v1/sync-mercadopago',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (
            select decrypted_secret
            from vault.decrypted_secrets
            where name = 'gastos_manual_sync_service_role_key'
            limit 1
          )
        ),
        body := '{"action":"process-manual-sync-jobs"}'::jsonb,
        timeout_milliseconds := 10000
      );
    $job$
  );
end
$schedule$;

-- Reconcile infra for Supabase Edge Function: reconcile-calls
-- 1) Run this in SQL Editor once.
-- 2) Replace <<CRON_SECRET>> below with the same secret configured via `supabase secrets set`.

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.reconcile_runs (
  id bigint generated always as identity primary key,
  status text not null check (status in ('running','ok','error')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  checked_count int not null default 0,
  reconciled_count int not null default 0,
  error_text text
);

create unique index if not exists uq_reconcile_single_running
on public.reconcile_runs (status)
where status = 'running';

create table if not exists public.reconcile_event_outbox (
  id bigint generated always as identity primary key,
  call_sid text not null,
  event text not null check (event in ('call.completed','call.missed')),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);

create index if not exists idx_reconcile_outbox_pending
on public.reconcile_event_outbox (created_at)
where delivered_at is null;

-- Remove previous job (if exists)
do $$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname = 'reconcile-calls-every-3m'
  loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

-- Schedule every 3 minutes
select cron.schedule(
  'reconcile-calls-every-3m',
  '*/3 * * * *',
  $$
  select net.http_post(
    url := 'https://paugdcqmjpygrjucdjwi.supabase.co/functions/v1/reconcile-calls',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<<CRON_SECRET>>'
    ),
    body := '{}'::jsonb
  );
  $$
);

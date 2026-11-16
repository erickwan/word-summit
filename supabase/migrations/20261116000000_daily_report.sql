-- Daily progress report to the parent. pg_cron invokes the daily-report edge
-- function at 15:10 and 16:10 UTC; the function only sends during the 7am
-- America/Los_Angeles hour, so exactly one of the two fires does anything and
-- the local send time survives DST. report_log caps it at one email per day and
-- is written only via the service role key.

create table if not exists public.report_log (
  day     date primary key,
  sent_at timestamptz not null default now()
);
alter table public.report_log enable row level security;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'daily-progress-report') then
    perform cron.unschedule('daily-progress-report');
  end if;
  perform cron.schedule(
    'daily-progress-report',
    '10 15,16 * * *',
    $job$
    select net.http_post(
      url := 'https://ywoaeadxfettakxehsel.supabase.co/functions/v1/daily-report',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
    $job$
  );
end
$do$;

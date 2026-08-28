-- Daily practice reminder: pg_cron invokes the practice-reminder edge
-- function at 01:30 and 02:30 UTC. The function itself only sends during
-- the 6pm America/Los_Angeles hour, so exactly one of the two fires does
-- anything and the local send time survives DST changes. reminder_log
-- caps it at one email per day; written only via the service role key.

create table if not exists public.reminder_log (
  day date primary key,
  sent_at timestamptz not null default now()
);
alter table public.reminder_log enable row level security;

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $do$
begin
  if exists (select 1 from cron.job where jobname = 'evia-practice-reminder') then
    perform cron.unschedule('evia-practice-reminder');
  end if;
  perform cron.schedule(
    'evia-practice-reminder',
    '30 1,2 * * *',
    $job$
    select net.http_post(
      url := 'https://ywoaeadxfettakxehsel.supabase.co/functions/v1/practice-reminder',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
    $job$
  );
end
$do$;

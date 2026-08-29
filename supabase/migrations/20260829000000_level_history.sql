-- Daily level snapshot, recorded server-side.
--
-- The apps used to keep this inside their own state blob, but a device running
-- an older cached build posts its whole state on save and silently dropped the
-- history for everyone. Recording it here instead means no client can erase it:
-- the table is written only by the edge functions via the service role key, and
-- has no policies, so anon/publishable keys cannot read or write it at all.

create table if not exists public.level_history (
  child    text not null,
  day      date not null,
  needs    int  not null,
  learning int  not null,
  mastered int  not null,
  primary key (child, day)
);
alter table public.level_history enable row level security;

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 04:40 and 05:40 UTC is 21:40 America/Los_Angeles either side of a DST shift;
-- the function is idempotent for the day, so the second fire is a no-op.
do $do$
begin
  if exists (select 1 from cron.job where jobname = 'level-history-snapshot') then
    perform cron.unschedule('level-history-snapshot');
  end if;
  perform cron.schedule(
    'level-history-snapshot',
    '40 4,5 * * *',
    $job$
    select net.http_post(
      url := 'https://ywoaeadxfettakxehsel.supabase.co/functions/v1/snapshot-levels',
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body := '{}'::jsonb
    );
    $job$
  );
end
$do$;

-- The practice-reminder function now serves both students (Evia's Word
-- Summit and Wesley's Word Lab): dedupe reminders per student per day, and
-- route push subscriptions to the right student's devices. Existing rows
-- all belonged to Evia.

alter table public.reminder_log
  add column if not exists student text not null default 'evia';
alter table public.reminder_log drop constraint reminder_log_pkey;
alter table public.reminder_log add primary key (day, student);

alter table public.push_subs
  add column if not exists student text not null default 'evia';

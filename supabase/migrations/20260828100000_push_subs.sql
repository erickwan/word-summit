-- Web Push subscriptions for practice reminders. The app inserts/updates
-- with the publishable key; only the practice-reminder function (service
-- role) may read them, since the sub JSON holds the push endpoint and keys.

create table if not exists public.push_subs (
  endpoint text primary key,
  sub jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;

create policy "anon can register" on public.push_subs
  for insert to anon with check (true);
create policy "anon can refresh" on public.push_subs
  for update to anon using (true) with check (true);

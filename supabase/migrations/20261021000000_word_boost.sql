-- Parent-picked words to introduce next.
--
-- The Word HQ dashboard lets a parent queue specific words for each child; the
-- apps read the list at load and move those words to the front of the
-- unseen-word queue, so they are introduced with the next round's new-word
-- cards. Once a word has been practised it is no longer unseen, so stale
-- entries are harmless; the dashboard replaces the list wholesale.
--
-- Written only by the parent-dashboard edge function (service role, behind the
-- parent password). The apps read it with the publishable key, so SELECT is
-- open — the lists hold nothing but vocabulary words.

create table if not exists public.word_boost (
  child      text primary key,
  words      jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.word_boost enable row level security;

drop policy if exists "word_boost is readable" on public.word_boost;
create policy "word_boost is readable" on public.word_boost
  for select using (true);

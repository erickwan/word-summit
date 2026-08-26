-- Daily counter backing the generation spend cap in the generate-questions
-- edge function. Written only by the function via the service role key.
create table if not exists public.gen_usage (
  day date primary key,
  count int not null default 0
);
alter table public.gen_usage enable row level security;

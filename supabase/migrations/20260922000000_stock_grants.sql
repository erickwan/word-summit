-- Fractional-share rewards the kids earn for vocabulary milestones.
--
-- Grants are entered by the parent in Word HQ and shown back to each child in
-- their own app. Both tables are written only by the edge functions with the
-- service role and carry no policies, so neither the publishable key nor a
-- child's browser can read or change them directly.

create table if not exists public.stock_grants (
  id                uuid primary key default gen_random_uuid(),
  child             text not null,
  ticker            text not null,
  shares            numeric not null check (shares > 0),
  purchased_at      timestamptz not null,
  price_at_purchase numeric,
  note              text,
  created_at        timestamptz not null default now()
);
create index if not exists stock_grants_child_idx on public.stock_grants (child, purchased_at);
alter table public.stock_grants enable row level security;

-- Price series straight from the feed, kept briefly so a child opening their
-- app repeatedly does not re-fetch the same history.
create table if not exists public.price_cache (
  ticker     text not null,
  range_key  text not null,
  fetched_at timestamptz not null default now(),
  payload    jsonb not null,
  primary key (ticker, range_key)
);
alter table public.price_cache enable row level security;

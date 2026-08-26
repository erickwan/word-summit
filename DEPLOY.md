# Deploying the question generator

The apps work without this — they fall back to locally built questions.
Deploying turns on live question generation.

## 1. Create the spend-guard table

In the Supabase SQL editor:

```sql
create table if not exists gen_usage (
  day date primary key,
  count int not null default 0
);
alter table gen_usage enable row level security;
-- No policies needed: the edge function uses the service role key.
```

## 2. Get an Anthropic API key

https://console.anthropic.com → API keys → Create key.

## 3. Deploy

```bash
brew install supabase/tap/supabase
supabase login
supabase link --project-ref ywoaeadxfettakxehsel
supabase secrets set ANTHROPIC_API_KEY=sk-ant-YOUR-KEY-HERE
supabase functions deploy generate-questions --no-verify-jwt
```

`--no-verify-jwt` is required because the page authenticates with the
publishable key, which is not a JWT.

## Settings worth knowing

In `supabase/functions/generate-questions/index.ts`:

- `MODEL` — `claude-opus-5`.
- `DAILY_GENERATION_CAP` — hard ceiling on generations per day (default 80).
  Past the cap the function returns 429 and the apps fall back to local
  questions, so practice still works.
- `MAX_WORDS_PER_CALL` — request size cap (default 12).

## Checking it works

Open an app, start a round, and look for question styles the local
generator cannot produce — Analogy and Odd one out. The Parent tab's
"accuracy by question type" also lists them once they have been answered.

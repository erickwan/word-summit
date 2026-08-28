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

# Deploying the daily practice reminder

`supabase/functions/practice-reminder` emails Evia at 6:30pm Pacific on
days with no completed practice round. pg_cron (scheduled by the
`practice_reminder` migration) invokes it at 01:30 and 02:30 UTC; the
function only acts during the 6pm local hour, so the reminder time
survives DST, and `reminder_log` caps it at one email per day.

```bash
supabase db push
supabase functions deploy practice-reminder --no-verify-jwt
supabase secrets set GMAIL_USER=you@gmail.com GMAIL_APP_PASSWORD=your-app-password
```

The app password comes from https://myaccount.google.com/apppasswords
(requires 2-step verification on the Google account). The email is sent
from that Gmail account via SMTP.

To test without waiting for 6:30pm:

```bash
# Report what would happen, send nothing:
curl -s -X POST "https://ywoaeadxfettakxehsel.supabase.co/functions/v1/practice-reminder?dry_run=1&force=1"

# Actually send one reminder now (dedupe still applies — max one per day):
curl -s -X POST "https://ywoaeadxfettakxehsel.supabase.co/functions/v1/practice-reminder?force=1"
```

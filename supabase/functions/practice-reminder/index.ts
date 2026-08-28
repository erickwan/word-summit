// Daily practice reminder for Evia's Word Summit.
//
// pg_cron invokes this at 01:30 and 02:30 UTC (see the practice_reminder
// migration). Whichever of the two lands in the 6pm America/Los_Angeles hour
// proceeds — that keeps the reminder at 6:30pm local across DST changes.
// If no practice round was recorded today, one email goes to Evia; the
// reminder_log table guarantees at most one send per day.
//
// Deploy:  supabase functions deploy practice-reminder --no-verify-jwt
// Secrets: supabase secrets set GMAIL_USER=... GMAIL_APP_PASSWORD=...
//          (a Gmail app password — https://myaccount.google.com/apppasswords)
//
// Query params for testing:
//   ?dry_run=1  report what would happen, send nothing
//   ?force=1    skip the 6pm-hour gate (dedupe still applies)

import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const TZ = "America/Los_Angeles";
const SEND_HOUR = 18; // 6pm–7pm local is the send window
const RECIPIENT = "evia.kwan@gmail.com";
const STATE_ROW = "evia";

const MESSAGES = [
  {
    subject: "Word Summit reminder \u{1F331}",
    body: "Hi Evia!\n\nJust a friendly nudge — no Word Summit round yet today. One quick round keeps your acorn jar growing!\n\nYou've got this. \u{1F330}",
  },
  {
    subject: "Your words miss you \u{1F333}",
    body: "Hi Evia!\n\nLooks like today's Word Summit practice hasn't happened yet. A single round only takes a few minutes — go earn some acorns!\n\n\u{1F331}",
  },
  {
    subject: "Quick round before bed? \u{1F330}",
    body: "Hi Evia!\n\nNo practice recorded today — there's still time for one round. The forest spirits are waiting to celebrate with you!\n\nYou can do it!",
  },
  {
    subject: "Don't break the streak! \u{1F331}",
    body: "Hi Evia!\n\nToday's Word Summit round is still waiting for you. Keep those words fresh — one round and you're done for the day.\n\n\u{1F333}\u{1F330}",
  },
  {
    subject: "Totoro says: practice time \u{1F343}",
    body: "Hi Evia!\n\nYou haven't done your Word Summit practice yet today. Hop on for a quick round — your tree wants to grow!\n\n\u{1F331}",
  },
];

function laParts(ms: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: parseInt(get("hour"), 10) % 24,
  };
}

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  try {
    const url = new URL(req.url);
    const dryRun = url.searchParams.get("dry_run") === "1";
    const force = url.searchParams.get("force") === "1";

    const sbUrl = Deno.env.get("SUPABASE_URL");
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!sbUrl || !sbKey) return json({ error: "not_configured" }, 503);
    const admin = createClient(sbUrl, sbKey);

    const now = laParts(Date.now());

    const { data: row, error: loadErr } = await admin
      .from("word_lab").select("state").eq("id", STATE_ROW).maybeSingle();
    // On any data problem, skip rather than nag off bad information.
    if (loadErr) return json({ sent: false, reason: "state_load_failed", detail: loadErr.message }, 502);
    if (!row) return json({ sent: false, reason: "no_state_row" });

    const sessions: Array<{ t: number }> = row.state?.sessions ?? [];
    const todays = sessions.filter((s) => laParts(s.t).date === now.date);
    if (todays.length > 0) {
      return json({ sent: false, reason: "practiced_today", rounds: todays.length });
    }

    if (!force && now.hour !== SEND_HOUR) {
      return json({ sent: false, reason: "outside_send_window", localHour: now.hour });
    }
    if (dryRun) return json({ sent: false, reason: "dry_run", wouldSend: true });

    const gmailUser = Deno.env.get("GMAIL_USER");
    const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!gmailUser || !gmailPass) return json({ error: "email_not_configured" }, 503);

    // Claim today before sending; a unique-key conflict means already sent.
    const ins = await admin.from("reminder_log").insert({ day: now.date });
    if (ins.error) return json({ sent: false, reason: "already_sent_today" });

    const msg = MESSAGES[new Date().getDate() % MESSAGES.length];
    const smtp = new SMTPClient({
      connection: {
        hostname: "smtp.gmail.com",
        port: 465,
        tls: true,
        auth: { username: gmailUser, password: gmailPass },
      },
    });
    try {
      await smtp.send({
        from: gmailUser,
        to: RECIPIENT,
        subject: msg.subject,
        content: msg.body,
      });
    } catch (err) {
      // Release the day so a later manual retry can still send.
      await admin.from("reminder_log").delete().eq("day", now.date);
      return json({ sent: false, reason: "smtp_failed", detail: String((err as Error)?.message || err) }, 502);
    } finally {
      try { await smtp.close(); } catch { /* already closed */ }
    }

    return json({ sent: true, to: RECIPIENT, day: now.date });
  } catch (err) {
    return json({ error: "unexpected", detail: String((err as Error)?.message || err) }, 500);
  }
});

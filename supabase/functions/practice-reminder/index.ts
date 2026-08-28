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

const APP_URL = "https://erickwan.github.io/word-summit/";

// Rotated by day of month so consecutive days don't repeat.
const MESSAGES = [
  { subject: "Word Summit reminder \u{1F331}",
    intro: "Just a friendly nudge — no round yet today. Look how far you've climbed; don't stop now!" },
  { subject: "Your words miss you \u{1F333}",
    intro: "Today's practice hasn't happened yet. A single round only takes a few minutes — go earn some acorns!" },
  { subject: "Quick round before bed? \u{1F330}",
    intro: "No practice recorded today — there's still time for one round. The forest spirits are waiting!" },
  { subject: "Don't break the streak! \u{1F331}",
    intro: "Today's round is still waiting for you. Keep those words fresh — one round and you're done for the day." },
  { subject: "Totoro says: practice time \u{1F343}",
    intro: "You haven't practiced yet today. Hop on for a quick round — your tree wants to grow!" },
];

// Consecutive days with a practice round, counting back from yesterday
// (today is missing by definition when a reminder goes out).
function streakDays(sessions: Array<{ t: number }>): number {
  const days = new Set(sessions.map((s) => laParts(s.t).date));
  let n = 0;
  while (n < 365 && days.has(laParts(Date.now() - (n + 1) * 86400000).date)) n++;
  return n;
}

function statTile(value: number, label: string, bg: string, dark: string, mid: string): string {
  return `<td width="33%" style="background:${bg};border-radius:8px;padding:10px;text-align:center;">` +
    `<div style="font-size:20px;font-weight:bold;color:${dark};font-family:Arial,Helvetica,sans-serif;">${value}</div>` +
    `<div style="font-size:11px;color:${mid};font-family:Arial,Helvetica,sans-serif;">${label}</div></td>`;
}

function buildEmail(state: { sessions?: Array<{ t: number }>; stats?: Record<string, { seen?: number }>; acorns?: number }) {
  const sessions = state.sessions ?? [];
  const acorns = typeof state.acorns === "number" ? state.acorns : 0;
  const learned = Object.values(state.stats ?? {}).filter((s) => (s.seen ?? 0) > 0).length;
  const streak = streakDays(sessions);
  const msg = MESSAGES[new Date().getDate() % MESSAGES.length];

  // A zero streak reads as a scold; show total rounds instead.
  const third = streak > 0
    ? statTile(streak, "day streak", "#FAEEDA", "#412402", "#854F0B")
    : statTile(sessions.length, "rounds done", "#FAEEDA", "#412402", "#854F0B");

  const html =
    `<div style="margin:0;padding:16px;background:#F4F2FB;">` +
    `<div style="max-width:420px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #AFA9EC;padding:20px;font-family:Arial,Helvetica,sans-serif;">` +
    `<p style="margin:0 0 6px;font-size:17px;color:#26215C;font-weight:bold;">\u{1F331} Your tree is waiting, Evia!</p>` +
    `<p style="margin:0 0 14px;font-size:14px;color:#3C3489;line-height:1.6;">${msg.intro}</p>` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:separate;border-spacing:6px 0;margin:0 0 16px;"><tr>` +
    statTile(acorns, "acorns", "#EEEDFE", "#26215C", "#534AB7") +
    statTile(learned, "words learned", "#E1F5EE", "#04342C", "#0F6E56") +
    third +
    `</tr></table>` +
    `<div style="text-align:center;margin:0 0 4px;">` +
    `<a href="${APP_URL}" style="display:inline-block;background:#534AB7;color:#EEEDFE;font-size:14px;font-weight:bold;padding:10px 22px;border-radius:8px;text-decoration:none;">Keep climbing →</a>` +
    `</div>` +
    `<p style="margin:12px 0 0;font-size:11px;color:#7F77DD;text-align:center;">Sent with love by Dad's reminder robot \u{1F330}</p>` +
    `</div></div>`;

  const text = `Hi Evia!\n\n${msg.intro}\n\n` +
    `Acorns: ${acorns}\nWords learned: ${learned}\n` +
    (streak > 0 ? `Day streak: ${streak}\n` : `Rounds done: ${sessions.length}\n`) +
    `\nKeep climbing: ${APP_URL}\n`;

  return { subject: msg.subject, html, text, stats: { acorns, learned, streak, rounds: sessions.length } };
}

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

    const email = buildEmail(row.state ?? {});

    if (!force && now.hour !== SEND_HOUR) {
      return json({ sent: false, reason: "outside_send_window", localHour: now.hour, stats: email.stats });
    }
    if (dryRun) return json({ sent: false, reason: "dry_run", wouldSend: true, subject: email.subject, stats: email.stats });

    const gmailUser = Deno.env.get("GMAIL_USER");
    const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!gmailUser || !gmailPass) return json({ error: "email_not_configured" }, 503);

    // Claim today before sending; a unique-key conflict means already sent.
    const ins = await admin.from("reminder_log").insert({ day: now.date });
    if (ins.error) return json({ sent: false, reason: "already_sent_today" });

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
        subject: email.subject,
        content: email.text,
        html: email.html,
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

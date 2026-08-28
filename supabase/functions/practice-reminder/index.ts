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
const PARENT = "eric.kwan@gmail.com";
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

// One per email, rotating daily through all 30 (epoch-day modulo length).
const QUOTES: Array<[string, string]> = [
  ["It always seems impossible until it's done.", "Nelson Mandela"],
  ["The beautiful thing about learning is that no one can take it away from you.", "B.B. King"],
  ["It does not matter how slowly you go as long as you do not stop.", "Confucius"],
  ["Do the best you can until you know better. Then when you know better, do better.", "Maya Angelou"],
  ["Nothing will work unless you do.", "Maya Angelou"],
  ["I have not failed. I've just found 10,000 ways that won't work.", "Thomas Edison"],
  ["Genius is one percent inspiration and ninety-nine percent perspiration.", "Thomas Edison"],
  ["A journey of a thousand miles begins with a single step.", "Lao Tzu"],
  ["We are what we repeatedly do. Excellence, then, is not an act but a habit.", "Will Durant"],
  ["Success is the sum of small efforts, repeated day in and day out.", "Robert Collier"],
  ["Whether you think you can, or you think you can't — you're right.", "Henry Ford"],
  ["Education is the most powerful weapon which you can use to change the world.", "Nelson Mandela"],
  ["You don't have to be great to start, but you have to start to be great.", "Zig Ziglar"],
  ["Perseverance is not a long race; it is many short races one after the other.", "Walter Elliot"],
  ["Well done is better than well said.", "Benjamin Franklin"],
  ["An investment in knowledge pays the best interest.", "Benjamin Franklin"],
  ["Success is not final, failure is not fatal: it is the courage to continue that counts.", "Winston Churchill"],
  ["You miss 100% of the shots you don't take.", "Wayne Gretzky"],
  ["Start where you are. Use what you have. Do what you can.", "Arthur Ashe"],
  ["The more that you read, the more things you will know. The more that you learn, the more places you'll go.", "Dr. Seuss"],
  ["Practice isn't the thing you do once you're good. It's the thing you do that makes you good.", "Malcolm Gladwell"],
  ["Don't watch the clock; do what it does. Keep going.", "Sam Levenson"],
  ["The future belongs to those who believe in the beauty of their dreams.", "Eleanor Roosevelt"],
  ["One child, one teacher, one book, one pen can change the world.", "Malala Yousafzai"],
  ["Champions keep playing until they get it right.", "Billie Jean King"],
  ["It's kind of fun to do the impossible.", "Walt Disney"],
  ["Learning never exhausts the mind.", "Leonardo da Vinci"],
  ["Believe you can and you're halfway there.", "Theodore Roosevelt"],
  ["However difficult life may seem, there is always something you can do and succeed at.", "Stephen Hawking"],
  ["The limits of my language mean the limits of my world.", "Ludwig Wittgenstein"],
];

// Consecutive days with a practice round, counting back from yesterday
// (today is missing by definition when a reminder goes out).
function streakDays(sessions: Array<{ t: number }>): number {
  const days = new Set(sessions.map((s) => laParts(s.t).date));
  let n = 0;
  while (n < 365 && days.has(laParts(Date.now() - (n + 1) * 86400000).date)) n++;
  return n;
}

// Consecutive days with no practice, counting today as missed (only called
// when today's check already came up empty).
function missedDaysCount(sessions: Array<{ t: number }>): number {
  const days = new Set(sessions.map((s) => laParts(s.t).date));
  let n = 1;
  while (n < 365 && !days.has(laParts(Date.now() - n * 86400000).date)) n++;
  return n;
}

// Alert the parent when a lapse reaches 2 days, then every 3 days while it
// continues. Never for a student with no history at all — an empty cloud row
// is more likely a sync problem than a real lapse.
function parentAlertDue(sessions: Array<{ t: number }>, missed: number): boolean {
  return sessions.length > 0 && missed >= 2 && (missed - 2) % 3 === 0;
}

function buildParentEmail(state: { sessions?: Array<{ t: number }> }, missed: number) {
  const sessions = state.sessions ?? [];
  const lastT = sessions.reduce((m, s) => Math.max(m, s.t), 0);
  const last = lastT ? laParts(lastT).date : "never";
  const subject = `Evia has missed ${missed} days of Word Summit practice`;
  const text =
    `Evia hasn't practiced for ${missed} days in a row (nothing yet today as of 6:30pm).\n` +
    `Her last practice round was ${last}.\n\n` +
    `She's been sent her usual reminder email, but a check-in in person might help.\n` +
    `Progress details are in the Parent tab: ${APP_URL}\n`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#26215C;line-height:1.6;max-width:420px;">` +
    `<p style="margin:0 0 10px;"><b>Evia hasn't practiced for ${missed} days in a row</b> (nothing yet today as of 6:30pm).</p>` +
    `<p style="margin:0 0 10px;">Her last practice round was <b>${last}</b>.</p>` +
    `<p style="margin:0 0 10px;">She's been sent her usual reminder email, but a check-in in person might help.</p>` +
    `<p style="margin:0;"><a href="${APP_URL}" style="color:#534AB7;">Progress details in the Parent tab →</a></p>` +
    `</div>`;
  return { subject, text, html };
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
  const [quote, quoteBy] = QUOTES[Math.floor(Date.now() / 86400000) % QUOTES.length];

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
    `<div style="border-left:3px solid #AFA9EC;padding:2px 0 2px 12px;margin:0 0 16px;">` +
    `<p style="margin:0;font-size:13px;color:#3C3489;line-height:1.55;font-style:italic;">“${quote}”</p>` +
    `<p style="margin:4px 0 0;font-size:12px;color:#7F77DD;">— ${quoteBy}</p>` +
    `</div>` +
    `<div style="text-align:center;margin:0 0 4px;">` +
    `<a href="${APP_URL}" style="display:inline-block;background:#534AB7;color:#EEEDFE;font-size:14px;font-weight:bold;padding:10px 22px;border-radius:8px;text-decoration:none;">Keep climbing →</a>` +
    `</div>` +
    `<p style="margin:12px 0 0;font-size:11px;color:#7F77DD;text-align:center;">Sent with love by Dad's reminder robot \u{1F330}</p>` +
    `</div></div>`;

  const text = `Hi Evia!\n\n${msg.intro}\n\n` +
    `Acorns: ${acorns}\nWords learned: ${learned}\n` +
    (streak > 0 ? `Day streak: ${streak}\n` : `Rounds done: ${sessions.length}\n`) +
    `\n"${quote}" — ${quoteBy}\n` +
    `\nKeep climbing: ${APP_URL}\n`;

  return { subject: msg.subject, html, text, quote: `${quote} — ${quoteBy}`,
    stats: { acorns, learned, streak, rounds: sessions.length } };
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
    const missed = missedDaysCount(sessions);
    const alertParent = parentAlertDue(sessions, missed);

    if (!force && now.hour !== SEND_HOUR) {
      return json({ sent: false, reason: "outside_send_window", localHour: now.hour, stats: email.stats, missedDays: missed });
    }
    if (dryRun) return json({ sent: false, reason: "dry_run", wouldSend: true, subject: email.subject, quote: email.quote, stats: email.stats, missedDays: missed, wouldAlertParent: alertParent });

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
    let parentSent = false;
    let parentError: string | null = null;
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
      try { await smtp.close(); } catch { /* already closed */ }
      return json({ sent: false, reason: "smtp_failed", detail: String((err as Error)?.message || err) }, 502);
    }
    if (alertParent) {
      const parent = buildParentEmail(row.state ?? {}, missed);
      try {
        await smtp.send({
          from: gmailUser,
          to: PARENT,
          subject: parent.subject,
          content: parent.text,
          html: parent.html,
        });
        parentSent = true;
      } catch (err) {
        parentError = String((err as Error)?.message || err);
      }
    }
    try { await smtp.close(); } catch { /* already closed */ }

    return json({ sent: true, to: RECIPIENT, day: now.date, missedDays: missed,
      parentAlert: alertParent ? { sent: parentSent, to: PARENT, error: parentError } : null });
  } catch (err) {
    return json({ error: "unexpected", detail: String((err as Error)?.message || err) }, 500);
  }
});

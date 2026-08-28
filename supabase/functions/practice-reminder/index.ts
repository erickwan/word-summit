// Daily practice reminders for Evia's Word Summit and Wesley's Word Lab.
//
// pg_cron invokes this at 01:30 and 02:30 UTC (see the practice_reminder
// migration). Whichever of the two lands in the 6pm America/Los_Angeles hour
// proceeds — that keeps the reminder at 6:30pm local across DST changes.
// For each student with no practice round recorded today: one email to the
// student, a Web Push to their registered devices, and — when a lapse
// reaches 2 days — an alert email to the parent. The reminder_log table
// guarantees at most one send per student per day.
//
// Deploy:  supabase functions deploy practice-reminder --no-verify-jwt
// Secrets: GMAIL_USER / GMAIL_APP_PASSWORD (Gmail app password),
//          VAPID_KEYS / VAPID_CONTACT (Web Push signing).
//
// Query params for testing:
//   ?dry_run=1              report what would happen, send nothing
//   ?force=1                skip the 6pm-hour gate (dedupe still applies)
//   ?push_test=1[&student=] push a test notification, no email

import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import * as webpush from "jsr:@negrel/webpush@0.3.0";

const TZ = "America/Los_Angeles";
const SEND_HOUR = 18; // 6pm–7pm local is the send window
const PARENT = "eric.kwan@gmail.com";

type Session = { t: number };
type Msg = { subject: string; intro: string };
type Tile = { v: number; l: string };
type Student = {
  id: string;
  row: string;              // id in the word_lab state table
  name: string;
  email: string;
  app: string;
  appName: string;
  hero: string;
  cta: string;
  He: string; his: string;  // pronouns for the parent email
  messages: Msg[];          // rotated by day of month
  tiles: (state: Record<string, unknown>) => [Tile, Tile];
};

const STUDENTS: Student[] = [
  {
    id: "evia",
    row: "evia",
    name: "Evia",
    email: "evia.kwan@gmail.com",
    app: "https://erickwan.github.io/word-summit/",
    appName: "Word Summit",
    hero: "\u{1F331} Your tree is waiting, Evia!",
    cta: "Keep climbing →",
    He: "She", his: "her",
    messages: [
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
    ],
    tiles: (state) => [
      { v: typeof state.acorns === "number" ? state.acorns as number : 0, l: "acorns" },
      { v: Object.values((state.stats ?? {}) as Record<string, { seen?: number }>)
            .filter((s) => (s.seen ?? 0) > 0).length, l: "words learned" },
    ],
  },
  {
    id: "wesley",
    row: "main",
    name: "Wesley",
    email: "wesleykwan1231@gmail.com",
    app: "https://erickwan.github.io/word-lab/",
    appName: "Word Lab",
    hero: "\u{1F409} Your words need training, Wesley!",
    cta: "Power up →",
    He: "He", his: "his",
    messages: [
      { subject: "Word Lab reminder \u{1F409}",
        intro: "Just a friendly nudge — no training round yet today. Your words are waiting to power up!" },
      { subject: "Your words miss you ⚡",
        intro: "Today's practice hasn't happened yet. One quick round earns more ki toward the next Dragon Ball!" },
      { subject: "Quick round before bed? \u{1F7E0}",
        intro: "No practice recorded today — there's still time for one round. The dragon is watching!" },
      { subject: "Don't break your training! \u{1F409}",
        intro: "Today's round is still waiting for you. A true fighter trains every day — one round and you're done." },
      { subject: "Shenron says: train your words ⚡",
        intro: "You haven't practiced yet today. Hop on for a quick round and gather more ki!" },
    ],
    tiles: (state) => [
      { v: Math.min(7, Math.floor((typeof state.ki === "number" ? state.ki as number : 0) / 20)),
        l: "dragon balls" },
      { v: Array.isArray(state.items) ? state.items.length : 0, l: "words collected" },
    ],
  },
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

// Consecutive days with a practice round, counting back from yesterday
// (today is missing by definition when a reminder goes out).
function streakDays(sessions: Session[]): number {
  const days = new Set(sessions.map((s) => laParts(s.t).date));
  let n = 0;
  while (n < 365 && days.has(laParts(Date.now() - (n + 1) * 86400000).date)) n++;
  return n;
}

// Consecutive days with no practice, counting today as missed (only called
// when today's check already came up empty).
function missedDaysCount(sessions: Session[]): number {
  const days = new Set(sessions.map((s) => laParts(s.t).date));
  let n = 1;
  while (n < 365 && !days.has(laParts(Date.now() - n * 86400000).date)) n++;
  return n;
}

// Alert the parent when a lapse reaches 2 days, then every 3 days while it
// continues. Never for a student with no history at all — an empty cloud row
// is more likely a sync problem than a real lapse.
function parentAlertDue(sessions: Session[], missed: number): boolean {
  return sessions.length > 0 && missed >= 2 && (missed - 2) % 3 === 0;
}

// Web Push to the student's registered browsers (see push_subs + each app's
// sw.js). Dead subscriptions (endpoint gone) are pruned as discovered.
async function sendPushes(
  admin: ReturnType<typeof createClient>,
  studentId: string,
  payload: { title: string; body: string; url: string },
) {
  const keysJson = Deno.env.get("VAPID_KEYS");
  if (!keysJson) return { sent: 0, pruned: 0, total: 0, errors: ["vapid_not_configured"] };
  const { data: subs, error } = await admin
    .from("push_subs").select("endpoint, sub").eq("student", studentId);
  if (error) return { sent: 0, pruned: 0, total: 0, errors: [error.message] };
  if (!subs?.length) return { sent: 0, pruned: 0, total: 0, errors: [] };

  const vapidKeys = await webpush.importVapidKeys(JSON.parse(keysJson), { extractable: false });
  const appServer = await webpush.ApplicationServer.new({
    contactInformation: Deno.env.get("VAPID_CONTACT") ?? `mailto:${PARENT}`,
    vapidKeys,
  });

  let sent = 0, pruned = 0;
  const errors: string[] = [];
  for (const row of subs) {
    try {
      await appServer.subscribe(row.sub as webpush.PushSubscription)
        .pushTextMessage(JSON.stringify(payload), {});
      sent++;
    } catch (err) {
      if (err instanceof webpush.PushMessageError && err.isGone()) {
        await admin.from("push_subs").delete().eq("endpoint", row.endpoint);
        pruned++;
      } else {
        errors.push(String((err as Error)?.message || err));
      }
    }
  }
  return { sent, pruned, total: subs.length, errors };
}

function statTile(t: Tile, bg: string, dark: string, mid: string): string {
  return `<td width="33%" style="background:${bg};border-radius:8px;padding:10px;text-align:center;">` +
    `<div style="font-size:20px;font-weight:bold;color:${dark};font-family:Arial,Helvetica,sans-serif;">${t.v}</div>` +
    `<div style="font-size:11px;color:${mid};font-family:Arial,Helvetica,sans-serif;">${t.l}</div></td>`;
}

function buildEmail(stu: Student, state: Record<string, unknown>) {
  const sessions = (state.sessions ?? []) as Session[];
  const streak = streakDays(sessions);
  const msg = stu.messages[new Date().getDate() % stu.messages.length];
  const [quote, quoteBy] = QUOTES[Math.floor(Date.now() / 86400000) % QUOTES.length];

  // A zero streak reads as a scold; show total rounds instead.
  const tiles: Tile[] = [
    ...stu.tiles(state),
    streak > 0 ? { v: streak, l: "day streak" } : { v: sessions.length, l: "rounds done" },
  ];

  const html =
    `<div style="margin:0;padding:16px;background:#F4F2FB;">` +
    `<div style="max-width:420px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #AFA9EC;padding:20px;font-family:Arial,Helvetica,sans-serif;">` +
    `<p style="margin:0 0 6px;font-size:17px;color:#26215C;font-weight:bold;">${stu.hero}</p>` +
    `<p style="margin:0 0 14px;font-size:14px;color:#3C3489;line-height:1.6;">${msg.intro}</p>` +
    `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:separate;border-spacing:6px 0;margin:0 0 16px;"><tr>` +
    statTile(tiles[0], "#EEEDFE", "#26215C", "#534AB7") +
    statTile(tiles[1], "#E1F5EE", "#04342C", "#0F6E56") +
    statTile(tiles[2], "#FAEEDA", "#412402", "#854F0B") +
    `</tr></table>` +
    `<div style="border-left:3px solid #AFA9EC;padding:2px 0 2px 12px;margin:0 0 16px;">` +
    `<p style="margin:0;font-size:13px;color:#3C3489;line-height:1.55;font-style:italic;">“${quote}”</p>` +
    `<p style="margin:4px 0 0;font-size:12px;color:#7F77DD;">— ${quoteBy}</p>` +
    `</div>` +
    `<div style="text-align:center;margin:0 0 4px;">` +
    `<a href="${stu.app}" style="display:inline-block;background:#534AB7;color:#EEEDFE;font-size:14px;font-weight:bold;padding:10px 22px;border-radius:8px;text-decoration:none;">${stu.cta}</a>` +
    `</div>` +
    `<p style="margin:12px 0 0;font-size:11px;color:#7F77DD;text-align:center;">Sent with love by Dad's reminder robot</p>` +
    `</div></div>`;

  const text = `Hi ${stu.name}!\n\n${msg.intro}\n\n` +
    tiles.map((t) => `${t.l[0].toUpperCase()}${t.l.slice(1)}: ${t.v}`).join("\n") +
    `\n\n"${quote}" — ${quoteBy}\n` +
    `\n${stu.cta.replace(" →", "")}: ${stu.app}\n`;

  return { subject: msg.subject, intro: msg.intro, html, text,
    quote: `${quote} — ${quoteBy}`, tiles, streak, rounds: sessions.length };
}

function buildParentEmail(stu: Student, state: Record<string, unknown>, missed: number) {
  const sessions = (state.sessions ?? []) as Session[];
  const lastT = sessions.reduce((m, s) => Math.max(m, s.t), 0);
  const last = lastT ? laParts(lastT).date : "never";
  const subject = `${stu.name} has missed ${missed} days of ${stu.appName} practice`;
  const text =
    `${stu.name} hasn't practiced for ${missed} days in a row (nothing yet today as of 6:30pm).\n` +
    `${stu.name}'s last practice round was ${last}.\n\n` +
    `${stu.He}'s been sent ${stu.his} usual reminder email, but a check-in in person might help.\n` +
    `Progress details are in the Parent tab: ${stu.app}\n`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#26215C;line-height:1.6;max-width:420px;">` +
    `<p style="margin:0 0 10px;"><b>${stu.name} hasn't practiced for ${missed} days in a row</b> (nothing yet today as of 6:30pm).</p>` +
    `<p style="margin:0 0 10px;">${stu.name}'s last practice round was <b>${last}</b>.</p>` +
    `<p style="margin:0 0 10px;">${stu.He}'s been sent ${stu.his} usual reminder email, but a check-in in person might help.</p>` +
    `<p style="margin:0;"><a href="${stu.app}" style="color:#534AB7;">Progress details in the Parent tab →</a></p>` +
    `</div>`;
  return { subject, text, html };
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

    // Test hook: push a notification to registered browsers, no email.
    if (url.searchParams.get("push_test") === "1") {
      const only = url.searchParams.get("student");
      const out: Record<string, unknown> = {};
      for (const stu of STUDENTS) {
        if (only && stu.id !== only) continue;
        out[stu.id] = await sendPushes(admin, stu.id, {
          title: `${stu.appName}`,
          body: "Test notification — reminders are working on this device!",
          url: stu.app,
        });
      }
      return json({ pushTest: true, ...out });
    }

    const results: Array<Record<string, unknown>> = [];
    for (const stu of STUDENTS) {
      const { data: row, error: loadErr } = await admin
        .from("word_lab").select("state").eq("id", stu.row).maybeSingle();
      // On any data problem, skip rather than nag off bad information.
      if (loadErr) { results.push({ student: stu.id, sent: false, reason: "state_load_failed", detail: loadErr.message }); continue; }
      if (!row) { results.push({ student: stu.id, sent: false, reason: "no_state_row" }); continue; }

      const state = (row.state ?? {}) as Record<string, unknown>;
      const sessions = (state.sessions ?? []) as Session[];
      const todays = sessions.filter((s) => laParts(s.t).date === now.date);
      if (todays.length > 0) {
        results.push({ student: stu.id, sent: false, reason: "practiced_today", rounds: todays.length });
        continue;
      }

      const email = buildEmail(stu, state);
      const missed = missedDaysCount(sessions);
      const alertParent = parentAlertDue(sessions, missed);

      if (!force && now.hour !== SEND_HOUR) {
        results.push({ student: stu.id, sent: false, reason: "outside_send_window", localHour: now.hour, missedDays: missed });
        continue;
      }
      if (dryRun) {
        const { count } = await admin.from("push_subs")
          .select("*", { count: "exact", head: true }).eq("student", stu.id);
        results.push({ student: stu.id, sent: false, reason: "dry_run", wouldSend: true,
          subject: email.subject, quote: email.quote, tiles: email.tiles,
          missedDays: missed, wouldAlertParent: alertParent, pushSubs: count ?? 0 });
        continue;
      }

      const gmailUser = Deno.env.get("GMAIL_USER");
      const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
      if (!gmailUser || !gmailPass) { results.push({ student: stu.id, error: "email_not_configured" }); continue; }

      // Claim today before sending; a unique-key conflict means already sent.
      const ins = await admin.from("reminder_log").insert({ day: now.date, student: stu.id });
      if (ins.error) { results.push({ student: stu.id, sent: false, reason: "already_sent_today" }); continue; }

      const push = await sendPushes(admin, stu.id, {
        title: `${stu.appName}`,
        body: email.intro,
        url: stu.app,
      });

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
          to: stu.email,
          subject: email.subject,
          content: email.text,
          html: email.html,
        });
      } catch (err) {
        // Release the day for a manual retry only if the push also failed to
        // go out; otherwise a retry would notify the laptop twice.
        if (push.sent === 0) {
          await admin.from("reminder_log").delete().eq("day", now.date).eq("student", stu.id);
        }
        try { await smtp.close(); } catch { /* already closed */ }
        results.push({ student: stu.id, sent: false, reason: "smtp_failed", push, detail: String((err as Error)?.message || err) });
        continue;
      }
      if (alertParent) {
        const parent = buildParentEmail(stu, state, missed);
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

      results.push({ student: stu.id, sent: true, to: stu.email, missedDays: missed, push,
        parentAlert: alertParent ? { sent: parentSent, to: PARENT, error: parentError } : null });
    }

    return json({ day: now.date, students: results });
  } catch (err) {
    return json({ error: "unexpected", detail: String((err as Error)?.message || err) }, 500);
  }
});

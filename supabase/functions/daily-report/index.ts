// Daily progress report for the parent, covering all three children.
//
// pg_cron invokes this at 15:10 and 16:10 UTC; the function only sends during
// the 7am America/Los_Angeles hour, so exactly one of the two fires does
// anything and the send time survives DST. report_log caps it at one email per
// day. It reports the day that has just finished, so the numbers are complete.
//
// Secrets: GMAIL_USER / GMAIL_APP_PASSWORD, SUPABASE_URL / SERVICE_ROLE_KEY.
import { createClient } from "npm:@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const PARENT = "eric.kwan@gmail.com";
const TZ = "America/Los_Angeles";
const SEND_HOUR = 7;

type Stat = { box?: number; seen?: number; correct?: number; wrong?: number; due?: number };
type Session = {
  t: number; total?: number; correct?: number; ms?: number;
  types?: Record<string, [number, number]>;
  missed?: string[]; mastered?: string[]; regressed?: string[]; eased?: string[];
};
type State = { stats?: Record<string, Stat>; sessions?: Session[]; items?: { id: string; word: string }[] };

const KIDS = [
  { row: "main", name: "Wesley", app: "https://erickwan.github.io/word-lab/", tint: "#2F6FBF" },
  { row: "evia", name: "Evia", app: "https://erickwan.github.io/word-summit/", tint: "#C33A93" },
  { row: "jax", name: "Jax", app: "https://erickwan.github.io/word-dojo/", tint: "#E4711E" },
];

function laDate(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}
function laHour(ms: number): number {
  return parseInt(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, hour: "2-digit", hour12: false,
  }).format(new Date(ms)), 10) % 24;
}
function prettyDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "long", month: "long", day: "numeric",
  });
}
// The local calendar day before `day`. Anchoring at UTC noon keeps the step
// exactly one day across DST changes.
function prevDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const ms = Date.UTC(y, m - 1, d, 12) - 86400000;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(ms));
}

// Word ids are "<word>-<n>", so the word reads out of the id without the list.
const wordOf = (id: string) => String(id).replace(/-[^-]*$/, "");
function mins(ms: number): string {
  if (!ms) return "—";
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
const esc = (s: string) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function levels(stats: Record<string, Stat>) {
  let practised = 0, mastered = 0, needs = 0, due = 0;
  const now = Date.now();
  for (const id of Object.keys(stats)) {
    const t = stats[id];
    if (!t || !t.seen) continue;
    practised++;
    if ((t.box ?? 1) >= 4) mastered++;
    else if ((t.box ?? 1) <= 2) needs++;
    if ((t.due ?? 0) <= now) due++;
  }
  return { practised, mastered, needs, due };
}

function summarise(state: State, day: string) {
  const sessions = (state.sessions ?? []).filter((s) => laDate(s.t) === day);
  const totals = sessions.reduce((a, s) => {
    a.questions += s.total ?? 0;
    a.correct += s.correct ?? 0;
    a.ms += s.ms ?? 0;
    return a;
  }, { questions: 0, correct: 0, ms: 0 });

  const dedupe = (key: "mastered" | "regressed" | "missed" | "eased") =>
    [...new Set(sessions.flatMap((s) => s[key] ?? []))];

  // How many of the last 7 days had at least one round.
  const days = new Set((state.sessions ?? []).map((s) => laDate(s.t)));
  let practisedDays = 0;
  const [y, m, d] = day.split("-").map(Number);
  for (let i = 0; i < 7; i++) {
    const ms = Date.UTC(y, m - 1, d, 12) - i * 86400000;
    if (days.has(laDate(ms))) practisedDays++;
  }

  // Time is only recorded by builds from 16 Nov 2026 on; say so rather than
  // reporting a confident zero.
  const hasTime = sessions.some((s) => typeof s.ms === "number");

  return {
    rounds: sessions.length, ...totals, hasTime,
    accuracy: totals.questions ? Math.round((100 * totals.correct) / totals.questions) : null,
    mastered: dedupe("mastered"), regressed: dedupe("regressed"),
    missed: dedupe("missed"), eased: dedupe("eased"),
    practisedDays, standing: levels(state.stats ?? {}),
  };
}

type Summary = ReturnType<typeof summarise>;

function kidHtml(kid: typeof KIDS[number], s: Summary) {
  const cell = (v: string, l: string) =>
    `<td style="padding:6px 12px 6px 0;"><div style="font-size:19px;font-weight:bold;color:#1B2028;">${v}</div>` +
    `<div style="font-size:11px;color:#616B7C;">${l}</div></td>`;

  const list = (label: string, ids: string[], colour: string) =>
    ids.length
      ? `<p style="margin:6px 0 0;font-size:13px;color:#1B2028;"><span style="color:${colour};font-weight:bold;">${label}</span> ` +
        esc(ids.map(wordOf).join(", ")) + `</p>`
      : "";

  const body = s.rounds === 0
    ? `<p style="margin:8px 0 0;font-size:13px;color:#616B7C;">No practice yesterday. ` +
      `${s.practisedDays} of the last 7 days had a round.</p>`
    : `<table cellpadding="0" cellspacing="0" style="margin:8px 0 0;"><tr>` +
      cell(String(s.rounds), s.rounds === 1 ? "round" : "rounds") +
      cell(String(s.questions), "questions") +
      cell(s.accuracy === null ? "—" : s.accuracy + "%", "correct") +
      cell(s.hasTime ? mins(s.ms) : "—", "time") +
      cell(`${s.practisedDays}/7`, "days this week") +
      `</tr></table>` +
      list("Newly mastered:", s.mastered, "#1D7A3D") +
      list("Slipped back:", s.regressed, "#B3261E") +
      list("Missed:", s.missed, "#8A6D00") +
      list("Asked for easier options:", s.eased, "#616B7C") +
      (s.hasTime ? "" : `<p style="margin:6px 0 0;font-size:11px;color:#8A93A5;">Time isn't recorded for these rounds yet.</p>`);

  return `<div style="border-left:4px solid ${kid.tint};padding:2px 0 2px 12px;margin:0 0 20px;">` +
    `<div style="font-size:16px;font-weight:bold;color:#1B2028;">${kid.name}</div>` +
    body +
    `<p style="margin:8px 0 0;font-size:12px;color:#616B7C;">` +
    `${s.standing.practised} words practised · ${s.standing.mastered} mastered · ` +
    `${s.standing.needs} need work · ${s.standing.due} due now</p>` +
    `</div>`;
}

function kidText(kid: typeof KIDS[number], s: Summary) {
  if (s.rounds === 0) {
    return `${kid.name}: no practice. ${s.practisedDays} of the last 7 days had a round.\n` +
      `  ${s.standing.practised} words practised, ${s.standing.mastered} mastered, ${s.standing.due} due now\n`;
  }
  const bits = [
    `${kid.name}: ${s.rounds} round${s.rounds === 1 ? "" : "s"}, ${s.questions} questions, ` +
    `${s.accuracy}% correct${s.hasTime ? `, ${mins(s.ms)}` : ""} (${s.practisedDays}/7 days this week)`,
  ];
  if (s.mastered.length) bits.push(`  Newly mastered: ${s.mastered.map(wordOf).join(", ")}`);
  if (s.regressed.length) bits.push(`  Slipped back: ${s.regressed.map(wordOf).join(", ")}`);
  if (s.missed.length) bits.push(`  Missed: ${s.missed.map(wordOf).join(", ")}`);
  if (s.eased.length) bits.push(`  Asked for easier options: ${s.eased.map(wordOf).join(", ")}`);
  bits.push(`  ${s.standing.practised} words practised, ${s.standing.mastered} mastered, ` +
    `${s.standing.needs} need work, ${s.standing.due} due now`);
  return bits.join("\n") + "\n";
}

Deno.serve(async (req: Request) => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  try {
    const url = new URL(req.url);
    const dryRun = url.searchParams.get("dry_run") === "1";
    const force = url.searchParams.get("force") === "1";

    const sbUrl = Deno.env.get("SUPABASE_URL");
    const sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!sbUrl || !sbKey) return json({ error: "not_configured" }, 503);
    const admin = createClient(sbUrl, sbKey);

    if (!force && laHour(Date.now()) !== SEND_HOUR) {
      return json({ sent: false, reason: "outside_send_window", localHour: laHour(Date.now()) });
    }

    // The day that has just finished, unless one is named for a re-run. Derived
    // from the calendar rather than an hours offset, so a run outside the 7am
    // window still reports yesterday.
    const day = url.searchParams.get("day") || prevDay(laDate(Date.now()));

    if (!dryRun && !force) {
      const { data: already } = await admin.from("report_log").select("day").eq("day", day).maybeSingle();
      if (already) return json({ sent: false, reason: "already_sent", day });
    }

    const parts: { kid: typeof KIDS[number]; s: Summary }[] = [];
    for (const kid of KIDS) {
      const { data: row, error } = await admin
        .from("word_lab").select("state").eq("id", kid.row).maybeSingle();
      if (error || !row) continue;
      parts.push({ kid, s: summarise((row.state ?? {}) as State, day) });
    }
    if (!parts.length) return json({ sent: false, reason: "no_data" });

    const active = parts.filter((p) => p.s.rounds > 0);
    const rounds = parts.reduce((n, p) => n + p.s.rounds, 0);
    const questions = parts.reduce((n, p) => n + p.s.questions, 0);
    const headline = rounds === 0
      ? "No one practised yesterday"
      : `${active.map((p) => p.kid.name).join(", ")} practised — ` +
        `${rounds} round${rounds === 1 ? "" : "s"}, ${questions} questions`;

    const subject = `Word practice — ${prettyDate(day)}`;
    const html =
      `<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:560px;color:#1B2028;">` +
      `<p style="margin:0 0 2px;font-size:12px;color:#616B7C;">${prettyDate(day)}</p>` +
      `<p style="margin:0 0 18px;font-size:17px;font-weight:bold;">${esc(headline)}</p>` +
      parts.map((p) => kidHtml(p.kid, p.s)).join("") +
      `<p style="margin:18px 0 0;font-size:12px;">` +
      `<a href="https://erickwan.github.io/word-hq/" style="color:#2F6FBF;">Open Word HQ →</a></p>` +
      `</div>`;
    const text = `${prettyDate(day)}\n${headline}\n\n` +
      parts.map((p) => kidText(p.kid, p.s)).join("\n") +
      `\nWord HQ: https://erickwan.github.io/word-hq/\n`;

    if (dryRun) return json({ sent: false, reason: "dry_run", day, subject, text });

    const gmailUser = Deno.env.get("GMAIL_USER");
    const gmailPass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!gmailUser || !gmailPass) return json({ error: "no_mail_credentials" }, 503);

    const smtp = new SMTPClient({
      connection: { hostname: "smtp.gmail.com", port: 465, tls: true,
        auth: { username: gmailUser, password: gmailPass } },
    });
    try {
      await smtp.send({ from: gmailUser, to: PARENT, subject, content: text, html });
    } catch (err) {
      try { await smtp.close(); } catch { /* already closed */ }
      return json({ sent: false, reason: "smtp_failed", detail: String((err as Error)?.message || err) }, 502);
    }
    try { await smtp.close(); } catch { /* already closed */ }

    await admin.from("report_log").upsert({ day, sent_at: new Date().toISOString() });
    return json({ sent: true, day, to: PARENT, subject,
      kids: parts.map((p) => ({ name: p.kid.name, rounds: p.s.rounds, questions: p.s.questions })) });
  } catch (err) {
    return json({ error: "unhandled", detail: String((err as Error)?.message || err) }, 500);
  }
});

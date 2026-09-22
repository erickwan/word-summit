// Fractional-share rewards: parent writes, children read.
//
// Admin actions (add/list/delete) need the Word HQ password and run with the
// service role. "series" is public, because each child's app is a static page
// with only the publishable key - it returns one child's holdings and nothing
// about the others.

const CHILDREN: Record<string, string> = { main: "Wesley", evia: "Evia", jax: "Jax" };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const SB_URL = () => Deno.env.get("SUPABASE_URL")!;
const SB_KEY = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const sbHeaders = () => ({ apikey: SB_KEY(), Authorization: `Bearer ${SB_KEY()}` });

/* ---------- admin auth (same password as the dashboard) ---------- */
async function digest(s: string) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
async function authorised(given: string): Promise<boolean> {
  const expected = Deno.env.get("PARENT_DASHBOARD_PASSWORD");
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* ---------- price feed ---------- */
// range key -> what to ask the feed for
const RANGES: Record<string, { range: string; interval: string; ttlMs: number }> = {
  today: { range: "1d", interval: "5m", ttlMs: 5 * 60_000 },
  week:  { range: "5d", interval: "30m", ttlMs: 10 * 60_000 },
  month: { range: "1mo", interval: "1d", ttlMs: 6 * 3600_000 },
  six:   { range: "6mo", interval: "1d", ttlMs: 6 * 3600_000 },
  year:  { range: "1y", interval: "1d", ttlMs: 6 * 3600_000 },
};

type Series = { t: number[]; c: (number | null)[]; currency?: string; name?: string };

async function fetchChart(url: string): Promise<any> {
  // query1 occasionally rate-limits; query2 serves the same data.
  for (const host of ["query1", "query2"]) {
    try {
      const r = await fetch(url.replace("HOST", host), {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j?.chart?.result?.[0]) return j.chart.result[0];
    } catch { /* try the other host */ }
  }
  return null;
}

async function seriesFor(ticker: string, key: string): Promise<Series | null> {
  const spec = RANGES[key];
  const cacheUrl = `${SB_URL()}/rest/v1/price_cache?ticker=eq.${encodeURIComponent(ticker)}&range_key=eq.${key}&select=payload,fetched_at`;
  try {
    const cr = await fetch(cacheUrl, { headers: sbHeaders() });
    if (cr.ok) {
      const rows = await cr.json();
      if (rows[0] && Date.now() - Date.parse(rows[0].fetched_at) < spec.ttlMs) return rows[0].payload;
    }
  } catch { /* a cache miss is not an error */ }

  const res = await fetchChart(
    `https://HOST.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${spec.range}&interval=${spec.interval}`,
  );
  if (!res) return null;
  const out: Series = {
    t: (res.timestamp || []).map((s: number) => s * 1000),
    c: res.indicators?.quote?.[0]?.close || [],
    currency: res.meta?.currency,
    name: res.meta?.shortName || res.meta?.symbol,
  };
  if (!out.t.length) return null;
  await fetch(`${SB_URL()}/rest/v1/price_cache?on_conflict=ticker,range_key`, {
    method: "POST",
    headers: { ...sbHeaders(), "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ ticker, range_key: key, payload: out, fetched_at: new Date().toISOString() }),
  }).catch(() => {});
  return out;
}

// Daily close on or just before a date — the cost basis of a grant.
async function priceOn(ticker: string, whenMs: number): Promise<number | null> {
  const p1 = Math.floor((whenMs - 14 * 86400_000) / 1000);
  const p2 = Math.floor((whenMs + 3 * 86400_000) / 1000);
  const res = await fetchChart(
    `https://HOST.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${p1}&period2=${p2}&interval=1d`,
  );
  if (!res?.timestamp?.length) return null;
  const closes = res.indicators?.quote?.[0]?.close || [];
  let best: number | null = null;
  res.timestamp.forEach((s: number, i: number) => {
    if (s * 1000 <= whenMs + 86400_000 && typeof closes[i] === "number") best = closes[i];
  });
  return best;
}

/* ---------- value over time ---------- */
type Grant = { id: string; child: string; ticker: string; shares: number; purchased_at: string; price_at_purchase: number | null; note: string | null };

function buildSeries(grants: Grant[], byTicker: Record<string, Series>) {
  const tickers = [...new Set(grants.map((g) => g.ticker))].filter((t) => byTicker[t]);
  // One timeline for every ticker, so the lines and the total line up.
  const stamps = [...new Set(tickers.flatMap((t) => byTicker[t].t))].sort((a, b) => a - b);

  // Last known close at or before each stamp, so a ticker that did not trade in
  // a slot holds its price instead of dropping to zero.
  const priceAt: Record<string, (number | null)[]> = {};
  for (const tk of tickers) {
    const s = byTicker[tk];
    const out: (number | null)[] = [];
    let i = 0, last: number | null = null;
    for (const stamp of stamps) {
      while (i < s.t.length && s.t[i] <= stamp) {
        if (typeof s.c[i] === "number") last = s.c[i] as number;
        i++;
      }
      out.push(last);
    }
    priceAt[tk] = out;
  }

  const points = stamps.map((stamp, idx) => {
    const per: Record<string, number> = {};
    let total = 0;
    for (const tk of tickers) {
      const price = priceAt[tk][idx];
      if (price == null) continue;
      // Shares only count from the moment they were actually given.
      const shares = grants
        .filter((g) => g.ticker === tk && Date.parse(g.purchased_at) <= stamp)
        .reduce((n, g) => n + Number(g.shares), 0);
      const v = shares * price;
      if (shares > 0) { per[tk] = v; total += v; }
    }
    return { t: stamp, total, per };
  }).filter((p) => Object.keys(p.per).length > 0);

  return { tickers, points };
}

/* ---------- request handling ---------- */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = String(body?.action || "");

  /* ----- public: one child's holdings over a window ----- */
  if (action === "series") {
    const child = String(body?.child || "");
    if (!CHILDREN[child]) return json({ error: "unknown_child" }, 400);
    const key = RANGES[String(body?.range || "month")] ? String(body.range) : "month";

    const gr = await fetch(
      `${SB_URL()}/rest/v1/stock_grants?child=eq.${child}&select=*&order=purchased_at.asc`,
      { headers: sbHeaders() },
    );
    if (!gr.ok) return json({ error: "read_failed" }, 502);
    const grants: Grant[] = await gr.json();
    if (!grants.length) {
      return json({ child, name: CHILDREN[child], range: key, tickers: [], points: [], grants: [], summary: null });
    }

    const tickers = [...new Set(grants.map((g) => g.ticker))];
    const fetched = await Promise.all(tickers.map((t) => seriesFor(t, key)));
    const byTicker: Record<string, Series> = {};
    tickers.forEach((t, i) => { if (fetched[i]) byTicker[t] = fetched[i]!; });

    const { tickers: live, points } = buildSeries(grants, byTicker);
    const last = points[points.length - 1];
    const first = points[0];

    const invested = grants.reduce(
      (n, g) => n + (g.price_at_purchase ? Number(g.shares) * Number(g.price_at_purchase) : 0), 0);
    const value = last ? last.total : 0;

    // A grant that landed inside the window lifts the line on its own, so the
    // window change is not performance alone. Say so rather than hide it.
    const windowStart = first ? first.t : 0;
    const addedInWindow = grants
      .filter((g) => Date.parse(g.purchased_at) >= windowStart)
      .map((g) => ({ ticker: g.ticker, at: g.purchased_at }));

    return json({
      child, name: CHILDREN[child], range: key,
      tickers: live.map((t) => ({ ticker: t, label: byTicker[t]?.name || t })),
      points, grants,
      summary: {
        value, invested, gain: value - invested,
        gainPct: invested > 0 ? ((value - invested) / invested) * 100 : null,
        windowChange: first && last ? last.total - first.total : 0,
        windowChangePct: first && first.total > 0 && last ? ((last.total - first.total) / first.total) * 100 : null,
        addedInWindow,
        asOf: last ? last.t : null,
        currency: Object.values(byTicker)[0]?.currency || "USD",
      },
    });
  }

  /* ----- everything below is the parent's ----- */
  if (!(await authorised(String(body?.password || "")))) {
    await new Promise((r) => setTimeout(r, 600));
    return json({ error: "unauthorized" }, 401);
  }

  if (action === "list") {
    const r = await fetch(`${SB_URL()}/rest/v1/stock_grants?select=*&order=purchased_at.desc`, { headers: sbHeaders() });
    if (!r.ok) return json({ error: "read_failed" }, 502);
    const grants: Grant[] = await r.json();

    // Current price per ticker, so the parent sees what each grant is worth now.
    const tickers = [...new Set(grants.map((g) => g.ticker))];
    const now: Record<string, number> = {};
    await Promise.all(tickers.map(async (t) => {
      const s = await seriesFor(t, "today");
      if (!s) return;
      for (let i = s.c.length - 1; i >= 0; i--) {
        if (typeof s.c[i] === "number") { now[t] = s.c[i] as number; break; }
      }
    }));
    return json({ grants, prices: now, children: CHILDREN });
  }

  if (action === "add") {
    const child = String(body?.child || "");
    const ticker = String(body?.ticker || "").trim().toUpperCase();
    const shares = Number(body?.shares);
    // A bare YYYY-MM-DD parses as midnight UTC, which renders as the previous
    // day anywhere west of Greenwich. Anchor it to midday UTC so the date shown
    // is the date entered, in any timezone the family reads it in.
    const raw = String(body?.purchased_at || "");
    const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    const when = ymd
      ? Date.UTC(+ymd[1], +ymd[2] - 1, +ymd[3], 12, 0, 0)
      : Date.parse(raw);
    const note = body?.note ? String(body.note).slice(0, 200) : null;

    if (!CHILDREN[child]) return json({ error: "unknown_child" }, 400);
    if (!/^[A-Z][A-Z.\-]{0,9}$/.test(ticker)) return json({ error: "bad_ticker" }, 400);
    if (!isFinite(shares) || shares <= 0) return json({ error: "bad_shares" }, 400);
    if (!isFinite(when)) return json({ error: "bad_date" }, 400);
    if (when > Date.now() + 86400_000) return json({ error: "future_date" }, 400);

    // Reject a ticker the feed does not know, rather than storing a typo that
    // silently shows no value later.
    const price = await priceOn(ticker, when);
    if (price == null) return json({ error: "unknown_ticker", ticker }, 400);

    const ins = await fetch(`${SB_URL()}/rest/v1/stock_grants`, {
      method: "POST",
      headers: { ...sbHeaders(), "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ child, ticker, shares, purchased_at: new Date(when).toISOString(), price_at_purchase: price, note }),
    });
    if (!ins.ok) return json({ error: "insert_failed", detail: await ins.text() }, 502);
    return json({ ok: true, grant: (await ins.json())[0] });
  }

  if (action === "delete") {
    const id = String(body?.id || "");
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad_id" }, 400);
    const r = await fetch(`${SB_URL()}/rest/v1/stock_grants?id=eq.${id}`, { method: "DELETE", headers: sbHeaders() });
    if (!r.ok) return json({ error: "delete_failed" }, 502);
    return json({ ok: true });
  }

  return json({ error: "unknown_action" }, 400);
});

// The stock-reward tab: what a child's fractional shares are worth over time.
//
// Shared verbatim by all three apps. Colours come from CSS variables so each
// app themes it; the palette itself is the validated categorical order, used in
// fixed slot order so a ticker keeps its colour when the selection changes.
var STOCKS = (function () {
  "use strict";

  var FN = "/functions/v1/stocks";
  var RANGES = [
    { key: "today", label: "Today" },
    { key: "week",  label: "1 week" },
    { key: "month", label: "1 month" },
    { key: "six",   label: "6 months" },
    { key: "year",  label: "1 year" }
  ];
  var MAX_SERIES = 6;   // past this, tickers fold into "Other"

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function money(n) {
    var v = Math.abs(Number(n) || 0);
    return (Number(n) < 0 ? "-$" : "$") + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function shares(n) {
    return String(Number(n)).replace(/(\.\d*?[1-9])0+$/, "$1");
  }
  function stamp(t, range) {
    var d = new Date(t);
    return range === "today"
      ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  /* ---------- data ---------- */
  var cache = {};          // range -> { at, payload }
  var TTL = 60 * 1000;

  function load(cfg, child, range) {
    var hit = cache[range];
    if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.payload);
    return fetch(cfg.url + FN, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.key, Authorization: "Bearer " + cfg.key },
      body: JSON.stringify({ action: "series", child: child, range: range })
    }).then(function (r) {
      if (!r.ok) throw new Error("http_" + r.status);
      return r.json();
    }).then(function (p) {
      cache[range] = { at: Date.now(), payload: p };
      return p;
    });
  }
  function clearCache() { cache = {}; }

  /* ---------- chart ---------- */
  // series: [{ key, label, values:[number|null] }], stamps: [ms]
  function chart(stamps, series, range, opts) {
    var W = 680, H = 230, padL = 52, padR = opts.labelRoom ? 58 : 14, padT = 12, padB = 26;
    var plotW = W - padL - padR, plotH = H - padT - padB;

    var all = [];
    series.forEach(function (s) {
      s.values.forEach(function (v) { if (typeof v === "number") all.push(v); });
    });
    if (!all.length) return "";
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi === lo) { hi = lo + Math.max(1, lo * 0.02); lo = Math.max(0, lo - Math.max(1, lo * 0.02)); }
    var pad = (hi - lo) * 0.12;
    lo = Math.max(0, lo - pad); hi = hi + pad;

    var x = function (i) { return padL + (stamps.length < 2 ? plotW / 2 : (plotW * i) / (stamps.length - 1)); };
    var y = function (v) { return padT + plotH - (plotH * (v - lo)) / (hi - lo); };

    // recessive grid + money axis
    var grid = "", ticks = 4;
    for (var g = 0; g <= ticks; g++) {
      var v = lo + ((hi - lo) / ticks) * g, gy = y(v);
      grid += '<line x1="' + padL + '" x2="' + (W - padR) + '" y1="' + gy.toFixed(1) + '" y2="' + gy.toFixed(1) +
        '" stroke="var(--line)" stroke-width="1" opacity=".55"/>' +
        '<text x="' + (padL - 8) + '" y="' + (gy + 3.5).toFixed(1) + '" text-anchor="end" font-size="10" fill="var(--muted)">' +
        "$" + (v >= 100 ? Math.round(v) : v.toFixed(1)) + "</text>";
    }

    var lines = "", labels = [];
    series.forEach(function (s, si) {
      var d = "", open = false;
      s.values.forEach(function (val, i) {
        if (typeof val !== "number") { open = false; return; }
        d += (open ? "L" : "M") + x(i).toFixed(1) + "," + y(val).toFixed(1);
        open = true;
      });
      if (!d) return;
      lines += '<path d="' + d + '" fill="none" stroke="' + s.color + '" stroke-width="2" ' +
        'stroke-linejoin="round" stroke-linecap="round"/>';
      if (opts.labelRoom) {
        for (var i = s.values.length - 1; i >= 0; i--) {
          if (typeof s.values[i] === "number") { labels.push({ y: y(s.values[i]), text: s.label, color: s.color }); break; }
        }
      }
    });

    // Direct labels at the line ends; nudge apart so converging lines stay legible.
    var labelSvg = "";
    labels.sort(function (a, b) { return a.y - b.y; });
    labels.forEach(function (l, i) {
      if (i && l.y - labels[i - 1].y < 12) l.y = labels[i - 1].y + 12;
      labelSvg += '<text x="' + (W - padR + 6) + '" y="' + (l.y + 3.5).toFixed(1) + '" font-size="10.5" ' +
        'font-weight="600" fill="' + l.color + '">' + esc(l.text) + "</text>";
    });

    var xl = "";
    [0, Math.floor((stamps.length - 1) / 2), stamps.length - 1].forEach(function (i, n) {
      if (i < 0 || !stamps.length) return;
      xl += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 8) + '" font-size="10" fill="var(--muted)" text-anchor="' +
        (n === 0 ? "start" : n === 2 ? "end" : "middle") + '">' + esc(stamp(stamps[i], range)) + "</text>";
    });

    var hits = stamps.map(function (t, i) {
      var w = plotW / Math.max(1, stamps.length - 1);
      var vals = series.map(function (s) {
        return typeof s.values[i] === "number" ? s.label + "~~" + money(s.values[i]) : null;
      }).filter(Boolean).join("||");
      return '<rect class="stk-hit" x="' + (x(i) - w / 2).toFixed(1) + '" y="' + padT + '" width="' + w.toFixed(1) +
        '" height="' + plotH + '" fill="transparent" data-cx="' + x(i).toFixed(1) +
        '" data-when="' + esc(stamp(t, range)) + '" data-vals="' + esc(vals) + '"></rect>';
    }).join("");

    return '<div class="stk-chart"><svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' +
      esc(opts.aria) + '">' + grid + lines + labelSvg + xl + hits +
      '<line class="stk-cross" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + plotH) +
      '" stroke="var(--ink)" stroke-width="1" opacity="0"/></svg><div class="stk-tip" hidden></div></div>';
  }

  /* ---------- view ---------- */
  function render(payload, ui, opts) {
    opts = opts || {};
    var toggles = '<div class="stk-tabs" role="group" aria-label="Time range">' +
      RANGES.map(function (r) {
        return '<button data-act="stk-range" data-range="' + r.key + '" class="' +
          (ui.range === r.key ? "on" : "") + '">' + r.label + "</button>";
      }).join("") + "</div>";

    if (!payload) {
      return '<div class="card"><h3 style="margin:0 0 6px;">My shares</h3>' + toggles +
        '<p class="explain" style="margin:10px 0 0;">Loading…</p></div>';
    }
    if (payload.error) {
      return '<div class="card"><h3 style="margin:0 0 6px;">My shares</h3>' + toggles +
        '<p class="explain" style="margin:10px 0 0;">Could not load prices just now. Try again in a moment.</p></div>';
    }
    if (!payload.grants || !payload.grants.length) {
      return '<div class="card"><h3 style="margin:0 0 6px;">My shares</h3>' +
        '<p class="explain" style="margin:8px 0 0;">' + esc(opts.emptyText || "No shares yet. Keep practising!") + "</p></div>";
    }

    var s = payload.summary || {};
    var up = (s.gain || 0) >= 0;
    var hero = '<div class="stk-hero">' +
      '<div><b>' + money(s.value) + '</b><span>what it is worth now</span></div>' +
      '<div class="' + (up ? "up" : "down") + '"><b>' + (up ? "+" : "") + money(s.gain) +
        (s.gainPct == null ? "" : " <small>(" + (up ? "+" : "") + s.gainPct.toFixed(1) + "%)</small>") +
      '</b><span>since it was bought</span></div>' +
      "</div>";

    // One colour per ticker, in fixed slot order, so a ticker keeps its colour
    // when the range changes or a new one is added.
    var tickers = (payload.tickers || []).map(function (t) { return t.ticker; });
    var shown = tickers.slice(0, MAX_SERIES);
    var stamps = payload.points.map(function (p) { return p.t; });

    var series;
    if (ui.mode === "each") {
      series = shown.map(function (tk, i) {
        return {
          key: tk, label: tk, color: "var(--s" + (i + 1) + ")",
          values: payload.points.map(function (p) { return typeof p.per[tk] === "number" ? p.per[tk] : null; })
        };
      });
      if (tickers.length > MAX_SERIES) {
        var rest = tickers.slice(MAX_SERIES);
        series.push({
          key: "other", label: "Other", color: "var(--muted)",
          values: payload.points.map(function (p) {
            var n = 0, any = false;
            rest.forEach(function (tk) { if (typeof p.per[tk] === "number") { n += p.per[tk]; any = true; } });
            return any ? n : null;
          })
        });
      }
    } else {
      series = [{ key: "total", label: "Total", color: "var(--stk-total)",
        values: payload.points.map(function (p) { return p.total; }) }];
    }

    var modes = '<div class="stk-tabs alt" role="group" aria-label="What to show">' +
      '<button data-act="stk-mode" data-mode="total" class="' + (ui.mode === "total" ? "on" : "") + '">All together</button>' +
      '<button data-act="stk-mode" data-mode="each" class="' + (ui.mode === "each" ? "on" : "") + '">Each stock</button>' +
      "</div>";

    // A legend is required for two or more lines, and it doubles as the relief
    // for the lighter slots' contrast.
    var legend = "";
    if (series.length > 1) {
      legend = '<div class="stk-legend">' + series.map(function (sr) {
        return '<span class="stk-key"><i style="background:' + sr.color + '"></i>' + esc(sr.label) + "</span>";
      }).join("") + "</div>";
    }

    var body = chart(stamps, series, ui.range, {
      labelRoom: series.length > 1 && series.length <= 4,
      aria: "Line chart of " + (ui.mode === "each" ? "each stock's value" : "total share value") + " over the chosen period"
    });
    if (!body) body = '<p class="explain">No prices for this period yet.</p>';

    var note = "";
    if (s.addedInWindow && s.addedInWindow.length) {
      note = '<p class="explain" style="margin:8px 0 0;">A new share was added during this period, so part of the ' +
        "rise is the new share rather than prices going up.</p>";
    }

    var rows = (payload.grants || []).slice().sort(function (a, b) {
      return Date.parse(b.purchased_at) - Date.parse(a.purchased_at);
    });
    var last = payload.points[payload.points.length - 1] || { per: {} };
    var priceNow = {};
    tickers.forEach(function (tk) {
      var held = rows.filter(function (g) { return g.ticker === tk; })
        .reduce(function (n, g) { return n + Number(g.shares); }, 0);
      if (held > 0 && typeof last.per[tk] === "number") priceNow[tk] = last.per[tk] / held;
    });

    var table = '<div class="tblwrap" style="margin-top:12px;"><table><thead><tr>' +
      "<th>Stock</th><th>Shares</th><th>Bought</th><th>Worth now</th></tr></thead><tbody>" +
      rows.map(function (g) {
        var now = priceNow[g.ticker] ? priceNow[g.ticker] * Number(g.shares) : null;
        return "<tr><td class=\"w\">" + esc(g.ticker) + "</td><td>" + shares(g.shares) + "</td><td>" +
          new Date(g.purchased_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
          "</td><td>" + (now == null ? "&mdash;" : money(now)) + "</td></tr>";
      }).join("") + "</tbody></table></div>";

    return '<div class="card">' +
      '<h3 style="margin:0 0 10px;">My shares</h3>' + hero + toggles + modes + legend + body + note + table +
      '<p class="explain" style="margin:10px 0 0;">Prices come from the stock market and can go down as well as up.</p>' +
      "</div>";
  }

  /* ---------- hover ---------- */
  function wire() {
    var host = document.querySelector(".stk-chart");
    if (!host || host.dataset.wired) return;
    host.dataset.wired = "1";
    var svg = host.querySelector("svg"), tip = host.querySelector(".stk-tip"), cross = host.querySelector(".stk-cross");
    function hide() { tip.hidden = true; if (cross) cross.setAttribute("opacity", "0"); }
    host.addEventListener("mouseleave", hide);
    host.addEventListener("mousemove", function (e) {
      var t = e.target;
      if (!t || !t.classList || !t.classList.contains("stk-hit")) return;
      var box = host.getBoundingClientRect();
      var scale = box.width / svg.viewBox.baseVal.width;
      var cx = parseFloat(t.dataset.cx) * scale;
      if (cross) {
        cross.setAttribute("x1", t.dataset.cx); cross.setAttribute("x2", t.dataset.cx);
        cross.setAttribute("opacity", ".35");
      }
      var rows = (t.dataset.vals || "").split("||").filter(Boolean).map(function (pair) {
        var bits = pair.split("~~");
        return '<div class="r"><span>' + esc(bits[0]) + "</span><b>" + esc(bits[1]) + "</b></div>";
      }).join("");
      tip.innerHTML = '<div class="d">' + esc(t.dataset.when) + "</div>" + rows;
      tip.hidden = false;
      tip.style.left = Math.min(Math.max(cx, 66), box.width - 66) + "px";
      tip.style.top = (box.height - 28) + "px";
    });
  }

  return { load: load, render: render, wire: wire, clearCache: clearCache,
           RANGES: RANGES, chart: chart, money: money, esc: esc };
})();

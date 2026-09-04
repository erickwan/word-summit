// Talks to the generate-questions edge function and validates what comes back.
// Anything that fails validation is dropped, and the app falls back to its own
// locally-built question for that word — a malformed question never reaches the
// student.
var QGEN = (function () {
  "use strict";

  var TIMEOUT_MS = 90000;
  var KNOWN_TYPES = { meaning:1, wordpick:1, syn:1, ant:1, cloze:1, scen:1, analogy:1, oddone:1 };

  function lev(a, b) {
    if (a.length < b.length) { var t = a; a = b; b = t; }
    var prev = [], i, j;
    for (j = 0; j <= b.length; j++) prev[j] = j;
    for (i = 1; i <= a.length; i++) {
      var cur = [i];
      for (j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // Does `text` contain the target word (or a close inflection of it)?
  function mentions(text, word) {
    var toks = String(text).toLowerCase().match(/[a-z]+/g) || [];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      if (t === word) return true;
      if (t.length > word.length && t.indexOf(word) === 0) return true;
      if (t.length >= 5 && t.charAt(0) === word.charAt(0) && lev(t, word) <= 1) return true;
    }
    return false;
  }

  function validate(q, item) {
    if (!q || !KNOWN_TYPES[q.type]) return null;
    var opts = (q.options || []).map(function (o) { return String(o).trim(); }).filter(Boolean);
    var answer = String(q.answer || "").trim();
    if (opts.length < 3 || opts.length > 4) return null;
    if (opts.indexOf(answer) < 0) return null;

    var lower = opts.map(function (o) { return o.toLowerCase(); });
    for (var i = 0; i < lower.length; i++) {
      if (lower.indexOf(lower[i]) !== i) return null;   // duplicate options
    }

    var word = String(item.word).toLowerCase();
    var prompt = String(q.prompt || "").trim();

    if (q.type === "cloze") {
      var blanks = prompt.match(/___+/g);
      if (!blanks || blanks.length !== 1) return null;
      if (answer.toLowerCase() !== word) return null;
      if (mentions(prompt.replace(/___+/g, " "), word)) return null;   // sentence gives it away
    }
    if (q.type === "syn" || q.type === "ant") {
      if (lower.indexOf(word) >= 0) return null;   // target must not be an option
    }
    if (q.type === "scen" || q.type === "analogy" || q.type === "oddone") {
      if (!prompt) return null;
    }
    if (q.type === "wordpick" && answer.toLowerCase() !== word) return null;

    // Per-option explanations, keyed by option text so the app can explain the
    // exact wrong answer the student picked. Missing entries are tolerated —
    // the feedback just falls back to the general note for those options.
    var why = {};
    (q.distractors || []).forEach(function (d) {
      if (!d) return;
      var opt = String(d.option || "").trim();
      var text = String(d.why || "").trim();
      if (opt && text && opt !== answer && opts.indexOf(opt) >= 0) why[opt] = text;
    });

    return {
      item: item,
      type: q.type,
      prompt: prompt,
      options: opts,
      answer: answer,
      teach: String(q.teach || "").trim(),
      why: why,
      generated: true
    };
  }


  // The service caps how many words one request may carry, and a long request is
  // slow. Rounds are therefore split into chunks generated in parallel, so a
  // 20-word round costs about the same wall-clock time as a 10-word one. A chunk
  // that fails only costs its own words, which fall back to local questions.
  var CHUNK = 5;

  function generate(config, words, profile) {
    if (!config || !config.url || !config.key || !words.length) {
      return Promise.resolve({ ok: false, why: "not_configured", questions: {} });
    }
    var chunks = [];
    for (var i = 0; i < words.length; i += CHUNK) chunks.push(words.slice(i, i + CHUNK));

    return Promise.all(chunks.map(function (c) { return generateBatch(config, c, profile); }))
      .then(function (results) {
        var questions = {}, kept = 0, dropped = 0, why = null;
        results.forEach(function (r) {
          Object.keys(r.questions || {}).forEach(function (id) { questions[id] = r.questions[id]; });
          kept += r.kept || 0;
          dropped += r.dropped || 0;
          if (!r.ok && !why) why = r.why;
        });
        return { ok: kept > 0, why: kept ? null : (why || "all_invalid"),
                 questions: questions, kept: kept, dropped: dropped, chunks: chunks.length };
      });
  }

  // words: [{id, word, pos, meaning, example, level, history}]
  // Resolves to a map of wordId -> validated question. Never rejects; on any
  // failure it resolves to an empty map and the caller falls back.
  function generateBatch(config, words, profile) {
    if (!config || !config.url || !config.key || !words.length) {
      return Promise.resolve({ ok: false, why: "not_configured", questions: {} });
    }
    var payload = {
      profile: profile,
      words: words.map(function (w) {
        return {
          id: w.item.id, word: w.item.word, pos: w.item.pos,
          meaning: w.item.meaning, example: w.item.example,
          recent: w.recent || [],
          level: w.item.level, history: w.history
        };
      })
    };
    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);

    return fetch(config.url + "/functions/v1/generate-questions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: config.key,
        Authorization: "Bearer " + config.key
      },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      return r.json().then(function (data) { return { status: r.status, data: data }; });
    }).then(function (res) {
      clearTimeout(timer);
      if (res.status !== 200 || !res.data || !res.data.questions) {
        return { ok: false, why: (res.data && res.data.error) || "http_" + res.status, questions: {} };
      }
      var byId = {};
      words.forEach(function (w) { byId[w.item.id] = w.item; });
      var out = {}, kept = 0, dropped = 0;
      res.data.questions.forEach(function (q) {
        var item = byId[q.wordId];
        if (!item || out[q.wordId]) { dropped++; return; }
        var v = validate(q, item);
        if (v) { out[q.wordId] = v; kept++; } else { dropped++; }
      });
      return { ok: kept > 0, why: kept ? null : "all_invalid", questions: out, kept: kept, dropped: dropped };
    }).catch(function () {
      clearTimeout(timer);
      return { ok: false, why: "network", questions: {} };
    });
  }

  /* Question cache.
     Generated questions are kept per word so that reopening the app, or
     reloading mid-round, does not pay to regenerate. A question is dropped
     once it has actually been asked, so the next review of that word gets a
     fresh one. */
  function Cache(key, maxAgeMs) {
    var store = {};
    try { store = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (e) { store = {}; }
    var now = Date.now();
    Object.keys(store).forEach(function (id) {
      if (!store[id] || now - (store[id].ts || 0) > maxAgeMs) delete store[id];
    });
    function flush() {
      try { localStorage.setItem(key, JSON.stringify(store)); } catch (e) {}
    }
    return {
      get: function (id) { return store[id] ? store[id].q : null; },
      put: function (id, q) { store[id] = { q: q, ts: Date.now() }; flush(); },
      putAll: function (map) {
        Object.keys(map).forEach(function (id) { store[id] = { q: map[id], ts: Date.now() }; });
        flush();
      },
      consume: function (id) { if (store[id]) { delete store[id]; flush(); } },
      size: function () { return Object.keys(store).length; }
    };
  }

  /* What has already been asked about each word.
     Without this the service receives an identical payload every time a word
     comes up for review, and returns near-identical questions — the same type,
     the same setting, even the same wrong options. Sending the last few asks
     back lets it deliberately do something different. Kept on the device
     rather than in the synced state, so an older cached build cannot wipe it. */
  function AskLog(key, keepPerWord, maxAgeMs) {
    var store = {};
    try { store = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch (e) { store = {}; }
    var now = Date.now();
    Object.keys(store).forEach(function (id) {
      store[id] = (store[id] || []).filter(function (e) { return now - (e.t || 0) <= maxAgeMs; });
      if (!store[id].length) delete store[id];
    });
    function flush() {
      try { localStorage.setItem(key, JSON.stringify(store)); } catch (e) {}
    }
    return {
      note: function (id, type, prompt, options, answer) {
        if (!id || !type) return;
        var opts = (options || []).filter(function (o) { return o !== answer; })
          .map(function (o) { return String(o); }).slice(0, 3);
        var entry = { t: Date.now(), type: type, gist: String(prompt || "").slice(0, 90), opts: opts };
        store[id] = (store[id] || []).concat([entry]).slice(-keepPerWord);
        flush();
      },
      recent: function (id) {
        return (store[id] || []).map(function (e) {
          return { type: e.type, gist: e.gist, opts: e.opts || [] };
        });
      },
      lastType: function (id) {
        var l = store[id] || [];
        return l.length ? l[l.length - 1].type : null;
      }
    };
  }

  // Generate only for words with no fresh cached question, then merge.
  function generateCached(cache, config, words, profile) {
    var have = {}, need = [];
    words.forEach(function (w) {
      var hit = cache.get(w.item.id);
      if (hit) { hit.item = w.item; have[w.item.id] = hit; }
      else need.push(w);
    });
    if (!need.length) {
      return Promise.resolve({ ok: true, why: "cached", questions: have, fromCache: true });
    }
    return generate(config, need, profile).then(function (r) {
      cache.putAll(r.questions || {});
      Object.keys(r.questions || {}).forEach(function (id) { have[id] = r.questions[id]; });
      return {
        ok: Object.keys(have).length > 0,
        why: r.why,
        questions: have,
        generated: Object.keys(r.questions || {}).length
      };
    });
  }

  return { generate: generate, generateCached: generateCached, validate: validate,
           Cache: Cache, AskLog: AskLog };
})();

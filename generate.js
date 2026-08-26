// Talks to the generate-questions edge function and validates what comes back.
// Anything that fails validation is dropped, and the app falls back to its own
// locally-built question for that word — a malformed question never reaches the
// student.
var QGEN = (function () {
  "use strict";

  var TIMEOUT_MS = 45000;
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

    return {
      item: item,
      type: q.type,
      prompt: prompt,
      options: opts,
      answer: answer,
      teach: String(q.teach || "").trim(),
      generated: true
    };
  }

  // words: [{id, word, pos, meaning, example, level, history}]
  // Resolves to a map of wordId -> validated question. Never rejects; on any
  // failure it resolves to an empty map and the caller falls back.
  function generate(config, words, profile) {
    if (!config || !config.url || !config.key || !words.length) {
      return Promise.resolve({ ok: false, why: "not_configured", questions: {} });
    }
    var payload = {
      profile: profile,
      words: words.map(function (w) {
        return {
          id: w.item.id, word: w.item.word, pos: w.item.pos,
          meaning: w.item.meaning, example: w.item.example,
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

  return { generate: generate, generateCached: generateCached, validate: validate, Cache: Cache };
})();

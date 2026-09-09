#!/usr/bin/env node
/**
 * CrossRun offline content pipeline.
 *
 *   node generate-puzzles.mjs --count 50000 --out bundle.json
 *   node generate-puzzles.mjs --count 200 --dry          # no API calls
 *   node generate-puzzles.mjs --count 50000 --verify     # second pass: can the clue be solved?
 *
 * Needs ANTHROPIC_API_KEY in the environment unless --dry.
 *
 * Clues are checkpointed to <out>.clues.json after every stage. If a run dies,
 * rerun the same command with --resume and only the missing work is redone.
 *
 * Output bundle shape:
 *   { lexicon: {3:"...",4:"...",5:"..."},      // packed, index-addressable
 *     templates: [["#...#", ...], ...],
 *     puzzles:  [{t: 0, w: [412, 1901, ...]}], // template index + word indices
 *     clues:    { ROBOT: ["plain", "standard", "oblique"] } }
 *
 * Puzzles store word *indices*, and clues live in one shared pool with three
 * difficulty tiers per word. So a 50k-puzzle bundle costs ~1.5MB and the API
 * bill is one pass over the vocabulary (~5k words), not one per puzzle.
 * Pick the clue tier at runtime from the player's level and the same word
 * reads differently on a later run.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i === -1 ? d : args[i + 1];
};
const flag = (k) => args.includes(`--${k}`);

const COUNT = +arg("count", 5000);
const OUT = arg("out", "bundle.json");
const CONCURRENCY = +arg("concurrency", 4);
const BATCH = +arg("batch", 30);
const DRY = flag("dry");
const VERIFY = flag("verify");
const RESUME = flag("resume");
const CACHE = OUT.replace(/\.json$/, "") + ".clues.json";
const GRIDS = OUT.replace(/\.json$/, "") + ".grids.json";
const MODEL = arg("model", "claude-sonnet-4-6");
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!DRY && !API_KEY) {
  console.error("Set ANTHROPIC_API_KEY, or pass --dry to generate grids only.");
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* lexicon + solver                                                     */
/* ------------------------------------------------------------------ */

const LEX = JSON.parse(fs.readFileSync(path.join(HERE, "lexicon.json"), "utf8"));
// Belt and braces: these are out of lexicon.json, but never ship them regardless.
const BLOCKED = new Set("NEGRO NIGGA CHINK COON HOMO CUNT RAPED JIHAD SLAVE GYPSY SQUAW GIMP NIP".split(" "));

const TEMPLATES = [
  ["#...#", ".....", ".....", ".....", "#...#"],
  ["...##", ".....", ".....", ".....", "##..."],
  ["##...", ".....", ".....", ".....", "...##"],
  [".....", ".....", "..#..", ".....", "....."],
  ["#....", ".....", ".....", ".....", "....#"],
  [".#..", "....", "....", "..#."],
  ["....", "....", "....", "...."],
  [".#..", "....", "....", "...."],
  ["....", "....", "....", "..#."],
];

function buildIndex(pack) {
  const idx = {};
  for (const L of Object.keys(pack)) {
    const n = +L, s = pack[L], count = s.length / n;
    const words = new Array(count);
    for (let i = 0; i < count; i++) words[i] = s.slice(i * n, (i + 1) * n);
    const nw = (count + 31) >> 5;
    const bits = new Uint32Array(n * 26 * nw);
    for (let i = 0; i < count; i++)
      for (let p = 0; p < n; p++)
        bits[(p * 26 + (words[i].charCodeAt(p) - 65)) * nw + (i >> 5)] |= 1 << (i & 31);
    const all = new Uint32Array(nw).fill(0xffffffff);
    if (count & 31) all[nw - 1] = (1 << (count & 31)) - 1;
    idx[n] = { words, count, nw, bits, all, rank: new Map(words.map((w, i) => [w, i])) };
  }
  return idx;
}
const IDX = buildIndex(LEX);

function slotsOf(grid) {
  const R = grid.length, C = grid[0].length, out = [];
  for (let r = 0; r < R; r++) {
    let c = 0;
    while (c < C) {
      if (grid[r][c] === "#") { c++; continue; }
      const s = c;
      while (c < C && grid[r][c] !== "#") c++;
      if (c - s >= 3) out.push({ dir: "A", cells: Array.from({ length: c - s }, (_, i) => [r, s + i]) });
    }
  }
  for (let c = 0; c < C; c++) {
    let r = 0;
    while (r < R) {
      if (grid[r][c] === "#") { r++; continue; }
      const s = r;
      while (r < R && grid[r][c] !== "#") r++;
      if (r - s >= 3) out.push({ dir: "D", cells: Array.from({ length: r - s }, (_, i) => [s + i, c]) });
    }
  }
  return out;
}

// Every white cell must belong to at least one entry, or the player gets a
// square with no clue attached to it. Cheap check, catches a whole class of bug.
function orphanCell(t) {
  const cov = new Set();
  slotsOf(t).forEach((s) => s.cells.forEach(([r, c]) => cov.add(`${r},${c}`)));
  for (let r = 0; r < t.length; r++)
    for (let c = 0; c < t[0].length; c++)
      if (t[r][c] !== "#" && !cov.has(`${r},${c}`)) return [r, c];
  return null;
}
TEMPLATES.forEach((t, i) => {
  const o = orphanCell(t);
  if (o) { console.error(`template ${i} has an unclued cell at ${o}`); process.exit(1); }
});

// Only the commonest `capFrac` of each length may be used. Mirrors the game's
// difficulty ramp, so a bundle carries grids the early levels can actually use.
function capMask(D, capFrac) {
  const cap = Math.min(D.count, Math.max(80, Math.ceil(D.count * capFrac)));
  const m = Uint32Array.from(D.all);
  for (let i = cap; i < D.count; i++) m[i >> 5] &= ~(1 << (i & 31));
  return m;
}

function fillGrid(template, bias, capFrac = 1) {
  const slots = slotsOf(template);
  const caps = {};
  for (const n of Object.keys(IDX)) caps[n] = capMask(IDX[n], capFrac);
  const cells = new Map(), assigned = new Array(slots.length).fill(null), used = new Set();
  const key = (r, c) => r * 16 + c;
  let steps = 0;

  const candidates = (i) => {
    const cs = slots[i].cells, n = cs.length, D = IDX[n];
    const acc = Uint32Array.from(caps[n]);
    for (let p = 0; p < n; p++) {
      const ch = cells.get(key(cs[p][0], cs[p][1]));
      if (!ch) continue;
      const off = (p * 26 + (ch.charCodeAt(0) - 65)) * D.nw;
      for (let k = 0; k < D.nw; k++) acc[k] &= D.bits[off + k];
    }
    const res = [];
    for (let k = 0; k < D.nw; k++) {
      let v = acc[k];
      while (v) {
        const b = v & -v;
        const w = D.words[(k << 5) + (31 - Math.clz32(b))];
        if (!used.has(w)) res.push(w);
        v ^= b;
      }
    }
    return res;
  };

  const order = slots.map((_, i) => i);
  function search(k) {
    if (++steps > 60000) throw new Error("budget");
    if (k === order.length) return true;
    let bestAt = -1, best = null;
    for (let t = k; t < order.length; t++) {
      const l = candidates(order[t]);
      if (best === null || l.length < best.length) { bestAt = t; best = l; }
      if (l.length === 0) break;
    }
    if (best.length === 0) return false;
    [order[k], order[bestAt]] = [order[bestAt], order[k]];
    const i = order[k], cs = slots[i].cells;
    const pool = best.slice(), tries = [];
    while (pool.length && tries.length < 25)
      tries.push(pool.splice(Math.floor(Math.pow(Math.random(), bias) * pool.length), 1)[0]);
    for (const w of tries) {
      const prev = cs.map(([r, c]) => cells.get(key(r, c)));
      cs.forEach(([r, c], p) => cells.set(key(r, c), w[p]));
      used.add(w); assigned[i] = w;
      if (search(k + 1)) return true;
      used.delete(w); assigned[i] = null;
      cs.forEach(([r, c], p) => {
        const kk = key(r, c);
        if (prev[p] === undefined) cells.delete(kk); else cells.set(kk, prev[p]);
      });
    }
    return false;
  }
  try { if (!search(0)) return null; } catch { return null; }
  return assigned;
}

/* ------------------------------------------------------------------ */
/* stage 1 — grids                                                      */
/* ------------------------------------------------------------------ */

function generateGrids(n) {
  const seen = new Set(), puzzles = [], t0 = Date.now();
  let attempts = 0;
  while (puzzles.length < n) {
    attempts++;
    if (attempts > n * 20) { console.warn("giving up early, template pool exhausted"); break; }
    const t = Math.floor(Math.random() * TEMPLATES.length);
    const bias = 1.2 + Math.random() * 3; // spread of common vs unusual fills
    const cap = 0.3 + Math.random() * 0.7; // spread of vocabulary size, 30% to all of it
    const words = fillGrid(TEMPLATES[t], bias, cap);
    if (!words || words.some((w) => BLOCKED.has(w))) continue;
    const sig = t + ":" + words.join(",");
    if (seen.has(sig)) continue;
    seen.add(sig);
    puzzles.push({
      t,
      w: words.map((w) => IDX[w.length].rank.get(w)),
      words,
    });
    if (puzzles.length % 5000 === 0)
      console.log(`  ${puzzles.length}/${n} grids (${Math.round(puzzles.length / ((Date.now() - t0) / 1000))}/s)`);
  }
  console.log(`grids: ${puzzles.length} unique in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return puzzles;
}

// Mean word rank is a decent cold-start difficulty proxy. Replace it with real
// per-word solve rates once you have telemetry; frequency stops being a good
// signal quickly.
function rawDifficulty(p) {
  return p.w.reduce((a, i, k) => a + i / IDX[p.words[k].length].count, 0) / p.w.length;
}
// Bucket on the terciles of the batch you actually generated, rather than on
// hardcoded thresholds that drift whenever the lexicon changes.
function bucketer(all) {
  if (!all.length) return () => 1;
  const sorted = all.map(rawDifficulty).sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length / 3)];
  const hi = sorted[Math.floor((2 * sorted.length) / 3)];
  return (p) => (rawDifficulty(p) < lo ? 0 : rawDifficulty(p) < hi ? 1 : 2);
}

/* ------------------------------------------------------------------ */
/* stage 2 — clues                                                      */
/* ------------------------------------------------------------------ */

const TIERS = [
  { name: "plain", brief: "a plain dictionary-style definition" },
  { name: "standard", brief: "a normal crossword clue, slightly indirect" },
  { name: "oblique", brief: "a wry, oblique clue with light wordplay, still fair" },
];

async function callClaude(prompt, maxTokens = 2000) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      const data = await res.json();
      if (!res.ok || data.error) {
        // 4xx other than 429 is a bad request: retrying it just burns time
        const e = new Error(data.error ? data.error.message : `http ${res.status}`);
        e.fatal = true;
        throw e;
      }
      return data.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    } catch (e) {
      if (e.fatal || attempt === 4) throw e;
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
    }
  }
}

function parseJson(text) {
  const t = text.replace(/```json|```/g, "").trim();
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in reply");
  return JSON.parse(t.slice(start, end + 1));
}

// A clue is unusable if it leaks the answer. Compare whole words, not
// substrings: "Loneliest number" is a fine clue for ONE, and a THEN clue that
// contains "the" is not a leak. Inflections of the answer (BAKER / bakes,
// USED / use, CATS / cat) are still caught. Suffixes are only stripped where
// they are a real inflection, so FORD does not get the root "for" and THEY
// does not get "the".
function leaksAnswer(clue, word) {
  const w = word.toLowerCase();
  const roots = new Set([w]);
  const addRoot = (r) => {
    roots.add(r);
    if (!r.endsWith("e")) roots.add(r + "e");                                   // baker -> bake
    if (r.length > 3 && r[r.length - 1] === r[r.length - 2]) roots.add(r.slice(0, -1)); // running -> run
  };
  const strip = (suf) => (w.endsWith(suf) ? w.slice(0, -suf.length) : null);
  let r;
  if ((r = strip("s")) && r.length >= 3) addRoot(r);
  if ((r = strip("es")) && r.length >= 3 && /(s|x|z|ch|sh)$/.test(r)) addRoot(r);
  if ((r = strip("d")) && r.length >= 3 && r.endsWith("e")) addRoot(r);      // used -> use
  for (const suf of ["ed", "er", "ers", "ing"]) if ((r = strip(suf)) && r.length >= 3) addRoot(r);
  for (const suf of ["ly", "y"]) if ((r = strip(suf)) && r.length >= 4) addRoot(r); // windy -> wind, not they -> the
  for (const suf of ["ies", "ied", "ier", "iest"]) if ((r = strip(suf)) && r.length >= 2) roots.add(r + "y"); // tries -> try
  const forms = new Set();
  for (const r of roots) {
    forms.add(r);
    forms.add(r + (/(s|x|z|ch|sh)$/.test(r) ? "es" : "s"));
    if (r.endsWith("e")) for (const suf of ["d", "r", "rs"]) forms.add(r + suf);
    const stem = r.endsWith("e") ? r.slice(0, -1) : r;
    for (const suf of ["ed", "er", "ers", "ing"]) forms.add(stem + suf);
    if (/[^aeiouwxy]$/.test(r) && /[aeiou][^aeiou]$/.test(r))                   // run -> running, sun -> sunny
      for (const suf of ["ed", "er", "ers", "ing", "y"]) forms.add(r + r[r.length - 1] + suf);
    if (r.endsWith("y")) for (const suf of ["ies", "ied", "ier", "iest"]) forms.add(r.slice(0, -1) + suf);
    else if (r.length >= 4) { forms.add(r + "y"); forms.add(r + "ly"); }
  }
  const tokens = clue.toLowerCase().match(/[a-z]+/g) || [];
  return tokens.some((t) => forms.has(t));
}

function clueIsSane(clue, word) {
  if (typeof clue !== "string") return false;
  const c = clue.trim();
  if (c.length < 3 || c.length > 50) return false;
  if (c.split(/\s+/).length > 8) return false;
  if (/\(\d+\)/.test(c)) return false;          // enumerations give the length away
  if (leaksAnswer(c, word)) return false;
  return true;
}

async function clueBatch(words, tier) {
  const prompt =
    `Write one crossword clue for each word. Style: ${tier.brief}.\n` +
    `Rules: at most 7 words per clue; never use the answer or any word sharing its root; ` +
    `no enumerations like "(5)"; no proper nouns unless the answer is one.\n` +
    `Words: ${words.join(", ")}\n\n` +
    `Reply with JSON only, no prose or code fences: an object mapping each uppercase word to its clue. ` +
    `Escape any double quotes inside a clue.`;
  // The model occasionally emits malformed JSON (an unescaped quote in a
  // clue). One fresh attempt rescues the batch far more often than not.
  try {
    return parseJson(await callClaude(prompt));
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    return parseJson(await callClaude(prompt));
  }
}

// Blind-solve check: hand the clue back with only the letter count and see if
// the model recovers the answer. Catches clues that are technically correct but
// fit fifty other words, which is what actually kills you under a clock.
async function verifyBatch(pairs) {
  const list = pairs.map(([w, c], i) => `${i + 1}. (${w.length} letters) ${c}`).join("\n");
  const text = await callClaude(
    `Solve these crossword clues. Answer with your single best guess for each, uppercase letters only.\n` +
      `${list}\n\nReply with JSON only: an object mapping the item number to your answer.`
  );
  const got = parseJson(text);
  return pairs.map(([w], i) => String(got[i + 1] || "").toUpperCase().trim() === w);
}

async function pool(items, worker, concurrency, label) {
  let next = 0, done = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (next < items.length) {
      const i = next++;
      try { await worker(items[i], i); } catch (e) { console.warn(`  ${label} chunk ${i} failed: ${e.message}`); }
      if (++done % 10 === 0) console.log(`  ${label} ${done}/${items.length}`);
    }
  });
  await Promise.all(runners);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function generateClues(words) {
  // cache shape: { clues: {WORD: [c0, c1, c2]},        null = attempted and rejected
  //                attempted: {WORD: [bool x3]},        which tiers have been asked for
  //                verified: {WORD: [bool|null x3]} }   blind-solve outcome per tier
  let cache = { clues: {}, attempted: {}, verified: {} };
  if (RESUME && fs.existsSync(CACHE)) {
    cache = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    console.log(`resume: ${Object.keys(cache.clues).length} words already in ${CACHE}`);
  }
  const checkpoint = () => fs.writeFileSync(CACHE, JSON.stringify(cache));

  const clues = {};
  words.forEach((w) => (clues[w] = cache.clues[w] ? cache.clues[w].slice() : [null, null, null]));
  const rejected = { sanity: 0, verify: 0 };

  for (let ti = 0; ti < TIERS.length; ti++) {
    const tier = TIERS[ti];
    // a cached null means the clue was rejected last time; do not pay for it again
    const todo = words.filter((w) => !(cache.attempted[w] && cache.attempted[w][ti]));
    console.log(`clues: ${tier.name} tier over ${todo.length} words` + (todo.length < words.length ? " (rest cached)" : ""));
    await pool(
      chunk(todo, BATCH),
      async (batch) => {
        const map = await clueBatch(batch, tier);
        batch.forEach((w) => {
          const c = map[w] || map[w.toLowerCase()];
          if (clueIsSane(c, w)) clues[w][ti] = c.trim();
          else rejected.sanity++;
          cache.clues[w] = clues[w];
          (cache.attempted[w] ||= [false, false, false])[ti] = true;
        });
      },
      CONCURRENCY,
      tier.name
    );
    checkpoint();
  }

  if (VERIFY) {
    const pairs = [];
    for (const w of words)
      clues[w].forEach((c, ti) => {
        if (!c) return;
        const v = cache.verified[w] && cache.verified[w][ti];
        if (v === true) return;                                   // passed last time
        if (v === false) { clues[w][ti] = null; rejected.verify++; return; } // failed last time
        pairs.push([w, c, ti]);
      });
    console.log(`verify: blind-solving ${pairs.length} clues`);
    await pool(
      chunk(pairs, 20),
      async (batch) => {
        const ok = await verifyBatch(batch);
        batch.forEach(([w, , at], i) => {
          (cache.verified[w] ||= [null, null, null])[at] = ok[i];
          if (!ok[i]) { clues[w][at] = null; rejected.verify++; }
        });
      },
      CONCURRENCY,
      "verify"
    );
    checkpoint();
  }

  // collapse: drop nulls, keep tier order, fall back to the nearest kept tier
  let noClue = 0;
  for (const w of words) {
    const tiers = clues[w];
    if (!tiers.some(Boolean)) { delete clues[w]; noClue++; continue; }
    clues[w] = tiers.map((c, i) => {
      if (c) return c;
      for (let d = 1; d < tiers.length; d++) {
        if (tiers[i - d]) return tiers[i - d];
        if (tiers[i + d]) return tiers[i + d];
      }
    });
  }
  console.log(
    `clues: rejected ${rejected.sanity} on sanity, ${rejected.verify} on blind-solve; ` +
      `${noClue} words left unclued`
  );
  return clues;
}

/* ------------------------------------------------------------------ */
/* main                                                                 */
/* ------------------------------------------------------------------ */

let puzzles;
if (RESUME && fs.existsSync(GRIDS)) {
  puzzles = JSON.parse(fs.readFileSync(GRIDS, "utf8"));
  console.log(`resume: ${puzzles.length} grids from ${GRIDS}`);
} else {
  puzzles = generateGrids(COUNT);
  if (!DRY) fs.writeFileSync(GRIDS, JSON.stringify(puzzles));
}

const used = [...new Set(puzzles.flatMap((p) => p.words))].sort();
console.log(`vocabulary in play: ${used.length} words`);

const clues = DRY ? {} : await generateClues(used);

// A puzzle is only shippable if every one of its answers has a clue.
const shippable = DRY ? puzzles : puzzles.filter((p) => p.words.every((w) => clues[w]));
console.log(`puzzles: ${shippable.length}/${puzzles.length} fully clued`);

const byBucket = [0, 0, 0];
const scoreDifficulty = bucketer(shippable);
const out = {
  version: 1,
  generated: new Date().toISOString(),
  lexicon: LEX,
  templates: TEMPLATES,
  tiers: TIERS.map((t) => t.name),
  puzzles: shippable.map((p) => {
    const d = scoreDifficulty(p);
    byBucket[d]++;
    return { t: p.t, w: p.w, d };
  }),
  clues,
};

fs.writeFileSync(OUT, JSON.stringify(out));
const mb = (fs.statSync(OUT).size / 1e6).toFixed(2);
console.log(`\nwrote ${OUT} — ${mb} MB`);
console.log(`difficulty buckets: easy ${byBucket[0]}, medium ${byBucket[1]}, hard ${byBucket[2]}`);
if (DRY) console.log("(--dry: no clues generated, bundle is grids only)");

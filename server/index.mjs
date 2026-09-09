// CrossRun global leaderboard. One best score per player (device) per mode.
//
//   npm install && DATABASE_URL=postgres://... node index.mjs
//
// Deploy on Railway: new project from this folder, add the Postgres plugin,
// and Railway sets DATABASE_URL and PORT for you. Without DATABASE_URL it
// keeps scores in memory, which is fine for a local try but forgets on restart.
//
// Endpoints
//   POST /v1/scores  {name, device, mode, points, level}  -> {rank, total}
//   GET  /v1/top?mode=words|cards&limit=25&device=...       -> {top:[...], you:{rank,points,level}|null, total}
//   GET  /health
import http from "http";

const PORT = process.env.PORT || 8790;
const MODES = new Set(["words", "cards"]);
const MAX_POINTS = { words: 200000, cards: 500000 };
const NAME_RE = /^[A-Za-z0-9 _.-]{3,14}$/;
const BAD = ["fuck", "shit", "cunt", "nigg", "fag", "bitch"];

// ── storage ──
let store;
if (process.env.DATABASE_URL) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "0" ? false : { rejectUnauthorized: false } });
  await pool.query(`CREATE TABLE IF NOT EXISTS scores (
    device text NOT NULL, mode text NOT NULL, name text NOT NULL,
    points integer NOT NULL, level integer NOT NULL, updated timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (device, mode))`);
  await pool.query(`CREATE INDEX IF NOT EXISTS scores_mode_points ON scores (mode, points DESC)`);
  store = {
    async upsert(s) {
      await pool.query(
        `INSERT INTO scores (device, mode, name, points, level) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (device, mode) DO UPDATE SET name = EXCLUDED.name,
           points = GREATEST(scores.points, EXCLUDED.points),
           level = CASE WHEN EXCLUDED.points > scores.points THEN EXCLUDED.level ELSE scores.level END,
           updated = now()`,
        [s.device, s.mode, s.name, s.points, s.level]
      );
    },
    async top(mode, limit) {
      const r = await pool.query(`SELECT name, points, level, device FROM scores WHERE mode = $1 ORDER BY points DESC, level DESC, updated ASC LIMIT $2`, [mode, limit]);
      return r.rows;
    },
    async rank(mode, device) {
      const me = await pool.query(`SELECT points, level FROM scores WHERE mode = $1 AND device = $2`, [mode, device]);
      if (!me.rows.length) return null;
      const above = await pool.query(`SELECT count(*)::int AS n FROM scores WHERE mode = $1 AND points > $2`, [mode, me.rows[0].points]);
      return { rank: above.rows[0].n + 1, points: me.rows[0].points, level: me.rows[0].level };
    },
    async total(mode) { const r = await pool.query(`SELECT count(*)::int AS n FROM scores WHERE mode = $1`, [mode]); return r.rows[0].n; },
  };
  console.log("leaderboard: postgres");
} else {
  const mem = new Map(); // key device|mode
  const list = (mode) => [...mem.values()].filter((s) => s.mode === mode).sort((a, b) => b.points - a.points || b.level - a.level);
  store = {
    async upsert(s) {
      const k = s.device + "|" + s.mode, prev = mem.get(k);
      if (!prev || s.points > prev.points) mem.set(k, { ...s, updated: Date.now() });
      else mem.set(k, { ...prev, name: s.name });
    },
    async top(mode, limit) { return list(mode).slice(0, limit); },
    async rank(mode, device) { const l = list(mode); const i = l.findIndex((s) => s.device === device); return i === -1 ? null : { rank: i + 1, points: l[i].points, level: l[i].level }; },
    async total(mode) { return list(mode).length; },
  };
  console.log("leaderboard: in-memory (set DATABASE_URL for persistence)");
}

// ── tiny rate limit per address ──
const hits = new Map();
const limited = (ip) => {
  const now = Date.now(), arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 60;
};

const send = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (limited(String(ip))) return send(res, 429, { error: "slow down" });

    if (req.method === "POST" && url.pathname === "/v1/scores") {
      const chunks = []; for await (const c of req) chunks.push(c);
      let b; try { b = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch (e) { return send(res, 400, { error: "bad json" }); }
      const name = String(b.name || "").trim(), device = String(b.device || "").slice(0, 40), mode = String(b.mode || "");
      const points = Math.floor(Number(b.points)), level = Math.floor(Number(b.level));
      if (!NAME_RE.test(name) || BAD.some((w) => name.toLowerCase().includes(w))) return send(res, 400, { error: "bad name" });
      if (!device || !MODES.has(mode)) return send(res, 400, { error: "bad request" });
      if (!(points >= 0 && points <= MAX_POINTS[mode]) || !(level >= 0 && level <= 10000)) return send(res, 400, { error: "bad score" });
      await store.upsert({ name, device, mode, points, level });
      const you = await store.rank(mode, device), total = await store.total(mode);
      return send(res, 200, { rank: you ? you.rank : null, total });
    }

    if (req.method === "GET" && url.pathname === "/v1/top") {
      const mode = url.searchParams.get("mode") || "words";
      if (!MODES.has(mode)) return send(res, 400, { error: "bad mode" });
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 25)));
      const device = url.searchParams.get("device") || "";
      const top = (await store.top(mode, limit)).map((r) => ({ name: r.name, points: r.points, level: r.level, device: r.device === device ? device : undefined }));
      const you = device ? await store.rank(mode, device) : null;
      return send(res, 200, { top, you, total: await store.total(mode) });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: "server error" });
  }
}).listen(PORT, () => console.log(`CrossRun leaderboard on :${PORT}`));

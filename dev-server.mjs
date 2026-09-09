#!/usr/bin/env node
/**
 * Local dev harness for crossrun.jsx.
 *
 *   ANTHROPIC_API_KEY=sk-... node dev-server.mjs        # then open http://localhost:8787
 *
 * crossrun.jsx is written for the claude.ai artifact sandbox, which provides
 * two things a plain browser does not: a keyless proxy to the Anthropic API and
 * a `window.storage` key/value store. This server stands in for both:
 *   - serves the component, transpiled in-browser by Babel standalone
 *   - proxies POST /api/messages to api.anthropic.com, adding the key from env
 *   - shims window.storage over localStorage
 *   - serves assets/ (the wood UI kit pieces the game references)
 *   - serves bundle.json (from generate-puzzles.mjs) if present, so the game
 *     uses pre-verified clues instead of generating them live
 * Without ANTHROPIC_API_KEY the game still runs, using the built-in fallback clues.
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const KEY = process.env.ANTHROPIC_API_KEY;

if (!KEY) console.warn("ANTHROPIC_API_KEY not set: clues will come from the built-in fallback list.");

const page = () => {
  // Strip the module import/export so the file can run as an inline script.
  const strip = (src) => src.replace(/^import .*$/gm, "").replace(/^export default function /m, "function ").replace(/^export (const|function) /gm, "$1 ");
  const jsx = [ "sfx.js", "cardrun.jsx", "crossrun.jsx" ].map((n) => strip(fs.readFileSync(path.join(HERE, n), "utf8"))).join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CrossRun dev</title>
<style>html,body,#root{margin:0;min-height:100%;background:#0E1330}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.development.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.development.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.26.4/babel.min.js"></script>
<div id="root"></div>
<script>
  // artifact sandbox shims
  window.CROSSRUN_LIVE_CLUES = true; // this page has a key-holding proxy
  window.CROSSRUN_API = "http://localhost:8790"; // local leaderboard server, if running
  // dev helpers: ?autostart jumps into a run, ?debug lists elements wider than the viewport
  if (location.search.includes("autostart=cards")) window.CROSSRUN_AUTOSTART = "cards";
  else if (location.search.includes("autostart")) window.CROSSRUN_AUTOSTART = true;
  if (location.search.includes("debug")) setTimeout(() => {
    const vw = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
    const bad = [...document.querySelectorAll("body *")].map((el) => [el, el.getBoundingClientRect()])
      .filter(([, r]) => r.right > vw + 1 || r.left < -1).slice(0, 12)
      .map(([el, r]) => el.tagName.toLowerCase() + "." + [...el.classList].join(".") + " L" + Math.round(r.left) + " R" + Math.round(r.right));
    const d = document.createElement("pre");
    d.style.cssText = "position:fixed;left:0;top:0;z-index:9999;background:#000;color:#0f0;font:11px monospace;padding:6px;max-width:100%;white-space:pre-wrap";
    d.textContent = "vw " + vw + " scrollW " + sw + " innerW " + innerWidth + "\n" + (bad.join("\n") || "no overflow");
    document.body.appendChild(d);
  }, 3000);
  window.storage = {
    get: async (k) => { const v = localStorage.getItem(k); return v == null ? null : { value: v }; },
    set: async (k, v) => { localStorage.setItem(k, String(v)); },
  };
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, opts) =>
    realFetch(String(url).startsWith("https://api.anthropic.com/v1/messages") ? "/api/messages" : url, opts);
</script>
<script type="text/babel" data-presets="react">
  const { useState, useEffect, useRef, useCallback } = React;
${jsx}
  ReactDOM.createRoot(document.getElementById("root")).render(<CrossRun />);
</script>`;
};

async function proxy(req, res) {
  if (!KEY) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "ANTHROPIC_API_KEY not set on dev server" } }));
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: Buffer.concat(chunks),
  });
  res.writeHead(upstream.status, { "content-type": "application/json" });
  res.end(await upstream.text());
}

http
  .createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/messages") return await proxy(req, res);
      if (req.url.startsWith("/assets/")) {
        const p = path.join(HERE, decodeURIComponent(req.url.split("?")[0]));
        if (!p.startsWith(path.join(HERE, "assets")) || !fs.existsSync(p)) { res.writeHead(404); return res.end("not found"); }
        const type = { ".png": "image/png", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".webp": "image/webp" }[path.extname(p)] || "application/octet-stream";
        res.writeHead(200, { "content-type": type, "cache-control": "max-age=3600" });
        return fs.createReadStream(p).pipe(res);
      }
      if (req.url === "/bundle.json") {
        const p = path.join(HERE, "bundle.json");
        if (!fs.existsSync(p)) { res.writeHead(404); return res.end("no bundle.json; run generate-puzzles.mjs"); }
        res.writeHead(200, { "content-type": "application/json" });
        return fs.createReadStream(p).pipe(res);
      }
      const route = req.url.split("?")[0];
      if (route === "/" || route === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(page());
      }
      res.writeHead(404); res.end("not found");
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: e.message } }));
    }
  })
  .on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use, so a dev server is probably running already.`);
      console.error(`Open http://localhost:${PORT} in your browser, or stop the other one with: pkill -f dev-server.mjs`);
      process.exit(1);
    }
    throw e;
  })
  .listen(PORT, () => console.log(`CrossRun dev server: http://localhost:${PORT}`));

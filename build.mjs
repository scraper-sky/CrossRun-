#!/usr/bin/env node
// Static production build: bundles the app into www/ for Capacitor.
//   node build.mjs          # www/app.js + assets + bundle.json
import { build } from "esbuild";
import fs from "fs";
import path from "path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const WWW = path.join(HERE, "www");

await build({
  entryPoints: [path.join(HERE, "src/main.jsx")],
  bundle: true,
  minify: true,
  sourcemap: false,
  target: ["ios15", "safari15"],
  format: "iife",
  loader: { ".jsx": "jsx", ".js": "jsx" },
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.CROSSRUN_AUTOSTART": JSON.stringify(process.env.CROSSRUN_AUTOSTART || ""),
    "process.env.CROSSRUN_FORCE_DAY": JSON.stringify(process.env.CROSSRUN_FORCE_DAY || ""),
  },
  outfile: path.join(WWW, "app.js"),
  logLevel: "warning",
});

fs.rmSync(path.join(WWW, "assets"), { recursive: true, force: true });
fs.cpSync(path.join(HERE, "assets"), path.join(WWW, "assets"), { recursive: true });
if (fs.existsSync(path.join(HERE, "bundle.json"))) fs.copyFileSync(path.join(HERE, "bundle.json"), path.join(WWW, "bundle.json"));
else console.warn("no bundle.json: the app will run on fallback clues only");

const size = (p) => (fs.statSync(p).size / 1e6).toFixed(2) + " MB";
console.log(`built www/app.js (${size(path.join(WWW, "app.js"))}), assets, bundle.json`);

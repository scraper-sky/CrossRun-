#!/usr/bin/env node
// Pulls the game, its bundle and its art from the project root into this
// Expo app. Run before every build so the wrapper ships the current game.
import fs from "fs";
import path from "path";
const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
fs.copyFileSync(path.join(ROOT, "crossrun.jsx"), path.join(HERE, "src/crossrun.jsx"));
fs.copyFileSync(path.join(ROOT, "cardrun.jsx"), path.join(HERE, "src/cardrun.jsx"));
fs.copyFileSync(path.join(ROOT, "sfx.js"), path.join(HERE, "src/sfx.js"));
fs.copyFileSync(path.join(ROOT, "bundle.json"), path.join(HERE, "src/bundle.json"));
fs.rmSync(path.join(HERE, "public/assets/wood"), { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "assets/wood"), path.join(HERE, "public/assets/wood"), { recursive: true });
const n = fs.readdirSync(path.join(HERE, "public/assets/wood")).length;
console.log(`synced crossrun.jsx, bundle.json and ${n} art files into expo-app`);

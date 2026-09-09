// App entry for the packaged (Capacitor) build and the static web build.
// The game component is written against two sandbox globals from claude.ai:
// `window.storage` and a keyless Anthropic proxy. Here storage is backed by
// Capacitor Preferences (localStorage on plain web), and there is no proxy,
// so the game runs entirely off bundle.json.
import React from "react";
import { createRoot } from "react-dom/client";
import { Preferences } from "@capacitor/preferences";
import CrossRun from "../crossrun.jsx";

window.storage = {
  get: async (key) => {
    const { value } = await Preferences.get({ key });
    return value == null ? null : { value };
  },
  set: async (key, value) => Preferences.set({ key, value: String(value) }),
};

if (process.env.CROSSRUN_AUTOSTART) window.CROSSRUN_AUTOSTART = process.env.CROSSRUN_AUTOSTART;
if (process.env.CROSSRUN_FORCE_DAY) window.CROSSRUN_FORCE_DAY = true;

createRoot(document.getElementById("root")).render(<CrossRun />);

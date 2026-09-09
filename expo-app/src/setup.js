// Runs inside the web view before the game module is evaluated: tells the
// game where its art lives and hands it the puzzle bundle directly.
import bundle from "./bundle.json";
window.CROSSRUN_ASSET_BASE = process.env.EXPO_BASE_URL || "/";
// Global leaderboard server, if one is configured at build time (EXPO_PUBLIC_CROSSRUN_API).
if (process.env.EXPO_PUBLIC_CROSSRUN_API) window.CROSSRUN_API = process.env.EXPO_PUBLIC_CROSSRUN_API.replace(/\/$/, "");
window.CROSSRUN_BUNDLE = bundle;
// Screenshot-only flags, inlined at build time; unset in normal builds.
if (process.env.EXPO_PUBLIC_CROSSRUN_AUTOSTART) window.CROSSRUN_AUTOSTART = process.env.EXPO_PUBLIC_CROSSRUN_AUTOSTART; // "1" or "cards"
if (process.env.EXPO_PUBLIC_CROSSRUN_FORCE_DAY) window.CROSSRUN_FORCE_DAY = true;
if (process.env.EXPO_PUBLIC_CROSSRUN_SCROLL) window.CROSSRUN_SCROLL = Number(process.env.EXPO_PUBLIC_CROSSRUN_SCROLL);
if (process.env.EXPO_PUBLIC_CROSSRUN_DEBUG) setTimeout(() => {
  const vw = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
  const bad = [...document.querySelectorAll("body *")].map((el) => [el, el.getBoundingClientRect()])
    .filter(([, r]) => r.right > vw + 1 || r.left < -1).slice(0, 12)
    .map(([el, r]) => el.tagName.toLowerCase() + "." + [...el.classList].join(".") + " L" + Math.round(r.left) + " R" + Math.round(r.right));
  const d = document.createElement("pre");
  d.style.cssText = "position:fixed;left:0;top:0;z-index:9999;background:#000;color:#0f0;font:11px monospace;padding:6px;max-width:100%;white-space:pre-wrap";
  d.textContent = "vw " + vw + " scrollW " + sw + " innerW " + innerWidth + " scale " + (visualViewport ? visualViewport.scale.toFixed(2) : "?") + "\n" + (bad.join("\n") || "no overflow");
  document.body.appendChild(d);
}, 4000);

// Diagnostics overlay: boot time, game mounts, current screen, last error.
if (process.env.EXPO_PUBLIC_CROSSRUN_DEBUG) {
  window.__boot = new Date().toLocaleTimeString();
  window.__mounts = 0; window.__screen = "?"; window.__err = "";
  window.addEventListener("error", (e) => { window.__err += "\nerror: " + (e.message || e); });
  document.addEventListener("click", (e) => { const t = e.target; window.__err += `\n${new Date().toLocaleTimeString()} click trusted=${e.isTrusted} ${t.tagName}.${t.className} "${(t.textContent || "").slice(0, 18)}"`; }, true);
  document.addEventListener("keydown", (e) => { window.__err += `\n${new Date().toLocaleTimeString()} key ${e.key} trusted=${e.isTrusted}`; }, true);
  window.addEventListener("unhandledrejection", (e) => { window.__err = "rejection: " + (e.reason && (e.reason.message || e.reason)); });
  const d = document.createElement("pre");
  d.style.cssText = "position:fixed;left:0;bottom:0;z-index:99999;background:#000;color:#0f0;font:10px monospace;padding:6px;margin:0;max-width:100%;max-height:45%;overflow:hidden;white-space:pre-wrap;pointer-events:none";
  document.body.appendChild(d);
  setInterval(() => { const tail = window.__err.split("\n").slice(-9).join("\n"); d.textContent = `boot ${window.__boot} now ${new Date().toLocaleTimeString()} mounts ${window.__mounts} screen ${window.__screen} active ${document.activeElement && document.activeElement.tagName}\n${tail}`; }, 5000);
}

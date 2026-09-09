/* ---------------- sound effects ----------------
 * Everything is synthesized with the Web Audio API, so there are no audio
 * files to ship. iOS only lets audio start from a user gesture, so `unlock`
 * is called from the first tap; until then `play` is a no-op.
 */
let ctx = null;
let enabled = true;
let unlocked = false;

export function setSoundEnabled(on) { enabled = !!on; }
export function soundEnabled() { return enabled; }

export function unlockSound() {
  try {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state !== "running") ctx.resume();
    if (!unlocked) {
      // a silent blip inside the gesture is what actually opens the gate on iOS
      const o = ctx.createOscillator(), g = ctx.createGain();
      g.gain.value = 0.0001; o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.02);
      unlocked = true;
    }
  } catch (e) {}
}

function tone({ freq = 440, type = "sine", dur = 0.12, gain = 0.18, at = 0, slide = 0, decay = true }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  if (decay) g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g); g.connect(ctx.destination);
  o.start(t0); o.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.08, gain = 0.12, at = 0, hp = 1200 }) {
  if (!ctx) return;
  const t0 = ctx.currentTime + at;
  const n = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = ctx.createBufferSource(); src.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = hp;
  const g = ctx.createGain(); g.gain.value = gain;
  src.connect(f); f.connect(g); g.connect(ctx.destination);
  src.start(t0);
}

const SOUNDS = {
  // crossword
  key: () => tone({ freq: 520, type: "triangle", dur: 0.05, gain: 0.08 }),
  word: () => { tone({ freq: 660, type: "triangle", dur: 0.1, gain: 0.14 }); tone({ freq: 990, type: "triangle", dur: 0.14, gain: 0.12, at: 0.07 }); },
  streak: (n = 2) => { for (let i = 0; i < Math.min(n, 5); i++) tone({ freq: 660 * Math.pow(1.19, i), type: "triangle", dur: 0.09, gain: 0.12, at: i * 0.06 }); },
  cleared: () => { [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, type: "triangle", dur: 0.22, gain: 0.14, at: i * 0.09 })); },
  skip: () => tone({ freq: 300, type: "sawtooth", dur: 0.12, gain: 0.06, slide: -120 }),
  reveal: () => tone({ freq: 880, type: "sine", dur: 0.18, gain: 0.1, slide: 300 }),
  over: () => { tone({ freq: 330, type: "sawtooth", dur: 0.35, gain: 0.1, slide: -200 }); tone({ freq: 220, type: "sawtooth", dur: 0.5, gain: 0.08, at: 0.25, slide: -120 }); },
  tick: () => tone({ freq: 1200, type: "square", dur: 0.03, gain: 0.03 }),
  // cards
  // phone speakers lose everything under ~250 Hz, so the thud is a click plus a mid tone
  drop: () => { noise({ dur: 0.05, gain: 0.16, hp: 1400 }); tone({ freq: 330, type: "triangle", dur: 0.08, gain: 0.18, slide: -120 }); },
  rotate: () => tone({ freq: 740, type: "triangle", dur: 0.05, gain: 0.12 }),
  match: (chain = 1) => { const b = 587 * Math.pow(1.25, Math.min(chain - 1, 4)); [0, 1, 2].forEach((i) => tone({ freq: b * Math.pow(1.2, i), type: "triangle", dur: 0.12, gain: 0.13, at: i * 0.05 })); },
  hand: (rank = 1) => { const n = 3 + Math.min(rank, 5); for (let i = 0; i < n; i++) tone({ freq: 440 * Math.pow(1.122, i), type: "triangle", dur: 0.16, gain: 0.13, at: i * 0.055 }); },
  dead: () => tone({ freq: 260, type: "square", dur: 0.22, gain: 0.1, slide: -90 }),
  hold: () => tone({ freq: 520, type: "triangle", dur: 0.08, gain: 0.14, slide: 160 }),
  // ui
  tap: () => tone({ freq: 600, type: "sine", dur: 0.04, gain: 0.05 }),
  coin: () => { tone({ freq: 1320, type: "square", dur: 0.06, gain: 0.05 }); tone({ freq: 1760, type: "square", dur: 0.1, gain: 0.05, at: 0.06 }); },
};

/* ---------------- music ----------------
 * Two CC0 loops (see assets/music/CREDITS.txt): a soft ambient pad for the
 * home and game-over screens, a gentle synth loop while playing. They run
 * through the same audio context as the effects, looped sample-accurately
 * with a short crossfade when the screen changes. */
let musicOn = true;
let musicBase = "";
let musicWanted = null;          // "ambient" | "calm" | null
let musicPlaying = null;         // { name, src, gain }
const musicBuffers = {};
const TRACKS = { ambient: "assets/music/ambient.m4a", calm: "assets/music/calm.mp3" };
const VOLUME = { ambient: 0.4, calm: 0.3 };

export function setMusicBase(base) { musicBase = base || ""; }
export function setMusicEnabled(on) {
  musicOn = !!on;
  if (!musicOn) fadeOutMusic();
  else startMusic();
}
export function wantMusic(track) { musicWanted = track; startMusic(); }

function fadeOutMusic() {
  if (!musicPlaying || !ctx) return;
  const { src, gain } = musicPlaying;
  musicPlaying = null;
  try {
    gain.gain.cancelScheduledValues(ctx.currentTime);
    gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.0001, ctx.currentTime + 0.7);
    src.stop(ctx.currentTime + 0.75);
  } catch (e) {}
}

async function loadTrack(name) {
  if (musicBuffers[name]) return musicBuffers[name];
  const res = await fetch(musicBase + TRACKS[name]);
  const data = await res.arrayBuffer();
  const buf = await new Promise((ok, bad) => { const p = ctx.decodeAudioData(data, ok, bad); if (p && p.then) p.then(ok, bad); });
  musicBuffers[name] = buf;
  return buf;
}

// Safe to call often: from screen changes and from every user gesture, so a
// track requested before audio was unlocked starts on the next tap.
export async function startMusic() {
  if (!musicOn || !musicWanted || !ctx || !unlocked) return;
  const name = musicWanted;
  if (musicPlaying && musicPlaying.name === name) return;
  try {
    const buf = await loadTrack(name);
    if (musicWanted !== name || !musicOn) return;             // the screen moved on while loading
    if (musicPlaying && musicPlaying.name === name) return;
    fadeOutMusic();
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(VOLUME[name], ctx.currentTime + 1.2);
    src.connect(gain); gain.connect(ctx.destination); src.start();
    musicPlaying = { name, src, gain };
  } catch (e) {}
}
export function stopMusic() { musicWanted = null; fadeOutMusic(); }

export function play(name, arg) {
  if (!enabled || !unlocked || !ctx) return;
  // iOS can leave the context "interrupted" or "suspended" after a call, the
  // keyboard, or the app going to the background; nudge it back every time
  try { if (ctx.state !== "running") ctx.resume(); } catch (e) {}
  try { const f = SOUNDS[name]; if (f) f(arg); } catch (e) {}
}

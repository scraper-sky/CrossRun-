import React, { useState, useEffect, useRef, useCallback } from "react";
import { play } from "./sfx.js";

/* ---------------- Card Run ----------------
 * Cards fall in pairs from a real 52-card deck into a five-wide well. Tap a
 * column to drop the pair there, tap Rotate to turn it. Three ways to clear:
 *   - a set: three or more of the same rank touching in a line
 *   - a run: three or more of one suit in rank order, touching in a line
 *   - a poker row: a full row of five that makes pair or better
 * Cleared cards vanish, the cards above fall, and anything that forms as
 * they land chains for more. A full row that is only high card, with no set
 * or run in it, turns to dead weight until three of a kind or better clears
 * right on top of it; a lone pair only takes its own row. No clock: the pace
 * rises as you score, and the run ends when the well overflows.
 */

export const COLS = 5;
export const ROWS = 7;
const NEXT_COUNT = 3;
const CLEARS_PER_LEVEL = 8;
const ROW_MIN_RANK = 1; // a full row clears on a pair or better

export const HANDS = [
  { name: "High card", points: 0 },
  { name: "Pair", points: 40 },
  { name: "Two pair", points: 80 },
  { name: "Three of a kind", points: 120 },
  { name: "Straight", points: 250 },
  { name: "Flush", points: 300 },
  { name: "Full house", points: 400 },
  { name: "Four of a kind", points: 700 },
  { name: "Straight flush", points: 1500 },
];
const SET_POINTS = { 3: 30, 4: 100 };
const RUN_POINTS = { 3: 40, 4: 120, 5: 500 };

const SUITS = ["♠", "♥", "♦", "♣"];
const RANK_LABEL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
export const rankLabel = (r) => RANK_LABEL[r] || String(r);
export const isRed = (s) => s === 1 || s === 2;

let nextId = 1;
export function freshDeck() {
  const d = [];
  for (let s = 0; s < 4; s++) for (let r = 2; r <= 14; r++) d.push({ id: nextId++, r, s });
  return shuffle(d);
}
export function shuffle(a) {
  const d = a.slice();
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// Rank a five-card hand. Aces play high and low in straights.
export function evalHand(cards) {
  const ranks = cards.map((c) => c.r).sort((a, b) => a - b);
  const counts = {};
  ranks.forEach((r) => (counts[r] = (counts[r] || 0) + 1));
  const groups = Object.values(counts).sort((a, b) => b - a);
  const flush = cards.every((c) => c.s === cards[0].s);
  const uniq = [...new Set(ranks)];
  let straight = false;
  if (uniq.length === 5) straight = ranks[4] - ranks[0] === 4 || (ranks[0] === 2 && ranks[3] === 5 && ranks[4] === 14);
  if (straight && flush) return 8;
  if (groups[0] === 4) return 7;
  if (groups[0] === 3 && groups[1] === 2) return 6;
  if (flush) return 5;
  if (straight) return 4;
  if (groups[0] === 3) return 3;
  if (groups[0] === 2 && groups[1] === 2) return 2;
  if (groups[0] === 2) return 1;
  return 0;
}

// Is this line of cards a run: one suit, ranks stepping by one in either
// direction? An ace may sit at either end (A-2-3 or Q-K-A).
export function isRun(cards) {
  if (cards.length < 3 || !cards.every((c) => c.s === cards[0].s)) return false;
  const options = cards.map((c) => (c.r === 14 ? [1, 14] : [c.r]));
  const walk = (i, prev, dir) => {
    if (i === cards.length) return true;
    return options[i].some((v) => {
      if (i === 0) return walk(1, v, 0);
      const d = v - prev;
      if (Math.abs(d) !== 1) return false;
      if (dir && d !== dir) return false;
      return walk(i + 1, v, d);
    });
  };
  return walk(0, null, 0);
}

// Every line (row or column) of 3+ that is a set or a run. Sets are maximal
// same-rank stretches; runs are the longest windows that qualify.
export function findLines(g, deadRows) {
  const out = [];
  const lines = [];
  for (let r = 0; r < ROWS; r++) lines.push(Array.from({ length: COLS }, (_, c) => [r, c]));
  for (let c = 0; c < COLS; c++) lines.push(Array.from({ length: ROWS }, (_, r) => [r, c]));
  for (const line of lines) {
    let seg = [];
    const flush = () => {
      if (seg.length >= 3) {
        let i = 0;
        while (i < seg.length) {
          let j = i;
          while (j + 1 < seg.length && g[seg[j + 1][0]][seg[j + 1][1]].r === g[seg[i][0]][seg[i][1]].r) j++;
          if (j - i + 1 >= 3) out.push({ kind: "set", cells: seg.slice(i, j + 1) });
          i = j + 1;
        }
        for (let len = Math.min(5, seg.length); len >= 3; len--) {
          for (let s = 0; s + len <= seg.length; s++) {
            const cells = seg.slice(s, s + len);
            if (isRun(cells.map(([r, c]) => g[r][c]))) {
              const covered = out.some((o) => o.kind === "run" && cells.every((cell) => o.cells.some((oc) => oc[0] === cell[0] && oc[1] === cell[1])));
              if (!covered) out.push({ kind: "run", cells });
            }
          }
        }
      }
      seg = [];
    };
    for (const [r, c] of line) { if (g[r][c] && !deadRows[r]) seg.push([r, c]); else flush(); }
    flush();
  }
  return out;
}

const tickFor = (level) => Math.max(300, 760 - 60 * (level - 1));
const emptyGrid = () => Array.from({ length: ROWS }, () => Array(COLS).fill(null));

const C = (r, s) => ({ id: "ex" + r + s, r, s });
const RULES = [
  { t: "Cards fall in pairs", d: "Tap a column to drop them there. Tap Rotate to turn the pair.", ex: [C(12, 0), C(4, 1)], stack: true },
  { t: "Three of a kind clears", d: "Same rank, touching in a line, across or down.", ex: [C(7, 0), C(7, 1), C(7, 2)] },
  { t: "A run clears", d: "Three or more of one suit in order.", ex: [C(5, 3), C(6, 3), C(7, 3)] },
  { t: "Fill a row: a pair clears it", d: "Any full row of five with a pair or better clears. Better hands pay more. A row with no pair goes dead until three of a kind or better clears right on top of it.", ex: [C(13, 0), C(13, 1), C(3, 2), C(9, 3), C(11, 1)], note: "the pair of kings clears this row" },
  { t: "Chains pay double", d: "Cards drop after a clear. Anything that forms as they land counts again, for more." },
];

export default function CardRun({ level, active, onClear, onDead, onLevelUp, onOver, onInput, onDeal, autoDeal, T }) {
  const [phase, setPhase] = useState(autoDeal ? "play" : "intro");
  const [grid, setGrid] = useState(emptyGrid);
  const [deck, setDeck] = useState(freshDeck);
  const [discard, setDiscard] = useState([]);
  const [queue, setQueue] = useState([]);     // upcoming pairs, each [a, b]
  const [hold, setHold] = useState(null);
  const [holdUsed, setHoldUsed] = useState(false);
  const [piece, setPiece] = useState(null);   // { a, b, col, row, orient: "v" | "h" }
  const [dead, setDead] = useState(() => Array(ROWS).fill(false));
  const [clearing, setClearing] = useState(new Set());
  const [landed, setLanded] = useState(new Set());   // ids that just settled, for the thud
  const [note, setNote] = useState(null);
  const clears = useRef(0);
  const busy = useRef(false);
  const over = useRef(false);

  const drawInto = useCallback((n, deckNow, discardNow, queueNow) => {
    let d = deckNow.slice(), disc = discardNow.slice(), q = queueNow.slice();
    while (q.length < n) {
      if (d.length < 2) { d = d.concat(shuffle(disc)); disc = []; }
      if (d.length < 2) break;
      q.push([d.shift(), d.shift()]);
    }
    return { d, disc, q };
  }, []);

  useEffect(() => {
    const { d, disc, q } = drawInto(NEXT_COUNT + 1, deck, discard, queue);
    setDeck(d); setDiscard(disc); setQueue(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cellsOf = (p) => (p.orient === "v" ? [[p.row, p.col], [p.row + 1, p.col]] : [[p.row, p.col], [p.row, p.col + 1]]);
  const free = (g, r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS && !g[r][c];
  const fits = (g, p) => cellsOf(p).every(([r, c]) => free(g, r, c));

  const spawn = (q, g) => {
    if (!q.length) return null;
    const [a, b] = q[0];
    for (const col of [2, 1, 3, 0, 4]) { const p = { a, b, col, row: 0, orient: "v" }; if (fits(g, p)) return p; }
    return null;
  };

  useEffect(() => {
    if (phase !== "play" || piece || !queue.length || busy.current || over.current) return;
    const p = spawn(queue, grid);
    if (!p) { over.current = true; onOver(); return; }
    setPiece(p);
    setHoldUsed(false);
  }, [phase, queue, piece, grid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase !== "play" || !active || !piece || busy.current) return;
    const id = setInterval(() => {
      const p = piece;
      if (!p || busy.current) return;
      const down = { ...p, row: p.row + 1 };
      if (fits(grid, down)) setPiece(down);
      else { setPiece(null); land(p); }
    }, tickFor(level));
    return () => clearInterval(id);
  }, [phase, active, piece, level, grid]); // eslint-disable-line react-hooks/exhaustive-deps

  const lowestEmpty = (g, col) => { let r = -1; for (let i = 0; i < ROWS; i++) if (!g[i][col]) r = i; else break; return r; };

  const land = (p) => {
    if (busy.current) return;
    busy.current = true;
    play("drop");
    const g = grid.map((row) => row.slice());
    const order = p.orient === "v" ? [[p.b, p.col], [p.a, p.col]] : [[p.a, p.col], [p.b, p.col + 1]];
    for (const [card, col] of order) { const r = lowestEmpty(g, col); if (r >= 0) g[r][col] = card; }
    setLanded(new Set([p.a.id, p.b.id]));
    setTimeout(() => setLanded(new Set()), 320);
    const { d, disc, q } = drawInto(NEXT_COUNT + 1, deck, discard, queue.slice(1));
    setDeck(d); setDiscard(disc); setQueue(q);
    resolve(g, dead.slice(), 1);
  };

  const resolve = (g, deadRows, chain) => {
    const lines = findLines(g, deadRows);
    const lineCells = new Set(lines.flatMap((l) => l.cells.map(([r, c]) => r + "," + c)));
    const pokerRows = [];
    let newlyDead = false;
    for (let r = 0; r < ROWS; r++) {
      if (deadRows[r] || !g[r].every(Boolean)) continue;
      if (g[r].some((_, c) => lineCells.has(r + "," + c))) continue;
      const rank = evalHand(g[r]);
      if (rank >= ROW_MIN_RANK) pokerRows.push({ kind: "hand", rank, cells: g[r].map((_, c) => [r, c]), row: r });
      else { deadRows[r] = true; newlyDead = true; }
    }
    const all = [...lines, ...pokerRows];
    if (!all.length) {
      if (newlyDead) { onDead(); play("dead"); }
      setGrid(g); setDead(deadRows); busy.current = false;
      return;
    }
    const toClear = new Set(all.flatMap((l) => l.cells.map(([r, c]) => r + "," + c)));
    // a lone pair only clears its own row; three of a kind or better (sets, runs, strong hands) also frees a dead row beneath
    const sweepers = all.filter((l) => l.kind !== "hand" || l.rank >= 3);
    const rowsTouched = new Set(sweepers.flatMap((l) => l.cells.map(([r]) => r)));
    let swept = 0;
    for (let r = 0; r < ROWS - 1; r++) if (rowsTouched.has(r) && deadRows[r + 1]) { deadRows[r + 1] = false; swept++; for (let c = 0; c < COLS; c++) toClear.add(r + 1 + "," + c); }

    let points = 0, best = null;
    for (const l of all) {
      let pts, label;
      if (l.kind === "set") { pts = SET_POINTS[Math.min(4, l.cells.length)]; label = `${l.cells.length} of a kind`; }
      else if (l.kind === "run") { pts = RUN_POINTS[Math.min(5, l.cells.length)]; label = `Run of ${l.cells.length}`; }
      else { pts = HANDS[l.rank].points; label = HANDS[l.rank].name; }
      points += pts;
      if (!best || pts > best.pts) best = { pts, label, rank: l.kind === "hand" ? l.rank : 0 };
    }
    const ids = new Set([...toClear].map((k) => { const [r, c] = k.split(",").map(Number); return g[r][c].id; }));
    setGrid(g); setDead(deadRows); setClearing(ids);
    setNote({ title: (chain > 1 ? `Chain x${chain}! ` : "") + best.label + "!", sub: `+${points * chain} pts` + (all.length > 1 ? ` · ${all.length} clears` : "") + (swept ? " · dead row freed" : "") });
    if (best.rank >= 1) play("hand", best.rank); else play("match", chain);
    clears.current += all.length;
    onClear({ points: points * chain, label: best.label, chain, count: all.length, rank: best.rank });
    if (Math.floor(clears.current / CLEARS_PER_LEVEL) > Math.floor((clears.current - all.length) / CLEARS_PER_LEVEL)) onLevelUp();

    setTimeout(() => {
      const g2 = g.map((row) => row.slice());
      const removed = [];
      toClear.forEach((k) => { const [r, c] = k.split(",").map(Number); removed.push(g2[r][c]); g2[r][c] = null; });
      for (let c = 0; c < COLS; c++) {
        const stack = [];
        for (let r = ROWS - 1; r >= 0; r--) if (g2[r][c]) stack.push(g2[r][c]);
        for (let r = ROWS - 1; r >= 0; r--) g2[r][c] = stack[ROWS - 1 - r] || null;
      }
      const deadIds = new Set();
      deadRows.forEach((isDead, r) => { if (isDead) g[r].forEach((card) => card && deadIds.add(card.id)); });
      const dead2 = g2.map((row) => row.every((card) => card && deadIds.has(card.id)));
      setDiscard((disc) => [...disc, ...removed]);
      setClearing(new Set());
      setNote(null);
      resolve(g2, dead2, chain + 1);
    }, 560);
  };

  const tapColumn = (col) => {
    if (phase !== "play" || !active || !piece || busy.current || over.current) return;
    onInput();
    const width = piece.orient === "h" ? 2 : 1;
    const p = { ...piece, col: Math.min(col, COLS - width) };
    if (!fits(grid, p)) return;
    let q = p;
    while (fits(grid, { ...q, row: q.row + 1 })) q = { ...q, row: q.row + 1 };
    setPiece(null);
    land(q);
  };
  const rotate = () => {
    if (phase !== "play" || !active || !piece || busy.current) return;
    onInput();
    let p = piece.orient === "v" ? { ...piece, orient: "h" } : { ...piece, orient: "v" };
    if (p.orient === "h" && p.col > COLS - 2) p = { ...p, col: COLS - 2 };
    if (!fits(grid, p) && p.orient === "h") p = { ...p, col: Math.max(0, p.col - 1) };
    if (!fits(grid, p)) return;
    play("rotate");
    setPiece(p);
  };
  const swapHold = () => {
    if (phase !== "play" || !active || !piece || holdUsed || busy.current) return;
    onInput();
    play("hold");
    const incoming = hold;
    setHold([piece.a, piece.b]);
    setHoldUsed(true);
    if (incoming) setPiece({ ...piece, a: incoming[0], b: incoming[1], row: 0, orient: "v" });
    else { setQueue((q) => q.slice(1)); setPiece(null); }
  };
  const deal = () => { onDeal(); setPhase("play"); };

  useEffect(() => {
    const onKey = (e) => {
      if (phase !== "play" || !piece) return;
      if (e.key === "ArrowLeft") { const p = { ...piece, col: piece.col - 1 }; if (fits(grid, p)) setPiece(p); onInput(); }
      else if (e.key === "ArrowRight") { const p = { ...piece, col: piece.col + 1 }; if (fits(grid, p)) setPiece(p); onInput(); }
      else if (e.key === "ArrowUp" || e.key === "r") rotate();
      else if (e.key === "ArrowDown" || e.key === " ") { tapColumn(piece.col); e.preventDefault(); }
      else if (e.key === "h" || e.key === "H") swapHold();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const Card = ({ card, small }) => (
    <div className={"pcard" + (isRed(card.s) ? " red" : "") + (small ? " small" : "") + (clearing.has(card.id) ? " clear" : "") + (landed.has(card.id) ? " landed" : "")}>
      <b>{rankLabel(card.r)}</b>
      <span>{SUITS[card.s]}</span>
    </div>
  );

  if (phase === "intro") {
    return (
      <div className="cardrun">
        <div className="col card tall rules">
          <h2>How to play</h2>
          {RULES.map((r) => (
            <div key={r.t} className="rule">
              <div className="rt">{r.t}</div>
              <div className="rd">{r.d}</div>
              {r.ex ? (
                <div className={"ex" + (r.stack ? " stack" : "")}>
                  {r.ex.map((c) => <Card key={c.id} card={c} small />)}
                  {r.note ? <span className="exn">{r.note}</span> : null}
                </div>
              ) : null}
            </div>
          ))}
          <div className="rd" style={{ marginTop: 8 }}>No clock in this mode. The pace rises as you score, and the run ends when the well overflows.</div>
        </div>
        <button className="big full" style={{ marginTop: 12 }} onClick={deal}>Deal</button>
      </div>
    );
  }

  const next = queue.slice(1, 1 + NEXT_COUNT);
  const aimCols = piece ? (piece.orient === "h" ? [piece.col, piece.col + 1] : [piece.col]) : [];

  return (
    <div className="cardrun">
      <div className="col tray tray-row">
        <div className="slot" onClick={swapHold}>
          <div className="lab">hold</div>
          {hold ? <div className="row">{hold.map((c) => <Card key={c.id} card={c} small />)}</div> : <div className="pcard small empty">↔</div>}
        </div>
        <div className="slot next">
          <div className="lab">next · {deck.length} in deck</div>
          <div className="row">{next.map((pair) => <div key={pair[0].id} className="pair-mini">{pair.map((c) => <Card key={c.id} card={c} small />)}</div>)}</div>
        </div>
        <button className="ghost outline c-light rotate" onClick={rotate}>Rotate</button>
      </div>

      <div className="well" style={{ gridTemplateColumns: `repeat(${COLS}, var(--cw))` }}>
        {note ? <div className="note big-note"><div className="t">{note.title}</div><div className="s">{note.sub}</div></div> : null}
        {piece ? cellsOf(piece).map(([r, c], i) => (
          <div key={i} className="falling" style={{ left: `calc(${c} * var(--cw))`, top: `calc(${r} * var(--ch))` }} onClick={(e) => { e.stopPropagation(); rotate(); }}>
            <Card card={i === 0 ? piece.a : piece.b} />
          </div>
        )) : null}
        {grid.map((row, r) =>
          row.map((card, c) => (
            <div key={r + "," + c} className={"wcell" + (dead[r] ? " dead" : "") + (aimCols.includes(c) ? " aim" : "")} onClick={() => tapColumn(c)}>
              {card ? <Card card={card} /> : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export const cardCss = (T, SERIF) => `
  .cr .cardrun { width:100%; max-width:430px; display:flex; flex-direction:column; align-items:center; gap:8px; --cw:60px; --ch:74px; }
  .cr .rules { padding-bottom:58px; }
  .cr .rules h2 { margin:0 0 10px; font-size:24px; font-weight:700; }
  .cr .rules .rule { padding:8px 0; border-top:1px solid ${T.paperBorder}; }
  .cr .rules .rt { font-family:${SERIF}; font-size:17px; font-weight:700; }
  .cr .rules .rd { font-size:13px; color:${T.muted}; line-height:1.4; margin-top:2px; }
  .cr .rules .ex { display:flex; align-items:center; gap:5px; margin-top:8px; }
  .cr .rules .ex.stack { flex-direction:column; align-items:flex-start; gap:2px; }
  .cr .rules .ex .pcard.small { width:28px; height:38px; }
  .cr .rules .exn { margin-left:8px; font-size:12px; color:${T.muted}; font-style:italic; }
  .cr .tray-row { display:flex; gap:8px; align-items:stretch; padding:12px 14px 14px; }
  .cr .slot { background:rgba(0,0,0,.25); border-radius:8px; padding:6px 8px 8px; box-shadow: inset 0 2px 4px rgba(0,0,0,.45); }
  .cr .slot .lab { color:${T.dim}; margin:0 0 4px; }
  .cr .slot.next { flex:1; }
  .cr .slot .row { display:flex; gap:6px; }
  .cr .pair-mini { display:flex; flex-direction:column; gap:2px; }
  .cr .tray-row .rotate { align-self:center; padding:12px 12px; font-size:14px; }
  .cr .well { position:relative; display:grid; gap:0; padding:10px; background:rgba(0,0,0,.28); border-radius:12px; box-shadow: inset 0 3px 8px rgba(0,0,0,.5); }
  .cr .wcell { width:var(--cw); height:var(--ch); display:flex; align-items:center; justify-content:center; border-bottom:1px dashed rgba(255,255,255,.08); }
  .cr .wcell.aim { background:rgba(255,255,255,.06); }
  .cr .wcell.dead .pcard { filter:grayscale(.9) brightness(.7); }
  .cr .falling { position:absolute; margin:10px; width:var(--cw); height:var(--ch); display:flex; align-items:center; justify-content:center;
                 transition: top .12s linear, left .1s ease-out; z-index:2; }
  .cr .pcard { width:calc(var(--cw) - 6px); height:calc(var(--ch) - 6px); border-radius:6px; background:#FBF6EA; color:#1E1A17;
               box-shadow: 0 0 0 2px #3A2415, 0 2px 0 rgba(0,0,0,.35); position:relative; font-family:${SERIF}; user-select:none; }
  .cr .pcard.red { color:#B0362E; }
  .cr .pcard b { position:absolute; top:3px; left:6px; font-size:17px; font-weight:700; }
  .cr .pcard span { position:absolute; right:5px; bottom:2px; font-size:26px; line-height:1; }
  .cr .pcard.small { width:30px; height:40px; }
  .cr .pcard.small b { font-size:11px; top:1px; left:3px; }
  .cr .pcard.small span { font-size:14px; right:3px; bottom:1px; }
  .cr .pcard.empty { display:flex; align-items:center; justify-content:center; color:${T.dim}; background:rgba(255,255,255,.08); box-shadow:none; font-size:18px; width:34px; height:52px; }
  .cr .pcard.clear { animation: cardpop .55s ease-out forwards; }
  .cr .pcard.landed { animation: thud .3s cubic-bezier(.2,.8,.2,1); }
  @keyframes thud { 0%{transform:translateY(-6px) scaleY(1.06)} 55%{transform:translateY(1px) scaleY(.94)} 100%{transform:none} }
  @keyframes cardpop { 0%{transform:scale(1)} 40%{transform:scale(1.12); box-shadow:0 0 0 3px ${T.accent}, 0 0 18px ${T.accent}} 100%{transform:scale(.2); opacity:0} }
  @media (max-width:400px){ .cr .cardrun { --cw:56px; --ch:70px; } }
`;

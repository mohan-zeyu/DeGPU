// Tiny deterministic motion engine: every frame is a pure function of time t.
// Scenes register with scene({dur, chapter, build(root, cue)}); build() makes the
// DOM once and returns update(localT). seek(T) positions everything for global T.

const D = window.DATA;
const W = 1920, H = 1080;
const X = 0.8; // crossfade between scenes (s)
const RENDER = new URLSearchParams(location.search).has("render");

const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, p) => a + (b - a) * p;
const E = {
  lin: (p) => p,
  out: (p) => 1 - (1 - p) ** 3,
  outQuint: (p) => 1 - (1 - p) ** 5,
  inOut: (p) => (p < 0.5 ? 4 * p ** 3 : 1 - (-2 * p + 2) ** 3 / 2),
  inOutSine: (p) => -(Math.cos(Math.PI * p) - 1) / 2,
  outBack: (p) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2; },
};
const P = (t, t0, d = 0.6, e = E.out) => e(clamp((t - t0) / d));

function h(html) {
  const tpl = document.createElement("template");
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}
function add(parent, html, style) {
  const el = h(html);
  if (style) Object.assign(el.style, style);
  parent.appendChild(el);
  return el;
}
function set(el, o, x = 0, y = 0, s = 1, blur = 0) {
  el.style.opacity = o;
  el.style.visibility = o <= 0.002 ? "hidden" : "visible";
  el.style.transform = `translate(${x}px,${y}px) scale(${s})`;
  el.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
}
// Fade-up entrance at t0, optional exit at t1.
function show(el, t, t0, t1 = Infinity, { d = 0.7, dy = 18, dx = 0, blur = 6, dout = 0.45, s0 = 1, e = E.out } = {}) {
  const pin = P(t, t0, d, e), pout = P(t, t1, dout, E.inOut);
  const o = pin * (1 - pout);
  set(el, o, (1 - pin) * dx, (1 - pin) * dy - pout * 10, lerp(s0, 1, pin), (1 - pin) * blur + pout * 4);
  return o;
}
function pop(el, t, t0, t1 = Infinity, d = 0.55) {
  const pin = P(t, t0, d, E.outBack), pout = P(t, t1, 0.4, E.inOut);
  set(el, clamp(P(t, t0, d * 0.6)) * (1 - pout), 0, 0, lerp(0.6, 1, pin) * lerp(1, 0.94, pout));
}

// A value that moves between keyframes: track(v0).to(t0, v, d).at(t)
function track(v0) {
  const ks = [];
  let sorted = true;
  return {
    to(t0, v, d = 0.9, e = E.inOut) { ks.push({ t0, v, d, e }); sorted = false; return this; },
    at(t) {
      if (!sorted) { ks.sort((a, b) => a.t0 - b.t0); sorted = true; }
      let v = v0;
      for (const k of ks) {
        if (t < k.t0) break;
        const p = k.e(clamp((t - k.t0) / k.d));
        v = v + (k.v - v) * p;
        if (p < 1) break;
      }
      return v;
    },
  };
}
// A discrete value: steps(v0).set(t0, v).at(t) -> {v, since}
function steps(v0) {
  const ks = [];
  return {
    set(t0, v) { ks.push([t0, v]); ks.sort((a, b) => a[0] - b[0]); return this; },
    at(t) {
      let cur = [-1e9, v0];
      for (const k of ks) if (t >= k[0]) cur = k;
      return { v: cur[1], since: t - cur[0] };
    },
  };
}
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const fmtEth = (v, digits = 3) => (v > 0.00049 ? "+" : v < -0.00049 ? "−" : "") + Math.abs(v).toFixed(digits);

// ---------------------------------------------------------------- icons
const I = (d, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
const IC = {
  chip: I('<rect x="6" y="6" width="12" height="12" rx="2.2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2.8v3.2M12 2.8v3.2M15 2.8v3.2M9 18v3.2M12 18v3.2M15 18v3.2M2.8 9h3.2M2.8 12h3.2M2.8 15h3.2M18 9h3.2M18 12h3.2M18 15h3.2"/>'),
  cube: I('<path d="M12 2.5l8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3L12 2.5z"/><path d="M12 21.5V12M20.5 7.3L12 12 3.5 7.3"/>'),
  shield: I('<path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>'),
  lock: I('<rect x="5" y="11" width="14" height="10" rx="2.2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/>'),
  unlock: I('<rect x="5" y="11" width="14" height="10" rx="2.2"/><path d="M8 11V7.5a4 4 0 0 1 7.6-1.8"/>'),
  laptop: I('<rect x="4" y="5" width="16" height="11" rx="1.6"/><path d="M2 19.5h20"/>'),
  db: I('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>'),
  team: I('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2c3 .2 5.5 2.6 5.5 5.8"/>'),
  clock: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  eye: I('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  check: I('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: I('<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>'),
  alert: I('<path d="M12 3.5l9.5 16.5h-19L12 3.5z"/><path d="M12 10v4.5M12 17.2v.3"/>'),
  term: I('<rect x="3" y="4" width="18" height="16" rx="2.2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5"/>'),
  dice: I('<rect x="4" y="4" width="16" height="16" rx="3.5"/><circle cx="9" cy="9" r="1.1" fill="currentColor"/><circle cx="15" cy="15" r="1.1" fill="currentColor"/><circle cx="15" cy="9" r="1.1" fill="currentColor"/><circle cx="9" cy="15" r="1.1" fill="currentColor"/>'),
  coins: I('<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v4c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 10v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4M5 14v4c0 1.7 3.1 3 7 3s7-1.3 7-3v-4"/>'),
  photo: I('<rect x="3" y="5" width="18" height="14" rx="2.2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/>'),
  moon: I('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>'),
  key: I('<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3M14 9l2 2"/>'),
  hash: I('<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>'),
  book: I('<path d="M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2V5z"/><path d="M4 20a2 2 0 0 1 2-2h13v3H6"/>'),
  ff: I('<path d="M3.5 6.5l7.5 5.5-7.5 5.5v-11zM12.5 6.5l7.5 5.5-7.5 5.5v-11z" fill="currentColor"/>'),
  scale: I('<path d="M12 4v16M6 20h12M5 7h14M7 7l-3 6.5a3 3 0 0 0 6 0L7 7zM17 7l-3 6.5a3 3 0 0 0 6 0L17 7z"/>'),
  layers: I('<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>'),
  flask: I('<path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 0 0 1.3 2h12.4a1.5 1.5 0 0 0 1.3-2L14 9V3"/><path d="M7 15h10"/>'),
  globe: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z"/>'),
  play: I('<path d="M7 5l12 7-12 7V5z" fill="currentColor"/>'),
};
const ic = (name, size, color) => `<span class="ic" style="width:${size}px;height:${size}px${color ? ";color:" + color : ""}">${IC[name]}</span>`;

function logoSVG(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 100 100" fill="none">
    <defs><linearGradient id="lg${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5eead4"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>
    <rect x="22" y="22" width="56" height="56" rx="12" stroke="url(#lg${size})" stroke-width="5"/>
    <g stroke="url(#lg${size})" stroke-width="5" stroke-linecap="round">
      <path d="M38 8v10M50 8v10M62 8v10M38 82v10M50 82v10M62 82v10M8 38h10M8 50h10M8 62h10M82 38h10M82 50h10M82 62h10"/>
    </g>
    <g fill="url(#lg${size})"><circle cx="40" cy="42" r="5"/><circle cx="60" cy="42" r="5"/><circle cx="50" cy="60" r="5"/></g>
    <path d="M40 42L60 42L50 60Z" stroke="url(#lg${size})" stroke-width="3" stroke-linejoin="round" opacity=".7"/>
  </svg>`;
}

// ---------------------------------------------------------------- scenes
const SCENES = [];
const CUES = [];
let DURATION = 0;
function scene(s) { SCENES.push(s); }

function header(root, tag, title, sub, color = "var(--client)", top = 96) {
  const a = add(root, `<div class="tag abs" style="left:120px;top:${top}px;--c:${color}"><span class="dot"></span>${tag}</div>`);
  const b = add(root, `<div class="h1 abs" style="left:118px;top:${top + 38}px">${title}</div>`);
  const c = sub ? add(root, `<div class="sub abs" style="left:121px;top:${top + 118}px">${sub}</div>`) : null;
  return (t) => { show(a, t, 0.2); show(b, t, 0.35, Infinity, { dy: 24, blur: 8 }); if (c) show(c, t, 0.6); };
}

function captions(root, list) {
  const box = add(root, `<div class="caps"></div>`);
  const els = list.map(([, , html]) => add(box, `<div class="cap"><span>${html}</span></div>`));
  return (t) => list.forEach(([a, b], i) => show(els[i], t, a, b, { d: 0.6, dy: 12, blur: 5, dout: 0.5 }));
}

// ---------------------------------------------------------------- background + chrome
const frame = document.getElementById("frame");
const bgc = document.getElementById("bgc");
const ctx = bgc.getContext("2d");
const blobA = document.getElementById("blobA"), blobB = document.getElementById("blobB"), blobC = document.getElementById("blobC");
const blackEl = document.getElementById("black");
const scenesEl = document.getElementById("scenes");
const chaptersEl = document.getElementById("chapters");
const CHAPTERS = ["Overview", "How it works", "Live demo", "Wrap-up"];

function hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function drawGrid(T, k) {
  ctx.clearRect(0, 0, W, H);
  if (k <= 0.002) return;
  const s = 40, g = 7;
  for (let r = 0; r < H / s + 1; r++) {
    for (let c = 0; c < W / s + 1; c++) {
      const x = c * s, y = r * s, cx = x + s / 2 - W / 2, cy = y + s / 2 - H / 2 + 40;
      const d = Math.hypot(cx, cy * 1.25);
      const n = hash2(c, r);
      const wave = Math.sin(d / 95 - T * 1.5 + n * 2.2) * 0.5 + 0.5;
      let a = (wave ** 7 * 0.55 * (0.3 + n) + 0.025) * clamp((d - 260) / 420) * (1 - clamp(d / 1250));
      a *= k;
      if (a < 0.006) continue;
      ctx.fillStyle = n > 0.55 ? `rgba(94,234,212,${a.toFixed(3)})` : `rgba(167,139,250,${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.roundRect(x + g / 2, y + g / 2, s - g, s - g, 5);
      ctx.fill();
    }
  }
}

function buildChapters() {
  return CHAPTERS.map((name, i) => {
    const el = add(chaptersEl, `<div class="chap"><div class="lb">${name}</div><div class="tr"><div class="fl"></div></div></div>`);
    const own = SCENES.filter((s) => s.chapter === i);
    return { el, fl: el.querySelector(".fl"), a: own[0].start + X / 2, b: own[own.length - 1].start + own[own.length - 1].dur - X / 2 };
  });
}
let CH = [];

// ---------------------------------------------------------------- narration timing
// Each scene animates on its own clock t. When a narration line (narration.js)
// needs more time than the gap to the next line, the scene pauses ("holds") at a
// moment where nothing is moving, so the voice and the picture stay in step.
// The scene's update gets (t, tau): t is the held animation clock, tau the
// scene's real elapsed time (for ambient loops that should keep running).
const NARR_GAP = 0.45, NARR_TAIL = 0.35, WORDS_PER_SEC = 2.6;
const plain = (html) => html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ");

function signature(s, t) {
  s.update(t, t);
  const out = [];
  for (const el of s.root.querySelectorAll("*")) {
    if (el.closest("[data-amb]")) continue;
    const st = el.style;
    out.push(`${st.opacity}|${st.transform}|${st.width}|${st.left}|${st.top}|${st.visibility}|${st.strokeDashoffset}` + (el.childElementCount ? "" : "|" + el.textContent));
  }
  return out;
}

// Latest time in [a, b] where the scene is at rest (nothing changes over the
// next 10 ms), or null when something is always moving.
function findRest(s, a, b) {
  const lo = a + 0.05, hi = b - 0.02;
  if (hi <= lo) return null;
  const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
  for (let t = hi; t >= lo; t -= 0.02) if (same(signature(s, t), signature(s, t + 0.01))) return +t.toFixed(3);
  return null;
}

function planNarration(s) {
  const durs = window.NARRATION_DURATIONS || {};
  s.dur0 = s.dur;
  s.lines = (window.NARRATION?.[s.id] || []).map((l, k) => {
    const say = l.say ?? plain(l.text);
    return { ...l, id: `${s.id}-${k}`, say, d: durs[`${s.id}-${k}`] ?? say.split(/\s+/).length / WORDS_PER_SEC };
  });
  // Extra time goes into a pause at a moment of rest, or, if the segment never
  // rests, into slowing the whole segment down evenly. knots map real time tau
  // to animation time t, piecewise linearly.
  const knots = [[0, 0]];
  let shift = 0;
  s.holds = [];
  s.lines.forEach((l, k) => {
    const next = s.lines[k + 1];
    const segEnd = next ? next.at : s.dur0 - X;
    const extra = l.d + (next ? NARR_GAP : NARR_TAIL) - (segEnd - l.at);
    if (extra <= 0.01) return;
    const h = l.hold ?? findRest(s, l.at, segEnd);
    if (h !== null) {
      knots.push([h + shift, h], [h + shift + extra, h]);
      s.holds.push({ kind: "hold", t: h, E: extra });
    } else {
      knots.push([l.at + shift, l.at], [segEnd + shift + extra, segEnd]);
      s.holds.push({ kind: "slow", t: l.at, until: segEnd, E: extra });
    }
    shift += extra;
  });
  knots.push([s.dur0 + shift, s.dur0]);
  s.dur = s.dur0 + shift;
  s.warp = (tau) => {
    for (let i = 1; i < knots.length; i++) {
      const [u0, t0] = knots[i - 1], [u1, t1] = knots[i];
      if (tau <= u1) return u1 > u0 ? t0 + ((tau - u0) * (t1 - t0)) / (u1 - u0) : t1;
    }
    return tau - shift;
  };
  s.unwarp = (t) => {
    for (let i = 1; i < knots.length; i++) {
      const [u0, t0] = knots[i - 1], [u1, t1] = knots[i];
      if (t1 > t0 && t <= t1) return u0 + ((t - t0) * (u1 - u0)) / (t1 - t0);
    }
    return t + shift;
  };
  s.lines.forEach((l) => (l.start = s.unwarp(l.at)));
  const shown = s.lines.filter((l) => l.cap !== false && l.text);
  s.caps = captions(s.root, shown.map((l) => {
    const next = s.lines[s.lines.indexOf(l) + 1];
    const out = Math.min(l.start + l.d + 0.4, next ? next.start - 0.3 : s.dur - X + 0.1);
    return [l.start - 0.12, out, l.text];
  }));
  s.root.lastElementChild.dataset.amb = "1";
}

function init() {
  SCENES.forEach((s) => (s.root = add(scenesEl, `<div class="scene"></div>`)));
  // build after all roots exist so layout-dependent measurements work
  const raw = [];
  SCENES.forEach((s) => {
    const upd = s.build(s.root, (type, lt) => raw.push({ s, type, lt }));
    s.update = (t, tau = t) => upd(t, tau);
    planNarration(s);
    s.root.style.display = "none";
  });
  let t = 0;
  SCENES.forEach((s, i) => {
    s.start = i === 0 ? 0 : t - X;
    t = s.start + s.dur;
    if (i > 0) CUES.push({ type: "whoosh", t: +(s.start - 0.15).toFixed(3) });
  });
  DURATION = t;
  for (const c of raw) CUES.push({ type: c.type, t: +(c.s.start + c.s.unwarp(c.lt)).toFixed(3) });
  CUES.sort((a, b) => a.t - b.t);
  CH = buildChapters();
  window.DURATION = DURATION;
  window.CUES = CUES;
  window.SCENE_TIMES = SCENES.map((s) => ({ id: s.id, chapter: s.chapter, start: +s.start.toFixed(3), dur: +s.dur.toFixed(3),
    holds: s.holds.map((x) => ({ kind: x.kind, at: +(s.start + s.unwarp(x.t)).toFixed(3), len: +x.E.toFixed(3),
      ...(x.until ? { until: +(s.start + s.unwarp(x.until)).toFixed(3) } : {}) })) }));
  window.NARRATION_LINES = SCENES.flatMap((s) => s.lines.map((l) => ({ id: l.id, say: l.say, start: +(s.start + l.start).toFixed(3), d: +l.d.toFixed(3) })));
}

function seekAll(T) {
  // background
  blobA.style.transform = `translate(${-380 + Math.sin(T / 11) * 120}px, ${-520 + Math.cos(T / 13) * 80}px)`;
  blobB.style.transform = `translate(${1060 + Math.cos(T / 12) * 140}px, ${300 + Math.sin(T / 10) * 90}px)`;
  blobC.style.transform = `translate(${420 + Math.sin(T / 17) * 200}px, ${700 + Math.cos(T / 15) * 60}px)`;
  const last = SCENES[SCENES.length - 1];
  const gk = Math.max(1 - P(T, SCENES[0].dur - 2.2, 2, E.inOutSine), P(T, last.start, 2.5, E.inOutSine));
  drawGrid(T, gk);
  // scenes
  for (const s of SCENES) {
    const lt = T - s.start;
    if (lt < -0.001 || lt > s.dur + 0.001) { s.root.style.display = "none"; continue; }
    const pin = s === SCENES[0] ? 1 : P(lt, 0, X, E.inOutSine);
    const pout = s === last ? 0 : P(lt, s.dur - X, X, E.inOutSine);
    const o = Math.min(pin, 1 - pout);
    s.root.style.display = o <= 0.002 ? "none" : "";
    s.root.style.opacity = o;
    const y = (1 - pin) * 16 - pout * 16, sc = 1 + (1 - pin) * 0.012 - pout * 0.012;
    s.root.style.transform = `translate(0,${y}px) scale(${sc})`;
    const bl = (1 - pin) * 5 + pout * 5;
    s.root.style.filter = bl > 0.05 ? `blur(${bl.toFixed(2)}px)` : "none";
    if (o > 0.002) { s.update(s.warp(lt), lt); s.caps(lt); }
  }
  // chapter progress
  let anyOn = 0;
  CH.forEach((c) => {
    c.fl.style.width = clamp((T - c.a) / (c.b - c.a)) * 100 + "%";
    const on = T >= c.a && T < c.b;
    c.el.classList.toggle("on", on);
  });
  const ca = CH[0].a, cb = CH[CH.length - 1].b;
  chaptersEl.style.opacity = P(T, ca - 0.3, 0.8) * (1 - P(T, cb - 0.6, 0.8));
  // fade from / to black
  blackEl.style.opacity = Math.max(1 - P(T, 0, 1.4, E.inOutSine), P(T, DURATION - 1.8, 1.8, E.inOutSine));
}

// ---------------------------------------------------------------- scenario stage
// Shared layout for the five demo scenarios: client + JobMarket on top,
// providers A-F below, the real on-chain timeline on the right.
const NAMES = ["A", "B", "C", "D", "E", "F"];
const PX = (i) => 120 + i * 180; // provider card left
const ANCH = {
  clientR: [472, 362], clientB: [285, 426], marketL: [698, 362], marketB: [930, 426],
  prov: (n) => [PX(NAMES.indexOf(n)) + 80, 648], provC: (n) => [PX(NAMES.indexOf(n)) + 80, 720],
};
const ROLE = {
  main: ["MAIN", "var(--main)"], v0: ["VERIFIER · 0–99", "var(--ver)"], v1: ["VERIFIER · 100–199", "var(--ver)"], tb: ["TIE-BREAKER", "var(--tb)"],
};

function timelineHTML(txt) {
  return txt
    .replace(/(slashed [\d.]+ ETH)/, '<span class="bad">$1</span>')
    .replace(/(payout [\d.]+ ETH)/, '<span class="ok">$1</span>')
    .replace(/(VERIFY|no verification)/, '<span class="ver">$1</span>')
    .replace(/(\d+ items mismatch)/, '<span class="bad">$1</span>')
    .replace(/^(job closed: \w+)/, '<span class="end">$1</span>')
    .replace(/^-- (.*) --$/, '<span class="tt">$1</span>');
}

function Stage(root, cfg) {
  const ups = [];
  const S = { ups };
  // nodes
  const client = add(root, `<div class="node card" style="left:120px;top:300px;width:352px;height:126px">
      <div class="av abs" style="left:22px;top:22px;--c:var(--client)">${ic("laptop", 28, "#0b1020")}</div>
      <div class="nm abs" style="left:90px;top:18px">Client</div>
      <div class="abs" style="left:90px;top:62px"><div class="k">wallet, net of gas</div><div class="v mono wal" style="margin-top:2px">0.000 ETH</div></div>
      <div class="pill abs sec" style="right:16px;top:20px;font-size:14px;padding:5px 11px"></div></div>`);
  const market = add(root, `<div class="node card" style="left:698px;top:300px;width:470px;height:126px">
      <div class="iconbox abs" style="left:22px;top:22px;--c:var(--chain);width:56px;height:56px;border-radius:16px">${ic("cube", 30)}</div>
      <div class="nm abs" style="left:96px;top:18px">JobMarket</div>
      <div class="abs" style="left:96px;top:62px;display:flex;gap:34px">
        <div><div class="k">escrow</div><div class="v mono esc" style="margin-top:2px">0.000</div></div>
        <div class="decw"><div class="k">decision on-chain</div><div class="v mono dec" style="margin-top:2px;color:var(--chain)">–</div></div></div>
      <div class="pill statuspill mst" style="background:rgba(167,139,250,.14);color:var(--chain)"></div></div>`);
  const wal = client.querySelector(".wal"), sec = client.querySelector(".sec");
  const esc = market.querySelector(".esc"), dec = market.querySelector(".dec"), mst = market.querySelector(".mst");
  const provs = {};
  NAMES.forEach((n, i) => {
    const el = add(root, `<div class="prov card" style="left:${PX(i)}px;top:650px">
        <div class="av">${n}</div><div class="lbl">provider</div>
        <div class="bar"><div class="fill"></div><div class="min"></div></div>
        <div class="stk mono">1.000</div><div class="st"></div></div>`);
    const rl = add(root, `<div class="role" style="left:${PX(i)}px;top:612px"><span></span></div>`);
    provs[n] = {
      el, rl, fill: el.querySelector(".fill"), stk: el.querySelector(".stk"), st: el.querySelector(".st"), av: el.querySelector(".av"),
      stake: track(cfg.stakes?.[n] ?? 1), status: steps(null), role: steps(null), dim: steps(!!cfg.dim?.[n]), shake: [], flash: [],
      tag: cfg.tags?.[n] ? add(el, `<div class="tg">${cfg.tags[n]}</div>`) : null,
    };
  });
  // timeline panel
  const tlp = add(root, `<div class="tlp card abs" style="left:1236px;top:300px;width:584px;height:546px">
      <div class="hd">${ic("cube", 22)}On-chain timeline<span class="s">JOB #${cfg.job} · REAL RUN</span></div>
      <div class="tlv"><div class="tll"></div></div></div>`);
  const tll = tlp.querySelector(".tll");
  const rows = cfg.timeline.map(([blk, txt]) => add(tll, `<div class="tlr"><span class="blk mono">#${blk}</span><span>${timelineHTML(txt)}</span></div>`));
  const rowT = rows.map(() => Infinity);
  const scroll = track(0);
  const VIEW = 546 - 67 - 14;

  const esct = track(0), walt = track(0), mstat = steps(""), secret = steps(null), decv = steps("–");
  let escV = 0, walV = 0;
  const outcomes = [];

  S.nodesIn = (t0) => (S.t0 = t0);
  S.tl = (t0, ...idx) => idx.forEach((i, k) => (rowT[i] = t0 + k * 0.28));
  S.market = (t0, v) => mstat.set(t0, v);
  S.escrow = (t0, v) => { escV = v; esct.to(t0, v, 0.8); };
  S.wallet = (t0, v) => { walV = v; walt.to(t0, v, 1.0); };
  S.status = (t0, n, html, color = "var(--muted)", prog = 0) => provs[n].status.set(t0, { html, color, prog });
  S.role = (t0, n, r) => provs[n].role.set(t0, r);
  S.dim = (t0, n, v) => provs[n].dim.set(t0, v);
  S.stake = (t0, n, v, d = 0.9) => provs[n].stake.to(t0, v, d, E.out);
  S.shake = (t0, n) => provs[n].shake.push(t0);
  S.flash = (t0, n, color) => provs[n].flash.push([t0, color]);
  S.secret = (t0, v) => secret.set(t0, v);

  S.packet = (t0, d, from, to, color, label = "", bend = 0) => {
    const el = add(root, `<div class="pk" style="--c:${color}"><div class="dotp"></div>${label ? `<div class="lab">${label}</div>` : ""}</div>`);
    const [x0, y0] = from, [x1, y1] = to;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2 + bend;
    ups.push((t) => {
      if (t < t0 - 0.05 || t > t0 + d + 0.45) { el.style.visibility = "hidden"; return; }
      const p = E.inOut(clamp((t - t0) / d));
      const x = (1 - p) ** 2 * x0 + 2 * (1 - p) * p * cx + p * p * x1;
      const y = (1 - p) ** 2 * y0 + 2 * (1 - p) * p * cy + p * p * y1;
      el.style.visibility = "visible";
      el.style.opacity = P(t, t0 - 0.05, 0.2) * (1 - P(t, t0 + d, 0.4));
      el.style.transform = `translate(${x}px,${y}px) scale(${lerp(0.6, 1, P(t, t0 - 0.05, 0.3))})`;
    });
    return el;
  };
  S.float = (t0, at, html, color, dur = 2.4) => {
    const el = add(root, `<div class="flt" style="color:${color}">${html}</div>`);
    ups.push((t) => {
      const p = clamp((t - t0) / dur);
      if (t < t0 || p >= 1) { el.style.visibility = "hidden"; return; }
      el.style.visibility = "visible";
      el.style.opacity = P(t, t0, 0.25) * (1 - P(t, t0 + dur - 0.6, 0.6));
      el.style.left = at[0] + "px";
      el.style.top = at[1] + "px";
      el.style.transform = `translate(-50%,${-E.out(p) * 46}px) scale(${lerp(0.7, 1, P(t, t0, 0.4, E.outBack))})`;
    });
  };
  S.draw = (t0, cand, picks, roles, d = 1.5) => {
    const lab = add(root, `<div class="pill abs" style="left:${ANCH.marketB[0] - 104}px;top:444px;background:rgba(251,191,36,.14);color:var(--ver)">${ic("dice", 20)} random draw</div>`);
    ups.push((t) => show(lab, t, t0 - 0.1, t0 + d + 0.9, { d: 0.4, dy: 8 }));
    picks.forEach((pk, k) => {
      const ring = add(root, `<div class="ring"></div>`);
      const land = t0 + d * (0.62 + 0.38 * k);
      const r = rng(7 + k * 31 + pk.charCodeAt(0));
      const seq = [];
      let tt = t0, step = 0.075, prev = -1;
      while (tt < land - 0.04) {
        let c;
        do c = cand[Math.floor(r() * cand.length)]; while (c === prev && cand.length > 1);
        seq.push([tt, c]); prev = c; tt += step; step *= 1.13;
      }
      seq.push([land, pk]);
      S.role(land, pk, roles[k]);
      ups.push((t) => {
        if (t < t0 || t > land + 1.4) { ring.style.visibility = "hidden"; return; }
        let cur = seq[0][1];
        for (const [ts, c] of seq) if (t >= ts) cur = c;
        const landed = t >= land;
        ring.style.visibility = "visible";
        // a faint shimmer while hopping: the draw counts as motion, so no narration pause lands mid-draw
        ring.style.opacity = landed ? 1 - P(t, land + 0.8, 0.6) : (0.8 + 0.06 * Math.sin(t * 40)).toFixed(3);
        ring.style.left = PX(NAMES.indexOf(cur)) - 6 + "px";
        ring.style.top = 644 + "px";
        ring.style.borderColor = landed ? "var(--ver)" : "rgba(255,255,255,.65)";
        ring.style.transform = `scale(${landed ? lerp(1.08, 1, P(t, land, 0.4)) : 1})`;
      });
    });
  };
  S.outcome = (t0, text, color, icon = "check") => {
    const el = add(root, `<div class="outcome" style="--c:${color}"><span>${ic(icon, 38)}${text}</span></div>`);
    outcomes.push([el, t0]);
  };
  S.extra = (fn) => ups.push(fn);

  // composite beats
  S.post = (t0, secretText, commit, idx) => {
    S.secret(t0, { text: "secret: " + secretText, open: false });
    S.wallet(t0 + 0.1, walV - 0.04);
    S.packet(t0, 0.9, ANCH.clientR, ANCH.marketL, "var(--client)", "0.040 ETH · 200 photos", 0);
    S.escrow(t0 + 0.8, escV + 0.04);
    S.market(t0 + 0.8, "OPEN");
    decv.set(t0 + 0.8, commit.slice(0, 8) + "…");
    S.tl(t0 + 0.7, idx);
  };
  S.offer = (t0, n) => {
    S.packet(t0, 0.85, ANCH.marketB, ANCH.prov(n), "var(--chain)", "job offer");
    S.role(t0 + 0.8, n, ROLE.main);
  };
  S.accept = (t0, n, idx, runDur, runText = "running 200 photos") => {
    S.tl(t0, idx);
    S.market(t0, "COMMITTING");
    S.status(t0, n, runText, "var(--main)", runDur);
  };
  S.commit = (t0, n, idx, statusText = "results committed") => {
    S.packet(t0, 0.8, ANCH.prov(n), ANCH.marketB, "var(--main)", "hash of results");
    S.status(t0 + 0.2, n, statusText, "var(--text)");
    S.tl(t0 + 0.7, idx);
    S.market(t0 + 0.7, "DECIDING");
  };
  S.reveal = (t0, yes, idx) => {
    S.packet(t0, 0.85, ANCH.clientR, ANCH.marketL, "var(--client)", "reveal: " + (yes ? "yes" : "no"));
    S.secret(t0 + 0.75, { text: "revealed: " + (yes ? "yes" : "no"), open: true, yes });
    S.tl(t0 + 0.75, idx);
    S.market(t0 + 0.75, yes ? "CHECKING" : "PUBLISHING");
  };
  S.publish = (t0, n, idx, label = "200 result leaves") => {
    S.packet(t0, 0.8, ANCH.prov(n), ANCH.marketB, "var(--main)", label);
    S.tl(t0 + 0.7, idx);
  };
  S.pay = (t0, n, amount, idx) => {
    S.packet(t0, 0.75, ANCH.marketB, ANCH.prov(n), "var(--ok)", "");
    S.escrow(t0 + 0.6, Math.max(0, escV - amount));
    S.float(t0 + 0.7, [ANCH.prov(n)[0], 596], "+" + amount.toFixed(3), "var(--ok)");
    S.status(t0 + 0.7, n, `earned +${amount.toFixed(3)}`, "var(--ok)");
    if (idx !== undefined) S.tl(t0 + 0.6, idx);
  };
  S.toClient = (t0, amount, idx) => {
    S.packet(t0, 0.85, ANCH.marketL, ANCH.clientR, "var(--ok)", "", 0);
    S.escrow(t0 + 0.7, 0);
    S.wallet(t0 + 0.8, walV + amount);
    S.float(t0 + 0.8, [585, 318], "+" + amount.toFixed(3), "var(--ok)");
    if (idx !== undefined) S.tl(t0 + 0.6, idx);
  };
  S.slash = (t0, n, amount, idx, cue) => {
    const pv = provs[n];
    S.shake(t0, n);
    S.flash(t0, n, "var(--bad)");
    S.stake(t0, n, pv.stake.at(1e9) - amount);
    S.float(t0 + 0.1, [ANCH.prov(n)[0], 596], "−" + amount.toFixed(1) + " ETH", "var(--bad)", 2.8);
    S.status(t0 + 0.1, n, `slashed −${amount.toFixed(1)}`, "var(--bad)");
    if (idx !== undefined) S.tl(t0, idx);
    cue && cue("slash", t0);
  };
  S.close = (t0, idx, text, color, icon, cue) => {
    S.tl(t0, idx);
    S.market(t0, "CLOSED");
    S.outcome(t0 + 0.3, text, color, icon);
    cue && cue("chime", t0 + 0.3);
  };

  S.finish = () => {
    // measure timeline rows for scrolling
    const order = rows.map((r, i) => [rowT[i], i]).filter(([t]) => t < Infinity).sort((a, b) => a[0] - b[0]);
    for (const [t, i] of order) {
      const bottom = rows[i].offsetTop + rows[i].offsetHeight + 12;
      scroll.to(t, Math.max(0, bottom - VIEW), 0.7, E.inOut);
    }
  };

  S.update = (t) => {
    const t0 = S.t0 ?? 0.8;
    show(client, t, t0, Infinity, { dy: 16 });
    show(market, t, t0 + 0.15, Infinity, { dy: 16 });
    show(tlp, t, t0 + 0.3, Infinity, { dy: 16, dx: 0 });
    // client
    const w = walt.at(t);
    wal.textContent = fmtEth(w) + " ETH";
    wal.style.color = w > 0.0005 ? "var(--ok)" : w < -0.0005 ? "#fda4af" : "var(--text)";
    const sc = secret.at(t);
    if (sc.v) {
      sec.style.opacity = P(sc.since, 0, 0.4);
      sec.innerHTML = ic(sc.v.open ? "unlock" : "lock", 16) + sc.v.text;
      sec.style.background = sc.v.open ? (sc.v.yes ? "rgba(251,191,36,.16)" : "rgba(148,163,184,.16)") : "rgba(255,255,255,.07)";
      sec.style.color = sc.v.open ? (sc.v.yes ? "var(--ver)" : "#cbd5e1") : "var(--muted)";
      sec.style.transform = `scale(${lerp(0.85, 1, P(sc.since, 0, 0.45, E.outBack))})`;
    } else sec.style.opacity = 0;
    // market
    esc.textContent = esct.at(t).toFixed(3);
    const dv = decv.at(t);
    dec.textContent = dv.v;
    const ms = mstat.at(t);
    mst.textContent = ms.v;
    mst.style.opacity = ms.v ? P(ms.since, 0, 0.3) : 0;
    mst.style.transform = `scale(${lerp(0.8, 1, P(ms.since, 0, 0.4, E.outBack))})`;
    // providers
    NAMES.forEach((n, i) => {
      const pv = provs[n];
      const tin = t0 + 0.35 + i * 0.07;
      const o = P(t, tin, 0.6);
      const dimv = pv.dim.at(t).v;
      let sx = 0;
      for (const s of pv.shake) if (t >= s && t < s + 0.6) sx = Math.sin((t - s) * 46) * 9 * (1 - (t - s) / 0.6);
      pv.el.style.opacity = o * (dimv ? 0.45 : 1);
      pv.el.style.transform = `translate(${sx}px,${(1 - o) * 18}px)`;
      pv.el.style.filter = dimv ? "grayscale(1)" : "none";
      const stake = pv.stake.at(t);
      pv.fill.style.width = clamp(stake) * 100 + "%";
      pv.fill.style.background = stake < 0.799 ? "var(--bad)" : "#94a3b8";
      pv.stk.textContent = stake.toFixed(3);
      pv.stk.style.color = stake < 0.799 ? "var(--bad)" : "var(--text)";
      let glow = "";
      for (const [ft, col] of pv.flash) if (t >= ft && t < ft + 1.6) glow = `0 0 0 2px ${col}, 0 0 ${50 * (1 - (t - ft) / 1.6)}px ${col}`;
      const rv = pv.role.at(t);
      const roleColor = rv.v ? rv.v[1] : null;
      pv.el.style.boxShadow = glow || (roleColor ? `0 0 0 1.5px ${roleColor}, 0 20px 50px -20px rgba(0,0,0,.6)` : "");
      pv.av.style.background = roleColor || "#cbd5e1";
      const rs = pv.rl.firstElementChild;
      if (rv.v) {
        rs.textContent = rv.v[0];
        rs.style.background = rv.v[1];
        pop(pv.rl, rv.since, 0);
      } else pv.rl.style.opacity = 0;
      const sv = pv.status.at(t);
      if (sv.v) {
        const pr = sv.v.prog ? clamp(sv.since / sv.v.prog) : 0;
        pv.st.innerHTML = `<span style="color:${sv.v.color}">${sv.v.html}</span>` + (sv.v.prog && pr < 1 ? `<div class="pb" style="color:${sv.v.color}"><i style="width:${pr * 100}%"></i></div>` : "");
        pv.st.style.opacity = P(sv.since, 0, 0.35);
      } else pv.st.style.opacity = 0;
      if (pv.tag) pv.tag.style.opacity = P(t, tin + 0.4, 0.5);
    });
    // timeline
    rows.forEach((r, i) => {
      const rt = rowT[i];
      const p = P(t, rt, 0.5);
      r.style.opacity = p;
      r.style.transform = `translateX(${(1 - p) * 22}px)`;
      const hl = t >= rt ? 1 - P(t, rt + 0.6, 1.4, E.inOutSine) : 0;
      r.style.background = hl > 0.01 ? `rgba(167,139,250,${(0.16 * hl).toFixed(3)})` : "transparent";
    });
    tll.style.transform = `translateY(${-scroll.at(t)}px)`;
    for (const [el, ot] of outcomes) pop(el, t, ot, Infinity, 0.6);
    ups.forEach((f) => f(t));
  };
  return S;
}

// mini 20x10 grid of 200 items
function miniGrid(parent, left, top, cell = 13, gap = 3) {
  const g = add(parent, `<div class="abs" style="left:${left}px;top:${top}px;display:grid;grid-template-columns:repeat(20,${cell}px);gap:${gap}px"></div>`);
  const cells = Array.from({ length: 200 }, () => add(g, `<i style="display:block;width:${cell}px;height:${cell}px;border-radius:3px;background:rgba(255,255,255,.08)"></i>`));
  return { g, cells };
}
const imgSrc = (i) => `../assets/images/${D.images[i]}`;
const className = (k) => D.classNames[k] ?? `class #${k}`;

// ---------------------------------------------------------------- boot
async function boot() {
  await document.fonts.ready;
  init();
  const imgs = [...document.images];
  await Promise.all(imgs.map((im) => (im.complete ? Promise.resolve() : new Promise((r) => { im.onload = im.onerror = r; }))).map((p) => p.then(() => {})));
  await Promise.all(imgs.map((im) => im.decode().catch(() => {})));
  window.seek = async (t) => { seekAll(t); };
  seekAll(Number(new URLSearchParams(location.search).get("t") ?? 0));
  window.READY = true;
  if (!RENDER) preview();
}
function preview() {
  let T = Number(new URLSearchParams(location.search).get("t") ?? 0), playing = true, last = performance.now();
  const hud = add(document.body, `<div style="position:fixed;left:12px;bottom:10px;font:13px system-ui;color:#fff8;z-index:9">space: play/pause · ←/→: 5 s · [ / ]: scene</div>`);
  addEventListener("keydown", (e) => {
    if (e.key === " ") playing = !playing;
    if (e.key === "ArrowRight") T += 5;
    if (e.key === "ArrowLeft") T = Math.max(0, T - 5);
    const i = SCENES.findIndex((s) => s.start + s.dur > T + 0.01);
    if (e.key === "]" && SCENES[i + 1]) T = SCENES[i + 1].start + X;
    if (e.key === "[" && i > 0) T = SCENES[i - 1].start + X;
  });
  const loop = (now) => {
    if (playing) T = Math.min(DURATION, T + (now - last) / 1000);
    last = now;
    seekAll(T);
    hud.textContent = `${T.toFixed(1)} / ${DURATION.toFixed(1)} s · space: play/pause · ←/→: 5 s · [ / ]: scene`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
window.addEventListener("error", (e) => { window.ERR = String(e.message); });

// Render index.html to an MP4, frame by frame, with headless Chrome.
//
//   node video/render.mjs [--fps 60] [--workers 5] [--threads N] [--chunk 600] [--from 0] [--to <sec>] [--out file.mp4]
//   Gentle (background priority, no idle sleep while it runs):
//     caffeinate -i taskpolicy -b nice -n 19 node video/render.mjs --workers 1 --threads 1
//   node video/render.mjs --still 42.5 --out frame.png     (one frame; --still 1,5,9 --out dir/ for several)
//   node video/render.mjs --timeline | --narration          (timing files for music.py / narrate.py)
//
// The page exposes window.DURATION and window.seek(t) (async, sets every
// animated property from t alone), so frames are exact and can be rendered in
// any order. Frames are encoded in chunks (default 600 frames) kept in
// .render/<page hash>/, so an interrupted render resumes where it stopped and
// only redoes the chunk in progress. A Chrome that stops answering (e.g. after
// the machine slept) is restarted. The chunks are concatenated and muxed with
// soundtrack.wav at the end.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const W = 1920, H = 1080;

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]?.startsWith("--") || all[i + 1] === undefined ? true : all[i + 1]]);
    return acc;
  }, []),
);
const FPS = Number(args.fps ?? 60);
const WORKERS = Number(args.workers ?? 5);
const THREADS = args.threads ? Number(args.threads) : 0; // 0 = let ffmpeg decide
const CHUNK = Number(args.chunk ?? 600);
const PAGE = pathToFileURL(resolve(HERE, args.page ?? "index.html")).href;
const OUT = resolve(args.out ?? join(HERE, "DeGPU-walkthrough.mp4"));
const AUDIO = join(HERE, "soundtrack.wav");
const CDP_TIMEOUT = 90_000;
const PAGE_FILES = ["index.html", "style.css", "data.js", "narration_durations.js", "narration.js", "engine.js", "scenes.js"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, argv, opts = {}) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "inherit", "inherit"], ...opts });
    p.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

async function launch(port) {
  const profile = mkdtempSync(join(tmpdir(), "degpu-render-"));
  const proc = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--allow-file-access-from-files", "--hide-scrollbars", "--mute-audio", "--no-first-run",
    "--force-color-profile=srgb", "--font-render-hinting=none", `--window-size=${W},${H}`,
    "--disable-extensions", "--disable-background-networking", "--renderer-process-limit=1", "about:blank",
  ], { stdio: "ignore" });
  const close = () => { try { ws?.close(); } catch {} proc.kill("SIGKILL"); setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500); };
  let ws;
  try {
    let target;
    for (let i = 0; i < 150 && !target; i++) {
      await sleep(100);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = list.find((t) => t.type === "page");
      } catch {}
    }
    if (!target) throw new Error("Chrome did not start");
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    };
    ws.onclose = () => { for (const { rej } of pending.values()) rej(new Error("Chrome connection closed")); pending.clear(); };
    // Every call times out, so a Chrome that stops answering is noticed and replaced.
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id;
      const timer = setTimeout(() => { pending.delete(i); rej(new Error(`Chrome did not answer ${method} in ${CDP_TIMEOUT / 1000} s`)); }, CDP_TIMEOUT);
      pending.set(i, { res: (v) => { clearTimeout(timer); res(v); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    const evaluate = async (expr) => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    await send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send("Page.enable");
    await send("Page.navigate", { url: PAGE + "?render=1" });
    for (let i = 0; i < 300; i++) {
      await sleep(100);
      try { if (await evaluate("window.READY === true")) break; } catch {}
    }
    if (!(await evaluate("window.READY === true"))) throw new Error("page never became ready");
    const shot = async (t) => {
      await evaluate(`seek(${t})`);
      const { data } = await send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, captureBeyondViewport: false });
      return Buffer.from(data, "base64");
    };
    return { evaluate, shot, close };
  } catch (e) {
    close();
    throw e;
  }
}

function encoder(file) {
  return spawn("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "png", "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-tune", "animation",
    "-x264-params", `keyint=${FPS * 4}` + (THREADS ? `:threads=${THREADS}` : ""), ...(THREADS ? ["-threads", String(THREADS)] : []),
    "-f", "mp4", file,
  ], { stdio: ["pipe", "inherit", "inherit"] });
}

// Encode frames [a, b) into file; written as .part and renamed only when complete.
async function renderChunk(page, a, b, file, onFrame) {
  const part = file + ".part";
  const ff = encoder(part);
  const done = new Promise((r, j) => ff.on("exit", (c) => (c === 0 ? r() : j(new Error("ffmpeg exited " + c)))));
  ff.stdin.on("error", () => {}); // a killed encoder must not crash the run; the chunk is redone
  try {
    for (let f = a; f < b; f++) {
      const png = await page.shot(f / FPS);
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      onFrame();
    }
    ff.stdin.end();
    await done;
    renameSync(part, file);
  } catch (e) {
    done.catch(() => {});
    ff.kill("SIGKILL");
    rmSync(part, { force: true });
    throw e;
  }
}

const chunkName = (a, b) => `f${String(a).padStart(7, "0")}-${String(b).padStart(7, "0")}.mp4`;
function existingChunks(dir) {
  return readdirSync(dir)
    .map((n) => n.match(/^f(\d+)-(\d+)\.mp4$/))
    .filter(Boolean)
    .map((m) => ({ a: Number(m[1]), b: Number(m[2]), file: join(dir, m[0]) }))
    .sort((x, y) => x.a - y.a);
}

async function main() {
  if (args.still !== undefined) {
    const page = await launch(9400);
    const err = await page.evaluate("window.ERR || ''");
    if (err) console.error("page error:", err);
    const times = String(args.still).split(",").map(Number);
    for (const t of times) {
      const out = times.length > 1 ? join(resolve(args.out), `t${t.toFixed(1).padStart(6, "0")}.png`) : resolve(args.out ?? "frame.png");
      writeFileSync(out, await page.shot(t));
    }
    page.close();
    return;
  }
  if (args.timeline || args.narration) {
    // --narration: the lines to synthesize (narrate.py); --timeline: scene starts,
    // holds, sound cues and voice start times (music.py)
    const page = await launch(9400);
    const err = await page.evaluate("window.ERR || ''");
    if (err) console.error("page error:", err);
    const name = args.narration ? "narration_lines.json" : "timeline.json";
    const info = await page.evaluate(args.narration
      ? "JSON.stringify(window.NARRATION_LINES.map(({id, say}) => ({id, say})), null, 1)"
      : "JSON.stringify({duration: window.DURATION, scenes: window.SCENE_TIMES, cues: window.CUES, narration: window.NARRATION_LINES}, null, 1)");
    writeFileSync(join(HERE, name), info);
    page.close();
    const parsed = JSON.parse(info);
    console.log(`wrote ${name}` + (args.narration ? ` (${parsed.length} lines)` : ` (${parsed.duration.toFixed(1)} s)`));
    return;
  }

  // Chunks are only reused for the exact same page, frame rate and size.
  const hash = createHash("sha1");
  for (const f of PAGE_FILES) if (existsSync(join(HERE, f))) hash.update(f).update(readFileSync(join(HERE, f)));
  hash.update(`${FPS}|${W}x${H}`);
  const dir = join(HERE, ".render", hash.digest("hex").slice(0, 12));
  mkdirSync(dir, { recursive: true });

  const probe = await launch(9399);
  const duration = await probe.evaluate("window.DURATION");
  probe.close();
  const from = Math.round(Number(args.from ?? 0) * FPS);
  const to = Math.round(Math.min(Number(args.to ?? duration), duration) * FPS);

  // What is still missing in [from, to), cut into chunks.
  const todo = [];
  let cur = from;
  for (const c of existingChunks(dir)) {
    if (c.b <= cur || c.a >= to) continue;
    for (let a = cur; a < Math.min(c.a, to); a += CHUNK) todo.push([a, Math.min(a + CHUNK, c.a, to)]);
    cur = Math.max(cur, c.b);
  }
  for (let a = cur; a < to; a += CHUNK) todo.push([a, Math.min(a + CHUNK, to)]);
  const total = todo.reduce((s, [a, b]) => s + b - a, 0);
  console.log(`audio: ${existsSync(AUDIO) ? AUDIO : "none"}`);
  console.log(`chunks in ${dir}`);
  console.log(`${((to - from - total) / FPS).toFixed(1)} s already rendered; rendering ${(total / FPS).toFixed(1)} s ` +
    `(${todo.length} chunks) at ${FPS} fps with ${WORKERS} worker(s)`);

  let doneFrames = 0;
  const t0 = Date.now();
  const tick = () => {
    doneFrames++;
    if (doneFrames % 60 === 0 || doneFrames === total) {
      const rate = doneFrames / ((Date.now() - t0) / 1000);
      process.stdout.write(`\r  ${doneFrames}/${total} frames  ${rate.toFixed(1)} fps  eta ${Math.round((total - doneFrames) / rate)} s   `);
    }
  };
  const queue = [...todo];
  const worker = async (w) => {
    let page = null;
    while (queue.length) {
      const [a, b] = queue.shift();
      for (let attempt = 1; ; attempt++) {
        let n = 0;
        try {
          page ??= await launch(9410 + w);
          await renderChunk(page, a, b, join(dir, chunkName(a, b)), () => { n++; tick(); });
          break;
        } catch (e) {
          console.log(`\n  chunk ${a}-${b}: ${e.message}; restarting Chrome (attempt ${attempt})`);
          page?.close();
          page = null;
          doneFrames -= n; // this chunk starts over
          if (attempt >= 8) throw e;
          await sleep(5000);
        }
      }
    }
    page?.close();
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, todo.length) }, (_, w) => worker(w)));
  if (total) console.log();

  // Assemble [from, to) from the chunks, in order.
  const parts = [];
  cur = from;
  for (const c of existingChunks(dir)) {
    if (c.a !== cur || c.b > to) continue;
    parts.push(c.file);
    cur = c.b;
  }
  if (cur !== to) throw new Error(`chunks cover frames ${from}-${cur}, need ${to}`);
  const tmp = mkdtempSync(join(tmpdir(), "degpu-concat-"));
  const list = join(tmp, "list.txt");
  writeFileSync(list, parts.map((s) => `file '${s}'`).join("\n"));
  const audio = existsSync(AUDIO) && !args.mute;
  await run("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
    ...(audio ? ["-ss", String(from / FPS), "-t", String((to - from) / FPS), "-i", AUDIO] : []),
    "-c:v", "copy", ...(audio ? ["-c:a", "aac", "-b:a", "192k", "-shortest"] : []),
    "-movflags", "+faststart", OUT,
  ]);
  rmSync(tmp, { recursive: true, force: true });
  console.log(`wrote ${OUT} from ${parts.length} chunks`);
}

main().catch((e) => { console.error(e); process.exit(1); });

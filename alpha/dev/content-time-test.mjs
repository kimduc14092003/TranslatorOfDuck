// Kiểm tra content.js theo thời gian (không cần trình duyệt): đồng hồ giả, các lượt tải chia nhau băng thông, server trả
// lời sau 3 s. Bắt các lỗi mà content-sim-test.mjs (tải xong ngay) không thấy: thứ tự tải sau khi tua, mẩu nhanh nhường
// đường truyền. Bộ mô phỏng do verifier dựng trong đợt rà soát 31/10.   Chạy: node alpha/dev/content-time-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'extension');
function makeEnv(dir, { bw = 9000, stall = () => 0, total = () => 99999999, autoReplyMs = null } = {}) {
  const env = { now: 1_000_000, perf: 0, sent: [], replies: new Map(), fetches: [], rafs: [], listeners: {}, videos: new Map(), activeId: null,
    href: 'https://www.douyin.com/', onChanged: null, timers: [], tid: 0, log: [] };
  const setTimeout_ = (fn, ms = 0) => { const id = ++env.tid; env.timers.push({ id, at: env.perf + ms, fn }); return id; };
  const clearTimeout_ = (id) => { env.timers = env.timers.filter((t) => t.id !== id); };
  const el = () => ({ style: {}, textContent: '' });
  const shadow = { '.sub': el(), '.badge': el(), '.badge .txt': el(), '.badge .dot': el() };
  const document = {
    createElement: () => ({ style: {}, attachShadow: () => ({ set innerHTML(_) {}, querySelector: (s) => shadow[s] }) }),
    addEventListener() {}, fullscreenElement: null, body: { appendChild() {} }, documentElement: {},
    querySelector: (s) => {
      if (s !== '[data-e2e="feed-active-video"]' || !env.activeId) return null;
      const id = env.activeId;
      return { getAttribute: (n) => (n === 'data-e2e-vid' ? id : null), querySelector: () => env.videos.get(id) };
    },
    querySelectorAll: () => [...env.videos.values()],
    elementFromPoint: () => null,
  };
  const active = [];
  const fakeFetch = (url, init) => new Promise((resolve, reject) => {
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); const a = +m[1], b = +m[2];
    if (init.signal.aborted) { env.fetches.push({ url, a, b, size: b - a + 1, got: 0, start: env.perf, end: env.perf, aborted: true, preAborted: true }); return reject(init.signal.reason); }
    const rec = { url, a, b, size: b - a + 1, got: 0, start: env.perf, end: null, aborted: false, done: false, waiters: [], stallUntil: env.perf + stall(a, b, env) };
    env.fetches.push(rec);
    const size = total(a, b);
    if (b === 65535) { rec.got = rec.size; rec.done = true; rec.end = env.perf; }
    else active.push(rec);
    init.signal.addEventListener('abort', () => { if (rec.done) return; rec.aborted = true; rec.end = env.perf; const i = active.indexOf(rec); if (i >= 0) active.splice(i, 1);
      reject(init.signal.reason); for (const w of rec.waiters.splice(0)) w.rej(init.signal.reason); }, { once: true });
    let delivered = 0;
    resolve({ status: 206, url: 'https://cdn.example/x.mp4', headers: { get: (h) => (h === 'content-range' ? `bytes ${a}-${b}/${size}` : null) },
      body: { getReader: () => ({ read: () => new Promise((res, rej) => {
        const check = () => {
          if (rec.aborted) return rej(new Error('aborted'));
          if (rec.got > delivered) { const n = rec.got - delivered; delivered = rec.got; return res({ done: false, value: new Uint8Array(Math.min(n, 16)) }); }
          if (rec.done) return res({ done: true });
          rec.waiters.push({ res: () => check(), rej });
        };
        check();
      }) }) } });
  });
  const step = (dt) => {
    const live = active.filter((r) => env.perf >= r.stallUntil);
    if (live.length) {
      const share = bw * dt / 1000 / live.length;
      for (const r of live) {
        r.got = Math.min(r.size, r.got + share);
        if (r.got >= r.size) { r.done = true; r.end = env.perf; active.splice(active.indexOf(r), 1); }
        for (const w of r.waiters.splice(0)) w.res();
      }
    }
  };
  const chrome = {
    runtime: { id: 'x', onMessage: { addListener() {} },
      sendMessage: (msg) => {
        env.sent.push({ at: env.now, perf: env.perf, ...msg, payload: msg.payload && { ...msg.payload, aac: undefined } });
        if (msg.type !== 'subtitles') return Promise.resolve();
        return new Promise((r) => { env.replies.set(msg.key, r); if (autoReplyMs != null) setTimeout_(() => { if (env.replies.get(msg.key) === r) { env.replies.delete(msg.key); env.log.push([env.perf, 'reply', msg.key]); r({ status: 'ok', cues: [] }); } }, autoReplyMs); });
      } },
    storage: { local: { get: (_k, cb) => cb({ settings: {} }), set() {} }, onChanged: { addListener: (f) => { env.onChanged = f; } } },
  };
  const TodMp4 = { headerEnd: () => 10, parse: () => ({ duration: 0 }),
    window: (_m, a, b) => ({ start: Math.round(a * 1000), end: Math.round(b * 1000), startTime: a, seconds: b - a, build: () => new Uint8Array(4) }) };
  const ctx = {
    window: { addEventListener: (t, f) => { env.listeners[t] = f; }, dispatchEvent() {} },
    document, chrome, TodMp4, location: { get href() { return env.href; } }, innerWidth: 1280, innerHeight: 800,
    requestAnimationFrame: (cb) => env.rafs.push(cb), performance: { now: () => env.perf }, Date: { now: () => env.now },
    fetch: fakeFetch, AbortController, AbortSignal, URL, setTimeout: setTimeout_, clearTimeout: clearTimeout_, btoa, queueMicrotask, console,
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(dir, 'cues.js'), 'utf8'), ctx);
  const src = fs.readFileSync(path.join(dir, 'content.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'globalThis.__dbg = { vids, lanes, get wanted() { return wanted; }, get playhead() { return playhead; }, timeOf: (v) => timeOf(v) };\n})();');
  vm.runInContext(src, ctx);
  env.dbg = ctx.__dbg;
  env.up = (type, data) => env.listeners.__tod_alpha_up({ detail: JSON.stringify({ type, data }) });
  env.item = (id, durMs, feed = true) => ({ id, kind: 'video', playUri: 'v0d00f' + id, durationMs: durMs, gears: [], audio: [], feed, desc: '', hashtags: [] });
  env.video = (id, t = 0) => { const v = { currentTime: t, paused: false, playbackRate: 1, readyState: 4,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 }) }; env.videos.set(id, v); return v; };
  env.flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  // advance time in 50 ms steps; playing videos advance currentTime; rAF each step
  env.tick = async (ms = 250, { onStep } = {}) => {
    const dt = 50;
    for (let t = 0; t < ms; t += dt) {
      env.now += dt; env.perf += dt;
      for (const v of env.videos.values()) if (!v.paused && !v.frozen) v.currentTime += dt / 1000 * v.playbackRate;
      step(dt);
      for (;;) { env.timers.sort((x, y) => x.at - y.at); const tm = env.timers[0]; if (!tm || tm.at > env.perf) break; env.timers.shift(); tm.fn(); }
      if (onStep) onStep();
      await env.flush(4);
      for (const cb of env.rafs.splice(0)) cb(env.perf);
      await env.flush(6);
    }
  };
  env.reply = async (key, r) => { const f = env.replies.get(key); if (!f) throw new Error('no pending ' + key); env.replies.delete(key); f(r); await env.flush(); };
  env.subs = () => env.sent.filter((m) => m.type === 'subtitles');
  env.cancels = () => env.sent.filter((m) => m.type === 'cancel').flatMap((m) => m.keys);
  env.vid = (id) => env.dbg.vids.get(id);
  env.media = () => env.fetches.filter((f) => f.b !== 65535);
  env.fmt = (f) => `[${(f.a / 1000).toFixed(1)}s..${((f.b + 1) / 1000).toFixed(1)}s] start=${f.start} end=${f.end} ${f.aborted ? 'ABORTED got=' + Math.round(f.got) + '/' + f.size : f.done ? 'done' : 'open got=' + Math.round(f.got)}`;
  return env;
}

const A = '7500000000000000004';
let n = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); n++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
};
// Tua tới SEEK trên video 600 s đang phát ở 10 s; trả về thời điểm gửi (ms sau khi tua) và thời gian không có sub.
async function seekRun({ bw = 9000, seek = 305, stall = () => 0 } = {}) {
  const e = makeEnv(EXT, { bw, autoReplyMs: 3000, stall });
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const v = e.video(A, 10);
  await e.tick(20000);
  const seekAt = e.perf, nSent = e.subs().length;
  v.currentTime = seek;
  let first = null, gap = 0; const sentAt = {};
  for (let i = 0; i < 100; i++) {
    await e.tick(250);
    for (const m of e.subs().slice(nSent)) if (!(m.key.slice(20) in sentAt)) sentAt[m.key.slice(20)] = m.perf - seekAt;
    const cv = e.vid(A), ph = e.dbg.playhead, k = cv.plan.findIndex(([a, b]) => ph >= a && ph < b);
    let ok = (cv.chunks.get(k) || {}).status === 'ok';
    for (const q of cv.quick.values()) if (ph >= q.from && ph < q.to && q.status === 'ok') ok = true;
    if (ok && first == null) first = e.perf - seekAt;
    if (!ok && first != null) gap += 250;
  }
  return { e, sentAt, first, gap };
}

await t('Tua vào 20 s đầu của đoạn [290,320): đoạn ở chỗ tua gửi trước đoạn kế, hết mẩu nhanh không mất sub', async () => {
  const r = await seekRun();
  assert.ok(r.sentAt.q305 != null && r.sentAt.q305 <= 3000, 'mẩu nhanh gửi sau ' + r.sentAt.q305 + ' ms');
  assert.ok(r.sentAt['10'] < r.sentAt['11'], 'thứ tự gửi: ' + JSON.stringify(r.sentAt));
  assert.ok(r.gap <= 1000, 'không có sub ' + r.gap + ' ms sau khi đã có sub (đảo thứ tự: ~5000 ms)');
});

await t('Mẩu nhanh bị treo (CDN không trả byte nào): đoạn ở chỗ tua không phải đợi quá 3 s', async () => {
  let stalled = false;
  const r = await seekRun({ stall: (a) => (a === 300500 && !stalled ? (stalled = true, 30000) : 0) });
  assert.ok(r.sentAt['10'] != null && r.sentAt['10'] <= 11000, 'đoạn ở chỗ tua gửi sau ' + r.sentAt['10'] + ' ms');
});

await t('Tua vào đoạn đã bắt đầu tải từ trước lần tua (dịch trước 30 s, CDN chậm): không ngắt nó', async () => {
  const e = makeEnv(EXT, { bw: 4400, autoReplyMs: 3000 });
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const v = e.video(A, 25);
  let started = null;
  for (let i = 0; i < 1200 && started == null; i++) { await e.tick(50); if (e.media().find((f) => f.a >= 40000 && f.a < 50000 && !f.aborted)) started = e.perf; }
  await e.tick(5000);
  const seekAt = e.perf, nSent = e.subs().length; v.currentTime = 55;
  for (let i = 0; i < 60; i++) await e.tick(250);
  const ch2 = e.media().filter((f) => f.a >= 40000 && f.a < 50000);
  assert.ok(ch2.every((f) => !f.aborted), 'đoạn [50,80) bị ngắt: ' + ch2.map(e.fmt).join(' | '));
  const s2 = e.subs().slice(nSent).find((m) => m.key === A + ':2');
  assert.ok(s2 && s2.perf - seekAt <= 10000, 'đoạn [50,80) gửi sau ' + (s2 && s2.perf - seekAt) + ' ms');
});

console.log(failed ? `\n${failed} kiểm tra trượt, ${n} đạt.` : `\n${n} kiểm tra đều đạt.`);
if (failed) process.exit(1);

// Kiểm tra content.js theo thời gian (không cần trình duyệt): đồng hồ giả, các lượt tải chia nhau băng thông, server trả
// lời sau 3 s. Bắt các lỗi mà content-sim-test.mjs (tải xong ngay) không thấy: thứ tự tải sau khi tua, mẩu nhanh nhường
// đường truyền. Bộ mô phỏng do verifier dựng trong đợt rà soát 31/10.   Chạy: node alpha/dev/content-time-test.mjs
// Chế độ mặc định từ 0.2.37 (dịch sẵn 10 s đầu): FIRST10=1 node alpha/dev/content-time-test.mjs. Chỉ chạy vài ca: ONLY=<regex>.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// EXT_DIR: chạy với bản sao khác của thư mục extension (bản đối chứng có chỗ sửa bị bỏ, để thấy ca trượt).
const EXT = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'extension');
// Hai chế độ: mặc định chạy cách cũ (dịch sẵn 20–30 s, đã bỏ chọn ô); FIRST10=1 chạy chế độ mặc định từ 0.2.37 (chưa lưu cài
// đặt: dịch sẵn 10 s đầu, HANDOFF §6ad, việc D2). Ca nào ghi rõ settings thì giữ đúng chế độ đó ở cả hai lượt chạy.
const FIRST10 = process.env.FIRST10 === '1';
const OLD = { first10: false, first10Set: true };
// Cài đặt này cho chế độ 10 s không (như planFor: first10: false chỉ tính khi có first10Set).
const f10Of = (s) => s.first10 !== false || !s.first10Set;
const VERSION = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
// cap(a, b, id): tốc độ tối đa (byte/s) của riêng lượt tải đó (id: video), như một máy chủ video chậm; 0: không giới hạn.
// Phần băng thông lượt bị giới hạn không dùng hết thì chia cho các lượt khác. pause(rec, env): lượt tải đang khựng (không
// nhận byte nào) ở lúc này. rtt (ms): thời gian tới byte đầu của mỗi lượt tải; qua /aweme/v1/play/ tính 2 lần (chuyển
// hướng 302 rồi mới tới máy chủ video). realProbe: lượt tải 64 KB đầu file cũng chia băng thông như mọi lượt khác (mặc định:
// xong ngay). Mục lục giả: moov dài head byte, giây t của video ở byte base + t * bps. status(a, b, url): mã HTTP.
// Mỗi byte gửi về có giá trị theo vị trí trong file, aacSum của tin gửi đi là tổng kiểm của đúng các byte âm thanh đã tải.
// settings: cài đặt đã lưu (chrome.storage). Mặc định OLD = { first10: false, first10Set: true } (đã bỏ chọn ô): các ca cũ kiểm cách
// dịch sẵn 20–30 s; FIRST10=1 thì mặc định {} (chưa lưu gì: dịch sẵn 10 s, mặc định từ 0.2.37). env.f10: env này chạy chế độ 10 s.
function makeEnv(dir, { bw = 9000, stall = () => 0, total = () => 99999999, autoReplyMs = null, cap = () => 0, pause = () => false,
  rtt = 0, realProbe = false, head = 10, base = 0, bps = 1000, status = () => 206, settings = FIRST10 ? {} : { ...OLD } } = {}) {
  const env = { now: 1_000_000, perf: 0, sent: [], replies: new Map(), fetches: [], rafs: [], listeners: {}, videos: new Map(), activeId: null,
    href: 'https://www.douyin.com/', onChanged: null, timers: [], tid: 0, log: [], f10: f10Of(settings) };
  const setTimeout_ = (fn, ms = 0) => { const id = ++env.tid; env.timers.push({ id, at: env.perf + ms, fn }); return id; };
  const clearTimeout_ = (id) => { env.timers = env.timers.filter((t) => t.id !== id); };
  const el = () => ({ style: {}, textContent: '' });
  const shadow = { '.sub': el(), '.badge': el(), '.badge .txt': el(), '.badge .dot': el(), '.info': el() };
  const document = {
    createElement: () => ({ style: {}, attachShadow: () => ({ set innerHTML(_) {}, querySelector: (s) => shadow[s] }) }),
    addEventListener() {}, fullscreenElement: null, body: { appendChild() {} }, documentElement: {},
    querySelector: (s) => {
      if (s !== '[data-e2e="feed-active-video"]' || !env.activeId) return null;
      const id = env.activeId;
      return { getAttribute: (n) => (n === 'data-e2e-vid' ? id : null), querySelector: () => env.videos.get(id),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 }) };
    },
    querySelectorAll: () => [...env.videos.values()],
    elementFromPoint: () => null,
  };
  const active = [];
  const fakeFetch = (url, init) => new Promise((resolve, reject) => {
    // "bytes=a-" (lượt tải đầu video: đọc tới chỗ cần rồi ngắt): b = null, open, tải tới hết file (total).
    const m = /bytes=(\d+)-(\d*)/.exec(init.headers.Range); const a = +m[1], b = m[2] ? +m[2] : null;
    const size = total(a, b), len = b == null ? size - a : b - a + 1;
    if (init.signal.aborted) { env.fetches.push({ url, a, b, open: b == null, size: len, got: 0, start: env.perf, end: env.perf, aborted: true, preAborted: true }); return reject(init.signal.reason); }
    const vidId = (/video_id=v0d00f(\d+)/.exec(url) || /cdn\.example\/(\d+)/.exec(url) || [])[1] || 'x';
    const rec = { url, a, b, open: b == null, size: len, got: 0, start: env.perf, end: null, aborted: false, done: false, waiters: [], stallUntil: env.perf + stall(a, b, env), cap: cap(a, b, vidId), vid: vidId };
    env.fetches.push(rec);
    const st = status(a, b, url);
    if ((b === 65535 && !realProbe) || (st !== 206 && st !== 200)) { rec.got = st === 206 || st === 200 ? rec.size : 0; rec.done = true; rec.end = env.perf; rec.status = st; }
    else active.push(rec);
    init.signal.addEventListener('abort', () => { if (rec.done) return; rec.aborted = true; rec.end = env.perf; const i = active.indexOf(rec); if (i >= 0) active.splice(i, 1);
      reject(init.signal.reason); for (const w of rec.waiters.splice(0)) w.rej(init.signal.reason); }, { once: true });
    let delivered = 0;
    resolve({ status: st, url: 'https://cdn.example/' + vidId, headers: { get: (h) => (h === 'content-range' && st === 206 ? `bytes ${a}-${b == null ? size - 1 : b}/${size}` : h === 'content-length' ? String(len) : null) },
      body: { getReader: () => ({ read: () => new Promise((res, rej) => {
        const check = () => {
          if (rec.aborted) return rej(new Error('aborted'));
          // Trả đúng số byte vừa tải (content.js đếm tiến độ theo đó: dropSlow).
          const upto = rec.done ? rec.size : Math.floor(rec.got);
          if (upto > delivered) {
            const value = new Uint8Array(upto - delivered);
            for (let i = 0; i < value.length; i++) value[i] = (a + delivered + i) % 251;
            delivered = upto; return res({ done: false, value });
          }
          if (rec.done) return res({ done: true });
          rec.waiters.push({ res: () => check(), rej });
        };
        check();
      }) }) } });
  });
  const step = (dt) => {
    const live = active.filter((r) => env.perf >= r.stallUntil && !pause(r, env));
    if (live.length) {
      const share = (typeof bw === 'function' ? bw(env.perf) : bw) * dt / 1000 / live.length;   // bw(perf): đường truyền đổi theo thời gian
      const capped = live.filter((r) => r.cap && r.cap * dt / 1000 < share);
      const rest = live.length - capped.length;
      const more = rest ? capped.reduce((x, r) => x + share - r.cap * dt / 1000, 0) / rest : 0;
      for (const r of live) {
        r.got = Math.min(r.size, r.got + (capped.includes(r) ? r.cap * dt / 1000 : share + more));
        if (r.got >= r.size) { r.done = true; r.end = env.perf; active.splice(active.indexOf(r), 1); }
        for (const w of r.waiters.splice(0)) w.res();
      }
    }
  };
  const chrome = {
    runtime: { id: 'x', onMessage: { addListener: (f) => { env.onMsg = f; } },
      sendMessage: (msg) => {
        const aac = msg.payload && msg.payload.aac ? Buffer.from(msg.payload.aac, 'base64') : null;
        env.sent.push({ at: env.now, perf: env.perf, ...msg, payload: msg.payload && { ...msg.payload, aac: undefined, aacLen: aac && aac.length, aacSum: aac && aac.reduce((x, y, i) => (x * 31 + y + i) % 1000000007, 0) } });
        if (msg.type === 'hello') return Promise.resolve({ build: VERSION, ndjson: true });
        if (msg.type !== 'subtitles') return Promise.resolve();
        return new Promise((r) => { env.replies.set(msg.key, r); if (autoReplyMs != null) setTimeout_(() => { if (env.replies.get(msg.key) === r) { env.replies.delete(msg.key); env.log.push([env.perf, 'reply', msg.key]); r({ status: 'ok', cues: [] }); } }, autoReplyMs); });
      },
      getManifest: () => ({ version: VERSION }) },
    storage: { local: { get: (_k, cb) => cb({ settings }), set() {} }, onChanged: { addListener: (f) => { env.onChanged = f; } } },
  };
  const TodMp4 = { headerEnd: () => head, parse: () => ({ duration: 0 }),
    window: (_m, a, b) => ({ start: base + Math.round(a * bps), end: base + Math.round(b * bps), startTime: a, seconds: b - a, build: (buf) => new Uint8Array(buf) }) };
  const ctx = {
    window: { addEventListener: (t, f) => { env.listeners[t] = f; }, dispatchEvent() {} },
    document, chrome, TodMp4, location: { get href() { return env.href; } }, innerWidth: 1280, innerHeight: 800,
    requestAnimationFrame: (cb) => env.rafs.push(cb), performance: { now: () => env.perf }, Date: { now: () => env.now },
    fetch: (u, i) => (!rtt ? fakeFetch(u, i) : new Promise((res, rej) => {
      const id = setTimeout_(() => { i.signal.removeEventListener('abort', ab); fakeFetch(u, i).then(res, rej); }, /aweme\/v1\/play/.test(u) ? 2 * rtt : rtt);
      const ab = () => { clearTimeout_(id); env.fetches.push({ url: u, a: 0, b: 0, size: 0, got: 0, start: env.perf, end: env.perf, aborted: true, preAborted: true }); rej(i.signal.reason); };
      i.signal.addEventListener('abort', ab, { once: true });
    })), AbortController, AbortSignal, URL, setTimeout: setTimeout_, clearTimeout: clearTimeout_, btoa, queueMicrotask, console,
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
  env.warms = () => env.sent.filter((m) => m.type === 'warm');
  env.status = () => { let r = null; env.onMsg({ type: 'status' }, {}, (x) => { r = x; }); return r; };   // như popup.js hỏi
  env.cancels = () => env.sent.filter((m) => m.type === 'cancel').flatMap((m) => m.keys);
  env.vid = (id) => env.dbg.vids.get(id);
  env.media = () => env.fetches.filter((f) => f.b !== 65535);
  env.fmt = (f) => `[${(f.a / 1000).toFixed(1)}s..${((f.b + 1) / 1000).toFixed(1)}s] start=${f.start} end=${f.end} ${f.aborted ? 'ABORTED got=' + Math.round(f.got) + '/' + f.size : f.done ? 'done' : 'open got=' + Math.round(f.got)}`;
  return env;
}

const A = '7500000000000000004';
let n = 0, failed = 0;
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const t = async (name, fn) => {
  if (ONLY && !ONLY.test(name)) return;
  try { await fn(); n++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
};
// Chế độ dịch sẵn 10 s: cài đặt chưa lưu gì (mặc định từ 0.2.37). Ca ghi rõ F10S / OLD chạy đúng chế độ đó ở cả hai lượt chạy.
const F10S = {};
const chunkAtOf = (plan, ph) => plan.findIndex(([a, b]) => ph >= a && ph < b);
// Tua tới SEEK trên video 600 s đang phát ở 10 s; trả về thời điểm gửi (ms sau khi tua) và thời gian không có sub.
// k: đoạn [290,320) chứa chỗ tua tới, theo chế độ của env (không lấy từ plan của content.js, kẻo content.js chia sai lưới vẫn đạt):
// cách cũ là đoạn 10; dịch sẵn 10 s có thêm [10,20) nên là đoạn 11 (cùng lưới 30 s từ giây 20). seek khác 305 thì tự kiểm lưới.
async function seekRun({ bw = 9000, seek = 305, stall = () => 0, settings } = {}) {
  const e = makeEnv(EXT, { bw, autoReplyMs: 3000, stall, ...(settings ? { settings } : {}) });
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
  const k = e.f10 ? 11 : 10;
  assert.equal(JSON.stringify(e.vid(A).plan[k]), '[290,320]', 'lưới: đoạn ' + k + ' của ' + JSON.stringify(e.vid(A).plan.slice(0, k + 2)));
  return { e, sentAt, first, gap, k: String(k) };
}

await t('Tua vào 20 s đầu của đoạn [290,320): đoạn ở chỗ tua gửi trước đoạn kế, hết mẩu nhanh không mất sub', async () => {
  const r = await seekRun();
  assert.ok(r.sentAt.q305 != null && r.sentAt.q305 <= 3000, 'mẩu nhanh gửi sau ' + r.sentAt.q305 + ' ms');
  assert.ok(r.sentAt[r.k] < r.sentAt[+r.k + 1], 'thứ tự gửi (đoạn ' + r.k + ' trước): ' + JSON.stringify(r.sentAt));
  assert.ok(r.gap <= 1000, 'không có sub ' + r.gap + ' ms sau khi đã có sub (đảo thứ tự: ~5000 ms)');
});

await t('Mẩu nhanh bị treo (CDN không trả byte nào): đoạn ở chỗ tua không phải đợi quá 3 s', async () => {
  let stalled = false;
  const r = await seekRun({ stall: (a) => (a === 300500 && !stalled ? (stalled = true, 30000) : 0) });
  assert.ok(r.sentAt[r.k] != null && r.sentAt[r.k] <= 11000, 'đoạn ở chỗ tua (' + r.k + ') gửi sau ' + r.sentAt[r.k] + ' ms');
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
  // Đoạn [50,80): đoạn 2 ở cách cũ, đoạn 3 ở cách dịch sẵn 10 s (cùng cửa sổ âm thanh [48,5; 86) s nên cùng khoảng byte).
  const k2 = e.f10 ? 3 : 2;
  assert.equal(JSON.stringify(e.vid(A).plan[k2]), '[50,80]', 'lưới: ' + JSON.stringify(e.vid(A).plan.slice(0, 4)));
  const s2 = e.subs().slice(nSent).find((m) => m.key === A + ':' + k2);
  assert.ok(s2 && s2.perf - seekAt <= 10000, 'đoạn [50,80) gửi sau ' + (s2 && s2.perf - seekAt) + ' ms');
});

// Bài hát 87 s mở ở trang /video/ (đo 1/11): metadata tới lúc 0,5 s, video phát từ 2,3 s; server trả mẩu nhanh sau 1,2 s
// (q0: "quá ít lời"), đoạn sau 4 s. cap: lượt tải đoạn [0,20) (byte 0–25999) qua máy chủ chậm.
// slowHead(bps, from, more): máy chủ chậm hẳn (bps byte/s) với lượt tải phần âm thanh đoạn [0,20) từ byte from (mặc định
// 12000: hết phần của mẩu q0). Cùng một kịch bản cho lượt tải riêng [0,26) s của bản 0.2.25 và lượt tải đầu video
// ("bytes=0-": mục lục, q0, đoạn 0 trên cùng một lượt, nên không thể có q0 nhanh mà đoạn 0 chậm ngay từ đầu như kịch bản
// trước của các ca này). more(rec, env): điều kiện khựng thêm (nếu có).
const slowHead = (bps, from = 12000, more = () => false) => ({
  cap: () => 0,
  pause: (rec, env) => { if (rec.a === 0 && (rec.b === 25999 || rec.open) && rec.got >= from) rec.cap = bps; return more(rec, env); },
});
// settings: OLD cho các ca chỉ có nghĩa ở lưới cũ ([0,20) có mẩu q0, dropSlow); ca tương ứng của chế độ 10 s ở cuối file.
async function slowStart(cap, { pause, seekBackAt, watch, settings } = {}) {
  const e = makeEnv(EXT, { cap, pause, ...(settings ? { settings } : {}) });
  e.href = 'https://www.douyin.com/video/' + A;
  const v = e.video(A, 0); v.readyState = 0; v.paused = true;
  let sent1 = null, first = null, gap = 0, cov = 0;
  for (let ms = 0; ms < 34000; ms += 250) {
    if (ms === 500) e.up('items', [e.item(A, 87100, null)]);
    if (ms === 2250) { v.readyState = 4; v.paused = false; }
    if (ms === seekBackAt) v.currentTime = 1;
    await e.tick(250);
    if (watch) watch(e);
    for (const m of e.subs()) {
      if (!e.replies.has(m.key) || e.perf - m.perf < (m.key.includes(':q') ? 1200 : 4000)) continue;
      const p = m.payload, cue = { start: p.from, end: p.to, se: p.to, vi: m.key.slice(20) };
      await e.reply(m.key, m.key.endsWith(':q0') ? { status: 'skipped', label: 'too_short', sung: 0, cues: [] } : { status: 'ok', sung: 0, cues: [cue] });
    }
    const ph = e.dbg.playhead, cv = e.vid(A);
    if (sent1 == null && e.subs().some((m) => m.key === A + ':1')) sent1 = ph;
    if (!cv || !cv.plan) continue;
    const k = cv.plan.findIndex(([a, b]) => ph >= a && ph < b);
    let ok = (cv.chunks.get(k) || {}).status === 'ok';
    for (const q of cv.quick.values()) if (ph >= q.from && ph < q.to && q.status === 'ok') ok = true;
    if (ok && first == null) first = ph;
    if (!ok && first != null && ph < 30) gap += 0.25;
    if (ok && ph >= 10 && ph < 30) cov += 0.25;
  }
  return { e, sent1, first, gap, cov, quick: e.subs().filter((m) => m.key.includes(':q')).map((m) => m.key.slice(20)) };
}

// Các ca slowHead dưới đây chỉ có nghĩa ở lưới cũ: đoạn [0,20) dài hơn QUICK_MIN_CHUNK (có q0, dropSlow), máy chủ chậm từ byte
// 12000 (hết phần của q0). Ở chế độ 10 s, đoạn 0 chỉ là [0,12) s âm thanh = 12000 byte nên kịch bản này không chạm tới nó: các
// ca này ghi rõ cách cũ (OLD), ca tương ứng của chế độ 10 s ở cuối file ("Dịch sẵn 10 s (ứng với ca …)").
await t('Đoạn đầu tải chậm (~25 s) qua máy chủ chậm, q0 bị bỏ qua: bỏ đoạn đó, đoạn kế gửi trước giây 20, có sub sớm; tải nhanh thì không thêm gì', async () => {
  const r = await slowStart(slowHead(560).cap, { ...slowHead(560), settings: OLD });
  // Trước đây: đoạn [20,50) chỉ bắt đầu tải khi đoạn đầu bị ngắt ở giây 20 (gửi ở giây ~25), sub đầu ở giây ~29.
  assert.ok(!r.e.subs().some((m) => m.key === A + ':0'), 'đoạn [0,20) không được gửi: ' + r.e.subs().map((m) => m.key.slice(20)));
  assert.ok(r.sent1 != null && r.sent1 < 20, 'đoạn [20,50) gửi ở giây ' + r.sent1);
  // Đoạn [0,20) không tới server nên đoạn [20,50) gửi dư 8 s (mạch câu, §6e).
  assert.equal(r.e.subs().find((m) => m.key === A + ':1').payload.audioStart, 12);
  assert.ok(r.first != null && r.first < 16, 'sub đầu ở giây ' + r.first + ' (mẩu nhanh: ' + r.quick + ')');
  assert.ok(r.gap <= 2, 'sau đó không có sub ' + r.gap + ' s tới giây 30');
  // Mẩu nối tiếp: mẩu sau bắt đầu khi mẩu trước đã hết, mỗi mẩu một khoảng khác nhau, không phủ quá đoạn bị bỏ.
  const qs = r.e.subs().filter((m) => m.key.includes(':q')).map((m) => m.payload);
  assert.ok(qs.length <= 3 && qs.every((p, i) => i === 0 || p.from >= qs[i - 1].to - 1) && qs.every((p) => p.to <= 20), 'mẩu nhanh: ' + qs.map((p) => p.from + '-' + p.to));
  const f = await slowStart(() => 0, { settings: OLD });   // mọi lượt tải nhanh: như trước khi sửa
  assert.deepEqual(f.quick, ['q0']);
  // Mục lục, q0 và đoạn [0,20) trên một lượt tải từ byte 0 (bản 0.2.25: lượt 64 KB, q0, đoạn 0 là ba lượt riêng). Tải
  // nhanh nên chế độ video dài (0.2.28) vẫn chỉ dịch trước 30 s: không tải thêm đoạn [80,88).
  assert.deepEqual(f.e.media().map((x) => x.a), [0, 18500, 48500], f.e.media().map(f.e.fmt).join(' | '));
});

await t('Đoạn đầu tải chậm vừa phải (2000–2200 B/s, ~12 s): vẫn kịp nên không bỏ, không có mẩu nhanh nào gửi sau khi đoạn đã gửi', async () => {
  // Kịch bản của verifier 1/11 (bản vá trước: mẩu q10 gửi sau khi đoạn [0,20) đã ở server, thêm ~23 s nhận dạng mà sub
  // không ra sớm hơn; đoạn [20,50) gửi dư 8 s thay vì 1,5 s).
  for (const capBps of [2000, 2200]) {
    const r = await slowStart(slowHead(capBps).cap, { ...slowHead(capBps), settings: OLD });
    const subs = r.e.subs();
    const s0 = subs.find((m) => m.key === A + ':0');
    assert.ok(s0, capBps + ' B/s: đoạn [0,20) phải được gửi');
    assert.deepEqual(subs.filter((m) => m.key.includes(':q')).map((m) => m.key.slice(20)), ['q0'], capBps + ' B/s');
    assert.equal(subs.find((m) => m.key === A + ':1').payload.audioStart, 18.5, capBps + ' B/s: đoạn [20,50) gửi dư 1,5 s');
  }
});

await t('Đường truyền chậm đều lúc vào trang (2 video dịch sẵn, 2500–4500 B/s): không thêm mẩu nhanh, lượt tải nào', async () => {
  // Mô phỏng của verifier 1/11: mẩu nhanh nối tiếp, lượt tải thêm bật ra khi chưa đo được tốc độ (rate = 0) thì chia nhỏ
  // băng thông rồi bị ngắt. 2500 B/s: 60 s đầu không có sub nào (bản 31/10: có từ giây 48).
  const B = '7500000000000000005', C3 = '7500000000000000006';
  // Mở video chưa dịch sẵn: hàng dịch sẵn nhường tới khi video đó gửi được mẩu đầu, tối đa 2,5 s (PF_HOLD_MAX). Ở 3500 và
  // 4500 B/s q0 nay tải kịp: sub đầu lúc 9,75 s và 6,75 s, bản 0.2.24 lúc 37 s và 31,5 s (q0 bị bỏ vì tải không kịp). Đổi
  // lại: ở 2500 B/s q0 vẫn không kịp mà 2 video dịch sẵn xong muộn hơn 2,5 s nên đoạn [20,50) có sub muộn hơn 1,7 s (0,75 s
  // thay vì 2,25 s); ở 3500 B/s có sub 21,75 s thay vì 23,25 s trong 60 s đầu; ở 4500 B/s 31,75 s thay vì 28,75 s.
  // Một lượt tải cho mục lục + q0 + đoạn 0 (bản 0.2.25 → nay): q0 và đoạn [0,20) đến từ cùng một lượt, không lượt tải thêm.
  // 2500 B/s: q0 nay gửi được (lúc 9,4 s), có sub 1,75 s thay vì 0,75 s; 3500 B/s: đoạn [0,20) nay gửi được, có sub 30 s
  // thay vì 21,75 s, sub đầu 6,75 s thay vì 9,75 s; 4500 B/s: 44,5 s thay vì 31,75 s, sub đầu 4,5 s thay vì 6,75 s.
  // Chế độ dịch sẵn 10 s (FIRST10=1): đoạn 0 là đúng cửa sổ của q0 ([0,12) s, 12000 byte) nên gửi đúng lúc q0 gửi ở cách cũ (9,4 /
  // 5,25 / 2,95 s); không có mẩu nhanh (đoạn ≤ QUICK_MIN_CHUNK), mỗi đoạn một lượt tải: đoạn 0 từ lượt tải đầu video, [10,20) tải
  // nối tiếp phần lượt đó đã có, rồi mỗi đoạn 30 s một lượt, không lượt nào bị ngắt hay tải lại (restartSlow không chạy: mọi lượt
  // cùng chậm). Không có [0,20) 26000 byte chặn đầu hàng nên có sub nhiều hơn (đo: 22 / 40,75 / 51,75 s); ở 2500 B/s đoạn 0 và
  // [10,20) về khi chỗ đang xem đã qua chúng, sub đầu ở giây 36,75 (đoạn [20,50)).
  // Cách cũ, 2500 B/s, từ 0.2.39 (headReuse, §6af): lượt tải đầu video bị ngắt (đoạn 0 bỏ vì chậm) mà đã có phần đầu cửa sổ
  // [20,50): đoạn đó chỉ tải phần còn thiếu, gửi lúc 43,3 s thay vì 46,9 s, rồi [50,80) gửi lúc 55,3 s; có sub 8,5 s thay vì 1,75 s.
  const ALL5 = ['0', '1', '2', '3', '4'];
  const table = FIRST10 ? [[2500, ALL5, 20, 40], [3500, ALL5, 39, 8], [4500, ALL5, 50, 6]]
    : [[2500, ['q0', '1', '2'], 8.5, 60], [3500, ['q0', '0', '1', '2', '3'], 30, 8], [4500, ['q0', '0', '1', '2', '3'], 44.5, 6]];
  for (const [bw, keys, cover, early] of table) {
    const e = makeEnv(EXT, { bw, autoReplyMs: 1500 });
    e.up('items', [e.item(A, 87100), e.item(B, 60000), e.item(C3, 90000)]);
    e.activeId = A; e.video(A, 0);
    let cov = 0, first = null;
    for (let i = 0; i < 240; i++) {
      await e.tick(250);
      const cv = e.vid(A), ph = e.dbg.playhead;
      if (!cv || !cv.plan) continue;
      let ok = (cv.chunks.get(cv.plan.findIndex(([a, b]) => ph >= a && ph < b)) || {}).status === 'ok';
      for (const q of cv.quick.values()) if (ph >= q.from && ph < q.to && q.status === 'ok') ok = true;
      if (ok) { cov += 0.25; if (first == null) first = ph; }
    }
    const sent = e.subs().filter((m) => m.key.startsWith(A)).map((m) => m.key.slice(20));
    assert.deepEqual(sent, keys, bw + ' B/s: ' + sent);
    assert.ok(cov >= cover, bw + ' B/s: có sub ' + cov + ' s trong 60 s đầu (cần ' + cover + ' s)');
    assert.ok(first != null && first < early, bw + ' B/s: sub đầu ở giây ' + first);
    if (e.f10) {
      const own = e.media().filter((f) => f.vid === A), rest = own.filter((f) => !f.open);
      assert.ok(own.filter((f) => f.open).length === 1 && rest.length === keys.length - 1 && rest.every((f) => !f.aborted),
        bw + ' B/s: lượt tải thêm hay bị ngắt: ' + own.map(e.fmt).join(' | '));
    }
  }
});

await t('Xem video dài trên feed, đường truyền chậm, 4 video kế chờ dịch sẵn: ở lại quá 10 s thì dịch sẵn nhường video đang xem, đoạn kế tải trong lúc đoạn trước ở server, đuổi kịp chỗ đang xem', async () => {
  // Đo 2/11 trên Douyin thật (video 678 s, giới hạn 450 KB/s cho cả tab): bản 0.2.27 hàng dịch sẵn tải đoạn đầu của 4 video
  // kế song song với đoạn của video đang xem, đoạn kế chỉ bắt đầu tải khi đoạn trước có kết quả; đoạn nào cũng về muộn
  // 12–18 s, 66% thời gian phát hiện "đang dịch". Mô phỏng: video 600 s, 1000 B mỗi giây video, server trả lời sau 6 s,
  // 150 s. Bản 0.2.27: "đang dịch" 82,25 s ở 3000 B/s (lần cuối ở giây 88), 24,5 s ở 6000 B/s (lần cuối ở giây 31). Lượt
  // dịch sẵn đã bắt đầu trong 10 s đầu vẫn chạy nốt (ngắt thì lướt feed kém đi), nên phần đầu vẫn trễ.
  const F = ['7500000000000000051', '7500000000000000052', '7500000000000000053', '7500000000000000054'];
  // Chế độ dịch sẵn 10 s (FIRST10=1), đo: 3000 B/s "đang dịch" 35 s (lần cuối ở giây 35): đoạn 0 chỉ 12000 byte, [10,20) tải sớm
  // nối tiếp; 6000 B/s 18 s (lần cuối 24,5): [0,10) và [10,20) như q0 và [0,20) của cách cũ, nhưng đoạn [20,50) gửi muộn hơn 0,6 s
  // vì chia đường truyền với 2 lượt dịch sẵn bắt đầu lúc 8 s (hàng dịch sẵn rảnh sớm hơn do đoạn 0 nhỏ; lượt bắt đầu trước 10 s
  // được chạy nốt, như cách cũ).
  for (const [bw, most, caught] of FIRST10 ? [[3000, 36, 40], [6000, 18.5, 25]] : [[3000, 55, 60], [6000, 17.5, 25]]) {
    const e = makeEnv(EXT, { bw, autoReplyMs: 6000 });
    e.up('items', [e.item(A, 600000), ...F.map((id) => e.item(id, 120000))]);
    e.activeId = A; e.video(A, 0);
    let pend = 0, last = null, overlap = 0;
    for (let i = 0; i < 600; i++) {
      await e.tick(250);
      const cv = e.vid(A), ph = e.dbg.playhead;
      if (!cv || !cv.plan) continue;
      let ok = (cv.chunks.get(cv.plan.findIndex(([a, b]) => ph >= a && ph < b)) || {}).status === 'ok';
      for (const q of cv.quick.values()) if (ph >= q.from && ph < q.to && q.status === 'ok') ok = true;
      if (!ok) { pend += 0.25; last = ph; }
      // Đã ở lại quá 10 s (chế độ video dài): lượt dịch sẵn bắt đầu trong lúc video đang xem có lượt tải đang chạy.
      const live = e.fetches.filter((f) => !f.done && !f.aborted);
      if (e.perf > 10500 && live.some((f) => f.vid === A) && live.some((f) => f.vid !== A && f.vid !== 'x' && f.start === e.perf)) overlap++;
    }
    assert.ok(pend <= most, bw + ' B/s: "đang dịch" ' + pend + ' s / 150 s');
    assert.ok(last == null || last < caught, bw + ' B/s: lần cuối chỗ đang xem chưa có sub ở giây ' + last);
    assert.equal(overlap, 0, bw + ' B/s: lượt dịch sẵn bắt đầu giữa lúc video đang xem đang tải');
  }
});

await t('Chế độ video dài: đoạn kế tải trong lúc đoạn ở chỗ đang xem ở server, gửi ngay sau khi đoạn đó có kết quả, kèm bản xưng hô của nó; lần dò hụt lúc hết chờ không làm tải lại', async () => {
  // Verifier 2/11: dò hụt (không thấy video đang xem một lượt 250 ms) đúng lúc hết chờ thì đoạn đã tải bị bỏ rồi tải lại.
  const PA = { pairs: [{ who: 'A → B', self: 'anh', other: 'em' }] };
  for (const miss of [false, true]) {
    const e = makeEnv(EXT, { bw: 9000 });   // server không tự trả lời
    e.up('items', [e.item(A, 600000)]);
    e.activeId = A; e.video(A, 0);
    // k1: đoạn [20,50) (chứa giây 28): đoạn 1 ở cách cũ, đoạn 2 ở cách dịch sẵn 10 s; đoạn kế [50,80) là k1 + 1 (cùng khoảng byte).
    const k1 = e.f10 ? 2 : 1;
    const answer = async () => { for (const k of [...e.replies.keys()]) if (k !== A + ':' + k1) await e.reply(k, { status: 'ok', cues: [] }); };
    for (let i = 0; i < 112; i++) { await e.tick(250); await answer(); }   // 28 s: đoạn [20,50) ở server, chưa trả lời
    assert.equal(JSON.stringify(e.vid(A).plan.slice(k1, k1 + 2)), '[[20,50],[50,80]]', 'lưới: ' + JSON.stringify(e.vid(A).plan.slice(0, 4)));
    const c2 = e.vid(A).chunks.get(k1 + 1);
    assert.ok(e.replies.has(A + ':' + k1), 'đoạn [20,50) phải đang ở server');
    assert.ok(c2 && c2.status === 'pending' && !c2.sent && c2.waiting, 'đoạn [50,80) đã tải, chờ lượt gửi: ' + JSON.stringify(c2 && { st: c2.status, sent: c2.sent, w: c2.waiting }));
    if (miss) { e.activeId = null; await e.tick(250); e.activeId = A; }
    await e.reply(A + ':' + k1, { status: 'ok', cues: [], pronouns: PA });
    await e.tick(250); await e.tick(250);
    const m2 = e.subs().find((m) => m.key === A + ':' + (k1 + 1));
    assert.ok(m2, (miss ? 'dò hụt: ' : '') + 'đoạn [50,80) phải được gửi');
    assert.equal(JSON.stringify(m2.payload.pronouns), JSON.stringify(PA), 'đoạn [50,80) mang bản xưng hô của đoạn [20,50)');   // khác realm (vm): so JSON
    assert.equal(e.fetches.filter((f) => f.b === 85999).length, 1, (miss ? 'dò hụt: ' : '') + 'đoạn [50,80) chỉ tải một lần');
  }
});

await t('Đoạn đầu tải được 3/4 thì khựng 2,5 s (máy chủ 3000 B/s): không bỏ đoạn, để lượt tải chạy tiếp', async () => {
  // Verifier 1/11: tính tốc độ theo 3 s gần nhất thì một lần khựng ngắn thành "không kịp", đoạn đã tải 74% bị bỏ, sub đầu
  // muộn hơn và thêm một mẩu nhanh.
  // Khựng khi đã có 3/4 đoạn (byte 19500; bản trước tính theo giờ: 6,5 s ở 3000 B/s, cùng chỗ đó).
  let p0 = null;
  const more = (rec, env) => { if (rec.a !== 0 || (rec.b !== 25999 && !rec.open)) return false; if (p0 == null && rec.got >= 19500) p0 = env.perf; return p0 != null && env.perf < p0 + 2500; };
  const sh = slowHead(3000, 12000, more);
  const r = await slowStart(sh.cap, { ...sh, settings: OLD });
  assert.ok(r.e.subs().some((m) => m.key === A + ':0'), 'đoạn [0,20) phải được gửi: ' + r.e.subs().map((m) => m.key.slice(20)));
  assert.deepEqual(r.quick, ['q0']);
});

await t('Trên feed: đoạn đầu của video kế tải chậm ở hàng dịch sẵn rồi mới lướt tới: vẫn bỏ được, có sub sớm', async () => {
  // Verifier 1/11: lượt tải đó (của chính video đang xem, bắt đầu ở hàng dịch sẵn) làm "hàng dịch sẵn bận", dropSlow không
  // chạy; 20 s đầu không có sub, đoạn [20,50) không có mạch câu.
  const B = '7500000000000000005';
  // Lượt tải đoạn đầu của B (riêng, hay lượt tải đầu video) chậm hẳn sau phần của q0, như slowHead. Chỉ ở lưới cũ (OLD), ca tương
  // ứng của chế độ 10 s ở cuối file.
  const e = makeEnv(EXT, { settings: OLD, pause: (rec) => { if (rec.vid === B && rec.a === 0 && (rec.b === 25999 || rec.open) && rec.got >= 12000) rec.cap = 560; return false; } });
  e.up('items', [e.item(A, 60000), e.item(B, 87100)]);
  e.activeId = A; e.video(A, 0);
  let first = null, sent1 = null;
  for (let ms = 0; ms < 34000; ms += 250) {
    if (ms === 4000) { e.videos.get(A).paused = true; e.activeId = B; e.video(B, 0); }
    await e.tick(250);
    for (const m of e.subs()) {
      if (!e.replies.has(m.key) || e.perf - m.perf < (m.key.includes(':q') ? 1200 : 4000)) continue;
      const p = m.payload;
      await e.reply(m.key, m.key === B + ':q0' ? { status: 'skipped', label: 'too_short', sung: 0, cues: [] } : { status: 'ok', sung: 0, cues: [{ start: p.from, end: p.to, se: p.to, vi: 'x' }] });
    }
    if (ms < 4000) continue;
    const cv = e.vid(B), ph = e.dbg.playhead;
    if (sent1 == null && e.subs().some((m) => m.key === B + ':1')) sent1 = ph;
    if (!cv || !cv.plan) continue;
    let ok = (cv.chunks.get(cv.plan.findIndex(([a, b]) => ph >= a && ph < b)) || {}).status === 'ok';
    for (const q of cv.quick.values()) if (ph >= q.from && ph < q.to && q.status === 'ok') ok = true;
    if (ok && first == null) first = ph;
  }
  assert.ok(!e.subs().some((m) => m.key === B + ':0'), 'đoạn [0,20) của B không gửi (đã bỏ)');
  assert.ok(sent1 != null && sent1 < 20, 'đoạn [20,50) của B gửi ở giây ' + sent1);
  assert.equal(e.subs().find((m) => m.key === B + ':1').payload.audioStart, 12);
  assert.ok(first != null && first < 16, 'sub đầu của B ở giây ' + first);
});

// Kịch bản §6v: A đang xem (video ngắn, dịch xong từ trước), thông tin Y (25 s) và P1–P3 tới lúc 1,5 s (API feed tới muộn),
// lướt sang slide livestream lúc 2 s, sang Y lúc `at` ms. aMs: độ dài A. Trả về số ms từ lúc lướt tới Y tới khi chỗ đang
// xem có sub (null: không có trong tới 17 s) và các lượt tải của Y.
const LY = '7500000000000000061', LP = ['7500000000000000062', '7500000000000000063', '7500000000000000064'];
async function afterLive(opts, at = 3000, aMs = 12000) {
  const e = makeEnv(EXT, { autoReplyMs: 1500, ...opts });
  e.up('items', [e.item(A, aMs)]);
  e.activeId = A; e.video(A, 0);
  let swipe = null, first = null;
  for (let ms = 0; ms < 20000; ms += 250) {
    if (ms === 1500) e.up('items', [e.item(LY, 25000), ...LP.map((id) => e.item(id, 60000))]);
    if (ms === 2000) { e.videos.get(A).paused = true; e.activeId = null; }   // slide livestream: không có video để dò
    if (ms === at) { e.activeId = LY; e.video(LY, 0); swipe = e.perf; }
    await e.tick(250);
    if (swipe == null) continue;
    const cv = e.vid(LY), ph = e.dbg.playhead;
    if (!cv || !cv.plan) continue;
    let ok = (cv.chunks.get(0) || {}).status === 'ok';
    for (const q of cv.quick.values()) if (ph >= q.from && ph < q.to && q.status === 'ok') ok = true;
    if (ok && first == null) first = e.perf - swipe;
  }
  return { e, first, y: e.fetches.filter((f) => f.vid === LY) };
}

await t('Video ngay sau slide livestream, lượt tải đầu của nó chậm riêng (máy chủ video chậm theo từng lượt): vẫn thôi lượt đó, có sub sớm; đường truyền chậm đều thì như cũ', async () => {
  // Đo 2/11 trên Douyin thật: thông tin video sau slide livestream tới 1 s trước khi lướt tới; lượt tải đầu của nó mất 4,3 s
  // cho mục lục, 17 s cho đoạn 0, trong khi 2 video dịch sẵn chạy cùng lúc tải xong trong ~3 s (video dịch sẵn thứ 3 không
  // tới server). headLate không thôi lượt đó vì "có video khác đang tải" (othersLoading): "đang dịch" 23 s.
  // (a) Như bản đo: P1 chạy cùng lượt đầu của Y, xong nhanh; P2 chậm theo lượt, còn đang tải lúc xét (ở slide livestream 4 s).
  // Bản 0.2.29: không có sub trong 14 s.
  const q0Again = (r) => r.y.filter((f) => !f.open && f.a > 0 && f.b === 11999).length;
  const a = await afterLive({ cap: (x, b, vid) => ((vid === LY && b == null) || vid === LP[1] ? 300 : 0) }, 6000);
  assert.ok(a.first != null && a.first <= 6000, '(a) có sub sau ' + a.first + ' ms');
  // (b) P1 còn đang tải, nhanh gấp 10 lượt của Y (chưa lượt nhanh nào xong): lượt của P1 không tính là "đường truyền đang
  // chia". Bản 0.2.29: sub sau 16 s.
  const b = await afterLive({ cap: (x, b2, vid) => (vid === LY && b2 == null ? 300 : vid === LP[0] ? 3000 : 0) });
  assert.ok(b.first != null && b.first <= 6000, '(b) có sub sau ' + b.first + ' ms');
  // (c) Đối chứng (verifier 2/11): A dài 60 s, không máy chủ nào chậm riêng, cả đường truyền giảm lúc 1,5 s, sau khi q0 của A
  // tải nhanh. Không được coi là chậm riêng: không thôi lượt đầu của Y (không có lượt q0 nối tiếp), sub như bản 0.2.29 (8,75 s
  // và 9,75 s). Bản tính cả lượt nhanh xong từ trước khi lượt của Y bắt đầu: có lượt q0 nối tiếp, không có sub trong 17 s.
  // Chế độ dịch sẵn 10 s (FIRST10=1): Y (25 s) chia [0,10) [10,26); đoạn 0 là đúng cửa sổ của q0 (lượt q0 nối tiếp cũng là lượt
  // tới byte 11999), nhưng từ giây phim 4 đoạn [10,26) của Y tải song song trên hàng của video đang xem (còn ≤ F10_NEAR s là tới),
  // nên lượt đầu của Y chỉ được 1/3 đường truyền thay vì 1/2: đoạn 0 có kết quả lúc 10 s và 11,75 s sau khi lướt (đo trên bản sao
  // content.js đã sửa lỗi CONCURRENT_SLACK nói dưới; bản hiện tại: ca thứ hai không có sub trong 17 s, có lượt q0 nối tiếp).
  for (const [bw, want] of [[(perf) => (perf < 1500 ? 9000 : 3000), FIRST10 ? 10000 : 8750], [(perf) => (perf < 1500 ? 20000 : 2500), FIRST10 ? 11750 : 9750]]) {
    const c = await afterLive({ bw }, 3000, 60000);
    assert.equal(JSON.stringify(c.e.vid(LY).plan), c.e.f10 ? '[[0,10],[10,26]]' : '[[0,26]]', '(c) lưới của Y');
    assert.equal(q0Again(c), 0, '(c) lượt q0 nối tiếp: ' + c.y.map((f) => (f.open ? 'đầu ' : '') + f.a + '-' + f.b).join(' '));
    assert.ok(c.first != null && c.first <= want, '(c) có sub sau ' + c.first + ' ms (0.2.29: ' + want + ' ms)');
  }
});

// Mục lục, lượt tải đầu của video đang xem (2/11, hướng 2). Y: video dài 25 s.
const Y = '7500000000000000071';
// (a) Y được dịch sẵn nhưng hai lượt tải đầu của nó treo (CDN treo, §6f), lượt sau tải bình thường. Lướt tới Y lúc `at`.
async function hungPrefetch(dir, at = 16000) {
  let n = 0;
  const e = makeEnv(dir, { autoReplyMs: 1500, stall: (a, b, env) => 0, pause: (rec) => rec.vid === Y && rec.open && rec.hung });
  // Đánh dấu hai lượt "bytes=0-" đầu của Y là treo (không nhận byte nào).
  const orig = e.fetches.push.bind(e.fetches);
  e.fetches.push = (rec) => { if (rec.vid === Y && rec.open && n++ < 2) rec.hung = true; return orig(rec); };
  e.up('items', [e.item(A, 60000), e.item(Y, 25000)]);
  e.activeId = A; e.video(A, 0);
  let swipe = null, first = null;
  for (let ms = 0; ms < at + 20000; ms += 250) {
    if (ms === at) { e.videos.get(A).paused = true; e.activeId = Y; e.video(Y, 0); swipe = e.perf; }
    await e.tick(250);
    if (swipe == null) continue;
    const cv = e.vid(Y), ph = e.dbg.playhead;
    if (!cv) continue;
    if (okAt(cv, ph) && first == null) first = e.perf - swipe;
  }
  return first;
}
// Chỗ đang xem có sub: đoạn chứa nó đã có kết quả, hay một mẩu nhanh phủ nó. Y dài 25 s: cách cũ chỉ một đoạn [0,26) (như đoạn 0
// của các bản trước); chế độ dịch sẵn 10 s chia [0,10) [10,26), phải xét đúng đoạn ở chỗ đang xem.
function okAt(cv, ph) {
  const k = cv.plan ? Math.max(0, chunkAtOf(cv.plan, ph)) : 0;
  let ok = (cv.chunks.get(k) || {}).status === 'ok';
  for (const q of cv.quick.values()) if (ph >= q.from && ph < q.to && q.status === 'ok') ok = true;
  return ok;
}
// (b) Y mở lạnh, mục lục 150 KB; lượt tải đầu tiên của Y nhỏ giọt 20 KB/s (lượt sau bình thường). other: có video kế P
// tải cùng lúc (bằng chứng đường truyền còn dư). bw: đường truyền.
// base, settings: bố cục file (mặc định âm thanh tính từ byte 0, như các bản trước) và cài đặt (ca 10 s ở cuối file).
async function slowMoov(dir, { other = true, bw = 200000, firstCap = 20000, base = 0, settings } = {}) {
  let n = 0;
  const P = '7500000000000000072';
  const e = makeEnv(dir, { bw, autoReplyMs: 1500, head: 150000, base, ...(settings ? { settings } : {}), cap: (a, b, vid) => (vid === Y && b == null && n++ === 0 ? firstCap : 0) });
  e.up('items', [e.item(Y, 25000), ...(other ? [e.item(P, 25000)] : [])]);
  e.activeId = Y; e.video(Y, 0);
  let first = null;
  for (let ms = 0; ms < 25000; ms += 250) {
    await e.tick(250);
    const cv = e.vid(Y), ph = e.dbg.playhead;
    if (!cv) continue;
    if (okAt(cv, ph) && first == null) first = e.perf;
  }
  return { e, first, heads: e.fetches.filter((f) => f.vid === Y && f.open).length };
}

await t('Lượt tải lúc dịch sẵn treo rồi mới lướt tới: thử lại ngay; mục lục nhỏ giọt khi có video khác tải nhanh: gọi lại một lần; đường truyền chậm đều thì như cũ', async () => {
  // Đo 2/11 trên Douyin thật: lượt tải lúc dịch sẵn treo hai lần ("tải video quá lâu"), lướt tới thì chờ đủ 20 s mới thử lại,
  // nhãn "lỗi" suốt lúc đó: sub sau 16,9 s. Bản 0.2.30 ở ca (a): không có sub trong 20 s.
  const a = await hungPrefetch(EXT);
  assert.ok(a != null && a <= 5000, '(a) có sub sau ' + a + ' ms');
  // (b) Bản 0.2.30: 9,25 s.
  const sm = ({ first, heads }) => JSON.stringify({ first, heads });
  const b = await slowMoov(EXT);
  assert.ok(b.first != null && b.first <= 6500 && b.heads === 2, '(b) ' + sm(b));
  // (c), (d) Đối chứng: không có bằng chứng chậm riêng thì không gọi lại (gọi lại tải mục lục từ byte 0), như 0.2.30.
  // (c) ở chế độ dịch sẵn 10 s (FIRST10=1): mục lục xong lúc 16,75 s, chỗ đang xem đã ở [10,26), đoạn 0 hết cần nên lượt tải đầu
  // video dừng ngay sau mục lục; đoạn [10,26) gửi dư 8 s phía trước (đoạn trước chưa dịch): cửa sổ [2,32) s = 30000 byte, 3,35 s ở
  // 9000 B/s, rồi 1,5 s ở server: 21,75 s (cách cũ: đoạn [0,26) nằm trong phần đã tải vì âm thanh giả tính từ byte 0, 18,25 s).
  const c = await slowMoov(EXT, { other: false, bw: 9000, firstCap: 0 });
  assert.equal(JSON.stringify(c.e.vid(Y).plan), c.e.f10 ? '[[0,10],[10,26]]' : '[[0,26]]', '(c) lưới của Y');
  assert.ok(c.heads === 1 && c.first != null && c.first <= (c.e.f10 ? 21750 : 18250), '(c) ' + sm(c));
  const d = await slowMoov(EXT, { bw: 30000, firstCap: 0 });
  assert.ok(d.heads === 1 && d.first != null && d.first <= 9000, '(d) ' + sm(d));
});

await t('Tua về đầu ngay sau khi bỏ đoạn đầu: không tải lại đoạn đó khi còn trong nó, không gửi mẩu thường chồng lên đoạn đã có sub', async () => {
  // Verifier 1/11: hết thời gian chờ lúc chỗ đang xem còn trong đoạn (giây ~18), đoạn bị tải lại, và mẩu thường q18 chồng
  // lên đoạn [20,50) đã có sub (16,5 s âm thanh trả tiền vô ích). Chỉ ở lưới cũ (OLD: dropSlow bỏ [0,20)); chế độ 10 s không bỏ đoạn
  // 0 và không có mẩu nhanh (ca tương ứng ở cuối file: "ứng với hai ca đoạn đầu tải chậm").
  const r = await slowStart(slowHead(560).cap, { ...slowHead(560), seekBackAt: 7250, settings: OLD });
  const again = r.e.media().filter((f) => f.a === 0 && (f.b === 25999 || f.open));
  assert.equal(again.length, 1, 'đoạn [0,20) tải ' + again.length + ' lần: ' + again.map(r.e.fmt).join(' | '));
  const late = r.e.subs().filter((m) => m.key.includes(':q') && m.payload.to > 20);
  assert.deepEqual(late.map((m) => m.key.slice(20)), [], 'mẩu nhanh chồng lên [20,50)');
});

await t('Đoạn đầu tải nhanh 1/4 rồi chậm hẳn (560 B/s): vẫn bỏ sớm, có sub kịp lúc phần lớn [10,30)', async () => {
  // Verifier 1/11: lấy trung bình cả lượt tải làm tốc độ thì chậm từ 20–33% đoạn trở đi bị bỏ quá muộn (sub kịp lúc 5,75–9,75
  // trên 20 s của [10,30), so với 16,5 s).
  // Chậm hẳn khi đã qua phần của q0 (byte 12000) và 1/4 phần còn lại của đoạn.
  const r = await slowStart(() => 0, { ...slowHead(560, 15500), settings: OLD });
  assert.ok(!r.e.subs().some((m) => m.key === A + ':0'), 'đoạn [0,20) không gửi (đã bỏ)');
  assert.ok(r.cov >= 15, 'có sub kịp lúc ' + r.cov + ' s trên 20 s của [10,30)');
});

await t('Rời feed sang trang không có video (tìm kiếm): sau 1 s không tải, không gửi thêm việc dịch sẵn nào', async () => {
  // Verifier 1/11: bản trước giữ cả việc dịch sẵn chưa gửi, nên sau khi rời feed vẫn tải và gửi đoạn đầu của 4 video kế.
  const ids = ['7500000000000000011', '7500000000000000012', '7500000000000000013', '7500000000000000014', '7500000000000000015', '7500000000000000016'];
  const e = makeEnv(EXT);
  e.up('items', ids.map((id) => e.item(id, 60000)));
  e.activeId = ids[0]; e.video(ids[0], 0);
  for (let ms = 0; ms < 1500; ms += 250) await e.tick(250);
  const n0 = e.subs().length;
  e.href = 'https://www.douyin.com/search/abc'; e.activeId = null;
  for (let ms = 0; ms < 1500; ms += 250) await e.tick(250);   // 1 s chờ (lúc lướt có thể không thấy video một lượt dò)
  const n1 = e.subs().length, m1 = e.media().length;
  for (let ms = 0; ms < 20000; ms += 250) await e.tick(250);
  assert.equal(e.subs().length, n1, 'gửi thêm sau khi rời feed: ' + e.subs().slice(n1).map((m) => m.key.slice(16)));
  assert.equal(e.media().length, m1, 'tải thêm sau khi rời feed');
  assert.ok(n1 - n0 <= 1, 'trong 1 s chờ gửi ' + (n1 - n0));
  // Còn ở feed mà slide đang xem là livestream (không có video để dò): việc dịch sẵn chạy tiếp, chỉ video cũ thôi.
  const f = makeEnv(EXT);
  f.up('items', ids.map((id) => f.item(id, 60000)));
  f.activeId = ids[0]; f.video(ids[0], 0);
  for (let ms = 0; ms < 1500; ms += 250) await f.tick(250);
  f.activeId = null; f.videos.get(ids[0]).paused = true;
  const nf = f.subs().length;   // q0 của video cũ có thể đã gửi trước lúc đó (mẩu q0 lấy từ lượt tải đầu video)
  for (let ms = 0; ms < 21500; ms += 250) await f.tick(250);
  const pre = f.subs().filter((m) => m.key !== ids[0] + ':0' && m.key.endsWith(':0')).map((m) => m.key.slice(16));
  assert.ok(pre.length >= 3, 'dịch sẵn trên feed khi slide là livestream: ' + pre);
  assert.ok(!f.subs().slice(nf).some((m) => m.key.startsWith(ids[0]) && m.key !== ids[0] + ':0'), 'không gửi thêm gì cho video cũ: ' + f.subs().map((m) => m.key.slice(16)));
  // Slide mất video ngay khi hàng dịch sẵn còn đang nhường video cũ (chưa gửi được gì): sau 1 s chờ thì dịch sẵn chạy lại
  // ngay, không chờ hết 2,5 s nhường (mô phỏng: lượt tải đầu lúc 1000 ms sau khi mất video, chờ hết hạn thì 2350 ms).
  const g = makeEnv(EXT);
  g.up('items', ids.map((id) => g.item(id, 60000)));
  g.activeId = ids[0]; g.video(ids[0], 0);
  await g.tick(250);
  const lost = g.perf;
  g.activeId = null; g.videos.get(ids[0]).paused = true;
  for (let ms = 0; ms < 3000; ms += 250) await g.tick(250);
  const pf = g.fetches.find((x) => x.vid !== ids[0]);
  assert.ok(pf && pf.start - lost <= 1300, 'dịch sẵn bắt đầu ' + (pf && pf.start - lost) + ' ms sau khi slide mất video');
});

// ---- Lần mở video (đợt first load 1/11): hàng dịch sẵn nhường video vừa mở, báo server làm nóng, mốc thời gian.
const S = ['7500000000000000021', '7500000000000000022', '7500000000000000023', '7500000000000000024', '7500000000000000025'];
// Mở kết quả tìm kiếm đầu (modal), 4 kết quả kế được dịch sẵn. hang: các lượt tải âm thanh của video đang xem treo.
// drop: lúc đó (ms) <video> về readyState 0 (trình phát nạp lại khi CDN treo): schedule() thôi chạy, chỉ còn setTimeout
// lúc hết PF_HOLD_MAX chạy lại hàng dịch sẵn.
async function openSearch({ hang = false, drop = null } = {}) {
  const e = makeEnv(EXT, { autoReplyMs: 2600, pause: (rec) => hang && rec.vid === S[0] });
  e.href = 'https://www.douyin.com/search/abc?modal_id=' + S[0];
  const v = e.video(S[0], 0);
  const t0 = e.perf;
  e.up('items', S.map((id) => e.item(id, 45000, 'search')));
  for (let i = 0; i < 160; i++) { if (drop != null && e.perf - t0 === drop) Object.assign(v, { readyState: 0, paused: true }); await e.tick(50); }
  const f = e.fetches.find((x) => x.vid && x.vid !== S[0]);   // lượt tải đầu tiên (cả mục lục) của video khác
  const pf = f ? f.start - t0 : null;
  const first = e.subs().find((m) => m.key.startsWith(S[0]));
  // piece: mẩu đầu ở chỗ đang xem: q0 ở cách cũ; ở chế độ dịch sẵn 10 s là chính đoạn 0 (đúng cửa sổ [0,12) s của q0, không có mẩu nhanh).
  const piece = (e.subs().find((m) => m.key === S[0] + (e.f10 ? ':0' : ':q0')) || {}).perf - t0;
  return { e, t0, pf, first: first && first.perf - t0, q0: piece };
}

await t('Mở kết quả tìm kiếm chưa dịch sẵn, 4 kết quả kế chờ dịch sẵn: mẩu nhanh gửi sớm hơn hẳn, hàng dịch sẵn chạy lại ngay sau lần gửi đầu', async () => {
  // HANDOFF §6i: mẩu nhanh chỉ "tải một mình" khi hàng dịch sẵn rảnh. Trước đây q0 gửi lúc 5000 ms (tải chung với 2 video
  // dịch sẵn), nay 2000 ms.
  const r = await openSearch();
  assert.ok(r.q0 <= 2500, (r.e.f10 ? 'đoạn 0' : 'q0') + ' gửi lúc ' + r.q0 + ' ms');
  if (r.e.f10) assert.ok(!r.e.subs().some((m) => m.key.includes(':q')), 'chế độ 10 s gửi mẩu nhanh: ' + r.e.subs().map((m) => m.key.slice(16)));
  assert.ok(r.pf != null && r.pf >= r.first && r.pf <= r.first + 300, 'lượt tải dịch sẵn đầu lúc ' + r.pf + ' ms, mẩu đầu gửi lúc ' + r.first + ' ms');
});

await t('Mở video chưa dịch sẵn mà lượt tải âm thanh của nó treo: hàng dịch sẵn chỉ nhường 2,5 s, kể cả khi <video> về readyState 0', async () => {
  for (const drop of [null, 500]) {
    const r = await openSearch({ hang: true, drop });
    assert.equal(r.first, undefined, 'không gửi được gì cho video đang xem');
    assert.ok(r.pf != null && r.pf >= 2400 && r.pf <= 2900, (drop ? 'readyState 0 từ ' + drop + ' ms: ' : '') + 'lượt tải dịch sẵn đầu lúc ' + r.pf + ' ms');
  }
});

await t('Báo server làm nóng (warm): một lần cho mỗi video vừa mở chưa có kết quả, cách nhau ít nhất 3 s; lướt tới video đã dịch sẵn (xong hay đã gửi, đang chờ server) thì không báo, không nhường; mốc xếp theo lúc xem', async () => {
  const ids = ['7500000000000000031', '7500000000000000032', '7500000000000000033', '7500000000000000034', '7500000000000000035', '7500000000000000036', '7500000000000000037'];
  const e = makeEnv(EXT, { autoReplyMs: 2600 });
  e.up('items', ids.map((id) => e.item(id, 45000)));
  e.activeId = ids[0]; e.video(ids[0], 0);
  const at = [e.perf];
  const swipe = (i) => { e.videos.get(ids[i - 1]).paused = true; e.activeId = ids[i]; e.video(ids[i], 0); at[i] = e.perf; };
  await e.tick(1000);
  swipe(1);              // video 2 chưa dịch sẵn: báo, nhưng chờ đủ 3 s sau lần báo trước
  await e.tick(25000);   // video 3–6 dịch sẵn xong, hàng dịch sẵn rảnh
  const w = e.warms();
  assert.equal(w.length, 2, 'số lần báo: ' + w.map((m) => m.perf));
  assert.ok(w[0].perf - at[0] <= 300, 'lần báo đầu lúc ' + (w[0].perf - at[0]) + ' ms');
  assert.ok(w[1].perf - w[0].perf >= 3000 && w[1].perf - w[0].perf <= 3300, 'hai lần báo cách nhau ' + (w[1].perf - w[0].perf) + ' ms');
  assert.equal(w[0].server, 'http://127.0.0.1:8787');
  // Video 3 đã dịch xong trước khi lướt tới: không báo, và hàng dịch sẵn bắt đầu ngay video kế mới (video 7) không chờ.
  assert.ok(e.log.some(([, , k]) => k === ids[2] + ':0'), 'video 3 phải dịch sẵn xong');
  const n = e.fetches.length;
  swipe(2);
  await e.tick(500);
  assert.equal(e.warms().length, 2, 'báo cho video đã dịch sẵn');
  const f7 = e.fetches.slice(n).find((f) => f.vid === ids[6]);
  assert.ok(f7 && f7.start - at[2] <= 300, 'dịch sẵn video 7 bắt đầu lúc ' + (f7 && f7.start - at[2]) + ' ms sau khi lướt');
  // Đoạn 0 đã gửi lúc dịch sẵn nhưng server chưa trả lời: cũng không báo, không nhường (kết quả đang tới). Mở kết quả tìm
  // kiếm thứ 3, rồi thứ 2 (dịch sẵn của nó bị huỷ khi mở kết quả 3: không còn là kết quả kế, nên lần này có báo): mốc xếp
  // theo lúc thành video đang xem, không theo lúc có mốc dịch sẵn đầu tiên.
  const g = makeEnv(EXT);   // server không trả lời
  const gs = ['7500000000000000041', '7500000000000000042', '7500000000000000043', '7500000000000000044', '7500000000000000045', '7500000000000000046', '7500000000000000047'];
  g.href = 'https://www.douyin.com/search/abc?modal_id=' + gs[0];
  g.up('items', gs.map((id) => g.item(id, 45000, 'search')));
  g.video(gs[0], 0);
  const sent = (id) => g.subs().some((m) => m.key === id + ':0');
  for (let ms = 0; ms < 20000 && !(sent(gs[1]) && sent(gs[2]) && sent(gs[3]) && sent(gs[4])); ms += 250) await g.tick(250);
  assert.ok(sent(gs[2]) && sent(gs[4]), 'chưa dịch sẵn xong: ' + g.subs().map((m) => m.key.slice(16)));
  await g.tick(3000);   // quá WARM_GAP: nếu có báo thì đã báo
  const nw = g.warms().length, nf = g.fetches.length;
  const open = (i) => { g.videos.clear(); g.href = 'https://www.douyin.com/search/abc?modal_id=' + gs[i]; g.video(gs[i], 0); return g.perf; };   // modal mới thay <video> cũ
  const at2 = open(2);
  await g.tick(500);
  assert.equal(g.warms().length, nw, 'báo cho video đã gửi dịch sẵn, đang chờ server');
  const f6 = g.fetches.slice(nf).find((f) => f.vid === gs[5]);
  assert.ok(f6 && f6.start - at2 <= 300, 'dịch sẵn kết quả 6 bắt đầu lúc ' + (f6 && f6.start - at2) + ' ms sau khi mở');
  open(1);
  await g.tick(500);
  assert.equal(g.warms().length, nw + 1, 'kết quả 2 (dịch sẵn đã huỷ) phải báo');
  const order = g.status().marks.map((x) => x.id.slice(16)).join();   // mảng tạo trong vm: so chuỗi
  assert.equal(order, [gs[0], gs[2], gs[1]].map((id) => id.slice(16)).join(), 'thứ tự mốc: ' + order);
});

await t('Mốc thời gian lần mở video trong câu trả lời status: có đủ, đúng lúc theo kịch bản, kèm kiểu trang và nguồn metadata', async () => {
  const e = makeEnv(EXT);
  e.href = 'https://www.douyin.com/video/' + A;
  const v = e.video(A, 0); v.readyState = 0; v.paused = true;
  let wall = null;
  for (let ms = 0; ms < 8000; ms += 250) {
    if (ms === 0) wall = e.now + 50;
    if (ms === 500) e.up('items', [{ ...e.item(A, 45000, null), source: 'ssr' }]);
    if (ms === 1000) v.readyState = 4;
    if (ms === 1250) v.paused = false;
    await e.tick(250);
    for (const m of e.subs()) {
      if (!e.replies.has(m.key) || e.perf - m.perf < 1000) continue;
      const p = m.payload;
      await e.reply(m.key, { status: 'ok', sung: 0, cues: [{ start: p.from, end: p.to, se: p.to, vi: 'x' }] });
    }
  }
  const st = e.status();
  assert.ok(st && Array.isArray(st.marks), 'không có marks: ' + JSON.stringify(st));
  assert.equal(st.page, 'video');
  const mk = st.marks.find((x) => x.id === A);
  assert.ok(mk, 'không có mốc của video đang xem');
  assert.equal(mk.page, 'video'); assert.equal(mk.src, 'ssr'); assert.equal(mk.wall, wall);
  const t_ = mk.t;
  // Chế độ dịch sẵn 10 s: đoạn 0 chỉ 10 s nên không có mẩu nhanh, không có mốc quick*; sub đầu đến từ đoạn 0 (chunk*).
  const QK = ['quickDl', 'quickDlEnd', 'quickPost', 'quickReply'];
  for (const k of ['current', 'item', 'video', 'ready', 'play', 'settle', 'moov', 'moovEnd', ...(e.f10 ? [] : QK), 'chunkDl', 'chunkDlEnd', 'chunkPost', 'chunkReply', 'drawn']) {
    assert.ok(typeof t_[k] === 'number', 'thiếu mốc ' + k + ': ' + JSON.stringify(t_));
  }
  if (e.f10) assert.ok(QK.every((k) => !(k in t_)), 'chế độ 10 s có mốc mẩu nhanh: ' + JSON.stringify(t_));
  // Mốc so với các điểm cố định của kịch bản (thành video đang xem ở lượt dò đầu, lúc 50 ms): metadata lúc 500 ms,
  // readyState 4 lúc 1000 ms, phát lúc 1250 ms; dò 4 lần/giây; server trả lời sau ít nhất 1 s.
  const near = (k, a, b) => assert.ok(t_[k] >= a && t_[k] <= b, k + ' lúc ' + t_[k] + ' (cần ' + a + '–' + b + '): ' + JSON.stringify(t_));
  assert.equal(t_.current, 0);
  near('video', 0, 0); near('item', 400, 500); near('moov', 400, 550); near('ready', 950, 1250); near('settle', 950, 1250);
  near('play', 1200, 1750);
  assert.ok((e.f10 || t_.quickReply - t_.quickPost >= 1000) && t_.chunkReply - t_.chunkPost >= 1000, 'trả lời sớm hơn 1 s: ' + JSON.stringify(t_));
  for (const chain of [['current', 'video', 'ready', 'play'], e.f10 ? ['item', 'moov', 'moovEnd', 'chunkDl', 'chunkDlEnd', 'chunkPost', 'chunkReply'] : ['item', 'moov', 'moovEnd', 'quickDl', 'quickDlEnd', 'quickPost', 'quickReply'], ['moovEnd', 'chunkDl', 'chunkDlEnd', 'chunkPost', 'chunkReply']]) {
    assert.ok(chain.every((k, i) => i === 0 || t_[k] >= t_[chain[i - 1]]), chain.join(' ≤ ') + ': ' + JSON.stringify(t_));
  }
  assert.ok(t_.drawn <= Math.min(e.f10 ? Infinity : t_.quickReply, t_.chunkReply) + 300, 'drawn lúc ' + t_.drawn);
});

// ---- Một lượt tải cho đầu video (first load bước 2): mục lục + mẩu q0 + đoạn 0 trên cùng một lượt tải từ byte 0.
// Bố cục gần file thật hơn các ca trên: moov dài H byte, video 2 Mbit/s (250 KB mỗi giây, âm thanh xen trong đó), lượt tải
// đầu tiên qua /aweme/v1/play/ (chuyển hướng: 2 rtt tới byte đầu), lượt 64 KB cũ cũng chia băng thông (realProbe).
const H = 40000, BPS = 250000, W0 = H + 26 * BPS;   // W0: byte sau cùng của âm thanh đoạn [0,20) (cửa sổ [0, 26) s) + 1
// Mở video A: /video/ (item lúc itemAt, <video> phát từ playAt) hay feed (đang phát từ 0). Trả về env và các mốc (ms từ lúc có
// item): q0, c0 (lúc gửi), heads (các lượt tải "bytes=0-" của A), mine (mọi lượt tải của A trước đoạn [20,50)).
// Chế độ dịch sẵn 10 s (env.f10): w0 = byte cuối của âm thanh đoạn 0 + 1 (cửa sổ [0,12) s thay vì [0,26) s: W0 là của cách cũ);
// mine = các lượt cho mục lục và đoạn 0 (đoạn [10,20) có cửa sổ từ giây 5,5, tải nối tiếp lượt đầu video: không tính).
// slack: lượt tải đầu video đọc tới hết cửa sổ rồi mới ngắt, nên có thể dư tới một bước 50 ms của mạng giả (bw × 50 ms); ở cách
// cũ W0 = 6,54 MB tình cờ gần bội số của các bước đó nên dư ≤ 100 KB, ở chế độ 10 s (3,04 MB) thì không.
async function openVideo({ rtt = 150, bw = 3e6, head = H, itemAt = 0, playAt = 0, feed = false, ids = [A], ms = 8000, env = {}, during } = {}) {
  const e = makeEnv(EXT, { bw, rtt, realProbe: true, head, base: head, bps: BPS, autoReplyMs: 2600, ...env });
  if (feed) { e.activeId = A; } else e.href = 'https://www.douyin.com/video/' + A;
  const v = e.video(A, 0);
  if (playAt > 0) { v.readyState = 0; v.paused = true; }
  for (let t = 0; t < ms; t += 50) {
    if (t === itemAt) e.up('items', ids.map((id) => e.item(id, 45000, feed ? true : null)));
    if (t === playAt && playAt > 0) { v.readyState = 4; v.paused = false; }
    if (during) await during(e, t);
    await e.tick(50);
  }
  const at = (key) => { const m = e.subs().find((x) => x.key === key); return m ? m.perf - itemAt : null; };
  const own = e.fetches.filter((f) => f.vid === A);
  const w0 = head + (e.f10 ? 12 : 26) * BPS;
  return { e, q0: at(A + ':q0'), c0: at(A + ':0'), c1: at(A + ':1'), heads: own.filter((f) => f.open), own, w0, slack: e.f10 ? Math.max(100000, bw * 0.05) : 100000,
    mine: e.f10 ? own.filter((f) => f.open || f.b < w0) : own.filter((f) => f.a < head + 18 * BPS) };
}
const MB = (fs) => fs.reduce((s, f) => s + f.got, 0);
// Tổng kiểm (như aacSum của makeEnv) của byte [a, b) trong file giả: cắt đúng phần âm thanh từ lượt tải đầu video.
const sumOf = (a, b) => { let x = 0; for (let i = 0; i < b - a; i++) x = (x * 31 + ((a + i) % 251) + i) % 1000000007; return x; };

await t('Mở video: một lượt tải cho mục lục, q0 và đoạn 0; q0 và đoạn 0 gửi sớm hơn, tải ít byte hơn (nhiều rtt, băng thông)', async () => {
  // Số của bản 0.2.25 (lượt 64 KB, rồi q0 và đoạn 0 tải riêng, đoạn 0 bị q0 ngắt rồi tải lại) và của bản này, ms từ lúc có
  // item. Trang /video/ (item 1,5 s, phát 2,8 s như đo 1/11): q0 6200 → 2150 (rtt 50, 1,5 MB/s), 3700 → 2150 (150, 3 MB/s);
  // đoạn 0: 6550 → 4500, 3050 → 2500, 2050 → 1700 (300, 6 MB/s: đoạn 0 gửi trước lúc phát, khỏi q0). Video đã phát sẵn: q0
  // 2700 → 2200, 1800 → 1400, 1500 → 1200; đoạn 0 7100 → 4550, 4150 → 2550, 2900 → 1750. Byte tải: 9,6–12 MB → 6,6 MB
  // (âm thanh đoạn 0 là 6,54 MB; bản 0.2.25 tải lại phần đầu và cả 12 s của q0).
  // Chế độ dịch sẵn 10 s (FIRST10=1): đoạn 0 là đúng cửa sổ của q0 ([0,12) s), cùng một lượt tải đầu video, nên phải gửi không
  // muộn hơn q0 ở cách cũ (cột q0Max; trang /video/ 300 ms 6 MB/s không có q0: không muộn hơn đoạn 0 cũ); không có mẩu nhanh.
  // Đo: 2150 / 1350 / 1150 (trang /video/, đoạn 0 không phải chờ phát như q0) và 2200 / 1400 / 1200 (feed). Đoạn [10,20) tải nối
  // tiếp đúng từ byte lượt đầu video đã nhận (không byte nào tải hai lần), ngay sau khi đoạn 0 gửi.
  for (const [page, rtt, bw, q0Max, c0Max] of [
    ['video', 50, 1.5e6, 2300, 4650], ['video', 150, 3e6, 2300, 2650], ['video', 300, 6e6, null, 1850],
    ['feed', 50, 1.5e6, 2350, 4700], ['feed', 150, 3e6, 1550, 2700], ['feed', 300, 6e6, 1350, 1900]]) {
    const r = await openVideo(page === 'video' ? { rtt, bw, itemAt: 1500, playAt: 2800 } : { rtt, bw, feed: true });
    const tag = `${page} rtt ${rtt} ms, ${bw / 1e6} MB/s: `;
    assert.equal(r.mine.length, 1, tag + 'số lượt tải: ' + r.mine.map(r.e.fmt).join(' | '));
    assert.ok(r.heads.length === 1 && /aweme\/v1\/play/.test(r.heads[0].url), tag + 'lượt tải đầu video qua /aweme/v1/play/');
    const got = MB(r.mine);
    assert.ok(got >= r.w0 && got <= r.w0 + r.slack, tag + 'tải ' + got + ' byte (âm thanh đoạn 0 tới byte ' + r.w0 + ')');
    if (q0Max == null || r.e.f10) assert.equal(r.q0, null, tag + 'q0 gửi lúc ' + r.q0);
    else assert.ok(r.q0 != null && r.q0 <= q0Max, tag + 'q0 gửi lúc ' + r.q0 + ' ms (cần ≤ ' + q0Max + ')');
    const c0Lim = r.e.f10 ? q0Max ?? c0Max : c0Max;
    assert.ok(r.c0 != null && r.c0 <= c0Lim, tag + 'đoạn 0 gửi lúc ' + r.c0 + ' ms (cần ≤ ' + c0Lim + ')');
    const sent = (k) => r.e.subs().find((m) => m.key === A + k).payload;
    assert.equal(sent(':0').aacSum, sumOf(H, r.w0), tag + 'âm thanh đoạn 0 cắt sai');
    if (q0Max != null && !r.e.f10) assert.equal(sent(':q0').aacSum, sumOf(H, H + 12 * BPS), tag + 'âm thanh q0 cắt sai');
    if (r.e.f10) {
      const f1 = r.e.fetches.filter((f) => f.vid === A && !f.open && f.b === W0 - 1);
      assert.ok(f1.length === 1 && f1[0].a === Math.floor(r.heads[0].got), tag + 'đoạn [10,20) tải nối tiếp: ' + r.e.fetches.filter((f) => f.vid === A).map(r.e.fmt).join(' | '));
    }
  }
});

await t('Tua tới gần cuối đoạn 0 lúc đang tải đầu video: mẩu nhanh lấy tiếp từ chính lượt đó, không thêm lượt tải song song', async () => {
  // Mẩu ở giây 16–17 cần tới giây 28–29, quá cuối âm thanh đoạn 0 (26 s): lượt tải đầu video đọc thêm tới đó. Bản 0.2.25:
  // 5 lượt tải trước đoạn [20,50) (4 lượt bị ngắt), mẩu nhanh gửi lúc 3100 ms; nay một lượt, 2800 ms.
  // Chỉ ở lưới cũ: giây 16 nằm trong đoạn [0,20) (có mẩu nhanh). Ở chế độ 10 s giây 16 thuộc [10,20) (không có mẩu nhanh): ca
  // tương ứng ở cuối file.
  const r = await openVideo({ feed: true, ms: 6000, env: { settings: OLD }, during: (e, t) => { if (t === 700) e.videos.get(A).currentTime = 16; } });
  const q = r.e.subs().find((m) => /:q1[67]$/.test(m.key));
  assert.ok(q, 'không có mẩu nhanh ở chỗ tua: ' + r.e.subs().map((m) => m.key.slice(17)));
  const end = H + (q.payload.to + 2) * BPS;
  assert.equal(r.mine.length, 1, r.mine.map(r.e.fmt).join(' | '));
  assert.ok(r.heads[0].got >= end && r.heads[0].got <= end + 100000, r.e.fmt(r.heads[0]) + ', cần tới byte ' + end);
  assert.ok(q.perf <= 2900, 'mẩu nhanh gửi lúc ' + q.perf);
  assert.equal(q.payload.aacSum, sumOf(H + (q.payload.from - 4.5) * BPS, end), 'âm thanh mẩu nhanh cắt sai');
});

await t('Dịch sẵn trên feed: mỗi video kế tiếp một lượt tải cho cả mục lục và đoạn 0', async () => {
  const B = '7500000000000000005', C3 = '7500000000000000006';
  const r = await openVideo({ feed: true, ids: [A, B, C3], ms: 10000 });
  for (const id of [B, C3]) {
    const own = r.e.fetches.filter((f) => f.vid === id);
    assert.ok(r.e.subs().some((m) => m.key === id + ':0'), id.slice(-1) + ': đoạn 0 chưa gửi: ' + r.e.subs().map((m) => m.key.slice(17)));
    assert.equal(own.length, 1, id.slice(-1) + ': ' + own.map(r.e.fmt).join(' | '));
    assert.ok(own[0].open && own[0].got >= r.w0 && own[0].got <= r.w0 + r.slack, id.slice(-1) + ': ' + r.e.fmt(own[0]));
  }
});

await t('Lượt tải đầu video, ca dự phòng: moov > 64 KB, file không có moov ở đầu, máy chủ bỏ qua Range (200 cả file)', async () => {
  // moov 150 KB: vẫn một lượt (bản 0.2.25: thêm lượt [0, moov) tải lại 64 KB đầu).
  const big = await openVideo({ head: 150000, feed: true });
  assert.equal(big.mine.length, 1, 'moov 150 KB: ' + big.mine.map(big.e.fmt).join(' | '));
  assert.ok(big.c0 != null && big.c0 <= 2800, 'moov 150 KB: đoạn 0 gửi lúc ' + big.c0);
  // moov không ở đầu (mdat trước): như lượt 64 KB cũ, thôi khi đã đọc 64 KB, báo lỗi, không đọc tiếp cả file.
  const ns = await openVideo({ head: null, feed: true, ms: 3000 });
  assert.equal(ns.heads.length, 1, 'không có moov ở đầu: ' + ns.mine.map(ns.e.fmt).join(' | '));
  assert.ok(ns.heads[0].aborted && ns.heads[0].got < 300000, 'không có moov ở đầu: ' + ns.e.fmt(ns.heads[0]));
  // Sau đó đoạn [20,50) thử lượt 64 KB riêng (đoạn 0 đã lỗi, không còn cần lượt tải đầu video), như bản 0.2.25.
  assert.ok(ns.mine.length <= 2 && ns.mine.every((f) => f.got < 300000), 'tải thêm: ' + ns.mine.map(ns.e.fmt).join(' | '));
  assert.equal(ns.e.vid(A).chunks.get(0).error, 'video không có mục lục ở đầu file (chưa hỗ trợ)');
  // 200 không có Content-Range (cả file): đọc tới hết âm thanh đoạn 0 rồi ngắt (bản 0.2.25 đọc cả file trong lượt 64 KB).
  const full = await openVideo({ feed: true, env: { status: (a, b) => (b == null ? 200 : 206) } });
  assert.equal(full.mine.length, 1, '200: ' + full.mine.map(full.e.fmt).join(' | '));
  assert.ok(full.heads[0].aborted && full.heads[0].got <= full.w0 + full.slack, '200: ' + full.e.fmt(full.heads[0]));
  assert.ok(full.c0 != null && full.c0 <= 2700, '200: đoạn 0 gửi lúc ' + full.c0);
  // Cỡ file lấy theo Content-Length (không có Content-Range), để vẫn nhận ra file đã đổi ở các lượt sau (fetchBytes).
  assert.equal(full.e.vid(A).media.total, 99999999, '200: cỡ file');
});

await t('Lướt đi giữa lúc tải đầu video: ngắt ngay, không gửi gì cho video cũ, không tải thêm', async () => {
  const B = '7500000000000000005';
  let swipe = null;
  const r = await openVideo({ feed: true, bw: 1.5e6, ids: [A, B], ms: 6000, during: (e, t) => {
    if (t === 1500) { swipe = e.perf; e.videos.get(A).paused = true; e.activeId = B; e.video(B, 0); }
  } });
  assert.equal(r.heads.length, 1, r.mine.map(r.e.fmt).join(' | '));
  const h = r.heads[0];
  assert.ok(h.aborted && h.end - swipe <= 300 && h.got < W0, 'lượt tải đầu video của A: ' + r.e.fmt(h) + ', lướt lúc ' + swipe);
  assert.deepEqual(r.e.subs().filter((m) => m.key.startsWith(A)).map((m) => m.key.slice(17)), []);
  assert.equal(r.e.fetches.filter((f) => f.vid === A).length, 1, 'tải thêm cho A');
});

await t('HTTP 429 ở lượt tải đầu video của video kế: lượt tải của video đang xem chạy tiếp tới xong, mọi lượt mới nghỉ 5 s', async () => {
  const B = '7500000000000000005';
  let blocked = false;
  const r = await openVideo({ feed: true, ids: [A, B], ms: 9000,
    env: { status: (a, b, url) => (b == null && url.includes(B) && !blocked ? (blocked = true, 429) : 206) } });
  const b429 = r.e.fetches.find((f) => f.vid === B && f.status === 429);
  assert.ok(b429, 'không có 429: ' + r.e.fetches.map(r.e.fmt).join(' | '));
  assert.ok(r.heads.length === 1 && r.heads[0].got >= r.w0, 'lượt tải đầu video của A: ' + r.e.fmt(r.heads[0]));
  assert.equal(r.mine.length, 1, r.mine.map(r.e.fmt).join(' | '));
  assert.ok(r.c0 != null, 'đoạn 0 của A chưa gửi');
  const later = r.e.fetches.filter((f) => f.start > b429.start);
  assert.ok(later.length && later.every((f) => f.start - b429.start >= 5000), 'lượt tải mới sau 429: ' + later.map((f) => f.vid.slice(-1) + '@' + (f.start - b429.start)).join(' '));
});

await t('Lượt tải đầu video treo, trong lúc đó video kế bị 429: lần gọi lại (sau 4 s) chờ hết thời gian nghỉ chung', async () => {
  // Lượt "bytes=0-" của A không trả byte nào; B (dịch sẵn) bị 429 lúc ~2,9 s nên mọi lượt mới nghỉ 5 s. Lần gọi lại của A
  // (hết 4 s im) rơi vào lúc nghỉ: không gọi (loadHead kiểm rateWait như rangeFetch), hết nghỉ mới tải lại.
  const B = '7500000000000000005';
  let firstA = null, blocked = false;
  const r = await openVideo({ feed: true, ids: [A, B], ms: 14000, env: {
    pause: (rec) => { if (rec.vid === A && rec.open && !firstA) firstA = rec; return rec === firstA; },
    status: (a, b, url) => (b == null && url.includes(B) && !blocked ? (blocked = true, 429) : 206) } });
  const b429 = r.e.fetches.find((f) => f.vid === B && f.status === 429);
  assert.ok(firstA && b429 && b429.start < firstA.start + 4000, 'kịch bản: ' + r.e.fetches.map(r.e.fmt).join(' | '));
  const during = r.e.fetches.filter((f) => f.start > b429.start && f.start - b429.start < 5000);
  assert.deepEqual(during.map(r.e.fmt), [], 'gọi trong lúc nghỉ sau 429');
  const againA = r.e.fetches.filter((f) => f.vid === A && f.start > firstA.start);
  assert.ok(againA.length && againA[0].start - b429.start >= 5000, 'gọi lại: ' + r.e.fetches.map((f) => String(f.vid).slice(-1) + ' ' + r.e.fmt(f)).join(' | '));
  // Hết nghỉ thì chỗ đang xem (~8,5 s) có mẩu nhanh như thường.
  assert.ok(r.e.subs().some((m) => m.key.startsWith(A) && m.perf - b429.start >= 5000), 'A không gửi gì sau lúc nghỉ');
});

await t('CDN treo ở lượt tải đầu video: trước khi có mục lục thì gọi lại sau 4 s; sau đó thì phần còn thiếu tải lại một lần qua /aweme/v1/play/ sau 6 s', async () => {
  // Không byte nào (cả mục lục): như lượt 64 KB cũ, 4 s thì gọi lại (lần này chờ tới 8 s).
  let first = true;
  const pre = await openVideo({ feed: true, ms: 9000, env: { stall: (a, b) => (b == null && first ? (first = false, 60000) : 0) } });
  assert.equal(pre.heads.length, 2, pre.mine.map(pre.e.fmt).join(' | '));
  const gap = pre.heads[1].start - pre.heads[0].start;
  assert.ok(gap >= 4000 && gap <= 4400, 'gọi lại sau ' + gap + ' ms');
  assert.ok(pre.c0 != null && pre.c0 <= 4000 + 3000, 'đoạn 0 gửi lúc ' + pre.c0);
  // moov 150 KB, im 5 s giữa moov (đã thấy header của moov): như lượt [0, moov) của bản 0.2.25, im tới 6 s mới cắt; trước
  // đây hạn 4 s áp tới hết moov, nên gọi lại từ byte 0.
  let p0 = null;
  const big = await openVideo({ head: 150000, feed: true, ms: 9000, env: { pause: (rec, env) => {
    if (!rec.open || rec.got < 100000) return false; if (p0 == null) p0 = env.perf; return env.perf < p0 + 5000; } } });
  assert.equal(big.heads.length, 1, 'moov 150 KB, im 5 s: ' + big.mine.map(big.e.fmt).join(' | '));
  assert.ok(big.c0 != null, 'moov 150 KB, im 5 s: đoạn 0 chưa gửi');
  // Có mục lục và 1 MB rồi im: 6 s sau, q0 rồi đoạn 0 tải nối tiếp phần còn thiếu (từ byte đã nhận), qua /aweme/v1/play/,
  // lần lượt: đoạn 0 chờ q0 xong (q0 đã chờ trên lượt đó quá 3 s nên cổng quickGate đã tự mở: trước đây hai lượt song song).
  let stop = null;
  const mid = await openVideo({ feed: true, ms: 12000, env: { pause: (rec, env) => { if (rec.open && rec.got >= 1e6) { if (stop == null) stop = env.perf; return true; } return false; } } });
  assert.equal(mid.heads.length, 1, mid.mine.map(mid.e.fmt).join(' | '));
  const h = mid.heads[0];
  assert.ok(h.aborted && h.end - stop >= 5900 && h.end - stop <= 6300, 'lượt tải đầu video ngắt lúc ' + (h.end - stop) + ' ms sau khi im');
  const again = mid.e.fetches.filter((f) => f.vid === A && !f.open && f.start >= h.end && f.a < H + 18 * BPS);
  const got = Math.floor(h.got);
  // Chế độ dịch sẵn 10 s (FIRST10=1): lượt thứ nhất là đoạn 0 ([0,12) s, cùng khoảng byte với q0 cũ), qua /aweme/v1/play/ vì nó đang
  // chờ trên lượt đầu video bị treo; lượt thứ hai là đoạn [10,20) (cửa sổ từ giây 5,5), tải tiếp sau phần đoạn 0 vừa nối vào, không
  // tải lại [5,5; 12) s. Nó không chờ trên lượt đầu video nên đi link CDN như mọi lượt thường.
  const f10 = mid.e.f10;
  assert.ok(again.length === 2 && again.every((f, i) => (f10 && i === 1) || /aweme\/v1\/play/.test(f.url)) && again[0].a === got && again[0].b === H + 12 * BPS - 1
    && again[1].a === H + 12 * BPS && again[1].b === W0 - 1, 'tải nối tiếp: ' + again.map(mid.e.fmt).join(' | ') + ', đã nhận ' + got);
  assert.ok(again[1].start >= again[0].end, (f10 ? 'đoạn [10,20) tải song song với đoạn 0: ' : 'đoạn 0 tải song song với q0: ') + again.map(mid.e.fmt).join(' | '));
  const sent = (k) => mid.e.subs().find((m) => m.key === A + k).payload;
  if (f10) {
    assert.ok(!mid.e.subs().some((m) => m.key.includes(':q')), 'chế độ 10 s gửi mẩu nhanh');
    assert.equal(sent(':0').aacSum, sumOf(H, H + 12 * BPS), 'âm thanh đoạn 0 ghép sai');
    assert.equal(sent(':1').aacSum, sumOf(H + 5.5 * BPS, W0), 'âm thanh đoạn [10,20) ghép sai');
  } else {
    assert.equal(sent(':q0').aacSum, sumOf(H, H + 12 * BPS), 'âm thanh q0 ghép sai');
    assert.equal(sent(':0').aacSum, sumOf(H, W0), 'âm thanh đoạn 0 ghép sai');
  }
});

await t('Đổi chế độ lời bài hát sau khi đoạn 0 lấy từ lượt tải đầu video: xin lại gửi đúng các byte âm thanh cũ (server dùng lại ASR)', async () => {
  const r = await openVideo({ feed: true, ms: 4000, env: { autoReplyMs: null } });
  const e = r.e;
  const s1 = e.subs().find((m) => m.key === A + ':0');
  assert.ok(s1, 'đoạn 0 chưa gửi');
  await e.reply(A + ':0', { status: 'ok', sung: 1, cues: [{ start: 1, end: 3, se: 3, vi: '♪', sung: true }] });
  await e.tick(250);
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  for (let i = 0; i < 48 && e.subs().filter((m) => m.key === A + ':0').length < 2; i++) await e.tick(250);   // sau đoạn [20,50) đang tải
  const again = e.subs().filter((m) => m.key === A + ':0');
  assert.equal(again.length, 2, 'không xin lại: ' + e.subs().map((m) => m.key.slice(17)));
  const [p1, p2] = again.map((m) => m.payload);
  assert.equal(p2.audioStart, p1.audioStart);
  assert.ok(p1.aacLen === r.w0 - H && p2.aacLen === p1.aacLen && p2.aacSum === p1.aacSum, `âm thanh khác: ${p1.aacLen}/${p1.aacSum} và ${p2.aacLen}/${p2.aacSum}`);
  assert.equal(p1.aacSum, sumOf(H, r.w0), 'âm thanh đoạn 0 cắt sai');
  // Các kiểm tra trên cũng đạt trên bản 0.2.25 (canh luật v.redo); hai kiểm tra dưới là cách làm mới: lần đầu lấy từ lượt tải
  // đầu video, lần xin lại tải riêng đúng cửa sổ đó (phần đã nhận đã bỏ khi đoạn 0 có kết quả).
  assert.equal(r.mine.length, 1, r.mine.map(e.fmt).join(' | '));
  assert.ok(e.fetches.some((f) => f.vid === A && f.a === H && f.b === r.w0 - 1), e.fetches.map(e.fmt).join(' | '));
});

// Các lượt tải của một video không chồng lên nhau theo thời gian (không tải song song).
const overlaps = (fs) => fs.filter((f, i) => fs.some((g, j) => j > i && g.start < (f.end ?? Infinity) && f.start < (g.end ?? Infinity) && !f.preAborted && !g.preAborted));

await t('Lượt tải đầu video chậm hẳn ngay từ byte 0 (q0 đi chung lượt đó): thôi lượt đó, tải nối tiếp bằng lượt riêng, không tệ hơn bản 0.2.25', async () => {
  // Verifier soát bản vá: lượt "bytes=0-" 1040 B/s từ byte 0 thì q0 cũng chậm (gửi lúc 12,1 s), dropSlow không có lượt
  // nhanh để so: sub đầu giây 29, có sub 1/20 s của [10,30). Bản 0.2.25 (q0 lượt riêng nhanh, lượt đoạn 0 chậm): 12,5 s và
  // 16,5 s. Nay (headLate): 1040 B/s: 7,5 s và 20 s (lượt nối tiếp nhanh). Lượt nối tiếp của đoạn 0 cũng chậm (560 B/s):
  // dropSlow vẫn bỏ được nhờ q0 tải nối tiếp nhanh, 12,5 s và 16,5 s như bản 0.2.25. Ca này cố ý đạt cả trên bản 0.2.25 (lượt
  // [0,26) s chậm từ byte 0), để canh hồi quy của chính cách tải mới.
  // Cả lượt nối tiếp cũng chậm 1040–1400 B/s (1040 B/s: đoạn 0 mất ~25 s như đo 1/11): lượt nối tiếp chỉ còn 14000 byte nên
  // sub vừa kịp trước giây 20, dropSlow không bỏ: sub đầu giây 19,5 / 17,75 / 16 (1040 / 1200 / 1400 B/s), có sub 7,75–14 s.
  // Nay bỏ khi sub tới lúc đoạn còn dưới 5 s (SLOW_KEEP): 12,5 s và 16,5 s như bản 0.2.25.
  // Chỉ ở lưới cũ (OLD): byte 25999 là cuối cửa sổ đoạn [0,20) (ở chế độ 10 s là cuối cửa sổ [10,20)); ca tương ứng ở cuối file.
  const from0 = (bps, chunkToo) => ({ pause: (rec) => { if ((rec.a === 0 && (rec.b === 25999 || rec.open)) || (chunkToo && rec.b === 25999)) rec.cap = bps; return false; } });
  for (const [bps, chunkToo, first, cov] of [[1040, false, 13, 16], [560, false, 13, 16], [560, true, 13, 16], [1040, true, 13, 16], [1400, true, 13, 16]]) {
    // Lượt nối tiếp của đoạn 0: dropSlow ước thời gian còn lại theo phần phải tải của lượt đó (prog.bytes), không theo cả cửa sổ.
    const bytes = new Set();
    const watch = (e) => {
      const c = e.vid(A) && e.vid(A).chunks.get(0), f = e.media().find((x) => !x.open && x.a > 0 && x.b === 25999 && !x.done && !x.aborted);
      if (c && c.status === 'pending' && f) bytes.add(c.bytes + '/' + (26000 - f.a));
    };
    const r = await slowStart(() => 0, { ...from0(bps, chunkToo), watch, settings: OLD });
    const tag = bps + ' B/s' + (chunkToo ? ' (cả lượt nối tiếp của đoạn 0)' : '') + ': ';
    if (chunkToo) assert.ok(bytes.size && [...bytes].every((x) => x.split('/')[0] === x.split('/')[1]), tag + 'prog.bytes/phần phải tải: ' + [...bytes]);
    assert.ok(r.first != null && r.first <= first, tag + 'sub đầu ở giây ' + r.first + ', ' + r.e.subs().map((m) => m.key.slice(20) + '@' + m.perf).join(' '));
    assert.ok(r.cov >= cov, tag + 'có sub ' + r.cov + ' s trên 20 s của [10,30)');
    // q0 tải nối tiếp phần còn thiếu qua link CDN đã chuyển hướng (thôi vì chậm, không phải lỗi: lượt mới tới cùng link).
    const q0 = r.e.media().find((f) => !f.open && f.a > 0 && f.b === 11999);
    assert.ok(q0 && /cdn\.example/.test(q0.url), tag + 'q0 tải nối tiếp: ' + r.e.media().map((f) => f.url.slice(8, 20) + ' ' + r.e.fmt(f)).join(' | '));
    // Mẩu nối tiếp (q9) chạy song song với đoạn [20,50) như bản 0.2.25 (không chặn đoạn kế); chỉ xét các lượt của [0,26) s.
    assert.deepEqual(overlaps(r.e.media().filter((f) => f.open || f.b <= 25999)).map(r.e.fmt), [], tag + 'tải song song');
  }
});

await t('Mở video khi trình phát đã ở giây 15 (feed, đồng hồ giữa video): giữ lượt 64 KB cũ, mẩu nhanh tải riêng', async () => {
  // Đọc từ byte 0 tới chỗ đang xem thì mẩu nhanh gửi lúc 2650 ms thay vì 2200 ms (3 MB/s, rtt 150), và đoạn [0,20) cũng được
  // gửi (thêm 26 s âm thanh nhận dạng, phần lớn đã phát qua).
  const e = makeEnv(EXT, { bw: 3e6, rtt: 150, realProbe: true, head: H, base: H, bps: BPS, autoReplyMs: 2600 });
  e.activeId = A; e.video(A, 15);
  e.up('items', [e.item(A, 45000, true)]);
  for (let t = 0; t < 6000; t += 50) await e.tick(50);
  const own = e.fetches.filter((f) => f.vid === A);
  assert.ok(own.length && own[0].b === 65535 && own.every((f) => !f.open), own.map(e.fmt).join(' | '));
  if (e.f10) {
    // Chế độ dịch sẵn 10 s (FIRST10=1): giây 15 thuộc [10,20), ≤ QUICK_MIN_CHUNK nên không có mẩu nhanh; chính đoạn đó gửi ngay,
    // dư 8 s phía trước (đoạn trước chưa dịch): cửa sổ [2,26) s = 6 MB thay vì 4,1 MB của q15 ([10,5; 27) s), thêm ~0,6 s ở 3 MB/s
    // (đo: 2550 ms so với 2200 ms của q15).
    const c = e.subs().find((m) => m.key === A + ':1');
    assert.ok(c && c.perf <= 2600 && c.payload.audioStart === 2, 'đoạn [10,20) gửi lúc ' + (c && c.perf) + ': ' + e.subs().map((m) => m.key.slice(17) + '@' + m.perf).join(' '));
    assert.ok(!e.subs().some((m) => m.key.includes(':q')), 'chế độ 10 s gửi mẩu nhanh');
  } else {
    const q = e.subs().find((m) => m.key === A + ':q15');
    assert.ok(q && q.perf <= 2300, 'mẩu nhanh gửi lúc ' + (q && q.perf));
  }
  assert.ok(!e.subs().some((m) => m.key === A + ':0'), 'gửi cả đoạn [0,' + e.vid(A).plan[0][1] + ')');
});

await t('Tiến độ và tốc độ khi lấy từ lượt tải đầu video: tính theo cửa sổ của chính đoạn, tốc độ theo lúc byte về (dropSlow)', async () => {
  // Trang /video/: q0 chỉ bắt đầu sau QUICK_STALL, lúc phần byte của nó đã về từ lâu. Tốc độ phải là tốc độ tải thật (3 MB/s
  // trừ 2 rtt), không chia cho cả lúc chờ (khi đó ~1,5 MB/s, chỉ còn gấp 3 tốc độ của một lượt chậm 0,5 MB/s: dropSlow không
  // bỏ được đoạn chậm). Tiến độ của đoạn 0 (got) tính từ byte đầu cửa sổ của nó, không tính mục lục.
  // Chế độ dịch sẵn 10 s (FIRST10=1): không có q0; mẩu đầu là chính đoạn 0 (chờ trên lượt đó từ lúc có mục lục, xong khi byte cuối
  // cửa sổ [0,12) s về): tốc độ đọc khi đoạn 0 gửi, cửa sổ của nó 3 MB.
  let speed = null, prog = null, f10 = false;
  await openVideo({ rtt: 150, bw: 3e6, itemAt: 1500, playAt: 2800, during: (e, t) => {
    const v = e.vid(A);
    f10 = e.f10;
    if (speed == null && e.subs().some((m) => m.key === A + (f10 ? ':0' : ':q0'))) speed = v.speed;
    const c = v && v.chunks.get(0), rec = e.fetches.find((f) => f.vid === A && f.open);
    if (t === 2500 && c && rec) prog = { got: c.got, bytes: c.bytes, recv: Math.floor(rec.got) };
  } });
  assert.ok(speed != null && speed >= 2000, 'tốc độ ' + speed + ' byte/ms');
  assert.ok(prog && prog.got > 0 && prog.got <= prog.recv - H && prog.bytes === (f10 ? 12 : 26) * BPS, 'tiến độ đoạn 0: ' + JSON.stringify(prog));
});

// ---- Chế độ thử "dịch sẵn 10 s" (cài đặt first10, ô trong popup; HANDOFF §6aa, §6ab): đoạn [0,10) rồi [10,25), rồi 30 s;
// đoạn sau đoạn ở chỗ đang xem chỉ làm khi đã xem 3 s.
const F10 = { settings: { first10: true } };
await t('Thử dịch sẵn 10 s: video 45 s chia [0,10) [10,20) [20,46); đoạn 0 gửi 12 s âm thanh; đoạn 1 tải ngay khi lướt tới nhưng chỉ gửi khi đã xem 4 s (video trước không xem lâu); video kế dịch sẵn chỉ đoạn 0; tắt thì như cũ', async () => {
  const B = '7500000000000000005';
  const r = await openVideo({ feed: true, ids: [A, B], ms: 9000, env: F10 });
  assert.equal(JSON.stringify(r.e.vid(A).plan), JSON.stringify([[0, 10], [10, 20], [20, 46]]));
  const at = (key) => r.e.subs().find((m) => m.key === key);
  for (const id of [A, B]) {
    const s0 = at(id + ':0');
    assert.ok(s0, id.slice(-1) + ': đoạn 0 chưa gửi: ' + r.e.subs().map((m) => m.key.slice(17)));
    assert.equal(s0.payload.aacLen, 12 * BPS, id.slice(-1) + ': âm thanh đoạn 0 (byte)');
  }
  const s1 = at(A + ':1');
  assert.ok(s1 && s1.perf >= 4000, 'đoạn [10,20) gửi lúc ' + (s1 && s1.perf) + ' (phải sau khi đã xem 4 s)');
  // Tải trước cửa chờ (tải không tốn tiền; chủ dự án dùng thử 2/11: hụt ở giây 10 vì tải sau cửa 3 s).
  const f1 = r.e.fetches.find((f) => f.vid === A && !f.open && f.b === H + 26 * BPS - 1);
  assert.ok(f1 && f1.start < 2500, 'đoạn [10,20) bắt đầu tải lúc ' + (f1 && f1.start) + ': ' + r.e.fetches.filter((f) => f.vid === A).map(r.e.fmt).join(' | '));
  // Gửi dư 4,5 s phía trước (server giữ câu vắt qua giây 10; đoạn 0 chỉ gửi dư 2 s phía sau; verifier 2/11, F1).
  assert.equal(s1.payload.audioStart, 5.5, 'đoạn [10,20) bắt đầu âm thanh ở');
  assert.equal(s1.payload.aacLen, (26 - 5.5) * BPS, 'âm thanh đoạn [10,20) (byte)');
  assert.ok(!at(B + ':1') && !r.e.subs().some((m) => m.key.endsWith(':q0')), 'gửi thêm: ' + r.e.subs().map((m) => m.key.slice(17)));
  const off = await openVideo({ feed: true, ids: [A, B], ms: 3000, env: { settings: OLD } });   // đã bỏ chọn ô
  assert.equal(JSON.stringify(off.e.vid(A).plan), JSON.stringify([[0, 20], [20, 46]]));
});

await t('Thử dịch sẵn 10 s: mở giữa video (trình phát ở giây 30) thì đoạn ở chỗ đang xem không phải chờ cửa chờ (verifier 2/11, F7)', async () => {
  const e = makeEnv(EXT, { bw: 1.2e7, rtt: 150, realProbe: true, head: H, base: H, bps: BPS, autoReplyMs: 2600, ...F10 });
  e.activeId = A; e.video(A, 30);
  e.up('items', [e.item(A, 90000, true)]);
  for (let t = 0; t < 6000; t += 50) await e.tick(50);
  const k = 2;   // [20,50) ở lưới 10 s
  assert.equal(JSON.stringify(e.vid(A).plan.slice(0, 3)), '[[0,10],[10,20],[20,50]]', 'lưới');
  const s = e.subs().find((m) => m.key === A + ':' + k);
  assert.ok(s && s.perf < 2500, 'đoạn ở chỗ đang xem (' + k + ') gửi lúc ' + (s && s.perf) + ': ' + e.subs().map((m) => m.key.slice(17) + '@' + m.perf).join(' '));
});

await t('Thử dịch sẵn 10 s: lượt tải đầu video nhỏ giọt (150 KB/s) mà đoạn 0 chỉ 10 s (không có mẩu nhanh): vẫn thôi lượt đó, tải nối tiếp, đoạn 0 gửi sớm (verifier 2/11, F2: trước đây không có sub trong 15 s)', async () => {
  const slowHead = { pause: (rec) => { if (rec.open && rec.vid === A) rec.cap = 150000; return false; } };
  const r = await openVideo({ feed: true, ms: 9000, env: { ...F10, ...slowHead } });
  const s0 = r.e.subs().find((m) => m.key === A + ':0');
  assert.ok(s0 && s0.perf <= 5000, 'đoạn 0 gửi lúc ' + (s0 && s0.perf) + ': ' + r.e.fetches.filter((f) => f.vid === A).map(r.e.fmt).join(' | '));
  assert.equal(s0.payload.aacLen, 12 * BPS, 'âm thanh đoạn 0 ghép đủ');
  const cont = r.e.fetches.filter((f) => f.vid === A && !f.open);
  assert.ok(cont.some((f) => f.done && f.b === H + 12 * BPS - 1), 'lượt nối tiếp: ' + r.e.fetches.filter((f) => f.vid === A).map(r.e.fmt).join(' | '));
});

await t('Thử dịch sẵn 10 s: phần dư cuối ngắn hơn 8 s gộp vào đoạn trước (video 25 s; video 13 s thành một lần), video ≤ 12 s một lần (verifier 2/11, F4)', async () => {
  // Video đang xem và 4 video kế (dịch sẵn) được chia đoạn; hai lượt vì mỗi lượt chỉ 5 video có plan.
  const plansOf = async (durs) => {
    const ids = durs.map((_, i) => '75000000000000000' + String(10 + i));
    const e = makeEnv(EXT, { bw: 3e6, rtt: 150, realProbe: true, head: H, base: H, bps: BPS, autoReplyMs: 2600, ...F10 });
    e.activeId = ids[0]; e.video(ids[0], 0);
    e.up('items', ids.map((id, i) => e.item(id, durs[i] * 1000, true)));
    for (let t = 0; t < 9000; t += 50) await e.tick(50);
    return ids.map((id) => JSON.stringify(e.vid(id) && e.vid(id).plan));
  };
  assert.deepEqual(await plansOf([45, 27, 31, 62, 12]), [[[0, 10], [10, 20], [20, 46]], [[0, 10], [10, 20], [20, 28]], [[0, 10], [10, 20], [20, 32]], [[0, 10], [10, 20], [20, 50], [50, 63]], [[0, 13]]].map((x) => JSON.stringify(x)));
  assert.deepEqual(await plansOf([45, 13, 17, 25]), [[[0, 10], [10, 20], [20, 46]], [[0, 14]], [[0, 10], [10, 18]], [[0, 10], [10, 26]]].map((x) => JSON.stringify(x)));
});

await t('Thử dịch sẵn 10 s: lượt tải đoạn [10,25) chậm hẳn (máy chủ chậm theo lượt) trong khi lượt khác nhanh: thôi, tải lại một lần qua kết nối mới, gửi kịp (verifier 2/11, F2: đoạn ngắn không có dropSlow, mẩu nhanh)', async () => {
  let slowOnce = false;
  // Lượt tải của đoạn [10,20): cửa sổ âm thanh [5,5; 26) s, nối tiếp phần lượt tải đầu video đã có (tới giây 12), nên nhận theo byte cuối.
  const END1 = H + 26 * BPS - 1;
  const slow1 = { pause: (rec) => { if (!rec.open && rec.vid === A && rec.b === END1 && !slowOnce && !rec.slowMarked) { slowOnce = true; rec.slowMarked = true; rec.cap = 300000; } return false; } };
  const r = await openVideo({ feed: true, ms: 14000, env: { ...F10, ...slow1 } });
  const s1 = r.e.subs().find((m) => m.key === A + ':1');
  const own = r.e.fetches.filter((f) => f.vid === A && !f.open && f.b === END1);
  assert.ok(s1 && s1.perf <= 10000, 'đoạn [10,25) gửi lúc ' + (s1 && s1.perf) + ': ' + r.e.fetches.filter((f) => f.vid === A).map(r.e.fmt).join(' | ') + ' · gửi: ' + r.e.subs().map((m) => m.key.slice(17) + '@' + m.perf).join(' '));
  assert.equal(own.length, 2, 'số lượt tải đoạn [10,25): ' + own.map(r.e.fmt).join(' | '));
  assert.equal(s1.payload.aacLen, (26 - 5.5) * BPS, 'âm thanh đoạn [10,20) đủ');
  // Lượt đó chỉ chậm hẳn khi đã tải được 85%: phần còn lại ở tốc độ đó nhanh hơn tải lại cả cửa sổ, nên không thôi (verifier
  // 2/11: lần tải lại bỏ phần đã tải, tải lại cả cửa sổ).
  const late = { pause: (rec) => { if (!rec.open && rec.vid === A && rec.b === END1 && rec.got > 0.85 * rec.size) rec.cap = 300000; return false; } };
  const lr = await openVideo({ feed: true, ms: 14000, env: { ...F10, ...late } });
  assert.equal(lr.e.fetches.filter((f) => f.vid === A && !f.open && f.b === END1).length, 1, 'gần xong mà vẫn tải lại: ' + lr.e.fetches.filter((f) => f.vid === A).map(lr.e.fmt).join(' | '));
  // Đường truyền chậm đều (mọi lượt cùng chậm): không thôi, không tải lại (lượt mới cũng chậm như vậy).
  const even = await openVideo({ feed: true, bw: 6e5, ms: 14000, env: F10 });
  assert.ok(even.e.fetches.filter((f) => f.vid === A && !f.open && f.b === END1).length <= 1, 'đường truyền chậm đều mà vẫn tải lại: ' + even.e.fetches.filter((f) => f.vid === A).map(even.e.fmt).join(' | '));
});

// Feed [B, A]: xem B `watchB` ms rồi lướt sang A (đã dịch sẵn đoạn 0). Trả ms từ lúc lướt tới khi đoạn 1 của A được gửi.
async function swipeAfter(watchB, env = {}, ms = 9000) {
  const B = '7500000000000000005';
  const e = makeEnv(EXT, { bw: 3e6, rtt: 150, realProbe: true, head: H, base: H, bps: BPS, autoReplyMs: 2600, ...F10, ...env });
  e.activeId = B; e.video(B, 0);
  e.up('items', [B, A].map((id) => e.item(id, 45000, true)));
  for (let t = 0; t < watchB; t += 50) await e.tick(50);
  e.videos.get(B).paused = true; e.activeId = A; e.video(A, 0);
  const t0 = e.perf;
  for (let t = 0; t < ms; t += 50) await e.tick(50);
  const s1 = e.subs().find((m) => m.key === A + ':1');
  return { e, s1: s1 ? s1.perf - t0 : null, t0 };
}
await t('Thử dịch sẵn 10 s: vừa xem hẳn video trước (≥ 8 s) thì đoạn 1 của video kế gửi sau 1,5 s, không chờ cửa 4 s; video trước chỉ lướt qua thì vẫn chờ', async () => {
  const watched = await swipeAfter(9000), swiped = await swipeAfter(3000);
  // 1,5 s chứ không 0: xem xong một video rồi lướt nhanh qua video kế thì khỏi gửi (verifier 2/11, G4).
  assert.ok(watched.s1 != null && watched.s1 >= 1500 && watched.s1 < 2200, 'xem video trước 9 s: đoạn 1 gửi sau ' + watched.s1 + ' ms');
  assert.ok(swiped.s1 != null && swiped.s1 >= 4000, 'xem video trước 3 s: đoạn 1 gửi sau ' + swiped.s1 + ' ms');
});

await t('Thử dịch sẵn 10 s: mọi lượt tải của video này qua máy chủ chậm (cả lượt dịch sẵn) trong khi video khác tải nhanh: vẫn thôi lượt chậm của đoạn 1, tải lại qua /aweme/v1/play/ (máy chủ khác), gửi kịp (chủ dự án dùng thử 2/11: hụt 6 s)', async () => {
  // Lượt tải đầu video (dịch sẵn) và lượt qua link CDN của A: 300 KB/s, tới khi một lượt qua /aweme/v1/play/ (không phải lượt
  // tải đầu video) được chuyển hướng sang máy chủ khác: từ đó nhanh, cả link CDN mới.
  let switched = false;
  const slowHost = { pause: (rec) => {
    if (rec.vid !== A) return false;
    if (/aweme\/v1\/play/.test(rec.url) && !rec.open && rec.got > 0) switched = true;
    if (!rec.capSet) { rec.capSet = true; if (rec.open || (/cdn\.example/.test(rec.url) && !switched)) rec.cap = 300000; }
    return false;
  } };
  const r = await swipeAfter(9000, slowHost, 9000);
  const own = r.e.fetches.filter((f) => f.vid === A && !f.open);
  const list = own.map((f) => f.url.slice(8, 30) + ' ' + r.e.fmt(f)).join(' | ');
  // Server giả trả lời sau 2,6 s: đoạn 1 phải gửi trước giây 7,4 kể từ lúc lướt tới để có sub ở giây 10.
  assert.ok(r.s1 != null && r.s1 <= 7000, 'đoạn 1 gửi sau ' + r.s1 + ' ms: ' + list);
  assert.ok(switched && own.some((f) => /aweme\/v1\/play/.test(f.url) && f.done), 'không tải lại qua /aweme/v1/play/: ' + list);
});

await t('Thử dịch sẵn 10 s: lướt tới video dịch sẵn mà đoạn 0 còn tải chậm: lần tải lại đoạn 0 không phải xếp sau đoạn 1 tải sớm, và đi qua /aweme/v1/play/ (verifier 2/11, G1)', async () => {
  // Lượt tải đầu video (dịch sẵn) và mọi lượt qua link CDN cho phần âm thanh đoạn 0 của A: 150 KB/s; qua /aweme/v1/play/: nhanh.
  const END0 = H + 12 * BPS - 1;
  const cap = { pause: (rec) => { if (rec.vid === A && !rec.capSet) { rec.capSet = true; if (rec.open || (!/aweme/.test(rec.url) && rec.b != null && rec.b <= END0)) rec.cap = 150000; } return false; } };
  const r = await swipeAfter(3000, cap, 9000);
  const s0 = r.e.subs().find((m) => m.key === A + ':0');
  const list = r.e.fetches.filter((f) => f.vid === A).map((f) => (/aweme/.test(f.url) ? 'api ' : 'cdn ') + r.e.fmt(f)).join(' | ');
  assert.ok(s0 && s0.perf - r.t0 <= 4000, 'đoạn 0 gửi sau ' + (s0 && s0.perf - r.t0) + ' ms: ' + list);
});

await t('Mặc định (chưa lưu cài đặt first10) là dịch sẵn 10 s đầu (0.2.37); first10: false chỉ là lựa chọn khi đã bấm ô (first10Set), không thì là giá trị popup 0.2.35–0.2.36 tự lưu (verifier 3/11, D1)', async () => {
  const plan = async (settings) => (await openVideo({ feed: true, ms: 3000, env: { settings } })).e.vid(A).plan;
  assert.equal(JSON.stringify(await plan({})), JSON.stringify([[0, 10], [10, 20], [20, 46]]));
  assert.equal(JSON.stringify(await plan({ first10: false, lyrics: true })), JSON.stringify([[0, 10], [10, 20], [20, 46]]), 'first10: false không có first10Set (popup cũ lưu cả object)');
  assert.equal(JSON.stringify(await plan({ first10: false, first10Set: true })), JSON.stringify([[0, 20], [20, 46]]), 'đã bỏ chọn ô');
});

await t('Dịch sẵn 10 s: tua sớm (cửa chờ chưa mở) tới gần cuối một đoạn: đoạn kế không phải chờ cửa, gửi không muộn hơn cách cũ (verifier 3/11, D3: trước đây muộn hơn 1,8–3,3 s)', async () => {
  const sentAt = async (settings) => {
    const e = makeEnv(EXT, { bw: 3e6, rtt: 150, realProbe: true, head: H, base: H, bps: BPS, autoReplyMs: 2600, settings });
    e.activeId = A; const v = e.video(A, 0);
    e.up('items', [e.item(A, 120000, true)]);
    for (let t = 0; t < 500; t += 50) await e.tick(50);
    v.currentTime = 46;   // tua lúc mới xem 0,5 s
    const t0 = e.perf;
    for (let t = 0; t < 9000; t += 50) await e.tick(50);
    const k = e.vid(A).plan.findIndex(([a]) => a === 50);
    const s = e.subs().find((m) => m.key === A + ':' + k);
    return { at: s ? s.perf - t0 : null, plan: JSON.stringify(e.vid(A).plan.slice(0, 3)), list: e.subs().map((m) => m.key.slice(17) + '@' + (m.perf - t0)).join(' ') };
  };
  const now = await sentAt({ first10: true }), old = await sentAt({ first10: false, first10Set: true });
  assert.ok(now.plan === '[[0,10],[10,20],[20,50]]' && old.plan === '[[0,20],[20,50],[50,80]]', 'lưới: ' + now.plan + ' | cũ: ' + old.plan);
  assert.ok(now.at != null && old.at != null && now.at <= old.at + 500, `đoạn [50,80) gửi sau ${now.at} ms (cách cũ ${old.at} ms): ${now.list} | cũ: ${old.list}`);
});

// ---- Dịch sẵn 10 s (mặc định từ 0.2.37; HANDOFF §6ad, việc D2): các ca ứng với những ca chỉ có nghĩa ở lưới cũ, và các ca riêng
// của chế độ này. Mọi ca dưới đây ghi rõ F10S (chưa lưu cài đặt) nên chạy chế độ 10 s ở cả hai lượt chạy.
// Lượt tải đầu video ("bytes=0-") của video đang xem chậm hẳn (bps byte/s) từ byte from (bố cục slowStart: 1000 byte mỗi giây
// phim tính từ byte 0, cửa sổ đoạn 0 [0,12) s là byte 0–11999); cont: cả lượt nối tiếp của đoạn 0 cũng chậm; more: khựng thêm.
const headCap = (bps, from = 0, { cont = false, more = () => false } = {}) => ({ pause: (rec, env) => {
  if (rec.a === 0 && rec.open && rec.got >= from) rec.cap = bps;
  if (cont && !rec.open && rec.b === 11999) rec.cap = bps;
  return more(rec, env);
} });
const keysAt = (e) => e.subs().map((m) => m.key.slice(16) + '@' + m.perf + '/' + m.payload.audioStart).join(' ');
const urlTag = (f) => (/aweme\/v1\/play/.test(f.url) ? 'api ' : 'cdn ') + (f.open ? 'đầu ' : '');

await t('Dịch sẵn 10 s (ứng với hai ca "đoạn đầu tải chậm (~25 s)" và "tải nhanh 1/4 rồi chậm hẳn"): lượt tải đầu video chậm hẳn (560 B/s) từ 1/4 hay 1/2 cửa sổ đoạn 0: thôi lượt đó, tải nối tiếp phần còn thiếu, đoạn 0 vẫn gửi, có sub sớm, không mẩu nhanh; tải nhanh thì mỗi đoạn một lượt', async () => {
  // Lưới cũ: đoạn [0,20) chậm thì bị bỏ (dropSlow), mẩu nhanh nối tiếp phủ chỗ đang xem. Đoạn 0 ở đây chỉ 10 s (≤ QUICK_MIN_CHUNK:
  // không có dropSlow, mẩu nhanh); headLate xét chính đoạn 0 khi nó chờ trên lượt tải đầu video (HANDOFF §6ab, verifier F2): chờ
  // tổng cộng quá HEAD_SLOW thì thôi lượt đó, lượt nối tiếp (link CDN) chỉ tải phần còn thiếu. Đo: đoạn 0 gửi lúc 2,7–2,75 s, sub
  // đầu ở giây 4,5, có sub suốt [10,30) (cách cũ ở cùng máy chủ chậm: sub đầu < 16 s nhờ mẩu nhanh).
  for (const from of [3000, 6000]) {
    const r = await slowStart(() => 0, { ...headCap(560, from), settings: F10S });
    const tag = '560 B/s từ byte ' + from + ': ', list = r.e.media().map((f) => urlTag(f) + r.e.fmt(f)).join(' | ');
    const s0 = r.e.subs().find((m) => m.key === A + ':0');
    assert.ok(s0 && s0.perf <= 3000, tag + 'đoạn 0 gửi lúc ' + (s0 && s0.perf) + ': ' + keysAt(r.e));
    const head = r.e.media().find((f) => f.open), cont = r.e.media().filter((f) => !f.open && f.b === 11999);
    assert.ok(head.aborted && cont.length === 1 && cont[0].a === Math.floor(head.got) && /cdn\.example/.test(cont[0].url), tag + 'lượt nối tiếp: ' + list);
    assert.deepEqual(r.quick, [], tag + 'mẩu nhanh');
    assert.ok(r.first != null && r.first <= 5, tag + 'sub đầu ở giây ' + r.first);
    assert.ok(r.gap === 0 && r.cov >= 19.75, tag + 'có sub ' + r.cov + ' s trên 20 s của [10,30), hụt ' + r.gap + ' s');
    assert.equal(r.e.subs().find((m) => m.key === A + ':1').payload.audioStart, 5.5, tag + 'đoạn [10,20) gửi dư 4,5 s (đoạn 0 đã gửi)');
  }
  // Tải nhanh: lượt đầu video (mục lục + đoạn 0), [10,20) tải nối tiếp đúng từ byte lượt đó đã nhận, rồi [20,50), [50,80); như cách
  // cũ, mạng nhanh thì chỉ dịch trước 30 s (không tải [80,88)).
  const f = await slowStart(() => 0, { settings: F10S });
  assert.deepEqual(f.quick, []);
  const fh = f.e.media().find((x) => x.open);
  assert.deepEqual(f.e.media().map((x) => x.a), [0, Math.floor(fh.got), 18500, 48500], f.e.media().map(f.e.fmt).join(' | '));
});

await t('Dịch sẵn 10 s (ứng với ca "đoạn đầu tải chậm vừa phải"): lượt tải đầu video 2000–2200 B/s từ 1/4 cửa sổ đoạn 0: vẫn kịp nên không thôi lượt đó, đoạn 0 lấy trọn từ lượt đó, có sub trước giây 10, không mẩu nhanh', async () => {
  // 9000 byte còn lại ở 2000 B/s là 4,5 s: đoạn 0 chờ tổng cộng ~5,5 s < HEAD_SLOW (6 s). Đo: đoạn 0 gửi 5,3 / 4,9 s, sub đầu
  // giây 7,25 / 6,75.
  for (const bps of [2000, 2200]) {
    const r = await slowStart(() => 0, { ...headCap(bps, 3000), settings: F10S });
    const tag = bps + ' B/s: ';
    assert.ok(r.e.subs().some((m) => m.key === A + ':0'), tag + 'đoạn 0 phải được gửi: ' + keysAt(r.e));
    assert.deepEqual(r.e.media().filter((f) => !f.open && f.b === 11999).map(r.e.fmt), [], tag + 'thôi lượt tải đầu video');
    assert.deepEqual(r.quick, [], tag + 'mẩu nhanh');
    assert.ok(r.first != null && r.first < 10, tag + 'sub đầu ở giây ' + r.first);
    assert.equal(r.e.subs().find((m) => m.key === A + ':1').payload.audioStart, 5.5, tag + 'đoạn [10,20) gửi dư 4,5 s');
  }
});

await t('Dịch sẵn 10 s (ứng với ca "đoạn đầu tải được 3/4 thì khựng 2,5 s"): khựng ở 3/4 cửa sổ đoạn 0 (máy chủ 3000 B/s): đoạn 0 vẫn gửi, chỉ phần còn thiếu tải qua lượt mới, không byte nào tải hai lần, không mẩu nhanh', async () => {
  // Đoạn 0 đang chờ trên lượt tải đầu video nên headLate xét nó: khựng quá 1 s (tốc độ 1 s gần nhất bằng 0) thì thôi lượt đó, lượt
  // nối tiếp lấy phần còn thiếu (thêm một rtt), thay vì chờ lượt đó chạy tiếp như đoạn [0,20) ở lưới cũ. Đo: đoạn 0 gửi 5,7 s,
  // sub đầu giây 7,5; mục lục + đoạn 0 + [10,20) đúng 26000 byte.
  let p0 = null;
  const more = (rec, env) => { if (!(rec.a === 0 && rec.open)) return false; if (p0 == null && rec.got >= 9000) p0 = env.perf; return p0 != null && env.perf < p0 + 2500; };
  const r = await slowStart(() => 0, { ...headCap(3000, 3000, { more }), settings: F10S });
  assert.ok(p0 != null && r.e.subs().some((m) => m.key === A + ':0'), 'đoạn 0 phải được gửi: ' + keysAt(r.e));
  assert.deepEqual(r.quick, []);
  const used = r.e.media().filter((f) => f.open || f.b <= 25999);
  const bytes = used.reduce((s, f) => s + Math.floor(f.got), 0);
  assert.ok(bytes <= 26000 + 150, 'tải ' + bytes + ' byte cho [0,26) s: ' + used.map(r.e.fmt).join(' | '));
  assert.ok(r.first != null && r.first <= 7.5, 'sub đầu ở giây ' + r.first);
  assert.equal(r.e.subs().find((m) => m.key === A + ':1').payload.audioStart, 5.5);
});

await t('Dịch sẵn 10 s (ứng với ca "đoạn đầu của video kế tải chậm ở hàng dịch sẵn"): lượt tải đầu video của B chậm hẳn (560 B/s) từ 1/4 hay 1/2 cửa sổ đoạn 0 lúc dịch sẵn, lướt tới ở giây 4: lúc dịch sẵn không thôi, lướt tới thì thôi ngay, đoạn 0 gửi trong 1,5 s, có sub sớm', async () => {
  // headLate chỉ xét đoạn 0 của video đang xem (dịch sẵn chậm không làm gì). Đo: đoạn 0 của B gửi 1,15 / 0,9 s sau khi lướt tới,
  // sub đầu giây 5,25 / 5.
  const B = '7500000000000000005';
  for (const from of [3000, 6000]) {
    const e = makeEnv(EXT, { settings: F10S, pause: (rec) => { if (rec.vid === B && rec.a === 0 && rec.open && rec.got >= from) rec.cap = 560; return false; } });
    e.up('items', [e.item(A, 60000), e.item(B, 87100)]);
    e.activeId = A; e.video(A, 0);
    let first = null, swipe = null;
    for (let ms = 0; ms < 34000; ms += 250) {
      if (ms === 4000) { e.videos.get(A).paused = true; e.activeId = B; e.video(B, 0); swipe = e.perf; }
      await e.tick(250);
      for (const m of e.subs()) {
        if (!e.replies.has(m.key) || e.perf - m.perf < 4000) continue;
        const p = m.payload;
        await e.reply(m.key, { status: 'ok', sung: 0, cues: [{ start: p.from, end: p.to, se: p.to, vi: 'x' }] });
      }
      if (ms < 4000) continue;
      const cv = e.vid(B), ph = e.dbg.playhead;
      if (cv && cv.plan && okAt(cv, ph) && first == null) first = ph;
    }
    const tag = 'từ byte ' + from + ': ', own = e.fetches.filter((f) => f.vid === B), list = own.map((f) => urlTag(f) + e.fmt(f)).join(' | ');
    const head = own.find((f) => f.open), s0 = e.subs().find((m) => m.key === B + ':0');
    assert.ok(head && head.end >= swipe, tag + 'thôi lượt tải dịch sẵn trước khi lướt tới: ' + list);
    assert.ok(s0 && s0.perf - swipe <= 1500, tag + 'đoạn 0 của B gửi ' + (s0 && s0.perf - swipe) + ' ms sau khi lướt tới: ' + list);
    assert.ok(own.some((f) => !f.open && f.b === 11999 && f.a === Math.floor(head.got)), tag + 'lượt nối tiếp: ' + list);
    assert.ok(first != null && first <= 5.5, tag + 'sub đầu của B ở giây ' + first);
    assert.equal(e.subs().find((m) => m.key === B + ':1').payload.audioStart, 5.5, tag + 'đoạn [10,20) của B gửi dư 4,5 s');
    assert.ok(!e.subs().some((m) => m.key.includes(':q')), tag + 'mẩu nhanh: ' + keysAt(e));
  }
});

await t('Dịch sẵn 10 s (ứng với ca "lượt tải đầu video chậm hẳn ngay từ byte 0"): 1040 / 560 B/s từ byte 0: thôi lượt đó, đoạn 0 tải nối tiếp qua link CDN (tiến độ theo phần phải tải), sub đầu trước giây 5, có sub suốt [10,30), không tải song song', async () => {
  // Đo: sub đầu giây 4,75, có sub 20 s trên 20 s của [10,30) (cách cũ: q0 nối tiếp, sub đầu ≤ 13 s).
  for (const bps of [1040, 560]) {
    const bytes = new Set();
    const watch = (e) => {
      const c = e.vid(A) && e.vid(A).chunks.get(0), f = e.media().find((x) => !x.open && x.a > 0 && x.b === 11999 && !x.done && !x.aborted);
      if (c && c.status === 'pending' && f) bytes.add(c.bytes + '/' + (12000 - f.a));
    };
    const r = await slowStart(() => 0, { ...headCap(bps, 0), watch, settings: F10S });
    const tag = bps + ' B/s: ', list = r.e.media().map((f) => urlTag(f) + r.e.fmt(f)).join(' | ');
    assert.ok(bytes.size && [...bytes].every((x) => x.split('/')[0] === x.split('/')[1]), tag + 'prog.bytes/phần phải tải: ' + [...bytes]);
    assert.ok(r.first != null && r.first <= 5, tag + 'sub đầu ở giây ' + r.first + ', ' + keysAt(r.e));
    assert.ok(r.cov >= 19.75, tag + 'có sub ' + r.cov + ' s trên 20 s của [10,30)');
    const c0 = r.e.media().find((f) => !f.open && f.a > 0 && f.b === 11999);
    assert.ok(c0 && /cdn\.example/.test(c0.url), tag + 'đoạn 0 tải nối tiếp: ' + list);
    assert.deepEqual(overlaps(r.e.media().filter((f) => f.open || f.b <= 25999)).map(r.e.fmt), [], tag + 'tải song song');
    assert.deepEqual(r.quick, [], tag + 'mẩu nhanh');
  }
  // Cả lượt nối tiếp của đoạn 0 cũng chậm (cùng máy chủ), video đầu tiên nên chưa có lượt tải xong nào để so (restartSlow không có
  // mốc), đoạn 0 ngắn nên không có dropSlow, mẩu nhanh: không có gì cứu đoạn 0. Chỉ kiểm không lượt tải song song, không mẩu nhanh.
  // Đo (bản này): sub đầu giây 15,5 / 17; 1040 B/s: đoạn 0 gửi lúc 12,05 s (chỗ đang xem 9,8: kết quả về khi đã qua đoạn đó).
  for (const bps of [1040, 560]) {
    const r = await slowStart(() => 0, { ...headCap(bps, 0, { cont: true }), settings: F10S });
    assert.deepEqual(overlaps(r.e.media().filter((f) => f.open || f.b <= 25999)).map(r.e.fmt), [], bps + ' B/s (cả lượt nối tiếp): tải song song');
    assert.deepEqual(r.quick, [], bps + ' B/s (cả lượt nối tiếp): mẩu nhanh');
  }
});

await t('Dịch sẵn 10 s (ứng với ca "tua tới gần cuối đoạn 0 lúc đang tải đầu video"): tua tới giây 16 ([10,20)) lúc lượt tải đầu video còn chạy: đoạn đó dùng lại phần lượt đó đã nhận, không byte nào tải hai lần, không mẩu nhanh, không lượt song song, gửi trong 2,9 s', async () => {
  // Cách cũ: q17 đọc tiếp chính lượt tải đầu video (runQuick kéo dài h.end), một lượt, gửi lúc 2800 ms. Ở đây [10,20) ≤ 16 s nên
  // không có mẩu nhanh; chính đoạn đó (gửi dư 8 s vì đoạn 0 chưa dịch: cửa sổ [2,26) s) thay vai q17. Tua lúc 0,7 s (lượt đầu đã có
  // ~4 s âm thanh) và 0,5 s (~1,6 s âm thanh, chưa tới đầu cửa sổ). Bản 0.2.38: ngắt lượt đầu, bỏ phần đã nhận rồi tải lại, thừa
  // 1,26 / 0,36 MB, gửi 3100 / 2800 ms. Đọc tiếp lượt đầu (headKeep) đã thử và bỏ: lượt đầu bị máy chủ cho chậm riêng thì đoạn
  // đó chờ lượt chậm (ca kế, §6ae B3). Nay ngắt như cũ nhưng giữ phần đã nhận (headReuse), đoạn đó chỉ tải phần còn thiếu bằng
  // lượt mới. Đo: gửi lúc 2700 / 2700 ms, không thừa; [20,46) lúc 5050 ms thay vì 6050 (dùng lại đuôi của [10,20)). Phần giữ lại
  // bỏ ngay sau khi [10,20) gửi (một bước 50 ms), hay khi lướt đi.
  for (const at of [700, 500]) {
    let sent1 = null, gone = null;
    const r = await openVideo({ feed: true, ms: 6000, env: { settings: F10S }, during: (e, t) => {
      if (t === at) e.videos.get(A).currentTime = 16;
      if (sent1 == null && e.subs().some((m) => m.key === A + ':1')) sent1 = e.perf;
      if (sent1 != null && gone == null && !e.vid(A).head) gone = e.perf;
    } });
    const tag = 'tua lúc ' + at + ' ms: ', list = r.own.map((f) => urlTag(f) + r.e.fmt(f)).join(' | ');
    const c2 = r.e.subs().find((m) => m.key === A + ':2');
    assert.ok(c2, tag + 'đoạn [20,46) chưa gửi: ' + keysAt(r.e));
    assert.equal(c2.payload.audioStart, 18.5, tag + 'đoạn [20,46) gửi dư 1,5 s');
    assert.equal(c2.payload.aacSum, sumOf(H + 18.5 * BPS, H + 52 * BPS), tag + 'âm thanh đoạn [20,46) (ghép từ đuôi của [10,20)) cắt sai');
    assert.ok(r.own.some((f) => !f.open && f.a === W0), tag + 'đoạn [20,46) không tải tiếp từ cuối [10,20): ' + list);
    assert.ok(gone != null && gone - sent1 <= 300, tag + 'phần lượt đầu vẫn giữ sau khi [10,20) gửi (' + sent1 + ' → ' + gone + ')');
    const c = r.e.subs().find((m) => m.key === A + ':1');
    assert.ok(c, tag + 'đoạn [10,20) chưa gửi: ' + keysAt(r.e));
    assert.ok(!r.e.subs().some((m) => m.key.includes(':q')), tag + 'mẩu nhanh: ' + keysAt(r.e));
    assert.equal(c.payload.audioStart, 2, tag + 'đoạn [10,20) gửi dư 8 s (PRE_SEEK)');
    assert.equal(c.payload.aacSum, sumOf(H + 2 * BPS, W0), tag + 'âm thanh đoạn [10,20) cắt sai');
    assert.deepEqual(overlaps(r.own).map(r.e.fmt), [], tag + 'tải song song');
    const bytes = r.own.filter((f) => f.open || f.b <= W0 - 1).reduce((s, f) => s + Math.floor(f.got), 0);
    assert.ok(bytes <= W0 + 150000, tag + 'tải ' + bytes + ' byte cho [0,26) s (cần ≤ ' + (W0 + 150000) + '): ' + list);
    assert.ok(c.perf <= 2900, tag + 'đoạn [10,20) gửi lúc ' + c.perf + ': ' + list);
  }
});

await t('Dịch sẵn 10 s: tua tới giây 16 lúc lượt tải đầu video còn chạy rồi lướt đi trước khi [10,20) tải xong: bỏ phần lượt đầu đã giữ (headReuse) trong 300 ms', async () => {
  // Phần giữ lại chỉ để [10,20) của video đang xem dùng; lướt đi thì đoạn đó hết cần, headCheck (mỗi lượt schedule) bỏ nó.
  const B2 = '7500000000000000005';
  let kept = false, gone = null;
  const r = await openVideo({ feed: true, ids: [A, B2], ms: 4000, env: { settings: F10S }, during: (e, t) => {
    if (t === 700) e.videos.get(A).currentTime = 16;
    if (t === 1650) kept = !!e.vid(A).head && e.vid(A).head.closed;
    if (t === 1700) { e.videos.get(A).paused = true; e.activeId = B2; e.video(B2, 0); }
    if (t >= 1700 && gone == null && !e.vid(A).head) gone = t;
  } });
  assert.ok(kept, 'lúc 1650 ms không có phần lượt đầu nào được giữ (đã ngắt): ' + r.own.map(r.e.fmt).join(' | '));
  assert.ok(gone != null && gone - 1700 <= 300, 'phần lượt đầu vẫn giữ sau khi lướt đi (bỏ lúc ' + gone + ')');
});

await t('Dịch sẵn 10 s: lượt tải đầu video bị máy chủ cho chậm riêng (1 / 1,5 MB/s, đường truyền 3 MB/s), tua vào [10,20) lúc nó còn chạy: đoạn đó không chờ lượt chậm, [10,20) và [20,46) gửi không muộn hơn bản 0.2.38, sub không ít hơn', async () => {
  // Kịch bản của verifier (R1, §6ae): video 45 s, tua tới giây 12 hay 16 lúc 0,7 / 1,5 s. Bản 0.2.38 (ngắt lượt đầu, tải lại cả
  // cửa sổ bằng lượt mới, nhanh): [10,20) gửi lúc T + 2400, [20,46) lúc T + 5350 ms; trong 14 s sau khi tua có sub 9,05–9,25 s (tua
  // tới 12) và 6,1–6,3 s (tua tới 16). Đọc tiếp lượt đầu (headKeep) thì 2,3–3,8 s (1 MB/s), 4,45–7,4 s (1,5 MB/s). Giữ phần
  // đã nhận (headReuse): [10,20) gửi sớm hơn 0–400 ms, [20,46) sớm hơn 50–1000 ms, sub 9,05–9,65 / 6,7–7,3 s.
  for (const cap of [1000000, 1500000]) for (const T of [700, 1500]) for (const S of [12, 16]) {
    const e = makeEnv(EXT, { bw: 3e6, rtt: 150, realProbe: true, head: H, base: H, bps: BPS, autoReplyMs: 2600, settings: F10S,
      cap: (a, b) => (b == null ? cap : 0) });
    e.activeId = A; const v = e.video(A, 0);
    let cov = 0, seekAt = null;
    for (let t = 0; t < T + 14000; t += 50) {
      if (t === 0) e.up('items', [e.item(A, 45000, true)]);
      if (t === T) { v.currentTime = S; seekAt = e.perf; }
      await e.tick(50);
      if (seekAt == null) continue;
      const cv = e.vid(A), ph = e.dbg.playhead, k = cv.plan ? chunkAtOf(cv.plan, ph) : -1;
      if (k >= 0 && (cv.chunks.get(k) || {}).status === 'ok') cov += 50;
    }
    const tag = cap / 1e6 + ' MB/s, tua tới ' + S + ' lúc ' + T + ' ms: ', at = (k) => { const m = e.subs().find((x) => x.key === A + ':' + k); return m ? m.perf : null; };
    const list = e.fetches.filter((f) => f.vid === A).map((f) => urlTag(f) + e.fmt(f)).join(' | ');
    assert.equal(JSON.stringify(e.vid(A).plan.slice(0, 3)), '[[0,10],[10,20],[20,46]]', tag + 'lưới');
    assert.ok(at(1) != null && at(1) <= T + 2500, tag + 'đoạn [10,20) gửi lúc ' + at(1) + ': ' + list);
    assert.ok(at(2) != null && at(2) <= T + 5450, tag + 'đoạn [20,46) gửi lúc ' + at(2) + ': ' + list);
    assert.ok(cov >= (S === 12 ? 8900 : 5950), tag + 'chỉ có sub ' + cov + ' ms trong 14 s sau khi tua: ' + list);
  }
});

await t('Dịch sẵn 10 s: tua vào đoạn 30 s (sau [20,50)) thì có mẩu nhanh như cách cũ: gửi trong 3 s, đoạn ở chỗ tua gửi dư 8 s, trước đoạn kế, không mất sub; tua vào [10,20) thì không có mẩu nhanh, chính đoạn đó gửi ngay', async () => {
  // Lưới 10 s: [0,10) [10,20) rồi các đoạn 30 s từ giây 20 (ranh giới như lưới cũ từ giây 20): đoạn 30 s > QUICK_MIN_CHUNK nên
  // maybeQuick chạy như cũ. Tua lúc mới xem 2 s (cửa chờ chưa mở) hay đã xem 20 s. Đo: mẩu nhanh 2,6 s, đoạn ở chỗ tua 7,5 s, đoạn
  // kế 11,7 s, sub đầu 5,75 s, hụt sau đó 0,25–0,5 s; tua tới giây 15: đoạn [10,20) gửi sau 1,1 s.
  for (const [at, to, k] of [[2000, 35, 2], [2000, 125, 5], [20000, 305, 11]]) {
    const e = makeEnv(EXT, { bw: 9000, autoReplyMs: 3000, settings: F10S });
    e.up('items', [e.item(A, 600000)]);
    e.activeId = A; const v = e.video(A, 0);
    await e.tick(at);
    const seekAt = e.perf, n0 = e.subs().length;
    v.currentTime = to;
    let first = null, gap = 0;
    for (let i = 0; i < 100; i++) {
      await e.tick(250);
      const cv = e.vid(A), ph = e.dbg.playhead;
      const ok = okAt(cv, ph);
      if (ok && first == null) first = e.perf - seekAt;
      if (!ok && first != null) gap += 250;
    }
    const tag = 'tua lúc ' + at + ' ms tới giây ' + to + ': ', after = e.subs().slice(n0);
    const sentAt = (key) => { const m = after.find((x) => x.key === A + ':' + key); return m ? m.perf - seekAt : null; };
    assert.equal(chunkAtOf(e.vid(A).plan, to), k, tag + 'lưới');
    assert.ok(sentAt('q' + to) != null && sentAt('q' + to) <= 3000, tag + 'mẩu nhanh gửi sau ' + sentAt('q' + to) + ' ms');
    assert.ok(sentAt(k) != null && sentAt(k) < sentAt(k + 1), tag + 'thứ tự gửi: ' + keysAt(e));
    assert.equal(after.find((x) => x.key === A + ':' + k).payload.audioStart, e.vid(A).plan[k][0] - 8, tag + 'đoạn ở chỗ tua gửi dư 8 s (PRE_SEEK)');
    assert.ok(first != null && first <= 6000 && gap <= 1000, tag + 'sub đầu sau ' + first + ' ms, sau đó hụt ' + gap + ' ms');
  }
  const e = makeEnv(EXT, { bw: 9000, autoReplyMs: 3000, settings: F10S });
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const v = e.video(A, 0);
  await e.tick(2000);
  const seekAt = e.perf, n0 = e.subs().length;
  v.currentTime = 15;
  for (let i = 0; i < 20; i++) await e.tick(250);
  const after = e.subs().slice(n0), s1 = after.find((m) => m.key === A + ':1');
  assert.ok(!after.some((m) => m.key.includes(':q')), 'tua tới giây 15: mẩu nhanh: ' + keysAt(e));
  assert.ok(s1 && s1.perf - seekAt <= 1500 && s1.payload.audioStart === 5.5, 'tua tới giây 15: đoạn [10,20) ' + keysAt(e));
});

await t('Dịch sẵn 10 s, chế độ video dài (đã xem ≥ 10 s): đường truyền chậm thì dịch trước 60 s, hàng dịch sẵn không bắt đầu lượt mới khi video đang xem còn đoạn chưa tải (currentBehind); mạng nhanh thì vẫn 30 s; chưa xem đủ 10 s thì 30 s', async () => {
  // aheadFor: một đoạn 30 s (37,5 s âm thanh, 1000 byte mỗi giây phim) ước tải quá SLOW_CHUNK_MS theo lượt tải xong gần nhất thì
  // LOOKAHEAD_LONG. 3000 B/s: chậm (lượt [10,20) chia đường truyền với dịch sẵn); 60000 B/s: không. Đo: ở giây 25 đoạn xa nhất
  // đang cần bắt đầu ở giây 80 (3000 B/s) và 50 (60000 B/s); trước 10 s cả hai là 20.
  const F = ['7500000000000000051', '7500000000000000052', '7500000000000000053', '7500000000000000054'];
  for (const [bw, slow, far] of [[3000, true, 80], [60000, false, 50]]) {
    const e = makeEnv(EXT, { bw, autoReplyMs: 6000, settings: F10S });
    e.up('items', [e.item(A, 600000), ...F.map((id) => e.item(id, 120000))]);
    e.activeId = A; e.video(A, 0);
    let early = null, at25 = null, slowEarly = null;
    const farthest = () => { const cv = e.vid(A); return Math.max(...[...e.dbg.wanted].filter((x) => x.startsWith(A)).map((x) => cv.plan[+x.slice(20)][0])); };
    for (let i = 0; i < 400; i++) {
      await e.tick(250);
      if (e.perf === 9500) { early = farthest(); slowEarly = !!e.vid(A).slow; }
      if (e.perf === 25000) at25 = farthest();
    }
    // Lượt dịch sẵn bắt đầu (sau 10,5 s) đúng lúc video đang xem có lượt tải đang chạy, xét theo giờ bắt đầu thật của từng lượt (không
    // chỉ các lượt bắt đầu đúng nhịp 250 ms). Bỏ currentBehind (bản sao content.js): 3000 B/s có hai lượt như vậy lúc 14,6 s.
    const clash = e.fetches.filter((g) => g.vid !== A && g.vid !== 'x' && g.start > 10500 && !g.preAborted
      && e.fetches.some((f) => f.vid === A && !f.preAborted && f.start <= g.start && (f.end == null || f.end > g.start)));
    const tag = bw + ' B/s: ';
    assert.equal(JSON.stringify(e.vid(A).plan.slice(0, 3)), '[[0,10],[10,20],[20,50]]', tag + 'lưới dịch sẵn 10 s');
    assert.ok(early === 20 && !slowEarly, tag + 'trước 10 s: đoạn xa nhất ở giây ' + early + (slowEarly ? ', đã coi là chậm' : ''));
    assert.equal(!!e.vid(A).slow, slow, tag + 'đoạn 30 s tải chậm');
    assert.equal(at25, far, tag + 'ở giây 25: đoạn xa nhất đang cần bắt đầu ở giây ' + at25);
    assert.deepEqual(clash.map((g) => g.vid.slice(-2) + '@' + g.start), [], tag + 'lượt dịch sẵn bắt đầu giữa lúc video đang xem đang tải');
  }
});

await t('Dịch sẵn 10 s: HTTP 429 khi đoạn [10,20) đã tải xong, đang chờ cửa: vẫn gửi đúng lúc qua cửa (gửi không phải tải), mọi lượt tải mới nghỉ 5 s; 429 ở chính lượt tải đoạn đó: hết nghỉ thì tải lại trước tiên và gửi ngay (đã qua cửa)', async () => {
  const B = '7500000000000000005';
  // (a) Lượt tải đầu video của B (dịch sẵn) bị 429 lúc 1,7 s; đoạn [10,20) của A tải 1,7–2,85 s rồi chờ cửa 4 s. Đo: gửi 4250 ms,
  // hết nghỉ lúc 6700 ms.
  let blocked = false, held = false;
  const r = await openVideo({ feed: true, ids: [A, B], ms: 9000, env: { settings: F10S, status: (a, b, url) => (b == null && url.includes(B) && !blocked ? (blocked = true, 429) : 206) },
    during: (e) => { const c = e.vid(A) && e.vid(A).chunks.get(1); if (c && c.waiting && !c.sent) held = true; } });
  const b429 = r.e.fetches.find((f) => f.vid === B && f.status === 429), s1 = r.e.subs().find((m) => m.key === A + ':1');
  assert.ok(b429 && held, '(a) kịch bản: ' + r.e.fetches.map((f) => f.vid.slice(-1) + ' ' + r.e.fmt(f)).join(' | '));
  assert.ok(s1 && s1.perf >= 4000 && s1.perf < b429.start + 5000, '(a) đoạn [10,20) gửi lúc ' + (s1 && s1.perf) + ', 429 lúc ' + b429.start);
  const later = r.e.fetches.filter((f) => f.start > b429.start);
  assert.ok(later.length && later.every((f) => f.start - b429.start >= 5000), '(a) lượt tải mới sau 429: ' + later.map((f) => f.vid.slice(-1) + '@' + (f.start - b429.start)).join(' '));
  // (b) Lượt tải đoạn [10,20) của A bị 429 (lúc 1,7 s). Đo: tải lại lúc 7,1 s (lượt đầu tiên sau lúc nghỉ), gửi ngay khi xong (8,85 s).
  let blocked2 = false;
  const r2 = await openVideo({ feed: true, ids: [A, B], ms: 14000, env: { settings: F10S, status: (a, b) => (b === W0 - 1 && !blocked2 ? (blocked2 = true, 429) : 206) } });
  const f429 = r2.e.fetches.find((f) => f.status === 429), list = r2.e.fetches.map((f) => f.vid.slice(-1) + ' ' + r2.e.fmt(f)).join(' | ');
  assert.ok(f429 && f429.vid === A, '(b) kịch bản: ' + list);
  const during = r2.e.fetches.filter((f) => f.start > f429.start && f.start - f429.start < 5000);
  assert.deepEqual(during.map(r2.e.fmt), [], '(b) gọi trong lúc nghỉ sau 429');
  const again = r2.e.fetches.filter((f) => f.vid === A && f.b === W0 - 1 && f.start > f429.start);
  const firstAfter = r2.e.fetches.filter((f) => f.start > f429.start).sort((x, y) => x.start - y.start)[0];
  assert.ok(again.length === 1 && again[0] === firstAfter && again[0].start - f429.start <= 5600, '(b) tải lại: ' + list);
  const s1b = r2.e.subs().find((m) => m.key === A + ':1');
  assert.ok(s1b && again[0].end != null && s1b.perf - again[0].end <= 300, '(b) đoạn [10,20) gửi lúc ' + (s1b && s1b.perf) + ', tải xong lúc ' + again[0].end);
  assert.equal(s1b.payload.aacSum, sumOf(H + 5.5 * BPS, W0), '(b) âm thanh đoạn [10,20)');
});

await t('Dịch sẵn 10 s: lượt tải sớm của đoạn [10,20) gặp CDN treo (không byte nào): 6 s sau gọi lại ngay qua /aweme/v1/play/ đúng khoảng byte đó, gửi ngay khi xong (đã qua cửa), âm thanh đủ; hàng dịch sẵn không phải chờ', async () => {
  // rangeFetch cắt lượt im quá 6 s rồi fetchBytes gọi /aweme/v1/play/ (có thể sang máy chủ khác) trong cùng lần làm, không chờ
  // DL_RETRY_CUR. Đo: treo 1,7–7,7 s, gọi lại 8,0 s (2 rtt), gửi 9,15 s.
  const B = '7500000000000000005';
  let k = 0;
  const r = await openVideo({ feed: true, ids: [A, B], ms: 12000, env: { settings: F10S, stall: (a, b) => (b === W0 - 1 && k++ === 0 ? 60000 : 0) } });
  const f1 = r.e.fetches.filter((f) => f.vid === A && f.b === W0 - 1), list = f1.map((f) => urlTag(f) + r.e.fmt(f)).join(' | ');
  assert.ok(f1.length === 2 && f1[0].aborted && f1[0].got === 0 && f1[0].end - f1[0].start >= 6000 && f1[0].end - f1[0].start <= 6100, 'lượt treo: ' + list);
  assert.ok(/aweme\/v1\/play/.test(f1[1].url) && f1[1].a === f1[0].a && f1[1].start - f1[0].end <= 400, 'gọi lại: ' + list);
  const s1 = r.e.subs().find((m) => m.key === A + ':1');
  assert.ok(s1 && f1[1].end != null && s1.perf - f1[1].end <= 100, 'đoạn [10,20) gửi lúc ' + (s1 && s1.perf) + ': ' + list);
  assert.equal(s1.payload.aacSum, sumOf(H + 5.5 * BPS, W0), 'âm thanh đoạn [10,20)');
  const b0 = r.e.subs().find((m) => m.key === B + ':0');
  assert.ok(b0 && b0.perf < f1[0].end, 'dịch sẵn B chờ theo lượt treo: ' + keysAt(r.e));
});

await t('Dịch sẵn 10 s: đoạn [10,20) tải lỗi cả hai đường (CDN treo, /aweme/v1/play/ 503) khi cửa đã mở: thử lại sau 1 s (DL_RETRY_CUR), đoạn kế [20,46) (chưa gấp) không được chiếm hàng tải của video đang xem trước nó', async () => {
  // Lỗi tải của video đang xem thì thử lại sau DL_RETRY_CUR (fastRetry). Ở chế độ 10 s, đoạn kế [20,46) (video 45 s) đã cần từ lúc
  // qua cửa (dịch trước 30 s), chưa gấp (chỗ đang xem < 10), mà holdBack chỉ giữ chỗ cho đoạn gấp đang tải hay chưa có mục nào, không
  // cho đoạn gấp đang chờ thử lại: đoạn kế (cửa sổ [12,52) s vì [10,20) lỗi, 10 MB) lấy hàng tải trước. Đo (bản này): lỗi lúc 8,0 s, gọi lại 11,65 s, gửi 13,4 s (hụt sub ~6 s sau
  // giây 10); bản sao content.js có holdBack giữ chỗ cho đoạn đó: gọi lại 9,2 s, gửi 10,95 s.
  const B = '7500000000000000005';
  let n1 = 0, cur = -1;
  const r = await openVideo({ feed: true, ids: [A, B], ms: 16000, env: { settings: F10S,
    stall: (a, b) => { if (b !== W0 - 1) return 0; cur = n1++; return cur === 0 ? 60000 : 0; },
    status: (a, b) => (b === W0 - 1 && cur === 1 ? 503 : 206) } });
  const f1 = r.e.fetches.filter((f) => f.vid === A && f.b === W0 - 1), list = r.own.map((f) => urlTag(f) + r.e.fmt(f)).join(' | ');
  assert.ok(f1.length >= 3 && f1[1].status === 503, 'kịch bản: ' + list);
  const failAt = f1[1].end, retry = f1[2];
  const c2 = r.e.fetches.find((f) => f.vid === A && f.b === H + 52 * BPS - 1);
  assert.ok(!c2 || c2.start >= retry.start, 'đoạn [20,46) tải trước lần thử lại của [10,20): ' + list);
  assert.ok(retry.start - failAt <= 1500, 'thử lại sau ' + (retry.start - failAt) + ' ms: ' + list);
  const s1 = r.e.subs().find((m) => m.key === A + ':1');
  assert.ok(s1 && s1.perf <= 11500, 'đoạn [10,20) gửi lúc ' + (s1 && s1.perf) + ': ' + keysAt(r.e));
});

await t('Dịch sẵn 10 s: mục lục nhỏ giọt (150 KB, 20 KB/s) khi có video khác tải nhanh: gọi lại một lần, sub đầu như cách cũ; không có bằng chứng chậm riêng thì không gọi lại', async () => {
  // Bố cục như file thật (âm thanh sau mục lục: base = 150000). Cách cũ cùng bố cục, đo: 6000 / 22000 / 11250 ms; chế độ 10 s: 6000 /
  // 21750 / 11250 ms (đoạn 0 là [0,12) s âm thanh).
  const b = await slowMoov(EXT, { base: 150000, settings: F10S });
  assert.ok(b.first != null && b.first <= 6000 && b.heads === 2, '(b) ' + JSON.stringify({ first: b.first, heads: b.heads }));
  assert.equal(b.e.subs().find((m) => m.key === Y + ':0').payload.aacLen, 12000, '(b) âm thanh đoạn 0');
  const c = await slowMoov(EXT, { other: false, bw: 9000, firstCap: 0, base: 150000, settings: F10S });
  assert.ok(c.heads === 1 && c.first != null && c.first <= 22000, '(c) ' + JSON.stringify({ first: c.first, heads: c.heads }));
  const d = await slowMoov(EXT, { bw: 30000, firstCap: 0, base: 150000, settings: F10S });
  assert.ok(d.heads === 1 && d.first != null && d.first <= 11250, '(d) ' + JSON.stringify({ first: d.first, heads: d.heads }));
});

await t('Dịch sẵn 10 s: lướt đi khi đoạn [10,20) đã tải xong mà còn chờ cửa, rồi lướt lại: lúc đi không gửi (không tốn tiền), bỏ phần đã tải; lúc lại cửa tính lại từ đầu theo thời gian xem video vừa rời (≥ 8 s: 1,5 s; không: 4 s), tải lại rồi gửi khi qua cửa', async () => {
  // HANDOFF §6ab, lưu ý: cửa chờ tính theo thời gian phát, tính lại khi quay lại video. Feed [A, B], 6 MB/s: đoạn [10,20) của A tải
  // xong lúc 2,1 s, chờ cửa; lướt sang B lúc 3,5 s, ở B 9 s hay 3 s, lại về A (phát lại từ 0). Đo: gửi 1650 / 4050 ms sau khi về.
  const B = '7500000000000000005';
  for (const [watchB, lo, hi] of [[9000, 1500, 2500], [3000, 4000, 4600]]) {
    const e = makeEnv(EXT, { bw: 6e6, rtt: 150, realProbe: true, head: H, base: H, bps: BPS, autoReplyMs: 2600, settings: F10S });
    e.activeId = A; const va = e.video(A, 0);
    e.up('items', [A, B].map((id) => e.item(id, 45000, true)));
    for (let t = 0; t < 3500; t += 50) await e.tick(50);
    const c = e.vid(A).chunks.get(1), tag = 'ở B ' + watchB + ' ms: ';
    assert.ok(c && c.status === 'pending' && c.waiting && !c.sent, tag + 'đoạn [10,20) phải đã tải xong, đang chờ cửa: ' + JSON.stringify(c && { st: c.status, w: c.waiting, sent: c.sent }));
    va.paused = true; e.activeId = B; e.video(B, 0);
    let kept = false;
    for (let t = 0; t < watchB; t += 50) { await e.tick(50); if (t >= 500 && e.vid(A).chunks.has(1)) kept = true; }
    assert.ok(!kept && !e.subs().some((m) => m.key === A + ':1'), tag + 'lúc ở B: ' + keysAt(e));
    e.videos.get(B).paused = true; e.activeId = A; va.currentTime = 0; va.paused = false;
    const back = e.perf;
    for (let t = 0; t < 6000; t += 50) await e.tick(50);
    const s1 = e.subs().filter((m) => m.key === A + ':1');
    assert.ok(s1.length === 1 && s1[0].perf - back >= lo && s1[0].perf - back <= hi, tag + 'đoạn [10,20) gửi ' + s1.map((m) => m.perf - back) + ' ms sau khi về: ' + keysAt(e));
    assert.equal(e.fetches.filter((f) => f.vid === A && f.b === W0 - 1).length, 2, tag + 'đoạn [10,20) tải lại một lần (phần đã tải bỏ khi lướt đi)');
    assert.equal(e.subs().filter((m) => m.key === A + ':0').length, 1, tag + 'đoạn 0 gửi lại');
  }
});

await t('Dịch sẵn 10 s: phát 2× / 0,5× so với cửa chờ: cửa tính theo thời gian đã phát (ms thật), "còn ≤ 6 s là tới" (F10_NEAR) theo giây phim', async () => {
  // 2×: cửa 4 s mở ở giây phim 8, nhưng [10,20) còn ≤ 6 s là tới từ giây phim 4 (sau 2 s phát): gửi ngay khi tải xong (2,85 s, giây
  // phim 5,7; cách cũ 0.2.35 với cửa 3 s: giây phim 6). 0,5×: giây phim 4 là sau 8 s phát nên cửa 4 s quyết định (gửi 4,25 s, giây
  // phim 2,1). 1×: cửa và F10_NEAR trùng ở giây 4.
  for (const [rate, lo, hi, phLo, phHi] of [[2, 2000, 3200, 4, 6.4], [1, 4000, 4500, 4, 4.5], [0.5, 4000, 4500, 2, 2.25]]) {
    let ph1 = null;
    const r = await openVideo({ feed: true, ms: 7000, env: { settings: F10S }, during: (e, t) => {
      if (t === 0) e.videos.get(A).playbackRate = rate;
      if (ph1 == null && e.subs().some((m) => m.key === A + ':1')) ph1 = e.dbg.playhead;
    } });
    const tag = rate + '×: ';
    assert.ok(r.c1 != null && r.c1 >= lo && r.c1 <= hi, tag + 'đoạn [10,20) gửi lúc ' + r.c1 + ' ms: ' + keysAt(r.e));
    assert.ok(ph1 != null && ph1 >= phLo && ph1 <= phHi, tag + 'ở giây phim ' + ph1);
  }
});

// ---- Hai lỗi chung của hai chế độ (thấy khi soát chế độ 10 s, 3/11), kiểm ở cách cũ.
await t('Cách cũ: lượt nhanh đã xong trước khi lượt này bắt đầu không phải bằng chứng đường truyền còn dư: đường truyền giảm 40000 → 2500 B/s lúc 1 s, lướt tới Y sau slide livestream: không thôi lượt đầu của Y, có sub như khi chỉ xét lượt chạy cùng lúc', async () => {
  // spareCapacity/othersLoading trước đây chỉ xét lượt nhanh bắt đầu sau since − CONCURRENT_SLACK, kể cả lượt đã xong trước since:
  // lượt đầu video của A (60 s) xong nhanh lúc ~0,7 s, lượt đầu của Y bắt đầu lúc 1 s ngay khi đường truyền giảm. Bản 0.2.37: thôi
  // lượt đầu của Y (lượt q0 nối tiếp tới byte 11999), không có sub trong 20 s; bản sửa (xét cả lúc xong): sub sau 9,75 s.
  const e = makeEnv(EXT, { autoReplyMs: 1500, bw: (p) => (p < 1000 ? 40000 : 2500), settings: OLD });
  e.up('items', [e.item(A, 60000)]);
  e.activeId = A; e.video(A, 0);
  let swipe = null, first = null;
  for (let ms = 0; ms < 22000; ms += 250) {
    if (ms === 1000) e.up('items', [e.item(LY, 25000), ...LP.map((id) => e.item(id, 60000))]);
    if (ms === 1500) { e.videos.get(A).paused = true; e.activeId = null; }   // slide livestream
    if (ms === 2500) { e.activeId = LY; e.video(LY, 0); swipe = e.perf; }
    await e.tick(250);
    if (swipe == null) continue;
    const cv = e.vid(LY), ph = e.dbg.playhead;
    if (cv && cv.plan && okAt(cv, ph) && first == null) first = e.perf - swipe;
  }
  const y = e.fetches.filter((f) => f.vid === LY);
  assert.equal(JSON.stringify(e.vid(LY).plan), '[[0,26]]', 'lưới cách cũ');
  assert.deepEqual(y.filter((f) => !f.open && f.a > 0 && f.b === 11999).map(e.fmt), [], 'lượt q0 nối tiếp (đã thôi lượt đầu của Y)');
  assert.ok(first != null && first <= 9750, 'có sub sau ' + first + ' ms: ' + keysAt(e));
});

await t('Cách cũ: đoạn ở chỗ tua tải lỗi cả hai đường (CDN treo 6 s, /aweme/v1/play/ 503): thử lại sau 1 s, đoạn kế (chưa gấp) không lấy hàng tải trước nó', async () => {
  // Video 600 s đang xem từ giây 10, tua tới 295 lúc 20 s. Lượt tải [290,320) bắt đầu từ 1,5 s sau lần tua treo, lần gọi qua
  // /aweme/v1/play/ trả 503 (lúc ~8,6 s sau tua): lỗi tải, thử lại sau DL_RETRY_CUR. Bản 0.2.37: [320,350) tải 8,6–13,5 s trước, thử
  // lại lúc 13,5 s, đoạn ở chỗ tua gửi 18,4 s sau lần tua; bản sửa: thử lại 9,75 s, gửi 14,65 s.
  const b10 = 326 * 1000 - 1, b11 = 356 * 1000 - 1;
  let n1 = 0, cur = -1, seekAt = Infinity;
  const e = makeEnv(EXT, { bw: 9000, autoReplyMs: 3000, settings: OLD,
    stall: (a, b, env) => { if (b !== b10 || env.perf < seekAt + 1500) return 0; cur = n1++; return cur === 0 ? 60000 : 0; },
    status: (a, b) => (b === b10 && cur === 1 ? 503 : 206) });
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const v = e.video(A, 10);
  await e.tick(20000);
  seekAt = e.perf; v.currentTime = 295;
  for (let i = 0; i < 100; i++) await e.tick(250);
  assert.equal(JSON.stringify(e.vid(A).plan[10]), '[290,320]', 'lưới cách cũ');
  const rel = (f) => (f.url.includes('aweme') ? 'api ' : 'cdn ') + (f.a / 1000) + '-' + ((f.b + 1) / 1000) + '@' + (f.start - seekAt) + '-' + (f.end == null ? '…' : f.end - seekAt) + (f.status ? ' ' + f.status : '') + (f.aborted ? ' X' : '');
  const f10 = e.fetches.filter((f) => f.vid === A && f.b === b10 && f.start >= seekAt), list = e.fetches.filter((f) => f.vid === A && f.start >= seekAt).map(rel).join(' | ');
  const fail = f10.find((f) => f.status === 503), retry = fail && f10.find((f) => f.start > fail.start);
  assert.ok(fail && retry, 'kịch bản: ' + list);
  const next = e.fetches.find((f) => f.vid === A && f.b === b11);
  assert.ok(!next || next.start >= retry.start, 'đoạn [320,350) tải trước lần thử lại của [290,320): ' + list);
  assert.ok(retry.start - fail.end <= 1500, 'thử lại sau ' + (retry.start - fail.end) + ' ms: ' + list);
  const s10 = e.subs().find((m) => m.key === A + ':10');
  assert.ok(s10 && s10.perf - seekAt <= 15000, 'đoạn [290,320) gửi ' + (s10 && s10.perf - seekAt) + ' ms sau lần tua: ' + list);
});

const modeTag = FIRST10 ? ' (FIRST10=1: mặc định dịch sẵn 10 s)' : ' (mặc định của harness: dịch sẵn 20–30 s)';
console.log((failed ? `\n${failed} kiểm tra trượt, ${n} đạt.` : `\n${n} kiểm tra đều đạt.`) + modeTag);
if (failed) process.exit(1);

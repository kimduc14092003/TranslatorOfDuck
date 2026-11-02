// Kiểm tra content.js theo thời gian (không cần trình duyệt): đồng hồ giả, các lượt tải chia nhau băng thông, server trả
// lời sau 3 s. Bắt các lỗi mà content-sim-test.mjs (tải xong ngay) không thấy: thứ tự tải sau khi tua, mẩu nhanh nhường
// đường truyền. Bộ mô phỏng do verifier dựng trong đợt rà soát 31/10.   Chạy: node alpha/dev/content-time-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'extension');
// cap(a, b, id): tốc độ tối đa (byte/s) của riêng lượt tải đó (id: video), như một máy chủ video chậm; 0: không giới hạn.
// Phần băng thông lượt bị giới hạn không dùng hết thì chia cho các lượt khác. pause(rec, env): lượt tải đang khựng (không
// nhận byte nào) ở lúc này. rtt (ms): thời gian tới byte đầu của mỗi lượt tải; qua /aweme/v1/play/ tính 2 lần (chuyển
// hướng 302 rồi mới tới máy chủ video). realProbe: lượt tải 64 KB đầu file cũng chia băng thông như mọi lượt khác (mặc định:
// xong ngay). Mục lục giả: moov dài head byte, giây t của video ở byte base + t * bps. status(a, b, url): mã HTTP.
// Mỗi byte gửi về có giá trị theo vị trí trong file, aacSum của tin gửi đi là tổng kiểm của đúng các byte âm thanh đã tải.
function makeEnv(dir, { bw = 9000, stall = () => 0, total = () => 99999999, autoReplyMs = null, cap = () => 0, pause = () => false,
  rtt = 0, realProbe = false, head = 10, base = 0, bps = 1000, status = () => 206 } = {}) {
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
      const share = bw * dt / 1000 / live.length;
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
        if (msg.type !== 'subtitles') return Promise.resolve();
        return new Promise((r) => { env.replies.set(msg.key, r); if (autoReplyMs != null) setTimeout_(() => { if (env.replies.get(msg.key) === r) { env.replies.delete(msg.key); env.log.push([env.perf, 'reply', msg.key]); r({ status: 'ok', cues: [] }); } }, autoReplyMs); });
      } },
    storage: { local: { get: (_k, cb) => cb({ settings: {} }), set() {} }, onChanged: { addListener: (f) => { env.onChanged = f; } } },
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
async function slowStart(cap, { pause, seekBackAt, watch } = {}) {
  const e = makeEnv(EXT, { cap, pause });
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

await t('Đoạn đầu tải chậm (~25 s) qua máy chủ chậm, q0 bị bỏ qua: bỏ đoạn đó, đoạn kế gửi trước giây 20, có sub sớm; tải nhanh thì không thêm gì', async () => {
  const r = await slowStart(slowHead(560).cap, slowHead(560));
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
  const f = await slowStart(() => 0);   // mọi lượt tải nhanh: như trước khi sửa
  assert.deepEqual(f.quick, ['q0']);
  // Mục lục, q0 và đoạn [0,20) trên một lượt tải từ byte 0 (bản 0.2.25: lượt 64 KB, q0, đoạn 0 là ba lượt riêng). Tải
  // nhanh nên chế độ video dài (0.2.28) vẫn chỉ dịch trước 30 s: không tải thêm đoạn [80,88).
  assert.deepEqual(f.e.media().map((x) => x.a), [0, 18500, 48500], f.e.media().map(f.e.fmt).join(' | '));
});

await t('Đoạn đầu tải chậm vừa phải (2000–2200 B/s, ~12 s): vẫn kịp nên không bỏ, không có mẩu nhanh nào gửi sau khi đoạn đã gửi', async () => {
  // Kịch bản của verifier 1/11 (bản vá trước: mẩu q10 gửi sau khi đoạn [0,20) đã ở server, thêm ~23 s nhận dạng mà sub
  // không ra sớm hơn; đoạn [20,50) gửi dư 8 s thay vì 1,5 s).
  for (const capBps of [2000, 2200]) {
    const r = await slowStart(slowHead(capBps).cap, slowHead(capBps));
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
  for (const [bw, keys, cover, early] of [[2500, ['q0', '1'], 1.75, 60], [3500, ['q0', '0', '1', '2', '3'], 30, 8], [4500, ['q0', '0', '1', '2', '3'], 44.5, 6]]) {
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
  }
});

await t('Xem video dài trên feed, đường truyền chậm, 4 video kế chờ dịch sẵn: ở lại quá 10 s thì dịch sẵn nhường video đang xem, đoạn kế tải trong lúc đoạn trước ở server, đuổi kịp chỗ đang xem', async () => {
  // Đo 2/11 trên Douyin thật (video 678 s, giới hạn 450 KB/s cho cả tab): bản 0.2.27 hàng dịch sẵn tải đoạn đầu của 4 video
  // kế song song với đoạn của video đang xem, đoạn kế chỉ bắt đầu tải khi đoạn trước có kết quả; đoạn nào cũng về muộn
  // 12–18 s, 66% thời gian phát hiện "đang dịch". Mô phỏng: video 600 s, 1000 B mỗi giây video, server trả lời sau 6 s,
  // 150 s. Bản 0.2.27: "đang dịch" 82,25 s ở 3000 B/s (lần cuối ở giây 88), 24,5 s ở 6000 B/s (lần cuối ở giây 31). Lượt
  // dịch sẵn đã bắt đầu trong 10 s đầu vẫn chạy nốt (ngắt thì lướt feed kém đi), nên phần đầu vẫn trễ.
  const F = ['7500000000000000051', '7500000000000000052', '7500000000000000053', '7500000000000000054'];
  for (const [bw, most, caught] of [[3000, 55, 60], [6000, 17.5, 25]]) {
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
    const answer = async () => { for (const k of [...e.replies.keys()]) if (!k.endsWith(':1')) await e.reply(k, { status: 'ok', cues: [] }); };
    for (let i = 0; i < 112; i++) { await e.tick(250); await answer(); }   // 28 s: đoạn [20,50) ở server, chưa trả lời
    const c2 = e.vid(A).chunks.get(2);
    assert.ok(e.replies.has(A + ':1'), 'đoạn [20,50) phải đang ở server');
    assert.ok(c2 && c2.status === 'pending' && !c2.sent && c2.waiting, 'đoạn [50,80) đã tải, chờ lượt gửi: ' + JSON.stringify(c2 && { st: c2.status, sent: c2.sent, w: c2.waiting }));
    if (miss) { e.activeId = null; await e.tick(250); e.activeId = A; }
    await e.reply(A + ':1', { status: 'ok', cues: [], pronouns: PA });
    await e.tick(250); await e.tick(250);
    const m2 = e.subs().find((m) => m.key === A + ':2');
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
  const r = await slowStart(sh.cap, sh);
  assert.ok(r.e.subs().some((m) => m.key === A + ':0'), 'đoạn [0,20) phải được gửi: ' + r.e.subs().map((m) => m.key.slice(20)));
  assert.deepEqual(r.quick, ['q0']);
});

await t('Trên feed: đoạn đầu của video kế tải chậm ở hàng dịch sẵn rồi mới lướt tới: vẫn bỏ được, có sub sớm', async () => {
  // Verifier 1/11: lượt tải đó (của chính video đang xem, bắt đầu ở hàng dịch sẵn) làm "hàng dịch sẵn bận", dropSlow không
  // chạy; 20 s đầu không có sub, đoạn [20,50) không có mạch câu.
  const B = '7500000000000000005';
  // Lượt tải đoạn đầu của B (riêng, hay lượt tải đầu video) chậm hẳn sau phần của q0, như slowHead.
  const e = makeEnv(EXT, { pause: (rec) => { if (rec.vid === B && rec.a === 0 && (rec.b === 25999 || rec.open) && rec.got >= 12000) rec.cap = 560; return false; } });
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

await t('Tua về đầu ngay sau khi bỏ đoạn đầu: không tải lại đoạn đó khi còn trong nó, không gửi mẩu thường chồng lên đoạn đã có sub', async () => {
  // Verifier 1/11: hết thời gian chờ lúc chỗ đang xem còn trong đoạn (giây ~18), đoạn bị tải lại, và mẩu thường q18 chồng
  // lên đoạn [20,50) đã có sub (16,5 s âm thanh trả tiền vô ích).
  const r = await slowStart(slowHead(560).cap, { ...slowHead(560), seekBackAt: 7250 });
  const again = r.e.media().filter((f) => f.a === 0 && (f.b === 25999 || f.open));
  assert.equal(again.length, 1, 'đoạn [0,20) tải ' + again.length + ' lần: ' + again.map(r.e.fmt).join(' | '));
  const late = r.e.subs().filter((m) => m.key.includes(':q') && m.payload.to > 20);
  assert.deepEqual(late.map((m) => m.key.slice(20)), [], 'mẩu nhanh chồng lên [20,50)');
});

await t('Đoạn đầu tải nhanh 1/4 rồi chậm hẳn (560 B/s): vẫn bỏ sớm, có sub kịp lúc phần lớn [10,30)', async () => {
  // Verifier 1/11: lấy trung bình cả lượt tải làm tốc độ thì chậm từ 20–33% đoạn trở đi bị bỏ quá muộn (sub kịp lúc 5,75–9,75
  // trên 20 s của [10,30), so với 16,5 s).
  // Chậm hẳn khi đã qua phần của q0 (byte 12000) và 1/4 phần còn lại của đoạn.
  const r = await slowStart(() => 0, slowHead(560, 15500));
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
  return { e, t0, pf, first: first && first.perf - t0, q0: (e.subs().find((m) => m.key === S[0] + ':q0') || {}).perf - t0 };
}

await t('Mở kết quả tìm kiếm chưa dịch sẵn, 4 kết quả kế chờ dịch sẵn: mẩu nhanh gửi sớm hơn hẳn, hàng dịch sẵn chạy lại ngay sau lần gửi đầu', async () => {
  // HANDOFF §6i: mẩu nhanh chỉ "tải một mình" khi hàng dịch sẵn rảnh. Trước đây q0 gửi lúc 5000 ms (tải chung với 2 video
  // dịch sẵn), nay 2000 ms.
  const r = await openSearch();
  assert.ok(r.q0 <= 2500, 'q0 gửi lúc ' + r.q0 + ' ms');
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
  for (const k of ['current', 'item', 'video', 'ready', 'play', 'settle', 'moov', 'moovEnd', 'quickDl', 'quickDlEnd', 'quickPost', 'quickReply', 'chunkDl', 'chunkDlEnd', 'chunkPost', 'chunkReply', 'drawn']) {
    assert.ok(typeof t_[k] === 'number', 'thiếu mốc ' + k + ': ' + JSON.stringify(t_));
  }
  // Mốc so với các điểm cố định của kịch bản (thành video đang xem ở lượt dò đầu, lúc 50 ms): metadata lúc 500 ms,
  // readyState 4 lúc 1000 ms, phát lúc 1250 ms; dò 4 lần/giây; server trả lời sau ít nhất 1 s.
  const near = (k, a, b) => assert.ok(t_[k] >= a && t_[k] <= b, k + ' lúc ' + t_[k] + ' (cần ' + a + '–' + b + '): ' + JSON.stringify(t_));
  assert.equal(t_.current, 0);
  near('video', 0, 0); near('item', 400, 500); near('moov', 400, 550); near('ready', 950, 1250); near('settle', 950, 1250);
  near('play', 1200, 1750);
  assert.ok(t_.quickReply - t_.quickPost >= 1000 && t_.chunkReply - t_.chunkPost >= 1000, 'trả lời sớm hơn 1 s: ' + JSON.stringify(t_));
  for (const chain of [['current', 'video', 'ready', 'play'], ['item', 'moov', 'moovEnd', 'quickDl', 'quickDlEnd', 'quickPost', 'quickReply'], ['moovEnd', 'chunkDl', 'chunkDlEnd', 'chunkPost', 'chunkReply']]) {
    assert.ok(chain.every((k, i) => i === 0 || t_[k] >= t_[chain[i - 1]]), chain.join(' ≤ ') + ': ' + JSON.stringify(t_));
  }
  assert.ok(t_.drawn <= Math.min(t_.quickReply, t_.chunkReply) + 300, 'drawn lúc ' + t_.drawn);
});

// ---- Một lượt tải cho đầu video (first load bước 2): mục lục + mẩu q0 + đoạn 0 trên cùng một lượt tải từ byte 0.
// Bố cục gần file thật hơn các ca trên: moov dài H byte, video 2 Mbit/s (250 KB mỗi giây, âm thanh xen trong đó), lượt tải
// đầu tiên qua /aweme/v1/play/ (chuyển hướng: 2 rtt tới byte đầu), lượt 64 KB cũ cũng chia băng thông (realProbe).
const H = 40000, BPS = 250000, W0 = H + 26 * BPS;   // W0: byte sau cùng của âm thanh đoạn [0,20) (cửa sổ [0, 26) s) + 1
// Mở video A: /video/ (item lúc itemAt, <video> phát từ playAt) hay feed (đang phát từ 0). Trả về env và các mốc (ms từ lúc có
// item): q0, c0 (lúc gửi), heads (các lượt tải "bytes=0-" của A), mine (mọi lượt tải của A trước đoạn [20,50)).
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
  return { e, q0: at(A + ':q0'), c0: at(A + ':0'), heads: own.filter((f) => f.open), mine: own.filter((f) => f.a < head + 18 * BPS) };
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
  for (const [page, rtt, bw, q0Max, c0Max] of [
    ['video', 50, 1.5e6, 2300, 4650], ['video', 150, 3e6, 2300, 2650], ['video', 300, 6e6, null, 1850],
    ['feed', 50, 1.5e6, 2350, 4700], ['feed', 150, 3e6, 1550, 2700], ['feed', 300, 6e6, 1350, 1900]]) {
    const r = await openVideo(page === 'video' ? { rtt, bw, itemAt: 1500, playAt: 2800 } : { rtt, bw, feed: true });
    const tag = `${page} rtt ${rtt} ms, ${bw / 1e6} MB/s: `;
    assert.equal(r.mine.length, 1, tag + 'số lượt tải: ' + r.mine.map(r.e.fmt).join(' | '));
    assert.ok(r.heads.length === 1 && /aweme\/v1\/play/.test(r.heads[0].url), tag + 'lượt tải đầu video qua /aweme/v1/play/');
    const got = MB(r.mine);
    assert.ok(got >= W0 && got <= W0 + 100000, tag + 'tải ' + got + ' byte (âm thanh đoạn 0 tới byte ' + W0 + ')');
    if (q0Max == null) assert.equal(r.q0, null, tag + 'q0 gửi lúc ' + r.q0);
    else assert.ok(r.q0 != null && r.q0 <= q0Max, tag + 'q0 gửi lúc ' + r.q0 + ' ms (cần ≤ ' + q0Max + ')');
    assert.ok(r.c0 != null && r.c0 <= c0Max, tag + 'đoạn 0 gửi lúc ' + r.c0 + ' ms (cần ≤ ' + c0Max + ')');
    const sent = (k) => r.e.subs().find((m) => m.key === A + k).payload;
    assert.equal(sent(':0').aacSum, sumOf(H, W0), tag + 'âm thanh đoạn 0 cắt sai');
    if (q0Max != null) assert.equal(sent(':q0').aacSum, sumOf(H, H + 12 * BPS), tag + 'âm thanh q0 cắt sai');
  }
});

await t('Tua tới gần cuối đoạn 0 lúc đang tải đầu video: mẩu nhanh lấy tiếp từ chính lượt đó, không thêm lượt tải song song', async () => {
  // Mẩu ở giây 16–17 cần tới giây 28–29, quá cuối âm thanh đoạn 0 (26 s): lượt tải đầu video đọc thêm tới đó. Bản 0.2.25:
  // 5 lượt tải trước đoạn [20,50) (4 lượt bị ngắt), mẩu nhanh gửi lúc 3100 ms; nay một lượt, 2800 ms.
  const r = await openVideo({ feed: true, ms: 6000, during: (e, t) => { if (t === 700) e.videos.get(A).currentTime = 16; } });
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
    assert.ok(own[0].open && own[0].got >= W0 && own[0].got <= W0 + 100000, id.slice(-1) + ': ' + r.e.fmt(own[0]));
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
  assert.ok(full.heads[0].aborted && full.heads[0].got <= W0 + 100000, '200: ' + full.e.fmt(full.heads[0]));
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
  assert.ok(r.heads.length === 1 && r.heads[0].got >= W0, 'lượt tải đầu video của A: ' + r.e.fmt(r.heads[0]));
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
  assert.ok(again.length === 2 && again.every((f) => /aweme\/v1\/play/.test(f.url)) && again[0].a === got && again[0].b === H + 12 * BPS - 1
    && again[1].a === H + 12 * BPS && again[1].b === W0 - 1, 'tải nối tiếp: ' + again.map(mid.e.fmt).join(' | ') + ', đã nhận ' + got);
  assert.ok(again[1].start >= again[0].end, 'đoạn 0 tải song song với q0: ' + again.map(mid.e.fmt).join(' | '));
  const sent = (k) => mid.e.subs().find((m) => m.key === A + k).payload;
  assert.equal(sent(':q0').aacSum, sumOf(H, H + 12 * BPS), 'âm thanh q0 ghép sai');
  assert.equal(sent(':0').aacSum, sumOf(H, W0), 'âm thanh đoạn 0 ghép sai');
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
  assert.ok(p1.aacLen === W0 - H && p2.aacLen === p1.aacLen && p2.aacSum === p1.aacSum, `âm thanh khác: ${p1.aacLen}/${p1.aacSum} và ${p2.aacLen}/${p2.aacSum}`);
  assert.equal(p1.aacSum, sumOf(H, W0), 'âm thanh đoạn 0 cắt sai');
  // Các kiểm tra trên cũng đạt trên bản 0.2.25 (canh luật v.redo); hai kiểm tra dưới là cách làm mới: lần đầu lấy từ lượt tải
  // đầu video, lần xin lại tải riêng đúng cửa sổ đó (phần đã nhận đã bỏ khi đoạn 0 có kết quả).
  assert.equal(r.mine.length, 1, r.mine.map(e.fmt).join(' | '));
  assert.ok(e.fetches.some((f) => f.vid === A && f.a === H && f.b === W0 - 1), e.fetches.map(e.fmt).join(' | '));
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
  const from0 = (bps, chunkToo) => ({ pause: (rec) => { if ((rec.a === 0 && (rec.b === 25999 || rec.open)) || (chunkToo && rec.b === 25999)) rec.cap = bps; return false; } });
  for (const [bps, chunkToo, first, cov] of [[1040, false, 13, 16], [560, false, 13, 16], [560, true, 13, 16], [1040, true, 13, 16], [1400, true, 13, 16]]) {
    // Lượt nối tiếp của đoạn 0: dropSlow ước thời gian còn lại theo phần phải tải của lượt đó (prog.bytes), không theo cả cửa sổ.
    const bytes = new Set();
    const watch = (e) => {
      const c = e.vid(A) && e.vid(A).chunks.get(0), f = e.media().find((x) => !x.open && x.a > 0 && x.b === 25999 && !x.done && !x.aborted);
      if (c && c.status === 'pending' && f) bytes.add(c.bytes + '/' + (26000 - f.a));
    };
    const r = await slowStart(() => 0, { ...from0(bps, chunkToo), watch });
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
  const q = e.subs().find((m) => m.key === A + ':q15');
  assert.ok(q && q.perf <= 2300, 'mẩu nhanh gửi lúc ' + (q && q.perf));
  assert.ok(!e.subs().some((m) => m.key === A + ':0'), 'gửi cả đoạn [0,20)');
});

await t('Tiến độ và tốc độ khi lấy từ lượt tải đầu video: tính theo cửa sổ của chính đoạn, tốc độ theo lúc byte về (dropSlow)', async () => {
  // Trang /video/: q0 chỉ bắt đầu sau QUICK_STALL, lúc phần byte của nó đã về từ lâu. Tốc độ phải là tốc độ tải thật (3 MB/s
  // trừ 2 rtt), không chia cho cả lúc chờ (khi đó ~1,5 MB/s, chỉ còn gấp 3 tốc độ của một lượt chậm 0,5 MB/s: dropSlow không
  // bỏ được đoạn chậm). Tiến độ của đoạn 0 (got) tính từ byte đầu cửa sổ của nó, không tính mục lục.
  let speed = null, prog = null;
  await openVideo({ rtt: 150, bw: 3e6, itemAt: 1500, playAt: 2800, during: (e, t) => {
    const v = e.vid(A);
    if (speed == null && e.subs().some((m) => m.key === A + ':q0')) speed = v.speed;
    const c = v && v.chunks.get(0), rec = e.fetches.find((f) => f.vid === A && f.open);
    if (t === 2500 && c && rec) prog = { got: c.got, bytes: c.bytes, recv: Math.floor(rec.got) };
  } });
  assert.ok(speed != null && speed >= 2000, 'tốc độ ' + speed + ' byte/ms');
  assert.ok(prog && prog.got > 0 && prog.got <= prog.recv - H && prog.bytes === W0 - H, 'tiến độ đoạn 0: ' + JSON.stringify(prog));
});

console.log(failed ? `\n${failed} kiểm tra trượt, ${n} đạt.` : `\n${n} kiểm tra đều đạt.`);
if (failed) process.exit(1);

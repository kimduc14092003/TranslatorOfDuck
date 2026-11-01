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
// nhận byte nào) ở lúc này.
function makeEnv(dir, { bw = 9000, stall = () => 0, total = () => 99999999, autoReplyMs = null, cap = () => 0, pause = () => false } = {}) {
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
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); const a = +m[1], b = +m[2];
    if (init.signal.aborted) { env.fetches.push({ url, a, b, size: b - a + 1, got: 0, start: env.perf, end: env.perf, aborted: true, preAborted: true }); return reject(init.signal.reason); }
    const vidId = (/video_id=v0d00f(\d+)/.exec(url) || /cdn\.example\/(\d+)/.exec(url) || [])[1] || 'x';
    const rec = { url, a, b, size: b - a + 1, got: 0, start: env.perf, end: null, aborted: false, done: false, waiters: [], stallUntil: env.perf + stall(a, b, env), cap: cap(a, b, vidId), vid: vidId };
    env.fetches.push(rec);
    const size = total(a, b);
    if (b === 65535) { rec.got = rec.size; rec.done = true; rec.end = env.perf; }
    else active.push(rec);
    init.signal.addEventListener('abort', () => { if (rec.done) return; rec.aborted = true; rec.end = env.perf; const i = active.indexOf(rec); if (i >= 0) active.splice(i, 1);
      reject(init.signal.reason); for (const w of rec.waiters.splice(0)) w.rej(init.signal.reason); }, { once: true });
    let delivered = 0;
    resolve({ status: 206, url: 'https://cdn.example/' + vidId, headers: { get: (h) => (h === 'content-range' ? `bytes ${a}-${b}/${size}` : null) },
      body: { getReader: () => ({ read: () => new Promise((res, rej) => {
        const check = () => {
          if (rec.aborted) return rej(new Error('aborted'));
          // Trả đúng số byte vừa tải (content.js đếm tiến độ theo đó: dropSlow).
          if (rec.got > delivered) { const n = Math.ceil(rec.got) - Math.ceil(delivered); delivered = rec.got; return res({ done: false, value: new Uint8Array(Math.max(n, 1)) }); }
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

// Bài hát 87 s mở ở trang /video/ (đo 1/11): metadata tới lúc 0,5 s, video phát từ 2,3 s; server trả mẩu nhanh sau 1,2 s
// (q0: "quá ít lời"), đoạn sau 4 s. cap: lượt tải đoạn [0,20) (byte 0–25999) qua máy chủ chậm.
async function slowStart(cap, { pause, seekBackAt } = {}) {
  const e = makeEnv(EXT, { cap, pause });
  e.href = 'https://www.douyin.com/video/' + A;
  const v = e.video(A, 0); v.readyState = 0; v.paused = true;
  let sent1 = null, first = null, gap = 0, cov = 0;
  for (let ms = 0; ms < 34000; ms += 250) {
    if (ms === 500) e.up('items', [e.item(A, 87100, null)]);
    if (ms === 2250) { v.readyState = 4; v.paused = false; }
    if (ms === seekBackAt) v.currentTime = 1;
    await e.tick(250);
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
  const r = await slowStart((a, b) => (a === 0 && b === 25999 ? 1040 : 0));
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
  assert.deepEqual(f.e.media().map((x) => x.a), [0, 0, 18500, 48500], f.e.media().map(f.e.fmt).join(' | '));
});

await t('Đoạn đầu tải chậm vừa phải (2000–2200 B/s, ~12 s): vẫn kịp nên không bỏ, không có mẩu nhanh nào gửi sau khi đoạn đã gửi', async () => {
  // Kịch bản của verifier 1/11 (bản vá trước: mẩu q10 gửi sau khi đoạn [0,20) đã ở server, thêm ~23 s nhận dạng mà sub
  // không ra sớm hơn; đoạn [20,50) gửi dư 8 s thay vì 1,5 s).
  for (const capBps of [2000, 2200]) {
    const r = await slowStart((a, b) => (a === 0 && b === 25999 ? capBps : 0));
    const subs = r.e.subs();
    const s0 = subs.find((m) => m.key === A + ':0');
    assert.ok(s0, capBps + ' B/s: đoạn [0,20) phải được gửi');
    assert.deepEqual(subs.filter((m) => m.key.includes(':q')).map((m) => m.key.slice(20)), ['q0'], capBps + ' B/s');
    assert.equal(subs.find((m) => m.key === A + ':1').payload.audioStart, 18.5, capBps + ' B/s: đoạn [20,50) gửi dư 1,5 s');
  }
});

await t('Đường truyền chậm đều lúc vào trang (2 video dịch sẵn, 2500–4500 B/s): không thêm mẩu nhanh, lượt tải nào', async () => {
  // Mô phỏng của verifier 1/11: mẩu nhanh nối tiếp, lượt tải thêm bật ra khi chưa đo được tốc độ (rate = 0) thì chia nhỏ
  // băng thông rồi bị ngắt. 2500 B/s: 60 s đầu không có sub nào (bản 31/10: có từ giây 48). Số dưới đây là của bản 31/10.
  const B = '7500000000000000005', C3 = '7500000000000000006';
  for (const [bw, keys, cover] of [[2500, ['1'], 2.25], [3500, ['1', '2', '3'], 23.25], [4500, ['1', '2', '3'], 28.75]]) {
    const e = makeEnv(EXT, { bw, autoReplyMs: 1500 });
    e.up('items', [e.item(A, 87100), e.item(B, 60000), e.item(C3, 90000)]);
    e.activeId = A; e.video(A, 0);
    let cov = 0;
    for (let i = 0; i < 240; i++) {
      await e.tick(250);
      const cv = e.vid(A), ph = e.dbg.playhead;
      if (!cv || !cv.plan) continue;
      let ok = (cv.chunks.get(cv.plan.findIndex(([a, b]) => ph >= a && ph < b)) || {}).status === 'ok';
      for (const q of cv.quick.values()) if (ph >= q.from && ph < q.to && q.status === 'ok') ok = true;
      if (ok) cov += 0.25;
    }
    const sent = e.subs().filter((m) => m.key.startsWith(A)).map((m) => m.key.slice(20));
    assert.deepEqual(sent, keys, bw + ' B/s: ' + sent);
    assert.ok(cov >= cover, bw + ' B/s: có sub ' + cov + ' s trong 60 s đầu (bản 31/10: ' + cover + ' s)');
  }
});

await t('Đoạn đầu tải được 3/4 thì khựng 2,5 s (máy chủ 3000 B/s): không bỏ đoạn, để lượt tải chạy tiếp', async () => {
  // Verifier 1/11: tính tốc độ theo 3 s gần nhất thì một lần khựng ngắn thành "không kịp", đoạn đã tải 74% bị bỏ, sub đầu
  // muộn hơn và thêm một mẩu nhanh.
  let p0 = null;
  const pause = (rec, env) => { if (rec.a !== 0 || rec.b !== 25999) return false; if (p0 == null && env.perf - rec.start >= 6500) p0 = env.perf; return p0 != null && env.perf < p0 + 2500; };
  const r = await slowStart((a, b) => (a === 0 && b === 25999 ? 3000 : 0), { pause });
  assert.ok(r.e.subs().some((m) => m.key === A + ':0'), 'đoạn [0,20) phải được gửi: ' + r.e.subs().map((m) => m.key.slice(20)));
  assert.deepEqual(r.quick, ['q0']);
});

await t('Trên feed: đoạn đầu của video kế tải chậm ở hàng dịch sẵn rồi mới lướt tới: vẫn bỏ được, có sub sớm', async () => {
  // Verifier 1/11: lượt tải đó (của chính video đang xem, bắt đầu ở hàng dịch sẵn) làm "hàng dịch sẵn bận", dropSlow không
  // chạy; 20 s đầu không có sub, đoạn [20,50) không có mạch câu.
  const B = '7500000000000000005';
  const e = makeEnv(EXT, { cap: (a, b, id) => (id === B && a === 0 && b === 25999 ? 1040 : 0) });
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
  const r = await slowStart((a, b) => (a === 0 && b === 25999 ? 1040 : 0), { seekBackAt: 7250 });
  const again = r.e.media().filter((f) => f.a === 0 && f.b === 25999);
  assert.equal(again.length, 1, 'đoạn [0,20) tải ' + again.length + ' lần: ' + again.map(r.e.fmt).join(' | '));
  const late = r.e.subs().filter((m) => m.key.includes(':q') && m.payload.to > 20);
  assert.deepEqual(late.map((m) => m.key.slice(20)), [], 'mẩu nhanh chồng lên [20,50)');
});

await t('Đoạn đầu tải nhanh 1/4 rồi chậm hẳn (1040 B/s): vẫn bỏ sớm, có sub kịp lúc phần lớn [10,30)', async () => {
  // Verifier 1/11: lấy trung bình cả lượt tải làm tốc độ thì chậm từ 20–33% đoạn trở đi bị bỏ quá muộn (sub kịp lúc 5,75–9,75
  // trên 20 s của [10,30), so với 16,5 s).
  const pause = (rec) => { if (rec.a === 0 && rec.b === 25999 && rec.got >= 0.25 * rec.size) rec.cap = 1040; return false; };
  const r = await slowStart(() => 0, { pause });
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
  for (let ms = 0; ms < 21500; ms += 250) await f.tick(250);
  const pre = f.subs().filter((m) => m.key !== ids[0] + ':0' && m.key.endsWith(':0')).map((m) => m.key.slice(16));
  assert.ok(pre.length >= 3, 'dịch sẵn trên feed khi slide là livestream: ' + pre);
  assert.ok(!f.subs().some((m) => m.key.startsWith(ids[0]) && m.key !== ids[0] + ':0'), 'không gửi thêm gì cho video cũ: ' + f.subs().map((m) => m.key.slice(16)));
});

console.log(failed ? `\n${failed} kiểm tra trượt, ${n} đạt.` : `\n${n} kiểm tra đều đạt.`);
if (failed) process.exit(1);

// Mô phỏng content.js + cues.js (và tap.main.js) trong vm: DOM, chrome.*, fetch, đồng hồ đều giả, không cần trình
// duyệt hay mạng. Mỗi ca dựng lại một lỗi đợt rà soát 31/10 tìm ra (F1, F2, F4, F6, F7, F9, F10, F11, F13, F15) hoặc
// lần kiểm lại bản sửa tìm ra, và kiểm cách sửa. Chạy: node alpha/dev/content-sim-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');

// ---- content.js trong vm. Đồng hồ: env.now (Date.now), env.perf (performance.now, requestAnimationFrame).
// fetchHang(a, b): lượt tải treo tới khi bị ngắt. total(a, b): cỡ file máy chủ báo trong Content-Range.
// status(a, b): mã HTTP trả về (vd. 429). retryAfter(a, b): header Retry-After (null: không đọc được).
function makeEnv({ fetchHang = () => false, total = () => 99999999, status = () => 206, retryAfter = () => null } = {}) {
  const env = { now: 1_000_000, perf: 0, sent: [], replies: new Map(), fetches: [], rafs: [], listeners: {}, videos: new Map(), activeId: null,
    href: 'https://www.douyin.com/', onChanged: null };
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
    elementFromPoint: () => env.center || null,   // env.center: phần tử ở giữa màn hình (thẻ kết quả tìm kiếm…)
  };
  const fakeFetch = (url, init) => new Promise((resolve, reject) => {
    // Như fetch thật: signal đã bị ngắt từ trước thì từ chối ngay, không gọi mạng.
    if (init.signal.aborted) { env.preAborted = (env.preAborted || 0) + 1; return reject(init.signal.reason); }
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers.Range); const a = +m[1], b = +m[2];
    const rec = { url, a, b, aborted: false, at: env.now, status: status(a, b, url) };
    env.fetches.push(rec);
    const size = total(a, b), ra = retryAfter(a, b);
    const fin = () => resolve({ status: rec.status, url: 'https://cdn.example/x.mp4',
      headers: { get: (h) => (h === 'content-range' ? `bytes ${a}-${b}/${size}` : h === 'retry-after' ? ra : null) },
      body: { getReader: () => { let d = false; return { read: async () => (d ? { done: true } : (d = true, { done: false, value: new Uint8Array(16) })) }; } } });
    init.signal.addEventListener('abort', () => { rec.aborted = true; reject(init.signal.reason); }, { once: true });
    if (fetchHang(a, b, url)) rec.release = fin; else queueMicrotask(fin);
  });
  const chrome = {
    runtime: { id: 'x', onMessage: { addListener() {} },
      sendMessage: (msg) => {
        env.sent.push({ at: env.now, ...msg, payload: msg.payload && { ...msg.payload, aac: undefined } });
        if (msg.type !== 'subtitles') return Promise.resolve();
        return new Promise((r) => env.replies.set(msg.key, r));
      } },
    storage: { local: { get: (_k, cb) => cb({ settings: {} }), set() {} }, onChanged: { addListener: (f) => { env.onChanged = f; } } },
  };
  // Mục lục giả: giây t ở byte t*1000.
  const TodMp4 = { headerEnd: () => 10, parse: () => ({ duration: 0 }),
    window: (_m, a, b) => ({ start: Math.round(a * 1000), end: Math.round(b * 1000), startTime: a, seconds: b - a, build: () => new Uint8Array(4) }) };
  const ctx = {
    window: { addEventListener: (t, f) => { env.listeners[t] = f; }, dispatchEvent() {} },
    document, chrome, TodMp4, location: { get href() { return env.href; } }, innerWidth: 1280, innerHeight: 800,
    requestAnimationFrame: (cb) => env.rafs.push(cb), performance: { now: () => env.perf }, Date: { now: () => env.now },
    fetch: fakeFetch, AbortController, AbortSignal, URL, setTimeout, clearTimeout, btoa, queueMicrotask, console,
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'cues.js'), 'utf8'), ctx);
  const src = fs.readFileSync(path.join(EXT, 'content.js'), 'utf8')
    .replace(/\}\)\(\);\s*$/, 'globalThis.__dbg = { vids, get wanted() { return wanted; }, get playhead() { return playhead; } };\n})();');
  vm.runInContext(src, ctx);
  env.dbg = ctx.__dbg;
  env.up = (type, data) => env.listeners.__tod_alpha_up({ detail: JSON.stringify({ type, data }) });
  env.item = (id, durMs, feed = true) => ({ id, kind: 'video', playUri: 'v0d00f' + id, durationMs: durMs, gears: [], audio: [], feed, desc: '', hashtags: [] });
  env.video = (id, t = 0) => { const v = { currentTime: t, paused: false, playbackRate: 1, readyState: 4,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 640, bottom: 480, width: 640, height: 480 }) }; env.videos.set(id, v); return v; };
  env.flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
  env.tick = async (ms = 260) => { env.now += ms; env.perf += ms; for (const cb of env.rafs.splice(0)) cb(env.perf); await env.flush(); };
  env.reply = async (key, r) => { const f = env.replies.get(key); assert.ok(f, 'không có yêu cầu đang chờ: ' + key); env.replies.delete(key); f(r); await env.flush(); };
  env.subs = () => env.sent.filter((m) => m.type === 'subtitles').map((m) => m.key);
  env.cancels = () => env.sent.filter((m) => m.type === 'cancel').flatMap((m) => m.keys);
  env.subText = () => (shadow['.sub'].style.display === 'block' ? shadow['.sub'].textContent : null);
  env.badge = () => (shadow['.badge'].style.display === 'block' ? shadow['.badge .txt'].textContent : null);
  env.vid = (id) => env.dbg.vids.get(id);
  return env;
}

const A = '7500000000000000004', B = '7500000000000000005', C2 = '7500000000000000006', D = '7500000000000000007';
const C = (start, se, vi, end = se + 0.3) => ({ start, end, se, vi });
const texts = (cues) => Array.from(cues, (c) => c.vi);
const DOWN = 'không kết nối được server (đã chạy "npm start" trong alpha/server chưa?)';   // câu của background.js
let n = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); n++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
};

await t('F1 tua tới 2 s trước ranh giới, đoạn trước bị huỷ: dòng của đoạn sau vẫn hiện, mẩu nhanh không che', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 18);
  for (let i = 0; i < 3; i++) await e.tick();
  assert.deepEqual(e.subs().sort(), [A + ':0', A + ':1', A + ':q18']);
  await e.reply(A + ':q18', { status: 'ok', cues: [C(18.5, 20.8, 'Q1'), C(21.5, 23.8, 'Q2'), C(25.0, 27.5, 'Q3')] });
  v.currentTime = 20.5; await e.tick();
  assert.deepEqual(e.cancels(), [A + ':0']);
  await e.reply(A + ':0', { status: 'cancelled' });
  await e.reply(A + ':1', { status: 'ok', cues: [C(21.4, 23.7, 'C1a'), C(24.0, 24.8, 'C1b'), C(25.1, 28.6, 'C1c'), C(30, 32.5, 'C1d')] });
  assert.deepEqual(texts(e.vid(A).cues), ['Q1', 'C1a', 'C1b', 'C1c', 'C1d']);
  for (const [at, want] of [[19, 'Q1'], [22, 'C1a'], [24.4, 'C1b'], [26, 'C1c'], [31, 'C1d']]) {
    v.currentTime = at; await e.tick(16);
    assert.equal(e.subText(), want, 'ở ' + at + ' s');
  }
});

await t('F1 dòng mẩu nhanh chồng lên dòng đầu (vắt qua ranh giới) của đoạn đã xong: bỏ dòng mẩu nhanh', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 45);
  for (let i = 0; i < 3; i++) await e.tick();
  assert.ok(e.subs().includes(A + ':q45'));
  await e.reply(A + ':q45', { status: 'ok', cues: [C(45.5, 47.6, 'Q1'), C(48.2, 51.0, 'Q2'), C(51.5, 54, 'Q3')] });
  // Đoạn [50,80) gửi dư 8 s phía trước nên giữ cả câu vắt qua 50 s (bắt đầu 48,3 s).
  await e.reply(A + ':2', { status: 'ok', cues: [C(48.3, 51.1, 'C2a'), C(51.6, 54.2, 'C2b')] });
  assert.deepEqual(texts(e.vid(A).cues), ['Q1', 'C2a', 'C2b']);
  v.currentTime = 49; await e.tick(16);
  assert.equal(e.subText(), 'C2a');
});

await t('F4 S6a: độ lệch của trình phát feed không cộng vào thẻ <video> khác của cùng video (?modal_id=)', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const fv = e.video(A, 30); fv.paused = true;
  e.up('clock', { id: A, offset: 100, mediaTime: 30, at: e.perf, paused: true, rate: 1 });
  await e.tick();
  assert.equal(e.dbg.playhead, 130);
  e.href = 'https://www.douyin.com/?modal_id=' + A; e.activeId = null; e.videos.clear(); e.video('modal', 5);
  await e.tick(); await e.tick();
  assert.equal(e.dbg.playhead, 5);
  assert.deepEqual([...e.dbg.wanted].filter((k) => k.startsWith(A)), [A + ':0', A + ':1']);   // 5 s + 30 s, không phải 105 s
});

await t('F4: thẻ <video> khác đang phát ngang qua đúng chỗ trình phát feed đang dừng: không cộng độ lệch', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const fv = e.video(A, 30); fv.paused = true;
  e.up('clock', { id: A, offset: 100, mediaTime: 30, at: e.perf, paused: true, rate: 1 });
  await e.tick();
  assert.equal(e.dbg.playhead, 130);
  e.href = 'https://www.douyin.com/?modal_id=' + A; e.activeId = null; e.videos.clear();
  const mv = e.video('modal', 29.6); mv.paused = false;   // đang phát, trùng chỗ 30 s của trình phát feed (đang dừng)
  await e.tick(); await e.tick();
  assert.ok(Math.abs(e.dbg.playhead - 29.6) < 1, String(e.dbg.playhead));
});

await t('F4 heartbeat: <video> đang phát, tin đồng hồ cũ 0,9 s vẫn khớp; <video> khựng lâu thì thôi cộng', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const v = e.video(A, 30);
  e.up('clock', { id: A, offset: 100, mediaTime: 30, at: e.perf, paused: false, rate: 1 });
  v.currentTime = 30.9; await e.tick(900);
  assert.ok(Math.abs(e.dbg.playhead - 130.9) < 1e-9);
  v.currentTime = 31; await e.tick(2000);   // không có tin mới mà <video> đứng ở 31 s trong khi tin bảo ~32,9 s
  assert.equal(e.dbg.playhead, 31);
});

await t('F4 S6b: trình phát sang video B trước khi trang đổi slide: video A vẫn giữ độ lệch, không huỷ nhầm', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 600000), e.item(B, 600000)]);
  e.activeId = A; const va = e.video(A, 30); va.paused = true;
  e.up('clock', { id: A, offset: 300, mediaTime: 30, at: e.perf, paused: true, rate: 1 });
  for (let i = 0; i < 3; i++) await e.tick();
  assert.equal(e.dbg.playhead, 330);
  assert.ok(e.subs().includes(A + ':q330'));
  const before = e.subs().length;
  e.up('clock', { id: B, offset: 0, mediaTime: 0, at: e.perf, paused: false, rate: 1 });
  await e.tick();
  assert.equal(e.dbg.playhead, 330);
  assert.deepEqual(e.subs().slice(before), []);
  assert.deepEqual(e.cancels(), []);
});

await t('F6 video 12 s chưa dịch sẵn: chỉ gửi cả đoạn, không gửi thêm mẩu nhanh', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 12000)]);
  e.activeId = A; e.video(A, 0);
  for (let i = 0; i < 6; i++) await e.tick();
  assert.deepEqual(e.subs(), [A + ':0']);
});

await t('F6 lướt tới video dịch sẵn mà đoạn đầu còn đang tải: không tải lần hai bằng mẩu nhanh', async () => {
  const e = makeEnv({ fetchHang: (a, b) => b !== 65535 && b - a > 20000 });
  e.up('items', [e.item(A, 12000), e.item(B, 60000)]);
  e.activeId = A; e.video(A, 1);
  await e.tick();
  e.activeId = B; e.videos.delete(A); e.video(B, 0.5);
  for (let i = 0; i < 6; i++) await e.tick();
  assert.deepEqual(e.subs().filter((k) => k.includes(':q')), []);
  assert.equal(e.fetches.filter((f) => f.b !== 65535 && f.b - f.a <= 20000 && f.a < 20000 && f.url.includes('cdn')).length, 1);   // chỉ đoạn 0 của A
});

await t('F7 S4: đoạn 30 s tải chậm, phát liền 0 → 30 s: chỉ một mẩu nhanh (trước đây q0, q8, q16, q24)', async () => {
  const e = makeEnv({ fetchHang: (a, b) => b !== 65535 && b - a > 20000 });
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 0);
  for (let s = 0; s <= 30; s += 0.25) {
    v.currentTime = s; await e.tick(250);
    for (const k of [...e.replies.keys()]) if (k.includes(':q')) await e.reply(k, { status: 'ok', cues: [] });
  }
  // Ở đây chưa lượt tải nào đo được tốc độ (tải xong ngay hay treo), nên không có mẩu nối tiếp (SLOW_SLOT). Mẩu nối tiếp
  // khi một đoạn tải chậm bất thường: content-time-test.mjs.
  assert.deepEqual(e.subs().filter((k) => k.includes(':q')), [A + ':q0']);
});

await t('F7 S5: kéo thanh tiến trình 3 s: không mẩu nhanh nào lúc kéo, một mẩu ở chỗ thả', async () => {
  const e = makeEnv({ fetchHang: (a, b) => b !== 65535 && b - a > 20000 });   // đoạn 30 s tải lâu, mẩu nhanh tải ngay
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const v = e.video(A, 60);
  await e.tick(251);
  for (let i = 1; i < 12; i++) { v.currentTime = 60 + 4 * i; await e.tick(251); }
  assert.deepEqual(e.subs().filter((k) => k.includes(':q')), []);
  for (let i = 0; i < 4; i++) { v.currentTime += 0.25; await e.tick(251); }
  assert.deepEqual(e.subs().filter((k) => k.includes(':q')), [A + ':q104']);
  // Lượt tải bắt đầu trong lúc kéo: chỉ đoạn 30 s ở các chỗ đi qua (tối đa một lượt mỗi lần đổi đoạn), không có mẩu nhanh.
  const media = e.fetches.filter((f) => f.b !== 65535);
  assert.equal(media.filter((f) => f.b - f.a <= 20000).length, 1);
});

await t('Tua tới chỗ chưa dịch (như e2e "tua tới 85 s"): một mẩu nhanh ở chỗ tua, sau ~0,5 s', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  for (const k of [...e.replies.keys()]) await e.reply(k, { status: 'ok', cues: [] });
  const quickBefore = e.subs().filter((k) => k.includes(':q')).length;
  v.currentTime = 85; await e.tick();
  assert.equal(e.subs().filter((k) => k.includes(':q')).length, quickBefore);   // vừa nhảy: chưa gửi
  for (let i = 0; i < 6; i++) await e.tick();
  assert.deepEqual(e.subs().filter((k) => k.includes(':q')).slice(quickBefore), [A + ':q85']);
  assert.ok(e.subs().includes(A + ':3'));
});

await t('Tua: mẩu nhanh tải một mình trước, lượt tải đoạn 30 s đang dở bị ngắt và tải lại sau khi mẩu nhanh tải xong', async () => {
  const e = makeEnv({ fetchHang: (a) => a === 72000 });   // lượt tải đoạn [80,101) (đoạn trước chưa dịch: từ 72 s) chậm, không xong
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  for (const k of [...e.replies.keys()]) await e.reply(k, { status: 'ok', cues: [] });
  v.currentTime = 85; await e.tick();
  const grid1 = e.fetches.find((f) => f.a === 72000);
  assert.ok(grid1 && !grid1.aborted, 'đoạn 30 s bắt đầu tải ngay khi tua');
  for (let i = 0; i < 6; i++) await e.tick();
  const qi = e.fetches.findIndex((f) => f.a === 80500);   // mẩu nhanh [85,95) tải từ 80,5 s
  assert.ok(qi >= 0, 'có mẩu nhanh');
  assert.ok(grid1.aborted, 'lượt tải đoạn 30 s đang dở bị ngắt khi mẩu nhanh bắt đầu');
  const grid2 = e.fetches.findIndex((f, i) => f.a === 72000 && i > qi);
  assert.ok(grid2 > qi, 'đoạn 30 s tải lại sau mẩu nhanh');
  assert.deepEqual(e.subs().filter((k) => k.includes(':q')).slice(-1), [A + ':q85']);
});

await t('Lời bài hát: mặc định gửi lyrics: true; tắt trong popup thì xin lại kết quả có câu hát với lyrics: false, không huỷ việc đang ở server', async () => {
  // Đợt soát 31/10: trước đây đổi nút thì huỷ mọi việc đã gửi; huỷ giữa lúc nhận dạng thì lần gửi lại trả tiền ASR lần nữa.
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  const first = e.sent.filter((m) => m.type === 'subtitles');
  assert.ok(first.length && first.every((m) => m.payload.lyrics === true), JSON.stringify(first.map((m) => [m.key, m.payload.lyrics])));
  await e.reply(A + ':0', { status: 'skipped', label: 'singing', sung: 2, cues: [] });
  const waiting = [...e.replies.keys()];   // còn đang chờ server (mẩu nhanh)
  assert.deepEqual(waiting, [A + ':q2']);
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  for (let i = 0; i < 2; i++) await e.tick();
  assert.deepEqual(e.cancels(), [], 'không huỷ gì');
  const again = e.sent.filter((m) => m.type === 'subtitles').slice(first.length);
  assert.deepEqual(again.map((m) => [m.key, m.payload.lyrics]), [[A + ':0', false]]);
  // Mẩu nhanh gửi theo chế độ cũ, trả về không có câu hát: kết quả như nhau ở hai chế độ, giữ và hiện.
  await e.reply(A + ':q2', { status: 'ok', label: 'speech', sung: 0, cues: [C(2.2, 4, 'Lời nói')] });
  v.currentTime = 2.5; await e.tick();
  assert.equal(e.subText(), 'Lời nói');
});

await t('Đổi chế độ khi đoạn đang ở server: trả lời của chế độ cũ có câu hát thì bỏ, xin lại đúng phần âm thanh đó; không có câu hát thì giữ', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':0', { status: 'ok', label: 'speech', sung: 0, cues: [C(2, 4, 'Lời nói')] });
  for (let i = 0; i < 3; i++) await e.tick();
  assert.ok(e.replies.has(A + ':1'), 'đoạn 1 đang ở server');
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  await e.tick();
  await e.reply(A + ':1', { status: 'ok', label: 'speech', sung: 1, cues: [{ ...C(22, 24, 'hát cũ'), sung: true }] });
  for (let i = 0; i < 2; i++) await e.tick();
  const s1 = e.sent.filter((m) => m.type === 'subtitles' && m.key === A + ':1').map((m) => [m.payload.lyrics, m.payload.audioStart]);
  assert.deepEqual(s1, [[true, 18.5], [false, 18.5]]);
  assert.ok(!e.cancels().includes(A + ':1'), 'đoạn đang ở server không bị huỷ khi đổi nút');
  v.currentTime = 22.5; await e.tick();
  assert.notEqual(e.subText(), '♪ hát cũ', 'không hiện kết quả của chế độ cũ');
  v.currentTime = 2.5; await e.tick();
  assert.equal(e.subText(), 'Lời nói', 'đoạn 0 (không có câu hát) vẫn giữ');
});

await t('Đổi chế độ: kết quả sung = 0 mà có dòng ♪ (điệp khúc câu ngắn, ASR Gemini) cũng bị bỏ ngay và xin lại', async () => {
  // Bản sao phía extension của lỗi R1 (đợt soát 31/10): bỏ điều kiện "không có dòng ♪" thì dòng ♪ ở lại chế độ thường.
  const e = makeEnv();
  e.up('items', [e.item(A, 12000)]);
  e.activeId = A; const v = e.video(A, 1); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':0', { status: 'ok', label: 'speech', sung: 0, cues: [{ ...C(0.5, 2.8, 'Anh yêu em'), sung: true }] });
  await e.tick();
  assert.equal(e.subText(), '♪ Anh yêu em');
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  await e.tick();
  assert.equal(e.subText(), null, 'dòng ♪ rời màn hình ngay');
  assert.deepEqual(e.sent.filter((m) => m.type === 'subtitles' && m.key === A + ':0').map((m) => m.payload.lyrics), [true, false]);
});

await t('Đổi chế độ: đoạn lỗi giữ số lần lỗi và thời gian chờ, đoạn không có âm thanh giữ nguyên, không xin lại ngay', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':0', { status: 'error', error: 'HTTP 500' });
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':1', { status: 'no_audio' });
  const err = e.vid(A).chunks.get(0);
  assert.equal(err.status, 'error'); assert.equal(err.fails, 1);
  const sends = e.subs().length;
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  for (let i = 0; i < 2; i++) await e.tick();
  assert.equal(e.vid(A).chunks.get(0), err, 'giữ đúng mục lỗi (fails, wait)');
  assert.equal(e.vid(A).chunks.get(1).status, 'no_audio');
  assert.deepEqual(e.subs().slice(sends).filter((k) => k === A + ':0' || k === A + ':1'), []);
});

await t('Đổi chế độ khi đã qua một đoạn rồi tua về đầu đoạn đó: vẫn gửi dư 8 s như lần tua thường (§6e), không dùng phần gửi dư cũ', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':0', { status: 'ok', label: 'speech', sung: 1, cues: [{ ...C(2, 4, 'hát 0'), sung: true }] });
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':1', { status: 'ok', label: 'speech', sung: 1, cues: [{ ...C(36, 37.8, 'hát 1'), sung: true }] });
  v.currentTime = 65; for (let i = 0; i < 4; i++) await e.tick();
  for (const k of [2, 3]) if (e.replies.has(A + ':' + k)) await e.reply(A + ':' + k, { status: 'ok', label: 'speech', sung: 1, cues: [{ ...C(52 + 30 * (k - 2), 54 + 30 * (k - 2), 'hát ' + k), sung: true }] });
  for (let i = 0; i < 3; i++) await e.tick();
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  for (let i = 0; i < 3; i++) await e.tick();
  v.currentTime = 20.5; for (let i = 0; i < 6; i++) await e.tick();
  const s1 = e.sent.filter((m) => m.type === 'subtitles' && m.key === A + ':1').map((m) => [m.payload.lyrics, m.payload.audioStart]);
  assert.deepEqual(s1.at(-1), [false, 12]);
});

await t('Đổi chế độ: mẩu nhanh có câu hát bị bỏ thì gửi mẩu nhanh mới cho chỗ đang xem, không chờ cả đoạn 30 s', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 85); v.paused = true;
  for (let i = 0; i < 6; i++) await e.tick();
  assert.ok(e.replies.has(A + ':q85'), 'có mẩu nhanh ở 85 s');
  await e.reply(A + ':q85', { status: 'ok', label: 'speech', sung: 1, cues: [{ ...C(86, 88, 'hát nhanh'), sung: true }] });
  if (e.replies.has(A + ':3')) await e.reply(A + ':3', { status: 'ok', label: 'speech', sung: 1, cues: [{ ...C(86, 88, 'hát'), sung: true }] });
  await e.tick();
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  for (let i = 0; i < 4; i++) await e.tick();
  const q = e.sent.filter((m) => m.type === 'subtitles' && m.key === A + ':q85').map((m) => m.payload.lyrics);
  assert.deepEqual(q, [true, false]);
});

await t('Đổi chế độ lời bài hát: giữ kết quả không có câu hát (sub vẫn hiện, không tải lại, không xin lại), chỉ xin lại đoạn có câu hát', async () => {
  // Rà soát 31/10: trước đây bỏ hết kết quả, sub biến mất và nhãn "đang dịch…" tới khi tải lại âm thanh từ CDN.
  const e = makeEnv();
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':0', { status: 'ok', label: 'speech', sung: 0, cues: [C(2, 4, 'Lời nói')] });
  for (let i = 0; i < 3; i++) await e.tick();   // đoạn 1 chờ đoạn 0 xong mới gửi (holdBack)
  await e.reply(A + ':1', { status: 'skipped', label: 'singing', sung: 3, cues: [] });
  v.currentTime = 2.5; await e.tick();
  assert.equal(e.subText(), 'Lời nói');
  const first1 = e.sent.find((m) => m.type === 'subtitles' && m.key === A + ':1');
  const fetches = e.fetches.length, sends = e.sent.length;
  e.onChanged({ settings: { newValue: { lyrics: true } } }, 'local');
  await e.tick();
  assert.equal(e.subText(), 'Lời nói');
  const again = e.sent.slice(sends).filter((m) => m.type === 'subtitles');
  assert.deepEqual(again.map((m) => [m.key, m.payload.lyrics]), [[A + ':1', true]]);
  assert.equal(again[0].payload.audioStart, first1.payload.audioStart, 'gửi đúng phần âm thanh cũ');
  assert.deepEqual(e.fetches.slice(fetches).map((f) => f.a), [first1.payload.audioStart * 1000], 'chỉ tải lại đoạn có câu hát');
});

await t('Đổi chế độ lời bài hát lúc đang phát liền mạch: đoạn có câu hát gửi lại đúng phần âm thanh cũ (server dùng lại ASR)', async () => {
  // Mô phỏng của verifier 31/10: phát từ 2 s tới 35 s rồi tắt lời bài hát. Đoạn 0 cũng bị bỏ nên prevDone khác lần đầu:
  // đoạn 1 từng gửi dư 8 s (audioStart 12) thay vì 1,5 s (18,5) như lần đầu, mã băm âm thanh khác, trả tiền ASR lần nữa.
  const e = makeEnv();
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':0', { status: 'ok', label: 'speech', sung: 1, cues: [{ ...C(2, 4, 'hát 0'), sung: true }] });
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':1', { status: 'ok', label: 'speech', sung: 1, cues: [{ ...C(36, 37.8, 'hát 1'), sung: true }] });
  v.currentTime = 35; for (let i = 0; i < 4; i++) await e.tick();
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  for (let i = 0; i < 3; i++) await e.tick();
  const sends = e.sent.filter((m) => m.type === 'subtitles' && m.key === A + ':1');
  assert.deepEqual(sends.map((m) => [m.payload.lyrics, m.payload.audioStart]), [[true, 18.5], [false, 18.5]]);
});

await t('Đổi chế độ lời bài hát khi một đoạn đang tải: không ngắt lượt tải, gửi với chế độ mới', async () => {
  const e = makeEnv({ fetchHang: (a) => a === 18500 });   // đoạn [20,50) (gửi dư từ 18,5 s) tải lâu
  e.up('items', [e.item(A, 100000)]);
  e.activeId = A; const v = e.video(A, 2); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':0', { status: 'ok', label: 'speech', sung: 0, cues: [C(2, 4, 'Lời nói')] });
  for (let i = 0; i < 3; i++) await e.tick();
  const slow = e.fetches.find((f) => f.a === 18500);
  assert.ok(slow && slow.release, 'đoạn 1 đang tải');
  e.onChanged({ settings: { newValue: { lyrics: false } } }, 'local');
  await e.tick();
  assert.ok(!slow.aborted, 'lượt tải không bị ngắt');
  slow.release(); await e.flush(); await e.tick();
  assert.deepEqual(e.sent.filter((m) => m.type === 'subtitles' && m.key === A + ':1').map((m) => m.payload.lyrics), [false]);
  assert.equal(e.fetches.filter((f) => f.a === 18500).length, 1, 'tải một lần, không tải lại');
});

await t('Dòng hát (sung) hiện kèm "♪ "', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 12000)]);
  e.activeId = A; const v = e.video(A, 1); v.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':0', { status: 'ok', cues: [{ start: 0.5, end: 3, se: 2.8, vi: 'Ánh trăng nói hộ lòng anh', zh: '月亮代表我的心', sung: true }] });
  await e.tick();
  assert.equal(e.subText(), '♪ Ánh trăng nói hộ lòng anh');
});

await t('F9 lướt sang video đang tải / dừng ở 0: nhãn theo video mới, không giữ nhãn video trước', async () => {
  const e = makeEnv();
  const X = '7500000000000000001', Y = '7500000000000000003';
  e.up('items', [e.item(X, 12000), e.item(Y, 12000)]);
  e.activeId = X; e.video(X, 3);
  await e.tick(); await e.tick();
  await e.reply(X + ':0', { status: 'skipped', label: 'singing', from: 0, to: 13 });
  await e.tick(16);
  assert.equal(e.badge(), 'VI · bài hát');
  e.activeId = Y; e.videos.delete(X); const vb = e.video(Y, 0); vb.readyState = 0; vb.paused = true;
  for (let i = 0; i < 4; i++) await e.tick(100);
  assert.equal(e.badge(), 'VI · đang dịch…');
  await e.reply(Y + ':0', { status: 'ok', cues: [] });
  vb.readyState = 4;
  for (let i = 0; i < 5; i++) await e.tick(100);
  assert.equal(e.badge(), 'VI');
});

await t('F13 máy chủ trả file khác cỡ: bỏ mục lục cũ, lần thử sau tải lại mục lục và gửi được', async () => {
  let probes = 0;
  const e = makeEnv({ total: (a, b) => (b === 65535 ? (++probes === 1 ? 5000000 : 6000000) : 6000000) });
  e.up('items', [e.item(A, 12000)]);
  e.activeId = A; e.video(A, 3).paused = true;
  await e.tick();
  const c = e.vid(A).chunks.get(0);
  assert.equal(c.status, 'error');
  assert.equal(c.error, 'file video đã đổi');
  assert.equal(e.vid(A).media, null);
  assert.deepEqual(e.subs(), []);
  for (let i = 0; i < 22; i++) await e.tick(1000);
  assert.equal(probes, 2);
  assert.deepEqual(e.subs(), [A + ':0']);
});

await t('F15 tắt sub: huỷ đoạn đã gửi, mẩu nhanh, ngắt lượt tải dịch sẵn', async () => {
  const e = makeEnv({ fetchHang: (a, b) => a === 0 && b === 25999 });   // đoạn đầu của B (dịch sẵn) tải lâu
  e.up('items', [e.item(A, 100000), e.item(B, 60000)]);
  e.activeId = A; e.video(A, 30).paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  assert.ok(e.subs().includes(A + ':1') && e.subs().includes(A + ':q30'));
  const hanging = e.fetches.filter((f) => f.release && !f.aborted);
  assert.ok(hanging.length >= 1);
  e.onChanged({ settings: { newValue: { enabled: false } } }, 'local');
  await e.flush();
  assert.deepEqual(e.cancels().sort(), [...e.replies.keys()].sort());   // mọi yêu cầu đang chờ server
  assert.deepEqual(e.cancels().sort(), [A + ':1', A + ':q30']);
  assert.ok(hanging.every((f) => f.aborted));
});

await t('F2 server trả lỗi liên tục: thử lại sau 20 s, 60 s, 180 s; retryAfterMs lớn hơn thì theo nó', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 12000)]);
  e.activeId = A; e.video(A, 3).paused = true;
  const times = [];
  for (let s = 0; s < 900; s++) {
    await e.tick(1000);
    for (const k of [...e.replies.keys()]) {
      times.push((e.now - 1_000_000) / 1000);
      await e.reply(k, times.length === 4 ? { status: 'error', error: 'HTTP 401', retryAfterMs: 400000 } : { status: 'error', error: 'HTTP 401' });
    }
  }
  const gaps = times.slice(1).map((x, i) => x - times[i]);
  assert.deepEqual(gaps.slice(0, 4).map((g) => Math.round(g / 10) * 10), [20, 60, 180, 400], JSON.stringify(times));
});

await t('F11 rank: 0 cho video đang xem, 1, 2, 3 cho video dịch sẵn theo thứ tự sẽ lướt tới', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 12000), e.item(B, 12000), e.item(C2, 12000), e.item(D, 12000)]);
  e.activeId = A; e.video(A, 1).paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  const rank = Object.fromEntries(e.sent.filter((m) => m.type === 'subtitles').map((m) => [m.key, m.payload.rank]));
  assert.deepEqual(rank, { [A + ':0']: 0, [B + ':0']: 1, [C2 + ':0']: 2, [D + ':0']: 3 });
});

await t('F2 không gọi được server (chưa chạy npm start): thử lại mỗi 20 s, không giãn; server lên thì sub có trong ~20 s', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 12000)]);
  e.activeId = A; e.video(A, 3).paused = true;
  const sends = [];
  for (let s = 0; s < 200 && !sends.some(([, up]) => up); s++) {
    await e.tick(1000);
    const up = s >= 100;
    for (const k of [...e.replies.keys()]) {
      sends.push([Math.round((e.now - 1_000_000) / 1000), up]);
      await e.reply(k, up ? { status: 'ok', cues: [] } : { status: 'error', error: DOWN });
    }
  }
  const gaps = sends.slice(1).map(([x], i) => x - sends[i][0]);
  assert.ok(gaps.every((g) => g >= 20 && g <= 22), JSON.stringify(sends));
  assert.ok(sends.at(-1)[1] && sends.at(-1)[0] <= 100 + 22, JSON.stringify(sends));
});

await t('F2 server khởi động lại (lỗi dịch 2 lần, rồi tắt, rồi lên): đoạn đang chờ 60 s được gửi ngay khi server trả lời lại', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 12000), e.item(B, 12000)]);
  e.activeId = A; e.video(A, 3).paused = true;
  await e.tick(1000);
  await e.reply(B + ':0', { status: 'ok', cues: [] });
  await e.reply(A + ':0', { status: 'error', error: 'HTTP 401' });   // lỗi server: 20 s
  for (let i = 0; i < 21; i++) await e.tick(1000);
  await e.reply(A + ':0', { status: 'error', error: 'HTTP 401' });   // lần 2: 60 s
  // Server tắt: video C2 mới tới, gửi không được; server lên lại, C2 thử lại sau 20 s và được trả lời.
  e.up('items', [e.item(C2, 12000)]);
  await e.tick(1000);
  await e.reply(C2 + ':0', { status: 'error', error: DOWN });
  for (let i = 0; i < 21; i++) await e.tick(1000);
  const before = e.subs().length;
  await e.reply(C2 + ':0', { status: 'ok', cues: [] });
  await e.tick();
  assert.deepEqual(e.subs().slice(before), [A + ':0']);   // 23 s sau lỗi thứ hai, không phải 60 s
});

await t('F2 lỗi tải video sau 2 lỗi server: chờ 20 s (lỗi tải không tốn tiền), số lỗi server vẫn giữ', async () => {
  let bad = false;
  const e = makeEnv({ total: (a, b) => (bad && b !== 65535 ? 1 : 99999999) });
  e.up('items', [e.item(A, 12000)]);
  e.activeId = A; e.video(A, 3).paused = true;
  const times = [];
  for (let s = 0; s < 400 && times.length < 4; s++) {
    await e.tick(1000);
    const c0 = e.vid(A).chunks.get(0);
    if (bad && c0 && c0.error === 'file video đã đổi') bad = false;   // lỗi tải một lần
    for (const k of [...e.replies.keys()]) {
      times.push(Math.round((e.now - 1_000_000) / 1000));
      await e.reply(k, { status: 'error', error: 'HTTP 500' });
      if (times.length === 2) bad = true;                 // lượt tải sau: máy chủ trả file khác cỡ
    }
  }
  const gaps = times.slice(1).map((x, i) => x - times[i]);
  // 20 s (lỗi 1) → chờ 60 s thì gặp lỗi tải → 20 s → gửi được, lỗi server lần 3 → 180 s.
  assert.deepEqual(gaps.map((g) => Math.round(g / 10) * 10), [20, 80, 180], JSON.stringify(times));
  assert.equal(e.vid(A).chunks.get(0).fails, 4);
});

await t('F4 lướt mà trang đổi slide chậm 1,5 s: <video> cũ dừng, đồng hồ đã sang B, chỗ đang xem của A giữ 332 s', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 600000), e.item(B, 600000)]);
  e.activeId = A; const va = e.video(A, 32);
  e.up('clock', { id: A, offset: 300, mediaTime: 32, at: e.perf, paused: false, rate: 1 });
  for (let i = 0; i < 3; i++) { await e.tick(); va.currentTime += 0.26; e.up('clock', { id: A, offset: 300, mediaTime: va.currentTime, at: e.perf, paused: false, rate: 1 }); }
  await e.tick(10);
  const ph = e.dbg.playhead;
  assert.ok(ph > 332 && ph < 333, String(ph));
  const before = e.subs().length, cancels = e.cancels().length;
  va.paused = true;
  e.up('clock', { id: B, offset: 0, mediaTime: 0, at: e.perf, paused: false, rate: 1 });
  for (let i = 0; i < 6; i++) await e.tick(250);
  assert.equal(e.dbg.playhead, ph);
  assert.deepEqual(e.subs().slice(before), []);
  assert.deepEqual(e.cancels().slice(cancels), []);
});

await t('F15 tắt sub ở 300 s rồi bật lại: không tải, không gửi q0, :0 (chỗ đang xem không về 0)', async () => {
  const e = makeEnv();
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; e.video(A, 300).paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  for (const k of [...e.replies.keys()]) await e.reply(k, { status: 'ok', cues: [] });
  e.onChanged({ settings: { newValue: { enabled: false } } }, 'local');
  for (let i = 0; i < 3; i++) await e.tick();
  assert.equal(e.dbg.playhead, 300);
  const before = e.subs().length, fetches = e.fetches.length;
  e.onChanged({ settings: { newValue: { enabled: true } } }, 'local');
  await e.flush();
  for (let i = 0; i < 4; i++) await e.tick();
  assert.ok(e.subs().slice(before).every((k) => !/:q?0$/.test(k)), JSON.stringify(e.subs().slice(before)));
  assert.ok(e.fetches.slice(fetches).every((f) => f.b === 65535 || f.a >= 280000), JSON.stringify(e.fetches.slice(fetches)));
});

await t('Tua vào đoạn dịch trước còn đang tải: chờ; tải quá 2 s chưa xong (CDN chậm) thì gửi một mẩu nhanh', async () => {
  const e = makeEnv({ fetchHang: (a, b) => a >= 40000 && b - a > 20000 });   // đoạn [50,80) tải mãi không xong
  e.up('items', [e.item(A, 600000)]);
  e.activeId = A; const v = e.video(A, 25);
  await e.tick(); await e.tick();
  for (const k of [...e.replies.keys()]) await e.reply(k, { status: 'ok', cues: [] });
  v.currentTime = 30; v.paused = true; await e.tick();   // đoạn [50,80) vào tầm dịch trước: bắt đầu tải
  await e.tick(); await e.tick();
  assert.ok(e.vid(A).chunks.get(2) && !e.vid(A).chunks.get(2).sent);
  v.currentTime = 55; await e.tick();                    // tua vào đúng đoạn đó
  for (let i = 0; i < 3; i++) await e.tick();             // đoạn đó đã tải 1,6 s: chưa gửi mẩu nhanh
  assert.deepEqual(e.subs().filter((k) => k.includes(':q')), []);
  for (let i = 0; i < 2; i++) await e.tick();             // quá 2 s kể từ lúc bắt đầu tải
  assert.deepEqual(e.subs().filter((k) => k.includes(':q')), [A + ':q55']);
});

await t('F10 nhiều danh sách: video kế tiếp lấy theo danh sách chứa video đang xem (feed, liên quan)', async () => {
  const e = makeEnv();
  const R1 = '7600000000000000001', R2 = '7600000000000000002';
  e.up('items', [e.item(A, 12000, 'feed'), e.item(B, 12000, 'feed')]);
  e.up('items', [e.item(R1, 12000, 'related'), e.item(R2, 12000, 'related')]);
  e.up('items', [e.item(C2, 12000, 'feed')]);
  e.activeId = A; e.video(A, 1).paused = true;
  await e.tick();
  assert.deepEqual([...e.dbg.wanted].sort(), [A + ':0', B + ':0', C2 + ':0']);
  e.activeId = R1; e.videos.clear(); e.video(R1, 1).paused = true;
  await e.tick();
  assert.deepEqual([...e.dbg.wanted].sort(), [R1 + ':0', R2 + ':0']);
  e.activeId = D; e.videos.clear(); e.video(D, 1).paused = true;   // không thuộc danh sách nào: video feed chưa xem
  await e.tick();
  assert.deepEqual([...e.dbg.wanted].sort(), [B + ':0', C2 + ':0', D + ':0']);
});

await t('Trang tìm kiếm sau khi tìm từ feed: slide feed cũ (ẩn) vẫn mang feed-active-video, video khác đang phát: không hiện sub và nhãn của video feed lên nó', async () => {
  // Đo 1/11: chuyển trang phía client, slide feed cũ ở lại trong DOM; sub "♪ …" của video 29 s hiện đè lên video xem trước
  // 628 s của trang tìm kiếm (videoFor lấy thẻ <video> lớn nhất đang thấy).
  // Video feed đang xem ở giây 200: chỗ đang xem đọc ra 0 (không thấy video nào) thì từng tải và gửi dịch [0,20), [20,50).
  const e = makeEnv();
  e.up('items', [e.item(A, 300000)]);
  e.activeId = A; const fv = e.video(A, 200); fv.paused = true;
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(A + ':7', { status: 'ok', cues: [C(199, 211, 'Sub của video feed')] });
  await e.tick();
  assert.equal(e.subText(), 'Sub của video feed');
  const nSent = e.subs().length;
  e.href = 'https://www.douyin.com/root/search/x?aid=1';
  fv.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  const pv = e.video('preview', 5);
  for (let i = 0; i < 4; i++) { pv.currentTime += 0.26; await e.tick(); }
  assert.equal(e.subText(), null);
  assert.equal(e.badge(), null);
  e.up('items', [e.item(B, 60000, 'search')]);   // kết quả tìm kiếm tới sau
  for (let i = 0; i < 4; i++) { pv.currentTime += 0.26; await e.tick(); }
  assert.deepEqual(e.subs().slice(nSent), [], 'không gửi dịch gì cho video không có trên màn hình');
});

await t('Trang kết quả tìm kiếm (chưa mở video): không dịch thẻ kết quả hay video xem trước tự phát; mở modal thì dịch', async () => {
  // Verifier 1/11: bản vá trang tìm kiếm làm các kết quả đầu thành video dịch được; thẻ ở giữa màn hình mang data-e2e-vid
  // thì content.js lấy nó làm video đang xem, dịch đoạn đầu và dịch sẵn 4 kết quả sau mà người xem chưa bấm gì.
  const e = makeEnv();
  const S = ['7600000000000000001', '7600000000000000002', '7600000000000000003'];
  e.href = 'https://www.douyin.com/search/abc';
  e.up('items', S.map((id) => e.item(id, 120000, 'search')));
  const pv = e.video('preview', 3);
  const card = { getAttribute: (n) => (n === 'data-e2e-vid' ? S[0] : null), querySelector: (q) => (q === 'video' ? pv : null) };
  card.closest = () => card;
  e.center = card;
  for (let i = 0; i < 20; i++) await e.tick();
  e.href = 'https://www.douyin.com/video/' + S[1] + '/search/abc';   // tìm từ trang /video/: kết quả phủ lên trang video
  for (let i = 0; i < 20; i++) await e.tick();
  assert.deepEqual(e.subs(), []);
  assert.equal(e.badge(), null);
  e.href = 'https://www.douyin.com/search/abc?modal_id=' + S[0];
  for (let i = 0; i < 3; i++) await e.tick();
  assert.ok(e.subs().includes(S[0] + ':0'), String(e.subs()));
});

await t('Đóng modal (không còn video nào đang thấy): không gửi thêm, sau ~1 s huỷ việc đã gửi của video đó, giữ việc dịch sẵn kết quả kế', async () => {
  const e = makeEnv();
  const M = '7600000000000000009', N = '7600000000000000010';
  e.href = 'https://www.douyin.com/search/abc?modal_id=' + M;
  e.up('items', [e.item(M, 300000, 'search'), e.item(N, 60000, 'search')]);
  const v = e.video(M, 200);
  for (let i = 0; i < 4; i++) { v.currentTime += 0.26; await e.tick(); }
  const sent = e.subs().filter((k) => k.startsWith(M));
  assert.ok(sent.length >= 2, String(sent));
  assert.ok(e.subs().includes(N + ':0'), 'kết quả kế được dịch sẵn: ' + e.subs());
  e.href = 'https://www.douyin.com/search/abc'; e.videos.delete(M);
  await e.tick(); await e.tick();   // ~0,5 s: chưa huỷ (lúc lướt, giữa hai slide có thể không thấy video nào)
  assert.deepEqual(e.cancels(), []);
  for (let i = 0; i < 6; i++) await e.tick();
  // Trước đây: chỗ đang xem về 0, gửi thêm :0 và q0 của video vừa đóng; bản vá trước: không gửi thêm nhưng cũng không huỷ.
  assert.deepEqual(e.subs().filter((k) => k.startsWith(M)), sent);
  assert.deepEqual(e.cancels().sort(), [...sent].sort());
  // Đóng modal rồi mở kết quả kế là luồng thường: việc dịch sẵn N:0 không bị huỷ rồi gửi lại (verifier 1/11).
  e.href = 'https://www.douyin.com/search/abc?modal_id=' + N; e.video(N, 0);
  for (let i = 0; i < 4; i++) await e.tick();
  assert.equal(e.subs().filter((k) => k === N + ':0').length, 1, String(e.subs()));
});

await t('Đóng modal lúc một đoạn của video đó đang tải: tải xong trong 1 s chờ thì không gửi', async () => {
  // Verifier 1/11: trong 1 s chờ, đoạn tải xong vẫn được gửi rồi mới bị huỷ (server có thể đã bắt đầu nhận dạng).
  const M = '7600000000000000009';
  const e = makeEnv({ fetchHang: (a, b) => b !== 65535 && a >= 18000 && a < 19000 });
  e.href = 'https://www.douyin.com/search/abc?modal_id=' + M;
  e.up('items', [e.item(M, 300000, 'search')]);
  e.video(M, 0);
  for (let i = 0; i < 3; i++) await e.tick();
  await e.reply(M + ':0', { status: 'ok', cues: [] });   // đoạn [0,20) xong thì đoạn [20,50) mới tải (holdBack)
  for (let i = 0; i < 2; i++) await e.tick();
  const hung = e.fetches.find((f) => f.a >= 18000 && f.a < 19000 && f.release);
  assert.ok(hung, 'đoạn [20,50) phải đang tải: ' + e.fetches.map((f) => f.a));
  e.href = 'https://www.douyin.com/search/abc'; e.videos.delete(M);
  await e.tick();
  hung.release(); await e.flush();
  await e.tick();
  assert.ok(!e.subs().includes(M + ':1'), String(e.subs()));
});

await t('HTTP 429 khi tải video: không gọi lại ngay, mọi lượt tải (cả dịch sẵn) nghỉ 5 s, nhãn nói rõ; hết nghỉ thì tải lại và gửi mẩu nhanh', async () => {
  // Đo 1/11: nhãn "lỗi: tải video: HTTP 429" ~24 s. Trước đây gọi lại ngay bằng link kia, đoạn kế cũng tải (lại 429),
  // rồi mỗi đoạn tự chờ 20 s; mẩu nhanh mất luôn.
  let block = true;
  const e = makeEnv({ status: (a, b) => (block && b !== 65535 ? 429 : 206) });
  e.up('items', [e.item(A, 87000)]);
  e.activeId = A; const v = e.video(A, 3); v.paused = true;
  await e.tick();
  const media = () => e.fetches.filter((f) => f.b !== 65535);
  assert.equal(media().length, 1, 'số lượt tải phần âm thanh: ' + JSON.stringify(media().map((f) => [f.a, f.status])));
  const t429 = media()[0].at;
  await e.tick();
  assert.equal(e.badge(), 'VI · lỗi: Douyin tạm chặn tải video (HTTP 429), thử lại sau 5 s');
  e.up('items', [e.item(B, 60000)]);   // video kế tiếp tới trong lúc nghỉ
  block = false;
  const n0 = e.fetches.length;
  while (e.now < t429 + 4900) await e.tick();
  assert.equal(e.fetches.length, n0, 'không tải gì trong lúc nghỉ (cả mục lục, dịch sẵn, mẩu nhanh)');
  assert.deepEqual(e.subs(), []);
  for (let i = 0; i < 4; i++) await e.tick();
  const next = e.fetches[n0];
  assert.ok(next && next.at - t429 >= 5000 && next.at - t429 <= 5300, 'tải lại sau ' + (next && next.at - t429) + ' ms');
  for (const k of [A + ':q3', A + ':0', B + ':0']) assert.ok(e.subs().includes(k), k + ' chưa gửi: ' + JSON.stringify(e.subs()));
});

await t('HTTP 429 lặp lại: nghỉ 5 s, 15 s, 45 s; tải được thì tính lại từ đầu; Retry-After dài hơn thì theo nó', async () => {
  let block = 3, ra = null;   // số lượt tải phần âm thanh còn bị 429; header Retry-After
  const e = makeEnv({ status: (a, b) => (b !== 65535 && block > 0 ? (block--, 429) : 206), retryAfter: () => ra });
  e.up('items', [e.item(A, 12000)]);
  e.activeId = A; e.video(A, 3).paused = true;
  const times = () => e.fetches.filter((f) => f.b !== 65535).map((f) => (f.at - 1_000_000) / 1000);
  for (let s = 0; s < 120 && !e.replies.has(A + ':0'); s++) await e.tick(1000);
  const ta = times();
  assert.deepEqual(ta.slice(1).map((x, i) => Math.floor(x - ta[i])), [5, 15, 45], JSON.stringify(ta));
  await e.reply(A + ':0', { status: 'ok', cues: [] });
  block = 1; ra = '30';
  e.up('items', [e.item(B, 12000)]);
  for (let s = 0; s < 60 && !e.replies.has(B + ':0'); s++) await e.tick(1000);
  const tb = times().slice(ta.length);
  assert.deepEqual(tb.slice(1).map((x, i) => Math.floor(x - tb[i])), [30], JSON.stringify(tb));   // không phải 45 s: đã tính lại
  // Retry-After quá dài (600 s) chỉ theo tới 2 phút: mọi video đều không tải được trong lúc nghỉ.
  await e.reply(B + ':0', { status: 'ok', cues: [] });
  block = 1; ra = '600';
  e.up('items', [e.item(C2, 12000)]);
  for (let s = 0; s < 300 && !e.replies.has(C2 + ':0'); s++) await e.tick(1000);
  const tc = times().slice(ta.length + tb.length);
  assert.deepEqual(tc.slice(1).map((x, i) => Math.floor(x - tc[i])), [120], JSON.stringify(tc));
});

// ---- tap.main.js trong vm: đọc __pace_f, đồng hồ trình phát.
const aw = (id) => ({ aweme_id: id, duration: 12000, video: { play_addr: { uri: 'v0d00f' + id, url_list: [] }, bit_rate: [] } });
function makeTap(href) {
  const env = { perf: 0, rafs: [], up: [], listeners: {}, docListeners: {} };
  const ctx = {
    location: new URL(href), performance: { now: () => env.perf }, requestAnimationFrame: (cb) => env.rafs.push(cb), setInterval: () => 0,
    document: { addEventListener: (t, f) => { env.docListeners[t] = f; }, getElementById: () => null },
    XMLHttpRequest: function () {}, URL, JSON, console,
    // Trang gọi API: trả JSON có một video (tap.main.js chỉ đọc bản sao của response).
    fetch: () => { const body = { aweme_list: [aw(C2)] };
      const res = { headers: { get: () => 'application/json' }, clone: () => res, json: async () => body }; return Promise.resolve(res); },
    addEventListener: (t, f) => { env.listeners[t] = f; },
    dispatchEvent: (ev) => { if (ev.type === '__tod_alpha_up') env.up.push(JSON.parse(ev.detail)); },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  ctx.__pace_f = [[1, '8:' + JSON.stringify(['$', '$La', null, { awemeList: [aw(A), aw(B)] }]) + '\n']];
  vm.runInContext(fs.readFileSync(path.join(EXT, 'tap.main.js'), 'utf8'), ctx);
  env.listeners.__tod_alpha_down({ detail: JSON.stringify({ type: 'ready' }) });
  env.docListeners.DOMContentLoaded();
  env.ctx = ctx;
  env.frame = (ms) => { env.perf += ms; for (const cb of env.rafs.splice(0)) cb(env.perf); };
  return env;
}

await t('F10 __pace_f chỉ là feed khi trang tải ở feed (/, /?recommend, /jingxuan), không ở /video/…, ?modal_id=', async () => {
  const feedOf = (href) => makeTap(href).up.filter((m) => m.type === 'items').flatMap((m) => m.data).map((it) => it.feed);
  assert.deepEqual(feedOf('https://www.douyin.com/'), ['feed', 'feed']);
  assert.deepEqual(feedOf('https://www.douyin.com/?recommend=1'), ['feed', 'feed']);
  assert.deepEqual(feedOf('https://www.douyin.com/jingxuan'), ['feed', 'feed']);
  assert.deepEqual(feedOf('https://www.douyin.com/jingxuan?modal_id=' + A), [null, null]);
  assert.deepEqual(feedOf('https://www.douyin.com/video/' + A), [null, null]);
  assert.deepEqual(feedOf('https://www.douyin.com/user/MS4wLjAB'), [null, null]);
});

await t('F10 tap.main.js: mỗi API một danh sách (feed, related, post, search, mix); detail, favorite không thuộc danh sách nào', async () => {
  const env = makeTap('https://www.douyin.com/user/MS4wLjAB');
  for (const [p, want] of [['/aweme/v1/web/tab/feed/?count=10', 'feed'], ['/aweme/v2/web/module/feed/', 'feed'],
    ['/aweme/v1/web/aweme/related/?aweme_id=1', 'related'], ['/aweme/v1/web/aweme/post/?sec_user_id=x', 'post'],
    ['/aweme/v1/web/general/search/single/?keyword=x', 'search'], ['/aweme/v1/web/mix/aweme/?mix_id=1', 'mix'],
    ['/aweme/v1/web/aweme/detail/?aweme_id=1', null], ['/aweme/v1/web/aweme/favorite/?count=2', null]]) {
    env.up.length = 0;
    await env.ctx.fetch('https://www.douyin.com' + p);
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    const its = env.up.filter((m) => m.type === 'items').flatMap((m) => m.data);
    assert.equal(its.length, 1, p);
    assert.equal(its[0].feed, want, p);
  }
});

await t('F4 tap.main.js gửi vị trí <video> kèm độ lệch: khi đổi, khi <video> nhảy, và nhắc lại mỗi ~500 ms', async () => {
  const env = makeTap('https://www.douyin.com/');
  const media = { currentTime: 10, paused: false, playbackRate: 1, closest: () => null };
  env.ctx.player = { config: { baseConfig: { mediaInfo: { id: A } } }, media, get currentTime() { return media.currentTime + 50; } };
  const clocks = () => env.up.filter((m) => m.type === 'clock').map((m) => m.data);
  for (let i = 0; i < 60; i++) { media.currentTime += 1 / 60; env.frame(1000 / 60); }   // 1 s phát bình thường
  const n1 = clocks().length;
  assert.ok(n1 >= 2 && n1 <= 3, 'số tin trong 1 s: ' + n1);
  const c = clocks()[0];
  assert.deepEqual(Object.keys(c).sort(), ['at', 'id', 'mediaTime', 'offset', 'paused', 'rate']);
  assert.equal(c.id, A); assert.equal(c.offset, 50); assert.equal(c.paused, false); assert.equal(c.rate, 1);
  media.currentTime = 3; env.frame(16);                                                   // <video> tua (độ lệch không đổi)
  assert.equal(clocks().length, n1 + 1);
  assert.equal(clocks().at(-1).mediaTime, 3);
  media.paused = true; env.frame(16);
  assert.equal(clocks().length, n1 + 2);
  assert.equal(clocks().at(-1).paused, true);
});

console.log(failed ? `\n${failed} kiểm tra trượt, ${n} đạt.` : `\n${n} kiểm tra đều đạt.`);
process.exit(failed ? 1 : 0);

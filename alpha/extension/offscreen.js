// Trang ẩn (offscreen) của đường dự phòng: thu âm thanh tab người xem đã bật trong popup, ghi từng khúc WebM/Opus, gửi server
// trên máy, chuyển dòng sub về background.js (background chuyển tiếp cho tab.js trong tab đó). Một tab mỗi lúc.
'use strict';
const L = globalThis.TodLive;
let run = null;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.to !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg).then(() => reply({ ok: true }), (e) => { stop(); reply({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }
  if (msg.type === 'stop') { stop('đã tắt'); reply({ ok: true }); return false; }
  if (msg.type === 'status') {
    reply(run ? { on: true, tabId: run.tabId, sent: run.sent, ok: run.ok, skipped: run.skipped, quiet: run.quiet, errors: run.errors } : { on: false });
    return false;
  }
  return false;
});

const tell = (r, m) => chrome.runtime.sendMessage({ ...m, to: 'background', tabId: r.tabId }).catch(() => {});
const sec = (r) => (performance.now() - r.t0) / 1000;

async function start({ streamId, tabId, settings = {}, title = '' }) {
  if (run) stop('bắt đầu lại');
  const base = String(settings.server || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('Bản Alpha chỉ gọi server trên máy (127.0.0.1 hoặc localhost).');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  // Thu tab thì Chrome không phát tiếng tab ra loa nữa: phát lại qua AudioContext để người xem vẫn nghe.
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // liveMonitor: false chỉ dùng khi thử tự động (alpha/dev/real/tablive-real.mjs): không phát ra loa máy đo.
  if (settings.liveMonitor !== false) src.connect(ctx.destination);
  const an = ctx.createAnalyser();
  an.fftSize = 2048;
  src.connect(an);
  // id "tab" + 16 chữ số: server nhận /^tab\d{6,25}$/. Mỗi lượt thu một id: cache, ngữ cảnh đoạn trước theo id này.
  const id = 'tab' + Date.now() + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const r = run = { id, base, tabId, stream, ctx, settings, title, t0: performance.now(), wall0: Date.now(), timers: new Set(), recs: new Set(), levels: [],
    sent: 0, ok: 0, skipped: 0, quiet: 0, errors: 0 };
  const buf = new Float32Array(an.fftSize);
  r.timers.add(setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let m = 0;
    for (const x of buf) if (Math.abs(x) > m) m = Math.abs(x);
    r.levels.push([sec(r), m]);
    if (r.levels.length > 1200) r.levels.splice(0, 600);
  }, 100));
  stream.getAudioTracks()[0].addEventListener('ended', () => { if (run === r) stop('tab đã đóng hay dừng thu'); });
  schedule(r, 0);
  tell(r, { type: 'state', on: true });
}

// Gọi đúng lúc khúc k bắt đầu thu; hẹn khúc k + 1. Hai khúc liền nhau thu chồng lên nhau PRE + TAIL giây.
function schedule(r, k) {
  const tail = Number(r.settings.liveTail) > 0 ? Math.min(6, Number(r.settings.liveTail)) : L.TAIL;
  const w = L.windowOf(k, tail);
  const at = (t, fn) => {
    const h = setTimeout(() => { r.timers.delete(h); if (run === r) fn(); }, Math.max(0, t * 1000 - (performance.now() - r.t0)));
    r.timers.add(h);
  };
  record(r, w, at);
  at(L.windowOf(k + 1).recStart, () => schedule(r, k + 1));
}

function record(r, w, at) {
  // Mỗi khúc một MediaRecorder riêng: file WebM tự đủ (có phần đầu), server đọc từng file bằng ffmpeg.
  const rec = new MediaRecorder(r.stream, { mimeType: 'audio/webm;codecs=opus' });
  const parts = [];
  const audioStart = sec(r);
  rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  rec.onstop = () => {
    r.recs.delete(rec);
    if (run !== r) return;
    if (L.silent(r.levels, audioStart, sec(r))) { r.quiet++; return; }
    send(r, w, new Blob(parts, { type: 'audio/webm' }), audioStart);
  };
  rec.start();
  r.recs.add(rec);
  at(w.recStop, () => { if (rec.state !== 'inactive') rec.stop(); });
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function send(r, w, blob, audioStart) {
  const s = r.settings;
  const body = {
    id: r.id, aac: await toBase64(blob), fmt: 'webm', from: w.from, to: w.to, audioStart: Math.round(audioStart * 1000) / 1000,
    ...(w.k > 0 ? { prev: [w.from - L.W, w.from] } : {}),
    target: s.target || 'vi', lyrics: s.lyrics !== false, desc: r.title, hashtags: [], urgent: true,
  };
  r.sent++;
  try {
    const res = await fetch(r.base + '/v1/subtitles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const o = await res.json().catch(() => ({}));
    if (run !== r) return;
    if (o.status === 'ok') { r.ok++; if (o.cues && o.cues.length) tell(r, { type: 'cues', cues: o.cues, wall0: r.wall0 }); }
    else if (o.status === 'skipped') r.skipped++;
    else { r.errors++; tell(r, { type: 'state', on: true, error: o.error || 'HTTP ' + res.status }); }
  } catch (_) {
    if (run !== r) return;
    r.errors++;
    tell(r, { type: 'state', on: true, error: 'không kết nối được server (đã chạy "npm start" trong alpha/server chưa?)' });
  }
}

function stop(reason) {
  const r = run;
  if (!r) return;
  run = null;
  for (const h of r.timers) clearTimeout(h), clearInterval(h);
  for (const rec of r.recs) if (rec.state !== 'inactive') rec.stop();
  for (const t of r.stream.getTracks()) t.stop();
  r.ctx.close().catch(() => {});
  tell(r, { type: 'state', on: false, reason });
}

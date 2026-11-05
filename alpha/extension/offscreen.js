// Trang ẩn (offscreen) của đường dự phòng: thu âm thanh tab người xem đã bật trong popup vào bộ đệm liên tục (16 kHz), gửi
// server trên máy phần chưa dịch (tablive.js: plan, advance), chuyển dòng sub về background.js (background chuyển tiếp cho
// tab.js trong tab đó). Một tab mỗi lúc.
'use strict';
const L = globalThis.TodLive;
const KEEP = 90;   // giây âm thanh giữ trong bộ đệm
let run = null;

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.to !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg).then(() => reply({ ok: true }), (e) => { stop(); reply({ ok: false, error: String((e && e.message) || e) }); });
    return true;
  }
  if (msg.type === 'stop') { stop('đã tắt'); reply({ ok: true }); return false; }
  if (msg.type === 'status') {
    reply(run ? { on: true, tabId: run.tabId, sent: run.sent, ok: run.ok, skipped: run.skipped, quiet: run.quiet, held: run.held, errors: run.errors } : { on: false });
    return false;
  }
  return false;
});

const tell = (r, m) => chrome.runtime.sendMessage({ ...m, to: 'background', tabId: r.tabId }).catch(() => {});
const nowSec = (r) => r.n / L.RATE;   // đồng hồ theo số mẫu đã nhận

async function start({ streamId, tabId, settings = {}, title = '' }) {
  if (run) stop('bắt đầu lại');
  const base = String(settings.server || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) throw new Error('Bản Alpha chỉ gọi server trên máy (127.0.0.1 hoặc localhost).');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // Thu tab thì Chrome không phát tiếng tab ra loa nữa: phát lại để người xem vẫn nghe. liveMonitor: false chỉ dùng khi thử tự
  // động (alpha/dev/real/tablive-real.mjs): không phát ra loa máy đo.
  if (settings.liveMonitor !== false) src.connect(ctx.destination);
  // Lấy mẫu: ScriptProcessor (đủ cho bản thử), hạ xuống 16 kHz bằng trung bình cộng, ghi vào bộ đệm vòng KEEP giây.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
  const id = 'tab' + Date.now() + String(Math.floor(Math.random() * 1000)).padStart(3, '0');
  const r = run = { id, base, tabId, stream, ctx, proc, settings, title, ring: new Int16Array(KEEP * L.RATE), n: 0, acc: 0, accN: 0, pos: 0,
    wall0: 0, cursor: 0, lastTo: 0, busy: false, prev: null, timer: null, sent: 0, ok: 0, skipped: 0, quiet: 0, held: 0, errors: 0 };
  const step = ctx.sampleRate / L.RATE;
  proc.onaudioprocess = (e) => {
    if (run !== r) return;
    if (!r.wall0) r.wall0 = Date.now() - (e.inputBuffer.duration * 1000);
    const x = e.inputBuffer.getChannelData(0);
    for (let i = 0; i < x.length; i++) {
      r.acc += x[i]; r.accN++; r.pos += 1;
      if (r.pos >= step) {
        r.pos -= step;
        const v = Math.max(-1, Math.min(1, r.acc / r.accN));
        r.ring[r.n % r.ring.length] = v * 32767;
        r.n++; r.acc = 0; r.accN = 0;
      }
    }
  };
  stream.getAudioTracks()[0].addEventListener('ended', () => { if (run === r) stop('tab đã đóng hay dừng thu'); });
  r.timer = setInterval(() => tick(r), 500);
  tell(r, { type: 'state', on: true });
}

// Mẫu trong [a, b) giây (phần đã bị ghi đè trong bộ đệm vòng thì bỏ).
function slice(r, a, b) {
  const i0 = Math.max(Math.round(a * L.RATE), r.n - r.ring.length, 0), i1 = Math.min(Math.round(b * L.RATE), r.n);
  const out = new Int16Array(Math.max(0, i1 - i0));
  for (let i = i0; i < i1; i++) out[i - i0] = r.ring[i % r.ring.length];
  return out;
}

function tick(r) {
  if (run !== r || r.busy || !r.wall0) return;
  const now = nowSec(r);
  const p = L.plan(r.cursor, r.lastTo, now);
  if (!p) return;
  // Im lặng từ con trỏ tới giờ: bỏ qua, không gửi.
  if (L.peak(slice(r, r.cursor, now)) < L.QUIET) { r.quiet++; r.cursor = r.lastTo = now; return; }
  // Cắt ở khoảng ngừng nói gần cuối nhất (nếu có): câu cuối đã xong, gửi final.
  const pcm = slice(r, p.audioFrom, now);
  const pause = L.findPause(pcm);
  const cut = pause != null ? p.audioFrom + pause : null;
  if (cut != null && cut - r.cursor >= 2) {
    const to = Math.round(cut * 10) / 10;
    send(r, { ...p, to, final: true }, pcm.subarray(0, Math.round((to - p.audioFrom) * L.RATE)));
  } else send(r, p, pcm);
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function send(r, p, pcm) {
  const s = r.settings;
  const body = {
    id: r.id, aac: toBase64(L.wav(pcm)), fmt: 'wav', from: p.from, to: p.to, audioStart: Math.round(p.audioFrom * 1000) / 1000,
    ...(r.prev ? { prev: r.prev } : {}), ...(p.final ? { final: true } : {}),
    target: s.target || 'vi', lyrics: s.lyrics !== false, desc: r.title, hashtags: [], urgent: true,
  };
  r.busy = true;
  r.sent++;
  let o = null;
  try {
    const res = await fetch(r.base + '/v1/subtitles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    o = await res.json().catch(() => ({}));
    if (run !== r) return;
    if (o.status === 'ok') { r.ok++; if (o.cues && o.cues.length) tell(r, { type: 'cues', cues: o.cues, wall0: r.wall0 }); }
    else if (o.status === 'skipped') r.skipped++;
    else { r.errors++; tell(r, { type: 'state', on: true, error: o.error || 'HTTP ' + res.status }); }
  } catch (_) {
    if (run !== r) return;
    r.errors++;
    tell(r, { type: 'state', on: true, error: 'không kết nối được server (đã chạy "npm start" trong alpha/server chưa?)' });
  } finally {
    if (run === r) {
      // Câu cuối còn dở: con trỏ dời về mốc câu đó (server trả next), lần sau gửi lại câu ấy cùng âm thanh mới.
      const next = L.advance(r.cursor, p.to, o && (o.status === 'ok' || o.status === 'skipped') ? o : null);
      if (next < p.to) r.held++;
      r.cursor = next;
      r.lastTo = p.to;
      if (o && o.status === 'ok') r.prev = [p.from, p.to];
      r.busy = false;
    }
  }
}

function stop(reason) {
  const r = run;
  if (!r) return;
  run = null;
  clearInterval(r.timer);
  r.proc.onaudioprocess = null;
  for (const t of r.stream.getTracks()) t.stop();
  r.ctx.close().catch(() => {});
  tell(r, { type: 'state', on: false, reason });
}

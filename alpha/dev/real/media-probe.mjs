// Đo cách các trang nạp video (chỉ đọc, không tải gì thêm): trình phát dùng Media Source Extensions (nạp từng mẩu, src là blob:)
// hay gắn thẳng file (src http); mỗi SourceBuffer kiểu gì (âm thanh riêng hay gộp); trình phát nạp trước bao nhiêu giây so với chỗ
// đang xem; có mã hoá (EME/DRM) không. Chromium riêng cổng 9334, hồ sơ tạm, tắt tiếng, khách. In bảng tóm tắt, không ghi nội dung.
//   node media-probe.mjs <url> [<url>…] [--seconds 30] [--next-at 15]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { args, playwright, sleep } from './lib.mjs';

const a = args();
const seconds = Number(a.seconds || 30);
const HOOK = () => {
  const st = window.__todProbe = { sbs: [], appends: 0, bytes: 0, eme: false, objUrls: 0 };
  const MS = window.MediaSource || window.ManagedMediaSource;
  for (const C of [window.MediaSource, window.ManagedMediaSource].filter(Boolean)) {
    const add = C.prototype.addSourceBuffer;
    C.prototype.addSourceBuffer = function (mime) {
      const sb = add.call(this, mime);
      const rec = { mime, appends: 0, bytes: 0, firstBytes: null };
      st.sbs.push(rec);
      const app = sb.appendBuffer;
      sb.appendBuffer = function (buf) {
        const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        rec.appends++; rec.bytes += u8.length; st.appends++; st.bytes += u8.length;
        if (!rec.firstBytes) rec.firstBytes = Array.from(u8.slice(4, 8)).map((c) => String.fromCharCode(c)).join('');
        return app.call(this, buf);
      };
      return sb;
    };
  }
  const rmk = navigator.requestMediaKeySystemAccess;
  if (rmk) navigator.requestMediaKeySystemAccess = function (...x) { st.eme = true; return rmk.apply(this, x); };
  const cu = URL.createObjectURL;
  URL.createObjectURL = function (o) { if (MS && o instanceof MS) st.objUrls++; return cu.call(this, o); };
};
const STATE = () => {
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const vs = [...document.querySelectorAll('video')];
  const v = vs.filter((x) => area(x) > 0).sort((p, q) => (q.paused ? 0 : 1) - (p.paused ? 0 : 1) || area(q) - area(p))[0];
  if (v && v.paused) { v.muted = true; v.play().catch(() => {}); }
  let ahead = null;
  if (v) for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.3 && v.buffered.end(i) >= v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
  const p = window.__todProbe || {};
  return { videos: vs.length, src: v ? (v.currentSrc || v.src || '').slice(0, 5) : null, t: v ? Math.round(v.currentTime * 10) / 10 : null,
    dur: v ? (isFinite(v.duration) ? Math.round(v.duration) : 'inf') : null, ahead: ahead == null ? null : Math.round(ahead * 10) / 10,
    mediaKeys: !!(v && v.mediaKeys), eme: p.eme, sbs: (p.sbs || []).map((s) => `${s.mime.replace(/\s/g, '')}[${s.appends}x,${Math.round(s.bytes / 1024)}KB,${s.firstBytes}]`) };
};

const { chromium } = playwright();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-probe-'));
const br = spawn(process.env.CHROME || chromium.executablePath(), [`--user-data-dir=${profile}`, '--remote-debugging-port=9334', '--autoplay-policy=no-user-gesture-required',
  '--mute-audio', '--no-first-run', '--no-default-browser-check', '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
let b;
for (let i = 0; ; i++) { try { b = await chromium.connectOverCDP('http://127.0.0.1:9334'); break; } catch (e) { if (i > 80) throw e; await sleep(250); } }
try {
  const ctx = b.contexts()[0];
  await ctx.addInitScript(HOOK);
  for (const url of a._) {
    const page = await ctx.newPage();
    console.log('=== ' + url);
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }); } catch (e) { console.log('  không tải được: ' + String(e.message).split('\n')[0]); await page.close(); continue; }
    const t0 = Date.now(), aheads = [];
    let last = null, nexted = false;
    while (Date.now() - t0 < seconds * 1000) {
      if (a['next-at'] && !nexted && Date.now() - t0 > Number(a['next-at']) * 1000) { nexted = true; await page.keyboard.press('ArrowDown').catch(() => {}); console.log('  --- sang video kế'); }
      last = await page.evaluate(STATE).catch((e) => ({ err: String(e.message).slice(0, 80) }));
      if (last.ahead != null) aheads.push(last.ahead);
      await sleep(1000);
    }
    const s = [...aheads].sort((x, y) => x - y);
    console.log(`  video: ${last.videos}, src: ${last.src}, t=${last.t}/${last.dur}s, EME: ${last.eme || last.mediaKeys}`);
    console.log(`  nạp trước: trung vị ${s.length ? s[Math.floor(s.length / 2)] : '-'} s, nhỏ nhất ${s[0] ?? '-'} s, lớn nhất ${s.at(-1) ?? '-'} s (${s.length} lần đo)`);
    for (const x of last.sbs || []) console.log('  SourceBuffer ' + x);
    await page.close();
  }
} finally {
  try { await b.close(); } catch (_) {}
  br.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}

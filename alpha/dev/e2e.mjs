// Kiểm thử toàn trình bản Alpha, không cần mạng thật hay key thật:
//   Douyin giả (HTTPS, feed JSON + /aweme/v1/play/ → CDN) · dịch vụ AI giả (Fun-ASR, Gemini)
//   · alpha/server thật · Chromium thật có cài alpha/extension.
// Cần: Node 18+, playwright (có Chromium), ffmpeg, openssl.   Chạy: node alpha/dev/e2e.mjs
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const https = require('node:https');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-alpha-'));

const ff = (args, out) => { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, path.join(TMP, out)]); return fs.readFileSync(path.join(TMP, out)); };
const video = (sec, freq) => ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', `sine=frequency=${freq}`, '-t', String(sec),
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'], `v${sec}.mp4`);
const MEDIA = { speech12: video(12, 440), song6: video(6, 300) };

// ---- dịch vụ AI giả: Fun-ASR trả lời nói cho video 12 s, lời hát (kéo dài chữ) cho video 6 s
const providerHits = { funasr: 0, gemini: 0 };
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      providerHits.funasr++;
      const b64 = JSON.parse(body).input.messages[0].content[0].input_audio.data;
      const seconds = (Buffer.from(b64.split(',')[1], 'base64').length * 8) / 48000;
      if (seconds < 8) {
        return json({ output: { sentence: { begin_time: 500, end_time: 5500, text: '自由是逃离这全世界', words:
          Array.from('自由是逃离这全世界').map((ch, i) => ({ begin_time: 500 + i * 600, end_time: 1050 + i * 600, text: ch, punctuation: '' })) }, text: '自由是逃离这全世界' } });
      }
      const words = [['大家', 1000, 1400], ['好', 1400, 1600, '，'], ['今天', 1700, 2000], ['我们', 2000, 2300], ['去', 2300, 2450], ['吃', 2450, 2600], ['火锅', 2600, 3100, '。'],
        ['走', 5000, 5300], ['吧', 5300, 5600, '！']].map(([text, b, e, p]) => ({ text, begin_time: b, end_time: e, punctuation: p || '' }));
      return json({ output: { sentence: { begin_time: 1000, end_time: 5600, text: '大家好，今天我们去吃火锅。走吧！', words }, text: '大家好，今天我们去吃火锅。走吧！' } });
    }
    if (req.url.includes(':generateContent')) {
      providerHits.gemini++;
      const text = JSON.parse(body).contents[0].parts[0].text;
      const lines = JSON.parse(text.match(/Các dòng: (.*)$/m)[1]);
      const vi = { '大家好，今天我们去吃火锅。': 'Chào cả nhà, hôm nay đi ăn lẩu.', '走吧！': 'Đi thôi!' };
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ cues: lines.map(l => ({ id: l.id, vi: vi[l.zh] || 'Dòng ' + l.id })) }) }] } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;

// ---- server Alpha thật
const alphaPort = 18787 + Math.floor(Math.random() * 1000);
const alpha = spawn(process.execPath, [path.join(ROOT, 'server', 'server.mjs')], {
  env: { ...process.env, PORT: String(alphaPort), TOD_WORK: path.join(TMP, 'work'), FFMPEG: 'ffmpeg',
    DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: 'test', DASHSCOPE_BASE: PROV, GEMINI_BASE: PROV + '/v1beta' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let alphaLog = '';
alpha.stdout.on('data', d => { alphaLog += d; });
alpha.stderr.on('data', d => { alphaLog += d; });
for (let i = 0; i < 50 && !alphaLog.includes('Alpha server'); i++) await new Promise(r => setTimeout(r, 100));

// ---- Douyin giả
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=www.douyin.com',
  '-addext', 'subjectAltName=DNS:www.douyin.com,DNS:v3-web.douyinvod.com', '-keyout', path.join(TMP, 'k.pem'), '-out', path.join(TMP, 'c.pem')], { stdio: 'ignore' });
const ids = ['7500000000000000001', '7500000000000000002', '7500000000000000003'];
const fileFor = { [ids[0]]: 'speech12', [ids[1]]: 'speech12', [ids[2]]: 'song6' };
const aweme = (id, desc) => ({ aweme_id: id, desc, duration: fileFor[id] === 'song6' ? 6000 : 12000, text_extra: [],
  video: { play_addr: { uri: 'v0d00f' + id, url_list: [`https://v3-web.douyinvod.com/x/${fileFor[id]}.mp4`] }, bit_rate: [] } });
const feed = { status_code: 0, aweme_list: [aweme(ids[0], '今天吃火锅'), aweme(ids[1], '日常vlog'), aweme(ids[2], '#翻唱 自由的你')] };
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div id="feed">${ids.map((id, i) => `<div class="slide" ${i === 0 ? 'data-e2e="feed-active-video"' : ''} data-e2e-vid="${id}"><video muted playsinline style="width:640px;height:480px;display:block"></video></div>`).join('')}</div>
<script>
  fetch('/aweme/v1/web/tab/feed/?count=3').then(r => r.json());
  const slides = [...document.querySelectorAll('.slide')];
  window.activate = (i) => {
    slides.forEach((s, j) => { if (j === i) s.setAttribute('data-e2e', 'feed-active-video'); else s.removeAttribute('data-e2e'); s.style.display = j === i ? 'block' : 'none'; });
    const v = slides[i].querySelector('video');
    if (!v.src) v.src = '/media/' + i + '.mp4';
    return v;
  };
  window.activate(0);
</script></body></html>`;
const douyin = https.createServer({ key: fs.readFileSync(path.join(TMP, 'k.pem')), cert: fs.readFileSync(path.join(TMP, 'c.pem')) }, (req, res) => {
  const u = new URL(req.url, 'https://' + req.headers.host);
  const send = (s, h, b) => { res.writeHead(s, h); res.end(b); };
  if (req.headers.host.startsWith('www.douyin.com')) {
    if (u.pathname === '/') return send(200, { 'content-type': 'text/html; charset=utf-8' }, PAGE);
    if (u.pathname.startsWith('/aweme/v1/web/tab/feed')) return send(200, { 'content-type': 'application/json' }, JSON.stringify(feed));
    if (u.pathname.startsWith('/aweme/v1/play/')) {
      const id = u.searchParams.get('video_id').replace('v0d00f', '');
      return send(302, { location: `https://v3-web.douyinvod.com/x/${fileFor[id]}.mp4` }, '');
    }
    if (!u.pathname.startsWith('/media/')) return send(404, {}, '');
  }
  // CDN giả, có hỗ trợ Range (video trên trang cũng cần Range để tua được).
  const body = u.pathname.startsWith('/media/') ? MEDIA.speech12 : MEDIA[u.pathname.split('/').pop().replace('.mp4', '')];
  const h = { 'access-control-allow-origin': 'https://www.douyin.com', 'access-control-expose-headers': 'content-range', 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (!body) return send(404, h, '');
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const a = Number(m[1]), b = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
    return send(206, { ...h, 'content-range': `bytes ${a}-${b}/${body.length}` }, body.subarray(a, b + 1));
  }
  send(200, h, body);
});
await new Promise(r => douyin.listen(0, '127.0.0.1', r));
const dport = douyin.address().port;

// ---- Chromium có cài extension
const extId = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
  headless: true, channel: 'chromium', ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required', '--no-proxy-server',
    '--ignore-certificate-errors', `--host-resolver-rules=MAP www.douyin.com:443 127.0.0.1:${dport}, MAP v3-web.douyinvod.com:443 127.0.0.1:${dport}`],
});
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.evaluate((p) => chrome.storage.local.set({ settings: { enabled: true, server: `http://127.0.0.1:${p}`, position: 'bottom', size: 'm' } }), alphaPort);
await pop.click('#check');
await pop.waitForFunction(() => !/Đang kiểm tra/.test(document.getElementById('health').textContent));
const health = await pop.evaluate(() => document.getElementById('health').textContent);

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('https://www.douyin.com/');
const subAt = async (t) => page.evaluate(async (t) => {
  const v = document.querySelector('[data-e2e="feed-active-video"] video');
  v.pause(); v.currentTime = t;
  await new Promise(r => setTimeout(r, 400));
  const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.sub'));
  const sub = host.shadowRoot.querySelector('.sub');
  const badge = host.shadowRoot.querySelector('.badge');
  return { sub: sub.style.display === 'block' ? sub.textContent : null, badge: badge.style.display === 'block' ? badge.textContent : null };
}, t);

// Chờ video đầu được dịch.
let first = null;
for (let i = 0; i < 60; i++) { first = await subAt(1.2); if (first.sub) break; await page.waitForTimeout(250); }
const atGap = await subAt(4.2);      // giữa 2 câu (sau 3,6 s là hết câu 1, câu 2 bắt đầu 5,0 s)
const atSecond = await subAt(5.2);
// Extension không có quyền "tabs" nên không lọc tab theo URL được: hỏi từng tab, tab Douyin sẽ trả lời.
const status = await pop.evaluate(async () => {
  for (const t of await chrome.tabs.query({})) { try { const r = await chrome.tabs.sendMessage(t.id, { type: 'status' }); if (r) return r; } catch (_) {} }
  return null;
});
// Phím ] ba lần: sub muộn hơn 0,3 s (câu 1 bắt đầu 1,0 s → giờ hiện từ 1,3 s).
for (let i = 0; i < 3; i++) await page.keyboard.press(']');
const delayed = { at12: await subAt(1.2), at135: await subAt(1.35) };
const savedDelay = await pop.evaluate(async () => (await chrome.storage.local.get('settings')).settings.delay);
await page.keyboard.press('['); await page.keyboard.press('['); await page.keyboard.press('[');
await page.waitForTimeout(1600); // chờ thông báo lệch sub tắt
// Chuyển sang video bài hát → phải bỏ qua, không hiện sub.
await page.evaluate(() => window.activate(2));
await page.waitForTimeout(800);
const song = await subAt(2.0);

console.log({ health, first, atGap, atSecond, delayed, savedDelay, status, song, providerHits });
console.log('server log:\n' + alphaLog.trim());
const checks = {
  'popup sees the server': /Server chạy/.test(health),
  'first video subtitle shows Vietnamese at 1.2 s': first.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.',
  'nothing shown between lines (4.2 s)': atGap.sub === null,
  'second line at 5.2 s': atSecond.sub === 'Đi thôi!',
  '] key delays subs by 0.3 s and saves it': delayed.at12.sub === null && /lệch sub \+0\.3 s/.test(delayed.at12.badge || '')
    && delayed.at135.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.' && savedDelay === 0.3,
  'next videos prefetched (3 processed)': (status.counts.ok || 0) + (status.counts.skipped || 0) >= 3,
  'song video skipped, no subtitle': song.sub === null && /bài hát/.test(song.badge || ''),
  'ASR called once per video (dedupe)': providerHits.funasr === 3,
  'no page errors': errors.length === 0,
};
console.log('\nCHECKS');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS ' : 'FAIL ') + k);
await ctx.close(); douyin.close(); providers.close(); alpha.kill();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

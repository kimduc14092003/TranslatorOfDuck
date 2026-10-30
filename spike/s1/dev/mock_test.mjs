// Chạy thử extension S1 trên một trang Douyin GIẢ LẬP (không cần mạng thật).
// Playwright chặn mọi request tới www.douyin.com và CDN rồi trả dữ liệu giả,
// nên content script vẫn được nạp như trên trang thật.
// Cần: Node 18+, playwright, ffmpeg.  Chạy: node spike/s1/dev/mock_test.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-s1-'));

function ffmpeg(args, out) {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...args, path.join(TMP, out)]);
  return fs.readFileSync(path.join(TMP, out));
}
const src = ['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
const MEDIA = {
  'fast.mp4': ffmpeg([...src, '-movflags', '+faststart'], 'fast.mp4'),
  'slow.mp4': ffmpeg(src, 'slow.mp4'),
  'audio.m4a': ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:a', 'aac', '-movflags', '+faststart'], 'audio.m4a'),
};

// Chrome tính ID của extension giải nén từ đường dẫn tuyệt đối.
const extId = [...createHash('sha256').update(EXT).digest('hex').slice(0, 32)]
  .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

const expHex = Math.floor(Date.now() / 1000 + 7200).toString(16);
const cdn = (file, cors = true) => `https://v3-web.douyinvod.com/sig123/${expHex}/video/tos/${file}?cors=${cors ? 1 : 0}`;
const aweme = (id, file, extra = {}) => ({
  aweme_id: id, duration: 12000, aweme_type: 0, is_subtitled: 0,
  seo_info: { ocr_content: '字幕' }, music: { is_original: false },
  video: {
    play_addr: { uri: 'v0d00f' + id, url_list: [cdn(file)] , data_size: MEDIA[file].length },
    bit_rate: [
      { gear_name: 'normal_540_0', format: 'mp4', is_h265: 0, FPS: 30, bit_rate: 600000, play_addr: { url_list: [cdn(file)], data_size: MEDIA[file].length } },
      { gear_name: 'adapt_lowest', format: 'mp4', is_h265: 1, FPS: 30, bit_rate: 300000, play_addr: { url_list: [cdn(file)], data_size: MEDIA[file].length } },
    ],
    ...extra,
  },
});
const feed1 = { status_code: 0, aweme_list: [
  aweme('7400000000000000001', 'fast.mp4', { bit_rate_audio: [{ audio_meta: { size: MEDIA['audio.m4a'].length, bitrate: 64000, url_list: { main_url: cdn('audio.m4a') } } }] }),
  aweme('7400000000000000002', 'slow.mp4'),
  { aweme_id: '7400000000000000009', images: [{ url: 'x' }], video: { play_addr: { url_list: [cdn('fast.mp4')] } } },
] };
const feed2 = { status_code: 0, aweme_list: [aweme('7400000000000000003', 'fast.mp4')] };
// item 3 trỏ tới URL không có CORS để kiểm đường A0 → A2 khi lỗi
feed2.aweme_list[0].video.bit_rate.forEach(g => { g.play_addr.url_list = [cdn('fast.mp4', false)]; });
feed2.aweme_list[0].video.play_addr.url_list = [cdn('fast.mp4', false)];
const ssr = { app: { videoDetail: aweme('7400000000000000004', 'fast.mp4') } };

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script id="RENDER_DATA" type="application/json">${encodeURIComponent(JSON.stringify(ssr))}</script>
<div id="feed">
  <div class="slide" data-e2e="feed-active-video" data-e2e-vid="7400000000000000001"><video muted playsinline style="width:320px;height:240px"></video></div>
  <div class="slide" data-e2e-vid="7400000000000000002"><video muted playsinline style="width:320px;height:240px"></video></div>
  <div class="slide" data-e2e-vid="7400000000000000003"><video muted playsinline style="width:320px;height:240px"></video></div>
</div>
<script>
  window.player = { config: { pluginsConfig: { foo: { awemeInfo: { awemeId: '7400000000000000005',
    video: { bitRateList: [{ gearName: 'p', dataSize: 1, playAddr: [{ src: '${cdn('fast.mp4')}' }] }] } } } } } };
  fetch('/aweme/v1/web/tab/feed/?count=3').then(r => r.json()).then(() => {
    const x = new XMLHttpRequest();
    x.open('POST', '/aweme/v2/web/module/feed/?count=20');
    x.send('a=1');
  });
  const slides = [...document.querySelectorAll('.slide')];
  function activate(i) {
    slides.forEach((s, j) => { if (j === i) s.setAttribute('data-e2e', 'feed-active-video'); else s.removeAttribute('data-e2e'); });
    const v = slides[i].querySelector('video');
    v.src = '/blobsim/' + i + '.mp4';
    v.play().catch(() => {});
    slides[i].scrollIntoView();
  }
  setTimeout(() => activate(0), 800);
  setTimeout(() => activate(1), 3500);
  setTimeout(() => activate(2), 6000);
</script></body></html>`;

// Server HTTPS cục bộ đóng vai cả www.douyin.com lẫn CDN; Chrome được trỏ tên miền về đây.
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=www.douyin.com',
  '-addext', 'subjectAltName=DNS:www.douyin.com,DNS:v3-web.douyinvod.com',
  '-keyout', path.join(TMP, 'key.pem'), '-out', path.join(TMP, 'cert.pem')], { stdio: 'ignore' });
const https = require('node:https');
const mediaHits = [];
const server = https.createServer({ key: fs.readFileSync(path.join(TMP, 'key.pem')), cert: fs.readFileSync(path.join(TMP, 'cert.pem')) }, (req, res) => {
  const u = new URL(req.url, 'https://' + req.headers.host);
  const send = (status, headers, body) => { res.writeHead(status, headers); res.end(body); };
  if (req.headers.host.startsWith('www.douyin.com')) {
    if (u.pathname === '/') return send(200, { 'content-type': 'text/html; charset=utf-8' }, PAGE);
    if (u.pathname.startsWith('/aweme/v1/web/tab/feed')) return send(200, { 'content-type': 'application/json' }, JSON.stringify(feed1));
    if (u.pathname.startsWith('/aweme/v2/web/module/feed')) return send(200, { 'content-type': 'application/json' }, JSON.stringify(feed2));
    if (u.pathname.startsWith('/blobsim/')) return send(200, { 'content-type': 'video/mp4' }, MEDIA['fast.mp4']);
    return send(404, {}, '');
  }
  const file = u.pathname.split('/').pop();
  const body = MEDIA[file];
  const cors = u.searchParams.get('cors') === '1';
  const headers = cors ? { 'access-control-allow-origin': 'https://www.douyin.com', 'access-control-expose-headers': 'content-range' } : {};
  if (req.method === 'OPTIONS') return send(204, { ...headers, 'access-control-allow-headers': 'range' });
  mediaHits.push({ file, range: req.headers.range || null, referer: req.headers.referer || null, origin: req.headers.origin || null, cookie: !!req.headers.cookie });
  if (!body) return send(404, headers, '');
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const a = Number(m[1]);
    const b = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
    return send(206, { ...headers, 'content-type': 'video/mp4', 'content-range': `bytes ${a}-${b}/${body.length}` }, body.subarray(a, b + 1));
  }
  return send(200, { ...headers, 'content-type': 'video/mp4' }, body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const ctx = await chromium.launchPersistentContext(path.join(TMP, 'profile'), {
  headless: true,
  channel: 'chromium', // bản headless-shell mặc định không nạp extension
  ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--autoplay-policy=no-user-gesture-required',
    '--no-proxy-server', '--ignore-certificate-errors',
    `--host-resolver-rules=MAP www.douyin.com:443 127.0.0.1:${port}, MAP v3-web.douyinvod.com:443 127.0.0.1:${port}`],
});

const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));
await page.goto('https://www.douyin.com/');
await page.waitForTimeout(11000);

const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${extId}/popup.html`);
await pop.waitForTimeout(500);
const report = await pop.evaluate(() => chrome.storage.local.get('s1_report').then(r => r.s1_report));
const rows = await pop.$$eval('#summary tr', trs => trs.map(tr => [...tr.cells].map(c => c.textContent).join(' = ')));
console.log(rows.join('\n'));
console.log('\nendpoints', JSON.stringify(report.endpoints));
console.log('items', JSON.stringify({ unique: report.items.unique, bySource: report.items.bySource, byKind: report.items.byKind }));
console.log('active', JSON.stringify({ changes: report.active.changes, plays: report.active.plays, withDescAtPlay: report.active.withDescAtPlay, how: report.active.how }));
console.log('downloads', JSON.stringify({ a0: report.downloads.a0, a2: report.downloads.a2, byCandidate: report.downloads.byCandidate,
  faststart: report.downloads.faststart, hasMp4a: report.downloads.hasMp4a, codecs: report.downloads.codecs, sizeMatch: report.downloads.sizeMatch,
  expiryMin: report.downloads.expiryMin.slice(0, 3), primary: [report.downloads.primaryOk, report.downloads.primaryFail] }));
console.log('ssr', JSON.stringify(report.ssr), 't1', JSON.stringify({ paths: report.t1.paths }), 'hook', JSON.stringify(report.hook));
console.log('media requests seen by CDN mock (first 3):', JSON.stringify(mediaHits.slice(0, 3)));
console.log('media hits total:', mediaHits.length, 'fail log:', JSON.stringify(report.log.filter(l => l.type === 'download_fail').slice(0, 4)));
console.log('page errors:', pageErrors.length ? pageErrors : 'none');
const leaked = JSON.stringify(report).includes('7400000000000000') || JSON.stringify(report).includes('sig123');
console.log('raw IDs or URL paths in report:', leaked ? 'YES (bug)' : 'no');

const checks = {
  'T0 fetch + XHR captured': Object.keys(report.endpoints).length >= 2,
  'SSR item captured': report.items.bySource.ssr >= 1,
  'player state (T1) item captured': report.items.bySource.player >= 1,
  'image post classified': report.items.byKind.image === 1,
  'plays had descriptor first': report.active.plays >= 2 && report.active.withDescAtPlay === report.active.plays,
  'A0 succeeded on CORS URL': Object.keys(report.downloads.a0).some(k => k.startsWith('ok_')),
  'A0 failure recorded on no-CORS URL': (report.downloads.a0.network_or_cors || 0) >= 1,
  'faststart true and false both seen': report.downloads.faststart.true >= 1 && report.downloads.faststart.false >= 1,
  'mp4a detected': report.downloads.hasMp4a.true >= 1,
  'no page errors': pageErrors.length === 0,
  'no raw IDs/URLs in report': !leaked,
};

// Phần 2: chế độ đối chứng (tắt hook) sau khi xóa số liệu.
await pop.evaluate(() => chrome.storage.local.remove('s1_report'));
await page.evaluate(() => localStorage.setItem('__tod_s1_hook', 'off'));
await page.reload();
await page.waitForTimeout(5000);
const ctl = await pop.evaluate(() => chrome.storage.local.get('s1_report').then(r => r.s1_report));
console.log('\ncontrol run:', JSON.stringify({ pageLoads: ctl.pageLoads, hookModes: ctl.hookModes, endpoints: ctl.endpoints,
  bySource: ctl.items.bySource, hookChecks: ctl.hook.checks }));
checks['reset cleared old numbers'] = ctl.pageLoads === 1;
checks['hook off: no T0 capture'] = Object.keys(ctl.endpoints).length === 0 && ctl.hookModes.off === 1;
checks['hook off: SSR/T1 still measured'] = (ctl.items.bySource.ssr || 0) >= 1 && (ctl.items.bySource.player || 0) >= 1;
checks['hook off: page fetch untouched'] = await page.evaluate(() => window.fetch.toString().includes('[native code]'));

console.log('\nCHECKS');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS ' : 'FAIL ') + k);
await ctx.close();
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

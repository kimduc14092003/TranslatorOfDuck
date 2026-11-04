// Kiểm thử toàn trình bản Alpha, không cần mạng thật hay key thật:
//   Douyin giả (HTTPS, feed JSON + /aweme/v1/play/ → CDN) · dịch vụ AI giả (Fun-ASR, Gemini)
//   · alpha/server thật · Chromium thật có cài alpha/extension.
// Cần: Node 18+, playwright (có Chromium), ffmpeg, openssl.   Chạy: node alpha/dev/e2e.mjs
// E2E_MT=openai: dịch bằng OpenAI giả trả SSE (stream), server gửi dòng tạm (NDJSON nhiều dòng) như với key OpenAI thật;
// mặc định Gemini giả (không stream, NDJSON chỉ có dòng cuối).
// E2E_FIRST10=1: extension chạy cách "dịch sẵn 10 s đầu" (mặc định của extension từ 0.2.37); không đặt thì cách cũ (dịch sẵn
// 20–30 s). Ở cách 10 s: ca video 100 s phát thật ≥ 5 s trước khi dừng để tua (qua cửa chờ 4 s), các kiểm tra theo lưới đoạn
// 10 s; thêm ca phát liên tục trên trang /jingxuan (lướt nhanh 4 video, xem một video 23 s không dừng, cửa chờ 1,5 s).
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
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'], `v${sec}.mp4`);
const MEDIA = { speech12: video(12, 440), song6: video(6, 300), long100: video(100, 500) };

// ---- dịch vụ AI giả. Fun-ASR trả lời theo độ dài âm thanh nhận được:
//   < 8 s: lời hát (chữ kéo dài) · 8–20 s: 2 câu ở 1,0 s và 5,0 s · ≥ 20 s (một đoạn của video dài): 3 câu ở 2,0 s, 6,0 s
//   và 9,0 s. Câu thứ ba cho đoạn [10,20) của cách 10 s (gửi dư 4,5 s phía trước: câu ở 2,0 s rơi trước giây 10, chỉ còn
//   "走吧" 2 chữ thì server bỏ cả đoạn là "quá ít lời"); ở cách cũ nó không trùng chỗ nào các kiểm tra đọc sub.
const MT = process.env.E2E_MT === 'openai' ? 'openai' : 'gemini';
const F10 = process.env.E2E_FIRST10 === '1';
const providerHits = { en: 0, funasr: 0, gemini: 0, withContext: 0, longChunks: [], rateLimited: 0, pronIn: 0, authorIn: 0, streamed: 0 };
// Bảng xưng hô model giả trả trong mọi lần dịch (không có trong lượt rút gọn): extension phải gửi lại ở yêu cầu sau.
const PRON = { pairs: [{ who: 'người kể → người xem', self: 'mình', other: 'các bạn' }] };
const sentence = (text, b, e) => {
  const chars = Array.from(text.replace(/[，。！]/g, ''));
  const step = (e - b) / chars.length;
  return { begin_time: b, end_time: e, text, words: chars.map((ch, i) => ({ text: ch, begin_time: Math.round(b + i * step), end_time: Math.round(b + (i + 1) * step),
    punctuation: i === chars.length - 1 ? text.slice(-1) : (text.includes('，') && ch === '好' ? '，' : '') })) };
};
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      providerHits.funasr++;
      const b64 = JSON.parse(body).input.messages[0].content[0].input_audio.data;
      const seconds = (Buffer.from(b64.split(',')[1], 'base64').length * 8) / 48000;
      if (seconds >= 20) {
        providerHits.longChunks.push(Math.round(seconds));
        // Đoạn 30 s chậm hơn mẩu nhanh như trên Douyin thật (6–8 s so với 3,3–3,7 s, HANDOFF §6e): extension chỉ gửi mẩu
        // nhanh sau khi chỗ tua tới đứng yên ~0,5 s, nên đoạn xong ngay thì không còn gì để gửi mẩu nhanh.
        const out = { output: { sentences: [sentence('大家好，今天我们去吃火锅。', 2000, 4100), sentence('走吧！', 6000, 6600), sentence('我们出发了。', 9000, 10200)] } };
        return setTimeout(() => json(out), 1500);
      }
      if (seconds < 8) {
        return json({ output: { sentence: { begin_time: 500, end_time: 5500, text: '自由是逃离这全世界', words:
          Array.from('自由是逃离这全世界').map((ch, i) => ({ begin_time: 500 + i * 600, end_time: 1050 + i * 600, text: ch, punctuation: '' })) }, text: '自由是逃离这全世界' } });
      }
      const words = [['大家', 1000, 1400], ['好', 1400, 1600, '，'], ['今天', 1700, 2000], ['我们', 2000, 2300], ['去', 2300, 2450], ['吃', 2450, 2600], ['火锅', 2600, 3100, '。'],
        ['走', 5000, 5300], ['吧', 5300, 5600, '！']].map(([text, b, e, p]) => ({ text, begin_time: b, end_time: e, punctuation: p || '' }));
      return json({ output: { sentence: { begin_time: 1000, end_time: 5600, text: '大家好，今天我们去吃火锅。走吧！', words }, text: '大家好，今天我们去吃火锅。走吧！' } });
    }
    const gem = req.url.includes(':generateContent'), oai = req.url.endsWith('/v1/chat/completions');
    if (gem || oai) {
      // Lần gọi dịch đầu tiên trả 429 (vượt hạn mức theo phút): server phải tự thử lại.
      if (!providerHits.rateLimited++) { res.writeHead(429, { 'content-type': 'application/json' }); return res.end('{"error":{"code":429}}'); }
      providerHits.gemini++;   // số lần gọi dịch (cả OpenAI giả)
      const b = JSON.parse(body);
      const text = gem ? b.contents[0].parts[0].text : b.messages[0].content;
      if (text.includes('Các dòng ngay trước')) providerHits.withContext++;
      if (text.includes('Bảng xưng hô đã dùng') && text.includes(JSON.stringify(PRON.pairs))) providerHits.pronIn++;
      if (text.includes('小李旅行')) providerHits.authorIn++;
      // Câu lệnh tiếng Anh (ngôn ngữ đích en): dòng 'Lines: ', khoá text, không có bảng xưng hô.
      const en = /^Lines: /m.test(text);
      if (en) providerHits.en++;
      const lines = JSON.parse(text.match(en ? /^Lines: (.*)$/m : /Các dòng: (.*)$/m)[1]);
      const vi = { '大家好，今天我们去吃火锅。': 'Chào cả nhà, hôm nay đi ăn lẩu.', '走吧！': 'Đi thôi!', '我们出发了。': 'Mình xuất phát nào.' };
      const EN = { '大家好，今天我们去吃火锅。': 'Hi everyone, we are going for hotpot today.', '走吧！': "Let's go!", '我们出发了。': "We're off." };
      const out = JSON.stringify(en ? { cues: lines.map(l => ({ id: l.id, text: EN[l.zh] || 'Line ' + l.id })) }
        : { ...(/^Rút gọn/.test(text) ? {} : { pronouns: PRON }), cues: lines.map(l => ({ id: l.id, vi: vi[l.zh] || 'Dòng ' + l.id })) });
      if (gem) return json({ candidates: [{ content: { parts: [{ text: out }] } }] });
      if (!b.stream) return json({ choices: [{ message: { role: 'assistant', content: out } }] });
      // SSE: 6 mẩu cách nhau 60 ms, để server gửi dòng tạm trước kết quả cuối.
      providerHits.streamed++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const n = Math.ceil(out.length / 6);
      for (let i = 0; i * n < out.length; i++) setTimeout(() => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out.slice(i * n, (i + 1) * n) } }] })}\n\n`); }, 30 + i * 60);
      setTimeout(() => { if (!res.writableEnded) res.end('data: [DONE]\n\n'); }, 30 + Math.ceil(out.length / n) * 60);
      return;
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
    DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: MT === 'gemini' ? 'test' : '', OPENAI_API_KEY: MT === 'openai' ? 'test-openai' : '', DASHSCOPE_BASE: PROV, GEMINI_BASE: PROV + '/v1beta',
    OPENAI_BASE: PROV + '/v1', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: 'none' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let alphaLog = '', logTail = '';
const logLines = [];   // { at: lúc dòng log tới (Date.now()), line }: server ghi một dòng khi xong (hay huỷ) một yêu cầu
const onLog = (d) => {
  alphaLog += d; logTail += d;
  for (let i; (i = logTail.indexOf('\n')) >= 0; logTail = logTail.slice(i + 1)) logLines.push({ at: Date.now(), line: logTail.slice(0, i) });
};
alpha.stdout.on('data', onLog);
alpha.stderr.on('data', onLog);
// Các yêu cầu đã xong (hay huỷ, lỗi) của một video theo log server: { at, quick, range: '0:10–0:20', status, seconds }.
const reqsOf = (id) => logLines.map(({ at, line }) => {
  const m = new RegExp(`^\\S+ \\S+ ${id} \\[(nhanh )?([^\\]]+?)( ♪)?\\] (\\S+)`).exec(line);
  const s = / · ([\d.]+) s âm thanh/.exec(line);
  return m && { at, quick: !!m[1], range: m[2], status: m[4], seconds: s ? Number(s[1]) : null };
}).filter(Boolean);
for (let i = 0; i < 50 && !alphaLog.includes('Alpha server'); i++) await new Promise(r => setTimeout(r, 100));

// ---- Douyin giả
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=www.douyin.com',
  '-addext', 'subjectAltName=DNS:www.douyin.com,DNS:v3-web.douyinvod.com', '-keyout', path.join(TMP, 'k.pem'), '-out', path.join(TMP, 'c.pem')], { stdio: 'ignore' });
const ids = ['7500000000000000001', '7500000000000000002', '7500000000000000003', '7500000000000000004'];
const FAV = '7500000000000000009';   // video đã thích ở cột bên, không nằm trong feed
const SIDS = ['7500000000000000011', '7500000000000000012'];   // kết quả tìm kiếm, chỉ có trong search/stream
// Feed /jingxuan của ca phát liên tục (chỉ E2E_FIRST10=1): 4 video lướt nhanh, video xem 23 s, video kế (xem ~4 s sau khi
// đã xem lâu: cửa 1,5 s), video kế nữa (chỉ được dịch sẵn). Đều 100 s (dùng chung file long100, kết quả server theo id).
const PIDS = ['7500000000000000021', '7500000000000000022', '7500000000000000023', '7500000000000000024', '7500000000000000025',
  '7500000000000000026', '7500000000000000027'];
const [PA, PP, PN, PN2] = [PIDS.slice(0, 4), PIDS[4], PIDS[5], PIDS[6]];
const fileFor = { [ids[0]]: 'speech12', [ids[1]]: 'speech12', [ids[2]]: 'song6', [ids[3]]: 'long100', [FAV]: 'speech12', [SIDS[0]]: 'speech12', [SIDS[1]]: 'speech12',
  ...Object.fromEntries(PIDS.map(id => [id, 'long100'])) };
const DUR = { speech12: 12000, song6: 6000, long100: 100000 };
const aweme = (id, desc) => ({ aweme_id: id, desc, duration: DUR[fileFor[id]], text_extra: [], ...(fileFor[id] === 'long100' ? { author: { nickname: '小李旅行' } } : {}),
  video: { play_addr: { uri: 'v0d00f' + id, url_list: [`https://v3-web.douyinvod.com/x/${fileFor[id]}.mp4`] }, bit_rate: [] } });
const feed = { status_code: 0, aweme_list: [aweme(ids[0], '今天吃火锅'), aweme(ids[1], '日常vlog'), aweme(ids[2], '#翻唱 自由的你'), aweme(ids[3], '旅游vlog')] };
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div id="feed">${ids.map((id, i) => `<div class="slide" ${i === 0 ? 'data-e2e="feed-active-video"' : ''} data-e2e-vid="${id}"><video muted playsinline style="width:640px;height:480px;display:block"></video></div>`).join('')}</div>
<script>
  // Như 推荐 thật: 2 video đầu nằm trong dữ liệu nhúng của trang (RSC, self.__pace_f), feed API tới sau.
  (self.__pace_f = self.__pace_f || []).push([1, '8:' + JSON.stringify(['$', '$La', null, { awemeList: ${JSON.stringify([aweme(ids[0], '今天吃火锅'), aweme(ids[1], '日常vlog')])} }]) + '\\n']);
</script>
<script>
  new Promise(r => setTimeout(r, 4000)).then(() => fetch('/aweme/v1/web/aweme/favorite/?count=2')).then(r => r.json()).then(() => fetch('/aweme/v1/web/tab/feed/?count=3')).then(r => r.json());
  const slides = [...document.querySelectorAll('.slide')];
  window.activate = (i) => {
    slides.forEach((s, j) => { if (j === i) s.setAttribute('data-e2e', 'feed-active-video'); else s.removeAttribute('data-e2e'); s.style.display = j === i ? 'block' : 'none'; });
    const v = slides[i].querySelector('video');
    if (!v.src) v.src = '/media/' + i + '.mp4';
    return v;
  };
  window.activate(0);
</script></body></html>`;
// Feed /jingxuan (cũng là feed với extension): mọi video nằm trong dữ liệu nhúng (__pace_f), không có feed API.
// activate(i): dừng mọi video, hiện slide i, phát từ 0.
const PAGE2 = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<div id="feed">${PIDS.map((id, i) => `<div class="slide" ${i === 0 ? 'data-e2e="feed-active-video"' : ''} data-e2e-vid="${id}"><video muted playsinline style="width:640px;height:480px;display:block"></video></div>`).join('')}</div>
<script>
  (self.__pace_f = self.__pace_f || []).push([1, '8:' + JSON.stringify(['$', '$La', null, { awemeList: ${JSON.stringify(PIDS.map(id => aweme(id, '旅游vlog')))} }]) + '\\n']);
</script>
<script>
  const slides = [...document.querySelectorAll('.slide')];
  window.activate = (i) => {
    for (const v of document.querySelectorAll('video')) v.pause();
    slides.forEach((s, j) => { if (j === i) s.setAttribute('data-e2e', 'feed-active-video'); else s.removeAttribute('data-e2e'); s.style.display = j === i ? 'block' : 'none'; });
    const v = slides[i].querySelector('video');
    if (!v.src) v.src = '/media/' + slides[i].getAttribute('data-e2e-vid') + '.mp4';
    v.currentTime = 0;
    return v;
  };
  window.activate(0);
</script></body></html>`;
// Trang tìm kiếm: kết quả đầu chỉ tới qua /general/search/stream/, thân khai là JSON nhưng chia khúc như đo trên Douyin
// thật 01/11 (dòng độ dài hex, xuống dòng, một khối JSON gọn, xuống dòng, …). Bấm kết quả đầu: mở ?modal_id= với một
// <video> đang phát; kết quả thứ hai (khối JSON sau) là video kế tiếp của danh sách tìm kiếm.
const searchStream = [{ status_code: 0, data: [{ type: 1, aweme_info: aweme(SIDS[0], '吉他弹唱') }] }, { status_code: 0, data: [{ type: 1, aweme_info: aweme(SIDS[1], '情歌') }] },
  { status_code: 0, has_more: 1, cursor: 2 }].map(d => { const j = JSON.stringify(d); return Buffer.byteLength(j).toString(16) + '\n' + j + '\n'; }).join('');
const SEARCH_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="modal"></div>
<script>
  fetch('/aweme/v1/web/general/search/stream/?keyword=x').then(r => r.text()).then(() => new Promise(r => setTimeout(r, 500))).then(() => {
    history.pushState(null, '', location.pathname + '?modal_id=${SIDS[0]}');
    document.getElementById('modal').innerHTML = '<video muted playsinline autoplay src="/media/${SIDS[0]}.mp4" style="width:640px;height:480px;display:block"></video>';
  });
</script></body></html>`;
// Byte sau cùng của moov (file faststart: ftyp, moov, … mdat).
const moovEnd = (b) => { for (let o = 0; o + 8 <= b.length;) { const size = b.readUInt32BE(o); if (b.toString('latin1', o + 4, o + 8) === 'moov') return o + size; if (size < 8) break; o += size; } return 0; };
const playRequested = new Set();
const cdnSong = [];   // lần tải phần âm thanh video bài hát (lần đầu bị treo)
const playRequestedAt = {};
const playRanges = {};   // id -> các header Range gửi tới /aweme/v1/play/ (trước khi chuyển hướng sang CDN)
let feedServedAt = 0;
const douyin = https.createServer({ key: fs.readFileSync(path.join(TMP, 'k.pem')), cert: fs.readFileSync(path.join(TMP, 'c.pem')) }, (req, res) => {
  const u = new URL(req.url, 'https://' + req.headers.host);
  const send = (s, h, b) => { res.writeHead(s, h); res.end(b); };
  if (req.headers.host.startsWith('www.douyin.com')) {
    if (u.pathname === '/') return send(200, { 'content-type': 'text/html; charset=utf-8' }, PAGE);
    if (u.pathname === '/jingxuan') return send(200, { 'content-type': 'text/html; charset=utf-8' }, PAGE2);
    if (u.pathname.startsWith('/search/')) return send(200, { 'content-type': 'text/html; charset=utf-8' }, SEARCH_PAGE);
    if (u.pathname.startsWith('/aweme/v1/web/general/search/stream')) return send(200, { 'content-type': 'application/json' }, searchStream);
    if (u.pathname.startsWith('/aweme/v1/web/tab/feed')) { feedServedAt = feedServedAt || Date.now(); return send(200, { 'content-type': 'application/json' }, JSON.stringify(feed)); }
    if (u.pathname.startsWith('/aweme/v1/web/aweme/favorite')) return send(200, { 'content-type': 'application/json' }, JSON.stringify({ status_code: 0, aweme_list: [aweme(ids[0], '今天吃火锅'), aweme(FAV, '收藏')] }));
    if (u.pathname.startsWith('/aweme/v1/play/')) {
      const id = u.searchParams.get('video_id').replace('v0d00f', '');
      playRequested.add(id);
      if (!playRequestedAt[id]) playRequestedAt[id] = Date.now();
      (playRanges[id] = playRanges[id] || []).push(req.headers.range || '');
      return send(302, { location: `https://v3-web.douyinvod.com/x/${fileFor[id]}.mp4` }, '');
    }
    if (!u.pathname.startsWith('/media/')) return send(404, {}, '');
  }
  // CDN giả, có hỗ trợ Range (video trên trang cũng cần Range để tua được).
  const mk = u.pathname.slice(7, -4);   // /media/<số thứ tự trong feed hoặc id>.mp4
  const body = u.pathname.startsWith('/media/') ? MEDIA[fileFor[mk] || fileFor[ids[Number(mk)]]] : MEDIA[u.pathname.split('/').pop().replace('.mp4', '')];
  const h = { 'access-control-allow-origin': 'https://www.douyin.com', 'access-control-expose-headers': 'content-range', 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (!body) return send(404, h, '');
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  // CDN treo một lần (như đo được trên Douyin): lượt tải phần âm thanh đầu tiên của video bài hát gửi header rồi im. Lượt
  // tải đầu video ("bytes=0-", mục lục + âm thanh trên cùng một lượt) thì gửi hết mục lục và 16 byte rồi mới im.
  if (m && !u.pathname.startsWith('/media/') && u.pathname.endsWith('/song6.mp4') && (Number(m[1]) > 0 || !m[2])) {
    cdnSong.push(Date.now());
    const from = Number(m[1]), upto = m[2] ? from + 16 : moovEnd(body) + 16;
    if (cdnSong.length === 1) { res.writeHead(206, { ...h, 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` }); res.write(body.subarray(from, upto)); return; }
  }
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
// first10: mặc định chạy cách dịch sẵn 20–30 s; E2E_FIRST10=1 chạy cách dịch sẵn 10 s (mặc định của extension từ 0.2.37):
// lưới đoạn, độ dài âm thanh khác theo thiết kế, kiểm tra ghi kỳ vọng theo từng cách.
await pop.evaluate(([p, f10]) => chrome.storage.local.set({ settings: { enabled: true, server: `http://127.0.0.1:${p}`, position: 'bottom', size: 'm', first10: f10, first10Set: true } }), [alphaPort, F10]);
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
// Thống kê của tab: chờ tới khi đủ 3 video xong (tối đa 8 s). Lần dịch đầu bị 429 giả rồi thử lại sau 2 s, lần đó
// có thể rơi vào video dịch sẵn (hai hàng tải chạy song song).
const readStatus = () => pop.evaluate(async () => {
  for (const t of await chrome.tabs.query({})) { try { const r = await chrome.tabs.sendMessage(t.id, { type: 'status' }); if (r) return r; } catch (_) {} }
  return null;
});
let status = await readStatus();
for (let i = 0; i < 16 && status && (status.counts.ok || 0) + (status.counts.skipped || 0) < 3; i++) { await new Promise(r => setTimeout(r, 500)); status = await readStatus(); }
// Phím ] ba lần: sub muộn hơn 0,3 s (câu 1 bắt đầu 1,0 s → giờ hiện từ 1,3 s).
for (let i = 0; i < 3; i++) await page.keyboard.press(']');
const delayed = { at12: await subAt(1.2), at135: await subAt(1.35) };
const savedDelay = await pop.evaluate(async () => (await chrome.storage.local.get('settings')).settings.delay);
await page.keyboard.press('['); await page.keyboard.press('['); await page.keyboard.press('[');
await page.waitForTimeout(1600); // chờ thông báo lệch sub tắt
// Chuyển sang video bài hát → phải bỏ qua, không hiện sub.
await page.evaluate(() => window.activate(2));
await page.waitForTimeout(800);
// Lượt tải đầu của video này bị CDN giả treo: chờ extension bỏ lượt đó (6 s im) và tải lại.
let song = await subAt(2.0);
for (let i = 0; i < 60 && /đang dịch/.test(song.badge || ''); i++) { await page.waitForTimeout(250); song = await subAt(2.0); }
// Tắt "Dịch cả lời bài hát" trong popup: video bài hát lại bị bỏ qua (server dùng lại kết quả nhận dạng), rồi bật lại.
// Bấm ô trong popup như người dùng (rà soát 31/10: trước đây ghi thẳng vào storage, không kiểm phần nối ô đó với cài đặt).
const storedLyrics = () => pop.evaluate(async () => (await chrome.storage.local.get('settings')).settings.lyrics);
const setLyrics = async (on) => {
  await pop.evaluate((on) => { const el = document.getElementById('lyrics'); if (el.checked !== on) el.click(); }, on);
  for (let i = 0; i < 40 && (await storedLyrics()) !== on; i++) await pop.waitForTimeout(50);
};
const lyricsBoxDefault = await pop.evaluate(() => document.getElementById('lyrics').checked);
const asrBeforeOff = providerHits.funasr;
await setLyrics(false);
const lyricsSavedOff = await storedLyrics();
let songOff = await subAt(2.0);
for (let i = 0; i < 60 && !/bài hát/.test(songOff.badge || ''); i++) { await page.waitForTimeout(250); songOff = await subAt(2.0); }
const asrAfterOff = providerHits.funasr;
await setLyrics(true);
await page.waitForTimeout(500);

// Video dài 100 s: chia đoạn [0,20) [20,50) [50,80) [80,101); dịch trước 30 s so với chỗ đang xem.
// Cách 10 s: [0,10) [10,20) [20,50) [50,80) [80,101). Đoạn sau đoạn ở chỗ đang xem chỉ gửi khi đã phát 4 s (cửa chờ), mà
// subAt dừng video trước mỗi lần đọc: phát thật từ 0 tới ≥ 5 s rồi mới dừng để tua, chờ [10,20) và [20,50) xong (gửi dư
// 4,5 s và 1,5 s phía trước như khi xem liền mạch). Không phát thì tua tới 21 s gửi [20,50) dư 8 s (đoạn trước chưa dịch),
// câu của ASR giả rơi trước giây 20, đoạn không còn câu nào (HANDOFF §6ad).
await page.evaluate(() => window.activate(3));
const waitSub = async (t, want) => { let r; for (let i = 0; i < 60; i++) { r = await subAt(t); if (r.sub === want) break; await page.waitForTimeout(250); } return r; };
const waitReq = async (id, range, ms = 10000) => { for (let i = 0; i * 250 < ms && !reqsOf(id).some(x => !x.quick && x.range === range); i++) await page.waitForTimeout(250); };
const long = {};
if (F10) {
  long.playedTo = await page.evaluate(async () => {
    const v = document.querySelector('[data-e2e="feed-active-video"] video');
    v.currentTime = 0;
    await v.play();
    const t0 = Date.now();
    while (v.currentTime < 5 && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50));
    v.pause();
    return v.currentTime;
  });
  await waitReq(ids[3], '0:10–0:20');
  await waitReq(ids[3], '0:20–0:50');
}
long.at2 = await waitSub(2.2, 'Chào cả nhà, hôm nay đi ăn lẩu.');      // đoạn 1: câu ở 2,0 s (cách 10 s: [0,10) dư 2 s, câu ở 1,0 s)
long.at21 = await waitSub(21.0, 'Chào cả nhà, hôm nay đi ăn lẩu.');    // đoạn 2: âm thanh từ 18,5 s → câu ở 20,5 s
await page.waitForTimeout(2500);                                      // đoạn 3 (gửi sau đoạn 2, ASR giả 1,5 s) xong
long.chunksBeforeSeek = providerHits.longChunks.length;               // đoạn 1, 2, 3 (21 + 30 = 51 chạm đoạn 3), chưa đến đoạn 4
// Đoạn đã xong trước khi tua tới 85 s (theo log server, không tính mẩu nhanh). Cách 10 s: [0,10) 12 s âm thanh không vào
// longChunks (< 20 s), nên longChunks là [10,20) [20,50) [50,80), cũng 3 như cách cũ: kiểm thêm theo tên đoạn.
long.doneBeforeSeek = reqsOf(ids[3]).filter(x => !x.quick && x.status === 'ok').map(x => x.range);
long.at85 = await waitSub(85.0, 'Đi thôi!');                          // tua tới 85 s: đoạn 4, âm thanh từ 78,5 s → "走吧" ở 84,5 s
long.at83 = await subAt(83.5);                                        // giữa 2 câu (câu 1 hết lúc 83,1 s): trống
long.chunks = [...providerHits.longChunks];
const longReqs = reqsOf(ids[3]).filter(x => !x.quick);
long.reqs = longReqs.map(({ range, status, seconds }) => `${range} ${status} ${seconds} s`);
// Rê chuột thật vào nhãn: bảng thông tin đã dịch hiện ra (chỗ đang xem 85 s, đoạn [80,101) đã dịch), rời nhãn thì ẩn.
const info = () => page.evaluate(() => {
  const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.sub'));
  const b = host.shadowRoot.querySelector('.badge').getBoundingClientRect(), el = host.shadowRoot.querySelector('.info');
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, text: el.style.display === 'block' ? el.textContent : null };
});
const ib = await info();
await page.mouse.move(ib.x, ib.y);
for (let i = 0; i < 20 && !(long.info = (await info()).text); i++) await page.waitForTimeout(100);
await page.mouse.move(ib.x + 300, ib.y + 300);
await page.waitForTimeout(300);
long.infoAfter = (await info()).text;
// Feed 推荐 phát nối đoạn: tua thì <video>.currentTime không đổi, chỉ đồng hồ trình phát (window.player.currentTime)
// nhảy. Giả lập trình phát chạy trước <video> 50 s: <video> ở 35 s nghĩa là đang xem 85 s → phải hiện "Đi thôi!".
await page.evaluate(() => {
  const v = document.querySelector('[data-e2e="feed-active-video"] video');
  // Dạng trình phát douyin-player: id ở config.baseConfig.mediaInfo.id, không có awemeInfo.
  window.player = { config: { baseConfig: { mediaInfo: { id: '7500000000000000004' } } }, media: v, get currentTime() { return v.currentTime + 50; } };
});
long.clock85 = await waitSub(35.0, 'Đi thôi!');
await page.evaluate(() => { window.player = undefined; });

// Mở video từ trang tìm kiếm (đo 01/11: trước đây không có nhãn, không dịch vì không đọc được search/stream).
const spage = await ctx.newPage();
spage.on('pageerror', e => errors.push(String(e)));
await spage.goto('https://www.douyin.com/search/test');
const search = { sub: null, badge: null };
for (let i = 0; i < 60 && search.sub !== 'Chào cả nhà, hôm nay đi ăn lẩu.'; i++) {
  await spage.waitForTimeout(250);
  Object.assign(search, await spage.evaluate(async () => {
    const v = document.querySelector('#modal video');
    if (!v || !/modal_id=/.test(location.search)) return {};
    v.pause(); v.currentTime = 1.2;
    await new Promise(r => setTimeout(r, 300));
    const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.sub'));
    if (!host) return {};
    const sub = host.shadowRoot.querySelector('.sub'), badge = host.shadowRoot.querySelector('.badge');
    return { sub: sub.style.display === 'block' ? sub.textContent : null, badge: badge.style.display === 'block' ? badge.textContent : null };
  }));
}
for (let i = 0; i < 20 && !playRequested.has(SIDS[1]); i++) await spage.waitForTimeout(250);
search.prefetchedNext = playRequested.has(SIDS[1]);
// Số đếm của dịch vụ AI giả tới hết các ca trên: kiểm tra của các ca đó đọc ở đây (ca phát liên tục bên dưới gọi thêm).
const hits0 = { ...providerHits, longChunks: [...providerHits.longChunks] };

// ---- Ngôn ngữ đích (giai đoạn 1): chọn English trong popup lúc video trang tìm kiếm đã có sub tiếng Việt. Extension xin bản dịch
// không kèm âm thanh, server dịch từ dòng gốc đã lưu (không nhận dạng lại); nhãn EN. Chọn lại Tiếng Việt: sub tiếng Việt có ngay.
const searchSub = (t) => spage.evaluate(async (t) => {
  const v = document.querySelector('#modal video');
  if (!v) return {};
  v.pause(); v.currentTime = t;
  await new Promise(r => setTimeout(r, 300));
  const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.sub'));
  if (!host) return {};
  const sub = host.shadowRoot.querySelector('.sub'), badge = host.shadowRoot.querySelector('.badge');
  return { sub: sub.style.display === 'block' ? sub.textContent : null, badge: badge.style.display === 'block' ? badge.textContent : null };
}, t);
const english = {};
await spage.bringToFront();
await pop.selectOption('#target', 'en');
for (let i = 0; i < 60; i++) { english.en = await searchSub(1.2); if (english.en.sub === 'Hi everyone, we are going for hotpot today.') break; await spage.waitForTimeout(250); }
english.saved = await pop.evaluate(async () => (await chrome.storage.local.get('settings')).settings.target);
await pop.selectOption('#target', 'vi');
await spage.waitForTimeout(400);
english.back = await searchSub(1.2);

// ---- Cách dịch sẵn 10 s, phát liên tục như người xem (chỉ E2E_FIRST10=1). Tab mới ở feed /jingxuan; không bao giờ dừng video
// để đọc: đọc sub và nhãn trong shadow DOM mỗi 250 ms lúc đang phát. Lúc server xong một đoạn: lúc dòng log của nó tới.
//   1. Lướt nhanh: PA[0..3], mỗi video phát ~2 s (cửa chờ 4 s vì video trước chỉ xem ~2 s).
//   2. PP: phát từ 0 tới 23,5 s.
//   3. PN: phát ~4,5 s ngay sau PP (đã xem ≥ 8 s nên cửa chờ 1,5 s). PN2: chỉ được dịch sẵn.
const CHAO = 'Chào cả nhà, hôm nay đi ăn lẩu.', DI = 'Đi thôi!', MINH = 'Mình xuất phát nào.';
// Sub của PP theo giờ phim. [0,10) gửi 12 s âm thanh (ASR giả 8–20 s: câu ở 1,0 s, 5,0 s); [10,20) gửi từ 5,5 s (câu ở 7,5 s
// rơi trước giây 10, bị bỏ; còn 11,5 s và 14,5 s); [20,50) từ 18,5 s (20,5 s). Hết dòng = hết lời + 0,5 s (segmentCues).
const P_LINES = [[1.0, 3.6, CHAO], [5.0, 6.1, DI], [11.5, 12.6, DI], [14.5, 16.2, MINH], [20.5, 23.1, CHAO]];
let play = null;
if (F10) {
  await spage.close(); await page.close();   // hai tab trước đã xong việc; khỏi chia CPU với tab đang phát
  const p2 = await ctx.newPage();
  p2.on('pageerror', e => errors.push(String(e)));
  await p2.goto('https://www.douyin.com/jingxuan');
  await p2.waitForTimeout(500);
  // Hiện video i, phát từ 0 trong ms (pause: dừng ở cuối). Mỗi 250 ms: wall (Date.now()), t (currentTime), sub, badge.
  const watch = (i, ms, pause) => p2.evaluate(async ({ i, ms, pause }) => {
    const v = window.activate(i);
    await v.play();
    const out = [], t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const host = [...document.querySelectorAll('div')].find(d => d.shadowRoot && d.shadowRoot.querySelector('.sub'));
      const sub = host && host.shadowRoot.querySelector('.sub'), badge = host && host.shadowRoot.querySelector('.badge');
      out.push({ wall: Date.now(), t: Math.round(v.currentTime * 1000) / 1000, paused: v.paused,
        sub: sub && sub.style.display === 'block' ? sub.textContent : null, badge: badge && badge.style.display === 'block' ? badge.textContent : null });
      await new Promise(r => setTimeout(r, 250));
    }
    if (pause) v.pause();
    return out;
  }, { i, ms, pause });
  play = { swipe: [] };
  for (let i = 0; i < 4; i++) play.swipe.push(await watch(i, 2000, false));
  play.p = await watch(4, 23500, true);
  play.n = await watch(5, 4500, true);
  await p2.waitForTimeout(2000);   // việc đã gửi (đoạn [20,50) của PN) xong
  play.reqs = Object.fromEntries(PIDS.map(id => [id, reqsOf(id)]));
}
// Giờ phim của một lượt phát (các mẫu đọc) lúc wall = T; null: trước mẫu đầu.
const headAt = (samples, T) => { let s = null; for (const x of samples) if (x.wall <= T) s = x; return s && Math.round((s.t + (s.paused ? 0 : (T - s.wall) / 1000)) * 100) / 100; };
// So sub đọc được lúc phát với bảng dòng (bỏ mẫu cách đầu/cuối dòng < 0,2 s): mẫu sai, và dòng nào đã thấy.
const timeline = (samples, lines, from, to) => {
  const lineAt = (t) => (lines.find(([a, b]) => t >= a && t < b) || [])[2] || null;
  const use = samples.filter(s => !s.paused && s.t >= from && s.t < to && !lines.some(([a, b]) => Math.abs(s.t - a) < 0.2 || Math.abs(s.t - b) < 0.2));
  return { n: use.length, wrong: use.filter(s => s.sub !== lineAt(s.t)).map(s => `${s.t} s: ${s.sub}`),
    seen: lines.filter(([a, b]) => a < to && b > from).map(([a, b, text]) => use.some(s => s.t >= a && s.t < b && s.sub === text)) };
};
// Mẫu đọc rút gọn để in: chỉ lúc sub hay nhãn đổi.
const changes = (samples) => samples.filter((s, i) => !i || s.sub !== samples[i - 1].sub || s.badge !== samples[i - 1].badge).map(s => `${s.t} ${s.sub} | ${s.badge}`);

// Kết quả ca phát liên tục: c1At, c2At, n1At là giờ phim lúc server xong đoạn [10,20) của PP, [20,50) của PP, [10,20) của PN.
let f10 = null;
if (play) {
  const r = play.reqs, get = (id, range) => r[id].find(x => !x.quick && x.range === range);
  const okAt = (x, samples) => (x && x.status === 'ok' ? headAt(samples, x.at) : null);
  f10 = { p: changes(play.p), n: changes(play.n), swipe: play.swipe.map(changes), swipeEnd: play.swipe.map(s => s.length ? s[s.length - 1].t : null),
    // Mọi mẫu đọc lúc video đang phát (ca này không được dừng video để đọc).
    neverPaused: [play.p, play.n, ...play.swipe].every(s => s.length && s.every(x => !x.paused)),
    lines01: timeline(play.p, P_LINES, 0.3, 19.5), lines2: timeline(play.p, P_LINES, 19.5, 23.5),
    badge816: play.p.filter(s => !s.paused && s.t >= 8 && s.t < 16).map(s => s.badge),
    c1At: okAt(get(PP, '0:10–0:20'), play.p), c2At: okAt(get(PP, '0:20–0:50'), play.p), n1At: okAt(get(PN, '0:10–0:20'), play.n),
    // Video được dịch sẵn: yêu cầu đầu tiên của nó; PP, PN xong trước lúc được lướt tới (đúng là dịch sẵn).
    pre: [...PA.slice(1), PP, PN, PN2].map(id => r[id][0] || null),
    preEarly: [[PP, play.p], [PN, play.n]].every(([id, s]) => { const x = get(id, '0:00–0:10'); return !!x && !!s.length && x.at < s[0].wall; }),
    reqs: Object.fromEntries(PIDS.map(id => [id, r[id].map(x => `${x.quick ? 'nhanh ' : ''}${x.range} ${x.status} ${x.seconds} s`)])) };
}
console.log({ english, health, first, atGap, atSecond, delayed, savedDelay, status, song, songOff, long, search, providerHits, hits0, cdnSongGapsMs: cdnSong.map(t => t - cdnSong[0]) });
if (f10) console.log('first10 play scenario:', JSON.stringify(f10, null, 1));
console.log('server log:\n' + alphaLog.trim());
// Yêu cầu ~12 s âm thanh: đoạn [0,10) gửi dư 2 s phía sau (F10_POST).
const s12 = (x) => !!x && !x.quick && x.range === '0:00–0:10' && x.status === 'ok' && x.seconds >= 11.5 && x.seconds <= 12.7;
// Cách 10 s, video 100 s: âm thanh từng đoạn (log server): [0,10) dư 2 s sau; [10,20) dư 4,5 s trước (F10_PRE1), 6 s sau;
// [20,50) [50,80) [80,101) dư 1,5 s trước (đoạn trước đã dịch), 6 s sau (hết file ở 100 s).
const AUDIO10 = { '0:00–0:10': 12, '0:10–0:20': 20.5, '0:20–0:50': 37.5, '0:50–1:20': 37.5, '1:20–1:41': 21.5 };
const audio10 = (() => {
  const got = Object.fromEntries(longReqs.filter(x => x.status === 'ok').map(x => [x.range, x.seconds]));
  return JSON.stringify(Object.keys(got).sort()) === JSON.stringify(Object.keys(AUDIO10).sort()) && Object.entries(AUDIO10).every(([k, s]) => Math.abs(got[k] - s) <= 0.7);
})();
const checks = {
  'popup sees the server': /Server chạy/.test(health),
  'first video subtitle shows Vietnamese at 1.2 s': first.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.',
  'nothing shown between lines (4.2 s)': atGap.sub === null,
  'second line at 5.2 s': atSecond.sub === 'Đi thôi!',
  '] key delays subs by 0.3 s and saves it': delayed.at12.sub === null && /lệch sub \+0\.3 s/.test(delayed.at12.badge || '')
    && delayed.at135.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.' && savedDelay === 0.3,
  'next videos prefetched (3 processed)': (status.counts.ok || 0) + (status.counts.skipped || 0) >= 3,
  'next video found in embedded page data (__pace_f), prefetched before the feed API answers': !!playRequestedAt[ids[1]] && (!feedServedAt || playRequestedAt[ids[1]] < feedServedAt),
  'first video: one request from byte 0 (bytes=0-) carries index and audio, no separate 64 KB index request':
    (playRanges[ids[0]] || [])[0] === 'bytes=0-' && !(playRanges[ids[0]] || []).includes('bytes=0-65535'),
  'liked video in the sidebar is not prefetched': !playRequested.has(FAV) && playRequested.has(ids[1]),
  'stalled CDN download dropped after ~6 s idle and retried; song video still processed': cdnSong.some(t => t - cdnSong[0] >= 5000 && t - cdnSong[0] < 15000) && /7500000000000000003 \[0:00[^\]]*\] (ok|skipped \(bài hát\))/.test(alphaLog),
  'song video (lyrics on by default): lyrics shown with ♪': /^♪ /.test(song.sub || ''),
  'lyrics turned off in popup: song skipped again, no sub, ASR reused': songOff.sub === null && /bài hát/.test(songOff.badge || '') && asrAfterOff === asrBeforeOff,
  'popup "Dịch cả lời bài hát" box: ticked by default, clicking it saves the setting': lyricsBoxDefault === true && lyricsSavedOff === false,
  // Mỗi video/đoạn chỉ xử lý một lần, tính cả mẩu nhanh "[nhanh …]" (mỗi lần tua tới một chỗ chỉ một mẩu).
  'ASR called once per video (dedupe)': (() => { const done = alphaLog.split('\n').map(l => /^\S+ \S+ (\d+)( \[[^\]]+\])? (ok|skipped)/.exec(l)).filter(Boolean).map(m => m[1] + (m[2] || ''));
    return done.length >= 4 && new Set(done).size === done.length; })(),
  'seek: quick 10 s piece sent at the seek point': /\[nhanh 1:25–1:3\d( ♪)?\]/.test(alphaLog),
  'short videos (12 s, 6 s) send no quick piece': !ids.slice(0, 3).some(id => new RegExp(id + ' \\[nhanh ').test(alphaLog)),
  'long video: chunk 1 line at 2.2 s': long.at2.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.',
  // Cách 10 s: chỉ đúng nghĩa khi bước phát thật đã tới 5 s (qua cửa 4 s) trước khi dừng để tua.
  'long video: chunk 2 line lands at 20.5 s (video time)': long.at21.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.' && (!F10 || long.playedTo >= 5),
  // Cách 10 s: longChunks (≥ 20 s âm thanh) là [10,20) [20,50) [50,80); kiểm thêm đúng các đoạn đã xong, chưa có [80,101).
  'long video: only chunks within 30 s of playhead processed': long.chunksBeforeSeek === 3
    && (!F10 || JSON.stringify([...long.doneBeforeSeek].sort()) === JSON.stringify(['0:00–0:10', '0:10–0:20', '0:20–0:50', '0:50–1:20'])),
  'long video: seek to 85 s translates that chunk': long.at85.sub === 'Đi thôi!' && long.at83.sub === null && long.chunks.length === 4,
  'hover on the badge shows what has been translated (playhead chunk ✓), hidden after leaving': /▶ 1:20–1:40 {2}✓ \d+ dòng/.test(long.info || '') && /Đã xong tới/.test(long.info || '') && long.infoAfter === null,
  // Đoạn 2 được gửi cùng lúc với đoạn 1 (cả hai nằm trong 30 s đầu): server chờ đoạn 1 dịch xong để lấy ngữ cảnh.
  // Cách 10 s: 4 đoạn sau đoạn đầu ([10,20) tới [80,101)). Số đếm tới trước ca phát liên tục (hits0).
  ...(F10 ? { 'later chunks translated with previous lines as context ([10,20) to [80,101), 10 s plan)': hits0.withContext >= 4 }
    : { 'later chunks translated with previous lines as context (chunks 2–4)': hits0.withContext >= 3 }),
  'first translation got HTTP 429, server retried (first video still has subs)': providerHits.rateLimited > 1 && first.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.',
  'player clock 50 s ahead of <video> (feed seek): sub follows the player': long.clock85.sub === 'Đi thôi!',
  ...(F10 ? { 'audio-only upload: chunk audio ≈ 12/20.5/37.5/37.5/21.5 s (10 s plan, server log per chunk)': audio10 }
    : { 'audio-only upload: chunk audio ≈ 26/38/38/22 s': JSON.stringify([...long.chunks].sort((a, b) => a - b)) === '[22,26,38,38]' }),
  'search page: video opened from chunked search/stream results is translated (request sent, badge shown, sub at 1.2 s)':
    new RegExp(SIDS[0] + '( \\[[^\\]]+\\])? ok').test(alphaLog) && !!search.badge && search.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.',
  'search page: next search result (later JSON block of search/stream) prefetched': search.prefetchedNext,
  'target language: choosing English in the popup re-translates the shown video from stored source lines (no new ASR), badge EN; back to Vietnamese at once':
    english.saved === 'en' && english.en.sub === 'Hi everyone, we are going for hotpot today.' && /^EN/.test(english.en.badge || '')
    && new RegExp(SIDS[0] + ' \\[[^\\]]+\\] →EN ok[^\\n]*dịch từ dòng gốc đã có \\(vi\\)').test(alphaLog)
    && english.back.sub === 'Chào cả nhà, hôm nay đi ăn lẩu.' && /^VI/.test(english.back.badge || ''),
  // Bảng xưng hô (P2): model trả, server trả về, extension gửi lại ở đoạn sau của cùng video, server đưa vào câu lệnh.
  'pronoun table round trip: later chunks of the long video carry the table back into the prompt': hits0.pronIn >= 2,
  'uploader nickname (author.nickname) reaches the translation prompt': hits0.authorIn >= 1,
  // Ca phát liên tục, cách 10 s (chỉ E2E_FIRST10=1; mẫu đọc mỗi 250 ms trong lúc phát, video không dừng).
  ...(f10 ? {
    'first10 play: chunk [0,10) and [10,20) lines shown at the right video times (read every 250 ms while playing, never paused)':
      f10.neverPaused && f10.lines01.n >= 50 && !f10.lines01.wrong.length && f10.lines01.seen.every(Boolean),
    'first10 play: no "đang dịch" from 8 s to 16 s while playing (server fast)': f10.neverPaused && f10.badge816.length >= 20 && f10.badge816.every(b => b === 'VI'),
    // Cửa 4 s (F10_GATE) và F10_NEAR = 6 cùng mở [10,20) ở giây phim 4 (video phát từ 0), cộng 1,5 s ASR giả (âm thanh ≥ 20 s):
    // xong sớm nhất ~5,5 s; cửa ngắn hơn (3 s: 4,8 s) thì sớm hơn 5,2 s. [20,50) thì cửa chặn tới khi qua cửa hay tới F10_NEAR
    // (giây 14): cửa 4 s thì tải ngay sau khi [10,20) xong, xong ~7–8 s; cửa dài (9,5 s: 11,4 s) thì không trước 10 s.
    'first10 play: gate 4 s / F10_NEAR: chunk [10,20) done at playhead 5.2–10 s (sent at 4 s, not earlier), chunk [20,50) done before 10 s (sent right after the 4 s gate)':
      f10.c1At != null && f10.c1At >= 5.2 && f10.c1At < 10 && f10.c2At != null && f10.c2At < 10,
    'first10 play: chunk [20,50) done (so sent) before playhead 20 s; its line shown at 20.5 s': f10.c2At != null && f10.c2At < 20
      && f10.lines2.n >= 5 && !f10.lines2.wrong.length && f10.lines2.seen.every(Boolean),
    'first10 prefetch: next videos send only [0,10) + 2 s (~12 s audio), done before they are reached; unwatched next video nothing more':
      f10.pre.every(s12) && f10.preEarly && play.reqs[PN2].length === 1,
    'first10 swipe (4 videos, ~2 s each): only chunk [0,10) sent (~12 s audio), no chunk [10,20) before the 4 s gate':
      f10.neverPaused && PA.every(id => play.reqs[id].length === 1 && s12(play.reqs[id][0])) && f10.swipeEnd.every(t => t >= 1 && t <= 3.5),
    // Cửa 1,5 s (F10_GATE_W) + 1,5 s ASR giả: xong sớm nhất ~3,0 s; cửa 4 s thì ≥ 5,5 s.
    'first10 gate after a video watched ≥ 8 s: next video sends chunk [10,20) after 1.5 s of play (done at playhead 2.9–5 s)':
      f10.n1At != null && f10.n1At >= 2.9 && f10.n1At < 5,
  } : {}),
  'no page errors': errors.length === 0,
  // Content script hỏi service worker bản nào ('hello'): đúng bản này thì gửi stream (§6y).
  'extension service worker is this build (hello → ok)': !!status && status.worker === 'ok',
  // Dòng tạm phải tới được tab qua background.js (mốc partial / quickPartial / chunkPartial): server luôn gọi OpenAI dạng stream,
  // nên đếm lần gọi stream không chứng minh được điều đó (verifier 2/11, F3).
  ...(MT === 'openai' ? { 'OpenAI stream: partial lines reached the page before the final result (partial marks)': providerHits.streamed > 0
    && !!status && (status.marks || []).some(m => Object.keys(m.t || {}).some(k => /^(quick|chunk)?[pP]artial$/.test(k))) } : {}),
};
console.log('\nCHECKS');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS ' : 'FAIL ') + k);
await ctx.close(); douyin.close(); providers.close(); alpha.kill();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

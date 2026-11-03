// Bộ công cụ đo trên Douyin thật (alpha/dev/real): phần dùng chung. Cách dùng và luật: README.md cạnh file này.
// Luật: ít video, nhịp người xem, chế độ khách, không đăng nhập hộ; dữ liệu của video (âm thanh, chữ) xoá khi xong lượt đo.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ALPHA = path.resolve(HERE, '..', '..');
export const EXT = path.join(ALPHA, 'extension');
export const SERVER_DIR = path.join(ALPHA, 'server');
// alpha/server/.gitignore bỏ qua work/, nên kết quả đo không bao giờ lọt vào commit.
export const OUT_ROOT = process.env.TOD_REAL_OUT ? path.resolve(process.env.TOD_REAL_OUT) : path.join(SERVER_DIR, 'work', 'real');
// Phiên bản kết quả trong cache: đọc từ chữ của pipeline.mjs, không import (import thì pipeline nạp alpha/server/.env).
export const PIPELINE_VERSION = (/PIPELINE_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(SERVER_DIR, 'pipeline.mjs'), 'utf8')) || [])[1];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const require = createRequire(import.meta.url);

export function playwright() {
  try { return require('playwright'); } catch (_) {
    throw new Error('Thiếu playwright: chạy "npm i --no-save playwright" trong alpha/dev/real, rồi "npx playwright install chromium".');
  }
}

// Tham số dòng lệnh: --tên giá_trị, cờ không có giá trị thì là true; còn lại là danh sách vị trí (_).
export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) out[a.slice(2)] = true; else { out[a.slice(2)] = v; i++; }
  }
  return out;
}

export const portFree = (port) => new Promise((r) => {
  const s = net.createServer();
  s.once('error', () => r(false));
  s.listen(port, '127.0.0.1', () => s.close(() => r(true)));
});
// Chờ cổng rảnh (tiến trình của lượt trước vừa tắt), tối đa ms; vẫn bận thì báo lỗi.
async function needPort(port, what, ms = 5000) {
  for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(250)) if (await portFree(port)) return;
  throw new Error(`cổng ${port} đang dùng (${what})`);
}
export const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } };
export const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch (_) { return []; } };
// Xoá thư mục, thử lại vài lần (Windows: tiến trình vừa tắt có thể còn giữ file).
export const rmrf = (p) => { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); return true; } catch (_) { return false; } };

// ---------------------------------------------------------------- Chromium riêng và extension
// Chromium riêng (hồ sơ tạm, tắt tiếng) nạp alpha/extension; không đụng Chromium hằng ngày của chủ dự án (cổng 9333).
export async function launchChromium({ profile, port = 9334, ext = EXT }) {
  await needPort(port, 'một Chromium khác đang chạy?');
  const { chromium } = playwright();
  const exe = process.env.CHROME || chromium.executablePath();
  fs.mkdirSync(profile, { recursive: true });
  const br = spawn(exe, [`--user-data-dir=${profile}`, `--load-extension=${ext}`, `--disable-extensions-except=${ext}`, `--remote-debugging-port=${port}`,
    '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
  let b = null;
  const close = async () => { try { if (b) await b.close(); } catch (_) {} try { br.kill(); } catch (_) {} await sleep(500); };
  try {
    for (let i = 0; ; i++) {
      try { b = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch (e) { if (i > 80) throw e; await sleep(250); }
    }
    const ctx = b.contexts()[0];
    return { b, ctx, sw: await extensionWorker(ctx), close };
  } catch (e) { await close(); throw e; }   // không để Chromium mồ côi giữ cổng
}
// Chrome for Testing có extension của chính nó cũng có background.js: nhận đúng extension của ta theo tên trong manifest.
export async function extensionWorker(ctx, tries = 80) {
  for (let i = 0; i < tries; i++) {
    for (const w of ctx.serviceWorkers()) {
      const name = await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => '');
      if (/^TranslatorOfDuck/.test(name)) return w;
    }
    await sleep(250);
  }
  throw new Error('không thấy service worker của extension');
}
// Gộp thêm vào cài đặt đã lưu (không ghi đè các ô khác về mặc định).
export const setSettings = (sw, patch) => sw.evaluate(async (p) => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const s = { ...settings, ...p };
  await chrome.storage.local.set({ settings: s });
  return s;
}, patch || {});
export const extStatus = (sw) => sw.evaluate(async () => {
  for (const t of await chrome.tabs.query({})) { try { const r = await chrome.tabs.sendMessage(t.id, { type: 'status' }); if (r) return r; } catch (_) {} }
  return null;
}).catch(() => null);

// Chạy trong trang: video đang phát (to nhất, có thời lượng), nhãn và sub của extension (shadow root mở).
// rate: đặt tốc độ; seek: tua chính thẻ video đó tới giây này.
export const PAGE_STATE = (opt) => {
  const { rate, seek } = typeof opt === 'object' && opt ? opt : { rate: opt };
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const v = [...document.querySelectorAll('video')].filter((x) => x.duration > 0 && area(x) > 0).sort((a, b) => area(b) - area(a))[0];
  if (v && seek != null) v.currentTime = seek;
  if (v && rate) { if (v.playbackRate !== rate) v.playbackRate = rate; if (v.paused) v.play().catch(() => {}); }
  let badge = null, dot = null, sub = null;
  for (const el of document.querySelectorAll('body > div, html > div')) {
    const sr = el.shadowRoot;
    if (!sr || !sr.querySelector('.sub')) continue;
    const bd = sr.querySelector('.badge'), d = sr.querySelector('.badge .dot'), s = sr.querySelector('.sub');
    if (bd && getComputedStyle(bd).display !== 'none') { badge = bd.textContent; dot = d ? d.style.background || d.style.backgroundColor : null; }
    if (s && getComputedStyle(s).display !== 'none') sub = s.textContent;
  }
  const act = document.querySelector('[data-e2e="feed-active-video"]');
  const inner = act && (act.getAttribute('data-e2e-vid') ? act : act.querySelector('[data-e2e-vid]'));
  return { t: v ? +v.currentTime.toFixed(2) : null, dur: v && isFinite(v.duration) ? +v.duration.toFixed(1) : null, rate: v ? v.playbackRate : null,
    paused: v ? v.paused : null, badge, dot, sub, vid: inner ? inner.getAttribute('data-e2e-vid') : null, url: location.pathname + location.search };
};
// Trạng thái nhãn theo màu chấm (BADGE trong alpha/extension/content.js), không theo chữ: chữ trên nhãn sẽ đổi theo ngôn ngữ.
const DOT = { '245,166,35': 'pending', '155,155,155': 'skipped', '231,76,60': 'error', '46,204,113': 'ok' };
export function stateOf(s) {
  if (!s || !s.badge) return 'none';
  const d = String(s.dot || '');
  const rgb = /(\d+)\D+(\d+)\D+(\d+)/.exec(d), hex = /#([0-9a-f]{6})/i.exec(d);
  const key = rgb ? `${rgb[1]},${rgb[2]},${rgb[3]}` : hex ? [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16)).join(',') : '';
  if (DOT[key]) return DOT[key];
  return /lỗi|error/i.test(s.badge) ? 'error' : /dịch|tải|chờ/i.test(s.badge) ? 'pending' : /bỏ qua|không/i.test(s.badge) ? 'skipped' : 'ok';
}
// Lỗi phía nền tảng đếm riêng với lỗi của ta (docs/ROADMAP.md §3): theo chữ extension ghi cho lỗi tải từ Douyin (429, tải
// video, tải mục lục, file video đã đổi). Lỗi của server (từ chối key, nhà cung cấp AI) là lỗi của ta dù có mã HTTP.
export const platformError = (s) => { const t = String((s && s.badge) || '');
  return /Douyin|tải video|tải mục lục|file video đã đổi|HTTP 429/i.test(t) && !/từ chối key|alpha\/server|OpenAI|Gemini|DashScope|server/i.test(t); };

// ---------------------------------------------------------------- server đo và proxy ghi yêu cầu
// Server đo riêng (cache trống trong work, giữ file nhận dạng để chạy lại offline: TOD_KEEP_ASR). Dùng key ở alpha/server/.env.
export async function startServer({ port = 8788, work, keepAsr = true, env = {} }) {
  await needPort(port, 'server đo khác đang chạy?');
  fs.mkdirSync(work, { recursive: true });
  const log = path.join(work, 'server.log');
  const fd = fs.openSync(log, 'a');
  const child = spawn(process.execPath, ['server.mjs'], { cwd: SERVER_DIR, stdio: ['ignore', fd, fd],
    env: { ...process.env, PORT: String(port), TOD_WORK: work, TOD_KEEP_ASR: keepAsr ? '1' : '', ...env } });
  fs.closeSync(fd);
  for (let i = 0; ; i++) {
    if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok).catch(() => false)) break;
    if (i > 80) { child.kill(); throw new Error('server đo không lên, xem ' + log); }
    await sleep(250);
  }
  return { url: `http://127.0.0.1:${port}`, cache: path.join(work, 'cache'), log, stop: async () => { child.kill(); await sleep(300); } };
}
// Proxy giữa extension và server: ghi từng yêu cầu và kết quả cuối (trạng thái, nhãn, số dòng; không ghi âm thanh, không ghi
// chữ), và lúc extension ngắt kết nối (huỷ).
export async function startProxy({ port = 8789, target, log }) {
  await needPort(port, 'proxy khác đang chạy?');
  const t0 = Date.now(), up = new URL(target);
  const write = (o) => fs.appendFileSync(log, JSON.stringify({ ms: Date.now() - t0, wall: Date.now(), ...o }) + '\n');
  let n = 0;
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks), rid = ++n;
      let meta = null;
      try { const { aac, b64, desc: _d, hashtags: _h, pronouns: _p, ...rest } = JSON.parse(body.toString()); meta = { ...rest, aacBytes: aac ? aac.length : undefined }; } catch (_) { /* không phải JSON */ }
      write({ ev: 'req', rid, url: req.url, meta });
      let done = false, got = '';
      const pr = http.request({ host: up.hostname, port: up.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode, r.headers);
        r.on('data', (c) => { res.write(c); if (got.length < 4e6) got += c; });
        r.on('end', () => {
          done = true; res.end();
          // Câu trả lời là JSON, hay NDJSON (dòng tạm rồi dòng cuối): chỉ lấy trạng thái của dòng cuối.
          let outcome = null;
          try { const x = JSON.parse(got.trim().split('\n').pop()); if (x && x.status) outcome = { status: x.status, label: x.label || null, cues: (x.cues || []).length, cached: !!x.cached }; } catch (_) {}
          write({ ev: 'done', rid, status: r.statusCode, outcome });
        });
      });
      pr.on('error', (e) => { write({ ev: 'error', rid, err: e.message }); try { res.end(); } catch (_) {} });
      res.on('close', () => { if (!done) { write({ ev: 'closed', rid }); pr.destroy(); } });
      pr.end(body);
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}`, log, close: () => new Promise((r) => srv.close(r)) };
}

// ---------------------------------------------------------------- cache của server
// Tên file: <id>.<q?><from>-<to>.<loại>.<phiên bản>.json; loại vi | vi.lyr | asr.<băm> (server.mjs cacheFile).
const FILE = /^(\d+)\.(q?)(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\.(vi\.lyr|vi|asr\.[0-9a-f]+)\.(.+)\.json$/;
export function cacheFiles(dir, version = PIPELINE_VERSION) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names.map((f) => { const m = FILE.exec(f); return m && { file: path.join(dir, f), id: m[1], quick: !!m[2], from: +m[3], to: +m[4], kind: m[5], version: m[6] }; })
    .filter((f) => f && (!version || f.version === version));
}
export const videoIds = (dir) => [...new Set(cacheFiles(dir).map((f) => f.id))];
// Như noSinging ở server.mjs: đoạn không có câu hát thì hai chế độ lời bài hát dùng chung một kết quả.
const noSinging = (x) => x && typeof x.sung === 'number' && x.sung === 0 && x.label !== 'singing' && !x.song && !(x.cues || []).some((c) => c.sung);
// Như stale ở server.mjs: kết quả của bản cũ mà server sẽ làm lại khi có người xem lại.
const stale = (x) => x && x.status === 'skipped' && (x.label === 'too_short' || (x.label === 'no_speech' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(x.heard || '')));
// Kết quả từng đoạn của một video theo chế độ lời bài hát (lyrics, mặc định bật như extension). Đoạn có file nhận dạng mà
// không có kết quả (dịch ra 0 dòng, lỗi, bị huỷ giữa chừng) trả về với status 'none'; kết quả cũ server sẽ làm lại: stale.
// version: phiên bản kết quả cần đọc; null thì lấy phiên bản đang chạy nếu thư mục có, không thì phiên bản của file mới nhất
// (lượt đo cũ chạy lại sau khi pipeline tăng phiên bản).
export function chunksOf(dir, id, lyrics = true, version = PIPELINE_VERSION) {
  const want = lyrics ? 'vi.lyr' : 'vi', other = lyrics ? 'vi' : 'vi.lyr';
  const mine = cacheFiles(dir, null).filter((f) => f.id === id);
  if (version == null) version = mine.some((f) => f.version === PIPELINE_VERSION) ? PIPELINE_VERSION
    : (mine.map((f) => ({ v: f.version, t: fs.statSync(f.file).mtimeMs })).sort((a, b) => b.t - a.t)[0] || {}).v;
  const spans = new Map();
  for (const f of mine) {
    if (f.version !== version) continue;
    const k = (f.quick ? 'q' : '') + f.from + '-' + f.to;
    if (!spans.has(k)) spans.set(k, { quick: f.quick, from: f.from, to: f.to, asr: [] });
    if (f.kind.startsWith('asr.')) spans.get(k).asr.push(f.file); else spans.get(k)[f.kind] = f.file;
  }
  const out = [];
  for (const s of spans.values()) {
    let x = s[want] && readJson(s[want]);
    if (!x && s[other]) { const y = readJson(s[other]); if (noSinging(y)) x = y; }
    if (x) { out.push({ ...x, quick: s.quick, from: s.from, to: s.to, ...(stale(x) ? { stale: true } : {}) }); continue; }
    // Không có kết quả: lấy câu nghe được từ file nhận dạng mới nhất có vị trí âm thanh (server đo, TOD_KEEP_ASR).
    const a = s.asr.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((p, q) => q.t - p.t).map((p) => readJson(p.f)).find((y) => y && y.window && y.asr);
    const sents = a ? (a.asr.segments || []).map((g) => ({ start: g.start + a.window.audioStart, end: g.end + a.window.audioStart, text: g.text })) : [];
    if (s.asr.length) out.push({ status: 'none', quick: s.quick, from: s.from, to: s.to, heard: '', debug: { sentences: sents }, noWindow: !a });
  }
  return out.sort((a, b) => a.from - b.from || a.quick - b.quick);
}

// ---------------------------------------------------------------- dòng sẽ hiện, câu bị mất
let todCues = null;
export function cuesLib() {
  if (!todCues) {
    const ctx = {}; ctx.globalThis = ctx; vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(EXT, 'cues.js'), 'utf8'), ctx);
    todCues = ctx.TodCues;
  }
  return todCues;
}
// Như mergeCues trong content.js: các đoạn đã xong, cộng dòng của mẩu nhanh không trùng đoạn nào (chưa tính dòng tạm).
export function mergedCues(chunks) {
  const done = chunks.filter((c) => !c.quick && c.status === 'ok');
  const se = (c) => c.se || c.end;
  const covered = (cue) => done.some((ch) => (cue.start >= ch.from && cue.start < ch.to) || (ch.cues || []).some((x) => cue.start < se(x) - 0.1 && x.start < se(cue) - 0.1));
  const quick = chunks.filter((c) => c.quick && c.status === 'ok').map((q) => ({ ...q, cues: (q.cues || []).filter((x) => !covered(x)) })).filter((q) => q.cues.length);
  return cuesLib().merge([...done, ...quick].sort((a, b) => a.from - b.from).map((c) => ({ from: c.from, to: c.to, cues: c.cues || [] })));
}
// Độ dài chuỗi con chung dài nhất của a và b.
export function longestCommon(a, b) {
  let best = 0, prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    prev = cur;
  }
  return best;
}
// Số chữ phải sửa ít nhất (thêm, bớt, thay) để a thành một khúc liền nào đó của b (so chuỗi gần đúng kiểu Sellers).
export function editInside(a, b) {
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(...prev);
}
export const norm = (t) => String(t || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
// Tiếng đệm đã chấp nhận: vế câu chỉ có 嗯, 啊, 呃, 额, hay tiếng đệm chữ Latin (yeah, oh: pipeline bỏ từ 31/10) không tính là
// mất câu. Tiếng kêu khác (诶, 哎呀, 嘿, 哇) vẫn tính, vì chủ dự án chưa quyết có bỏ không (ROADMAP §6).
const FILLER_HAN = /^[嗯啊呃额]+$/u;
const SOUND = /^(?:(?:o+h*|a+h*|uh+|um+|m{2,}|hm+|huh|ye(?:ah?|h)?|hey|wo+w?|woah|whoa|eh|ay|(?:la)+|(?:na)+|(?:da)+|(?:ha)+|(?:ya)+|(?:yo)+))+$/i;
export const isFillerClause = (p) => FILLER_HAN.test(p) || SOUND.test(p);
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Vế câu: tách theo dấu câu Trung và Latin; mọi hệ chữ đều tính. Một chữ Hán, kana, chữ Hàn (好, 喂, 走) cũng là một vế.
export const clausesOf = (text) => String(text || '').split(/[，。！？；、,.!?;…]+/u).map(norm)
  .filter((p) => p.length >= (CJK.test(p) ? 1 : 2) && !isFillerClause(p));
// Nhãn bỏ cả đoạn đã chấp nhận: không nghe thấy chữ nào; bài hát khi đã tắt lời bài hát; tiếng đệm 嗯/啊 (docs/ROADMAP.md §3).
// Tiếng đệm khác (诶, 哎呀, 嘿) còn chờ chủ dự án quyết (ROADMAP §6), nên vẫn là "cần duyệt".
const acceptedSkip = (c, lyrics) => (c.label === 'no_speech' && !norm(c.heard)) || (c.label === 'singing' && !lyrics)
  || (c.label === 'filler' && /^[嗯啊呃额]*$/u.test(norm(c.heard)));
// Vế p có trong chữ của các dòng đã gộp quanh nó (nối liền, vì một vế có thể vắt qua hai dòng: "…三连音在" + "海绵宝宝…")?
// Câu vắt qua ranh giới đoạn có ở cả hai đoạn, mỗi bên nghe một kiểu, và cues.js giữ một bản. 'ok': có nguyên vẹn. 'one': khác
// một chữ (tiếng đệm 啊, 储入/储物), chỉ với vế từ 4 chữ. 'part': thiếu vài chữ ở chỗ nối, phần lớn vế còn liền một khúc; tính là
// mất nhưng đã chấp nhận. 'lost': mất. Chữ phủ định (不, 没…) của vế phải có trong các dòng: thiếu nó là đổi nghĩa.
const NEGATION = /[不没別别未非无無]/gu;
function mergedCheck(p, near) {
  if (near.includes(p)) return 'ok';
  if (p.length < 4 || (p.match(NEGATION) || []).some((x) => !near.includes(x))) return 'lost';
  if (editInside(p, near) <= 1) return 'one';
  return longestCommon(p, near) >= 0.6 * p.length ? 'part' : 'lost';
}
// Mọi vế câu server nghe được ở phần chính của đoạn (không tính phần âm thanh gửi dư), và vế nào không thành dòng sub hiện ra.
// lost: mọi vế không có dòng (kể cả đã chấp nhận); unapproved: vế mất chưa được chấp nhận.
export function drops(chunks, { lyrics = true } = {}) {
  const items = [];
  let clauses = 0, lost = 0, unapproved = 0, staleN = 0, noResult = 0;
  const merged = mergedCues(chunks);
  // Chữ của các dòng đã gộp quanh [a, b], nối liền: một vế có thể vắt qua hai dòng ("刺耳三连音在" + "海绵宝宝身边时…").
  const nearText = (a, b) => norm(merged.filter((m) => m.end >= a - 1 && m.start <= b + 1).map((m) => m.zh).join(''));
  for (const c of chunks.filter((x) => !x.quick)) {
    if (c.stale) { staleN++; continue; }
    const main = ((c.debug && c.debug.sentences) || []).filter((s) => { const mid = (s.start + s.end) / 2; return mid >= c.from && mid < c.to; });
    const parts = main.flatMap((s) => clausesOf(s.text).map((p) => ({ p, s })));
    clauses += parts.length;
    if (c.status === 'none') noResult++;
    if (c.status !== 'ok') {
      const why = c.status === 'none' ? 'không có kết quả (dịch ra 0 dòng, lỗi, hay bị huỷ)' : 'bỏ cả đoạn: ' + c.label;
      const ok = c.status === 'skipped' && acceptedSkip(c, lyrics);
      lost += parts.length;
      if (!ok) unapproved += parts.length;
      if (parts.length || !ok) items.push({ span: `${c.from}-${c.to}`, why, accepted: ok || !parts.length, clauses: parts.length, heard: c.heard || '' });
      continue;
    }
    const have = norm((c.cues || []).map((x) => x.zh).join(''));
    const mt = (c.debug && c.debug.mtFix && c.debug.mtFix.dropped) || [];
    for (const { p, s } of parts) {
      if (have.includes(p)) {
        // Có trong dòng của đoạn; xem bước ghép sub (cues.js) có bỏ mất không. Vế vắt qua hai dòng của đoạn: so theo giờ của câu.
        const cue = (c.cues || []).find((x) => norm(x.zh).includes(p));
        const at = mergedCheck(p, nearText(cue ? cue.start : s.start, cue ? cue.end : s.end));
        if (at === 'ok') continue;
        if (at === 'one') { items.push({ span: `${c.from}-${c.to}`, t: +s.start.toFixed(1), why: 'ghép sub: khác một chữ', accepted: true, text: p }); continue; }
        lost++;
        if (at === 'part') { items.push({ span: `${c.from}-${c.to}`, t: +s.start.toFixed(1), why: 'ghép sub: thiếu vài chữ ở chỗ nối', accepted: true, text: p }); continue; }
        unapproved++;
        items.push({ span: `${c.from}-${c.to}`, t: +s.start.toFixed(1), why: 'bỏ khi ghép sub', accepted: false, text: p });
        continue;
      }
      lost++;
      if (s.sung && !lyrics) { items.push({ span: `${c.from}-${c.to}`, t: +s.start.toFixed(1), why: 'câu hát (lời bài hát đang tắt)', accepted: true, text: p }); continue; }
      unapproved++;
      const d = mt.find((x) => norm(x.zh).includes(p));
      items.push({ span: `${c.from}-${c.to}`, t: +s.start.toFixed(1), why: d ? 'dịch: ' + (d.why === 'han' ? 'còn chữ Hán' : 'trống') : 'chia câu hay cắt đoạn', accepted: false, text: p });
    }
  }
  return { clauses, lost, unapproved, stale: staleN, noResult, coverage: clauses ? +(100 * (clauses - lost) / clauses).toFixed(2) : null, items };
}
// Quãng nghi nghe sót (để nghe lại, "nghe đủ"): khoảng hơn `min` giây không có câu nào, trong phần chính của các đoạn đã nhận
// dạng, kể cả đầu và cuối phần đó. Chưa lọc theo năng lượng âm thanh, nên quãng nhạc, im lặng cũng hiện.
export function silentGaps(chunks, min = 4) {
  const done = chunks.filter((c) => !c.quick && (c.status === 'ok' || c.status === 'skipped') && !c.stale);
  if (!done.length) return [];
  const sents = done.flatMap((c) => ((c.debug && c.debug.sentences) || []).filter((s) => { const mid = (s.start + s.end) / 2; return mid >= c.from && mid < c.to; }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  let end = Math.min(...done.map((c) => c.from));
  for (const s of sents) { if (s.start - end > min) out.push([+end.toFixed(1), +s.start.toFixed(1)]); end = Math.max(end, s.end); }
  const last = Math.max(...done.map((c) => c.to));
  if (last - end > min) out.push([+end.toFixed(1), +last.toFixed(1)]);
  return out;
}
// Tốc độ đọc: số ký tự hiển thị (kể cả dấu cách) mỗi giây của dòng dịch.
export function readingSpeed(cues, limit = 17) {
  const seg = new Intl.Segmenter('vi', { granularity: 'grapheme' });
  let n = 0, ok = 0;
  for (const c of cues) {
    const d = c.end - c.start;
    if (!(d > 0)) continue;
    n++;
    if ([...seg.segment(String(c.vi || ''))].length / d <= limit) ok++;
  }
  return { cues: n, limit, within: n ? +(100 * ok / n).toFixed(1) : null };
}

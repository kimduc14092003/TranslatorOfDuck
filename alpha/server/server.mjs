#!/usr/bin/env node
// Server Alpha chạy trên máy bạn: extension gửi âm thanh từng đoạn video Douyin, server trả sub tiếng Việt.
// Key nằm trong alpha/server/.env, không bao giờ vào extension.
//   node server.mjs        (mặc định http://127.0.0.1:8787)
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFfmpeg, condenseCues, config, dotEnvInfo, makeSubtitles, mergePronouns, misplacedOpenAIKey, normalizePronouns, PIPELINE_VERSION, pronounChanges, tooLong, warmProviders } from './pipeline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const CACHE = path.join(process.env.TOD_WORK || path.join(HERE, 'work'), 'cache');
const MAX_BODY = 40 * 1024 * 1024;
// Lướt nhanh: video đang xem + 4 video dịch sẵn + đoạn kế cùng chờ; 2 việc một lúc thì video thứ 3 trở đi không kịp.
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL) || 4;
// Server đo của alpha/dev/real: giữ file nhận dạng (kèm vị trí âm thanh, mô tả) để chạy lại offline; server hằng ngày thì không.
const KEEP_ASR = process.env.TOD_KEEP_ASR === '1';
fs.mkdirSync(CACHE, { recursive: true });

// Tối đa MAX_PARALLEL đoạn xử lý cùng lúc; cùng một đoạn thì dùng chung một lần xử lý (inflight).
// Hàng đợi có ưu tiên: đoạn chứa chỗ đang xem (urgent) trước, rồi video gần chỗ đang xem trước (rank: 0 = video đang
// xem, 1 = video kế tiếp, … 4 = video dịch sẵn xa nhất), rồi yêu cầu mới nhất trước. Tua liên tiếp nhiều chỗ thì chỗ
// dừng cuối được làm ngay, không phải chờ các chỗ đã tua qua (đo trên Douyin thật: trước đây 25 s mới có sub).
// Có rank vì chỉ xếp theo mới nhất thì lúc đông việc, video dịch sẵn thứ 4 (gửi sau cùng) chạy trước video kế tiếp.
// Đoạn urgent được dùng thêm một chỗ. Đoạn không còn ai chờ (extension huỷ vì người xem đã tua đi): còn xếp hàng thì
// bỏ, đang chạy thì dừng giữa chừng, để chỗ đang xem không phải chờ và khỏi tốn tiền API.
let running = 0;
let seq = 0;
const queue = [];
const inflight = new Map();      // key → job { promise, urgent, rank, seq, started, waiters, cancel() }
const cancelledError = () => Object.assign(new Error('cancelled'), { cancelled: true });
const CONTEXT_WAIT_MS = 30000;
const canRun = (job) => running < MAX_PARALLEL || (job.urgent && running < MAX_PARALLEL + 1);
function pumpQueue() {
  queue.sort((a, b) => (b.urgent - a.urgent) || (a.rank - b.rank) || (b.seq - a.seq));
  while (queue.length && canRun(queue[0])) { const job = queue.shift(); running++; job.start(); }
}
// Không gửi rank (extension cũ, video đang xem) thì coi là 0.
const rankOf = (x) => (Number.isInteger(x) && x >= 0 ? x : 0);
// fn(signal): signal bị huỷ khi không còn ai chờ đoạn đang chạy → dừng lệnh gọi ASR/dịch, nhường chỗ cho chỗ đang xem.
function submit(key, urgent, rank, fn) {
  const job = { urgent: !!urgent, rank: rankOf(rank), seq: ++seq, started: false, waiters: 0, at: Date.now() };
  const ctl = new AbortController();
  job.promise = new Promise((resolve, reject) => {
    job.start = () => {
      job.started = true; job.startedAt = Date.now();
      Promise.resolve().then(() => fn(ctl.signal))
        .then(resolve, (e) => reject(ctl.signal.aborted ? cancelledError() : e))
        .finally(() => { running--; pumpQueue(); });
    };
    job.cancel = () => {
      const i = queue.indexOf(job);
      if (i >= 0) { queue.splice(i, 1); reject(cancelledError()); } else if (job.started) ctl.abort(cancelledError());
    };
  });
  job.promise.then(() => inflight.delete(key), () => inflight.delete(key));
  inflight.set(key, job);
  queue.push(job);
  pumpQueue();
  return job;
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body_too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// File cache hỏng (máy tắt hay đĩa đầy giữa lúc ghi): trước đây JSON.parse ném lỗi trong hàm async và server thoát
// (đo: file bị cắt cụt → server thoát mã 1). Giờ coi như chưa có, xoá đi để lần sau làm lại. Ghi thì ghi ra file tạm
// rồi đổi tên: không bao giờ để lại file viết dở.
function readCache(f) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (_) { return null; }
  try { return JSON.parse(text); } catch (_) {
    console.log(`  → cache hỏng, xoá để làm lại: ${path.basename(f)}`);
    try { fs.rmSync(f, { force: true }); } catch (_) { /* để lần sau */ }
    return null;
  }
}
let tmpSeq = 0;
function writeCache(f, obj) {
  const tmp = `${f}.${process.pid}.${++tmpSeq}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); } catch (e) {
    console.log(`  → không ghi được cache ${path.basename(f)}: ${e.message}`);
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* bỏ qua */ }
  }
}

// Chỉ nhận request của extension. Trang web bất kỳ gửi được POST text/plain tới 127.0.0.1 mà trình duyệt không hỏi
// trước (CORS preflight), và server sẽ trả tiền ASR + dịch cho nó (đo: POST text/plain chạy đủ ASR). Service worker
// của extension gửi Origin chrome-extension://… và application/json; test, curl trên máy không có Origin.
function rejectForeign(req, res) {
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) { req.resume(); send(res, 403, { error: 'forbidden_origin' }); return true; }
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { req.resume(); send(res, 415, { error: 'need content-type: application/json' }); return true; }
  return false;
}

async function handleSubtitles(req, res) {
  let meta;
  try { meta = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return send(res, 400, { error: 'bad_body: ' + e.message }); }
  const id = String(meta.id || '');
  const num = (x) => typeof x === 'number' && isFinite(x) && x >= 0;
  const chunked = typeof meta.aac === 'string';
  if (!/^\d{6,25}$/.test(id) || !(chunked || typeof meta.b64 === 'string')) return send(res, 400, { error: 'need id (digits) and aac or b64' });
  if (chunked && !(num(meta.from) && num(meta.to) && meta.to > meta.from && num(meta.audioStart))) return send(res, 400, { error: 'need from < to and audioStart' });
  const span = (a, b) => `${a}-${b}`;
  const cacheFile = (sp, kind = 'vi') => path.join(CACHE, `${id}.${sp ? sp + '.' : ''}${kind}.${PIPELINE_VERSION}.json`);
  // Mẩu nhanh (quick): ~10 s ngay tại chỗ vừa tua tới, gửi song song với đoạn 30 s để sub đầu ra sớm. Cache riêng (tiền tố q).
  const quick = chunked && meta.quick === true;
  const fileSpan = chunked ? (quick ? 'q' : '') + span(meta.from, meta.to) : '';
  // Chế độ lời bài hát (extension gửi lyrics: true, mặc định bật): kết quả lưu riêng (.vi.lyr.). Đoạn không có câu hát
  // nào thì hai chế độ ra cùng một kết quả: dùng lại file của chế độ kia, đổi chế độ không phải dịch lại.
  // Không có câu hát nào: sung (số câu hát) = 0, không phải bài hát, không có dòng ♪. Cả đoạn là bài hát mà không câu
  // nào tự đủ dài để tính là câu hát (điệp khúc câu 3 chữ; ASR Gemini không có mốc từng chữ) thì sung = 0 mà mọi dòng là
  // dòng hát: trước đây chế độ thường nhận nhầm kết quả đó, hiện cả các dòng ♪. Đoạn cả bài (song) cũng không dùng chung:
  // chế độ thường chỉ giữ câu nói nhanh, kết quả có thể là ok, sung = 0, không dòng ♪ mà vẫn thiếu lời hát (§6n).
  const lyrics = meta.lyrics === true;
  const MT = lyrics ? 'vi.lyr' : 'vi';
  const noSinging = (x) => x && typeof x.sung === 'number' && x.sung === 0 && x.label !== 'singing' && !x.song && !(x.cues || []).some(c => c.sung);
  const file = cacheFile(fileSpan, MT);
  const key = file;
  const otherFile = cacheFile(fileSpan, lyrics ? 'vi' : 'vi.lyr');
  // Kết quả bản cũ bỏ cả đoạn vì "quá ít lời" (dưới 4 chữ Hán), hay coi câu toàn kana, chữ Hàn là không có lời: làm lại.
  const stale = (x) => x && x.status === 'skipped' && (x.label === 'too_short' || (x.label === 'no_speech' && /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(x.heard || '')));
  const fresh = (f) => { const x = readCache(f); return stale(x) ? null : x; };
  const ready = () => { const other = fresh(otherFile); return fresh(file) || (noSinging(other) ? other : null); };
  // full, condensedLater (rút gọn sau): chỉ cho công cụ đo đọc file cache, không gửi extension.
  const fromCache = (x) => { const { debug: _d, condensedLater: _l, ...c } = x; return { ...c, ...(Array.isArray(c.cues) ? { cues: c.cues.map(({ full: _f, ...q }) => q) } : {}), cached: true }; };
  // Bảng xưng hô trả cho request này (cả request nhập vào việc đang chạy của request khác, việc đó dịch với bảng của
  // request kia). Kết quả lấy từ cache mang bảng lúc nó được dịch, có thể cũ hơn bảng extension vừa gửi (tua lại đoạn đã
  // dịch): bảng extension gửi đứng trước, thêm cặp chỉ file cache có, để extension (giữ bảng mới nhất) không lùi về bảng
  // cũ. Kết quả vừa dịch: bảng model vừa chốt đứng trước (có thể là cặp sửa), thêm cặp request này gửi mà thiếu.
  // Chỉ đoạn 'ok' mới có bảng. File cache không đổi.
  const withPronouns = (x) => {
    const { pronouns: _p, ...c } = x;
    const p = c.status === 'ok' ? (c.cached ? mergePronouns(meta.pronouns, x.pronouns) : mergePronouns(x.pronouns, meta.pronouns)) : null;
    return { ...c, ...(p ? { pronouns: p } : {}) };
  };
  const hit = ready();
  if (hit) return send(res, 200, withPronouns(fromCache(hit)));
  let job = inflight.get(key);
  if (job && !job.started) { job.urgent = job.urgent || !!meta.urgent; job.rank = Math.min(job.rank, rankOf(meta.rank)); job.seq = ++seq; pumpQueue(); }   // lại được hỏi: đẩy lên
  // Dòng dịch xong trước (OpenAI stream): việc giữ bản mới nhất (partials) và báo các request đang chờ nó (listeners), kể cả
  // request nhập vào việc đang chạy của request khác.
  const feed = (job && job.feed) || { partials: null, listeners: new Set() };
  if (!job) {
    // TOD_DUMP=1: giữ âm thanh nhận được ở work/dump (tên file kèm audioStart) để soi lỗi ASR, mốc thời gian. Chỉ để trên máy, xoá sau khi xong.
    if (process.env.TOD_DUMP) {
      const dir = path.join(CACHE, '..', 'dump');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, path.basename(file, '.json') + (chunked ? `.at${meta.audioStart}.aac` : '.mp4')), Buffer.from(chunked ? meta.aac : meta.b64, 'base64'));
    }
    let opts = {}, later = false;
    if (chunked) {
      // Ngữ cảnh: 3 dòng cuối của đoạn trước. Khi tua, đoạn đang xem và đoạn kế được gửi cùng lúc: nếu đoạn trước
      // đang chạy thì chờ nó dịch xong (chỉ chờ ở bước dịch, nhận dạng giọng nói vẫn chạy song song). Đoạn trước
      // còn xếp hàng thì không chờ, để hai đoạn không giữ chỗ chờ nhau.
      const prevSpan = Array.isArray(meta.prev) && meta.prev.length === 2 && meta.prev.every(num) ? span(meta.prev[0], meta.prev[1]) : null;
      const prev = prevSpan ? cacheFile(prevSpan, MT) : null;
      // Chế độ thường không hiện dòng hát: không lấy chúng làm ngữ cảnh (lời bài hát xưng hô, giọng văn khác lời nói).
      // Cùng file đó cho bảng xưng hô (pronouns) của đoạn: đoạn gửi cùng lúc với đoạn trước, hay sau khi tải lại
      // extension, không có bảng từ extension (đợt soát 1/11, F2). Server vẫn không giữ trạng thái: chỉ đọc cache.
      const fromFile = (f) => { try { const x = readCache(f) || {}; return { lines: (x.cues || []).filter(c => lyrics || !c.sung).slice(-3).map(c => ({ zh: c.zh, vi: c.vi })), pronouns: x.status === 'ok' ? normalizePronouns(x.pronouns) : null }; } catch (_) { return { lines: [], pronouns: null }; } };
      const context = async (signal) => {
        if (prev) {
          const pj = inflight.get(prev);
          if (pj && pj.started) {
            await Promise.race([pj.promise.catch(() => {}), new Promise(r => { setTimeout(r, CONTEXT_WAIT_MS); signal?.addEventListener('abort', r, { once: true }); })]);
          }
          // Đoạn liền trước đã cache mà không có dòng nào (bỏ qua: nhạc, không lời) thì vẫn tìm xa hơn bên dưới; trước
          // đây trả ngữ cảnh rỗng dù đoạn trước nữa đã dịch.
          const p = fromFile(prev);
          if (p.lines.length) return p;
          const o = fromFile(cacheFile(prevSpan, lyrics ? 'vi' : 'vi.lyr'));   // đoạn trước dịch ở chế độ kia
          if (o.lines.length) return o;
        } else if (!quick) return [];   // đoạn đầu video
        // Đoạn liền trước chưa dịch (vừa tua tới) hoặc không có dòng nào, hoặc mẩu nhanh (không chờ gì): lấy đoạn đã
        // dịch gần nhất phía trước có dòng dịch, để giữ xưng hô, tên riêng.
        const re = new RegExp(`^${id}\\.(\\d+)-(\\d+)\\.vi(?:\\.lyr)?\\.${PIPELINE_VERSION}\\.json$`);
        const near = fs.readdirSync(CACHE).map(f => [f, re.exec(f)]).filter(([, m]) => m && Number(m[2]) <= meta.from)
          .sort((a, b) => Number(b[1][2]) - Number(a[1][2]));
        for (const [f] of near) {
          const x = fromFile(path.join(CACHE, f));
          if (x.lines.length) return { ...x, far: true };
        }
        return [];
      };
      // Mẩu nhanh, đoạn dịch sẵn (video kế tiếp) và đoạn gấp (chứa hay sắp tới chỗ đang xem: urgent) bỏ lượt rút gọn: bớt một
      // lần gọi model, xong sớm hơn. Đo 2/11 trên 503 đoạn trong cache: có rút gọn thì dịch mất 4,0 s (trung vị) thay vì 1,8 s.
      // Đoạn gấp là lúc đang trễ (vừa tua, mạng chậm): sub sớm hơn ~2 s đáng hơn dòng ngắn hơn.
      opts = { kind: 'aac', offset: meta.audioStart, from: meta.from, to: meta.to, context, condense: !quick && meta.prefetch !== true && meta.urgent !== true };
      // Rút gọn sau (extension từ 0.2.42 gửi condenseLater: true cùng stream: true): đoạn gấp, dịch sẵn vẫn trả kết quả ngay như
      // trên, rồi mới rút gọn dòng dài; bản rút gọn gửi thêm một dòng { condensed: [dòng…] } sau dòng kết quả, và ghi đè vào cache.
      // Extension chỉ thay những dòng chưa hiện (chủ dự án 4/11: giữ sub ra sớm, ROADMAP §6).
      later = !quick && !opts.condense && meta.stream === true && meta.condenseLater === true;
    }
    opts.lyrics = lyrics;
    const buf = Buffer.from(chunked ? meta.aac : meta.b64, 'base64');
    // Kết quả nhận dạng giọng nói giữ theo mã băm âm thanh (cùng đoạn mà gửi dư khác nhau thì âm thanh, mốc thời gian
    // khác nhau): dịch lỗi rồi extension gửi lại thì không trả tiền ASR lần nữa. Có kết quả cuối thì xoá, trừ đoạn có câu
    // hát (cùng điều kiện noSinging): đổi chế độ lời bài hát thì đoạn đó phải làm lại, giữ ASR để khỏi trả tiền lần nữa.
    // TOD_KEEP_ASR=1 (chỉ server đo của alpha/dev/real): giữ lại cả file này để chạy lại offline bước chia câu, chia đoạn, ghép sub;
    // công cụ đo xoá cả thư mục khi xong lượt đo. window: vị trí âm thanh trong video và mô tả, hashtag (classifySpeech
    // dùng hashtag nhạc), để chạy lại đúng như lúc đó.
    const asrFile = cacheFile(fileSpan, 'asr.' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16));
    const asrCache = {
      load: () => { const x = readCache(asrFile); return x && typeof x.seconds === 'number' && x.asr && Array.isArray(x.asr.segments) ? x : null; },
      save: (x) => writeCache(asrFile, KEEP_ASR && chunked ? { ...x, window: { audioStart: meta.audioStart, from: meta.from, to: meta.to, quick, desc: meta.desc || '', hashtags: meta.hashtags || [] } } : x),
    };
    // Rút gọn sau khi đã trả kết quả: không giữ chỗ trong hàng (submit), không huỷ theo request (đã có kết quả cuối). Trả các
    // dòng sau khi rút gọn (đủ dòng, cùng thứ tự), hay null khi không dòng nào ngắn đi (lượt rút gọn lỗi, model không rút được).
    const condenseAfter = async (out) => {
      const t0 = Date.now();
      const short = await condenseCues(out.cues.filter(tooLong), out.pronouns, null);
      if (!short.size) { console.log(`${new Date().toLocaleTimeString()} ${id} [${span(meta.from, meta.to)}] rút gọn sau: không dòng nào ngắn đi · ${Date.now() - t0} ms`); return null; }
      // full: bản đầy đủ đã trả trước đó. Extension chỉ thay dòng đang mang đúng chữ đó; cache giữ nó để công cụ đo (alpha/dev/real)
      // so được chữ đã hiện (dòng đã hiện lúc đó vẫn là bản đầy đủ).
      const cues = out.cues.map(c => (short.has(c) ? { ...c, vi: short.get(c), full: c.vi } : c));
      // Ghi đè cache khi file vẫn là kết quả này (cùng số dòng, cùng mốc): lần xem lại có sẵn bản rút gọn.
      const cur = readCache(file);
      if (cur && Array.isArray(cur.cues) && cur.cues.length === cues.length && cur.cues.every((c, i) => c.start === cues[i].start)) writeCache(file, { ...cur, cues, condensedLater: short.size });
      console.log(`${new Date().toLocaleTimeString()} ${id} [${span(meta.from, meta.to)}] rút gọn sau: ${short.size}/${out.cues.filter(tooLong).length} dòng dài · ${Date.now() - t0} ms`);
      return cues;
    };
    job = submit(key, meta.urgent, meta.rank, async (signal) => {
      // Lúc tới lượt chạy, đoạn này có thể đã có kết quả: việc của chế độ kia cho cùng đoạn vừa xong mà không có câu hát
      // (hai tab, hay đổi nút lúc đoạn đang xếp hàng). Dùng luôn, khỏi trả tiền ASR và dịch lần nữa (đợt soát 31/10: việc
      // chạy sau không xem lại cache, file .asr. đã bị việc trước xoá).
      const now = ready();
      if (now) return fromCache(now);
      // pronouns: bảng xưng hô của video extension giữ từ các lần trả trước (gửi lại nguyên dạng server đã trả); author:
      // người đăng. Không vào khoá cache: cùng đoạn thì dùng lại kết quả đã có. Request cũ không gửi thì như trước.
      // Extension gửi author là chuỗi tên, giới tính ở trường riêng authorGender ('male'/'female'): gộp lại cho authorHint.
      const author = meta.authorGender ? { nickname: typeof meta.author === 'string' ? meta.author : '', gender: meta.authorGender } : meta.author;
      const onPartial = (cues) => { feed.partials = cues; for (const l of feed.listeners) l(cues); };
      const r = await makeSubtitles({ desc: meta.desc, hashtags: meta.hashtags, author, pronouns: meta.pronouns }, buf, { ...opts, signal, asrCache, onPartial });
      const out = { id, ...(chunked ? { from: meta.from, to: meta.to } : {}), ...r };
      // 'untranslated' (dịch không ra dòng nào) không cache: lần sau thử dịch lại, ASR đã có sẵn ở asrFile.
      // Lỗi (kể cả không chạy được ffmpeg) thì báo 'error' qua catch bên dưới, không bao giờ cache.
      if (r.status !== 'error' && r.label !== 'untranslated') {
        writeCache(file, out);
        if (noSinging(out) && !KEEP_ASR) try { fs.rmSync(asrFile, { force: true }); } catch (_) { /* file nhỏ, để lại cũng được */ }
      }
      if (later && r.status === 'ok' && r.cues.some(tooLong)) feed.condensed = condenseAfter(out);
      return out;
    });
    job.feed = feed;
  }
  job.waiters++;
  // stream: true (extension từ 0.2.32): trả từng dòng JSON (NDJSON). Mỗi lần có thêm dòng dịch xong: { partial: [dòng…] } (đủ
  // các dòng đã xong tới lúc đó, chưa rút gọn); dòng cuối là kết quả như trả lời thường (có status). Đã gửi header 200 nên
  // lỗi cũng nằm ở dòng cuối ({ status: 'error' }). Kết quả có sẵn trong cache thì trả một lần như trước (đã return ở trên).
  const stream = meta.stream === true;
  const sendFinal = (status, obj) => {
    if (res.writableEnded || res.destroyed) return;
    if (!stream) return send(res, status, obj);
    if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    res.end(JSON.stringify(obj) + '\n');
  };
  let listener = null;
  if (stream) {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
    listener = (cues) => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify({ partial: cues }) + '\n'); };
    feed.listeners.add(listener);
    if (feed.partials) listener(feed.partials);
  }
  res.on('close', () => { if (!res.writableEnded && --job.waiters <= 0) job.cancel(); });
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const where = chunked ? ` [${quick ? 'nhanh ' : ''}${mmss(meta.from)}–${mmss(meta.to)}${lyrics ? ' ♪' : ''}]` : '';
  // Mỗi lần gọi HTTP của bước đó: "đầu" = thời gian tới khi có header trả lời; kết nối mới (kèm thời gian mở) hay dùng lại
  // kết nối sẵn có ("(làm nóng)": kết nối do /v1/warm mở). Ví dụ "ASR 1048 ms [đầu 1010 ms, kết nối mới 180 ms]".
  // Gọi lại, đổi model, lượt rút gọn: cách nhau "; ".
  const netInfo = (calls) => (calls && calls.length ? ' [' + calls.map(c => `đầu ${c.headMs ?? '-'} ms, ` +
    (c.fresh == null ? 'kết nối ?' : c.fresh ? `kết nối mới ${c.connectMs} ms` : `kết nối sẵn${c.byWarm ? ' (làm nóng)' : ''}`)).join('; ') + ']' : '');
  const pronounsIn = normalizePronouns(meta.pronouns)?.pairs.length || 0;
  try {
    const out = withPronouns(await job.promise);
    const t = out.timings || {};
    const why = { no_speech: 'không nghe thấy lời', too_short: 'quá ít lời', filler: 'chỉ có tiếng đệm', not_zh: 'không phải tiếng Trung', singing: 'bài hát', untranslated: 'dịch không ra dòng nào' };
    console.log(`${new Date().toLocaleTimeString()} ${id}${where} ${out.status}${out.label && out.status !== 'ok' ? ' (' + (why[out.label] || out.label) + ')' : ''}` +
      `${out.cues ? ' ' + out.cues.length + ' dòng' : ''}${chunked && meta.from > 0 && out.status === 'ok' && !out.cached ? ` (ngữ cảnh ${out.context || 0} dòng${out.contextFar ? ' ở đoạn xa' : ''}${out.before ? `, lời ngay trước ${out.before} câu` : ''})` : ''} · ${out.seconds ?? '-'} s âm thanh · ${out.sentences ?? 0} câu${!lyrics ? (out.song && out.status === 'ok' ? ', cả đoạn là bài hát: chỉ giữ câu nói' : `, ${out.sung ?? 0} câu hát bị bỏ`) : out.status === 'ok' ? `, ${out.cues.filter(c => c.sung).length} dòng hát được dịch` : ''}` +
      ` · âm thanh ${t.audioMs ?? '-'} ms, ASR ${out.asrCached ? 'dùng lại' : (t.asrMs ?? '-') + ' ms'}${out.asrModel ? ' (' + out.asrModel + ')' : ''}${out.cached ? '' : netInfo(out.debug?.net?.asr)}` +
      `, dịch ${t.mtMs ?? '-'} ms${out.cached ? ' · (cache)' : netInfo(out.debug?.net?.mt)}` +
      // Dòng lượt dịch đầu bỏ trống hay còn chữ Hán: đã dịch lại; dòng vẫn phải bỏ thì in ra (lý do, chữ gốc).
      (out.debug?.mtFix && !out.cached ? ` · dịch lại ${out.debug.mtFix.retried} dòng` + (out.debug.mtFix.ok ? ` (sửa được ${out.debug.mtFix.fixed})` : ' (lượt dịch lại lỗi)') + (out.debug.mtFix.keptHan ? `, ${out.debug.mtFix.keptHan} dòng còn chữ Hán vẫn hiện` : '')
        + out.debug.mtFix.dropped.map(d => `\n    bỏ dòng (${d.why === 'han' ? 'còn chữ Hán' : 'dịch trống'}): ${d.zh}`).join('') : '') +
      (job.startedAt - job.at > 300 ? ` · xếp hàng ${job.startedAt - job.at} ms` : '') +
      (out.heard ? `\n    nghe được: ${out.heard}` : '') +
      // Bảng xưng hô (để đo trên Douyin thật xem cặp có giữ qua các đoạn không): số cặp nhận từ extension và lấy từ file
      // cache đoạn trước, bảng trả về, cặp model vừa sửa so với bảng nó nhận.
      (out.pronouns && !out.cached ? `\n    xưng hô${pronounsIn || out.debug?.pronounsCtx ? ` (nhận ${pronounsIn} cặp${out.debug?.pronounsCtx ? `, từ cache đoạn trước ${out.debug.pronounsCtx} cặp` : ''})` : ''}: ${out.pronouns.pairs.map(p => `${p.who}: ${p.self}/${p.other}`).join('; ')}` +
        pronounChanges(out.debug?.pronounsIn, out.pronouns).map(c => `\n    xưng hô SỬA: ${c}`).join('') : ''));
    const { debug: _d, ...reply } = out;
    // Rút gọn sau: gửi dòng kết quả, giữ kết nối tới khi có bản rút gọn (extension đã nhận kết quả, không chờ dòng này).
    if (stream && meta.condenseLater === true && feed.condensed && !out.cached && !res.writableEnded && !res.destroyed) {
      res.write(JSON.stringify(reply) + '\n');
      const cues = await feed.condensed.catch(() => null);
      if (!res.writableEnded && !res.destroyed) res.end(cues ? JSON.stringify({ condensed: cues }) + '\n' : '');
      return;
    }
    sendFinal(200, reply);
  } catch (e) {
    if (e.cancelled) {
      const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
      console.log(`${new Date().toLocaleTimeString()} ${id}${where} huỷ (đã tua đi chỗ khác${job.started ? ', dừng giữa chừng' : ', chưa xử lý'})` +
        (job.started ? ` · xếp hàng ${sec(job.startedAt - job.at)}, chạy ${sec(Date.now() - job.startedAt)}` : ` · xếp hàng ${sec(Date.now() - job.at)}`));
      sendFinal(200, { id, status: 'cancelled' });
      return;
    }
    console.log(`${new Date().toLocaleTimeString()} ${id}${chunked ? ` [${meta.from}–${meta.to} s]` : ''} LỖI ${e.message}`);
    sendFinal(502, { id, status: 'error', error: String(e.message).slice(0, 300), ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}) });
  } finally {
    if (listener) feed.listeners.delete(listener);
  }
}

// Extension vừa mở video chưa có sub ở chỗ đang xem: trả lời ngay rồi mở sẵn kết nối tới dịch vụ ASR, dịch
// (warmProviders ở pipeline.mjs). Body bỏ qua.
async function handleWarm(req, res) {
  req.resume();
  res.writeHead(204);
  res.end();
  warmProviders();
}

// Người xem vừa lướt tới video đã được gửi dịch sẵn (lúc đó chưa gấp): đoạn còn xếp hàng thì đẩy lên đầu.
async function handleBump(req, res) {
  let meta;
  try { meta = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return send(res, 400, { error: 'bad_body: ' + e.message }); }
  const id = String(meta.id || '');
  if (!/^\d{6,25}$/.test(id) || !(typeof meta.from === 'number' && typeof meta.to === 'number')) return send(res, 400, { error: 'need id, from, to' });
  // Lần bump không mang cờ lyrics: thử cả khoá của chế độ lời bài hát (.vi.lyr., mặc định) lẫn chế độ thường. Trước đây
  // chỉ tìm .vi. nên ở chế độ mặc định không bao giờ thấy việc nào để đẩy lên.
  const jobs = ['vi.lyr', 'vi'].map(mt => inflight.get(path.join(CACHE, `${id}.${meta.from}-${meta.to}.${mt}.${PIPELINE_VERSION}.json`))).filter(Boolean);
  const waiting = jobs.filter(job => !job.started);
  for (const job of waiting) { job.urgent = true; job.rank = 0; job.seq = ++seq; }
  if (waiting.length) pumpQueue();
  send(res, 200, { ok: true, found: jobs.length > 0, queued: waiting.length > 0 });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, version: PIPELINE_VERSION, ...config(), running, queued: queue.length });
  const handler = req.method === 'POST' && { '/v1/subtitles': handleSubtitles, '/v1/bump': handleBump, '/v1/warm': handleWarm }[url.pathname];
  if (!handler) return send(res, 404, { error: 'not_found' });
  if (rejectForeign(req, res)) return;
  // Lỗi không lường trước trong một request (body lạ, đĩa lỗi) chỉ làm hỏng request đó, không làm server thoát.
  handler(req, res).catch((e) => {
    console.log(`${new Date().toLocaleTimeString()} LỖI xử lý ${url.pathname}: ${e.message}`);
    if (!res.headersSent && !res.destroyed) send(res, 500, { status: 'error', error: String(e.message).slice(0, 300) });
  });
});
server.listen(PORT, HOST, () => {
  const c = config();
  console.log(`TranslatorOfDuck Alpha server: http://${HOST}:${PORT}  (ASR: ${c.asr || 'CHƯA CÓ KEY'}${c.asrModels ? ' ' + c.asrModels.join(', dự phòng ') : ''}, dịch: ${c.mt || 'CHƯA CÓ KEY'}, dịch theo từng đoạn 30 s)`);
  // Báo tên biến (không bao giờ in giá trị) để tìm lỗi gõ sai tên trong .env.
  const KNOWN = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE', 'GEMINI_API_KEY', 'GEMINI_MODEL', 'GEMINI_BASE', 'DASHSCOPE_API_KEY',
    'DASHSCOPE_BASE', 'FUNASR_MODEL', 'ASR_FALLBACK_MODEL', 'ASR_QUOTA_RETRY_MS', 'OPENAI_REASONING_EFFORT', 'MAX_PARALLEL', 'FFMPEG',
    'HOST', 'PORT', 'MAX_SECONDS', 'TOD_DUMP', 'TOD_WORK', 'TOD_KEEP_ASR', 'MT_TIMEOUT_MS'];
  const odd = dotEnvInfo.names.filter(n => !KNOWN.includes(n));
  if (odd.length) console.log(`  → .env có biến server không dùng: ${odd.join(', ')}. Tên key đúng: OPENAI_API_KEY, GEMINI_API_KEY, DASHSCOPE_API_KEY.`);
  if (misplacedOpenAIKey) console.log(`  → ${misplacedOpenAIKey} có dạng key OpenAI: đang dùng nó để dịch bằng OpenAI. Nên đổi tên dòng đó thành OPENAI_API_KEY.`);
  if (dotEnvInfo.empty.length) console.log(`  → .env có biến để trống: ${dotEnvInfo.empty.join(', ')}.`);
  if (dotEnvInfo.badLines.length) console.log(`  → .env: dòng ${dotEnvInfo.badLines.join(', ')} không đọc được (cần dạng TÊN=giá trị trên một dòng).`);
  if (!c.mt) console.log('  → Điền OPENAI_API_KEY hoặc GEMINI_API_KEY (và DASHSCOPE_API_KEY nếu có) vào alpha/server/.env rồi chạy lại.');
  checkFfmpeg().then((f) => {
    if (!f.ok) console.log(`  → Không chạy được ffmpeg (${f.bin}: ${f.error}): mọi đoạn sẽ báo lỗi. Chạy npm install trong alpha/server, hoặc cài ffmpeg, hoặc đặt FFMPEG trong .env.`);
  });
});

// Quy trình tạo sub cho một đoạn video: tách âm thanh → nhận dạng giọng nói → lọc nói/hát
// → chia câu và đặt mốc thời gian → dịch → rút gọn dòng quá dài.
// Logic lấy từ bài thử spike/s3/bench.mjs (docs/PLAN.md §6–§7, kết quả ở §6.6b).
import fs from 'node:fs';
import { TARGETS } from './langs.mjs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import dc from 'node:diagnostics_channel';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Chỉ ghi lại TÊN biến và số dòng không đọc được (không bao giờ giá trị) để báo lỗi gõ sai khi khởi động.
export const dotEnvInfo = { names: [], badLines: [], empty: [] };
loadDotEnv(path.join(HERE, '.env'));
const ENV = process.env;
const GEMINI_BASE = ENV.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_MODEL = ENV.GEMINI_MODEL || 'gemini-3.5-flash-lite';
// Dịch: có OPENAI_API_KEY thì dùng OpenAI, không thì Gemini.
const OPENAI_BASE = ENV.OPENAI_BASE || 'https://api.openai.com/v1';
const OPENAI_MODEL = ENV.OPENAI_MODEL || 'gpt-4.1-mini';
// Mức suy luận cho model suy luận (none/minimal/low/…). Dịch phụ đề không cần nghĩ sâu: mức thấp nhanh hơn nhiều.
const OPENAI_REASONING_EFFORT = ENV.OPENAI_REASONING_EFFORT || '';
const DASHSCOPE_BASE = ENV.DASHSCOPE_BASE || 'https://dashscope-intl.aliyuncs.com';
const FUNASR_MODEL = ENV.FUNASR_MODEL || 'fun-asr-flash-2026-06-15';
// Model nhận dạng dự phòng khi Fun-ASR hết hạn mức (31/10, chủ dự án chọn). Cùng API, cùng dạng kết quả có mốc từng chữ:
// gọi thử thật một câu 6,9 s ra 17 từ có mốc, 965 ms; đoạn im lặng báo ASR_RESPONSE_HAVE_NO_WORDS như Fun-ASR. Đặt
// ASR_FALLBACK_MODEL= (rỗng) trong .env để tắt.
const ASR_FALLBACK_MODEL = ENV.ASR_FALLBACK_MODEL ?? 'qwen-audio-3.1-asr-flash';
export const MAX_SECONDS = Number(ENV.MAX_SECONDS || 60);
export const PIPELINE_VERSION = 'alpha-8';

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line)) return;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) { dotEnvInfo.badLines.push(i + 1); return; }
    dotEnvInfo.names.push(m[1]);
    if (!m[2].replace(/^["']|["']$/g, '')) dotEnvInfo.empty.push(m[1]);
    // Biến đã đặt (kể cả rỗng, như test đặt OPENAI_API_KEY='' để không gọi dịch vụ thật) thì giữ nguyên.
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
}
// Key OpenAI dạng "sk-proj-…", "sk-svcacct-…" hoặc dạng cũ "sk-" + 48 ký tự có "T3BlbkFJ" (key DashScope cũng bắt đầu
// bằng "sk-" nhưng chỉ 32 ký tự hex). Dán nhầm vào biến key khác thì vẫn dùng làm key OpenAI.
const looksOpenAI = (v) => /^sk-(proj|svcacct|admin)-/.test(v || '') || /^sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}$/.test(v || '');
export const misplacedOpenAIKey = ['GEMINI_API_KEY', 'DASHSCOPE_API_KEY', 'GROQ_API_KEY'].find(n => looksOpenAI(ENV[n])) || null;
if (!ENV.OPENAI_API_KEY && misplacedOpenAIKey) ENV.OPENAI_API_KEY = ENV[misplacedOpenAIKey];
for (const n of ['GEMINI_API_KEY', 'DASHSCOPE_API_KEY']) if (looksOpenAI(ENV[n])) delete ENV[n];
const mtProvider = () => (ENV.OPENAI_API_KEY ? 'openai' : ENV.GEMINI_API_KEY ? 'gemini' : null);
export function config() {
  const mt = mtProvider();
  // asrModel: model nhận dạng đang dùng (null khi mọi model đều hết hạn mức); asrFallback: đang dùng model dự phòng.
  const dash = !!ENV.DASHSCOPE_API_KEY, asrModel = dash ? asrModelNow() : null;
  return { asr: dash ? 'funasr' : (ENV.GEMINI_API_KEY ? 'gemini' : null),
    ...(dash ? { asrModel, asrModels: asrModels(), ...(asrModel && asrModel !== FUNASR_MODEL ? { asrFallback: true } : {}) } : {}), mt,
    model: mt === 'openai' ? OPENAI_MODEL : GEMINI_MODEL, ...(mt === 'openai' && OPENAI_REASONING_EFFORT ? { effort: OPENAI_REASONING_EFFORT } : {}),
    maxSeconds: MAX_SECONDS };
}

const round = (x, d = 2) => (x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
function pct(arr, p) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = p * (s.length - 1);
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
}
const HAN = /\p{Script=Han}/gu;
// Chữ của lời nói ngoài chữ Hán và chữ Latin: kana (thoại tiếng Nhật trong phim), chữ Hàn.
const SPEECH_LETTER = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const SPEECH_LETTERS = new RegExp(SPEECH_LETTER.source, 'gu');
// Số chữ Hán ngoài ngoặc đơn: bản dịch ghi 'chữ "biện" (辫)' là đúng ý, chữ Hán trong ngoặc chỉ để chú thích.
const hanOut = (t) => (String(t).replace(/[（(][^）)]*[）)]/g, '').match(HAN) || []).length;
const normalize = (t) => Array.from(String(t).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, ''));

// ---------------------------------------------------------------- tách âm thanh
// Thứ tự: biến FFMPEG → gói ffmpeg-static (npm install) → ffmpeg trong PATH.
let ffmpegBin = null;
async function resolveFfmpeg() {
  if (ffmpegBin) return ffmpegBin;
  ffmpegBin = ENV.FFMPEG || null;
  if (!ffmpegBin) {
    try { const m = await import('ffmpeg-static'); if (m.default && fs.existsSync(m.default)) ffmpegBin = m.default; } catch (_) { /* không cài */ }
  }
  if (!ffmpegBin) ffmpegBin = 'ffmpeg';
  return ffmpegBin;
}
// Khi khởi động: báo ngay nếu không chạy được ffmpeg, thay vì để mọi đoạn lỗi lúc đang xem.
export async function checkFfmpeg() {
  const bin = await resolveFfmpeg();
  return new Promise((resolve) => execFile(bin, ['-version'], (err) => resolve(err ? { ok: false, bin, error: err.code || err.message } : { ok: true, bin })));
}
// Âm thanh AAC (ADTS, extension đã cắt sẵn) hoặc đoạn đầu video mp4 (cắt ngắn có chủ đích) → mp3 16 kHz mono.
// Trả null (no_audio, được cache) chỉ khi ffmpeg chạy xong mà không có tiếng. Không chạy được ffmpeg hay ffmpeg lỗi
// mà không tách ra được gì thì báo lỗi: trước đây cả hai thành no_audio và bị cache mãi (đo với FFMPEG=/nonexistent:
// đoạn vẫn "không có âm thanh" sau khi cài lại ffmpeg và chạy lại server).
export async function extractAudio(buf, kind = 'mp4') {
  const bin = await resolveFfmpeg();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-'));
  const src = path.join(dir, kind === 'aac' ? 'in.aac' : 'in.mp4');
  const out = path.join(dir, 'out.mp3');
  fs.writeFileSync(src, buf);
  try {
    // aresample first_pts=0: nếu track âm thanh bắt đầu muộn hơn mốc 0 của video (edit list), chèn khoảng lặng
    // tương ứng; không thì mọi mốc thời gian bị sớm đúng bằng khoảng đó và sub hiện trước lời nói.
    const run = await new Promise((resolve) => execFile(bin, ['-v', 'error', '-y', '-i', src, '-t', String(kind === 'aac' ? 120 : MAX_SECONDS), '-vn', '-ac', '1', '-ar', '16000',
      '-af', 'aresample=async=1:first_pts=0',
      '-c:a', 'libmp3lame', '-b:a', '48k', out], (err, _o, stderr) => resolve({ err, stderr: String(stderr || '') })));
    // Mã lỗi dạng chữ (ENOENT, EACCES): không chạy được ffmpeg.
    if (run.err && typeof run.err.code === 'string') throw new Error(`không chạy được ffmpeg (${bin}): ${run.err.code}`);
    // File cắt ngắn nên ffmpeg hay báo lỗi ở cuối (đo: "partial file", "Input buffer exhausted"): vẫn dùng phần đã tách.
    if (fs.existsSync(out) && fs.statSync(out).size >= 2000) {
      const mp3 = fs.readFileSync(out);
      return { mp3, seconds: round((mp3.length * 8) / 48000, 1) };
    }
    // Video không có track tiếng: ffmpeg 6 báo "Output file does not contain any stream" (bản cũ: "Output file #0 …").
    if (!run.err || /does not contain any stream|matches no streams/i.test(run.stderr)) return null;
    throw new Error('ffmpeg không tách được âm thanh: ' + (run.stderr.trim().split('\n').pop() || 'thoát mã ' + (run.err.code ?? run.err.signal)).slice(0, 200));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- gọi dịch vụ
// Tua nhiều chỗ thì nhiều đoạn gửi dồn một lúc: Gemini trả 429 (vượt hạn mức theo phút), thỉnh thoảng còn lỗi
// mạng. Thử lại sau 2 s, 5 s rồi 15 s (hạn mức tính theo phút) trước khi báo lỗi; rẻ hơn để extension gửi lại cả đoạn.
const RETRY_WAITS = [2000, 5000, 15000];
// signal: server huỷ đoạn đang chạy khi người xem đã tua đi (không còn ai chờ) → dừng cả lệnh gọi và lượt chờ thử lại.
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});
// timeoutMs: mỗi lần gọi có hạn; quá hạn thì gọi lại ngay. Đo trên dữ liệu thật: lần dịch thường 1,5–2 s nhưng có lần 24 s.
// timeoutMs là hàm (lần gọi thứ i, từ 0) thì mỗi lần một hạn. Lượt gọi model dịch dùng hạn tăng dần (mtLimit): đo 2/11 lúc
// OpenAI chậm (~35 token/giây), đoạn 30 s cần 9–12 s; hạn cố định 10 s làm cả 4 lần gọi đều quá hạn (19/54 lượt hỏng sau
// 40 s). Lần đầu vẫn cắt ở 10 s cho kết nối treo, lần gọi lại được 20 s rồi 30 s; quá hạn 3 lần (60 s) thì thôi, lần thứ
// tư hiếm khi cứu được đoạn mà giữ chỗ chạy thêm 30 s. MT_TIMEOUT_MS chỉ để test đặt hạn ngắn (sai dạng thì 10 s).
const mtBase = Math.round(Number(ENV.MT_TIMEOUT_MS));
const MT_TIMEOUT_MS = mtBase > 0 ? mtBase : 10000;
const mtLimit = (ms) => (i) => ms * Math.min(i + 1, 3);
const MT_LIMIT = mtLimit(MT_TIMEOUT_MS);
// Hết hạn mức không tự hồi trong vài giây (Gemini gói miễn phí: quotaId ...PerDay...; OpenAI: insufficient_quota,
// hết tiền trong tài khoản): gọi lại vô ích, chỉ làm video kẹt "đang dịch" mỗi lần 20–60 s. Nhớ lại
// DAY_QUOTA_PAUSE_MS, trong lúc đó báo lỗi ngay, không gọi dịch vụ.
const DAY_QUOTA_PAUSE_MS = 10 * 60 * 1000;
const dayQuotaUntil = new Map();   // dịch vụ → thời điểm thử lại
const serviceOf = (url) => url.startsWith(OPENAI_BASE) ? 'OpenAI' : url.startsWith(GEMINI_BASE) ? 'Gemini'
  : url.startsWith(DASHSCOPE_BASE) ? 'DashScope' : new URL(url).host;
const QUOTA_WHY = { Gemini: 'đã hết lượt gọi trong ngày (gói miễn phí)', OpenAI: 'hết hạn mức hoặc hết tiền trong tài khoản' };
function dayQuotaError(service) {
  const why = service !== 'DashScope' ? QUOTA_WHY[service] || 'hết hạn mức'
    : 'hết hạn mức nhận dạng giọng nói' + (asrModels().length > 1 ? ' (cả model dự phòng)' : '');
  const err = new Error(`${service} ${why}`);
  err.quotaDay = true;
  err.retryAfterMs = Math.max(0, (dayQuotaUntil.get(service) || 0) - Date.now());
  return err;
}
// Key sai hay bị thu hồi, model không có (HTTP 401/403/404): gọi lại vô ích tới khi sửa .env. Lỗi dịch xảy ra SAU khi
// đã trả tiền nhận dạng giọng nói, và extension gửi lại đoạn đó mỗi 20 s (đo bằng dịch vụ giả: dịch báo 401, 3 lần gửi
// = 3 lần ASR). Tạm không gọi dịch vụ đó CONFIG_PAUSE_MS, báo lỗi ngay kèm retryAfterMs như khi hết hạn mức; ngắn hơn
// vì sửa key xong là dùng được (chạy lại server thì hết tạm dừng).
const CONFIG_PAUSE_MS = 2 * 60 * 1000;
const configErrorUntil = new Map();   // dịch vụ → { until, status }
function configError(service) {
  const c = configErrorUntil.get(service) || {};
  const err = new Error(`${service} từ chối key hoặc model (HTTP ${c.status}): kiểm tra alpha/server/.env`);
  err.config = true;
  err.retryAfterMs = Math.max(0, (c.until || 0) - Date.now());
  return err;
}
// Dịch vụ đang tạm dừng (hết hạn mức hoặc key/model sai) thì trả lỗi để báo ngay, không thì null.
function pausedError(service) {
  if ((dayQuotaUntil.get(service) || 0) > Date.now()) return dayQuotaError(service);
  if ((configErrorUntil.get(service)?.until || 0) > Date.now()) return configError(service);
  return null;
}
// Đo từng lần gọi HTTP (chỉ để ghi log, không đổi cách gọi): thời gian tới khi có header trả lời (headMs), có phải mở
// kết nối mới không (fresh) và mất bao lâu từ lúc tạo request tới lúc gửi header (connectMs ≈ DNS + TCP + TLS). fetch của
// Node (undici) giữ kết nối nghỉ trong (thời gian máy chủ gợi ý ở header Keep-Alive − 2 s), hoặc 4 s nếu máy chủ không
// gợi ý (đo trên máy, Node 26.5 / undici 8.7: không gợi ý → nghỉ 3,5 s dùng lại, 4,5 s mở mới; "timeout=5" → 2,8 s dùng
// lại, 3,2 s mở mới), nên lần gọi ASR/dịch đầu của một video thường phải mở kết nối mới. Dùng các kênh
// diagnostics_channel của undici; Node không có các kênh đó thì fresh = null (log ghi "kết nối ?").
const netCtx = new AsyncLocalStorage();   // { calls: [] } của một bước (ASR, dịch); thêm rec trong lúc gọi fetch
const netRec = new WeakMap();             // request của undici → bản ghi lần gọi
const freshSockets = new WeakSet();       // kết nối vừa mở, chưa gửi request nào
const warmSockets = new WeakSet();        // kết nối do lần làm nóng mở, chưa có lệnh gọi thật nào dùng
const onChannel = (name, fn) => (dc.subscribe ? dc.subscribe(name, fn) : dc.channel(name).subscribe(fn));
onChannel('undici:request:create', ({ request }) => {
  const rec = netCtx.getStore()?.rec;
  if (rec) { rec.createdAt = Date.now(); netRec.set(request, rec); }
});
onChannel('undici:client:connected', ({ socket }) => { freshSockets.add(socket); });
onChannel('undici:client:sendHeaders', ({ request, socket }) => {
  const fresh = freshSockets.delete(socket);   // mọi request (cả lần làm nóng) đều đánh dấu kết nối đã dùng
  const rec = netRec.get(request);
  if (!rec) return;
  rec.fresh = fresh;
  if (fresh) rec.connectMs = Date.now() - rec.createdAt;
  // Lệnh gọi thật đầu tiên chạy trên kết nối do làm nóng mở: log ghi "kết nối sẵn (làm nóng)".
  if (rec.warm) { if (fresh) warmSockets.add(socket); } else if (!fresh && warmSockets.delete(socket)) rec.byWarm = true;
});
// Lần gần nhất có lệnh gọi thật tới mỗi origin (lúc bắt đầu và lúc xong): warmProviders bỏ qua origin vừa dùng.
const lastReal = new Map();
// Lượt gọi dạng stream (init.onText, chỉ lượt dịch đầu của OpenAI): hạn của lần gọi tính tới chữ đầu tiên; chữ đã về thì
// chỉ cắt khi im quá STREAM_IDLE_MS (đang trả lời chậm mà đều thì không cắt giữa chừng). Cả chuỗi gọi lại tối đa
// STREAM_MAX_MS tính từ lần gọi đầu, như tổng 10 + 20 + 30 s của lượt không stream (verifier 2/11: tính riêng từng lần
// thì 3 lần quá hạn thành ~180 s). Theo MT_TIMEOUT_MS (10 s: 6 s và 60 s) để test đặt hạn ngắn.
const STREAM_IDLE_MS = Math.round(0.6 * MT_TIMEOUT_MS), STREAM_MAX_MS = 6 * MT_TIMEOUT_MS;
// Đọc trả lời dạng SSE của Chat Completions (stream: true): gọi onText(nội dung đã nhận) mỗi lần có chữ mới, kick() để gia
// hạn. Trả về như trả lời thường ({ choices: [{ message: { content } }] }) để phần còn lại của httpJson, openaiJson không đổi.
async function readSse(res, onText, kick) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', content = '', refusal = '';
  const line = (raw) => {
    const l = raw.trim();
    if (!l.startsWith('data:')) return;
    const data = l.slice(5).trim();
    if (data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch (_) { return; }
    if (ev.error) throw new Error('OpenAI stream: ' + JSON.stringify(ev.error).slice(0, 200));
    const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (d && typeof d.refusal === 'string') refusal += d.refusal;
    if (d && typeof d.content === 'string' && d.content) {
      content += d.content;
      kick();
      try { onText(content); } catch (_) { /* lỗi ở phía nhận không làm hỏng lượt gọi */ }
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buf += done ? dec.decode() : dec.decode(value, { stream: true });
      for (let nl; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) line(buf.slice(0, nl));
      if (done) { line(buf); break; }   // sự kiện cuối không có xuống dòng
    }
  } catch (e) {
    reader.cancel().catch(() => {});   // bỏ dở: đóng thân trả lời, không giữ kết nối
    throw e;
  }
  return JSON.stringify({ choices: [{ message: { content, ...(refusal ? { refusal } : {}) } }] });
}
async function httpJson(url, init, timeoutMs = 20000) {
  const host = new URL(url).host;
  const origin = new URL(url).origin;
  const service = serviceOf(url);
  const paused = pausedError(service);
  if (paused) throw paused;
  const chainEnd = init.onText ? Date.now() + STREAM_MAX_MS : Infinity;   // lượt stream: hạn chung cả chuỗi gọi lại
  for (let i = 0; ; i++) {
    let res, text;
    const calls = netCtx.getStore()?.calls;
    const rec = { headMs: null, fresh: null };
    calls?.push(rec);
    const limitMs = typeof timeoutMs === 'function' ? timeoutMs(i) : timeoutMs;
    const { onText, ...fetchInit } = init;
    const ctl = new AbortController();
    let cut = 'first';   // hạn nào cắt: chưa có chữ đầu (first), im giữa chừng (idle), hết hạn chung (max)
    const timeout = (why) => () => { cut = why; ctl.abort(new DOMException('quá hạn', 'TimeoutError')); };
    let timer = setTimeout(timeout('first'), limitMs);
    // Hạn chung chỉ chạy từ chữ đầu tiên: trước đó hạn của lần gọi (10/20/30 s, tối đa 3 lần) đã giới hạn tổng như cũ.
    let whole = null;
    const kick = () => {
      clearTimeout(timer); timer = setTimeout(timeout('idle'), STREAM_IDLE_MS);
      if (!whole) whole = setTimeout(timeout('max'), Math.max(0, chainEnd - Date.now()));
    };
    try {
      const limit = ctl.signal;
      const t0 = Date.now();
      lastReal.set(origin, t0);
      try {
        res = await netCtx.run({ calls, rec }, () => fetch(url, { ...fetchInit, signal: fetchInit.signal ? AbortSignal.any([fetchInit.signal, limit]) : limit }));
        rec.headMs = Date.now() - t0;
        text = onText && res.ok && /event-stream/.test(res.headers.get('content-type') || '') ? await readSse(res, onText, kick) : await res.text();
      } finally { clearTimeout(timer); clearTimeout(whole); lastReal.set(origin, Date.now()); }
    } catch (e) {
      if (init.signal?.aborted) throw e;
      const timedOut = e.name === 'TimeoutError';
      // Hạn tăng dần (lượt dịch): quá hạn lần thứ 3 thì thôi (xem mtLimit). Lượt stream: hết hạn chung thì thôi.
      const retry = i < RETRY_WAITS.length && !(timedOut && typeof timeoutMs === 'function' && i >= 2) && Date.now() < chainEnd - 100;
      const what = cut === 'idle' ? `im quá ${STREAM_IDLE_MS / 1000} s giữa chừng` : cut === 'max' ? `quá ${STREAM_MAX_MS / 1000} s cả lượt` : `quá ${limitMs / 1000} s chưa trả lời`;
      if (timedOut) console.log(`    · ${new URL(url).host} ${what}: ${retry ? 'gọi lại' : 'thôi, báo lỗi'}`);
      if (retry) { if (!timedOut) await sleep(RETRY_WAITS[i], init.signal); continue; }
      throw e;
    }
    let body = null;
    try { body = JSON.parse(text); } catch (_) { /* giữ text */ }
    if (!res.ok) {
      // DashScope tính hạn mức riêng cho từng model và không tự chuyển model khác. Hết hạn mức thật (modelQuota): báo riêng,
      // không tạm dừng cả DashScope như key sai, để funasr() đổi sang model dự phòng.
      const code = body && typeof body.code === 'string' ? body.code : '';
      if (service === 'DashScope' && modelQuota(code, body && body.message)) {
        const err = new Error(`DashScope ${code}: ${String(body.message || '').slice(0, 160)}`);
        err.modelQuota = code;
        throw err;
      }
      if ((res.status === 429 || res.status >= 500) && i < RETRY_WAITS.length) {
        // Gemini ghi loại hạn mức (quotaId) và thời gian nên chờ (retryDelay) trong lỗi 429: ghi log, chờ đúng chừng đó.
        const details = (body && body.error && body.error.details) || [];
        const quota = details.flatMap(d => d.violations || []).map(v => v.quotaId).filter(Boolean)[0]
          || (body && body.error && body.error.code === 'insufficient_quota' ? 'insufficient_quota' : null);
        if (res.status === 429 && /PerDay|insufficient_quota/i.test(quota || '')) {
          dayQuotaUntil.set(service, Date.now() + DAY_QUOTA_PAUSE_MS);
          console.log(`    · ${host} báo 429 (${quota}): hết hạn mức, tạm không gọi ${service} ${DAY_QUOTA_PAUSE_MS / 60000} phút`);
          throw dayQuotaError(service);
        }
        // OpenAI ghi thời gian nên chờ ở header retry-after-ms / retry-after.
        const hint = Number((/^([\d.]+)s$/.exec((details.find(d => d.retryDelay) || {}).retryDelay || '') || [])[1]) * 1000
          || Number(res.headers.get('retry-after-ms')) || Number(res.headers.get('retry-after')) * 1000 || 0;
        const wait = Math.min(Math.max(RETRY_WAITS[i], hint), 20000);
        if (res.status === 429) console.log(`    · ${new URL(url).host} báo 429${quota ? ' (' + quota + ')' : ''}: thử lại sau ${Math.round(wait / 1000)} s`);
        await sleep(wait, init.signal);
        continue;
      }
      if ([401, 403, 404].includes(res.status)) {
        configErrorUntil.set(service, { until: Date.now() + CONFIG_PAUSE_MS, status: res.status });
        console.log(`    · ${host} báo HTTP ${res.status}: ${text.slice(0, 200)} → key hoặc model sai, tạm không gọi ${service} ${CONFIG_PAUSE_MS / 60000} phút`);
        throw configError(service);
      }
      // Giới hạn theo phút (429 Throttling.AllocationQuota) vẫn còn sau các lần gọi lại: cho model đó nghỉ ngắn để funasr()
      // dùng model dự phòng, thay vì đoạn nào cũng chờ 22 s rồi lỗi (đợt soát 31/10).
      if (service === 'DashScope' && code === 'Throttling.AllocationQuota') {
        const err = new Error(`DashScope ${code} sau ${RETRY_WAITS.length} lần gọi lại: ${String(body.message || '').slice(0, 160)}`);
        err.modelQuota = code;
        err.cooldownMs = ASR_THROTTLE_MS;
        throw err;
      }
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return body;
  }
}
// Hết hạn mức thật của một model: hết hạn mức miễn phí khi bật "chỉ dùng miễn phí" (403 AllocationQuota.FreeTierOnly),
// tài khoản hết tiền (400 Arrearage), hay 429 Throttling.AllocationQuota kèm câu "Free allocated quota exceeded". Không kèm
// câu đó thì là giới hạn theo phút: gọi lại như mọi 429 (đợt soát 31/10: coi là hết hạn mức thì gặp một lần ở cả hai
// model là mất nhận dạng 30 phút, bản trước chỉ chờ ~2 s).
const modelQuota = (code, message) => /^(AllocationQuota\.FreeTierOnly|Arrearage)$/.test(code)
  || (code === 'Throttling.AllocationQuota' && /free/i.test(String(message || '')));
// Model nhận dạng hết hạn mức → thời điểm thử lại. Hạn mức miễn phí không tự hồi (chỉ khi nạp tiền, tắt "chỉ dùng miễn
// phí"), nên 30 phút mới thử lại model chính một lần; lần thử hỏng trả lời ngay, không tốn tiền. Chạy lại server thì thử
// ngay. ASR_QUOTA_RETRY_MS chỉ để test rút ngắn.
const ASR_QUOTA_RETRY_MS = Number(ENV.ASR_QUOTA_RETRY_MS) > 0 ? Number(ENV.ASR_QUOTA_RETRY_MS) : 30 * 60 * 1000;
const ASR_THROTTLE_MS = Math.min(3 * 60 * 1000, ASR_QUOTA_RETRY_MS);   // giới hạn theo phút vẫn còn sau các lần gọi lại
let fallbackRejected = null;     // { until, message }: model dự phòng bị từ chối, trong lúc DashScope tạm dừng vì lỗi đó
const asrQuotaUntil = new Map();
const asrModels = () => [FUNASR_MODEL, ASR_FALLBACK_MODEL].filter((m, i, a) => m && a.indexOf(m) === i);
const asrModelNow = () => asrModels().find(m => (asrQuotaUntil.get(m) || 0) <= Date.now()) || null;
async function funasr(mp3, signal) {
  // Mỗi model thử tối đa một lần. Tìm lại sau mỗi lần hỏng: model chính có thể vừa hết lượt chờ trong lúc model dự phòng
  // đang chạy (đợt soát 31/10: trước đây đoạn đó báo lỗi dù Fun-ASR đã dùng lại được).
  const tried = new Set();
  for (let model; (model = asrModels().find(m => !tried.has(m) && (asrQuotaUntil.get(m) || 0) <= Date.now())); ) {
    tried.add(model);
    try { return await funasrModel(model, mp3, signal); } catch (e) {
      if (e.config) {
        // Model dự phòng bị từ chối (chưa bật trong Model Studio, key không có quyền): nói rõ, không chỉ "kiểm tra .env". Lỗi
        // đó tạm dừng cả DashScope 2 phút; trong lúc đó câu lỗi vẫn nói vậy, kể cả khi tới lượt thử lại Fun-ASR.
        if (model !== FUNASR_MODEL) fallbackRejected = { until: Date.now() + (e.retryAfterMs || 0), message: `${FUNASR_MODEL} hết hạn mức, model dự phòng ${model} bị từ chối: ${e.message}` };
        if (fallbackRejected && fallbackRejected.until > Date.now()) throw Object.assign(new Error(fallbackRejected.message), { config: true, retryAfterMs: e.retryAfterMs });
        throw e;
      }
      if (!e.modelQuota) throw e;
      const known = (asrQuotaUntil.get(model) || 0) > Date.now();   // việc chạy song song đã ghi trước
      asrQuotaUntil.set(model, Date.now() + (e.cooldownMs || ASR_QUOTA_RETRY_MS));
      const next = asrModelNow();
      const why = e.cooldownMs ? `bị giới hạn theo phút (${e.modelQuota}), nghỉ ${Math.round(e.cooldownMs / 60000)} phút` : `hết hạn mức (${e.modelQuota})`;
      if (!known) console.log(`    · ${model} ${why}${next ? ': chuyển sang ' + next : ': không còn model nhận dạng nào'}`);
    }
  }
  // Mọi model đều hết hạn mức: tạm dừng nhận dạng tới lúc thử lại model sớm nhất, báo lỗi ngay kèm retryAfterMs.
  dayQuotaUntil.set('DashScope', Math.min(...asrModels().map(m => asrQuotaUntil.get(m) || 0)));
  throw dayQuotaError('DashScope');
}
async function funasrModel(model, mp3, signal) {
  try {
    const b = await httpJson(DASHSCOPE_BASE + '/api/v1/services/aigc/multimodal-generation/generation', {
      method: 'POST',
      signal, headers: { Authorization: 'Bearer ' + ENV.DASHSCOPE_API_KEY, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' },
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/mp3;base64,' + mp3.toString('base64') } }] }] },
        parameters: { format: 'mp3', sample_rate: '16000', language_hints: ['zh'] },
      }),
    });
    const o = b && b.output;
    const out = (o && o.output) || o || {};
    // Trả 200 mà không có câu (dạng khác, ví dụ model kiểu API khác): báo lỗi. Có chữ mà không có câu cũng không dùng được
    // (không có mốc thời gian); chỉ chữ rỗng mới là "không có lời". Coi là "không có lời" thì đoạn đó bị lưu cache là bỏ qua
    // mãi (đợt soát 31/10).
    const hasSentences = typeof out === 'object' && ('sentence' in out || 'sentences' in out);
    if (!hasSentences && !(typeof out.text === 'string' && !out.text.trim())) throw new Error(`${model} trả kết quả lạ: ${JSON.stringify(b).slice(0, 160)}`);
    let sentences = out.sentences || out.sentence || [];
    if (!Array.isArray(sentences)) sentences = [sentences];
    const segments = sentences.filter(Boolean).map(x => ({ start: x.begin_time / 1000, end: x.end_time / 1000, text: x.text || '' }));
    const words = sentences.flatMap(x => (x && x.words) || []).map(w => ({ text: (w.text || '') + (w.punctuation || ''), start: w.begin_time / 1000, end: w.end_time / 1000 }));
    return { provider: 'funasr', model, text: out.text || segments.map(x => x.text).join(''), segments, words };
  } catch (e) {
    if (e.status === 400 && /ASR_RESPONSE_HAVE_NO_WORDS/.test(e.message)) return { provider: 'funasr', model, text: '', segments: [], words: [] };
    throw e;
  }
}
async function geminiJson(parts, schema, temperature = 0, signal, timeoutMs = 10000) {
  const b = await httpJson(`${GEMINI_BASE}/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    signal, headers: { 'x-goog-api-key': ENV.GEMINI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature } }),
  }, timeoutMs);
  const t = b.candidates && b.candidates[0] && b.candidates[0].content && b.candidates[0].content.parts.map(p => p.text || '').join('');
  return JSON.parse(t || '{}');
}
// Gọi model dịch (OpenAI hoặc Gemini), trả JSON theo schema (viết kiểu Gemini, đổi sang JSON Schema cho OpenAI).
const toJsonSchema = (x) => {
  if (!x || typeof x !== 'object') return x;
  const { propertyOrdering: _o, ...rest } = x;   // chỉ Gemini dùng; OpenAI strict không cần
  const out = { ...rest, type: String(x.type).toLowerCase() };
  if (x.properties) out.properties = Object.fromEntries(Object.entries(x.properties).map(([k, v]) => [k, toJsonSchema(v)]));
  if (x.items) out.items = toJsonSchema(x.items);
  if (out.type === 'object') out.additionalProperties = false;
  return out;
};
// onText (nếu có): gọi dạng stream, onText(nội dung JSON đã nhận tới lúc đó) mỗi lần có chữ mới.
async function openaiJson(text, schema, temperature, signal, timeoutMs = 10000, onText = null) {
  if (!onText) return openaiCall(text, schema, temperature, signal, timeoutMs, null);
  // Dịch vụ cùng kiểu API (OPENAI_BASE) không nhận stream: true (HTTP 400): gọi lại không stream.
  try { return await openaiCall(text, schema, temperature, signal, timeoutMs, onText); } catch (e) {
    if (e.status === 400) return openaiCall(text, schema, temperature, signal, timeoutMs, null);
    throw e;
  }
}
async function openaiCall(text, schema, temperature, signal, timeoutMs, onText) {
  const reasoning = OPENAI_REASONING_EFFORT || /^(o\d|gpt-([5-9]|\d\d))/.test(OPENAI_MODEL);   // model suy luận không nhận temperature
  const b = await httpJson(`${OPENAI_BASE}/chat/completions`, {
    method: 'POST', ...(onText ? { onText } : {}),
    signal, headers: { Authorization: 'Bearer ' + ENV.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: 'user', content: text }], ...(reasoning ? {} : { temperature }), ...(onText ? { stream: true } : {}),
      ...(OPENAI_REASONING_EFFORT ? { reasoning_effort: OPENAI_REASONING_EFFORT } : {}),
      response_format: { type: 'json_schema', json_schema: { name: 'subtitles', strict: true, schema: toJsonSchema(schema) } } }),
  }, timeoutMs);
  const m = b.choices && b.choices[0] && b.choices[0].message;
  if (m && m.refusal) throw new Error('OpenAI từ chối: ' + String(m.refusal).slice(0, 100));
  return JSON.parse((m && m.content) || '{}');
}
// Lượt gọi model dịch: hạn tăng dần (MT_LIMIT). httpJson nhận hạn là số (cố định) hay hàm (theo lần gọi).
// onText: chỉ OpenAI (stream); Gemini trả một lần như trước.
const mtJson = (text, schema, temperature, signal, onText = null) =>
  (mtProvider() === 'openai' ? openaiJson(text, schema, temperature, signal, MT_LIMIT, onText) : geminiJson([{ text }], schema, temperature, signal, MT_LIMIT));
const mtService = () => (mtProvider() === 'openai' ? 'OpenAI' : 'Gemini');
async function geminiAsr(mp3, signal) {
  const schema = { type: 'OBJECT', properties: { segments: { type: 'ARRAY', items: { type: 'OBJECT', properties: {
    start: { type: 'NUMBER' }, end: { type: 'NUMBER' }, text: { type: 'STRING' } }, required: ['start', 'end', 'text'] } } }, required: ['segments'] };
  const r = await geminiJson([
    { text: 'Chép lại nguyên văn lời nói tiếng Trung trong đoạn âm thanh bằng chữ Hán giản thể, có dấu câu. Chia theo câu; mỗi câu có start và end tính bằng giây. Bỏ qua nhạc và lời bài hát. Không có lời nói thì trả về segments rỗng.' },
    { inlineData: { mimeType: 'audio/mp3', data: mp3.toString('base64') } },
  ], schema, 0, signal, 30000);   // nhận dạng cả đoạn âm thanh: lâu hơn dịch
  const segments = (r.segments || []).map(x => ({ start: Number(x.start), end: Number(x.end), text: String(x.text || '') }));
  return { provider: 'gemini', text: segments.map(x => x.text).join(''), segments, words: [] };
}
// ---------------------------------------------------------------- làm nóng kết nối
// Extension báo vừa mở video chưa có sub (POST /v1/warm): mở sẵn kết nối tới đúng các dịch vụ đang dùng, để lần gọi ASR,
// dịch đầu tiên của video không phải trả thêm DNS + TCP + TLS. Extension còn tải âm thanh ~0,5–1,5 s trước khi gửi, đủ
// để kết nối mở xong. Mỗi origin một request GET / không key, không body, hạn 3 s, bỏ qua mọi lỗi và mã trả về; không
// qua httpJson nên không bao giờ tính vào hạn mức hay tạm dừng. Không dùng HEAD: undici luôn đóng kết nối sau một request
// HEAD (đo trên máy, Node 26: HEAD rồi POST → POST mở kết nối mới; GET hay OPTIONS rồi POST → dùng lại).
// Mỗi origin tối đa một lần mỗi 3 s; bỏ qua origin vừa có lệnh gọi thật trong 3 s (thường kết nối đó còn mở; máy chủ
// gợi ý Keep-Alive ngắn hơn 5 s thì có thể đã đóng: dòng log làm nóng ghi header keep-alive để đo trên dịch vụ thật).
// Mỗi lần làm nóng ghi một dòng log: origin, mã trả về, thời gian tới header, kết nối mới hay sẵn, header keep-alive.
const WARM_GAP_MS = 3000;
const lastWarm = new Map();
async function drainSmall(res) {
  // Đọc hết body nhỏ để kết nối trở về hàng chờ dùng lại; body lớn bất thường thì thôi không đọc nữa.
  const reader = res.body?.getReader();
  for (let size = 0; reader;) {
    const { done, value } = await reader.read();
    if (done) return;
    if ((size += value.length) > 64 * 1024) return reader.cancel();
  }
}
export function warmProviders() {
  const mt = mtProvider();
  // Chưa có key dịch, hay dịch đang tạm dừng: makeSubtitles báo lỗi trước cả bước ASR, làm nóng vô ích.
  if (!mt || pausedError(mtService())) return [];
  // Dịch vụ nhận dạng của transcribe(): có key DashScope thì chỉ Fun-ASR (không chuyển sang Gemini), không thì Gemini.
  // Không có, hay đang tạm dừng (hết hạn mức mọi model, key sai): đoạn của video mới hỏng ở bước ASR, dịch không được
  // gọi tới, nên cũng không làm nóng gì.
  let asrBase = null;
  if (ENV.DASHSCOPE_API_KEY) { if (!pausedError('DashScope') && asrModelNow()) asrBase = DASHSCOPE_BASE; }
  else if (ENV.GEMINI_API_KEY && !pausedError('Gemini')) asrBase = GEMINI_BASE;
  if (!asrBase) return [];
  const bases = [mt === 'openai' ? OPENAI_BASE : GEMINI_BASE, asrBase];
  const now = Date.now();
  const warmed = [];
  for (const origin of new Set(bases.map(b => new URL(b).origin))) {
    if (now - (lastWarm.get(origin) ?? -Infinity) < WARM_GAP_MS || now - (lastReal.get(origin) ?? -Infinity) < WARM_GAP_MS) continue;
    lastWarm.set(origin, now);
    warmed.push(origin);
    const rec = { warm: true, headMs: null, fresh: null };
    const host = new URL(origin).host;
    netCtx.run({ rec }, () => fetch(origin + '/', { redirect: 'manual', signal: AbortSignal.timeout(3000) }))
      .then((res) => {
        rec.headMs = Date.now() - now;
        console.log(`${new Date().toLocaleTimeString()} làm nóng ${host}: HTTP ${res.status}, đầu ${rec.headMs} ms, ` +
          (rec.fresh == null ? 'kết nối ?' : rec.fresh ? `kết nối mới ${rec.connectMs} ms` : 'kết nối sẵn') +
          `, keep-alive: ${res.headers.get('keep-alive') || 'không có'}`);
        return drainSmall(res);
      })
      .catch((e) => console.log(`${new Date().toLocaleTimeString()} làm nóng ${host}: hỏng (${e.name === 'TimeoutError' ? 'quá 3 s' : e.message})`));
  }
  return warmed;
}

export async function transcribe(mp3, signal) {
  if (ENV.DASHSCOPE_API_KEY) return funasr(mp3, signal);
  if (ENV.GEMINI_API_KEY) return geminiAsr(mp3, signal);
  throw new Error('Chưa có key: đặt DASHSCOPE_API_KEY (Fun-ASR) hoặc GEMINI_API_KEY trong alpha/server/.env');
}

// Fun-ASR có khi trả cả đoạn âm thanh thành một "câu" (Douyin thật: 37 s lời nói liên tục, 1 câu), khiến
// windowAsr bỏ cả đoạn và lọc hát theo câu thành lọc cả đoạn. Chia lại câu từ danh sách từ: hết câu ở dấu
// 。！？…, ở khoảng lặng ≥ 0,8 s, ở dấu phẩy khi câu đã dài ≥ 6 s; dài quá 12 s thì cắt cứng.
export function resplitSentences(r) {
  const words = (r.words || []).filter(w => w.text && w.end > w.start);
  if (!words.length) return r;
  const segments = [];
  let cur = [];
  const flush = () => {
    if (cur.length) segments.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map(w => w.text).join('') });
    cur = [];
  };
  for (const w of words) {
    if (cur.length && (w.start - cur[cur.length - 1].end >= 0.8 || w.end - cur[0].start > 12)) flush();
    cur.push(w);
    if (/[。！？；…!?;]$/.test(w.text) || (/[，、,：:]$/.test(w.text) && w.end - cur[0].start >= 6)) flush();
  }
  flush();
  return { ...r, segments, words, text: segments.map(x => x.text).join('') };
}

// ---------------------------------------------------------------- nói hay hát (§7.2, §15: chỉ dịch lời nói)
const MUSIC_TAGS = /(翻唱|对口型|手势舞|音乐|歌|唱|舞|mv|cover|bgm|卡点|伴奏|旋律|前奏|dj)/i;
// Lời lặp kiểu điệp khúc: một cụm 2–8 chữ Hán lặp liền nhau `times` lần. Bỏ số và chữ Latin trước ("25000"
// có "000" không phải lời lặp), gộp một chữ lặp liền nhau ("哈哈哈", "对对对" là lời nói).
const repeated = (t, times) => new RegExp(`(.{2,8})\\1{${times - 1},}`, 'u')
  .test(normalize(t).filter(c => /\p{Script=Han}/u.test(c)).join('').replace(/(.)\1+/gu, '$1'));
// Lặp lời mà chữ ngắn như nói (≤ 0,25 s/chữ) là nói nhấn mạnh ("投降了，投降了，投降了", "完了完了完了"), không phải hát.
// Không có mốc từng chữ (Gemini) thì vẫn coi lặp lời là hát.
const slowChars = (med) => med == null || med > 0.25;
export function classifySpeech(meta, r) {
  const text = (r && r.text) || '';
  const han = (text.match(HAN) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const other = (text.match(SPEECH_LETTERS) || []).length;
  const words = (r && r.words) || [];
  const perChar = [];
  for (const w of words) {
    const n = (w.text.match(HAN) || []).length;
    if (n && w.end > w.start) for (let i = 0; i < n; i++) perChar.push((w.end - w.start) / n);
  }
  const span = words.length ? words[words.length - 1].end - words[0].start : 0;
  const f = {
    // Kana, chữ Hàn tính cùng chữ Hán: câu tiếng Nhật ngắn có một từ tiếng Anh ("OKだ、行くぞ。") không phải lời tiếng Anh.
    han, latinShare: han + other + latin ? round(latin / (han + other + latin), 2) : 0, medCharDur: round(pct(perChar, 0.5), 3),
    cps: span > 0 ? round(han / span, 1) : null,
    tagMusic: MUSIC_TAGS.test((meta.desc || '') + ' ' + (meta.hashtags || []).join(' ')),
    repeat: repeated(text, 4),
  };
  // Không còn nhãn "quá ít lời" (dưới 4 chữ Hán thì bỏ cả đoạn): lời ngắn có thể là lời quan trọng (đo 3/11 trên Douyin
  // thật: thoại tiếng Nhật 断る。帰れ。てめえ死にてえのか。 có 3 chữ Hán, mất cả ba câu). Không có lời chỉ khi không có chữ nào
  // (Hán, kana, Hàn, Latin): trước đây câu toàn kana cũng bị coi là không có lời.
  let label;
  if (!f.han && f.latinShare === 0 && !SPEECH_LETTER.test(text)) label = 'no_speech';
  else if (f.latinShare > 0.5) label = 'not_zh';
  else if (f.repeat && slowChars(f.medCharDur)) label = 'singing';
  else {
    const score = (f.medCharDur != null && f.medCharDur > 0.33 ? 2 : 0) + (f.tagMusic ? 1 : 0) + (f.cps != null && f.cps < 2.5 ? 1 : 0);
    label = score >= 2 ? 'singing' : 'speech';
  }
  return { label, ...f };
}

// Lọc theo từng câu: video nói có nhạc nền hay đoạn hát ngắn thì chỉ bỏ những câu hát, không bỏ cả video.
// Câu "hát" khi chữ kéo dài (trung vị > 0,33 s/chữ, cùng ngưỡng với cả video) hoặc lặp đi lặp lại.
export function splitSung(r) {
  const words = (r.words || []).filter(w => w.end > w.start);
  const segs = r.segments || [];
  if (!words.length || !segs.length) return { r, sentences: segs.map(x => ({ start: x.start, end: x.end, text: x.text, sung: false })), sung: 0, total: segs.length };
  const sentences = segs.map((x) => {
    const ws = words.filter(w => w.start >= x.start - 0.05 && w.end <= x.end + 0.05);
    const perChar = [];
    for (const w of ws) { const n = (w.text.match(HAN) || []).length; for (let i = 0; i < n; i++) perChar.push((w.end - w.start) / n); }
    const med = pct(perChar, 0.5);
    const sung = (perChar.length >= 4 && med > 0.33) || (repeated(x.text, 3) && slowChars(med));
    return { start: x.start, end: x.end, text: x.text, medCharDur: round(med, 3), sung, words: ws };
  });
  const kept = sentences.filter(x => !x.sung);
  const keptWords = new Set(kept.flatMap(x => x.words));
  return {
    r: { ...r, segments: kept.map(x => ({ start: x.start, end: x.end, text: x.text })), words: words.filter(w => keptWords.has(w)), text: kept.map(x => x.text).join('') },
    sentences: sentences.map(({ words: _w, ...x }) => x), sung: sentences.length - kept.length, total: sentences.length,
  };
}

// Đoạn của video dài: đổi mốc về thời gian video (cộng thời điểm bắt đầu của đoạn âm thanh) và chỉ giữ
// những câu BẮT ĐẦU trong [from, to). Âm thanh gửi lên dư vài giây hai đầu nên câu vắt qua ranh giới
// vẫn đủ chữ ở đoạn chứa điểm bắt đầu của nó, và không bị lặp ở đoạn sau.
// keepCrossing: giữ cả câu bắt đầu trước from mà còn nói sang đoạn này (đủ trong phần âm thanh gửi dư). Dùng khi
// đoạn trước chưa dịch (vừa tua tới): không thì câu ở ngay chỗ tua tới không bao giờ hiện.
export function windowAsr(r, offset, from, to, keepCrossing = false) {
  const sh = (x) => ({ ...x, start: round(x.start + offset, 3), end: round(x.end + offset, 3) });
  const crossing = (x) => keepCrossing && x.start < from && x.start >= offset + 0.5 && x.end > from + 0.3;
  // Câu bắt đầu trước đoạn mà kéo dài quá 2,5 s vào đoạn: giữ các từ từ đầu đoạn. Đo 3/11 (video BLG): model nhận dạng dự
  // phòng có lúc trả cả đoạn không một dấu câu, câu chia lại thành 5,6–17,6 s mà đoạn trước chỉ có âm thanh tới 12 s: lời
  // 12–17,6 s không thuộc đoạn nào. Luật này cũng chạy khi hai lượt nhận dạng chia câu ở ranh giới khác nhau (verifier, 112
  // đoạn có from > 0 trong cache: 38 đoạn đổi; chữ không có dòng nào 160 → 72, chữ lặp giữa hai dòng liền nhau 11 → 18).
  // Phần trùng với dòng cuối đoạn trước: cues.js giữ dòng kết thúc muộn hơn. Đã thử bắt đầu phần giữ ở dấu phẩy đầu tiên:
  // không bớt chữ mất (lời trước dấu phẩy có lúc đoạn trước không có), thêm chữ lặp (verifier 3/11).
  const tail = (x) => {
    const ws = (r.words || []).map(sh).filter(w => w.start >= from && w.start < to && w.start >= x.start - 0.05 && w.end <= x.end + 0.05);
    return ws.length ? { start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map(w => w.text).join('') } : null;
  };
  const segments = (r.segments || []).map(sh).map(x => ((x.start >= from && x.start < to) || crossing(x) ? x
    : x.start < from && x.end > from + 2.5 ? tail(x) : null)).filter(Boolean);
  const words = (r.words || []).map(sh).filter(w => segments.some(x => w.start >= x.start - 0.05 && w.end <= x.end + 0.05));
  return { ...r, segments, words, text: segments.map(x => x.text).join('') };
}

// Lời nói ngay trước đoạn (trong phần âm thanh gửi dư, kết thúc trước from): đưa cho bước dịch làm mạch câu.
export function speechBefore(r, offset, from, n = 3) {
  return (r.segments || []).map(x => ({ text: x.text, start: x.start + offset, end: x.end + offset }))
    .filter(x => x.start >= offset + 0.5 && x.end <= from + 0.3 && x.text.trim()).slice(-n).map(x => x.text);
}

// Chế độ lời bài hát (31/10: chủ dự án muốn hiểu cả video bài hát; log hôm đó 35/232 video bị bỏ vì là bài hát, trong
// khi phần nhận dạng đã trả tiền rồi). Dòng hát được giữ và đánh dấu sung để extension hiện "♪". Cả đoạn là bài hát thì
// mọi dòng là dòng hát; không thì dòng bắt đầu trong một câu hát (splitSung). Dòng hát chỉ có tiếng đệm (耶耶耶, 啦啦啦)
// thì bỏ: dịch ra chỉ là "yeah yeah". Tiếng đệm ASR ghi bằng chữ Latin ("yeah yeah", "oh", "lalala") thì bỏ ở mọi dòng:
// splitSung chỉ đếm chữ Hán nên dòng chữ Latin không bao giờ được tính là câu hát (đợt soát 31/10).
const FILLER = /^[啊哦呀耶啦嗯哈呜喔哎嘿噢唉哇嘞咯呦哟咿呃诶哒嘀嗒]+$/u;
// Từng từ một (không lồng lượng từ, khỏi quay lui lâu với chuỗi dài): tiếng đệm, hay một tiếng đệm viết liền nhiều lần.
const SOUND = /^(?:o+h*|a+h*|uh+|um+|m{2,}|hm+|huh|ye(?:ah?|h)?|hey|wo+w?|woah|whoa|eh|ay|(?:la)+|(?:na)+|(?:da)+|(?:ha)+|(?:ya)+|(?:yo)+)$/i;
const SOUND_TWICE = /^(yeah|oh|ah|hey|wow|woah|whoa|huh)\1+$/i;
// Tiếng đệm im lặng: đoạn chỉ có các chữ này (hay tiếng đệm chữ Latin) thì bỏ cả đoạn. Tiếng kêu có nghĩa (诶？ ngạc nhiên, 哎呀！
// tiếc, 哇 thán phục) thì vẫn dịch: chủ dự án quyết 4/11 (ROADMAP §6).
export const QUIET_FILLER = /^[嗯啊呃额]+$/u;
export function isFiller(zh, set = FILLER) {
  const s = String(zh).normalize('NFKC');
  const han = normalize(s).filter(ch => /\p{Script=Han}/u.test(ch)).join('');
  const words = s.replace(/\p{Script=Han}/gu, ' ').split(/[\p{P}\p{S}\s]+/u).filter(Boolean);
  return !!(han || words.length) && (!han || set.test(han)) && words.every(w => SOUND.test(w) || SOUND_TWICE.test(w));
}
// Câu nói nhanh trong đoạn cả bài (≥ 3 chữ Hán, trung vị ≤ 0,20 s/chữ): lời chào, câu hỏi người qua đường, tiêu đề đọc
// lên ngay trước hay giữa bài hát, không phải lời hát. Đo trên Douyin thật: lô 1 (13 video) có 4 dòng nói bị ♪ chỉ vì
// luật cả bài, chữ 0,16–0,18 s; lô 2 (22 video mới, ngưỡng định trước khi đo) sửa 4 dòng, không hỏng dòng hát nào.
// Ngưỡng sát: dòng hát nhanh nhất trong đoạn cả bài ở lô 2 là 0,24–0,25 s/chữ, ngưỡng 0,25 làm hỏng cả hai (HANDOFF §6n).
// Tiếng đệm nói nhanh ("哈哈哈哈") không tính: vẫn là dòng hát, rồi bị bỏ như mọi dòng hát chỉ có tiếng đệm.
const SONG_TALK = 0.20;
const talkInSong = (x) => !!x && !x.sung && x.medCharDur != null && x.medCharDur <= SONG_TALK && ((x.text || '').match(HAN) || []).length >= 3 && !isFiller(x.text);
// Dòng là dòng hát khi quá nửa thời gian nói của nó nằm trong câu hát. Trước đây chỉ xét mốc bắt đầu: segmentCues gộp
// một dòng nói rất ngắn ("好。") vào dòng hát ngay sau, dòng gộp bắt đầu trong câu nói nên mất ♪ (đợt soát 31/10).
// Đoạn cả bài thì mọi dòng là dòng hát, trừ dòng có câu của nó (câu trùng thời gian nhiều nhất) là câu nói nhanh.
export function lyricCues(r, cls, split) {
  const wholeSong = cls.label === 'singing';
  const overlap = (c, x) => Math.max(0, Math.min(Math.max(c.se || c.end, c.start + 0.01), x.end) - Math.max(c.start, x.start));
  const sungShare = (c) => split.sentences.reduce((s, x) => s + (x.sung ? overlap(c, x) : 0), 0) / (Math.max(c.se || c.end, c.start + 0.01) - c.start);
  const own = (c) => split.sentences.reduce((best, x) => (!best || overlap(c, x) > overlap(c, best) ? x : best), null);
  const hasHan = (t) => /\p{Script=Han}/u.test(t);
  return segmentCues(r).map(c => ({ ...c, sung: sungShare(c) > 0.5 || (wholeSong && !talkInSong(own(c))) }))
    .filter(c => !((c.sung || !hasHan(c.zh)) && isFiller(c.zh)));
}

// ---------------------------------------------------------------- chia câu, mốc thời gian (§7.3, §7.4)
const FRAME = 1 / 30;
export function segmentCues(r) {
  let words = (r.words || []).filter(w => w.text && w.end > w.start);
  if (!words.length) words = (r.segments || []).map(x => ({ text: x.text, start: x.start, end: x.end }));
  const hanOf = (t) => (t.match(HAN) || []).length;
  const cues = [];
  let cur = [];
  const textOf = (ws) => ws.map(w => w.text).join('');
  const emit = (ws) => { if (ws.length && textOf(ws).trim()) cues.push({ start: ws[0].start, speechEnd: ws[ws.length - 1].end, zh: textOf(ws) }); };
  const cutPoint = (ws) => {
    if (ws.length < 2) return ws.length;   // một từ: trước đây đọc ws[-1] và báo lỗi (verifier 3/11)
    for (let k = ws.length - 2; k >= 1; k--) if (/[，、,：:]$/.test(ws[k].text)) return k + 1;
    let best = -1, gap = -1;
    for (let k = Math.floor(ws.length / 2); k < ws.length; k++) {
      const g = ws[k].start - ws[k - 1].end;
      if (g > gap) { gap = g; best = k; }
    }
    return best > 0 ? best : ws.length;
  };
  for (const w of words) {
    if (cur.length) {
      const gap = w.start - cur[cur.length - 1].end;
      if (gap >= 0.6) { emit(cur); cur = []; }
      else if (w.end - cur[0].start > 7 || hanOf(textOf(cur) + w.text) > 16) {
        const k = cutPoint(cur);
        emit(cur.slice(0, k));
        cur = cur.slice(k);
      }
    }
    cur.push(w);
    const dur = w.end - cur[0].start;
    if (/[。！？；…!?]$/.test(w.text)) { emit(cur); cur = []; }
    else if (/[，、,：:]$/.test(w.text) && (dur >= 3.5 || hanOf(textOf(cur)) >= 12)) { emit(cur); cur = []; }
  }
  emit(cur);
  // Dòng ít chữ mà ASR cho kéo dài rất lâu (một từ そう。 tới hết 25 s âm thanh, verifier 3/11): trước đây đứng trên màn
  // hình cả 25 s. Cắt theo số chữ (~0,8 s mỗi chữ + 1 s, ít nhất 2,5 s), chỉ khi dài quá 7,5 s (độ dài tối đa của dòng
  // chia được) và quá mức đó; câu dài nhiều chữ chỉ có mốc cả câu (Gemini) giữ nguyên. Cắt trước bước gộp dòng ngắn:
  // "爱" + "你。" kéo dài 9 s được gộp lại thành một dòng (verifier 3/11).
  for (const c of cues) {
    const fit = Math.max(2.5, 0.8 * (c.zh.match(/\p{L}/gu) || []).length + 1);
    if (c.speechEnd - c.start > Math.max(7.5, fit)) c.speechEnd = c.start + fit;
  }
  for (let i = 0; i < cues.length - 1; i++) {
    const a = cues[i], b = cues[i + 1];
    if (a.speechEnd - a.start < 0.833 && b.start - a.speechEnd < 0.5 && b.speechEnd - a.start <= 7 && hanOf(a.zh + b.zh) <= 16) {
      b.start = a.start; b.zh = a.zh + b.zh; cues.splice(i, 1); i--;
    }
  }
  cues.forEach((c, i) => {
    const next = cues[i + 1];
    const g = next ? next.start - c.speechEnd : Infinity;
    let end = g < 0.5 ? next.start - 2 * FRAME : g < 1 ? next.start - 0.5 : c.speechEnd + 0.5;
    if (end - c.start < 0.833) end = Math.min(c.start + 0.833, next ? next.start - 2 * FRAME : Infinity);
    c.end = Math.max(end, c.speechEnd);
    c.zh = c.zh.trim();
  });
  return cues.map((c, id) => ({ id, start: round(c.start, 3), end: round(c.end, 3), se: round(c.speechEnd, 3), zh: c.zh }));
}

// ---------------------------------------------------------------- dịch (§7.5)
export function fixViText(t) {
  return String(t || '').replace(/\s+/g, ' ').replace(/\s+([,.!?;:…])/g, '$1').replace(/([,!?;:])(?=[^\s\d"'”)\]])/g, '$1 ').trim();
}
// Bảng nhận từ extension (hay model trả) là dữ liệu ngoài: chỉ giữ đúng dạng { pairs: [{ who, self, other }] }, cắt độ
// dài, tối đa PRONOUN_PAIRS cặp, để câu lệnh không phình. Sai dạng thì coi như không có (null).
const PRONOUN_PAIRS = 6;
const pronounKey = (p) => p.who.toLowerCase().replace(/\s+/g, '');
export function normalizePronouns(x) {
  if (!x || typeof x !== 'object' || !Array.isArray(x.pairs)) return null;
  const str = (v, n) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const pairs = [], seen = new Set();
  for (const p of x.pairs) {
    if (!p || typeof p !== 'object') continue;
    const q = { who: str(p.who, 80), self: str(p.self, 24), other: str(p.other, 24) };
    if (!q.who || !(q.self || q.other) || seen.has(pronounKey(q))) continue;
    seen.add(pronounKey(q));
    pairs.push(q);
    if (pairs.length >= PRONOUN_PAIRS) break;
  }
  return pairs.length ? { pairs } : null;
}
// Bảng trả về = bảng model vừa chốt, thêm các cặp của bảng cũ mà model bỏ sót (đoạn chỉ có lời hát thì model hay chỉ ghi
// cặp của bài hát): extension chỉ giữ bảng mới nhất, không được mất cặp của cảnh trước. Model không trả bảng thì giữ bảng cũ.
export function mergePronouns(fresh, prev) {
  const a = normalizePronouns(fresh), b = normalizePronouns(prev);
  if (!a || !b) return a || b;
  const have = new Set(a.pairs.map(pronounKey));
  return normalizePronouns({ pairs: [...a.pairs, ...b.pairs.filter(p => !have.has(pronounKey(p)))] });
}
// Cặp có trong bảng cũ (cùng who) mà model vừa đổi self/other: server ghi log để đo trên Douyin thật xem cặp chọn sai
// ở đầu video có được sửa ở đoạn sau không (đợt soát 1/11, F4).
export function pronounChanges(prev, next) {
  const a = normalizePronouns(prev), b = normalizePronouns(next);
  if (!a || !b) return [];
  const old = new Map(a.pairs.map(p => [pronounKey(p), p]));
  return b.pairs.filter(p => { const o = old.get(pronounKey(p)); return o && (o.self !== p.self || o.other !== p.other); })
    .map(p => { const o = old.get(pronounKey(p)); return `${p.who}: ${o.self}/${o.other} → ${p.self}/${p.other}`; });
}
// Số ký tự tối đa của một dòng: tốc độ đọc của ngôn ngữ đích (gói ngôn ngữ, langs.mjs) nhân thời lượng, tối đa 84.
const budgetAt = (cps, c) => Math.floor(Math.min(84, cps * (c.end - c.start)));
const budget = (c) => budgetAt(17, c);
// Các object đã đóng trong mảng "cues" của JSON đang nhận dở ({"pronouns":…,"cues":[{"id":1,"vi":"…"},{"id":2,"vi":"…).
export function completedCues(text) {
  const at = text.indexOf('"cues"');
  const open = at < 0 ? -1 : text.indexOf('[', at);
  if (open < 0) return [];
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') { depth--; if (depth === 0 && start >= 0) { try { out.push(JSON.parse(text.slice(start, i + 1))); } catch (_) { /* bỏ object hỏng */ } start = -1; } }
    else if (ch === ']' && depth === 0) break;
  }
  return out;
}
// Dòng tiếng Việt dài hơn 1,1 lần max_chars (17 ký tự/giây, tối đa 84): cần rút gọn.
export const tooLong = (c) => String(c.vi || '').length > 1.1 * budget(c);
// Lượt rút gọn: một lần gọi model cho các dòng `long` ({ start, end, vi, zh, sung? }). Trả Map dòng → bản ngắn hơn, chỉ cho dòng
// được rút gọn thật (ngắn hơn, không thêm chữ Hán). Tuỳ chọn: lỗi thì Map rỗng (giữ bản đầy đủ); chờ tối đa 2 lần hạn đầu, không
// chờ cả chuỗi gọi lại 10-20-30 s trong khi đoạn đã dịch xong. Dùng trong translate (đoạn không gấp) và sau khi trả kết quả
// (đoạn gấp, dịch sẵn: server.mjs, "rút gọn sau").
export async function condenseCues(long, pronouns, signal, target = 'vi') {
  const pack = TARGETS[target] || TARGETS.vi;
  const out = new Map();
  if (!long.length || !pack.condense) return out;   // gói chưa có câu lệnh rút gọn (tiếng Anh)
  try {
    const cs = AbortSignal.any([signal, AbortSignal.timeout(2 * MT_TIMEOUT_MS)].filter(Boolean));
    const r = await mtJson(pack.condense({ pronouns, long, budget }), pack.cueSchema, 0.2, cs);
    const short = new Map((r.cues || []).map(c => [c.id, fixViText(c[pack.key])]));
    long.forEach((c, i) => {
      const v = short.get(i + 1);
      // Dòng đã có ít chữ Hán (dịch lại vẫn giữ): bản rút gọn được giữ chữ đó, không thêm chữ Hán mới.
      if (v && v.length < c.vi.length && hanOut(v) <= hanOut(c.vi) && (v.match(HAN) || []).length <= (c.vi.match(HAN) || []).length) out.set(c, v);
    });
  } catch (_) { /* giữ bản đầy đủ nếu lượt rút gọn lỗi */ }
  return out;
}
// context: dòng đã dịch ngay trước (hoặc ở đoạn đã dịch gần nhất phía trước, far = true). before: lời nói ngay trước
// đoạn (chữ Hán, chưa dịch) khi đoạn trước chưa dịch, ví dụ vừa tua tới.
// condense = false: bỏ lượt rút gọn dòng quá dài (mẩu nhanh: sub ra sớm hơn một lần gọi model).
// Dòng có sung (chế độ lời bài hát) được dịch như lời bài hát.
// meta.pronouns: bảng xưng hô video đã dùng (extension gửi lại); meta.author: người đăng. Trả { cues, pronouns }.
// Không tăng PIPELINE_VERSION: file cache cũ (không có pronouns) vẫn dùng được, chỉ không mang bảng xưng hô.
// onPartial(cues): các dòng đã dịch xong trong lúc model còn đang viết (lượt dịch đầu, OpenAI stream), mỗi lần có thêm dòng;
// cùng dạng dòng như kết quả cuối, chưa rút gọn. Extension hiện tạm, kết quả cuối thay.
export async function translate(meta, cues, context = [], signal, { far = false, before = [], condense = true, onPartial = null, target = 'vi' } = {}) {
  const pack = TARGETS[target] || TARGETS.vi;
  const budget = (c) => budgetAt(pack.cps, c);
  const sung = cues.some(c => c.sung);
  let shown = 0;
  const byId = new Map(cues.map(c => [c.id, c]));
  const onText = onPartial && ((content) => {
    const done = completedCues(content);
    if (done.length <= shown) return;
    shown = done.length;
    const part = done.map(x => ({ c: byId.get(x.id), vi: fixViText(String(x[pack.key] || '')) }))
      .filter(x => x.c && x.vi && !(x.vi.match(HAN) || []).length && !(pack.wrongLang && pack.wrongLang(x.vi)))
      .map(({ c, vi }) => ({ start: c.start, end: c.end, se: c.se, vi, zh: c.zh, ...(c.sung ? { sung: true } : {}) }));
    if (part.length) onPartial(part);
  });
  if (!mtProvider()) throw new Error('Chưa có OPENAI_API_KEY hoặc GEMINI_API_KEY trong alpha/server/.env');
  const known = pack.pronouns ? normalizePronouns(meta.pronouns) : null;   // bảng xưng hô chỉ có ở tiếng Việt
  const author = pack.author(meta.author);
  const first = await mtJson(pack.first({ meta, known, author, context, far, before, sung, cues, budget, round, PRONOUN_PAIRS }), pack.firstSchema, 0.2, signal, onText);
  const pronouns = pack.pronouns ? mergePronouns(first.pronouns, known) : null;
  const vi = new Map((first.cues || []).map(c => [c.id, fixViText(c[pack.key])]));
  const flagsOf = (c, text) => [...(!text ? ['missing'] : []), ...((text.match(HAN) || []).length ? ['han_left'] : []),
    ...(text.length > 1.1 * budget(c) ? ['too_long'] : []), ...(text && pack.wrongLang && pack.wrongLang(text) ? ['wrong_lang'] : [])];
  const out = cues.map(c => { const text = vi.get(c.id) || ''; return { ...c, vi: text, flags: flagsOf(c, text) }; });
  // Dòng bị bỏ trống hay còn chữ Hán: trước đây bỏ cả dòng, mà thường là câu chốt (đo 3/11 trên cache: 18 vế câu mất ở 8
  // video: tên riêng "B站", câu nói về cách viết chữ 辫, câu hỏi "陀螺 nghĩa là gì"). Dịch lại riêng các dòng đó một lần,
  // kèm các dòng xung quanh đã dịch để giữ mạch. Lỗi thì giữ bản đầu. Chờ tối đa 2 lần hạn đầu như lượt rút gọn; đoạn gấp,
  // mẩu nhanh, dịch sẵn (condense = false: đang trễ) chỉ một lần hạn đầu (verifier 3/11: lượt dịch lại lỗi hay treo làm kết
  // quả cuối của đoạn gấp chậm thêm 20 s).
  // Chữ tiếng Việt: chữ Latin, trừ từ chép nguyên từ câu gốc ("MacBook", "BLG") và kana (câu tiếng Nhật bị chép lại).
  const viLetters = (c) => {
    const latin = (t) => t.match(/\p{Script=Latin}+/gu) || [];
    const src = new Set(latin(c.zh).map(w => w.toLowerCase()));
    return latin(c.vi).filter(w => !src.has(w.toLowerCase())).join('').length;
  };
  const mostlyHan = (c) => 2 * (c.vi.match(HAN) || []).length > viLetters(c);
  const keep = (c) => !!c.vi && !mostlyHan(c);
  // Dòng còn ít chữ Hán (câu nói về chính chữ đó, tên chưa phiên được) vẫn hiện: mất cả câu thoại tệ hơn. Chỉ bỏ dòng trống
  // hay gần như toàn chữ Hán (model chép lại câu gốc); file cache ghi lại các dòng bỏ (debug.mtFix), server ghi log.
  // Tiếng Anh: dòng trả về bằng tiếng Việt (wrong_lang) cũng dịch lại; vẫn sai thì vẫn giữ, không bỏ (verifier 4/11, F5).
  const bad = out.filter(c => c.flags.includes('missing') || c.flags.includes('han_left') || c.flags.includes('wrong_lang'));
  let retryOk = false;
  const changed = new Set();
  if (bad.length) {
    try {
      const rs = AbortSignal.any([signal, AbortSignal.timeout((condense && pack.condense ? 2 : 1) * MT_TIMEOUT_MS)].filter(Boolean));
      // Dòng ngay trước, ngay sau mỗi dòng lỗi (3 dòng mỗi phía), và dòng cuối đoạn trước khi dòng lỗi ở đầu đoạn.
      const near = new Set(bad.flatMap(c => { const i = out.indexOf(c); return out.slice(Math.max(0, i - 3), i + 4); }));
      const around = out.filter(c => near.has(c) && !bad.includes(c) && c.vi).map(c => ({ zh: c.zh, vi: c.vi }));
      const prior = !far && bad.some(c => out.indexOf(c) < 3) ? context : [];
      const r = await mtJson(pack.retry({ pronouns, bad, meta, prior, around, budget }), pack.cueSchema, 0.2, rs);
      // Model trả trùng id: lấy bản ít chữ Hán nhất.
      const again = new Map();
      for (const x of r.cues || []) { const v = fixViText(x[pack.key]); const o = again.get(x.id); if (v && (!o || hanOut(v) < hanOut(o))) again.set(x.id, v); }
      retryOk = true;
      for (const c of bad) {
        const v = again.get(c.id);
        // Bản mới phải có chữ và không nhiều chữ Hán hơn bản đầu (không tính chữ trong ngoặc đơn: 'chữ "biện" (辫)' đúng như
        // câu lệnh dặn, hơn 'chữ 辫'); bằng nhau thì lấy bản mới.
        if (!v || (c.vi && hanOut(v) > hanOut(c.vi))) continue;
        // Không đổi một dòng hiện được thành dòng phải bỏ (bản dịch lại chép cả câu Hán vào ngoặc; verifier 3/11).
        if (keep(c) && !keep({ ...c, vi: v })) continue;
        // Không đổi dòng đúng ngôn ngữ thành sai. Dòng đang trống thì nhận cả bản sai ngôn ngữ (gắn wrong_lang, vẫn hiện): mất câu tệ
        // hơn (verifier 4/11, F5).
        if (pack.wrongLang && pack.wrongLang(v) && c.vi && !pack.wrongLang(c.vi)) continue;
        if (v !== c.vi) changed.add(c);
        c.vi = v; c.flags = flagsOf(c, v);
      }
    } catch (_) { /* giữ bản đầu nếu lượt dịch lại lỗi */ }
  }
  if (condense && pack.condense) {
    const short = await condenseCues(out.filter(c => c.flags.includes('too_long')), pronouns, signal, target);
    for (const c of out) if (short.has(c)) { c.vi = short.get(c); c.flags = flagsOf(c, c.vi).concat(['condensed']); }
  }
  const fix = bad.length ? { retried: bad.length, ok: retryOk, fixed: [...changed].filter(keep).length, keptHan: out.filter(c => keep(c) && c.flags.includes('han_left')).length, ...(pack.wrongLang ? { wrongLang: out.filter(c => keep(c) && c.flags.includes('wrong_lang')).length } : {}),
    dropped: out.filter(c => !keep(c)).map(c => ({ zh: c.zh, why: c.vi ? 'han' : 'missing' })) } : null;
  return { cues: out.filter(keep), pronouns, ...(fix ? { fix } : {}) };
}

// ---------------------------------------------------------------- toàn bộ
// Từ kết quả nhận dạng của một đoạn tới các dòng gốc chưa dịch: cắt theo đoạn, nói hay hát, chia dòng, bỏ đoạn chỉ có
// tiếng đệm. Tách khỏi makeSubtitles để alpha/dev/real/replay.mjs chạy lại offline đúng như server, khỏi gọi dịch.
// Trả { asr (đã cắt theo đoạn), before, cls, split, song, cues }, hoặc { ..., skip: nhãn } khi bỏ qua cả đoạn.
export function cuesFromAsr(meta, asr, opts = {}) {
  // Âm thanh gửi dư trước đoạn ≥ 4 s: extension báo đoạn trước chưa dịch (vừa tua tới). Lấy lời nói phần đó làm
  // mạch câu cho bước dịch, và giữ câu vắt qua đầu đoạn.
  const preRoll = opts.from != null && opts.from - (opts.offset || 0) >= 4;
  const before = preRoll ? speechBefore(asr, opts.offset || 0, opts.from) : [];
  if (opts.from != null) asr = windowAsr(asr, opts.offset || 0, opts.from, opts.to, preRoll);
  const cls = classifySpeech(meta, asr);
  const split = splitSung(asr);
  // Cả đoạn là bài hát khi: lặp lời, hoặc quá nửa số câu là câu hát, hoặc chữ kéo dài kèm hashtag nhạc.
  // Hashtag nhạc cộng nói thưa (vlog có nhạc nền, nhiều khoảng lặng) thì không đủ: chỉ lọc từng câu.
  const song = cls.label === 'singing' && ((cls.repeat && slowChars(cls.medCharDur)) || split.sung * 2 > split.total || (cls.tagMusic && cls.medCharDur > 0.33));
  const out = { asr, before, cls, split, song };
  if (cls.label !== 'speech' && cls.label !== 'singing') return { ...out, skip: cls.label };
  let cues;
  if (opts.lyrics) {
    // Chế độ lời bài hát: không bỏ câu hát, đánh dấu để hiện "♪".
    cues = lyricCues(asr, { ...cls, label: song ? 'singing' : 'speech' }, split);
    // Không còn dòng nào: chỉ có tiếng đệm (yeah yeah), hay dòng hát chỉ có tiếng đệm (啦啦啦).
    if (!cues.length) return { ...out, skip: song || split.sung ? 'singing' : 'no_speech' };
  } else if (song) {
    // Đoạn cả bài bị bỏ, trừ đúng các dòng chế độ lời bài hát hiện không có ♪ (câu nói nhanh), để hai chế độ khớp nhau.
    cues = lyricCues(asr, { ...cls, label: 'singing' }, split).filter(c => !c.sung).map(({ sung: _s, ...c }) => c);
    if ((cues.map(c => c.zh).join('').match(HAN) || []).length < 4) return { ...out, skip: 'singing' };
  } else {
    // Dòng chỉ có tiếng đệm chữ Latin ("yeah yeah") bỏ như ở chế độ lời bài hát: đoạn không có câu hát thì hai chế độ
    // dùng chung một kết quả (noSinging ở server.mjs), nên phải ra cùng các dòng.
    cues = segmentCues(split.r).filter(c => /\p{Script=Han}/u.test(c.zh) || !isFiller(c.zh));
    // Bỏ câu hát rồi không còn dòng lời nói nào. Trước đây phần lời nói dưới 4 chữ Hán cũng bỏ cả đoạn: mất câu nói ngắn.
    if (!cues.length) return { ...out, skip: split.sung ? 'singing' : 'no_speech' };
  }
  // Đoạn chỉ có tiếng đệm (嗯。, 啊。; verifier 3/11: 12 trên 20 đoạn "quá ít lời" cũ trong cache, ASR nghe ~0,6 s, thường lúc
  // đầu video có nhạc): không dịch thành "Ừm.". Đoạn có lời thật thì giữ cả dòng tiếng đệm như trước. Nhãn riêng, không phải
  // no_speech: server.mjs làm lại kết quả no_speech có chữ Hán. Đoạn có 诶？, 哎呀！ thì dịch (QUIET_FILLER, 4/11).
  if (!song && cues.every(c => isFiller(c.zh, QUIET_FILLER))) return { ...out, skip: 'filler' };
  return { ...out, cues };
}

// opts (video dài, từng đoạn): { kind: 'aac', offset: giây bắt đầu của âm thanh, from, to, context }; signal: huỷ giữa chừng.
// opts.asrCache { load(), save(x) }: kết quả nhận dạng giọng nói của đúng âm thanh này (server giữ theo mã băm). Lần
// trước dịch lỗi (sau khi đã trả tiền ASR) thì lần gửi lại chỉ còn bước dịch.
export async function makeSubtitles(meta, buf, opts = {}) {
  // Dịch đang tạm dừng (hết lượt trong ngày, key/model sai): báo ngay, khỏi tốn tiền nhận dạng giọng nói cho đoạn không dịch được.
  const paused = pausedError(mtService());
  if (paused) throw paused;
  const t0 = Date.now();
  const saved = opts.asrCache?.load();
  const audio = saved ? { seconds: saved.seconds } : await extractAudio(buf, opts.kind);
  const tAudio = Date.now();
  if (!audio) return { status: 'no_audio', timings: { audioMs: tAudio - t0 } };
  // Từng lần gọi HTTP của bước ASR và bước dịch (net.asr, net.mt: headMs, fresh, connectMs): server ghi vào dòng log.
  const net = { asr: [], mt: [] };
  let asr = saved ? saved.asr : resplitSentences(await netCtx.run({ calls: net.asr }, () => transcribe(audio.mp3, opts.signal)));
  if (!saved) opts.asrCache?.save({ seconds: audio.seconds, asr });
  const tAsr = Date.now();
  const prep = cuesFromAsr(meta, asr, opts);
  asr = prep.asr;
  const { before, cls, split, song } = prep;
  const cues = prep.cues;
  // song: kết quả của đoạn cả bài khác nhau ở hai chế độ kể cả khi sung = 0 (điệp khúc câu 3 chữ), nên server và
  // extension không dùng chung nó giữa hai chế độ (noSinging, modeFree).
  const base = { asr: asr.provider, ...(asr.model && asr.model !== FUNASR_MODEL ? { asrModel: asr.model } : {}), ...(saved ? { asrCached: true } : {}), seconds: audio.seconds, heard: (asr.text || '').slice(0, 40), sung: split.sung, sentences: split.total,
    ...(song ? { song: true } : {}), debug: { features: cls, sentences: split.sentences, net } };
  const skip = (label) => ({ status: 'skipped', label, ...base, timings: { audioMs: tAudio - t0, asrMs: tAsr - tAudio } });
  if (prep.skip) return skip(prep.skip);
  // source: đủ để dựng lại kết quả ở ngôn ngữ đích khác mà không nhận dạng lại (retranslate, server.mjs: yêu cầu retarget).
  const { debug: _dbg, asrCached: _ac, ...srcBase } = base;
  const source = { cues, before, base: srcBase, debug: { features: cls, sentences: split.sentences } };
  return finishSubtitles(meta, { cues, before, base, source, t0, tAudio, tAsr, net }, opts);
}
// Phần cuối chung: ngữ cảnh, dịch, kết quả. Dùng cho makeSubtitles và retranslate.
async function finishSubtitles(meta, { cues, before, base, source, t0, tAudio, tAsr, net }, opts) {
  // opts.context có thể là hàm: server chờ đoạn trước (đang chạy) dịch xong rồi mới lấy ngữ cảnh. Trả về mảng dòng,
  // hoặc { lines, far, pronouns } (far: lấy từ đoạn đã dịch gần nhất phía trước, không phải đoạn liền trước; pronouns:
  // bảng xưng hô trong file cache của đoạn đó).
  const ctxRaw = typeof opts.context === 'function' ? await opts.context(opts.signal) : (opts.context || []);
  const context = Array.isArray(ctxRaw) ? ctxRaw : (ctxRaw.lines || []);
  const far = !Array.isArray(ctxRaw) && !!ctxRaw.far;
  // Không có ngữ cảnh cùng ngôn ngữ đích (vừa đổi ngôn ngữ): server đưa dòng gốc đoạn trước làm lời nói ngay trước.
  if (!before.length && !Array.isArray(ctxRaw) && Array.isArray(ctxRaw.before)) before = ctxRaw.before;
  // Bảng xưng hô trong file cache của đoạn lấy ngữ cảnh (server đọc cùng lúc với 3 dòng): đoạn gửi cùng lúc với đoạn
  // trước (tua tới; mẩu nhanh song song đoạn 0) hay sau khi tải lại extension không có bảng từ extension. Bảng
  // extension gửi đứng trước (đợt soát 1/11, F2).
  const ctxPronouns = Array.isArray(ctxRaw) ? null : normalizePronouns(ctxRaw.pronouns);
  const tmeta = ctxPronouns ? { ...meta, pronouns: mergePronouns(meta.pronouns, ctxPronouns) } : meta;
  base.debug.pronounsIn = normalizePronouns(tmeta.pronouns);
  base.debug.pronounsCtx = ctxPronouns ? ctxPronouns.pairs.length : 0;
  opts.signal?.throwIfAborted();
  const tr = cues.length ? await netCtx.run({ calls: net.mt }, () => translate(tmeta, cues, context, opts.signal, { far, before: context.length && !far ? [] : before, condense: opts.condense !== false, onPartial: opts.onPartial, target: opts.target || 'vi' })) : { cues: [], pronouns: null };
  opts.signal?.throwIfAborted();   // huỷ giữa lượt rút gọn (lượt đó tự bắt lỗi): không trả kết quả dở
  const tMt = Date.now();
  const vi = tr.cues;
  if (tr.fix) base.debug.mtFix = tr.fix;
  // pronouns: bảng xưng hô sau đoạn này (cũng lưu trong file cache); extension giữ theo video, gửi lại ở request sau.
  return { status: vi.length ? 'ok' : 'skipped', label: vi.length ? 'speech' : 'untranslated', target: opts.target || 'vi', ...base, context: context.length,
    contextFar: far, before: context.length && !far ? 0 : before.length, ...(opts.lyrics ? { lyrics: true } : {}),
    ...(vi.length && tr.pronouns ? { pronouns: tr.pronouns } : {}),
    cues: vi.map(c => ({ start: c.start, end: c.end, se: c.se, vi: c.vi, zh: c.zh, ...(c.sung ? { sung: true } : {}) })),
    timings: { audioMs: tAudio - t0, asrMs: tAsr - tAudio, mtMs: tMt - tAsr, totalMs: tMt - t0 }, ...(vi.length ? { source } : {}) };
}
// Dịch một đoạn sang ngôn ngữ đích khác từ `source` đã lưu (makeSubtitles): không nhận dạng lại, mốc giống hệt.
export async function retranslate(meta, source, opts = {}) {
  const paused = pausedError(mtService());
  if (paused) throw paused;
  const t0 = Date.now();
  const net = { asr: [], mt: [] };
  const base = { ...source.base, debug: { ...(source.debug || {}), net } };
  return finishSubtitles(meta, { cues: source.cues, before: source.before || [], base, source, t0, tAudio: t0, tAsr: t0, net }, opts);
}


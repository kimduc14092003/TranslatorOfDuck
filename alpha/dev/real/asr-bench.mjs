#!/usr/bin/env node
// So sánh dịch vụ nhận dạng giọng nói (ASR) trên âm thanh đã giữ của lượt đo thật, để chọn model theo chất lượng: các model
// DashScope (ASR_BENCH_DASHSCOPE_MODELS, mặc định fun-asr, qwen3-asr-flash, qwen-audio-3.1-asr-flash), ElevenLabs Scribe v2,
// Gemini 3.5 Transcribe, MAI-Transcribe-2 (Azure Speech); dịch vụ thiếu key thì bỏ qua. Mỗi đoạn tách mp3 16 kHz mono
// một lần (extractAudio của pipeline), gửi cho mọi dịch vụ có key, rồi in bảng chỉ số và các đoạn các dịch vụ chênh nhau nhất.
//   node asr-bench.mjs <tên lượt | thư mục | file.aac ...> [--go] [--name tên] [--lang zh] [--providers dashscope,elevenlabs,gemini,azure]
//                      [--limit N] [--top 10] [--timeout 60000] [--fresh] [--gemini-upload]
//   node asr-bench.mjs --clean <tên>      xoá kết quả (chữ nhận dạng) của một lượt so sánh
// Tên lượt: lượt "node run.mjs --keep" để lại (alpha/server/work/real/<tên>/<id>-<n>/server/dump/*.aac, server đo chạy với TOD_DUMP).
// TỐN TIỀN: mỗi đoạn × mỗi dịch vụ là một lần gọi thật. Không có --go thì chỉ in kế hoạch (số đoạn, số giây, dịch vụ nào).
// Kết quả đã có của lượt cùng tên được dùng lại (chỉ gọi lại chỗ lỗi); --fresh thì gọi lại hết.
// Nạp alpha/server/pipeline.mjs (tách âm thanh), nên nạp cả alpha/server/.env (không in ra). Âm thanh và chữ nhận dạng có bản
// quyền: kết quả chỉ nằm ở alpha/server/work/asr-bench/<tên> (ngoài git); chữ chỉ in ra ở danh sách đoạn chênh nhau.
// Cách gọi từng dịch vụ theo tài liệu chính thức (xem link ở mỗi adapter); bảng chỉ số giải thích ở README.md cạnh file này.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OUT_ROOT, SERVER_DIR, args, readJsonl, rmrf } from './lib.mjs';

// Thư mục kết quả: luôn dưới alpha/server/work (alpha/server/.gitignore bỏ qua work/), không theo TOD_REAL_OUT.
export const BENCH_ROOT = path.join(SERVER_DIR, 'work', 'asr-bench');
// Model DashScope: ASR_BENCH_DASHSCOPE_MODELS (xem dashscopeKind); các dịch vụ khác một model.
export const MODELS = { elevenlabs: 'scribe_v2', gemini: 'gemini-3.5-transcribe', azure: 'MAI-Transcribe-2' };
const AZURE_API_VERSION = '2025-10-15';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const has = (env, n) => typeof env[n] === 'string' && env[n].trim() !== '';

// ---------------------------------------------------------------- gọi HTTP
// Mỗi lần gọi có hạn (timeoutMs, tính cả lúc đọc body); 429, 5xx hay lỗi mạng thì gọi lại đúng một lần (chờ retry-after,
// tối đa 10 s, không có thì retryWaitMs). Quá hạn thì không gọi lại: tính là lỗi "quá hạn".
async function request(url, init, o) {
  for (let i = 0; ; i++) {
    let res, text;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs) });
      text = await res.text();
    } catch (e) {
      if (e.name === 'TimeoutError') throw Object.assign(new Error(`quá ${o.timeoutMs / 1000} s chưa trả lời`), { kind: 'timeout' });
      if (i === 0) { o.stats.retries++; await sleep(o.retryWaitMs); continue; }
      throw Object.assign(new Error('lỗi mạng: ' + ((e.cause && e.cause.code) || e.message)), { kind: 'network' });
    }
    if ((res.status === 429 || res.status >= 500) && i === 0) {
      o.stats.retries++;
      const hint = Number(res.headers.get('retry-after')) * 1000;
      await sleep(Math.min(hint > 0 ? hint : o.retryWaitMs, 10000));
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}: ${text.replace(/\s+/g, ' ').trim().slice(0, 2000)}`), { kind: 'http', status: res.status, body: text });
    return { res, text, json() { try { return JSON.parse(text); } catch (_) { throw Object.assign(new Error('trả về không phải JSON: ' + text.slice(0, 120)), { kind: 'shape' }); } } };
  }
}

// ---------------------------------------------------------------- chuẩn hoá kết quả về dạng của pipeline
// Từ của dịch vụ không mang dấu cách, dấu câu sau nó (Gemini, Azure, ElevenLabs): lấy chữ của từ trong toàn văn, kèm dấu câu
// và dấu cách liền sau, như từ của Fun-ASR (text + punctuation), để words.map(w => w.text).join('') ra lại toàn văn.
export function attachWords(full, raw) {
  full = String(full || '');
  let pos = 0;
  const at = raw.map((w) => {
    const i = w.text ? full.indexOf(w.text, pos) : -1;
    if (i >= 0) pos = i + w.text.length;
    return i;
  });
  return raw.map((w, k) => {
    if (at[k] < 0) return { text: w.text || '', start: w.start, end: w.end };
    const end0 = at[k] + w.text.length;
    const next = at.slice(k + 1).find((i) => i >= 0) ?? full.length;
    const tail = (/^[\p{P}\p{S}\s]*/u.exec(full.slice(end0)) || [''])[0].length;
    return { text: full.slice(at[k], Math.min(next, end0 + tail)), start: w.start, end: w.end };
  });
}
// Dịch vụ không trả câu (ElevenLabs, Gemini): chia câu từ danh sách từ, hết câu ở dấu câu cuối câu hay khoảng lặng ≥ 0,8 s.
export function segmentsOf(words) {
  const out = [];
  let cur = [];
  const flush = () => { if (cur.length) out.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.text).join('') }); cur = []; };
  for (const w of words) {
    if (cur.length && w.start - cur[cur.length - 1].end >= 0.8) flush();
    cur.push(w);
    if (/[。！？!?…]["'”’)]*\s*$|[A-Za-z0-9]\.\s*$/.test(w.text)) flush();
  }
  flush();
  return out;
}
const num = (x) => (x == null || x === '' ? null : Number(x));
// Mốc của Gemini: chuỗi "1.200s" (tài liệu), phòng khi là số hay { seconds, nanos }.
const offsetS = (x) => (x == null ? null : typeof x === 'object' ? Number(x.seconds || 0) + Number(x.nanos || 0) / 1e9 : parseFloat(String(x)));

// ---------------------------------------------------------------- adapter từng dịch vụ
// Mỗi adapter: (mp3, o) → { provider, model, text, segments: [{start,end,text}], words: [{text,start,end}], lang?, langProb? }.
// o: { env, lang (gợi ý ngôn ngữ, mặc định không: để dịch vụ tự nhận), timeoutMs, retryWaitMs, stats: { retries } }.

// DashScope (Model Studio): nhiều model trong một lượt, mỗi model một hàng (ASR_BENCH_DASHSCOPE_MODELS, cách nhau dấu phẩy).
// Ba kiểu model, theo tài liệu:
// - Kiểu Fun-ASR flash (fun-asr-flash-*, qwen-audio-*-asr-flash): POST multimodal-generation đồng bộ, input_audio base64, trả
//   output.sentence(s) có begin_time/end_time và words[], giống funasrModel trong alpha/server/pipeline.mjs (đang chạy thật).
//   https://www.alibabacloud.com/help/en/model-studio/fun-asr-flash-recorded-speech-recognition-http-api
//   https://www.alibabacloud.com/help/en/model-studio/qwen-speech-recognition (qwen-audio-3.1-asr-flash: ví dụ đồng bộ chỉ có
//   output.sentence.text, tài liệu nói mốc luôn bật nhưng không có trong ví dụ: không có words thì bảng ghi "không có mốc từ").
// - qwen3-asr-flash: cùng đường dẫn đồng bộ nhưng content [{ audio: data URL }], parameters.asr_options; trả
//   output.choices[0].message.content[].text, annotations có language. Không trả mốc thời gian ở dạng đồng bộ (mốc từ chỉ có ở
//   qwen3-asr-flash-filetrans, bất đồng bộ). https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference
// - fun-asr, paraformer-*, *-filetrans: chỉ bất đồng bộ (gửi file_urls công khai, hỏi lại task), không nhận base64: không gọi,
//   bảng ghi "chỉ bất đồng bộ". *-realtime, *-streaming, *-message: chỉ WebSocket: không gọi.
//   https://www.alibabacloud.com/help/en/model-studio/fun-asr-recorded-speech-recognition-restful-api, .../asr-model
// Gợi ý ngôn ngữ chỉ khi có --lang (server hằng ngày luôn gợi ý zh).
export const DASHSCOPE_DEFAULT = 'fun-asr,qwen3-asr-flash,qwen-audio-3.1-asr-flash';
export function dashscopeKind(model) {
  if (/-(realtime|streaming|message)(-|$)/.test(model)) return { kind: 'realtime', note: 'chỉ có dạng WebSocket thời gian thực: không gọi' };
  if (/^(fun-asr|paraformer-.*)$|-filetrans(-|$)/.test(model)) return { kind: 'async', note: 'chỉ bất đồng bộ (file_urls công khai + hỏi lại task), không nhận base64: không gọi' };
  if (/^qwen3-asr-flash/.test(model)) return { kind: 'qwen3', note: 'dạng đồng bộ không trả mốc thời gian (tài liệu): không có mốc từ' };
  return { kind: 'flash', note: null };
}
const dashscopeUrl = (env) => (env.DASHSCOPE_BASE || 'https://dashscope-intl.aliyuncs.com') + '/api/v1/services/aigc/multimodal-generation/generation';
const dashscopeHeaders = (env) => ({ Authorization: 'Bearer ' + env.DASHSCOPE_API_KEY, 'Content-Type': 'application/json', 'X-DashScope-SSE': 'disable' });
const dashscopeFlash = (model) => async (mp3, o) => {
  let b;
  try {
    b = (await request(dashscopeUrl(o.env), {
      method: 'POST',
      headers: dashscopeHeaders(o.env),
      body: JSON.stringify({
        model,
        input: { messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'data:audio/mp3;base64,' + mp3.toString('base64') } }] }] },
        parameters: { format: 'mp3', sample_rate: '16000', ...(o.lang ? { language_hints: [o.lang] } : {}) },
      }),
    }, o)).json();
  } catch (e) {
    if (e.status === 400 && /ASR_RESPONSE_HAVE_NO_WORDS/.test(e.body || '')) return { provider: model, model, text: '', segments: [], words: [] };
    throw e;
  }
  const out = (b && b.output && (b.output.output || b.output)) || {};
  if (typeof out !== 'object' || !('sentence' in out || 'sentences' in out || typeof out.text === 'string')) throw Object.assign(new Error('kết quả lạ: ' + JSON.stringify(b).slice(0, 2000)), { kind: 'shape' });
  let sentences = out.sentences || out.sentence || [];
  if (!Array.isArray(sentences)) sentences = [sentences];
  sentences = sentences.filter(Boolean);
  const timed = (x) => x.begin_time != null && x.end_time != null;
  const segments = sentences.filter(timed).map((x) => ({ start: x.begin_time / 1000, end: x.end_time / 1000, text: x.text || '' }));
  const words = sentences.flatMap((x) => x.words || []).filter(timed).map((w) => ({ text: (w.text || '') + (w.punctuation || ''), start: w.begin_time / 1000, end: w.end_time / 1000 }));
  return { provider: model, model, text: out.text || sentences.map((x) => x.text || '').join(''), segments, words };
};
const dashscopeQwen3 = (model) => async (mp3, o) => {
  const b = (await request(dashscopeUrl(o.env), {
    method: 'POST',
    headers: dashscopeHeaders(o.env),
    body: JSON.stringify({
      model,
      input: { messages: [{ role: 'user', content: [{ audio: 'data:audio/mpeg;base64,' + mp3.toString('base64') }] }] },
      // ITN (số viết bằng chữ số) như Fun-ASR, để so chữ công bằng; chỉ có tác dụng với tiếng Trung, tiếng Anh.
      parameters: { asr_options: { enable_itn: true, ...(o.lang ? { language: o.lang } : {}) } },
    }),
  }, o)).json();
  const msg = b && b.output && Array.isArray(b.output.choices) && b.output.choices[0] && b.output.choices[0].message;
  if (!msg) throw Object.assign(new Error('kết quả lạ: ' + JSON.stringify(b).slice(0, 2000)), { kind: 'shape' });
  const content = Array.isArray(msg.content) ? msg.content : [{ text: String(msg.content || '') }];
  const text = content.map((c) => (c && c.text) || '').join('');
  const notes = [...(msg.annotations || []), ...content.flatMap((c) => (c && c.annotations) || [])];
  const lang = (notes.find((x) => x && x.language) || {}).language || null;
  return { provider: model, model, text, segments: [], words: [], lang };
};

// ElevenLabs Scribe v2: POST /v1/speech-to-text, multipart (file, model_id), header xi-api-key, trả đồng bộ khi không có
// webhook. Từ: words[] loại word | spacing | audio_event, start/end tính bằng giây; language_code + language_probability.
// Tài liệu: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
// Tắt tag_audio_events để chữ "(laughter)", "(music)" không làm lệch so sánh chữ.
async function elevenlabs(mp3, o) {
  const model = MODELS.elevenlabs;
  const base = (o.env.ELEVENLABS_BASE || 'https://api.elevenlabs.io').replace(/\/$/, '');
  const fd = new FormData();
  fd.append('model_id', model);
  fd.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'chunk.mp3');
  fd.append('timestamps_granularity', 'word');
  fd.append('tag_audio_events', 'false');
  if (o.lang) fd.append('language_code', o.lang);
  let b = (await request(base + '/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': o.env.ELEVENLABS_API_KEY }, body: fd }, o)).json();
  if (Array.isArray(b.transcripts)) b = b.transcripts[0] || {};   // nhiều kênh (âm thanh ta gửi là mono, phòng khi)
  if (!b || (typeof b.text !== 'string' && !Array.isArray(b.words))) throw Object.assign(new Error('kết quả lạ: ' + JSON.stringify(b).slice(0, 2000)), { kind: 'shape' });
  const tokens = Array.isArray(b.words) ? b.words : [];
  const text = typeof b.text === 'string' ? b.text : tokens.map((w) => w.text || '').join('');
  const raw = tokens.filter((w) => (w.type || 'word') === 'word' && w.start != null && w.end != null).map((w) => ({ text: w.text || '', start: Number(w.start), end: Number(w.end) }));
  const words = attachWords(text, raw);
  return { provider: 'elevenlabs', model, text, segments: segmentsOf(words), words, lang: b.language_code || null, langProb: num(b.language_probability) };
}

// Gemini 3.5 Transcribe: POST /v1beta/interactions. Âm thanh là mục input kiểu "audio": gửi thẳng base64 (data + mime_type,
// cả yêu cầu tối đa 20 MB, đủ cho đoạn ≤ 2 phút) hay tải lên Files API trước rồi gửi uri + mime_type (--gemini-upload). Trang
// transcribe ghi { type: 'file', file_uri } nhưng dịch vụ thật trả 400 "The value 'file' is not supported for 'type'" (lượt
// đo 4/11): theo trang audio. Mốc từng từ: mode verbatim + timestamp_granularities ["word"], trả annotations word_info với
// start_offset/end_offset dạng "0.100s". Không có trường ngôn ngữ nhận được.
// Tài liệu: https://aistudio.google.com/docs/audio, https://aistudio.google.com/docs/transcribe, https://aistudio.google.com/docs/files
// Tải lên: thời gian đo gồm cả lần tải lên (uploadMs ghi riêng); file xoá ngay sau đó (không thì Google giữ 48 giờ).
const GEMINI_LOCALES = { zh: 'cmn-Hans-CN', yue: 'yue-Hant-HK', en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', vi: 'vi-VN' };
async function geminiUpload(mp3, base, key, o) {
  const u = new URL(base);
  const start = await request(u.origin + '/upload' + u.pathname.replace(/\/$/, '') + '/files', {
    method: 'POST',
    headers: { ...key, 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(mp3.length),
      'X-Goog-Upload-Header-Content-Type': 'audio/mp3', 'Content-Type': 'application/json' },
    body: JSON.stringify({ file: { display_name: 'asr-bench.mp3' } }),
  }, o);
  const uploadUrl = start.res.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw Object.assign(new Error('Files API không trả x-goog-upload-url'), { kind: 'shape' });
  let file = ((await request(uploadUrl, { method: 'POST', headers: { 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' }, body: mp3 }, o)).json() || {}).file;
  if (!file || !file.uri) throw Object.assign(new Error('Files API không trả file.uri'), { kind: 'shape' });
  // File âm thanh thường dùng được ngay; còn PROCESSING thì hỏi lại tới khi ACTIVE (trong hạn của lần gọi).
  for (const until = Date.now() + o.timeoutMs; file.state && file.state !== 'ACTIVE';) {
    if (file.state === 'FAILED' || Date.now() > until) { geminiDelete(file, base, key); throw Object.assign(new Error('file tải lên ở trạng thái ' + file.state), { kind: 'shape' }); }
    await sleep(500);
    file = (await request(base + '/' + file.name, { headers: key }, o)).json();
  }
  return file;
}
// Xoá file đã tải lên; hỏng thì thôi (Google tự xoá sau 48 giờ).
const geminiDelete = (file, base, key) => { if (file && file.name) fetch(base + '/' + file.name, { method: 'DELETE', headers: key, signal: AbortSignal.timeout(10000) }).then((r) => r.arrayBuffer()).catch(() => {}); };
async function gemini(mp3, o) {
  const model = MODELS.gemini;
  const base = (o.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const key = { 'x-goog-api-key': o.env.GEMINI_API_KEY };
  const t0 = Date.now();
  const file = o.geminiUpload ? await geminiUpload(mp3, base, key, o) : null;
  const uploadMs = file ? Date.now() - t0 : null;
  try {
    const audio = file ? { type: 'audio', uri: file.uri, mime_type: 'audio/mp3' } : { type: 'audio', data: mp3.toString('base64'), mime_type: 'audio/mp3' };
    const b = (await request(base + '/interactions', {
      method: 'POST',
      headers: { ...key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/' + model,
        input: [audio],
        generation_config: { transcription_config: { language_codes: o.lang ? [GEMINI_LOCALES[o.lang] || o.lang] : [], mode: { type: 'verbatim', timestamp_granularities: ['word'] } } },
      }),
    }, o)).json();
    if (b.status && b.status !== 'completed') throw Object.assign(new Error('interaction ở trạng thái ' + b.status), { kind: 'shape' });
    // Chữ nằm ở steps[].content[] (bước model_output) theo ví dụ của tài liệu; phòng khi có dạng outputs[].
    const contents = [...(b.steps || []).filter((s) => !s.type || s.type === 'model_output').flatMap((s) => s.content || []), ...(Array.isArray(b.outputs) ? b.outputs : [])];
    const texts = contents.filter((c) => c && c.type === 'text');
    if (!texts.length && !(b.steps || b.outputs)) throw Object.assign(new Error('kết quả lạ: ' + JSON.stringify(b).slice(0, 2000)), { kind: 'shape' });
    const text = texts.map((c) => c.text || '').join('');
    const raw = texts.flatMap((c) => c.annotations || []).filter((x) => x.type === 'word_info')
      .map((x) => ({ text: x.text || '', start: offsetS(x.start_offset), end: offsetS(x.end_offset) }));
    const words = attachWords(text, raw);
    return { provider: 'gemini', model, text, segments: segmentsOf(words), words, ...(file ? { uploadMs } : {}) };
  } finally {
    geminiDelete(file, base, key);
  }
}

// MAI-Transcribe-2 qua Azure Speech (fast transcription, LLM Speech): POST .../speechtotext/transcriptions:transcribe
// ?api-version=2025-10-15, multipart audio + definition { enhancedMode: { enabled, model, modelOptions: { timestamps: 'word' } } },
// header Ocp-Apim-Subscription-Key. Trả combinedPhrases[].text và phrases[] (offsetMilliseconds, durationMilliseconds, text,
// locale, words[] cùng mốc). Tài liệu: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/mai-transcribe,
// https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create
// Tài liệu MAI dùng tên miền riêng của resource (<tên>.cognitiveservices.azure.com); mặc định ở đây là tên miền theo vùng
// (<vùng>.api.cognitive.microsoft.com, kiểu cũ của fast transcription). Không gọi được thì đặt AZURE_SPEECH_BASE=https://<tên resource>.cognitiveservices.azure.com.
async function azure(mp3, o) {
  const model = MODELS.azure;
  const region = String(o.env.AZURE_SPEECH_REGION || '').trim();
  if (!/^[a-z0-9]+$/i.test(region) && !o.env.AZURE_SPEECH_BASE) throw Object.assign(new Error('AZURE_SPEECH_REGION không hợp lệ'), { kind: 'config' });
  const base = (o.env.AZURE_SPEECH_BASE || `https://${region}.api.cognitive.microsoft.com`).replace(/\/$/, '');
  const fd = new FormData();
  fd.append('audio', new Blob([mp3], { type: 'audio/mpeg' }), 'chunk.mp3');
  fd.append('definition', JSON.stringify({ ...(o.lang ? { locales: [o.lang] } : {}), enhancedMode: { enabled: true, model, modelOptions: { timestamps: 'word' } } }));
  const b = (await request(`${base}/speechtotext/transcriptions:transcribe?api-version=${AZURE_API_VERSION}`, {
    method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': o.env.AZURE_SPEECH_KEY }, body: fd,
  }, o)).json();
  if (!b || !(Array.isArray(b.phrases) || Array.isArray(b.combinedPhrases))) throw Object.assign(new Error('kết quả lạ: ' + JSON.stringify(b).slice(0, 2000)), { kind: 'shape' });
  const phrases = b.phrases || [];
  const sep = phrases.some((p) => /\p{Script=Han}/u.test(p.text || '')) ? '' : ' ';
  const text = (b.combinedPhrases || []).map((x) => x.text || '').join(sep) || phrases.map((p) => p.text || '').join(sep);
  const ms = (x) => Number(x) / 1000;
  const segments = phrases.map((p) => ({ start: ms(p.offsetMilliseconds), end: ms(p.offsetMilliseconds + p.durationMilliseconds), text: p.text || '' }));
  const raw = phrases.flatMap((p) => (p.words || []).map((w) => ({ text: w.text || '', start: ms(w.offsetMilliseconds), end: ms(w.offsetMilliseconds + w.durationMilliseconds) })));
  // Ngôn ngữ: locale của các câu, tính theo thời lượng.
  const by = new Map();
  for (const p of phrases) if (p.locale) by.set(p.locale, (by.get(p.locale) || 0) + (Number(p.durationMilliseconds) || 1));
  const lang = [...by].sort((x, y) => y[1] - x[1]).map((x) => x[0])[0] || null;
  return { provider: 'azure', model, text, segments, words: attachWords(text, raw), lang };
}

// Danh sách dịch vụ: mỗi model DashScope một hàng (id = tên model), rồi ElevenLabs, Gemini, Azure. note: giới hạn theo tài
// liệu, in dưới bảng; noCall: không gọi được bằng một yêu cầu đồng bộ gửi âm thanh base64 (chỉ ghi lý do).
export function providersFor(env = process.env) {
  const models = (has(env, 'ASR_BENCH_DASHSCOPE_MODELS') ? env.ASR_BENCH_DASHSCOPE_MODELS : DASHSCOPE_DEFAULT).split(',').map((s) => s.trim()).filter((m, i, a) => m && a.indexOf(m) === i);
  const ds = models.map((m) => {
    const k = dashscopeKind(m);
    return { id: m, model: m, vendor: 'dashscope', keys: ['DASHSCOPE_API_KEY'], note: k.note, noCall: k.kind === 'async' || k.kind === 'realtime',
      run: k.kind === 'qwen3' ? dashscopeQwen3(m) : dashscopeFlash(m) };
  });
  return [...ds,
    { id: 'elevenlabs', model: MODELS.elevenlabs, keys: ['ELEVENLABS_API_KEY'], run: elevenlabs, note: null },
    { id: 'gemini', model: MODELS.gemini, keys: ['GEMINI_API_KEY'], run: gemini, note: null },
    { id: 'azure', model: MODELS.azure, keys: ['AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION'], run: azure, note: null }];
}
// Dịch vụ bật khi có đủ biến key (khác rỗng). Chỉ trả tên biến thiếu, không bao giờ trả giá trị. only: id, hay "dashscope" cho
// mọi model DashScope. notCalled: có key nhưng không gọi được (chỉ bất đồng bộ, chỉ WebSocket).
export function enabledProviders(env = process.env, only = null) {
  const all = providersFor(env);
  const want = only ? all.filter((p) => only.includes(p.id) || (p.vendor && only.includes(p.vendor))) : all;
  const ready = want.filter((p) => p.keys.every((k) => has(env, k)));
  return {
    enabled: ready.filter((p) => !p.noCall),
    notCalled: ready.filter((p) => p.noCall).map((p) => ({ id: p.id, note: p.note })),
    skipped: want.filter((p) => !p.keys.every((k) => has(env, k))).map((p) => ({ id: p.id, missing: p.keys.filter((k) => !has(env, k)) })),
  };
}
// Gọi một dịch vụ cho một đoạn: không bao giờ ném lỗi, trả { ok, ms, retries, ... } để tính chỉ số.
export async function callProvider(p, mp3, opts) {
  const stats = { retries: 0 };
  const t0 = Date.now();
  try {
    const r = await p.run(mp3, { timeoutMs: 60000, retryWaitMs: 2000, ...opts, stats });
    return { ok: true, ms: Date.now() - t0, retries: stats.retries, ...r };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, retries: stats.retries, provider: p.id, model: p.model, error: String(e.message || e).slice(0, 2000), kind: e.kind || 'other', status: e.status ?? null };
  }
}

// ---------------------------------------------------------------- chỉ số
// So chữ: NFKC, bỏ dấu câu, ký hiệu, dấu cách, chữ thường; không có OpenCC nên phồn thể và giản thể tính là khác chữ.
export const normalizeText = (t) => Array.from(String(t || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, ''));
export function editDistance(a, b) {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j), cur = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}
// Tỉ lệ lỗi ký tự của hyp so với ref (ref là chuẩn); ref rỗng thì không tính (null).
export const cer = (ref, hyp) => { const r = normalizeText(ref), h = normalizeText(hyp); return r.length ? editDistance(r, h) / r.length : null; };
// Độ chênh giữa hai bản (0..1, đối xứng): khoảng cách sửa / độ dài bản dài hơn; cả hai rỗng là 0.
const gap = (a, b) => { const x = normalizeText(a), y = normalizeText(b); const n = Math.max(x.length, y.length); return n ? editDistance(x, y) / n : 0; };

// Hệ chữ chiếm nhiều nhất trong chữ (Han, Japanese, Hangul, Latin, …). Chữ Hán kèm kana (≥ 10%) là tiếng Nhật.
const SCRIPTS = [['Han', /\p{Script=Han}/gu], ['Kana', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu], ['Hangul', /\p{Script=Hangul}/gu], ['Latin', /\p{Script=Latin}/gu],
  ['Cyrillic', /\p{Script=Cyrillic}/gu], ['Thai', /\p{Script=Thai}/gu], ['Arabic', /\p{Script=Arabic}/gu], ['Devanagari', /\p{Script=Devanagari}/gu]];
export function scriptOf(t) {
  const n = Object.fromEntries(SCRIPTS.map(([k, re]) => [k, (String(t || '').match(re) || []).length]));
  if (n.Kana && n.Kana >= 0.1 * (n.Han + n.Kana)) { n.Japanese = n.Han + n.Kana; n.Han = 0; }
  delete n.Kana;
  const best = Object.entries(n).sort((x, y) => y[1] - x[1])[0];
  return best && best[1] > 0 ? best[0] : null;
}
// Mã ngôn ngữ dịch vụ báo (zh, cmn, zh-CN, yue, ja, …) → hệ chữ, để so với hệ chữ của bản đồng thuận.
const LANG_SCRIPT = { zh: 'Han', zho: 'Han', chi: 'Han', cmn: 'Han', yue: 'Han', wuu: 'Han', nan: 'Han', hak: 'Han', ja: 'Japanese', jpn: 'Japanese', ko: 'Hangul', kor: 'Hangul',
  ru: 'Cyrillic', rus: 'Cyrillic', uk: 'Cyrillic', ukr: 'Cyrillic', bg: 'Cyrillic', bul: 'Cyrillic', sr: 'Cyrillic', mk: 'Cyrillic', kk: 'Cyrillic', th: 'Thai', tha: 'Thai',
  ar: 'Arabic', ara: 'Arabic', fa: 'Arabic', fas: 'Arabic', ur: 'Arabic', urd: 'Arabic', hi: 'Devanagari', hin: 'Devanagari', mr: 'Devanagari', mar: 'Devanagari', ne: 'Devanagari', nep: 'Devanagari' };
export const langScript = (code) => { if (!code) return null; const k = String(code).toLowerCase().split(/[-_]/)[0]; return LANG_SCRIPT[k] || 'Latin'; };

const quantile = (xs, q) => { const s = xs.filter((x) => x != null && isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1 < 0 ? 0 : Math.ceil(q * s.length) - 1)] : null; };
const share = (k, n) => (n ? Math.round((100 * k) / n) : null);
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const timedWords = (r) => (r.words || []).filter((w) => isFinite(w.start) && isFinite(w.end) && w.end > w.start);

// Bản đồng thuận của một đoạn: bản (của dịch vụ ok, có chữ) gần các bản khác nhất. Một dịch vụ thì là bản đó.
export function consensusOf(rec, ids) {
  const oks = ids.filter((p) => rec.results[p] && rec.results[p].ok && normalizeText(rec.results[p].text).length);
  if (!oks.length) return null;
  const score = (p) => oks.reduce((s, q) => s + (q === p ? 0 : gap(rec.results[p].text, rec.results[q].text)), 0);
  const p = oks.slice().sort((x, y) => score(x) - score(y))[0];
  return { provider: p, text: rec.results[p].text };
}

// records: [{ key, id, from, to, audioStart, seconds, results: { provider: kết quả callProvider } }]. Không chứa chữ nhận dạng.
export function computeMetrics(records, ids, top = 10, models = {}) {
  const recs = records.filter((r) => r.results && !r.noAudio);
  const P = Object.fromEntries(ids.map((p) => [p, { model: models[p] || MODELS[p] || p, calls: 0, ok: 0, errors: 0, errorKinds: {}, errorSamples: [], retries: 0, ms: [],
    nonEmpty: 0, punctuated: 0, withWordTimes: 0, stretchedWords: 0, chunksWithStretched: 0, wordDur: [], langReported: 0, langMatch: 0,
    scriptChecked: 0, scriptMatch: 0, emptyWhenOthersSpoke: 0 }]));
  const pair = Object.fromEntries(ids.map((p) => [p, Object.fromEntries(ids.filter((q) => q !== p).map((q) => [q, []]))]));
  const expectedCount = {};
  const disagree = [];
  for (const rec of recs) {
    const cons = consensusOf(rec, ids);
    const expected = cons ? scriptOf(cons.text) : null;
    if (expected) expectedCount[expected] = (expectedCount[expected] || 0) + 1;
    for (const p of ids) {
      const r = rec.results[p];
      if (!r) continue;
      const m = P[p];
      m.calls++;
      m.retries += r.retries || 0;
      if (!r.ok) {
        m.errors++;
        const k = r.kind === 'http' ? 'HTTP ' + r.status : r.kind || 'other';
        m.errorKinds[k] = (m.errorKinds[k] || 0) + 1;
        if (m.errorSamples.length < 3) m.errorSamples.push(String(r.error || ''));
        continue;
      }
      m.ok++;
      m.ms.push(r.ms);
      if (!normalizeText(r.text).length) { if (cons) m.emptyWhenOthersSpoke++; continue; }
      m.nonEmpty++;
      if (/\p{P}/u.test(r.text)) m.punctuated++;
      const tw = timedWords(r);
      if (tw.length) m.withWordTimes++;
      const long = tw.filter((w) => w.end - w.start > 2).length;
      m.stretchedWords += long;
      if (long) m.chunksWithStretched++;
      for (const w of tw) m.wordDur.push(w.end - w.start);
      if (r.lang) { m.langReported++; if (expected && langScript(r.lang) === expected) m.langMatch++; }
      if (expected) { m.scriptChecked++; if (scriptOf(r.text) === expected) m.scriptMatch++; }
      for (const q of ids) {
        const o = rec.results[q];
        if (q === p || !o || !o.ok) continue;
        const c = cer(o.text, r.text);
        if (c != null) pair[p][q].push(c);
      }
    }
    // Độ chênh của đoạn: trung bình độ chênh từng cặp dịch vụ ok (một bản rỗng, bản kia có chữ là 1).
    const oks = ids.filter((p) => rec.results[p] && rec.results[p].ok);
    if (oks.length >= 2) {
      const gs = [];
      for (let i = 0; i < oks.length; i++) for (let j = i + 1; j < oks.length; j++) gs.push(gap(rec.results[oks[i]].text, rec.results[oks[j]].text));
      disagree.push({ key: rec.key, id: rec.id, from: rec.from, to: rec.to, audioStart: rec.audioStart, seconds: rec.seconds, score: r3(mean(gs)), providers: oks });
    }
  }
  const providers = Object.fromEntries(ids.map((p) => {
    const m = P[p];
    const cerVs = Object.fromEntries(Object.entries(pair[p]).map(([q, xs]) => [q, { mean: r3(mean(xs)), n: xs.length }]));
    const all = Object.values(pair[p]).flat();
    return [p, { model: m.model, calls: m.calls, ok: m.ok, errors: m.errors, errorKinds: m.errorKinds, errorSamples: m.errorSamples, retries: m.retries,
      latencyMs: { p50: quantile(m.ms, 0.5), p95: quantile(m.ms, 0.95), n: m.ms.length },
      nonEmpty: m.nonEmpty, punctuatedPct: share(m.punctuated, m.nonEmpty), wordTimesPct: share(m.withWordTimes, m.nonEmpty),
      stretchedWords: m.stretchedWords, chunksWithStretchedPct: share(m.chunksWithStretched, m.nonEmpty), medianWordS: r3(quantile(m.wordDur, 0.5)),
      lang: { reported: m.langReported, match: m.langMatch, matchPct: share(m.langMatch, m.langReported) },
      scriptMatchPct: share(m.scriptMatch, m.scriptChecked), emptyWhenOthersSpoke: m.emptyWhenOthersSpoke,
      cerVs, cerVsOthersMean: r3(mean(all)) }];
  }));
  disagree.sort((x, y) => y.score - x.score);
  return { chunks: recs.length, noAudio: records.length - recs.length, expectedScript: expectedCount, providers, disagreements: disagree.filter((d) => d.score > 0).slice(0, top) };
}

// ---------------------------------------------------------------- in báo cáo
const cell = (x, w) => String(x ?? '-').padStart(w);
const pctS = (x) => (x == null ? '-' : x + '%');
export function printReport(metrics, records, ids, out = console.log) {
  const M = metrics.providers;
  const W = Math.max(10, ...ids.map((p) => p.length));
  out(`\n${metrics.chunks} đoạn có âm thanh${metrics.noAudio ? `, ${metrics.noAudio} đoạn không có tiếng` : ''}. Hệ chữ của bản đồng thuận: ` +
    (Object.entries(metrics.expectedScript).map(([k, v]) => `${k} ${v}`).join(', ') || '-'));
  out('dịch vụ'.padEnd(W) + ' | đoạn ok | lỗi | gọi lại | p50 ms | p95 ms | có dấu câu | có mốc từ | đoạn có từ >2 s (số từ) | từ trung vị s | báo ngôn ngữ đúng | chữ đúng hệ | trống khi bên khác có chữ | CER TB');
  for (const p of ids) {
    const m = M[p];
    out([p.padEnd(W), cell(`${m.ok}/${m.calls}`, 7), cell(m.errors, 3), cell(m.retries, 7), cell(m.latencyMs.p50, 6), cell(m.latencyMs.p95, 6), cell(pctS(m.punctuatedPct), 10),
      cell(pctS(m.wordTimesPct), 9), cell(`${pctS(m.chunksWithStretchedPct)} (${m.stretchedWords})`, 23), cell(m.medianWordS, 13),
      cell(m.lang.reported ? `${m.lang.match}/${m.lang.reported}` : 'không báo', 17), cell(pctS(m.scriptMatchPct), 11), cell(m.emptyWhenOthersSpoke, 25), cell(m.cerVsOthersMean, 6)].join(' | '));
  }
  for (const p of ids) {
    const m = M[p];
    if (m.errors) out(`  ${p} lỗi: ${Object.entries(m.errorKinds).map(([k, v]) => `${v} ${k === 'timeout' ? 'quá hạn' : k}`).join(', ')}; ví dụ: ${m.errorSamples[0]}`);
  }
  for (const [p, note] of Object.entries(metrics.notes || {})) out(`  ${p}: ${note}`);
  for (const x of metrics.notCalled || []) out(`  ${x.id}: ${x.note}`);
  if (ids.length >= 2) {
    out('\nCER từng cặp (hàng: dịch vụ được chấm; cột: dịch vụ lấy làm chuẩn; số đoạn trong ngoặc):');
    const C = Math.max(14, ...ids.map((q) => q.length));
    out(''.padEnd(W) + ' | ' + ids.map((q) => q.padStart(C)).join(' | '));
    for (const p of ids) out(p.padEnd(W) + ' | ' + ids.map((q) => (q === p ? cell('—', C) : cell(M[p].cerVs[q].mean == null ? '-' : `${M[p].cerVs[q].mean} (${M[p].cerVs[q].n})`, C))).join(' | '));
  }
  if (metrics.disagreements.length) {
    out('\nĐoạn các dịch vụ chênh nhau nhất (nghe lại để biết bên nào đúng; chữ có bản quyền, đừng chép ra ngoài):');
    const byKey = new Map(records.map((r) => [r.key, r]));
    metrics.disagreements.forEach((d, i) => {
      const rec = byKey.get(d.key);
      const span = d.from != null ? `${d.from}–${d.to} s` : '?';
      out(`#${i + 1} ${d.id} ${span} (âm thanh từ ${d.audioStart ?? 0} s, dài ${d.seconds ?? '?'} s) chênh ${d.score}  [${rec ? rec.file : ''}]`);
      for (const p of ids) {
        const r = rec && rec.results[p];
        if (r) out(`   ${p.padEnd(W)} ${r.ok ? (r.text || '(trống)') : 'LỖI ' + r.error}`);
      }
    });
  }
}

// ---------------------------------------------------------------- đoạn âm thanh đầu vào
// Tên file của server đo (server.mjs, TOD_DUMP): <id>.[q]<from>-<to>.<loại>.<PIPELINE_VERSION>.at<audioStart>.aac
// (loại: vi, vi.lyr, en, …; q: đoạn gấp). Tên khác thì vẫn chạy, chỉ không có mốc.
const DUMP_NAME = /^(\d{6,})\.(q?)(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\.(.+)\.at(-?\d+(?:\.\d+)?)\.aac$/;
export function parseChunkName(file) {
  const b = path.basename(file);
  const m = DUMP_NAME.exec(b);
  if (!m) return { file: b, id: b.replace(/\.aac$/, ''), from: null, to: null, quick: false, kind: null, audioStart: 0 };
  return { file: b, id: m[1], quick: m[2] === 'q', from: Number(m[3]), to: Number(m[4]), kind: m[5], audioStart: Number(m[6]) };
}
function aacFiles(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return p.endsWith('.aac') ? [p] : [];
  return fs.readdirSync(p).sort().flatMap((f) => aacFiles(path.join(p, f)));
}
// Đầu vào: tên lượt dưới alpha/server/work/real, thư mục, hay file .aac. Cùng âm thanh (đoạn giữ hai lần, ví dụ đổi ngôn ngữ
// đích) chỉ tính một lần.
export function collectChunks(inputs) {
  const files = inputs.flatMap((x) => {
    const p = fs.existsSync(x) ? x : path.join(OUT_ROOT, x);
    if (!fs.existsSync(p)) throw new Error('không thấy: ' + x);
    return aacFiles(p);
  });
  const seen = new Set();
  const out = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const key = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...parseChunkName(f), key, path: f });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || (a.from ?? 0) - (b.from ?? 0) || a.file.localeCompare(b.file));
}
const safeName = (n) => { const s = String(n); if (!/^[\w.-]+$/.test(s) || /^\.+$/.test(s)) throw new Error('tên không hợp lệ: ' + s); return s; };

// ---------------------------------------------------------------- chạy
async function main() {
  const a = args();
  if (a.clean) {
    const d = path.join(BENCH_ROOT, safeName(a.clean));
    console.log(rmrf(d) ? 'Đã xoá kết quả so sánh nhận dạng ' + d : 'Không xoá được ' + d + ' — xoá tay thư mục này');
    return 0;
  }
  if (!a._.length) {
    console.log('node asr-bench.mjs <tên lượt | thư mục | file.aac ...> [--go] [--name tên] [--lang zh] [--providers dashscope,elevenlabs,gemini,azure] [--limit N] [--top 10] [--timeout 60000] [--fresh] [--gemini-upload]');
    console.log('node asr-bench.mjs --clean <tên>');
    return 1;
  }
  let chunks = collectChunks(a._);
  if (a.limit) chunks = chunks.slice(0, Number(a.limit));
  if (!chunks.length) { console.log('Không có file .aac nào (server đo phải chạy với TOD_DUMP=1; run.mjs làm sẵn).'); return 1; }
  const runName = a._.length === 1 && !fs.existsSync(a._[0]) ? a._[0] : a._.length === 1 && fs.statSync(a._[0]).isDirectory() ? path.basename(path.resolve(a._[0])) : null;
  const name = safeName(a.name || runName || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
  const outDir = path.join(BENCH_ROOT, name);
  // Nạp pipeline: tách âm thanh, và nạp alpha/server/.env vào process.env (không in giá trị nào).
  const P = await import(pathToFileURL(path.join(SERVER_DIR, 'pipeline.mjs')).href);
  const only = a.providers ? String(a.providers).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const { enabled, notCalled, skipped } = enabledProviders(process.env, only);
  for (const s of skipped) console.log(`bỏ qua ${s.id}: thiếu ${s.missing.join(', ')} trong alpha/server/.env`);
  for (const x of notCalled) console.log(`không gọi ${x.id}: ${x.note}`);
  if (!enabled.length) { console.log('Không có dịch vụ nào có key.'); return 1; }
  const ids = enabled.map((p) => p.id);
  const lang = a.lang ? String(a.lang) : null;
  const opts = { env: process.env, lang, timeoutMs: Number(a.timeout) || 60000, retryWaitMs: a['retry-wait'] != null ? Number(a['retry-wait']) : 2000, geminiUpload: !!a['gemini-upload'] };

  // Kết quả đã có (lượt cùng tên): dùng lại chỗ ok, chỉ gọi lại chỗ lỗi hay dịch vụ chưa gọi.
  const file = path.join(outDir, 'chunks.jsonl');
  const prev = new Map(a.fresh ? [] : readJsonl(file).map((r) => [r.key, r]));
  const recs = chunks.map((c) => {
    const old = prev.get(c.key);
    return { key: c.key, file: c.file, id: c.id, from: c.from, to: c.to, quick: c.quick, kind: c.kind, audioStart: c.audioStart,
      seconds: old ? old.seconds : null, noAudio: old ? !!old.noAudio : false, results: old ? Object.fromEntries(Object.entries(old.results || {}).filter(([, r]) => r.ok)) : {} };
  });
  const need = (r) => (r.noAudio ? [] : enabled.filter((p) => !r.results[p.id]));
  const calls = recs.reduce((s, r) => s + need(r).length, 0);
  const known = recs.filter((r) => r.seconds != null).reduce((s, r) => s + r.seconds, 0);
  console.log(`${chunks.length} đoạn, dịch vụ: ${ids.join(', ')}${lang ? `, gợi ý ngôn ngữ ${lang}` : ', tự nhận ngôn ngữ'}; cần ${calls} lần gọi${known ? ` (đã biết ${Math.round(known)} s âm thanh)` : ''}. Kết quả: ${outDir}`);
  if (calls && !a.go) { console.log('TỐN TIỀN: thêm --go để gọi thật.'); return 0; }

  fs.mkdirSync(outDir, { recursive: true });
  const save = () => fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  for (const [i, rec] of recs.entries()) {
    const todo = need(rec);
    if (!todo.length) continue;
    const audio = await P.extractAudio(fs.readFileSync(chunks[i].path), 'aac');
    if (!audio) { rec.noAudio = true; save(); continue; }
    rec.seconds = audio.seconds;
    const got = await Promise.all(todo.map((p) => callProvider(p, audio.mp3, opts)));
    todo.forEach((p, k) => { rec.results[p.id] = got[k]; });
    save();
    console.log(`${i + 1}/${recs.length} ${rec.id} ${rec.from ?? ''}–${rec.to ?? ''} s: ` + todo.map((p, k) => `${p.id} ${got[k].ok ? got[k].ms + ' ms' : 'LỖI'}`).join(', '));
  }
  const metrics = { ...computeMetrics(recs, ids, Number(a.top) || 10, Object.fromEntries(enabled.map((p) => [p.id, p.model]))),
    notes: Object.fromEntries(enabled.filter((p) => p.note).map((p) => [p.id, p.note])
      .concat(opts.geminiUpload && ids.includes('gemini') ? [['gemini', 'tải âm thanh lên Files API trước (--gemini-upload): thời gian gồm cả lần tải lên']] : [])), notCalled };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'metrics.json'), JSON.stringify({ name, at: new Date().toISOString(), lang, ...metrics }, null, 1));
  printReport(metrics, recs, ids);
  console.log(`\nChỉ số: ${path.join(outDir, 'metrics.json')}. Chữ nhận dạng nằm ở ${file}: xem xong thì xoá: node asr-bench.mjs --clean ${name}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main());

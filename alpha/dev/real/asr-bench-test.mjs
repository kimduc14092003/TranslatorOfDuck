// Kiểm tra asr-bench.mjs: bốn dịch vụ giả (DashScope, ElevenLabs, Gemini, Azure) trên máy, trả đúng dạng trong tài liệu chính
// thức (link ở từng adapter của asr-bench.mjs). Không cần key, không gọi dịch vụ thật; cần ffmpeg (gói ffmpeg-static của
// alpha/server). Mọi key và địa chỉ dịch vụ đều đặt rõ (key giả, địa chỉ giả) nên .env không chen vào được; vẫn nên chạy trên
// bản sao không có alpha/server/.env.   Chạy: node alpha/dev/real/asr-bench-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { BENCH_ROOT, attachWords, callProvider, computeMetrics, enabledProviders, parseChunkName, scriptOf, langScript, cer } from './asr-bench.mjs';
import { SERVER_DIR } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
const ok = (name) => { passed++; console.log('ok', name); };

// ---------------------------------------------------------------- dịch vụ giả
const T = '大家好，今天我们去吃火锅。';
const W = ['大家', '好', '今天', '我们', '去', '吃', '火锅'];
const T3 = '我不知道你在说什么。';
const W3 = ['我', '不知道', '你', '在', '说', '什么'];
const times = (ws, from = 0.1, d = 0.3) => ws.map((w, i) => ({ w, s: +(from + i * d).toFixed(3), e: +(from + (i + 1) * d).toFixed(3) }));
const count = {};            // dịch vụ → số request (kể cả gọi lại)
const once = {};             // dịch vụ → hàng lỗi cho các request kế tiếp: '500' | '429' | 'hang' | null (trả bình thường)
const seen = {};             // dịch vụ → request cuối (để kiểm tra dạng gửi lên)
const hung = [];
let t3At = null;             // số thứ tự request qwen-audio-3.1-asr-flash trả câu khác (đoạn chênh nhau)
const bump = (k) => (count[k] = (count[k] || 0) + 1);
const next = (k) => (once[k] && once[k].length ? once[k].shift() : null);
function serve(handler) {
  const s = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const json = (o, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(o)); };
      const form = () => new Response(body, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      try { await handler({ req, res, body, json, form, base: `http://127.0.0.1:${s.address().port}` }); } catch (e) { json({ error: String(e) }, 599); }
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}
// Lỗi giả chung: 500, 429, hay treo (không trả lời).
const fail = (k, x) => {
  const f = next(k);
  if (f === 'hang') { hung.push(x.res); return true; }
  if (f === '500') { x.json({ message: 'internal error' }, 500); return true; }
  if (f === '429') { x.json({ message: 'rate limited' }, 429); return true; }
  if (f === '400') { x.json({ message: 'bad request ' + 'x'.repeat(500) + ' END' }, 400); return true; }
  return false;
};

// DashScope: multimodal-generation đồng bộ; dạng Fun-ASR flash / qwen-audio (output.sentence) và qwen3-asr-flash (choices).
const dashscope = await serve(async (x) => {
  assert.equal(x.req.url, '/api/v1/services/aigc/multimodal-generation/generation');
  assert.match(x.req.headers.authorization, /^Bearer test-/);
  assert.equal(x.req.headers['x-dashscope-sse'], 'disable');
  const b = JSON.parse(x.body);
  const k = 'ds:' + b.model;
  const n = bump(k);
  seen[k] = b;
  if (fail(k, x)) return;
  if (/^qwen3-asr-flash/.test(b.model)) {
    assert.match(b.input.messages[0].content[0].audio, /^data:audio\/mpeg;base64,/);
    return x.json({ output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ text: T }], annotations: [{ language: 'zh', type: 'audio_info', emotion: 'neutral' }] } }] }, usage: { seconds: 3 }, request_id: 't' });
  }
  assert.match(b.input.messages[0].content[0].input_audio.data, /^data:audio\/mp3;base64,/);
  const [text, ws] = b.model === 'qwen-audio-3.1-asr-flash' && n === t3At ? [T3, W3] : [T, W];
  const words = times(ws).map(({ w, s, e }, i) => ({ text: w, begin_time: Math.round(s * 1000), end_time: Math.round(e * 1000), punctuation: i === ws.length - 1 ? '。' : i === 1 && text === T ? '，' : '' }));
  return x.json({ output: { sentence: { begin_time: 100, end_time: words[words.length - 1].end_time, text, words }, text }, request_id: 't' });
});
// ElevenLabs: POST /v1/speech-to-text multipart; words[] gồm word/spacing, start/end giây; language_code, language_probability.
const eleven = await serve(async (x) => {
  assert.equal(x.req.url, '/v1/speech-to-text');
  assert.equal(x.req.headers['xi-api-key'], 'test-eleven');
  const f = await x.form();
  seen.eleven = { model_id: f.get('model_id'), timestamps_granularity: f.get('timestamps_granularity'), tag_audio_events: f.get('tag_audio_events'), file: f.get('file') };
  bump('eleven');
  if (fail('eleven', x)) return;
  const words = times(W).map(({ w, s, e }, i) => ({ text: w + (i === 1 ? '，' : i === W.length - 1 ? '。' : ''), start: s, end: e, type: 'word', logprob: -0.1, speaker_id: null }));
  return x.json({ language_code: 'cmn', language_probability: 0.97, text: T, words, transcription_id: 't' });
});
// Gemini: Files API (resumable: start → x-goog-upload-url → upload, finalize), rồi POST /v1beta/interactions, rồi DELETE file.
const gemini = await serve(async (x) => {
  const u = x.req.url;
  assert.equal(x.req.headers['x-goog-api-key'] ?? 'none', u.startsWith('/upload-target/') ? 'none' : 'test-gemini');
  if (u === '/upload/v1beta/files') {
    assert.equal(x.req.headers['x-goog-upload-protocol'], 'resumable');
    assert.equal(x.req.headers['x-goog-upload-command'], 'start');
    assert.equal(x.req.headers['x-goog-upload-header-content-type'], 'audio/mp3');
    const n = bump('gem:upload');
    res(x, 200, { 'x-goog-upload-url': `${x.base}/upload-target/${n}` });
    return;
  }
  if (u.startsWith('/upload-target/')) {
    assert.equal(x.req.headers['x-goog-upload-command'], 'upload, finalize');
    const id = u.split('/').pop();
    return x.json({ file: { name: 'files/f' + id, uri: `${x.base}/v1beta/files/f${id}`, mimeType: 'audio/mp3', state: 'ACTIVE' } });
  }
  if (x.req.method === 'DELETE' && u.startsWith('/v1beta/files/')) { bump('gem:delete'); return x.json({}); }
  assert.equal(u, '/v1beta/interactions');
  const b = JSON.parse(x.body);
  // Như dịch vụ thật (lượt đo 4/11): mục input kiểu "file" bị từ chối; chỉ nhận "audio" có data hay uri, kèm mime_type.
  const it = b.input && b.input[0];
  if (!it || it.type !== 'audio') return x.json({ error: { code: 400, message: `The value '${it && it.type}' is not supported for 'type' at 'input[0]'. Supported values: 'audio', 'code_execution_call', 'code_execution_result', 'document', 'file_search_call', 'file_search_result', 'function_call', 'function_result', 'image', 'text', 'video'.`, status: 'INVALID_ARGUMENT' } }, 400);
  assert.equal(it.mime_type, 'audio/mp3');
  assert.ok(typeof it.data === 'string' ? !('uri' in it) : /\/v1beta\/files\/f\d+$/.test(it.uri));
  seen.gemini = b;
  bump('gemini');
  if (fail('gemini', x)) return;
  const annotations = times(W).map(({ w, s, e }) => ({ type: 'word_info', text: w, speaker: 'spk_1', start_offset: s.toFixed(3) + 's', end_offset: e.toFixed(3) + 's' }));
  return x.json({ id: 'interactions/t', status: 'completed', steps: [{ id: 's1', type: 'model_output', content: [{ type: 'text', text: T, annotations }] }] });
});
function res(x, status, headers) { x.res.writeHead(status, headers); x.res.end(); }
// Azure (MAI-Transcribe-2): POST /speechtotext/transcriptions:transcribe?api-version=2025-10-15, multipart audio + definition;
// trả combinedPhrases, phrases[] với offsetMilliseconds/durationMilliseconds, locale, words[]. Một từ dài 3 s (từ kéo dài).
const azure = await serve(async (x) => {
  assert.equal(x.req.url, '/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
  assert.equal(x.req.headers['ocp-apim-subscription-key'], 'test-azure');
  const f = await x.form();
  seen.azure = { definition: JSON.parse(f.get('definition')), audio: f.get('audio') };
  bump('azure');
  if (fail('azure', x)) return;
  const words = times(W).map(({ w, s, e }, i) => ({ text: w + (i === 1 ? '，' : i === W.length - 1 ? '。' : ''), offsetMilliseconds: Math.round(s * 1000), durationMilliseconds: i === 0 ? 3000 : Math.round((e - s) * 1000) }));
  return x.json({ durationMilliseconds: 4000, combinedPhrases: [{ text: T }], phrases: [{ offsetMilliseconds: 100, durationMilliseconds: 2100, text: T, words, locale: 'zh-CN', confidence: 0.9 }] });
});
const url = (s) => `http://127.0.0.1:${s.address().port}`;
const ENV = {
  DASHSCOPE_API_KEY: 'test-dashscope', DASHSCOPE_BASE: url(dashscope),
  ELEVENLABS_API_KEY: 'test-eleven', ELEVENLABS_BASE: url(eleven),
  GEMINI_API_KEY: 'test-gemini', GEMINI_BASE: url(gemini) + '/v1beta',
  AZURE_SPEECH_KEY: 'test-azure', AZURE_SPEECH_REGION: 'southeastasia', AZURE_SPEECH_BASE: url(azure),
};

// ---------------------------------------------------------------- 1. adapter ra đúng dạng của pipeline
{
  const env = { ...ENV, ASR_BENCH_DASHSCOPE_MODELS: 'fun-asr-flash-2026-06-15,qwen3-asr-flash,qwen-audio-3.1-asr-flash,fun-asr,qwen3-asr-flash-filetrans,fun-asr-realtime' };
  const { enabled, notCalled, skipped } = enabledProviders(env);
  assert.deepEqual(enabled.map((p) => p.id), ['fun-asr-flash-2026-06-15', 'qwen3-asr-flash', 'qwen-audio-3.1-asr-flash', 'elevenlabs', 'gemini', 'azure']);
  assert.deepEqual(notCalled.map((p) => p.id), ['fun-asr', 'qwen3-asr-flash-filetrans', 'fun-asr-realtime']);
  assert.match(notCalled[0].note, /bất đồng bộ/);
  assert.match(notCalled[2].note, /WebSocket/);
  assert.deepEqual(skipped, []);
  const mp3 = Buffer.from('fake mp3 bytes');
  const opts = { env, timeoutMs: 3000, retryWaitMs: 20 };
  const r = Object.fromEntries(await Promise.all(enabled.map(async (p) => [p.id, await callProvider(p, mp3, opts)])));
  for (const [id, x] of Object.entries(r)) {
    assert.equal(x.ok, true, id + ': ' + x.error);
    assert.equal(typeof x.text, 'string');
    assert.ok(Array.isArray(x.segments) && Array.isArray(x.words), id);
    for (const w of x.words) assert.ok(typeof w.text === 'string' && w.end > w.start, id);
    for (const s of x.segments) assert.ok(typeof s.text === 'string' && s.end >= s.start, id);
    assert.equal(x.retries, 0);
  }
  // Từ mang dấu câu của nó, nối lại ra toàn văn (như Fun-ASR).
  for (const id of ['fun-asr-flash-2026-06-15', 'qwen-audio-3.1-asr-flash', 'elevenlabs', 'gemini', 'azure']) {
    assert.equal(r[id].text, T, id);
    assert.equal(r[id].words.map((w) => w.text).join(''), T, id);
    assert.equal(r[id].words[1].text, '好，', id);
    assert.ok(r[id].segments.length >= 1, id);
  }
  assert.deepEqual(r.gemini.words[0], { text: '大家', start: 0.1, end: 0.4 });
  assert.ok(Math.abs(r.azure.words[0].end - r.azure.words[0].start - 3) < 1e-9);
  assert.deepEqual(r['fun-asr-flash-2026-06-15'].segments, [{ start: 0.1, end: 2.2, text: T }]);
  // qwen3-asr-flash: có chữ và ngôn ngữ, không có mốc (đúng tài liệu).
  assert.equal(r['qwen3-asr-flash'].text, T);
  assert.equal(r['qwen3-asr-flash'].lang, 'zh');
  assert.deepEqual(r['qwen3-asr-flash'].words, []);
  assert.equal(r.elevenlabs.lang, 'cmn');
  assert.equal(r.elevenlabs.langProb, 0.97);
  assert.equal(r.azure.lang, 'zh-CN');
  assert.equal(r.gemini.lang, undefined);
  assert.equal(r.gemini.uploadMs, undefined);
  // Dạng gửi lên.
  assert.deepEqual(seen['ds:fun-asr-flash-2026-06-15'].parameters, { format: 'mp3', sample_rate: '16000' });
  assert.deepEqual(seen['ds:qwen3-asr-flash'].parameters, { asr_options: { enable_itn: true } });
  assert.deepEqual([seen.eleven.model_id, seen.eleven.timestamps_granularity, seen.eleven.tag_audio_events], ['scribe_v2', 'word', 'false']);
  assert.equal(Buffer.from(await seen.eleven.file.arrayBuffer()).toString(), 'fake mp3 bytes');
  assert.equal(seen.gemini.model, 'models/gemini-3.5-transcribe');
  assert.deepEqual(seen.gemini.input, [{ type: 'audio', data: Buffer.from('fake mp3 bytes').toString('base64'), mime_type: 'audio/mp3' }]);   // gửi thẳng, không tải lên
  assert.equal(count['gem:upload'], undefined);
  assert.deepEqual(seen.gemini.generation_config.transcription_config, { language_codes: [], mode: { type: 'verbatim', timestamp_granularities: ['word'] } });
  assert.deepEqual(seen.azure.definition, { enhancedMode: { enabled: true, model: 'MAI-Transcribe-2', modelOptions: { timestamps: 'word' } } });
  await new Promise((r2) => setTimeout(r2, 100));
  // --gemini-upload: tải lên Files API, gửi uri, rồi xoá file.
  const g = await callProvider(enabled.find((p) => p.id === 'gemini'), mp3, { ...opts, geminiUpload: true });
  assert.deepEqual([g.ok, g.text, g.words.length], [true, T, W.length]);
  assert.ok(g.uploadMs >= 0);
  assert.match(seen.gemini.input[0].uri, /\/v1beta\/files\/f1$/);
  assert.equal(count['gem:upload'], 1);
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(count['gem:delete'], 1);   // file tải lên đã xoá
  // Dạng cũ (type "file") bị từ chối với 400, và lỗi được giữ đủ câu.
  const old = await fetch(ENV.GEMINI_BASE + '/interactions', { method: 'POST', headers: { 'x-goog-api-key': 'test-gemini', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'models/gemini-3.5-transcribe', input: [{ type: 'file', file_uri: 'x' }] }) });
  assert.equal(old.status, 400);
  // Gợi ý ngôn ngữ đi đúng chỗ của từng dịch vụ.
  const zh = { ...opts, lang: 'zh' };
  await callProvider(enabled[0], mp3, zh); await callProvider(enabled[1], mp3, zh); await callProvider(enabled[4], mp3, zh); await callProvider(enabled[5], mp3, zh);
  assert.deepEqual(seen['ds:fun-asr-flash-2026-06-15'].parameters.language_hints, ['zh']);
  assert.deepEqual(seen['ds:qwen3-asr-flash'].parameters.asr_options, { enable_itn: true, language: 'zh' });
  assert.deepEqual(seen.gemini.generation_config.transcription_config.language_codes, ['cmn-Hans-CN']);
  assert.deepEqual(seen.azure.definition.locales, ['zh']);
  // Chữ Latin: từ kèm dấu câu và dấu cách sau nó.
  const en = attachWords('Hello world! How are you?', ['Hello', 'world', 'How', 'are', 'you'].map((t, i) => ({ text: t, start: i, end: i + 0.5 })));
  assert.deepEqual(en.map((w) => w.text), ['Hello ', 'world! ', 'How ', 'are ', 'you?']);
  ok('adapter của mọi dịch vụ ra dạng { provider, model, text, segments, words, lang? }');
}

// ---------------------------------------------------------------- 2. thiếu key thì bỏ qua
{
  const e = enabledProviders({ GEMINI_API_KEY: 'x', DASHSCOPE_API_KEY: 'y', AZURE_SPEECH_KEY: 'z', AZURE_SPEECH_REGION: '  ', ELEVENLABS_API_KEY: '' });
  assert.deepEqual(e.enabled.map((p) => p.id), ['qwen3-asr-flash', 'qwen-audio-3.1-asr-flash', 'gemini']);
  assert.deepEqual(e.notCalled.map((p) => p.id), ['fun-asr']);
  assert.deepEqual(e.skipped, [{ id: 'elevenlabs', missing: ['ELEVENLABS_API_KEY'] }, { id: 'azure', missing: ['AZURE_SPEECH_REGION'] }]);
  const none = enabledProviders({});
  assert.equal(none.enabled.length, 0);
  assert.equal(none.skipped.length, 6);
  assert.deepEqual(enabledProviders({ GEMINI_API_KEY: 'x', DASHSCOPE_API_KEY: 'y' }, ['dashscope']).enabled.map((p) => p.id), ['qwen3-asr-flash', 'qwen-audio-3.1-asr-flash']);
  ok('thiếu key (hay key rỗng) thì bỏ qua dịch vụ, chỉ báo tên biến');
}

// ---------------------------------------------------------------- 3. lỗi, gọi lại một lần, quá hạn
{
  const { enabled } = enabledProviders(ENV);
  const by = Object.fromEntries(enabled.map((p) => [p.id, p]));
  const opts = { env: ENV, timeoutMs: 600, retryWaitMs: 20 };
  const mp3 = Buffer.from('x');
  once.eleven = ['500', '500'];
  const e1 = await callProvider(by.elevenlabs, mp3, opts);
  assert.deepEqual([e1.ok, e1.kind, e1.status, e1.retries], [false, 'http', 500, 1]);
  assert.doesNotMatch(e1.error, /test-eleven/);
  once['ds:qwen3-asr-flash'] = ['429'];
  const e2 = await callProvider(by['qwen3-asr-flash'], mp3, opts);
  assert.deepEqual([e2.ok, e2.retries, e2.text], [true, 1, T]);
  once.gemini = ['500'];
  const e3 = await callProvider(by.gemini, mp3, opts);
  assert.deepEqual([e3.ok, e3.retries], [true, 1]);
  once.azure = ['hang'];
  const t0 = Date.now();
  const e4 = await callProvider(by.azure, mp3, opts);
  assert.deepEqual([e4.ok, e4.kind, e4.retries], [false, 'timeout', 0]);
  assert.ok(Date.now() - t0 < 3000);
  const before = count.azure;
  once.azure = ['400'];
  const bad = await callProvider(by.azure, mp3, opts);
  assert.deepEqual([bad.ok, bad.kind, bad.status, bad.retries], [false, 'http', 400, 0]);
  assert.match(bad.error, / END"\}$/);   // lỗi giữ đủ câu, không cắt
  assert.equal(count.azure, before + 1);
  ok('5xx/429 gọi lại đúng một lần, quá hạn và 4xx không gọi lại, lỗi không chứa key');
}

// ---------------------------------------------------------------- 4. chỉ số
{
  assert.equal(scriptOf('大家好'), 'Han');
  assert.equal(scriptOf('こんにちは世界'), 'Japanese');
  assert.equal(scriptOf('Hello 你'), 'Latin');
  assert.equal(langScript('zh-CN'), 'Han');
  assert.equal(langScript('cmn'), 'Han');
  assert.equal(langScript('en'), 'Latin');
  assert.equal(cer('大家好', '大家, 好!'), 0);
  assert.equal(cer('ＡＢＣ', 'abc'), 0);
  assert.equal(cer('大家好', '大好'), 1 / 3);
  const res2 = (o) => ({ ok: true, retries: 0, segments: [], words: [], ...o });
  const recs = [
    { key: 'k1', id: '7000000000000000001', from: 0, to: 10, audioStart: 0, seconds: 10, results: {
      A: res2({ ms: 100, text: '大家好。', words: [{ text: '大家', start: 0, end: 0.3 }, { text: '好。', start: 0.3, end: 3 }] }),
      B: res2({ ms: 300, text: '大家好', lang: 'en' }) } },
    { key: 'k2', id: '7000000000000000001', from: 10, to: 20, audioStart: 8, seconds: 12, results: {
      A: res2({ ms: 200, text: '你好' }),
      B: { ok: false, ms: 50, retries: 1, error: 'HTTP 500: x', kind: 'http', status: 500 } } },
    { key: 'k3', id: '7000000000000000002', from: 0, to: 10, audioStart: 0, seconds: 10, results: {
      A: res2({ ms: 400, text: '大家好' }), B: res2({ ms: 500, text: '再见', lang: 'zh' }) } },
    { key: 'k4', id: '7000000000000000002', from: 10, to: 20, audioStart: 10, seconds: 10, results: {
      A: res2({ ms: 100, text: '' }), B: res2({ ms: 100, text: '嗯好的' }) } },
    { key: 'k5', noAudio: true, results: {} },
  ];
  const m = computeMetrics(recs, ['A', 'B'], 10);
  assert.equal(m.chunks, 4);
  assert.equal(m.noAudio, 1);
  const A = m.providers.A, B = m.providers.B;
  assert.deepEqual([A.calls, A.ok, A.errors, B.ok, B.errors, B.retries], [4, 4, 0, 3, 1, 1]);
  assert.deepEqual(B.errorKinds, { 'HTTP 500': 1 });
  assert.deepEqual(A.latencyMs, { p50: 100, p95: 400, n: 4 });
  assert.equal(A.nonEmpty, 3);
  assert.equal(A.punctuatedPct, 33);
  assert.equal(A.wordTimesPct, 33);
  assert.equal(A.stretchedWords, 1);
  assert.equal(A.chunksWithStretchedPct, 33);
  assert.equal(A.medianWordS, 0.3);   // [0.3, 2.7]: lấy giá trị dưới
  assert.equal(A.emptyWhenOthersSpoke, 1);
  assert.deepEqual(B.lang, { reported: 2, match: 1, matchPct: 50 });
  assert.deepEqual(A.lang, { reported: 0, match: 0, matchPct: null });
  assert.equal(B.scriptMatchPct, 100);
  assert.deepEqual(A.cerVs.B, { mean: 0.75, n: 2 });   // k1: 0, k3: 3/2; k4 A trống: tính ở emptyWhenOthersSpoke
  assert.deepEqual(m.disagreements.map((d) => d.key), ['k3', 'k4']);
  assert.equal(m.disagreements[0].score, 1);
  assert.deepEqual(m.expectedScript, { Han: 4 });
  ok('chỉ số: ok/lỗi, độ trễ, dấu câu, mốc từ, từ kéo dài, ngôn ngữ, CER từng cặp, đoạn chênh nhau');
}

// ---------------------------------------------------------------- 5. chạy cả lệnh trên thư mục lượt đo
{
  const req = createRequire(path.join(SERVER_DIR, 'package.json'));
  const ffmpeg = process.env.FFMPEG || (() => { try { return req('ffmpeg-static'); } catch (_) { return 'ffmpeg'; } })();
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-asrbench-'));
  const dump = path.join(TMP, 'run1', '7311111111111111111-1', 'server', 'dump');
  fs.mkdirSync(dump, { recursive: true });
  const mk = (name, hz) => execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=3`, '-c:a', 'aac', '-f', 'adts', path.join(dump, name)]);
  mk('7311111111111111111.0-10.vi.alpha-8.at0.aac', 300);
  mk('7311111111111111111.10-20.vi.alpha-8.at8.5.aac', 500);
  mk('7311111111111111111.q20-30.vi.lyr.alpha-8.at18.aac', 700);
  fs.copyFileSync(path.join(dump, '7311111111111111111.10-20.vi.alpha-8.at8.5.aac'), path.join(dump, '7311111111111111111.10-20.en.alpha-8.at8.5.aac'));   // trùng âm thanh
  assert.deepEqual(parseChunkName('7311111111111111111.q20-30.vi.lyr.alpha-8.at18.aac'),
    { file: '7311111111111111111.q20-30.vi.lyr.alpha-8.at18.aac', id: '7311111111111111111', quick: true, from: 20, to: 30, kind: 'vi.lyr.alpha-8', audioStart: 18 });
  const name = `test-${process.pid}`;
  const outDir = path.join(BENCH_ROOT, name);
  const run = (extra, env = {}) => new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, 'asr-bench.mjs'), path.join(TMP, 'run1'), '--name', name, '--timeout', '1500', '--retry-wait', '20', ...extra],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, ...ENV, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
  const snap = () => ({ ...count });
  const diff = (a, b) => Object.fromEntries(Object.keys(b).filter((k) => (b[k] || 0) !== (a[k] || 0)).map((k) => [k, b[k] - (a[k] || 0)]));

  // Không có --go: chỉ in kế hoạch, không gọi gì.
  let c0 = snap();
  let r = await run([]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /3 đoạn, dịch vụ: qwen3-asr-flash, qwen-audio-3.1-asr-flash, elevenlabs, gemini, azure, tự nhận ngôn ngữ; cần 15 lần gọi/);
  assert.match(r.out, /không gọi fun-asr: chỉ bất đồng bộ/);
  assert.match(r.out, /thêm --go/);
  assert.deepEqual(diff(c0, snap()), {});
  assert.ok(!fs.existsSync(outDir));
  // Thiếu vùng Azure: bỏ qua, chỉ báo tên biến.
  r = await run([], { AZURE_SPEECH_REGION: '' });
  assert.match(r.out, /bỏ qua azure: thiếu AZURE_SPEECH_REGION/);
  assert.match(r.out, /cần 12 lần gọi/);

  // Chạy thật (với dịch vụ giả): ElevenLabs lỗi 500 hai lần ở đoạn 2, Azure treo ở đoạn 1, Gemini 429 một lần.
  once.eleven = [null, '500', '500'];
  once.azure = ['hang'];
  once.gemini = ['429'];
  t3At = (count['ds:qwen-audio-3.1-asr-flash'] || 0) + 3;
  c0 = snap();
  r = await run(['--go']);
  assert.equal(r.code, 0, r.out);
  const d1 = diff(c0, snap());
  assert.deepEqual([d1['ds:qwen3-asr-flash'], d1['ds:qwen-audio-3.1-asr-flash'], d1.eleven, d1.gemini, d1.azure, d1['gem:upload']], [3, 3, 4, 4, 3, undefined]);
  assert.equal(d1['ds:fun-asr'], undefined);
  const m = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
  const P = m.providers;
  assert.deepEqual(Object.keys(P), ['qwen3-asr-flash', 'qwen-audio-3.1-asr-flash', 'elevenlabs', 'gemini', 'azure']);
  assert.deepEqual([P.elevenlabs.ok, P.elevenlabs.errors, P.elevenlabs.retries, P.elevenlabs.errorKinds], [2, 1, 1, { 'HTTP 500': 1 }]);
  assert.deepEqual([P.azure.ok, P.azure.errors, P.azure.errorKinds], [2, 1, { timeout: 1 }]);
  assert.deepEqual([P.gemini.ok, P.gemini.retries], [3, 1]);
  assert.equal(P['qwen3-asr-flash'].wordTimesPct, 0);
  assert.deepEqual(P['qwen3-asr-flash'].lang, { reported: 3, match: 3, matchPct: 100 });
  assert.equal(P['qwen-audio-3.1-asr-flash'].wordTimesPct, 100);
  assert.equal(P.azure.stretchedWords, 2);
  assert.ok(P.azure.latencyMs.p50 != null && P.azure.latencyMs.n === 2);
  assert.equal(m.notCalled[0].id, 'fun-asr');
  assert.match(m.notes['qwen3-asr-flash'], /không có mốc từ/);
  assert.equal(m.notes.gemini, undefined);   // mặc định gửi base64 thẳng, không ghi chú tải lên
  assert.equal(m.disagreements[0].from, 20);
  assert.equal(m.disagreements[0].audioStart, 18);
  assert.equal(m.chunks, 3);
  assert.ok(!JSON.stringify(m).includes(T.slice(0, 4)), 'metrics.json không chứa chữ nhận dạng');
  // Bảng tiếng Việt và danh sách đoạn chênh nhau (chỉ chỗ này in chữ).
  assert.match(r.out, /dịch vụ\s+\| đoạn ok \| lỗi/);
  assert.match(r.out, /CER từng cặp/);
  assert.match(r.out, /#1 7311111111111111111 20–30 s \(âm thanh từ 18 s/);
  assert.match(r.out, /qwen-audio-3.1-asr-flash\s+我不知道你在说什么。/);
  assert.match(r.out, /elevenlabs lỗi: 1 HTTP 500/);
  assert.match(r.out, /azure lỗi: 1 quá hạn/);
  assert.match(r.out, /fun-asr: chỉ bất đồng bộ/);
  for (const v of Object.values(ENV).filter((v) => v.startsWith('test-'))) assert.ok(!r.out.includes(v), 'không in key');
  assert.ok(fs.readFileSync(path.join(outDir, 'chunks.jsonl'), 'utf8').includes(T), 'chữ nhận dạng chỉ ở work/asr-bench');
  assert.ok(outDir.startsWith(path.join(SERVER_DIR, 'work') + path.sep));

  // Chạy lại: dùng lại chỗ ok, chỉ gọi lại hai chỗ lỗi.
  c0 = snap();
  r = await run(['--go']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /cần 2 lần gọi/);
  assert.deepEqual(diff(c0, snap()), { eleven: 1, azure: 1 });
  const m2 = JSON.parse(fs.readFileSync(path.join(outDir, 'metrics.json'), 'utf8'));
  assert.deepEqual([m2.providers.elevenlabs.ok, m2.providers.azure.ok, m2.providers.azure.errors], [3, 3, 0]);

  // --clean xoá kết quả.
  r = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, 'asr-bench.mjs'), '--clean', name], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out }));
  });
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(outDir));
  fs.rmSync(TMP, { recursive: true, force: true });
  ok('cả lệnh: kế hoạch không --go, gọi thật, đếm lỗi và quá hạn, dùng lại kết quả, --clean');
}

for (const r of hung) r.destroy();
for (const s of [dashscope, eleven, gemini, azure]) { s.closeAllConnections(); s.close(); }
console.log(`\n${passed}/5 nhóm kiểm tra đạt`);

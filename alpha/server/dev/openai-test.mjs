// Kiểm tra dịch bằng OpenAI (có OPENAI_API_KEY thì server dùng OpenAI thay Gemini). Không cần key, không cần mạng;
// cần ffmpeg. Server thật + dịch vụ AI giả.   Chạy: node dev/openai-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-openai-'));
const aac = (sec) => { const f = path.join(TMP, `${sec}.aac`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', f]); return fs.readFileSync(f).toString('base64'); };

const openaiBodies = [];
let geminiCalls = 0, asrCalls = 0;
let mode = 'ok';                   // 'ok' | 'rate' (429 theo phút, lần đầu) | 'quota' (hết tiền)
let rateHits = 0;
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o, status = 200, h = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      asrCalls++;
      const words = [['大家', 1000, 1400], ['好', 1400, 1600, '，'], ['今天', 1700, 2000], ['我们', 2000, 2300], ['去', 2300, 2450], ['吃', 2450, 2600], ['火锅', 2600, 3100, '。']]
        .map(([text, b, e, p]) => ({ text, begin_time: b, end_time: e, punctuation: p || '' }));
      return json({ output: { sentence: { begin_time: 1000, end_time: 3100, text: '大家好，今天我们去吃火锅。', words }, text: '大家好，今天我们去吃火锅。' } });
    }
    if (req.url.includes(':generateContent')) { geminiCalls++; return json({}, 500); }
    if (req.url.endsWith('/v1/chat/completions')) {
      const b = JSON.parse(body);
      openaiBodies.push(b);
      if (req.headers.authorization !== 'Bearer test-openai') return json({ error: { message: 'bad key' } }, 401);
      if (mode === 'quota') return json({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, 429);
      if (mode === 'rate' && rateHits++ === 0) return json({ error: { message: 'Rate limit reached', type: 'requests', code: 'rate_limit_exceeded' } }, 429, { 'retry-after-ms': '300' });
      const lines = JSON.parse(b.messages[0].content.match(/Các dòng: (.*)$/m)[1]);
      const content = JSON.stringify({ cues: lines.map(l => ({ id: l.id, vi: 'Chào cả nhà, hôm nay đi ăn lẩu.' })) });
      return json({ choices: [{ message: { role: 'assistant', content } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
const port = 20787 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), TOD_WORK: path.join(TMP, 'work'), FFMPEG: ffmpeg,
    DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: 'test', OPENAI_API_KEY: 'test-openai',
    DASHSCOPE_BASE: PROV, GEMINI_BASE: PROV + '/v1beta', OPENAI_BASE: PROV + '/v1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));

const audio = aac(22);
const post = (from) => fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: '7500000000000000077', from, to: from + 30, audioStart: from, urgent: true, aac: audio }) }).then(r => r.json());
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
try {
  const health = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
  t('có OPENAI_API_KEY: server dịch bằng OpenAI', () => { assert.equal(health.mt, 'openai'); });
  const a = await post(0);
  t('dịch bằng OpenAI ra sub, không gọi Gemini', () => {
    assert.equal(a.status, 'ok', JSON.stringify(a));
    assert.equal(a.cues[0].vi, 'Chào cả nhà, hôm nay đi ăn lẩu.');
    assert.equal(geminiCalls, 0);
  });
  t('gửi OpenAI JSON Schema chặt (strict, không thêm trường)', () => {
    const rf = openaiBodies[0].response_format;
    assert.equal(rf.type, 'json_schema'); assert.equal(rf.json_schema.strict, true);
    assert.equal(rf.json_schema.schema.type, 'object'); assert.equal(rf.json_schema.schema.additionalProperties, false);
    assert.equal(rf.json_schema.schema.properties.cues.items.properties.id.type, 'integer');
  });
  mode = 'rate';
  const t0 = Date.now();
  const b = await post(30);
  t('OpenAI báo 429 theo phút: chờ theo retry-after-ms rồi gọi lại', () => {
    assert.equal(b.status, 'ok', JSON.stringify(b));
    assert.ok(Date.now() - t0 < 5000, 'mất ' + (Date.now() - t0) + ' ms');
  });
  mode = 'quota';
  const c = await post(60);
  const asrBefore = asrCalls, calls = openaiBodies.length;
  const d = await post(90);
  t('OpenAI hết tiền (insufficient_quota): báo lỗi ngay, tạm không gọi', () => {
    assert.equal(c.status, 'error'); assert.match(c.error, /OpenAI hết hạn mức/);
    assert.equal(d.status, 'error'); assert.ok(d.retryAfterMs > 60000, JSON.stringify(d));
    assert.equal(asrCalls, asrBefore); assert.equal(openaiBodies.length, calls);
  });
} finally {
  server.kill(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

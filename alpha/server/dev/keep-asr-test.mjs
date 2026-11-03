// TOD_KEEP_ASR=1 (server đo của alpha/dev/real): giữ file nhận dạng của đoạn đã dịch xong, kèm vị trí âm thanh trong video,
// để chạy lại offline bước chia câu, chia đoạn, ghép sub. Không đặt thì như cũ: đoạn không có câu hát xoá file nhận dạng.
// Không cần key, không cần mạng; cần ffmpeg. Server thật + dịch vụ AI giả.   Chạy: node dev/keep-asr-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-keepasr-'));
const aac = (sec) => { const f = path.join(TMP, `${sec}.aac`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', f]); return fs.readFileSync(f).toString('base64'); };
const words = Array.from('大家好今天我们去吃火锅').map((c, i, a) => ({ text: c, begin_time: 3000 + i * 200, end_time: 3180 + i * 200, punctuation: i === a.length - 1 ? '。' : '' }));
const sentence = { begin_time: words[0].begin_time, end_time: words.at(-1).end_time, text: '大家好今天我们去吃火锅。', words };

let asrCalls = 0;
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) { asrCalls++; return json({ output: { sentence, text: sentence.text } }); }
    if (req.url.endsWith('/v1/chat/completions')) {
      const lines = JSON.parse(JSON.parse(body).messages[0].content.match(/^Các dòng: (.*)$/m)[1]);
      return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ pronouns: { pairs: [] }, cues: lines.map(l => ({ id: l.id, vi: 'Chào cả nhà, hôm nay đi ăn lẩu.' })) }) } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;

async function startServer(name, extraEnv) {
  const port = 23787 + Math.floor(Math.random() * 1000);
  const work = path.join(TMP, name);
  const child = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), TOD_WORK: work, FFMPEG: ffmpeg, DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '', OPENAI_API_KEY: 'test-openai',
      OPENAI_MODEL: 'test-model', DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1', FUNASR_MODEL: 'fun-asr-flash-2026-06-15', TOD_KEEP_ASR: '', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));
  const post = (from) => fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '7500000000000000301', from, to: from + 30, audioStart: from - 1.5, urgent: true, lyrics: true, desc: '#vlog', hashtags: ['vlog'], aac: audio }) }).then(r => r.json());
  const asrFiles = () => fs.readdirSync(path.join(work, 'cache')).filter(f => f.includes('.asr.'));
  return { post, asrFiles, cache: path.join(work, 'cache'), stop: () => child.kill() };
}

const audio = aac(33);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const keep = await startServer('keep', { TOD_KEEP_ASR: '1' });
const plain = await startServer('plain', {});
try {
  const a = await keep.post(30);
  t('TOD_KEEP_ASR=1: đoạn đã dịch xong vẫn giữ file nhận dạng, kèm vị trí âm thanh trong video', () => {
    assert.equal(a.status, 'ok', JSON.stringify(a));
    const files = keep.asrFiles();
    assert.equal(files.length, 1, files.join(' '));
    const x = JSON.parse(fs.readFileSync(path.join(keep.cache, files[0]), 'utf8'));
    assert.deepEqual(x.window, { audioStart: 28.5, from: 30, to: 60, quick: false, desc: '#vlog', hashtags: ['vlog'] });
    assert.ok(Array.isArray(x.asr.words) && x.asr.words.length > 0);
  });
  const b = await plain.post(30);
  t('không đặt TOD_KEEP_ASR: như cũ, đoạn không có câu hát xoá file nhận dạng', () => {
    assert.equal(b.status, 'ok', JSON.stringify(b));
    assert.deepEqual(plain.asrFiles(), []);
  });
} finally {
  keep.stop(); plain.stop(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

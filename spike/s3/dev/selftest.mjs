// Tự kiểm bench.mjs mà không cần key thật: tạo mẫu giả (ffmpeg), dựng server giả trả về
// đúng dạng response trong tài liệu của Groq, Alibaba (Qwen3-ASR, Fun-ASR) và Gemini,
// rồi chạy prepare → asr → refs → translate → report.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = path.join(HERE, '..', 'bench.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-s3-'));
const DL = path.join(TMP, 'Downloads');
const WORK = path.join(TMP, 'work');
fs.mkdirSync(DL);

// 3 mẫu: 2 video có tiếng (bị cắt ngắn như extension lưu), 1 mẫu thiếu file.
const samples = [];
for (const h of ['aaaa0001', 'aaaa0002']) {
  const f = path.join(DL, `tod_s3_${h}.mp4`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=300',
    '-t', '40', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', f]);
  const full = fs.readFileSync(f);
  fs.writeFileSync(f, full.subarray(0, Math.floor(full.length * 0.9))); // cắt đuôi như mẫu thật
  samples.push({ h, file: `tod_s3_${h}.mp4`, durationMs: 40000, hasMp4a: true, desc: '测试视频 #日常', hashtags: ['日常'] });
}
samples.push({ h: 'aaaa0003', file: 'tod_s3_aaaa0003.mp4', durationMs: 10000, hasMp4a: true });
fs.writeFileSync(path.join(DL, 'tod_s3_manifest.json'), JSON.stringify({ kind: 'tod_s3_manifest', samples }));

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    seen.push({ url: req.url, auth: req.headers.authorization || req.headers['x-goog-api-key'] || null, ct: req.headers['content-type'] });
    if (req.url === '/groq/audio/transcriptions') {
      if (!body.includes('name="timestamp_granularities[]"') || !body.includes('verbose_json')) return json({ error: 'bad form' }, 400);
      return json({ text: '大家好，今天我们去吃火锅。', segments: [{ id: 0, start: 0.5, end: 3.2, text: '大家好，今天我们去吃火锅。', no_speech_prob: 0.01, avg_logprob: -0.2, compression_ratio: 1.1 }],
        words: [{ word: '大家', start: 0.5, end: 0.9 }, { word: '好', start: 0.9, end: 1.1 }] });
    }
    if (req.url === '/ds/compatible-mode/v1/chat/completions') {
      const b = JSON.parse(body);
      if (b.messages[0].content[0].type !== 'input_audio') return json({ error: 'bad' }, 400);
      return json({ choices: [{ message: { content: '大家好，今天我们去吃火锅。', annotations: [{ type: 'audio_info', language: 'zh', emotion: 'neutral' }] } }] });
    }
    if (req.url === '/ds/api/v1/services/aigc/multimodal-generation/generation') {
      const b = JSON.parse(body);
      if (b.parameters.format !== 'mp3' || req.headers['x-dashscope-sse'] !== 'disable') return json({ error: 'bad' }, 400);
      return json({ output: { sentence: { begin_time: 500, end_time: 3200, text: '大家好，今天我们去吃火锅。', words: [
        { begin_time: 500, end_time: 900, text: '大家', punctuation: '' }, { begin_time: 900, end_time: 1100, text: '好', punctuation: '，' }] }, text: '大家好，今天我们去吃火锅。' }, usage: { duration: 30 } });
    }
    const gm = req.url.match(/^\/gemini\/models\/([^:]+):generateContent$/);
    if (gm) {
      const b = JSON.parse(body);
      const parts = b.contents[0].parts;
      if (parts.some(p => p.inlineData)) {
        return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ segments: [{ start: 0.5, end: 3.2, text: '大家好，今天我们去吃火锅' }] }) }] } }] });
      }
      const m = parts[0].text.match(/Các dòng: (.*)$/m);
      const cues = JSON.parse(m[1]).map(c => ({ id: c.id, vi: 'Chào cả nhà, hôm nay mình đi ăn lẩu.' }));
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ cues }) }] } }] });
    }
    json({ error: 'not found ' + req.url }, 404);
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const env = { ...process.env, GROQ_API_KEY: 'g', DASHSCOPE_API_KEY: 'd', GEMINI_API_KEY: 'm',
  GROQ_BASE: base + '/groq', DASHSCOPE_BASE: base + '/ds', GEMINI_BASE: base + '/gemini', FFMPEG: 'ffmpeg' };
const run = (...a) => new Promise((resolve, reject) => {
  import('node:child_process').then(({ execFile }) => execFile(process.execPath, [BENCH, ...a, '--samples', DL, '--work', WORK], { env }, (err, stdout, stderr) => {
    if (err) reject(new Error(stderr || stdout)); else resolve(stdout);
  }));
});

console.log(await run('all')); // chạy một lần không có đáp án
console.log(fs.readFileSync(path.join(WORK, 'report.md'), 'utf8').split('\n').slice(4, 8).join('\n'));
console.log(await run('prepare'));
console.log(await run('asr'));
console.log(await run('refs'));
fs.mkdirSync(path.join(WORK, 'refs'));
fs.writeFileSync(path.join(WORK, 'refs', 'aaaa0001.txt'), '大家好，今天我们去吃火锅。\n');
fs.writeFileSync(path.join(WORK, 'refs', 'aaaa0002.txt'), '大家好，今天我们去吃烤鸭。\n');
console.log(await run('translate'));
console.log(await run('report'));

const rep = JSON.parse(fs.readFileSync(path.join(WORK, 'report.json'), 'utf8'));
const srt = path.join(WORK, 'mt', 'gemini', 'aaaa0001.vi.srt');
const checks = {
  'prepare: 2 samples, 30 s each': JSON.parse(fs.readFileSync(path.join(WORK, 'samples.json'))).map(s => s.seconds).every(x => x >= 29 && x <= 31),
  'all 5 providers ran without error': ['funasr', 'qwen3', 'gemini', 'groq-v3', 'groq-turbo'].every(n => rep[n] && rep[n].ok === 2 && rep[n].errors === 0),
  'word timestamps parsed (funasr, groq)': rep.funasr.wordTimes === 2 && rep['groq-v3'].wordTimes === 2 && rep.qwen3.wordTimes === 0,
  'CER computed (0 and ~0.17)': rep.funasr.cerN === 2 && Math.abs(rep.funasr.cerMedian - rep.funasr.cerMean) < 1e-9 && rep.funasr.cerMean > 0.05 && rep.funasr.cerMean < 0.15,
  'refs drafts written': fs.existsSync(path.join(WORK, 'refs_draft', 'INDEX.md')),
  'Vietnamese SRT written': fs.existsSync(srt) && fs.readFileSync(srt, 'utf8').includes('00:00:00,500 --> 00:00:03,200'),
  'auth headers sent': seen.every(s => s.auth),
};
console.log('\nCHECKS');
for (const [k, v] of Object.entries(checks)) console.log((v ? 'PASS ' : 'FAIL ') + k);
server.close();
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);

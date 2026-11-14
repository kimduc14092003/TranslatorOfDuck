// Ô "Dịch bằng" của popup: /health liệt kê dịch vụ có key (mts), /v1/mt đổi dịch vụ lúc server đang chạy, sub của dịch vụ
// mặc định giữ tên file cache cũ, dịch vụ khác lưu riêng (.<phiên bản>.qwen.json), đổi lại thì dùng lại cache, việc đang
// chạy giữ dịch vụ lúc nhận yêu cầu, lựa chọn còn sau khi bật lại server, dịch vụ không có key bị từ chối, origin lạ bị chặn.
// Server thật, dịch vụ giả (Fun-ASR, OpenAI, Qwen). Không cần key, không cần mạng; cần ffmpeg.   Chạy: node dev/mt-pick-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-mtpick-'));
const aacFile = path.join(TMP, 'a.aac');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'aac', aacFile]);
const AAC = fs.readFileSync(aacFile).toString('base64');

const chars = (text, at, per) => {
  const out = [];
  for (const ch of text) {
    if (/[，。？！]/.test(ch)) { out[out.length - 1].punctuation = ch; continue; }
    out.push({ text: ch, begin_time: Math.round(at * 1000), end_time: Math.round((at + per) * 1000), punctuation: '' });
    at += per;
  }
  return out;
};
const WORDS = [...chars('大家好，今天我们去吃火锅。', 0.5, 0.2), ...chars('王小明很喜欢这家店。', 3.6, 0.2)];
// Mỗi dịch vụ dịch ra chữ khác nhau để biết dòng nào do dịch vụ nào dịch.
const mtModels = [];
let mtDelay = 0, asrCalls = 0, failOpenAI = false;
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      asrCalls++;
      const sentence = { begin_time: WORDS[0].begin_time, end_time: WORDS.at(-1).end_time, text: WORDS.map(w => w.text + w.punctuation).join(''), words: WORDS };
      return json({ output: { sentence, text: sentence.text } });
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const b = JSON.parse(body);
      mtModels.push(b.model);
      if (failOpenAI && b.model === 'test-model') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'boom' } })); }
      const tag = b.model === 'test-qwen' ? 'Q' : 'O';
      const lines = JSON.parse(b.messages[0].content.match(/^Các dòng: (.*)$/m)[1]);
      const text = JSON.stringify({ pronouns: { pairs: [] }, cues: lines.map(l => ({ id: l.id, vi: `${tag} dòng ${l.id}` })) });
      return setTimeout(() => json({ choices: [{ message: { role: 'assistant', content: text } }] }), mtDelay);
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
const port = 25787 + Math.floor(Math.random() * 1000);
const WORK = path.join(TMP, 'work');
let server, log = '';
async function start() {
  log = '';
  server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), TOD_WORK: WORK, FFMPEG: ffmpeg, DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '', MT_PROVIDER: '',
      OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: '', DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1',
      QWEN_MODEL: 'test-qwen', QWEN_BASE: PROV + '/compatible-mode/v1', FUNASR_MODEL: 'fun-asr-flash-2026-06-15', MAX_PARALLEL: '1', TOD_CONDENSE: '', MT_TIMEOUT_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });
  while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));
}
const stop = () => new Promise(r => { server.once('exit', r); server.kill(); });
const URL0 = () => `http://127.0.0.1:${port}`;
const health = async () => (await fetch(URL0() + '/health')).json();
const pick = async (mt, headers = {}) => {
  const r = await fetch(URL0() + '/v1/mt', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ mt }) });
  return { status: r.status, body: await r.json() };
};
const sub = async (id, extra = {}) => (await fetch(URL0() + '/v1/subtitles', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, desc: '火锅', hashtags: [], lyrics: true, from: 0, to: 10, audioStart: 0, aac: AAC, ...extra }) })).json();
const bump = async (id) => (await fetch(URL0() + '/v1/bump', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, from: 0, to: 10, target: 'vi' }) })).json();
const cacheFiles = () => fs.readdirSync(path.join(WORK, 'cache')).filter(f => !f.includes('.asr.')).sort();
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
await start();
try {
  const V = (await health()).version;
  const h0 = await health();
  t('/health: các dịch vụ có key (OpenAI, Qwen; Gemini không key), mặc định OpenAI', () => {
    assert.deepEqual(h0.mts, [{ id: 'openai', model: 'test-model' }, { id: 'qwen', model: 'test-qwen' }]);
    assert.equal(h0.mt, 'openai');
    assert.equal(h0.mtDefault, 'openai');
  });

  const A = '7500000000000000901';
  const a1 = await sub(A);
  t('mặc định: dịch bằng OpenAI, file cache giữ tên cũ', () => {
    assert.equal(a1.status, 'ok', JSON.stringify(a1));
    assert.ok(a1.cues.every(c => c.vi.startsWith('O ')), JSON.stringify(a1.cues));
    assert.deepEqual(cacheFiles(), [`${A}.0-10.vi.lyr.${V}.json`]);
  });

  const p = await pick('qwen');
  const hq = await health();
  t('/v1/mt qwen: đổi được, /health báo qwen, lưu work/settings.json', () => {
    assert.equal(p.status, 200);
    assert.equal(p.body.mt, 'qwen');
    assert.equal(hq.mt, 'qwen');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(WORK, 'settings.json'), 'utf8')), { mt: 'qwen' });
  });

  const before = mtModels.length;
  const a2 = await sub(A);
  t('sau khi đổi sang Qwen: cùng đoạn dịch lại bằng Qwen, lưu file riêng, không ghi đè file OpenAI', () => {
    assert.equal(a2.status, 'ok', JSON.stringify(a2));
    assert.ok(a2.cues.every(c => c.vi.startsWith('Q ')), JSON.stringify(a2.cues));
    assert.ok(mtModels.slice(before).every(m => m === 'test-qwen') && mtModels.length > before);
    assert.deepEqual(cacheFiles(), [`${A}.0-10.vi.lyr.${V}.json`, `${A}.0-10.vi.lyr.${V}.qwen.json`]);
  });

  const bad = await pick('gemini');
  t('dịch vụ không có key: 400, giữ lựa chọn cũ', () => {
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'mt_unavailable');
    assert.equal(bad.body.mt, 'qwen');
  });
  const foreign = await pick('openai', { origin: 'https://evil.example' });
  t('origin lạ (trang web) không đổi được', () => assert.equal(foreign.status, 403));

  await pick('openai');
  const before2 = mtModels.length;
  const a3 = await sub(A);
  t('đổi lại OpenAI: dùng lại sub OpenAI đã lưu, không gọi dịch', () => {
    assert.equal(a3.cached, true);
    assert.ok(a3.cues.every(c => c.vi.startsWith('O ')));
    assert.equal(mtModels.length, before2);
  });

  // Đổi dịch vụ lúc một đoạn đang dịch: đoạn đó vẫn xong bằng dịch vụ lúc gửi, lưu đúng file của dịch vụ đó.
  const B = '7500000000000000902';
  mtDelay = 600;
  const before3 = mtModels.length;
  const pending = sub(B);
  await new Promise(r => setTimeout(r, 250));
  await pick('qwen');
  const b1 = await pending;
  mtDelay = 0;
  t('đổi giữa chừng: đoạn đang chạy giữ OpenAI, lưu vào file OpenAI', () => {
    assert.equal(b1.status, 'ok', JSON.stringify(b1));
    assert.ok(b1.cues.every(c => c.vi.startsWith('O ')), JSON.stringify(b1.cues));
    assert.ok(mtModels.slice(before3).every(m => m === 'test-model'), mtModels.slice(before3).join());
    assert.ok(cacheFiles().includes(`${B}.0-10.vi.lyr.${V}.json`));
    assert.ok(!cacheFiles().includes(`${B}.0-10.vi.lyr.${V}.qwen.json`));
  });

  // Hàng đợi một chỗ (MAX_PARALLEL 1): D gửi sau khi đổi sang Qwen phải chờ C (OpenAI) chạy xong, rồi được khởi chạy từ
  // phần kết thúc của C. D vẫn phải dịch bằng Qwen.
  await pick('openai');
  const C = '7500000000000000903', D = '7500000000000000904';
  mtDelay = 600;
  const pc = sub(C);
  await new Promise(r => setTimeout(r, 250));
  await pick('qwen');
  const pd = sub(D);
  const [c1, d1] = await Promise.all([pc, pd]);
  mtDelay = 0;
  t('việc xếp hàng giữ dịch vụ lúc gửi, dù được khởi chạy từ việc của dịch vụ khác', () => {
    assert.ok(c1.cues.every(c => c.vi.startsWith('O ')), JSON.stringify(c1.cues));
    assert.ok(d1.cues.every(c => c.vi.startsWith('Q ')), JSON.stringify(d1.cues));
    assert.ok(cacheFiles().includes(`${D}.0-10.vi.lyr.${V}.qwen.json`));
  });

  // Bump (video vừa thành video đang xem) tìm được việc xếp hàng gửi trước lúc đổi dịch vụ (Astra F3).
  await pick('openai');
  const G = '7500000000000000905', H = '7500000000000000906';
  mtDelay = 600;
  const pg = sub(G, { urgent: false, rank: 0 });
  await new Promise(r => setTimeout(r, 150));
  const ph = sub(H, { urgent: false, rank: 3 });
  await new Promise(r => setTimeout(r, 100));
  await pick('qwen');
  const bh = await bump(H);
  await Promise.all([pg, ph]);
  mtDelay = 0;
  t('bump tìm được việc của dịch vụ trước lúc đổi', () => { assert.equal(bh.found, true, JSON.stringify(bh)); assert.equal(bh.queued, true); });

  // Dịch bằng OpenAI lỗi, đổi sang Qwen: dùng lại kết quả nhận dạng đã lưu, không nhận dạng lại (Astra F6).
  await pick('openai');
  const K = '7500000000000000907';
  failOpenAI = true;
  const k1 = await sub(K);
  failOpenAI = false;
  await pick('qwen');
  const asrBefore = asrCalls;
  const k2 = await sub(K);
  t('đổi dịch vụ sau lỗi dịch: không nhận dạng lại', () => {
    assert.notEqual(k1.status, 'ok', JSON.stringify(k1));
    assert.equal(k2.status, 'ok', JSON.stringify(k2));
    assert.ok(k2.cues.every(c => c.vi.startsWith('Q ')));
    assert.equal(asrCalls, asrBefore, 'ASR gọi lại');
  });

  await stop();
  await start();
  const h1 = await health();
  t('bật lại server: vẫn nhớ Qwen', () => assert.equal(h1.mt, 'qwen'));
  const back = await pick(null);
  t('/v1/mt null: về mặc định theo .env', () => { assert.equal(back.status, 200); assert.equal(back.body.mt, 'openai'); });
} catch (e) {
  console.log(log);
  throw e;
} finally {
  server.kill(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

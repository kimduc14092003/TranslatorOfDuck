// Kiểm tra hàng đợi của server khi người xem tua liên tiếp (không cần key, không cần mạng; cần ffmpeg).
// Server thật + dịch vụ AI giả (nhận dạng giọng nói chậm 1,5 s). Mỗi đoạn gửi âm thanh dài khác nhau để biết
// dịch vụ giả đang xử lý đoạn nào.   Chạy: node dev/queue-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-queue-'));
const aac = (sec) => { const f = path.join(TMP, `${sec}.aac`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', f]); return fs.readFileSync(f).toString('base64'); };

const asrOrder = [];
let geminiCalls = 0;
let dayQuota = false;              // Gemini giả trả 429: hết lượt trong ngày
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      const b64 = JSON.parse(body).input.messages[0].content[0].input_audio.data;
      asrOrder.push(Math.round((Buffer.from(b64.split(',')[1], 'base64').length * 8) / 48000));
      await new Promise(r => setTimeout(r, 1500));
      const words = [['大家', 1000, 1400], ['好', 1400, 1600, '，'], ['今天', 1700, 2000], ['我们', 2000, 2300], ['去', 2300, 2450], ['吃', 2450, 2600], ['火锅', 2600, 3100, '。']]
        .map(([text, b, e, p]) => ({ text, begin_time: b, end_time: e, punctuation: p || '' }));
      return json({ output: { sentence: { begin_time: 1000, end_time: 3100, text: '大家好，今天我们去吃火锅。', words }, text: '大家好，今天我们去吃火锅。' } });
    }
    if (req.url.includes(':generateContent')) {
      geminiCalls++;
      if (dayQuota) {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
          { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] },
          { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' }] } }));
      }
      const lines = JSON.parse(JSON.parse(body).contents[0].parts[0].text.match(/Các dòng: (.*)$/m)[1]);
      return json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ cues: lines.map(l => ({ id: l.id, vi: 'Chào cả nhà, hôm nay đi ăn lẩu.' })) }) }] } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
const port = 19787 + Math.floor(Math.random() * 1000);
const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), TOD_WORK: path.join(TMP, 'work'), FFMPEG: ffmpeg,
    MAX_PARALLEL: '2', DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: 'test', OPENAI_API_KEY: '', DASHSCOPE_BASE: PROV, GEMINI_BASE: PROV + '/v1beta' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));

// Âm thanh dài 21..26 s: dịch vụ giả nhận ra đoạn nào qua độ dài.
const SEC = { a: 21, b: 22, c: 23, d: 24, e: 25, f: 26, g: 27, k: 28, l: 29, m: 30, o: 31, h: 32, i: 33 };
const audio = Object.fromEntries(Object.entries(SEC).map(([k, s]) => [k, aac(s)]));
const FROM = { a: 0, b: 20, c: 50, d: 80, e: 110, f: 140, g: 170, k: 230, l: 260, m: 290, o: 320, h: 350, i: 380 };
function post(name, urgent) {
  const ctl = new AbortController();
  const body = JSON.stringify({ id: '7500000000000000099', from: FROM[name], to: FROM[name] + 30, audioStart: FROM[name], urgent, aac: audio[name] });
  const p = fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctl.signal })
    .then(r => r.json()).catch(e => ({ status: e.name === 'AbortError' ? 'aborted' : 'error' }));
  return { p, abort: () => ctl.abort() };
}
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
try {
  // Tua tới chỗ 1: hai đoạn (a đang xem, b kế tiếp) chiếm 2 chỗ. Tua tiếp: c, d xếp hàng. Dừng ở chỗ cuối: e (urgent), f.
  const a = post('a', true), b = post('b', false);
  await wait(300);
  const c = post('c', false), d = post('d', false);
  await wait(300);
  d.abort();                                   // extension huỷ d (đã tua đi)
  await wait(200);
  const e = post('e', true), f = post('f', false);
  const out = await Promise.all([a.p, b.p, c.p, e.p, f.p]);
  await d.p;
  t('đoạn chứa chỗ đang xem (urgent) chạy ngay, không chờ hai đoạn trước', () => {
    assert.deepEqual(asrOrder.slice(0, 3).sort(), [SEC.a, SEC.b, SEC.e].sort());
  });
  t('đoạn xếp hàng: yêu cầu mới nhất làm trước (f trước c)', () => {
    assert.ok(asrOrder.indexOf(SEC.f) < asrOrder.indexOf(SEC.c), 'thứ tự ASR: ' + asrOrder.join(','));
  });
  t('đoạn bị huỷ khi còn xếp hàng thì không gọi dịch vụ AI', () => {
    assert.ok(!asrOrder.includes(SEC.d), 'thứ tự ASR: ' + asrOrder.join(','));
    assert.match(log, /huỷ \(đã tua đi chỗ khác/);
  });
  t('các đoạn còn lại đều có sub', () => { assert.ok(out.every(o => o.status === 'ok'), JSON.stringify(out.map(o => o.status))); });
  // Đoạn đang chạy (đang nhận dạng giọng nói) mà extension huỷ: dừng giữa chừng, không dịch, không ghi cache.
  const calls = geminiCalls;
  const g = post('g', true);
  await wait(500);
  g.abort();
  await g.p;
  await wait(2500);
  t('đoạn đang chạy bị huỷ: dừng giữa chừng, không gọi dịch, không ghi cache', () => {
    assert.ok(asrOrder.includes(SEC.g));
    assert.match(log, /huỷ \(đã tua đi chỗ khác, dừng giữa chừng\)/);
    assert.equal(geminiCalls, calls);
    assert.ok(!fs.readdirSync(path.join(TMP, 'work', 'cache')).some(f => f.includes('.170-200.')));
  });
  // Lướt tới video đã gửi dịch sẵn (không gấp): extension báo /v1/bump, đoạn đó vượt lên trước đoạn gửi sau nó.
  const k = post('k', false), l = post('l', false);
  await wait(300);
  const m = post('m', false);
  await wait(100);
  const o = post('o', false);
  await wait(100);
  const bump = await fetch(`http://127.0.0.1:${port}/v1/bump`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '7500000000000000099', from: FROM.m, to: FROM.m + 30 }) }).then(r => r.json());
  await Promise.all([k.p, l.p, m.p, o.p]);
  t('đoạn được đẩy lên (bump) chạy trước đoạn gửi sau nó', () => {
    assert.ok(bump.found && bump.queued, JSON.stringify(bump));
    assert.ok(asrOrder.indexOf(SEC.m) < asrOrder.indexOf(SEC.o), 'thứ tự ASR: ' + asrOrder.join(','));
  });
  // Gemini hết lượt trong ngày: báo lỗi ngay (không chờ 20 s gọi lại), đoạn sau không gọi cả nhận dạng giọng nói.
  dayQuota = true;
  const t0 = Date.now();
  const h = await post('h', true).p;
  const hMs = Date.now() - t0;
  const asrBefore = asrOrder.length, gemBefore = geminiCalls;
  const i = await post('i', true).p;
  t('Gemini hết lượt trong ngày: báo lỗi ngay, tạm không gọi dịch vụ', () => {
    assert.equal(h.status, 'error'); assert.match(h.error, /hết lượt/);
    assert.ok(hMs < 5000, 'mất ' + hMs + ' ms');
    assert.equal(i.status, 'error'); assert.ok(i.retryAfterMs > 60000, JSON.stringify(i));
    assert.equal(asrOrder.length, asrBefore); assert.equal(geminiCalls, gemBefore);
  });
} finally {
  server.kill(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

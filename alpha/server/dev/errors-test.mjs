// Kiểm tra server khi gặp lỗi: dịch lỗi sau khi đã nhận dạng giọng nói, key/model sai, không có ffmpeg, file cache
// hỏng, request không phải của extension, ngữ cảnh khi đoạn trước không có dòng nào. Không cần key, không cần mạng;
// cần ffmpeg. Server thật + dịch vụ AI giả.   Chạy: node dev/errors-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-errors-'));
const aacFile = path.join(TMP, 'a.aac');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=22', '-c:a', 'aac', aacFile]);
const AAC = fs.readFileSync(aacFile).toString('base64');

let asrCalls = 0;
const mtPrompts = [];
let mtMode = 'ok';                 // 'ok' | 'han' (trả lại chữ Hán: không dòng nào dùng được) | '400' | '401'
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      asrCalls++;
      const words = [['大家', 1000, 1400], ['好', 1400, 1600, '，'], ['今天', 1700, 2000], ['我们', 2000, 2300], ['去', 2300, 2450], ['吃', 2450, 2600], ['火锅', 2600, 3100, '。']]
        .map(([text, b, e, p]) => ({ text, begin_time: b, end_time: e, punctuation: p || '' }));
      return json({ output: { sentence: { begin_time: 1000, end_time: 3100, text: '大家好，今天我们去吃火锅。', words }, text: '大家好，今天我们去吃火锅。' } });
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const content = JSON.parse(body).messages[0].content;
      mtPrompts.push(content);
      if (mtMode === '401') return json({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, 401);
      if (mtMode === '400') return json({ error: { message: 'Invalid schema' } }, 400);
      const lines = JSON.parse(content.match(/Các dòng: (.*)$/m)[1]);
      const vi = mtMode === 'han' ? '大家好' : 'Chào cả nhà, hôm nay đi ăn lẩu.';
      return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ cues: lines.map(l => ({ id: l.id, vi })) }) } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;

async function start(work, extra = {}) {
  const port = 22787 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), TOD_WORK: work, FFMPEG: ffmpeg,
      DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '', OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: '',
      DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = { proc, port, log: '', exited: null, cache: path.join(work, 'cache') };
  proc.stdout.on('data', d => { s.log += d; });
  proc.stderr.on('data', d => { s.log += d; });
  proc.on('exit', (c) => { s.exited = c; });
  while (!/Alpha server/.test(s.log)) await new Promise(r => setTimeout(r, 50));
  return s;
}
// http.request thay cho fetch: đặt được header Origin như trình duyệt gửi.
const request = (s, pathname, body, headers = { 'content-type': 'application/json' }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: s.port, path: pathname, method: body == null ? 'GET' : 'POST', headers }, (res) => {
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) { /* giữ text */ } resolve({ status: res.statusCode, json }); });
  });
  req.on('error', reject);
  req.end(body == null ? undefined : body);
});
const chunk = (id, from, extra = {}) => JSON.stringify({ id, from, to: from + 30, audioStart: from, urgent: true, aac: AAC, ...extra });
const post = async (s, id, from, extra) => (await request(s, '/v1/subtitles', chunk(id, from, extra))).json;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const servers = [];
try {
  const s = await start(path.join(TMP, 'w1'));
  servers.push(s);
  const ver = (await request(s, '/health')).json.version;

  // Trang web bất kỳ gửi được POST text/plain tới 127.0.0.1 mà không bị trình duyệt hỏi trước: không được tốn tiền ASR.
  const a0 = asrCalls;
  const web = await request(s, '/v1/subtitles', chunk('7500000000000000011', 0), { 'content-type': 'application/json', origin: 'https://www.douyin.com' });
  const plain = await request(s, '/v1/subtitles', chunk('7500000000000000011', 0), { 'content-type': 'text/plain' });
  const bump = await request(s, '/v1/bump', JSON.stringify({ id: '7500000000000000011', from: 0, to: 30 }), { 'content-type': 'application/json', origin: 'null' });
  t('request từ trang web (Origin lạ) bị từ chối 403, không gọi ASR', () => {
    assert.equal(web.status, 403); assert.equal(bump.status, 403);
  });
  t('request không phải application/json bị từ chối 415, không gọi ASR', () => {
    assert.equal(plain.status, 415);
    assert.equal(asrCalls, a0);
  });
  const ext = await request(s, '/v1/subtitles', chunk('7500000000000000011', 0), { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnop' });
  t('request của extension (Origin chrome-extension://) vẫn có sub', () => {
    assert.equal(ext.status, 200); assert.equal(ext.json.status, 'ok', JSON.stringify(ext.json));
  });

  // File cache bị cắt cụt (máy tắt giữa lúc ghi): trước đây server thoát.
  const bad = path.join(s.cache, `7500000000000000022.90-120.vi.${ver}.json`);
  fs.writeFileSync(bad, '{"id":"750');
  const fresh = await post(s, '7500000000000000022', 90);
  const odd = await request(s, '/v1/subtitles', 'null');
  await wait(200);
  const health = await request(s, '/health');
  t('file cache hỏng: coi như chưa có, dịch lại, server vẫn chạy', () => {
    assert.equal(fresh.status, 'ok', JSON.stringify(fresh)); assert.ok(!fresh.cached);
    assert.equal(JSON.parse(fs.readFileSync(bad, 'utf8')).status, 'ok');
    assert.equal(odd.status, 500);
    assert.equal(s.exited, null); assert.equal(health.status, 200);
  });
  t('ghi cache không để lại file tạm', () => {
    assert.ok(!fs.readdirSync(s.cache).some(f => f.endsWith('.tmp')), fs.readdirSync(s.cache).join(', '));
  });

  // Đoạn trước đã cache nhưng bị bỏ qua (không có dòng nào): lấy ngữ cảnh ở đoạn đã dịch xa hơn phía trước.
  const ID3 = '7500000000000000033';
  fs.writeFileSync(path.join(s.cache, `${ID3}.0-20.vi.${ver}.json`), JSON.stringify({ id: ID3, from: 0, to: 20, status: 'ok',
    cues: [{ start: 1, end: 3, zh: '师父，等等我。', vi: 'Sư phụ, đợi con với.' }] }));
  fs.writeFileSync(path.join(s.cache, `${ID3}.20-50.vi.${ver}.json`), JSON.stringify({ id: ID3, from: 20, to: 50, status: 'skipped', label: 'singing' }));
  const ctx = await post(s, ID3, 50, { prev: [20, 50] });
  t('đoạn trước bị bỏ qua: ngữ cảnh lấy ở đoạn đã dịch xa hơn', () => {
    assert.equal(ctx.status, 'ok', JSON.stringify(ctx));
    assert.equal(ctx.context, 1); assert.equal(ctx.contextFar, true);
    assert.match(mtPrompts[mtPrompts.length - 1], /một đoạn trước đó.*Sư phụ, đợi con với\./);
  });

  // Dịch lỗi sau khi đã nhận dạng giọng nói: extension gửi lại cả đoạn mỗi 20 s. Lần gửi lại không trả tiền ASR nữa.
  const ID4 = '7500000000000000044';
  const viFile = path.join(s.cache, `${ID4}.120-150.vi.${ver}.json`);
  const asrFiles = () => fs.readdirSync(s.cache).filter(f => f.startsWith(`${ID4}.120-150.asr.`));
  const a1 = asrCalls;
  mtMode = 'han';
  const u = await post(s, ID4, 120);
  t('dịch không ra dòng nào (untranslated): không cache, giữ kết quả ASR', () => {
    assert.equal(u.status, 'skipped'); assert.equal(u.label, 'untranslated');
    assert.ok(!fs.existsSync(viFile)); assert.equal(asrFiles().length, 1);
  });
  mtMode = '400';
  const e400 = await post(s, ID4, 120);
  mtMode = 'ok';
  const ok = await post(s, ID4, 120);
  t('gửi lại sau khi dịch lỗi: dùng lại ASR (3 lần gửi = 1 lần ASR), có sub thì xoá ASR đã giữ', () => {
    assert.equal(e400.status, 'error');
    assert.equal(ok.status, 'ok', JSON.stringify(ok)); assert.equal(ok.asrCached, true);
    assert.equal(asrCalls - a1, 1);
    assert.ok(fs.existsSync(viFile)); assert.equal(asrFiles().length, 0);
  });

  // Key dịch sai (401): báo lỗi kèm retryAfterMs, các lần sau báo ngay, không gọi ASR lẫn dịch.
  const a2 = asrCalls, m2 = mtPrompts.length;
  mtMode = '401';
  const r401 = [];
  for (let i = 0; i < 3; i++) r401.push(await post(s, '7500000000000000055', 150));
  t('dịch báo 401: 3 lần gửi = 1 lần ASR, 1 lần gọi dịch, báo lỗi kèm thời gian chờ', () => {
    assert.ok(r401.every(r => r.status === 'error'), JSON.stringify(r401));
    assert.match(r401[0].error, /OpenAI từ chối key hoặc model \(HTTP 401\)/);
    assert.ok(r401.every(r => r.retryAfterMs > 60000 && r.retryAfterMs <= 120000), JSON.stringify(r401.map(r => r.retryAfterMs)));
    assert.equal(asrCalls - a2, 1); assert.equal(mtPrompts.length - m2, 1);
  });
  // Video khác trong lúc tạm dừng: báo ngay trước khi tách âm thanh, không gọi ASR.
  const other = await post(s, '7500000000000000066', 0);
  t('trong lúc tạm dừng vì key sai: video khác báo lỗi ngay, không gọi ASR', () => {
    assert.equal(other.status, 'error'); assert.ok(other.retryAfterMs > 60000);
    assert.equal(asrCalls - a2, 1);
  });
  s.proc.kill();

  // Không chạy được ffmpeg: báo lỗi khi khởi động và ở từng đoạn; không cache "không có âm thanh".
  const nf = await start(path.join(TMP, 'w2'), { FFMPEG: path.join(TMP, 'khong-co', 'ffmpeg') });
  servers.push(nf);
  for (let i = 0; i < 60 && !/Không chạy được ffmpeg/.test(nf.log); i++) await wait(50);
  const a3 = asrCalls;
  const noff = await post(nf, '7500000000000000077', 0);
  t('không có ffmpeg: báo khi khởi động, đoạn báo lỗi (không phải no_audio), không ghi cache', () => {
    assert.match(nf.log, /Không chạy được ffmpeg/);
    assert.equal(noff.status, 'error', JSON.stringify(noff)); assert.match(noff.error, /ffmpeg/);
    assert.deepEqual(fs.readdirSync(nf.cache), []);
    assert.equal(asrCalls, a3);
  });
} finally {
  for (const s of servers) s.proc.kill();
  providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

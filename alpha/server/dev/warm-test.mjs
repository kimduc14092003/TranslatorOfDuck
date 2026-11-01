// Kiểm tra POST /v1/warm (mở sẵn kết nối tới dịch vụ ASR, dịch khi extension vừa mở video) và phần đo kết nối trong
// dòng log từng đoạn. Không cần key, không cần mạng; cần ffmpeg. Server thật + ba dịch vụ AI giả ở ba origin khác nhau
// (DashScope, OpenAI, Gemini giả), đếm request làm nóng (GET /) và số kết nối TCP mỗi bên.   Chạy: node dev/warm-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-warm-'));
const aacFile = path.join(TMP, 'a.aac');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=22', '-c:a', 'aac', aacFile]);
const AAC = fs.readFileSync(aacFile).toString('base64');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let mtMode = 'ok';     // 'ok' | '401'
let asrMode = 'ok';    // 'ok' | '401'
function fake(name) {
  const f = { name, warms: 0, conns: 0, calls: 0 };
  f.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/') { f.warms++; assert.equal(req.headers.authorization, undefined); assert.equal(body, ''); return json({ error: 'not_found' }, 404); }
      f.calls++;
      if (req.url.endsWith('/multimodal-generation/generation')) {
        if (asrMode === '401') return json({ code: 'InvalidApiKey', message: 'Invalid API-key provided.' }, 401);
        const words = [['大家', 1000, 1400], ['好', 1400, 1600, '，'], ['今天', 1700, 2000], ['我们', 2000, 2300], ['去', 2300, 2450], ['吃', 2450, 2600], ['火锅', 2600, 3100, '。']]
          .map(([text, b, e, p]) => ({ text, begin_time: b, end_time: e, punctuation: p || '' }));
        return json({ output: { sentence: { begin_time: 1000, end_time: 3100, text: '大家好，今天我们去吃火锅。', words }, text: '大家好，今天我们去吃火锅。' } });
      }
      if (req.url.endsWith('/v1/chat/completions')) {
        if (mtMode === '401') return json({ error: { message: 'Incorrect API key provided', code: 'invalid_api_key' } }, 401);
        const lines = JSON.parse(JSON.parse(body).messages[0].content.match(/Các dòng: (.*)$/m)[1]);
        return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ cues: lines.map(l => ({ id: l.id, vi: 'Chào cả nhà, hôm nay đi ăn lẩu.' })) }) } }] });
      }
      res.writeHead(404); res.end();
    });
  });
  f.server.on('connection', () => { f.conns++; });
  return new Promise(r => f.server.listen(0, '127.0.0.1', () => { f.url = `http://127.0.0.1:${f.server.address().port}`; r(f); }));
}
const DASH = await fake('DashScope');
const OAI = await fake('OpenAI');
const GEM = await fake('Gemini');
const snap = () => ({ dw: DASH.warms, ow: OAI.warms, gw: GEM.warms, dc: DASH.conns, oc: OAI.conns, gc: GEM.conns });
const GEMINI = { GEMINI_API_KEY: 'test-gemini', GEMINI_BASE: GEM.url + '/v1beta' };

const freePort = () => new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });
const servers = [];
async function start(extra = {}) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), TOD_WORK: fs.mkdtempSync(path.join(TMP, 'w-')), FFMPEG: ffmpeg,
      DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '', OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: '',
      FUNASR_MODEL: 'fun-asr-test', ASR_FALLBACK_MODEL: '', DASHSCOPE_BASE: DASH.url, OPENAI_BASE: OAI.url + '/v1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = { proc, port, log: '' };
  servers.push(s);
  proc.stdout.on('data', d => { s.log += d; });
  proc.stderr.on('data', d => { s.log += d; });
  const t0 = Date.now();
  while (!/Alpha server/.test(s.log)) {
    if (proc.exitCode !== null || Date.now() - t0 > 10000) throw new Error('server không khởi động được: ' + s.log.slice(-300));
    await wait(50);
  }
  return s;
}
// http.request thay cho fetch: đặt được header Origin như trình duyệt gửi.
const request = (s, pathname, body, headers = { 'content-type': 'application/json' }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: s.port, path: pathname, method: 'POST', headers }, (res) => {
    let text = '';
    res.on('data', c => { text += c; });
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch (_) { /* giữ text */ } resolve({ status: res.statusCode, json, text }); });
  });
  req.on('error', reject);
  req.end(body);
});
const EXT = { 'content-type': 'application/json', origin: 'chrome-extension://abcdefghijklmnop' };
const warm = (s, headers = EXT) => request(s, '/v1/warm', '{}', headers);
let idn = 0;
const post = async (s) => {
  const id = '75000000000000' + String(++idn).padStart(5, '0');
  const r = await request(s, '/v1/subtitles', JSON.stringify({ id, from: 0, to: 30, audioStart: 0, urgent: true, aac: AAC }), EXT);
  return { id, ...r.json };
};
const lineOf = (s, id) => s.log.split('\n').find(l => l.includes(id) && / (ok|error|skipped) /.test(l)) || '';
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
try {
  // Server chưa từng làm nóng: lần gọi ASR, dịch đầu tiên phải mở kết nối mới; log ghi thời gian tới header và thời gian mở.
  const s0 = await start();
  const r0 = await post(s0);
  t('log từng đoạn ghi thời gian tới header và kết nối mới kèm thời gian mở (ASR và dịch)', () => {
    assert.equal(r0.status, 'ok', JSON.stringify(r0));
    assert.match(lineOf(s0, r0.id), /ASR \d+ ms \[đầu \d+ ms, kết nối mới \d+ ms\], dịch \d+ ms \[đầu \d+ ms, kết nối mới \d+ ms\]/, s0.log);
    assert.equal(r0.debug, undefined, 'phần đo không gửi về extension');
  });
  s0.proc.kill();

  const s = await start();
  // Trang web bất kỳ không được gọi /v1/warm (cùng luật Origin, content-type như /v1/subtitles).
  const b0 = snap();
  const web = await warm(s, { 'content-type': 'application/json', origin: 'https://www.douyin.com' });
  const plain = await warm(s, { 'content-type': 'text/plain' });
  await wait(300);
  t('/v1/warm từ trang web (Origin lạ) bị từ chối 403, không phải JSON bị 415, không làm nóng gì', () => {
    assert.equal(web.status, 403); assert.equal(plain.status, 415);
    assert.deepEqual(snap(), b0);
  });

  const b1 = snap();
  const t1 = Date.now();
  const w1 = await warm(s);
  const w2 = await warm(s);
  await wait(300);
  const a1 = snap();
  t('/v1/warm trả 204 ngay; mỗi origin dịch vụ đang dùng đúng một GET / (không key, không body); lần thứ hai trong 3 s không làm gì', () => {
    assert.equal(w1.status, 204); assert.equal(w1.text, ''); assert.equal(w2.status, 204);
    assert.equal(a1.dw - b1.dw, 1); assert.equal(a1.ow - b1.ow, 1);
  });
  t('mỗi lần làm nóng ghi một dòng log: origin, mã trả về, thời gian tới header, kết nối mới, header keep-alive', () => {
    for (const f of [DASH, OAI]) {
      const re = new RegExp(`làm nóng ${f.url.replace('http://', '').replace(/\./g, '\\.')}: HTTP 404, đầu \\d+ ms, kết nối mới \\d+ ms, keep-alive: timeout=5`, 'g');
      assert.equal((s.log.match(re) || []).length, 1, s.log);
    }
  });
  const r1 = await post(s);
  const a2 = snap();
  t('sau khi làm nóng: lần gọi ASR và dịch thật dùng lại kết nối đã mở (không mở kết nối mới), log ghi "kết nối sẵn (làm nóng)"', () => {
    assert.equal(r1.status, 'ok', JSON.stringify(r1));
    assert.equal(a2.dc, a1.dc); assert.equal(a2.oc, a1.oc);
    assert.match(lineOf(s, r1.id), /ASR \d+ ms \[đầu \d+ ms, kết nối sẵn \(làm nóng\)\], dịch \d+ ms \[đầu \d+ ms, kết nối sẵn \(làm nóng\)\]/, s.log);
  });

  // Hết 3 s kể từ lần làm nóng, nhưng vừa có lệnh gọi thật: kết nối còn mở, không làm nóng.
  await wait(Math.max(0, t1 + 3300 - Date.now()));
  const r2 = await post(s);
  const b3 = snap();
  const w3 = await warm(s);
  await wait(300);
  t('/v1/warm ngay sau một lệnh gọi thật (trong 3 s): không làm nóng origin đó', () => {
    assert.equal(r2.status, 'ok', JSON.stringify(r2)); assert.equal(w3.status, 204);
    assert.equal(snap().dw, b3.dw); assert.equal(snap().ow, b3.ow);
  });
  await wait(3300);
  const b4 = snap();
  await warm(s);
  await wait(300);
  t('quá 3 s không gọi gì: /v1/warm làm nóng lại mỗi origin một lần', () => {
    assert.equal(snap().dw - b4.dw, 1); assert.equal(snap().ow - b4.ow, 1);
  });
  s.proc.kill();

  // Không có key nhận dạng nào (DashScope, Gemini): đoạn nào cũng hỏng ở bước ASR, dịch không được gọi tới.
  const sn = await start({ DASHSCOPE_API_KEY: '' });
  const b5 = snap();
  const wn = await warm(sn);
  await wait(300);
  t('chưa có key nhận dạng nào: /v1/warm vẫn trả 204 nhưng không làm nóng origin nào (kể cả dịch)', () => {
    assert.equal(wn.status, 204); assert.deepEqual(snap(), b5);
  });
  sn.proc.kill();

  // Chỉ có key Gemini: nhận dạng và dịch đều bằng Gemini, chung một origin → một GET / duy nhất.
  const sg = await start({ DASHSCOPE_API_KEY: '', OPENAI_API_KEY: '', ...GEMINI });
  const b7 = snap();
  await warm(sg);
  await wait(300);
  t('chỉ có Gemini (nhận dạng + dịch chung origin): đúng một GET / tới Gemini, không gì tới DashScope, OpenAI', () => {
    const a = snap();
    assert.equal(a.gw - b7.gw, 1); assert.equal(a.dw, b7.dw); assert.equal(a.ow, b7.ow);
  });
  sg.proc.kill();

  // Dịch bằng OpenAI, nhận dạng bằng Gemini (không có key DashScope): làm nóng cả hai origin, mỗi origin một lần.
  const so = await start({ DASHSCOPE_API_KEY: '', ...GEMINI });
  const b8 = snap();
  await warm(so);
  await wait(300);
  t('dịch OpenAI + nhận dạng Gemini: một GET / tới OpenAI, một tới Gemini, không gì tới DashScope', () => {
    const a = snap();
    assert.equal(a.ow - b8.ow, 1); assert.equal(a.gw - b8.gw, 1); assert.equal(a.dw, b8.dw);
  });
  so.proc.kill();

  // DashScope đang tạm dừng (key sai, HTTP 401): transcribe() không chuyển sang Gemini, đoạn hỏng ở bước ASR, nên không
  // làm nóng gì (kể cả OpenAI).
  const sd = await start();
  asrMode = '401';
  const rd = await post(sd);
  asrMode = 'ok';
  await wait(3300);
  const b9 = snap();
  const wd = await warm(sd);
  await wait(300);
  t('DashScope đang tạm dừng (401): /v1/warm vẫn trả 204 nhưng không làm nóng origin nào', () => {
    assert.equal(rd.status, 'error', JSON.stringify(rd)); assert.equal(wd.status, 204);
    assert.deepEqual(snap(), b9);
  });
  sd.proc.kill();

  // Dịch đang tạm dừng (key sai, HTTP 401): không làm nóng gì (makeSubtitles báo lỗi trước cả bước ASR); lần làm nóng không
  // tính vào tạm dừng hay hạn mức.
  const sp = await start();
  mtMode = '401';
  const rp = await post(sp);
  mtMode = 'ok';
  await wait(3300);
  const b6 = snap();
  const calls6 = OAI.calls;
  const wp = await warm(sp);
  await wait(300);
  t('dịch đang tạm dừng (401): /v1/warm vẫn trả 204 nhưng không làm nóng origin nào', () => {
    assert.equal(rp.status, 'error', JSON.stringify(rp)); assert.equal(wp.status, 204);
    assert.deepEqual(snap(), b6); assert.equal(OAI.calls, calls6);
  });
  sp.proc.kill();
} finally {
  for (const s of servers) s.proc.kill();
  DASH.server.close(); OAI.server.close(); GEM.server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

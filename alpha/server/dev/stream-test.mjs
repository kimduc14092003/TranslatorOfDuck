// Kiểm tra dịch dạng stream (extension gửi stream: true, server trả NDJSON: các dòng dịch xong trước, rồi kết quả cuối).
// Không cần key, không cần mạng; cần ffmpeg. Server thật + dịch vụ AI giả (OpenAI trả SSE).   Chạy: node dev/stream-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-stream-'));
const aacFile = path.join(TMP, 'a.aac');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=22', '-c:a', 'aac', aacFile]);
const AAC = fs.readFileSync(aacFile).toString('base64');

// MT_TIMEOUT_MS = 300: hạn chữ đầu 0,3 s, im giữa chừng 0,18 s, cả chuỗi gọi lại 1,8 s.
// mode: 'stream' (SSE, mỗi mẩu cách 100 ms), 'slow' (chữ đầu sau 100 ms, rồi mỗi 100 ms một mẩu, cả lượt ~0,9 s, lâu hơn
// hạn 0,3 s), 'stall' (lần gọi đầu im 1,5 s không chữ nào, lần sau như 'stream'), 'midstall' (lần gọi đầu gửi 2 mẩu rồi im
// 1 s, lần sau như 'stream'), 'forever' (mỗi 100 ms một mẩu, không bao giờ xong), 'nokey' (401).
let mode = 'stream';
const calls = [];
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      const sent = (text, b, e) => ({ begin_time: b, end_time: e, text, words: [...text.replace(/[，。]/g, '')].map((ch, i, a) => ({ text: ch, begin_time: b + Math.round(i * (e - b) / a.length), end_time: b + Math.round((i + 1) * (e - b) / a.length), punctuation: i === a.length - 1 ? '。' : '' })) });
      const s1 = sent('大家好今天我们去吃火锅。', 1000, 4000), s2 = sent('这家店是我最喜欢的。', 6000, 9000);
      return json({ output: { sentences: [s1, s2], text: s1.text + s2.text } });
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const b = JSON.parse(body);
      const n = calls.push({ at: Date.now(), stream: b.stream === true });
      if (mode === 'nokey') return json({ error: { message: 'bad key' } }, 401);
      const lines = JSON.parse(b.messages[0].content.match(/Các dòng: (.*)$/m)[1]);
      // Lượt rút gọn: trả 'Ngắn N.' sau 150 ms, một lần (nhanh hơn hạn 2 × 0,3 s). mode 'long': lượt dịch đầu ra dòng quá dài.
      const condensing = /^Rút gọn/.test(b.messages[0].content);
      if (condensing) calls.at(-1).condense = true;
      const viOf = (l) => (condensing ? 'Ngắn ' + l.id + '.' : mode === 'long' ? 'Dòng ' + l.id + ' ' + 'rất '.repeat(30) + 'dài.' : 'Dòng ' + l.id + ' đã dịch.');
      const content = JSON.stringify({ pronouns: { pairs: [] }, cues: lines.map(l => ({ id: l.id, vi: viOf(l) })) });
      if (condensing) {
        return setTimeout(() => {
          if (!b.stream) return json({ choices: [{ message: { role: 'assistant', content } }] });
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
        }, 150);
      }
      if (!b.stream) return json({ choices: [{ message: { role: 'assistant', content } }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const pieces = [];
      for (let i = 0; i < content.length; i += Math.ceil(content.length / 8)) pieces.push(content.slice(i, i + Math.ceil(content.length / 8)));
      const ev = (d) => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`;
      if (mode === 'stall' && n === 1) { setTimeout(() => res.end(), 1500); return; }
      if (mode === 'midstall' && n === 1) {
        res.write(ev({ content: pieces[0] })); setTimeout(() => res.write(ev({ content: pieces[1] })), 50);
        setTimeout(() => res.end(), 1000); return;
      }
      if (mode === 'forever') {
        const iv = setInterval(() => { if (res.writableEnded || res.destroyed) return clearInterval(iv); res.write(ev({ content: ' ' })); }, 100);
        res.on('close', () => clearInterval(iv)); return;
      }
      const first = mode === 'slow' ? 100 : 50, gap = 100;
      pieces.forEach((p, i) => setTimeout(() => { if (!res.writableEnded) res.write(ev({ content: p })); }, first + i * gap));
      setTimeout(() => { if (!res.writableEnded) res.end('data: [DONE]\n\n'); }, first + pieces.length * gap);
      return;
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
// Hai server: mặc định (rút gọn tắt từ 4/11) và TOD_CONDENSE=1 (bật lại rút gọn: kiểm rút gọn sau). log: cả hai.
let log = '';
async function startServer(extra = {}) {
  const port = 22787 + Math.floor(Math.random() * 1000);
  const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
    env: { ...process.env, PORT: String(port), TOD_WORK: path.join(TMP, 'work-' + port), FFMPEG: ffmpeg, MT_TIMEOUT_MS: '300', TOD_CONDENSE: '',
      DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '', OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: 'none',
      DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let mine = '';
  proc.stdout.on('data', d => { log += d; mine += d; });
  proc.stderr.on('data', d => { log += d; mine += d; });
  while (!/Alpha server/.test(mine)) await new Promise(r => setTimeout(r, 50));
  return { proc, port, work: path.join(TMP, 'work-' + port) };
}
const main = await startServer(), cond = await startServer({ TOD_CONDENSE: '1' });
const port = main.port;
const server = { kill: () => { main.proc.kill(); cond.proc.kill(); } };

// Gửi một đoạn, đọc trả lời từng dòng: [{ at: ms từ lúc gửi, obj }], kèm content-type.
async function post(id, extra = {}, p = port) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${p}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, from: 0, to: 30, audioStart: 0, urgent: true, aac: AAC, ...extra }) });
  const type = res.headers.get('content-type') || '';
  const reader = res.body.getReader(), dec = new TextDecoder();
  const out = [];
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    for (let nl; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) if (buf.slice(0, nl).trim()) out.push({ at: Date.now() - t0, obj: JSON.parse(buf.slice(0, nl)) });
    if (done) break;
  }
  if (buf.trim()) out.push({ at: Date.now() - t0, obj: JSON.parse(buf) });
  return { type, out };
}
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
try {
  mode = 'stream';
  const a = await post('7500000000000000201', { stream: true });
  const partials = a.out.filter(x => x.obj.partial), fin = a.out.at(-1);
  t('stream: các dòng dịch xong được gửi trước kết quả cuối, cùng dạng dòng, kết quả cuối như trả lời thường', () => {
    assert.match(a.type, /x-ndjson/);
    assert.ok(partials.length >= 1, JSON.stringify(a.out.map(x => [x.at, Object.keys(x.obj)])));
    assert.ok(partials[0].at + 100 <= fin.at, 'dòng đầu lúc ' + partials[0].at + ' ms, kết quả cuối lúc ' + fin.at + ' ms');
    const p = partials[0].obj.partial[0];
    assert.ok(typeof p.start === 'number' && typeof p.end === 'number' && /^Dòng \d+ đã dịch\.$/.test(p.vi) && p.zh, JSON.stringify(p));
    assert.equal(fin.obj.status, 'ok', JSON.stringify(fin.obj));
    assert.deepEqual(partials.at(-1).obj.partial.map(c => c.vi), fin.obj.cues.map(c => c.vi));
  });
  t('lượt dịch dạng stream gửi stream: true tới OpenAI', () => assert.ok(calls.at(-1).stream));

  const c = await post('7500000000000000201', { stream: true });
  t('kết quả có sẵn trong cache: trả một lần (JSON), không gọi dịch thêm', () => {
    assert.match(c.type, /application\/json/);
    assert.equal(c.out.length, 1); assert.equal(c.out[0].obj.cached, true);
  });

  mode = 'slow';
  const k = calls.length;
  const s = await post('7500000000000000202', { stream: true });
  t('trả chậm mà đều (cả lượt ~0,9 s, hạn chữ đầu 0,3 s): không cắt giữa chừng, một lần gọi', () => {
    assert.equal(s.out.at(-1).obj.status, 'ok', JSON.stringify(s.out.at(-1).obj));
    assert.equal(calls.length - k, 1, 'số lần gọi dịch: ' + (calls.length - k));
  });

  mode = 'stall';
  calls.length = 0;
  const st = await post('7500000000000000203', { stream: true });
  t('im quá hạn trước chữ đầu tiên: gọi lại, vẫn có kết quả', () => {
    assert.equal(st.out.at(-1).obj.status, 'ok', JSON.stringify(st.out.at(-1).obj));
    assert.equal(calls.length, 2);
    assert.match(log, /quá 0\.3 s chưa trả lời: gọi lại/);
  });

  mode = 'stream';
  const plain = await post('7500000000000000204');
  t('không xin stream: trả JSON một lần như trước', () => {
    assert.match(plain.type, /application\/json/);
    assert.equal(plain.out.length, 1); assert.equal(plain.out[0].obj.status, 'ok');
  });

  mode = 'midstall';
  calls.length = 0;
  const mid = await post('7500000000000000205', { stream: true });
  t('im giữa chừng quá hạn im (0,18 s): cắt, gọi lại, log ghi đúng loại hạn, vẫn có kết quả', () => {
    assert.equal(mid.out.at(-1).obj.status, 'ok', JSON.stringify(mid.out.at(-1).obj));
    assert.equal(calls.length, 2);
    assert.match(log, /im quá 0\.18 s giữa chừng: gọi lại/);
  });

  mode = 'forever';
  calls.length = 0;
  const t0 = Date.now();
  const fv = await post('7500000000000000206', { stream: true });
  t('trả mãi không xong: hết hạn chung của cả chuỗi (1,8 s) thì thôi, báo lỗi ở dòng cuối (verifier 2/11: trước là ~3 × 60 s)', () => {
    assert.equal(fv.out.at(-1).obj.status, 'error', JSON.stringify(fv.out.at(-1).obj));
    assert.ok(Date.now() - t0 < 3500, 'mất ' + (Date.now() - t0) + ' ms');
    assert.match(log, /quá 1\.8 s cả lượt: thôi, báo lỗi/);
  });

  // Mặc định (rút gọn tắt, 4/11): đoạn gấp hay không gấp, có hay không condenseLater: không lượt rút gọn nào, dòng dài giữ nguyên.
  mode = 'long';
  calls.length = 0;
  const off1 = await post('7500000000000000211', { stream: true, condenseLater: true });
  const off2 = await post('7500000000000000212', { stream: true, condenseLater: true, urgent: false });
  t('rút gọn tắt (mặc định): không gọi lượt rút gọn, không có dòng condensed, dòng dài giữ đủ chữ, ở đoạn gấp lẫn đoạn không gấp', () => {
    for (const r of [off1, off2]) {
      assert.equal(r.out.at(-1).obj.status, 'ok', JSON.stringify(r.out.at(-1).obj));
      assert.ok(r.out.at(-1).obj.cues.every(c => / rất rất /.test(c.vi)), JSON.stringify(r.out.at(-1).obj.cues));
      assert.ok(!r.out.some(x => x.obj.condensed));
    }
    assert.equal(calls.filter(c => c.condense).length, 0);
  });
  // TOD_CONDENSE=1. Rút gọn sau (extension 0.2.42: condenseLater: true): đoạn gấp trả kết quả chưa rút gọn ngay, rồi một dòng { condensed }.
  mode = 'long';
  calls.length = 0;
  const lt = await post('7500000000000000208', { stream: true, condenseLater: true }, cond.port);
  const lfin = lt.out.find(x => x.obj.status), lcon = lt.out.find(x => x.obj.condensed);
  t('TOD_CONDENSE=1, rút gọn sau: đoạn gấp trả kết quả chưa rút gọn trước, rồi dòng { condensed } đủ dòng, cùng mốc; cache giữ bản rút gọn', () => {
    assert.equal(lfin.obj.status, 'ok', JSON.stringify(lt.out.map(x => Object.keys(x.obj))));
    assert.ok(lfin.obj.cues.every(c => / rất rất /.test(c.vi)), 'kết quả đầu phải là bản đầy đủ');
    assert.ok(lcon, 'thiếu dòng condensed: ' + JSON.stringify(lt.out.map(x => Object.keys(x.obj))));
    assert.ok(lcon.at >= lfin.at + 100, `kết quả lúc ${lfin.at} ms, bản rút gọn lúc ${lcon.at} ms`);
    assert.deepEqual(lcon.obj.condensed.map(c => c.start), lfin.obj.cues.map(c => c.start));
    assert.ok(lcon.obj.condensed.every(c => /^Ngắn \d+\.$/.test(c.vi)), JSON.stringify(lcon.obj.condensed));
    assert.deepEqual(lcon.obj.condensed.map(c => c.full), lfin.obj.cues.map(c => c.vi), 'full: bản đầy đủ đã trả');
    const file = fs.readdirSync(path.join(cond.work, 'cache')).find(f => f.startsWith('7500000000000000208.0-30.vi.'));
    const saved = JSON.parse(fs.readFileSync(path.join(cond.work, 'cache', file), 'utf8'));
    assert.ok(saved.cues.every(c => c.full && /^Ngắn/.test(c.vi)) && saved.condensedLater === saved.cues.length, 'cache giữ bản rút gọn kèm full');
    assert.equal(lt.out.indexOf(lcon), lt.out.length - 1, 'dòng condensed là dòng cuối');
    assert.equal(calls.filter(c => c.condense).length, 1);
    assert.match(log, /rút gọn sau: \d+\/\d+ dòng dài/);
  });
  const lc = await post('7500000000000000208', { stream: true, condenseLater: true }, cond.port);
  t('TOD_CONDENSE=1, rút gọn sau: lần hỏi lại lấy từ cache ra bản đã rút gọn, không gọi thêm', () => {
    assert.equal(lc.out.length, 1); assert.equal(lc.out[0].obj.cached, true);
    assert.ok(lc.out[0].obj.cues.every(c => /^Ngắn \d+\.$/.test(c.vi) && !('full' in c)), JSON.stringify(lc.out[0].obj.cues));
    assert.ok(!('condensedLater' in lc.out[0].obj), 'full, condensedLater chỉ ở file cache');
    assert.equal(calls.filter(c => c.condense).length, 1);
  });
  calls.length = 0;
  const lo = await post('7500000000000000209', { stream: true }, cond.port);
  t('TOD_CONDENSE=1, extension cũ (không gửi condenseLater): đoạn gấp không rút gọn như trước, không có dòng condensed', () => {
    assert.equal(lo.out.at(-1).obj.status, 'ok');
    assert.ok(lo.out.at(-1).obj.cues.every(c => / rất rất /.test(c.vi)));
    assert.ok(!lo.out.some(x => x.obj.condensed));
    assert.equal(calls.filter(c => c.condense).length, 0);
  });
  calls.length = 0;
  const ln = await post('7500000000000000210', { stream: true, condenseLater: true, urgent: false }, cond.port);
  t('TOD_CONDENSE=1, đoạn không gấp: rút gọn ngay trong lượt dịch như trước, không có dòng condensed', () => {
    assert.ok(ln.out.at(-1).obj.cues.every(c => /^Ngắn \d+\.$/.test(c.vi)), JSON.stringify(ln.out.at(-1).obj));
    assert.ok(!ln.out.some(x => x.obj.condensed));
    assert.equal(calls.filter(c => c.condense).length, 1);
  });

  mode = 'nokey';
  const nk = await post('7500000000000000207', { stream: true });
  t('lỗi sau khi đã gửi header (401): dòng cuối là { status: "error" }', () => {
    assert.match(nk.type, /x-ndjson/);
    assert.equal(nk.out.at(-1).obj.status, 'error', JSON.stringify(nk.out.at(-1).obj));
  });
  console.log(`\n${n} kiểm tra đều đạt.`);
} catch (e) {
  console.log(log.slice(-3000));
  throw e;
} finally {
  server.kill();
  providers.close();
}

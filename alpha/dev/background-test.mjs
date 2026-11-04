// Kiểm tra alpha/extension/background.js (không cần trình duyệt): chạy nó trong vm với fetch thật của Node, gửi tới một
// server HTTP thử trên 127.0.0.1 (cổng ngẫu nhiên) nhận request theo cùng luật với alpha/server/server.mjs (rejectForeign:
// Origin chrome-extension:// hay không có Origin, content-type application/json; sai thì 415).   Chạy: node alpha/dev/background-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
const VERSION = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8')).version;
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

// routes: đường dẫn server có (server cũ không có /v1/warm thì 404).
async function startServer(routes = ['/v1/warm', '/v1/bump', '/v1/subtitles']) {
  const got = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '', origin = req.headers.origin;
      const code = req.method !== 'POST' || !routes.includes(req.url) ? 404
        : origin && !origin.startsWith('chrome-extension://') ? 403
        : !/^application\/json\b/i.test(ct) ? 415 : 204;
      got.push({ url: req.url, ct, body, code });
      res.writeHead(code); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { got, base: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise((r) => srv.close(r)) };
}
// toTab: các tin background.js gửi cho tab (chrome.tabs.sendMessage).
function load(toTab = []) {
  let listener = null;
  const ctx = { chrome: { runtime: { onMessage: { addListener: (f) => { listener = f; } } },
    tabs: { sendMessage: (tab, m) => { toTab.push({ tab, ...m }); return Promise.resolve(); } } }, AbortController, fetch, TextDecoder };
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  return (msg) => { const replies = []; const ret = listener(msg, { tab: { id: 1 } }, (r) => replies.push(r)); return { ret, replies }; };
}
const settle = async (got, n) => { for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 10)); await new Promise((r) => setTimeout(r, 30)); };

let n = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); n++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
};

await t('warm: POST /v1/warm tới server trên máy, kiểu application/json (server nhận, trả 204), không chờ trả lời', async () => {
  // Bản đầu gửi POST không content-type: server trả 415 (rejectForeign) nên không làm nóng gì (reviewer 1/11).
  const s = await startServer();
  const send = load();
  const r = send({ type: 'warm', server: s.base + '/' });
  await settle(s.got, 1);
  await s.close();
  assert.equal(r.ret, false, 'không giữ kênh trả lời');
  assert.deepEqual(r.replies, []);
  assert.equal(s.got.length, 1, 'số request: ' + JSON.stringify(s.got));
  assert.equal(s.got[0].url, '/v1/warm');
  assert.equal(s.got[0].code, 204, 'server trả ' + s.got[0].code + ' (content-type: "' + s.got[0].ct + '")');
  assert.equal(s.got[0].body, '{}');
});

await t('warm: địa chỉ server không phải máy này thì không gọi; server cũ (404) hay không chạy thì bỏ qua lỗi', async () => {
  const s = await startServer(['/v1/bump', '/v1/subtitles']);
  const send = load();
  const far = send({ type: 'warm', server: 'https://example.com' });
  assert.equal(far.ret, false);
  assert.match(String((far.replies[0] || {}).error), /127\.0\.0\.1/);
  send({ type: 'warm', server: s.base });
  await settle(s.got, 1);
  await s.close();
  assert.deepEqual(s.got.map((x) => [x.url, x.code]), [['/v1/warm', 404]]);
  send({ type: 'warm', server: s.base });   // server đã tắt: lỗi kết nối
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(unhandled.map(String), [], 'lỗi không được bắt');
});

await t('subtitles dạng stream: các dòng { partial } chuyển ngay cho tab (type partial, đúng key), dòng cuối là câu trả lời; JSON một lần vẫn như cũ', async () => {
  const fin = { status: 'ok', cues: [{ start: 1, end: 2, vi: 'A' }, { start: 3, end: 4, vi: 'B' }] };
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (!JSON.parse(body).stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(fin)); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      res.write(JSON.stringify({ partial: [fin.cues[0]] }) + '\n');
      setTimeout(() => { res.write(JSON.stringify({ partial: fin.cues }) + '\n' + JSON.stringify(fin).slice(0, 10)); }, 30);
      setTimeout(() => res.end(JSON.stringify(fin).slice(10) + '\n'), 60);   // dòng cuối bị chia làm hai khúc
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const toTab = [];
  const send = load(toTab);
  const r = send({ type: 'subtitles', server: base, key: '7500000000000000004:1', payload: { id: '7500000000000000004', stream: true } });
  const plain = send({ type: 'subtitles', server: base, key: '7500000000000000004:2', payload: { id: '7500000000000000004' } });
  for (let i = 0; i < 100 && !(r.replies.length && plain.replies.length); i++) await new Promise((res) => setTimeout(res, 10));
  await new Promise((res) => srv.close(res));
  assert.equal(r.ret, true);
  assert.deepEqual(toTab.map((m) => [m.tab, m.type, m.key, m.cues.map((c) => c.vi).join('')]), [[1, 'partial', '7500000000000000004:1', 'A'], [1, 'partial', '7500000000000000004:1', 'AB']]);
  assert.equal(JSON.stringify(r.replies), JSON.stringify([fin]));
  assert.equal(JSON.stringify(plain.replies), JSON.stringify([fin]));
});

await t('NDJSON hết mà không có dòng kết quả cuối: báo lỗi rõ (trước đây trả {} và content báo "không có phản hồi", verifier 2/11 F5)', async () => {
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      res.end(JSON.stringify({ partial: [{ start: 1, end: 2, vi: 'A' }] }) + '\n');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const send = load([]);
  const r = send({ type: 'subtitles', server: 'http://127.0.0.1:' + srv.address().port, key: '7500000000000000005:0', payload: { id: '7500000000000000005', stream: true } });
  for (let i = 0; i < 100 && !r.replies.length; i++) await new Promise((res) => setTimeout(res, 10));
  await new Promise((res) => srv.close(res));
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].status, 'error', JSON.stringify(r.replies));
  assert.match(r.replies[0].error, /dòng kết quả cuối/);
});

await t('rút gọn sau: trả kết quả ngay khi có dòng kết quả (không chờ hết stream), rồi chuyển dòng { condensed } cho tab; trả lời đúng một lần kể cả khi stream bị ngắt sau đó', async () => {
  const fin = { status: 'ok', cues: [{ start: 1, end: 2, vi: 'Dòng rất dài' }, { start: 3, end: 4, vi: 'B' }] };
  const short = [{ ...fin.cues[0], vi: 'Ngắn' }, fin.cues[1]];
  let ended = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const p = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      res.write(JSON.stringify({ partial: [fin.cues[0]] }) + '\n' + JSON.stringify(fin) + '\n');
      if (p.cut) return setTimeout(() => res.destroy(), 150);   // ngắt giữa lúc chờ bản rút gọn
      setTimeout(() => { ended = Date.now(); res.end(JSON.stringify({ condensed: short }) + '\n'); }, 300);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const toTab = [];
  const send = load(toTab);
  const r = send({ type: 'subtitles', server: base, key: '7500000000000000006:1', payload: { id: '7500000000000000006', stream: true, condenseLater: true } });
  const cut = send({ type: 'subtitles', server: base, key: '7500000000000000006:2', payload: { id: '7500000000000000006', stream: true, condenseLater: true, cut: true } });
  for (let i = 0; i < 100 && !r.replies.length; i++) await new Promise((res) => setTimeout(res, 10));
  assert.equal(JSON.stringify(r.replies), JSON.stringify([fin]));
  assert.equal(ended, 0, 'câu trả lời phải tới trước khi server gửi xong bản rút gọn');
  for (let i = 0; i < 100 && !toTab.some((m) => m.type === 'condensed'); i++) await new Promise((res) => setTimeout(res, 10));
  await new Promise((res) => setTimeout(res, 100));
  await new Promise((res) => srv.close(res));
  assert.deepEqual(toTab.filter((m) => m.type === 'condensed').map((m) => [m.key, m.cues.map((c) => c.vi).join('|')]), [['7500000000000000006:1', 'Ngắn|B']]);
  assert.equal(JSON.stringify(cut.replies), JSON.stringify([fin]), 'stream bị ngắt sau dòng kết quả: không trả lời lần hai');
  assert.deepEqual(unhandled.map(String), []);
});

await t('hello: trả bản của background.js, bằng version trong manifest.json (content.js so để biết service worker có phải bản cũ không); không gọi server', async () => {
  const s = await startServer();
  const send = load();
  const r = send({ type: 'hello' });
  await settle(s.got, 0);
  await s.close();
  assert.equal(r.ret, false);
  assert.equal(JSON.stringify(r.replies), JSON.stringify([{ build: VERSION, ndjson: true, condensed: true }]), 'bản trong background.js khác manifest.json (' + VERSION + '): đổi cả hai khi tăng bản');
  assert.deepEqual(s.got, []);
});

await t('ngôn ngữ đích: dòng { partial, target } và { condensed, target } chuyển cho tab kèm target; dòng không có target (server cũ) thì không thêm', async () => {
  const fin = { status: 'ok', target: 'en', cues: [{ start: 1, end: 2, vi: 'Hello' }] };
  const srv = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      res.write(JSON.stringify({ partial: fin.cues, target: 'en' }) + '\n' + JSON.stringify({ partial: fin.cues }) + '\n' + JSON.stringify(fin) + '\n');
      setTimeout(() => res.end(JSON.stringify({ condensed: fin.cues, target: 'en' }) + '\n'), 30);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const toTab = [];
  const send = load(toTab);
  const r = send({ type: 'subtitles', server: 'http://127.0.0.1:' + srv.address().port, key: '7500000000000000007:0', payload: { id: '7500000000000000007', stream: true, target: 'en' } });
  for (let i = 0; i < 100 && !toTab.some((m) => m.type === 'condensed'); i++) await new Promise((res) => setTimeout(res, 10));
  await new Promise((res) => srv.close(res));
  assert.deepEqual(toTab.map((m) => [m.type, 'target' in m ? m.target : '-']), [['partial', 'en'], ['partial', '-'], ['condensed', 'en']]);
  assert.equal(r.replies[0].target, 'en');
});

console.log(failed ? `\n${failed} kiểm tra trượt, ${n} đạt.` : `\n${n} kiểm tra đều đạt.`);
if (failed) process.exit(1);

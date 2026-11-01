// Kiểm tra alpha/extension/background.js (không cần trình duyệt): chạy nó trong vm với fetch thật của Node, gửi tới một
// server HTTP thử trên 127.0.0.1 (cổng ngẫu nhiên) nhận request theo cùng luật với alpha/server/server.mjs (rejectForeign:
// Origin chrome-extension:// hay không có Origin, content-type application/json; sai thì 415).   Chạy: node alpha/dev/background-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const SRC = fs.readFileSync(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'extension', 'background.js'), 'utf8');
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
function load() {
  let listener = null;
  const ctx = { chrome: { runtime: { onMessage: { addListener: (f) => { listener = f; } } } }, AbortController, fetch };
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

console.log(failed ? `\n${failed} kiểm tra trượt, ${n} đạt.` : `\n${n} kiểm tra đều đạt.`);
if (failed) process.exit(1);

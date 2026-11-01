// Kiểm tra alpha/extension/tap.main.js đọc response API của trang (không cần mạng, không cần trình duyệt).
// Dùng Response thật của Node (clone là tee thật, thân tới từng khúc 64 KB), cả fetch lẫn XHR.
// Thân chia khúc theo khuôn đo trên /general/search/stream/ của Douyin thật 01/11. Chạy: node alpha/dev/tap-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'extension', 'tap.main.js'), 'utf8');
const aw = (id) => ({ aweme_id: id, duration: 12000, video: { play_addr: { uri: 'v0d00f' + id, url_list: ['x'] }, bit_rate: [] } });
// dòng độ dài hex, xuống dòng, một khối JSON gọn, xuống dòng, …
const chunked = (docs) => docs.map(d => { const j = JSON.stringify(d); return Buffer.byteLength(j).toString(16) + '\n' + j + '\n'; }).join('');
const STREAM = chunked([{ status_code: 0, data: [{ type: 1, aweme_info: aw('11') }] }, { status_code: 0, data: [{ type: 1, aweme_info: aw('12') }] },
  { status_code: 0, has_more: 1, cursor: 2 }]);
const SINGLE = JSON.stringify({ status_code: 0, data: [{ type: 1, aweme_info: aw('13') }] });
const BROKEN = '1a\n{"status_code":0,"data":[{"aweme_info"\n';
const STREAM_URL = 'https://www.douyin.com/aweme/v1/web/general/search/stream/?keyword=x';
const SINGLE_URL = 'https://www.douyin.com/aweme/v1/web/general/search/single/?keyword=x&offset=10';
const settle = () => new Promise(r => setTimeout(r, 30));

function makeTap() {
  const env = { up: [], timers: [], listeners: {}, bodies: {} };
  class XHR {
    open() {}
    send() {}
    addEventListener(t, f) { (this.l = this.l || {})[t] = [...(this.l[t] || []), f]; }
    fire(t) { for (const f of (this.l && this.l[t]) || []) f(); }
  }
  // Trang gọi fetch: thân tới từng khúc 64 KB; hold = chưa đóng thân cho tới khi gọi env.finish(url).
  const fetch = (url, hold) => {
    const bytes = Buffer.from(env.bodies[url]);
    let off = 0;
    const closed = hold ? new Promise(r => { env.finish = r; }) : Promise.resolve();
    const rs = new ReadableStream({ async pull(c) {
      if (off < bytes.length) return c.enqueue(new Uint8Array(bytes.subarray(off, off += 65536)));
      await closed; c.close();
    } });
    return Promise.resolve(new Response(rs, { headers: { 'content-type': 'application/json' } }));
  };
  const ctx = {
    location: new URL('https://www.douyin.com/search/x'), URL, JSON, console, XMLHttpRequest: XHR, fetch,
    setTimeout: (f) => { env.timers.push(f); return 0; }, setInterval: () => 0, requestAnimationFrame: () => 0, performance: { now: () => 0 },
    document: { addEventListener: () => {}, getElementById: () => null },
    addEventListener: (t, f) => { env.listeners[t] = f; },
    dispatchEvent: (ev) => { if (ev.type === '__tod_alpha_up') env.up.push(JSON.parse(ev.detail)); },
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  env.listeners.__tod_alpha_down({ detail: JSON.stringify({ type: 'ready' }) });
  // Trang tự đọc response gốc đến hết (như trang thật).
  env.get = async (url, body, hold) => { env.bodies[url] = body; const r = await ctx.fetch(url, hold); return r.text(); };
  env.xhr = (url, text) => { const x = new XHR(); x.open('GET', url); x.send(); x.responseType = ''; x.responseText = text; return x; };
  env.of = (type) => env.up.filter(m => m.type === type).map(m => m.data);
  env.ids = () => env.of('items').flat().map(it => it.id + ':' + it.feed);
  return env;
}

let n = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); n++; console.log('PASS ' + name); } catch (e) { failed++; console.log('FAIL ' + name + '\n     ' + String(e.message).split('\n')[0]); }
};

await t('fetch: thân search/stream chia khúc → item của mọi khối, danh sách "search"; JSON thường như cũ', async () => {
  const env = makeTap();
  assert.equal(await env.get(STREAM_URL, STREAM), STREAM);   // trang vẫn đọc đủ response gốc
  await settle();
  assert.deepEqual(env.ids(), ['11:search', '12:search']);
  assert.deepEqual(env.of('endpoint'), [{ path: '/aweme/v1/web/general/search/stream', known: true, via: 'fetch', items: 2, chunked: true, docs: 3 }]);
  assert.deepEqual(env.of('parse_error'), []);
  await env.get(SINGLE_URL, SINGLE);
  await settle();
  assert.deepEqual(env.ids(), ['11:search', '12:search', '13:search']);
  assert.deepEqual(env.of('endpoint')[1], { path: '/aweme/v1/web/general/search/single', known: true, via: 'fetch', items: 1 });
});

await t('XHR (responseType ""): thân chia khúc → item danh sách "search"; thân hỏng hẳn (fetch, XHR) vẫn ra parse_error', async () => {
  const env = makeTap();
  const x = env.xhr(STREAM_URL, STREAM);
  x.fire('load'); x.fire('loadend');
  assert.deepEqual(env.ids(), ['11:search', '12:search']);
  assert.equal(env.of('endpoint')[0].chunked, true);
  const bad = makeTap();
  const y = bad.xhr(STREAM_URL, BROKEN);
  y.fire('load'); y.fire('loadend');
  await bad.get(STREAM_URL, BROKEN);
  await bad.get(STREAM_URL, '<html>{oops</html>');
  await settle();
  assert.deepEqual(bad.of('parse_error').map(e => e.via), ['xhr', 'fetch', 'fetch']);
  assert.deepEqual(bad.of('items'), []);
});

await t('search/single đọc xong trước search/stream: item gửi sang content.js vẫn theo thứ tự trang (stream trước)', async () => {
  // content.js xếp danh sách theo thứ tự nhận: single trước thì video cuối của single dịch sẵn nhầm các kết quả đầu.
  const env = makeTap();
  const stream = env.get(STREAM_URL, STREAM, true);
  await settle();
  await env.get(SINGLE_URL, SINGLE);
  await settle();
  assert.deepEqual(env.ids(), [], 'single giữ lại trong lúc stream còn đang đọc');
  env.finish(); await stream; await settle();
  assert.deepEqual(env.ids(), ['11:search', '12:search', '13:search']);

  // Qua XHR cũng vậy.
  const ex = makeTap();
  const x = ex.xhr(STREAM_URL, STREAM);
  await ex.get(SINGLE_URL, SINGLE); await settle();
  assert.deepEqual(ex.ids(), []);
  x.fire('load'); x.fire('loadend');
  assert.deepEqual(ex.ids(), ['11:search', '12:search', '13:search']);

  // stream hỏng hẳn: single vẫn được gửi khi stream xong.
  const eb = makeTap();
  const sb = eb.get(STREAM_URL, BROKEN, true);
  await settle(); await eb.get(SINGLE_URL, SINGLE); await settle();
  eb.finish(); await sb; await settle();
  assert.deepEqual(eb.of('parse_error').length, 1);
  assert.deepEqual(eb.ids(), ['13:search']);

  // stream treo: hết hạn giữ (20 s) thì single được gửi, không chờ mãi.
  const eh = makeTap();
  eh.get(STREAM_URL, STREAM, true);
  await settle(); await eh.get(SINGLE_URL, SINGLE); await settle();
  assert.deepEqual(eh.ids(), []);
  for (const f of eh.timers.splice(0)) f();
  assert.deepEqual(eh.ids(), ['13:search']);
});

console.log(failed ? `\n${failed} kiểm tra trượt, ${n} đạt.` : `\n${n} kiểm tra đều đạt.`);
process.exit(failed ? 1 : 0);

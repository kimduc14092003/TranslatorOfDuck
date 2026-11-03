// Bộ ghi CHỈ ĐỌC cho Chromium chủ dự án đang dùng (mở với --remote-debugging-port, mặc định 9333): mỗi 250 ms video đang
// xem, chỗ đang phát, nhãn, sub; mỗi 2 s trạng thái extension (status); mọi lượt tải video (CDP Network: Range, byte, ai gọi).
// Không bấm, không điều khiển trang. Ghi tới khi dừng (Ctrl+C).   node rec.mjs [tên] [--port 9333]
// Ra alpha/server/work/real/rec/<tên>.jsonl và <tên>.net.jsonl; có chữ sub của video: chỉ để trên máy, xoá khi xong.
import fs from 'node:fs';
import path from 'node:path';
import { OUT_ROOT, PAGE_STATE, args, playwright, sleep } from './lib.mjs';

const a = args();
const name = a._[0] || 'trial';
const dir = path.join(OUT_ROOT, 'rec');
fs.mkdirSync(dir, { recursive: true });
const sampOut = fs.createWriteStream(path.join(dir, name + '.jsonl'), { flags: 'a' });
const netOut = fs.createWriteStream(path.join(dir, name + '.net.jsonl'), { flags: 'a' });
const b = await playwright().chromium.connectOverCDP(`http://127.0.0.1:${a.port || 9333}`);
const ctx = b.contexts()[0];
let sw = null;
async function worker() {
  if (sw && ctx.serviceWorkers().includes(sw)) return sw;
  sw = null;
  for (const w of ctx.serviceWorkers()) if (/^TranslatorOfDuck/.test(await w.evaluate(() => chrome.runtime.getManifest().name).catch(() => ''))) sw = w;
  return sw;
}
let netPage = null, pageCdp = null;
const reqs = new Map(), isoCtx = new Map();   // executionContextId -> tên (tìm thế giới riêng của content script)
async function watchNet(page) {
  if (netPage === page) return;
  netPage = page;
  const cdp = pageCdp = await ctx.newCDPSession(page);
  cdp.on('Runtime.executionContextCreated', (e) => { if (e.context.auxData && e.context.auxData.type === 'isolated') isoCtx.set(e.context.id, e.context.name); });
  cdp.on('Runtime.executionContextDestroyed', (e) => isoCtx.delete(e.executionContextId));
  cdp.on('Runtime.executionContextsCleared', () => isoCtx.clear());
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', (e) => {
    const u = e.request.url;
    if (!/douyinvod|zjcdn|bytecdn|\/aweme\/v1\/play|mime_type=video/.test(u)) return;
    const frames = ((e.initiator && e.initiator.stack && e.initiator.stack.callFrames) || []).map((f) => f.url.split('/').pop());
    let host = '?'; try { host = new URL(u).host; } catch (_) {}
    if (reqs.has(e.requestId) && e.redirectResponse) { netOut.write(JSON.stringify({ ev: 'redirect', at: Date.now(), id: e.requestId, host }) + '\n'); return; }
    reqs.set(e.requestId, { bytes: 0 });
    netOut.write(JSON.stringify({ ev: 'req', at: Date.now(), id: e.requestId, who: frames.includes('content.js') ? 'ext' : 'page', host,
      range: e.request.headers.Range || e.request.headers.range || null, play: /aweme\/v1\/play/.test(u), uri: (/video_id=([^&]+)/.exec(u) || [])[1] || null }) + '\n');
  });
  cdp.on('Network.responseReceived', (e) => { if (reqs.has(e.requestId)) netOut.write(JSON.stringify({ ev: 'res', at: Date.now(), id: e.requestId, status: e.response.status, cr: e.response.headers['content-range'] || e.response.headers['Content-Range'] || null }) + '\n'); });
  cdp.on('Network.dataReceived', (e) => { const r = reqs.get(e.requestId); if (r) r.bytes += e.dataLength; });
  cdp.on('Network.loadingFinished', (e) => { const r = reqs.get(e.requestId); if (r) { netOut.write(JSON.stringify({ ev: 'end', at: Date.now(), id: e.requestId, bytes: r.bytes }) + '\n'); reqs.delete(e.requestId); } });
  cdp.on('Network.loadingFailed', (e) => { const r = reqs.get(e.requestId); if (r) { netOut.write(JSON.stringify({ ev: 'fail', at: Date.now(), id: e.requestId, bytes: r.bytes, err: e.errorText, canceled: !!e.canceled }) + '\n'); reqs.delete(e.requestId); } });
}
console.log('Đang ghi vào', path.join(dir, name + '.jsonl'), '(Ctrl+C để dừng). Có chữ sub của video: xem xong thì xoá.');
for (let n = 0; ; n++) {
  const page = ctx.pages().find((p) => /douyin\.com/.test(p.url()));
  if (!page) { await sleep(1000); continue; }
  await watchNet(page).catch(() => {});
  const s = await page.evaluate(PAGE_STATE).catch((e) => ({ err: String(e.message).slice(0, 80) }));
  let status = null;
  if (n % 8 === 0) {
    const w = await worker();
    // Worker ngủ: đánh thức bằng tin "cancel" rỗng từ thế giới của content script (không huỷ gì), rồi hỏi ở lượt sau.
    if (!w && pageCdp) {
      const c = [...isoCtx].find(([, nm]) => /TranslatorOfDuck/i.test(nm));
      if (c) await pageCdp.send('Runtime.evaluate', { contextId: c[0], expression: "chrome.runtime.sendMessage({type:'cancel',keys:[]}).catch(()=>{}); 1" }).catch(() => {});
    }
    if (w) status = await w.evaluate(async () => { for (const t of await chrome.tabs.query({})) { try { const r = await chrome.tabs.sendMessage(t.id, { type: 'status' }); if (r) return r; } catch (_) {} } return null; }).catch(() => null);
  }
  sampOut.write(JSON.stringify({ at: Date.now(), ...s, ...(status ? { worker: status.worker, counts: status.counts, cur: status.cur && { id: status.cur.id, chunks: status.cur.chunks }, marks: (status.marks || []).slice(-2) } : {}) }) + '\n');
  await sleep(250);
}

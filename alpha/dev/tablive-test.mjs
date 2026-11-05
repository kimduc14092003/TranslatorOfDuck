// Kiểm tra đường dự phòng cho trang bất kỳ (bản thử): hàm chung trong extension/tablive.js, và phần background.js bật thu âm
// thanh tab, chuyển tin giữa trang ẩn (offscreen.js) và tab. Không cần trình duyệt.   Chạy: node alpha/dev/tablive-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'extension');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, 'tablive.js'), 'utf8'), ctx);
const L = ctx.TodLive;

let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('PASS ' + name); };

await t('khúc thu: liền nhau, không hở; mỗi khúc thu dư hai đầu, khúc đầu không bắt đầu trước 0', () => {
  const ws = [0, 1, 2, 3].map(k => L.windowOf(k));
  assert.deepEqual(ws.map(w => [w.from, w.to]), [[0, 5], [5, 10], [10, 15], [15, 20]]);
  assert.equal(ws[0].recStart, 0);
  for (const w of ws.slice(1)) assert.ok(w.recStart < w.from && w.recStop > w.to);
  // Khúc sau bắt đầu thu trước khi khúc trước dừng: không có quãng nào không được thu.
  for (let i = 1; i < ws.length; i++) assert.ok(ws[i].recStart < ws[i - 1].recStop);
});

await t('độ trễ hiển thị: dòng về muộn thì tăng (tròn 0,5 s, tối đa 20 s), về sớm thì giữ', () => {
  assert.equal(L.nextDelay(6000, 0, 4000), 6000);
  assert.equal(L.nextDelay(6000, 0, 7200), 8000);
  assert.equal(L.nextDelay(6000, 0, 60000), 20000);
});

await t('khúc im lặng: không gửi; có tiếng ở bất kỳ lúc nào trong khúc: gửi; không có mẫu mức âm: gửi', () => {
  const lv = [[0, 0.001], [1, 0.002], [2, 0.003], [3, 0.2], [4, 0.001]];
  assert.equal(L.silent(lv, 0, 2.5), true);
  assert.equal(L.silent(lv, 0, 4), false);
  assert.equal(L.silent([], 0, 4), false);
});

await t('dòng đang hiện: dòng mới nhất đã tới giờ, còn trong thời gian của nó (dòng ngắn giữ ít nhất 1,2 s)', () => {
  const cues = [{ at: 1000, until: 1500, text: 'a' }, { at: 3000, until: 6000, text: 'b' }];
  assert.equal(L.current(cues, 500), null);
  assert.equal(L.current(cues, 2100).text, 'a');
  assert.equal(L.current(cues, 2300), null);
  assert.equal(L.current(cues, 4000).text, 'b');
});

// background.js với chrome giả: ghi lại các lời gọi.
function loadBackground() {
  const calls = [], toTab = [], session = {};
  let listener = null, hasDoc = false;
  const chrome = {
    runtime: {
      onMessage: { addListener: (f) => { listener = f; } },
      sendMessage: async (m) => { calls.push(['runtime', m]); return m.type === 'start' ? { ok: true } : m.type === 'status' ? { on: true, tabId: 7, sent: 3 } : { ok: true }; },
    },
    tabs: { sendMessage: (tab, m) => { toTab.push({ tab, ...m }); return Promise.resolve(); }, get: async (id) => ({ id, title: 'A page' }), onUpdated: { addListener: () => {} } },
    tabCapture: { getMediaStreamId: async (o) => { calls.push(['capture', o]); return 'stream-1'; } },
    offscreen: { hasDocument: async () => hasDoc, createDocument: async (o) => { calls.push(['offscreen', o]); hasDoc = true; } },
    scripting: { executeScript: async (o) => { calls.push(['inject', o]); } },
    storage: { local: { get: async () => ({ settings: { target: 'en', server: 'http://127.0.0.1:8787' } }) },
      session: { set: async (o) => Object.assign(session, o), get: async () => session, remove: async (k) => { delete session[k]; } } },
  };
  const c = { chrome, AbortController, fetch, TextDecoder };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), c);
  const send = (msg, sender = {}) => new Promise((resolve) => { const ret = listener(msg, sender, resolve); if (ret !== true) resolve(undefined); });
  return { send, calls, toTab, session };
}

await t('popup bật: lấy mã luồng thu của tab, mở trang ẩn, tiêm lớp sub, gửi cài đặt cho trang ẩn, nhớ tab đang thu', async () => {
  const b = loadBackground();
  const r = await b.send({ type: 'tab-start', tabId: 7 });
  assert.equal(JSON.stringify(r), '{"ok":true}');
  assert.deepEqual(b.calls.map(c => c[0]), ['capture', 'offscreen', 'inject', 'runtime']);
  assert.equal(b.calls[0][1].targetTabId, 7);
  assert.equal(JSON.stringify(b.calls[1][1].reasons), '["USER_MEDIA"]');
  assert.equal(JSON.stringify(b.calls[2][1].files), '["tablive.js","tab.js"]');
  const start = b.calls[3][1];
  assert.equal(start.to, 'offscreen'); assert.equal(start.streamId, 'stream-1'); assert.equal(start.settings.target, 'en'); assert.equal(start.title, 'A page');
  assert.equal(b.session.liveTab, 7);
});

await t('tin của trang ẩn chuyển cho đúng tab (tab-cues, tab-state); tắt thì quên tab đang thu; tin từ tab không được giả làm trang ẩn', async () => {
  const b = loadBackground();
  await b.send({ type: 'tab-start', tabId: 7 });
  await b.send({ to: 'background', type: 'cues', tabId: 7, cues: [{ start: 1, end: 2, vi: 'x' }], wall0: 5 });
  await b.send({ to: 'background', type: 'cues', tabId: 9, cues: [] }, { tab: { id: 9 } });
  await b.send({ to: 'background', type: 'state', tabId: 7, on: false });
  assert.deepEqual(b.toTab.map(m => [m.tab, m.type]), [[7, 'tab-cues'], [7, 'tab-state']]);
  assert.equal(b.toTab[0].wall0, 5);
  assert.equal(b.session.liveTab, undefined);
});

await t('trạng thái: hỏi trang ẩn khi có; chưa có trang ẩn thì tắt', async () => {
  const b = loadBackground();
  assert.equal(JSON.stringify(await b.send({ type: 'tab-status' })), '{"on":false}');
  await b.send({ type: 'tab-start', tabId: 7 });
  assert.equal((await b.send({ type: 'tab-status' })).sent, 3);
});

console.log(`\n${n} kiểm tra đều đạt.`);

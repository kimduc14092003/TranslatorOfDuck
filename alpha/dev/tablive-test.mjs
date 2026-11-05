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

await t('kế hoạch gửi: chờ đủ 5 s chưa dịch và 2 s âm thanh mới; gửi từ con trỏ, âm thanh dư 1,5 s phía trước', () => {
  assert.equal(L.plan(0, 0, 4.9), null);
  assert.equal(JSON.stringify(L.plan(0, 0, 5.04)), JSON.stringify({ from: 0, to: 5, audioFrom: 0, final: false }));
  // Câu cuối bị giữ lại ở 8,2: lần sau gửi lại từ 7,9 khi đã có thêm 2 s mới và phần chưa dịch đủ 5 s.
  assert.equal(L.plan(8.2, 10, 11.5), null);
  assert.equal(L.plan(8.2, 10, 13.25).from, 8.2);
  assert.equal(L.plan(8.2, 10, 13.25).audioFrom.toFixed(1), '6.7');
  // Một câu dài mãi không hết: sau 15 s thì gửi final (server dịch hết).
  assert.equal(L.plan(20, 33, 35.1).final, true);
});

await t('khoảng ngừng nói: tìm cái gần cuối nhất trong 2,5 s cuối; nói liền (không ngừng) thì không có', () => {
  const R = L.RATE, tone = (sec, amp) => Array.from({ length: Math.round(sec * R) }, (_, i) => Math.round(amp * Math.sin(i / 3)));
  // nói 3 s, ngừng 0,6 s (từ 3 tới 3,6), nói tiếp 1 s
  const a = new Int16Array([...tone(3, 8000), ...tone(0.6, 50), ...tone(1, 8000)]);
  const p = L.findPause(a);
  assert.ok(p > 3 && p < 3.6, String(p));
  assert.equal(L.findPause(new Int16Array(tone(5, 8000))), null);
  // ngừng xa hơn 2,5 s trước cuối: không tính
  assert.equal(L.findPause(new Int16Array([...tone(1, 8000), ...tone(0.5, 50), ...tone(3, 8000)])), null);
});

await t('con trỏ sau lần gửi: dời tới next server trả (không lùi, không vượt to); lỗi hay server cũ: tới to', () => {
  assert.equal(L.advance(5, 12, { next: 9.4 }), 9.4);
  assert.equal(L.advance(5, 12, { next: 3 }), 5);
  assert.equal(L.advance(5, 12, { next: 20 }), 12);
  assert.equal(L.advance(5, 12, null), 12);
  assert.equal(L.advance(5, 12, {}), 12);
});

await t('WAV 16 bit một kênh 16 kHz; mức to nhất để bỏ khúc im lặng', () => {
  const pcm = new Int16Array([0, 1000, -32768, 32767]);
  const w = L.wav(pcm);
  assert.equal(w.length, 44 + 8);
  assert.equal(String.fromCharCode(...w.slice(0, 4)) + String.fromCharCode(...w.slice(8, 12)), 'RIFFWAVE');
  const v = new DataView(w.buffer);
  assert.equal(v.getUint32(24, true), 16000); assert.equal(v.getUint16(34, true), 16); assert.equal(v.getInt16(46, true), 1000);
  assert.ok(L.peak(new Int16Array([10, -200, 50])) < L.QUIET);
  assert.ok(L.peak(pcm) > 0.99);
});

await t('độ trễ hiển thị: dòng về muộn thì tăng (tròn 0,5 s, tối đa 20 s), về sớm thì giữ', () => {
  assert.equal(L.nextDelay(6000, 0, 4000), 6000);
  assert.equal(L.nextDelay(6000, 0, 7200), 8000);
  assert.equal(L.nextDelay(6000, 0, 60000), 20000);
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

// Kiểm bộ đọc chung (dịch trước trên trang bất kỳ): extension/fmp4.js đọc mốc thời gian các mẩu MP4 phân mảnh (như trình phát của
// TikTok, Instagram nạp), trên file thật do ffmpeg tạo; background.js bật, tắt bộ đọc cho một trang.   Chạy: node alpha/dev/web-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(HERE, '..', 'extension');
const ffmpeg = process.env.FFMPEG || (await import(path.join(HERE, '..', 'server', 'node_modules', 'ffmpeg-static', 'index.js')).then((m) => m.default).catch(() => 'ffmpeg'));
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(EXT, 'fmp4.js'), 'utf8'), ctx);
const F = ctx.TodFmp4;
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log('PASS ' + name); };

// fMP4 âm thanh AAC 12 s, mỗi mảnh ~1 s (ffmpeg ghi -output_ts_offset vào edit list, tfdt vẫn từ 0; trên trang, độ lệch là
// SourceBuffer.timestampOffset mà msehook.main.js gửi kèm).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-web-'));
const file = path.join(TMP, 'a.mp4');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:a', 'aac', '-output_ts_offset', '30',
  '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', file]);
const buf = new Uint8Array(fs.readFileSync(file));
// Tách như trình phát nạp: init (ftyp + moov), rồi từng cặp moof + mdat.
const dv = new DataView(buf.buffer);
const tops = [];
for (let o = 0; o + 8 <= buf.length;) { const size = dv.getUint32(o); tops.push({ type: String.fromCharCode(...buf.slice(o + 4, o + 8)), at: o, size }); o += size; }
const moovEnd = tops.find((b) => b.type === 'moov');
const init = buf.slice(0, moovEnd.at + moovEnd.size);
const frags = [];
for (let i = 0; i < tops.length; i++) if (tops[i].type === 'moof') frags.push(buf.slice(tops[i].at, tops[i + 1].at + tops[i + 1].size));

await t('mẩu init: thước thời gian của track âm thanh; mẩu thường không phải init', () => {
  const info = F.readInit(init);
  assert.ok(info && info.timescale > 0, JSON.stringify(info));
  assert.equal(F.readInit(frags[0]), null);
});
await t('mẩu thường: mốc bắt đầu (tfdt) và độ dài (trun), liền nhau, phủ 0–12 s', () => {
  const info = F.readInit(init);
  const segs = frags.flatMap((f) => F.readSegments(f, info));
  assert.ok(segs.length >= 6, String(segs.length));
  assert.ok(Math.abs(segs[0].start) < 0.1, String(segs[0].start));
  for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(segs[i].start - segs[i - 1].end) < 0.03, `${segs[i - 1].end} → ${segs[i].start}`);
  assert.ok(Math.abs(segs.at(-1).end - 12) < 0.2, String(segs.at(-1).end));
  // Vị trí byte: moof tới hết mdat của chính mảnh đó.
  const f0 = frags[0], g = F.readSegments(f0, info)[0];
  assert.equal(g.byteStart, 0); assert.equal(g.byteEnd, f0.length);
  const two = new Uint8Array([...frags[0], ...frags[1]]), gg = F.readSegments(two, info);
  assert.equal(gg.length, 2); assert.equal(gg[1].byteStart, frags[0].length); assert.equal(gg[1].byteEnd, two.length);
});

// background.js: bật bộ đọc cho một trang (đăng ký script, tải lại tab); trang chặn chặt thì không.
function loadBackground(granted = true) {
  let listener = null;
  const reg = [], reloads = [], offs = [];
  const chrome = { runtime: { onMessage: { addListener: (f) => { listener = f; } }, sendMessage: async () => ({}) },
    tabs: { sendMessage: async (id, m) => { offs.push([id, m.type]); }, query: async () => [{ id: 5 }, { id: 9 }], get: async () => ({}), reload: async (id) => { reloads.push(id); }, onUpdated: { addListener: () => {} } },
    permissions: { contains: async () => granted },
    scripting: { executeScript: async () => {}, getRegisteredContentScripts: async ({ ids }) => reg.filter((x) => ids.includes(x.id)),
      registerContentScripts: async (xs) => { reg.push(...xs); }, unregisterContentScripts: async ({ ids }) => { for (const id of ids) reg.splice(reg.findIndex((x) => x.id === id), 1); } },
    storage: { local: { get: async () => ({}) }, session: { get: async () => ({}), set: async () => {}, remove: async () => {} } } };
  const c = { chrome, AbortController, fetch, TextDecoder, URL };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(EXT, 'background.js'), 'utf8'), c);
  const send = (msg) => new Promise((resolve) => { const ret = listener(msg, {}, resolve); if (ret !== true) resolve(undefined); });
  return { send, reg, reloads, offs };
}
await t('bật cho một trang: đăng ký bộ đọc (thế giới trang + extension) đúng trang đó, tải lại tab; tắt thì gỡ', async () => {
  const b = loadBackground();
  const r = await b.send({ type: 'web-enable', origin: 'https://www.tiktok.com', tabId: 5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(b.reg.length, 2);
  const main = b.reg.find((x) => x.world === 'MAIN'), iso = b.reg.find((x) => x.world !== 'MAIN');
  assert.equal(JSON.stringify(main.js), '["msehook.main.js"]'); assert.equal(main.runAt, 'document_start');
  assert.equal(JSON.stringify(iso.js), '["fmp4.js","web.js"]');
  assert.equal(JSON.stringify(main.matches), '["https://www.tiktok.com/*"]');
  assert.equal(JSON.stringify(b.reloads), '[5]');
  assert.equal((await b.send({ type: 'web-status', origin: 'https://www.tiktok.com' })).on, true);
  await b.send({ type: 'web-disable', origin: 'https://www.tiktok.com', tabId: 5 });
  assert.equal(b.reg.length, 0);
  assert.equal(JSON.stringify(b.offs), '[[5,"web-off"],[9,"web-off"]]');
  // Hai trang khác nhau không trùng mã đăng ký.
  const c = loadBackground();
  await c.send({ type: 'web-enable', origin: 'https://a-b.example', tabId: 1 });
  await c.send({ type: 'web-enable', origin: 'https://a.b.example', tabId: 1 });
  assert.equal(c.reg.length, 4);
});
await t('trang chặn chặt (YouTube, Netflix) và Douyin: không bật; chưa được cấp quyền: không bật', async () => {
  for (const o of ['https://www.youtube.com', 'https://m.youtube.com', 'https://www.youtube-nocookie.com', 'https://www.netflix.com', 'https://www.douyin.com']) {
    const b = loadBackground();
    const r = await b.send({ type: 'web-enable', origin: o, tabId: 1 });
    assert.equal(r.ok, false, o); assert.equal(b.reg.length, 0, o);
  }
  const b = loadBackground(false);
  assert.equal((await b.send({ type: 'web-enable', origin: 'https://www.instagram.com', tabId: 1 })).ok, false);
  assert.equal(b.reg.length, 0);
});
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${n} kiểm tra đều đạt.`);

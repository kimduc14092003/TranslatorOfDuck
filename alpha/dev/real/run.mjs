// Chạy bộ video thử (videos.json) và chấm bảng điểm (docs/ROADMAP.md §3). Mỗi video: một server đo riêng với cache trống
// (cổng 8788, giữ file nhận dạng để chạy lại offline), một proxy ghi yêu cầu (8789), một Chromium riêng (9334); xem lần
// lượt ở tốc độ 1×. Xong mỗi video thì xoá dữ liệu của nó (âm thanh, chữ), chỉ giữ điểm số trong summary.json và history.jsonl.
//   node run.mjs [--items 1,3] [--ids id1,id2] [--rate 1] [--throttle KB/s] [--lyrics off] [--target vi|en] [--switch-at giây] [--name tên] [--keep]
//   node run.mjs --clean <tên>      xoá dữ liệu của một lượt đã chạy với --keep
// --items: số thứ tự mục trong videos.json (một id có thể có hai mục). Không có --items, --ids: chạy cả videos.json.
// Mục có "from"/"to" thì tua tới "from" và xem tới "to". TỐN TIỀN nhận dạng và dịch: cả bộ khoảng 29 phút âm thanh.
import fs from 'node:fs';
import path from 'node:path';
import { HERE, OUT_ROOT, args, readJson, readJsonl, rmrf, startProxy, startServer } from './lib.mjs';
import { print, quant, report } from './report.mjs';
import { watchVideo } from './watch.mjs';

const a = args();
// Thư mục dữ liệu video (tên bắt đầu bằng id); lượt chạy với --keep có tệp "kept".
const videoDirs = (root) => (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((f) => /^\d{6,}/.test(f)).map((f) => path.join(root, f));
if (a.clean) { for (const d of videoDirs(path.join(OUT_ROOT, String(a.clean)))) rmrf(d); rmrf(path.join(OUT_ROOT, String(a.clean), 'kept')); console.log('Đã xoá dữ liệu video của lượt', a.clean); process.exit(0); }
// Dữ liệu còn sót của lượt run.mjs trước bị dừng giữa chừng (có tệp "run", không có "kept"): xoá trước khi chạy. Không đụng
// thư mục khác (kết quả watch, scroll, rec).
for (const r of fs.existsSync(OUT_ROOT) ? fs.readdirSync(OUT_ROOT).map((f) => path.join(OUT_ROOT, f)) : []) {
  if (fs.existsSync(path.join(r, 'run')) && !fs.existsSync(path.join(r, 'kept'))) for (const d of videoDirs(r)) { rmrf(d); console.log('Xoá dữ liệu còn sót:', d); }
}

const set = readJson(path.join(HERE, 'videos.json')) || { videos: [] };
const list = a.items ? String(a.items).split(',').map((i) => set.videos[Number(i) - 1]).filter(Boolean)
  : a.ids ? String(a.ids).split(',').map((id) => set.videos.find((v) => v.id === id) || { id }) : set.videos;
const rate = Number(a.rate || 1), throttle = Number(a.throttle || 0), lyrics = a.lyrics == null ? null : a.lyrics !== 'off';
const target = a.target || null, switchAt = a['switch-at'] != null ? Number(a['switch-at']) : null;   // watch.mjs
const name = String(a.name || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'));
const root = path.join(OUT_ROOT, name);
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'run'), '');
if (a.keep) fs.writeFileSync(path.join(root, 'kept'), '');
let current = null;
// Ctrl+C: xoá dữ liệu của video đang đo (trừ khi --keep) rồi thoát.
process.on('SIGINT', () => { if (current && !a.keep) rmrf(current); console.log('\nĐã dừng' + (current && !a.keep ? '; đã xoá dữ liệu của video đang đo' : '')); process.exit(130); });

const rows = [];
for (const [i, v] of list.entries()) {
  const dir = current = path.join(root, `${v.id}-${i + 1}`);
  rmrf(dir);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n== ${i + 1}/${list.length} ${v.id}${v.kind ? ' (' + v.kind + ')' : ''}`);
  let server = null, proxy = null, error = null;
  try {
    server = await startServer({ work: path.join(dir, 'server') });
    proxy = await startProxy({ target: server.url, log: path.join(dir, 'proxy.jsonl') });
    // Thời lượng thật: durationMs extension gửi kèm yêu cầu dịch đầu tiên của video này (qua proxy).
    let duration = null;
    const durationOf = () => duration || (duration = ((readJsonl(proxy.log).find((x) => x.meta && x.meta.id === v.id && x.meta.durationMs) || {}).meta || {}).durationMs / 1000 || null);
    await watchVideo({ id: v.id, out: dir, server: proxy.url, rate, from: v.from || 0, to: v.to ?? Infinity, throttle, lyrics, durationOf, target, switchAt });
  } catch (e) { error = e.message; console.log('LỖI', e.message); }
  finally { if (proxy) await proxy.close(); if (server) await server.stop(); }
  let r = null;
  try { r = report(dir); fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r, null, 1)); console.log(print(r)); } catch (e) { error = error || 'không chấm được: ' + e.message; }
  // Chỉ số, không có chữ của video: giữ được sau khi xoá dữ liệu. Hàng có lỗi không tính là đạt.
  rows.push(r ? { id: v.id, kind: v.kind || null, from: v.from || 0, to: v.to ?? null, error: error || r.error, duration: r.duration, chunks: r.chunks,
    unapproved: r.unapproved, failed: r.failed.length, coverage: r.coverage, correct: r.correct, expected: r.expected, samples: r.samples,
    waitRuns: r.waitRuns, errorRuns: r.errorRuns, platformErrorRuns: r.platformErrorRuns, ttfsS: r.ttfsMs == null ? null : +(r.ttfsMs / 1000).toFixed(1),
    readingWithin: r.readingSpeed.within, condensedLater: r.condensedLater, timing: r.timing, cancelled: r.cancelled.length, cancelledOther: r.cancelledOther, silentGaps: r.silentGaps.length }
    : { id: v.id, kind: v.kind || null, error });
  if (!a.keep && !rmrf(dir)) console.log('Không xoá được', dir, '— xoá tay thư mục này');
  current = null;
}
// Hàng tổng: số chỗ cần duyệt, hiện đúng dòng thấp nhất, sub đầu tiên trung vị và cao nhất.
const ok = rows.filter((r) => !r.error), med = (xs) => { const s = xs.filter((x) => x != null).sort((p, q) => p - q); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const total = { videos: rows.length, errors: rows.length - ok.length, unapproved: ok.reduce((s, r) => s + r.unapproved, 0), failedChunks: ok.reduce((s, r) => s + r.failed, 0),
  correctMin: ok.length ? Math.min(...ok.map((r) => r.correct ?? 100)) : null, waitRuns: ok.reduce((s, r) => s + r.waitRuns, 0),
  errorRuns: ok.reduce((s, r) => s + r.errorRuns, 0), ttfsMedian: med(ok.map((r) => r.ttfsS)), ttfsMax: ok.length ? Math.max(...ok.map((r) => r.ttfsS ?? 0)) : null,
  readingMedian: med(ok.map((r) => r.readingWithin)), cancelled: ok.reduce((s, r) => s + r.cancelled, 0),
  // Đúng nhịp gộp mọi video (mỗi video ít dòng đo được): hiển thị, nhận dạng, Δin.
  timing: Object.fromEntries(['render', 'asr', 'in'].map((k) => [k, quant(ok.flatMap((r) => (r.timing && r.timing.values && r.timing.values[k]) || []))])) };
const summary = { name, at: new Date().toISOString(), rate, throttle: throttle || null, lyrics, target, switchAt, total, rows };
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 1));
fs.appendFileSync(path.join(OUT_ROOT, 'history.jsonl'), JSON.stringify(summary) + '\n');
const cell = (x, w) => String(x ?? '-').padStart(w);
console.log('\nid                  | vế cần duyệt | đoạn lỗi | độ phủ | đúng dòng | chờ | lỗi | sub đầu | đọc đạt | huỷ');
for (const r of rows) {
  if (r.error && r.correct == null) { console.log(`${r.id.padEnd(19)} | LỖI: ${r.error}`); continue; }
  console.log([r.id.padEnd(19), cell(r.unapproved, 12), cell(r.failed, 8), cell(r.coverage, 6), cell(r.correct, 9), cell(r.waitRuns, 3), cell(r.errorRuns, 3), cell(r.ttfsS, 7),
    cell(r.readingWithin, 7), cell(r.cancelled, 4)].join(' | ') + (r.error ? '  LỖI: ' + r.error : ''));
}
console.log(`tổng: ${total.videos} mục, ${total.errors} lỗi, ${total.unapproved} vế cần duyệt, ${total.failedChunks} đoạn lỗi hay dịch ra 0 dòng, đúng dòng thấp nhất ${total.correctMin ?? '-'}%, ` +
  `chờ ${total.waitRuns} lần, lỗi ${total.errorRuns} lần, sub đầu trung vị ${total.ttfsMedian ?? '-'} s (cao nhất ${total.ttfsMax ?? '-'} s), đọc đạt chuẩn (17 ký tự/giây tiếng Việt, 20 tiếng Anh) trung vị ${total.readingMedian ?? '-'}%`);
const T = total.timing, ms = (x) => (x == null ? '-' : Math.round(x * 1000) + ' ms');
console.log(`đúng nhịp gộp: hiển thị trung vị ${ms(T.render.median)} (${T.render.n} dòng); nhận dạng trung vị ${ms(T.asr.median)}, P90 ${ms(T.asr.p90)} (${T.asr.n} dòng); ` +
  `Δin trung vị ${ms(T.in.median)}, P90 ${ms(T.in.p90)}, sớm nhất ${ms(T.in.min)}, ${T.in.within83ms ?? '-'}% trong ±83 ms (${T.in.n} dòng)`);
console.log(a.keep ? `\nĐã giữ dữ liệu video trong ${root}. Xem xong thì xoá: node run.mjs --clean ${name}` : `\nĐã xoá dữ liệu video; điểm số ở ${path.join(root, 'summary.json')}`);
process.exit(0);

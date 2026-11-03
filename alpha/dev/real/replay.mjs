// Chạy lại offline bước cắt theo đoạn, nói hay hát, chia dòng (cuesFromAsr trong alpha/server/pipeline.mjs) trên file nhận
// dạng đã giữ của một lượt đo (server đo chạy với TOD_KEEP_ASR=1: run.mjs --keep). Không gọi nhận dạng, không gọi dịch.
// Dùng để thử một thay đổi của pipeline trên dữ liệu thật: so dòng gốc chạy lại với dòng đã lưu, và số vế câu bị mất.
// Bản chạy lại chưa qua bước dịch: dòng bị bỏ ở bước dịch (debug.mtFix) cũng hiện là "khác".
//   node replay.mjs <thư mục cache> [--id id] [--plain] [--max 20]
// Lưu ý: nạp pipeline.mjs thì pipeline tự đọc alpha/server/.env vào bộ nhớ (không in ra). Agent chạy trên bản sao không có .env.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_DIR, args, cacheFiles, chunksOf, drops, readJson } from './lib.mjs';

const a = args();
const dir = path.resolve(a._[0] || '');
if (!a._[0] || !fs.existsSync(dir)) { console.log('node replay.mjs <thư mục cache> [--id id] [--plain]'); process.exit(1); }
const P = await import(pathToFileURL(path.join(SERVER_DIR, 'pipeline.mjs')).href);
const lyrics = !a.plain;
// Mọi phiên bản: lượt đo cũ vẫn chạy lại được sau khi pipeline tăng PIPELINE_VERSION.
const ids = a.id ? [String(a.id)] : [...new Set(cacheFiles(dir, null).filter((f) => f.kind.startsWith('asr.')).map((f) => f.id))];
let changed = 0, same = 0;
const shown = [];
for (const id of ids) {
  // Mỗi đoạn có thể có nhiều file nhận dạng (gửi lại với phần gửi dư khác): lấy file mới nhất.
  const asr = new Map();
  for (const f of cacheFiles(dir, null).filter((x) => x.id === id && x.kind.startsWith('asr.'))) {
    const k = (f.quick ? 'q' : '') + f.from + '-' + f.to, t = fs.statSync(f.file).mtimeMs;
    if (!asr.has(k) || asr.get(k).t < t) asr.set(k, { f, t });
  }
  const stored = chunksOf(dir, id, lyrics, null);
  const replayed = [];
  for (const [k, { f }] of asr) {
    const x = readJson(f.file);
    if (!x || !x.window) continue;   // file của bản server cũ, không biết vị trí âm thanh
    const w = x.window;
    const prep = P.cuesFromAsr({ desc: w.desc, hashtags: w.hashtags }, x.asr, { offset: w.audioStart, from: w.from, to: w.to, lyrics });
    const cues = (prep.cues || []).map((c) => ({ ...c, vi: '' }));
    replayed.push({ from: w.from, to: w.to, quick: !!w.quick, status: prep.skip ? 'skipped' : 'ok', label: prep.skip || 'speech',
      heard: (prep.asr.text || '').slice(0, 40), cues, debug: { sentences: prep.split.sentences } });
    const old = stored.find((c) => c.from === w.from && c.to === w.to && c.quick === !!w.quick);
    const before = old ? (old.status === 'ok' ? (old.cues || []).map((c) => c.zh) : ['(bỏ qua: ' + old.label + ')']) : ['(không có kết quả đã lưu)'];
    const after = prep.skip ? ['(bỏ qua: ' + prep.skip + ')'] : cues.map((c) => c.zh);
    if (JSON.stringify(before) === JSON.stringify(after)) { same++; continue; }
    changed++;
    shown.push({ id, span: k, before, after });
  }
  const d0 = drops(stored, { lyrics }), d1 = drops(replayed, { lyrics });
  console.log(`${id}: ${asr.size} đoạn có file nhận dạng; vế câu mất: đã lưu ${d0.lost}/${d0.clauses}, chạy lại ${d1.lost}/${d1.clauses} (chạy lại chưa qua bước dịch)`);
}
console.log(`Dòng gốc giống bản đã lưu: ${same} đoạn; khác: ${changed} đoạn`);
for (const x of shown.slice(0, Number(a.max || 20))) {
  console.log(`== ${x.id} ${x.span}`);
  console.log('   đã lưu  : ' + x.before.join(' / ').slice(0, 300));
  console.log('   chạy lại: ' + x.after.join(' / ').slice(0, 300));
}

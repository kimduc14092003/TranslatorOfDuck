// In câu nhận dạng, dòng sub từng đoạn và dòng sau khi gộp trong khoảng [a, b] giây của một video, để soát lỗi.
//   node window.mjs <thư mục cache> <id> <a> <b> [--plain]
// In chữ của video (dữ liệu có bản quyền): chỉ xem trên máy.
import path from 'node:path';
import { args, chunksOf, mergedCues } from './lib.mjs';

const a = args();
const [dir, id, A, B] = a._;
if (!dir || !id || A == null || B == null) { console.log('node window.mjs <thư mục cache> <id> <a> <b> [--plain]'); process.exit(1); }
const chunks = chunksOf(path.resolve(dir), id, !a.plain);
const inW = (x) => x.end >= +A && x.start <= +B;
for (const c of chunks) {
  if (c.to < +A || c.from > +B) continue;
  console.log(`== ${c.quick ? 'mẩu nhanh' : 'đoạn'} ${c.from}-${c.to} (${c.status}${c.status !== 'ok' && c.label ? '/' + c.label : ''}, ${c.asrModel || c.asr || '-'})`);
  for (const x of ((c.debug && c.debug.sentences) || []).filter(inW)) console.log(`   nghe ${x.start.toFixed(2)}-${x.end.toFixed(2)} ${x.sung ? '♪ ' : ''}${x.text}`);
  for (const x of (c.cues || []).filter(inW)) console.log(`   dòng ${x.start.toFixed(2)}-${x.end.toFixed(2)} ${x.zh} | ${x.vi}`);
}
console.log('== sau khi gộp (như content.js)');
for (const x of mergedCues(chunks).filter(inW)) console.log(`   ${x.start.toFixed(2)}-${x.end.toFixed(2)} ${x.sung ? '♪ ' : ''}${x.zh} | ${x.vi}`);

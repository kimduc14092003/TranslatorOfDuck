// Quét cache của server tìm câu bị mất: vế câu server nghe được mà không thành dòng sub, đoạn bị bỏ cả đoạn, dòng phải bỏ
// sau lượt dịch lại. Mặc định quét cache của server hằng ngày (alpha/server/work/cache).
//   node cache-scan.mjs [thư mục cache] [--plain] [--ids id1,id2] [--max 40]
// In cả chữ của câu bị mất (dữ liệu có bản quyền): chỉ xem trên máy.
import path from 'node:path';
import { SERVER_DIR, args, chunksOf, drops, videoIds } from './lib.mjs';

const a = args();
const dir = path.resolve(a._[0] || path.join(SERVER_DIR, 'work', 'cache'));
const lyrics = !a.plain;
const ids = a.ids ? String(a.ids).split(',') : videoIds(dir);
let clauses = 0, lost = 0, mixed = 0, noResult = 0;
const items = [];
for (const id of ids) {
  const chunks = chunksOf(dir, id, lyrics);
  // Cache có cả cách chia đoạn cũ và mới (đoạn chồng nhau): ghép sub ra kết quả ảo, bỏ qua video này.
  const spans = chunks.filter((c) => !c.quick).sort((p, q) => p.from - q.from);
  if (spans.some((c, i) => i > 0 && c.from < spans[i - 1].to)) { mixed++; continue; }
  const d = drops(chunks, { lyrics });
  clauses += d.clauses; lost += d.lost; noResult += d.noResult;
  for (const x of d.items) if (!x.accepted) items.push({ id, ...x });
}
console.log(`${ids.length} video (${mixed} bỏ qua vì lẫn cách chia đoạn cũ), ${clauses} vế câu, mất ${lost} (độ phủ ${clauses ? (100 * (clauses - lost) / clauses).toFixed(2) : '-'}%), ` +
  `${items.length} chỗ cần duyệt; ${noResult} đoạn có file nhận dạng mà không có kết quả (dịch ra 0 dòng, lỗi, hay bị huỷ; cache hằng ngày không biết vị trí nên không đếm được vế); chế độ lời bài hát ${lyrics ? 'bật' : 'tắt'}`);
const by = {};
for (const x of items) by[x.why] = (by[x.why] || 0) + 1;
for (const [k, v] of Object.entries(by).sort((p, q) => q[1] - p[1])) console.log(`  ${k}: ${v}`);
for (const x of items.slice(0, Number(a.max || 40))) console.log(`  ${x.id} ${x.span}${x.t != null ? ' @' + x.t : ''} ${x.why}: ${String(x.text || x.heard || '').slice(0, 40)}`);

// Bảng điểm của một lượt xem (docs/ROADMAP.md §3): đối chiếu mẫu ghi được (watch.mjs) với cache của server đo và log proxy.
//   node report.mjs <thư mục lượt xem>        (thư mục của run.mjs: meta.json, samples.jsonl, proxy.jsonl, server/cache)
// Ghi report.json cạnh đó. Trong đó có chữ của các câu bị mất (dữ liệu có bản quyền): chỉ để trên máy, xoá khi xong.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { args, chunksOf, cuesLib, drops, mergedCues, platformError, readJson, readJsonl, readingSpeed, silentGaps, stateOf } from './lib.mjs';

const clean = (s) => String(s || '').replace(/^♪\s*/, '').trim();
// Mẫu theo lưới 0,25 s như ROADMAP §3 định nghĩa: 10 s đầu watch.mjs chụp mỗi 100 ms, nếu tính cả thì 10 s đầu nặng gấp 2,5 lần.
const grid = (S, ms = 250) => { const out = []; let cell = -1; for (const s of S) { const c = Math.floor(s.at / ms); if (c !== cell) { out.push(s); cell = c; } } return out; };

// Từ mẫu chụp: hiện đúng dòng, chờ dịch khi đang xem, lỗi (của ta và phía nền tảng), sub đầu tiên.
export function samplesScore(samples, cues, { from = 0 } = {}) {
  const at = cuesLib().at;
  const all = samples.filter((s) => s.t != null);
  // Lượt có tua (from > 0): chỉ chấm từ lúc thấy chỗ đang xem đã tới gần from.
  const startIdx = from ? all.findIndex((s) => Math.abs(s.t - from) < 2) : 0;
  const S = startIdx >= 0 ? grid(all.slice(startIdx)) : [];
  const r = { samples: S.length, expected: 0, same: 0, blank: 0, other: 0, extra: 0, waitRuns: 0, waitSamples: 0, errorRuns: 0, platformErrorRuns: 0 };
  let prevW = false, prevE = false;
  for (const s of S) {
    const st = stateOf(s), c = at(cues, s.t);
    if (c) { r.expected++; if (!s.sub) r.blank++; else if (clean(s.sub) === clean(c.vi)) r.same++; else r.other++; } else if (s.sub) r.extra++;
    const w = st === 'pending' && !s.sub && !s.paused && s.t >= from + 5;
    if (w) { r.waitSamples++; if (!prevW) r.waitRuns++; }
    prevW = w;
    const e = st === 'error';
    if (e && !prevE) { if (platformError(s)) r.platformErrorRuns++; else r.errorRuns++; }
    prevE = e;
  }
  r.correct = r.expected ? +(100 * r.same / r.expected).toFixed(1) : null;
  // Sub đầu tiên (TTFS): lúc nhãn báo đoạn ở chỗ đang xem đã có kết quả (có sub, hay đã kết luận bỏ qua), trừ lúc bắt đầu phát.
  // Lượt có tua (from > 0): tính từ lúc thấy chỗ đang xem đã tới gần from. Dùng mọi mẫu (100 ms trong 10 s đầu).
  let playAt = null;
  if (from) playAt = startIdx >= 0 ? all[startIdx].at : null;
  else {
    for (let i = 1; i < all.length; i++) {
      if (all[i].t > all[i - 1].t + 0.01 && !all[i].paused) { playAt = all[i].at - all[i].t * 1000 / (all[i].rate || 1); break; }
    }
  }
  const ready = startIdx >= 0 ? all.slice(startIdx).find((s) => ['ok', 'skipped'].includes(stateOf(s))) : null;
  r.ttfsMs = playAt != null && ready ? Math.max(0, Math.round(ready.at - playAt)) : null;
  r.rate = S.length ? S[Math.floor(S.length / 2)].rate : null;
  return r;
}

// Theo log proxy, chỉ tính trước lúc đóng trình duyệt (endWall): yêu cầu dịch bị huỷ (extension ngắt kết nối; để bắt lỗi
// "đoạn đầu bị huỷ lúc mở video", HANDOFF §6aj), tách video đang xem với video dịch sẵn; và đoạn của video đang xem có kết
// quả cuối là lỗi hay dịch ra 0 dòng (server không ghi cache cho hai loại này).
export function proxyFacts(proxy, { id, endWall } = {}) {
  const before = (x) => !endWall || !x.wall || x.wall < endWall;
  const reqs = new Map(proxy.filter((x) => x.ev === 'req' && x.url === '/v1/subtitles').map((x) => [x.rid, x]));
  const span = (m) => (m.from != null ? `${m.quick ? 'q' : ''}${m.from}-${m.to}` : null);
  const closed = proxy.filter((x) => x.ev === 'closed' && before(x) && reqs.has(x.rid)).map((x) => {
    const q = reqs.get(x.rid), m = q.meta || {};
    return { id: m.id, span: span(m), after: x.ms - q.ms };
  });
  const failed = proxy.filter((x) => x.ev === 'done' && reqs.has(x.rid) && x.outcome && (x.outcome.status === 'error' || x.outcome.label === 'untranslated'))
    .map((x) => { const m = reqs.get(x.rid).meta || {}; return { id: m.id, span: span(m), status: x.outcome.status, label: x.outcome.label }; })
    .filter((x) => !id || x.id === id);
  return { cancelled: closed.filter((x) => !id || x.id === id), cancelledOther: closed.filter((x) => id && x.id !== id).length, failed };
}

export function report(dir) {
  const meta = readJson(path.join(dir, 'meta.json')) || { error: 'không có meta.json (lượt xem không chạy được)' };
  const proxy = readJsonl(path.join(dir, 'proxy.jsonl'));
  const samples = readJsonl(path.join(dir, 'samples.jsonl'));
  const lyrics = !(meta.settings && meta.settings.lyrics === false);
  // Chỉ xét phần đã thực sự xem: từ from (lượt có tua) tới chỗ xa nhất đã phát. Đoạn bị huỷ vì tua đi, đoạn dịch sẵn phía
  // sau chỗ dừng xem không tính.
  const from = meta.from || 0, ts = samples.map((s) => s.t).filter((t) => t != null && t >= from - 2);
  const range = ts.length ? [from, Math.max(...ts)] : null;
  const inRange = (a, b) => !range || (b > range[0] && a < range[1] + 0.5);
  const spanIn = (sp) => { const m = /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/.exec(sp || ''); return !m || inRange(+m[1], +m[2]); };
  // Đoạn không có kết quả mà bắt đầu ngay chỗ dừng xem: đoạn dịch sẵn phía trước, bị huỷ lúc đóng trình duyệt, không tính.
  const chunks = (meta.id ? chunksOf(path.join(dir, 'server', 'cache'), meta.id, lyrics, null) : [])
    .filter((c) => inRange(c.from, c.to) && !(c.status === 'none' && range && c.from >= range[1] - 1));
  const cues = mergedCues(chunks);
  const d = drops(chunks, { lyrics });
  const p0 = proxyFacts(proxy, meta);
  const okSpans = new Set(chunks.filter((c) => c.status === 'ok').map((c) => `${c.quick ? 'q' : ''}${c.from}-${c.to}`));
  const p = { ...p0, cancelled: p0.cancelled.filter((x) => spanIn(x.span)), failed: p0.failed.filter((x) => spanIn(x.span) && !okSpans.has(x.span)) };
  const byStatus = {};
  for (const c of chunks.filter((x) => !x.quick)) { const k = c.status + (c.status === 'ok' ? '' : '/' + (c.label || '-')); byStatus[k] = (byStatus[k] || 0) + 1; }
  const durMs = ((proxy.find((x) => x.meta && x.meta.id === meta.id && x.meta.durationMs) || {}).meta || {}).durationMs;
  return {
    id: meta.id || null, error: meta.error || null, lyrics, rate: meta.rate, from: meta.from, to: meta.to, throttle: meta.throttle, extension: meta.extension, watched: range,
    duration: durMs ? durMs / 1000 : meta.duration || null,
    chunks: byStatus, asrModels: [...new Set(chunks.map((c) => c.asrModel || c.asr).filter(Boolean))],
    clauses: d.clauses, lost: d.lost, coverage: d.coverage, unapproved: d.unapproved, staleChunks: d.stale, noResult: d.noResult, drops: d.items, failed: p.failed,
    cues: cues.length, sung: cues.filter((c) => c.sung).length, readingSpeed: readingSpeed(cues),
    ...samplesScore(samples, cues, { from }),
    cancelled: p.cancelled, cancelledOther: p.cancelledOther, silentGaps: silentGaps(chunks),
  };
}

const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
export function print(r) {
  const lines = [
    `Video ${r.id || '?'}${r.duration ? ' (' + mmss(r.duration) + ')' : ''}: ${Object.entries(r.chunks).map(([k, v]) => `${k} ${v}`).join(', ') || 'chưa có đoạn nào'}; ` +
      `nhận dạng: ${r.asrModels.join(', ') || '-'}; lời bài hát ${r.lyrics ? 'bật' : 'tắt'}`,
    ...(r.error ? [`  LỖI khi xem: ${r.error}`] : []),
    `  Không mất câu vì luật của ta: ${r.unapproved} vế cần duyệt${r.failed.length ? `; ${r.failed.length} đoạn lỗi hay dịch ra 0 dòng` : ''}${r.staleChunks ? `; ${r.staleChunks} đoạn là kết quả cũ (server sẽ làm lại)` : ''}`,
    ...r.failed.map((x) => `    ${x.span} ${x.status}${x.label ? '/' + x.label : ''}`),
    ...r.drops.filter((x) => !x.accepted).slice(0, 12).map((x) => `    ${x.span}${x.t != null ? ' @' + x.t : ''} ${x.why}${x.text ? ': ' + x.text.slice(0, 30) : x.heard ? ': ' + x.heard.slice(0, 30) : ''}`),
    `  Độ phủ lời nói: ${r.coverage ?? '-'}% (${r.clauses - r.lost}/${r.clauses} vế câu)`,
    `  Hiện đúng dòng: ${r.correct ?? '-'}% (${r.same}/${r.expected} lần chụp mỗi 0,25 s; trống ${r.blank}, khác dòng ${r.other}, sub thừa ${r.extra}), tốc độ ${r.rate ?? '-'}×${r.throttle ? `, mạng ${r.throttle} KB/s` : ''}`,
    `  Chờ dịch khi đang xem (sau 5 s đầu): ${r.waitRuns} lần (${r.waitSamples} lần chụp)`,
    `  Lỗi của ta: ${r.errorRuns} lần; lỗi phía Douyin: ${r.platformErrorRuns} lần`,
    `  Sub đầu tiên${r.from ? ' sau khi tua' : ''}: ${r.ttfsMs == null ? '-' : (r.ttfsMs / 1000).toFixed(1) + ' s'}${r.watched ? `; đã xem ${mmss(r.watched[0])}–${mmss(r.watched[1])}` : ''}`,
    `  Tốc độ đọc: ${r.readingSpeed.within ?? '-'}% dòng ≤ ${r.readingSpeed.limit} ký tự/giây (${r.readingSpeed.cues} dòng, ${r.sung} dòng ♪)`,
    `  Yêu cầu dịch của video này bị huỷ: ${r.cancelled.length}${r.cancelled.length ? ' (' + r.cancelled.map((x) => `${x.span} sau ${(x.after / 1000).toFixed(1)} s`).join('; ') + ')' : ''}; của video dịch sẵn: ${r.cancelledOther}`,
    `  Quãng nghi nghe sót (> 4 s không có câu nào, kể cả nhạc, im lặng): ${r.silentGaps.length ? r.silentGaps.map(([a, b]) => `${a}–${b}`).join(', ') : 'không có'}`,
  ];
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = args()._[0];
  if (!dir || !fs.existsSync(dir)) { console.log('Cần thư mục lượt xem: node report.mjs <thư mục>'); process.exit(1); }
  const r = report(path.resolve(dir));
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(r, null, 1));
  console.log(print(r));
}

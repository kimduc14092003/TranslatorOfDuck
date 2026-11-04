// Bảng điểm của một lượt xem (docs/ROADMAP.md §3): đối chiếu mẫu ghi được (watch.mjs) với cache của server đo và log proxy.
//   node report.mjs <thư mục lượt xem>        (thư mục của run.mjs: meta.json, samples.jsonl, proxy.jsonl, server/cache)
// Ghi report.json cạnh đó. Trong đó có chữ của các câu bị mất (dữ liệu có bản quyền): chỉ để trên máy, xoá khi xong.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_DIR, args, chunksOf, cpsOf, cuesLib, drops, mergedCues, platformError, readJson, readJsonl, readingSpeed, silentGaps, stateOf } from './lib.mjs';

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
  // seen: dòng rút gọn sau (có full) → số lần chụp thấy bản rút gọn trừ số lần thấy bản đầy đủ.
  const seen = new Map();
  r.seen = seen;
  let prevW = false, prevE = false;
  for (const s of S) {
    const st = stateOf(s), c = at(cues, s.t);
    // Dòng rút gọn sau (server ghi bản đầy đủ đã trả vào full): hiện bản nào cũng là đúng dòng.
    if (c) {
      r.expected++;
      if (!s.sub) r.blank++;
      else if (clean(s.sub) === clean(c.vi)) { r.same++; if (c.full) seen.set(c, (seen.get(c) || 0) + 1); }
      else if (c.full && clean(s.sub) === clean(c.full)) { r.same++; seen.set(c, (seen.get(c) || 0) - 1); }
      else r.other++;
    } else if (s.sub) r.extra++;
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
  // Lần chụp đầu tiên đã ở quá 3 s (trang tải chậm, chưa kịp chụp thì video đã phát): không biết sub đầu ra lúc nào.
  if (!from && all.length && all[0].t > 3) { r.lateStart = all[0].t; r.ttfsMs = null; }
  r.rate = S.length ? S[Math.floor(S.length / 2)].rate : null;
  return r;
}

// ---------------------------------------------------------------- đúng nhịp (Δin = lúc sub hiện − lúc người nói bắt đầu)
// Tách hai phần, cả hai tính theo giờ video, dương là sub muộn:
//  - hiển thị (render): giờ video lúc chữ của dòng hiện ra (bộ ghi trong trang, PAGE_STATE subLog) − đầu dòng (start). Dòng hiện
//    muộn hơn 0,1 s là dòng tới muộn (chưa dịch kịp: dòng đầu lúc mở video, vừa tua), không phải lệch nhịp: đếm riêng, không tính
//    vào trung vị và Δin. Đo 4/11: các dòng khác chỉ lệch 1–17 ms (một khung hình);
//  - nhận dạng (asr): đầu dòng − lúc tiếng nói bắt đầu trong âm thanh server nhận (work/dump, TOD_DUMP). Chỉ dòng bắt đầu sau một
//    quãng lặng rõ (onsetNear) và dòng trước đã dứt lời ít nhất 0,3 s; nói liền thì không dò được, bỏ qua.
//  - Δin của một dòng = hiển thị + nhận dạng, khi có cả hai.
// Lần đo tay 30/10 (HANDOFF §5): mốc chữ muộn hơn lúc giọng nói bắt đầu trung vị 0,08 s (82 điểm).
export const quant = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); const q = (p) => v.length ? +v[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(3) : null;
  return { n: v.length, min: v.length ? +v[0].toFixed(3) : null, median: q(0.5), p90: q(0.9), within83ms: v.length ? +(100 * v.filter((x) => Math.abs(x) <= 0.083).length / v.length).toFixed(1) : null }; };
let ffmpegPath;
const ffmpeg = () => ffmpegPath ?? (ffmpegPath = process.env.FFMPEG || (() => { try { return createRequire(path.join(SERVER_DIR, 'package.json'))('ffmpeg-static'); } catch (_) { return 'ffmpeg'; } })());
// Năng lượng mỗi 10 ms của một file âm thanh (16 kHz, một kênh).
function envelope(file) {
  const pcm = execFileSync(ffmpeg(), ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 1 << 28 });
  const n = Math.floor(pcm.length / 2 / 160), out = new Float64Array(n);
  for (let f = 0; f < n; f++) { let e = 0; for (let i = 0; i < 160; i++) { const x = pcm.readInt16LE((f * 160 + i) * 2); e += x * x; } out[f] = Math.sqrt(e / 160); }
  return out;
}
// Lúc tiếng nói bắt đầu quanh giây a của file (null: không dò được). Tìm lúc bắt đầu trước, rồi mới đòi quãng lặng ngay trước nó, để
// dòng có mốc muộn (tiếng nói bắt đầu sớm hơn đầu dòng tới 0,5 s) vẫn đo được (verifier 4/11: bản đầu đòi lặng ngay trước đầu dòng,
// nên không bao giờ thấy mốc muộn quá 0,15 s). Ngưỡng theo tiếng ồn ngay tại chỗ, không theo cả file (chỗ nói nhỏ bị bắt nhầm sớm):
//  - nền: trung vị năng lượng 0,9–0,5 s trước đầu dòng; đỉnh: lớn nhất trong 0,5 s sau đầu dòng, phải gấp 4 lần nền;
//  - lúc bắt đầu: khung đầu tiên trong ±0,5 s quanh đầu dòng mà 3 khung liền vượt max(3 lần nền, nền + 10% (đỉnh − nền));
//  - quãng lặng: 0,35 s trước lúc bắt đầu (trừ 50 ms sát nó) đều dưới ngưỡng đó.
export function onsetNear(env, a) {
  const F = (t) => Math.round(t * 100), at = (f) => env[f] ?? 0;
  const pre = []; for (let f = F(a - 0.9); f < F(a - 0.5); f++) if (f >= 0) pre.push(at(f));
  if (pre.length < 20) return null;
  pre.sort((x, y) => x - y);
  const noise = Math.max(pre[pre.length >> 1], 20);
  let peak = 0; for (let f = F(a); f <= F(a + 0.5) && f < env.length; f++) peak = Math.max(peak, at(f));
  if (peak < 4 * noise) return null;
  const thr = Math.max(3 * noise, noise + 0.1 * (peak - noise));
  let o = -1;
  for (let f = Math.max(0, F(a - 0.5)); f <= F(a + 0.5) && f + 2 < env.length; f++) if (at(f) > thr && at(f + 1) > thr && at(f + 2) > thr) { o = f; break; }
  if (o < 0) return null;
  for (let f = o - 35; f < o - 5; f++) if (f < 0 || at(f) > thr) return null;
  return o / 100;
}
export function timing(dir, cues, samples, { from = 0, id = null } = {}) {
  // Hiển thị.
  // Mỗi dòng ghép với lần hiện chưa dùng, sớm nhất từ 0,1 s trước đầu dòng tới 3 s sau (dòng lặp chữ, tua lại không ghép nhầm).
  const log = samples.flatMap((s) => s.subLog || []).filter((x) => x.t != null && x.sub);
  const render = [], late = [], used = new Set();
  let unmatched = 0;
  for (const c of cues) {
    if (c.start < from) continue;
    const hit = log.find((x) => !used.has(x) && x.t >= c.start - 0.1 && x.t < c.start + 3 && (clean(x.sub) === clean(c.vi) || (c.full && clean(x.sub) === clean(c.full))));
    if (!hit) { unmatched++; continue; }
    used.add(hit);
    const d = hit.t - c.start;
    (d > 0.1 ? late : render).push({ c, d });
  }
  // Nhận dạng: theo âm thanh từng đoạn 30 s (không tính mẩu nhanh).
  const asr = new Map();
  const dumpDir = path.join(dir, 'server', 'dump');
  if (fs.existsSync(dumpDir)) {
    const re = new RegExp(`^${id}\\.(\\d+(?:\\.\\d+)?)-(\\d+(?:\\.\\d+)?)\\..*\\.at([\\d.]+)\\.aac$`);
    for (const f of fs.readdirSync(dumpDir)) {
      const m = re.exec(f);
      if (!m) continue;
      const lo = +m[1], hi = +m[2], at = +m[3];
      let env;
      try { env = envelope(path.join(dumpDir, f)); } catch (_) { continue; }
      cues.forEach((c, i) => {
        // Dòng nối liền dòng trước (dòng trước dứt lời chưa tới 0,3 s trước đó): năng lượng trước đầu dòng là lời của dòng trước, không
        // dò được (đo 4/11: "…您对" + "得起当年…" cho Δ 340 ms giả).
        const prev = cues[i - 1];
        if (c.start < lo || c.start >= hi || c.start < from || asr.has(c) || (prev && (prev.se || prev.end) > c.start - 0.3)) return;
        const o = onsetNear(env, c.start - at);
        if (o != null) asr.set(c, c.start - (at + o));
      });
    }
  }
  const both = render.filter((x) => asr.has(x.c)).map((x) => x.d + asr.get(x.c));
  // values: các số lệch (giây, không có chữ) để run.mjs gộp nhiều video: mỗi video chỉ có vài chục dòng, P90 do 1–2 dòng quyết định.
  return { render: quant(render.map((x) => x.d)), late: late.length, unmatched, asr: quant([...asr.values()]), in: quant(both), inAbsP90: quant(both.map(Math.abs)).p90,
    values: { render: render.map((x) => +x.d.toFixed(3)), asr: [...asr.values()].map((x) => +x.toFixed(3)), in: both.map((x) => +x.toFixed(3)) } };
}

// Theo log proxy, chỉ tính trước lúc đóng trình duyệt (endWall): yêu cầu dịch bị huỷ (extension ngắt kết nối; để bắt lỗi
// "đoạn đầu bị huỷ lúc mở video", HANDOFF §6aj), tách video đang xem với video dịch sẵn; và đoạn của video đang xem có kết
// quả cuối là lỗi hay dịch ra 0 dòng (server không ghi cache cho hai loại này).
export function proxyFacts(proxy, { id, endWall } = {}) {
  const before = (x) => !endWall || !x.wall || x.wall < endWall;
  const reqs = new Map(proxy.filter((x) => x.ev === 'req' && x.url === '/v1/subtitles').map((x) => [x.rid, x]));
  const span = (m) => (m.from != null ? `${m.quick ? 'q' : ''}${m.from}-${m.to}` : null);
  const closed = proxy.filter((x) => x.ev === 'closed' && !x.afterResult && before(x) && reqs.has(x.rid)).map((x) => {
    const q = reqs.get(x.rid), m = q.meta || {};
    return { id: m.id, span: span(m), after: x.ms - q.ms };
  });
  const failed = proxy.filter((x) => x.ev === 'done' && reqs.has(x.rid) && x.outcome && (x.outcome.status === 'error' || x.outcome.label === 'untranslated'))
    .map((x) => { const m = reqs.get(x.rid).meta || {}; return { id: m.id, span: span(m), status: x.outcome.status, label: x.outcome.label }; })
    .filter((x) => !id || x.id === id);
  return { cancelled: closed.filter((x) => !id || x.id === id), cancelledOther: closed.filter((x) => id && x.id !== id).length, failed };
}

// Lượt có đổi ngôn ngữ giữa chừng (watch.mjs --switch-at; meta.switch { at, from, to }): chấm riêng từng khoảng theo ngôn ngữ
// đang chọn lúc đó. Kết quả là phần sau khi đổi, kèm before (phần trước) và switch.
export function report(dir, part = null) {
  const meta = readJson(path.join(dir, 'meta.json')) || { error: 'không có meta.json (lượt xem không chạy được)' };
  if (!part && meta.switch) {
    const before = report(dir, { target: meta.switch.from, upTo: meta.switch.at });
    return { ...report(dir, { target: meta.switch.to, startAt: meta.switch.at }), before, switch: meta.switch };
  }
  const target = (part && part.target) || (meta.settings && meta.settings.target) || 'vi';
  const proxy = readJsonl(path.join(dir, 'proxy.jsonl'));
  const upTo = part && part.upTo != null ? part.upTo : Infinity;
  const samples = readJsonl(path.join(dir, 'samples.jsonl')).filter((s) => s.t == null || s.t < upTo);
  const lyrics = !(meta.settings && meta.settings.lyrics === false);
  // Chỉ xét phần đã thực sự xem: từ from (lượt có tua) tới chỗ xa nhất đã phát. Đoạn bị huỷ vì tua đi, đoạn dịch sẵn phía
  // sau chỗ dừng xem không tính.
  const from = part && part.startAt != null ? part.startAt : meta.from || 0, ts = samples.map((s) => s.t).filter((t) => t != null && t >= from - 2);
  const range = ts.length ? [from, Math.max(...ts)] : null;
  const inRange = (a, b) => !range || (b > range[0] && a < range[1] + 0.5);
  const spanIn = (sp) => { const m = /(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)/.exec(sp || ''); return !m || inRange(+m[1], +m[2]); };
  // Đoạn không có kết quả mà bắt đầu ngay chỗ dừng xem: đoạn dịch sẵn phía trước, bị huỷ lúc đóng trình duyệt, không tính.
  const chunks = (meta.id ? chunksOf(path.join(dir, 'server', 'cache'), meta.id, lyrics, null, target) : [])
    .filter((c) => inRange(c.from, c.to) && !(c.status === 'none' && range && c.from >= range[1] - 1));
  const cues = mergedCues(chunks);
  const { seen: _seen, ...rest } = samplesScore(samples.filter((s) => s.t == null || s.t >= from - 2), cues, { from });
  const sc = { seen: _seen };
  const d = drops(chunks, { lyrics });
  const p0 = proxyFacts(proxy, meta);
  const okSpans = new Set(chunks.filter((c) => c.status === 'ok').map((c) => `${c.quick ? 'q' : ''}${c.from}-${c.to}`));
  const p = { ...p0, cancelled: p0.cancelled.filter((x) => spanIn(x.span)), failed: p0.failed.filter((x) => spanIn(x.span) && !okSpans.has(x.span)) };
  const byStatus = {};
  for (const c of chunks.filter((x) => !x.quick)) { const k = c.status + (c.status === 'ok' ? '' : '/' + (c.label || '-')); byStatus[k] = (byStatus[k] || 0) + 1; }
  const durMs = ((proxy.find((x) => x.meta && x.meta.id === meta.id && x.meta.durationMs) || {}).meta || {}).durationMs;
  return {
    id: meta.id || null, error: meta.error || null, target, lyrics, rate: meta.rate, from: meta.from, to: meta.to, throttle: meta.throttle, extension: meta.extension, watched: range,
    duration: durMs ? durMs / 1000 : meta.duration || null,
    chunks: byStatus, asrModels: [...new Set(chunks.map((c) => c.asrModel || c.asr).filter(Boolean))],
    clauses: d.clauses, lost: d.lost, coverage: d.coverage, unapproved: d.unapproved, staleChunks: d.stale, noResult: d.noResult, drops: d.items, failed: p.failed,
    cues: cues.length, sung: cues.filter((c) => c.sung).length,
    // Tốc độ đọc theo chữ đã hiện: dòng rút gọn sau chỉ tính bản ngắn khi lúc xem thấy bản ngắn nhiều hơn; chưa chụp được hay
    // hoà thì tính bản đầy đủ (cho chắc, verifier 4/11).
    readingSpeed: readingSpeed(cues.map((c) => (c.full && !((sc.seen.get(c) || 0) > 0) ? { ...c, vi: c.full } : c)), cpsOf(target)),
    condensedLater: { lines: cues.filter((c) => c.full).length, shownShort: [...sc.seen.values()].filter((x) => x > 0).length, shownFull: [...sc.seen.values()].filter((x) => x < 0).length },
    ...rest,
    cancelled: p.cancelled, cancelledOther: p.cancelledOther, silentGaps: silentGaps(chunks),
    timing: timing(dir, cues, samples, { from, id: meta.id }),
  };
}

// Vế đã chấp nhận ở chỗ nối hai đoạn (lib.mjs, mergedCheck): in số để còn thấy, không tính là cần duyệt.
export function seamLine(drops) {
  const one = drops.filter((x) => x.why === 'ghép sub: khác một chữ').length, part = drops.filter((x) => x.why === 'ghép sub: thiếu vài chữ ở chỗ nối').length;
  return one || part ? [`  Chỗ nối hai đoạn (đã chấp nhận): ${one} vế khác một chữ, ${part} vế thiếu vài chữ (tính là mất)`] : [];
}
const ms = (x) => (x == null ? '-' : Math.round(x * 1000) + ' ms');
// Hiển thị: chỉ là độ trễ theo khung hình (bộ ghi và extension cùng chạy theo requestAnimationFrame); chưa tính thời gian vẽ ra màn
// hình, nên Δin là cận dưới. Nhận dạng: chỉ dòng bắt đầu sau quãng lặng.
const timingLine = (t) => !t ? '  Đúng nhịp: -' : `  Đúng nhịp (dương là sub muộn): hiển thị theo khung hình trung vị ${ms(t.render.median)}, P90 ${ms(t.render.p90)} (${t.render.n} dòng` +
  `${t.late ? `; ${t.late} dòng tới muộn hơn 0,1 s` : ''}${t.unmatched ? `; ${t.unmatched} dòng không thấy hiện` : ''}); mốc nhận dạng so với lúc bắt đầu nói ${ms(t.asr.median)}, P90 ${ms(t.asr.p90)} (${t.asr.n} dòng sau quãng lặng); ` +
  `Δin ${ms(t.in.median)}, P90 ${ms(t.in.p90)}, sớm nhất ${ms(t.in.min)}, P90 của |Δin| ${ms(t.inAbsP90)}, ${t.in.within83ms ?? '-'}% trong ±83 ms (${t.in.n} dòng)`;
const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
export function print(r) {
  if (r.switch) return [`Đổi ngôn ngữ ${r.switch.from} → ${r.switch.to} ở ${mmss(r.switch.at)}.`, '— Trước khi đổi (' + r.switch.from + '):', print(r.before), '— Sau khi đổi (' + r.switch.to + '):', print({ ...r, switch: null })].join('\n');
  const lines = [
    `Video ${r.id || '?'}${r.duration ? ' (' + mmss(r.duration) + ')' : ''}: ${Object.entries(r.chunks).map(([k, v]) => `${k} ${v}`).join(', ') || 'chưa có đoạn nào'}; ` +
      `nhận dạng: ${r.asrModels.join(', ') || '-'}; lời bài hát ${r.lyrics ? 'bật' : 'tắt'}; dịch sang ${r.target || 'vi'}`,
    ...(r.error ? [`  LỖI khi xem: ${r.error}`] : []),
    `  Không mất câu vì luật của ta: ${r.unapproved} vế cần duyệt${r.failed.length ? `; ${r.failed.length} đoạn lỗi hay dịch ra 0 dòng` : ''}${r.staleChunks ? `; ${r.staleChunks} đoạn là kết quả cũ (server sẽ làm lại)` : ''}`,
    ...r.failed.map((x) => `    ${x.span} ${x.status}${x.label ? '/' + x.label : ''}`),
    ...seamLine(r.drops),
    ...r.drops.filter((x) => !x.accepted).slice(0, 12).map((x) => `    ${x.span}${x.t != null ? ' @' + x.t : ''} ${x.why}${x.text ? ': ' + x.text.slice(0, 30) : x.heard ? ': ' + x.heard.slice(0, 30) : ''}`),
    `  Độ phủ lời nói: ${r.coverage ?? '-'}% (${r.clauses - r.lost}/${r.clauses} vế câu)`,
    `  Hiện đúng dòng: ${r.correct ?? '-'}% (${r.same}/${r.expected} lần chụp mỗi 0,25 s; trống ${r.blank}, khác dòng ${r.other}, sub thừa ${r.extra}), tốc độ ${r.rate ?? '-'}×${r.throttle ? `, mạng ${r.throttle} KB/s` : ''}`,
    `  Chờ dịch khi đang xem (sau 5 s đầu): ${r.waitRuns} lần (${r.waitSamples} lần chụp)`,
    `  Lỗi của ta: ${r.errorRuns} lần; lỗi phía Douyin: ${r.platformErrorRuns} lần`,
    `  Sub đầu tiên${r.from ? ' sau khi tua' : ''}: ${r.ttfsMs == null ? (r.lateStart ? `không đo được (bắt đầu chụp ở ${r.lateStart} s)` : '-') : (r.ttfsMs / 1000).toFixed(1) + ' s'}${r.watched ? `; đã xem ${mmss(r.watched[0])}–${mmss(r.watched[1])}` : ''}`,
    timingLine(r.timing),
    `  Tốc độ đọc: ${r.readingSpeed.within ?? '-'}% dòng ≤ ${r.readingSpeed.limit} ký tự/giây (${r.readingSpeed.cues} dòng, ${r.sung} dòng ♪)` +
      (r.condensedLater && r.condensedLater.lines ? `; rút gọn sau ${r.condensedLater.lines} dòng: hiện bản ngắn ${r.condensedLater.shownShort}, bản đầy đủ ${r.condensedLater.shownFull}` : ''),
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

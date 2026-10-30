// Đọc mục lục (moov) của file mp4 và cắt riêng âm thanh AAC của một khoảng thời gian (docs/PLAN.md §5.4).
// Nhờ vậy chỉ tải đúng phần byte cần, và chỉ gửi âm thanh (~16 KB/giây) lên server thay vì cả video.
// Mốc thời gian là thời gian trình phát (đã tính edit list), cùng thước với video.currentTime.
(() => {
  'use strict';
  const type4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  function* boxes(dv, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o), head = 8;
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); head = 16; } else if (size === 0) size = end - o;
      if (size < head || o + size > end) return;
      yield { type: type4(dv, o + 4), start: o + head, end: o + size };
      o += size;
    }
  }
  const child = (dv, box, type) => { for (const b of boxes(dv, box.start, box.end)) if (b.type === type) return b; return null; };
  const path = (dv, box, types) => types.reduce((b, t) => (b ? child(dv, b, t) : null), box);

  // Vị trí kết thúc moov, nếu moov đứng trước dữ liệu (file faststart). Chỉ cần đọc phần đầu file.
  function headerEnd(buf) {
    const dv = new DataView(buf);
    let o = 0;
    while (o + 8 <= buf.byteLength) {
      let size = dv.getUint32(o);
      const t = type4(dv, o + 4);
      if (size === 1 && o + 16 <= buf.byteLength) size = Number(dv.getBigUint64(o + 8));
      if (t === 'mdat') return null;
      if (t === 'moov') return o + size;
      if (size < 8) return null;
      o += size;
    }
    return null;
  }

  const FREQS = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  // AudioSpecificConfig → thông số cho header ADTS.
  function readAsc(u8) {
    let pos = 0;
    const bits = (n) => { let v = 0; for (let i = 0; i < n; i++, pos++) v = (v << 1) | ((u8[pos >> 3] >> (7 - (pos & 7))) & 1); return v; };
    let aot = bits(5); if (aot === 31) aot = 32 + bits(6);
    let fi = bits(4); if (fi === 15) fi = FREQS.indexOf(bits(24));
    const ch = bits(4);
    if (aot === 5 || aot === 29) { bits(4); aot = bits(5); }   // HE-AAC: header ADTS ghi lớp AAC-LC lõi
    if (aot < 1 || aot > 4 || fi < 0 || ch < 1 || ch > 7) throw new Error('âm thanh AAC loại chưa hỗ trợ');
    return { profile: aot - 1, fi, ch };
  }
  function findEsds(dv, entry) {
    for (const b of boxes(dv, entry.start + 28, entry.end)) {
      if (b.type === 'esds') return b;
      if (b.type === 'wave') { const e = child(dv, b, 'esds'); if (e) return e; }
    }
    return null;
  }
  function readDescriptorAsc(dv, esds) {
    let o = esds.start + 4;
    const len = () => { let n = 0; for (let i = 0; i < 4; i++) { const b = dv.getUint8(o++); n = (n << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return n; };
    while (o < esds.end) {
      const tag = dv.getUint8(o++);
      const n = len();
      if (tag === 0x03) { const flags = dv.getUint8(o + 2); o += 3; if (flags & 0x80) o += 2; if (flags & 0x40) o += 1 + dv.getUint8(o); if (flags & 0x20) o += 2; continue; }
      if (tag === 0x04) { o += 13; continue; }
      if (tag === 0x05) return new Uint8Array(dv.buffer, dv.byteOffset + o, n);
      o += n;
    }
    throw new Error('không đọc được cấu hình âm thanh');
  }

  // moov (ArrayBuffer bắt đầu từ đầu file) → bảng mẫu âm thanh.
  function parse(buf) {
    const dv = new DataView(buf);
    let moov = null;
    for (const b of boxes(dv, 0, buf.byteLength)) if (b.type === 'moov') moov = b;
    if (!moov) throw new Error('không thấy mục lục video');
    const mvhd = child(dv, moov, 'mvhd');
    const mv1 = dv.getUint8(mvhd.start) === 1;
    const movieScale = dv.getUint32(mvhd.start + (mv1 ? 20 : 12));
    const movieDur = mv1 ? Number(dv.getBigUint64(mvhd.start + 24)) : dv.getUint32(mvhd.start + 16);
    if (child(dv, moov, 'mvex')) throw new Error('video dạng phân mảnh (chưa hỗ trợ)');
    let trak = null;
    for (const b of boxes(dv, moov.start, moov.end)) {
      if (b.type !== 'trak') continue;
      const hdlr = path(dv, b, ['mdia', 'hdlr']);
      if (hdlr && type4(dv, hdlr.start + 8) === 'soun') { trak = b; break; }
    }
    if (!trak) throw new Error('video không có âm thanh');
    const mdhd = path(dv, trak, ['mdia', 'mdhd']);
    const scale = dv.getUint32(mdhd.start + (dv.getUint8(mdhd.start) === 1 ? 20 : 12));
    const stbl = path(dv, trak, ['mdia', 'minf', 'stbl']);
    const stsd = child(dv, stbl, 'stsd');
    const entry = boxes(dv, stsd.start + 8, stsd.end).next().value;
    if (!entry || entry.type !== 'mp4a') throw new Error('âm thanh không phải AAC (' + (entry ? entry.type : '?') + ')');
    const esds = findEsds(dv, entry);
    if (!esds) throw new Error('không đọc được cấu hình âm thanh');
    const asc = readAsc(readDescriptorAsc(dv, esds));

    // Edit list: khoảng trống đầu (media_time = -1) đẩy âm thanh muộn lại; media_time > 0 (priming) kéo sớm lên.
    let shift = 0;
    const elst = path(dv, trak, ['edts', 'elst']);
    if (elst) {
      const v1 = dv.getUint8(elst.start) === 1;
      const n = dv.getUint32(elst.start + 4);
      let o = elst.start + 8;
      for (let i = 0; i < n; i++) {
        const dur = v1 ? Number(dv.getBigUint64(o)) : dv.getUint32(o);
        const mt = v1 ? Number(dv.getBigInt64(o + 8)) : dv.getInt32(o + 4);
        o += v1 ? 20 : 12;
        if (mt === -1) shift += dur / movieScale;
        else { shift -= mt / scale; break; }
      }
    }

    const stsz = child(dv, stbl, 'stsz');
    const fixed = dv.getUint32(stsz.start + 4);
    const count = dv.getUint32(stsz.start + 8);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.start + 12 + 4 * i);

    const pts = new Float64Array(count);
    const stts = child(dv, stbl, 'stts');
    let t = 0, k = 0;
    for (let e = 0, n = dv.getUint32(stts.start + 4); e < n && k < count; e++) {
      const c = dv.getUint32(stts.start + 8 + 8 * e), d = dv.getUint32(stts.start + 12 + 8 * e);
      for (let j = 0; j < c && k < count; j++, k++) { pts[k] = t / scale + shift; t += d; }
    }

    const co = child(dv, stbl, 'stco') || child(dv, stbl, 'co64');
    const big = co.type === 'co64';
    const nChunks = dv.getUint32(co.start + 4);
    const chunkOff = (i) => (big ? Number(dv.getBigUint64(co.start + 8 + 8 * i)) : dv.getUint32(co.start + 8 + 4 * i));
    const stsc = child(dv, stbl, 'stsc');
    const nStsc = dv.getUint32(stsc.start + 4);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let e = 0; e < nStsc; e++) {
      const first = dv.getUint32(stsc.start + 8 + 12 * e) - 1;
      const per = dv.getUint32(stsc.start + 12 + 12 * e);
      const last = e + 1 < nStsc ? dv.getUint32(stsc.start + 20 + 12 * e) - 1 : nChunks;
      for (let c = first; c < last && s < count; c++) {
        let o = chunkOff(c);
        for (let j = 0; j < per && s < count; j++, s++) { offsets[s] = o; o += sizes[s]; }
      }
    }
    return { duration: movieDur / movieScale, asc, pts, sizes, offsets, count };
  }

  // Các mẫu âm thanh trong [a, b) giây → khoảng byte cần tải và hàm dựng file ADTS từ phần đã tải.
  function window(m, a, b) {
    let lo = 0, hi = m.count;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (m.pts[mid] < a) lo = mid + 1; else hi = mid; }
    const i0 = lo;
    let i1 = i0;
    while (i1 < m.count && m.pts[i1] < b) i1++;
    if (i1 <= i0) return null;
    let start = Infinity, end = 0;
    for (let i = i0; i < i1; i++) { start = Math.min(start, m.offsets[i]); end = Math.max(end, m.offsets[i] + m.sizes[i]); }
    return {
      start, end, startTime: m.pts[i0], seconds: m.pts[i1 - 1] - m.pts[i0],
      build(buf) {
        let total = 0;
        for (let i = i0; i < i1; i++) total += m.sizes[i] + 7;
        const out = new Uint8Array(total);
        const src = new Uint8Array(buf);
        const { profile, fi, ch } = m.asc;
        let o = 0;
        for (let i = i0; i < i1; i++) {
          const n = m.sizes[i] + 7;
          out[o] = 0xff; out[o + 1] = 0xf1;
          out[o + 2] = (profile << 6) | (fi << 2) | (ch >> 2);
          out[o + 3] = ((ch & 3) << 6) | (n >> 11);
          out[o + 4] = (n >> 3) & 0xff;
          out[o + 5] = ((n & 7) << 5) | 0x1f;
          out[o + 6] = 0xfc;
          out.set(src.subarray(m.offsets[i] - start, m.offsets[i] - start + m.sizes[i]), o + 7);
          o += n;
        }
        return out;
      },
    };
  }

  globalThis.TodMp4 = { headerEnd, parse, window };
})();

// Quét cấu trúc MP4 ở phần đầu file (không giải mã gì): box cấp cao nhất,
// moov có nằm trước mdat không (faststart), có track âm thanh mp4a không.
(() => {
  'use strict';
  const ascii = (u8, i) => String.fromCharCode(u8[i], u8[i + 1], u8[i + 2], u8[i + 3]);
  const u32 = (u8, i) => ((u8[i] << 24) >>> 0) + (u8[i + 1] << 16) + (u8[i + 2] << 8) + u8[i + 3];

  function indexOfToken(u8, token, from, to) {
    const t = [...token].map(c => c.charCodeAt(0));
    for (let i = from; i <= to - 4; i++) {
      if (u8[i] === t[0] && u8[i + 1] === t[1] && u8[i + 2] === t[2] && u8[i + 3] === t[3]) return i;
    }
    return -1;
  }

  function scan(u8) {
    const out = { bytes: u8.length, top: [], faststart: null, moovComplete: false,
      hasMp4a: false, videoCodec: null, hasElst: false, isMp4: false };
    let off = 0;
    let moov = null;
    let mdatAt = -1;
    while (off + 8 <= u8.length && out.top.length < 20) {
      let size = u32(u8, off);
      const type = ascii(u8, off + 4);
      if (!/^[a-zA-Z0-9 ]{4}$/.test(type)) break;
      if (size === 1) {
        if (off + 16 > u8.length) { out.top.push(type); break; }
        size = u32(u8, off + 8) * 4294967296 + u32(u8, off + 12);
      } else if (size === 0) {
        size = Infinity;
      }
      out.top.push(type);
      if (type === 'moov' && moov === null) moov = { start: off, end: off + size };
      if (type === 'mdat' && mdatAt < 0) mdatAt = off;
      if (size < 8 || !isFinite(size)) break;
      off += size;
    }
    out.isMp4 = out.top[0] === 'ftyp' || out.top[0] === 'styp' || out.top[0] === 'sidx' || out.top[0] === 'moov';
    if (moov) out.faststart = mdatAt < 0 || moov.start < mdatAt;
    else if (mdatAt >= 0) out.faststart = false;
    // Chỉ tìm codec trong moov: mdat là dữ liệu ngẫu nhiên, còn ftyp chỉ liệt kê nhãn tương thích.
    if (!moov) return out;
    const from = moov.start;
    const to = Math.min(moov.end, u8.length);
    out.moovComplete = moov.end <= u8.length;
    out.hasMp4a = indexOfToken(u8, 'mp4a', from, to) >= 0;
    out.hasElst = indexOfToken(u8, 'elst', from, to) >= 0;
    for (const c of ['avc1', 'hvc1', 'hev1', 'av01', 'vp09']) {
      if (indexOfToken(u8, c, from, to) >= 0) { out.videoCodec = c; break; }
    }
    return out;
  }

  globalThis.__todS1Mp4Scan = scan;
})();

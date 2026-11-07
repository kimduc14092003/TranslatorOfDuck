// Đọc mốc thời gian của các mẩu MP4 phân mảnh (fMP4) mà trình phát nạp vào Media Source Extensions: mẩu đầu (init: ftyp + moov)
// cho thước thời gian (timescale) và độ dài mẫu mặc định (trex); mỗi mẩu sau (moof + mdat) cho mốc bắt đầu (tfdt) và độ dài (trun).
// Dùng cho bộ đọc chung (web.js). Không đụng chrome.*, chạy được trong Node để test (alpha/dev/web-test.mjs).
(function (root) {
  const type4 = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  function* boxes(dv, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = dv.getUint32(o), head = 8;
      if (size === 1) { if (o + 16 > end) return; size = Number(dv.getBigUint64(o + 8)); head = 16; } else if (size === 0) size = end - o;
      if (size < head || o + size > end) return;
      yield { type: type4(dv, o + 4), start: o + head, end: o + size, at: o };
      o += size;
    }
  }
  const child = (dv, box, type) => { for (const b of boxes(dv, box.start, box.end)) if (b.type === type) return b; return null; };
  const dvOf = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const top = (u8) => [...boxes(dvOf(u8), 0, u8.byteLength)];

  // Mẩu init: { timescale, defaultDuration } của track đầu tiên (mẩu âm thanh riêng chỉ có một track). Không phải init: null.
  function readInit(u8) {
    const dv = dvOf(u8);
    const moov = top(u8).find((b) => b.type === 'moov');
    if (!moov) return null;
    const trak = child(dv, moov, 'trak');
    const mdia = trak && child(dv, trak, 'mdia');
    const mdhd = mdia && child(dv, mdia, 'mdhd');
    if (!mdhd) return null;
    const timescale = dv.getUint32(mdhd.start + (dv.getUint8(mdhd.start) === 1 ? 20 : 12));
    let defaultDuration = 0;
    const mvex = child(dv, moov, 'mvex');
    const trex = mvex && child(dv, mvex, 'trex');
    if (trex) defaultDuration = dv.getUint32(trex.start + 12);
    return { timescale, defaultDuration, end: moov.end };
  }

  // Các đoạn thời gian (giây, chưa cộng timestampOffset) trong một lần nạp: mỗi cặp moof có tfdt và trun. byteStart, byteEnd: vị
  // trí moof và hết mdat theo sau trong u8, để chỉ gửi đúng các mảnh cần (TikTok nạp hơn 10 s một lần).
  function readSegments(u8, init) {
    const dv = dvOf(u8), out = [];
    if (!init || !init.timescale) return out;
    const tops = top(u8);
    for (const moof of tops.filter((b) => b.type === 'moof')) {
      // Chỉ nhận mảnh có mdat theo sau trong cùng lần nạp (thiếu dữ liệu mẫu thì ffmpeg không giải được: Astra 7/11, G02).
      const next = tops[tops.indexOf(moof) + 1];
      if (!next || next.type !== 'mdat') continue;
      const byteEnd = next.end;
      for (const traf of boxes(dv, moof.start, moof.end)) {
        if (traf.type !== 'traf') continue;
        let base = null, dur = 0, defDur = init.defaultDuration;
        for (const b of boxes(dv, traf.start, traf.end)) {
          const ver = dv.getUint8(b.start), flags = dv.getUint32(b.start) & 0xffffff;
          if (b.type === 'tfhd') {
            let o = b.start + 8;
            if (flags & 0x1) o += 8;
            if (flags & 0x2) o += 4;
            if (flags & 0x8) defDur = dv.getUint32(o);
          } else if (b.type === 'tfdt') {
            base = ver === 1 ? Number(dv.getBigUint64(b.start + 4)) : dv.getUint32(b.start + 4);
          } else if (b.type === 'trun') {
            // Số mẫu do trang đưa: chặn theo cỡ hộp, không lặp quá số mục hộp chứa được (trang giả dữ liệu, G01).
            const per = 4 * ((flags & 0x100 ? 1 : 0) + (flags & 0x200 ? 1 : 0) + (flags & 0x400 ? 1 : 0) + (flags & 0x800 ? 1 : 0));
            let o = b.start + 8;
            if (flags & 0x1) o += 4;
            if (flags & 0x4) o += 4;
            const n = Math.min(dv.getUint32(b.start + 4), per ? Math.floor((b.end - o) / per) : 1e5);
            for (let i = 0; i < n; i++) {
              if (flags & 0x100) { dur += dv.getUint32(o); o += 4; } else dur += defDur;
              if (flags & 0x200) o += 4;
              if (flags & 0x400) o += 4;
              if (flags & 0x800) o += 4;
            }
          }
        }
        if (base != null) out.push({ start: base / init.timescale, end: (base + dur) / init.timescale, byteStart: moof.at, byteEnd });
      }
    }
    return out;
  }
  root.TodFmp4 = { readInit, readSegments };
})(globalThis);

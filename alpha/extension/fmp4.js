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

  const kids = (dv, box, type) => [...boxes(dv, box.start, box.end)].filter((b) => b.type === type);
  // Ghép hộp MP4: cỡ 4 byte + loại + nội dung.
  function box(type, ...parts) {
    const n = 8 + parts.reduce((x, p) => x + p.length, 0), out = new Uint8Array(n), dv = new DataView(out.buffer);
    dv.setUint32(0, n);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const whole = (u8, b) => u8.subarray(b.at, b.end);
  const trackIdOf = (dv, trak) => { const h = child(dv, trak, 'tkhd'); return h ? dv.getUint32(h.start + (dv.getUint8(h.start) === 1 ? 20 : 12)) : 0; };

  // Mẩu init: { timescale, defaultDuration, trackId, end } của track âm thanh (hdlr 'soun'; không có thì track đầu). Mẩu gộp hình +
  // tiếng (nhiều track, như huangguoai.com: HEVC + AAC chung một SourceBuffer, 7/11): mux = true và initBytes là mẩu init chỉ có
  // track âm thanh (ftyp, mvhd, trak âm thanh, trex của nó), để server giải như âm thanh riêng. Không phải init: null.
  function readInit(u8) {
    const dv = dvOf(u8), tops = top(u8);
    const moov = tops.find((b) => b.type === 'moov');
    if (!moov) return null;
    const traks = kids(dv, moov, 'trak');
    const handler = (t) => { const m = child(dv, t, 'mdia'), h = m && child(dv, m, 'hdlr'); return h ? type4(dv, h.start + 8) : ''; };
    const trak = traks.find((t) => handler(t) === 'soun') || traks[0];
    const mdia = trak && child(dv, trak, 'mdia');
    const mdhd = mdia && child(dv, mdia, 'mdhd');
    if (!mdhd) return null;
    const timescale = dv.getUint32(mdhd.start + (dv.getUint8(mdhd.start) === 1 ? 20 : 12));
    const trackId = trackIdOf(dv, trak);
    let defaultDuration = 0, defaultSize = 0;
    const mvex = child(dv, moov, 'mvex');
    const trexes = mvex ? kids(dv, mvex, 'trex') : [];
    const trex = trexes.find((x) => dv.getUint32(x.start + 4) === trackId) || trexes[0];
    if (trex) { defaultDuration = dv.getUint32(trex.start + 12); defaultSize = dv.getUint32(trex.start + 16); }
    const info = { timescale, defaultDuration, defaultSize, trackId, end: moov.end, mux: traks.length > 1 };
    if (info.mux) {
      const ftyp = tops.find((b) => b.type === 'ftyp'), mvhd = child(dv, moov, 'mvhd');
      const parts = [mvhd ? whole(u8, mvhd) : new Uint8Array(0), whole(u8, trak)];
      if (mvex) parts.push(box('mvex', ...kids(dv, mvex, 'mehd').map((b) => whole(u8, b)), ...(trex ? [whole(u8, trex)] : [])));
      const m = box('moov', ...parts);
      info.initBytes = ftyp ? new Uint8Array([...whole(u8, ftyp), ...m]) : m;
    }
    return info;
  }

  // Mẩu gộp hình + tiếng: chép riêng phần âm thanh của mỗi mảnh thành cặp moof + mdat mới (chỉ traf âm thanh; mdat chỉ có các
  // mẫu âm thanh). Mảnh thiếu mdat theo sau, hay vị trí mẫu nằm ngoài lần nạp: bỏ. Trả Uint8Array (rỗng nếu không có gì).
  function extractAudio(u8, init) {
    const dv = dvOf(u8), tops = top(u8), out = [];
    for (let i = 0; i < tops.length; i++) {
      const moof = tops[i];
      if (moof.type !== 'moof' || !tops[i + 1] || tops[i + 1].type !== 'mdat') continue;
      const mfhd = child(dv, moof, 'mfhd');
      for (const traf of kids(dv, moof, 'traf')) {
        const tfhd = child(dv, traf, 'tfhd');
        if (!tfhd || dv.getUint32(tfhd.start + 4) !== init.trackId) continue;
        const hf = dv.getUint32(tfhd.start) & 0xffffff;
        let o = tfhd.start + 8, base = moof.at, defSize = init.defaultSize;
        if (hf & 0x1) { base = Number(dv.getBigUint64(o)); o += 8; }
        const keep = [];   // các trường tuỳ chọn còn giữ của tfhd (bỏ base-data-offset)
        if (hf & 0x2) { keep.push(u8.subarray(o, o + 4)); o += 4; }
        if (hf & 0x8) { keep.push(u8.subarray(o, o + 4)); o += 4; }
        if (hf & 0x10) { defSize = dv.getUint32(o); keep.push(u8.subarray(o, o + 4)); o += 4; }
        if (hf & 0x20) { keep.push(u8.subarray(o, o + 4)); o += 4; }
        const head = new Uint8Array(8);
        new DataView(head.buffer).setUint32(0, 0x20000 | (hf & 0x3a));
        new DataView(head.buffer).setUint32(4, init.trackId);
        const newTfhd = box('tfhd', head, ...keep);
        const tfdt = child(dv, traf, 'tfdt');
        // Mỗi trun: vị trí dữ liệu cũ, tổng cỡ mẫu, bảng mẫu (giữ nguyên) để ghi lại với data_offset mới.
        const runs = [];
        let next = base;
        for (const trun of kids(dv, traf, 'trun')) {
          const ver = dv.getUint8(trun.start), tf = dv.getUint32(trun.start) & 0xffffff;
          const per = 4 * ((tf & 0x100 ? 1 : 0) + (tf & 0x200 ? 1 : 0) + (tf & 0x400 ? 1 : 0) + (tf & 0x800 ? 1 : 0));
          let p = trun.start + 8;
          let at = next;
          if (tf & 0x1) { at = base + dv.getInt32(p); p += 4; }
          const first = tf & 0x4 ? u8.subarray(p, p + 4) : null;
          if (tf & 0x4) p += 4;
          const n = Math.min(dv.getUint32(trun.start + 4), per ? Math.floor((trun.end - p) / per) : 1e5);
          let size = 0;
          for (let k = 0, q = p; k < n; k++, q += per) {
            const so = q + (tf & 0x100 ? 4 : 0);
            size += tf & 0x200 ? dv.getUint32(so) : defSize;
          }
          if (at < 0 || at + size > u8.length) { runs.length = 0; break; }
          runs.push({ ver, tf, n, first, table: u8.subarray(p, p + n * per), data: u8.subarray(at, at + size) });
          next = at + size;
        }
        if (!runs.length) continue;
        const build = (offs) => box('moof', mfhd ? whole(u8, mfhd) : new Uint8Array(0), box('traf', newTfhd, tfdt ? whole(u8, tfdt) : new Uint8Array(0),
          ...runs.map((r, j) => {
            const h = new Uint8Array(12), hd = new DataView(h.buffer);
            hd.setUint32(0, (r.ver << 24) | (r.tf | 0x1)); hd.setUint32(4, r.n); hd.setInt32(8, offs[j]);
            return box('trun', h, ...(r.first ? [r.first] : []), r.table);
          })));
        const len = build(runs.map(() => 0)).length;
        const offs = [];
        let acc = len + 8;
        for (const r of runs) { offs.push(acc); acc += r.data.length; }
        out.push(build(offs), box('mdat', ...runs.map((r) => r.data)));
      }
    }
    const n = out.reduce((x, p) => x + p.length, 0), all = new Uint8Array(n);
    let o = 0;
    for (const p of out) { all.set(p, o); o += p.length; }
    return all;
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
        // Mẩu gộp hình + tiếng: chỉ đọc traf của track âm thanh (traf hình có thước thời gian khác).
        const th = child(dv, traf, 'tfhd');
        if (init.trackId && th && dv.getUint32(th.start + 4) !== init.trackId) continue;
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
  root.TodFmp4 = { readInit, readSegments, extractAudio };
})(globalThis);

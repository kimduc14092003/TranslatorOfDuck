// Đường dự phòng cho trang bất kỳ (bản thử, nhánh claude/any-site-tab-audio): thu âm thanh của tab, gửi cho server nhận dạng và
// dịch, sub hiện trễ vài giây. Hàm dùng chung cho offscreen.js (thu, gửi) và tab.js (hiện sub); không đụng chrome.*, nên chạy
// được trong Node để test (alpha/dev/tablive-test.mjs).
(function (root) {
  // Âm thanh giữ liên tục trong bộ đệm (16 kHz, một kênh). Con trỏ (cursor, giây tính từ lúc bắt đầu thu): mốc đầu phần chưa dịch.
  // Mỗi lần gửi: âm thanh từ cursor − PRE tới hiện tại, dịch các câu bắt đầu từ cursor. Server bỏ lại câu cuối nếu còn đang nói
  // lúc âm thanh hết, trả mốc bắt đầu câu đó (next): con trỏ dời tới đó, lần sau gửi lại câu ấy cùng âm thanh mới. Trước đây
  // (khúc 5 s cố định) câu nói chậm bị cắt đôi ở ranh giới khúc (thử thật 6/11, HANDOFF §6ay).
  const RATE = 16000;
  // Gửi khi phần chưa dịch dài ≥ W giây và có ≥ MIN_NEW giây âm thanh mới kể từ lần gửi trước. Phần chưa dịch dài quá MAX_WAIT
  // giây (một câu dài mãi không hết): gửi final, server dịch hết. BACK: lùi from một chút, mốc câu ở lượt nhận dạng sau có thể
  // sớm hơn mốc next vài trăm ms.
  // from là đúng con trỏ: server cắt theo từng chữ từ đó (liveTrim, lệch mốc 0,15 s).
  const W = 5, PRE = 1.5, MIN_NEW = 2, MAX_WAIT = 15;
  const r1 = (x) => Math.round(x * 10) / 10;
  function plan(cursor, lastTo, now) {
    if (now - cursor < W || now - lastTo < MIN_NEW) return null;
    return { from: r1(cursor), to: r1(now), audioFrom: Math.max(0, cursor - PRE), final: now - cursor >= MAX_WAIT };
  }
  // Khoảng ngừng nói gần cuối nhất (giây tính từ đầu tail): cửa sổ 0,45 s có độ to (RMS) dưới 20% độ to cả đoạn, trong LOOK giây
  // cuối. Cắt âm thanh ở đó thì câu cuối đã nói xong: gửi final, khỏi để server giữ câu (ASR kéo mốc chữ cuối tới hết âm thanh nên
  // server hay tưởng câu còn dở: 17/21 lần giữ, sub trễ 14 s, thử thật 6/11). Không có (nhạc nền, nói liền): null.
  const LOOK = 2.5, PAUSE = 0.45;
  function rms(a, i0, i1) { let s = 0; for (let i = i0; i < i1; i++) s += a[i] * a[i]; return Math.sqrt(s / Math.max(1, i1 - i0)); }
  function findPause(int16, rate = RATE) {
    const win = Math.round(PAUSE * rate), hop = Math.round(0.05 * rate);
    if (int16.length < win * 4) return null;
    const all = rms(int16, 0, int16.length);
    const lim = Math.max(0.2 * all, 0.005 * 32768);
    for (let e = int16.length; e - win >= Math.max(0, int16.length - LOOK * rate); e -= hop) {
      if (rms(int16, e - win, e) < lim) return (e - win / 2) / rate;
    }
    return null;
  }
  // Con trỏ sau một lần gửi (to: hết âm thanh đã gửi). Lỗi, hay server cũ không trả next: coi như đã dịch hết tới to.
  function advance(cursor, to, res) {
    const next = res && typeof res.next === 'number' ? res.next : to;
    return Math.max(cursor, Math.min(next, to));
  }
  // Mức to nhất (0–1) của mẫu Int16: dưới QUIET suốt phần chưa dịch thì không gửi (khỏi trả tiền nhận dạng khúc im lặng).
  const QUIET = 0.01;
  function peak(int16) {
    let m = 0;
    for (let i = 0; i < int16.length; i++) { const v = Math.abs(int16[i]); if (v > m) m = v; }
    return m / 32768;
  }
  // File WAV PCM 16 bit một kênh.
  function wav(int16, rate = RATE) {
    const out = new Uint8Array(44 + int16.length * 2), v = new DataView(out.buffer);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
    str(0, 'RIFF'); v.setUint32(4, 36 + int16.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
    v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, int16.length * 2, true);
    for (let i = 0; i < int16.length; i++) v.setInt16(44 + i * 2, int16[i], true);
    return out;
  }
  // Độ trễ hiển thị (ms): dòng hiện ở lúc người nói bắt đầu nói + delay, để các dòng giữ đúng nhịp với nhau. Dòng về muộn hơn
  // mốc đó thì tăng delay (làm tròn lên 0,5 s, tối đa 20 s); không giảm trong một lượt thu (sub nhảy sớm, muộn khó theo hơn).
  const MAX_DELAY = 20000;
  function nextDelay(delay, cueStartMs, arrivedMs) {
    const late = arrivedMs - cueStartMs;
    return late > delay ? Math.min(MAX_DELAY, Math.ceil((late + 500) / 500) * 500) : delay;
  }
  // Dòng đang hiện lúc now (ms, theo đồng hồ hiển thị: giờ video khi trang có video, không thì đồng hồ máy). Mỗi dòng hiện từ
  // at + lag tới until + lag (giữ ít nhất 1,2 s cho dòng ngắn); lag: độ trễ của dòng (dòng dịch lúc đang xem: độ trễ hiện tại;
  // tua lại chỗ đã dịch: 0, hiện đúng lúc nói). Nhiều dòng cùng hợp: dòng bắt đầu muộn nhất. cues: [{ at, until, lag?, text }].
  function current(cues, now) {
    let pick = null;
    for (const c of cues) {
      const lag = c.lag || 0, from = c.at + lag;
      if (from <= now && now < Math.max(c.until, c.at + 1200) + lag && (!pick || from >= pick.at + (pick.lag || 0))) pick = c;
    }
    return pick;
  }
  // Giờ video (giây) lúc đồng hồ máy là at (ms), từ các mẫu tab.js ghi mỗi 100 ms: [{ w, vt, playing, rate }] theo thứ tự w. Mẫu
  // gần nhất trước at, cộng thời gian đã phát từ đó nếu đang phát. Không có mẫu nào trước at (hay quá 2 s): null.
  function videoTimeAt(samples, at) {
    let s = null;
    for (const x of samples) { if (x.w > at) break; s = x; }
    if (!s || at - s.w > 2000) return null;
    return s.vt + (s.playing ? ((at - s.w) / 1000) * (s.rate || 1) : 0);
  }
  // Dòng x đã chiếm phần lớn (> 50% dòng ngắn hơn) khoảng [a, b) (ms) chưa.
  function overlaps(x, a, b) {
    const o = Math.min(x.until, b) - Math.max(x.at, a);
    return o > 0.5 * Math.max(1, Math.min(x.until - x.at, b - a));
  }
  root.TodLive = { RATE, W, PRE, MIN_NEW, MAX_WAIT, QUIET, findPause, MAX_DELAY, plan, advance, peak, wav, nextDelay, current, videoTimeAt, overlaps };
})(globalThis);

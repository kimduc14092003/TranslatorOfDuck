// Đường dự phòng cho trang bất kỳ (bản thử, nhánh claude/any-site-tab-audio): thu âm thanh của tab, gửi từng khúc cho server
// nhận dạng và dịch, sub hiện trễ vài giây. Hàm dùng chung cho offscreen.js (thu, gửi) và tab.js (hiện sub); không đụng
// chrome.*, nên chạy được trong Node để test (alpha/dev/tablive-test.mjs).
(function (root) {
  // Khúc k dịch các câu BẮT ĐẦU trong [kW, (k+1)W) (giây tính từ lúc bắt đầu thu). Âm thanh thu dư PRE giây phía trước để đủ
  // chữ của câu vắt qua đầu khúc, dư TAIL giây phía sau để câu bắt đầu gần cuối khúc nói hết. Server cắt theo from/to
  // (windowAsr), như đoạn video Douyin. Khúc ngắn thì sub ra sớm hơn; dư hai đầu làm tốn thêm (PRE + TAIL) / W tiền nhận dạng.
  const W = 5, PRE = 1.5, TAIL = 1.5;
  // tail: thu dư phía sau (giây), đổi được để thử (cài đặt liveTail): dư nhiều thì câu nói chậm ít bị cắt ở ranh giới khúc hơn,
  // đổi lại sub trễ thêm đúng chừng đó.
  function windowOf(k, tail = TAIL) {
    return { k, from: k * W, to: (k + 1) * W, recStart: Math.max(0, k * W - PRE), recStop: (k + 1) * W + tail };
  }
  // Độ trễ hiển thị (ms): dòng hiện ở lúc người nói bắt đầu nói + delay, để các dòng giữ đúng nhịp với nhau. Dòng về muộn hơn
  // mốc đó thì tăng delay (làm tròn lên 0,5 s, tối đa 20 s); không giảm trong một lượt thu (sub nhảy sớm, muộn khó theo hơn).
  const MAX_DELAY = 20000;
  function nextDelay(delay, cueStartMs, arrivedMs) {
    const late = arrivedMs - cueStartMs;
    return late > delay ? Math.min(MAX_DELAY, Math.ceil((late + 500) / 500) * 500) : delay;
  }
  // Khúc im lặng (mức to nhất dưới ngưỡng suốt khúc): không gửi, khỏi trả tiền nhận dạng. levels: [[giây, mức 0–1], …].
  const QUIET = 0.01;
  function silent(levels, from, to) {
    const xs = levels.filter(([t]) => t >= from && t <= to);
    return xs.length > 0 && xs.every(([, m]) => m < QUIET);
  }
  // Dòng đang hiện lúc now (ms, đồng hồ máy): dòng đã tới giờ (at ≤ now) mới nhất, còn trong thời gian của nó (giữ ít nhất
  // 1,2 s cho dòng ngắn). cues: [{ at, until, text }] theo thứ tự at.
  function current(cues, now) {
    let pick = null;
    for (const c of cues) {
      if (c.at > now) break;
      if (now < Math.max(c.until, c.at + 1200)) pick = c;
    }
    return pick;
  }
  root.TodLive = { W, PRE, TAIL, MAX_DELAY, QUIET, windowOf, nextDelay, silent, current };
})(globalThis);

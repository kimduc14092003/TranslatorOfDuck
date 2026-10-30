// Gộp sub của các đoạn 30 s đã dịch xong thành một danh sách theo thời gian video.
// Hai đoạn kề nhau chạy nhận dạng giọng nói riêng (âm thanh gửi dư hai đầu), nên câu vắt qua ranh giới có thể
// có ở cả hai, mỗi bên nghe một kiểu. Dòng ở đầu đoạn sau mà bắt đầu trước khi người nói dứt dòng cuối đoạn trước:
//  - nằm gọn trong lời của dòng trước → là phần lặp, bỏ;
//  - kéo dài hơn (đoạn trước nghe thiếu) → giữ, cắt ngắn dòng trước; dòng trước còn dưới 0,8 s thì bỏ hẳn.
// Đo trên Douyin thật: "花了5.5元。" (đoạn trước) và "花了5.5块买了一把鞋刷子和一块肥皂，" (đoạn sau) — trước đây
// giữ dòng ngắn, mất nửa câu.
(() => {
  'use strict';
  const MIN = 0.8, GAP = 2 / 30;
  const se = (c) => c.se || c.end;
  // chunks: kết quả 'ok' của các đoạn, xếp theo thứ tự đoạn; mỗi cái có cues [{ start, end, se, vi, zh }].
  function merge(chunks) {
    const out = [];
    for (const ch of chunks) {
      for (const src of ch.cues) {
        const cue = { ...src };
        const overlaps = (x) => x && cue.start < se(x) - 0.1;
        let last = out[out.length - 1];
        if (overlaps(last)) {
          if (se(cue) <= se(last) + 0.1) continue;
          while (overlaps(last) && cue.start - GAP - last.start < MIN) { out.pop(); last = out[out.length - 1]; }
        }
        if (overlaps(last)) last.end = cue.start - GAP;
        else if (last && cue.start < last.end) last.end = Math.max(last.se || last.start, cue.start - GAP);
        out.push(cue);
      }
    }
    return out;
  }
  // Dòng đang hiện ở thời điểm t (cues đã xếp theo start).
  function at(cues, t) {
    for (const c of cues) { if (t >= c.start && t < c.end) return c; if (c.start > t) break; }
    return null;
  }
  globalThis.TodCues = { merge, at };
})();

// Gộp sub của các đoạn 30 s đã dịch xong thành một danh sách theo thời gian video.
// Hai đoạn kề nhau chạy nhận dạng giọng nói riêng (âm thanh gửi dư hai đầu), nên câu vắt qua ranh giới có thể
// có ở cả hai, mỗi bên nghe một kiểu. Dòng ở đầu đoạn sau mà bắt đầu trước khi người nói dứt dòng cuối đoạn trước:
//  - nằm gọn trong lời của dòng trước → là phần lặp, bỏ; nhưng chỉ khi chữ gốc (zh) của nó đã có trong các dòng đã gộp quanh đó.
//    Chữ mới (chỉ đoạn sau nghe được) thì nối vào dòng trước, không bỏ (cache 4/11: "哭" trong bài hát bị bỏ);
//  - kéo dài hơn (đoạn trước nghe thiếu) → giữ, cắt ngắn dòng trước; dòng trước còn dưới 0,8 s thì bỏ hẳn, nhưng chỉ khi chữ của
//    nó có trong dòng mới (và các dòng sau của cùng đoạn). Không có thì giữ dòng trước, dòng mới bắt đầu lúc dòng trước dứt lời
//    (cache 4/11: "我只有一台相机，" bị bỏ vì dòng sau "相机，还有一个很…" bắt đầu sau nó 0,7 s, mất "我只有一台").
// So chữ: bỏ dấu câu, khoảng trắng; vế từ 4 chữ khác một chữ (hai lượt nhận dạng nghe khác) vẫn là có. Dòng không có zh: như cũ.
// Đo trên Douyin thật: "花了5.5元。" (đoạn trước) và "花了5.5块买了一把鞋刷子和一块肥皂，" (đoạn sau) — trước đây
// giữ dòng ngắn, mất nửa câu.
// Sau khi gộp: dòng có nhiều chữ hơn đọc kịp (17 ký tự/giây) được hiện lâu hơn, vào quãng lặng sau lời (tối đa LINGER giây sau
// lúc dứt lời), không đè dòng kế. Đầu dòng không đổi nên nhịp sub vẫn như cũ. Dòng chưa biết dòng kế (dòng cuối đã có: đoạn sau
// chưa dịch xong, dòng tạm đang tới dần) thì không kéo dài: dòng kế có thể bắt đầu ngay sau, khi đó sub cũ đè lên lời mới tới
// 1,5 s (verifier 4/11: 32,6% dòng như vậy khi mô phỏng dòng tới dần). Ước lượng trên cache (4/11): dòng đọc kịp từ 64,4% lên
// 67,0% (HANDOFF §6ao); phần lớn dòng khó đọc có dòng kế bám sát ngay sau, không có quãng lặng.
(() => {
  'use strict';
  const MIN = 0.8, GAP = 2 / 30, CPS = 17, LINGER = 1.5;
  const se = (c) => c.se || c.end;
  const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('vi', { granularity: 'grapheme' }) : null;
  const chars = (t) => (seg ? [...seg.segment(String(t || ''))].length : [...String(t || '')].length);
  const norm = (t) => String(t || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '').slice(0, 400);
  // Số chữ phải sửa ít nhất để a thành một khúc liền của b (so chuỗi gần đúng).
  function editInside(a, b) {
    let prev = new Array(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return Math.min(...prev);
  }
  // Chữ gốc a đã có trong chữ b? (Dòng thiếu zh thì không so: merge giữ cách gộp cũ.)
  const covered = (a, b) => { a = norm(a); b = norm(b); return !a || b.includes(a) || (a.length >= 4 && editInside(a, b) <= 1); };
  // chunks: kết quả 'ok' của các đoạn, xếp theo thứ tự đoạn; mỗi cái có cues [{ start, end, se, vi, zh }].
  function merge(chunks) {
    const out = [];
    for (const ch of chunks) {
      ch.cues.forEach((src, k) => {
        const cue = { ...src };
        const overlaps = (x) => x && cue.start < se(x) - 0.1;
        const hasZh = (x) => typeof x.zh === 'string' && x.zh.trim();
        let last = out[out.length - 1];
        if (overlaps(last)) {
          if (se(cue) <= se(last) + 0.1) {
            const near = out.filter((x) => se(x) > cue.start - 0.5 && x.start < se(cue) + 0.5);
            if (!hasZh(cue) || !near.every(hasZh) || covered(cue.zh, near.map((x) => x.zh).join(''))) return;
            // Chữ chỉ đoạn sau nghe được: nối vào dòng trùng giờ với nó nhiều nhất (cả bản dịch), không bỏ. Khác loại (câu hát /
            // câu nói: dòng hát hiện "♪") thì bỏ như trước. Chữ mới lẫn chữ đã có thì nối cả: lặp vài chữ còn hơn mất chữ.
            const ov = (x) => Math.min(se(x), se(cue)) - Math.max(x.start, cue.start);
            const host = near.reduce((a, b) => (ov(b) > ov(a) ? b : a), last);
            if (!!host.sung !== !!cue.sung) return;
            host.vi = `${host.vi} ${cue.vi}`; host.zh = `${host.zh}${cue.zh}`;
            return;
          }
          while (overlaps(last) && cue.start - GAP - last.start < MIN) {
            // Dòng mới và các dòng tiếp theo của cùng đoạn bắt đầu tới 2 s sau lúc dòng trước dứt lời.
            const ahead = ch.cues.slice(k).filter((x, i) => i === 0 || x.start < se(last) + 2);
            // Dòng trước có chữ dòng mới không có: giữ nó, dòng mới bắt đầu lúc dòng trước dứt lời (giữ ít nhất MIN lời của dòng
            // mới). Không còn chỗ cho dòng trước (dòng mới phải bắt đầu ngay đầu nó): bỏ như trước (verifier 4/11).
            const later = Math.min(se(last) + GAP, Math.max(cue.start, se(cue) - MIN));
            if (hasZh(last) && ahead.every(hasZh) && later - GAP > last.start + 0.1 && !covered(last.zh, ahead.map((x) => x.zh).join(''))) {
              cue.start = later;
              break;
            }
            out.pop(); last = out[out.length - 1];
          }
        }
        if (overlaps(last)) last.end = cue.start - GAP;
        else if (last && cue.start < last.end) last.end = Math.max(last.se || last.start, cue.start - GAP);
        out.push(cue);
      });
    }
    out.forEach((c, i) => {
      const next = out[i + 1], need = chars(c.vi) / CPS;
      if (!next || c.end - c.start >= need) return;
      const end = Math.min(c.start + need, se(c) + LINGER, next.start - GAP);
      if (end > c.end) c.end = end;
    });
    return out;
  }
  // Dòng đang hiện ở thời điểm t (cues đã xếp theo start).
  function at(cues, t) {
    for (const c of cues) { if (t >= c.start && t < c.end) return c; if (c.start > t) break; }
    return null;
  }
  globalThis.TodCues = { merge, at };
})();

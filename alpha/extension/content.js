// Content script (ISOLATED) trên www.douyin.com — bản Alpha.
// 1. Nhận metadata video từ tap.main.js (JSON feed của chính trang).
// 2. Video dài được chia đoạn 30 s; luôn dịch trước 30 s so với chỗ đang xem (xem quá 10 s thì 60 s), tua tới đâu dịch tới đó.
//    Video 2 cái kế tiếp được dịch sẵn đoạn đầu. Tải đúng phần byte cần qua /aweme/v1/play/ (đường đã đo ở S1),
//    cắt riêng âm thanh (mp4audio.js) rồi gửi qua service worker tới server trên máy bạn.
// 3. Vẽ sub đè lên video theo thời gian phát (docs/PLAN.md §8).
(() => {
  'use strict';
  const UP = '__tod_alpha_up';
  const DOWN = '__tod_alpha_down';
  const PREFETCH = 4;            // số video kế tiếp được dịch sẵn đoạn đầu (lướt nhanh ~4 s/video vẫn kịp)
  const LOOKAHEAD = 30;          // luôn dịch trước chỗ đang xem bấy nhiêu giây
  // Chế độ video dài: ở lại video đang xem quá WATCH_MS (đang xem, không lướt qua) thì dịch trước LOOKAHEAD_LONG giây, hàng
  // dịch sẵn nhường hẳn video đang xem (currentBehind), đoạn kế tải trong lúc đoạn ở chỗ đang xem ở server (holdBack,
  // sendWait). Đo 2/11 trên Douyin thật (video 678 s, giới hạn 450 KB/s cho cả tab): bản 0.2.27 mỗi đoạn 30 s (5–6 MB) tải
  // 20–28 s, cộng 6–7 s ở server, cộng lượt tải dịch sẵn chen vào; đoạn nào cũng về khi chỗ đang xem đã vào đoạn đó 12–18 s,
  // 66% thời gian phát hiện "đang dịch". 10 s đầu (tính theo thời gian phát) như cũ: mô phỏng lướt feed, giữ hàng dịch sẵn
  // ngay từ lúc mở thì lướt 4 s/video còn 3/12 video có sẵn kết quả thay vì 4/12, mạng chậm lướt 8 s/video có 2 video không
  // kịp có sub; từ 10 s thì lướt 4 s hay 8 s/video vẫn y như cũ (mô phỏng chuyển chế độ ở 8, 10, 12 s cho cùng kết quả, 15 s
  // kém hơn ở 6000 B/s). Dịch trước 60 s chỉ khi một đoạn 30 s (cả phần gửi dư) ước tải quá SLOW_CHUNK_MS theo tốc độ lượt
  // tải xong gần nhất của video đó, và giữ luôn cho video đó (không bật tắt, kẻo huỷ việc đang tải): verifier đo trên mô
  // phỏng, mạng nhanh thì 60 s không bớt "đang dịch" mà người ở lại 12–25 s rồi lướt đi trả thêm 22–48% lượt nhận dạng, dịch.
  const LOOKAHEAD_LONG = 60, WATCH_MS = 10000, SLOW_CHUNK_MS = 10000;
  const FIRST = 20, STEP = 30;   // đoạn đầu ngắn để sub đầu ra nhanh, sau đó mỗi đoạn 30 s
  // Video ngắn hơn thế thì dịch một lần. Dài hơn thì đoạn đầu chỉ 20 s: đo khi lướt, /aweme/v1/play có lúc chuyển
  // sang máy chủ video chỉ tải được ~0,3 MB/s, tải trọn video 60 s mất cả chục giây mới có sub đầu.
  const SINGLE_MAX = 30;
  // Chế độ "dịch sẵn 10 s" (cài đặt first10, ô trong popup; bản thử 0.2.35–0.2.36, mặc định bật từ 0.2.37 sau khi chủ dự án
  // dùng thử, bỏ chọn thì dịch sẵn 20–30 s như trước; HANDOFF §6aa–§6ad): đoạn [0,10) rồi [10,20), rồi
  // 30 s; video ≤ F10_SINGLE giây dịch một lần. Video dịch sẵn chỉ làm 10 s đầu; video đang xem chỉ gửi đoạn sau đoạn ở chỗ
  // đang xem khi qua cửa chờ (f10Gate; lướt qua thì khỏi trả tiền). Đoạn 0 gửi dư F10_POST giây như mẩu nhanh.
  // Mô phỏng 2/11 (thời gian server dao động, bắt đầu ấm; HANDOFF §6ab–§6ac): lướt nhanh có sẵn sub nhiều hơn (1,2 MB/s lướt
  // 4 s: phủ 99% thay vì 21%; 3 MB/s lướt 2 s: 11/11 video thay vì 6,8/11) và bớt 45–63% giây nhận dạng; xem tiếp thì gần như
  // cách cũ (xem 15 s: 3 MB/s phủ 100%, 1,2 MB/s 95% thay vì 97%) nhưng tốn hơn 4–6% giây nhận dạng, ít rút gọn câu hơn; mạng
  // 450 KB/s xem hết video thì kém hẳn (27% thay vì 59%, bản 0.2.35).
  // Áp cho video chưa chia đoạn: video kế đang dịch sẵn và video đã gặp giữ cách cũ.
  // Đoạn 1 gửi dư F10_PRE1 giây phía trước (≥ 4 s: server giữ câu vắt qua giây 10, ghép sub thay dòng bị cắt của đoạn 0;
  // verifier 2/11: ≥ 13,6% đoạn đầu có lời có câu như vậy). Phần dư cuối ngắn hơn F10_TAIL giây: xem planFor.
  // Đoạn [10,20) (đoạn 1) tải ngay khi lướt tới (tải không tốn tiền; khi đoạn ở chỗ đang xem đã gửi hay xong) nhưng chỉ gửi
  // server khi đã xem F10_GATE ms, hay F10_GATE_W ms nếu video trước vừa được xem ≥ F10_WATCHED ms (đang xem hẳn, không lướt).
  // Chủ dự án dùng thử 2/11: đoạn [10,25) tải sau cửa 3 s, hụt sub ở giây 10 (tải 10 s qua máy chủ chậm; server 9 s). Mô phỏng
  // 2/11 (5 hạt giống, 11 video xem 15 s, 3 MB/s): tổng hụt trong [9,5; 16) s 7,5 s → 0,6 s; máy chủ chậm theo video 20,9 s →
  // 6,3 s; lướt 4 s tốn như cửa 3 s cũ (cửa 3 s mà tải sớm thì gấp đôi: gửi ở giây 3 rồi huỷ ở giây 4).
  // Đoạn chỉ còn ≤ F10_NEAR giây là tới thì không chờ cửa: tua sớm hay dừng thì cửa (tính theo thời gian đã phát) còn đóng, đoạn
  // kế gửi muộn, hụt ở ranh giới kế dài hơn cách cũ 1,8–3,3 s (mô phỏng của verifier 3/11, D3).
  const F10_SINGLE = 12, F10_FIRST = 10, F10_SECOND = 10, F10_GATE = 4000, F10_GATE_W = 1500, F10_WATCHED = 8000, F10_POST = 2,
    F10_PRE1 = 4.5, F10_TAIL = 8, F10_NEAR = 6;
  const PRE = 1.5, POST = 6;     // âm thanh gửi dư hai đầu để câu vắt qua ranh giới không bị cắt
  // Đoạn trước chưa dịch (vừa tua tới): gửi dư 8 s phía trước. Server lấy lời nói phần đó làm mạch câu cho bước dịch
  // và giữ câu vắt qua đầu đoạn (đo trên vlog thật: 30% đoạn sau tua dịch không có ngữ cảnh, sai xưng hô, mất nửa câu).
  const PRE_SEEK = 8;
  // Mẩu nhanh: chỗ đang xem chưa có sub (vừa tua tới, video chưa dịch sẵn) thì gửi ngay ~10 s âm thanh từ chỗ đó, song
  // song với đoạn 30 s. Mẩu ngắn tải, nhận dạng, dịch đều nhanh hơn (đo trên vlog: chờ đoạn 30 s mất 6–8 s). Gửi dư
  // 4,5 s phía trước để server giữ câu đang nói dở và lấy lời ngay trước làm mạch câu.
  const QUICK = 10, PRE_QUICK = 4.5;
  // Mẩu nhanh chỉ gửi khi chỗ đang xem đã đứng yên (phát bình thường, không nhảy) bấy nhiêu ms, mỗi lần tua một mẩu.
  // Mô phỏng của đợt rà soát 31/10 (nay ở alpha/dev/content-sim-test.mjs): kéo thanh tiến trình 3 s bắt đầu 8 lượt tải
  // (6 bị ngắt), và khi đoạn 30 s tải chậm thì cứ 8 s lại gửi một mẩu nhanh mới (q0, q8, q16, q24), mỗi mẩu tốn một lần
  // nhận dạng. Mẩu nối tiếp nay chỉ gửi khi đoạn ở chỗ đang xem đã bị bỏ vì không thể tải kịp (dropSlow).
  const SETTLE = 450;
  // Đoạn ngắn thế này thì đoạn đó cũng nhanh gần bằng mẩu nhanh: không gửi mẩu nhanh (video 12 s từng gửi cả mẩu nhanh
  // lẫn cả đoạn, cùng một phần âm thanh, nhận dạng hai lần).
  const QUICK_MIN_CHUNK = 16;
  // Đoạn ở chỗ tua tới đã tải từ trước lần tua mà quá bấy nhiêu ms chưa tải xong thì vẫn gửi mẩu nhanh (maybeQuick).
  const QUICK_STALL = 2000;
  // Mẩu nhanh tải một mình trước: đo 31/10 trên video 23 phút bitrate cao, đoạn 30 s (14,5 MB) và mẩu nhanh (5,7 MB) tải
  // cùng lúc thì mẩu nhanh mất 4,4 s, sub đầu ~8 s sau khi tua; tải một mình (6,7 MB, lần đo khác) 1,8 s. Khi mẩu nhanh
  // bắt đầu tải, ngắt các lượt tải đoạn 30 s của video đó bắt đầu sau lần tua mà chưa gửi; chúng tải lại sau khi mẩu
  // nhanh tải xong. Chờ tối đa bấy nhiêu ms: mẩu nhanh treo (CDN treo 15–37 s, §6f) thì đoạn 30 s không phải đợi theo.
  const QUICK_GATE_MAX = 3000;
  // Lỗi do server trả về (đã chạy nhận dạng rồi mới lỗi ở bước dịch, mỗi lần thử lại tốn tiền): thử lại sau 20 s, rồi
  // 60 s, rồi 180 s. Mô phỏng: key dịch sai thì trước đây một đoạn bị gửi lại mỗi 20 s mãi mãi.
  // Không gọi được server (chưa chạy "npm start", đang khởi động lại) hay lỗi tải video thì không tốn tiền: luôn 20 s
  // (đo 31/10, §6h: tắt server rồi bật lại, gọi lại sau ~20 s, sub ra sau 7,7 s). Giãn cả những lỗi này thì mở Douyin
  // trước khi chạy server, video đang xem phải chờ thêm 60–180 s sau khi server đã lên (mô phỏng: 163 s).
  const RETRY_MS = [20000, 60000, 180000];
  // Douyin trả HTTP 429 khi tải video (đo 1/11: 1/13 video, 2 đoạn, nhãn lỗi ~24 s). Trước đây gọi lại ngay một lần (gấp
  // đôi số lượt), lượt tải đoạn khác vẫn chạy, rồi mỗi đoạn tự thử lại sau 20 s. Nay mọi lượt tải (cả hai hàng, mọi video)
  // cùng nghỉ 5 s, rồi 15 s, 45 s nếu lại bị 429 (theo Retry-After nếu lâu hơn, tối đa 2 phút: Retry-After 600 từng
  // làm mọi video không tải gì 10 phút trong mô phỏng); tải được một lượt bắt đầu sau lần 429 cuối, hay 10 phút không bị
  // 429, thì tính lại từ 5 s. Hết thời gian nghỉ thì các đoạn bị 429 tải lại ngay.
  const BACKOFF_429 = [5000, 15000, 45000], RETRY_AFTER_MAX = 120000;
  // Đoạn ở chỗ đang xem tải chậm tới mức không thể có sub trước khi chỗ đang xem rời đoạn đó (dropSlow): chỉ xét sau khi
  // lượt tải đã chạy bấy nhiêu ms (ước tốc độ theo chính nó), và tính thêm SERVER_MS cho nhận dạng + dịch ở server.
  // Sub tới khi đoạn chỉ còn dưới SLOW_KEEP thì cũng bỏ: gần như vô ích, mà đoạn kế phải chờ sau nó (mô phỏng: lượt đầu video
  // rồi lượt nối tiếp của đoạn 0 cùng 1040–1400 B/s, sub đầu giây 16–19,5, nay 12,5 như bản 0.2.25).
  const SLOW_SLOT = 6000, SERVER_MS = 4000, SLOW_KEEP = 5000;
  // Câu background.js trả khi không gọi được server (fetch lỗi mạng), và khi địa chỉ server trong cài đặt không phải máy
  // này (chưa gửi gì). Không có phản hồi nào cũng tính là chưa tới server.
  const UNREACHABLE = /^không kết nối được server/, NOT_SENT = /^Bản Alpha chỉ gọi server trên máy/;
  // Độ lệch tối đa giữa <video>.currentTime và vị trí tap.main.js đọc được (đã tính thời gian trôi) để còn coi là cùng
  // thẻ <video>, cùng lúc phát.
  const CLOCK_TOL = 1;
  // Mở video chưa dịch sẵn (chỗ đang xem chưa có kết quả, chưa gửi server): hàng dịch sẵn không bắt đầu lượt tải mới cho
  // video khác tới khi video này gửi được mẩu đầu (mẩu nhanh hay đoạn ở chỗ đang xem), tối đa bấy nhiêu ms để lượt tải
  // treo (CDN treo 15–37 s, §6f) không chặn dịch sẵn. HANDOFF §6i: mẩu nhanh chỉ "tải một mình" khi hàng dịch sẵn rảnh.
  // Mô phỏng (mở kết quả tìm kiếm, 4 video kế, video 2 Mbit/s, RTT 150 ms): q0 gửi lúc 2300 → 1300 ms (đường truyền
  // 6 MB/s), 3800 → 1800 ms (3 MB/s), 7800 → 2800 ms (1,5 MB/s); video kế dịch sẵn xong muộn hơn 1,2–1,7 s.
  // Lượt tải dịch sẵn đang chạy lúc mở thì để chạy tiếp: ngắt chúng (mô phỏng lướt feed mỗi 4 s, 3 MB/s) thì 0/9 video có
  // sẵn kết quả khi lướt tới thay vì 4/9; 6 MB/s: 6/9 thay vì 7/9, tải bỏ phí 19,4 MB thay vì 10,4 MB.
  const PF_HOLD_MAX = 2500;
  // Cũng lúc đó: báo server làm nóng kết nối tới nhà cung cấp nhận dạng, dịch (POST /v1/warm), tối đa một lần mỗi bấy
  // nhiêu ms. Node đóng kết nối nghỉ quá ~4 s (đo: nghỉ 3,5 s dùng lại, 4,5 s mở mới), lần gọi đầu của video mới thường
  // trả thêm TCP+TLS; extension tải âm thanh 0,5–1,5 s rồi mới gửi, đủ che lần làm nóng.
  const WARM_GAP = 3000;

  // lyrics: dịch cả lời bài hát (dòng hát hiện "♪"); tắt thì bỏ qua bài hát như trước (PLAN §15). Mặc định bật (31/10).
  let settings = { enabled: true, server: 'http://127.0.0.1:8787', position: 'bottom', size: 'm', delay: 0, lyrics: true, first10: true };
  const lyricsOn = () => settings.lyrics !== false;
  // Kết quả như nhau ở hai chế độ lời bài hát: không có câu hát nào (cùng điều kiện noSinging ở server.mjs: số câu hát 0,
  // không phải bài hát, không phải đoạn cả bài, không có dòng ♪), hay không có âm thanh. Đoạn cả bài (song) ở chế độ thường
  // chỉ còn câu nói nhanh, có thể không có dòng ♪ nào mà vẫn thiếu lời hát.
  const modeFree = (r) => r.status === 'no_audio' || ((r.status === 'ok' || r.status === 'skipped') && typeof r.sung === 'number'
    && r.sung === 0 && r.label !== 'singing' && !r.song && !(r.cues || []).some(x => x.sung));
  const items = new Map();       // id -> metadata
  // Thứ tự video theo từng danh sách của trang (tap.main.js đặt tên: feed, related, post, search, mix…; không tính video
  // chỉ thấy ở API khác hay ở player). Danh sách nào chứa video đang xem thì video kế tiếp lấy theo danh sách đó.
  const orders = new Map();      // tên danh sách -> [id]
  const watched = new Set();     // video đã từng là video đang xem
  const vids = new Map();        // id -> { plan, media, url, total, chunks: Map k -> kết quả, cues }
  // Hai hàng tải riêng: video đang xem, và video kế tiếp (dịch sẵn). Đo trên Douyin thật: một lượt tải dịch sẵn
  // gặp CDN chậm mất 13 s, đoạn ở chỗ vừa tua tới phải chờ theo. Hàng dịch sẵn tải 2 video cùng lúc, để một lượt gặp
  // CDN chậm không chặn 3 video sau.
  const lanes = { current: { queue: [], busy: 0, max: 1 }, prefetch: { queue: [], busy: 0, max: 2 } };
  let currentId = null;
  let act = null;                // video đang xem tìm được trên trang (findActive); null: không thấy video nào
  let actAt = 0;                 // lần cuối thấy video đang xem (performance.now())
  let playing = false;           // video đang xem đang phát (dropSlow: dừng thì không vội)
  let playRate = 1;              // tốc độ phát của video đang xem
  let playhead = 0;              // vị trí thật trong video đang xem (giây)
  let headOf = null;             // playhead đang là của video nào
  // Lần cuối chỗ đang xem nhảy (tua, lướt sang video khác): { id, ph, at, since, from } theo performance.now().
  const settle = { id: null, ph: 0, at: 0, since: -Infinity, from: 0 };
  let quickTried = -1;           // lần "đứng yên" đã xét gửi mẩu nhanh (mỗi lần tua xét một lần)
  // Độ lệch đồng hồ trình phát Douyin so với <video>.currentTime (tap.main.js gửi). Feed 推荐 phát nối đoạn: tua thì
  // <video>.currentTime không đổi, chỉ đồng hồ trình phát nhảy. Giữ tin cuối của từng video: lúc lướt, trình phát có
  // thể sang video sau trước khi trang đổi slide, video trước không mất độ lệch. Mỗi tin kèm vị trí <video> lúc đọc
  // (mediaTime, at, paused, rate); chỉ cộng độ lệch khi thẻ <video> ta đọc khớp vị trí đó, vì cùng một video có thể
  // đang phát ở thẻ khác (mở ?modal_id= sau khi xem trên feed: mô phỏng ra 105 s thay cho 5 s).
  const clocks = new Map();      // id -> { offset, media, at, paused, rate }
  let clockLast = null;          // video của tin đồng hồ mới nhất (trình phát đang ở video nào)
  // Vị trí thật của <video> v trong video đang xem; null: chưa biết, giữ playhead cũ.
  const flips = new WeakMap();    // <video> -> { paused, at }: lần cuối thấy nó đổi dừng/phát
  function timeOf(v) {
    const now = performance.now();
    let f = flips.get(v);
    if (!f) flips.set(v, f = { paused: v.paused, at: -Infinity });
    else if (f.paused !== v.paused) { f.paused = v.paused; f.at = now; }
    const c = clocks.get(currentId);
    if (!c || !c.offset) return v.currentTime;
    const expect = c.media + (c.paused ? 0 : (performance.now() - c.at) / 1000 * c.rate);
    // Trạng thái dừng/phát cũng phải khớp: thẻ <video> khác đang phát ngang qua đúng chỗ trình phát feed đang dừng thì
    // không bị cộng nhầm (mô phỏng của verifier 31/10). Chỉ bỏ qua điều kiện này ~1 s sau khi chính thẻ <video> này vừa
    // đổi dừng/phát (tin đồng hồ mới chưa kịp tới); tính theo tuổi của tin thì nhịp nhắc 500 ms luôn lọt, vô tác dụng.
    if (Math.abs(v.currentTime - expect) < CLOCK_TOL && (c.paused === v.paused || (c.at <= f.at && now - f.at < 1000))) return v.currentTime + c.offset;
    // Vừa lướt: trình phát đã sang video sau, <video> cũ dừng lại mà trang chưa đổi slide. Tin cuối của video này (đang
    // phát) không còn khớp, nhưng <video> đứng yên không phải chỗ người xem tua tới: giữ chỗ cũ. Lấy giờ thô của <video>
    // ở đây thì chỗ đang xem rơi từ 332 s về 32 s, đoạn [20,50) bị tải và gửi dịch (mô phỏng: trang chậm 1,5 s). Thẻ
    // <video> khác đang phát (trang ?modal_id=) thì vẫn lấy giờ của nó.
    if (v.paused && clockLast !== currentId && headOf === currentId) return null;
    return v.currentTime;
  }
  let wanted = new Set();        // "id:k" các đoạn đang cần (schedule() tính lại 4 lần/giây)
  // Lần mở video đang xem (PF_HOLD_MAX, WARM_GAP): need: chỗ đang xem chưa có kết quả lúc mở (null: chưa xét được, chưa có
  // metadata hay không phải video); hold: hàng dịch sẵn đang nhường; since: lúc xét; warm: đã báo làm nóng.
  // played: số ms video đó đã phát kể từ lúc thành video đang xem (WATCH_MS; last: lần đọc trước).
  let opened = { id: null, need: null, hold: false, since: 0, warm: false, played: 0, last: 0 };
  // Chế độ first10: thời gian đã phát của các video vừa xem (gần nhất cuối), cho cửa chờ của đoạn 1 (f10Gate).
  let dwell = [];
  const f10Gate = () => (dwell.length && dwell[dwell.length - 1] >= F10_WATCHED ? F10_GATE_W : F10_GATE);
  // Đoạn k của video đang xem đã tải xong mà chưa được gửi: sau đoạn ở chỗ đang xem và chưa qua cửa chờ.
  const f10Hold = (id, k) => {
    const v = vids.get(id), plan = v && v.plan;
    return !!plan && !!v.short0 && id === currentId && k > Math.max(0, chunkAt(plan, playhead)) && !(opened.id === currentId && opened.played >= f10Gate())
      && !(plan[k] && plan[k][0] - playhead <= F10_NEAR);
  };
  const watching = () => opened.id === currentId && opened.played >= WATCH_MS;   // chế độ video dài
  // Dịch trước bao xa (chế độ video dài và đoạn tải chậm: LOOKAHEAD_LONG). v.bps: byte mỗi giây video (runChunk), v.speed:
  // byte/ms của lượt tải xong gần nhất.
  function aheadFor(v) {
    if (!watching() || !v) return LOOKAHEAD;
    if (!v.slow && v.speed > 0 && v.bps > 0 && (STEP + PRE + POST) * v.bps / v.speed > SLOW_CHUNK_MS) v.slow = true;
    return v.slow ? LOOKAHEAD_LONG : LOOKAHEAD;
  }
  let warmAt = -Infinity;        // lần báo làm nóng gần nhất (performance.now())

  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  // Service worker (background.js) có cùng bản với file này không, có đọc được NDJSON (stream) không. Chrome mở lại bằng
  // --load-extension có thể vẫn chạy background.js của bản trước (đo 2/11 trên Chromium của chủ dự án: worker bản trước 0.2.32,
  // không đọc được NDJSON, với content 0.2.33: mọi đoạn dịch mới báo "lỗi: không có phản hồi", 20 s sau mới có sub lấy từ
  // cache; HANDOFF §6y). Worker không báo ndjson (bản trước 0.2.34 không biết tin 'hello', Chrome trả undefined): gửi không
  // stream (JSON một lần, worker nào cũng đọc được). Bản khác manifest: bảng thông tin báo; đọc được NDJSON thì vẫn stream.
  // worker: null chưa biết (lỗi gửi, hay quá WORKER_WAIT: gửi không stream, lần gửi sau hỏi lại), 'ok', hay bản của worker
  // đang chạy ('?': không trả lời). Hỏi ngay khi trang mở, để lần gửi đầu không phải chờ worker thức dậy.
  const WORKER_WAIT = 2000;
  let worker = null, workerStream = false, workerAsk = null;
  function workerReady() {
    if (worker || !alive()) return Promise.resolve();
    if (workerAsk) return workerAsk;
    // Lỗi (không gửi được, extension vừa bị tải lại nên getManifest hỏng): để null, không làm hỏng lần gửi đang chờ.
    const ask = chrome.runtime.sendMessage({ type: 'hello' }).then((r) => {
      workerStream = !!(r && r.ndjson === true);
      worker = r && r.build === chrome.runtime.getManifest().version ? 'ok' : (r && typeof r.build === 'string' ? r.build.slice(0, 20) : '?');
    }).catch(() => {});
    // Worker kẹt không bao giờ trả lời: không để mọi lần gửi của trang chờ theo (verifier 2/11).
    return (workerAsk = Promise.race([ask, new Promise((r) => setTimeout(r, WORKER_WAIT))]).finally(() => { workerAsk = null; }));
  }
  workerReady();

  // ---------------------------------------------------------------- mốc thời gian lần mở video
  // Chỉ để đo sub đầu ra chậm ở đâu, không đổi hành vi. Trả trong câu trả lời {type:'status'} (cuối file) dưới tên marks:
  // [{ id, page, src, wall, t: { mốc: ms } }], tối đa MARKS_MAX video gần nhất đã là video đang xem, cũ trước.
  //   page: trang lúc video thành video đang xem: 'video' (/video/<id>, /note/<id>), 'modal' (?modal_id=), 'feed' (/,
  //     /jingxuan), 'other'. src: metadata lấy từ đâu (tap.main.js: 'ssr', 'fetch', 'xhr', 'player').
  //   wall: Date.now() lúc thành video đang xem (để khớp với log server).
  //   t: ms theo performance.now() tính từ lúc đó, xếp theo thời gian, mỗi mốc chỉ lần đầu; số âm: làm trước khi lướt tới
  //     (dịch sẵn). Mốc: current (0) thành video đang xem; item có metadata; video thấy thẻ <video> của nó; ready
  //     readyState >= 1; play thời gian phát chạy; settle bắt đầu tính "đứng yên" (SETTLE); moov, moovEnd tải mục lục;
  //     quickDl, quickDlEnd tải âm thanh mẩu nhanh; quickPost, quickPartial, quickReply gửi, dòng tạm đầu tiên (server gửi
  //     dần), nhận mẩu nhanh; chunkDl, chunkDlEnd, chunkPartial,
  //     chunkPost, chunkReply như vậy cho đoạn ở chỗ đang xem (video chưa xem: đoạn 0); drawn vẽ dòng sub đầu tiên.
  // Video chưa là video đang xem mà đã có mốc (dịch sẵn) giữ riêng, cũng tối đa MARKS_MAX.
  const MARKS_MAX = 20;
  const marks = new Map();       // id -> { at0, wall, page, src, ct, ev: { mốc: performance.now() } }
  function trimMarks() {
    for (const cur of [true, false]) {
      const ids = [...marks].filter(([, r]) => (r.at0 != null) === cur).map(([id]) => id);
      for (const id of ids.slice(0, Math.max(0, ids.length - MARKS_MAX))) marks.delete(id);
    }
  }
  function mark(id, name, at = performance.now()) {
    if (!id) return;
    let r = marks.get(id);
    if (!r) { marks.set(id, r = { at0: null, wall: null, page: null, src: null, ct: null, ev: {} }); trimMarks(); }
    if (!(name in r.ev)) r.ev[name] = at;
  }
  function pageKind() {
    const u = new URL(location.href);
    if (u.searchParams.get('modal_id')) return 'modal';
    if (/^\/(video|note)\/\d+/.test(u.pathname)) return 'video';
    return /^\/(jingxuan\/?)?$/.test(u.pathname) ? 'feed' : 'other';
  }
  function markCurrent(id) {
    // Xếp cuối danh sách (trimMarks bỏ cũ trước, status trả cũ trước). Video dịch sẵn giữ các mốc đã có (số âm); quay lại
    // video đã xem thì mốc mới.
    const old = marks.get(id);
    marks.delete(id);
    if (old && old.at0 == null) marks.set(id, old);
    mark(id, 'current');
    const r = marks.get(id), d = items.get(id);
    Object.assign(r, { at0: r.ev.current, wall: Date.now(), page: pageKind() });
    if (d) { r.src = d.seenSrc || null; mark(id, 'item', d.seenAt); }
    trimMarks();
  }
  function markVideo(pv) {
    const r = marks.get(currentId);
    if (!r || r.at0 == null) return;
    mark(currentId, 'video');
    if (pv.readyState >= 1) mark(currentId, 'ready');
    if ('play' in r.ev) return;
    if (!pv.paused && pv.readyState >= 1 && r.ct != null && pv.currentTime !== r.ct) mark(currentId, 'play');
    r.ct = pv.currentTime;
  }

  // ---------------------------------------------------------------- metadata từ trang
  function onItems(list) {
    for (const d of list) {
      if (!d || !d.id || d.id === 'undefined') continue;
      const prev = items.get(d.id);
      if (!prev || (d.gears.length + d.audio.length) > (prev.gears.length + prev.audio.length)) {
        // Lần đầu có metadata và từ đâu (mốc item).
        Object.assign(d, prev ? { seenAt: prev.seenAt, seenSrc: prev.seenSrc } : { seenAt: performance.now(), seenSrc: d.source || null });
        // Bản metadata mới (nhiều luồng hơn) có thể từ nguồn không có người đăng: giữ người đăng của bản trước.
        if (prev && !d.author && prev.author) Object.assign(d, { author: prev.author, authorGender: d.authorGender || prev.authorGender || null });
        items.set(d.id, d);
        const r = marks.get(d.id);
        if (r && r.at0 != null && !('item' in r.ev)) { r.src = d.seenSrc; mark(d.id, 'item', d.seenAt); }
      } else if (!prev.author && d.author) {
        // Chiều ngược lại: bản đang giữ không có người đăng, bản tới sau có (không nhiều luồng hơn nên không thay cả bản).
        Object.assign(prev, { author: d.author, authorGender: d.authorGender || null });
      }
      const name = d.feed === true ? 'feed' : d.feed;
      if (!name) continue;
      const order = orders.get(name) || [];
      orders.delete(name); orders.set(name, order);    // danh sách vừa nhận video xếp cuối (upcoming() chọn nó trước)
      if (!order.includes(d.id)) order.push(d.id);
    }
    schedule();
  }
  window.addEventListener(UP, (ev) => {
    let msg;
    try { msg = JSON.parse(ev.detail); } catch (_) { return; }
    if (msg.type === 'items') onItems(msg.data);
    else if (msg.type === 'clock' && msg.data && msg.data.id) {
      const c = msg.data, id = String(c.id);
      clocks.delete(id);
      clocks.set(id, { offset: Number(c.offset) || 0, media: Number(c.mediaTime), at: Number(c.at), paused: !!c.paused, rate: Number(c.rate) || 1 });
      if (clocks.size > 20) clocks.delete(clocks.keys().next().value);
      clockLast = id;
    }
  });

  // ---------------------------------------------------------------- video đang xem
  function findActive() {
    const u = new URL(location.href);
    const modal = u.searchParams.get('modal_id');
    if (modal) return { id: modal };
    // Trang tìm kiếm (/search/…, /root/search/…, /video/<id>/search/…): chỉ video mở trong modal mới là video đang xem.
    // Thẻ kết quả, video xem trước tự phát không tính: dịch chúng là trả tiền cho video người xem chưa mở (verifier 1/11).
    if (/\/search\//.test(u.pathname)) return null;
    const m = u.pathname.match(/^\/(video|note)\/(\d+)/);
    if (m) return { id: m[2] };
    // Slide feed phải đang thấy (xét <video> của chính nó nếu có). Đo 1/11: tìm từ feed (chuyển trang phía client) thì
    // slide feed cũ vẫn nằm trong DOM, ẩn, vẫn mang data-e2e="feed-active-video"; sub của video 29 s hiện đè lên video
    // xem trước 628 s của trang tìm kiếm.
    const el = document.querySelector('[data-e2e="feed-active-video"]');
    if (el && visibleArea(el.querySelector('video') || el) > 0) {
      const inner = el.getAttribute('data-e2e-vid') ? el : el.querySelector('[data-e2e-vid]');
      if (inner) return { id: inner.getAttribute('data-e2e-vid'), el };
    }
    const c = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    const cand = c && c.closest && c.closest('[data-e2e-vid]');
    if (cand) return { id: cand.getAttribute('data-e2e-vid'), el: cand };
    return null;
  }
  function visibleArea(v) {
    const r = v.getBoundingClientRect();
    return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
  }
  function videoFor(active) {
    // Slide có <video> riêng mà <video> đó không thấy: không mượn <video> khác (sub của video này sẽ đè lên video khác).
    if (active && active.el) { const v = active.el.querySelector('video'); if (v) return visibleArea(v) > 0 ? v : null; }
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) { const a = visibleArea(v); if (a > area) { area = a; best = v; } }
    return best;
  }

  // ---------------------------------------------------------------- dịch trước
  // redo: k -> phần âm thanh gửi dư (PRE hay PRE_SEEK) của đoạn bị bỏ khi đổi chế độ lời bài hát (resetResults).
  // pron, pronGen, pronQuick: bản đồ xưng hô của video (takePron).
  const vid = (id) => { let v = vids.get(id); if (!v) { v = { chunks: new Map(), quick: new Map(), cues: [], redo: new Map(), pron: null, pronGen: 0, pronQuick: false }; vids.set(id, v); } return v; };
  // Xưng hô theo cả video (P2, soát 837 dòng 1/11: khoảng 26/62 lỗi xưng hô là trôi khi sang đoạn mới, vd.
  // 7492643322209619257 nói 'chị' mà đoạn hát sau thành 'em'). Server trả "pronouns" (ai nói với ai, cặp đã chọn;
  // extension không đọc bên trong) trong kết quả; giữ theo video và gửi kèm mọi yêu cầu sau của video đó (đoạn, mẩu
  // nhanh, dịch sẵn, xin lại sau đổi chế độ hay lỗi). Server không giữ trạng thái (PLAN.md:141). Không gửi cho video khác.
  // Chỉ kết quả của yêu cầu gửi kèm đúng bản đang giữ (gen) mới thay nó: các yêu cầu gửi song song với cùng một bản (vd.
  // đoạn 0 và mẩu nhanh lúc mở video) không thay nhau qua lại. Riêng bản đến từ mẩu nhanh: kết quả đoạn 30 s gửi cùng lúc
  // với mẩu đó (gen - 1) thay nó một lần, vì dòng của đoạn thay dòng mẩu nhanh trên màn hình (mergeCues); đoạn sau theo
  // cặp của dòng đang hiện, không đổi cặp ở giây 30.
  const PRON_MAX = 4000;   // ký tự JSON; lớn hơn là bất thường, bỏ qua
  const pronPayload = (v) => (v.pron ? { pronouns: v.pron } : {});
  function takePron(v, gen, r, quick) {
    const p = r && r.status !== 'error' && r.status !== 'cancelled' ? r.pronouns : null;
    if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.keys(p).length) return;
    if (gen !== v.pronGen && !(!quick && v.pronQuick && gen === v.pronGen - 1)) return;
    let s;
    try { s = JSON.stringify(p); } catch (_) { return; }
    if (s.length > PRON_MAX) return;
    v.pron = JSON.parse(s); v.pronGen++; v.pronQuick = !!quick;
  }
  // Người đăng (tap.main.js): gợi ý vai, giới cho xưng hô (P4). Server đọc author dạng chuỗi hoặc { nickname, gender }.
  // Thiếu thì không gửi.
  const authorPayload = (d) => (!d.author ? {} : { author: d.authorGender ? { nickname: d.author, gender: d.authorGender } : d.author });
  const eligible = (d) => d && d.kind === 'video' && d.playUri && !/^https?:/.test(d.playUri);
  // Lưới đoạn cố định theo thời lượng (cùng video thì luôn cùng lưới, để cache dùng lại được).
  function planFor(id) {
    const v = vid(id);
    if (v.plan) return v.plan;
    const d = items.get(id);
    const D = (d && d.durationMs ? d.durationMs / 1000 : 0) || (v.media && v.media.duration) || 0;
    if (!D) return null;
    // first10: false chỉ tính khi chính người xem bỏ chọn ô (first10Set): popup 0.2.35–0.2.36 lưu cả object cài đặt, kèm
    // first10: false mặc định lúc đó, mỗi khi đổi bất kỳ cài đặt nào (verifier 3/11, D1).
    const f10 = settings.first10 !== false || !settings.first10Set;
    if (D <= (f10 ? F10_SINGLE : SINGLE_MAX)) v.plan = [[0, Math.ceil(D) + 1]];
    else if (f10) {
      v.short0 = true;
      v.plan = [[0, F10_FIRST]];
      for (let a = F10_FIRST; a < D;) { const b = a + (a === F10_FIRST ? F10_SECOND : STEP); v.plan.push([a, Math.min(b, Math.ceil(D) + 1)]); a = b; }
      // Phần dư cuối ngắn gộp vào đoạn trước nó (video 13 s: [0,14) một lần; 27 s: [0,10), [10,28)): bớt một lần gửi. Mô
      // phỏng 2/11 (5 hạt giống): độ phủ như để riêng, bớt vài giây nhận dạng.
      const [x, y] = v.plan.slice(-2);
      if (y[1] - y[0] < F10_TAIL) v.plan.splice(-2, 2, [x[0], y[1]]);
    } else { v.plan = [[0, FIRST]]; for (let a = FIRST; a < D; a += STEP) v.plan.push([a, Math.min(a + STEP, Math.ceil(D) + 1)]); }
    return v.plan;
  }
  const chunkAt = (plan, t) => plan.findIndex(([a, b]) => t >= a && t < b);
  // Lỗi thì thử lại sau c.wait (RETRY_MS, đặt lúc nhận lỗi: xem done() của runChunk), hoặc sau thời gian server báo nếu
  // lâu hơn (vd. dịch hết lượt trong ngày, key sai: server tạm nghỉ vài phút).
  // Lỗi tải video (chưa gửi server: dl) của video đang xem thì thử lại sau DL_RETRY_CUR, tối đa DL_FAST_MAX lần liền, rồi mới
  // theo RETRY_MS: tải lỗi không tốn tiền, và lần gọi lại qua /aweme/v1/play/ có thể sang máy chủ video khác. Đo 2/11 trên
  // Douyin thật: lượt tải lúc dịch sẵn treo hai lần ("tải video quá lâu"), lướt tới thì chờ đủ 20 s mới thử lại, nhãn "lỗi"
  // suốt lúc đó, có sub sau 16,9 s.
  const DL_RETRY_CUR = 1000, DL_FAST_MAX = 3;
  const fastRetry = (c, id) => !!c.dl && id === currentId && (c.dlFails || 0) <= DL_FAST_MAX;
  const retryWait = (c, id) => (fastRetry(c, id) ? DL_RETRY_CUR : Math.max(c.wait || RETRY_MS[0], c.retryAfterMs || 0));
  // Kết quả một yêu cầu đã gửi: trả true nếu là lỗi không do server trả (không gọi được, không có phản hồi). Server vừa
  // trả lời lại sau một lúc không gọi được (vừa chạy hoặc khởi động lại, thường là sau khi sửa .env): các đoạn đang chờ
  // thử lại được gửi ngay, đếm lỗi từ đầu, thay vì chờ hết 20–180 s (hay thời gian tạm nghỉ của server cũ) tính từ trước.
  let serverDown = false;
  function noteReply(r) {
    if (r.status === 'cancelled') return false;
    if (r.status === 'error' && UNREACHABLE.test(String(r.error || ''))) { serverDown = true; return true; }
    if (r.unreachable || (r.status === 'error' && NOT_SENT.test(String(r.error || '')))) return true;
    if (serverDown) {
      serverDown = false;
      for (const v of vids.values()) {
        for (const c of v.chunks.values()) if (c.status === 'error') Object.assign(c, { at: 0, fails: 0, wait: 0, retryAfterMs: 0 });
      }
    }
    return false;
  }
  function needsWork(id, k) {
    const c = vid(id).chunks.get(k);
    // Đoạn bị bỏ vì tải chậm (dropSlow): không tải lại khi chỗ đang xem còn trong đoạn đó (mẩu nối tiếp phủ chỗ đó; trước
    // đây hết thời gian chờ là tải lại ở 2 s cuối đoạn, server khởi động lại cũng làm nó tải lại ngay). Hết cần thì
    // cancelUnwanted xoá nó, tua về lại thì tải lại từ đầu.
    return !c || (c.status === 'error' && !c.slow && (c.rateLimited ? !rateWait() : Date.now() - (c.at || 0) > retryWait(c, id)));
  }
  // Thời gian nghỉ chung sau HTTP 429 (BACKOFF_429). at: lần 429 cuối; n: số lần 429 liên tiếp (về 0 khi tải được, hay
  // 10 phút không bị 429).
  const limit = { until: 0, at: 0, n: 0 };
  const rateWait = () => Math.max(0, limit.until - Date.now());
  const limited = () => Object.assign(new Error('Douyin tạm chặn tải video (HTTP 429)'), { rateLimited: true });
  function noteLimit(retryAfter) {
    const now = Date.now();
    if (now - limit.at > 600000) limit.n = 0;
    if (now >= limit.until) limit.n = Math.min(limit.n + 1, BACKOFF_429.length);   // các lượt 429 cùng lúc tính một lần
    limit.at = now;
    limit.until = Math.max(limit.until, now + Math.max(BACKOFF_429[Math.max(limit.n, 1) - 1], Math.min(retryAfter || 0, RETRY_AFTER_MAX)));
  }
  // Retry-After: số giây hoặc ngày giờ HTTP. Lượt tải đã chuyển sang CDN khác nguồn thì thường không đọc được (null).
  function parseRetryAfter(h) {
    if (!h) return 0;
    const s = Number(h);
    return Number.isFinite(s) ? s * 1000 : Math.max(0, (Date.parse(h) || 0) - Date.now());
  }
  function schedule() {
    wakeTurns();
    // Tắt sub: huỷ cả việc đang tải, đang ở server (trước đây vẫn chạy tiếp và tốn tiền dịch).
    if (!settings.enabled) {
      wanted = new Set();
      lanes.current.queue = []; lanes.prefetch.queue = [];
      cancelUnwanted();
      return;
    }
    // Không thấy video đang xem nào (trang tìm kiếm, vừa đóng modal, slide feed cũ bị ẩn): currentId vẫn là video cũ, chỗ
    // đang xem đọc ra 0 thì tải và gửi dịch đoạn [0,20), [20,50) của video không có trên màn hình (mô phỏng của verifier
    // 1/11). Không thêm việc mới; quá 1 s vẫn không thấy thì không còn video đang xem: huỷ việc của video cũ (cả mẩu nhanh)
    // như khi lướt đi (đóng modal mà việc đã gửi vẫn chạy ở server). Việc dịch sẵn video kế tiếp đã gửi thì giữ: đóng modal
    // rồi mở kết quả kế là luồng thường (verifier 1/11: huỷ nó thì phải gửi lại, server ngắt giữa lúc nhận dạng). Chờ 1 s
    // vì lúc lướt, giữa hai slide có thể có một lượt dò không thấy video nào.
    if (!currentId) return;
    if (!act) {
      if (performance.now() - actAt > 1000) {
        const old = currentId;
        currentId = null;
        // Giữ việc đã gửi tới server của video khác (dịch sẵn). Việc chưa gửi: rời feed sang trang không có video thì thôi,
        // không tải, không gửi thêm (verifier 1/11); còn ở feed (slide livestream, quảng cáo: không có video để dò) thì dịch
        // sẵn tiếp, lướt tới video kế là có sub ngay như trước (đo 1/11: feed mở đầu bằng một slide livestream).
        const u = new URL(location.href);
        const onFeed = /^\/(jingxuan\/?)?$/.test(u.pathname) && !u.searchParams.has('modal_id');
        wanted = new Set();
        for (const [id, v] of vids) if (id !== old) for (const [k, c] of v.chunks) if (c.status === 'pending' && (c.sent || onFeed)) wanted.add(id + ':' + k);
        lanes.current.queue = [];
        if (onFeed) for (const [id, k] of lanes.prefetch.queue) wanted.add(id + ':' + k);
        else lanes.prefetch.queue = [];
        cancelUnwanted();
        // Hàng dịch sẵn có thể đang nhường video cũ (prefetchHeld, nay hết vì không còn video đang xem): chạy lại ngay,
        // không chờ tới hết PF_HOLD_MAX (setTimeout trong opening()).
        if (onFeed) pump(lanes.prefetch);
      }
      return;
    }
    const want = [];
    const plan = planFor(currentId);
    const ahead = aheadFor(vids.get(currentId));
    // Chế độ first10: chưa qua cửa chờ (f10Gate) thì chỉ làm tới đoạn ngay sau đoạn ở chỗ đang xem; đoạn đó tải nhưng chưa
    // gửi (f10Hold), và chỉ khi đoạn ở chỗ đang xem đã gửi hay xong: hàng tải của video đang xem chỉ một chỗ, đoạn chờ cửa giữ
    // chỗ đó, lần tải lại đoạn ở chỗ đang xem (restartSlow) phải xếp sau (verifier 2/11, G1). Mở giữa video, tua sớm: đoạn ở
    // chỗ đang xem vẫn làm ngay (verifier 2/11).
    const cv = vids.get(currentId), ph0 = plan ? Math.max(0, chunkAt(plan, playhead)) : 0;
    const gated = !!cv && !!cv.short0 && !(opened.id === currentId && opened.played >= f10Gate());
    const c0 = cv && cv.chunks.get(ph0), early = !!c0 && (c0.sent || ['ok', 'skipped', 'no_audio'].includes(c0.status));
    if (plan) plan.forEach(([a, b], k) => { if (gated && k > ph0 + (early ? 1 : 0) && a - playhead > F10_NEAR) return; if (b > playhead && a < playhead + ahead) want.push([currentId, k]); });
    else want.push([currentId, 0]);
    for (const id of upcoming()) want.push([id, 0]);
    wanted = new Set(want.map(([id, k]) => id + ':' + k));
    bumpCurrent(plan);
    restartSlow(plan);   // trước khi xếp hàng: đoạn vừa thôi được tải lại trước các đoạn sau nó
    const todo = want.filter(([id, k]) => eligible(items.get(id)) && needsWork(id, k));
    lanes.current.queue = todo.filter(([id]) => id === currentId);
    lanes.prefetch.queue = todo.filter(([id]) => id !== currentId);
    cancelUnwanted();
    dropSlow(plan);
    maybeQuick(plan);
    opening(plan);
    pump(lanes.current);
    pump(lanes.prefetch);
  }
  // Video đang xem vừa mở: lần đầu có metadata thì xét chỗ đang xem đã có kết quả chưa (kết quả cuối, hay đoạn đó đã gửi
  // server lúc dịch sẵn). Chưa có: hàng dịch sẵn nhường (prefetchHeld) và báo server làm nóng kết nối (WARM_GAP: báo
  // muộn hơn nếu vừa báo cho video trước, thôi nếu đã có kết quả trước lúc đó).
  function opening(plan) {
    const o = opened;
    if (o.id !== currentId) return;
    const v = vids.get(currentId), ph = headOf === currentId ? playhead : 0;
    const c = v && v.chunks.get(plan ? chunkAt(plan, ph) : 0);
    const final = (x) => !!x && x.status !== 'pending' && x.status !== 'error';
    const done = final(c) || (!!v && [...v.quick.values()].some((q) => q.status === 'ok' && ph >= q.from && ph < q.to));
    if (o.need === null) {
      if (!eligible(items.get(currentId))) return;
      o.need = o.hold = !(done || (c && c.sent));
      o.since = performance.now();
      // Hết hạn nhường thì chạy lại hàng dịch sẵn, kể cả khi schedule() không chạy (<video> chưa sẵn sàng: readyState 0).
      if (o.hold) setTimeout(() => pump(lanes.prefetch), PF_HOLD_MAX + 50);
    }
    if (!o.need || o.warm || done || performance.now() - warmAt < WARM_GAP || !alive()) return;
    o.warm = true; warmAt = performance.now();
    chrome.runtime.sendMessage({ type: 'warm', server: settings.server }).catch(() => {});
  }
  // Hàng dịch sẵn đang nhường video vừa mở: tới khi video đó gửi được mẩu đầu, hay quá PF_HOLD_MAX. Lượt tải dịch sẵn
  // đang chạy thì để chạy tiếp, chỉ không bắt đầu lượt mới.
  function prefetchHeld() {
    const o = opened;
    if (!o.hold) return false;
    const v = vids.get(currentId);
    if (o.id !== currentId || performance.now() - o.since >= PF_HOLD_MAX
      || (v && ([...v.quick.values()].some((q) => q.sent) || [...v.chunks.values()].some((c) => c.sent)))) o.hold = false;
    return o.hold;
  }
  // Video sắp lướt tới: các video sau video đang xem trong danh sách chứa nó (danh sách nhận thêm video gần nhất nếu có
  // nhiều). Video đang xem không có trong danh sách nào (đo khi vào trang: 1–2 video đầu chỉ thấy qua player, feed tới
  // sau) thì lấy các video feed chưa xem.
  function upcoming() {
    let order = null;
    for (const o of orders.values()) if (o.includes(currentId)) order = o;
    const feed = orders.get('feed') || [];
    const next = order ? order.slice(order.indexOf(currentId) + 1) : feed.filter(id => !watched.has(id));
    return next.filter(id => eligible(items.get(id))).slice(0, PREFETCH);
  }
  // Đoạn không còn cần (tua đi chỗ khác, lướt sang video khác): đang tải thì ngắt (đo khi lướt: lượt tải của video
  // vừa lướt qua gặp máy chủ chậm làm video mới phải chờ thêm), đã gửi server thì huỷ (server bỏ nếu chưa xử lý),
  // để chỗ đang xem không phải xếp hàng sau các chỗ đã bỏ qua.
  function cancelUnwanted() {
    const keys = [];
    for (const [id, v] of vids) {
      // Phần gửi dư nhớ lúc đổi chế độ lời bài hát chỉ dùng cho lần xin lại ngay sau đó. Đoạn không còn cần (tua, lướt đi)
      // thì bỏ: lần sau tính lại theo đoạn trước, tua tới thì vẫn gửi dư 8 s cho đúng ngữ cảnh (§6e), dù phải nhận dạng lại.
      for (const k of v.redo.keys()) if (!wanted.has(id + ':' + k)) v.redo.delete(k);
      let dropped = false;   // bỏ dòng tạm (partial) của yêu cầu vừa huỷ: tính lại v.cues
      for (const [k, c] of v.chunks) {
        // Đoạn bị bỏ vì tải chậm: chỗ đang xem ra khỏi nó (hết cần, hay tua lùi về đoạn trước) thì xoá, quay lại thì tải lại.
        if (c.slow && (!wanted.has(id + ':' + k) || (id === currentId && v.plan && chunkAt(v.plan, playhead) !== k))) { v.chunks.delete(k); continue; }
        if (c.status !== 'pending' || wanted.has(id + ':' + k)) continue;
        if (c.sent) { c.sent = false; keys.push(id + ':' + k); if (c.partial) { c.partial = null; dropped = true; } } else if (c.ctl) c.ctl.abort();
      }
      for (const [qa, q] of v.quick) {
        if (q.status !== 'pending' || quickWanted(id, q)) continue;
        if (q.sent) { q.sent = false; keys.push(id + ':q' + qa); if (q.partial) { q.partial = null; dropped = true; } } else q.ctl.abort();
      }
      if (dropped) mergeCues(v);
      headCheck(id, v);   // lượt tải đầu video không còn ai cần (vừa lướt đi, tua đi khi chưa có ai chờ) thì ngắt
    }
    if (keys.length && alive()) chrome.runtime.sendMessage({ type: 'cancel', keys }).catch(() => {});
  }
  // Lướt tới video đã được gửi dịch sẵn (lúc gửi chưa gấp): báo server làm nó trước các video kế tiếp.
  function bumpCurrent(plan) {
    const v = vids.get(currentId);
    if (!v || !plan) return;
    for (const [k, c] of v.chunks) {
      if (c.status !== 'pending' || !c.sent || c.urgent || !urgentChunk(currentId, k, plan) || !alive()) continue;
      c.urgent = true;
      chrome.runtime.sendMessage({ type: 'bump', server: settings.server, payload: { id: currentId, from: c.from, to: c.to } }).catch(() => {});
    }
  }
  // Hạn giờ theo "đứng im": đo khi lướt, lượt tải qua CDN có lúc treo 15–37 s không nhận byte nào, video đó không được
  // dịch sẵn. Quá idleMs không có dữ liệu thì bỏ để gọi lại. Tải chậm mà vẫn có dữ liệu (máy chủ hl-mly ~0,3 MB/s, đoạn
  // video dài tới 15 MB) thì không cắt, chỉ cắt khi quá totalMs.
  // prog (nếu có): ghi tiến độ của lượt tải đang chạy: since (lúc bắt đầu, performance.now()), got (số byte đã nhận), last
  // (lúc nhận byte cuối), gaps (các khoảng hơn 0,5 s không nhận byte nào). onBytes (nếu có): gọi mỗi lần nhận byte.
  async function rangeFetch(url, a, b, signal, idleMs = 6000, totalMs = 60000, prog = null, onBytes = null) {
    if (rateWait()) throw limited();   // đang nghỉ sau 429: không gọi
    const started = Date.now(), at = performance.now();
    if (prog) { prog.since = prog.last = at; prog.got = 0; prog.marks = []; prog.gaps = []; }
    const ctl = new AbortController();
    let timedOut = false, idle = null;
    const stop = () => { timedOut = true; ctl.abort(); };
    const kick = () => { clearTimeout(idle); idle = setTimeout(stop, idleMs); };
    const whole = setTimeout(stop, totalMs);
    const onAbort = () => ctl.abort();
    if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      kick();
      const res = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, credentials: 'omit', cache: 'no-store', signal: ctl.signal });
      if (res.status === 429) { noteLimit(parseRetryAfter(res.headers.get('retry-after'))); throw limited(); }
      if (res.status !== 206 && res.status !== 200) throw new Error('tải video: HTTP ' + res.status);
      const total = Number(((res.headers.get('content-range') || '').match(/\/(\d+)$/) || [])[1]) || null;
      const parts = [];
      let n = 0;
      const reader = res.body.getReader();
      for (;;) {
        kick();
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); n += value.byteLength;
        if (prog) { const t = performance.now(); if (t - prog.last > 500) prog.gaps.push([prog.last, t]); prog.got = n; prog.last = t; }
        if (onBytes) onBytes();
      }
      const all = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { all.set(p, o); o += p.byteLength; }
      let buf = all.buffer;
      if (res.status === 200 && a > 0) buf = buf.slice(a, b + 1);   // máy chủ bỏ qua Range
      if (started > limit.at) limit.n = 0;
      return { buf, total, url: res.url, at };
    } catch (e) {
      if (timedOut && !(signal && signal.aborted)) throw Object.assign(new Error('tải video quá lâu'), { timeout: true });
      throw e;
    } finally {
      clearTimeout(idle); clearTimeout(whole);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  // Mục lục (moov) của video: tải một lần, giữ lại cho các đoạn sau.
  function ensureMedia(id) {
    const v = vid(id);
    if (v.media) return Promise.resolve(v.media);
    if (!v.mediaLoading) v.mediaLoading = loadMedia(id, v).finally(() => { v.mediaLoading = null; });   // hai hàng tải dùng chung
    return v.mediaLoading;
  }
  function useMedia(id, v, api, media, total, url) {
    v.media = media;
    v.media.total = total;
    mark(id, 'moovEnd');
    v.api = api; v.url = url || api;
    // Chỉ giữ mục lục của 20 video gần nhất (video dài có mục lục vài MB).
    const withMedia = [...vids.entries()].filter(([, x]) => x.media);
    for (const [, x] of withMedia.slice(0, Math.max(0, withMedia.length - 20))) x.media = null;
    return v.media;
  }
  async function loadMedia(id, v) {
    const api = 'https://www.douyin.com/aweme/v1/play/?video_id=' + encodeURIComponent(items.get(id).playUri);
    mark(id, 'moov');
    // Đoạn đầu file treo (quá 4 s chưa thấy mục lục) hoặc lỗi mạng (đo được: máy chủ video cắt ngang,
    // ERR_CONTENT_LENGTH_MISMATCH) thì gọi lại một lần, có thể sang máy chủ video khác.
    const retry = (e) => e.timeout || e.slowMoov || e instanceof TypeError;
    // Mở video từ đầu (đoạn 0 đang cần, chưa có kết quả, chỗ đang xem trước giây QUICK hay chưa biết): một lượt tải cho cả
    // mục lục lẫn âm thanh đoạn 0 (loadHead). Chỗ đang xem đã xa hơn thì mẩu nhanh cần phần sau của đoạn 0: đọc từ byte 0
    // tới đó thì mẩu nhanh tới muộn hơn lượt tải riêng, và đoạn [0,20) (phần lớn đã phát qua) cũng bị gửi đi nhận dạng (mô
    // phỏng, mở ở giây 15, 3 MB/s, rtt 150 ms: mẩu nhanh 2650 ms thay vì 2200 ms).
    if (headWanted(id) && (id !== currentId || headOf !== id || playhead < QUICK)) return loadHead(id, v, api, 4000).catch((e) => { if (retry(e)) return loadHead(id, v, api, 8000); throw e; });
    // Mở giữa video (tua, đồng hồ trình phát feed ở giữa video): chỉ tải phần đầu file nhỏ (64 KB) lấy mục lục.
    const probe = await rangeFetch(api, 0, HEAD_PROBE - 1, null, 4000)
      .catch((e) => { if (retry(e)) return rangeFetch(api, 0, HEAD_PROBE - 1, null, 8000); throw e; });
    const head = TodMp4.headerEnd(probe.buf);
    if (head == null) throw new Error('video không có mục lục ở đầu file (chưa hỗ trợ)');
    const moov = head <= probe.buf.byteLength ? probe.buf : (await rangeFetch(probe.url || api, 0, head - 1)).buf;
    return useMedia(id, v, api, TodMp4.parse(moov), probe.total, probe.url);
  }
  // ---- Một lượt tải cho đầu video (mục lục + âm thanh đoạn 0)
  // Đo trên Douyin thật 1/11 (extension 0.2.25, 14 trang /video/): tải mục lục 0,7–1,7 s (3/14 lần 4,5–8,9 s), rồi mẩu
  // nhanh 0,4–1,2 s bằng một lượt hỏi máy chủ video nữa; đoạn 0 tải lại phần đầu file, bị mẩu nhanh ngắt rồi tải lại
  // (mô phỏng: phí 0,9–1,8 MB mỗi lần mở). Nay: một lượt tải từ byte 0 (Range "bytes=0-", như trình phát tự tải lúc mở
  // video), đọc mục lục ngay khi đủ byte, đọc tiếp trên chính lượt đó tới hết âm thanh đoạn 0 (mẩu nhanh đầu là phần đầu
  // của nó, gửi ngay khi đủ byte), rồi ngắt. Không thêm lượt tải song song, không thêm lượt hỏi máy chủ video.
  // Ngắt sớm khi không còn cần (lướt đi, tua đi, đoạn 0 bị bỏ vì tải chậm, tắt sub); mục lục thì vẫn đọc cho xong như
  // lượt tải 64 KB cũ (lần sau khỏi tải lại).
  const HEAD_PROBE = 65536;      // như lượt tải 64 KB cũ: quá chừng này byte mà chưa thấy moov thì coi như không có ở đầu file
  // Đoạn 0 của video này đang cần mà chưa có kết quả, chưa gửi (đoạn 0 luôn tải [0, cuối + POST): cùng byte dù gửi dư
  // bao nhiêu, nên lần xin lại theo luật v.redo vẫn gửi đúng phần âm thanh cũ).
  const headWanted = (id) => { const c = vid(id).chunks.get(0); return settings.enabled && wanted.has(id + ':0') && (!c || (c.status === 'pending' && !c.sent)); };
  function headBytes(h, a, b) {    // byte [a, b] (gồm b) trong phần đã nhận
    const out = new Uint8Array(Math.max(0, b - a + 1));
    let o = 0;
    for (const p of h.parts) {
      const s = Math.max(a, o), e = Math.min(b + 1, o + p.byteLength);
      if (e > s) out.set(p.subarray(s - o, e - o), s - a);
      o += p.byteLength;
      if (o > b) break;
    }
    return out.buffer;
  }
  // Lượt tải đầu video còn phục vụ được khoảng byte [.., b] (cùng mục lục; đã có tới đó, hay đang tải tới đó).
  const headServes = (v, media, b) => { const h = v.head; return !!h && h.media === media && b < h.end && (h.got > b || !h.closed); };
  // Lượt tải đầu video bị ngắt giữa chừng (tua đi lúc nó còn chạy, vd. vào [10,20) ở chế độ first10), hay đã xong mà đoạn 0 hết
  // cần (tua đi ngay sau đó), mà phần chính nó đã nhận (h.own) là phần đầu cửa sổ của một đoạn sau đang cần, chưa tải: giữ phần
  // đó, đoạn đó chỉ tải phần còn thiếu bằng lượt mới (fetchBytes, part). Trước đây bỏ ngay, đoạn đó tải lại cả phần đã nhận (mô
  // phỏng 3/11, 3 MB/s, tua tới giây 16 lúc 0,7 s: thừa 1,26 MB, gửi lúc 3,1 s). Không đọc tiếp chính lượt đó (đã thử, §6ae B3):
  // lượt đầu bị máy chủ cho chậm riêng thì đoạn đó phải chờ nó. Lượt đã xong mà đoạn 0 còn cần thì như cũ (phát bình thường).
  // Cửa sổ tính rộng nhất (gửi dư PRE_SEEK): giữ thừa chỉ tốn bộ nhớ tới khi đoạn đó tải xong.
  const headReuse = (id, v, h) => !!h.media && (h.own < h.end || !wanted.has(id + ':0')) && !!v.plan && v.plan.some(([a, b], k) => {
    if (k === 0 || !wanted.has(id + ':' + k)) return false;
    const c = v.chunks.get(k);
    if (c && c.status !== 'error' && !(c.status === 'pending' && !c.sent && !c.waiting)) return false;
    const w = TodMp4.window(h.media, Math.max(0, a - PRE_SEEK), b);
    return !!w && w.start < h.own;
  });
  // Xét lại lượt tải đầu video: không còn ai cần thì ngắt; xong rồi mà đoạn 0 hết cần hay đã có kết quả thì bỏ phần đã
  // nhận (giữ lại trong lúc đoạn 0 còn chờ: mẩu nhanh có thể tới sau, lấy từ đây khỏi tải lại; hay headReuse).
  function headCheck(id, v) {
    const h = v.head;
    if (!h) return;
    if (!h.closed) { if (h.media && !(h.got < h.end && (h.waiters.size || headWanted(id)))) { h.stopped = true; h.ctl.abort(); } return; }
    const c = v.chunks.get(0);
    if (!h.waiters.size && (!wanted.has(id + ':0') || (c && c.status !== 'pending')) && !headReuse(id, v, h)) v.head = null;
  }
  // Lượt tải đầu video chậm hẳn ngay từ đầu: q0 nay đi chung lượt đó nên cũng chậm, và dropSlow không còn lượt tải nhanh nào
  // để so (bản 0.2.25 tải q0 bằng lượt riêng; đo 1/11: q0 về nhanh mà lượt tải đoạn 0 mất ~25 s, cả hai tới cùng link CDN,
  // tức chậm theo từng lượt tải). Mô phỏng của verifier, lượt "bytes=0-" 1040 B/s từ byte 0: sub đầu giây 29 thay vì 12,5
  // (nay 7,5 s).
  // Nên: mẩu nhanh đang chờ trên lượt này mà theo tốc độ 1 s gần nhất phải chờ tổng cộng quá HEAD_SLOW mới đủ byte thì thôi
  // lượt này; mẩu nhanh rồi đoạn 0 tải nối tiếp phần còn thiếu bằng lượt riêng, lần lượt (fetchBytes), như bản 0.2.25 nhưng
  // không tải lại phần đã nhận. Mạng chậm đều thì lượt mới cũng chậm như vậy: chỉ mất thêm 1–2 rtt. Đang có lượt tải của
  // video khác nhận byte không nhanh hơn hẳn (othersLoading, như dropSlow) thì chậm có thể do chia đường truyền: không thôi
  // (mô phỏng 2500 B/s có 2 video dịch sẵn: thôi lượt này thì q0 không kịp, sub 1 s thay vì 1,75 s trong 60 s đầu).
  const HEAD_SLOW = 6000;
  // Mục lục của video đang xem tải quá MOOV_SLOW ms mà còn quá MOOV_LEFT ms nữa mới đủ: gọi lại (loadHead). Đo 2/11 trên Douyin
  // thật, 21 video: mục lục thường 0,5–1,7 s, 5 lần 3,6–4,9 s.
  const MOOV_SLOW = 2500, MOOV_LEFT = 1500;
  function headLate(h, now) {
    // Chế độ first10: đoạn 0 chỉ 10 s nên không có mẩu nhanh; đoạn 0 của video đang xem chờ trên lượt này thì xét chính
    // nó (verifier 2/11: lượt "bytes=0-" 150 KB/s, không có sub trong 15 s).
    const sv = vids.get(h.id);
    const q = [...h.waiters].find((w) => !w.prog) || (sv && sv.short0 && h.id === currentId ? [...h.waiters].find((w) => w.prog) : null);
    if (!q || now - h.first < 1000) return false;
    let g = 0;
    for (const [t, x] of h.hist) { if (t > now - 1000) break; g = x; }
    const rate = (h.got - g) / 1000;
    if (othersLoading(rate, h.at)) return false;
    return now - q.at + (rate > 0 ? (q.b + 1 - h.got) / rate : Infinity) > HEAD_SLOW;
  }
  // Trả mục lục khi đã đọc được; phần còn lại đọc tiếp ở nền cho các lượt chờ (headSlice). Hạn giờ như rangeFetch: im quá
  // idleMs (4 s trước khi có mục lục như lượt tải 64 KB cũ, 6 s sau đó như lượt tải đoạn) hay quá 60 s thì cắt. Lỗi sau khi
  // đã có mục lục (hay thôi vì chậm: headLate) thì các lượt chờ tự tải nối tiếp phần còn thiếu (fetchBytes).
  function loadHead(id, v, api, idleMs) {
    if (rateWait()) return Promise.reject(limited());   // đang nghỉ sau 429: không gọi
    const h = v.head = { id, parts: [], got: 0, end: Infinity, media: null, waiters: new Set(), closed: false, stopped: false,
      ctl: new AbortController(), at: performance.now(), first: null, hist: [], release: null, qGate: null, qOpen: null };
    return new Promise((resolve, reject) => {
      const started = Date.now();
      let timedOut = false, idle = null, idleNow = idleMs, head = null;
      const stop = () => { timedOut = true; h.ctl.abort(); };
      const kick = () => { clearTimeout(idle); idle = setTimeout(stop, idleNow); };
      const whole = setTimeout(stop, 60000);
      const close = (e) => {
        h.closed = true; h.own = h.got;
        // Đoạn và mẩu nhanh cùng chờ: đoạn tải sau khi mẩu nhanh tải xong phần của nó (tối đa QUICK_GATE_MAX), không song
        // song. Cổng quickGate của runQuick không dùng được: mẩu nhanh đã chờ trên lượt này quá 3 s thì nó đã tự mở.
        if ([...h.waiters].some((w) => !w.prog)) h.qGate = new Promise((r) => { h.qOpen = r; setTimeout(r, QUICK_GATE_MAX); });
        for (const w of [...h.waiters]) { h.waiters.delete(w); w.fail(e || new Error('tải video: thiếu dữ liệu')); }
        headCheck(id, v);
      };
      (async () => {
        try {
          kick();
          const res = await fetch(api, { headers: { Range: 'bytes=0-' }, credentials: 'omit', cache: 'no-store', signal: h.ctl.signal });
          if (res.status === 429) { noteLimit(parseRetryAfter(res.headers.get('retry-after'))); throw limited(); }
          if (res.status !== 206 && res.status !== 200) throw new Error('tải video: HTTP ' + res.status);
          // Máy chủ bỏ qua Range (200, cả file): vẫn từ byte 0, đọc tới chỗ cần rồi ngắt như trên. Cỡ file khi đó lấy theo
          // Content-Length, để fetchBytes vẫn nhận ra file đã đổi.
          const total = Number(((res.headers.get('content-range') || '').match(/\/(\d+)$/) || [])[1])
            || (res.status === 200 && Number(res.headers.get('content-length'))) || null;
          const reader = res.body.getReader();
          for (;;) {
            kick();
            const { done, value } = await reader.read();
            const now = performance.now();
            if (!done) { h.parts.push(value); h.got += value.byteLength; h.hist.push([now, h.got]); if (h.first == null) h.first = now; v.byteAt = now; }
            if (!h.media) {
              if (head == null) {
                head = TodMp4.headerEnd(headBytes(h, 0, h.got - 1));
                if (head == null && (done || h.got >= HEAD_PROBE)) throw new Error('video không có mục lục ở đầu file (chưa hỗ trợ)');
                if (head != null) idleNow = 6000;   // đã thấy moov: phần còn lại của nó như lượt tải [0, moov) cũ, im tới 6 s
              }
              // Video đang xem mà mục lục nhỏ giọt: quá MOOV_SLOW chưa đủ, theo tốc độ 1 s gần nhất còn quá MOOV_LEFT nữa, và có
              // bằng chứng là chậm riêng lượt này (spareCapacity): thôi lượt này, loadMedia gọi lại qua /aweme/v1/play/ (có thể
              // sang máy chủ video khác). Lượt nhỏ giọt không bao giờ "im" đủ lâu để idleMs cắt. Mỗi video một lần
              // (moovRetried), và chỉ khi có bằng chứng: lượt mới tải lại mục lục từ byte 0, đường truyền chậm đều mà cứ gọi lại
              // thì không bao giờ xong (mô phỏng: 9000 B/s, mục lục 150 KB: không có sub trong 20 s, bản trước 18 s).
              if (head != null && h.got < head && id === currentId && !v.moovRetried && now - h.at > MOOV_SLOW) {
                let g = 0;
                for (const [t, x] of h.hist) { if (t > now - 1000) break; g = x; }
                const rate = (h.got - g) / 1000;
                if (rate > 0 && (head - h.got) / rate > MOOV_LEFT && spareCapacity(rate, h.at)) {
                  v.moovRetried = true;
                  throw Object.assign(new Error('tải mục lục quá chậm'), { slowMoov: true });
                }
              }
              if (head != null && h.got >= head) {
                h.media = useMedia(id, v, api, TodMp4.parse(headBytes(h, 0, head - 1)), total, res.url);
                if (started > limit.at) limit.n = 0;
                // Đọc tiếp tới hết âm thanh đoạn 0 (cùng khoảng runChunk tính cho đoạn 0) nếu nó còn cần; không thì thôi.
                const plan = headWanted(id) && planFor(id);
                const w = plan && TodMp4.window(h.media, 0, plan[0][1] + (v.short0 ? F10_POST : POST));
                h.end = w ? w.end : head;
                resolve(h.media);
              } else if (done) throw new Error('tải video: thiếu dữ liệu');
            }
            if (done) break;
            for (const w of [...h.waiters]) {
              const p = w.prog;
              if (p) { if (now - p.last > 500) p.gaps.push([p.last, now]); p.got = Math.max(0, Math.min(h.got - w.a, w.b - w.a + 1)); p.last = now; }
              if (h.got > w.b) { h.waiters.delete(w); w.done(); }
            }
            if (h.media && !(h.got < h.end && (h.waiters.size || headWanted(id)))) { h.stopped = true; h.ctl.abort(); break; }
            if (h.media && headLate(h, now)) { h.release = Object.assign(new Error('tải video quá chậm'), { slow: true }); h.ctl.abort(); break; }
          }
          close(h.release);
        } catch (e) {
          h.ctl.abort();                        // thôi đọc (không moov ở đầu, lỗi giữa chừng): ngắt lượt tải luôn
          if (h.stopped || h.release) return close(h.release);   // tự ngắt: không còn cần, hay chậm quá (headLate)
          const err = timedOut ? Object.assign(new Error('tải video quá lâu'), { timeout: true }) : e;
          if (!h.media) { h.closed = true; if (v.head === h) v.head = null; reject(err); } else close(err);
        } finally {
          clearTimeout(idle); clearTimeout(whole);
        }
      })();
    });
  }
  // Phần [a, b] của một cửa sổ âm thanh lấy từ lượt tải đầu video. Tiến độ (prog: since, got, last, gaps) tính theo byte
  // của chính cửa sổ đó như rangeFetch, để dropSlow và othersLoading vẫn đúng.
  function headSlice(v, h, a, b, signal, prog) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const at = performance.now();
      const fin = () => {
        // Tốc độ để dropSlow so (như fetchBytes: số byte / thời gian từ lúc gọi tới khi đủ): tính tới lúc byte b về, kể cả
        // khi cửa sổ này lấy sau từ phần đã nhận (lượt tải có thể đã chậm hẳn sau đó). Byte đó do lượt tải nối tiếp đem về
        // (fetchBytes) thì giữ tốc độ của lượt đó.
        const hit = h.hist.find(([, g]) => g > b);
        if (hit) noteSpeed(v, (b + 1) / Math.max(1, hit[0] - h.at), h.at);
        resolve(headBytes(h, a, b));
      };
      if (prog) Object.assign(prog, { since: at, last: at, got: Math.max(0, Math.min(h.got - a, b - a + 1)), marks: [], gaps: [] });
      if (h.got > b) return fin();
      const onAbort = () => { if (h.waiters.delete(w)) { reject(signal.reason); headCheck(h.id, v); } };
      const w = { a, b, prog, at, done: () => { signal.removeEventListener('abort', onAbort); fin(); },
        fail: (e) => { signal.removeEventListener('abort', onAbort); reject(Object.assign(e, { head: true })); } };
      h.waiters.add(w);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  async function fetchBytes(v, media, a, b, signal, prog) {
    // Link CDN đã chuyển hướng hết hạn hoặc treo thì quay về /aweme/v1/play/ (lần gọi mới có thể sang máy chủ khác).
    let urls = v.url === v.api || (prog && prog.viaApi) ? [v.api, v.api] : [v.url, v.api];
    const h = v.head;
    if (headServes(v, media, b)) {
      // Lượt tải đầu video treo hay lỗi giữa chừng: tính là lần gọi đầu, gọi lại một lần qua /aweme/v1/play/. Thôi vì chậm
      // (headLate): tải như thường, qua link CDN (lượt mới tới cùng link có thể nhanh: đo 1/11 ở dropSlow).
      try { return await headSlice(v, h, a, b, signal, prog); } catch (e) { if (signal.aborted || !e.head) throw e; if (!e.slow) urls = [v.api]; }
    }
    // Lượt tải đầu video đã dừng (lỗi, treo, chậm) mà đã có phần đầu cửa sổ này: chỉ tải phần còn thiếu, rồi ghép. Đoạn (có
    // prog) thì chờ mẩu nhanh cùng chờ lượt đó tải xong phần của nó trước (h.qGate), rồi nối tiếp sau phần đó.
    const part = !!h && h.closed && h.media === media && v.head === h;
    if (part && prog && h.qGate) { await h.qGate; if (signal.aborted) throw signal.reason; }
    const from = part && h.got > a && h.got <= b ? h.got : a;
    // dropSlow: ước thời gian còn lại theo phần phải tải; đoạn đã chờ trên lượt tải đầu video từ prog.since nên xét ngay khi
    // lượt nối tiếp có đủ 2 s tốc độ, không chờ thêm SLOW_SLOT (mô phỏng: lượt đầu video rồi lượt nối tiếp của đoạn 0 cùng
    // 560–1400 B/s, q0 nhanh: chờ thêm 6 s thì bỏ muộn, sub đầu giây 14,25 thay vì 12,5 như bản 0.2.25).
    const since = prog && from > a ? prog.since : null;
    if (prog && from > a) prog.bytes = b - from + 1;
    const openQ = part && !prog ? h.qOpen : null;
    try {
      for (const [i, url] of urls.entries()) {
        try {
          const pending = rangeFetch(url, from, b, signal, undefined, undefined, prog, () => { v.byteAt = performance.now(); });
          if (since != null) prog.since = since;
          const r = await pending;
          // Máy chủ trả file khác (cỡ khác) thì vị trí byte tính theo mục lục cũ sai hết: bỏ mục lục để lần thử sau tải
          // lại. Trước đây giữ mục lục cũ, mọi đoạn sau của video đó lỗi mãi, 20 s một lần. So với cỡ file của chính mục
          // lục đã dùng để tính vị trí (lượt tải đang chạy song song vẫn bắt được).
          if (media.total && r.total && r.total !== media.total) {
            if (v.media === media) { v.media = null; v.url = null; v.api = null; }
            throw Object.assign(new Error('file video đã đổi'), { changed: true });
          }
          if (r.url && hostOf(r.url) !== v.badHost) v.url = r.url;
          noteSpeed(v, r.buf.byteLength / Math.max(1, performance.now() - r.at), r.at);   // tốc độ của lượt tải xong gần nhất (dropSlow)
          if (from === a) return r.buf;
          const all = new Uint8Array(b - a + 1);
          all.set(new Uint8Array(headBytes(h, a, from - 1)));
          all.set(new Uint8Array(r.buf), from - a);
          // Nối vào phần đã nhận: lượt sau (đoạn 0 sau mẩu nhanh) chỉ tải tiếp từ đây.
          if (v.head === h && h.got === from) { h.parts.push(new Uint8Array(r.buf)); h.got += r.buf.byteLength; }
          return all.buffer;
        } catch (e) { if (e.changed || e.rateLimited || i === urls.length - 1 || signal.aborted) throw e; }   // 429: không gọi lại ngay
      }
    } finally { if (openQ) openQ(); }
  }
  function toBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // Gộp sub các đoạn đã xong (cues.js xử lý câu vắt qua ranh giới hai đoạn).
  // Mẩu nhanh: bỏ từng dòng đã có bản của đoạn 30 s (dòng bắt đầu trong một đoạn đã dịch xong, hoặc chồng lên một dòng
  // của đoạn đó). Trước đây cả mẩu chỉ bị bỏ khi mọi đoạn phủ lên nó đã xong: tua tới 2 s trước ranh giới, đoạn trước bị
  // huỷ (đã phát qua) nên mẩu nhanh ở lại mãi, xếp trước đoạn sau và che mất dòng của đoạn sau (mô phỏng: ở 22 s hiện
  // dòng của mẩu nhanh, ở 24,4 s mất hẳn một dòng; ca F1 trong alpha/dev/content-sim-test.mjs).
  function mergeCues(v) {
    const done = [...v.chunks.keys()].sort((a, b) => a - b).map(k => v.chunks.get(k)).filter(c => c.status === 'ok');
    const se = (c) => c.se || c.end;
    const covered = (cue) => done.some(ch => (cue.start >= ch.from && cue.start < ch.to)
      || (ch.cues || []).some(x => cue.start < se(x) - 0.1 && x.start < se(cue) - 0.1));
    // Dòng dịch xong trước (partial, server gửi dần: 0.2.32) của đoạn, mẩu nhanh còn ở server: hiện tạm, nhường dòng của đoạn
    // đã xong và của mẩu nhanh đã xong; kết quả cuối thay (done() của runChunk, runQuick).
    // Dòng tạm có câu hát của yêu cầu gửi theo chế độ lời bài hát kia (vừa đổi nút): không hiện.
    const live = (x) => x.status === 'pending' && x.sent && Array.isArray(x.partial) && x.partial.length > 0
      && (x.lyrics === lyricsOn() || !x.partial.some(c => c.sung));
    const quick = [...v.quick.values()].filter(q => q.status === 'ok' || live(q))
      .map(q => ({ ...q, cues: (q.status === 'ok' ? q.cues || [] : q.partial).filter(x => !covered(x)) })).filter(q => q.cues.length);
    const quickOk = quick.filter(q => q.status === 'ok');
    const byQuick = (cue) => quickOk.some(q => q.cues.some(x => cue.start < se(x) - 0.1 && x.start < se(cue) - 0.1));
    // Mỗi dòng tạm của đoạn là một mục riêng, xếp theo đầu dòng: cả đoạn là một mục (from = đầu đoạn) thì đứng trước mẩu
    // nhanh ở giữa đoạn (tua tới), TodCues.merge chỉ so với dòng cuối đã nhận nên bỏ mọi dòng mẩu nhanh đã xong khi đoạn có
    // dòng tạm nằm sau khoảng mẩu nhanh (verifier 2/11: không có sub ở chỗ tua tới tới lúc đoạn có kết quả cuối).
    const part = [...v.chunks.values()].filter(live)
      .flatMap(c => c.partial.filter(x => !covered(x) && !byQuick(x)).map(x => ({ from: x.start, to: x.end, cues: [x] })));
    v.cues = TodCues.merge([...done, ...quick, ...part].sort((a, b) => a.from - b.from));
  }
  const superseded = (v, q) => !!v.plan && v.plan.every(([a, b], k) => b <= q.from || a >= q.to || (v.chunks.get(k) || {}).status === 'ok');
  // Không thấy video đang xem (một lượt dò hụt, hay vừa đóng modal): chờ tối đa ~1,2 s xem nó có quay lại không rồi mới
  // quyết định gửi hay bỏ phần vừa tải (verifier 1/11: một lượt dò hụt trùng lúc tải xong làm phải tải lại đoạn đó, mất
  // luôn mẩu nhanh). Quá 1 s thì schedule() đã bỏ video đó (currentId = null).
  const actBack = (id) => new Promise((r) => { let n = 0; const check = () => (act || currentId !== id || ++n > 12 ? r() : setTimeout(check, 100)); check(); });
  const quickWanted = (id, q) => settings.enabled && !!act && id === currentId && playhead >= q.from - 1 && playhead < q.to && !superseded(vid(id), q);
  function maybeQuick(plan) {
    if (!plan || !eligible(items.get(currentId))) return;
    // Chờ chỗ đang xem đứng yên (kéo thanh tiến trình thì mỗi 250 ms một chỗ mới), rồi xét một lần cho lần tua này. Đang
    // nghỉ sau 429 thì chưa xét: hết nghỉ mới xét (trước đây mẩu nhanh mất luôn khi đoạn 0 lỗi trước lúc đứng yên).
    const now = performance.now();
    if (settle.id !== currentId || now - settle.since < SETTLE || rateWait()) return;
    const v = vid(currentId);
    const k = chunkAt(plan, playhead);
    const c0 = v.chunks.get(k);
    const c = c0 && c0.status === 'error' && c0.rateLimited ? null : c0;   // bị 429, hết nghỉ: như chưa bắt đầu
    // Đoạn ở chỗ đang xem đã bị bỏ vì không thể tải kịp (dropSlow): mẩu nhanh nối tiếp phủ chỗ đang xem tới hết đoạn đó,
    // mỗi lần một mẩu: chỗ đang xem tới 1 s trước cuối mẩu trước (dù mẩu đó có lời hay bị bỏ qua) mới gửi mẩu sau. Còn quá
    // ít thời gian (kết quả về khi chỗ đang xem đã qua) thì thôi: đoạn kế sẽ phủ. Không ngắt, không chặn lượt tải nào:
    // đoạn kế đang tải cho kịp. Lần tua này coi như đã xét mẩu nhanh (không gửi thêm mẩu thường chồng lên).
    if (c && c.slow) {
      quickTried = settle.since;
      for (const q of v.quick.values()) {
        if (q.status === 'pending' && quickWanted(currentId, q)) return;
        if (playhead >= q.from - 0.5 && playhead < q.to - 1 && (q.status !== 'error' || Date.now() - q.at < 20000)) return;
      }
      const from = Math.floor(playhead), to = Math.min(from + QUICK, plan[k][1]);
      if (to - from >= 3 && (to - playhead) / playRate > SERVER_MS / 1000 + 1) runQuick(currentId, from, to, true);
      return;
    }
    if (quickTried === settle.since) return;
    // Đoạn này đã bắt đầu từ trước lần tua (dịch sẵn, dịch trước 30 s): đang tải đúng phần byte đó, tải lần hai chỉ thêm
    // chậm và tốn thêm một lần nhận dạng. Bắt đầu trong lúc kéo thanh tiến trình thì vẫn gửi (tải chưa được bao nhiêu).
    // Nhưng tải đã quá QUICK_STALL mà chưa gửi được thì có thể gặp máy chủ video chậm (§6d: 0,3–0,9 MB/s, đoạn đầu 2–4 MB
    // mất 5–11 s): khi đó vẫn gửi mẩu nhanh, ít byte hơn, sub đầu ra sớm hơn (§6e: 3,3–3,7 s so với 6–8 s). Chưa tới lúc
    // đó thì xét lại ở lần sau (250 ms). Ngưỡng 2 s chưa đo trên Douyin sau khi đổi.
    const early = c && c.status === 'pending' && c.made < settle.from;
    if (early && !c.sent && now - c.made < QUICK_STALL) return;
    quickTried = settle.since;
    if (k < 0 || (c && c.status !== 'pending')) return;           // đã có kết quả (hoặc lỗi: đoạn 30 s tự thử lại)
    if (plan[k][1] - plan[k][0] <= QUICK_MIN_CHUNK) return;       // đoạn ngắn: tự nó cũng nhanh
    if (early && c.sent) return;
    if (c && c.sent && Date.now() - c.sentAt > 2000) return;      // đoạn 30 s đã ở server một lúc (vd. dịch sẵn): sắp xong
    for (const q of v.quick.values()) {
      if (q.status === 'pending' && quickWanted(currentId, q)) return;   // mỗi video một mẩu nhanh đang chạy
      // Đã có mẩu nhanh phủ chỗ này (lỗi thì 20 s sau mới thử lại).
      if (playhead >= q.from - 0.5 && playhead < q.to - 2 && (q.status !== 'error' || Date.now() - q.at < 20000)) return;
    }
    const from = Math.floor(playhead), to = Math.min(from + QUICK, plan[plan.length - 1][1]);
    if (to - from >= 3) runQuick(currentId, from, to);
  }
  // Đoạn ở chỗ đang xem tải chậm tới mức không thể có sub (tải xong cộng nhận dạng, dịch ở server) trước khi chỗ đang xem
  // rời đoạn đó: bỏ nó, để hàng tải chạy ngay đoạn kế, chỗ đang xem có mẩu nhanh nối tiếp (maybeQuick). Đo 1/11: bài hát
  // 87 s, đoạn [0,20) tải ~25 s, đoạn kế chờ sau nó tới giây 20 (hàng video đang xem tải từng việc một), mẩu q0 bị bỏ qua
  // ("quá ít lời"), 30 s đầu không có sub. Chỉ khi riêng lượt tải này chậm: tốc độ 3 s gần nhất của nó (không tính lúc
  // khựng) dưới 1/3 tốc độ của lượt tải xong gần nhất của video này (máy chủ video chậm, vd. hl-mly ~0,3 MB/s ở §6d), và
  // không có lượt tải của video khác đang nhận byte mà không nhanh hơn hẳn (othersLoading).
  // Đường truyền chậm đều hay chia cho nhiều lượt thì lượt nào cũng chậm như nhau, bỏ đoạn rồi gửi mẩu nhanh chỉ chia nhỏ
  // thêm (mô phỏng của verifier 1/11: lượt tải đoạn đầu bị ngắt khi đã tải 97%). Lượt tải đứng hẳn (không byte nào) thì để
  // rangeFetch tự cắt sau 6 s rồi gọi lại. Không tải song song đoạn kế: tải song song tới cùng máy chủ video để lách giới
  // hạn tốc độ của CDN cần chủ dự án quyết (HANDOFF §6d).
  // Có lượt tải đoạn của video khác đang nhận byte (dịch sẵn): đường truyền đang chia. Đoạn của chính video đang xem mà
  // đang tải ở hàng dịch sẵn (bắt đầu trước khi lướt tới) thì không tính (verifier 1/11: trên feed dropSlow không bao giờ
  // chạy), lượt tải đang đứng im cũng không.
  // rate (byte/ms, nếu có), since: tốc độ và lúc bắt đầu của lượt đang xét. Đường truyền còn dư thì chậm là do riêng lượt này
  // (máy chủ video chậm theo từng lượt, §6d), vẫn xét bỏ: có lượt tải (video nào cũng được) chạy cùng lúc với nó (bắt đầu
  // sau nó, cho dư CONCURRENT_SLACK) mà đã xong nhanh gấp 3 trở lên (fastDone), hay lượt của video khác đang nhận byte nhanh
  // gấp 3 trở lên (lượt đó không tính). Lượt nhanh xong từ trước khi lượt này bắt đầu không tính: đường truyền có thể đã chậm
  // đi (trình phát, livestream, tab khác); verifier 2/11 mô phỏng đường truyền giảm 9000 → 3000 B/s sau một lượt nhanh: tính
  // cả lượt đó thì headLate, dropSlow chia nhỏ lượt tải, có sub 13 s thay vì 35,75 s trong 60 s đầu. Đo 2/11 trên Douyin thật:
  // video ngay sau một slide livestream, thông tin của nó tới 1 s trước khi lướt tới; lượt tải đầu của nó mất 4,3 s cho mục
  // lục và 17 s cho đoạn 0, trong khi 2 video dịch sẵn chạy cùng lúc tải xong trong ~3 s (video dịch sẵn thứ 3 không tới
  // server). Không tính tốc độ thì headLate không thôi lượt đó (có video khác đang tải), mẩu q0 chờ theo: "đang dịch" 23 s.
  const FAST_RECENT = 10000, CONCURRENT_SLACK = 1000;
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };
  const recentSpeeds = [];   // { speed (byte/ms), at } 6 lượt tải xong gần nhất, mọi video (restartSlow)
  const fastDone = [];   // { speed (byte/ms), start, at } các lượt tải xong trong FAST_RECENT gần nhất
  function noteSpeed(v, speed, start) {
    v.speed = speed;
    recentSpeeds.push({ speed, at: performance.now() }); if (recentSpeeds.length > 6) recentSpeeds.shift();
    const now = performance.now();
    fastDone.push({ speed, start, at: now });
    while (fastDone.length && now - fastDone[0].at > FAST_RECENT) fastDone.shift();
  }
  // Lượt tải xong nhanh gấp 3 rate, chạy cùng lúc với lượt bắt đầu lúc since: bắt đầu sau nó (dư CONCURRENT_SLACK) và xong sau khi
  // nó bắt đầu. Trước đây chỉ xét lúc bắt đầu: ở chế độ first10, lượt [10,20) tải sớm của video trước (ngắn, nhanh) xong ngay trước
  // lượt đầu của video kế, đường truyền chậm đi thì lượt đó bị coi là chậm riêng (mô phỏng 3/11: thôi lượt đầu, tải lại đoạn 0, không
  // có sub trong 17 s thay vì 11,75 s; cách cũ cũng gặp: thấy với video trước 12–60 s).
  const fastAlong = (rate, since, now) => fastDone.some((x) => now - x.at < FAST_RECENT && x.start >= since - CONCURRENT_SLACK && x.at > since && x.speed >= 3 * rate);
  // Có bằng chứng đường truyền còn dư cho lượt tốc độ rate bắt đầu lúc since: một lượt chạy cùng lúc đã xong nhanh gấp 3, hay
  // lượt của video khác đang tải nhanh gấp 3. Không có lượt nào khác thì không có bằng chứng (khác othersLoading: false).
  const spareCapacity = (rate, since) => {
    const now = performance.now();
    return rate > 0 && (fastAlong(rate, since, now)
      || [...vids].some(([id, v]) => id !== currentId && [...v.chunks.values()].some((c) => c.status === 'pending' && !c.sent && c.since != null && now - c.last < 1000
        && c.got / Math.max(1, now - c.since) >= 3 * rate)));
  };
  const othersLoading = (rate = null, since = -Infinity) => {
    const now = performance.now();
    if (rate != null && rate > 0 && fastAlong(rate, since, now)) return false;
    return [...vids].some(([id, v]) => id !== currentId && [...v.chunks.values()].some((c) => c.status === 'pending' && !c.sent && c.since != null && now - c.last < 1000
      && !(rate != null && c.got / Math.max(1, now - c.since) >= 3 * rate)));
  };
  function dropSlow(plan) {
    if (!plan || plan.length < 2 || !playing || rateWait()) return;
    const v = vid(currentId), k = chunkAt(plan, playhead), c = v.chunks.get(k);
    const now = performance.now();
    if (k < 0 || !c || c.status !== 'pending' || c.sent || c.since == null || !c.got || now - c.last > 1000) return;
    c.marks.push([now, c.got]);
    while (c.marks.length > 1 && now - c.marks[0][0] > 3000) c.marks.shift();
    const [t0, g0] = c.marks[0];
    if (now - c.since < SLOW_SLOT || now - t0 < 2000 || plan[k][1] - plan[k][0] <= QUICK_MIN_CHUNK) return;
    // byte/ms trong 3 s gần nhất, không tính các khoảng khựng: một lần khựng ngắn không thành "không kịp" (verifier 1/11:
    // lượt tải đã xong 74–90% khựng 2,5 s thì bị bỏ, thêm ~22 s nhận dạng), mà tải nhanh lúc đầu rồi chậm hẳn vẫn nhận ra
    // (lấy trung bình cả lượt thì không: verifier 1/11, chậm từ 20–33% đoạn trở đi thì bỏ quá muộn).
    while (c.gaps.length && c.gaps[0][1] < t0) c.gaps.shift();
    const idle = c.gaps.reduce((x, [ga, gb]) => x + Math.max(0, Math.min(gb, now) - Math.max(ga, t0)), 0);
    const speed = (c.got - g0) / Math.max(1, now - t0 - idle);
    // Đường truyền đang chia: như trước, không xét, và đo lại từ đầu (sau khi hết chia cần đủ 2 s tốc độ mới).
    if (othersLoading(speed, c.since)) { c.marks = [[now, c.got]]; return; }
    if (!v.speed || speed * 3 >= v.speed) return;
    const left = (plan[k][1] - playhead) * 1000;
    const eta = speed > 0 ? (c.bytes - c.got) / speed : Infinity;
    if (eta + SERVER_MS + SLOW_KEEP < left) return;
    // Lượt tải bị ngắt không xoá mục mới này (runChunk). Không tải lại khi chỗ đang xem còn trong đoạn (needsWork).
    v.chunks.set(k, { status: 'error', error: 'tải video quá chậm', slow: true, pre: c.pre, at: Date.now() });
    c.ctl.abort();
  }
  // Chế độ first10: đoạn [0,10) và [10,20) ngắn hơn QUICK_MIN_CHUNK nên dropSlow và mẩu nhanh không xét chúng. Lượt tải
  // của đoạn ở chỗ đang xem hay đoạn kế nó (chỉ đoạn 0, 1) chậm hẳn: 2 s gần nhất dưới 1/3 tốc độ lượt tải xong gần nhất
  // (v.speed), không do chia đường truyền (othersLoading), và phần còn lại ở tốc độ đó lâu hơn tải lại cả cửa sổ ở 1/3 v.speed
  // (lần tải lại bỏ phần đã tải; verifier 2/11). Khi đó thôi lượt đó và tải lại ngay một lần qua lượt mới (như lỗi tải tạm
  // thời: fastRetry, không chờ DL_RETRY_CUR), trước các đoạn sau nó. Máy chủ video chậm theo từng lượt, lượt mới thường
  // nhanh (§6z). Mô phỏng của verifier 2/11: 1/4 lượt tải 300 KB/s thì xem 15 s chỉ phủ 86% thay vì 100%.
  function restartSlow(plan) {
    const v = vids.get(currentId);
    if (!plan || !v || !v.short0 || !playing || rateWait()) return;
    const now = performance.now(), k0 = Math.max(0, chunkAt(plan, playhead));
    v.restarted = v.restarted || new Set();
    for (const k of [k0, k0 + 1]) {
      const c = v.chunks.get(k);
      if (!c || k > 1 || c.status !== 'pending' || c.sent || c.waiting || c.since == null || !c.got || v.restarted.has(k) || !plan[k]
        || now - c.last > 1000) continue;
      c.rmarks = c.rmarks || [];
      if (c.rmarks.length && c.got < c.rmarks[c.rmarks.length - 1][1]) c.rmarks = [];   // lượt tải bắt đầu lại (got về 0)
      c.rmarks.push([now, c.got]);
      while (c.rmarks.length > 1 && now - c.rmarks[0][0] > 2000) c.rmarks.shift();
      const [t0, g0] = c.rmarks[0];
      if (now - c.since < 2000 || now - t0 < 1500) continue;
      const idle = (c.gaps || []).reduce((x, [ga, gb]) => x + Math.max(0, Math.min(gb, now) - Math.max(ga, t0)), 0);
      const speed = (c.got - g0) / Math.max(1, now - t0 - idle);
      if (othersLoading(speed, c.since)) { c.rmarks = [[now, c.got]]; continue; }
      // So với lượt tải xong gần nhất của video này hay trung vị các lượt gần đây của mọi video, lấy cái nhanh hơn: mọi lượt của
      // một video có thể cùng đi qua máy chủ chậm (dùng thử 2/11: lượt dịch sẵn 368 KB/s, đoạn 1 230 KB/s, video khác 4–11 MB/s).
      // Lượt trong 60 s gần đây. Verifier 2/11 (G2) đề nghị 15 s (cả đường truyền vừa chậm đi thì tốc độ cũ làm tải lại vô ích,
      // đoạn 1 tới muộn ~1 s), nhưng xem video dài trên máy chủ chậm thì lượt nhanh gần nhất thường cũ hơn 15 s, không còn gì để
      // so: mô phỏng 2/11 (1/4 máy chủ chậm, xem hết) phủ 88% thay vì 98%; 60 s cho cùng kết quả như không giới hạn.
      const rs = recentSpeeds.filter((x) => now - x.at < 60000).map((x) => x.speed).sort((x, y) => x - y);
      const base = Math.max(v.speed || 0, rs.length ? rs[rs.length >> 1] : 0);
      if (!base || speed * 3 >= base) continue;
      const total = c.bytes || c.win || 0;
      if (!(speed > 0) || (total - c.got) / speed <= total / (base / 3)) continue;

      v.restarted.add(k);
      // Lần tải lại và các lượt sau của video này đi qua /aweme/v1/play/ (có thể được chuyển sang máy chủ khác): v.url = v.api,
      // nhớ máy chủ chậm (v.badHost) để lượt tải cũ từ máy chủ đó xong sau không đặt lại v.url về nó (fetchBytes), và cờ viaApi
      // trên chính đoạn này (verifier 2/11, G1).
      v.badHost = hostOf(v.url);
      if (v.api) v.url = v.api;
      v.chunks.set(k, { status: 'error', error: 'tải video quá chậm', dl: true, transient: true, dlFails: 1, viaApi: true, pre: c.pre, at: Date.now() - DL_RETRY_CUR - 1 });
      c.ctl.abort();
    }
  }
  async function runQuick(id, from, to, rolling) {
    const v = vid(id);
    const d = items.get(id);
    const q = { status: 'pending', from, to, ctl: new AbortController(), made: performance.now() };
    v.quick.set(from, q);
    // pg: bản xưng hô gửi kèm (takePron), chỉ xét khi giữ kết quả.
    const done = (r, pg) => {
      if (v.quick.get(from) !== q) return;
      if (r.status === 'cancelled') { v.quick.delete(from); if (q.partial) mergeCues(v); return; }
      // Gửi khi chế độ lời bài hát còn khác (đổi nút lúc mẩu này đang ở server) mà có câu hát: bỏ, xin mẩu mới.
      if (q.sent && q.lyrics !== lyricsOn() && !modeFree(r)) { v.quick.delete(from); quickTried = -1; if (q.partial) mergeCues(v); return; }
      if (pg != null) takePron(v, pg, r, true);
      Object.assign(q, r, { from, to, at: Date.now() });
      mergeCues(v);
    };
    try {
      const media = await ensureMedia(id);
      const w = TodMp4.window(media, Math.max(0, from - PRE_QUICK), to + 2);
      if (!w) return done({ status: 'no_audio' });
      // Lượt tải đầu video còn đang chạy mà cửa sổ này bắt đầu trong phần nó sẽ tải (tua tới gần cuối đoạn 0 lúc đang tải):
      // đọc tiếp lượt đó thêm cho tới hết cửa sổ, khỏi thêm một lượt tải song song.
      const h = v.head;
      if (h && !h.closed && h.media === media && w.start < h.end && w.end > h.end) h.end = w.end;
      let open = () => {}, gate = null;
      // Mẩu nối tiếp (rolling) không ngắt, không chặn lượt tải nào: đoạn kế đang tải cho kịp chỗ đang xem.
      if (!rolling) {
        gate = v.quickGate = new Promise((r) => { open = r; setTimeout(r, QUICK_GATE_MAX); });
        // Đoạn bắt đầu tải trước lần tua (dịch sẵn, dịch trước 30 s) thì không ngắt: có khi đã tải gần xong, nhất là trên
        // máy chủ video chậm (mô phỏng của verifier: ngắt làm đoạn đó xong muộn từ 2,6 s thành 12,4 s). Mẩu lấy từ lượt tải
        // đầu video (headServes) thì không ngắt gì: nó là phần đầu của chính lượt tải đoạn 0, ngắt không làm nó tới sớm hơn.
        // Đoạn 0 chờ cổng thì lượt đó vẫn đọc tiếp (headWanted), chờ không làm đoạn 0 tới muộn hơn.
        if (!headServes(v, media, w.end - 1)) for (const c of v.chunks.values()) if (c.status === 'pending' && !c.sent && c.ctl && !(c.made < settle.from)) c.ctl.abort();
      }
      let bytes;
      mark(id, 'quickDl');
      try { bytes = await fetchBytes(v, media, w.start, w.end - 1, q.ctl.signal); } finally { open(); if (gate && v.quickGate === gate) v.quickGate = null; }
      mark(id, 'quickDlEnd');
      const aac = w.build(bytes);
      if (!act) await actBack(id);
      if (!worker) await workerReady();
      if (!quickWanted(id, q)) { if (v.quick.get(from) === q) { v.quick.delete(from); if (!act) quickTried = -1; } return; }
      q.sent = true; q.sentAt = Date.now(); q.lyrics = lyricsOn();
      mark(id, 'quickPost');
      const pg = v.pronGen;
      chrome.runtime.sendMessage({ type: 'subtitles', server: settings.server, key: id + ':q' + from, payload: {
        id, desc: d.desc, hashtags: d.hashtags, ...authorPayload(d), durationMs: d.durationMs, from, to, audioStart: Math.round(w.startTime * 1000) / 1000,
        quick: true, urgent: true, rank: 0, lyrics: q.lyrics, stream: workerStream, ...pronPayload(v), aac: toBase64(aac) } })
        .then((r) => { mark(id, 'quickReply'); r = r && r.status ? r : { status: 'error', error: (r && r.error) || 'không có phản hồi', unreachable: true }; noteReply(r); done(r, pg); })
        .catch((e) => { mark(id, 'quickReply'); const r = { status: 'error', error: e.message, unreachable: true }; noteReply(r); done(r); });
      if (id === currentId) pump(lanes.prefetch);   // hàng dịch sẵn hết nhường (prefetchHeld)
    } catch (e) {
      if (q.ctl.signal.aborted) { if (v.quick.get(from) === q) v.quick.delete(from); return; }
      // 429: bỏ mẩu này, hết nghỉ thì maybeQuick xét lại.
      if (e.rateLimited) { if (v.quick.get(from) === q) { v.quick.delete(from); quickTried = -1; } return; }
      done({ status: 'error', error: e.message });
    }
  }
  async function runChunk(id, k) {
    const v = vid(id);
    const d = items.get(id);
    const before = v.chunks.get(k);
    const fails = before && before.status === 'error' ? (before.fails || 0) : 0;
    const entry = { status: 'pending', ctl: new AbortController(), made: performance.now(),
      ...(before && before.status === 'error' && before.viaApi ? { viaApi: true } : {}) };   // restartSlow: tải lại qua /aweme/v1/play/
    // sent: kết quả của yêu cầu đã gửi qua background.js. Lỗi server trả về thì đếm (fails) để giãn lần thử lại; không
    // gọi được server và lỗi tải video thì giữ số đếm cũ nhưng chờ 20 s (RETRY_MS).
    const done = (r, sent, pg) => {
      if (sent && entry.head) mark(id, 'chunkReply');
      const down = sent && noteReply(r);
      if (v.chunks.get(k) !== entry) return;
      if (r.status === 'cancelled') { v.chunks.delete(k); if (entry.partial) mergeCues(v); return; }   // tua lại tới đây thì gửi lại
      // Gửi khi chế độ lời bài hát còn khác (đổi nút lúc đoạn này đang ở server): kết quả có câu hát (hay lỗi) thì bỏ,
      // schedule() xin lại theo chế độ mới với đúng phần âm thanh này (server đã giữ ASR). Không có câu hát thì như nhau.
      if (sent && entry.lyrics !== lyricsOn() && !modeFree(r)) { v.chunks.delete(k); v.redo.set(k, entry.pre); if (entry.partial) mergeCues(v); return; }
      if (r.status !== 'error') v.redo.delete(k);
      if (pg != null) takePron(v, pg, r, false);
      const paid = sent && !down;
      const n = fails + (paid ? 1 : 0);
      // dl: lỗi mạng tạm thời trước khi gửi server (tải video); dlFails: số lần liền như vậy (fastRetry).
      v.chunks.set(k, { ...r, pre: entry.pre, at: Date.now(), ...(r.status === 'error'
        ? { fails: n, wait: paid ? RETRY_MS[Math.min(n, RETRY_MS.length) - 1] : RETRY_MS[0],
          ...(!sent && r.transient ? { dl: true, dlFails: (before && before.dl ? before.dlFails || 0 : 0) + 1 } : {}) } : {}) });
      mergeCues(v);
      wakeTurns();   // đoạn kế đang chờ lượt gửi (sendWait) gửi ngay
    };
    v.chunks.set(k, entry);
    try {
      const media = await ensureMedia(id);
      const plan = planFor(id);
      if (!plan[k]) { v.chunks.delete(k); return; }
      const [from, to] = plan[k];
      // Đoạn trước đã dịch hoặc đang dịch (phát liền mạch: server chờ nó để lấy ngữ cảnh) thì chỉ gửi dư 1,5 s.
      const prevDone = k === 0 || ['ok', 'pending'].includes((v.chunks.get(k - 1) || {}).status);
      // Xin lại sau khi đổi chế độ lời bài hát, hay thử lại sau lỗi: gửi đúng phần âm thanh như lần trước để server dùng
      // lại kết quả nhận dạng (giữ theo mã băm âm thanh). Đoạn trước lúc đó cũng thường bị bỏ nên prevDone khác lần đầu: mô
      // phỏng của verifier, đang phát liền mạch mà đổi chế độ thì đoạn thứ hai gửi dư 8 s thay vì 1,5 s, trả tiền ASR lần
      // nữa. v.redo chỉ xoá khi có kết quả cuối (done), để lần tải hỏng hay lỗi server vẫn gửi đúng phần âm thanh đó.
      entry.pre = v.redo.has(k) ? v.redo.get(k) : before && before.status === 'error' && before.pre != null ? before.pre
        : prevDone ? (k === 1 && v.short0 ? F10_PRE1 : PRE) : PRE_SEEK;
      const w = TodMp4.window(media, Math.max(0, from - entry.pre), to + (k === 0 && v.short0 ? F10_POST : POST));
      if (!w) return done({ status: 'no_audio', from, to });
      if (w.seconds > 0) v.bps = (w.end - w.start) / w.seconds;   // aheadFor
      if (v.quickGate) await v.quickGate;   // mẩu nhanh của video này đang tải: nhường đường truyền
      entry.bytes = entry.win = w.end - w.start;   // tiến độ tải (since, got) ghi vào entry, cho dropSlow; win: bảng thông tin
      // Mốc chunk*: đoạn ở chỗ đang xem (video chưa xem: đoạn 0, chỗ bắt đầu phát khi lướt tới).
      entry.head = k === (id === currentId && headOf === id ? chunkAt(plan, playhead) : 0);
      if (entry.head) mark(id, 'chunkDl');
      const aac = w.build(await fetchBytes(v, media, w.start, w.end - 1, entry.ctl.signal, entry));
      if (entry.head) mark(id, 'chunkDlEnd');
      // Trong lúc tải, người xem đã tua/lướt đi chỗ khác: khỏi gửi (quay lại tới đây thì làm lại).
      // Không thấy video đang xem: chờ nó quay lại (actBack); vẫn không thấy (vừa đóng modal) thì khỏi gửi, kẻo gửi rồi lại
      // huỷ giữa lúc nhận dạng.
      if (id === currentId && !act) await actBack(id);
      while (sendWait(id, k) || f10Hold(id, k)) {
        entry.waiting = true;   // đã tải xong, chờ lượt gửi (currentBehind: không phải lượt tải đứng im)
        entry.gate = !sendWait(id, k);   // chờ vì cửa chờ (f10Hold), không phải vì đoạn trước: bảng thông tin (pieceState)
        await nextTurn();
        if (entry.ctl.signal.aborted || v.chunks.get(k) !== entry) { if (v.chunks.get(k) === entry) v.chunks.delete(k); return; }
        // Lần dò hụt (không thấy video đang xem) trùng lúc hết chờ: chờ nó quay lại như trên, kẻo bỏ đoạn đã tải xong.
        if (id === currentId && !act) await actBack(id);
      }
      entry.waiting = false;
      if (!worker) {
        await workerReady();
        if (entry.ctl.signal.aborted || v.chunks.get(k) !== entry) { if (v.chunks.get(k) === entry) v.chunks.delete(k); return; }
      }
      if (!wanted.has(id + ':' + k) || (id === currentId && !act)) { if (v.chunks.get(k) === entry) v.chunks.delete(k); return; }
      // Không chờ server xong mới tải đoạn tiếp theo. urgent: đoạn chứa (hoặc sắp tới) chỗ đang xem, server làm trước.
      // rank: 0 là video đang xem, 1–4 là video dịch sẵn theo thứ tự sẽ lướt tới (server làm video gần trước).
      const next = upcoming().indexOf(id);
      Object.assign(entry, { sent: true, sentAt: Date.now(), from, to, urgent: urgentChunk(id, k, plan), lyrics: lyricsOn() });
      if (entry.head) mark(id, 'chunkPost');
      const pg = v.pronGen;
      chrome.runtime.sendMessage({ type: 'subtitles', server: settings.server, key: id + ':' + k, payload: {
        id, desc: d.desc, hashtags: d.hashtags, ...authorPayload(d), durationMs: d.durationMs, from, to, audioStart: Math.round(w.startTime * 1000) / 1000,
        prev: k > 0 ? plan[k - 1] : null, urgent: entry.urgent, prefetch: id !== currentId, lyrics: entry.lyrics, stream: workerStream, ...pronPayload(v),
        rank: id === currentId ? 0 : next >= 0 ? next + 1 : PREFETCH, aac: toBase64(aac) } })
        .then((r) => done(r && r.status ? { ...r, from, to } : { status: 'error', error: (r && r.error) || 'không có phản hồi', unreachable: true, from, to }, true, pg))
        .catch((e) => done({ status: 'error', error: e.message, unreachable: true, from, to }, true));
      if (id === currentId) pump(lanes.prefetch);   // hàng dịch sẵn hết nhường (prefetchHeld)
    } catch (e) {
      if (entry.ctl.signal.aborted) { if (v.chunks.get(k) === entry) v.chunks.delete(k); return; }
      // transient: lỗi mạng tạm thời (treo, đứt, HTTP 5xx/403/408, thiếu dữ liệu, file vừa đổi, quá chậm), thử lại có thể
      // được (fastRetry). Lỗi đọc file (không có mục lục ở đầu, không phải AAC…) thì thử lại cũng vậy.
      // HTTP: 5xx, 403 (link CDN hết hạn), 408 là tạm thời; 404, 410… thì không (verifier 2/11). TypeError chỉ khi là lỗi mạng
      // của fetch ("Failed to fetch"), không phải lỗi trong code.
      const http = Number((/^tải video: HTTP (\d{3})/.exec(e.message) || [])[1]);
      const transient = !!(e.timeout || e.slowMoov || e.changed || (e instanceof TypeError && /fetch|network/i.test(e.message))
        || (http ? http >= 500 || http === 403 || http === 408 : /^tải (video|mục lục)/.test(e.message)));
      done({ status: 'error', error: e.message, ...(e.rateLimited ? { rateLimited: true } : {}), ...(transient ? { transient } : {}) });   // 429: tải lại khi hết nghỉ
    }
  }
  // Đoạn ở chỗ đang xem chưa dịch xong thì chưa làm đoạn kế của cùng video: sau khi tua, chỗ đang xem được server
  // làm trước. Đoạn kế thường còn 15–30 s mới cần; schedule() gửi nó ngay khi đoạn này xong. Video kế tiếp thì không
  // hoãn (đo khi vào trang: hoãn thì lướt sang video 2 cũng phải chờ dịch từ đầu); server vẫn ưu tiên đoạn gấp.
  // Chế độ video dài (watching): chỉ chờ lúc đoạn đó còn đang tải; nó đã ở server thì đoạn kế tải luôn nhưng chờ nó có
  // kết quả rồi mới gửi (sendWait), nên vẫn gửi kèm bản xưng hô của nó như trước. Chờ cả lúc nó ở server thì tải rồi nhận
  // dạng, dịch nối tiếp nhau: đo 2/11 (giới hạn 450 KB/s) mỗi đoạn 30 s tải 21–28 s cộng 6–7 s ở server, quá 30 s nên đã
  // trễ là trễ mãi (17–23 s mỗi đoạn).
  // Đoạn kế bắt đầu trong 10 s tới cũng là gấp (dịch song song): đo trên vlog thật, tua tới gần cuối một đoạn thì đoạn
  // đó dịch xong (6–9 s) đã bị phát qua, đoạn kế mới bắt đầu dịch, chờ 10–12 s mới có sub.
  const URGENT_AHEAD = 10;
  const urgentChunk = (id, k, plan) => id === currentId && plan && plan[k] && plan[k][0] <= playhead + URGENT_AHEAD && playhead < plan[k][1];
  function holdBack(id, k) {
    const plan = planFor(currentId);
    if (id !== currentId || !plan || urgentChunk(id, k, plan)) return false;
    const long = watching();
    for (const [pk, c] of vid(currentId).chunks) if (c.status === 'pending' && !(long && c.sent) && urgentChunk(currentId, pk, plan)) return true;
    // Chế độ video dài dịch trước tới 60 s: đoạn còn xa đó không tải chung đường truyền với mẩu nhanh đang tải cho chỗ đang
    // xem (mẩu nối tiếp không chặn lượt nào: mô phỏng, đoạn đầu tải 560 B/s rồi bị bỏ, đoạn [50,80) tải chung với mẩu q9 thì
    // sub đầu muộn từ 12,5 s thành 14,25 s).
    if (long && [...vid(currentId).quick.values()].some((q) => q.status === 'pending' && !q.sent)) return true;
    // Đoạn gấp vừa bị mẩu nhanh ngắt (chưa có mục nào) cũng giữ chỗ: không thì đoạn kế lấy lượt tải trước nó, hết 10 s của
    // mẩu nhanh là mất sub ~5 s (mô phỏng của verifier 31/10: đoạn ở chỗ tua xong lúc 12,4 s thay vì 6,9 s). Đoạn gấp tải lỗi đang
    // chờ thử lại nhanh (fastRetry, DL_RETRY_CUR) cũng vậy: không thì đoạn kế (chưa gấp) lấy hàng tải trước, lần thử lại sau 1 s thành
    // sau cả lượt đó (mô phỏng 3/11, first10: [10,20) lỗi lúc 8 s, thử lại lúc 11,65 s thay vì 9,2 s; cách cũ: tua tới [290,320)).
    for (let pk = 0; pk < plan.length; pk++) {
      const pc = vid(currentId).chunks.get(pk);
      if (pk !== k && urgentChunk(currentId, pk, plan) && wanted.has(currentId + ':' + pk)
        && (!pc || (pc.status === 'error' && !pc.slow && fastRetry(pc, currentId)))) return true;
    }
    return false;
  }
  // Đoạn kế đã tải xong mà đoạn gấp trước nó của cùng video còn ở server: chờ (holdBack). Chế độ video dài còn chờ cả đoạn
  // liền trước đang ở server (dịch trước 60 s thì hai đoạn chưa gấp có thể cùng lúc ở server; gửi trước khi đoạn liền trước
  // có kết quả thì mang bản xưng hô cũ, verifier 2/11). Đoạn này đã thành gấp thì gửi luôn (server lấy ngữ cảnh, bản xưng hô
  // của đoạn trước từ cache khi đoạn đó xong). Đoạn đang chờ xét lại mỗi lần schedule() chạy (4 lần/giây) và mỗi khi một
  // đoạn có kết quả (wakeTurns).
  let turnWake = [];
  const nextTurn = () => new Promise((r) => turnWake.push(r));
  const wakeTurns = () => { for (const r of turnWake.splice(0)) r(); };
  function sendWait(id, k) {
    const plan = planFor(id);
    if (id !== currentId || !plan || urgentChunk(id, k, plan)) return false;
    const long = watching();
    for (const [pk, c] of vid(id).chunks) if (pk < k && c.status === 'pending' && c.sent && (urgentChunk(id, pk, plan) || (long && pk === k - 1))) return true;
    return false;
  }
  // Đang nghỉ sau 429 thì không bắt đầu lượt tải nào, cả hàng dịch sẵn. Hàng dịch sẵn nhường video vừa mở (prefetchHeld)
  // và video đang xem ở chế độ video dài còn đoạn chưa tải xong (currentBehind).
  const laneWait = (lane) => rateWait() || (lane === lanes.prefetch && (prefetchHeld() || currentBehind()));
  // Chế độ video dài: video đang xem còn đoạn đang cần mà chưa tải xong (chưa bắt đầu, đang tải), hay mẩu nhanh đang tải:
  // hàng dịch sẵn không bắt đầu lượt tải mới cho video khác. Đoạn đã tải xong, chờ lượt gửi (sendWait) thì không tính: đang
  // dừng xem mà đoạn gấp ở server lâu thì trước đây giữ cả hàng dịch sẵn (verifier 2/11). Lượt dịch sẵn đang chạy thì để chạy tiếp
  // (ngắt thì phí phần đã tải, xem PF_HOLD_MAX). Đo 2/11 trên Douyin thật (video 678 s, giới hạn 450 KB/s cho cả tab): 2 phút
  // đầu hàng dịch sẵn tải ~20 MB đoạn đầu của 4 video kế, chia đường truyền với đoạn của video đang xem. Chỉ giữ khi đoạn
  // gấp (urgentChunk) chưa tải xong thì vẫn hụt: lượt dịch sẵn bắt đầu đúng lúc đoạn 0 vừa gửi mà đoạn [20,50) chưa kịp
  // thành gấp, rồi chạy 46 s song song với nó (78% "đang dịch").
  // Đoạn đã gửi server, bị bỏ vì tải chậm (mẩu nối tiếp lo) hay đang chờ thử lại sau lỗi thì không tính. Video đang xem có
  // lượt tải đã chạy quá BYTE_GAP mà BYTE_GAP gần nhất không nhận byte nào (byteAt; CDN treo 15–37 s, §6f) thì không giữ:
  // đường truyền đang rảnh, giữ chỉ làm video kế chờ theo.
  const BYTE_GAP = 1500;
  function currentBehind() {
    if (!currentId || !act || !watching() || !eligible(items.get(currentId))) return false;
    const v = vids.get(currentId), plan = planFor(currentId);
    if (!v || !plan) return false;
    const now = performance.now();
    const loading = [...v.chunks.values(), ...v.quick.values()].filter((x) => x.status === 'pending' && !x.sent && !x.waiting);
    const h = v.head;
    if (now - (v.byteAt || -Infinity) >= BYTE_GAP
      && (loading.some((x) => now - x.made >= BYTE_GAP) || (h && !h.closed && now - h.at >= BYTE_GAP))) return false;
    for (let k = 0; k < plan.length; k++) {
      if (!wanted.has(currentId + ':' + k)) continue;
      const c = v.chunks.get(k);
      if (!c || (c.status === 'pending' && !c.sent && !c.waiting)) return true;
    }
    return [...v.quick.values()].some((q) => q.status === 'pending' && !q.sent);
  }
  function pump(lane) {
    while (lane.busy < lane.max && lane.queue.length && !laneWait(lane)) { lane.busy++; drain(lane).finally(() => { lane.busy--; }); }
  }
  async function drain(lane) {
    while (lane.queue.length && alive() && settings.enabled && !laneWait(lane)) {
      const [id, k] = lane.queue.shift();
      if (needsWork(id, k) && !holdBack(id, k)) await runChunk(id, k);
    }
  }

  // ---------------------------------------------------------------- vẽ sub
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host { all: initial; }
    .wrap { position: absolute; inset: 0; font-family: "Segoe UI", Roboto, "Noto Sans", Arial, sans-serif; }
    .sub { position: absolute; left: 50%; transform: translateX(-50%); max-width: 88%; text-align: center;
      color: #fff; background: rgba(0,0,0,.62); padding: .18em .55em; border-radius: .3em; line-height: 1.35;
      text-shadow: 0 0 2px #000; white-space: pre-line; display: none; }
    .badge { position: absolute; left: 10px; top: 10px; font-size: 12px; color: #fff; background: rgba(0,0,0,.55);
      padding: 2px 8px; border-radius: 10px; display: none; }
    .badge .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: 1px; }
    .info { position: absolute; left: 10px; top: 36px; max-width: min(380px, 90%); max-height: 75%; overflow: hidden;
      font-size: 12px; line-height: 1.5; color: #fff; background: rgba(0,0,0,.82); padding: 7px 10px; border-radius: 8px;
      white-space: pre-wrap; font-variant-numeric: tabular-nums; display: none; }
  </style><div class="wrap"><div class="badge"><span class="dot"></span><span class="txt"></span></div><div class="info"></div><div class="sub"></div></div>`;
  const subEl = root.querySelector('.sub');
  const badgeEl = root.querySelector('.badge');
  const badgeTxt = root.querySelector('.badge .txt');
  const badgeDot = root.querySelector('.badge .dot');
  const infoEl = root.querySelector('.info');
  function attachHost() {
    const parent = document.fullscreenElement || document.body || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }
  document.addEventListener('fullscreenchange', attachHost);

  const BADGE = {
    pending: ['#f5a623', 'VI · đang dịch…'],
    skipped: ['#9b9b9b', 'VI · bỏ qua'],
    no_audio: ['#9b9b9b', 'VI · không có âm thanh'],
    error: ['#e74c3c', 'VI · lỗi'],
    ok: ['#2ecc71', 'VI'],
  };
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const SKIP_WHY = { no_speech: 'không nghe thấy lời', too_short: 'quá ít lời', not_zh: 'không phải tiếng Trung', singing: 'bài hát', untranslated: 'dịch lỗi' };
  // ---- Rê chuột vào nhãn: bảng thông tin đã dịch của video đang xem (infoText), cập nhật 4 lần/giây. Lớp phủ vẫn không
  // nhận chuột (pointer-events: none), chỉ đọc vị trí chuột: click vẫn tới trang Douyin bên dưới nhãn.
  let infoOpen = false, infoAt = 0, infoId = null, mouseX = -1, mouseY = -1;
  function overBadge(x, y) {
    if (badgeEl.style.display !== 'block') return false;
    const b = badgeEl.getBoundingClientRect();
    return x >= b.left - 4 && x <= b.right + 4 && y >= b.top - 4 && y <= b.bottom + 4;
  }
  function setInfo(open) {
    if (open === infoOpen) return;
    infoOpen = open; infoAt = 0;
    if (!open) infoEl.style.display = 'none';
  }
  window.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; setInfo(overBadge(mouseX, mouseY)); }, { passive: true, capture: true });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) setInfo(false); }, true);   // chuột ra khỏi cửa sổ
  function pieceState(c) {
    if (!c) return 'chờ tải';
    const cues = c.cues || [], sung = cues.filter((x) => x.sung).length;
    if (c.status === 'ok') return cues.length ? `✓ ${cues.length} dòng${sung ? `, ${sung} dòng ♪` : ''}` : '✓ không có lời';
    if (c.status === 'skipped') return 'bỏ qua: ' + (SKIP_WHY[c.label] || 'không dịch');
    if (c.status === 'no_audio') return 'không có âm thanh';
    if (c.status === 'error') return c.slow ? 'tải quá chậm, dùng mẩu nhanh' : 'lỗi: ' + String(c.error || '').slice(0, 50);
    if (c.sent) return `đang dịch ở server${c.sentAt ? ` (${Math.round((Date.now() - c.sentAt) / 1000)} s` : ''}${Array.isArray(c.partial) && c.partial.length ? `${c.sentAt ? ', ' : ' ('}đã có ${c.partial.length} dòng)` : c.sentAt ? ')' : ''}`;
    if (c.waiting) return c.gate ? 'đã tải, gửi khi xem tiếp' : 'đã tải, chờ đoạn trước dịch xong';
    // win: cả cửa sổ; bytes: phần lượt đang chạy phải tải (lượt nối tiếp sau lượt tải đầu video chỉ tải phần còn thiếu).
    if (c.since != null && c.bytes) { const w = c.win || c.bytes; return `đang tải ${Math.min(99, Math.max(0, Math.round(100 * (w - c.bytes + (c.got || 0)) / w)))}%`; }
    return 'đang tải';
  }
  function infoText(v, plan, t) {
    const d = items.get(currentId);
    const D = (d && d.durationMs ? d.durationMs / 1000 : 0) || (v && v.media && v.media.duration) || 0;
    const end = (x) => (D ? Math.min(x, D) : x);
    const out = [`Video ${D ? mmss(D) : '?'} · đang xem ${mmss(t)}`];
    if (worker && worker !== 'ok') out.push(`Service worker của extension là bản cũ (${worker === '?' ? 'trước 0.2.34' : worker})${workerStream ? '' : ': dịch vẫn chạy, không hiện từng dòng sớm'}. Tải lại extension ở chrome://extensions (Chromium mở bằng --load-extension: xem HANDOFF §6y)`);
    if (!eligible(d)) return out.concat('Không dịch được video này (ảnh, quảng cáo, livestream hay chưa có thông tin)').join('\n');
    if (!v || !plan) return out.concat('Đang tải mục lục video…').join('\n');
    // Xong: có bản dịch, hay không cần dịch (nhạc, không lời, không có âm thanh). Bỏ qua vì dịch lỗi thì chưa xong.
    const fin = (c) => !!c && (c.status === 'ok' || c.status === 'no_audio' || (c.status === 'skipped' && c.label !== 'untranslated'));
    const cur = chunkAt(plan, t);
    let upto = null;
    if (cur >= 0 && fin(v.chunks.get(cur))) { for (let k = cur; k < plan.length && fin(v.chunks.get(k)); k++) upto = plan[k][1]; }
    else for (const q of v.quick.values()) if (q.status === 'ok' && t >= q.from && t < q.to) upto = q.to;
    out.push(upto != null ? `Đã xong tới ${mmss(end(upto))} (trước chỗ đang xem ${Math.max(0, Math.round(end(upto) - t))} s)` : 'Chỗ đang xem chưa có bản dịch');
    const done = [...v.chunks.values()].filter((c) => c.status === 'ok');
    const lines = done.reduce((x, c) => x + (c.cues || []).length, 0), sung = done.reduce((x, c) => x + (c.cues || []).filter((y) => y.sung).length, 0);
    out.push(`Đã xong ${[...v.chunks.values()].filter(fin).length}/${plan.length} đoạn · ${lines} dòng${sung ? ` (${sung} dòng ♪)` : ''}`);
    // Các đoạn đã có việc hay đang cần, gần chỗ đang xem nhất (tối đa 8), theo thứ tự thời gian. Chỗ đang xem ngoài lưới
    // đoạn (thời lượng báo thiếu, đồng hồ lệch): lấy đoạn gần nó nhất theo thời gian.
    const near = cur >= 0 ? cur : t >= plan[plan.length - 1][0] ? plan.length - 1 : 0;
    const ks = plan.map((_, k) => k).filter((k) => v.chunks.has(k) || wanted.has(currentId + ':' + k));
    const show = [...ks].sort((a, b) => Math.abs(a - near) - Math.abs(b - near) || a - b).slice(0, 8).sort((a, b) => a - b);
    for (const k of show) out.push(`${k === cur ? '▶' : '  '} ${mmss(plan[k][0])}–${mmss(end(plan[k][1]))}  ${pieceState(v.chunks.get(k))}`);
    if (ks.length > show.length) out.push(`   (+${ks.length - show.length} đoạn khác)`);
    const qs = [...v.quick.values()].filter((q) => q.to > t - 10).sort((a, b) => a.from - b.from).slice(-2);
    for (const q of qs) out.push(`Mẩu nhanh ${mmss(q.from)}–${mmss(end(q.to))}  ${pieceState(q)}`);
    const pairs = v.pron && Array.isArray(v.pron.pairs) ? v.pron.pairs.filter((x) => x && x.who) : [];
    if (pairs.length) out.push('Xưng hô: ' + pairs.slice(0, 3).map((x) => `${x.who}: ${x.self}/${x.other}`).join('; ') + (pairs.length > 3 ? ` (+${pairs.length - 3})` : ''));
    out.push(`Dịch trước ${aheadFor(v)} s${watching() ? (v.slow ? ' (đang xem, tải chậm)' : ' (đang xem)') : ''} · lời bài hát: ${lyricsOn() ? 'dịch' : 'bỏ qua'}${v.short0 ? ' · dịch sẵn 10 s đầu' : ''}`);
    return out.join('\n');
  }
  let lastFind = 0;
  let zeroSeen = false;
  let toastText = '';
  let toastUntil = 0;
  let delayWrite = null;
  const fmtDelay = (d) => (d > 0 ? '+' : '') + d.toFixed(1) + ' s';
  // Phím [ và ]: sub hiện sớm hơn / muộn hơn 0,1 s (lưu lại cho mọi video).
  window.addEventListener('keydown', (e) => {
    if (e.key !== '[' && e.key !== ']') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const d = Math.round(((Number(settings.delay) || 0) + (e.key === ']' ? 0.1 : -0.1)) * 10) / 10;
    settings.delay = Math.max(-2, Math.min(2, d));
    // Ghi một lần sau phím cuối; ghi mỗi lần bấm thì sự kiện "đã đổi" của lần trước về muộn có thể đè giá trị mới.
    clearTimeout(delayWrite);
    delayWrite = setTimeout(() => {
      if (alive()) chrome.storage.local.get('settings', (s) => chrome.storage.local.set({ settings: { ...(s.settings || {}), delay: settings.delay } }, () => { delayWrite = null; }));
    }, 300);
    toastText = 'VI · lệch sub ' + fmtDelay(settings.delay) + (settings.delay > 0 ? ' (muộn hơn)' : settings.delay < 0 ? ' (sớm hơn)' : '');
    toastUntil = performance.now() + 1500;
  }, true);
  function frame(now) {
    if (!alive()) return;
    requestAnimationFrame(frame);
    if (!lastFind || now - lastFind > 250) {   // dò video đang xem 4 lần/giây là đủ; vẽ sub thì mỗi khung hình
      lastFind = now;
      act = findActive();
      if (act) actAt = now;
      if (act && act.id !== currentId) {
        currentId = act.id; watched.add(currentId);
        markCurrent(currentId);
        if (opened.id) dwell = [...dwell, opened.played].slice(-3);
        opened = { id: currentId, need: null, hold: false, since: 0, warm: false, played: 0, last: 0 };
        // Đoạn lỗi tải lúc dịch sẵn: thử lại ngay, đủ DL_FAST_MAX lần nhanh (fastRetry) tính từ lúc lướt tới.
        const nv = vids.get(currentId);
        if (nv) for (const c of nv.chunks.values()) if (c.status === 'error' && c.dl) Object.assign(c, { at: 0, dlFails: 0 });
      }
      const pv = settings.enabled && act ? videoFor(act) : null;
      if (pv) markVideo(pv);
      playing = !!pv && !pv.paused; playRate = (pv && pv.playbackRate) || 1;
      if (playing && opened.last) opened.played += Math.min(1000, now - opened.last);   // tab ẩn lâu: không tính cả quãng đó
      opened.last = now;
      // Đo trên Douyin thật: giữa lúc phát, trình phát có lúc trả currentTime = 0 (đang dừng) rồi quay lại chỗ cũ. Tin
      // con số đó thì huỷ nhầm đoạn đang dịch rồi phải gửi lại. Bỏ qua lần đọc khi video chưa sẵn sàng, và cú nhảy về 0
      // lúc đang dừng phải lặp lại ở lần đọc sau (250 ms) mới tin.
      const raw = pv ? pv.currentTime : 0;
      const glitch = pv && (pv.readyState < 1 || (raw === 0 && pv.paused && playhead > 2 && !zeroSeen));
      zeroSeen = !!pv && raw === 0 && pv.paused;
      const ph = glitch || !pv ? 0 : timeOf(pv);
      // Tắt sub thì không đọc chỗ đang xem (trước đây đặt về 0: bật lại thì schedule() trong onChanged tải và gửi q0, :0
      // của video đang xem ở 300 s rồi mới huỷ ở lần đọc sau). Lần đọc ngay sau khi bật lại tính là một cú nhảy.
      if (!settings.enabled) settle.id = null;
      else if (!act) schedule();               // không thấy video nào: schedule() huỷ việc của video cũ sau 1 s
      else if (!glitch && ph != null) {
        // Chỗ đang xem nhảy (tua, kéo thanh tiến trình, lướt sang video khác) thì tính lại lúc "đứng yên" (maybeQuick).
        const expect = settle.ph + (pv && !pv.paused ? (now - settle.at) / 1000 * (pv.playbackRate || 1) : 0);
        // from: cú nhảy đầu của cả lượt kéo (các cú nhảy cách nhau dưới SETTLE tính là một lượt).
        if (settle.id !== currentId || Math.abs(ph - expect) > 1) {
          if (settle.id !== currentId) mark(currentId, 'settle');
          if (settle.id !== currentId || now - settle.since >= SETTLE) settle.from = now;
          settle.since = now;
        }
        Object.assign(settle, { id: currentId, ph, at: now });
        playhead = ph; headOf = currentId;
        schedule();                            // theo chỗ đang xem: tua tới đâu dịch tới đó
      }
    }
    const v = settings.enabled && act ? videoFor(act) : null;
    if (!v) { host.style.width = '0'; subEl.style.display = 'none'; badgeEl.style.display = 'none'; infoEl.style.display = 'none'; return; }
    attachHost();
    const r = v.getBoundingClientRect();
    host.style.left = r.left + 'px'; host.style.top = r.top + 'px'; host.style.width = r.width + 'px'; host.style.height = r.height + 'px';
    // Video chưa sẵn sàng hoặc đang dừng ở 0: chưa vẽ sub, nhưng nhãn vẫn theo video mới. Trước đây nhãn của video trước
    // ở lại trên video mới trong lúc nó tải hay dừng ở 0 (mô phỏng s10: "bỏ qua (bài hát)" của video trước).
    const hold = v.readyState < 1 || (zeroSeen && v.currentTime === 0);
    const tv = hold ? null : timeOf(v);
    if (tv != null) { playhead = tv; headOf = currentId; }
    const t = headOf === currentId ? playhead : 0;
    const cv = vids.get(currentId);
    const plan = cv && cv.plan;
    let res = cv && (plan ? cv.chunks.get(chunkAt(plan, t)) : cv.chunks.get(0));
    // Đoạn 30 s chưa xong mà mẩu nhanh ở chỗ này đã có sub: nhãn "VI". Mẩu nhanh bị bỏ qua thì chưa tin (cửa sổ 10 s
    // ngắn, dễ thành "quá ít lời"): vẫn "đang dịch" tới khi đoạn 30 s xong. Đoạn bị bỏ vì tải chậm (dropSlow) cũng vậy:
    // mẩu nhanh nối tiếp và đoạn kế đang làm, không phải lỗi.
    if (cv && (!res || res.status === 'pending' || res.slow)) {
      for (const q of cv.quick.values()) if (t >= q.from && t < q.to && q.status === 'ok') res = q;
      // Đoạn (hay mẩu nhanh) ở server đã gửi dần dòng dịch tới chỗ đang xem: "VI", không "đang dịch".
      // Dòng tới theo thứ tự thời gian: có dòng kết thúc từ chỗ đang xem trở đi là bản dịch đã tới chỗ này.
      const ahead = (x) => x && x.status === 'pending' && Array.isArray(x.partial) && x.partial.some(c => (c.se || c.end) >= t - 0.5);
      if (res && ahead(res)) res = { status: 'ok' };
      else for (const q of cv.quick.values()) if (t >= q.from && t < q.to && ahead(q)) res = { status: 'ok' };
    }
    // Lỗi tải sắp được thử lại ngay (fastRetry): vẫn là "đang dịch", không hiện "lỗi".
    const st = res ? (res.slow || (res.status === 'error' && fastRetry(res, currentId)) ? 'pending' : res.status) : (eligible(items.get(currentId)) ? 'pending' : null);
    const wait = rateWait();
    if (now < toastUntil) {
      badgeDot.style.background = BADGE.ok[0];
      badgeTxt.textContent = toastText;
      badgeEl.style.display = 'block';
    } else if (wait && ((st === 'pending' && !res) || (st === 'error' && res.rateLimited))) {
      badgeDot.style.background = BADGE.error[0];
      badgeTxt.textContent = `VI · lỗi: Douyin tạm chặn tải video (HTTP 429), thử lại sau ${Math.ceil(wait / 1000)} s`;
      badgeEl.style.display = 'block';
    } else if (st && BADGE[st]) {
      badgeDot.style.background = BADGE[st][0];
      badgeTxt.textContent = st === 'error' ? BADGE.error[1] + ': ' + String(res.error || '').slice(0, 60)
        : st === 'skipped' ? 'VI · ' + (SKIP_WHY[res.label] || 'bỏ qua') + (plan && plan.length > 1 ? ` (đoạn ${mmss(res.from)}–${mmss(res.to)})` : '')
        : BADGE[st][1];
      badgeEl.style.display = 'block';
    } else badgeEl.style.display = 'none';
    // Nhãn dời khỏi chuột mà chuột không động (vào/thoát toàn màn hình, trang đổi bố cục): xét lại theo vị trí chuột cuối.
    if (infoOpen && (!infoAt || now - infoAt >= 250)) setInfo(overBadge(mouseX, mouseY));
    if (!infoOpen || badgeEl.style.display !== 'block') infoEl.style.display = 'none';
    else if (!infoAt || now - infoAt >= 250 || infoId !== currentId) {
      infoAt = now; infoId = currentId;
      let text;
      try { text = infoText(cv, plan, t); } catch (e) { text = 'Không hiện được thông tin: ' + e.message; }   // không làm hỏng phần vẽ sub
      if (infoEl.textContent !== text) infoEl.textContent = text;
      infoEl.style.display = 'block';
    }
    if (hold) { subEl.style.display = 'none'; return; }
    const c = cv ? TodCues.at(cv.cues, playhead - (Number(settings.delay) || 0)) : null;
    if (!c) { subEl.style.display = 'none'; return; }
    const scale = { s: 0.034, m: 0.042, l: 0.052 }[settings.size] || 0.042;
    subEl.style.fontSize = Math.max(14, Math.min(40, r.height * scale)) + 'px';
    subEl.style.top = ''; subEl.style.bottom = '';
    if (settings.position === 'top') subEl.style.top = (r.height * 0.08) + 'px';
    else if (settings.position === 'middle') subEl.style.top = (r.height * 0.55) + 'px';
    else subEl.style.bottom = (r.height * 0.13) + 'px';
    const text = (c.sung ? '♪ ' : '') + c.vi;   // dòng hát (chế độ lời bài hát)
    if (subEl.textContent !== text) subEl.textContent = text;
    subEl.style.display = 'block';
    mark(currentId, 'drawn');
  }

  // ---------------------------------------------------------------- cài đặt, khởi động
  chrome.storage.local.get('settings', (s) => {
    settings = { ...settings, ...(s.settings || {}) };
    window.dispatchEvent(new CustomEvent(DOWN, { detail: JSON.stringify({ type: 'ready' }) }));
    requestAnimationFrame(frame);
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) {
      const nv = { ...(ch.settings.newValue || {}) };
      if (delayWrite) delete nv.delay;         // đang có chỉnh lệch bằng phím chưa ghi xong
      const was = settings.enabled, wasLyrics = settings.lyrics !== false;
      settings = { ...settings, ...nv };
      if (lyricsOn() !== wasLyrics) resetResults();
      // Vừa bật lại: chỗ đang xem là của lúc tắt (người xem có thể đã tua, lướt đi). Đọc lại ngay ở khung hình sau rồi
      // mới lên lịch, khỏi tải và gửi nhầm chỗ cũ.
      if (settings.enabled && !was) lastFind = 0;
      else schedule();
    }
  });
  // Đổi chế độ lời bài hát: bỏ kết quả đã có mà có câu hát (bài hát bị bỏ qua, hay có dòng ♪); schedule() xin lại theo
  // chế độ mới. Đoạn chỉ có lời nói, đoạn lỗi (lần thử lại tự gửi theo chế độ mới, giữ số lần lỗi) và việc đang tải hay
  // đang ở server thì giữ. Không huỷ việc đã gửi: huỷ giữa lúc nhận dạng thì lần gửi lại trả tiền ASR lần nữa, cả với đoạn
  // chỉ có lời nói (đợt soát 31/10); trả lời của chế độ cũ được xét ở done().
  function resetResults() {
    for (const v of vids.values()) {
      for (const [k, c] of v.chunks) {
        if (c.status === 'pending' || c.status === 'error' || modeFree(c)) continue;
        if (c.pre != null) v.redo.set(k, c.pre);
        v.chunks.delete(k);
      }
      for (const [qa, q] of v.quick) {
        if (q.status === 'pending' || q.status === 'error' || modeFree(q)) continue;
        v.quick.delete(qa);
        quickTried = -1;        // xin mẩu nhanh mới cho chỗ đang xem, không chờ cả đoạn 30 s
      }
      mergeCues(v);
    }
  }
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    // Dòng dịch xong trước của một yêu cầu còn ở server (background.js chuyển từ NDJSON): giữ ở đoạn/mẩu nhanh đó (partial,
    // đủ các dòng tới lúc đó), hiện tạm (mergeCues). key như lúc gửi: "<id>:<k>" (đoạn) hay "<id>:q<from>" (mẩu nhanh).
    if (msg && msg.type === 'partial') {
      const m = typeof msg.key === 'string' && /^(\d+):(q?)(\d+)$/.exec(msg.key);
      const v = m && vids.get(m[1]);
      const x = v && (m[2] ? v.quick.get(Number(m[3])) : v.chunks.get(Number(m[3])));
      if (x && x.status === 'pending' && x.sent && Array.isArray(msg.cues)) {
        if (!x.partial) mark(m[1], m[2] ? 'quickPartial' : (x.head ? 'chunkPartial' : 'partial'));   // mốc: dòng tạm đầu tiên
        x.partial = msg.cues.filter(c => c && typeof c.start === 'number' && typeof c.end === 'number' && c.end > c.start && typeof c.vi === 'string' && c.vi)
          .slice(0, 200).map(c => ({ start: c.start, end: c.end, se: typeof c.se === 'number' ? c.se : c.end, vi: c.vi.slice(0, 300),
            zh: typeof c.zh === 'string' ? c.zh : '', ...(c.sung ? { sung: true } : {}) }));
        mergeCues(v);
      }
      return false;
    }
    if (msg && msg.type === 'status') {
      // Mỗi video tính một lần: có đoạn đã dịch thì là "ok", còn đang chờ thì "pending"…
      const counts = {};
      let chunks = 0;
      for (const v of vids.values()) {
        const sts = [...v.chunks.values()].map(c => c.status);
        chunks += sts.length;
        const st = ['ok', 'pending', 'error', 'skipped', 'no_audio'].find(x => sts.includes(x));
        if (st) counts[st] = (counts[st] || 0) + 1;
      }
      // marks: mốc thời gian lần mở video (định dạng: mục "mốc thời gian lần mở video" ở đầu file); page: trang hiện tại.
      const list = [...marks].filter(([, r]) => r.at0 != null).map(([id, r]) => ({ id, page: r.page, src: r.src, wall: r.wall,
        t: Object.fromEntries(Object.entries(r.ev).sort((a, b) => a[1] - b[1]).map(([k, x]) => [k, Math.round(x - r.at0)])) }));
      // cur: video đang xem theo extension (chỉ để đo, như marks): đã có metadata chưa, loại, thuộc danh sách nào, video kế
      // tiếp sẽ dịch sẵn, trạng thái từng đoạn.
      const d = currentId ? items.get(currentId) : null, cv = currentId ? vids.get(currentId) : null;
      const cur = currentId ? { id: currentId, act: act ? act.id : null, known: !!d, kind: d ? d.kind : null, src: d ? d.source : null,
        eligible: !!eligible(d), lists: [...orders].filter(([, o]) => o.includes(currentId)).map(([n]) => n), next: upcoming(),
        chunks: cv ? [...cv.chunks].map(([k, c]) => [k, c.status, !!c.sent]) : [] } : { id: null, act: act ? act.id : null };
      reply({ seen: items.size, counts, chunks, page: pageKind(), marks: list, cur, worker });
    }
  });
})();

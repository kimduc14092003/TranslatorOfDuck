// Content script (ISOLATED) trên www.douyin.com — bản Alpha.
// 1. Nhận metadata video từ tap.main.js (JSON feed của chính trang).
// 2. Video dài được chia đoạn 30 s; luôn dịch trước 30 s so với chỗ đang xem, tua tới đâu dịch tới đó.
//    Video 2 cái kế tiếp được dịch sẵn đoạn đầu. Tải đúng phần byte cần qua /aweme/v1/play/ (đường đã đo ở S1),
//    cắt riêng âm thanh (mp4audio.js) rồi gửi qua service worker tới server trên máy bạn.
// 3. Vẽ sub đè lên video theo thời gian phát (docs/PLAN.md §8).
(() => {
  'use strict';
  const UP = '__tod_alpha_up';
  const DOWN = '__tod_alpha_down';
  const PREFETCH = 4;            // số video kế tiếp được dịch sẵn đoạn đầu (lướt nhanh ~4 s/video vẫn kịp)
  const LOOKAHEAD = 30;          // luôn dịch trước chỗ đang xem bấy nhiêu giây
  const FIRST = 20, STEP = 30;   // đoạn đầu ngắn để sub đầu ra nhanh, sau đó mỗi đoạn 30 s
  // Video ngắn hơn thế thì dịch một lần. Dài hơn thì đoạn đầu chỉ 20 s: đo khi lướt, /aweme/v1/play có lúc chuyển
  // sang máy chủ video chỉ tải được ~0,3 MB/s, tải trọn video 60 s mất cả chục giây mới có sub đầu.
  const SINGLE_MAX = 30;
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
  const SLOW_SLOT = 6000, SERVER_MS = 4000;
  // Câu background.js trả khi không gọi được server (fetch lỗi mạng), và khi địa chỉ server trong cài đặt không phải máy
  // này (chưa gửi gì). Không có phản hồi nào cũng tính là chưa tới server.
  const UNREACHABLE = /^không kết nối được server/, NOT_SENT = /^Bản Alpha chỉ gọi server trên máy/;
  // Độ lệch tối đa giữa <video>.currentTime và vị trí tap.main.js đọc được (đã tính thời gian trôi) để còn coi là cùng
  // thẻ <video>, cùng lúc phát.
  const CLOCK_TOL = 1;

  // lyrics: dịch cả lời bài hát (dòng hát hiện "♪"); tắt thì bỏ qua bài hát như trước (PLAN §15). Mặc định bật (31/10).
  let settings = { enabled: true, server: 'http://127.0.0.1:8787', position: 'bottom', size: 'm', delay: 0, lyrics: true };
  const lyricsOn = () => settings.lyrics !== false;
  // Kết quả như nhau ở hai chế độ lời bài hát: không có câu hát nào (cùng điều kiện noSinging ở server.mjs: số câu hát 0,
  // không phải bài hát, không có dòng ♪), hay không có âm thanh.
  const modeFree = (r) => r.status === 'no_audio' || ((r.status === 'ok' || r.status === 'skipped') && typeof r.sung === 'number'
    && r.sung === 0 && r.label !== 'singing' && !(r.cues || []).some(x => x.sung));
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

  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };

  // ---------------------------------------------------------------- metadata từ trang
  function onItems(list) {
    for (const d of list) {
      if (!d || !d.id || d.id === 'undefined') continue;
      const prev = items.get(d.id);
      if (!prev || (d.gears.length + d.audio.length) > (prev.gears.length + prev.audio.length)) items.set(d.id, d);
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
  const vid = (id) => { let v = vids.get(id); if (!v) { v = { chunks: new Map(), quick: new Map(), cues: [], redo: new Map() }; vids.set(id, v); } return v; };
  const eligible = (d) => d && d.kind === 'video' && d.playUri && !/^https?:/.test(d.playUri);
  // Lưới đoạn cố định theo thời lượng (cùng video thì luôn cùng lưới, để cache dùng lại được).
  function planFor(id) {
    const v = vid(id);
    if (v.plan) return v.plan;
    const d = items.get(id);
    const D = (d && d.durationMs ? d.durationMs / 1000 : 0) || (v.media && v.media.duration) || 0;
    if (!D) return null;
    if (D <= SINGLE_MAX) v.plan = [[0, Math.ceil(D) + 1]];
    else { v.plan = [[0, FIRST]]; for (let a = FIRST; a < D; a += STEP) v.plan.push([a, Math.min(a + STEP, Math.ceil(D) + 1)]); }
    return v.plan;
  }
  const chunkAt = (plan, t) => plan.findIndex(([a, b]) => t >= a && t < b);
  // Lỗi thì thử lại sau c.wait (RETRY_MS, đặt lúc nhận lỗi: xem done() của runChunk), hoặc sau thời gian server báo nếu
  // lâu hơn (vd. dịch hết lượt trong ngày, key sai: server tạm nghỉ vài phút).
  const retryWait = (c) => Math.max(c.wait || RETRY_MS[0], c.retryAfterMs || 0);
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
    return !c || (c.status === 'error' && !c.slow && (c.rateLimited ? !rateWait() : Date.now() - (c.at || 0) > retryWait(c)));
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
      }
      return;
    }
    const want = [];
    const plan = planFor(currentId);
    if (plan) plan.forEach(([a, b], k) => { if (b > playhead && a < playhead + LOOKAHEAD) want.push([currentId, k]); });
    else want.push([currentId, 0]);
    for (const id of upcoming()) want.push([id, 0]);
    wanted = new Set(want.map(([id, k]) => id + ':' + k));
    bumpCurrent(plan);
    const todo = want.filter(([id, k]) => eligible(items.get(id)) && needsWork(id, k));
    lanes.current.queue = todo.filter(([id]) => id === currentId);
    lanes.prefetch.queue = todo.filter(([id]) => id !== currentId);
    cancelUnwanted();
    dropSlow(plan);
    maybeQuick(plan);
    pump(lanes.current);
    pump(lanes.prefetch);
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
      for (const [k, c] of v.chunks) {
        // Đoạn bị bỏ vì tải chậm: chỗ đang xem ra khỏi nó (hết cần, hay tua lùi về đoạn trước) thì xoá, quay lại thì tải lại.
        if (c.slow && (!wanted.has(id + ':' + k) || (id === currentId && v.plan && chunkAt(v.plan, playhead) !== k))) { v.chunks.delete(k); continue; }
        if (c.status !== 'pending' || wanted.has(id + ':' + k)) continue;
        if (c.sent) { c.sent = false; keys.push(id + ':' + k); } else if (c.ctl) c.ctl.abort();
      }
      for (const [qa, q] of v.quick) {
        if (q.status !== 'pending' || quickWanted(id, q)) continue;
        if (q.sent) { q.sent = false; keys.push(id + ':q' + qa); } else q.ctl.abort();
      }
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
  // (lúc nhận byte cuối), gaps (các khoảng hơn 0,5 s không nhận byte nào).
  async function rangeFetch(url, a, b, signal, idleMs = 6000, totalMs = 60000, prog = null) {
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
  async function loadMedia(id, v) {
    const api = 'https://www.douyin.com/aweme/v1/play/?video_id=' + encodeURIComponent(items.get(id).playUri);
    // Đoạn đầu file nhỏ (64 KB): quá 4 s là treo; treo hoặc lỗi mạng (đo được: máy chủ video cắt ngang,
    // ERR_CONTENT_LENGTH_MISMATCH) thì gọi lại một lần, có thể sang máy chủ video khác.
    const probe = await rangeFetch(api, 0, 65535, null, 4000)
      .catch((e) => { if (e.timeout || e instanceof TypeError) return rangeFetch(api, 0, 65535, null, 8000); throw e; });
    const head = TodMp4.headerEnd(probe.buf);
    if (head == null) throw new Error('video không có mục lục ở đầu file (chưa hỗ trợ)');
    const moov = head <= probe.buf.byteLength ? probe.buf : (await rangeFetch(probe.url || api, 0, head - 1)).buf;
    v.media = TodMp4.parse(moov);
    v.media.total = probe.total;
    v.api = api; v.url = probe.url || api;
    // Chỉ giữ mục lục của 20 video gần nhất (video dài có mục lục vài MB).
    const withMedia = [...vids.entries()].filter(([, x]) => x.media);
    for (const [, x] of withMedia.slice(0, Math.max(0, withMedia.length - 20))) x.media = null;
    return v.media;
  }
  async function fetchBytes(v, media, a, b, signal, prog) {
    // Link CDN đã chuyển hướng hết hạn hoặc treo thì quay về /aweme/v1/play/ (lần gọi mới có thể sang máy chủ khác).
    const urls = v.url === v.api ? [v.api, v.api] : [v.url, v.api];
    for (const [i, url] of urls.entries()) {
      try {
        const r = await rangeFetch(url, a, b, signal, undefined, undefined, prog);
        // Máy chủ trả file khác (cỡ khác) thì vị trí byte tính theo mục lục cũ sai hết: bỏ mục lục để lần thử sau tải
        // lại. Trước đây giữ mục lục cũ, mọi đoạn sau của video đó lỗi mãi, 20 s một lần. So với cỡ file của chính mục
        // lục đã dùng để tính vị trí (lượt tải đang chạy song song vẫn bắt được).
        if (media.total && r.total && r.total !== media.total) {
          if (v.media === media) { v.media = null; v.url = null; v.api = null; }
          throw Object.assign(new Error('file video đã đổi'), { changed: true });
        }
        if (r.url) v.url = r.url;
        v.speed = r.buf.byteLength / Math.max(1, performance.now() - r.at);   // tốc độ của lượt tải xong gần nhất (dropSlow)
        return r.buf;
      } catch (e) { if (e.changed || e.rateLimited || i === urls.length - 1 || signal.aborted) throw e; }   // 429: không gọi lại ngay
    }
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
    const quick = [...v.quick.values()].filter(q => q.status === 'ok')
      .map(q => ({ ...q, cues: (q.cues || []).filter(x => !covered(x)) })).filter(q => q.cues.length);
    v.cues = TodCues.merge([...done, ...quick].sort((a, b) => a.from - b.from));
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
  // không có lượt tải của video khác đang nhận byte (othersLoading).
  // Đường truyền chậm đều hay chia cho nhiều lượt thì lượt nào cũng chậm như nhau, bỏ đoạn rồi gửi mẩu nhanh chỉ chia nhỏ
  // thêm (mô phỏng của verifier 1/11: lượt tải đoạn đầu bị ngắt khi đã tải 97%). Lượt tải đứng hẳn (không byte nào) thì để
  // rangeFetch tự cắt sau 6 s rồi gọi lại. Không tải song song đoạn kế: tải song song tới cùng máy chủ video để lách giới
  // hạn tốc độ của CDN cần chủ dự án quyết (HANDOFF §6d).
  // Có lượt tải đoạn của video khác đang nhận byte (dịch sẵn): đường truyền đang chia. Đoạn của chính video đang xem mà
  // đang tải ở hàng dịch sẵn (bắt đầu trước khi lướt tới) thì không tính (verifier 1/11: trên feed dropSlow không bao giờ
  // chạy), lượt tải đang đứng im cũng không.
  const othersLoading = () => {
    const now = performance.now();
    return [...vids].some(([id, v]) => id !== currentId && [...v.chunks.values()].some((c) => c.status === 'pending' && !c.sent && c.since != null && now - c.last < 1000));
  };
  function dropSlow(plan) {
    if (!plan || plan.length < 2 || !playing || othersLoading() || rateWait()) return;
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
    if (!v.speed || speed * 3 >= v.speed) return;
    const left = (plan[k][1] - playhead) * 1000;
    const eta = speed > 0 ? (c.bytes - c.got) / speed : Infinity;
    if (eta + SERVER_MS < left) return;
    // Lượt tải bị ngắt không xoá mục mới này (runChunk). Không tải lại khi chỗ đang xem còn trong đoạn (needsWork).
    v.chunks.set(k, { status: 'error', error: 'tải video quá chậm', slow: true, pre: c.pre, at: Date.now() });
    c.ctl.abort();
  }
  async function runQuick(id, from, to, rolling) {
    const v = vid(id);
    const d = items.get(id);
    const q = { status: 'pending', from, to, ctl: new AbortController() };
    v.quick.set(from, q);
    const done = (r) => {
      if (v.quick.get(from) !== q) return;
      if (r.status === 'cancelled') { v.quick.delete(from); return; }
      // Gửi khi chế độ lời bài hát còn khác (đổi nút lúc mẩu này đang ở server) mà có câu hát: bỏ, xin mẩu mới.
      if (q.sent && q.lyrics !== lyricsOn() && !modeFree(r)) { v.quick.delete(from); quickTried = -1; return; }
      Object.assign(q, r, { from, to, at: Date.now() });
      mergeCues(v);
    };
    try {
      const media = await ensureMedia(id);
      const w = TodMp4.window(media, Math.max(0, from - PRE_QUICK), to + 2);
      if (!w) return done({ status: 'no_audio' });
      let open = () => {}, gate = null;
      // Mẩu nối tiếp (rolling) không ngắt, không chặn lượt tải nào: đoạn kế đang tải cho kịp chỗ đang xem.
      if (!rolling) {
        gate = v.quickGate = new Promise((r) => { open = r; setTimeout(r, QUICK_GATE_MAX); });
        // Đoạn bắt đầu tải trước lần tua (dịch sẵn, dịch trước 30 s) thì không ngắt: có khi đã tải gần xong, nhất là trên
        // máy chủ video chậm (mô phỏng của verifier: ngắt làm đoạn đó xong muộn từ 2,6 s thành 12,4 s).
        for (const c of v.chunks.values()) if (c.status === 'pending' && !c.sent && c.ctl && !(c.made < settle.from)) c.ctl.abort();
      }
      let bytes;
      try { bytes = await fetchBytes(v, media, w.start, w.end - 1, q.ctl.signal); } finally { open(); if (gate && v.quickGate === gate) v.quickGate = null; }
      const aac = w.build(bytes);
      if (!act) await actBack(id);
      if (!quickWanted(id, q)) { if (v.quick.get(from) === q) { v.quick.delete(from); if (!act) quickTried = -1; } return; }
      q.sent = true; q.lyrics = lyricsOn();
      chrome.runtime.sendMessage({ type: 'subtitles', server: settings.server, key: id + ':q' + from, payload: {
        id, desc: d.desc, hashtags: d.hashtags, durationMs: d.durationMs, from, to, audioStart: Math.round(w.startTime * 1000) / 1000,
        quick: true, urgent: true, rank: 0, lyrics: q.lyrics, aac: toBase64(aac) } })
        .then((r) => { r = r && r.status ? r : { status: 'error', error: (r && r.error) || 'không có phản hồi', unreachable: true }; noteReply(r); done(r); })
        .catch((e) => { const r = { status: 'error', error: e.message, unreachable: true }; noteReply(r); done(r); });
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
    const entry = { status: 'pending', ctl: new AbortController(), made: performance.now() };
    // sent: kết quả của yêu cầu đã gửi qua background.js. Lỗi server trả về thì đếm (fails) để giãn lần thử lại; không
    // gọi được server và lỗi tải video thì giữ số đếm cũ nhưng chờ 20 s (RETRY_MS).
    const done = (r, sent) => {
      const down = sent && noteReply(r);
      if (v.chunks.get(k) !== entry) return;
      if (r.status === 'cancelled') { v.chunks.delete(k); return; }   // tua lại tới đây thì gửi lại
      // Gửi khi chế độ lời bài hát còn khác (đổi nút lúc đoạn này đang ở server): kết quả có câu hát (hay lỗi) thì bỏ,
      // schedule() xin lại theo chế độ mới với đúng phần âm thanh này (server đã giữ ASR). Không có câu hát thì như nhau.
      if (sent && entry.lyrics !== lyricsOn() && !modeFree(r)) { v.chunks.delete(k); v.redo.set(k, entry.pre); return; }
      if (r.status !== 'error') v.redo.delete(k);
      const paid = sent && !down;
      const n = fails + (paid ? 1 : 0);
      v.chunks.set(k, { ...r, pre: entry.pre, at: Date.now(), ...(r.status === 'error'
        ? { fails: n, wait: paid ? RETRY_MS[Math.min(n, RETRY_MS.length) - 1] : RETRY_MS[0] } : {}) });
      mergeCues(v);
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
      entry.pre = v.redo.has(k) ? v.redo.get(k) : before && before.status === 'error' && before.pre != null ? before.pre : prevDone ? PRE : PRE_SEEK;
      const w = TodMp4.window(media, Math.max(0, from - entry.pre), to + POST);
      if (!w) return done({ status: 'no_audio', from, to });
      if (v.quickGate) await v.quickGate;   // mẩu nhanh của video này đang tải: nhường đường truyền
      entry.bytes = w.end - w.start;   // tiến độ tải (since, got) ghi vào entry, cho dropSlow
      const aac = w.build(await fetchBytes(v, media, w.start, w.end - 1, entry.ctl.signal, entry));
      // Trong lúc tải, người xem đã tua/lướt đi chỗ khác: khỏi gửi (quay lại tới đây thì làm lại).
      // Không thấy video đang xem: chờ nó quay lại (actBack); vẫn không thấy (vừa đóng modal) thì khỏi gửi, kẻo gửi rồi lại
      // huỷ giữa lúc nhận dạng.
      if (id === currentId && !act) await actBack(id);
      if (!wanted.has(id + ':' + k) || (id === currentId && !act)) { if (v.chunks.get(k) === entry) v.chunks.delete(k); return; }
      // Không chờ server xong mới tải đoạn tiếp theo. urgent: đoạn chứa (hoặc sắp tới) chỗ đang xem, server làm trước.
      // rank: 0 là video đang xem, 1–4 là video dịch sẵn theo thứ tự sẽ lướt tới (server làm video gần trước).
      const next = upcoming().indexOf(id);
      Object.assign(entry, { sent: true, sentAt: Date.now(), from, to, urgent: urgentChunk(id, k, plan), lyrics: lyricsOn() });
      chrome.runtime.sendMessage({ type: 'subtitles', server: settings.server, key: id + ':' + k, payload: {
        id, desc: d.desc, hashtags: d.hashtags, durationMs: d.durationMs, from, to, audioStart: Math.round(w.startTime * 1000) / 1000,
        prev: k > 0 ? plan[k - 1] : null, urgent: entry.urgent, prefetch: id !== currentId, lyrics: entry.lyrics,
        rank: id === currentId ? 0 : next >= 0 ? next + 1 : PREFETCH, aac: toBase64(aac) } })
        .then((r) => done(r && r.status ? { ...r, from, to } : { status: 'error', error: (r && r.error) || 'không có phản hồi', unreachable: true, from, to }, true))
        .catch((e) => done({ status: 'error', error: e.message, unreachable: true, from, to }, true));
    } catch (e) {
      if (entry.ctl.signal.aborted) { if (v.chunks.get(k) === entry) v.chunks.delete(k); return; }
      done({ status: 'error', error: e.message, ...(e.rateLimited ? { rateLimited: true } : {}) });   // 429: tải lại khi hết nghỉ
    }
  }
  // Đoạn ở chỗ đang xem chưa dịch xong thì chưa làm đoạn kế của cùng video: sau khi tua, chỗ đang xem được server
  // làm trước. Đoạn kế thường còn 15–30 s mới cần; schedule() gửi nó ngay khi đoạn này xong. Video kế tiếp thì không
  // hoãn (đo khi vào trang: hoãn thì lướt sang video 2 cũng phải chờ dịch từ đầu); server vẫn ưu tiên đoạn gấp.
  // Đoạn kế bắt đầu trong 10 s tới cũng là gấp (dịch song song): đo trên vlog thật, tua tới gần cuối một đoạn thì đoạn
  // đó dịch xong (6–9 s) đã bị phát qua, đoạn kế mới bắt đầu dịch, chờ 10–12 s mới có sub.
  const URGENT_AHEAD = 10;
  const urgentChunk = (id, k, plan) => id === currentId && plan && plan[k] && plan[k][0] <= playhead + URGENT_AHEAD && playhead < plan[k][1];
  function holdBack(id, k) {
    const plan = planFor(currentId);
    if (id !== currentId || !plan || urgentChunk(id, k, plan)) return false;
    for (const [pk, c] of vid(currentId).chunks) if (c.status === 'pending' && urgentChunk(currentId, pk, plan)) return true;
    // Đoạn gấp vừa bị mẩu nhanh ngắt (chưa có mục nào) cũng giữ chỗ: không thì đoạn kế lấy lượt tải trước nó, hết 10 s của
    // mẩu nhanh là mất sub ~5 s (mô phỏng của verifier 31/10: đoạn ở chỗ tua xong lúc 12,4 s thay vì 6,9 s).
    for (let pk = 0; pk < plan.length; pk++) {
      if (pk !== k && urgentChunk(currentId, pk, plan) && wanted.has(currentId + ':' + pk) && !vid(currentId).chunks.has(pk)) return true;
    }
    return false;
  }
  // Đang nghỉ sau 429 thì không bắt đầu lượt tải nào, cả hàng dịch sẵn.
  function pump(lane) {
    while (lane.busy < lane.max && lane.queue.length && !rateWait()) { lane.busy++; drain(lane).finally(() => { lane.busy--; }); }
  }
  async function drain(lane) {
    while (lane.queue.length && alive() && settings.enabled && !rateWait()) {
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
  </style><div class="wrap"><div class="badge"><span class="dot"></span><span class="txt"></span></div><div class="sub"></div></div>`;
  const subEl = root.querySelector('.sub');
  const badgeEl = root.querySelector('.badge');
  const badgeTxt = root.querySelector('.badge .txt');
  const badgeDot = root.querySelector('.badge .dot');
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
      if (act && act.id !== currentId) { currentId = act.id; watched.add(currentId); }
      const pv = settings.enabled && act ? videoFor(act) : null;
      playing = !!pv && !pv.paused; playRate = (pv && pv.playbackRate) || 1;
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
          if (settle.id !== currentId || now - settle.since >= SETTLE) settle.from = now;
          settle.since = now;
        }
        Object.assign(settle, { id: currentId, ph, at: now });
        playhead = ph; headOf = currentId;
        schedule();                            // theo chỗ đang xem: tua tới đâu dịch tới đó
      }
    }
    const v = settings.enabled && act ? videoFor(act) : null;
    if (!v) { host.style.width = '0'; subEl.style.display = 'none'; badgeEl.style.display = 'none'; return; }
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
    }
    const st = res ? (res.slow ? 'pending' : res.status) : (eligible(items.get(currentId)) ? 'pending' : null);
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
      reply({ seen: items.size, counts, chunks });
    }
  });
})();

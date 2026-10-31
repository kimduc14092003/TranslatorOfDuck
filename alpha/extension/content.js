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

  let settings = { enabled: true, server: 'http://127.0.0.1:8787', position: 'bottom', size: 'm', delay: 0 };
  const items = new Map();       // id -> metadata
  const order = [];              // thứ tự video theo các API feed (không tính video chỉ thấy ở API khác hay ở player)
  const watched = new Set();     // video đã từng là video đang xem
  const vids = new Map();        // id -> { plan, media, url, total, chunks: Map k -> kết quả, cues }
  // Hai hàng tải riêng: video đang xem, và video kế tiếp (dịch sẵn). Đo trên Douyin thật: một lượt tải dịch sẵn
  // gặp CDN chậm mất 13 s, đoạn ở chỗ vừa tua tới phải chờ theo. Hàng dịch sẵn tải 2 video cùng lúc, để một lượt gặp
  // CDN chậm không chặn 3 video sau.
  const lanes = { current: { queue: [], busy: 0, max: 1 }, prefetch: { queue: [], busy: 0, max: 2 } };
  let currentId = null;
  let playhead = 0;              // vị trí thật trong video đang xem (giây)
  // Độ lệch đồng hồ trình phát Douyin so với <video>.currentTime (tap.main.js gửi). Feed 推荐 phát nối đoạn: tua thì
  // <video>.currentTime không đổi, chỉ đồng hồ trình phát nhảy; chỉ dùng khi đúng video đang xem.
  let clock = { id: null, offset: 0 };
  const timeOf = (v) => v.currentTime + (clock.id === currentId ? clock.offset : 0);
  let wanted = new Set();        // "id:k" các đoạn đang cần (schedule() tính lại 4 lần/giây)

  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };

  // ---------------------------------------------------------------- metadata từ trang
  function onItems(list) {
    for (const d of list) {
      if (!d || !d.id || d.id === 'undefined') continue;
      const prev = items.get(d.id);
      if (!prev || (d.gears.length + d.audio.length) > (prev.gears.length + prev.audio.length)) items.set(d.id, d);
      if (d.feed && !order.includes(d.id)) order.push(d.id);
    }
    schedule();
  }
  window.addEventListener(UP, (ev) => {
    let msg;
    try { msg = JSON.parse(ev.detail); } catch (_) { return; }
    if (msg.type === 'items') onItems(msg.data);
    else if (msg.type === 'clock' && msg.data && msg.data.id) clock = { id: String(msg.data.id), offset: Number(msg.data.offset) || 0 };
  });

  // ---------------------------------------------------------------- video đang xem
  function findActive() {
    const u = new URL(location.href);
    const modal = u.searchParams.get('modal_id');
    if (modal) return { id: modal };
    const m = u.pathname.match(/^\/(video|note)\/(\d+)/);
    if (m) return { id: m[2] };
    const el = document.querySelector('[data-e2e="feed-active-video"]');
    if (el) {
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
    if (active && active.el) { const v = active.el.querySelector('video'); if (v && visibleArea(v) > 0) return v; }
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) { const a = visibleArea(v); if (a > area) { area = a; best = v; } }
    return best;
  }

  // ---------------------------------------------------------------- dịch trước
  const vid = (id) => { let v = vids.get(id); if (!v) { v = { chunks: new Map(), quick: new Map(), cues: [] }; vids.set(id, v); } return v; };
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
  function needsWork(id, k) {
    const c = vid(id).chunks.get(k);
    // Lỗi thì thử lại sau 20 s, hoặc sau thời gian server báo (vd. dịch hết lượt trong ngày: server tạm nghỉ vài phút).
    return !c || (c.status === 'error' && Date.now() - (c.at || 0) > Math.max(20000, c.retryAfterMs || 0));
  }
  function schedule() {
    if (!settings.enabled || !currentId) return;
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
    maybeQuick(plan);
    pump(lanes.current);
    pump(lanes.prefetch);
  }
  // Video sắp lướt tới: các video sau video đang xem trong feed. Video đang xem không có trong feed (đo khi vào
  // trang: 1–2 video đầu chỉ thấy qua player, feed tới sau) thì lấy các video feed chưa xem.
  function upcoming() {
    const i = order.indexOf(currentId);
    const next = i >= 0 ? order.slice(i + 1) : order.filter(id => !watched.has(id));
    return next.filter(id => eligible(items.get(id))).slice(0, PREFETCH);
  }
  // Đoạn không còn cần (tua đi chỗ khác, lướt sang video khác): đang tải thì ngắt (đo khi lướt: lượt tải của video
  // vừa lướt qua gặp máy chủ chậm làm video mới phải chờ thêm), đã gửi server thì huỷ (server bỏ nếu chưa xử lý),
  // để chỗ đang xem không phải xếp hàng sau các chỗ đã bỏ qua.
  function cancelUnwanted() {
    const keys = [];
    for (const [id, v] of vids) {
      for (const [k, c] of v.chunks) {
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
  // Có hạn giờ: đo khi lướt, một lượt tải qua /aweme/v1/play/ treo tới 37 s, video đó không bao giờ được dịch sẵn.
  async function rangeFetch(url, a, b, signal, timeoutMs = 20000) {
    const limit = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, credentials: 'omit', cache: 'no-store', signal: signal ? AbortSignal.any([signal, limit]) : limit });
      if (res.status !== 206 && res.status !== 200) throw new Error('tải video: HTTP ' + res.status);
      const total = Number(((res.headers.get('content-range') || '').match(/\/(\d+)$/) || [])[1]) || null;
      let buf = await res.arrayBuffer();
      if (res.status === 200 && a > 0) buf = buf.slice(a, b + 1);   // máy chủ bỏ qua Range
      return { buf, total, url: res.url };
    } catch (e) {
      if (limit.aborted && !(signal && signal.aborted)) throw Object.assign(new Error('tải video quá lâu'), { timeout: true });
      throw e;
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
    v.api = api; v.url = probe.url || api; v.total = probe.total;
    // Chỉ giữ mục lục của 20 video gần nhất (video dài có mục lục vài MB).
    const withMedia = [...vids.entries()].filter(([, x]) => x.media);
    for (const [, x] of withMedia.slice(0, Math.max(0, withMedia.length - 20))) x.media = null;
    return v.media;
  }
  async function fetchBytes(v, a, b, signal) {
    for (const url of v.url === v.api ? [v.api] : [v.url, v.api]) {   // link CDN đã chuyển hướng hết hạn thì quay về /aweme/v1/play/
      try {
        const r = await rangeFetch(url, a, b, signal);
        if (v.total && r.total && r.total !== v.total) throw new Error('file video đã đổi');
        if (r.url) v.url = r.url;
        return r.buf;
      } catch (e) { if (url === v.api || signal.aborted) throw e; }
    }
  }
  function toBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // Gộp sub các đoạn đã xong (cues.js xử lý câu vắt qua ranh giới hai đoạn).
  // Mẩu nhanh chỉ dùng tới khi mọi đoạn 30 s phủ lên nó đã dịch xong.
  function mergeCues(v) {
    const done = [...v.chunks.keys()].sort((a, b) => a - b).map(k => v.chunks.get(k)).filter(c => c.status === 'ok');
    const quick = [...v.quick.values()].filter(q => q.status === 'ok' && !superseded(v, q));
    v.cues = TodCues.merge([...done, ...quick].sort((a, b) => a.from - b.from));
  }
  const superseded = (v, q) => !!v.plan && v.plan.every(([a, b], k) => b <= q.from || a >= q.to || (v.chunks.get(k) || {}).status === 'ok');
  const quickWanted = (id, q) => id === currentId && playhead >= q.from - 1 && playhead < q.to && !superseded(vid(id), q);
  function maybeQuick(plan) {
    if (!plan || !eligible(items.get(currentId))) return;
    const v = vid(currentId);
    const k = chunkAt(plan, playhead);
    const c = v.chunks.get(k);
    if (k < 0 || (c && c.status !== 'pending')) return;           // đã có kết quả (hoặc lỗi: đoạn 30 s tự thử lại)
    if (c && c.sent && Date.now() - c.sentAt > 2000) return;      // đoạn 30 s đã ở server một lúc (vd. dịch sẵn): sắp xong
    for (const q of v.quick.values()) {                            // đã có mẩu nhanh phủ chỗ này (lỗi thì 20 s sau mới thử lại)
      if (playhead >= q.from - 0.5 && playhead < q.to - 2 && (q.status !== 'error' || Date.now() - q.at < 20000)) return;
    }
    const from = Math.floor(playhead), to = Math.min(from + QUICK, plan[plan.length - 1][1]);
    if (to - from >= 3) runQuick(currentId, from, to);
  }
  async function runQuick(id, from, to) {
    const v = vid(id);
    const d = items.get(id);
    const q = { status: 'pending', from, to, ctl: new AbortController() };
    v.quick.set(from, q);
    const done = (r) => {
      if (v.quick.get(from) !== q) return;
      if (r.status === 'cancelled') { v.quick.delete(from); return; }
      Object.assign(q, r, { from, to, at: Date.now() });
      mergeCues(v);
    };
    try {
      const media = await ensureMedia(id);
      const w = TodMp4.window(media, Math.max(0, from - PRE_QUICK), to + 2);
      if (!w) return done({ status: 'no_audio' });
      const aac = w.build(await fetchBytes(v, w.start, w.end - 1, q.ctl.signal));
      if (!quickWanted(id, q)) { if (v.quick.get(from) === q) v.quick.delete(from); return; }
      q.sent = true;
      chrome.runtime.sendMessage({ type: 'subtitles', server: settings.server, key: id + ':q' + from, payload: {
        id, desc: d.desc, hashtags: d.hashtags, durationMs: d.durationMs, from, to, audioStart: Math.round(w.startTime * 1000) / 1000,
        quick: true, urgent: true, aac: toBase64(aac) } })
        .then((r) => done(r && r.status ? r : { status: 'error', error: (r && r.error) || 'không có phản hồi' }))
        .catch((e) => done({ status: 'error', error: e.message }));
    } catch (e) {
      if (q.ctl.signal.aborted) { if (v.quick.get(from) === q) v.quick.delete(from); return; }
      done({ status: 'error', error: e.message });
    }
  }
  async function runChunk(id, k) {
    const v = vid(id);
    const d = items.get(id);
    const entry = { status: 'pending', ctl: new AbortController() };
    const done = (r) => {
      if (v.chunks.get(k) !== entry) return;
      if (r.status === 'cancelled') { v.chunks.delete(k); return; }   // tua lại tới đây thì gửi lại
      v.chunks.set(k, { ...r, at: Date.now() });
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
      const w = TodMp4.window(media, Math.max(0, from - (prevDone ? PRE : PRE_SEEK)), to + POST);
      if (!w) return done({ status: 'no_audio', from, to });
      const aac = w.build(await fetchBytes(v, w.start, w.end - 1, entry.ctl.signal));
      // Trong lúc tải, người xem đã tua/lướt đi chỗ khác: khỏi gửi (quay lại tới đây thì làm lại).
      if (!wanted.has(id + ':' + k)) { if (v.chunks.get(k) === entry) v.chunks.delete(k); return; }
      // Không chờ server xong mới tải đoạn tiếp theo. urgent: đoạn chứa (hoặc sắp tới) chỗ đang xem, server làm trước.
      Object.assign(entry, { sent: true, sentAt: Date.now(), from, to, urgent: urgentChunk(id, k, plan) });
      chrome.runtime.sendMessage({ type: 'subtitles', server: settings.server, key: id + ':' + k, payload: {
        id, desc: d.desc, hashtags: d.hashtags, durationMs: d.durationMs, from, to, audioStart: Math.round(w.startTime * 1000) / 1000,
        prev: k > 0 ? plan[k - 1] : null, urgent: entry.urgent, prefetch: id !== currentId, aac: toBase64(aac) } })
        .then((r) => done(r && r.status ? { ...r, from, to } : { status: 'error', error: (r && r.error) || 'không có phản hồi', from, to }))
        .catch((e) => done({ status: 'error', error: e.message, from, to }));
    } catch (e) {
      if (entry.ctl.signal.aborted) { if (v.chunks.get(k) === entry) v.chunks.delete(k); return; }
      done({ status: 'error', error: e.message });
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
    return false;
  }
  function pump(lane) {
    while (lane.busy < lane.max && lane.queue.length) { lane.busy++; drain(lane).finally(() => { lane.busy--; }); }
  }
  async function drain(lane) {
    while (lane.queue.length && alive() && settings.enabled) {
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
  let act = null;
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
      if (act && act.id !== currentId) { currentId = act.id; watched.add(currentId); }
      const pv = settings.enabled && act ? videoFor(act) : null;
      // Đo trên Douyin thật: giữa lúc phát, trình phát có lúc trả currentTime = 0 (đang dừng) rồi quay lại chỗ cũ. Tin
      // con số đó thì huỷ nhầm đoạn đang dịch rồi phải gửi lại. Bỏ qua lần đọc khi video chưa sẵn sàng, và cú nhảy về 0
      // lúc đang dừng phải lặp lại ở lần đọc sau (250 ms) mới tin.
      const raw = pv ? pv.currentTime : 0;
      const glitch = pv && (pv.readyState < 1 || (raw === 0 && pv.paused && playhead > 2 && !zeroSeen));
      zeroSeen = !!pv && raw === 0 && pv.paused;
      if (!glitch) {
        playhead = pv ? timeOf(pv) : 0;
        schedule();                            // theo chỗ đang xem: tua tới đâu dịch tới đó
      }
    }
    const v = settings.enabled && act ? videoFor(act) : null;
    if (!v) { host.style.width = '0'; subEl.style.display = 'none'; badgeEl.style.display = 'none'; return; }
    attachHost();
    const r = v.getBoundingClientRect();
    host.style.left = r.left + 'px'; host.style.top = r.top + 'px'; host.style.width = r.width + 'px'; host.style.height = r.height + 'px';
    if (v.readyState < 1 || (zeroSeen && v.currentTime === 0)) { subEl.style.display = 'none'; return; }
    playhead = timeOf(v);
    const cv = vids.get(currentId);
    const plan = cv && cv.plan;
    let res = cv && (plan ? cv.chunks.get(chunkAt(plan, playhead)) : cv.chunks.get(0));
    // Đoạn 30 s chưa xong mà mẩu nhanh ở chỗ này đã có sub: nhãn "VI". Mẩu nhanh bị bỏ qua thì chưa tin (cửa sổ 10 s
    // ngắn, dễ thành "quá ít lời"): vẫn "đang dịch" tới khi đoạn 30 s xong.
    if (cv && (!res || res.status === 'pending')) {
      for (const q of cv.quick.values()) if (playhead >= q.from && playhead < q.to && q.status === 'ok') res = q;
    }
    const st = res ? res.status : (eligible(items.get(currentId)) ? 'pending' : null);
    if (now < toastUntil) {
      badgeDot.style.background = BADGE.ok[0];
      badgeTxt.textContent = toastText;
      badgeEl.style.display = 'block';
    } else if (st && BADGE[st]) {
      badgeDot.style.background = BADGE[st][0];
      badgeTxt.textContent = st === 'error' ? BADGE.error[1] + ': ' + String(res.error || '').slice(0, 60)
        : st === 'skipped' ? 'VI · ' + (SKIP_WHY[res.label] || 'bỏ qua') + (plan && plan.length > 1 ? ` (đoạn ${mmss(res.from)}–${mmss(res.to)})` : '')
        : BADGE[st][1];
      badgeEl.style.display = 'block';
    } else badgeEl.style.display = 'none';
    const c = cv ? TodCues.at(cv.cues, playhead - (Number(settings.delay) || 0)) : null;
    if (!c) { subEl.style.display = 'none'; return; }
    const scale = { s: 0.034, m: 0.042, l: 0.052 }[settings.size] || 0.042;
    subEl.style.fontSize = Math.max(14, Math.min(40, r.height * scale)) + 'px';
    subEl.style.top = ''; subEl.style.bottom = '';
    if (settings.position === 'top') subEl.style.top = (r.height * 0.08) + 'px';
    else if (settings.position === 'middle') subEl.style.top = (r.height * 0.55) + 'px';
    else subEl.style.bottom = (r.height * 0.13) + 'px';
    if (subEl.textContent !== c.vi) subEl.textContent = c.vi;
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
      settings = { ...settings, ...nv };
      schedule();
    }
  });
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

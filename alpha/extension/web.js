// Bộ đọc chung cho trang người xem đã bật trong popup ("Dịch trang này"): nhận các mẩu âm thanh trình phát của trang tự nạp
// (msehook.main.js), chia thành đoạn theo thời gian video, gửi server trên máy dịch TRƯỚC chỗ đang xem, hiện sub đúng lúc nói theo
// video.currentTime. Như đường Douyin nhưng không viết riêng cho trang nào; video có mã hoá (DRM) hay không nạp kiểu Media Source
// thì không dịch được (dùng nút "Dịch âm thanh tab này", sub trễ).
(() => {
  if (globalThis.__todWeb) return;
  globalThis.__todWeb = true;
  const F = globalThis.TodFmp4;
  // Đoạn W giây: dịch các câu bắt đầu trong [kW, (k+1)W); âm thanh gửi dư PRE giây phía trước, POST giây phía sau (câu vắt qua
  // ranh giới đủ chữ). Đoạn sẵn sàng khi âm thanh đã nạp phủ liền cả khoảng đó (hay tới hết video).
  // Đoạn đầu ngắn (8 s): dịch xong sớm, không lỡ câu đầu video (thử TikTok 7/11: đoạn đầu 15 s về lúc câu đầu đã qua).
  const W = 15, FIRST = 8, PRE = 2, POST = 3, AHEAD = 60, MAX_INFLIGHT = 2;
  const startOf = (k) => (k === 0 ? 0 : FIRST + (k - 1) * W);
  const indexAt = (t) => (t < FIRST ? 0 : 1 + Math.floor((t - FIRST) / W));
  let settings = { enabled: true, server: 'http://127.0.0.1:8787', target: 'vi', lyrics: true };
  // Đổi ngôn ngữ đích hay chế độ lời bài hát: bỏ kết quả cũ, dịch lại (trước đây đoạn đã dịch giữ dòng của ngôn ngữ cũ, G18).
  const loadSettings = () => chrome.storage.local.get('settings').then(({ settings: s = {} }) => {
    const before = (settings.target || 'vi') + '|' + (settings.lyrics !== false);
    settings = { ...settings, ...s };
    if (before !== (settings.target || 'vi') + '|' + (settings.lyrics !== false)) for (const x of sources.values()) { x.sent.clear(); x.info.clear(); x.cues = []; }
  }).catch(() => {});
  loadSettings();
  chrome.storage.onChanged.addListener((c) => { if (c.settings) loadSettings(); });

  // ms (mã MediaSource) -> { url, tracks: Map sb -> { init, info, segs: [{ start, end, bytes }] }, id, sent: Map k -> trạng thái, cues }
  const sources = new Map();
  let reqN = 0, off = false;
  // Giới hạn: số nguồn, cỡ mỗi lần nạp, tổng byte mỗi track (trang có thể gửi tin giả cùng dấu hiệu, G01; bộ nhớ, G10).
  const MAX_SOURCES = 30, MAX_APPEND = 16 << 20, MAX_TRACK = 48 << 20;
  const src = (ms) => {
    if (!sources.has(ms)) {
      if (sources.size >= MAX_SOURCES) sources.delete([...sources.entries()].sort((a, b) => a[1].seen - b[1].seen)[0][0]);
      sources.set(ms, { url: null, tracks: new Map(), id: 'web' + Date.now() + String(++reqN).padStart(3, '0'), sent: new Map(), info: new Map(), cues: [], seen: Date.now() });
    }
    return sources.get(ms);
  };
  const okId = (x) => Number.isInteger(x) && x > 0 && x < 1e7;
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (off || e.source !== window || !m || m.__todMse !== 1 || !okId(m.ms)) return;
    if (!['url', 'sb', 'data', 'close'].includes(m.type)) return;
    const s = src(m.ms);
    s.seen = Date.now();
    if (m.type === 'url') { if (typeof m.url === 'string' && m.url.startsWith('blob:')) s.url = m.url; }
    else if (m.type === 'sb') { if (!okId(m.sb)) return; if (typeof m.url === 'string' && m.url.startsWith('blob:')) s.url = m.url; if (!s.tracks.has(m.sb)) s.tracks.set(m.sb, { init: null, info: null, segs: [], bytes: 0 }); }
    else if (m.type === 'data') {
      if (!okId(m.sb) || !(m.bytes instanceof ArrayBuffer) || m.bytes.byteLength > MAX_APPEND || !Number.isFinite(m.offset)) return;
      const tr = s.tracks.get(m.sb) || s.tracks.set(m.sb, { init: null, info: null, segs: [], bytes: 0 }).get(m.sb);
      let u8 = new Uint8Array(m.bytes);
      let segs = [];
      try {
        // Mẩu init và mẩu dữ liệu có thể nằm chung một lần nạp (G02): lấy init, rồi đọc tiếp các mảnh phía sau.
        const info = F.readInit(u8);
        if (info) { tr.init = info.mux ? info.initBytes : u8.slice(0, info.end); tr.info = info; }
        // Mẩu gộp hình + tiếng: chỉ giữ phần âm thanh (bản chép mới, nhỏ hơn hàng chục lần), phần hình bỏ luôn.
        if (tr.info && tr.info.mux) u8 = F.extractAudio(u8, tr.info);
        segs = F.readSegments(u8, tr.info);
      } catch (_) { return; }
      for (const g of segs) {
        const start = g.start + m.offset, end = g.end + m.offset;
        if (!(end > start) || end - start > 600) continue;
        // Nạp lại cùng đoạn (tua, đổi chất lượng): thay mẩu cũ cùng mốc. Chép đúng phần của mảnh, không giữ cả lần nạp (G10).
        tr.segs = tr.segs.filter((x) => Math.abs(x.start - start) > 0.01);
        tr.segs.push({ start, end, bytes: u8.slice(g.byteStart, g.byteEnd) });
      }
      tr.segs.sort((a, b) => a.start - b.start);
      tr.bytes = tr.segs.reduce((n, x) => n + x.bytes.length, 0);
      while (tr.bytes > MAX_TRACK && tr.segs.length > 1) tr.bytes -= tr.segs.shift().bytes.length;
    } else if (m.type === 'close') s.closed = true;
  });
  // Người xem tắt trang này trong popup: dừng ngay ở tab này (background báo mọi tab của trang, G14).
  chrome.runtime.onMessage.addListener((msg) => { if (msg && msg.type === 'web-off') stop(); });

  // Track âm thanh của một nguồn: track có init và nhiều mẩu nhất (thường chỉ một).
  const trackOf = (s) => [...s.tracks.values()].filter((t) => t.init).sort((a, b) => b.segs.length - a.segs.length)[0] || null;
  // Phần đã nạp liền nhau quanh [a, b]: trả các mẩu phủ nó, hay null nếu còn hở (sai số 0,05 s giữa hai mẩu).
  // Quét theo mép xa nhất đã phủ (mẩu nằm trong mẩu khác không làm hở, G08).
  function cover(tr, a, b) {
    const segs = tr.segs.filter((x) => x.end > a && x.start < b);
    if (!segs.length || segs[0].start > a + 0.05) return null;
    let edge = segs[0].end;
    for (const x of segs.slice(1)) { if (x.start > edge + 0.05) return null; edge = Math.max(edge, x.end); }
    return edge >= b - 0.05 ? segs : null;
  }
  // Mép xa nhất phủ liền từ a (để gửi mẩu nhanh khi tua xa hay khi trình phát nạp ít): null nếu a chưa được phủ.
  function reach(tr, a) {
    let edge = null;
    for (const x of tr.segs) { if (x.end <= a) continue; if (edge == null) { if (x.start > a + 0.05) return null; edge = x.end; } else if (x.start > edge + 0.05) break; else edge = Math.max(edge, x.end); }
    return edge;
  }
  const area = (v) => { const r = v.getBoundingClientRect(); return Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)); };
  const mainVideo = () => [...document.querySelectorAll('video')].filter((v) => area(v) > 0)
    .sort((a, b) => (b.paused ? 0 : 1) - (a.paused ? 0 : 1) || area(b) - area(a))[0] || null;
  const sourceOf = (v) => { const u = v && (v.currentSrc || v.src); for (const [ms, s] of sources) if (u && s.url === u) return [ms, s]; return [null, null]; };

  function toBase64(parts) {
    const n = parts.reduce((x, p) => x + p.length, 0), all = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { all.set(p, o); o += p.length; }
    let str = '';
    for (let i = 0; i < all.length; i += 0x8000) str += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000));
    return btoa(str);
  }

  // Gửi đoạn k của nguồn s nếu âm thanh đã nạp đủ. dur: thời lượng video (Infinity nếu chưa biết). quick: mẩu nhanh [qa, qb) khi
  // đoạn đầy đủ chưa đủ âm thanh (tua xa, trình phát nạp ít, livestream: G09); khoá riêng 'q' + k.
  const r3 = (x) => Math.round(x * 1000) / 1000;
  // Extension vừa cập nhật hay tải lại: bản bộ đọc cũ còn trên trang mất kết nối (chrome.runtime.id rỗng, gọi
  // sendMessage ném "Extension context invalidated", Cốc Cốc 7/11). Dừng bản cũ, gỡ lớp sub; tải lại trang để chạy bản mới.
  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };
  function stop() { off = true; sources.clear(); host.remove(); }
  function trySend(s, k, dur, quick = null) {
    if (!alive()) { stop(); return false; }
    const key = quick ? 'q' + k : k;
    if (s.sent.has(key) || (quick && s.sent.has(k))) return false;
    const tr = trackOf(s);
    if (!tr) return false;
    const from = quick ? quick.from : startOf(k), to = quick ? quick.to : Math.min(startOf(k + 1), dur);
    if (!(to > from)) return false;
    const a = Math.max(0, from - PRE), b = quick ? quick.b : Math.min(to + POST, isFinite(dur) ? dur - 0.1 : to + POST);
    const segs = cover(tr, a, b);
    if (!segs) return false;
    // Ghép init + các mảnh (mỗi mảnh moof + mdat đủ). Mảnh dài hơn đoạn (TikTok 36 s một mảnh): server chỉ giải [a, b] (skip, span).
    const parts = [tr.init, ...segs.map((x) => x.bytes)];
    const size = parts.reduce((n, p) => n + p.length, 0);
    if (size > 24 << 20) { s.sent.set(key, 'error'); note = 'mẩu âm thanh quá lớn'; return false; }
    const audioStart = r3(segs[0].start);
    s.sent.set(key, 'pending');
    s.info.set(key, { at: Date.now(), from, to });
    const payload = {
      id: s.id, aac: toBase64(parts), fmt: 'fmp4', from: r3(from), to: r3(to), audioStart, skip: r3(Math.max(0, a - segs[0].start)), span: r3(b - a + 0.5),
      ...(quick ? { quick: true } : {}),
      ...(!quick && k > 0 && s.sent.get(k - 1) === 'ok' ? { prev: [startOf(k - 1), from] } : {}),
      target: settings.target || 'vi', lyrics: settings.lyrics !== false, desc: document.title || '', hashtags: [],
    };
    const want = (settings.target || 'vi') + '|' + (settings.lyrics !== false);
    let sending;
    try { sending = chrome.runtime.sendMessage({ type: 'subtitles', key: s.id + ':' + key + ':' + want, server: settings.server, payload }); }
    catch (_) { s.sent.delete(key); stop(); return false; }
    sending.then((r) => {
      // Ngôn ngữ đã đổi trong lúc dịch: bỏ kết quả (trạng thái đã được xoá khi đổi).
      if (want !== (settings.target || 'vi') + '|' + (settings.lyrics !== false)) return;
      const inf = s.info.get(key) || {};
      if (r && r.status !== 'error' && r.status !== 'cancelled') Object.assign(inf, { done: Date.now(), lines: Array.isArray(r.cues) ? r.cues.length : 0, sung: Array.isArray(r.cues) ? r.cues.filter((c) => c.sung).length : 0, label: r.label, error: null });
      else inf.error = (r && r.error) || 'không có phản hồi';
      if (!r || r.status === 'error' || r.status === 'cancelled') { s.sent.delete(key); s.fails = (s.fails || 0) + 1; note = 'lỗi: ' + ((r && r.error) || 'không có phản hồi'); if (s.fails >= 3) s.sent.set(key, 'error'); return; }
      s.fails = 0;
      s.sent.set(key, r.status === 'ok' ? 'ok' : 'skipped');
      if (r.status === 'ok' && Array.isArray(r.cues)) {
        if (r.target && r.target !== (settings.target || 'vi')) return;
        // Câu vắt qua ranh giới có thể ra ở cả hai đoạn (thử TikTok 7/11: hai bản dịch của cùng một câu): dòng mới chiếm quá nửa
        // thời gian của một dòng đã có thì bỏ.
        const dup = (c) => s.cues.some((x) => { const o = Math.min(x.end, c.end) - Math.max(x.start, c.start); return o > 0.5 * Math.max(0.1, Math.min(x.end - x.start, c.end - c.start)); });
        for (const c of r.cues) if (!dup(c)) s.cues.push({ start: c.start, end: c.end, text: (c.sung ? '♪ ' : '') + (c.vi || c.zh || '') });
        s.cues.sort((x, y) => x.start - y.start);
      }
    }).catch(() => { s.sent.delete(key); });
    return true;
  }

  // Lớp sub: đặt trên khung video đang xem.
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;overflow:hidden';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .line { position: absolute; left: 50%; transform: translateX(-50%); max-width: 88%; text-align: center; font: 600 20px/1.35 system-ui, sans-serif; color: #fff;
      background: rgba(0,0,0,.6); padding: .15em .5em; border-radius: .3em; white-space: pre-wrap; text-shadow: 0 0 2px #000; }
    /* Che sub gốc (tuỳ chọn trong popup, chủ dự án 7/11): dải ngang hết bề rộng video, làm mờ hình phía sau để chữ in sẵn
       trong video không còn đọc được; chữ đậm, viền đen. */
    .cover { left: 0 !important; right: 0; transform: none !important; max-width: none !important; width: 100%; box-sizing: border-box;
      border-radius: 0 !important; background: rgba(12,12,12,.42) !important; backdrop-filter: blur(16px) saturate(.85); -webkit-backdrop-filter: blur(16px) saturate(.85);
      padding: .42em .6em !important; font-weight: 800 !important; -webkit-text-stroke: .1em #000; paint-order: stroke fill; text-shadow: 0 .05em .14em rgba(0,0,0,.75) !important; }
    .badge { position: absolute; left: 10px; top: 10px; font: 12px/1.4 system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.55); padding: 2px 8px; border-radius: 10px; }
    .badge .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; vertical-align: 1px; }
    .info { position: absolute; left: 10px; top: 36px; max-width: min(380px, 90%); max-height: 75%; overflow: hidden; font: 12px/1.5 system-ui, sans-serif;
      color: #fff; background: rgba(0,0,0,.82); padding: 7px 10px; border-radius: 8px; white-space: pre-wrap; font-variant-numeric: tabular-nums; display: none; }
  </style><span class="line" hidden></span><span class="badge"><span class="dot"></span><span class="txt"></span></span><div class="info"></div>`;
  // Nhãn trạng thái như Douyin (chủ dự án 7/11): góc trên trái khung video, chấm màu + mã ngôn ngữ đích; chạy ổn thì chỉ có
  // mã, đang dịch, chờ hay lỗi thì thêm chữ.
  const lineEl = root.querySelector('.line'), badge = root.querySelector('.badge');
  const badgeDot = root.querySelector('.badge .dot'), badgeTxt = root.querySelector('.badge .txt'), infoEl = root.querySelector('.info');
  // Rê chuột vào nhãn: bảng tình trạng dịch của video đang xem, như Douyin (chủ dự án 7/11). Lớp sub không nhận chuột
  // (pointer-events: none), chỉ đọc vị trí chuột: click vẫn tới trang bên dưới.
  let mouseX = -1, mouseY = -1, infoOpen = false;
  const overBadge = () => { if (!host.isConnected || host.style.display === 'none') return false; const b = badge.getBoundingClientRect(); return mouseX >= b.left - 4 && mouseX <= b.right + 4 && mouseY >= b.top - 4 && mouseY <= b.bottom + 4; };
  window.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; infoOpen = overBadge(); if (!infoOpen) infoEl.style.display = 'none'; }, { passive: true, capture: true });
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) { infoOpen = false; infoEl.style.display = 'none'; } }, true);
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const SKIP_WHY = { no_speech: 'không nghe thấy lời', too_short: 'quá ít lời', filler: 'chỉ có tiếng đệm', not_zh: 'không phải ngôn ngữ dịch được', singing: 'bài hát', untranslated: 'dịch lỗi' };
  function pieceState(s, key) {
    const st = s.sent.get(key), inf = s.info.get(key) || {};
    if (st === 'ok') return inf.lines ? `✓ ${inf.lines} dòng${inf.sung ? `, ${inf.sung} dòng ♪` : ''}` : '✓ không có lời';
    if (st === 'skipped') return 'bỏ qua: ' + (SKIP_WHY[inf.label] || 'không dịch');
    if (st === 'error') return 'lỗi: ' + String(inf.error || note).slice(0, 50);
    if (st === 'pending') return `đang dịch ở server (${Math.round((Date.now() - (inf.at || Date.now())) / 1000)} s)`;
    if (inf.error) return 'lỗi, thử lại: ' + String(inf.error).slice(0, 40);
    return 'chờ trình phát nạp âm thanh';
  }
  function infoText(v, s) {
    const dur = isFinite(v.duration) ? v.duration : 0, t = v.currentTime;
    const out = [`Video ${dur ? mmss(dur) : '?'} · đang xem ${mmss(t)}`];
    if (!s) return out.concat(note).join('\n');
    const tr = trackOf(s), fin = (k) => s.sent.get(k) === 'ok' || s.sent.get(k) === 'skipped';
    const cur = indexAt(t), last = dur ? indexAt(Math.max(0, dur - 0.01)) : null;
    let upto = null;
    for (let k = cur; fin(k) && (last == null || k <= last); k++) upto = Math.min(startOf(k + 1), dur || Infinity);
    out.push(upto != null ? `Đã xong tới ${mmss(upto)} (trước chỗ đang xem ${Math.max(0, Math.round(upto - t))} s)` : 'Chỗ đang xem chưa có bản dịch');
    const ks = [...s.sent.keys()].filter((k) => typeof k === 'number');
    const lines = ks.reduce((n, k) => n + ((s.sent.get(k) === 'ok' && (s.info.get(k) || {}).lines) || 0), 0);
    out.push(`Đã xong ${ks.filter(fin).length}${last != null ? '/' + (last + 1) : ''} đoạn · ${lines} dòng`);
    const want = new Set([...ks, cur]);
    for (let k = cur; k <= cur + 3 && (last == null || k <= last); k++) want.add(k);
    const show = [...want].sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b).slice(0, 8).sort((a, b) => a - b);
    for (const k of show) out.push(`${k === cur ? '▶' : '  '} ${mmss(startOf(k))}–${mmss(Math.min(startOf(k + 1), dur || Infinity))}  ${pieceState(s, k)}`);
    if (want.size > show.length) out.push(`   (+${want.size - show.length} đoạn khác)`);
    for (const k of [...s.sent.keys()].filter((x) => typeof x === 'string').slice(-2)) {
      const inf = s.info.get(k) || {};
      out.push(`Mẩu nhanh ${mmss(inf.from || 0)}–${mmss(inf.to || 0)}  ${pieceState(s, k)}`);
    }
    if (tr && tr.segs.length) {
      const edge = reach(tr, Math.max(0, t - 0.1));
      out.push(`Âm thanh: ${tr.info && tr.info.mux ? 'tách từ luồng gộp hình + tiếng' : 'luồng tiếng riêng'} · ${edge != null ? `trình phát đã nạp tới ${mmss(edge)} (trước ${Math.max(0, Math.round(edge - t))} s)` : 'chưa nạp chỗ đang xem'}`);
    } else out.push('Âm thanh: chưa thấy');
    out.push(`Dịch trước ${settings.fullAhead ? 'tới hết phần trình phát đã nạp' : AHEAD + ' s'} · lời bài hát: ${settings.lyrics !== false ? 'dịch' : 'bỏ qua'}`);
    return out.join('\n');
  }
  const DOT = { ok: '#2ecc71', pending: '#f5a623', wait: '#9b9b9b', error: '#e74c3c' };
  const dotOf = (n) => n === 'đọc trước' ? DOT.ok : n === 'đang dịch…' ? DOT.pending : /^lỗi|không dịch được|quá lớn|không nạp/.test(n) ? DOT.error : DOT.wait;
  let note = 'chờ video…';
  const place = () => { const fe = document.fullscreenElement; (fe && fe.tagName !== 'VIDEO' ? fe : document.documentElement).appendChild(host); };
  document.addEventListener('fullscreenchange', place);

  // Alt+↑ / Alt+↓: dời sub lên, xuống 2% chiều cao video, nhớ theo trang (subPos, chung với đường Douyin); chọn lại "Vị trí sub"
  // trong popup thì về mặc định.
  let subOff = 0, subPosWrite = null, toastText = '', toastUntil = 0;
  chrome.storage.local.get('subPos').then((x) => { subOff = Number((x.subPos || {})[location.host]) || 0; }).catch(() => {});
  chrome.storage.onChanged.addListener((c) => { if (c.subPos && !subPosWrite) subOff = Number((c.subPos.newValue || {})[location.host]) || 0; });
  window.addEventListener('keydown', (e) => {
    if (off || !e.altKey || e.ctrlKey || e.metaKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault(); e.stopPropagation();
    subOff = Math.max(-0.5, Math.min(0.8, Math.round((subOff + (e.key === 'ArrowUp' ? 0.02 : -0.02)) * 100) / 100));
    clearTimeout(subPosWrite);
    subPosWrite = setTimeout(() => {
      if (alive()) chrome.storage.local.get('subPos').then((x) => chrome.storage.local.set({ subPos: { ...(x.subPos || {}), [location.host]: subOff } })).catch(() => {}).finally(() => { subPosWrite = null; });
    }, 300);
    toastText = 'sub ' + (subOff ? (subOff > 0 ? 'cao hơn ' : 'thấp hơn ') + Math.round(Math.abs(subOff) * 100) + '%' : 'ở vị trí mặc định');
    toastUntil = Date.now() + 1500;
  }, true);
  let waitSince = 0, waitKey = null;
  setInterval(() => {
    if (off) return;
    if (!alive()) { stop(); return; }
    // Dọn nguồn cũ trước mọi thứ (kể cả lúc không thấy video nào, G10).
    for (const [ms, x] of sources) if (Date.now() - x.seen > 120000 && !x.cues.length) sources.delete(ms);
    if (settings.enabled === false) { host.remove(); return; }
    if (!document.documentElement) return;
    if (!host.isConnected) place();
    const v = mainVideo();
    if (!v) { host.style.display = 'none'; return; }
    const r = v.getBoundingClientRect();
    const hl = Math.max(0, r.left), ht = Math.max(0, r.top), hw = Math.min(r.right, innerWidth) - hl, hh = Math.min(r.bottom, innerHeight) - ht;
    Object.assign(host.style, { display: 'block', left: hl + 'px', width: Math.max(0, hw) + 'px', top: ht + 'px', height: Math.max(0, hh) + 'px' });
    const [, s] = sourceOf(v);
    if (v.mediaKeys) note = 'video có mã hoá: không dịch được';
    else if (!s) note = (v.currentSrc || '').startsWith('blob:') ? 'chưa thấy âm thanh của video này' : 'trang không nạp kiểu Media Source: dùng "Dịch âm thanh tab"';
    else {
      const dur = isFinite(v.duration) ? v.duration : Infinity, t = v.currentTime;
      let inflight = [...sources.values()].reduce((n, x) => n + [...x.sent.values()].filter((y) => y === 'pending').length, 0);
      // Video đang xem: đoạn chứa chỗ đang xem trước, rồi tới AHEAD giây phía trước. Ô "Dịch trước cả video khi rảnh"
      // (settings.fullAhead): tới hết video, nhưng chỉ được phần trình phát của trang đã nạp (trySend không gửi đoạn chưa có
      // âm thanh); việc gấp vẫn trước vì vòng đi từ chỗ đang xem và giới hạn MAX_INFLIGHT.
      // Ngoài cửa sổ AHEAD thì dừng ở đoạn đầu tiên chưa gửi mà không gửi được (trình phát chưa nạp tới): livestream có dur vô
      // cực, không dừng thì vòng lặp không bao giờ hết.
      const until = settings.fullAhead ? dur : t + AHEAD;
      for (let k = indexAt(t); startOf(k) < Math.min(dur, until) && inflight < MAX_INFLIGHT; k++) {
        if (trySend(s, k, dur)) inflight++;
        else if (startOf(k) >= t + AHEAD && !s.sent.has(k)) break;
      }
      // Video tải sẵn trong feed (chưa xem): đoạn đầu, để lướt sang là có sub ngay.
      for (const [, x] of sources) if (x !== s && inflight < MAX_INFLIGHT + 1 && !x.closed && Date.now() - x.seen < 60000 && trySend(x, 0, Infinity)) inflight++;
      const k = indexAt(t), st = s.sent.get(k), tr = trackOf(s);
      // Đoạn đang xem chưa gửi được sau 1,5 s (tua xa: trình phát chỉ nạp từ chỗ mới; livestream): gửi mẩu nhanh từ chỗ đang xem
      // tới hết phần đã nạp liền, tối đa tới hết đoạn (G09). Câu trùng với đoạn đầy đủ gửi sau bị bỏ khi hiện.
      const wk = s.id + ':' + k;
      if (st || s.sent.has('q' + k)) waitKey = null; else if (waitKey !== wk) { waitKey = wk; waitSince = Date.now(); }
      if (tr && waitKey === wk && Date.now() - waitSince > 1500 && !v.paused && inflight < MAX_INFLIGHT + 1) {
        const qa = Math.max(0, t - 0.5), edge = reach(tr, Math.max(0, qa - PRE));
        if (edge != null && edge - qa >= 4) trySend(s, k, dur, { from: Math.max(startOf(k), qa), to: Math.min(startOf(k + 1), dur, edge - 1), b: edge });
      }
      const sq = s.sent.get('q' + k);
      note = st === 'ok' || st === 'skipped' || sq === 'ok' || sq === 'skipped' ? 'đọc trước' : st === 'pending' || sq === 'pending' ? 'đang dịch…' : st === 'error' ? note : 'chờ trình phát nạp âm thanh…';
      // Bỏ mẩu đã xem xa phía sau (giữ bộ nhớ nhỏ).
      if (tr) tr.segs = tr.segs.filter((x) => x.end > t - 30 || x.start > t);
    }
    const c = s && s.cues.filter((x) => x.start <= v.currentTime && v.currentTime < Math.max(x.end, x.start + 1.2)).at(-1);
    if (c) {
      if (lineEl.textContent !== c.text) lineEl.textContent = c.text;
      lineEl.hidden = false;
      // Cỡ chữ, vị trí như đường Douyin (popup: cỡ chữ, vị trí sub), tính theo cả khung video; Alt+↑/↓ dời thêm (subOff).
      const scale = ({ s: 0.034, m: 0.042, l: 0.052 }[settings.size] || 0.042) * (settings.cover ? 1.15 : 1);
      lineEl.style.fontSize = Math.max(14, Math.min(44, r.height * scale)) + 'px';
      lineEl.classList.toggle('cover', !!settings.cover);
      lineEl.style.top = ''; lineEl.style.bottom = '';
      if (settings.position === 'top') lineEl.style.top = (r.top + r.height * (0.08 - subOff) - ht) + 'px';
      else if (settings.position === 'middle') lineEl.style.top = (r.top + r.height * (0.55 - subOff) - ht) + 'px';
      else lineEl.style.bottom = (ht + hh - (r.bottom - r.height * (0.13 + subOff))) + 'px';
    } else lineEl.hidden = true;
    const tagTxt = (settings.target || 'vi').toUpperCase() + (Date.now() < toastUntil ? ' · ' + toastText : note === 'đọc trước' ? '' : ' · ' + note);
    if (badgeTxt.textContent !== tagTxt) badgeTxt.textContent = tagTxt;
    badgeDot.style.background = dotOf(note);
    if (infoOpen && overBadge()) {
      let text;
      try { text = infoText(v, s); } catch (e) { text = 'Không hiện được thông tin: ' + e.message; }
      if (infoEl.textContent !== text) infoEl.textContent = text;
      infoEl.style.display = 'block';
    } else infoEl.style.display = 'none';
  }, 200);
})();

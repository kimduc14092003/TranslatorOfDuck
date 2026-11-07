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
  const loadSettings = () => chrome.storage.local.get('settings').then(({ settings: s = {} }) => { settings = { ...settings, ...s }; }).catch(() => {});
  loadSettings();
  chrome.storage.onChanged.addListener((c) => { if (c.settings) loadSettings(); });

  // ms (mã MediaSource) -> { url, tracks: Map sb -> { init, info, segs: [{ start, end, bytes }] }, id, sent: Map k -> trạng thái, cues }
  const sources = new Map();
  let reqN = 0;
  const src = (ms) => {
    if (!sources.has(ms)) sources.set(ms, { url: null, tracks: new Map(), id: 'web' + Date.now() + String(++reqN).padStart(3, '0'), sent: new Map(), cues: [], seen: Date.now() });
    return sources.get(ms);
  };
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (e.source !== window || !m || m.__todMse !== 1) return;
    const s = src(m.ms);
    s.seen = Date.now();
    if (m.type === 'url') s.url = m.url;
    else if (m.type === 'sb') { if (m.url) s.url = m.url; s.tracks.set(m.sb, { init: null, info: null, segs: [], mime: m.mime }); }
    else if (m.type === 'data') {
      const tr = s.tracks.get(m.sb) || s.tracks.set(m.sb, { init: null, info: null, segs: [] }).get(m.sb);
      const u8 = new Uint8Array(m.bytes);
      const info = F.readInit(u8);
      if (info) { tr.init = u8; tr.info = info; return; }
      for (const g of F.readSegments(u8, tr.info)) {
        const start = g.start + m.offset, end = g.end + m.offset;
        // Nạp lại cùng đoạn (tua, đổi chất lượng): thay mẩu cũ cùng mốc.
        tr.segs = tr.segs.filter((x) => Math.abs(x.start - start) > 0.01);
        tr.segs.push({ start, end, bytes: g.byteEnd > g.byteStart ? u8.subarray(g.byteStart, g.byteEnd) : u8 });
      }
      tr.segs.sort((a, b) => a.start - b.start);
    } else if (m.type === 'close') s.closed = true;
  });

  // Track âm thanh của một nguồn: track có init và nhiều mẩu nhất (thường chỉ một).
  const trackOf = (s) => [...s.tracks.values()].filter((t) => t.init).sort((a, b) => b.segs.length - a.segs.length)[0] || null;
  // Phần đã nạp liền nhau quanh [a, b]: trả các mẩu phủ nó, hay null nếu còn hở (sai số 0,05 s giữa hai mẩu).
  function cover(tr, a, b) {
    const segs = tr.segs.filter((x) => x.end > a && x.start < b);
    if (!segs.length || segs[0].start > a + 0.05) return null;
    for (let i = 1; i < segs.length; i++) if (segs[i].start > segs[i - 1].end + 0.05) return null;
    return segs.at(-1).end >= b - 0.05 ? segs : null;
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

  // Gửi đoạn k của nguồn s nếu âm thanh đã nạp đủ. dur: thời lượng video (Infinity nếu chưa biết).
  function trySend(s, k, dur) {
    if (s.sent.has(k)) return false;
    const tr = trackOf(s);
    if (!tr) return false;
    const from = startOf(k), to = Math.min(startOf(k + 1), dur);
    if (!(to > from)) return false;
    const a = Math.max(0, from - PRE), b = Math.min(to + POST, isFinite(dur) ? dur - 0.1 : to + POST);
    const segs = cover(tr, a, b);
    if (!segs) return false;
    // Mẩu một lần nạp có thể chứa nhiều đoạn thời gian: gộp theo mảng byte, giữ thứ tự.
    const parts = [tr.init];
    for (const x of segs) if (parts.at(-1) !== x.bytes) parts.push(x.bytes);
    const audioStart = Math.round(segs[0].start * 1000) / 1000;
    s.sent.set(k, 'pending');
    const payload = {
      id: s.id, aac: toBase64(parts), fmt: 'fmp4', from: Math.round(from * 1000) / 1000, to: Math.round(to * 1000) / 1000, audioStart,
      ...(k > 0 && s.sent.get(k - 1) === 'ok' ? { prev: [startOf(k - 1), from] } : {}),
      target: settings.target || 'vi', lyrics: settings.lyrics !== false, desc: document.title || '', hashtags: [],
    };
    chrome.runtime.sendMessage({ type: 'subtitles', key: s.id + ':' + k, server: settings.server, payload }).then((r) => {
      if (!r || r.status === 'error' || r.status === 'cancelled') { s.sent.delete(k); s.fails = (s.fails || 0) + 1; note = 'lỗi: ' + ((r && r.error) || 'không có phản hồi'); if (s.fails >= 3) s.sent.set(k, 'error'); return; }
      s.fails = 0;
      s.sent.set(k, r.status === 'ok' ? 'ok' : 'skipped');
      if (r.status === 'ok' && Array.isArray(r.cues)) {
        if (r.target && r.target !== (settings.target || 'vi')) return;
        // Câu vắt qua ranh giới có thể ra ở cả hai đoạn (thử TikTok 7/11: hai bản dịch của cùng một câu): dòng mới chiếm quá nửa
        // thời gian của một dòng đã có thì bỏ.
        const dup = (c) => s.cues.some((x) => { const o = Math.min(x.end, c.end) - Math.max(x.start, c.start); return o > 0.5 * Math.max(0.1, Math.min(x.end - x.start, c.end - c.start)); });
        for (const c of r.cues) if (!dup(c)) s.cues.push({ start: c.start, end: c.end, text: (c.sung ? '♪ ' : '') + (c.vi || c.zh || '') });
        s.cues.sort((x, y) => x.start - y.start);
      }
    }).catch(() => { s.sent.delete(k); });
    return true;
  }

  // Lớp sub: đặt trên khung video đang xem.
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;pointer-events:none;display:flex;flex-direction:column;align-items:center;justify-content:flex-end';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .line { max-width: 92%; text-align: center; font: 600 20px/1.35 system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.6); padding: 3px 10px; border-radius: 6px; white-space: pre-wrap; }
    .badge { font: 11px/1.4 system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.45); padding: 1px 6px; border-radius: 4px; margin-top: 4px; }
  </style><span class="line" hidden></span><span class="badge"></span>`;
  const lineEl = root.querySelector('.line'), badge = root.querySelector('.badge');
  let note = 'chờ video…';
  const place = () => { const fe = document.fullscreenElement; (fe && fe.tagName !== 'VIDEO' ? fe : document.documentElement).appendChild(host); };
  document.addEventListener('fullscreenchange', place);

  setInterval(() => {
    if (settings.enabled === false) { host.remove(); return; }
    if (!document.documentElement) return;
    if (!host.isConnected) place();
    const v = mainVideo();
    if (!v) { host.style.display = 'none'; return; }
    const r = v.getBoundingClientRect();
    Object.assign(host.style, { display: 'flex', left: Math.max(0, r.left) + 'px', width: Math.min(r.width, innerWidth) + 'px', top: Math.max(0, r.top) + 'px',
      height: Math.max(40, Math.min(r.bottom, innerHeight) - Math.max(0, r.top) - Math.min(r.height * 0.12, 90)) + 'px' });
    const [, s] = sourceOf(v);
    if (v.mediaKeys) note = 'video có mã hoá: không dịch được';
    else if (!s) note = (v.currentSrc || '').startsWith('blob:') ? 'chưa thấy âm thanh của video này' : 'trang không nạp kiểu Media Source: dùng "Dịch âm thanh tab"';
    else {
      const dur = isFinite(v.duration) ? v.duration : Infinity, t = v.currentTime;
      let inflight = [...sources.values()].reduce((n, x) => n + [...x.sent.values()].filter((y) => y === 'pending').length, 0);
      // Video đang xem: đoạn chứa chỗ đang xem trước, rồi tới AHEAD giây phía trước.
      for (let k = indexAt(t); startOf(k) < Math.min(dur, t + AHEAD) && inflight < MAX_INFLIGHT; k++) if (trySend(s, k, dur)) inflight++;
      // Video tải sẵn trong feed (chưa xem): đoạn đầu, để lướt sang là có sub ngay.
      for (const [, x] of sources) if (x !== s && inflight < MAX_INFLIGHT + 1 && !x.closed && Date.now() - x.seen < 60000 && trySend(x, 0, Infinity)) inflight++;
      const k = indexAt(t), st = s.sent.get(k);
      note = st === 'ok' || st === 'skipped' ? 'đọc trước' : st === 'pending' ? 'đang dịch…' : st === 'error' ? note : 'chờ trình phát nạp âm thanh…';
      // Bỏ mẩu đã xem xa phía sau (giữ bộ nhớ nhỏ).
      const tr = trackOf(s);
      if (tr && tr.segs.length > 40) tr.segs = tr.segs.filter((x) => x.end > t - 30);
    }
    const c = s && s.cues.filter((x) => x.start <= v.currentTime && v.currentTime < Math.max(x.end, x.start + 1.2)).at(-1);
    if (c) { lineEl.textContent = c.text; lineEl.hidden = false; } else lineEl.hidden = true;
    badge.textContent = 'TOD · ' + note;
    // Nguồn cũ không còn thẻ video nào phát, quá 2 phút: bỏ.
    for (const [ms, x] of sources) if (x !== s && Date.now() - x.seen > 120000) sources.delete(ms);
  }, 200);
})();

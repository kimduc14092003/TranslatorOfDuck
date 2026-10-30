// Content script (ISOLATED) trên www.douyin.com — bản Alpha.
// 1. Nhận metadata video từ tap.main.js (JSON feed của chính trang).
// 2. Lấy đoạn đầu video đang xem và 2 video kế tiếp qua /aweme/v1/play/ (đường đã đo ở S1),
//    gửi qua service worker tới server trên máy bạn để tạo sub.
// 3. Vẽ sub đè lên video theo thời gian phát (docs/PLAN.md §8).
(() => {
  'use strict';
  const UP = '__tod_alpha_up';
  const DOWN = '__tod_alpha_down';
  const PREFETCH = 2;            // số video kế tiếp được dịch sẵn
  const MAX_SECONDS = 60;        // bản Alpha chỉ dịch 60 giây đầu mỗi video

  let settings = { enabled: true, server: 'http://127.0.0.1:8787', position: 'bottom', size: 'm', delay: 0 };
  const items = new Map();       // id -> metadata
  const order = [];              // thứ tự video theo feed
  const results = new Map();     // id -> { status, cues, error, seconds }
  const queued = new Set();
  const queue = [];
  let downloading = false;
  let currentId = null;

  const alive = () => { try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; } };

  // ---------------------------------------------------------------- metadata từ trang
  function onItems(list) {
    for (const d of list) {
      if (!d || !d.id || d.id === 'undefined') continue;
      const prev = items.get(d.id);
      if (!prev || (d.gears.length + d.audio.length) > (prev.gears.length + prev.audio.length)) items.set(d.id, d);
      if (!prev) order.push(d.id);
    }
    schedule();
  }
  window.addEventListener(UP, (ev) => {
    let msg;
    try { msg = JSON.parse(ev.detail); } catch (_) { return; }
    if (msg.type === 'items') onItems(msg.data);
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
  function schedule() {
    if (!settings.enabled || !currentId) return;
    const i = order.indexOf(currentId);
    const targets = [currentId, ...(i >= 0 ? order.slice(i + 1, i + 1 + PREFETCH) : [])];
    targets.forEach((id, k) => {
      const d = items.get(id);
      if (!d || d.kind !== 'video' || !d.playUri || /^https?:/.test(d.playUri)) return;
      const prev = results.get(id);
      if (queued.has(id) || (prev && !(prev.status === 'error' && Date.now() - (prev.at || 0) > 20000))) return;
      queued.add(id);
      if (k === 0) queue.unshift(id); else queue.push(id); // video đang xem luôn đi trước
    });
    pump();
  }
  async function rangeFetch(url, end) {
    const res = await fetch(url, { headers: { Range: 'bytes=0-' + end }, credentials: 'omit', cache: 'no-store' });
    if (res.status !== 206 && res.status !== 200) throw new Error('tải video: HTTP ' + res.status);
    const total = Number(((res.headers.get('content-range') || '').match(/\/(\d+)$/) || [])[1]) || null;
    return { buf: await res.arrayBuffer(), total };
  }
  // Cuối phần "mục lục" (moov) nằm ở đầu file faststart (§5.6b). Video dài có moov vài MB,
  // nên phải cộng phần này vào ước lượng, không thì chỉ lấy được nửa số giây cần.
  function headerEnd(buf) {
    const dv = new DataView(buf);
    let off = 0;
    while (off + 8 <= buf.byteLength) {
      let size = dv.getUint32(off);
      const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7));
      if (size === 1 && off + 16 <= buf.byteLength) size = Number(dv.getBigUint64(off + 8));
      if (type === 'mdat') return null;          // mục lục ở cuối file: chưa hỗ trợ
      if (type === 'moov') return off + size;
      if (size < 8) return null;
      off += size;
    }
    return null;
  }
  // Ước lượng số byte chứa MAX_SECONDS giây đầu rồi tải một lần.
  async function downloadHead(d) {
    const url = 'https://www.douyin.com/aweme/v1/play/?video_id=' + encodeURIComponent(d.playUri);
    const probe = await rangeFetch(url, 65535);
    const durS = d.durationMs ? d.durationMs / 1000 : null;
    const head = headerEnd(probe.buf);
    if (probe.total && head == null) throw new Error('video không có mục lục ở đầu file (chưa hỗ trợ)');
    let end = (head || 0) + 6 * 1024 * 1024 - 1;
    if (probe.total && durS) end = Math.min(probe.total - 1, head + Math.ceil((probe.total - head) * Math.min(1, (MAX_SECONDS + 5) / durS)) + 524288);
    if (probe.total && end <= 65535) return probe.buf;
    return (await rangeFetch(url, end)).buf;
  }
  function toBase64(buf) {
    const u8 = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function pump() {
    if (downloading) return;
    downloading = true;
    try {
      while (queue.length && alive() && settings.enabled) {
        const id = queue.shift();
        const d = items.get(id);
        results.set(id, { status: 'pending' });
        let b64;
        try { b64 = toBase64(await downloadHead(d)); } catch (e) {
          results.set(id, { status: 'error', error: e.message, at: Date.now() });
          queued.delete(id);
          continue;
        }
        // Không chờ server xong mới tải video tiếp theo.
        chrome.runtime.sendMessage({ type: 'subtitles', server: settings.server, payload: { id, desc: d.desc, hashtags: d.hashtags, durationMs: d.durationMs, b64 } })
          .then((r) => results.set(id, r && r.status ? { ...r, at: Date.now() } : { status: 'error', error: (r && r.error) || 'không có phản hồi', at: Date.now() }))
          .catch((e) => results.set(id, { status: 'error', error: e.message, at: Date.now() }))
          .finally(() => queued.delete(id));
      }
    } finally { downloading = false; }
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
  const SKIP_WHY = { no_speech: 'không nghe thấy lời', too_short: 'quá ít lời', not_zh: 'không phải tiếng Trung', singing: 'bài hát', untranslated: 'dịch lỗi' };
  function cueAt(cues, t) {
    for (const c of cues) { if (t >= c.start && t < c.end) return c; if (c.start > t) break; }
    return null;
  }
  let act = null;
  let lastFind = 0;
  let toastText = '';
  let toastUntil = 0;
  const fmtDelay = (d) => (d > 0 ? '+' : '') + d.toFixed(1) + ' s';
  // Phím [ và ]: sub hiện sớm hơn / muộn hơn 0,1 s (lưu lại cho mọi video).
  window.addEventListener('keydown', (e) => {
    if (e.key !== '[' && e.key !== ']') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const d = Math.round(((Number(settings.delay) || 0) + (e.key === ']' ? 0.1 : -0.1)) * 10) / 10;
    settings.delay = Math.max(-2, Math.min(2, d));
    if (alive()) chrome.storage.local.get('settings', (s) => chrome.storage.local.set({ settings: { ...(s.settings || {}), delay: settings.delay } }));
    toastText = 'VI · lệch sub ' + fmtDelay(settings.delay) + (settings.delay > 0 ? ' (muộn hơn)' : settings.delay < 0 ? ' (sớm hơn)' : '');
    toastUntil = performance.now() + 1500;
  }, true);
  function frame(now) {
    if (!alive()) return;
    requestAnimationFrame(frame);
    if (!lastFind || now - lastFind > 250) {   // dò video đang xem 4 lần/giây là đủ; vẽ sub thì mỗi khung hình
      lastFind = now;
      act = findActive();
      if (act && act.id !== currentId) { currentId = act.id; schedule(); }
    }
    const v = settings.enabled && act ? videoFor(act) : null;
    if (!v) { host.style.width = '0'; subEl.style.display = 'none'; badgeEl.style.display = 'none'; return; }
    attachHost();
    const r = v.getBoundingClientRect();
    host.style.left = r.left + 'px'; host.style.top = r.top + 'px'; host.style.width = r.width + 'px'; host.style.height = r.height + 'px';
    const res = results.get(currentId);
    const st = res ? res.status : (items.has(currentId) ? 'pending' : null);
    if (now < toastUntil) {
      badgeDot.style.background = BADGE.ok[0];
      badgeTxt.textContent = toastText;
      badgeEl.style.display = 'block';
    } else if (st && BADGE[st]) {
      badgeDot.style.background = BADGE[st][0];
      badgeTxt.textContent = st === 'error' ? BADGE.error[1] + ': ' + String(res.error || '').slice(0, 60)
        : st === 'skipped' ? 'VI · ' + (SKIP_WHY[res.label] || 'bỏ qua') + (res.seconds != null ? ` (${Math.round(res.seconds)} s đầu)` : '')
        : BADGE[st][1];
      badgeEl.style.display = 'block';
    } else badgeEl.style.display = 'none';
    const c = res && res.status === 'ok' ? cueAt(res.cues, v.currentTime - (Number(settings.delay) || 0)) : null;
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
    if (area === 'local' && ch.settings) { settings = { ...settings, ...(ch.settings.newValue || {}) }; schedule(); }
  });
  chrome.runtime.onMessage.addListener((msg, _s, reply) => {
    if (msg && msg.type === 'status') {
      const counts = {};
      for (const r of results.values()) counts[r.status] = (counts[r.status] || 0) + 1;
      reply({ seen: items.size, counts, current: currentId ? (results.get(currentId) || { status: 'chưa có' }).status : null });
    }
  });
})();

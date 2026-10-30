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
  const PREFETCH = 2;            // số video kế tiếp được dịch sẵn đoạn đầu
  const LOOKAHEAD = 30;          // luôn dịch trước chỗ đang xem bấy nhiêu giây
  const FIRST = 20, STEP = 30;   // đoạn đầu ngắn để sub đầu ra nhanh, sau đó mỗi đoạn 30 s
  const SINGLE_MAX = 75;         // video ngắn hơn thế thì dịch một lần
  const PRE = 1.5, POST = 6;     // âm thanh gửi dư hai đầu để câu vắt qua ranh giới không bị cắt

  let settings = { enabled: true, server: 'http://127.0.0.1:8787', position: 'bottom', size: 'm', delay: 0 };
  const items = new Map();       // id -> metadata
  const order = [];              // thứ tự video theo feed
  const vids = new Map();        // id -> { plan, media, url, total, chunks: Map k -> kết quả, cues }
  let queue = [];
  let downloading = false;
  let currentId = null;
  let playhead = 0;              // video.currentTime của video đang xem

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
  const vid = (id) => { let v = vids.get(id); if (!v) { v = { chunks: new Map(), cues: [] }; vids.set(id, v); } return v; };
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
    return !c || (c.status === 'error' && Date.now() - (c.at || 0) > 20000);
  }
  function schedule() {
    if (!settings.enabled || !currentId) return;
    const want = [];
    const plan = planFor(currentId);
    if (plan) plan.forEach(([a, b], k) => { if (b > playhead && a < playhead + LOOKAHEAD) want.push([currentId, k]); });
    else want.push([currentId, 0]);
    const i = order.indexOf(currentId);
    for (const id of i >= 0 ? order.slice(i + 1, i + 1 + PREFETCH) : []) want.push([id, 0]);
    queue = want.filter(([id, k]) => eligible(items.get(id)) && needsWork(id, k));
    pump();
  }
  async function rangeFetch(url, a, b) {
    const res = await fetch(url, { headers: { Range: `bytes=${a}-${b}` }, credentials: 'omit', cache: 'no-store' });
    if (res.status !== 206 && res.status !== 200) throw new Error('tải video: HTTP ' + res.status);
    const total = Number(((res.headers.get('content-range') || '').match(/\/(\d+)$/) || [])[1]) || null;
    let buf = await res.arrayBuffer();
    if (res.status === 200 && a > 0) buf = buf.slice(a, b + 1);   // máy chủ bỏ qua Range
    return { buf, total, url: res.url };
  }
  // Mục lục (moov) của video: tải một lần, giữ lại cho các đoạn sau.
  async function ensureMedia(id) {
    const v = vid(id);
    if (v.media) return v.media;
    const api = 'https://www.douyin.com/aweme/v1/play/?video_id=' + encodeURIComponent(items.get(id).playUri);
    const probe = await rangeFetch(api, 0, 65535);
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
  async function fetchBytes(v, a, b) {
    for (const url of v.url === v.api ? [v.api] : [v.url, v.api]) {   // link CDN đã chuyển hướng hết hạn thì quay về /aweme/v1/play/
      try {
        const r = await rangeFetch(url, a, b);
        if (v.total && r.total && r.total !== v.total) throw new Error('file video đã đổi');
        if (r.url) v.url = r.url;
        return r.buf;
      } catch (e) { if (url === v.api) throw e; }
    }
  }
  function toBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  // Gộp sub các đoạn đã xong. Câu ở đầu đoạn sau mà bắt đầu trước khi người nói dứt câu cuối của đoạn trước
  // là phần lặp (nghe dư ở ranh giới) thì bỏ; dòng trước kéo dài sang đoạn sau thì cắt cho khỏi chồng.
  function mergeCues(v) {
    const out = [];
    for (const k of [...v.chunks.keys()].sort((a, b) => a - b)) {
      const c = v.chunks.get(k);
      if (c.status !== 'ok') continue;
      for (const cue of c.cues) {
        const last = out[out.length - 1];
        if (last && cue.start < (last.se || last.end) - 0.1) continue;
        if (last && cue.start < last.end) last.end = Math.max(last.se || last.start, cue.start - 2 / 30);
        out.push({ ...cue });
      }
    }
    v.cues = out;
  }
  async function runChunk(id, k) {
    const v = vid(id);
    const d = items.get(id);
    const done = (r) => { v.chunks.set(k, { ...r, at: Date.now() }); mergeCues(v); };
    v.chunks.set(k, { status: 'pending' });
    try {
      const media = await ensureMedia(id);
      const plan = planFor(id);
      if (!plan[k]) { v.chunks.delete(k); return; }
      const [from, to] = plan[k];
      const w = TodMp4.window(media, Math.max(0, from - PRE), to + POST);
      if (!w) return done({ status: 'no_audio', from, to });
      const aac = w.build(await fetchBytes(v, w.start, w.end - 1));
      // Không chờ server xong mới tải đoạn tiếp theo.
      chrome.runtime.sendMessage({ type: 'subtitles', server: settings.server, payload: {
        id, desc: d.desc, hashtags: d.hashtags, durationMs: d.durationMs, from, to, audioStart: Math.round(w.startTime * 1000) / 1000,
        prev: k > 0 ? plan[k - 1] : null, aac: toBase64(aac) } })
        .then((r) => done(r && r.status ? { ...r, from, to } : { status: 'error', error: (r && r.error) || 'không có phản hồi', from, to }))
        .catch((e) => done({ status: 'error', error: e.message, from, to }));
    } catch (e) {
      done({ status: 'error', error: e.message });
    }
  }
  async function pump() {
    if (downloading) return;
    downloading = true;
    try {
      while (queue.length && alive() && settings.enabled) {
        const [id, k] = queue.shift();
        if (needsWork(id, k)) await runChunk(id, k);
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
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const SKIP_WHY = { no_speech: 'không nghe thấy lời', too_short: 'quá ít lời', not_zh: 'không phải tiếng Trung', singing: 'bài hát', untranslated: 'dịch lỗi' };
  function cueAt(cues, t) {
    for (const c of cues) { if (t >= c.start && t < c.end) return c; if (c.start > t) break; }
    return null;
  }
  let act = null;
  let lastFind = 0;
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
      if (act && act.id !== currentId) currentId = act.id;
      const pv = settings.enabled && act ? videoFor(act) : null;
      playhead = pv ? pv.currentTime : 0;
      schedule();                              // theo chỗ đang xem: tua tới đâu dịch tới đó
    }
    const v = settings.enabled && act ? videoFor(act) : null;
    if (!v) { host.style.width = '0'; subEl.style.display = 'none'; badgeEl.style.display = 'none'; return; }
    attachHost();
    const r = v.getBoundingClientRect();
    host.style.left = r.left + 'px'; host.style.top = r.top + 'px'; host.style.width = r.width + 'px'; host.style.height = r.height + 'px';
    playhead = v.currentTime;
    const cv = vids.get(currentId);
    const plan = cv && cv.plan;
    const res = cv && (plan ? cv.chunks.get(chunkAt(plan, playhead)) : cv.chunks.get(0));
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
    const c = cv ? cueAt(cv.cues, playhead - (Number(settings.delay) || 0)) : null;
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

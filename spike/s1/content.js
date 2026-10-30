// Content script (ISOLATED world) trên www.douyin.com.
// Nhận metadata từ tap.main.js, theo dõi video đang xem, chạy phép thử tải A0/A2,
// và cộng dồn số liệu vào chrome.storage.local. Báo cáo không chứa URL đầy đủ,
// ID video thật, cookie hay nội dung video; ID chỉ lưu dạng băm.
(() => {
  'use strict';
  const UP = '__tod_s1_up';
  const DOWN = '__tod_s1_down';
  const KEY = 's1_report';
  const scan = globalThis.__todS1Mp4Scan;
  const RANGE_BYTES = 262144;       // 256 KB đầu file là đủ để thấy moov nếu file faststart
  const MAX_TEST_ITEMS = 40;        // số video tối đa được tải thử mỗi lần tải trang
  const COMPARE_ITEMS = 8;          // vài video đầu: thử mọi nguồn bằng cả A0 và A2 để so sánh
  const CAP = 300;

  const items = new Map();          // id -> { d, firstSeen, sources:Set }
  let report = null;
  let dirty = false;

  // ---------------- tiện ích ----------------
  function fnv(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  }
  const hostOf = (u) => { try { return new URL(u).hostname; } catch (_) { return 'invalid'; } };
  const bump = (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; };
  const pushCap = (arr, v) => { arr.push(v); if (arr.length > CAP) arr.shift(); };
  function log(type, data) {
    pushCap(report.log, { t: Date.now(), type, ...data });
    if (report.log.length > 150) report.log.splice(0, report.log.length - 150);
    dirty = true;
  }
  function expiryMinutes(u) {
    try {
      const url = new URL(u);
      const q = url.searchParams.get('x-expires') || url.searchParams.get('expires');
      let sec = q ? Number(q) : NaN;
      if (!isFinite(sec)) {
        const seg = url.pathname.split('/').filter(Boolean);
        const hex = seg.find((s, i) => i > 0 && /^[0-9a-f]{8}$/i.test(s));
        if (hex) sec = parseInt(hex, 16);
      }
      if (!isFinite(sec)) return null;
      const min = (sec * 1000 - Date.now()) / 60000;
      return min > -1440 && min < 10080 ? Math.round(min) : null;
    } catch (_) { return null; }
  }

  function newReport() {
    return {
      version: 2, createdAt: Date.now(), updatedAt: Date.now(),
      env: {}, pageLoads: 0, hookModes: {},
      endpoints: {}, unknownPaths: {}, parseErrors: 0,
      ssr: { pages: 0, renderData: 0, renderDataItems: 0, paceF: 0, paceFAwemeHits: 0 },
      t1: { probes: 0, withPlayer: 0, paths: {}, shapes: [] },
      hook: { checks: 0, fetchReplaced: 0, openReplaced: 0 },
      items: { unique: 0, bySource: {}, byKind: {}, withAudioOnly: 0, withMp4Gear: 0, withPktOffsetMap: 0,
        encrypted: 0, isSubtitled: 0, hasOcr: 0, musicOriginal: 0, gearsPerItem: [], minGearKB: [],
        durationsS: [], fps: {}, formats: {}, h265Gears: 0, gearsTotal: 0, mediaHosts: {} },
      active: { changes: 0, how: {}, section: {}, withDescAtActivate: 0, plays: 0, withDescAtPlay: 0, noDescAtPlay: 0,
        bySourceAtPlay: {}, leadBeforePlayMs: [], videoTagsOnPage: [], noIdFound: 0 },
      downloads: { requests: 0, itemsTested: 0, a0: {}, a2: {}, a2c: {}, byCandidate: {}, tHeadMs: { a0: [], a2: [], a2c: [] },
        tTotalMs: { a0: [], a2: [], a2c: [] }, faststart: {}, hasMp4a: {}, codecs: {}, hasElst: 0, firstBox: {},
        hosts: {}, finalHosts: {}, redirected: 0, sizeMatch: { match: 0, mismatch: 0, unknown: 0 },
        expiryMin: [], primaryOk: 0, primaryFail: 0 },
      captcha: { appearances: 0 },
      log: [],
    };
  }

  // ---------------- nhận dữ liệu từ MAIN world ----------------
  function onItems(list) {
    for (const d of list) {
      if (!d || !d.id || d.id === 'undefined') continue;
      const prev = items.get(d.id);
      if (prev) {
        if (!prev.sources.has(d.source)) { prev.sources.add(d.source); bump(report.items.bySource, d.source); }
        const richer = (d.gears.length + d.audio.length) > (prev.d.gears.length + prev.d.audio.length);
        if (richer) prev.d = d;
        continue;
      }
      items.set(d.id, { d, firstSeen: Date.now(), sources: new Set([d.source]) });
      const s = report.items;
      s.unique++;
      bump(s.bySource, d.source);
      bump(s.byKind, d.kind);
      if (d.audio.some(a => a.urls.length)) s.withAudioOnly++;
      const mp4 = d.gears.filter(g => g.urls.length && (!g.format || g.format === 'mp4'));
      if (mp4.length) s.withMp4Gear++;
      if (d.gears.some(g => g.pktOffsetMap)) s.withPktOffsetMap++;
      if (d.encrypted) s.encrypted++;
      if (d.isSubtitled) s.isSubtitled++;
      if (d.hasOcrContent) s.hasOcr++;
      if (d.musicIsOriginal) s.musicOriginal++;
      pushCap(s.gearsPerItem, d.gears.length);
      const sizes = mp4.map(g => Number(g.size)).filter(x => x > 0);
      if (sizes.length) pushCap(s.minGearKB, Math.round(Math.min(...sizes) / 1024));
      if (d.durationMs) pushCap(s.durationsS, Math.round(d.durationMs / 1000));
      for (const g of d.gears) {
        s.gearsTotal++;
        if (g.h265) s.h265Gears++;
        if (g.fps) bump(s.fps, String(g.fps));
        bump(s.formats, String(g.format));
      }
      const hosts = new Set([...d.playUrls, ...d.gears.flatMap(g => g.urls), ...d.audio.flatMap(a => a.urls)].map(hostOf));
      for (const h of hosts) bump(s.mediaHosts, h);
    }
    dirty = true;
    maybeQueueActiveTest();
  }

  function onUp(msg) {
    const { type, data } = msg;
    if (type === 'items') onItems(data);
    else if (type === 'endpoint') {
      const k = data.path + ' [' + data.via + ']';
      const e = report.endpoints[k] || (report.endpoints[k] = { calls: 0, items: 0, nonJson: 0, known: data.known });
      e.calls++; e.items += data.items || 0; if (data.nonJson || data.responseType) e.nonJson++;
      if (!data.known) bump(report.unknownPaths, data.path);
    } else if (type === 'parse_error') { report.parseErrors++; log('parse_error', { path: data.path, via: data.via }); }
    else if (type === 'ssr') {
      const s = report.ssr; s.pages++;
      if (data.renderData) s.renderData++;
      s.renderDataItems += data.renderDataItems || 0;
      if (data.paceF) s.paceF++;
      s.paceFAwemeHits += data.paceFAwemeHits || 0;
      log('ssr', data);
    } else if (type === 't1_probe') {
      report.t1.probes++;
      if (data.hasPlayer) report.t1.withPlayer++;
      for (const p of data.paths) bump(report.t1.paths, p);
    } else if (type === 't1_shape') {
      if (report.t1.shapes.length < 3) report.t1.shapes.push(data);
    } else if (type === 'hook_check') {
      report.hook.checks++;
      if (!data.fetchIsOurs) report.hook.fetchReplaced++;
      if (!data.openIsOurs) report.hook.openReplaced++;
    } else if (type === 'a2_result') {
      const p = pendingA2.get(data.reqId);
      if (p) {
        pendingA2.delete(data.reqId);
        if (data.b64) {
          const bin = atob(data.b64);
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          data.scan = scan(u8);
        }
        delete data.b64;
        p(data);
      }
    }
    dirty = true;
  }

  // ---------------- video đang xem ----------------
  let currentId = null;
  let lostActive = false;

  function findActive() {
    const u = new URL(location.href);
    const modal = u.searchParams.get('modal_id');
    if (modal) return { id: modal, how: 'modal_id' };
    const m = u.pathname.match(/^\/(video|note)\/(\d+)/);
    if (m) return { id: m[2], how: m[1] };
    const el = document.querySelector('[data-e2e="feed-active-video"]');
    if (el) {
      const inner = el.getAttribute('data-e2e-vid') ? el : el.querySelector('[data-e2e-vid]');
      if (inner) return { id: inner.getAttribute('data-e2e-vid'), how: 'feed-active-video', el };
    }
    const c = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    const cand = c && c.closest && c.closest('[data-e2e-vid]');
    if (cand) return { id: cand.getAttribute('data-e2e-vid'), how: 'center-data-e2e-vid', el: cand };
    return null;
  }
  // Khu vực đang lướt: đoạn đầu của path + tên các tham số (không lấy giá trị).
  function sectionOf() {
    const u = new URL(location.href);
    const seg = u.pathname.split('/').filter(Boolean)[0] || 'root';
    const keys = [...u.searchParams.keys()].filter(k => k !== 'modal_id').sort();
    return seg.replace(/^\d+$/, ':id') + (keys.length ? '?' + keys.join('&') : '');
  }
  function videoFor(active) {
    if (active.el) { const v = active.el.querySelector('video'); if (v) return v; }
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const a = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      if (a > area) { area = a; best = v; }
    }
    return best;
  }
  function onPlay(id) {
    const a = report.active;
    a.plays++;
    const it = items.get(id);
    if (it) {
      a.withDescAtPlay++;
      bump(a.bySourceAtPlay, [...it.sources][0]);
      pushCap(a.leadBeforePlayMs, Date.now() - it.firstSeen);
    } else {
      a.noDescAtPlay++;
      log('no_desc_at_play', { id: fnv(id) });
    }
    dirty = true;
  }
  function tick() {
    const act = findActive();
    if (!act) {
      if (!lostActive) { lostActive = true; report.active.noIdFound++; dirty = true; }
      return;
    }
    lostActive = false;
    if (act.id === currentId) return;
    currentId = act.id;
    const a = report.active;
    a.changes++;
    bump(a.how, act.how);
    bump(a.section, sectionOf());
    if (items.has(act.id)) a.withDescAtActivate++;
    pushCap(a.videoTagsOnPage, document.querySelectorAll('video').length);
    const v = videoFor(act);
    if (v) {
      const id = act.id;
      if (!v.paused && v.currentTime > 0) onPlay(id);
      else v.addEventListener('playing', () => { if (currentId === id) onPlay(id); }, { once: true });
    }
    dirty = true;
    maybeQueueActiveTest();
  }

  // ---------------- phép thử tải A0 / A2 ----------------
  const tested = new Set();
  const testQueue = [];
  let testing = false;
  let itemsTestedThisPage = 0;
  const pendingA2 = new Map();
  let reqSeq = 0;

  function candidatesOf(d) {
    const out = [];
    const audioUrl = d.audio.map(a => a.urls[0]).find(Boolean);
    if (audioUrl) out.push({ label: 'audio_only', url: audioUrl, size: (d.audio.find(a => a.urls[0] === audioUrl) || {}).size });
    const mp4 = d.gears.filter(g => g.urls.length && (!g.format || g.format === 'mp4'))
      .sort((x, y) => (Number(x.size) || Infinity) - (Number(y.size) || Infinity));
    if (mp4.length) out.push({ label: 'min_mp4_gear', url: mp4[0].urls[0], size: mp4[0].size });
    if (d.playUrls[0]) out.push({ label: 'play_addr', url: d.playUrls[0], size: null });
    if (d.playUri && !/^https?:/.test(d.playUri)) {
      out.push({ label: 'aweme_play_api', url: 'https://www.douyin.com/aweme/v1/play/?video_id=' + encodeURIComponent(d.playUri), size: null });
    }
    return out.filter(c => /^https:\/\//.test(c.url));
  }
  function maybeQueueActiveTest() {
    if (!currentId || tested.has(currentId) || itemsTestedThisPage >= MAX_TEST_ITEMS) return;
    const it = items.get(currentId);
    if (!it || it.d.kind !== 'video') return;
    tested.add(currentId);
    itemsTestedThisPage++;
    testQueue.push(it.d);
    runTests();
  }
  function a2(url, withCookies = false) {
    return new Promise((resolve) => {
      const reqId = ++reqSeq;
      pendingA2.set(reqId, resolve);
      setTimeout(() => { if (pendingA2.has(reqId)) { pendingA2.delete(reqId); resolve({ ok: false, error: 'no_answer' }); } }, 20000);
      window.dispatchEvent(new CustomEvent(DOWN, { detail: JSON.stringify({ type: 'a2', reqId, url, bytes: RANGE_BYTES, withCookies }) }));
    });
  }
  async function a0(url) {
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-' + (RANGE_BYTES - 1) }, credentials: 'omit', cache: 'no-store', signal: ctl.signal });
      const tHead = performance.now() - t0;
      const buf = new Uint8Array(await res.arrayBuffer());
      return { ok: res.ok, status: res.status, tHeadMs: Math.round(tHead), tTotalMs: Math.round(performance.now() - t0),
        contentType: res.headers.get('content-type'), contentRange: res.headers.get('content-range'),
        finalHost: hostOf(res.url), redirected: res.redirected, scan: scan(buf.subarray(0, Math.min(buf.length, RANGE_BYTES))) };
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network_or_cors',
        message: String(e && e.message).slice(0, 120), tTotalMs: Math.round(performance.now() - t0) };
    } finally { clearTimeout(timer); }
  }
  function record(method, cand, r) {
    const dl = report.downloads;
    dl.requests++;
    const outcome = r.ok ? 'ok_' + r.status : (r.error || 'http_' + r.status);
    bump(dl[method], outcome);
    const bc = dl.byCandidate[cand.label] || (dl.byCandidate[cand.label] = { a0: {}, a2: {}, a2c: {}, mp4a: {}, source: {} });
    bump(bc[method], outcome);
    if (cand.source) bump(bc.source, cand.source);
    if (r.ok && r.scan) bump(bc.mp4a, String(r.scan.hasMp4a));
    bump(dl.hosts, hostOf(cand.url));
    if (r.tHeadMs != null) pushCap(dl.tHeadMs[method], r.tHeadMs);
    if (r.tTotalMs != null && r.ok) pushCap(dl.tTotalMs[method], r.tTotalMs);
    if (r.finalHost) bump(dl.finalHosts, r.finalHost);
    if (r.redirected) dl.redirected++;
    const exp = expiryMinutes(cand.url);
    if (exp != null) pushCap(dl.expiryMin, exp);
    if (r.ok && r.scan) {
      bump(dl.faststart, String(r.scan.faststart));
      bump(dl.hasMp4a, String(r.scan.hasMp4a));
      bump(dl.codecs, String(r.scan.videoCodec));
      bump(dl.firstBox, String(r.scan.top[0]));
      if (r.scan.hasElst) dl.hasElst++;
      const m = r.contentRange && r.contentRange.match(/\/(\d+)$/);
      if (m && cand.size) {
        const total = Number(m[1]);
        if (Math.abs(total - Number(cand.size)) <= Math.max(1024, total * 0.01)) dl.sizeMatch.match++; else dl.sizeMatch.mismatch++;
      } else dl.sizeMatch.unknown++;
    }
    if (!r.ok) log('download_fail', { method, candidate: cand.label, host: hostOf(cand.url), outcome, contentType: r.contentType || null, message: r.message || null });
    dirty = true;
  }
  async function runTests() {
    if (testing) return;
    testing = true;
    try {
      while (testQueue.length) {
        const d = testQueue.shift();
        const cands = candidatesOf(d).map(c => ({ ...c, source: [...(items.get(d.id) || { sources: new Set() }).sources][0] || null }));
        if (!cands.length) { log('no_candidate', { id: fnv(d.id) }); continue; }
        report.downloads.itemsTested++;
        const compare = report.downloads.itemsTested <= COMPARE_ITEMS;
        let primaryOk = false;
        for (let i = 0; i < cands.length; i++) {
          if (!compare && i > 0) break;
          const c = cands[i];
          const r0 = await a0(c.url);
          record('a0', c, r0);
          let ok = r0.ok;
          if (compare || !r0.ok) {
            const r2 = await a2(c.url);
            record('a2', c, r2);
            ok = ok || r2.ok;
            // 403 khi không gửi cookie: thử lại một lần CÓ cookie để biết link có cần đăng nhập không.
            if (r2.status === 403) {
              const r3 = await a2(c.url, true);
              record('a2c', c, r3);
              ok = ok || r3.ok;
            }
          }
          if (i === 0) primaryOk = ok;
        }
        if (primaryOk) report.downloads.primaryOk++; else report.downloads.primaryFail++;
      }
    } finally { testing = false; }
  }

  // ---------------- captcha (heuristic) ----------------
  let captchaVisible = false;
  function checkCaptcha() {
    const el = document.querySelector('#captcha_container, [id^="captcha"], [class*="captcha_verify"], iframe[src*="captcha"], iframe[src*="verify"]');
    const vis = !!(el && el.getBoundingClientRect().width > 0);
    if (vis && !captchaVisible) { report.captcha.appearances++; log('captcha', {}); }
    captchaVisible = vis;
  }

  // ---------------- popup ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'getHook') {
      let v = 'on';
      try { v = localStorage.getItem('__tod_s1_hook') === 'off' ? 'off' : 'on'; } catch (_) { /* mặc định on */ }
      sendResponse({ hook: v });
    } else if (msg && msg.type === 'setHook') {
      try { localStorage.setItem('__tod_s1_hook', msg.on ? 'on' : 'off'); } catch (_) { /* bỏ qua */ }
      sendResponse({ ok: true });
    }
  });
  // Popup bấm "Xóa số liệu" thì bắt đầu lại từ đầu, kể cả ở tab đang mở.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY] && changes[KEY].newValue === undefined && report) {
      // Chỉ tính các lần tải trang SAU khi xóa, để số liệu có hook / không hook không bị lẫn.
      const env = report.env;
      report = newReport();
      report.env = env;
      dirty = false;
    }
  });

  // ---------------- khởi động ----------------
  function save() {
    if (!dirty || !report) return;
    dirty = false;
    report.updatedAt = Date.now();
    chrome.storage.local.set({ [KEY]: report });
  }
  chrome.storage.local.get(KEY, (res) => {
    report = (res && res[KEY] && res[KEY].version === 2) ? res[KEY] : newReport();
    const ua = navigator.userAgent;
    let hookMode = 'on';
    try { hookMode = localStorage.getItem('__tod_s1_hook') === 'off' ? 'off' : 'on'; } catch (_) { /* mặc định on */ }
    report.env = {
      userAgent: ua,
      cocCoc: /coc_coc_browser/i.test(ua),
      chromeMajor: (ua.match(/Chrome\/(\d+)/) || [])[1] || null,
      screen: innerWidth + 'x' + innerHeight,
      lastHookMode: hookMode,
    };
    report.pageLoads++;
    bump(report.hookModes, hookMode);
    dirty = true;
    window.addEventListener(UP, (ev) => {
      try { onUp(JSON.parse(ev.detail)); } catch (_) { /* bỏ qua tin hỏng */ }
    });
    window.dispatchEvent(new CustomEvent(DOWN, { detail: JSON.stringify({ type: 'ready' }) }));
    setInterval(tick, 300);
    setInterval(checkCaptcha, 2000);
    setInterval(save, 3000);
    addEventListener('pagehide', save);
  });
})();

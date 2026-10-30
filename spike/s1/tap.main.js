// Chạy trong MAIN world của www.douyin.com lúc document_start.
// Chỉ ĐỌC response JSON mà trang tự tải (tầng T0), JSON nhúng sẵn trong HTML (T0-SSR)
// và state của player (T1). Không sửa request/response, không gọi mạng trừ phép thử A2.
(() => {
  'use strict';
  if (window.__todS1Installed) return;
  window.__todS1Installed = true;

  const UP = '__tod_s1_up';
  const DOWN = '__tod_s1_down';
  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  let hookOn = true;
  try { hookOn = localStorage.getItem('__tod_s1_hook') !== 'off'; } catch (_) { /* giữ mặc định */ }

  // ---- kênh gửi sang content script (ISOLATED); xếp hàng tới khi bên kia sẵn sàng ----
  let ready = false;
  const queue = [];
  function emit(type, data) {
    const msg = JSON.stringify({ type, data, t: Date.now() });
    if (!ready) { if (queue.length < 500) queue.push(msg); return; }
    window.dispatchEvent(new CustomEvent(UP, { detail: msg }));
  }

  // ---- endpoint feed/detail mà trang tự gọi (theo WhiteSevs, OpenBiliClaw, dtk) ----
  const PATHS = [
    '/aweme/v1/web/tab/feed', '/aweme/v2/web/module/feed', '/aweme/v1/web/module/feed',
    '/aweme/v1/web/aweme/related', '/aweme/v1/web/aweme/detail', '/aweme/v1/web/aweme/post',
    '/aweme/v1/web/general/search/single', '/aweme/v1/web/search/item', '/aweme/v1/web/mix/aweme',
    '/aweme/v1/web/follow/feed', '/aweme/v1/web/familiar/feed', '/aweme/v1/web/channel/feed',
  ];
  function classify(rawUrl) {
    let u;
    try { u = new URL(rawUrl, location.href); } catch (_) { return null; }
    if (u.hostname !== location.hostname) return null;
    const p = u.pathname;
    if (!p.startsWith('/aweme/') || p.startsWith('/aweme/v1/play')) return null;
    const known = PATHS.find(x => p.startsWith(x));
    return { path: known || p.replace(/\/\d+/g, '/:n'), known: !!known };
  }

  // ---- nhận dạng item theo hình dạng JSON (snake_case hoặc camelCase) ----
  const urlsOf = (pa) => {
    if (!pa) return [];
    if (Array.isArray(pa.url_list)) return pa.url_list;
    if (Array.isArray(pa.urlList)) return pa.urlList;
    if (Array.isArray(pa)) return pa.map(x => (x && (x.src || x.url)) || x).filter(x => typeof x === 'string');
    return [];
  };
  function describe(aw, source) {
    const v = aw.video || {};
    const gearsRaw = v.bit_rate || v.bitRateList || [];
    const gears = (Array.isArray(gearsRaw) ? gearsRaw : []).slice(0, 12).map(g => {
      const pa = g.play_addr || g.playAddr;
      let urls = urlsOf(pa);
      if (!urls.length && typeof g.playApi === 'string') urls = [g.playApi];
      return {
        gear: g.gear_name || g.gearName || null,
        format: g.format || null,
        h265: g.is_h265 != null ? !!g.is_h265 : (g.isH265 != null ? !!g.isH265 : null),
        size: (pa && (pa.data_size || pa.dataSize)) || g.dataSize || g.data_size || null,
        bitrate: g.bit_rate || g.bitRate || null,
        fps: g.FPS || g.fps || null,
        pktOffsetMap: !!(g.pktOffsetMap || g.pkt_offset_map),
        urls: urls.slice(0, 3),
      };
    });
    const audioRaw = v.bit_rate_audio || v.bitRateAudioList || [];
    const audio = (Array.isArray(audioRaw) ? audioRaw : []).slice(0, 6).map(a => {
      const m = a.audio_meta || a.audioMeta || {};
      const ul = m.url_list || m.urlList || {};
      const urls = [ul.main_url || ul.mainUrl, ul.backup_url || ul.backupUrl, ul.fallback_url || ul.fallbackUrl]
        .filter(x => typeof x === 'string');
      return { size: m.size || null, bitrate: m.bitrate || null, format: m.format || null, urls };
    });
    const pa = v.play_addr || v.playAddr;
    const images = aw.images || aw.image_post_info || aw.imageInfos;
    const kind = (Array.isArray(images) ? images.length > 0 : !!images) ? 'image'
      : (aw.is_ads || aw.raw_ad_data || aw.isAds) ? 'ad'
      : (aw.room || aw.live_room || aw.cell_room) ? 'live' : 'video';
    return {
      id: String(aw.aweme_id || aw.awemeId),
      source,
      kind,
      awemeType: aw.aweme_type != null ? aw.aweme_type : (aw.awemeType != null ? aw.awemeType : null),
      durationMs: aw.duration || v.duration || null,
      playUri: (pa && (pa.uri || pa.uri_id)) || v.uri || null,
      playUrls: urlsOf(pa).slice(0, 3),
      gears,
      audio,
      isSubtitled: aw.is_subtitled != null ? aw.is_subtitled : null,
      hasOcrContent: !!(aw.seo_info && aw.seo_info.ocr_content),
      musicIsOriginal: aw.music ? (aw.music.is_original != null ? !!aw.music.is_original : (aw.music.isOriginal != null ? !!aw.music.isOriginal : null)) : null,
      encrypted: !!(v.enca || v.encv || (v.play_addr && v.play_addr.encrypt)),
      // Chỉ dùng làm ngữ cảnh cho bộ mẫu S3 (lưu trên máy người dùng), không vào báo cáo S1.
      desc: typeof aw.desc === 'string' ? aw.desc.slice(0, 300) : null,
      hashtags: Array.isArray(aw.text_extra) ? aw.text_extra.map(t => t && t.hashtag_name).filter(Boolean).slice(0, 10) : [],
    };
  }
  function walk(node, out, source, depth) {
    if (!node || typeof node !== 'object' || depth > 9 || out.length >= 120) return;
    if (Array.isArray(node)) { for (const x of node) walk(x, out, source, depth + 1); return; }
    const id = node.aweme_id || node.awemeId;
    const v = node.video;
    if (id && v && typeof v === 'object' &&
        (v.play_addr || v.playAddr || v.bit_rate || v.bitRateList || v.bit_rate_audio)) {
      out.push(describe(node, source));
      return;
    }
    for (const k in node) {
      const x = node[k];
      if (x && typeof x === 'object') walk(x, out, source, depth + 1);
    }
  }
  function handleJson(data, info, via) {
    const items = [];
    walk(data, items, via, 0);
    emit('endpoint', { path: info.path, known: info.known, via, items: items.length });
    if (items.length) emit('items', items);
  }

  // ---- T0: bọc fetch/XHR, chỉ đọc. Cài một lần, không bao giờ gán lại. ----
  let wrappedFetch = null;
  let wrappedOpen = null;
  if (hookOn) {
    wrappedFetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        const info = classify(url);
        if (info) {
          p.then(res => {
            try {
              const ct = (res.headers.get('content-type') || '').toLowerCase();
              if (!ct.includes('json')) { emit('endpoint', { path: info.path, known: info.known, via: 'fetch', items: 0, nonJson: true }); return; }
              res.clone().json().then(d => handleJson(d, info, 'fetch'), () => emit('parse_error', { path: info.path, via: 'fetch' }));
            } catch (_) { /* không làm hỏng trang */ }
          }, () => {});
        }
      } catch (_) { /* không làm hỏng trang */ }
      return p;
    };
    window.fetch = wrappedFetch;

    wrappedOpen = function (method, url) {
      try { this.__todS1Url = String(url); } catch (_) { /* bỏ qua */ }
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open = wrappedOpen;
    XMLHttpRequest.prototype.send = function () {
      try {
        const info = this.__todS1Url ? classify(this.__todS1Url) : null;
        if (info) {
          const xhr = this;
          xhr.addEventListener('load', () => {
            try {
              const rt = xhr.responseType;
              let data = null;
              if (rt === '' || rt === 'text') data = JSON.parse(xhr.responseText);
              else if (rt === 'json') data = xhr.response;
              else { emit('endpoint', { path: info.path, known: info.known, via: 'xhr', items: 0, responseType: rt }); return; }
              handleJson(data, info, 'xhr');
            } catch (_) { emit('parse_error', { path: info.path, via: 'xhr' }); }
          });
        }
      } catch (_) { /* không làm hỏng trang */ }
      return origSend.apply(this, arguments);
    };
  }

  // ---- T0-SSR: JSON nhúng trong HTML ----
  function probeSsr() {
    const res = { renderData: false, renderDataItems: 0, paceF: false, paceFChunks: 0, paceFAwemeHits: 0 };
    try {
      const el = document.getElementById('RENDER_DATA');
      if (el && el.textContent) {
        res.renderData = true;
        const items = [];
        walk(JSON.parse(decodeURIComponent(el.textContent)), items, 'ssr', 0);
        res.renderDataItems = items.length;
        if (items.length) emit('items', items);
      }
    } catch (_) { res.renderDataError = true; }
    try {
      const pf = self.__pace_f;
      if (Array.isArray(pf)) {
        res.paceF = true;
        res.paceFChunks = pf.length;
        for (const chunk of pf) {
          const s = Array.isArray(chunk) ? chunk.find(x => typeof x === 'string') : null;
          if (s) res.paceFAwemeHits += (s.match(/"aweme_?[iI]d"/g) || []).length;
        }
      }
    } catch (_) { /* bỏ qua */ }
    emit('ssr', res);
  }
  document.addEventListener('DOMContentLoaded', probeSsr, { once: true });

  // ---- T1: state của player + kiểm tra hook còn là của ta không ----
  const t1Seen = new Set();
  setInterval(() => {
    try {
      const pl = window.player;
      const found = [];
      if (pl && pl.config) {
        if (pl.config.awemeInfo) found.push(['player.config.awemeInfo', pl.config.awemeInfo]);
        const pc = pl.config.pluginsConfig;
        if (pc && typeof pc === 'object') {
          for (const k of Object.keys(pc)) {
            if (pc[k] && pc[k].awemeInfo) found.push(['player.config.pluginsConfig.' + k + '.awemeInfo', pc[k].awemeInfo]);
          }
        }
      }
      emit('t1_probe', { hasPlayer: !!pl, paths: found.map(f => f[0]) });
      for (const [path, aw] of found) {
        const id = aw && (aw.awemeId || aw.aweme_id);
        if (id && !t1Seen.has(String(id))) {
          t1Seen.add(String(id));
          const items = [];
          walk(aw, items, 'player', 0);
          if (items.length) emit('items', items);
          else emit('t1_shape', { path, keys: Object.keys(aw).slice(0, 40), videoKeys: aw.video ? Object.keys(aw.video).slice(0, 40) : [] });
        }
      }
      if (hookOn) {
        emit('hook_check', {
          fetchIsOurs: window.fetch === wrappedFetch,
          openIsOurs: XMLHttpRequest.prototype.open === wrappedOpen,
        });
      }
    } catch (_) { /* bỏ qua */ }
  }, 2000);

  // ---- A2: tải thử từ MAIN world bằng fetch gốc (không qua wrapper của trang) ----
  window.addEventListener(DOWN, (ev) => {
    let req;
    try { req = JSON.parse(ev.detail); } catch (_) { return; }
    if (req.type === 'ready') {
      ready = true;
      emit('hello', { hookOn });
      while (queue.length) window.dispatchEvent(new CustomEvent(UP, { detail: queue.shift() }));
      return;
    }
    if (req.type !== 'a2' || typeof req.url !== 'string' || !/^https:\/\//.test(req.url)) return;
    const t0 = performance.now();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    origFetch.call(window, req.url, { headers: { Range: 'bytes=0-' + (req.bytes - 1) }, credentials: req.withCookies ? 'include' : 'omit', signal: ctl.signal })
      .then(async (res) => {
        const tHead = performance.now() - t0;
        const buf = new Uint8Array(await res.arrayBuffer()).subarray(0, req.bytes);
        clearTimeout(timer);
        // Byte gửi về content script dạng base64 để quét cấu trúc MP4 ở đó.
        let b64 = '';
        for (let i = 0; i < buf.length; i += 0x8000) b64 += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        emit('a2_result', {
          b64: res.ok ? btoa(b64) : null,
          reqId: req.reqId, ok: res.ok, status: res.status, tHeadMs: Math.round(tHead),
          tTotalMs: Math.round(performance.now() - t0),
          contentType: res.headers.get('content-type'), contentRange: res.headers.get('content-range'),
          finalHost: (() => { try { return new URL(res.url).hostname; } catch (_) { return null; } })(),
          redirected: res.redirected,
        });
      })
      .catch((e) => {
        clearTimeout(timer);
        emit('a2_result', { reqId: req.reqId, ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network_or_cors',
          message: String(e && e.message).slice(0, 120), tTotalMs: Math.round(performance.now() - t0) });
      });
  });
})();

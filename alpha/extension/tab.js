// Lớp sub của đường dự phòng (trang bất kỳ): background.js tiêm file này (cùng tablive.js) vào tab người xem bật trong popup.
// Nhận dòng sub (tin 'tab-cues') và trạng thái ('tab-state') từ background.
// Trang có video: mỗi dòng gắn vào giờ video lúc câu đó được nghe (ghi giờ video mỗi 100 ms), hiện theo giờ video + độ trễ. Tạm
// dừng thì sub dừng theo; tua đi thì dòng cũ không chen vào; tua lại chỗ đã dịch thì dòng hiện đúng lúc nói (không trễ). Trước
// đây (6/11) sub theo đồng hồ máy: tua video thì vẫn hiện nốt dòng của đoạn cũ. Không có video (trang chỉ có tiếng, video trong
// iframe): theo đồng hồ máy như cũ.
(() => {
  if (globalThis.__todTab) return;
  globalThis.__todTab = true;
  const L = globalThis.TodLive;
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:0;right:0;bottom:8%;z-index:2147483647;pointer-events:none;display:flex;justify-content:center';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    .box { max-width: 82vw; text-align: center; font: 600 22px/1.35 system-ui, sans-serif; color: #fff; }
    .line { background: rgba(0,0,0,.6); padding: 3px 10px; border-radius: 6px; display: inline-block; white-space: pre-wrap; }
    .badge { font: 12px/1.4 system-ui, sans-serif; color: #fff; background: rgba(0,0,0,.5); padding: 1px 6px; border-radius: 4px; margin-top: 4px; display: inline-block; }
  </style><div class="box"><div><span class="line" hidden></span></div><div><span class="badge"></span></div></div>`;
  const lineEl = root.querySelector('.line'), badge = root.querySelector('.badge');
  const place = () => {
    const fe = document.fullscreenElement;
    // Trình phát toàn màn hình là một phần tử (không phải chính thẻ video): đặt lớp sub vào trong nó để vẫn thấy.
    (fe && fe.tagName !== 'VIDEO' ? fe : document.documentElement).appendChild(host);
  };
  place();
  document.addEventListener('fullscreenchange', place);

  // Video chính: thẻ video lớn nhất đang hiện, có thời lượng.
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const mainVideo = () => [...document.querySelectorAll('video')].filter((v) => v.duration > 0 && area(v) > 0).sort((a, b) => area(b) - area(a))[0] || null;
  let video = null;
  const samples = [];   // [{ w, vt, playing, rate }]: giờ video theo đồng hồ máy, 2 phút gần nhất
  // Tua: mọi dòng đã có hiện đúng lúc nói (lag 0). Dòng nói trước điểm tua thì không hiện lại; trước đây chỉ bỏ trễ cho dòng sau
  // điểm tua, dòng nói ở 0:13 vẫn hiện lại ở 0:21 sau khi tua về 0:20 (thử thật 6/11).
  const onSeeking = () => { for (const c of vcues) c.lag = 0; };
  const watch = (v) => {
    if (video === v) return;
    if (video) video.removeEventListener('seeking', onSeeking);
    video = v;
    if (video) video.addEventListener('seeking', onSeeking);
  };

  let wcues = [], vcues = [], delay = 6000, note = 'đang nghe…';
  const showBadge = () => { badge.textContent = `TOD · trễ ${(delay / 1000).toFixed(1)} s · ${note}`; };
  showBadge();
  const timer = setInterval(() => {
    watch(mainVideo());
    const w = Date.now();
    if (video) {
      samples.push({ w, vt: video.currentTime, playing: !video.paused && !video.seeking, rate: video.playbackRate || 1 });
      while (samples.length && samples[0].w < w - 120000) samples.shift();
    }
    const c = (video && L.current(vcues, video.currentTime * 1000)) || L.current(wcues, w - delay);
    if (c) { lineEl.textContent = c.text; lineEl.hidden = false; } else lineEl.hidden = true;
    if (wcues.length > 300) wcues = wcues.slice(-200);
    if (vcues.length > 600) vcues = vcues.slice(-400);
  }, 100);

  const onMsg = (msg) => {
    if (!msg) return;
    if (msg.type === 'tab-cues' && Array.isArray(msg.cues)) {
      const now = Date.now();
      for (const c of msg.cues) {
        const text = (c.sung ? '♪ ' : '') + (c.vi || c.zh || '');
        const at = msg.wall0 + c.start * 1000, until = msg.wall0 + c.end * 1000;
        const vt = video ? L.videoTimeAt(samples, at) : null;
        if (vt != null) {
          const vs = vt * 1000, ve = vs + (until - at);
          // Đã có dòng chiếm phần lớn khoảng giờ video đó (tua lại rồi nghe lại, lần nhận dạng sau có thể ra chữ hơi khác): giữ dòng cũ.
          if (vcues.some((x) => L.overlaps(x, vs, ve))) continue;
          // Trễ tính theo giờ video: dòng về lúc video đã chạy tới đâu so với lúc câu được nói.
          delay = L.nextDelay(delay, vs, video.currentTime * 1000);
          vcues.push({ at: vs, until: ve, lag: delay, text });
        } else {
          delay = L.nextDelay(delay, at, now);
          wcues.push({ at, until, text });
        }
      }
      vcues.sort((a, b) => a.at - b.at);
      wcues.sort((a, b) => a.at - b.at);
      note = 'đang dịch';
      showBadge();
    } else if (msg.type === 'tab-state') {
      if (msg.on === false) {
        clearInterval(timer);
        watch(null);
        chrome.runtime.onMessage.removeListener(onMsg);
        document.removeEventListener('fullscreenchange', place);
        host.remove();
        globalThis.__todTab = false;
        return;
      }
      if (msg.error) { note = 'lỗi: ' + msg.error; showBadge(); }
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);
})();

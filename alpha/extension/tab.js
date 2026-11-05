// Lớp sub của đường dự phòng (trang bất kỳ): background.js tiêm file này (cùng tablive.js) vào tab người xem bật trong popup.
// Nhận dòng sub (tin 'tab-cues') và trạng thái ('tab-state') từ background, hiện dòng ở lúc người nói + độ trễ.
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
  let cues = [], delay = 6000, note = 'đang nghe…';
  const showBadge = () => { badge.textContent = `TOD · trễ ${(delay / 1000).toFixed(1)} s · ${note}`; };
  showBadge();
  const timer = setInterval(() => {
    const c = L.current(cues, Date.now() - delay);
    if (c) { lineEl.textContent = c.text; lineEl.hidden = false; } else lineEl.hidden = true;
    const cut = Date.now() - delay - 60000;
    if (cues.length > 200) cues = cues.filter((x) => x.until > cut);
  }, 100);
  const onMsg = (msg) => {
    if (!msg) return;
    if (msg.type === 'tab-cues' && Array.isArray(msg.cues)) {
      const now = Date.now();
      for (const c of msg.cues) {
        const at = msg.wall0 + c.start * 1000;
        delay = L.nextDelay(delay, at, now);
        cues.push({ at, until: msg.wall0 + c.end * 1000, text: (c.sung ? '♪ ' : '') + (c.vi || c.zh || '') });
      }
      cues.sort((a, b) => a.at - b.at);
      note = 'đang dịch';
      showBadge();
    } else if (msg.type === 'tab-state') {
      if (msg.on === false) {
        clearInterval(timer);
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

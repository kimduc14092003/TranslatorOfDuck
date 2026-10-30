'use strict';
const $ = (id) => document.getElementById(id);
const DEFAULTS = { enabled: true, server: 'http://127.0.0.1:8787', position: 'bottom', size: 'm', delay: 0 };

async function load() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}
async function save(patch) {
  const s = { ...(await load()), ...patch };
  await chrome.storage.local.set({ settings: s });
  return s;
}
async function checkServer() {
  const s = await load();
  $('health').className = 'muted';
  $('health').textContent = 'Đang kiểm tra…';
  try {
    const r = await fetch(s.server.replace(/\/+$/, '') + '/health');
    const h = await r.json();
    const ok = h.ok && h.mt;
    $('health').className = ok ? 'ok' : 'bad';
    $('health').textContent = ok
      ? `Server chạy. Nhận dạng: ${h.asr === 'funasr' ? 'Fun-ASR' : 'Gemini'}, dịch: Gemini.`
      : 'Server chạy nhưng thiếu GEMINI_API_KEY trong alpha/server/.env.';
  } catch (_) {
    $('health').className = 'bad';
    $('health').textContent = 'Không kết nối được. Mở PowerShell trong alpha\\server và chạy "npm start".';
  }
}
async function showStats() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const st = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
    const c = st.counts || {};
    $('stats').textContent = `Trang này: thấy ${st.seen} video; đã dịch ${c.ok || 0}, không có lời ${c.skipped || 0}, đang xử lý ${c.pending || 0}, lỗi ${c.error || 0} (${st.chunks || 0} đoạn).`;
  } catch (_) {
    $('stats').textContent = 'Mở một tab www.douyin.com để xem thống kê.';
  }
}

(async () => {
  const s = await load();
  $('enabled').checked = s.enabled;
  $('position').value = s.position;
  $('size').value = s.size;
  $('server').value = s.server;
  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('position').addEventListener('change', (e) => save({ position: e.target.value }));
  $('size').addEventListener('change', (e) => save({ size: e.target.value }));
  $('server').addEventListener('change', (e) => save({ server: e.target.value.trim() || DEFAULTS.server }));
  const showDelay = (d) => { $('delay').textContent = (d > 0 ? '+' : '') + d.toFixed(1) + ' s'; };
  showDelay(Number(s.delay) || 0);
  const nudge = async (step) => {
    const cur = Number((await load()).delay) || 0;
    const d = Math.max(-2, Math.min(2, Math.round((cur + step) * 10) / 10));
    await save({ delay: d });
    showDelay(d);
  };
  $('dminus').addEventListener('click', () => nudge(-0.1));
  $('dplus').addEventListener('click', () => nudge(0.1));
  $('check').addEventListener('click', checkServer);
  checkServer();
  showStats();
})();

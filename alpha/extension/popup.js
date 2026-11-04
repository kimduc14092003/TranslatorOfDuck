'use strict';
const $ = (id) => document.getElementById(id);
const DEFAULTS = { enabled: true, server: 'http://127.0.0.1:8787', position: 'bottom', size: 'm', delay: 0, lyrics: true, first10: true, target: 'vi' };

async function stored() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return settings;
}
async function load() {
  return { ...DEFAULTS, ...(await stored()) };
}
// Chỉ ghi cài đặt đã lưu cộng phần vừa đổi, không ghi giá trị mặc định: trước đây đổi một ô là ghi cả first10: true… vào
// storage, mặc định đổi sau này không tới được người xem (verifier 4/11, F16).
async function save(patch) {
  const s = { ...(await stored()), ...patch };
  await chrome.storage.local.set({ settings: s });
  return { ...DEFAULTS, ...s };
}
async function checkServer() {
  const s = await load();
  $('health').className = 'muted';
  $('health').textContent = 'Đang kiểm tra…';
  try {
    const r = await fetch(s.server.replace(/\/+$/, '') + '/health');
    const h = await r.json();
    const ok = h.ok && h.mt;
    // Fun-ASR hết hạn mức thì server tự chuyển sang model dự phòng (asrFallback); hết cả hai thì asrModel là null, nhận
    // dạng tạm dừng: hiện màu lỗi.
    const asrDown = h.asr === 'funasr' && h.asrModels && !h.asrModel;
    const asr = h.asr !== 'funasr' ? 'Gemini' : asrDown ? 'hết hạn mức' + (h.asrModels.length > 1 ? ' (cả model dự phòng)' : '')
      : h.asrFallback ? `${h.asrModel} (Fun-ASR hết hạn mức)` : 'Fun-ASR';
    const mt = h.mt === 'openai' ? 'OpenAI' : 'Gemini';
    // Không có DASHSCOPE_API_KEY lẫn GEMINI_API_KEY thì asr là null (chỉ có OPENAI_API_KEY): trước đây vẫn ghi "Gemini".
    $('health').className = ok && h.asr && !asrDown ? 'ok' : 'bad';
    $('health').textContent = !ok ? 'Server chạy nhưng thiếu OPENAI_API_KEY hoặc GEMINI_API_KEY trong alpha/server/.env.'
      : !h.asr ? `Server chạy nhưng chưa nhận dạng được giọng nói (sẽ không có sub): thiếu DASHSCOPE_API_KEY (Fun-ASR) hoặc GEMINI_API_KEY trong alpha/server/.env. Dịch: ${mt}.`
      : `Server chạy. Nhận dạng: ${asr}, dịch: ${mt}.`;
    // Server trước giai đoạn 1 không có targets: chỉ dịch tiếng Việt.
    const targets = Array.isArray(h.targets) ? h.targets : ['vi'];
    if (ok && h.asr && !targets.includes(s.target)) {
      $('health').className = 'bad';
      $('health').textContent += Array.isArray(h.targets) ? ` Server chưa dịch được sang ${s.target}.` : ' Server cũ chỉ dịch tiếng Việt: cập nhật alpha/server rồi chạy lại "npm start".';
    }
  } catch (_) {
    $('health').className = 'bad';
    // Server chạy cả trên Mac lẫn Windows (đang dùng trên Mac, HANDOFF §7): không chỉ nói PowerShell.
    $('health').textContent = 'Không kết nối được. Mở cửa sổ dòng lệnh (Terminal, PowerShell) trong thư mục alpha/server và chạy "npm start".';
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
  $('lyrics').checked = s.lyrics !== false;
  $('first10').checked = s.first10 !== false || !s.first10Set;
  $('target').value = ['vi', 'en'].includes(s.target) ? s.target : 'vi';
  $('position').value = s.position;
  $('size').value = s.size;
  $('server').value = s.server;
  $('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
  $('lyrics').addEventListener('change', (e) => save({ lyrics: e.target.checked }));
  // first10Set: chính người xem đã chọn (content.js: first10 false do popup cũ tự lưu thì không tính).
  $('first10').addEventListener('change', (e) => save({ first10: e.target.checked, first10Set: true }));
  $('target').addEventListener('change', async (e) => { await save({ target: e.target.value }); checkServer(); });
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

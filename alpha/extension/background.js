// Service worker: chuyển yêu cầu từ content script tới server trên máy bạn.
// Đi qua đây (không gọi thẳng từ trang Douyin) để không vướng CSP/CORS và giới hạn mạng cục bộ của trang.
// Yêu cầu nào content script huỷ (người xem đã tua đi chỗ khác) thì ngắt kết nối; server bỏ đoạn đó nếu chưa xử lý.
const pending = new Map();   // "tab:key" -> AbortController
// Bản của file này: phải bằng "version" trong manifest.json (dev/background-test.mjs kiểm). Content script hỏi { type: 'hello' }
// để biết service worker đang chạy có phải bản cũ không (Chrome có thể giữ background.js bản trước: content.js, workerReady)
// và có đọc được NDJSON không (ndjson: gửi stream: true được), có chuyển bản rút gọn sau không (condensed: gửi condenseLater: true
// được, từ 0.2.42).
const BUILD = '0.2.46';
// Đường dự phòng cho trang bất kỳ (bản thử): popup bật trên tab đang mở; offscreen.js thu âm thanh tab và gọi server, tab.js
// (tiêm vào tab) hiện sub. Background lấy mã luồng thu (tabCapture), mở trang ẩn, chuyển tin giữa trang ẩn và tab.
const inject = (tabId) => chrome.scripting.executeScript({ target: { tabId }, files: ['tablive.js', 'tab.js'] }).catch(() => {});
async function toOffscreen(m) {
  if (!(await chrome.offscreen.hasDocument())) return null;
  return chrome.runtime.sendMessage({ ...m, to: 'offscreen' }).catch(() => null);
}
async function tabStart(tabId) {
  // Gọi ngay trong lượt người xem bấm nút ở popup (quyền activeTab của tab đó).
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Thu âm thanh tab người xem bật để làm phụ đề' });
  }
  const [{ settings = {} }, tab] = await Promise.all([chrome.storage.local.get('settings'), chrome.tabs.get(tabId)]);
  await inject(tabId);
  const r = await chrome.runtime.sendMessage({ to: 'offscreen', type: 'start', streamId, tabId, settings, title: tab.title || '' });
  if (r && r.ok) await chrome.storage.session.set({ liveTab: tabId });
  return r || { ok: false, error: 'trang thu âm thanh không trả lời' };
}
// Tab đang thu tải lại trang hay sang trang khác cùng trang web: tiêm lại lớp sub (khác trang web thì Chrome không cho, bỏ qua).
chrome.tabs.onUpdated?.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  chrome.storage.session.get('liveTab').then(({ liveTab }) => { if (liveTab === tabId) inject(tabId); }).catch(() => {});
});
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const tab = sender.tab ? sender.tab.id : -1;
  if (msg && msg.type === 'hello') { reply({ build: BUILD, ndjson: true, condensed: true }); return false; }
  // Đường dự phòng: tin của offscreen.js (dòng sub, trạng thái) chuyển cho tab đang thu; popup bật, tắt, hỏi trạng thái.
  if (msg && msg.to === 'background' && !sender.tab) {
    if (msg.type === 'state' && msg.on === false) chrome.storage.session.remove('liveTab').catch(() => {});
    if (typeof msg.tabId === 'number') chrome.tabs.sendMessage(msg.tabId, { ...msg, type: 'tab-' + msg.type }).catch(() => {});
    return false;
  }
  if (msg && msg.type === 'tab-start' && !sender.tab) { tabStart(msg.tabId).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) })); return true; }
  if (msg && msg.type === 'tab-stop' && !sender.tab) { toOffscreen({ type: 'stop' }).then(() => reply({ ok: true })); return true; }
  if (msg && msg.type === 'tab-status' && !sender.tab) { toOffscreen({ type: 'status' }).then((st) => reply(st || { on: false })); return true; }
  if (msg && msg.type === 'cancel') {
    for (const k of msg.keys || []) { const c = pending.get(tab + ':' + k); if (c) c.abort(); }
    return false;
  }
  if (!msg || (msg.type !== 'subtitles' && msg.type !== 'bump' && msg.type !== 'warm')) return false;
  const base = String(msg.server || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    reply({ status: 'error', error: 'Bản Alpha chỉ gọi server trên máy (127.0.0.1 hoặc localhost).' });
    return false;
  }
  // Video được dịch sẵn vừa thành video đang xem: báo server làm đoạn đó trước.
  if (msg.type === 'bump') {
    fetch(base + '/v1/bump', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg.payload) }).catch(() => {});
    return false;
  }
  // Mở video chưa có kết quả: server làm nóng kết nối tới nhà cung cấp nhận dạng, dịch. Không chờ, bỏ qua mọi lỗi (server
  // cũ không có /v1/warm thì trả 404). Phải là application/json như /v1/bump: server chỉ nhận kiểu đó (rejectForeign),
  // thiếu thì trả 415 và không làm nóng gì.
  if (msg.type === 'warm') {
    fetch(base + '/v1/warm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    return false;
  }
  const pk = tab + ':' + msg.key;
  const ctl = new AbortController();
  pending.set(pk, ctl);
  // Trả lời một lần: sau dòng kết quả, kết nối còn mở chờ bản rút gọn; lỗi hay huỷ lúc đó không đổi câu trả lời đã gửi.
  let answered = false;
  const answer = (o) => { if (!answered) { answered = true; reply(o); } };
  fetch(base + '/v1/subtitles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg.payload), signal: ctl.signal })
    .then(async (res) => {
      // Server trả NDJSON (payload stream: true): các dòng { partial: [dòng…], target } (dòng dịch xong trước) chuyển ngay cho tab
      // qua tin { type: 'partial', key, cues, target } (target: ngôn ngữ đích, content.js bỏ dòng của ngôn ngữ cũ); dòng có status là kết quả: trả ngay cho tab như trước. Sau nó có thể còn một
      // dòng { condensed: [dòng…] } (rút gọn sau, payload condenseLater: true): chuyển qua tin { type: 'condensed', key, cues }.
      // Server cũ, hay kết quả có sẵn trong cache: JSON một lần.
      const result = (body) => answer(res.ok ? body : { ...body, status: 'error', error: body.error || 'HTTP ' + res.status });
      if (/ndjson/.test(res.headers.get('content-type') || '') && res.body) {
        const reader = res.body.getReader(), dec = new TextDecoder();
        let buf = '';
        const line = (s) => {
          let o;
          try { o = JSON.parse(s); } catch (_) { return; }
          if (o && Array.isArray(o.partial)) { if (tab >= 0) chrome.tabs.sendMessage(tab, { type: 'partial', key: msg.key, cues: o.partial, ...(typeof o.target === 'string' ? { target: o.target } : {}) }).catch(() => {}); }
          else if (o && Array.isArray(o.condensed)) { if (answered && tab >= 0) chrome.tabs.sendMessage(tab, { type: 'condensed', key: msg.key, cues: o.condensed, ...(typeof o.target === 'string' ? { target: o.target } : {}) }).catch(() => {}); }
          else result(o || {});
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (value) buf += dec.decode(value, { stream: true });
          for (let nl; (nl = buf.indexOf('\n')) >= 0; buf = buf.slice(nl + 1)) if (buf.slice(0, nl).trim()) line(buf.slice(0, nl));
          if (done) break;
        }
        if (buf.trim()) line(buf);
        // Hết mà không có dòng kết quả cuối (server ngắt giữa chừng): báo rõ, không trả {} (content sẽ chỉ báo "không có phản hồi").
        answer({ status: 'error', error: 'server ngắt giữa chừng (thiếu dòng kết quả cuối)' });
        return;
      }
      result(await res.json().catch(() => ({})));
    })
    .catch((e) => answer(e.name === 'AbortError' ? { status: 'cancelled' }
      : { status: 'error', error: 'không kết nối được server (đã chạy "npm start" trong alpha/server chưa?)' }))
    .finally(() => { if (pending.get(pk) === ctl) pending.delete(pk); });
  return true; // trả lời bất đồng bộ
});

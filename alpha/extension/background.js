// Service worker: chuyển yêu cầu từ content script tới server trên máy bạn.
// Đi qua đây (không gọi thẳng từ trang Douyin) để không vướng CSP/CORS và giới hạn mạng cục bộ của trang.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.type !== 'subtitles') return false;
  const base = String(msg.server || 'http://127.0.0.1:8787').replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    reply({ status: 'error', error: 'Bản Alpha chỉ gọi server trên máy (127.0.0.1 hoặc localhost).' });
    return false;
  }
  fetch(base + '/v1/subtitles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg.payload) })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      reply(res.ok ? body : { status: 'error', error: body.error || 'HTTP ' + res.status });
    })
    .catch(() => reply({ status: 'error', error: 'không kết nối được server (đã chạy "npm start" trong alpha/server chưa?)' }));
  return true; // trả lời bất đồng bộ
});

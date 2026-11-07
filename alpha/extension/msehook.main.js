// Bộ đọc chung (trang người xem đã bật trong popup), chạy trong thế giới của trang (MAIN) từ lúc trang bắt đầu tải: chép lại
// các mẩu âm thanh mà trình phát của trang tự nạp vào Media Source Extensions (SourceBuffer.appendBuffer). Không tải thêm gì,
// không đổi dữ liệu trình phát nạp. Đo 7/11 (alpha/dev/real/media-probe.mjs): TikTok, Instagram Reels, Vimeo, Douyin đều nạp âm
// thanh AAC thành SourceBuffer riêng, trước chỗ đang xem 6–40 s. Bản chép gửi cho web.js (thế giới riêng của extension) qua
// window.postMessage.
(() => {
  // Đã gắn rồi (tiêm hai lần): nhận ra bằng dấu trên chính hàm thay thế, không bằng cờ trên window mà trang tự đặt được (G01).
  const MS0 = window.MediaSource || window.ManagedMediaSource;
  if (MS0 && MS0.prototype.addSourceBuffer.__tod) return;
  const VIDEO_CODEC = /avc|hvc|hev|vp0?[89]|av01|mp4v/i;
  const AUDIO_CODEC = /mp4a|opus|vorbis|ac-3|ec-3|flac/i;
  // Âm thanh riêng: codecs chỉ có âm thanh (TikTok ghi kiểu "video/mp4;codecs=mp4a…"). Mẩu gộp hình + tiếng (huangguoai.com:
  // "video/mp4;codecs=mp4a.40.2,hvc1…") cũng chép, đánh dấu mux: web.js tách riêng phần âm thanh rồi bỏ phần hình ngay.
  const hasAudio = (mime) => AUDIO_CODEC.test(mime);
  let msN = 0, sbN = 0;
  const msId = new WeakMap(), msUrl = new WeakMap();
  const post = (m, transfer) => window.postMessage({ __todMse: 1, ...m }, '*', transfer || []);
  const cu = URL.createObjectURL;
  const isMs = (o) => (window.MediaSource && o instanceof window.MediaSource) || (window.ManagedMediaSource && o instanceof window.ManagedMediaSource);
  // Trang tạo blob: cho MediaSource trước khi thêm SourceBuffer: gắn mã ngay lúc này để web.js biết thẻ video nào phát nó.
  URL.createObjectURL = function (o) {
    const url = cu.call(this, o);
    if (isMs(o)) {
      if (!msId.has(o)) msId.set(o, ++msN);
      msUrl.set(o, url);
      post({ type: 'url', ms: msId.get(o), url });
    }
    return url;
  };
  for (const C of [window.MediaSource, window.ManagedMediaSource].filter(Boolean)) {
    const ctor = C;
    const add = ctor.prototype.addSourceBuffer;
    ctor.prototype.addSourceBuffer = function (mime) {
      const sb = add.call(this, mime);
      if (!msId.has(this)) msId.set(this, ++msN);
      if (!hasAudio(String(mime))) return sb;
      const ms = msId.get(this), id = ++sbN;
      post({ type: 'sb', ms, sb: id, mime: String(mime), mux: VIDEO_CODEC.test(String(mime)), url: msUrl.get(this) || null });
      const app = sb.appendBuffer;
      sb.appendBuffer = function (buf) {
        try {
          const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
          const copy = u8.slice().buffer;
          post({ type: 'data', ms, sb: id, offset: Number(sb.timestampOffset) || 0, bytes: copy }, [copy]);
        } catch (_) { /* không làm hỏng trình phát của trang */ }
        return app.call(this, buf);
      };
      this.addEventListener('sourceclose', () => post({ type: 'close', ms }), { once: true });
      return sb;
    };
    ctor.prototype.addSourceBuffer.__tod = true;
  }
})();

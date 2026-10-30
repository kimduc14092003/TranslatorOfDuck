# S1 spike: đo đạc trên Douyin thật

Extension này **chỉ đo**, không dịch gì cả. Nó trả lời ba câu hỏi quyết định plan
(xem `docs/PLAN.md` mục 5 và 14, các spike S1–S2):

1. Extension có đọc được JSON feed mà Douyin tự tải về, **trước khi** video phát không? (tầng T0, T0-SSR, T1)
2. Có tải được phần đầu file âm thanh/video từ CDN của Douyin không, bằng cách nào? (A0: từ content script; A2: từ trang, bằng fetch gốc)
3. Gắn hook vào trang có làm Douyin hiện captcha nhiều hơn không? (so sánh có hook và không hook)

## Cài đặt

**Chrome**
1. Tải thư mục `spike/s1` về máy (clone repo hoặc tải ZIP từ GitHub, nhánh `claude/busy-newton-1y8nzr`).
2. Mở `chrome://extensions`, bật **Developer mode** (góc trên bên phải).
3. Bấm **Load unpacked**, chọn thư mục `spike/s1`.
4. Ghim extension "TranslatorOfDuck S1 spike" lên thanh công cụ.

**Cốc Cốc:** làm giống hệt, nhưng mở `coccoc://extensions`.

## Cách đo (khoảng 30 phút)

Mỗi lượt đo dùng **một tab douyin.com duy nhất**.

**Lượt A: có hook (mặc định)**
1. Mở `https://www.douyin.com/`. Nếu bạn đang đăng nhập Douyin, mở popup của extension và tick "Tôi đang đăng nhập Douyin".
2. Trong popup bấm **Xóa số liệu**, rồi tải lại trang (F5).
3. Lướt feed 10–15 phút như bình thường: có video vuốt qua nhanh, có video xem hết. Mở thêm 2–3 video bằng link (`/video/...`).
4. Mở popup, bấm **Sao chép báo cáo** rồi dán vào chat cho mình (hoặc bấm **Lưu file báo cáo** và gửi file).

**Lượt B: đối chứng, không hook**
1. Trong popup bấm nút **Hook: BẬT → tắt để đo đối chứng**. Trang sẽ tự tải lại.
2. Bấm **Xóa số liệu**, rồi tải lại trang (F5).
3. Lướt feed 10–15 phút giống lượt A.
4. Sao chép báo cáo và gửi cho mình.
5. Bấm nút hook lần nữa để bật lại.

**Lượt C (nếu có Cốc Cốc):** lặp lại lượt A trên Cốc Cốc.

## Báo cáo chứa gì

- Có: số lượt gọi API feed bắt được, số video thấy được theo từng nguồn, tỉ lệ video có dữ liệu trước khi phát, kết quả tải thử (mã HTTP, thời gian, file có `moov` ở đầu không, có track âm thanh `mp4a` không), tên miền CDN, thời hạn link, số lần thấy captcha, phiên bản trình duyệt.
- Không có: URL đầy đủ, ID video (chỉ lưu dạng băm), cookie, nội dung video hay âm thanh, lịch sử xem.
- Extension không gửi gì đi đâu. Báo cáo nằm trong `chrome.storage` của trình duyệt bạn tới khi bạn tự sao chép.

## Lưu lượng mạng thêm

- Mỗi video được tải thử tối đa 256 KB đầu file, đúng như player của Douyin vẫn làm.
- Tối đa 40 video mỗi lần tải trang. 8 video đầu được thử mọi nguồn bằng cả hai cách để so sánh, nên tổng cộng tối đa khoảng 30 MB mỗi lần tải trang.
- Request đi với Origin/Referer của `www.douyin.com` và **không** gửi cookie (`credentials: 'omit'`).

## Hạn chế đã biết

- Phát hiện captcha chỉ dựa trên vài selector đoán trước, có thể sót.
- Đường dẫn state của player (T1) lấy từ code mã nguồn mở, có thể đã đổi.
- Nguồn `aweme_play_api` (`/aweme/v1/play/?video_id=...`) có thể hỏng vì phép thử không gửi cookie; điều đó cũng là một kết quả cần đo.
- Gỡ extension sau khi đo xong: `chrome://extensions` → Remove.

## Kiểm thử trên trang giả lập (cho dev)

```bash
node spike/s1/dev/mock_test.mjs
```

Cần Node 18+, `playwright` (có Chromium) và `ffmpeg`. Script dựng một server HTTPS cục bộ đóng vai `www.douyin.com` và CDN, trả JSON feed giả (fetch, XHR, `RENDER_DATA`, state của player) cùng file MP4 tạo bằng ffmpeg, rồi kiểm 15 điều kiện. Trong đó có: bắt được dữ liệu trước khi phát, A0/A2 tải được khi có CORS và báo lỗi khi không có CORS, nhận ra faststart, chế độ đối chứng không đụng vào `fetch` của trang, và báo cáo không lộ ID/URL.

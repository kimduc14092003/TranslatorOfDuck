# Bàn giao: TranslatorOfDuck (30/10/2026)

Ghi chú cho phiên Claude Code tiếp theo, chạy trên máy Mac của chủ dự án. Đọc hết file này trước khi làm. Kế hoạch đầy đủ ở `docs/PLAN.md`, phần "Tóm tắt nhanh" đọc trong 3 phút. Hướng dẫn chạy bản thử ở `alpha/README.md`.

## 1. Sản phẩm

Extension Chromium (Chrome, Cốc Cốc) hiện **sub tiếng Việt cho video Douyin web**.

- Sub phải khớp như sub người làm, không trễ.
- Cách làm: lấy âm thanh **trước** chỗ đang xem → nhận dạng giọng nói (ASR) → chia câu theo luật Netflix → dịch bằng AI → vẽ đè lên video theo `video.currentTime`.
- Sau này mở rộng: TikTok, trang bất kỳ, ngôn ngữ khác.
- Kinh doanh: bán gói thuê bao. Key API nằm trên server của chủ dự án, người dùng **không** tự đưa key (không BYOK).

## 2. Quy tắc phải giữ

- Chủ dự án nói tiếng Việt. Trả lời bằng tiếng Việt, ngắn gọn, dễ hiểu.
- **Key API:**
  - Không bao giờ yêu cầu dán key vào chat.
  - Key chỉ nằm trong `alpha/server/.env` và `spike/s3/.env` trên máy chủ dự án. Không đọc, không in, không commit file `.env`.
- **Video mẫu Douyin có bản quyền:** chỉ dùng trên máy để test, không đưa vào repo, không gửi đi đâu, xóa sau khi xong.
- **Git:**
  - Làm và push trên nhánh `claude/busy-newton-1y8nzr`.
  - Không tạo PR khi chưa được yêu cầu.
  - Không ghi tên hoặc mã model AI vào code, commit hay tài liệu trong repo.
- **Không làm** (PLAN §1):
  - tải hay lưu video cho người dùng;
  - server tự gọi API Douyin hoặc dùng cookie;
  - vượt anti-bot;
  - tự động lướt hay thu thập hàng loạt.
  - Test trên Douyin thật thì **chỉ vài video, lướt chậm như người thật**.
- **Quyết định đã chốt** (PLAN §15):
  - Chỉ dịch **lời nói**, bỏ qua tiếng hát.
  - Khi không chắc thì nghiêng về bỏ qua. Nhưng chủ dự án đã phàn nàn vlog nói nhiều bị bỏ, xem mục 6.

## 3. Đã đo được trên Douyin thật (S1, S3)

- **Dữ liệu video có sẵn trước khi phát:** hook đọc JSON feed của chính trang, ở MAIN world, `document_start`. Đọc được 47/47 video.
  - Endpoint: `/aweme/v1/web/tab/feed/` (推荐) và `/aweme/v2/web/module/feed/` (精选), đều qua XHR.
  - Trang tự bọc fetch/XHR đè lên hook của ta, nên **không bao giờ gán lại `fetch` hay XHR**.
- **Tải âm thanh:** chỉ đường `https://www.douyin.com/aweme/v1/play/?video_id=<play_addr.uri>` chạy được (24/24).
  - Gọi từ content script, có Range, `credentials: 'omit'`. Nó chuyển hướng sang CDN douyinvod hoặc zjcdn.
  - Link CDN trực tiếp, gear nhỏ nhất và `bit_rate_audio` đều trả **403** ở feed 推荐.
- **File video:** 16/16 có mục lục ở đầu file (faststart), âm thanh AAC (`mp4a`), có edit list. 16/16 bắt đầu bằng hộp `ftyp`.
- **ASR:** chọn **Fun-ASR Flash** (Alibaba DashScope, có mốc thời gian từng chữ). Gemini Flash-Lite làm dự phòng; mốc thời gian của nó kém.
- **Dịch:** Gemini Flash-Lite.
- **Tỉ lệ video có lời nói ở feed:** khoảng 26%. Còn lại là nhạc hoặc không lời.
- Kết quả chi tiết: PLAN §5.6b, §6.6b, `spike/s3/results/`.

## 4. Bản Alpha: những gì đang có (`alpha/`)

Chạy trên máy chủ dự án: một extension, cộng một server Node ở `127.0.0.1:8787` giữ key.

### Extension (`alpha/extension`, MV3, bản 0.2.0)

- **`tap.main.js`** (MAIN world): đọc JSON feed, gửi metadata sang content script qua sự kiện `__tod_alpha_up`.
- **`mp4audio.js`**: đọc bảng mẫu âm thanh trong moov, có tính edit list.
  - Tìm đúng byte của một khoảng thời gian, cắt riêng khung AAC thành ADTS.
  - Mốc thời gian cùng thước với `video.currentTime`.
- **`content.js`**:
  - Tìm video đang xem: `[data-e2e="feed-active-video"][data-e2e-vid]`, `?modal_id=`, `/video/{id}`.
  - **Chia đoạn:** video ≤ 75 s dịch một lần. Video dài hơn chia theo lưới cố định: [0,20), rồi mỗi 30 s.
  - **Dịch trước:** luôn dịch các đoạn nằm trong [chỗ đang xem, +30 s]; tua tới đâu dịch tới đó. 2 video kế tiếp được dịch sẵn đoạn đầu.
  - **Âm thanh gửi dư:** 1,5 s trước và 6 s sau mỗi đoạn.
  - **Vẽ sub:** shadow DOM, theo vòng `requestAnimationFrame`.
  - **Nhãn góc trên trái:** đang dịch / VI / bỏ qua + lý do / lỗi.
  - **Phím `[` / `]`:** chỉnh lệch sub ±0,1 s, lưu vào `chrome.storage` (`settings.delay`).
- **`background.js`**: chuyển yêu cầu tới server, chỉ cho phép 127.0.0.1 hoặc localhost.
- **`popup.*`**: bật/tắt, vị trí và cỡ sub, lệch sub, kiểm tra server, thống kê.

### Server (`alpha/server`)

- **`server.mjs`**: `POST /v1/subtitles` và `GET /health`.
  - Cache file theo từng đoạn: `work/cache/<id>.<from>-<to>.vi.<phiên bản>.json`, có trường `debug` gồm đặc trưng nói/hát và từng câu.
  - Mỗi đoạn có 2 dòng log: kết quả và "nghe được: …".
- **`pipeline.mjs`** (`PIPELINE_VERSION = 'alpha-4'`), lần lượt:
  1. ffmpeg chuyển sang mp3 16 kHz, có `aresample first_pts=0`.
  2. Fun-ASR.
  3. `windowAsr`: đổi mốc về thời gian video, chỉ giữ câu **bắt đầu** trong đoạn.
  4. `classifySpeech` và `splitSung`: lọc hát theo từng câu, trung vị > 0,33 s/chữ hoặc lời lặp.
  5. `segmentCues`: ≤ 7 s và ≤ 16 chữ Hán mỗi dòng.
  6. `translate`: kèm 3 dòng cuối của đoạn trước làm ngữ cảnh; rút gọn dòng quá dài.
- **Đổi logic thì tăng `PIPELINE_VERSION`** để bỏ kết quả cũ trong cache.

### Kiểm thử (đều chạy được không cần key)

| Lệnh | Kiểm tra gì |
|---|---|
| `cd alpha/server && npm test` | Chia câu, mốc thời gian, lọc hát, cắt đoạn, giữ độ lệch đầu track âm thanh (9 kiểm tra) |
| `node alpha/dev/mp4audio-test.mjs` | Cắt âm thanh từ mp4 thật do ffmpeg tạo, đúng mốc trong khoảng 15 ms (4 kiểm tra) |
| `node alpha/dev/e2e.mjs` | Chromium thật + extension + Douyin giả + AI giả + server thật, có video dài 100 s (15 kiểm tra) |

Cần cho các test: Node 18+, `playwright`, `ffmpeg`, `openssl`.

Mẹo Playwright:
- Muốn nạp extension thì dùng `chromium.launchPersistentContext(..., { channel: 'chromium', args: ['--load-extension=…', '--disable-extensions-except=…'] })`. Bản headless shell không nạp được extension.
- Route của Playwright không chặn được fetch của content script. Vì vậy e2e dùng server HTTPS giả kèm `--host-resolver-rules`.

## 5. Chưa kiểm chứng trên Douyin thật

Mọi thứ ở mục 4 mới chạy trên Douyin giả. Các điểm cần xem trên trang thật:

1. `mp4audio.js` có đọc được file thật không: moov lớn, `co64`, nhiều mục `stsc`, HE-AAC.
2. Dùng lại link CDN sau chuyển hướng (`res.url`) cho các đoạn sau có bị 403 không. Mã đã có đường lùi về `/aweme/v1/play/`.
3. **Sub có còn sớm hơn lời nói không.** Đã sửa một nguyên nhân (mất khoảng chênh khi track âm thanh bắt đầu muộn). Nhưng trình phát của Douyin (xgplayer, có thể dùng MSE) có thể đặt mốc khác. Đo bằng cách:
   - so với sub tiếng Trung in sẵn trên video;
   - hoặc hỏi chủ dự án mức chỉnh `[ ]` đã chọn, rồi đặt làm mặc định.
4. Trang video dài (ví dụ `/video/{id}`, có chương) có đúng thẻ `<video>` đang phát không. Trang có thể có thêm video xem trước khi rê chuột lên thanh tiến trình.

## 6. Vấn đề đang mở (ưu tiên cao nhất)

**Vlog nói nhiều nhưng không có sub.** Chưa có log nên chưa rõ nguyên nhân. Các khả năng:

- **a. Bộ lọc hát chấm nhầm từng câu.**
  - Với video nói, trung vị giây/chữ đo ở S3 là 0,14–0,24 cho **cả video**. Nhưng chấm **từng câu** thì câu nói chậm, kéo giọng có thể vượt 0,33.
  - Nếu quá nửa số câu bị coi là hát kèm nhãn `singing`, **cả đoạn** bị bỏ.
  - Kiểm bằng trường `debug.sentences[].medCharDur` và `sung` trong file cache của đoạn đó.
- **b. ASR không nghe ra lời** vì nhạc nền to. Khi đó nhãn ghi "không nghe thấy lời" hoặc "quá ít lời".
- **c. Lỗi tải hoặc đọc file.** Nhãn đỏ.

Cách làm đề xuất: tái hiện trên Douyin thật, xem nhãn, log và `debug`, rồi chỉnh theo dữ liệu. Có thể thêm nút "Dịch cả bài hát" trong popup để tạm tắt bộ lọc.

## 7. Việc tiếp theo trên Mac

1. **Kiểm tra môi trường:** `node -v` (cần 18+), `git status`, đang ở nhánh `claude/busy-newton-1y8nzr`. Có `alpha/server/.env` chưa (chỉ kiểm có file, không đọc nội dung).
2. **Cài đặt:**
   ```bash
   cd alpha/server && npm install
   npm i -D playwright
   npx playwright install chromium
   ```
   Cài `ffmpeg` qua Homebrew nếu cần.
3. **Chạy toàn bộ test** ở mục 4 để chắc môi trường đúng.
4. **Test trên Douyin thật:**
   - Chạy server ở chế độ nền.
   - Mở Chromium **có giao diện** (headed), profile cố định (ví dụ `~/.tod-profile`) để giữ đăng nhập, nạp `alpha/extension`.
   - Nếu Douyin đòi đăng nhập hay captcha, nhờ chủ dự án xử lý một lần.
   - Xem vài video ở 推荐, mỗi video vài chục giây. Tìm một vlog dài nhiều lời, xem vài phút, rồi tua tới giữa video.
   - Thu: nhãn và chữ sub (đọc shadow root của phần tử có `.sub`), log server, file cache, ảnh chụp.
5. **Sửa vấn đề ở mục 6**, rồi kiểm các điểm ở mục 5.
6. **Mỗi lần sửa:** chạy lại test, commit và push lên nhánh, báo chủ dự án ngắn gọn bằng tiếng Việt.

## 8. Để sau (chủ dự án nói "sau này tối ưu")

- Đo hiệu quả bước rút gọn dòng quá dài trên dữ liệu thật. Ở S3 có 44/99 dòng vượt 17 ký tự/giây.
- Thu thêm khoảng 100 mẫu có lời nói, kèm bản chép tay để đo tỉ lệ lỗi chữ (CER).
- Bộ phân loại nói/hát theo âm thanh (ví dụ SenseVoice) thay cho đặc trưng văn bản.
- Bỏ khoảng lặng và nhạc trước khi gửi ASR (VAD), vì Fun-ASR tính tiền theo giây.
- Bảng tên riêng và xưng hô theo cả video. Cache dùng chung giữa người dùng khi có server thật.

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
  - Chỉ dịch **lời nói**, bỏ qua tiếng hát. Từ 31/10 chủ dự án muốn dịch cả lời bài hát: có nút trong popup, mặc định bật, dòng hát hiện "♪" (§6j).
  - Khi không chắc thì nghiêng về bỏ qua. Nhưng chủ dự án đã phàn nàn vlog nói nhiều bị bỏ, xem mục 6. Từ 3/11: không mất câu. Không bỏ đoạn vì ít lời, không bỏ dòng vì còn chữ Hán; thà hiện dòng còn vài chữ gốc (§6ai, §6aj).

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
  - **Chia đoạn:** video ≤ 30 s dịch một lần (`SINGLE_MAX`). Video dài hơn chia theo lưới cố định: [0,20), rồi mỗi 30 s.
  - **Dịch trước:** luôn dịch các đoạn nằm trong [chỗ đang xem, +30 s]; tua tới đâu dịch tới đó. 4 video kế tiếp được dịch sẵn đoạn đầu (`PREFETCH`).
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
- **`pipeline.mjs`** (`PIPELINE_VERSION = 'alpha-8'`), lần lượt:
  1. ffmpeg chuyển sang mp3 16 kHz, có `aresample first_pts=0`.
  2. Fun-ASR; hết hạn mức thì tự chuyển sang `qwen-audio-3.1-asr-flash` (§6k).
  3. `windowAsr`: đổi mốc về thời gian video, chỉ giữ câu **bắt đầu** trong đoạn.
  4. `classifySpeech` và `splitSung`: lọc hát theo từng câu, trung vị > 0,33 s/chữ hoặc lời lặp. Trong đoạn cả bài, dòng có câu là câu nói nhanh (≥ 3 chữ Hán, ≤ 0,20 s/chữ) không phải lời hát; đủ điều kiện ở §6n.
  5. `segmentCues`: ≤ 7 s và ≤ 16 chữ Hán mỗi dòng.
  6. `translate`: kèm 3 dòng cuối của đoạn trước làm ngữ cảnh; rút gọn dòng quá dài.
- **Đổi logic thì tăng `PIPELINE_VERSION`** để bỏ kết quả cũ trong cache. Ngoại lệ có lý do ghi ở §6j và §6n: thay đổi nhỏ mà file cũ vẫn dùng được.

### Kiểm thử (đều chạy được không cần key)

| Lệnh | Kiểm tra gì |
|---|---|
| `cd alpha/server && npm test` | `test.mjs`: chia câu, mốc thời gian, lọc hát, cắt đoạn, giữ độ lệch đầu track âm thanh, câu vắt qua đầu đoạn khi vừa tua tới, đánh dấu dòng hát, tiếng đệm trong lời hát, dòng nói ngắn gộp vào dòng hát, câu nói nhanh trong đoạn cả bài, lời rất ngắn, toàn kana hay chữ Hàn vẫn là lời nói, dòng ít chữ bị ASR kéo dài, câu không dấu câu vắt qua đầu đoạn (23 kiểm tra). `queue-test.mjs`: hàng đợi khi tua liên tiếp (ưu tiên, huỷ, đẩy lên khi lướt tới ở cả hai chế độ lời bài hát, `rank`), Gemini hết lượt trong ngày (9 kiểm tra). `asr-fallback-test.mjs`: Fun-ASR hết hạn mức thì chuyển sang model dự phòng, giới hạn theo phút thì gọi lại (20 kiểm tra). `warm-test.mjs`: `/v1/warm` làm nóng đúng dịch vụ đang dùng, giãn 3 s, bỏ qua khi vừa có lệnh gọi thật, log thời gian kết nối (12 kiểm tra). `pronoun-test.mjs`: luật xưng hô trong câu lệnh, bảng xưng hô nhận vào và trả về, đọc bảng của đoạn trước từ cache, giới tính người đăng (21 kiểm tra). `openai-test.mjs`: dịch bằng OpenAI giả, mức suy luận, đoạn dịch sẵn và đoạn gấp bỏ rút gọn (7 kiểm tra). `stream-test.mjs`: dịch dạng stream (NDJSON: dòng xong trước rồi kết quả cuối; trả chậm mà đều không bị cắt; im trước chữ đầu thì gọi lại; cache và request thường trả JSON như cũ) (6 kiểm tra). `errors-test.mjs`: key dịch sai không chạy lại nhận dạng giọng nói, thiếu ffmpeg, file cache hỏng, Origin lạ, không phải JSON, dịch chậm hơn hạn lần đầu thì lần gọi lại được hạn dài hơn, dịch vụ treo hẳn thì thôi sau 3 lần quá hạn, lượt rút gọn treo thì giữ dòng đầy đủ (14 kiểm tra). `lyrics-test.mjs`: chế độ lời bài hát, kể cả điệp khúc câu ngắn, ngữ cảnh ở chế độ thường, hai chế độ cùng lúc, đoạn cả bài có câu nói nhanh ở hai chế độ, kể cả khi không câu nào tự đủ là câu hát, thoại tiếng Nhật ít chữ Hán, câu một chữ, đoạn chỉ có tiếng đệm, cache "quá ít lời" cũ được làm lại (23 kiểm tra). `mtfix-test.mjs`: dòng lượt dịch đầu bỏ trống hay còn chữ Hán được dịch lại, luật giữ/bỏ dòng còn chữ Hán, log và `debug.mtFix` (9 kiểm tra, §6aj). `keep-asr-test.mjs`: `TOD_KEEP_ASR=1` giữ file nhận dạng kèm vị trí âm thanh; không đặt thì xoá như cũ (2 kiểm tra, §6al) |
| `node alpha/dev/content-sim-test.mjs` | content.js + tap.main.js trong vm, không cần trình duyệt: mẩu nhanh, đồng hồ trình phát, lướt, tua, tắt sub, giãn lần thử lại, `rank`, chế độ lời bài hát và đổi chế độ giữa chừng, slide feed bị ẩn, trang kết quả tìm kiếm, đóng modal, HTTP 429, đoạn cả bài không dùng chung giữa hai chế độ , bảng xưng hô theo từng video, bảng thông tin khi rê chuột vào nhãn, dòng dịch xong trước (tin partial), service worker cũ thì gửi không stream, lưới đoạn ở hai cách, các ca riêng cho cách dịch sẵn 10 s (70 kiểm tra). Mặc định chạy cách cũ; `FIRST10=1` chạy cả bộ ở cách 10 s (§6ae) |
| `node alpha/dev/content-time-test.mjs` | content.js theo thời gian: đồng hồ giả, các lượt tải chia băng thông. Thứ tự tải sau khi tua, mẩu nhanh nhường đường truyền, mẩu nhanh bị treo, không ngắt đoạn đã tải từ trước, đoạn đầu tải chậm qua máy chủ chậm (trang video và feed), tải nhanh rồi chậm hẳn, rời feed, tải chậm vừa phải, đường truyền chậm đều, khựng giữa chừng, tua về sau khi bỏ đoạn , hàng dịch sẵn nhường video vừa mở, báo làm nóng, mốc thời gian trong câu trả lời status; một lượt tải từ byte 0 cho mục lục + q0 + đoạn 0 (nhiều rtt và băng thông, dịch sẵn, tua lúc đang tải, moov lớn, không có moov ở đầu, 200 cả file, lướt đi, 429, CDN treo, lượt đó chậm từ byte 0, đổi chế độ lời bài hát gửi đúng byte cũ, mở giữa video, tiến độ cho dropSlow); xem video dài trên đường truyền chậm, đoạn kế chờ lượt gửi (chế độ video dài, §6t); video sau slide livestream có lượt tải đầu chậm riêng (§6v); lượt tải lúc dịch sẵn treo rồi lướt tới, mục lục nhỏ giọt (§6w); cửa chờ, tải sớm, `restartSlow` và các ca cách cũ chạy lại ở cách dịch sẵn 10 s (§6ab–§6ae); tua lúc lượt tải đầu video còn chạy thì dùng lại phần đã nhận, kể cả khi lượt đó bị máy chủ cho chậm riêng (§6af) (59 kiểm tra). Mặc định chạy cách cũ; `FIRST10=1` chạy cả bộ ở cách 10 s |
| `node alpha/dev/mp4audio-test.mjs` | Cắt âm thanh từ mp4 thật do ffmpeg tạo, đúng mốc trong khoảng 15 ms; `headerEnd` trên phần đầu file đang tải dở (5 kiểm tra) |
| `node alpha/dev/cues-test.mjs` | Gộp sub các đoạn, câu vắt qua ranh giới hai đoạn (5 kiểm tra) |
| `node alpha/dev/background-test.mjs` | background.js gửi `POST /v1/warm` (kiểu JSON) tới server trên máy, bỏ qua lỗi, chặn địa chỉ ngoài máy; trả lời NDJSON: dòng { partial } chuyển cho tab, dòng cuối là câu trả lời; `hello` trả bản, bằng version trong manifest; NDJSON thiếu dòng cuối thì báo lỗi rõ (5 kiểm tra) |
| `node alpha/dev/popup-test.mjs` | Dòng trạng thái server trong popup với `/health` giả: dịch vụ nhận dạng và dịch đang dùng, model dự phòng, hết hạn mức, thiếu key nhận dạng khi chỉ có `OPENAI_API_KEY`, thiếu key dịch, chỉ có `DASHSCOPE_API_KEY`, không kết nối được (9 kiểm tra, §6ag) |
| `alpha/dev/real/` | Bộ công cụ đo trên Douyin thật (cần mạng, key, Chromium; tốn tiền nhận dạng và dịch): bảng điểm của ROADMAP §3 trên bộ video thử. Cách dùng ở README trong thư mục đó (§6al) |
| `node alpha/dev/tap-test.mjs` | tap.main.js đọc response API với Response thật (fetch, XHR): thân chia khúc của search/stream, thân hỏng, giữ thứ tự danh sách tìm kiếm khi search/single đọc xong trước (3 kiểm tra) |
| `node alpha/dev/e2e.mjs` | Chromium thật + extension + Douyin giả + AI giả + server thật, có video dài 100 s, video "đã thích" ở cột bên, mẩu nhanh khi tua, đồng hồ trình phát lệch 50 s, CDN treo một lần, lời bài hát ♪, bấm ô tắt lời bài hát trong popup, video mở từ trang tìm kiếm, video đầu tải một lượt từ byte 0 , bảng xưng hô gửi lại cho đoạn sau, rê chuột thật vào nhãn thì hiện bảng thông tin, service worker đúng bản (31 kiểm tra). `E2E_MT=openai`: dịch bằng OpenAI giả trả SSE, có dòng tạm (32 kiểm tra). Mặc định chạy cách dịch sẵn 20–30 s; `E2E_FIRST10=1`: cách dịch sẵn 10 s, thêm ca phát liên tục (dòng đúng mốc, không "đang dịch" ở giây 8–16, cửa 4 s, dịch sẵn 12 s, lướt nhanh, cửa 1,5 s) (38 kiểm tra; 39 với `E2E_MT=openai`) (§6ae) |

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

### Đã kiểm trên Douyin thật (30/10, Chromium trên Mac, đã đăng nhập)

- **Điểm 1:** `mp4audio.js` đọc được file thật, kể cả vlog 34 phút. Các đoạn từ 0:00 tới 8:50 đều cắt và giải mã được, không có nhãn đỏ.
- **Điểm 2:** không gặp lỗi tải nào ở các đoạn sau. Chưa tách riêng xem lần nào dùng link CDN, lần nào phải lùi về `/aweme/v1/play/`.
- **Điểm 3: sub không còn sớm.**
  - Trình phát dùng MSE với **luồng âm thanh khác**: HE-AAC v2, mono, lõi 22,05 kHz, edit list bỏ 7106/44100 ≈ 0,161 s đầu. Chrome có áp edit list này (đo qua `SourceBuffer.buffered`).
  - So tương quan chéo âm thanh MSE với âm thanh extension gửi (tương quan 0,997): hai thước thời gian lệch nhau khoảng **0,5 ms**.
  - So mốc chữ của Fun-ASR với lúc giọng nói bắt đầu (82 điểm): ASR **muộn hơn** trung vị 0,08 s, sớm nhất 0,23 s.
  - Kết luận: để lệch mặc định là 0.
- **Điểm 4:** mới thử dạng `?modal_id=`, chưa thử trang `/video/{id}`.

## 6. Vấn đề "vlog nói nhiều không có sub": đã sửa (`alpha-5`)

**Nguyên nhân chính** (bắt được trên Douyin thật nhờ `TOD_DUMP=1`):
- Fun-ASR có khi trả **cả đoạn âm thanh thành một câu**. Ví dụ đoạn [20, 50) của vlog: 1 câu dài 0,08–37,5 s.
- Câu đó bắt đầu trong phần âm thanh gửi dư trước đoạn (18,5–20 s), nên `windowAsr` bỏ cả câu. Kết quả: nhãn "không nghe thấy lời" cho mọi đoạn sau đoạn đầu.
- Ở đoạn đầu, cùng hiện tượng một câu khiến lọc hát theo câu thành lọc cả đoạn.

**Cách sửa:**
- `resplitSentences` chia lại câu từ danh sách từ: dấu câu, khoảng lặng ≥ 0,8 s, dấu phẩy khi câu ≥ 6 s, cắt cứng khi quá 12 s.
- Luật "lời lặp" bỏ chữ số, Latin và chữ lặp liền nhau trước khi dò. Trước đây video MrBeast lồng tiếng bị coi là "bài hát" vì "25000" có "000"; "哈哈哈" cũng từng bị coi là lời lặp.
- Hashtag nhạc cộng nói thưa không còn đủ để bỏ cả đoạn, phải có thêm chữ kéo dài.

**Kết quả:** sau khi sửa, 18 đoạn mới xử lý trên Douyin thật chỉ bỏ 1 đoạn, và bỏ đúng (video chỉ có "嗯").

## 6b. Tua tới, tua lui nhiều chỗ: dịch kém, đã sửa (`alpha-6`, extension 0.2.1)

Đo bằng cách tua 11 chỗ trên vlog thật rồi so sub hiện ra với cache: phần hiển thị đúng giờ (351/355 mẫu; 4 mẫu lệch chỉ là khung hình ngay lúc tua). Lỗi nằm ở nội dung:

- **Chỗ nối hai đoạn mất nửa câu.** Hai đoạn chạy ASR riêng, câu vắt qua ranh giới có ở cả hai, mỗi bên nghe một kiểu. Extension luôn giữ bản của đoạn trước, kể cả khi bản đó thiếu ("花了5.5元。" thay cho "花了5.5块买了一把鞋刷子和一块肥皂，"). Sửa: `alpha/extension/cues.js` giữ bản dài hơn, cắt ngắn hoặc bỏ dòng trước; kiểm thử ở `alpha/dev/cues-test.mjs`.
- **Dịch thiếu ngữ cảnh khi tua.** Đoạn đang xem và đoạn kế được gửi cùng lúc, nên đoạn kế không có 3 dòng trước làm ngữ cảnh (xưng hô, tên riêng lệch). Sửa: server chờ đoạn trước *đang chạy* dịch xong rồi mới dịch (chỉ chờ ở bước dịch). Log ghi "(ngữ cảnh N dòng)". Đoạn vừa tua tới vẫn không có ngữ cảnh.
- **Lặp lời để nhấn mạnh bị coi là hát**, bỏ cả đoạn 30 s ("投降了，投降了，投降了", "完了完了完了"). Sửa: lặp lời chỉ là hát khi chữ kéo dài (> 0,25 s/chữ).
- **Gemini trả 429** (vượt hạn mức theo phút) khi nhiều đoạn gửi dồn. Sửa: server thử lại sau 2, 5, 15 s. Nếu key là gói miễn phí thì tua dồn dập vẫn có thể chạm hạn mức.

## 6c. Tua liên tiếp: sub đến quá muộn, đã sửa (extension 0.2.4)

Đo trên vlog thật, bấm thanh tiến trình 3–4 chỗ cách nhau ~3 s rồi dừng: trước khi sửa **25,5 s** mới có sub ở chỗ dừng; sau khi sửa **4,5–4,9 s** (bằng tua một lần).

- **Server làm theo thứ tự đến**, 2 đoạn một lúc: dịch hết các chỗ đã tua qua rồi mới tới chỗ đang xem. Sửa (`server.mjs`): hàng đợi ưu tiên (đoạn chứa chỗ đang xem trước, rồi yêu cầu mới nhất), đoạn ưu tiên được thêm một chỗ; đoạn không còn ai chờ thì bỏ khỏi hàng hoặc dừng giữa chừng (huỷ cả lệnh gọi ASR, dịch). Log ghi "huỷ (đã tua đi chỗ khác …)". Kiểm thử: `alpha/server/dev/queue-test.mjs`.
- **Extension báo huỷ** đoạn không còn cần (`background.js` ngắt request); tải xong mà người xem đã tua đi thì không gửi.
- **Sau khi tua, chỉ gửi đoạn ở chỗ đang xem**; đoạn kế và video dịch sẵn chờ nó xong (đoạn kế thường còn 15–30 s mới cần).
- **Hai hàng tải riêng**: video đang xem không chờ lượt tải dịch sẵn (đo được một lượt gặp CDN chậm 13 s).
- **Gọi nhà cung cấp có hạn giờ**: dịch 10 s, ASR 20 s, quá hạn thì gọi lại ngay (đo được một lần dịch 24 s). Gặp 429 thì chờ theo `retryDelay` của Gemini và ghi log loại hạn mức (`quotaId`).

Còn lại, chưa làm:
- Mỗi đoạn tải ~12 MB để lấy ~0,6 MB âm thanh. Không tải riêng được phần tiếng: file Douyin xen hình/tiếng rất dày (trung bình 1,4 khung tiếng mỗi cụm, cách nhau ~1 KB).
- Lượt "rút gọn dòng quá dài" chạy ở mọi đoạn đo được, thêm ~1–1,4 s mỗi đoạn (§8).
- Đoạn vừa tua tới không có ngữ cảnh dịch (đoạn trước chưa dịch hoặc đã bị huỷ).
- Khi thử nhiều, key Gemini chạm hạn mức theo phút: một câu ngắn mất 25 s vì thử lại. Chưa đọc được `quotaId` lúc đó (log mới sẽ ghi).

## 6d. Lướt video: dính "đang dịch" lâu, đã sửa một phần (extension 0.2.5)

Đo bằng `ArrowDown` qua 5–6 video ở 推荐, mỗi video 8–12 s, ghi nhãn mỗi 200 ms cùng các request tải.
- **Lướt khi đã ở trang một lúc:** 6/6 video có kết quả ngay khi lướt tới (đã dịch sẵn), cả trước khi sửa.
- **Vừa vào trang (tải lại):** đây là chỗ dính.
  - Trước khi sửa: video 1 không ra trong 12 s, video 2 và 4 chờ hết 8–12 s.
  - Sau khi sửa: video 1 ra sau 3,8–6,5 s (3 lần đo); từ video 3 trở đi có ngay.

Nguyên nhân và cách sửa:
- **Dịch sẵn nhầm video.**
  - Khi vào trang, Douyin tải `/aweme/v1/web/aweme/favorite/` (20 video đã thích ở cột bên). Extension xếp chúng vào hàng "video kế tiếp" và dịch sẵn, vừa tốn API vừa bỏ sót video thật.
  - Sửa: `tap.main.js` đánh dấu `feed` cho video lấy từ các API trong `PATHS`, và `content.js` chỉ đoán video kế tiếp từ đó.
  - Video đang xem không có trong feed (1–2 video đầu chỉ thấy qua player) thì lấy các video feed chưa xem.
  - e2e có kiểm tra cho trường hợp này.
- **Lượt tải của video đã lướt qua chặn video mới.** Sửa: tải đoạn không còn cần thì ngắt bằng `AbortController`; tải xong mà không còn cần (kể cả video dịch sẵn) thì không gửi.
- **Video kế tiếp bị hoãn** tới khi video đang xem dịch xong (luật của §6c). Sửa: chỉ hoãn đoạn kế của cùng video; video kế tiếp tải và gửi ngay, server vẫn làm đoạn gấp trước.
- **Video dịch sẵn vẫn xếp hàng như việc không gấp khi đã lướt tới.** Sửa: extension gọi `POST /v1/bump`, server đẩy đoạn đó lên đầu.
- **Video 31–75 s dịch một lần cả video**, nên phải tải trọn file mới có sub đầu. Sửa: `SINGLE_MAX` giảm từ 75 xuống 30. Video dài hơn 30 s được chia đoạn đầu 20 s như video dài; cache cũ của các video này không dùng lại.
- **Gemini hết lượt trong ngày** (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, key đang ở **gói miễn phí**).
  - Trước đây mỗi đoạn có lời thử lại 20–60 s (đo được một lần dịch mất 63 s), nên video kẹt "đang dịch".
  - Sửa: gặp `quotaId` có `PerDay` thì tạm không gọi Gemini 10 phút, cũng không gọi ASR trong thời gian đó. Nhãn hiện ngay "lỗi: Gemini đã hết lượt gọi trong ngày (gói miễn phí)", và extension chờ đúng thời gian server báo rồi mới thử lại.
- Log server ghi thêm thời gian xếp hàng và thời gian chạy của đoạn bị huỷ; `/health` có `running`, `queued`.

**Dịch bằng OpenAI** (extension 0.2.6):
- Chủ dự án đổi sang key OpenAI. Có `OPENAI_API_KEY` trong `alpha/server/.env` thì server dịch (cả lượt rút gọn) bằng OpenAI Chat Completions, trả JSON theo JSON Schema `strict`. Không có thì vẫn dùng Gemini. Model đổi bằng `OPENAI_MODEL`.
- 429 theo phút: chờ theo header `retry-after-ms` rồi gọi lại. 429 `insufficient_quota` (hết tiền): tạm ngừng 10 phút như Gemini hết lượt trong ngày.
- Test (`dev/queue-test.mjs`, `alpha/dev/e2e.mjs`) đặt `OPENAI_API_KEY=''` để server không nạp key thật từ `.env`. `loadDotEnv` giữ nguyên biến đã đặt, kể cả biến rỗng.
- Đã chạy với key thật (31/10). Tải lại trang rồi lướt 7 video: video 1–2 có kết quả sau 5,4–5,5 s, video 3–7 có ngay khi lướt tới. Dịch mất 1,2–4,6 s mỗi đoạn, không gặp 429.
- `OPENAI_BASE` trỏ được sang dịch vụ khác cùng kiểu API. `OPENAI_REASONING_EFFORT` gửi `reasoning_effort` cho model suy luận, và khi đó server không gửi `temperature`.
  - Đo trên 6 đoạn thật (31/10, cùng câu tiếng Trung, model suy luận nhỏ): mức `none` mất 1,3–4,2 s mỗi đoạn, ngang `gpt-4.1-mini` (1,2–4,6 s); mức `low` mất 2,4–13,5 s.
  - Model đó không nhận `minimal`.
- Khi khởi động, server báo các tên biến trong `.env` không dùng được (chỉ in tên, không in giá trị). Ví dụ: dòng key bị để sau `#` nên server không thấy.

Còn lại, chưa làm:
- **Key Gemini gói miễn phí** không đủ cho việc lướt bình thường: hết lượt trong ngày sau vài chục video. Lượt rút gọn (§8) gọi thêm một lần mỗi đoạn có dòng dài. Cần chủ dự án chọn: bật trả phí, đổi model, hay bỏ lượt rút gọn.
- **Máy chủ video chậm.** `/aweme/v1/play/` có lúc chuyển sang `v5-hl-mly-ov.zjcdn.com`, chỉ tải 0,3–0,9 MB/s (các máy khác trên 3 MB/s), nên đoạn đầu 2–4 MB mất 5–11 s. Có thể tải song song nhiều khoảng byte, nhưng như thế là lách giới hạn tốc độ của CDN, cần chủ dự án quyết theo quy tắc ở §2.
- **Feed tới muộn.** Khi vào trang, `/aweme/v1/web/tab/feed` tới sau ~12 s. Video 1–2 chỉ thấy qua player nên chưa dịch sẵn được video 2. Có thể tìm metadata của chúng trong `self.__pace_f` (hiện chỉ đếm, chưa đọc). (2/11: `tap.main.js` đã đọc `__pace_f` từ bản trước; trang chỉ nhúng 2 video đầu, xem §6w.)

Ghi chú môi trường test:
- Extension nạp bằng `--load-extension` trong Chrome for Testing bị tắt nếu gọi `chrome.runtime.reload()`; phải khởi động lại trình duyệt.
- Khởi động lại vẫn có thể **giữ service worker cũ** (`background.js` bản trước). Kiểm bằng `Debugger.getScriptSource` của service worker; nếu cũ thì tắt trình duyệt, dời thư mục `Default/Service Worker` của profile rồi mở lại. Người dùng bấm Reload ở `chrome://extensions` thì không gặp. Tăng version trong manifest cũng không đủ (đo 2/11, §6y). Từ 0.2.34 bảng thông tin báo khi worker là bản cũ.

Ghi chú cũ, giữ để tham khảo:

**Vlog nói nhiều nhưng không có sub.** Chưa có log nên chưa rõ nguyên nhân. Các khả năng:

- **a. Bộ lọc hát chấm nhầm từng câu.**
  - Với video nói, trung vị giây/chữ đo ở S3 là 0,14–0,24 cho **cả video**. Nhưng chấm **từng câu** thì câu nói chậm, kéo giọng có thể vượt 0,33.
  - Nếu quá nửa số câu bị coi là hát kèm nhãn `singing`, **cả đoạn** bị bỏ.
  - Kiểm bằng trường `debug.sentences[].medCharDur` và `sung` trong file cache của đoạn đó.
- **b. ASR không nghe ra lời** vì nhạc nền to. Khi đó nhãn ghi "không nghe thấy lời" hoặc "quá ít lời".
- **c. Lỗi tải hoặc đọc file.** Nhãn đỏ.

Cách làm đề xuất: tái hiện trên Douyin thật, xem nhãn, log và `debug`, rồi chỉnh theo dữ liệu. Có thể thêm nút "Dịch cả bài hát" trong popup để tạm tắt bộ lọc.

## 6e. Sau khi tua: dịch thiếu ngữ cảnh, mất câu ở chỗ tua tới (`alpha-7`, extension 0.2.8)

Kiểm trên vlog 34 phút bằng cách bấm thanh tiến trình như người dùng, ghi mỗi 100 ms (`scratchpad/seekcheck.mjs`, chỉ để trên máy):
- **Sub hiện đúng thời điểm.** 0 câu hiện nhầm trong 534 mẫu sau 4 lần tua; số còn lại là đang chờ dịch hoặc khung hình đầu câu.
- **Extension đọc đúng video.** Trang có 3–4 thẻ `<video>`, các thẻ kia ẩn hoặc nhỏ.
- **Không cần bắt riêng sự kiện tua.** Mỗi khung hình extension đọc `currentTime`, và 4 lần/giây lên lịch dịch theo nó.

Lỗi nằm ở nội dung dịch:
- **30% đoạn sau đoạn đầu (26/87) dịch không có ngữ cảnh**, chủ yếu là đoạn vừa tua tới: xưng hô đổi giữa chừng, câu bị cắt đôi ở ranh giới dịch lệch nghĩa.
  - Sửa 1: đoạn liền trước chưa dịch thì server lấy 3 dòng cuối của đoạn đã dịch gần nhất phía trước trong cùng video. Prompt ghi rõ là "cách một quãng".
  - Sửa 2: đoạn liền trước chưa có (chưa dịch, chưa gửi) thì extension gửi dư 8 s âm thanh phía trước, thay vì 1,5 s. Server lấy lời nói trọn trong phần đó (`speechBefore`) làm mạch câu cho bước dịch.
  - Đo khi dịch lại 3 đoạn: rõ nhất ở câu bị cắt đôi ("用不了" thành "Không dùng được" thay vì "Không được") và câu thiếu chủ ngữ.
- **Câu ở ngay chỗ tua tới không bao giờ hiện.** Câu bắt đầu trước ranh giới thuộc đoạn trước, mà đoạn trước không còn cần nên không được dịch. Sửa: khi gửi dư 8 s, `windowAsr(..., keepCrossing)` giữ cả câu vắt qua đầu đoạn; `cues.js` bỏ bản trùng nếu sau này đoạn trước cũng dịch.
- **Tua tới gần cuối một đoạn thì chờ 10–12 s:** đoạn đó dịch xong đã bị phát qua, rồi đoạn kế mới bắt đầu dịch. Sửa: đoạn bắt đầu trong 10 s tới cũng là "gấp" (`URGENT_AHEAD`), dịch song song. Sau sửa: 6,6–10,8 s, phần lớn là thời gian dịch của model đang dùng (3,5–7 s mỗi đoạn qua dịch vụ cùng kiểu API OpenAI chạy trên máy).
- Log ghi `(ngữ cảnh 3 dòng ở đoạn xa, lời ngay trước N câu)`.

**Mẩu nhanh khi tua (extension 0.2.10):**
- Chỗ đang xem chưa có sub thì extension gửi ngay một mẩu ~10 s từ chỗ đó, kèm 4,5 s dư phía trước, song song với đoạn 30 s.
- Server cache mẩu này riêng (`id.qFROM-TO…`), dùng ngữ cảnh của đoạn đã dịch gần nhất phía trước, và bỏ lượt rút gọn. Log ghi `[nhanh m:ss–m:ss]`.
- Khi mọi đoạn 30 s phủ lên mẩu nhanh đã xong, sub chuyển sang bản đoạn 30 s.
- Đo trên vlog, key OpenAI gốc (`gpt-4.1-mini`): chờ sau khi tua **3,3–3,7 s**; trước khi có mẩu nhanh là 6,3–7,9 s. Mẩu nhanh mất ~1–2 s nhận dạng và ~1,1–2,2 s dịch.
- Đánh đổi:
  - Khoảng 3 s đầu là bản của mẩu nhanh; khi đoạn 30 s xong, chữ có thể đổi giữa chừng.
  - Bản nhanh đôi khi kém hơn vì nhận dạng trên âm thanh ngắn (tên riêng sai).
  - Mỗi lần tua tốn thêm ~16 s nhận dạng và một lần dịch.
- Mẩu nhanh bị bỏ qua ("quá ít lời", cửa sổ ngắn) thì không đổi nhãn: vẫn "đang dịch" tới khi đoạn 30 s xong.
- Đo được trình phát Douyin có lúc trả `currentTime = 0` (đang dừng) giữa lúc phát rồi quay lại. Extension từng tin số đó và huỷ nhầm đoạn đang dịch. Giờ extension bỏ qua lần đọc khi `readyState < 1`, và cú nhảy về 0 lúc đang dừng phải lặp lại sau 250 ms mới tin.

## 6f. Lướt nhanh (~4 s/video): video thứ 3 trở đi không kịp dịch sẵn (extension 0.2.12)

Đo bằng cách tải lại 推荐 rồi lướt 10 video, mỗi video 4 s (`swipeperf.mjs`, `swipesum.mjs`, chỉ để trên máy). Tính từ video thứ 4, khi feed đã tới:
- **Trước khi sửa:** 2/8 có ngay, 4 phải chờ (0–3,5 s), 2 không kịp. Log server có đoạn xếp hàng 1,1–2,7 s.
- **Sau khi sửa:**
  - lượt 1: 6/8 có ngay, 1 chờ 0,0 s, 1 chờ 2,9 s;
  - lượt 2 (gặp lượt tải treo, xem dưới): 1 không kịp, 1 chờ 0,6 s, 5 có ngay;
  - lượt 3 (bản 0.2.12): 6/8 có ngay, 1 không có nhãn, 1 lỗi tải (đã sửa sau đó);
  - lượt 4: 8/8 có ngay.
- Video 1–3 sau khi tải lại hay không kịp vì feed API tới sau ~12 s (§6d). Đã sửa một phần (extension 0.2.13):
  - 2 video đầu của 推荐 nằm trong dữ liệu nhúng của trang (`self.__pace_f`, RSC, mỗi dòng `id:JSON`), không qua API feed. Trước đây extension chỉ thấy chúng qua player (kiểm mỗi 2 s), nên video 1 mất ~1,5 s đầu không có nhãn và video 2 không được dịch sẵn.
  - Sửa: `tap.main.js` đọc `__pace_f` lúc DOMContentLoaded và lúc load, coi đó là đầu danh sách feed; player kiểm mỗi 0,5 s. e2e có kiểm tra (feed giả tới sau 4 s); kiểm tra này trượt với mã cũ.
  - Đo: video 1 có nhãn ngay khi hiện. Video 2 có ngay hoặc chờ 0,2 s ở 2/2 lượt, trước đó trượt ở 5/5 lượt.
  - Còn sót do mạng: lượt tải 64 KB đầu file qua `/aweme/v1/play/` có lúc mất 2–5 s hoặc treo cả 3 lần gọi lại.

Nguyên nhân và cách sửa:
- **Server chỉ chạy 2 việc cùng lúc**, chia cho video đang xem, đoạn kế và các video dịch sẵn. Sửa: `MAX_PARALLEL` mặc định 4, đặt được qua `.env`. `queue-test` đặt 2 để giữ kịch bản cũ.
- **Chỉ dịch sẵn 2 video**, mỗi video mất 4–12 s. Sửa: `PREFETCH = 4`. Hàng tải dịch sẵn chạy 2 video cùng lúc, để một lượt gặp CDN chậm không chặn các video sau.
- **Đoạn dịch sẵn bỏ lượt rút gọn dòng dài**: extension gửi `prefetch: true`, mỗi video bớt một lần gọi model. Video đang xem vẫn rút gọn, trừ đoạn gấp (từ 2/11, §6w). Có test trong `openai-test`.
- **Lượt tải 64 KB đầu file qua `/aweme/v1/play/` có lúc treo 10–37 s**, không có hạn giờ, nên video đó không bao giờ được dịch sẵn. Sửa:
  - `rangeFetch` có hạn giờ: mặc định 20 s, phần đầu file 4 s.
  - Phần đầu file bị treo hoặc lỗi mạng (đo được `ERR_CONTENT_LENGTH_MISMATCH`) thì gọi lại một lần.
- Chi phí: mỗi video dịch sẵn tốn ~26 s nhận dạng giọng nói và 1 lần gọi dịch, kể cả video bị lướt qua.

## 6g. Tua trên feed 推荐: sub vẫn là của chỗ cũ (extension 0.2.15)

Feed có hai loại trình phát: `xgplayer-*` và `douyin-player-*`.
- **Loại `douyin-player`** (gặp ở video dài): khi tua, `<video>.currentTime` **không đổi**. Trình phát nối phần mới vào tiếp dòng thời gian cũ của MSE; chỉ `window.player.currentTime` nhảy tới chỗ mới.
  - Đo trên video 17:30: tua tới 5:00, 15:00, 10:50, 2:00, 16:40, mà `<video>` vẫn chạy liền 201 → 229 s.
  - Extension dùng `<video>.currentTime` nên không biết người dùng đã tua: vẫn dịch và hiện sub của chỗ cũ (đầu video).
  - Trang modal (`?modal_id=`) tua thẻ `<video>` bình thường, nên các lần đo ở §6b–§6e không bắt được lỗi này.
- **Sửa:**
  - `tap.main.js` (trong ngữ cảnh trang, chỉ đọc) gửi độ lệch `player.currentTime − <video>.currentTime` mỗi khi độ lệch đổi.
  - Id video lấy từ slide chứa thẻ `<video>` của trình phát; nếu không có thì từ `config.baseConfig.mediaInfo.id` (loại này không có `awemeInfo`), rồi mới tới `awemeInfo`.
  - `content.js` cộng độ lệch đó khi đúng video đang xem.
- **e2e:** giả lập trình phát chạy trước `<video>` 50 s. Kiểm tra trượt với mã cũ.
- **Đo trên feed thật** (video 3:09 có lời, `douyin-player`): 6 lần tua (bấm và kéo), độ lệch từ −55 đến +127 s, 338 mẫu có sub, 0 mẫu sai (so với đồng hồ trình phát). Loại `xgplayer` thì thẻ `<video>` được tua bình thường (độ lệch 0).

## 6h. Kiểm tra toàn bộ như người dùng (31/10, extension 0.2.16, key OpenAI gốc)

Đo trên Douyin thật, Chromium test có đăng nhập. Script ở scratchpad, chỉ để trên máy.

| Tình huống | Kết quả |
|---|---|
| Tua trên feed, trình phát `douyin-player` (bấm và kéo thanh tiến trình, 6 lần) | 338 mẫu có sub, 0 sai |
| Tua trên feed, trình phát `xgplayer` | 29 mẫu có sub, 0 sai |
| Tua bằng phím ← → | 7 mẫu có sub, 0 sai |
| Video tự phát lại từ đầu (3:09, `<video>` vẫn chạy tiếp ở 245 s) | sub vòng sau đúng |
| Lướt ngược ↑ rồi ↓ lại | đúng video, sub có ngay, 0 sai |
| Trang modal `?modal_id=` (vlog 34 phút, 3 lần tua) | 249 mẫu có sub, 0 sai; sub đầu sau 0,6–4,0 s |
| Lướt nhanh 4 s/video, tải lại trang (2 lượt) | 7 và 9 / 11 có ngay; 1 và 0 không kịp |
| Popup: kiểm server, tắt/bật, vị trí, cỡ chữ, nút −/+ | đúng, có lưu |
| Phím `]` ×3 rồi `[` ×3 | +0,3 s rồi về 0,0 s, có lưu |
| Toàn màn hình (nút của trình phát) | sub nằm trong phần toàn màn hình |
| Trang `/video/{id}` (`xgplayer`, 3 lần tua) rồi phát 2× | 90 + 21 mẫu có sub, 0 sai |
| Tắt server giữa chừng rồi bật lại | sau 1,6 s nhãn "lỗi: không kết nối được server…"; extension gọi lại sau ~20 s, sub ra sau 7,7 s |

Sửa trong lúc kiểm: lượt tải bị treo (15 s không có byte nào) giờ bị bỏ sau 6 s im lặng (phần đầu file 4 s), không đợi đủ 20 s, rồi gọi lại qua `/aweme/v1/play/`. Tải chậm nhưng vẫn có dữ liệu thì không bị cắt (tổng tối đa 60 s). e2e có kiểm tra: CDN giả treo một lần; mã mới gọi lại sau 6,0 s, mã cũ sau 20,0 s.

Chưa kiểm được:
- Dòng thống kê của popup khi mở bằng biểu tượng thật (lúc kiểm, popup được mở như một tab nên không thấy tab Douyin).
- Sub trên video livestream hay bài ảnh: chỉ thấy không có nhãn, chưa xem kỹ.

## 6i. Sửa theo đợt rà soát độc lập (31/10, extension 0.2.18, `alpha-8`)

Một agent `verifier` đọc toàn bộ code ở commit `acf699d` và tìm ra 16 điểm, không có lỗi chặn. Tôi tự chạy lại mô phỏng của nó và tái hiện được F1, F2, F3, F8, F12. Sửa bằng một workflow: hai thợ code, một cho extension, một cho server, mỗi người một worktree; mỗi bản vá có một verifier kiểm, và extension qua thêm một vòng sửa.

Server (`alpha-8`, xoá cache cũ, các video đã xem sẽ dịch lại):
- **F2:** lỗi dịch không do hết hạn mức từng làm extension gửi lại mỗi 20 s mãi, mỗi lần trả tiền nhận dạng lại.
  - Giờ server cache kết quả nhận dạng của từng đoạn và dùng lại khi thử lại.
  - Lỗi cấu hình dịch (401/403/404) tạm dừng gọi dịch vụ và trả `retryAfterMs`.
  - Extension giãn lần thử lại 20 s → 60 s → 180 s khi server trả lỗi. Không gọi được server (chưa chạy `npm start`) thì vẫn 20 s.
- **F3:** thiếu ffmpeg từng ra "không có âm thanh" và lưu vĩnh viễn. Giờ báo lỗi, không cache; "dịch không ra dòng" cũng không cache.
- **F8:** file cache hỏng từng làm server sập. Giờ coi như chưa có cache; ghi cache theo kiểu tmp + rename.
- **F11:** việc không gấp chạy theo `rank` (video kế tiếp trước), rồi mới đến yêu cầu mới nhất.
- **F12:** trang web lạ từng gửi được POST `text/plain` và làm tốn tiền. Giờ Origin khác `chrome-extension://` bị trả 403, không phải JSON bị trả 415. Đã thử bằng curl trên server thật.
- **F14:** đoạn trước bị "bỏ qua" (bài hát, không lời) thì lấy ngữ cảnh ở đoạn xa hơn.

Extension:
- **F1:** mẩu nhanh được lọc theo từng dòng. Dòng nằm trong đoạn 30 s đã xong thì bỏ. Trước đây tua sát cuối đoạn thì mẩu nhanh hiện mãi và mất dòng của đoạn sau.
- **F4:** đồng hồ trình phát gửi kèm vị trí `<video>`, trạng thái dừng/phát và tốc độ, nhắc lại mỗi ~500 ms.
  - Chỉ cộng độ lệch khi thẻ `<video>` khớp vị trí và trạng thái dừng/phát.
  - Riêng ~1 s sau khi chính thẻ `<video>` đó đổi dừng/phát thì không xét trạng thái, vì tin đồng hồ mới chưa kịp tới.
  - Bản đầu của tôi tính theo tuổi của tin (< 600 ms), nên nhịp nhắc 500 ms luôn lọt và điều kiện vô tác dụng; verifier chỉ ra, đã sửa.
- **F6, F7:** mẩu nhanh chỉ gửi khi chỗ đang xem đã đứng yên 450 ms, mỗi lần tua một mẩu. Không gửi cho đoạn ≤ 16 s, hay khi đoạn đã bắt đầu tải từ trước lần tua (trừ khi tải quá 2 s chưa xong).
  - Lướt nhanh 10 video: cả lượt chỉ còn 1 mẩu nhanh.
- **F9:** lướt sang video đang tải hay dừng ở 0 s, nhãn đổi theo video mới.
- **F10:**
  - `__pace_f` chỉ được tính là feed ở trang feed (`/`, `/?recommend`, `/jingxuan`).
  - Mỗi API là một danh sách riêng; video kế tiếp lấy theo danh sách chứa video đang xem.
- **F13:** gặp "file video đã đổi" thì bỏ mục lục cũ, lần sau tải lại.
- **F15:** tắt sub thì huỷ mọi việc đang chạy. Câu báo lỗi trong popup không chỉ nói PowerShell.
- **Tôi thêm, ưu tiên đường truyền cho mẩu nhanh:** khi mẩu nhanh bắt đầu tải, các lượt tải đoạn 30 s của video đó bắt đầu sau lần tua mà chưa gửi bị ngắt, rồi tải lại sau khi mẩu nhanh tải xong (chờ tối đa 3 s).
  - Một verifier soát riêng phần này và bắt được lỗi đảo thứ tự: đoạn kế lấy lượt tải trước đoạn ở chỗ tua, nên hết 10 s của mẩu nhanh là mất sub ~5 s.
  - Đã sửa:
    - `holdBack` giữ chỗ cho đoạn gấp vừa bị ngắt;
    - không ngắt đoạn đã tải từ trước lần tua;
    - cổng chờ 3 s thay vì 6 s.
  - `content-time-test.mjs` có 3 kiểm tra; cả 3 trượt với bản đầu của tôi.
  - Đo trên video 23 phút bitrate cao (đoạn 30 s ~14,5 MB): mẩu nhanh 6,7 MB tải một mình trong 1,8 s, trước đó 4,4 s khi tải chung với đoạn 30 s.
  - Sub đầu sau khi tua: 2,3–4,6 s; trước đó 6,8–9,3 s, có lần quá 10 s.

Đo lại trên Douyin thật sau khi ghép:
- Lướt nhanh 10 video: 8/11 có ngay, 2 phải chờ, 1 không kịp.
- Tua trên video 23 phút: 155 mẫu có sub, 0 sai.

Còn mở:
- **F4, một ca hẹp:** thẻ `<video>` khác của cùng video phát ngang qua đúng chỗ trình phát feed đang dừng. Đã chặn bằng điều kiện trạng thái dừng/phát (mô phỏng: 0/12 lần cộng nhầm, trước đó 8/12). Chưa đo trên Douyin xem `window.player` có còn là trình phát feed khi mở `?modal_id=` không.
- **Mẩu nhanh không được ưu tiên so với hàng dịch sẵn:** hàng dịch sẵn (video kế tiếp) vẫn tải song song, nên mẩu nhanh chỉ "tải một mình" khi hàng dịch sẵn đang rảnh.
- **F6:** video > 15 s chưa dịch sẵn vẫn gửi cả mẩu nhanh lẫn đoạn đầu, nên 10 s đầu được nhận dạng hai lần. Giữ lại vì nó cho sub đầu nhanh hơn.
- **SETTLE 450 ms:** làm mẩu nhanh sau khi tua đi muộn thêm ~0,45 s, để tránh tải bừa khi kéo thanh tiến trình.
- **Nhận diện lỗi kết nối:** extension phân biệt "không gọi được server" với lỗi phải trả tiền bằng cách so câu chữ báo lỗi của `background.js`. Đổi câu đó thì phải đổi theo `UNREACHABLE` trong `content.js`.
- **F16:** service worker MV3 có thể bị dừng khi một yêu cầu kéo dài hơn 30 s. Chưa kiểm.
- File `.asr.` của đoạn bị huỷ giữa chừng còn lại trong cache. Vô hại; lần thử lại còn dùng được.

## 6j. Dịch cả lời bài hát (31/10, extension 0.2.21)

Chủ dự án muốn hiểu cả video bài hát. Log ngày 31/10: 35/232 video bị bỏ vì là bài hát. Phần nhận dạng giọng nói của các video này đã trả tiền trước khi biết là bài hát, nên dịch thêm chỉ tốn bước dịch.
- **Popup:** nút "Dịch cả lời bài hát (♪)", mặc định bật (`settings.lyrics`). Extension gửi `lyrics: true` trong mọi yêu cầu.
- **Server, khi `lyrics: true`:**
  - Không bỏ đoạn hát. `lyricCues` đánh dấu `sung` cho từng dòng: cả đoạn là bài hát (đúng điều kiện bỏ qua cũ) thì mọi dòng; không thì dòng có quá nửa thời gian nói nằm trong một câu hát (`splitSung`).
  - Dòng hát chỉ có tiếng đệm (耶耶耶, 啦啦啦…) bị bỏ. Dòng chỉ có tiếng đệm chữ Latin ("yeah yeah", "lalala") bị bỏ ở mọi dòng và ở cả hai chế độ, vì `splitSung` chỉ đếm chữ Hán nên dòng chữ Latin không bao giờ là câu hát.
  - Câu lệnh dịch thêm hướng dẫn lời bài hát và cờ `"sung": true` cho từng dòng. Lượt rút gọn dòng quá dài cũng nhận cờ đó.
- **Cache riêng** `.vi.lyr.`:
  - Đoạn không có câu hát nào thì hai chế độ ra cùng kết quả: server trả ngay file của chế độ kia. "Không có câu hát" là `sung === 0`, không phải bài hát, và không có dòng ♪ (`noSinging` trong `server.mjs`).
  - Lúc một việc tới lượt chạy, server xem lại cache, cả file của chế độ kia. Hai chế độ cho cùng một đoạn tới cùng lúc thì việc chạy sau dùng kết quả của việc trước.
  - File nhận dạng (`.asr.`) của đoạn có hát (cùng điều kiện) được giữ lại, nên đổi chế độ thường không phải trả tiền nhận dạng lần nữa. Log ghi "ASR dùng lại".
  - Chế độ thường không lấy dòng hát của đoạn trước làm ngữ cảnh dịch.
  - `/v1/bump` tìm việc theo cả hai khoá (`.vi.lyr.` rồi `.vi.`); lần bump không mang cờ lyrics.
- **Extension:**
  - Dòng `sung` hiện "♪ " ở đầu.
  - Đổi nút thì bỏ kết quả đã có mà có câu hát (bài hát bị bỏ qua, hay có dòng ♪), rồi xin lại. Đoạn chỉ có lời nói và đoạn lỗi (giữ số lần lỗi) giữ nguyên, nên sub không biến mất.
  - Không huỷ việc đang tải hay đang ở server. Chế độ lúc gửi được ghi lại; trả lời về mà là chế độ cũ và có câu hát (hay lỗi) thì bỏ và xin lại, không có câu hát thì giữ.
  - Đoạn xin lại gửi đúng phần âm thanh như lần trước (`v.redo`; thử lại sau lỗi cũng vậy), để mã băm khớp và server dùng lại kết quả nhận dạng. Phần nhớ này chỉ xoá khi có kết quả cuối, và bỏ khi đoạn không còn cần (tua, lướt đi). Tua về sau đó thì gửi dư 8 s cho đúng ngữ cảnh (§6e), chấp nhận nhận dạng lại một lần. Đây là lựa chọn có chủ ý: ưu tiên sub đúng ở chỗ tua tới.
  - Mẩu nhanh có câu hát bị bỏ thì gửi mẩu nhanh mới cho chỗ đang xem.
- **Log server:** đoạn ở chế độ lời bài hát có "♪" trong nhãn, ví dụ `[0:20–0:50 ♪]`. Chế độ lời bài hát ghi "N dòng hát được dịch" khi có kết quả, chế độ thường ghi "N câu hát bị bỏ".
- **ASR Gemini** (khi không có key DashScope) gần như không nhận ra câu hát. Nó không có mốc từng chữ, nên chỉ điệp khúc lặp 4 lần mới thành "cả đoạn là bài hát", và câu lệnh nhận dạng còn dặn bỏ qua lời bài hát. Chế độ lời bài hát cần Fun-ASR.
- **Đo trên Douyin thật:**
  - Dòng hát hiện đúng lúc, ví dụ "♪ Ngày ấy tôi đã trở thành xiềng xích," (当年我变成了枷锁) ở 36,3 s.
  - Tắt trong popup thì cùng chỗ đó hiện "bài hát (đoạn 0:20–0:50)", server ghi "ASR dùng lại".
  - Extension 0.2.21, video nói (7697856221549727017): tắt rồi bật ô trong popup, sub vẫn hiện suốt (30/30 và 29/30 mẫu trong 3 s), nhãn không về "đang dịch", server không bị hỏi lại.
  - Video 12 s chỉ có tiếng ngân "嗯嗯嗯…": chế độ thường bỏ qua (bài hát); bật lại thì xin lại, server ghi "ASR dùng lại", vẫn bỏ qua vì chỉ có tiếng đệm.
  - Chưa gặp bài hát dài hơn 35 s trong 20 video lướt thử, nên ca đổi nút lúc đang phát liền mạch một bài hát dài chỉ có mô phỏng.
- **Sửa theo đợt soát độc lập lần 1** (1 verifier, 31/10). Tôi tự dựng lại cả hai lỗi lớn bằng script của nó trên code thật trước khi sửa:
  - **Chế độ thường nhận nhầm dòng ♪.** Bài hát toàn câu ngắn (điệp khúc "我爱你。" ×4: không câu nào đủ 4 chữ để tự tính là câu hát) hoặc ASR Gemini cho `sung = 0` mà mọi dòng là dòng hát. Điều kiện cũ (`sung === 0`, không phải `singing`) cho chế độ thường dùng lại file đó, hiện cả dòng ♪. Sửa: thêm điều kiện "không có dòng ♪".
  - **`/v1/bump` không chạy ở chế độ mặc định.** Server chỉ tìm khoá `.vi.`, nên lướt tới video dịch sẵn thì đoạn đó không được đẩy lên (hỏng bản sửa "video dịch sẵn vẫn xếp hàng" ở §6d). Đo bằng hàng đợi 1 chỗ: thứ tự xong 01, 03, 02 thay vì 01, 02, 03.
  - **Đổi nút lúc đang phát liền mạch thì trả tiền ASR lần nữa.** Đoạn trước cũng bị bỏ nên đoạn thứ hai gửi dư 8 s thay vì 1,5 s như lần đầu, mã băm âm thanh khác. Cache thật của video bài hát test hôm đó có đúng dấu vết này: đoạn 0:50–1:20 có 2 file `.asr.` khác mã băm.
  - **Đổi nút bỏ cả đoạn chỉ có lời nói:** sub biến mất, nhãn "đang dịch…" tới khi tải lại âm thanh từ CDN.
  - Nhỏ: ngữ cảnh ở chế độ thường, tiếng đệm chữ Latin, lượt rút gọn, câu log.
- **Sửa theo đợt soát lần 2** (Workflow 7 agent: 3 lens server / extension / test-tài liệu-chi phí, mỗi lens 1 verifier, 1 critic; ~0,75 triệu token, 37 phút). Không có lỗi chặn hay lỗi lớn; các lỗi nhỏ đã sửa:
  - **Đổi nút huỷ mọi việc đã gửi server**, kể cả đoạn chỉ có lời nói. Server ngắt lệnh ASR trước khi lưu `.asr.`, nên huỷ giữa lúc nhận dạng thì lần gửi lại trả tiền ASR lần nữa (hai agent chạy lại độc lập). Kẽ hở đi kèm: trả lời muộn của chế độ cũ được giữ, mô phỏng thấy "♪ hát cũ" ở chế độ thường. Sửa: không huỷ, xét trả lời theo chế độ lúc gửi.
  - **Hai chế độ cùng lúc cho một đoạn** thì việc chạy sau trả tiền ASR và dịch lần nữa. Sửa: xem lại cache lúc việc bắt đầu.
  - **Phần âm thanh nhớ lúc đổi nút bị xoá ngay khi bắt đầu xin lại:** tải hỏng hay lỗi server thì lần sau gửi khác, trả tiền ASR lần nữa. Nó cũng được dùng cho lần tua sau đó, mất câu vắt qua chỗ tua tới.
  - **Dòng nói ngắn ("好。") gộp vào dòng hát ngay sau thì mất ♪**, vì chỉ xét mốc bắt đầu.
  - **"yeah yeah" ở dòng không hát vẫn hiện.**
  - **Mẩu nhanh có câu hát bị bỏ khi đổi nút mà không gửi lại.**
  - Thêm test cho phần điều kiện "không có dòng ♪" phía extension và cho việc giữ đoạn lỗi: trước đó bỏ đi mà mọi test vẫn đạt.
- **Vẫn trả tiền thêm** trong các trường hợp:
  - Đoạn có câu hát đang ở server lúc đổi nút chạy hết theo chế độ cũ, rồi dịch lại theo chế độ mới. ASR được dùng lại, chỉ tốn thêm một lần dịch.
  - Xin lại với phần gửi dư khác lần đầu: tải lại trang, tab khác, tua về đoạn đã bỏ.
  - File `.vi.lyr.` làm trước các bản sửa, của điệp khúc câu ngắn hay của ASR Gemini, đã mất `.asr.`.
  - Đoạn có xen câu hát đã dịch ở chế độ thường trước 31/10 (file cũ không có `.asr.`): chế độ lời bài hát (mặc định) nhận dạng và dịch lại một lần.
  - Bài hát đã bị bỏ qua trước khi có chế độ này (bản cũ luôn xoá `.asr.`): lần đầu xem lại ở chế độ lời bài hát trả tiền nhận dạng một lần.
  - Người xem tua đi lúc đoạn đang nhận dạng: server ngắt ASR trước khi lưu. Chuyện này có từ trước chế độ lời bài hát. Chưa biết lệnh bị ngắt có bị tính tiền không.
- **Không tăng `PIPELINE_VERSION`** (vẫn `alpha-8`). Các thay đổi chỉ đổi kết quả làm mới từ nay: chế độ lời bài hát, ngữ cảnh và dòng "yeah yeah" ở chế độ thường. File cũ vẫn đúng, vì điều kiện dùng chung giữa hai chế độ được xét lúc đọc. Tăng thì mọi video đã xem phải nhận dạng và dịch lại. File `.vi.lyr.` làm trước các bản sửa có thể còn dòng tiếng đệm chữ Latin.
- **Test:**
  - `lyrics-test.mjs` 14: điệp khúc câu ngắn ở hai chế độ, ngữ cảnh ở chế độ thường, lượt rút gọn dòng hát, "yeah yeah", hai chế độ cùng lúc.
  - `queue-test.mjs`: bump ở chế độ lời bài hát.
  - `test.mjs`: dòng hát trong vlog, tiếng đệm (kể cả chữ Latin toàn chiều rộng, chuỗi dài), dòng nói ngắn gộp vào dòng hát.
  - `content-sim-test.mjs`: 10 kiểm tra về lời bài hát và đổi chế độ giữa chừng.
  - e2e: video bài hát hiện "♪ …"; bấm ô trong popup để tắt thì bài hát bị bỏ qua và ASR được dùng lại.
  - Trượt với code trước đợt soát lần 2: 4 kiểm tra extension (không huỷ khi đổi nút, trả lời của chế độ cũ, tua về sau khi đổi nút, mẩu nhanh) và 4 kiểm tra server (chữ Latin toàn chiều rộng, dòng gộp, "yeah yeah", hai chế độ cùng lúc). Các kiểm tra "không có dòng ♪" phía extension, giữ đoạn lỗi và lượt rút gọn được kiểm bằng cách bỏ đúng đoạn code đó: test trượt. Kiểm tra điệp khúc ở chế độ lời bài hát đạt cả với code cũ; kiểm tra chế độ thường ngay sau nó mới bắt lỗi R1.

Còn mở:
- **Nhận dạng lời hát kém hơn lời nói** khi nhạc to hoặc hát luyến: có chỗ sai chữ, câu dịch lệch nghĩa.
- **Đánh dấu ♪ theo từng câu** dựa vào độ dài chữ (> 0,33 s/chữ), nên câu nói kéo dài, la hét có thể bị đánh dấu ♪ (ví dụ "冲刺冲 → Tăng tốc nào!"). Trong một đoạn có cả câu hát lẫn câu nói, câu hát không đủ dài có thể không có ♪. Đã đo trên 13 video thật ngày 1/11 (§6l): ♪ đúng khoảng 90% số dòng được gắn, phủ khoảng 89% dòng hát có sub; rap và hô vè không bao giờ có ♪. Lô 2 (22 video mới, §6n), luật trước khi sửa: với Fun-ASR, ♪ đúng 93% nhưng chỉ phủ 59% dòng hát (nhiều bài hát nhanh); với model dự phòng, video đọc chậm (thơ, thiền, 三字经) bị gắn ♪ hàng loạt. Sau đó chủ dự án quyết định đọc theo nhịp (三字经, đồng dao, vè), 喊麦 và rap đều tính là hát; số tính lại ở §6n.
- **Server ngắt ASR khi người xem tua đi**, trước khi lưu `.asr.` (có từ trước). Sửa được bằng cách để lệnh ASR chạy nốt rồi lưu, nhưng nên biết trước lệnh bị ngắt có tính tiền không.
- **Bản quyền:** khi có cache dùng chung cho nhiều người, việc lưu và phát bản dịch lời bài hát cần xem lại.

## 6k. Fun-ASR hết hạn mức: tự chuyển sang `qwen-audio-3.1-asr-flash` (31/10, extension 0.2.22)

Chủ dự án yêu cầu: hết token (hạn mức) của Fun-ASR thì chuyển sang `qwen-audio-3.1-asr-flash`.
- **DashScope tính hạn mức riêng cho từng model** và không tự chuyển sang model khác. Hết hạn mức thì báo:
  - 403 `AllocationQuota.FreeTierOnly`: hết hạn mức miễn phí khi bật "chỉ dùng miễn phí";
  - 429 `Throttling.AllocationQuota` kèm câu "Free allocated quota exceeded": hết hạn mức miễn phí;
  - 400 `Arrearage`: tài khoản hết tiền.

  429 `Throttling.AllocationQuota` không kèm câu đó thường là giới hạn theo phút (chưa kiểm được trên DashScope thật): server gọi lại sau 2, 5, 15 s như mọi 429, không đổi model. Vẫn bị sau 3 lần gọi lại (22 s) thì model đó nghỉ 3 phút và đoạn đó dùng model dự phòng. Bản đầu coi mọi 429 mã này là hết hạn mức; verifier chứng minh gặp một lần ở cả hai model là mất nhận dạng 30 phút, trong khi bản trước chỉ chờ ~2 s.

  Nguồn: tài liệu Model Studio (trang hạn mức miễn phí, trang API nhận dạng không thời gian thực).
- **Cách chạy** (`pipeline.mjs`, `funasr()`):
  - Gặp một trong ba mã đó thì gửi lại ngay đoạn đó bằng model dự phòng (`ASR_FALLBACK_MODEL`, mặc định `qwen-audio-3.1-asr-flash`), nên vẫn có sub. Các đoạn sau đi thẳng sang model dự phòng.
  - Cứ 30 phút server thử lại Fun-ASR một lần (lần thử hỏng trả lời ngay), phòng khi đã nạp tiền hay tắt "chỉ dùng miễn phí". Chạy lại server thì thử ngay.
  - Mỗi đoạn thử mỗi model tối đa một lần. Fun-ASR vừa hết lượt chờ trong lúc model dự phòng đang chạy (rồi báo hết hạn mức) thì cùng đoạn đó thử Fun-ASR luôn.
  - Model dự phòng bị từ chối (chưa bật trong Model Studio, key không có quyền) thì lỗi ghi rõ "… hết hạn mức, model dự phòng … bị từ chối". Lỗi đó tạm dừng cả DashScope 2 phút như mọi lỗi key; trong lúc đó câu lỗi vẫn giữ nguyên.
  - Trả 200 mà không có câu thì báo lỗi, trừ khi chữ cũng rỗng (đó mới là "không có lời"). Không thì đoạn đó bị lưu là bỏ qua mãi.
  - Lỗi không phải JSON (trang lỗi HTML của cổng mạng) vẫn được gọi lại như trước.
  - Model dự phòng cũng hết hạn mức thì tạm dừng nhận dạng tới lúc thử lại, báo lỗi ngay kèm `retryAfterMs` như khi Gemini hết lượt.
  - Lỗi 401/403/404 khác (key sai, không có quyền) vẫn là lỗi cấu hình như trước, không đổi model.
  - Đặt `ASR_FALLBACK_MODEL=` (rỗng) trong `.env` để tắt.
- **Thấy ở đâu:**
  - Log khởi động ghi `ASR: funasr fun-asr-flash-2026-06-15, dự phòng qwen-audio-3.1-asr-flash`.
  - Lúc chuyển model, log ghi một lần `… hết hạn mức (mã): chuyển sang …`; dòng log của đoạn ghi tên model dự phòng sau thời gian ASR.
  - `/health` có `asrModel` (model đang dùng), `asrModels`, `asrFallback`. Popup ghi "Nhận dạng: qwen-audio-3.1-asr-flash (Fun-ASR hết hạn mức)".
- **Gọi thật một lần** với key của chủ dự án (server tự nạp `.env`; không đọc file đó). Âm thanh do giọng Tingting của macOS đọc.
  - Câu tiếng Trung 6,9 s: HTTP 200, 965 ms, nhận đúng nguyên câu, 1 câu có mốc 0,12–6,80 s và 17 từ có mốc.
  - Kết quả cùng dạng với Fun-ASR-Flash (`output.sentence` có `words[]` với `begin_time`/`end_time`), nên bộ đọc kết quả dùng chung.
  - Đoạn im lặng 4 s: HTTP 400 `CLIENT_ERROR` với câu `ASR_RESPONSE_HAVE_NO_WORDS`, giống Fun-ASR, nên được hiểu là "không có lời".
  - Giá trên trang model, khu vực Singapore: vào 0,15, ra 0,47 USD mỗi triệu token. Lượt thử trên tính 85 token vào, 17 token ra.
- **Soát độc lập:** 1 verifier dựng server thật với DashScope giả, 3 lượt (soát, kiểm lại, kiểm lại lần cuối). Không có lỗi chặn.
  - Lượt 1, lỗi lớn: 429 theo phút nói trên. Lỗi nhỏ: log khởi động báo nhầm `ASR_FALLBACK_MODEL` là biến không dùng; dạng kết quả lạ bị lưu thành "không có lời"; đoạn báo lỗi đúng lúc hết lượt chờ; câu lỗi khi model dự phòng bị từ chối; "(cả model dự phòng)" khi đã tắt dự phòng; log chuyển model lặp lại.
  - Lượt 2, lỗi lớn do chính bản sửa sinh ra: đọc `body.message` khi DashScope trả lỗi không phải JSON (`body` là `null`), nên trang lỗi 502, 503 rỗng báo lỗi ngay, mất các lần gọi lại. Lỗi nhỏ: có chữ mà không có câu vẫn bị lưu là "không có lời"; 429 theo phút kéo dài làm đoạn nào cũng chờ 22 s rồi lỗi; câu lỗi đổi lại sau khi hết lượt chờ; `ASR_QUOTA_RETRY_MS` âm làm mất lượt chờ; test có thể treo khi trùng cổng.
- **Test:** `asr-fallback-test.mjs`, 20 kiểm tra, dùng DashScope giả trả đúng mã và câu lỗi theo tài liệu (`ASR_QUOTA_RETRY_MS` rút lượt chờ 30 phút xuống 1,2 s; cổng do hệ điều hành chọn). Kiểm tra mới của mỗi lượt trượt với bản trước lượt đó.
- **Chưa kiểm:**
  - Fun-ASR hết hạn mức thật đã gặp ngày 1/11 lúc 17:03, giữa lúc đo lô 2: DashScope trả mã `AllocationQuota.FreeTierOnly` (theo tài liệu là HTTP 403; log chỉ ghi mã), server chuyển sang model dự phòng đúng như trên, log ghi một dòng chuyển model, sub không gián đoạn (§6n). Mã khác (nếu có) nằm trong log server: dòng `báo HTTP 401/403/404: {…}` (lỗi key/model), hay dòng `LỖI HTTP 4xx: {…}` của đoạn đó.
  - Chất lượng nhận dạng của model dự phòng trên video Douyin thật (nhạc nền, nói nhanh) chưa so với Fun-ASR.
- **Còn nhỏ, chưa sửa** (verifier lượt 3, không ảnh hưởng sub):
  - Cả hai model cùng bị giới hạn theo phút kéo dài thì câu lỗi vẫn ghi "hết hạn mức", popup ghi "Fun-ASR hết hạn mức", và mỗi lần thử lại sau 3 phút tốn một vòng 22 s.
  - Model dự phòng bị từ chối đúng lúc một lệnh Fun-ASR đang chạy và lệnh đó báo lỗi key: câu lỗi nói về model dự phòng, nhưng log vẫn ghi đúng lỗi của Fun-ASR.

## 6l. Đo phân loại câu hát trên Douyin thật (1/11, extension 0.2.22, `alpha-8`)

Chế độ lời bài hát bật mặc định, mà phần phân loại câu hát/câu nói mới chỉ được kiểm bằng ASR giả (§6j).

- **Cách đo:**
  - Xem 13 video thật ở trang `/video/<id>`. Video tìm theo từ khoá, không phải lướt feed ngẫu nhiên, nên tỉ lệ video có hát (7/13) cao hơn feed thật.
    - Có hát: 2 bài hát cover, 2 video dạy hát, 1 livestream nói chuyện rồi hát, 1 kinh kịch, 1 rap.
    - Chỉ nói hoặc hô vè: 2 video đọc thơ, 1 bình luận bóng đá, 1 bài giảng đào tạo streamer, 1 livestream bán hàng hô vè, 1 vlog lồng tiếng.
  - Có 352 dòng sub, hệ thống gắn ♪ cho 76 dòng.
  - Nhãn chuẩn dựng mù, người gán nhãn không thấy cờ ♪. Workflow 9 agent:
    - 3 giám khảo: một xét chữ và ngữ cảnh; một xét âm thanh (dò cao độ, đo tỉ lệ nốt giữ, bỏ nốt của nhạc cụ); một tra lời bài hát trên web.
    - 1 agent phân xử gộp nhãn của ba giám khảo.
    - 2 verifier phản biện từng dòng lệch và 22 dòng khớp lấy mẫu.
    - 1 agent phân tích luật, 1 critic.
  - Có 4 loại nhãn: hát, rap/hô vè, nói, không rõ (21 dòng). Không ai nghe trực tiếp.
- **Kết quả**, tính hát với nói, bỏ rap và dòng không rõ:
  - Độ chính xác của ♪ là 63/70 = 0,90. Độ phủ là 63/71 = 0,887. Dòng nói bị gắn ♪: 7/221 = 3,2%.
  - Có 5 video toàn lời nói: 4 video không có dòng nào bị ♪, video đọc thơ còn lại có 3 dòng.
  - Hai video có hát liền mạch (爱错, guitar 情歌) có 30/30 dòng hát được gắn ♪.
  - Rap và hô vè: 0/39 dòng có ♪.
- **Đọc số cho đúng** (critic tự tính lại các số trên từ file, đều khớp):
  - 2 trong 7 dòng nói bị ♪ là dòng trùng. Chúng sinh ra vì đoạn sau bị gửi dư 8 s sau một lỗi tải (xem HTTP 429 bên dưới), và người xem thấy bản không có ♪. Tính theo những gì người xem thấy: 61/66 = 0,924.
  - Nhãn "hát" của 8 dòng trong video 宿敌 chỉ có giám khảo chữ ủng hộ. Nếu thực ra đó là đọc lời thì độ chính xác còn 0,79, nên khoảng nhạy là 0,79–0,92.
  - Giám khảo chữ đã đọc bản dịch tiếng Việt, mà dòng có ♪ được dịch bằng câu lệnh "lời bài hát". Đây là một đường rò quyết định của hệ thống vào nhãn chuẩn. Lần đo sau chỉ đưa chữ Trung.
  - Độ phủ chỉ tính trên các dòng có sub: đoạn hát mà ASR không ra chữ thì không được đếm.
  - 5 dòng có ♪ trong video kinh kịch có nhãn "không rõ". Nhiều khả năng đó là chữ ASR bịa ra trên tiếng đàn. Nếu tính chúng là gắn sai thì độ chính xác là 0,83.
- **Nguyên nhân của 15 lỗi.** Verifier phản biện xác nhận cả 15 là lỗi của hệ thống.
  - Gắn ♪ cho 7 dòng nói:
    - 3 dòng đọc thơ chậm. Trung vị độ dài chữ của câu là 0,40 / 0,34 / 0,40 s, vượt ngưỡng 0,33.
    - 4 dòng nói nằm trong đoạn bị coi là "cả bài". 3 dòng là lời nói chuyện ngay trước khi hát trong livestream (đoạn có 5/9 câu hát). 1 dòng là câu kêu theo dõi ở cuối video 宿敌 (đoạn có hashtag nhạc, trung vị cả đoạn 0,359, dù chỉ 2/5 câu hát). Chữ của chính các câu này chỉ 0,16–0,18 s.
  - Thiếu ♪ ở 8 dòng hát:
    - 5 dòng hát nhanh, câu chỉ 0,24–0,32 s/chữ.
    - 3 dòng hát chỉ có 3 chữ Hán, dù chữ kéo dài 0,56–1,44 s. Luật cần ít nhất 4 chữ.
  - Không ngưỡng nào tách sạch được. Câu đọc thơ và câu hát nhanh cùng 0,32 s/chữ. Câu hát có trung vị 0,41 (p10 0,32); câu nói có trung vị 0,16 (p90 0,26, lớn nhất 0,40).
  - Luật "quá nửa thời gian của dòng nằm trong câu hát" không gây lỗi nào.
  - ASR nghe sai chữ ở khoảng 28% dòng hát (kinh kịch 6/7 dòng), nên dù ♪ đúng, bản dịch lời hát vẫn hay dựa trên chữ sai.
- **Tác động:**
  - Chế độ lời bài hát: dòng nói bị ♪ vẫn hiện, chỉ thêm ♪ và văn dịch kiểu lời hát. Khoảng 1 dòng mỗi phút nói, và chỉ gặp ở 3/13 video. Dòng hát thiếu ♪ vẫn hiện, như lời nói.
  - Chế độ thường (tắt lời bài hát): câu bị coi là hát bị bỏ. Ước lượng mất 5 dòng nói (khoảng 10 s) trong 7,2 phút nói. Chưa đo trực tiếp.
- **Thử biến thể luật trên dữ liệu này.** Agent phân tích dựng lại đúng 352/352 cờ của hệ thống từ dữ liệu câu trước khi thử.
  - Đổi ngưỡng sang 0,30, 0,36 hay 0,40: chỉ đổi lỗi này lấy lỗi khác.
  - Hai thay đổi theo chữ không làm hỏng dòng nào ở đây:
    - (a) Trong đoạn "cả bài", dòng thuộc câu có ít nhất 3 chữ và trung vị ≤ 0,20 s/chữ thì không gắn ♪. Ở chế độ thường thì giữ dòng đó lại, thay vì bỏ cả đoạn.
    - (b) Hạ yêu cầu từ 4 xuống 3 chữ Hán.

    Gộp cả hai: 66 dòng đúng, 3 dòng gắn oan, 5 dòng thiếu (độ chính xác 0,957, độ phủ 0,93).
  - Cổng âm thanh (theo nốt giữ) sửa được bao nhiêu thì hỏng bấy nhiêu. Làm mịn theo câu bên cạnh thì xấu hơn hiện tại.
  - Rap chỉ bắt được bằng cách đo nhịp trong âm thanh (21/39 dòng). Số này không độc lập, vì luật đo nhịp được chỉnh trên chính các video này.
  - **Chưa đổi code.** Mẫu nhỏ (13 video trong một buổi, 15 lỗi), và các mốc 0,20 và 3 chữ được chọn sau khi đã nhìn lỗi. Đã đo lô mới ở §6n: áp (a), không áp (b).
    - Cần đo một lô mới trước khi commit: ngâm thơ, livestream nói rồi hát, hát nhanh, và lướt feed ngẫu nhiên.
    - Với (b), phải xem câu nói ngắn kéo dài (kiểu "好的吧") ở chế độ thường.
- **Lỗi khác tìm thấy trong cùng đợt:**
  - **Video mở từ trang tìm kiếm không có sub** (4/4 video thử: 3 trong lúc đo, 1 lần kiểm lại).
    - Kết quả đầu của trang tìm kiếm tới qua `/aweme/v1/web/general/search/stream/`. Phản hồi này khai là JSON nhưng chia khúc trong thân: một dòng độ dài hex, rồi một khối JSON, cứ thế lặp lại.
    - `tap.main.js` đọc bằng `res.clone().json()` nên báo `parse_error`, và đường này cũng không có trong `PATHS`. Vì vậy `content.js` không có item cho `modal_id`: không hiện nhãn, không tải gì.
    - Đã kiểm trực tiếp trong trình duyệt; tải lại hẳn trang tìm kiếm vẫn vậy.
    - Đã sửa ở extension 0.2.23 (§6m).
  - **Trang kết quả tìm kiếm hiện sub của video khác.**
    - Sau khi tìm từ feed (chuyển trang phía client), slide feed cũ vẫn nằm trong DOM với `data-e2e="feed-active-video"`. `findActive()` lấy slide đó, còn `videoFor()` lấy thẻ `<video>` lớn nhất đang thấy, tức video xem trước dài 628 s của trang tìm kiếm.
    - Kết quả: sub "♪ …" của video piano 29 s hiện đè lên một video khác.
    - Đã sửa ở extension 0.2.23 (§6m).
  - **Đoạn đầu không được gửi, 30 s mới có sub** (1/13 video, bài hát có đoạn dạo guitar).
    - Lượt tải đoạn 0–20 bị chậm. Tới giây 20 đoạn đó không còn "cần" nên bị ngắt im lặng (`cancelUnwanted`). Đoạn 20–50 vì thế gửi dư 8 s, và có 0 dòng ngữ cảnh.
    - Mẩu nhanh 0–10 bị bỏ qua ("quá ít lời") nên không bù được, và mỗi lần đứng yên chỉ xét một mẩu nhanh.
    - Verifier dựng lại được trong vm khi lượt tải đoạn 0 chậm. Riêng việc mẩu nhanh bị bỏ qua thì không gây lỗi.
    - Đã sửa ở extension 0.2.23 (§6m), không tải song song.
  - **HTTP 429 khi tải video** (1/13 video, 2 đoạn, nhãn lỗi khoảng 24 s). Không rõ 429 đến từ CDN hay từ `/aweme/v1/play/`.
    - Extension coi 429 như lỗi tải thường: gọi lại ngay một lần, rồi cứ 20 s thử một lần, không đọc `Retry-After`, mỗi đoạn tự chờ riêng; mẩu nhanh mất luôn.
    - Lượng tải của extension thấp (5–7 lượt cho video 90 s), không có dấu hiệu chính nó gây ra 429.
    - Đã sửa ở extension 0.2.23 (§6m).
  - Bộ mô phỏng `alpha/dev/content-sim-test.mjs`: fetch giả không từ chối khi signal đã bị ngắt từ trước (fetch thật thì từ chối ngay). Đã sửa (§6m).
- **Chưa đo:**
  - Model ASR dự phòng và Gemini với luật này. Gemini không có mốc từng chữ, nên ♪ gần như không bật.
  - Tiếng Quảng, song ca, giọng trẻ em, lời nói đè lên bài hát có lời.
  - Đo trực tiếp chế độ thường.
- Mẫu âm thanh tạm (TOD_DUMP) và ảnh chụp đã xoá sau khi đo. Nhãn và số liệu chỉ để trên máy.

## 6m. Sửa các lỗi phụ của đợt đo 1/11 (extension 0.2.23)

Quá trình sửa:
- Workflow 9 agent: hai thợ code làm song song trên bản sao (một người sửa `tap.main.js`, một người sửa `content.js`); mỗi bản vá có một verifier soi, một lượt sửa rồi kiểm lại; cuối cùng một agent ghép thử cả hai.
- Lượt 2 (tôi sửa): phần đoạn tải chậm, trang tìm kiếm, đóng modal. Hai verifier soi: phần chi phí và tài liệu đạt, phần lịch tải còn 3 lỗi lớn.
- Lượt 3: sửa 3 lỗi đó và các lỗi nhỏ, mỗi lỗi có test dựng từ kịch bản của verifier (trượt trên bản lượt 2). Một verifier khác kiểm lại: không còn lỗi lớn, còn 5 lỗi nhỏ.
- Lượt 4: sửa 5 lỗi nhỏ đó. Hai lỗi có test (trượt trên bản lượt 3); ba lỗi còn lại tôi kiểm bằng chính kịch bản của verifier. Sau lượt này không có agent nào soi lại.

- **Video mở từ trang tìm kiếm có sub** (`tap.main.js`):
  - Khi JSON.parse cả thân phản hồi hỏng (thân chia khúc), đọc từng dòng bắt đầu bằng `{` hay `[` (bỏ dòng độ dài hex), rồi walk từng khối. Trang vẫn đọc phản hồi gốc như cũ; bản sao dự phòng chỉ được đọc dạng chữ khi JSON hỏng.
  - Thêm `/aweme/v1/web/general/search/stream` vào `PATHS`, thuộc danh sách `search`.
  - Trong lúc stream (kết quả đầu) còn đọc, item của `search/single` (các trang sau) được giữ lại tối đa 20 s, để danh sách theo đúng thứ tự trang. Danh sách này quyết định video kế tiếp được dịch sẵn. Đo trên Douyin thật: stream đọc xong khoảng 1,5 s sau khi tìm, `single` xong sau đó 1,2 s.
  - Test:
    - `tap-test.mjs` (mới, 3 kiểm tra, dùng Response thật): thân chia khúc qua fetch và XHR; thân hỏng; thứ tự khi `single` xong trước.
    - e2e thêm 2 kiểm tra: video mở từ kết quả đầu có sub; kết quả kế tiếp được dịch sẵn.
- **Trang tìm kiếm không dịch video chưa mở** (`content.js`):
  - `findActive()`: khi đường dẫn có `/search/`, chỉ video mở trong modal (`?modal_id=`) mới là video đang xem. Thẻ kết quả và video xem trước tự phát không tính, để không trả tiền cho video người xem chưa mở.
- **Slide feed bị ẩn không còn làm hiện sub của nó lên video khác:**
  - Slide đó (vẫn mang `feed-active-video` sau khi tìm từ feed) không còn được nhận.
  - `videoFor()` không mượn `<video>` khác khi `<video>` của chính slide không thấy.
- **Đóng modal, trang không còn video nào:**
  - Quá 1 s không thấy video nào thì bỏ video đang xem và huỷ việc đã gửi của chính video đó.
  - Việc dịch sẵn video khác đã gửi tới server thì giữ, vì đóng modal rồi mở kết quả kế là luồng thường.
  - Việc dịch sẵn chưa gửi: rời feed sang trang không có video thì thôi, không tải, không gửi thêm. Còn ở feed mà slide đang xem không có video (livestream, quảng cáo) thì dịch sẵn tiếp, để lướt tới video kế là có sub ngay. Đo 1/11: feed tải lại có lúc mở đầu bằng một slide livestream.
  - Không thấy video lúc một đoạn hay mẩu nhanh vừa tải xong: chờ tối đa khoảng 1,2 s xem video có quay lại không. Một lượt dò hụt thì vẫn gửi bình thường; vừa đóng modal thì bỏ, không gửi rồi lại huỷ.
  - Trước đây chỗ đang xem về 0, và còn gửi thêm đoạn [0,20) của video vừa đóng.
- **Đoạn ở chỗ đang xem tải chậm** (`dropSlow`):
  - Nếu theo ước tính đoạn chỉ có sub khi chỗ đang xem đã đi qua nó, thì bỏ đoạn đó. Ước tính dùng tốc độ 3 s gần nhất của chính lượt tải (không tính các khoảng hơn 0,5 s không có byte), cộng 4 s xử lý ở server.
  - Khi đó hàng tải chạy ngay đoạn kế, gửi dư 8 s cho mạch câu (§6e). Chỗ đang xem được phủ bằng mẩu nhanh nối tiếp, tới hết đoạn bị bỏ.
  - Chỉ bỏ khi riêng lượt tải đó chậm:
    - tốc độ dưới 1/3 lượt tải xong gần nhất của cùng video;
    - không có lượt tải của video khác đang nhận byte;
    - video đang phát;
    - vừa có byte về trong 1 s qua. Lượt tải khựng hay đứng hẳn thì vẫn để `rangeFetch` cắt sau 6 s rồi gọi lại.
  - Đoạn đã bỏ không được tải lại khi chỗ đang xem còn trong nó. Chỗ đang xem ra khỏi nó (kể cả tua lùi về đoạn trước) thì xoá; quay lại thì tải lại từ đầu.
  - Mẩu nối tiếp chỉ gửi khi còn ít nhất 5 s (theo tốc độ phát) trước cuối mẩu, để kết quả về kịp.
  - Không tải song song đoạn kế. Bản vá đầu có thêm một lượt tải song song tới cùng máy chủ video; đã bỏ, vì §6d ghi đó là việc chủ dự án quyết.
  - Bản vá đầu còn gửi mẩu nối tiếp cả khi đoạn đã tới server. Verifier đo được: thêm khoảng 23 s nhận dạng mỗi video khi máy chủ chậm cỡ 2000 B/s, mà sub không ra sớm hơn.
  - Mô phỏng ca 1/11 (đoạn [0,20) tải 1040 B/s, q0 bị bỏ qua):
    - sub đầu ở giây 12,5, trước đây khoảng giây 29;
    - đoạn [20,50) gửi ở giây 9,5. Trước đây nó chỉ bắt đầu tải ở giây 20, gửi ở khoảng giây 25;
    - chỉ thêm 1 mẩu nhanh (q9), tức 16,5 s âm thanh.

    Kết quả cũng như vậy trên feed, khi đoạn đầu chậm đã bắt đầu tải từ lúc dịch sẵn, và khi đoạn tải nhanh 1/4 đầu rồi mới chậm hẳn. Ở 2000–2200 B/s (đoạn vẫn kịp), khi đường truyền chậm đều (có 2 video dịch sẵn), và khi khựng 2,5 s giữa chừng, kết quả giống hệt bản trước.

    Từ §6p, kịch bản test của các ca này là 560 B/s chậm từ byte 12000 (hết phần của q0), vì q0 và đoạn 0 nay đi chung một lượt tải. Ca 1040 B/s chậm từ byte 0 nằm ở §6p.
  - Từ §6p còn bỏ cả khi sub chỉ tới lúc đoạn còn dưới 5 s (`SLOW_KEEP`): sub tới sát cuối đoạn gần như vô ích, mà đoạn kế phải chờ sau nó.
  - Giới hạn:
    - Cần một lượt tải khác của cùng video đã xong nhanh hơn hẳn (thường là q0) để so. Máy chủ video chậm với mọi lượt tải thì không bỏ gì, như bản 0.2.22.
    - Từ §6p, q0 là phần đầu của chính lượt tải đoạn 0. Lượt đó chậm ngay từ byte 0 thì phải thôi lượt đó rồi tải nối tiếp bằng lượt riêng (`headLate`) mới có mốc để so.
    - Trên feed có nhiều video đang dịch sẵn mà đường truyền chậm, phải đợi dịch sẵn xong mới bỏ được, thường là quá muộn (verifier đo: 7 video, 9 KB/s).
- **HTTP 429 khi tải video:**
  - Không gọi lại ngay. Mọi lượt tải (cả hai hàng, mọi video) cùng nghỉ 5 s, rồi 15 s và 45 s nếu lại bị 429. Nếu đọc được `Retry-After` mà dài hơn thì theo nó, tối đa 2 phút.
  - Tải được một lượt bắt đầu sau lần 429 cuối, hoặc 10 phút không bị 429, thì tính lại từ 5 s.
  - Hết thời gian nghỉ thì đoạn bị 429 tải lại, và mẩu nhanh được xét lại.
  - Nhãn: "VI · lỗi: Douyin tạm chặn tải video (HTTP 429), thử lại sau N s".
  - Một lần 429 của video dịch sẵn cũng làm video đang xem nghỉ 5 s. Nghỉ chung là cố ý: không dồn thêm request khi Douyin đang chặn.
- **Bộ mô phỏng:**
  - Fetch giả nay từ chối khi signal đã bị ngắt từ trước.
  - `content-time-test` trả đúng số byte vừa tải. Trước đây mỗi lần đọc chỉ trả 16 byte, nên không đếm được tiến độ.
  - `content-time-test` có thêm `pause` (khựng giữa chừng) và `cap` theo từng video.
  - `content-sim-test` có thêm `env.center`, phần tử ở giữa màn hình.
- **Test:**
  - content-sim-test 43 kiểm tra, thêm 6: slide feed ẩn, trang kết quả tìm kiếm, đóng modal (giữ việc dịch sẵn kết quả kế), đóng modal lúc đang tải, 429, 429 lặp lại.
  - content-time-test 11 kiểm tra, thêm 8: đoạn đầu tải chậm, đoạn đầu chậm ở hàng dịch sẵn trên feed, tải nhanh rồi chậm hẳn, rời feed sang trang không có video (còn ở feed với slide livestream thì dịch sẵn tiếp), tải chậm vừa phải, đường truyền chậm đều, khựng giữa chừng, tua về sau khi bỏ đoạn. Bốn ca sau cố ý đạt cả trên bản 0.2.22, để canh hồi quy do chính bản sửa có thể gây ra.
  - tap-test 3, e2e 26.
  - Mọi kiểm tra mới còn lại đều trượt trên bản 0.2.22.
- **Kiểm trên Douyin thật** (1/11, Chromium test, bản 0.2.23; chạy lại sau lượt 3 và lượt 4):
  - Từ feed, gõ tìm "吉他弹唱 情歌" (chuyển trang phía client). Trang kết quả 12 s không có nhãn, không có sub, server không nhận yêu cầu nào. `tap.main.js` báo `search/stream` đọc được (chia khúc, 5 khối, 9 video), không còn `parse_error`.
  - Bấm kết quả đầu: nhãn "đang dịch…" sau 1 s, sub "♪ …" từ giây 8,5. Server dịch sẵn 4 kết quả kế tiếp, vì modal tự phát tiếp kết quả sau.
  - Đóng modal: nhãn và sub tắt, không có yêu cầu mới. Quay lại feed: sub hiện lại ngay; lướt tiếp vẫn có sub. Bài ảnh (图文) không có nhãn, như trước.
  - Chưa gặp lại đoạn đầu tải chậm hay HTTP 429 trên trang thật: hai phần này mới kiểm bằng mô phỏng.
- **Còn mở:**
  - Mở một kết quả tìm kiếm thì 4 kết quả kế được dịch sẵn (cùng luật với feed), tốn nhận dạng cho video người xem có thể không xem.
  - Modal tìm kiếm có thể mượn `<video>` xem trước của trang kết quả trong lúc `<video>` của modal chưa gắn vào trang: tải và gửi nhầm một đoạn rồi huỷ. Lỗi này có từ trước (verifier đo trong mô phỏng, chưa thấy trên trang thật).
  - Các ngưỡng của `dropSlow` (6 s, 1/3, 4 s, 1 s) chưa đo trên Douyin.

## 6n. Đo lô 2 và chốt luật ♪ (1/11, đo trên extension 0.2.23; sửa ở extension 0.2.24, `alpha-8`)

Hai luật ứng viên ở §6l được chọn sau khi nhìn lỗi của lô 1, nên phải đo trên video mới trước khi đổi code.

- **Ghi trước khi đo** (file chỉ để trên máy, cộng hai phụ lục viết trước khi có nhãn chuẩn):
  - Áp ứng viên X khi, trên lô 2: [không hỏng dòng nào và sửa ≥ 1] hoặc [sửa ≥ 3 và sửa ≥ 3 lần số hỏng]; X không làm chế độ thường mất thêm lời nói; không tầng ASR nào hỏng nhiều hơn sửa. Không chỉnh ngưỡng trên lô 2.
  - (a) Trong đoạn cả bài, dòng có câu của nó (câu trùng thời gian nhiều nhất) ≥ 3 chữ Hán, trung vị ≤ 0,20 s/chữ, và dòng nằm trong câu hát không quá nửa thời gian, thì không gắn ♪; chế độ thường giữ dòng đó. (b) Hạ yêu cầu từ 4 xuống 3 chữ Hán.
- **Lô 2:** 22 video mới, 485 dòng sub, hệ thống gắn ♪ cho 187 dòng.
  - 7 video lướt feed ngẫu nhiên (6 video ra sub; video piano không có lời).
  - 15 video tìm theo loại, để có nhiều chỗ hai luật đổi cờ: livestream và co-host hát xen nói chuyện, 3 người hát rong bắt chuyện người qua đường, lớp dạy hát, 2 cover (một song ca), rap trong lớp, bé hát 虫儿飞, ngâm thơ 艾青, thiền trước khi ngủ, bé đọc 三字经, hai cha con đọc 三字经 tiếng Quảng, ca sĩ phòng chat giọng nói.
  - Luật dừng ghi trước chỉ dựa vào dữ liệu hệ thống, chưa có nhãn. Sau 18 video, (a) mới có 2 dòng đổi cờ, nên thêm 4 video nói xen hát, tới mức tối đa 22.
  - Server chạy `TOD_DUMP=1` với `TOD_WORK` riêng, nên cache đo tách khỏi cache dùng hằng ngày.
- **Fun-ASR hết hạn mức thật giữa lúc đo** (17:03, mã `AllocationQuota.FreeTierOnly`). Server tự chuyển sang `qwen-audio-3.1-asr-flash`, sub không gián đoạn (§6k).
  - 14 video đầu chạy Fun-ASR (tầng F; 13 video ra sub), 8 video sau chạy model dự phòng (tầng Q).
  - Từ giờ production chạy model dự phòng, tới khi nạp tiền hay tắt "chỉ dùng miễn phí" trong Model Studio.
- **Nhãn chuẩn mù.** Workflow 8 agent:
  - 3 giám khảo. Một người chỉ xét chữ Trung và ngữ cảnh; khác lô 1, lần này không có bản dịch. Một người xét âm thanh: chạy nguyên phương pháp của lô 1 trước, rồi mới sửa. Một người tra lời bài hát trên web.
  - 1 agent phân xử.
  - 2 người phản biện không biết cờ của hệ thống. Một người tự viết bộ đo âm thanh riêng. Mỗi dòng mà một ứng viên đổi cờ được cả hai người xét.
  - 1 agent phân tích tự viết lại luật từ code, và 1 critic.
  - Nhãn cuối: 313 nói, 150 hát, 9 rap, 13 không rõ.
- **Quyết định** (theo nhãn lúc đo: đọc theo nhịp là lời nói; theo nhãn mới kết luận vẫn vậy, xem mục quyết định của chủ dự án). Script của tôi, agent phân tích và critic tính độc lập ra cùng các số dưới đây.
  - (a): sửa 4 dòng, hỏng 0 (F 2/0, Q 2/0). Chế độ thường mất 70 dòng nói thay vì 74 (195 s thay vì 203 s). **Áp.**
  - (b): sửa 1 (ở F), hỏng 5 (đều ở Q: 4 dòng ngâm thơ và câu "来关掉。"). Chế độ thường mất thêm 6 dòng. **Không áp.** Còn 1 dòng tranh chấp ("啊，姐姐。", cả hai người phản biện đều không chắc); tính là hỏng thì hỏng 6, quyết định không đổi.
  - (a)+(b): sửa 5, hỏng 5. Không áp.
  - Thử ngưỡng 0,25 thay 0,20, chỉ để xem độ nhạy: hỏng 2 dòng hát thật (0,24 và 0,25 s/chữ, livestream hát 邓紫棋). Giữ 0,20.
- **Đọc số cho đúng** (critic):
  - 4 dòng sửa thực ra là 3 sự kiện. 2 dòng là "可以吗？可以吗？" của cùng một người hát rong, và một trong hai nằm đúng ngưỡng 0,20. Hai dòng còn lại là một câu lời bài hát được nói nhanh trước khi đàn vào, và tiêu đề video đọc lên trước khi hát.
  - Khoảng an toàn hẹp. Dòng hát nhanh nhất trong đoạn cả bài ở lô 2 là 0,24 s/chữ. 15% câu hát ở tầng F có trung vị ≤ 0,20, nhưng đều nằm trong đoạn không phải cả bài, nên (a) không chạm tới.
  - Tác động nhỏ: trên model dự phòng đang chạy, (a) chỉ sửa 2/70 dòng gắn ♪ nhầm.
- **Sửa (`pipeline.mjs`, `server.mjs`, `content.js`):**
  - `lyricCues`: trong đoạn cả bài, dòng có câu là câu nói nhanh (`talkInSong`) không có ♪. Tiếng đệm nói nhanh ("哈哈哈哈") không tính là câu nói, vẫn bị bỏ như cũ.
  - Chế độ thường: đoạn cả bài chỉ giữ đúng các dòng mà chế độ lời bài hát hiện không có ♪, nên hai chế độ khớp nhau. Phần giữ lại dưới 4 chữ Hán thì vẫn bỏ cả đoạn: một câu nói 3 chữ đứng một mình có ở chế độ lời bài hát (không ♪) nhưng không có ở chế độ thường. Câu nói ngắn bị `segmentCues` gộp vào dòng hát thì cả hai chế độ coi là lời hát.
  - Kết quả của đoạn cả bài mang cờ `song`. `noSinging` (server) và `modeFree` (extension) không dùng chung kết quả có cờ này giữa hai chế độ.
  - Lý do của cờ: bản sửa đầu có lỗi lớn, cả hai verifier đều dựng lại được bằng server thật. Đoạn cả bài vì lặp lời mà không câu nào tự đủ là câu hát (điệp khúc câu 3 chữ, sung = 0) cộng một câu nói nhanh cho ra kết quả chế độ thường ok, sung 0, không dòng ♪. Server coi đó là "không có câu hát": xoá `.asr.`, rồi chế độ lời bài hát lấy lại kết quả đó và mất hết dòng ♪. Cache dùng hằng ngày có 1 đoạn đúng dạng này (file alpha-7 cũ, server hiện không đọc); lô 2 thì không có.
  - Chạy lại code mới trên kết quả nhận dạng thật đã lưu:
    - Lô 2 đổi đúng 4 dòng trên.
    - Lô 1 đổi đúng 4 dòng nói ở §6l.
    - Còn 5 dòng đổi cờ, chưa có nhãn: 4 dòng trong 3 video tự phát kế tiếp lúc đo lô 2, và 1 dòng trong cache dùng hằng ngày ("老辈子听的歌…", câu dẫn trước bài hát).
- **Không tăng `PIPELINE_VERSION`** (vẫn `alpha-8`).
  - Thay đổi chỉ chạm đoạn cả bài có câu nói nhanh: 8/837 dòng ở hai lô.
  - Tăng thì mọi kết quả `.vi.` và `.vi.lyr.` bị bỏ, phải nhận dạng và dịch lại. Lý do: file `.asr.` chỉ còn ở đoạn có hát, và tên file đó cũng có phiên bản.
  - File cũ của các đoạn đó giữ cách cũ (♪ cho câu nói; chế độ thường bỏ cả đoạn), không tệ hơn trước. Một đoạn có thể lệch giữa hai chế độ nếu chỉ một chế độ còn file cũ.
- **Luật alpha-8 trước (a), trên lô 2, theo nhãn lúc đo** (tính hát với nói, bỏ rap và dòng không rõ; ba số là độ chính xác của ♪, độ phủ, tỉ lệ dòng nói bị ♪):
  - Cả lô: 0,602 / 0,747 / 23,6%.
  - Tầng F: 0,93 / 0,589 / 2,7%. Độ chính xác gần lô 1, độ phủ thấp hơn vì nhiều bài hát nhanh.
  - Tầng Q: 0,457 / 0,983 / 42,4%.
  - 6 video feed ra sub (đều ở F): 0,875 / 0,368 / 1,2%. Trên feed, lỗi chính là thiếu ♪ ở bài hát nhanh.
  - Gộp hai lô: 0,684 / 0,792. Riêng phần Fun-ASR: 0,913 / 0,720.
  - Sau (a): cả lô 0,615 / 0,747 / 22,4%; F 0,964 / 0,589 / 1,4%; Q 0,465 / 0,983 / 41,2%; gộp hai lô 0,706 / 0,792. Feed không đổi.
- **Lỗi chính còn lại, theo nhãn lúc đo** (theo nhãn mới ở mục quyết định của chủ dự án):
  - Đọc chậm bị coi là hát: 66/70 dòng gắn nhầm ở Q.
    - Bé đọc 三字经 có 23/23 dòng ♪ (cả đoạn là bài hát); 三字经 tiếng Quảng 28/39; thiền 12/27; thơ 3/16.
    - Trung vị độ dài chữ của câu nói trong 4 video này là 0,34 s, trên ngưỡng 0,33.
    - Chế độ thường mất 74 dòng nói (203 s) trên cả lô; video bé đọc 三字经 mất toàn bộ phụ đề.
  - Số này phụ thuộc vào luật gán nhãn "đọc theo nhịp mà không có giai điệu là lời nói".
    - Ba video đọc (hai video 三字经 và video thơ, không gồm video thiền) chiếm 54/74 dòng gắn nhầm. Bỏ chúng thì độ chính xác 0,85 và dòng nói bị ♪ còn 8,5%.
    - Critic thấy dấu hiệu, chưa chắc, rằng 三字经 được đọc theo lưới nhịp 0,32 s, gần với hô vè. Ở video tiếng Quảng, nhịp đó có thể đến từ nhạc nền.
    - Chủ dự án đã quyết: đọc theo nhịp, 喊麦 và rap đều tính là hát (mục ngay dưới).
  - Hát nhanh thiếu ♪ ở tầng F: 35/37 dòng, câu ≤ 0,33 s/chữ (cover DJ 0/10, 雅俗共赏, 有何不可).
  - Chưa tách được phần do nội dung với phần do ASR, vì mọi video đọc chậm rơi vào tầng Q. Với lời nói hội thoại, trung vị độ dài chữ của hai ASR gần bằng nhau (0,16 và 0,15 s). qwen có đuôi dài hơn (19% câu > 0,33 so với 3%), nhưng mẫu nhỏ.
- **Hạn chế của phép đo:**
  - Không ai nghe trực tiếp.
  - Nhãn của khoảng 30% số dòng chủ yếu dựa vào chữ và ngữ cảnh. Giám khảo chữ và giám khảo lời bài hát gần như trùng nhau (477/485 dòng).
  - Người phản biện thấy nhãn chuẩn khi xét, nên tỉ lệ lỗi nhãn ước tính (khoảng 1%) chỉ là cận dưới.
  - Agent phân xử không ghi được file nhãn. Nhãn cuối lấy từ đầu ra của workflow (đầu ra của agent phân xử cộng phần sửa của người phản biện). Bản chép của agent phân tích khớp 485/485 dòng.
- **Phát hiện phụ:**
  - Gặp lượt tải video treo trên Douyin thật: video 7070135093603405087 báo "lỗi: tải video quá lâu" trong 17 s. Đoạn đó tải lại được, sub có từ giây 40.
  - Profile thử nghiệm bị đăng xuất sau khoảng 20 video, Douyin hiện hộp "登录后免费畅享高清视频". Đóng hộp và xem tiếp ở chế độ khách vẫn có sub.
  - Trang `/video/`: sub đầu tiên hiện sau 1–7 s.
- **Test mới:**
  - `test.mjs`: ngưỡng 0,20 (tính cả 0,20), câu hát 0,24 s/chữ, câu 2 chữ, dòng quá nửa nằm trong câu hát, câu của dòng là câu trùng nhiều nhất, tiếng đệm nói nhanh.
  - `lyrics-test.mjs`: hai chế độ với đoạn cả bài có câu nói nhanh; đoạn cả bài sung = 0, gửi chế độ thường trước rồi tới chế độ lời bài hát; câu nói ngắn gộp vào dòng hát; đoạn cả bài chỉ có câu nói 3 chữ.
  - `content-sim-test.mjs`: kết quả có cờ `song` được xin lại khi đổi nút.
  - Mỗi kiểm tra mới trượt trên code trước nó (HEAD, hay bản sửa đầu với ca sung = 0).
  - Sáu bản đột biến đều bị bắt: bỏ điều kiện tiếng đệm, bỏ điều kiện quá nửa, chọn câu theo mốc đầu, dùng `<` thay `≤`, chế độ thường lọc theo câu như bản sửa đầu, bỏ luật dưới 4 chữ Hán.
  - Soát độc lập 2 vòng. Vòng 1 có 2 verifier (code; độ khớp với phép đo và tài liệu). Vòng 2 có 1 verifier kiểm lại các chỗ sửa. Hai ca test thêm sau vòng 2 tôi tự kiểm bằng hai bản đột biến của verifier.
- **Quyết định của chủ dự án (1/11): đọc theo nhịp, 喊麦 và rap đều tính là hát.**
  - Hai câu trả lời: "tính là hát" cho 三字经, đồng dao, vè; rồi "cũng tính là hát" cho rap và 喊麦 (vè ứng tác trên nền nhạc).
  - "Hát" (có ♪; chế độ thường bỏ) giờ gồm hát có giai điệu, đọc theo nhịp bài có vần và nhịp cố định, 喊麦 và rap. Vẫn là lời nói: ngâm thơ tự do (thơ 艾青), giọng hướng dẫn thiền, nói chuyện thường.
  - **Không đổi code; người dùng thấy y như trước.** Chỉ cách chấm thay đổi.
  - Gán lại nhãn:
    - 51 dòng đọc 三字经 ở lô 2 thành hát (23 dòng của bé, 28 dòng của hai cha con; 11 dòng trò chuyện vẫn là nói).
    - 25 dòng 喊麦 ở lô 1: 21 dòng nhãn cũ rap_chant, cộng 4 dòng giám khảo phân vân giữa hát và đọc theo nhịp.
    - 27 dòng rap: 18 dòng 崂山道士 ở lô 1, 9 dòng rap trong lớp ở lô 2.
  - Luật hiện hành (có (a)), theo cách tính mới, ba số như trên. Hai phép tính độc lập ra cùng số; phần chung với bản trước đã có verifier tự tính lại.
    - Lô 2, ngoài mẫu: 0,896 / 0,776 / 7,3% (theo nhãn lúc đo: 0,615 / 0,747 / 22,4%).
      - Tầng F 0,964 / 0,535 / 1,4%; tầng Q 0,866 / 0,991 / 14,9%.
      - 6 video feed: 0,875 / 0,368 / 1,2% (không đổi).
    - Lô 1: 0,955 / 0,553 / 1,4%.
    - Gộp hai lô: 0,911 / 0,698 / 4,6%; riêng phần Fun-ASR 0,959 / 0,545.
    - Số lô 1 và số gộp có phần trong mẫu, vì (a) được chọn từ lỗi của lô 1.
    - Chế độ thường, lô 2: mất 19 dòng nói (63 s) với (a), 23 dòng (71 s) trước (a); 12 dòng trong đó thuộc video thiền. Các dòng đọc 三字经 không có sub ở chế độ thường là đúng ý; 11 dòng trò chuyện vẫn có.
  - Độ chính xác lô 2 tăng chủ yếu vì 51 dòng 三字经 mà model dự phòng gắn ♪ nay tính là đúng. Nhưng 三字经 có ♪ chỉ vì model dự phòng cho độ dài chữ 0,36 s. Đó cũng là cơ chế đang gắn ♪ nhầm cho thiền và thơ; hệ thống không nhận ra nhịp. Đọc nhanh hơn 0,33 s/chữ thì sẽ không có ♪.
  - 98 dòng hát thiếu ♪ ở hai lô:
    - 52 dòng rap và 喊麦: không dòng nào có ♪. Chế độ thường vẫn hiện chúng như lời nói.
    - 46 dòng hát khác: 37 ở tầng F lô 2 (gần hết là hát nhanh), 8 ở lô 1 (5 dòng hát nhanh, 3 câu chỉ có 3 chữ), 1 ở tầng Q.
    - Độ dài chữ không tách được loại này; cần đo nhịp từ âm thanh (§8).
  - Luật (a) không đổi kết luận: 8 dòng nó đổi ở hai lô đều là lời nói thường, không chạm dòng rap hay 喊麦 nào.
    - Rủi ro nay là lỗi thật nếu gặp: dòng hát nhanh (≤ 0,20 s/chữ, ≥ 3 chữ) sẽ mất ♪ nếu nằm trong đoạn cả bài, ví dụ một đoạn rap giữa bài hát; chế độ thường sẽ hiện nó như lời nói.
    - Dòng nhanh như vậy ở hai lô: 30/48 dòng 喊麦 và rap (lô 1: 21/39; lô 2: 9/9 dòng rap), 17/221 dòng hát (đều ở lô 2), 0/51 dòng 三字经. Chưa dòng nào nằm trong đoạn cả bài.
  - Lời nói chậm bị ♪: thiền 12 dòng, thơ 3 dòng ở mỗi lô. Ở chế độ thường, các dòng này mất.
  - Chưa biết Fun-ASR có gắn ♪ cho 三字经 không, vì hai video đọc đều chạy model dự phòng.
- **Lần đo sau:**
  - Ghi trước luật mới cho lời nói chậm trên model dự phòng.
  - Cần video đọc chậm chạy trên cả Fun-ASR lẫn qwen, nên phải có Fun-ASR trở lại.
  - Thêm livestream bán hàng và bài hát nhanh nằm trong đoạn cả bài (rủi ro của (a)).
  - Quy trình: agent phân xử có thư mục được ghi; người phản biện không thấy nhãn chuẩn; giám khảo chạy trong thư mục chỉ có dữ liệu mù.
  - Nhãn: đọc theo nhịp (三字经, đồng dao, vè), 喊麦 và rap đều gán là hát.
  - Thêm bài hát có đoạn rap: đó là chỗ (a) có thể bỏ ♪ nhầm.
- Mẫu âm thanh, ảnh chụp và cache đo đã xoá sau khi đo. Nhãn và số liệu chỉ để trên máy.

## 6o. Sub đầu khi mở video (first load), bước 1 (1/11, extension 0.2.25)

Đo lô 2 (§6n, 15 trang `/video/`): từ lúc video phát tới khi có kết quả mất trung vị 3,5 s, và video nào cũng mất vài giây lời đầu. Phân tích bằng workflow (2 scout dò đường đi, 1 verifier xếp hạng) ra 0,4–1,2 s có thể bớt trên trang `/video/`, 1–2 s ở modal tìm kiếm và video feed đầu. Bước 1 gồm 3 việc ít rủi ro; mỗi phía do một agent làm trên bản sao, có verifier soát và sửa, rồi một verifier ghép kiểm toàn bộ test.
- **Mốc thời gian (không đổi hành vi):** `content.js` ghi cho mỗi video đang xem các mốc so với lúc nó thành video đang xem: có item (kèm nguồn), thấy `<video>`, có metadata, bắt đầu phát, tải mục lục (moov), tải và gửi mẩu nhanh, có kết quả, gửi đoạn ở chỗ đang xem, vẽ sub đầu. Trả trong câu trả lời `{type:'status'}` (`marks`, 20 video gần nhất); định dạng ghi ở comment trong `content.js`.
- **Hàng dịch sẵn nhường video vừa mở** (việc còn mở ở §6i): video vừa mở chưa có kết quả ở chỗ đang xem thì hàng dịch sẵn không bắt đầu lượt tải mới cho tới khi video đó gửi được mẩu đầu, tối đa 2,5 s. Lượt tải dịch sẵn đang chạy thì để chạy tiếp (mô phỏng: ngắt thì bỏ phí gần gấp đôi byte mà video có sẵn kết quả khi lướt tới còn ít hơn).
- **Làm nóng kết nối:** video vừa mở chưa có kết quả thì extension báo `POST /v1/warm` (qua `background.js`, tối đa một lần mỗi 3 s). Server trả 204 rồi gọi thử (không key, không dữ liệu) tới đúng dịch vụ nhận dạng và dịch đang dùng, mỗi dịch vụ tối đa một lần mỗi 3 s, bỏ qua dịch vụ vừa có lệnh gọi thật. Lý do: `fetch` của Node đóng kết nối rảnh sau khoảng 4 s, nên lần gọi đầu của mỗi video thường phải mở kết nối mới.
- **Log server** ghi thời gian tới header và kết nối mới hay sẵn cho từng lệnh gọi, ví dụ `ASR 915 ms [đầu 912 ms, kết nối sẵn (làm nóng)]`, và một dòng cho mỗi lần làm nóng.
- **Đo trên Douyin thật** (1/11, chế độ khách, 19 trang `/video/` mới; có mốc thời gian ở 14 trang; 8 trang sau khi service worker đã là bản mới):
  - Item tới qua API chi tiết video sau 1,1–2,0 s; extension bắt đầu tải mục lục ngay lúc đó, trước khi video phát (2,1–3,5 s).
  - Tải mục lục mất 0,7–1,7 s (3/14 lần chậm: 4,5, 6,1 và 8,9 s); tải mẩu nhanh 0,4–1,2 s (có lần 1,9 và 2,8 s); mẩu nhanh thường được gửi khoảng lúc video bắt đầu phát.
  - Sau khi video phát, phần còn lại chủ yếu là server: mẩu nhanh có dịch về sau 1,7–2,6 s; 4 video có lời: kết quả sẵn sàng 2,4–2,8 s sau khi phát. Không so thẳng được với 3,5 s của lô 2 vì khác video, khác chế độ đăng nhập và khác model nhận dạng.
  - Làm nóng: 6/8 video có lượt nhận dạng đầu (và lượt dịch nếu có) chạy trên kết nối do làm nóng mở. Trước đó mỗi lượt mở kết nối mới mất 97–257 ms (nhận dạng) và 62–76 ms (dịch), tức bớt khoảng 0,15–0,3 s mỗi video. Một video tải mục lục 4,5 s nên kết nối làm nóng đã bị đóng trước khi kịp dùng.
  - Hàng dịch sẵn nhường video vừa mở chưa đo trên Douyin thật (chỉ có mô phỏng); cần đo ở modal tìm kiếm và video feed đầu.
- **Đánh đổi (mô phỏng, chưa đo thật):** lướt feed nhanh (2,5–4 s mỗi video) ngay sau khi tải lại trang thì video thứ 2–4 có kết quả muộn hơn 0,3–0,5 s; lướt chậm hơn thì bằng hoặc tốt hơn. Mạng chậm mà lướt nhanh thì gửi rồi huỷ nhiều yêu cầu hơn; huỷ giữa lúc nhận dạng có thể vẫn tốn tiền (đếm "huỷ" trong log server khi đo).
- **Bẫy khi cập nhật extension:** sau khi đổi file extension, Chrome có thể vẫn chạy service worker (`background.js`) cũ dù đã khởi động lại trình duyệt, trong khi content script đã là bản mới. Lần đo đầu bị đúng lỗi này (không có lời làm nóng nào tới server). Sau khi cập nhật, bấm Reload extension ở `chrome://extensions` rồi kiểm phiên bản.
- **Test:** content-time 15 (thêm 4, đổi kỳ vọng ca "đường truyền chậm đều": nay mẩu nhanh tải kịp, sub đầu ở giây 9,75 thay vì 37 khi 3500 B/s), background-test 2 (mới), warm-test 12 (mới); mọi bộ khác và e2e 26/26 đạt. Kiểm tra mới trượt trên code trước.
- **Bước sau (chưa làm):** một lượt tải cho cả mục lục và mẩu nhanh (bớt một lượt hỏi máy chủ video, phần lớn nhất còn lại phía extension); làm nóng lại nếu tải mục lục quá 3 s; dịch trả dần từng dòng (0,2–0,4 s, công lớn); hiện thêm 1–2 s dòng vừa nói xong khi kết quả đầu về (chủ dự án quyết); bỏ lần gọi Fun-ASR chắc chắn hỏng sau khi khởi động server (đụng chính sách §6k, chủ dự án quyết).

## 6p. Sub đầu khi mở video, bước 2: một lượt tải cho mục lục và đoạn đầu (1/11, extension 0.2.26)

Bước 1 (§6o) đo được: tải mục lục 0,7–1,7 s rồi mới tải mẩu nhanh bằng một lượt nữa; đoạn 0 tải lại phần đầu file, bị mẩu nhanh ngắt rồi tải lại.
- **Cách làm:** mở video từ đầu thì một lượt `Range: bytes=0-` qua `/aweme/v1/play/` (`loadHead` trong `content.js`). Đọc mục lục ngay khi đủ byte, đọc tiếp trên chính lượt đó tới hết âm thanh đoạn 0, rồi ngắt. q0 và đoạn 0 cắt từ phần đã nhận. Dịch sẵn trên feed cũng vậy. Mở giữa video (chỗ đang xem từ giây 10) thì giữ lượt 64 KB cũ.
- **Giữ nguyên:** không có moov trong 64 KB đầu thì báo lỗi như cũ; máy chủ trả 200 cả file thì đọc tới chỗ cần rồi ngắt (cỡ file theo Content-Length); 429 nghỉ chung; lướt đi, `dropSlow`, tắt sub thì ngắt; luật xin lại sau khi đổi chế độ lời bài hát gửi đúng byte cũ.
- **Treo, lỗi hay chậm giữa chừng:** trước khi có mục lục thì gọi lại sau 4 s như cũ. Sau đó q0 rồi đoạn 0 tải nối tiếp phần còn thiếu, lần lượt, không tải lại phần đã nhận. Lượt đó chậm tới mức q0 phải chờ quá 6 s (và không có video khác đang tải) thì cũng thôi lượt đó (`headLate`), để có lượt mới và mốc so cho `dropSlow`.
- **Mô phỏng** (đồng hồ giả, video 2 Mbit/s, moov 40 KB; chưa đo thật):
  - Trang `/video/`: q0 gửi sớm hơn 1,25–4 s, đoạn 0 sớm hơn 0,1–2,3 s. Video đang phát sẵn: q0 sớm hơn 0,3–0,5 s, đoạn 0 sớm hơn 1,1–2,6 s.
  - Số lượt tải tới máy chủ video: 2–4 xuống 1.
  - Byte: 9,6–12 MB xuống 6,6 MB khi bản cũ có tải q0 hay tải lại đoạn 0. Ở 6 MB/s (bản cũ không gửi q0) thì bằng hoặc nhỉnh hơn (6,57 → 6,60 MB; moov 150 KB: 6,72 → 6,90 MB), do đọc quá chỗ cần.
  - Lượt đầu video 1040 B/s từ byte 0, lượt nối tiếp nhanh: sub đầu giây 7,5 (bản cũ 12,5), có sub 20/20 s của [10,30) (bản cũ 16,5).
  - Lượt nối tiếp của đoạn 0 cũng chậm (cùng link CDN; 1040 B/s là tốc độ đo 1/11, đoạn 0 mất ~25 s): lượt nối tiếp chỉ còn 14000/26000 byte nên sub vừa kịp trước giây 20 và `dropSlow` không bỏ đoạn. Bản vá đầu ở 1040 / 1200 / 1400 B/s: sub đầu giây 19,5 / 17,75 / 16, có sub 7,75 / 11,25 / 14 s (bản cũ 12,5 s và 16,5 s). Nay `dropSlow` bỏ cả khi sub chỉ tới lúc đoạn còn dưới 5 s (`SLOW_KEEP`): 560–1400 B/s đều 12,5 s và 16,5 s như bản cũ. Test canh ca 560, 1040, 1400 B/s.
  - `SLOW_KEEP` cũng đổi ca chậm từ byte 12000 (sau phần của q0): 1040 B/s sub đầu giây 17 → 12,5 (có sub 12,5 → 16,5 s), 1200 B/s 15,25 → 12,5. Từ 1400 B/s trở lên không đổi. Ca lướt feed nhanh dưới đây không đổi số nào.
  - Chưa sửa: 1600–2000 B/s chậm từ byte 0, sub đầu giây 15,25–18,5 (bản cũ 15,5–18,75). q0 chờ trên lượt đó chưa quá 6 s nên lượt đó không bị thôi (`headLate`), `dropSlow` không có lượt nhanh nào để so (q0 gửi lúc 8 s, chỉ 3 lượt tải).
- **Đánh đổi (mô phỏng lướt feed, 6 video; bản cũ → nay; "giây ASR" là số giây âm thanh gửi nhận dạng, phần tốn tiền):** q0 gửi sớm hơn nên hàng dịch sẵn hết nhường sớm hơn, video nào cũng kịp gửi nhiều hơn.
  - Lướt nhanh (1–3 s mỗi video) tải nhiều byte hơn, gửi rồi huỷ nhiều hơn. Nặng nhất: 6 MB/s, 1 s/video: 23,4 → 41,4 MB (+77%), giây ASR 30 → 80, huỷ 0 → 2. 3 MB/s, 1,5 s/video: 25,5 → 36,6 MB, giây ASR 10 → 61, huỷ 0 → 3. 3 MB/s, 2 s/video: 42,8 → 47,0 MB, giây ASR 62 → 141, huỷ 3 → 7.
  - Từ 4 s mỗi video, byte gần bằng (79,3 → 81,1 MB ở 3 MB/s 4 s; 110,5 → 110,2 MB ở 6 MB/s 6 s). Số huỷ: 3 MB/s 4 → 2 (4 s) và 1 → 3 (6 s); 6 MB/s 5 → 4 và 2 → 0; 1,5 MB/s 1 → 4 và 0 → 1. Giây ASR: 3 MB/s 170 → 227,5 (4 s) và 227,5 → 302,5 (6 s); 6 MB/s 330 → 320 và 347,5 → 347,5; 1,5 MB/s 21 → 140 và 100 → 140 (bản cũ gần như không kịp gửi gì: 2 lần gửi so với 10 ở 4 s).
- **Test bổ sung sau lượt soát cuối:** ca lượt nối tiếp cũng chậm 1040 và 1400 B/s (trượt trên bản vá đầu: sub đầu giây 19,5), kiểm `prog.bytes` của lượt nối tiếp, và ca lượt đầu video treo trong lúc nghỉ sau 429 (bỏ kiểm `rateWait` ở đầu `loadHead` thì trượt: lần gọi lại sau 4 s rơi vào lúc nghỉ). content-time 27 kiểm tra. Hai nhánh chưa có test bắt khi bỏ đi, vì ảnh hưởng nhỏ (theo đọc code): không ngắt đoạn khi mẩu nhanh lấy từ lượt tải đầu video (bỏ đi thì đoạn 0 chờ lại trên chính lượt đó, không thêm lượt tải); `headCheck` khi một lượt chờ bị huỷ (bỏ đi thì lượt tải vẫn dừng ở lần nhận byte kế tiếp, hay sau 6 s im).
- **Đo trên Douyin thật** (1/11, chế độ khách, 6 trang `/video/` mới, mốc thời gian của bước 1):
  - Từ lúc có item tới lúc gửi mẩu nhanh: 0,70–2,11 s, trung vị 0,91 s. Bước 1 (8 video): 1,64–4,63 s, trung vị 1,93 s.
  - Lượt tải đầu video có mục lục sau 0,57–1,43 s; byte của mẩu nhanh về thêm 0,02–0,67 s sau đó; đoạn 0 gửi ngay sau mẩu nhanh 0,02–0,8 s (bước 1: 1–2 s).
  - Mẩu nhanh được gửi trước lúc video phát ở 5/6 video. Kết quả mẩu nhanh về sau khi phát trung vị khoảng 1,15 s; 2 video có kết quả trước cả lúc phát. Video chậm nhất là do server mất 4,1 s.
  - Phần còn lại sau khi video phát gần như chỉ là thời gian của server (nhận dạng và dịch).
- **Còn mở:** ngưỡng giây 10 và 6 s mới chọn theo mô phỏng; CDN giới hạn tốc độ theo kết nối chưa có số đo; chưa đo trên feed và modal tìm kiếm với bản này. Bộ đệm `h.parts` của lượt tải đầu video được giữ tới hết đoạn 1 (khoảng 13 MB với video 2 Mbit/s), và tiến độ `prog.bytes` không chỉnh cho đoạn 1 khi đoạn đó dùng lại phần đã nhận (verifier vòng sau ghi nhận, chưa sửa).

## 6q. Xưng hô tiếng Việt (anh/em, chị/em…) (2/11, extension 0.2.27)

Chủ dự án báo đại từ nhân xưng chưa đúng.
- **Soát** (workflow 3 agent trên 837 dòng dịch thật của 35 video lô 1 và lô 2; verifier kiểm lại cả 62 dòng): 62 dòng (7,4%) sai (32) hay lệch nhau (30), ở 18 video. Hay gặp nhất: lời hát đổi xưng hô khi sang đoạn mới (13), cùng một người bị gọi khác nhau (12), sai vai hay sai giới (10), đảo vai trong lời hát (8), nhầm người nghe (7), một dòng có hai người nói (5).
- **Sửa** (2 thợ code, mỗi phía một verifier, một lượt sửa, một verifier ghép kiểm):
  - Câu lệnh dịch có khối luật xưng hô: xác định ai nói với ai trong từng cảnh (tiếng gọi 姐姐/哥/老师/宝宝/大家), chọn cặp đúng vai và giới rồi giữ; lời hát giữ một cặp cho cả bài, bài thiếu nhi không dùng anh/em.
  - Lượt dịch trả thêm bảng xưng hô (`pronouns`, đứng trước `cues`); chỉ ghi cặp mới hay cặp đổi để đỡ tốn chữ đầu ra. Extension giữ bảng mới nhất của từng video và gửi lại với mọi yêu cầu sau của video đó (không sang video khác). Server còn đọc bảng trong file cache của đoạn trước, nên đoạn gửi cùng lúc cũng có bảng.
  - `tap.main.js` lấy tên và giới tính người đăng; câu lệnh dùng làm gợi ý.
  - Không tăng `PIPELINE_VERSION`: file cache cũ giữ bản dịch cũ.
- **Chi phí:** câu lệnh dài thêm khoảng 1.500 ký tự (ước 450–550 token vào mỗi lượt dịch); chưa đo độ trễ thêm trên dịch vụ thật.
- **Thử trên Douyin thật** (1 video người hát rong 7518362235144998203): xưng hô nhất quán em/chị; 4 dòng soát ra là sai ở video này đều đúng ("Chị có bạn trai chưa?" thay cho "Em có bạn trai chưa?", "Em yêu chị" thay cho "Em yêu anh"). Dòng đầu ghép lời hai người nói vẫn gán một vai.
- **Test:** pronoun-test 21 (mới), content-sim 51, e2e 29; mọi bộ khác đạt.
- **Còn mở:** đo lại tỉ lệ lỗi trên một lô mới; độ trễ thêm của sub đầu do câu lệnh dài hơn; dòng có hai người nói (do ASR gộp câu).

## 6r. Thử sửa xưng hô đợt 2: không giữ (2/11)

Một agent test như người dùng thật (10 video, chế độ khách), rồi 3 verifier kiểm lại 20 điểm. Lỗi lớn nhất: bảng xưng hô không bao giờ lớn thêm. Ở 44/44 đoạn có bảng gửi vào, model không thêm cũng không sửa cặp nào, vì câu lệnh bảo "không có gì mới thì pairs rỗng". Show hẹn hò 7681136832927185521: nữ khách mời số 2 xưng "chị" rồi "em" với cùng một người.
- **Đã thử.** Mỗi bản dịch lại cùng các dòng chữ Hán đã cache của 9 video, theo đúng cách truyền bảng và ngữ cảnh của server. Mỗi video 2 giám khảo mù đếm lỗi xưng hô trên 3 bản, nhãn X/Y/Z xáo. Các bản:
  - ghi mọi cặp ở mỗi đoạn, thêm luật (lời kể ngôi ba, chuyện kể bằng 你, thầy cô với học sinh, khách mời nói với trường quay, 他/她), bảng 10 cặp;
  - thêm chỉ số cặp cho từng dòng; tách người nói và người nghe thành hai ô trong schema;
  - luật cũ, chỉ thêm phần ghi mọi cặp và hai ô người nói, người nghe;
  - câu lệnh cũ trên model dịch mạnh hơn;
  - một lượt soát xưng hô sau lượt dịch (bằng model hiện tại, hoặc model mạnh hơn);
  - nhiệt độ 0; 12 dòng ngữ cảnh thay vì 3.
- **Kết quả** (tổng lỗi của 2 giám khảo, so với câu lệnh cũ trong cùng lần đo): câu lệnh cũ thắng 9/11 lần so.
  - Ghi mọi cặp + luật mới: 80 so với 81, rồi 77 so với 56.
  - Thêm hai ô người nói, người nghe: 67 so với 56. Luật cũ + phần cấu trúc: 112 so với 105, rồi 95 so với 61.
  - Model mạnh hơn: 79 so với 105, rồi 72 so với 61. Tốt hơn ở video độc thoại, kém hơn ở show hẹn hò cả hai lần.
  - Lượt soát: 79 và 128 so với 48. Nhiệt độ 0 và 12 dòng ngữ cảnh: cùng 79 so với 50.
  - Không phải giám khảo thiên vị: ở mẩu nhanh và đoạn 0, câu lệnh cũ và bản 12 dòng ngữ cảnh gửi đúng một câu lệnh, lỗi ngang nhau (13 so với 16); khác biệt chỉ ở các đoạn sau.
- **Bài học:**
  - Cùng một câu lệnh, hai lần dịch lệch tới 81 và 56 lỗi. Chỉ tin so cặp trong cùng lần đo, và cần ít nhất 2 lần lặp.
  - Luật thêm vào hay làm lời kể dùng luôn từ xưng hô của nhân vật ("em gái số 2", "em ấy") và gắn sai giới.
  - Bảng lớn thêm không làm bản dịch tốt hơn.
  - Đo bằng chấm mù trước khi nói "đã sửa", không chỉ đo cấu trúc (bảng có lớn thêm không).
- **Quyết định:** giữ câu lệnh của 0.2.27.

## 6s. Hạn thời gian của lượt gọi dịch (2/11, server)

- **Lỗi:** mỗi lượt gọi model dịch có hạn 10 s, quá hạn thì gọi lại ngay, tối đa 3 lần. Đo 2/11 lúc dịch vụ chậm (khoảng 35 token/giây): đoạn 30 s cần 9–12 s, cả 4 lần đều quá hạn, 19/54 lượt dịch hỏng sau khoảng 40 s. Lúc dịch vụ nhanh, đoạn 20–50 s của show hẹn hò vẫn mất 9,5 s, sát hạn.
- **Sửa:**
  - Lượt gọi model dịch có hạn tăng dần 10 s, 20 s rồi 30 s. Lần đầu vẫn cắt ở 10 s để bỏ kết nối treo.
  - Quá hạn lần thứ 3 thì thôi: tổng chờ tối đa 60 s, không gọi lần thứ tư như trước.
  - Lượt rút gọn là tuỳ chọn, nên chỉ chờ tối đa 20 s; quá thì giữ dòng đầy đủ.
  - Nhận dạng giọng nói (DashScope, Gemini) giữ hạn cố định như cũ.
  - `MT_TIMEOUT_MS` chỉ để test đặt hạn ngắn: sai dạng thì về 10 s, và server không còn báo nhầm là biến không dùng.
- **Kiểm:** một verifier soát diff (ship_with_fixes, 0 lỗi chặn). Đã áp: chặn ở 3 lần quá hạn, hạn riêng cho lượt rút gọn, kiểm giá trị `MT_TIMEOUT_MS`, gom chính sách hạn vào một chỗ (`mtJson`). Chưa làm: tăng hạn lần đầu lên 15 s để đoạn cần 10–12 s khỏi phải gọi lại; đánh đổi là kết nối treo bị cắt muộn hơn 5 s.
- **Test:** errors-test 14. Ba kiểm tra mới:
  - dịch giả trả lời sau 600 ms, hạn lần đầu 400 ms: vẫn có sub; với hạn cố định cũ thì đoạn báo lỗi;
  - dịch vụ treo hẳn: đúng 3 lượt gọi, log lần cuối "thôi, báo lỗi";
  - lượt rút gọn treo: giữ dòng đầy đủ sau 2 lượt gọi.
  - Chạy thử trên bản sao code bỏ từng phần sửa thì đúng kiểm tra tương ứng hỏng. Mọi bộ khác đạt.
- **Bẫy khi đo:** máy Mac chạy pin về đêm thì vào "Maintenance Sleep". Lô đo kéo từ 10 phút lên 2,4 giờ, warm-test hỏng ECONNRESET dù code đúng. Xem `pmset -g log` trước khi tin một lần chạy chậm hay chập chờn.

## 6t. Video dài: sub đứt quãng vì dịch không kịp (2/11, extension 0.2.28)

- **Chủ dự án báo:** xem một video dài (678 s) trên feed thì sub cứ ngắt quãng.
- **Log và mốc của extension lúc đó:**
  - Server không chậm: nhận dạng ~1 s, dịch 1–4 s mỗi đoạn.
  - Lượt tải đoạn 0 bắt đầu từ lúc dịch sẵn, 4,2 s trước khi mở video, và không bao giờ xong. Mục lục mất 3,9 s.
  - Đoạn [0,20) và [20,50) không tới server. Có mẩu nhanh 0–10 s, rồi các mẩu nối tiếp từ giây 22.
  - Trong 15 s đầu, hàng dịch sẵn gửi đoạn đầu của 4 video kế.
- **Cách đo, dùng lại được** (scratchpad của phiên, không vào repo):
  - Chromium for Testing riêng: cổng 9334, profile tạm, tắt tiếng.
  - Server riêng: cổng 8788, cache riêng.
  - Mở `https://www.douyin.com/jingxuan?modal_id=<id>` (khách không mở được `/video/<id>`, bị chuyển sang 精选).
  - Giới hạn tải về cho cả tab bằng CDP `Network.emulateNetworkConditions`.
  - Mẫu mỗi 250 ms: chỗ đang xem, nhãn, sub. Mọi lượt tải video qua CDP Network. Log server.
- **Đo trên video đó (103 MB, 1,2 Mbit/s, âm thanh 128 kbit/s), bản 0.2.27:**
  - Mạng tốt (1–3 MB/s): theo kịp, chỉ 2,5 s "đang dịch" trong 180 s.
  - Giới hạn 450 KB/s: 66% thời gian phát hiện "đang dịch", đoạn nào cũng về muộn 12–18 s.
    - Mỗi đoạn 30 s là 5–6 MB, tải mất 20–28 s, cộng 6–7 s ở server.
    - Đoạn kế chỉ bắt đầu tải khi đoạn ở chỗ đang xem đã có kết quả, nên mỗi vòng quá 30 s: đã trễ là trễ mãi.
    - 2 phút đầu hàng dịch sẵn tải ~20 MB đoạn đầu của 4 video kế, chia đường truyền với video đang xem.
  - Tải riêng phần tiếng vẫn không được (như §6c): đoạn 37,5 s có 0,6 MB tiếng nằm trong 5,3 MB, chia làm 1.125 mẩu xen giữa hình.
    - CDN có nhận Range nhiều khoảng (trả `multipart/byteranges` cho 3 khoảng).
    - Không dùng: một yêu cầu cả nghìn khoảng là kiểu yêu cầu bất thường (giống tấn công Range) với CDN của Douyin.
  - Trình phát của trang tự tải tiếng riêng (DASH, `media-audio-und-mp4a`). `bit_rate_audio` từng trả 403 ở S1, chưa thử lại.
- **Sửa: chế độ video dài.** Video đang xem đã phát quá 10 s (`WATCH_MS`, tính theo thời gian phát) thì:
  - Hàng dịch sẵn không bắt đầu lượt tải mới khi video đang xem còn đoạn đang cần mà chưa tải xong (`currentBehind`).
    - Lượt dịch sẵn đang chạy thì để chạy nốt.
    - Video đang xem không nhận byte nào quá 1,5 s (CDN treo) thì không giữ.
    - Đoạn đã tải xong, chờ lượt gửi thì không giữ.
  - Đoạn kế tải ngay khi đoạn ở chỗ đang xem đã gửi server (`holdBack` chỉ chờ lúc nó còn đang tải).
    - Tải xong thì chờ đoạn đó và đoạn liền trước có kết quả rồi mới gửi (`sendWait`), nên bảng xưng hô và ngữ cảnh đi theo thứ tự như cũ.
    - Đoạn đã thành gấp thì gửi luôn.
  - Đoạn còn xa không tải chung với mẩu nhanh đang tải cho chỗ đang xem.
  - Dịch trước 60 s thay vì 30 s (`LOOKAHEAD_LONG`) chỉ khi ước một đoạn 30 s tải quá 10 s theo tốc độ đo được của video đó (`SLOW_CHUNK_MS`), và giữ luôn cho video đó.
  - 10 s đầu y như 0.2.27.
    - Mô phỏng lướt feed: bật các luật này ngay từ lúc mở thì lướt 4 s/video còn 3/12 video có sẵn kết quả thay vì 4/12; mạng chậm lướt 8 s/video có 2 video không kịp có sub.
    - Bật từ giây 8, 10 hay 12 thì kết quả lướt y như cũ.
- **Đo lại trên Douyin thật, cùng video:**
  - Giới hạn 450 KB/s: "đang dịch" 35% trong 180 s (bản cũ 66% trong 150 s). Đoạn về muộn giảm dần 19,2 → 18,7 → 8,7 → 5,7 → 3,7 → 0,8 s, từ đoạn 170–200 thì về trước chỗ đang xem.
  - Mạng tốt (bản giữa chừng, luôn dịch trước 60 s): 3,8 s "đang dịch" trong 150 s, chỉ trước khi mẩu đầu về; dịch sẵn vẫn chạy.
- **Mô phỏng** (`content-time-test`, video 600 s, server 6 s): "đang dịch" trên 150 s giảm từ 82,25 s xuống 55 s ở 3000 B/s, và từ 24,5 s xuống 17,5 s ở 6000 B/s. Lướt 4 s và 8 s/video ở 9000 và 3000 B/s y như 0.2.27.
- **Kiểm:** một verifier soát diff, có mô phỏng riêng (ok_with_fixes, 0 lỗi chặn, không thấy kẹt). Đã áp:
  - dịch trước 60 s chỉ khi tải chậm: mạng nhanh thì không bớt "đang dịch", mà người ở lại 12–25 s rồi lướt đi trả thêm 22–48% lượt nhận dạng, dịch;
  - dò lại video đang xem sau khi chờ lượt gửi (trước đó lần dò hụt làm tải lại đoạn đã tải);
  - chờ cả đoạn liền trước để bảng xưng hô theo thứ tự;
  - đoạn chờ lượt gửi không giữ hàng dịch sẵn lúc dừng xem;
  - `prog.bytes` theo phần phải tải ở lượt nối tiếp;
  - tính 10 s theo thời gian phát.
- **Chưa làm** (verifier nêu, nhẹ):
  - CDN chậm theo từng lượt (§6d) mà danh sách feed tới muộn: hàng dịch sẵn bị giữ suốt lúc video đang xem còn trễ, dù giữ không giúp gì.
  - Đoạn gấp trả lỗi thì đoạn kế (đã cắt với 1,5 s gửi dư) không có 8 s ngữ cảnh như sau khi tua.
  - Đoạn gấp bị huỷ hay đổi chế độ lời bài hát lúc ở server: đoạn kế có thể gửi trước lần xin lại.
  - Tua lùi về sát đoạn gấp đang ở server: đoạn ở chỗ tua chờ tới khi đoạn gấp xong; mẩu nhanh vẫn phủ.
- **Còn lại:**
  - Phần đầu vẫn trễ trên mạng chậm: lượt dịch sẵn bắt đầu trong 10 s đầu vẫn chạy nốt; lúc vào trang, mục lục tải chung với chính trang Douyin (đo: 21 s cho 0,7 MB).
  - Đường truyền dưới ~2 lần bitrate video thì vẫn không kịp: mỗi đoạn tải 5–6 MB để lấy 0,6 MB tiếng.
  - Hướng lớn nếu cần: tải tiếng riêng như trình phát (thử lại `bit_rate_audio`), cần chủ dự án quyết và đo lại.
- **Test:** content-time-test thêm hai ca (29 kiểm tra): xem video dài trên đường truyền chậm; đoạn kế chờ lượt gửi rồi mang bản xưng hô của đoạn trước, kể cả khi dò hụt video lúc hết chờ. Bản 0.2.27 trượt cả hai. Content-sim-test giữ nguyên 51 kiểm tra, đều đạt. e2e 29 kiểm tra đạt.

## 6u. Rê chuột vào nhãn: thông tin đã dịch của video đang xem (2/11, extension 0.2.29)

- Chủ dự án muốn: rê chuột vào nhãn ("VI", "VI · đang dịch…") thì thấy video đang xem đã dịch tới đâu.
- Bảng hiện ngay dưới nhãn, cập nhật 4 lần/giây, rời nhãn (hay chuột ra khỏi cửa sổ) thì ẩn. Nội dung:
  - thời lượng video, chỗ đang xem;
  - đã xong tới đâu tính từ chỗ đang xem (đoạn liền nhau đã xong, hay mẩu nhanh đang phủ chỗ đó). "Xong" là có bản dịch hay không cần dịch (nhạc, không lời); bỏ qua vì dịch lỗi thì chưa xong;
  - số đoạn đã xong / tổng số đoạn, số dòng, số dòng ♪;
  - tối đa 8 đoạn gần chỗ đang xem (▶ là đoạn đang phát): ✓ số dòng, bỏ qua (lý do), lỗi, đang tải %, đã tải chờ đoạn trước, đang dịch ở server (bao lâu rồi), chờ tải;
  - mẩu nhanh gần đây, bảng xưng hô (tối đa 3 cặp), đang dịch trước bao xa, chế độ lời bài hát.
- Lớp phủ vẫn `pointer-events: none`: không bắt chuột, chỉ đọc vị trí chuột (`mousemove` ở window) rồi so với khung của nhãn. Click ở chỗ nhãn vẫn tới trang Douyin bên dưới (nút đóng modal có thể nằm đó).
- Chữ đặt bằng `textContent` (tên trong bảng xưng hô đến từ server, không chèn HTML).
- Nhãn dời khỏi chuột mà chuột không động (vào/thoát toàn màn hình): xét lại theo vị trí chuột cuối. Lướt sang video khác thì bảng đổi ngay. Lỗi khi dựng chữ không làm hỏng phần vẽ sub.
- Đã xem trên Douyin thật (video 678 s, giây 40): bảng ghi đã dịch tới 1:20, 3/23 đoạn, 22 dòng, ba đoạn ✓, xưng hô hai cặp; rời nhãn thì ẩn.
- Kiểm: một verifier soát diff, có chạy thử các trạng thái lạ (ok_with_fixes, 0 lỗi chặn; không chặn click, không chèn HTML, không đổi hành vi tải và gửi). Đã áp: phần trăm tải đúng ở lượt nối tiếp sau lượt tải đầu video; đoạn dịch lỗi không tính là xong; đóng khi nhãn dời đi; lướt video thì đổi ngay; chỗ đang xem ngoài lưới đoạn thì liệt kê đoạn gần nó; mẩu nhanh ở server có số giây. Không làm: chờ ~300 ms mới mở (bảng có thể che nút Douyin nằm dưới nhãn, không chặn click); đoạn vừa bị huỷ có thể hiện "đang tải 99%" một lúc.
- Test: content-sim-test 52 (rê vào thì hiện đúng các dòng, đoạn chưa cần thì không liệt kê, đoạn dịch lỗi không tính là xong, rời ra thì ẩn, lướt video thì đổi, tắt sub thì ẩn), e2e 30 (rê chuột thật trong Chromium).

## 6v. Video ngay sau slide livestream: "đang dịch" rất lâu (2/11, extension 0.2.30)

- **Chủ dự án báo:** lướt qua livestream thì video ngay dưới không được dịch.
- **Đo trên Douyin thật** bằng script chỉ đọc (Chromium của chủ dự án, cổng 9333). Mỗi 250 ms ghi slide đang hiện, `feed-active-video`, các `<video>`, nhãn, sub. Mỗi giây hỏi extension `status` (nay có `cur`: video đang xem, đã có thông tin chưa, thuộc danh sách nào, video kế sẽ dịch sẵn, trạng thái từng đoạn). Ghi kèm các API `/aweme/` trang gọi.
- **Slide livestream:** `data-e2e="feed-live"` trong `live-slider`, không có `feed-active-video` và không có `data-e2e-vid`. Extension không thấy video đang xem, sau 1 s thôi video cũ, dịch sẵn chạy tiếp (đúng như thiết kế).
- **Lần lỗi (14:29):**
  - Mở trang: extension chỉ biết 2 video (HTML trang). `/aweme/v1/web/tab/feed/` chỉ được gọi khi lướt tới video thứ 2. Thông tin video sau livestream tới 1 s trước khi lướt tới nó.
  - Lượt tải đầu của video đó (bắt đầu ở hàng dịch sẵn) chậm riêng: mục lục 4,3 s, đoạn 0 thêm 17 s. Hai video dịch sẵn chạy cùng lúc tải xong trong ~3 s; video dịch sẵn thứ 3 không tới server.
  - `headLate` (thôi lượt đầu chậm, tải q0 bằng lượt mới) không chạy vì `othersLoading()`: có video khác đang nhận byte thì coi là đường truyền đang chia.
  - Kết quả: "VI · đang dịch…" 23 s.
  - Lần trước đó (14:23), video sau livestream có sub sau ~1 s (đã có trong cache server).
- **Sửa:** `othersLoading(rate, since)` so tốc độ của lượt đang xét. Hai trường hợp coi là đường truyền còn dư, tức lượt đang xét chậm riêng (`headLate` và `dropSlow` vẫn chạy):
  - có lượt tải (video nào cũng được) chạy cùng lúc với nó (bắt đầu sau nó, cho dư 1 s) đã xong nhanh gấp 3 trở lên (`fastDone`, ghi ở `noteSpeed`);
  - lượt của video khác đang tải mà nhanh gấp 3 trở lên thì không tính.

  Lượt nhanh xong từ trước khi lượt đang xét bắt đầu thì không tính.
  - Bản sửa đầu có tính, và verifier chỉ ra rằng đường truyền vừa chậm đi (trình phát, livestream, tab khác) thì `headLate`, `dropSlow` lại chia nhỏ lượt tải.
  - Mô phỏng của verifier: có sub 13 s thay vì 35,75 s trong 60 s đầu.
  - `dropSlow`: lúc đường truyền đang chia thì như cũ không xét, và đo tốc độ lại từ đầu.
- **Kiểm:** verifier soát bản sửa đầu (ok_with_fixes, 1 major, có mô phỏng A/B). Đã áp:
  - chỉ tính lượt nhanh chạy cùng lúc;
  - `rate > 0`;
  - đo lại cửa sổ tốc độ của `dropSlow` sau lúc chia;
  - dựng lại test cho giống bản đo, thêm ca đối chứng.

  Lướt feed, vào trang khi mạng chậm đều, chế độ video dài: kết quả như 0.2.29 (verifier chạy mô phỏng).
- **Test:** content-time-test thêm một ca, 30 kiểm tra:
  - (a) như bản đo: một video dịch sẵn chạy cùng lượt đầu chậm của Y, xong nhanh; một video khác chậm còn đang tải. Có sub sau ≤ 6 s; 0.2.29 không có sub.
  - (b) video dịch sẵn nhanh còn đang tải: ≤ 6 s; 0.2.29: 16 s.
  - (c) đối chứng: cả đường truyền giảm sau một lượt nhanh. Không có lượt q0 nối tiếp, sub như 0.2.29 (8,75 s và 9,75 s); bản sửa đầu không có sub trong 17 s.

  Ca "Đường truyền chậm đều lúc vào trang" chỉ kiểm mạng chậm ngay từ đầu, không có lượt nhanh nào trước; ca (c) mới kiểm mạng chậm đi giữa chừng.
- **Lần đo thứ hai (14:41, bản 0.2.30, lướt ~1 s/video qua 2 livestream):**
  - Video sau livestream thứ nhất có sub ngay.
  - Video sau livestream thứ hai đã gửi dịch sẵn 7 s trước, mà "đang dịch" 12 s nữa. Server: nhận dạng 2,7 s, dịch 16,2 s (lượt gọi OpenAI đầu không trả lời trong 10 s, gọi lại thì 6,2 s). Cùng lúc các lượt dịch khác mất 8–9 s (bình thường 2–4 s), lượt làm nóng tới cả hai dịch vụ quá 3 s: mạng hay dịch vụ chậm lúc đó, không phải do livestream.
  - Chủ dự án chọn giữ hạn lượt gọi dịch đầu 10 s (không lên 15 s): kết nối treo vẫn bị cắt sớm.
- **Không làm được:** lấy thêm thông tin video lúc vào trang. Trang chỉ nhúng 2 video đầu vào `__pace_f`, và `tap.main.js` đã đọc chúng. Video thứ 3 trở đi chỉ có khi Douyin gọi API feed, lúc lướt tới video thứ 2. Extension tự gọi API đó thì phải giả chữ ký của Douyin (§6w).

## 6w. Giảm thời gian chờ: 4 hướng (2/11, extension 0.2.31, server)

Chủ dự án hỏi thời gian dịch tổng. Số đo hôm đó:
- 21 video đã lướt (mốc của extension):
  - video đã dịch sẵn có sub sau 0–0,5 s;
  - mở lạnh 4,0–5,2 s (mục lục 0,85–1,66 s, âm thanh 0,15–0,21 s, server 3,0–3,3 s);
  - 4 ca chậm 12–23 s.
- 503 đoạn trong cache server: ASR 1,8 s, dịch 2,4 s (1 lượt 1,8 s, có rút gọn 4,0 s), tổng 4,3 s (trung vị; 90% dưới 7,1 s).

Chủ dự án chọn làm cả 4 hướng.

1. **Bỏ lượt rút gọn khi đoạn gấp** (server, `urgent`): xong. Mẩu nhanh và đoạn dịch sẵn đã bỏ từ trước. Test server: đoạn gấp 1 lần gọi dịch; các test đụng lượt rút gọn gửi `urgent: false`.
   - Đánh đổi (verifier): kết quả không rút gọn được lưu cache, nên lần xem sau (không gấp) cũng nhận dòng dài.
   - Quyết định gấp hay không chỉ theo request tạo việc; request gấp nhập vào việc đang chạy, hay bump, không đổi lượt rút gọn.
   - Đoạn 0 dịch sẵn vốn đã không rút gọn từ trước.
2. **Đọc trước danh sách video lúc vào trang:** không làm được. Trang chỉ nhúng 2 video đầu vào `__pace_f`, và `tap.main.js` đã đọc chúng từ trước (ghi chú cũ "chỉ đếm, chưa đọc" là sai). Video thứ 3 trở đi chỉ có khi Douyin gọi `/aweme/v1/web/tab/feed/`, lúc lướt tới video thứ 2. Extension tự gọi API đó thì phải giả chữ ký: không làm.
3. **Lượt tải treo, mục lục nhỏ giọt** (extension 0.2.31):
   - Đo: video `…277715` lúc dịch sẵn treo hai lần (`tải video quá lâu`). Lướt tới thì chờ đủ 20 s mới thử lại (`RETRY_MS[0]`, vốn cho lúc server chưa chạy), nhãn "lỗi" suốt lúc đó: sub sau 16,9 s.
   - Sửa: lỗi mạng tạm thời trước khi gửi server (treo, đứt, HTTP lỗi, thiếu dữ liệu, file vừa đổi, quá chậm: `transient`) của video đang xem thì thử lại sau 1 s, tối đa 3 lần liền (`fastRetry`), rồi mới theo `RETRY_MS`. Lướt tới video có đoạn lỗi tải thì thử lại ngay. Nhãn vẫn "đang dịch" trong lúc đó. Lỗi đọc file (không có mục lục ở đầu…) thì không thử lại nhanh.
   - Mục lục của video đang xem nhỏ giọt (quá 2,5 s mà còn quá 1,5 s nữa): gọi lại một lần qua `/aweme/v1/play/`, chỉ khi có bằng chứng chậm riêng (`spareCapacity`: lượt chạy cùng lúc đã xong nhanh gấp 3, hay video khác đang tải nhanh gấp 3). Bản đầu gọi lại cả khi không có lượt nào khác: đường truyền chậm đều thì mục lục tải lại từ byte 0 mãi không xong (mô phỏng: không có sub trong 20 s, bản cũ 18 s).
   - Mô phỏng (content-time-test, ca mới):
     - treo lúc dịch sẵn: 0.2.30 không có sub trong 20 s, nay 3,25 s;
     - mục lục nhỏ giọt có video khác tải nhanh: 9,25 s, nay 5,75 s;
     - đường truyền chậm đều / chia đều: như cũ, không gọi lại.
4. **Hiện từng dòng khi dịch xong** (streaming): §6x.

## 6x. Hiện từng dòng ngay khi dịch xong (2/11, extension 0.2.32, server)

- **Server:**
  - Lượt dịch đầu gọi OpenAI dạng stream (`stream: true`, SSE; `readSse` trong `httpJson`). `completedCues` đọc các dòng đã đóng trong JSON đang về dở, `translate(…, { onPartial })` báo các dòng đó, cùng dạng dòng như kết quả cuối, chưa rút gọn.
  - Request có `stream: true` nhận NDJSON: mỗi lần có thêm dòng là `{ partial: [dòng…] }` (đủ các dòng tới lúc đó), dòng cuối là kết quả như trả lời thường. Lỗi cũng nằm ở dòng cuối vì đã gửi header 200.
  - Request nhập vào việc đang chạy cũng nhận các dòng đó (`job.feed`). Kết quả có trong cache, request không xin stream, hay dịch bằng Gemini: JSON một lần như trước.
- **Hạn của lượt stream:**
  - hạn 10/20/30 s tính tới chữ đầu tiên;
  - chữ đã về thì chỉ cắt khi im quá 6 s, cả lượt tối đa 60 s.

  Lượt chậm mà đều không bị cắt giữa chừng rồi gọi lại như trước.
- **Extension:**
  - `background.js` đọc NDJSON và chuyển `{ type: 'partial', key, cues }` cho tab.
  - `content.js` giữ các dòng đó ở đoạn hay mẩu nhanh còn ở server (`partial`) và hiện tạm (`mergeCues`). Dòng tạm nhường dòng của đoạn đã xong và của mẩu nhanh đã xong. Kết quả cuối thay hết. Tin của yêu cầu đã xong hay không rõ thì bỏ.
  - Nhãn "VI" khi dòng tạm đã tới chỗ đang xem. Bảng thông tin ghi "đã có N dòng".
  - Mốc `quickPartial`, `chunkPartial`.
- **Đo trên Douyin thật** (Chromium riêng, server riêng, key thật, 3 video mở lạnh):
  - dòng tạm đầu tiên của mẩu nhanh tới trước kết quả cuối 0,33–0,58 s, sub đầu sau 3,56 / 4,47 / 6,63 s;
  - đoạn 0 (~10 dòng): dòng tạm đầu sớm hơn 1,08–1,19 s.

  Lợi lớn hơn khi dịch vụ chậm (thời gian viết tỉ lệ với số dòng).
- **Kiểm:** verifier soát 3 commit (bỏ rút gọn khi gấp, thử lại nhanh, stream): ok_with_fixes, 1 major, có chạy mô phỏng. Đã áp (0.2.33):
  - **(major)** tua vào giữa đoạn: dòng tạm của đoạn nằm sau mẩu nhanh làm mất dòng mẩu nhanh đã xong (`TodCues.merge` chỉ so dòng cuối). Nay mỗi dòng tạm là một mục riêng xếp theo đầu dòng.
  - Huỷ (tua đi), bỏ kết quả của chế độ lời bài hát cũ: tính lại `v.cues`, không còn dòng tạm cũ. Dòng tạm có câu hát của chế độ kia không hiện.
  - Nhãn "VI" chỉ khi có dòng tạm kết thúc từ chỗ đang xem trở đi.
  - Server: hạn chung 60 s cho cả chuỗi gọi lại của lượt stream, tính từ chữ đầu tiên (trước có thể ~180 s). Log ghi hạn nào cắt (chưa có chữ đầu / im giữa chừng / quá cả lượt). Hạn im và hạn chung theo `MT_TIMEOUT_MS` (0,6× và 6×) để test được.
  - `readSse` đóng thân trả lời khi lỗi và đọc sự kiện cuối không có xuống dòng. Dịch vụ cùng kiểu API trả 400 cho `stream: true` thì gọi lại không stream.
  - Lỗi tải tạm thời: HTTP 5xx, 403, 408; 404, 410 thì không. TypeError chỉ khi là lỗi mạng của fetch.
- **Chưa làm:** `completedCues` neo vào chuỗi `"cues"` đầu tiên (một giá trị trong bảng xưng hô đúng bằng "cues" thì không có dòng tạm, không ra dòng sai).
- **Test:**
  - `stream-test.mjs` (server, 9 kiểm tra): thêm im giữa chừng, trả mãi không xong (hạn chung), lỗi sau khi đã gửi header;
  - background-test (3);
  - content-sim-test (55): thêm tua vào giữa đoạn, huỷ, đổi chế độ, nhãn, HTTP 403 với 404.

  Bản 0.2.32 trượt các ca mới. e2e dùng Gemini giả nên không đi đường stream.

## 6y. "lỗi: không có phản hồi": service worker cũ (2/11, extension 0.2.34)

- **Triệu chứng** (chủ dự án chụp màn hình): video 27 s, nhãn "VI · lỗi: không có phản hồi", sub chỉ hiện sau ~24 s.
- **Nguyên nhân (đo):** Chromium của chủ dự án (Chrome for Testing, `--load-extension`, profile `~/.tod-profile`) chạy `background.js` giống hệt bản 93bcbde (1/11), dù manifest và content script đã là 0.2.33. Kiểm bằng `Debugger.getScriptSource` của service worker; `Default/Service Worker/ScriptCache` không đổi từ 21:31 ngày 1/11. Worker cũ đọc trả lời bằng `res.json()`. Từ 0.2.32 content gửi `stream: true` nên server trả NDJSON nhiều dòng (dòng tạm rồi kết quả), `res.json()` hỏng, worker trả `{}`, content báo "không có phản hồi". 20 s sau gửi lại thì lấy từ cache (JSON một lần) nên mới có sub. Như vậy từ 0.2.32 mọi đoạn dịch mới trên Chromium đó đều trễ thêm 20 s và chưa lần nào hiện dòng tạm.
- **Tái hiện:** Chromium tạm, mở lại sau khi đổi `background.js` và tăng version: vẫn chạy script cũ. e2e với Gemini giả không thấy lỗi này: NDJSON chỉ có một dòng nên `res.json()` vẫn đọc được. Chỉ OpenAI stream (có dòng tạm) mới hỏng.
- **Sửa ngay:** tắt Chromium, dời `~/.tod-profile/Default/Service Worker` thành `Service Worker.stale-0211`, mở lại. Worker khớp từng byte với file trên đĩa; sau đó có mốc `partial`, `quickPartial`, `chunkPartial`, không còn lỗi.
- **Sửa trong extension (0.2.34):**
  - `background.js` có `BUILD` (phải bằng version trong manifest; background-test kiểm) và trả `{ build, ndjson: true }` cho tin `{ type: 'hello' }`.
  - `content.js` hỏi `hello` khi trang mở (`workerReady`).
    - Worker báo `ndjson` thì gửi `stream: true`.
    - Worker không trả lời (bản trước 0.2.34; Chrome trả `undefined`, đã đo) thì gửi không stream: JSON một lần, worker nào cũng đọc được. Sub vẫn ra, chỉ không có dòng tạm.
    - Bản worker khác manifest thì bảng thông tin ghi "Service worker của extension là bản cũ (…)" kèm cách sửa; worker đọc được NDJSON thì vẫn stream.
    - Lỗi gửi, hay quá 2 s không trả lời: lần đó gửi không stream, lần sau hỏi lại.
    - Câu trả lời `status` có thêm `worker`.
  - NDJSON hết mà không có dòng kết quả cuối thì `background.js` báo "server ngắt giữa chừng (thiếu dòng kết quả cuối)" thay vì `{}`. Server hiện tại không gửi như vậy; chỉ để lỗi kiểu này không lẫn với worker cũ.
  - Không dùng `chrome.runtime.reload()` để tự sửa: với `--load-extension` trong Chrome for Testing nó tắt extension (ghi chú ở mục môi trường test phía trên).
- **Kiểm:** verifier soát bản đầu: ok_with_fixes, 0 major, có chạy mô phỏng và thử background.js 93bcbde với NDJSON nhiều dòng, một dòng, JSON. Đã áp:
  - `hello` không trả lời thì trước đây không gửi gì cả (đo bằng mô phỏng); nay chờ tối đa 2 s.
  - Stream quyết theo `ndjson`, không theo bản: trên profile giữ worker cũ, mỗi lần tăng bản không còn tắt stream.
  - Kiểm tra e2e chế độ OpenAI nay đòi mốc dòng tạm ở tab. Đếm lần gọi stream thì không đủ, vì server luôn gọi OpenAI dạng stream.
  - Thiếu dòng cuối thì báo lỗi rõ; ghi chú trong bảng thông tin trỏ tới mục này.
  - Không áp: lo Chrome reject thay vì trả `undefined` khi worker cũ không trả lời. Đã đo trong Chromium tạm: listener trả `false` thì `sendMessage` resolve `undefined`.
- **Cách nạp bản mới vào Chromium của chủ dự án** (bắt buộc, lần này đã bỏ sót):
  1. tắt trình duyệt;
  2. dời `Default/Service Worker` của profile;
  3. mở lại;
  4. so script của worker (target có URL đúng `chrome-extension://<id>/background.js`; Chrome for Testing có một extension sẵn cũng tên `background.js`) với file trên đĩa.
- **Test:**
  - background-test 5: `hello`, `BUILD` bằng manifest, NDJSON thiếu dòng cuối;
  - content-sim-test 57: worker không trả lời, trả bản cũ, bản cũ mà đọc được NDJSON, đúng bản, không gửi được, không bao giờ trả lời;
  - content-time-test 31: stub trả `hello`;
  - e2e có chế độ `E2E_MT=openai` (OpenAI giả trả SSE, server gửi dòng tạm) và kiểm `worker` là `ok`.

  Đối chứng e2e chế độ OpenAI, chạy trên bản sao:
  - bản mới: 32/32;
  - bản mới, `background.js` thay bằng 93bcbde: 30/32, mọi kiểm tra về sub đạt, chỉ trượt kiểm tra worker và kiểm tra dòng tạm (đúng ý: worker cũ không đọc được NDJSON nên gửi không stream);
  - content 0.2.33 với worker 93bcbde: 23/32, trượt 7 kiểm tra về dịch (sub, ngữ cảnh, xưng hô, video dài), kiểm tra worker và kiểm tra dòng tạm. Log có "lỗi: không có phản hồi" như ảnh của chủ dự án.

  e2e mặc định (Gemini giả) 31/31.

## 6z. Video dài mở ngay sau khi khởi động lại Chromium: 69 s mới có sub (2/11, chỉ đo, chưa sửa)

- **Chuyện xảy ra** (Chromium của chủ dự án, 0.2.33 với worker đúng bản, 16:41): video feed đầu tiên sau khi mở lại trình duyệt, dài 4:35, phát từ đầu.
  - Mốc (mỗi mốc chỉ ghi lần đầu): mục lục xong ở 2,1 s. Không lượt tải nào của video này xong trước 48 s: không mẩu nhanh, không đoạn 0. Đoạn 0 không bao giờ tới server.
  - Ở 48 s, đoạn 0:20–0:50 tải xong và được gửi, rồi bị huỷ 1,7 s sau vì chỗ đang xem đã qua 0:50 (server đã chạy nhận dạng 1,7 s).
  - Đoạn 0:50–1:20 xong ở 70 s; sub đầu ở 69 s (dòng tạm). Sau đó các đoạn về đều, sớm hơn chỗ đang xem.
  - Cùng lúc đó, video dịch sẵn kế tiếp mất ~20 s mới tới server.
- **Đo lại** (17:15, Chromium riêng, modal, cùng video, 110 s): sub đầu ở giây 5 của video, không lặp lại được.
  - Lượt tải trên máy chủ `v5-hl-mly-ov.zjcdn.com` chậm theo từng lượt: một lượt `bytes=0-` (video dịch sẵn) 158 KB/s suốt 28 s. Đoạn 1:50–2:20 hai lần 6 s không có header (cắt vì im), lần ba 762 KB/s, tổng 24 s.
  - Các lượt khác tới cùng máy chủ đạt 11–19 MB/s.
- **Chưa biết chắc nguyên nhân lần 16:41:** không có nhật ký từng lượt tải lúc đó. Giả thuyết:
  - các lượt tải của video đó gặp kết nối CDN chậm;
  - `headLate`, `dropSlow` không thôi lượt chậm, vì video đầu sau khi mở trình duyệt chưa có tốc độ tham chiếu (`v.speed`), và các lượt dịch sẵn cùng chậm (`othersLoading`).

  Cần nhật ký từng lượt tải lần sau để kiểm.
- **Số liệu cho hướng "tải tiếng riêng"** (§6t): trình phát của trang tải luồng tiếng riêng 0,13–0,17 MB mỗi ~6 s. Extension tải file gộp 6,4–8,8 MB mỗi đoạn 30 s, tức gấp ~10 lần số byte.

## 6aa. Mô phỏng: dịch sẵn chỉ 10 s đầu, xem đủ 5 s mới làm tiếp (2/11, chỉ mô phỏng, chưa đổi code)

- **Đề xuất của chủ dự án:** chỉ tải 10 s đầu; người xem xem hết 5 s đầu mới tải tiếp; mỗi lần lướt thì tải thêm video mới để luôn có n video phía trước. Phần "n video phía trước" đã có sẵn (`PREFETCH` = 4, cửa sổ trượt theo mỗi lần lướt).
- **Cách mô phỏng:** `content.js` 0.2.34 chạy trong vm với đồng hồ giả, harness lấy từ `content-time-test`.
  - Mạng: băng thông chia cho mọi lượt tải và cho trình phát của trang (150 KB/s); file gộp 200 KB mỗi giây phim.
  - Server giả: 2070 ms + 102 ms mỗi giây âm thanh (khớp trung vị log server 2/11), 4 việc cùng lúc + 1 việc gấp, có huỷ.
  - Feed: 12 video dài 15–240 s.
  - Bốn bản:
    - `cur`: như hiện tại;
    - `h10`: đoạn đầu 10 s, lướt tới thì làm tiếp ngay;
    - `u5`: đề xuất, chờ xem đủ 5 s;
    - `u3q`: chờ 3 s, phần tiếp [10, 25) rồi các đoạn 30 s.
  - Kịch bản (bản sao, không trong repo): mạng 3 MB/s, 1,2 MB/s, 450 KB/s; lướt 2, 4, 8 s, xem 15 s, xem hết.
- **Kết quả (verifier đã chạy lại, khớp từng số, kèm 8 phép thử độ nhạy):**
  - **Lướt nhanh, đoạn đầu 10 s thắng rõ.** Bắt đầu ấm (video đầu đã xem 15 s), mạng 1,2 MB/s, lướt 4 s: `cur` có sẵn sub 1/12 video, cả ba bản 10 s được 11/12. Mạng 3 MB/s lướt 4 s thì bốn bản như nhau (11/12).
  - **Cửa 5 s chủ yếu bớt tiền.** Khi lướt 2–4 s, giây nhận dạng ít hơn `h10` 2,5–3 lần, ít hơn `cur` 38–68% tuỳ mạng. Bắt đầu ấm thì số video có sẵn sub như `h10`.
  - **Cửa 5 s làm hụt sub quanh giây 10** trên mọi video dài hơn ~25 s mà người xem ở lại. Mạng 3 MB/s, xem 15 s: phủ 84% so với 98%, hụt 3–4 s. Dòng tạm (stream) rút ngắn khoảng 1 s.
  - `u3q` không hụt ở mạng 3 MB/s, nhưng chỉ dư ~0,8 s: server chậm hơn 1,5 lần là hụt 9/12 video. Ở 1,2 MB/s vẫn hụt (xem 15 s: 86% so với 91%).
  - **Xem hết video** ở 1,2 MB/s và 450 KB/s thì `cur` tốt nhất (97% so với 86–95%; 60% so với 31–40%). Riêng 450 KB/s xem 15 s thì `cur` kém nhất (38% so với 52–53%).
- **Phải sửa trước khi làm thật** (verifier tìm ra):
  - Đoạn đầu 10 s ≤ `QUICK_MIN_CHUNK` (16) nên mất mẩu nhanh, `dropSlow`, và `headLate` (cần mẩu nhanh đang chờ). Lượt tải đầu nhỏ giọt 150 KB/s: `cur` có sub ở 5,75 s, các bản 10 s không có sub trong 15 s.
  - Cửa 5 s chặn cả đoạn ở chỗ đang xem khi mở giữa video hay tua sớm: phải miễn đoạn đó.
  - Đoạn [10, 40) luôn là đoạn gấp nên server bỏ lượt rút gọn: dòng dài hơn (§6w).
- **Thấy thêm ở bản hiện tại:** lướt 2 s từ lúc mở trang (bắt đầu lạnh) thì hàng dịch sẵn không bao giờ chạy. Nó nhường video vừa mở tối đa `PF_HOLD_MAX` 2,5 s, dài hơn khoảng cách giữa hai lần lướt, và tính lại mỗi lần mở.
- **Chưa mô phỏng:** thời gian server ngẫu nhiên, dòng tạm, lượt rút gọn, chất lượng dịch khi đoạn ngắn (ít ngữ cảnh), tiền của việc bị huỷ giữa chừng.

## 6ab. Chế độ thử "dịch sẵn 10 s đầu" (2/11, extension 0.2.35, mặc định tắt)

- **Bật:** ô "Thử: dịch sẵn 10 s đầu" trong popup (cài đặt `first10`).
  - Áp cho video chưa chia đoạn: video kế đang dịch sẵn và video đã gặp giữ cách cũ.
  - Bảng thông tin ghi "· thử 10 s đầu" cho video theo chế độ này.
- **Cách làm (`content.js`):**
  - **Chia đoạn (`planFor`):**
    - video ≤ 12 s: dịch một lần;
    - còn lại: [0,10), [10,25), rồi các đoạn 30 s;
    - phần dư cuối < 8 s gộp vào đoạn trước nó (13 s: [0,14) một lần; 27 s: [0,10), [10,28); 61 s: …, [25,62)).
    - Có lúc tôi đổi thành "không gộp vào [10,25)" vì một số mô phỏng (video 30 s chỉ phủ 65%). Verifier chỉ ra đó là nhiễu: thời gian server khi ấy rút thăm theo thứ tự việc. Rút thăm theo từng việc thì hai luật cho độ phủ như nhau, gộp thì bớt vài giây nhận dạng, nên giữ luật gộp.
  - **Dịch sẵn:** video kế chỉ làm đoạn 0. Đoạn 0 gửi dư 2 s phía sau, cả trong lượt tải đầu video.
  - **Video đang xem:** chưa xem đủ 3 s thì chỉ làm tới đoạn ở chỗ đang xem. Mở giữa video hay tua sớm thì đoạn đó vẫn làm ngay.
  - **Câu vắt qua giây 10:** đoạn [10,25) gửi dư 4,5 s phía trước. Từ 4 s trở lên thì server giữ câu vắt qua giây 10 (`windowAsr`), và lúc ghép sub dòng bị cắt của đoạn 0 được thay.
  - **`headLate`:** xét cả đoạn 0 ngắn của video đang xem, vì ở chế độ này không có mẩu nhanh.
  - **`restartSlow` (đoạn 0 và 1 của video đang xem):** thôi lượt tải và tải lại ngay một lần, trước các đoạn sau, khi đủ cả ba điều kiện:
    - tốc độ 2 s gần nhất dưới 1/3 của lượt tải xong gần nhất;
    - không phải do chia đường truyền;
    - phần còn lại ở tốc độ đó lâu hơn tải lại cả cửa sổ ở 1/3 tốc độ (lần tải lại bỏ phần đã tải).
  - **Tắt ô** thì không nhánh nào chạy: mô phỏng ra từng số như 0.2.34, test cũ không đổi.
- **Kiểm:**
  - Verifier soát bản đầu: ship_trial_with_fixes, 2 major đã sửa:
    - **cắt câu ở giây 10:** đếm trên 250 đoạn đầu có lời trong cache server, ≥ 13,6% có câu bắt đầu trước giây 10 mà nói quá giây 12;
    - **đoạn ngắn không có cơ chế thôi lượt tải chậm.**
  - Lần soát thứ hai: ship_trial, kèm vài việc nhỏ đã làm: tải lại chỉ khi đáng, xoá mốc đo khi lượt tải bắt đầu lại, video 12–17 s.
  - Lần soát thứ ba (sau các sửa nhỏ): ship_trial. Bảng dưới đo với luật "không gộp vào [10,25)"; theo verifier (`M-tail`, 5 hạt giống), luật gộp cho cùng độ phủ, ít hơn 2–13 giây nhận dạng.
  - Test: content-time 36 (thêm 5). Mỗi ca mới trượt trên code trước khi sửa (đã chạy bản đối chứng bỏ từng chỗ sửa).
  - e2e 31/31 (Gemini) và 32/32 (OpenAI stream) khi tắt ô.
- **Mô phỏng** (`cmp2.mjs` ở scratch):
  - server dao động log-chuẩn (trung vị như đo, p80 = 1,5 lần), rút thăm theo từng việc;
  - 5 hạt giống, video đầu đã xem 15 s, 11 video;
  - "lượt chậm": mỗi lượt tải, kể cả lần thử lại, 1/4 khả năng chỉ 300 KB/s.

  | Mạng | Lướt 2 s: video có sẵn sub | Lướt 4 s: phủ | Xem 15 s: phủ | Xem hết: phủ | Trộn: phủ | Giây nhận dạng lướt 4 s / xem 15 s |
  |---|---|---|---|---|---|---|
  | 10 MB/s | 10,0 → 11,0 | 100 → 100% | 100 → 98% | 100 → 99% | 100 → 99% | 540 → 404 / 540 → 584 |
  | 3 MB/s | 6,8 → 11,0 | 100 → 100% | 100 → 95% | 100 → 98% | 100 → 98% | 465 → 191 / 540 → 584 |
  | 3 MB/s, lượt chậm | 4,6 → 9,0 | 83 → 100% | 100 → 95% | 100 → 94% | 100 → 96% | 398 → 191 / 540 → 522 |
  | 1,2 MB/s | 0,2 → 4,8 | 21 → 99% | 97 → 86% | 98 → 94% | 96 → 93% | 397 → 178 / 522 → 432 |
  | 450 KB/s | 0 → 0 | 0 → 0% | 38 → 58% | 59 → 27% | 6 → 32% | 0 → 0 / 285 → 138 |

  - Xem tiếp thì hụt sub quanh giây 10 ở mọi tốc độ mạng (3 MB/s, xem 15 s: 3,4 lần hụt / 11 video).
  - Khi xem: thêm lượt gửi, ít rút gọn câu hơn (đoạn [10,25) luôn gấp nên server bỏ lượt rút gọn), giây nhận dạng tăng ~8% ở mạng nhanh.
  - Nếu lần tải lại cùng khoảng byte cũng chậm (mô hình của verifier), `restartSlow` trung bình không giúp mà cũng không hại.
- **Đo trên Douyin thật** (Chromium riêng, server riêng, 2 lượt × 7 video, ô thử bật):
  - đoạn 0 gửi 12,1 s âm thanh; xem quá 3 s thì gửi đoạn 1 (25,6 s âm thanh, gửi dư 4,5 s); video 27 s chia [0,10), [10,29);
  - không lỗi; worker đúng bản;
  - lướt đi ở giây 4 thì đoạn 1 đã gửi bị huỷ giữa chừng (2 lần mỗi lượt): tốn một phần tiền nhận dạng, cái giá của cửa 3 s.
- **Chủ dự án dùng thử** (2/11, 19:27–19:33, Chromium của chủ dự án, ô thử bật, bộ ghi chỉ đọc `rec2.mjs` ghi nhãn/sub mỗi 250 ms, trạng thái, mọi lượt tải). Mẫu nhỏ, không có đối chứng bản cũ:
  - 5 video, 7 lần xem: 5/7 có sub ngay khi tới, 2 lần còn lại chờ 3,4 s và 0,25 s. Video dài (xem 92 s) phủ 100%.
  - Xem ≥ 12 s: 6 lần, phủ trung bình 88%, hụt đúng ở giây 10 hai lần:
    - **6,1 s:** đoạn [10,25) gửi lúc 3,3 s, lượt tải qua máy chủ `v5-hl-mly-ov.zjcdn.com` chỉ 230 KB/s (2,34 MB mất 10,2 s), server làm 2,5 s. `restartSlow` không chạy vì so với tốc độ của chính video đó (`v.speed`): lượt dịch sẵn trước đó của video này cũng đi qua máy chủ chậm ấy (368 KB/s). Cùng lúc các video khác tải 4–11 MB/s.
    - **2,6 s:** server nhận dạng mất 7,5 s (`qwen-audio-3.1-asr-flash`, thường ~1 s); lúc 19:31 một đoạn khác cũng mất 8,6 s.
  - 13 lượt tải của extension, trung vị 5,3 MB/s. Server 14 việc, 1 huỷ giữa chừng, 0 lỗi, 262 s âm thanh.
  - Hướng sửa (chưa làm): `restartSlow` so với tốc độ gần đây của mọi video (`fastDone`), không chỉ video đó; lần tải lại đi qua `/aweme/v1/play/` để có thể sang máy chủ khác.
- **Chưa làm, có từ trước:** đoạn 0 không có lời (bỏ qua: nhạc) thì đoạn 1 gửi dư 8 s (`PRE_SEEK`). Ở chế độ thử điều này hay gặp hơn: 29 s âm thanh cho [10,25) thay vì 25,5 s.
- **Lưu ý khác** (verifier, chấp nhận cho bản thử):
  - cửa 3 s tính theo thời gian phát, tính lại khi quay lại video;
  - tua về đoạn 0 trong 3 s đầu thì huỷ đoạn 1 đã gửi;
  - phát 2× thì đoạn 1 bắt đầu ở giây phim thứ 6.

## 6ac. Chế độ thử: bớt hụt sub ở giây 10 (2/11, extension 0.2.36)

- **Vấn đề** (chủ dự án dùng thử 0.2.35): sang đoạn [10, …) vẫn thấy "đang dịch".
  - Đo trong phiên đó (§6ab): đoạn 1 chỉ bắt đầu tải sau cửa 3 s.
  - Hụt 6,1 s: tải 10,2 s qua máy chủ chậm.
  - Hụt 2,6 s: server nhận dạng 7,5 s.
  - Thời gian cần cho đoạn 1 = cửa chờ + tải + server, mà chỉ có 10 s.
- **Sửa (`content.js`, chỉ khi bật ô thử):**
  1. **Tải sớm, gửi sau cửa:** đoạn ngay sau đoạn ở chỗ đang xem tải ngay khi lướt tới (tải không tốn tiền), chỉ gửi server khi qua cửa (`f10Hold` trong vòng chờ gửi, cạnh `sendWait`). Chỉ tải sớm khi đoạn ở chỗ đang xem đã gửi hay đã xong, vì hàng tải của video đang xem chỉ có một chỗ (verifier, G1).
  2. **Cửa thích ứng (`f10Gate`):** 1,5 s nếu video trước vừa được xem ≥ 8 s (đang xem hẳn), không thì 4 s.
     - Cửa 3 s mà tải sớm thì lướt 4 s tốn gấp đôi: gửi ở giây 3, huỷ ở giây 4.
     - 1,5 s chứ không 0: xem xong một video rồi lướt nhanh qua video kế thì khỏi gửi (verifier, G4).
  3. **Đoạn 1 ngắn hơn:** [10,20) thay vì [10,25), để server làm nhanh hơn. Sau đó các đoạn 30 s.
  4. **`restartSlow`:**
     - So với tốc độ nhanh hơn trong hai mốc: lượt tải xong gần nhất của video đó, hoặc trung vị 6 lượt gần nhất của mọi video. Lý do: mọi lượt của một video có thể cùng qua máy chủ chậm.
     - Khi thôi lượt chậm: cả video chuyển sang tải qua `/aweme/v1/play/` (`v.url = v.api`) để có thể được chuyển sang máy chủ khác. Máy chủ chậm được ghi nhớ (`v.badHost`), để lượt tải cũ từ đó xong sau không đặt lại link (verifier, G1). Đoạn được tải lại mang cờ `viaApi`.
     - Mốc lấy các lượt trong 60 s gần đây. Verifier (G2) đề nghị 15 s, để khi cả đường truyền chậm đi không tải lại vô ích (đoạn 1 muộn ~1 s). Nhưng khi xem video dài trên máy chủ chậm, lượt nhanh gần nhất thường cũ hơn 15 s: mô phỏng xem hết chỉ phủ 88% thay vì 98%. 60 s cho cùng kết quả như không giới hạn (verifier đo lại).
     - Trong phiên thật, các lượt nhanh không chạy cùng lúc với lượt chậm, nên đòi "có lượt nhanh chạy song song" (`spareCapacity`) cũng sẽ chặn lần tải lại ấy.
- **Đã bỏ:** chỉ tải sớm khi mạng nhanh. Không giúp mạng 1,2 MB/s mà còn làm kiểu xem trộn kém đi.
- **Test:**
  - content-time 39, trong đó các ca thử cập nhật cho đoạn [10,20) và thêm 3 ca: cửa thích ứng; video mà mọi lượt tải qua máy chủ chậm; lướt tới video dịch sẵn mà đoạn 0 còn tải chậm (kịch bản của verifier, G1).
  - Đối chứng: bỏ sửa 4 thì ca máy chủ chậm trượt (đoạn 1 không gửi trong 9 s).
- **Kiểm:**
  - Verifier soát: ship_with_fixes:
    - G1 (major): đã sửa;
    - G2: không áp, lý do ở trên;
    - G3: chấp nhận. Mạng 1,2 MB/s lướt 2 s sau một video xem lâu: đoạn [10,20) làm đoạn [20,50) tải sớm trong lúc xem, nên video kế dịch sẵn ít hơn;
    - G4: đã đổi cửa 0 → 1,5 s.
  - Lần soát lại: ship. G4 trong mô phỏng không bớt tiền ở kiểu xem trộn: video sau một video xem lâu thường ở lại 2–3 s, lâu hơn 1,5 s. Cửa 3 s thì bớt (481 → 440 giây nhận dạng) nhưng hụt nhiều hơn khi xem (hụt@10 0,6 → 1,4 s). Giữ 1,5 s vì chủ dự án đang khó chịu đúng chỗ hụt.
- **Mô phỏng** (`cmp2.mjs`, 5 hạt giống, server rút thăm theo việc, video đầu đã xem 15 s):
  - kiểu mạng mới "1/4 máy chủ chậm 250 KB/s": máy chủ rút thăm mỗi lần chuyển hướng `/aweme/v1/play/`, giữ cho link CDN của nó;
  - số "hụt@10 s" = tổng giây không có sub trong [9,5; 16) s của các video xem ≥ 14 s.

  | Mạng | Xem 15 s: phủ 0.2.35 → 0.2.36 (0.2.34) | Hụt@10 s 0.2.35 → 0.2.36 | Xem hết: phủ | Trộn: phủ | Lướt 2 s: video có sẵn sub |
  |---|---|---|---|---|---|
  | 10 MB/s | 98 → 100% (100%) | 4,0 → 0,3 s | 99 → 100% | 99 → 99% | 11 → 11 |
  | 3 MB/s | 95 → 100% (100%) | 7,5 → 0,6 s | 98 → 99% | 98 → 99% | 11 → 11 (0.2.34: 6,8) |
  | 3 MB/s, 1/4 lượt chậm | 95 → 100% (100%) | 8,7 → 0,8 s | 94 → 99% | 96 → 99% | 9 → 9 |
  | 3 MB/s, 1/4 máy chủ chậm | 87 → 96% (100%) | 20,9 → 6,3 s | 83 → 98% | 89 → 99% | 9 → 9 |
  | 1,2 MB/s | 87 → 95% (97%) | 22,1 → 8,3 s | 94 → 95% | 93 → 94% | 6,0 → 2,2 (0.2.34: 0,2) |

  - Tiền nhận dạng (3 MB/s): lướt 4 s 190 → 200 s (0.2.34: 465); xem hết 778 → 798 (0.2.34: 762); trộn 441 → 481 (0.2.34: 516). Khi xem hay xem trộn, bản thử tốn ngang hoặc hơn 0.2.34 4–6%; chỉ rẻ hơn hẳn khi lướt.
  - Kém đi: mạng 1,2 MB/s lướt 2 s, video có sẵn sub 6,0 → 2,2/11.

- **Chủ dự án dùng thử 0.2.36** (3/11, 8:50–8:56, Chromium của chủ dự án, ô thử bật):
  - Bộ ghi `rec2.mjs` chết lúc 20:55 tối hôm trước (máy ngủ) nên không có mẫu nhãn/sub. Số dưới lấy từ mốc của extension (7 video gần nhất) và log server.
  - 4/7 video có kết quả ngay khi tới (dịch sẵn).
  - 3 video phải chờ:
    - 2 video mở lạnh sau một lúc nghỉ, không được dịch sẵn: sub đầu ở 3,3 s và 4,2 s;
    - 1 video dịch sẵn chưa xong vì lượt tải đầu chậm (mục lục 3,6 s): sub đầu ở 3,0 s.
  - Hai video xem quá giây 10 có đoạn [10, …) xong lúc 6 s và 8 s sau khi tới, trước giây 10. Đây là suy ra từ thời gian, không có mẫu nhãn để xác nhận.
  - Một video ở lại 8 s: đoạn 1 gửi ở giây ~4,4 (cửa 4 s) rồi bị huỷ giữa chừng, là cái giá đã biết.
  - Bộ ghi cần sửa: hạn giờ cho mỗi lần đọc, tự kết nối lại sau khi máy ngủ, theo tab đang hiện thay vì tab Douyin đầu tiên.
  - Chủ dự án xác nhận (3/11): không còn thấy "đang dịch" ở giây 10.

## 6ad. "Dịch sẵn 10 s đầu" thành mặc định (3/11, extension 0.2.37)

- **Quyết định của chủ dự án:** sau phiên dùng thử 0.2.36, không còn thấy "đang dịch" ở giây 10 (§6ac). Chủ dự án yêu cầu bật làm mặc định.
- **Đổi:**
  - `settings.first10` mặc định `true`. Chỉ người đã lưu `first10: false` (bỏ chọn ô) mới dùng cách cũ.
  - Ô trong popup: "Dịch sẵn 10 s đầu (lướt nhanh, đỡ tốn)". Ghi chú: bỏ chọn thì dịch sẵn 20–30 s như trước, hợp mạng rất chậm.
  - Bảng thông tin ghi "· dịch sẵn 10 s đầu". README thêm một dòng.
- **Test:**
  - content-time-test 41: các ca cũ nay ghi rõ `{ first10: false, first10Set: true }` để vẫn kiểm cách cũ. Thêm ca "chưa lưu thì là 10 s; `first10: false` không có `first10Set` vẫn là 10 s; đã bỏ chọn ô thì như cũ" và ca D3. Cả hai trượt trên code trước khi sửa.
  - content-sim-test cũng ghi rõ cách cũ.
  - e2e mặc định chạy cách cũ (`first10: false`): 31/31 (Gemini) và 32/32 (OpenAI stream).
  - `E2E_FIRST10=1`: 23/31 và 24/32. Cả 8 kiểm tra trượt đều thuộc ca video 100 s, và do cách viết ca chứ không phải lỗi:
    - ca này dừng video rồi tua (`subAt` gọi `pause()`), nên thời gian đã phát luôn < 4 s; cửa chờ không mở, đoạn sau đoạn ở chỗ đang xem không được gửi;
    - tua tới 21 s và 85 s thì đoạn đó gửi dư 8 s phía trước (`PRE_SEEK`, đoạn trước chưa dịch), mà ASR giả trả câu ở mốc cố định 2 s và 6 s tính từ đầu âm thanh. Hai câu rơi vào trước đầu đoạn, bị bỏ ("không nghe thấy lời"; log server: `[0:20–0:50] … 44.1 s âm thanh · 0 câu`).
  - Với người dùng thật: tua lúc dừng thì đoạn ở chỗ đang xem vẫn dịch ngay, đoạn sau chờ tới khi đã phát 4 s. Muốn e2e kiểm cách 10 s cho đúng thì cần một ca riêng cho phát liên tục (chưa làm).
- **Verifier soát** (ship_with_fixes), đã sửa:
  - **D1:** popup 0.2.35–0.2.36 lưu cả object cài đặt kèm `first10: false` (mặc định khi đó) mỗi khi đổi bất kỳ cài đặt nào. Người đã đổi gì đó sẽ ở cách cũ mà không biết. Nay `first10: false` chỉ tính khi có `first10Set`, ghi lúc bấm ô.
  - **D3:** cửa chờ tính theo thời gian đã phát, nên tua sớm hay dừng thì cửa đóng, đoạn kế gửi muộn hơn cách cũ 1,8–3,3 s. Nay đoạn còn ≤ 6 s là tới (`F10_NEAR`) thì không chờ cửa. Test so với cách cũ: tua tới 46 s lúc mới xem 0,5 s thì đoạn [50,80) gửi không muộn hơn (đối chứng không sửa: 7,9 s so với 6,15 s).
  - **D4:** sửa chú thích.
- **D2:** đường mặc định ít test tự động. 11/41 ca content-time và 0/57 ca content-sim chạy ở cách 10 s. Đã làm ở §6ae.
- **Cái giá** (mô phỏng §6ab–§6ac):
  - xem lâu hay xem trộn tốn hơn cách cũ 4–6% giây nhận dạng; chỉ khi lướt mới rẻ hơn hẳn (45–63%);
  - mạng ~1,2 MB/s lướt 2 s ngay sau một video xem lâu: ít video có sẵn sub hơn;
  - mạng ~450 KB/s xem hết video: phủ 27% thay vì 59% (bản 0.2.35; nên bỏ chọn ô).

## 6ae. Test cách dịch sẵn 10 s ở cả hai bộ test (3/11, extension 0.2.38)

- **Việc:** §6ad D2. Cách mặc định (dịch sẵn 10 s) có ít test tự động: 11/41 ca content-time, 0/57 ca content-sim, e2e chưa có ca phát liên tục.
- **Chạy hai chế độ:**
  - `node alpha/dev/content-sim-test.mjs` và `node alpha/dev/content-time-test.mjs` chạy cách cũ (`first10: false`); thêm `FIRST10=1` thì chạy cả bộ ở cách 10 s. Mỗi ca có kỳ vọng theo chế độ. Ca nào chỉ đúng một cách thì tự đặt cách đó.
  - `EXT_DIR=<thư mục extension>` chạy bộ test trên một bản content.js khác (đối chứng); `ONLY=<regex>` chạy một số ca.
  - Số thứ tự và mốc đoạn lấy từ lưới viết tay theo từng chế độ (`GRID` trong content-sim, `e.f10 ? … : …` trong content-time), không lấy từ `plan` của content.js. Lý do (verifier, T1): lấy từ `plan` thì content.js chia sai lưới vẫn đạt; bản content.js ép `f10 = true` ở cách cũ làm 4 ca cũ chuyển từ trượt sang đạt.
- **Test:**
  - content-sim-test 57 → 70, đạt 70/70 ở cả hai chế độ. Ca "Lưới đoạn" so lưới với bảng viết tay ở cả hai cách. 12 ca riêng cho cách 10 s: bảng thông tin lúc [10,20) chờ cửa và lúc [20,50) chờ lượt gửi; 429 ở lượt tải sớm của [10,20); dòng tạm và câu vắt qua giây 10; đổi chế độ lời bài hát khi đang xem [10,20) và lúc nó chờ cửa; mặc định gửi `lyrics: true`; modal và trang tìm kiếm; service worker cũ; tắt sub lúc chờ cửa; lướt tới video dịch sẵn mà lượt tải đầu còn treo; xưng hô.
  - content-time-test 41 → 57, đạt 57/57 ở cả hai chế độ. 14 ca mới cho cách 10 s, phần lớn ứng với ca cũ:
    - lượt tải đầu chậm từ byte 0, chậm vừa phải, khựng ở 3/4, chậm ~25 s;
    - tua gần cuối đoạn 0 lúc đang tải; đoạn đầu video kế chậm ở hàng dịch sẵn; chế độ video dài;
    - 429 lúc [10,20) chờ cửa; lướt đi rồi lướt lại lúc chờ cửa; CDN treo ở lượt tải sớm; [10,20) lỗi cả hai đường;
    - mục lục nhỏ giọt; phát 2× và 0,5× so với cửa; tua vào đoạn 30 s thì có mẩu nhanh như cách cũ.
    - Thêm 2 ca cách cũ cho lỗi B1, B2 dưới đây.
  - e2e: ca mới phát liên tục ở cách 10 s, không dừng video. ASR giả thêm câu thứ ba lúc 9,0 s.
    - Kiểm: dòng [0,10) và [10,20) đúng mốc (63 mẫu mỗi 250 ms); không có "đang dịch" từ 8 đến 16 s; [10,20) xong ở giây 5,2–10, [20,50) xong trước giây 10; dịch sẵn chỉ 12 s; lướt 4 video ~2 s không gửi [10,20); xem ≥ 8 s rồi lướt thì đoạn sau xong ở 2,9–5 s (cửa 1,5 s).
    - Ca video 100 s ở cách 10 s nay phát thật 5 s trước khi tua, nên 8 kiểm tra trượt ở §6ad nay đạt.
    - Kết quả: 31/31, 32/32 (cách cũ); 38/38, 39/39 (`E2E_FIRST10=1`).
  - Đối chứng: e2e với cửa 3 s, 9,5 s, không cửa đều trượt kiểm tra "gate 4 s / F10_NEAR". Bản đầu của kiểm tra này đạt cả với cửa 3 s, vì `F10_NEAR` đã mở [10,20) ở giây 4 (verifier, E1); nay đòi [10,20) xong từ giây 5,2. content-time: bỏ `F10_NEAR`, bỏ cửa, bỏ `restartSlow`, bỏ `headLate` cho đoạn 0 ngắn, hay bỏ `currentBehind` thì 3–8 ca cách 10 s trượt.
- **Lỗi tìm ra khi viết test, đã sửa trong content.js:**
  1. **B1** (cả hai cách): `spareCapacity` và `othersLoading` coi một lượt tải nhanh đã xong *trước khi* lượt đang xét bắt đầu là bằng chứng đường truyền còn dư. Trái với thiết kế ở §6v. Ở cách 10 s: lượt [10,20) của video trước xong ngay trước lượt đầu của video kế, đường truyền chậm đi thì lượt đầu bị thôi, tải lại đoạn 0. Sửa: `fastAlong`, đòi lượt kia xong sau lúc lượt này bắt đầu. Mô phỏng cách cũ: không có sub trong 19,5 s, nay 9,75 s.
  2. **B2** (cả hai cách): `holdBack` không giữ hàng tải cho đoạn gấp tải lỗi đang chờ thử lại nhanh (`DL_RETRY_CUR`). Đoạn kế lấy hàng trước, lần thử lại sau 1 s thành sau cả lượt đó. Mô phỏng cách cũ (tua tới [290,320), CDN treo rồi 503): hụt sub 11,5 s, nay 7,75 s. Giữ tối đa `DL_FAST_MAX` lần.
  3. Bảng thông tin: đoạn đã tải mà chờ cửa thì ghi "đã tải, gửi khi xem tiếp" (`entry.gate`), thay vì "chờ đoạn trước dịch xong".
- **Tìm ra, sửa ở §6af (0.2.39) (B3, chỉ cách 10 s):** tua vào [10,20) lúc lượt tải đầu video còn chạy thì lượt đó bị ngắt rồi tải lại phần đã nhận: thừa 0,3–1,3 MB, đoạn đó gửi muộn ~0,55 s (mô phỏng 3 MB/s: 3,1 s thay vì 2,55 s).
  - Đã thử `headKeep`: đọc tiếp lượt đầu tới hết cửa sổ của đoạn ở chỗ tua, như mẩu nhanh ở `runQuick`. Bỏ, vì verifier (R1) đo được: lượt đầu bị máy chủ cho chậm riêng (1–1,5 MB/s trên đường 3 MB/s, kiểu §6d, §6z) thì đoạn đó chờ lượt chậm. Trong 14 s sau khi tua chỉ có sub 2,3–3,8 s thay vì 6,1–9,05 s. `headLate` không cứu, vì chỉ thôi khi tổng thời gian chờ quá 6 s.
  - Muốn sửa thì chỉ giữ lượt đầu khi nó kịp hạn (phần còn thiếu / tốc độ + thời gian server ≤ thời gian còn lại của đoạn), kèm ca test lượt đầu chậm riêng. Cần chủ dự án quyết, vì với luật đó, ca tua tới giây 16 ở 3 MB/s cũng không giữ.
  - Ca content-time "tua tới gần cuối đoạn 0" ở cách 10 s nay chỉ kiểm âm thanh đúng, không mẩu nhanh, không tải song song, gửi trong 3,3 s; không kiểm số byte.
  - Cùng chỗ (verifier, R2; đã có từ trước, không do bản này): video 25–26 s ở cách 10 s (đoạn cuối ngắn gộp vào nên đoạn 1 dài hơn 16 s, có mẩu nhanh) tua vào đoạn 1 lúc lượt đầu còn chạy thì lượt đầu bị ngắt trước khi mẩu nhanh kịp đọc tiếp: tải hai lần [2,33) s (+5,8–6,7 MB).
- **Đối chứng trên content.js 0.2.37:** content-time trượt 3/57 (cách cũ) và 4/57 (`FIRST10=1`), đúng các ca B1, B2; content-sim (`FIRST10=1`) trượt 1/70, ca nhãn.
- **Kiểm:** mỗi bộ test một verifier. Sim: accept. Time: accept_with_fixes (T1–T6), đã sửa; lần soát lại tìm ra R1 nên bỏ `headKeep`. e2e: accept_with_fixes (E1–E6), đã sửa. Các số ở trên đều từ lần chạy thật; mức ảnh hưởng của B1, B2 trên Douyin thật chỉ là suy luận.

## 6af. Tua lúc lượt tải đầu video còn chạy: dùng lại phần đã nhận (3/11, extension 0.2.39)

- **Vấn đề (B3, §6ae):** tua vào đoạn sau đoạn 0 (vd. [10,20) ở cách 10 s) lúc lượt tải đầu video còn chạy thì lượt đó bị ngắt, phần đã nhận bị bỏ, đoạn đó tải lại cả cửa sổ: thừa 0,3–1,3 MB, gửi muộn ~0,4 s.
- **Sửa (`content.js`, cả hai cách):** vẫn ngắt lượt đầu như cũ, nhưng giữ phần chính nó đã nhận (`h.own`) khi phần đó là phần đầu cửa sổ của một đoạn sau đang cần mà chưa tải (`headReuse`). Đoạn đó chỉ tải phần còn thiếu bằng lượt mới, rồi ghép (đường `part` sẵn có trong `fetchBytes`).
  - Chỉ khi lượt đầu bị ngắt giữa chừng (`h.own < h.end`), hay đã xong mà đoạn 0 hết cần (tua đi ngay sau khi lượt đầu xong; verifier, F1: cách cũ bớt 6 MB, có sub thêm 0,5–0,8 s). Phát bình thường thì như cũ. Bỏ hẳn điều kiện này thì rộng quá: lượt đầu sống mãi lúc phát bình thường, 4–5 ca test trượt.
  - Không đọc tiếp lượt đầu (`headKeep`, đã bỏ ở §6ae): không đoạn nào phải chờ một lượt chậm.
  - Phần giữ lại bỏ khi đoạn đó đã tải xong, lướt đi hay tắt sub (`schedule` → `cancelUnwanted` → `headCheck` mỗi lượt).
- **Đo (mô phỏng, video 45 s, 3 MB/s):**
  - Tua tới giây 16 lúc 0,7 / 0,5 s: không thừa byte nào (0.2.38: 1,26 / 0,36 MB); [10,20) gửi lúc 2,7 s (0.2.38: 3,1 / 2,8 s); [20,46) lúc 5,05 s (6,05 s), vì nó dùng lại đuôi của [10,20).
  - Lượt đầu bị máy chủ cho chậm riêng (0,7–2 MB/s), tua tới 12 / 16 lúc 0,7–1,5 s (kịch bản R1 của verifier): mọi trường hợp bằng hoặc tốt hơn 0.2.38. [10,20) gửi sớm hơn 0–400 ms, [20,46) sớm hơn 50–1000 ms. Sub trong 14 s sau khi tua 9,05–9,85 / 6,1–7,5 s (0.2.38: 9,05–9,25 / 6,1–6,3 s). `headKeep` khi đó chỉ có 2,3–3,8 s.
  - Cách cũ, đường truyền chậm đều 2500 B/s (ca "Đường truyền chậm đều lúc vào trang"): đoạn 0 bị bỏ vì chậm, lượt đầu đã có phần đầu cửa sổ [20,50). Đoạn đó gửi lúc 43,3 s thay vì 46,9 s, rồi [50,80) lúc 55,3 s; có sub 8,5 s thay vì 1,75 s trong 60 s đầu.
- **Còn lại (R2):** video 25–26 s ở cách 10 s (đoạn 1 dài hơn 16 s nên có mẩu nhanh): mẩu nhanh tải riêng phần của nó, đoạn 1 tải lại phần đó. Thừa 5,48 MB thay vì 6,74 MB.
- **Test:**
  - content-time 57 → 59, đạt 59/59 ở cả hai chế độ; content-sim 70/70; e2e 31/32/38/39.
  - Ca "tua tới gần cuối đoạn 0" ở cách 10 s lại kiểm số byte (không byte nào tải hai lần), gửi trong 2,9 s. Thêm: âm thanh [20,46) ghép từ đuôi của [10,20) đúng byte, [20,46) tải tiếp từ cuối [10,20), phần giữ lại bỏ trong 300 ms sau khi [10,20) gửi (verifier, F2).
  - Ca mới: lượt đầu chậm riêng 1 / 1,5 MB/s, tua tới 12 / 16 lúc 0,7 / 1,5 s, lấy số của 0.2.38 làm ngưỡng.
  - Ca mới: tua tới giây 16 rồi lướt đi trước khi [10,20) tải xong thì bỏ phần đã giữ trong 300 ms.
  - Đối chứng: content.js 0.2.38 trượt ca tua tới giây 16 (cả hai lượt chạy), ca lướt đi (không giữ gì) và ca 2500 B/s (cách cũ). `headKeep` trượt ca lượt đầu chậm riêng. Bản không bao giờ bỏ phần đã giữ trượt ca lướt đi.
- **Kiểm:** verifier soát (accept). Mô phỏng 24 kịch bản (hai cách, tua 12–45 s, 503 ở lượt nối tiếp, lướt đi, tắt sub, file bị thay trên server): âm thanh gửi đi luôn đúng byte của file. Cách cũ không ca nào kém hơn 0.2.38. Phần giữ lại lớn nhất 6,5 MB (cách 10 s), 14 MB (cách cũ, một bước 50 ms).
  - Chỉ suy luận (verifier, F3): phép kiểm "file đã đổi" (`r.total !== media.total`) bị bỏ qua khi không biết cỡ file. Điều này có từ trước; giữ phần đã nhận lâu hơn làm khoảng hở này rộng hơn một chút.

## 6ag. Popup ghi "Nhận dạng: Gemini" khi không có key nhận dạng (3/11, extension 0.2.40)

- **Vấn đề:** chủ dự án chuyển sang máy Windows. `alpha/server/.env` không theo git, và file trên máy đó chỉ có `OPENAI_API_KEY`. Không có `DASHSCOPE_API_KEY` lẫn `GEMINI_API_KEY` thì `/health` trả `asr: null`, nhưng popup vẫn ghi "Nhận dạng: Gemini" (mọi giá trị khác `funasr` đều thành Gemini), màu xanh. Thật ra không đoạn nào nhận dạng được: mọi đoạn báo lỗi thiếu key.
- **Sửa (`popup.js`):** `asr` null thì ghi "Server chạy nhưng chưa nhận dạng được giọng nói (sẽ không có sub): thiếu DASHSCOPE_API_KEY (Fun-ASR) hoặc GEMINI_API_KEY trong alpha/server/.env. Dịch: OpenAI.", màu lỗi. Các trường hợp khác giữ nguyên chữ.
- **Test:** `alpha/dev/popup-test.mjs` (mới): chạy popup.js trong vm với `/health` giả theo các dạng `config()` trả về (9 kiểm tra). Trước khi sửa trượt đúng ca chỉ có `OPENAI_API_KEY`.
- **Kiểm:** verifier soát (accept). Dựng lại mọi dạng `/health` mà `config()` trả về, chạy bản mới và bản cũ: chỉ ca `asr` null + `mt` openai đổi. Trường `asr` có từ commit đầu, nên server cũ không làm dòng mới báo sai. 6 bản đột biến đều bị test bắt. Đã theo góp ý: chữ nói rõ "sẽ không có sub", thêm ca chỉ có `DASHSCOPE_API_KEY`.
- **Chưa làm (verifier, minor):** dán key OpenAI vào dòng `GEMINI_API_KEY` thì server dời nó sang OpenAI và xoá khỏi Gemini, popup lại báo "thiếu GEMINI_API_KEY" dù file có dòng đó; lời nhắc đổi tên dòng chỉ in ở cửa sổ server. e2e chỉ kiểm chữ `Server chạy`, nên không bắt được loại lỗi này (luôn có `DASHSCOPE_API_KEY`).

## 6ah. Đo state khi lướt rất lâu (3/11, extension 0.2.40, mô phỏng, chưa sửa)

- **Câu hỏi (rà soát ngoài, điểm B):** `items`, `orders`, `watched`, `vids` (`content.js:115-120`) không bao giờ bị xoá. Lướt lâu thì tốn bộ nhớ và làm chậm bước xếp lịch tải bao nhiêu?
- **Cách đo:** content.js thật trong vm (môi trường của `content-sim-test`), lướt tới 8.000 video feed giả, cách 10 s, mỗi video xem 3 s hay 15 s, mọi đoạn có sub. Không mạng, không Douyin thật. Script để trong scratchpad, không vào repo.
- **Đo được:**
  - Bộ nhớ tăng đều theo số video, không có chỗ nào tăng vọt. Item cỡ thật (12 gear, có audio; dữ liệu S1: hầu hết item có 12 gear) tốn khoảng 26–35 KB mỗi video, trong đó URL của item chiếm hơn một nửa; sub chỉ khoảng 3 KB. Lướt 300–600 video/giờ trong một tab: khoảng 8–21 MB/giờ; tải lại tab thì mất hết. Mục lục video (`media`) giữ tối đa 20 video, không tăng theo số video.
  - CPU: `schedule()` 0,58 ms ở 8.000 video (gần hết là `cancelUnwanted`), chạy mỗi ~250 ms. Khung hình thường 0,002 ms, không đổi. Nhận một trang API 10 video ≤ 5 ms.
  - Verifier tìm thêm: `headLate` gọi `othersLoading` (quét mọi video, 0,45 ms ở 8.000) ở mỗi lượt đọc mạng của lượt tải đầu video sau giây đầu; ước tính 10–50 ms mỗi lần mở video ở 8.000 video (số lượt đọc chỉ suy luận).
- **Kết luận:** chưa cần sửa. Nếu thêm giới hạn, phải giữ: video đang xem, các video `upcoming()` (cần `items` để tải), video có đoạn đang chờ hay đã gửi, `v.head` đang dùng lại, `watched` đi cùng `orders.feed`; và chấp nhận lướt ngược về video cũ thì tải âm thanh lại (server vẫn có cache). Cách rẻ nhất nếu cần: bỏ URL của item khi video đã xa (phần nặng nhất).

## 6ai. Không bỏ đoạn vì "quá ít lời" nữa (3/11, extension 0.2.41)

- **Vấn đề:** chủ dự án xem một phim dài và thấy mất câu. Xem lại video 21:42 đó ở 2× (Chromium riêng, server 8787; nhận dạng bằng model dự phòng qwen-audio vì Fun-ASR hết hạn mức, dịch OpenAI):
  - Server nghe 251 câu (312 vế). Sub hiện đúng dòng ở 1.333/1.349 mẫu có sub (98,8%); trống 6 mẫu lúc mở video (đoạn đầu đang dịch) và 6 mẫu lúc chuyển dòng.
  - Mất 3 câu thoại tiếng Nhật ở 8:21–8:27 (断る。帰れ。てめえ死にてえのか。): cả đoạn 8:20–8:50 bị bỏ vì dưới 4 chữ Hán (nhãn `too_short`).
  - Chưa kiểm: ASR có nghe sót không (51 quãng > 4 s không có câu nào; cần nghe lại âm thanh).
- **Quyết định của chủ dự án:** bỏ hẳn luật "quá ít lời": lời ngắn có thể là lời quan trọng.
- **Sửa (`pipeline.mjs`, `server.mjs`):**
  - `classifySpeech` không còn `too_short`. `no_speech` chỉ khi không có chữ nào (Hán, kana, Hàn, Latin): trước đây câu toàn kana cũng là "không có lời". `latinShare` tính kana và chữ Hàn cùng chữ Hán ("OKだ、行くぞ。" không còn là `not_zh`).
  - Chế độ thường: phần lời nói dưới 4 chữ Hán không còn làm bỏ cả đoạn; chỉ bỏ khi không còn dòng nào. Giữ nguyên: đoạn cả bài ở chế độ thường vẫn bỏ câu nói dưới 4 chữ Hán (lời bài hát đã tắt; cache thật không có ca nào).
  - Đoạn mà mọi dòng là tiếng đệm (嗯。, 啊。) bỏ qua với nhãn mới `filler` ("chỉ có tiếng đệm"; extension 0.2.41 có chữ này). Verifier: 12 trên 20 đoạn `too_short` cũ trong cache chỉ có 嗯/啊 (ASR nghe ~0,6 s, thường lúc đầu video có nhạc), nếu dịch sẽ hiện "Ừm.".
  - Dòng ít chữ mà ASR kéo dài quá 7,5 s (một từ そう。 tới hết 25 s âm thanh) được cắt còn ~0,8 s mỗi chữ + 1 s (ít nhất 2,5 s), trước bước gộp dòng ngắn. Cache thật: chạm 4 trên 4.775 dòng, đều là chữ bị qwen-audio kéo dài.
  - `cutPoint` với một từ không còn báo lỗi (trước đây đọc `ws[-1]`; đoạn lỗi mãi).
  - Server làm lại kết quả cũ trong cache có nhãn `too_short`, hay `no_speech` mà `heard` có chữ Hán, kana, chữ Hàn (`stale`). Các đoạn đó trả tiền nhận dạng lại một lần (file ASR đã bị xoá).
- **Chi phí:** verifier chạy lại 20 đoạn `too_short` cũ và 1 đoạn tiếng Hàn: thêm 3 lần gọi dịch trên 4,74 giờ âm thanh trong cache (khoảng 0,6 lần/giờ).
- **Test:** `test.mjs` 22, `lyrics-test.mjs` 23 (ca mới trượt trước khi sửa), cả bộ `npm test`, content-sim 70/70 hai chế độ, e2e 31/31 và 38/38 (`E2E_FIRST10=1`).
- **Kiểm:** verifier soát hai lượt (lượt 1 accept_with_fixes: 1 major, tiếng đệm; 4 minor đã sửa; lượt 2 accept). Mô phỏng offline trên cache thật, không gọi dịch vụ thật: hai chế độ vẫn dùng chung kết quả như cũ, không có vòng làm lại.
  - Chưa làm (verifier, chỉ đánh giá nghĩa): đoạn chỉ có 诶？, 哎呀！, 嘿！ cũng là tiếng đệm, bị bỏ; 喂？, 好。, うん。 vẫn giữ.

## 6aj. Dòng dịch còn chữ Hán hay bị bỏ trống: dịch lại, không bỏ cả câu (3/11, server, extension không đổi)

- **Vấn đề:** `translate()` bỏ mọi dòng có bản dịch trống hay còn chữ Hán. Quét cache (`clauses.mjs` trong scratchpad): 18 trên 4.254 vế câu mất ở 8 video, thường là câu chốt: "雷鸟说如果BLG不夺冠，B站联名眼镜就退款" (lý do của cả video), câu nói cách viết chữ 辫/又/工, câu hỏi "陀螺 nghĩa là gì". Cache không giữ bản dịch bị bỏ, nên lý do từng dòng (còn chữ Hán hay trống) chỉ suy từ nội dung.
- **Sửa (`pipeline.mjs`):**
  - Dòng `missing` hay `han_left` được dịch lại một lần, riêng các dòng đó: câu lệnh dặn viết tên theo âm Hán Việt hay tên quốc tế (B站 → Bilibili), câu nói về chính một chữ thì ghi âm Hán Việt trong ngoặc kép, có thể kèm chữ Hán trong ngoặc đơn; kèm 3 dòng hai bên đã dịch và dòng cuối đoạn trước khi dòng lỗi ở đầu đoạn. Hạn: 2 lần `MT_TIMEOUT_MS`, đoạn gấp, mẩu nhanh, dịch sẵn 1 lần (lỗi hay treo thì chậm thêm tối đa 10 s, giữ bản đầu).
  - Lấy bản dịch lại khi không nhiều chữ Hán ngoài ngoặc đơn hơn bản đầu, và không làm một dòng hiện được thành phải bỏ. Trùng id thì lấy bản ít chữ Hán nhất.
  - Dòng còn chữ Hán mà phần lớn là tiếng Việt thì vẫn hiện. Chỉ bỏ dòng trống hay gần như toàn chữ Hán (2 × chữ Hán > chữ Latin, không tính từ Latin chép từ câu gốc, không tính kana): model chép lại câu gốc.
  - Lượt rút gọn nhận bản rút gọn không thêm chữ Hán (dòng giữ "(辫)" vẫn rút gọn được).
  - File cache ghi `debug.mtFix` { retried, ok, fixed, keptHan, dropped }; log server in "dịch lại N dòng (sửa được K)" hay "(lượt dịch lại lỗi)" và từng dòng bỏ.
- **Đo trên Douyin thật** (server riêng 8788, cache trống, nhận dạng qwen-audio, dịch OpenAI, 24 s đầu mỗi video):
  - Video 陀螺: lượt đầu còn chữ Hán ở 2 dòng, dịch lại 2, cả hai hiện ("'陀螺' nghĩa là gì vậy?"; model vẫn giữ chữ Hán trong ngoặc kép, chưa ghi âm Hán Việt). Trước đây mất cả hai câu.
  - Video chữ 辫: lần này lượt đầu dịch được ngay ("chữ "bện""), không cần dịch lại.
  - Video BLG: đoạn 0–10 s bị huỷ ngay lúc mở video (server ghi "đã tua đi chỗ khác"), và đoạn 10–20 s chỉ có 1 câu. (b) đã sửa ở §6ak. (a) chưa tái hiện được: 5 lần mở lại 4 video qua proxy ghi mọi request (scratchpad `repro/proxy.mjs`, `watch/seek2.mjs`) không lần nào bị.
- **Test:** `mtfix-test.mjs` (mới, 9 kiểm tra, trượt trước khi sửa); cả bộ `npm test` đạt.
- **Kiểm:** verifier soát ba lượt (accept_with_fixes cả ba; các lỗi đã sửa: luật "ít chữ Hán hơn" loại đúng kiểu dịch câu lệnh dặn, đoạn gấp chờ 20 s, câu tiếng Nhật/từ tiếng Anh bị chép lại vẫn hiện, lượt rút gọn, trùng id, ngữ cảnh, bản dịch lại làm mất dòng hiện được). 6/13 bản đột biến bị test bắt; chưa có test cho huỷ giữa lượt dịch lại (verifier đo: an toàn, không ghi cache).
  - Chỉ suy luận: model thật có hay chép lại câu Hán trong ngoặc hay ghi pinyin không ("我爱你 (wǒ ài nǐ)" vẫn hiện).

## 6ak. Câu không dấu câu vắt qua đầu đoạn: lời giữa hai đoạn không thuộc đoạn nào (3/11, server)

- **Vấn đề (video BLG, đoạn [10, 20), âm thanh từ 5,5 s):** model nhận dạng dự phòng có lúc trả cả đoạn không một dấu câu (cùng âm thanh, 4/4 lần gọi lại như nhau; lượt của server thì có dấu câu). `resplitSentences` chỉ cắt được theo khoảng lặng và mốc 12 s: câu đầu thành 5,6–17,6 s, bắt đầu trước đoạn nên `windowAsr` bỏ, mà đoạn trước chỉ có âm thanh tới 12,1 s. Lời 12–17,6 s không thuộc đoạn nào: đoạn còn 1 dòng.
- **Sửa (`windowAsr`):** câu bắt đầu trước `from` mà kéo dài quá `from + 2,5 s` thì giữ các từ bắt đầu trong [from, to) (cần mốc từng từ; Gemini không đổi). Phần trùng với dòng cuối đoạn trước để `cues.js` gộp (giữ dòng kết thúc muộn hơn).
  - Trên dữ liệu thật đó: đoạn 10–20 từ 1 dòng thành 4 dòng (10,3–19,6 s).
  - Luật này cũng chạy khi hai lượt nhận dạng chia câu ở ranh giới khác nhau (verifier, 112 đoạn có from > 0 trong cache, 38 đoạn đổi). Gộp bằng `cues.js` thật trên 13 đoạn có cache đoạn trước: chữ không có dòng nào 171 → 83, chữ lặp giữa hai dòng liền nhau 11 → 18, dòng đoạn trước bị cắt dưới 1,5 s 0 → 1 (BLG: dòng cuối đoạn 0 còn 1 s).
  - Đã thử bắt đầu phần giữ ở dấu phẩy đầu tiên: tổng chữ mất như cũ, thêm chữ lặp; bỏ.
  - Còn lại: cache alpha-8 giữ nguyên kết quả cũ của các đoạn đã dịch. Dòng đoạn trước bị cắt ngắn khi dòng mới bắt đầu giữa nó: chỉ `cues.js` sửa được (đẩy đầu dòng mới tới hết dòng trước), chưa làm.
- **Test:** `test.mjs` 23 (ca mới trượt trước khi sửa; một assert cũ ghi "mất cả đoạn" đổi theo hành vi mới); lyrics, mtfix, errors, queue, openai đạt. Verifier soát hai lượt (accept_with_fixes; sửa chú thích, bỏ luật dấu phẩy).

## 6al. Bộ công cụ đo trên Douyin thật (4/11, giai đoạn 0 của ROADMAP)

- **Mục đích:** chấm bảng điểm "ngon" (ROADMAP §3) sau mỗi thay đổi. Các script trước đây nằm trong scratchpad của phiên, dễ mất.
- **`alpha/dev/real/`** (README ở đó):
  - `run.mjs` chạy bộ video thử: mỗi video một server đo với cache trống, một proxy ghi yêu cầu, một Chromium riêng (cổng 9334, chế độ khách, tắt tiếng), xem ở 1×, chấm điểm, rồi xoá dữ liệu của video; chỉ giữ điểm số (`summary.json`, `history.jsonl`).
  - `watch`, `report`, `cache-scan`, `window`, `replay` (chạy lại offline bước cắt đoạn, chia dòng), `scroll`, `rec`, `sw-source`, `asr-replay`.
  - `videos.json`: 13 mục, chỉ có id và thể loại; chủ dự án đã duyệt (4/11). Còn thiếu một video dưới 15 s.
- **Server:**
  - `cuesFromAsr` tách khỏi `makeSubtitles`, hành vi không đổi: verifier gọi bản cũ và bản mới 4.464 lần trên 271 file nhận dạng thật, 0 khác; `replay.mjs` ra đúng từng dòng đã lưu ở 9/9 đoạn.
  - `TOD_KEEP_ASR=1` (chỉ server đo): giữ file nhận dạng kèm vị trí âm thanh, mô tả, hashtag, để chạy lại offline. Không đặt thì như cũ. Test mới `keep-asr-test.mjs` (trượt với server cũ).
- **Đo thử ngày 4/11** (Mac, nhận dạng bằng model dự phòng, dịch OpenAI, tốc độ 1×):

  | Video | Độ phủ | Hiện đúng dòng | Sub đầu tiên | Đọc ≤ 17 ký tự/giây |
  |---|---|---|---|---|
  | 7696833663460553073 (1:38) | 100% | 96,9% | 3,3 s | 75% |
  | 7675579923955846410 (9:10, xem 2 phút) | 100% | 99,4% | 2,6 s | 67,9% |
  | 7672279659249290548 (2:44) | 100% | 98,2% | 2,9 s | 66,7% |
  | 7703023641964907827, tua tới 8:10–9:00 | 100% | 98% | 3,3 s sau khi tua | 100% |

  Cả bốn lượt: không chờ dịch, không lỗi, không vế nào cần duyệt.
- **Phát hiện: tốc độ đọc thấp** (67–75% dòng ≤ 17 ký tự/giây; mốc M1 của PLAN §2 là 85%). Server chỉ rút gọn dòng dài khi đoạn không gấp, không dịch sẵn, không phải mẩu nhanh (`server.mjs`, `condense`), mà ở cách dịch sẵn 10 s gần như mọi đoạn đều gấp hay dịch sẵn (`content.js`, `urgentChunk`). Bỏ rút gọn ở các đoạn đó là quyết định ngày 2/11 để sub ra sớm hơn khoảng 2 s. Ngày 4/11 chủ dự án chọn giữ sub ra sớm (ROADMAP §6): không bật lại rút gọn ở các đoạn đó; chỉ làm cách nâng tốc độ đọc mà sub không ra chậm hơn.
- **Quét cache hằng ngày** (`cache-scan.mjs`, 388 video bản alpha-8; bỏ qua 2 video có cả cách chia đoạn cũ): 54 chỗ cần duyệt.
  - 30 đoạn tiếng Anh bị bỏ "không phải tiếng Trung" (để giai đoạn 3); có ca đoạn tiếng Trung xen tiếng Anh bị bỏ cả đoạn (7669364984706649350, 170–200 s).
  - 17 vế mất ở bước chia câu hay cắt đoạn; 5 vế bỏ khi ghép sub (có thể chỉ do hai lượt nhận dạng nghe khác nhau, cần nghe lại).
  - 1 đoạn chỉ có số "10" bị coi là không có lời; 1 đoạn bài hát chỉ còn tiếng kêu.
  - 30 đoạn có file nhận dạng mà không có kết quả (dịch ra 0 dòng, lỗi, hay bị huỷ); cache hằng ngày không giữ vị trí âm thanh nên không đếm được vế câu.
- **Chưa đo:** đúng nhịp (Δin), ♪ đúng. Chưa chạy bộ công cụ trên Windows (phần Windows mới là suy luận).
- **Kiểm (bộ công cụ):** verifier soát (accept_with_fixes). 3 lỗi lớn đã sửa: đoạn dịch ra 0 dòng hay lỗi không hiện trong bảng điểm; dòng bị bỏ khi ghép sub không được đếm; 10 s đầu (chụp mỗi 100 ms) nặng gấp 2,5 lần khi chấm. Cùng 17 lỗi nhỏ: dọn dữ liệu khi dừng giữa chừng, chọn đúng thẻ video khi tua, lỗi phía Douyin đếm riêng, chạy trên Windows. Lượt đo thật có tua cho thấy thêm: phải chỉ chấm phần đã xem, nếu không đoạn bị huỷ vì tua đi bị tính là mất câu. Lượt soát 2 (accept_with_fixes): 1 lỗi lớn do chính bản sửa (đổi `PIPELINE_VERSION` thì không thấy file của lượt đo cũ) và 9 lỗi nhỏ, đã sửa; các sửa này chưa được soát lại.

## 6am. Số đo nền: cả bộ 13 mục (4/11, extension 0.2.41, server alpha-8)

- **Cách đo:** `node run.mjs --name baseline-0411`, Mac, nhận dạng bằng model dự phòng (hết lượt miễn phí của model chính), dịch OpenAI, tốc độ 1×, lời bài hát bật. Điểm số ở `alpha/server/work/real/baseline-0411/summary.json` (không có chữ của video).
- **Tổng:** 0 lần chờ dịch, 0 lần lỗi của ta, 0 đoạn lỗi hay dịch ra 0 dòng, 0 yêu cầu bị huỷ. Hiện đúng dòng thấp nhất 88,2% (đoạn tiếng Nhật của phim ngắn), các mục khác 97–100%. Sub đầu tiên trung vị 3,8 s, cao nhất 5,5 s. Đọc ≤ 17 ký tự/giây trung vị 64,9% (40,5–100%).
- **1 mục lỗi:** 7696833663460553073 "không thấy video đang phát" (trang Douyin không mở video trong 60 s). Chạy lại thì ổn (96,1% đúng dòng, sub đầu 3,8 s): lỗi thoáng qua phía trang, không phải của ta.
- **95 vế "cần duyệt":**
  - 88 vế là đoạn tiếng Anh bị bỏ "không phải tiếng Trung": cả video 7681279162377061563 (73 vế) và hai đoạn đầu của 7699966439993675034 (15 vế). Đúng thiết kế hiện tại; nguồn tiếng Anh là giai đoạn 3.
  - 7 vế "bỏ khi ghép sub": 1 ở 7703023641964907827, 4 ở 7677880211542740230, 2 ở 7675802139846823177. Chạy lại 7675802139846823177 và 7696833663460553073 có giữ dữ liệu (lượt `check-0411`): lại ra 2 + 1 vế như vậy, đều ở đầu đoạn (15 s, 140 s). Câu vắt qua ranh giới đoạn có ở cả hai đoạn, mỗi bên nghe một kiểu, và cues.js giữ một bản. 2 vế ở 140 s là báo nhầm: một chữ nằm ở dòng trước (`…三连音在` + `海绵宝宝…`), một vế chỉ thiếu tiếng đệm 啊. Vế ở 15 s thiếu thật 3 chữ đầu (`脸上的` của `脸上的锤子多了不少`); bản dịch của dòng được giữ có "trên mặt" (tôi đọc khi soát, không kiểm lại được). 5 vế của hai video kia không xem được vì dữ liệu đã xoá (suy luận: cùng kiểu).
- **Sửa công cụ đo** (`lib.mjs`, `mergedCheck`), theo lượt soát của verifier (accept_with_fixes):
  - Vế coi là có khi chữ của các dòng đã gộp quanh nó, nối liền, chứa nguyên vế. Vế từ 4 chữ khác đúng một chữ với một khúc liền của các dòng đó (`editInside` ≤ 1) thì ghi "ghép sub: khác một chữ", không tính mất.
  - Thiếu vài chữ ở chỗ nối mà còn ít nhất 60% vế liền một khúc thì ghi "ghép sub: thiếu vài chữ ở chỗ nối": tính là mất, nhưng đã chấp nhận (không cần duyệt), như câu hát khi tắt lời bài hát.
  - Vế dưới 4 chữ phải có nguyên vẹn; chữ phủ định của vế (不, 没, 别, 未, 非, 无) phải có trong các dòng đó.
  - Vế vắt qua hai dòng của cùng một đoạn: trước đây không được so với sub đã gộp, nay so theo giờ của câu.
  - Báo cáo và `cache-scan` in số vế đã chấp nhận ở chỗ nối.
  - Bản đầu dùng dãy con chung (không cần liền), verifier tìm ra là nó nhận nhầm `我们走了` khi dòng giữ lại là `他们是走了的人啊`, và `他没有去学校` khi chỉ còn `他有去学校`. Ca thử tổng hợp (8 ca, chạy tay, chưa thành test): câu khác hẳn, hai ca trên, `不要了`/`我要了`, `好的`/`好` đều báo "bỏ khi ghép sub"; `今天天气很好我们出去完` là "khác một chữ"; `脸上的…` là "thiếu vài chữ".
  - Quét lại cache hằng ngày (388 video, 5.601 vế): "bỏ khi ghép sub" từ 5 còn 1; 4 vế "khác một chữ", verifier xem từng ca, đều do hai lượt nhận dạng nghe khác một chữ.
  - Dữ liệu của `check-0411` đã xoá, nên không chấm lại được bằng bản sửa cuối. `check-0411/summary.json` còn điểm của bản cũ (3 vế cần duyệt). Theo luật mới, 7696833663460553073 sẽ là 0 vế cần duyệt, độ phủ 52/53 (suy luận từ lượt chấm bằng bản đầu).
- **Một lỗi thật nhỏ của cues.js:** dòng của đoạn sau nằm gọn trong thời gian dòng cuối đoạn trước thì bị bỏ mà không so chữ. 7649415147513375994 ở 21,4 s: chỉ đoạn sau nghe được "哭" (trong bài hát), bị bỏ. 1 ca trong 5.601 vế của cache hằng ngày, chưa sửa.

## 6an. Rút gọn sau: đoạn gấp, dịch sẵn vẫn ra sớm, rồi thay dòng chưa hiện (4/11, extension 0.2.42, server)

- **Vì sao:** chủ dự án chọn giữ sub ra sớm (ROADMAP §6, 4/11), nên không bật lại lượt rút gọn trong lượt dịch của đoạn gấp và đoạn dịch sẵn.
- **Cách làm:**
  - Server (`server.mjs`, `condenseAfter`; `pipeline.mjs`, `condenseCues` tách khỏi `translate`): đoạn gấp hay dịch sẵn, khi extension gửi `stream: true` và `condenseLater: true`, vẫn trả dòng kết quả ngay như trước. Sau đó server rút gọn các dòng dài (cùng câu lệnh, cùng luật nhận như lượt rút gọn cũ), gửi thêm một dòng `{ condensed: [dòng…] }` trên cùng kết nối, và ghi đè cache. Dòng được rút gọn mang `full` (bản đầy đủ đã trả); trả từ cache thì bỏ `full`, `condensedLater`.
  - `background.js`: trả kết quả cho trang ngay ở dòng kết quả (trước đây chờ hết luồng), trả lời đúng một lần, chuyển dòng rút gọn bằng tin `condensed`. `hello` báo `condensed: true`.
  - `content.js`: chỉ thay dòng chưa hiện. Với video đang xem, đó là dòng bắt đầu sau giờ của sub (chỗ đang xem trừ độ lệch sub, cộng 0,25 s); video dịch sẵn thì thay hết. Chỉ thay dòng còn mang đúng chữ `full`; sai số dòng hay lệch mốc thì bỏ cả tin.
  - Extension cũ (không gửi `condenseLater`): như trước. Mẩu nhanh: không rút gọn.
- **Test:** `stream-test` (4 ca mới), `background-test` (1 ca), `content-sim-test` (1 ca, 4 tình huống: dòng đang hiện, độ lệch sub −1 s, video dịch sẵn, worker cũ). Verifier chạy các test mới trên code cũ: đều trượt. `npm test` của server và mọi test extension đều đạt.
- **Soát:** verifier (accept_with_fixes). Lỗi lớn đã sửa: với độ lệch sub âm, dòng đang hiện vẫn bị đổi chữ (lúc đầu so với chỗ đang xem, không trừ độ lệch). Sửa thêm: tin muộn của yêu cầu cũ (đổi chế độ lời bài hát) không ghi đè được nhờ `full`; dòng chưa được chụp thì công cụ đo tính bản đầy đủ. Chưa sửa (chấp nhận):
  - request trúng cache trong lúc đang rút gọn nhận bản đầy đủ;
  - lượt rút gọn sau chạy ngoài hàng đợi, không huỷ được: video dịch sẵn có dòng dài nào cũng thêm một lần gọi model, kể cả khi người xem không lướt tới (chi phí để sau, ROADMAP §6);
  - service worker bị Chrome tắt trong lúc chờ thì chỉ mất bản rút gọn, chưa kiểm.
- **Công cụ đo:** hiện bản đầy đủ hay bản ngắn của dòng rút gọn sau đều là "đúng dòng"; tốc độ đọc tính theo chữ đã hiện; proxy đọc trạng thái ở dòng có `status` (`outcomeOf`), ngắt sau dòng kết quả không tính là huỷ.
- **Đo trên Douyin thật** (lượt `condense-0411`, 1×, bản trước mấy chỗ sửa của verifier; với độ lệch sub 0 thì hai bản chạy như nhau):

  | Video | Đọc ≤ 17 ký tự/giây: nếu hiện bản đầy đủ → đã hiện | Dòng rút gọn sau (hiện bản ngắn / bản đầy đủ) | Hiện đúng dòng | Sub đầu tiên |
  |---|---|---|---|---|
  | 7696833663460553073 (1:38) | 75% → 81,3% | 2 (2 / 0) | 95,5% | 5,6 s |
  | 7672279659249290548 (2:44) | 64,9% → 70,2% | 5 (3 / 2) | 98,1% | 5,0 s |
  | 7701192992614370560 (xem 3:00) | 53,4% → 53% | 4 (1 / 1) | 98,8% | 4,1 s |

  0 vế cần duyệt, 0 chờ, 0 lỗi, 0 yêu cầu bị huỷ.
  - Sub đầu tiên chậm hơn lần đo nền (3,8 s, 3,5 s) là do nhà cung cấp trả chậm lần này (dịch đoạn đầu 2.743 ms; nhận dạng 1.739 ms), trước khi có lượt rút gọn nào. Lượt rút gọn chạy sau khi đã trả kết quả.
- **Phát hiện, sửa lại nhận định ở §6al:** khi phát liền ở 1×, chỉ hai đoạn đầu (0–10, 10–20) của video đang xem là đoạn gấp; các đoạn sau gửi trước và đã được rút gọn ngay trong lượt dịch như cũ. Nhận định "gần như mọi đoạn đều gấp hay dịch sẵn" chỉ đúng khi tua hay xem nhanh. Tốc độ đọc thấp chủ yếu vì:
  - dòng quá ngắn so với lời: video 7701192992614370560 có 27/88 dòng vượt 1,1 lần mức; đa số dài 0,6–2,4 s (0,8 s mà 32 ký tự: mức là 13). Rút gọn không đủ, kể cả ở đoạn đã rút gọn trong lượt dịch;
  - dòng vượt 1,0–1,1 lần mức không bao giờ được rút gọn (luật `too_long` là trên 1,1 lần), ví dụ 14 dòng ở video trên.
  - Hướng có thể thử (chưa làm): kéo dài thời gian hiện của dòng vào quãng lặng sau nó; gộp hai dòng ngắn liền nhau; hạ ngưỡng rút gọn về 1,0.

## 6ao. Dòng khó đọc hiện lâu hơn vào quãng lặng sau lời (4/11, extension 0.2.43)

- **Cách làm** (`cues.js`, cuối `merge`): dòng có nhiều chữ hơn đọc kịp (ký tự hiển thị / 17) được hiện lâu hơn, tối đa tới 1,5 s sau lúc dứt lời, và dừng 2 khung hình trước dòng kế. Đầu dòng không đổi, nên nhịp sub như cũ. Dòng chưa biết dòng kế (dòng cuối đã có: đoạn sau chưa dịch xong, dòng tạm đang tới) thì không kéo dài.
- **Ước lượng trên cache hằng ngày** (307 video có kết quả, 4.411 dòng, chỉ đoạn 30 s): dòng đọc kịp từ 64,5% lên 66,4%. Có ích ở 51 video; 741 dòng được kéo dài. Số chỗ hai dòng chồng nhau không đổi (có từ trước).
- **Đo trên Douyin thật** (lượt `linger-0411`, 2 video, 1×): 0 vế cần duyệt, 0 chờ, 0 lỗi; hiện đúng dòng 95,5% và 99,8%. So cùng bản dịch, bước ghép cũ và mới: 77,4% → 77,4% và 59,6% → 59,6% (bản đầy đủ), 83,9% → 83,9% và 66,7% → 66,7% (bản rút gọn). Hai video này không có dòng khó đọc nào có quãng lặng phía sau. Lượt đo chạy bằng bản trước khi bỏ kéo dài dòng chưa biết dòng kế; chấm lại bằng bản đã sửa.
- **Soát:** verifier (accept_with_fixes). Đã sửa:
  - dòng chưa biết dòng kế bị kéo dài đè lên lời mới, tới 1,5 s. Mô phỏng dòng tới dần: 32,6% dòng như vậy;
  - test đếm ký tự dùng chữ á viết tách dấu (NFD), để phân biệt đếm theo ký tự hiển thị với đếm theo mã.
- **Công cụ đo:** chấm lượt đo cũ (trước 0.2.43) bằng `cues.js` mới thì quãng kéo dài bị tính là "lẽ ra có sub", nên "hiện đúng dòng" của lượt cũ có thể thấp đi. Muốn so lượt cũ thì chấm bằng `cues.js` của bản đó.
- **Công cụ đo, sửa thêm:** có lần trang Douyin mất ~30 s mới tải xong (domcontentloaded) trong khi video đã phát tới 28 s; số "sub đầu tiên" (28,3 s) là sai. `watch.mjs` nay bắt đầu chụp từ lúc trang bắt đầu tải (`waitUntil: 'commit'`, chưa chạy thật). `report.mjs` báo "không đo được" khi lần chụp đầu đã quá 3 s.
- **Kết luận:** kéo dài chỉ giúp khoảng 2 điểm. Dòng khó đọc phần lớn nằm sát dòng kế. Trong cache có 1.588 dòng khó đọc trên 4.455 dòng; trung vị 6 chữ Hán mỗi giây.
  - 507 dòng chỉ vượt mức tới 10%: luật rút gọn (trên 1,1 lần) không bao giờ đụng tới.
  - Khoảng 384 dòng ghép được với dòng kề thành một dòng hai hàng mà vẫn đọc kịp; nhưng câu sau hiện trước khi người nói tới (lệch nhịp).
  - Ngày 4/11 chủ dự án chọn ưu tiên sub đầy đủ (ROADMAP §6): không hạ ngưỡng rút gọn, không ghép dòng kề; tốc độ đọc chỉ còn để theo dõi.
- **Tắt rút gọn (4/11, server):** chủ dự án bảo tắt luôn lượt rút gọn đang có. `server.mjs` có công tắc `TOD_CONDENSE`, mặc định tắt: không rút gọn trong lượt dịch, không "rút gọn sau". `TOD_CONDENSE=1` (trong `.env` hay biến môi trường) bật lại đúng như trước. Code rút gọn giữ nguyên; extension 0.2.43 vẫn gửi `condenseLater`, server tắt thì không gửi dòng `condensed`.
  - Còn lại: câu lệnh dịch đầu vẫn cho mỗi dòng max_chars và dặn "chỉ rút gọn khi bản dịch đủ ý dài hơn max_chars" (`pipeline.mjs`, translate). Chưa đổi, vì đổi là đổi cách dịch mọi dòng, cần đo lại chất lượng dịch.
  - Test: mặc định tắt có ca riêng (`stream-test`, `openai-test`). Các ca rút gọn (`stream-test`, `mtfix-test`, `errors-test`, `lyrics-test`, `pronoun-test`) chạy server với `TOD_CONDENSE=1`. `npm test`: 11 bộ đều đạt.
  - Theo số đo 4/11 (§6an), tắt rút gọn làm tốc độ đọc giảm khoảng 5–7 điểm ở video có dòng dài.

## 6ap. Giữ đoạn chỉ có tiếng kêu 诶？, 哎呀！ (4/11, server)

- **Quyết định của chủ dự án (4/11):** đoạn chỉ có tiếng kêu có nghĩa (诶 ngạc nhiên, 哎呀 tiếc, 哇 thán phục) thì giữ, vẫn dịch. Lời dặn max_chars trong câu lệnh dịch đầu: giữ.
- **Sửa:**
  - `pipeline.mjs`: bỏ cả đoạn (nhãn `filler`) chỉ khi mọi dòng là tiếng đệm im lặng `QUIET_FILLER` (嗯, 啊, 呃, 额) hay tiếng đệm chữ Latin. Trước đây là tập rộng (诶, 哎, 哇, 嘿…). Bỏ dòng tiếng đệm trong lời bài hát (耶耶耶, 啦啦啦) vẫn như cũ.
  - `server.mjs`, `stale`: kết quả `filler` cũ trong cache mà chữ nghe được có tiếng kêu khác 嗯/啊/呃/额 thì làm lại.
  - Công cụ đo đã chỉ chấp nhận 嗯/啊/呃/额 từ trước, không đổi luật, chỉ sửa chú thích.
- **Test:** `test.mjs` (isFiller với QUIET_FILLER), `lyrics-test` (đoạn 诶。哎呀。 được dịch; cache cũ nhãn filler có 诶 thì làm lại). Hai ca mới trượt trên code cũ. `npm test`: 11 bộ đều đạt.

## 6aq. Ghép sub ở chỗ nối hai đoạn: so chữ gốc trước khi bỏ dòng (4/11, extension 0.2.44)

- **Vấn đề (cache hằng ngày):** hai luật của `cues.js` bỏ dòng chỉ theo giờ. Quét các chỗ nối: 31 dòng đầu đoạn sau nằm gọn trong thời gian dòng trước, 15 lần bỏ dòng trước vì dòng sau bắt đầu sát nó. So với chữ của mọi dòng đã gộp quanh đó, chỉ 2 ca mất chữ thật:
  - "哭" trong bài hát chỉ đoạn sau nghe được, bị bỏ (7649415147513375994, 21,4 s);
  - "我只有一台相机，" bị bỏ vì dòng sau "相机，还有一个很…" bắt đầu sau nó 0,7 s, mất "我只有一台" (7701687665833315593, 19,4 s).
- **Lỗi "dòng cuối đoạn trước bị cắt còn ~1 s" (ROADMAP giai đoạn 0, việc 5):** cache hiện không còn ca nào; 3 ca cắt, dòng trước đều còn từ 2,1 s. Không sửa thêm.
- **Sửa (`cues.js`, `merge`):**
  - dòng nằm gọn trong thời gian dòng trước: chỉ bỏ khi chữ gốc (zh, bỏ dấu câu, NFKC) đã có trong các dòng đã gộp quanh nó (khớp nguyên, hay khác một chữ với vế từ 4 chữ). Có chữ mới thì nối (cả bản dịch) vào dòng trùng giờ nhiều nhất; khác loại hát / nói thì bỏ như cũ;
  - dòng trước chỉ bị bỏ khi chữ của nó có trong dòng mới và các dòng tiếp theo của cùng đoạn (bắt đầu tới 2 s sau lúc dòng trước dứt lời). Không có thì giữ dòng trước, dòng mới bắt đầu lúc dòng trước dứt lời, giữ ít nhất 0,8 s lời của dòng mới; không còn chỗ thì bỏ như cũ;
  - dòng không có zh: như cũ.
- **Đo trên cache** (so với bản trước): "bỏ khi ghép sub" 1 → 0. Chỉ 2 video đổi, đúng hai ca trên. Dòng chồng nhau 8 → 8, dòng có giờ cuối không sau giờ đầu 0 → 0, sai thứ tự 0 → 0, dòng dưới 0,5 s 8 → 8. Ca 2 còn lặp "相机，" ở hai dòng; dòng sau còn 0,8 s.
- **Soát:** verifier (accept_with_fixes, 5 phát hiện nhẹ). Đã sửa:
  - nối vào dòng trùng giờ nhiều nhất thay vì dòng cuối;
  - không nối câu nói vào dòng hát;
  - không để dòng có giờ cuối trước giờ đầu;
  - NFKC.
  Để lại:
  - lúc dòng đang tới dần (mỗi dòng tạm là một mục riêng khi gộp) thì không thấy các dòng sau, nên có thể tạm giữ dòng trước và lặp chữ tới khi đoạn xong;
  - chữ mới lẫn chữ đã có thì nối cả: lặp vài chữ, chủ dự án ưu tiên sub đầy đủ.
- **Test:** `cues-test` 8 (2 ca mới từ hai ca thật, trượt trên bản cũ; thêm ca dòng trùng giờ, dòng hát, chữ toàn khổ, không còn chỗ). Mọi test extension đạt.

## 6ar. Báo cáo đúng nhịp (Δin) trong bộ công cụ đo (4/11)

- **Cách đo** (`report.mjs`, `timing`; dương là sub muộn, theo giờ video):
  - hiển thị: bộ ghi trong trang (`PAGE_STATE`, mỗi khung hình) ghi giờ video lúc chữ sub đổi; trừ đầu dòng trong cache. Mỗi dòng ghép với lần hiện chưa dùng, từ 0,1 s trước đầu dòng tới 3 s sau. Dòng hiện muộn hơn 0,1 s là dòng tới muộn (dòng đầu lúc mở video, vừa tua): đếm riêng. Phần này chỉ là độ trễ theo khung hình, chưa tính thời gian vẽ ra màn hình, nên Δin là cận dưới;
  - nhận dạng: đầu dòng − lúc tiếng nói bắt đầu trong âm thanh server nhận. Server đo nay bật `TOD_DUMP=1`, âm thanh nằm trong thư mục lượt đo và xoá cùng nó; `scroll.mjs` không bật. `onsetNear`: nền là trung vị năng lượng 0,9–0,5 s trước đầu dòng; đỉnh trong 0,5 s sau phải gấp 4 lần nền; lúc bắt đầu là khung đầu tiên trong ±0,5 s mà 3 khung liền vượt ngưỡng; 0,35 s trước đó phải lặng. Chỉ dòng mà dòng trước đã dứt lời ít nhất 0,3 s (nói liền thì không dò được);
  - Δin của một dòng = hai phần cộng lại. Báo trung vị, P90, sớm nhất, P90 của |Δin|, % trong ±83 ms. `run.mjs` gộp mọi video (mỗi video chỉ vài dòng đo được nhận dạng).
- **Đo thật** (lượt `timing-0411`, 2 video, 1×, extension 0.2.44, rút gọn tắt):
  - hiển thị trung vị 12 ms và 7 ms (55 + 31 dòng);
  - nhận dạng trung vị 10 ms và 0 ms (4 + 10 dòng);
  - Δin gộp 14 dòng: trung vị 10 ms, P90 70 ms, sớm nhất −48 ms, 92,9% trong ±83 ms. Đạt mốc PLAN (trung vị ≤ 80 ms, P90 ≤ 200 ms) trên mẫu nhỏ này.
  - Cả hai video: 0 vế cần duyệt, 0 chờ, 0 lỗi; hiện đúng dòng 99,3% và 98,3%; đọc ≤ 17 ký tự/giây 49,1% và 75% (rút gọn tắt).
  - "Sub đầu tiên 0,4 s" của video 1 không sai: trang mất ~9 s mới có thẻ video, extension đã dịch xong đoạn đầu trong lúc đó.
- **Soát:** verifier (accept_with_fixes). Hai lỗi lớn của bản đầu đã sửa:
  - đòi lặng ngay trước đầu dòng, nên không bao giờ thấy mốc muộn quá 0,15 s;
  - ngưỡng theo cả file, nên chỗ nói nhỏ bị bắt nhầm sớm. "Sớm nhất −180 ms" là giả.
  Sửa thêm:
  - ghép lần hiện chưa dùng, đếm dòng không thấy hiện;
  - P90 của |Δin|;
  - bỏ dòng nối liền dòng trước, sau khi tự thấy Δ 340 ms giả ở "…您对" + "得起当年…".
  Verifier kiểm: âm thanh các đoạn khớp nhau (tương quan ≥ 0,994, lệch ≤ 0,81 ms); mốc so với trình phát dựa trên lần đo 30/10 (§5).

## 6as. Chọn ngôn ngữ đích: tiếng Việt hoặc tiếng Anh (4/11, extension 0.2.45, server; giai đoạn 1)

- **Hợp đồng dữ liệu (khác bản ROADMAP gốc, verifier 4/11):** không đổi tên trường: `zh` là chữ gốc, `vi` là chữ dịch ở **mọi** ngôn ngữ đích. Không tăng `PIPELINE_VERSION` (vẫn `alpha-8`). Lý do: server cũ hay nhánh `main` đọc chung cache vẫn chạy, `cues.js`, bộ công cụ đo, các test cũ không phải đổi.
  - Yêu cầu có `target` (thiếu thì `vi`; mã lạ trả 400 `unsupported_target`). `/health` có `targets: ['vi','en']`.
  - Mọi trả lời mang `target`: kết quả, kết quả từ cache, dòng tạm NDJSON `{ partial, target }`, `{ condensed, target }`, huỷ, lỗi, `need_audio`.
  - File cache: `<id>.<đoạn>.<target>[.lyr].<phiên bản>.json`. File tiếng Việt giữ tên cũ (`.vi.`, `.vi.lyr.`). File nhận dạng `.asr.<băm>.` dùng chung mọi ngôn ngữ.
- **Gói ngôn ngữ** `alpha/server/langs.mjs` (`TARGETS.vi`, `TARGETS.en`): câu lệnh lượt đầu, dịch lại, rút gọn, gợi ý người đăng, schema, khoá JSON (`vi` / `text`), `cps` (cả hai 17), có bảng xưng hô không. Câu lệnh tiếng Việt giữ nguyên từng chữ: `dev/prompt-golden-test.mjs` so với `dev/golden/prompts-vi.json`.
  - Tiếng Anh: không bảng xưng hô (bỏ bảng extension gửi), không có câu lệnh rút gọn, ngữ cảnh gửi model dùng khoá `text`.
  - Kiểm sai ngôn ngữ (`wrongLang`): chỉ đếm chữ riêng của tiếng Việt (ă â đ ê ô ơ ư, dấu nặng, dấu hỏi), ≥ 2 từ và ≥ 30% số từ. Café, Pokémon, tên pinyin có dấu thanh không bị bắt. Dòng bị bắt vào lượt dịch lại; vẫn sai thì **vẫn giữ** (log `wrong_lang`), không bỏ. Dòng tạm sai ngôn ngữ thì không gửi. Câu ngắn kiểu "Em yêu anh" không bị bắt (verifier: chấp nhận).
- **`source` trong file cache** (không gửi extension): dòng gốc kèm id, mốc, `sung`; `before`; các trường chung. Ngôn ngữ đích khác cho cùng đoạn dịch từ đó (`retranslate` trong `pipeline.mjs`): không nhận dạng lại, mốc giống hệt. Áp cả khi yêu cầu có âm thanh.
  - `retarget: true` không kèm âm thanh: có `source` thì dịch, không có thì trả `need_audio`. Kết quả bỏ qua (nhạc, không lời) dùng lại cho ngôn ngữ kia (`reused`), trừ `untranslated`.
  - Ngôn ngữ kia đang chạy cho đoạn đó (đổi ngôn ngữ lúc đoạn đang dịch): chờ việc đó rồi dịch từ `source` của nó, không nhận dạng hai lần.
  - Chưa có ngữ cảnh cùng ngôn ngữ đích: dòng gốc cuối của đoạn trước (ngôn ngữ khác) làm "lời nói ngay trước".
- **Extension 0.2.45:**
  - Popup: ô "Dịch sang" (Tiếng Việt, English); "Bật sub"; `save()` chỉ ghi cài đặt đã lưu cộng ô vừa đổi (không ghi giá trị mặc định); server không có `targets` thì báo "server cũ chỉ dịch tiếng Việt".
  - Khoá yêu cầu của ngôn ngữ khác tiếng Việt có hậu tố `@en` (`<id>:<k>@en`, `<id>:q<from>@en`); khoá tiếng Việt như cũ. Dòng tạm, bản rút gọn chỉ nhận khi ngôn ngữ trong khoá khớp yêu cầu. Nhờ vậy worker bản cũ (không chuyển `target`) vẫn không làm lẫn ngôn ngữ (verifier 4/11, F1).
  - Đổi ngôn ngữ: kết quả cuối cất theo ngôn ngữ (`v.stash`), đổi lại là có ngay; lượt tải chưa gửi thì dừng; việc đã ở server không huỷ. Đoạn, mẩu nhanh đã có ở ngôn ngữ kia: gửi yêu cầu không âm thanh (không giữ chỗ hàng tải); `need_audio` hay server cũ trả 400 thì gửi kèm âm thanh.
  - Bảng xưng hô chỉ gửi khi dịch sang tiếng Việt. Nhãn ghi `VI`/`EN` ở cả 4 chỗ. Trả lời không có `target` khi đang chọn tiếng Anh: báo lỗi "server cũ", không hiện chữ Việt.
- **Test:** `dev/target-test.mjs` (19 kiểm tra, chạy với `TOD_DUMP=1` như server đo), `prompt-golden-test.mjs`; sim thêm 7 ca, popup 4, background 1. e2e thêm ca đổi sang English: 32 / 39 / 33 / 40 kiểm tra (mặc định, `E2E_FIRST10=1`, `E2E_MT=openai`, cả hai). e2e cần `NODE_PATH=alpha/dev/real/node_modules` và ffmpeg trên PATH.
- **Bộ công cụ đo:** `run.mjs`/`watch.mjs --target en`, `--switch-at <giây>` (đổi sang ngôn ngữ kia lúc phát tới đó); `report.mjs` chấm riêng phần trước và sau khi đổi; giới hạn tốc độ đọc lấy từ gói ngôn ngữ.
- **Hai đợt verifier:** server (1 blocker: `TOD_DUMP=1` làm mọi đoạn mới lỗi 500 vì đọc biến trước khi khai báo; đã sửa) và extension (1 major: worker cũ làm mất dòng tạm tiếng Anh; đã sửa bằng khoá). Các điểm nhỏ đã sửa, trừ: cache dùng chung với server cũ thì server cũ gửi cả `source` cho extension cũ (chỉ nặng hơn, không hỏng).
- **Đo trên Douyin thật (4/11, server 8788, Chromium 9334, khách, 1×):**

  | Video | Ngôn ngữ | Vế cần duyệt | Đúng dòng | Sub đầu | Đọc ≤ 17 | Tiếng Việt trước đây (đúng dòng) |
  |---|---|---|---|---|---|---|
  | 7701192992614370560 vlog nói nhanh, 3 phút | en | 0 | 97,0% | 5,9 s | 25% | 98,4–98,8% |
  | 7696833663460553073 tiểu phẩm | en | 0 | 97,5% | 1,9 s | 71,9% | 95,5–98,3% |
  | 7672279659249290548 kể chuyện | en | 0 | 97,4% | 4,4 s | 40,4% | 98,1–99,8% |
  | 7675579923955846410 vlog, 0–60 s | vi | 0 | 98,3% | 5,4 s | 55,2% | 99,4–99,7% |
  | cùng video, 60–120 s sau khi đổi | en | 0 | 92,8% | — | 51,9% | — |

  - 0 vế mất, 0 lỗi, 0 lần chờ dịch. 241 dòng tiếng Anh: 0 dòng tiếng Việt, 0 còn chữ Hán, 0 dòng trống.
  - Lúc đổi ngôn ngữ (giây 60): dòng tiếng Việt còn một lần chụp, rồi ~1 s "EN · đang dịch" (server dịch lại từ dòng gốc, không nhận dạng), rồi tiếng Anh. Phần lớn mức 92,8% là khoảnh khắc này trên một quãng ngắn.
  - **Fun-ASR đã hết hạn mức miễn phí** (`AllocationQuota.FreeTierOnly`): mọi lượt hôm nay dùng `qwen-audio-3.1-asr-flash`, kể cả server hằng ngày. Số tiếng Việt trước đây có thể đo với Fun-ASR, nên so en với vi lẫn cả việc đổi model nhận dạng.
  - Tốc độ đọc tiếng Anh thấp hơn (câu tiếng Anh dài hơn, rút gọn đang tắt). Chỉ theo dõi, theo quyết định 4/11.
  - Đúng dòng tiếng Anh 97,0–97,5%, dưới mốc 98% một chút. **So cùng ngày, cùng qwen** (lượt `p1-vi`, tiếng Việt, cùng 3 video):

    | Video | en | vi (cùng ngày, qwen) |
    |---|---|---|
    | vlog nói nhanh, 3 phút | 97,0% | 96,9% |
    | tiểu phẩm | 97,5% | 99,1% |
    | kể chuyện | 97,4% | 98,8% |

    - Vlog: như nhau. Mức thấp hơn các lần trước (98,4–98,8%) đi cùng model nhận dạng qwen, không phải ngôn ngữ đích.
    - Tiểu phẩm, kể chuyện: tiếng Anh thấp hơn do lần chụp **trống** (8 so với 2, 14 so với 6). Tra từng lần chụp: gần như tất cả nằm ở 0–4 s đầu video, lúc nhãn còn "đang dịch" (chờ sub đầu). Sau khi sub đầu hiện: tiểu phẩm 2 lần trống, kể chuyện 0. Nghĩa là chênh lệch nằm ở sub đầu của lượt đó, không ở cách hiện dòng tiếng Anh. Sub đầu phụ thuộc lúc trang tải, cùng cơ chế cho mọi ngôn ngữ (giai đoạn 0). Đây là suy luận từ mẫu chụp, chưa đo lặp nhiều lần.
- **Còn chờ chủ dự án:** đọc bản tiếng Anh (`alpha/server/work/p1-en-lines.md`, chỉ trên máy, xoá sau khi đọc cùng `node alpha/dev/real/run.mjs --clean p1-en` và `--clean p1-switch`).
- **Cài 0.2.45 vào Chromium của chủ dự án:** Chromium lúc đó đang tắt; đã dời `~/.tod-profile/Default/Service Worker` thành `Service Worker.prev-0244`. Lần mở sau sẽ nạp worker mới. Đã mở lại bằng lệnh thường dùng và kiểm: worker chạy BUILD 0.2.45, giống hệt `alpha/extension/background.js` (`sw-source.mjs`, 4/11).

## 6at. Thử nhanh nền tảng thứ hai (4/11, giai đoạn 2, chỉ đọc)

Kết quả và đề xuất ở [`docs/PLATFORMS.md`](PLATFORMS.md). Tóm tắt: Bilibili trước (khách xem được, âm thanh DASH tách sẵn, phụ đề cần đăng nhập nên tự nhận dạng như Douyin); YouTube sau (phụ đề có sẵn nhưng cần PO token, âm thanh qua SABR; hướng là đọc phụ đề trình phát đã tải, cần thử có cửa sổ); TikTok để cuối.
- Thêm cùng ngày: YouTube thử có cửa sổ vẫn nhận phụ đề rỗng (trình phát bật phụ đề mà vẽ 0 dòng, `navigator.webdriver` là `true`), nên phải kiểm trên trình duyệt thật. Đã kiểm trong Chromium của chủ dự án (chưa đăng nhập YouTube): trình phát tự tải phụ đề `json3` có `pot`, đủ cả video trong một lần (221 dòng); đọc được bằng cách chỉ nghe yêu cầu đó. TikTok: trang thẻ và trang tìm kiếm không hiện video cho khách. Đọc điều khoản: cả ba có điều về dịch hay sửa nội dung, cùng loại rủi ro với Douyin; bảng tóm tắt ở PLATFORMS.md.
- Tiếng Anh dùng 20 ký tự/giây (chuẩn Netflix English cho người lớn, 42 ký tự/dòng; trẻ em 17), tiếng Việt giữ 17. Chấm lại 3 video tiếng Anh đã đo với giới hạn 20: 43%, 78,1%, 63,2% dòng đạt (với 17: 25%, 71,9%, 40,4%); các dòng đó viết theo gợi ý độ dài cũ (17).

## 6au. Video nói tiếng Anh: dịch sang tiếng Việt, tiếng Anh thì hiện bản chép (4/11, server; giai đoạn 3, bản thử)

- **Trước đây:** đoạn có chữ Latin chiếm quá nửa bị bỏ cả đoạn, nhãn `not_zh` ("không phải tiếng Trung"). Cache 3/11 có 34 đoạn như vậy (cả Fun-ASR lẫn model dự phòng đều chép tiếng Anh tốt, có dấu cách, dấu câu dù gợi ý ngôn ngữ là `zh`).
- **Sửa (`pipeline.mjs`, `langs.mjs`, `server.mjs`; extension không đổi, không tăng `PIPELINE_VERSION`):**
  - Nguồn của đoạn (`src`): `en` khi số từ Latin nhiều hơn số chữ Hán, kana, Hàn; không thì `zh`. "这就是america." vẫn là tiếng Trung. Kết quả và `source` ghi `src: 'en'`.
  - Tách câu ở dấu chấm ASCII sau chữ Latin (token thật có dấu cách sau dấu chấm: `" night. "`), trừ viết tắt (Mr., U.S., e.g.); ngoặc kép sau `.`, `?`, `!` của câu tiếng Anh. Tiếng Trung không đổi.
  - Chia dòng chữ Latin theo độ dài: 42 ký tự ứng với 16 chữ Hán.
  - Bài hát tiếng Anh: trung vị > 0,5 s/từ, hay lặp câu kèm > 0,4 s/từ, hay hashtag nhạc kèm > 0,45 s/từ (lời nói trên cache tối đa 0,33 s/từ). Khi đó cả đoạn là bài hát: tắt lời bài hát thì bỏ, bật thì mọi dòng ♪. Lặp câu mà nói nhanh ("Thank you so much." hai lần) vẫn là lời nói.
  - Tiếng đệm tiếng Anh: chỉ uh, um, hm, ah, oh, er; "Yeah.", "Hey!", "Huh?" giữ.
  - Dịch sang tiếng Việt: câu lệnh "từ tiếng Anh", tên riêng giữ nguyên, dòng gốc gửi bằng khoá `en`; dòng trả về vẫn là tiếng Anh (≥ 3 từ, không dấu tiếng Việt) thì dịch lại. Câu lệnh tiếng Trung giữ nguyên từng chữ (`prompt-golden-test`).
  - Đích tiếng Anh cho video tiếng Anh: hiện chính bản chép lời, không gọi dịch (`same: true`; log "hiện bản chép, không dịch"). Đoạn tiếng Anh mà có dòng chữ Hán, kana, Hàn thì dùng câu lệnh tiếng Trung, không hiện nguyên.
  - Kết quả cũ `not_zh` trong cache được làm lại (nhận dạng lại một lần).
- **Còn lại:** gợi ý ngôn ngữ cho nhận dạng vẫn là `zh`; chưa chọn model nhận dạng cuối; chưa có nhận diện ngôn ngữ khác (tiếng Tây Ban Nha... đi như tiếng Anh); ASR Gemini (chỉ có câu, không có từ) dính chữ khi gộp dòng tiếng Anh; ngưỡng bài hát mới chọn theo mốc thời gian ước lượng trên cache, chưa đo trên mốc thật.
- **Test:** `test.mjs` 30 (7 ca tiếng Anh), `dev/source-test.mjs` mới (9 kiểm tra), các bộ server khác đạt.
- **Kiểm:** verifier soát hai lượt (accept_with_fixes cả hai; đã sửa: dấu chấm có dấu cách sau, nguồn tính theo từ, bài hát tiếng Anh, tiếng đệm, "I.", lặp câu khi nói nhanh). So code cũ và mới trên 290 file nhận dạng tiếng Trung thật, hai chế độ: 0 khác biệt. Chạy lại 34 đoạn `not_zh`: 33 ra sub.
- **Đo trên Douyin thật (4/11, server 8788, Chromium 9334, khách, 1×, 2 phút đầu):**

  | Video | Đích | Vế cần duyệt | Độ phủ | Đúng dòng | Chờ | Sub đầu | Đọc đạt |
  |---|---|---|---|---|---|---|---|
  | 7681279162377061563 kể chuyện tiếng Anh (trước đây bị bỏ) | vi | 0 | 100% | 96,4% | 0 | 6,4 s | 76,1% |
  | cùng video | en (bản chép) | 0 | 100% | 97,9% | 0 | 2,2 s | 94% |
  | 7699966439993675034 Trung xen Anh | vi | 0 | 100% | 99,2% | 0 | 2,6 s | 65,6% |

  - Bản dịch đọc tự nhiên ("If you understand this story," → "Nếu các bạn hiểu câu chuyện này,"). Lượt vi chạy trên code trước bản sửa luật bài hát cuối; lượt en trên code cuối.
  - Đúng dòng 96,4% (dưới mốc 98%): 15/17 lần chụp sai là trống, chưa tra từng lần.

## 6av. So model nhận dạng trên bộ video thử (4/11, giai đoạn 3, `alpha/dev/real/asr-bench.mjs`)

- 87 đoạn của 13 video (chữ đồng thuận: Hán 64, Nhật 6, Latin 1). Gọi đồng bộ, base64 mp3, tự nhận ngôn ngữ. Không có bản chép tay: số chênh (CER) là mức hai model chép khác nhau, không phải độ chính xác.

  | Model | Đoạn ok | p50 | p95 | Mốc từng từ | Từ kéo dài > 2 s | Báo ngôn ngữ đúng |
  |---|---|---|---|---|---|---|
  | qwen3-asr-flash | 87/87 | 1,43 s | 2,28 s | không (đồng bộ) | — | 85/87 |
  | qwen-audio-3.1-asr-flash (đang dùng) | 87/87 | 1,66 s | 3,71 s | có | 11% đoạn (14 từ) | không báo |
  | gemini-3.5-transcribe | 26/87 | 5,35 s | 40,6 s | có | 0 | không báo |

  - Chênh nhau: hai model Alibaba 0,11–0,12; Gemini so với hai model kia 0,18–0,21.
  - Gemini: gói miễn phí chỉ 25 lần gọi mỗi ngày (61 lần 429). Lượt đầu có 16 đoạn lỗi mạng (ENOTFOUND) ở mọi model, chạy lại được.
  - Không gọi: `fun-asr` (chỉ bất đồng bộ qua link công khai), ElevenLabs, Azure (chưa có key).
- Chưa biết model nào đúng hơn (chưa nghe lại các đoạn chênh nhau). Chủ dự án chốt tạm 5/11: giữ `qwen-audio-3.1-asr-flash`. Dữ liệu của lượt đo đã xoá.

## 6aw. Nguồn tiếng Nhật, tiếng Hàn (5/11, giai đoạn 4)

- **Nhận ngôn ngữ nguồn** (`classifySpeech`, trường `src` của kết quả, tiếng Trung không ghi):
  - `en`: số từ Latin nhiều hơn số chữ Hán, kana, Hàn (giai đoạn 3);
  - `ko`: chữ Hàn nhiều hơn chữ Hán + kana và hơn số từ Latin;
  - `ja`: ≥ 2 chữ hiragana và kana ≥ 20% chữ Hán + kana. Chỉ katakana thì không đủ: "今天去ユニクロ买了件衣服" vẫn là tiếng Trung.
  - Trên 290 đoạn nhận dạng trong cache: 14 đoạn ja, 1 đoạn ko, còn lại như cũ.
- **Dịch:** câu lệnh tiếng Việt, tiếng Anh ghi "từ tiếng Nhật / tiếng Hàn", dòng gốc gửi bằng khoá `ja` / `ko`, tên riêng phiên theo romaji / romanization; không có dòng Hán Việt, pinyin. Bản dịch còn kana hay chữ Hàn thì dịch lại (`hanOut` đếm cả kana, chữ Hàn). Câu lệnh tiếng Trung, tiếng Anh giữ từng byte (`prompt-golden-test`).
- **Chia câu, chia dòng:** dấu chấm sau chữ Hàn là hết câu; dòng kana đếm chữ như chữ Hán.
- **Lời hát:** độ kéo dài từng chữ đếm cả kana, chữ Hàn và dấu ー; lặp điệp khúc, lời nói trong bài hát cũng đếm các chữ này. Câu chủ yếu kana hay chữ Hàn cần ≥ 6 chữ mới xét là câu hát: đo thật, câu cảm thán "うんらん？" (4 chữ, 1,8 s) bị gắn ♪.
- **Cache cũ:** kết quả `ok` không có `src`, không có `debug.features.kana`, mà `heard` có ≥ 3 kana hay chữ Hàn thì làm lại (`oldJaKo` trong `server.mjs`). Trên cache thật chỉ bắt 11 file, đều là tiếng Nhật thật.
- **Kiểm:**
  - `npm test` 14 bộ đều đạt (thêm ca tiếng Nhật, tiếng Hàn ở `test.mjs`, `source-test.mjs`);
  - verifier hai vòng: chạy lại 290 đoạn nhận dạng × 2 chế độ bằng code cũ và mới, 578/580 lượt giống hệt; 2 lượt còn lại là đoạn trộn Trung, Anh, Nhật (7698003223789848803), chỉ đổi `src` sang ja, dòng sub giữ nguyên.
- **Đo thật** (bộ video thử mục 2, phim 7703023641964907827, 8:10–9:00, `run.mjs --items 2`):

  | Đích | Vế mất | Độ phủ | Đúng dòng | Lỗi | Sub đầu sau khi tua |
  |---|---|---|---|---|---|
  | vi | 0 | 100% (15/15) | 85,7% | 0 | 4,2 s |
  | en | 0 | 100% (15/15) | 86% | 0 | 4,5 s |

  - Đúng dòng thấp vì 7 lần chụp trống ở 491,9–493,6 s: câu đầu tiên sau khi tua đã hết trước khi bản dịch về. Tiếng Trung cũng vậy, không do tiếng Nhật.
  - Phim trộn hai ngôn ngữ: đoạn có cả câu tiếng Trung lẫn tiếng Nhật được dịch bằng câu lệnh tiếng Nhật, câu tiếng Trung vẫn dịch đúng.
  - Dữ liệu lượt đo đã xoá.
- **Còn lại:**
  - tiếng Hàn chưa có mốc từng chữ thật để kiểm luật lời hát và chia dòng;
  - giọng kịch nói chậm (dưới 0,33 s/chữ thì an toàn; chậm hơn 2,5 lần bình thường mới bị ♪, verifier thử bằng cách kéo dài một đoạn thật);
  - chưa có người đọc tiếng Nhật, tiếng Hàn duyệt bản dịch;
  - `heard` chỉ có 40 chữ đầu: kết quả tiếng Nhật cũ mà 40 chữ đầu có < 3 kana thì không được làm lại (cache thật không có ca này).

## 6ax. Đo thật tiếng Hàn (5/11, giai đoạn 4)

- **Video:** tìm bằng tìm kiếm web, hai video dạy tiếng Hàn trên Douyin, mỗi video xem 60 giây (`run.mjs --ids … --to 60`): 7671660514925863395 (câu sách vở và câu đời thường, gần như toàn tiếng Hàn), 7680835126024015144 (50 câu thường ngày, giọng chậm, xen câu dịch tiếng Trung). Video thứ ba (7565032174022331711, vlog Seoul) hoá ra nói tiếng Trung.
- **Lượt đầu (code của §6aw), dịch sang tiếng Việt:** nhận đúng `ko` ở mọi đoạn tiếng Hàn, 0 vế mất, đúng dòng 99,5% và 97%. Lỗi: giọng dạy nói chậm bị gắn ♪ (2 dòng ở video đầu, 15 dòng ở video sau, cả các câu tiếng Trung xen giữa).
  - Nguyên nhân: mốc kết thúc của từ kéo tới tận từ sau, nên câu nói chậm đo được 0,4–1,2 s/chữ. Riêng chữ kéo dài đã đủ để cả đoạn bị coi là bài hát.
  - Ở chế độ tắt lời bài hát, các câu này bị bỏ.
- **Sửa:**
  - đoạn tiếng Nhật, tiếng Hàn chỉ là bài hát khi lặp lời, hoặc có hashtag nhạc kèm chữ kéo dài;
  - xét câu hát theo độ kéo dài từng câu (`splitSung(…, { slow })`) chỉ khi có các dấu hiệu đó;
  - dấu chấm ASCII sau chữ Hán, kana, chữ Hàn là hết câu ("我是大学生.저는 회사원이에요." từng thành một dòng).
  - đoạn tiếng Nhật, tiếng Hàn ở chế độ tắt lời bài hát cũng không bỏ dòng nghi là hát, chỉ gắn ♪. Lý do (verifier 5/11): mô tả có chữ liên quan nhạc (歌, 舞, mv, cover…, hay gặp ở video dạy tiếng qua bài hát) thì giọng dạy chậm lại bị coi là hát, và độ kéo dài không tách được hai loại (giọng dạy 0,36–0,48 s/chữ, bài hát Nhật 0,46).
- **Lượt hai (code mới), dịch sang tiếng Anh:**

  | Video | Vế mất | Độ phủ | Đúng dòng | Lỗi | ♪ |
  |---|---|---|---|---|---|
  | 7671660514925863395 | 0 | 100% | 99,5% | 0 | 0 |
  | 7680835126024015144 | 0 | 100% | 98,1% | 0 | 0 |

- **Chạy lại offline:** 7 đoạn tiếng Hàn thật đều 0 ♪, chế độ thường giữ đủ dòng; 290 đoạn trong cache tiếng Trung không đổi (chỉ đoạn trộn 7698003223789848803 đổi `src`, như §6aw).
- **Đổi so với §6aw:**
  - bài hát tiếng Nhật, tiếng Hàn không có hashtag nhạc và không lặp lời thì không có ♪ (vẫn dịch đủ);
  - ở chế độ tắt lời bài hát, bài hát tiếng Nhật, tiếng Hàn vẫn được dịch (có ♪) thay vì bị bỏ.
- **Verifier vòng 3:** so với 43bc8f0 trên dữ liệu tiếng Hàn thật, không đoạn nào ít dòng hơn; tiếng Trung không đổi. Chưa có mốc từng chữ tiếng Nhật thật để kiểm giọng kịch nói chậm (lượt `p4-ja` không giữ file nhận dạng).
- **Ghi lại, chưa xem:** vlog Seoul mất 7 vế ở 0–10 s; đoạn đầu bị huỷ ("đã tua đi chỗ khác") ngay lúc mở video, sub đầu 13,8 s. Chưa rõ do extension hay do công cụ đo.
- Dữ liệu lượt đo đã xoá.

## 6ay. Thử đường dự phòng cho trang bất kỳ (6/11, nhánh `claude/any-site-tab-audio`, extension 0.2.46)

- **Cách làm:** popup có nút "Dịch âm thanh tab này". Background lấy mã luồng thu (`chrome.tabCapture.getMediaStreamId`, quyền activeTab của lần bấm), mở trang ẩn `offscreen.html` (`USER_MEDIA`) và tiêm `tablive.js` + `tab.js` vào tab.
  - Trang ẩn thu âm thanh, phát lại ra loa (đang thu thì Chrome không phát tiếng tab), ghi từng khúc WebM/Opus, gửi `/v1/subtitles`.
  - Mỗi khúc dịch các câu bắt đầu trong 5 s, thu dư 1,5 s hai đầu. Khúc im lặng không gửi.
  - `tab.js` hiện dòng ở lúc người nói + độ trễ. Độ trễ tự tăng khi dòng về muộn, bắt đầu 6 s, tối đa 20 s.
- **Server:** id `tab<số>` (mốc tính từ lúc bắt đầu thu), trường `fmt: 'webm'`; mọi bước sau như đoạn Douyin. `source-test` có ca WebM.
- **Quyền mới:** `tabCapture`, `offscreen`, `activeTab`, `scripting`. Không xin quyền mọi trang.
- **Test:** `alpha/dev/tablive-test.mjs` 7 kiểm tra; các test cũ của server và extension đều đạt.
- **Thử thật** (`alpha/dev/real/tablive-real.mjs`, YouTube "日常中文对话 Ep.1", 75 s, dịch sang tiếng Việt): 14/14 khúc có lời, 0 lỗi, 116–118/149 lần chụp có sub, trễ 8,5–9,5 s.
- **Vấn đề thấy được:**
  - câu nói chậm bị cắt ở ranh giới khúc ("我的名。" rồi "名字 | 是乐乐"), dịch sai theo ("我也很高。" thành "Mình cũng rất cao."). Thu dư 3 s không đỡ: thêm dòng lặp, trễ 12,5 s. Hướng sửa: giữ câu cuối chưa xong của khúc, gửi lại cùng âm thanh khúc sau;
  - giọng dạy tiếng Trung chậm bị gắn ♪ (luật sẵn có của đường tiếng Trung);
  - sang trang web khác trong cùng tab thì Chrome không cho tiêm lại lớp sub (activeTab mất); âm thanh vẫn thu;
  - chưa thử bằng cú bấm popup thật trên Chrome của chủ dự án (lúc thử tự động dùng cờ `--allowlisted-extension-id` và bản sao có quyền mọi trang).

### 6ay (tiếp). Sửa câu bị cắt ở ranh giới khúc (6/11)

- **Bỏ khúc 5 s cố định.** Trang ẩn giữ âm thanh liên tục trong bộ đệm 90 s (16 kHz, gửi WAV, `fmt: 'wav'`) và một con trỏ: mốc đầu phần chưa dịch.
  - Khi phần chưa dịch đủ 5 s và có thêm ≥ 2 s mới: gửi âm thanh từ con trỏ − 1,5 s tới hiện tại (`tablive.js` `plan`).
  - Có khoảng ngừng nói ≥ 0,45 s trong 2,5 s cuối (độ to dưới 20% cả đoạn): cắt ở đó, gửi `final` (`findPause`).
  - Không có khoảng ngừng (nhạc nền, nói liền): server giữ câu cuối nếu chữ cuối kết thúc trong 0,8 s cuối, trả `next` = mốc bắt đầu câu đó; con trỏ dời tới `next` (`liveHold`).
  - Phần chưa dịch dài quá 15 s thì gửi `final`.
- **Server cắt theo từng chữ** từ con trỏ (`liveTrim`), vì lượt nhận dạng sau có thể chia câu khác lượt trước: trước đó "你是美国人" bắt đầu trước con trỏ bị bỏ cả câu.
- **Thử thật** (75 s mỗi video, dịch sang tiếng Việt):

  | Video | Lần gửi | Giữ câu | Có sub | Trễ | Ghi chú |
  |---|---|---|---|---|---|
  | M4pc8Epwens, khúc 5 s cố định (trước) | 15 | — | 118/149 | 9,5 s | câu cắt đôi ở ranh giới |
  | M4pc8Epwens, chỉ giữ câu ở server | 21 | 17 | 102/149 | 14 s | ASR kéo mốc chữ cuối tới hết âm thanh nên gần như lần nào cũng giữ; mất chữ khi lượt sau chia câu khác |
  | M4pc8Epwens, bản cuối | 17 | 1 | 104/149 | 8 s | video dạy rất chậm, ngừng giữa các chữ lâu như giữa các câu: vẫn vụn ("我的名字。" \| "是乐乐") |
  | U4h59nMjb0A (vlog dạy tiếng, nói thường), bản cuối | 16 | 1 | 125/149 | 8,5 s | câu liền, không thấy mất chữ |

- Còn lại: giọng dạy tiếng Trung chậm bị gắn ♪ (luật của đường tiếng Trung); chưa thử bằng cú bấm popup thật; chưa thử trang có nhạc nền liên tục (đường giữ câu ở server).

### 6ay (tiếp). Sub theo giờ video (6/11)

- Chủ dự án thử lần đầu thấy "dịch không đúng". Log cho thấy chữ nhận dạng và bản dịch đều đúng, nhưng: ô "Dịch sang" đang là English; sub theo đồng hồ máy nên trễ 8–10 s so với lời, và khi tua vẫn hiện nốt dòng của đoạn cũ.
- **Sửa (`tab.js`):** trang có video thì ghi giờ video mỗi 100 ms; mỗi dòng gắn vào giờ video lúc câu được nghe (`videoTimeAt`), hiện theo giờ video + độ trễ riêng của dòng (`lag`).
  - tạm dừng thì sub đứng yên;
  - tua thì mọi dòng đã có bỏ độ trễ: tua lại chỗ đã dịch thì dòng hiện đúng lúc nói, dòng trước điểm tua không hiện lại;
  - dòng mới trùng quá nửa thời gian với dòng đã có (nghe lại sau khi tua) thì bỏ (`overlaps`);
  - không có video (trang chỉ có tiếng, video trong iframe): theo đồng hồ máy như cũ.
- **Thử thật** (U4h59nMjb0A, 95 s, tạm dừng 6 s ở giây 30, tua từ 0:54 về 0:20): sub đứng yên khi dừng; sau khi tua, các dòng hiện đúng lúc nói, đúng thứ tự, không dòng lặp. Lần thử trước bản sửa: dòng nói ở 0:13 hiện lại ở 0:21, một dòng hiện hai lần.

## 7. Việc tiếp theo trên Mac

Lộ trình từ 3/11/2026 (làm sản phẩm ngon trước, dịch mọi ngôn ngữ sang mọi ngôn ngữ, bán để sau): [`ROADMAP.md`](ROADMAP.md).

1. **Kiểm tra môi trường:** `node -v` (cần 18+), `git status`, đang ở nhánh `claude/busy-newton-1y8nzr`. Có `alpha/server/.env` chưa (chỉ kiểm có file, không đọc nội dung). File này không theo git: máy mới (kể cả máy Windows) cần tự tạo, chép từ `.env.example` rồi điền key. Popup ghi rõ dịch vụ nhận dạng và dịch đang dùng, hoặc key nào còn thiếu.
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
- Bộ phân loại nói/hát theo âm thanh (ví dụ SenseVoice) thay cho đặc trưng văn bản. Từ 1/11 đọc theo nhịp, 喊麦 và rap đều tính là hát, nên bộ này đáng giá hơn: 98 dòng hát thiếu ♪ ở hai lô đo (52 dòng rap và 喊麦, 46 dòng bài hát nhanh) không bắt được bằng độ dài chữ (§6n). Ngày 1/11 chủ dự án vẫn chọn để sau.
- Bỏ khoảng lặng và nhạc trước khi gửi ASR (VAD), vì Fun-ASR tính tiền theo giây.
- Bảng tên riêng và xưng hô theo cả video. Cache dùng chung giữa người dùng khi có server thật.

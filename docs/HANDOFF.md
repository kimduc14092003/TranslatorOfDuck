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
| `cd alpha/server && npm test` | `test.mjs`: chia câu, mốc thời gian, lọc hát, cắt đoạn, giữ độ lệch đầu track âm thanh, câu vắt qua đầu đoạn khi vừa tua tới, đánh dấu dòng hát, tiếng đệm trong lời hát, dòng nói ngắn gộp vào dòng hát, câu nói nhanh trong đoạn cả bài (20 kiểm tra). `queue-test.mjs`: hàng đợi khi tua liên tiếp (ưu tiên, huỷ, đẩy lên khi lướt tới ở cả hai chế độ lời bài hát, `rank`), Gemini hết lượt trong ngày (9 kiểm tra). `asr-fallback-test.mjs`: Fun-ASR hết hạn mức thì chuyển sang model dự phòng, giới hạn theo phút thì gọi lại (20 kiểm tra). `warm-test.mjs`: `/v1/warm` làm nóng đúng dịch vụ đang dùng, giãn 3 s, bỏ qua khi vừa có lệnh gọi thật, log thời gian kết nối (12 kiểm tra). `pronoun-test.mjs`: luật xưng hô trong câu lệnh, bảng xưng hô nhận vào và trả về, đọc bảng của đoạn trước từ cache, giới tính người đăng (21 kiểm tra). `openai-test.mjs`: dịch bằng OpenAI giả, mức suy luận, đoạn dịch sẵn bỏ rút gọn (7 kiểm tra). `errors-test.mjs`: key dịch sai không chạy lại nhận dạng giọng nói, thiếu ffmpeg, file cache hỏng, Origin lạ, không phải JSON, dịch chậm hơn hạn lần đầu thì lần gọi lại được hạn dài hơn, dịch vụ treo hẳn thì thôi sau 3 lần quá hạn, lượt rút gọn treo thì giữ dòng đầy đủ (14 kiểm tra). `lyrics-test.mjs`: chế độ lời bài hát, kể cả điệp khúc câu ngắn, ngữ cảnh ở chế độ thường, hai chế độ cùng lúc, đoạn cả bài có câu nói nhanh ở hai chế độ, kể cả khi không câu nào tự đủ là câu hát (19 kiểm tra) |
| `node alpha/dev/content-sim-test.mjs` | content.js + tap.main.js trong vm, không cần trình duyệt: mẩu nhanh, đồng hồ trình phát, lướt, tua, tắt sub, giãn lần thử lại, `rank`, chế độ lời bài hát và đổi chế độ giữa chừng, slide feed bị ẩn, trang kết quả tìm kiếm, đóng modal, HTTP 429, đoạn cả bài không dùng chung giữa hai chế độ , bảng xưng hô theo từng video, bảng thông tin khi rê chuột vào nhãn (52 kiểm tra) |
| `node alpha/dev/content-time-test.mjs` | content.js theo thời gian: đồng hồ giả, các lượt tải chia băng thông. Thứ tự tải sau khi tua, mẩu nhanh nhường đường truyền, mẩu nhanh bị treo, không ngắt đoạn đã tải từ trước, đoạn đầu tải chậm qua máy chủ chậm (trang video và feed), tải nhanh rồi chậm hẳn, rời feed, tải chậm vừa phải, đường truyền chậm đều, khựng giữa chừng, tua về sau khi bỏ đoạn , hàng dịch sẵn nhường video vừa mở, báo làm nóng, mốc thời gian trong câu trả lời status; một lượt tải từ byte 0 cho mục lục + q0 + đoạn 0 (nhiều rtt và băng thông, dịch sẵn, tua lúc đang tải, moov lớn, không có moov ở đầu, 200 cả file, lướt đi, 429, CDN treo, lượt đó chậm từ byte 0, đổi chế độ lời bài hát gửi đúng byte cũ, mở giữa video, tiến độ cho dropSlow); xem video dài trên đường truyền chậm, đoạn kế chờ lượt gửi (chế độ video dài, §6t); video sau slide livestream có lượt tải đầu chậm riêng (§6v) (30 kiểm tra) |
| `node alpha/dev/mp4audio-test.mjs` | Cắt âm thanh từ mp4 thật do ffmpeg tạo, đúng mốc trong khoảng 15 ms; `headerEnd` trên phần đầu file đang tải dở (5 kiểm tra) |
| `node alpha/dev/cues-test.mjs` | Gộp sub các đoạn, câu vắt qua ranh giới hai đoạn (5 kiểm tra) |
| `node alpha/dev/background-test.mjs` | background.js gửi `POST /v1/warm` (kiểu JSON) tới server trên máy, bỏ qua lỗi, chặn địa chỉ ngoài máy (2 kiểm tra) |
| `node alpha/dev/tap-test.mjs` | tap.main.js đọc response API với Response thật (fetch, XHR): thân chia khúc của search/stream, thân hỏng, giữ thứ tự danh sách tìm kiếm khi search/single đọc xong trước (3 kiểm tra) |
| `node alpha/dev/e2e.mjs` | Chromium thật + extension + Douyin giả + AI giả + server thật, có video dài 100 s, video "đã thích" ở cột bên, mẩu nhanh khi tua, đồng hồ trình phát lệch 50 s, CDN treo một lần, lời bài hát ♪, bấm ô tắt lời bài hát trong popup, video mở từ trang tìm kiếm, video đầu tải một lượt từ byte 0 , bảng xưng hô gửi lại cho đoạn sau, rê chuột thật vào nhãn thì hiện bảng thông tin (30 kiểm tra) |

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
- **Feed tới muộn.** Khi vào trang, `/aweme/v1/web/tab/feed` tới sau ~12 s. Video 1–2 chỉ thấy qua player nên chưa dịch sẵn được video 2. Có thể tìm metadata của chúng trong `self.__pace_f` (hiện chỉ đếm, chưa đọc).

Ghi chú môi trường test:
- Extension nạp bằng `--load-extension` trong Chrome for Testing bị tắt nếu gọi `chrome.runtime.reload()`; phải khởi động lại trình duyệt.
- Khởi động lại vẫn có thể **giữ service worker cũ** (`background.js` bản trước). Kiểm bằng `Debugger.getScriptSource` của service worker; nếu cũ thì tắt trình duyệt, dời thư mục `Default/Service Worker` của profile rồi mở lại. Người dùng bấm Reload ở `chrome://extensions` thì không gặp.

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
- **Đoạn dịch sẵn bỏ lượt rút gọn dòng dài**: extension gửi `prefetch: true`, mỗi video bớt một lần gọi model. Video đang xem vẫn rút gọn. Có test trong `openai-test`.
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
- **Chưa làm:** lấy thông tin video từ `self.__pace_f` lúc vào trang (§6d) để dịch sẵn được từ video thứ 3. Hiện API feed tới khi lướt tới video thứ 2.

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
- Bộ phân loại nói/hát theo âm thanh (ví dụ SenseVoice) thay cho đặc trưng văn bản. Từ 1/11 đọc theo nhịp, 喊麦 và rap đều tính là hát, nên bộ này đáng giá hơn: 98 dòng hát thiếu ♪ ở hai lô đo (52 dòng rap và 喊麦, 46 dòng bài hát nhanh) không bắt được bằng độ dài chữ (§6n). Ngày 1/11 chủ dự án vẫn chọn để sau.
- Bỏ khoảng lặng và nhạc trước khi gửi ASR (VAD), vì Fun-ASR tính tiền theo giây.
- Bảng tên riêng và xưng hô theo cả video. Cache dùng chung giữa người dùng khi có server thật.

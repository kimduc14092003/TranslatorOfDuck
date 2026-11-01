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
  4. `classifySpeech` và `splitSung`: lọc hát theo từng câu, trung vị > 0,33 s/chữ hoặc lời lặp.
  5. `segmentCues`: ≤ 7 s và ≤ 16 chữ Hán mỗi dòng.
  6. `translate`: kèm 3 dòng cuối của đoạn trước làm ngữ cảnh; rút gọn dòng quá dài.
- **Đổi logic thì tăng `PIPELINE_VERSION`** để bỏ kết quả cũ trong cache.

### Kiểm thử (đều chạy được không cần key)

| Lệnh | Kiểm tra gì |
|---|---|
| `cd alpha/server && npm test` | `test.mjs`: chia câu, mốc thời gian, lọc hát, cắt đoạn, giữ độ lệch đầu track âm thanh, câu vắt qua đầu đoạn khi vừa tua tới, đánh dấu dòng hát, tiếng đệm trong lời hát, dòng nói ngắn gộp vào dòng hát (18 kiểm tra). `queue-test.mjs`: hàng đợi khi tua liên tiếp (ưu tiên, huỷ, đẩy lên khi lướt tới ở cả hai chế độ lời bài hát, `rank`), Gemini hết lượt trong ngày (9 kiểm tra). `asr-fallback-test.mjs`: Fun-ASR hết hạn mức thì chuyển sang model dự phòng, giới hạn theo phút thì gọi lại (20 kiểm tra). `openai-test.mjs`: dịch bằng OpenAI giả, mức suy luận, đoạn dịch sẵn bỏ rút gọn (7 kiểm tra). `errors-test.mjs`: key dịch sai không chạy lại nhận dạng giọng nói, thiếu ffmpeg, file cache hỏng, Origin lạ, không phải JSON (11 kiểm tra). `lyrics-test.mjs`: chế độ lời bài hát, kể cả điệp khúc câu ngắn, ngữ cảnh ở chế độ thường, hai chế độ cùng lúc (14 kiểm tra) |
| `node alpha/dev/content-sim-test.mjs` | content.js + tap.main.js trong vm, không cần trình duyệt: mẩu nhanh, đồng hồ trình phát, lướt, tua, tắt sub, giãn lần thử lại, `rank`, chế độ lời bài hát và đổi chế độ giữa chừng (37 kiểm tra) |
| `node alpha/dev/content-time-test.mjs` | content.js theo thời gian: đồng hồ giả, các lượt tải chia băng thông. Thứ tự tải sau khi tua, mẩu nhanh nhường đường truyền, mẩu nhanh bị treo, không ngắt đoạn đã tải từ trước (3 kiểm tra) |
| `node alpha/dev/mp4audio-test.mjs` | Cắt âm thanh từ mp4 thật do ffmpeg tạo, đúng mốc trong khoảng 15 ms (4 kiểm tra) |
| `node alpha/dev/cues-test.mjs` | Gộp sub các đoạn, câu vắt qua ranh giới hai đoạn (5 kiểm tra) |
| `node alpha/dev/e2e.mjs` | Chromium thật + extension + Douyin giả + AI giả + server thật, có video dài 100 s, video "đã thích" ở cột bên, mẩu nhanh khi tua, đồng hồ trình phát lệch 50 s, CDN treo một lần, lời bài hát ♪, bấm ô tắt lời bài hát trong popup (24 kiểm tra) |

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
- **Đánh dấu ♪ theo từng câu** dựa vào độ dài chữ (> 0,33 s/chữ), nên câu nói kéo dài, la hét có thể bị đánh dấu ♪ (ví dụ "冲刺冲 → Tăng tốc nào!"). Trong một đoạn có cả câu hát lẫn câu nói, câu hát không đủ dài có thể không có ♪. Đã đo trên 13 video thật ngày 1/11 (§6l): ♪ đúng khoảng 90% số dòng được gắn, phủ khoảng 89% dòng hát có sub; rap và hô vè không bao giờ có ♪.
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
  - Chưa thấy Fun-ASR hết hạn mức thật; mã lỗi lấy theo tài liệu. Nếu lúc đó DashScope trả mã khác, server báo lỗi chứ không chuyển model. Mã nằm trong log server: dòng `báo HTTP 401/403/404: {…}` (lỗi key/model), hay dòng `LỖI HTTP 4xx: {…}` của đoạn đó.
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
  - **Chưa đổi code.** Mẫu nhỏ (13 video trong một buổi, 15 lỗi), và các mốc 0,20 và 3 chữ được chọn sau khi đã nhìn lỗi.
    - Cần đo một lô mới trước khi commit: ngâm thơ, livestream nói rồi hát, hát nhanh, và lướt feed ngẫu nhiên.
    - Với (b), phải xem câu nói ngắn kéo dài (kiểu "好的吧") ở chế độ thường.
- **Lỗi khác tìm thấy trong cùng đợt:**
  - **Video mở từ trang tìm kiếm không có sub** (4/4 video thử: 3 trong lúc đo, 1 lần kiểm lại).
    - Kết quả đầu của trang tìm kiếm tới qua `/aweme/v1/web/general/search/stream/`. Phản hồi này khai là JSON nhưng chia khúc trong thân: một dòng độ dài hex, rồi một khối JSON, cứ thế lặp lại.
    - `tap.main.js` đọc bằng `res.clone().json()` nên báo `parse_error`, và đường này cũng không có trong `PATHS`. Vì vậy `content.js` không có item cho `modal_id`: không hiện nhãn, không tải gì.
    - Đã kiểm trực tiếp trong trình duyệt; tải lại hẳn trang tìm kiếm vẫn vậy.
    - Sửa: tách dòng, bỏ dòng độ dài, parse từng khối JSON; thêm đường này vào `PATHS`.
  - **Trang kết quả tìm kiếm hiện sub của video khác.**
    - Sau khi tìm từ feed (chuyển trang phía client), slide feed cũ vẫn nằm trong DOM với `data-e2e="feed-active-video"`. `findActive()` lấy slide đó, còn `videoFor()` lấy thẻ `<video>` lớn nhất đang thấy, tức video xem trước dài 628 s của trang tìm kiếm.
    - Kết quả: sub "♪ …" của video piano 29 s hiện đè lên một video khác.
    - Sửa: chỉ nhận slide feed khi `<video>` của chính nó đang thấy.
  - **Đoạn đầu không được gửi, 30 s mới có sub** (1/13 video, bài hát có đoạn dạo guitar).
    - Lượt tải đoạn 0–20 bị chậm. Tới giây 20 đoạn đó không còn "cần" nên bị ngắt im lặng (`cancelUnwanted`). Đoạn 20–50 vì thế gửi dư 8 s, và có 0 dòng ngữ cảnh.
    - Mẩu nhanh 0–10 bị bỏ qua ("quá ít lời") nên không bù được, và mỗi lần đứng yên chỉ xét một mẩu nhanh.
    - Verifier dựng lại được trong vm khi lượt tải đoạn 0 chậm. Riêng việc mẩu nhanh bị bỏ qua thì không gây lỗi.
    - Sửa: khi đoạn ở chỗ đang xem tải chậm thì gửi mẩu nhanh tiếp theo hoặc mở thêm một lượt tải; cho xét lại mẩu nhanh khi mẩu trước bị bỏ qua.
  - **HTTP 429 khi tải video** (1/13 video, 2 đoạn, nhãn lỗi khoảng 24 s). Không rõ 429 đến từ CDN hay từ `/aweme/v1/play/`.
    - Extension coi 429 như lỗi tải thường: gọi lại ngay một lần, rồi cứ 20 s thử một lần, không đọc `Retry-After`, mỗi đoạn tự chờ riêng; mẩu nhanh mất luôn.
    - Lượng tải của extension thấp (5–7 lượt cho video 90 s), không có dấu hiệu chính nó gây ra 429.
    - Sửa: tách 429 thành loại lỗi riêng, giãn dần thời gian chờ và dùng chung cho mọi đoạn, trong lúc chờ thì tạm dừng dịch sẵn.
  - Bộ mô phỏng `alpha/dev/content-sim-test.mjs`: fetch giả không từ chối khi signal đã bị ngắt từ trước (fetch thật thì từ chối ngay).
- **Chưa đo:**
  - Model ASR dự phòng và Gemini với luật này. Gemini không có mốc từng chữ, nên ♪ gần như không bật.
  - Tiếng Quảng, song ca, giọng trẻ em, lời nói đè lên bài hát có lời.
  - Đo trực tiếp chế độ thường.
- Mẫu âm thanh tạm (TOD_DUMP) và ảnh chụp đã xoá sau khi đo. Nhãn và số liệu chỉ để trên máy.

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

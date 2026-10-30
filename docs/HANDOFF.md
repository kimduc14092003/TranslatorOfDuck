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
| `cd alpha/server && npm test` | Chia câu, mốc thời gian, lọc hát, cắt đoạn, giữ độ lệch đầu track âm thanh, câu vắt qua đầu đoạn khi vừa tua tới (14 kiểm tra); hàng đợi khi tua liên tiếp: ưu tiên, huỷ, đẩy lên khi lướt tới, Gemini hết lượt trong ngày (7 kiểm tra); dịch bằng OpenAI giả (5 kiểm tra) |
| `node alpha/dev/mp4audio-test.mjs` | Cắt âm thanh từ mp4 thật do ffmpeg tạo, đúng mốc trong khoảng 15 ms (4 kiểm tra) |
| `node alpha/dev/cues-test.mjs` | Gộp sub các đoạn, câu vắt qua ranh giới hai đoạn (5 kiểm tra) |
| `node alpha/dev/e2e.mjs` | Chromium thật + extension + Douyin giả + AI giả + server thật, có video dài 100 s, video "đã thích" ở cột bên (17 kiểm tra) |

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

# Thử nhanh nền tảng thứ hai (giai đoạn 2, 4/11/2026)

Mục đích: chọn nền tảng làm tiếp sau Douyin ở giai đoạn 5 (ROADMAP). Mỗi nền tảng trả lời bốn câu: trang có sẵn phụ đề không, đọc được không mà không tự ký yêu cầu, lấy được âm thanh trước chỗ đang xem không, rủi ro.

## Cách thử

- Chromium riêng ở cổng 9335, hồ sơ tạm, tắt tiếng, chế độ khách, **không đăng nhập**, không cookie có sẵn. Chỉ đọc, không sửa code sản phẩm.
- Mỗi nền tảng 3–4 video, mở lần lượt, nghỉ vài giây giữa hai video. Video lấy từ trang công khai: YouTube tìm "中文 vlog" lọc có phụ đề, Bilibili trang thịnh hành, TikTok trang khám phá.
- Script chỉ ghi **cấu trúc**: dữ liệu sẵn trong trang (có trường nào, bao nhiêu mục), yêu cầu mạng trang tự gửi (đường dẫn, tên tham số, loại, mã trả lời), cấu trúc phụ đề trang tự tải. Không ghi chữ phụ đề, tiêu đề, mô tả, không tải media. Dữ liệu thô đã xoá.
- Trước đó tìm trên web (nguồn ở cuối). Agent tìm hiểu lúc lập plan bị dừng vì hạn mức, nên phần web chỉ là vài lượt tìm.
- Chạy ở chế độ không cửa sổ (headless); một số kết quả có thể khác khi chạy có cửa sổ. Chỗ nào có thể bị ảnh hưởng thì ghi rõ.

## Kết quả

| | YouTube | Bilibili | TikTok |
|---|---|---|---|
| Xem không cần đăng nhập | Được (4/4) | Được (7/7) | Được (4/4) |
| Phụ đề có sẵn trong trang | Có danh sách track (`captionTracks`) trên 4/4 video; cả 4 có track tiếng Trung do người đăng làm | Không: danh sách phụ đề rỗng cho khách; API trình phát trả `need_login_subtitle: true`, 0 phụ đề (3/3) | `subtitleInfos` có ở 1/4 video (ASR của TikTok, WebVTT, tiếng Việt); 3 video ngắn còn lại không có |
| Đọc phụ đề mà không tự ký yêu cầu | Khó: URL trong `captionTracks` không có `pot`; yêu cầu phụ đề của chính trình phát có `pot` (mã PO token), nhưng trả 0 byte khi chạy headless (3/4) | Không áp dụng: phải đăng nhập (đã chốt không đăng nhập, ghi lại) | Trang không tự tải file phụ đề; đọc nó là yêu cầu của ta tới URL CDN có chữ ký |
| Âm thanh trước chỗ đang xem | Khó: định dạng âm thanh không có URL, trình phát dùng SABR (`serverAbrStreamingUrl`) | Có: `__playinfo__` có 3 track âm thanh DASH riêng (m4s), trình phát tự tải bằng yêu cầu theo khoảng byte, giống cách extension làm với Douyin | Chỉ có một file video gộp (`playAddr`), không có track âm thanh riêng; phải tải cả video |
| Nội dung tiếng Trung | Phải tìm; feed chung không phải tiếng Trung | Có, gần như toàn bộ | Theo vùng: ở Việt Nam trang khám phá ra video tiếng Việt |

### YouTube
- `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks` có trên cả 4 video, mỗi video 2–4 track (zh, zh-Hans, en…), kèm hơn 150 ngôn ngữ dịch máy của YouTube.
- URL track có `exp`, `expire`, `sparams`, `signature`, không có `pot`. Tài liệu tháng 6/2026 nói YouTube đòi PO token cho phụ đề; thiếu thì trả rỗng. Yêu cầu do chính trình phát gửi khi bật phụ đề (phím `c`) có `pot`, `potc`, `fmt`: thấy ở 3/4 video, cả 3 trả 200 mà 0 byte trong lần chạy headless. **Chưa rõ** là do headless hay do cách đọc; cần thử lại có cửa sổ trước khi kết luận.
- Âm thanh: 12 định dạng âm thanh mỗi video, không cái nào có URL hay `signatureCipher`; trình phát dùng SABR. Tải âm thanh trước chỗ đang xem như với Douyin là không làm được nếu không giả lập giao thức của trình phát.
- Hướng khả dĩ: đọc chính câu trả lời phụ đề trình phát đã tải (extension chỉ nghe, không gửi gì) rồi dịch chữ đó, không cần nhận dạng giọng nói. Cần thử có cửa sổ.

### Bilibili
- Khách xem được, không bị chặn. `window.__playinfo__` có DASH với 3 track âm thanh riêng trên CDN (`*.akamaized.net`, `bilivideo`); trình phát tự tải các khúc m4s bằng xhr.
- Phụ đề: `__INITIAL_STATE__.videoData.subtitle.list` rỗng; API trình phát (`x/player/wbi/v2`, trang tự gọi, có chữ ký WBI) trả 0 phụ đề và `need_login_subtitle: true` trên 3/3 video. Đúng như các nguồn trên web: phụ đề, kể cả phụ đề AI, chỉ dành cho người đã đăng nhập.
- Nghĩa là với khách, Bilibili đi đúng đường của Douyin: lấy âm thanh, tự nhận dạng, tự dịch. Track âm thanh riêng còn nhẹ hơn Douyin (không phải tách âm thanh khỏi file video).

### TikTok
- Trang video lẻ không đòi đăng nhập. `__UNIVERSAL_DATA_FOR_REHYDRATION__` có `webapp.video-detail` trên 4/4 video.
- `video.subtitleInfos`: 1/4 video có một track (nguồn ASR, WebVTT, ngôn ngữ theo người nói). Theo tài liệu, TikTok tự sinh phụ đề cho nhiều video từ cuối 2023, không phải tất cả.
- Trang không tự tải file phụ đề trong lúc thử; đọc file đó là yêu cầu riêng của ta.
- Media là một file video gộp, không có track âm thanh riêng.
- Ở Việt Nam trang khám phá ra video tiếng Việt; muốn thử nội dung tiếng Trung phải tìm riêng (chưa làm).

## Rủi ro điều khoản

Chưa đọc điều khoản chi tiết của từng nền tảng; việc này cần làm trước giai đoạn 5. Điều đã biết từ cách thử:
- Cả ba đều có chống bot ở API (YouTube: PO token/BotGuard; Bilibili: chữ ký WBI; TikTok: URL có chữ ký). Luật của dự án (không bỏ qua chống bot, không tự ký yêu cầu, chỉ đọc cái trang đã tải) loại bỏ mọi cách gọi API trực tiếp.
- Bilibili và Douyin: extension chỉ đọc lại khúc âm thanh mà trình phát vốn tải, như hiện nay với Douyin.

## Đề xuất cho giai đoạn 5

1. **Bilibili trước.** Nội dung tiếng Trung, khách xem được, âm thanh tách sẵn: dùng lại gần như nguyên đường ống Douyin (tải âm thanh theo khoảng byte, nhận dạng, dịch). Phụ đề có sẵn cần đăng nhập nên không trông vào nó. Việc chính: đọc `__playinfo__`, chia đoạn theo DASH, xử lý video nhiều phần (`p=`).
2. **YouTube sau**, theo hướng khác: đọc phụ đề trình phát đã tải (khi video có phụ đề) rồi chỉ dịch, không nhận dạng. Cần một lần thử có cửa sổ để xác nhận đọc được câu trả lời phụ đề của trình phát; video không có phụ đề thì chưa có đường lấy âm thanh.
3. **TikTok để cuối.** Phụ đề có ở một phần video, media gộp, nội dung ở Việt Nam ít tiếng Trung.

Chưa làm: thử có cửa sổ cho YouTube; tìm video tiếng Trung trên TikTok; đọc điều khoản.

## Nguồn

- YouTube PO token cho phụ đề: [DEV Community, 6/2026](https://dev.to/jamhimself/why-your-youtube-transcript-scraper-started-returning-empty-strings-and-how-to-fix-it-in-2026-20ed); [OpenCLI PR #1499](https://github.yxlr123.workers.dev/jackwener/OpenCLI/pull/1499) (đọc URL phụ đề có `pot` của chính trình phát); [youtube-transcript-api issue #592](https://github.com/jdepoix/youtube-transcript-api/issues/592) (`exp=xpe`); [hướng dẫn distube](https://distube.js.org/ytdl-core/guides/captions/) (không ghi ngày, nói chưa cần PO token: có thể đã cũ).
- Bilibili phụ đề cần đăng nhập: [bilibili-data-mcp](https://pypi.org/project/bilibili-data-mcp), [bilibili-subtitle skill](https://smithery.ai/skills/neversight/bilibili-subtitle), [glama.ai](https://glama.ai/mcp/servers/hm8rgkg2yh).
- TikTok `subtitleInfos`: [commit yt-dlp (bản sao)](https://gitea.smoothnet.org/nhyatt/yt-dlp/commit/2f97779f335ac069ecccd9c7bf81abf4a83cfe7a); phụ đề tự sinh: [Kapwing](https://www.kapwing.com/resources/a-complete-guide-to-tiktok-subtitles/).

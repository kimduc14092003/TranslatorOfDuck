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
- URL track có `exp`, `expire`, `sparams`, `signature`, không có `pot`. Tài liệu tháng 6/2026 nói YouTube đòi PO token cho phụ đề; thiếu thì trả rỗng. Yêu cầu do chính trình phát gửi khi bật phụ đề (phím `c`) có `pot`, `potc`, `fmt`: thấy ở 3/4 video, cả 3 trả 200 mà 0 byte trong lần chạy headless.
- **Thử lại có cửa sổ (4/11, 5 video):** vẫn 200 và 0 byte. Nút phụ đề đang bật mà trình phát vẽ 0 dòng phụ đề; `navigator.webdriver` là `true`. Nghĩa là YouTube trả phụ đề rỗng cho trình duyệt điều khiển tự động, không phải lỗi cách đọc. Tự động hoá không trả lời được câu này; cần kiểm chỉ đọc trên trình duyệt thật (Chromium của chủ dự án, `rec.mjs` ở cổng 9333) khi bạn mở một video có phụ đề.
- Âm thanh: 12 định dạng âm thanh mỗi video, không cái nào có URL hay `signatureCipher`; trình phát dùng SABR. Tải âm thanh trước chỗ đang xem như với Douyin là không làm được nếu không giả lập giao thức của trình phát.
- Hướng khả dĩ: đọc chính câu trả lời phụ đề trình phát đã tải (extension chỉ nghe, không gửi gì) rồi dịch chữ đó, không cần nhận dạng giọng nói. Cần kiểm trên trình duyệt thật như trên.

### Bilibili
- Khách xem được, không bị chặn. `window.__playinfo__` có DASH với 3 track âm thanh riêng trên CDN (`*.akamaized.net`, `bilivideo`); trình phát tự tải các khúc m4s bằng xhr.
- Phụ đề: `__INITIAL_STATE__.videoData.subtitle.list` rỗng; API trình phát (`x/player/wbi/v2`, trang tự gọi, có chữ ký WBI) trả 0 phụ đề và `need_login_subtitle: true` trên 3/3 video. Đúng như các nguồn trên web: phụ đề, kể cả phụ đề AI, chỉ dành cho người đã đăng nhập.
- Nghĩa là với khách, Bilibili đi đúng đường của Douyin: lấy âm thanh, tự nhận dạng, tự dịch. Track âm thanh riêng còn nhẹ hơn Douyin (không phải tách âm thanh khỏi file video).

### TikTok
- Trang video lẻ không đòi đăng nhập. `__UNIVERSAL_DATA_FOR_REHYDRATION__` có `webapp.video-detail` trên 4/4 video.
- `video.subtitleInfos`: 1/4 video có một track (nguồn ASR, WebVTT, ngôn ngữ theo người nói). Theo tài liệu, TikTok tự sinh phụ đề cho nhiều video từ cuối 2023, không phải tất cả.
- Trang không tự tải file phụ đề trong lúc thử; đọc file đó là yêu cầu riêng của ta.
- Media là một file video gộp, không có track âm thanh riêng.
- Ở Việt Nam trang khám phá ra video tiếng Việt. Thử tìm video tiếng Trung: trang thẻ (`/tag/中国`) và trang tìm kiếm (`/search/video?q=中文vlog`) đều không hiện video nào cho khách (0 video). Không đăng nhập thì không tới được nội dung tiếng Trung theo đường người xem bình thường.

## Rủi ro điều khoản

Đọc điều khoản hiện hành ngày 4/11 (tóm tắt bằng lời của tôi, không phải ý kiến pháp lý; nguồn ở cuối):

| | Tự động truy cập, thu thập | Sửa, dịch, tác phẩm phái sinh | Tải, sao chép | Né biện pháp kỹ thuật |
|---|---|---|---|---|
| YouTube | Cấm truy cập bằng phương thức tự động (robot, crawler), trừ công cụ tìm kiếm theo robots.txt hay khi được cho phép bằng văn bản | Cấm sửa đổi bất kỳ phần nào của Dịch vụ hay Nội dung, trừ khi Dịch vụ cho phép rõ | Cấm truy cập, tải, phát lại ngoài cách Dịch vụ cho phép; chỉ dùng cá nhân, phi thương mại | Cấm né, vô hiệu, can thiệp tính năng bảo mật hay chống sao chép |
| Bilibili | Điều 4.3.15: cấm dùng robot, crawler, script lấy dịch vụ, nội dung, dữ liệu nếu không có phép bằng văn bản | Điều 6.2: cấm sửa, cải biên, **dịch** phần mềm, kỹ thuật, tài liệu của nền tảng, cấm tác phẩm phái sinh | Điều 6.3, 6.5: cấm sao chép, phát tán; cấm đăng lại nội dung tự sản xuất, độc quyền | Không có điều riêng; gần nhất là điều 1.2 (cấm tách dịch vụ khỏi nền tảng bằng cách bẻ khoá) |
| TikTok | Cấm script tự động thu thập thông tin hay tương tác với Dịch vụ | Cấm sửa, **dịch**, tạo tác phẩm dựa trên Dịch vụ hay nội dung | Cấm lưu, sao chép, phát lại nội dung của TikTok nếu không có phép; chỉ dùng cá nhân | Cấm né biện pháp giới hạn truy cập |

Điều rút ra cho dự án:
- Cả ba đều có điều khoản về **dịch hay sửa nội dung** (Bilibili, TikTok nói thẳng "dịch"; YouTube nói "sửa đổi"). Đây là rủi ro của chính sản phẩm, cùng loại với Douyin (PLAN §12), không riêng nền tảng mới. Trước khi bán cần ý kiến pháp lý; chưa phải việc của giai đoạn này.
- Luật đang giữ của dự án đi đúng phía các điều khoản về tự động hoá và né kỹ thuật: extension chỉ chạy khi người xem đang xem, chỉ đọc cái trình phát đã tải, không tự ký yêu cầu, không bỏ qua chống bot, server không gọi API của nền tảng.
- Bilibili và Douyin: extension đọc lại khúc âm thanh trình phát vốn tải (theo khoảng byte), như hiện nay với Douyin. YouTube, nếu làm theo hướng đọc phụ đề trình phát đã tải, cũng không gửi yêu cầu riêng.

## Đề xuất cho giai đoạn 5

1. **Bilibili trước.** Nội dung tiếng Trung, khách xem được, âm thanh tách sẵn: dùng lại gần như nguyên đường ống Douyin (tải âm thanh theo khoảng byte, nhận dạng, dịch). Phụ đề có sẵn cần đăng nhập nên không trông vào nó. Việc chính: đọc `__playinfo__`, chia đoạn theo DASH, xử lý video nhiều phần (`p=`).
2. **YouTube sau**, theo hướng khác: đọc phụ đề trình phát đã tải (khi video có phụ đề) rồi chỉ dịch, không nhận dạng. Cần một lần thử có cửa sổ để xác nhận đọc được câu trả lời phụ đề của trình phát; video không có phụ đề thì chưa có đường lấy âm thanh.
3. **TikTok để cuối.** Phụ đề có ở một phần video, media gộp, nội dung ở Việt Nam ít tiếng Trung.

Chưa làm: kiểm phụ đề YouTube trên trình duyệt thật (cần bạn mở Chromium của bạn với một video có phụ đề); TikTok tiếng Trung khi có đăng nhập (đã chốt không đăng nhập).

## Nguồn

- YouTube PO token cho phụ đề: [DEV Community, 6/2026](https://dev.to/jamhimself/why-your-youtube-transcript-scraper-started-returning-empty-strings-and-how-to-fix-it-in-2026-20ed); [OpenCLI PR #1499](https://github.yxlr123.workers.dev/jackwener/OpenCLI/pull/1499) (đọc URL phụ đề có `pot` của chính trình phát); [youtube-transcript-api issue #592](https://github.com/jdepoix/youtube-transcript-api/issues/592) (`exp=xpe`); [hướng dẫn distube](https://distube.js.org/ytdl-core/guides/captions/) (không ghi ngày, nói chưa cần PO token: có thể đã cũ).
- Bilibili phụ đề cần đăng nhập: [bilibili-data-mcp](https://pypi.org/project/bilibili-data-mcp), [bilibili-subtitle skill](https://smithery.ai/skills/neversight/bilibili-subtitle), [glama.ai](https://glama.ai/mcp/servers/hm8rgkg2yh).
- Điều khoản: [YouTube](https://www.youtube.com/static?template=terms) (mục Quyền và hạn chế), [Bilibili 用户协议](https://www.bilibili.com/blackboard/protocal/international_hans.html) (điều 1.2, 4.3.15, 6.2, 6.3, 6.5), [TikTok Terms of Service](https://www.tiktok.com/legal/page/row/terms-of-service/en).
- TikTok `subtitleInfos`: [commit yt-dlp (bản sao)](https://gitea.smoothnet.org/nhyatt/yt-dlp/commit/2f97779f335ac069ecccd9c7bf81abf4a83cfe7a); phụ đề tự sinh: [Kapwing](https://www.kapwing.com/resources/a-complete-guide-to-tiktok-subtitles/).

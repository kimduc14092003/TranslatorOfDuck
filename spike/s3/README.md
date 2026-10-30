# S3/S4: thử nhận dạng giọng nói và dịch trên mẫu Douyin

## Cách nhanh (3 bước)

1. **Thu mẫu:** trong popup extension (v0.3.1), bấm **Bắt đầu thu mẫu** rồi lướt tab 推荐 tới khi đủ 60 mẫu. Extension tự dừng và tự lưu `tod_s3_manifest.json`.
2. **Điền key một lần:** chép `.env.example` thành `.env`, điền `GEMINI_API_KEY` và `DASHSCOPE_API_KEY`, rồi chạy `npm install`.
3. **Chạy một lệnh:** `node bench.mjs all --samples "D:\Download"`. Lệnh này làm hết các bước (tách âm thanh, gọi các dịch vụ, dịch thử, báo cáo). Xong thì gửi mình `work\report.md`.

Chưa có đáp án sửa tay thì báo cáo so các dịch vụ với Fun-ASR (cột "Lệch so với"). Muốn có CER thật, làm thêm phần "đáp án" bên dưới rồi chạy `node bench.mjs report`.

Nếu bạn có Claude Code trên máy, mở thư mục repo và bảo nó "chạy spike/s3 theo README" là nó tự làm bước 2–3, chỉ cần bạn tự điền key vào `.env`.

---

Mục tiêu (xem `docs/PLAN.md` mục 6.7 và 14): so sánh các dịch vụ nhận dạng giọng nói (ASR) trên chính video Douyin. So về độ chính xác (CER), độ trễ, có mốc thời gian theo từng từ không, và có bịa chữ khi gặp nhạc nền không. Sau đó dịch thử sang tiếng Việt.

Mọi thứ chạy **trên máy bạn**. API key nằm trong file `.env` ở máy bạn, không gửi cho ai và **không dán vào chat**.

Các dịch vụ được thử:

| Tên trong script | Dịch vụ | Mốc thời gian | Key cần có |
|---|---|---|---|
| `funasr` | Alibaba Fun-ASR-Flash (Singapore) | theo từ | `DASHSCOPE_API_KEY` |
| `qwen3` | Alibaba Qwen3-ASR-Flash (Singapore) | không có | `DASHSCOPE_API_KEY` |
| `gemini` | Gemini (mặc định `gemini-3.5-flash-lite`) | theo câu, do model tự ước | `GEMINI_API_KEY` |
| `groq-v3`, `groq-turbo` | Whisper large-v3 / turbo trên Groq | theo từ | `GROQ_API_KEY` (không bắt buộc) |

Thiếu key nào thì script bỏ qua dịch vụ đó.

## Bước 1: thu mẫu bằng extension (khoảng 15 phút)

1. Cập nhật thư mục `spike\s1` lên bản mới (v0.3.0). Ở `chrome://extensions` bấm ↻ của extension, rồi F5 tab Douyin.
2. Trong cài đặt Chrome, tắt tạm **"Hỏi vị trí lưu từng tệp trước khi tải xuống"**. Khi Chrome hỏi "Trang web muốn tải xuống nhiều tệp", chọn **Cho phép**.
3. Mở popup, ở phần **S3 · Thu mẫu âm thanh**, để số mẫu là 60 rồi bấm **Bắt đầu thu mẫu**.
4. Lướt tab 推荐 như bình thường, mỗi video dừng vài giây. Mỗi video được lưu khoảng 35 giây đầu thành file `tod_s3_xxxxxxxx.mp4` trong thư mục Downloads (của bạn có thể là `D:\Download`). Đủ số mẫu thì extension tự dừng.
5. Bấm **Lưu danh sách mẫu**. File `tod_s3_manifest.json` sẽ được lưu cùng thư mục.

Các file mẫu là nội dung có bản quyền. Chỉ dùng để thử trên máy bạn, đừng chia sẻ, và xóa sau khi xong.

## Bước 2: cài và cấu hình (một lần)

1. Cài Node.js bản LTS (18 trở lên) từ nodejs.org.
2. Mở PowerShell trong thư mục `spike\s3` và chạy `npm install`. Lệnh này tải sẵn ffmpeg; nếu máy bạn đã có ffmpeg trong PATH thì bước này không bắt buộc.
3. Chép `.env.example` thành `.env` rồi điền key:
   - `GEMINI_API_KEY`: lấy ở Google AI Studio.
   - `DASHSCOPE_API_KEY`: lấy ở Alibaba Model Studio quốc tế, vùng Singapore. Nếu console bảo dùng domain workspace, đặt thêm `DASHSCOPE_BASE=https://<WorkspaceId>.ap-southeast-1.maas.aliyuncs.com`.
   - `GROQ_API_KEY`: không bắt buộc.

## Bước 3: chạy

```powershell
node bench.mjs prepare --samples "D:\Download"   # tách 30 s âm thanh đầu → work\audio\*.mp3
node bench.mjs asr                               # gọi từng dịch vụ (khoảng 5–10 phút cho 60 mẫu)
node bench.mjs refs                              # tạo bản nháp đáp án → work\refs_draft\
```

Tiếp theo, làm đáp án để chấm điểm (cần ít nhất 20 mẫu, càng nhiều càng tốt):
1. Mở từng file `work\refs_draft\<mã>.txt`, nghe file `work\audio\<mã>.mp3` và sửa cho đúng lời nói, bằng chữ Hán giản thể. `INDEX.md` có mô tả từng video cho dễ tìm. Video không có lời nói thì để file rỗng.
2. Chép các file đã sửa sang `work\refs\`, giữ nguyên tên file.

Sau đó:

```powershell
node bench.mjs translate   # dịch thử sang tiếng Việt bằng Gemini → work\mt\gemini\*.vi.srt
node bench.mjs report      # tổng hợp → work\report.md và work\report.json
```

- Chỉ chạy một vài dịch vụ: `--providers funasr,gemini`.
- Thử ít mẫu trước: `--limit 5`.
- Chạy lại mẫu đã xong: `--force`. Mặc định script bỏ qua mẫu đã chạy được, nên lỡ bị ngắt giữa chừng thì chạy lại là được.
- Xem sub tiếng Việt trên video: mở lại video đó trên Douyin rồi nạp file `.vi.srt` bằng extension Subtitle Overlay.

## Gửi kết quả cho mình

Gửi file `work\report.md` và `work\report.json`. **Đừng gửi file `.env`.** Bảng báo cáo có:
- **CER:** tỉ lệ lỗi ký tự so với đáp án (càng thấp càng tốt).
- **Độ trễ p50 / p95:** thời gian từ lúc gửi tới lúc nhận kết quả cho mỗi đoạn 30 giây.
- **Nhanh hơn thời gian thực:** xử lý nhanh gấp bao nhiêu lần độ dài âm thanh.
- **Có mốc theo từ:** số mẫu có mốc thời gian từng từ.
- **Nghi bịa chữ:** số mẫu có quá 12 chữ/giây hoặc lặp cụm từ (dấu hiệu bịa chữ khi gặp nhạc).
- Lỗi đầu tiên của từng dịch vụ, nếu có.

## Chi phí

- 60 mẫu × 30 giây = 30 phút âm thanh cho mỗi dịch vụ.
- Alibaba: nằm trong 10 giờ miễn phí (2 model là 1 giờ).
- Gemini Flash-Lite và Groq: dùng gói miễn phí. Gói miễn phí của Gemini có thể dùng dữ liệu để cải thiện sản phẩm, nên chỉ dùng với video công khai như ở đây.

## Kiểm thử script (cho dev)

`node dev/selftest.mjs` dựng một server giả trả về đúng dạng response trong tài liệu của từng dịch vụ, rồi chạy cả 5 lệnh và kiểm 7 điều kiện. Không cần key thật.

Định dạng request lấy theo tài liệu chính thức đọc ngày 30/10/2026. Một số chỗ tài liệu ghi không thống nhất, nên lần chạy thật đầu tiên có thể lộ ra lỗi; nếu có, gửi mình phần "Lỗi đầu tiên" trong báo cáo:
- dạng response của Fun-ASR-Flash;
- domain quốc tế của Alibaba;
- cách viết tên trường khi gửi audio cho Gemini.

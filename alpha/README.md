# TranslatorOfDuck · bản Alpha

Bản thử chạy trên máy bạn. Khi lướt Douyin, sub tiếng Việt hiện đè lên video, đúng lúc người nói.

- Video được chia thành từng đoạn 30 giây (video từ 30 giây trở xuống thì dịch một lần).
  - Extension luôn dịch trước 30 giây so với chỗ bạn đang xem. Tua tới đâu dịch tới đó.
  - Phần bạn không xem thì không dịch, nên không tốn tiền API.
  - 4 video kế tiếp trong feed được dịch sẵn đoạn đầu.
- Extension chỉ tải đúng phần cần của video, tự tách riêng âm thanh rồi gửi tới **server chạy trên chính máy bạn**.
- Server tách âm thanh, nhận dạng giọng nói (Fun-ASR, hoặc Gemini nếu không có key Alibaba), chia câu, dịch bằng OpenAI hoặc Gemini rồi trả sub về. Fun-ASR hết hạn mức thì server tự chuyển sang `qwen-audio-3.1-asr-flash` (cùng key Alibaba), popup ghi rõ đang dùng model nào.
- Mặc định dịch cả lời bài hát: dòng hát hiện "♪" ở đầu. Tắt bằng nút "Dịch cả lời bài hát (♪)" trong popup thì video bài hát bị bỏ qua như trước, và video nói chuyện có xen đoạn hát chỉ bỏ những câu hát. Đổi nút giữa chừng thì chỉ những đoạn có hát được làm lại, phần nhận dạng giọng nói thường được dùng lại. Chế độ này cần Fun-ASR: nhận dạng bằng Gemini gần như không nhận ra câu hát. Video chỉ có nhạc (không lời) luôn bỏ qua.
- Key nằm trong file `.env` trên máy bạn, không gửi đi đâu ngoài nhà cung cấp AI.

## Chạy lần đầu (Windows)

**1. Cài server** (chỉ làm một lần). Mở PowerShell:

```powershell
cd D:\Project\TranslatorDuck\TranslatorOfDuck
git pull
cd alpha\server
npm install
copy .env.example .env
notepad .env
```

Trong Notepad, điền key rồi lưu:

```
OPENAI_API_KEY=key OpenAI của bạn (dịch)
DASHSCOPE_API_KEY=key Alibaba của bạn (Fun-ASR)
```

Dịch dùng OpenAI nếu có `OPENAI_API_KEY`, không thì dùng `GEMINI_API_KEY`. Đổi model OpenAI bằng dòng `OPENAI_MODEL=...`. Với model suy luận, thêm `OPENAI_REASONING_EFFORT=none` (hoặc `low` nếu model không nhận `none`) để sub ra nhanh. Dịch vụ khác cùng kiểu API với OpenAI thì đặt `OPENAI_BASE=.../v1`. Nếu chỉ có `GEMINI_API_KEY` thì server vẫn chạy (Gemini lo cả nhận dạng lẫn dịch), nhưng Fun-ASR cho mốc thời gian chuẩn hơn. Key Gemini gói miễn phí hết lượt sau vài chục video mỗi ngày.

**2. Bật server** (mỗi lần dùng):

```powershell
cd D:\Project\TranslatorDuck\TranslatorOfDuck\alpha\server
npm start
```

Thấy dòng `TranslatorOfDuck Alpha server: http://127.0.0.1:8787` là được. Để nguyên cửa sổ này; mỗi video dịch xong sẽ in một dòng ở đây.

**3. Cài extension** (chỉ làm một lần):

- Mở `chrome://extensions` (Cốc Cốc: `coccoc://extensions`) và bật **Developer mode**.
- **Gỡ hoặc tắt** extension S1 cũ ("TranslatorOfDuck S1 spike (đo đạc)"), để hai cái không cùng móc vào trang.
- Bấm **Load unpacked** và chọn thư mục `D:\Project\TranslatorDuck\TranslatorOfDuck\alpha\extension`.
- Bấm biểu tượng extension rồi **Kiểm tra server**. Phải hiện chữ xanh "Server chạy…".

**4. Dùng:** mở https://www.douyin.com/ (tab 推荐) rồi lướt như bình thường.

- Góc trên trái video có nhãn:
  - **VI · đang dịch…** (vàng): đang chờ.
  - **VI** (xanh): đã có sub.
  - **bỏ qua** (xám), kèm lý do và số giây đã nghe, ví dụ "bài hát (60 s đầu)" hoặc "không nghe thấy lời (60 s đầu)". Cửa sổ `npm start` in thêm mấy chữ đầu nghe được.
  - **lỗi** (đỏ): kèm lý do ngắn.
- Video đầu tiên mất vài giây. Các video sau thường đã dịch xong trước khi bạn lướt tới.
- Popup cho bật/tắt dịch lời bài hát, đổi vị trí sub (dưới / giữa / trên), cỡ chữ, và xem thống kê của tab.
- **Sub lệch so với lời nói:** trên trang Douyin bấm phím `]` (sub muộn hơn 0,1 s) hoặc `[` (sớm hơn 0,1 s), hoặc dùng nút − / + trong popup. Mức lệch được lưu cho mọi video.

## Giới hạn của bản Alpha

- Chỉ hỗ trợ www.douyin.com: lướt feed, `?modal_id=` và trang `/video/...`.
- Bộ lọc nói/hát còn đơn giản: thỉnh thoảng bỏ nhầm video có lời, hoặc dịch nhầm một bài hát. Gặp trường hợp sai, gửi dòng log của video đó trong cửa sổ `npm start`.
- Chưa hỗ trợ (nhãn đỏ sẽ ghi rõ): video có mục lục nằm ở cuối file, và âm thanh không phải AAC. Cả hai đều hiếm trên Douyin.
- Sub đã dịch được lưu theo từng đoạn ở `alpha\server\work\cache`. Xem lại hay tua lại không tốn thêm tiền API. Xóa thư mục này nếu muốn dịch lại.
- Tua tới chỗ chưa dịch thì mất vài giây mới có sub (nhãn vàng "đang dịch…").

## Gặp lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| Nhãn đỏ "không kết nối được server" | Cửa sổ `npm start` đã bị đóng. Mở lại theo bước 2. |
| Popup: "thiếu OPENAI_API_KEY hoặc GEMINI_API_KEY" | Kiểm tra file `alpha\server\.env`, rồi tắt và bật lại `npm start`. |
| Nhãn đỏ "OpenAI hết hạn mức…" hoặc "Gemini đã hết lượt…" | Key hết tiền hoặc hết lượt miễn phí. Server tạm ngừng gọi 10 phút; nạp tiền hoặc đổi key rồi bật lại `npm start`. |
| `npm` báo ENOENT / không thấy package.json | Bạn đang đứng sai thư mục. `cd` vào `alpha\server` trước. |
| Không thấy nhãn nào trên video | Tải lại trang Douyin (F5) sau khi cài hoặc cập nhật extension. |
| Lỗi "ffmpeg" | Chạy lại `npm install` trong `alpha\server`. |

Đừng dán key vào chat, và đừng gửi file `.env` cho ai.

## Cho người phát triển

- `npm test` trong `alpha/server`: kiểm tra chia câu, mốc thời gian, lọc nói/hát (không cần key).
- `node alpha/dev/mp4audio-test.mjs`: kiểm tra phần đọc mp4 và cắt âm thanh của extension trên file thật do ffmpeg tạo (cần ffmpeg).
- `node alpha/dev/cues-test.mjs`: kiểm tra phần gộp sub các đoạn ở extension, nhất là câu vắt qua ranh giới hai đoạn.
- `TOD_DUMP=1 npm start`: server giữ lại âm thanh nhận được ở `work/dump`, tên file kèm mốc bắt đầu (`.at<giây>.aac`), để soi lỗi nhận dạng hay lệch thời gian. Đây là âm thanh video có bản quyền: chỉ để trên máy, xoá sau khi xong.
- `node alpha/dev/e2e.mjs`: kiểm thử toàn trình, có cả video dài chia đoạn. Chạy Chromium thật có extension, một Douyin giả, các dịch vụ AI giả và server thật. Cần playwright, ffmpeg và openssl.

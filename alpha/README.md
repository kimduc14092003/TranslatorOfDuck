# TranslatorOfDuck · bản Alpha

Bản thử chạy trên máy bạn. Khi lướt Douyin, sub tiếng Việt hiện đè lên video, đúng lúc người nói.

- Extension tải trước đoạn đầu (60 giây) của video đang xem và 2 video kế tiếp. Nó gửi đoạn đó tới **server chạy trên chính máy bạn**.
- Server tách âm thanh, nhận dạng giọng nói (Fun-ASR, hoặc Gemini nếu không có key Alibaba), chia câu, dịch bằng Gemini rồi trả sub về.
- Video chỉ có nhạc hoặc bài hát sẽ bỏ qua (góc video hiện "không có lời nói").
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
GEMINI_API_KEY=key Gemini của bạn
DASHSCOPE_API_KEY=key Alibaba của bạn (Fun-ASR)
```

Có thể chép đúng 2 dòng này từ `spike\s3\.env` đã dùng lần trước. Chỉ cần `GEMINI_API_KEY` cũng chạy được, nhưng Fun-ASR cho mốc thời gian chuẩn hơn.

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
  - **không có lời nói** (xám): bài hát hoặc nhạc, bỏ qua.
  - **lỗi** (đỏ): kèm lý do ngắn.
- Video đầu tiên mất vài giây. Các video sau thường đã dịch xong trước khi bạn lướt tới.
- Popup cho đổi vị trí sub (dưới / giữa / trên), cỡ chữ, và xem thống kê của tab.

## Giới hạn của bản Alpha

- Chỉ dịch **60 giây đầu** mỗi video (đổi được bằng `MAX_SECONDS=` trong `.env`).
- Chỉ hỗ trợ www.douyin.com: lướt feed, `?modal_id=` và trang `/video/...`.
- Bộ lọc nói/hát còn đơn giản: thỉnh thoảng bỏ nhầm video có lời, hoặc dịch nhầm một bài hát.
- Sub đã dịch được lưu ở `alpha\server\work\cache`. Xem lại video cũ sẽ không tốn thêm tiền API. Xóa thư mục này nếu muốn dịch lại.

## Gặp lỗi

| Hiện tượng | Cách xử lý |
|---|---|
| Nhãn đỏ "không kết nối được server" | Cửa sổ `npm start` đã bị đóng. Mở lại theo bước 2. |
| Popup: "thiếu GEMINI_API_KEY" | Kiểm tra file `alpha\server\.env`, rồi tắt và bật lại `npm start`. |
| `npm` báo ENOENT / không thấy package.json | Bạn đang đứng sai thư mục. `cd` vào `alpha\server` trước. |
| Không thấy nhãn nào trên video | Tải lại trang Douyin (F5) sau khi cài hoặc cập nhật extension. |
| Lỗi "ffmpeg" | Chạy lại `npm install` trong `alpha\server`. |

Đừng dán key vào chat, và đừng gửi file `.env` cho ai.

## Cho người phát triển

- `npm test` trong `alpha/server`: kiểm tra chia câu, mốc thời gian, lọc nói/hát (không cần key).
- `node alpha/dev/e2e.mjs`: kiểm thử toàn trình. Chạy Chromium thật có extension, một Douyin giả, các dịch vụ AI giả và server thật. Cần playwright, ffmpeg và openssl.

# Bộ công cụ đo trên Douyin thật

Dùng để chấm bảng điểm "ngon" ([`docs/ROADMAP.md`](../../../docs/ROADMAP.md) §3) sau mỗi thay đổi, và để soát lỗi trên video thật.

## Luật

- **Ít video, nhịp người xem:** xem lần lượt ở tốc độ 1×, chế độ khách (`jingxuan?modal_id=`), không đăng nhập hộ, không tự động lướt hàng loạt. Bộ video thử ở `videos.json` có 13 mục.
- **Dữ liệu của video** (âm thanh, chữ nhận dạng, bản dịch) chỉ để trên máy và **xoá khi xong lượt đo**. `run.mjs` và `scroll.mjs` tự xoá, chỉ giữ điểm số; lượt bị dừng giữa chừng thì lần chạy `run.mjs` sau xoá phần còn sót. `watch.mjs` chạy riêng và `rec.mjs` thì giữ mẫu (có chữ sub): xem xong tự xoá. Repo chỉ có id video và thể loại.
- **Tốn tiền:** mỗi video đo là một lượt nhận dạng và dịch thật, bằng key của bạn. Cả `videos.json` khoảng 29 phút âm thanh.
- **`scroll.mjs` là tự động lướt** (tối đa 10 video, mỗi video ít nhất 3 s): chỉ chạy khi chủ dự án yêu cầu.
- Kết quả nằm dưới `alpha/server/work/real/`; thư mục `work/` đã nằm ngoài git.
- Không đụng Chromium bạn dùng hằng ngày: công cụ mở Chromium riêng ở cổng 9334, hồ sơ tạm, tắt tiếng; server đo ở cổng 8788, proxy ở 8789.
- `replay.mjs`, `asr-replay.mjs` nạp `alpha/server/pipeline.mjs`, nên pipeline tự đọc `alpha/server/.env` (không in ra). Agent phải chạy trên bản sao không có `.env`.

## Cài một lần

```bash
cd alpha/dev/real
npm i --no-save playwright
npx playwright install chromium
```

Server đo dùng key trong `alpha/server/.env`, giống server hằng ngày. Đặt `CHROME=<đường dẫn>` nếu muốn dùng Chromium khác.

## Lệnh

| Lệnh | Làm gì |
|---|---|
| `node run.mjs` | Chạy cả `videos.json`. Mỗi video có một server đo với cache trống, một proxy ghi yêu cầu, một Chromium riêng; chấm điểm; xoá dữ liệu video; in bảng và ghi `summary.json`, `history.jsonl` |
| `node run.mjs --items 2,4 --keep` | Chạy vài mục (số thứ tự trong `videos.json`; `--ids` chọn theo id), **giữ** dữ liệu để soát; xong thì `node run.mjs --clean <tên lượt>` |
| `node run.mjs --throttle 450` | Như trên, mạng giả lập chậm 450 KB/s (HANDOFF §6t) |
| `node run.mjs --lyrics off` | Tắt chế độ lời bài hát |
| `node watch.mjs <id> [--rate 1] [--from s] [--to s] [--server URL]` | Xem một video, ghi `samples.jsonl` (100 ms trong 10 s đầu, rồi 250 ms) |
| `node report.mjs <thư mục lượt xem>` | Chấm bảng điểm của một lượt (`run.mjs --keep` để lại thư mục) |
| `node cache-scan.mjs [thư mục cache]` | Quét cache tìm câu bị mất; mặc định quét cache của server hằng ngày |
| `node window.mjs <thư mục cache> <id> <a> <b>` | In câu nghe được, dòng từng đoạn, dòng sau khi gộp trong khoảng [a, b] giây |
| `node replay.mjs <thư mục cache>` | Chạy lại offline bước cắt đoạn, chia dòng trên file nhận dạng đã giữ, để thử một thay đổi của pipeline mà không gọi dịch vụ |
| `node scroll.mjs <id đầu> 4,4,8,3 --fresh` | Lướt feed theo các khoảng dừng, đo "sẵn sàng khi lướt" |
| `node rec.mjs [tên]` | Ghi chỉ đọc Chromium bạn đang dùng (cổng 9333) |
| `node sw-source.mjs` | Kiểm service worker đang chạy có đúng bản trong `alpha/extension` không (cần Node 22 trở lên) |
| `node asr-replay.mjs <file.aac> <audioStart> <from> <to> [N]` | Gọi lại nhận dạng trên âm thanh đã giữ (`TOD_DUMP=1`). **Tốn tiền**, hỏi trước |

## Bảng điểm đo được

`report.mjs` in, cho mỗi lượt xem:
- **không mất câu vì luật của ta:** các vế câu cần duyệt: đoạn bị bỏ cả đoạn, đoạn lỗi hay dịch ra 0 dòng (theo proxy và file nhận dạng giữ lại), vế nghe được mà không thành dòng, dòng bỏ ở bước dịch, dòng bỏ khi ghép sub. Đã chấp nhận: đoạn không có chữ nào, chỉ có 嗯/啊, bài hát khi đã tắt lời bài hát, vế ở chỗ nối hai đoạn chỉ khác một chữ hay thiếu vài chữ (in riêng một dòng). Kết quả cũ mà server sẽ làm lại ("quá ít lời") không tính;
- **độ phủ lời nói** (chỉ để theo dõi);
- **hiện đúng dòng:** so sub đang hiện với dòng lẽ ra phải hiện, trên lưới 0,25 s;
- **chờ dịch khi đang xem**, **lỗi** (của ta, và phía Douyin như 429), **sub đầu tiên**;
- **tốc độ đọc** (ký tự/giây);
- **yêu cầu dịch bị huỷ** (theo proxy: bắt lỗi đoạn đầu bị huỷ lúc mở video);
- **quãng nghi nghe sót:** quãng hơn 4 s không có câu nào, để bạn nghe lại ("nghe đủ"); chưa lọc theo âm thanh nên có cả quãng nhạc, im lặng.

Trạng thái nhãn đọc theo màu chấm trên nhãn (`BADGE` trong `alpha/extension/content.js`), không theo chữ.

Chưa đo: **đúng nhịp** (Δin, cần lúc người nói bắt đầu, lấy từ âm thanh) và **♪ đúng** (cần nhãn nói hay hát).

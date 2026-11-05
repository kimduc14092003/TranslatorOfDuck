# Bộ công cụ đo trên Douyin thật

Dùng để chấm bảng điểm "ngon" ([`docs/ROADMAP.md`](../../../docs/ROADMAP.md) §3) sau mỗi thay đổi, và để soát lỗi trên video thật.

## Luật

- **Ít video, nhịp người xem:** xem lần lượt ở tốc độ 1×, chế độ khách (`jingxuan?modal_id=`), không đăng nhập hộ, không tự động lướt hàng loạt. Bộ video thử ở `videos.json` có 13 mục.
- **Dữ liệu của video** (âm thanh, chữ nhận dạng, bản dịch) chỉ để trên máy và **xoá khi xong lượt đo**. `run.mjs` và `scroll.mjs` tự xoá, chỉ giữ điểm số; lượt bị dừng giữa chừng thì lần chạy `run.mjs` sau xoá phần còn sót. `watch.mjs` chạy riêng và `rec.mjs` thì giữ mẫu (có chữ sub): xem xong tự xoá. Repo chỉ có id video và thể loại.
- **Tốn tiền:** mỗi video đo là một lượt nhận dạng và dịch thật, bằng key của bạn. Cả `videos.json` khoảng 29 phút âm thanh.
- **`scroll.mjs` là tự động lướt** (tối đa 10 video, mỗi video ít nhất 3 s): chỉ chạy khi chủ dự án yêu cầu.
- Kết quả nằm dưới `alpha/server/work/real/`; thư mục `work/` đã nằm ngoài git.
- Không đụng Chromium bạn dùng hằng ngày: công cụ mở Chromium riêng ở cổng 9334, hồ sơ tạm, tắt tiếng; server đo ở cổng 8788, proxy ở 8789.
- `replay.mjs`, `asr-replay.mjs`, `asr-bench.mjs` nạp `alpha/server/pipeline.mjs`, nên pipeline tự đọc `alpha/server/.env` (không in ra). Agent phải chạy trên bản sao không có `.env`.

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
| `node run.mjs --ids <id> --to 60` | Thử một video ngoài `videos.json`, chỉ xem 60 giây đầu (`--from` để bắt đầu muộn hơn) |
| `node tablive-real.mjs <url> --seconds 75 [--tail 3] [--keep]` | Thử đường dự phòng (âm thanh tab) trên một trang bất kỳ: server đo 8788, Chromium 9334 với bản sao extension có quyền tiêm mọi trang và cờ `--allowlisted-extension-id`; không phát ra loa. In chữ sub theo thời gian, xoá dữ liệu khi xong |
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
| `node asr-bench.mjs <tên lượt> [--go]` | So sánh các dịch vụ nhận dạng trên âm thanh của một lượt `run.mjs --keep` (mục dưới). **Tốn tiền**, hỏi trước |

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

## So sánh nhận dạng giọng nói (`asr-bench.mjs`)

Để chọn model nhận dạng theo chất lượng trên video thật. Dịch vụ có key trong `alpha/server/.env` thì được so, thiếu key thì bỏ qua (chỉ in tên biến thiếu):

| Hàng | Key | Ghi chú |
|---|---|---|
| mỗi model trong `ASR_BENCH_DASHSCOPE_MODELS` (mặc định `fun-asr,qwen3-asr-flash,qwen-audio-3.1-asr-flash`) | `DASHSCOPE_API_KEY` | `fun-asr` (và `*-filetrans`, `paraformer-*`) chỉ có dạng bất đồng bộ cần URL công khai, `*-realtime` chỉ có WebSocket: không gọi, chỉ ghi lý do. `qwen3-asr-flash` dạng đồng bộ không trả mốc thời gian |
| `elevenlabs` (scribe_v2) | `ELEVENLABS_API_KEY` | |
| `gemini` (gemini-3.5-transcribe) | `GEMINI_API_KEY` | gửi âm thanh base64 thẳng trong mục `audio`; `--gemini-upload` thì tải lên Files API trước (thời gian đo gồm cả lần tải lên, file xoá ngay sau đó) |
| `azure` (MAI-Transcribe-2) | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | mặc định gọi `<vùng>.api.cognitive.microsoft.com`; không được thì đặt `AZURE_SPEECH_BASE=https://<tên resource>.cognitiveservices.azure.com` |

```bash
node run.mjs --items 2,4 --keep --name so-asr     # server đo giữ âm thanh từng đoạn (TOD_DUMP)
node asr-bench.mjs so-asr                         # chỉ in kế hoạch: số đoạn, dịch vụ, số lần gọi
node asr-bench.mjs so-asr --go                    # gọi thật; chạy lại thì chỉ gọi lại chỗ lỗi (--fresh: gọi lại hết)
node asr-bench.mjs --clean so-asr && node run.mjs --clean so-asr    # xem xong: xoá chữ nhận dạng và âm thanh
```

Tham số: `--lang zh` gợi ý ngôn ngữ cho mọi dịch vụ (mặc định để dịch vụ tự nhận; server hằng ngày luôn gợi ý zh), `--providers dashscope,gemini` chỉ so vài dịch vụ, `--limit N` số đoạn, `--top N` số đoạn chênh nhau in ra, `--timeout ms` hạn mỗi lần gọi (mặc định 60 s). Lỗi in đủ câu dịch vụ trả về. Đầu vào cũng có thể là thư mục hay file `.aac`; cùng âm thanh giữ hai lần chỉ tính một lần. Mỗi đoạn tách mp3 16 kHz mono một lần (`extractAudio`), gửi song song cho các dịch vụ; 429 hay 5xx thì gọi lại một lần, quá hạn thì tính lỗi.

Bảng in ra, mỗi dịch vụ một hàng (cũng ghi ở `metrics.json`, không có chữ):
- **đoạn ok / lỗi / gọi lại**, **p50, p95 ms** (thời gian một lần gọi, kể cả gọi lại);
- **có dấu câu**, **có mốc từ**: phần trăm đoạn có chữ;
- **đoạn có từ > 2 s**: từ bị kéo dài (lỗi đã gặp với qwen-audio); **từ trung vị**: thời lượng trung vị một từ (dịch vụ chia từ khác nhau: Fun-ASR theo từ, có dịch vụ theo chữ, nên chỉ so cùng dịch vụ giữa các lượt);
- **báo ngôn ngữ đúng**: ngôn ngữ dịch vụ báo khớp hệ chữ của bản đồng thuận (bản gần các bản khác nhất); Fun-ASR, Gemini không báo ngôn ngữ; **chữ đúng hệ**: chữ trả về cùng hệ chữ đó (bắt dịch vụ dịch sang tiếng Anh thay vì chép);
- **trống khi bên khác có chữ**: bỏ sót cả đoạn;
- **CER TB** và bảng **CER từng cặp**: tỉ lệ lỗi ký tự khi lấy dịch vụ kia làm chuẩn (bỏ dấu câu, dấu cách, NFKC, chữ thường; không có OpenCC nên phồn thể và giản thể tính là khác). Không có bản chuẩn do người chép, nên đây là **độ đồng thuận**, không phải độ đúng.

Cuối cùng là **các đoạn chênh nhau nhất**: id, khoảng thời gian trong video, chữ của từng dịch vụ, để bạn mở video nghe lại chỗ đó và biết bên nào đúng. Chỉ chỗ này in chữ ra màn hình.

Dữ liệu: âm thanh và chữ nhận dạng có bản quyền. Kết quả chỉ nằm ở `alpha/server/work/asr-bench/<tên>` (ngoài git): `chunks.jsonl` (có chữ, để chạy lại không tốn tiền) và `metrics.json` (chỉ số). Xem xong thì `--clean`.

Kiểm tra (không cần key, không gọi dịch vụ thật; bốn dịch vụ giả trên máy): `node asr-bench-test.mjs`. Agent chạy trên bản sao không có `alpha/server/.env`.

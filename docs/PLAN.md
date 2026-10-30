# TranslatorOfDuck: Kế hoạch lõi (bản cuối)

> **Ngày lập:** 2026-10-29. **Phạm vi v1:** feed Douyin web, Trung → Việt, extension Chromium MV3 (Chrome, Cốc Cốc), bán gói thuê bao, khóa ASR/LLM chỉ ở server.
> **Quy ước:** **(giả định)** = số của nhóm, phải đo lại; **(cần kiểm chứng)** = nguồn thứ cấp, mâu thuẫn hoặc chưa đo. Chi phí quy đổi 27.000 đ/USD (giá bán Vietcombank ~26.490 đ + phí thẻ; giả định). Mô hình chi phí và mô phỏng: [`cost_model.py`](cost_model.py) (chạy `python3 docs/cost_model.py`). Đã sửa theo phản biện kỹ thuật (K) và kinh doanh (B), xem cuối bài.

## Tóm tắt nhanh (đọc trong 3 phút)

**Sản phẩm.** Extension cho Chrome và Cốc Cốc. Khi lướt feed Douyin, video có lời sẽ hiện sub tiếng Việt đúng lúc người nói bắt đầu nói. Câu được chia và hiển thị theo chuẩn sub chuyên nghiệp: tối đa 2 dòng, mỗi dòng ≤ 42 ký tự, tốc độ đọc khoảng 17 ký tự/giây (theo Netflix). Bán gói theo số phút sub; khóa API của dịch vụ AI chỉ nằm trên server.

**Vì sao không trễ.** Không nghe âm thanh tab như các extension caption hiện có. Trang Douyin tự tải JSON danh sách khoảng 20 video, kèm link media. Extension:
1. Đọc JSON đó bằng cách hook `fetch`/XHR ở chế độ chỉ đọc.
2. Tải trước một đoạn âm thanh đầu (W0, 6–15 giây) của video đang xem và video kế tiếp.
3. Gửi lên server để nhận dạng giọng nói, chia câu, rồi dịch.
4. Hiện sub theo đồng hồ khung hình của video (`requestVideoFrameCallback`).

Vì vậy sub đã có trước khi người nói tới câu đó.

**Giới hạn cần nói thẳng.**
- Video đầu tiên của mỗi phiên chưa kịp tải trước, nên có thể thiếu sub 2–5 giây đầu. Mục tiêu: sub đầu tiên có sau ≤ 2,5 giây (trung vị).
- Từ video thứ hai trở đi, nếu bạn dừng trung bình ≥ 3 giây mỗi video, mục tiêu là ≥ 90% video có sub sẵn khi vuốt tới.

**Kiến trúc (5 khối).**
1. Script MAIN-world đọc JSON feed của trang.
2. Content script: chọn video đang xem, tải đoạn âm thanh bằng Range request, vẽ sub (shadow DOM).
3. Offscreen document: tách âm thanh AAC sang M4A mà không mã hóa lại (khoảng 240–480 KB cho 30 giây), quản lý hàng đợi, gửi lên server.
4. API trên Cloudflare Workers: tài khoản, hạn mức, gọi nhận dạng giọng nói và LLM dịch, stream sub về.
5. Media worker ở Singapore: nhận diện ngôn ngữ và nhạc nền, gọi nhà cung cấp AI qua một đường mạng cố định.

**Chọn dịch vụ AI** (chốt bằng thử nghiệm so sánh ở M0):
- Nhận dạng giọng nói tiếng Trung: Alibaba Fun-ASR/Qwen3-ASR (máy chủ Singapore, khoảng 0,126 USD/giờ) hoặc Soniox (0,10 USD/giờ). ElevenLabs dùng làm mốc chất lượng. Whisper/Groq chỉ dự phòng, vì kém với tiếng Trung có nhạc nền.
- Dịch: Claude Haiku 5.5, Gemini Flash-Lite, Qwen..., chọn model rẻ nhất đạt ngưỡng chất lượng.

**Chi phí và giá** (giả định; tính lại bằng [`cost_model.py`](cost_model.py)):
- Chi phí biến đổi khoảng 0,0047 USD/phút sub (stack Alibaba + Claude Haiku 5.5).
- Gói 30 ngày: 79k / 149k / 299k đồng cho 300 / 650 / 1.300 phút.
- Biên lợi nhuận gộp khoảng 43–49% ở mức dùng điển hình, và ≥ 22% ở trường hợp xấu nhất.
- Dùng thử 60 phút tốn khoảng 0,28 USD/người.
- Chi phí cố định khoảng 40 USD/tháng, nên cần khoảng 13 người trả tiền để hòa vốn.

**Thanh toán.**
- Stripe không hỗ trợ người bán ở Việt Nam, nên dùng VietQR (payOS hoặc SePay) và bán gói trả trước (pass).
- Đăng ký hộ kinh doanh trước khi thu tiền.
- Thẻ quốc tế qua merchant of record (Creem, Polar, Paddle) sau v1.

**Phát hành.**
- Chỉ một item trên Chrome Web Store, cũng dùng được cho Cốc Cốc.
- Không có chức năng tải hoặc xuất video, audio, SRT.
- Nộp bản thăm dò sớm (tuần 5–6) để biết có qua duyệt không trước khi làm phần thanh toán.

**Lộ trình** (1 dev toàn thời gian):
1. Tuần 0: chuẩn bị bộ dữ liệu đánh giá.
2. M0 (tuần 1–3): thử nghiệm kỹ thuật và so sánh ASR/LLM, có điểm quyết định làm tiếp hay dừng (go/no-go).
3. M1 alpha (tuần 4–8).
4. M2 beta có thu tiền (tuần 9–12).
5. M3 ra mắt công khai (khoảng tuần 15–18).
6. Sau đó: TikTok (M4); YouTube, trang bất kỳ, Firefox (M5).

**Rủi ro lớn nhất.**
- Douyin đổi giao diện web hoặc chặn hook.
- Chrome Web Store từ chối hoặc gỡ extension.
- Pháp lý: điều khoản nền tảng, bản dịch là tác phẩm phái sinh, Luật Bảo vệ dữ liệu cá nhân 91/2025. Cần gặp luật sư trước khi thu tiền.

**Thuật ngữ dùng trong tài liệu.**
- **TTFS:** thời gian tới khi có sub đầu tiên.
- **FRR:** % video có sub sẵn khi vuốt tới.
- **OTR:** % sub hiện đúng lúc, sai lệch tối đa ±1 khung hình.
- **Δin:** độ lệch giữa lúc sub hiện và lúc bắt đầu nói.
- **CQR:** % sub đồng thời đúng giờ, đúng luật trình bày và không có lỗi dịch nặng.
- **W0:** đoạn âm thanh đầu tiên được xử lý.
- **T0–T4:** các tầng lấy dữ liệu, từ đọc JSON (T0) tới nghe âm thanh tab (T4).
- **A0–A3:** các cách tải âm thanh.
- **L1 / L2:** cache trên máy người dùng / cache chung ở server.
- **w:** số giây xử lý trên mỗi giây tính phí (đo lãng phí do tải trước).
- **α:** trần của w.
- **(giả định):** con số của nhóm, phải đo lại.
- **(cần kiểm chứng):** nguồn thứ cấp hoặc chưa đo.

## 1. Mục tiêu & phi mục tiêu

**Lời hứa.** Lướt feed Douyin trên Chrome/Cốc Cốc, video có lời hiện phụ đề tiếng Việt đúng lúc người nói bắt đầu nói, chia câu và tốc độ đọc như sub chuyên nghiệp; video kế tiếp thường đã có sub trước khi vuốt tới.

**Luận điểm kỹ thuật.** Công cụ hiện có nghe xong câu mới dịch nên chữ luôn trễ. Ta lấy media **trước playhead** từ JSON feed mà trang Douyin đã tải, chạy ASR → chia câu → dịch, rồi render cue theo `mediaTime`.

| # | Mục tiêu | Ngưỡng ra mắt |
|---|---|---|
| G1 | Đúng nhịp | Video đã chuẩn bị (prefetch/cache): ≥ 99% cue đúng in-time ±1 khung. Video đầu phiên hoặc sau khi lướt quá nhanh: 2–5 s lời đầu có thể chưa có sub (TTFS lạnh p50 ≤ 2,5 s, p95 ≤ 5 s); câu đang nói chỉ hiện muộn khi còn ≥ 0,6 s thời gian thực và bị tính vào OTR. Không bao giờ hiện chữ của câu đã nói xong |
| G2 | Hợp feed | ≥ 90% video có lời đã có sub khi vuốt tới, nếu người dùng dừng trung bình ≥ 3 s/video |
| G3 | Như người làm | CQR (§2) đạt ngưỡng chốt sau baseline M0 (gợi ý ≥ 70%) |
| G4 | Bán được | Hạn mức đo và khóa giữ ở server; stack được chọn có biên gộp điển hình ≥ 40%, xấu nhất thật ≥ 20% ở mọi gói (§10) |
| G5 | Ship được | **Một** item Chrome Web Store (CWS) phủ Chrome và Cốc Cốc ([Cốc Cốc](https://coccoc.com/en/desktop/features) đưa người dùng sang CWS; cần kiểm chứng) |
| G6 | Bền, mở rộng | Douyin đổi thì xuống cấp có kiểm soát; đổi provider không cần phát hành lại; thêm nền tảng/ngôn ngữ bằng adapter |

**Ưu tiên khi xung đột:** không làm hỏng việc phát video > không vi phạm chính sách store > không lỗ chi phí biến đổi > đúng nhịp > chất lượng dịch > mở rộng.

**Phạm vi v1:** douyin.com desktop (feed đề xuất, 精选, `?modal_id=`, `/video/{id}`), clip ≤ 5 phút, Phổ thông/Quảng Đông → Việt, pass VietQR, dải che hard-sub thủ công; bỏ qua bài ảnh, livestream, video không phải tiếng Trung. **Sau v1:** Edge (M3), TikTok (M4), YouTube, trang bất kỳ, Firefox (M5), song ngữ, tự gia hạn, thẻ quốc tế. **Không làm:** tải/lưu/xuất video, audio, SRT (không dùng chữ "download"); server tự tải media, tự ký API Douyin, đọc/giả cookie, vượt anti-bot; item CWS thứ hai cùng chức năng; tự động lướt, thu thập hàng loạt; BYO key; lồng tiếng; tabCapture làm đường chính.

## 2. Trải nghiệm người dùng & chỉ số

**Hành trình:** cài từ CWS, đăng nhập → màn hình công bố + đồng ý trước lần upload đầu ("Âm thanh của video bạn đang xem được gửi tới máy chủ để tạo phụ đề và bị xóa ngay sau khi xử lý" — [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)) → dùng thử 60 phút (Q10) → nút "VI" + HUD `Sẵn sàng` · `Đang chuẩn bị` · `Không có lời thoại` · `Không phải tiếng Trung` · `Mạng chậm` · `Chế độ dự phòng` · `Hết hạn mức` → "Báo câu sai" gắn `cue_id` → hết phút thì mua pass VietQR.

**Chỉ số** (giả định; chốt sau baseline M0)

| Chỉ số | Định nghĩa | M1 | Ra mắt |
|---|---|---|---|
| TTFS lạnh | cue đầu sẵn sàng − lúc phát (đầu phiên, cache miss) | p50 ≤ 3 s, p95 ≤ 6 s | p50 ≤ 2,5 s, p95 ≤ 5 s |
| TTFS đã tải trước / L1 | audio W0 / cue đã ở máy | p50 ≤ 2 s / ≤ 0,3 s | ≤ 1,8 s / ≤ 0,3 s |
| FRR | % item có lời mà lúc active đã có coverage `final` phủ [0, min(W0_mục_tiêu − 2 s, T)] hoặc đã kết luận `no_speech`/`unsupported_lang` | ≥ 85% (D̄ ≥ 3 s) | ≥ 90% |
| Lead L(t) | cuối vùng `final` liền mạch − `mediaTime` | ≥ max(8 s, p95 xử lý cửa sổ kế) ở ≥ 95% thời gian | như M1 |
| OTR | % cue hiện tại in-time ±1 khung | ≥ 98% đã chuẩn bị, ≥ 90% chung | ≥ 99%, ≥ 93% |
| Δin | start − onset lời, trên nhãn ±40 ms **và** player thật | trung vị ≤ 80 ms, P90 ≤ 200 ms | ≥ 80% trong ±83 ms |
| Luật cứng | ≤ 2 dòng, ≤ 42 ký tự/dòng, ≤ 20 cps, 0,833–7 s, không chồng, không gap sai luật | 100% | 100% |
| Đọc / ASR / dịch | % cue ≤ 17 cps (ngoài CQR) / ảo giác / % cue không lỗi MQM major | ≥ 85% / ≤ 2% / ≥ 85% | ≥ 90% / ≤ 1% / ≥ 90% |
| **CQR** | % cue đồng thời \|Δin\| ≤ 100 ms (3 khung @30 fps), qua luật cứng, không lỗi major | ≥ 60% | ≥ 70% |
| w | giây xử lý server / giây tính phí | p50 ≤ 1,5; p95 ≤ α = 1,6 | như M1 |

CQR không đặt cao hơn tích các chỉ tiêu con (muốn ≥ 85% thì Δin ≥ 92% trong ±100 ms và dịch ≥ 95%). Sàn Δin: aligner tốt nhất lệch trung bình 42,9 ms ([Qwen3-ForcedAligner](https://huggingface.co/Qwen/Qwen3-ForcedAligner-0.6B)); render chậm tới một v-sync ([MDN rVFC](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)).

## 3. Vì sao khác các giải pháp hiện có

| Giải pháp | Điểm nghẽn | Ta gỡ |
|---|---|---|
| Caption real-time từ audio tab (Tablingo, SonicCaption, Tencent RTC, Live Translate, kami-subs…) | Nghe hết câu mới dịch nên luôn trễ (chủ dự án đã thử); tabCapture chỉ có audio tại playhead ([tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture), [SonicCaption](https://aisotools.com/pricing/soniccaption)) | Media trước playhead; tabCapture chỉ là dự phòng có nhãn "trễ" |
| Chrome Live Caption + Live Translate (miễn phí) | Dịch caption 100+ ngôn ngữ ([help](https://support.google.com/chrome/answer/10538231)) nhưng cũng trễ theo tiếng; tiếng Trung desktop cần kiểm chứng | Demo đặt cạnh nhau |
| Immersive Translate | Trang Douyin chỉ dịch text, bình luận ([trang](https://immersivetranslate.com/zh-Hans/webpage/douyin-website-translator/)); AI subtitle còn beta ([App Store](https://apps.apple.com/app/immersive-translate/id6447957425)) | ASR mọi video trong feed |
| BibiGPT | Từng URL, xuất SRT, nạp tay, không có tiếng Việt ([pricing](https://bibigpt.co/pricing), cần kiểm chứng) | Tự động theo feed |
| Subtide ([repo](https://github.com/rennerdo30/subtide)) | yt-dlp ở server, loại douyin; tự host; chia lại bản dịch theo dấu cách nên hỏng zh/vi | JSON trong trang, ánh xạ cue bằng `id`; giữ ≤ 2 job song song, guard prompt-injection |
| Whisper local, VideoLingo ([repo](https://github.com/Huanshere/VideoLingo)), pyVideoTrans | Cần GPU; Whisper-large-v3 WenetSpeech-meeting 19,11 so với 5,88 của Qwen3-ASR-1.7B ([Qwen3-ASR](https://github.com/QwenLM/Qwen3-ASR)); offline, nhiều lượt LLM, không kiểm cps | Server + bake-off; một lượt dịch có cấu trúc mỗi cửa sổ |
| Doubao 同声传译, TikTok tự dịch, Trancy | Doubao trễ ~2–3 s, không tiếng Việt ([Zhihu](https://www.zhihu.com/tardis/jm/art/1990447000831944143)); TikTok 2022 chưa có tiếng Việt ([newsroom](https://newsroom.tiktok.com/auto-translations-and-captions?lang=en)); Trancy chỉ YouTube ([manual](https://manual.trancy.org/en/billing-and-plans/premium)) (cần kiểm chứng) | Douyin trước, đích tiếng Việt; TikTok dùng caption gốc |

Không ai định nghĩa rồi đo "giống sub người làm"; ta biến nó thành chỉ số (§2), luật (§7.1), bộ đánh giá (§7.7). Chưa thấy sản phẩm nào cùng lúc chạy trong feed, đi trước playhead, zh→vi, khóa do nhà cung cấp quản lý, thanh toán VND (cần kiểm chứng). Đe dọa: Immersive Translate làm Douyin, ByteDance tự dịch. Khó sao chép nhất: adapter Douyin bền + engine timing.

## 4. Kiến trúc tổng thể

**4.1 Nguyên tắc:** lõi là thư viện TypeScript thuần (pipeline, timing, quota), bên ngoài đi qua adapter có contract test; client lo thu thập media, server lo khóa, quota, provider; không remote code — adapter nằm trong package, server chỉ gửi dữ liệu và cờ ([CWS policies](https://developer.chrome.com/docs/webstore/program-policies/policies)); lời gọi provider đi qua egress có vị trí xác định (§4.8).

**4.2 Thành phần**
- `tap.main.js` (`world:"MAIN"`, `document_start` — [manifest](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)): bọc fetch/XHR chỉ đọc; chỉ clone khi host `www.douyin.com`, path thuộc danh sách §5.1 (loại `/aweme/v1/play/`), content-type JSON; clone không đọc thì `body.cancel()`; XHR chỉ đọc khi `responseType` là `''`/`'text'`/`'json'`; đọc thêm JSON SSR; không eval, không gọi mạng trừ A2 ([content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)). **Tự tắt = cờ pass-through**, không bao giờ gán lại `window.fetch`/`XMLHttpRequest.prototype.*`: SDK bảo mật Douyin có thể đã bọc lên trên ta, gán lại sẽ mất bước ký request.
- `content.js` (ISOLATED): adapter, lọc loại item, tracker item active, đường tải A0, overlay (closed shadow root, rVFC), HUD.
- `sw.js`: chỉ định tuyến, không giữ trạng thái (bị tắt sau 30 s rảnh; mở Port không giữ SW sống, chỉ message mới gia hạn — [lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)): JWT, cờ từ xa, `ensureDnrRules()` khi bật A1.
- `offscreen.html` + worker (`WORKERS`, `BLOBS` — [offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen)): scheduler, hàng đợi (IndexedDB), bộ đệm tải trước ~10 MB, remux, Opus, VAD, upload, đọc NDJSON, L1 (WebCodecs không có trong SW — [WebCodecs](https://w3c.github.io/webcodecs/)).
- **Backend MVP:** một API Worker (Smart Placement): auth, quota/ledger trên D1 ([D1](https://developers.cloudflare.com/d1/platform/limits/)), `POST /v1/windows` chạy pipeline và stream cue trong response; không giữ trạng thái (client gửi kèm cue trước, bản đồ xưng hô). **Media worker Singapore** (container CPU: Fly.io `sin` [regions](https://docs.fly.io/reference/regions), Render [regions](https://render.com/docs/regions) hoặc Cloud Run): egress cố định, SenseVoice (LID + BGM), chuyển mã; aligner GPU chỉ khi cần. **Provider gate** (DO, trước M3). **R2** cho audio tạm khi provider đòi URL ([R2](https://developers.cloudflare.com/r2/pricing/)). **Khi Q1 cho phép:** L2, Job DO, single-flight, Queues ([Queues](https://developers.cloudflare.com/queues/platform/limits/)).

**4.3 Sơ đồ**

```
 Trình duyệt (Chrome / Cốc Cốc) · tab www.douyin.com
┌──────────────────────────────────────────────────────────────────────────────┐
│ [MAIN] tap.main.js @document_start · chỉ đọc · có chế độ pass-through        │
│   JSON feed/detail (T0) · JSON SSR (T0-SSR) · dự phòng T1/T2 · T3 (cờ)       │
│       │ CustomEvent: chuỗi JSON + nonce (chỉ metadata)                       │
│ [ISOLATED] content.js                                                        │
│   Adapter · lọc loại item · ActiveItemTracker · Overlay (rVFC + offset)      │
│   A0: fetch Range với origin trang ─────────────► CDN Douyin (douyinvod…)    │
└──────┬─────────────────────────────────────────────────────────▲─────────────┘
       │ byte cửa sổ, việc cần làm                               │ cue
┌──────▼─────────────────────────────────────────────────────────┴─────────────┐
│ [SW] chỉ định tuyến, không giữ trạng thái: JWT · cờ từ xa · ensureDnrRules   │
└──────┬─────────────────────────────────────────────────────────▲─────────────┘
┌──────▼─────────────────────────────────────────────────────────┴─────────────┐
│ [Offscreen + Worker] scheduler & hàng đợi (IndexedDB) · tải trước cục bộ     │
│   remux AAC→M4A (Opus khi uplink chậm) · VAD (M2) · L1 · đọc NDJSON          │
└──────┬─────────────────────────────────────────────────────────▲─────────────┘
       │ POST /v1/windows (audio + ngữ cảnh, JWT)                │ NDJSON: coverage, cues
┌──────▼─────────────────────────────────────────────────────────┴─────────────┐
│ API Worker (Smart Placement) · auth · entitlement · quota/ledger (D1)        │
│   ASR → (Aligner) → LID/BGM → lọc → chia câu + timing → dịch (structured,    │
│   stream) → validator → condense · provider gate (DO, trước M3)              │
│   ngân sách chi tiêu · telemetry · cờ từ xa · webhook payOS/SePay            │
│   [sau, nếu Q1] L2 cache R2 · Job DO · single-flight · Queues                │
├──────────────────────────────────────────────────────────────────────────────┤
│ Media worker SG (container CPU): egress cố định · SenseVoice (LID + BGM)     │
│   chuyển mã khi provider không nhận M4A · aligner GPU (chỉ khi cần)          │
└──────────────┬─────────────────────────────────────┬─────────────────────────┘
               ▼                                     ▼
   ASR {Alibaba SG, Soniox, ElevenLabs (mốc)}   LLM {Haiku 5.5, Gemini Flash-Lite, …}
```

**4.4 Luồng một video:** trang gọi feed (~20 item/lần — [mitm log](https://github.com/hanzheng1954/douyin-abogus-analysis)) → tap gửi `MediaDescriptor[]` qua CustomEvent (chuỗi JSON + nonce, bên nhận validate) → lọc, scheduler chọn active/N1/N1–N3 (§6.4) → L1 trúng thì render → A0 tải Range W0, byte sang offscreen bằng base64 hoặc iframe WAR (runtime messaging chỉ nhận JSON — [messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)) → remux M4A, `POST /v1/windows` → server: giữ chỗ quota → ASR → (aligner) → LID/BGM → lọc → chia câu + timing → dịch stream → validator → condense → NDJSON về tab, lưu L1 → overlay theo rVFC + `offset_player`; heartbeat phút sub mỗi 30 s.

**4.5 Interface:** `PlatformAdapter` (`extract` theo hình dạng JSON, `classify` loại item, `activeItem`, `tiers` bật bằng cờ), `AsrProvider` (khai `accepts` định dạng), `Aligner`, `Translator` (stream + `condense`), `LanguagePack` (MVP: hằng số vi/zh); `NormalizedAsr` = {lang, lang_conf, segments[{start, end, text, words[]}]}.

**4.6 Hợp đồng dữ liệu:** *MediaDescriptor* `{item_id, kind ∈ video|image|ad|live, duration_ms, fps, enc, audio[{audio_only|muxed, gear_uri, vcodec, size, urls, pkt_offsets}], music{is_original}, meta{desc, hashtags, ocr_hint}, source}`; *Cue* `tod.cue/1` `{id, start_ms, end_ms, src, tgt, lines[1..2], spk, rev, flags ⊂ {condensed, low_conf, music, chained, provisional_end}, conf}`; *CueTrack* `{key (platform, video_id, src, tgt, pipeline), status ∈ partial|complete|no_speech|unsupported_lang|unsupported_media|failed, coverage[{from_ms, to_ms, final|pending}], cues, hints, provenance}`. **Bất biến:** thời gian là ms trên **timeline nguồn** (mẫu AAC đầu của gear, chưa áp edit list), offset player chỉ cộng lúc render; cue không chồng, 833–7000 ms; khoảng hở đúng 2 khung (`chained`) hoặc ≥ 500 ms; vùng `final` không cue là im lặng thật; client chỉ nhận bản sửa khi `start_ms > mediaTime + 500 ms`, riêng `provisional_end` chỉ sửa `end_ms` tới khi `mediaTime ≥ end_ms − 300 ms`; server giữ schema N-1 trong 90 ngày (giả định).

**4.7 API** (`fetch()` + `Authorization: Bearer <JWT ~15 phút>`; không EventSource vì không gửi được header — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/EventSource/EventSource); không đặt token trên URL)
- `POST /v1/windows`: multipart `meta` (video_id, duration_ms, fps, tgt, cửa sổ {seq, src_from_ms, dur_ms, priming_samples, final}, ngữ cảnh {desc, hashtags, ocr_hint, ≤ 5 cue trước, register}) + `audio` (`audio/mp4`/`audio/ogg`), `Idempotency-Key: <item>:<seq>`; trả NDJSON `coverage`, `cues` (upsert id/rev), `status`, `quota`, `error{code, retryable, retry_after_ms}`. Đứt luồng thì gửi lại cùng key; ledger khóa theo key nên không trừ hai lần.
- `POST /v1/usage:heartbeat`, `GET /v1/me`, `GET /v1/config` (cờ, `min_ext_version`, `pipeline_major`), `POST /v1/feedback`, `POST /v1/billing/checkout`, `/v1/billing/webhook/{provider}` (xác minh chữ ký).
- Khi có L2: `POST /v1/jobs:ensure` (lookup + job), `GET /v1/events?device_id=` (luồng ghép kênh, `Last-Event-ID`, phát lại 120 s).
- Lỗi: `402 quota_exceeded`, `429 {retry_after_ms}`, `503 degraded`, `audio_invalid`, `duration_mismatch`, `unsupported_lang`.

**4.8 Stack & egress (quyết cuối M0).** Workers Paid + D1: body tới 100 MB, CPU tới 5 phút, không giới hạn wall-clock khi client còn kết nối ([Workers](https://developers.cloudflare.com/workers/platform/limits/)). **Egress:** từ VN, Worker có thể chạy ở colo Hồng Kông, nơi Gemini API trả 400 "User location is not supported" (báo cáo 12/10/2026 — [forum](https://discuss.ai.google.dev/t/gemini-api-location-error-400-when-called-from-cloudflare-workers/188368), [community](https://community.cloudflare.com/t/711754)); GroqCloud cũng loại TQ/HK. Quy tắc: Smart Placement, log colo; colo HK/TQ hoặc lỗi chặn vùng → proxy cố định ở media worker Singapore, không thử lại cùng đường; DO dùng locationHint gần Singapore (`apac`/`apac-se` — [data location](https://developers.cloudflare.com/durable-objects/reference/data-location/), cần kiểm chứng); Gemini cân nhắc Vertex AI asia-southeast1. **Giữ Workers nếu:** p95 overhead từ VN ≤ 150 ms; 48 giờ từ Viettel, VNPT, FPT ở 2 thành phố: 100% lời gọi provider thành công; stream ổn định ≥ 60 s; `Intl.Segmenter`, OpenCC JS chạy được (cần kiểm chứng). Trượt thì chuyển pipeline sang media worker (Node), 1–2 tuần (giả định).

## 5. Thu thập media (Douyin trước) và dự phòng

`video.currentSrc` là `blob:` (Douyin phát qua MSE), nên media phải lấy từ JSON.

**5.1 Đã biết về Douyin**
- **Endpoint trang tự gọi** (danh sách clone): `/aweme/v1/web/tab/feed/`, `/aweme/v2/web/module/feed/` (精选, POST, count=20), `/aweme/v1/web/module/feed/`, `…/aweme/related/`, `…/aweme/detail/`, `…/aweme/post/`, `…/general/search/single/`, `…/search/item/`, `/mix/aweme/`, `/follow/feed/`, `/familiar/feed/` ([WhiteSevs](https://raw.githubusercontent.com/WhiteSevs/TamperMonkeyScript/master/scripts-vite/%E6%8A%96%E9%9F%B3%E4%BC%98%E5%8C%96/src/main/video/filter/DouYinVideoFilter.ts), [OpenBiliClaw](https://github.com/whiteguo233/OpenBiliClaw)). Server không gọi lại: có chữ ký (a_bogus, msToken, x-secsdk) + cookie khách, gọi từ server bị `403 Uifid Not Found` 5/8 lần ngày 2026-09-08 ([TikTokDownloader](https://github.com/JoeanAmier/TikTokDownloader)).
- **Media:** `video.play_addr.url_list`, `video.bit_rate[]` (`format` mp4|dash, `data_size`, `FPS`), `bit_rate_audio[]` (thường null), `bitRateList[].pktOffsetMap` trong player state ([douyin-dl-user-js](https://github.com/zhzLuke96/douyin-dl-user-js)). Không có caption có timing (chỉ `is_subtitled`, `seo_info.ocr_content`) nên bắt buộc ASR. CDN chỉ cần Referer `https://www.douyin.com/` + UA trình duyệt ([dtk](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)); URL hết hạn ~1–3 giờ (cần kiểm chứng).
- **Item active:** `?modal_id=`, `/video/{id}`, `/note/{id}`, nếu không thì `[data-e2e="feed-active-video"][data-e2e-vid]` đang hiển thị ([PromptDirector](https://github.com/wchao6891/PromptDirector)); không dùng `querySelector('video')` vì trang preload nhiều player ([ghi chú](https://github.com/williamxhero/skills)).
- **Lọc loại item:** `images`/`live_photo_type` → `image`, bỏ qua (`play_addr` cấp bài là nhạc nền, theo parser dtk); `is_ads`/`raw_ad_data` → `ad`: không prefetch, chỉ xử lý khi dừng ≥ 3 s, không trừ quota (giả định); thiếu `duration` hoặc có `room` → `live`, bỏ qua; mã hóa (`enca`/`encv`, `senc`/`tenc`) → `unsupported_media`, xuống T3/T4.

**5.2 Thang dự phòng**

| Tầng | Cách lấy | Lead | v1 |
|---|---|---|---|
| T0 | Tap JSON, không sửa request/response; kiểm lại wrapper sau khi `byted_acrawler` nạp | cả clip + ~20 item | Bật |
| T0-SSR | JSON SSR (RENDER_DATA / `self.__pace_f`) trên `/video/{id}`; S1 đo item đầu đến qua XHR hay SSR (cần kiểm chứng) | item mở qua link | Nếu S1 cần |
| T1 | Player state `…pluginsConfig[*].awemeInfo` / `player.config.awemeInfo` | item đang phát | Bật |
| T2 | React fiber `memoizedProps.awemeInfo` | item trong DOM | M2, cờ |
| T3 | Tap MSE kiểu [cat-catch](https://github.com/xifangczy/cat-catch): gọi `appendBuffer` gốc trước rồi `slice` bản sao, không detach; chỉ SourceBuffer `audio/*`; khử trùng lặp theo `tfdt`; binary kênh riêng | phần đã buffer ([xgplayer-mp4](https://raw.githubusercontent.com/bytedance/xgplayer/main/packages/xgplayer-mp4/README.md) `maxBufferLength` 40); mọi video coi là lạnh, KPI riêng | M2, cờ |
| T4 | tabCapture + offscreen `USER_MEDIA`, quyền optional | 0, có trễ | M4 nếu Q5 |

**5.3 Đường tải audio** (đo ngày đầu S2; server không bao giờ tự tải)
- **A0 (mặc định nếu đạt):** fetch Range từ content script ISOLATED: origin `www.douyin.com`, Referer tự nhiên, chịu CORS như player (suy luận, cần kiểm chứng); không cần host permission CDN hay DNR.
- **A2:** fetch từ MAIN bằng tham chiếu fetch gốc lưu lúc document_start (không qua wrapper Douyin), byte qua `MessageChannel` tới iframe WAR.
- **A1 (chỉ khi A0/A2 trượt, sau cờ):** offscreen fetch với host_permissions CDN ([network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)) + DNR `modifyHeaders` (`referer: set`, `origin: remove`, `initiatorDomains:[runtime.id]` — [DNR](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)), mới có bằng chứng diễn đàn ([chromium-extensions](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/eZBVJsSiu-I)); session rule mất khi restart/cập nhật nên `ensureDnrRules()` idempotent chạy lúc SW khởi động và trước mỗi lần tải; sửa Referer là câu hỏi cho luật sư. **A3:** xuống T3.
- **Rào chắn:** chỉ `https`, host thuộc allowlist họ domain media ByteDance, `credentials:'omit'`, không `Authorization`; không gửi cookie người dùng lên server.
- **Quyền:** A0/A2 không cần host CDN. Buộc dùng A1 thì khai họ domain (`*.douyinvod.com`, `*.zjcdn.com`, `*.douyinstatic.com`…, chốt sau S2) ngay lần nộp đầu; domain mới vào `optional_host_permissions`, vì cập nhật thêm quyền có cảnh báo sẽ vô hiệu hóa extension tới khi người dùng đồng ý ([permission warnings](https://developer.chrome.com/docs/extensions/develop/concepts/permission-warnings)).

**5.4 Nguồn audio, remux.** Thứ tự (sửa theo đo S1, §5.6b): `/aweme/v1/play/?video_id=<uri>` (chạy 24/24 ở cả 3 lượt đo, không cần cookie) → CDN trực tiếp chỉ khi host không phải `v3-web-prime.douyinvod.com` (`bit_rate_audio` → gear `mp4` `data_size` nhỏ nhất bất kể codec video, miễn audio `mp4a` → `play_addr`); `music.play_url` chỉ khi `is_original` và thời lượng ≈ video. Range W0 trước (`pktOffsetMap`, không thì moov + byte đầu; faststart cần kiểm chứng). Remux AAC → M4A không re-encode bằng mediabunny (MPL-2.0 — [README](https://github.com/Vanilagy/mediabunny/blob/main/README.md)) hoặc mp4box.js (BSD-3 — [README](https://github.com/gpac/mp4box.js/blob/main/README.md)), bỏ `elst`, gửi `priming_samples`; 64–128 kbps → 240–480 KB/30 s. Uplink < 2 Mbps hoặc provider không nhận M4A: `AudioDecoder` (probe `mp4a.40.2`, dự phòng `decodeAudioData`) → Opus 24 kbps mono (~90 KB/30 s). Không dùng ffmpeg.wasm (~32 MB, GPL, 0,04–0,08× native — [benchmark](https://github.com/ffmpegwasm/ffmpeg.wasm/blob/main/apps/website/docs/performance.md)). URL 403 thì lấy URL mới từ T1.

**5.5 Chịu được thay đổi:** nhận dạng theo hình dạng JSON (`aweme_id|awemeId` + `video.play_addr|bit_rate|bitRateList`) trong phạm vi endpoint đã lọc; model chung camelCase/snake_case, parser khoan dung; T0 + T1 song song đối chiếu `data-e2e-vid`; fixture JSON trong CI; telemetry theo tầng (không URL/ID); cờ bật T3, giảm prefetch, kill-switch; không giả chữ ký, không giấu hook.

**5.6 S2 đo:** tỉ lệ tải A0/A2/A1 trên 100 video × 2 ngày, mạng VN, Chrome và Cốc Cốc; CORS; mọi host thật (kể cả redirect của `/aweme/v1/play/`); Referer có bắt buộc; hạn URL; tần suất `bit_rate_audio`; cỡ gear nhỏ nhất; faststart; tỉ lệ mã hóa; phân bố thời lượng.

**5.6b Kết quả S1 (30/10/2026, Chrome 154 Windows, đã đăng nhập; số liệu thô trong `spike/s1/results/`).** Mẫu nhỏ (29 phút, 100 video đã phát, 86 video tải thử), cần đo lại trên Cốc Cốc và mạng khác.

| Lượt | Khu vực | Có dữ liệu trước khi phát | Đi trước (trung vị) | Thời lượng trung vị | CDN trực tiếp | `/aweme/v1/play/` |
|---|---|---|---|---|---|---|
| A, hook bật | 精选 / modal (`/aweme/v2/web/module/feed/`) | 13/13 | 19,8 s | 208 s | 100% (host `zjcdn.com`) | 8/8 |
| B, hook tắt | 推荐 | 7/53 (chỉ T1) | 0,1 s | 14,5 s | 0% (403, `v3-web-prime`) | 8/8 |
| C, hook bật | 推荐 (`/aweme/v1/web/tab/feed/`) | 34/34 | 53,1 s | 14 s | 0% (403, `v3-web-prime`) | 8/8 |

- **T0 bắt buộc, đạt ngưỡng M0:** có hook thì 47/47 video có dữ liệu trước khi phát (cả hai feed đều qua XHR, không qua `fetch`); không hook thì T1 chỉ có lúc bắt đầu phát, không dùng cho lookahead.
- **Đường tải chính:** `/aweme/v1/play/?video_id=<uri>` từ content script (A0), Range, không cookie: 24/24, chuyển hướng sang `douyinvod.com`/`zjcdn.com`; 103/103 lượt tải thành công là file faststart, 97/103 có track `mp4a` (6 lượt thiếu ở lượt A, chưa rõ nguồn nào); 256 KB mất trung vị ≈ 0,7 s (có chuyển hướng) so với ≈ 0,16 s khi CDN trực tiếp chạy. Không cần host permission CDN hay DNR (A1).
- **Link CDN trực tiếp không ổn định:** chạy ở feed 精选 (`zjcdn.com`) nhưng 403 ở feed 推荐 (`v3-web-prime.douyinvod.com`) với cả A0 và A2; chưa biết có phải do không gửi cookie (spike v0.2 có phép thử lại kèm cookie).
- **Hook bị trang bọc lên trên** ở 542/542 lần kiểm (SDK của Douyin bọc `fetch`/`XMLHttpRequest.open` sau ta) nhưng vẫn bắt được dữ liệu; giữ quy tắc không gán lại (§4.2).
- **Captcha:** 0 lần ở cả ba lượt (hook bật 18 phút, tắt 11 phút).
- **Thời lượng phụ thuộc feed:** 推荐 đa số ≤ 60 s (74–87%), 精选 trung vị 208 s và 31% > 5 phút; cửa sổ cho video dài (§6.2) cần có ngay trong MVP nếu hỗ trợ 精选.
- **Link sống lâu hơn dự tính:** khoảng 3–4 giờ, có loại 24 giờ.

**5.7 Nền tảng sau.** **TikTok (M4):** bắt `/api/recommend/item_list/`, `/api/item/detail/`… và `__UNIVERSAL_DATA_FOR_REHYDRATION__`; caption có timing `subtitleInfos`/`claInfo.captionInfos` thì bỏ ASR; không có thì tải trong trình duyệt bằng cookie trang (cần `tt_chain_token` — [yt-dlp](https://github.com/yt-dlp/yt-dlp), [#10346](https://github.com/yt-dlp/yt-dlp/issues/10346)). **YouTube (M5):** `captionTracks` trước; audio server gãy vì PO token, SABR ([PO Token Guide](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide)); không ASR audio YouTube ở v1 (CWS nêu đích danh "facilitating download of YouTube videos"). **Trang bất kỳ (M5):** quyền theo site, `registerContentScripts` ([scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)), HLS/DASH hoặc T3/T4, không hứa "không trễ".

## 6. Pipeline xử lý & ngân sách độ trễ

**6.1 Các bước:** L1 (khi có L2, lookup chạy song song với tải) → cửa sổ W0 → ASR → timestamp native hoặc aligner → LID/BGM, lọc ảo giác, chia câu, timing (tất định; `cut_ms` = cuối câu hoàn chỉnh cuối trong W0, `next.in` lấy ngay trong output W0, cần `W0_end − cut_ms ≥ 1,0 s`) → dịch structured, stream từng cue, validator, condense → NDJSON: coverage `final` = [0, cut_ms]; cửa sổ kế bắt đầu từ `cut_ms − 0,3 s`.

**6.2 Luật cửa sổ** (dùng chung cho API và chống lạm dụng; giả định)

| Luật | Giá trị |
|---|---|
| W0 item active chưa chuẩn bị | 6–8 s, tới hết câu hoàn chỉnh đầu |
| W0 prefetch N1 | `clamp(2 × trung vị thời gian dừng 10 video gần nhất + 4 s, 6, 15 s)`; kéo dài từng 3 s (≤ 20 s) tới khi `cut_ms ≥ min(W0_mục_tiêu − 2 s, T)` |
| Cửa sổ kế | 20–30 s, cắt ở khoảng lặng; chỉ gửi khi đã dừng ≥ 3 s và L < 20 s; ≤ min(giới hạn sync của provider, 60 s) |
| Tối thiểu | 10 s, trừ W0, cửa sổ cuối, clip < 10 s (gửi cả clip); Groq tính tối thiểu 10 s/request |
| Có VAD (M2) | ghép đoạn có lời vào một file + `speech_map [{src_from_ms, src_to_ms, file_offset_ms}]` |
| Kiểm tổng | hợp các khoảng đã phủ ≤ `duration_ms` + 1 s |
| Video dài (sau v1) | 30–60 s, L ≥ 30 s, 2–3 cửa sổ song song, seek hủy ngoài [t − 5 s, t + 90 s] |

**6.3 Ngân sách TTFS lạnh** (đầu phiên, W0 = 8 s; gear b_src = 0,6 Mbps; xuống 20 / lên 5 Mbps; AAC 128 kbps; RTT VN→SG 40 ms; giả định)

| # | Bước | Công thức | p50 |
|---|---|---|---|
| 0 | Phát hiện item (MAIN) | JSON có trước khi phát | 0 |
| 1 | SW + offscreen + worker + JWT | 0 nếu đã làm ấm | 0 (0,35 s nếu chưa) |
| 2 | Tra L1 | IndexedDB | 0,01 s |
| 3 | Tải W0 (A0) | 0,15 + 8·0,6/20 | 0,39 s |
| 3b | Range lấy moov | chỉ khi không faststart | 0 (0,19 s) |
| 4 | Remux | không re-encode | ≤ 0,10 s |
| 5 | Upload (gộp tạo cửa sổ) | 8·0,128/5 + RTT/2 | 0,22 s |
| 6 | ASR | W0/RTFx + overhead; Groq turbo 216x ([Groq](https://console.groq.com/docs/speech-to-text)), Soniox 41x + poll ([AA](https://artificialanalysis.ai/speech-to-text)), Alibaba chưa công bố | 0,60 s |
| 7 | Aligner (nếu ASR không có timestamp) | chưa có RTF công bố | 0,20 s |
| 8 | LID/BGM (song song) + lọc + chia câu + timing | tất định | 0,02 s |
| 9 | Dịch cue đầu | TTFT + 30 token/150 tok/s | 0,70 s |
| 10 | Stream → render | RTT/2 + 1 khung | 0,05 s |
| | **Tổng** | tuần tự | **≈ 2,3 s** (2,1 s không aligner; 2,8 s nếu chưa ấm, không faststart) |

Item đã tải trước: bỏ bước 3–4, ≈ 1,8 s. Item N1: cue có sẵn (W0 12 s mất ≈ 2,9 s kể cả tải, kịp nếu dừng ≥ ~3 s). Mạng 5/1 Mbps: tải 1,1 s, upload AAC 1,0 s (Opus 0,2 s). Bước 5–9 là đường găng nên chọn provider theo p95 đo thật.

**6.4 Prefetch hai tầng**

| Tầng | Item | Việc | Tốn API |
|---|---|---|---|
| Server | Active | W0 nếu chưa có; phần còn lại theo §6.2 | Có |
| Server | N1 | W0_mục_tiêu; nguyên clip nếu T ≤ 60 s và EWMA xem hết ≥ 0,6 | Có |
| Cục bộ | N1–N3, `d = clamp(⌈P_W0/D̄⌉, 1, 3)` | Range W0 + remux, giữ ở offscreen | Không |
| Cache | N4–N10 | lookup L2 (khi có) | — |

- c = 2 cửa sổ đang tải/upload mỗi người (đếm theo cửa sổ); vuốt qua thì hủy cửa sổ chưa vào bước dịch; giữ [N, N+d], không giữ N−1; không prefetch bài ảnh, livestream, quảng cáo; dùng thử không xử lý server N1.
- **Mô phỏng** (clip 8–90 s, 15% không lời): w ≈ 1,48 / 1,39 / 1,23 cho hồ sơ lướt nhanh / pha trộn / xem lâu (tối thiểu 10 s/video); bỏ cổng "dừng ≥ 3 s" hoặc chỉ tính tối thiểu 5 s thì lướt nhanh lên ≈ 1,73–1,76 (giả định).
- **Hạ cấp** (gần hết hạn mức, chạm bất biến ngắn hạn §9.2, ngân sách chi tiêu, mạng yếu): tắt nguyên clip N1 → tắt W0 N1 → giảm d; không động tới item active.

**6.5 Video đầu, làm ấm, mạng chậm.** Mở tab douyin.com thì tạo sẵn offscreen + worker, làm mới JWT, preconnect API; tải item 0 ngay khi JSON về. Video đầu là Q5: (a) thiếu 2–5 s đầu (mặc định); (b) "Giữ nhịp" dừng ≤ 3 s, chỉ khi spike M0 an toàn; (c) "Phát lại từ đầu" nếu mới phát < 5 s; clip tự lặp nên từ vòng 2 đủ sub (cần kiểm chứng). Player `waiting`/`stalled` hoặc thông lượng < 3 Mbps → dừng tải trước N2/N3, fetch prefetch `priority:'low'`; uplink < 2 Mbps → Opus.

**6.6 Lỗi & điều phối provider.** ASR lỗi/chậm quá 2× → provider thứ hai một lần (beta bật bằng cờ, từ M3 chạy thật); JSON dịch hỏng → thử lại rồi model dự phòng; lỗi chặn vùng → proxy Singapore; không bao giờ hiện cue sai giờ. **Bộ điều phối toàn cục (trước M3):** mỗi provider/model một DO token bucket theo QPS/RPM/TPM; lớp P0 (W0 active) > P1 (phần còn lại active) > P2 (N1) > P3; tới 80% hạn mức thì 429 cho P3 rồi P2; P0 không chờ sau P2/P3. Beta (≤ ~30 người đồng thời, giả định) chỉ đếm 429 và hạ cấp.

**6.6b Kết quả S3 đợt 1 (30/10/2026; 39 mẫu tab 推荐, chỉ Gemini; số liệu trong `spike/s3/results/`).**
- **Chỉ 10/39 video (26%) có lời nói**, còn lại là nhạc, nhảy, hát nhép, cover. Giả định s = 0,6 ở §10 đang cao: chi phí trên mỗi phút xem thấp hơn, nhưng cần nhận ra "không có lời" (LID/BGM, VAD) trước khi gọi ASR trả phí. Mẫu có lời còn ít, cần thu thêm.
- **Gemini 3.5 Flash-Lite (ASR):** 39/39 không lỗi; độ trễ p50 2,5 s, p95 5,4 s cho đoạn ≤ 30 s (≈ 6× thời gian thực), quá ngân sách 0,6 s của §6.3 cho video đầu nhưng đủ cho prefetch; không có mốc theo từ, câu dài tới 12–17 s; sai chữ đồng âm và tên riêng (木日/末日, 坤/鲲, 端话/童话), nhất là phim AI có nhạc nền. Chưa có đáp án nên chưa có CER.
- **Dịch (Gemini):** trôi chảy nhưng kéo theo lỗi ASR, hiểu sai thành ngữ (非死不可 → "Bất tử"), sót chữ Hán ("Long Ư央"), thiếu dấu cách sau dấu phẩy, cue quá dài: xác nhận cần validator (§7.5), chia câu tất định theo luật §7.3 trước khi dịch, và so model dịch mạnh hơn.
- **Fun-ASR-Flash (Alibaba Singapore), cùng 39 mẫu:** p50 0,70 s, p95 1,44 s cho đoạn ≤ 30 s (≈ 24× thời gian thực, khớp ngân sách §6.3); mốc theo từ ở 33/33 mẫu; 6 mẫu trả `ASR_RESPONSE_HAVE_NO_WORDS` (không có lời). Trên các video có lời, chép đúng những chỗ Gemini sai (鲲, 末日, 童话世界, 渝中江北, 依依…), nên là ứng viên ASR chính. Nhưng nó chép cả lời bài hát và bịa chữ trên nhạc (lặp "爱是种…", "羊羊羊", "嗯。", lời tiếng Tây Ban Nha/Anh): bắt buộc có bước LID/BGM (SenseVoice, §7.2) và lọc lặp; có dịch lời bài hát hay không là quyết định của chủ dự án. Qwen3-ASR-Flash: tài khoản chưa được cấp quyền (403 `AccessDenied.Unpurchased`).
- **Chia câu + dịch theo từng dòng (bench v2):** dùng mốc theo từ của Fun-ASR, dòng ≤ 7 s / 16 chữ Hán, cắt ở dấu phẩy hoặc chỗ ngắt hơi, mốc ra theo luật Netflix; 13 video thành 99 dòng (trung vị 2,1 s, dài nhất 5,5 s); bản dịch đủ ý, 0 dòng thiếu, 0 dòng sót chữ Hán; nhưng 44/99 dòng vượt 17 ký tự/giây, nên đã thêm lượt rút gọn riêng (§7.5), chưa đo trên dữ liệu thật.
- **Bộ lọc nói/hát bằng đặc trưng văn bản:** 36/38 đúng so với nhãn tạm (gán từ bản chép, chưa nghe); giữ 10/10 video có lời, lọt 2/28 video hát (một cover có nhịp 0,22 s/chữ như lời nói, một bài lẫn tiếng Anh). Không tách được bằng ngưỡng vì một video game có lời thật mang đặc trưng gần như y hệt: cần bộ phân loại âm thanh (SenseVoice hoặc tương đương, §7.2) ở M1; trong lúc chờ, ưu tiên bỏ sót lời nói hơn hiện lời bài hát (§15).
- **Tiếp theo:** chạy Fun-ASR-Flash và Qwen3-ASR-Flash trên cùng mẫu (cần key Alibaba), thu thêm mẫu có lời, sửa đáp án cho các mẫu có lời để có CER.

**6.7 Nhà cung cấp & quy tắc chọn** (bake-off M0 bằng đúng file M4A production, chạy lại M2)
- **Alibaba Intl (SG) `fun-asr-flash-2026-06-15`:** sync ≤ 5 phút, $0,000035/s ≈ $0,0021/phút, 10 h miễn phí ([giá](https://www.alibabacloud.com/help/en/model-studio/model-pricing)); tài liệu ghi timestamp "luôn bật" nhưng ví dụ sync chỉ có text; nhận AAC/WAV/MP3 (M4A chưa nêu), ví dụ nạp URL → presigned R2, +0,1–0,3 s (giả định). `qwen3-asr-flash` + Qwen3-ForcedAligner tự host (zh/yue, không vi — [docs](https://www.alibabacloud.com/help/en/model-studio/qwen-speech-recognition)) cần GPU cố định.
- **Soniox `stt-async-v5`/`stt-rt-v5`:** $0,10/h, rt $0,12/h ([giá](https://soniox.com/pricing)); token timestamp luôn có ([docs](https://soniox.com/docs/stt/concepts/timestamps)); nhận m4a; async ≥ 4 lời gọi ([async](https://soniox.com/docs/stt/async/async-transcription)), dùng `audio_url` presigned + webhook để còn 2.
- **ElevenLabs Scribe v2** làm mốc: $0,22/h ([giá](https://elevenlabs.io/pricing/api), [docs](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)).
- **Chỉ thử khi ba ứng viên trên trượt:** Seed-ASR ([Volcengine](https://docs.volcengine.com/docs/6561/1631584), [BytePlus LAS](https://docs.byteplus.com/en/docs/Byteplus_LAS/las_asr); chỉ WAV/MP3/OGG-Opus → nhánh Opus; chưa có giá chính thức), Groq whisper ($0,111/h, turbo $0,04/h; 20 RPM, 28,8K audio-giây/ngày — [limits](https://console.groq.com/docs/rate-limits)), tự host Qwen3-ASR/SenseVoice. Loại `whisper-1`, `gpt-4o-*-transcribe` (ngừng 2027-02-26 — [OpenAI STT](https://developers.openai.com/api/docs/guides/speech-to-text)). Theo bảng vendor, Whisper kém với lời hát (54,82) và phương ngữ (66,14) so với Fun-ASR 21,00 và 15,21 ([Fun-ASR](https://github.com/FunAudioLLM/Fun-ASR)).
- **Chọn ASR:** tổng chi phí (biến đổi + cố định như GPU) thấp nhất trong số đạt: CER ≤ tốt nhất + 1 điểm ở từng tầng; lệch timestamp trung vị ≤ 80 ms, P90 ≤ 150 ms; p95 cửa sổ 15 s ≤ 1,5 s; ảo giác ≤ 1%; QPS được cấp ≥ λ_user (0,25) × người đồng thời cao điểm × 1,5, dự phòng gánh ≥ 50% tải (Groq 20 RPM không đạt); nhận định dạng của client; điều khoản dữ liệu ổn.
- **LLM (bake-off 3–4):** Claude Haiku 5.5 $0,10/$0,50 (prompt ≤ 100K token; bảng giá Anthropic 10/2026), Gemini 2.5 Flash-Lite $0,10/$0,40, 3.1 Flash-Lite $0,25/$1,50 ([Gemini](https://ai.google.dev/gemini-api/docs/pricing)), gpt-6-luna $0,10/$0,50 ([OpenAI](https://developers.openai.com/api/docs/pricing)), qwen3.7-flash $0,03/$0,13 ([Qwen](https://www.alibabacloud.com/help/en/model-studio/machine-translation)); mốc trần Claude Sonnet 5.5 ($2/$10); baseline Google NMT ([Google](https://cloud.google.com/translate/pricing)). **Chọn** rẻ nhất đạt: không lỗi MQM major ≥ mốc trần − 5 điểm; JSON hợp lệ lần đầu ≥ 99,5%; ≤ 15% cue cần condense; TTFT p95 ≤ 1 s; ≤ $0,002/phút lời; hạ được thinking (Haiku 5.5 tắt được ở effort ≤ high).

## 7. Chất lượng sub "như người làm"

**7.1 Chuẩn thành config:** tiếng Việt 42 ký tự/dòng, tối đa 2 dòng (dòng dưới dài hơn), mục tiêu 17 cps, trần 20 (Q4), U+2026, hội thoại "- ", số 1–10 viết chữ, giữ đúng mức tục ([Netflix vi](https://partnerhelp.netflixstudios.com/hc/en-us/articles/220447048-Vietnamese-Timed-Text-Style-Guide)); dòng zh khi song ngữ 16 ký tự, 9 cps ([zh-Hans](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215986007-Chinese-Simplified-Timed-Text-Style-Guide)); cue 833 ms–7 s ([General](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements)); in-time ở khung đầu có lời, out ≈ +0,5 s, gap tối thiểu 2 khung, gap < 0,5 s thì nối liền ([Timing](https://partnerhelp.netflixstudios.com/hc/en-us/articles/360051554394-Timed-Text-Style-Guide-Subtitle-Timing-Guidelines)); fps lấy `bit_rate[].FPS`, mặc định 30.

**7.2 Nguồn văn bản, LID, nhạc, làm sạch**
- Thứ tự nguồn: caption có timing của nền tảng (TikTok) → ASR có timestamp ký tự → chữ trên màn hình (`ocr_content`, sau là OCR) để đối chiếu.
- **Chỉ dịch lời nói (đã chốt 30/10/2026, §15).** Đo S3 cho thấy Fun-ASR chép cả lời bài hát và bịa chữ trên nhạc, nên bước dưới đây là bắt buộc trong MVP, không phải tùy chọn.
- **LID, nhạc:** SenseVoice-Small (zh/yue/en/ja/ko, tag BGM — [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)) chạy song song ASR ở media worker; không phải zh/yue với độ tin ≥ 0,8 → `unsupported_lang`; Fun-ASR/Qwen3 chép lời bài hát khá tốt nên không tự lọc được, đoạn gắn BGM/hát thì không dịch, không tính phút, tùy chọn nhãn [nhạc].
- **Làm sạch:** OpenCC t2s, NFC; ct-punc khi thiếu dấu câu ([ct-punc](https://huggingface.co/funasr/ct-punc)); bỏ đoạn < 50 ms, > 12 ký tự/giây, n-gram ký tự lặp ≥ 4, cụm khớp "bag of hallucinations" tiếng Trung ([BoH](https://arxiv.org/abs/2501.11378), [Calm-Whisper](https://arxiv.org/abs/2505.12969v1)); Whisper thì `condition_on_previous_text=False`, ngưỡng 2,4/0,6/−1,0 ([faster-whisper](https://github.com/SYSTRAN/faster-whisper)); không tách giọng mặc định ([2506.15514](https://arxiv.org/abs/2506.15514), [2201.06685](https://arxiv.org/abs/2201.06685)).
- **VAD (M2):** bỏ đoạn không lời ≥ 2 s, gửi `speech_map`, hít in-time về onset; CSP `extension_pages` = `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`, mọi `.wasm`/`.onnx` trong gói (tự tải từ CDN là remote code), `numThreads = 1`, dự phòng VAD năng lượng thuần JS.

**7.3 Chia câu** (tất định; giả định): ranh giới cứng 。！？；…, lặng ≥ 600 ms, đổi người nói; cue ≤ 7 s (ưu tiên ≤ 5 s) và `3,5 × số_chữ_Hán ≤ min(84, 17 × (thời_lượng + 0,3))`; điểm cắt = `pause_ms/100 + 3·[，、：] + 2·[liên từ 因为 所以 但是 可是 不过 而且 然后 如果 虽然 即使 尽管 结果] − |vị_trí − giữa|/độ_dài`, không cắt giữa từ; gộp cue < 833 ms hoặc < 3 chữ nếu gap < 500 ms. Phương án B (A/B ở M4): LLM gom cụm 3–10 chữ có id thành `{ids, tgt}`.

**7.4 Thời gian**
- **Timeline nguồn + `offset_player`:** Douyin transmux MP4 vào MSE; theo xgplayer-mp4-loader, video chỉ dời theo `elst` khi có ctts và trình duyệt cho phép, audio không dời (giữ priming AAC ≈ 23–48 ms), không có edit list thì pts đầu ép về 0 ([utils.js](https://github.com/bytedance/xgplayer/blob/main/packages/xgplayer-mp4-loader/src/utils.js)). Player production đóng nên S3 đo pts/tfdt lần append đầu (mã T3 chỉ đọc) so với cts/ctts/elst trên ≥ 30 video, Chrome và Cốc Cốc, rồi viết `offset_player = f(elst, ctts, priming, trình duyệt)`; không ghi offset vào cache.
- **In-time** = start ký tự đầu, hít về onset VAD nếu sớm hơn ≤ 150 ms, làm tròn **xuống** biên khung. **Out-time**, `g = next.in − speech_end`: < 500 ms → `next.in − 2 khung`; 500–1000 ms → `next.in − 500 ms`; ≥ 1000 ms → `speech_end + 500 ms`.
- **Biên cửa sổ:** sau `cut_ms` không còn từ thì g = W0_end − speech_end; g < 1,0 s → cờ `provisional_end`; cửa sổ sau không đổi thời gian của từ trước `cut_ms`. Thiếu 833 ms thì mượn thời gian trống (≤ 0,5 s sau lời) hoặc gộp; > 7 s thì tách.

**7.5 Dịch**
- **Rút gọn là chuyện thường:** tỉ lệ cần rút = `max(0, 1 − cps_trần/(r_zh × 3,5))`; tiếng Phổ thông ~5,2 chữ/giây ([nguồn thứ cấp](https://storylearning.com/fastest-spoken-languages), cần kiểm chứng); r_zh = 5/6/8 → 3%/19%/39% ở trần 17 cps, 0%/5%/29% ở trần 20.
- **Hợp đồng** (một lời gọi structured output mỗi cửa sổ, stream):
```json
{"src_lang":"zh-Hans","tgt_lang":"vi","video":{"desc":"…","hashtags":["…"],"ocr_hint":"…"},
 "style":{"max_cpl":42,"max_lines":2,"target_cps":17},"register":[{"pair":"S1->viewers","self":"mình","other":"cả nhà"}],
 "glossary":[{"src":"家人们","tgt":"cả nhà"}],"prev":[{"id":"c0007","src":"…","tgt":"…"}],
 "cues":[{"id":"c0008","spk":"S1","dur":2.4,"max_chars":40,"src":"…"}]}
→ {"cues":[{"id":"c0008","tgt":"…"}],"register":[…],"new_terms":[{"src":"…","tgt":"…"}]}
```
- `max_chars = floor(min(84, 17 × thời_gian_hiển_thị))`; glossary chỉ chèn mục có trong transcript (≤ 15–30); phần tĩnh đặt đầu prompt để caching ăn (Haiku 5.5: tiền tố tối thiểu 512 token, cần kiểm chứng; đọc cache ≈ 0,1× giá vào). Server kiểm đủ id, đúng thứ tự, NFC, không còn `\p{Han}` (trừ glossary), `len ≤ 1,1 × max_chars` (vượt thì condense riêng); transcript/metadata là dữ liệu không tin cậy, chỉ dẫn trong đó bị bỏ qua.
- **Xưng hô** (Netflix vi không có luật đại từ; [BHASA](https://arxiv.org/pdf/2309.06085) cho rằng cần người đánh giá): mỗi video một bản đồ `register` cố định; mặc định (giả định, người bản ngữ duyệt): creator "mình/các bạn" (livestream "cả nhà"), thuyết minh "tôi", cặp đôi "anh/em", cha mẹ–con "bố, mẹ/con", "tao/mày" chỉ khi bản gốc thô tương đương. Không dịch tên riêng; glossary slang có version, log `new_terms` để duyệt.

**7.6 Hard-sub.** v1: dải che kéo thả, nhớ vị trí theo tác giả, né UI (selector cần kiểm chứng); `ocr_content` khác rỗng và phủ ký tự với ASR ≥ 0,5 thì gợi ý bật. M0 S6 đo tỉ lệ video có phụ đề cứng; nếu ≥ 40% (giả định), spike **OCR-first** ở M4 (kéo lên M2 nếu kịp): giải mã khung từ MP4 đã tải (WebCodecs), OCR bằng PP-OCRv5 mobile (dòng chữ in tiếng Trung 0,8605 — [PP-OCRv5](https://www.paddleocr.ai/latest/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html)) qua onnxruntime-web, lấy lúc sub gốc hiện/tắt làm in/out, chỉ gọi ASR khi OCR thất bại — bớt phí ASR (≈ 60–65% chi phí biến đổi stack Alibaba) và có timing do người làm; không gửi khung hình lên server.

**7.7 Đánh giá** (bộ tối thiểu M0–M2; gán nhãn từ tuần 0): 60 clip transcript sửa tay chia tầng (độc thoại, hội thoại, nói nhanh, slang, nhạc/nhiễu, giọng địa phương), 20 clip nhãn onset ±40 ms, 10 clip sub vi chuyên nghiệp. Đo CER, ảo giác, Δin/Δout (nhãn + player thật, trang beep trong CI), tuân thủ tự động, một LLM-judge khác họ với ứng viên theo rubric MQM rút gọn (chính xác, xưng hô, tên/slang, độ dài) hiệu chỉnh bằng 1 người bản ngữ trên 10 clip, và OTR/FRR/TTFS/w/$ online; cùng input cho mọi ứng viên; CI chặn khi CQR tụt > 2 điểm. Sau ra mắt: MetricX-24 (bản XXL ~13B cần GPU lớn — [card](https://huggingface.co/google/metricx-24-hybrid-xxl-v2p6/raw/main/README.md)), COMET-22, SubER/Sigma ([IWSLT](https://iwslt.org/2025/subtitling)), slang ([CSM-MTBench](https://arxiv.org/abs/2601.22931)), người xem mù; không dùng xCOMET-XL (CC-BY-NC-SA — [card](https://huggingface.co/Unbabel/XCOMET-XL)).

## 8. Render & đồng bộ
- Đồng hồ `requestVideoFrameCallback` + `metadata.mediaTime`, không dùng `timeupdate` (4–66 Hz — [MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/timeupdate_event)); pause/seek dùng rAF + `currentTime`; hiển thị theo thời gian cue + `offset_player`; binary search mỗi tick nên seek, vòng lặp, playbackRate tự đúng. Gắn `<video>` trong container active (`data-e2e-vid`, IntersectionObserver > 50%), kiểm `item_id` mỗi tick.
- **Không trễ:** chỉ hiện cue có `start ≤ t < end`; cue về sau `start` chỉ hiện nếu `(end − t)/playbackRate ≥ 0,6 s` (thời gian thực) và tính là muộn; luôn tắt đúng `end`; vùng `pending` tại playhead thì HUD "Đang chuẩn bị". playbackRate > 1,25: gộp cue liền kề cùng người nói nếu ≤ 84 ký tự và ≤ 20 cps thực, không được thì HUD "Tốc độ cao".
- **Bố cục:** closed shadow root, `:host{all:initial}`, `pointer-events:none`; khung hình theo `object-fit` + ResizeObserver; font đủ dấu tiếng Việt đóng gói sẵn; ngắt sau dấu câu hoặc trước "và/nhưng/mà/vì/nên/thì/để". Fullscreen: chuyển overlay vào `document.fullscreenElement`, hoặc `showPopover()` nếu chính `<video>` fullscreen ([Top layer](https://developer.mozilla.org/en-US/docs/Glossary/Top_layer)); PiP sau v1.
- **Kiểm thử:** trang beep đo Δrender trong CI (Chrome for Testing vẫn nhận `--load-extension` — [PSA](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/S0ET5wPjCAAJ)); mỗi bản phát hành kiểm tay 10 video thử (vỗ tay, đếm số) do nhóm tự đăng, chặn nếu |Δin| trên player thật > 1 khung.

## 9. Backend, tài khoản, hạn mức, cache, chống lạm dụng
**9.1 Tài khoản:** beta một cách đăng nhập (Google qua `launchWebAuthFlow`, chạy trên Chrome/Edge/Firefox — [identity](https://developer.chrome.com/docs/extensions/reference/api/identity), [Edge API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support); hoặc email OTP); JWT ~15 phút, refresh token xoay vòng; mọi cửa sổ kiểm entitlement ở server.

**9.2 Hạn mức — hai sổ cái.** **Phút sub** (đơn vị bán) chỉ tính khi tại playhead có coverage `final` của track có lời; không tính "Đang chuẩn bị", "Không dịch được", "Mạng chậm", nhạc bị ẩn, `no_speech`, `unsupported_lang`, quảng cáo, livestream; mỗi video đã hiện ≥ 1 cue tính tối thiểu 10 s (giả định, Q11, ghi trong bảng giá); popup hiện phút đã tính theo ngày. **Giây xử lý, $ provider** đo theo cửa sổ, ledger khóa theo `Idempotency-Key`, hoàn nếu hủy trước ASR. **Bất biến** (α = 1,6, chốt bằng p95 w ở beta): (1) `processed(kỳ) ≤ α × quota_đã_trả`; (2) xử lý suy đoán (N1) chỉ chạy khi `processed_suy_đoán(60 phút) ≤ (α − 1) × watched(60 phút) + 300 s` và `α·quota − processed − 1,3·quota_còn_lại > 0`; (3) item active không bao giờ bị chặn khi còn quota, trần theo item `processed_item ≤ max(W0, watched_item) + 40 s`.

**9.3 Cache.** L1: IndexedDB, LRU ~200 track, khóa `(platform, video_id, src, tgt, pipeline_major, schema)`, không lưu `failed`, `partial` TTL 1 giờ. **Beta chỉ L1**; server không giữ ánh xạ user ↔ video, đo h tiềm năng bằng `video_id` băm. **L2 (khi Q1 duyệt):** thêm `audio_fp` = sha256 AAC thô [0, 10 s] của gear chọn tất định (`data_size` nhỏ nhất), so trong cùng `gear_uri`; `verified` khi ≥ 2 tài khoản độc lập trùng fp; trùng < 80% thì dùng fingerprint PCM ở media worker; TTL 30 ngày, không `user_id`, danh sách gỡ, single-flight.

**9.4 Chống lạm dụng, chi tiêu.** Server không bao giờ tải URL do client gửi (không SSRF). Cửa sổ theo §6.2, ≤ 2 MB, thời lượng header khớp ±5%, video ≤ 10 phút. Mỗi người ≤ 2 cửa sổ đang tải, ≤ 40 item/phút (burst 10), 2 thiết bị; dùng thử một lần mỗi tài khoản + `install_id`, có trần ngân sách dùng thử. Bất thường → khóa mềm. Ngân sách chi tiêu ngày + circuit breaker + provider gate; chạm 80%: tắt N1 nguyên clip → provider rẻ hơn → dừng dùng thử.

**9.5 Thanh toán.** Stripe không mở cho doanh nghiệp Việt Nam ([Stripe](https://stripe.com/global)). **Đăng ký hộ kinh doanh trước giao dịch đầu** (kể cả đặt trước), hóa đơn điện tử từng pass. Pass 1 tháng ở beta (3/12 tháng sau) qua VietQR — payOS (không thu phí trung gian; chữ ký webhook cần kiểm chứng — [payOS](https://payos.vn/)) hoặc SePay (FREE 50 giao dịch, STARTUP 120.000 đ/tháng — [SePay](https://sepay.vn/bang-gia.html)); kích hoạt tay khi webhook lỗi; nhắc gia hạn; công bố điều khoản bán và hoàn tiền. Quốc tế sau v1: Creem 3,9% + $0,40 ([Creem](https://www.creem.io/pricing)), Polar 5% + 50¢ + 1,5% ([Polar](https://polar.sh/resources/pricing)), Paddle ([Paddle](https://www.paddle.com/pricing)), cộng phí rút (Creem max(7 USD; 1%)/lần ⇒ ≥ 14 USD/tháng; Polar 2 USD/tháng + 0,25% + 0,25 USD/lần, 1% FX, 15 USD/tranh chấp). Pha 2: MoMo ([tokenization](https://developers.momo.vn/v3/docs/payment/guides/aio-tokenization-payment/)) hoặc ZaloPay ([Agreement Pay](https://docs.zalopay.vn/docs/specs/agreement-pay)), điều kiện cần kiểm chứng.

**9.6 Vận hành:** cảnh báo sức khỏe T0, lỗi provider/vùng, $/giờ; dashboard TTFS, FRR, OTR, w, $/phút; runbook Douyin đổi: bật tầng dự phòng → vá parser → fixture → nộp bản sửa của chính item CWS ≤ 48 giờ.

## 10. Chi phí đơn vị & gợi ý giá
```
m = Σ phút lời / Σ lời gọi dịch (mô phỏng ≈ 0,18)
I = P/m + r·t_zh + c·o_in + p_cond·(P_cond + 120)/m ;  O = r·k·t_vi + c·o_out + p_cond·75/m   (token/phút lời)
L = (I·p_in + O·p_out)/10^6 ;  u = (v·A + s·L)·(1 + retry) ;  c_min = w·(1 − h)·u
C_điển_hình = Q·c_min + C_infra ;  C_xấu_nhất = α·Q·u_xấu + C_infra
Q_max = min((R·0,6 − C_infra)/c_min, (R·0,8 − C_infra)/(α·u_xấu))
```
Tham số (giả định): r = 300 chữ/phút lời, s = 0,6, t_zh = 1, c = 25, o_in = 15, P = 2.000 (caching ~500), k = 1,2, t_vi = 1,5, o_out = 8, p_cond = 0,6, P_cond = 800, retry 2%, w = 1,4, h = 0 (beta chỉ L1), v = 1 (0,66 khi VAD), C_infra = 0,10 USD/người/tháng (MVP không có DO giữ kết nối; bật Job DO thì cộng phí duration, phản biện ước 0,10–0,45 USD), α = 1,6. **Xấu nhất thật:** s = 1, r = 450, w = α, không VAD/caching, p_cond = 0,8, retry 3%. Ra I ≈ 14.700, O ≈ 990 token/phút lời (bản trước 5.675 do giả định m = 0,4).

| Stack | u điển hình | c_min điển hình / tối ưu | u xấu nhất | 15/60/180 phút/ngày ($/tháng) | ASR/u |
|---|---|---|---|---|---|
| S1 Groq turbo + Gemini 2.5 FL | 0,00182 | 0,00253 / 0,00151 | 0,00243 | 1,24 / 4,66 / 13,78 | 37% |
| S2 Soniox + Gemini 2.5 FL | 0,00284 | 0,00395 / 0,00245 | 0,00346 | 1,88 / 7,22 / 21,45 | 60% |
| S3 Alibaba SG + Gemini 2.5 FL | 0,00328 | 0,00457 / 0,00285 | 0,00390 | 2,16 / 8,32 / 24,77 | 65% |
| S4 Alibaba SG + Claude Haiku 5.5 | 0,00334 | 0,00465 / 0,00294 | 0,00404 | 2,19 / 8,47 / 25,22 | 64% |
| S5 Alibaba SG + Gemini 3.1 FL | 0,00530 | 0,00737 / 0,00460 | 0,00720 | 3,42 / 13,36 / 39,89 | 40% |
| S6 ElevenLabs + Sonnet 5.5 (mốc) | 0,02776 | 0,03863 / 0,02283 | 0,04134 | 17,48 / 69,64 / 208,71 | 13% |

ASR vẫn lớn nhất ở stack Alibaba/Soniox, kế đến là prompt cố định (P/m ≈ 11.000 token/phút lời); với S4, caching cắt u ≈ 15%, VAD thêm ≈ 22%. S1 không làm cơ sở định giá: hạn mức Groq công bố (20 RPM; 28,8K audio-giây/ngày; đây là bảng giới hạn cơ bản, có thể xin nâng, cần kiểm chứng) chỉ đủ ~12 người dùng 30 phút/ngày. S5 lỗ ở kịch bản xấu nhất: loại hoặc tăng giá. Người dùng app Douyin xem 112–120 phút/ngày ([TechNode](https://technode.com/2026/09/09/douyin-overtakes-wechat-average-time-spent-per-user/)); web desktop chắc thấp hơn, đo ở beta.

**Giá ra mắt** (VietQR, phí ≈ 0; tiêu hết hạn mức; biên điển hình / xấu nhất thật)

| Gói (30 ngày) | Giá | Hạn mức | S2 | S3 | S4 | S5 |
|---|---|---|---|---|---|---|
| Dùng thử | 0 | 60 phút | S4 ≈ 0,28 USD (xấu nhất 0,39) | | | |
| Cơ bản | 79.000 đ | 300 phút (~10/ngày) | 56% / 40% | 50% / 33% | 49% / 30% | 21% / −22% |
| Tiêu chuẩn | 149.000 đ | 650 phút (~22/ngày) | 52% / 33% | 44% / 25% | 43% / 22% | 11% / −38% |
| Cao cấp | 299.000 đ | 1.300 phút (~43/ngày) | 53% / 34% | 45% / 26% | 44% / 23% | 13% / −36% |
| Gói thêm | 49.000 đ | +180 phút | 61% / 45% | 55% / 38% | 54% / 36% | 27% / −14% |

- Giữ 450/900/1.800 phút với S4 thì giá phải ≈ 102.000/200.000/396.000 đ. `Q_max` S4 ≈ 347/667/1.355; S2 ≈ 405/780/1.584; S1 ≈ 577/1.111/2.256 (khi có hạn mức Groq). Ràng buộc xấu nhất thường quyết định: nâng hạn mức khi α đo thật nhỏ hơn, caching được xác nhận (`cache_read_input_tokens`) hoặc có cache chung. Pass 3/12 tháng giảm 10%/20% (giả định). Mốc: Immersive Translate Pro ≈ $9,99/tháng ([pricing](https://immersivetranslate.com/en/pricing/), cần kiểm chứng).
- **Cố định** ≈ 40 USD/tháng (Workers ≈ 5, cần kiểm chứng; SePay ≈ 4,5 hoặc 0; container SG ≈ 10–25; email/tên miền/giám sát ≈ 10); aligner GPU 24/7 nếu cần +250–550. Một lần: luật sư, kế toán, gán nhãn (5–8 ngày công), phí CWS 5 USD. **Hòa vốn:** lợi nhuận gộp ≈ 3,3 USD/người trả tiền/tháng (149k/650 phút, S4, dùng 70%) ⇒ ≈ 13 người (không GPU), ≈ 134 người (GPU 400 USD). Dùng thử 60 phút ≈ 0,28 USD; chuyển đổi 5% ⇒ ≈ 5,5 USD/người trả tiền.
- **Tự host ASR** khi `A_self = G/(60·X·U)` + vận hành < `A_api` (Qwen3-ASR-0.6B báo 2000× ở concurrency 128, không nêu phần cứng). **Thuế:** hộ kinh doanh < 500 triệu đ/năm miễn VAT/TNCN nhưng vẫn khai ([Lao Động](https://news.laodong.vn/kinh-doanh/ho-kinh-doanh-co-doanh-thu-duoi-500-trieu-dong-can-luu-y-de-tranh-rui-ro-ve-thue-1649872.ldo)); ngưỡng 1 tỷ (NĐ 141/2026) chưa xác minh. Mốc quốc tế $4,99/$9,99/$19,99 phải tính lại với số mới và phí rút.

## 11. Phát hành & chính sách store
- **Một item CWS suốt vòng đời:** beta là chính item đó ở chế độ Unlisted/Private, ra mắt thì chuyển Public; không tạo item thứ hai cùng chức năng ("multiple extensions that provide duplicate experiences or functionality" bị cấm — [policies](https://developer.chrome.com/docs/webstore/program-policies/policies)).
- **Nộp thăm dò tuần 5–6 (giữa M1):** bản tối thiểu (tap + overlay + upload sau màn hình đồng ý) với **đúng bộ quyền cuối**, kèm privacy policy, tài khoản test, video demo giải thích xử lý tạm thời, không lưu, không xuất. Bị từ chối vì Blue Zinc/Copper/Lithium/Magnesium hoặc Purple Potassium thì dừng, chọn lại đường lấy audio và bộ quyền trước khi xây billing. Review mất vài ngày tới vài tuần ([review](https://developer.chrome.com/docs/webstore/review-process)).
- **Không thu tiền** tới khi người dùng cài được từ CWS; Load unpacked chỉ cho dogfood kỹ thuật (không tự cập nhật); Windows/macOS không có đường cài ngoài store cho người dùng phổ thông ([install](https://developer.chrome.com/docs/extensions/how-to/distribute/install-extensions)).
- **Kênh khác:** Edge Add-ons cùng M3 (≤ 7 ngày làm việc — [Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension), [policies](https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies)) nhưng chỉ cài trên Edge, không cứu người dùng Chrome/Cốc Cốc. Firefox (M5): không có `background.service_worker` ([BCD](https://raw.githubusercontent.com/mdn/browser-compat-data/main/webextensions/manifest/background.json)) và tabCapture nên dùng event page; source build lại được ([AMO](https://extensionworkshop.com/documentation/publish/add-on-policies/)); khai `data_collection_permissions` ([consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)).
- **Checklist** ([troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting)): Blue Argon — parser trong package, config chỉ chứa cờ ([MV3](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)); Blue Zinc/Copper/Lithium/Magnesium — không tải/lưu/xuất, không chữ "download"; Purple * — privacy policy, đồng ý trong UI, chỉ HTTPS, tuyên bố Limited Use ([Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)); Purple Potassium — `storage`, `offscreen`, `identity` (+ `declarativeNetRequestWithHostAccess` và họ domain CDN chỉ khi A1), host `www.douyin.com` + API, `tabCapture` và `*://*/*` optional, tránh `tabs`/`cookies`/`webRequest`/`<all_urls>`, build chặn mọi thay đổi văn bản cảnh báo quyền; Red Titanium — minify, không obfuscate; Yellow Magnesium — tài khoản reviewer có quota. Single purpose: "Phụ đề dịch AI đồng bộ cho video web".
- **Nếu bị gỡ:** sửa và nộp bản sửa của **chính item đó** ("Removals are permanent unless you submit a revision to fix the issue"), kháng nghị; không bao giờ đăng listing mới (lách cưỡng chế → chấm dứt tài khoản nhà phát triển); ngừng tính phút, hoàn phần pass chưa dùng nếu gián đoạn > 14 ngày (giả định). `minimum_chrome_version` ≈ 116, test mỗi bản trên Cốc Cốc. Lời kể voz.vn về một extension lồng tiếng Douyin bị gỡ: chưa kiểm chứng.

## 12. Pháp lý & quyền riêng tư
*Mức cao; gặp luật sư công nghệ và kế toán trong M1, trước khi thu tiền.*
- **Nền tảng:** ToS TikTok (1/12/2025) cấm script tự động, tải khi chưa đồng ý, dịch/tạo tác phẩm phái sinh ([ToS](https://www.tiktok.com/legal/page/row/terms-of-service/en)); thỏa thuận Douyin chưa đọc được (cần kiểm chứng); tòa Trung Quốc buộc bồi thường 1 triệu CNY vụ cào dữ liệu Douyin ([IT之家](https://www.ithome.com/0/596/034.htm)). Giảm (không loại trừ) rủi ro: chỉ xử lý video người dùng đang xem trong trình duyệt của họ, không cào, không bán dữ liệu, server không tải media, không đọc cookie.
- **Bản quyền:** bản dịch là tác phẩm phái sinh ([Luật 07/2022](https://thuvienphapluat.vn/van-ban/So-huu-tri-tue/Law-07-2022-QH15-amendments-to-some-Articles-of-Law-Intellectual-Property-531773.aspx), [hỏi đáp](https://thuvienphapluat.vn/hoi-dap-phap-luat/lam-phu-de-phim-nuoc-ngoai-dang-len-mang-co-dang-vi-pham-luat-so-huu-tri-tue-khong-370043.html)); hiển thị riêng một người ít rủi ro hơn; cache chung là điểm rủi ro chính (Q1); có quy trình gỡ.
- **Dữ liệu cá nhân:** Luật 91/2025/QH15 (từ 1/1/2026), NĐ 356/2025 thay NĐ 13/2023, NĐ 330/2026 xử phạt từ 19/8/2026, tới 5% doanh thu với chuyển dữ liệu xuyên biên giới ([Tilleke](https://www.tilleke.com/insights/vietnam-issues-personal-data-protection-law), [LuatVietnam](https://luatvietnam.vn/tin-van-ban-moi/da-co-luat-bao-ve-du-lieu-ca-nhan-2025-so-91-2025-qh15-186-102925-article.html), [NĐ 356](https://thuvienphapluat.vn/van-ban/Quyen-dan-su/Nghi-dinh-356-2025-ND-CP-huong-dan-Luat-Bao-ve-du-lieu-ca-nhan-687428.aspx)); hồ sơ tác động và chuyển ra nước ngoài trong 60 ngày; trả lời chủ thể trong 30 ngày; cloud nước ngoài cũng là chuyển xuyên biên giới ([EY](https://www.ey.com/content/dam/ey-unified-site/ey-com/en-vn/technical/tax/documents/legal-alert-july-2025-personal-data-protection-law-en.pdf)); miễn trừ startup có điều kiện ([Conventus](https://conventuslaw.com/report/vietnams-new-personal-data-protection-law-what-businesses-need-to-know/), cần kiểm chứng).
- **Thương mại điện tử:** Luật TMĐT 2025 (122/2025/QH15, từ 1/7/2026) và NĐ 248/2026/NĐ-CP (theo LuatVietnam, cần kiểm chứng): thông tin người bán, điều khoản, xác thực, thông báo website; Luật Bảo vệ quyền lợi người tiêu dùng 2023 (giao dịch từ xa, hoàn tiền). Điều khoản của ta: chỉ xem cá nhân, cấm gọi API ngoài extension.
- **Nhà cung cấp AI:** chỉ gói trả phí (gói miễn phí Gemini dùng dữ liệu cải thiện sản phẩm), bật không lưu/không huấn luyện nếu có, ký DPA (cần kiểm chứng từng provider); OpenAI chỉ cam kết lưu trữ ở châu Á ([OpenAI](https://openai.com/index/introducing-data-residency-in-asia/)); provider gốc Trung Quốc là Q2.
- **Dữ liệu giữ:** audio chỉ trong bộ nhớ hoặc R2 presigned ≤ 120 s, xóa ngay sau ASR; cue ở L1 (L2 không `user_id`, TTL 30 ngày, nếu Q1); không giữ ánh xạ user ↔ video; sổ quota không có `video_id`; telemetry tổng hợp; không bao giờ thu cookie nền tảng.
- **Hỏi luật sư:** cache chung có là "phân phối" tác phẩm phái sinh; phơi nhiễm khi người dùng vi phạm ToS; hồ sơ chuyển dữ liệu sang Singapore/Mỹ, lịch sử xem có nhạy cảm; giọng người sáng tạo trong audio có là dữ liệu cá nhân; A1 sửa Referer có là vô hiệu hóa biện pháp kỹ thuật; bản sao tạm ở server có là sao chép; dùng tên "Douyin"; nghĩa vụ Luật TMĐT. **Hỏi kế toán:** VAT thuê bao, hóa đơn từng pass, thuế khoản trả từ merchant of record.

## 13. Rủi ro & giảm thiểu

| # | Rủi ro | KN/TĐ | Tín hiệu → giảm thiểu |
|---|---|---|---|
| R1 | Douyin đổi endpoint/field/player | Cao/Cao | T0 < 90% → hình dạng JSON, T0+T1, fixture CI, cờ T3, bản sửa ≤ 48 giờ |
| R2 | Anti-bot phát hiện/đè hook | TB/Cao | captcha tăng → pass-through không gán lại, A/B ở S1, lùi T1 |
| R3 | CDN đòi Referer/CORS, URL hết hạn | TB/Cao | 403 → A0 → A2 → A1 → T3 |
| R4 | DNR không áp lên request extension (A1) | TB/TB | S2 → chỉ dùng A1 khi cần, `ensureDnrRules` |
| R5 | CWS từ chối/gỡ, review chậm | TB/Rất cao | → một item, nộp thăm dò sớm, quyền tối thiểu, sửa chính item |
| R6 | ASR kém với BGM, phương ngữ, bịa chữ | TB/Cao | CER theo tầng → bake-off, SenseVoice, lọc |
| R7 | Provider đổi giá/ngừng/giới hạn ([Groq–Nvidia](https://groq.com/blog/groq-and-nvidia-enter-non-exclusive-inference-technology-licensing-agreement-to-accelerate-ai-inference-at-global-scale); OpenAI ngừng 2027-02-26) | TB/TB | 429 → adapter, provider thứ hai, provider gate |
| R8 | Chi phí vượt | TB/Cao | w > α → prefetch hai tầng, tối thiểu 10 s/video, bất biến α, VAD, caching |
| R9 | Lạm dụng, share tài khoản | Cao/TB | xử lý/xem bất thường → §9.4 |
| R10 | Đầu độc cache chung | Thấp/TB | → ≥ 2 tài khoản trùng fp, danh sách gỡ |
| R11 | Sai xưng hô, slang, tên | Cao/TB | → bản đồ xưng hô, glossary duyệt |
| R12 | Sub đè hard-sub/UI | Cao/TB | → dải che, heuristic, OCR-first |
| R13 | Video đầu thiếu sub | Cao/TB | TTFS p95 → làm ấm, W0 6–8 s, tải trước, Q5 |
| R14 | Pháp lý (ToS, phái sinh, BVDLCN, TMĐT) | TB/Cao | → luật sư M1, L1-only, hộ kinh doanh trước giao dịch đầu |
| R15 | Thanh toán (không Stripe, VietQR không tự gia hạn) | TB/Cao | → pass dài hạn, nhắc, MoR sau v1 |
| R16 | 1 dev trượt lịch | Cao/Cao | → MVP bán được, dự phòng 20%, cắt theo thứ tự |
| R17 | Douyin thêm domain CDN, cập nhật quyền làm extension bị tắt | TB/Cao | → A0 không cần host CDN; A1 khai họ domain từ đầu |
| R18 | Provider chặn theo vùng (egress HK) | TB/Cao | 400 location → Smart Placement, proxy SG |
| R19 | Lệch timeline player làm sai Δin | TB/Cao | Δin online > 1 khung → `offset_player`, kiểm tay mỗi bản |
| R20 | Nhu cầu thấp trên web desktop | TB/Cao | waitlist dưới ngưỡng → cổng nhu cầu trước M2 |
| R21 | Cốc Cốc/Chromium cũ; prompt injection | Thấp/TB | → `minimum_chrome_version`, test mỗi bản; guard + schema chặt |

## 14. Lộ trình theo mốc

Giả định: 1 dev full-stack toàn thời gian; gán nhãn, luật sư, kế toán, đăng ký kinh doanh, marketing chạy song song.

**MVP bán được:** T0 + T1, A0 (A2 dự phòng), remux AAC, overlay rVFC + HUD + dải che, chỉ tiếng Việt; một Worker `POST /v1/windows` + D1 + container SG (egress, SenseVoice); 1 ASR + 1 LLM chạy thật (provider thứ hai là adapter tắt bằng cờ); một cách đăng nhập; payOS pass 1 tháng; bộ đánh giá tối thiểu. Ngoài MVP: Job DO, luồng sự kiện, Queues, single-flight, Quota DO, L2, song ngữ, "Giữ nhịp".

| Mốc | Nội dung (ngày dev) | Tiêu chí hoàn thành |
|---|---|---|
| **Tuần 0** | Chọn clip, gán nhãn (5–8 ngày công); landing + demo + waitlist; hồ sơ hộ kinh doanh; liên hệ luật sư | dữ liệu sẵn trước S4/S5 |
| **M0 Spike & bake-off** (tuần 1–3; 13–14) | S1 tap T0/T0-SSR/T1 trên Chrome + Cốc Cốc, A/B captcha 2 × 200 video có/không hook; S2 đường tải (§5.6); S3 remux, `offset_player`, overlay, fullscreen, "Giữ nhịp", TTFS ở 3 hồ sơ mạng; S4 3 ASR; S5 3–4 LLM; S6 Cốc Cốc, `ocr_content`, tỉ lệ hard-sub, egress 3 nhà mạng × 48 giờ; harness eval (2,5) | T0 ≥ 90%, T0∪T1 ≥ 95% item có MediaDescriptor trước khi phát, captcha không tăng rõ; một đường tải ≥ 95%; chọn ASR/LLM; TTFS prototype p50 ≤ 4 s; có c_min, w; quyết stack + egress. **No-go:** T0, A0, A2 cùng < 80% → quyết lại; chỉ còn T3 → chủ dự án chọn "khớp từ vòng 2" hay dừng; hook làm tăng captcha → T1 mặc định; không ASR nào đạt → engine tốt nhất + tăng giá |
| **M1 Alpha** (tuần 4–8; 24–26) | Extension; backend MVP + container; chia câu, timing, offset; dịch, condense, register; renderer, HUD; đồng ý, privacy, **nộp CWS thăm dò tuần 5–6**; CI fixture, eval, beep; gặp luật sư/kế toán | dogfood ≥ 1 tuần: TTFS p50 ≤ 3 s, FRR ≥ 85%, OTR ≥ 98%, Δin P90 ≤ 200 ms (nhãn + player thật), CQR ≥ 60%, không hỏng phát video; CWS chấp nhận bản thăm dò hoặc đã rõ hướng sửa |
| **M2 Beta thu tiền** (tuần 9–12; 15–16) | Tài khoản; sổ cái, bất biến, payOS + admin; xóa dữ liệu; chống lạm dụng, provider gate; VAD, caching, prefetch điều tiết, T2/T3 sau cờ; dashboard. Chỉ thu tiền khi qua cổng nhu cầu và cài được từ CWS | 30–100 người, ≥ 2 tuần số liệu: w p95 ≤ α; chốt giá, α; CQR ≥ 65%; đối soát 100%; mô phỏng Douyin đổi → bản sửa nộp ≤ 48 giờ; 20–50 người trả tiền (giả định) |
| **M3 Ra mắt** (tuần 13–14 + review; 7–10) | Listing, website (giá, điều khoản, hoàn tiền, Limited Use); load test có giới hạn provider; runbook, hỗ trợ; provider thứ hai chạy thật; listing Edge; L2 nếu Q1; hồ sơ BVDLCN | CWS Public; CQR ≥ 70%, OTR ≥ 99%, FRR ≥ 90%, TTFS p50 ≤ 2,5 s; biên gộp thực ≥ 40% |
| **M4** (18–25) | TikTok caption-first; en/ja/ko→vi; OCR-first nếu §7.6 đạt; phương án B; T4 nếu Q5; song ngữ | TikTok đạt cùng KPI |
| **M5** (30–40) | YouTube, trang bất kỳ, Firefox, MoMo/ZaloPay, thẻ quốc tế, ASR tự host | KPI riêng |

- **Tổng tới ra mắt:** 59–66 ngày + 20% dự phòng ≈ 71–79 ngày (14–16 tuần); beta thu tiền ~tuần 10–12, công khai ~tuần 15–18 (review chạy song song từ tuần 5–6). Đường găng: S2, chọn ASR, review CWS.
- **Kiểm chứng nhu cầu (song song M0):** landing + video so sánh với caption trực tiếp + waitlist; đăng ở nhóm Facebook/Zalo/TikTok về phim Trung, Douyin, học tiếng Trung; "thành viên sáng lập" trả trước 1 tháng (ví dụ 49.000 đ, hoàn nếu không ra mắt) chỉ khi đã có hộ kinh doanh, chưa có thì thu "cam kết mua". **Cổng trước billing** (giả định): ≥ 300 waitlist và ≥ 30 người trả trước (hoặc ≥ 60 cam kết) trong 3 tuần; dưới mức thì thu hẹp hoặc đổi định vị.
- **Cắt khi trễ:** gói thêm, pass 3/12 tháng → T2/T3 → VAD/caching → provider thứ hai chạy thật. Không bao giờ cắt: tuân thủ store, quyền riêng tư, quota ở server, bộ đánh giá tối thiểu.

## 15. Quyết định chủ dự án cần chốt

**Đã chốt**
- **30/10/2026: chỉ dịch lời nói, bỏ qua tiếng hát** (cover, MV, nhạc nền có lời, hát nhép). Đoạn bị nhận là hát hoặc nhạc thì không hiện sub và không tính phút. Bỏ sót một câu nói còn hơn hiện lời bài hát hay chữ bịa trên nhạc. Cách nhận biết cần đo ở M0 (xem §7.2): tag sự kiện của SenseVoice, tín hiệu từ metadata (`music` của bài, hashtag như 翻唱/对口型/手势舞/音乐分享), và dấu hiệu trong bản chép (lặp cụm, khác ngôn ngữ video, câu ngắn như "嗯。" trên đoạn dài).

**Còn mở**
1. **Cache chung?** Đề xuất: beta chỉ L1; L2 từ M3 nếu luật sư đồng ý.
2. **Provider gốc Trung Quốc** (Alibaba SG, BytePlus) hay chỉ Mỹ/EU (Soniox, ElevenLabs)? Quyết định S2 hay S3/S4.
3. **Giá hay hạn mức:** 300/650/1.300 phút ở 79k/149k/299k, hay 450/900/1.800 ở ≈ 102k/200k/396k? Đề xuất: giữ giá, nâng hạn mức theo `Q_max` khi số đo cho phép.
4. **Hiển thị:** chỉ tiếng Việt hay song ngữ; 17 cps cứng hay 17/20; xưng hô mặc định; mức tục. Đề xuất: tiếng Việt, 17/20, "mình/các bạn", giữ mức tục.
5. **Video đầu phiên:** (a) thiếu 2–5 s đầu, (b) "Giữ nhịp", (c) "Phát lại từ đầu"; có cho tabCapture? Đề xuất: (a), (b)/(c) opt-in sau spike, tabCapture từ M4.
6. **Pháp nhân:** hộ kinh doanh + payOS ngay, hay công ty (MoMo/ZaloPay, merchant of record)? Đề xuất: hộ kinh doanh ở tuần 0.
7. **Nguồn lực:** ngân sách gán nhãn, API beta; thêm 0,3–0,5 FTE hay chấp nhận 15–18 tuần; ra mắt theo ngưỡng chất lượng hay theo ngày. Đề xuất: theo ngưỡng.
8. **Sau Douyin:** TikTok hay YouTube/Bilibili. Đề xuất: TikTok.
9. **Ngân sách, điểm dừng:** trần chi trước doanh thu; dừng/pivot nếu ví dụ < 20 người trả tiền sau 4 tuần beta hoặc biên điển hình thực < 30%.
10. **Dùng thử:** 60 hay 120 phút; chống tài khoản ảo thế nào.
11. **Tính phút:** tối thiểu 10 s hay 5 s mỗi video; hết hạn mức giữa video thì dừng ngay hay cho xem hết.
12. **Hoàn tiền, hỗ trợ:** chính sách hoàn pass VietQR; kênh Zalo OA/Facebook, thời gian phản hồi.
13. **Thương hiệu:** tên tiếng Việt, tra cứu nhãn hiệu; không đặt "Douyin" trong tên.
14. **Tăng trưởng:** kênh chính, ngân sách marketing 3 tháng đầu.

## Phụ lục: Nhật ký sửa đổi sau phản biện

*K = phản biện kỹ thuật, B = phản biện kinh doanh. Không ý kiến nào bị bác toàn bộ; chỗ áp dụng một phần có lý do.*

- K1 egress colo HK (major) — áp dụng: Smart Placement, log colo, proxy SG, test 3 nhà mạng (§4.8, §6.6); `apac-se` để cần kiểm chứng.
- K2 tự gỡ hook, lọc `/aweme/` (major) — áp dụng: pass-through, lọc host/path/content-type, `body.cancel()`, A/B captcha ở S1 (§4.2, §14).
- K3 timeline player (major) — áp dụng: timeline nguồn + `offset_player` đo trên player thật, kiểm tay mỗi bản (§7.4, §8).
- K4 prefetch/w/α (major) — một phần: W0 theo hành vi, cửa sổ khi L < 20 s, hủy khi vuốt, c theo cửa sổ, trần theo item (+40 s cho khớp luật cửa sổ); không dùng w = 1,8/2,4 vì chính sách mới mô phỏng ra 1,2–1,5.
- K5 luật cửa sổ (major) — áp dụng: bảng §6.2; FRR, L định nghĩa lại (§2).
- K6 host_permissions CDN (major) — một phần: A0 mặc định không cần host CDN (theo B8); nếu A1 thì khai họ domain từ đầu, domain mới optional; rào chắn URL (§5.3).
- K7 M4A với provider (major) — áp dụng: cách nạp theo provider, bake-off bằng M4A thật, nhánh Opus, presigned ≤ 120 s (§5.4, §6.7).
- K8 bài ảnh/quảng cáo/LID/hát/SSR/mã hóa (major) — áp dụng; SenseVoice đưa container SG vào v1 (§5.1, §5.2, §7.2).
- K9 mô hình chi phí (major) — áp dụng m ≈ 0,18, condense, retry; phí DO chỉ ghi điều kiện vì MVP không có DO giữ kết nối; bỏ ý gộp dịch W0 N2/N3 vì N2/N3 không còn xử lý server (§10).
- K10 điều phối provider (major) — áp dụng: provider gate 4 lớp trước M3, QPS trong quy tắc chọn (§6.6, §6.7, §9.4).
- K11 SSE không gửi được JWT (minor) — áp dụng: `fetch()` + NDJSON (§4.7).
- K12 SW giữ trạng thái, DNR session (minor) — áp dụng: scheduler ở offscreen, `ensureDnrRules()` (§4.2, §5.3).
- K13 TTFS thiếu bước (minor) — áp dụng: khởi động lạnh, moov, gộp lookup, gear bất kể codec (§5.4, §6.3).
- K14 out-time ở biên cửa sổ (minor) — áp dụng: `provisional_end` (§6.1, §7.4).
- K15 khóa cache, `audio_fp` (minor) — áp dụng (§9.3).
- K16 CSP wasm cho VAD (minor) — áp dụng (§7.2).
- K17 playbackRate (minor) — áp dụng (§8).
- K18 an toàn T3 (minor) — áp dụng (§5.2).
- B1 chi phí đơn vị (blocker) — áp dụng; hạn mức 300/650/1.300 thay vì 350/750/1.500 phản biện đề xuất vì mô hình mới dùng α = 1,6, w = 1,4; bỏ "cần kiểm chứng" ở giá Haiku 5.5 vì đã khớp bảng Anthropic (§1, §10).
- B2 bất biến α chặn item active (blocker) — áp dụng (§6.2, §9.2).
- B3 lời hứa "không trễ" — áp dụng: G1, HUD, Q5 (§1, §2, §6.5).
- B4 prefetch hai tầng — áp dụng (§6.4).
- B5 TTFS lạnh, mạng chậm — áp dụng: làm ấm, bảo vệ phát video, Opus (§6.3, §6.5).
- B6 CQR không đạt được — áp dụng: ±100 ms, 17 cps đo riêng, ngưỡng chốt sau baseline (§2).
- B7 đăng lại sau khi bị gỡ — áp dụng: một item, sửa chính item, Edge ở M3 (§11).
- B8 tải từ ISOLATED — áp dụng: A0 mặc định, A1 sau cờ; CORS của CDN để cần kiểm chứng vì content script chịu CORS (§5.3).
- B9 nộp CWS muộn — áp dụng: nộp thăm dò tuần 5–6, chưa cài được từ CWS thì chưa thu tiền (§11, §14).
- B10 chi phí cố định/dùng thử/hòa vốn — áp dụng; chọn ASR theo tổng chi phí (§6.7, §10).
- B11 MVP quá lớn — áp dụng; lịch 71–79 ngày (cao hơn 45–55 của phản biện) vì cộng K1, K3, K8 (§14).
- B12 bộ đánh giá quá nặng — áp dụng (§7.7).
- B13 nhu cầu/GTM — áp dụng; đặt trước chỉ sau khi có hộ kinh doanh để không mâu thuẫn B14 (§3, §14, Q14).
- B14 Luật TMĐT, đăng ký kinh doanh — áp dụng, số hiệu văn bản cần kiểm chứng (§9.5, §12).
- B15 thiếu quyết định — áp dụng: Q9–Q14.
- B16 định nghĩa phút sub (minor) — áp dụng (§9.2).
- B17 OCR-first (minor) — một phần: đo ở M0, spike ở M4 (kéo lên M2 nếu kịp) để giữ MVP gọn (§7.6).
- B18 phí quốc tế (minor) — áp dụng (§9.5, §10).
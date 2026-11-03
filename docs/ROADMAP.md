# TranslatorOfDuck: Lộ trình phát triển sản phẩm

> **Lập ngày 3/11/2026** theo hai yêu cầu của chủ dự án:
> 1. **Mục tiêu cuối:** dịch **toàn bộ video**, nói **bất kỳ ngôn ngữ nào**, sang **ngôn ngữ người xem chọn**; về sau bán gói credit.
> 2. **Làm sản phẩm ngon trước, bán sau.** Chưa làm chi phí, giá, credit, thanh toán, tài khoản cho tới khi chủ dự án nói sản phẩm đã ổn.
>
> **Tài liệu này thay các phần sau trong [`PLAN.md`](PLAN.md):**
> - §1 (phạm vi v1) và §14 (lộ trình M0–M5);
> - quyết định "chỉ dịch lời nói, bỏ qua tiếng hát" ở §15 và §7.2: từ 31/10 extension dịch cả lời bài hát, mặc định bật (HANDOFF §6j);
> - luật "khi không chắc thì nghiêng về bỏ qua" (HANDOFF §2): từ 3/11 là "không mất câu" (§6ai, §6aj);
> - tiêu chí "chọn rẻ nhất trong số đạt" ở §6.7: nay chọn theo chất lượng, giá chỉ ghi để tham khảo;
> - "bán thuê bao": nay là gói credit, và để sau.
>
> Các phần còn lại của `PLAN.md` (kiến thức Douyin, chuẩn sub, ghi chú nhà cung cấp, pháp lý) vẫn là tài liệu tham khảo. Nhật ký từng lần sửa nằm ở [`HANDOFF.md`](HANDOFF.md).

## Tóm tắt

| Giai đoạn | Mục tiêu | Lớn cỡ nào | Bạn cần làm |
|---|---|---|---|
| **0. Đo được "ngon", dọn lỗi** | Giữ bộ công cụ đo để kiểm từng thay đổi; dọn các lỗi đã biết trên Douyin | Vừa | Duyệt bộ video thử |
| **1. Chọn ngôn ngữ đích** | Tiếng Trung sang Việt và Anh (đã chốt tiếng Anh), rồi vài ngôn ngữ khác, cùng chất lượng | Vừa | Duyệt bản dịch tiếng Anh |
| **2. Thử nhanh nền tảng khác** | Biết nền tảng nào làm tiếp và bằng cách nào; nền tảng có phụ đề sẵn là đường rẻ nhất tới "mọi ngôn ngữ, cả video" | Nhỏ, mỗi nền tảng | Chọn nền tảng thử; quyết với nền tảng có rủi ro điều khoản |
| **3. Một ngôn ngữ nguồn mới, làm trọn** | Chọn model nhận dạng cuối; tiếng Anh (đề xuất) nói trong video, dịch sang Việt và Anh, đạt bảng điểm | Lớn | Tạo key nhà cung cấp nhận dạng; đồng ý chi phí chạy thử |
| **4. Mở ra nhiều ngôn ngữ nguồn** | Nhật, Hàn và các ngôn ngữ khác; chữ viết, chiều chữ, kính ngữ của từng ngôn ngữ | Lớn | Chọn ngôn ngữ; tìm người duyệt |
| **5. Nền tảng thứ hai, làm thật** | Cùng trải nghiệm trên nền tảng được chọn ở giai đoạn 2; đường dự phòng cho trang bất kỳ | Lớn | Duyệt rủi ro điều khoản |
| **6. Trải nghiệm đầy đủ** | Song ngữ, vị trí tuỳ ý, báo câu sai, bảng tên riêng cho phim dài | Vừa, xen kẽ được | Chọn tính năng |
| **7. Chuẩn bị bán (để sau)** | Server trên mạng, tài khoản, credit, thanh toán | Chưa tính | Chỉ bắt đầu khi bạn nói |

Thứ tự đề xuất: 0, 1, 2, 3, 4, 5. Giai đoạn 6 xen vào khi cần. Lý do thứ tự ở mục 5.

## 1. Nguyên tắc giữ suốt lộ trình

- **Sub có trước khi người ta nói.** Đây là điểm khác biệt chính: extension tải trước âm thanh của đoạn sắp phát. Nền tảng có phụ đề sẵn còn tốt hơn: có chữ của cả video ngay từ đầu. Cách "nghe âm thanh đang phát rồi mới dịch" chỉ là đường dự phòng, có nhãn "trễ".
- **Không mất câu.** Thà hiện dòng còn vài chữ gốc hơn là mất cả câu thoại (3/11). Mỗi lần pipeline bỏ một dòng phải có log và lý do.
- **Không làm:** tải hay lưu video cho người dùng; để server tự gọi API hay tự tải media của nền tảng; đọc hay gửi cookie; vượt chống bot; tự động lướt hay thu thập hàng loạt. Đo trên trang thật thì ít video, nhịp người xem; đăng nhập và captcha do chủ dự án làm.
- **Dữ liệu có bản quyền** (âm thanh, bản chép lời, bản dịch của video thật): chỉ để trên máy, không vào repo, không gửi đi đâu, xoá sau khi xong (HANDOFF §2; chủ dự án giữ luật này ngày 3/11). Không giữ bộ dữ liệu thử lâu dài: mỗi lượt đo xoá dữ liệu trên máy khi xong; repo chỉ giữ id video và điểm số. Key chỉ ở `alpha/server/.env`; không đọc, không in, không commit.
- **Mỗi thay đổi một lần:** ghi ngưỡng trước khi đo, viết test cho ca khó trước, sửa, chạy test, người kiểm độc lập soát, đo trên trang thật, commit. Chủ dự án push.
- **Làm thử nghiệm nền tảng mới trên bản sao extension và hồ sơ trình duyệt riêng,** không đụng extension bạn dùng hằng ngày.

## 2. Hiện trạng (3/11/2026)

**Đang chạy được:**
- Extension 0.2.41 cho `www.douyin.com`, server Node chạy trên máy (cổng 8787).
- Tiếng Trung sang tiếng Việt: dịch sẵn 10 s đầu, chia đoạn [0,10), [10,20) rồi mỗi đoạn 30 s; video dài, tua, lướt; lời bài hát có ♪; bảng xưng hô theo video.
- Đo trên Douyin thật ngày 3/11 (phim 21:42): **98,8%** số lần chụp hiện đúng dòng phải hiện (1.333/1.349). Lượt đo này chạy ở tốc độ 2×, trên extension 0.2.40, với model nhận dạng dự phòng, và trước các sửa của HANDOFF §6ai–§6ak. Các sửa đó được kiểm bằng test và chạy lại offline trên dữ liệu thật; chưa xem lại cả phim.

**Giới hạn về nhận dạng giọng nói:**
- **Fun-ASR** hết hạn mức miễn phí từ 1/11. Mọi đoạn đang đi qua **model dự phòng**, với các vấn đề đã gặp:
  - có lúc trả cả đoạn không dấu câu (§6ak);
  - kéo dài một chữ hàng chục giây (§6ai);
  - đánh ♪ nhầm 14,9% dòng nói, so với 1,4% của Fun-ASR (§6n);
  - có lúc mất 7,5–8,6 s thay vì khoảng 1 s (§6ab);
  - có thể nghe sót lời: 51 quãng dài hơn 4 s không có câu nào trong phim 21:42, chưa nghe lại (§6ai).
- **Fun-ASR cũng có lỗi riêng:** có lúc trả cả đoạn thành một câu (§6); bịa chữ trên nhạc (PLAN §6.6b); chỉ nhận ra khoảng một nửa số câu hát (§6n).
- **Quyết định ngày 3/11:** không bật lại Fun-ASR, chưa đo so sánh nhận dạng. Model dự phòng dùng tạm; model nhận dạng cuối chọn và tối ưu ở giai đoạn 3.
- **Chỉ có key Gemini** thì nhận dạng chạy bằng Gemini, không có mốc thời gian từng chữ: ♪ và bản sửa §6ak không chạy được (§6j). Máy Windows cần đủ key nhận dạng (§6ag).

**Chỉ tiếng Trung sang tiếng Việt.** Các chỗ gắn cứng:
- **Nhận dạng:** gợi ý ngôn ngữ `zh` ([pipeline.mjs:387](../alpha/server/pipeline.mjs#L387)); câu lệnh nhận dạng của Gemini viết cho tiếng Trung ([:457](../alpha/server/pipeline.mjs#L457)).
- **Tách câu, chia dòng:**
  - dấu kết câu không có dấu chấm ASCII ([:537](../alpha/server/pipeline.mjs#L537), [:704](../alpha/server/pipeline.mjs#L704));
  - các từ được nối không có dấu cách ([:531](../alpha/server/pipeline.mjs#L531), [:680](../alpha/server/pipeline.mjs#L680)), nên tiếng Anh sẽ bị dính chữ;
  - mỗi dòng tối đa 16 chữ Hán ([:696](../alpha/server/pipeline.mjs#L696)).
- **Phân loại lời:**
  - lời có nhiều chữ Latin bị bỏ với nhãn "không phải tiếng Trung" ([:576](../alpha/server/pipeline.mjs#L576));
  - chữ Kirin, Thái, Ả Rập, Devanagari bị coi là "không có lời" ([:575](../alpha/server/pipeline.mjs#L575));
  - nhận lời hát, tiếng đệm, câu nói nhanh trong bài hát đều đếm chữ Hán ([:554](../alpha/server/pipeline.mjs#L554), [:594](../alpha/server/pipeline.mjs#L594), [:642](../alpha/server/pipeline.mjs#L642), [:658](../alpha/server/pipeline.mjs#L658));
  - hashtag nhạc là tiếng Trung ([:544](../alpha/server/pipeline.mjs#L544)).
- **Dịch:**
  - câu lệnh ghi "từ tiếng Trung sang tiếng Việt", kèm luật xưng hô tiếng Việt và phiên âm Hán Việt ([:798](../alpha/server/pipeline.mjs#L798), [:847](../alpha/server/pipeline.mjs#L847), [:851](../alpha/server/pipeline.mjs#L851)); lượt dịch lại cũng vậy ([:901](../alpha/server/pipeline.mjs#L901)); lượt rút gọn viết cho tiếng Việt ([:935](../alpha/server/pipeline.mjs#L935));
  - độ dài dòng tính theo 17 ký tự/giây ([:804](../alpha/server/pipeline.mjs#L804));
  - trường dữ liệu đặt tên `zh`/`vi` ([:737](../alpha/server/pipeline.mjs#L737), [:868](../alpha/server/pipeline.mjs#L868));
  - luật giữ hay bỏ dòng còn chữ Hán chỉ coi chữ Latin là tiếng Việt ([:881](../alpha/server/pipeline.mjs#L881)).
- **Server:**
  - id video chỉ nhận chữ số, tức chỉ nhận id Douyin ([server.mjs:115](../alpha/server/server.mjs#L115));
  - cache chỉ có loại `vi`/`vi.lyr` ([:129](../alpha/server/server.mjs#L129));
  - tra ngữ cảnh đoạn trước và lệnh đẩy việc lên trước đều ghi cứng `vi` ([:189](../alpha/server/server.mjs#L189), [:314](../alpha/server/server.mjs#L314)).
- **Extension:**
  - nhãn ghi "VI" ([content.js:1365](../alpha/extension/content.js#L1365));
  - phần vẽ sub đọc trường `vi` ([:1559](../alpha/extension/content.js#L1559));
  - chữ giao diện tiếng Việt ([:1368](../alpha/extension/content.js#L1368), popup);
  - font chữ Latin, không đặt thuộc tính ngôn ngữ (`lang`) và chiều chữ (`dir`) ([:1338](../alpha/extension/content.js#L1338)).

**Chỉ Douyin:**
- extension chỉ chạy trên `www.douyin.com` ([manifest.json](../alpha/extension/manifest.json));
- tìm video đang xem bằng thuộc tính riêng của Douyin ([content.js:316](../alpha/extension/content.js#L316)), tải âm thanh qua `/aweme/v1/play/` ([:643](../alpha/extension/content.js#L643));
- `tap.main.js` đọc JSON riêng của Douyin;
- `mp4audio.js` chỉ đọc MP4 không phân mảnh với âm thanh AAC ([mp4audio.js:80](../alpha/extension/mp4audio.js#L80), [:93](../alpha/extension/mp4audio.js#L93)).
- Mỗi đoạn 30 s phải tải 5–6 MB để lấy khoảng 0,6 MB âm thanh, vì âm thanh xen giữa hình. Trình phát của Douyin thì tải riêng luồng âm thanh (DASH) (§6t).

**Chỉ chủ dự án dùng được:** phải tự chạy server và có key.

## 3. Thế nào là "ngon": bảng điểm

Mỗi giai đoạn chỉ xong khi bảng điểm đạt trên **bộ video thử** (giai đoạn 0 lập), không chỉ dựa vào cảm giác. Ngưỡng ghi trước khi đo, không chỉnh sau khi đã thấy số.

Tới khi chọn model nhận dạng cuối (giai đoạn 3), bảng điểm dùng để so trước và sau mỗi thay đổi. Các chỉ số phụ thuộc nhận dạng (nghe đủ, ♪ đúng, đúng nhịp) chưa dùng làm ngưỡng đạt.

| Chỉ số | Cách đo | Ngưỡng |
|---|---|---|
| **Không mất câu vì luật của ta** | Mỗi lần server hay extension bỏ một vế câu có nghĩa (cả khi bỏ nguyên đoạn) đều ghi log kèm lý do. Đếm trên bộ video thử. Tiếng đệm đã chấp nhận (嗯, 啊) không tính | 0 lần bỏ chưa được duyệt |
| **Độ phủ lời nói** | Vế câu nghe được mà có dòng sub, trên tổng số vế câu. Tính cả đoạn bị bỏ, vế không có chữ Hán, cả hai chế độ lời bài hát | Chỉ theo dõi xu hướng. Ngày 3/11 mất 3 câu thoại vẫn ra 99,04%, nên không dùng làm ngưỡng |
| **Nghe đủ** | Liệt kê quãng dài hơn 4 s không có câu nào mà vẫn có tiếng nói, theo năng lượng âm thanh hoặc theo một model nhận dạng thứ hai. Bạn chỉ nghe lại đúng các quãng đó | Mọi quãng bị nghi đều được nghe lại; ngưỡng chốt ở giai đoạn 3 |
| **Hiện đúng dòng** | Chụp mỗi 0,25 s khi phát ở 1×: số lần hiện đúng dòng, trên số lần lẽ ra phải có sub. Luôn báo kèm độ phủ | ≥ 98% |
| **Đúng nhịp** | Độ lệch giữa lúc sub hiện và lúc người nói bắt đầu (Δin, PLAN §2), đo như ngày 30/10 (HANDOFF §5) | trung vị ≤ 80 ms, P90 ≤ 200 ms (mốc M1 của PLAN §2) |
| **Tốc độ đọc** | Số dòng không vượt số ký tự/giây của ngôn ngữ đích (đếm theo ký tự hiển thị); số dòng phải rút gọn | tiếng Việt ≥ 85% dòng ≤ 17 ký tự/giây (mốc M1 của PLAN §2); ngôn ngữ khác theo chuẩn của ngôn ngữ đó |
| **Không chờ khi đang xem** | Số lần hiện "đang dịch" khi phát liên tục, không tính 5 s đầu | 0 ở mạng thường; mạng chậm (~450 KB/s) ghi lại để so (§6t) |
| **Sẵn sàng khi lướt** | Số video có lời đã có sub khi vuốt tới, nếu dừng ≥ 3 s mỗi video (FRR, PLAN §2) | ≥ 85% (mốc M1) |
| **Sub đầu tiên** | Lúc có kết quả, trừ lúc bắt đầu phát (TTFS, PLAN §2); tách mở lạnh và video đã dịch sẵn | mở lạnh: trung vị ≤ 2,5 s, p95 ≤ 5 s. Đo được 3,0–4,2 s ngày 2/11 (§6ac) |
| **♪ đúng** | Trên các đoạn đã gán nhãn nói hay hát: số dòng ♪ đúng là câu hát, và số câu hát có ♪ | chốt sau lần đo đầu (số cũ ở §6n) |
| **Không lỗi** | Số nhãn "lỗi" do server hay extension gây ra. Lỗi phía nền tảng (Douyin trả 429, CDN treo) đếm riêng | 0 lỗi của ta |
| **Dịch đúng** | ≥ 200 dòng chia theo video. Lỗi nặng: sai nghĩa, mất ý, sai xưng hô, sai tên. Một model khác họ chấm mù; bạn kiểm 50 dòng. So hai phiên bản trên cùng các dòng, chạy ít nhất 2 lần (cùng câu lệnh mà hai lần chạy lệch 81 và 56 lỗi, §6r) | ≤ 5% dòng lỗi nặng |

**Điều kiện đo:**
- Mỗi lượt dùng cache trống (server đo riêng, thư mục `TOD_WORK` mới). Kết quả nhận dạng chỉ giữ trong lượt đó để chạy lại offline, rồi xoá.
- Hai kiểu mạng: mạng thường, và mạng giả lập chậm khoảng 450 KB/s như §6t. Ở mạng chậm, cách dịch sẵn 10 s chỉ phủ 27% thay vì 59% (§6ad).
- Chấm điểm ở tốc độ 1×. Tốc độ 2× chỉ để xem nhanh.

## 4. Các giai đoạn

### Giai đoạn 0: Đo được "ngon", dọn lỗi trên Douyin

**Mục tiêu:** giữ được bộ công cụ đo để kiểm từng thay đổi về sau (giai đoạn 1 cần nó để kiểm tiếng Anh); dọn các lỗi đã biết trên Douyin. Không so sánh model nhận dạng lúc này (quyết định 3/11).

**Việc cần làm:**
1. **Cứu bộ công cụ đo ngay.** *(Đã làm 4/11: `alpha/dev/real/`, HANDOFF §6al. Việc 2 cũng đã làm, trừ báo cáo đúng nhịp và chế độ ghi chẩn đoán.)* Các script đang nằm trong scratchpad của phiên 3/11 (`/private/tmp/...`), thư mục máy có thể xoá bất cứ lúc nào. Chép vào repo (`alpha/dev/real/`):
   - xem một video thật trong Chromium riêng (hồ sơ tạm, tắt tiếng), chọn tốc độ, tua tới đoạn cần, ghi sub và nhãn mỗi 0,25 s;
   - proxy ghi mọi yêu cầu extension gửi server, không ghi âm thanh;
   - báo cáo bảng điểm từ mẫu ghi được và cache;
   - quét cache tìm vế câu nghe được mà không có sub;
   - chạy lại offline bước chia câu, chia đoạn và ghép sub trên kết quả nhận dạng đã lưu. Cách này đã bắt được lỗi ranh giới đoạn hôm 3/11.
2. **Sửa các giới hạn của bộ công cụ:**
   - đếm cả đoạn bị bỏ nguyên đoạn, vế câu không có chữ Hán, và cả hai chế độ lời bài hát;
   - nhận biết "đang dịch" từ trạng thái máy đọc được, thay vì dò chữ tiếng Việt trên nhãn: chữ trên nhãn sẽ đổi ở giai đoạn 1;
   - thêm tuỳ chọn cho server đo giữ lại kết quả nhận dạng có mốc từng chữ, chỉ trong lượt đo, xoá khi xong. Hiện server xoá file nhận dạng khi đã có kết quả cuối ([server.mjs:230](../alpha/server/server.mjs#L230)), nên không chạy lại offline được;
   - thêm báo cáo đúng nhịp và tốc độ đọc;
   - thêm chế độ ghi chẩn đoán khi bạn xem bình thường, để lỗi bạn gặp trên máy Windows gửi về được.

   Kết quả ghi vào `alpha/server/work/` (đã nằm ngoài git) hoặc thư mục có `.gitignore` riêng, để GitHub Desktop không đẩy nhầm. Âm thanh và chữ của video xoá khi xong lượt đo; chỉ giữ điểm số. Chạy được cả trên Mac lẫn Windows.
3. **Bộ video thử:** khoảng 10–12 video Douyin, ghi id và thể loại vào repo: vlog nói nhiều, phim ngắn hội thoại, game, bài hát, video có tiếng Nhật hay tiếng Anh xen vào, một video trên 20 phút, một video dưới 15 s. Chạy lại cả bộ sau mỗi thay đổi lớn, ở nhịp người xem.
4. **Nhận dạng: chưa làm gì thêm.** Không bật lại Fun-ASR, không so sánh model lúc này (quyết định 3/11). Chỉ sửa khi model dự phòng làm mất câu, như các sửa ngày 3/11.
5. **Sửa các lỗi đã biết:**
   - đoạn đầu bị huỷ lúc mở video: gặp 1 lần, mở lại 5 lần trên 4 video không gặp lại (§6aj); chạy bộ video thử qua proxy để bắt;
   - khi ghép sub, dòng cuối đoạn trước có lúc bị cắt còn khoảng 1 s, và chữ lặp giữa hai dòng liền nhau tăng từ 11 lên 18 sau bản sửa §6ak; sửa trong `cues.js`;
   - đoạn chỉ có 诶？, 哎呀！ bị coi là tiếng đệm và bỏ (§6ai): chờ bạn quyết có giữ không;
   - tải thừa khi tua lúc lượt tải đầu video còn chạy, ở video 25–26 s (R2, §6af);
   - phép kiểm "file đã đổi" bị bỏ khi không biết cỡ file (F3, §6af; mới là suy luận);
   - trang video dài có chương, và video xem trước khi rê chuột lên thanh tiến trình, chưa thử (HANDOFF §5 điểm 4).
   - tốc độ đọc thấp: 67–75% dòng ≤ 17 ký tự/giây trên các lượt đo 4/11 (mốc 85%), vì server bỏ lượt rút gọn ở đoạn gấp và đoạn dịch sẵn (HANDOFF §6al); chờ bạn chọn hướng.
6. **Thử tải riêng luồng âm thanh của Douyin**, như trình phát của trang (§6t), thay vì tải 5–6 MB cho 0,6 MB âm thanh mỗi đoạn 30 s. Giúp mạng chậm và video dài, và là bước chuẩn bị cho nền tảng dùng DASH (Bilibili, YouTube). Thử chỉ đọc, ít video. Trước đây luồng `bit_rate_audio` trả 403 (S1), chưa thử lại.
7. **Máy Windows:** hướng dẫn cài đã có ([alpha/README.md](../alpha/README.md)). Còn thiếu: chạy test và bộ công cụ đo trên Windows, và nói rõ key nhận dạng bắt buộc (chỉ có key Gemini thì mất mốc từng chữ).

**Bạn cần làm:** duyệt bộ video thử; xem thử và chấm cảm giác sau đợt sửa.

**Xong khi:** bộ công cụ đo chạy được trên Mac và Windows, và ra bảng điểm cho bộ video thử; các lỗi ở việc 5 đã sửa, hoặc có lý do để lại; bạn xem thấy ổn.

### Giai đoạn 1: Chọn ngôn ngữ đích

**Mục tiêu:** người xem chọn dịch sang tiếng Việt, tiếng Anh hay vài ngôn ngữ khác; chất lượng như tiếng Việt hiện nay.

**Việc cần làm:**
1. **Tách phần dịch ra khỏi `pipeline.mjs` trước,** thành phần dịch và "gói ngôn ngữ", hành vi không đổi, test giữ nguyên. Sau đó mới thêm ngôn ngữ, khỏi sửa một file 1.000 dòng hai lần.
2. **Chốt hợp đồng dữ liệu một lần cho cả lộ trình:**
   - đổi tên trường `zh`/`vi` thành tên trung tính: dòng gốc, dòng dịch, ngôn ngữ gốc, ngôn ngữ đích;
   - khoá cache gồm: nền tảng, id, đoạn, ngôn ngữ nguồn, ngôn ngữ đích, chế độ lời bài hát, phiên bản (PLAN §4.6 có mẫu);
   - file cache cũ vẫn đọc được;
   - service worker cũ không gửi ngôn ngữ đích thì hiểu là tiếng Việt (như cách xử lý service worker cũ ở §6y);
   - tăng `PIPELINE_VERSION` một lần ở đây, gộp việc làm lại cache cũ. Lưu ý: file nhận dạng mang số phiên bản trong tên nên cũng phải làm lại.
3. **Truyền ngôn ngữ đích:** ô "Dịch sang" trong popup. Chỉ lưu khi người dùng tự chọn: popup hiện lưu luôn giá trị mặc định khi đổi cài đặt khác, cùng loại lỗi với ô dịch sẵn 10 s (§6ad).
4. **Đổi ngôn ngữ đích giữa chừng** xử lý như đổi chế độ lời bài hát. **Dịch từ dòng gốc đã có:** đoạn đã có dòng gốc thì chỉ gọi dịch cho ngôn ngữ mới, không nhận dạng lại, mốc thời gian giống hệt.
5. **Gói ngôn ngữ đích:** câu lệnh dịch chung, cộng phần riêng của từng ngôn ngữ, cho cả lượt dịch đầu, dịch lại, rút gọn, lời bài hát.
   - tiếng Việt: luật xưng hô, bảng xưng hô theo video, phiên âm Hán Việt;
   - tiếng Anh: tên riêng theo pinyin, không có bảng xưng hô.

   Bảng xưng hô hiện là kiểu tiếng Việt (`PAIR_SCHEMA`, [pipeline.mjs:744](../alpha/server/pipeline.mjs#L744)). Bảng theo từng ngôn ngữ đích làm ở giai đoạn 4.
6. **Kiểm đầu ra theo ngôn ngữ đích ở mọi lượt:**
   - dòng trả về sai ngôn ngữ phải bị bắt, vì hiện chỉ kiểm độ dài và chữ Hán;
   - luật "còn chữ Hán thì dịch lại" chỉ áp khi ngôn ngữ đích không dùng chữ Hán;
   - đếm chữ của ngôn ngữ đích, không chỉ chữ Latin.
7. **Luật trình bày theo ngôn ngữ đích:**
   - số ký tự mỗi giây và mỗi dòng lấy từ chuẩn Netflix của từng ngôn ngữ. Hiện `PLAN.md` §7.1 mới có tiếng Việt (17, trần 20, 42 ký tự/dòng) và tiếng Trung (9, 16 ký tự/dòng);
   - đếm theo ký tự hiển thị;
   - đặt dấu cách quanh dấu câu theo từng ngôn ngữ (hiện là `fixViText`).
8. **Nhãn trên video ghi mã ngôn ngữ đích** thay chữ "VI" cố định. Dịch cả giao diện (popup, bảng thông tin) để sau, khi có người dùng ngoài (giai đoạn 6).
9. **Chọn model dịch cho từng cặp ngôn ngữ** theo chất lượng: chấm mù, so cặp trên cùng các dòng. Giá chỉ ghi để tham khảo.
10. **Test:** dịch vụ dịch giả cho từng ngôn ngữ đích trong các bộ test server; extension gửi đúng ngôn ngữ đích; e2e với tiếng Anh.

**Bạn cần làm:** duyệt bản dịch tiếng Anh, hoặc tìm người duyệt. Ngôn ngữ đích đầu tiên ngoài tiếng Việt là tiếng Anh (chốt 3/11).

**Xong khi:** tiếng Trung sang tiếng Anh đạt bảng điểm trên bộ video thử; tiếng Việt không kém đi.

### Giai đoạn 2: Thử nhanh nền tảng khác

**Mục tiêu:** biết nền tảng nào làm tiếp, và bằng cách nào. Nền tảng có phụ đề sẵn không cần nhận dạng giọng nói, có chữ của cả video từ đầu, nhiều ngôn ngữ. Đó là đường rẻ nhất tới "mọi ngôn ngữ, cả video" (PLAN §5.7, §7.2).

**Việc cần làm:** mỗi nền tảng một lượt thử ngắn: ít video, chỉ đọc, trên bản sao extension và hồ sơ trình duyệt riêng. Mỗi lượt trả lời ba câu: có phụ đề sẵn không; lấy được âm thanh trước chỗ đang xem không; rủi ro điều khoản là gì.
- **YouTube:** dùng phụ đề sẵn. Không lấy âm thanh, vì chính sách Chrome Web Store nêu đích danh việc giúp tải video YouTube (PLAN §5.7).
- **Bilibili:** tiếng Trung nên không cần giai đoạn 3; âm thanh tách riêng (DASH); có phụ đề CC ở một số video.
- **TikTok:** gần Douyin nhất, nhưng điều khoản cấm script tự động và cấm dịch hay tạo tác phẩm phái sinh (PLAN §12), và muốn tải media thì phải dùng cookie của trang (PLAN §5.7), trái luật không dùng cookie. **Chỉ thử khi bạn đã quyết.**

**Bạn cần làm:** chọn nền tảng thử; quyết với TikTok.

**Xong khi:** có một trang ghi kết quả từng nền tảng và đề xuất nền tảng thứ hai cho giai đoạn 5.

### Giai đoạn 3: Một ngôn ngữ nguồn mới, làm trọn

**Mục tiêu:** làm trọn một ngôn ngữ nguồn trước khi tổng quát hoá: tiếng Anh (đề xuất) nói trong video, dịch sang tiếng Việt và tiếng Anh, đạt bảng điểm.

**Việc cần làm:**
1. **Tách phần nhận dạng thành một lớp chung trước:** mọi nhà cung cấp trả về chữ, câu, từng chữ kèm mốc thời gian và dấu câu, ngôn ngữ nhận ra (`NormalizedAsr`, PLAN §4.5). Fun-ASR, model dự phòng và Gemini chuyển sang lớp này.
2. **Chọn model nhận dạng cuối:** một model nhiều ngôn ngữ làm chính, một làm dự phòng. Đây là lúc tối ưu phần nhận dạng (chủ dự án, 3/11). Chọn theo chất lượng: sai chữ, có dấu câu, mốc thời gian, độ trễ. Ngưỡng ghi trước, có thể dùng số ở PLAN §6.7: sai chữ không quá model tốt nhất 1 điểm; lệch mốc thời gian trung vị ≤ 80 ms, P90 ≤ 150 ms; bịa chữ ≤ 1%. Giá chỉ ghi để tham khảo. Mỗi lượt chạy thử tốn tiền gọi dịch vụ, nên sẽ hỏi trước.
3. **Sửa các chỗ gắn cứng mà tiếng Anh vấp phải:**
   - dấu chấm ASCII khi tách câu;
   - nối từ có dấu cách;
   - chia dòng theo từ và ký tự thay vì 16 chữ Hán;
   - bỏ nhãn "không phải tiếng Trung" với ngôn ngữ đã hỗ trợ;
   - câu lệnh nhận dạng và câu lệnh dịch ghi đúng ngôn ngữ nguồn.
4. **Lời bài hát:** tạm thời dịch mọi dòng, chưa đánh ♪ cho ngôn ngữ mới. Chế độ lời bài hát mặc định bật không bao giờ làm mất câu ([pipeline.mjs:991](../alpha/server/pipeline.mjs#L991)). Nhận lời hát cho ngôn ngữ khác để sau: bộ phân loại âm thanh SenseVoice mà `PLAN.md` nhắc chỉ biết zh, yue, en, ja, ko (PLAN §7.2).
5. **Nguồn video thử tiếng Anh:** Douyin có ít video tiếng nước ngoài. Có thể phải chờ nền tảng của giai đoạn 2. Vẫn theo luật không tải video: chỉ dùng âm thanh của video đã phát, giữ trên máy trong lượt đo, xoá khi xong.
6. **Kết quả cũ trong cache:** đoạn tiếng Anh trước đây đã bị ghi "không phải tiếng Trung" hay "không có lời" thì làm lại, như cách đã làm với "quá ít lời" (§6ai).

**Bạn cần làm:** tạo tài khoản và key cho nhà cung cấp được chọn, tự dán vào `.env`; đồng ý chi phí chạy thử; gửi vài video tiếng Anh; duyệt bản dịch.

**Xong khi:** tiếng Anh dịch sang tiếng Việt và tiếng Anh đạt bảng điểm, kể cả "nghe đủ" với ngưỡng chốt ở giai đoạn này.

### Giai đoạn 4: Mở ra nhiều ngôn ngữ nguồn

**Mục tiêu:** thêm tiếng Nhật, tiếng Hàn và các ngôn ngữ khác, mỗi ngôn ngữ một lần, dùng lại khung của giai đoạn 3.

**Việc cần làm:**
1. **Tách nốt `pipeline.mjs`:** chia câu và chia dòng, nhận lời hát và tiếng đệm, thành các phần theo ngôn ngữ. Hành vi không đổi, test giữ nguyên.
2. **Chia dòng theo hệ chữ:**
   - tiếng Trung, tiếng Nhật đếm chữ, và có luật không ngắt dòng ở một số dấu (kinsoku);
   - tiếng Thái và các ngôn ngữ không có dấu cách dùng `Intl.Segmenter`;
   - tiếng Ả Rập, tiếng Do Thái viết từ phải sang trái.
3. **Hiển thị theo hệ chữ:** đặt `lang` và `dir` cho dòng sub; dấu "♪ " đặt đúng chiều với chữ phải sang trái; font cho chữ Hán, Nhật, Hàn, Thái, Devanagari.
4. **Xưng hô theo từng ngôn ngữ đích:** tiếng Việt có anh/em; tiếng Nhật có kính ngữ; nhiều ngôn ngữ châu Âu có hai cách xưng "anh/ngài"; nhiều ngôn ngữ chia động từ theo giới tính người nói. Tên riêng phiên theo từng ngôn ngữ đích.
5. **Các quy ước cần chốt:**
   - video đã nói đúng ngôn ngữ đích thì hiện hay ẩn sub;
   - một dòng xen hai ngôn ngữ;
   - tiếng Quảng Đông;
   - chữ giản thể và phồn thể, và các biến thể như tiếng Bồ Đào Nha Brazil và Bồ Đào Nha;
   - ngôn ngữ nguồn do người xem chọn hay tự nhận, và cách ghi vào khoá cache.
6. **Nhận ra ngôn ngữ nói** theo từng đoạn, và xử lý video nói xen nhiều ngôn ngữ.
7. **Test chống chèn lệnh vào câu lệnh dịch** bằng nhiều ngôn ngữ. Hiện mô tả, tên người đăng và bảng xưng hô đã được đánh dấu là dữ liệu, nhưng dòng lời nói thì chưa ([pipeline.mjs:853](../alpha/server/pipeline.mjs#L853), [:868](../alpha/server/pipeline.mjs#L868)).

**Bạn cần làm:** chọn thứ tự ngôn ngữ; tìm người duyệt bản dịch cho ngôn ngữ bạn không đọc được.

**Xong khi:** mỗi ngôn ngữ thêm vào đạt bảng điểm trên bộ video thử của nó.

### Giai đoạn 5: Nền tảng thứ hai, làm thật

**Mục tiêu:** cùng trải nghiệm trên nền tảng đã chọn ở giai đoạn 2, và một đường dự phòng chạy được trên trang bất kỳ.

**Việc cần làm:**
1. **Tách phần riêng của Douyin khỏi `content.js`** (khoảng 1.640 dòng) thành "bộ chuyển đổi nền tảng", sau khi đã biết nền tảng thứ hai cần gì. Bộ chuyển đổi lo: danh sách video, video đang xem và đồng hồ phát, cách lấy chữ hay âm thanh trước, chỗ đặt sub. Phần chung giữ lại: lịch tải, ghép sub, hiển thị. Douyin là bộ đầu tiên, hành vi không đổi.
2. **Server nhận nhiều nền tảng:** id có tên nền tảng đi kèm (hiện chỉ nhận id toàn chữ số của Douyin); cache tách theo nền tảng.
3. **Định dạng âm thanh:** `mp4audio.js` hiện chỉ đọc MP4 không phân mảnh với AAC. Nền tảng dùng DASH phân mảnh, HLS, hay âm thanh Opus thì cần đọc thêm (giai đoạn 0 việc 6 đã chuẩn bị phần DASH).
4. **Đường dự phòng cho mọi trang:** thu âm thanh đang phát trong tab, rồi nhận dạng và dịch liên tục; sub trễ vài giây, có nhãn "trễ". Cần thiết kế riêng:
   - người xem bấm bật trên từng tab;
   - âm thanh phải vẫn phát ra loa khi đang thu;
   - server cần chế độ nhận dạng liên tục, vì hiện chỉ xử lý từng đoạn 10–30 s;
   - xin quyền theo tab đang mở, không xin quyền mọi trang.

**Bạn cần làm:** duyệt rủi ro điều khoản của nền tảng đó (PLAN §12).

**Xong khi:** nền tảng thứ hai đạt bảng điểm riêng của nó; đường dự phòng chạy được trên một trang bất kỳ.

### Giai đoạn 6: Trải nghiệm đầy đủ

Làm xen kẽ khi cần:
- sub song ngữ (dòng gốc cộng dòng dịch), hữu ích cho người học ngôn ngữ;
- kéo sub tới vị trí tuỳ ý (hiện mới có vài vị trí và cỡ chữ cố định); che phụ đề in sẵn trên video (PLAN §7.6);
- nút "Báo câu sai" gắn với từng dòng. Phải thiết kế để không cản thao tác với trình phát, vì lớp sub hiện không nhận chuột;
- bảng tên riêng và thuật ngữ theo từng phim dài, theo từng ngôn ngữ đích (hiện ngữ cảnh chỉ có 3 dòng trước và bảng xưng hô);
- video rất dài (một giờ trở lên): chiến lược dịch sẵn và tua;
- giao diện nhiều ngôn ngữ (popup, nhãn, bảng thông tin) và hướng dẫn lần đầu, khi có người dùng ngoài.

### Giai đoạn 7: Chuẩn bị bán (để sau)

Chỉ bắt đầu khi bạn nói sản phẩm đã ổn. Gồm: server chạy trên mạng thay server trên máy, tài khoản, credit, thanh toán, đo chi phí thật, hồ sơ Chrome Web Store, pháp lý. Phân tích có sẵn ở `PLAN.md` §9–§12, và ở bản tổng kết của Astra ngày 3/11 (chủ dự án giữ, chưa đưa vào repo).

Một ngoại lệ có thể kéo sớm: cho vài người ngoài dùng thử miễn phí để góp ý. Việc này vẫn cần server trên mạng (extension hiện chỉ gọi server trên máy), mã truy cập cho người thử, giới hạn chi tiêu, và màn hình báo cho người dùng biết âm thanh được gửi đi (PLAN §2, §12).

## 5. Thứ tự và việc chạy song song

- **0 trước hết, nhưng gọn:** cứu bộ công cụ đo (giai đoạn 1 cần để kiểm tiếng Anh) và dọn lỗi đã biết. Phần nhận dạng để giai đoạn 3.
- **1 tiếp theo.** Việc gọn, thấy kết quả ngay, và chốt hợp đồng dữ liệu cùng khoá cache một lần cho cả lộ trình.
- **2 ngay sau 1.** Rẻ, chỉ đọc. Kết quả quyết định đường đi: nếu nền tảng có phụ đề sẵn chạy được thì có "nhiều ngôn ngữ, cả video" mà chưa cần nhận dạng mới.
- **3 trước 4.** Làm trọn một ngôn ngữ trước, rồi mới tổng quát hoá, để mỗi bước đều ra một ngôn ngữ dùng được.
- **5 sau 2.** Chỉ tách bộ chuyển đổi nền tảng khi đã biết nền tảng thứ hai cần gì.
- **Song song được:** gom video thử tiếng Anh trong lúc làm giai đoạn 1; thử nền tảng (giai đoạn 2) trong lúc chờ bạn duyệt bản dịch.

## 6. Quyết định về sản phẩm

**Đã chốt ngày 3/11:**
1. Không bật lại Fun-ASR, chưa đo so sánh nhận dạng. Model nhận dạng cuối chọn và tối ưu ở giai đoạn 3.
2. Giữ luật xoá dữ liệu thử sau khi xong; không giữ bộ dữ liệu thử lâu dài.
3. Ngôn ngữ đích đầu tiên ngoài tiếng Việt: tiếng Anh.

**Còn mở:**
1. Nền tảng thử ở giai đoạn 2 (đề xuất: YouTube với phụ đề sẵn, và Bilibili), và có thử TikTok không.
2. Ngôn ngữ nguồn đầu tiên ngoài tiếng Trung (đề xuất: tiếng Anh).
3. Video đã nói đúng ngôn ngữ đích thì ẩn sub hay vẫn hiện.
4. Đoạn chỉ có tiếng kêu như 诶？, 哎呀！ thì bỏ hay giữ.
5. Ai duyệt bản dịch ở những ngôn ngữ bạn không đọc được.

## Phụ lục: phản biện ngày 3/11

Bản nháp đầu được một verifier độc lập soát (good_with_fixes). Các thay đổi chính đã áp dụng:
- **Bảng điểm:**
  - bỏ ngưỡng "độ phủ ≥ 99%", vì ngày mất 3 câu thoại vẫn ra 99,04%; thay bằng "không mất câu vì luật của ta" cộng chỉ số "nghe đủ" tạm;
  - thêm đúng nhịp, tốc độ đọc, sẵn sàng khi lướt, ♪;
  - nói rõ điều kiện đo: cache trống, hai kiểu mạng, tốc độ 1×, lỗi nền tảng đếm riêng;
  - chấm bản dịch trên ≥ 200 dòng thay vì 50.
- **Hiện trạng:** ghi rõ 98,8% đo ở 2×, trước khi sửa; thêm các chỗ gắn cứng còn sót (dấu chấm ASCII, nối từ không dấu cách, tên trường `zh`/`vi`, id chỉ nhận số, câu lệnh nhận dạng của Gemini); sửa lỗi nói trang `/video/` chưa thử (đã thử ngày 1/11).
- **Thứ tự:**
  - tách phần dịch và chốt hợp đồng dữ liệu ở đầu giai đoạn 1;
  - thêm giai đoạn thử nhanh nền tảng ngay sau giai đoạn 1, vì nền tảng có phụ đề sẵn không cần giai đoạn nhận dạng;
  - làm trọn một ngôn ngữ nguồn trước khi tổng quát hoá;
  - chỉ tách bộ chuyển đổi nền tảng sau khi đã chọn nền tảng.
- **Ràng buộc:** ghi rõ các quyết định cũ trong `PLAN.md` bị thay; chọn nhà cung cấp theo chất lượng, không theo giá; TikTok phải chờ bạn quyết vì điều khoản và cookie; việc giữ dữ liệu thử cần bạn đồng ý.
- **Thêm việc:** cứu bộ công cụ đo khỏi thư mục tạm; thử tải riêng luồng âm thanh Douyin; hiển thị theo hệ chữ; xưng hô theo từng ngôn ngữ; chống chèn lệnh; thiết kế đường thu âm thanh tab; server nhận nhiều nền tảng; bảng tên riêng theo phim.
- **Sau phản biện, chủ dự án chốt (3/11):** không bật lại Fun-ASR và chưa đo nhận dạng; giữ luật xoá dữ liệu thử; tiếng Anh là ngôn ngữ đích đầu tiên. Giai đoạn 0 bỏ phần so sánh nhận dạng; việc giữ dữ liệu chỉ trong từng lượt đo.

# Báo cáo S3/S4: nhận dạng giọng nói

Mẫu: 39, mỗi mẫu tối đa 30 s. Đáp án có ở 0 mẫu.

| Provider | Model | OK / lỗi | Độ trễ p50 / p95 (ms) | Nhanh hơn thời gian thực | Có lời | Có mốc theo từ | Nghi bịa chữ | CER trung bình / trung vị | Lệch so với funasr |
|---|---|---|---|---|---|---|---|---|---|
| funasr | fun-asr-flash-2026-06-15 | 39 / 0 | 718 / 1528 | 23× | 33/39 | 33/39 | 1 | – / – (n=0) | mốc |
| qwen3 | – | 0 / 3 | – / – | –× | 0/0 | 0/0 | 0 | – / – (n=0) | – |
| gemini | gemini-3.5-flash-lite | 39 / 0 | 2535 / 5420 | 6× | 10/39 | 0/39 | 1 | – / – (n=0) | 1 |

## Lỗi đầu tiên của từng provider

- **qwen3**: HTTP 403: {"error":{"message":"Access to model denied. Please make sure you are eligible for using the model.","type":"AccessDenied.Unpurchased","param":null,"code":"AccessDenied.Unpurchased"},"id":"chatcmpl-ea9d4487-92e0-9e4a-bc0c-3a84bfce7dfc","request_id":"ea9d4487-92e0-9e4a-bc0c-3a84bfce7dfc"}

## Từng mẫu

| Mẫu | Giây | Mô tả video | Lời nói (Trung) | Bản dịch (Việt) |
|---|---|---|---|---|
| e1c6ec54 | 7.6 | 请求支援… #迪迦奥特曼 #迪迦 #基里艾洛德人 #基里艾洛德人二代 #心动名场 | 恋人怀中。 | (bỏ qua: singing) |
| 8d51f8a5 | 12.2 | 风虽大，都绕过我的灵魂 | 爱是种爱是种爱是种爱是种爱是种爱是种。 | (bỏ qua: singing) |
| 6a2fcead | 18.3 | #清空 #翻唱 | 是我爱的太蠢，太过天真，才会把你的寂寞当做契合的灵魂。也是我自作自受，竟然那么认真相信你。多轻浮的在爱的世界，你好像还没弄懂。 | Là em yêu quá khờ dại, quá ngây thơ, / nên mới xem sự cô đơn của anh là tâm hồn đồng điệu. / Cũng là em tự chuốc lấy, lại có thể tin tưởng anh nghiêm túc đến vậ |
| 07f385c9 | 20.1 | 🕶️❤️‍🔥 | Girl right we wanna freak out have a good time. ladies come raise your hands. show me where all my fans come to the club | (bỏ qua: not_zh) |
| 10f57ac8 | 13 | #harrypotter #Blonde#hogwarts | 嗯。 | (bỏ qua: too_short) |
| 340404f5 | 22.7 | 《校花的贴身道士》第1~3集 纯享版 一次看爽！#道士 #AI #校花的贴身道士 | 学功夫练武术，师傅教你扎马步，天天扎马步。师傅，你我靠，师傅，师傅，你人呢。 | Học công phu luyện võ thuật, sư phụ dạy con đứng tấn, / ngày nào cũng đứng tấn. / Sư phụ, ngài / Ôi trời, sư phụ, sư phụ, ngài đâu rồi. |
| b8e7843c | 14.1 | 你很强 可惜遇到的是我们 | (không có lời) |  |
| 632a2d4e | 9.2 | 人真的好奇怪 突然爱 又突然不爱 #氛围感女主 #破碎感美学 #寂静岭雾 | (không có lời) |  |
| 6008c25c | 21.3 | 可我的性格总让我感觉亏欠 #对口型 #沦陷 | 我的性格都让我感觉亏欠世界，我未知的故事的一我多爱你一。 | (bỏ qua: singing) |
| 3107deac | 30.2 | 今天是体验干员日常的一天！ #三角洲干员漫展派对#三角洲行动redland #R | 今天是被妈妈顶号的一天，然后来体验单人的日常生活。待会儿要和竹竹乐队的朋友们一起，你先你先别，当什么周边没有拿到啊，我帮人带一张啊，你还要帮人带一张，我就一下。 | Hôm nay là ngày bị mẹ chơi thay tài khoản, / rồi đến để trải nghiệm đời sống thường ngày một mình. / Lát nữa sẽ cùng các bạn trong ban nhạc Trúc Trúc, / Cậu từ  |
| 26779d1a | 30.2 | 杨戬、哪吒、孙悟空、杨清玄进入北冥，却发现鲲鹏正在被朱厌捕杀 #杨戬 #哪吒 # | 一路往北，按理来说，此地应当就是北冥寒境。二郎，这鱼怎么能长这么大？不是鱼，是鲲。北冥有鱼，其名为鲲，化而为鸟，其名为鹏。究竟何等凶兽，居然有能力捕猎鲲鹏？又来了几个送死的，加速行军，照这个进程，不出半日即可。 | Càng đi về hướng bắc, xét theo lý mà nói, / nơi đây hẳn chính là vùng giá lạnh Bắc Minh. / Nhị Lang, con cá này sao lại có thể lớn thế này? / Không phải cá, là  |
| 3fd1bee2 | 18.1 | 胜方结算画面 #王者荣耀 #爱的主打歌运镜 #一镜到底#王者IP创作团 | 非死不可，有机会露破绽了，替你点根蜡。被铭记是需要付出代价的，念念不忘，必有回响。 | Phải chết thôi, có cơ hội lộ sơ hở rồi, thắp cho ngươi ngọn nến nhé. / Được ghi nhớ là cần phải trả giá đai, khắc ghi không quên, / ắt có hồi âm. |
| d85a974c | 12.6 | 你的呼吸像雨滴渗入我的爱里 | 你的故事像雨滴，渗入我的爱里。真希望雨能下不停，让想念继续。 | (bỏ qua: singing) |
| 9acae20d | 14.3 | 你和月亮有一个共同点 #Lili百合乡 | 嗯。 | (bỏ qua: too_short) |
| b744d6a8 | 7.6 | 2026年热播歌曲合集#音乐分享 #海屿你 #潮汐 #热播歌曲#茶汤 | 我们的过去，分分合合太多。 | (bỏ qua: singing) |
| 25c5095f | 30.2 | IG夺冠之路第一章：“宁王的弱势打野” 四月份还在令他暴怒的弱势英雄，十一月份直 | 那我会玩啥？咱们把把我整个猪女、整个渣子，容易被入侵野区。他们话也不说，把把选个弱势打野，能比他弱吗？我选个弱势打野，然后你们也话也不说。此视频拍摄于2018年4月18，连胜的IG在季后赛折戟四强。回到休息室的宁王瞬间暴怒，直言自己每局比赛 | Thế tôi chơi con gì? / Mỗi ván cứ bắt tôi chơi Sejuani, chơi Zac, / Rất dễ bị xâm chiếm rừng. / Họ chẳng nói gì, ván nào cũng chọn tướng rừng yếu, / Có thể yếu  |
| fbea5e36 | 13.4 | 喵～ #手势舞 #喵 #阿里嘎多 | 羊羊羊羊羊羊。 | (bỏ qua: singing) |
| 1b025f04 | 9.5 | 🧑‍🍳 #backseat #手势舞 | 七夕的天空。 | (bỏ qua: singing) |
| 64283fce | 21.6 | #飞天小麻花 看到我的起手式，你会心动吗 #枪 | (không có lời) |  |
| 359ea750 | 17.3 | 少女心事 #hotdog热狗很辣 | 三月。 | (bỏ qua: too_short) |
| 6a8d5f88 | 7.9 | #郑志杰 #泳池正常穿搭拍摄 | 到顶。 | (bỏ qua: too_short) |
| 41cb77e2 | 30.2 | 《醉醉酒店》1-8优化版/一口气看到爽，老粉可从16：26看 #即梦ai#末世囤 | 末日的第3年，我开了一家度假酒店。可是这都开2年了，怎么一个客人都没有？嗯，终于来客了！你愣着干什么？客人不用担心，他们进不来的。怎么可能？你还生活在童话世界里吗？你要死也别拽上我！放心吧，在我店里你死不了的。熊熊乖，去把门打开。好的，主人 | Vào năm thứ 3 của ngày tận thế, tôi đã mở một khách sạn nghỉ dưỡng. / Nhưng mà khách sạn mở được 2 năm rồi, sao lại không có một bóng khách nào thế này? / Ừm, / |
| 32e215da | 30.2 | 三角洲剪辑教学，学会了没！ #一条小团团ovo #三角洲行动 | 爆杀时刻怎么剪？我这个就可以教你们一下了，就是剪这种击杀时刻的时候，可以稍微的加个速，再加那个动态模糊，然后再再抽帧，漂亮，换位置，再加个那个什么，停顿停顿，对，再加停顿，你看我不用滑滑绳，用最快速度下降，知道吧？好呀。救一下，救一下，救一 | Khoảnh khắc càn quét cắt thế nào? / Tôi có thể dạy các bạn điều này, / Đó là khi cắt những khoảnh khắc hạ gục này, / Có thể tăng tốc một chút, / Rồi thêm hiệu ứ |
| 4a1b6d00 | 20 | 大师说我们缘浅 我说大师我加钱 #颜值就是最好的时尚单品#让你的照片更有秋日氛围 | 假如你舍一滴泪，假如老去我能陪，烟波里成灰，也许能完美。 | (bỏ qua: singing) |
| 521b1964 | 15.8 | #飞天小麻花 野火烧不尽 #青年创作者扶持计划 #火把节的仪式感 #藏在火把节里 | (không có lời) |  |
| a0a5f0f0 | 23 | 假如你也似水仙花般临水自照便好. #古早味 | (không có lời) |  |
| e3de6322 | 30.2 | 回忆是一件容易掉眼泪的事 #过敏 #翻唱 | 我敏感的神经线，一天一天没知觉，泛红双眼不成眠。他跟着我一整夜，麻痹的脸，他笑摇曳无解。 | (bỏ qua: singing) |
| a502d763 | 8 | 想回到你身边 #回到你身边 | 想回到你身边，对你说声“sorry.  | Rất muốn quay lại bên em, / để nói với em một câu "sorry". |
| f6358794 | 30.2 | 《名归名·红之章》 万木生春厂牌出道作品 万木生春是由我和@草帽小蔡 以及@AI | 本台消息，近日我市渝中江北多个路段接连发生不明破坏，监控显示一名蒙面女子屡次独自出现在事发现场。嗨我说什么来着，叫你低调点，还不叫人监控拍着了，搁不出大麻烦了吗？知道啦，你知道个嘛知道的，天天放着你那月薪3000的活不干，就想着除魔卫道，有 | Bản tin cho biết, gần đây tại các tuyến đường / thuộc Du Trung và Giang Bắc liên tiếp xảy ra các vụ phá hoại bí ẩn. / Camera giám sát cho thấy một phụ nữ đeo mặ |
| 8c35e580 | 17.4 | 万圣节我就扮演银行卡 这样你们的钱都可以存我这#嘉桐摇 | Let's go.  | (bỏ qua: not_zh) |
| adf10583 | 24.1 | 不愧是驯龙高手取景地#法罗群岛 #驯龙高手 |  pero si nada dime que lo que pasa yo quiero deserme contigo pap perd el control contigo pap dime dime yo teigo papi. ay | (bỏ qua: not_zh) |
| c4cc4c0a | 11.3 | 这首歌的频率太快了，就像逝去的青春，眨眼间闲散 | 嗯。 | (bỏ qua: too_short) |
| 5c843f1b | 30.2 | 其实这首歌最开始是在钢琴上写的🙈❤️ 是不是跟现在科幻感的版本非常不一样🤓  | 自由是逃离这全世界，到你身边，自由的放掉整个世界，一路荒野。你是我的地平线，不只为你发言。自由是与你浪迹的天，不惧危险。 | (bỏ qua: singing) |
| f5cba22e | 10.5 | 本世纪最伟大的前奏 | (không có lời) |  |
| 73f2ea1a | 27.1 | 《我的妹妹不可爱》第九集 千禧年非主流纯爱玄幻原创大片 @林一一 熬了无数个大夜 | 依依，你快说，永远都不会离开我。你还没说呢。嗯，依依永远都不会离开哥哥的。你发誓？我发誓，依依永远都不会离开哥哥的。为啥不说我？都一样嘛，反正。 | Y Y, em mau nói đi, sẽ không bao giờ rời xa anh. / Em vẫn chưa nói mà. / Ừm, Y Y sẽ không bao giờ rời xa anh hai đâu. / Em thề đi? / Em thề, / Y Y sẽ không bao  |
| 0e5094c7 | 12.1 | 至美至疯摩羯女 #摩羯 #对口型 #fyp #摩羯女 #红发 | 我不会怪你，天空的光芒，太阳的光。 | (bỏ qua: singing) |
| ebe9dce8 | 25.9 | 刚开始修炼，离成仙还有一大半 #难解 #敦煌舞蹈 #灵溪舞蹈姐妹花 | 今生的约定，有亏欠，前世不见，今生不见。 | (bỏ qua: singing) |
| c0fda5c0 | 18.5 | 《瑞草学院捉鬼师》 1-6集 30分钟纯享版 #瑞草学院捉鬼师 #苗疆少女 #即 | 我叫龙央，苗疆龙氏第19代捉鬼师。奶奶算到这所学校有怨气，派我还有他奶奶10年前在韩国收养的师弟龙舟一起来捉鬼。 | Tôi tên là Long Ương, là pháp sư bắt quỷ đời thứ 19 của gia tộc họ Long ở Miêu Cương. / Bà nội tính ra ngôi trường này có oán khí, / nên đã phái tôi cùng với sư |
| 0133088e | 12.9 |  | 觉得激动，便来捧上了花蜜，便独醉。活着是为了找目标，来游戏。害怕孤独，便团聚。怕过于迫切，便离开。 | Cảm thấy kích động, bèn dâng lên chút mật hoa, rồi say sưa một mình. / Sống là để tìm mục tiêu, để trải nghiệm. / Sợ cô đơn, nên mới tụ họp. / Sợ quá mức vội vã |

## Nói hay hát (chỉ dịch lời nói)

| Mẫu | Máy | Người | Giây/chữ (trung vị) | Chữ/giây | Hashtag nhạc | Lặp | Chữ Latin |
|---|---|---|---|---|---|---|---|
| e1c6ec54 | singing | singing | 0.55 | 1.8 |  |  | 0 |
| 8d51f8a5 | singing | singing | 0.32 | 1.9 |  | có | 0 |
| 6a2fcead | speech | singing | 0.22 | 3.3 | có |  | 0 |
| 07f385c9 | not_zh | singing | – | 0 |  |  | 1 |
| 10f57ac8 | too_short | no_speech | 0.6 | 1.7 |  |  | 0 |
| 340404f5 | speech | speech | 0.2 | 1.5 |  |  | 0 |
| b8e7843c | no_speech | no_speech | – | 0 |  |  | 0 |
| 632a2d4e | no_speech | no_speech | – | 0 |  |  | 0 |
| 6008c25c | singing | singing | 0.26 | 1.3 | có |  | 0 |
| 3107deac | speech | speech | 0.16 | 2.4 |  |  | 0 |
| 26779d1a | speech | speech | 0.2 | 3.1 |  |  | 0 |
| 3fd1bee2 | speech | speech | 0.24 | 3.2 | có |  | 0 |
| d85a974c | singing | singing | 0.399 | 2.1 |  |  | 0 |
| 9acae20d | too_short | no_speech | 0.6 | 1.7 |  |  | 0 |
| b744d6a8 | singing | singing | 0.4 | 2 | có |  | 0 |
| 25c5095f | speech | speech | 0.16 | 4.7 | có |  | 0.03 |
| fbea5e36 | singing | singing | 0.54 | 0.5 | có | có | 0 |
| 1b025f04 | singing | singing | 0.28 | 1.6 | có |  | 0 |
| 64283fce | no_speech | no_speech | – | 0 |  |  | 0 |
| 359ea750 | too_short | singing | 0.54 | 1.9 |  |  | 0 |
| 6a8d5f88 | too_short | singing | 0.6 | 0.3 |  |  | 0 |
| 41cb77e2 | speech | speech | 0.16 | 3.4 |  |  | 0 |
| 32e215da | speech | speech | 0.16 | 3.6 |  |  | 0 |
| 4a1b6d00 | singing | singing | 0.48 | 1.7 |  |  | 0 |
| 521b1964 | no_speech | no_speech | – | 0 |  |  | 0 |
| a0a5f0f0 | no_speech | no_speech | – | 0 |  |  | 0 |
| e3de6322 | singing | singing | 0.49 | 1.5 | có |  | 0 |
| a502d763 | speech | singing | 0.28 | 2.2 |  |  | 0.33 |
| f6358794 | speech | speech | 0.14 | 4.7 |  |  | 0 |
| 8c35e580 | not_zh | singing | – | 0 |  |  | 1 |
| adf10583 | not_zh | singing | – | 0 |  |  | 1 |
| c4cc4c0a | too_short | no_speech | 0.6 | 1.7 | có |  | 0 |
| 5c843f1b | singing | singing | 0.38 | 1.8 | có |  | 0 |
| f5cba22e | no_speech | no_speech | – | 0 | có |  | 0 |
| 73f2ea1a | speech | speech | 0.173 | 2.3 |  |  | 0 |
| 0e5094c7 | singing | singing | 0.44 | 1.3 | có |  | 0 |
| ebe9dce8 | singing | singing | 0.57 | 1.5 | có |  | 0 |
| c0fda5c0 | speech | speech | 0.17 | 3.7 |  |  | 0 |
| 0133088e | speech | unsure | 0.24 | 3.5 |  |  | 0 |

Trên 38 mẫu có nhãn người: đúng 36/38. Lời nói được giữ lại 10/10; nhạc/không lời bị dịch nhầm 2/28.

## Bản dịch

13 video được dịch, 99 dòng sub; thời lượng dòng trung vị 2.1 s, dài nhất 5.5 s. Dòng thiếu bản dịch: 0, còn chữ Hán: 0, vượt giới hạn ký tự: 44.

## Dịch thử (Gemini) theo từng câu, 5 mẫu đầu có bản dịch

### 6a2fcead (ASR: funasr, 1376 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 1.2–4.1 s | 是我爱的太蠢，太过天真， | Là em yêu quá khờ dại, quá ngây thơ, |
| 4.1–7.6 s | 才会把你的寂寞当做契合的灵魂。 | nên mới xem sự cô đơn của anh là tâm hồn đồng điệu. |
| 7.7–13 s | 也是我自作自受，竟然那么认真相信你。 | Cũng là em tự chuốc lấy, lại có thể tin tưởng anh nghiêm túc đến vậy. |
| 13.6–18.6 s | 多轻浮的在爱的世界，你好像还没弄懂。 | Hời hợt biết bao trong thế giới tình yêu, có lẽ anh vẫn chưa hiểu rõ. |

### 340404f5 (ASR: funasr, 1302 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0.1–4.2 s | 学功夫练武术，师傅教你扎马步， | Học công phu luyện võ thuật, sư phụ dạy con đứng tấn, |
| 8.3–9.7 s | 天天扎马步。 | ngày nào cũng đứng tấn. |
| 10.2–11.6 s | 师傅，你 | Sư phụ, ngài |
| 17.5–20.5 s | 我靠，师傅，师傅，你人呢。 | Ôi trời, sư phụ, sư phụ, ngài đâu rồi. |

### 3107deac (ASR: funasr, 1439 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0.5–2.3 s | 今天是被妈妈顶号的一天， | Hôm nay là ngày bị mẹ chơi thay tài khoản, |
| 2.4–4.6 s | 然后来体验单人的日常生活。 | rồi đến để trải nghiệm đời sống thường ngày một mình. |
| 4.7–7.4 s | 待会儿要和竹竹乐队的朋友们一起， | Lát nữa sẽ cùng các bạn trong ban nhạc Trúc Trúc, |
| 19.8–21.6 s | 你先你先别， | Cậu từ từ, đừng mà, |
| 23.8–26.1 s | 当什么周边没有拿到啊， | Sao lại không nhận được món quà lưu niệm nào thế, |
| 26.2–29 s | 我帮人带一张啊，你还要帮人带一张， | Tớ mua hộ người ta một tấm nhé, cậu còn định mua hộ người khác một tấm nữa ư, |
| 29.1–30.5 s | 我就一下。 | Tớ lấy một cái thôi. |

### 26779d1a (ASR: funasr, 1791 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 1.7–3.8 s | 一路往北，按理来说， | Càng đi về hướng bắc, xét theo lý mà nói, |
| 3.8–5.8 s | 此地应当就是北冥寒境。 | nơi đây hẳn chính là vùng giá lạnh Bắc Minh. |
| 5.8–8.8 s | 二郎，这鱼怎么能长这么大？ | Nhị Lang, con cá này sao lại có thể lớn thế này? |
| 8.9–10.5 s | 不是鱼，是鲲。 | Không phải cá, là Côn. |
| 10.5–13.9 s | 北冥有鱼，其名为鲲，化而为鸟， | Bắc Minh có cá, tên của nó là Côn, hóa thành chim, |
| 14–15.3 s | 其名为鹏。 | tên của nó là Bằng. |
| 15.3–18.9 s | 究竟何等凶兽，居然有能力捕猎鲲鹏？ | Rốt cuộc là hung thú phương nào, lại có năng lực săn bắt Côn Bằng? |
| 21.5–24.3 s | 又来了几个送死的， | Lại đến thêm mấy kẻ chịu chết, |

### 3fd1bee2 (ASR: funasr, 1418 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0.4–5.9 s | 非死不可，有机会露破绽了，替你点根蜡。 | Phải chết thôi, có cơ hội lộ sơ hở rồi, thắp cho ngươi ngọn nến nhé. |
| 6–10 s | 被铭记是需要付出代价的，念念不忘， | Được ghi nhớ là cần phải trả giá đai, khắc ghi không quên, |
| 10–11.8 s | 必有回响。 | ắt có hồi âm. |


"Lệch so với funasr" = trung vị tỉ lệ ký tự khác nhau so với dịch vụ mốc; chỉ để tham khảo khi chưa có đáp án, không phải độ chính xác.

CER = tỉ lệ lỗi ký tự so với đáp án (bỏ dấu câu, khoảng trắng). "Nghi bịa chữ" = quá 12 chữ/giây hoặc lặp một cụm ≥ 4 lần.

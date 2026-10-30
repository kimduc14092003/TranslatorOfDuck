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
| e1c6ec54 | 7.6 | 请求支援… #迪迦奥特曼 #迪迦 #基里艾洛德人 #基里艾洛德人二代 #心动名场 | 恋人怀中。 | Trong lòng người yêu. |
| 8d51f8a5 | 12.2 | 风虽大，都绕过我的灵魂 | 爱是种爱是种爱是种爱是种爱是种爱是种。 | Tình yêu là thế |
| 6a2fcead | 18.3 | #清空 #翻唱 | 是我爱的太蠢，太过天真，才会把你的寂寞当做契合的灵魂。也是我自作自受，竟然那么认真相信你。多轻浮的在爱的世界，你好像还没弄懂。 | Yêu quá ngây thơ, tưởng hồn hai đứa hợp nhau. |
| 07f385c9 | 20.1 | 🕶️❤️‍🔥 | Girl right we wanna freak out have a good time. ladies come raise your hands. show me where all my fans come to the club | Quẩy lên nào mọi người! |
| 10f57ac8 | 13 | #harrypotter #Blonde#hogwarts | 嗯。 | Ừm. |
| 340404f5 | 22.7 | 《校花的贴身道士》第1~3集 纯享版 一次看爽！#道士 #AI #校花的贴身道士 | 学功夫练武术，师傅教你扎马步，天天扎马步。师傅，你我靠，师傅，师傅，你人呢。 | Học võ công, sư phụ dạy con đứng tấn, ngày nào cũng đứng tấn. Sư phụ, người... ôi trời, sư phụ, sư phụ, người đâu rồi? |
| b8e7843c | 14.1 | 你很强 可惜遇到的是我们 | (không có lời) |  |
| 632a2d4e | 9.2 | 人真的好奇怪 突然爱 又突然不爱 #氛围感女主 #破碎感美学 #寂静岭雾 | (không có lời) |  |
| 6008c25c | 21.3 | 可我的性格总让我感觉亏欠 #对口型 #沦陷 | 我的性格都让我感觉亏欠世界，我未知的故事的一我多爱你一。 | Tính cách khiến tôi luôn thấy nợ thế giới này. |
| 3107deac | 30.2 | 今天是体验干员日常的一天！ #三角洲干员漫展派对#三角洲行动redland #R | 今天是被妈妈顶号的一天，然后来体验单人的日常生活。待会儿要和竹竹乐队的朋友们一起，你先你先别，当什么周边没有拿到啊，我帮人带一张啊，你还要帮人带一张，我就一下。 | Hôm nay mẹ chơi hộ acc, trải nghiệm ngày đơn lẻ. Lát gặp bạn bè, chưa lấy đủ đồ, tớ mua hộ cho nhé. |
| 26779d1a | 30.2 | 杨戬、哪吒、孙悟空、杨清玄进入北冥，却发现鲲鹏正在被朱厌捕杀 #杨戬 #哪吒 # | 一路往北，按理来说，此地应当就是北冥寒境。二郎，这鱼怎么能长这么大？不是鱼，是鲲。北冥有鱼，其名为鲲，化而为鸟，其名为鹏。究竟何等凶兽，居然有能力捕猎鲲鹏？又来了几个送死的，加速行军，照这个进程，不出半日即可。 | Càng đi về bắc, đây hẳn là Bắc Minh. Sao cá lớn thế? Không phải cá, là Côn. Côn hóa Phượng Hoàng? Loài dữ nào săn được nó? Lại có kẻ chịu chết. Tăng tốc, nửa ng |
| 3fd1bee2 | 18.1 | 胜方结算画面 #王者荣耀 #爱的主打歌运镜 #一镜到底#王者IP创作团 | 非死不可，有机会露破绽了，替你点根蜡。被铭记是需要付出代价的，念念不忘，必有回响。 | Chờ sơ hở, thắp đuốc cho ngươi. Khắc ghi cần trả giá. |
| d85a974c | 12.6 | 你的呼吸像雨滴渗入我的爱里 | 你的故事像雨滴，渗入我的爱里。真希望雨能下不停，让想念继续。 | Chuyện tình như mưa, thấm sâu vào tim. |
| 9acae20d | 14.3 | 你和月亮有一个共同点 #Lili百合乡 | 嗯。 | Ừ. |
| b744d6a8 | 7.6 | 2026年热播歌曲合集#音乐分享 #海屿你 #潮汐 #热播歌曲#茶汤 | 我们的过去，分分合合太多。 | Quá khứ tan hợp quá nhiều. |
| 25c5095f | 30.2 | IG夺冠之路第一章：“宁王的弱势打野” 四月份还在令他暴怒的弱势英雄，十一月份直 | 那我会玩啥？咱们把把我整个猪女、整个渣子，容易被入侵野区。他们话也不说，把把选个弱势打野，能比他弱吗？我选个弱势打野，然后你们也话也不说。此视频拍摄于2018年4月18，连胜的IG在季后赛折戟四强。回到休息室的宁王瞬间暴怒，直言自己每局比赛 | Tháng 4/2018, IG thua ở bán kết. Ning nổi giận trong phòng chờ, bức xúc vì luôn phải chơi tướng đi rừng yếu. Lúc đó anh không biết rằng, 6 tháng sau, chính tướn |
| fbea5e36 | 13.4 | 喵～ #手势舞 #喵 #阿里嘎多 | 羊羊羊羊羊羊。 | Dương dương dương! |
| 1b025f04 | 9.5 | 🧑‍🍳 #backseat #手势舞 | 七夕的天空。 | Bầu trời Thất Tịch. |
| 64283fce | 21.6 | #飞天小麻花 看到我的起手式，你会心动吗 #枪 | (không có lời) |  |
| 359ea750 | 17.3 | 少女心事 #hotdog热狗很辣 | 三月。 | Tháng ba. |
| 6a8d5f88 | 7.9 | #郑志杰 #泳池正常穿搭拍摄 | 到顶。 | Đến đỉnh rồi. |
| 41cb77e2 | 30.2 | 《醉醉酒店》1-8优化版/一口气看到爽，老粉可从16：26看 #即梦ai#末世囤 | 末日的第3年，我开了一家度假酒店。可是这都开2年了，怎么一个客人都没有？嗯，终于来客了！你愣着干什么？客人不用担心，他们进不来的。怎么可能？你还生活在童话世界里吗？你要死也别拽上我！放心吧，在我店里你死不了的。熊熊乖，去把门打开。好的，主人 | Tận thế năm 3, tôi mở khách sạn. Đã 2 năm sao không có khách? À, khách đến kìa! Đứng ngẩn ra đó làm gì? Khách không vào được đâu. Sao có thể? Sống trong truyện  |
| 32e215da | 30.2 | 三角洲剪辑教学，学会了没！ #一条小团团ovo #三角洲行动 | 爆杀时刻怎么剪？我这个就可以教你们一下了，就是剪这种击杀时刻的时候，可以稍微的加个速，再加那个动态模糊，然后再再抽帧，漂亮，换位置，再加个那个什么，停顿停顿，对，再加停顿，你看我不用滑滑绳，用最快速度下降，知道吧？好呀。救一下，救一下，救一 | Cách làm video double kill cực đỉnh đây! |
| 4a1b6d00 | 20 | 大师说我们缘浅 我说大师我加钱 #颜值就是最好的时尚单品#让你的照片更有秋日氛围 | 假如你舍一滴泪，假如老去我能陪，烟波里成灰，也许能完美。 | Nếu người rơi lệ, ta nguyện cùng già đi, hóa tro tàn, có lẽ sẽ trọn vẹn. |
| 521b1964 | 15.8 | #飞天小麻花 野火烧不尽 #青年创作者扶持计划 #火把节的仪式感 #藏在火把节里 | (không có lời) |  |
| a0a5f0f0 | 23 | 假如你也似水仙花般临水自照便好. #古早味 | (không có lời) |  |
| e3de6322 | 30.2 | 回忆是一件容易掉眼泪的事 #过敏 #翻唱 | 我敏感的神经线，一天一天没知觉，泛红双眼不成眠。他跟着我一整夜，麻痹的脸，他笑摇曳无解。 | Dây thần kinh nhạy cảm của tôi, ngày qua ngày mất đi cảm giác, đôi mắt đỏ hoe không thể ngủ. Nó đi theo tôi suốt cả đêm, khuôn mặt tê dại, nó cười đung đưa khôn |
| a502d763 | 8 | 想回到你身边 #回到你身边 | 想回到你身边，对你说声“sorry.  | Muốn về bên bạn, xin lỗi nhé. |
| f6358794 | 30.2 | 《名归名·红之章》 万木生春厂牌出道作品 万木生春是由我和@草帽小蔡 以及@AI | 本台消息，近日我市渝中江北多个路段接连发生不明破坏，监控显示一名蒙面女子屡次独自出现在事发现场。嗨我说什么来着，叫你低调点，还不叫人监控拍着了，搁不出大麻烦了吗？知道啦，你知道个嘛知道的，天天放着你那月薪3000的活不干，就想着除魔卫道，有 | Tin mới, nhiều tuyến đường liên tiếp bị phá hoại. |
| 8c35e580 | 17.4 | 万圣节我就扮演银行卡 这样你们的钱都可以存我这#嘉桐摇 | Let's go.  | Đi thôi. |
| adf10583 | 24.1 | 不愧是驯龙高手取景地#法罗群岛 #驯龙高手 |  pero si nada dime que lo que pasa yo quiero deserme contigo pap perd el control contigo pap dime dime yo teigo papi. ay | Quả là bối cảnh Bí Kíp Luyện Rồng |
| c4cc4c0a | 11.3 | 这首歌的频率太快了，就像逝去的青春，眨眼间闲散 | 嗯。 | Ừm. |
| 5c843f1b | 30.2 | 其实这首歌最开始是在钢琴上写的🙈❤️ 是不是跟现在科幻感的版本非常不一样🤓  | 自由是逃离这全世界，到你身边，自由的放掉整个世界，一路荒野。你是我的地平线，不只为你发言。自由是与你浪迹的天，不惧危险。 | Tự do là bỏ lại thế giới, đến bên em, mặc kệ hoang vu. Anh là chân trời của em, không chỉ vì anh lên tiếng. Tự do là phiêu du cùng anh, chẳng sợ hiểm nguy. |
| f5cba22e | 10.5 | 本世纪最伟大的前奏 | (không có lời) |  |
| 73f2ea1a | 27.1 | 《我的妹妹不可爱》第九集 千禧年非主流纯爱玄幻原创大片 @林一一 熬了无数个大夜 | 依依，你快说，永远都不会离开我。你还没说呢。嗯，依依永远都不会离开哥哥的。你发誓？我发誓，依依永远都不会离开哥哥的。为啥不说我？都一样嘛，反正。 | Y Y, nói đi, sẽ không bao giờ rời xa anh. Em chưa nói mà. Ừ, Y Y sẽ mãi không rời xa anh. Thề đi? Em thề, Y Y không bao giờ rời xa anh. Sao không nhắc đến em? C |
| 0e5094c7 | 12.1 | 至美至疯摩羯女 #摩羯 #对口型 #fyp #摩羯女 #红发 | 我不会怪你，天空的光芒，太阳的光。 | Em không trách anh đâu |
| ebe9dce8 | 25.9 | 刚开始修炼，离成仙还有一大半 #难解 #敦煌舞蹈 #灵溪舞蹈姐妹花 | 今生的约定，有亏欠，前世不见，今生不见。 | Hẹn thề kiếp này, nợ duyên chưa dứt. |
| c0fda5c0 | 18.5 | 《瑞草学院捉鬼师》 1-6集 30分钟纯享版 #瑞草学院捉鬼师 #苗疆少女 #即 | 我叫龙央，苗疆龙氏第19代捉鬼师。奶奶算到这所学校有怨气，派我还有他奶奶10年前在韩国收养的师弟龙舟一起来捉鬼。 | Tôi là Long Ư央, pháp sư đời 19. |
| 0133088e | 12.9 |  | 觉得激动，便来捧上了花蜜，便独醉。活着是为了找目标，来游戏。害怕孤独，便团聚。怕过于迫切，便离开。 | Xúc động dâng trào, dâng mật hoa, rồi say sưa. Sống là để tìm mục đích, để chơi đùa. Sợ cô đơn nên tụ họp. Sợ vội vã nên rời đi. |

## Dịch thử (Gemini) theo từng câu, 5 mẫu đầu có bản dịch

### e1c6ec54 (ASR: funasr, 1162 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0.3–2.6 s | 恋人怀中。 | Trong lòng người yêu. |

### 8d51f8a5 (ASR: funasr, 4021 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 1.4–10.8 s | 爱是种爱是种爱是种爱是种爱是种爱是种。 | Tình yêu là thế |

### 6a2fcead (ASR: funasr, 1519 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 1.2–18.1 s | 是我爱的太蠢，太过天真，才会把你的寂寞当做契合的灵魂。也是我自作自受，竟然那么认真相信你。多轻浮的在爱的世界，你好像还没弄懂。 | Yêu quá ngây thơ, tưởng hồn hai đứa hợp nhau. |

### 07f385c9 (ASR: funasr, 1005 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0.2–15.9 s | Girl right we wanna freak out have a good time. ladies come raise your hands. show me where all my fans come to the club warm hear bigj put the base up. | Quẩy lên nào mọi người! |

### 10f57ac8 (ASR: funasr, 877 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 7–7.6 s | 嗯。 | Ừm. |


"Lệch so với funasr" = trung vị tỉ lệ ký tự khác nhau so với dịch vụ mốc; chỉ để tham khảo khi chưa có đáp án, không phải độ chính xác.

CER = tỉ lệ lỗi ký tự so với đáp án (bỏ dấu câu, khoảng trắng). "Nghi bịa chữ" = quá 12 chữ/giây hoặc lặp một cụm ≥ 4 lần.

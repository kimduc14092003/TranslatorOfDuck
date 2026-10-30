# Báo cáo S3/S4: nhận dạng giọng nói

Mẫu: 39, mỗi mẫu tối đa 30 s. Đáp án có ở 0 mẫu.

| Provider | Model | OK / lỗi | Độ trễ p50 / p95 (ms) | Nhanh hơn thời gian thực | Có lời | Có mốc theo từ | Nghi bịa chữ | CER trung bình / trung vị | Lệch so với gemini |
|---|---|---|---|---|---|---|---|---|---|
| gemini | gemini-3.5-flash-lite | 39 / 0 | 2535 / 5420 | 6× | 10/39 | 0/39 | 1 | – / – (n=0) | mốc |

## Từng mẫu

| Mẫu | Giây | Mô tả video | Lời nói (Trung) | Bản dịch (Việt) |
|---|---|---|---|---|
| e1c6ec54 | 7.6 | 请求支援… #迪迦奥特曼 #迪迦 #基里艾洛德人 #基里艾洛德人二代 #心动名场 | (chưa chạy) |  |
| 8d51f8a5 | 12.2 | 风虽大，都绕过我的灵魂 | (chưa chạy) |  |
| 6a2fcead | 18.3 | #清空 #翻唱 | (chưa chạy) |  |
| 07f385c9 | 20.1 | 🕶️❤️‍🔥 | (chưa chạy) |  |
| 10f57ac8 | 13 | #harrypotter #Blonde#hogwarts | (chưa chạy) |  |
| 340404f5 | 22.7 | 《校花的贴身道士》第1~3集 纯享版 一次看爽！#道士 #AI #校花的贴身道士 | 学功夫，练武术。师傅教你扎马步。天天扎马步。师傅你不靠！师傅！师傅你人呢？ | Học kung fu, / luyện võ thuật. / Thầy dạy tấn tấn. / Ngày ngày tấn. / Thầy ơi, / Thầy ơi! Thầy đâu rồi? |
| b8e7843c | 14.1 | 你很强 可惜遇到的是我们 | (chưa chạy) |  |
| 632a2d4e | 9.2 | 人真的好奇怪 突然爱 又突然不爱 #氛围感女主 #破碎感美学 #寂静岭雾 | (chưa chạy) |  |
| 6008c25c | 21.3 | 可我的性格总让我感觉亏欠 #对口型 #沦陷 | (chưa chạy) |  |
| 3107deac | 30.2 | 今天是体验干员日常的一天！ #三角洲干员漫展派对#三角洲行动redland #R | 体验设备慢慢打卡的一天，然后来体验干员的日常生活，待会儿要和猪头乐队的朋友们一起。刚才什么周边没有拿到？我帮人代一张。啊，你还要帮人代一张？我就一三六七。 | Trải nghiệm thiết bị, check-in từ từ, rồi trải nghiệm đời thường của đặc vụ. Lát nữa sẽ gặp bạn bè ban nhạc Pig Head. / Vừa nãy không nhận được merchandise nào  |
| 26779d1a | 30.2 | 杨戬、哪吒、孙悟空、杨清玄进入北冥，却发现鲲鹏正在被朱厌捕杀 #杨戬 #哪吒 # | 一路往北,按理来说,此地应当就是北冥寒境。二哥,至于怎么能长这么大?不是羽,是坤。北冥有鱼,其名为坤,化而为鸟,其名为鹏,究其何。可怕的凶兽,居然有能力捕猎坤鹏。又来 了几个送死的。加速行军,找这个进程,不出半日即刻。 | Càng đi về bắc,đây hẳn là Bắc Minh. / Nhị ca,sao nó to thế nhỉ? / Không phải Côn,là Khôn. / Bắc Minh có cá,tên là Khôn hóa thành chim tên là Bằng. / Hung thú đá |
| 3fd1bee2 | 18.1 | 胜方结算画面 #王者荣耀 #爱的主打歌运镜 #一镜到底#王者IP创作团 | 非死不可。好机会。落花战令。替你点根蜡。大明境是需要付出代价的。念念不忘。必有回响。 | Bất tử. / Cơ hội tốt. / Lạc Hoa Chiến Lệnh. / Thắp nến cho bạn. / Đại Minh Cảnh phải trả giá. / Vương vấn. / Ắt có hồi âm. |
| d85a974c | 12.6 | 你的呼吸像雨滴渗入我的爱里 | (chưa chạy) |  |
| 9acae20d | 14.3 | 你和月亮有一个共同点 #Lili百合乡 | (chưa chạy) |  |
| b744d6a8 | 7.6 | 2026年热播歌曲合集#音乐分享 #海屿你 #潮汐 #热播歌曲#茶汤 | (chưa chạy) |  |
| 25c5095f | 30.2 | IG夺冠之路第一章：“宁王的弱势打野” 四月份还在令他暴怒的弱势英雄，十一月份直 | 头号种子,拿个世锦赛冠军,他妈的怎么怎么怎么怎么扎个流感针,就容易被狙击,学什么怪都不学,把把选个弱势妲己,什么比赛都选弱势妲己,然后怎么也说怪都不说。此视频拍摄于2018年4月,18连胜的IG在季后赛折戟四强,回到休息室的宁王瞬间暴怒,直 | Đánh bại mọi đối thủ, vô địch thế giới, sao lại tiêm vaccine xong dễ bị nhắm đến, chọn toàn tướng yếu thế, đánh trận nào cũng vậy, mà không ai nói gì. / Tháng 4 |
| fbea5e36 | 13.4 | 喵～ #手势舞 #喵 #阿里嘎多 | (chưa chạy) |  |
| 1b025f04 | 9.5 | 🧑‍🍳 #backseat #手势舞 | (chưa chạy) |  |
| 64283fce | 21.6 | #飞天小麻花 看到我的起手式，你会心动吗 #枪 | (chưa chạy) |  |
| 359ea750 | 17.3 | 少女心事 #hotdog热狗很辣 | (chưa chạy) |  |
| 6a8d5f88 | 7.9 | #郑志杰 #泳池正常穿搭拍摄 | (chưa chạy) |  |
| 41cb77e2 | 30.2 | 《醉醉酒店》1-8优化版/一口气看到爽，老粉可从16：26看 #即梦ai#末世囤 | 木日的第三年，我开了一家度假酒店。可是这都开两年了，怎么一个客人都没有。终于来客了。你撸着干仅什么？客人不用担心，他们进不来的。怎么可能？你还生活在端话世界里吗？要死也别挺巧我。放心吧，在我店里你死不了的。熊熊也也也，去，把门打开。好的主人 | Mạt thế năm thứ 3, tôi mở khách sạn. / Mở 2 năm rồi mà sao chẳng có khách. / Cuối cùng có khách. / Anh run rẩy cái gì? / Đừng lo, họ không vào được đâu. / Sao t |
| 32e215da | 30.2 | 三角洲剪辑教学，学会了没！ #一条小团团ovo #三角洲行动 | 暴击时刻怎么剪？我这个就可以教你们一下了。就是剪这种击杀时刻的时候可以稍微的加个速。再加那个动态模糊。然后再再抽真。漂亮。哎呀我的妈呀。再加个那个什么停顿停顿。对,再加停顿,你看我不用花花绳,一瞬间快速度下降,你知道吧？好。然后再顿。 | Edit khoảnh khắc chí mạng? / Để mình chỉ các bạn nhé. / Đoạn hạ địch có thể tua nhanh chút. / Thêm hiệu ứng mờ chuyển động. / Rồi chỉnh giật hình nghệ thuật. /  |
| 4a1b6d00 | 20 | 大师说我们缘浅 我说大师我加钱 #颜值就是最好的时尚单品#让你的照片更有秋日氛围 | (chưa chạy) |  |
| 521b1964 | 15.8 | #飞天小麻花 野火烧不尽 #青年创作者扶持计划 #火把节的仪式感 #藏在火把节里 | (chưa chạy) |  |
| a0a5f0f0 | 23 | 假如你也似水仙花般临水自照便好. #古早味 | (chưa chạy) |  |
| e3de6322 | 30.2 | 回忆是一件容易掉眼泪的事 #过敏 #翻唱 | (chưa chạy) |  |
| a502d763 | 8 | 想回到你身边 #回到你身边 | (chưa chạy) |  |
| f6358794 | 30.2 | 《名归名·红之章》 万木生春厂牌出道作品 万木生春是由我和@草帽小蔡 以及@AI | 近日我市禹钟尖北多格路段接连发生不明火灾,监控显示一名蒙面女子屡次独自出现在事发现场。害,我索什么来的,叫你蒂掉点,还不叫人监控派着了,各不戳大麻烦了嘛。知道了啦。你知道个嘛知道,天天放着你那月薪三千的活不干,就想找出摸味道。有那闲工夫抛抛 | Gần đây khu vực Vũ Chung Tiêm liên tiếp xảy ra hỏa hoạn, camera ghi lại một phụ nữ bịt mặt. / Haizz, bảo cô cẩn thận chút, giờ cảnh sát theo dõi rồi, rắc rối to |
| 8c35e580 | 17.4 | 万圣节我就扮演银行卡 这样你们的钱都可以存我这#嘉桐摇 | (chưa chạy) |  |
| adf10583 | 24.1 | 不愧是驯龙高手取景地#法罗群岛 #驯龙高手 | (chưa chạy) |  |
| c4cc4c0a | 11.3 | 这首歌的频率太快了，就像逝去的青春，眨眼间闲散 | (chưa chạy) |  |
| 5c843f1b | 30.2 | 其实这首歌最开始是在钢琴上写的🙈❤️ 是不是跟现在科幻感的版本非常不一样🤓  | (chưa chạy) |  |
| f5cba22e | 10.5 | 本世纪最伟大的前奏 | (chưa chạy) |  |
| 73f2ea1a | 27.1 | 《我的妹妹不可爱》第九集 千禧年非主流纯爱玄幻原创大片 @林一一 熬了无数个大夜 | 约，你快说。犹人都不会离开我。你还没说嘞。嗯，一永远都不会离开哥哥的。你发誓。我发誓一永远都不会离开哥哥的。为啥不说？我？长一样嘛。 | Đói à, nói đi chứ. / Do Du không bỏ anh đâu. / Cậu chưa nói kìa. / Ừ, Y sẽ mãi bên anh mà. / Thề đi. / Em thề sẽ mãi không rời anh. / Sao không nói? Tôi á? / Nh |
| 0e5094c7 | 12.1 | 至美至疯摩羯女 #摩羯 #对口型 #fyp #摩羯女 #红发 | (chưa chạy) |  |
| ebe9dce8 | 25.9 | 刚开始修炼，离成仙还有一大半 #难解 #敦煌舞蹈 #灵溪舞蹈姐妹花 | (chưa chạy) |  |
| c0fda5c0 | 18.5 | 《瑞草学院捉鬼师》 1-6集 30分钟纯享版 #瑞草学院捉鬼师 #苗疆少女 #即 | 我叫龙央，苗疆龙氏第19代捉鬼师。奶奶算到这所学校有怨气，派我，还有他。奶奶十年前在韩国收养的失地龙舟，一起拉捉鬼。 | Tôi là Long Ư央, pháp sư đời 19. / Trường có oán khí, tôi và cậu ấy được cử đến. / Long Chu được bà nhận nuôi ở Hàn chục năm trước. |
| 0133088e | 12.9 |  | (chưa chạy) |  |

## Dịch thử (Gemini) theo từng câu, 5 mẫu đầu có bản dịch

### 340404f5 (ASR: gemini, 1221 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0.2–0.4 s | 学功夫， | Học kung fu, |
| 1.2–1.5 s | 练武术。 | luyện võ thuật. |
| 2.2–3.7 s | 师傅教你扎马步。 | Thầy dạy tấn tấn. |
| 8–9.4 s | 天天扎马步。 | Ngày ngày tấn. |
| 10.4–10.6 s | 师傅你 | Thầy ơi, |
| 17.2–19.9 s | 不靠！师傅！师傅你人呢？ | Thầy ơi! Thầy đâu rồi? |

### 3107deac (ASR: gemini, 1350 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0–7 s | 体验设备慢慢打卡的一天，然后来体验干员的日常生活，待会儿要和猪头乐队的朋友们一起。 | Trải nghiệm thiết bị, check-in từ từ, rồi trải nghiệm đời thường của đặc vụ. Lát nữa sẽ gặp bạn bè ban nhạc Pig Head. |
| 23–25 s | 刚才什么周边没有拿到？ | Vừa nãy không nhận được merchandise nào à? |
| 26–27 s | 我帮人代一张。 | Tớ mua hộ người ta một tấm. |
| 27–28 s | 啊，你还要帮人代一张？ | Ể, cậu còn mua hộ người ta à? |
| 29–30 s | 我就一三六七。 | Tớ chỉ lấy 1, 3, 6, 7 thôi. |

### 26779d1a (ASR: gemini, 1424 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 1.4–5.5 s | 一路往北,按理来说,此地应当就是北冥寒境。 | Càng đi về bắc,đây hẳn là Bắc Minh. |
| 6.1–8 s | 二哥,至于怎么能长这么大? | Nhị ca,sao nó to thế nhỉ? |
| 8.8–9.9 s | 不是羽,是坤。 | Không phải Côn,là Khôn. |
| 10.1–15.7 s | 北冥有鱼,其名为坤,化而为鸟,其名为鹏,究其何。 | Bắc Minh có cá,tên là Khôn hóa thành chim tên là Bằng. |
| 16–18.3 s | 可怕的凶兽,居然有能力捕猎坤鹏。 | Hung thú đáng sợ,dám săn cả Côn Bằng. |
| 21.6–24 s | 又来 了几个送死的。 | Lại đến mấy kẻ chịu chết. |
| 26.2–29.8 s | 加速行军,找这个进程,不出半日即刻。 | Tăng tốc,tốc độ này nửa ngày là tới. |

### 3fd1bee2 (ASR: gemini, 1095 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0–1.5 s | 非死不可。 | Bất tử. |
| 2.1–2.8 s | 好机会。 | Cơ hội tốt. |
| 3–3.7 s | 落花战令。 | Lạc Hoa Chiến Lệnh. |
| 4.1–5.5 s | 替你点根蜡。 | Thắp nến cho bạn. |
| 5.9–8.5 s | 大明境是需要付出代价的。 | Đại Minh Cảnh phải trả giá. |
| 8.9–9.5 s | 念念不忘。 | Vương vấn. |
| 9.9–10.7 s | 必有回响。 | Ắt có hồi âm. |

### 25c5095f (ASR: gemini, 1555 ms)

| Thời gian | Trung | Việt |
|---|---|---|
| 0.4–12.3 s | 头号种子,拿个世锦赛冠军,他妈的怎么怎么怎么怎么扎个流感针,就容易被狙击,学什么怪都不学,把把选个弱势妲己,什么比赛都选弱势妲己,然后怎么也说怪都不说。 | Đánh bại mọi đối thủ, vô địch thế giới, sao lại tiêm vaccine xong dễ bị nhắm đến, chọn toàn tướng yếu thế, đánh trận nào cũng vậy, mà không ai nói gì. |
| 12.4–29.8 s | 此视频拍摄于2018年4月,18连胜的IG在季后赛折戟四强,回到休息室的宁王瞬间暴怒,直言自己每场比赛都是弱势打野,但此刻他并不知道,六个月之后的世界赛上,他的弱势打野扎克将带领IG开启夺冠之路。 | Tháng 4/2018, IG thua ở bán kết, về phòng nghỉ, Ning nổi giận vì luôn phải chơi rừng yếu thế. Sáu tháng sau, vị tướng Zac ấy sẽ đưa IG đến ngôi vương. |


"Lệch so với gemini" = trung vị tỉ lệ ký tự khác nhau so với dịch vụ mốc; chỉ để tham khảo khi chưa có đáp án, không phải độ chính xác.

CER = tỉ lệ lỗi ký tự so với đáp án (bỏ dấu câu, khoảng trắng). "Nghi bịa chữ" = quá 12 chữ/giây hoặc lặp một cụm ≥ 4 lần.

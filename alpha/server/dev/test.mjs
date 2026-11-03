// Kiểm tra nhanh các hàm thuần của pipeline (không cần key, không cần mạng). Chạy: npm test
// Kiểm thử toàn trình (extension + server + Douyin giả) nằm ở alpha/dev/e2e.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifySpeech, segmentCues, fixViText, splitSung, extractAudio, windowAsr, resplitSentences, speechBefore, lyricCues, isFiller } from '../pipeline.mjs';

const W = (text, start, end) => ({ text, start, end });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

t('tách câu theo dấu chấm và khoảng lặng', () => {
  const cues = segmentCues({ words: [W('大家', 1, 1.4), W('好，', 1.4, 1.6), W('今天', 1.7, 2), W('去', 2, 2.3), W('吃火锅。', 2.3, 3.1), W('走吧！', 5, 5.6)] });
  assert.equal(cues.length, 2);
  assert.equal(cues[0].zh, '大家好，今天去吃火锅。');
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.6);              // khoảng trống ≥ 1 s → hết lời + 0,5 s
  assert.equal(cues[1].start, 5);
});
t('câu dài quá 16 chữ Hán được cắt ở dấu phẩy', () => {
  const ws = '我们今天一起去，那个很远的地方看看风景吧'.match(/.，?/gu).map((ch, i) => W(ch, i * 0.25, i * 0.25 + 0.24));
  const cues = segmentCues({ words: ws });
  assert.ok(cues.length >= 2);
  assert.ok(cues[0].zh.endsWith('，'));
  for (const c of cues) assert.ok(c.end - c.start <= 7.5);
});
t('câu sát nhau: dòng trước kết thúc trước dòng sau 2 khung hình', () => {
  const cues = segmentCues({ words: [W('你好。', 0, 1.2), W('再见。', 1.4, 2.6)] });
  assert.equal(cues.length, 2);
  assert.ok(Math.abs(cues[0].end - (1.4 - 2 / 30)) < 0.002);
});
t('không có từ thì dùng câu (Gemini)', () => {
  const cues = segmentCues({ segments: [{ start: 0.5, end: 2, text: '你好。' }] });
  assert.deepEqual(cues.map(c => c.zh), ['你好。']);
});
t('nhận ra lời nói / tiếng hát / không có lời', () => {
  const speech = { text: '大家好今天我们去吃火锅', words: Array.from('大家好今天我们去吃火锅').map((c, i) => W(c, i * 0.2, i * 0.2 + 0.18)) };
  assert.equal(classifySpeech({ desc: '' }, speech).label, 'speech');
  const song = { text: '自由是逃离这全世界', words: Array.from('自由是逃离这全世界').map((c, i) => W(c, i * 0.6, i * 0.6 + 0.55)) };
  assert.equal(classifySpeech({ desc: '#翻唱' }, song).label, 'singing');
  assert.equal(classifySpeech({}, { text: '', words: [] }).label, 'no_speech');
});
// Trước đây dưới 4 chữ Hán là "quá ít lời", bỏ cả đoạn (đo 3/11 trên Douyin thật: thoại tiếng Nhật 断る。帰れ。てめえ死にてえのか。
// chỉ có 3 chữ Hán, mất cả ba câu). Lời ngắn có thể là lời quan trọng: vẫn dịch. Chỉ không có chữ nào mới là không có lời.
t('lời rất ngắn, lời toàn kana hay chữ Hàn vẫn là lời nói; chỉ dấu câu là không có lời', () => {
  const w = (text, per = 0.2) => ({ text, words: Array.from(text.replace(/[。，！？]/g, '')).map((c, i) => W(c, i * per, i * per + per - 0.02)) });
  assert.equal(classifySpeech({}, w('好。')).label, 'speech');
  assert.equal(classifySpeech({}, w('断る。帰れ。てめえ死にてえのか。')).label, 'speech');
  assert.equal(classifySpeech({}, w('そう。')).label, 'speech');
  assert.equal(classifySpeech({}, w('사랑해요.')).label, 'speech');
  assert.equal(classifySpeech({}, { text: '。', words: [] }).label, 'no_speech');
  // Một từ tiếng Anh trong câu tiếng Nhật, tiếng Hàn ngắn: vẫn là lời nói, không phải "không phải tiếng Trung".
  assert.equal(classifySpeech({}, w('OKだ、行くぞ。')).label, 'speech');
  assert.equal(classifySpeech({}, w('사랑해요, 진짜 baby.')).label, 'speech');
});
// Lời ngắn tới được segmentCues nhiều hơn (verifier 3/11): một chữ mà ASR cho kéo dài tới cuối âm thanh (そう。 25 s), và
// dòng một từ rồi một từ dài quá 7 s (cutPoint đọc ws[-1], đoạn báo lỗi mãi).
t('dòng ít chữ mà ASR cho kéo dài quá lâu: không đứng trên màn hình hàng chục giây; dòng một từ không làm lỗi', () => {
  const [c] = segmentCues({ words: [W('そう。', 510.9, 536.0)] });
  assert.ok(c.end - c.start <= 3.5 && c.se - c.start <= 3, JSON.stringify(c));
  assert.doesNotThrow(() => segmentCues({ words: [W('そ', 0, 1), W('う', 1.1, 9)] }));
  assert.deepEqual(segmentCues({ words: [W('爱', 0, 0.5), W('你。', 0.55, 9)] }).map(c => c.zh), ['爱你。']);
  // Câu dài nhiều chữ mà ASR chỉ có mốc cả câu (Gemini): giữ nguyên.
  const [g] = segmentCues({ segments: [{ start: 0, end: 10, text: '我们今天一起去那个很远的地方看看风景然后再回来吃饭睡觉。' }] });
  assert.ok(g.se >= 10, JSON.stringify(g));
});
t('vlog có một câu hát: chỉ bỏ câu hát, giữ câu nói', () => {
  const talk1 = Array.from('今天我们来到了稻城亚丁').map((c, i) => W(c, 0.2 + i * 0.2, 0.38 + i * 0.2));
  const sing = Array.from('自由是逃离这全世界').map((c, i) => W(c, 5 + i * 0.6, 5.55 + i * 0.6));
  const talk2 = Array.from('这里的风景真的太美了').map((c, i) => W(c, 12 + i * 0.2, 12.18 + i * 0.2));
  const r = { text: '今天我们来到了稻城亚丁自由是逃离这全世界这里的风景真的太美了', words: [...talk1, ...sing, ...talk2], segments: [
    { start: 0.2, end: 2.6, text: '今天我们来到了稻城亚丁' }, { start: 5, end: 10.4, text: '自由是逃离这全世界' }, { start: 12, end: 14, text: '这里的风景真的太美了' }] };
  const s = splitSung(r);
  assert.equal(s.total, 3);
  assert.equal(s.sung, 1);
  assert.equal(s.r.text, '今天我们来到了稻城亚丁这里的风景真的太美了');
  assert.ok(segmentCues(s.r).every(c => !c.zh.includes('自由')));
});
t('chế độ lời bài hát, vlog có một câu hát: chỉ dòng hát được đánh dấu sung, dòng nói giữ nguyên', () => {
  // Câu nói 0,2 s/chữ, rồi một câu hát 0,6 s/chữ (như vlog có đoạn hát theo nhạc nền).
  const words = [W('今天', 0, 0.4), W('我们', 0.4, 0.8), W('去', 0.8, 1.0), W('吃', 1.0, 1.2), W('火锅。', 1.2, 1.6),
    W('月', 3, 3.6), W('亮', 3.6, 4.2), W('代', 4.2, 4.8), W('表', 4.8, 5.4), W('我', 5.4, 6), W('的', 6, 6.6), W('心。', 6.6, 7.2)];
  const r = { text: '今天我们去吃火锅。月亮代表我的心。', segments: [{ start: 0, end: 1.6, text: '今天我们去吃火锅。' }, { start: 3, end: 7.2, text: '月亮代表我的心。' }], words };
  const cues = lyricCues(r, { label: 'speech' }, splitSung(r));
  assert.deepEqual(cues.map(c => [c.zh, c.sung]), [['今天我们去吃火锅。', false], ['月亮代表我的心。', true]]);
});
t('chế độ lời bài hát: dòng hát chỉ có tiếng đệm (kể cả ASR ghi bằng chữ Latin) thì bỏ, dòng có lời thì giữ', () => {
  for (const zh of ['耶耶耶耶。', 'yeah yeah', 'Oh, oh, oh!', 'lalala', '啦啦啦 la la', 'ooh~', 'Ｙｅａｈ ｙｅａｈ', 'uh huh', 'yeahyeah']) assert.ok(isFiller(zh), zh);
  for (const zh of ['我爱你', 'I love you', 'oh baby', 'mama', '耶 love you', '2025', '', 'oh no', '哈哈 so funny']) assert.ok(!isFiller(zh), zh);
  const t0 = Date.now(); isFiller('o'.repeat(5000) + '!' + 'oh'.repeat(3000) + 'x');
  assert.ok(Date.now() - t0 < 200, 'chuỗi dài không làm biểu thức chạy lâu');
});
t('chế độ lời bài hát: dòng nói rất ngắn bị gộp vào dòng hát ngay sau vẫn là dòng hát (♪); dòng chữ Latin chỉ có tiếng đệm bị bỏ dù không hát', () => {
  // "好。" 0,3 s rồi câu hát 0,6 s/chữ: segmentCues gộp hai câu thành một dòng bắt đầu trong câu nói. Trước đây chỉ xét
  // mốc bắt đầu nên dòng gộp mất ♪ (đợt soát 31/10). Sau đó "yeah yeah" nói nhanh: không phải câu hát (splitSung chỉ đếm
  // chữ Hán) nhưng chỉ là tiếng đệm.
  const song = '月亮代表我的心。'.split('').filter(ch => ch !== '。');
  const words = [W('好。', 0, 0.3), ...song.map((ch, i) => W(ch + (i === song.length - 1 ? '。' : ''), 0.5 + 0.6 * i, 1.1 + 0.6 * i)),
    W('yeah', 6, 6.3), W('yeah。', 6.3, 6.6)];
  const r = { text: '好。月亮代表我的心。yeahyeah。', words,
    segments: [{ start: 0, end: 0.3, text: '好。' }, { start: 0.5, end: 4.7, text: '月亮代表我的心。' }, { start: 6, end: 6.6, text: 'yeahyeah。' }] };
  const cues = lyricCues(r, { label: 'speech' }, splitSung(r));
  assert.deepEqual(cues.map(c => [c.zh, c.sung]), [['好。月亮代表我的心。', true]]);
});
t('chế độ lời bài hát, đoạn cả bài: câu nói nhanh (≥ 3 chữ Hán, ≤ 0,20 s/chữ) không có ♪; câu hát, câu hát nhanh 0,24 s/chữ và câu 2 chữ vẫn có ♪', () => {
  // Đo trên Douyin thật, lô 2 (HANDOFF §6n): người hát rong hỏi "可以吗？可以吗？" (0,18–0,20 s/chữ) giữa đoạn cả bài.
  // Dòng hát nhanh nhất trong đoạn cả bài ở lô 2 là 0,24–0,25 s/chữ; câu 2 chữ ("好的。") quá ngắn để kết luận.
  const han = (x) => Array.from(x).filter(ch => !/[，。？]/.test(ch));
  const parts = [['可以吗？', 0, 0.18], ['你愿意吗？', 2, 0.2], ['月亮代表我的心。', 4, 0.6], ['你问我爱你有多深。', 10, 0.24], ['好的。', 14, 0.15], ['轻轻的一个吻。', 16, 0.6]];
  const words = parts.flatMap(([x, at, per]) => han(x).map((ch, i, a) => W(ch + (i === a.length - 1 ? x.at(-1) : ''), at + i * per, at + (i + 1) * per)));
  const segments = parts.map(([x, at, per]) => ({ start: at, end: +(at + han(x).length * per).toFixed(3), text: x }));
  const r = { text: parts.map(p => p[0]).join(''), words, segments };
  const cues = lyricCues(r, { label: 'singing' }, splitSung(r));
  assert.deepEqual(cues.map(c => [c.zh, c.sung]), [['可以吗？', false], ['你愿意吗？', false], ['月亮代表我的心。', true], ['你问我爱你有多深。', true], ['好的。', true], ['轻轻的一个吻。', true]]);
  // Đoạn không phải cả bài: như cũ, chỉ câu hát có ♪.
  assert.deepEqual(lyricCues(r, { label: 'speech' }, splitSung(r)).map(c => c.sung), [false, false, true, false, false, true]);
});
t('… đoạn cả bài: dòng quá nửa nằm trong câu hát vẫn có ♪; câu của dòng là câu trùng nhiều nhất, không phải câu đầu; tiếng đệm nói nhanh vẫn bị bỏ', () => {
  const han = (x) => Array.from(x).filter(ch => !/[，。？]/.test(ch));
  // (1) Một dòng gộp ba câu: câu nói nhanh 8 chữ (1,44 s) rồi hai câu hát 4 chữ (mỗi câu 1,36 s). Câu trùng nhiều nhất là
  // câu nói, nhưng 65% thời gian của dòng nằm trong câu hát. (2) Một dòng gộp "好的，" (2 chữ, không đủ để là câu nói
  // nhanh) với câu nói nhanh 9 chữ: câu của dòng là câu 9 chữ. (3) "哈哈哈哈。" 0,15 s/chữ là tiếng đệm.
  const parts = [['我们今天一起来唱，', 0, 0.18], ['月亮代表', 1.44, 0.34], ['我的心呀。', 2.8, 0.34],
    ['好的，', 6.5, 0.15], ['可以吗可以吗可以吗。', 6.8, 0.18], ['哈哈哈哈。', 10, 0.15]];
  const punct = (x) => (/[，。？]$/.test(x) ? x.at(-1) : '');
  const words = parts.flatMap(([x, at, per]) => han(x).map((ch, i, a) => W(ch + (i === a.length - 1 ? punct(x) : ''), at + i * per, at + (i + 1) * per)));
  const segments = parts.map(([x, at, per]) => ({ start: at, end: +(at + han(x).length * per).toFixed(3), text: x }));
  const r = { text: parts.map(p => p[0]).join(''), words, segments };
  const cues = lyricCues(r, { label: 'singing' }, splitSung(r));
  assert.deepEqual(cues.map(c => [c.zh, c.sung]), [['我们今天一起来唱，月亮代表我的心呀。', true], ['好的，可以吗可以吗可以吗。', false]]);
});
t('đoạn video dài: đổi về thời gian video, chỉ giữ câu bắt đầu trong đoạn', () => {
  // Âm thanh của đoạn [20, 50) bắt đầu ở 18,5 s; câu đầu (0,5 s → 19,0 s) thuộc đoạn trước.
  const r = { text: '甲乙丙丁。戊己庚辛。', segments: [{ start: 0.5, end: 2, text: '甲乙丙丁。' }, { start: 3, end: 5, text: '戊己庚辛。' }],
    words: [W('甲乙', 0.5, 1), W('丙丁。', 1, 2), W('戊己', 3, 4), W('庚辛。', 4, 5)] };
  const w = windowAsr(r, 18.5, 20, 50);
  assert.deepEqual(w.segments.map(x => [x.start, x.text]), [[21.5, '戊己庚辛。']]);
  assert.deepEqual(w.words.map(x => x.start), [21.5, 22.5]);
  assert.equal(w.text, '戊己庚辛。');
  const cues = segmentCues(w);
  assert.equal(cues[0].start, 21.5);
  assert.equal(cues[0].se, 23.5);
});
t('vừa tua tới (gửi dư 8 s): giữ câu vắt qua đầu đoạn, lời trước đó làm mạch câu', () => {
  // Âm thanh của đoạn [20, 50) bắt đầu ở 12 s. Câu 1 (12,2–14 s) ở sát đầu phần gửi dư: bỏ. Câu 2 (15–17 s) nằm trọn
  // trước đoạn: làm mạch câu. Câu 3 (18–21 s) vắt qua đầu đoạn: giữ (đoạn trước chưa dịch thì không ai hiện câu này).
  const r = { text: '', segments: [{ start: 0.2, end: 2, text: '甲乙。' }, { start: 3, end: 5, text: '丙丁。' },
    { start: 6, end: 9, text: '戊己庚。' }, { start: 10, end: 12, text: '辛壬。' }], words: [] };
  assert.deepEqual(windowAsr(r, 12, 20, 50, true).segments.map(x => x.text), ['戊己庚。', '辛壬。']);
  assert.deepEqual(windowAsr(r, 12, 20, 50).segments.map(x => x.text), ['辛壬。']);   // phát liền mạch: như cũ
  assert.deepEqual(speechBefore(r, 12, 20), ['丙丁。']);
});
t('Fun-ASR trả cả đoạn thành một câu: chia lại theo từ, đoạn sau vẫn có lời', () => {
  // Như đoạn [20, 50) của một vlog thật: âm thanh bắt đầu ở 18,5 s, "câu" duy nhất bắt đầu ở 0,1 s (18,6 s).
  const words = [W('还剩', 0.1, 0.6), W('五块。', 0.6, 1.2), W('早啊，', 6.3, 6.6), W('朋友们！', 6.6, 7.1),
    W('到了', 9.4, 9.7), W('发生活费', 9.8, 10.7), W('的时间', 10.7, 11.3), W('了哈！', 11.3, 11.7),
    ...Array.from('我分三轮拍卖每一轮付钱最多的得到生活费其他人付过的钱不退回').map((c, i) => W(c, 12 + i * 0.2, 12.18 + i * 0.2))];
  const r = { provider: 'funasr', text: words.map(w => w.text).join(''), segments: [{ start: 0.1, end: 17.6, text: words.map(w => w.text).join('') }], words };
  // Trước khi chia lại theo từ: mất cả đoạn. Từ 3/11 windowAsr giữ phần từ đầu đoạn của câu vắt qua quá 2,5 s.
  assert.ok(windowAsr(r, 18.5, 20, 50).segments[0].start >= 20);
  const s = resplitSentences(r);
  assert.deepEqual(s.segments.map(x => x.text).slice(0, 3), ['还剩五块。', '早啊，朋友们！', '到了发生活费的时间了哈！']);
  assert.ok(s.segments.every(x => x.end - x.start <= 12));
  const w = windowAsr(s, 18.5, 20, 50);
  assert.equal(w.segments[0].start, 24.8);                             // câu "还剩五块。" (18,6 s) thuộc đoạn trước
  assert.ok(w.text.includes('朋友们') && w.text.includes('不退回'));
  const sp = splitSung(w);
  assert.equal(sp.sung, 0);
  assert.equal(classifySpeech({}, w).label, 'speech');
});
// Đo 3/11 trên Douyin thật (video BLG, đoạn [10, 20) gửi âm thanh từ 5,5 s): model nhận dạng dự phòng có lúc trả cả đoạn
// không một dấu câu. resplitSentences chỉ cắt được theo khoảng lặng và mốc 12 s, nên câu đầu thành 5,6–17,6 s: bắt đầu trước
// đoạn nên bị bỏ, mà đoạn trước chỉ có âm thanh tới 12 s. Lời 12–17,6 s không thuộc đoạn nào: đoạn chỉ còn 1 câu.
t('câu không dấu câu vắt qua đầu đoạn quá phần đoạn trước nghe được: giữ phần từ đầu đoạn', () => {
  const text = '哇这玩意儿太大了吧我现在正好就在标记基地门口必须带大家检查一下他们赛的备战情况如何走哇好可爱的布鲁鲁芝麻开门哦这还是我第一次来标记基地呢呀参观一下我们去寻找一下';
  const words = Array.from(text).map((c, i) => W(c, 0.1 + i * 0.3, 0.38 + i * 0.3));
  const r = resplitSentences({ provider: 'funasr', text, segments: [{ start: 0.1, end: 20.5, text }], words });
  const w = windowAsr(r, 5.503, 10, 20, true);
  const want = words.map(x => ({ ...x, start: x.start + 5.503 })).filter(x => x.start >= 10).length;   // câu sau bắt đầu trong đoạn: giữ cả câu
  assert.ok(w.segments[0].start >= 10 && w.segments[0].start < 10.4, JSON.stringify(w.segments.map(x => [x.start, x.end])));
  assert.equal(w.words.length, want);
  // Câu có dấu câu vắt qua đầu đoạn ít (đoạn trước đã nghe gần hết): như cũ, thuộc đoạn trước.
  const r2 = { text: '甲乙丙丁戊己。', segments: [{ start: 0.5, end: 3, text: '甲乙丙丁戊己。' }],
    words: [W('甲乙丙', 0.5, 1.5), W('丁戊己。', 1.5, 3)] };
  assert.equal(windowAsr(r2, 18.5, 20, 50).segments.length, 0);
});
t('số và tiếng cười không bị coi là lời hát lặp', () => {
  const speech = (text) => ({ text, words: [], segments: [{ start: 0, end: 3, text }] });
  assert.equal(splitSung({ ...speech('我们还将乘坐票价25000美元的私人飞机'), words: [W('我们', 0, 0.3)] }).sung, 0);
  assert.equal(splitSung({ ...speech('哈哈哈哈哈，对对对，太好吃了'), words: [W('哈哈', 0, 0.3)] }).sung, 0);
  assert.equal(classifySpeech({}, { text: '哈哈哈哈哈哈哈哈这个100000块钱' }).repeat, false);
  assert.equal(splitSung({ ...speech('爱你爱你爱你'), words: [W('爱你', 0, 1.2)] }).sung, 1);   // điệp khúc thật (hát chậm) vẫn bị lọc
});
t('nói nhấn mạnh lặp lời ở tốc độ nói: không phải hát, không bỏ cả đoạn', () => {
  // Vlog thật: cả đoạn 30 s từng bị bỏ là "bài hát" vì "投降了，投降了，投降了，投降了" và "完了完了完了完了".
  const lines = ['我给你们提示，一共10个字。', '算了，投降了，投降了，投降了，投降了。', '哎呦，我完了完了完了完了完了。'];
  let t0 = 0;
  const words = lines.flatMap((l) => { const ws = Array.from(l).map((c, i) => W(c, t0 + i * 0.15, t0 + i * 0.15 + 0.14)); t0 += l.length * 0.15 + 1; return ws; });
  const r = resplitSentences({ text: '', words, segments: [] });
  const cls = classifySpeech({}, r);
  assert.equal(cls.repeat, true);
  assert.equal(cls.label, 'speech');
  assert.equal(splitSung(r).sung, 0);
  // Cũng những câu đó mà hát (0,6 s/chữ) thì vẫn là hát.
  const slow = resplitSentences({ text: '', words: Array.from('投降了投降了投降了投降了').map((c, i) => W(c, i * 0.6, i * 0.6 + 0.55)), segments: [] });
  assert.equal(classifySpeech({}, slow).label, 'singing');
});
t('vlog có hashtag nhạc, nói thưa: không bỏ cả đoạn', () => {
  // Nói tốc độ thường (0,2 s/chữ) nhưng nhiều khoảng lặng → cps thấp; hashtag có chữ "歌".
  const words = ['今天带大家去', '看看这家店', '真的很好吃', '下次还来'].flatMap((p, k) => Array.from(p).map((c, i) => W(c, k * 8 + i * 0.2, k * 8 + i * 0.2 + 0.18)));
  const r = resplitSentences({ text: '', words, segments: [] });
  const cls = classifySpeech({ hashtags: ['#唱歌'] }, r);
  assert.ok(cls.cps < 2.5 && cls.tagMusic && cls.medCharDur <= 0.33);
  const sp = splitSung(r);
  assert.ok(!(cls.repeat || sp.sung * 2 > sp.total || (cls.tagMusic && cls.medCharDur > 0.33)));
});
t('sửa khoảng trắng câu tiếng Việt', () => {
  assert.equal(fixViText('  Chào  cả nhà ,hôm nay đi ăn lẩu . '), 'Chào cả nhà, hôm nay đi ăn lẩu.');
});
// Track âm thanh bắt đầu muộn 0,4 s so với video (edit list): âm thanh tách ra phải giữ đúng khoảng đó,
// không thì sub hiện sớm hơn lời nói.
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-test-'));
try {
  const f = (name) => path.join(dir, name);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3,adelay=1000|1000',
    '-t', '6', '-c:v', 'libx264', '-c:a', 'aac', f('a.mp4')]);
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', f('a.mp4'), '-itsoffset', '0.4', '-i', f('a.mp4'), '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movflags', '+faststart', f('b.mp4')]);
  const audio = await extractAudio(fs.readFileSync(f('b.mp4')));
  fs.writeFileSync(f('o.mp3'), audio.mp3);
  const log = spawnSync(ffmpeg, ['-i', f('o.mp3'), '-af', 'silencedetect=n=-30dB:d=0.2', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  t('âm thanh bắt đầu muộn: giữ đúng mốc thời gian', () => {
    const onset = Number((/silence_end: ([\d.]+)/.exec(log) || [])[1]);
    assert.ok(Math.abs(onset - 1.4) < 0.08, 'tiếng bắt đầu ở ' + onset + ' s, cần ≈ 1,4 s');
  });
  // no_audio được cache mãi: chỉ trả khi video thật sự không có tiếng. File hỏng thì báo lỗi (lần sau thử lại);
  // file cắt ngắn (đầu video, ffmpeg báo lỗi ở cuối) vẫn dùng phần đã tách.
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', f('a.mp4'), '-an', '-c', 'copy', f('v.mp4')]);
  const silent = await extractAudio(fs.readFileSync(f('v.mp4')));
  const garbage = await extractAudio(Buffer.alloc(3000, 7), 'aac').then(() => 'ok', (e) => e.message);
  const head = await extractAudio(fs.readFileSync(f('b.mp4')).subarray(0, 60000));
  t('video không có tiếng: no_audio; file hỏng: báo lỗi; file cắt ngắn: vẫn tách được', () => {
    assert.equal(silent, null);
    assert.match(garbage, /ffmpeg không tách được âm thanh/);
    assert.ok(head && head.seconds > 0.5, JSON.stringify(head && head.seconds));
  });
} catch (e) {
  if (e.code === 'ENOENT') console.log('BỎ QUA kiểm tra mốc âm thanh (không tìm thấy ffmpeg)'); else throw e;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${n} kiểm tra đều đạt.`);

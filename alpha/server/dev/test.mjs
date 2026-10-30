// Kiểm tra nhanh các hàm thuần của pipeline (không cần key, không cần mạng). Chạy: npm test
// Kiểm thử toàn trình (extension + server + Douyin giả) nằm ở alpha/dev/e2e.mjs.
import assert from 'node:assert/strict';
import { classifySpeech, segmentCues, fixViText, splitSung } from '../pipeline.mjs';

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
t('sửa khoảng trắng câu tiếng Việt', () => {
  assert.equal(fixViText('  Chào  cả nhà ,hôm nay đi ăn lẩu . '), 'Chào cả nhà, hôm nay đi ăn lẩu.');
});
console.log(`\n${n} kiểm tra đều đạt.`);

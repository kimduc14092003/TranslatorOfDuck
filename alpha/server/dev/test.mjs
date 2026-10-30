// Kiểm tra nhanh các hàm thuần của pipeline (không cần key, không cần mạng). Chạy: npm test
// Kiểm thử toàn trình (extension + server + Douyin giả) nằm ở alpha/dev/e2e.mjs.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifySpeech, segmentCues, fixViText, splitSung, extractAudio, windowAsr, resplitSentences } from '../pipeline.mjs';

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
t('Fun-ASR trả cả đoạn thành một câu: chia lại theo từ, đoạn sau vẫn có lời', () => {
  // Như đoạn [20, 50) của một vlog thật: âm thanh bắt đầu ở 18,5 s, "câu" duy nhất bắt đầu ở 0,1 s (18,6 s).
  const words = [W('还剩', 0.1, 0.6), W('五块。', 0.6, 1.2), W('早啊，', 6.3, 6.6), W('朋友们！', 6.6, 7.1),
    W('到了', 9.4, 9.7), W('发生活费', 9.8, 10.7), W('的时间', 10.7, 11.3), W('了哈！', 11.3, 11.7),
    ...Array.from('我分三轮拍卖每一轮付钱最多的得到生活费其他人付过的钱不退回').map((c, i) => W(c, 12 + i * 0.2, 12.18 + i * 0.2))];
  const r = { provider: 'funasr', text: words.map(w => w.text).join(''), segments: [{ start: 0.1, end: 17.6, text: words.map(w => w.text).join('') }], words };
  assert.equal(windowAsr(r, 18.5, 20, 50).segments.length, 0);          // trước khi sửa: mất cả đoạn
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
} catch (e) {
  if (e.code === 'ENOENT') console.log('BỎ QUA kiểm tra mốc âm thanh (không tìm thấy ffmpeg)'); else throw e;
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${n} kiểm tra đều đạt.`);

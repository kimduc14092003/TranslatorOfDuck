// Kiểm tra chế độ lời bài hát (extension gửi lyrics: true, mặc định bật). Không cần key, không cần mạng; cần ffmpeg.
// Server thật + dịch vụ AI giả: âm thanh 22 s là một bài hát (chữ kéo dài 0,6 s, có dòng chỉ "耶耶耶耶"), 26 s là lời nói,
// 14 s là điệp khúc câu ngắn "我爱你。" ×4 (cả đoạn là bài hát mà không câu nào đủ 4 chữ để tự tính là câu hát), 30 s là
// lời nói kèm một câu "yeah yeah" nói nhanh. Dòng hát "我爱你" được dịch rất dài để có lượt rút gọn.
//   Chạy: node dev/lyrics-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-lyrics-'));
const aac = (sec) => { const f = path.join(TMP, `${sec}.aac`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', f]); return fs.readFileSync(f).toString('base64'); };

// Mỗi chữ một "từ" như Fun-ASR trả, bắt đầu ở giây `at`, dài `per` giây; nghỉ `gap` giây sau mỗi dấu câu.
const chars = (text, at, per, gap = 0) => {
  const out = [];
  for (const ch of text) {
    if (/[，。]/.test(ch)) { out[out.length - 1].punctuation = ch; at += gap; continue; }
    out.push({ text: ch, begin_time: Math.round(at * 1000), end_time: Math.round((at + per) * 1000), punctuation: '' });
    at += per;
  }
  return out;
};
const SONG = [...chars('月亮代表我的心，', 1, 0.6), ...chars('月亮代表我的心。', 5.6, 0.6), ...chars('耶耶耶耶。', 10.5, 0.6)];
const CHORUS = chars('我爱你。我爱你。我爱你。我爱你。', 1, 0.5, 1);
const SPEECH = [['大家', 1000, 1400], ['好', 1400, 1600, '，'], ['今天', 1700, 2000], ['我们', 2000, 2300], ['去', 2300, 2450], ['吃', 2450, 2600], ['火锅', 2600, 3100, '。']]
  .map(([text, b, e, p]) => ({ text, begin_time: b, end_time: e, punctuation: p || '' }));
const SPEECH_YEAH = [...SPEECH, { text: 'yeah', begin_time: 3800, end_time: 4000, punctuation: '' }, { text: 'yeah', begin_time: 4000, end_time: 4300, punctuation: '。' }];
const sentence = (words) => ({ begin_time: words[0].begin_time, end_time: words.at(-1).end_time, text: words.map(w => w.text + w.punctuation).join(''), words });

let asrCalls = 0, asrDelay = 0;
const mtBodies = [];
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      asrCalls++;
      if (asrDelay) await new Promise(r => setTimeout(r, asrDelay));
      const b64 = JSON.parse(body).input.messages[0].content[0].input_audio.data;
      const seconds = Math.round((Buffer.from(b64.split(',')[1], 'base64').length * 8) / 48000);
      const words = seconds < 17 ? CHORUS : seconds < 24 ? SONG : seconds < 28 ? SPEECH : SPEECH_YEAH;
      return json({ output: { sentence: sentence(words), text: sentence(words).text } });
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const content = JSON.parse(body).messages[0].content;
      mtBodies.push(content);
      const lines = JSON.parse(content.match(/Các dòng: (.*)$/m)[1]);
      const vi = (l) => !l.sung ? 'Chào cả nhà, hôm nay đi ăn lẩu.' : l.zh.startsWith('我爱你') ? 'Anh yêu em, yêu em mãi mãi, dù mai này trời đất có đổi thay' : 'Ánh trăng nói hộ lòng anh';
      return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ cues: lines.map(l => ({ id: l.id, vi: vi(l) })) }) } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
const port = 21787 + Math.floor(Math.random() * 1000);
const WORK = path.join(TMP, 'work');
const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), TOD_WORK: WORK, FFMPEG: ffmpeg, DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: 'test',
    OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', DASHSCOPE_BASE: PROV, GEMINI_BASE: PROV + '/v1beta', OPENAI_BASE: PROV + '/v1',
    MAX_PARALLEL: '1', FUNASR_MODEL: 'fun-asr-flash-2026-06-15' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));

const song = aac(22), speech = aac(26), chorus = aac(14), yeah = aac(30);
const ID = new Map([[song, '7500000000000000081'], [speech, '7500000000000000082'], [chorus, '7500000000000000083'], [yeah, '7500000000000000086']]);
const post = (audio, lyrics, extra = {}) => fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: ID.get(audio), from: 0, to: 30, audioStart: 0, urgent: true, lyrics, aac: audio, ...extra }) }).then(r => r.json());
const files = () => fs.readdirSync(path.join(WORK, 'cache')).sort();
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
try {
  const off = await post(song, false);
  t('chế độ cũ (lyrics: false): bài hát vẫn bị bỏ qua, không gọi dịch', () => {
    assert.equal(off.status, 'skipped'); assert.equal(off.label, 'singing');
    assert.equal(asrCalls, 1); assert.equal(mtBodies.length, 0);
  });
  const on = await post(song, true);
  t('lyrics: true: dịch lời bài hát, mọi dòng đánh dấu sung, bỏ dòng chỉ có tiếng đệm "耶耶耶耶"', () => {
    assert.equal(on.status, 'ok', JSON.stringify(on));
    assert.ok(on.cues.length >= 1 && on.cues.every(c => c.sung === true), JSON.stringify(on.cues));
    assert.ok(on.cues.every(c => !c.zh.includes('耶')), JSON.stringify(on.cues.map(c => c.zh)));
    assert.equal(on.cues[0].vi, 'Ánh trăng nói hộ lòng anh');
  });
  t('lyrics: true: dùng lại kết quả nhận dạng đã có, không trả tiền ASR lần nữa', () => { assert.equal(asrCalls, 1); });
  t('câu lệnh dịch có hướng dẫn lời bài hát và cờ "sung" cho từng dòng hát', () => {
    assert.match(mtBodies[0], /là lời bài hát/);
    assert.match(mtBodies[0], /"sung":true/);
  });
  t('cache riêng cho chế độ lời bài hát (.vi.lyr.), giữ file nhận dạng của đoạn có hát', () => {
    assert.ok(files().some(f => /^7500000000000000081\.0-30\.vi\.lyr\./.test(f)), files().join(' '));
    assert.ok(files().some(f => /^7500000000000000081\.0-30\.vi\.alpha/.test(f)), files().join(' '));
    assert.ok(files().some(f => /^7500000000000000081\.0-30\.asr\./.test(f)), files().join(' '));
  });
  const sp = await post(speech, false);
  const asrBefore = asrCalls, mtBefore = mtBodies.length;
  const sp2 = await post(speech, true);
  t('đoạn lời nói (không câu hát nào): chế độ lời bài hát trả ngay kết quả của chế độ kia, không ASR, không dịch lại', () => {
    assert.equal(sp.status, 'ok'); assert.equal(sp2.status, 'ok'); assert.equal(sp2.cached, true);
    assert.deepEqual(sp2.cues, sp.cues);
    assert.equal(asrCalls, asrBefore); assert.equal(mtBodies.length, mtBefore);
    assert.ok(!files().some(f => /^7500000000000000082\.0-30\.vi\.lyr\./.test(f)), files().join(' '));
  });
  const back = await post(song, false);
  t('tắt lại chế độ lời bài hát: bài hát lại bị bỏ qua (từ cache), không gọi gì thêm', () => {
    assert.equal(back.status, 'skipped'); assert.equal(back.label, 'singing'); assert.equal(back.cached, true);
    assert.equal(asrCalls, asrBefore); assert.equal(mtBodies.length, mtBefore);
  });
  t('log ghi rõ chế độ lời bài hát ("♪", số dòng hát được dịch)', () => {
    assert.match(log, /7500000000000000081 \[0:00–0:30 ♪\] ok 2 dòng .*2 dòng hát được dịch/);
  });
  // Điệp khúc câu ngắn: server báo sung = 0 (không câu nào tự tính là câu hát) dù cả đoạn là bài hát. Trước đây chế độ
  // thường nhận nhầm kết quả của chế độ lời bài hát (noSinging chỉ xét sung và label), hiện các dòng ♪.
  const ch1 = await post(chorus, true);
  t('điệp khúc câu ngắn, chế độ lời bài hát: dịch cả đoạn, mọi dòng là dòng hát dù sung = 0', () => {
    assert.equal(ch1.status, 'ok', JSON.stringify(ch1)); assert.equal(ch1.sung, 0);
    assert.ok(ch1.cues.length >= 1 && ch1.cues.every(c => c.sung === true), JSON.stringify(ch1.cues));
  });
  t('lượt rút gọn dòng hát quá dài nhận cờ "sung" và hướng dẫn lời bài hát', () => {
    assert.ok(mtBodies.some(b => /^Rút gọn các dòng/.test(b) && /rút gọn mà vẫn là lời hát/.test(b) && /"sung":true/.test(b)), 'không có lượt rút gọn cho dòng hát');
  });
  const asrCh = asrCalls, mtCh = mtBodies.length;
  const ch2 = await post(chorus, false);
  t('… tắt lời bài hát: chế độ thường không nhận kết quả có dòng ♪ (bài hát bị bỏ qua), dùng lại ASR đã giữ', () => {
    assert.equal(ch2.status, 'skipped', JSON.stringify(ch2)); assert.equal(ch2.label, 'singing'); assert.ok(!ch2.cached);
    assert.ok(!(ch2.cues || []).some(c => c.sung));
    assert.equal(asrCalls, asrCh); assert.equal(mtBodies.length, mtCh);
  });
  // Chế độ thường không hiện dòng hát: đoạn lời nói ngay sau một đoạn hát (đã dịch ở chế độ lời bài hát) không được lấy
  // các dòng hát làm ngữ cảnh. Chế độ lời bài hát thì vẫn lấy.
  const SID = '7500000000000000084';
  await post(song, true, { id: SID, from: 0, to: 20 });
  await post(speech, false, { id: SID, from: 20, to: 50, audioStart: 20, prev: [0, 20] });
  const speechPrompt = mtBodies.at(-1);
  await post(song, true, { id: '7500000000000000085', from: 0, to: 20 });
  await post(speech, true, { id: '7500000000000000085', from: 20, to: 50, audioStart: 20, prev: [0, 20] });
  const lyricPrompt = mtBodies.at(-1);
  t('ngữ cảnh: chế độ thường bỏ các dòng hát của đoạn trước, chế độ lời bài hát giữ', () => {
    assert.match(speechPrompt, /火锅/); assert.doesNotMatch(speechPrompt, /月亮代表我的心/);
    assert.match(lyricPrompt, /Các dòng ngay trước trong video.*月亮代表我的心/);
  });
  // Dòng chỉ có tiếng đệm chữ Latin, nói nhanh (không phải câu hát): bỏ ở cả hai chế độ, để hai chế độ ra cùng các dòng.
  const y1 = await post(yeah, true), y2 = await post(yeah, false, { id: '7500000000000000087' });
  t('dòng "yeah yeah" (tiếng đệm chữ Latin, không hát) bị bỏ ở cả hai chế độ', () => {
    for (const y of [y1, y2]) { assert.equal(y.status, 'ok'); assert.ok(y.cues.length >= 1 && !y.cues.some(c => /yeah/i.test(c.zh)), JSON.stringify(y.cues)); }
  });
  // Hai chế độ cho cùng một đoạn tới cùng lúc (hai tab; đổi nút lúc đoạn đang xếp hàng): một chỗ chạy (MAX_PARALLEL=1),
  // việc thứ hai tới lượt thì thấy kết quả không có câu hát của việc thứ nhất, dùng luôn: một lần ASR, một lần dịch.
  asrDelay = 400;
  const asr0 = asrCalls, mt0 = mtBodies.length;
  // urgent: false: đoạn gấp được thêm một chỗ (canRun), hai việc gấp sẽ chạy cùng lúc.
  const both = await Promise.all([post(speech, true, { id: '7500000000000000088', urgent: false }), post(speech, false, { id: '7500000000000000088', urgent: false })]);
  asrDelay = 0;
  t('hai chế độ cùng lúc cho một đoạn lời nói: việc chạy sau dùng kết quả của việc trước, không ASR, không dịch lại', () => {
    assert.ok(both.every(b => b.status === 'ok'), JSON.stringify(both));
    assert.equal(both.filter(b => b.cached).length, 1);
    assert.equal(asrCalls - asr0, 1); assert.equal(mtBodies.length - mt0, 1);
    assert.match(log, /7500000000000000088 \[0:00–0:30( ♪)?\] ok .*\(cache\)/);
  });
} finally {
  server.kill(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

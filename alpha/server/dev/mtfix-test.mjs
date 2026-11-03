// Dòng bị bỏ trống hay còn chữ Hán sau lượt dịch đầu (đo 3/11 trên cache: 18 vế câu bị mất ở 8 video, thường là câu chốt:
// "B站联名眼镜就退款", câu nói về cách viết chữ 辫, câu hỏi "陀螺 nghĩa là gì"). Server dịch lại riêng các dòng đó một lần;
// còn chữ Hán mà phần lớn là tiếng Việt thì vẫn hiện; chỉ bỏ dòng trống hay gần như toàn chữ Hán, và ghi log.
// Không cần key, không cần mạng; cần ffmpeg. Server thật + dịch vụ AI giả.   Chạy: node dev/mtfix-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-mtfix-'));
const aac = (sec) => { const f = path.join(TMP, `${sec}.aac`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', f]); return fs.readFileSync(f).toString('base64'); };

// Mỗi chữ một "từ" như Fun-ASR trả; mỗi câu cách câu sau 1 s để thành dòng riêng.
const chars = (text, at, per = 0.2) => {
  const out = [];
  for (const ch of text) {
    if (/[，。？！]/.test(ch)) { out[out.length - 1].punctuation = ch; continue; }
    out.push({ text: ch, begin_time: Math.round(at * 1000), end_time: Math.round((at + per) * 1000), punctuation: '' });
    at += per;
  }
  return out;
};
const LINES = ['大家好。', 'B站联名眼镜就退款。', '你看辫字是这样写的。', '陀螺什么意思啊？'];
const WORDS = LINES.flatMap((l, i) => chars(l, 1 + i * 4));
const CLEAN = ['大家好。'];
// Ca của verifier 3/11: bản đầu đã có chữ 辫 (bản dịch lại cùng số chữ Hán, trong ngoặc: lấy bản dịch lại), câu tiếng Nhật và
// câu có từ tiếng Anh bị model chép lại (bỏ), model trả id lộn thứ tự và trùng id (lấy bản ít chữ Hán nhất).
// Thêm: bản dịch lại chép cả câu Hán vào ngoặc (bản đầu hiện được thì giữ bản đầu), bản dịch lại nhiều chữ Hán hơn (bỏ).
const TRICKY = ['这个字念辫。', '今日はいい天気ですね。', '这款MacBook Pro很好用。', '陀螺什么意思啊？', '雷鸟说的。'].flatMap((l, i) => chars(l, 1 + i * 4));
// Dòng dài còn chữ Hán ở đoạn thường (có lượt rút gọn): bản rút gọn được giữ chữ trong ngoặc.
const LONG = chars('这个字念辫。', 1);
const sentence = (words) => ({ begin_time: words[0].begin_time, end_time: words.at(-1).end_time, text: words.map(w => w.text + w.punctuation).join(''), words });

const bodies = [];
let retryMode = 'ok';   // 'ok' | 'fail' (lượt dịch lại báo lỗi 500)
let asr = 'all';        // 'all' (LINES) | 'clean' (chỉ câu dịch được ngay) | 'tricky' | 'long'
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      const s = sentence(asr === 'clean' ? chars(CLEAN[0], 1) : asr === 'tricky' ? TRICKY : asr === 'long' ? LONG : WORDS);
      return json({ output: { sentence: s, text: s.text } });
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const content = JSON.parse(body).messages[0].content;
      const retry = /^Dịch lại/.test(content), condense = /^Rút gọn/.test(content);
      bodies.push({ retry, condense, content });
      if (retry && retryMode === 'fail') return json({ error: { message: 'boom' } }, 500);
      const lines = JSON.parse(content.match(/^Các dòng: (.*)$/m)[1]);
      const LONGVI = 'Chữ này đọc là "biện" (辫), một chữ rất khó viết mà học sinh tiểu học thường hay viết sai thành chữ khác.';
      if (condense) return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ cues: lines.map(l => ({ id: l.id, vi: 'Chữ này đọc "biện" (辫).' })) }) } }] });
      if (asr === 'long') {
        const vi = retry ? LONGVI : 'Chữ này đọc là 辫, một chữ rất khó viết mà học sinh tiểu học thường hay viết sai thành chữ khác.';
        return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ pronouns: { pairs: [] }, cues: lines.map(l => ({ id: l.id, vi })) }) } }] });
      }
      if (asr === 'tricky') {
        const f = (zh) => zh.includes('辫') ? (retry ? 'Chữ này đọc là "biện" (辫).' : 'Chữ này đọc là 辫.') : zh.includes('今日') ? '今日はいい天気ですね。'
          : zh.includes('陀螺') ? (retry ? 'Nghĩa là gì vậy (陀螺什么意思啊)?' : 'Con quay 陀螺 nghĩa là gì?')
          : zh.includes('雷鸟') ? (retry ? '雷鸟 雷鸟 nói.' : 'Lôi Điểu 雷鸟 nói vậy đó.') : '这款MacBook Pro';
        let cues = lines.map(l => ({ id: l.id, vi: f(l.zh) }));
        if (retry) cues = [...cues.reverse(), ...lines.filter(l => l.zh.includes('辫')).map(l => ({ id: l.id, vi: '这个字念辫 (biện)' }))];
        return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(retry ? { cues } : { pronouns: { pairs: [] }, cues }) } }] });
      }
      const first = (zh) => zh.includes('B站') ? 'Kính hợp tác B站 sẽ được hoàn tiền.' : zh.includes('辫') ? null : zh.includes('陀螺') ? '陀螺什么意思啊？' : 'Chào mọi người.';
      const again = (zh) => zh.includes('B站') ? 'Kính hợp tác Bilibili sẽ được hoàn tiền.' : zh.includes('辫') ? 'Nhìn này, chữ "biện" (辫) viết thế này.' : zh.includes('陀螺') ? '陀螺是什么意思' : 'Chào mọi người.';
      const cues = lines.map(l => ({ id: l.id, vi: retry ? again(l.zh) : first(l.zh) })).filter(c => c.vi != null);
      return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(retry ? { cues } : { pronouns: { pairs: [] }, cues }) } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
const port = 22787 + Math.floor(Math.random() * 1000);
const WORK = path.join(TMP, 'work');
// MT_TIMEOUT_MS ngắn: ca lượt dịch lại lỗi không chờ chuỗi gọi lại 10 s (verifier 3/11).
const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), TOD_WORK: WORK, FFMPEG: ffmpeg, DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '', MT_TIMEOUT_MS: '800', TOD_CONDENSE: '1',
    OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1', FUNASR_MODEL: 'fun-asr-flash-2026-06-15' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));

const audio = aac(22);
const post = (id, from, extra = {}) => fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id, from, to: from + 30, audioStart: from, urgent: true, lyrics: true, aac: audio, ...extra }) }).then(r => r.json());
const vis = (r) => (r.cues || []).map(c => [c.zh, c.vi]);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
try {
  const a = await post('7500000000000000201', 0);
  const calls = bodies.slice();
  t('dòng còn chữ Hán hay bị bỏ trống: dịch lại riêng các dòng đó, một lần', () => {
    assert.equal(calls.length, 2, JSON.stringify(calls.map(b => b.retry)));
    assert.ok(!calls[0].retry && calls[1].retry);
    const sent = JSON.parse(calls[1].content.match(/^Các dòng: (.*)$/m)[1]).map(l => l.zh);
    assert.deepEqual(sent, ['B站联名眼镜就退款。', '你看辫字是这样写的。', '陀螺什么意思啊？']);
    assert.match(calls[1].content, /Bilibili/);
    assert.match(calls[1].content, /Các dòng xung quanh đã dịch/);
  });
  t('dịch lại hết chữ Hán thì dùng bản mới; còn ít chữ Hán (câu nói về chính chữ đó) vẫn hiện; gần như toàn chữ Hán thì bỏ', () => {
    assert.equal(a.status, 'ok', JSON.stringify(a));
    assert.deepEqual(vis(a), [['大家好。', 'Chào mọi người.'], ['B站联名眼镜就退款。', 'Kính hợp tác Bilibili sẽ được hoàn tiền.'],
      ['你看辫字是这样写的。', 'Nhìn này, chữ "biện" (辫) viết thế này.']]);
  });
  t('log server ghi dòng bị bỏ và lý do, số dòng dịch lại', () => {
    assert.match(log, /dịch lại 3 dòng \(sửa được 2\)/);
    assert.match(log, /bỏ dòng \(còn chữ Hán\): 陀螺什么意思啊？/);
  });
  const cached = JSON.parse(fs.readFileSync(path.join(WORK, 'cache', '7500000000000000201.0-30.vi.lyr.alpha-8.json'), 'utf8'));
  t('file cache ghi lại dòng bị bỏ (debug.mtFix), câu trả lời cho extension không có debug', () => {
    assert.deepEqual(cached.debug.mtFix.dropped, [{ zh: '陀螺什么意思啊？', why: 'han' }]);
    assert.equal(cached.debug.mtFix.retried, 3); assert.equal(cached.debug.mtFix.keptHan, 1);
    assert.ok(!('debug' in a));
  });
  retryMode = 'fail';
  const b = await post('7500000000000000202', 0);
  t('lượt dịch lại lỗi: giữ bản đầu nếu phần lớn là tiếng Việt, bỏ dòng trống và dòng toàn chữ Hán', () => {
    assert.equal(b.status, 'ok', JSON.stringify(b));
    assert.deepEqual(vis(b), [['大家好。', 'Chào mọi người.'], ['B站联名眼镜就退款。', 'Kính hợp tác B站 sẽ được hoàn tiền.']]);
  });
  t('log ghi lượt dịch lại lỗi', () => { assert.match(log, /dịch lại 3 dòng \(lượt dịch lại lỗi\)/); });
  retryMode = 'ok'; asr = 'tricky';
  const d = await post('7500000000000000204', 0);
  t('bản dịch lại cùng số chữ Hán (trong ngoặc) thì lấy bản dịch lại; id lộn thứ tự, trùng id; câu tiếng Nhật, từ tiếng Anh bị chép lại thì bỏ', () => {
    assert.equal(d.status, 'ok', JSON.stringify(d));
    assert.deepEqual(vis(d), [['这个字念辫。', 'Chữ này đọc là "biện" (辫).'], ['陀螺什么意思啊？', 'Con quay 陀螺 nghĩa là gì?'],
      ['雷鸟说的。', 'Lôi Điểu 雷鸟 nói vậy đó.']]);
  });
  asr = 'long';
  const e = await post('7500000000000000205', 0, { urgent: false });
  t('đoạn thường: dòng dài còn chữ Hán trong ngoặc được rút gọn, giữ chữ đó', () => {
    assert.equal(e.status, 'ok', JSON.stringify(e));
    assert.deepEqual(vis(e), [['这个字念辫。', 'Chữ này đọc "biện" (辫).']]);
    assert.ok(bodies.some(b => b.condense));
  });
  asr = 'clean';
  const before = bodies.length;
  const c = await post('7500000000000000203', 0);
  t('không có dòng nào lỗi: không gọi thêm', () => {
    assert.equal(c.status, 'ok'); assert.equal(bodies.length - before, 1);
  });
} finally {
  server.kill(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

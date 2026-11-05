// Ngôn ngữ nguồn tiếng Anh (ROADMAP giai đoạn 3): video nói tiếng Anh không còn bị bỏ là "không phải tiếng Trung". Dịch sang
// tiếng Việt bằng câu lệnh "từ tiếng Anh"; đích tiếng Anh thì hiện chính bản chép lời, không gọi dịch; dòng trả về vẫn là tiếng
// Anh thì dịch lại; kết quả cũ "không phải tiếng Trung" trong cache được làm lại; đổi ngôn ngữ đích từ dòng gốc tiếng Anh;
// đoạn tiếng Trung không đổi. Server thật, dịch vụ giả. Không cần key, không cần mạng; cần ffmpeg.
//   Chạy: node dev/source-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-source-'));
const webm = (sec) => { const f = path.join(TMP, `${sec}.webm`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'libopus', f]); return fs.readFileSync(f).toString('base64'); };
const aac = (sec) => { const f = path.join(TMP, `${sec}.aac`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', f]); return fs.readFileSync(f).toString('base64'); };

// Từ tiếng Anh như Fun-ASR trả: dấu cách đứng trước từ, dấu câu ở trường punctuation. Câu liền nhau, không có khoảng lặng.
const english = (sentences, at = 0.5, per = 0.3) => {
  const out = [];
  for (const s of sentences) for (const tok of s.split(/(?= )/)) {
    const m = tok.match(/^(.*?)([,.?!]?)$/);
    out.push({ text: m[1], begin_time: Math.round(at * 1000), end_time: Math.round((at + per - 0.02) * 1000), punctuation: m[2] });
    at += per;
  }
  return out;
};
const chars = (text, at, per) => {
  const out = [];
  for (const ch of text) {
    if (/[，。？！]/.test(ch)) { out[out.length - 1].punctuation = ch; continue; }
    out.push({ text: ch, begin_time: Math.round(at * 1000), end_time: Math.round((at + per) * 1000), punctuation: '' });
    at += per;
  }
  return out;
};
// Âm thanh 12 s: tiếng Anh, ba câu liền nhau; 16 s: tiếng Trung.
const EN_LINES = ['Hello everyone, my name is Mr. Brown.', ' Today we are going to talk about pandas.', ' Are you ready?'];
const WORDS = { 12: english(EN_LINES), 16: [...chars('大家好，今天我们去吃火锅。', 0.5, 0.2), ...chars('这个陀螺很好玩。', 4, 0.2)],
  20: chars('断る。帰れ。てめえ死にてえのか。', 0.5, 0.2), 24: english(['안녕하세요.', ' 오늘은 날씨가 좋네요.']) };
const VI = { 断る: 'Tôi từ chối.', 帰れ: 'Về đi.', てめえ: 'Mày muốn chết à?', 안녕하세요: 'Xin chào.', 오늘은: 'Hôm nay trời đẹp nhỉ.', Hello: 'Chào mọi người, mình tên là Brown.', Today: 'Hôm nay chúng ta sẽ nói về gấu trúc.', ready: 'Các bạn sẵn sàng chưa?',
  大家好: 'Chào cả nhà, hôm nay đi ăn lẩu.', 陀螺: 'Con quay này vui lắm.' };
const pick = (src) => Object.entries(VI).find(([k]) => src.includes(k))?.[1] || 'x';
const KOECHO = '안녕하세요.';
let asrCalls = 0;
const mtBodies = [];
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      asrCalls++;
      const b64 = JSON.parse(body).input.messages[0].content[0].input_audio.data;
      const seconds = Math.round((Buffer.from(b64.split(',')[1], 'base64').length * 8) / 48000);
      const words = WORDS[seconds < 14 ? 12 : seconds < 18 ? 16 : seconds < 22 ? 20 : 24];
      const sentence = { begin_time: words[0].begin_time, end_time: words.at(-1).end_time, text: words.map(w => w.text + w.punctuation).join(''), words };
      return json({ output: { sentence, text: sentence.text } });
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const content = JSON.parse(body).messages[0].content;
      mtBodies.push(content);
      const lines = JSON.parse(content.match(/^Các dòng: (.*)$/m)[1]);
      const retry = /^Dịch lại/.test(content);
      // ECHO trong mô tả video: lượt đầu trả nguyên câu tiếng Anh cho câu về gấu trúc (model không dịch).
      const echo = content.includes('ECHO') && !retry;
      const cues = lines.map(l => { const src = l.en ?? l.ja ?? l.ko ?? l.zh; return { id: l.id, vi: echo && (src.includes('pandas') || src.includes('안녕')) ? src : pick(src) }; });
      return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(retry ? { cues } : { pronouns: { pairs: [] }, cues }) } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
const port = 25787 + Math.floor(Math.random() * 1000);
const WORK = path.join(TMP, 'work');
const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), TOD_WORK: WORK, FFMPEG: ffmpeg, DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '',
    OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: '', DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1',
    FUNASR_MODEL: 'fun-asr-flash-2026-06-15', MAX_PARALLEL: '4', TOD_CONDENSE: '', MT_TIMEOUT_MS: '2000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));

const post = async (body) => (await fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const base = (id, extra) => ({ id, desc: 'a vlog about pandas', hashtags: ['vlog'], lyrics: true, from: 0, to: 10, audioStart: 0, ...extra });
const V = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).version;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const EN_TRIM = EN_LINES.map(s => s.trim());
try {
  // 1. Nguồn tiếng Anh, đích tiếng Việt.
  const A = '7500000000000000501';
  const mt0 = mtBodies.length;
  const a = await post(base(A, { target: 'vi', aac: aac(12) }));
  t('video nói tiếng Anh, đích tiếng Việt: có sub (trước đây bị bỏ "không phải tiếng Trung"), nguồn ghi en', () => {
    assert.equal(a.status, 'ok', JSON.stringify(a));
    assert.equal(a.src, 'en');
    assert.deepEqual(a.cues.map(c => c.zh), EN_TRIM);
    assert.deepEqual(a.cues.map(c => c.vi), [VI.Hello, VI.Today, VI.ready]);
  });
  t('câu lệnh dịch ghi "từ tiếng Anh", không có luật Hán Việt, dòng gốc gửi bằng khoá en', () => {
    const prompt = mtBodies[mt0];
    assert.match(prompt, /từ tiếng Anh sang tiếng Việt/);
    assert.doesNotMatch(prompt, /Hán Việt|tiếng Trung|chữ Hán/);
    assert.match(prompt, /"en":"Hello everyone, my name is Mr\. Brown\."/);
  });

  // 2. Nguồn tiếng Anh, đích tiếng Anh: hiện chính bản chép lời, không gọi dịch.
  const B = '7500000000000000502';
  const mtB = mtBodies.length, asrB = asrCalls;
  const b = await post(base(B, { target: 'en', aac: aac(12) }));
  t('video nói tiếng Anh, đích tiếng Anh: hiện bản chép lời, không gọi dịch', () => {
    assert.equal(b.status, 'ok', JSON.stringify(b));
    assert.equal(b.target, 'en'); assert.equal(b.src, 'en'); assert.equal(b.same, true);
    assert.deepEqual(b.cues.map(c => c.vi), EN_TRIM);
    assert.equal(mtBodies.length, mtB, 'không gọi dịch');
    assert.equal(asrCalls, asrB + 1);
  });

  // 3. Đổi đích sang tiếng Việt không kèm âm thanh: dịch từ dòng gốc tiếng Anh đã lưu, vẫn câu lệnh "từ tiếng Anh".
  const mtC = mtBodies.length, asrC = asrCalls;
  const c = await post(base(B, { target: 'vi', retarget: true, audioStart: undefined }));
  t('đổi sang tiếng Việt từ dòng gốc tiếng Anh: không nhận dạng lại, câu lệnh từ tiếng Anh', () => {
    assert.equal(c.status, 'ok', JSON.stringify(c));
    assert.equal(asrCalls, asrC);
    assert.deepEqual(c.cues.map(x => x.vi), [VI.Hello, VI.Today, VI.ready]);
    assert.match(mtBodies[mtC], /từ tiếng Anh sang tiếng Việt/);
  });

  // 4. Model trả nguyên câu tiếng Anh: dịch lại; bản dịch lại là tiếng Việt.
  const D = '7500000000000000503';
  const mtD = mtBodies.length;
  const d = await post(base(D, { target: 'vi', aac: aac(12), desc: 'ECHO pandas' }));
  t('dòng trả về vẫn là tiếng Anh: dịch lại, ra tiếng Việt', () => {
    assert.equal(d.status, 'ok', JSON.stringify(d));
    assert.deepEqual(d.cues.map(x => x.vi), [VI.Hello, VI.Today, VI.ready]);
    assert.equal(mtBodies.length - mtD, 2);
    assert.match(mtBodies[mtD + 1], /^Dịch lại[^\n]*tiếng Anh/);
  });

  // 5. Kết quả cũ "không phải tiếng Trung" trong cache: làm lại.
  const E = '7500000000000000504';
  fs.mkdirSync(path.join(WORK, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'cache', `${E}.0-10.vi.lyr.${V}.json`),
    JSON.stringify({ id: E, from: 0, to: 10, status: 'skipped', label: 'not_zh', asr: 'funasr', seconds: 12, heard: 'Hello everyone', sung: 0, sentences: 3 }));
  const asrE = asrCalls;
  const e = await post(base(E, { target: 'vi', aac: aac(12) }));
  t('cache cũ ghi "không phải tiếng Trung": làm lại, có sub', () => {
    assert.equal(e.status, 'ok', JSON.stringify(e)); assert.ok(!e.cached);
    assert.equal(asrCalls, asrE + 1);
  });

  // 6. Tiếng Trung không đổi: câu lệnh từ tiếng Trung, không có trường src.
  const F = '7500000000000000505';
  const mtF = mtBodies.length;
  const f = await post(base(F, { target: 'vi', aac: aac(16), desc: '一起去吃火锅' }));
  t('đoạn tiếng Trung như cũ: câu lệnh từ tiếng Trung, khoá zh, không ghi src', () => {
    assert.equal(f.status, 'ok', JSON.stringify(f));
    assert.equal(f.src, undefined);
    assert.match(mtBodies[mtF], /^Dịch phụ đề video Douyin từ tiếng Trung sang tiếng Việt/);
    assert.match(mtBodies[mtF], /"zh":"大家好，今天我们去吃火锅。"/);
  });

  // 7. Chế độ thường (tắt lời bài hát): video tiếng Anh vẫn có sub.
  const G = '7500000000000000506';
  const g = await post(base(G, { target: 'vi', aac: aac(12), lyrics: false }));
  t('tắt lời bài hát: video tiếng Anh vẫn có sub', () => {
    assert.equal(g.status, 'ok', JSON.stringify(g));
    assert.deepEqual(g.cues.map(x => x.zh), EN_TRIM);
  });

  // 8. Tiếng Nhật, tiếng Hàn (giai đoạn 4): câu lệnh ghi đúng ngôn ngữ nguồn, dòng gốc gửi bằng khoá ja / ko; bản dịch chép nguyên
  // chữ Hàn thì dịch lại.
  const J = '7500000000000000507', K = '7500000000000000508';
  const mtJ = mtBodies.length;
  const j = await post(base(J, { target: 'vi', aac: aac(20) }));
  t('video nói tiếng Nhật: nguồn ja, câu lệnh "từ tiếng Nhật", khoá ja', () => {
    assert.equal(j.status, 'ok', JSON.stringify(j)); assert.equal(j.src, 'ja');
    // Ba câu ngắn liền nhau được gộp thành một dòng (luật gộp dòng dưới 0,833 s, như tiếng Trung).
    assert.match(mtBodies[mtJ], /từ tiếng Nhật sang tiếng Việt/); assert.match(mtBodies[mtJ], /"ja":"断る。帰れ。/);
    assert.doesNotMatch(mtBodies[mtJ], /Hán Việt/);
    assert.deepEqual(j.cues.map(c => c.vi), ['Tôi từ chối.']);
  });
  const mtK = mtBodies.length;
  const k = await post(base(K, { target: 'vi', aac: aac(24), desc: 'ECHO' }));
  t('video nói tiếng Hàn: nguồn ko, câu lệnh "từ tiếng Hàn"; dòng còn chữ Hàn thì dịch lại', () => {
    assert.equal(k.status, 'ok', JSON.stringify(k)); assert.equal(k.src, 'ko');
    assert.match(mtBodies[mtK], /từ tiếng Hàn sang tiếng Việt/); assert.match(mtBodies[mtK], /"ko":"안녕하세요\./);
    assert.match(mtBodies[mtK + 1], /^Dịch lại[^\n]*tiếng Hàn/);
    assert.ok(k.cues.length >= 1 && k.cues.every(c => !/\p{Script=Hangul}/u.test(c.vi)), JSON.stringify(k.cues));
  });

  // 9. Kết quả "ok" cũ (trước giai đoạn 4) của đoạn nghe ra tiếng Nhật: làm lại; kết quả cũ tiếng Trung và kết quả mới tiếng Nhật: dùng cache.
  const L = '7500000000000000509', M = '7500000000000000510';
  const okOld = (id, heard) => JSON.stringify({ id, from: 0, to: 10, status: 'ok', target: 'vi', asr: 'funasr', seconds: 20, heard, sung: 0, sentences: 2,
    cues: [{ id: 0, start: 0.5, end: 2, zh: heard, vi: 'cũ' }], debug: { features: { label: 'speech' } } });
  fs.writeFileSync(path.join(WORK, 'cache', `${L}.0-10.vi.lyr.${V}.json`), okOld(L, 'てめえ死にてえのか。'));
  fs.writeFileSync(path.join(WORK, 'cache', `${M}.0-10.vi.lyr.${V}.json`), okOld(M, '大家好，今天我们去吃火锅。'));
  const asrL = asrCalls;
  const l = await post(base(L, { target: 'vi', aac: aac(20) }));
  const m = await post(base(M, { target: 'vi', aac: aac(16) }));
  const j2 = await post(base(J, { target: 'vi', aac: aac(20) }));
  t('cache "ok" cũ nghe ra tiếng Nhật: làm lại; tiếng Trung cũ và tiếng Nhật mới: dùng cache', () => {
    assert.equal(l.status, 'ok', JSON.stringify(l)); assert.ok(!l.cached); assert.equal(l.src, 'ja');
    assert.ok(m.cached, JSON.stringify(m)); assert.equal(m.cues[0].vi, 'cũ');
    assert.ok(j2.cached, JSON.stringify(j2));
    assert.equal(asrCalls, asrL + 1);
  });

  // 10. Đường dự phòng (âm thanh thu từ tab của trang bất kỳ): id "tab…", WebM/Opus; định dạng lạ thì 400.
  const T = 'tab123456789012';
  const tb = await post(base(T, { target: 'vi', aac: webm(12), fmt: 'webm', from: 5, to: 10, audioStart: 0, desc: 'Some page title' }));
  const bad = await fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(base(T, { aac: webm(12), fmt: 'ogg' })) });
  t('âm thanh WebM thu từ tab: nhận dạng, dịch như đoạn video; fmt lạ trả 400', () => {
    assert.equal(tb.status, 'ok', JSON.stringify(tb)); assert.equal(tb.id, T);
    assert.ok(tb.cues.length >= 1 && tb.cues.every(c => c.start >= 5 && c.start < 10), JSON.stringify(tb.cues));
    assert.equal(bad.status, 400);
  });

  t('log server ghi nguồn tiếng Anh, và lần hiện bản chép không dịch', () => {
    assert.match(log, /nguồn tiếng Anh/);
    assert.match(log, /hiện bản chép, không dịch/);
  });
} finally {
  server.kill(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

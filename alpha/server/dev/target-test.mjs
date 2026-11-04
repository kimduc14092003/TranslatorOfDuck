// Ngôn ngữ đích (ROADMAP giai đoạn 1, bước 1.2): dịch sang tiếng Anh, file cache theo ngôn ngữ, target trong mọi trả lời và
// dòng tạm, đổi ngôn ngữ không kèm âm thanh (dịch từ dòng gốc đã lưu, không nhận dạng lại; need_audio khi chưa có), kết quả
// bỏ qua dùng lại, lời nói ngay trước lấy từ dòng gốc đoạn trước ở ngôn ngữ khác, kiểm dòng trả về sai ngôn ngữ, /health.
// Server thật, dịch vụ giả. Không cần key, không cần mạng; cần ffmpeg.   Chạy: node dev/target-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from '../langs.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-target-'));
const aac = (sec) => { const f = path.join(TMP, `${sec}.aac`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', f]); return fs.readFileSync(f).toString('base64'); };

const chars = (text, at, per) => {
  const out = [];
  for (const ch of text) {
    if (/[，。？！]/.test(ch)) { out[out.length - 1].punctuation = ch; continue; }
    out.push({ text: ch, begin_time: Math.round(at * 1000), end_time: Math.round((at + per) * 1000), punctuation: '' });
    at += per;
  }
  return out;
};
// Âm thanh 12 s: ba câu nói; 16 s: hai câu nói; 8 s: im lặng (không lời: kết quả bỏ qua).
const WORDS = {
  12: [...chars('大家好，今天我们去吃火锅。', 0.5, 0.2), ...chars('王小明很喜欢这家店。', 3.6, 0.2), ...chars('这个陀螺很好玩。', 7, 0.2)],
  16: [...chars('你好吗？', 2, 0.2), ...chars('我很好，谢谢。', 3.5, 0.2), ...chars('我们下次再来吧。', 6, 0.2)],
  8: [],
};
let asrCalls = 0;
const mtBodies = [];
const EN = {
  大家好: 'Hi everyone, today we are going to eat hotpot.', 王小明: 'Wang Xiaoming loves café and Pokémon.', 陀螺: 'This spinning top is fun.',
  你好吗: 'How are you?', 我很好: "I'm fine, thanks.", 下次: "Let's come again next time.",
};
const VI = { 大家好: 'Chào cả nhà, hôm nay đi ăn lẩu.', 王小明: 'Vương Tiểu Minh rất thích quán này.', 陀螺: 'Con quay này vui lắm.', 你好吗: 'Bạn khoẻ không?', 我很好: 'Mình khoẻ, cảm ơn.', 下次: 'Lần sau lại tới nhé.' };
const pick = (table, zh) => Object.entries(table).find(([k]) => zh.includes(k))?.[1] || 'x';
// Câu tiếng Việt có nhiều chữ riêng của tiếng Việt: model trả nhầm ngôn ngữ (ca WRONGLANG trong mô tả video).
const WRONG = 'Con quay này thật sự rất vui đấy.';
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      asrCalls++;
      if (asrDelay) return setTimeout(() => answerAsr(body, json), asrDelay);
      return answerAsr(body, json);
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const b = JSON.parse(body);
      const content = b.messages[0].content;
      mtBodies.push(content);
      return answerMt(b, content, res, json);
    }
    res.writeHead(404); res.end();
  });
});
let asrDelay = 0;
function answerAsr(body, json) {
  {
      const b64 = JSON.parse(body).input.messages[0].content[0].input_audio.data;
      const seconds = Math.round((Buffer.from(b64.split(',')[1], 'base64').length * 8) / 48000);
      const words = WORDS[seconds < 10 ? 8 : seconds < 14 ? 12 : 16];
      if (!words.length) return json({ output: { sentences: [], text: '' } });
      const sentence = { begin_time: words[0].begin_time, end_time: words.at(-1).end_time, text: words.map(w => w.text + w.punctuation).join(''), words };
      return json({ output: { sentence, text: sentence.text } });
  }
}
function answerMt(b, content, res, json) {
  {
      let out;
      if (/^Lines: /m.test(content)) {
        // Câu lệnh tiếng Anh: khoá 'text'.
        const lines = JSON.parse(content.match(/^Lines: (.*)$/m)[1]);
        const wrong = content.includes('WRONGLANG') || (content.includes('EMPTYFIRST') && /^Translate again/.test(content));
        const empty = content.includes('EMPTYFIRST') && !/^Translate again/.test(content);
        out = { cues: lines.map(l => ({ id: l.id, text: l.zh.includes('陀螺') && empty ? '' : wrong && l.zh.includes('陀螺') ? WRONG : pick(EN, l.zh) })) };
      } else {
        const lines = JSON.parse(content.match(/^Các dòng: (.*)$/m)[1]);
        out = { pronouns: { pairs: [] }, cues: lines.map(l => ({ id: l.id, vi: pick(VI, l.zh) })) };
      }
      const text = JSON.stringify(out);
      if (!b.stream) return json({ choices: [{ message: { role: 'assistant', content: text } }] });
      // Stream (SSE) từng mẩu để server gửi dòng tạm.
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const step = Math.ceil(text.length / 6);
      for (let i = 0; i < text.length; i += step) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + step) } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
  }
}
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
const port = 24787 + Math.floor(Math.random() * 1000);
const WORK = path.join(TMP, 'work');
const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), TOD_WORK: WORK, FFMPEG: ffmpeg, DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '',
    OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: '', DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1',
    FUNASR_MODEL: 'fun-asr-flash-2026-06-15', MAX_PARALLEL: '4', TOD_CONDENSE: '', MT_TIMEOUT_MS: '2000', TOD_DUMP: '1' },   // TOD_DUMP như server đo (alpha/dev/real)
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));

// Trả { status, lines: [obj…] } (NDJSON hay JSON thường); last = kết quả cuối.
async function post(body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  const lines = text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  return { status: res.status, lines, last: lines.at(-1) };
}
const base = (id, extra) => ({ id, desc: '一起去吃火锅', hashtags: ['美食'], lyrics: true, ...extra });
const cacheFiles = () => fs.readdirSync(path.join(WORK, 'cache')).filter(f => !f.includes('.asr.')).sort();
const readFile = (f) => JSON.parse(fs.readFileSync(path.join(WORK, 'cache', f), 'utf8'));
const V = JSON.parse(await (await fetch(`http://127.0.0.1:${port}/health`)).text()).version;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const counts = () => ({ asr: asrCalls, mt: mtBodies.length });
try {
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  t('/health có targets (vi, en)', () => assert.deepEqual(health.targets, Object.keys(TARGETS)));

  // 1. Tiếng Anh, stream: câu lệnh tiếng Anh, file .en.lyr., target trong kết quả và mọi dòng tạm, không gửi source.
  const A = '7500000000000000401';
  const c0 = counts();
  const a = await post(base(A, { target: 'en', from: 0, to: 10, audioStart: 0, aac: aac(12), stream: true, pronouns: { pairs: [{ who: 'a → b', self: 'mình', other: 'bạn' }] } }));
  t('tiếng Anh: kết quả ok, target en, chữ dịch tiếng Anh trong trường vi, không có source', () => {
    assert.equal(a.last.status, 'ok', JSON.stringify(a.last));
    assert.equal(a.last.target, 'en');
    assert.deepEqual(a.last.cues.map(c => c.vi), [EN.大家好, EN.王小明, EN.陀螺]);
    assert.equal(a.last.source, undefined);
    assert.equal(a.last.pronouns, undefined, 'tiếng Anh không có bảng xưng hô');
  });
  t('tiếng Anh: câu lệnh tiếng Anh, khoá text, bỏ bảng xưng hô gửi lên', () => {
    const p = mtBodies.at(-1);
    assert.match(p, /^Translate these Douyin video subtitles from Chinese into natural English/);
    assert.doesNotMatch(p, /mình|xưng hô|Các dòng/);
    assert.equal(counts().asr - c0.asr, 1);
  });
  t('tiếng Anh: max_chars theo 20 ký tự/giây (chuẩn Netflix English cho người lớn), tiếng Việt vẫn 17', () => {
    const lines = JSON.parse(mtBodies[c0.mt].match(/^Lines: (.*)$/m)[1]);
    assert.deepEqual(lines.map(l => l.max_chars), a.last.cues.map(c => Math.floor(Math.min(84, 20 * (c.end - c.start)))));
    assert.equal(TARGETS.vi.cps, 17);
  });
  t('tiếng Anh: dòng tạm có target en', () => {
    const parts = a.lines.filter(l => l.partial);
    assert.ok(parts.length >= 1, 'không có dòng tạm');
    for (const l of parts) assert.equal(l.target, 'en');
  });
  t('tiếng Anh: file .en.lyr. có source (dòng gốc, before, các trường chung)', () => {
    const f = `${A}.0-10.en.lyr.${V}.json`;
    assert.ok(cacheFiles().includes(f), cacheFiles().join(', '));
    const x = readFile(f);
    assert.equal(x.target, 'en');
    assert.deepEqual(x.source.cues.map(c => c.zh), ['大家好，今天我们去吃火锅。', '王小明很喜欢这家店。', '这个陀螺很好玩。']);
    for (const k of ['seconds', 'sung', 'sentences', 'heard', 'asr']) assert.ok(k in x.source.base, 'thiếu ' + k);
    assert.ok(x.source.debug.features && x.source.debug.sentences, 'thiếu debug.features/sentences');
    assert.ok(Array.isArray(x.source.before));
  });

  // 2. Đổi sang tiếng Việt, không kèm âm thanh: 0 lần nhận dạng, 1 lần dịch (câu lệnh tiếng Việt), mốc giống hệt.
  const c1 = counts();
  const b = await post(base(A, { target: 'vi', from: 0, to: 10, retarget: true, stream: true }));
  t('đổi ngôn ngữ: dịch từ dòng gốc đã lưu, không nhận dạng lại, mốc giống hệt', () => {
    assert.equal(b.last.status, 'ok', JSON.stringify(b.last));
    assert.equal(b.last.target, 'vi');
    assert.equal(counts().asr - c1.asr, 0, 'nhận dạng lại');
    assert.equal(counts().mt - c1.mt, 1);
    assert.match(mtBodies.at(-1), /^Dịch phụ đề video Douyin/);
    assert.deepEqual(b.last.cues.map(c => [c.start, c.end, c.zh]), a.last.cues.map(c => [c.start, c.end, c.zh]));
    assert.deepEqual(b.last.cues.map(c => c.vi), [VI.大家好, VI.王小明, VI.陀螺]);
    assert.ok(cacheFiles().includes(`${A}.0-10.vi.lyr.${V}.json`));
    for (const l of b.lines.filter(l => l.partial)) assert.equal(l.target, 'vi');
  });
  const bEn = await post(base(A, { target: 'en', from: 0, to: 10, retarget: true }));
  const bVi = await post(base(A, { target: 'vi', from: 0, to: 10, retarget: true }));
  t('hỏi lại: lấy từ cache đúng ngôn ngữ, có target, không source', () => {
    assert.equal(bEn.last.cached, true); assert.equal(bEn.last.target, 'en'); assert.equal(bEn.last.cues[0].vi, EN.大家好);
    assert.equal(bVi.last.cached, true); assert.equal(bVi.last.target, 'vi'); assert.equal(bVi.last.cues[0].vi, VI.大家好);
    assert.equal(bEn.last.source, undefined); assert.equal(bVi.last.source, undefined);
  });

  // 3. Đổi ngôn ngữ cho đoạn chưa có ở ngôn ngữ nào: need_audio, không ghi cache.
  const c3 = counts();
  const na = await post(base(A, { target: 'en', from: 10, to: 20, retarget: true }));
  t('đổi ngôn ngữ cho đoạn chưa dịch: need_audio, không gọi dịch vụ nào, không cache', () => {
    assert.equal(na.status, 200);
    assert.equal(na.last.status, 'need_audio');
    assert.equal(na.last.target, 'en');
    assert.deepEqual(counts(), c3);
    assert.ok(!cacheFiles().some(f => f.startsWith(`${A}.10-20.`)));
  });

  // 4. Yêu cầu kiểu cũ (không target): như trước, tiếng Việt, file .vi.lyr., ngữ cảnh từ đoạn trước cùng ngôn ngữ.
  const old = await post(base(A, { from: 10, to: 20, audioStart: 8.5, prev: [0, 10], aac: aac(16) }));
  t('yêu cầu kiểu cũ: tiếng Việt, file .vi.lyr., ngữ cảnh đoạn trước tiếng Việt', () => {
    assert.equal(old.last.status, 'ok', JSON.stringify(old.last));
    assert.equal(old.last.target, 'vi');
    assert.ok(cacheFiles().includes(`${A}.10-20.vi.lyr.${V}.json`));
    const p = mtBodies.at(-1);
    assert.match(p, /Các dòng ngay trước trong video \(đã dịch/);
    assert.ok(p.includes(VI.陀螺), 'ngữ cảnh không phải dòng tiếng Việt của đoạn trước');
  });
  // Tiếng Anh cho đoạn đó: có dòng gốc tiếng Việt → không nhận dạng; ngữ cảnh lấy từ đoạn trước tiếng Anh (khoá text).
  const c4 = counts();
  const en2 = await post(base(A, { target: 'en', from: 10, to: 20, audioStart: 8.5, prev: [0, 10], aac: aac(16) }));
  t('tiếng Anh cho đoạn đã có tiếng Việt (kèm âm thanh): dịch từ dòng gốc, ngữ cảnh tiếng Anh với khoá text', () => {
    assert.equal(en2.last.status, 'ok', JSON.stringify(en2.last));
    assert.equal(counts().asr - c4.asr, 0);
    const p = mtBodies.at(-1);
    assert.match(p, /The lines just before in the video/);
    assert.ok(p.includes(JSON.stringify({ zh: '这个陀螺很好玩。', text: EN.陀螺 })), 'ngữ cảnh tiếng Anh');
    assert.ok(!p.includes(VI.陀螺), 'lẫn ngữ cảnh tiếng Việt');
  });

  // 5. Vừa đổi ngôn ngữ: đoạn trước chỉ có tiếng Việt → dòng gốc của nó làm "lời nói ngay trước" cho tiếng Anh.
  const B = '7500000000000000402';
  await post(base(B, { from: 0, to: 10, audioStart: 0, aac: aac(12) }));
  const sw = await post(base(B, { target: 'en', from: 10, to: 20, audioStart: 8.5, prev: [0, 10], aac: aac(16) }));
  t('vừa đổi ngôn ngữ: dòng gốc đoạn trước (ngôn ngữ khác) thành lời nói ngay trước', () => {
    assert.equal(sw.last.status, 'ok', JSON.stringify(sw.last));
    const p = mtBodies.at(-1);
    assert.match(p, /^Speech just before these lines/m);
    assert.ok(p.includes('这个陀螺很好玩。'));
    assert.ok(!p.includes(VI.陀螺), 'lẫn bản dịch tiếng Việt');
    assert.equal(sw.last.before, 3);
  });

  // 6. Kết quả bỏ qua (im lặng) dùng lại cho ngôn ngữ khác, đóng dấu target mới; không gọi dịch vụ nào.
  const C = '7500000000000000403';
  const s1 = await post(base(C, { from: 0, to: 8, audioStart: 0, aac: aac(8) }));
  const c6 = counts();
  const s2 = await post(base(C, { target: 'en', from: 0, to: 8, retarget: true }));
  t('kết quả bỏ qua: dùng lại cho tiếng Anh, target en, không gọi dịch vụ', () => {
    assert.equal(s1.last.status, 'skipped');
    assert.equal(s2.last.status, 'skipped');
    assert.equal(s2.last.label, s1.last.label);
    assert.equal(s2.last.target, 'en');
    assert.equal(s2.last.reused, 'vi');
    assert.deepEqual(counts(), c6);
    assert.ok(cacheFiles().includes(`${C}.0-8.en.lyr.${V}.json`));
  });

  // 7. Model trả câu tiếng Việt khi dịch sang tiếng Anh: vào lượt dịch lại; vẫn sai thì vẫn giữ, ghi log wrong_lang.
  // café, Pokémon, tên pinyin không bị bắt.
  const D = '7500000000000000404';
  const w = await post(base(D, { target: 'en', desc: '陀螺 WRONGLANG', from: 0, to: 10, audioStart: 0, aac: aac(12) }));
  t('sai ngôn ngữ: dòng tiếng Việt vào lượt dịch lại, vẫn sai thì vẫn giữ; café/Pokémon không bị bắt', () => {
    assert.equal(w.last.status, 'ok', JSON.stringify(w.last));
    const retry = mtBodies.at(-1);
    assert.match(retry, /^Translate again these Douyin subtitle lines/);
    const ids = JSON.parse(retry.match(/^Lines: (.*)$/m)[1]).map(l => l.zh);
    assert.deepEqual(ids, ['这个陀螺很好玩。'], 'chỉ dòng sai ngôn ngữ được dịch lại');
    assert.deepEqual(w.last.cues.map(c => c.vi), [EN.大家好, EN.王小明, WRONG]);
    assert.match(log, /1 dòng sai ngôn ngữ \(wrong_lang\) vẫn hiện/);
  });
  t('kiểm sai ngôn ngữ (hàm): café, Pokémon, Rosé, Lǐ Míng không bị bắt; câu tiếng Việt bị bắt', () => {
    const wl = TARGETS.en.wrongLang;
    for (const s of ['Wang Xiaoming loves café and Pokémon.', 'Rosé sings with Lǐ Míng.', 'Hello my friend, how are you?']) assert.equal(wl(s), false, s);
    for (const s of ['Xin chào các bạn, hôm nay đi ăn lẩu.', WRONG, 'Mình đang đứng trước cổng trụ sở BLG']) assert.equal(wl(s), true, s);
  });

  // 7b. Lượt đầu bỏ trống dòng, lượt dịch lại trả tiếng Việt: giữ câu (gắn wrong_lang), không mất câu (verifier 4/11, F5).
  const D2 = '7500000000000000405';
  const w2 = await post(base(D2, { target: 'en', desc: '陀螺 EMPTYFIRST', from: 0, to: 10, audioStart: 0, aac: aac(12) }));
  t('dòng trống ở lượt đầu, lượt dịch lại sai ngôn ngữ: vẫn giữ câu', () => {
    assert.deepEqual(w2.last.cues.map(c => c.vi), [EN.大家好, EN.王小明, WRONG]);
  });

  // 9. Hai ngôn ngữ cùng lúc cho cùng một đoạn (đổi ngôn ngữ lúc đoạn đang chạy): ngôn ngữ sau chờ việc đang chạy, dịch từ dòng
  // gốc của nó; chỉ một lần nhận dạng. Yêu cầu không âm thanh lúc đó cũng chờ, không trả need_audio (verifier 4/11, F2).
  const E = '7500000000000000406';
  asrDelay = 300;
  const c9 = counts();
  const [p1, p2, p3] = await Promise.all([
    post(base(E, { from: 0, to: 10, audioStart: 0, aac: aac(12) })),
    new Promise(r => setTimeout(r, 50)).then(() => post(base(E, { target: 'en', from: 0, to: 10, audioStart: 0, aac: aac(12) }))),
    new Promise(r => setTimeout(r, 100)).then(() => post(base(E, { target: 'en', from: 0, to: 10, retarget: true }))),
  ]);
  asrDelay = 0;
  t('hai ngôn ngữ cùng lúc: một lần nhận dạng, ngôn ngữ sau dịch từ dòng gốc, yêu cầu không âm thanh chờ chứ không need_audio', () => {
    assert.equal(p1.last.status, 'ok', JSON.stringify(p1.last));
    assert.equal(p2.last.status, 'ok', JSON.stringify(p2.last));
    assert.equal(p3.last.status, 'ok', JSON.stringify(p3.last));
    assert.equal(p2.last.retargeted, 'vi');
    assert.equal(counts().asr - c9.asr, 1, 'nhận dạng hai lần');
  });
  t('TOD_DUMP=1 (server đo): yêu cầu có âm thanh vẫn chạy, giữ âm thanh ở work/dump', () => {
    assert.ok(fs.readdirSync(path.join(WORK, 'dump')).some(f => f.endsWith('.aac')));
  });

  // 8. Ngôn ngữ lạ: 400; bump theo ngôn ngữ.
  const bad = await post(base(A, { target: 'xx', from: 0, to: 10, audioStart: 0, aac: aac(12) }));
  t('ngôn ngữ đích lạ: 400 unsupported_target kèm danh sách', () => {
    assert.equal(bad.status, 400);
    assert.equal(bad.last.error, 'unsupported_target');
    assert.deepEqual(bad.last.targets, Object.keys(TARGETS));
  });
  const bump = await (await fetch(`http://127.0.0.1:${port}/v1/bump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: A, from: 0, to: 10, target: 'en' }) })).json();
  t('bump nhận target', () => assert.equal(bump.ok, true));
} catch (e) {
  console.log(log);
  throw e;
} finally {
  server.kill(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

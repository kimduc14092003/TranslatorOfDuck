// Câu lệnh gửi dịch vụ dịch khi dịch sang tiếng Việt phải giữ nguyên từng chữ khi tách gói ngôn ngữ (ROADMAP giai đoạn 1,
// bước 1.1). Chạy qua server thật với dịch vụ giả: lượt dịch đầu (người đăng, mô tả, lời hát, rút gọn), đoạn sau có ngữ cảnh
// đọc từ file đoạn trước và bảng xưng hô, lượt dịch lại (dòng trống, dòng còn chữ Hán), đoạn có ngữ cảnh xa và lời nói ngay
// trước. So mọi body gửi dịch vụ dịch với dev/golden/prompts-vi.json; GOLDEN_WRITE=1 ghi lại file đó (chỉ khi cố ý đổi câu lệnh).
// Không cần key, không cần mạng; cần ffmpeg.   Chạy: node dev/prompt-golden-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden', 'prompts-vi.json');
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-golden-'));
const aac = (sec) => { const f = path.join(TMP, `${sec}.aac`); execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, '-c:a', 'aac', f]); return fs.readFileSync(f).toString('base64'); };

// Mỗi chữ một "từ" như Fun-ASR trả, bắt đầu ở giây `at` (tính từ đầu âm thanh gửi lên), mỗi chữ `per` giây.
const chars = (text, at, per) => {
  const out = [];
  for (const ch of text) {
    if (/[，。？！]/.test(ch)) { out[out.length - 1].punctuation = ch; continue; }
    out.push({ text: ch, begin_time: Math.round(at * 1000), end_time: Math.round((at + per) * 1000), punctuation: '' });
    at += per;
  }
  return out;
};
// Đoạn [0,10) (âm thanh 12 s từ 0): câu nói, câu hát (0,6 s/chữ), câu nói. Đoạn [10,20) (âm thanh 16 s từ 8,5). Đoạn [40,70)
// (âm thanh 24 s từ 32: gửi dư 8 s, có lời nói ngay trước đoạn).
const WORDS = {
  12: [...chars('大家好，今天我们去吃火锅。', 0.5, 0.2), ...chars('月亮代表我的心。', 3.6, 0.6), ...chars('这个陀螺很好玩。', 8.6, 0.18)],
  16: [...chars('你好吗？', 2, 0.2), ...chars('我很好，谢谢。', 3.5, 0.2), ...chars('B站联名眼镜就退款。', 6, 0.2)],
  24: [...chars('刚才说到哪里了。', 2, 0.2), ...chars('我们继续吧。', 9, 0.2)],
};
const sentence = (words) => ({ begin_time: words[0].begin_time, end_time: words.at(-1).end_time, text: words.map(w => w.text + w.punctuation).join(''), words });

const bodies = [];
// Bản dịch giả theo chữ gốc: dòng dài để có lượt rút gọn; 你好吗 dịch được ngay; 我很好 bỏ trống và 站 còn chữ Hán ở lượt đầu (có
// lượt dịch lại).
const firstVi = (zh) => zh.includes('大家好') ? 'Chào cả nhà thân mến của mình, hôm nay chúng ta sẽ cùng nhau đi ăn lẩu ở một quán rất nổi tiếng nhé.'
  : zh.includes('月亮') ? 'Ánh trăng nói hộ lòng anh' : zh.includes('陀螺') ? 'Con quay này vui lắm.' : zh.includes('我很好') ? null
  : zh.includes('站') ? 'Kính hợp tác B站 được hoàn tiền.' : 'Câu dịch giả.';
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      const b64 = JSON.parse(body).input.messages[0].content[0].input_audio.data;
      const seconds = Math.round((Buffer.from(b64.split(',')[1], 'base64').length * 8) / 48000);
      const words = WORDS[seconds < 14 ? 12 : seconds < 20 ? 16 : 24];
      return json({ output: { sentence: sentence(words), text: sentence(words).text } });
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const b = JSON.parse(body);
      bodies.push(b);
      const content = b.messages[0].content;
      const lines = JSON.parse(content.match(/^Các dòng: (.*)$/m)[1]);
      let cues;
      if (/^Rút gọn/.test(content)) cues = lines.map(l => ({ id: l.id, vi: 'Chào cả nhà, hôm nay đi ăn lẩu.' }));
      else if (/^Dịch lại/.test(content)) cues = lines.map(l => ({ id: l.id, vi: l.zh.includes('站') ? 'Kính hợp tác Bilibili được hoàn tiền.' : 'Mình khoẻ, cảm ơn.' }));
      else cues = lines.map(l => ({ id: l.id, vi: firstVi(l.zh) })).filter(c => c.vi != null);
      const out = /^Rút gọn|^Dịch lại/.test(content) ? { cues } : { pronouns: { pairs: [{ who: 'người nói → người xem', self: 'mình', other: 'cả nhà' }] }, cues };
      return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify(out) } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;
const port = 23787 + Math.floor(Math.random() * 1000);
// TOD_CONDENSE=1: có lượt rút gọn trong lượt dịch (đoạn không gấp), để chụp cả câu lệnh rút gọn.
const server = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
  env: { ...process.env, PORT: String(port), TOD_WORK: path.join(TMP, 'work'), FFMPEG: ffmpeg, DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '',
    OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: '', DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1',
    FUNASR_MODEL: 'fun-asr-flash-2026-06-15', MAX_PARALLEL: '1', TOD_CONDENSE: '1', MT_TIMEOUT_MS: '2000' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });
while (!/Alpha server/.test(log)) await new Promise(r => setTimeout(r, 50));

const ID = '7500000000000000301';
const post = (extra) => fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ id: ID, desc: '一起去吃火锅 #美食', hashtags: ['美食', '火锅'], author: '小红', authorGender: 'female', lyrics: true, ...extra }) }).then(r => r.json());
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
try {
  const a = await post({ from: 0, to: 10, audioStart: 0, aac: aac(12) });
  const b = await post({ from: 10, to: 20, audioStart: 8.5, prev: [0, 10], aac: aac(16), pronouns: { pairs: [{ who: 'người nói → người xem', self: 'mình', other: 'các bạn' }] } });
  const c = await post({ from: 40, to: 70, audioStart: 32, prev: [20, 40], aac: aac(24) });
  t('ba đoạn đều có kết quả; có lượt rút gọn, lượt dịch lại, ngữ cảnh gần và xa', () => {
    for (const x of [a, b, c]) assert.equal(x.status, 'ok', JSON.stringify(x));
    assert.ok(bodies.some(x => /^Rút gọn/.test(x.messages[0].content)), 'không có lượt rút gọn');
    assert.ok(bodies.some(x => /^Dịch lại/.test(x.messages[0].content)), 'không có lượt dịch lại');
    assert.ok(bodies.some(x => x.messages[0].content.includes('Các dòng ngay trước trong video (đã dịch')), 'không có ngữ cảnh gần');
    assert.ok(bodies.some(x => x.messages[0].content.includes('Các dòng đã dịch ở một đoạn trước đó')), 'không có ngữ cảnh xa');
    assert.ok(bodies.some(x => x.messages[0].content.includes('Lời nói ngay trước các dòng này')), 'không có lời nói ngay trước');
  });
  if (process.env.GOLDEN_WRITE === '1') {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(bodies, null, 1) + '\n');
    console.log(`đã ghi ${GOLDEN} (${bodies.length} lần gọi dịch)`);
  } else {
    const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    t(`câu lệnh tiếng Việt giống hệt bản ghi (${want.length} lần gọi dịch)`, () => {
      assert.equal(bodies.length, want.length, 'số lần gọi dịch');
      want.forEach((w, i) => {
        const g = bodies[i];
        if (JSON.stringify(g) === JSON.stringify(w)) return;
        const gl = g.messages[0].content.split('\n'), wl = w.messages[0].content.split('\n');
        const at = gl.findIndex((l, k) => l !== wl[k]);
        assert.fail(`lần gọi ${i + 1} khác bản ghi` + (at >= 0 ? ` ở dòng ${at + 1} của câu lệnh:\n  có:  ${gl[at]}\n  cần: ${wl[at]}` : ': khác ngoài câu lệnh (schema, model, nhiệt độ)'));
      });
    });
  }
} finally {
  server.kill(); providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

// Kiểm tra dòng trạng thái server trong alpha/extension/popup.js (không cần trình duyệt): chạy popup.js trong vm với
// document, chrome và fetch giả; /health trả đúng các dạng config() của alpha/server/pipeline.mjs.
// Chạy: node alpha/dev/popup-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const EXT = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'extension');
const SRC = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');

// health: câu trả lời của /health, hoặc null khi không kết nối được server.
async function run(health) {
  const els = {};
  const document = { getElementById: (id) => (els[id] ||= { id, checked: false, value: '', textContent: '', className: '', addEventListener() {} }) };
  const chrome = {
    storage: { local: { get: async () => ({}), set: async () => {} } },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => { throw new Error('no tab'); } },
  };
  const fetch = async () => {
    if (!health) throw new TypeError('Failed to fetch');
    return { json: async () => JSON.parse(JSON.stringify(health)) };
  };
  vm.runInContext(SRC, vm.createContext({ document, chrome, fetch }));
  for (let i = 0; i < 50 && (!els.health || els.health.textContent === 'Đang kiểm tra…' || !els.health.textContent); i++) await new Promise((r) => setImmediate(r));
  return { text: els.health.textContent, cls: els.health.className };
}

const FUN = 'fun-asr-flash-2026-06-15', QWEN = 'qwen-audio-3.1-asr-flash';
const CASES = [
  ['Fun-ASR nhận dạng, OpenAI dịch', { ok: true, asr: 'funasr', asrModel: FUN, asrModels: [FUN, QWEN], mt: 'openai' },
    'ok', (t) => t === 'Server chạy. Nhận dạng: Fun-ASR, dịch: OpenAI.'],
  ['Fun-ASR hết hạn mức: dùng model dự phòng', { ok: true, asr: 'funasr', asrModel: QWEN, asrModels: [FUN, QWEN], asrFallback: true, mt: 'openai' },
    'ok', (t) => t === `Server chạy. Nhận dạng: ${QWEN} (Fun-ASR hết hạn mức), dịch: OpenAI.`],
  ['hết hạn mức cả model dự phòng', { ok: true, asr: 'funasr', asrModel: null, asrModels: [FUN, QWEN], mt: 'openai' },
    'bad', (t) => /Nhận dạng: hết hạn mức \(cả model dự phòng\), dịch: OpenAI\./.test(t)],
  ['Gemini nhận dạng (không có DASHSCOPE_API_KEY), OpenAI dịch', { ok: true, asr: 'gemini', mt: 'openai' },
    'ok', (t) => t === 'Server chạy. Nhận dạng: Gemini, dịch: OpenAI.'],
  ['chỉ có GEMINI_API_KEY', { ok: true, asr: 'gemini', mt: 'gemini' },
    'ok', (t) => t === 'Server chạy. Nhận dạng: Gemini, dịch: Gemini.'],
  // Máy Windows của chủ dự án (3/11): .env chỉ có OPENAI_API_KEY. Trước đây popup ghi "Nhận dạng: Gemini" dù không có
  // key Gemini, mọi đoạn lại báo lỗi thiếu key nhận dạng.
  ['chỉ có OPENAI_API_KEY: báo thiếu key nhận dạng, không ghi Gemini', { ok: true, asr: null, mt: 'openai' },
    'bad', (t) => /^Server chạy/.test(t) && /Dịch: OpenAI/.test(t) && /không có sub/.test(t) && /DASHSCOPE_API_KEY/.test(t)
      && /GEMINI_API_KEY/.test(t) && /alpha\/server\/\.env/.test(t) && !/Nhận dạng: Gemini/.test(t)],
  ['chỉ có DASHSCOPE_API_KEY: báo thiếu key dịch', { ok: true, asr: 'funasr', asrModel: FUN, asrModels: [FUN, QWEN], mt: null },
    'bad', (t) => t === 'Server chạy nhưng thiếu OPENAI_API_KEY hoặc GEMINI_API_KEY trong alpha/server/.env.'],
  ['chưa có key nào', { ok: true, asr: null, mt: null },
    'bad', (t) => t === 'Server chạy nhưng thiếu OPENAI_API_KEY hoặc GEMINI_API_KEY trong alpha/server/.env.'],
  ['không kết nối được server', null,
    'bad', (t) => /^Không kết nối được\./.test(t)],
];

let pass = 0, fail = 0;
for (const [name, health, cls, ok] of CASES) {
  const got = await run(health);
  try {
    assert.equal(got.cls, cls, 'className');
    assert.ok(ok(got.text), 'text: ' + got.text);
    pass++; console.log('ok  ', name);
  } catch (e) { fail++; console.log('FAIL', name, '→', e.message); }
}
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

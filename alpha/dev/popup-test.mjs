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
// stored: cài đặt đã lưu (chrome.storage.local); writes: các lần popup ghi.
// posts: các lần popup gửi POST (ô "Dịch bằng": /v1/mt); afterPost: /health trả sau lần POST đầu (null: giữ health).
async function run(health, stored = {}, writes = [], posts = [], afterPost = null) {
  const els = {};
  const el = (id) => ({ id, checked: false, value: '', textContent: '', className: '', disabled: false, children: [], listeners: {},
    addEventListener(t, f) { this.listeners[t] = f; }, replaceChildren(...c) { this.children = c; } });
  const document = { getElementById: (id) => (els[id] ||= el(id)), createElement: () => el(null) };
  const chrome = {
    storage: { local: { get: async () => ({ settings: { ...stored } }), set: async (o) => { writes.push(o.settings); stored = o.settings; } } },
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => { throw new Error('no tab'); } },
  };
  const fetch = async (url, init) => {
    if (init && init.method === 'POST') {
      posts.push({ url, body: JSON.parse(init.body) });
      if (afterPost && afterPost.reject) return { ok: false, status: 400, json: async () => afterPost.reject };
      if (afterPost) health = afterPost;
      return { ok: true, json: async () => ({ ok: true, ...(afterPost && afterPost.saved === false ? { saved: false } : {}) }) };
    }
    if (!health) throw new TypeError('Failed to fetch');
    return { json: async () => JSON.parse(JSON.stringify(health)) };
  };
  vm.runInContext(SRC, vm.createContext({ document, chrome, fetch }));
  for (let i = 0; i < 50 && (!els.health || els.health.textContent === 'Đang kiểm tra…' || !els.health.textContent); i++) await new Promise((r) => setImmediate(r));
  return { text: els.health.textContent, cls: els.health.className, els };
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
    'bad', (t) => /^Không kết nối được\./.test(t)],  // Ngôn ngữ đích (giai đoạn 1): server cũ không có targets.
  ['đang chọn English, server cũ (không có targets): báo server cũ chỉ dịch tiếng Việt', [{ ok: true, asr: 'funasr', asrModel: FUN, asrModels: [FUN, QWEN], mt: 'openai' }, { target: 'en' }],
    'bad', (t) => /^Server chạy\. Nhận dạng: Fun-ASR, dịch: OpenAI\. Server cũ chỉ dịch tiếng Việt/.test(t)],
  ['đang chọn English, server mới có targets: bình thường', [{ ok: true, asr: 'funasr', asrModel: FUN, asrModels: [FUN, QWEN], mt: 'openai', targets: ['vi', 'en'] }, { target: 'en' }],
    'ok', (t) => t === 'Server chạy. Nhận dạng: Fun-ASR, dịch: OpenAI.'],
  ['tiếng Việt với server cũ: bình thường', [{ ok: true, asr: 'funasr', asrModel: FUN, asrModels: [FUN, QWEN], mt: 'openai' }, {}],
    'ok', (t) => t === 'Server chạy. Nhận dạng: Fun-ASR, dịch: OpenAI.'],
];

let pass = 0, fail = 0;
for (const [name, h, cls, ok] of CASES) {
  const [health, stored] = Array.isArray(h) ? h : [h, {}];
  const got = await run(health, stored);
  try {
    assert.equal(got.cls, cls, 'className');
    assert.ok(ok(got.text), 'text: ' + got.text);
    pass++; console.log('ok  ', name);
  } catch (e) { fail++; console.log('FAIL', name, '→', e.message); }
}
// Đổi một ô chỉ ghi cài đặt đã lưu cộng ô đó, không ghi giá trị mặc định (verifier 4/11, F16); ô "Dịch sang" ghi target.
{
  const writes = [];
  const got = await run(null, { lyrics: false }, writes);
  try {
    assert.equal(got.els.target.value, 'vi', 'mặc định tiếng Việt');
    got.els.target.listeners.change({ target: { value: 'en' } });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(JSON.stringify(writes[0]), JSON.stringify({ lyrics: false, target: 'en' }));
    pass++; console.log('ok   ô Dịch sang ghi target, không ghi giá trị mặc định');
  } catch (e) { fail++; console.log('FAIL ô Dịch sang →', e.message); }
}
// Ô "Dịch trước cả video khi rảnh": mặc định tắt, tích thì ghi fullAhead: true (content.js, web.js đọc).
{
  const writes = [];
  const got = await run(null, {}, writes);
  try {
    assert.equal(got.els.fullAhead.checked, false);
    got.els.fullAhead.listeners.change({ target: { checked: true } });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    assert.equal(JSON.stringify(writes[0]), JSON.stringify({ fullAhead: true }));
    pass++; console.log('ok   ô Dịch trước cả video: mặc định tắt, tích thì ghi fullAhead');
  } catch (e) { fail++; console.log('FAIL ô Dịch trước cả video →', e.message); }
}
// Ô "Dịch bằng": liệt kê dịch vụ có key (health.mts) kèm model, đánh dấu mặc định, chọn đúng dịch vụ server đang dùng;
// đổi thì POST /v1/mt rồi kiểm lại server. Một dịch vụ, server cũ, không có server: khoá ô.
const MTS = { ok: true, asr: 'funasr', asrModel: FUN, asrModels: [FUN, QWEN], targets: ['vi', 'en'],
  mts: [{ id: 'openai', model: 'gpt-x' }, { id: 'qwen', model: 'qwen-flash' }], mtDefault: 'openai' };
const step = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
{
  const posts = [], writes = [];
  const got = await run({ ...MTS, mt: 'openai', model: 'gpt-x' }, {}, writes, posts, { ...MTS, mt: 'qwen', model: 'qwen-flash' });
  try {
    const sel = got.els.mt;
    assert.deepEqual(sel.children.map((o) => [o.value, o.textContent]), [['openai', 'OpenAI (gpt-x) · mặc định'], ['qwen', 'Qwen (qwen-flash)']]);
    assert.equal(sel.value, 'openai');
    assert.equal(sel.disabled, false);
    assert.equal(got.text, 'Server chạy. Nhận dạng: Fun-ASR, dịch: OpenAI (gpt-x).');
    sel.listeners.change({ target: { value: 'qwen' } });
    await step();
    assert.deepEqual(posts, [{ url: 'http://127.0.0.1:8787/v1/mt', body: { mt: 'qwen' } }]);
    assert.equal(sel.value, 'qwen');
    assert.equal(got.els.health.textContent, 'Server chạy. Nhận dạng: Fun-ASR, dịch: Qwen (qwen-flash).');
    assert.equal(typeof writes.at(-1).mtGen, 'number', 'ghi mtGen để tab bỏ thời gian chờ của dịch vụ cũ');
    pass++; console.log('ok   ô Dịch bằng: liệt kê, đổi gửi /v1/mt, dòng trạng thái theo dịch vụ mới');
  } catch (e) { fail++; console.log('FAIL ô Dịch bằng →', e.message); }
}
// Server từ chối (400) hay không lưu được: lời báo còn sau khi popup kiểm lại server; bị từ chối thì không ghi mtGen.
for (const [name, after, note, gen] of [
  ['bị từ chối', { reject: { error: 'mt_unavailable' } }, /^Không đổi được: dịch vụ này không có key/, false],
  ['không lưu được', { ...MTS, mt: 'qwen', saved: false }, /bật lại server sẽ về như cũ/, true],
]) {
  const writes = [];
  const got = await run({ ...MTS, mt: 'openai' }, {}, writes, [], after);
  try {
    got.els.mt.listeners.change({ target: { value: 'qwen' } });
    await step();
    assert.match(got.els.mtNote.textContent, note);
    assert.equal(writes.some((w) => w.mtGen), gen);
    pass++; console.log('ok   ô Dịch bằng khi ' + name);
  } catch (e) { fail++; console.log('FAIL ô Dịch bằng khi ' + name + ' →', e.message); }
}
// Dịch vụ mặc định không có key (mt null) mà còn đúng một dịch vụ: vẫn chọn được (Astra F8). Server cũ: ô hiện dịch vụ đang dùng (F9).
{
  const got = await run({ ...MTS, mts: [{ id: 'qwen', model: 'qwen-flash' }], mt: null });
  const old = await run({ ok: true, asr: 'funasr', asrModel: FUN, asrModels: [FUN, QWEN], mt: 'openai' });
  try {
    assert.equal(got.els.mt.disabled, false);
    assert.deepEqual(got.els.mt.children.map((o) => o.value), ['', 'qwen']);
    assert.deepEqual(old.els.mt.children.map((o) => [o.value, o.textContent]), [['openai', 'OpenAI']]);
    pass++; console.log('ok   ô Dịch bằng: một dịch vụ chưa chọn thì chọn được; server cũ hiện dịch vụ đang dùng');
  } catch (e) { fail++; console.log('FAIL ô Dịch bằng mt null / server cũ →', e.message); }
}
for (const [name, h, note] of [
  ['một dịch vụ', { ...MTS, mts: [{ id: 'qwen', model: 'qwen-flash' }], mt: 'qwen' }, /Chỉ có một dịch vụ/],
  ['server cũ (không có mts)', { ok: true, asr: 'funasr', asrModel: FUN, asrModels: [FUN, QWEN], mt: 'openai' }, /Server cũ/],
  ['không có server', null, /Cần server/],
]) {
  const got = await run(h);
  try {
    assert.equal(got.els.mt.disabled, true);
    assert.match(got.els.mtNote.textContent, note);
    pass++; console.log('ok   ô Dịch bằng khoá khi ' + name);
  } catch (e) { fail++; console.log('FAIL ô Dịch bằng khi ' + name + ' →', e.message); }
}
console.log(`${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);

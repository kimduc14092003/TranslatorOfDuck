// Kiểm tra model nhận dạng dự phòng: Fun-ASR hết hạn mức thì chuyển sang qwen-audio-3.1-asr-flash. Không cần key, không
// cần mạng; cần ffmpeg. Server thật + DashScope giả, mỗi model một cách trả lời.   Chạy: node dev/asr-fallback-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ffmpeg = process.env.FFMPEG || (await import('ffmpeg-static').then(m => m.default).catch(() => null)) || 'ffmpeg';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-asrfb-'));
const aacFile = path.join(TMP, 'a.aac');
execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=22', '-c:a', 'aac', aacFile]);
const AAC = fs.readFileSync(aacFile).toString('base64');
const FUN = 'fun-asr-flash-2026-06-15', QWEN = 'qwen-audio-3.1-asr-flash';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Lỗi đúng như DashScope trả (mã và câu lấy từ tài liệu Model Studio).
const ERR = {
  free: [403, { code: 'AllocationQuota.FreeTierOnly', message: 'The free tier of the model has been exhausted. If you wish to continue access the model on a paid basis, please disable the "use free tier only" mode in the management console.' }],
  arrear: [400, { code: 'Arrearage', message: 'Access denied, please make sure your account is in good standing.' }],
  denied: [403, { code: 'AccessDenied', message: 'Access denied.' }],
  freeThrottle: [429, { code: 'Throttling.AllocationQuota', message: 'Free allocated quota exceeded.' }],
  throttle: [429, { code: 'Throttling.AllocationQuota', message: 'Allocated quota exceeded, please increase your quota limit.' }],
};
const mode = {};                  // model → 'ok' | 'shape' (200 dạng lạ) | 'textOnly' (200 có chữ, không có câu) | 'html502' | khoá trong ERR
const once = {};                  // model → khoá trong ERR chỉ cho lần gọi kế tiếp
const delay = {};                 // model → ms chờ trước khi trả lời
const calls = [];                 // model theo thứ tự được gọi
const providers = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', async () => {
    const json = (o, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.url.endsWith('/multimodal-generation/generation')) {
      const { model } = JSON.parse(body);
      calls.push(model);
      if (delay[model]) await wait(delay[model]);
      const m = once[model] || mode[model];
      delete once[model];
      const e = ERR[m];
      if (e) return json({ ...e[1], request_id: 'test' }, e[0]);
      if (m === 'shape') return json({ output: { choices: [{ message: { content: [{ text: '大家好' }] } }] } });
      if (m === 'textOnly') return json({ output: { text: '大家好，今天我们去吃火锅。' } });
      if (m === 'html502') { res.writeHead(502, { 'content-type': 'text/html' }); return res.end('<html><body>502 Bad Gateway</body></html>'); }
      const words = [['大家', 1000, 1400], ['好', 1400, 1600, '，'], ['今天', 1700, 2000], ['我们', 2000, 2300], ['去', 2300, 2450], ['吃', 2450, 2600], ['火锅', 2600, 3100, '。']]
        .map(([text, b, e2, p]) => ({ text, begin_time: b, end_time: e2, punctuation: p || '' }));
      return json({ output: { sentence: { begin_time: 1000, end_time: 3100, text: '大家好，今天我们去吃火锅。', words }, text: '大家好，今天我们去吃火锅。' } });
    }
    if (req.url.endsWith('/v1/chat/completions')) {
      const lines = JSON.parse(JSON.parse(body).messages[0].content.match(/Các dòng: (.*)$/m)[1]);
      return json({ choices: [{ message: { role: 'assistant', content: JSON.stringify({ cues: lines.map(l => ({ id: l.id, vi: 'Chào cả nhà, hôm nay đi ăn lẩu.' })) }) } }] });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise(r => providers.listen(0, '127.0.0.1', r));
const PROV = `http://127.0.0.1:${providers.address().port}`;

// Cổng trống do hệ điều hành chọn (test chạy 9 server: chọn ngẫu nhiên thì có lúc trùng cổng, server thoát mà test treo).
const freePort = () => new Promise((resolve) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); }); });
const servers = [];
async function start(extra = {}) {
  const port = await freePort();
  for (const k of Object.keys(mode)) delete mode[k];
  const proc = spawn(process.execPath, [path.join(HERE, '..', 'server.mjs')], {
    // Tên model đặt rõ: .env của máy (nếu có FUNASR_MODEL, ASR_FALLBACK_MODEL) không ảnh hưởng.
    env: { ...process.env, PORT: String(port), TOD_WORK: fs.mkdtempSync(path.join(TMP, 'w-')), FFMPEG: ffmpeg,
      DASHSCOPE_API_KEY: 'test', GEMINI_API_KEY: '', OPENAI_API_KEY: 'test-openai', OPENAI_MODEL: 'test-model', OPENAI_REASONING_EFFORT: '',
      FUNASR_MODEL: FUN, ASR_FALLBACK_MODEL: QWEN, ASR_QUOTA_RETRY_MS: '', DASHSCOPE_BASE: PROV, OPENAI_BASE: PROV + '/v1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const s = { proc, port, log: '' };
  servers.push(s);
  proc.stdout.on('data', d => { s.log += d; });
  proc.stderr.on('data', d => { s.log += d; });
  const t0 = Date.now();
  while (!/Alpha server/.test(s.log)) {
    if (proc.exitCode !== null || Date.now() - t0 > 10000) throw new Error('server không khởi động được: ' + s.log.slice(-300));
    await wait(50);
  }
  let n = 0;
  s.post = () => fetch(`http://127.0.0.1:${port}/v1/subtitles`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: '75000000000' + String(port).padStart(5, '0') + String(++n).padStart(3, '0'), from: 0, to: 30, audioStart: 0, urgent: true, aac: AAC }) })
    .then(async r => ({ http: r.status, ...(await r.json()) }));
  s.health = () => fetch(`http://127.0.0.1:${port}/health`).then(r => r.json());
  return s;
}
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const since = (k) => calls.slice(k);
const count = (text, re) => (text.match(re) || []).length;
try {
  const s = await start();
  const h0 = await s.health();
  t('khởi động: log ghi model chính và model dự phòng; /health báo đang dùng Fun-ASR', () => {
    assert.match(s.log, new RegExp(`ASR: funasr ${FUN}, dự phòng ${QWEN}`));
    assert.equal(h0.asrModel, FUN); assert.equal(h0.asrFallback, undefined);
  });

  // Giới hạn theo phút (429 Throttling.AllocationQuota không kèm "Free"): gọi lại như mọi 429, không đổi model.
  once[FUN] = 'throttle';
  let k = calls.length;
  const th = await s.post();
  t('429 Throttling.AllocationQuota theo phút: gọi lại Fun-ASR (chờ ~2 s), không chuyển model', () => {
    assert.equal(th.status, 'ok', JSON.stringify(th)); assert.deepEqual(since(k), [FUN, FUN]);
    assert.equal(th.asrModel, undefined); assert.doesNotMatch(s.log, /hết hạn mức/);
  });

  // DashScope trả 200 mà dạng lạ: báo lỗi, không lưu thành "không có lời".
  mode[FUN] = 'shape';
  const sh = await s.post();
  mode[FUN] = 'ok';
  t('trả 200 mà không có câu, không có chữ: báo lỗi, không coi là "không có lời"', () => {
    assert.equal(sh.status, 'error', JSON.stringify(sh)); assert.match(sh.error, /kết quả lạ/);
  });
  mode[FUN] = 'textOnly';
  const to = await s.post();
  mode[FUN] = 'ok';
  t('trả 200 có chữ mà không có câu (không có mốc thời gian): báo lỗi, không coi là "không có lời"', () => {
    assert.equal(to.status, 'error', JSON.stringify(to)); assert.match(to.error, /kết quả lạ/);
  });
  // Lỗi không phải JSON (trang lỗi HTML của cổng mạng): gọi lại như trước. Bản sửa đầu đọc body.message khi body null nên
  // báo lỗi ngay (verifier, 31/10).
  once[FUN] = 'html502';
  k = calls.length;
  const hb = await s.post();
  t('502 trả trang HTML (không phải JSON): gọi lại Fun-ASR và có sub, không văng lỗi', () => {
    assert.equal(hb.status, 'ok', JSON.stringify(hb)); assert.deepEqual(since(k), [FUN, FUN]);
  });

  mode[FUN] = 'free';
  k = calls.length;
  const a = await s.post();
  t('Fun-ASR hết hạn mức miễn phí (403 AllocationQuota.FreeTierOnly): cùng đoạn đó chuyển ngay sang model dự phòng, vẫn có sub', () => {
    assert.equal(a.status, 'ok', JSON.stringify(a)); assert.ok(a.cues.length >= 1);
    assert.deepEqual(since(k), [FUN, QWEN]);
    assert.equal(a.asrModel, QWEN);
  });
  t('log ghi lý do chuyển và model đã dùng cho đoạn đó', () => {
    assert.match(s.log, new RegExp(`${FUN} hết hạn mức \\(AllocationQuota\\.FreeTierOnly\\): chuyển sang ${QWEN}`));
    assert.match(s.log, new RegExp(`ASR \\d+ ms \\(${QWEN.replace(/\./g, '\\.')}\\)`));
  });
  k = calls.length;
  const b = await s.post();
  const h1 = await s.health();
  t('đoạn sau đi thẳng sang model dự phòng (không gọi lại Fun-ASR); /health báo đang dùng model dự phòng', () => {
    assert.equal(b.status, 'ok'); assert.deepEqual(since(k), [QWEN]);
    assert.equal(h1.asrModel, QWEN); assert.equal(h1.asrFallback, true);
  });

  mode[QWEN] = 'arrear';
  k = calls.length;
  const c = await s.post();
  t('model dự phòng cũng hết (400 Arrearage): báo lỗi hết hạn mức kèm thời gian chờ, không gọi lại Fun-ASR đang tạm nghỉ', () => {
    assert.equal(c.http, 502); assert.equal(c.status, 'error'); assert.match(c.error, /hết hạn mức nhận dạng giọng nói \(cả model dự phòng\)/);
    assert.ok(c.retryAfterMs > 25 * 60 * 1000, JSON.stringify(c));
    assert.deepEqual(since(k), [QWEN]);
    assert.match(s.log, new RegExp(`${QWEN} hết hạn mức \\(Arrearage\\): không còn model nhận dạng nào`));
  });
  k = calls.length;
  const d = await s.post();
  const h2 = await s.health();
  t('trong lúc tạm dừng: báo lỗi ngay, không gọi dịch vụ nhận dạng nào; /health báo không còn model nào (asrModel null)', () => {
    assert.equal(d.status, 'error'); assert.ok(d.retryAfterMs > 0); assert.deepEqual(since(k), []);
    assert.equal(h2.asrModel, null);
  });

  // 429 Throttling.AllocationQuota kèm "Free allocated quota exceeded": hết hạn mức miễn phí, chuyển model.
  const sf = await start();
  mode[FUN] = 'freeThrottle';
  k = calls.length;
  const f1 = await sf.post();
  t('429 Throttling.AllocationQuota "Free allocated quota exceeded": hết hạn mức thật, chuyển ngay sang model dự phòng', () => {
    assert.equal(f1.status, 'ok'); assert.deepEqual(since(k), [FUN, QWEN]);
  });

  // Nhiều đoạn cùng lúc gặp hết hạn mức: đều sang model dự phòng, log ghi việc chuyển một lần.
  const sc = await start();
  mode[FUN] = 'free'; delay[FUN] = 300;
  const burst = await Promise.all([sc.post(), sc.post(), sc.post()]);
  delete delay[FUN];
  t('3 đoạn cùng lúc gặp Fun-ASR hết hạn mức: cả 3 có sub nhờ model dự phòng, log ghi việc chuyển một lần', () => {
    assert.ok(burst.every(x => x.status === 'ok' && x.asrModel === QWEN), JSON.stringify(burst.map(x => [x.status, x.asrModel])));
    assert.equal(count(sc.log, /hết hạn mức \(AllocationQuota\.FreeTierOnly\): chuyển sang/g), 1);
  });

  // Hết lượt chờ thì thử lại Fun-ASR (lượt chờ rút còn 1,2 s trong test); vừa hết lượt chờ trong lúc model dự phòng đang
  // chạy rồi báo hết hạn mức thì cùng đoạn đó thử Fun-ASR luôn, không báo lỗi.
  const sr = await start({ ASR_QUOTA_RETRY_MS: '1200' });
  mode[FUN] = 'free';
  await sr.post();
  mode[FUN] = 'ok';
  await wait(1300);
  k = calls.length;
  const r1 = await sr.post();
  t('hết lượt chờ: đoạn kế thử lại Fun-ASR và dùng được (vd. đã nạp tiền)', () => {
    assert.equal(r1.status, 'ok'); assert.deepEqual(since(k), [FUN]); assert.equal(r1.asrModel, undefined);
  });
  mode[FUN] = 'free';
  await sr.post();                               // Fun-ASR lại hết hạn mức, nghỉ 1,2 s
  mode[FUN] = 'ok'; mode[QWEN] = 'free'; delay[QWEN] = 1500;
  k = calls.length;
  const r2 = await sr.post();                    // dự phòng chạy 1,5 s rồi báo hết; lúc đó Fun-ASR đã hết lượt chờ
  delete delay[QWEN];
  t('Fun-ASR hết lượt chờ trong lúc model dự phòng đang chạy rồi báo hết hạn mức: cùng đoạn thử Fun-ASR, vẫn có sub', () => {
    assert.equal(r2.status, 'ok', JSON.stringify(r2)); assert.deepEqual(since(k), [QWEN, FUN]);
  });

  // Model dự phòng bị từ chối (403 không phải hết hạn mức) sau khi Fun-ASR hết: câu lỗi nói rõ là model dự phòng.
  const sd = await start();
  mode[FUN] = 'free'; mode[QWEN] = 'denied';
  const dn = await sd.post();
  t('Fun-ASR hết hạn mức, model dự phòng bị từ chối (403 AccessDenied): lỗi nói rõ model dự phòng bị từ chối', () => {
    assert.equal(dn.status, 'error'); assert.match(dn.error, new RegExp(`${FUN} hết hạn mức, model dự phòng ${QWEN} bị từ chối`));
  });

  // Model dự phòng bị từ chối thì DashScope tạm dừng 2 phút; Fun-ASR hết lượt chờ trong lúc đó vẫn báo đúng lý do.
  const sp = await start({ ASR_QUOTA_RETRY_MS: '1200' });
  mode[FUN] = 'free'; mode[QWEN] = 'denied';
  await sp.post();
  await wait(1300);
  k = calls.length;
  const pz = await sp.post();
  t('trong 2 phút tạm dừng vì model dự phòng bị từ chối, tới lượt thử lại Fun-ASR: lỗi vẫn nói model dự phòng bị từ chối, không gọi gì', () => {
    assert.equal(pz.status, 'error'); assert.match(pz.error, new RegExp(`model dự phòng ${QWEN} bị từ chối`)); assert.deepEqual(since(k), []);
  });

  // ASR_QUOTA_RETRY_MS âm hay không phải số: dùng 30 phút như mặc định, không bỏ lượt chờ.
  const sn = await start({ ASR_QUOTA_RETRY_MS: '-60000' });
  mode[FUN] = 'free'; mode[QWEN] = 'arrear';
  const ng = await sn.post();
  t('ASR_QUOTA_RETRY_MS âm: vẫn chờ 30 phút', () => {
    assert.equal(ng.status, 'error'); assert.ok(ng.retryAfterMs > 25 * 60 * 1000, JSON.stringify(ng));
  });

  // Giới hạn theo phút kéo dài (gọi lại 3 lần, 2 + 5 + 15 s, vẫn 429): Fun-ASR nghỉ 3 phút, đoạn đó dùng model dự phòng.
  const sl = await start();
  mode[FUN] = 'throttle';
  k = calls.length;
  const tl = await sl.post();
  t('429 theo phút vẫn còn sau các lần gọi lại: Fun-ASR nghỉ ngắn, cùng đoạn dùng model dự phòng, vẫn có sub', () => {
    assert.equal(tl.status, 'ok', JSON.stringify(tl)); assert.deepEqual(since(k), [FUN, FUN, FUN, FUN, QWEN]);
    assert.equal(tl.asrModel, QWEN);
    assert.match(sl.log, new RegExp(`${FUN} bị giới hạn theo phút \\(Throttling\\.AllocationQuota\\), nghỉ 3 phút: chuyển sang ${QWEN}`));
  });

  // Lỗi khác cùng mã HTTP 403 ở Fun-ASR (key không có quyền): vẫn là lỗi cấu hình như trước, không đổi model.
  const s2 = await start();
  mode[FUN] = 'denied';
  k = calls.length;
  const e = await s2.post();
  t('403 không phải hết hạn mức (AccessDenied) ở Fun-ASR: lỗi key/model như cũ, không chuyển sang model dự phòng', () => {
    assert.equal(e.status, 'error'); assert.match(e.error, /từ chối key hoặc model/);
    assert.deepEqual(since(k), [FUN]);
  });

  // Tắt model dự phòng (ASR_FALLBACK_MODEL rỗng): Fun-ASR hết hạn mức thì tạm dừng nhận dạng, báo lỗi rõ.
  const s3 = await start({ ASR_FALLBACK_MODEL: '' });
  mode[FUN] = 'free';
  k = calls.length;
  const f = await s3.post();
  t('tắt model dự phòng: Fun-ASR hết hạn mức thì báo lỗi hết hạn mức (không nhắc model dự phòng), chỉ gọi Fun-ASR', () => {
    assert.equal(f.status, 'error'); assert.match(f.error, /hết hạn mức nhận dạng giọng nói$/); assert.deepEqual(since(k), [FUN]);
    assert.match(s3.log, new RegExp(`ASR: funasr ${FUN}, dịch`));
  });
} finally {
  for (const s of servers) s.proc.kill();
  providers.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${n} kiểm tra đều đạt.`);

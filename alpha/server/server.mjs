#!/usr/bin/env node
// Server Alpha chạy trên máy bạn: extension gửi âm thanh từng đoạn video Douyin, server trả sub tiếng Việt.
// Key nằm trong alpha/server/.env, không bao giờ vào extension.
//   node server.mjs        (mặc định http://127.0.0.1:8787)
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, makeSubtitles, PIPELINE_VERSION } from './pipeline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const CACHE = path.join(process.env.TOD_WORK || path.join(HERE, 'work'), 'cache');
const MAX_BODY = 40 * 1024 * 1024;
const MAX_PARALLEL = 2;
fs.mkdirSync(CACHE, { recursive: true });

// Tối đa MAX_PARALLEL đoạn xử lý cùng lúc; cùng một đoạn thì dùng chung một lần xử lý (inflight).
// Hàng đợi có ưu tiên: đoạn chứa chỗ đang xem (urgent) trước, rồi yêu cầu mới nhất trước. Tua liên tiếp nhiều chỗ
// thì chỗ dừng cuối được làm ngay, không phải chờ các chỗ đã tua qua (đo trên Douyin thật: trước đây 25 s mới có sub).
// Đoạn urgent được dùng thêm một chỗ. Đoạn không còn ai chờ (extension huỷ vì người xem đã tua đi): còn xếp hàng thì
// bỏ, đang chạy thì dừng giữa chừng, để chỗ đang xem không phải chờ và khỏi tốn tiền API.
let running = 0;
let seq = 0;
const queue = [];
const inflight = new Map();      // key → job { promise, urgent, seq, started, waiters, cancel() }
const cancelledError = () => Object.assign(new Error('cancelled'), { cancelled: true });
const CONTEXT_WAIT_MS = 30000;
const canRun = (job) => running < MAX_PARALLEL || (job.urgent && running < MAX_PARALLEL + 1);
function pumpQueue() {
  queue.sort((a, b) => (b.urgent - a.urgent) || (b.seq - a.seq));
  while (queue.length && canRun(queue[0])) { const job = queue.shift(); running++; job.start(); }
}
// fn(signal): signal bị huỷ khi không còn ai chờ đoạn đang chạy → dừng lệnh gọi ASR/dịch, nhường chỗ cho chỗ đang xem.
function submit(key, urgent, fn) {
  const job = { urgent: !!urgent, seq: ++seq, started: false, waiters: 0, at: Date.now() };
  const ctl = new AbortController();
  job.promise = new Promise((resolve, reject) => {
    job.start = () => {
      job.started = true; job.startedAt = Date.now();
      Promise.resolve().then(() => fn(ctl.signal))
        .then(resolve, (e) => reject(ctl.signal.aborted ? cancelledError() : e))
        .finally(() => { running--; pumpQueue(); });
    };
    job.cancel = () => {
      const i = queue.indexOf(job);
      if (i >= 0) { queue.splice(i, 1); reject(cancelledError()); } else if (job.started) ctl.abort(cancelledError());
    };
  });
  job.promise.then(() => inflight.delete(key), () => inflight.delete(key));
  inflight.set(key, job);
  queue.push(job);
  pumpQueue();
  return job;
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error('body_too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleSubtitles(req, res) {
  let meta;
  try { meta = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return send(res, 400, { error: 'bad_body: ' + e.message }); }
  const id = String(meta.id || '');
  const num = (x) => typeof x === 'number' && isFinite(x) && x >= 0;
  const chunked = typeof meta.aac === 'string';
  if (!/^\d{6,25}$/.test(id) || !(chunked || typeof meta.b64 === 'string')) return send(res, 400, { error: 'need id (digits) and aac or b64' });
  if (chunked && !(num(meta.from) && num(meta.to) && meta.to > meta.from && num(meta.audioStart))) return send(res, 400, { error: 'need from < to and audioStart' });
  const span = (a, b) => `${a}-${b}`;
  const cacheFile = (sp) => path.join(CACHE, `${id}.${sp ? sp + '.' : ''}vi.${PIPELINE_VERSION}.json`);
  const file = cacheFile(chunked ? span(meta.from, meta.to) : '');
  const key = file;
  if (fs.existsSync(file)) { const { debug: _d, ...c } = JSON.parse(fs.readFileSync(file, 'utf8')); return send(res, 200, { ...c, cached: true }); }
  let job = inflight.get(key);
  if (job && !job.started) { job.urgent = job.urgent || !!meta.urgent; job.seq = ++seq; pumpQueue(); }   // lại được hỏi: đẩy lên
  if (!job) {
    // TOD_DUMP=1: giữ âm thanh nhận được ở work/dump (tên file kèm audioStart) để soi lỗi ASR, mốc thời gian. Chỉ để trên máy, xoá sau khi xong.
    if (process.env.TOD_DUMP) {
      const dir = path.join(CACHE, '..', 'dump');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, path.basename(file, '.json') + (chunked ? `.at${meta.audioStart}.aac` : '.mp4')), Buffer.from(chunked ? meta.aac : meta.b64, 'base64'));
    }
    let opts = {};
    if (chunked) {
      // Ngữ cảnh: 3 dòng cuối của đoạn trước. Khi tua, đoạn đang xem và đoạn kế được gửi cùng lúc: nếu đoạn trước
      // đang chạy thì chờ nó dịch xong (chỉ chờ ở bước dịch, nhận dạng giọng nói vẫn chạy song song). Đoạn trước
      // còn xếp hàng thì không chờ, để hai đoạn không giữ chỗ chờ nhau.
      const prev = Array.isArray(meta.prev) && meta.prev.length === 2 && meta.prev.every(num) ? cacheFile(span(meta.prev[0], meta.prev[1])) : null;
      const context = async (signal) => {
        if (!prev) return [];
        const pj = inflight.get(prev);
        if (pj && pj.started) {
          await Promise.race([pj.promise.catch(() => {}), new Promise(r => { setTimeout(r, CONTEXT_WAIT_MS); signal?.addEventListener('abort', r, { once: true }); })]);
        }
        if (!fs.existsSync(prev)) return [];
        try { return (JSON.parse(fs.readFileSync(prev, 'utf8')).cues || []).slice(-3).map(c => ({ zh: c.zh, vi: c.vi })); } catch (_) { return []; }
      };
      opts = { kind: 'aac', offset: meta.audioStart, from: meta.from, to: meta.to, context };
    }
    const buf = Buffer.from(chunked ? meta.aac : meta.b64, 'base64');
    job = submit(key, meta.urgent, async (signal) => {
      const r = await makeSubtitles({ desc: meta.desc, hashtags: meta.hashtags }, buf, { ...opts, signal });
      const out = { id, ...(chunked ? { from: meta.from, to: meta.to } : {}), ...r };
      if (r.status !== 'error') fs.writeFileSync(file, JSON.stringify(out));
      return out;
    });
  }
  job.waiters++;
  res.on('close', () => { if (!res.writableEnded && --job.waiters <= 0) job.cancel(); });
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
  const where = chunked ? ` [${mmss(meta.from)}–${mmss(meta.to)}]` : '';
  try {
    const out = await job.promise;
    const t = out.timings || {};
    const why = { no_speech: 'không nghe thấy lời', too_short: 'quá ít lời', not_zh: 'không phải tiếng Trung', singing: 'bài hát', untranslated: 'dịch không ra dòng nào' };
    console.log(`${new Date().toLocaleTimeString()} ${id}${where} ${out.status}${out.label && out.status !== 'ok' ? ' (' + (why[out.label] || out.label) + ')' : ''}` +
      `${out.cues ? ' ' + out.cues.length + ' dòng' : ''}${chunked && meta.from > 0 && out.status === 'ok' && !out.cached ? ` (ngữ cảnh ${out.context || 0} dòng)` : ''} · ${out.seconds ?? '-'} s âm thanh · ${out.sentences ?? 0} câu, ${out.sung ?? 0} câu hát bị bỏ` +
      ` · âm thanh ${t.audioMs ?? '-'} ms, ASR ${t.asrMs ?? '-'} ms, dịch ${t.mtMs ?? '-'} ms${out.cached ? ' · (cache)' : ''}` +
      (job.startedAt - job.at > 300 ? ` · xếp hàng ${job.startedAt - job.at} ms` : '') +
      (out.heard ? `\n    nghe được: ${out.heard}` : ''));
    const { debug: _d, ...reply } = out;
    send(res, 200, reply);
  } catch (e) {
    if (e.cancelled) {
      const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
      console.log(`${new Date().toLocaleTimeString()} ${id}${where} huỷ (đã tua đi chỗ khác${job.started ? ', dừng giữa chừng' : ', chưa xử lý'})` +
        (job.started ? ` · xếp hàng ${sec(job.startedAt - job.at)}, chạy ${sec(Date.now() - job.startedAt)}` : ` · xếp hàng ${sec(Date.now() - job.at)}`));
      if (!res.writableEnded && !res.destroyed) send(res, 200, { id, status: 'cancelled' });
      return;
    }
    console.log(`${new Date().toLocaleTimeString()} ${id}${chunked ? ` [${meta.from}–${meta.to} s]` : ''} LỖI ${e.message}`);
    send(res, 502, { id, status: 'error', error: String(e.message).slice(0, 300), ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}) });
  }
}

// Người xem vừa lướt tới video đã được gửi dịch sẵn (lúc đó chưa gấp): đoạn còn xếp hàng thì đẩy lên đầu.
async function handleBump(req, res) {
  let meta;
  try { meta = JSON.parse((await readBody(req)).toString('utf8')); } catch (e) { return send(res, 400, { error: 'bad_body: ' + e.message }); }
  const id = String(meta.id || '');
  if (!/^\d{6,25}$/.test(id) || !(typeof meta.from === 'number' && typeof meta.to === 'number')) return send(res, 400, { error: 'need id, from, to' });
  const job = inflight.get(path.join(CACHE, `${id}.${meta.from}-${meta.to}.vi.${PIPELINE_VERSION}.json`));
  const queued = !!(job && !job.started);
  if (queued) { job.urgent = true; job.seq = ++seq; pumpQueue(); }
  send(res, 200, { ok: true, found: !!job, queued });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, version: PIPELINE_VERSION, ...config(), running, queued: queue.length });
  if (req.method === 'POST' && url.pathname === '/v1/subtitles') return handleSubtitles(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/bump') return handleBump(req, res);
  send(res, 404, { error: 'not_found' });
});
server.listen(PORT, HOST, () => {
  const c = config();
  console.log(`TranslatorOfDuck Alpha server: http://${HOST}:${PORT}  (ASR: ${c.asr || 'CHƯA CÓ KEY'}, dịch: ${c.mt || 'CHƯA CÓ KEY'}, dịch theo từng đoạn 30 s)`);
  if (!c.mt) console.log('  → Điền GEMINI_API_KEY (và DASHSCOPE_API_KEY nếu có) vào alpha/server/.env rồi chạy lại.');
});

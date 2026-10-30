#!/usr/bin/env node
// Server Alpha chạy trên máy bạn: extension gửi đoạn đầu video Douyin, server trả sub tiếng Việt.
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

// Tối đa MAX_PARALLEL video xử lý cùng lúc; cùng một video thì dùng chung một lần xử lý.
let running = 0;
const waiting = [];
const inflight = new Map();
async function withSlot(fn) {
  if (running >= MAX_PARALLEL) await new Promise(r => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; const next = waiting.shift(); if (next) next(); }
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
  if (!/^\d{6,25}$/.test(id) || typeof meta.b64 !== 'string') return send(res, 400, { error: 'need id (digits) and b64' });
  const key = `${id}.vi.${PIPELINE_VERSION}`;
  const file = path.join(CACHE, key + '.json');
  if (fs.existsSync(file)) { const { debug: _d, ...c } = JSON.parse(fs.readFileSync(file, 'utf8')); return send(res, 200, { ...c, cached: true }); }
  if (!inflight.has(key)) {
    inflight.set(key, withSlot(() => makeSubtitles({ desc: meta.desc, hashtags: meta.hashtags }, Buffer.from(meta.b64, 'base64')))
      .then((r) => { const out = { id, ...r }; if (r.status !== 'error') fs.writeFileSync(file, JSON.stringify(out)); return out; })
      .finally(() => inflight.delete(key)));
  }
  try {
    const out = await inflight.get(key);
    const t = out.timings || {};
    const why = { no_speech: 'không nghe thấy lời', too_short: 'quá ít lời', not_zh: 'không phải tiếng Trung', singing: 'bài hát', untranslated: 'dịch không ra dòng nào' };
    console.log(`${new Date().toLocaleTimeString()} ${id} ${out.status}${out.label && out.status !== 'ok' ? ' (' + (why[out.label] || out.label) + ')' : ''}` +
      `${out.cues ? ' ' + out.cues.length + ' dòng' : ''} · ${out.seconds ?? '-'} s âm thanh · ${out.sentences ?? 0} câu, ${out.sung ?? 0} câu hát bị bỏ` +
      ` · âm thanh ${t.audioMs ?? '-'} ms, ASR ${t.asrMs ?? '-'} ms, dịch ${t.mtMs ?? '-'} ms${out.cached ? ' · (cache)' : ''}` +
      (out.heard ? `\n    nghe được: ${out.heard}` : ''));
    const { debug: _d, ...reply } = out;
    send(res, 200, reply);
  } catch (e) {
    console.log(`${new Date().toLocaleTimeString()} ${id} LỖI ${e.message}`);
    send(res, 502, { id, status: 'error', error: String(e.message).slice(0, 300) });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, version: PIPELINE_VERSION, ...config() });
  if (req.method === 'POST' && url.pathname === '/v1/subtitles') return handleSubtitles(req, res);
  send(res, 404, { error: 'not_found' });
});
server.listen(PORT, HOST, () => {
  const c = config();
  console.log(`TranslatorOfDuck Alpha server: http://${HOST}:${PORT}  (ASR: ${c.asr || 'CHƯA CÓ KEY'}, dịch: ${c.mt || 'CHƯA CÓ KEY'}, tối đa ${c.maxSeconds} s/video)`);
  if (!c.mt) console.log('  → Điền GEMINI_API_KEY (và DASHSCOPE_API_KEY nếu có) vào alpha/server/.env rồi chạy lại.');
});

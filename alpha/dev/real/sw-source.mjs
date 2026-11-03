// Kiểm extension đang chạy trong Chromium có đúng bản trong alpha/extension không: đọc mã background.js mà service worker
// đang chạy (CDP Debugger.getScriptSource) rồi so với file. Chrome giữ service worker cũ cả khi đã mở lại trình duyệt
// (HANDOFF §6y): cài bản mới xong phải kiểm bằng cách này.   node sw-source.mjs [--port 9333]
import fs from 'node:fs';
import path from 'node:path';
import { EXT, args, sleep } from './lib.mjs';

const port = args().port || 9333;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const file = fs.readFileSync(path.join(EXT, 'background.js'), 'utf8');
let found = false;
for (const t of list.filter((x) => x.type === 'service_worker' && /\/background\.js$/.test(x.url))) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const wait = new Map(), scripts = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && wait.has(m.id)) { wait.get(m.id)(m); wait.delete(m.id); }
    else if (m.method === 'Debugger.scriptParsed' && /background\.js$/.test(m.params.url)) scripts.push(m.params.scriptId);
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => { ws.onopen = r; });
  const nm = await send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name + " " + chrome.runtime.getManifest().version', returnByValue: true });
  const name = nm.result && nm.result.result && nm.result.result.value || '';
  if (!/^TranslatorOfDuck/.test(name)) { ws.close(); continue; }
  found = true;
  await send('Debugger.enable');
  await sleep(300);
  for (const s of scripts) {
    const src = (await send('Debugger.getScriptSource', { scriptId: s })).result.scriptSource;
    const build = (/const BUILD = '([^']+)'/.exec(src) || [])[1];
    console.log(`${name}: service worker chạy BUILD ${build || '?'}; ${src === file ? 'GIỐNG' : 'KHÁC'} alpha/extension/background.js`);
  }
  await send('Debugger.disable');
  ws.close();
}
if (!found) console.log(`Không thấy service worker của TranslatorOfDuck trên cổng ${port}`);

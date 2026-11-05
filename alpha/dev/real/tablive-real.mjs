// Thử đường dự phòng (âm thanh tab, trang bất kỳ) trên một trang thật: server đo riêng (cổng 8788, cache trống), Chromium riêng
// (cổng 9334, hồ sơ tạm) với cờ --allowlisted-extension-id để bật thu âm thanh tab không cần bấm popup. Ghi mỗi 0,5 s: giờ video,
// chữ sub, nhãn trễ; xong in tóm tắt và xoá dữ liệu (--keep để giữ).
//   node tablive-real.mjs <url trang> [--seconds 90] [--target vi|en] [--tail giây] [--keep] [--out <thư mục>]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { args, playwright, sleep, startServer, extensionWorker, setSettings, EXT as REAL_EXT } from './lib.mjs';

const a = args();
const url = a._[0];
if (!url) { console.error('cần url trang'); process.exit(2); }
const seconds = Number(a.seconds || 90), target = a.target || 'vi';
const out = a.out || fs.mkdtempSync(path.join(os.tmpdir(), 'tod-live-'));
// Bản sao extension có quyền tiêm vào mọi trang: lúc thử không có cú bấm popup thật (quyền activeTab), nên background.js không
// tiêm được lớp sub. Chỉ bản sao trong thư mục lượt thử có quyền này; extension thật không đổi.
const EXT = path.join(out, 'ext');
fs.cpSync(REAL_EXT, EXT, { recursive: true });
const man = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
man.host_permissions = [...man.host_permissions, '<all_urls>'];
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(man, null, 2));
// id của extension giải nén: sha256 đường dẫn tuyệt đối, 32 ký tự hex đầu đổi 0–f thành a–p.
const extId = crypto.createHash('sha256').update(fs.realpathSync(EXT)).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, (c) => 'abcdefghijklmnop'[parseInt(c, 16)]);
const server = await startServer({ port: 8788, work: path.join(out, 'server'), keepAsr: false, dump: false });
const { chromium } = playwright();
const profile = path.join(out, 'profile');
const br = spawn(process.env.CHROME || chromium.executablePath(), [`--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`,
  `--allowlisted-extension-id=${extId}`, '--remote-debugging-port=9334', '--autoplay-policy=no-user-gesture-required',
  '--no-first-run', '--no-default-browser-check', '--disable-component-update', '--window-size=1280,860', 'about:blank'], { stdio: 'ignore' });
let b;
for (let i = 0; ; i++) { try { b = await chromium.connectOverCDP('http://127.0.0.1:9334'); break; } catch (e) { if (i > 80) throw e; await sleep(250); } }
const samples = [];
try {
  const ctx = b.contexts()[0];
  const sw = await extensionWorker(ctx);
  if (!sw.url().includes(extId)) throw new Error('id extension tính ra khác: ' + sw.url());
  // Không --mute-audio (tắt cả âm thanh thu được): thay vào đó trang ẩn không phát lại ra loa (liveMonitor: false), và bật thu
  // ngay khi trang vừa tải, trước khi video kịp phát ra loa (đang thu thì Chrome không phát tiếng tab).
  await setSettings(sw, { server: server.url, target, liveMonitor: false, ...(a.tail ? { liveTail: Number(a.tail) } : {}) });
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('about:blank#tod');
  const r = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true }); return tabStart(t.id); });
  console.log('bật thu:', JSON.stringify(r));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await sw.evaluate(async () => { const { liveTab } = await chrome.storage.session.get('liveTab'); await inject(liveTab); });
  for (let i = 0; i < 60; i++) {
    const playing = await page.evaluate(() => { const v = document.querySelector('video'); if (v && v.paused) v.play().catch(() => {}); return !!v && !v.paused && v.currentTime > 0.5; }).catch(() => false);
    if (playing) break;
    await sleep(500);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const s = await page.evaluate(() => {
      const v = document.querySelector('video');
      const host = [...document.querySelectorAll('div')].find((d) => d.shadowRoot && d.shadowRoot.querySelector('.badge'));
      const line = host && host.shadowRoot.querySelector('.line');
      return { vt: v ? Math.round(v.currentTime * 10) / 10 : null, sub: line && !line.hidden ? line.textContent : '', badge: host ? host.shadowRoot.querySelector('.badge').textContent : null };
    }).catch((e) => ({ err: String(e.message).slice(0, 80) }));
    samples.push({ ms: Date.now() - t0, ...s });
    await sleep(500);
  }
  const st = await sw.evaluate(() => toOffscreen({ type: 'status' }));
  console.log('trạng thái trang ẩn:', JSON.stringify(st));
  await page.screenshot({ path: path.join(out, 'shot.png') });
  await sw.evaluate(() => toOffscreen({ type: 'stop' }));
} finally {
  try { await b.close(); } catch (_) {}
  br.kill();
  await server.stop();
}
fs.writeFileSync(path.join(out, 'samples.json'), JSON.stringify(samples, null, 1));
let prev = '';
for (const s of samples) { const k = s.sub + ' | ' + s.badge; if (k !== prev) { console.log(((s.ms / 1000).toFixed(1) + ' s').padStart(7), 'video', s.vt, '|', s.sub || '(trống)', '|', s.badge); prev = k; } }
const withSub = samples.filter((s) => s.sub).length;
console.log(`\n${samples.length} lần chụp, ${withSub} có sub. Server log: ${server.log}`);
if (!a.keep) { fs.rmSync(out, { recursive: true, force: true }); console.log('đã xoá dữ liệu lượt thử'); } else console.log('giữ dữ liệu ở', out);

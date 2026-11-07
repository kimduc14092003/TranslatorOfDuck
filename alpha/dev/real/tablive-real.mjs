// Thử đường dự phòng (âm thanh tab, trang bất kỳ) trên một trang thật: server đo riêng (cổng 8788, cache trống), Chromium riêng
// (cổng 9334, hồ sơ tạm) với cờ --allowlisted-extension-id để bật thu âm thanh tab không cần bấm popup. Ghi mỗi 0,5 s: giờ video,
// chữ sub, nhãn trễ; xong in tóm tắt và xoá dữ liệu (--keep để giữ).
//   node tablive-real.mjs <url trang> [--web] [--next-at 30,60] [--seconds 90] [--target vi|en] [--keep] [--out <thư mục>]
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
  await setSettings(sw, { server: server.url, target, liveMonitor: false, ...(a.pause ? { livePause: Number(a.pause) } : {}) });
  const page = ctx.pages()[0] || await ctx.newPage();
  if (a.web) {
    // --web: bộ đọc chung (dịch trước). Bật cho trang web của url (bản sao extension có sẵn quyền mọi trang), tải lại trang.
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const r = await sw.evaluate(async (o) => { const [t] = await chrome.tabs.query({ active: true }); return webEnable(o, t.id); }, new URL(url).origin);
    console.log('bật bộ đọc chung:', JSON.stringify(r));
    // Bộ đọc chung đọc dữ liệu trình phát nạp, không cần tiếng: để video tắt tiếng (trang tự phát được, như người xem lướt im lặng).
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await sleep(3000);
  } else {
    // Bật thu trên một trang thường (trang /health của server đo): about:blank không tiêm được lớp sub nên extension từ chối bật.
    await page.goto(server.url + '/health');
    const r = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ active: true }); return tabStart(t.id); });
    console.log('bật thu:', JSON.stringify(r));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await sw.evaluate(async () => { const { liveTab } = await chrome.storage.session.get('liveTab'); await inject(liveTab); });
  }
  for (let i = 0; i < 60; i++) {
    const playing = await page.evaluate((keep) => { const v = [...document.querySelectorAll('video')].filter((x) => x.getBoundingClientRect().width * x.getBoundingClientRect().height > 0).sort((p, q) => { const r = (x) => x.getBoundingClientRect(); return r(q).width * r(q).height - r(p).width * r(p).height; })[0]; if (v && !keep) v.muted = false; if (v && v.paused) v.play().catch(() => {}); return !!v && !v.paused && v.currentTime > 0.5; }, !!a.web).catch(() => false);
    if (playing) break;
    await sleep(500);
  }
  // --seek-at giây --seek-to giây: tua video (giờ thử) ; --pause-at giây --pause-for giây: tạm dừng.
  const t0 = Date.now();
  const acts = [];
  if (a['seek-at']) acts.push({ at: Number(a['seek-at']) * 1000, run: () => page.evaluate((x) => { ([...document.querySelectorAll('video')].filter((x) => x.getBoundingClientRect().width * x.getBoundingClientRect().height > 0).sort((p, q) => { const r = (x) => x.getBoundingClientRect(); return r(q).width * r(q).height - r(p).width * r(p).height; })[0]).currentTime = x; }, Number(a['seek-to'] || 0)), name: 'tua tới ' + (a['seek-to'] || 0) });
  if (a['pause-at']) {
    acts.push({ at: Number(a['pause-at']) * 1000, run: () => page.evaluate(() => ([...document.querySelectorAll('video')].filter((x) => x.getBoundingClientRect().width * x.getBoundingClientRect().height > 0).sort((p, q) => { const r = (x) => x.getBoundingClientRect(); return r(q).width * r(q).height - r(p).width * r(p).height; })[0]).pause()), name: 'tạm dừng' });
    acts.push({ at: (Number(a['pause-at']) + Number(a['pause-for'] || 5)) * 1000, run: () => page.evaluate(() => ([...document.querySelectorAll('video')].filter((x) => x.getBoundingClientRect().width * x.getBoundingClientRect().height > 0).sort((p, q) => { const r = (x) => x.getBoundingClientRect(); return r(q).width * r(q).height - r(p).width * r(p).height; })[0]).play()), name: 'phát tiếp' });
  }
  // --next-at giây[,giây…]: nhấn mũi tên xuống (sang video kế trong feed, như lướt Douyin), rồi bật tiếng video mới.
  for (const x of String(a['next-at'] || '').split(',').filter(Boolean)) acts.push({ at: Number(x) * 1000, name: 'sang video kế',
    run: async () => { await page.keyboard.press('ArrowDown'); await sleep(1500); await page.evaluate((keep) => { const v = [...document.querySelectorAll('video')].filter((x) => x.getBoundingClientRect().width * x.getBoundingClientRect().height > 0).sort((p, q) => { const r = (x) => x.getBoundingClientRect(); return r(q).width * r(q).height - r(p).width * r(p).height; })[0]; if (v) { if (!keep) v.muted = false; if (v.paused) v.play().catch(() => {}); } }, !!a.web); } });
  while (Date.now() - t0 < seconds * 1000) {
    for (const x of acts) if (!x.done && Date.now() - t0 >= x.at) { x.done = true; await x.run().catch(() => {}); samples.push({ ms: Date.now() - t0, act: x.name }); }
    const s = await page.evaluate(() => {
      const v = [...document.querySelectorAll('video')].filter((x) => x.getBoundingClientRect().width * x.getBoundingClientRect().height > 0).sort((p, q) => { const r = (x) => x.getBoundingClientRect(); return r(q).width * r(q).height - r(p).width * r(p).height; })[0];
      const host = [...document.querySelectorAll('div')].find((d) => d.shadowRoot && d.shadowRoot.querySelector('.badge'));
      const line = host && host.shadowRoot.querySelector('.line');
      return { vt: v ? Math.round(v.currentTime * 10) / 10 : null, sub: line && !line.hidden ? line.textContent : '', badge: host ? host.shadowRoot.querySelector('.badge').textContent : null };
    }).catch((e) => ({ err: String(e.message).slice(0, 80) }));
    samples.push({ ms: Date.now() - t0, ...s });
    await sleep(500);
  }
  if (!a.web) console.log('trạng thái trang ẩn:', JSON.stringify(await sw.evaluate(() => toOffscreen({ type: 'status' }))));
  await page.screenshot({ path: path.join(out, 'shot.png') });
  if (!a.web) await sw.evaluate(() => toOffscreen({ type: 'stop' }));
} finally {
  try { await b.close(); } catch (_) {}
  br.kill();
  await server.stop();
}
fs.writeFileSync(path.join(out, 'samples.json'), JSON.stringify(samples, null, 1));
let prev = '';
for (const s of samples) { if (s.act) { console.log('   ---', s.act); continue; } const k = s.sub + ' | ' + s.badge; if (k !== prev) { console.log(((s.ms / 1000).toFixed(1) + ' s').padStart(7), 'video', s.vt, '|', s.sub || '(trống)', '|', s.badge); prev = k; } }
const withSub = samples.filter((s) => s.sub).length;
console.log(`\n${samples.length} lần chụp, ${withSub} có sub. Server log: ${server.log}`);
if (!a.keep) { fs.rmSync(out, { recursive: true, force: true }); console.log('đã xoá dữ liệu lượt thử'); } else console.log('giữ dữ liệu ở', out);

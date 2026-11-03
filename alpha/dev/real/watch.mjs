// Xem một video Douyin thật trong Chromium riêng (cổng 9334, hồ sơ tạm, tắt tiếng, chế độ khách) và ghi lại: giây đang
// phát, tốc độ, nhãn, sub đang hiện. Ghi mỗi 100 ms trong 10 s đầu (để đo sub đầu tiên), sau đó mỗi 250 ms.
//   node watch.mjs <id> [--rate 1] [--from 0] [--to giây] [--server http://127.0.0.1:8788] [--throttle KB/s] [--out thư mục]
// Không có --server thì extension gọi server mặc định (8787). Đo có cache trống, có proxy: dùng run.mjs.
// Hết video: tới --to, hay gần cuối video. Thời lượng lấy từ durationOf() (run.mjs đọc durationMs extension gửi qua proxy);
// không có thì chỉ tin thời lượng của thẻ <video> khi nó đứng yên 5 s: trình phát MSE của Douyin báo thời lượng tăng dần.
// Ra: samples.jsonl (có chữ sub: xoá khi xong), meta.json, status.json, run.log. Hồ sơ trình duyệt xoá khi xong.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OUT_ROOT, PAGE_STATE, args, extStatus, launchChromium, rmrf, setSettings, sleep } from './lib.mjs';

export async function watchVideo({ id, out, server = null, rate = 1, from = 0, to = Infinity, throttle = 0, lyrics = null, maxMin = 30, port = 9334, durationOf = null }) {
  fs.mkdirSync(out, { recursive: true });
  const runLog = path.join(out, 'run.log');
  const log = (...a) => { const s = new Date().toISOString().slice(11, 19) + ' ' + a.join(' '); console.log(s); fs.appendFileSync(runLog, s + '\n'); };
  const samples = fs.createWriteStream(path.join(out, 'samples.jsonl'));
  const profile = path.join(out, 'profile');
  const meta = { id, rate, from, to: isFinite(to) ? to : null, server, throttle: throttle || null, startedAt: new Date().toISOString() };
  let br = null, n = 0;
  try {
    br = await launchChromium({ profile, port });
    meta.extension = await br.sw.evaluate(() => chrome.runtime.getManifest().version);
    const patch = { ...(server ? { server } : {}), ...(lyrics == null ? {} : { lyrics }) };
    if (Object.keys(patch).length) meta.settings = await setSettings(br.sw, patch);
    log('extension', meta.extension, server ? 'server ' + server : 'server mặc định');
    const page = br.ctx.pages()[0] || await br.ctx.newPage();
    if (throttle) {
      // Giả lập mạng chậm cho cả trang: trình phát của Douyin và lượt tải của extension đi chung đường (HANDOFF §6t).
      const cdp = await br.ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: throttle * 1024, uploadThroughput: -1 });
      log('mạng giả lập', throttle, 'KB/s');
    }
    const t0 = Date.now();
    await page.goto('https://www.douyin.com/jingxuan?modal_id=' + id, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => log('goto', e.message));
    // seekAt: lúc ra lệnh tua; seeked: đã thấy chỗ đang xem ở gần from (trong 2 s).
    let seekAt = 0, seekTries = 0, seeked = !from, maxT = 0, lastT = -1, movedAt = Date.now(), dur = null, durSince = 0;
    while (Date.now() - t0 < maxMin * 60000) {
      const wantSeek = !seeked && (!seekAt || Date.now() - seekAt > 3000);
      const s = await page.evaluate(PAGE_STATE, { rate, seek: wantSeek && dur ? from : null }).catch((e) => ({ err: String(e.message).slice(0, 80) }));
      samples.write(JSON.stringify({ at: Date.now() - t0, ...s }) + '\n');
      n++;
      if (s.dur && s.dur !== dur) { dur = s.dur; durSince = Date.now(); }
      if (wantSeek && dur) {
        if (++seekTries > 3) { meta.error = `không tua được tới ${from} s`; log('LỖI', meta.error); break; }
        seekAt = Date.now(); log('tua tới', from);
      }
      // Đã tua: một lần chụp sau lệnh tua ít nhất 1 s mà chỗ đang xem nằm trong [from, from + 5] (đã phát tiếp từ from).
      if (!seeked && seekAt && Date.now() - seekAt >= 1000 && s.t != null && s.t >= from - 0.5 && s.t <= from + 5) seeked = true;
      const known = (durationOf && durationOf()) || (dur && Date.now() - durSince >= 5000 ? dur : null);
      if (s.t != null && s.t !== lastT) { lastT = s.t; movedAt = Date.now(); }
      // Video không chạy (captcha, video bị gỡ, không thấy thẻ video): thôi sau 60 s.
      if (Date.now() - movedAt > 60000) { meta.error = s.t == null ? 'không thấy video đang phát' : `video đứng ở ${s.t} s`; log('LỖI', meta.error); break; }
      if (s.t != null && seeked) {
        if (s.t > maxT) maxT = s.t;
        // Hết: tới mốc cần xem, gần cuối video, hay video phát lại từ đầu sau khi đã qua 90%.
        if (s.t >= to || (known && (s.t >= known - 0.6 || (maxT > 0.9 * known && s.t < 5)))) { log('xong ở', s.t, 'trên', known || dur, 's'); meta.duration = known; break; }
      }
      if (n % 120 === 0) log('t', s.t, 'nhãn', s.badge, 'sub', String(s.sub || '').slice(0, 40));
      await sleep(Date.now() - t0 < 10000 ? 100 : 250);
    }
    await sleep(1500);
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(await extStatus(br.sw), null, 1));
  } catch (e) { log('LỖI', e.message); meta.error = e.message; }
  finally {
    meta.endWall = Date.now();   // yêu cầu bị huỷ sau mốc này là do đóng trình duyệt, không tính
    samples.end();
    meta.samples = n; meta.endedAt = new Date().toISOString();
    fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(meta, null, 1));
    if (br) await br.close();
    if (!rmrf(profile)) log('không xoá được hồ sơ trình duyệt', profile);   // hồ sơ có bản sao media trong cache trình duyệt
  }
  return meta;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = args();
  const id = a._[0];
  if (!/^\d{6,25}$/.test(id || '')) { console.log('Cần id video Douyin: node watch.mjs <id> [--rate 1] [--from 0] [--to giây] [--server URL]'); process.exit(1); }
  const out = a.out ? path.resolve(a.out) : path.join(OUT_ROOT, 'watch', id + '-' + Date.now());
  await watchVideo({ id, out, server: a.server || null, rate: Number(a.rate || 1), from: Number(a.from || 0), to: a.to ? Number(a.to) : Infinity,
    throttle: Number(a.throttle || 0), lyrics: a.lyrics == null ? null : a.lyrics !== 'off' });
  console.log('Kết quả:', out, '\nTrong đó có chữ sub của video: xem xong thì xoá thư mục này.');
  process.exit(0);
}

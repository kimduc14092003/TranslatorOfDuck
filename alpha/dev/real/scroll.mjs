// Lướt như người xem: mở video đầu (jingxuan?modal_id=), mỗi khoảng dừng xong thì bấm ↓ sang video kế. Ghi trạng thái mỗi
// 250 ms, và đo "sẵn sàng khi lướt" (FRR, docs/ROADMAP.md §3): 0,5 s sau khi tới video, đoạn ở chỗ đang xem đã có kết quả chưa
// (có sub, hay đã kết luận bỏ qua). Video đầu là mở lạnh, không tính.
//   node scroll.mjs <id video đầu> <giây dừng,giây dừng,...> [--fresh] [--server URL] [--out thư mục] [--keep]
// --fresh: server đo riêng với cache trống (8788). Xong thì xoá dữ liệu của lượt (mẫu có chữ sub), trừ khi --keep.
// Đây là tự động lướt: chỉ chạy khi chủ dự án yêu cầu; tối đa 10 video, mỗi video dừng ít nhất 3 s (nhịp người xem).
import fs from 'node:fs';
import path from 'node:path';
import { OUT_ROOT, PAGE_STATE, args, extStatus, launchChromium, rmrf, setSettings, sleep, startServer, stateOf } from './lib.mjs';

const a = args();
const [first, pattern] = a._;
if (!/^\d{6,25}$/.test(first || '') || !pattern) { console.log('node scroll.mjs <id video đầu> <giây dừng,giây dừng,...> [--fresh] [--server URL]'); process.exit(1); }
const stays = String(pattern).split(',').map((x) => Math.max(3, Number(x) || 3)).slice(0, 10);
const out = a.out ? path.resolve(a.out) : path.join(OUT_ROOT, 'scroll', first + '-' + Date.now());
fs.mkdirSync(out, { recursive: true });
let server = null, br = null;
const arrivals = [];
try {
  if (a.fresh) server = await startServer({ work: path.join(out, 'server'), dump: false });   // không giữ âm thanh: scroll không đo đúng nhịp
  br = await launchChromium({ profile: path.join(out, 'profile') });
  const url = server ? server.url : a.server;
  if (url) await setSettings(br.sw, { server: url });
  const page = br.ctx.pages()[0] || await br.ctx.newPage();
  const samples = fs.createWriteStream(path.join(out, 'samples.jsonl'));
  const t0 = Date.now();
  await page.goto('https://www.douyin.com/jingxuan?modal_id=' + first, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(3000);
  for (let i = 0; i < stays.length; i++) {
    const st = await extStatus(br.sw);
    const id = st && st.cur && st.cur.id;
    const tA = Date.now();
    let arrival = null;
    while (Date.now() - tA < stays[i] * 1000) {
      const s = await page.evaluate(PAGE_STATE).catch(() => ({}));
      samples.write(JSON.stringify({ i, id, at: Date.now() - t0, ...s }) + '\n');
      if (!arrival && Date.now() - tA >= 500) arrival = stateOf(s);
      await sleep(250);
    }
    arrivals.push({ i, id, state: arrival });
    console.log(`video ${i + 1} ${id || '?'}: lúc tới ${arrival}`);
    if (i < stays.length - 1) { await page.keyboard.press('ArrowDown').catch(() => {}); await sleep(300); }
  }
  samples.end();
} catch (e) { console.log('LỖI', e.message); }
finally { if (br) await br.close(); if (server) await server.stop(); rmrf(path.join(out, 'profile')); }
const counted = arrivals.slice(1).filter((x) => x.state && x.state !== 'none');
const ready = counted.filter((x) => x.state === 'ok' || x.state === 'skipped').length;
const result = { first, stays, arrivals, frr: counted.length ? +(100 * ready / counted.length).toFixed(1) : null };
fs.writeFileSync(path.join(out, 'scroll.json'), JSON.stringify(result, null, 1));
console.log(`Sẵn sàng khi lướt: ${result.frr ?? '-'}% (${ready}/${counted.length} video, không tính video đầu và video không có nhãn)`);
if (!a.keep) for (const f of ['server', 'samples.jsonl']) rmrf(path.join(out, f));
process.exit(0);

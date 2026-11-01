// Kiểm tra alpha/extension/mp4audio.js trên file mp4 thật do ffmpeg tạo (cần ffmpeg).
// File có tiếng bíp ở mốc đã biết; cắt âm thanh một khoảng, giải mã lại và xem tiếng bíp có rơi đúng chỗ không.
// Chạy: node alpha/dev/mp4audio-test.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'extension', 'mp4audio.js'), 'utf8'), ctx);
const { headerEnd, parse, window } = ctx.globalThis.TodMp4;
const FF = process.env.FFMPEG || 'ffmpeg';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tod-mp4-'));
const f = (n) => path.join(dir, n);
const ff = (...a) => execFileSync(FF, ['-v', 'error', '-y', ...a]);
const onsets = (file) => [...spawnSync(FF, ['-i', file, '-af', 'silencedetect=n=-30dB:d=0.2', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
  .matchAll(/silence_end: ([\d.]+)/g)].map(m => Number(m[1]));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };

try {
  // Tiếng bíp 0,5 s ở giây 3, 7, 11, 15 (thời gian của track âm thanh).
  ff('-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30', '-f', 'lavfi', '-i',
    "sine=frequency=440:duration=20,volume=0:enable='not(between(t,3,3.5)+between(t,7,7.5)+between(t,11,11.5)+between(t,15,15.5))'",
    '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', f('plain.mp4'));
  ff('-i', f('plain.mp4'), '-itsoffset', '0.4', '-i', f('plain.mp4'), '-map', '0:v', '-map', '1:a', '-c', 'copy', '-movflags', '+faststart', f('late.mp4'));

  for (const [name, shift] of [['plain.mp4', 0], ['late.mp4', 0.4]]) {
    const file = fs.readFileSync(f(name));
    const ab = file.buffer.slice(file.byteOffset, file.byteOffset + file.length);
    const head = headerEnd(ab.slice(0, 65536));
    const m = parse(ab.slice(0, head));
    const w = window(m, 6, 12.5);
    // Chỉ đưa phần byte đã "tải" cho build, đúng như extension.
    fs.writeFileSync(f('cut.aac'), w.build(ab.slice(w.start, w.end)));
    ff('-i', f('cut.aac'), f('cut.wav'));
    const got = onsets(f('cut.wav')).map(x => +(x + w.startTime).toFixed(3));
    t(`${name}: tiếng bíp rơi đúng mốc (${got.join(', ')} ≈ ${7 + shift}, ${11 + shift})`, () => {
      assert.ok(Math.abs(w.startTime - 6) < 0.05, 'bắt đầu ở ' + w.startTime);
      assert.ok(got.length >= 2);   // silencedetect còn báo một mốc ở cuối file
      assert.ok(Math.abs(got[0] - (7 + shift)) < 0.06 && Math.abs(got[1] - (11 + shift)) < 0.06);
      assert.ok(w.end - w.start < file.length * 0.6, 'chỉ tải một phần file');
    });
  }
  t('đọc được thời lượng video', () => {
    const file = fs.readFileSync(f('plain.mp4'));
    const m = parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.length));
    assert.ok(Math.abs(m.duration - 20) < 0.1, String(m.duration));
  });
  t('headerEnd trên phần đầu file đang tải dở: chưa đủ header của moov thì null, kể cả cỡ 64 bit', () => {
    const box = (type, size, big) => { const b = new Uint8Array(big ? 16 : 8); const dv = new DataView(b.buffer);
      dv.setUint32(0, big ? 1 : size); b.set([...type].map((c) => c.charCodeAt(0)), 4); if (big) dv.setBigUint64(8, BigInt(size)); return b; };
    const ftyp = new Uint8Array(24); ftyp.set(box('ftyp', 24));
    const big = new Uint8Array([...ftyp, ...box('moov', 70000, true)]);
    const ab = (u8, n) => u8.slice(0, n).buffer;
    assert.equal(headerEnd(ab(big, 24 + 8)), null);    // mới tới giữa header 64 bit (trước đây: 25)
    assert.equal(headerEnd(ab(big, 24 + 15)), null);
    assert.equal(headerEnd(ab(big, 24 + 16)), 24 + 70000);
    const small = new Uint8Array([...ftyp, ...box('moov', 5000)]);
    assert.equal(headerEnd(ab(small, 24 + 4)), null);
    assert.equal(headerEnd(ab(small, 24 + 8)), 24 + 5000);
  });
  t('video không có âm thanh báo lỗi rõ ràng', () => {
    ff('-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-movflags', '+faststart', f('mute.mp4'));
    const file = fs.readFileSync(f('mute.mp4'));
    assert.throws(() => parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.length)), /không có âm thanh/);
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log(`\n${n} kiểm tra đều đạt.`);

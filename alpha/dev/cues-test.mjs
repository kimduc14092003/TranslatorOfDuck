// Kiểm tra alpha/extension/cues.js: gộp sub các đoạn, câu vắt qua ranh giới hai đoạn (không cần mạng).
// Các ca lấy từ một vlog Douyin thật (đổi chữ cho ngắn). Chạy: node alpha/dev/cues-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { globalThis: {} };
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'extension', 'cues.js'), 'utf8'), ctx);
const { merge, at } = ctx.globalThis.TodCues;
const C = (start, se, vi, end = se + 0.5) => ({ start, end, se, vi });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('PASS ' + name); };
const texts = (cues) => Array.from(cues, c => c.vi);   // mảng từ vm thuộc realm khác: chép sang

t('đoạn sau nghe đủ câu mà đoạn trước nghe thiếu: giữ dòng đầy đủ', () => {
  // 650 s: đoạn trước "花了5.5元。", đoạn sau "花了5.5块买了一把鞋刷子和一块肥皂，"
  const out = merge([{ cues: [C(651.8, 655.09, 'A1'), C(655.251, 656.011, 'A2 ngắn')] }, { cues: [C(655.271, 658.591, 'B1 đầy đủ'), C(658.871, 661.031, 'B2')] }]);
  assert.deepEqual(texts(out), ['A1', 'B1 đầy đủ', 'B2']);
  assert.equal(at(out, 656.5).vi, 'B1 đầy đủ');
});
t('câu chồng một phần: giữ cả hai, dòng trước cắt ngắn', () => {
  // 380 s: "不合作了，玩呗！" (379,69–381,37) và "玩呗！我看谁能玩过谁！" (380,99–382,91)
  const out = merge([{ cues: [C(377.3, 379.49, 'A1'), C(379.692, 381.371, 'A2')] }, { cues: [C(380.989, 382.909, 'B1')] }]);
  assert.deepEqual(texts(out), ['A1', 'A2', 'B1']);
  assert.ok(Math.abs(out[1].end - (380.989 - 2 / 30)) < 1e-6);
  assert.equal(at(out, 380.5).vi, 'A2');
  assert.equal(at(out, 381.2).vi, 'B1');
});
t('dòng đầu đoạn sau nằm gọn trong lời dòng trước: bỏ (phần nghe dư)', () => {
  // 530 s: "我不要了，30块钱我不要了。" (530,33–532,13) và "朋友们，30块钱我不要了！" (530,47–532,15)
  const out = merge([{ cues: [C(528.2, 530.25, 'A1'), C(530.333, 532.132, 'A2')] }, { cues: [C(530.469, 532.148, 'B1'), C(534.4, 537.1, 'B2')] }]);
  assert.deepEqual(texts(out), ['A1', 'A2', 'B2']);
});
t('không chồng nhau: giữ nguyên, dòng trước không đè dòng sau', () => {
  const out = merge([{ cues: [C(46.1, 48.25, 'A1'), C(48.37, 50.129, 'A2', 50.5)] }, { cues: [C(50.346, 52.704, 'B1')] }]);
  assert.deepEqual(texts(out), ['A1', 'A2', 'B1']);
  assert.ok(out[1].end <= 50.346);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].start >= out[i - 1].start);
});
t('tua tới trước (mới có đoạn sau), rồi đoạn trước xong: gộp lại từ đầu, không giữ trạng thái cũ', () => {
  const a = { cues: [C(651.8, 655.09, 'A1'), C(655.251, 656.011, 'A2')] }, b = { cues: [C(655.271, 658.591, 'B1')] };
  const onlyB = merge([b]);
  assert.deepEqual(texts(onlyB), ['B1']);
  assert.deepEqual(texts(merge([a, b])), ['A1', 'B1']);
  assert.equal(onlyB[0].start, 655.271);          // không sửa vào cues gốc của đoạn
  assert.equal(b.cues[0].end, 659.091);
});
t('dòng nhiều chữ hơn đọc kịp (17 ký tự/giây): hiện lâu hơn vào quãng lặng, tối đa 1,5 s sau lúc dứt lời, không đè dòng kế; dòng đọc kịp giữ nguyên; đầu dòng không đổi; dòng chưa biết dòng kế thì không kéo dài', () => {
  const long = 'x'.repeat(68);   // cần 4 s
  // 'a\u0301': chữ á viết tách dấu (NFD), hai mã một ký tự hiển thị: đếm theo mã thì ra 68 (verifier 4/11).
  const src = { cues: [C(10, 11.5, long), C(20, 21, 'ngắn'), C(30, 31, long), C(32, 33, 'B'), C(40, 41.2, 'a\u0301'.repeat(34)), C(50, 51, long)] };
  const out = merge([src]);
  assert.equal(out[5].end, 51.5, 'dòng cuối (chưa biết dòng kế) giữ nguyên');
  assert.ok(Math.abs(out[0].end - 13) < 1e-6, 'tới se + 1,5 s: ' + out[0].end);   // cần tới 14 s
  assert.equal(out[1].end, 21.5, 'dòng đọc kịp giữ nguyên');
  assert.ok(Math.abs(out[2].end - (32 - 2 / 30)) < 1e-6, 'dừng trước dòng kế: ' + out[2].end);
  assert.ok(Math.abs(out[4].end - 42) < 1e-6, 'đếm theo ký tự hiển thị (chữ có dấu là một ký tự): ' + out[4].end);
  assert.deepEqual(Array.from(out, c => c.start), [10, 20, 30, 32, 40, 50]);
  assert.equal(src.cues[0].end, 12, 'không sửa vào cues gốc của đoạn');
  assert.equal(at(out, 12.8).vi, long);
});
console.log(`\n${n} kiểm tra đều đạt.`);

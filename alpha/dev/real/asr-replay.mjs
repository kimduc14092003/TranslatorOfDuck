// Gọi lại nhận dạng giọng nói N lần trên cùng một đoạn âm thanh đã giữ (server chạy với TOD_DUMP=1), xem kết quả dao động
// thế nào và câu nào bị bỏ ở bước cắt theo đoạn. TỐN TIỀN: mỗi lần là một lần gọi dịch vụ nhận dạng thật; hỏi chủ dự án trước.
//   node asr-replay.mjs <file.aac> <audioStart> <from> <to> [N=1]
// Nạp alpha/server/pipeline.mjs, nên nạp cả alpha/server/.env (không in ra). Âm thanh có bản quyền: xoá khi xong.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SERVER_DIR, args } from './lib.mjs';

const [file, as, from, to, N] = args()._;
if (!file || as == null || from == null || to == null) { console.log('node asr-replay.mjs <file.aac> <audioStart> <from> <to> [N=1]'); process.exit(1); }
const P = await import(pathToFileURL(path.join(SERVER_DIR, 'pipeline.mjs')).href);
const audio = await P.extractAudio(fs.readFileSync(file), 'aac');
for (let i = 0; i < Number(N || 1); i++) {
  const t0 = Date.now();
  const raw = await P.transcribe(audio.mp3);
  const r = P.resplitSentences(raw);
  const w = P.windowAsr(r, Number(as), Number(from), Number(to), Number(from) - Number(as) >= 4);
  console.log(JSON.stringify({ i, ms: Date.now() - t0, model: raw.model, seconds: audio.seconds, rawSegments: raw.segments.length, words: raw.words.length,
    punctuated: raw.words.filter((x) => /[，。！？、,.!?]$/.test(x.text)).length, inWindow: w.segments.length,
    segments: r.segments.map((s) => `${(s.start + Number(as)).toFixed(1)}-${(s.end + Number(as)).toFixed(1)} ${s.text.slice(0, 14)}`) }));
}

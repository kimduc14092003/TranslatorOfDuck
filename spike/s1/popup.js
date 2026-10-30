'use strict';
const KEY = 's1_report';
const NOTES = 's1_notes';
const $ = (id) => document.getElementById(id);

const median = (a) => {
  if (!a || !a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) + '%' : '–');
const okCount = (o) => Object.entries(o || {}).filter(([k]) => k.startsWith('ok_')).reduce((s, [, v]) => s + v, 0);
const total = (o) => Object.values(o || {}).reduce((s, v) => s + v, 0);

function summarize(r) {
  const it = r.items;
  const a = r.active;
  const dl = r.downloads;
  const epCalls = Object.values(r.endpoints).reduce((s, e) => s + e.calls, 0);
  const epItems = Object.values(r.endpoints).reduce((s, e) => s + e.items, 0);
  const minutes = Math.max(1, Math.round((r.updatedAt - r.createdAt) / 60000));
  return {
    'Thời gian thu (phút)': minutes,
    'Số lần tải trang / chế độ hook': r.pageLoads + ' / ' + (Object.entries(r.hookModes).map(([k, v]) => k + '×' + v).join(', ') || 'hiện tại: ' + (r.env.lastHookMode || '?')),
    'Khu vực đã lướt': Object.entries(r.active.section || {}).map(([k, v]) => k + ' ' + v).join(', ') || '–',
    'Trình duyệt': (r.env.cocCoc ? 'Cốc Cốc' : 'Chrome') + ' ' + (r.env.chromeMajor || '?'),
    'T0: lượt gọi API feed bắt được': epCalls + ' (' + epItems + ' item)',
    'Video khác nhau thấy được': it.unique + ' (' + Object.entries(it.bySource).map(([k, v]) => k + ' ' + v).join(', ') + ')',
    'Video đã phát': a.plays,
    'Có dữ liệu TRƯỚC khi phát': pct(a.withDescAtPlay, a.plays),
    'Trung vị đi trước (giây)': median(a.leadBeforePlayMs) != null ? (median(a.leadBeforePlayMs) / 1000).toFixed(1) : '–',
    'Có luồng chỉ âm thanh': pct(it.withAudioOnly, it.unique),
    'Video tải thử': dl.itemsTested,
    'Nguồn chính tải được (A0 hoặc A2)': pct(dl.primaryOk, dl.primaryOk + dl.primaryFail),
    'A0 thành công': pct(okCount(dl.a0), total(dl.a0)),
    'A2 thành công': pct(okCount(dl.a2), total(dl.a2)),
    'Thử lại có cookie sau 403 thành công': pct(okCount(dl.a2c), total(dl.a2c)),
    'Trung vị tải 256 KB (A0, ms)': median(dl.tTotalMs.a0) ?? '–',
    'File faststart (moov đầu file)': pct(dl.faststart.true || 0, total(dl.faststart)),
    'Có track âm thanh mp4a': pct(dl.hasMp4a.true || 0, total(dl.hasMp4a)),
    'Trung vị URL còn hạn (phút)': median(dl.expiryMin) ?? '–',
    'Hook bị trang thay thế (lần kiểm)': r.hook.fetchReplaced + '/' + r.hook.checks,
    'Captcha xuất hiện': r.captcha.appearances,
  };
}

function render(r) {
  const tb = $('summary');
  tb.textContent = '';
  if (!r) {
    const tr = tb.insertRow();
    tr.insertCell().textContent = 'Chưa có số liệu. Mở www.douyin.com và lướt feed.';
    tr.insertCell();
    return;
  }
  for (const [k, v] of Object.entries(summarize(r))) {
    const tr = tb.insertRow();
    tr.insertCell().textContent = k;
    tr.insertCell().textContent = String(v);
  }
}

async function buildExport() {
  const res = await chrome.storage.local.get([KEY, NOTES]);
  const r = res[KEY];
  return JSON.stringify({ spike: 'S1', exportedAt: new Date().toISOString(), notes: res[NOTES] || {},
    summary: r ? summarize(r) : null, report: r || null }, null, 1);
}

function flash(msg) { $('status').textContent = msg; setTimeout(() => { $('status').textContent = ''; }, 3000); }

async function activeDouyinTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshHook() {
  const tab = await activeDouyinTab();
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'getHook' });
    $('hook').textContent = res.hook === 'off' ? 'Hook: TẮT (đối chứng) → bật lại' : 'Hook: BẬT → tắt để đo đối chứng';
    $('hook').dataset.state = res.hook;
    $('hook').disabled = false;
  } catch (_) {
    $('hook').textContent = 'Hook: mở tab douyin.com để đổi';
    $('hook').disabled = true;
  }
}

$('copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(await buildExport());
  flash('Đã sao chép. Dán vào chat là được.');
});
$('save').addEventListener('click', async () => {
  const blob = new Blob([await buildExport()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 's1-report-' + new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.json';
  a.click();
  flash('Đã lưu file báo cáo.');
});
$('reset').addEventListener('click', async () => {
  await chrome.storage.local.remove(KEY);
  render(null);
  flash('Đã xóa số liệu. Lướt lại để đo từ đầu.');
});
$('hook').addEventListener('click', async () => {
  const tab = await activeDouyinTab();
  const on = $('hook').dataset.state === 'off';
  await chrome.tabs.sendMessage(tab.id, { type: 'setHook', on });
  await chrome.tabs.reload(tab.id);
  flash(on ? 'Đã bật hook, trang đang tải lại.' : 'Đã tắt hook (đo đối chứng), trang đang tải lại.');
  setTimeout(refreshHook, 1500);
});
$('loggedIn').addEventListener('change', async (e) => {
  const res = await chrome.storage.local.get(NOTES);
  await chrome.storage.local.set({ [NOTES]: { ...(res[NOTES] || {}), loggedIn: e.target.checked } });
});

// ---------------- S3: thu mẫu ----------------
async function renderSampling() {
  const { s3_sampling: sp = { on: false, target: 60 }, s3_samples: list = [] } = await chrome.storage.local.get(['s3_sampling', 's3_samples']);
  $('sampleTarget').value = sp.target || 60;
  $('sampleToggle').textContent = sp.on ? 'Dừng thu mẫu' : 'Bắt đầu thu mẫu';
  $('sampleStatus').textContent = 'Đã lưu ' + list.length + '/' + (sp.target || 60) + ' mẫu' + (sp.on ? ' (đang thu: cứ lướt và xem từng video vài giây)' : '') + '.';
}
$('sampleToggle').addEventListener('click', async () => {
  const { s3_sampling: sp = { on: false } } = await chrome.storage.local.get('s3_sampling');
  const target = Math.max(5, Math.min(200, Number($('sampleTarget').value) || 60));
  await chrome.storage.local.set({ s3_sampling: { on: !sp.on, target, seconds: 30 } });
  renderSampling();
});
$('sampleManifest').addEventListener('click', async () => {
  const { s3_samples: list = [] } = await chrome.storage.local.get('s3_samples');
  const blob = new Blob([JSON.stringify({ kind: 'tod_s3_manifest', version: 1, createdAt: new Date().toISOString(), samples: list }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'tod_s3_manifest.json';
  a.click();
  flash('Đã lưu tod_s3_manifest.json (' + list.length + ' mẫu).');
});
$('sampleClear').addEventListener('click', async () => {
  await chrome.storage.local.set({ s3_samples: [], s3_sampling: { on: false, target: Number($('sampleTarget').value) || 60, seconds: 30 } });
  renderSampling();
  flash('Đã xóa danh sách mẫu (file đã lưu trong Downloads vẫn còn).');
});
chrome.storage.onChanged.addListener((ch) => { if (ch.s3_samples || ch.s3_sampling) renderSampling(); });

(async () => {
  renderSampling();
  const res = await chrome.storage.local.get([KEY, NOTES]);
  render(res[KEY]);
  $('loggedIn').checked = !!(res[NOTES] && res[NOTES].loggedIn);
  refreshHook();
})();

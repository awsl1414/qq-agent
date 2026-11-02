// 今日用量卡片：只负责把主进程算好的数字排版出来。
// 数据来自 window.qqPetUsage（受限 preload），页面本身不发起任何网络请求。
//
// 2026-10-24：从多行卡片改成与主界面顶栏同一口径的一行式用量串
// （「今日：N 次运行 · X tok · 缓存 Y% · ¥Z」+ 下方「搜索：N 次」）。
// 主进程每 5 秒推一次新数据，这里原样重排，不停在旧数字上。
const api = window.qqPetUsage;
const $ = (id) => document.getElementById(id);

// token 紧凑格式与主界面顶栏（ui/app/00-core.js 的 fmtTokShort）逐字一致：
// K/M/G 三档、阈值 1000 —— 同一个数字在桌宠和主界面必须长得一样。
const fmtTokShort = (n) => {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs < 1000) return String(Math.round(v));
  if (abs < 1e6) return `${(v / 1e3).toFixed(1)}k`;
  if (abs < 1e9) return `${(v / 1e6).toFixed(2)}M`;
  return `${(v / 1e9).toFixed(2)}G`;
};
const fmtTokens = (n) => `${fmtTokShort(n)} tok`;

function render(payload) {
  const data = payload?.data || payload;
  if (!data) return;
  const totals = data.totals || {};
  const runs = Number(totals.runs) || 0;
  const rate = Number(totals.cacheHitRate) || 0;
  const cost = Number(totals.cost) || 0;
  // 成本：官方价匹配得上就显示；匹配不上（中转站常见）只显示 token，
  // 不显示误导性的 ¥0 —— 与顶栏口径一致。
  const rateTxt = rate > 0 ? ` · 缓存 ${Math.round(rate * 100)}%` : '';
  const costTxt = cost > 0 ? ` · ¥${cost.toFixed(3)}` : '';
  $('usage').textContent = `今日：${runs} 次运行 · ${fmtTokens(totals.totalTokens)}${rateTxt}${costTxt}`;
  $('search').textContent = `搜索：${Number(data.searchCount) || 0} 次`;
}

function close() {
  try { api?.close(); } catch { /* 无桥时忽略 */ }
}

window.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
// 点卡片空白处也收起来（这是一张"看一眼"的卡，不该挡着桌面）
document.addEventListener('pointerdown', close);

api?.onData?.(render);
Promise.resolve(api?.ready?.()).then((state) => { if (state?.data) render(state); }).catch(() => {});

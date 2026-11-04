// QQ Agent 控制台前端：会话式（每次运行 = 一个会话）。
// ── 基础层（工具函数 / state / 主题 / 峰谷 / 滑条）。
//    所有段都是普通脚本（无 import/export），按 index.html 里的 defer 顺序执行；
//    跨段共享的顶层 let/const 是全局词法绑定。
//    vendor 模块（tier-slider / price-match）由 /app.js（ESM 桥）挂到 window 上。
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ── 活性心跳 ──────────────────────────────────────────────────────────────
// 主进程的看门狗（electron/main.js 的 probePage）每 5 秒读一次 window.__qaBeat：
// 只要它在递增，就说明渲染主线程还在正常跑。
//
// 为什么需要它：有一类僵死是"JS 还活着、但界面已经冻住"（渲染/合成层面），
// 这类故障 render-process-gone 不会触发、appReady 之类的启动标志也恒为真，
// 只有"心跳还在不在动"能把它和正常工作区分开。
//
// ⚠️ 窗口隐藏时 Chromium 会节流甚至暂停定时器，心跳会停，这是正常的，
//    所以主进程只在窗口可见时才拿它做判定（缩到托盘不会误判成僵死）。
window.__qaBeat = 0;
setInterval(() => { window.__qaBeat = (window.__qaBeat || 0) + 1; }, 1000);

// ── 后台降载 ──────────────────────────────────────────────────────────────
// 窗口隐藏/被遮挡时给 <html> 挂 .qa-bg，style.css 末尾那一段据此把装饰性的
// infinite 动画（骨架 shimmer、各类 spinner、? 主题的 VHS 扫描线等）统一改成
// animation-play-state: paused。
//
// 为什么需要：为了"被遮挡时不误判僵死"，页面关掉了 backgroundThrottling，
// 代价是后台照样全速跑动画，笔记本上实耗电，集显机上还会与合成器抢资源、
// 表现为偶发掉帧。可见时行为逐帧不变（class 只在隐藏时挂）。
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('qa-bg', document.hidden === true);
});

// 列表分页：一次渲染多少条 / 滚到底部再追加多少条
const SESSION_PAGE = 50;      // 会话页：一次渲染多少条
const SESSION_KEEP = 400;     // 会话页：内存里最多保留多少条（与请求量一致）
const CHAT_MSG_PAGE = 500;    // 存档页：首次加载条数
const CHAT_MSG_MORE = 200;    // 存档页：每次滚动追加

// ── 峰谷时段预设 ──────────────────────────────────────────────────────────
// 内置作息模板（一键填充时段+档位）+ 一份用户自定义（custom）。
// sliderPos 口径：0~100（10=仅艾特，100=全响应），与峰谷设置页输入框一致。
const PEAK_PRESETS = {
  // 预设标签带「计费」二字：这个功能的动机是省钱（部分厂商高峰时段
  // token 更贵），不是作息习惯。只写"高峰"会让人以为是"群聊高峰时间"。
  workbuddy: { label: 'workbuddy（早 8~晚 11 计费高峰）',
    peak: { start: '08:00', end: '23:00', sliderPos: 10 }, valley: { start: '23:00', end: '08:00', sliderPos: 100 } },
  deepseek: { label: 'deepseek（早 9~晚 6 计费高峰）',
    peak: { start: '09:00', end: '18:00', sliderPos: 10 }, valley: { start: '18:00', end: '09:00', sliderPos: 100 } }
};

/** 预设下拉的选项列表：内置 2 个 + 自定义（有才显示）。 */
function peakPresetOptions(ps) {
  const out = Object.entries(PEAK_PRESETS).map(([k, v]) => [k, v.label]);
  const cu = ps?.custom;
  if (cu?.peak?.start) {
    out.push(['custom', `自定义（峰 ${cu.peak.start}~${cu.peak.end} @${cu.peak.sliderPos} / 其余时间 @${cu.valley?.sliderPos ?? 100}）`]);
  }
  return out;
}

/** 把预设套进当前表单（改 DOM 值，用户仍可继续微调后保存）。 */
function applyPeakPreset(key) {
  const p = PEAK_PRESETS[key] || state.config?.store?.peakSchedule?.custom;
  if (!p?.peak) return;
  // ⚠️ 设值后必须派发 input 事件：程序改 .value 不会触发监听，
  // 不派发的话时段字段的联动全停留在旧状态。
  const setVal = (sel, v) => {
    const el = $(sel);
    if (!el) return;
    el.value = v;
    try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch { /* 旧环境无 Event 构造器时退化为只设值 */ }
  };
  setVal('#cfg-peak-start', p.peak.start);
  setVal('#cfg-peak-end', p.peak.end);
  // 档位点走自定义竖向滑条控制器（activeVSlider 在活跃设置弹窗打开时挂上）。
  // 高峰珠（档位低）与低谷珠（档位高）各就各位；applyValues 会触发一次
  // onChange 把值写进弹窗草稿，刻度/区间带/说明文字随之刷新。
  const toSliderPos = (raw, fallback) => {
    if (raw === null || raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : fallback;
  };
  const peakPos = toSliderPos(p.peak.sliderPos, 0);
  const valleyPos = toSliderPos(p.valley?.sliderPos, 100);
  const hi = Math.min(peakPos, valleyPos);
  const lo = Math.max(peakPos, valleyPos);
  activeVSlider?.applyValues(lo, hi);
  const hint = $('#peak-preset-hint');
  if (hint) hint.textContent = key === 'custom' ? '已套用「自定义」。可继续微调，保存后生效。' : `已套用「${PEAK_PRESETS[key].label}」。可继续微调，保存后生效。`;
}

/* ═══ 自定义档位滑条（横向）═══
   从零实现的指针驱动滑条，不用任何 <input type=range>：原生 range 无法
   在同一条轨道上放两颗可独立抓取的珠子（两个 range 叠加只能点到最上面那个）。
   控制器协议：
     createVSlider({ mount, dual, low, high, onChange, onInput })
       mount    挂载点元素
       dual     true = 双珠（峰谷），false = 单珠
       low/high 初始值（0~100，恒满足 low >= high；单珠只用 low）
       onChange 值变化回调 ({ low, high, byUser })
       onInput  拖动中高频回调（同参，可选）
     .setValues(low, high)   外部装值（不触发 onChange）
     .applyValues(low, high) 外部装值并**触发一次** onChange（预设套用用）
     .setDual(bool)          切换单/双珠形态（不触发 onChange）
     .setDisabled(bool)      只读态（分群模式但白名单为空）
     .destroy()              摘监听（弹窗关闭时调用）
   可访问性：容器 role=slider + aria-valuenow/min/max + 方向键步进（左右 1、
   PgUp/PgDn 10、Home/End 到端点）；双珠时 Tab 在两颗珠间切换，各自响应键盘。 */
let activeVSlider = null;   // 活跃设置弹窗当前打开的控制器实例（applyPeakPreset 要用）

function createVSlider({ mount, dual = false, low = 100, high = 10, onChange = null, onInput = null } = {}) {
  if (!mount) return null;
  const el = typeof mount === 'string' ? $(mount) : mount;
  if (!el) return null;

  el.classList.add('vslider2');
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-orientation', 'horizontal');
  el.setAttribute('aria-valuemin', '0');
  el.setAttribute('aria-valuemax', '100');
  el.setAttribute('tabindex', '0');

  // DOM：轨道（渐变）+ 可选区间带 + 两颗珠（低谷彩珠 / 高峰灰珠）
  // ⚠️ 必须是横向：style.css 把 `.vslider2` 和横向的 `.tier-slider` 写在同一条
  //    规则里（height:6px / 背景 card-hi），竖向容器会被一起压成 6px 横条。
  el.innerHTML = `
    <div class="vs2-track"></div>
    <div class="vs2-band"></div>
    <div class="vs2-thumb vs2-low" tabindex="0" role="slider" aria-orientation="horizontal"
      aria-label="低谷时段档位（活跃）" aria-valuemin="0" aria-valuemax="100"></div>
    <div class="vs2-thumb vs2-high" tabindex="0" role="slider" aria-orientation="horizontal"
      aria-label="高峰时段档位（安静）" aria-valuemin="0" aria-valuemax="100"></div>`;
  const trackEl = el.querySelector('.vs2-track');
  const bandEl = el.querySelector('.vs2-band');
  const lowEl = el.querySelector('.vs2-low');
  const highEl = el.querySelector('.vs2-high');

  let lo = Math.min(100, Math.max(0, Number(low) || 0));
  let hi = Math.min(100, Math.max(0, Number(high) || 0));
  if (hi > lo) { const x = hi; hi = lo; lo = x; }
  let isDual = !!dual;
  let disabled = false;
  let dragging = null;         // 'low' | 'high' | null
  let destroyed = false;
  // 珠心限制在 [R, 100%-R]：贴到 0% / 100% 会让 18px 的视觉珠有一半跑到容器外
  // （拖到最左/最右时珠子被裁成半圆）。限制后珠子边缘正好与轨道端点齐平。
  // R 取 12 = CSS 里 .vs2-thumb 的 margin-left:-12px（24px 热区的一半），
  // 这样连透明的热区也完整落在容器内。
  const THUMB_R = 12;
  // ⚠️ 必须写成 `calc(100% - 12px)` 而不是 `calc(100% + -12px)`：
  //    后者在 Chromium 里是无效值，会被静默丢弃（left 回落 auto → 珠子跳到 0）。
  const pctLeft = (v) => {
    const d = THUMB_R - (2 * THUMB_R * v) / 100;   // v=0 → +12；v=100 → -12
    return d >= 0 ? `calc(${v}% + ${d}px)` : `calc(${v}% - ${-d}px)`;
  };

  // ── 渲染 ──
  // 横向：珠心锚在值的位置（CSS 里 margin-left:-12px 把 left 锚点折回珠心）
  function render() {
    lowEl.style.left = pctLeft(lo);
    lowEl.setAttribute('aria-valuenow', String(Math.round(lo * 10) / 10));
    highEl.style.left = pctLeft(hi);
    highEl.setAttribute('aria-valuenow', String(Math.round(hi * 10) / 10));
    el.setAttribute('aria-valuenow', String(Math.round(lo * 10) / 10));
    highEl.style.display = isDual ? '' : 'none';
    if (isDual && lo > hi) {
      bandEl.style.display = '';
      // 区间带与两珠同一套映射：左端 = mapped(hi)，右端 = mapped(lo)
      bandEl.style.left = pctLeft(hi);
      bandEl.style.width = `calc(${lo - hi}% - ${(2 * THUMB_R * (lo - hi)) / 100}px)`;
    } else {
      bandEl.style.display = 'none';
    }
  }

  // ── 事件 ──
  function posFromEvent(e) {
    const rect = el.getBoundingClientRect();
    // left=0 在左（1 档端），100 在右（4 档端）。
    // 与 pctLeft 互逆：珠子中心只在 [R, width-R] 之间移动，
    // 指针映射也要按这段可用宽度算，否则拖到边缘时珠子与指针会差出 R 像素。
    const x = (e.touches?.[0] ?? e).clientX;
    const usable = Math.max(1, rect.width - 2 * THUMB_R);
    const raw = ((x - rect.left - THUMB_R) / usable) * 100;
    return Math.min(100, Math.max(0, raw));
  }

  function onDown(e) {
    if (disabled || destroyed) return;
    const pos = posFromEvent(e);
    // 抓取判定：离哪颗珠近抓哪颗；双珠重叠时优先低谷（彩珠在上层）
    const dLow = Math.abs(pos - lo);
    const dHigh = isDual ? Math.abs(pos - hi) : Infinity;
    dragging = dHigh < dLow ? 'high' : 'low';
    moveTo(dragging, pos, true);
    e.preventDefault();   // 阻止文本选中/触摸滚动
  }
  function onMove(e) {
    if (!dragging || disabled || destroyed) return;
    moveTo(dragging, posFromEvent(e), true);
    e.preventDefault();
  }
  function onUp() { dragging = null; }
  // 指针事件统一走 pointer 系列（鼠标+触摸+笔一套搞定），move/up 挂 window 才能拖出边界
  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);

  function moveTo(which, pos, byUser) {
    if (which === 'high') {
      hi = pos;
      if (hi > lo) hi = lo;          // 高峰珠不能越过低谷珠（上界）
    } else {
      lo = pos;
      // 约束只在双珠时有意义：单珠模式下隐藏的高峰珠是"幽灵下界"，
      // 会把低谷珠锁死在初始位置以下（表现为"全局档位拖不动"）。
      if (isDual && lo < hi) lo = hi;
      if (!isDual) hi = Math.min(hi, lo);   // 维持 lo >= hi 不变量（切双珠时干净）
    }
    render();
    if (byUser) {
      onInput?.({ low: lo, high: hi, byUser: true });
      onChange?.({ low: lo, high: hi, byUser: true });
    }
  }

  // 键盘：每颗珠各自响应方向键（可访问性硬要求）
  function keyFor(target, e) {
    const which = target === highEl ? 'high' : 'low';
    const step = e.shiftKey ? 10 : 1;
    let pos = which === 'high' ? hi : lo;
    switch (e.key) {
      case 'ArrowUp': case 'ArrowRight': pos += step; break;
      case 'ArrowDown': case 'ArrowLeft': pos -= step; break;
      case 'PageUp': pos += 10; break;
      case 'PageDown': pos -= 10; break;
      case 'Home': pos = 0; break;
      case 'End': pos = 100; break;
      default: return false;
    }
    e.preventDefault();
    moveTo(which, Math.min(100, Math.max(0, pos)), true);
    return true;
  }
  lowEl.addEventListener('keydown', (e) => keyFor(lowEl, e));
  highEl.addEventListener('keydown', (e) => keyFor(highEl, e));

  // 构造完先画一次。不画的话，任何"创建后不立刻赋值"的入口都会看到
  // 两颗珠都停在最左端。
  render();
  return {
    get values() { return { low: lo, high: hi }; },
    setValues(lowV, highV) {
      let nLo = Math.min(100, Math.max(0, Number(lowV) || 0));
      let nHi = Math.min(100, Math.max(0, Number(highV ?? nLo) || 0));
      if (nHi > nLo) { const x = nHi; nHi = nLo; nLo = x; }
      lo = nLo; hi = nHi; render();
    },
    applyValues(lowV, highV) {
      this.setValues(lowV, highV);
      onChange?.({ low: lo, high: hi, byUser: false });
    },
    setDual(on) { isDual = !!on; render(); },
    setDisabled(on) {
      disabled = !!on;
      el.classList.toggle('vs2-disabled', disabled);
      lowEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      highEl.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    },
    focusLow() { try { lowEl.focus({ preventScroll: true }); } catch { /* ignore */ } },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      el.innerHTML = '';
    }
  };
}

const state = {
  tab: 'sessions',
  sessions: [],          // 摘要列表
  currentSessionId: null,
  sessionDetail: null,   // 完整记录
  chats: [],
  currentChatKey: null,
  chatMessages: [],
  config: null,
  personaTemplates: {},
  skills: [],            // 扩展条目状态列表（技能+插件，后端判定，含 kind 与不可用原因）
  skillsReady: false,    // 扩展列表是否已从后端拉回（区分"加载中"与"真的一件都没装"）
  skillsSummary: {},     // 后端全量摘要 { total, active, disabled, broken, capabilities }
                         // ⚠️ 两页的"生效 N/M"不读它，而是按本页条目现算，
                         // 否则技能页会把插件的数量也算进去，两个页签显示同一组数字。
  uninstalledSkills: [], // 配置里有 skills.<id> 段、但磁盘上已无此条目（删目录后的配置残留）
  status: null,
  paused: false,
  pauseReason: null,
  autoFollowRunning: true,
  settingsSection: 'api',
  memoryView: 'events',
  usageMetric: 'runs',   // 用量页三张图当前显示的指标（USAGE_METRICS 里的键）
  currentMemoryChatKey: null,
  groupMembers: [],
  groupMembersLoaded: false,
  // 记忆整理状态：按 chatKey 存，不依赖 DOM。
  // 切页签会导致记忆页 DOM 重建，状态若只存在按钮/文本节点里就会丢失，
  // 用户切回来时看不出整理是在跑还是已经结束了。
  consolidating: {},      // chatKey -> { startedAt }
  consolidateResult: {}, // chatKey -> { note, at, failed? }
  // 提示词预览缓存（GET /api/prompt-preview）：按当前启停状态组装的系统提示 + 可用工具。
  // 设置-工具页与技能页右侧共用；开关变动后 refreshPromptPreview() 拉新并原地替换 DOM。
  promptPreview: null
};

// ── 工具函数 ──
/** 数字加千分位（token 计数用）。表格里的精确数值用它，不做单位压缩。 */
const fmtTok = (n) => (Number(n) || 0).toLocaleString('zh-CN');

/**
 * token 计数的紧凑格式（图表气泡、坐标轴、顶部概览条共用）。
 *
 * ⚠️ 不要另造换算：曾经有三套互不相同的实现（01-boot.js 的 k 套 k、
 * 04-archive-usage.js 的丢精度取整、fmtTok 的不加单位），同一个数字在
 * 概览条 / 卡片 / 坐标轴 / 表格里长得都不一样。
 *
 * 统一到 K / M / G 三档，阈值 1000 而不是 10000：否则 9999 显示「9999」
 * 而 10000 突然跳成「10.0k」，视觉上像数据出错。
 *   999  → 999        1000 → 1.0k       16_871_668 → 16.9M
 */
function fmtTokShort(n) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  if (abs < 1000) return String(Math.round(v));
  if (abs < 1e6) return `${(v / 1e3).toFixed(1)}k`;
  if (abs < 1e9) return `${(v / 1e6).toFixed(2)}M`;
  return `${(v / 1e9).toFixed(2)}G`;
}

/**
 * 金额格式化（成本用）。
 * 成本经常是小额（几分钱），固定两位小数会全显示成 ¥0.00 看不出差别，
 * 所以小于 1 时多给两位有效数字。
 */
const fmtYuan = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '¥0';
  if (Math.abs(v) < 1) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(2)}`;
};

/**
 * 用量页当前选中的时间范围（对应 USAGE_RANGES 里的值）。
 * 用 let 而不是 const：点范围按钮会改它，改完要重新拉取数据。
 */
let usageRange = '7';

/*
 * 工具的中文名与分类，用于"调用明细"弹窗。
 *
 * 用 emoji 当图标只是为了扫一眼好认，这类"没什么实际用处但有趣"的细节，
 * 是特意保留的：一张纯数字的表格很无聊，分类 + 图标能让人真的去看一眼。
 */
const TOOL_META = {
  // 发言类
  send_message:      { name: '发消息',     cat: '发言',   icon: '💬' },
  send_poke:         { name: '戳一戳',     cat: '发言',   icon: '👆' },
  // 查看类
  get_recent_messages: { name: '翻聊天记录', cat: '查看', icon: '📜' },
  get_message_detail:  { name: '看消息详情', cat: '查看', icon: '🔍' },
  get_message_images:  { name: '看图片',     cat: '查看', icon: '🖼️' },
  get_active_members:  { name: '看活跃群友', cat: '查看', icon: '👥' },
  // 表情包（plugins/sticker 注册，工具 id 带 sticker__ 前缀）
  sticker__send_sticker:          { name: '发送表情',       cat: '表情', icon: '😀' },
  sticker__list_stickers:         { name: '查看表情库',     cat: '表情', icon: '📋' },
  sticker__get_sticker_image:     { name: '查看表情图片',   cat: '表情', icon: '🖼️' },
  sticker__collect_sticker:       { name: '收藏表情',       cat: '表情', icon: '⭐' },
  sticker__note:                  { name: '备注表情',       cat: '表情', icon: '📝' },
  sticker__delete_sticker:        { name: '删除表情',       cat: '表情', icon: '🗑️' },
  sticker__restore_sticker:       { name: '恢复表情',       cat: '表情', icon: '↩️' },
  sticker__list_deleted_stickers: { name: '看删过哪些表情', cat: '表情', icon: '🗃️' },
  // 记忆
  memory_append:     { name: '记一条',     cat: '记忆',   icon: '🧠' },
  memory_query:      { name: '查记忆',     cat: '记忆',   icon: '🧠' },
  memory_remove:     { name: '删记忆',     cat: '记忆',   icon: '🧹' },
  // 联网
  web_search:        { name: '联网搜索',   cat: '联网',   icon: '🌐' },
  web_fetch:         { name: '抓网页',     cat: '联网',   icon: '🔗' },
  // 其他
  report_feedback:   { name: '汇报反馈',   cat: '其他',   icon: '📣' },
  finish:            { name: '结束本次',   cat: '其他',   icon: '🏁' },

  // ── 插件 / 技能注册的工具（id 一律带 `<插件id>__` 前缀，见 plugin-loader 的 registerTool）──
  // 「用量 → 调用明细」按这里的 cat 分组；**没登记的工具会退化成裸 id + 🔧**，
  // 所以插件新增工具时记得在这里补一行。
  // 中文名 / 图标优先照抄插件自己声明的 name / icon；只有插件没声明图标（落到 🔧
  // 占位）时才补一个更贴切的。分类按插件声明的 category 映射到下面的展示分组。
  // 知识
  'knowledge-memes__memory_meme_save':   { name: '记录梗',           cat: '知识', icon: '📚' },
  'knowledge-memes__memory_meme_search': { name: '搜知识库',         cat: '知识', icon: '🔍' },
  'memory-recall__memory_search':        { name: '检索长期记忆',     cat: '知识', icon: '🧠' },
  'memory-recall__memory_archive':       { name: '翻阅聊天归档',     cat: '知识', icon: '🗂️' },
  'memory-recall__memory_status':        { name: '查看记忆索引状态', cat: '知识', icon: '📊' },
  'mem-layered__memory_todo':            { name: '记待办 / 办完待办', cat: '知识', icon: '📌' },
  // 发言 / 查看
  'keyword-reply__keyword_reply':        { name: '关键词自动回复',   cat: '发言', icon: '🔑' },
  'keyword-reply__keyword_reply_list':   { name: '查看关键词列表',   cat: '查看', icon: '📋' },
  // 媒体
  'image-generate__draw':                { name: '生成图片',         cat: '媒体', icon: '🎨' },
  'random-image__random_image':          { name: '发二次元随机图',   cat: '媒体', icon: '🖼️' },
  // 工具
  'calculator__calculate':               { name: '计算',             cat: '工具', icon: '🧮' },
  'calculator__base_convert':            { name: '进制转换',         cat: '工具', icon: '🔢' },
  'help-board__help_board':              { name: '指令一览',         cat: '工具', icon: '🧭' },
  'schedule__schedule_add':              { name: '添加日程',         cat: '工具', icon: '📅' },
  'schedule__schedule_list':             { name: '查看日程',         cat: '工具', icon: '📋' },
  'schedule__schedule_del':              { name: '删除日程',         cat: '工具', icon: '🗑️' },
  // 系统
  'self-doctor__self_doctor':            { name: '系统自检',         cat: '系统', icon: '🩺' },
  'self-doctor__scan_project':           { name: '全项目扫描',       cat: '系统', icon: '🔬' },
  'cache-guard__cache_report':           { name: '缓存命中率报表',   cat: '系统', icon: '📈' }
};

/**
 * 分类的展示顺序（"其他"垫底）。
 * ⚠️ 这里没列到的分类**不会消失**（08-modals.js 会把它们追加到末尾），
 *    但会排到"其他"后面，所以新增展示分类时要同步加到这里。
 */
const TOOL_CAT_ORDER = ['发言', '查看', '表情', '知识', '记忆', '媒体', '工具', '系统', '联网', '其他'];

/** 用量页的时间范围选项：[传给后端的值, 按钮文案] */
const USAGE_RANGES = [
  ['today', '今日'],
  ['7', '近 7 天'],
  ['30', '近 30 天'],
  ['all', '全部']
];

/** 三张图表（按天折线 / 按会话条形 / 按模型条形）共用的指标：[键, 按钮文案] */
const USAGE_METRICS = [
  ['runs', '调用次数'],
  ['cost', '成本'],
  ['tokens', 'Token']
];

// 控制台标识头：证明请求来自本控制台页面，而非外部网页冒用浏览器。
// 带自定义头的请求必须过 CORS 预检，天然挡住跨站脚本/表单的静默读取。
const CONSOLE_MARKER = 'qq-agent-console';
// Browser/headless users may open the console with ?token=<server.token>.
// Cache it for this tab, then remove it from the address bar; Electron replaces the marker
// with its process-private renderer credential in the main-process request interceptor.
// ⚠️ 浏览器原生发起的加载（EventSource / CSS url() / <img src>）附加不了请求头，
//    必须走下面的 withToken() 换成 ?token=，不要各自拼。
const CONSOLE_AUTH_TOKEN = (() => {
  try {
    const url = new URL(window.location.href);
    const supplied = url.searchParams.get('token');
    if (supplied) {
      try { sessionStorage.setItem('qqa-console-token', supplied); } catch { /* 当前标签页仍可用本次凭据 */ }
      url.searchParams.delete('token');
      try { history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`); } catch { /* 不影响请求鉴权 */ }
      return supplied;
    }
    try { return sessionStorage.getItem('qqa-console-token') || ''; } catch { return ''; }
  } catch { return ''; }
})();

/**
 * 给「浏览器原生发起」的请求 URL 补上控制台令牌（?token=）。
 *
 * 为什么需要统一出口：api() 走 fetch，能带 x-console-token 头；但 EventSource、
 * CSS 的 url()、<img src>、<video src> 都是浏览器自己发的请求，附加不了自定义头。
 * 后端 authorize() 同时接受 ?token=，所以这些路径只能把令牌写进查询串。
 * 曾经 token 传递只散落在 api() 与 02-sse-sessions.js 两处，每新增一处原生加载
 * 就必然遗漏一次（配置 server.token 后表现为该资源恒 401、静默失效）。
 * 新增任何原生加载路径都从这里过，不要自己拼 `?token=`。
 *
 * @param {string} url 相对路径（/api/...）；外部绝对 URL 原样返回
 * @returns {string}
 */
function withToken(url) {
  const raw = String(url ?? '');
  if (!CONSOLE_AUTH_TOKEN) return raw;
  // 只处理站内相对路径：外链（http(s)://…、//…、data:）不该带上本机令牌
  if (!raw.startsWith('/') || raw.startsWith('//')) return raw;
  // 有 #hash 时令牌要插在 hash 之前，否则会被当成片段内容（不发给服务端）
  const hashAt = raw.indexOf('#');
  const head = hashAt >= 0 ? raw.slice(0, hashAt) : raw;
  const tail = hashAt >= 0 ? raw.slice(hashAt) : '';
  const sep = head.includes('?') ? '&' : '?';
  return `${head}${sep}token=${encodeURIComponent(CONSOLE_AUTH_TOKEN)}${tail}`;
}

/* ══════════════════════════════════════════════════════════════
   主题（明/暗/系统/？）
   ══════════════════════════════════════════════════════════════
   四种取值：'dark' | 'light' | 'system'（跟随系统偏好）| '?'（整活主题）。
   持久化两层：
     1. localStorage，立即生效，避免每次启动都等接口
     2. 后端 config.ui.theme，跨设备/重装后保留（尽力而为，失败不阻塞）
   首屏防闪由 index.html 的内联脚本负责（读 localStorage 直接设 data-theme）。
*/
const THEME_ICON = { dark: '🌙', light: '☀️', system: '🖥️', '?': '❓' };
const THEME_LABEL = { dark: '暗色', light: '亮色', system: '跟随系统', '?': '？' };
const THEME_VALUES = ['dark', 'light', 'system', '?'];

/** 读取当前主题设置（localStorage 优先，其次系统偏好）。 */
function getThemePref() {
  try {
    const v = localStorage.getItem('qqa-theme');
    if (THEME_VALUES.includes(v)) return v;
  } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  return 'dark';
}

/** 把设置解析成实际要应用的主题名。 */
function resolveTheme(pref) {
  if (THEME_VALUES.includes(pref) && pref !== 'system') return pref;
  // system：跟随系统
  try {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  } catch { return 'dark'; }
}

/** 应用主题到 <html>，并同步按钮图标。 */
function applyTheme(pref) {
  const actual = resolveTheme(pref);
  document.documentElement.setAttribute('data-theme', actual);
  syncChaosLayers(actual === '?');
  try { localStorage.setItem('qqa-theme', pref); } catch { /* 忽略 */ }
}

/* ══════════════════════════════════════════════════════════════
   外观个性化：强调色 / 界面底色 / 底色不透明度 / 背景图 / 整窗不透明度
   ══════════════════════════════════════════════════════════════
   全部只改 CSS 变量与一个静态背景层，不重建 DOM、不加动画，
   本机是软件渲染，个性化不能变成性能负担。
   空值一律"跟随主题"：不覆盖对应变量，这样换主题仍然协调。 */

/** 判断一个字符串是不是可用的 #rgb / #rrggbb 颜色。 */
function isHexColor(v) {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v || '').trim());
}

/** 预设色板：调色不必先想十六进制，点一下就有。 */
const ACCENT_PRESETS = [
  ['#5b8cff', '默认蓝'], ['#7c6cff', '紫罗兰'], ['#00b3a4', '青碧'],
  ['#3fce7a', '草绿'], ['#ffb454', '琥珀'], ['#ff6b8a', '樱粉'],
  ['#e5484d', '朱红'], ['#8b9bb4', '石墨']
];
const BG_PRESETS = [
  ['#0e1013', '默认墨'], ['#151515', '纯黑'], ['#101a24', '深夜蓝'],
  ['#1b1420', '暗紫'], ['#0f1a14', '墨绿'], ['#241a14', '暖棕']
];
/* 玻璃色调：半透明面板/卡片的底色往这个色相上拉。
   只在「全界面透明度」< 100 时看得出来，不透明时卡片是实色，染色等于换了个卡片色。
   ⚠️ 这里给的是色相，不是最终卡片色：实际会按比例混进主题原色
   （暗色主题仍保持暗、亮色主题仍保持亮），见 20-glass.js 的 TINT_WEIGHT。 */
const GLASS_TINT_PRESETS = [
  ['#3d6fd8', '深海蓝'], ['#6d5ce0', '紫雾'], ['#12897f', '青瓷'],
  ['#2f9e5f', '苔绿'], ['#c98a2e', '琥珀'], ['#c9526e', '樱粉'],
  ['#9aa7bd', '月白'], ['#d2694a', '陶土']
];

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// 上一次真正推给主进程的整窗不透明度（见 applyUiCustom 里的注释）。
// 初值 100 = "主窗口生来就是不透明的"，所以配置为 100% 时永远不会触发那次调用。
// 窗口被看门狗重建时页面会整体重载，这个变量跟着归位，不会错记成"已经调过"。
// ⚠️ 别删：applyUiCustom 读写它，少声明一行会让整窗不透明度整个失效，
//    而且异常会被外面"桥不可用"的 catch 吞掉，看不出任何错误。
let lastWinOpacity = 100;

/**
 * 把 config.ui 里的个性化项应用到界面上。
 * 任何一项留空/非法 = 用主题默认值（把对应的内联样式删掉，而不是写成空串，
 * 空串会让 var() 回落到"无效"，同样整条声明失效）。
 * @param {object} ui config.ui（可为空对象）
 * @param {{live?: boolean}} [opts]
 *   live=true（拖动滑条的过程中）：只更新 CSS 变量做即时预览，
 *   **跳过昂贵的跨进程调用**（setOpacity）。理由见下方注释。
 */
function applyUiCustom(ui, opts) {
  const u = ui || {};
  const live = !!(opts && opts.live);
  const root = document.documentElement;

  // 强调色
  if (isHexColor(u.accent)) root.style.setProperty('--accent', String(u.accent).trim());
  else root.style.removeProperty('--accent');

  // 界面底色：只覆盖 --layer-0（--bg 由它派生），卡片仍用 layer-1/2 保持层次
  const bg = isHexColor(u.bgColor) ? String(u.bgColor).trim() : '';
  if (bg) root.style.setProperty('--layer-0', bg);
  else root.style.removeProperty('--layer-0');

  // 底色不透明度：100 = 不透明；调低后窗口底色变半透明（透明窗口下透出背景图/桌面）
  // 下限放到 0：要配合壁纸当底色时，0% 才真的能看清底图（原版 30% 永远压着一层）
  const alpha = clampInt(u.frameAlpha, 0, 100, 100);
  if (alpha >= 100) root.style.setProperty('--frame-bg', 'var(--layer-0)');
  else root.style.setProperty('--frame-bg', `color-mix(in srgb, var(--layer-0) ${alpha}%, transparent)`);

  // 背景图
  const bgEl = document.getElementById('app-bg');
  if (bgEl) {
    const name = String(u.bgImage || '').trim();
    /* ⚠️⚠️ 内置主题跟随（src/wallpaper/theme.js）抓的是壁纸的 preview 缩略图
       （实测 192×192 / 50 帧），用 cover 铺满 1000+ 宽的窗口等于放大 6 倍多，
       糊成一片色块。它本来只是「壁纸套件没接管时的降级兜底」，
       所以：用户在「壁纸」页选过真壁纸时（localStorage 的 wp-console-bg 里有 id，
       真媒体由 14-wallpaper.js 的 #wp-bg-video / #wp-bg-img 负责），这里绝不能铺。
       否则启动首帧先闪那张糊缩略图，等 4K 视频解出首帧才被盖住，观感就是"打开时糊一下"。
       用户自己上传的图（文件名不带 bg-we-）不受影响，照旧铺满。
       这条判断必须留在首帧绘制前的 applyUiCustom 里：只在 wp 那边挂
       html[data-wp='on'] 再 display:none 是来不及的，那时糊图已经画上屏了。 */
    const autoThumb = name.startsWith('bg-we-');
    const wpOwnsBg = (() => {
      try { return !!(JSON.parse(localStorage.getItem('wp-console-bg') || '') || {}).id; }
      catch { return false; }   // 存储被禁/内容坏掉：当作没有壁纸，退回插件兜底
    })();
    const useBg = !!name && !(autoThumb && wpOwnsBg);
    if (useBg) {
      const dim = clampInt(u.bgDim, 0, 85, 0) / 100;
      const fit = String(u.bgFit || 'cover');
      // 暗化不靠 backdrop-filter（软件渲染的帧率杀手），直接叠一层黑纱
      const veil = dim > 0 ? `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), ` : '';
      bgEl.style.backgroundImage = `${veil}url("${withToken(`/api/ui-bg?v=${encodeURIComponent(name)}`)}")`;
      if (fit === 'repeat') {
        bgEl.style.backgroundSize = 'auto';
        bgEl.style.backgroundRepeat = 'repeat';
      } else if (fit === 'contain') {
        bgEl.style.backgroundSize = 'contain';
        bgEl.style.backgroundRepeat = 'no-repeat';
      } else {
        bgEl.style.backgroundSize = 'cover';
        bgEl.style.backgroundRepeat = 'no-repeat';
      }
    } else {
      bgEl.style.backgroundImage = '';
    }
    /* 小图柔化（补上插件的 bgSoften 契约）：插件量过预览图宽度，<720px 时写
       bgSoften（像素半径），本意是"交给前端一次性高斯模糊，做一张柔和的氛围底，
       比硬拉伸体面得多"（原文见 src/wallpaper/theme.js 头部的「分辨率说明」）。
       前端此前从未读过这个字段，缩略图只能被 cover 硬拉伸成马赛克。
       这里交给 CSS 做：filter 挂在静态层上只栅格化一次，
       不是 backdrop-filter 那种逐帧整屏模糊。 */
    const soften = clampInt(u.bgSoften, 0, 60, 0);
    if (useBg && soften > 0) {
      bgEl.style.setProperty('--app-bg-soften', `${soften}px`);
      bgEl.classList.add('is-soft');
    } else {
      bgEl.classList.remove('is-soft');
      bgEl.style.removeProperty('--app-bg-soften');
    }
  }

  // 整窗不透明度：只有 Electron 桌面端有这座桥（浏览器里打开没有 qqaDesktop）
  // ⚠️ live（拖动滑条）阶段跳过这次 IPC：setOpacity 是跨进程调用，挂在滑条的
  //    `input` 上会让拖动期间每一帧都打一次（60fps → 60 次/秒），既浪费又可能
  //    拖慢主进程。CSS 变量照常更新（用户立刻看到颜色变化），真正的窗口透明度
  //    等松手（change 事件）那一次再落。
  // ⚠️ 100% 时一次都不要打，值没变也别打。Electron 在 Windows 上的 SetOpacity
  //    （native_window_views.cc）会无条件给窗口加 WS_EX_LAYERED 并调
  //    SetLayeredWindowAttributes(LWA_ALPHA)，而且没有"回到 1.0 就摘掉这个样式"
  //    的分支。LWA_ALPHA 与真透明窗口用的逐像素 alpha 是互斥的两种分层模式，
  //    一旦调用，那个窗口就只剩第一帧、之后永不重绘。这段代码启动时恒被调用
  //    一次（11-init.js → applyUiCustom），所以 100% 也照调会让"真透明窗口"必挂。
  if (!live) {
    const op = clampInt(u.winOpacity, 30, 100, 100);
    try {
      if (op !== lastWinOpacity
        && window.qqaDesktop && typeof window.qqaDesktop.setOpacity === 'function') {
        window.qqaDesktop.setOpacity(op / 100);
        lastWinOpacity = op;
      }
    } catch { /* 桥不可用（浏览器/旧壳）就只保留界面内的个性化 */ }
  }
}


/* ── 「？」主题的 JS 层：VHS 覆盖层 + 点击爆粒子 ──
   CSS 管不了的就这两件需要一个真实 DOM 层（body 的 ::before/::after 已被占用）。
   主题切走即移除，零残留。 */
function syncChaosLayers(on) {
  let vhs = document.getElementById('chaos-vhs');
  if (on && !vhs) {
    vhs = document.createElement('div');
    vhs.id = 'chaos-vhs';
    vhs.innerHTML = '<div class="vhs-track"></div>';   // 白闪太刺眼已移除，只留扫描线+追踪误差带
    document.body.appendChild(vhs);
  } else if (!on && vhs) {
    vhs.remove();
  }
}

// 点击爆「？」粒子：只在「？」主题下生效（判断放点击时，不绑状态）
//
// ⚠️ 加了"在飞粒子"上限。每个粒子都是 position:fixed + will-change:
//    transform,opacity（见 style.css 的 .chaos-pop），850ms 后才回收。没有节流时
//    在 ? 主题下快速连点会瞬间堆出上百个常驻合成层，合成器扛不住，连点期间掉帧。
//    上限取 48：单击最多爆 5 个，足够容纳任何正常操作节奏，
//    只有"按住连点"才会被截流，被截流时只少几个装饰粒子，不影响功能。
const CHAOS_POP_MAX = 48;
let chaosPopAlive = 0;
document.addEventListener('click', (e) => {
  if (document.documentElement.getAttribute('data-theme') !== '?') return;
  if (chaosPopAlive >= CHAOS_POP_MAX) return;
  // 一次爆 3~5 个，方向随机（抽象 = 不统一）
  const n = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    const el = document.createElement('span');
    el.className = 'chaos-pop';
    el.textContent = '？';
    el.style.left = `${e.clientX}px`;
    el.style.top = `${e.clientY}px`;
    el.style.setProperty('--dx', `${(Math.random() - 0.5) * 160}px`);
    el.style.setProperty('--dy', `${-40 - Math.random() * 90}px`);
    el.style.setProperty('--rot', `${(Math.random() - 0.5) * 540}deg`);
    el.style.fontSize = `${14 + Math.random() * 20}px`;
    document.body.appendChild(el);
    chaosPopAlive++;
    setTimeout(() => { el.remove(); chaosPopAlive--; }, 850);
  }
}, { passive: true });

// 渲染端网络自愈看门狗。说明见下面 api() catch 里的注释。
let __netFailStreak = 0;
let __netFailAt = 0;
let __netRecoverAt = 0;
function noteNetworkFailure() {
  const now = Date.now();
  if (now - __netFailAt > 20000) __netFailStreak = 0;   // 间隔太久不算"连续"
  __netFailStreak++;
  __netFailAt = now;
  // 连续 4 次失败且 5 分钟内没自愈过 → 走一次兜底
  if (__netFailStreak >= 4 && now - __netRecoverAt > 300000) {
    __netRecoverAt = now;
    __netFailStreak = 0;
    // 先重建 SSE（轻量，多数情况这一下就好）
    try { if (typeof reconnectSSE === 'function') reconnectSSE(); } catch { /* 忽略 */ }
    // 延迟探针：已经自愈就别打扰用户；还失败才让 Chromium 丢掉整个坏 socket 池
    setTimeout(() => {
      try {
        fetch('/api/status', { headers: { 'x-console-token': CONSOLE_AUTH_TOKEN || CONSOLE_MARKER } })
          .then(() => { /* 已恢复，无需重载 */ })
          .catch(() => { try { location.reload(); } catch { /* 忽略 */ } });
      } catch { try { location.reload(); } catch { /* 忽略 */ } }
    }, 800);
  }
}

/**
 * 把 HTTP 状态码翻成用户能转述的一句话（只在后端没给 data.error 时使用）。
 * 不写"请联系开发者"这类空话，每条都指向用户自己能做的下一步。
 */
function httpStatusText(status) {
  const s = Number(status) || 0;
  if (s === 401 || s === 403) return '没有权限（控制台令牌失效或被拒绝）—— 重启 QQ Agent 可恢复';
  if (s === 404) return '接口不存在 —— 软件文件可能不完整，更新或重新安装一次';
  if (s === 413) return '内容太大，后端拒绝接收';
  if (s === 429) return '请求太频繁，等几秒再试';
  if (s >= 500) return `后端内部错误（${s}）—— 详细原因见「工具 → 连接 → 应用日志」`;
  if (s >= 400) return `请求被拒绝（${s}）—— 参数可能不合法`;
  return `请求失败（HTTP ${s}）`;
}

async function api(path, options = {}) {
  // keepalive 由调用方按需传（配置保存的 POST 用它：页面卸载后请求仍能完成）
  // timeoutMs：请求级超时（AbortSignal.timeout）。用量页统计接口在历史数据多、
  // 后端忙时可能长时间无响应，没有超时兜底的话加载态会永远转下去。
  // 到点抛错让页面能显示失败原因 + 重试按钮。
  const { keepalive, timeoutMs, ...rest } = options;
  try {
    const res = await fetch(path, {
      headers: {
        'content-type': 'application/json',
        'x-console-token': CONSOLE_AUTH_TOKEN || CONSOLE_MARKER,
        ...(rest.headers || {})
      },
      ...rest,
      ...(keepalive ? { keepalive: true } : {}),
      ...(timeoutMs && !rest.signal ? { signal: AbortSignal.timeout(timeoutMs) } : {})
    });
    const data = await res.json().catch(() => ({}));
    // 后端没给 data.error 时不能直接抛 `HTTP 500`：用户既不知道是谁的问题，
    // 也不知道下一步干什么。状态码分档翻译成人话；后端给了 error 就以它为准
    // （src/error-l10n.js 已本地化）。
    if (!res.ok) throw new Error(data.error || httpStatusText(res.status));
    return data;
  } catch (e) {
    // 网络层失败单独计数。服务端 keep-alive 超时后 Chromium 若复用了那条
    // 半死 socket，fetch 会抛 TypeError: "Failed to fetch"（此时 curl 依然正常，
    // 是渲染端 socket 池的问题，不是服务端挂了）。连续失败说明池卡死了，
    // 触发一次自愈（重建 SSE + 必要时整页重载），否则用量页/会话列表会永远停
    // 在那张转圈的"加载中…"上，只能重启。
    if (e && e.name === 'TypeError' && /Failed to fetch|NetworkError|network/i.test(String(e.message))) {
      noteNetworkFailure();
      // 网络层失败单独转译。原样往上抛 "Failed to fetch"，用户看到的是一段英文，
      // 既不知道该重试还是该查端口，也没法转述给别人。
      // ⚠️ 这条路径同时覆盖「服务真没起（端口不通）」与上面那条
      //    「服务端活着、但渲染端 socket 池卡了（keep-alive 半死 socket）」，
      //    两者前端表现完全一样，所以文案里两种可能都写上，别只说一种。
      throw new Error('连不上控制台服务（网络层失败：服务可能没起、端口被占、被杀软拦截，或连接被重置）');
    }
    // AbortSignal.timeout 抛的是 TimeoutError DOMException，message 是英文，
    // 转成用户能看懂的中文（调用方的 catch 直接展示 e.message）
    if (e && e.name === 'TimeoutError') throw new Error(`请求超时（${Math.round((timeoutMs || 0) / 1000)} 秒无响应）`);
    throw e;
  }
}

function fmtTime(ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtClock(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ── 服务商展示标识 ──────────────────────────────────────────────────────
   列表项、页面摘要与三处破坏性确认框（删除服务商 / 清除 Key / 删除模型）
   都必须用同一串字来指认一个服务商，否则同名项在确认框里分不清。

   规则与 src/providers.js 的 providerDisplayLabel 完全一致：
     · 有名称 + 有端点 → `名称 · 端点`
     · 只有名称        → `名称`
     · 只有端点        → `端点`
     · 都没有          → id
   端点取 host（含端口），不是原始 Base URL——路径尾巴（/v1）对指认没有帮助。

   优先用后端在 GET /api/providers 里下发的 label；只有老缓存 / 局部对象
   （如 profile 里只存了 id + displayName）缺这个字段时才就地拼。

   ⚠️ 后端是同一规则的源实现，改这里必须同步改 src/providers.js。 */
function providerEndpointHost(p) {
  const raw = String((p && (p.baseURL || p.baseUrl)) || '').trim();
  if (!raw) return '';
  try { return new URL(raw).host || ''; } catch { return ''; }
}
function providerLabelOf(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.label === 'string' && p.label.trim()) return p.label;
  const name = String(p.displayName ?? '').trim();
  const host = providerEndpointHost(p);
  // 名称与端点相同（老数据名称就是域名）时不重复拼，见 src/providers.js 同处注释
  if (name && host && name !== host) return `${name} · ${host}`;
  if (name) return name;
  if (host) return host;
  return String(p.id ?? '');
}

/**
 * 服务商列表项的内层 HTML：主行名称 + 次行端点。
 *
 * 为什么分两行而不是拼成一个字符串：左列只有 200px 宽，`名称 · 127.0.0.1:11434`
 * 这类长串在窄屏下会折行或截断，两行结构更稳，也更容易扫读。
 * 名称与端点相同时（老数据名称就是域名）只出一行——两行重复内容没有信息量。
 *
 * @param {object}  p
 * @param {boolean} [current] 是否当前生效的服务商。标记放在**名称那行末尾**，
 *   而不是跟在整块 HTML 之后：后者会落到第二行下面自成一行，看起来像
 *   「（当前）」属于端点。调用方只需传这个布尔值，不必自己拼标记。
 */
function providerRowHtml(p, current = false) {
  const host = providerEndpointHost(p);
  const name = String((p && p.displayName) ?? '').trim();
  const main = name || host || String((p && p.id) ?? '');
  const showHost = host && host !== main;
  const badge = current ? '<span class="mm-prov-current">（当前）</span>' : '';
  return `<div class="mm-prov-name">${esc(main)}${badge}</div>${showHost ? `<div class="mm-prov-host">${esc(host)}</div>` : ''}`;
}

const STATUS_LABEL = { waiting: '等待中', done: '已发言', noreply: '未回复', running: '运行中', error: '出错', aborted: '中止' };

// ── 启动 loading 壳：页面先渲染，等服务可用后自动隐藏 ──
const loadingOverlay = $('#loading-overlay');
const loadingStatus = $('#loading-status');
const loadingLogs = $('#loading-logs');
let appReady = false;
let bootLogs = [];
// 失败卡片里的日志 <pre> 一旦渲染出来，就存引用；
// setLoadingStatus 在后台继续轮询期间同步更新它，卡片日志实时滚动而不是定格。
let failureLogEl = null;
// 页面加载时刻。bootLogs 每行带一个「距今多少秒」。
// 光看墙钟时间分不清"服务每 5 秒才动一下"和"5 秒超时 + 1 秒间隔的固定步长"，
// 带上偏移才能一眼看出是后者。
const bootT0 = Date.now();

function setLoadingStatus(text) {
  const off = ((Date.now() - bootT0) / 1000).toFixed(1);
  bootLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })} +${off}s] ${text}`);
  const tail = bootLogs.slice(-12).join('\n');
  if (loadingStatus) loadingStatus.textContent = text;
  if (loadingLogs) loadingLogs.textContent = tail;
  // 后台轮询期间，失败卡片里的日志也跟着滚，用户能实时看到"服务在动"。
  if (failureLogEl) failureLogEl.textContent = tail;
}

// 启动壳日志默认折叠：常显一堵等宽小字墙对新手不友好。
// 折成一行「查看详细日志」，点了才展开；展开态只活到本次启动
// （overlay 整个会被 remove，没有落盘的必要）。失败卡片（showBootFailure）里的
// 日志仍然常显，那时候用户就是来看日志找原因的。
const loadingLogsToggle = $('#loading-logs-toggle');
if (loadingLogsToggle && loadingLogs) {
  loadingLogsToggle.addEventListener('click', () => {
    const willShow = loadingLogs.hidden;
    loadingLogs.hidden = !willShow;
    loadingLogsToggle.textContent = willShow ? '收起详细日志' : '查看详细日志';
    loadingLogsToggle.setAttribute('aria-expanded', String(willShow));
  });
}

function hideLoading() {
  appReady = true;
  failureLogEl = null;   // 自愈后卡片已收起，断开日志引用
  if (loadingOverlay) {
    loadingOverlay.style.transition = 'opacity .25s ease';
    loadingOverlay.style.opacity = '0';
    setTimeout(() => { loadingOverlay?.remove(); }, 300);
  }
}

/** 探测「控制台服务（HTTP）本身活着吗」，不碰任何业务逻辑。
 *  /api/version 是零依赖的极简路由，拿它当"服务活着"的证据。
 *
 *  为什么需要：只探 /api/status 一个接口的话，
 *    · HTTP 没起（端口拒绝连接）→ 报"服务还没响应：请求超时"
 *    · HTTP 起了但 /api/status 慢（旧版本 / OneBot 未连）→ 也报同一句
 *  两类故障被当成一种，而它们的自救方法完全不同（前者查端口和杀软，
 *  后者只需再等一等）。失败时补这一下就能分开。
 *  ⚠️ 只在失败路径上跑，正常启动一次都不多请求。 */
async function pingConsole() {
  try {
    await api('/api/version', { signal: AbortSignal.timeout(2500) });
    return true;
  } catch { return false; }
}

// 最后一次探测到的"服务是否活着"，showBootFailure 用它决定给哪套文案
// （null = 一次都没探到，按最保守的说法处理）。
let lastConsoleAlive = null;

async function pollUntilReady(startedAt) {
  try {
    // ⚠️ 单次请求必须有超时：fetch 在网络栈层面"既不 resolve 也不 reject"时，
    //    await 会永久挂住，启动循环停在第一次调用上，界面永远显示最开始那句
    //    "正在启动 QQ Agent 服务…"。加了超时至少能继续下一轮。
    const status = await api('/api/status', { signal: AbortSignal.timeout(5000) });
    lastConsoleAlive = true;
    if (!status.onebot?.connected) setLoadingStatus(status.onebot?.diagnosis || '协议端已就绪，正在等机器人上线…');
    else setLoadingStatus(`机器人已上线${status.onebot.self ? `（${status.onebot.self.nickname}）` : ''}，即将进入控制台…`);
    // 服务已可达，无需等到 OneBot 完全连上即可进入控制台（体检卡会继续提示）
    return 'ok';
  } catch (e) {
    // startedAt 由 bootLoop 传入：曾经在这里声明，每轮重置，
    // 45 秒超时判定永远为 false，"启动超时"提示从未出现过
    const secs = Math.round((Date.now() - startedAt) / 1000);
    // e.message 已被 api() 转译过（超时 → 「请求超时（5 秒无响应）」、
    // 网络层 → 「连不上控制台服务（…）」），这里直接用，不再判 e.name。
    const why = e?.message || String(e);
    // 失败时补一次"服务到底活着没"，两类故障写进日志时分开说。
    const alive = await pingConsole();
    lastConsoleAlive = alive;
    setLoadingStatus(alive
      ? `服务在跑，但状态接口没回：${why}（已等待 ${secs} 秒）`
      : `连不上控制台服务：${why}（已等待 ${secs} 秒）`);
    // 45 秒只是"该给用户看卡片了"的门槛，不是"放弃"的门槛。
    // 超过 45 秒返回 'giveup'（让 bootLoop 渲染卡片），但仍然继续轮询：
    // 后端一旦能回（慢机器建完索引、OneBot 连上、或只是瞬时网络抖动恢复），
    // 下一轮 pollUntilReady 直接返回 'ok'，bootLoop 原地恢复，不再卡死等手动刷新。
    return Date.now() - startedAt > 45000 ? 'giveup' : 'fail';
  }
}

/** 启动失败兜底界面：不再无限转圈，给出原因、实时日志和自救按钮；且后台仍在轮询，
 *  后端一旦恢复会自动收起卡片继续走（见 bootLoop 的 giveup 分支）。
 *  本函数只负责"渲染一次卡片"，重复进入只更新日志文本、不重建 DOM。 */
function showBootFailure() {
  const card = document.querySelector('#loading-overlay .loading-card');
  appReady = false;   // 保持"未就绪"，主进程看门狗据此重载 / 弹窗提示
  if (!card) return;
  if (failureLogEl) return;  // 已经渲染过，bootLoop 之后每轮只更新日志文本，不重建 DOM

  card.innerHTML = '';
  const title = document.createElement('div');
  title.className = 'loading-title';
  title.textContent = '界面没能启动完成';
  const sub = document.createElement('div');
  sub.className = 'loading-sub';
  // 按"服务到底活着没"给两套不同的引导：死端口（ECONNREFUSED / 杀软拦截）
  // 和"端口在、业务没好"是两种完全不同的自救路径。
  sub.textContent = lastConsoleAlive === false
    ? '页面连不上控制台服务（HTTP 端口没起 / 被杀软拦截 / 端口被占）。后端多半没起来，看下面的日志找原因，或点「打开日志目录」排查。'
    : '控制台服务 45 秒内还没完全就绪。后端多半是正常在跑的，通常是页面这一侧没能连上它，或 OneBot 还在连 —— 后台仍在重试，连上会自动继续。';

  const pre = document.createElement('pre');
  pre.className = 'loading-logs';
  pre.textContent = (bootLogs || []).slice(-12).join('\n');
  failureLogEl = pre;

  const btnRow = document.createElement('div');
  btnRow.style.marginTop = '10px';
  btnRow.style.display = 'flex';
  btnRow.style.gap = '8px';
  btnRow.style.flexWrap = 'wrap';

  // ① 重新加载界面（带 6 秒冷却，防止手抖连点把刚起来的页面又刷掉）
  const btn = document.createElement('button');
  btn.className = 'btn btn-small';
  btn.id = 'boot-retry-btn';
  btn.textContent = '重新加载界面';
  let cooling = false;
  btn.addEventListener('click', () => {
    if (cooling) return;
    cooling = true;
    btn.disabled = true;
    let left = 6;
    btn.textContent = `重新加载界面（${left}s）`;
    const t = setInterval(() => {
      left -= 1;
      if (left <= 0) { clearInterval(t); location.reload(); }
      else btn.textContent = `重新加载界面（${left}s）`;
    }, 1000);
  });

  // ② 打开日志目录（需主进程桥 shell.openPath）
  const logBtn = document.createElement('button');
  logBtn.className = 'btn btn-small';
  logBtn.textContent = '打开日志目录';
  logBtn.addEventListener('click', () => {
    // 浏览器里打开控制台（无桌面壳）时没有 openLogDir 这个桥，点了没反应是正常的
    try { window.qqaDesktop?.openLogDir?.(); } catch (_) { /* 无桌面壳时忽略 */ }
  });

  // ③ 复制错误详情（纯前端，便于发群里/贴给开发者）
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn btn-small';
  copyBtn.textContent = '复制错误详情';
  copyBtn.addEventListener('click', async () => {
    const detail = `QQ Agent 启动失败（${new Date().toLocaleString('zh-CN')}）\n服务是否可达：${lastConsoleAlive}\n\n${(bootLogs || []).slice(-12).join('\n')}`;
    try {
      await navigator.clipboard.writeText(detail);
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => { copyBtn.textContent = '复制错误详情'; }, 1500);
    } catch (_) { copyBtn.textContent = '复制失败'; }
  });

  btnRow.append(btn, logBtn, copyBtn);
  card.append(title, sub, pre, btnRow);

  // 通知主进程把这次启动失败 + 尾部日志写进主进程日志，便于远程排查。
  try { window.qqaDesktop?.reportBootFailure?.({ logs: (bootLogs || []).slice(-12), alive: lastConsoleAlive }); } catch (_) { /* 上报失败不影响错误卡片展示 */ }
}

async function bootLoop() {
  const startedAt = Date.now();
  let shownFailure = false;
  // 45 秒后只"亮卡片"不"放弃"，后端一旦恢复即原地收起卡片继续走。
  // 看门狗的 60 秒重载作为兜底仍有效。
  // ⚠️ 上限是 24 分钟硬时间预算，不是轮数：旧实现按"每轮约 6 秒"估出"≈24 分钟"，
  //    但只有超时路径才这么慢。最常见的死端口（ECONNREFUSED）毫秒级失败，
  //    按 240 轮算约 4 分钟就穷尽退出，"后台仍在重试"的承诺恰恰在最需要它的
  //    场景最先失效。
  const BOOT_MAX_MS = 24 * 60_000;
  while (Date.now() - startedAt < BOOT_MAX_MS) {
    const result = await pollUntilReady(startedAt);
    if (result === 'ok') { hideLoading(); return; }
    if (result === 'giveup' && !shownFailure) { showBootFailure(); shownFailure = true; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // 真正穷尽（24 分钟仍连不上）：保留失败卡片，不再轮询，等用户手动操作（按钮/看门狗重载）。
}

// ── 就绪度体检（傻瓜式引导的核心） ──
// key 是这一项的稳定标识：页头体检卡、侧栏就绪小标等消费方按 key 取结论，
// 不要按数组下标或文案匹配（改顺序 / 改措辞就会静默错位）。
function assessReadiness(cfg, status) {
  const checks = [];
  if (!cfg) return { ready: false, checks: [{ key: 'config', ok: false, label: '配置加载失败' }] };
  // 拆成"接口地址"与"模型"两步：合并判断时新手分不清到底缺哪个。
  // 出厂 baseUrl 为空，第一条会直接指出该填什么。
  const urlOk = !!String(cfg.api.baseUrl || '').trim();
  checks.push({
    key: 'baseUrl',
    ok: urlOk,
    label: urlOk ? `接口地址：${cfg.api.baseUrl}` : '还没有填接口地址（Base URL，必填）：官方 API 或中转站提供的 OpenAI 兼容地址',
    fix: urlOk ? null : 'settings-api'
  });
  const modelOk = !!String(cfg.api.model || '').trim();
  checks.push({
    key: 'model',
    ok: modelOk,
    label: modelOk ? `模型已选择：${cfg.api.model}` : '还没有选择模型（填好地址后点「获取列表」或手动添加）',
    fix: modelOk ? null : 'settings-api'
  });
  const allowOk = (cfg.allow?.groups?.length || cfg.allow?.private?.length || cfg.allowAllWhenEmpty);
  checks.push({ key: 'allow', ok: !!allowOk, label: allowOk ? `白名单：${(cfg.allow.groups || []).length} 个群 / ${(cfg.allow.private || []).length} 个好友` : '还没有配置白名单（必填）', fix: allowOk ? null : 'settings-allow' });
  // status 在启动早期为空：state.status 初值是 null，而设置页可能在首次 /api/status
  // 返回前就被渲染（loadSettings → renderSettings → 页头体检）。归一化后按
  // "状态未知"表述，既不因 `status.onebot.diagnosis` 抛错，也不误报"机器人没连上"。
  const ob = status?.onebot || {};
  const obOk = ob.connected;
  checks.push({
    key: 'onebot',
    ok: !!obOk,
    label: obOk
      ? `机器人已上线${ob.self ? `（${ob.self.nickname}）` : ''}`
      : (status ? (ob.diagnosis || '机器人没连上 —— 请到「连接」页看看') : '正在读取机器人连接状态…'),
    fix: obOk ? null : 'connection-tab'
  });
  return { ready: !!(urlOk && modelOk && allowOk && obOk), checks };
}

/** 按 key 取就绪结论：返回 { [key]: ok }，供侧栏小标等消费方复用同一份口径。 */
function readinessByKey(cfg, status) {
  const out = {};
  for (const c of assessReadiness(cfg, status).checks) {
    if (c.key) out[c.key] = !!c.ok;
  }
  return out;
}

// 横幅内容签名。refreshStatus 每轮都会调到这里，无条件 `banner.innerHTML = html`
// 会连按钮和监听器一起重造，暂停中 / 一直未连接时横幅会周期性闪一下。
// 内容串不变就不动 DOM（按钮与监听器原地保留）。
let lastBannerHtml = null;
function renderBanner() {
  const banner = $('#banner');
  const s = state.status;
  let show = false;
  let html = '';
  if (state.paused) {
    show = true;
    html = '⏸ 机器人已暂停，不会处理任何消息。';
  } else if (state.statusStale) {
    // 后端持续无响应（01-boot.js 连续 3 次 /api/status 失败）时顶栏改了口径，
    // 但左栏身份卡还是旧数据，"曾经连上又掉线"也不会亮横幅，用户以为一切正常。
    // 这里补一条醒目横幅 + 一个"重新加载页面"的出路。
    show = true;
    html = '🛑 和控制台失去联系，界面显示的可能还是旧状态'
      + ' <button class="btn btn-small" id="banner-reload-btn">重新加载页面</button>';
  } else if (s && !s.onebot.connected && !s.onebot.everConnected) {
    show = true;
    // 带一个直达按钮，不让用户去找顶栏就绪圆点（hover 才知道能点）。
    // 与签名机制兼容：html 变了才重建，监听器在重建分支里补挂。
    // 按协议端端口是否在监听分两档：最常见的其实是机器人 QQ 没登录（协议端好着呢），
    // 其次是协议端压根没装，所以文案说"没在运行 / 没监听端口"而不是"没启动"。
    const protoUp = !!s.protocol?.portOpen;
    html = protoUp
      ? '🔌 机器人没连上 · 多半是机器人 QQ 还没登录 <button class="btn btn-small" id="banner-goto-connection-btn">去排查</button>'
      : '🔌 机器人没连上 · 协议端（SnowLuma / NapCat）没在运行 <button class="btn btn-small" id="banner-goto-connection-btn">去连接页</button>';
  }
  banner.classList.toggle('hidden', !show);
  if (show) {
    if (state.paused) {
      html += ` <button class="btn btn-small" id="banner-resume-btn">恢复</button>
        <button class="btn btn-small btn-danger" id="banner-resume-read-btn" title="恢复运行，并把暂停期间积压的所有未读消息直接标记为已读（不再处理）">恢复并全部标为已读</button>`;
    }
    // 内容没变就不重建（见 lastBannerHtml 的说明）
    if (html !== lastBannerHtml) {
      lastBannerHtml = html;
      banner.innerHTML = html;
      const resumeBtn = $('#banner-resume-btn');
      if (resumeBtn) resumeBtn.addEventListener('click', () => resumePause({ skipBacklog: false }));
      const resumeReadBtn = $('#banner-resume-read-btn');
      if (resumeReadBtn) resumeReadBtn.addEventListener('click', () => resumePause({ skipBacklog: true }));
      const gotoConnectionBtn = $('#banner-goto-connection-btn');
      if (gotoConnectionBtn) gotoConnectionBtn.addEventListener('click', () => switchTab('connection'));
    }
  } else {
    // 藏起来时把签名清空：下次重新显示一定会重建一次，不赌"隐藏期间 DOM 没被动过"。
    lastBannerHtml = null;
  }
}

async function resumePause({ skipBacklog = false } = {}) {
  try {
    if (skipBacklog) {
      await api('/api/pause', { method: 'DELETE', body: '{}' });
    } else {
      await api('/api/pause', { method: 'POST', body: JSON.stringify({ paused: false }) });
    }
    await refreshStatus();
    if (state.tab === 'chats') loadChats({ quiet: true });
  } catch (e) {
    // 只写 console 的话，用户点横幅上的「恢复」失败时界面毫无反应，看起来像按钮坏了。
    console.error('恢复失败:', e);
    try { qaAlert(`恢复运行失败：${e?.message || e}\n\n机器人仍处于暂停状态。请确认程序还在运行，然后再试一次。`); } catch { /* 弹窗不可用则只留控制台 */ }
  }
}

function switchTab(name) {
  // 离开设置页（无论去哪）前，先把防抖窗口内还没落盘的改动立即保存。
  // 必须在页签切换、任何 loadXxx 触发之前做：不 flush 的话这次改动要等
  // 600ms 定时器到点，期间用户看到的其它页签数据（用量/状态）就是旧配置算出来的。
  if (state.tab === 'settings' && name !== 'settings') flushSettingsSaves();
  // 人设预览浮层是挂在 body 下的全局单例（人设市场页 / 已安装人设页共用），
  // 不随页面容器一起隐藏，切页时必须主动关掉，否则它会一直盖在新页面上。
  if (typeof closePersonaPreview === 'function') {
    try { closePersonaPreview(); } catch { /* 浮层没开时是空操作 */ }
  }
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  // 可访问性：把「当前页」用 aria 明确标出来。只用 .active 这个纯视觉类表达
  // 选中态时，屏幕阅读器读到的是一排没有状态差异的按钮。
  // aria-current="page" 是 WAI-ARIA 对「当前页」的标准表达（aria-selected 是给
  // tablist 用的）。二级左栏的具体项由 syncChrome 负责（它才知道 name 归属哪个组）。
  $$('.tab').forEach((t) => {
    if (t.classList.contains('active')) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  // 切页挂起子动画：110ms 挂载窗口内 body 带 .switching，CSS 会把非活动视图
  // 的过渡全部关掉，避免旧页残留的悬停态 / 浮层过渡在切换瞬间闪一下。
  document.body.classList.add('switching');
  clearTimeout(document.body.__swTimer);
  document.body.__swTimer =
    setTimeout(() => document.body.classList.remove('switching'), 110);
  $$('.view').forEach((v) => {
    const on = v.id === `view-${name}`;
    v.classList.toggle('active', on);
    if (on) {
      /* 重触发入场动画：CSS 动画只在类名"重新加上"时播放，
         先移除再强制 reflow 后加回，切换页签才有平滑入场。 */
      v.style.animation = 'none';
      void v.offsetWidth;   // reflow
      v.style.animation = '';
    }
  });
  state.tab = name;
  if (state.quoteMode && name !== 'chats') exitQuoteMode();   // 离开存档页自动退出金句勾选
  if (name === 'sessions') loadSessions();
  // 壁纸页（内置模块 src/wallpaper 前端）：每次进入都重新拉列表，插件热重载换了壁纸能立刻看到。
  // 用 typeof 守卫，14-wallpaper.js 若没装（纯核心部署），这里不能抛错。
  if (name === 'wallpaper' && typeof loadWallpaperPage === 'function') loadWallpaperPage();
  // 桌宠页（desktop-pet 插件）：进入才启动 4s 轮询与预览 URL 管理，离开立即停止并回收
  // ObjectURL，轮询跑在别的页面上会白耗电，预览不回收会漏内存。
  // typeof 守卫与壁纸页同口径：没装插件时这里不能抛错。
  if (name === 'desktop-pet' && typeof loadDesktopPetPage === 'function') loadDesktopPetPage();
  else if (typeof stopDesktopPetPage === 'function') stopDesktopPetPage();
  if (name === 'chats') loadChats();
  // 群名补底：设置页（人设分群按钮/活跃设置分群下拉）用 chatNameOf 取名字，
  // 依赖 state.chats，若用户没先进过存档页这里是空的，会只显示群号。
  // 进设置页时悄悄拉一次（quiet，失败不报错），列表已在就跳过。
  if (name === 'settings' && !(state.chats || []).length) {
    api('/api/chats').then((d) => { state.chats = d.chats || []; }).catch(() => {});
  }
  if (name === 'memory') loadMemoryView();
  if (name === 'usage') loadUsageView({ force: true });
  if (name === 'skills') loadModulePage('skill');
  if (name === 'plugins') loadModulePage('plugin');
  // 已安装的人设页（左栏「下载 → 已安装 → 人设」）
  if (name === 'personas') loadPersonasPage();
  if (name === 'harness') loadHarnessPage();
  if (name === 'connection') loadConnectionPage();
  if (name === 'settings') {
    // loadSettings 首行 await api('/api/config') 失败即 reject，不 catch 会留下
    // 未处理的拒绝，设置页保持空白或旧内容且没有重试入口（表现为"点了设置没反应"）。
    // 这里兜底成一张带「重试」的错误卡。
    loadSettings().catch((e) => {
      const box = document.getElementById('settings-form');
      if (!box) return;
      box.innerHTML = `<div class="empty-hint">设置加载失败：${esc(e?.message || e)}<br><br>`
        + '<button class="btn btn-small" id="settings-retry-btn" type="button">重试</button></div>';
      const btn = box.querySelector('#settings-retry-btn');
      if (btn) btn.addEventListener('click', () => switchTab('settings'));
    });
  }
}

// ── 自定义下拉框（美化原生 <select>）──
// 原生 select 的弹出列表是操作系统渲染的，改不了样式、也没法做过渡动画。
// 这里把每个 <select> 换成自绘的 .sel 组件（隐藏原 select 但保留在 DOM，
// val()/chk() 与 change 监听全部照常工作，getElementById 绑定零改动）。
// 由 MutationObserver 自动接管所有后渲染出来的 select（设置页/弹窗/连接页）。
function enhanceOneSelect(sel) {
  if (sel.dataset.selEnhanced) return;
  sel.dataset.selEnhanced = '1';
  sel.style.display = 'none';

  const wrap = document.createElement('span');
  wrap.className = 'sel' + (sel.disabled ? ' sel-disabled' : '');
  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'sel-head';
  const CHEV = '<svg class="sel-arrow" viewBox="0 0 12 12" aria-hidden="true"><path class="ln" d="M2.5 4.5 6 8l3.5-3.5"/></svg>';
  head.innerHTML = '<span class="sel-label"></span>' + CHEV;
  const menu = document.createElement('span');
  menu.className = 'sel-menu';
  wrap.appendChild(head);
  sel.after(wrap);
  // ⚠️ 菜单 portal 到 body：脱离 .sel 祖先的 backdrop-filter / overflow / transform
  //    子树，软件渲染下下拉动画不再拖累毛玻璃层逐帧重光栅（这是卡顿的根因）。
  document.body.appendChild(menu);
  // portal 菜单与触发器互相关联：页面重绘（innerHTML）销毁 wrap 时，
  // 由全局 MutationObserver 的 removedNodes 分支据此回收 body 上的菜单，
  // 否则每次重绘都泄漏一棵含全部 option 的子树。
  wrap._selMenu = menu;
  menu._selWrap = wrap;

  const label = () => (sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '');
  const syncHead = () => { head.firstElementChild.textContent = label(); };
  // 缓存菜单渲染快照：打开时先比较 options，内容没变就不重建 innerHTML。
  // 每次点击都重建整个选项列表（有些下拉有上百项），随后又立刻读几何信息触发
  // 布局，弹出瞬间主线程忙着重建 DOM，动画第一帧就掉了。
  let menuSnapshot = [];
  let menuSelectedIndex = -1;
  const syncMenu = () => {
    const options = sel.options;
    let changed = menuSelectedIndex !== sel.selectedIndex || menuSnapshot.length !== options.length;
    if (!changed) {
      for (let i = 0; i < options.length; i++) {
        const o = options[i], prev = menuSnapshot[i];
        if (o.value !== prev.value || o.text !== prev.text || o.disabled !== prev.disabled) { changed = true; break; }
      }
    }
    if (!changed) return;
    menu.innerHTML = [...options].map((o, i) =>
      '<span class="sel-opt' + (i === sel.selectedIndex ? ' selected' : '') + '" data-i="' + i + '">' + esc(o.text) + '</span>'
    ).join('');
    menuSnapshot = Array.from(options, (o) => ({ value: o.value, text: o.text, disabled: o.disabled }));
    menuSelectedIndex = sel.selectedIndex;
  };
  syncHead(); syncMenu();

  const close = () => {
    wrap.classList.remove('open');
    menu.classList.remove('open');
    // ⚠️ 菜单已 portal 到 body 且用 position:fixed 定位。收起动画期间若把
    //    position/left/width/top/bottom/zIndex 清回 CSS 的 absolute，菜单会瞬间
    //    跳到视口左上角（body 是 absolute 的包含块），造成肉眼可见的"收回跳帧"。
    //    故只清 maxHeight（避免下次展开用到陈旧限高把菜单裁短）；其余内联定位
    //    全部保留，下次展开会整体重写，隐藏态留着也无害（fixed 脱离文档流）。
    menu.style.maxHeight = '';
  };
  wrap._selClose = close;   // 供全局的滚动/点外收起逻辑复位
  // 键盘可达性：原生 select 被 display:none 之后，键盘用户 Tab 到触发条、Enter 展开，
  // 方向键毫无反应，等于无法更改任何下拉选项。这里在触发条上补方向键/Home/End
  // 直接改选中项（与原生 select 行为对齐），Enter/Space 仍由 button 的默认行为展开菜单。
  head.addEventListener('keydown', (e) => {
    if (sel.disabled) return;
    const n = sel.options.length;
    if (!n) return;
    const i = sel.selectedIndex;
    let next = null;
    if (e.key === 'ArrowDown') next = Math.min(n - 1, i + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, i - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    if (next === null) return;
    e.preventDefault();
    if (next !== i) {
      sel.selectedIndex = next;
      syncHead(); syncMenu();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  head.addEventListener('click', () => {
    if (sel.disabled) return;
    // 展开前重同步：options 可能被代码重建过（如搜索服务商下拉动态填充）
    syncMenu(); syncHead();
    // 先关掉别的开着的下拉，避免菜单叠菜单（走各自的 close 以清干净内联定位）
    document.querySelectorAll('.sel.open').forEach((w) => {
      if (w === wrap) return;
      if (typeof w._selClose === 'function') w._selClose();
      else w.classList.remove('open');
    });
    // ⚠️ 不能直接用 classList.toggle('open')：那会绕过 close()，展开期写下的内联
    //    定位（position/left/width/zIndex…）残留下来，下次展开会用到陈旧坐标。
    if (wrap.classList.contains('open')) {
      close();          // 再点一次 = 收起（并复位内联样式）
      return;
    }
    // 先完成测量与定位，最后才加 .open：这样浏览器首次绘制菜单时就已处于最终位置，
    // 避免菜单先按旧坐标开始动画、紧接着被 fixed/宽度/top 等样式改写造成跳帧。
    {
      // 视口自适应：空间不够就上弹或限高，保证菜单完整落在可视区内。
      //
      // ⚠️ 菜单必须用 position:fixed。它原本是 .sel 的子节点（absolute 定位），
      //    在模态框里会失效：模态框的 .model-modal-body 带 overflow:auto，
      //    菜单一旦超出就被裁掉并随 body 滚动，实测贴近底部展开时高度 112px、
      //    可见 0px，选项完全点不到。限高治不了根，根因是"裁剪容器"而非"空间不足"；
      //    fixed 的包含块是视口，不受任何祖先 overflow 影响。
      //    用 head 的视口坐标手动定位（top/left/width），上弹/限高逻辑照旧。
      // close() 已在收起时复位所有内联坐标，这里不重复清空。
      const hr = head.getBoundingClientRect();
      menu.style.position = 'fixed';
      // ⚠️ 横向刻意不取整：hr.left/width 常为小数（如 210.4px），round 后菜单
      //    会比触发按钮窄最多 0.5px、左缘偏移，人眼对竖边对齐敏感。
      //    交浏览器做亚像素定位。top/bottom 仍取整。
      menu.style.left = hr.left + 'px';
      menu.style.width = hr.width + 'px';
      menu.style.right = 'auto';
      // ⚠️ 层号不要写死数字，读 style.css 里的层号令牌。写死 260 时它比
      //    .model-modal-overlay 的 900/910 还低，凡是开在 modal 里的 <select>，
      //    展开的菜单整块被压在遮罩底下。读变量后与 .sel-menu 的 CSS 兜底同源，
      //    不会因某一侧漏改而走偏。取值 920：高于 900/910（要在 modal 里展开），
      //    低于 .loading-overlay(999)（首启加载遮罩必须压住一切可交互元素）。
      //    getComputedStyle 只在展开时读一次，开销可忽略；读不到时兜底 920。
      menu.style.zIndex =
        getComputedStyle(document.documentElement).getPropertyValue('--z-sel-menu').trim() || '920';
      // 视口自适应：菜单已 fixed 在 body，不受任何祖先 overflow 裁剪，
      // 直接以视口为安全边界（这块原本要区分 absolute/fixed 两套边界，现已统一）。
      const MARGIN = 8;
      const lo = MARGIN, hi = window.innerHeight - MARGIN;
      const below = hi - hr.bottom;
      const above = hr.top - lo;
      const NEED = 132;   // 约四行选项，低于这个数就换边/限高
      if (below < NEED && above > below) {
        // 上弹：菜单底边贴在 head 顶边上方 5px（fixed 相对视口底边 = 窗口高度）
        menu.style.top = 'auto';
        menu.style.bottom = Math.round(window.innerHeight - hr.top + 5) + 'px';
        menu.style.maxHeight = Math.min(288, Math.round(above)) + 'px';
      } else {
        // 下弹
        menu.style.top = Math.round(hr.bottom + 5) + 'px';
        menu.style.bottom = 'auto';
        if (below < 288) menu.style.maxHeight = Math.max(NEED, Math.round(below)) + 'px';
      }
      const cur = menu.querySelector('.sel-opt.selected');
      if (cur) menu.scrollTop = Math.max(0, cur.offsetTop - menu.clientHeight / 2 + cur.offsetHeight / 2);
      // 所有同步布局操作结束后才切状态：菜单加 .open（触发位移入场），
      // 触发条加 .open（箭头旋转）。两 class 分开管，因菜单已不在 .sel 内，
      // 旧的 ".sel.open .sel-menu" 后代选择器不再命中。
      menu.classList.add('open');
      wrap.classList.add('open');
    }
  });
  menu.addEventListener('click', (e) => {
    const opt = e.target.closest('.sel-opt');
    if (!opt || sel.disabled) return;
    const i = Number(opt.dataset.i);
    if (i !== sel.selectedIndex) {
      sel.selectedIndex = i;
      syncHead(); syncMenu();
      // 派发 change：所有既有监听（保存/联动）原样触发
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close();
  });
  // 代码改 value 后手动 dispatch 的 change 也同步显示
  sel.addEventListener('change', () => { syncHead(); syncMenu(); });
  // 点外面 / Esc 收起（全局监听只挂一次）
  if (!window.__selOutsideBound) {
    window.__selOutsideBound = true;
    // 统一收起：优先走各 wrap 自己的 close（会清掉展开期的内联定位样式），
    // 拿不到就退回只删 class。
    const closeAll = () => {
      document.querySelectorAll('.sel.open').forEach((w) => {
        if (typeof w._selClose === 'function') w._selClose();
        else w.classList.remove('open');
      });
      // 孤儿菜单兜底：wrap 已随页面重绘销毁、portal 菜单还挂在 body 上
      // （带 .open + 内联 fixed + pointer-events:auto，上面那轮遍历够不到它）。
      document.querySelectorAll('.sel-menu.open').forEach((m) => {
        if (!m._selWrap || !m._selWrap.isConnected) m.remove();
      });
    };
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.sel')) closeAll();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll();
    });
    // ⚠️ 展开态是 position:fixed，不随页面滚动。任何滚动/窗口尺寸变化都会让
    //    菜单与它的 head 脱位，直接收起比错位更稳。
    //    capture=true：滚动事件不冒泡，必须用捕获阶段才能收到任意滚动容器的滚动。
    const closeAllOnMove = () => closeAll();
    window.addEventListener('resize', closeAllOnMove);
    document.addEventListener('scroll', (e) => {
      // 只处理真正滚动的容器；.sel-menu 自己在菜单内滚动时不该收起
      if (e.target && e.target.closest && e.target.closest('.sel-menu')) return;
      closeAll();
    }, true);
  }
}

let selObserverStarted = false;
function startSelectEnhancer() {
  if (selObserverStarted) return;
  selObserverStarted = true;
  const scan = (root) => {
    if (root instanceof HTMLSelectElement) enhanceOneSelect(root);
    if (root.querySelectorAll) root.querySelectorAll('select').forEach(enhanceOneSelect);
  };
  scan(document);
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => { if (n.nodeType === 1) scan(n); });
      // wrap 随页面重绘被移出 DOM 时回收其 portal 菜单。延迟到下一轮任务再判定
      // isConnected：若是「搬迁」（先 remove 再 insert 同一节点），届时节点已重新
      // 入树，不误杀；真正的销毁则 isConnected 仍为 false。
      if (m.removedNodes.length) {
        setTimeout(() => {
          m.removedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            const deadWraps = [];
            if (n.classList?.contains('sel') && n._selMenu) deadWraps.push(n);
            if (n.querySelectorAll) n.querySelectorAll('.sel').forEach((w) => { if (w._selMenu) deadWraps.push(w); });
            deadWraps.forEach((w) => { if (!w.isConnected) w._selMenu.remove(); });
          });
        }, 0);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

/* ── 输入框"点了却不聚焦"的自愈兜底 + 取证埋点 ──────────────────────────
   症状：点到文本框里，光标不出现、敲键盘没反应，只有输入框这样（按钮一切
   正常），且"有的时候又能恢复"。

   可能成因有五六个（DOM 重建夺焦 / 祖先 user-select:none / Electron 拖拽区
   吞事件 / 窗口失焦回流 / 输入法组字被拆），拿到现场数据前逐个猜没有意义。
   这里做两件确定有益的事：
     ① 兜底：一次指针按下结束后，若目标本该聚焦却没聚焦，替浏览器补一次
        focus()。这本来就是浏览器该做的，补上不会引入新语义；
     ② 取证：每次兜底命中都用 console.error 打一条结构化诊断
        （level 3 = error → 主进程的 console-message 监听会落盘，
         打包版也能在 data/logs 里拿到），记下当时谁抢了焦点、谁是命中目标。

   刻意收缩作用域：只处理 INPUT/TEXTAREA/SELECT/contenteditable，且排除
   disabled。点了按钮、点了普通区域一律不干预。 */
(function initInputFocusGuard() {
  if (window.__inputFocusGuardBound) return;
  window.__inputFocusGuardBound = true;

  const EDITABLE = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
  let pending = null;
  let lastX = 0, lastY = 0;

  const describe = (el) => {
    if (!el) return 'null';
    const cls = String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.');
    const boxId = el.closest?.('.model-modal') ? `[modal:${el.closest('.model-modal').getAttribute('aria-label') || '?'}]` : '';
    return `${el.tagName}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}${boxId}`;
  };
  const focusable = (el) =>
    !!el && el.isConnected && !el.disabled &&
    el.getAttribute('readonly') == null && el.tabIndex !== -1 &&
    (!el.offsetParent || el.getClientRects().length > 0);

  document.addEventListener('pointerdown', (e) => {
    const el = e.target?.closest?.(EDITABLE) || null;
    pending = focusable(el) ? el : null;
    lastX = e.clientX; lastY = e.clientY;
  }, true);

  const check = () => {
    const el = pending;
    pending = null;
    if (!el || !el.isConnected) return;
    if (document.activeElement === el) return;   // 正常聚焦，不打扰
    // 拖选/拖动插件 focus（如 marked）等中间态允许晚一拍；再给一拍机会
    requestAnimationFrame(() => {
      if (document.activeElement === el) return;
      const activeBefore = document.activeElement;
      const hit = document.elementFromPoint(lastX, lastY);
      console.error(
        `[焦点自愈] 目标=${describe(el)} 点击坐标=(${lastX},${lastY}) ` +
        `命中元素=${describe(hit)} 抢到焦点的是=${describe(activeBefore)} ` +
        `hasFocus=${document.hasFocus()} body.class="${document.body.className}" ` +
        `祖先userSelect=${(() => { let s = '', n = el; while (n && n !== document.body) { const v = getComputedStyle(n).webkitUserSelect || getComputedStyle(n).userSelect; if (v === 'none') { s += describe(n) + ' '; } n = n.parentElement; } return s || 'clean'; })()}`
      );
      try { el.focus({ preventScroll: true }); } catch { /* 兜底失败不影响用户 */ }
    });
  };

  document.addEventListener('pointerup', () => setTimeout(check, 0), true);
})();

/**
 * 跳到「设置 → 媒体工具」并滚到 ffmpeg 那一段。
 *
 * 统一入口的原因：这处跳转会被多个地方调用（壁纸导入、视频抽帧、大图压缩的
 * 降级提示）。各页各写一遍"切 tab + 设分区 + 等一拍再滚"，迟早出现某处漏了
 * flushSettingsSaves 或节拍不对，表现成"点了没反应"。
 *
 * 与 wpBackToSettings 的区别：那个去「外观与数据」，这里去「media」分区。
 *
 * @param {{ note?: string }} [opts] note 会短暂高亮在状态条上，用来说明"为什么要装"
 */
function gotoFfmpegSettings(opts = {}) {
  try { state.settingsSection = 'media'; } catch { /* state 未就绪 */ }
  if (typeof flushSettingsSaves === 'function') { try { flushSettingsSaves(); } catch { /* ignore */ } }
  switchTab('settings');
  // 设置页是异步渲染的：等一拍再滚动。找不到锚点就停在页面顶部，不算失败。
  setTimeout(() => {
    const anchor = document.getElementById('settings-media');
    if (!anchor) return;
    anchor.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const note = String(opts && opts.note ? opts.note : '').trim();
    if (note) {
      const status = document.getElementById('ffmpeg-status-text');
      if (status) {
        const prev = status.innerHTML;
        status.innerHTML = `<b style="color:var(--orange)">${esc(note)}</b>`;
        setTimeout(() => { if (status.innerHTML.includes(esc(note))) status.innerHTML = prev; }, 6000);
      }
    }
  }, 160);
}
window.gotoFfmpegSettings = gotoFfmpegSettings;

// 〔人设市场：浏览 / 预览 / 试用 / 应用〕——r113 新增
// ---------------------------------------------------------------------------
// 为什么单独一个文件，不塞进 16-market.js：
//   16-market.js 的每一处逻辑都假定"东西是**代码**"—— 有 installCode、下载
//   zip、装进 skills/ 或 plugins/、装完 reloadSkills。人设一样都不是：它是
//   一段文本，取回来落进 config.customPersonas，装完还要人自己切过去才生效。
//   硬塞进去会让 loadMarket / installFromMarket 全长出 if (kind==='persona')
//   分支 —— 那是对现有稳定代码的侵入式改写，且改坏了要回滚的面积很大。
//   独立成文件 = 零改动风险，删掉这个文件市场也只是少一个入口。
//
// 数据来源：后端 GET /api/market → 实为 /api/persona-market/list
//   （src/routes.js），由 src/market.js 的 listPersonaItems 代理官网 /personas。
//   ⚠️ 列表**不含 prompt 正文**（官网整包 3.7MB / 70 万字，见 market.js 注释），
//   所以「预览」「试用」「应用」三个动作都要按 id 单取一次正文。
//
// 三段式动作（对应 UI 上卡片右侧三颗钮）：
//   预览 = 看正文前若干行，不落任何配置
//   试用 = 落库并**立刻切成当前人设**（改 persona.roleText），不满意可一键还原
//   应用 = 只落库，不动当前人设（存着以后用）
//   ⚠️ 试用会改当前人设，所以必须给"还原"留退路 —— 见 personaTryBackup。

'use strict';

/* ══════════════════════════════════════════════════════════════
   状态
   ══════════════════════════════════════════════════════════════ */
const personaState = {
  all: [],
  categories: {},
  q: '',
  cat: 'all',
  sort: 'updated',
  loaded: false,
  loading: false,
  error: ''
};

const PERSONA_SORTS = [
  { key: 'updated', label: '最近更新' },
  { key: 'title', label: '名称排序' },
  { key: 'length', label: '提示词长度' }
];

/* 试用前的备份：{ id, title, roleText } —— 还原按钮靠它回滚。 */
let personaTryBackup = null;
/* 正文缓存：id → prompt 字符串。同一张卡反复点预览/应用不必每次回后端。 */
const personaPromptCache = new Map();
/* 打开预览的那颗「预览」按钮 —— 关掉浮层后把焦点还回去。
   模态里焦点凭空消失是很常见的可访问性毛病（键盘用户会瞬间失去位置）。 */
let personaPreviewBtn = null;
/* 预览正文上限：原来是 1200 字（内联小面板，再多会撑爆列表）。
   现在改成 760px 宽的模态、正文框内滚动，可以多给一些；仍留上限是为了
   极端长卡（几万字）不至于一次性塞进 DOM 造成卡顿。 */
const PERSONA_PREVIEW_CHARS = 4000;

/* ══════════════════════════════════════════════════════════════
   工具
   ══════════════════════════════════════════════════════════════ */
/** 千字缩写：8870 → "8.9k 字"。 */
function personaFmtLen(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 1000) return `${v} 字`;
  return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k 字`;
}

/** 相对时间：与 16-market.js 的 marketRelTime 同款口径（本地实现，不跨文件依赖）。 */
function personaRelTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 0) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 取彩色块首字符（沿用 16-market.js 的取字口径，跳过标点）。 */
function personaInitialOf(title, id) {
  const s = String(title || id || '?').trim();
  const m = s.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : '?';
}

/** 稳定色相：与 16-market.js 的 marketHueOf 同一套哈希（FNV-1a 变体）。 */
function personaHueOf(str) {
  let h = 2166136261;
  const s = String(str || '?');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/**
 * 本机是否已经应用过这个人设。
 * 判据是 config.customPersonas 里的 sourceId（市场安装时写入）——
 *   不能按 name 比：社区里同名不同 id 的人设很多（实测 123 条里 5 组重名），
 *   按名字判会把两个不同的人设认成同一个。
 */
function personaAppliedIds() {
  const set = new Set();
  try {
    const list = (typeof state !== 'undefined' && state.config && state.config.customPersonas) || [];
    for (const p of list) {
      if (p && p.sourceId) set.add(p.sourceId);
    }
  } catch { /* state 未就绪 → 当作没应用过，不影响浏览 */ }
  return set;
}

/* ══════════════════════════════════════════════════════════════
   筛选 / 排序
   ══════════════════════════════════════════════════════════════ */
function personaVisible() {
  const st = personaState;
  const q = (st.q || '').trim().toLowerCase();
  let list = st.all.filter((x) => {
    if (st.cat !== 'all' && x.category !== st.cat) return false;
    if (q) {
      const hay = `${x.title || ''} ${x.description || ''} ${x.id || ''} ${x.author || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const by = st.sort;
  list = list.slice().sort((a, b) => {
    if (by === 'title') return String(a.title || a.id).localeCompare(String(b.title || b.id), 'zh');
    if (by === 'length') return (Number(b.promptLength) || 0) - (Number(a.promptLength) || 0);
    // updated（默认）：最近更新优先，同刻再按标题
    const d = (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    return d !== 0 ? d : String(a.title || a.id).localeCompare(String(b.title || b.id), 'zh');
  });
  return list;
}

function personaCatCounts() {
  const st = personaState;
  const out = { all: 0 };
  for (const x of st.all) {
    out.all += 1;
    const c = x.category || 'custom';
    out[c] = (out[c] || 0) + 1;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
   渲染
   ══════════════════════════════════════════════════════════════ */
function renderPersonaShell() {
  const box = document.querySelector('#personamarket-page');
  if (!box) return;
  const st = personaState;
  const counts = personaCatCounts();
  const catEntries = Object.entries(st.categories || {});

  box.innerHTML = `
    <div class="mk-head">
      <div class="mk-title">
        <h2>人设市场</h2>
        <span class="mk-sub" id="pm-sub">${st.loaded ? `共 ${counts.all} 个人设` : '正在连接市场…'}</span>
      </div>
      <div class="mk-head-actions">
        ${personaTryBackup
          ? '<button class="mk-refresh pm-undo" type="button" id="pm-undo" title="把当前人设换回试用前的那一张">↩ 还原试用</button>'
          : ''}
        <button class="mk-refresh" type="button" data-pm-refresh title="重新拉取人设列表">↻ 刷新</button>
      </div>
    </div>

    <div class="pm-hint">
      装上即换性格，<b>不改能力</b>。技能和插件照旧，人设只决定它怎么说话。
    </div>

    <div class="mk-toolbar">
      <div class="mk-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/></svg>
        <input type="text" id="pm-q" placeholder="搜索人设名称、简介、作者…" autocomplete="off" spellcheck="false" value="${esc(st.q)}" />
        <button class="mk-q-clear" type="button" data-pm-qclear title="清空" ${st.q ? '' : 'hidden'}>×</button>
      </div>
      <div class="mk-filter-panel">
        <div class="mk-filters">
          <label class="mk-fld mk-cat-field"><span>分类</span>
            <select class="mk-select" data-pm-cat aria-label="按分类筛选">
              <option value="all" ${st.cat === 'all' ? 'selected' : ''}>全部（${counts.all}）</option>
              ${catEntries.map(([k, v]) => `<option value="${esc(k)}" ${st.cat === k ? 'selected' : ''}>${esc(v)}（${counts[k] || 0}）</option>`).join('')}
            </select>
          </label>
          <label class="mk-fld"><span>排序</span>
            <select class="mk-select" data-pm-sort aria-label="排序方式">
              ${PERSONA_SORTS.map((s) => `<option value="${s.key}" ${st.sort === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
            </select>
          </label>
        </div>
      </div>
    </div>

    <div class="mk-body">
      <div class="mk-list" id="pm-list"></div>
    </div>`;

  renderPersonaList();
  bindPersonaShell();
}

function renderPersonaList() {
  const box = document.querySelector('#pm-list');
  if (!box) return;
  const st = personaState;

  if (st.loading && !st.all.length) {
    box.innerHTML = '<div class="mk-empty"><span class="mk-spin"></span>正在加载人设…</div>';
    return;
  }
  if (st.error && !st.all.length) {
    box.innerHTML = `<div class="mk-empty mk-err">人设市场连接失败：${esc(st.error)}<br><button class="btn" type="button" data-pm-refresh>重试</button></div>`;
    bindPersonaList();
    return;
  }
  const list = personaVisible();
  if (!list.length) {
    box.innerHTML = st.all.length
      ? '<div class="mk-empty">没有匹配的人设，换个关键词或分类试试。</div>'
      : '<div class="mk-empty">人设市场里还没有上架的条目。</div>';
    return;
  }

  const applied = personaAppliedIds();

  box.innerHTML = list.map((x) => {
    const isApplied = applied.has(x.id);
    const hue = personaHueOf(x.id || x.title);
    const desc = String(x.description || '暂无简介').replace(/\s+/g, ' ').trim();
    const cat = x.categoryName || personaState.categories[x.category] || '其他';
    return `
      <article class="mk-card pm-card${isApplied ? ' mk-installed' : ''}" data-pm-card="${esc(x.id)}">
        <span class="mk-tile" style="--mk-h:${hue}" aria-hidden="true">${esc(personaInitialOf(x.title, x.id))}</span>
        <div class="mk-info">
          <div class="mk-row1">
            <span class="mk-name">${esc(x.title || x.id)}</span>
            <span class="mk-badge">${esc(cat)}</span>
            ${isApplied ? '<span class="mk-badge mk-ok">已应用</span>' : ''}
          </div>
          <div class="mk-desc" title="${esc(desc)}">${esc(desc)}</div>
          <div class="mk-meta">
            <span title="提示词长度">≡ ${esc(personaFmtLen(x.promptLength))}</span>
            <span title="最近更新">↻ ${esc(personaRelTime(x.updatedAt) || '—')}</span>
            <span title="作者">@${esc(x.author || '未署名')}</span>
          </div>
        </div>
        <div class="mk-action pm-action">
          <button class="mk-btn pm-btn-preview" type="button" data-pm-preview="${esc(x.id)}">预览</button>
          <button class="mk-btn mk-btn-manage" type="button" data-pm-try="${esc(x.id)}" title="立刻换成这个人设聊几句，不满意可点左上角还原">试用</button>
          <button class="mk-btn mk-btn-install" type="button" data-pm-apply="${esc(x.id)}" title="存进人设库，不改变当前正在用的">应用</button>
        </div>
      </article>`;
  }).join('');

  bindPersonaList();
}

/* ══════════════════════════════════════════════════════════════
   交互绑定
   ══════════════════════════════════════════════════════════════ */
function bindPersonaShell() {
  const root = document.querySelector('#personamarket-page');
  if (!root || root.dataset.pmBound === '1') return;
  root.dataset.pmBound = '1';

  root.addEventListener('click', (e) => {
    if (e.target.closest?.('#pm-undo')) { personaUndoTry(); return; }
    if (e.target.closest?.('[data-pm-refresh]')) { loadPersonaMarket({ force: true }); return; }
    const clr = e.target.closest?.('[data-pm-qclear]');
    if (clr) {
      personaState.q = '';
      const inp = root.querySelector('#pm-q');
      if (inp) inp.value = '';
      clr.hidden = true;
      renderPersonaList();
      return;
    }
    // 预览浮层的 × / 遮罩 / 底部动作都由浮层自己的点击委托处理（它挂在 body 下，
    // 不在本页容器里，这里收不到 —— 别再重复绑一遍）。
  });

  root.addEventListener('change', (e) => {
    if (e.target?.matches?.('[data-pm-cat]')) {
      personaState.cat = e.target.value || 'all';
      renderPersonaList();
      return;
    }
    if (e.target?.matches?.('[data-pm-sort]')) {
      personaState.sort = e.target.value || 'updated';
      renderPersonaList();
    }
  });

  root.addEventListener('input', (e) => {
    if (e.target?.id !== 'pm-q') return;
    personaState.q = e.target.value;
    const clr = root.querySelector('[data-pm-qclear]');
    if (clr) clr.hidden = !e.target.value;
    renderPersonaList();
  });
}

function bindPersonaList() {
  const box = document.querySelector('#pm-list');
  if (!box || box.dataset.pmBound === '1') return;
  box.dataset.pmBound = '1';
  box.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-pm-refresh]')) { loadPersonaMarket({ force: true }); return; }
    const pv = e.target.closest?.('[data-pm-preview]');
    if (pv) { personaPreview(pv.dataset.pmPreview, pv); return; }
    const tr = e.target.closest?.('[data-pm-try]');
    if (tr) { personaApply(tr.dataset.pmTry, { applyNow: true }, tr); return; }
    const ap = e.target.closest?.('[data-pm-apply]');
    if (ap) { personaApply(ap.dataset.pmApply, { applyNow: false }, ap); }
  });
}

/* ══════════════════════════════════════════════════════════════
   加载
   ══════════════════════════════════════════════════════════════ */
async function loadPersonaMarket({ force = false } = {}) {
  const st = personaState;
  if (st.loading) return;
  if (st.loaded && !force) { renderPersonaShell(); return; }
  st.loading = true;
  st.error = '';
  renderPersonaShell();
  try {
    // 115s：与后端 marketFetch 的 90s 预算对齐（2026-10-20，详见 16-market.js 同处注释）
    const r = await api('/api/persona-market/list', { timeoutMs: 115000 });
    st.all = Array.isArray(r?.items) ? r.items : [];
    st.categories = r?.categories && typeof r.categories === 'object' ? r.categories : {};
    st.loaded = true;
  } catch (e) {
    st.error = String(e?.message || e);
    st.loaded = false;
  } finally {
    st.loading = false;
  }
  renderPersonaShell();
}

/* ══════════════════════════════════════════════════════════════
   取正文（带缓存）
   ══════════════════════════════════════════════════════════════ */
async function personaFetchPrompt(id) {
  const pid = String(id || '');
  if (personaPromptCache.has(pid)) return personaPromptCache.get(pid);
  const r = await api(`/api/persona-market/item/${encodeURIComponent(pid)}`, { timeoutMs: 115000 });
  const item = r?.item;
  if (!item?.prompt) throw new Error(r?.error || '读取人设正文失败');
  personaPromptCache.set(pid, item);
  return item;
}

/* ══════════════════════════════════════════════════════════════
   预览：看开头若干行，不落任何配置
   ──────────────────────────────────────────────────────────────
   2026-10-22：从「列表底部的内联小面板」改成模态浮层。
   原实现只往 #pm-preview 里塞 .pm-prev-* 结构，而 style.css 里**一条
   对应样式都没有** → 关闭键是浏览器默认 <button>（小灰块 + 默认 ×）、
   正文是默认 <pre>，和全站风格脱节；而且面板在列表最下方，点了还得
   往下滚才看得见。现在结构与样式成套（见 style.css「人设预览」段）。
   ══════════════════════════════════════════════════════════════ */
/* ── 预览浮层（全局单例）────────────────────────────────────────────────
   2026-10-22 第二版：浮层从「人设市场页里的一个 div」改成挂在 body 上的单例。
   原因：左栏新增「已安装 → 人设」页后，两个页面都要能弹预览。而 id 不能重复，
   再复制一套又必然出现"改一处漏一处"。现在谁都可以调 openPersonaPreview()，
   浮层自己管开关、遮罩点击和 Esc。
   ⚠️ 挂在 body 下（不是页面容器里）：body 有 contain:paint，会成为 fixed 的
      包含块 —— 但 body 就是满屏 100vh，效果等同视口。放在页面容器里反而会
      被 overflow:hidden 和切页时的 display:none 牵连。 */
let personaPreviewAction = null;

function ensurePreviewLayer() {
  let el = document.getElementById('pm-preview');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'pm-preview';
  el.hidden = true;
  // 点击委托挂在浮层自己身上：× / 遮罩 / 底部动作三条入口与调用页无关，
  // 不必让每个页面各写一遍（写过两遍就一定会漏一遍）。
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest?.('[data-pm-close]')) { closePersonaPreview(); return; }
    if (e.target.closest?.('[data-pm-prev-act]')) {
      const act = personaPreviewAction;
      closePersonaPreview();
      try { act?.onClick?.(); } catch (err) { console.warn('[persona] 预览动作失败：', err && err.message); }
    }
  });
  document.body.appendChild(el);
  return el;
}

/**
 * 打开人设预览浮层。
 * @param {object} o
 * @param {string} o.title    人设名
 * @param {string} o.text     正文（本地模板直接给，市场条目取回来再给）
 * @param {string} [o.author] 作者；空则只显示字数
 * @param {HTMLElement} [o.trigger] 触发按钮，关闭后焦点还给它
 * @param {{label:string, onClick:Function}} [o.action] 底部动作（市场页=试用 / 已安装页=使用）
 */
function openPersonaPreview({ title, text, author = '', trigger = null, action = null }) {
  const full = String(text || '');
  const head = full.slice(0, PERSONA_PREVIEW_CHARS);
  const more = full.length > head.length;
  const panel = ensurePreviewLayer();
  personaPreviewBtn = trigger || null;
  personaPreviewAction = action;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="pm-prev-box" role="dialog" aria-modal="true" aria-label="人设预览：${esc(title)}">
      <div class="pm-prev-head">
        <div class="pm-prev-heading">
          <span class="pm-prev-title">${esc(title)}</span>
          <span class="pm-prev-meta">${esc(personaFmtLen(full.length))}${author ? ` · @${esc(author)}` : ''}</span>
        </div>
        <button class="pm-prev-x" type="button" data-pm-close title="关闭（Esc）" aria-label="关闭预览">×</button>
      </div>
      <pre class="pm-prev-body">${esc(head)}</pre>
      <div class="pm-prev-more">
        <span class="pm-prev-more-text">${more ? `…… 还有 ${esc(personaFmtLen(full.length - head.length))}` : '全文已显示'}</span>
        ${action ? `<button class="mk-btn pm-prev-try" type="button" data-pm-prev-act>${esc(action.label)}</button>` : ''}
      </div>
    </div>`;
  document.addEventListener('keydown', personaPreviewEsc, true);
  // 焦点落到关闭键：键盘 / 读屏用户一进来就知道浮层开着，Esc 和回车都够得着
  try { panel.querySelector('.pm-prev-x')?.focus(); } catch { /* 焦点失败不影响显示 */ }
}

async function personaPreview(id, btn) {
  const pid = String(id || '');
  const meta = personaState.all.find((x) => x.id === pid);
  const title = meta?.title || pid;

  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
  try {
    const item = await personaFetchPrompt(pid);
    openPersonaPreview({
      title,
      text: String(item.prompt || ''),
      author: item.author || meta?.author || '',
      trigger: btn,
      // 模态把列表挡住了 —— 底部必须给一个「试用」，否则文案让人去点一个看不见的按钮
      action: { label: '试用这个人设', onClick: () => personaApply(pid, { applyNow: true }, null) }
    });
  } catch (e) {
    personaToast(`读取失败：${e?.message || e}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/* 关闭预览：浮层、内容、Esc 监听、焦点一次收拾干净。
   × 按钮 / 点遮罩 / Esc / 底部动作四条入口都走这里，避免各写一份、漏掉其中一步。
   监听无条件移除（放在最前面）：页面被整体重渲染后 #pm-preview 可能已换过节点，
   若先判 hidden 就 return，旧监听会一直挂在 document 上。 */
function closePersonaPreview() {
  document.removeEventListener('keydown', personaPreviewEsc, true);
  const panel = document.getElementById('pm-preview');
  if (panel && !panel.hidden) {
    panel.hidden = true;
    panel.innerHTML = '';
  }
  personaPreviewAction = null;
  const back = personaPreviewBtn;
  personaPreviewBtn = null;
  // 焦点还给刚才那颗「预览」按钮；卡片若已被重渲染（节点离线）就跳过
  try { back?.focus(); } catch { /* 忽略 */ }
}

/* Esc 关预览。捕获阶段 + stopPropagation：设置页和其他弹层也监听 Esc，
   不拦一下会「关掉预览的同时把底下的页面也退一层」。 */
function personaPreviewEsc(e) {
  if (e.key !== 'Escape') return;
  const panel = document.getElementById('pm-preview');
  // getClientRects 为空 = 已被祖先 display:none 藏起来。
  // 注意不能用 offsetParent 判断：fixed 元素的 offsetParent 恒为 null。
  if (!panel || panel.hidden || panel.getClientRects().length === 0) {
    document.removeEventListener('keydown', personaPreviewEsc, true);
    return;
  }
  e.stopPropagation();
  e.preventDefault();
  closePersonaPreview();
}


/* ══════════════════════════════════════════════════════════════
   试用 / 应用
   ══════════════════════════════════════════════════════════════ */
async function personaApply(id, { applyNow = false } = {}, btn) {
  const pid = String(id || '');
  const meta = personaState.all.find((x) => x.id === pid);
  const name = meta?.title || pid;
  const label = applyNow ? '试用中' : '应用中';

  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = `${label}…`; }
  try {
    // 试用会改 persona.roleText —— 先把当前值存下来当退路，
    // 否则用户试用完发现不喜欢，却只能自己手动去设置页改回去。
    if (applyNow && !personaTryBackup) {
      const cfg = (typeof state !== 'undefined' && state.config) || {};
      personaTryBackup = {
        id: pid,
        // 只存"试用前"的身份描述，不存试用的人设名 —— 还原提示要说的是
        // 换回了什么（试用前），不是换掉了什么（刚试用的那个）。
        roleText: String(cfg?.persona?.roleText || '')
      };
    }
    const r = await api('/api/persona-market/apply', {
      method: 'POST',
      body: JSON.stringify({ id: pid, name, applyNow })
    });
    // 刷新本地 config 副本：persona / customPersonas 两处都会变，
    // 不刷的话设置页与「已应用」徽标都会停在旧状态。
    // ⚠️ GET /api/config 回的是**脱敏后的 config 本体**（routes.js 的 `/api/config` 直接
    //   json(res,200,sanitizeConfig(...))），不是 {config:...} 包一层 ——
    //   包错了就会把整个 state.config 覆盖成 undefined。
    try {
      const d = await api('/api/config');
      if (d && typeof d === 'object' && d.persona) state.config = d;
    } catch { /* 刷新失败不阻塞：本次操作本身已成功 */ }
    personaToast(
      applyNow ? `已换成「${name}」—— 不满意点左上角还原` : `「${name}」已存进人设库`,
      'ok'
    );
    if (btn) { btn.textContent = '已应用'; btn.classList.add('mk-btn-done'); }
    // 试用后要把"还原"那颗钮补上 → 重画一次外壳。
    // ⚠️ 2026-10-22：renderPersonaShell 是整页 innerHTML 重建，列表容器会换成
    // 新节点、scrollTop 归零（群友反馈"每次安装完都得重新划下去"是同一类问题）。
    // 存一份旧的 scrollTop，重画后写给**新**的 #pm-list。
    const sub = document.querySelector('#pm-sub');
    const oldList = document.querySelector('#pm-list');
    const keepTop = oldList ? oldList.scrollTop : 0;
    if (sub && personaState.loaded) renderPersonaShell();
    const newList = document.querySelector('#pm-list');
    if (newList && keepTop) newList.scrollTop = keepTop;
  } catch (e) {
    personaToast(`${label}失败：${e?.message || e}`, 'err');
    if (btn) { btn.disabled = false; btn.textContent = old; }
  }
}

/** 还原试用：把 persona.roleText 换回试用前那一份。 */
async function personaUndoTry() {
  if (!personaTryBackup) return;
  const bak = personaTryBackup;
  try {
    const cfg = (typeof state !== 'undefined' && state.config) || {};
    const cur = String(cfg?.persona?.roleText || '');
    if (cur === bak.roleText) {
      personaToast('当前已经是试用前的人设了', 'warn');
      return;
    }
    // 走 POST /api/config（深合并，routes.js 的 `/api/config`）—— 只带 persona 这一个键，
    // 后端 merge 后 botName / participation 等同级字段原样保留。
    const d = await api('/api/config', {
      method: 'POST',
      body: JSON.stringify({ persona: { roleText: bak.roleText } })
    });
    if (d?.config) state.config = d.config;
    personaTryBackup = null;
    personaToast(`已换回试用前的人设`, 'ok');
    renderPersonaShell();
  } catch (e) {
    personaToast(`还原失败：${e?.message || e}`, 'err');
  }
}

/* 轻提示：复用 16-market.js 的 marketToast（同一视觉），未就绪时自绘。 */
function personaToast(text, tone) {
  if (typeof marketToast === 'function') { marketToast(text, tone); return; }
  marketToastFallback(text, tone);
}

function marketToastFallback(text, tone) {
  let el = document.getElementById('mk-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mk-toast';
    el.className = 'mk-toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.dataset.tone = tone || '';
  el.classList.add('on');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('on'), 3200);
}

/* ══════════════════════════════════════════════════════════════
   与外壳对接：切到人设市场页时懒加载
   ══════════════════════════════════════════════════════════════ */
(function hookPersonaMarketSwitch() {
  const orig = window.switchTab;
  if (typeof orig !== 'function') return;   // 00-core 还没就绪（正常不会：本文件最后加载）
  window.switchTab = function (name) {
    const r = orig.apply(this, arguments);
    if (name === 'personamarket') {
      try { loadPersonaMarket(); } catch (e) { /* 不得影响正常切页 */ }
    }
    return r;
  };
})();

// 显式挂 window（defer 经典脚本，顶层 const 不挂 window，但函数声明可以裸名跨文件引用）
if (typeof window !== 'undefined') {
  window.personaState = personaState;
  window.loadPersonaMarket = loadPersonaMarket;
  window.personaVisible = personaVisible;
}
// 〔市场页：应用内浏览 / 搜索 / 筛选 / 一键安装〕
// ---------------------------------------------------------------------------
// 以前「添加技能」只有一个「看看技能市场」按钮，点它跳到官网外链，回来还得走
// 「复制口令 → 粘贴 → 校验 → 安装」四步。绝大多数用户卡在这里：到了网页不知道
// 该装什么、不会走口令流程、懒得来回切窗口。参照 PCL 的 Mod 下载页，把市场搬进
// 应用内：左栏分类 + 顶部搜索 + 多条件筛选 + 卡片列表（彩色块图标 / 名称 / 分类 /
// 简介 / 下载量 / 更新时间 / 作者），点卡片直接装。
//
// 数据来源：后端 GET /api/market/list?kind=skill|plugin（src/routes.js），
//   由 src/market.js 代理官网 /skills 或 /plugins 并做字段白名单裁剪。
//   官网忽略 sort/q 参数（返回全量），所以搜索/筛选/排序全在客户端做，
//   百来条量级下无压力，且切筛选零延迟。
//
// 图标：官网列表里没有 icon/logo 字段（已核实无一带图）。照 PCL 做彩色块：
//   按 id 哈希出一组稳定色相（同一技能永远同色，不跳变），取名称首字符。
//   将来官网若加了真图标，在 marketTileHtml 里优先用它即可。
//
// 安全：下载安装仍走既有 /api/market/verify + /api/market/install 链路
//   （type 由服务器决定、zip 结构与路径穿越校验都在后端），本文件不自造下载。

'use strict';

/* ══════════════════════════════════════════════════════════════
   状态（每个 kind 一份，互不干扰）
   ══════════════════════════════════════════════════════════════ */
const MARKET_KINDS = {
  skill:  { view: 'skillmarket',  page: '#skillmarket-page',  label: '技能', apiKind: 'skill'  },
  plugin: { view: 'pluginmarket', page: '#pluginmarket-page', label: '插件', apiKind: 'plugin' }
};

// kind → { all, categories, q, cat, status, sort, loaded, loading, error }
// status 默认 'approved'：pending 条目还没有安装口令，混在列表里只会让人
// 点不动然后困惑。默认只看已上架的，想看全部随时切。
const marketState = {
  // rendered：这份数据已经画到 DOM 上了吗。切页时靠它跳过重复重建：
  // 市场条目动辄三四百条（/plugins 实测 402 条），每点一次顶栏「下载」就把整页
  // （警告块 + 工具栏 + 3 个 select + 全部卡片）拆了重建一遍，用户感知就是
  // "先卡一下才出界面"。数据没变就没必要重画。
  skill:  { all: [], categories: {}, q: '', cat: 'all', status: 'approved', sort: 'downloads', loaded: false, loading: false, error: '', rendered: false },
  plugin: { all: [], categories: {}, q: '', cat: 'all', status: 'approved', sort: 'downloads', loaded: false, loading: false, error: '', rendered: false }
};

/* 排序选项。官网无下载量以外的热度信号，所以「最新」用 updatedAt 兜底。 */
const MARKET_SORTS = [
  { key: 'downloads', label: '下载最多' },
  { key: 'updated',   label: '最近更新' },
  { key: 'name',      label: '名称排序' }
];
/* 审阅状态筛选（pending 的还没有安装口令，点不了"安装"，但能看到）*/
const MARKET_STATUS = [
  { key: 'approved', label: '已上架' },
  { key: 'all',      label: '全部' }
];

/* ══════════════════════════════════════════════════════════════
   彩色块图标，按 id 稳定哈希出一组色相
   ══════════════════════════════════════════════════════════════ */
/**
 * 由字符串算出 0~359 的色相。用 FNV-1a 变体，分布比简单累加均匀，
 * 避免相邻 id 撞成一模一样的颜色。
 */
function marketHueOf(str) {
  let h = 2166136261;
  const s = String(str || '?');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/** 取名称里第一个「有意义的字符」当图标字（跳过空格与常见标点）。 */
function marketInitialOf(name, id) {
  const s = String(name || id || '?').trim();
  const m = s.match(/[\p{L}\p{N}]/u);          // 第一个字母或数字（含中文）
  return m ? m[0].toUpperCase() : '?';
}

/**
 * 生成彩色块 HTML。
 * 若官网将来在条目里给出真图标字段（icon/logo/avatar），在这里优先使用；
 * 目前核实列表接口无此字段，故走生成的字母块。
 */
function marketTileHtml(item) {
  const hue = marketHueOf(item?.id || item?.name);
  const ch = marketInitialOf(item?.name, item?.id);
  return `<span class="mk-tile" style="--mk-h:${hue}" aria-hidden="true">${esc(ch)}</span>`;
}

/* ══════════════════════════════════════════════════════════════
   工具
   ══════════════════════════════════════════════════════════════ */
/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD。 */
function marketRelTime(iso) {
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

/** 下载量紧凑显示：1234 → 1.2k。 */
function marketFmtDownloads(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 1000) return String(v);
  if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

/**
 * 该 item 装在哪一类里（'skill' | 'plugin'），本机没有则 null。
 * 卡片上那颗「管理」钮要跳到对应的管理页，光知道"装过"不够，
 * 得知道装的是技能还是插件。
 *
 * 这里有个必须记住的坑：state.skills 里技能与插件是混在一起的。
 * /api/skills 全量返回两类条目，靠各自的 kind 字段区分（loadSkillsStatus
 * 一次写进 state.skills；renderModulePage 也是拿 state.skills 再按 kind 过滤）。
 * 所以不能写成"在 state.skills 里找到就算技能"，那会把插件判成技能、
 * 点「管理」跳到技能页，然后找不到卡（还看不出为什么）。
 * 正确做法：读命中那一条自己的 kind，规则与 renderModulePage 逐字一致
 * （kind 为 null / 缺省 → 算技能）。
 */
function marketInstalledKind(item) {
  try {
    const id = item?.id;
    if (id == null) return null;
    const all = [
      ...((typeof state !== 'undefined' && state.skills) || []),
      ...((typeof state !== 'undefined' && state.plugins) || [])
    ];
    const hit = all.find((m) => m && m.id === id);
    if (!hit) return null;
    return hit.kind === 'plugin' ? 'plugin' : 'skill';
  } catch { return null; }
}

/** 该 item 在本机是否已安装（按 id 匹配 state.skills / state.plugins）。 */
function marketIsInstalled(item) {
  return marketInstalledKind(item) !== null;
}

/* ══════════════════════════════════════════════════════════════
   筛选 / 排序（纯函数，便于测试）
   ══════════════════════════════════════════════════════════════ */
/**
 * 按当前 kind 的状态过滤 + 排序，返回要渲染的数组。
 * @param {object} st marketState[kind]
 * @returns {Array}
 */
function marketVisible(st) {
  const q = (st.q || '').trim().toLowerCase();
  let list = st.all.filter((x) => {
    if (st.status !== 'all' && x.status !== st.status) return false;
    if (st.cat !== 'all' && x.category !== st.cat) return false;
    if (q) {
      const hay = `${x.name || ''} ${x.description || ''} ${x.id || ''} ${x.author || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const by = st.sort;
  list = list.slice().sort((a, b) => {
    if (by === 'name') return String(a.name || a.id).localeCompare(String(b.name || b.id), 'zh');
    if (by === 'updated') return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    // downloads（默认）：下载量降序，同量再按更新时间
    const d = (Number(b.downloads) || 0) - (Number(a.downloads) || 0);
    return d !== 0 ? d : ((Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  });
  return list;
}

/** 分类计数（只计当前 status 范围内的，用于左栏显数）。 */
function marketCatCounts(st) {
  const out = { all: 0 };
  for (const x of st.all) {
    if (st.status !== 'all' && x.status !== st.status) continue;
    out.all += 1;
    const c = x.category || 'other';
    out[c] = (out[c] || 0) + 1;
  }
  return out;
}

/* ══════════════════════════════════════════════════════════════
   渲染
   ══════════════════════════════════════════════════════════════ */
function renderMarketShell(kind) {
  const meta = MARKET_KINDS[kind];
  const box = document.querySelector(meta.page);
  if (!box) return;
  const st = marketState[kind];
  const counts = marketCatCounts(st);
  const catEntries = Object.entries(st.categories || {});

  box.innerHTML = `
    <div class="mk-head">
      <div class="mk-title">
        <h2>${meta.label}市场</h2>
        <span class="mk-sub" id="mk-sub-${kind}">${st.loaded ? `共 ${counts.all} 个` : '正在连接市场…'}</span>
      </div>
      <div class="mk-head-actions">
        <button class="mk-refresh" type="button" data-mk-refresh="${kind}" title="重新拉取市场列表">↻ 刷新</button>
      </div>
    </div>

    <!-- 2026-10-18：装扩展前的常驻警告。插件数量与 token 用量/缓存命中率直接相关；
         且本版本自带用量优化，第三方同类插件会冲突双双失效。放在标题栏正下方，
         不挡搜索/筛选，但装之前一定看得见。视觉与 .mod-trust-all 同一套暖色约定。 -->
    <div class="mk-warn" role="note">
      <svg class="mkw-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 22 20.5H2L12 3.5zm0 3.6L5.3 18.5h13.4L12 7.1zm-1 3.4v4h2v-4h-2zm0 5v2h2v-2h-2z"/></svg>
      <div class="mkw-text">
        <p>过多的插件会显著增加 <b>token 用量</b>，并且降低<b>缓存命中率</b>。</p>
        <p>此版本已自带 token 用量优化，<b>不要再安装其他的用量优化插件</b> —— 会冲突，导致二者都不生效。</p>
      </div>
    </div>

    <div class="mk-toolbar">
      <div class="mk-search">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4a7 7 0 1 0 4.2 12.6l4.1 4.1 1.4-1.4-4.1-4.1A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z"/></svg>
        <input type="text" id="mk-q-${kind}" placeholder="搜索${meta.label}名称、简介、作者…" autocomplete="off" spellcheck="false" value="${esc(st.q)}" />
        <button class="mk-q-clear" type="button" data-mk-qclear="${kind}" title="清空" ${st.q ? '' : 'hidden'}>×</button>
      </div>
      <div class="mk-filter-panel">
        <div class="mk-filters">
          <label class="mk-fld mk-cat-field" id="mk-cats-${kind}"><span>分类</span>
            <select class="mk-select" data-mk-cat-select="${kind}" aria-label="按分类筛选">
              <option value="all" ${st.cat === 'all' ? 'selected' : ''}>全部（${counts.all}）</option>
              ${catEntries.map(([k, v]) => `<option value="${esc(k)}" ${st.cat === k ? 'selected' : ''}>${esc(v)}（${counts[k] || 0}）</option>`).join('')}
            </select>
          </label>
          <label class="mk-fld"><span>状态</span>
            <select class="mk-select" data-mk-status-select="${kind}" aria-label="按审核状态筛选">
              ${MARKET_STATUS.map((s) => `<option value="${s.key}" ${st.status === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
            </select>
          </label>
          <label class="mk-fld"><span>排序</span>
            <select class="mk-select" data-mk-sort-select="${kind}" aria-label="排序方式">
              ${MARKET_SORTS.map((s) => `<option value="${s.key}" ${st.sort === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}
            </select>
          </label>
        </div>
      </div>
    </div>

    <div class="mk-body">
      <div class="mk-list" id="mk-list-${kind}"></div>
    </div>`;

  renderMarketList(kind);
  bindMarketShell(kind);
}

/** 只重画列表区（筛选/搜索/排序变化时用，不重建工具栏，避免输入框失焦）。 */
function renderMarketList(kind) {
  const meta = MARKET_KINDS[kind];
  const box = document.querySelector(`#mk-list-${kind}`);
  if (!box) return;
  const st = marketState[kind];

  if (st.loading && !st.all.length) {
    box.innerHTML = '<div class="mk-empty"><span class="mk-spin"></span>正在加载市场…</div>';
    return;
  }
  if (st.error && !st.all.length) {
    box.innerHTML = `<div class="mk-empty mk-err">市场连接失败：${esc(st.error)}<br><button class="btn" type="button" data-mk-refresh="${kind}">重试</button></div>`;
    return;
  }
  const list = marketVisible(st);
  if (!list.length) {
    box.innerHTML = st.all.length
      ? '<div class="mk-empty">没有匹配的条目，换个关键词或分类试试。</div>'
      : '<div class="mk-empty">市场里还没有上架的条目。</div>';
    return;
  }

  box.innerHTML = list.map((x) => {
    const approved = x.status === 'approved';
    // 拿到"装在哪一类"，才能让「管理」钮跳到对的管理页
    const installedKind = approved ? marketInstalledKind(x) : null;
    const installed = !!installedKind;
    const cat = x.categoryName || st.categories[x.category] || '其他';
    const desc = String(x.description || '暂无简介').replace(/\s+/g, ' ').trim();
    const canInstall = approved && !!x.installCode;
    return `
      <article class="mk-card${installed ? ' mk-installed' : ''}" data-mk-id="${esc(x.id)}">
        ${marketTileHtml(x)}
        <div class="mk-info">
          <div class="mk-row1">
            <span class="mk-name">${esc(x.name || x.id)}</span>
            <span class="mk-badge">${esc(cat)}</span>
            ${approved ? '' : '<span class="mk-badge mk-pending">待审核</span>'}
            ${installed ? '<span class="mk-badge mk-ok">已安装</span>' : ''}
          </div>
          <div class="mk-desc" title="${esc(desc)}">${esc(desc)}</div>
          <div class="mk-meta">
            <span title="下载量">⇩ ${marketFmtDownloads(x.downloads)}</span>
            <span title="最近更新">↻ ${esc(marketRelTime(x.updatedAt) || '—')}</span>
            <span title="作者">@${esc(x.author || '未署名')}</span>
            <span class="mk-ver">v${esc(x.version || '0.0.0')}</span>
          </div>
        </div>
        <div class="mk-action">
          ${installed
            ? `<button class="mk-btn mk-btn-manage" type="button" data-mk-manage="${esc(installedKind)}|${esc(x.id)}" title="已安装 —— 点这里去开 / 关它">管理</button>`
            : canInstall
              ? `<button class="mk-btn mk-btn-install" type="button" data-mk-install="${esc(x.id)}">安装</button>`
              : '<button class="mk-btn" type="button" disabled title="该条目尚未通过审核">不可用</button>'}
        </div>
      </article>`;
  }).join('');

  // 列表区（含"重试"按钮）的委托，每次重画后重挂，因为 innerHTML 被整体替换
  bindMarketList(kind);
}

/* ══════════════════════════════════════════════════════════════
   交互绑定
   ══════════════════════════════════════════════════════════════ */
function bindMarketShell(kind) {
  const meta = MARKET_KINDS[kind];
  const root = document.querySelector(meta.page);
  if (!root || root.dataset.mkBound === '1') return;
  root.dataset.mkBound = '1';

  root.addEventListener('click', (e) => {
    const t = e.target;
    // 市场卡片上的「管理」→ 切到带开关的管理页，并高亮那一张卡
    const mg = t.closest?.('[data-mk-manage]');
    if (mg) { marketJumpToInstalled(mg.dataset.mkManage); return; }
    const ref = t.closest?.('[data-mk-refresh]');
    // force：后端有 60s 列表缓存，点「刷新/重试」必须跳过它，否则点了等于没点
    if (ref) { marketState[kind].loaded = false; loadMarket(kind, { force: true }); return; }
    const clr = t.closest?.('[data-mk-qclear]');
    if (clr) {
      marketState[kind].q = '';
      const inp = root.querySelector(`#mk-q-${kind}`);
      if (inp) inp.value = '';
      clr.hidden = true;
      renderMarketList(kind);
      return;
    }
  });

  // 下拉筛选：分类 / 状态 / 排序与 PCL 下载页一致。状态变化会影响分类计数，
  // 因此重画工具栏；搜索词、排序、分类状态保存在 marketState 中并自动恢复。
  root.addEventListener('change', (e) => {
    const target = e.target;
    if (target?.matches?.(`[data-mk-cat-select="${kind}"]`)) {
      marketState[kind].cat = target.value || 'all';
      renderMarketList(kind);
      return;
    }
    if (target?.matches?.(`[data-mk-sort-select="${kind}"]`)) {
      marketState[kind].sort = target.value || 'downloads';
      renderMarketList(kind);
      return;
    }
    if (target?.matches?.(`[data-mk-status-select="${kind}"]`)) {
      marketState[kind].status = target.value || 'approved';
      renderMarketShell(kind);
    }
  });

  // 搜索：输入即筛（客户端过滤，无需防抖；126 条量级）
  root.addEventListener('input', (e) => {
    if (e.target?.id !== `mk-q-${kind}`) return;
    marketState[kind].q = e.target.value;
    const clr = root.querySelector(`[data-mk-qclear="${kind}"]`);
    if (clr) clr.hidden = !e.target.value;
    renderMarketList(kind);
  });
}

/* ══════════════════════════════════════════════════════════════
   从市场卡片跳到「已安装」的管理页，并定位到那一张卡
   ══════════════════════════════════════════════════════════════ */
/** 把任意字符串安全地放进 `[attr="…"]` 选择器（只转义 CSS 字符串字面量里的两个特殊字符）。 */
function marketCssStr(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * spec = "skill|<id>" / "plugin|<id>"。
 * 管理页的渲染是异步的（switchTab → loadModulePage 要等 /api/skills 回来），
 * 所以这里轮询等那张卡出现，最多 ~2s；等不到就明说一句，不做静默失败。
 * id 本身可能含 '|'，只按第一个 '|' 切，其余原样拼回去。
 */
function marketJumpToInstalled(spec) {
  const raw = String(spec || '');
  const cut = raw.indexOf('|');
  if (cut < 0) return;
  const kind = raw.slice(0, cut) === 'plugin' ? 'plugin' : 'skill';
  const id = raw.slice(cut + 1);
  if (!id) return;

  const view = kind === 'plugin' ? 'plugins' : 'skills';
  if (typeof switchTab === 'function') switchTab(view);

  let tries = 0;
  const tick = () => {
    const card = document.querySelector(`.mcard[data-skill-id="${marketCssStr(id)}"]`);
    if (card) {
      try { card.scrollIntoView({ block: 'center' }); } catch { /* 老引擎不支持 options */ }
      // 先摘再挂 + 读一次布局：连点同一张卡时动画能重放，而不是"第二次没反应"
      card.classList.remove('mcard-jump');
      void card.offsetWidth;
      card.classList.add('mcard-jump');
      clearTimeout(card._r102JumpT);
      card._r102JumpT = setTimeout(() => card.classList.remove('mcard-jump'), 1800);
      return;
    }
    if (++tries < 25) { setTimeout(tick, 80); return; }
    marketToast('没找到这张卡 —— 可能已经被卸载了', 'warn');
  };
  setTimeout(tick, 60);
}

function bindMarketList(kind) {
  const box = document.querySelector(`#mk-list-${kind}`);
  if (!box || box.dataset.mkBound === '1') return;
  box.dataset.mkBound = '1';
  box.addEventListener('click', (e) => {
    const retry = e.target.closest?.('[data-mk-refresh]');
    if (retry) { marketState[kind].loaded = false; loadMarket(kind, { force: true }); return; }
    const btn = e.target.closest?.('[data-mk-install]');
    if (btn) installFromMarket(kind, btn.dataset.mkInstall, btn);
  });
}

/* ══════════════════════════════════════════════════════════════
   加载
   ══════════════════════════════════════════════════════════════ */
async function loadMarket(kind, { force = false } = {}) {
  const meta = MARKET_KINDS[kind];
  const st = marketState[kind];
  if (st.loading) return;
  // 已加载且已经画在屏幕上 → 直接复用现有 DOM，什么都不做。
  // 这是"点下载卡一下"的主因：原先这里无条件 renderMarketShell()，把几百张卡
  // 连同工具栏整块拆了重建，白付一次 DOM 构建 + 一次布局。
  if (st.loaded && !force) {
    if (!st.rendered) renderMarketShell(kind);
    return;
  }

  st.loading = true;
  st.error = '';
  // 6 秒还没回来就给一句人话：这条链路实测 6~34 秒，干等一个不动的"正在连接市场…"
  // 用户会以为卡死然后强制关窗。只是在原有文案基础上补一句，不改状态机。
  const slowTimer = setTimeout(() => {
    const el = document.getElementById('mk-sub-' + kind);
    if (el && st.loading) el.textContent = '线路较慢，仍在等…（最长约 2 分钟）';
  }, 6000);
  try {
    // 先画一次骨架（含"正在加载"），让切页立刻有反馈。
    // 这句必须在 try 之内：渲染一旦抛异常，st.loading 永远停在 true，
    // 本次运行期间这个市场页再也加载不出来（点刷新也会被 `if (st.loading) return` 挡掉）。
    renderMarketShell(kind);
    // 超时 115s：后端自己给上游 90s（一次瞬时错误重试，总预算不叠加），
    // 前端再留 25s 余量。以前这里是 15s，比后端的 30s 还短，上游稍慢就必然
    // 先被前端掐断，用户看到「请求超时（15 秒无响应）」，而后台还在正常拉取。
    // 实测该接口到本机 6~54 秒不等（/plugins 402 条用了 53.9s）。
    // force=1 让后端跳过 5min 列表缓存（装完 / 点刷新时要看到新状态）。
    const r = await api(`/api/market/list?kind=${encodeURIComponent(meta.apiKind)}${force ? '&force=1' : ''}`, { timeoutMs: 115000 });
    st.all = Array.isArray(r?.items) ? r.items : [];
    st.categories = r?.categories && typeof r.categories === 'object' ? r.categories : {};
    st.loaded = true;
    st.rendered = false;          // 新数据 → 必须重画
  } catch (e) {
    st.error = String(e?.message || e);
    st.loaded = false;
  } finally {
    clearTimeout(slowTimer);
    // 收尾渲染放进 finally 并自己兜住：无论上面哪一步抛了，loading 都要归零、
    // 页面都要有一次最终绘制，否则就是"永远正在连接市场…"。
    st.loading = false;
    try { renderMarketShell(kind); } catch (err) { console.error('[market] 渲染失败:', err); }
    // 只有"数据到位并已画上屏"才算 rendered。失败/骨架阶段保持 false，
    // 下次切回来会重新请求，而不是把一句错误停在屏幕上。
    st.rendered = st.loaded;
  }
}

/* ══════════════════════════════════════════════════════════════
   一键安装（走既有 verify + install 链路）
   ══════════════════════════════════════════════════════════════ */
async function installFromMarket(kind, id, btn) {
  const st = marketState[kind];
  const item = st.all.find((x) => x.id === id);
  if (!item) return;
  const code = String(item.installCode || '').trim().toUpperCase();
  if (!code) { marketToast('这个条目还没有安装口令（可能未过审）', 'warn'); return; }

  const name = item.name || id;
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '安装中…';
  try {
    // ① 校验口令（顺带拿到服务器判定的 type）
    const v = await api('/api/market/verify', { method: 'POST', body: JSON.stringify({ codes: [code] }) });
    const hit = (v?.results || [])[0];
    if (!hit?.ok) throw new Error(hit?.error || '口令校验失败');
    // ② 安装（类型由服务器 entry.type 决定，装进 skills/ 或 plugins/）
    const r = await api('/api/market/install', {
      method: 'POST',
      body: JSON.stringify({ code, entry: hit })
    });
    // ③ 后端不再"下载即安装"。
    //    下载的包先进「扩展锻造台」暂存区 → 过五道闸门 → 等你人工确认才落盘。
    //    这里必须如实说"待确认"，不能再弹"已安装"，那正是黑盒感的来源。
    if (r?.pending) {
      const g = r.gate || {};
      const head = g.ok
        ? `闸门通过${g.confirm ? `，${g.confirm} 项要你确认` : ''}`
        : `闸门阻断 ${g.blocking || 0} 项`;
      // 解包时因体积超限被丢掉的条目必须在这里就说出来：跳转后的锻造台页面
      // 虽然也会提示，但用户当下看到的是"已下载"这个结论，不说就等于谎报完整。
      // 原因值与 13-doctor.js 的 FORGE_SKIP_SIZE_REASONS 一致（后端 SKIP_REASONS）。
      const skipped = Array.isArray(r.skipped) ? r.skipped : [];
      const sizeLost = skipped.filter((s) => typeof s === 'object'
        && (s.reason === 'single-file-too-large' || s.reason === 'total-too-large'));
      const lostNote = sizeLost.length
        ? `；⚠️ 另有 ${sizeLost.length} 个文件因体积超限未解出，这个技能可能无法正常工作`
        : '';
      marketToast(
        r.deduped
          ? `「${name}」之前已经下载过了 —— 直接用现有草稿（${head}），正在打开锻造台…`
          : `「${name}」已下载（${head}）${lostNote} —— 正在打开锻造台并让模型适配本机环境…`,
        g.ok && !sizeLost.length ? 'ok' : 'warn'
      );
      // 置为不可再点：再点一次只会又下一份、又生成一个草稿（同一口令重复入暂存区）。
      // 后端现在已经按内容摘要去重（同 digest 直接复用现有草稿），这里仍是第一道
      // 视觉提示：按钮停留在"待确认"能直接说明这条口令已经处理过了。
      // 这不是"已安装"，所以不加 mk-btn-done（那个绿色态的含义是装好了）。
      btn.disabled = true;
      btn.textContent = '待确认';
      // 直接跳到 harness → 自创扩展、打开这个草稿、开始适配（只写暂存区，落盘仍要人工确认）
      if (typeof forgeOpenAndAdapt === 'function') {
        forgeOpenAndAdapt(r.draftId).catch(() => { /* 跳转失败不影响下载结果，用户可手动进 */ });
      }
      return;
    }
    // ③' 兼容性回执：安装成功 ≠ 能用。后端在落地后已真实加载过
    //    这个模块并把结果随响应带回，这里把笼统的"已安装"细分成三档，
    //    不再让加载失败的包也弹绿字，用户不用自己去模块页翻红字。
    const kindLabel2 = r?.kind === 'plugin' ? '插件' : '技能';
    const load = r?.load;
    if (load && load.ok === false) {
      marketToast(`「${name}」已下载安装，但加载失败：${load.error || '原因未知'} —— 到${kindLabel2}页点「🔧 自动适配」可让模型修`, 'err');
    } else if (load && load.ok) {
      marketToast(`${kindLabel2}「${name}」已安装${load.active ? '并生效' : (load.enabled ? '（已加载）' : '（当前为关闭状态，到' + kindLabel2 + '页开启）')}`, 'ok');
    } else {
      marketToast(`${kindLabel2}「${name}」已安装`, 'ok');
    }
    btn.textContent = '已安装';
    btn.classList.add('mk-btn-done');
    // 刷新两个模块页（安装类型可能与被浏览的 kind 不同）+ 重画列表（标记"已安装"）
    await loadModulePage('skill', { rescan: true }).catch(() => {});
    await loadModulePage('plugin', { rescan: true }).catch(() => {});
    // 重画列表必须保住滚动位置。市场动辄三四百条，装完弹回顶部等于白翻一遍。
    // innerHTML 重建子节点时容器的 scrollTop 会被清零（内容高度瞬间为 0），
    // 所以先存一份再写回。注意：只在"安装完"这条路径保持滚动；筛选/搜索/排序变化时不保持。
    // 那时内容整个变了，回到顶部才是对的（renderMarketList 内部不处理，区分在调用处）。
    const listEl = document.querySelector('#mk-list-' + kind);
    const keepTop = listEl ? listEl.scrollTop : 0;
    renderMarketList(kind);
    if (listEl) listEl.scrollTop = keepTop;
  } catch (e) {
    marketToast(`安装失败：${e?.message || e}`, 'err');
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* 轻量提示（自绘，避免 alert 阻塞渲染进程，与全项目一致） */
function marketToast(text, tone) {
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
   与外壳对接：切到市场页时懒加载
   ══════════════════════════════════════════════════════════════ */
(function hookMarketSwitch() {
  const orig = window.switchTab;

  /* 市场页要判断「这一条本机装没装」，依据是 state.skills / state.plugins。
     但这两个数组只有**进过技能页/插件页**（loadModulePage）才会填上，
     用户在设置里直接点「技能市场」，或深链直达，state 里还是空的，
     结果就是所有卡片都显示「安装」，已装的还能再点一次。
     这里在进入市场页时补拉一次（失败静默：取不到只是少个徽标，不影响浏览）。 */
  const MODULE_IFACE = {
    skill: 'skills',
    plugin: 'plugins'
  };
  async function ensureModuleState(kind) {
    const seg = MODULE_IFACE[kind];
    if (!seg) return false;
    /* guard 与取数都只认 /api/skills。原实现按 MODULE_IFACE 拼出
       '/api/plugins' 去请求，而后端根本没有这条路由（技能与插件全走
       /api/skills 一个出口，靠各自的 kind 区分，见 src/routes.js），
       于是每次进市场页先白吃一个 404，再掉进 loadSkillsStatus() 兜底，
       既污染控制台又多绕一圈。另外 state.plugins 全工程没有任何一处赋值，
       真正的判据只有 state.skills（marketInstalledKind 读的就是它），
       所以 guard 也统一按 state.skills 判，不再按 seg 分流。 */
    // 返回 true 表示"这次真的把 state.skills 填上了"，调用方据此决定要不要
    // 重画列表。否则每次进市场页都要多付一次全量重建（几百张卡）。
    if (Array.isArray(state.skills) && state.skills.length) return false;
    try {
      const d = await api('/api/skills');
      const list = Array.isArray(d?.skills) ? d.skills : null;
      if (list) {
        state.skills = list;
        if (kind === 'skill') state.skillsSummary = d.summary || state.skillsSummary || {};
        return true;
      } else if (typeof loadSkillsStatus === 'function') {
        // 接口形状不认识时的兜底：走既有的状态加载器（它知道字段细节）
        await loadSkillsStatus().catch(() => {});
        return true;
      }
    } catch { /* 静默：拿不到安装状态不影响市场浏览 */ }
    return false;
  }
  if (typeof orig !== 'function') return;      // 00-core 还没就绪（正常不会：本文件最后加载）
  window.switchTab = function (name) {
    const r = orig.apply(this, arguments);
    if (name === 'skillmarket' || name === 'pluginmarket') {
      const kind = name === 'skillmarket' ? 'skill' : 'plugin';
      /* 原来是 `ensureModuleState(kind).then(() => loadMarket(kind))`，市场列表被
         /api/skills 串行挡住。那条接口一慢或一挂，市场页就永远停在「正在连接市场…」。
         现在改成并行：列表先拉、骨架先出；"本机装了什么"回来后再补一次渲染，
         把已装徽标刷上去。代价只是首帧可能闪一下"安装"按钮，比整页加载不出来好得多。 */
      try { loadMarket(kind); } catch (e) { /* 不得影响正常切页 */ }
      ensureModuleState(kind)
        .then((changed) => {
          // 只有真的补上了"本机装了什么"，才值得再画一遍刷徽标；
          // 否则这一次全量重建就是纯浪费（几百张卡的构建 + 布局）。
          if (!changed) return;
          marketState[kind].rendered = false;
          try { renderMarketShell(kind); } catch { /* 补渲染失败不影响已上屏内容 */ }
        })
        .catch(() => { /* 拿不到模块状态：列表照常可用，只是没有"已安装"徽标 */ });
    }
    return r;
  };
})();

// 显式挂 window（defer 经典脚本，顶层 const 不挂 window，但函数声明可以裸名跨文件引用；
// 这里额外挂一遍，方便其它模块与探针调用）
if (typeof window !== 'undefined') {
  window.MARKET_KINDS = MARKET_KINDS;
  window.marketState = marketState;
  window.loadMarket = loadMarket;
  window.marketVisible = marketVisible;
  window.marketHueOf = marketHueOf;
  window.marketInitialOf = marketInitialOf;
}

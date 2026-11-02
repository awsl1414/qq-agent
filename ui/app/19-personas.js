// 〔已安装的人设〕—— 左栏「下载 → 已安装 → 人设」
'use strict';
/* ══════════════════════════════════════════════════════════════
   为什么单独开一页（2026-10-22）：
     人设落在 config.customPersonas，但在此之前**没有任何界面列出它们** ——
     市场页只给市场条目打「已应用」徽标；设置页只有一个「选择人设」弹窗，
     而那个弹窗的语义是"挑一个填进角色设定"，不是"看看我装了哪些"。
     于是用户装了几个、装的是什么、怎么切走、怎么删，全都看不见。
     技能和插件在「已安装」段各有一页，人设是同一类东西却没有 —— 这是
     信息架构的缺口，不是样式问题。

   与技能 / 插件页的关键差别：
     那两个是**开关型**（每个独立启用/关闭）；人设是**单选型**（同一时间只有
     一个 roleText 生效）。所以这里没有开关，只有「使用中」标记 + 「使用」按钮。
   ══════════════════════════════════════════════════════════════ */

var PERSONA_SRC = {
  builtin: { label: '内置', tip: '随应用一起提供的人设' },
  market: { label: '市场', tip: '从人设市场装的' },
  custom: { label: '自定义', tip: '自己在设置页写的' }
};

/* 状态筛选（与插件页的 MODULE_FILTER 同款三档）。
   人设只有"使用中 / 未使用"两种状态，所以没有插件页那两档
   （依赖未就绪 / 加载失败 —— 人设是纯文本，不存在加载失败）。
   放模块级：切走再回来保留筛选，跟插件页行为一致。 */
var personasFilter = 'all';   // all | on | off

/* 切换进行中的闸门。
   全局人设是单选，但连点两个开关会发两个 POST —— 后端 updateConfig 虽然是同步
   读-改-写、最终值以最后一次为准，前端两次 renderPersonasPage 交错却会让用户
   看到"两个都亮过一下"的中间态。串行化最省事：上一次没回来就忽略新的点击。 */
var personasSwitching = false;

/* 最近一次把人设列表渲染到了哪个容器。
   2026-10-22：会话设置（全屏页）的右栏也要渲染同一套列表，容器不再是固定的
   #personas-page。所有"操作完重画"的路径（开关 / 删除 / 筛选）都调无参的
   renderPersonasPage()，靠这个变量找回家 —— 否则在会话设置里点一下开关，
   重画会画到后台那个隐藏的人设页上，眼前这份纹丝不动。 */
var personasHost = null;

function personaHostEl() {
  // 只认"还在 DOM 里且真的可见"的那个容器。会话设置是全屏页，关掉之后
  // #bp-setup-scroll 仍然挂在 DOM 上、只是被隐藏 —— 不判可见性的话，
  // 回到人设页点开关会重画到那个看不见的右栏里，眼前纹丝不动。
  if (personasHost && document.body.contains(personasHost) && personasHost.getClientRects().length) {
    return personasHost;
  }
  return document.getElementById('personas-page');
}

/** 当前生效的人设正文（config.persona.roleText）。 */
function personaCurrentText() {
  return String((typeof state !== 'undefined' && state.config && state.config.persona && state.config.persona.roleText) || '').trim();
}

/** 是否就是当前生效的那一个。判据与设置页「选择人设」一致：比正文，不比名字。 */
/**
 * 当前生效的人设 id —— **第一个**正文匹配的模板。
 *
 * config 里只存 roleText，没有"当前用的是哪个模板"的字段，所以只能靠正文反查。
 * ⚠️ 2026-10-22：判据从"每张卡各自比正文"改成"全局只认第一个匹配的 id"。
 *    原因是全局人设**同时只能有一个**：用户如果把同一个 .txt 导入两次，
 *    两个人设正文完全相同，按正文比对会让两张卡同时显示「使用中」、两个开关
 *    同时打开 —— 看起来像能同时启用两个。改成只认第一个 id 后，无论重复多少份，
 *    最多只有一个亮。
 *    顺序取自 state.personaTemplates 的插入顺序（内置在前、自定义按数组序），稳定。
 */
function personaCurrentId() {
  const cur = personaCurrentText();
  if (!cur) return '';
  const tpl = (typeof state !== 'undefined' && state.personaTemplates) || {};
  for (const [id, p] of Object.entries(tpl)) {
    if (String((p && p.text) || '').trim() === cur) return id;
  }
  return '';
}

/** 这个 id 是不是当前生效的那一个。全局人设是单选，所以至多一个 id 返回 true。 */
function personaIsCurrent(id) {
  return !!id && id === personaCurrentId();
}

/**
 * 把 state.personaTemplates 摊成列表。
 * custom_N 里的 N 就是 customPersonas 的下标 —— 靠它区分"从市场装的"和"自己写的"：
 * GET /api/persona-templates 只回 id/name/text/builtin，不回 source。
 */
function personaInstalledList() {
  const tpl = (typeof state !== 'undefined' && state.personaTemplates) || {};
  const customs = (typeof state !== 'undefined' && Array.isArray(state.config && state.config.customPersonas))
    ? state.config.customPersonas : [];
  const out = [];
  for (const [id, p] of Object.entries(tpl)) {
    const builtin = !!p.builtin;
    let source = 'builtin';
    let author = '';
    if (!builtin) {
      const m = /^custom_(\d+)$/.exec(id);
      const rec = m ? customs[Number(m[1])] : null;
      source = (rec && (rec.sourceId || rec.marketId)) ? 'market' : 'custom';
      author = String((rec && rec.author) || '');
    }
    out.push({ id, name: String(p.name || id), text: String(p.text || ''), builtin, source, author });
  }
  // 使用中的排最前 → 内置在前 → 按名字
  out.sort((a, b) =>
    (personaIsCurrent(b.id) ? 1 : 0) - (personaIsCurrent(a.id) ? 1 : 0)
    || (b.builtin ? 1 : 0) - (a.builtin ? 1 : 0)
    || a.name.localeCompare(b.name, 'zh'));
  return out;
}

/* ══════════════════════════════════════════════════════════════
   渲染
   ══════════════════════════════════════════════════════════════ */
function renderPersonasPage(opts) {
  const o = opts || {};
  const box = o.box || personaHostEl();
  if (!box) return;
  personasHost = box;
  // compact：会话设置右栏那种窄容器 —— 去掉底部尾注（那块是"全局概览"，
  // 属于人设页的收尾，塞进右栏只会把卡片往下推）。
  const compact = !!o.compact;
  // keepScroll：切换人设 / 删除后重画时保住滚动位置。列表内容几乎没变
  //（只换一个开关状态），弹回顶部会让用户重新找刚才那一张。
  // 筛选变化**不**传这个 —— 那时内容整个变了，回顶部才是对的。
  const keepScroll = !!o.keepScroll;
  const prevTop = keepScroll ? box.scrollTop : 0;
  const all = personaInstalledList();
  const cur = all.find((x) => personaIsCurrent(x.id));
  const onCount = cur ? 1 : 0;
  // 筛选后的列表；统计（页头那个 X / N、筛选条的数字）一律按全量算，
  // 否则"使用中 1"在切到「未使用」档后会变成 0，看着像状态丢了。
  // 2026-10-23：筛选状态是模块级变量，主页「下载→已安装→人设」与会话设置右栏**共用**。
  // 群友反馈「会话设置里的人设选择：人设库有 5 个，只显示 4 个，也不能往下滑」，
  // 根因就是这次共用：右栏只想给本会话挑一个人设，却继承了主页面留下的「未使用」筛选
  // —— 正在用的那 1 个被过滤掉，剩 4 个（2 行）不足一屏，于是既看不到第 5 个、也没有
  // 滚动条，看上去像被裁掉了。
  // 实测（无头浏览器 + CDP 量真实布局）：#bp-setup-scroll（.bp-scroll）的
  // overflow-y:auto 与 flex 高度链都正常，8 张卡时 scrollHeight 878 > clientHeight 621、
  // scrollTop 能滚到底 —— 容器本身没有问题，纯粹是筛选把条目藏了。
  // 修法：compact（会话设置右栏）不参与全局筛选，永远按「全部」渲染；筛选条也不显示。
  const effFilter = compact ? 'all' : personasFilter;
  const list = all.filter((x) => {
    if (effFilter === 'on') return personaIsCurrent(x.id);
    if (effFilter === 'off') return !personaIsCurrent(x.id);
    return true;
  });
  // 两个"覆盖全局"的隐形层，必须在**切换的地方**报出来 —— 设置页已经报过，
  // 但用户是在这一页按开关的。不报的话，他切完发现那几个会话/主人那边行为没变，
  // 只会觉得"这个开关坏了"。判定口径与 06-settings-render.js 的摘要卡完全一致：
  //   ① personaByChat：personaForChat 逐会话合并，优先级高于全局
  //   ② owner-identity 插件：主人发言时 persona = ownerPersona || personaForChat(...)
  const perChat = (state.config && state.config.personaByChat) || {};
  const perChatActive = Object.values(perChat)
    .filter((v) => v && (v.roleText || v.participation || v.customRules || v.systemPromptOverride)).length;
  const ownerCfg = ((state.config && state.config.skills) || {})['owner-identity'] || {};
  const ownerOn = ownerCfg.personaEnabled === true && !!String(ownerCfg.personaRoleText || '').trim();
  // 第三个隐形层：覆盖了系统提示词、但没留 {roleText} 占位符。
  // buildSystemPrompt 的 override 分支是「整段替换」再 replaceAll('{roleText}', ...)，
  // 所以占位符不在 = 人设正文根本没有注入点 —— 在这页怎么切都没反应，
  // 而且界面上一切正常（开关会动、卡片会换），最难自查的一种。
  const overrideText = String((state.config && state.config.persona && state.config.persona.systemPromptOverride) || '').trim();
  const overrideNoRole = !!overrideText && overrideText.indexOf('{roleText}') < 0;

  // 2026-10-22 第三版：与插件卡**同构**。
  //   上一版虽然用了 .mcard，但把操作放成了底部一整行文字钮，于是：
  //   ① .mcard-state 的 margin-left:auto 把「使用中」推到卡片最右，和名称之间
  //      拉开一大段（插件卡的「生效中」是紧跟版本号的）；
  //   ② 多一条分隔线 + 一行按钮，卡片比插件卡高一截。
  //   用户一眼就看出"样式不一样"。现在改成插件卡那套：右侧图标（预览 + 开关），
  //   删除放右下角，卡片高度和插件卡完全一致。
  // 2026-10-23：第四处破相 —— 「全局人设 · 所有会话共用」当时独占卡片第 4 行，
  //   于是"使用中"的人设卡比同页其他人设卡、比插件卡高一截（用户截图对比
  //   记忆系统插件卡后指出"卡片大小不一致"）。已改为 .mcard-dir 行内后缀标签
  //   （.ps-global-tag，hover 看完整解释），结构回到"标题 + 简介（固定两行）
  //   + 元信息单行"三件套。**教训：这套卡片的等高是硬约定，任何"觉得重要就
  //   再加一行"都会破相 —— 新信息一律并入既有行或收进 hover。**
  //   开关语义：开 = 用这个人设，关 = 回落到内置默认（人设是单选，没有"都关掉"）。
  // 齿轮：编辑自定义人设。造型与插件卡那颗完全一致（06-settings-render.js 的 GEAR_SVG）。
  const GEAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="3.2"/>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
    + '</svg>';
  const EYE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M1.8 12S5.4 5.6 12 5.6 22.2 12 22.2 12 18.6 18.4 12 18.4 1.8 12 1.8 12z"/>'
    + '<circle cx="12" cy="12" r="3.1"/>'
    + '</svg>';
  const TRASH_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
    + '<path d="M3 6h18"/>'
    + '<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>'
    + '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'
    + '<path d="M10 11v6"/><path d="M14 11v6"/>'
    + '</svg>';
  const cards = list.map((x) => {
    const isCur = personaIsCurrent(x.id);
    // 描述取正文前 120 字。**先剥掉 Markdown 标记**：人设卡正文普遍以
    // "# 角色卡：… ## 一、你是谁" 开头，原样塞进小卡会满屏 # 和 **，
    // 而这里要的是"一眼看出这是谁"，不是原文。
    const desc = String(x.text)
      .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')   // 行首标题井号
      .replace(/\*\*|__/g, '')                // 粗体标记
      .replace(/^[ \t]*[-*+][ \t]+/gm, '')    // 行首列表符号
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return `
      <div class="mcard mcard-big persona-card${isCur ? ' mcard-on' : ''}"
           data-ps-card="${esc(x.id)}" role="button" tabindex="0"
           title="${isCur ? '正在使用这个人设 · 点击预览' : '点击预览'}">
        <div class="mcard-info">
          <div class="mcard-title-line">
            <span class="mcard-name">${esc(x.name)}</span>
            <span class="skill-card__ver" title="${esc(PERSONA_SRC[x.source].tip)}">${esc(PERSONA_SRC[x.source].label)}</span>
            <span class="mcard-state">${isCur ? '使用中' : ''}</span>
          </div>
          <div class="mcard-desc">${esc(desc || '（正文为空）')}</div>
          <div class="mcard-dir">≡ ${esc(personaFmtLen(x.text.length))}</div>
          ${isCur ? `<div class="ps-global-note" title="这是**全局**人设：所有没单独配置人设的会话都用它。单独配过的那几个不受影响，页头会提示数量。">全局人设 · 所有会话共用</div>` : ''}
        </div>
        <div class="mcard-acts">
          <button class="mcard-gear" type="button" data-ps-preview="${esc(x.id)}" title="预览正文" aria-label="预览 ${esc(x.name)}">${EYE_SVG}</button>
          ${x.builtin ? '' : `<button class="mcard-gear" type="button" data-ps-edit="${esc(x.id)}" title="编辑这个人设（改名称 / 正文 / 附加规则）" aria-label="编辑 ${esc(x.name)}">${GEAR_SVG}</button>`}
          <label class="mcard-sw" title="${isCur ? '正在使用 —— 关闭会回落到内置默认人设' : '使用这个人设'}">
            <input type="checkbox" class="sw" data-ps-use-sw="${esc(x.id)}" ${isCur ? 'checked' : ''} />
          </label>
        </div>
        ${x.builtin ? '' : `<button class="mcard-del" type="button" data-ps-del="${esc(x.id)}" title="删除这个人设" aria-label="删除 ${esc(x.name)}">${TRASH_SVG}</button>`}
      </div>`;
  }).join('');

  // 外层容器照抄插件页：.usage-wrap（max-width 940 居中）→ .usage-head → 网格。
  // 这不是"抄着好看"—— 插件页就是这套，容器不同则卡片宽度、左边距、滚动行为全变，
  // 同一套 .mcard 会长成两个样子。
  // 状态筛选条：与插件页 .mod-filters 同款写法（选中态用主题强调色内联，
  // 不新增一次性 CSS）。人设只有"使用中 / 未使用"两态，所以是三档不是四档。
  const filterBar = `<div class="mod-filters" style="display:flex;gap:8px;margin:0 0 12px">`
    + [
        { id: 'all', label: '全部', n: all.length },
        { id: 'on', label: '使用中', n: onCount },
        { id: 'off', label: '未使用', n: all.length - onCount }
      ].map((f) => `<button type="button" class="btn btn-small" data-ps-filter="${f.id}"`
        + (f.id === personasFilter ? ' style="background:var(--accent);color:#fff;border-color:var(--accent)"' : '')
        + `>${f.label} ${f.n}</button>`).join('')
    // 2026-10-23：显式标出"当前显示几个 / 一共几个"。
    // 反馈来源：用户说「人设库里有 5 个，只显示 4 个，还不能往下滑」。
    // 实测（无头浏览器量真实布局）：.usage-pane 的滚动本身正常 —— 8 张卡时
    // scrollHeight 878 > clientHeight 621，scrollTop 能滚到底。真正会"少一个"
    // 的是筛选：切到「未使用」后，正在用的那 1 个被过滤掉，剩 4 个不足一屏，
    // 于是既看不到第 5 个、也没有滚动条，看上去像"被裁掉了"。
    // 这行字让"筛选导致的减少"和"渲染丢失"一眼可辨。
    + `<span class="hint" style="margin-left:auto;white-space:nowrap">当前显示 ${list.length} / 共 ${all.length}${
        list.length < all.length ? `（已按「${personasFilter === 'on' ? '使用中' : '未使用'}」筛选）` : ''}</span>`
    + '</div>';

  // 尾注：与技能页（共注册 N 个工具）/ 插件页（共提供 N 个能力）同一套版式。
  // 人设没有"能力/工具"这种可枚举的东西，最有用的是**体量**：正文会整段注入
  // 系统提示词，字数直接换算成 token —— 用户能一眼看出哪一类人设"重"。
  // 统计一律按全量 all，不随筛选变。
  const bySrc = { builtin: [], market: [], custom: [] };
  for (const x of all) bySrc[x.source].push(x);
  const sumLen = (arr) => arr.reduce((s, x) => s + x.text.length, 0);
  const footer = all.length ? `
      <h3 class="usage-h3">这 ${all.length} 个人设合计 ${esc(personaFmtLen(sumLen(all)))}</h3>
      <div class="hint" style="margin-bottom:6px">人设正文会<b>整段注入系统提示词</b> —— 字越多占的 token 越多；短了又撑不起性格，按需取舍。</div>
      <div class="tool-meta" style="gap:6px">${Object.entries(bySrc)
        .filter(([, arr]) => arr.length)
        .map(([k, arr]) => `<span class="tool-dep" title="${esc(PERSONA_SRC[k].tip)}">${esc(PERSONA_SRC[k].label)} ${arr.length} 个 · ${esc(personaFmtLen(sumLen(arr)))}</span>`)
        .join('')}</div>` : '';

  box.innerHTML = `
    <div class="usage-wrap">
      <div class="usage-head">
        <h2>人设</h2>
        <div class="usage-days">
          <span class="uc-tag" title="共 ${all.length} 个人设，其中 ${onCount} 个正在使用">${onCount} / ${all.length} 使用中</span>
          <button class="btn btn-small" type="button" data-ps-gomarket title="去人设市场装新的">去市场</button>
          <button class="btn btn-small" type="button" data-ps-add title="自己写一个人设（也可以把 .txt 拖进弹窗）">＋ 添加人设</button>
          <button class="btn btn-small" type="button" data-ps-refresh title="重新读取人设列表">刷新</button>
        </div>
      </div>
      <div class="hint" style="margin-bottom:10px">
        ${cur
          ? `现在用的是「<b>${esc(cur.name)}</b>」。右侧开关打开即切换，不用重启。`
          : '当前还没有应用任何人设，用的是内置默认。'}
      </div>
      <!-- 说明折叠条：与技能 / 插件页同一个组件（原生 <details>，无 JS、键盘与读屏天然可用）。
           收起来只占一行，展开才铺开解释 —— 顶部不再吃视口。 -->
      <details class="module-note">
        <summary>
          <svg class="mn-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.4 2.4 8 6l-3.6 3.6" /></svg>
          <span class="mn-t">人设是纯文本 —— 换的是它怎么说话，不改能力</span>
        </summary>
        <div class="hint mn-body">
          人设只决定<b>语气、身份和说话方式</b>，不会改变它能做什么：技能和插件照旧，装了什么就有什么。<br />
          <b>同一时间只有一个生效</b>：打开某张卡的开关就切过去，关掉会回落到内置默认。<br />
          来源分三种：<b>内置</b>（随应用提供）、<b>市场</b>（从「人设下载」装的）、<b>自定义</b>（自己写的，可以删）。<br />
          <b>换人设不影响</b>配了独立人设的会话和「主人专属人设」—— 那两层优先级更高，命中时下面会单独提示。
        </div>
      </details>
      ${perChatActive ? `<div class="hint" style="color:var(--orange);margin:0 0 12px">⚠️ 有 <b>${perChatActive}</b> 个会话配了独立人设（优先级高于全局）—— 在这里切换对它们<b>不生效</b>，要改得去那个会话的设置里改。</div>` : ''}
      ${ownerOn ? '<div class="hint" style="color:var(--orange);margin:0 0 12px">⚠️ 主人识别插件已启用「主人专属人设」—— 主人发言时优先用它，这里的切换对主人<b>不生效</b>。</div>' : ''}
      ${overrideNoRole ? '<div class="hint" style="color:var(--orange);margin:0 0 12px">⚠️ 你覆盖了<b>系统提示词</b>，但里面没有 <code>{roleText}</code> 占位符 —— 人设正文没有注入点，<b>在这里切换不会有任何效果</b>。去「设置 → 人设与记忆」把占位符加回去。</div>' : ''}
      ${filterBar}
      <div class="ps-grid">${cards || `<div class="empty-hint" style="grid-column:1/-1">${
        all.length ? '这一档里没有条目。' : '还没有任何人设 —— 去「人设下载」装一个，或点上面「＋ 添加人设」自己写一个。'
      }</div>`}</div>
      ${compact ? '' : footer}
    </div>`;
  if (keepScroll) box.scrollTop = prevTop;
}

/* ══════════════════════════════════════════════════════════════
   加载
   ══════════════════════════════════════════════════════════════ */
/**
 * 拉人设模板 + 相关 config 字段，写回 state。**不碰任何 DOM。**
 * 人设页（#personas-page）和会话设置右栏（#bp-setup-scroll）共用它 ——
 * 两边各自只负责渲染，数据这一份逻辑不要写两遍。
 */
async function refreshPersonaData() {
  const [tplData, cfg] = await Promise.all([
    api('/api/persona-templates'),
    api('/api/config')
  ]);
  const map = {};
  for (const t of ((tplData && tplData.templates) || [])) {
    // customRules 必须带上：personaForChat 是**逐字段合并**（roleText / customRules /
    // systemPromptOverride / participation），切换时只写 roleText 会让上一个人设的
    // 附加规则残留下来，两套设定串味。设置页的「选择人设」就是同步它的。
    map[t.id] = { name: t.name, text: t.text, builtin: !!t.builtin, customRules: t.customRules || '' };
  }
  state.personaTemplates = map;
  // GET /api/config 回的是**脱敏后的 config 本体**（不是 {config} 包一层）。
  // 只摘需要的字段回填，不整体覆盖 state.config —— sanitizeConfig 会把 apiKey
  // 等换成掩码，整包覆盖会让别处读到假值。
  // personaByChat / skills 是页头那两条覆盖警告要用的，一并带上。
  if (cfg && typeof cfg === 'object') {
    state.config = state.config || {};
    if (cfg.persona) state.config.persona = cfg.persona;
    if (Array.isArray(cfg.customPersonas)) state.config.customPersonas = cfg.customPersonas;
    if (cfg.personaByChat) state.config.personaByChat = cfg.personaByChat;
    if (cfg.skills) state.config.skills = cfg.skills;
  }
  return map;
}

/** 人设统计（供会话设置左栏那一条用）：共几个、几个在用。 */
function personaStatOf() {
  const list = personaInstalledList();
  return { total: list.length, on: personaCurrentId() ? 1 : 0 };
}

async function loadPersonasPage(opts) {
  const force = !!(opts && opts.force);
  const compact = !!(opts && opts.compact);
  const box = (opts && opts.box) || document.getElementById('personas-page');
  if (!box) return;
  personasHost = box;
  bindPersonasPage(box);

  const hasCache = Object.keys((typeof state !== 'undefined' && state.personaTemplates) || {}).length > 0;
  if (!hasCache) {
    box.innerHTML = '<div class="mk-empty"><span class="mk-spin"></span>正在读取人设…</div>';
  } else if (!force) {
    renderPersonasPage({ box: box, compact: compact });   // 有缓存先出页，后台再对齐
  }

  try {
    await refreshPersonaData();
  } catch (e) {
    if (!hasCache) {
      box.innerHTML = `<div class="mk-empty mk-err">读取人设失败：${esc(e && e.message ? e.message : e)}` +
        '<br><button class="btn" type="button" data-ps-refresh>重试</button></div>';
      return;
    }
  }
  // 人设页：切走就别重画了；会话设置右栏（box 不是 #personas-page）不看 state.tab
  if (box.id === 'personas-page' && state.tab !== 'personas') return;
  renderPersonasPage({ box: box, compact: compact });
}

/* ══════════════════════════════════════════════════════════════
   交互
   ══════════════════════════════════════════════════════════════ */
function bindPersonasPage(host) {
  const box = host || personaHostEl();
  if (!box || box.dataset.psBound === '1') return;
  box.dataset.psBound = '1';
  // 容器本身不会被 innerHTML 替换（只换它的子节点），所以委托绑一次就够
  box.addEventListener('click', (e) => {
    // 状态筛选（全部 / 使用中 / 未使用）
    const flt = e.target.closest('[data-ps-filter]');
    if (flt) {
      if (personasFilter !== flt.dataset.psFilter) {
        personasFilter = flt.dataset.psFilter;
        renderPersonasPage();
      }
      return;
    }
    if (e.target.closest('[data-ps-refresh]')) { loadPersonasPage({ force: true }); return; }
    // 与插件页头部同款的另两颗钮：去市场装新的 / 自己写一个
    if (e.target.closest('[data-ps-gomarket]')) { switchTab('personamarket'); return; }
    if (e.target.closest('[data-ps-add]')) { personaAddNew(); return; }
    const prev = e.target.closest('[data-ps-preview]');
    if (prev) { personaPreviewInstalled(prev.dataset.psPreview, prev); return; }
    const ed = e.target.closest('[data-ps-edit]');
    if (ed) { personaEditInstalled(ed.dataset.psEdit); return; }
    const del = e.target.closest('[data-ps-del]');
    if (del) { personaDeleteInstalled(del.dataset.psDel); return; }
    // 开关区域交给 change 处理，别再冒泡成"点卡片开预览"
    if (e.target.closest('.mcard-sw')) return;
    // 点卡片空白处 = 预览。上面几类都已拦掉，走到这里的都不是控件。
    const cardEl = e.target.closest('[data-ps-card]');
    if (cardEl) { personaPreviewInstalled(cardEl.dataset.psCard, cardEl); return; }
  });
  // 使用开关：开 = 换成它，关 = 回落到内置默认（见 personaToggleUse 注释）
  box.addEventListener('change', (e) => {
    const sw = e.target.closest && e.target.closest('[data-ps-use-sw]');
    if (sw) personaToggleUse(sw.dataset.psUseSw, sw.checked);
  });
  // 卡片是 role=button + tabindex=0（照 .mcard 的既有约定），键盘也要能开
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const cardEl = e.target.closest && e.target.closest('[data-ps-card]');
    // 只在卡片本身聚焦时接管；焦点在里面的按钮/开关上时交给浏览器自己处理
    if (cardEl && e.target === cardEl) {
      e.preventDefault();
      personaPreviewInstalled(cardEl.dataset.psCard, cardEl);
    }
  });
}

/**
 * 「＋ 添加人设」：复用设置页那个新建弹窗（支持把 .txt/.md 拖进去自动读取）。
 *
 * ⚠️ 四个选择器都刻意指向**不存在**的元素：
 *    弹窗默认会把新内容填回设置页的「角色设定 / 附加规则」文本框并派发 input
 *    触发自动保存 —— 如果用户刚从设置页切过来、那里还开着正在编辑的内容，
 *    就会把人家写了一半的东西覆盖掉。这页本来也没有编辑器可填，直接指向空气；
 *    弹窗内部对 null 都有保护，不会报错。
 *    提示也走不到页面上（hintSel 是空的），所以成功反馈由 onDone 里的 toast 负责。
 */

/**
 * 「齿轮」：编辑这条自定义人设（名称 / 正文 / 附加规则）。
 *
 * 复用设置页那个新建弹窗的编辑模式（传 editId）—— 同一套字段、同一套拖文件读取，
 * 不另写一个只差三个输入框的弹窗。
 * ⚠️ 四个选择器同样指向不存在的元素：这页没有"角色设定"编辑器可填，
 *    不能让编辑结果灌进设置页那边正在写的东西里（与 personaAddNew 同一个理由）。
 * ⚠️ 只对自定义人设开放：内置人设的正文写死在 src/personas.js，后端也只认 custom_N。
 */
function personaEditInstalled(id) {
  const tpl = state.personaTemplates && state.personaTemplates[id];
  if (!tpl) return;
  if (tpl.builtin) { personaToast('内置人设不能改，可以「＋ 添加人设」另存一份再改', 'warn'); return; }
  openPersonaCreateModal({
    editId: id,
    roleSel: '#ps-no-editor',
    rulesSel: '#ps-no-editor',
    pickSel: '#ps-no-editor',
    hintSel: '#ps-no-editor',
    onDone: () => {
      personaToast(`「${tpl.name}」已保存`, 'ok');
      loadPersonasPage({ force: true });
    }
  });
}

function personaAddNew() {
  openPersonaCreateModal({
    roleSel: '#ps-no-editor',
    rulesSel: '#ps-no-editor',
    pickSel: '#ps-no-editor',
    hintSel: '#ps-no-editor',
    onDone: () => {
      personaToast('人设已添加', 'ok');
      loadPersonasPage({ force: true });
    }
  });
}

/** 预览：正文已经在本地，不用再请求；浮层与市场页共用同一个单例。 */
function personaPreviewInstalled(id, trigger) {
  const tpl = state.personaTemplates && state.personaTemplates[id];
  if (!tpl) return;
  const isCur = personaIsCurrent(id);
  openPersonaPreview({
    title: tpl.name || id,
    text: tpl.text || '',
    author: '',
    trigger,
    // 使用中的那个不用再给「使用」，否则按钮点下去什么都不会变
    action: isCur ? null : { label: '使用这个人设', onClick: () => personaUseInstalled(id, null) }
  });
}

/**
 * 把人设模板应用成「当前全局人设」的 patch。
 *
 * ⚠️ customRules 只在模板**自带**规则时才写。这是 2026-10-16 修过的坑：
 *   内置人设没有 rules，无条件 `customRules: ''` 会把用户手写的「管理员附加规则」
 *   静默抹掉；反过来，切换时**完全不写**又会让上一个人设的规则残留
 *   （personaForChat 是逐字段合并，roleText 换了、customRules 还留着旧的）。
 *   与设置页「选择人设」同口径：有才覆盖，没有就保留用户的值。
 */
function personaApplyPatch(tpl) {
  const patch = { persona: { roleText: String(tpl.text || '') } };
  const rules = String(tpl.customRules || '').trim();
  if (rules) patch.persona.customRules = rules;
  return patch;
}

async function personaUseInstalled(id, btn) {
  if (personasSwitching) return;
  const tpl = state.personaTemplates && state.personaTemplates[id];
  if (!tpl) return;
  const prevId = personaCurrentId();
  const prevName = ((state.personaTemplates && state.personaTemplates[prevId]) || {}).name;
  const old = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '切换中…'; }
  personasSwitching = true;
  try {
    // 只改 persona 下的字段（后端 updateConfig 是深合并 patch），刻意不动 botName ——
    // 名字是账号身份，@ 判定与存档称呼都依赖它。
    await api('/api/config', { method: 'POST', body: JSON.stringify(personaApplyPatch(tpl)) });
    if (state.config && state.config.persona) {
      state.config.persona.roleText = tpl.text;
      if (tpl.customRules) state.config.persona.customRules = tpl.customRules;
    }
    personaToast(
      prevId && prevId !== id
        ? `已换成「${tpl.name}」，「${prevName || '原人设'}」已自动关闭`
        : `已换成「${tpl.name}」`,
      'ok'
    );
    renderPersonasPage({ keepScroll: true });
  } catch (e) {
    personaToast(`切换失败：${e && e.message ? e.message : e}`, 'err');
    if (btn) { btn.disabled = false; btn.textContent = old; }
  } finally {
    personasSwitching = false;
  }
}

/**
 * 卡片右侧那颗「使用」开关。
 *
 * 开 = 换成这个人设；关 = **回落到内置默认**。
 * 为什么关不是"变成没人设"：人设是单选，roleText 必须有值 —— 留空的话
 * 机器人会带着一段空设定说话，比"用回默认"糟得多。内置默认取 xiaojingyu，
 * 与「选择人设」弹窗里删掉正在使用的人设时的回落口径完全一致。
 */
async function personaToggleUse(id, checked) {
  if (personasSwitching) return;            // 上一次切换还没回来，忽略这次点击
  const tpl = state.personaTemplates && state.personaTemplates[id];
  if (!tpl) return;
  const next = checked ? tpl : (state.personaTemplates && state.personaTemplates.xiaojingyu);
  if (!next) {
    personaToast('没有可回落的内置人设', 'err');
    renderPersonasPage();          // 把开关画回去
    return;
  }
  // 记下"原来是哪一个"，用来在提示里明说"它已经自动关了" —— 单选语义要讲出来，
  // 否则用户看到另一个开关自己弹回去，会以为点错了。
  const prevId = personaCurrentId();
  const prevName = ((state.personaTemplates && state.personaTemplates[prevId]) || {}).name;
  // 正文与当前人设完全相同的另一份（用户把同一个 txt 导了两次）：
  // 打开它不会改变 roleText，重画后亮的仍是第一个 —— 不解释的话用户只会看到
  // "开关自己弹回去了"。这里直接说清，不做无效 POST。
  if (checked && prevId && prevId !== id && String(tpl.text || '').trim() === personaCurrentText()) {
    personaToast(`「${tpl.name}」的正文和当前人设完全相同，切换不会有变化`, 'warn');
    renderPersonasPage();
    return;
  }
  personasSwitching = true;
  try {
    await api('/api/config', { method: 'POST', body: JSON.stringify(personaApplyPatch(next)) });
    if (state.config && state.config.persona) {
      state.config.persona.roleText = next.text;
      if (next.customRules) state.config.persona.customRules = next.customRules;
    }
    personaToast(
      checked
        ? (prevId && prevId !== id
            ? `已换成「${tpl.name}」，「${prevName || '原人设'}」已自动关闭`
            : `已换成「${tpl.name}」`)
        : `已回落到「${next.name || '内置默认'}」`,
      'ok'
    );
    renderPersonasPage({ keepScroll: true });
  } catch (e) {
    personaToast(`切换失败：${e && e.message ? e.message : e}`, 'err');
    renderPersonasPage();          // 失败要把开关状态画回去
  } finally {
    personasSwitching = false;
  }
}

async function personaDeleteInstalled(id) {
  const tpl = state.personaTemplates && state.personaTemplates[id];
  if (!tpl) return;
  const ok = await qaConfirm({
    danger: true,
    title: '删除人设',
    message: `确定删除「${tpl.name}」？\n\n删除后不可恢复。如果它正在被使用，角色设定会回落到内置默认。`,
    confirmText: '删除',
    cancelText: '取消'
  });
  if (!ok) return;
  try {
    await api(`/api/persona-templates/${encodeURIComponent(id)}`, { method: 'DELETE', body: '{}' });
    // 删的正好是当前在用的那个 → 回落到内置默认（与 08-modals.js 同口径）
    if (personaIsCurrent(id)) {
      const fallback = state.personaTemplates && state.personaTemplates.xiaojingyu;
      if (fallback) {
        await api('/api/config', { method: 'POST', body: JSON.stringify({ persona: { roleText: fallback.text } }) })
          .catch(() => { /* 回落失败不阻塞列表刷新：至少人设已经删掉了 */ });
      }
    }
    await loadPersonasPage({ force: true });
  } catch (e) {
    personaToast(`删除失败：${e && e.message ? e.message : e}`, 'err');
  }
}

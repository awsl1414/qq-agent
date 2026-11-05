// 〔信息架构 · 照原型 v2〕，一级 5 项 / 左栏每页一份 / 全屏页
'use strict';
/* ══════════════════════════════════════════════════════════════
 原型 v2 与 0.4.5 的差别只在外壳，不在数据：
   · 9 个页面（sessions/chats/memory/usage/skills/plugins/harness/connection/
     settings）两边同名，16 个渲染器一行不用改；
   · 差的是一级入口（9 平铺 → 5 平铺）、左栏（无 → 每页一份）、
     会话首页（列表+聊天 → PCL 启动页）+ 聊天进全屏页。

 本段是唯一的新增逻辑层，做法是包裹而不是改写：
   · switchTab 是全局函数声明（00-core.js），这里换成 wrapper，
     每次切页后同步顶栏高亮 / 左栏 / 全屏页，00-core 本体零改动；
   · 二级导航项复用 .tab 契约：带 data-tab 即可被 switchTab 认知，
     但不加 .tab 类，避免吃到顶栏胶囊样式与 $$('.tab') 的 active 覆盖。
 ══════════════════════════════════════════════════════════════ */
(function () {
  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ── 信息架构表（与 index.html 顶栏 6 项一一对应）───────────────── */
  var GROUPS = [
    { key: 'sessions', label: '会话', home: 'sessions', subs: ['sessions', 'chats', 'memory'] },
    { key: 'usage',    label: '用量', home: 'usage',    subs: ['usage'] },
    // 「下载」页左栏分两段：市场（装新的）/ 已安装（管已装的）。
    // 已安装段直接落到带开关的 #view-skills / #view-plugins；市场卡片上那颗绿钮
    // 是「管理」，点了跳过去并高亮那一张卡（见 16-market.js）。
    // subs 仍含 skills/plugins：groupOfTab 靠它把 switchTab('skills'/'plugins')
    // 归到本组，否则顶栏高亮会掉回「会话」。
    { key: 'ext',      label: '下载', home: 'skillmarket',
      subs: ['skills', 'plugins', 'personas', 'skillmarket', 'pluginmarket', 'personamarket'],
      navSubs: ['skillmarket', 'pluginmarket', 'personamarket', 'skills', 'plugins', 'personas'] },
    // home 决定点一级入口先进哪个页，subs 顺序决定左栏排列，两处一起改。
    // 萌新点「工具」绝大多数是去看机器人连上没有、该怎么装协议端，
    // harness（自检 + 对话审查）是进阶排查工具，所以连接在前。
    // 桌宠与另两项同为"机器人跑不跑得起来 / 长什么样"的杂务，放在这里。
    { key: 'ops',      label: '工具', home: 'connection', subs: ['connection', 'harness', 'logs', 'desktop-pet'] },
    // 壁纸页（内置壁纸模块 src/wallpaper）是独立一级入口。
    // settings 组的左栏渲染被 syncChrome 关掉了（设置页用自己那份 #settings-sidebar），
    // 所以写在 settings 的 subs 里左栏永远画不出「壁纸」，整页等于没有入口。
    // 提成一级之后：顶栏点「壁纸」直接进页，左栏不需要（见 syncChrome 的 is-none）。
    { key: 'wallpaper', label: '壁纸', home: 'wallpaper', subs: ['wallpaper'] },
    // groupOfTab 找不到归属会回退成「会话」组，顶栏高亮会掉到会话上，所以必须登记。
    { key: 'settings', label: '设置', home: 'settings', subs: ['settings'] }
  ];
  var SUB_LABEL = {
    sessions: '会话', chats: '存档', memory: '记忆', usage: '用量', skills: '技能',
    plugins: '插件', skillmarket: '技能下载', pluginmarket: '插件下载', personamarket: '人设下载',
    // 技能/插件管开关，人设管"用哪一个"，三者是同一层的东西，都挂在「已安装」下。
    personas: '人设',
    // 英文 harness 对小白等于没有指引，页内多模块由子页签自己呈现，
    // 入口名只负责"看病查问题"。hover 说明走 navItemHtml 里给 harness 加的 title。
    harness: '自检', connection: '连接', settings: '设置',
    // 完整日志（按级别 / 模块 / 关键字筛，能翻磁盘历史）独立成一页；
    // 连接页那个「应用日志」面板原先只留最近 200 条，现已移除，日志只剩这一页。
    logs: '日志',
    'desktop-pet': '桌宠'
  };
  var SUB_ICON = {
    // 与「会话选择」全屏页「页面」三项的图标对齐同一套设计（会话=双气泡 /
    // 存档=归档箱 / 记忆=数据库圆柱），避免同一概念在两侧长成两副样子。
    sessions: 'M5 4 h5 a2 2 0 0 1 2 2 v3 a2 2 0 0 1 -2 2 h-5 a2 2 0 0 1 -2 -2 v-3 a2 2 0 0 1 2 -2 z M14 13 h5 a2 2 0 0 1 2 2 v3 a2 2 0 0 1 -2 2 h-5 a2 2 0 0 1 -2 -2 v-3 a2 2 0 0 1 2 -2 z',
    chats: 'M2 4h20v4H2z M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8 M10 12h4',
    memory: 'M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3z M3 6v12c0 1.66 4.03 3 9 3s9-1.34 9-3V6 M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3',
    skills: 'M12 3l2.2 5.4L20 10l-5.8 1.6L12 17l-2.2-5.4L4 10l5.8-1.6z',
    plugins: 'M10 4h4v3a2 2 0 1 0 4 0h2v6h-3a2 2 0 1 0 0 4h3v3H7v-3a2 2 0 1 0 0-4H4V7h3a2 2 0 1 0 3 0z',
    // 市场：下载箭头入库
    skillmarket: 'M12 4v10M8 10l4 4 4-4M5 18h14',
    pluginmarket: 'M12 4v10M8 10l4 4 4-4M5 18h14',
    // 人设市场不能沿用上面那枚下载箭头：技能/插件/人设三个并列时，
    // 同一个图标出现三次等于没有区分度。用一枚人形（头 + 肩），与"人设"字面对上。
    personamarket: 'M12 10.6a3.3 3.3 0 1 0 0-6.6 3.3 3.3 0 0 0 0 6.6zM4.8 19.5c.9-3.2 3.7-5 7.2-5s6.3 1.8 7.2 5',
    // 「已安装的人设」也刻意不用 personamarket 那枚单人形：两者在左栏上下紧挨着。
    // 改成「人形 + 右侧三条列表线」，左边是"这一个人"，右边是"一串"。
    personas: 'M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 19c.8-2.8 3.2-4.4 6-4.4s5.2 1.6 6 4.4M17 7h4M17 11h4M17 15h4',
    harness: 'M12 3v4M12 17v4M3 12h4M17 12h4M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
    // 日志：一页纸 + 三条文本行。与「存档」的三横线区别在左上的折角，
    // 一眼能认出「这是一份文件」，不会被当成列表。
    logs: 'M6 3h8l4 4v14H6z M14 3v4h4 M9 12h6M9 15h6M9 18h3',
    // 壁纸（内置壁纸模块 src/wallpaper）：相框 + 里面一座山。
    wallpaper: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7.5 10.2a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2z M3 16.5l4.8-4.3a1.6 1.6 0 0 1 2.1 0L15 17M13.2 14.6l2.6-2.3a1.6 1.6 0 0 1 2.1 0L21 15.5',
    // 桌宠（desktop-pet 插件）：与 index.html 顶栏那枚「猫头」同一套路径。
    'desktop-pet': 'M4 11l1.4-6 4.6 3h4l4.6-3L20 11v3a6 6 0 0 1-6 6h-4a6 6 0 0 1-6-6z M9.2 14h.01M14.8 14h.01',
    connection: 'M12 3v18M4 7l16 10M20 7L4 17',
    /* 与顶栏导航「设置」项（index.html #tabs 的 data-top="settings"）同一枚图标。
       它是两段 path（内圆 + 齿轮外圈）；只抄第一段内圆的话，15px 下会渲染成
       4.4px 的小圈，看着像个列表圆点。 */
    settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.56 1.03z'
  };
  /* 「用量」是单页，左栏照 PCL 做成本页分块的导航。
     点哪一项就只显示哪一块（早先三块同时铺在同一个滚动区里，点左栏只是推一下
     滚动条，画面里的三张图一张没少）。
     dim 取值必须与 04-archive-usage.js 里 [data-block] 的三个值逐字一致。 */
  var USAGE_ANCHORS = [
    { dim: 'days',   label: '按天',   icon: 'M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-3' },
    { dim: 'chats',  label: '按会话', icon: 'M4 5h16v11H8l-4 4z' },
    { dim: 'models', label: '按模型', icon: 'M4 7h16M4 12h10M4 17h7' },
    // 插件维度（token 归因）。dim 必须与 04-archive-usage.js 里
    // [data-block="plugins"] 与 style.css 的 data-udim 选择器逐字一致。
    { dim: 'plugins', label: '按插件', icon: 'M4 8h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 17h7v3H4z' }
  ];
  var usageDim = 'days';     // 用户选中的维度（对齐原型 usageAnchor 默认 usage-day）
  /* ══════════ 全屏页 · 会话设置（真·按会话）══════════
     这一页只放"能按单个会话覆盖"的项（白名单归属 / 人设覆盖 / 响应档位 /
     指令禁言 / 群成员屏蔽），全局默认值仍只属于导航栏「设置」页，两页不重复。
     全局页那边不动：设置→人设的「分会话按钮网格」、设置→聊天→活跃设置里的
     分群档位，是"跨会话批量管理"的入口，语义上属于全局页。 */

  var setupChat = '';        // 当前正在配置的会话 chatKey（'' = 还没选）

  /* ── 这一页左栏的「视图」────────────────────────────────────
     'chat'  = 按会话的设置（默认，正文）
     'skill' / 'plugin' = 本机已安装的技能 / 插件（卡片 + 开关）
     对应 PCL 的「启动页『版本设置』 → 左栏『Mod 管理』 → 列表」，
     所以入口做在左栏、列表出在右栏（同一页切换，不跳页）。 */
  var setupView = 'chat';

  /* 左栏「扩展」两项右侧的计数：本机已装几个 / 几个生效。
     取 state.skills（/api/skills 那一份），与「下载 → 技能 / 插件」页同源。
     kind 为 null（自定义根目录）归入技能，与 renderModulePage 的归类逐字一致，
     否则左栏说「技能 3 个」、点进去却列了 4 张卡。 */
  function extStatOf(kind) {
    var st = { total: 0, on: 0 };
    // 人设的数据源是 /api/persona-templates（state.personaTemplates），
    // 与技能/插件的 /api/skills 不是同一份，统计口径交给 19-personas.js 的
    // personaStatOf()，免得这里再算一遍、两边慢慢漂开。
    if (kind === 'persona') {
      try {
        if (typeof personaStatOf === 'function') return personaStatOf();
      } catch (e) { /* 未加载 → 显示 0 个 */ }
      return st;
    }
    try {
      var all = (typeof state !== 'undefined' && state.skills) || [];
      for (var i = 0; i < all.length; i++) {
        var s = all[i] || {};
        var k = s.kind == null ? 'skill' : s.kind;
        if (k !== kind) continue;
        st.total++;
        if (s.loaded && s.enabled && s.active) st.on++;
      }
    } catch (e) { /* state 还没就绪 → 显示 0 个，别抛 */ }
    return st;
  }
  /* 左栏那一条：图标与「下载」页左栏用的是同一份 SUB_ICON，认起来是一回事。
     aria-current 与 .on 同源（视觉高亮读屏读不到）。 */
  function extEntryHtml(kind, label, icon) {
    var st = extStatOf(kind);
    var on = setupView === kind;
    return '<button class="bp-act' + (on ? ' on' : '') + '" type="button" data-setup-ext="' + kind + '"' +
      (on ? ' aria-current="true"' : '') +
      ' title="' + label + '：本机已装 ' + st.total + ' 个，' + st.on + ' 个生效（点开管理开关）">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + icon +
      '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      '<span>' + label + '</span>' +
      // 人设是单选，"生效"这个词对不上，用"使用中"。技能/插件保持"生效"。
      '<span class="su-ext-n">' + st.total + ' 个 · ' + st.on + (kind === 'persona' ? ' 使用中' : ' 生效') + '</span></button>';
  }
  /* 进「技能 / 插件」时补拉一次 /api/skills。
     用户完全可能从没点过导航栏「下载」页，那时 state.skills 还是空的，
     左栏会写「技能 0 个 · 0 生效」、右栏一张卡都没有，看着像"东西被我弄丢了"。
     只在这一页仍停在同一个视图时回写：拉取期间用户可能已经改点会话或关页，
     不能把画面抢回来。extLoading 保证一次访问只拉一遍
     （renderSetupPane 会在筛选/开关后反复重渲染，次次都拉就成轮询了）。 */
  var extLoading = '';
  function refreshSetupExt(kind) {
    if (typeof loadSkillsStatus !== 'function') return;
    if (extLoading === kind) return;
    extLoading = kind;
    loadSkillsStatus().then(function () {
      if (!bigpage || bigpage.hidden || setupView !== kind) { extLoading = ''; return; }
      renderSetupNav();     // 左栏那两条的计数也要跟着更新
      // extLoading 要等这次重画结束再放开：renderSetupPane 内部又会调
      // refreshSetupExt，提前清空就成了"渲染→拉取→渲染→拉取"的轮询。
      renderSetupPane();
      extLoading = '';
    }).catch(function () { extLoading = ''; });
  }

  /* 标题条右侧那句话随视图换。 */
  function setSetupCrumb(view) {
    var el = $('#bp-crumb');
    if (!el) return;
    el.textContent = view === 'skill' ? '本机已安装的技能 · 开关全局生效'
      : view === 'plugin' ? '本机已安装的插件 · 开关全局生效'
        : view === 'persona' ? '本机已安装的人设 · 全局生效，同一时间只有一个'
          : '只对选中的这一个会话生效 · 全局设置在顶栏「设置」里';
  }

  function escH(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function cfgNow() {
    try { return (typeof state !== 'undefined' && state.config) || {}; } catch (e) { return {}; }
  }
  /* 'group:123' → { kind:'group', id:'123' } */
  function splitKey(chatKey) {
    var p = String(chatKey || '').split(':');
    return { kind: p[0] || '', id: p[1] || '' };
  }
  /* 会话群名 / 私聊备注名（拿不到返回空串）。state.chats 由 /api/chats 灌入。 */
  function chatNameOfKey(chatKey) {
    try {
      var list = (typeof state !== 'undefined' && state.chats) || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].key === chatKey) return String(list[i].chatName || '').trim();
      }
    } catch (e) { /* ignore */ }
    return '';
  }
  /* 左栏用：只要名字（拿不到才退回「群 123」）。左栏只有 216px，带上群号必被截断。 */
  function chatShortLabel(chatKey) {
    var nm = chatNameOfKey(chatKey), k = splitKey(chatKey);
    if (nm) return nm;
    if (k.kind === 'group') return '群 ' + k.id;
    if (k.kind === 'private') return '私聊 ' + k.id;
    return String(chatKey || '');
  }
  /* 右栏标题用：名字（群号） / 群 群号，既好认又能核对身份。 */
  function chatLabel(chatKey) {
    var nm = chatNameOfKey(chatKey), k = splitKey(chatKey);
    if (k.kind === 'group') return nm ? (nm + '（' + k.id + '）') : ('群 ' + k.id);
    if (k.kind === 'private') return nm ? (nm + '（' + k.id + '）') : ('私聊 ' + k.id);
    return String(chatKey || '');
  }
  /* ── 白名单键归一化 ──────────────────────────────────────────
     后端权威格式是裸号（src/app.js allowed() 直接 includes(String(id))，
     设置页表单、跨会话发送工具同样按裸号比对）。此前 setupChatList 用精确
     字符串去重、setAllowState 还写入带前缀的 chatKey，裸号与 group:号
     在左栏里各渲染一行，就是用户看到的"两个相同的群"。读取时一律归一化、
     写入时一律落裸号，两端格式不再分叉。 */
  function bareIdOf(entry) {
    var m = String(entry).match(/^(?:group|private):(.+)$/);
    return m ? m[1] : String(entry);
  }
  /* 白名单 → 规范 chatKey 集合（'group:123' / 'private:456'）。 */
  function allowMapOf() {
    var c = cfgNow(), map = {};
    ((c.allow || {}).groups || []).forEach(function (x) { map['group:' + bareIdOf(x)] = true; });
    ((c.allow || {}).private || []).forEach(function (x) { map['private:' + bareIdOf(x)] = true; });
    return map;
  }
  /* 可配置的会话清单：白名单(群 ∪ 私聊) 在前，state.chats 里其余的补在后面
     （标记 inAllow=false，用户可能在会话列表里看到一个还没加白名单的群）。 */
  function setupChatList() {
    var seen = {}, out = [];
    Object.keys(allowMapOf()).forEach(function (k) { if (k && !seen[k]) { seen[k] = 1; out.push({ key: k, inAllow: true }); } });
    try {
      (((typeof state !== 'undefined' && state.chats) || [])).forEach(function (ch) {
        if (ch && ch.key && !seen[ch.key]) { seen[ch.key] = 1; out.push({ key: ch.key, inAllow: false }); }
      });
    } catch (e) { /* ignore */ }
    return out;
  }
  /* 该会话的人设覆盖（后端 personaForChat 认两种键：纯 id 与 chatKey，这里也两种都查）。 */
  function personaConfOf(chatKey) {
    var c = cfgNow(), k = splitKey(chatKey), map = c.personaByChat || {};
    return map[String(k.id)] || map[String(chatKey)] || {};
  }
  function hasPersonaOwn(chatKey) {
    var p = personaConfOf(chatKey);
    return Boolean(p.roleText || p.participation || p.customRules || p.systemPromptOverride);
  }
  /* 该群单独档位（滑条位置 0~100）；没有单独设置返回 null。
     后端只有 store.unifiedTier === false 时才看 groupSliderPos（src/config.js 的 storeConfigForChat）。 */
  function groupSliderOf(chatKey) {
    var c = cfgNow(), k = splitKey(chatKey);
    var m = (c.store || {}).groupSliderPos || {};
    var v = m[String(k.id)];
    if (v === undefined || v === null) v = m[String(chatKey)];
    var n = Number(v);
    return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
  }
  var TIER_TEXT = { 1: '仅艾特', 2: '+关键词', 3: '+随机', 4: '全响应' };
  /* 该会话当前实际生效的档位摘要（含来源：本群单独 / 跟随全局）。 */
  function effectiveTierOf(chatKey) {
    var c = cfgNow(), st = c.store || {};
    var k = splitKey(chatKey);
    var unified = st.unifiedTier !== false;      // 默认统一
    var own = (!unified && k.kind === 'group') ? groupSliderOf(chatKey) : null;
    var pos = own !== null ? own : (Number.isFinite(Number(st.contextSliderPos)) ? Number(st.contextSliderPos) : 100);
    var t;
    try { t = (typeof sliderToTier === 'function' ? sliderToTier(pos) : { tier: 4, randomPercent: 100 }); }
    catch (e) { t = { tier: 4, randomPercent: 100 }; }
    // 峰谷开启时全局档位其实是两个点，全局摘要这里只做参考值，实际以活跃设置里的为准
    return { own: own !== null, pos: pos, tier: t.tier, randomPercent: t.randomPercent,
      unified: unified, peakOn: (st.peakSchedule || {}).enabled === true };
  }
  /* 指令禁言：该群是否处于禁言期（后端 commandMuteTier 同口径，仅群聊有意义）。 */
  function muteStateOf(chatKey) {
    var c = cfgNow(), k = splitKey(chatKey);
    var cm = c.commandMute || {};
    if (k.kind !== 'group' || !k.id) return { applicable: false };
    var until = Number((cm.active || {})[String(k.id)]);
    if (!Number.isFinite(until)) return { applicable: true, muted: false };
    if (until === 0) return { applicable: true, muted: true, manual: true };
    if (Date.now() < until) return { applicable: true, muted: true, until: until };
    return { applicable: true, muted: false, expired: true, until: until };
  }
  function blockedCountOf(chatKey) {
    var c = cfgNow(), k = splitKey(chatKey);
    var m = (c.blocklist || {})[String(k.id)] || (c.blocklist || {})[String(chatKey)] || [];
    return Array.isArray(m) ? m.length : 0;
  }
  /* 统一的 patch 提交口：POST /api/config 回 `{config}`，回写 state.config 供重渲染。 */
  function suSave(patch) {
    return api('/api/config', { method: 'POST', body: JSON.stringify(patch) }).then(function (r) {
      if (r && r.config) { try { state.config = r.config; } catch (e) { /* ignore */ } }
      return r;
    });
  }
  function suAlert(msg) {
    try { if (typeof qaAlert === 'function') { qaAlert(msg); return; } } catch (e) { /* ignore */ }
    console.warn('[setup] ' + msg);
  }

  function groupOfTab(name) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].subs.indexOf(name) >= 0) return GROUPS[i];
    }
    return GROUPS[0];
  }

  var sidebar = $('#sidebar');
  var sideLaunch = $('#side-launch');
  var sideNav = $('#side-nav');
  var panes = {
    chats: $('#chat-list'),
    memory: $('#memory-list'),
    settings: $('#settings-sidebar')
    // r36：#settings-community 已迁到设置页页脚（index.html #settings-foot），不再由外壳同步
  };

  /* ══════════ 侧栏宽度 ══════════
     启动页 300 / 导航页 176 / 存档·记忆（要列群聊）268 / 设置 196。
     用户拖过分隔条后 --pane-w 落在 #sidebar 行内样式上，此后统一覆盖各页默认值，
     否则「拖宽了启动页、切到设置又缩回去」会让人以为拖动没生效。 */
  function syncSidebarWidth(name, group) {
    if (!sidebar) return;
    var cls = 'is-launch';
    if (name === 'sessions') cls = 'is-launch';
    else if (name === 'chats' || name === 'memory') cls = 'is-wide';
    else if (group.key === 'settings') cls = 'is-set';
    // 壁纸页是整页布局（左壁纸库、右预览，自己带两栏），再挂一条 176px 左栏
    // 只会白白吃掉一块宽度，所以整条侧栏收起。is-none 的样式见 style.css
    // 「每页一份的固定宽度」那一节。
    else if (group.key === 'wallpaper') cls = 'is-none';
    // 桌宠已并进 ops 组左栏，和技能/插件页一样走 is-nav，左栏 176px，面板自己缩。
    else cls = 'is-nav';
    sidebar.classList.remove('is-launch', 'is-nav', 'is-wide', 'is-set', 'is-none');
    sidebar.classList.add(cls);
  }

  /* ══════════ 用量页的「统计维度」切换 ══════════
     后端 stats.mode：'today' | '24h' | 'days' | 'all'（src/app.js 的 rangeWindow）。
     只有 'days' 时按天那块才有内容，04-archive-usage.js 会把它整块 display:none。
     stats 参数：传本次**将要渲染**的那份统计（切时间范围时用，避免拿上一次的 mode 判断）；
              不传则取 state.usageRenderArgs（04 每次渲染都会写）。 */
  function usageModeOf(stats) {
    if (stats && stats.mode) return stats.mode;
    try {
      if (typeof state === 'undefined') return null;
      var a = state.usageRenderArgs;
      return (a && a.stats && a.stats.mode) || null;
    } catch (e) { return null; }
  }
  function usageOff(stats) {
    var m = usageModeOf(stats);
    return !!m && m !== 'days';      // 「今日 / 24 小时」→ 按天没有内容
  }
  /* 「今日」范围下按天没内容 → 降级显示「按会话」。
     只降级显示，不动 usageDim：用户切回「近 7 天 / 近 30 天」时「按天」要自己亮回来。 */
  function usageDimNow(stats) {
    return (usageDim === 'days' && usageOff(stats)) ? 'chats' : usageDim;
  }

  /* 把「一次只显示一块」写进 DOM（页面 + 左栏选中/置灰一起刷，两处永远同步）。
     这里只写 #usage-page 上的 data-udim，绝不写内联 display：
     updateUsagePage 每次都会给按天块写内联 style.display（按 mode 决定），
     内联优先级高于一切选择器，我们写的那份会被它当场顶掉，
     表现为「切到按会话后按天又自己冒出来」。可见性交给 style.css 第 14 节
     的属性选择器 + !important 决定。 */
  function applyUsageDim(stats) {
    var cur = usageDimNow(stats);
    var off = usageOff(stats);
    var box = $('#usage-page');
    if (box) box.dataset.udim = cur;
    $$('#side-nav [data-usage-dim]').forEach(function (el) {
      var isDay = el.dataset.usageDim === 'days';
      el.classList.toggle('on', el.dataset.usageDim === cur);
      el.classList.toggle('is-off', isDay && off);
      if (isDay && off) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    });
  }

  /* ══════════ 左栏二级导航 ══════════ */
  // 左栏结构上没有副标题位，hover 说明走原生 title 属性（不动 DOM 结构与既有 class）。
  var SUB_TITLE = {
    harness: '给机器人看病、查问题',
    'desktop-pet': '桌面上的 Live2D 小伙伴：今日用量卡片、开发工单'
  };
  function navItemHtml(sub, active) {
    const subTitle = SUB_TITLE[sub] ? ' title="' + SUB_TITLE[sub] + '"' : '';
    return '<button class="sn-item' + (active ? ' on' : '') + '" type="button" data-sub="' + sub + '"' +
      // 当前二级页要能被读屏识别。视觉靠 .on / .sn-bar，
      // 但对屏幕阅读器来说「一排长得一样的按钮」等于没有导航状态。
      (active ? ' aria-current="page"' : '') +
      ' role="button" tabindex="0"' + subTitle + '>' +
      '<span class="sn-bar"></span>' +
      '<svg class="sn-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="' + (SUB_ICON[sub] || '') +
      '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      '<span class="sn-t">' + SUB_LABEL[sub] + '</span></button>';
  }

  function renderSideNav(name, group) {
    if (!sideNav) return;
    if (group.key === 'usage') {
      var cur = usageDimNow();
      // 「今日」下按天没有内容 → 该置灰不可点，不能做成"点了没反应"的哑按钮
      var offDay = usageOff();
      var h = '<div class="sn-sec">统计维度</div>';
      USAGE_ANCHORS.forEach(function (a) {
        var isOff = offDay && a.dim === 'days';
        h += '<button class="sn-item' + (a.dim === cur ? ' on' : '') + (isOff ? ' is-off' : '') +
          '" type="button" data-usage-dim="' + a.dim + '"' + (isOff ? ' aria-disabled="true"' : '') +
          // aria-current 与视觉的 .on 同源
          (a.dim === cur ? ' aria-current="true"' : '') +
          ' role="button" tabindex="0">' +
          '<span class="sn-bar"></span>' +
          '<svg class="sn-logo" viewBox="0 0 24 24" aria-hidden="true"><path d="' + a.icon + '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
          '<span class="sn-t">' + a.label + '</span></button>';
      });
      sideNav.innerHTML = h;
      return;
    }
    if (group.key === 'sessions') {
      // 存档 / 记忆 与「会话」同属一级，但首页被启动块占满，给它们补一份
      // 「消息记录」导航，否则这两个页在界面上没有任何入口（只有会话设置里的跳转）。
      sideNav.innerHTML = '<div class="sn-sec">消息记录</div>' +
        GROUPS[0].subs.map(function (s) { return navItemHtml(s, s === name); }).join('');
      return;
    }
    // 「下载」页左栏分两段：市场（装新的）/ 已安装（管已装的）。
    // 写法与上面 usage / sessions 两个 case 一致（一个 .sn-sec 小标题 + 若干 .sn-item）。
    // 两段的条目合起来与 GROUPS 里 ext.navSubs 逐项对应，要增减条目两处一起改。
    // 技能 / 插件两个二级页此前在左栏没有对应按钮，.sn-item.on 无处可挂，点进去两条都不高亮。
    if (group.key === 'ext') {
      var extSeg = function (title, list) {
        return '<div class="sn-sec">' + title + '</div>' +
          list.map(function (s) { return navItemHtml(s, s === name); }).join('');
      };
      sideNav.innerHTML = extSeg('市场', ['skillmarket', 'pluginmarket', 'personamarket']) +
                          extSeg('已安装', ['skills', 'plugins', 'personas']);
      return;
    }
    // 左栏渲染 navSubs（默认回退到 subs），而不是 subs：二级页可以"存在但不出现在左栏"。
    var navSubs = group.navSubs || group.subs;
    sideNav.innerHTML = navSubs.map(function (s) { return navItemHtml(s, s === name); }).join('');
  }

  /* ══════════ 全屏页 ══════════ */
  var bigpage = $('#bigpage');
  var bpMode = '';                       // '' | 'chat' | 'setup'

  function bpWindowBtns() {
    var d = window.qqaDesktop;
    var minB = $('#bp-min'), maxB = $('#bp-max');
    // 没有桌面壳时只不绑事件，不隐藏按钮。隐藏的话，用浏览器打开控制台 /
    // 预览页（无 window.qqaDesktop）时全屏页右上角只剩一颗 ✕，与真机、与原型都不一致；
    // 而且隐藏依赖本文件成功执行，脚本报错 / 渲染进程冻结都会停在隐藏态。
    // 现在：看得见由 HTML 保证，点得动由这里保证。
    if (minB && d && d.minimize) minB.addEventListener('click', function () { d.minimize(); });
    if (maxB && d && d.toggleMaximize) maxB.addEventListener('click', function () { d.toggleMaximize(); });
    // 关闭必须无条件绑定。早期写法把 #bp-x 和 min/max 一起塞进 if (d) 里，
    // 于是没有 window.qqaDesktop 时全屏页关不掉（返回键能用，只坏在这一条路径）。
    // min/max 都作用于真实窗口，✕ 却只关遮罩回主界面，所以有桥时改调 d.close()
    // （与主顶栏 #win-close-btn 同款）；关全屏页仍由 ← 返回键 / Esc 承担。
    // 无桥（浏览器 / 预览）才退回 closeBigPage。
    $('#bp-x') && $('#bp-x').addEventListener('click', function () {
      if (d && typeof d.close === 'function') { d.close(); return; }
      closeBigPage();
    });
  }

  /* ── 左栏：会话选择（= 这一页到底在配置谁）────────────────────── */
  // 头像方块与 15-chat-chrome.js 的会话列表同风格（qlogo 直链 + 首字兜底；
  // error 用捕获委托揭兜底，CSP 禁内联 onerror，见 15 的 bindAvatarFallback）。
  // chatKey 形如 group:123456 / private:654321（冒号分隔），与 qqAvatarUrl 的正则一致。
  function setupAvatarHtml(key, label) {
    var m = /^(group|private):(\d{5,12})$/.exec(String(key || ''));
    var fb = escH(String(label || '?').charAt(0) || '?');
    var url = m ? (m[1] === 'group'
      ? 'https://p.qlogo.cn/gh/' + m[2] + '/' + m[2] + '/100'
      : 'https://q1.qlogo.cn/g?b=qq&nk=' + m[2] + '&s=100') : '';
    if (!url) return '<span class="bp-av"><span class="av-l">' + fb + '</span></span>';
    return '<span class="bp-av" data-avk="' + escH(key) + '">' +
      '<img class="av-img" src="' + url + '" alt="" loading="lazy" referrerpolicy="no-referrer" />' +
      '<span class="av-l av-fb" hidden>' + fb + '</span></span>';
  }
  /* ── R131：左栏搜索词 ──────────────────────────────────────────────
     setupQRaw = 用户输入原文（回填 input 的 value，保留大小写与空格）；
     setupQ = 归一化（trim + 小写）后用于匹配，口径同 15-chat-chrome.js 的 st.q。
     只过滤会话清单，「扩展 / 全部设置」两段不参与。 */
  var setupQ = '', setupQRaw = '';

  /* 一次扫描 state.sessions 按 chatKey 汇总：总数 / 进行中数 / 最近一条摘要。
     口径与 15-chat-chrome.js 的 chatGroups 逐字一致（进行中 = running | waiting，
     摘要取 startedAt 最新一条的 trigger，42 字截断），两页左栏显示同一个数。 */
  function sessionStatsByChat() {
    var map = {};
    try {
      var arr = (typeof state !== 'undefined' && state.sessions) || [];
      for (var i = 0; i < arr.length; i++) {
        var s = arr[i];
        if (!s || !s.chatKey) continue;
        var g = map[s.chatKey];
        if (!g) g = map[s.chatKey] = { total: 0, active: 0, last: '', newest: -1 };
        g.total++;
        if (s.status === 'running' || s.status === 'waiting') g.active++;
        var t = Number(s.startedAt) || 0;
        if (t > g.newest) {
          g.newest = t;
          g.last = String(s.trigger || s.triggerSummary || '').replace(/\s+/g, ' ').trim().slice(0, 42);
        }
      }
    } catch (e) { /* state 还没就绪 → 全 0，别抛 */ }
    return map;
  }

  /* 搜索命中：名称 / chatKey / 最近摘要（同 15-chat-chrome.js fillLeft 里的 hit）。 */
  function setupHit(it, stats, q) {
    if (!q) return true;
    var g = stats[it.key];
    var hay = chatShortLabel(it.key) + ' ' + it.key + ' ' + (g ? g.last : '');
    return hay.toLowerCase().indexOf(q) >= 0;
  }

  /* 一行会话 = 与「会话选择」页左栏 chatRow 同款排布（两页一致）：
     [头像] [名称 + 最近会话摘要] [计数胶囊]。
     本页专属的两枚标记不破坏主排布：「未加白名单」折进摘要行末；
     「已设人设」是右侧第二颗胶囊。 */
  function setupChatRowHtml(it, stats) {
    var g = stats[it.key] || { total: 0, active: 0, last: '' };
    var pill = g.active
      ? '<span class="cc-pill cc-running">' + g.active + ' 个进行中</span>'
      : '<span class="cc-pill cc-gray">' + g.total + ' 个会话</span>';
    var sub = g.last;
    if (!it.inAllow) sub = (sub ? sub + ' · ' : '') + '未加白名单';
    if (!sub) sub = '—';
    return '<div class="bp-row chat-row' + (it.key === setupChat && setupView === 'chat' ? ' on' : '') +
      '" type="button" role="button" tabindex="0" data-setup-chat="' + escH(it.key) + '" title="' +
      escH(chatLabel(it.key)) + '">' +
      setupAvatarHtml(it.key, chatShortLabel(it.key)) +
      '<span class="bp-rl"><span class="bp-rt">' + escH(chatShortLabel(it.key)) + '</span>' +
      '<span class="bp-ri">' + escH(sub) + '</span></span>' +
      pill +
      (hasPersonaOwn(it.key) ? '<span class="cc-pill cc-gray">已设人设</span>' : '') +
      '</div>';
  }

  /* 会话清单段 = 分区头（含计数与 + 钮）+ 行容器（含空态）。搜索时只重渲染这一段。 */
  function setupChatSegHtml(list) {
    var stats = sessionStatsByChat();
    var shown = list.filter(function (it) { return setupHit(it, stats, setupQ); });
    var h = '<div class="bp-sec bp-sec-row"><span>选择会话</span>' +
      '<span class="cc-cnt" id="bp-cnt">' + (list.length ? list.length + ' 个' : '') + '</span>' +
      // + 添加会话（用户要求在这一页直接加群聊/私聊），弹窗见 openAddChatModal
      '<button class="bp-add" id="bp-add-chat" type="button" title="添加群聊 / 私聊" aria-label="添加群聊 / 私聊">' +
      '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.2v7.6M1.2 5h7.6"/></svg></button></div>';
    if (!list.length) {
      // 白名单与会话列表都空：指条路（设置 → 聊天）
      h += '<div class="su-empty">白名单为空 —— 先去「设置 → 聊天」把群 / 好友加进来。</div>';
    } else {
      h += '<div id="bp-rows">' +
        (shown.length
          ? shown.map(function (it) { return setupChatRowHtml(it, stats); }).join('')
          : '<div class="bp-empty">没有匹配的会话</div>') +
        '</div>';
    }
    return h;
  }

  /* 搜索框两枚图标，与 15-chat-chrome.js 左栏搜索框逐字符相同
     （那边的常量在它自己的 IIFE 里，跨不过来，只能显式复制一份）。 */
  var ICON_MAG = 'M675.9168 242.816C556.3008 123.2 362.4448 123.2 242.8288 242.816 123.2128 362.432 123.2128 556.288 ' +
    '242.8288 675.904 362.4448 795.52 556.3008 795.52 675.9168 675.904 795.5328 556.288 795.5328 362.432 675.9168 ' +
    '242.816L675.9168 242.816ZM1000.7168 892.48C1030.6048 922.368 1030.6048 970.816 1000.7168 1000.704 ' +
    '970.8288 1030.656 922.3808 1030.656 892.4288 1000.704L730.0608 838.336C728.1408 836.416 727.4368 833.92 ' +
    '725.7728 831.872 546.3168 960.448 295.7568 945.408 134.5408 784.192-44.8512 604.8-44.8512 313.92 ' +
    '134.5408 134.528 313.9328-44.864 604.8128-44.864 784.2048 134.528 945.4208 295.744 960.4608 546.304 ' +
    '831.8848 725.76 833.9328 727.424 836.4288 728.128 838.3488 730.048L1000.7168 892.48Z';
  var ICON_X = 'M2,0 L0,2 8,10 0,18 2,20 10,12 18,20 20,18 12,10 20,2 18,0 10,8 2,0Z';

  function renderSetupNav() {
    var left = $('#bp-setup-left');
    if (!left) return;
    var list = setupChatList();
    // R131：搜索框，与「会话选择」页左栏同款（.bp-search + sticky 挡板，
    // 样式见 style.css 的 #bp-setup-left .bp-search-wrap 两条）。
    var h = '<div class="bp-search-wrap" id="bp-q-wrap">' +
      '<div class="bp-search">' +
      '<svg class="bp-mag" viewBox="0 0 1040 1040" aria-hidden="true"><path d="' + ICON_MAG + '"/></svg>' +
      '<input id="bp-q" type="text" placeholder="搜索会话" maxlength="50" autocomplete="off" aria-label="搜索会话" value="' + escH(setupQRaw) + '">' +
      '<button class="bp-clear" id="bp-q-clear" type="button" title="清空" aria-label="清空" data-show="' + (setupQ ? '1' : '0') + '">' +
      '<svg viewBox="0 0 20 20"><path d="' + ICON_X + '" fill="currentColor" stroke="none"/></svg></button>' +
      '</div></div>';
    // ── 段顺序：扩展 → 会话清单 → 全部设置 ──────────────────────────────
    // 「扩展」放在会话清单上方，与「会话选择」页左栏（页面导航在上、会话清单在下）
    // 保持一致。技能/插件管的是开关，人设管的是"用哪一个"，三者都是"本机已装的东西"，
    // 所以同列在「扩展」段，带开关的列表出在右栏（PCL「版本设置 → Mod 管理」）。
    // 「全部设置」留在最底：它是次要出口，不该压在日常要点的东西上面。
    h += '<div class="bp-sec">扩展</div>' +
      extEntryHtml('skill', '技能', SUB_ICON.skills) +
      extEntryHtml('plugin', '插件', SUB_ICON.plugins) +
      extEntryHtml('persona', '人设', SUB_ICON.personas);
    h += setupChatSegHtml(list);
    h += '<div class="bp-sec">全部设置</div>' +
      '<button class="bp-act" type="button" data-setup-all="1">' +
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + SUB_ICON.settings +
      '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
      '<span>打开完整设置页</span></button>';
    left.innerHTML = h;
  }

  /* 打字时的轻量刷新：只换行容器，搜索框本身不重建，焦点与光标不丢。
     #bp-rows 不存在（清单全空、连行容器都没建）时退回全量重画。 */
  function applySetupFilter() {
    var rows = $('#bp-rows');
    if (!rows) { renderSetupNav(); return; }
    var stats = sessionStatsByChat();
    var shown = setupChatList().filter(function (it) { return setupHit(it, stats, setupQ); });
    rows.innerHTML = shown.length
      ? shown.map(function (it) { return setupChatRowHtml(it, stats); }).join('')
      : '<div class="bp-empty">没有匹配的会话</div>';
  }

  /* ── 右栏：本会话的专属设置 ─────────────────────────────────────
     只放"能按单个会话覆盖"的项。每一项的写入都直接 POST /api/config 的对应
     子树，保存后回写 state.config 并就地重渲染（不整页重拉）。 */
  function renderSetupPane() {
    var box = $('#bp-setup-scroll');
    if (!box) return;
    // 左栏点了「技能 / 插件」→ 右栏借这块滚动区渲染本机列表。
    // 渲染复用「下载 → 技能 / 插件」那一套（renderModulePage），compact 模式：
    // 只出「标题 + 计数 + 状态筛选 + 卡片」，不出「去市场 / ＋添加 / 刷新」，
    // 那几颗钮带全局唯一 id，而 #view-skills / #view-plugins 一直挂在 DOM 里，
    // 再来一份同 id 的 DOM 会让 $() 只认先出现的那一个，另一份变成哑按钮。
    if (setupView !== 'chat') {
      setSetupCrumb(setupView);
      // 人设走另一套渲染：数据源是 /api/persona-templates，不是 /api/skills，
      // 而且它没有 renderModulePage 那套卡片（人设是单选、不是开关型模块）。
      // 复用 19-personas.js 的 loadPersonasPage，传 box 指到右栏、compact 去掉尾注。
      if (setupView === 'persona') {
        if (typeof loadPersonasPage === 'function') {
          // 数据回来后左栏那一条的计数（N 个 · 1 使用中）也要跟着更新
          Promise.resolve(loadPersonasPage({ box: box, compact: true }))
            .then(function () { if (setupView === 'persona') renderSetupNav(); })
            .catch(function () { /* 失败时右栏自己会显示错误态 */ });
        } else {
          box.innerHTML = '<div class="su-empty-lg">人设列表加载失败：loadPersonasPage 不可用。</div>';
        }
        return;
      }
      if (typeof renderModulePage === 'function') renderModulePage(setupView, box, { compact: true });
      else box.innerHTML = '<div class="su-empty-lg">本地管理页加载失败：renderModulePage 不可用。</div>';
      refreshSetupExt(setupView);
      return;
    }
    setSetupCrumb('');
    var key = setupChat;
    if (!key) {
      box.innerHTML = '<div class="su-empty-lg">← 左侧选一个会话，这里显示它的专属设置</div>';
      return;
    }
    var c = cfgNow();
    var k = splitKey(key);
    var isGroup = k.kind === 'group';
    var inAllow = !!allowMapOf()[key];   // 归一化比对（裸号白名单 vs 带前缀 chatKey）

    // ① 白名单
    var allowCard =
      '<section class="su-card">' +
      '<h3>参与白名单</h3>' +
      '<div class="checkbox-row"><input type="checkbox" class="sw" id="su-allow"' + (inAllow ? ' checked' : '') + ' />' +
      '<label for="su-allow">机器人参与这个会话</label></div>' +
      '<div class="hint">关闭 = 从白名单移除：这个会话里的消息不再存档、不触发回复。"白名单为空时允许所有会话"若开着，移除后仍会被其它规则放行 —— 那一条在「设置 → 聊天」里。</div>' +
      '</section>';

    // ② 人设覆盖
    var pc = personaConfOf(key);
    var own = hasPersonaOwn(key);
    var LBL = { low: '安静型', medium: '普通群友', high: '活跃型' };
    var gPart = (c.persona || {}).participation || 'medium';
    var partNow = pc.participation
      ? escH(LBL[pc.participation] || pc.participation) + ' <span class="su-tag">本会话单独</span>'
      : escH(LBL[gPart] || gPart) + ' <span class="su-tag su-tag-off">跟随全局</span>';
    var roleNow = pc.roleText
      ? escH(String(pc.roleText).slice(0, 60)) + (String(pc.roleText).length > 60 ? '…' : '')
      : '<span class="su-none">跟随全局人设</span>';
    var extras = [];
    if (pc.customRules) extras.push('附加规则');
    if (pc.systemPromptOverride) extras.push('系统提示覆盖');
    var personaCard =
      '<section class="su-card">' +
      '<h3>人设覆盖</h3>' +
      (own ? '<div class="hint" style="margin-bottom:8px">本会话已单独设置人设（左栏那颗圆点就是它）。</div>'
           : '<div class="hint" style="margin-bottom:8px">本会话没有独立人设，当前跟随全局。</div>') +
      '<div class="su-kv"><span class="su-k">参与度</span><span class="su-v">' + partNow + '</span></div>' +
      '<div class="su-kv"><span class="su-k">角色设定</span><span class="su-v">' + roleNow + '</span></div>' +
      (extras.length ? '<div class="su-kv"><span class="su-k">另含</span><span class="su-v">' + escH(extras.join(' / ')) + '</span></div>' : '') +
      '<div class="su-acts">' +
      '<button class="btn btn-small" id="su-persona-edit">✎ 编辑本会话人设</button>' +
      (own ? '<button class="btn btn-small" id="su-persona-clear">清除独立人设（回到跟随全局）</button>' : '') +
      '</div></section>';

    // ③ 响应档位（仅群聊；私聊永远跟随全局，后端 storeConfigForChat 里写死了）
    //    这里只做「看状态 + 就地入口」：编辑（拖档位 / 峰谷 / 清除单独设置）
    //    统一收进「活跃设置」弹窗，避免下拉框与滑条改同一份 groupSliderPos 却两套交互。
    var eff = effectiveTierOf(key);
    var tierCard = '';
    if (isGroup) {
      var tagNow = eff.own
        ? ' <span class="su-tag">本群单独</span>'
        : ' <span class="su-tag su-tag-off">跟随全局</span>';
      var modeHint = eff.unified
        ? '现在是「统一档位」模式：全部群聊共用一个档位。要改成按群单独拖（含峰谷 / 指令禁言），打开下面的「活跃设置」。'
        : (eff.peakOn
          ? '⚠️ 峰谷切换开着：本群档位按「高峰 / 低谷」两个点走 —— 拖动与两点都在下面的「活跃设置」里调。'
          : '要单独拖动本群档位（或清除单独设置），用下面的「活跃设置」。');
      tierCard =
        '<section class="su-card">' +
        '<h3>响应档位</h3>' +
        '<div class="su-kv"><span class="su-k">当前生效</span><span class="su-v">' +
        eff.tier + ' 档 · ' + escH(TIER_TEXT[eff.tier] || '') + tagNow +
        '</span></div>' +
        '<div class="hint">' + modeHint + '</div>' +
        '<div class="su-acts"><button class="btn btn-small" id="su-active-config">⚡ 活跃设置（档位 / 峰谷 / 全部群）</button></div>' +
        '</section>';
    }

    // ④ 指令禁言（仅群聊）
    var mut = muteStateOf(key);
    var muteCard = '';
    if (isGroup && mut.applicable) {
      var mTxt, mCls;
      if (mut.muted && mut.manual) { mTxt = '已禁言 —— 直到手动解除'; mCls = 'su-tag'; }
      else if (mut.muted) {
        var mins = Math.max(1, Math.round((mut.until - Date.now()) / 60000));
        mTxt = '已禁言 —— 约 ' + mins + ' 分钟后自动解除'; mCls = 'su-tag';
      } else { mTxt = '未禁言'; mCls = 'su-tag-off'; }
      muteCard =
        '<section class="su-card">' +
        '<h3>指令禁言</h3>' +
        '<div class="su-kv"><span class="su-k">状态</span><span class="su-v">' + escH(mTxt) +
        ' <span class="su-tag ' + mCls + '">' + (mut.muted ? '生效中' : '正常') + '</span></span></div>' +
        '<div class="hint">群成员发指令（默认 <code>/安静</code>）可临时把本群压到 1 档仅艾特。' +
        '指令与时长在「活跃设置」弹窗里改（上面响应档位卡的 ⚡ 按钮）。</div>' +
        (mut.muted ? '<div class="su-acts"><button class="btn btn-small" id="su-mute-clear">解除本群禁言</button></div>' : '') +
        '</section>';
    }

    // ⑤ 群成员屏蔽名单（仅群聊）
    var blockCard = '';
    if (isGroup) {
      var n = blockedCountOf(key);
      blockCard =
        '<section class="su-card">' +
        '<h3>群成员屏蔽名单</h3>' +
        '<div class="su-kv"><span class="su-k">已屏蔽</span><span class="su-v">' +
        n + ' 人' + (n ? '' : ' <span class="su-tag su-tag-off">名单为空</span>') + '</span></div>' +
        '<div class="hint">被屏蔽成员的消息不存档、不触发回复、不进提示词背景。名单按群单独保存。</div>' +
        '<div class="su-acts"><button class="btn btn-small" id="su-blocklist">管理屏蔽名单</button></div>' +
        '</section>';
    }

    var head =
      '<div class="su-head">' +
      '<div class="su-name">' + escH(chatLabel(key)) + '</div>' +
      '<div class="su-meta">' + escH(key) + ' · ' + (isGroup ? '群聊' : '私聊') +
      ' · ' + (inAllow ? '在白名单' : '未加白名单') + '</div>' +
      '</div>';

    box.innerHTML = head + allowCard + personaCard + tierCard + muteCard + blockCard;
  }

  /* ── 会话设置：事件委托（绑在长期容器上，内容随 innerHTML 重建不丢）── */
  var suPane = $('#bp-setup-scroll');
  var suLeft = $('#bp-setup-left');
  suLeft && suLeft.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('#bp-add-chat')) {
      openAddChatModal();
      return;
    }
    // R131：搜索框的清空钮（×）
    if (e.target.closest && e.target.closest('#bp-q-clear')) {
      var qi = $('#bp-q');
      if (qi) { qi.value = ''; qi.focus(); }
      setupQ = ''; setupQRaw = '';
      var qc = $('#bp-q-clear');
      if (qc) qc.dataset.show = '0';
      applySetupFilter();
      return;
    }
    // 「技能 / 插件」两条：点开 = 右栏换成那一类的本机列表；
    // 再点一次同一条（或改点任一会话）退回按会话的设置。
    var ex = e.target.closest && e.target.closest('[data-setup-ext]');
    if (ex) {
      var want = ex.dataset.setupExt;
      setupView = (setupView === want) ? 'chat' : want;
      renderSetupNav();
      renderSetupPane();
      return;
    }
    var b = e.target.closest && e.target.closest('[data-setup-chat]');
    if (b) {
      setupChat = b.dataset.setupChat;
      setupView = 'chat';
      renderSetupNav();
      renderSetupPane();
    }
  });
  // R131：搜索输入，只重画清单段（搜索框不重建，打字不丢焦点）
  suLeft && suLeft.addEventListener('input', function (e) {
    if (!e.target || e.target.id !== 'bp-q') return;
    setupQRaw = String(e.target.value || '');
    setupQ = setupQRaw.trim().toLowerCase();
    var qc2 = $('#bp-q-clear');
    if (qc2) qc2.dataset.show = setupQ ? '1' : '0';
    applySetupFilter();
  });
  // 会话行（setupChatRowHtml 里是 role="button" + tabindex="0"）此前只有 click 委托，
  // 键盘能 Tab 到、按回车没反应，等于键盘用户进不去任何会话。
  // 焦点必须在行本身；直接 click() 复用上面那条委托的全部分支。
  suLeft && suLeft.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains('bp-row')) return;
    e.preventDefault();
    t.click();
  });
  // 头像加载失败 → 揭开首字兜底（捕获：error 不冒泡；容器长期存在，绑一次即可）
  suLeft && suLeft.addEventListener('error', function (e) {    var im = e.target;
    if (!im || im.tagName !== 'IMG' || !im.classList.contains('av-img')) return;
    var box = im.parentNode;
    var fb = box && box.querySelector('.av-fb');
    im.style.display = 'none';
    if (fb) fb.hidden = false;
  }, true);

  /* ── 「+ 添加会话」弹窗 ─────────────────────────────────
     照「活跃设置」弹窗同款外壳（modelModalShell，遮罩层号 910，现由
     style.css 0.5 段的 --z-model-modal-overlay 统一给值，盖过 #bigpage 的 60）：
     类型选群聊/私聊 + 纯数字 ID，落白名单裸号。
     ID 右侧多一个「拉取群聊 / 拉取好友」按钮，调 GET /api/onebot/groups
     （私聊走 /api/onebot/friends）把机器人已加入的列表拉下来，选一个即回填 ID。
     机器人没连上时后端返 502，这里降级成一行提示，手动填号照旧可用。
     保存 = POST /api/config {allow:{groups|private:{__replace__:[...]}}}
     （数组必须整体替换，deepMerge 对数组是覆盖不是拼接）。 */
  function openAddChatModal() {
    var overlay = modelModalShell({
      head: '添加会话',
      body:
        '<div class="field"><label>类型</label>' +
        '<select id="bp-add-kind"><option value="group">群聊</option><option value="private">私聊</option></select></div>' +
        '<div class="field"><label id="bp-add-id-label">群号</label>' +
        '<div class="bp-add-row">' +
        '<input type="text" id="bp-add-id" inputmode="numeric" placeholder="只填数字，如 7366472817" />' +
        '<button class="btn btn-small" id="bp-add-pull" type="button">拉取群聊</button>' +
        '</div></div>' +
        '<div id="bp-add-pick"></div>' +
        '<div class="hint">可以直接「拉取群聊」从机器人已加入的群里选，也可以手动填号。' +
        '添加后自动加入白名单并选中。会话名称会在机器人收到该会话的消息后自动带出。</div>',
      foot:
        '<button class="btn" id="bp-add-cancel" type="button">取消</button>' +
        '<button class="btn btn-primary" id="bp-add-ok" type="button">添加</button>'
    });
    var kindSel = overlay.querySelector('#bp-add-kind');
    var idLabel = overlay.querySelector('#bp-add-id-label');
    var idIn = overlay.querySelector('#bp-add-id');
    var pullBtn = overlay.querySelector('#bp-add-pull');
    var pickBox = overlay.querySelector('#bp-add-pick');
    function isPrivate() { return kindSel.value === 'private'; }
    function pullLabel() { return isPrivate() ? '拉取好友' : '拉取群聊'; }
    kindSel.addEventListener('change', function () {
      idLabel.textContent = isPrivate() ? 'QQ 号' : '群号';
      idIn.placeholder = isPrivate() ? '只填数字，如 10001' : '只填数字，如 7366472817';
      // 切类型后旧列表作废（群 ≠ 好友），按钮文案跟着回位
      pickBox.innerHTML = '';
      pullBtn.textContent = pullLabel();
    });
    pullBtn.addEventListener('click', function () {
      var isP = isPrivate();
      var ep = isP ? '/api/onebot/friends' : '/api/onebot/groups';
      var key = isP ? 'friends' : 'groups';
      var unit = isP ? '好友' : '群';
      var field = isP ? 'private' : 'groups';
      pullBtn.disabled = true; pullBtn.textContent = '拉取中…';
      api(ep).then(function (d) {
        var list = ((d && d[key]) || []).map(function (g) {
          return { id: String(g.id), name: String(g.name || g.id) };
        }).filter(function (g) { return /^\d+$/.test(g.id); });
        if (!list.length) {
          pickBox.innerHTML = '<div class="hint" style="color:var(--orange)">没有拉到任何' + unit +
            '（机器人上报的' + unit + '列表是空的）。</div>';
          return;
        }
        // 已在白名单的标出来并禁选，避免"选了却发现重复"
        var seen = {}, wl = [];
        (((cfgNow().allow || {})[field]) || []).map(bareIdOf).map(String).forEach(function (x) {
          if (!seen[x]) { seen[x] = 1; wl.push(x); }
        });
        var opts = list.map(function (g) {
          var has = wl.indexOf(g.id) >= 0;
          return '<option value="' + escH(g.id) + '"' + (has ? ' disabled' : '') + '>' +
            escH(g.name) + ' · ' + escH(g.id) + (has ? '（已添加）' : '') + '</option>';
        }).join('');
        pickBox.innerHTML =
          '<div class="field"><label>' + unit + '列表（共 ' + list.length + ' 个）</label>' +
          '<select id="bp-add-pick-sel"><option value="">— 从列表里选一个 —</option>' + opts + '</select></div>';
        pickBox.querySelector('#bp-add-pick-sel').addEventListener('change', function (e) {
          if (e.target.value) { idIn.value = e.target.value; idIn.focus(); }
        });
      }).catch(function (err) {
        var msg = (err && err.message) ? err.message : String(err);
        pickBox.innerHTML = '<div class="hint" style="color:var(--red)">拉取失败：' + escH(msg) +
          '<br />机器人可能没连上 OneBot（没上报' + unit + '列表）。手动填号一样能添加。</div>';
      }).then(function () {
        pullBtn.disabled = false; pullBtn.textContent = pullLabel();
      }).catch(function () { /* 兜底自检 unhandledRejection，按钮状态在 then 内已恢复 */ });
    });
    overlay.querySelector('#bp-add-cancel').addEventListener('click', function () { closeModelModal(overlay); });
    var okBtn = overlay.querySelector('#bp-add-ok');
    okBtn.addEventListener('click', function () {
      var id = String(idIn.value || '').trim();
      if (!/^\d{4,}$/.test(id)) { suAlert('请输入正确的数字 ID（群号 / QQ 号，只填数字）'); return; }
      var kind = kindSel.value === 'private' ? 'private' : 'group';
      var field = kind === 'private' ? 'private' : 'groups';   // 白名单字段名（后端 allow.groups/private）
      var seenA = {}, cur = [];
      (((cfgNow().allow || {})[field]) || []).map(bareIdOf).map(String).forEach(function (x) {
        if (!seenA[x]) { seenA[x] = 1; cur.push(x); }
      });
      if (cur.indexOf(id) >= 0) {
        suAlert('这个' + (kind === 'private' ? 'QQ 号' : '群号') + '已经在列表里了');
        return;
      }
      var patch = { allow: {} };
      patch.allow[field] = { __replace__: cur.concat([id]) };
      okBtn.disabled = true;
      suSave(patch).then(function () {
        setupChat = kind + ':' + id;   // chatKey 前缀是 group/private，不是字段名 groups
        closeModelModal(overlay);
        renderSetupNav();
        renderSetupPane();
      }).catch(function (err) {
        okBtn.disabled = false;
        suAlert('保存失败：' + (err && err.message ? err.message : err));
      });
    });
    idIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); } });
  }
  suPane && suPane.addEventListener('change', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'su-allow') {
      var on = t.checked;
      setAllowState(on).then(function () { renderSetupNav(); renderSetupPane(); })
        .catch(function (err) { t.checked = !on; suAlert('保存失败：' + (err && err.message ? err.message : err)); });
    }
    // #su-tier 下拉框已移除，档位编辑统一走「活跃设置」弹窗（su-active-config）
  });
  suPane && suPane.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.id) return;
    if (t.id === 'su-persona-edit') {
      // 复用全局页那套「会话人设」弹窗（自己 POST 落盘），不在这里重写一份保存逻辑
      try { if (typeof openPerChatPersonaModal === 'function') openPerChatPersonaModal(setupChat); }
      catch (err) { suAlert('打开人设弹窗失败：' + (err && err.message ? err.message : err)); }
    } else if (t.id === 'su-persona-clear') {
      clearPersonaOwn().then(function () { renderSetupNav(); renderSetupPane(); })
        .catch(function (err) { suAlert('清除失败：' + (err && err.message ? err.message : err)); });
    } else if (t.id === 'su-active-config') {
      // 带上当前群，弹窗分群模式下直接聚焦它，不用再在群列表里点一次
      try {
        if (typeof openActiveConfigModal === 'function') {
          var fk = splitKey(setupChat);
          openActiveConfigModal({ focusGid: fk && fk.kind === 'group' ? fk.id : '' });
        }
      }
      catch (err) { suAlert('打开失败：' + (err && err.message ? err.message : err)); }
    } else if (t.id === 'su-mute-clear') {
      clearMute().then(function () { renderSetupPane(); })
        .catch(function (err) { suAlert('解除失败：' + (err && err.message ? err.message : err)); });
    } else if (t.id === 'su-blocklist') {
      try { if (typeof openBlocklistModal === 'function') openBlocklistModal(); }
      catch (err) { suAlert('打开失败：' + (err && err.message ? err.message : err)); }
    }
  });

  /* ── 会话设置的三个写操作（都用 __replace__ 整体替换，否则 deepMerge 删不掉旧键）── */
  function setAllowState(on) {
    var c = cfgNow(), k = splitKey(setupChat);
    var field = k.kind === 'private' ? 'private' : 'groups';
    // 读出来归一化成裸号（顺带清历史遗留的带前缀键），写回也落裸号：
    // 后端 allowed() 只认裸号，写入 group:xxx 等于没加白名单。
    var seenA = {}, arr = [];
    (((c.allow || {})[field]) || []).map(bareIdOf).map(String).forEach(function (x) {
      if (!seenA[x]) { seenA[x] = 1; arr.push(x); }
    });
    arr = arr.filter(function (x) { return x !== String(k.id); });
    if (on) arr.push(String(k.id));
    var patch = { allow: {} };
    patch.allow[field] = { __replace__: arr };
    return suSave(patch);
  }
  // setGroupTier() 已随档位下拉框一并移除，档位写入由「活跃设置」弹窗
  // 的保存逻辑负责（09-community.js openActiveConfigModal 的 #ac-save）。
  function clearMute() {
    var c = cfgNow(), k = splitKey(setupChat);
    var next = {};
    Object.keys((c.commandMute || {}).active || {}).forEach(function (g) {
      if (g !== k.id) next[g] = c.commandMute.active[g];
    });
    return suSave({ commandMute: { active: { __replace__: next } } });
  }
  function clearPersonaOwn() {
    var c = cfgNow(), k = splitKey(setupChat);
    var next = {};
    Object.keys(c.personaByChat || {}).forEach(function (g) {
      if (g !== k.id && g !== setupChat) next[g] = c.personaByChat[g];
    });
    return suSave({ personaByChat: { __replace__: next } });
  }

  function openBigPage(mode) {
    if (!bigpage) return;
    bpMode = mode === 'setup' ? 'setup' : 'chat';
    bigpage.hidden = false;
    // 这里原先是 remove/add `bp-in` 类做淡入，但 `.bp-in` 是批量价格弹窗的输入框类
    // （style.css:3373 `.bp-in { width: 74px; padding: 4px 6px }`），类名撞车后全屏页
    // 被压成 74px 宽（点「会话选择」只剩左栏一条，右侧露出会话首页的更新报告）。
    // 现在改用 WAAPI 播入场：不碰 class、不触发 15-chat-chrome 的 class MutationObserver。
    // 同时清掉可能残留的 bp-in，避免旧类继续压宽度。
    bigpage.classList.remove('bp-in');
    try {
      if (bigpage.animate) {
        bigpage.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      }
    } catch { /* 不支持 WAAPI 就硬切 */ }
    bigpage.classList.toggle('mode-chat', bpMode === 'chat');
    bigpage.classList.toggle('mode-setup', bpMode === 'setup');
    var chat = $('#bp-mode-chat'), setup = $('#bp-mode-setup');
    if (chat) chat.hidden = bpMode !== 'chat';
    if (setup) setup.hidden = bpMode !== 'setup';

    if (bpMode === 'chat') {
      $('#bp-title') && ($('#bp-title').textContent = '会话选择');
      $('#bp-crumb') && ($('#bp-crumb').textContent = '左栏选会话 · 右栏看完整过程');
    } else {
      $('#bp-title') && ($('#bp-title').textContent = '会话设置');
      setSetupCrumb('');
      // 每次打开这一页都回到「按会话」，上次停在「技能」不留着，
      // 这一页的默认身份仍是"这个会话的设置"。
      setupView = 'chat';
      // 这一页有自己的按会话内容（renderSetupPane），不再借用 #settings-form：
      // #settings-form 留在 #view-settings 原地，导航栏「设置」页随时可用、两页互不干扰。
      // 首选会话：上次选过的沿用，否则白名单第一个（都由左栏列表里切换）。
      var list = setupChatList();
      var keys = list.map(function (x) { return x.key; });
      if (keys.indexOf(setupChat) < 0) setupChat = keys[0] || '';
      renderSetupNav();
      renderSetupPane();
    }
  }

  function closeBigPage() {
    if (!bigpage) return;
    bpMode = '';
    bigpage.hidden = true;
    bigpage.classList.remove('mode-chat', 'mode-setup');
  }

  /* 关掉全屏页 → 切到指定的一级页。两步之间必须隔一拍。
     15-chat-chrome.js 的 sync() 挂在 #bigpage 的 hidden / class 变化上（MutationObserver），
     它会在微任务里把 tab 还原成"打开全屏页之前那一页"（那个文件里的 bpPrevSub）。
     同一 tick 里紧跟的 switchTab 会被它当场顶掉：「打开完整设置页」点完停在会话首页，
     设置页根本没进去。
     放进 setTimeout（宏任务，永远排在 MutationObserver 的微任务之后）就落到它后面。 */
  function closeBigPageThen(tab) {
    closeBigPage();
    setTimeout(function () {
      try { if (typeof switchTab === 'function') switchTab(tab); } catch (e) { /* 忽略 */ }
    }, 0);
  }
  // 06-settings-render.js 的「打开完整管理页」要走同一条路径（跨文件的私有函数只能这么给）
  window.closeBigPageThen = closeBigPageThen;

  /* 给 02-sse-sessions.js 的 chat-update 一个刷新「会话设置」右栏的入口。
     群内发 /安静 改的是禁言态，右栏卡片不重绘就会一直显示「未禁言」，用户以为指令没生效。
     （02 里那段判断引用的是 setupChat / renderSetupPane，两者都是本 IIFE 私有的，
     typeof 恒为 undefined，所以从来没真的执行过。）

     内部自己判「当前是不是会话设置模式、有没有选中会话」，不在该状态时是空操作，
     调用方不需要知道这些细节。 */
  window.refreshSetupPane = function () {
    try {
      if (!bigpage || bigpage.hidden) return;
      if (!bigpage.classList.contains('mode-setup')) return;
      if (setupView !== 'chat' || !setupChat) return;
      renderSetupPane();
    } catch (e) { /* 右栏渲染失败不该拖累 SSE 回调 */ }
  };

  bigpage && $('#bp-back') && $('#bp-back').addEventListener('click', closeBigPage);
  bpWindowBtns();
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && bigpage && !bigpage.hidden) {
      // 设置页里 Esc 有别的用途（收起下拉等），只在没有别的处理器消费时关页。
      if (e.defaultPrevented) return;
      closeBigPage();
    }
  });
  bigpage && bigpage.addEventListener('click', function (e) {
    // 会话设置页的按会话交互（选会话 / 各块按钮）由 suPane / suLeft 上的
    // 委托处理，这里只管「打开完整设置页」这一条跨页跳转。
    if (e.target.closest && e.target.closest('[data-setup-all]')) {
      // 不能 closeBigPage() + switchTab('settings') 同一 tick 连做：
      // 15-chat-chrome.js 的 sync() 随后把 tab 还原回"打开前那一页"，设置页根本进不去。
      closeBigPageThen('settings');
    }
  });

  /* ══════════ 左栏交互 ══════════ */
  // 「开始对话」：机器人未运行时，这个按钮是 PCL 隐喻里的「启动游戏」：
  // 拉起机器人用的 QQ（协议端由用户自己装、自己启动），进度写在副标题上，
  // 而不是直接跳会话界面。已连接时才保持旧行为（进全屏会话页并选中第一个）。
  // 启动链本体是 00-core.js 的 launchBotQq（与连接页 quick-start-btn 共用一份），
  // 这里只做本按钮自己的前置判断与终态呈现。
  $('#launch-btn') && $('#launch-btn').addEventListener('click', async function () {
    var btn = this;
    if (btn.dataset.starting === '1') return;   // 启动中防重复点击
    delete btn.dataset.launchMsg;               // 清掉上一轮的粘性提示

    var sub = $('#launch-sub');
    var setSub = function (t) { if (sub) sub.textContent = t; };
    var enterChat = function () {
      openBigPage('chat');
      try {
        var list = $('#session-items');
        var first = list && list.querySelector('.session-item, [data-chat], [data-session]');
        var hasSel = list && list.querySelector('.active, .on, .sel');
        if (first && !hasSel && typeof first.click === 'function') first.click();
      } catch (e) { /* 选择失败就让用户自己在左栏点 */ }
    };

    // 先看机器人是否已在线：在线 → 这就是「开始对话」，保持旧行为
    var st = null;
    try { st = await api('/api/status'); } catch (e) { /* 探不到就当未连接走启动链 */ }
    if (st && st.onebot && st.onebot.connected) { enterChat(); return; }

    var qqReady = !!(st && st.qqPortable && st.qqPortable.ready);
    var qqSupported = !(st && st.qqPortable && st.qqPortable.supported === false);
    // 非 Windows：QQNT 没有另外两版，一键启动这条路走不通，别让人去装 QQNT。
    if (!qqSupported) {
      setSub('这台机器上「一键启动 QQ」不可用（便携 QQ 仅 Windows）—— 请自行登录 QQ 并启动协议端（SnowLuma 或 NapCat）');
      return;
    }
    // ready=false = 便携副本没装且本机也没检测到 QQ，此时"去点一键安装"的指引
    // 必然失败（没源可复制），改成让人去装 QQ / 重新检测。
    if (!qqReady) { setSub('没找到可用的 QQ：先装一个新版 QQ（QQNT），然后到「工具 → 连接」页重试'); return; }

    btn.dataset.starting = '1';
    btn.classList.add('is-starting');
    try {
      var res = await launchBotQq({
        // 按钮脱离 DOM（切走页签）就不再轮询，与连接页同一约束
        isAborted: function () { return !btn.isConnected; },
        onProgress: function (e) { setSub(e.message); }
      });
      if (res.phase === 'aborted') return;   // 页面已经换掉，写提示没人看
      if (res.phase === 'connected') {
        // 粘性提示：身份区由 3 秒定时器按 launchMsg 重建副标题，
        // 先写 dataset 再立刻刷一次，避免「✓ 已连接」一闪就被会话名盖掉
        btn.dataset.launchMsg = '✓ 已连接，机器人运行中 —— 再点一次进入会话';
        setSub(btn.dataset.launchMsg);
        try { if (typeof refreshStatus === 'function') refreshStatus(); } catch (e) { /* ignore */ }
        return;
      }
      // 其余终态的文案要指向本按钮能走的下一步，所以留在调用方；失败原因不设成粘性
      // 提示，下次点击还能看到新的原因。
      if (res.phase === 'proto-down') {
        btn.dataset.launchMsg = 'QQ 已启动，但协议端没在运行 —— 到 工具 → 连接 页按指引启动 SnowLuma 或 NapCat';
        setSub(btn.dataset.launchMsg);
        return;
      }
      if (res.phase === 'timeout') {
        btn.dataset.launchMsg = '还没连上：多半是机器人 QQ 没登录 —— 登录后会自动连上；状态见 工具 → 连接';
        setSub(btn.dataset.launchMsg);
        return;
      }
      setSub(res.message || '启动失败：QQ 没能启动');
    } catch (e) {
      setSub('启动失败：' + (e && e.message ? e.message : e));
    } finally {
      delete btn.dataset.starting;
      btn.classList.remove('is-starting');
    }
  });
  $('#view-btn') && $('#view-btn').addEventListener('click', function () { openBigPage('chat'); });
  $('#cfg-btn') && $('#cfg-btn').addEventListener('click', function () { openBigPage('setup'); });

  $('#avatar-refresh') && $('#avatar-refresh').addEventListener('click', function () {
    try { if (typeof refreshStatus === 'function') refreshStatus(); } catch (e) { /* ignore */ }
    syncIdentity();
  });

  // 二级导航点击（每次渲染后重新绑定，内容是 innerHTML 重建的）
  sideNav && sideNav.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-sub],[data-usage-dim]');
    if (!el) return;
    if (el.dataset.sub && typeof switchTab === 'function') { switchTab(el.dataset.sub); return; }
    if (el.dataset.usageDim) {
      // 「今日」下按天没内容：不作无声跳转，也不改用户的选择
      if (el.getAttribute('aria-disabled') === 'true') return;
      usageDim = el.dataset.usageDim;
      applyUsageDim();
      var ubox = $('#usage-page');
      if (ubox) ubox.scrollTop = 0;      // 换了块就回到顶部（原型切块也是从头上看）
      // 三张图的测量宽度取决于容器当时可不可见（隐藏的块 clientWidth = 0）→
      // 切完必须让 04 原地重画一次。走的还是它那套「折叠/换指标」用的重绘，不重新请求接口。
      var args = (typeof state !== 'undefined' && state.usageRenderArgs) || null;
      if (args) { try { updateUsagePage(args.stats, args.st, args.prices); } catch (err) { /* ignore */ } }
    }
  });

  // 一级导航：点一级 → 进它的默认二级页。
  $$('#tabs .nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (bigpage && !bigpage.hidden) closeBigPage();
      var g = null;
      for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].key === btn.dataset.top) g = GROUPS[i];
      if (g && typeof switchTab === 'function') switchTab(g.home);
    });
  });

  // 会话首页的提示条（可关，记住选择）
  var HINT_KEY = 'qa.stageHintClosed';
  (function () {
    var box = $('#stage-hint');
    if (!box) return;
    var closed = false;
    try { closed = localStorage.getItem(HINT_KEY) === '1'; } catch (e) { /* 隐私模式 */ }
    if (closed) box.hidden = true;
    $('#stage-hint-close') && $('#stage-hint-close').addEventListener('click', function () {
      box.hidden = true;
      try { localStorage.setItem(HINT_KEY, '1'); } catch (e) { /* ignore */ }
    });
  })();

  /* ══════════ 会话首页的「更新报告」══════════
     内容走本地数据（下面这个数组），不接线上更新检查，离线也看得见，
     改完刷新界面即可，不用重新打包。

     要改内容只改 STAGE_CHANGELOG：新的放最前面，数组第 1 条会带「最新」标记。
     字段：version 版本号（与 resources/app/package.json 的 version 对齐）
           date    日期 YYYY-MM-DD
           items   这次改了什么，一条一行，写给用户看（别写内部术语）
     数组清空 → 整块不渲染，.stage-empty 回到原来的居中布局。
     卡片由本段自己 insertBefore 进 .stage-empty，不动 index.html。

     右上角 × 关掉后，把当前最新那一版的 version 写进 localStorage
     （qa.stageReportClosed），下次启动版本号对得上就整块不渲染。
     所以要重新推给所有人，必须把 version 改成新号；只改 items 而不动 version，
     已经关掉过的用户不会再看到。version 与 date 都为空的条目退化成
     「只在本次会话内关闭」，不写盘。 */
  var REPORT_KEY = 'qa.stageReportClosed';
  /* 条目按「新增 / 修复 / 优化」开头，渲染层据此分组；同一件事只留一条。
     新版本加在数组最前面。 */
  var STAGE_CHANGELOG = [
    {
      version: '0.5.2.8',
      date: '2026-11-05',
      items: [
        '新增 设置里多了「内容分级」四档（全部放行 / 只拦 R-18 / 拦 R-18 + R-15 / 仅 R-0），随机图和发送图片段都按它拦，改完立即生效，旧配置自动折算',
        '变更 QQ 连接只剩一个入口：设置里的「连接 QQ」整块移除，统一到「工具 → 连接」；同一组地址和令牌不再有两套表单',
        '变更 日志只剩一个入口：连接页底部的「应用日志」面板删除，原面板里的「写进文件的详细程度」搬进日志页并改名「记录级别」',
        '变更 引导顺序按依赖重排：接口地址 → 模型 → 连通性 → 协议端 → 白名单（白名单要靠协议端拉群列表）',
        '变更 表单里的下拉和输入框统一成同一族，不再一个凸起一个凹下、圆角还差一档',
        '修复 备用模型删不掉：只剩一条时按钮是灰的，删了也不保存；现在可以删空，删完立刻落盘',
        '修复 桌面宠物的「已有 API 配置」是空白框：选项填充后没同步自绘按钮的文案'
      ]
    },
    {
      version: '0.5.2.7',
      date: '2026-11-05',
      items: [
        '新增 「工具 → 日志」页：按级别、模块、关键字筛选，可以按日期往前翻磁盘上的历史日志，也能跟随实时流；点一行展开完整正文，还能下载某一天的日志文件。级别四档都有可分辨的勾选态，模块下拉列出当天各模块的条数且不会随筛选收缩，选过的模块随时能直接切回别的',
        '新增 磁盘日志翻页到扫描上限时会明确提示「已到本次扫描上限（32MB）」，不再显示成「没有更早的了」',
        '新增 扩展锻造台读文件支持分段：一次最多回 400 行，并写明共多少行、本次读到哪一段、下次该从哪里接着读',
        '新增 闸门把同一条规则在多个文件的命中合并成一张卡，卡里列出全部位置，不再刷出一屏几乎一样的警告',
        '新增 磁盘上没被登记的扩展目录（历史撞名留下的、手工拷进来的）会在日志里提示一次，不会自动删除',
        '修复 因需要本机能力被拦下的第三方扩展，卡片上没有「信任并重试」按钮：界面与后端此前都在匹配一句已经改过的文案，现在统一按准入闸给出的原因码判断',
        '修复 日志里的失败全被记成 INFO：失败、拒绝、超时与正常统计在日志文件和日志页里都是同一级别；现在按语义分级，可以直接按级别筛出问题',
        '修复 随机发图失败时日志里一个字都没有：取图条数、每张图的下载尝试与最终结论、配置不合法现在都会落盘',
        '修复 把「写进文件的详细程度」改成 debug，重启后又变回 info：这个设置此前只改内存、没写进配置',
        '修复 装同名扩展会落出两份目录、卸载反而把它「复活」：现在同一 id 只能装一份，冲突时直接拒绝并说明已有的是哪一份',
        '修复 第三方扩展可以占用内置模块的 id，占上之后锻造台整块消失：内置模块的 id 现在由一份名单统一保护',
        '修复 「导入 zip / 文件夹」会造出 `_1` 副本：与锻造台安装复用同一套 id 判据，同 id 与撞目录名都拒绝',
        '修复 同一口令重复安装会堆出好几份「待安装」草稿：现在按内容去重，命中时直接用现有草稿',
        '修复 丢弃草稿没有二次确认，误点即删：现在按来源区分提示语，确认后才删',
        '修复 解包时因体积超限没解出来的文件被静默丢掉：现在逐个说明少了哪些、为什么，并醒目提示这个包可能不完整',
        '修复 后台空转：设置页的状态刷新被两路轮询各刷一半、顶栏身份区叠成约 2.5 秒一跳、无壁纸时看门狗仍每 3 秒空转，现在按实际条件运行',
        '优化 随机发图改为按需下载：此前要 1 张也并发下 4 张、丢掉 3 张，现在并发数等于实际需要数，某张图本身没了才补取一轮',
        '优化 启动时清理一次过期临时图：以前不发图就不清理，上次会话残留的临时图会一直留在磁盘上'
      ]
    },
    {
      version: '0.5.2.6',
      date: '2026-11-04',
      items: [
        '新增 会话详情里已发出的图片能看到缩略图了：以前只剩一行「已发送到 QQ ·[图片]」，看不出是哪张；现在会显示限宽缩略图，配文和时间都保留',
        '修复 开着代理（Clash / Mihomo 等）时搜图、发随机图全部失败，提示「域名解析到内网」：代理会把所有域名解析到基准测试保留段，此前被误判成内网；现在这类地址正常放行，真实内网地址仍被拒绝',
        '修复 勾选了「允许图片下载访问内网地址」，图片搜索和网页抓取还是被拒：这个开关以前只管图片下载，现在所有联网请求统一遵循',
        '修复 在设置里填好白名单后，页头体检卡还停在「还没有配置白名单」：现在自动保存一完成，这张卡就按最新配置更新，补齐后整张卡消失，不用切页签或刷新',
        '修复 保存设置后，左侧「配置就绪」小标和分区的未配置小橙点不跟着变：现在它们和页头体检卡一起刷新',
        '修复 顶栏「配置」状态和设置页体检卡说法相反：Base URL 只填了空格时，顶栏说已配置、体检卡说还没填；现在四处（体检卡、侧栏、引导、顶栏）用同一套判定',
        '修复 有图但预览拿不到时，会话里和纯文字消息长得一模一样：随机图走 base64 模式、AI 绘图留档失败时没有可预览地址；现在会标上「无预览」以示区分',
        '修复 新手引导第 5 步永远打不上勾：它读的会话列表根本不带「已发送」记录，机器人回过话也显示没应答；现在改读后端统计的发送条数',
        '修复 「随机发图」一调用就报「接口地址不是合法 URL」：设置里原本没有接口地址这一项，代码读到的永远是空值；现在多了「接口地址」，默认填好 lolicon，开箱可用',
        '修复 「随机发图」取到图后仍报「图片读取失败」：取图结果交给发送层时字段名不一致，地址被读成空值；现在两侧统一，能真正发出去',
        '修复 只预览了一张图、实际没发出去，界面却显示「已发送到 QQ」：预览返回的"未发送"标志挂在另一层，记账逻辑读不到；现在能正确识别',
        '修复 取图接口换了返回格式后一张都拿不到：以前只认一种旧格式，地址填对也判成「拉不到图」；现在能识别 lolicon、cnmiw、anosu 等几类实测有效的格式',
        '修复 随机图偶尔因为单张体积超限整批失败：现在默认取压缩后的 regular 尺寸，不再拉到超过 4MB 上限的大图而作废'
      ]
    },
    {
      version: '0.5.2.5',
      date: '2026-11-04',
      items: [
        '修复 连接页点「显示」看到的还是密码圆点：按钮只把掩码换成明文，输入框类型一直是密码，所以看起来毫无反应；现在会真正切换成明文，再点「隐藏」变回圆点',
        '修复 隐藏令牌时会把刚输入的内容冲掉：以前不管你有没有改过都填回掩码；现在只在你没动过时恢复掩码，新输入或清空的值会保留到保存',
        '修复 读取令牌期间继续输入会被覆盖：请求返回时若你已经改了内容，迟到的结果不再写回输入框',
        '修复 连接端点的四个字段挤成三列加一列：HTTP 令牌会单独换到下一行，现在把地址和令牌分成两行，两个令牌的输入框与按钮始终同排',
        '优化 令牌字段的说明从占位符移到字段下方，占位符改成「输入 WS 令牌」这类动作描述；补上标签关联与读屏名称'
      ]
    },
    {
      version: '0.5.2.4',
      date: '2026-11-04',
      items: [
        '修复 左栏选中项的蓝色竖条不见了：二级导航按钮的起始标签漏写闭合符，竖条被当成属性吞掉；现在补齐标签，市场、技能、插件、人设等页面的选中标记都能正常显示',
        '修复 左下角「开始对话」「会话选择」「会话设置」三个按钮过于方正：它们误用了小标签的圆角，现在按主按钮和次级按钮分别调整为 8px 与 6px',
        '修复 备份页的按钮和说明挤在一起：操作按钮组缺少自身的上下留白，没有提示文字时又紧贴下面的折叠区；现在统一按钮组间距，字段说明的节奏也一并整理',
        '修复 配置选项藏在折叠区里：连接端点、安装指引、本地导出内容、工具分类、扩展与人设说明、用量数值和统计口径改为默认展开；原始报错、日志和诊断轨迹仍然收起，那些是排查时才看的内容',
        '修复 切换用量时间范围会把刚收起的内容重新展开：折叠状态以前只从页面上读，切换范围时页面重建就丢了；现在按维度与区块记住你的选择，刷新、切换范围和出错重试都保持不变',
        '修复 控件与面板的圆角不统一：主控制台此前混用了 18 种圆角值，现在收敛为六档——小标签、输入框、按钮、面板、大容器和胶囊各用一档，圆形头像与窗口边角保持原样'
      ]
    },
    {
      version: '0.5.2.3',
      date: '2026-11-04',
      items: [
        '修复 「自动修复」多文件落地失败后无法回滚：以前写完真实文件才保存快照索引，第二个文件写入失败或进程中途退出时，第一个文件已经改了却没有回滚入口；现在先保存原始快照再逐个替换，中断后可回滚或重试，重试不会把已修改的文件当成新原版',
        '修复 Windows 下内置扩展被误判并拒载：指纹按原始字节比对，检出或打包时的换行差异（CRLF 与 LF）会被当成内容篡改，桌宠和分层记忆因此加载失败并提示「触碰高危能力」；现在比对前统一换行，二进制文件保持原样，真失配时直接报出是哪个文件',
        '修复 并发打开用量统计偶发报错：复用在途请求时变量拼写错误，同一范围的两个请求同时发出就会失败',
        '修复 暂停或关闭后任务仍继续执行：群禁言查询返回后没有复核状态，提醒停止后仍续发剩余条目并重挂定时器；关闭与重置数据现在会等待在途任务收尾，模型响应被取消时保留真实原因',
        '修复 协议重连后账号信息串号：登录查询没有绑定发起它的连接，旧连接迟到的结果会覆盖新账号，影响自我消息过滤和艾特判断',
        '修复 移出白名单后队列仍可能发消息：入队时的准入结果被当成整个异步发送流程的有效授权，排队和失败回退期间撤销的会话仍会收到文字、图片、表情和拍一拍',
        '修复 导入回滚与开发文件工具的路径边界不完整：回滚会信任备份清单里的相对路径，越界路径或目录联接可读写数据目录之外的文件',
        '修复 扩展安装可能覆盖已有目录或留下半成品：同名候选耗尽时会直接使用最后一个已占用的目录；写入中途失败还会留下能被加载的残缺模块',
        '修复 工具资源未完整释放：壁纸停用后旧定时循环仍会复活，图片头读取失败泄漏文件句柄，ffmpeg 安装失败遗留暂存目录',
        '修复 技能声明的 0 号提示词优先级被改成 50：合法的最低优先级被当成缺失值'
      ]
    },
    {
      version: '0.5.2.2',
      date: '2026-11-04',
      items: [
        '修复 窄窗下页面和弹窗内容被挤出屏幕：会话首页的固定侧栏在窄屏改为上方导航，模型设置的双栏弹窗正确纵向排列；详情列、表单、协议指引卡片、市场卡片与操作按钮组改为按容器收缩或换行，桌面布局保持不变',
        '修复 技能设置、白名单和人设预览弹窗的键盘焦点会跑到背后页面：手写的弹窗与插件面板没有接入统一的焦点管理，Tab 会跑到背后的页面上；现在按实际层号判定顶层，叠层时 Esc 只关闭最上层，关闭后焦点回到触发它的按钮',
        '修复 暗色主题下辅助说明难以辨认：辅助文字在卡片上的对比度只有约 3.29:1，低于正文 4.5:1 的下限；调亮后在三档面板底色上都不低于 4.5:1，亮色主题原本就达标、未改动',
        '修复 技能和插件首次读取失败被显示成空列表：以前会引导你「去安装扩展」，实际只是请求失败；现在显示错误原因和重试入口，已有列表的后台刷新仍保留缓存'
      ]
    },
    {
      version: '0.5.2.1',
      date: '2026-11-04',
      items: [
        '新增 备份可以直接导出离线副本：不需要配置任何上传目标，勾选要备份的内容后保存成 ZIP。桌面端弹出保存对话框，网页端直接下载；不上传，也不计入备份历史',
        '新增 本地备份目录可以浏览选择：桌面端点「浏览…」选文件夹，不用再手抄路径',
        '新增 添加备份目标时说明三种方式的区别：本地目录、WebDAV、S3 兼容各自适合什么场景、要填哪些项、有什么限制，切换类型时内容跟着变',
        '修复 备份恢复只能全量导入：预览现在列出可恢复的类别、会话数、文件数和体积，可以逐类勾选后执行；至少选一项才能恢复',
        '修复 导出到本地的备份无法导回：以前只能从已配置的目标列表恢复，导出的 ZIP 拿回来没有入口；现在桌面端和网页端都能直接选择本地 ZIP 或 QQAB 文件，走与目标恢复完全相同的校验、解密、预览和导入流程',
        '修复 备份设置拥挤且层级不清：整理说明和空状态引导，区分分组标题与字段标签，压缩字段和类别之间的留白；窄窗时侧栏与表单控件自适应'
      ]
    },
    {
      version: '0.5.2.0',
      date: '2026-11-04',
      items: [
        '修复 Windows 覆盖安装会丢失数据：NSIS 升级会清空整个安装目录，包括运行时生成的 data。安装版的数据目录改到 %APPDATA%\\qq-agent\\data\\，升级不再受影响；免安装 zip 版仍用 exe 同级的 data，便携用法不变',
        '修复 桌面应用显示名不统一：Windows 的安装目录、可执行文件和卸载列表改用「QQ Agent」，下载文件名仍保留小写的 qq-agent；进程与快捷方式使用同一个应用 ID，通知能归到正确图标。内部应用名与数据目录固定为小写 qq-agent，避免显示名变化导致数据路径漂移',
        '变更 更新后需要重新安装一次，让安装目录名称和数据位置同时生效'
      ]
    },
    {
      version: '0.5.0.0',
      date: '2026-11-03',
      items: [
        '变更 从上游项目 fork 独立维护：界面上的「洛版」字样全部去掉，统一叫 QQ Agent。新版本在 Windows 上会被当成另一个应用，与上游版本不共用任务栏分组和开机自启，升级前请手动卸载',
        '变更 在线更新检查默认关闭：更新源以前指向上游项目的服务器，现在默认不联网、不检查。需要时可在配置文件里填自己的更新源地址打开',
        '变更 用量遥测默认关闭：以前每 6 小时会把匿名调用次数和 token 用量发到上游项目的服务器，且没有开关。现在默认不发任何数据，本机的统计照常累计',
        '清理 不再随包分发上游官网的落地页与三个市场静态页：应用里从不加载，留着只会让人以为还能用。上游的社区渠道（意见箱 / 金句墙 / 三个市场）仍照常可用，应用内按钮指向不变'
      ]
    },
    {
      version: '0.4.9.2',
      date: '2026-11-03',
      items: [
        '新增 可复现的打包：以前安装包靠人工构建，现在一条命令产出安装包与免安装 zip，安装包约 127MB、免安装包约 158MB',
        '新增 安装包是用户级安装，不写 Program Files，可选安装目录，卸载时保留 data（群聊记录、记忆、API Key 都在里面）',
        '新增 运行方式文档：环境变量、网页模式的鉴权与端口规则、数据目录、多实例、常见故障，README 里可点进去看',
        '修复 网页模式（浏览器打开控制台）配了访问令牌后，壁纸换不了、背景图变成纯色：这两处资源由浏览器自己发起，带不了令牌，而令牌传递以前只覆盖了部分请求。现在统一走同一个出口，以后新增这类资源也不会再漏',
        '修复 壁纸缩略图与桌宠预览图在浏览器里加载不出来（原因同上，用错了令牌来源）',
        '修复 打出来的安装包缺三个运行依赖：打包配置里那条排除规则被依赖收集器误当成了自己的规则，把 js-yaml / undici / ws 一起排掉了。本机测试能跑纯属巧合，换台机器会直接起不来',
        '修复 四段式版本号导致打包直接失败：打包工具只认三段，现在构建期间自动转换，结束后原样恢复',
        '修复 浏览器打开控制台时端口写死成 3210：实际端口会因占用或多实例而变化，以 data/console-port 为准',
        '优化 页面标题与窗口标题的版本号现在跟着 package.json 走，不再各写各的'
      ]
    },
    {
      version: '0.4.9.1',
      date: '2026-11-03',
      items: [
        '优化 ffmpeg 改为按需下载：它以前随包分发（占安装包 79MB，而安装包总共 186MB），但它只服务大图压缩、GIF 转视频、视频抽帧、动态壁纸导入四项功能，纯文字聊天用不上。现在在「设置 → 媒体工具」里按需下载，安装包预计降到约 107MB；不下载时这四项各自降级，不会报错',
        '新增 可以直接用系统里已装的 ffmpeg：设置页新增「优先使用哪一个」，可在「手填路径 / 下载安装的 / 系统安装的」之间切换并按组调整优先级，切换后即时生效不必重启；设置页同时列出本机实际可用的 ffmpeg 及其版本',
        '新增 下载源四选一（git.yylx.win 镜像 / gh-proxy 镜像 / GitHub 官方 / 自定义前缀），下载后做 SHA-256 校验；有代理时自动改走官方直连（镜像本就是替代代理用的，代理加镜像等于多绕一跳）',
        '新增 可选填 GitHub Token（只发给 GitHub 主机，绝不发给镜像站），用于共享出口 IP 时绕开 GitHub 限流（60 次/小时 → 5000 次/小时）',
        '修复 装了一份但不能用的 ffmpeg 也会被识别：检查是否具备本应用需要的 libx264 编码器与 scale 滤镜，缺失时说明缺什么并给出下载入口，而不是显示「已安装」却让功能莫名其妙地失败',
        '修复 视频读取看不见已安装的 ffmpeg：该模块只查系统 PATH，随包的、设置页下载的、手动指定的都看不见，表现为同一个安装包里「图片压缩能用、视频元信息读不出」。现在五处（图片压缩 / GIF 转视频 / 视频读取 / 视频抽帧 / 动态壁纸）统一走同一条解析链',
        '修复 ffprobe 用裸名查找：ffmpeg 在非 PATH 目录时，明明同目录就躺着 ffprobe.exe 却找不到，只能退化到解析 ffmpeg -i 的文本。现在优先用同目录那份',
        '修复 含空格的安装路径下找不到随包 ffmpeg：路径取法会把空格变成 %20，C:\\Program Files\\… 必然失配。解析链重写后这条路径不再存在',
        '优化 媒体工具页重新组织：已安装时不再顶着大号「下载并安装」按钮，下载源 / Token / 删除等设置收进可折叠的「高级」区'
      ]
    },
    {
      version: '0.4.9.0',
      date: '2026-10-24',
      items: [
        '新增桌宠：桌面右下角住进一个 Live2D 小伙伴（入口：工具 → 桌宠）。单击它弹「今日用量」卡片（花费 / 调用 / 输入输出 / 缓存命中率 / 会话数），双击开开发工单对话窗；置顶、鼠标穿透、大小、透明度、待机动作与表情都能调',
        '新增自己的桌宠角色：桌宠页可导入 Cubism 4 模型，动作组和表情会自动读出来（随包默认角色就是 DS鼠控版，8 个动作组 / 44 个表情；换成自己的模型也一样，动作和表情会自动读出来）。⚠️ 导入前先完整退出应用（含托盘），否则运行中每 5 秒的状态落盘会把新模型覆盖掉',
        '新增壁纸管家：设置 → 外观与数据 → 界面背景 里点「🎨 打开壁纸库」，能换壁纸、调效果（亮度 / 对比 / 饱和 / 模糊）、一键关掉；装了 Wallpaper Engine 还能翻创意工坊的库、换小红车壁纸、控制播放与暂停，也能把当前壁纸设成软件自己的背景',
        '修复 GIF 永远按图片发：勾了「视频输入」也没用 —— 转码要用的 ffmpeg 只在系统 PATH 里找，而包里明明带着一份。现在先找随包那份，实测 96×72 的 1 秒 GIF 能转成 24 帧视频',
        '修复读不出视频时长 / 分辨率：没有 ffprobe 时改用 ffmpeg 自己报的元数据兜底，不再直接放弃',
        '修复更新检查「假装已是最新」：服务器上的版本号没跟着发版更新时，界面以前照样显示「已是最新」，和真的最新分不开；现在会明说「更新源还没推进，所以不会提示更新」',
        '修复桌宠在别人机器上打不开：它之前不在随包清单里，收包的人会被安全闸拦下、显示「触碰了高危能力」；现在已随包登记，换台机器也能直接用',
        '修复自检命令：以前那两条命令指向开发目录，在发行包里必然报错；现在直接跑 tests 下的用例（67 个，含新增的 6 个）',
        '修复群禁言插件的文件指纹与清单对不上（已重算），以及信任清单里还留着一个早就删掉的插件名（已清掉，避免占名绕过安全闸）',
        '修复发布包漏文件：以前包里的内容可能和安装目录对不上（这次就漏了桌宠和壁纸整整两批文件，同版本号却是两份内容）。现在打包后逐文件比对，589 个文件与安装目录一一对应',
        '优化 安装目录名：改为「v0.4.9.0」，和设置页显示的版本号对齐；已有配置、记忆、聊天记录、表情库原样保留',
        '桌面悬浮小窗换了默认档：现在默认就开着，默认「真·透明 + 背景 50%」—— 卡片浮在桌面上、直接看得见桌面（贴边自动收起仍是默认开，拖到屏幕边上会收成一条细缝、鼠标移近即展开）。改的只是默认值，已经用过的老配置保持原样不变',
        '「桌宠」从一级入口挪进了「工具」左栏（和「连接 / 自检」并列）：一级导航从 6 项回到 5 项。桌宠窗口右键菜单里的「打开控制台」、双击角色仍能直接进这一页',
        '修掉「一进自检页就白屏」：体检单的「忽略 / 恢复」那段（已忽略区 + 每条问题上的忽略按钮）在合并时被连带删掉，只剩两处引用，打开就报 ReferenceError。已按原样补回，忽略清单落盘在后端、重启后仍生效',
        '修掉「解禁了机器人还装聋」：禁言复检的几个关键件（60 秒复检间隔常量、强制刷新成员列表的 no_cache、复检翻案与宽限期）也在同一轮合并里丢了，导致复检永远读到旧值、解禁通知一丢就永久装聋。测试从 4 红变成全绿（67/67）',
        '修掉「桌宠一直显示正在加载」：桌面上的角色明明已经出来了，控制台卡片却永远停在「正在加载」、预览也生不出来。根因是主进程取不到桌宠服务（后端有三个访问器没导出），角色反向上报的「已加载」落进了空对象；现在动作预览、表情预览、屏幕观察、单击用量卡片、双击工单全部恢复',
        '另外补回两处被上游旧版整份盖掉的本地改动：桌面悬浮小窗的圆角处理（关掉真透明、改用毛玻璃档时，窗口四角会露出一块深色弧片），和启动失败提示条的「详情」折叠（修好之后首屏只显示一句人话，英文堆栈折在详情里，不再直接甩给用户）',
        '桌宠页重新做了一遍界面：以前那套样式引用的颜色变量在整体换肤时就被删了 —— 边框、圆角、底色全失效，所以这页看着和别的页面格格不入。现在和「连接 / 自检」页同一套版式：顶部的状态信息收成一条细横条（插件 / 桌面窗口 / 当前角色 / 桌宠，正常时不吵、出问题才多一行说明），分区改成带标题线的面板，页内导航滚动时自动高亮，导入角色、找回位置这些按钮都归到各自面板的右上角；所有勾选项也换成了和设置页一样的滑动开关',
        '连接页：连不上时页头就有「重新检测」按钮了（以前唯一的测试按钮藏在折叠的端点设置里，装好协议端只能干等）。状态区改成「一句话结论 + 三行事实 + 折叠的诊断详情」，每种状态直接说下一步该查什么；右边那句和标题重复的"没检测到协议端"换成了检测时间。「装一个协议端」没连上时自动展开、连上后自动收起；两张卡的第 1 步统一成「从官方仓库获取并安装」，都直接给出官网地址；协议端装完要人工把 QQ 接进来，所以两张卡下面都直接给出了控制台地址（SnowLuma 5099 / NapCat 6099），带一键打开和复制'
      ]
    },
    {
      version: '0.4.8.9',
      date: '2026-10-22',
      items: [
        '表情包会自己收图了：以前只有你亲口说「收藏这个」它才收 —— 24 小时群里过了 70 张图，只进了 5 张。现在刷到合适的图 / 表情会主动收下来，「先看图确认」也不再是必做步骤；「确实」「乐了」这种三五个字的短回应，也会顺手配一张',
        '短回应终于等得到那张表情了：「发完就收尾」的省 token 机制会直接掐掉第二轮，表情永远排在不存在的下一轮。现在只对短回应（不超过 10 字）或刚有人发图的情况松一次口 —— 单独给它一轮把表情补上，同一个群 5 分钟最多一次，其余照旧立刻收尾（宽限一次约多花 19K token，所以卡得很紧）',
        '人设预览终于像个正常窗口了：以前点「预览」弹出的是浏览器默认样式的一坨 —— 关闭键是个小灰块、正文是挤在一起的等宽小字。现在是一张正经的浮层卡片，看得清、能滚动，按 Esc 或点外面就关',
        '新增「下载 → 已安装 → 人设」一页：装过的人设终于能看全了。之前装完就找不回来 —— 看不到有哪些、也切不走删不掉；现在能预览、能切换、能删，还能改',
        '人设页和技能 / 插件页长得一样了：同一套网格卡片、同样的说明折叠条和筛选，切过去不用重新适应',
        '会话设置里也能管人设：左栏「扩展」多了第三项。这里看到的是全局人设，卡片上会写明「全局人设 · 所有会话共用」',
        '人设卡上能直接改了：自定义人设右上角有齿轮，改名称、正文、附加规则都在一个弹窗里，支持把 .txt 拖进去。内置人设改不了（正文写在程序里）',
        '人设同时只能用一个：开一个会自动关掉另一个，并明确告诉你「某某已自动关闭」—— 以前两个开关能同时亮着，看着像能同时启用',
        '换人设会把它自己的附加规则一起带过去：以前只换了角色设定，上一个人设的「管理员附加规则」会残留下来，两套设定串在一起',
        '切换不生效时会说清原因：分会话单独配过人设的、开了主人专属人设的、覆盖了系统提示词却没留占位符的 —— 这三种情况以前切了没反应，现在页面顶部会直接点出来',
        '插件和技能页能按来源筛了：内置的、自己后来装的，一眼分开',
        '点「下载」不再卡一下：市场页每次切回来都整页重建几百张卡，现在数据没变就不重建，切页几乎瞬间',
        '装完插件不用重新往下翻了：列表不再被弹回顶部，你正在看的位置保持不动',
        'SnowLuma 的日志不再自己往下跑：以前每 15 秒刷新一次就把你拽到最底下，正在读的那一行瞬间不见；现在刷新只更新内容，位置不动'
      ]
    },
    {
      version: '0.4.8.8',
      date: '2026-10-22',
      items: [
        '修掉「机器人明明记得，问它却检索不出来」：分层记忆的词表被硬卡在 2 万词，而被挤掉的恰好是中文里最常用的实词 —— 群友天天聊的东西全在裁剪名单里，检索自然搜不着。三处根因一起改：短词剪枝不再误伤中文、超上限时优先淘汰「区分不出内容」的词、群号和日期这类每个块都带的碎片不再占词表位置。词表从 2 万回到 2.7 万，中文单字从 0 回到 2126，同一批问题的检索从 0/5 命中变成 5/5。另外设置页现在能看到记忆整理相关的 4 个阈值了（以前只写在代码里，界面上找不到）',
        '修掉「重建一次记忆索引，机器人对老熟人的印象就全没了」：块目录名和内部记录用的键格式不一样（一个下划线、一个冒号），重建脚本按目录名传进去时查不到旧记录 —— 熟悉度、提及次数、关系强度全部静默退回初始值，还不报错。现在两种格式都认，实测 52 个块的权重逐块还原',
        '修掉「模型配置里换了 API Key 却不生效」：同一个弹窗里「清除」写的是提供商槽位、「保存」却写到顶层字段，而运行时的优先级是槽位高于顶层 —— 于是清得掉、换不掉，界面显示新 Key、请求还在用旧的（一直 401）。现在保存也写槽位，改完重启生效',
        '修掉回复整句被方括号包住：上下文里 [图片] [表情] [引用…] 这些系统标记太密集，小模型会照猫画虎把自己的整句也包一层；现在提示词里立了规矩，发送前还有一道兜底 —— 只剥「整条恰好是一对方括号」且不超过 60 字的那种，句中括号和 CQ 码一律不动',
        '修掉合并转发的聊天记录点开是空的：QQ NT 里转发消息的 id 常是负数，以前把负数直接丢给协议端会被当成另一个 id 去拉、报「payload 为空」；现在先取原消息、从转发段里抠出它自带的 id 再拉，正负都能用。引用别人的转发时也不会再撞一句看不懂的报错 —— 以前引用块里显示成英文的 [forward]，模型以为还有条转发没展开、回头去拉那条引用消息、必然失败；现在引用里直接写明「合并转发聊天记录」并把那条转发的编号带在引用块里（`[引用 #1161151700 名字：…]`），想看全就展开这个号；真拉错了也会直说「这条不是转发」，展开后转发里的图会一起给出来（最多 4 张），不会只剩一排 [图片]',
        '修掉设置页弹窗「点了没反应」：白名单里挑完群点确定，界面没动静、群里也没加上 —— 弹窗背后的提示节点会随设置页重渲染消失，旧代码往一个已经不存在的元素写文字，抛错后整段流程就断了；现在提示写不进去就直接跳过，目标输入框也会在点击那一刻重新确认，真找不到就明说「回白名单页签再点一次」',
        '修掉「两个号同时被注入也不管」：以前「只给一个号装注入」只是说明里的一句话，真检测到第二个号也被注入时不会有任何动作；现在会立刻处理，并说清楚是哪个号抢了端口、该保留哪一个',
        '省下三处白花的钱：① 系统提示里每轮都会变的那几句不再顶掉前缀缓存，命中率从 79–86% 回到 92% 档；② 启动预热不再重复发一遍、白占上游并发位；③ 发完语音 / 图片 / 跨会话消息后不再多跑一轮收尾，每句省约 19K token',
        '雪茹的两处日志问题：日志总量收到 256 MB、只留 3 天，不再越跑越占盘；设置里填的目录实际不存在时，日志里会直接说明白，不再只是静默不记',
        '修掉安装包的三个问题：① 超 4 MB 的图要先压缩，以前在新装的机器上这一步会静默失败（既发不出去也不报错）—— 现在 ffmpeg 随包分发，装完即可用，不用自己另外装；② 不再多带一份安装器备份，装完的目录更干净；③ 打包前自动体检（依赖是否齐全、该随包的文件在不在、有没有残留的备份 / 崩溃转储 / 锁文件）。代价是安装包从 166.8 MB 涨到 186.3 MB',
        '20 日那个 0.4.8.7 安装包打在上面几处修复落盘之前，装过旧包的覆盖安装即可补齐',
        '被 @ 不再装没听见：机器人以前经常认不出群里 @ 的是自己（群名片、QQ 号、角色名对不上就直接跳过）。现在系统提示里同时给出这三个锚点，每条被 @ 的消息还会标注「这一条 @ 了你本人」；同时修掉一个硬伤 —— 被点名时它若想直接结束对话，以前会拦下一次却仍然结束、群里什么都不回，现在拦下后会真的再走一轮（同一句话实测：以前静默，现在正常回复）',
        '「嘴上说了发表情、实际只发了文字」修好了：以前提示它先发文字、再单独发表情，而分两轮会被「发完就收尾」的逻辑砍掉第二句；现在文字和表情放进同一次调用里一起发',
        '发表情频率按库存自适应：库里 0 张就不再承诺发表情（空库时提示词会明说别答应）；1–3 张每 3–5 轮 1 张、4–9 张 2 张、10 张以上才按你的配置档 —— 不会再出现素材只有一两张却被反复点名去发',
        '收藏表情能带标签和用途了：收藏时顺手填 note / tags / usage 三样，之后挑选时按标签挑得更准；重复收藏会覆盖旧标签，已收藏的不会自动补',
        '自动修复不再「改到一半死透」：以前一个工单的批准票只能用一次 —— 应用失败或回滚后再申请必然被拒，而提交又要求先验证通过，工单直接卡死。现在验证失败 / 回滚后会自动重新发批准票，暂存区保留可以重跑；提案在批准之后又被改动也会明确提示，而不是静默失败',
        '四个开发类工具搬进软件本体：系统自检 / 自动修复 / 扩展锻造 / 开发工单不再是「插件」，不在插件列表里显示、也不会被误卸载或误禁用。代价是这四个模块改完不再即时生效，需要重启应用；左栏「工具」二级页签名也改回 harness（这一页已经是自检 / 对话审查 / 自动修复 / 锻造 / 工单五块的工作台，叫「自检」名不副实）',
        '自动修复的开关找到了：内置化之后开关不在插件页，「自检 → 自动修复」页的未启用状态里现在直接给「开启自动修复」按钮，写活配置、不用重启；页面里那些「去插件页找它」的过时指路也全部改掉了',
        '视频抽帧 / 视频理解修好：安装包里明明带了 ffmpeg，插件却只在系统 PATH 里找，于是一直报「未找到 ffmpeg」。现在优先用随包的 ffmpeg.exe，装完即可用，不用自己另外装',
        '语音消息不再「时好时坏」：探测期间的状态以前会被乐观放行，每 60 秒翻转一次，系统提示里的「语音消息」段跟着反复增删 —— 这一项实测占掉全天约 28% 的缓存 miss（约 15 万 token）。现在探测期间一律显示不可用，状态稳定；要真正用上语音转文字，还需在设置里填模型文件路径',
        '密钥读取不再「同源就能读」：以前伪造一个同来源的请求头，就能把控制台密码明文读出来。现在密钥类接口一律拒绝（除非在配置里显式打开），配置接口里的 Key 也已脱敏；实测无凭据 / 伪造同源 / 跨源三种来源全部被拒',
        '接口报错不再冒充 502：模型没配 Base URL、人格市场传了不存在的 id，以前都返回 502（看着像服务端坏了），现在返回 400 / 404 并说明原因',
        '被 QQ 拒发的消息现在记进用量账本：以前拒发的消息在应用日志和用量统计里都看不到（错误计数恒为 0），只能翻协议端日志；现在按调用计数记进去',
        '本版发布前做了 774 项全量体检（代码 / 加载 / 基线 / 数据 / 日志 / 外部服务 / 安全），发布包也做了泄漏扫描 —— 密钥、群聊记录、协议端凭据均确认未随包分发；从 10-21 的记忆检索与安装包修复，到今天的被 @ 回复、表情策略、自动修复与内置化，全部并入 0.4.8.8 这一条'
      ]
    },
    {
      version: '0.4.8.7',
      date: '2026-10-20',
      items: [
        '新增「卡住了？自助排查」卡片：卡在「机器人连接中」满 20 秒就自动出现，按现场分四种情况 —— 没指定机器人的号 / 指定的号没登录 / 注入装好了但网关没起来 / 网关没跑 —— 每种给一句话说明和一个能直接点的按钮，点一下就把那个号接上，或者只重启网关',
        '新增「🛡 安全开关」（工具与技能页）：浏览域名白名单（锁定后只允许访问名单里的站）、允许图片下载走内网地址、额外放行的主机 —— 这三项以前只有配置文件里有，界面上根本找不到；域名写成「https://xxx/路径」会自动裁成主机名',
        '新增「允许机器人发送网图」勾选框（设置 → 聊天 →「📨 信息发送配置」）：它是发图与搜图的安全总开关，和「工具与技能」里的工具开关不是一回事；总开关关着时那两张工具卡上会直接提示还差这一步，不用等调用失败才知道',
        '新增桌面悬浮小窗：桌面右下角一张小卡片，显示今日调用 / 估算成本 / 总 Token / 缓存命中率 + 机器人连接状态；可拖动、三档尺寸、可置顶、可鼠标穿透，右键菜单改成卡片内自绘的深色菜单，不再是系统白底菜单',
        '新增「贴边自动收起」：小窗拖到屏幕任意一条边 6px 内就收成一条细缝，鼠标移近整卡弹回原位、移开又滑回去（和 QQ 一个手感）；重启后仍是收起状态',
        '新增「背景不透明度」滑条：30%~100%，默认 100% 就是原来的深色小卡；调到 100% 以下变成半透明磨砂，拖动时卡片半秒内跟着变色，设置页和小窗右键菜单里都能调',
        'SnowLuma 页重新排过：首屏按钮从 18 个降到 8 个，控制台地址 / 密码 / 重置密码 / 连接排查 / 三块日志全部收进两个折叠区（出问题才需要展开）；节点名和按钮全换成动作句 ——「单独启动 QQ」改成「启动机器人的 QQ」、「切换到此账号」改成「就用这个号」、「仅保存」改成「先记下」、「取消注入」改成「停止接入」',
        '设置页的静默保存终于有反馈了：页头右侧出现 2.4 秒后淡出的「✓ 已保存 08:58」，失败时是红色「保存失败，正在重试…」，不弹框、不占位',
        '技能页从别的页签点「下载」不再空一下：有缓存时直接出完整页、不再先画骨架再重画，只有接口真慢（超过 120ms）才补骨架',
        '市场页等待超过 6 秒会把副标题改成「线路较慢，仍在等…（最长约 2 分钟）」，不再让人以为卡死',
        '市场列表加了本机缓存（内存 5 分钟 + 磁盘 24 小时）：再次进市场页多数情况立刻出内容，后台再悄悄换新；只有点「刷新」才强制重拉',
        '「仅保存」的提示说清当前状态：下次启动生效、现在仍按原来的号跑，要立刻切过去请点「就用这个号」',
        '「本机 QQ」模式的说明改成能兑现的话：只向这个号装注入、不会主动注入别的号，请确认它是机器人专用号；顺手删掉页面下方重复的第二处承诺',
        '修掉「连着个人号却显示一切正常」：以前只看“连上了没”，多号在场时谁抢到端口就是谁；现在用真实登录号与设置对账，连错号会橙色告警，并自动把抢占端口的号卸掉（卸不掉就明确让你重启那个 QQ）',
        '修掉切号时配置被提前写脏：填一个格式对但没登录的号点切换，接口报错但设置里已经记成它，之后每轮自动注入都空转；现在目标确认存在才落配置',
        '修掉「点了停止接入却照样被注回去」：网关没跑、登录失败、当前没有已注入进程这三条路径以前都不记「已暂停」，QQ 一重登又被注入',
        '修掉同一个 QQ 被连续注入两次：注入标记刷新慢于接口返回，旧判据会让同一进程被连续载入，轻则重建会话、重则丢消息',
        '修掉「重置控制台密码说成功其实没成」：停网关失败仍会删配置文件、随后新密码并没写进去，界面却报「✓ 已重置，密码：xxx」；现在端口没释放就中止，重置后先用新密码真登一次才报成功',
        '修掉切号后要等十几秒才连上：网关的令牌按 QQ 号分文件存，切号后旧令牌必然被拒；现在切号成功即按目标号对齐令牌并立刻重连',
        '修掉「被临时锁定」被说成密码错：连错 5 次网关会锁 15 分钟，以前和“密码被拒”共用一套话术、还劝你去重置（重置会重启网关、断开注入）；现在单独说明并劝你别重置',
        '修掉令牌过期被报成「进程表是空的（QQ 还没登录）」：鉴权失败的响应被当成正常数据用了，错误分支永不触发；现在一律按读取失败上报',
        '修掉网关快速重启后要等 30 秒才恢复：端口“关→开”这条变化在已连接时被吞掉，恢复只能等连接超时；现在一发现就立刻重连并补一次自动接入',
        '修掉「测试连通性」恒报 401：那个请求根本没带鉴权信息，Key 对不对都回 401；同时修掉在弹窗里挑别家模型时、服务端仍按主提供商协议去请求的问题',
        '修掉非 OpenAI 协议的「能不能看图」永远探测不出来：探测请求被写死成 OpenAI 形态，Claude / Gemini 一律 404 判成“未知”，看图工具因此被永久关掉；现在按各家自己的协议发',
        '修掉启动后 2 秒内设置页必崩一次（右下角红条「Cannot read properties of null」）：首次进设置页时状态还没到、页面读了个空值；现在状态未知时显示「正在读取机器人连接状态…」，不再误报“机器人没连上”',
        '修掉「API 协议选了保存不住」：保存一直是成功的，是保存后整页重建时下拉被缓存里的旧值回填；现在以刚写入的值为准',
        '修掉一批「保存不住」的同类问题（全站复查 9 处）：滑条松手后回弹、开关关掉又自己亮、输入框自动保存把刚打的字冲掉这类时序问题',
        '修掉 17 处「指到不存在页面」的提示：「设置 → 插件」「设置 → 模型价格」这些入口早就没了，模型报错和插件提示却一直往那儿指；现在全部指到真实位置',
        '修掉「发网图」的报错指错地方：它说去「设置页聊天设置 → 发网图」打开，而那个开关界面上根本没有；现在文案和真实入口一致',
        '修掉市场页「有时候加载不出来」：前端 15 秒就放弃而后端还在正常拉（现在前后端一并放宽到约 2 分钟）；响应体没读完时不再被当成“市场是空的”（以前会显示「共 0 个」）',
        '修掉「输入完 QQ 号连按两下回车会切两次号」：回车是第二个入口，绕过了按钮置灰；连着切两次会让同一个 QQ 被注入两遍、会话重建、可能丢消息',
        '修掉市场页每次进来都要重新拉一遍列表：上次留下的缓存时间戳被当成“刚拉的”，一进内存就过期；现在切页签不再白等一分半',
        '修掉装完插件点「刷新」还显示旧列表：刷新时若正好有条请求在途，界面会复用那条旧结果；现在刷新会作废在途请求',
        '修掉小窗「贴边收起又自己弹回来」：拖到边上松手时光标还停在判定区里，0.1 秒就被判成“鼠标移近”；现在收起后要先见到光标离开才允许悬停展开',
        '修掉小窗「鼠标移开不收回」：悬停展开的卡片现在鼠标移开就滑回细缝；从细缝拖出来的、菜单点开的则不会自己收走'
      ]
    },
    {
      version: '0.4.8.6',
      date: '2026-10-19',
      items: [
        '连续对话更省也更稳：系统提示里每轮都会变的那几句（当前场景、时间、上一条消息等）挪到了大段固定内容之后，前面的人设、插件与工具说明不再被它顶掉，能一直命中缓存；实测每轮被全价重算的部分缩到原来的二十分之一以内，聊得越久省得越明显',
        '修掉「调用明细只算最近几个小时」：弹窗写着「近 7 天」，实际只扫了最近 120 个会话文件（活跃时仅够几小时）—— 现在工具调用次数也会按天记进账本，被裁掉的老会话照样计入合计，近 7 天 / 近 30 天不再只剩今天',
        '四个统计维度（按天 / 按会话 / 按模型 / 按插件）版式统一：都是「标题 + 右侧计量 → 一行说明 → 一句结论 → 图表 → 折叠数值表 → 口径说明」，切换维度不再像换了一套设计；每块还会用一句话点出结论，比如「用量集中在哪一天」「主力是哪个模型」',
        '新增「API 协议」选择：添加或编辑模型提供商时，可以直接选 OpenAI Chat Completions / OpenAI Responses / Anthropic / Google / Mistral 五种协议，不用再靠中转站猜格式；地址留空会自动填上官方端点，测试连通性和实际对话走的是同一套协议',
        '新增网络代理：接入国外模型 API 时可以在设置里填本机代理（支持 http://），对话、拉模型列表、测连通性统一走代理；填了不支持的 socks5 会明确提示，不会装作已经生效',
        '新增「按插件」用量统计：能看清每个插件 / 技能到底花了多少 token —— 支持按「区间总消耗 / 每次固定开销 / 调用次数」三种方式排行，也能看到每次对话新进来的正文（聊天记录、人设等）占了多少',
        '新增扩展安装前体检与装完回执：清单 JSON 写坏、要求比本机更新的版本、声明的入口文件没打进包里 —— 这三类「装完一定不能用」的包现在会在安装前直接拦下，磁盘上不会留下垃圾目录；装完的提示也分成「已生效 / 已加载但当前关闭 / 加载失败」三档，不再一律说成功',
        '扩展卡片多了几种状态提示，以及一个「🔧 自动适配」按钮：「已熔断」表示工具连续失败被临时停用（几分钟后自动恢复）、「工具被关」表示工具全部进不了模型列表、「⚠️ 有警告」指放错目录或没写引导语这类「装了却没人调用」的问题；加载失败或反复出错时可以一键送进升级工作台，模型按你本机环境改好、你确认后才覆盖安装，原版自动备份、可回滚',
        '设置页的「就绪度体检」回来了：没填接口地址、没选模型、白名单空着时，设置页顶部会主动列出缺什么、点一下直达对应位置；全部就绪后自动收起，不打扰老用户',
        '启动等待改成按 24 分钟硬时间算：以前按轮数估算，遇到端口直接拒绝的情况 4 分钟就放弃，和「后台仍在重试」的提示对不上',
        '「OneBot 未连接」的横幅上多了「打开 SnowLuma 页」按钮：以前只有一行字，想处理还得去顶栏悬停找入口',
        'SnowLuma 页每 15 秒自动刷新时，不再吃掉你手上正在做的事：注入目标的 QQ 号打一半不会被重置、展开的账号列表不会自己收起、密码的显示状态和折叠块状态都会保留，光标也不丢',
        '插件装多了以后聊天不再突然变慢变贵：工具列表的频繁抖动会在 90 秒内折叠成一次变化，不会每次都把提示词缓存整段作废（实测一天抖 7 次，每次多付 1.5~2 万 token）；你自己手动开关插件仍然立刻生效',
        '修掉两类「插件明明开着，模型却调不到工具」：收藏表情的工具实际名字和提示词里写的不一致，模型每次调用都报「未知工具」（顺带补上了收藏引导，以前策略里只字未提）；带前缀的工具用短名调用现在也能自动兜底匹配',
        '修掉「好几个群友同时 @ 会漏回一个，有时还 @ 错人」：被 @、被点名、被引用提问现在按硬召唤处理，优先级高于人设里「少而精 / 挑着接」的风格要求，点名的每一条都必须回应；多人同时叫时要分别回给每个人，各自带上对方的 QQ 号；另外加了一道保险 —— 被 @ 且还没开口时，不能直接「结束本轮」混过去',
        '新增「使用引导」：第一次打开软件会自动弹出四步上手引导（配模型 / 连 QQ / 选会话 / 定人设），每步带实时完成状态 —— 配好一步就自动变绿，不用猜还差什么；随时能关掉，关掉照常进会话，不拦路也不强制跳设置页',
        '引导里点「去配置」会直接把对应的配置窗口弹出来（模型管理 / 人设编辑），省得在设置页里找不到那颗按钮；设置页侧栏留了「使用引导」入口，想回来看随时能看',
        '表情库里的表情可以自己改备注和标签了：点开表情详情直接编辑、保存，不用再让机器人在聊天里替你改',
        '修掉「Ctrl+V 时灵时不灵」：人设编辑、模型管理、社区口令粘贴都有这个毛病 —— 根因是粘贴前焦点停在只读的选择框上，按键被系统静默吞掉；现在粘完会把焦点交还给可编辑框',
        '编辑人设 / 模型这类弹窗，点窗外不再直接关闭了（误触丢内容太伤），右上角 ×、取消、Esc 照常能关',
        '配好提供商后不用再自己收尾：加完、拉完模型会自动刷新列表（不再显示「还没有提供商」），只有一个模型时直接帮你选上、多个才让你挑，新手引导也不会再卡在这一步不变绿',
        '模型报错终于说人话了：限流、Key 无效、余额不足、服务商故障、模型不存在、接口地址填错，都会给一张中文卡片讲清「发生了什么 + 该怎么办」—— 以前这些提示规则写好了却从没被调用过，你看到的始终是一串英文原文',
        '修掉「机器人思考了但没回话」：模型偶尔会把要说的话当成没加引号的参数塞进发送工具，导致整轮作废、群友什么都没收到 —— 现在会把这段话捞回来再发，实在救不回来才报错，不会凭空发错内容',
        '修掉「查看收藏的表情」打不开：插件自带的页面被安全策略挡掉了',
        '修掉添加提供商后模型名被存成一串编号：名字缺失时不再拿编号顶替',
        '默认人设「小鲸鱼」整体重写：群友反馈旧版怼人太厉害，这次降了攻击性、篇幅也砍了一半；存过旧版全文的老配置会静默换成新版，但你自己改过的人设一个字都不动',
        '修掉切换人设后被系统提示「压回去」：系统提示里写死的角色扮演已经全部搬进人设卡，切谁的卡就是谁，不会再左右脑互搏',
        '修掉「使用引导」的两处小毛病：用现成模板（含内置默认的小鲸鱼）不再被误判成「已自定义」；再次打开时步骤区也不会一片空白',
        '会话记录里能一眼看出错在哪了：模型报错会连同中文解释一起写进摘要，重启软件、从磁盘重建列表也不会丢',
        '顶栏四个就绪圆点会说话了：没就绪的会在旁边补一个红色缩写（⚠QQ / ⚠SL / ⚠OB / ⚠配置），不用把鼠标挪上去也知道缺哪一项；用你自己登录的那份 QQ、或挂外部 OneBot 的情况，不再误亮红灯',
        '「工具」入口默认先进 SnowLuma：新手点「工具」绝大多数是去启动 / 登录机器人 QQ，自检和对话审查属于进阶排查，顺序调过来了',
        '设置页顶部那两行说明不再天天占地方：第一次照旧完整显示，点「知道了」就收成一行，之后一直保持',
        '扩展页不再把「正在加载」显示成「一件都没装」',
        '内置插件 / 技能的默认顺序按重要性排了：以前按文件夹字母序，把账号池、前缀缓存这类核心项顶在最前面反而看不出重点；你自己拖过的顺序仍然优先',
        '市场页装扩展前加了常驻提醒：插件越多 token 用量越高、缓存命中率越低；本版已自带用量优化，不要再装同类的用量优化插件 —— 两者会冲突，导致都不生效',
        '修掉鼠标悬停在按钮上冒出两个提示窗口的问题：一个是软件自己的气泡、一个是系统的淡黄色小框；根因是提示文字挂在了外层容器上，而且状态刷新会把它重新写回去',
        '修掉几处界面小瑕疵：消息存档页和记忆页左栏多出来的一圈细边框（右缘一条竖线 + 上下圆角），设置里较长的标题被挤成两行',
        '更新报告本身也重排了：条目按「新增 / 优化 / 修复」分组、引号里的关键词加粗、旧版本收起成一行点开再展开；标题栏滚动时吸在顶部，条目再多也知道在看哪一版',
        '表情库顶部按钮换成图标：「重新载入」四个字挤在统计后面太占地方',
        'Windows 下任务栏 / 桌面图标优先用 .ico，显示更清晰',
        '退出时的兜底更稳：单实例提示失败也不会卡住退出'
      ]
    },
    {
      version: '0.4.8.5',
      date: '2026-10-17',
      items: [
        '自动注入的核心死锁修好了：注入成功过一次后，协议端一重启就再也不自动恢复，机器人永久掉线、界面却只显示「取消注入」—— 现在会自己重连重注入，不用重启软件',
        '「连不上」不再被当成「密码错了」：以前会白等 15 分钟、还劝你去重置密码；现在能分清是连不上还是真被拒，直接给出下一步',
        '自动注入失败后想手动注入：SnowLuma 日志里现在直接给出控制台地址、密码和三步操作；密码读不到时也不再整块消失，会给「重试」',
        '控制台里密码、配置等 7 个接口集体「读取失败」已修：根因是一处鉴权判断写错，最强的那个凭据从头到尾没被读到过',
        '密码框那团「糊掉的色块」已修：提示文字被密码遮蔽样式糊住了 —— 只有真密码才该遮蔽',
        '修掉几处会让软件自己退出或假死的问题：连接卡在半路时主进程崩溃、请求协议端没有超时、并发登录撞上「错 5 次锁 15 分钟」',
        '开箱可用：全新安装默认自动拉起协议端；启动时不再 30 秒就误报「连接超时」，等待窗口更合理',
        '记忆系统瘦身：索引里八成是重复抄写的块 id、落盘还带缩进 —— 同样的两份索引 3.6MB → 1MB，整个记忆目录 4.9MB → 2.3MB；召回门槛一个没动，命中率不受影响',
        '升级残留自动清理：旧版记忆插件覆盖安装后会留在磁盘上，和新记忆系统打架（重复注入、检索到旧数据）—— 现在启动时自动识别并清理',
        '用量页不再崩溃（一处空数据解引用）；「清空已结束会话不影响用量历史」这句提示以前是假的，现在按天汇总真的保住了，只有逐次明细会随文件消失',
        '聊天记录保存更快：以前每来一条消息就把整个会话文件重写一遍，聊得越久越卡',
        '界面某一块出错不再整页卡死：前端加了全局兜底，单个脚本异常不会拖垮其它功能',
        '还有一批稳定性修复：删了人设后残留旧人设、启动项重复、锁冲突被误报成「启动失败」、退出清理卡住会超时兜底、磁盘写满提前提示、日志不再明文记密钥',
        '插件和技能会真正「记住」你的选择：你关掉的，重装、升级或重置之后也不会自己跳回开启；你开着的，也照样是开着的（默认关闭 6 个 / 默认开启 8 个，可在设置里逐项确认）',
        '拍一拍更准了：修掉机器人被拍时文案写错、喊它没反应的问题；群友名字以「我」开头时也不会再认错成在拍自己',
        '修掉群被移出白名单后机器人仍在该群发言：以前设的提醒到点不再发，聊到一半被移出也不会再回复',
        '修掉「活跃设置」里的禁言指令不生效：禁言期间机器人不再条条都回，冷场也不会主动开话题',
        '修掉切换人设不成功：保存新人设不再被旧设置覆盖，写好的「管理员附加规则」也不会再被悄悄抹掉',
        '新增 QQ 版本核对：启动时自动比对 QQ 版本和协议端是否匹配，不一致会明说下一步怎么办，不再只报「登录被拒」让人干猜',
        '表情更积极了：默认积极程度提到最高档，回应「表情包发送概率太低」的反馈',
        '会话选择页新增左栏搜索：搜会话更快，样式与主界面左栏统一',
        '修掉让机器人翻旧记录时拿到重复内容的问题',
        '修掉从 GitHub 下载的插件带多层文件夹装不上的问题（会自动找到真正的插件目录）',
        '修掉只配置了群白名单时、机器人可能给陌生私聊发消息的越权问题',
        '峰谷计价配置不全时按最保守的档位计费，不再误按最贵的档位',
        '指令禁言后，状态卡片会立刻刷新，不用猜指令到底生没生效',
        '人设摘要卡现在会提示「分会话独立人设 / 主人专属人设」这两个会盖过全局人设的隐形层，切换不生效有据可查'
      ]
    },
    {
      version: '0.4.8.4',
      date: '2026-10-15',
      items: [
        '表情包独立成插件了：插件页新增「表情系统」卡片，开关和设置（积极程度、提示词里列举的数量、收藏上限等）都收在这一张卡里',
        '新增「表情库」界面：在「表情系统」设置里点「查看收藏的表情」就能打开 —— 可以搜 id / 备注 / 标签，按「用过 / 有备注 / 本地转存」筛选，点开看大图和完整备注',
        '表情可以删了：不想要的表情能让机器人干脆删掉（删掉后不再出现在表情列表和提示词里，也不会再被发出去）；删错了随时恢复，备注和使用次数都还在',
        '「分层记忆（增强版）」更名为「记忆系统」，并改为随包内置 —— 插件页里显示的新名字就是它',
        '注入全自动了：登录机器人 QQ 后自动完成注入并连上，不用再进控制台手动点「进程注入」',
        '只注入机器人那份 QQ：可填机器人 QQ 号或从已登录 QQ 里点选；不填也能自动识别，个人 QQ 不受影响',
        '机器人 QQ 号自动记住：首次注入成功后下次直接用，不用重复填',
        '控制台密码不用管了：自动接管 SnowLuma 控制台密码；忘记密码点「重置并接管」一键找回',
        '新增「取消注入 / 重新注入」：取消后重启也不会自动注入，点「重新注入」随时恢复',
        '登录后连接更快：修掉了登录后要空等一轮重试才连上的问题',
        '修复：人设市场拉不到列表、下载人设失败的问题',
        '「选择会话」列表与全屏会话选择页风格统一，带头像显示',
        '连续对话时回复更快：前缀缓存保活默认开启',
        'SnowLuma 升级到 1.14.22',
        '界面文字修正：修掉一批显示成 **星号** 的加粗标记、缺字与重复文案'
      ]
    },
    {
      version: '0.4.8.3',
      date: '2026-10-14',
      items: [
        '启动卡住不再无解：超过 45 秒连不上后端，会弹出「启动失败」卡片，写明原因和实时日志，并带「重新加载界面 / 打开日志目录 / 复制错误详情」三个按钮，方便定位',
        '后台持续重试：失败卡片弹出后程序仍在后台轮询，后端一旦恢复（慢机器建完索引、OneBot 连上、网络抖动恢复）会自动继续，不用手动刷新',
        '分清两类故障：现在能区分「端口根本没起来（被杀软拦了 / 端口被占）」和「服务在跑但还没就绪」，提示和排查方向不再混为一谈',
        '「重新加载界面」按钮加了 6 秒冷却，防止手抖连点把刚起来的页面又刷掉',
        '启动日志更详细：控制台服务每步耗时（端口监听 / 技能加载 / SnowLuma 拉起 / OneBot 首连）都会记下来，卡在哪一步一目了然',
        '修复：整理群记忆期间，记忆页左侧列表点不动的问题（列表被每秒整体重建，点击经常落空）',
        '修复：从没整理过记忆的群在记忆页里找不到、也就没法整理 —— 现在聊过的会话都会出现在记忆页，点开就能「整理本群记忆」',
        '「OneBot 连接」说明补充：长时间连不上时，点 SnowLuma 节点里的控制台链接打开 WebUI 手动注入一次即可'
      ]
    },
    {
      version: '0.4.8.2',
      date: '2026-10-14',
      items: [
        '会话列表不再自己乱跳：你手动点开某条会话或往上翻记录时，自动滚动会先让一让，不会硬把你拽回底部',
        '追最新消息时右栏只更新有变化的那几张卡片，不再整块重刷，滚动位置也不会被顶回去',
        '已经展开的会话卡片不会被自动收起，切走再切回来仍然保持展开',
        '修掉了会话卡内容偶尔「张冠李戴」（A 会话的卡片显示成 B 会话的内容）的问题',
        '设置页切换分区时不再闪一下'
      ]
    },
    {
      version: '0.4.8.1',
      date: '2026-10-14',
      items: [
        '修掉了一批会导致闪退、窗口自己消失、任务栏闪烁、卡住不动的问题',
        '全 App 的动效统一成一套：按压、悬停、切页、弹窗、列表逐个入场都有明确手感',
        '各个界面的左栏统一成一套：左右留白、分隔线、选中卡片、首个选项卡的位置全都对齐，每行开头多余的蓝点也去掉了',
        '插件更好找了：下载页左栏拆成「市场 / 已安装」，装完的插件卡片上直接点「管理」就能跳过去开关',
        '下载页滑动浏览插件不再卡顿',
        '键盘 Tab 切到输入框时能看到焦点框了',
        '设置页切换分区时有了弹出动画',
        '「更新报告」这张卡片可以关掉，关掉后这个版本不再弹出来'
      ]
    }
  ];

  (function renderStageReport() {
    var host = document.querySelector('#view-sessions .stage-empty');
    if (!host || !STAGE_CHANGELOG || !STAGE_CHANGELOG.length) return;
    var escHtml = (typeof esc === 'function') ? esc : function (s) { return String(s == null ? '' : s); };

    /* 卡片重排：之前 30 多条混排成一堵灰字墙，扫不出重点。
       ① 条目按开头动词自动归入「新增 / 优化 / 修复」三组（渲染层分类，
         STAGE_CHANGELOG 不用贴标签；分不进前两类的都算优化，例如
         「默认人设…」「Windows 下…」，分组是扫读辅助，不求完美）；
       ② 引号「」里的短词（问题名 / 功能名）加粗当扫读锚点，超过 24 字的引号
         多半是整句话，不动；
       ③ 旧版本（第 2 版起）默认折叠成一行版本号，点版本行展开：99% 的用户
         只看最新一版。展开状态只活在本次会话，不落盘。
       ④ 没完成启动引导的用户（config.onboarding.seen !== true，
         读法照 18-onboarding.js 的 onboardingNeedsShow），最新一版也默认折成
         一行「本版改了 N 项改进，点击展开」，萌新的首页不该一上来就被十几条
         改进砸脸；已完成引导的老用户仍默认展开。 */
    function classifyItem(text) {
      if (/^新增/.test(text)) return 'add';
      if (/^(修掉|修复)/.test(text)) return 'fix';
      return 'opt';
    }
    var GROUPS = [
      { id: 'add', label: '新增' },
      { id: 'opt', label: '优化' },
      { id: 'fix', label: '修复' }
    ];
    function emHtml(text) {
      return escHtml(text).replace(/「([^「」]{1,24})」/g, '「<strong>$1</strong>」');
    }

    var rows = [];
    for (var i = 0; i < STAGE_CHANGELOG.length; i++) {
      var e = STAGE_CHANGELOG[i];
      if (!e) continue;
      var items = [];
      for (var j = 0; j < (e.items || []).length; j++) if (e.items[j]) items.push(e.items[j]);
      if (!e.version && !items.length) continue;
      rows.push({ version: e.version, date: e.date, items: items });
    }
    if (!rows.length) return;

    // 用户点 × 关掉之后，同版本不再出现（换了新版本自动再出现一次）。
    // stamp 取最新那一版的 version，退而求其次取 date；两者都空就不记忆（只本次会话关闭）。
    var stamp = String(rows[0].version || rows[0].date || '');
    if (stamp) {
      var closed = '';
      try { closed = localStorage.getItem(REPORT_KEY) || ''; } catch (e) { /* 隐私模式 */ }
      if (closed === stamp) return;
    }

    var h = '<div class="sr-head"><span class="sr-title">更新报告</span>' +
            '<span class="sr-sub">本版改了什么</span>' +
            '<button class="sr-x" id="stage-report-close" type="button"' +
            ' title="关闭更新报告（这个版本之后不再弹出）" aria-label="关闭更新报告（这个版本之后不再弹出）">' +
            '<svg viewBox="0 0 20 20" aria-hidden="true">' +
            '<path d="M2,0 L0,2 8,10 0,18 2,20 10,12 18,20 20,18 12,10 20,2 18,0 10,8 2,0Z"' +
            ' fill="currentColor" stroke="none" /></svg></button></div>';
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      var foldable = k > 0;
      h += '<section class="sr-ver' + (foldable ? ' sr-ver--old' : '') + '">' +
           '<div class="sr-vh' + (foldable ? ' sr-vh--toggle" role="button" tabindex="0" aria-expanded="false' : '') + '">';
      if (foldable) h += '<svg class="sr-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="M3,1 L8,5 3,9Z" fill="currentColor" stroke="none"/></svg>';
      h += '<span class="sr-vn">' + escHtml(r.version ? ('v' + r.version) : '') + '</span>' +
           '<span class="sr-vd">' + escHtml(r.date || '') + '</span>';
      if (foldable) h += '<span class="sr-count" data-n="' + r.items.length + '">' + r.items.length + ' 条改动 · 点击展开</span>';
      h += (k === 0 ? '<span class="sr-badge">最新</span>' : '') + '</div>';
      if (r.items.length) {
        var buckets = { add: [], opt: [], fix: [] };
        for (var m = 0; m < r.items.length; m++) buckets[classifyItem(r.items[m])].push(r.items[m]);
        h += '<div class="sr-body"' + (foldable ? ' hidden' : '') + '>';
        for (var g = 0; g < GROUPS.length; g++) {
          var list = buckets[GROUPS[g].id];
          if (!list.length) continue;
          h += '<div class="sr-group"><span class="sr-tag sr-tag--' + GROUPS[g].id + '">' + GROUPS[g].label + '</span><ul class="sr-list">';
          for (var n = 0; n < list.length; n++) h += '<li>' + emHtml(list[n]) + '</li>';
          h += '</ul></div>';
        }
        h += '</div>';
      }
      h += '</section>';
    }

    var box = document.createElement('div');
    box.className = 'stage-report';
    box.id = 'stage-report';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', '更新报告');
    box.innerHTML = h;

    var note = host.querySelector('.stage-note');
    if (note) host.insertBefore(box, note); else host.appendChild(box);
    host.classList.add('has-report');

    // 吸顶条的渐隐只在「真的滚动过」时出现（is-scrolled 开关）。
    // 停在顶部时第一条目不该被 ::after 渐变罩暗半截；滚回顶上就恢复。
    // 监听滚动容器自己即可，passive 不抢滚动性能。
    box.addEventListener('scroll', function () {
      box.classList.toggle('is-scrolled', box.scrollTop > 2);
    }, { passive: true });

    // 旧版本折叠：点版本行展开 / 收起；Enter / 空格同样可操作（role=button）。
    var toggles = box.querySelectorAll('.sr-vh--toggle');
    for (var t = 0; t < toggles.length; t++) {
      (function (vh) {
        function toggle() {
          var body = vh.parentNode.querySelector('.sr-body');
          if (!body) return;
          var willHide = !body.hidden;   // 当前展开 → 这次点了就是收起
          body.hidden = willHide;
          vh.setAttribute('aria-expanded', String(!willHide));
          vh.classList.toggle('is-open', !willHide);
          var cnt = vh.querySelector('.sr-count');
          if (cnt) cnt.textContent = cnt.getAttribute('data-n') + ' 条改动 · ' + (willHide ? '点击展开' : '点击收起');
        }
        vh.addEventListener('click', toggle);
        vh.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
        });
      })(toggles[t]);
    }

    // × 关掉：连同 has-report 一起摘掉，让 .stage-note 回到原来的居中布局
    // （与「数组清空 → 不渲染卡片」走同一条路径，不留半截状态）。
    var xb = box.querySelector('#stage-report-close');
    if (xb) xb.addEventListener('click', function () {
      if (box.parentNode) box.parentNode.removeChild(box);
      host.classList.remove('has-report');
      if (stamp) { try { localStorage.setItem(REPORT_KEY, stamp); } catch (e) { /* ignore */ } }
    });
  })();

  /* ══════════ 身份区同步 ══════════
     真机的连接状态由 01-boot.js 的 refreshStatus() 写进 #onebot-dot / #onebot-label，
     这里只做「搬运」。
     ⚠️ 触发契约：**只有下面那个 3 秒定时器**（外加 switchTab / 头像刷新按钮这类
     显式调用的即时同步）。不要再包 refreshStatus 让它在每轮之后补一次 —— 那会与
     定时器叠加成 1/3 + 1/15 ≈ 2.5 秒一跳的重复路径（F7 BUG-2），改一处漏一处。 */
  // R80（BUG-14）：写前比较缓存。旧逻辑每次 refreshStatus（本地配置 15s 一轮）
  // 都无条件写 innerHTML / 重设 img.src，值没变也整块重建 DOM；头像更惨：
  // src 重设 = 重新走一次 CDN 加载，表现为头像周期性闪烁/闪白。
  // 现在记住「上次写进去的值 + 当时的元素引用」，签名没变就整个跳过；
  // 元素引用也进签名，万一边上别的地方把这块 DOM 重建了，不会被缓存骗过去。
  var lastIdent = null;
  function syncIdentity() {
    var st = (typeof state !== 'undefined' && state.status) || {};
    var ob = st.onebot || {};
    // 只信 state.status.onebot.connected，绝不"读顶栏 #onebot-label 的文字"兜底：
    // 未连接时 01-boot.js 写进去的是后端诊断原文，例如
    // 「协议端未运行或未监听 WS 端口」，里面含子串「运行」，
    // 按关键字匹配就会把「未运行」误判成「已连接」，与右下角「还没连上」的提示自相矛盾。
    // state.status 是唯一权威来源。
    var on = !!ob.connected;
    // 后端持续无响应时（01-boot.js 的 statusFailStreak 判定），state.status 是过期数据，
    // 身份卡再写"在线 · 已连接 OneBot"就是撒谎，而用户根本看不出后端已经挂了。
    // 副标题改口径 + 圆点转灰；名字保留（是旧值，但比抹掉更认得出是谁）。
    // 3 秒定时器保证 stale 置位后最迟 3 秒就会走到这里。
    var stale = !!(typeof state !== 'undefined' && state.statusStale);

    // 昵称与头像都跟随「当前登录 QQ」（照原型 syncIdentity 的语义）：
    // 后端 /api/status 的 onebot.self = { userId, nickname }（src/routes.js 的 `/api/status`）。
    var self = ob.self || st.self || null;
    var uin = String((self && self.userId) || ob.selfId || ob.self_id || '').trim();
    var nick = String((self && self.nickname) || ob.nickname || ob.nick || '').trim();
    var name = nick || (uin ? 'QQ ' + uin : '');

    var elName = $('#ident-name');
    // 拿不到 QQ 号才算「未登录」；此时若 OneBot 其实连着，只说「已连接」，
    // 不再出现「未登录 / 已连接 OneBot」这种自相矛盾的两行。
    var nameText = name || (on ? '已连接' : '未登录');
    var elSub = $('#ident-sub');
    var subHtml = '<span class="dot ' + (on ? 'dot-on' : 'dot-off') + '"></span>' +
      (on ? '在线 · 已连接 OneBot' : '未连接 OneBot');

    // 头像：优先用后端给的地址；没有就按 QQ 号拉官方 CDN（全站既有做法，
    // 见 05-memory-settings.js 的头像渲染）；两者都拿不到 → 保持默认企鹅（.avatar-default）。
    var img = $('#sidebar-avatar');
    var box = img && img.parentNode;                    // .avatar
    var url = String(ob.avatar || ob.avatarUrl || ob.face || '').trim();
    if (!url && uin) url = 'https://q1.qlogo.cn/g?b=qq&nk=' + encodeURIComponent(uin) + '&s=640';
    var avatarUsable = /^(https?:|data:|\/)/.test(url);

    // 「开始对话」副标题：有会话就显示第一个会话名，否则提示还没会话。
    // ① 启动链进行中（starting）副标题是进度条，跳过重建；
    // ② 启动结束的结论（launchMsg，已连接/超时）要粘住，refreshStatus 的重渲染
    //    不能把它盖回会话名，用户下次点击时才清除。
    var sub = $('#launch-sub');
    var lb = $('#launch-btn');
    var launchVal = null;   // null = 这次不该写（没元素 / 进度条中）
    if (sub && lb) {
      if (lb.dataset.starting === '1') { launchVal = null; }
      else if (lb.dataset.launchMsg) { launchVal = lb.dataset.launchMsg; }
      else {
        var items = $$('#session-items .session-item');
        var first = items[0];
        // 取「会话名」而不是整个条目的 textContent，也不 slice：
        // textContent 会把群名、时间、状态、统计连成一串，截断常常切在半个词上；
        // 硬切之后 CSS 的 text-overflow:ellipsis 也永远不会触发（实测
        // scrollWidth === clientWidth），于是显示成断在半句的残句。
        // 现在只取名字，溢出交给 #launch-sub 的省略号。
        var nameEl = first && first.querySelector('.session-chat');
        var txt = nameEl
          ? String(nameEl.getAttribute('title') || nameEl.textContent || '').trim()
          : (first ? String(first.getAttribute('title') || first.textContent || '').trim() : '');
        launchVal = txt || (items.length ? '进入会话列表' : '还没有会话');
      }
    }

    // 签名：值 + 元素引用。全都没变 → 这次刷新没有任何可写的，直接返回。
    if (lastIdent
      && lastIdent.elName === elName && lastIdent.elSub === elSub && lastIdent.img === img
      && lastIdent.nameText === nameText && lastIdent.subHtml === subHtml
      && lastIdent.avatarUrl === url && lastIdent.avatarUsable === avatarUsable
      && lastIdent.launchVal === launchVal) return;
    lastIdent = { elName: elName, elSub: elSub, img: img, nameText: nameText, subHtml: subHtml, avatarUrl: url, avatarUsable: avatarUsable, launchVal: launchVal };

    if (elName) elName.textContent = nameText;
    if (elSub) elSub.innerHTML = subHtml;
    if (img) {
      // 头像 CDN 不需要、也不该把本机 origin 当 referer 带出去。
      img.referrerPolicy = 'no-referrer';
      if (avatarUsable) {
        img.src = url;
        box && box.classList.add('logged-in');
      } else {
        img.removeAttribute('src');
        box && box.classList.remove('logged-in');
      }
    }
    if (sub && launchVal !== null) sub.textContent = launchVal;
  }

  /* ══════════ 主同步（switchTab 之后调用）══════════ */
  function syncChrome(name) {
    var g = groupOfTab(name);
    // 顶栏一级高亮
    // 壁纸页已收回「设置 → 外观与数据」，顶栏不再有 data-top="wallpaper" 这颗按钮
    // （见 index.html 该处注释）。但 GROUPS 里仍保留 wallpaper 分组：
    // showNav / panes.settings 那些判断都靠 g.key 区分，归到 settings 组会把设置页内容
    // 一起亮出来。所以这里单独做一次归属映射：进壁纸页时高亮设置，
    // 否则会出现"切进壁纸页、顶栏一个都不亮"的迷路感。
    var topKey = g.key === 'wallpaper' ? 'settings' : g.key;
    $$('#tabs .nav-item').forEach(function (b) {
      var on = b.dataset.top === topKey;
      b.classList.toggle('active', on);
      // 一级导航同样要能"读"出选中态：此前只有 .active 这个视觉类，
      // 读屏用户听到的是一排无差别的按钮。
      if (on) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    // 离开「会话」一级就别把全屏页留在屏幕上（用户点了别的页签 = 明确要去别处）
    if (bigpage && !bigpage.hidden && g.key !== 'sessions') closeBigPage();

    var isLaunch = name === 'sessions';
    sideLaunch && (sideLaunch.hidden = !isLaunch);
    // 左栏中间那块：启动页是启动块、设置页是设置分区菜单，其余页是「二级导航」。
    // 存档 / 记忆 也必须显示二级导航：它们与「会话」同属一级，若这里一并隐掉，
    // 用户就没有任何途径在这三页之间来回切（原型在 存档/记忆 页的左栏同时列
    // 「消息记录」导航与群聊列表；本实现把列表交给该页自己的 .list-pane 承担）。
    // 壁纸页同设置页：左栏不挂二级导航（它没有二级页，整页自己带两栏）。
    // 桌宠走二级导航（ops 组第三项），所以这条判断里没有 pet。
    var showNav = !isLaunch && g.key !== 'settings' && g.key !== 'wallpaper';
    sideNav && (sideNav.hidden = !showNav);

    // 每页一份的列表栏
    panes.chats && (panes.chats.hidden = name !== 'chats');
    panes.memory && (panes.memory.hidden = name !== 'memory');
    panes.settings && (panes.settings.hidden = g.key !== 'settings');
    // r36：社区块已从左栏迁到设置页内容区底部（#view-settings > .settings-foot），
    // 随 view 显隐，这里不再管。
    syncSidebarWidth(name, g);
    // 存档 / 记忆 的左栏里要同时有「消息记录」导航（列在列表栏上方）
    if (!sideNav.hidden) renderSideNav(name, g);
    if (bigpage && !bigpage.hidden && bpMode === 'setup') { renderSetupNav(); renderSetupPane(); }
    syncIdentity();
  }

  // 包裹 switchTab：00-core.js 本体不动，切页后补一次外壳同步。
  if (typeof switchTab === 'function') {
    var rawSwitch = switchTab;
    switchTab = function (name) {
      var r = rawSwitch.apply(this, arguments);
      // 刻意静默：syncChrome 只负责外壳高亮/左栏这类纯视觉同步，
      // 失败时页面本身已经切过去了，再弹一个提示框反而更打断。
      // 保留 console.warn 作为线索即可。
      try { syncChrome(name); } catch (e) { console.warn('[chrome] 同步失败：', e && e.message); }
      return r;
    };
  }

  /* 包一层 renderSettings（06-settings-render.js 的全局函数，与 switchTab 同一种做法）：
     「会话设置」页的「编辑本会话人设」复用全局页的 openPerChatPersonaModal，那个弹窗
     保存后只调 renderSettings() 刷全局页，不包这一层，改完人设回到全屏页摘要还是旧的。 */
  if (typeof renderSettings === 'function') {
    var rawRenderSettings = renderSettings;
    renderSettings = function () {
      var r = rawRenderSettings.apply(this, arguments);
      try { if (bigpage && !bigpage.hidden && bpMode === 'setup') renderSetupPane(); } catch (e) { /* ignore */ }
      return r;
    };
  }

  /* 包一层 updateUsagePage（04-archive-usage.js 的全局函数，与 switchTab 同一种做法）：
     它每次都会重画三张图，而图表的宽度是量容器得来的，隐藏的块 clientWidth 是 0，
     会把图拉成整页宽。所以先把维度可见性定下来，再让它去量、去画。 */
  if (typeof updateUsagePage === 'function') {
    var rawUpdateUsage = updateUsagePage;
    updateUsagePage = function (stats) {
      applyUsageDim(stats);
      return rawUpdateUsage.apply(this, arguments);
    };
  }

  // 首屏同步：DOM 就绪即可（脚本是 defer，元素已解析完）。
  syncChrome((typeof state !== 'undefined' && state.tab) || 'sessions');
  // 身份区的**唯一**周期触发（见上方「身份区同步」注释）。3 秒是有意偏快：
  // 它靠 lastIdent 签名短路，值没变时只做比较、不写 DOM。
  setInterval(syncIdentity, 3000);
  // 首屏后补一次：此时 status 可能已由 11-init 拉到
  setTimeout(syncIdentity, 1500);
})();

// 〔15-chat-chrome〕全屏页「会话选择」的左栏 / 右栏 chrome —— 照原型 v2 `.bigpage.mode-chat`
//
// 为什么单独一层：原型这一页是「左＝聊天对象列表（带搜索 / 页面 / 分组 / 快捷操作），
// 右＝状态条 + 会话头 + 该聊天的 N 个会话卡片」。真机原来的 #bigpage.mode-chat 是
// 「左＝逐条会话平铺 + 状态卡，右＝单条会话消息流」—— 数据模型不同（左栏列"聊天对象"，
// 不是"会话"）。要对齐原型就得换一层组织方式，而 #session-items / #session-detail
// 的渲染全在 02-sse-sessions.js 里（它被 16 个脚本依赖）。所以这里**不碰它**，
// 改用「包裹 + 后处理」：
//   · 包裹 renderSessionList / renderSessionDetail / selectSession —— 与 14-chrome.js
//     包裹 switchTab 是同一套做法（函数声明在全局，重新赋值即可，调用方无感）；
//   · 左栏：新建三个自己的容器（搜索 / 列表 / 快捷操作）插到 #session-list 最前，
//     逐条会话的 #session-items 与分页提示隐藏（渲染器照旧跑，只是不展示）；
//     「聊天对象」由 state.sessions 按 chatKey 去重得出；
//   · 右栏：把 #session-detail 里 02 渲染出来的节点**搬进**当前会话卡片的卡体，
//     卡头 / 状态条 / 会话头是本层新加的 —— 这样 JSON 模式、删除、折叠面板全照旧工作。
//   · 卡体里的工具卡：02 渲染的是整张 JSON 卡，原型 `.tool-step` 只占一行 ——
//     这里做 DOM 级后处理（skinTools）：单行摘要照原型，入参 / 返回原文收进 .ts-raw，
//     由右侧小按钮展开。见 skinTools() 上方注释。
//
// 左栏「页面」三项（会话 / 存档 / 记忆）＝ 右栏的三个视图，照原型 bpRightRender：
//   · 会话 → 03 的会话卡（本层自建卡壳 + 02 的节点）
//   · 存档 → 04-archive-usage.js 的 #chat-detail 搬进右栏
//   · 记忆 → 05-memory-settings.js 的 #memory-detail 搬进右栏
// 点这三项**不关全屏页**（原型 v22：关了会被当成"退出"），底层的落点由 bpPrevSub
// 在关闭时还原（原型 v23）。详见 gotoPage / applyRightAux 的注释。
//
// ⚠️ 只在大屏页开着且是 mode-chat 时生效；关掉后所有节点还原。
// ⚠️ .session-status 由这里搬进右栏，另有一个观察器兜住回挂 —— 见 rehomeStatus()。
'use strict';

(function () {
  var BIG = document.getElementById('bigpage');
  var LIST = document.getElementById('session-list');
  var DETAIL = document.getElementById('session-detail');
  if (!BIG || !LIST || !DETAIL) return;

  // 放大镜：照原型 `.bp-search .bp-mag` 的 path（1040 视框、实心、fill: --fg-dim）
  var ICON_MAG = 'M675.9168 242.816C556.3008 123.2 362.4448 123.2 242.8288 242.816 123.2128 362.432 123.2128 556.288 ' +
    '242.8288 675.904 362.4448 795.52 556.3008 795.52 675.9168 675.904 795.5328 556.288 795.5328 362.432 675.9168 ' +
    '242.816L675.9168 242.816ZM1000.7168 892.48C1030.6048 922.368 1030.6048 970.816 1000.7168 1000.704 ' +
    '970.8288 1030.656 922.3808 1030.656 892.4288 1000.704L730.0608 838.336C728.1408 836.416 727.4368 833.92 ' +
    '725.7728 831.872 546.3168 960.448 295.7568 945.408 134.5408 784.192-44.8512 604.8-44.8512 313.92 ' +
    '134.5408 134.528 313.9328-44.864 604.8128-44.864 784.2048 134.528 945.4208 295.744 960.4608 546.304 ' +
    '831.8848 725.76 833.9328 727.424 836.4288 728.128 838.3488 730.048L1000.7168 892.48Z';
  var ICON_X = 'M2,0 L0,2 8,10 0,18 2,20 10,12 18,20 20,18 12,10 20,2 18,0 10,8 2,0Z';
  var ICON_MEGA = 'M4 9v6h3l5 4V5L7 9H4zm11-1a5 5 0 0 1 0 8';
  var ICON_BROOM = 'M13 3l4 4-7 7-4-4 7-7zM6 12l2 2-2 6-4 1 1-4z';
  // 〔页面〕三枚线性图标 —— 照原型 Lucide 线条风（24×24 / 描边 / 与 .sm-ico · .sn-logo 同族）。
  //   会话 = 双气泡（区别于「聊天」单气泡）   存档 = 归档箱   记忆 = 数据库圆柱（r108 定稿）。
  var ICON_SESSIONS = 'M5 4 h5 a2 2 0 0 1 2 2 v3 a2 2 0 0 1 -2 2 h-5 a2 2 0 0 1 -2 -2 v-3 a2 2 0 0 1 2 -2 z M14 13 h5 a2 2 0 0 1 2 2 v3 a2 2 0 0 1 -2 2 h-5 a2 2 0 0 1 -2 -2 v-3 a2 2 0 0 1 2 -2 z';
  var ICON_CHATS    = 'M2 4h20v4H2z M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8 M10 12h4';
  var ICON_MEMORY   = 'M12 3c4.97 0 9 1.34 9 3s-4.03 3-9 3-9-1.34-9-3 4.03-3 9-3z M3 6v12c0 1.66 4.03 3 9 3s9-1.34 9-3V6 M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3';

  var st = { chat: null, q: '' };
  // R116：用户主动选中（点卡头 / 自动跟随）的会话 id。该会话下一次详情渲染
  // **必须保证展开** —— 与 02 是否真的重渲染了内容无关，见 renderSessionDetail
  // 包裹层里的说明（修「运行中的卡片点了展开不开」）。
  var ccPendingExpand = null;
  // R121：用户**手动展开过**的会话卡（sid → true）。治「手动展开的为什么会
  // 自动收起」（2026-10-14 用户反馈）：新会话到达时自动跟随会切换选中会话，
  // 全量重建把非选中卡一律折叠；会话跑完 autoFoldTick 也按 r37 设计自动收起。
  // 用户明确点开来的卡，只有用户自己能关 —— 其它路径（重建 / 状态迁移）
  // 一律绕开它。用户手动收起（点已展开卡头）或点了别的卡（手风琴）时销账。
  var ccUserExpanded = {};
  // R121：重建时暂存「被展开卡体」的离帧容器。刻意不用 HOLD —— collectSessionNodes
  // 会扫 HOLD，混在一起会把旧内容错挂到新选中的卡体上。
  var ccBodyHold = document.createElement('div');

  // R126：右栏会话卡**分页**。根因（2026-10-15 用户报「点会话选择卡一下」）：
  // applyRightInner 原来把该聊天的**全部**会话一次性建成 DOM —— 这个群 4115
  // 条会话 = 一万多个节点 + 4115 次 innerHTML 解析 + 一次全量样式/布局，
  // 主线程阻塞约 1s，全屏页半天出不来。左栏 02 的列表早有 SESSION_PAGE
  // 分页（00-core.js），右栏卡片照同一思路补上：首屏只建 CC_CARD_PAGE 张，
  // 滚到底再补下一批（loader 挂右栏滚动容器 #session-detail，见 buildStatic）。
  // ⚠️ ccShown 在每次全量重建（applyRightInner）时归零重来。
  var CC_CARD_PAGE = 50;
  var ccShown = CC_CARD_PAGE;

  // R122：两个卡体小工具。
  // loadingBody：「加载中…」占位卡体（R117 点击即展开 / R122-C1 卡体自愈共用）。
  function loadingBody() {
    var body = document.createElement('div');
    body.className = 'bs-cb';
    var hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '加载中…';
    body.appendChild(hint);
    return body;
  }
  // pullParkedBody：取回某个会话被手风琴 park 掉的卡体（R122-C5），没有返回 null。
  // ccBodyHold 每次 applyRightInner 快照时会整体清空（见 applyRightInner ①），
  // 所以 park 的卡体最多存活到下一次全量重建 —— 之后按账本走 keepBodies /
  // 占位 + 重填，语义不断。
  function pullParkedBody(sid) {
    var kids = Array.prototype.slice.call(ccBodyHold.children);
    for (var i = 0; i < kids.length; i++) {
      if (kids[i].dataset && kids[i].dataset.ccOwner === sid) {
        ccBodyHold.removeChild(kids[i]);
        return kids[i];
      }
    }
    return null;
  }
  // R118：上一次实际渲染过的聊天对象（st.chat）。fillLeft 每次跑完更新。
  // 用来区分「同聊天的列表刷新」（新会话插顶/行重排 → 恢复滚动锚点）与
  // 「切换了聊天对象」（pickChat 会先改 st.chat 再 applyRight → 不恢复，
  // 那份 scrollTop 属于另一个聊天的列表）。只在 applyRightInner / fillLeft
  // 开头读、fillLeft 末尾写 —— 两处 rebuild 路径都先于 fillLeft 或伴随它。
  var ccLastChat = null;
  // R122-B：自动跟随「用户接管」暂停。治「用户正在读旧卡，每个新会话都把
  // 当前选中切走」（autoFollowRunning 默认 true，02 的 session-start 每次都
  // selectSession 活跃会话）。规则：用户手动选择（点卡头 / 点左栏聊天）后
  // CC_PAUSE_MS 内，**系统发起**的 selectSession 直接跳过 —— 选择留在用户
  // 正在读的会话上；新会话卡照常出现在列表里（refreshCards 增量补卡），
  // 只是不抢选择。暂停窗口从最后一次手动选择起算，用户持续操作就顺延。
  // ccFromUserClick 区分「用户点出来的 selectSession」与系统调用方
  // （02 自动跟随 / autoFoldTick / activate 默认选）。
  var CC_PAUSE_MS = 60000;
  var ccUserPickAt = 0;
  var ccFromUserClick = null;
  // R119：右栏滚动锚定（治「新消息到达被弹回顶部」，R118 没治干净的那版）。
  //
  // R118 为什么没挡住：回退分支（新会话的卡还不存在 → 全量重建）里，
  // 02 的 rd.apply 先 `detail.innerHTML = 整串` 把 DETAIL 连骨架一起清掉、
  // scrollTop 归零，**然后**才 applyRight(true) —— 锚点抓到时已经是 0，
  // `sdTop0 > 4` 不成立，恢复被跳过。所以锚点必须在清空**之前**抓。
  //
  // 三个抓锚入口（谁可能引发清空/重建，谁负责在动手前抓）：
  //   ① 详情包裹层回退分支：rd.apply 之前（主路径：新会话 + 自动跟随）；
  //   ② selectSession 包裹层入口：覆盖详情 >200ms 时 02 延迟占位的清空；
  //   ③ applyRightInner 入口：R122-C3 —— 骨架健在（#cc-cards 还在，DETAIL
  //      内容完好、scrollTop 是实时有效位置）就 force 重抓；骨架没了（已被
  //      02 的占位/重建清空）才非强制抓，沿用 ①/② 已抓好的好锚点。
  // 统一在 applyRightInner 末尾（autoFoldTick 之后）restoreScrollAnchor() 消费。
  // 守卫：同一聊天 + 15 秒内 + 用户原本不在顶部（scrollTop>4）。切了聊天 /
  // 陈年旧锚点一律丢弃 —— 别把用户拽到莫名其妙的位置。
  // ⚠️ force 参数：入口②（用户点击 selectSession）与入口③的骨架健在分支传
  //    true —— 抓取时机的滚动位置实时有效，永远重新抓；入口① 与入口③的
  //    骨架已失分支传默认值 —— DETAIL 可能已被 02 的占位清空，此刻再抓只能
  //    抓到 0，会把好锚点覆盖没，已有 TTL 内的新锚点就沿用。
  // ⚠️ TTL 5s → 15s（R122-C3）：慢接口场景（详情 >200ms 才落）下，从「抓锚」
  //    到「重建完恢复」可能跨过好几步异步，5 秒太紧，锚点会在恢复前就过期。
  var CC_ANCHOR_TTL = 15000;
  var ccAnchor = null;
  function captureScrollAnchor(force) {
    if (!force && ccAnchor && Date.now() - ccAnchor.at <= CC_ANCHOR_TTL && ccAnchor.chat === st.chat) return;
    ccAnchor = null;
    try {
      if (!active || tabNow() !== 'sessions') return;
      if (ccLastChat !== st.chat) return;          // 切了聊天 = 另一份列表，不锚
      var top = DETAIL.scrollTop;
      if (top > 4) ccAnchor = { top: top, h: DETAIL.scrollHeight, chat: st.chat, at: Date.now() };
    } catch (e) { ccAnchor = null; }
  }
  function restoreScrollAnchor() {
    var a = ccAnchor;
    ccAnchor = null;
    if (!a) return;
    if (a.chat !== st.chat || Date.now() - a.at > CC_ANCHOR_TTL) return;
    var d = 0;
    try { d = DETAIL.scrollHeight - a.h; } catch (e) { d = 0; }
    try { DETAIL.scrollTop = a.top + (d > 0 ? d : 0); } catch (e) { /* 忽略 */ }
  }

  // ── 小工具 ─────────────────────────────────────────────────────────────
  function S() { try { return (state && state.sessions) || []; } catch (e) { return []; } }
  function tabNow() { try { return state.tab || 'sessions'; } catch (e) { return 'sessions'; } }
  // ⚠️（2026-10-17 修 L2）原实现是
  //     `typeof esc === 'function' ? esc(s) : String(s == null ? '' : s)`
  //   —— 它把转义这件事**跨文件依赖**在 00-core.js 的 esc 上。那个文件一旦加载失败
  //   或顶层异常中断（本文件比它晚执行，19 个脚本按序 defer），兜底分支就会把
  //   **完全未转义**的字符串交给 innerHTML / 属性拼接：群名、会话标题、图片 URL
  //   里塞一段 `<img src=x onerror=...>` 就是可执行代码。
  //   本文件里被 esc2 包住的有群名、会话标题、头像 URL、状态文案等十余处，
  //   全都在 HTML 字符串里拼 —— 静默退化 = 静默 XSS。
  //   正确写法是像 14-chrome.js 的 escH 那样**本文件独立实现**（那才是同项目范本）。
  //   行为与 00-core.js 的 esc 完全一致，所以正常路径下没有任何变化。
  function esc2(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function kindOf(k) { return /^private:/.test(String(k || '')) ? 'p' : 'g'; }
  function isLive(s) { return s && (s.status === 'running' || s.status === 'waiting'); }

  function chatDisplayName(key) {
    var n = '';
    try { n = typeof chatNameOf === 'function' ? chatNameOf(key) : ''; } catch (e) { n = ''; }
    n = String(n || '').trim();
    if (n) return n;
    var m = /:(\d+)$/.exec(String(key || ''));
    return (kindOf(key) === 'p' ? '私聊 ' : '群 ') + (m ? m[1] : String(key || ''));
  }
  function avLabel(name) { return String(name || '?').trim().slice(0, 1) || '?'; }

  /* ═══ 真实 QQ 头像（r34）═══
     腾讯公开头像 CDN，无需鉴权（与 05-memory-settings.js 的 .mem-card-ava-img、
     14-chrome.js 的 #sidebar-avatar 同一套路）：
       群   → https://p.qlogo.cn/gh/<群号>/<群号>/100
       私聊 → https://q1.qlogo.cn/g?b=qq&nk=<QQ号>&s=100
     ⚠️ 群头像**不能**用 b=qq&nk=群号 —— 那是个人接口，对群号返回 404。
     拿不到 id（非纯数字的 key）时返回 ''，由调用方退回首字。 */
  function qqAvatarUrl(chatKey, size) {
    var m = /^(group|private):(\d{5,12})$/.exec(String(chatKey || ''));
    if (!m) return '';
    var id = m[2];
    var s = size || 100;
    return m[1] === 'group'
      ? 'https://p.qlogo.cn/gh/' + id + '/' + id + '/' + s
      : 'https://q1.qlogo.cn/g?b=qq&nk=' + id + '&s=' + s;
  }

  /* 头像方块：<img> + 首字兜底。
     ⚠️ 不能用内联 onerror —— CSP script-src 'self' 会拦内联事件，
     必须渲染后用 addEventListener 绑 error（与 05-memory-settings.js 同因）。 */
  function avHtml(chatKey, name, cls) {
    var fb = esc2(avLabel(name));
    var url = qqAvatarUrl(chatKey, 100);
    if (!url) return '<span class="bp-av' + (cls ? ' ' + cls : '') + '"><span class="av-l">' + fb + '</span></span>';
    return '<span class="bp-av' + (cls ? ' ' + cls : '') + '" data-avk="' + esc2(chatKey) + '">' +
      '<img class="av-img" src="' + esc2(url) + '" alt="" loading="lazy" referrerpolicy="no-referrer" />' +
      '<span class="av-l av-fb" hidden>' + fb + '</span></span>';
  }
  /* 把首字兜底揭开：img 加载成功 → 藏首字；失败 → 藏 img、显首字。
     用 event delegation 绑在长期容器上（W_LIST 会被整体重绘，不能逐节点绑）。
     ⚠️ 必须用捕获（true）：error 事件不冒泡，默认监听收不到。 */
  function bindAvatarFallback(root) {
    if (!root || root.__avBound) return;
    root.__avBound = true;
    root.addEventListener('error', function (e) {
      var im = e.target;
      if (!im || im.tagName !== 'IMG' || !im.classList.contains('av-img')) return;
      var box = im.parentNode;
      var fb = box && box.querySelector('.av-fb');
      im.style.display = 'none';
      if (fb) fb.hidden = false;
    }, true);
  }

  function dur(s) {
    var a = Number(s.startedAt) || 0, b = Number(s.endedAt) || 0;
    if (!a || !b || b < a) return '';
    return ((b - a) / 1000).toFixed(1) + 's';
  }
  function statusText(s) {
    try { return (STATUS_LABEL && STATUS_LABEL[s.status]) || s.status || '-'; } catch (e) { return s.status || '-'; }
  }

  /** 按 chatKey 去重成「聊天对象」，顺序 = 最近有会话的排前面 */
  function chatGroups() {
    var map = {}, out = [];
    S().forEach(function (s) {
      var k = s && s.chatKey; if (!k) return;
      var g = map[k];
      if (!g) {
        g = map[k] = { key: k, kind: kindOf(k), name: chatDisplayName(k), total: 0, active: 0, last: '', newest: -1, newestId: null };
        out.push(g);
      }
      g.total++;
      if (isLive(s)) g.active++;
      var t = Number(s.startedAt) || 0;
      if (t > g.newest) {
        g.newest = t; g.newestId = s.id;
        g.last = String(s.trigger || s.triggerSummary || '').replace(/\s+/g, ' ').trim().slice(0, 42);
      }
    });
    out.sort(function (a, b) { return b.newest - a.newest; });
    return out;
  }
  function sessionsOf(key) {
    return S().filter(function (s) { return s && s.chatKey === key; })
      .sort(function (a, b) { return (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0); });
  }

  // ── 左栏 ───────────────────────────────────────────────────────────────
  var W_SEARCH = null, W_LIST = null, W_ACTS = null;
  // R114：左栏骨架的常驻节点引用（fillLeft 增量 reconcile 用，见 fillLeft 注释）。
  // 它们全是 W_LIST 的直接子节点 —— 特别是「页面」.bp-sec 必须保持 first-child：
  // style.css 有 #cc-left > .bp-sec:first-child 的上间距覆写（约 8092 行）。
  var W_SEC_PAGE = null, W_NAVS = null, W_SEC_G = null, W_SEC_P = null;
  var W_ROWS_G = null, W_ROWS_P = null, W_EMPTY = null;

  function buildStatic() {
    if (W_SEARCH) return;
    W_SEARCH = document.createElement('div');
    W_SEARCH.id = 'cc-search-wrap';
    W_SEARCH.setAttribute('data-cc', '1');
    W_SEARCH.innerHTML =
      '<div class="bp-search" id="cc-search">' +
        '<svg class="bp-mag" viewBox="0 0 1040 1040" aria-hidden="true"><path d="' + ICON_MAG + '"/></svg>' +
        '<input id="cc-q" type="text" placeholder="搜索群 / 好友（也匹配最近一条消息）" maxlength="50" autocomplete="off" aria-label="搜索会话">' +
        '<button class="bp-clear" id="cc-clear" type="button" title="清空" aria-label="清空">' +
          '<svg viewBox="0 0 20 20"><path d="' + ICON_X + '" fill="currentColor" stroke="none"/></svg></button>' +
      '</div>';

    W_LIST = document.createElement('div');
    W_LIST.id = 'cc-left';
    W_LIST.setAttribute('data-cc', '1');

    // R114：左栏骨架**一次建成**，之后 fillLeft 只做增量 reconcile（见 fillLeft 注释）。
    // 全部是 W_LIST 直接子节点：行容器是裸 div（CSS 全按类选，无结构依赖），
    // 两个 .bp-sec 头与 .bp-empty 常驻、只切 hidden，nav 三项常驻、只切 .on。
    W_SEC_PAGE = document.createElement('div');
    W_SEC_PAGE.className = 'bp-sec';
    W_SEC_PAGE.textContent = '换个角度看';
    W_LIST.appendChild(W_SEC_PAGE);
    W_NAVS = {};
    // 萌新化：三个导航各挂一句「这一页是干什么的」—— 裸名词对小白是黑话
    [['sessions', '会话', ICON_SESSIONS, '会话＝机器人最近怎么应答的（每次触发一条记录）'],
     ['chats', '存档', ICON_CHATS, '存档＝这个群聊过的所有消息'],
     ['memory', '记忆', ICON_MEMORY, '记忆＝机器人记住的群友特点']].forEach(function (p) {
      var n = document.createElement('div');
      n.className = 'bp-nav';
      n.setAttribute('role', 'button');
      n.tabIndex = 0;
      n.dataset.goto = p[0];
      n.title = p[3];
      n.innerHTML = '<span class="bp-radio"></span>' +
        '<svg class="bp-nav-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="' + p[2] + '" stroke-linejoin="round" stroke-linecap="round"/></svg>' +
        '<span class="bp-nav-t">' + p[1] + '</span>';
      W_NAVS[p[0]] = n;
      W_LIST.appendChild(n);
    });
    W_SEC_G = document.createElement('div');
    W_SEC_G.className = 'bp-sec';
    W_SEC_G.innerHTML = '群聊<span class="cc-cnt" id="cc-cnt"></span>';
    W_LIST.appendChild(W_SEC_G);
    W_ROWS_G = document.createElement('div');
    W_ROWS_G.id = 'cc-rows-g';
    W_LIST.appendChild(W_ROWS_G);
    W_SEC_P = document.createElement('div');
    W_SEC_P.className = 'bp-sec';
    W_SEC_P.textContent = '私聊';
    W_LIST.appendChild(W_SEC_P);
    W_ROWS_P = document.createElement('div');
    W_ROWS_P.id = 'cc-rows-p';
    W_LIST.appendChild(W_ROWS_P);
    W_EMPTY = document.createElement('div');
    W_EMPTY.className = 'bp-empty';
    W_EMPTY.textContent = '还没有聊天记录——机器人加入群聊后会自动出现在这里';
    W_LIST.appendChild(W_EMPTY);

    W_ACTS = document.createElement('div');
    W_ACTS.id = 'cc-actions';
    W_ACTS.setAttribute('data-cc', '1');
    W_ACTS.innerHTML =
      '<div class="bp-sec">快捷操作</div>' +
      '<button class="bp-act" type="button" data-cc-act="broadcast" title="给选中的群/私聊批量发送一条消息">' +
        '<svg viewBox="0 0 24 24"><path d="' + ICON_MEGA + '"/></svg><span>给多个群发同一条消息</span></button>' +
      '<button class="bp-act" type="button" data-cc-act="clear" title="清空全部已结束的会话记录（保留运行中/等待中的）">' +
        '<svg viewBox="0 0 24 24"><path d="' + ICON_BROOM + '"/></svg><span>清理已结束的记录（进行中的会保留）</span></button>';

    LIST.insertBefore(W_ACTS, LIST.firstChild);
    LIST.insertBefore(W_LIST, W_ACTS);
    LIST.insertBefore(W_SEARCH, W_LIST);

    // 逐条会话行与分页提示不展示：新的左栏列的是「聊天对象」，不是「会话」
    var items = document.getElementById('session-items');
    var more = document.getElementById('session-more');
    var head = LIST.querySelector('.list-head');
    if (items) items.classList.add('cc-hide');
    if (more) more.classList.add('cc-hide');
    if (head) head.classList.add('cc-hide');

    // 事件：全部委托到三个容器上（内部会整体重绘，不能逐个绑定）
    W_SEARCH.addEventListener('input', function (e) {
      if (e.target && e.target.id === 'cc-q') {
        st.q = String(e.target.value || '').trim().toLowerCase();
        var c = document.getElementById('cc-clear');
        if (c) c.dataset.show = st.q ? '1' : '0';
        fillLeft();
      }
    });
    W_SEARCH.addEventListener('click', function (e) {
      if (!e.target.closest || !e.target.closest('#cc-clear')) return;
      var q = document.getElementById('cc-q');
      if (q) { q.value = ''; q.focus(); }
      st.q = '';
      fillLeft();
    });
    W_LIST.addEventListener('click', function (e) {
      var row = e.target.closest && e.target.closest('.bp-row');
      if (row) { pickChat(row.dataset.chat); return; }
      var nav = e.target.closest && e.target.closest('.bp-nav');
      if (nav) gotoPage(nav.dataset.goto);
    });
    // 2026-10-23 修复：这些行是 role="button" + tabindex="0"（见下方 bp-nav 与 chatRow），
    //   但此前只挂了 click 委托 —— 键盘 Tab 能聚焦到会话行，按回车/空格毫无反应，
    //   全项目也没有 Enter→click 的兜底（grep 过所有 key === 'Enter'）。
    //   只接管「焦点正好落在行本身」的情况：焦点在行内按钮/输入框上时不抢，
    //   否则会和行内控件自己的键盘行为打架。直接 t.click() 复用上面那条委托。
    W_LIST.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var t = e.target;
      if (!t || !t.classList) return;
      // 焦点必须在行本身（不是行内的按钮/文字），否则会和行内控件抢键
      var isRow = t.classList.contains('bp-row') || t.classList.contains('bp-nav');
      if (!isRow) return;
      e.preventDefault();
      t.click();
    });
    W_ACTS.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-cc-act]');
      if (!b) return;
      var id = b.dataset.ccAct === 'broadcast' ? 'session-broadcast-btn' : 'session-clear-btn';
      var orig = document.getElementById(id);
      if (orig) orig.click();               // 复用原有逻辑与确认弹窗，不另写一份
    });
  }

  function chatRow(g) {
    var pill = g.active
      ? '<span class="cc-pill cc-running">' + g.active + ' 个进行中</span>'
      : '<span class="cc-pill cc-gray">' + g.total + ' 个会话</span>';
    return '<div class="bp-row chat-row' + (g.key === st.chat ? ' on' : '') + '" data-chat="' + esc2(g.key) + '" role="button" tabindex="0">' +
      avHtml(g.key, g.name) +
      '<span class="bp-rl"><span class="bp-rt">' + esc2(g.name) + '</span>' +
      '<span class="bp-ri">' + esc2(g.last || '—') + '</span></span>' +
      pill + '</div>';
  }

  /**
   * 左栏渲染：**增量 reconcile**，不再整体 innerHTML 重建。
   *
   * 背景（2026-10-14 用户复现）：这里原来是 `W_LIST.innerHTML = <整串 HTML>`，
   * 而它被包在 renderSessionList 外面（见文件末 wrap）——会话页每次刷新
   * （SSE session-update/start/end、轮询 loadSessions、状态轮询）都会把
   * 导航 + 全部聊天行推倒重画：容器滚动位置清零（整列跳一下）、悬停/选中态闪、
   * 头像 img 重新加载。群越活跃闪得越频繁，用户报「有新对话出现会话选择界面
   * 就会刷新导致页面闪烁」。
   *
   * 现在骨架常驻（buildStatic 建），本函数只做 reconcile：
   *   · nav：只切 .on class；
   *   · 聊天行：按 data-chat 复用节点；data-sig 内容指纹没变就完全不动 DOM，
   *     变了只重建那一行；新增行只插一个节点；消失的行移除；
   *   · 章节头 / 空态提示：常驻，只切 hidden。
   * 容器不换、节点复用 → 滚动位置、悬停态天然保住；只有真正变化的行才重画。
   */
  function fillLeft() {
    if (!W_LIST || !W_ROWS_G || !W_ROWS_P) return;
    // R118：左栏滚动锚定——与右栏 ② 同一套补偿。新聊天行插到最顶 / 行重排
    // （"最近有会话的排前面"）会把下面的内容整体推下去，正在翻找旧聊天的
    // 用户被弹回顶部。滚动容器是 #session-list（.list-pane，overflow-y:auto）。
    // 不在顶部（scrollTop>4）才按新增高度补回去；在顶部则保持 0。
    var listTop0 = LIST.scrollTop, listH0 = LIST.scrollHeight;
    // #session-count 是 02-sse-sessions.js 会写的既有节点：保证它在「群聊」头的
    // 计数槽里。它随 deactivate 被还回列表头，再激活时这里搬回来 —— 节点本身
    // 一直在 DOM 里，不像旧实现要靠"先摘出来再挂回"躲 innerHTML 重建。
    var cnt0 = document.getElementById('session-count');
    if (cnt0 && cnt0.parentElement && cnt0.parentElement.id !== 'cc-cnt') {
      var slot0 = document.getElementById('cc-cnt');
      if (slot0) slot0.appendChild(cnt0);
    }

    var gs = chatGroups();
    var q = st.q;
    var hit = function (g) {
      if (!q) return true;
      return (g.name + ' ' + g.last + ' ' + g.key).toLowerCase().indexOf(q) >= 0;
    };
    var g1 = gs.filter(function (g) { return g.kind === 'g' && hit(g); });
    var g2 = gs.filter(function (g) { return g.kind === 'p' && hit(g); });

    var now = tabNow();
    Object.keys(W_NAVS).forEach(function (k) { W_NAVS[k].classList.toggle('on', k === now); });

    W_SEC_G.hidden = !g1.length;
    W_SEC_P.hidden = !g2.length;
    // 空态分流：有搜索词 = 没搜到（保持原文案）；无搜索词 = 真的还没有聊天记录
    W_EMPTY.textContent = q ? '没有匹配的聊天' : '还没有聊天记录——机器人加入群聊后会自动出现在这里';
    W_EMPTY.hidden = (g1.length + g2.length) > 0;

    reconcileRows(W_ROWS_G, g1);
    reconcileRows(W_ROWS_P, g2);

    // R118：左栏滚动恢复（补偿新增/重排行的高度，见函数开头的说明）。
    // ccLastChat !== st.chat = 刚切换聊天对象 → 不恢复（另一份列表的位置）。
    if (ccLastChat === st.chat && listTop0 > 4) {
      var listDelta = LIST.scrollHeight - listH0;
      LIST.scrollTop = listTop0 + (listDelta > 0 ? listDelta : 0);
    }
    ccLastChat = st.chat;   // R118：记账：这份列表已经渲染过了
  }

  /** 把 desired（chatGroups 的过滤结果）同步进 container：复用 / 更新 / 插入 / 移除。 */
  function reconcileRows(container, desired) {
    var want = {};
    desired.forEach(function (g) { want[g.key] = g; });
    // 1) 移除不再出现的行（被搜索词过滤掉 / 该聊天没会话了）
    var old = container.querySelectorAll('.bp-row');
    for (var i = old.length - 1; i >= 0; i--) {
      var k = old[i].getAttribute('data-chat');
      if (!want[k]) old[i].remove();
    }
    // 2) 顺序 + 内容。全量走一遍，但只是移动/比对节点，不重建 DOM。
    var prev = null;
    desired.forEach(function (g) {
      var el = findRow(container, g.key);
      if (!el) {
        el = makeRow(g);
      } else if (el.getAttribute('data-sig') !== rowSig(g)) {
        updateRow(el, g);   // R115：就地更新，别整块换节点 —— 见 updateRow 注释
      }
      el.classList.toggle('on', g.key === st.chat);
      if (prev) { if (prev.nextElementSibling !== el) prev.after(el); }
      else if (container.firstElementChild !== el) container.insertBefore(el, container.firstElementChild);
      prev = el;
    });
  }

  function findRow(container, key) {
    var kids = container.children;
    for (var j = 0; j < kids.length; j++) {
      if (kids[j].getAttribute && kids[j].getAttribute('data-chat') === key) return kids[j];
    }
    return null;
  }

  /** 行内容指纹：名称 / 最近消息 / 进行中数 / 总会话数任一变化 → 重画这一行。
   *  不含选中态（选中只切 class，不值得重建节点）。 */
  function rowSig(g) {
    return [g.key, g.name, g.last, g.active, g.total].join('\u0001');
  }

  function makeRow(g) {
    var d = document.createElement('div');
    d.innerHTML = chatRow(g);
    var row = d.firstElementChild;
    row.setAttribute('data-sig', rowSig(g));
    return row;
  }

  /**
   * 行内容**就地更新**：只改变化的文字与状态胶囊，头像 img 节点绝不碰。
   *
   * 为什么不能整块 replaceWith（2026-10-14 用户复现「只要有新对话就闪一下」）：
   * 聊天行的头像是**真实 QQ 网络头像**（p.qlogo.cn / q1.qlogo.cn，见 avHtml）。
   * 整块换节点 = 重新创建 <img> = 重新拉一次头像 —— 哪怕走 HTTP 缓存也有
   * 一帧空白→显图的过程，新会话到来时那一行就"闪"一下。群越活跃闪得越烦。
   * 结构（头像/名字/最近消息/胶囊）里只有文字会变，逐项 textContent 补丁即可。
   */
  function updateRow(el, g) {
    var rt = el.querySelector('.bp-rt');
    if (rt && rt.textContent !== g.name) rt.textContent = g.name;
    var ri = el.querySelector('.bp-ri');
    var last = g.last || '—';
    if (ri && ri.textContent !== last) ri.textContent = last;
    var pill = el.querySelector('.cc-pill');
    var wantActive = !!g.active;
    var wantText = wantActive ? (g.active + ' 个进行中') : (g.total + ' 个会话');
    if (pill && (pill.textContent !== wantText || pill.classList.contains('cc-running') !== wantActive)) {
      pill.className = 'cc-pill ' + (wantActive ? 'cc-running' : 'cc-gray');
      pill.textContent = wantText;
    }
    el.setAttribute('data-sig', rowSig(g));
  }

  /** 左栏顶部「页面」：会话 / 存档 / 记忆。
   *
   *  ⚠️ 2026-10-09（r26）这里原来是 `switchTab(name)` 就完事 —— 用户报「点了没反应」。
   *  根因：`.bigpage` 是 `position:fixed; inset:0; z-index:60` 的全屏遮罩，切底层
   *  `#view-chats` / `#view-memory` 在遮罩底下发生，肉眼完全看不见。
   *  （实测：点「存档」后 state.tab='chats'、#view-chats 已 active、但 bigpage 仍开着、
   *    右栏还是那张会话卡 —— 等于什么都没发生。顺带还埋下原型 v23 那个 bug：
   *    关掉全屏页会落在「存档」页，返回不回原页。）
   *
   *  照原型 v22/v23 的定论改：**点非当前页 = 就地换右栏视图，全屏页不关**；
   *  点当前页什么都不做；底层的落点仍然同步切（左栏选中态 / 一级高亮靠它），
   *  但由 `sync()` 里的 `bpPrevSub` 在关闭时还原 —— 于是「返回」真的回到打开前那一页。 */
  function gotoPage(name) {
    if (!name) return;
    if (name === tabNow()) {
      // 萌新化：点当前页不跳转，但给一句轻提示说明「已经在这一页了」。
      // 主界面没有轻量 toast，用 09-dialogs.js 的统一非阻塞对话框 qaAlert
      // （项目里替代原生 alert 的那一套）；提示失败不拦"什么都不做"的本意。
      try {
        qaAlert('已经在当前页面了（' + ({ sessions: '会话', chats: '存档', memory: '记忆' }[name] || name) + '）');
      } catch (e) { /* 忽略 */ }
      return;        // 原型 v22：点当前页不做事（也不退出）
    }
    try { switchTab(name); } catch (e) { /* 忽略 */ }
    try { autoPick(); } catch (e) { /* 忽略 */ }
    applyRight(true);
    fillLeft();
  }

  /** 左栏点一个「聊天对象」。三个页面各自落到不同的详情：
   *   会话 → 选中该聊天的最近一条会话（右栏展开它）
   *   存档 → 选中该聊天的消息存档（04-archive-usage.js 的全局 selectChat）
   *   记忆 → 选中该聊天的群友印象（05-memory-settings.js 的 loadMemoryDetail）
   *
   *  ⚠️ 这个名字（pickChat）是刻意的：`selectChat` 是 04-archive-usage.js 的**全局函数名**，
   *     本 IIFE 里再定义同名的会把全局那个遮住，只能靠 `window.selectChat` 取回 ——
   *     改名叫 pickChat，两个都不容易混。 */
  function pickChat(key) {
    if (!key) return;
    st.chat = key;
    ccUserPickAt = Date.now();                 // R122-B：点左栏聊天也是用户接管
    var m = tabNow();
    if (m === 'chats') {
      // 没有存档的聊天不硬选，免得 04 去拉一个 404、右栏跳出「加载失败」
      if (hasArchive(key)) { try { window.selectChat(key); } catch (e) { /* 忽略 */ } }
    } else if (m === 'memory') {
      if (hasMemory(key)) {
        try {
          state.currentMemoryChatKey = key;
          if (typeof loadMemoryDetail === 'function') loadMemoryDetail(key);
        } catch (e) { /* 忽略 */ }
      }
    } else {
      var list = sessionsOf(key);
      if (list.length && typeof selectSession === 'function') {
        ccFromUserClick = list[0].id;             // R122-B：这也是用户发起的选择
        selectSession(list[0].id);                // 最新一条默认展开
      }
    }
    applyRight(true);
    fillLeft();
  }

  function hasArchive(key) {
    try { return (state.chats || []).some(function (c) { return c && c.key === key; }); } catch (e) { return false; }
  }
  function hasMemory(key) {
    try { return (state.memoryFiles || []).some(function (f) { return f && f.chatKey === key; }); } catch (e) { return false; }
  }

  /** 从「会话」切到「存档 / 记忆」时，把当前这行的聊天对象顺手选中 —— 别让右栏空着
   *  （原型进存档/记忆页也是带着当前聊天对象进去的）。只在数据到齐后才做，
   *  调用点见文件末尾对 loadChats / loadMemoryView 的包裹。 */
  function autoPick() {
    var m = tabNow();
    if (m === 'sessions') return;
    var key = st.chat;
    if (!key) return;
    var cur = m === 'chats' ? currentKey('chats') : currentKey('memory');
    if (cur === key) return;
    if (m === 'chats' ? hasArchive(key) : hasMemory(key)) pickChat(key);
  }

  function currentKey(m) {
    try { return m === 'chats' ? (state.currentChatKey || null) : (state.currentMemoryChatKey || null); }
    catch (e) { return null; }
  }

  // ── 右栏：离屏暂存区 + 「借出 / 还回」登记 ─────────────────────────────
  //
  // 本页右栏在三种页面下装的东西不一样（原型 bpRightRender 也是这么分的）：
  //   会话 → 状态条 + 会话卡（卡体里塞 02-sse-sessions.js 渲染的节点）
  //   存档 → 04-archive-usage.js 的 #chat-detail（真正的消息存档面板）
  //   记忆 → 05-memory-settings.js 的 #memory-detail（真正的群友印象面板）
  //
  // 后两者**不重画**，直接把真机那两个面板搬进来 —— 数据、工具栏、删除按钮、
  // 滚动加载全是现成的，一行都不用抄（抄一份必然与 04/05 分叉）。
  // 搬出去的东西要能原样放回：借出时记下原宿主与后继兄弟节点，关闭 / 切页时还回。

  var HOLD = document.createElement('div');    // 离屏暂存：会话模式下 02 的节点
  var borrowed = {};                           // id -> { el, parent, next }
  var AUX_PANES = { chats: 'chat-detail', memory: 'memory-detail' };   // 页面 → 要借的真机面板
  var AUX_IDS = ['chat-detail', 'memory-detail'];

  /** 借出某块面板。已借出过的直接返回**对象引用** ——
   *  ⚠️ 不能只靠 `getElementById`：面板已经搬进右栏，之后每次 `DETAIL.innerHTML = ''`
   *     都会把它摘出文档，此时它已不在 document 里，getElementById 会返回 null，
   *     再想挂回去就找不到对象了（下一句 appendChild 就没东西可挂）。 */
  function borrow(id) {
    var rec = borrowed[id];
    var el = rec ? rec.el : document.getElementById(id);
    if (!el) return null;
    if (!rec) borrowed[id] = { el: el, parent: el.parentNode, next: el.nextSibling };
    return el;
  }
  function giveBack(id) {
    var rec = borrowed[id];
    if (!rec) return;
    delete borrowed[id];
    var el = rec.el, p = rec.parent;
    if (!el || !p) return;
    if (el.parentNode === p && el.previousSibling === rec.next) return;   // 已在原位，别动（动一下会重置它的滚动位置）
    if (rec.next && rec.next.parentNode === p) p.insertBefore(el, rec.next);
    else p.appendChild(el);
  }
  function giveBackAll() { Object.keys(borrowed).forEach(giveBack); }

  /** 收集 02-sse-sessions.js 渲染在 #session-detail 里的节点。
   *  一定要在 `DETAIL.innerHTML = ''` 之前调用 —— 否则它们被连根销毁。
   *  （排除本层自建节点与借来的存档 / 记忆面板。） */
  function collectSessionNodes() {
    var out = [];
    var body = DETAIL.querySelector('#cc-cards .bs-cb');
    if (body) {
      Array.prototype.slice.call(body.childNodes).forEach(function (n) { out.push(n); });
      return out;
    }
    Array.prototype.slice.call(DETAIL.childNodes).forEach(function (n) {
      if (n.nodeType === 1) {
        if (n.hasAttribute('data-cc')) return;                    // 本层自建（头部 / 卡片 / 宿主）
        if (AUX_IDS.indexOf(n.id) >= 0) return;                   // 借来的 04 / 05 面板
      }
      out.push(n);
    });
    return out;
  }
  /** 切到存档 / 记忆前，把 02 的节点挪进离屏暂存区（切回会话时原样取回） */
  function stashSessionNodes() {
    collectSessionNodes().forEach(function (n) { HOLD.appendChild(n); });
  }
  /** 暂存区里的 02 节点 */
  function heldNodes() { return Array.prototype.slice.call(HOLD.childNodes); }

  // ── 右栏 ───────────────────────────────────────────────────────────────
  function chatHeadHtml() {
    var name = chatDisplayName(st.chat);
    // 萌新化：第二行不再直出原始 chatKey（group:123456789 这种），改成人话
    var keyText = String(st.chat || '');
    var mg = /^group:(\d+)$/.exec(keyText);
    var mp = /^private:(\d+)$/.exec(keyText);
    if (mg) keyText = '群号 ' + mg[1];
    else if (mp) keyText = 'QQ ' + mp[1];
    return avHtml(st.chat, name, 'chat-av') +
      '<span class="chat-head-t">' + esc2(name) + '</span>' +
      '<span class="chat-head-s">' + esc2(keyText) + '</span>';
  }

  function cardHead(s) {
    var when = '';
    try { when = typeof fmtClock === 'function' ? fmtClock(s.startedAt) : ''; } catch (e) { when = ''; }
    // 萌新化：「N 轮」对小白是黑话，挂一句人话 title。left 从此含 HTML，
    // 动态片段（when / d）改为各自 esc2 后直拼，不再整体 esc2。
    var left = (when ? esc2(when) + ' · ' : '') +
      '<span title="模型『思考→行动』了多少轮">' + (s.rounds || 0) + ' 轮</span>';
    var d = dur(s);
    if (d) left += ' · 用时 ' + esc2(d);          // 还没跑完的会话不写「用时」——宁可不出，也不出不成立的数
    var u = s.usage || {};
    var cache = '';
    try { cache = typeof fmtCacheRate === 'function' ? fmtCacheRate(u) : ''; } catch (e) { cache = ''; }
    var stat = u.totalTokens
      ? '<span class="sess-stat">' +
        '<span class="sess-tok" title="这次会话消耗的 token（模型计费单位，约 1 token ≈ 1 个汉字）">↑ ' + (typeof fmtTokens === 'function' ? fmtTokens(u.totalTokens) : u.totalTokens) + '</span>' +
        (cache ? '<span class="sess-cache" title="这部分内容命中了模型缓存，重读时更快、更便宜">' + esc2(cache) + '</span>' : '') +
        '</span>'
      : '';
    return '<span class="bp-ct">' + left + '</span>' +
      '<span class="sess-right">' + stat +
      '<span class="cc-pill cc-' + esc2(s.status || 'done') + '">' + esc2(statusText(s)) + '</span>' +
      '<svg class="bp-chev" viewBox="0 0 12 8"><path d="M2 6l4-4 4 4"/></svg></span>';
  }

  /** 长期持有的 .session-status 引用 —— 见 ensureHead() 注释里「坑 2」。
   *  ⚠️ 必须是模块级 var，不能省；本文件顶有 'use strict'，
   *     少了它 rehomeStatus 里的 `SS = SS || …` 会直接抛 ReferenceError，
   *     被 applyRight 的 try/catch 吞掉后右栏整块不渲染（真踩过）。 */
  var SS = null;

  /** 把 .session-status 搬进右栏状态条 */
  function rehomeStatus(bar) {
    if (!bar) return;
    SS = SS || document.querySelector('.session-status');
    if (!SS) return;
    if (SS.parentElement !== bar) bar.appendChild(SS);
  }

  var warned = false;
  function applyRight(force) {
    if (!BIG.classList.contains('mode-chat') || BIG.hidden) return;
    try {
      if (tabNow() === 'sessions') applyRightInner(force);
      else applyRightAux(tabNow());
    } catch (e) {
      // ⚠️ 不能静默吞：本层自己的编程错误（strict mode 下少个 var 声明就是 ReferenceError）
      //    被吞掉后，外部表现和"根本没写这个功能"完全一样 —— r25 的右栏空白就是这么来的。
      if (!warned) { warned = true; try { console.warn('[chat-chrome] 右栏渲染失败：', e); } catch (e2) { /* 忽略 */ } }
    }
  }

  /** 右栏头部（状态条 + 会话头 + 分区标题），挂在 #session-detail 最前。
   *
   *  ⚠️ 两个坑，别改：
   *  1) #session-detail 会被 02-sse-sessions.js 整块 `innerHTML = …` 重写
   *     （selectSession 的「加载中…」、加载失败、删除会话三条路都会）。
   *     所以头部每次都由本函数**重建**，而不是"建一次就一直用"。
   *  2) .session-status（里面还有 #pause-btn）也活在那次重写里 —— 但它**不能被重建**
   *     （重建等于换掉 01-boot / 00-core 认的那个节点，状态就再也不更新了）。
   *     这里用一个**长期持有的引用 SS** 拿着它：即使被 innerHTML 摘出文档，
   *     对象依然在，下一轮 appendChild 就能挂回去。
   *     （第一版靠 querySelector 找它，切一次聊天状态卡就永久消失 —— 别改回去。）
   *
   *  3) 状态条在三种页面下都留在右栏顶部。原型里「记忆」页的页头也是一条
   *     `.bs-hint.chat-status`（一行按钮）—— 本页底下那颗 .session-status 是
   *     00-core / 01-boot 认的实时状态与暂停键，它必须始终挂在文档里（r24 的教训），
   *     所以不做"只在会话页显示"这种优化。 */
  function ensureHead(m) {
    var head = DETAIL.querySelector('#cc-right-head');
    if (!head) {
      head = document.createElement('div');
      head.id = 'cc-right-head';
      head.setAttribute('data-cc', '1');
      DETAIL.insertBefore(head, DETAIL.firstChild);
    }
    var bar = head.querySelector('.chat-status');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'bs-hint chat-status';
      bar.setAttribute('data-cc', '1');
      head.insertBefore(bar, head.firstChild);
    }
    rehomeStatus(bar);

    // 会话头 + 分区标题：跟着 st.chat 每次刷新。
    // ⚠️ 只在「会话」页加 —— 存档 / 记忆 的右栏是 04/05 自己的面板，
    //    它们自带 `.detail-header > h2`（聊天名）与整排按钮，再加一层就是重复标题。
    var old = head.querySelector('.chat-head');
    if (old) old.remove();
    var oldSec = head.querySelector('.chat-sec');
    if (oldSec) oldSec.remove();
    if (st.chat && m === 'sessions') {
      var ch = document.createElement('div');
      ch.className = 'chat-head';
      ch.setAttribute('data-cc', '1');
      ch.innerHTML = chatHeadHtml();
      head.appendChild(ch);
      var sec = document.createElement('div');
      sec.className = 'bp-sec chat-sec';
      sec.setAttribute('data-cc', '1');
      sec.textContent = '该聊天的 ' + sessionsOf(st.chat).length + ' 个会话 · 按时间倒序';
      head.appendChild(sec);
    }
    return head;
  }

  // ── 卡体「消息流」：把 02 渲染的 .tool-card-flow 压成原型 .tool-step 单行 ─────────────
  // 原型（QQAgent-主界面原型-v2.html 2677 行）里一次工具调用只占一行：
  //   <div class="tool-step"><b>工具</b> memory_recall · 检索「头像 / 身份卡」相关记忆 → 命中 2 条</div>
  // 真机 02 渲染的是**整张 JSON 卡**。入参原文是这个控制台最有用的东西，不能丢 ——
  // 所以单行摘要照原型，原文收进 .ts-raw 由右侧小按钮展开。
  // ⚠️ 02-sse-sessions.js 一个字符不动：这是 DOM 级后处理，用 data-ts 做幂等标记
  //    （每轮轮询 02 都会重写 #session-detail，节点是新的对象，但 02 的 HTML 里没有
  //     data-ts，所以每批只按一次）。幂等**只能**认 data-ts 属性，别改成用 class 判定 ——
  //    class 会被样式/主题改动牵动，属性不会。
  //    2026-10-21：原先这里还会 add 一个 `.ts-on`，但全仓既没有它的样式也没有任何读取方
  //    （样式走 .tool-card-flow / .tool-error，展开态走 .ts-open），已删。
  var TS_RES_MAX = 46;      // 结果摘要最长字数
  var TS_ARG_MAX = 70;      // 入参摘要最长字数

  // 萌新化：工具名汉化小映射 —— 消息流里优先显示中文名，未收录的仍显示原始 id。
  // id 照 src/tools.js 的内置工具逐个核对补全（真实 id 是 memory_query，
  // 不存在 memory_recall）；中文名与 00-core.js 的 TOOL_META 保持同一套说法。
  var TOOL_NAME_CN = {
    send_message: '发消息',
    send_to: '发给指定聊天',
    send_poke: '戳一戳',
    get_recent_messages: '翻聊天记录',
    read_forward: '展开转发消息',
    get_active_members: '看活跃群友',
    get_chats: '看有哪些聊天',
    get_message_detail: '看消息详情',
    get_message_images: '看图片',
    memory_append: '记一条印象',
    memory_query: '查记忆',
    memory_remove: '删记忆',
    web_search: '联网搜索',
    web_fetch: '抓网页',
    send_image: '发网图',
    search_images: '搜图',
    report_feedback: '汇报反馈',
    finish: '结束本次'
  };

  function tsText(el) { return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : ''; }
  function tsClip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n).replace(/\s+$/, '') + '…' : s;
  }
  /** 02 的 .tool-args 是 `JSON.stringify(args, null, 1)` 的原文 → 压成单行摘要。
   *  单键取「值」，多键取 `k=v, k=v` —— 与原型 `memory_recall · 检索「头像」` 的读法一致。 */
  function tsArgs(el) {
    var raw = tsText(el);
    if (!raw) return '';
    var o = null;
    try { o = JSON.parse(raw); } catch (e) { o = null; }
    if (!o || typeof o !== 'object') return tsClip(raw, TS_ARG_MAX);
    var keys = Object.keys(o);
    if (!keys.length) return '';
    var val = function (v) { return (v && typeof v === 'object') ? JSON.stringify(v) : String(v); };
    if (keys.length === 1) return tsClip(val(o[keys[0]]), TS_ARG_MAX);
    return tsClip(keys.map(function (k) { return k + '=' + tsClip(val(o[k]), 40); }).join(', '), TS_ARG_MAX);
  }

  function skinTool(tool) {
    if (!tool || tool.getAttribute('data-ts') === '1') return;
    var head = tool.querySelector('.tool-head');
    var argsEl = tool.querySelector('.tool-args');
    var resEl = tool.querySelector('.tool-result');
    if (!head && !argsEl && !resEl) return;              // 不是 02 那张卡，别动

    var name = tsText(tool.querySelector('.tool-name-flow'));
    var nameShow = TOOL_NAME_CN[name] || name;   // 萌新化：有汉化名优先显示，没有才露原始 id
    var aTxt = tsArgs(argsEl);
    var rTxt = tsClip(tsText(resEl), TS_RES_MAX);
    // 无入参无结果的那种（toolImages：`.tool-head` 里多一句「→ N 张图片已注入」）
    if (!aTxt && !rTxt) aTxt = tsClip(tsText(head).slice(name.length).replace(/^[\s·→]+/, ''), TS_ARG_MAX);
    var isErr = tool.classList.contains('tool-error') || (resEl && resEl.classList.contains('is-error'));

    var line = document.createElement('div');
    line.className = 'ts-line';
    line.innerHTML = '<b>工具</b>' +
      '<span class="ts-sum">' + esc2(nameShow) +
        (aTxt ? ' <span class="ts-arrow">·</span> ' + esc2(aTxt) : '') +
        (rTxt ? ' <span class="ts-arrow">→</span> ' + esc2(rTxt) : '') +
      '</span>' +
      // 原文里没什么可藏的（只有工具名）就不给按钮，免得点了没东西
      ((argsEl || resEl)
        ? '<button class="ts-more" type="button" title="查看原始调用参数 / 返回全文" aria-expanded="false">' +
            // 大括号图标：一眼看出"这是 JSON 原文"
            '<svg viewBox="0 0 12 12" aria-hidden="true">' +
              '<path d="M4.6 1.6C3.5 1.6 3.1 2.1 3.1 3.1v1.4c0 .8-.5 1.2-1.2 1.5.7.3 1.2.7 1.2 1.5v1.4c0 1 .4 1.5 1.5 1.5"/>' +
              '<path d="M7.4 1.6c1.1 0 1.5.5 1.5 1.5v1.4c0 .8.5 1.2 1.2 1.5-.7.3-1.2.7-1.2 1.5v1.4c0 1-.4 1.5-1.5 1.5"/>' +
            '</svg>' +
          '</button>'
        : '');
    tool.appendChild(line);
    if (argsEl || resEl) {
      var rawBox = document.createElement('div');
      rawBox.className = 'ts-raw';
      rawBox.hidden = true;
      [head, argsEl, resEl].forEach(function (n) { if (n) rawBox.appendChild(n); });
      tool.appendChild(rawBox);
    } else if (head) {
      head.remove();                                     // 摘要已经把这句话说完了
    }
    if (isErr) tool.classList.add('tool-error');
    tool.setAttribute('data-ts', '1');
  }

  /** 对一棵子树里所有还没改造过的工具卡做一遍（幂等） */
  function skinTools(root) {
    if (!root) return;
    var list = root.querySelectorAll('.tool-card-flow:not([data-ts])');
    for (var i = 0; i < list.length; i++) skinTool(list[i]);
  }

  /** R126：建一张会话卡（卡头 + 选中卡的卡体）。抽出来给首屏与滚底补卡共用。
   *  selId = 当前选中会话 id（只有它带卡体）；nodes = 02 渲染出来要搬进卡体的节点。 */
  function buildCard(s, selId, nodes) {
    var card = document.createElement('div');
    card.className = 'bp-card' + (s.id === selId ? '' : ' collapsed');
    card.setAttribute('data-cc', '1');
    card.dataset.sid = s.id;
    var btn = document.createElement('button');
    btn.className = 'bp-ch';
    btn.type = 'button';
    btn.dataset.ccFold = s.id;
    var headHtml = cardHead(s);
    btn.innerHTML = headHtml;
    btn.setAttribute('data-head', headHtml);   // R115：给 refreshCards 的签名比对用
    card.appendChild(btn);
    if (s.id === selId) {
      var body = document.createElement('div');
      body.className = 'bs-cb';
      (nodes || []).forEach(function (n) { body.appendChild(n); });
      card.appendChild(body);
    }
    return card;
  }

  /** R126：分页提示条（「向下滚动加载更多（还有 N 条）」）。全部显示完返回 null。 */
  function moreHintEl(total) {
    var rest = total - ccShown;
    if (rest <= 0) return null;
    var em = document.createElement('div');
    em.className = 'bp-more';
    em.id = 'cc-more';
    em.textContent = '向下滚动加载更多（还有 ' + rest + ' 条）';
    return em;
  }

  /** R126：滚到底补下一批会话卡（右栏分页的加载路径）。
   *  与首屏同一套 buildCard；补进来的卡若在「用户手动展开」账本上，
   *  顺手恢复展开态（restoreExpanded，keepBodies 传空 —— 重建时暂存的
   *  卡体早没了，走「加载中…」+ 后台重拉那条路）。 */
  function loadMoreCards() {
    if (!active || tabNow() !== 'sessions') return;
    var cards = DETAIL.querySelector('#cc-cards');
    if (!cards || !st.chat) return;
    var list = sessionsOf(st.chat);
    if (ccShown >= list.length) return;
    var from = ccShown;
    ccShown = Math.min(list.length, ccShown + CC_CARD_PAGE);
    var frag = document.createDocumentFragment();
    list.slice(from, ccShown).forEach(function (s) { frag.appendChild(buildCard(s, null, null)); });
    var oldHint = document.getElementById('cc-more');
    if (oldHint) oldHint.remove();
    cards.appendChild(frag);
    var hint = moreHintEl(list.length);
    if (hint) cards.appendChild(hint);
    var selId = null;
    try { selId = state.currentSessionId || null; } catch (e) { selId = null; }
    if (!list.some(function (s) { return s.id === selId; })) selId = list.length ? list[0].id : null;
    restoreExpanded(cards, list, selId, {});
  }

  /** R121/R122-C1：把用户手动展开过的卡还回去（卡体内容 + 展开态）。
   *
   *  遍历账本 ccUserExpanded 而不是 keepBodies —— 慢接口 >200ms 的占位清空
   *  （02 的 hintTimer）会把展开卡体连内容一起销毁，那时 keepBodies 里没有
   *  这张卡，只按 keepBodies 恢复就会永远把它留在折叠态（账还在、卡已亡）。
   *  现在按账本逐张恢复：keepBodies 有 → 原卡体挂回；没有 → 建「加载中…」
   *  占位盒 + 后台重拉 /api/sessions/:sid，回来后按参数定位填回同一张卡
   *  （renderSessionDetail 包裹层 sel = arguments[0].id，不抢当前选择）。
   *  R126：抽成函数 —— 滚底补卡（loadMoreCards）也要走同一套恢复。 */
  function restoreExpanded(cards, list, selId, keepBodies) {
    var inList = {};
    list.forEach(function (s) { inList[s.id] = 1; });
    Object.keys(ccUserExpanded).forEach(function (sid) {
      var c = cards.querySelector('.bp-card[data-sid="' + sid + '"]');
      if (!c || sid === selId) return;         // 已不存在（被清/删）/ 选中卡走正常路径
      c.classList.remove('collapsed');
      var old = c.querySelector('.bs-cb');
      if (old) old.remove();
      var kept = keepBodies[sid];
      if (kept) { c.appendChild(kept); return; }
      c.appendChild(loadingBody());
      if (typeof api === 'function') {
        api('/api/sessions/' + sid).then(function (s) {
          if (!active || tabNow() !== 'sessions' || !s || !s.id) return;
          try {
            // 卡还在、还展开着才填 —— 用户中途收起过就别打扰
            var cc = DETAIL.querySelector('#cc-cards .bp-card[data-sid="' + sid + '"]');
            if (cc && !cc.classList.contains('collapsed')) window.renderSessionDetail(s);
          } catch (e) { /* 忽略：最差是停在「加载中…」 */ }
        }, function () { /* 拉取失败就停在「加载中…」，用户可重点卡头重试 */ });
      }
    });
    // 销账：不在新列表里的会话（清理过的/删了的），账目不留 stale
    Object.keys(ccUserExpanded).forEach(function (sid) { if (!inList[sid]) delete ccUserExpanded[sid]; });
  }

  function applyRightInner() {
    var chatAtEntry = st.chat;   // R122-P2-6：记入口时的聊天对象，末尾只有切换过才重刷左栏
    ccShown = CC_CARD_PAGE;      // R126：全量重建 = 分页归零重来（首屏 50 张，滚底再补）
    // R118/R119：右栏滚动锚定（详见文件头 captureScrollAnchor 注释）。
    // 入口③（R122-C3 精化）：骨架健在 = DETAIL 内容完好、scrollTop 是实时
    // 有效位置 → force 重抓（每次重建前把锚点推到最新）；骨架没了 = 已被
    // 02 的占位/重建清空，此刻抓只能抓到 0 → 非强制，沿用 ①/② 的好锚点。
    if (DETAIL.querySelector('#cc-cards')) captureScrollAnchor(true); else captureScrollAnchor();
    var groups = chatGroups();
    // 当前会话决定右栏是谁 —— 左栏选中态必须跟着它走。
    // 若反过来只看"最新会话的聊天"，会出现「左栏选中张同学、右栏却是 AI 工具交流群的内容」
    // 这种左右不一致（本层踩过）。所以只要 state.currentSessionId 有主，就以它为准。
    var cur = null;
    try { cur = state.currentSessionId || null; } catch (e) { cur = null; }
    var curS = cur ? S().filter(function (s) { return s.id === cur; })[0] : null;
    if (curS && curS.chatKey && groups.some(function (g) { return g.key === curS.chatKey; })) {
      st.chat = curS.chatKey;
    } else if (!st.chat || !groups.some(function (g) { return g.key === st.chat; })) {
      st.chat = groups.length ? groups[0].key : null;
    }
    var list = st.chat ? sessionsOf(st.chat) : [];
    var selId = null;
    try { selId = state.currentSessionId || null; } catch (e) { selId = null; }
    if (!list.some(function (s) { return s.id === selId; })) selId = list.length ? list[0].id : null;
    // R126：选中会话若落在首屏之外（重开页面时正读着一条旧会话），把分页窗口
    //    扩到包含它 —— 否则它的卡不在首屏，02 渲染出来的详情节点没人接。
    if (selId) {
      for (var si = 0; si < list.length; si++) {
        if (list[si].id === selId) { if (si >= ccShown) ccShown = si + 1; break; }
      }
    }

    // ① R121/R122：把「用户手动展开、且不是本次选中」的卡体摘进离帧容器。
    //    重建会 `DETAIL.innerHTML = ''`，不先摘出来，这些卡连内容一起没了；
    //    而按 r37/旧设计它们会被折叠收起——正是用户反馈的
    //    「手动展开的为什么会自动收起」。
    //    ⚠️ R122：必须在 collectSessionNodes **之前**跑 ——
    //    collectSessionNodes 取「#cc-cards 里第一个 .bs-cb」的子节点当选中卡
    //    内容，而用户展开的卡也有卡体；若它在 DOM 里排在选中卡前面（会话按
    //    时间倒序，完全可能），握走的就是它的节点 → 选中卡与它的内容整体
    //    调包。先摘走，querySelector 必然只剩选中卡的卡体可命中。
    while (ccBodyHold.firstChild) ccBodyHold.removeChild(ccBodyHold.firstChild);
    var keepBodies = {};
    try {
      DETAIL.querySelectorAll('#cc-cards .bp-card[data-sid]').forEach(function (c) {
        if (c.classList.contains('collapsed')) return;
        var sid = c.dataset.sid;
        if (!sid || sid === selId || !ccUserExpanded[sid]) return;
        var b = c.querySelector('.bs-cb');
        if (b) { ccBodyHold.appendChild(b); keepBodies[sid] = b; }
      });
    } catch (e) { /* 快照失败不致命：最差是这张卡照旧被收起 */ }

    // ② 把 02 渲染出来的节点从旧卡体（或直接从 #session-detail）里摘出来；
    //    若它们正躺在离屏暂存区（上一轮从存档 / 记忆切回来），就从那儿取回。
    var nodes = collectSessionNodes();
    if (!nodes.length) nodes = heldNodes();

    // ②′ 从「存档 / 记忆」切回「会话」时，必须先把借出去的面板还回原页 ——
    //     否则下面那句 `DETAIL.innerHTML = ''` 会把面板从文档里摘掉、又没人放回去，
    //     真机的存档 / 记忆 页就永久空白了（探针踩到过：#memory-detail 变 null）。
    Object.keys(AUX_PANES).forEach(function (k) { giveBack(AUX_PANES[k]); });

    // ③ 重建骨架：先清空（顺手把头部也清了），再把头部挂回最前
    // ⚠️ R118/R119：`innerHTML = ''` 会把 DETAIL（.detail-pane，右栏的滚动容器，
    //    overflow-y:auto）的 scrollTop 清零。新会话卡按时间倒序插在最顶，
    //    用户正在下面读旧卡片时视野被整个弹回顶部。锚点在清空前就已抓好
    //    （文件头三个入口），重建完成后按高度差补偿恢复。用户本来就在顶部
    //    （scrollTop≈0）则不恢复：新卡出现在顶部即所见（聊天式跟随）。
    DETAIL.innerHTML = '';
    ensureHead('sessions');

    // ④ 会话卡（最新在上，当前会话默认展开，卡体里放 02 渲染的内容）
    //    R126：只建前 ccShown 张 —— 全量一次性建 DOM 是这个页面打开卡顿的
    //    根因（4115 条会话 ≈ 1s 主线程阻塞，见 CC_CARD_PAGE 注释）；之外的卡
    //    由 loadMoreCards 滚底补，不在打开路径上。
    var cards = document.createElement('div');
    cards.id = 'cc-cards';
    cards.setAttribute('data-cc', '1');
    list.slice(0, ccShown).forEach(function (s) {
      cards.appendChild(buildCard(s, selId, nodes));
    });
    if (!st.chat) {
      // 零会话白板：整个应用一条会话都没有 —— 给萌新一条「怎么让这里出现内容」的路
      var em0 = document.createElement('div');
      em0.className = 'bp-empty';
      em0.textContent = '这里会记录机器人的每次应答。把机器人拉进群、@ 它说句话，记录就会出现在左侧';
      cards.appendChild(em0);
    } else if (!list.length) {
      var em = document.createElement('div');
      em.className = 'bp-empty';
      em.textContent = '这个聊天还没有会话记录——有人 @ 它或触发关键词时，这里会产生新记录';
      cards.appendChild(em);
    }
    var moreEl = moreHintEl(list.length);
    if (moreEl) cards.appendChild(moreEl);
    DETAIL.appendChild(cards);

    // ⑤ 卡体里的工具卡：压成原型 .tool-step 单行 + 「查看原文」按钮
    //    （节点可能刚从 HOLD 取回、上一轮已经改造过 —— skinTools 是幂等的）
    skinTools(cards);

    // ⑤′ 运行中的卡自动展开（r37）：重建后按 runSeen 账本补一次迁移检测 ——
    //     首次见到活跃会话时这里负责掀开；已有账目的卡不会重复动作。
    autoFoldTick();

    // R121/R122-C1：把用户手动展开的卡还回去（卡体内容 + 展开态）。
    // R122-C1（P1-3「账在卡亡」自愈）：遍历账本 ccUserExpanded 而不是
    // keepBodies —— 慢接口 >200ms 的占位清空（02 的 hintTimer）会把展开卡体
    // 连内容一起销毁，那时 keepBodies 里没有这张卡，旧代码就永远把它留在
    // 折叠态（账还在、卡已亡）。现在按账本逐张恢复：keepBodies 有 → 原卡体
    // 挂回；没有 → 建「加载中…」占位盒 + 后台重拉 /api/sessions/:sid，回来
    // 后按参数定位填回同一张卡（renderSessionDetail 包裹层 sel = arguments
    // [0].id，不抢当前选择）。放在 autoFoldTick 之后——它只按状态迁移动作，
    // 被恢复的卡不受影响；放在滚动恢复之前——卡体挂回会改高度，那一截得算
    // 进锚点补偿。
    restoreExpanded(cards, list, selId, keepBodies);

    // R118/R119：滚动锚定恢复（说明见文件头 captureScrollAnchor）。放在
    // autoFoldTick 之后——它掀开/收起卡体会改高度，那一截得算进高度差补偿。
    restoreScrollAnchor();

    // ⑥ 卡片：点卡头 = 切到那条会话（= 展开它）／点已展开的卡头 = 收起
    cards.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-cc-fold]');
      if (!b) return;
      var card = b.closest('.bp-card');
      if (!card) return;
      if (card.classList.contains('collapsed')) {
        // R117：**点击即展开**（同步，绝不等 /api/sessions/:id 回来）。
        // R116 把展开保证挪进了 renderSessionDetail 包裹层，而包裹层要等详情
        // 接口拉完 + 渲染完才跑（大会话服务端 structuredClone + 网络 + 前端渲染，
        // 几百毫秒起）——用户眼里就是"点了愣一会才弹出来"（2026-10-14 用户复现，
        // 点已中止会话卡的卡头）。展开是纯选择语义，点下去就该立刻发生；
        // 内容随后由包裹层 wantExpand/fresh 分支填（那边也会兜底再摘一次）。
        // 卡体没有就先从离帧暂存区捞回被手风琴收起的旧卡体（R122-C5，内容
        // 现成、无需重拉），再没有才建「加载中…」占位盒：展开立刻有内容区，
        // 「别的卡收回卡体并折叠」的新选中态语义也提前保持一致。
        card.classList.remove('collapsed');
        ccUserExpanded[card.dataset.sid] = true;   // R121：用户手动展开 → 记账
        ccUserPickAt = Date.now();                 // R122-B：用户接管，暂停自动跟随
        ccFromUserClick = card.dataset.sid;        // R122-B：标记这次 selectSession 是用户发起
        var body0 = card.querySelector('.bs-cb');
        if (!body0) card.appendChild(pullParkedBody(card.dataset.sid) || loadingBody());
        // R121：手风琴——用户点了这张，别的展开卡收起（这是用户动作，明确意图）。
        // 原来只在"新建卡体"时才收，导致点已有卡体的卡时多张同时展开、状态不确定；
        // 现在无论卡体是否已存在都收，语义确定。
        // R122-C5：收起的卡体 park 进离帧容器而不是销毁 —— 用户马上又点开它时
        // 能从暂存区原样捞回（上面那行），不用重拉详情、不闪「加载中…」。
        cards.querySelectorAll('.bp-card[data-sid]').forEach(function (c) {
          if (c !== card) {
            var b2 = c.querySelector('.bs-cb');
            if (b2) { b2.dataset.ccOwner = c.dataset.sid; ccBodyHold.appendChild(b2); }
            c.classList.add('collapsed');
            delete ccUserExpanded[c.dataset.sid];   // R121：被手风琴收起的卡销账
          }
        });
        if (typeof selectSession === 'function') selectSession(card.dataset.sid);
      } else {
        card.classList.add('collapsed');
        // R121：用户手动收起 = 销账（并取消这条会话的"待展开"意图，否则连点两下
        // 时晚到的详情渲染会凭 ccPendingExpand 又把卡抢开）。
        delete ccUserExpanded[card.dataset.sid];
        if (ccPendingExpand === card.dataset.sid) ccPendingExpand = null;
      }
    });

    // R122-P2-6：只有 st.chat 被兜底改过（切换了聊天对象）才需要重刷左栏
    // 选中态；没变就别跑 —— 同一个 tick 里 renderSessionList 包裹层已经跑过
    // 一次 fillLeft + refreshCards，双 fillLeft 白跑一轮 reconcile。
    if (st.chat !== chatAtEntry) fillLeft();
  }

  /** 右栏 = 「存档」/「记忆」页（原型 bpRightRender 的后两个分支）。
   *
   *  做法与「会话」页一致：**搬真机的面板进来**，而不是照原型重画一份。
   *   · 存档 → 04-archive-usage.js 的 #chat-detail（消息存档表 + 唤醒/标记已读/
   *            清空/选择删除/手动发测试消息整排工具栏）
   *   · 记忆 → 05-memory-settings.js 的 #memory-detail（群友印象卡 + 拉取群成员 /
   *            添加印象 / 整理本群记忆）
   *  这样 04 / 05 的渲染、事件、轮询全部原样生效，本层只负责"搬到右栏"这件事。 */
  function applyRightAux(m) {
    var paneId = AUX_PANES[m];
    if (!paneId) return;

    // ① 会话页的节点先离屏暂存（切回会话时原样取回），另一块面板先还回原处
    stashSessionNodes();
    Object.keys(AUX_PANES).forEach(function (k) { if (AUX_PANES[k] !== paneId) giveBack(AUX_PANES[k]); });

    // ② 左栏选中态：跟着该页当前选中的聊天对象走（首次进入则沿用 st.chat）
    var groups = chatGroups();
    var link = currentKey(m);
    if (link && groups.some(function (g) { return g.key === link; })) {
      st.chat = link;
    } else if (!st.chat || !groups.some(function (g) { return g.key === st.chat; })) {
      st.chat = groups.length ? groups[0].key : null;
    }

    // ③ 骨架：清空（头部与两块面板一起被摘出文档）→ 建头 → 把面板挂回去。
    //    ⚠️ 借出过的面板对象引用还在（borrowed 里），appendChild 就能回到文档。
    DETAIL.innerHTML = '';
    ensureHead(m);
    var pane = borrow(paneId);
    if (pane) {
      if (pane.parentElement !== DETAIL) {
        pane.classList.add('cc-aux-pane');
        DETAIL.appendChild(pane);
      }
      // 面板自带 detail-header（聊天名 + 工具栏），所以右栏不再加第二层标题
    }
    fillLeft();
  }

  /** 轮询刷新：卡头文字就地更新（签名守卫）+ R122 增量补卡/删卡/排序。
   *  原来新会话只能等全量重建（自动跟随触发）才在右栏出现 —— 短会话、或被
   *  R122-B 暂停了自动跟随时，右栏列表是旧的（左右栏计数不一致）。现在每次
   *  刷新都把 #cc-cards 同步成 sessionsOf(st.chat) 的真实内容：缺的卡按
   *  startedAt 倒序插入（新建卡一律折叠、无卡体，选中卡走既有渲染路径），
   *  消失的卡移除。插入/移除会改高度 → 用和左栏同款的滚动补偿保住阅读位置。 */
  function refreshCards() {
    var cards = DETAIL.querySelector('#cc-cards');
    if (!cards || !st.chat) return;
    var list = sessionsOf(st.chat);
    var map = {};
    list.forEach(function (s) { map[s.id] = s; });
    // R122：右栏滚动锚定（补卡插顶会把下面内容推下去）
    var top0 = DETAIL.scrollTop, h0 = DETAIL.scrollHeight;
    // ① 卡头就地更新（R115 签名守卫，内容没变不碰 DOM）
    cards.querySelectorAll('.bp-card[data-sid]').forEach(function (card) {
      var s = map[card.dataset.sid];
      var btn = card.querySelector('.bp-ch');
      if (s && btn) {
        var h = cardHead(s);
        if (btn.getAttribute('data-head') !== h) {
          btn.innerHTML = h;
          btn.setAttribute('data-head', h);
        }
      }
    });
    // ② 删卡：列表里没有的（会话被删除 / 清空已结束）
    cards.querySelectorAll('.bp-card[data-sid]').forEach(function (card) {
      if (!map[card.dataset.sid]) card.remove();
    });
    // ③ 补卡 + 排序：缺的卡建出来（结构同 applyRightInner：卡头 + data-head 签名），
    //    然后整体按 list 顺序重排（只移动节点，不重建 → 展开态/卡体原生保留）
    //    R126：只在分页窗口内补 —— 不然轮询一次就把 4115 张卡全补回来，分页白做。
    var existing = {};
    cards.querySelectorAll('.bp-card[data-sid]').forEach(function (c) { existing[c.dataset.sid] = c; });
    var win = list.slice(0, ccShown);
    win.forEach(function (s) {
      if (existing[s.id]) return;
      existing[s.id] = buildCard(s, null, null);
    });
    var prev = null;
    win.forEach(function (s) {
      var el = existing[s.id];
      if (prev) { if (prev.nextElementSibling !== el) prev.after(el); }
      else {
        var firstCard = cards.querySelector('.bp-card');
        if (firstCard !== el) cards.insertBefore(el, firstCard || null);
      }
      prev = el;
    });
    // ④ 空态提示：常驻节点只切 hidden（同左栏 W_EMPTY 的处理）
    var em = cards.querySelector('.bp-empty');
    if (em) em.hidden = list.length > 0;
    // R126：分页提示条跟着真实条数走（删会话/清空会让「还有 N 条」失真；
    //    窗口被新会话挤出时也要能补出提示条）
    var hintEl = document.getElementById('cc-more');
    var restN = list.length - ccShown;
    if (restN > 0) {
      if (hintEl) hintEl.textContent = '向下滚动加载更多（还有 ' + restN + ' 条）';
      else cards.appendChild(moreHintEl(list.length));
    } else if (hintEl) hintEl.remove();
    autoFoldTick();
    // R122：滚动恢复（补偿新增/删除卡的高度，见函数开头的说明）
    if (top0 > 4) {
      var d = DETAIL.scrollHeight - h0;
      DETAIL.scrollTop = top0 + (d > 0 ? d : 0);
    }
  }

  // ── r37：会话卡随运行状态自动展开 / 收起 ─────────────────────────────────
  //  用户拍板：「运行中的展开，运行结束之后自动收起」。
  //  · 活跃（isLive = running / waiting，等待下一轮也算还没跑完）→ 展开卡体看实时输出；
  //  · 跑到终态（已发言 / 未回复 / 出错 / 中止）→ 自动收起。
  //  ⚠️ 只在**状态迁移**时动作（runSeen 记住每个会话上一次的活跃态）：
  //    用户手动收起运行中的卡、或手动展开已结束的卡，轮询一律不跟用户抢 ——
  //    没有迁移就什么都不做。
  //  ⚠️ runSeen 是模块级长期账本，**不能**在 applyRightInner 重建卡时清零：
  //    重建会把非选中卡一律折叠，若清零账本，每次重建都会把「运行中但非选中」的卡
  //    重新 selectSession 一遍，把用户手动选中的别的会话顶掉（r37 探针踩过）。
  var runSeen = {};
  function autoFoldTick() {
    if (!st.chat) return;
    var map = {};
    sessionsOf(st.chat).forEach(function (s) { map[s.id] = s; });
    DETAIL.querySelectorAll('.bp-card[data-sid]').forEach(function (card) {
      var s = map[card.dataset.sid];
      if (!s) return;
      var act = isLive(s) ? 'active' : 'over';
      var prev = runSeen[s.id];
      if (prev === act) return;              // 无迁移：不动（尊重用户手动折叠/展开）
      runSeen[s.id] = act;
      if (act === 'active') {
        if (!card.classList.contains('collapsed')) return;
        if (card.querySelector('.bs-cb')) {
          card.classList.remove('collapsed');       // 有卡体 → 直接掀开
        } else if (typeof selectSession === 'function') {
          selectSession(s.id);                      // 没卡体（非选中会话）→ 走正式选中
        }
      } else if (prev === 'active') {
        // 活跃 → 终态：自动收起。⚠️ R121：用户手动展开过的卡不自动收 ——
        // 用户点开来看的，跑完了也留着（「手动展开的为什么会自动收起」）。
        if (!ccUserExpanded[s.id]) card.classList.add('collapsed');
      }
    });
  }

  // ── 生效 / 复位 ─────────────────────────────────────────────────────────
  var active = false;

  function activate() {
    if (active) return;
    active = true;
    buildStatic();
    // 头像兜底：img 加载失败时把首字揭开。左栏绑 W_LIST、右栏绑 DETAIL ——
    // 两个都是长期容器（W_LIST 内部整体重绘、DETAIL 换 innerHTML），
    // delegation 只绑一次就够，不能逐个 img 绑。
    bindAvatarFallback(W_LIST);
    bindAvatarFallback(DETAIL);
    // R126：右栏会话卡分页的滚底加载（02 同款 loader，幂等 —— 重复调用只更新回调）。
    // 不挂的话首屏 50 张之外的会话永远补不进来。
    if (typeof attachScrollLoader === 'function') {
      attachScrollLoader('session-detail', function () { loadMoreCards(); });
    }
    fillLeft();
    applyRight(true);                 // 右栏按当前页面分派：见 applyRight / applyRightAux
    // 原型：进页面就是「最新一条默认展开」，不是空着让用户先点一下。
    // ⚠️ 只在「会话」页做 —— 存档 / 记忆 的默认选中要等后端数据（state.chats /
    //    state.memoryFiles）到齐，由 autoPick() 负责，见文件末尾对 loadChats /
    //    loadMemoryView 的包裹。
    if (tabNow() === 'sessions') {
      var sel = null;
      try { sel = state.currentSessionId || null; } catch (e) { sel = null; }
      var list = st.chat ? sessionsOf(st.chat) : [];
      if (!sel && list.length && typeof selectSession === 'function') selectSession(list[0].id);
    } else {
      autoPick();
    }
  }

  function deactivate() {
    if (!active) return;
    active = false;
    // ⚠️ 借来的 #chat-detail / #memory-detail 必须先还回 #view-chats / #view-memory：
    //    它们是**真机那两个页面的正式面板**，留在右栏里会让用户切回存档页时看到空白。
    giveBackAll();
    // 还回原位：把 .session-status 放回列表头，隐藏的节点恢复显示
    var ss = document.querySelector('.session-status');
    var head = LIST.querySelector('.list-head');
    if (ss && head) head.appendChild(ss);
    var cnt = document.getElementById('session-count');
    var lhRow = head && head.querySelector('.lh-row');
    if (cnt && lhRow) lhRow.insertBefore(cnt, lhRow.firstChild);
    ['#cc-search-wrap', '#cc-left', '#cc-actions'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el) el.remove();
    });
    W_SEARCH = W_LIST = W_ACTS = null;
    W_SEC_PAGE = null; W_NAVS = null; W_SEC_G = null; W_SEC_P = null;
    W_ROWS_G = null; W_ROWS_P = null; W_EMPTY = null;
    var items = document.getElementById('session-items');
    var more = document.getElementById('session-more');
    if (items) items.classList.remove('cc-hide');
    if (more) more.classList.remove('cc-hide');
    if (head) head.classList.remove('cc-hide');
  }

  // 打开全屏页前的落点 —— 关闭时还原（原型 v23）。
  // 不还原的话：「会话选择」里点一下「存档」再点返回，主界面会停在存档页，
  // 看起来像"退不出去"（原型用户实测报过同一个 bug）。
  var bpPrevSub = null, bpWasOpen = false;

  function sync() {
    var open = !BIG.hidden;                                        // 全屏页可见（chat / setup 都算）
    var chatOn = open && BIG.classList.contains('mode-chat');
    var wasOpen = bpWasOpen;
    bpWasOpen = open;      // 先落状态：下面还原里的 switchTab 会再次触发本函数，别重复还原
    if (open && !wasOpen) {
      bpPrevSub = tabNow();
    } else if (!open && wasOpen) {
      var back = bpPrevSub; bpPrevSub = null;
      if (back && back !== tabNow()) { try { switchTab(back); } catch (e) { /* 忽略 */ } }
    }
    if (chatOn) activate(); else deactivate();
    if (chatOn) applyRight(true);
  }

  // 大屏页开关（hidden 属性）与两个 mode class 的变化都盯住
  try {
    new MutationObserver(function () { sync(); }).observe(BIG, {
      attributes: true, attributeFilter: ['hidden', 'class']
    });
  } catch (e) { /* 忽略 */ }

  // .session-status 被搬出 / 回挂时把它再搬回右栏状态条
  try {
    new MutationObserver(function () {
      if (!active) return;
      var bar = DETAIL.querySelector('.chat-status');
      if (bar) rehomeStatus(bar);
    }).observe(LIST, { childList: true, subtree: true });
  } catch (e) { /* 忽略 */ }

  /** 包裹一个**异步**全局函数：它 resolve 之后再跑 after（数据到齐才能做的事）。
   *  与同步包裹同一套思路，只是把回调挂到 promise 上。 */
  function wrapAsync(name, after) {
    var f = window[name];
    if (typeof f !== 'function') return;
    window[name] = function () {
      var p = f.apply(this, arguments);
      var run = function () { if (!active) return; try { after(); } catch (e) { /* 忽略 */ } };
      try { Promise.resolve(p).then(run, run); } catch (e) { run(); }
      return p;
    };
  }

  // 包裹全局函数（不改 02 / 04 / 05 一个字符）
  (function wrap() {
    var rl = window.renderSessionList;
    if (typeof rl === 'function') {
      window.renderSessionList = function () {
        var r = rl.apply(this, arguments);
        if (active) { try { fillLeft(); refreshCards(); } catch (e) { /* 忽略 */ } }
        return r;
      };
    }
    var rd = window.renderSessionDetail;
    if (typeof rd === 'function') {
      window.renderSessionDetail = function () {
        var m = tabNow();
        // R114：02 的 renderSessionDetail 会 `detail.innerHTML = 整串` 覆盖
        // #session-detail —— 而 #session-detail 就是本层 DETAIL（装着 #cc-cards
        // 骨架 + 头部）。旧路径一发现 #cc-cards 没了就 applyRight(true) 把整个
        // 选择器（左栏 + 全部卡片）推倒重建 → 满屏闪，正是用户报的
        // 「有新对话出现会话选择界面就会刷新导致页面闪烁」的右半部分。
        //
        // 新路径（会话页 + 骨架健在）：调用前把 DETAIL 里的本层节点（全带
        // data-cc）摘进离屏 HOLD，02 的整块覆盖就只清掉它自己上一轮的节点；
        // 调用后把 02 的新节点收进**当前会话**的卡体、骨架按原顺序挂回 ——
        // 只换当前卡的内容，别的卡片不动、滚动位置不丢。
        // 任何意外（没激活 / 骨架没了 / 没有当前会话 / 抛错）回退旧的全量重建。
        if (!active) return rd.apply(this, arguments);
        if (m !== 'sessions') {
          var rAux = rd.apply(this, arguments);
          try { applyRightAux(m); } catch (e) { /* 忽略 */ }
          return rAux;
        }
        var cards = DETAIL.querySelector('#cc-cards');
        var sel = null;
        try {
          // R122：优先按「本次渲染的会话」定位卡片。历史上所有调用方传的
          // 都是当前选中会话（loadSessionDetail 有 currentSessionId 守卫、
          // 合批渲染传的也是它），结果不变；按参数定位后才能为「非选中卡」
          // 补内容 —— P1-3 的卡体重填自愈靠这个（见 applyRightInner 末尾）。
          sel = (arguments[0] && arguments[0].id) || state.currentSessionId || null;
        } catch (e) { sel = null; }
        var selCard = (cards && sel) ? cards.querySelector('.bp-card[data-sid="' + sel + '"]') : null;
        if (!cards || !selCard) {
          // R119（入口①）：回退 = 全量重建。但先别急着让 02 渲染 —— 它的
          // `detail.innerHTML = 整串` 会把 DETAIL 连骨架一起清掉、scrollTop
          // 归零。锚点必须在它动手**之前**抓（R118 就是抓晚了才没挡住：
          // 抓到的是已经归零的 0）。这条路径正是「新会话到达 + 自动跟随」
          // 的主路径：新会话的卡还不存在 → selCard 为 null → 走这里。
          captureScrollAnchor();
          var rFull = rd.apply(this, arguments);
          try { applyRight(true); } catch (e) { /* 忽略 */ }
          return rFull;
        }
        // ① 记滚动快照 —— 必须在把骨架摘进 HOLD **之前**读！
        //    R120（2026-10-14 用户复现「展开卡片后直接弹到最上面」）：旧代码先
        //    `HOLD.appendChild(#cc-cards)` 再读 scrollTop —— 整个滚动内容被摘走，
        //    DETAIL 的 scrollHeight 塌掉、scrollTop 被浏览器钳成 0，快照记下的
        //    是 0；重建后 snaps 把 scrollTop"恢复"成 0 → 每次选中卡重渲染
        //    （点开折叠卡 / SSE patch / 自动跟随）都弹回顶部。运行中的会话被
        //    「贴底跟随」分支掩盖着没发现，读历史卡必现。快照先行，摘骨架随后。
        var snaps = [DETAIL, selCard.querySelector('.bs-cb')].filter(Boolean).map(function (el) {
          return { el: el, top: el.scrollTop, bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 48 };
        });
        // ② 摘骨架进 HOLD（保持顺序，回头原样挂回）
        var chrome = Array.prototype.slice.call(DETAIL.childNodes).filter(function (n) {
          return n.nodeType === 1 && n.hasAttribute('data-cc');
        });
        chrome.forEach(function (n) { HOLD.appendChild(n); });
        // ③ 02 渲染（DETAIL 此刻是空的 → 它的 innerHTML 覆盖只清自己的旧节点）
        var r = null, err = null;
        try { r = rd.apply(this, arguments); } catch (e) { err = e; }
        // ④ 无论成败，先把骨架还回 DETAIL；02 真的渲染了才换卡体内容
        //    （fresh 为空 = 02 指纹未变提前返回 / 或渲染中途抛错 → 保持原样）
        try {
          var fresh = Array.prototype.slice.call(DETAIL.childNodes);
          chrome.forEach(function (n) { DETAIL.appendChild(n); });
          // R116：选中卡的卡体与展开态**与 02 是否重渲染无关**。
          // 旧代码（R114）把"建卡体 / 去 collapsed"整段放在 if (fresh.length) 里 ——
          // 而 02 的 renderSessionDetail 有指纹去重（lastDetailFp）：运行中的会话
          // SSE patch 可能刚渲染过一模一样的内容（id/status/rounds/消息数全同），
          // 点击触发的这次渲染被去重跳过（fresh 为空）→ 展开逻辑整段跳过 →
          // 用户点折叠卡"毫无反应"（2026-10-14 16:41 复现：会话卡点了展开不开）。
          // 展开是**选择语义**，不是渲染结果，必须无条件保证。
          var body = selCard.querySelector('.bs-cb');
          var madeBody = !body;
          if (madeBody) {
            body = document.createElement('div');
            body.className = 'bs-cb';
            selCard.appendChild(body);
            // 别的卡收回卡体并折叠（语义同 applyRightInner：只有选中卡有卡体）。
            // ⚠️ R121：用户手动展开过的卡除外——内容留下、展开态保留。
            cards.querySelectorAll('.bp-card[data-sid]').forEach(function (c) {
              if (c !== selCard && !ccUserExpanded[c.dataset.sid]) {
                var b = c.querySelector('.bs-cb'); if (b) b.remove(); c.classList.add('collapsed');
              }
            });
          }
          // wantExpand：用户主动选中过这个会话 → 必须展开；
          // madeBody：该卡第一次拿到内容 → 也展开（与旧全量重建语义一致）。
          // 其余情况（SSE/轮询刷新且用户手动收过）→ 尊重用户，不动折叠态。
          var wantExpand = ccPendingExpand === sel;
          if (wantExpand) ccPendingExpand = null;
          if (wantExpand || madeBody) selCard.classList.remove('collapsed');
          if (fresh.length) {
            while (body.firstChild) body.removeChild(body.firstChild);   // 旧内容作废（02 已整块重渲染）
            fresh.forEach(function (n) { body.appendChild(n); });
            skinTools(body);      // 工具卡单行化（幂等）
          }
          // R122-P2-8：autoFoldTick 移出 fresh 门 —— 02 指纹未变提前返回
          // （fresh 为空）时也要做运行态迁移检测，否则「跑完自动展开/收起」
          // 要等下一次事件才补上。
          autoFoldTick();         // 运行态自动展开/收起（只在状态迁移时动作）
          // 滚动恢复：贴底跟随 / 原样保留（02 在空 DETAIL 上算出的 scrollTop 不可信）
          var run = false;
          try { var s0 = S().filter(function (x) { return x.id === sel; })[0]; run = !!(s0 && isLive(s0)); } catch (e) { run = false; }
          snaps.forEach(function (sn) { sn.el.scrollTop = (run && sn.bottom) ? sn.el.scrollHeight : sn.top; });
        } catch (e2) {
          try { applyRight(true); } catch (e3) { /* 忽略 */ }
        }
        if (err) throw err;
        return r;
      };
    }
    var sc = window.selectSession;
    if (typeof sc === 'function') {
      window.selectSession = function () {
        // R122-B：暂停窗口内的「系统选择」直接跳过 —— 用户正在读某会话，
        // 不让新会话把选择抢走（视图/左栏高亮/选区内容都不动）。放行两种情况：
        // ① 用户自己点出来的（ccFromUserClick 刚被点击处理置上）；
        // ② 选回当前已选中的会话（无切换，无干扰）。
        // 被跳过时新会话卡照常由 refreshCards 增量补进列表（R122-P0-2）。
        var fromUser = ccFromUserClick === arguments[0];
        ccFromUserClick = null;
        if (!fromUser && arguments[0] && arguments[0] !== state.currentSessionId &&
            Date.now() - ccUserPickAt < CC_PAUSE_MS) {
          return null;
        }
        // R119（入口②）：selectSession 有两条会把 DETAIL 清空的路 —— 02 的
        // 延迟占位（详情 >200ms 才落「加载中…」）与失败时的直写。锚点在
        // sc.apply 之前抓（force=true：用户的新动作，永远重新抓），晚到的
        // 重建才补得回用户的位置。
        captureScrollAnchor(true);
        // R116：记录"用户主动选中"这个动作。
        // 02 的 renderSessionDetail 有 lastDetailFp 指纹去重，若内容与 SSE 抢先渲染的
        // 一致会整体跳过（本层 newNodes 为空）——但"展开了哪个卡"必须由点击意图决定，
        // 不能因为详情内容没变就顺手跳过，否则点了没反应。展开态与渲染解耦。
        ccPendingExpand = arguments[0];
        var r = sc.apply(this, arguments);
        if (active) {
          // 02 会把 #session-detail 直接写成「加载中…」（把本层的骨架一起冲掉），
          // 这里立刻把骨架补回去，别让右栏闪一下空白
          setTimeout(function () {
            if (!active || tabNow() !== 'sessions') return;
            try { if (!DETAIL.querySelector('#cc-cards')) applyRight(true); } catch (e) { /* 忽略 */ }
          }, 0);
          // R117：慢接口 / 失败两条路也要兜底。详情 >200ms 时 02 的延迟占位
          // （selectSession 里的 hintTimer）会把 #cc-cards 整块冲掉；失败时 02
          // 直接写「加载失败」——两种情况骨架都没了。等 promise 落地后再查一次，
          // 缺骨架就 applyRight(true) 重建，右栏不会停在裸文本状态。
          if (r && typeof r.then === 'function') {
            var restoreSkeleton = function () {
              if (!active || tabNow() !== 'sessions') return;
              try { if (!DETAIL.querySelector('#cc-cards')) applyRight(true); } catch (e) { /* 忽略 */ }
            };
            r.then(restoreSkeleton, restoreSkeleton);
          }
        }
        return r;
      };
    }
    // 「存档 / 记忆」页的数据是异步来的：到齐之后再自动选中当前聊天对象，
    // 否则刚切过去时 state.chats / state.memoryFiles 还是空的，右栏会停在
    // 「← 选择左侧会话查看消息存档」——看着又像"点了没反应"。
    wrapAsync('loadChats', function () { if (tabNow() === 'chats') autoPick(); });
    wrapAsync('loadMemoryView', function () { if (tabNow() === 'memory') autoPick(); });
  })();

  // 工具卡「查看原文」按钮：委托在 #session-detail 上 —— 它是长期容器，
  // 02 每次 `innerHTML = …` 重写的是它的**子节点**，容器本身和这个监听器都活着。
  // 点击不会误触卡头折叠：卡片折叠委托查的是 [data-cc-fold]，.ts-more 命不中。
  DETAIL.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('.ts-more');
    if (!b) return;
    var card = b.closest('.tool-card-flow');
    var raw = card && card.querySelector('.ts-raw');
    if (!raw) return;
    var show = raw.hidden;
    raw.hidden = !show;
    b.setAttribute('aria-expanded', show ? 'true' : 'false');
    card.classList.toggle('ts-open', show);
  });

  sync();
})();

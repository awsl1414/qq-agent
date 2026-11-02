/*
  表情库查看器（plugins/sticker/panel/viewer.js）

  ── 这个页面是怎么拿到数据的 ───────────────────────────────────────────────
  它跑在设置弹窗的 iframe 里，只有两条只读通道（契约见 src/skills/panel.js）：
    · ../panel/viewer.html 同目录资源  → 本页自己（插件目录）
    · ../@data/storage.json            → plugin-data/sticker/storage.json
  表情库真身在 <DATA_DIR>/stickers.json，页面读不到，也不需要读 ——
  插件侧（plugins/sticker/index.js 的 writeViewSnapshot）会把一份**只读快照**
  写进 api.storage 的 `view` 键，本页 fetch 出来渲染即可。所以：

  ⚠️ 唯一会写数据的动作是「详情弹层里点保存」（备注/标签/场景）：面板自己
     仍然写不了任何东西 —— 它只是 postMessage 请宿主转发一次 sticker__note
     工具调用，宿主侧有来源校验 + 工具白名单（src/routes.js 的 /api/plugin-tool）。
     其余任何时候这里都是纯只读。

  ── 两条宿主 CSP 约束（踩过坑的点）────────────────────────────────────────
    · script-src 'self'  → 内联 <script> 不执行，onclick= 这类内联事件处理器
      同样被拦。所以全部用 addEventListener。
    · img-src 放行 http:/https: → 表情可以直接热链 p.qpic.cn（QQ 表情 CDN，
      不带 rkey、不会过期），不需要把图片 base64 内联进来。
*/

(function () {
  'use strict';

  // ── 主题：本脚本在 <head> 里同步执行，先于 <body> 出现就定好 data-theme，
  //    所以首屏不会闪默认色，也就不需要再多一个 boot 脚本。
  //    取值逻辑与 /theme-boot.js 完全一致（面板与 /ui 同源，localStorage 共用）。
  try {
    var saved = localStorage.getItem('qqa-theme') || '';
    var sys = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    var theme = (saved === 'light' || saved === 'dark' || saved === '?') ? saved : (saved === 'system' ? sys : (saved || sys));
    if (theme !== 'light' && theme !== 'dark' && theme !== '?') theme = 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }

  /**
   * 快照入口。
   *
   * ⚠️ 用**相对路径**，不要写成 `/plugin-panel/sticker/@data/storage.json`。
   * 本页的 URL 是 `/plugin-panel/<id>/panel/viewer.html`，`../@data/…` 会解析成
   * `/plugin-panel/<id>/@data/…` —— 于是页面**不必知道自己的插件 id**，
   * 整份 panel/ 目录可以原样复制给别的插件用（改个 plugin.json 就行）。
   * 硬编码 id 的话，复制过去就静默白屏了。
   * 这套 URL 形态是宿主的契约，见 src/skills/panel.js。
   */
  var SNAPSHOT_URL = '../@data/storage.json';

  // ⚠️ 「全部」是**排除已删除**的 —— 插件的删除是软删除，快照里仍然带着被删的
  //    条目（打 `hidden:true`），默认不显示才符合"我删掉了"的直觉。
  //    要看删过什么，点「已删除」那个 chip（有东西时才会出现）。
  var FILTERS = [
    { key: 'all', label: '全部', test: function (it) { return !it.hidden; } },
    { key: 'annotated', label: '有备注', test: function (it) { return !it.hidden && Boolean(it.note || it.desc); } },
    { key: 'used', label: '用过', test: function (it) { return !it.hidden && (Number(it.useCount) || 0) > 0; } },
    { key: 'plain', label: '未标注', test: function (it) { return !it.hidden && !(it.note || it.desc); } },
    { key: 'local', label: '本地转存', test: function (it) { return !it.hidden && Boolean(it.local); } },
    { key: 'hidden', label: '已删除', test: function (it) { return Boolean(it.hidden); } }
  ];

  var state = {
    snap: null,       // 整个快照对象（含 total / annotated / used / syncedAt / error）
    items: [],        // snap.items 的拷贝
    q: '',
    filter: 'all',
    sort: 'id',
    failed: null      // 读取失败时的说明
  };

  // ── 小工具 ────────────────────────────────────────────────────────────────

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function fmtMs(ms) {
    var n = Number(ms) || 0;
    if (!n) return '—';
    try { return new Date(n).toLocaleString('zh-CN', { hour12: false }); } catch (e) { return '—'; }
  }

  function fmtIso(s) {
    var v = String(s || '').trim();
    if (!v) return '—';
    var d = new Date(v);
    return isNaN(d.getTime()) ? v : d.toLocaleString('zh-CN', { hour12: false });
  }

  function nameOf(it) {
    return String(it.note || it.desc || '').trim();
  }

  function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* 落到下面的兜底 */ }
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) { return false; }
  }

  // ── 过滤 / 排序 ───────────────────────────────────────────────────────────

  function filterOf(key) {
    for (var i = 0; i < FILTERS.length; i += 1) if (FILTERS[i].key === key) return FILTERS[i];
    return FILTERS[0];
  }

  function visible() {
    var q = state.q.trim().toLowerCase();
    var test = filterOf(state.filter).test;
    var list = state.items.filter(function (it) {
      if (!test(it)) return false;
      if (!q) return true;
      var hay = [
        it.id, it.desc, it.note, it.usage, it.source,
        (Array.isArray(it.tags) ? it.tags.join(' ') : '')
      ].join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });

    list.sort(function (a, b) {
      if (state.sort === 'updated') {
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
          || String(a.id).localeCompare(String(b.id));
      }
      if (state.sort === 'used') {
        return (Number(b.useCount) || 0) - (Number(a.useCount) || 0)
          || (Number(b.lastUsedAt) || 0) - (Number(a.lastUsedAt) || 0)
          || String(a.id).localeCompare(String(b.id));
      }
      if (state.sort === 'annotated') {
        var na = nameOf(a) ? 0 : 1;
        var nb = nameOf(b) ? 0 : 1;
        return na - nb || String(a.id).localeCompare(String(b.id));
      }
      return String(a.id).localeCompare(String(b.id));
    });
    return list;
  }

  // ── 渲染：页头 ────────────────────────────────────────────────────────────

  function renderStats() {
    var box = $('stats');
    box.textContent = '';
    if (!state.snap) return;
    var s = state.snap;

    var n1 = el('span'); n1.appendChild(document.createTextNode('共 ')); n1.appendChild(el('b', null, Number(s.total) || 0)); n1.appendChild(document.createTextNode(' 张'));
    var n2 = el('span'); n2.appendChild(document.createTextNode('有备注 ')); n2.appendChild(el('b', null, Number(s.annotated) || 0));
    var n3 = el('span'); n3.appendChild(document.createTextNode('用过 ')); n3.appendChild(el('b', null, Number(s.used) || 0));
    var n4 = el('span'); n4.appendChild(document.createTextNode('未标注 ')); n4.appendChild(el('b', null, Math.max(0, (Number(s.total) || 0) - (Number(s.annotated) || 0))));
    box.appendChild(n1); box.appendChild(n2); box.appendChild(n3); box.appendChild(n4);

    // 删掉的表情仍留在库里（软删除），这里给个入口，免得用户以为它们没了
    if (Number(s.hidden) > 0) {
      var nh = el('span', 'badge badge--hidden', '已删除 ' + Number(s.hidden));
      nh.title = '点右边的「已删除」筛选可以看到它们；想恢复就在聊天里说「恢复表情 <id>」';
      box.appendChild(nh);
    }

    if (s.settings && s.settings.enabled === false) {
      var off = el('span', 'badge badge--local', '表情包已在设置里关闭');
      box.appendChild(off);
    }
    if (s.error) {
      var e = el('span', 'badge badge--local', '最近一次收藏同步失败');
      e.title = String(s.error);
      box.appendChild(e);
    }
  }

  function renderChips() {
    var box = $('filters');
    box.textContent = '';
    var counts = {};
    FILTERS.forEach(function (f) {
      counts[f.key] = state.items.filter(f.test).length;
    });
    FILTERS.forEach(function (f) {
      // 「已删除」一个数都没有就别占位，免得每次都提醒用户"你删过 0 个"
      if (f.key === 'hidden' && counts[f.key] === 0) return;
      var b = el('button', 'chip' + (state.filter === f.key ? ' on' : ''), f.label + ' ' + counts[f.key]);
      b.type = 'button';
      b.addEventListener('click', function () {
        state.filter = f.key;
        renderChips();
        renderGrid();
      });
      box.appendChild(b);
    });
  }

  // ── 渲染：网格 ────────────────────────────────────────────────────────────

  function placeholderFor(it) {
    if (it.local) return '本地转存\n（发送前的临时形态，\n下次收藏同步会换成图床地址）';
    return '没有图片地址';
  }

  function buildCard(it) {
    var card = el('button', 'card');
    card.type = 'button';
    card.title = it.id;

    var imgBox = el('div', 'card__img');
    var url = String(it.img || '').trim();
    if (url) {
      var img = el('img');
      img.alt = nameOf(it) || it.id;
      img.loading = 'lazy';
      img.decoding = 'async';
      // 图床偶尔抽风/被墙：加载失败就退成占位，别留一个破图图标。
      img.addEventListener('error', function () {
        imgBox.textContent = '';
        imgBox.appendChild(el('div', 'card__ph', '图片加载失败'));
      });
      img.src = url;
      imgBox.appendChild(img);
    } else {
      imgBox.appendChild(el('div', 'card__ph', placeholderFor(it)));
    }

    var badges = el('div', 'card__badges');
    if ((Number(it.useCount) || 0) > 0) badges.appendChild(el('span', 'badge badge--used', '×' + it.useCount));
    if (it.local) badges.appendChild(el('span', 'badge badge--local', '本地'));
    if (it.hidden) badges.appendChild(el('span', 'badge badge--hidden', '已删除'));
    if (badges.childNodes.length) imgBox.appendChild(badges);

    if (it.hidden) card.className += ' card--hidden';
    card.appendChild(imgBox);

    var body = el('div', 'card__body');
    var name = nameOf(it);
    body.appendChild(el('div', 'card__name' + (name ? '' : ' card__name--dim'), name || '（无备注）'));
    var tags = Array.isArray(it.tags) ? it.tags.slice(0, 3) : [];
    if (tags.length) {
      var tagBox = el('div', 'card__tags');
      tags.forEach(function (t) { tagBox.appendChild(el('span', 'tag', t)); });
      body.appendChild(tagBox);
    }
    card.appendChild(body);

    card.addEventListener('click', function () { openDetail(it); });
    return card;
  }

  function renderGrid() {
    var main = $('main');
    main.textContent = '';

    if (state.failed) {
      main.appendChild(msgBox('读不到表情库快照', [
        state.failed,
        '快照由插件在「收藏同步 / 备注 / 收藏新表情」后写入，位置是：',
        'plugin-data/sticker/storage.json 的 view 键。',
        '如果插件刚装上还没同步过，等下一次自动同步（最长 60 秒）再点「重新载入」。'
      ]));
      return;
    }
    if (!state.items.length) {
      main.appendChild(msgBox('表情库是空的', [
        '插件还没同步到任何 QQ 收藏表情。可能的原因：',
        '· 这个 QQ 号没有收藏过表情；',
        '· 插件没开（设置里的「启用表情包」）；',
        '· fetch_custom_face_detail 调用失败（看控制台日志）。'
      ]));
      return;
    }

    var list = visible();
    if (!list.length) {
      // ⚠️ 区分两种情况（R130 修）：库里还有东西但**全被删了**，和"搜索没命中"。
      //    以前都落到"没有匹配的表情 / 换个关键词"，用户把表情全删掉时会看到
      //    一句完全对不上的提示。
      var aliveCount = state.items.filter(function (it) { return !it.hidden; }).length;
      if (aliveCount === 0) {
        main.appendChild(msgBox('表情都被删掉了', [
          '库里还有 ' + state.items.length + ' 张，但都被你删了。',
          '点「已删除」筛选可以看到它们，挑一张记下 id，',
          '然后在聊天里说一句「恢复表情 <id>」。'
        ]));
        return;
      }
      main.appendChild(msgBox('没有匹配的表情', ['换个关键词，或把筛选切回「全部」。']));
      return;
    }

    var grid = el('div', 'grid');
    var frag = document.createDocumentFragment();
    list.forEach(function (it) { frag.appendChild(buildCard(it)); });
    grid.appendChild(frag);
    main.appendChild(grid);
  }

  function msgBox(title, lines) {
    var box = el('div', 'msg');
    box.appendChild(el('h2', null, title));
    lines.forEach(function (t) {
      var p = el('p', null, t);
      p.style.margin = '6px 0';
      box.appendChild(p);
    });
    return box;
  }

  // ── 渲染：页脚 ────────────────────────────────────────────────────────────

  function renderFoot() {
    var f = $('foot');
    f.textContent = '';
    if (!state.snap) return;
    var s = state.snap;
    f.appendChild(el('span', null, '快照 v' + (s.v || 1) + ' · 生成于 ' + fmtIso(s.at)));
    f.appendChild(el('span', null, '收藏同步于 ' + fmtMs(s.syncedAt)));
    f.appendChild(el('span', null, '只读页面：改备注/标签请在聊天里让机器人用「备注表情」'));
  }

  // ── 详情浮层 ──────────────────────────────────────────────────────────────

  function openDetail(it) {
    var ov = $('ov');
    var imgBox = $('ov-img').parentNode;
    var img = $('ov-img');

    imgBox.textContent = '';
    imgBox.appendChild(img);
    var url = String(it.img || '').trim();
    if (url) {
      img.style.display = '';
      img.alt = nameOf(it) || it.id;
      img.addEventListener('error', function onErr() {
        img.removeEventListener('error', onErr);
        img.style.display = 'none';
        imgBox.appendChild(el('div', 'card__ph', '图片加载失败'));
      });
      img.src = url;
    } else {
      img.style.display = 'none';
      img.removeAttribute('src');
      imgBox.appendChild(el('div', 'card__ph', placeholderFor(it)));
    }

    var meta = $('ov-meta');
    meta.textContent = '';
    var dl = el('dl');

    function row(label, value, cls) {
      dl.appendChild(el('dt', null, label));
      var dd = el('dd', cls || null, value === '' || value === undefined || value === null ? '—' : String(value));
      dl.appendChild(dd);
      return dd;
    }

    var idDd = row('id', it.id, 'id mono');
    idDd.title = '点击复制';
    idDd.addEventListener('click', function () {
      if (copyText(String(it.id))) {
        var old = idDd.textContent;
        idDd.textContent = old + '（已复制）';
        setTimeout(function () { idDd.textContent = old; }, 1200);
      }
    });

    row('备注', nameOf(it));
    row('标签', (Array.isArray(it.tags) && it.tags.length) ? it.tags.join('、') : '');
    row('适用场景', it.usage || '');
    row('用过', (Number(it.useCount) || 0) + ' 次' + (Number(it.lastUsedAt) ? '（最近 ' + fmtMs(it.lastUsedAt) + '）' : ''));
    row('来源', it.source === 'ai' ? 'ai（收藏别人发的）' : String(it.source || 'qq'));
    row('图片', it.local ? '本地转存 file:///（页面读不到，等下次同步换成图床地址）' : (it.img || '无'));
    row('更新时间', fmtIso(it.updatedAt));

    meta.appendChild(dl);

    // 编辑区填充 + 绑定保存（用属性赋值而不是 onclick="" 内联，CSP 只拦后者）
    $('ov-note').value = String(it.note || '');
    $('ov-tags').value = Array.isArray(it.tags) ? it.tags.join(', ') : '';
    $('ov-usage').value = String(it.usage || '');
    $('ov-save-hint').textContent = '';
    $('ov-save').disabled = false;
    $('ov-save').onclick = function () { saveEdit(it); };

    ov.hidden = false;
    $('ov-x').focus();
  }

  function closeDetail() {
    $('ov').hidden = true;
  }

  // ── 编辑备注/标签（2026-10-18）─────────────────────────────────────────
  // 面板是只读静态页，自己写不了数据。用户点「保存」→ 请宿主转发一次
  // sticker__note 工具（宿主有来源校验 + 工具白名单，见 /api/plugin-tool）。
  // 这是**用户明确点击**才发生的写操作，与"页面能随便改数据"是两回事。
  var pendingCmd = null;   // { reqId, resolve }
  var cmdSeq = 0;

  function sendCmd(tool, args) {
    return new Promise(function (resolve) {
      var reqId = 'c' + (++cmdSeq) + '_' + Date.now();
      pendingCmd = { reqId: reqId, resolve: resolve };
      try {
        window.parent.postMessage({
          type: 'qa-plugin-cmd', tool: tool, args: args, reqId: reqId
        }, window.location.origin);
      } catch (e) {
        pendingCmd = null;
        resolve({ ok: false, error: '与宿主通信失败' });
        return;
      }
      setTimeout(function () {
        if (pendingCmd && pendingCmd.reqId === reqId) {
          pendingCmd = null;
          resolve({ ok: false, error: '宿主没有响应（超时）' });
        }
      }, 8000);
    });
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin) return;          // 只认同源
    var d = e.data || {};
    if (d.type !== 'qa-plugin-cmd-result') return;
    if (!pendingCmd || d.reqId !== pendingCmd.reqId) return;
    var p = pendingCmd;
    pendingCmd = null;
    p.resolve({ ok: !!d.ok, error: d.error || '' });
  });

  function saveEdit(it) {
    var btn = $('ov-save');
    var hint = $('ov-save-hint');
    var note = String($('ov-note').value || '').trim();
    var tags = String($('ov-tags').value || '')
      .split(/[,，\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var usage = String($('ov-usage').value || '').trim();
    btn.disabled = true;
    hint.textContent = '保存中…';
    sendCmd('sticker__note', { stickerId: it.id, note: note, tags: tags, usage: usage })
      .then(function (r) {
        btn.disabled = false;
        if (!r.ok) {
          hint.textContent = '保存失败：' + (r.error || '未知错误');
          return;
        }
        // 插件在 note() 之后会重写快照；这里先把本地对象改掉让当前卡片立刻正确，
        // 再重新拉一次快照（快照更新有极小延迟，load 失败也不影响本地显示）。
        it.note = note;
        it.tags = tags;
        it.usage = usage;
        hint.textContent = '已保存 ✓';
        setTimeout(function () { load(); }, 500);
      })
      .catch(function (e) {
        // sendCmd 本身永不 reject，这里兜"then 内部抛错"（比如 DOM 已被清掉）
        btn.disabled = false;
        hint.textContent = '保存失败：' + ((e && e.message) || e);
      });
  }

  // ── 载入 ──────────────────────────────────────────────────────────────────

  function load() {
    var btn = $('reload');
    btn.disabled = true;
    state.failed = null;

    fetch(SNAPSHOT_URL, { cache: 'no-store' })
      // 链尾已有 .catch（状态/渲染都在 catch 之后统一收尾）；
      // 自检规则会因 then 回调内的 } 误判"链已结束"——显式豁免，2026-10-18。
      // scan-ignore-next-line: unhandled-promise
      .then(function (res) {
        if (res.status === 404) {
          throw new Error('插件还没写过快照（storage.json 不存在）。');
        }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (all) {
        var snap = all && typeof all === 'object' ? all.view : null;
        if (!snap || typeof snap !== 'object') {
          throw new Error('storage.json 里没有 view 键（插件可能还没跑过一次同步）。');
        }
        state.snap = snap;
        state.items = Array.isArray(snap.items) ? snap.items : [];
      })
      .catch(function (error) {
        state.snap = null;
        state.items = [];
        state.failed = String((error && error.message) || error);
      })
      // 链尾已有 .catch（状态/渲染都在 catch 之后统一收尾）；
      // 自检规则会因 then 回调内的 } 误判"链已结束"——显式豁免，2026-10-18。
      // scan-ignore-next-line: unhandled-promise
      .then(function () {
        btn.disabled = false;
        renderStats();
        renderChips();
        renderGrid();
        renderFoot();
      });
  }

  // ── 启动 ──────────────────────────────────────────────────────────────────

  function boot() {
    $('reload').addEventListener('click', load);

    $('q').addEventListener('input', function (e) {
      state.q = String(e.target.value || '');
      renderGrid();
    });

    $('sort').addEventListener('change', function (e) {
      state.sort = String(e.target.value || 'id');
      renderGrid();
    });

    $('ov-x').addEventListener('click', closeDetail);
    $('ov-mask').addEventListener('click', closeDetail);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('ov').hidden) {
        e.preventDefault();
        e.stopPropagation();
        closeDetail();
      }
    });

    // 焦点回到搜索框，打开面板就能直接打字
    load();
    try { $('q').focus(); } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();

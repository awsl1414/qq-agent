// error-boot.js — 前端全局错误兜底（报告3 H1，2026-10-17）
// ---------------------------------------------------------------------------
// 为什么要它：ui/ 下 19 个 defer 脚本按序执行、彼此共享全局（state / esc / api …）。
// 任何一个文件在**顶层**抛异常，它后面的语句就全不执行了，而后续文件往往要调用
// 前面定义的函数 —— 于是一次脚本错误最终表现为"界面某块永远空着 / 点什么都没反应"，
// 而且**屏幕上没有任何线索**（错误只进了 DevTools，用户不会去开）。
//
// 这里做两件事：
//   1. 装全局监听（window.error / unhandledrejection），把失败**记录下来**：
//      window.__qaBootErrors 是一个数组，可在控制台直接看全量。
//   2. 渲染一个自包含的浮动提示条（右下角）：首行一句人话（出了点问题、重启通常
//      能恢复），原始错误（英文堆栈 / 文件:行号）折进「详情」里 —— 小白看到英文
//      堆栈只会更慌，排查的人又确实需要它。带错误计数与"复制"按钮。15 秒后自动
//      收起，不长期占屏。
//
// ⚠️ 位置与写法约束（改这个文件前先读）：
//   · 它必须是 ui/index.html 里**最先执行的脚本**（排在 theme-boot.js 之前），
//     否则它自己都还没装监听，前面的错误就漏了。
//   · 因此它**不许依赖任何其它文件**（不能用 $ / esc / state / qaAlert）。
//   · 全篇 try/catch 兜着：兜底代码自己抛异常是最蠢的失败模式。
//   · 关闭按钮文案与样式全部内联：CSP 是 script-src 'self' + style-src 'unsafe-inline'，
//     外链脚本合法、内联 style 属性合法，内联 <script> 不合法（所以本文件必须是外链）。
(function () {
  'use strict';
  if (window.__qaErrorBoot) return;   // 多标签/重复插入时幂等
  window.__qaErrorBoot = true;

  var MAX_RECORDS = 30;               // 只留最近 30 条，避免异常风暴把内存吃光
  var HIDE_AFTER_MS = 15000;          // 提示条自动收起时间
  var records = [];
  window.__qaBootErrors = records;

  function textOf(v) {
    try {
      if (v == null) return '';
      if (typeof v === 'string') return v;
      if (v instanceof Error) return String(v.stack || v.message || v);
      if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
      return String(v);
    } catch (e) { return '(无法序列化的错误值)'; }
  }

  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function record(kind, message, extra) {
    try {
      var rec = { kind: kind, message: clip(message, 500), at: Date.now(), extra: extra || '' };
      records.push(rec);
      if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
      // console 也留一份：DevTools 里能直接看到，且不会被 15 秒自动收起带走
      try { console.error('[界面错误]', kind, rec.message, extra || ''); } catch (e) { /* ignore */ }
      show(rec);
    } catch (e) { /* 记录本身失败也只能算了 */ }
  }

  // ── 浮动提示条（自包含，不依赖任何其它文件/样式表）─────────────────────
  // 2026-10-23：首行只说人话，原始错误折进「详情」。结构：
  //   el > [ body > [ msg（人话） / detailBtn（详情 ⇄ 收起详情） / detailWrap > [ rawText（原文） / rawHint ] ] , acts（复制 × ） ]
  var HUMAN_LINE = '软件界面出了点问题，部分功能可能暂时不可用；重启软件通常能恢复。';
  var bar = null;
  var hideTimer = null;

  function ensureBar() {
    if (bar) return bar;
    var el = document.createElement('div');
    el.id = 'qa-error-boot-bar';
    el.setAttribute('role', 'alert');
    el.style.cssText = [
      'position:fixed', 'right:14px', 'bottom:14px', 'z-index:2147483647',
      'max-width:min(460px,calc(100vw - 28px))', 'box-sizing:border-box',
      'padding:10px 12px 10px 14px', 'border-radius:10px',
      'background:rgba(28,28,32,.94)', 'color:#f3f4f6',
      'border-left:4px solid #ef4444',
      'box-shadow:0 8px 28px rgba(0,0,0,.42)',
      'font:12px/1.6 system-ui,"Microsoft YaHei",sans-serif',
      'display:none', 'gap:8px', 'align-items:flex-start'
    ].join(';');
    var body = document.createElement('div');
    body.style.cssText = 'flex:1;min-width:0;word-break:break-word;';
    var msg = document.createElement('div');
    msg.style.cssText = 'white-space:pre-wrap;';
    var detailBtn = document.createElement('button');
    detailBtn.type = 'button';
    detailBtn.textContent = '详情';
    detailBtn.style.cssText = 'background:none;border:none;color:#8f96a3;cursor:pointer;font:inherit;padding:0;margin-top:5px;line-height:1;text-decoration:underline;font-size:11px;';
    var detailWrap = document.createElement('div');
    detailWrap.style.cssText = 'display:none;';
    var rawText = document.createElement('div');
    rawText.style.cssText = 'margin-top:4px;padding:6px 8px;border-radius:6px;background:rgba(255,255,255,.06);font-size:11px;line-height:1.5;color:#a9adb8;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto;';
    var rawHint = document.createElement('div');
    rawHint.style.cssText = 'margin-top:4px;font-size:10.5px;color:#8f96a3;';
    rawHint.textContent = '可复制后发给别人排查';
    detailBtn.addEventListener('click', function () {
      var willShow = detailWrap.style.display === 'none';
      detailWrap.style.display = willShow ? 'block' : 'none';
      detailBtn.textContent = willShow ? '收起详情' : '详情';
    });
    detailWrap.appendChild(rawText);
    detailWrap.appendChild(rawHint);
    body.appendChild(msg);
    body.appendChild(detailBtn);
    body.appendChild(detailWrap);
    var acts = document.createElement('div');
    acts.style.cssText = 'display:flex;gap:10px;flex-shrink:0;align-items:center';
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制';
    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    for (var i = 0, btns = [copy, close]; i < btns.length; i++) {
      btns[i].style.cssText = 'background:none;border:none;color:#c9ccd4;cursor:pointer;font:inherit;padding:0;line-height:1';
    }
    copy.style.textDecoration = 'underline';
    close.style.fontSize = '16px';
    copy.addEventListener('click', function () { copyAll(copy); });
    close.addEventListener('click', hide);
    acts.appendChild(copy);
    acts.appendChild(close);
    el.appendChild(body);
    el.appendChild(acts);
    (document.body || document.documentElement).appendChild(el);
    bar = { el: el, body: body, msg: msg, detailBtn: detailBtn, detailWrap: detailWrap, rawText: rawText };
    return bar;
  }

  function summary() {
    var last = records[records.length - 1] || { kind: '', message: '' };
    var head = records.length > 1
      ? '界面出现脚本错误（' + records.length + ' 条，最新一条）'
      : '界面出现脚本错误';
    return head + '：\n' + last.message;
  }

  function show() {
    try {
      var b = ensureBar();
      // 首行人话常显；原始错误（含条数的摘要头 + 最新一条 message）进「详情」，
      // 每次新错误都收回详情 —— 首屏永远只有一句大白话。
      b.msg.textContent = HUMAN_LINE;
      b.rawText.textContent = summary();
      b.detailWrap.style.display = 'none';
      b.detailBtn.textContent = '详情';
      b.el.style.display = 'flex';
      if (hideTimer) clearTimeout(hideTimer);
      // 自动收起：只收起显示，记录仍留在 __qaBootErrors 里
      hideTimer = setTimeout(hide, HIDE_AFTER_MS);
    } catch (e) { /* 提示条渲染失败不影响页面本身 */ }
  }

  function hide() {
    try {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (bar) bar.el.style.display = 'none';
    } catch (e) { /* ignore */ }
  }

  /** 把全部记录复制到剪贴板（失败则打印到控制台并全选提示）。 */
  function copyAll(btn) {
    var txt;
    try {
      txt = records.map(function (r) {
        return '[' + new Date(r.at).toLocaleString('zh-CN') + '] ' + r.kind + ' ' + r.message
          + (r.extra ? '\n    ' + r.extra : '');
      }).join('\n');
    } catch (e) { txt = '(拼装失败)'; }
    var done = function (ok) {
      try {
        var old = btn.textContent;
        btn.textContent = ok ? '已复制' : '见控制台';
        setTimeout(function () { btn.textContent = old; }, 1500);
      } catch (e) { /* ignore */ }
      if (!ok) { try { console.error('[界面错误·全部记录]\n' + txt); } catch (e) { /* ignore */ } }
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { done(true); }, function () { done(false); });
        return;
      }
    } catch (e) { /* 落到控制台分支 */ }
    done(false);
  }

  /** 供用户在控制台手动唤回提示条：__qaShowBootErrors() */
  window.__qaShowBootErrors = function () {
    if (!records.length) { try { console.log('[界面错误] 没有记录到任何错误'); } catch (e) { /* ignore */ } return; }
    show();
  };

  // ── 装监听 ────────────────────────────────────────────────────────────
  // capture=true 才能收到**资源加载失败**（<img>/<script> 的 error 事件不冒泡到 window）
  window.addEventListener('error', function (ev) {
    try {
      var t = ev && ev.target;
      if (t && t !== window && t.tagName && (t.src || t.href)) {
        record('资源加载失败', '<' + String(t.tagName).toLowerCase() + '> ' + (t.src || t.href), '');
        return;
      }
      var msg = (ev && (ev.message || (ev.error && ev.error.message))) || '未知脚本错误';
      var where = ev && ev.filename
        ? ' @ ' + ev.filename + (ev.lineno ? ':' + ev.lineno + (ev.colno ? ':' + ev.colno : '') : '')
        : '';
      // 跨域脱敏噪音（2026-10-17）：外域脚本（如验证码 SDK）没带 crossorigin 时，
      // 浏览器只报 "Script error."——无消息、无位置、无堆栈，零诊断价值。
      // 同源脚本（本应用全部业务代码）永远拿得到完整信息，不受此过滤影响。
      // 这种噪音只留控制台痕迹，不弹提示条打扰用户。
      if (!where && /^script error\.?$/i.test(String(msg))
        && !(ev && ev.error && ev.error.stack)) {
        try { console.debug('[界面错误·跨域脱敏报错已静音]', msg); } catch (e) { /* ignore */ }
        return;
      }
      record('运行时异常', msg + where, ev && ev.error && ev.error.stack ? String(ev.error.stack) : '');
    } catch (e) { /* ignore */ }
  }, true);

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev && ev.reason;
      // 同上：外域 Promise 的脱敏拒绝也只有一句 "Script error."，静音
      if (/^script error\.?$/i.test(textOf(r)) && !(r && r.stack)) {
        try { console.debug('[界面错误·跨域脱敏拒绝已静音]', textOf(r)); } catch (e) { /* ignore */ }
        return;
      }
      record('未处理的 Promise', textOf(r), r && r.stack ? String(r.stack) : '');
    } catch (e) { /* ignore */ }
  });
})();

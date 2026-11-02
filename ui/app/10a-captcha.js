// 〔人机验证桥接〕—— 2026-10-17 新增
//
// 背景：kondius.cn 给所有社区上传端点（金句 /holyshits、意见 /comment、
// 插件/技能 /market/publish）加了**阿里云验证码 2.0**（V3 弹出式滑块）。
// 服务端校验请求体里的 captchaVerifyParam，缺失/无效一律 403「请先完成人机验证」。
// 官网网页版在提交前弹滑块拿到 param 再上传；桌面端此前没接这套流程，
// 导致金句/意见/插件/技能上传全挂（用户集中反馈的就是这个）。
//
// 做法：与官网 holyshits 页完全同款 —— 同一 SceneId、同一 SDK（官网反代托管）、
// 同一「aliyun 域名请求改写到 kondius.cn 反代」的钩子。差异只有两点：
//   ① 改写目标用**绝对地址**（桌面端 origin 是 127.0.0.1，相对路径会打到本地服务）；
//   ② 挂载点 DOM 由本模块自己注入（官网是写死在 HTML 里的）。
//
// 用法（上传侧统一走 Promise 封装）：
//   hint.textContent = '请完成人机验证…';
//   const captchaVerifyParam = await window.__qqaCaptcha.verify();  // 弹滑块
//   …body: JSON.stringify({ ..., captchaVerifyParam })
// 用户取消/验证失败时 verify() 抛 Error（message 已是人话），调用方按普通上传失败处理。
(function () {
  'use strict';
  if (window.__qqaCaptcha) return;

  window.AliyunCaptchaConfig = { region: 'cn', prefix: '163stu' };

  // ── aliyun 域名请求改写：SDK 对 *.aliyuncs.com / *.alicdn.com 的请求
  //    一律改走 kondius.cn 的 nginx 反代（/qq-agent/captcha-api/<域名>/<路径>），
  //    与官网行为等价。只改写这两个域，业务请求（/api/*、kondius.cn）不受影响。
  //    豁免：o.alicdn.com/captcha-frontend/（官方 CDN 上的验证码前端脚本）不改写 ——
  //    script 标签无 CORS 问题，直连 CDN 比 kettle 反代少一跳； kondius 线路抖动时
  //    它还能当 SDK 主档的备用源（见下方 SDK_SOURCES）。
  const PROXY_BASE = 'https://kondius.cn/qq-agent/captcha-api/';
  const RE_ALI = /^(https:\/\/([a-zA-Z0-9.-]+\.(?:aliyuncs|alicdn)\.com))(\/.*)?$/;
  const RE_ALI_DIRECT = /^https:\/\/o\.alicdn\.com\/captcha-frontend\//;
  function rw(u) {
    const s = String(u || '');
    if (RE_ALI_DIRECT.test(s)) return s;
    const m = RE_ALI.exec(s);
    return m ? PROXY_BASE + m[2] + (m[3] || '/') : s;
  }
  try {
    const of = window.fetch;
    window.fetch = function (input, init) {
      try { if (typeof input === 'string') input = rw(input); } catch { /* 改写失败退回原请求 */ }
      return of.apply(this, [input, init]);
    };
    const oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
      try { u = rw(u); } catch { /* ignore */ }
      return oo.apply(this, [m, u].concat([].slice.call(arguments, 2)));
    };
    // SDK 会动态插 <script>（子模块），同样改写到反代
    const sd = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, 'src');
    const oc = document.createElement.bind(document);
    document.createElement = function (tag, opts) {
      const el = oc(tag, opts);
      try {
        if (String(tag).toLowerCase() === 'script') {
          Object.defineProperty(el, 'src', {
            configurable: true,
            get() { return el.getAttribute('src') || ''; },
            set(v) { sd.set.call(el, rw(v)); }
          });
        }
      } catch { /* ignore */ }
      return el;
    };
  } catch { /* 钩子装不上就直连 aliyun —— CSP 放行了 kondius.cn，直连能否成功看运行环境 */ }

  // ── 挂载点：官网把 #captcha-element / #captcha-trigger 写死在 HTML 里，
  //    桌面端按需注入（initAliyunCaptcha 要求这两个元素在 init 时已存在）。
  function ensureDom() {
    if (!document.getElementById('captcha-element')) {
      const el = document.createElement('div');
      el.id = 'captcha-element';
      document.body.appendChild(el);
    }
    if (!document.getElementById('captcha-trigger')) {
      const btn = document.createElement('button');
      btn.id = 'captcha-trigger';
      btn.type = 'button';
      btn.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(btn);
    }
  }

  // ── SDK 生命周期：就绪信号是 getInstance 回调（脚本 onload 只代表下载完，
  //    init 内部还要异步初始化，提前 show() 会静默无操作 —— 官网注释原话）。
  //    SDK 来源（2026-10-17 加备用）：主档 kondius 反代托管，备用阿里云官方 CDN
  //    o.alicdn.com（与主档**同一份文件**，224977 字节逐字节一致）。桌面端强制
  //    直连（setProxy direct，防系统代理劫持 127.0.0.1），CDN 线路瞬时抖动会让
  //    主档拉不下来 —— 群友实测就挂在这。逐源尝试 + 缓存穿透重试。
  const SDK_SOURCES = [
    'https://kondius.cn/qq-agent/captcha-sdk/AliyunCaptcha.js',
    'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
  ];
  let instance = null, ready = false, loading = false, onPass = null, everInited = false;
  const pending = [];
  function dispatch(p) {
    const cb = onPass; onPass = null;
    if (cb) cb(p);
  }
  // ── 销毁实例（2026-10-17 二次上传卡死修复）──
  // captchaVerifyParam 是**一次性**的：实例成功一次后内部状态停在"验证通过"，
  // 再 show() 只会重放残影、永远不再触发 success —— 用户看到"验证通过！"
  // 却传不出去。官网网页版靠上传成功后 location.reload() 整页刷新绕过；
  // 桌面端不能刷页面，所以每次成功（或初始化失败）后彻底销毁，下次全新 init。
  function teardown() {
    if (instance) {
      // 不同 SDK 版本的清理方法名不一，逐一尝试，没有就算了
      ['destroy', 'reset', 'refresh'].forEach((m) => {
        try { if (typeof instance[m] === 'function') instance[m](); } catch { /* ignore */ }
      });
    }
    instance = null; ready = false;
    try {
      const el = document.getElementById('captcha-element');
      if (el) el.innerHTML = '';
      // 弹窗/遮罩层可能由 SDK 挂在 body 上（子模块动态渲染），按类名兜底清掉
      document.querySelectorAll('body > [class*="aliyunCaptcha"], body > [class*="aliyun-captcha"]')
        .forEach((n) => n.remove());
    } catch { /* ignore */ }
  }
  function failAll(msg) {
    loading = false;
    teardown();
    // 二次 init 若被 SDK 的单例守卫拒绝（INIT_FAIL 之类）→ 硬复位：
    // 删全局函数 + 移除脚本标签，下次 start() 走 tryLoad 重新拉 SDK，保证有恢复路径。
    if (everInited) {
      everInited = false;
      try {
        delete window.initAliyunCaptcha;
        document.querySelectorAll('script[src*="AliyunCaptcha"]').forEach((n) => n.remove());
      } catch { /* ignore */ }
    }
    const q = pending.splice(0);
    q.forEach((cb) => cb(new Error(msg)));
  }
  function loadScript(src, ok, bad) {
    const s = document.createElement('script');
    s.onload = ok;
    s.onerror = () => bad();
    s.src = src;
    document.head.appendChild(s);
  }
  function tryLoad(sources, attempt, bust) {
    if (!sources.length) {
      failAll('验证码组件加载失败（kondius 与阿里云 CDN 均不可达，请检查网络/代理/防火墙'
        + (navigator.onLine === false ? '；当前系统显示离线' : '') + '）');
      return;
    }
    const [head, ...rest] = sources;
    const url = bust ? head + (head.includes('?') ? '&' : '?') + 'r=' + Date.now() : head;
    loadScript(url, () => {
      if (ready) return;
      initSdk();
    }, () => {
      if (attempt < 2) {
        // 同源缓存穿透重试一次，再失败换下一个源
        setTimeout(() => tryLoad([head, ...rest], attempt + 1, true), 1200);
      } else {
        tryLoad(rest, 0, false);
      }
    });
  }
  function initSdk() {
    if (ready || instance) return;   // 防重复 init（重试路径可能并发触发 onload）
    try {
      window.initAliyunCaptcha({
        SceneId: '632wvduj',
        mode: 'popup',
        element: '#captcha-element',
        button: '#captcha-trigger',
        zIndex: 2147483000,
        // 成功即销毁（见 teardown 注释）：param 已交付上传流程，本实例使命结束。
        // 顺序不能反——先 dispatch 把 param 交出去，再拆 DOM，调用方拿到的 param 不受影响。
        success: (captchaVerifyParam) => { dispatch(captchaVerifyParam); teardown(); },
        fail: () => { /* 用户滑块失败：SDK 自己会重置滑块，不动队列 */ },
        getInstance: (i) => {
          instance = i; ready = true; loading = false; everInited = true;
          const q = pending.splice(0);
          q.forEach((cb) => { onPass = cb; instance.show(); });
        },
        onError: (info) => failAll('人机验证初始化失败（' + ((info && (info.msg || info.code)) || '未知错误') + '），请稍后重试'),
        slideStyle: { width: 320, height: 40 },
        language: 'cn'
      });
    } catch (e) {
      failAll('人机验证组件异常，请稍后重试');
    }
  }
  function start() {
    loading = true;
    ensureDom();
    // SDK 脚本已加载过（initAliyunCaptcha 还在）就直接 init，不再重复插 <script>
    if (typeof window.initAliyunCaptcha === 'function') { initSdk(); return; }
    tryLoad(SDK_SOURCES, 0, false);
  }

  window.__qqaCaptcha = {
    /** 回调式：show(cb)。cb 收到 captchaVerifyParam（字符串）或 Error。 */
    show(cb) {
      // 上一轮回调还挂着（用户没滑完就关了上传弹窗）→ 判作取消，作废它。
      // 否则新请求会顶掉 onPass，旧上传流程永远停在"请完成人机验证…"。
      if (onPass) {
        const stale = onPass; onPass = null;
        try { stale(new Error('已取消，请重新完成人机验证')); } catch { /* ignore */ }
      }
      if (ready && instance && instance.show) { onPass = cb; instance.show(); return; }
      pending.push(cb);
      if (!loading) start();
    },
    /** Promise 封装：通过则 resolve(captchaVerifyParam)，取消/失败则 reject(Error)。 */
    verify() {
      return new Promise((resolve, reject) => {
        this.show((p) => (p instanceof Error ? reject(p) : resolve(p)));
      });
    }
  };
})();

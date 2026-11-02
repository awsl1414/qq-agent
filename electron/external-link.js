// 外链白名单校验（2026-10-10，P0-2）。
//
// 为什么单独一个模块：这是"点一个链接就把用户交给系统浏览器"的最后一道关口，
// 也是安全 review 最该能一眼跑起来验证的一段。所以**刻意不 import electron /
// 不碰 shell** —— 纯函数，给定输入返回判定结果，可被 node 直接跑（见
// test/external-link-test.mjs）。
//
// 威胁模型：
//   ① 页面里会渲染**模型输出 / 远端 JSON** 里的 <a href>（金句墙、意见墙、
//      更新提示的下载链接）。这些内容不完全受我们控制；
//   ② Electron 的 setWindowOpenHandler / will-navigate 若不拦，会把这些
//      目标直接交给系统 shell —— 意味着从用户的桌面环境里一键打开任意程序/协议；
//   ③ 旧实现只判 `/^https?:\/\//` 前缀，挡不住 `https://evil.com@kondius.cn`
//      这种 userinfo 混淆，也没有主机约束（任意站点都能开）。
//
// 策略：**协议白名单 + userinfo 拒绝 + 主机白名单**，三者全过才放行。
//   白名单是"默认拒绝"而不是"黑名单" —— 新增一个可信域名需要显式加进来，
//   而不是"忘了拦"就默认放行。
'use strict';

/** 允许外开的主机（精确匹配或它的子域）。以项目实际会外链的域名为准。 */
export const DEFAULT_ALLOW_HOSTS = Object.freeze([
  'kondius.cn',            // 官网 / 版本信息 / 价格源 / 意见墙 / 金句墙
  'github.com',            // 用户协议 / 隐私政策 / 项目主页
  'deepseek.com',          // 供应商后台（设置页"获取 Key"引导）
  'platform.openai.com',
  'openrouter.ai',
  'api-docs.deepseek.com',
]);

/** 本机地址不视为"外链"：它们要么由控制台自己处理，要么就不该丢给系统浏览器。 */
const INTERNAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

/** 规范化主机名：小写 + 去末尾点（FQDN 形态 `github.com.` 与 `github.com` 等价）。 */
const normHost = (h) => String(h || '').toLowerCase().replace(/\.$/, '');

/** 主机是否命中白名单。`api.kondius.cn` 命中 `kondius.cn`；`evil-kondius.cn` 不命中。 */
export function hostAllowed(host, allowHosts) {
  const h = normHost(host);
  if (!h) return false;
  const list = (Array.isArray(allowHosts) && allowHosts.length ? allowHosts : DEFAULT_ALLOW_HOSTS);
  // ⚠️ 必须用 `h === base || h.endsWith('.' + base)`，**不能**用 includes：
  //    'evil-kondius.cn'.includes('kondius.cn') === true —— 一个字符的差别就是钓鱼洞。
  return list.some((raw) => {
    const base = normHost(raw);
    if (!base) return false;
    return h === base || h.endsWith('.' + base);
  });
}

/**
 * 判断一个 URL 是否允许交给系统浏览器。
 * @param {string} raw          待校验 URL
 * @param {string[]} [allowHosts] 额外/替代的主机白名单（不传则用 DEFAULT_ALLOW_HOSTS）
 * @returns {{ok:true,url:string}|{ok:false,reason:string}}
 */
export function checkExternalUrl(raw, allowHosts) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: '空 URL' };

  let u;
  try { u = new URL(s); } catch { return { ok: false, reason: '不是合法 URL' }; }

  // ① 协议白名单：只放 http / https。
  //    javascript: / data: / file: / ms-*: / 自定义协议一律拒绝 ——
  //    这些协议交给 shell 打开，可能直接落地执行或读写本地文件。
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `协议不允许（${u.protocol}）` };
  }

  // ② 拒绝带 userinfo 的 URL（`https://user:pass@host/`）。
  //    正常外链不该有；而 `https://trusted.com@evil.com/` 这类是经典钓鱼形态，
  //    只看"字符串里出现过 trusted.com"的实现会被骗。
  if (u.username || u.password) {
    return { ok: false, reason: 'URL 含 userinfo（疑似钓鱼）' };
  }

  const host = normHost(u.hostname);
  if (!host) return { ok: false, reason: '缺少主机名' };

  // ③ 本机地址不外开
  if (INTERNAL_HOSTS.has(host)) return { ok: false, reason: '本机地址不外开' };

  // ④ 主机白名单
  if (!hostAllowed(host, allowHosts)) {
    return { ok: false, reason: `主机不在白名单（${host}）` };
  }

  return { ok: true, url: u.href };
}

export default { checkExternalUrl, hostAllowed, DEFAULT_ALLOW_HOSTS };

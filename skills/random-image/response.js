// 取图接口响应解析：纯函数，不碰网络、不读配置，便于单测。
//
// 只支持经过实测确认存在的结构，不为「以后可能变」预留分支：
//   1. { pic: [url] }                     —— api.cnmiw.com/api.php?type=json（MirlKoi，
//                                             本技能移植自的 MaiBot 插件 v4.1.0 的原始契约）
//   2. { data: [{ urls: { regular } }] }  —— api.lolicon.app/setu/v2（默认源，实测）
//                                             size=regular 时只有 regular 键；未传 size 时是 original
//   3. { data: [{ url }] }                —— api.lolicon.app/setu（v1，实测）
//   4. { pics: [url] }                    —— api.anosu.top/api、moe.jitsu.top/api（实测）
//
// 明确不实现、也确认无真实来源的结构（任务书旧笔记里列的，实测找不到出处）：
//   { data: [url] }、{ images: [url] } —— 找不到任何真实接口返回它们，
//   不为凑数保留分支。真遇到新接口时，下面的 warn 会打印顶层键名，据此再加。

/** 只保留非空字符串。 */
function pickUrlStrings(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((u) => typeof u === 'string' && u.trim() !== '');
}

/** 取 urls 里第一个非空的字符串，按 regular → original → large → medium 顺序。 */
function firstUrlOf(urls) {
  // 默认请求带 size=regular，lolicon v2 只会返回对应的那一个键；其余键是为
  // 用户自填了不带 size 的同类接口时兜底（那时返回 original）。按序取第一个
  // 非空字符串，而不是用 ?? 链：空串不是 nullish，会让后面的有效值取不到。
  for (const key of ['regular', 'original', 'large', 'medium']) {
    const v = urls[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

/** 从 data 数组的每一项里取 URL：兼容 {urls:{...}} 与 {url}。 */
function pickFromDataItems(items) {
  const out = [];
  for (const item of items) {
    if (typeof item === 'string') continue;   // {data:[url]} 不是已确认的真实结构
    if (!item || typeof item !== 'object') continue;
    const urls = item.urls;
    if (urls && typeof urls === 'object') {
      const candidate = firstUrlOf(urls);
      if (candidate) out.push(candidate);
      continue;
    }
    if (typeof item.url === 'string' && item.url.trim() !== '') out.push(item.url);
  }
  return out;
}

/**
 * 从接口响应体（已 JSON.parse 的对象）里取出图片 URL 列表。
 * 识别不到时返回 [] 并打一条 warn（带顶层键名），便于接口再变时定位。
 * @param {unknown} data
 * @returns {string[]}
 */
export function extractImageUrls(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.warn(`[setu] 取图接口响应不是对象（${Array.isArray(data) ? '数组' : typeof data}）`);
    return [];
  }
  // 命中已知字段就按该字段的语义返回，哪怕结果为空：lolicon 对未知 tag 会返回
  // {"data":[]}，这是合法的「没搜到」，不是结构不认识，不该打 warn 误导排查。
  if (Array.isArray(data.pic)) return pickUrlStrings(data.pic);        // cnmiw
  if (Array.isArray(data.pics)) return pickUrlStrings(data.pics);      // anosu / jitsu
  if (Array.isArray(data.data)) return pickFromDataItems(data.data);   // lolicon v1 / v2
  const keys = Object.keys(data).join(', ') || '(无)';
  console.warn(`[setu] 取图接口响应里没有可识别的图片字段，顶层键：${keys}`);
  return [];
}

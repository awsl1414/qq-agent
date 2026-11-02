// 把 agent 的 Markdown 回复转成适合 QQ 发送的纯文本。（移植自 qq-bridge src/md-to-plain.js）

export function mdToPlain(md) {
  let s = String(md ?? '');
  // 代码块：保留内容，去掉围栏
  s = s.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, body) => body.replace(/\n+$/, ''));
  // 行内代码
  s = s.replace(/`([^`\n]+)`/g, '$1');
  // 图片/链接：保留文字，链接附在括号里（QQ 可点）
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (alt || url));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
  // 粗体/斜体/删除线标记
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/\*([^*]+)\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  // 标题符
  s = s.replace(/^#{1,6}\s+/gm, '');
  // 引用符
  s = s.replace(/^>\s?/gm, '');
  // 列表符
  s = s.replace(/^\s*[-*+]\s+/gm, '• ');
  // 表格：按行保留文本
  s = s.split('\n').filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line) || line.includes('|') === false || /\S/.test(line.replace(/[\s:|-]/g, ''))).join('\n');
  s = s.replace(/^\s*\|/gm, '').replace(/\|\s*$/gm, '');
  // 折叠的连续空行
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * 剥掉模型偶尔给整条回复套上的那层方括号（2026-10-20，实锤来自会话存档：
 * send_message 的参数就是 "[那不就是纯躺平了]"）。上下文里 [图片] [表情] [语音]
 * [引用 …] 这类系统媒体标记太多，小模型会照猫画虎把自己的整条回复也包进一层
 * 方括号 —— 用户看到的就是一句话戴了个玻璃罩子。
 *
 * 刻意收得极窄，只处理确证的失败形态，其它内容一律不碰：
 *   ① 去掉首尾空白后，整条消息恰好是**一个**方括号组；
 *   ② 内部 ≤60 字、不含换行、不含嵌套方括号（`[[x]]` 不匹配，不会剥成 `[x]`）；
 *   ③ 内部不是 CQ 码（[CQ:xxx] 是 OneBot 的功能语法，剥了就坏）；
 *   ④ 只剥一层，剥完不再递归。
 */
export function unwrapStrayBrackets(text) {
  const s = String(text ?? '');
  const m = s.match(/^\s*\[([^\[\]\n]{1,60})\]\s*$/);
  if (!m) return s;
  const inner = m[1].trim();
  if (!inner || /^CQ:/i.test(inner)) return s;
  return inner;
}

/** 按 QQ 单条消息长度上限切分（群消息一般 ≤ 4500 字，留余量）。 */
export function splitForQQ(text, max = 4000) {
  const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 4000;
  const parts = [];
  let rest = text;
  while (rest.length > safeMax) {
    let cut = rest.lastIndexOf('\n', safeMax);
    let eat = 0;
    if (cut <= 0) {
      cut = safeMax;
    } else {
      eat = 1; // 换行符保留给前一段，避免拼接后丢换行
    }
    // 若切点正好落在代理对中间（emoji 等会被切成乱码），把切点前移一个码元
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    if (cut <= 0) {
      const first = rest.charCodeAt(0);
      const second = rest.charCodeAt(1);
      cut = (first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff) ? 2 : 1;
      eat = 0;
    }
    parts.push(rest.slice(0, cut + eat));
    rest = rest.slice(cut + eat);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}

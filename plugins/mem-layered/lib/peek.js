// 跨群旁听：处理 A 会话时，顺带知道别的会话最近在聊什么。
// 目标很像人的「余光」——话题词 + 谁在说 + 尾句，不是把别人的原文搬过来。
//
// ── ⚠️ 为什么本插件默认**关闭**（内置版默认开着）────────────────────────
// 内置版的 crossChatAwareness 默认 true：B 群最近聊的内容会被写进 A 群的提示词。
// 在"一个机器人被拉进好几个互不相识的群"这种常见配置下，这是**隐私问题**，
// 不该是默认行为。所以这里默认 false —— 想要"余光"的人自己打开，
// 还能用 crossChatPeekAllow 限定只旁听哪几个会话。
//
// ── 另一处改动：缓存 ────────────────────────────────────────────────────
// 内置版在 2026-10-14 修过 M7（按 mtime+size 缓存，避免每条消息整文件读+parse），
// 这里从一开始就带上，并且把缓存上限做成了可配置的常量。
import fs from 'node:fs';
import path from 'node:path';
import { safeName, normText } from './util.js';

/** 缓存多少个会话文件的解析结果；满了淘汰最久未访问的一半。 */
const CACHE_MAX = 64;
/**
 * 每个会话缓存**尾部**多少条消息。
 *
 * ⚠️ C6 修复（2026-10-14）：原来缓存的是整个文件 parse 出来的完整数组。
 *    一个活跃群的会话文件几 MB，parse 后的对象树是它的数倍 —— 64 个会话全命中
 *    就是几百 MB 常驻。而 peek 只用"最近几分钟"的窗口（topics / 在聊的人 /
 *    尾句），尾部 400 条对任何合理窗口都绰绰有余（400 条 / 12 分钟 ≈ 33 条/分钟）。
 *    超活跃群的旁听计数会停在 400（标签里显示的就是这个数），无伤大雅。
 */
const TAIL_CACHE = 400;

const STOP = new Set([
  '这个', '那个', '就是', '还是', '但是', '因为', '所以', '什么', '怎么', '可以',
  '没有', '我们', '你们', '他们', '自己', '一下', '不是', '如果', '现在', '时候',
  '一个', '不会', '知道', '然后', '已经', '这样', '那样', '而且', '或者', '不过'
]);

/** 会话文件名的形状（与核心一致：group_123 / private_456）。 */
const CHAT_FILE_RE = /^(group|private)_(\d+)\.json$/;

export class Peek {
  /**
   * @param {{messagesDir: string, settings: () => object}} deps
   */
  constructor({ messagesDir, settings }) {
    this.messagesDir = path.resolve(messagesDir);
    this.settings = settings;
    /** @type {Map<string, {mtimeMs:number, size:number, msgs:object[], at:number}>} */
    this.cache = new Map();
  }

  /**
   * 读一个会话的消息（带 mtime+size 缓存，只缓存尾部 TAIL_CACHE 条）。
   * ⚠️ 返回值是**缓存里的数组引用**，调用方只读不写。
   */
  #load(chatKey) {
    const abs = path.join(this.messagesDir, `${safeName(chatKey)}.json`);
    try {
      const st = fs.statSync(abs);
      const hit = this.cache.get(abs);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        hit.at = Date.now();
        return hit.msgs;
      }
      let text = fs.readFileSync(abs, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const parsed = JSON.parse(text);
      const all = Array.isArray(parsed?.messages) ? parsed.messages : [];
      // 只留尾部：peek 的窗口是"最近几分钟"，完整数组常驻内存是纯浪费（见 TAIL_CACHE 注释）
      const msgs = all.length > TAIL_CACHE ? all.slice(-TAIL_CACHE) : all;
      if (this.cache.size >= CACHE_MAX) {
        const byAge = [...this.cache.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
        for (let i = 0; i < Math.ceil(byAge.length / 2); i += 1) this.cache.delete(byAge[i][0]);
      }
      this.cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, msgs, at: Date.now() });
      return msgs;
    } catch {
      this.cache.delete(abs);
      return [];
    }
  }

  /** 列出磁盘上的会话 key（不含当前会话）。 */
  #otherChats(currentChatKey, allow) {
    let files = [];
    try {
      files = fs.readdirSync(this.messagesDir).filter((f) => CHAT_FILE_RE.test(f));
    } catch {
      return [];
    }
    const out = [];
    for (const f of files) {
      const m = CHAT_FILE_RE.exec(f);
      if (!m) continue;
      const chatKey = `${m[1]}:${m[2]}`;
      if (chatKey === currentChatKey) continue;
      if (allow.size && !allow.has(chatKey)) continue;
      out.push({ chatKey, label: m[1] === 'group' ? `群${m[2]}` : `私聊${m[2]}` });
    }
    return out;
  }

  /**
   * 组装「旁听」那一段。
   * @param {string} currentChatKey
   * @returns {string} 可能是空串
   */
  build(currentChatKey) {
    const s = this.settings();
    if (s.crossChatPeek !== true) return '';   // 默认关
    const key = String(currentChatKey || '');
    if (!key) return '';

    const minutes = Math.max(1, Number(s.crossChatPeekMinutes) || 12);
    const maxChats = Math.max(1, Number(s.crossChatPeekChats) || 2);
    const maxChars = Math.max(60, Number(s.crossChatPeekChars) || 180);
    const allow = new Set(
      String(s.crossChatPeekAllow || '')
        .split(/[,，\s]+/)
        .map((x) => x.trim())
        .filter(Boolean)
    );

    const cutoff = Date.now() - minutes * 60000;
    const rows = [];
    for (const { chatKey, label } of this.#otherChats(key, allow)) {
      const recent = this.#load(chatKey).filter((m) => Number(m?.ts || 0) >= cutoff);
      if (recent.length < 4) continue;

      const usable = recent.filter((m) => {
        const t = String(m?.text || '').trim();
        if (!t) return false;
        if (/^\[(图片|表情|贴图|语音|视频)\]$/.test(t)) return false;
        if (m?.self) return false;                    // 自己的发言不算"旁听"
        return t.length >= 4 && t.length < 200;
      });
      if (!usable.length) continue;

      const freq = new Map();
      for (const m of usable) {
        const text = normText(m.text);
        for (const w of text.match(/[\u4e00-\u9fff]{2,}|[a-z0-9_]{3,}/g) || []) {
          if (w.length < 2 || STOP.has(w)) continue;
          if (/^\d+$/.test(w) && w.length < 4) continue;
          freq.set(w, (freq.get(w) || 0) + 1);
        }
      }
      const topics = [...freq.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([w]) => w);

      const people = [...new Set(usable.slice(-30).map((m) => m.senderName || m.senderId))]
        .filter(Boolean).slice(0, 4);
      const tail = String(usable[usable.length - 1].text || '').replace(/\s+/g, ' ').slice(0, 36);

      rows.push({
        label,
        n: recent.length,
        topics,
        people,
        tail,
        priority: topics.length * 3 + Math.min(20, recent.length) / 5
      });
    }

    if (!rows.length) return '';
    rows.sort((a, b) => b.priority - a.priority);

    const parts = [];
    let used = 0;
    for (const r of rows.slice(0, maxChats)) {
      const bits = [];
      if (r.topics.length) bits.push(`话题:${r.topics.join('/')}`);
      if (r.people.length) bits.push(`在聊:${r.people.join(',')}`);
      if (r.tail) bits.push(`尾句:"${r.tail}"`);
      const line = `${r.label}${r.n}条 ${bits.join(' · ')}`;
      if (used + line.length > maxChars && parts.length) break;
      parts.push(line);
      used += line.length;
    }
    if (!parts.length) return '';
    return `【旁听·其它会话最近${minutes}分钟】\n${parts.join('\n')}\n（环境感知；别插话除非被点名）`;
  }

  stats() {
    return { cached: this.cache.size };
  }
}

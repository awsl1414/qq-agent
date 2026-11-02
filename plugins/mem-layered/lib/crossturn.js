// 跨轮工作记忆：上一轮说了什么、有没有没说完。
//
// ── 它解决的是什么 ───────────────────────────────────────────────────────
// 只解决一件事：**防复读**。连续两轮里机器人不该把同一句话再说一遍，
// 也不该在自己刚说过「我查一下」之后当没说过。
// 它不是"记住内容" —— 那是长时记忆（blocks/）的职责，两者别混。
//
// ── 相对内置 lib/cross-turn.js 的两处实质改动 ────────────────────────────
//   1. 内置版的 saveAfterRun 支持 outcome/lastQuery/unfinished/note，
//      但它的 index.js 只传了 sent 与 draft —— 也就是说「上一轮查过什么」
//      「有没有没说完」这两个字段**永远是空的**，渲染出来只剩一句"刚发过"。
//      本插件在 after-response 里把 recalled（上一轮注入过哪些旧事）也一起存下来，
//      下一轮就不会把同一件旧事再提一遍。
//   2. TTL 到期的文件会被 sweep() 真正删掉。内置版只靠 load() 判断过期，
//      文件永远留在磁盘上 —— 会话多起来就是一个只增不减的目录。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson, removeFile, safeName, num } from './util.js';

/** 单个会话最多留几条"刚发过"。 */
const MAX_SENT = 3;
/** sweep 单次最多检查多少个文件，别让清理自己变成慢操作。 */
const SWEEP_SCAN_MAX = 400;

export class CrossTurn {
  /**
   * @param {string} root     数据根（<DATA_DIR>/memory-v3）
   * @param {() => object} settings
   */
  constructor(root, settings) {
    this.root = path.resolve(root);
    this.dir = path.join(this.root, 'cross-turn');
    this.settings = settings;
    ensureDir(this.dir);
  }

  #file(chatKey) {
    return path.join(this.dir, `${safeName(chatKey)}.json`);
  }

  #ttlMs() {
    // num 而不是 clamp：设置项被清空时退回 90 分钟，而不是被夹成下限 5 分钟
    return num(this.settings().crossTurnTtlMin, 90, 5, 720) * 60000;
  }

  /**
   * 运行结束时写入。
   * @param {string} chatKey
   * @param {{sent?: any[], draft?: string, recalled?: string[], unfinished?: boolean, note?: string}} payload
   */
  save(chatKey, { sent = [], draft = '', recalled = [], unfinished = false, note = '' } = {}) {
    const key = String(chatKey || '');
    if (!key) return null;
    const s = this.settings();
    const maxChars = num(s.crossTurnMaxChars, 200, 80, 600);

    const sentLines = (Array.isArray(sent) ? sent : [])
      .map((x) => (typeof x === 'string' ? x : x?.text))
      .map((t) => String(t || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, MAX_SENT)
      .map((t) => t.slice(0, 60));

    const body = String(draft || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);

    // 上一轮注入过哪些旧事 —— 用来避免下一轮复读同一件
    const recalledLines = (Array.isArray(recalled) ? recalled : [])
      .map((t) => String(t || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((t) => t.slice(0, 50));

    // 完全没信息就删掉这份档案，别留空壳
    if (!sentLines.length && !body && !recalledLines.length && !unfinished) {
      removeFile(this.#file(key));
      return null;
    }

    const out = {
      at: Date.now(),
      sent: sentLines,
      draft: body,
      recalled: recalledLines,
      unfinished: !!unfinished,
      note: String(note || '').slice(0, 80)
    };
    writeJson(this.#file(key), out);
    return out;
  }

  /** 读一份仍在 TTL 内的档案；过期视为没有（但文件还在，等 sweep 清）。 */
  load(chatKey) {
    const key = String(chatKey || '');
    if (!key) return null;
    const raw = readJson(this.#file(key), null);
    if (!raw || typeof raw !== 'object') return null;
    if (Date.now() - (Number(raw.at) || 0) > this.#ttlMs()) return null;
    return raw;
  }

  /**
   * 渲染成极短一段。
   * @returns {string} 可能是空串
   */
  render(chatKey) {
    if (this.settings().crossTurn === false) return '';
    const w = this.load(chatKey);
    if (!w) return '';
    const bits = [];
    if (w.sent?.length) bits.push(`刚发过「${String(w.sent[0]).slice(0, 24)}」`);
    if (w.draft) bits.push(`上一轮想说的是「${String(w.draft).slice(0, 36)}」`);
    if (w.recalled?.length) bits.push(`上一轮提过「${String(w.recalled[0]).slice(0, 24)}」`);
    if (w.unfinished) bits.push('上一轮没说完');
    if (!bits.length) return '';
    return `【跨轮】${bits.join('；')}。（接着聊，别复读同一句）`;
  }

  clear(chatKey) {
    const key = String(chatKey || '');
    if (!key) return false;
    return removeFile(this.#file(key));
  }

  /**
   * 删掉过期档案。
   * ⚠️ 内置版没有这一步：TTL 只在 load() 里判断，文件永远不删 ——
   *    会话越多这个目录越涨，而且从外面看不出"哪些其实已经作废"。
   */
  sweep() {
    // 口径与 load() 完全一致：过了 TTL 就是"已经不算数了"，没有留着的理由。
    const cutoff = Date.now() - this.#ttlMs();
    let removed = 0;
    const files = this.#list();
    for (const f of files.slice(0, SWEEP_SCAN_MAX)) {
      const p = path.join(this.dir, f);
      const raw = readJson(p, null);
      const at = Number(raw?.at) || 0;
      if (!at || at < cutoff) {
        if (removeFile(p)) removed += 1;
      }
    }
    return removed;
  }

  stats() {
    const files = this.#list();
    const ttl = this.#ttlMs();
    const now = Date.now();
    let alive = 0;
    for (const f of files) {
      const raw = readJson(path.join(this.dir, f), null);
      if (raw && now - (Number(raw.at) || 0) <= ttl) alive += 1;
    }
    return { files: files.length, alive };
  }

  /** 目录下的 .json 文件名（排障用，失败返回空数组）。 */
  #list() {
    try {
      return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
  }
}

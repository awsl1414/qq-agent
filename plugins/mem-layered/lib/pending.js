// 待办：模型说「记着明天问一下」时写进来；到点自动消失，不靠模型每次维护。
//
// ── ⚠️ 为什么本文件必须自带一个工具入口 ─────────────────────────────────
// 内置 plugins/conversation-memory/lib/pending.js 有完整的 saveTodo / completeTodo，
// 但**全应用零调用** —— 没有任何技能注册「记待办」的工具，也没有任何地方 import 它们。
// 结果就是：设置页的「待办提醒」开关是开着的、注入代码也一直在跑，但
// <DATA_DIR>/pending-todos.json 从来不存在 —— 一个彻底空转的功能。
// 所以本插件把「状态机」和「入口」放在一起：index.js 会 registerTool('memory_todo')。
// 没有入口的记忆功能不该发布。
//
// ── 相对内置版的两处改动 ────────────────────────────────────────────────
//   1. 补上入口（上面那条）。
//   2. completeTodo 的匹配从"必须完全相等"放宽成"包含即算完成"——
//      模型复述待办时几乎不会一字不差（内置版那版基本删不掉东西）。
import path from 'node:path';
import { ensureDir, readJson, writeJson, num } from './util.js';

/** 单文件上限：超了就丢最旧的，别让它无限长。 */
const MAX_TODOS = 60;
/** 默认过期时间与上限（分钟）。 */
const DEFAULT_EXPIRE_MIN = 120;
const MAX_EXPIRE_MIN = 7 * 24 * 60;

export class Pending {
  /**
   * @param {string} root 数据根（<DATA_DIR>/memory-v3）
   * @param {() => object} settings
   */
  constructor(root, settings) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'todos.json');
    this.settings = settings;
    ensureDir(this.root);
  }

  #read() {
    const raw = readJson(this.file, null);
    return Array.isArray(raw?.todos) ? raw.todos : [];
  }

  /** 写盘时顺手清过期（这是唯一会真正删掉待办的地方）。 */
  #write(todos) {
    const now = Date.now();
    const alive = todos
      .filter((t) => !t.expiresAt || Number(t.expiresAt) > now)
      .slice(-MAX_TODOS);
    writeJson(this.file, { version: 1, todos: alive });
    return alive;
  }

  /**
   * 记一条待办。同会话同内容会去重并刷新过期时间。
   * @returns {{ok: boolean, todo?: object, deduped?: boolean, error?: string}}
   */
  add({ chatKey, text, expireInMinutes = DEFAULT_EXPIRE_MIN, userId = '', note = '' } = {}) {
    const body = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!body) return { ok: false, error: '待办内容不能为空' };
    const key = String(chatKey || '');
    if (!key) return { ok: false, error: '缺少 chatKey' };

    // num 而不是 clamp + ||：clamp(null,1,N) 会返回 1，再被 `|| 120` 当成
    // "用户要 1 分钟" —— 模型传个 null 就变成"记下来一分钟就忘"。
    const mins = num(expireInMinutes, DEFAULT_EXPIRE_MIN, 1, MAX_EXPIRE_MIN);
    const now = Date.now();
    // QQ 号可能是负数（私聊会话号），统一取绝对值
    const rawUid = String(userId || '').trim();
    const fixedUid = /^-?\d{5,15}$/.test(rawUid) ? String(Math.abs(Number(rawUid))) : '';

    const todos = this.#read();
    const existing = todos.find(
      (t) => String(t.chatKey) === key && String(t.text).toLowerCase() === body.toLowerCase()
    );
    if (existing) {
      existing.expiresAt = now + mins * 60000;
      existing.updatedAt = now;
      existing.note = String(note || '').slice(0, 80);
      if (fixedUid) existing.userId = fixedUid;
      this.#write(todos);
      return { ok: true, todo: existing, deduped: true };
    }

    const todo = {
      id: `t${now.toString(36)}`,
      chatKey: key,
      userId: fixedUid,
      text: body,
      note: String(note || '').slice(0, 80),
      createdAt: now,
      updatedAt: now,
      expiresAt: now + mins * 60000,
      expireInMinutes: mins
    };
    todos.push(todo);
    this.#write(todos);
    return { ok: true, todo };
  }

  /**
   * 办完了：删掉。
   * ⚠️ 匹配放宽到"包含"——模型复述待办很少一字不差，内置版的严格相等基本删不掉。
   *    优先精确匹配；没有精确的再退到子串匹配（取第一条）。
   */
  done({ chatKey, text } = {}) {
    const needle = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!needle) return { ok: false, error: '需要待办内容（可以只写几个关键词）' };
    const key = String(chatKey || '');
    const todos = this.#read();

    const inChat = (t) => !key || String(t.chatKey) === key;
    let idx = todos.findIndex((t) => inChat(t) && String(t.text).toLowerCase() === needle);
    if (idx < 0) {
      idx = todos.findIndex((t) => inChat(t) && String(t.text).toLowerCase().includes(needle));
    }
    if (idx < 0) {
      idx = todos.findIndex((t) => inChat(t) && needle.includes(String(t.text).toLowerCase()));
    }
    if (idx < 0) return { ok: false, error: '没找到这条待办（用 action=list 看一眼有哪些）' };

    const [removed] = todos.splice(idx, 1);
    this.#write(todos);
    return { ok: true, removed };
  }

  /** 未过期的待办（已按"绑人优先 + 快到期的在前"排序）。 */
  list({ chatKey = null, personIds = [], limit = 5 } = {}) {
    const now = Date.now();
    const people = new Set((personIds || []).map(String).filter(Boolean));
    return this.#read()
      .filter((t) => {
        if (t.expiresAt && Number(t.expiresAt) <= now) return false;
        if (chatKey && t.chatKey && String(t.chatKey) !== String(chatKey)) return false;
        // 绑了人的待办：只有该人出现在本轮才拿出来
        if (t.userId) {
          if (!people.size) return false;
          if (!people.has(String(t.userId))) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ap = a.userId && people.has(String(a.userId)) ? 0 : 1;
        const bp = b.userId && people.has(String(b.userId)) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return (Number(a.expiresAt) || 0) - (Number(b.expiresAt) || 0);
      })
      .slice(0, Math.max(1, Number(limit) || 5))
      .map((t) => ({
        text: t.text,
        userId: t.userId || '',
        leftMin: Math.max(0, Math.round(((Number(t.expiresAt) || 0) - now) / 60000)),
        note: t.note || ''
      }));
  }

  /**
   * 渲染成给提示词的一小段。
   * @param {{chatKey: string, personIds?: string[], max?: number}} opts
   */
  render({ chatKey, personIds = [], max = 3 } = {}) {
    if (this.settings().pendingTodos === false) return '';
    const list = this.list({ chatKey, personIds, limit: max });
    if (!list.length) return '';
    const lines = list.map((t) => {
      const who = t.userId ? `@${t.userId}` : '';
      const soon = t.leftMin <= 60 ? `（约${t.leftMin}分后忘）` : '';
      return `- ${who}${t.text}${soon}`;
    });
    return `【未完待办·会自动过期】\n${lines.join('\n')}\n（记得就去办；到点没办完也会忘，别一直挂着）`;
  }

  /** 清掉过期条目（渲染时本来就不显示，这里是把文件真正缩回去）。 */
  sweep() {
    const before = this.#read().length;
    const after = this.#write(this.#read()).length;
    return before - after;
  }

  stats() {
    const todos = this.#read();
    const now = Date.now();
    const alive = todos.filter((t) => !t.expiresAt || Number(t.expiresAt) > now).length;
    return { total: todos.length, alive, expired: todos.length - alive };
  }
}

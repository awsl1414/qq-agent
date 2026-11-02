// 成本护栏：本地累计 prompt token，接近上限时**分级**砍掉可选注入。
//
// ── 相对内置 lib/cost-guard.js 的实质改动 ────────────────────────────────
// 内置版有两个问题（其中第二个它自己的注释里已经承认了）：
//   1. shouldReduceOptionalInjects(cfg) 只判**日级**：会话级的 chatPromptMax
//      虽然会写进统计文件，但判断时根本没读 —— 也就是说设置页那个
//      「单会话 prompt 上限」调了等于没调。本插件把 chatKey 一路传下来，
//      日级与会话级**两个都判**。
//   2. 只有"砍 / 不砍"两档，且砍的是语义卡与跨群旁听，跨轮与待办照旧 ——
//      真到超限那天，护栏其实护不住多少。本插件分三档（见 LEVELS）。
//
// ── 为什么放在 memory-v3 而不是 DATA_DIR 根 ─────────────────────────────
// 本插件所有状态都收在自己的数据根里，卸载 = 删一个目录。
// 内置版把 cost-guard.json / pending-todos.json / semantic-cards/ 散在 DATA_DIR 根，
// 卸载后留一地文件。
import path from 'node:path';
import { ensureDir, readJson, writeJson, dayKeyOf } from './util.js';

/**
 * 三档的含义（level 越大砍得越狠）：
 *   0  正常      —— 全部注入
 *   1  接近上限  —— 关掉「语义卡 + 跨群旁听」；自动回忆预算减半
 *   2  已超上限  —— 再关掉「跨轮 + 自动回忆」，只留待办（短、且办不完会真的误事）
 */
const LEVELS = {
  0: { cards: true, peek: true, crossTurn: true, autoRecall: true, recallBudgetScale: 1 },
  1: { cards: false, peek: false, crossTurn: true, autoRecall: true, recallBudgetScale: 0.5 },
  2: { cards: false, peek: false, crossTurn: false, autoRecall: false, recallBudgetScale: 0 }
};

/** 触发 level 1 的阈值（占上限的比例）。 */
const NEAR_RATIO = 0.85;

/**
 * 单文件里最多跟踪多少个会话。
 * 护栏只需要知道"谁在烧钱"，不需要给每个会话留一行 ——
 * 不设上限的话，长期运行会攒出成千上万个只增不减的条目。
 */
const MAX_TRACKED_CHATS = 200;

/**
 * 落盘节流（毫秒）。
 * ⚠️ C7 修复（2026-10-14）：原来 after-response **每轮**都整文件写一遍
 *    （含最多 200 个会话条目）。内存里的 this.data 才是 shouldReduce 的
 *    实时真相源，磁盘文件只在崩溃恢复时用 —— 每轮全量写既没必要也拖慢主流程。
 *    20 秒节流的代价：崩溃时最多丢 20 秒的计数（护栏略微松弛），可接受。
 */
const WRITE_INTERVAL_MS = 20000;

export class Budget {
  /**
   * @param {string} root 数据根（<DATA_DIR>/memory-v3）
   * @param {() => object} settings
   */
  constructor(root, settings) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'budget.json');
    this.settings = settings;
    ensureDir(this.root);
    this.data = this.#read();
    this.lastWriteAt = 0;
  }

  #read() {
    const raw = readJson(this.file, null);
    const day = dayKeyOf(Date.now());
    if (!raw || raw.day !== day) return { version: 1, day, totalPrompt: 0, totalCached: 0, chats: {} };
    if (!raw.chats || typeof raw.chats !== 'object') raw.chats = {};
    return raw;
  }

  #write({ force = false } = {}) {
    // 会话表按用量裁剪：只留最烧的前 N 个（护栏是"防超支"，不是"记账本"）
    const chats = this.data.chats || {};
    const keys = Object.keys(chats);
    if (keys.length > MAX_TRACKED_CHATS) {
      const keep = keys
        .map((k) => ({ k, p: Number(chats[k]?.prompt) || 0 }))
        .sort((a, b) => b.p - a.p)
        .slice(0, MAX_TRACKED_CHATS);
      const next = {};
      for (const { k } of keep) next[k] = chats[k];
      this.data.chats = next;
    }
    // 节流：内存数据是实时真相源，磁盘只为崩溃恢复服务（见 WRITE_INTERVAL_MS）
    const now = Date.now();
    if (!force && now - (this.lastWriteAt || 0) < WRITE_INTERVAL_MS) return;
    writeJson(this.file, this.data);
    this.lastWriteAt = now;
  }

  /** 立即落盘（deactivate / 排障用）。 */
  flush() {
    this.#write({ force: true });
    return true;
  }

  #limits() {
    const s = this.settings();
    return {
      on: s.budgetGuard !== false,
      dayMax: Math.max(0, Number(s.dayPromptMax) || 0),   // 0 = 不限
      chatMax: Math.max(0, Number(s.chatPromptMax) || 0)
    };
  }

  /**
   * 记一次运行的本轮增量用量。
   * ⚠️ 必须传**本轮增量**：宿主 after-response 每轮都触发，而 ctx.session.usage
   *    是运行级累计值 —— 内置版踩过这个坑（真实 791K 被记成 1285K，×1.62）。
   *    所以这里只接受调用方算好的差值。
   */
  report(chatKey, { promptTokens = 0, cachedTokens = 0 } = {}) {
    const { on } = this.#limits();
    if (!on) return { ok: true, skipped: true };
    const p = Math.max(0, Number(promptTokens) || 0);
    const c = Math.max(0, Number(cachedTokens) || 0);
    const key = String(chatKey || '');
    this.data.totalPrompt = (Number(this.data.totalPrompt) || 0) + p;
    this.data.totalCached = (Number(this.data.totalCached) || 0) + c;
    if (key) {
      const cur = this.data.chats[key] || { prompt: 0, cached: 0, at: 0 };
      cur.prompt = (Number(cur.prompt) || 0) + p;
      cur.cached = (Number(cur.cached) || 0) + c;
      cur.at = Date.now();
      this.data.chats[key] = cur;
    }
    this.#write();
    return { ok: true, dayPrompt: this.data.totalPrompt };
  }

  /**
   * 组 prompt 之前问一次：这轮该砍到什么程度。
   * @param {string} [chatKey]
   * @returns {{level: number, reason: string, flags: object, recallBudgetScale: number}}
   */
  shouldReduce(chatKey = '') {
    const { on, dayMax, chatMax } = this.#limits();
    if (!on) return { level: 0, reason: 'off', ...pick(0) };

    // 跨天时先重置（钩子里不会调 report 的那一轮也可能来问）
    const day = dayKeyOf(Date.now());
    if (this.data.day !== day) {
      this.data = { version: 1, day, totalPrompt: 0, totalCached: 0, chats: {} };
    }

    const dayPrompt = Number(this.data.totalPrompt) || 0;
    const chatPrompt = Number(this.data.chats?.[String(chatKey)]?.prompt) || 0;

    if (dayMax > 0 && dayPrompt >= dayMax) return { level: 2, reason: `day≥${dayMax}`, ...pick(2) };
    if (chatMax > 0 && chatPrompt >= chatMax) return { level: 2, reason: `chat≥${chatMax}`, ...pick(2) };
    if (dayMax > 0 && dayPrompt >= dayMax * NEAR_RATIO) return { level: 1, reason: `day≥${Math.round(dayMax * NEAR_RATIO)}`, ...pick(1) };
    if (chatMax > 0 && chatPrompt >= chatMax * NEAR_RATIO) return { level: 1, reason: `chat≥${Math.round(chatMax * NEAR_RATIO)}`, ...pick(1) };
    return { level: 0, reason: '', ...pick(0) };
  }

  snapshot() {
    const { on, dayMax, chatMax } = this.#limits();
    const chats = this.data.chats || {};
    const top = Object.entries(chats)
      .map(([k, v]) => ({ chatKey: k, prompt: Number(v?.prompt) || 0 }))
      .sort((a, b) => b.prompt - a.prompt)
      .slice(0, 5);
    return {
      enabled: on,
      day: this.data.day,
      dayPrompt: Number(this.data.totalPrompt) || 0,
      dayMax,
      chatMax,
      cached: Number(this.data.totalCached) || 0,
      chats: Object.keys(chats).length,
      topChats: top,
      level: this.shouldReduce('').level
    };
  }
}

function pick(level) {
  const f = LEVELS[level] || LEVELS[0];
  return { flags: { ...f }, recallBudgetScale: f.recallBudgetScale };
}

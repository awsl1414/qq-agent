// 冲突自检：内置 plugins/conversation-memory 与本插件**提供同名能力**
// （memory.search / memory.archive / memory.status / memory.rebuild）。
//
// ── 为什么要自检 ─────────────────────────────────────────────────────────
// 两个提供者同时启用会同时踩三件事。这三条都是在宿主源码里查证过的，不是推测：
//   ① 钩子叠加 —— skills/manager.js 的 runHook 是 `for (const skill of registry.list())`
//      **遍历所有已激活 Skill 依次调用**，不是"谁先返回谁赢"。两边都会往最后一条
//      user 消息末尾追加记忆 → 内容重复、token 翻倍。
//   ② 能力先注册者赢 —— plugin-loader.js 的 api.capability 只取**第一个**生效的
//      提供者（源码注释原话："约定：同类能力只应有一个提供者"）。加载顺序是
//      skills/ → plugins/，各自按目录名排序 —— conversation-memory(c) 排在
//      mem-layered(m) 前面，所以默认情形下**内置版赢**。后果：宿主自带的
//      memory_search 工具查到的是内置版的数据根，本插件的数据在磁盘上却查不到
//      —— 不报错，只是"看起来新插件没生效"，最容易误判。
//   ③ 双定时器 —— 两边各自 setInterval 跑后台巩固，互不破坏，但 CPU/IO 双份。
//
// ── 怎么在不碰宿主的前提下判断出来 ───────────────────────────────────────
// 宿主没给插件"读别的 Skill 配置"或"列出能力提供者"的接口（createSkillApi 的
// 白名单里只有 isSkillActive / capability / hasCapability），所以这里用两件事拼：
//   · api.isSkillActive('conversation-memory') —— 内置版是否生效（纯内存查询，无 IO）
//   · 给自己的 memory.status 传一个探针参数，看**第一个**提供者回不回我的引擎标记
//     —— 回了说明我排在前面；没回说明内置版抢走了能力。
// 探针在**本插件自己的** provider 里短路返回（见 index.js 的 providers），不读盘、
// 不建实例；内置版不认识这个参数，会照常算它自己的状态（几个内存计数，代价极小）。
// 而且只有"内置版确实生效"时才会去探针 —— 没冲突就不花这一分钱。
//
// ⚠️ 本文件不改宿主任何一个字节：只用上面两个公开接口 + 宿主给插件自己的存储。
import { num } from './util.js';

/** 内置记忆插件的目录名 / 清单 id（两者一致）。 */
export const BUILTIN_ID = 'conversation-memory';
/** 内置版的显示名 —— 提示文案必须指名道姓，否则用户不知道该去关哪一个。 */
export const BUILTIN_NAME = '分层会话记忆';
/** 本插件的显示名（提示文案里用）。 */
const SELF_NAME = '分层记忆（增强版）';
/** 探针参数名：只在本插件内部使用，宿主与内置版都不会传这个键。 */
const PROBE_KEY = '__memLayeredProbe';
/** 本插件在 memory.status 返回里留的引擎标记（与 index.js 的 providers 一致）。 */
export const ENGINE_TAG = 'mem-layered';
/** 冲突状态复查间隔：用户可能中途把内置版关掉，不能一直拿启动时的结论说话。 */
const RECHECK_MS = 5 * 60 * 1000;
/** 提醒记账的存储键（走宿主给的 plugin-data 存储，不自己写文件）。 */
const STORAGE_KEY = 'conflictWarn';
/** 提醒冷却的上下限（分钟）：5 分钟 ~ 30 天，默认一天一次。 */
const COOLDOWN_MIN = 5;
const COOLDOWN_MAX = 43200;
const COOLDOWN_DEFAULT = 1440;

/**
 * 冲突看门狗。
 *
 * 三级结论：
 *   none      内置版没生效 —— 什么都没发生
 *   duplicate 内置版开着，但第一个能力提供者仍是我 —— 重复注入 + 双定时器
 *   shadowed  内置版开着**且抢走了能力**（默认情形）—— 上面全部，外加
 *             "模型主动检索查到的是内置版的旧数据"
 */
export class ConflictGuard {
  /**
   * @param {object} api      宿主给的 skill api（只用 isSkillActive / capability / storage / warn）
   * @param {Function} settings 取当前设置（返回合并后的对象）
   */
  constructor(api, settings) {
    this.api = api;
    this.settings = typeof settings === 'function' ? settings : () => ({});
    this.state = null;
    this.checkedAt = 0;
    this.lastAnnouncedAt = 0;
    // 上次提醒时间从宿主的插件存储里读回来 —— 进程重启不该把冷却重新数一遍，
    // 否则每次热重载都会再念叨一次。
    try {
      const saved = api?.storage?.get?.(STORAGE_KEY, null);
      const at = Number(saved?.at);
      if (Number.isFinite(at) && at > 0) this.lastAnnouncedAt = at;
    } catch { /* 存储读不到就从 0 开始：最坏是多提醒一次 */ }
  }

  /** 当前冲突状态。带 TTL 缓存；force=true 立刻复查（activate 时用）。 */
  check({ force = false, now = Date.now() } = {}) {
    if (!force && this.state && now - this.checkedAt < RECHECK_MS) return this.state;
    this.checkedAt = now;
    this.state = this.#detect();
    return this.state;
  }

  get level() {
    return this.state?.level || 'none';
  }

  #detect() {
    if (!this.#builtinActive()) {
      return { level: 'none', builtinActive: false, selfFirst: null, at: Date.now() };
    }
    const selfFirst = this.#probeSelfFirst();
    return {
      // selfFirst === false → 确定是内置版赢了，敢把"检索查到旧数据"说出口；
      // selfFirst === null  → 探针问不出来（没提供者 / 抛错），不夸大，按较轻的那档报。
      level: selfFirst === false ? 'shadowed' : 'duplicate',
      builtinActive: true,
      selfFirst,
      at: Date.now()
    };
  }

  /** 内置版是否生效。纯内存查询，不碰磁盘。 */
  #builtinActive() {
    const a = this.api;
    if (!a || typeof a.isSkillActive !== 'function') return false;
    try { return a.isSkillActive(BUILTIN_ID) === true; } catch { return false; }
  }

  /** 问"第一个 memory.status 提供者是不是我"。true=是，false=不是，null=问不出来。 */
  #probeSelfFirst() {
    const a = this.api;
    if (!a || typeof a.capability !== 'function') return null;
    let r;
    try { r = a.capability('memory.status', { [PROBE_KEY]: ENGINE_TAG }); } catch { return null; }
    if (!r || typeof r !== 'object') return null;
    return r.engine === ENGINE_TAG;
  }

  /** 给人看的完整提示（日志 / memory.status 里用）。无冲突返回 ''。 */
  notice() {
    const st = this.state;
    if (!st || st.level === 'none') return '';
    const head = `⚠️ 记忆引擎冲突：内置的「${BUILTIN_NAME}」插件还开着。`;
    const tail = `请到「插件」页把它关掉，只留「${SELF_NAME}」。`;
    if (st.level === 'shadowed') {
      return `${head}两套记忆会同时往每轮请求里塞内容（重复 + 双份 token），`
        + '而且它的能力排在前面 —— 宿主自带的检索工具查到的是它的旧数据，不是本插件的。'
        + tail;
    }
    return `${head}两套记忆会同时往每轮请求里塞内容（重复 + 双份 token），后台巩固也会各跑一份。`
      + tail;
  }

  /**
   * 注入用的一句话。必须短 —— 它只在私聊、且隔一段冷却才出现一次。
   * 措辞写成"给助手的一句话"，让模型顺口转达给主人；末尾明确"说一次就够"，
   * 免得模型每轮都念。
   */
  announce() {
    const st = this.state;
    if (!st || st.level === 'none') return '';
    return `〔记忆引擎提醒〕检测到内置的「${BUILTIN_NAME}」插件仍然开启，它会和本插件重复往提示词里塞记忆。`
      + `请顺口提醒主人一句：到「插件」页把内置那个关掉，只留「${SELF_NAME}」。说一次就够，别反复念叨。`;
  }

  /**
   * 这轮该不该插一句冲突提醒。**纯判断，不记账** ——
   * 记账交给 markAnnounced()，由调用方在"确实注入成功"之后调用，
   * 否则"没找到 user 消息、注入失败"也会白白吃掉一次冷却。
   */
  canAnnounce(chatKey, { now = Date.now() } = {}) {
    const s = this.settings() || {};
    if (s.warnOnConflict === false) return false;
    // 只在私聊提醒：群聊里播报插件配置，等于当着陌生人的面念主人的设置页。
    // 这是安全默认，不做成开关 —— 让人误开的东西不该存在。
    if (!String(chatKey || '').startsWith('private:')) return false;
    if (this.check({ now }).level === 'none') return false;
    const cooldownMs = num(s.conflictWarnCooldownMin, COOLDOWN_DEFAULT, COOLDOWN_MIN, COOLDOWN_MAX) * 60000;
    return now - this.lastAnnouncedAt >= cooldownMs;
  }

  /** 记一笔"已经提醒过"。落盘到宿主给的插件存储，重启不重数冷却。 */
  markAnnounced({ now = Date.now() } = {}) {
    this.lastAnnouncedAt = now;
    try { this.api?.storage?.set?.(STORAGE_KEY, { at: now, level: this.level }); } catch { /* 落盘失败只影响下次冷却判断 */ }
    return true;
  }

  /** 排障用：把状态摊平成纯数据（memory.status 直接回给模型/用户）。 */
  snapshot() {
    const st = this.state;
    return {
      level: st?.level || 'none',
      builtinActive: st?.builtinActive === true,
      selfFirst: st?.selfFirst ?? null,
      checkedAt: this.checkedAt || 0,
      lastAnnouncedAt: this.lastAnnouncedAt || 0,
      hint: this.notice()
    };
  }
}

export { STORAGE_KEY, PROBE_KEY, RECHECK_MS, COOLDOWN_DEFAULT };

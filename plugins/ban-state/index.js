// 群禁言状态 —— 记住机器人在哪些群被禁言，避免白跑一轮烧 token。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────
// 机器人被禁言时**一条消息都发不出去**。此时如果照常处理消息，
// 结果是：花掉一整轮的 token（提示词 + 思考 + 工具调用），最后一句话也发不出去。
// 群里刷十句话，就白烧十轮。
//
// ── 为什么单独一个模块（而不是塞进 orchestrator）─────────────────────
// 写状态的有两个来源，读状态的是第三个地方，三者互不持有引用：
//   写：协议层（收到 OneBot 的 group_ban 通知）
//   写：发送层（发送被服务端拒绝时兜底 —— 通知可能丢）
//   读：编排层（决定这次要不要跑）
// 用模块级状态最省事，也不用把 app/sender/orchestrator 互相串起来。
//
// ── 两种来源，互为补充 ────────────────────────────────────────────────
//   1) OneBot 的 group_ban 通知 —— 准，带明确到期时间
//   2) 发送被服务端拒绝 —— 兜底：通知可能丢，或禁言是别的形式
// 有时长的到期自动失效；没时长的（0）保持到收到明确解禁。
//
// ── 状态变化订阅（2026-10-22，报告 F1）─────────────────────────────────
// 光有状态不够：编排层的禁言查询结果带 TTL 缓存，状态变了缓存不会自动失效，
// 于是"已经知道被禁言"了这个事实最多要被缓存蒙 60 秒（2026-10-22 实测：
// 禁言后 4 次唤醒全部命中禁言前的旧缓存，10 分钟禁言期一次都没刷新）。
// 因此 noteMuted / noteUnmuted / 到期自动失效三条路径都通知订阅者，
// 由订阅者（orchestrator）直接覆写它的缓存 —— 缓存穿透，不等 TTL。
//
// ── 记录时间 notedAt（2026-10-22 晚，解禁复检）────────────────────────
// 编排层的复检逻辑要区分"刚记录的禁言"和"记了很久的禁言"：解禁通知可能丢，
// 但成员列表刷新也可能比通知慢一拍 —— 刚记上的禁言若被一次过期数据翻案，
// 机器人会去发言再被拒，白跑一轮。所以记录时间要暴露给编排层做宽限期。

let cfg = () => ({});
let log = () => {};

// chatKey -> { until: 到期时间戳(0=直到明确解禁), notedAt: 记录时间(ms) }
const mutedUntil = new Map();
const changeListeners = new Set();   // 禁言状态变化订阅者（编排层缓存穿透用）

/** 通知所有订阅者：某会话的禁言状态变了。订阅者抛错不影响状态写入本身。 */
function notifyChange(chatKey, muted) {
  for (const cb of [...changeListeners]) {
    try { cb(chatKey, muted); } catch { /* 订阅者自己兜底 */ }
  }
}

/** 订阅禁言状态变化。返回退订函数。 */
export function onBanStateChange(cb) {
  if (typeof cb !== 'function') return () => {};
  changeListeners.add(cb);
  return () => changeListeners.delete(cb);
}

/**
 * 记录被禁言。
 * @param {string} chatKey 形如 group:123456
 * @param {number} durationSec 禁言时长（秒）；<=0 表示时长未知，保持到解禁通知
 */
export function noteMuted(chatKey, durationSec = 0) {
  const key = String(chatKey || '');
  if (!key) return;
  const sec = Number(durationSec) || 0;
  mutedUntil.set(key, { until: sec > 0 ? Date.now() + sec * 1000 : 0, notedAt: Date.now() });
  log(`群 ${key} 进入禁言${sec > 0 ? `（${sec} 秒）` : '（时长未知）'}，期间跳过处理`);
  notifyChange(key, true);
}

/** 明确解禁。 */
export function noteUnmuted(chatKey) {
  const key = String(chatKey || '');
  if (mutedUntil.delete(key)) {
    log(`群 ${key} 已解禁，恢复正常处理`);
    notifyChange(key, false);
  }
}

/** 现在是否处于禁言中（顺带清理已过期的）。 */
export function isMuted(chatKey) {
  const key = String(chatKey || '');
  if (!mutedUntil.has(key)) return false;
  const rec = mutedUntil.get(key);
  if (rec.until && Date.now() >= rec.until) {
    mutedUntil.delete(key);
    // 到期自动失效也要通知：否则编排层缓存里"禁言中"会继续蒙到 TTL 结束
    notifyChange(key, false);
    return false;
  }
  return true;
}

/** 这条记录是什么时候记下的（编排层复检宽限期用；无记录返回 null）。 */
export function mutedNotedAt(chatKey) {
  return mutedUntil.get(String(chatKey || ''))?.notedAt ?? null;
}

/** 还剩多少秒；null = 未禁言或无明确时长（给人看的，日志用）。 */
export function mutedRemainSec(chatKey) {
  const until = mutedUntil.get(String(chatKey || ''))?.until ?? 0;
  if (!until) return null;
  return Math.max(0, Math.round((until - Date.now()) / 1000));
}

/** 当前所有处于禁言中的会话（状态接口 / 排障用）。 */
export function listMuted() {
  const out = [];
  for (const key of [...mutedUntil.keys()]) {
    if (isMuted(key)) out.push({ chatKey: key, remainSec: mutedRemainSec(key) });
  }
  return out;
}

/**
 * 由 OneBot 的 shut_up_timestamp 判断"现在还在禁言中吗"。
 *
 * ⚠️ 这个字段是禁言的**到期时刻**（epoch 秒），不是时长；而且**解禁后 QQ 不会把它清零**，
 * 会留着一个已经过去的时刻。所以判据必须是「到期时刻在**未来**」，不能是「非 0」：
 *   - 旧写法 `until > 0` → 早就解禁的群被当成"正在禁言"
 *   - 再配上 `Math.max(1, until - now)` → 负数差值被夹成 1 秒 → 永久卡在"剩余 1 秒"，
 *     那个群**再也不会被唤醒**
 * 实测（2026-09-12）有两个群的到期时刻分别是 6.7 / 12 小时之前，
 * 却因此彻底不回复，日志里反复刷"剩余 1 秒"。
 *
 * 做成纯函数是为了可测 —— 这段逻辑原本内联在定时器里，测试碰不到。
 *
 * @param {number|string} untilRaw shut_up_timestamp 原值
 * @param {number} [nowSec] 当前 epoch 秒（测试可注入）
 * @returns {{muted:boolean, remainSec:number}}
 */
export function muteFromTimestamp(untilRaw, nowSec = Math.floor(Date.now() / 1000)) {
  const until = Number(untilRaw) || 0;
  if (until > nowSec) return { muted: true, remainSec: until - nowSec };
  return { muted: false, remainSec: 0 };
}

/**
 * 这个发送错误是不是"被禁言"的签名（2026-10-22，报告 F4）。
 *
 * 实测签名（本栈，禁言发送失败）：
 *   snowluma 协议层   throw `send group message rejected: result=120 err=""`
 *     ↓ OneBot 包装   failedResponse(RETCODE.ACTION_FAILED=100, 同上文案)
 *     ↓ onebot.js     Error("OneBot send_group_msg 失败: retcode=100 send group
 *                          message rejected: result=120 err=\"\""), e.retcode=100
 *
 * 判据只能认 **result=120**：errMsg 是空串，没有任何文案可依。
 * retcode 只在**确实拿得到**时校验（必须 = 100）；拿不到（如 sendTextBatch
 * 把多条失败聚合成一条字符串错误后）时按 message 判，不误杀。
 *
 * ⚠️ 风控可能返回同码（模型自己的判断也是"可能是被禁言或风控"）——
 *    调用方按禁言处理的代价是跳过若干轮回复（可恢复），好过继续烧 token，
 *    但日志必须注明存疑。
 *
 * @param {{retcode?:number, message?:string}|Error|string} err
 * @returns {boolean}
 */
export function isMuteRejection(err) {
  const msg = String(err?.message ?? err ?? '');
  if (!/result=120/.test(msg)) return false;
  const retcode = err?.retcode;
  return retcode == null || retcode === 100;
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  // 给编排层/发送层/协议层用的统一入口。
  // ⚠️ 必须用解构参数，不能用 arguments —— 箭头函数没有自己的 arguments，
  //    在箭头函数里写 arguments 会拿到外层作用域（或直接报错），是个隐蔽的坑。
  'chat.ban-state': ({ chatKey, action = 'check', durationSec = 0, onChange, error } = {}) => {
    if (action === 'note-muted') { noteMuted(chatKey, durationSec); return { ok: true }; }
    if (action === 'note-unmuted') { noteUnmuted(chatKey); return { ok: true }; }
    if (action === 'list') return { muted: listMuted() };
    // 订阅状态变化（F1 缓存穿透）：编排层启动/每次查询时注册，幂等。
    // 直接返回插件的退订函数（调用方持有它，热重载/销毁时退订）。
    if (action === 'subscribe') {
      if (typeof onChange !== 'function') return { ok: false };
      return onBanStateChange(onChange);
    }
    // 发送被拒兜底（F4）：识别禁言签名，命中即记录（时长未知，保持到解禁）。
    // 返回 matched 供调用方决定怎么跟模型/用户交代。
    if (action === 'note-send-rejected') {
      const matched = isMuteRejection(error);
      if (matched) noteMuted(chatKey, 0);
      return { ok: true, matched };
    }
    const c = cfg();
    const muted = isMuted(chatKey);
    return {
      muted,
      // known 的含义：**这个答案是不是确定的**。
      //   true  = 我们收到过明确的禁言通知/发送拒绝，答案可信
      //   false = 没收到过任何通知，只是"没记录"——不代表没被禁言
      // 编排层只在 known=true 且 muted=true 时才跳过；
      // 其余情况仍走一次 OneBot 查询（通知可能丢），两者互为兜底。
      // 这样"确定被禁言"时省掉一次 API 调用 + 一整轮 token，
      // 而"不知道"时不会因为状态缺失就误放行。
      known: muted,
      remainSec: mutedRemainSec(chatKey),
      // 记录时间：编排层复检的宽限期判据 —— 刚记上的禁言不允许被一次
      // （可能滞后的）查询翻案，见 orchestrator #checkSelfMutedDetail。
      notedAt: mutedNotedAt(chatKey),
      skipRun: c.skipRunWhenMuted !== false,
      markRead: c.markReadWhenMuted !== false
    };
  }
};

export function available() { return { ok: true }; }

export const internals = {
  noteMuted, noteUnmuted, isMuted, mutedRemainSec, mutedNotedAt, listMuted, muteFromTimestamp,
  isMuteRejection, onBanStateChange
};

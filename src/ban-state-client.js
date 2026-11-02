// ban-state 客户端：统一封装对「群禁言状态」Skill（chat.ban-state 能力）的访问。
//
// 为什么需要这一层：写禁言状态的有三个地方（协议层 group_ban 通知、发送层被拒兜底、
// UI/API），读的有编排层。让每个调用方自己 enumerate providers 一遍，写法会漂移
// （context 传不传、错误吞不吞、返回值怎么取），所以收口在这里。
//
// 插件没装 / 没启用时所有调用都是静默无副作用 —— 禁言判断退化为"只有查询兜底"，
// 与装插件之前的行为一致。
//
// 相关：plugins/ban-state/index.js（状态与纯函数本体，单测直接驱动它的 internals）。
import { skillManager } from './skills/manager.js';

/** 取所有生效中的 ban-state 提供者（插件缺失时为空数组）。 */
function providersOf(chatKey) {
  try {
    return skillManager.getCapabilityProviders('chat.ban-state', chatKey ? { chatKey, kind: 'group' } : {}) || [];
  } catch { return []; }
}

/** 对第一个提供者调用 action，返回其结果；无提供者返回 null。 */
function call(action, args = {}, chatKey = '') {
  for (const p of providersOf(chatKey)) {
    try { return p.fn({ chatKey, ...args, action }); } catch { /* 单个 provider 出错不影响其它 */ }
  }
  return null;
}

/**
 * 查询禁言状态（编排层用）。
 * 返回 { muted, known, remainSec, notedAt, skipRun, markRead }；插件缺失时返回
 * { muted:false, known:false, remainSec:null, notedAt:null, skipRun:true, markRead:true }。
 */
export function checkBanState(chatKey) {
  const r = call('check', {}, chatKey);
  if (!r) return { muted: false, known: false, remainSec: null, notedAt: null, skipRun: true, markRead: true };
  return {
    muted: r.muted === true,
    known: r.known === true,
    remainSec: r.remainSec ?? null,
    notedAt: r.notedAt ?? null,
    skipRun: r.skipRun !== false,
    markRead: r.markRead !== false
  };
}

/** 记录被禁言。durationSec <=0 = 时长未知，保持到解禁通知。 */
export function noteMuted(chatKey, durationSec = 0) {
  return call('note-muted', { durationSec }, chatKey);
}

/** 明确解禁。 */
export function noteUnmuted(chatKey) {
  return call('note-unmuted', {}, chatKey);
}

/**
 * 订阅禁言状态变化（F1 缓存穿透用）。
 * @param {(chatKey:string, muted:boolean)=>void} onChange
 * @returns {() => void} 退订函数（插件缺失时是空操作）
 */
export function onBanStateChange(onChange) {
  if (typeof onChange !== 'function') return () => {};
  const r = call('subscribe', { onChange }, '');
  return typeof r === 'function' ? r : () => {};
}

/**
 * 发送被拒兜底（F4）：把一次发送失败反馈给 ban-state。
 * 命中禁言签名（result=120）时插件会记录该群禁言，本函数返回 { matched:true }。
 *
 * @param {string} chatKey
 * @param {{retcode?:number, message?:string}|Error|string} error 原始错误或其消息串
 */
export function noteSendRejected(chatKey, error) {
  const r = call('note-send-rejected', { error }, chatKey);
  return { matched: r?.matched === true };
}

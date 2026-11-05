// setu 过滤函数（从 setu.js 提取，纯函数、零副作用、可独立单元测试）。
// 只依赖 config.js 的标签 Set 数据与全局分级派生表，不依赖任何 I/O 或模块状态。
import { MULTI_PERSON_TAGS, GENERIC_TAGS, MALE_CHARACTER_TAGS, HORROR_TAGS, QUALITY_TAGS } from './config.js';
import { ratingRule } from '../../src/content-rating.js';

/** 帖子是否双人/多人图（按作品标签判定，soloOnly 时跳过这些）。 */
export function isMultiPersonIllust(illust) {
  const names = new Set((illust?.tags || []).map((t) => String(t?.name || '').trim().toLowerCase()));
  for (const t of MULTI_PERSON_TAGS) if (names.has(t)) return true;
  return false;
}

/** 判断标签是否像角色名（CJK 且 2-4 字，且不在通用标签列表）。 */
function isCharacterLikeTag(tag) {
  const s = String(tag || '').trim();
  if (!s) return false;
  if (!/[\u3400-\u9fff\uf900-\ufaff]/.test(s)) return false;
  if (s.length < 2 || s.length > 4) return false;
  if (GENERIC_TAGS.has(s.toLowerCase())) return false;
  return true;
}

/** 帖子是否含多个角色标签（singleCharacterOnly 时跳过这些）。 */
export function isMultiCharacterIllust(illust) {
  const tags = illust?.tags || [];
  const charTags = tags
    .map((t) => String(t?.name || '').trim())
    .filter((t) => isCharacterLikeTag(t));
  return charTags.length > 1;
}

/** 关键词是否像配对/CP 请求（双人图正是目标，跳过 solo 过滤）。 */
export function isPairingKeyword(keyword) {
  const k = String(keyword || '').trim().toLowerCase();
  if (/[×&＋+]/.test(k)) return true;
  return /\b(and|cp|couple|pair|ship)\b/.test(k);
}

/**
 * 构造 Pixiv 搜索词：关键词 + solo（可选）。抽成纯函数便于测试。
 * 质量标签走客户端 OR 过滤（hasQualityTag），不追加到搜索词，避免 AND 逻辑过严。
 * femaleOnly 参数保留但不参与拼词，女性角色过滤完全走客户端 isMaleCharacterIllust。
 */
export function buildSearchWord(tags, soloOnly, _femaleOnly, qualityTags = '') {
  let word = tags;
  if (soloOnly) word += ' solo';
  // 质量标签改为客户端 OR 过滤，不追加到搜索词（避免 AND 逻辑过严）
  return word;
}

/** 质量标签 OR 过滤：图片含任一标签即保留。 */
export function hasQualityTag(illust, qualityTags = '') {
  const qt = String(qualityTags || '').trim();
  if (!qt) return true;
  const wanted = qt.split(/[\s,，]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (!wanted.length) return true;
  const names = new Set((illust?.tags || []).map((t) => String(t?.name || '').trim().toLowerCase()));
  for (const t of wanted) if (names.has(t)) return true;
  return false;
}

/** 帖子是否含男性角色标签（femaleOnly 时跳过这些）。 */
export function isMaleCharacterIllust(illust) {
  const names = new Set((illust?.tags || []).map((t) => String(t?.name || '').trim().toLowerCase()));
  for (const t of MALE_CHARACTER_TAGS) if (names.has(t)) return true;
  return false;
}

/** 帖子是否含恐怖/血腥/不适内容标签。 */
export function isHorrorIllust(illust) {
  const names = new Set((illust?.tags || []).map((t) => String(t?.name || '').trim().toLowerCase()));
  for (const t of HORROR_TAGS) if (names.has(t)) return true;
  return false;
}

/** R-18 检测：标准 API restrict=1、PXVE x_restrict=1 / sanity_level>=6、categories 含 R-18/R-18G。 */
export function isR18Illust(illust) {
  if (illust?.restrict === 1) return true;
  if (illust?.x_restrict === 1) return true;
  if (Number(illust?.sanity_level) >= 6) return true;
  const cats = Array.isArray(illust?.categories) ? illust.categories : [];
  for (const c of cats) {
    const v = String(c).trim();
    if (v === 'R-18' || v === 'R-18G') return true;
  }
  return false;
}

/** R-15 检测：PXVE sanity_level>=2 或 categories 含 R-15。 */
export function isR15Illust(illust) {
  if (Number(illust?.sanity_level) >= 2) return true;
  const cats = Array.isArray(illust?.categories) ? illust.categories : [];
  for (const c of cats) {
    if (String(c).trim() === 'R-15') return true;
  }
  return false;
}

/** R-0 白名单：只保留 categories 全为 R-0（或空）的图片。 */
export function isR0Only(illust) {
  if (illust?.restrict === 1) return false;
  if (illust?.x_restrict === 1) return false;
  if (Number(illust?.sanity_level) >= 2) return false;
  const cats = Array.isArray(illust?.categories) ? illust.categories : [];
  for (const c of cats) {
    const v = String(c).trim();
    if (v !== 'R-0' && v !== '') return false;
  }
  return true;
}

/** 按质量给帖子打分：分辨率(权重最大) + 标签丰富度(上限5分) + 质量标签(每个+3分)。 */
export function illustScore(illust) {
  let score = 0;
  const w = Number(illust?.width) || 0;
  const h = Number(illust?.height) || 0;
  score += (w * h) / 1000000;
  score += Math.min((illust?.tags?.length || 0) / 10, 5);
  const names = new Set((illust?.tags || []).map((t) => String(t?.name || '').trim().toLowerCase()));
  for (const t of QUALITY_TAGS) if (names.has(t)) score += 3;
  return score;
}

/**
 * 单张作品的内容分级声明（发送时交给 core 闸门）。
 * 判定顺序必须从严到宽：R-18 命中即 r18，其次 R-15，其余按 R-0/safe。
 */
export function illustRating(illust) {
  if (isR18Illust(illust)) return 'r18';
  if (isR15Illust(illust)) return 'r15';
  return 'safe';
}

/**
 * 按全局内容分级过滤候选，并返回每一步的漏斗计数。
 *
 * 这是全项目唯一的候选分级过滤实现：搜索路径用它筛 URL，诊断也用它的 funnel
 * 判断「到底是哪一步把候选滤空了」，不再靠标签样本猜。
 * 未启用的档位不执行过滤，对应计数沿用上一步（漏斗因此始终可读成
 * 「这一档实际滤掉了多少」）。
 *
 * @param {Array} illusts 候选作品
 * @param {string} rating 策略档位（all / r18 / strict / r0）
 * @returns {{ illusts: Array, funnel: { afterR18: number, afterR15: number, afterR0: number } }}
 */
export function applyContentPolicy(illusts, rating) {
  const rule = ratingRule(rating);
  let list = Array.isArray(illusts) ? illusts : [];
  if (rule.blockR18) list = list.filter((il) => !isR18Illust(il));
  const afterR18 = list.length;
  if (rule.blockR15) list = list.filter((il) => !isR15Illust(il));
  const afterR15 = list.length;
  if (rule.onlyR0) list = list.filter((il) => isR0Only(il));
  const afterR0 = list.length;
  return { illusts: list, funnel: { afterR18, afterR15, afterR0 } };
}

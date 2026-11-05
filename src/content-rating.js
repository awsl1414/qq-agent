// 内容分级：出站图片「发什么级别的内容」的全局策略与唯一派生表。
//
// 为什么是全局而不是扩展私有配置：本项目支持安装第三方 / 自制扩展包，如果分级
// 是每个图片类扩展各写一套私有键（历史上是 random-image 的 safeMode 与
// booru.strictSfw / booru.onlyR0），键名、语义、默认值必然漂移，第三方包既不知道
// 该读哪个键，core 也无法统一执行 —— 策略形同虚设。
//
// 分层（与 security.imageSend 并列，两条不同的轴）：
//   · security.imageSend  管「能不能发 / 怎么发」（总开关、预览、限量、体积）；
//   · security.contentRating 管「发什么级别的内容」，本文件是它唯一的派生来源。
// 将来表情包、视频要分级时复用同一张表，不必再开新键。
import { getConfig } from './config.js';
import { logger } from './logger.js';

/** 策略档位。顺序即从严到宽，供 UI 下拉直接复用。 */
export const CONTENT_RATINGS = ['all', 'r18', 'strict', 'r0'];

/**
 * 调用方可以声明的图片分级（sender.sendImage 的 options.rating）。
 * 与策略档位不是同一组值：声明描述「这张图有多露」，策略描述「放行到哪一档」。
 */
export const DECLARED_RATINGS = ['safe', 'r15', 'r18'];

/**
 * rating → 过滤规则。全项目只有这一处定义，其它模块一律调用 ratingRule()。
 *   all    全部放行
 *   r18    只拦 R-18 / R-18G
 *   strict 拦 R-18 + R-15（默认）
 *   r0     仅 R-0
 * 说明：Pixiv 的 sanity_level≥2 即属 R-15，绝大多数图都在这一档，
 * 所以 strict 会滤掉几乎全部内容。
 */
const RATING_RULES = {
  all: { blockR18: false, blockR15: false, onlyR0: false },
  r18: { blockR18: true, blockR15: false, onlyR0: false },
  strict: { blockR18: true, blockR15: true, onlyR0: false },
  r0: { blockR18: true, blockR15: true, onlyR0: true }
};

/** 非法档位一律按最严处理（安全侧）。 */
const FALLBACK_RATING = 'strict';

/** 某个档位的过滤规则。未知档位回落 strict，不做第二套判断。 */
export function ratingRule(rating) {
  return RATING_RULES[rating] ?? RATING_RULES[FALLBACK_RATING];
}

let warnedInvalidRating = false;

/**
 * 当前生效的分级。读配置；非法 / 未知值回落 strict 并 warn 一次
 * （每次进程只报一次，避免每次发图都刷日志）。
 */
export function currentContentRating(cfg = getConfig()) {
  const raw = cfg?.security?.contentRating;
  if (CONTENT_RATINGS.includes(raw)) return raw;
  if (raw !== undefined && raw !== null && !warnedInvalidRating) {
    warnedInvalidRating = true;
    logger.warn('content-rating', `security.contentRating 的值 ${JSON.stringify(raw)} 不在 ${CONTENT_RATINGS.join(' / ')} 内，已按 ${FALLBACK_RATING} 处理`);
  }
  return FALLBACK_RATING;
}

/**
 * 声明的分级是否超过当前策略。
 *
 * 映射关系（declared → 被哪条规则拦）：
 *   safe → 永不超限（R-0）
 *   r15  → 策略拦 R-15 时超限（strict / r0）
 *   r18  → 策略拦 R-18 时超限（r18 / strict / r0）
 * 未知 declared 不属于本函数的职责，调用方须先用 DECLARED_RATINGS 校验。
 */
export function exceedsPolicy(declared, policy) {
  const rule = ratingRule(policy);
  switch (declared) {
    case 'safe': return false;
    case 'r15': return rule.blockR15;
    case 'r18': return rule.blockR18;
    default: return false;
  }
}

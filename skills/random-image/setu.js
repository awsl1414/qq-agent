// 二次元随机图片数据层（移植自 MaiBot 插件 com.claw.pixiv-crawler v4.1.0，MIT）。
//
// 与原版的差异：
//   1. 去掉 @Command 关键词直发路径，只保留工具入口，@ 检测与意图判断交给模型。
//   2. 图片下载走本项目的 safeFetchBinary（SSRF 全防护：DNS 校验、IP 固定防
//      rebinding、每跳重校验、限量读取），Referer 通过 headers 注入。
//   3. 加了原版没有的两个上限：count 最多 20 张、单图最多 maxImageBytes 字节。
//      原版允许 num=100 且无大小限制，原图直发会把内存和 HTTP 负载放大到不可控。
//
// 原图直发不压缩。载荷默认走"本地临时文件 + 绝对路径"，而不是 base64 内联：
// 实测 SnowLuma 的 HTTP 服务端对 ~3MB 的 base64 请求体直接 ECONNRESET（0.1KB 的
// 路径请求正常 200），落盘后请求体只剩一个路径字符串。payloadMode='base64'
// 可切回内联（用于 SnowLuma 在另一台机器时）。
import { safeFetch } from '../../src/safe-fetch.js';

// 常量与标签 Set 在 config.js，这里只导入本文件直接使用的
import {
  MAX_COUNT, NSFW_TRIGGER_RE, MULTI_PERSON_TAGS, MALE_CHARACTER_TAGS, HORROR_TAGS,
  DEFAULT_SETU_BASE_URL, SETU_IMAGE_SIZE, SETU_NSFW_SORT, SETU_SFW_SORT, SETU_REQUEST_TIMEOUT_MS,
  FETCH_ROUNDS
} from './config.js';

// 响应解析是纯函数（可独立单测），见 response.js
import { extractImageUrls } from './response.js';
// 日志出口（setup 时由 index.js 注入核心 logger）
import { log, warn, error } from './log.js';

// 过滤函数在 filters.js（纯函数，可独立单元测试）
import {
  isMultiPersonIllust, isMultiCharacterIllust, isPairingKeyword,
  buildSearchWord, hasQualityTag, isMaleCharacterIllust, isHorrorIllust,
  isR18Illust, isR15Illust, isR0Only, illustScore
} from './filters.js';
export {
  isMultiPersonIllust, isMultiCharacterIllust, isPairingKeyword,
  buildSearchWord, hasQualityTag, isMaleCharacterIllust, isHorrorIllust,
  isR18Illust, isR15Illust, isR0Only, illustScore
};

// 下载基础设施在 downloader.js
import {
  validateImageIntegrity, SetuSource, defaultSetuSource, pickBestImages, downloadImage
} from './downloader.js';
export { validateImageIntegrity, SetuSource, defaultSetuSource, pickBestImages };

// Pixiv 搜索基础设施在 pixiv.js
import {
  AUTOCOMPLETE_CACHE, cacheAutocomplete, mapKeywordToTags, resolveSearchTag,
  translateTag, lookupBooruTag, pixivCfg, hasCJK, pixivArtworkId, fetchBooruCandidates
} from './pixiv.js';
export { AUTOCOMPLETE_CACHE, cacheAutocomplete, mapKeywordToTags, resolveSearchTag, translateTag, lookupBooruTag };

/** 从 chatKey（"group:<id>" / "private:<id>"）拆出会话上下文。 */
export function chatContextFromKey(chatKey) {
  const [kind, id] = String(chatKey || '').split(':');
  if (kind === 'group') return { groupId: String(id || ''), userId: '', isGroup: true };
  if (kind === 'private') return { groupId: '', userId: String(id || ''), isGroup: false };
  return { groupId: '', userId: '', isGroup: false };
}

/** whitelist=在名单内才放行；blacklist=在名单内则丢弃。（与原版 _id_allowed_by_policy 语义一致） */
export function idAllowedByPolicy(targetId, listType, configuredIds) {
  const ids = new Set((Array.isArray(configuredIds) ? configuredIds : []).map(String));
  const has = ids.has(String(targetId || ''));
  return listType === 'whitelist' ? has : !has;
}

/** 群/私聊黑白名单：本会话是否允许发图。未开启或未配名单时全放行。 */
export function isChatAllowed(chatKey, chatFilter) {
  if (!chatFilter || chatFilter.enabled !== true) return true;
  const ctx = chatContextFromKey(chatKey);
  if (ctx.isGroup) return idAllowedByPolicy(ctx.groupId, chatFilter.groupListType || 'blacklist', chatFilter.groupList);
  return idAllowedByPolicy(ctx.userId, chatFilter.privateListType || 'blacklist', chatFilter.privateList);
}

/** 色图是否允许在当前会话发送。nsfwFilter.enabled=false 时恒放行（只看全局 nsfwAllowed）。 */
export function isNsfwAllowedForChat(chatKey, nsfwFilter) {
  if (!nsfwFilter || nsfwFilter.enabled !== true) return true;
  const ctx = chatContextFromKey(chatKey);
  if (ctx.isGroup) return idAllowedByPolicy(ctx.groupId, nsfwFilter.groupListType || 'whitelist', nsfwFilter.groupList);
  return nsfwFilter.privateAllowed !== false;
}

/** 色图范围过滤 + 降级。返回 { category, reject }：category 为 null 表示拒绝不发。 */
export function resolveNsfw(chatKey, requested, { nsfwFilter, send } = {}) {
  if (requested !== 'nsfw') return { category: requested, reject: null };
  if (isNsfwAllowedForChat(chatKey, nsfwFilter)) return { category: 'nsfw', reject: null };
  if (nsfwFilter && nsfwFilter.fallbackToSfw !== false && send && send.sfwAllowed !== false) {
    return { category: 'sfw', reject: null };   // 本会话不允许色图 → 自动改发无色图
  }
  return { category: null, reject: (nsfwFilter && nsfwFilter.rejectMessage) ?? '' };
}

/** 分类归一：nsfw/r18/色图/涩图/瑟图/setu → nsfw，其余一律 sfw。 */
export function normalizeCategory(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (['nsfw', 'r18', '色图', '涩图', '瑟图', 'setu'].includes(v)) return 'nsfw';
  return 'sfw';
}

export function categoryLabel(category) {
  return category === 'nsfw' ? '色图' : '无色图';
}

/** sort 参数只对 cnmiw（MirlKoi）这类接口有意义，lolicon v2 会忽略它。 */
function sortKeyFor(api, category) {
  return category === 'nsfw' ? (api.nsfwSort || SETU_NSFW_SORT) : (api.sfwSort || SETU_SFW_SORT);
}

function clampCount(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_COUNT);
}

/**
 * 组装取图请求 URL。
 * 参数按各接口的公开契约组织（均经实测）：
 *   num          —— lolicon v1/v2、cnmiw 都支持
 *   r18          —— lolicon v2 支持（0/1）；cnmiw/anosu 忽略
 *   size=regular —— lolicon v2 支持，取值依据见 config.js 的 SETU_IMAGE_SIZE
 *   sort / type  —— cnmiw 只有 type=json 才返回 JSON，且需要 sort 选分类；
 *                   lolicon 忽略这两个参数。保留它们是为兼容 cnmiw 与用户自填的同类接口，
 *                   不是无理由的遗留参数。
 * 不传 tag：关键词请求走 Pixiv 标签搜索（见 runKeywordSearch），参数到不了这里，
 * 传空 tag 只会让接口把它当过滤条件，命中 0 条。
 *
 * 导出仅为单测：这些 query 参数拼错时接口照常 200，只是返回空或错误尺寸，
 * 表现为"拉不到图"/"单图超大下载失败"，从发送链路看不出来源。
 * 用户自填地址里已有的 query 会保留（URL.searchParams.set 是增量改写，不是整体替换）。
 */
export function buildPicUrl(api, sortKey, num, { nsfw }) {
  const base = String(api?.baseUrl ?? '').trim();
  // 配置类故障不可恢复（要用户改设置），落 error 级别：这两条以前只 throw 给模型，
  // data/logs 里一个字都没有，"随机图发不出去"时无法判断是配置还是网络。
  if (!base) {
    error('随机图片接口地址为空，请到「设置 → 工具与技能 → 二次元随机图片」填写接口地址');
    throw new Error('随机图片接口地址为空');
  }
  let u;
  try {
    u = new URL(base);
  } catch {
    error(`随机图片接口地址不是合法 URL：${base}`);
    throw new Error(
      `随机图片接口地址不是合法 URL：${base}。请到「设置 → 工具与技能 → 二次元随机图片 → 接口地址」改成完整地址，例如 ${DEFAULT_SETU_BASE_URL}`
    );
  }
  u.searchParams.set('num', String(clampCount(num)));
  u.searchParams.set('r18', nsfw ? '1' : '0');
  u.searchParams.set('size', SETU_IMAGE_SIZE);
  u.searchParams.set('type', 'json');
  u.searchParams.set('sort', String(sortKey || ''));
  return u.toString();
}

/** 调取图接口拿一批 URL。失败返回 []（网络错误表现为"拉不到图"，不抛错）。 */
async function fetchPicUrls(cfg, sortKey, num, { category }) {
  const api = cfg.api;
  const target = buildPicUrl(api, sortKey, num, { nsfw: category === 'nsfw' });
  let body;
  try {
    ({ body } = await safeFetch(target, {
      timeoutMs: Number(api?.requestTimeoutMs) > 0 ? Number(api.requestTimeoutMs) : SETU_REQUEST_TIMEOUT_MS
    }));
  } catch (error) {
    warn(`取图接口请求失败 ${sortKey}: ${error?.message ?? error}`);
    return [];
  }
  let data;
  try { data = JSON.parse(body || ''); } catch {
    warn('取图接口返回不是合法 JSON');
    return [];
  }
  const urls = extractImageUrls(data);
  // 一行说清"取图这步走到哪了"：真实故障里这条链上原本只有下载侧日志，
  // 接口返回 0 条与接口没请求成功在日志里无从区分。
  log(`取图接口返回 ${urls.length} 条 URL（sort=${sortKey} num=${num}）`);
  return urls;
}

function dedupeInBatch(batch, limit) {
  const seen = new Set();
  const out = [];
  for (const u of batch) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
    if (out.length >= limit) break;
  }
  return out;
}

/** 取去重后的 URL 列表，最多 limit 个。去重过严时退化为不去重再取一次保证可用性。 */
async function fetchFreshUrls(cfg, source, sortKey, limit, category) {
  if (cfg.send?.dedupEnabled === false) {
    return dedupeInBatch(await fetchPicUrls(cfg, sortKey, limit, { category }), limit);
  }
  const collected = [];
  for (let round = 0; round < 2; round++) {
    const need = limit - collected.length;
    if (need <= 0) break;
    const batch = await fetchPicUrls(cfg, sortKey, need, { category });
    if (!batch.length) break;
    for (const u of batch) {
      if (collected.includes(u) || source.isRecent(u)) continue;
      collected.push(u);
      if (collected.length >= limit) break;
    }
    if (batch.length < need) break;   // API 没给够，再请求也无意义
  }
  if (!collected.length) {
    return dedupeInBatch(await fetchPicUrls(cfg, sortKey, limit, { category }), limit);
  }
  return collected;
}

// 关键词搜图基础设施在 pixiv.js（搜索缓存、429重试、标签补全、候选取图）
// 下载基础设施在 downloader.js（CDN镜像、代理回退、临时文件、图片下载、去重源）

/**
 * 这批触发消息里有没有点名机器人。用于"@ 才发图"门控。
 * 判定依据（任一中即算点名）：
 *   - 文本含 @全体成员（@all 覆盖所有人，包括自己）
 *   - 文本含 @<群名片> / @<botName> / @<QQ号>
 *     （消息入库时 @ 段被转成 @群名片，解析失败则回退成 @QQ号，所以三个都查）
 */
export function anyEntryMentionsSelf(entries, { selfNickname, selfId, botName, selfCard } = {}) {
  if (!Array.isArray(entries) || !entries.length) return false;
  // 群聊里 @ 机器人通常用的是「群名片」，而不是机器人名/QQ 昵称/QQ 号。
  // 这里把群名片(selfCard)也纳入目标，避免 @ 名片时门控误判为"没点名"。
  const targets = [selfNickname, botName, selfCard, selfId]
    .map((v) => String(v ?? '').trim())
    .filter(Boolean);
  for (const entry of entries) {
    const text = String(entry?.text ?? '');
    if (!text) continue;
    if (text.includes('@全体成员')) return true;
    if (targets.some((t) => text.includes(`@${t}`))) return true;
  }
  return false;
}

/**
 * 执行一次点图请求。纯逻辑，不接触发送通道。
 * 返回 { outcome: 'ok'|'cooldown'|'blocked'|'disabled'|'no-image', ... }
 *   ok:            { images: [{payload, bytes, mime}], category, label, downgraded }
 *   其余:           { message }，空串表示策略要求静默
 */
export async function runSetuRequest({ cfg, chatKey, requested, keyword, source = defaultSetuSource }) {
  if (!cfg || cfg.enabled === false) return { outcome: 'disabled', message: '发图功能已关闭' };

  // 冷却检查 + 占位必须一步完成（tryBeginSend）：并发第二发在第一发的下载窗口内
  // 就要被挡住。之前"入口查冷却、下载完才 markSent"两步分离，并发请求可穿透冷却连发。
  if (!source.tryBeginSend(cfg.send)) return { outcome: 'cooldown', message: '刚刚已触发发图，冷却中跳过' };
  try {
    return await runSetuRequestGuarded({ cfg, chatKey, requested, keyword, source });
  } finally {
    // 成功路径在内部已 markSent（真正的冷却起点）；被拦/无图/失败只释放占位，不消耗冷却
    source.releaseHold();
  }
}

async function runSetuRequestGuarded({ cfg, chatKey, requested, keyword, source }) {
  if (!isChatAllowed(chatKey, cfg.chatFilter)) {
    return { outcome: 'blocked', message: (cfg.chatFilter && cfg.chatFilter.rejectMessage) || '' };
  }

  const wanted = normalizeCategory(requested);

  // 关键词路径：走 Pixiv 标签搜索（中文关键词自动补全解析成日文标签）。仅在给了非空关键词时启用。
  const kw = String(keyword || '').trim();
  if (kw) return runKeywordSearch({ cfg, source, chatKey, keyword: kw, wanted });

  const resolved = resolveNsfw(chatKey, wanted, { nsfwFilter: cfg.nsfwFilter, send: cfg.send });
  const category = resolved.category;
  if (category === null) return { outcome: 'blocked', message: resolved.reject || '' };

  const allow = category === 'nsfw' ? cfg.send?.nsfwAllowed : cfg.send?.sfwAllowed;
  if (allow === false) return { outcome: 'disabled', message: `${categoryLabel(category)}功能已关闭` };

  const limit = clampCount(cfg.send?.count);
  const label = categoryLabel(category);
  const sortKey = sortKeyFor(cfg.api, category);
  const download = (url) => downloadImage(url, cfg);
  const remember = (url) => source.remember(url, cfg.send?.dedupMaxSize);

  // 按需取图：先只取需要的数量，下载失败才补取。
  //
  // 旧实现无条件多要 3 张（limit + 3）并让 pickBestImages 并发下载
  // max(limit, 4) 张，等于「要 1 张、下 4 张」。这两层冗余都解决不了
  // 真正的网络故障（4 张并发全挂），却让正常路径恒定多付 3 张图的流量
  // 与临时文件。单张图内部本来就有 4 个 CDN 镜像的串行重试（pximgAttempts），
  // 那才是应对单点故障的机制；外层备胎真正覆盖的是「这张图本身没了」
  // （作者删除 / 搜索缓存里的旧 URL），属于少数情况，按需补取即可。
  const picked = [];
  for (let round = 0; round < FETCH_ROUNDS && picked.length < limit; round += 1) {
    const need = limit - picked.length;
    const urls = await fetchFreshUrls(cfg, source, sortKey, need, category);
    if (!urls.length) break;
    const got = await pickBestImages(urls, need, download, () => true, remember);
    picked.push(...got);
    if (got.length < need) continue;   // 本轮有失败，下一轮补取
    break;                             // 取满了
  }

  const images = picked.map((p) => p.got);
  if (!images.length) {
    const message = picked.length < limit && images.length === 0
      ? `${label}图片下载失败了，稍后再试～`
      : `${label}接口暂时拉不到图，稍后再试试吧～`;
    return { outcome: 'no-image', message };
  }

  source.markSent();
  return { outcome: 'ok', category, label, downgraded: category !== wanted, images };
}

/**
 * 关键词搜索 0 条时的诊断：复用 lookup_setu_tag 的查询逻辑，区分不同的原因。
 *
 * 0 条本身有多种原因，处理方式完全不一样，模型拿不到区分就会判断错。
 * 关键词搜图不做 R-18 过滤，所以内容层面只剩「没被收录 / 请求失败」两种；
 * soloOnly 开启时多一档「标签有内容但都是双人/多人图」，
 * femaleOnly 开启时多一档「都含男性角色」，noHorror 同理。
 * 不要笼统提示「可检查 setu.booru.tagMap」：tagMap 命中恰恰说明映射没错，
 * 照那个提示去改只会越改越乱。
 */
export async function diagnoseEmptyResult(cfg, tags, category, lookup = lookupBooruTag, soloOnly = false, femaleOnly = false) {
  const probe = await lookup(cfg, tags, category);

  // ① 请求本身失败（代理没开、图库不可用）：不是内容问题，重试可能有救
  if (probe.reason) {
    return {
      message: `「${tags}」搜索失败了（${probe.reason}），稍后再试～`,
      tip: '图库请求失败，不是没内容。常见原因是代理没开（setu.booru.proxyUrl）或图库暂时不可用。可以换个时间重试，但不要反复重试同一次请求。'
    };
  }

  // ② 标签确实没被索引，改 tagMap 没用
  if (!probe.found) {
    return {
      message: `「${tags}」在图库里没有内容（查了 0 条），换个关键词或确认标签拼写试试吧～`,
      tip: '这个标签本身没被图库收录，不是映射写错，改 tagMap 没用。中文关键词原样搜索（不再自动翻译），系统已尝试过日文标签兜底。返回的 tags 里列了该标签下被收录的真实角色标签，可以从中找正确的写法。查完还是空就如实告诉用户图库里没收录这个角色。'
    };
  }

  // ③ soloOnly 开启：有内容但都是双人/多人图。先看样本里是否真有双人/多人标签，不盲猜。
  if (soloOnly) {
    // 用 config.js 的 MULTI_PERSON_TAGS：局部副本会遮蔽它，且容易漏条目
    const multiInSample = (probe.tags || []).filter((t) => MULTI_PERSON_TAGS.has(String(t).trim().toLowerCase()));
    if (multiInSample.length > 0) {
      return {
        message: `「${tags}」只搜到双人/多人图，没有单人图，换个关键词或关掉「只发单人图」试试～`,
        tip: `这个标签在图库里有内容，样本里确实有双人/多人标签（${multiInSample.join('、')}），被单人图过滤（soloOnly）滤掉了。可以让用户换个只画单人角色的关键词，或者明确要双人/CP 图（用 ×、&、and 等配对写法会自动豁免单人过滤）。不要改 tagMap。`
      };
    }
    // ③ 不成立：样本里没有双人/多人标签，过滤不是原因，落到④
    log(`诊断：「${tags}」有内容但样本无双人标签，soloOnly 不是过滤原因`);
  }

  // ④ femaleOnly 开启：有内容但都含男性角色
  // 实际验证：样本里是否真的有男性角色标签（不盲猜）
  if (femaleOnly) {
    const maleInSample = (probe.tags || []).filter((t) => MALE_CHARACTER_TAGS.has(String(t).trim().toLowerCase()));
    if (maleInSample.length > 0) {
      return {
        message: `「${tags}」只搜到含男性角色的图，被「只搜女角色」过滤掉了，换个关键词或关掉该选项试试～`,
        tip: `这个标签在图库里有内容，样本里确实有男性角色标签（${maleInSample.join('、')}），被女角色过滤（femaleOnly）滤掉了。两种可能：一是这个角色本身就是男性角色（那就只能关掉「只搜女角色」才能发出来），二是这个标签下的图大多是双人/CP 图。不要改 tagMap。`
      };
    }
    // ④ 不成立：样本里没有男性角色标签，过滤不是原因，落到④.5
    log(`诊断：「${tags}」有内容但样本无男性标签，femaleOnly 不是过滤原因`);
  }

  // ④.5 noHorror 开启：有内容但都含恐怖/血腥标签
  // 实际验证：样本里是否真的有恐怖/血腥标签（不盲猜）
  const noHorror = cfg.booru?.noHorror !== false;
  if (noHorror) {
    const horrorInSample = (probe.tags || []).filter((t) => HORROR_TAGS.has(String(t).trim().toLowerCase()));
    if (horrorInSample.length > 0) {
      return {
        message: `「${tags}」搜到的图都是恐怖/血腥内容，被过滤掉了，换个关键词或关掉「过滤恐怖内容」试试～`,
        tip: `这个标签在图库里有内容，样本里确实有恐怖/血腥标签（${horrorInSample.join('、')}），被恐怖内容过滤（noHorror）滤掉了。这个标签下的图大多是恐怖/血腥内容，不适合群聊发送。不要改 tagMap。`
      };
    }
    log(`诊断：「${tags}」有内容但样本无恐怖标签，noHorror 不是过滤原因`);
  }

  // ⑤ R-18/R-15 过滤：nsfwAllowed=false 时过滤 R-18，strictSfw=true 时额外过滤 R-15
  // probe 不含 sanity_level 数据，无法精确验证，但配置开启时这是最可能的原因
  const nsfwOff = cfg.send?.nsfwAllowed === false;
  const strictSfw = cfg.booru?.strictSfw !== false;
  if (nsfwOff || strictSfw) {
    const r18Tip = nsfwOff
      ? (strictSfw ? 'R-18 + R-15 过滤（strictSfw）' : 'R-18 过滤（nsfwAllowed=false）')
      : 'R-15 过滤（strictSfw=true）';
    return {
      message: `「${tags}」搜到的图被「${r18Tip}」过滤了，暂时发不了。换个关键词，或者在配置里关掉 strictSfw/nsfwAllowed 限制试试～`,
      tip: `这个标签在图库里有内容，但所有候选图的分级都是 R-15 或更高（sanity_level≥2），被 R-18/R-15 过滤滤掉了。大多数 Pixiv 图片的 sanity_level≥2（R-15），strictSfw=true 会过滤掉几乎所有内容。建议把 strictSfw 设为 false（只过滤 R-18 不过滤 R-15），或者把 nsfwAllowed 设为 true。`
    };
  }

  // ⑥ 有内容但没发出来，原因不明（去重池 / 下载失败 / 其他过滤）
  return {
    message: `「${tags}」搜到的图暂时发不了（可能刚发过、下载失败、或没通过过滤），换个关键词试试～`,
    tip: '图库里有内容，但候选图没能成功发送。可能原因：去重池（刚发过）、下载失败（原图超时/防盗链）、R-18 过滤（nsfwAllowed=false 时跳过成人内容）、或没通过质量/尺寸过滤。换个关键词试试，或者等一会儿再试。不要反复重试同一个关键词。'
  };
}

/**
 * 关键词搜图（Pixiv 标签搜索，经 PXVE 社区代理）。
 * 与随机池路径共用 nsfwFilter / chatFilter / 冷却 / 去重。
 * nsfwAllowed=false 时过滤 R-18 / R-18G 内容。
 *
 * 中文关键词原样搜索（图库支持中文标签），不做自动翻译。
 * 原样搜索 0 条时可选翻译兜底重试（translateOnEmpty=true，默认开）：
 * 冷门角色的中文标签可能没收录，翻译一次日文标签还能兜住。
 * tagMap 作为快路径保留（命中即返回，不调接口）。
 *
 * 色图/无色图判断：关键词里没有明确色图词（色图/黄的/R-18/福利等）时强制走 sfw。
 * 不信任模型的 category 判断，防止群里误发色图。
 */
async function runKeywordSearch({ cfg, source, chatKey, keyword, wanted }) {
  const booru = cfg.booru || {};
  if (booru.enabled === false) return { outcome: 'disabled', message: '关键词搜图功能已关闭' };

  // 解析标签：tagMap 快路径 → 原样下发（不再自动翻译）
  const tags = await resolveSearchTag(cfg, keyword);
  if (!tags) return { outcome: 'no-image', message: '关键词不能为空～' };

  // 色图/无色图安全兜底：关键词里没有明确色图词时强制 sfw。
  // 模型可能自作主张传 nsfw，但「美图」不该出黄图。
  if (wanted === 'nsfw' && !NSFW_TRIGGER_RE.test(keyword)) {
    log(`「${keyword}」关键词无明确色图词，强制 sfw（模型传的是 nsfw）`);
    wanted = 'sfw';
  }

  // 尺度检查与随机池路径完全一致（同一套 nsfwFilter / allow 判断）
  const resolved = resolveNsfw(chatKey, wanted, { nsfwFilter: cfg.nsfwFilter, send: cfg.send });
  const category = resolved.category;
  if (category === null) return { outcome: 'blocked', message: resolved.reject || '' };
  const allow = category === 'nsfw' ? cfg.send?.nsfwAllowed : cfg.send?.sfwAllowed;
  if (allow === false) return { outcome: 'disabled', message: `${categoryLabel(category)}功能已关闭` };

  const limit = clampCount(cfg.send?.count);
  const minBytes = Number(booru.minImageBytes) > 0 ? Math.trunc(Number(booru.minImageBytes)) : 81920;
  const dlTimeout = Number(booru.downloadTimeoutMs) > 0 ? Math.trunc(Number(booru.downloadTimeoutMs)) : 25000;
  const referer = String(booru.referer || 'https://www.pixiv.net/').trim();
  const proxyUrl = pixivCfg(booru).proxyUrl;
  const label = `关键词图（${keyword}）`;

  // 单人图过滤：默认只发单人图（搜「角色名」时排除双人/多人同框图）。
  // 配对/CP 关键词（含 ×、&、+、and、cp 等）自动豁免，那种请求双人图正是用户要的。
  const soloOnly = booru.soloOnly !== false && !isPairingKeyword(keyword);

  // 女角色过滤：默认只搜女角色，配对/CP 关键词自动豁免。
  const femaleOnly = booru.femaleOnly !== false && !isPairingKeyword(keyword);

  // 恐怖/血腥过滤：配对/CP 关键词也过滤，这类内容不适合任何群聊场景。
  const noHorror = booru.noHorror !== false;

  // 单角色过滤：图片含 2 个以上角色名标签时过滤。配对/CP 关键词自动豁免。
  const singleCharacterOnly = booru.singleCharacterOnly !== false && !isPairingKeyword(keyword);

  // 不过滤 R-18，直接全量取候选 URL（soloOnly 时带 solo 过滤）
  let searchTag = tags;   // 实际用于搜索的标签（翻译兜底后会更新）
  let urls = await fetchBooruCandidates(cfg, source, searchTag, limit, soloOnly, femaleOnly, noHorror, singleCharacterOnly);

  // 原样搜索 0 条 → 如果是中文且开启翻译兜底，试一次日文标签。
  // 条件 tags === keyword 排除了 tagMap 已映射的情况（用户显式配了映射就不该被覆盖）。
  if (!urls.length && booru.translateOnEmpty !== false && hasCJK(keyword) && tags === keyword) {
    const translated = await translateTag(cfg, keyword);
    if (translated && translated !== tags) {
      log(`「${keyword}」原样搜索 0 条，翻译为「${translated}」重试`);
      searchTag = translated;
      urls = await fetchBooruCandidates(cfg, source, searchTag, limit, soloOnly, femaleOnly, noHorror, singleCharacterOnly);
    }
  }

  if (!urls.length) {
    // 诊断用实际搜索的标签（翻译兜底后是日文标签），不用原始中文标签
    const diag = await diagnoseEmptyResult(cfg, searchTag, category, lookupBooruTag, soloOnly, femaleOnly);
    log(`「${keyword}」搜索 0 条（搜索标签=「${searchTag}」），诊断=${diag.message}`);
    return { outcome: 'no-image', keyword, message: diag.message, tip: diag.tip };
  }

  // 从质量最优的候选开始下载，失败自动换下一个（pickBestImages）。
  // 同 host 的节点切换由 downloadImage 内部的 pximgAttempts 负责，这里不再单独维护 deadHosts。
  const picked = await pickBestImages(
    urls,
    limit,
    (url) => downloadImage(url, cfg, { referer, timeoutMs: dlTimeout, proxy: proxyUrl }),
    (got) => got.bytes >= minBytes,
    (url) => source.remember(url, cfg.send?.dedupMaxSize)
  );
  const images = picked.map((p) => p.got);
  log(`「${keyword}」下载完成：候选=${urls.length} 成功=${images.length} 目标=${limit}`);
  // 记录已发送图片的 Pixiv 作品 ID，方便用户排查标签
  const sentIds = picked.map((p) => pixivArtworkId(p.url)).filter(Boolean);
  if (sentIds.length > 0) {
    log(`「${keyword}」已发送 Pixiv 作品 ID: ${sentIds.join(', ')}`);
  }
  if (!images.length) return { outcome: 'no-image', message: `「${keyword}」搜到了但图片都没能下载下来，稍后再试～` };

  source.markSent();
  const downgraded = category !== wanted;
  const nsfwOff = cfg.send?.nsfwAllowed === false;
  const strictSfw = cfg.booru?.strictSfw !== false;
  const r18Tip = nsfwOff
    ? (strictSfw ? '，已过滤 R-18/R-18G/R-15 内容' : '，已过滤 R-18/R-18G 内容')
    : '，未过滤 R-18 内容';
  const tip = downgraded
    ? '（用户要的是色图但本会话不允许，可以顺口提一句本会话限制）'
    : `（关键词搜图来自 Pixiv 标签库${r18Tip}）`
    + (soloOnly ? '（已过滤双人/多人图，只发单人图）' : '');
  return { outcome: 'ok', category, label, keyword, downgraded, tip, images };
}

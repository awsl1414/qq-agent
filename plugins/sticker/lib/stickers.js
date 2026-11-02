// 表情包体系：本地表情知识库 + 搜索 + 提示词摘要。
// QQ 收藏表情（SnowLuma fetch_custom_face_detail）是"源"，本地库是 AI 认知层。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';

const STICKER_FILE = path.join(DATA_DIR, 'stickers.json');
/** 隐藏（软删除）名单。见 HIDDEN_FILE 上方的说明与 isHidden/visibleEntries。 */
const HIDDEN_FILE = path.join(DATA_DIR, 'stickers-hidden.json');

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeStickerEntry(raw) {
  const entry = raw && typeof raw === 'object' ? raw : {};
  const id = String(entry.id || entry.emoji_id || entry.resId || '').trim();
  if (!id) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((t) => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
    : [];
  return {
    id,
    resId: String(entry.resId || entry.emoji_id || id).trim(),
    url: String(entry.url || '').trim(),
    // 本地转存的真实路径（file:///）。以前这个字段只活在内存里、没进
    // normalizeStickerEntry，所以 saveStickerStore → loadStickerStore 一轮就没了 ——
    // 于是下一轮同步又得重新下载。现在落盘，D2（本地缓存被远端 url 覆盖）才有得救。
    localFile: String(entry.localFile ?? '').trim(),
    md5: String(entry.md5 || '').trim().toUpperCase(),
    desc: String(entry.desc ?? '').trim(),
    localNote: String(entry.localNote ?? '').trim(),
    tags,
    usage: String(entry.usage ?? '').trim(),
    source: entry.source === 'manual' ? 'manual' : (entry.source === 'ai' ? 'ai' : 'qq'),
    useCount: Math.max(0, Number(entry.useCount) || 0),
    lastUsedAt: Number(entry.lastUsedAt) || 0,
    lastContext: String(entry.lastContext ?? '').slice(0, 200),
    createdAt: String(entry.createdAt || nowIso()),
    updatedAt: String(entry.updatedAt || nowIso())
  };
}

export function loadStickerStore(file = STICKER_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStickerEntry).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveStickerStore(entries, file = STICKER_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── 隐藏名单（软删除）────────────────────────────────────────────────────────
//
// 为什么"删除"必须是软删除（R130）：
//   QQ 收藏是**源**，`stickers.json` 只是它的镜像。同步每 60 秒跑一次，
//   `mergeStickerLibrary` 会把远端还存在的表情原样加回来 —— 所以从数组里
//   物理删掉一个 qq 源条目，它 ≤60 秒后必定复活，变成一个"删了又自己回来"的
//   玄学 bug。正确做法是**留着条目、只把它从"可见集合"里摘出去**。
//
//   附带两个好处：① 删除可逆（`restore` 只是把 id 从名单里划掉）；
//   ② 误删不会连带丢掉备注、标签、使用次数和本地图片。
//
// 为什么单独一个文件、不塞进 stickers.json：
//   stickers.json 是**数组**，没有放元数据的位置；改成对象会动到
//   `loadStickerStore` 的 `Array.isArray` 判断，波及面太大。独立文件
//   还方便以后跟导出/导入（备份）一起打包带走。
//
// 为什么不用 api.storage：storage 语义上是"给页面看的数据"，且已经被
//   查看器快照占用；隐藏名单是**库数据**，跟 stickers.json 同类，该放一起。

/**
 * @param {string} [file]
 * @returns {Set<string>} 被隐藏的表情 id
 */
export function loadHiddenSet(file = HIDDEN_FILE) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    const ids = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.hidden) ? parsed.hidden : []);
    return new Set(ids.map((x) => String(x ?? '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

/** @returns {number} 落盘的 id 条数 */
export function saveHiddenSet(ids, file = HIDDEN_FILE) {
  const list = [...(ids instanceof Set ? ids : new Set(Array.isArray(ids) ? ids : []))]
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
    .sort();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, hidden: list }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  return list.length;
}

/** 某个条目当前是不是被隐藏了（id 或 resId 任一命中即算）。 */
export function isHidden(entry, hidden) {
  if (!(hidden instanceof Set) || !hidden.size || !entry) return false;
  return hidden.has(String(entry.id ?? '').trim()) || hidden.has(String(entry.resId ?? '').trim());
}

/**
 * 取"可见"的那部分库。所有消费点（提示词 / list 工具 / 查看器快照 / 发送）
 * 都必须走这里，否则隐藏就只是半吊子。
 *
 * ⚠️ 注意传进来的 entries 是**完整库**（含隐藏项）—— 隐藏名单单独维护，
 *    库本身不动，这样"取消隐藏"才能把备注/标签/使用次数原样带回来。
 */
export function visibleEntries(entries, hidden) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  if (!(hidden instanceof Set) || !hidden.size) return list;
  return list.filter((e) => !isHidden(e, hidden));
}

/**
 * 这次拉取结果是不是"完整的一份"—— 即**可以据此剪枝**。
 *
 * 为什么必须有这个判据（2026-10-15 R129 修）：
 *   `fetch_custom_face_detail` 返回的是**前 N 条**，N = 我们请求的 count。
 *   旧实现拿这个列表当"全部收藏"直接剪枝：
 *
 *       out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id))
 *
 *   于是只要用户收藏数 > 请求的 count，第 count+1 张之后的表情每次同步都会被
 *   当"已经不在收藏里了"删掉 —— 连带备注、标签、使用次数一起永久丢失。
 *   而默认 count = promptMaxStickers(10) × 10 = **100**，所以超过 100 张的用户
 *   每次同步都在稳定丢数据（查看器页面会如实显示"只剩 100 张"）。
 *
 *   判据：**没拿满**（got < asked）才能证明服务端已经把收藏给完了。
 *   拿满 count 条说明后面还有，此时"不在列表里"只等于"没翻到"，不等于"被删了"。
 *
 *   空结果单独判、且**一律不剪**：`[]` 既可能是"用户真的清空了收藏"，也可能是
 *   瞬时抖动（协议端超时/降级返回空数组，而 `Array.isArray([])` 会把它当成功）。
 *   后者被当成完整列表 = 一次性抹掉整个本地库。代价不对称，所以宁可留残留。
 *
 * @param {number} fetchedCount   本次拿到的条数
 * @param {number} requestedCount 本次请求的条数（= count）
 * @returns {boolean} true 才允许剪枝
 */
export function isStickerFetchComplete(fetchedCount, requestedCount) {
  const got = Number(fetchedCount) || 0;
  const asked = Number(requestedCount) || 0;
  if (got <= 0) return false;    // 空结果不可信（可能只是抖动）
  if (asked <= 0) return false;  // 没记请求量，无从判断
  return got < asked;            // 没拿满 → 服务端已经到底了
}

/**
 * 合并远端收藏与本地库。
 *
 * ⚠️ 剪枝**默认关闭**（`opts.prune !== true` 就只合并不删除）。
 *    这个默认值是刻意的：本函数被误用一次的代价是用户永久丢失表情库，
 *    所以"删除"必须由调用方显式、且基于 isStickerFetchComplete 的证据来要求。
 *
 * @param {Array} existing 本地库
 * @param {Array} fetched  协议端返回的收藏（可能是被截断的一页）
 * @param {{prune?: boolean}} [opts] prune=true 才删除"确认已不在收藏里"的条目
 */
export function mergeStickerLibrary(existing, fetched, opts = {}) {
  const out = existing.map(normalizeStickerEntry).filter(Boolean);
  const byId = new Map(out.map((e) => [e.id, e]));
  const fetchedIds = new Set();
  for (const item of Array.isArray(fetched) ? fetched : []) {
    const id = String(item?.emoji_id || item?.resId || item?.id || '').trim();
    if (id) fetchedIds.add(id);
  }
  for (const item of Array.isArray(fetched) ? fetched : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.emoji_id || item.resId || item.id || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const merged = normalizeStickerEntry({
      ...(old || {}),
      id,
      resId: String(item.resId || item.emoji_id || id).trim(),
      url: String(item.url || old?.url || '').trim(),
      md5: String(item.md5 || old?.md5 || '').trim().toUpperCase(),
      desc: String(item.desc ?? old?.desc ?? '').trim(),
      localNote: old?.localNote || '',
      tags: old?.tags || [],
      usage: old?.usage || '',
      source: old?.source || 'qq',
      useCount: old?.useCount || 0,
      lastUsedAt: old?.lastUsedAt || 0,
      lastContext: old?.lastContext || '',
      createdAt: old?.createdAt || nowIso(),
      updatedAt: nowIso()
    });
    if (!merged) continue;
    if (!byId.has(id)) {
      out.push(merged);
      byId.set(id, merged);
    } else {
      const idx = out.findIndex((e) => e.id === id);
      if (idx >= 0) out[idx] = merged;
    }
  }
  // 默认不删。理由见函数头注释与 isStickerFetchComplete。
  if (opts.prune !== true) return out;
  // 只删 qq 来源的：manual / ai 是本地加的，不该被远端列表的存在与否决定去留。
  return out.filter((e) => e.source !== 'qq' || fetchedIds.has(e.id));
}

export function findSticker(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  const urlNormalized = raw.replace(/\/+$/, '').replace(/^https?:\/\//i, '');
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    const eUrl = String(e.url || '').replace(/\/+$/, '').replace(/^https?:\/\//i, '');
    if (eUrl && urlNormalized && (eUrl === urlNormalized || eUrl.includes(urlNormalized) || urlNormalized.includes(eUrl))) return true;
    return false;
  }) || null;
}

/**
 * **精确**查找：只认 id / resId / md5 的完整相等，不走 url 子串兜底。
 *
 * 为什么要有两个版本（R130 修）：
 *   `findSticker` 的 url 兜底是 `includes` 双向匹配，本来是给"模型手抄了半截
 *   url"兜底的，放在**查询**上无伤大雅。但把它用在**破坏性操作**上就会出事：
 *   传一个不存在的 id，只要它恰好是某个表情 url 的子串，就会命中那张表情 ——
 *   实测 `hide('abcdef123')` 能把 url 里含 `abcdef123` 的表情删掉。
 *   所以 hide / unhide / 删除前的存在性校验一律走这里。
 */
export function findStickerExact(entries, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) return null;
  const md5 = raw.toUpperCase();
  return (Array.isArray(entries) ? entries : []).find((e) => {
    if (!e) return false;
    if (e.id === raw || e.resId === raw) return true;
    if (e.md5 && e.md5 === md5) return true;
    return false;
  }) || null;
}

export function formatStickerList(entries, query = '', limit = 48, opts = {}) {
  const list = visibleEntries(entries, opts.hidden);
  const q = String(query ?? '').trim().toLowerCase();
  const filtered = q
    ? list.filter((e) => {
        const haystack = [e.desc, e.localNote, e.usage, e.id, e.resId, e.md5, ...(e.tags || [])].join(' ').toLowerCase();
        return haystack.includes(q);
      })
    : list;
  const max = Math.max(1, Math.min(500, Number(limit) || 48));
  const items = filtered.slice(0, max).map((e) => ({
    id: e.id,
    desc: e.desc || '',
    localNote: e.localNote || '',
    tags: e.tags || [],
    useCount: e.useCount || 0
  }));
  return { total: list.length, matched: filtered.length, truncated: filtered.length > max, stickers: items };
}

/**
 * 查看器页面用的只读快照（plugins/sticker/panel/viewer.html）。
 *
 * 为什么不直接把 stickers.json 交给页面：页面跑在设置弹窗的 iframe 里，它只有
 * `/plugin-panel/<id>/@data/`（= `plugin-data/<id>/`）这一条只读通道，读不到
 * `<DATA_DIR>/stickers.json`。而 `api.storage` 本来就是插件已有的能力 ——
 * 把页面要的数据写进去、页面 fetch 出来即可，宿主不需要为此新增任何接口。
 *
 * ⚠️ 两条硬约束：
 *   ① storage 有 **1MB 上限**（src/plugin-loader.js 的 SKILL_STORAGE_MAX_BYTES）
 *      → 只带页面真正要用的字段，绝不内联图片（100 张 base64 就爆了）；
 *   ② 每次收藏同步后都会重写 → 这里必须是纯函数、别做 IO。
 *
 * `img` 交给页面自己解析：http(s) 原样用；空串 = 显示不了，画占位。
 * 什么情况会是空串：`file:///` 形态。那是"发送前临时转存"的中间态 ——
 * 下一次收藏同步就会被远端地址覆盖（见 mergeStickerLibrary 的 `item.url ||`），
 * 而且浏览器也读不了 file:///，所以不假装能显示。
 */
export function buildViewSnapshot(entries, meta = {}) {
  // ⚠️ 这里**保留**被隐藏的条目（打 `hidden: true` 标记），不做过滤。
  //    跟提示词/list 工具相反，是刻意的：查看器是唯一能让用户看到"我删过什么"
  //    并找回 id 去取消隐藏的地方。页面侧用筛选 chip 把它们默认挡掉。
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const hiddenSet = meta.hidden instanceof Set ? meta.hidden : null;
  // 本地转存的图浏览器读不了 file:///，靠 manager 复制一份到 plugin-data 下的
  // 缩略图目录，由这里换成 ../@data/img/xxx 的相对地址（见 manager.materializeThumbs）。
  // 没有缩略图（复制失败 / 坏文件）才退回空串画占位。
  const thumbs = (meta.thumbs && typeof meta.thumbs.get === 'function') ? meta.thumbs : null;
  const items = list.map((e) => {
    const url = String(e.url || '').trim();
    const isLocal = url.toLowerCase().startsWith('file:///');
    const thumb = isLocal && thumbs ? String(thumbs.get(e.id) || '').trim() : '';
    return {
      id: e.id,
      img: isLocal ? (thumb || '') : url,
      local: isLocal,
      hidden: isHidden(e, hiddenSet),
      desc: e.desc || '',
      note: e.localNote || '',
      tags: Array.isArray(e.tags) ? e.tags : [],
      usage: e.usage || '',
      source: e.source || 'qq',
      useCount: e.useCount || 0,
      lastUsedAt: e.lastUsedAt || 0,
      updatedAt: e.updatedAt || ''
    };
  });
  const hiddenCount = items.filter((x) => x.hidden).length;
  return {
    v: 1,
    at: nowIso(),
    total: items.length - hiddenCount,
    // 已隐藏条数。页头单独显示，让用户知道"库里还有 N 张被我删了、可以恢复"。
    hidden: hiddenCount,
    // 两个给页头直接用的计数，省得页面自己遍历（也保证口径与这里一致）。
    // ⚠️ 口径要跟 total 一致：都排除已隐藏的，否则页头会出现"共 100、有备注 110"。
    annotated: items.filter((x) => !x.hidden && (x.note || x.desc)).length,
    used: items.filter((x) => !x.hidden && x.useCount > 0).length,
    syncedAt: Number(meta.syncedAt) || 0,
    error: String(meta.error || ''),
    settings: (meta.settings && typeof meta.settings === 'object') ? meta.settings : {},
    items
  };
}

function compareCodePointAsc(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa < sb ? -1 : (sa > sb ? 1 : 0);
}

/**
 * 提示词里的【可用表情包】摘要（不暴露完整 URL，控制上下文体积）。
 * rotatePeriodMin <= 0 时关闭轮换；now 仅用于测试注入稳定的轮次。
 * withId 未显式设置时，max <= 15 才附带 id，避免提示词无谓膨胀。
 */
export function buildStickerContext(entries, max = 10, { rotatePeriodMin = 60, now = Date.now(), withId = Number(max) <= 15, listTool = 'list_stickers', hidden = null } = {}) {
  const list = visibleEntries(entries, hidden);
  if (!list.length) return '';
  const total = Math.max(1, Math.min(30, Number(max) || 10));
  const byUse = [...list].sort((a, b) =>
    ((b.desc || b.localNote) ? 1 : 0) - ((a.desc || a.localNote) ? 1 : 0)
    || compareCodePointAsc(a.id, b.id)
  );
  let selected = byUse.slice(0, total);

  if (Number(rotatePeriodMin) > 0 && list.length > total) {
    const stableCount = Math.max(1, Math.floor(total / 2));
    const stable = byUse.slice(0, stableCount);
    const stableIds = new Set(stable.map((e) => e.id));
    const pool = [...list].filter((e) => !stableIds.has(e.id)).sort((a, b) => compareCodePointAsc(a.id, b.id));
    const period = Number(rotatePeriodMin) * 60000;
    const round = Math.floor(Number(now) / period);
    let seed = round >>> 0;
    for (const e of pool) for (const ch of e.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    if (seed === 0) seed = 0x9e3779b9;
    const shuffled = [...pool];
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    selected = [...stable, ...shuffled.slice(0, total - stableCount)];
  }

  const lines = selected.map((e) => {
    const label = e.desc || e.localNote || '（无备注，可先看图）';
    const extra = e.tags?.length ? ` [${e.tags.join('/')}]` : '';
    const id = withId ? ` id=${e.id}` : '';
    return `- ${label}${extra}${id}`;
  });
  return `【可用表情包】你的 QQ 收藏表情里有 ${list.length} 个表情（以下是其中 ${selected.length} 个，完整列表可用 ${listTool} 查询）：\n${lines.join('\n')}`;
}

/**
 * 发送前的表情包策略提示（软策略）。
 *
 * @param {number} level 0~3 活跃度档位
 * @param {{send?:string,list?:string,image?:string,text?:string}} names
 *        实际工具名（插件注册后会被宿主加上 `<skillId>__` 前缀，
 *        所以这里必须用真实名字，不能让模型去猜）。
 */

/**
 * 容量档：库里有几张，决定"该不该鼓励发表情"。
 *
 * 为什么需要（2026-10-21）：策略档位是用户配的固定值（默认 3 = 尽量配），
 * 而库里可能一张都没有。档位与能力脱钩会直接产出空头支票：
 *   · 0 张：模型按"爱好者"人设承诺"等我甩图"，然后无图可发（实测 3/6 被 @ 都这样）
 *   · 1 张：连续两轮发同一张（实测 21:33:33 / 21:34:33）
 * 取 min(配置档, 容量档)：用户想低调就低调，想高调也高不过库存。
 *
 * @param {number} configured 用户配置档 0~3
 * @param {number|null} count 当前库条目数；null/undefined = 读不到，按配置档走
 */

/**
 * 容量档的**原始档位**（不掺用户配置）：0 张 → 0，1–3 张 → 1，4–9 张 → 2，10+ 张 → 3。
 *
 * 从 capacityLevel 拆出来（2026-10-23）：提示词段要先对原始档做降档滞回
 * （smoothCapDowngrade）再与用户配置取 min，没有这个出口就只能整函数复制一份。
 *
 * @param {number|null|undefined} count 库存张数；null/undefined/非数字 = 读不到
 * @returns {number|null} 0~3；读不到返回 null（调用方按"不擅自降档"处理）
 */
export function capacityCap(count) {
  // ⚠️ 必须显式判 null：Number(null) === 0，会把"读不到库存"误当成"库存为 0"。
  if (count === null || count === undefined) return null;
  const n = Number(count);
  if (!Number.isFinite(n)) return null;
  return n <= 0 ? 0 : n <= 3 ? 1 : n <= 9 ? 2 : 3;
}

export function capacityLevel(configured, count) {
  const want = Math.min(3, Math.max(0, Number(configured) || 0));
  const cap = capacityCap(count);
  if (cap === null) return want;             // 读不到库存：不擅自降档
  return Math.min(want, cap);
}

// ── 提示词段滞回（2026-10-23，识图场景缓存稳定化）─────────────────────────
//
// 为什么需要：本插件有两段内容随**库存实时变化**翻字，而两段都压在前缀缓存的
// 命脉位置上 ——
//   · 【表情包策略】段进**系统提示**（promptSections）。档位每翻一次（库存越过
//     0/4/10 三个边界）整段换字，而系统提示在整条请求的最前面，其后是 tools 与
//     全部消息 ⇒ 整条前缀击穿。实测单次 miss 8898 / 9348 tok（命中 22% / 21%），
//     两次都发生在"识图 → 收藏表情"之后几分钟内。
//   · 【可用表情包】段插在用户提示的【过去状态】**之前**（可缓存区）。每张新表情
//     让段长 +54~64B，其后整个历史窗口重算。实测一天 7 次、合计 14284B 全价，
//     其中 6 次挤在 00:03–00:06 的收藏风暴里。
// 用户在手机上取消收藏又收藏回来（或一次同步拿到不完整快照）会让库存瞬时跌到
// 边界另一侧；一次收藏风暴会让列表段连翻多次。两者都不该按整条前缀的代价计费。
//
// 修法两个，原则都是"该变的一次不少，不该变的一次不多"：
//   ① smoothCapDowngrade —— 策略档位**降档滞回**：升级立即生效（库变大是模型
//      该知道的好事），降档要持续低于边界满宽限才落地（默认 10 分钟）。
//      手机端"取消-收藏"抖动被折叠成零次翻字。
//   ② planSectionRender —— 列表段**最小刷新间隔**：内容没变原样返回；空库↔非空
//      翻转算紧急（行为关键，且一生只一次）立即生效；其余变化按间隔节流
//      （默认 3 分钟），收藏风暴从 6 次翻字折叠成 1~2 次。清单本就只是
//      "存在性提示"（完整列表模型随时可用 list_stickers 查），几分钟陈旧不伤功能。

/**
 * 策略档位降档滞回（纯函数，无 IO）。
 *
 * @param {{cap:number, pendingCap:number|null, pendingSince:number}|null} state 上次状态（null=首次）
 * @param {number|null|undefined} newCap 本次原始容量档（null=读不到库存）
 * @param {number} now 当前时间 ms
 * @param {number} graceMs 降档需持续满足的宽限 ms
 * @returns {{cap:number, pendingCap:number|null, pendingSince:number}} 新状态（cap=生效档位）
 */
export function smoothCapDowngrade(state, newCap, now, graceMs) {
  const cur = state && Number.isFinite(state.cap) ? state : null;
  // 读不到库存：原样保留（连观察期一起），调用方按"用上次生效档"处理 ——
  // 与 capacityLevel 的"不擅自降档"同向，但比它多记住最后一次真数。
  if (newCap === null || newCap === undefined) {
    return cur || { cap: 0, pendingCap: null, pendingSince: 0 };
  }
  const n = Math.min(3, Math.max(0, Number(newCap) || 0));
  if (!cur) return { cap: n, pendingCap: null, pendingSince: 0 };        // 首次：直接采用
  if (n >= cur.cap) return { cap: n, pendingCap: null, pendingSince: 0 }; // 升级/持平：立即生效
  // 降档候选：同一档位持续满宽限才落地；中途涨回去则观察期作废（pendingSince 归零重计）
  if (cur.pendingCap === n && now - (Number(cur.pendingSince) || now) >= graceMs) {
    return { cap: n, pendingCap: null, pendingSince: 0 };
  }
  return {
    cap: cur.cap,
    pendingCap: n,
    pendingSince: cur.pendingCap === n ? (Number(cur.pendingSince) || now) : now
  };
}

/**
 * 提示词段的渲染计划（纯函数，无 IO）：决定"这一轮注入新文本还是继续用旧文本"。
 *
 * @param {{text:string, at:number}|null} prev 上次**注入**的文本与渲染时间（null=首次）
 * @param {string} next 本次算出的文本
 * @param {number} now 当前时间 ms
 * @param {number} intervalMs 非紧急变化的最小刷新间隔 ms
 * @param {boolean} [urgent=false] 是否紧急（如空库↔非空翻转）：紧急立即生效
 * @returns {{text:string, at:number, rendered:boolean}} text=本轮应注入的文本；
 *          rendered=本次是否发生了真实翻字（供调用方打日志/推进状态）
 */
export function planSectionRender(prev, next, now, intervalMs, urgent = false) {
  const nextText = String(next ?? '');
  if (!prev) return { text: nextText, at: now, rendered: true };
  if (prev.text === nextText) return { text: nextText, at: prev.at, rendered: false }; // 没变
  if (urgent || now - (Number(prev.at) || now) >= intervalMs) {
    return { text: nextText, at: now, rendered: true };
  }
  // 节流期内：继续注入旧文本，at 不推进（间隔从上次真实渲染起算，不是从上次请求起算）
  return { text: prev.text, at: prev.at, rendered: false };
}

/**
 * 表情策略段。level 决定频率那一行；opts.empty=true 时整段换成"现在没表情"的版本
 * （不是把频率调到最低，而是明确禁止承诺——空库时"少发一点"仍然是空头支票）。
 */
export function buildStickerStrategyHint(level = 1, names = {}, opts = {}) {
  const T = {
    send: names.send || 'send_sticker',
    list: names.list || 'list_stickers',
    image: names.image || 'get_sticker_image',
    text: names.text || 'send_message',
    // 2026-10-19：策略段此前**只字未提收藏**——模型面对「帮我收藏这个表情」
    // 只会嘴炮答应，从不调 collect_sticker（实测 60 个会话 0 次调用、库里
    // 0 条 AI 收藏，而 send_sticker 59/60 在用——差距就是引导）。模型的行为
    // 靠这段每轮可见的策略文本驱动，工具描述只在工具列表里，管不到触发时机。
    collect: names.collect || 'collect_sticker'
  };

  // 空库专用文案：此时"鼓励发表情"是纯负债
  if (opts.empty === true) {
    return [
      '【表情包策略：暂时没有可用表情】',
      '- 你的收藏表情库现在是**空的**，没有任何一张可以发。**不要承诺发表情**（别说"等我甩图""给你配个表情"），承诺了也做不到。',
      // P2（2026-10-22）：空库是最需要"主动收"的时刻，文案从"等指令"改成"看到就收"。
      `- 看到群友发的好玩的图/表情就**主动**用 ${T.collect} 收下来（填那条消息前的 #数字），不用等他说「收藏 / 存下来」；拿不准图里画的是什么时才先用 ${T.image} 看一眼。**三样一起填**：note（画的是什么、什么情绪）、tags（2~4 个短标签）、usage（什么场合用）；收藏成功的下次就能直接发。`,
      `- 纯文字回应完全没问题，正常用 ${T.text} 说话即可。`
    ].join('\n');
  }

  const lvl = Math.min(3, Math.max(0, Number(level) || 0));
  const freqByLevel = [
    '表情包是备选项，不勉强；纯文字回应完全没问题。',
    '频率：普通闲聊不用每条都配；大约每 3~5 轮来一张就够，热闹/玩梗时可以更密，但不要连续刷屏。',
    '频率：回应、吐槽、接梗时优先考虑配一个贴切的表情，让对话更有活人感；别每次都用同一张。',
    '频率：你是表情包爱好者——能配表情的地方尽量配，接梗/调侃/附和时几乎都会带一张，聊天要有表情包的烟火气；注意换着用，不要连发同一张。'
  ][lvl];
  // ⚠️ 2026-10-22 P1：频率行只管"多密"，管不到"这种句子该配"。实测近 24 小时 149 条
  //    ≤10 字的纯反应（"确实""乐了""认了"）一条表情都没配，而这类短反应恰恰是真人最爱
  //    配图的场景 —— 所以单独给一条硬指引，并把 10-21 的"必须同批"规则在这里复述一遍
  //    （收尾机制 autoEndAfterSend 会吃掉第二轮，说了不做等于没做）。
  //    仅在有效档位 ≥2 时出现：0/1 档是用户明确要"少发"，硬推会与频率行自相矛盾。
  //    ⚠️ 2026-10-23 更正：这里原注释写"档位是稳定的配置值（不一定变），所以这一行
  //    有/无不会跨轮抖动" —— **实测被推翻**。档位是 min(配置档, 库存档)，库存跨 4/10
  //    边界就会翻；00:03:52 的缓存断点正好落在本行（body-lcp 附近文本 = 本句），
  //    单次代价 7141 字全价。现在本段已标 volatile，翻字不再击穿系统提示前缀。
  const shortReplyHint = lvl >= 2
    ? `- 短回应：≤10 字的纯反应（"确实""乐了""认了""绷不住了"这一类附和/吐槽/无语）**优先配一张表情**，就在同一次回复里同时调用 ${T.text} 和 ${T.send}，别只回一句干巴巴的文字。`
    : null;
  return [
    '【表情包策略：像真人一样用，不刷屏】',
    '- 合适时机：被戳中笑点/槽点、接梗、怼人、赞同、自嘲、安慰、无语、赢了/输了、告别/晚安、别人发了表情时回一张，都可以自然用。',
    `- ${freqByLevel}`,
    shortReplyHint,
    `- 选择：优先用备注（desc）和你的记忆（localNote/tags）能准确对上语境的；没有备注/不确定的表情，先 ${T.image} 看图再决定，不要瞎发。`,
    // ⚠️ 2026-10-21 修：原文写的是"想说的话先用 send_message 作为单独气泡发出，再单独发表情"，
    //    字面鼓励了**分两轮**。而编排器在"纯发送批"之后会立即收尾（autoEndAfterSend），
    //    第二轮根本不存在 —— 分两轮 = 表情永远发不出去（实测 1 轮同批发才成功 2/2）。
    `- 发送：用 ${T.send}。**要文字+表情时，在同一次回复里同时调用 ${T.text} 和 ${T.send}**（两个工具一起发），不要分成两轮——分成两轮的话第一轮发完就收尾了，表情永远发不出去。一条消息只能是一张表情，文字和表情不能混在同一个气泡里。`,
    // ⚠️ 2026-10-22 P2：收藏从"被动响应指令"改成"看到合适的就主动收"。旧文案只在
    //    「用户让你收藏」时才引导，实测近 24 小时群里过了 70 张图、只入库 5 张 ——
    //    库长不大，capacityLevel() 就永远把档位压在 2（≤9 张最高 2 档），形成闭环。
    //    看图确认降级为可选步骤（只在拿不准图意时用），note/tags/usage 三件套仍必须填全。
    //    护栏仍是 maxCollectPerHour（10 次/小时），不写进提示词以免变成运行时变量。
    `- 收藏：群友发了有意思的图/表情就**主动**用 ${T.collect} 收下来（填那条消息的 #数字），不用等他开口说「收藏 / 存下来 / 记住这个梗」；只有拿不准图里画的是什么、或者想不出什么场合该用时，才先用 ${T.image} 看一眼。收的时候把**三样一起填全**：note（画的是什么、什么情绪，20 字内）、tags（2~4 个短标签，如"无语/翻白眼/懒得理"——它们会进你的表情候选列表，下次挑表情就靠它）、usage（什么场合该用，如"被噎住/不想接话/敷衍"）。别见一张收一张，挑真用得上的；描述填得准，下次才挑得到、用得对，别只回一句"收了"就算。`,
    '- 不要：在严肃/正式/敏感话题硬塞表情；不要每次都用同一个；不要一条消息里塞多个表情；不要把文字和表情混在同一个气泡里。'
  ].filter(Boolean).join('\n');
}

export function applyStickerNote(entries, id, patch = {}) {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    localNote: patch.note !== undefined ? String(patch.note ?? '').trim() : target.localNote,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : target.tags,
    usage: patch.usage !== undefined ? String(patch.usage ?? '').trim() : target.usage,
    source: patch.source || target.source || 'ai',
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

export function markStickerUsed(entries, id, context = '') {
  const list = (Array.isArray(entries) ? entries : []).map(normalizeStickerEntry).filter(Boolean);
  const target = findSticker(list, id);
  if (!target) return { entries: list, entry: null };
  const idx = list.findIndex((e) => e.id === target.id);
  const next = normalizeStickerEntry({
    ...target,
    useCount: (target.useCount || 0) + 1,
    lastUsedAt: Date.now(),
    lastContext: String(context || '').slice(0, 200),
    updatedAt: nowIso()
  });
  if (!next) return { entries: list, entry: null };
  list[idx] = next;
  return { entries: list, entry: next };
}

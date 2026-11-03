// 表情系统（确定性型 / plugins/sticker/）
//
// 把宿主原先硬编码在 src 里的整套表情包功能（库 / 同步 / 提示词 / 工具 / 设置）
// 搬成一个独立的内置插件，宿主只保留两个通用能力（api.qqCall / api.sendSticker
// 的能力位），任何插件都能复用。
//
// 职责：
//   · 表情库：QQ 收藏同步（fetch_custom_face_detail）+ 本地认知层（备注/标签/计数）
//   · 提示词：策略段（软引导，按积极程度档位改写频率行）+ 每轮可用表情列表
//   · 工具：send_sticker / list_stickers / get_sticker_image / note / collect_sticker
//   · 界面：panel/viewer.html，表情库查看器，经 configSchema 的 type:'action'
//           按钮打开。宿主把它只读挂在 /plugin-panel/sticker/ 下；那条通道的
//           完整契约（路径规则 / 白名单扩展名 / CSP / 数据通道）见 src/skills/panel.js。
//           页面里用的是相对路径（`../@data/storage.json`），所以整份 panel/
//           目录可以原样复制给别的插件用，不必改 id。
//
// 与宿主的边界：
//   读：settings（api.config）、ctx.sender / ctx.store / ctx.chatKey（工具执行上下文）
//   写：QQ 收藏同步用 api.qqCall('fetch_custom_face_detail')（需 qq_sticker 权限）
//       发送表情用 ctx.sender.sendSticker（宿主 SendQueue，带三级回退）
//   数据：沿用宿主数据根（DATA_DIR）下的 stickers.json 与 sticker-images/，
//         与旧版完全同一份文件，卸载/关闭插件不丢已收藏的表情。
//         另外把一份"页面用"的只读快照写进 api.storage（见 buildViewSnapshot），
//         页面只有 plugin-data/<id>/ 这条通道，读不到 stickers.json。
//
// 工具名会被宿主加上 `<skillId>__` 前缀（如 sticker__send_sticker），
// 所以策略段里引用工具名必须用注册后返回的真实 id，不能让模型去猜。
import { validateImageUrl } from '../../src/safe-fetch.js';
import { downloadImageAsDataUrl, getImagePartsOrVideo } from '../../src/tools.js';
import { StickerManager, localStickerPath } from './lib/manager.js';
import { buildStickerContext, buildStickerStrategyHint, buildViewSnapshot, capacityCap, capacityLevel, planSectionRender, smoothCapDowngrade } from './lib/stickers.js';

/** 出厂默认（与 plugin.json 的 settings 一致，改一处要改两处）。
 *  encourage 默认 3：用户大量反馈"表情包发送概率太低"，
 *  把默认档位提到最高（3 · 表情包爱好者：能配的地方尽量配）。 */
const DEFAULTS = {
  enabled: true,
  encourage: 3,
  promptMaxStickers: 10,
  // 已废弃：本段现在注入到【过去状态】之前的可缓存前缀，
  // 任何内容变化都会连累其后的整个历史块重新计费。钩子里已硬编码 rotatePeriodMin:0
  // 强制关闭轮换，此默认值仅保留以兼容旧配置文件，不再被读取。
  rotatePeriodMin: 0,
  collectEnabled: true,
  maxCollectPerHour: 10
};

let api = null;
let manager = null;
let timer = null;
/** 冷启动是否已经"等过一次"首次收藏同步（只等一次，之后一律用内存快照）。 */
let coldSynced = false;
/** 上次写查看器快照时"库长什么样"（见 snapshotSignature）。 */
let snapshotSig = '';
// ── 提示词段滞回状态（识图场景缓存稳定化）──────────────────────────────────
// 动机与实测数据见 lib/stickers.js 顶部的「提示词段滞回」注释块。
// 进程内有效：重启后第一轮按当前真实库存取值（一次必然的翻字，由 shape-warm 兜底）。
const CAP_DOWNGRADE_GRACE_MS = 10 * 60 * 1000;   // 策略档位降档宽限：吸收手机端取消收藏的瞬时抖动
const LIST_REFRESH_MS = 3 * 60 * 1000;           // 可用表情包段最小刷新间隔：把收藏风暴折叠成一次翻字
let capState = null;        // { cap, pendingCap, pendingSince } 策略段生效档位（smoothCapDowngrade 的状态）
let listRender = null;      // { text, at } 可用表情包段上次注入的文本（planSectionRender 的状态）
let listWasEmpty = true;    // 上次注入时库是否为空（用于判定空库↔非空翻转=紧急）
/** 注册后由宿主返回的真实工具 id（带 skillId__ 前缀）。 */
const ids = { send: 'send_sticker', list: 'list_stickers', image: 'get_sticker_image', text: 'send_message', collect: 'collect_sticker' };

function settings() {
  try {
    const c = api?.config?.();
    return c && typeof c === 'object' ? { ...DEFAULTS, ...c } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function instance() {
  if (!manager) manager = new StickerManager(api);
  return manager;
}

// ── 查看器快照（panel/viewer.html 的数据源）──────────────────────────────────
//
// 页面只有 /plugin-panel/<id>/@data/ 这一条只读通道，读不到 <DATA_DIR>/stickers.json，
// 所以由这边把一份只读快照写进 api.storage 的 `view` 键，页面 fetch 出来渲染。
//
// 为什么要节流：hook 每轮都会调 sync()，而 storage.set 是"读整个 storage.json →
// 改一个键 → 整个写回"，100 张表情 ≈ 32KB，内容没变就不该白写一遍。

/**
 * 快照的"内容指纹"。
 *
 * 必须逐字段哈希，不能用"条数 / 用过数 / 有备注数"这种粗粒度指标：
 * 实测给一个本来就有备注的表情改备注、加标签、改使用次数，三个计数全都不动，
 * 指纹不变就跳过写盘，页面停在旧数据上。而这类改动恰恰是用户最常做的
 * （"我刚让它记了备注，怎么页面没变"）。
 *
 * 用 FNV-1a 而不是 node:crypto：省一个 import，碰撞概率对"变化检测"这个用途
 * 绰绰有余（真碰撞的后果只是少写一次快照，下次同步就补上了）。
 */
export function snapshotSignature(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  let h = 2166136261;
  const mix = (s) => {
    const str = String(s ?? '');
    for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  };
  for (const it of items) {
    mix(it.id); mix('\u0001');
    // hidden 必须进指纹：用户刚"删除"了一张表情，页面得立刻反映出来。
    // 否则隐藏后签名不变，跳过写盘，查看器还显示着那张。
    mix(it.hidden ? 'H' : '-'); mix('\u0001');
    mix(it.img); mix('\u0001');
    mix(it.desc); mix('\u0001');
    mix(it.note); mix('\u0001');
    mix(Array.isArray(it.tags) ? it.tags.join(',') : ''); mix('\u0001');
    mix(it.usage); mix('\u0001');
    mix(it.useCount); mix('\u0001');
    mix(it.lastUsedAt); mix('\u0001');
    mix(it.updatedAt); mix('\u0002');
  }
  // 同步时刻与总开关也要进指纹：前者让页脚的"收藏同步于"保持新鲜，
  // 后者让用户在设置里关掉表情包时页面立刻能显示出来。
  mix(payload?.syncedAt); mix('\u0001');
  mix(payload?.settings?.enabled === false ? 'off' : 'on');
  return `${items.length}:${(h >>> 0).toString(36)}`;
}

/**
 * @param {{error?: string}} [extra] 额外写进快照的元信息（如本次同步的错误）
 * @param {{force?: boolean}} [opts] force = 跳过节流（首次写 / 报错要立刻可见）
 */
function writeViewSnapshot(extra = {}, { force = false } = {}) {
  try {
    const mgr = instance();
    // 本地转存的图浏览器读不了 file:///，先导出一份到 plugin-data 下，
    // 页面才能显示（见 manager.materializeThumbs 的注释）。
    let thumbs = null;
    try { thumbs = mgr.materializeThumbs(); } catch { thumbs = null; }
    const payload = buildViewSnapshot(mgr.entries, {
      syncedAt: mgr.syncedAt,
      settings: settings(),
      hidden: mgr.hidden,
      thumbs,
      ...extra
    });
    const sig = snapshotSignature(payload);
    if (!force && sig === snapshotSig) return false;
    api?.storage?.set('view', payload);
    snapshotSig = sig;
    return true;
  } catch (error) {
    // 快照只是给界面看的，写不进去不能影响表情功能本身
    api?.warn?.('表情库快照写入失败：', error?.message ?? error);
    return false;
  }
}

/** 同步一次收藏，并按需刷新快照。三处调用点（启用时 / 定时器 / 每轮 hook）共用。 */
async function syncAndSnapshot(force = false) {
  let result;
  try {
    result = await instance().sync(force);
  } catch (error) {
    result = { entries: instance().entries, fromCache: true, error: String(error?.message ?? error) };
  }
  if (result?.fromCache === false) writeViewSnapshot({});
  // 同步失败时 syncedAt 不变、签名也不变，得强制写一次页面才知道"最近一次同步挂了"
  else if (result?.error) writeViewSnapshot({ error: result.error }, { force: true });
  return result;
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload) };
}
function err(message) {
  return { content: `错误：${message}`, isError: true };
}

/**
 * 把片段插进最后一条 user 消息的【过去状态】之前（原地改，钩子约定允许）。
 *
 * 为什么不是 appendToLastUser：buildUserPrompt 用 parts.join('\n\n') 拼装，段落顺序是
 *   角色设定 → 引导说明 → 当前状态说明 → 记忆 →【过去状态】
 *            → 本次唤醒 → 此刻状态 → 当前时间
 * 前缀缓存的断点落在【过去状态】内部（历史块逐条滚动），所以它之后的一切
 * 都是全价。原先把表情包段追加到 user 消息末尾（【当前时间】之后），等于把
 * 740 字符 ≈ 350 tok 放进"每轮 100% 白付"的位置，内容一个字符没变照样计费。
 *
 * "user 消息尾部本来就是易变段，放这里不额外增加缓存损失"这个说法是错的：
 * 它默认了"尾部反正要重算，白放不白放"，但那是把断点之后的全价区当成了免费的垃圾桶。
 *
 * 插到【过去状态】之前即可进入可缓存前缀（参考 prompt.js 里【当前状态说明】
 * 的前移修复：实测 78/78 次字节相同，回收效果立即可见）。
 *
 * 配套硬约束：调用方必须同时把 rotatePeriodMin 置 0（见 hooks 注释）。
 */
function insertBeforePastState(messages, text) {
  if (!Array.isArray(messages) || !text) return false;
  let target = null;
  for (const m of messages) if (m && m.role === 'user') target = m;
  if (!target) return false;

  // 只认【过去状态】段头的长形态，避开正文里可能出现的同名字面量
  const ANCHOR = '\n\n【过去状态】';

  if (typeof target.content === 'string') {
    const i = target.content.indexOf(ANCHOR);
    if (i >= 0) { target.content = target.content.slice(0, i) + '\n\n' + text + target.content.slice(i); return true; }
    // 找不到锚点就退回追加（保持旧行为，别静默丢内容）
    target.content += `\n\n${text}`;
    return true;
  }
  if (Array.isArray(target.content)) {
    // 数组形态：先找第一条 text 片段里含锚点的，在它内部切分；
    // 找不到锚点的片段则退回在末位 push。
    for (const part of target.content) {
      if (!part || part.type !== 'text' || typeof part.text !== 'string') continue;
      const i = part.text.indexOf(ANCHOR);
      if (i >= 0) {
        part.text = part.text.slice(0, i) + '\n\n' + text + part.text.slice(i);
        return true;
      }
    }
    target.content.push({ type: 'text', text: `\n\n${text}` });
    return true;
  }
  return false;
}

// ── 工具 ────────────────────────────────────────────────────────────────────

function registerTools(a) {
  ids.send = a.registerTool({
    id: 'send_sticker',
    name: '发送表情',
    description: '发一个 QQ 收藏表情（一次一张，不带文字，想说的话用 send_message 单独发）。stickerId 从 list_stickers 获取。',
    category: 'sticker',
    icon: '😀',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用的消息 id（聊天记录里的 #数字）' },
        atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        let sticker = await instance().find(String(args.stickerId ?? ''));
        if (!sticker) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);
        if (!sticker.url) return err(`表情 ${sticker.id} 没有可发送的图片地址`);
        sticker = await instance().ensureSendable(sticker);
        const isLocalFile = String(sticker.url).startsWith('file:///');
        if (isLocalFile) {
          if (!localStickerPath(sticker.url)) {
            // 说全两种可能：路径不在受控目录内，或本地文件是个空壳（写入中断留下的）
            return err(`表情 ${sticker.id} 的本地图片不可用（不在受控收藏目录内，或文件为空），已拒绝发送`);
          }
        } else {
          try {
            await validateImageUrl(sticker.url);
          } catch (error) {
            return err(`表情 ${sticker.id} 的图片地址不合法，已拒绝发送：${error?.message ?? error}`);
          }
        }
        const result = await ctx.sender.sendSticker(ctx.chatKey, sticker, {
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        instance().markUsed(sticker.id, String(ctx.session?.triggerText || '').slice(0, 100));
        writeViewSnapshot({});   // 使用次数变了，页面上的"用过"计数跟着更新
        ctx.session?.sent?.push({ type: 'sticker', text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`, at: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
        ctx.emit?.('session-update', ctx.session?.id);
        return ok({ sent: true, messageId: result?.message_id ?? null, note: '表情已发送。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  ids.list = a.registerTool({
    id: 'list_stickers',
    name: '查看表情库',
    description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。',
    category: 'sticker',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
        limit: { type: 'integer', description: '最多返回条数，默认 24' }
      }
    },
    async execute(ctx, args) {
      try {
        const result = await instance().list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
        return ok(result);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  ids.image = a.registerTool({
    id: 'get_sticker_image',
    name: '查看表情图片',
    description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
    category: 'sticker',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: { stickerId: { type: 'string', description: '表情 id' } },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const sticker = await instance().find(String(args.stickerId ?? ''));
        if (!sticker) return err(`找不到表情 ${args.stickerId}`);
        if (!sticker.url) return err('该表情没有图片地址');
        const r = await downloadImageAsDataUrl(sticker.url);
        const built = getImagePartsOrVideo(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）：`, [r]);
        if (r.gifVideo) {
          built.content[0].text += `\n（这是 GIF 动图，已转成 ${r.gifVideo.frames} 帧、最长边 ${Math.max(r.gifVideo.width, r.gifVideo.height) || '≤480'}px 的视频输入，画面按视频发给模型）`;
        }
        return built;
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  a.registerTool({
    id: 'note',
    name: '备注表情',
    description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
    category: 'sticker',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id（照抄 list_stickers 的）' },
        note: { type: 'string', description: '你的理解/含义' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
        usage: { type: 'string', description: '适用场景（可选）' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const entry = instance().note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
        if (!entry) return err(`找不到表情 ${args.stickerId}`);
        writeViewSnapshot({});
        return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // 必须接住 registerTool 的返回值：宿主会把工具 id 前缀成 `sticker__collect_sticker`。
  // 此前这里没赋值，策略段回落到裸名 `collect_sticker`，模型照提示词去调，
  // executeTool 只认精确 id / 中文显示名，每次都报「未知工具 collect_sticker」，
  // 表现就是"让它收藏表情，它答应了但什么都没做"。
  ids.collect = a.registerTool({
    id: 'collect_sticker',
    name: '收藏表情',
    description: '收藏别人发的表情/图片（先 get_message_images 看图确认）。除了一句备注，还要顺手把标签和适用场景写上——它们会进你的表情候选列表，下次挑表情才挑得准。',
    category: 'sticker',
    icon: '⭐',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '消息的 #数字' },
        note: { type: 'string', description: '一句简短备注：画面是什么、什么情绪（20 字内）' },
        tags: { type: ['array', 'string'], items: { type: 'string' }, description: '2~4 个短标签，描述可用的语境/情绪，如 ["无语","翻白眼","懒得理"]；也可传逗号分隔字符串' },
        usage: { type: 'string', description: '适用场景一句话：什么情况下该用它，如「被噎住/不想接话/敷衍回应」' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store?.findByMid?.(ctx.chatKey, args.messageId);
        if (!entry) return err(`在当前会话找不到消息 ${args.messageId}`.trim());
        const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && (m.url || m.file));
        if (!imageMedia) return err('该消息没有可收藏的图片');
        const saved = await instance().collect(args.messageId, {
          url: imageMedia.url || '',
          file: imageMedia.file || '',
          note: String(args.note ?? ''),
          tags: args.tags ?? [],
          usage: String(args.usage ?? '')
        });
        writeViewSnapshot({});
        return ok({
          collected: true,
          id: saved.id,
          note: saved.localNote,
          tags: saved.tags || [],
          usage: saved.usage || ''
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── 删除 / 恢复 ──────────────────────────────────────────────────────────
  //
  // 这两个工具做的是软删除，不是从 stickers.json 里把条目抹掉。
  // 原因：QQ 收藏是源、本地库是镜像，物理删除会在下一次同步（≤60 秒）
  // 被原样加回来。所以"删除"= 把 id 记进隐藏名单，由 visibleEntries
  // 在各消费点（提示词 / list / 快照 / 发送）摘出去。好处是可逆、且不丢
  // 备注/标签/使用次数/本地图片。详见 lib/stickers.js 的隐藏名单注释。

  a.registerTool({
    id: 'delete_sticker',
    name: '删除表情',
    description: '把一个表情从表情库里移除。是软删除——它的备注、标签、使用次数都还留着，随时可以用 restore_sticker 恢复。stickerId 从 list_stickers 获取。',
    category: 'sticker',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id（照抄 list_stickers 的）' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const r = instance().hide(String(args.stickerId ?? ''));
        if (!r.ok) return err(`找不到表情 ${args.stickerId}，请先用 list_stickers 获取有效 id`);
        writeViewSnapshot({});   // 隐藏态变了，查看器要立刻反映
        return ok({
          deleted: true,
          id: r.id,
          alreadyDeleted: Boolean(r.alreadyHidden),
          hiddenCount: instance().hidden.size,
          note: '已删除。它不会再出现在表情列表和提示词里；想找回来说一句「恢复表情 <id>」，或去顶部「插件」页 → 表情库 →「已删除」里看。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  a.registerTool({
    id: 'restore_sticker',
    name: '恢复表情',
    description: '把一个之前删掉的表情恢复回表情库（备注、标签、使用次数都还在）。不确定 id 就先用 list_deleted_stickers 看看删过哪些。',
    category: 'sticker',
    icon: '↩️',
    parameters: {
      type: 'object',
      properties: {
        stickerId: { type: 'string', description: '表情 id' }
      },
      required: ['stickerId']
    },
    async execute(ctx, args) {
      try {
        const r = instance().unhide(String(args.stickerId ?? ''));
        if (!r.ok) return err(`找不到表情 ${args.stickerId}（它可能从来没被删过，也可能本来就不在库里）`);
        writeViewSnapshot({});
        return ok({ restored: true, id: r.id, note: '已恢复，它会重新出现在表情列表和提示词里。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  a.registerTool({
    id: 'list_deleted_stickers',
    name: '看删过哪些表情',
    description: '列出被删除（隐藏）的表情及其 id，方便决定要不要恢复。',
    category: 'sticker',
    icon: '🗃️',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const mgr = instance();
        const list = mgr.hiddenEntries().map((e) => ({
          id: e.id,
          desc: e.desc || '',
          localNote: e.localNote || '',
          tags: e.tags || [],
          useCount: e.useCount || 0
        }));
        return ok({ total: list.length, deleted: list });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // 上面这些"会改库"的工具（发送 / 备注 / 收藏 / 删除 / 恢复）都在改完之后
  // 同步刷新快照，保证用户点开查看器看到的就是刚刚发生的事，不用等下一次收藏同步。
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  try {
    registerTools(a);
  } catch (error) {
    api.warn('表情工具注册失败：', error?.message ?? error);
  }
  // 先把磁盘上的库写一份快照：用户装完插件就去点「查看收藏的表情」时，
  // 页面不该是空的（真同步由 activate() 起，最长 60 秒后才到）。
  writeViewSnapshot({}, { force: true });
}

/** 生效：起一个后台刷新定时器，保持收藏表情新鲜（避免在 hook 里做网络等待）。 */
export function activate() {
  if (settings().enabled === false) {
    // 关掉时也刷一次快照：页面仍可打开，但要让用户看到"已关闭"这个状态
    writeViewSnapshot({}, { force: true });
    return;
  }
  coldSynced = false;   // 重新启用（或热重载）时允许再等一次首次同步
  try {
    syncAndSnapshot(false).catch(() => {});
  } catch { /* ignore */ }
  // 60 秒与 StickerManager.sync 的 TTL 对齐：定时器到点时正好可以真刷新。
  timer = setInterval(() => {
    try { syncAndSnapshot(false).catch(() => {}); } catch { /* ignore */ }
  }, 60000);
  timer.unref?.();
  // api.panel 是宿主的界面助手（见 src/skills/panel.js）：插件不用手抄
  // `/plugin-panel/<自己的 id>/`。把地址打进日志，排障时能直接确认界面挂在哪。
  const viewUrl = api.panel?.url?.('panel/viewer.html') || '';
  api.log(`表情系统已启用：收藏同步 + 提示词注入 + 发送/看图/收藏工具${viewUrl ? `\n  界面：${viewUrl}` : ''}`);
}

export function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
}

// ── 能力（sticker.state 软依赖）────────────────────────────────────────────

/**
 * 给编排器的「收尾宽限」提供判断依据（`sticker.state` 软依赖）。
 *
 * 为什么需要：编排器在"纯发送批"之后会立刻收尾（省一轮 19K token），把
 * "先说文字、下一轮补表情"整条路砍掉。要判断"这一轮值不值得宽限"，它需要知道
 * 两件本插件独占的事实：库里有几张图、生效档位够不够。而核心代码不该
 * import 插件，于是走能力名：装上并启用才有，缺了编排器静默退回收尾旧行为。
 *
 * 只读内存快照，不发网络、不 await：编排器每轮最多问一次，热路径上等 OneBot
 * 会直接把回应拖慢。库还没同步上来时返回 count=null，capacityLevel 按配置档走
 * （不降档），而编排器据此放弃宽限（拿不准就不花那 19K）。
 */
export const providers = {
  'sticker.state': () => {
    try {
      const s = settings();
      if (s.enabled === false) return { enabled: false, count: 0, level: 0 };
      let count = null;
      try { count = instance().entries.length; } catch { count = null; }
      const level = typeof capacityLevel === 'function' ? capacityLevel(s.encourage, count) : s.encourage;
      return { enabled: true, count, level };
    } catch {
      return { enabled: false, count: 0, level: 0 };
    }
  }
};

// ── 提示词片段（策略段，进系统提示；随档位变化，稳定可缓存）─────────────────

/**
 * 动态片段：由 skills/manager.js 的 getPromptSections 收集，渲染进系统提示
 * 末尾的【可用技能】区（与 schedule / knowledge-memes 等技能同一机制）。
 * 同步函数，只依赖设置与工具名，不碰网络。
 */
export function promptSections() {
  const s = settings();
  if (s.enabled === false) return [];
  // 容量档：库里几张决定该不该鼓励发表情。
  // 读不到库存（manager 还没起）就按配置档走，绝不因为读失败把功能关掉。
  let count = null;
  try { count = instance().entries.length; } catch { count = null; }
  // 热重载只刷新入口、不刷新被 import 的子模块（ESM 缓存），窗口期内 capacityLevel
  // 可能还是 undefined，这里退化成"按配置档走"，绝不让提示词构建抛错。
  //
  // 原始档先过降档滞回，再与配置取 min。档位每翻一次，【表情包策略】段整段换字，
  // 前缀缓存从该处起全部重算（实测单次 6.5K~9.4K tok、命中掉到 21%，
  // cache-guard 记「系统提示漂移」）。库存跨 0/4/10 边界是升级，立即生效（库变大
  // 是模型该知道的好事）；手机端取消收藏造成的瞬时跌档要持续
  // CAP_DOWNGRADE_GRACE_MS 才落地，抖动被折叠成零次翻字。
  // 连带把「空库文案」也改按生效档判：库存清零同样走降档滞回，而【可用表情包】
  // 清单段的空库占位会立即翻转（紧急项），"没表情可发"的信号不会因此迟到。
  // 升级不滞回是有意的：库存单调增长，滞回只把翻字推后、次数不变，
  // 还会让模型晚知道库里有新表情（见下方 volatile 注释里的实测数据）。
  const want = Math.min(3, Math.max(0, Number(s.encourage) || 0));
  const rawCap = typeof capacityCap === 'function' ? capacityCap(count) : null;
  let effectiveCap = rawCap;
  if (rawCap !== null && typeof smoothCapDowngrade === 'function') {
    const before = capState ? capState.cap : null;
    capState = smoothCapDowngrade(capState, rawCap, Date.now(), CAP_DOWNGRADE_GRACE_MS);
    effectiveCap = capState.cap;
    if (before !== null && before !== capState.cap) {
      try {
        api.log(`表情策略档位生效变化：${before} → ${capState.cap}（库存 ${count} 张）。该段已标 volatile、渲染在【当前状态说明】，翻字只重算其后约 4K 字（原为整条前缀 ~9K）`);
      } catch { /* 日志失败不影响提示词构建 */ }
    }
  }
  const level = effectiveCap === null
    ? (typeof capacityLevel === 'function' ? capacityLevel(s.encourage, count) : s.encourage)
    : Math.min(want, effectiveCap);
  return [{
    id: 'sticker-strategy',
    title: '表情包',
    priority: 62,
    // volatile: true：本段内容 = f(库存档位)，而库存每一张新收藏
    // 都可能跨 0/4/10 边界，段内换字，前缀断在这里，其后【过去状态】+【场景】
    // +【此刻状态】整段全价（实测单次 6.5K~9.4K tok，占 messages 块的 67%~78%）。
    // 标为易变后由 buildSystemPrompt 拆出（prompt.js 的 isVolatileSection），
    // 渲染进用户提示的【当前状态说明】：该块在【过去状态】之前，于是断点
    // 从 messages 的 25% 处后移到 73% 处，翻字代价降到原来的 ~44%。
    // 为什么不用"升级也走滞回"来避免翻字：库存是单调增长的，滞回只把翻字推后、
    // 翻字次数不变（实测 00:01:41 / 00:03:52 两次都是升级，且跨的是不同边界，
    // 任何窗口都合并不了），还额外让模型晚知道新表情。真正降低代价只能靠挪位置。
    volatile: true,
    content: buildStickerStrategyHint(level, { send: ids.send, list: ids.list, image: ids.image, text: ids.text, collect: ids.collect }, { empty: effectiveCap === 0 })
  }];
}

// ── 钩子 ────────────────────────────────────────────────────────────────────

export const hooks = {
  /**
   * 每轮把【可用表情包】列表注入到【过去状态】之前。
   *
   * 不 await 网络同步：hook 有 5 秒超时，而 fetch_custom_face_detail 最长
   * 15 秒，冷缓存时 await 会被掐断。改为用内存里的当前快照注入，并
   * fire-and-forget 触发一次后台刷新；activate() 的定时器负责让它基本总是热的。
   *
   * 轮换必须关闭（硬编码，不看配置）：本段已移入可缓存前缀，一旦内容
   * 变化，其后的【过去状态】整块历史都要重新计费。小时级轮换 = 每天 24 次
   * 全量重算（约 4000+ tok/次），是彻底的负优化。
   * 表情库多样性改由 list_stickers 工具兜底：提示词里本来就写了
   * "完整列表可用 list_stickers 查询"，模型想看全库随时能看。
   * 这里的 10 条只作为"存在性提示"（让模型知道用户有表情包可用），不承担
   * 轮换曝光的职责。
   */
  async 'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (s.enabled === false) return;
    const messages = ctx?.messages;
    if (!Array.isArray(messages)) return;
    try {
      const mgr = instance();
      // 命中 TTL 时立即返回；过期则后台刷新，本轮先用现有快照（不阻塞）。
      // 用 syncAndSnapshot 而不是裸 sync：刷新成功后顺手把查看器快照更新掉
      // （签名没变就自动跳过，所以"每轮 hook"不会变成"每轮写盘"）。
      const inflight = syncAndSnapshot(false).catch(() => {});
      // 冷启动（内存里还没有任何表情）：把这一次同步等完，否则前几轮会"库是空的、
      // 注入不出东西"。之后一律不 await：hook 只有 5 秒预算，而 OneBot 调用可能更慢。
      if (!coldSynced && !(mgr.entries || []).length) {
        coldSynced = true;
        try { await inflight; } catch { /* 等不到就用空快照，下一轮定时器已刷新 */ }
      }
      const entries = mgr.entries || [];
      const text = buildStickerContext(entries, s.promptMaxStickers, {
        rotatePeriodMin: 0,   // 强制关闭轮换，见上方注释。勿改回 s.rotatePeriodMin。
        listTool: ids.list,
        hidden: mgr.hidden   // 已隐藏的不进提示词，否则"删了还会被翻出来"
      });
      // 空库时也必须占位：此前是 `if (text)`，库空的那些轮次这一整段会消失，
      // 用户收藏第一个表情的下一轮它又整段出现。段增删会把【过去状态】及其后
      // 所有内容的字节位置整体前移，前缀缓存整段作废。
      // 与 prompt.js 的【记忆】空态同因同解：段结构必须恒定。
      const nextText = text || '【可用表情包】你的 QQ 收藏表情库现在是空的（用户还没收藏过表情）。';
      // 清单段按最小刷新间隔节流（planSectionRender）。每张新表情让段长
      //   +54~64B，其后整个历史窗口重算；收藏风暴（实测 5 分钟 6 张）会连翻 6 次。
      //   空库↔非空翻转算紧急（行为关键，且一生只一次）立即生效；其余变化最多每
      //   LIST_REFRESH_MS 翻一次字。清单只是"存在性提示"，完整列表模型随时可用
      //   list_stickers 查，几分钟的陈旧不伤功能。节流期内继续注入上一版文本
      //   （段结构恒定，不消失、不前移）。
      const isEmpty = !text;
      const plan = typeof planSectionRender === 'function'
        ? planSectionRender(listRender, nextText, Date.now(), LIST_REFRESH_MS, isEmpty !== listWasEmpty)
        : { text: nextText, at: Date.now(), rendered: true };
      if (plan.rendered) {
        if (listRender && listRender.text !== plan.text) {
          try {
            api.log(`可用表情包段已刷新（库存 ${entries.length} 张）。该段在【过去状态】之前，翻字=历史窗口重算`);
          } catch { /* 日志失败不影响提示词构建 */ }
        }
        listRender = { text: plan.text, at: plan.at };
        listWasEmpty = isEmpty;
      }
      insertBeforePastState(messages, plan.text);
    } catch (error) {
      api.warn('表情包注入失败：', error?.message ?? error);
    }
  }
};

/** 供本地自测/排障直接拿内部实例（宿主不会调用）。 */
export function __internals() {
  return { settings, instance, ids, DEFAULTS, writeViewSnapshot, snapshotSignature };
}

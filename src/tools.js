// 原生工具集（OpenAI function calling 格式）。
// 每个工具自动绑定本次运行对应的会话（chatKey），不再需要 key/token 参数，
// 模型物理上无法把消息发到别的群/私聊。工具命名去掉了 qq_ 前缀（更短，省 token）。
// 所有工具通过 registerTool() 注册到 tool-registry.js，设置页可按卡片勾选启用/禁用。
import { getConfig } from './config.js';
import { isAtMe } from './prompt.js';
import { logger } from './logger.js';
import { normalizeMessageList } from './util.js';
import { skillManager } from './skills/manager.js';
import { validateImageUrl, safeFetchBinary, browseLockState, checkBrowseLock } from './safe-fetch.js';
import { webSearch, webFetch } from './web-search.js';
import { expandForwardNodes, fetchForwardNodes } from './onebot.js';
import { registerTool, listTools } from './tool-registry.js';
import { holidayOn, upcomingHoliday } from './holidays.js';
import { compressImage } from './image-compress.js';
import { isGifBuffer, gifToVideoDataUrl, resolveGifRoute } from './gif-to-video.js';
import { lookupCachedImage } from './image-cache.js';
import { resolveCachedMediaPath } from './media-path.js';
import fs from 'node:fs';
import path from 'node:path';

/** 当前配置的 GIF 选路（vision/video 开关组合，规则矩阵见 resolveGifRoute 注释）。 */
function currentGifRoute() {
  const cfg = getConfig();
  return resolveGifRoute({ vision: cfg.api?.vision !== false, video: cfg.api?.video === true });
}

export async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  // GIF 在这里分岔（规则矩阵见 resolveGifRoute）：
  //   vision+video 都开 → 转 mp4 按 video 部件发（llm.js 自动切视频专用模型）；
  //   只开 vision      → GIF 按图片原样发（读不了的模型由 llm.js 的"图片被拒"
  //                      降级路径换首帧重试，见 image-compat 的 llm.retry-advisor）；
  //   vision 没开      → 看图工具整体不可用，不会被调到。
  if (isGifBuffer(buffer) && currentGifRoute() === 'video') {
    const video = await gifToVideoDataUrl(buffer);
    if (video) {
      return {
        dataUrl: '',
        gifVideo: {
          dataUrl: video.dataUrl,
          frames: video.frames,
          width: video.width,
          height: video.height
        }
      };
    }
    // 转换失败（没 ffmpeg / 文件异常）→ 落到下面的普通图片路径，按原样发
  }
  // 大图片自动压缩（有 ffmpeg 时）：缩到模型可接受的尺寸/体积，降低 token 成本
  const compressed = await compressImage(buffer);
  const mime = compressed.compressed ? compressed.mime : (detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0]);
  return {
    dataUrl: `data:${mime};base64,${compressed.buffer.toString('base64')}`,
    isGif: mime === 'image/gif',
    // 原始 GIF 字节留着：模型拒收 GIF 时降级重试要取首帧（gifFirstFrameDataUrl）。
    // 非 GIF 返回 null，不占内存。
    gifBuffer: isGifBuffer(buffer) ? buffer : null
  };
}

/**
 * 把 downloadImageAsDataUrl 的结果组装成工具返回的 content parts。
 * GIF 转出的视频用 video_url 部件（llm.js 检测到会自动切视频专用模型），
 * 其余仍是 image_url。GIF 按原图（gif-image 路线）发送时：能读 GIF 的模型
 * 看得到动图，读不了的会在网关报错后由 image-compat 的降级路径换首帧重试。
 */
export function getImagePartsOrVideo(text, results) {
  const parts = [{ type: 'text', text }];
  const gifAsImage = [];
  for (const r of results) {
    if (r?.gifVideo) {
      parts.push({ type: 'video_url', video_url: { url: r.gifVideo.dataUrl } });
    } else {
      parts.push({ type: 'image_url', image_url: { url: r.dataUrl } });
      if (r?.isGif) gifAsImage.push(r);
    }
  }
  if (gifAsImage.length) {
    parts[0].text += `\n（其中 ${gifAsImage.length} 张是 GIF 动图，按原图发送：部分模型只能看到第一帧，读不了时会自动换成首帧重试）`;
  }
  return { content: parts, videoCount: parts.filter((p) => p.type === 'video_url').length };
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 8) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/**
 * 把一条消息里的图片读成可直传给模型的数据部件：**入库缓存优先 → 消息里的 url → 本地落盘**。
 * `get_message_images`（看图工具）与 `read_forward`（转发里的图）共用，避免两套实现走岔。
 *
 * @param media  消息的 media 数组（entry.media，或 expandForwardNodes 返回的 media）
 * @param midKey 缓存键里的消息号（与入库侧 image-cache.js 用的 event.message_id 对齐）
 * @param max    最多读几张（转发里可能一次带很多图，全塞进去会把上下文撑爆）
 */
export async function collectImageResults(ctx, media, midKey, { max = 8 } = {}) {
  const items = (media || [])
    .map((m, i) => ({ m, i }))
    .filter(({ m }) => m.kind === 'image' && (m.url || m.file))
    .slice(0, max);
  const results = [];
  const failed = [];
  for (const { m, i } of items) {
    try {
      // **入库缓存优先**：QQ 图片链接几分钟就过期（官方错误体 "download url has
      // expired"，实测入库 48 秒后就已经 400）。入库那一刻后台已经把图下载到本地，
      // 这里直接读；没有缓存（旧消息/下载失败）才走 url，那时多半也已经过期。
      const cached = lookupCachedImage(ctx.chatKey, midKey, i);
      if (cached) {
        results.push({
          dataUrl: `data:${cached.contentType};base64,${cached.buffer.toString('base64')}`,
          isGif: cached.contentType === 'image/gif',
          gifBuffer: null
        });
        continue;
      }
      if (m.url) {
        results.push(await downloadImageAsDataUrl(m.url));
      } else if (m.file) {
        // 仅本地落盘、无 url（远端直链已过期）的图片：直接读本地字节回传，
        // 否则会漏掉"图床直链过期但本地还有"的情况。
        // ⚠️ m.file 是**消息段转述**的字段，直接 readFileSync 等于"消息里写什么
        //    路径就读什么文件"，群里一条构造消息段就能让机器人读本地任意文件并经
        //    base64 外发。所以先过白名单：只放行我们自己写下的缓存文件
        //    （归属 + realpath + 命名规则三道，见 media-path.js）。
        const gate = resolveCachedMediaPath(m.file, { kind: 'image' });
        if (!gate.ok) {
          failed.push(`本地图片不可用：${gate.reason}`);
          continue;
        }
        try {
          const fp = gate.path;
          const buf = fs.readFileSync(fp);
          const ext = path.extname(fp).toLowerCase();
          const mime = ext === '.png' ? 'image/png'
            : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg'
            : ext === '.gif' ? 'image/gif'
            : ext === '.webp' ? 'image/webp'
            : 'image/png';
          results.push({ dataUrl: `data:${mime};base64,${buf.toString('base64')}`, isGif: mime === 'image/gif', gifBuffer: null });
        } catch (e) { failed.push(`本地图片读取失败：${String(e?.message ?? e)}`); }
      }
    } catch (e) { failed.push(String(e?.message ?? e)); }
  }
  return { results, failed };
}

/**
 * read_forward 的统一返回：转发文本 + **转发里的图片一起回传**。
 *
 * 只回 `images: N` 这个数字时，模型看到正文里一排 `[图片]` 却没有任何可看的
 * 东西，只能跟用户说"图看不到"。转发里的图本来就在 `ex.media` 里（入库时也
 * 下过缓存），没道理不一起给它。一次最多回 4 张，十几张会把上下文撑爆。
 */
export async function forwardResult(ctx, midKey, text, media, note = '') {
  const imgs = (media || []).filter((m) => m.kind === 'image');
  // 看图能力关着的时候别硬塞 image 部件（会和 get_message_images 的 requiresVision 不一致，
  // 模型收到图也读不了）。只把张数说清楚。
  if (imgs.length && getConfig().api?.vision === false) {
    return ok({ messageId: midKey, text, note: [note, `转发里还有 ${imgs.length} 张图，但看图能力没开`].filter(Boolean).join('；') });
  }
  const { results } = await collectImageResults(ctx, media, String(midKey).replace(/^#/, ''), { max: 4 });
  const tail = [];
  // 备注末尾的句号会拼出「。；」这种双标点，统一剥掉
  if (note) tail.push(note.replace(/[。；;\s]+$/, ''));
  if (imgs.length && results.length) {
    tail.push(imgs.length > results.length
      ? `转发里共 ${imgs.length} 张图，先给前 ${results.length} 张`
      : `转发里的 ${results.length} 张图已附在下面`);
  } else if (imgs.length) {
    tail.push(`转发里还有 ${imgs.length} 张图，但直链已过期取不到（正文里的 [图片] 就是它们）`);
  }
  if (!results.length) return ok({ messageId: midKey, text, note: tail.join('；') || undefined });
  return getImagePartsOrVideo(`${text}${tail.length ? `\n\n（${tail.join('；')}）` : ''}`, results);
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

// 找不到消息 id 时，把当前会话真实可见的 id 告诉模型，避免它继续瞎猜。
function midHint(ctx) {
  const mids = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => m.mid)
    .filter((v) => v !== null && v !== undefined && String(v) !== '');
  const uniq = [...new Set(mids.map(String))].slice(-8);
  return uniq.length
    ? `消息 id 只能用聊天记录里每条消息前的 #数字（最近可见：${uniq.join(' ')}），不要自己编`
    : '聊天记录里还没有带 #id 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 构建绑定一次运行的工具集。工具定义注册到 tool-registry，这里从 registry 读取。
 */
export function buildToolDefs() {
  // 确保所有工具已注册（幂等）
  registerAllTools();
  // 加载插件工具（如果还没加载）
  loadPluginTools();
  return listTools();
}

/** 加载插件工具（幂等） */
let pluginToolsLoaded = false;
function loadPluginTools() {
  if (pluginToolsLoaded) return;
  pluginToolsLoaded = true;
  // 插件工具已在 app.js 启动时通过 loadPlugins() 注册到 registry，这里只需确保 registry 里有它们
}

/** 注册所有内置工具到 registry。 */
function registerAllTools() {
  // 消息发送类
  registerTool({
    id: 'send_message',
    name: '发送消息',
    description: '发消息到当前会话。messages 传字符串=一条；数组=分多条。只有需要明确回哪条才传 replyToMessageId，需要点名才传 atUserId。',
    category: 'messaging',
    icon: '💬',
    parameters: {
      type: 'object',
      properties: {
        messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
        replyToMessageId: { type: ['integer', 'string'], description: '要引用的消息 id（#数字，可选）' },
        atUserId: { type: ['integer', 'string'], description: '要 @ 的 QQ 号（可选）' }
      },
      required: ['messages']
    },
    async execute(ctx, args) {
      try {
        const messages = normalizeMessageList(args.messages);
        if (!messages.length) return err('消息内容为空');
        const result = await ctx.sender.sendTextBatch(ctx.chatKey, messages, {
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        const realSent = result.sent.filter((s) => !s.deduped);
        ctx.session.sent.push(...realSent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
        ctx.emit('session-update', ctx.session.id);
        const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
        if (result.failed.length) {
          // 失败原因是"被禁言"时，重试不可能成功，每重试一轮就是一整份 prompt
          // （实测单请求 body 涨到 1.9MB）。明确告诉模型这是终态，停止重试。
          const banFailed = result.failed.filter((f) => f.muteRejection).length;
          if (banFailed > 0) {
            note.push(`（${banFailed} 条发送失败：机器人当前在本群被禁言，消息不可能送达。请勿重试发送，直接结束本轮；如需说明，简短告知"当前被禁言无法发言"即可。）`);
          } else {
            note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          }
        }
        // failed 必须带出去：用量账本（plugin-usage）按 toolCall.failed 统计失败，
        // 否则"部分失败"在控制台永远是 0 错误。
        return ok({ sent: realSent.length, failed: result.failed.length, messageIds: realSent.map((s) => s.messageId).filter(Boolean), note: note.join('') });
      } catch (error) {
        // 禁言终态错误：全败且签名是禁言（sender 已标记该群禁言状态）。
        // 作为终态返回：模型收到后应停止重试发送，重试除了烧 token 没有任何意义。
        if (error?.muteRejection) {
          return err('发送失败：机器人当前在本群被禁言，消息不可能送达（已记录禁言状态）。请勿重试发送，直接结束本轮；如需说明，简短告知"当前被禁言无法发言"即可。');
        }
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'send_to',
    name: '发送到指定会话',
    // 描述动态化：开关关闭时明确说"没权限"，避免模型白试一次；
    // 开启时引导先用 get_chats 查目标。默认关闭（社交敏感操作）。
    description: (() => {
      const cross = getConfig().tools?.crossChatSend === true;
      const base = '把消息发送到另一个群/私聊（不在当前会话里说，而是去别处说）。适用于：有人明确让你转告某人/某群、你主动去私聊某人。';
      return cross
        ? `${base}先用 get_chats 查可用的 chatKey，再传 targetChatKey（形如 group:123 / private:456）。只在有明确理由时使用，不要骚扰别人。`
        // 跨会话发送就是 send_to 这张工具卡自己的开关
        // （ui/app/06-settings-render.js 里 isSendTo 分支直接映射 tools.crossChatSend），
        // 界面上没有单独的「允许跨会话发送」勾选框，文案别指向不存在的入口。
        : `${base}（当前未开启：管理员可在 设置 → 工具与技能 →「💬 消息发送」分类里打开 send_to 的开关。）`;
    })(),
    category: 'messaging',
    icon: '📨',
    // 工具级可用性：开关关闭时整组工具不可见（getToolAvailability 的第 5 层），
    // 比描述提示更硬：模型连试的机会都没有。
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        targetChatKey: { type: 'string', description: 'group:群号 / private:QQ号（用 get_chats 查）' },
        messages: { description: '要发送的内容：字符串=一条；数组=分多条', oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }
      },
      required: ['targetChatKey', 'messages']
    },
    async execute(ctx, args) {
      try {
        // 硬校验三连：开关 → 格式 → 白名单。描述里的引导不是安全边界。
        if (getConfig().tools?.crossChatSend !== true) {
          return err('跨会话发送未开启（管理员可在 设置 → 工具与技能 →「💬 消息发送」分类里打开 send_to 的开关）。');
        }
        const wantTarget = String(args.targetChatKey ?? '').trim();
        if (!/^(group|private):\d+$/.test(wantTarget)) {
          return err('targetChatKey 格式应为 group:群号 或 private:QQ号');
        }
        if (wantTarget === ctx.chatKey) {
          return err(`目标 ${wantTarget} 就是当前会话，直接用 send_message 即可。`);
        }
        const [tKind, tId] = wantTarget.split(':');
        const allow = getConfig().allow || {};
        const allowList = (tKind === 'group' ? allow.groups : allow.private) || [];
        // ⚠️ group / private 对称：空名单都必须显式开 allowAllWhenEmpty 才允许全放行，
        // 否则默认拒绝。private 分支若无条件放行，等于"只配了 allow.groups 就能给
        // 任意私聊发消息"，是越权口子。
        const allowedAll = allowList.length === 0 && getConfig().allowAllWhenEmpty === true;
        if (!(allowList.map(String).includes(tId) || allowedAll)) {
          return err(`目标 ${wantTarget} 不在白名单内，不能发送。`);
        }
        const messages = normalizeMessageList(args.messages);
        if (!messages.length) return err('消息内容为空');
        const result = await ctx.sender.sendTextBatch(wantTarget, messages, {});
        const realSent = result.sent.filter((s) => !s.deduped);
        ctx.session.sent.push(...realSent.map((s) => ({ type: 'text', text: s.text, to: wantTarget })));
        ctx.emit('session-update', ctx.session.id);
        const note = [`已发送到 ${wantTarget}。不要输出汇报。`];
        if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}）`);
        return ok({ sent: realSent.length, messageIds: realSent.map((s) => s.messageId).filter(Boolean), note: note.join('') });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'send_poke',
    name: '拍一拍',
    description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号，不知道就先调 get_active_members 查，不要传名字或昵称。',
    category: 'messaging',
    icon: '👋',
    parameters: {
      type: 'object',
      properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的 QQ 号（群聊必填）' } }
    },
    async execute(ctx, args) {
      try {
        if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
          return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
        }
        let target = args.targetUserId;
        if (target !== undefined && target !== null && String(target).trim() !== '') {
          target = Number(target);
          if (!Number.isInteger(target) || target <= 0) {
            return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
          }
          await ctx.sender.poke(ctx.chatKey, target);
        } else {
          await ctx.sender.poke(ctx.chatKey, null);
        }
        return ok({ poked: true });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'get_recent_messages',
    name: '查看历史消息',
    description: '往前翻更多历史消息（需要更早上下文时用）。返回的 messageId 就是 #数字，可引用/看图；[合并转发聊天记录] 用 read_forward 展开。',
    category: 'query',
    icon: '📜',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: '默认 30，最大 100' },
        offset: { type: 'integer', description: '在已展示给模型的上下文之外，再往前跳过 N 条历史（已进上下文的不算）' }
      }
    },
    async execute(ctx, args) {
      const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
      const offset = Math.max(0, Number(args.offset) || 0);
      const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
      return ok({
        count: messages.length,
        messages: messages.map((m) => ({
          messageId: m.mid ?? undefined,
          time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
          // sender 带 QQ 号（与提示词历史同口径）：模型按 id 对齐人，@/拍一拍/记印象才不会指错
          sender: m.self ? '我' : `${m.senderName}${m.senderId ? `(QQ:${m.senderId})` : ''}`,
          senderId: m.self ? undefined : (m.senderId || undefined),
          text: m.text
        }))
      });
    }
  });

  registerTool({
    id: 'read_forward',
    name: '展开转发消息',
    description: '展开合并转发的聊天记录。messageId 必须填「整条消息就是一条转发」的那个 #数字（不是方括号里的长 id）。[引用 #数字 名字：…] 里带的那个号就是被引用那条转发自己的，想看全就填它；引用者自己那条消息的号不是转发，填了会失败。转发里的图片会一起回传（最多 4 张），展开后直接就能看，不用再调 get_message_images。结果写回存档，不用重复调。',
    category: 'query',
    icon: '📨',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '消息的 #数字（可为负）' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) {
          // 引用块里会带「被引用那条」的 #数字，它可能已经滑出本会话的存档窗口
          // （或压根没被白名单收进来）。这种 id 不该判死刑，直接问协议端：
          // 是转发就展开给出去，不是就明说，别让模型在「找不到」和「不是转发」之间瞎猜。
          try {
            const msg = await ctx.onebot.getMsg(args.messageId);
            const segs = Array.isArray(msg?.message) ? msg.message : null;
            if (!segs || !segs.some((s) => String(s?.type ?? '') === 'forward')) {
              return err(`#${args.messageId} 不是合并转发，没有可展开的内容。`);
            }
            const nodes = await fetchForwardNodes(ctx.onebot, args.messageId, segs);
            const ex = await expandForwardNodes(nodes);
            if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
            return await forwardResult(ctx, args.messageId, ex.text, ex.media, '不在本会话存档窗口内，直接读的协议端');
          } catch (e) {
            return err(`当前会话找不到消息 ${args.messageId}，协议端也取不到：${e?.message ?? e}`);
          }
        }
        // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
        if (String(entry.text || '').startsWith('[合并转发 共')) {
          return await forwardResult(ctx, entry.mid, entry.text, entry.media, '存档里已是展开版');
        }
        // 只有「整条消息就是一条合并转发」才展开得动，占位符必须落在正文开头。
        // 引用块里也会出现「[合并转发聊天记录]」（被引用的那条是转发），模型看见就调
        // 本工具，但手上只有**外层消息**的 mid，展开必然失败。不先挡一下的话，用户
        // 看到的是「展开失败：OneBot get_forward_msg 失败：retcode=100」，指不到真原因。
        if (!/^\[(合并转发|转发消息)/.test(String(entry.text || ''))) {
          const peek = String(entry.text || '').replace(/\s+/g, ' ').slice(0, 40);
          return err(`#${entry.mid} 本身不是合并转发（正文：${peek || '空'}），没有可展开的内容。只有整条消息是一条转发时才能展开；引用里的转发需要引用的是那条转发本身。`);
        }
        // 负数 mid 不能直接丢给协议端（它只在 message_id > 0 时替我们解析 forward 段 id，
        // 否则把负数当 res_id 去拉 → "payload is empty"）。fetchForwardNodes 会自己
        // get_msg 取原消息、抠出 forward 段 id 再拉，正负都走同一条稳路。
        const nodes = await fetchForwardNodes(ctx.onebot, entry.mid);
        const ex = await expandForwardNodes(nodes);
        if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
        // 写回存档：一次展开，永久升级这条记录（模型/存档页/金句墙都受益）
        ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: ex.media || [] });
        const fresh = ctx.store.findByMid(ctx.chatKey, entry.mid) || entry;
        return await forwardResult(ctx, entry.mid, ex.text, fresh.media, '');
      } catch (error) {
        const msg = String(error?.message ?? error);
        // 优先用 onebot.call 挂上的结构化 retcode，字符串匹配只作兜底：
        // 协议端 wording 一改正则就会静默失效，而这类"拉不到内容"的判断最怕静默。
        const retcode = error?.retcode ?? (/(?:^|\D)retcode=(\d+)/.exec(msg)?.[1] ? Number(/(?:^|\D)retcode=(\d+)/.exec(msg)[1]) : null);
        if (retcode === 100 || /payload is empty/i.test(msg)) {
          // 这一类**重试没有意义**：不是参数错、也不是判据错，是协议端手上没有这份长消息。
          // 常见原因：转发发送时间太久已过保留期 / 当前账号无权读取该转发 / 原消息已被撤回。
          return err(`#${args.messageId} 的转发内容在协议端取不到（retcode=100 空载荷）。这通常意味着该转发已超过服务器保留期、已被撤回，或当前账号无权读取 —— 换参数重试不会有不同结果，请如实告诉用户「这条转发读不到内容」，不要反复重试。`);
        }
        if (error?.code === 'NOT_FORWARD') {
          return err(`#${args.messageId} 不是合并转发，没有可展开的内容。只有整条消息本身就是一条转发时才能展开。`);
        }
        return err(`展开失败：${msg}`);
      }
    }
  });

  registerTool({
    id: 'get_active_members',
    name: '查看活跃成员',
    description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
    category: 'query',
    icon: '👥',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
    },
    async execute(ctx, args) {
      const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
      return ok({
        members: members.map((m) => ({
          userId: m.userId,
          name: m.name,
          lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
          recentCount: m.count
        }))
      });
    }
  });

  registerTool({
    id: 'get_chats',
    name: '查看可用会话',
    description: '列出机器人参与的会话。跨会话发送前用它查 chatKey。',
    category: 'query',
    icon: '📋',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '默认 20，最大 50' } }
    },
    async execute(ctx, args) {
      const limit = Math.min(50, Math.max(1, Number(args?.limit) || 20));
      const chats = ctx.store.listChats()
        .map((key) => ({ key, ...(ctx.store.getChatMeta(key) || {}) }))
        .sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0))
        .slice(0, limit);
      return ok({
        count: chats.length,
        chats: chats.map((c) => ({
          chatKey: c.key,
          lastActive: c.lastTs ? new Date(c.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
          recentText: String(c.lastText || '').slice(0, 30)
        }))
      });
    }
  });

  registerTool({
    id: 'get_message_detail',
    name: '查看消息详情',
    description: '按 #数字 查单条消息详情（完整文本/发送者/时间），id 不要自己编。',
    category: 'query',
    icon: '📄',
    parameters: {
      type: 'object',
      properties: { messageId: { type: ['integer', 'string'], description: '消息的 #数字（可为负）' } },
      required: ['messageId']
    },
    async execute(ctx, args) {
      const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
      if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
      return ok({
        messageId: entry.mid,
        time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
        sender: entry.self ? '我' : entry.senderName,
        senderId: entry.senderId,
        text: entry.text,
        reply: entry.reply
      });
    }
  });

  registerTool({
    id: 'get_message_images',
    name: '查看消息图片',
    description: '查看某条消息里的图片（可直接看懂）。消息带 [图片] 时用，id 为 #数字。',
    category: 'query',
    icon: '🖼️',
    requiresVision: true,
    parameters: {
      type: 'object',
      properties: { messageId: { type: ['integer', 'string'], description: '消息的 #数字（可为负）' } },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        // 缓存键要和入库侧（image-cache.js 用 event.message_id）对上，容错掉模型可能带来的 '#'
        const midKey = String(args.messageId).replace(/^#/, '');
        const { results, failed } = await collectImageResults(ctx, entry.media, midKey);
        if (!results.length && !failed.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
        if (!results.length) return err(`图片获取失败：${failed.join('；')}`);
        const note = failed.length ? `（另有 ${failed.length} 张获取失败）` : '';
        // GIF 动图可能被转成了视频部件（见 downloadImageAsDataUrl），文案里区分张数
        const videoCount = results.filter((r) => r?.gifVideo).length;
        const imageCount = results.length - videoCount;
        const what = [
          imageCount ? `${imageCount} 张图片` : '',
          videoCount ? `${videoCount} 段视频（由 GIF 动图转换，≤480px/≤24帧）` : ''
        ].filter(Boolean).join(' + ');
        const built = getImagePartsOrVideo(`消息 ${args.messageId} 的内容${note}：${what}。`, results);
        return built;
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'memory_append',
    name: '记录印象',
    description: '记一条对群友的长期印象（下次自动可见）。只记稳定信息：身份/风格/爱玩的梗/雷点，临时事不记。userId 必须是 QQ 号（不知道先查 get_active_members）。',
    category: 'memory',
    icon: '🧠',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['memberImpression'], description: '固定 memberImpression' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（数字）' },
        target: { type: 'string', description: '对方名字' },
        content: { type: 'string', description: '印象内容（≤120字）' }
      },
      required: ['category', 'userId', 'content']
    },
    async execute(ctx, args) {
      const userId = String(args.userId ?? '').trim();
      if (!/^\d{1,15}$/.test(userId)) {
        return err(`userId 必须是数字 QQ 号（收到：${JSON.stringify(args.userId)}）。先用 get_active_members 查准确 QQ 号再记。`);
      }
      const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', String(args.content ?? ''), {
        userId,
        target: String(args.target ?? '').trim()
      });
      return ok({ saved: true, entry });
    }
  });

  registerTool({
    id: 'memory_query',
    name: '查询印象',
    description: '查看当前会话里你对群友的长期印象。不传 userId 返回全部；传 userId 只看某一个人。',
    category: 'memory',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' }
      }
    },
    async execute(ctx, args) {
      const mem = ctx.memory.query(ctx.chatKey);
      const userId = String(args.userId ?? '').trim();
      const list = userId
        ? mem.memberImpression.filter((e) => String(e.userId) === userId)
        : mem.memberImpression;
      return ok({ memberImpression: list });
    }
  });

  registerTool({
    id: 'memory_remove',
    name: '删除印象',
    description: '删除一条过时/不再准确的对群友印象。userId 优先按 QQ 号删；target 按名字删；两者都不传则删全部印象。',
    category: 'memory',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['memberImpression'], description: '固定 memberImpression' },
        userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
        target: { type: 'string', description: '对方名字' },
        content: { type: 'string', description: '只删这条内容' }
      },
      required: ['category']
    },
    async execute(ctx, args) {
      const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
        userId: String(args.userId ?? '').trim(),
        target: String(args.target ?? '').trim(),
        content: String(args.content ?? '').trim()
      });
      return ok({ removed });
    }
  });

  registerTool({
    id: 'report_feedback',
    name: '反馈问题',
    description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
    category: 'system',
    icon: '📢',
    parameters: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warning', 'error'], description: 'info/warning/error' },
        message: { type: 'string', description: '反馈内容' }
      },
      required: ['message']
    },
    async execute(ctx, args) {
      const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
      ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
      ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
      return ok({ reported: true });
    }
  });

  registerTool({
    id: 'web_search',
    name: '联网搜索',
    description: '联网搜索（Bing），返回标题/URL/摘要。适用：实时信息/新梗含义/不确定的事实。对最相关的 1~2 个结果用 web_fetch 读正文，不要只看摘要。',
    category: 'web',
    icon: '🔍',
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索词' } },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const result = await webSearch(String(args.query ?? ''));
        if (!result.results.length) {
          return ok({ query: result.query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
        }
        return ok(result);
      } catch (error) {
        return err(`搜索失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'web_fetch',
    name: '抓取网页',
    description: '只读抓取网页正文（≤2万字符）。群友发链接问内容时直接抓。禁止内网/本机地址。',
    category: 'web',
    icon: '📄',
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
      required: ['url']
    },
    async execute(ctx, args) {
      try {
        // 浏览锁定开启时逐跳校验白名单（与 send_image/search_images 同一口径；
        // 漏传 browseLocked 会让锁定形同虚设）
        const result = await webFetch(String(args.url ?? ''), { browseLocked: browseLockState().enabled });
        const body = String(result.body || '');
        return ok({
          url: result.url,
          statusCode: result.statusCode,
          truncated: result.truncated || body.length > 20000,
          content: body.slice(0, 20000)
        });
      } catch (error) {
        return err(`抓取失败：${error?.message ?? error}`);
      }
    }
  });

  registerTool({
    id: 'finish',
    name: '结束会话',
    description: '明确结束本次处理。看完不说话、说完收尾时调用（不调用直接结束也可以）。活跃期话题结束/偏离时也用它（summary 填"话题结束"）。',
    category: 'system',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '一句话决定说明（活跃期结束时填"话题结束"）' },
        activeTopic: { type: 'string', description: '开启活跃期才填：话题概括（15字内），平时不要填' }
      },
      required: ['summary']
    },
    async execute(ctx, args) {
      // ── 被点名时不许用 finish 跳过回应 ──────────────────────────────────
      // 现象：群友 @ 机器人并发图，模型连续看了几张图后直接 finish("不发送")，
      // 群里什么都没收到，用户以为"机器人坏了"。
      // 依据：【回应义务】写明"被 @/点名/引用提问必须回应，哪怕只回一个字"，
      // 但那是纯提示词约束，模型会无视，所以要在这里补一道代码闸。
      // 只拦第一次：第二次放行，防止模型硬顶导致无限重试，每次重试都要重付 prefill。
      try {
        const summoned = (ctx.session.trigger || []).some((e) => isAtMe(String(e?.text ?? ''), {
          selfNickname: ctx.selfNickname, botName: ctx.botName, selfId: ctx.selfId
        }));
        if (summoned && !(ctx.session.sent || []).length && !ctx.session.finishGuardHit) {
          ctx.session.finishGuardHit = true;
          // ⚠️ 不写 session.finishReason：那是"本次会话为什么结束"的说明。
          //   拦截后模型通常还会补发消息，写成"被点名但未回应"会让 UI 显示
          //   "未回应"而实际已经回了。拦截本身落日志，便于统计命中率。
          logger.warn('finish-guard', `被 @/点名但想直接结束，已拦截一次并要求先回应（${ctx.chatKey || ''}）`);
          return err('这一轮有人 @你 或 点名你。按【回应义务】必须先调用 send_message 回应（哪怕只回一个字），不能直接结束。');
        }
      } catch { /* 判定失败不阻断收尾 */ }
      ctx.session.finishReason = String(args.summary ?? '').slice(0, 300);
      // 活跃模式（chatActive）：模型在 finish 时带回话题总结。
      // orchestrator 读取 session.activeTopic 决定是否开启/维持活跃期。
      const topic = String(args.activeTopic ?? '').trim();
      if (topic) ctx.session.activeTopic = topic.slice(0, 60);
      return ok({ finished: true });
    }
  });

  // ── 提醒（闹钟/计时）──
  registerTool({
    id: 'set_reminder',
    name: '设置提醒',
    description: '设置定时提醒（到点在当前群主动发消息）。"X分钟后提醒我"用 delayMinutes；"明天8点/18:30"用 atTime，二选一。',
    category: 'system',
    icon: '⏰',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '到点要发的话' },
        delayMinutes: { type: 'number', description: '多少分钟后（与 atTime 二选一）' },
        atTime: { type: 'string', description: '"HH:MM" 或 "YYYY-MM-DD HH:MM"' }
      },
      required: ['text']
    },
    async execute(ctx, args) {
      const text = String(args.text ?? '').trim();
      if (!text) return err('提醒内容为空');
      let dueAt = null;
      if (args.delayMinutes != null && Number(args.delayMinutes) > 0) {
        // clamp：模型偶尔会把"分钟"算成天文数字（如把日期差直接塞进来），
        // 不设上限的话提醒列表里会躺着一个几百年后才触发的僵尸条目。上限 1 年。
        const minutes = Math.min(Number(args.delayMinutes), 365 * 24 * 60);
        dueAt = Date.now() + minutes * 60000;
      } else if (args.atTime) {
        dueAt = parseAtTime(String(args.atTime));
        if (!dueAt) return err('时间格式不对：用 "HH:MM"（如 18:30）或 "YYYY-MM-DD HH:MM"');
        if (dueAt <= Date.now()) return err('这个时间已经过了，请给个未来的时间');
      } else {
        return err('请提供 delayMinutes（多少分钟后）或 atTime（具体时间）之一');
      }
      if (!ctx.reminders) return err('提醒服务未启用');
      const entry = ctx.reminders.add({ chatKey: ctx.chatKey, text, dueAt, createdBy: String(ctx.selfId || '') });
      const when = new Date(dueAt);
      const whenStr = `${when.getMonth() + 1}月${when.getDate()}日 ${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
      return ok({ set: true, id: entry.id, dueAt, note: `已设置提醒：${whenStr} 到点我会在本群说「${text}」。` });
    }
  });

  registerTool({
    id: 'list_reminders',
    name: '查看提醒',
    description: '查看当前会话里还没触发的所有提醒（闹钟）。适用：群友问"我设了什么提醒"、"还有哪些闹钟"。',
    category: 'system',
    icon: '📋',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      if (!ctx.reminders) return err('提醒服务未启用');
      const list = ctx.reminders.pending(ctx.chatKey);
      if (!list.length) return ok({ count: 0, note: '当前没有待触发的提醒。' });
      const lines = list.map((r) => {
        const d = new Date(r.dueAt);
        const whenStr = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        return `- [${r.id}] ${whenStr}：${r.text}`;
      });
      return ok({ count: list.length, reminders: lines.join('\n') });
    }
  });

  registerTool({
    id: 'cancel_reminder',
    name: '取消提醒',
    description: '取消一个还没触发的提醒（闹钟）。id 从 list_reminders 获取。适用：群友说"取消那个提醒"、"别提醒我了"。',
    category: 'system',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '要取消的提醒 id（list_reminders 里 [r_xxx] 那个）' } },
      required: ['id']
    },
    async execute(ctx, args) {
      if (!ctx.reminders) return err('提醒服务未启用');
      const id = String(args.id ?? '').trim();
      if (!id) return err('请提供提醒 id');
      const ok_ = ctx.reminders.cancel(id);
      return ok_ ? ok({ cancelled: true, id }) : err(`没找到提醒 ${id}（可能已触发或 id 不对，用 list_reminders 查一下）`);
    }
  });

  // ── 节假日问候 ──
  registerTool({
    id: 'check_holiday',
    name: '查询节日',
    description: '查询今天或最近有什么节日（春节/中秋/端午/元旦/国庆等中国法定与常见节日）。用于在节日时主动向群友送上问候。适用：想知道"今天是什么节日"、"最近有什么节日可以蹭个祝福"。返回节日名称与一句参考祝福语，你可以据此自然发挥（别照抄）。',
    category: 'system',
    icon: '🎉',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '往后查几天内的最近节日（默认 7 天；0 表示只查今天）' }
      }
    },
    async execute(ctx, args) {
      const today = holidayOn(new Date());
      const days = args.days != null ? Math.max(0, Number(args.days) || 0) : 7;
      const upcoming = upcomingHoliday(days);
      const out = {
        today: today ? { name: today.name, greeting: today.greeting, type: today.type } : null,
        upcoming: upcoming ? { name: upcoming.name, date: upcoming.date, daysAway: upcoming.daysAway, greeting: upcoming.greeting } : null
      };
      let note;
      if (today) {
        note = `今天是${today.name}！可以自然地送上祝福（参考：${today.greeting}）。`;
      } else if (upcoming) {
        note = upcoming.daysAway === 0
          ? `今天是${upcoming.name}。`
          : `今天不是节日。最近的是 ${upcoming.daysAway} 天后的${upcoming.name}（${upcoming.date}）。`;
      } else {
        note = `今天不是节日，未来 ${days} 天内也没有常见节日。`;
      }
      return ok({ ...out, note });
    }
  });

  // ── 发网图（send_image / search_images）────────────────────────────────
  //
  // 此前机器人只能发 QQ 收藏的表情（send_sticker），**无法主动发一张网上找的图**。
  //
  // 三道闸门（缺一不可）：
  //   1. 总开关：security.imageSend.enabled 默认开启，只有用户显式存了 false 才拒绝。
  //      老配置里已显式存过 false 的，deepMerge 会保留其选择，不会被默认值覆盖。
  //   2. 预览闸门：requirePreview 时先 send_image(url, preview=true) 看一眼，才能真发
  //   3. 字节校验：魔数确认是真图（防"图片链接其实是防盗链网页"），
  //      下载走 safe-fetch（SSRF 防护 + 限量 + 浏览锁定）
  registerTool({
    id: 'send_image',
    name: '发送网图',
    description: '把一张网上找到的图片发到当前聊天。默认需要先预览确认（send_image(url, preview=true) 看一眼，再 send_image(url) 发出）。只支持 png/jpg/gif/webp 直链；网页地址不是图片。',
    category: 'media',
    icon: '🖼️',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '图片直链（要整条照抄，不要改动路径字符）' },
        preview: { type: 'boolean', description: 'true = 先只给自己看一眼、不发送' },
        note: { type: 'string', description: '可选：配一句话一起发' },
        replyToMessageId: { type: ['integer', 'string'], description: '可选：引用某条消息的 id' },
        atUserId: { type: ['integer', 'string'], description: '可选：@ 某人（填 QQ 号）' }
      },
      required: ['url']
    },
    async execute(ctx, args) {
      try {
        const cfg = getConfig();
        const opt = cfg.security?.imageSend || {};
        // 默认开启：仅"显式关掉"（enabled === false）才拒绝，undefined 视为放行。
        if (opt.enabled === false) {
          // 文案必须指向界面上真实存在的路径：设置 → 聊天 →「📨 信息发送配置」弹窗里的勾选框。
          return err('发网图功能未开启。这是安全总开关（security.imageSend.enabled），'
            + '与「工具与技能」里的 send_image 开关不是一回事：'
            + '请在 设置 → 聊天 →「📨 信息发送配置」里勾选「允许机器人发送网图」。');
        }

        const url = String(args.url ?? '').trim();
        if (!url) return err('url 不能为空');
        if (!/^https?:\/\//i.test(url)) {
          return err('只支持 http(s) 图片直链。本地文件路径不能发（那会暴露宿主文件系统）。');
        }
        // 每次运行的状态挂在 ctx 上（ctx 每次运行新建，天然隔离、不用持久化）
        ctx.sendImageState = ctx.sendImageState || { previewed: [], previews: 0, sent: 0 };
        const st = ctx.sendImageState;

        const isPreview = args.preview === true;
        const lock = cfg.security?.browseLock || {};
        // 浏览锁定站点内的图可跳过预览：站内图源可信，省一轮
        const lockCheck = checkBrowseLock(url, browseLockState());
        const trusted = lockCheck.enabled && lockCheck.allowed && opt.skipPreviewForLockedHosts !== false;

        if (!isPreview) {
          if (opt.requirePreview !== false && !trusted && !st.previewed.includes(url)) {
            return err('发图前要先看一眼：先调 send_image(url, preview=true) 确认这张图合适，再调 send_image(url) 发送。');
          }
          if (st.sent >= Math.max(1, Number(opt.maxPerRun) || 3)) {
            return err(`本次运行已经发了 ${st.sent} 张图，达到上限（设置里可调）。`);
          }
        } else if (st.previews >= Math.max(1, Number(opt.maxPreviewsPerRun) || 5)) {
          return err(`本次运行预览次数已达上限（${st.previews} 次）。挑最有把握的一张直接发。`);
        }

        // 下载：safe-fetch 全套防护（DNS 固定、逐跳校验、限量、浏览锁定）
        const maxBytes = Math.max(1, Number(opt.maxBytesMB) || 5) * 1024 * 1024;
        let buffer;
        let contentType;
        try {
          ({ buffer, contentType } = await safeFetchBinary(url, maxBytes, { browseLocked: !!lock.enabled }));
        } catch (error) {
          const msg = String(error?.message ?? error);
          // 404 多半是模型抄 URL 时手抖（实测把 /2026/04/xx.jpg 抄成 /2026-04-xx.jpg），
          // 提醒它原样复制，别自己"修复"路径
          const hint = /HTTP 404/.test(msg)
            ? '（地址可能抄错了：请从 web_fetch / search_images 返回的 images 里原样复制，不要改动路径字符；也可能是图已删除）'
            : '';
          return err(`图片下载失败：${msg}${hint}`);
        }
        if (!buffer || !buffer.length) return err('图片内容为空');

        // 魔数校验：只认真图。很多"图片链接"其实返回 HTML（防盗链页/错误页）
        const mime = detectMime(buffer);
        if (!mime) {
          const head = buffer.subarray(0, 200).toString('utf8').trim().toLowerCase();
          if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
            return err('这个地址返回的是网页（HTML），不是图片直链。先用 web_fetch 抓那页，再从它返回的 images 里挑一条直链。');
          }
          return err(`这个地址返回的不是图片（Content-Type: ${contentType || '未知'}）。只支持 png/jpg/gif/webp 直链。`);
        }

        const b64 = buffer.toString('base64');
        if (isPreview) {
          st.previews += 1;
          if (!st.previewed.includes(url)) st.previewed.push(url);
          // 问图片格式兼容 Skill：这种格式能不能喂给当前模型。
          // webp/avif 在部分本地视觉接口会直接 400，那会把整轮打挂，
          // 比"这轮看不到图"严重得多，所以改成字节校验后让模型自己决定发不发。
          let supported = true;
          try {
            for (const p of skillManager.getCapabilityProviders('image.mime-support', {})) {
              const r = p.fn({ mime });
              if (r && r.supported === false) supported = false;
              break;
            }
          } catch { /* 能力坏了不影响预览 */ }

          if (!supported) {
            return ok(`这张图是 ${mime}（约 ${Math.round(buffer.length / 1024)}KB）。当前视觉接口不支持 ${mime}，看不到画面内容，但字节已校验过是真图、QQ 里能正常显示。你觉得合适就直接调 send_image(url) 发出去（URL 照抄：${url}）。`);
          }
          return { content: imageParts(`这张图（${mime}，约 ${Math.round(buffer.length / 1024)}KB）——觉得合适就立刻调 send_image(url) 发出去：`, [`data:${mime};base64,${b64}`]) };
        }

        // 传 url 而不是只传 base64：OneBot 的 image 段原生支持 http 直链，让**协议端
        // 自己去下载**，body 从 MB 级降到几十字节。而 base64 内联走 HTTP body 时，
        // 5MB 的图（本工具 maxBytesMB 默认值）base64 后 6.7MB，很容易撞上发送超时，
        // 这正是"图画出来了但发不出去"的同一个根因。
        // `url` 是刚经 safe-fetch 校验并成功下载过的地址，交给协议端取是安全的。
        // 保留 dataUrl 作为回退：协议端取不到时（防盗链 / 协议端在别的机器）自动改用 base64。
        const result = await ctx.sender.sendImage(ctx.chatKey, { url, dataUrl: `base64://${b64}` }, {
          note: args.note,
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
        st.sent += 1;
        ctx.session.sent.push({
          type: 'image',
          text: `[图片${args.note ? `:${String(args.note).slice(0, 40)}` : ''}]`,
          at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
        });
        ctx.emit('session-update', ctx.session.id);
        return ok({ sent: true, messageId: result?.message_id ?? null, note: '图片已发送。' });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  registerTool({
    id: 'search_images',
    name: '搜索网图',
    description: '搜网图，直接拿到"能发的图片直链"。用法：先 search_images("关键词") 看列表，再挑一条用 send_image(url) 发出去。被要求"发张图/来点表情/找张照片"时用它。',
    category: 'web',
    icon: '🔎',
    requiresVision: false,
    requiresSearch: true,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词（越具体越准）' },
        limit: { type: 'integer', description: '最多返回几条，默认 8' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const cfg = getConfig();
        // 与 send_image 同一个总开关、同一套默认开启语义
        if (cfg.security?.imageSend?.enabled === false) {
          // 搜图与发图共用同一个总开关，文案必须说清这一点，
          // 否则用户会以为"联网搜索开关都开着，搜图却是坏的"。
          return err('搜图功能未开启。搜图与发网图共用同一个安全总开关（security.imageSend.enabled）：'
            + '请在 设置 → 聊天 →「📨 信息发送配置」里勾选「允许机器人发送网图」。');
        }
        const query = String(args.query ?? '').trim();
        if (!query) return err('query 不能为空');
        const limit = Math.min(12, Math.max(1, Number(args.limit) || 8));

        // 动态取图搜能力：特性检测，避免 web-search 缺这个函数时整个注册就崩
        let searchImages = null;
        try {
          const mod = await import('./web-search.js');
          searchImages = typeof mod.searchImages === 'function' ? mod.searchImages : null;
        } catch { /* 下面统一报错 */ }
        if (!searchImages) {
          return err('图搜能力不可用（web-search 里没有 searchImages）。请用 web_search 找图片页面，再用 web_fetch 拿 images。');
        }

        const list = await searchImages(query, { limit, browseLocked: browseLockState().enabled });
        if (!Array.isArray(list) || !list.length) {
          return ok({ query, results: [], note: '没搜到图。换个更具体的关键词再试一次（最多搜 3 次）。' });
        }
        return ok({
          query,
          results: list.slice(0, limit).map((r) => ({ title: String(r?.title ?? '').slice(0, 60), url: String(r?.url ?? '') })),
          note: '挑一条用 send_image(url) 发出去；url 要整条照抄，不要改。都不贴切就换个更具体的词再搜一次（最多搜 3 次）。'
        });
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });

  // ── 视频读取 ──
  registerTool({
    id: 'read_video',
    name: '读取视频',
    description: '读取消息里的视频。会返回时长/分辨率等元信息，并根据设置页的「视频模式」把画面交给模型：原生视频输入（全模态模型）或抽帧截图（普通视觉模型）。适用：群友发了一个视频，你想"看看"里面是什么。需要消息 id（聊天记录里的 #数字）。',
    category: 'query',
    icon: '🎬',
    requiresVision: false,
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '那条带视频的消息的 QQ 消息 id（聊天记录里的 #数字）' },
        frames: { type: ['integer', 'string'], description: '可选：本次要抽几帧（1~12）。不传用设置页的默认值。' }
      },
      required: ['messageId']
    },
    async execute(ctx, args) {
      try {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        const videoMedia = (entry.media || []).find((m) => m.kind === 'video');
        if (!videoMedia) return err('该消息没有视频（媒体里没有 video 段）');
        if (!ctx.videoReader) return err('视频读取服务未启用');
        const info = await ctx.videoReader.probe(videoMedia, { count: Number(args.frames) || 0 });

        // 元信息（不含画面）单独作为文本返回。
        // ⚠️ 必须把画面字段剥掉再序列化：把 frameDataUrl（base64 图片）塞进这个
        //    JSON 字符串，整张图会被当成**文本**送进上下文，模型既看不到图，
        //    又要为几十万 token 的 base64 付钱。画面一律走下面的 parts。
        const metaOut = {
          messageId: entry.mid,
          durationSec: info.durationSec,
          width: info.width,
          height: info.height,
          sizeBytes: info.sizeBytes,
          format: info.format,
          route: info.route,
          routeReason: info.routeReason,
          frameCount: Array.isArray(info.frames) ? info.frames.length : 0,
          frameTimes: info.frameTimes,
          note: info.note || '已读取视频信息。'
        };
        const metaText = JSON.stringify(metaOut, null, 1);

        // 原生视频输入：把视频地址作为 video 部分交给模型（由 llm.js 换成 videoModel）
        if (info.route === 'native' && info.nativeUrl) {
          return {
            content: [
              { type: 'text', text: `${metaText}\n\n（画面已作为视频输入发送）` },
              { type: 'video_url', video_url: { url: info.nativeUrl } }
            ]
          };
        }

        // 抽帧：每一帧作为一个 image 部分交给模型
        if (info.route === 'frames' && Array.isArray(info.frames) && info.frames.length) {
          return {
            content: [
              { type: 'text', text: `${metaText}\n\n（以下 ${info.frames.length} 张是抽帧截图，不是连续视频）` },
              ...info.frames.map((url) => ({ type: 'image_url', image_url: { url } }))
            ]
          };
        }

        // 只给元信息（off / 抽帧不可用 / 全模态模型没配）
        return ok(metaOut);
      } catch (error) {
        return err(error?.message ?? error);
      }
    }
  });
}

/** 解析 "HH:MM" 或 "YYYY-MM-DD HH:MM" 为时间戳；解析不了返回 null。 */
function parseAtTime(raw) {
  const s = String(raw || '').trim();
  // YYYY-MM-DD HH:MM；严格校验边界，避免 Date 把 2 月 31 日归一化成 3 月 3 日
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
    const hour = Number(m[4]), minute = Number(m[5]);
    const d = new Date(year, month - 1, day, hour, minute, 0, 0);
    if (month < 1 || month > 12 || hour > 23 || minute > 59
      || d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
      || d.getHours() !== hour || d.getMinutes() !== minute) return null;
    return d.getTime();
  }
  // HH:MM（今天；若已过则明天）
  m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const hour = Number(m[1]), minute = Number(m[2]);
    if (hour > 23 || minute > 59) return null;
    const now = new Date();
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);   // 今天已过 → 明天
    return d.getTime();
  }
  return null;
}

// ── required 为什么必须保留 ──────────────────────────────────────────────
//
// 症状：DeepSeek 系 OpenAI 兼容端点（Go 实现）里，**所有带 tools 的请求**稳定返回
//     400 Invalid schema for function '…': null is not of type 'array'。
//
// 原因是 Go 端把缺失字段 unmarshal 成 nil slice，再按 JSON Schema 校验时就变成 null。
// **"缺 required"与"required: null"在这类端点上完全等价，一律 400。**
// 报错只报 tools 数组里的**第一个**违规函数，所以修掉一两个工具没用，必须全量保证。
//
// 于是这里的行为反转：省 ~30 字符/工具去主动删掉 required: []，在那个端点上
// 等于亲手制造 400。改为一律保留，多出来的字符相对整份请求体是零头。

/** 这些槽位必须是数组；写成 null 时该约束直接删掉（语义上等于"没有这条约束"）。 */
const NULL_ARRAY_SLOTS = new Set(['enum', 'anyOf', 'oneOf', 'allOf', 'prefixItems', 'examples']);

/**
 * 规范化 schema：清掉可能被端点判定非法的形态。
 *   · required: null / 非数组：统一成数组（缺失的由 normalizeParameters 在顶层补）
 *   · enum/anyOf/oneOf/… 为 null：整键删除
 *   · properties: {} 保留。只补 required 时，这类端点会换报
 *     list_reminders: null is not of type "object"：它们对 properties 同样是
 *     "缺失 == null"，删空 properties 等于换一个字段继续 400。
 * 递归处理嵌套 items/oneOf 等；顺序稳定，不影响前缀缓存的逐字节一致性。
 */
function slimSchema(node) {
  if (Array.isArray(node)) return node.map(slimSchema);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (v === null && NULL_ARRAY_SLOTS.has(k)) continue;
    // required 一律保留（见上方注释）；null / 非数组兜成空数组。
    if (k === 'required') { out[k] = Array.isArray(v) ? v.map(slimSchema) : []; continue; }
    // properties 一律保留（含空对象），理由见上，删了会换报 "not of type object"。
    out[k] = slimSchema(v);
  }
  return out;
}

/**
 * 把工具的 parameters 兜成「任何 OpenAI 兼容端点都接受」的最小合法形态。
 * 插件/扩展注册的工具可以任意写（甚至 parameters: null），这里统一收口，
 * 一处兜底覆盖全部来源，不必逐个插件去改。
 */
function normalizeParameters(p) {
  const base = (p && typeof p === 'object' && !Array.isArray(p)) ? p : {};
  const out = slimSchema(base);
  if (typeof out.type !== 'string') out.type = 'object';
  if (!out.properties || typeof out.properties !== 'object' || Array.isArray(out.properties)) out.properties = {};
  if (!Array.isArray(out.required)) out.required = [];
  return out;
}

/**
 * 工具分区排序（前缀缓存优化）。
 *
 * tools 数组体积约 9k tok，位于请求体靠前位置（system 之后、messages 之前）。
 * 前缀缓存要求逐字节一致：数组里任意一个工具被增删，**它后面所有工具的位置全部
 * 后移**，缓存从变化点整段击穿（实测加载 1 个扩展 → 紧随的会话缓存从 98% 跌到 13%）。
 *
 * 分区规则（稳定 → 易变）：
 *   ① 核心区：内置工具（tools.js 静态注册，skillId 为 null）。随版本发布而变，
 *      运行期**永不变化** → 这部分前缀永久命中（token 大头）。
 *   ② 扩展区：插件/skill 注册的工具（带 skillId）。会随热重载增减，
 *      但**按固定规则排序**（skillId 字典序 → 工具 id 码点序）。
 *
 * 这样扩展增减只影响扩展区（尾部），核心区不再被击穿。扩展绝不与内置工具混排：
 * 混排会让新扩展把它后面的内置工具全部推走，核心区缓存照样断。
 *
 * ⚠️ 排序必须是**全序且确定**的：同一组工具不论注册先后（异步加载顺序会漂移），
 *    排出来的字节必须完全一致，否则每次重扫都抖动，等于没排。
 */
function toolSortKey(d) {
  const isBuiltin = !d.skillId;                       // 内置：tools.js 注册，skillId=null
  return isBuiltin ? '\u0000' : `\u0001${String(d.skillId ?? '')}`;
}
function compareToolOrder(a, b) {
  const ka = toolSortKey(a);
  const kb = toolSortKey(b);
  if (ka !== kb) return ka < kb ? -1 : 1;            // 核心区(内置) 恒在 扩展区 之前
  const ia = String(a.id ?? '');
  const ib = String(b.id ?? '');
  return ia < ib ? -1 : (ia > ib ? 1 : 0);           // 同区内按 id 码点升序（显式，去 locale 依赖）
}
export function toOpenAiTools(defs) {
  // ⚠️ 排序在**转换前**做，且不修改入参顺序（slice 复制）。
  //    出参顺序 = 发给模型的 tools 数组顺序 = 缓存键顺序。
  const ordered = [...(Array.isArray(defs) ? defs : [])].sort(compareToolOrder);
  return ordered.map((d) => ({
    type: 'function',
    function: {
      name: d.id || d.name,   // 优先用 id（英文标识），兼容旧版 name 字段
      description: d.description,
      parameters: normalizeParameters(d.parameters)
    }
  }));
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  // 兼容：name 可能是 id（英文）或 name（中文显示名）
  // id 优先（英文 function name 才是唯一键），显示名仅作兜底；
  // 避免两个工具中文名相同时被 find 误解析到第一个。
  let def = defs.find((d) => d.id === name) || defs.find((d) => d.name === name);
  // 第三档兜底：插件工具注册后的 id 带 `<skillId>__` 前缀，而提示词/模型输出偶尔
  // 只给裸名（如 `collect_sticker`）。精确匹配失败时做一次**唯一**后缀匹配：
  //   `sticker__collect_sticker` 的裸名就是 `collect_sticker`。
  // 只在恰好命中一个时才解析（多个同名工具宁可报错，也不能调错对象）。
  // 命中时留一条警告：这是提示词里工具名写错的信号，别让它继续静默。
  if (!def && typeof name === 'string' && !name.includes('__')) {
    const hits = defs.filter((d) => String(d.id || '').endsWith(`__${name}`));
    if (hits.length === 1) {
      def = hits[0];
      console.warn(`[tools] ⚠️ 模型调用了裸工具名 "${name}"，已按唯一后缀解析为 "${def.id}" —— 请检查该插件的提示词是否写漏了前缀。`);
    }
  }
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    // send_message 的参数写坏不能直接判死。实测会话里出现过
    // `{"messages": 行 那你鼓吧 我等着听}`：模型想发消息，但把正文当成未加引号的
    // JSON 值塞进去了。严格解析失败 → 整轮作废 → 群友什么都没收到，用户看到的就是
    // "机器人思考了但没回话"。只对发送类工具做**保守**修复（修不回来照旧报错），
    // 避免凭空发错内容。
    const repaired = name === 'send_message' ? repairSendMessageArgs(String(raw)) : null;
    if (repaired) {
      args = repaired;
    } else {
      return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
    }
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}

/**
 * send_message 参数 JSON 的宽松修复。
 *
 * 现场：模型把一整句话当成 JSON 值塞进去：{"messages": 行 那你鼓吧 我等着听}
 * 严格 JSON.parse 直接抛错 → 整轮作废 → 看似"思考后不说话"。
 *
 * 只做两种**不会发错内容**的修复：
 *   ① 参数就是一整段纯文本（没有 { ）→ 当成 { messages: 文本 }
 *   ② {"messages"/"text"/"content": <未加引号的一行文本>} → 抽出那段文本
 * 其它情况（乱码 / 多行结构损坏 / 带数组 / 引号错乱）一律不猜，照旧报错让模型重发。
 */
function repairSendMessageArgs(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (!s.startsWith('{')) return { messages: s };               // ① 纯文本
  const m = /^\{\s*"(messages?|text|content)"\s*:\s*([^\n{}]+?)\s*\}\s*$/.exec(s);
  if (!m) return null;
  let v = m[2].trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    // 外层有引号但整体仍解析失败 → 多半是内部有未转义引号，去掉外层按纯文本发
    v = v.slice(1, -1).replace(/\\"/g, '"');
  }
  v = v.replace(/^[']|[']$/g, '').trim();
  if (!v) return null;
  return { messages: v };
}

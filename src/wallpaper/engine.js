// 小红车壁纸（Wallpaper Engine）—— 内置模块 src/wallpaper/engine.js
// （2026-10-23 由「壁纸套件交接包」内置化，原 skills/wallpaper-engine 技能）：
// 注册工具，由模型判断什么时候用。
//
// 为什么是工具而不是确定性钩子：
//   换壁纸是"用户说了才做"的动作，必须经过模型理解"换张初音的看看"这种自然语言，
//   所以它应该是工具（进模型的 function 列表），而不是确定性钩子。
//
// 工具分三件，刻意不做成"一个万能 action"：
//   wallpaper_list     看/搜壁纸库（改名、换 id、找关键词都靠它）
//   wallpaper_set      换壁纸（按 id / 关键词 / 随机）
//   wallpaper_control  播放控制与状态（暂停、静音、下一张、隐藏图标、关闭、现在是什么）
//   分开的理由：参数 schema 各自简单，模型不容易漏参数；错误信息也能说清是哪一步坏的。
//
// 安全边界（都写在这里，不放给模型自行判断）：
//   · 只执行白名单里的 -control 动作（we.js 的 CONTROL_ACTIONS）
//   · 只接受壁纸库扫描出来的 project.json 路径，模型给不了任意文件路径
//   · 换壁纸前不弹窗、不写注册表、不动 WE 设置；失败只报错，不改任何东西

import fs from 'node:fs';
import path from 'node:path';
import { detectInstall, scanWallpapers, readCurrent, openWallpaper, nextWallpaper, runControl, isRunning, searchWallpapers, formatEntry, isSafeRating } from './we-control.js';

const DEFAULTS = {
  executable: '',        // 手填 wallpaper64.exe 或安装目录；空 = 自动探测
  sendPreview: true,     // 换完壁纸顺手把预览图发到聊天里
  previewRating: 'safe', // safe = 成人向壁纸不发预览图；all = 都发
  maxList: 30,           // 一次最多列几条
  cacheSeconds: 45       // 壁纸库扫描缓存（订阅新壁纸后最多等这么久）
};

let readConfig = () => DEFAULTS;
let skillApi = null;   // 留着给"设成软件主题背景"用（走 plugin 的能力，见 wallpaper.theme-sync）

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? Math.trunc(n) : min));
}

function cfg() {
  const raw = readConfig() || {};
  return {
    executable: String(raw.executable ?? '').trim(),
    sendPreview: raw.sendPreview !== false,
    previewRating: raw.previewRating === 'all' ? 'all' : 'safe',
    maxList: clamp(Number(raw.maxList) || DEFAULTS.maxList, 5, 60),
    cacheSeconds: clamp(Number(raw.cacheSeconds) || DEFAULTS.cacheSeconds, 5, 600)
  };
}

/** 探测安装位置 + 扫库，两个都会命中内部缓存，可以放心每次工具调用都调。 */
function loadLibrary() {
  const c = cfg();
  const install = detectInstall({ executable: c.executable });
  const list = scanWallpapers(install, { cacheSeconds: c.cacheSeconds });
  return { install, list };
}

/** 统一处理"没装 WE / 一张壁纸都没有"这两种环境问题，给出可执行的下一步。 */
function libraryUnavailable(install, list) {
  if (!install.ok) {
    return `小红车没就绪：${install.error || '没找到 Wallpaper Engine'}\n`
      + '（如果装在非常规位置，可以在控制台「壁纸」页的设置里填安装目录）';
  }
  return '';
}

function currentState(install, list) {
  try {
    return readCurrent(install, list);
  } catch {
    return null;   // 读不到 config.json 不影响换壁纸，只影响状态显示
  }
}

/**
 * 换完发预览图。
 * 预览图是 WE 工程目录里的 preview.gif/jpg，直接给本地路径让协议端自己读磁盘 ——
 * 比 base64 内联省两个数量级（见 sender.sendImage 的注释）。
 * 预览图太大或发送失败都不算换壁纸失败：图是锦上添花，不能反过来把主流程搞挂。
 */
async function sendPreview(ctx, entry, enabled) {
  if (!enabled) return { sent: false, reason: 'disabled' };
  if (!entry?.previewFile) return { sent: false, reason: 'no-preview' };
  if (!ctx?.sender?.sendImage || !ctx?.chatKey) return { sent: false, reason: 'no-sender' };
  // 成人向壁纸的预览图一律不自动发（配置里可显式放开）。
  // 这是唯一一处"宁可少做"的地方：换壁纸最多是换个桌面，发错图是号没了。
  if (!isSafeRating(entry) && cfg().previewRating !== 'all') return { sent: false, reason: 'adult' };
  if (entry.previewBytes > 12 * 1024 * 1024) return { sent: false, reason: 'too-big' };
  try {
    await ctx.sender.sendImage(ctx.chatKey, { file: entry.previewFile }, { note: String(entry.title || '').slice(0, 20) });
    return { sent: true };
  } catch (error) {
    return { sent: false, reason: String(error?.message ?? error) };
  }
}

/**
 * 把预览图读成 data URL（给模型"看"用）。
 *
 * 为什么不用本地路径：模型只认 data URL / http 链接；路径是给协议端读磁盘用的。
 * 4MB 上限是"看得清"和"别把上下文烧穿"之间的折中 —— 工坊预览图多是 1~3MB 的 GIF，
 * 更大的（4K 动图十几 MB）发出去只会让请求变慢甚至 400。
 */
function previewDataUrl(entry) {
  if (!entry?.previewFile) return '';
  if (entry.previewBytes > 4 * 1024 * 1024) return '';
  try {
    const ext = path.extname(entry.previewFile).toLowerCase();
    const mime = ext === '.gif' ? 'image/gif'
      : ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return `data:${mime};base64,${fs.readFileSync(entry.previewFile).toString('base64')}`;
  } catch {
    return '';
  }
}

/** 候选列表文案：找不到 / 有歧义时把选择权交回给模型（它再去问用户）。 */
function candidatesText(items, { title = '相近的有', limit = 6 } = {}) {
  const lines = items.slice(0, limit).map((x, i) => `${i + 1}. ${formatEntry(x.entry || x)}`);
  return `${title}：\n${lines.join('\n')}`;
}

export function setup(api) {
  if (api && typeof api.config === 'function') readConfig = api.config;
  skillApi = api;

  // ── 看 / 搜 ──────────────────────────────────────────────────────────────
  api.registerTool({
    id: 'wallpaper_list',
    name: '查看小红车壁纸库',
    description: '列出或搜索这台电脑上 Wallpaper Engine（小红车）已安装的壁纸。'
      + '用户问"你有哪些壁纸/有没有XX的壁纸/找张XX"，或者你不确定该换哪一张时调用。'
      + '返回每条的标题、类型和 id；把 id 交给 wallpaper_set 就能精确切换。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，可留空。支持中文标题片段（如"初音""甘雨"）、标签（如"像素""风景"）、或工坊 id。' },
        limit: { type: 'number', description: '最多返回几条，默认按技能设置（30），上限 60。' }
      }
    },
    async execute(_ctx, args) {
      try {
        const c = cfg();
        const { install, list } = loadLibrary();
        const bad = libraryUnavailable(install, list);
        if (bad) return { content: bad, isError: true };
        if (!list.length) return { content: '壁纸库里一张都没扫到（创意工坊 / 我的项目 / 官方项目都是空的）。', isError: true };

        const state = currentState(install, list);
        const currentId = state?.entry?.id || '';
        const query = String(args?.query ?? '').trim();
        const limit = clamp(Number(args?.limit) || c.maxList, 1, 60);

        const hits = query
          ? searchWallpapers(list, query).map((x) => x.entry)
          : list;

        if (!hits.length) {
          return {
            content: `没找到和「${query}」匹配的壁纸（库里共 ${list.length} 张）。\n`
              + '可以让用户换个更短的关键词，或者先列出全部看看。',
            isError: false
          };
        }

        const shown = hits.slice(0, limit);
        const lines = shown.map((e, i) => `${i + 1}. ${formatEntry(e, { current: e.id === currentId })}`);
        const more = hits.length > shown.length ? `\n（还有 ${hits.length - shown.length} 张没列出，用关键词缩小范围）` : '';
        return {
          content: `${query ? `「${query}」匹配到 ${hits.length} 张` : `共 ${list.length} 张壁纸`}：\n`
            + lines.join('\n')
            + `\n用 wallpaper_set 传 id（或关键词）切换。当前壁纸：${state?.entry?.title || '读取不到（Wallpaper Engine 可能没在跑）'}`
            + more
        };
      } catch (error) {
        return { content: `查壁纸库失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 换 ──────────────────────────────────────────────────────────────────
  api.registerTool({
    id: 'wallpaper_set',
    name: '换小红车壁纸',
    description: '把这台电脑的桌面壁纸换成 Wallpaper Engine 里的某一张。'
      + '用户说"换个壁纸/换张XX的/来个XX壁纸/随便换一张"时调用。'
      + '参数三选一：id（最精确）、query（关键词，如"初音"）、random=true（随机）。',
    category: 'media',
    icon: '🎨',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '壁纸 id，形如 workshop:3478434536。有它就不再按关键词猜。' },
        query: { type: 'string', description: '关键词，如"初音""甘雨""像素""星空"。用户说法直接当关键词用即可。' },
        random: { type: 'boolean', description: 'true = 从库里随机换一张（和当前不同的）。' },
        monitor: { type: 'string', description: '多显示器时指定屏幕，如 Monitor0；单屏不用填。' },
        preview: { type: 'boolean', description: '是否把预览图发到当前聊天，不填按技能设置。' }
      }
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        const { install, list } = loadLibrary();
        const bad = libraryUnavailable(install, list);
        if (bad) return { content: bad, isError: true };
        if (!list.length) return { content: '壁纸库里一张都没有，没法换。', isError: true };

        const state = currentState(install, list);
        const currentId = state?.entry?.id || '';
        const id = String(args?.id ?? '').trim();
        const query = String(args?.query ?? '').trim();
        const wantRandom = args?.random === true;

        // 先把目标定下来 ───────────────────────────────────────────────────
        let target = null;
        let note = '';

        if (id) {
          target = list.find((e) => e.id === id)
            || list.find((e) => e.id.toLowerCase() === id.toLowerCase())
            || list.find((e) => e.workshopId && e.workshopId === id);
          if (!target) {
            const byQuery = searchWallpapers(list, id).map((x) => x.entry);
            return {
              content: `id「${id}」不在壁纸库里（可能已取消订阅）。`
                + (byQuery.length ? `\n${candidatesText(byQuery.map((e) => ({ entry: e })))}` : '\n可以先用 wallpaper_list 看看有哪些。'),
              isError: false
            };
          }
        } else if (wantRandom) {
          const pool = list.filter((e) => e.id !== currentId);
          if (!pool.length) return { content: '壁纸库里只有这一张，没得随机。', isError: false };
          target = pool[Math.floor(Math.random() * pool.length)];
        } else if (query) {
          const hits = searchWallpapers(list, query);
          if (!hits.length) {
            return {
              content: `没找到和「${query}」匹配的壁纸（库里共 ${list.length} 张）。`
                + `\n可以让用户换个说法，或者先看看库里都有什么。`,
              isError: false
            };
          }
          target = hits[0].entry;
          if (hits.length > 1) {
            const others = hits.slice(1).filter((x) => x.entry.title !== target.title).slice(0, 3);
            note = `（「${query}」还匹配到 ${hits.length - 1} 张` + (others.length ? `，例如：${others.map((x) => x.entry.title.slice(0, 16)).join('、')}` : '') + '）';
          }
        } else {
          // 什么参数都没给：按"换一张随便的"处理。
          // 用户说"换个壁纸吧"时模型很可能就传个空对象，这里直接随机比让它再调一次好。
          const pool = list.filter((e) => e.id !== currentId);
          if (!pool.length) return { content: '壁纸库里只有这一张，没得换。', isError: false };
          target = pool[Math.floor(Math.random() * pool.length)];
        }

        if (target.id === currentId) {
          return { content: `现在用的就是「${target.title}」，没换。想换别的可以说个关键词。` };
        }

        // 真正换 ───────────────────────────────────────────────────────────
        const applied = await openWallpaper(install, target, { monitor: String(args?.monitor ?? '').trim() });
        if (!applied.ok) return { content: `换壁纸失败：${applied.error}`, isError: true };

        const previewWanted = args?.preview === undefined ? c.sendPreview : args.preview !== false;
        const preview = await sendPreview(ctx, target, previewWanted);

        const typeText = target.type ? `（${target.type}）` : '';
        const srcText = target.source === 'workshop' ? '创意工坊' : target.source === 'official' ? '官方自带' : '我的项目';
        const confirmText = applied.confirmed ? '' : '，Wallpaper Engine 还没把状态写回（可能还在加载）';
        return {
          content: `已把壁纸换成「${target.title}」${typeText}，来自${srcText}${confirmText}。`
            + (preview.sent ? '预览图已经发到聊天里了。' : '')
            + (preview.reason === 'too-big' ? '预览图太大，这次没发。' : '')
            + (preview.reason === 'adult' ? '（成人向壁纸，按设置没发预览图）' : '')
            + (note ? `\n${note}` : '')
            + '\n回复时一句话带过就行，不要复述这段文字，也不要解释参数。'
        };
      } catch (error) {
        return { content: `换壁纸失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 控制 / 状态 ──────────────────────────────────────────────────────────
  api.registerTool({
    id: 'wallpaper_control',
    name: '控制小红车壁纸播放',
    description: '暂停/继续/静音/下一张/隐藏桌面图标/关闭壁纸，查询"现在是什么壁纸"，'
      + '或者把当前壁纸的预览图拿出来看看。'
      + '用户说"壁纸暂停一下""静音壁纸""下一张""关掉壁纸""现在用的什么壁纸""给我看看现在这张"时调用。',
    category: 'media',
    icon: '⏯️',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'preview', 'pause', 'play', 'mute', 'unmute', 'next', 'hide_icons', 'show_icons', 'close'],
          description: 'status=查询当前壁纸；preview=把当前壁纸的预览图发出来（自己也能看到）；'
            + 'pause/play=暂停/继续；mute/unmute=静音/取消静音；next=下一张；'
            + 'hide_icons/show_icons=隐藏/显示桌面图标；close=关闭壁纸。'
        }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      try {
        const action = String(args?.action ?? '').trim();
        const { install, list } = loadLibrary();
        const bad = libraryUnavailable(install, list);
        if (bad) return { content: bad, isError: true };
        const state = currentState(install, list);

        if (!action || action === 'status') {
          const running = isRunning();
          const monitors = (state?.monitors || []).map((m) => `${m.monitor}: ${m.entry?.title || m.file}`);
          return {
            content: [
              `当前壁纸：${state?.entry?.title || '读不到（config.json 里没有记录）'}`,
              state?.entry ? `类型：${state.entry.type || '未知'}｜来源：${state.entry.source === 'workshop' ? '创意工坊' : state.entry.source === 'official' ? '官方自带' : '我的项目'}` : '',
              monitors.length > 1 ? `分屏：${monitors.join('；')}` : '',
              `Wallpaper Engine：${running ? '正在运行' : '没在运行（换壁纸时会自动拉起）'}`,
              `壁纸库：共 ${list.length} 张`
            ].filter(Boolean).join('\n')
          };
        }

        // preview：把当前壁纸的画面拿出来 —— 发给群里，同时作为图片交给自己看。
        // 这样"现在这张好不好看""给我看看现在这张"才回答得出来，而不是只会念标题。
        if (action === 'preview') {
          const entry = state?.entry;
          if (!entry) return { content: '读不到当前壁纸（Wallpaper Engine 可能还没启动过）。', isError: true };
          if (!isSafeRating(entry)) return { content: '当前这张是成人向壁纸，预览图不往外发。' };
          const dataUrl = previewDataUrl(entry);
          if (!dataUrl) return { content: `「${entry.title}」的预览图太大（或找不到），这次不发了。` };

          let sent = false;
          if (ctx?.sender?.sendImage && ctx?.chatKey) {
            try { await ctx.sender.sendImage(ctx.chatKey, { file: entry.previewFile }, { note: String(entry.title).slice(0, 20) }); sent = true; }
            catch { /* 发不出去不影响自己看 */ }
          }
          return {
            content: [
              { type: 'text', text: `当前壁纸：「${entry.title}」${sent ? '（预览图已发到聊天里）' : ''}。看清画面后用一两句话回应，别照着标题念。` },
              { type: 'image_url', image_url: { url: dataUrl } }
            ]
          };
        }

        if (action === 'next') {
          const r = await nextWallpaper(install, list, state?.entry || null);
          if (!r.ok) return { content: `换下一张失败：${r.error}`, isError: true };
          const via = r.via === 'playlist' ? '（按播放列表）' : '（没开播放列表，随机换了一张）';
          return { content: `下一张：已换成「${r.entry?.title || '未知'}」${via}。回复一句话就好，不要复述标题以外的内容。` };
        }

        const r = await runControl(install, action);
        if (!r.ok) return { content: `控制失败（${action}）：${r.stderr || `退出码 ${r.code}`}`, isError: true };
        const label = {
          pause: '已暂停壁纸', play: '已继续播放', mute: '已静音壁纸', unmute: '已取消静音',
          hide_icons: '已隐藏桌面图标', show_icons: '已显示桌面图标', close: '已关闭壁纸'
        }[action] || `已执行 ${action}`;
        return { content: `${label}。一句话回应就行，不要解释技术细节。` };
      } catch (error) {
        return { content: `控制壁纸失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 设成软件主题背景 ─────────────────────────────────────────────────────
  // 真正干活的是 theme.js（它还会每 intervalSec 秒自动跟一次）。
  // 这里只提供"现在这张，立刻同步过去"的手动入口，走 soft dependency（能力名），
  // 模块没加载上时工具会给出明确原因，而不是静默失败。
  api.registerTool({
    id: 'wallpaper_theme',
    name: '把当前壁纸设成软件主题背景',
    description: '把 QQ Agent 这个控制台窗口的背景换成小红车当前那张壁纸（小图会自动柔化）。'
      + '用户说"把这张设成你的背景/主题壁纸换成这个/你背景也换一下"时调用。',
    category: 'media',
    icon: '🪟',
    parameters: {
      type: 'object',
      properties: {
        force: { type: 'boolean', description: '默认 true：即使用户之前手动选过背景图，也覆盖成这张壁纸。' }
      }
    },
    async execute(_ctx, args) {
      try {
        if (typeof skillApi?.capability !== 'function') {
          return { content: '内部错误：能力接口不可用。', isError: true };
        }
        const r = await skillApi.capability('wallpaper.theme-sync', { force: args?.force !== false });
        if (!r) return { content: '主题背景同步功能没就绪（内置模块，重启一次 QQ Agent 试试）。', isError: true };
        if (r.ok) {
          return {
            content: r.changed
              ? `已把控制台窗口的背景换成「${r.title}」。一句话回应即可，不用念完整标题。`
              : `控制台背景已经是「${r.title}」了，没再动。`
          };
        }
        const why = r.skipped === 'mature'
          ? '这张是成人向壁纸，按设置不会拿来当界面背景（怕被人看到）。'
          : r.skipped === 'no-we' ? '没找到 Wallpaper Engine。'
            : r.skipped === 'follow-off' ? '主题跟随被关掉了（插件设置里「跟随小红车当前壁纸」）。'
              : `没同步成功：${r.error || r.skipped || '未知原因'}`;
        return { content: why, isError: r.skipped !== 'mature' };
      } catch (error) {
        return { content: `同步主题背景失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/** 别的技能想复用"换壁纸"能力时软依赖它（当前没有消费方，保留是为了以后能被组合）。 */
export const providers = {
  'wallpaper.apply': async ({ query = '', id = '', random = false } = {}) => {
    const c = cfg();
    const install = detectInstall({ executable: c.executable });
    if (!install.ok) return { ok: false, error: install.error };
    const list = scanWallpapers(install, { cacheSeconds: c.cacheSeconds });
    let target = id ? list.find((e) => e.id === id) : null;
    if (!target && query) target = searchWallpapers(list, query)[0]?.entry || null;
    if (!target && random && list.length) {
      const st = currentState(install, list);
      const pool = list.filter((e) => e.id !== st?.entry?.id);
      target = pool[Math.floor(Math.random() * pool.length)] || null;
    }
    if (!target) return { ok: false, error: '没找到匹配的壁纸' };
    const r = await openWallpaper(install, target);
    return r.ok ? { ok: true, entry: { id: target.id, title: target.title } } : { ok: false, error: r.error };
  }
};

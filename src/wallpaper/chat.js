// 「壁纸管家」（内置模块 src/wallpaper/chat.js —— 2026-10-23 由「壁纸套件交接包」
// 内置化，原 skills/wallpaper-chat 技能）：在 QQ 聊天里控制控制台壁纸。
//
// 架构：本部分只做「门禁 + 参数解析 + 调能力 + 广播」，真正的状态与
// 扫描都在同模块的 core.js（能力中介：wallpaper.library / wallpaper.state.*）。
// 换/调之后 ctx.emit('wallpaper-changed') 走 SSE 推给控制台，控制台
// 拉取新状态实时换背景 —— 机器人改壁纸，主人屏幕上立刻见效。
//
// 门禁：白名单 QQ 号（本模块设置里配置，空格/逗号分隔）。白名单为空 =
// 功能上锁，谁都不能用 —— 宁可锁着也不能裸奔（控制台是主人自己的屏幕）。
'use strict';

let cfg = () => ({});
let log = () => {};
let cap = () => undefined;

const ok = (payload) => ({ content: JSON.stringify(payload, null, 1) });
const err = (message) => ({ content: String(message), isError: true });

function whitelistOf() {
  return String(cfg()?.whitelist ?? '')
    .split(/[\s,，;；、]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 白名单校验：triggerSenderId 由 orchestrator 塞进工具上下文（2026-10-04）。 */
function allowed(ctx) {
  const uid = String(ctx?.triggerSenderId || '').trim();
  return !!uid && whitelistOf().includes(uid);
}

const DENY_NOTE = '操作者不在壁纸管家白名单里。请在控制台「壁纸」页的设置里把对方 QQ 号加进白名单。';

/** 标题模糊匹配：包含即命中，多命中取标题最短的（越短越接近原名）。 */
function pickByTitle(items, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return null;
  const hits = items.filter((it) => String(it.title || '').toLowerCase().includes(q));
  if (!hits.length) return null;
  return hits.sort((a, b) => a.title.length - b.title.length)[0];
}

export async function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});
  cap = api.capability || (() => undefined);

  api.registerTool({
    id: 'set',
    name: '换壁纸',
    description: '换控制台壁纸：按名字匹配壁纸库（title 为名字关键词，包含即命中），或 random=true 随机换一张。成功后控制台立刻生效。',
    category: 'utility',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '壁纸名字关键词（如「Miku」「星空」）；对方没指定或要求随便换时可不填' },
        random: { type: 'boolean', description: 'true = 从壁纸库里随机挑一张；与 title 二选一' }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        if (!allowed(ctx)) return ok({ not_allowed: true, note: DENY_NOTE });
        const lib = await cap('wallpaper.library');
        if (!lib?.ok || !Array.isArray(lib.items) || !lib.items.length) {
          return err(`壁纸库不可用：${String(lib?.error || '库是空的')}`);
        }
        let chosen = null;
        if (String(args.title || '').trim()) {
          chosen = pickByTitle(lib.items, args.title);
          if (!chosen) {
            return ok({ found: false, note: `壁纸库里没有名字含「${String(args.title).trim()}」的壁纸。可让对方换个说法，或用 wallpaper__list 查库里有什么。` });
          }
        } else if (args.random) {
          chosen = lib.items[Math.floor(Math.random() * lib.items.length)];
        } else {
          return err('title 与 random 至少给一个');
        }
        const prev = (await cap('wallpaper.state.get'))?.cfg || null;
        const r = await cap('wallpaper.state.set', {
          cfg: {
            id: chosen.id, title: chosen.title, kind: chosen.kind,
            blur: Number(prev?.blur ?? 18), dim: Number(prev?.dim ?? 0.25),
            monet: prev?.monet !== false, fit: prev?.fit || 'smart'
          }
        });
        if (!r?.ok) return err('壁纸状态写入失败');
        ctx.emit('wallpaper-changed', {});
        log(`换壁纸：${chosen.title}（由 ${ctx.triggerSenderId || '?'} 指示）`);
        return ok({ done: true, wallpaper: chosen.title, kind: chosen.kind });
      } catch (e) {
        return err(`换壁纸失败：${String(e?.message ?? e)}`);
      }
    }
  });

  api.registerTool({
    id: 'adjust',
    name: '调壁纸效果',
    description: '调整当前壁纸的模糊（blur，0~40，越大越糊）与压暗（dim，0~70，越大越暗）。只传要改的项，另一项保持不变。',
    category: 'utility',
    icon: '🎚️',
    parameters: {
      type: 'object',
      properties: {
        blur: { type: 'number', description: '模糊强度 0~40（像素）。对方说「太糊/调清晰」→ 调小，「梦幻一点」→ 调大' },
        dim: { type: 'number', description: '压暗程度 0~70（百分比）。对方说「太暗」→ 调小，「太亮/晃眼」→ 调大' }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        if (!allowed(ctx)) return ok({ not_allowed: true, note: DENY_NOTE });
        const cur = (await cap('wallpaper.state.get'))?.cfg;
        if (!cur?.id) return ok({ note: '当前没开壁纸，先换一张再调效果。' });
        const next = { ...cur };
        if (args.blur !== undefined) next.blur = Math.max(0, Math.min(40, Math.round(Number(args.blur))));
        if (args.dim !== undefined) next.dim = Math.max(0, Math.min(70, Math.round(Number(args.dim))));
        if (args.blur === undefined && args.dim === undefined) return err('blur 与 dim 至少给一个');
        const r = await cap('wallpaper.state.set', { cfg: next });
        if (!r?.ok) return err('壁纸状态写入失败');
        ctx.emit('wallpaper-changed', {});
        return ok({ done: true, blur: r.cfg.blur, dim: Math.round(r.cfg.dim * 100) });
      } catch (e) {
        return err(`调壁纸失败：${String(e?.message ?? e)}`);
      }
    }
  });

  api.registerTool({
    id: 'off',
    name: '关壁纸',
    description: '关闭控制台壁纸（恢复默认纯色背景）。设置与效果参数保留，下次换壁纸仍在。',
    category: 'utility',
    icon: '🚫',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(ctx) {
      try {
        if (!allowed(ctx)) return ok({ not_allowed: true, note: DENY_NOTE });
        const r = await cap('wallpaper.state.set', { cfg: null });
        if (!r?.ok) return err('壁纸状态写入失败');
        ctx.emit('wallpaper-changed', {});
        return ok({ done: true, note: '壁纸已关' });
      } catch (e) {
        return err(`关壁纸失败：${String(e?.message ?? e)}`);
      }
    }
  });

  api.registerTool({
    id: 'list',
    name: '查壁纸库',
    description: '列出壁纸库里的壁纸名字（最多 40 条），供挑壁纸或回答「有什么壁纸」用。',
    category: 'utility',
    icon: '📋',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(ctx) {
      try {
        if (!allowed(ctx)) return ok({ not_allowed: true, note: DENY_NOTE });
        const lib = await cap('wallpaper.library');
        if (!lib?.ok) return err(`壁纸库不可用：${String(lib?.error || '未知错误')}`);
        const titles = (lib.items || []).slice(0, 40).map((it) => it.title);
        return ok({ count: lib.count, titles });
      } catch (e) {
        return err(`查壁纸库失败：${String(e?.message ?? e)}`);
      }
    }
  });
}

export function available(api) {
  // 硬依赖 wallpaper 插件的能力（manifest.requires 也声明了，双保险）。
  return { ok: !!(api?.hasCapability ? api.hasCapability('wallpaper.state.get') : true) };
}

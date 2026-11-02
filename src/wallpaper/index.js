// 内置壁纸模块（src/wallpaper/）—— 2026-10-23 由「QQ-Agent壁纸套件-交接包」内置化。
//
// 原形态是 4 个独立插件/技能（plugins/wallpaper、plugins/wallpaper-theme、
// skills/wallpaper-chat、skills/wallpaper-engine），按用户要求「不进插件，直接
// 内置进洛版」合并为**一个** core 模块：不走插件目录扫描、不进
// builtin-modules 基线、不出现在插件/Skill 列表、不可禁用
// （manifest.kind='core'，注册见 src/harness/index.js 的 MODULES）。
//
// 四个部分（彼此独立，可单独删文件 + 从下面摘掉对应 import/providers）：
//   core.js        壁纸库/文件伺服/状态镜像/动态导入 —— 7 个能力，控制台「壁纸」页的后端
//   theme.js       主题跟随：每隔几秒读小红车当前壁纸 → 复制预览进 data/ui/ → 写 config.ui.bgImage
//   chat.js        「壁纸管家」：QQ 聊天里换/调/关/查**控制台**壁纸（白名单门禁）
//   engine.js      「小红车」：QQ 聊天里换/控**桌面**壁纸（WE -control 通道）
//   lib/           动态壁纸管线（ffmpeg 录制/无缝循环）与场景渲染窗，core.js 专用
//   we-control.js  桌面侧控制层（-control + 壁纸库扫描 + 当前壁纸解析），engine.js 专用
//
// 依赖方向：界面背景 ← theme.js ← 读 core.js 的库；QQ 侧两部分 ← 调 core.js 的能力。
// 工具名（registerTool 自动加 wallpaper__ 前缀，sanitize 后仍是合法 function name）：
//   wallpaper__set / wallpaper__adjust / wallpaper__off / wallpaper__list
//   wallpaper__wallpaper_list / wallpaper__wallpaper_set / wallpaper__wallpaper_control / wallpaper__wallpaper_theme
//
// ⚠️ 改本目录下任何文件都要**重启应用**才生效（core 模块不热重载，这是内置化的
//    已知代价，见 harness/index.js 头注释）。
import * as core from './core.js';
import * as theme from './theme.js';
import * as chat from './chat.js';
import * as engine from './engine.js';

/** 全部能力。四部分命名互不重叠，合并顺序无所谓。 */
export const providers = {
  ...core.providers,
  ...theme.providers,
  ...engine.providers
};

// ── 对话侧开关（2026-10-24）─────────────────────────────────────────────
//
// 壁纸的定位是**软件自带功能**（控制台壁纸页 + 背景跟随），不是对话能力。
// 但内置化时把聊天侧的 8 个工具和 2 段提示词一起注册了，代价是每次 LLM 调用
// 固定 **1358 tok**：提示词 1021 字符 ≈ 406 tok（`▸ 壁纸管家` + `▸ 小红车壁纸`）
// + 8 个工具定义 ≈ 952 tok。而这两段的内容与工具 description 高度重复
// （engine.js 每个工具描述里都写了"用户说换个壁纸时调用"），实测 7 天 56 次
// 调用中聊天侧工具调用 **0 次**（白名单还没配，功能本来就是锁的）—— 纯占位。
//
// 所以默认：只留 core + theme（控制台侧），chat/engine 的工具**不注册**、
// 提示词段**不注入**。要恢复"群里换壁纸"，控制台「壁纸」页底部勾选
// 「聊天里可控制壁纸」（config.skills.wallpaper.llmControl），然后**重启应用**
// （core 模块不热重载，这是已知代价）。
//
// ⚠️ 不要改成"按消息关键词动态增删段"：那会让 systemPrompt 翻字，
//    击穿前缀缓存，比常驻更贵（见 src/harness/doctor/cache-attribution.js）。
let llmExposed = false;

/** 当前是否把壁纸能力暴露给模型（供体检/排障读取，不参与业务判断）。 */
export function llmToolsEnabled() { return llmExposed; }

/**
 * 初始化四部分。每部分单独 try——harness 的 registrar 对 setup 抛错是整模块判死的，
 * 一部分炸掉不该让整个壁纸模块注册失败（比如某天 lib/ 缺文件，至少另外三部分还能用）。
 *
 * ⚠️ 关闭对话侧时**仍然执行** chat/engine 的 setup：它们在这里绑 config 与
 *    capability（engine 的 `wallpaper.apply` 能力照常可用，只是模型看不到工具）。
 *    只把 registerTool 换成空实现 —— 工具不落地到注册表，就永远不会进 tools 数组。
 */
export function setup(api) {
  let flag = false;
  try { flag = api?.config?.()?.llmControl === true; } catch { flag = false; }
  llmExposed = flag;
  const toolApi = flag ? api : { ...api, registerTool: () => null };

  const parts = [['core', core, api], ['theme', theme, api], ['chat', chat, toolApi], ['engine', engine, toolApi]];
  for (const [name, mod, target] of parts) {
    try {
      const r = mod.setup?.(target);
      // chat.js 的 setup 是 async（体内全同步，promise 立即落定）—— 兜底接住拒绝
      if (r && typeof r.catch === 'function') {
        r.catch((e) => api.error?.(`[wallpaper] ${name} 初始化失败：${e?.message ?? e}`));
      }
    } catch (e) {
      api.error?.(`[wallpaper] ${name} 初始化失败：${e?.message ?? e}`);
    }
  }
}

// 主题跟随的定时器生命周期（其余三部分无进程级状态）
export function activate(ctx) { theme.activate?.(ctx); }
export function deactivate(ctx) { theme.deactivate?.(ctx); }
export function dispose() { theme.dispose?.(); }

/**
 * 提示词片段（原两个技能 skill.json 里的 prompt.sections，内置化后改为函数式动态段，
 * 由 skills/manager.js 的 getPromptSections 收集）。
 *
 * ⚠️ 默认返回**空数组**：壁纸是控制台功能，不是对话能力（详见上面 llmExposed 的注释）。
 *    只有 config.skills.wallpaper.llmControl === true 时才注入这两段 —— 也就是说
 *    "要让模型看见"，必须和工具注册同时打开，不能只开一半（只有段没有工具时，
 *    模型会被告知"你会换壁纸"却调不到函数，容易嘴上答应）。
 *
 * ⚠️ 内容保持**静态**：不读配置、不带易变信息。它是系统提示里的稳定段，每次请求
 *    字节相同才能吃前缀缓存；工具的门禁（白名单）在 execute 里做，不靠在这里增减段。
 * ⚠️ 段 id 沿用原技能的两个（wallpaper-chat-note / wallpaper-engine），
 *    排障时能和对面对照。
 */
export function promptSections() {
  if (!llmExposed) return [];
  return [
    {
      id: 'wallpaper-chat-note',
      title: '壁纸管家',
      priority: 35,
      content:
        '群友说「换壁纸」「来张XX壁纸」「壁纸太糊了/调清晰点」「太暗了/亮点」「关掉壁纸」「有什么壁纸」时调用壁纸管家工具（控制台界面背景，不是桌面）。'
        + '换壁纸优先按对方说的名字用 wallpaper__set 匹配；只说「随便换一张」就 random=true；问库存用 wallpaper__list 再挑。'
        + '调效果用 wallpaper__adjust（blur=0~40 模糊像素，dim=0~70 压暗百分比）。'
        + '工具返回 not_allowed 时说明操作者不在白名单，如实转告（可提醒主人在控制台「壁纸」页的设置里加白名单），不要道歉装作已执行。'
        + '改完简短确认即可，不用长篇解释。'
    },
    {
      id: 'wallpaper-engine',
      title: '小红车壁纸',
      priority: 60,
      content:
        '你能控制这台电脑的桌面壁纸（Wallpaper Engine / 小红车）。\n'
        + '工具：wallpaper__wallpaper_list 看/搜壁纸库，wallpaper__wallpaper_set 换壁纸（id、关键词或 random），wallpaper__wallpaper_control 暂停/继续/静音/下一张/隐藏图标/关闭/查当前。\n'
        + '只有在别人明确提出要求时才动手（"换个壁纸""换张初音的""壁纸暂停一下""现在是什么壁纸"）。没人提就别自己换，也别在闲聊里顺手换——那是主人的桌面。\n'
        + '有人说"换张XX的"就直接用 wallpaper__wallpaper_set 的 query 参数，不要先列一遍；只有不确定库里有没有才用 wallpaper__wallpaper_list 查。\n'
        + '换完一句话带过（"换好啦" / "现在是小林家的猫"），不要念完整标题、不要提 id、路径、参数或工具名。\n'
        + '有人问"现在用的是什么壁纸"用 wallpaper__wallpaper_control 的 status；说"给我看看现在这张"就用它的 preview（会把画面发给你看，也发到群里），看完用一两句话说说画面，别只念标题。\n'
        + '有人让你把壁纸设成"你的背景/主题背景"时，用 wallpaper__wallpaper_theme 把当前这张同步成控制台窗口的背景（主题跟随模块会自动同步，这个工具是手动立刻同步一次）。\n'
        + '成人向（墙上标着 18+）的壁纸可以换，但不要描述画面细节、不要主动说尺度、也不要把预览图再要求发一遍——代码层面已经不会自动发。\n'
        + '多个人同时要换时按最新那条做，别来回抢；换不动就直说没换成功，别编。'
    }
  ];
}

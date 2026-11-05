// 二次元随机图片（LLM 型）：注册工具供模型调用。
//
// 本模块在 skills/ 下，属于 LLM 型（由模型决定何时发图），必须有 registerTool；
// 只提供 image.random 能力是没人消费的（核心不认这个能力名）。
// 能力仍然保留：别的模块想复用取图逻辑时可以软依赖它。
import fs from 'node:fs';
import { runSetuRequest } from './setu.js';
import { sweepTmp } from './downloader.js';
import { setLogger } from './log.js';
import { DEFAULT_SETU_BASE_URL, SETU_NSFW_SORT, SETU_SFW_SORT } from './config.js';
// 内容分级是全局策略，内置技能直接读核心配置（与 skills/schedule 同一先例）。
// 全项目只有 src/content-rating.js 定义档位与派生规则，这里不再自己判断。
import { currentContentRating, ratingRule } from '../../src/content-rating.js';

let getConfig = () => ({
  maxCount: 3,
  maxImageBytes: 4 * 1024 * 1024,
  source: 'auto',
  // 与 skill.json 的 settings.apiBaseUrl 保持一致（JSON 引不到 JS 常量）
  apiBaseUrl: DEFAULT_SETU_BASE_URL
});
let skillApi = null;

/**
 * 取图接口地址的唯一解析处。
 *
 * 界面的 configSchema 是扁平键表（ui/app/06-settings-render.js 用 values[key] 直取、
 * 保存时写 settings[key] = el.value），写 "api.baseUrl" 这种带点的键会被当成字面量键名，
 * 而代码读的是嵌套对象，永远读不到 —— 这正是「随机发图必报 baseUrl 非法」的根因。
 * 所以配置键只有扁平键 apiBaseUrl，内部统一映射成运行期的 api.baseUrl。
 * 空串不算有效值（界面清空输入框时不应把地址改成一个空字符串）。
 */
function resolveApiBaseUrl(raw) {
  const flat = String(raw.apiBaseUrl ?? '').trim();
  return flat || DEFAULT_SETU_BASE_URL;
}

/**
 * 把技能配置归一成运行期 cfg 形状（纯函数，可单测）。
 * api 对象（baseUrl / sort / 超时）只在这里构造一次，其余模块只读不拼。
 *
 * 内容分级来自全局策略（security.contentRating），不是技能私有配置：
 * 这里只把它折算成运行期需要的两个派生值，判断规则一律走 ratingRule()。
 *
 * @param {object} raw    getSkillConfig() 的浅合并结果（扁平键表）
 * @param {string} rating 全局内容分级档位（默认读当前配置）
 */
export function normalizeConfig(raw = {}, rating = currentContentRating()) {
  const maxCount = Math.min(10, Math.max(1, Math.trunc(Number(raw.maxCount) || 3)));
  const maxImageBytes = Math.min(4 * 1024 * 1024, Math.max(1, Math.trunc(Number(raw.maxImageBytes) || 4 * 1024 * 1024)));
  const source = ['auto', 'pixiv', 'local'].includes(raw.source) ? raw.source : 'auto';
  // 其余 api.* 键（超时等）仍是 programmatic 覆盖位；baseUrl 只认扁平键（见 resolveApiBaseUrl）
  const rawApi = raw.api || {};
  const api = {
    ...rawApi,
    baseUrl: resolveApiBaseUrl(raw),
    nsfwSort: rawApi.nsfwSort || SETU_NSFW_SORT,
    sfwSort: rawApi.sfwSort || SETU_SFW_SORT
  };
  const booru = raw.booru || {};
  // 「色图」请求本身是否放行 = 策略是否放行 R-18（只有 all 档）。逐图分级过滤在
  // pixiv.js 用同一张表执行，这里只是给「用户点名要色图」这一层做前置判断。
  const nsfwAllowed = !ratingRule(rating).blockR18;
  return {
    enabled: true,
    api,
    contentRating: rating,
    booru: { ...booru, enabled: source !== 'local' && booru.enabled !== false },
    send: { ...(raw.send || {}), count: maxCount, maxImageBytes, nsfwAllowed, sfwAllowed: true },
    // 分会话色图白名单是「哪些会话能收色图」这条独立轴：rating !== 'all' 时开启，
    // 群聊点名要色图会被 resolveNsfw 降级成无色图（fallbackToSfw 默认生效）；
    // rating === 'all' 时不做分会话限制，与旧 safeMode=false 的语义一致。
    nsfwFilter: { ...(raw.nsfwFilter || {}), enabled: rating !== 'all' },
    chatFilter: raw.chatFilter
  };
}

function normalizedConfig() {
  return normalizeConfig(getConfig() || {});
}

/**
 * 把取图结果转成"能交给 ctx.sender.sendImage 的形式"。
 *
 * 入参**必须**是 downloader.js 的 downloadImage 契约形状（file / payload）。
 * 导出仅为单测：providers 的输出键一旦与这里不一致，结果恒为 null，
 * 表现为"取图成功却报图片读取失败"（真实发生过的故障）。
 */
export async function toSendable(image) {
  const src = String(image?.file || image?.payload || '').trim();
  if (!src) return null;
  if (src.startsWith('base64://') || /^https?:/i.test(src)) return src;
  // 本地临时文件：读成 base64，避免依赖 OneBot 端能不能解析本机路径
  try {
    const buf = await fs.promises.readFile(src);
    return `base64://${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export function setup(api) {
  if (api && typeof api.config === 'function') getConfig = api.config;
  // 日志出口：核心注入的 api.log/warn/error 会走 logger（落盘 + 分级 + 脱敏）。
  // 没有注入时保持静默，取图主流程不受影响。
  setLogger({ info: api?.log, warn: api?.warn, error: api?.error });
  // 启动时清一次过期临时图。sweepTmp 原本只在 savePayload 里调用，
  // 意味着「不发图就不清理」——长期闲置的实例会把上次会话残留的临时图
  // 一直留在磁盘上（实测一次使用可留 6.5MB）。这里补一次，语义与发图时相同。
  sweepTmp();
  // 走能力取图：本模块自己提供 image.random，工具通过 api.capability 取用，
  // 保证"取图逻辑"只有一份实现（也避免能力因为没有消费方被审计判为孤儿）。
  skillApi = api;

  api.registerTool({
    id: 'random_image',
    name: '发二次元随机图',
    description: '随机取若干张二次元插画并发到群里。当用户说"来张图/涩图/随机图/二次元图"，或要求"发点好看的图"时使用。可传关键词缩小范围（如"猫娘""风景"）。',
    category: 'media',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词，可选。如"猫娘""风景""白发"。不填则完全随机。' },
        count: { type: 'number', description: '要几张，1~10，不填用设置里的默认值（默认 3）。' }
      }
    },
    async execute(ctx, args) {
      try {
        const cfg = normalizedConfig();
        const want = Math.min(
          cfg.send.count,
          Math.max(1, Math.trunc(Number(args?.count) || cfg.send.count))
        );

        if (!skillApi?.capability) return { content: '内部错误：能力接口不可用', isError: true };
        const r = await skillApi.capability('image.random', { count: want, tags: String(args?.keyword || '').trim() });
        if (!r?.ok || !(r.images || []).length) {
          return { content: `没取到图：${r?.error || '未知原因'}`, isError: true };
        }

        let sent = 0;
        const errors = [];
        for (const image of r.images) {
          const dataUrl = await toSendable(image);
          if (!dataUrl) { errors.push('图片读取失败'); continue; }
          try {
            // rating 是这张图的分级声明（搜索阶段从 Pixiv 元数据得出）：
            // 交给核心的统一闸门，超过全局内容分级策略会被拒发。
            await ctx.sender.sendImage(ctx.chatKey, { dataUrl }, { note: args?.keyword || '', rating: image?.rating });
            sent += 1;
            // 预览地址由核心签发（不要在扩展里拼 URL）。image.file 是下载器写进
            // setu-tmp 的绝对路径；base64 模式下没有本地文件，src 为空 → 文字徽标。
            const src = typeof skillApi?.localImageSrc === 'function' && image?.file
              ? skillApi.localImageSrc('setu', String(image.file), ctx)
              : null;
            ctx.session?.sent?.push({
              type: 'image',
              text: `[随机图${args?.keyword ? `:${String(args.keyword).slice(0, 20)}` : ''}]`,
              at: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
              src
            });
          } catch (error) {
            errors.push(String(error?.message ?? error));
          }
        }
        if (!sent) return { content: `图片发送失败：${errors.join('；') || '未知原因'}`, isError: true };

        ctx.emit?.('session-update', ctx.session?.id);
        return { content: `已发送 ${sent} 张${args?.keyword ? `「${args.keyword}」` : ''}图片。不要再复述图片内容，按用户的话自然回应即可。` };
      } catch (error) {
        return { content: `发图失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/**
 * runSetuRequest 结果 → provider 返回值的唯一映射处（纯函数，可单测）。
 *
 * 字段名必须与 toSendable 的读取处一致（file / payload）：这里曾映射成 { url }，
 * 而 toSendable 只读 image.file / image.payload，于是 src 恒为空 →
 * 「图片读取失败」。取图成功却发不出去，用户看到的就是这个报错。
 * 两边共用同一组键，不再各自起名。
 *
 * rating 原样透出：调用方发图时要把它作为分级声明交给核心闸门。
 */
export function buildProviderResult(result) {
  if (result?.outcome !== 'ok') {
    return { ok: false, images: [], error: result?.message || result?.outcome || 'image unavailable' };
  }
  return {
    ok: true,
    images: (result.images || []).map((image) => ({ file: image.file, payload: image.payload, rating: image.rating }))
  };
}

// 能力保留：别的模块/技能想复用取图逻辑时可软依赖
export const providers = {
  'image.random': async ({ count, tags } = {}) => {
    const cfg = normalizedConfig();
    const wanted = cfg.send.nsfwAllowed ? 'nsfw' : 'sfw';
    const result = await runSetuRequest({
      cfg: { ...cfg, send: { ...cfg.send, count: Math.min(cfg.send.count, Math.max(1, Math.trunc(Number(count) || cfg.send.count))) } },
      chatKey: '', requested: wanted, keyword: String(tags || '').trim()
    });
    return buildProviderResult(result);
  }
};

export function available() { return { ok: true }; }

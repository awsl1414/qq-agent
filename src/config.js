// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS, LEGACY_XIAOJINGYU_TEXT } from './personas.js';
import { sliderToTier } from './tier-slider.js';   // 零依赖模块，避免循环依赖

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
// 测试/便携场景可重定向数据目录。
// 多实例 PROFILE：QQ_AGENT_PROFILE=2 时数据目录变成 data-2/、端口整体 +100，
// 同一台机器可以跑两个机器人实例（两个 QQ 号）而不互相踩。
// 优先级：QQ_AGENT_DATA_DIR（显式覆盖）> PROFILE 推导 > 默认 data/
//
// 必须在这里就生效（而不是在 UI 或 app.js 里改）：DATA_DIR 是整个进程的根路径，
// 配置、会话、记忆、表情库全挂在它下面。晚一步设置就会有一部分文件写到主实例的
// 目录里，造成两个实例数据互相污染。
import { profileSuffix, portOffset } from './profile.js';

// 用 https：http 版 301 跳转且明文传输可被 MITM 篡改成本展示。
export const FIXED_PRICE_REMOTE_URL = 'https://kondius.cn/qq-agent/model-prices.json';
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, `data${profileSuffix()}`);
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    // 网络代理（可选）：接入国外大模型 API 时填写，如 http://127.0.0.1:7890。
    // 只作用于 LLM 链路（对话/模型列表/连通性探测），仅支持 http:// 代理
    // （undici ProxyAgent 边界，socks5 明确提示不支持）。留空 = 直连。
    // 网页阅读（safe-fetch）与 OneBot 协议端不受此项影响。
    proxy: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    // 备选模型列表：主模型在重试后仍失败时，逐个用备选模型重试直至成功。
    // 每项 { model, provider? }：provider 留空则沿用主模型的 provider/baseUrl/apiKey；
    // 填了 provider 则切到该提供商（用它的 baseUrl + Key）。按顺序尝试。
    fallbackModels: [],
    // 按输入类型分开选择模型（可选）：留空则都用上方主模型 api.model。
    // 图片/视频输入需要模型支持对应模态；文字输入用纯文本模型即可（可省成本）。
    // llm.js 检测到请求里带图片/视频部分时会用对应字段的模型替换主模型
    // （仅主调用路径；记忆整理/备选模型降级不受影响）。
    visionModel: '',            // 图片输入专用模型（留空 = 用主模型）
    videoModel: '',             // 视频输入专用模型（留空 = 用主模型）
    // 视频走哪条路。两条路互斥，不会同时喂：同时喂等于同一内容重复计费，
    // 而且多数网关会因格式冲突直接 400。
    //   auto   配了 videoModel 就认为你有全模态模型 → 原生读视频；否则抽帧；
    //          抽帧 Skill 不可用（没装 ffmpeg）就只给元信息
    //   native 强制原生视频输入（把视频地址作为 video 部分发给模型）
    //   frames 强制抽帧（把视频变成若干张图片，任何视觉模型都能用）
    //   off    不喂画面，只给时长/分辨率等元信息（纯文本模型 / 省 token）
    videoMode: 'auto',
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    // 视频输入（模型能不能吃 video 部分）。与 vision 相互独立：
    //   勾了 vision + video → 有人发 GIF 动图时，用 ffmpeg 转成 ≤480px / ≤24 帧的
    //                        mp4，按 video 部件发给模型（llm.js 自动切 videoModel）
    //   勾了 vision 没勾 video → GIF 按图片原样发（部分视觉模型能直接读动图）
    //   没勾 vision → 看图工具整个不存在，GIF 自然也看不到
    // 默认关闭：猜错"模型支持视频"的代价是请求 400，比不启用更糟。
    video: false,
    temperature: 0.8,
    maxRounds: 12,                          // 单次运行的最多工具轮数
    timeoutMs: 180000,
    // 思考强度（设置页-模型 API 区的口径；实际落成各厂商参数由 thinking-adapters 插件负责）：
    //   thinkingMode   off/auto/on：off=能思考的模型也明确关闭，on=按渠道发开启参数
    //   thinkingEffort low/medium/high：推理强度，仅 OpenAI o 系 / OpenRouter 生效
    //   thinkingBudget token 数：思考预算，仅 Claude 兼容 / 部分网关生效，0=不指定
    // 目的：防"雷霆大思考"（几千 token 的 reasoning 拖慢且烧钱）或该思考的完全不思考。
    thinkingMode: 'auto',
    thinkingEffort: '',
    thinkingBudget: 0,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token），兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表地址由 src/community.js 固定为官网公开表；此字段仅为历史配置兼容保留。
    // UI 不再展示或写入它，避免用户/页面改到错误地址。
    priceRemoteUrl: FIXED_PRICE_REMOTE_URL,
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高：一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  providersImported: true,
  // 联网搜索（默认 Bing 网页解析，无需 key；可选 DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    maxResults: 6,
    // 可选：'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    provider: 'bing',
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    }
  },
  // ── 插件信任名单 ──
  // 插件以 import() 直接进主进程执行，与主进程共享同一个 process。permissions
  // 白名单只拦得住 fetch，fs / child_process 是插件自己 import 的，权限层碰不到。
  // 所以「装一个插件」=「把本机权限交给它」。
  //
  // 随应用分发的内置插件由 plugin-loader.js 按 builtin-modules.json 的指纹基线放行；
  // 第三方插件若 import 高危模块（fs/child_process/net/vm…）或触碰凭据文件，
  // 默认拒绝加载，需要在这里显式登记它的目录名才能装
  // （控制台卡片上的「信任并重试」/「一键信任全部」就是往这里写）。
  // 这层不做沙箱（那需要 worker_threads / 子进程隔离），只把信任边界显式化。
  //
  // 这个键必须在顶层：plugin-loader.js 读 getConfig().trustedPlugins，
  // routes.js 的「信任并重试」也写顶层。放错位置的那份默认值从来没被读过。
  trustedPlugins: [],
  // 安全例外（默认全部关闭）
  security: {
    // true 时所有出站请求（网页抓取 / 图片下载 / 扩展联网）允许访问内网地址。
    // 键名沿用历史名称（用户配置里已存在），语义已统一为「允许出站访问内网」。
    allowPrivateImageHosts: false,
    // 外链白名单。主进程把页面里的链接交给系统浏览器前，要走
    // electron/external-link.js 的四道判据：
    //   ① 协议只允许 http/https（`file:` / `ms-msdt:` 这类交给 shell 是"执行"不是"打开"）；
    //   ② 拒绝带 userinfo 的 URL（`https://trusted@evil.com` 是经典钓鱼形态）；
    //   ③ 拒绝 127.0.0.1 / localhost（本机地址不该丢给系统浏览器）；
    //   ④ 主机必须在白名单里（精确匹配或它的子域）。
    // 前三条没有开关（挡的是执行/钓鱼，不是"访问了不喜欢的网站"）；第四条的内置名单
    // 见 external-link.js 的 DEFAULT_ALLOW_HOSTS（官网 / GitHub / 各供应商后台）。
    //
    // 这里填额外允许的主机，例如自建文档站、公司内网门户。写成 `example.com`
    // 会同时放行 `a.example.com`（子域规则），不需要写通配符。
    // 不加 `*.` 之类前缀，写裸域名即可；匹配用的是 `h === base || h.endsWith('.' + base)`，
    // 所以 `evil-example.com` 不会命中（用 includes 就会，那是个洞）。
    externalHosts: [],
    // ── 发网图（send_image）──
    // 机器人主动往群里发网上找的图。按用户要求默认开启，安全闸门仍在：
    //   · requirePreview（默认 true）：模型必须先预览确认才真发；
    //   · maxPerRun / maxBytesMB：限量与体积上限；
    //   · 下载走 safe-fetch（SSRF 防护 + 浏览锁定）。
    // 已有用户的 config.json 里若显式存过 enabled:false，deepMerge 会保留他们的
    // 选择，默认值只管"从没设过"的人。
    imageSend: {
      enabled: true,
      // 是否强制"先看一眼再发"。开启时模型必须先 send_image(url, preview=true)
      // 把图给自己看一眼、确认合适，才能真的发出去。
      // 这是防"模型随手发一张不合适的图"的主要闸门。
      requirePreview: true,
      // 单次运行里最多发几张、最多预览几张（防一次刷屏或反复下载烧流量）
      maxPerRun: 3,
      maxPreviewsPerRun: 5,
      // 单图体积上限（MB）
      maxBytesMB: 5,
      // 浏览锁定站点内的图可以跳过预览（站内图源可信，省一轮）
      skipPreviewForLockedHosts: true
    },
    // ── 出站图片的内容分级 ──
    // 全局唯一，所有技能共享（含第三方扩展）。档位与派生规则见 src/content-rating.js
    // （ratingRule 是全项目唯一的定义处，这里只存档位名）。
    //   all    全部放行
    //   r18    只拦 R-18 / R-18G
    //   strict 拦 R-18 + R-15（默认）
    //   r0     仅 R-0
    // 为什么与 imageSend 分开：imageSend 管「能不能发 / 怎么发（预览、限量、体积）」，
    // contentRating 管「发什么级别的内容」—— 两条不同的轴，将来表情包、视频要分级时
    // 可以复用它，不必再开一个键。
    contentRating: 'strict',
    // ── 浏览锁定 ──
    // 把"机器人能访问哪些域名"收成白名单。开启后 fetch 与发图**逐跳**校验
    // （含重定向目标），不在清单内一律拒绝。
    browseLock: {
      enabled: false,
      hosts: [],                  // 允许的域名，如 ['zh.wikipedia.org', 'example.com']（支持子域）
      siteSearchUrl: ''           // 站内搜索模板，如 'https://example.com/search?q={query}'
    }
  },
  // ── 协议端（OneBot v11）────────────────────────────────────────────────
  // 协议端不随包分发、也不由本软件启动/托管：SnowLuma 的 EULA 5.4 禁止其专有
  // 原生组件并入第三方安装包或经自动化脚本部署。用户自行安装 SnowLuma 或 NapCat
  // 并运行，然后把 QQ Agent 指向它的 OneBot v11 端点。两者默认端口一致
  // （WS 3001 / HTTP 3000），默认值即开即用；换了端口或加了令牌再改这里。
  protocol: {
    // 第二实例默认连自己的 OneBot 端口（3001/3000 + 偏移），
    // 否则两个实例会同时连到同一个协议端，消息被处理两遍。
    wsUrl: `ws://127.0.0.1:${3001 + portOffset()}`,
    httpUrl: `http://127.0.0.1:${3000 + portOffset()}`,
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: ''        // HTTP API 令牌（可与 WS 不同；留空沿用 accessToken）
  },
  // 人设与行为
  persona: {
    botName: '小鲸鱼',
    selfNickname: '',                       // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：DeepSeek 小鲸鱼 QQ 群友版
    participation: 'medium',                // low | medium | high，参与度参考
    customRules: '',                        // 追加自定义规则（可选）
    // 系统提示词覆盖（可选）：非空时整体替换 buildSystemPrompt 的默认行为准则。
    // 高级功能：默认提示词包含安全规则/工具协议/反AI味等关键约束，覆盖后这些
    // 全部失效，需自行在覆盖文本里写明。留空 = 用内置默认提示词。
    // 可用占位符：{botName} {roleText} {participation}
    systemPromptOverride: ''
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 按会话独立人设：{ [群号/QQ号]: { roleText, participation, customRules, systemPromptOverride } }
  // key 是白名单会话的 id（群号或私聊 QQ 号），值是该会话覆盖全局 persona 的字段；
  // 只覆盖写在这里的字段，其余（botName/selfNickname 等账号身份）永远用全局值：
  // 名字换了会和 @ 判定、存档里"我"的称呼对不上。
  personaByChat: {},
  // 统一人设（人设页开关）：true = 所有用一套全局人设；false = 人设页展示分会话
  // 独立编辑入口（personaByChat 生效）。仅控制 UI 形态与心智模型，运行时合并
  // 语义不变（personaByChat 有条目就按会话覆盖）。
  personaUnified: true,
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 会话级自动重试：整轮运行失败且一条消息都没发出时，自动从头再来几次。
  // 0 = 关闭自动重试（失败会话仍可在会话页手动点「重试」）。
  // 已发出过消息的会话绝不自动重试：重试会导致群里看到两遍同样的话。
  sessionRetryAttempts: 2,
  // 发送保护
  send: {
    minGapMs: 1000,         // 相邻两条消息最小间隔
    maxGapMs: 3000,         // 最大间隔
    byLengthMs: 20,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    // 发送去重窗口（毫秒）：同一会话在该窗口内完全相同的文本只发一次。
    // 防"模型重复调用 send_message / OneBot 超时看似失败但实际已发出、上层重试再发"导致的重复发言。
    // 0 = 关闭去重。默认 8000（8 秒）。
    dedupeWindowMs: 8000
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25
  },
  // 活跃模式（chatActive）：1/2/3 档被召唤触发响应后，模型若认为话题值得持续参与，
  // 会在 finish 时带回话题总结 → 该群进入"活跃期"：忽略档位判定必响应，
  // 提示词注入话题锚点，模型每次自判"是否仍在话题上"，偏离则 finish("话题结束") 退出。
  // 让"开始活跃"容易、"停下"由模型自主判断，恰好是档位系统的反向补充。
  chatActive: {
    enabled: false,
    ttlMinutes: 30   // 活跃期最长持续时间（分钟）：到期自动退出，兜住"模型忘了结束"
  },
  // ── 前缀缓存保活 ──────────────────────────────────────────────────────
  // 一个会话的第一次调用只能命中约 36% 的 prompt：「工具 schema + 系统提示」这段
  // 前缀虽然跨会话字节一致，但服务商的缓存需要先有请求写过它才会命中；而用户的
  // 实际会话多是"一次唤醒就结束"，于是每个新会话都在付这段前缀的全价。
  //
  // 做法：后台按固定间隔发一次"只含固定前缀 + 极短用户消息"的请求，把这段前缀
  // 保持在服务商缓存里，之后任何新会话的第一次调用都能命中它。
  // 成本：一次保活约 2700 token 输入，命中后按缓存价计费（约为普通输入价的 1/10）。
  //
  // 默认开启。它会主动联网，用户应明确知情；间隔的合适取值取决于服务商的缓存
  // TTL，需自行实测调整：逐档放大间隔，观察新会话第一次调用的 cached 是否仍然很高。
  cacheWarm: {
    // 间隔 10 分钟对服务商缓存 TTL 是安全的（app.js 注释有实测方法）。
    enabled: true,
    intervalMin: 10,
    // 调用前预热：真实 LLM 调用之前，先发一次同前缀的轻量请求把缓存写好。
    //
    // 默认关闭。预热必须逐字节复用真实 body（否则两者各占一个缓存档位），而
    // "复用真实 body"就意味着它把真实调用本来就要付的那笔全价 prefill 提前自己
    // 付了一遍。成对实测（同一会话内预热+真实一起算）：
    //    预热：预热未命中 2496 + 真实未命中 192 = 2688，成本 3005
    //    不预热：                    真实未命中 2481 = 2481，成本 2617
    // → 预热净亏约 389×1e-6 元/次，买到的是"命中率这个数字"。预热只有在前缀会被
    // 多次真实调用复用时才可能回本，而本项目的会话是一次一事（每个新会话的 user
    // 消息都不同），所以它稳定为负。
    //
    // 真正把命中率提上去的是【过去状态】窗口起点锚定（见 prompt.js 的
    // ANCHOR_MAX_CHUNK）：首轮未命中 2500 → 796，命中率 73% → 91.6%，而且同时
    // 降低总成本。后台定期保活（intervalMin）不受影响：它只发"固定前缀 + 极短
    // 用户消息"，命中的是已经缓存的那段，成本近乎为零，保留。
    preCall: false,
    // 调用前预热的防重间隔（秒，热生效）。开 preCall 后控制"多久之内同一形状
    // 不重复预热"：调小（5-10s）接近每条消息都预热，真实调用能冲到 97-100%，
    // 但请求数翻倍，上游限流（429）时适得其反；cache-warm 的限流冷却会自动暂停
    // 预热兜底。注意一次性会话下 preCall 是净负成本，默认关闭，按需开。
    preCallGapSec: 45,
    // 同形状预热去重窗口（秒，热生效）。设 0 关闭。
    // 启动/保活 tick/early-warm/形状变化四条路径各自判重、互相看不见，曾出现
    // 重启后 8 秒内对同一个 shape（18773 tok）连发 5 次预热，每次 1.5~6 秒，
    // 白占上游并发位（该模型并发上限 16，当天有 41 次真实调用被 429）。
    // warmOnce 在这一层做统一收口：同形状 N 秒内只暖一次。
    warmDedupSec: 20,
    // 静默时段（小时）：该区间内不发保活请求。空数组 = 全天保活。
    quietHours: [1, 2, 3, 4, 5, 6]
  },
  // 日志（src/logger.js 读取）
  logs: {
    // 最低落盘级别 debug/info/warn/error。UI 的级别选择器写这里，重启后保持。
    // 与 logger 构造期默认（info）一致：配置缺失时行为不变。
    level: 'info'
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。0 = 不限制。
    // 前端存档页已分页（首屏 500 条、滚动追加 200 条），store 的 #trim 在
    // maxPerChat<=0 时直接跳过。单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 上下文读取档位（决定本次唤醒读多少条历史）──
    // 档位累积生效：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定读取条数。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全读
    atCount: 20,                // 档1：机器人被艾特时读 w 条
    keywordCount: 15,           // 档2：命中关键词时读 x 条
    keywords: [],               // 档2 的关键词表
    randomPercent: 10,          // 档3：y% 概率
    randomCount: 8,             // 档3：命中时读 z 条
    allCount: 80,               // 档4：读全部（上限）
    // ── 响应档位的作用范围 ──
    unifiedTier: true,          // true = 上方滑条对所有会话生效；false = 可按群单独设置
    groupSliderPos: {},         // { [群号]: 0~100 } 仅 unifiedTier=false 时生效；未设置的群/私聊跟随全局滑条
    // 分群峰谷：unifiedTier=false 且 peakSchedule.enabled 时，每个群可以有自己的
    // 峰谷档位 { [群号]: { peak: 0~100, valley: 0~100 } }。时段（start/end）全局
    // 共享，每群分开拖两个点的档位值即可。
    groupPeakPos: {},           // 未设置的群跟随全局峰谷双点
    // 会话记录永不清理是确定的无界磁盘增长，默认保留 120 个已结束会话；
    // settings 里可改回 0 恢复不限制。
    keepSessionFiles: 120,      // 保留最近多少个会话记录文件；0 = 不限制
    // ── 峰谷切换（按时段自动调整响应档位）──
    // 允许用户设定"高峰/低谷"两个时段及各自生效的响应档位（滑条位置 0~100）。
    // 例如：白天上班时间（高峰）设为 1 档仅艾特省 token，晚上（低谷）设为 4 档全响应。
    // 命中某时段时用该时段的档位覆盖全局滑条；都不命中用全局滑条。
    peakSchedule: {
      enabled: false,           // 总开关
      // 高峰时段：start~end（"HH:MM"，跨零点也支持，如 22:00~06:00）
      peak: { start: '09:00', end: '18:00', sliderPos: 10 },   // 高峰档位（默认 1 档仅艾特）
      // 低谷时段：start~end
      valley: { start: '18:00', end: '09:00', sliderPos: 100 } // 低谷档位（默认 4 档全响应）
    }
  },
  // 屏蔽名单：{ [群号]: [QQ号, ...] }
  // 被屏蔽群员的消息在入口处直接丢弃：不存档、不触发会话、不作为提示词背景。
  // 机器人自己的消息不受影响。仅群聊有意义（私聊要屏蔽请直接用白名单/黑名单）。
  blocklist: {},
  // 全局屏蔽名单（"上云"）：[QQ号, ...]
  // 与 blocklist 的区别：blocklist 按群单独屏蔽；globalBlocklist 对所有群生效，
  // 一旦某人被加进来，他在任何群里的消息都会被丢弃（含私聊）。
  // 用于"这个人在所有群里都不该再被机器人看到"的场景（如骚扰者、广告号）。
  globalBlocklist: [],
  // 本机豁免名单：无管理密钥时"本机解除全局屏蔽"的持久化记录。
  // 云端名单仍含这些 id（移除需要密钥），但本机用 getGlobalBlocklist() 时扣除它们。
  // 独立字段：5 分钟一次的云端同步会整体覆盖 globalBlocklist，但不会碰这里。
  communityExemptions: [],
  // 指令禁言：群内任何人 @机器人 并发送指定指令后，机器人暂时把响应档位固定为 1 档（仅艾特）。
  // 用于群里太吵时让机器人"闭嘴"，只回应被直接点名。
  commandMute: {
    enabled: true,              // 总开关
    command: '/安静',            // 触发指令（需与 @机器人 同条消息）
    durationMin: 30,            // 禁言时长（分钟），0 = 直到手动解除
    // 运行态（不在 UI 编辑）：{ [群号]: 禁言到期时间戳 }
    active: {}
  },
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    consolidateMinIntervalMs: 21600000,  // 默认 6 小时
    // 触发阈值：orchestrator 读这些键时带类常量兜底（`cfg.memory?.xxx || 常量`），
    // 值必须与 orchestrator 的 MEMORY_THRESHOLDS / DISCOVER_MIN_MESSAGES /
    // DISCOVER_MAX_MEMBERS 保持一致，否则"默认值"与"兜底值"会打架。
    consolidateMinImpressions: 4,         // 全群印象总数超过它才触发整理
    maxImpressionsPerMember: 5,           // 单个成员印象条数超过它也会触发（照顾人少的群）
    discoverMinMessages: 20,              // "发现新人"：发言至少这么多条才纳入分析
    discoverMaxMembers: 3,                // "发现新人"：单次最多发现几个人（控成本）
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: ''                             // 专用模型 id（useChatModel=false 时生效）
  },
  // 工具与技能（skill 化开关）
  //
  // 边界（避免"两个开关打架"）：
  //   tools.*  = 工具层的开关：全局 / 分类 / 单个工具
  //   skills.* = 能力层的开关：每个 Skill 一个命名空间
  // 最终"能不能用"由 tool-registry.getToolAvailability() 统一计算，
  // 顺序是：tools.enabled → skill 生效 → requires 能力 → 分类 → 单工具 → 运行期依赖。
  // 模块不允许再写自己的 isXxxEnabled 影子开关。
  tools: {
    enabled: true,              // 全局开关：false 时所有工具都禁用
    overrides: {},              // { [toolId]: boolean } 单个工具的启用状态
    // 跨会话发送（默认关）：开启后 send_message 支持 targetChatKey，
    // 允许模型按用户指示把消息发到白名单内的其它群/私聊。
    // 这是社交敏感操作（可能被诱导去骚扰别的会话），所以默认只允许当前会话。
    crossChatSend: false,
    categories: {
      messaging: true,          // 消息发送
      sticker: true,            // 表情管理
      query: true,              // 消息查询
      memory: true,             // 记忆系统
      web: true,                // 联网搜索
      knowledge: true,          // 知识库
      media: true,              // 媒体理解
      system: true              // 系统反馈
    }
  },
  // Skill 统一开关：唯一的"能力启停"来源。
  // 形状：{ [skillId]: { enabled: boolean, ...该 Skill 自己的设置 } }
  // 这里只存用户改过的值；默认值来自各 Skill 的 skill.json → settings。
  skills: {},
  // 扩展热重载：把自定义的插件/skill 目录放进 plugins/ 或 skills/ 后自动生效，无需重启。
  // 默认开，这正是"放进去就能用"的体验来源。
  // 安全含义：等价于"任意落地的 JS 会被执行"。共享机器 / 只跑固定版本时建议关掉。
  extensions: {
    hotReload: true
  },
  // ── 系统自检页的「对话排查」专用模型 ────────────────────────────────────
  // 默认跟随全局 api（enabled=false 时 chatCompletion 不传 overrides，走 effectiveApi）。
  // 单独一份的价值：诊断用小模型省钱、或诊断走另一个端点避开限流，而群聊/记忆
  // 整理不受影响。
  // apiKey 存这里会走 sanitizeConfig 的密钥模式自动脱敏（读回来是 hasApiKey 布尔），
  // 前端要显示明文得走带来源校验的端点，与搜索 Key / OneBot 令牌同一套。
  doctorApi: {
    enabled: false,     // true 时 /api/doctor/ask 走下面这套；false 时跟随全局
    baseUrl: '',
    model: '',
    apiKey: ''
  },
  // 「开发工单」专用模型（比 doctorApi 更优先）：开发模式对模型能力要求高，
  // 可以单独指到更强的模型（如 deepseek-v4-pro）。false 时 doctorApi > 全局。
  devApi: {
    enabled: false,
    baseUrl: '',
    model: '',
    apiKey: ''
  },
  // 桌面端/控制台
  server: {
    // 端口：QQ_AGENT_PORT 显式覆盖 > 默认 3210 + PROFILE 偏移
    // （第二实例整体 +100，避免和主实例撞端口）
    port: Number(process.env.QQ_AGENT_PORT) || (3210 + portOffset()),
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    closeToTray: true,        // 点关闭 = 最小化到托盘
    // 允许"外部浏览器打开的控制台"读取明文凭据（API Key / SnowLuma 密码）。
    // 默认 false：Origin / Referer 都是客户端可伪造的头，不能当凭据用。
    // 需要外部浏览器读密钥时，配 server.token 并带 x-console-token，而不是打开这个开关。
    allowBrowserKeyRead: false
  },
  // ── 数据备份与恢复 ────────────────────────────────────────────────────
  // 把实例数据（会话存档 / 群友印象 / 用量 / 提醒 / 表情配置）打包成 .qqab，
  // 推到本地目录 / WebDAV / S3 兼容存储，并可从备份恢复。
  //
  // 硬边界：config.json 与 plugin-data/ 默认永不进包（见 DATA_CATEGORIES 白名单）。
  // 勾选 includeSecrets 时整包必须 AES-256-GCM 加密才允许上传（加密实现见
  // backup/crypto.js）；凭据密文（webdav.credentials / s3.secretAccessKeyCipher）
  // 只进本文件，不得出现在日志、API 响应或备份包里。
  //
  // 目标是数组：同一轮备份构建一份包，写给所有启用的目标，便于"本地留一份 +
  // 云上留一份"。id 由界面生成，用于历史记录与恢复时定位。
  backup: {
    enabled: false,
    intervalHours: 24,          // 间隔式触发，随应用运行；不引入 cron
    retention: 7,               // 每个目标保留最近几个备份包
    includeSecrets: false,      // 默认关闭：含密钥必须整包加密，且界面二次确认
    targets: [
      {
        id: 't1',
        name: '',
        type: 'local',            // 'local' | 'webdav' | 's3'
        enabled: false,
        // local
        dir: '',
        // webdav
        url: '',
        username: '',
        credentials: '',          // 密文（机器绑定密钥派生，见 backup/crypto.js）
        // s3
        endpoint: '',
        region: 'us-east-1',
        bucket: '',
        accessKeyId: '',
        secretAccessKeyCipher: '',// 密文
        forcePathStyle: true,
        // 通用：只备份勾选的类别
        categories: ['messages', 'memory', 'usage', 'reminders', 'stickers']
      }
    ]
  },
  // ── 桌面悬浮小窗 ──────────────────────────────────────────────────────
  // 设置 → 界面与应用 → 桌面端打开后，桌面上出现一张无边框小卡片，显示今日用量 /
  // 缓存命中率 / 机器人连接状态。数据零新增：页面每 refreshMs 轮询一次
  // /api/status（与主界面顶栏同一个接口），不新增任何后端接口。
  // 小窗默认开、真透明 + 50% 背景，卡片浮在桌面上能直接看见桌面，四角由页面自己画。
  // transparent 曾默认 false：主窗口因"启动时无条件 setOpacity(1)"把透明分层窗口
  // 打死，根因已修复（见 electron/main.js createWindow 的注释）。悬浮窗自身不调
  // setOpacity，没有那条冲突；但透明窗口在 Windows 上仍有边缘情况（老显卡驱动、
  // 远程桌面会话），所以设置里仍标着「实验」，出问题时关掉此项并把 opacity 调回
  // 100 即可回到不透明深色卡。
  // 位置/尺寸不存这里：与主窗口一致落在 data/window-state.json 的 widget 字段，
  // 避免每次拖动都整份重写配置（配置里可有密钥）。
  widget: {
    enabled: true,            // 总开关（默认开：开箱即见小窗）
    alwaysOnTop: true,        // 总是置顶
    clickThrough: false,      // 鼠标穿透（点了不抢焦点；开启后右键菜单也用不了，
                              //   需要关闭时走托盘菜单或设置页，三条恢复路径）
    transparent: true,        // 真透明（默认开；实验档，见上）
    // 贴边自动收起（QQ 式）：拖到屏幕边缘 6px 内收起只剩一条 6px 细缝，
    // 鼠标移近即展开；直接拖走细缝也会弹回。展开态坐标落 window-state.json，
    // 重启后仍是收起态。
    edgeHide: true,
    // 背景不透明度（百分数 30~100，默认 50 = 半透明卡片）。
    // transparent 关掉时，<100 走 Windows 11 mica 毛玻璃背板（DWM 合成），
    // 而不是拿 transparent:true 去换半透明。
    // mica 背板建窗时决定：调过 100 这条线会重建小窗（位置保留）；
    // 100 以下来回拖只是改卡片 CSS 透明度，页面轮询 /api/config 即时生效。
    opacity: 50,
    size: 'm',                // 尺寸预设：s | m | l（像素表在 main.js WIDGET_SIZES）
    refreshMs: 2500           // 轮询间隔（主进程夹到 1000~60000）
  },
  // ── 媒体工具（ffmpeg）────────────────────────────────────────────────
  // ffmpeg 不随安装包分发（79MB），改为「设置 → 媒体工具」按需下载到
  // data/runtime/ffmpeg/bin/。它只服务四项：大图压缩 / GIF 转视频 / 视频抽帧 /
  // 动态壁纸导入。没下载时这四项各自降级（不压缩、按图发、只给元信息、报错引导），
  // 不影响启动与纯文字聊天。
  //
  // 路径解析统一在 src/ffmpeg-resolve.js：手填 > QQ_AGENT_FFMPEG > 下载的 >
  // 旧随包 > PATH/注册表/WinGet。
  media: {
    ffmpegPath: '',              // 手动指定的 ffmpeg 路径（留空 = 自动探测）
    // 优先使用哪一组：''（自动，按 manual > managed > system）
    // | 'manual'（手填）| 'managed'（设置页下载的）| 'system'（系统里自己装的）
    // 只调组间顺序，组内顺序固定；手填路径即便切到 system 也仍作为兜底。
    // 取值必须与 ffmpeg-resolve.js 的 FFMPEG_SOURCES 一致。
    ffmpegSource: '',
    // 下载源：yylx（git.yylx.win，默认）| gh-proxy | direct（GitHub 官方）| custom
    // 前两个都是国内镜像加速，不需要代理；某个站挂了换个源即可。国内直连 GitHub
    // Release 经常几十 KB/s 甚至超时，所以默认走加速。有可用代理时会自动改走
    // 官方直连，见 ffmpeg-setup.js 的 resolveDownloadRoute。
    // 默认值必须与 ffmpeg-setup.js 的 DEFAULT_MIRROR 一致。
    downloadMirror: 'yylx',
    customMirror: '',            // 形如 https://git.yylx.win/（仅在 downloadMirror='custom' 时生效）
    // 字段名必须是 githubAccessToken，不能叫 githubToken：app.js 的
    // SECRET_KEY_PATTERN 里有 accesstoken 但没有裸 token 分支，叫 githubToken
    // 会明文回传给浏览器（GET /api/config 不脱敏）。
    // 用途：代理节点是共享出口 IP 时，GitHub 按 IP 限流 60 次/小时；带 Token 后
    // 按 Token 计额度（5000 次/小时）。只发给 GitHub 自己的主机，绝不发给镜像站，
    // 见 ffmpeg-setup.js 的 githubAuthHeaders。
    githubAccessToken: ''
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000,         // 界面轮询间隔
    // 全部"空值 = 跟随主题"：留空时前端不覆盖对应 CSS 变量，
    // 换主题/换设备也不会因为写死颜色而变得不搭。
    accent: '',               // 强调色 hex（如 #5b8cff），空 = 用主题自带的 accent
    bgColor: '',              // 界面底色 hex，空 = 用主题自带的 --layer-0
    frameAlpha: 100,          // 底色不透明度 %（100 = 完全不透明；调低可透出背景图/桌面）
    bgImage: '',              // 背景图文件名（存在 data/ui/ 下），空 = 无背景图
    bgFit: 'cover',           // 背景图填充：cover | contain | repeat
    bgDim: 0,                 // 背景图暗化 %（压暗图片让文字更好读）
    winOpacity: 100           // 整窗不透明度 %（仅 Electron 桌面端，走 setOpacity）
  },
  // ── 启动引导（OOBE）──────────────────────────────────────────────────
  // seen=false（或缺这个字段）= 下次启动自动弹「使用引导」。群友多次反馈新手
  // 不知道从哪下手，而"没配好就强行跳设置页"的旧方案被"每次点开都在设置界面"
  // 的反馈否决，所以现在是可随时关掉的全屏引导：关掉照常进会话页，不拦截、不跳转。
  // version：引导内容大改版时 +1，老用户升级后会重新看到一版（见
  // ui/app/18-onboarding.js 的 ONBOARDING_VERSION）。
  onboarding: {
    seen: false,
    version: 0
  },
  // ── 在线更新检查 ─────────────────────────────────────────────────────
  // 本仓库从上游项目 fork 出来独立维护，上游更新源推的安装包与本仓库的构建不
  // 对应，所以改为默认关闭 + 源地址可配：
  //   enabled=false 时 /api/update-check 直接返回 disabled，不发任何网络请求；
  //   要恢复时在这里填自己发布的 version.json 地址（格式 { version, url, notes }）。
  // 关掉不影响 /api/version（界面显示当前版本仍走它）。
  update: {
    enabled: false,
    feedUrl: ''
  },
  // ── 匿名用量遥测 ─────────────────────────────────────────────────────
  // 原实现每 6 小时把 installId + 版本号 + 调用计数 POST 到上游项目的服务器，
  // 且没有任何开关。本仓库 fork 后独立维护，这些数据继续发给上游既无意义也不
  // 合适，所以改为默认关闭 + 上报地址可配：
  //   enabled=false 时 startTelemetryLoop 不装任何定时器，进程零网络请求；
  //   要自己收数据时填 reportUrl（接收端按 installId 覆盖式 upsert）。
  // 本机的 telemetry-totals.json 仍照常累计（sessions.js 写），它只是本地计数，
  // 关掉遥测不影响任何界面功能。
  telemetry: {
    enabled: false,
    reportUrl: ''
  }
};

/** 深合并（含 __replace__ 整体替换约定）。导出供 routes.js 的预览端点做"不落盘的临时合并"。 */
export function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 这三个键必须跳过。override 来自 WebUI 提交的 JSON（或第三方扩展），
    // JSON.parse 会把 "__proto__" 建成普通自有属性并出现在 Object.entries 里；
    // 而下面 `out[key] = ...` 在普通对象上走的是原型 setter，结果是数据没写进去、
    // 合并结果的原型却被替换（后续 `out.api` 之类的读取会顺着原型链拿到"看不见"
    // 的值，配置看着没变却生效了，最难查的那类）。constructor / prototype 同理，
    // 合并语义上没有一个是合法的配置键名。
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景，
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    const cfg = deepMerge(DEFAULT_CONFIG, migrateContentRating(migrateLegacySkills(migrateSnowlumaToProtocol(parsed))));
    // 内置人设改版迁移：群友反馈旧版默认人设"怼人太厉害"，PERSONAS.xiaojingyu
    // 已整体重写（攻击性大降、长度减半），老配置里存的旧版全文在这里静默换成新版。
    // 必须精确匹配旧文本才替换：用户基于旧卡自己改过/微调过的不动，个性化修改
    // 优先于内置改版。不在此处写盘，内存里迁移即可，用户下次保存配置时会自然固化；
    // 每次启动重跑是幂等的，没有副作用。
    try {
      if (cfg?.persona && typeof cfg.persona.roleText === 'string'
        && cfg.persona.roleText.trim() === LEGACY_XIAOJINGYU_TEXT.trim()) {
        cfg.persona.roleText = PERSONAS.xiaojingyu.text;
      }
    } catch { /* 迁移失败不阻塞启动 */ }
    return cfg;
  } catch (error) {
    // 配置文件坏了（手改错/磁盘故障）不能静默回落默认值：曾经直接返回 DEFAULT，
    // 随后任何 updateConfig（比如 5 分钟一次的云端屏蔽名单同步）都会以默认配置为底
    // 整体写回 config.json，用户的 Key/白名单/人设被静默抹成出厂值。
    // 现在先把坏文件改名备份（原始数据可手工抢救），再回落默认，并打 error 日志。
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(CONFIG_FILE, `${CONFIG_FILE}.corrupt-${stamp}`);
        console.error(`[config] 配置文件解析失败（${String(error?.message ?? error)}），` +
          `已备份为 config.json.corrupt-${stamp}，本次以默认配置启动。` +
          `请尽快从备份抢救配置，否则下次保存会覆盖全量配置！`);
      }
    } catch (backupError) {
      console.error('[config] 配置文件解析失败且备份失败：', backupError);
    }
    return structuredClone(DEFAULT_CONFIG);
  }
}

/**
 * 旧配置迁移：把历史上散落在各处的"能力开关"收拢进 config.skills。
 *
 * 必须做：旧版把同一件事的开关放在 api.thinking、tools.knowledgeEnabled 之类的
 * 字段里，而新架构只认 config.skills[id].enabled。不迁移的话，用户升级后会出现
 * "UI 显示已开启、实际 Skill 判定为关闭"。
 *
 * 规则表驱动，新增迁移只需加一行：旧字段路径 → Skill id，可选值映射函数。
 * 迁移幂等：只有在 skills[id] 尚未存在时才写入，不覆盖用户新配置。
 */
const LEGACY_SKILL_MIGRATIONS = [
  // skill 名字必须与 skills/ 下的目录名完全一致。曾经写成 'thinking' /
  // 'video-understanding' / 'sticker-annotation'，而真实技能叫 'thinking-adapters' /
  // 'video-frames' / 'sticker-annotate'，后果是旧配置被迁进了一个没有任何技能读取
  // 的命名空间：用户升级后开关看着"迁过来了"，实际仍是关的。
  // test/skill-test.mjs 现在会校验目标技能存在。
  // 社区版的思考开关：api.thinking: boolean → skills['thinking-adapters'].enabled
  { from: ['api', 'thinking'], skill: 'thinking-adapters', map: (v) => ({ enabled: v !== false, mode: 'auto' }) },
  // 旧知识库开关（知识库技能尚未移植，先留位；目标不存在时迁移会跳过并记日志）
  { from: ['tools', 'knowledgeEnabled'], skill: 'knowledge-base', map: (v) => ({ enabled: v !== false }) },
  // 旧视频理解开关
  { from: ['tools', 'videoEnabled'], skill: 'video-frames', map: (v) => ({ enabled: v !== false }) },
  // 旧表情标注开关
  { from: ['tools', 'stickerAnnotate'], skill: 'sticker-annotate', map: (v) => ({ enabled: v !== false }) }
];

export function migrateLegacySkills(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const out = { ...parsed };
  out.skills = (out.skills && typeof out.skills === 'object' && !Array.isArray(out.skills)) ? { ...out.skills } : {};

  // 整块对象型迁移：表情包原先放在顶层 config.sticker，抽出内置插件 plugins/sticker 后
  // 改由 config.skills.sticker 读。已有新配置就不动（用户可能已在新 UI 里改过）。
  if (out.sticker && typeof out.sticker === 'object' && !Array.isArray(out.sticker)) {
    if (!('sticker' in out.skills)) out.skills.sticker = { ...out.sticker };
    delete out.sticker;
  }

  for (const rule of LEGACY_SKILL_MIGRATIONS) {
    const [parent, key] = rule.from;
    const container = out[parent];
    if (!container || typeof container !== 'object') continue;
    if (!(key in container)) continue;
    const legacyValue = container[key];
    // 已有新配置就不动（用户可能已经在新 UI 里改过）
    if (!(rule.skill in out.skills)) {
      out.skills[rule.skill] = { ...rule.map(legacyValue) };
    }
    // 清掉旧字段，避免下次启动重复迁移、也避免模块继续读到旧值
    const nextContainer = { ...container };
    delete nextContainer[key];
    out[parent] = nextContainer;
  }
  return out;
}

/**
 * 旧配置迁移：`config.snowluma` → `config.protocol`。
 *
 * 协议端从"随包分发 + 本软件托管"改为"用户自选安装"（SnowLuma EULA 5.4）。
 * 旧配置块里只有四个字段与"连到哪里"有关，其余（dir / autoLaunch / autoInject /
 * botQQ / webuiPassword…）都是进程管理字段，随协议端托管一起废弃。
 *
 * 幂等：只在 protocol 对应字段缺失时搬运，不覆盖用户已保存的新值；
 * 搬完即删除 snowluma 块，避免旧字段被继续读取。
 */
export function migrateSnowlumaToProtocol(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const sl = parsed.snowluma;
  if (!sl || typeof sl !== 'object') return parsed;
  const out = { ...parsed };
  const proto = (out.protocol && typeof out.protocol === 'object' && !Array.isArray(out.protocol))
    ? { ...out.protocol }
    : {};
  const CONNECTION_FIELDS = ['wsUrl', 'httpUrl', 'accessToken', 'httpAccessToken'];
  for (const key of CONNECTION_FIELDS) {
    if (proto[key] === undefined && sl[key] !== undefined && sl[key] !== '') proto[key] = sl[key];
  }
  out.protocol = proto;
  delete out.snowluma;
  return out;
}

/** 迁移读取旧分级键的扩展 id（与 skills/ 下的目录名一致）。 */
const CONTENT_RATING_SKILL = 'random-image';

/**
 * 旧配置迁移：把 random-image 私有的分级键折算成全局 `security.contentRating`。
 *
 * 旧版把同一件事拆成三个键散落在技能配置里，其中两个用户根本看不见：
 *   skills['random-image'].booru.onlyR0 === true → 'r0'
 *   skills['random-image'].safeMode === false    → 'all'
 *   skills['random-image'].booru.strictSfw === false → 'r18'
 *   其余（safeMode 为 true 或未设）              → 保持默认 'strict'
 *
 * 幂等：只在用户没显式设过 security.contentRating 时推断档位（显式值优先，
 * 不覆盖用户的选择）。三个旧键无论是否参与推断都会被清除 —— 迁移完成后
 * 任何代码再读旧键都会形成第二套契约。用户数据迁移属于保留兼容代码的正当场景，
 * 但兼容只存在于这一处。
 */
export function migrateContentRating(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  const skills = parsed.skills && typeof parsed.skills === 'object' && !Array.isArray(parsed.skills)
    ? parsed.skills
    : null;
  const skillCfg = skills?.[CONTENT_RATING_SKILL];
  if (!skillCfg || typeof skillCfg !== 'object' || Array.isArray(skillCfg)) return parsed;

  const booru = skillCfg.booru && typeof skillCfg.booru === 'object' && !Array.isArray(skillCfg.booru)
    ? skillCfg.booru
    : null;
  const hasLegacy = 'safeMode' in skillCfg || (booru !== null && ('strictSfw' in booru || 'onlyR0' in booru));
  if (!hasLegacy) return parsed;

  const out = { ...parsed };
  const security = out.security && typeof out.security === 'object' && !Array.isArray(out.security)
    ? out.security
    : null;

  if (!security || !('contentRating' in security)) {
    let rating = null;
    if (booru?.onlyR0 === true) rating = 'r0';
    else if (skillCfg.safeMode === false) rating = 'all';
    else if (booru?.strictSfw === false) rating = 'r18';
    // rating 为 null 时保持默认 strict，不写盘（deepMerge 会补上默认值）
    if (rating) out.security = { ...(security || {}), contentRating: rating };
  }

  // 清除旧键：迁移完成后不得再有第二处读取点
  const nextSkill = { ...skillCfg };
  delete nextSkill.safeMode;
  if (booru !== null) {
    const nextBooru = { ...booru };
    delete nextBooru.strictSfw;
    delete nextBooru.onlyR0;
    nextSkill.booru = nextBooru;
  }
  out.skills = { ...skills, [CONTENT_RATING_SKILL]: nextSkill };
  return out;
}

let currentConfig = null;
/** 取当前生效配置（未初始化时从磁盘读）。 */
export function getConfig() {
  if (!currentConfig) currentConfig = loadConfig();
  return currentConfig;
}

/**
 * 剔除派生标记：GET /api/config 的脱敏层会生成 hasXxx / dshProviderKeyPresence
 * 这类"只表示存在性"的字段。前端把它们当成配置的一部分回传时，deepMerge 会把
 * 它们真的写进 config.json，于是配置文件里混进了派生数据，且会随密钥增删变得与
 * 实际不一致（清了 Key 但 hasKey 仍是 true）。
 */
function stripDerivedFlags(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) {
    for (const item of node) stripDerivedFlags(item);
    return node;
  }
  for (const key of Object.keys(node)) {
    // hasApiKey / hasKey / hasAccessToken / hasHttpAccessToken …
    // 只匹配 camelCase 的 has+大写开头，避免误删用户自定义的普通字段。
    if (/^has[A-Z][A-Za-z0-9]*$/.test(key)) { delete node[key]; continue; }
    if (key === 'dshProviderKeyPresence') { delete node[key]; continue; }
    stripDerivedFlags(node[key]);
  }
  return node;
}

/**
 * 数组型密钥容器的脱敏回传保留：patch 里按 id 匹配的条目若缺少密钥字段，
 * 从现配置同 id 条目回填。前端脱敏视图回传时密钥天然不在场，不回填就会在
 * "数组整体替换"的合并语义下静默清空。显式传空串（''）= 真清除，不回填。
 * 目前只有 webSearch.providers 一处数组密钥容器；新增容器时往数组里加路径即可。
 */
function preserveSanitizedSecrets(current, patch) {
  try {
    const cur = current?.webSearch?.providers;
    const next = patch?.webSearch?.providers;
    if (!Array.isArray(cur) || !Array.isArray(next)) return;
    for (const entry of next) {
      if (!entry || typeof entry !== 'object' || entry.id == null) continue;
      // 显式带了 apiKey（含空串 = 真清除）→ 尊重调用方，不回填；
      // 完全没带（脱敏回传的常态）→ 从现配置同 id 条目回填现值。
      if (entry.apiKey !== undefined) continue;
      const stored = cur.find((p) => String(p?.id) === String(entry.id));
      if (stored && String(stored.apiKey || '').trim()) {
        entry.apiKey = stored.apiKey;         // 回填现值，等价于"该条目未动"
      }
    }
  } catch { /* 保留失败不阻塞保存；最坏结果是回到旧行为 */ }
}

/**
 * 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。
 *
 * 也接受函数式入口：`updateConfig(cfg => patch)`，回调收到当前配置、返回 patch，
 * 读-改-写在这一个同步块里完成。
 *
 * 需要它的原因：形如
 *   const active = { ...getConfig().commandMute.active }; active[群号] = until;
 *   updateConfig({ commandMute: { active: { __replace__: active } } });
 * 的写法，"读"与"写"之间只要插进任何一个 await（跨 await 的窗口可达数百毫秒），
 * 两次并发调用就会各自基于同一份旧快照构造，后写者覆盖前写者，其中一个修改
 * 静默失效（群 A 的禁言指令看起来发了，其实被群 B 那次覆盖掉了）。
 * 函数式入口把这个保证变成接口约束：拿到 cfg 的那一刻就是原子的读-改-写。
 */

/**
 * 配置世代号：每次可能改变工具可用性的配置写入 +1。
 *
 * 消费方是工具集粘滞窗（tool-registry.js 的 stabilizeToolset）：它按会话桶缓冲
 * "工具集合变化"90 秒，把插件热装卸的前缀缓存击穿折叠成一次。但用户在 UI 里
 * 主动开/关插件是意图明确的操作，不该被缓冲，否则"刚启用的插件 90 秒内调不到"
 * 就是新的"插件无法调用"故障。
 *
 * 于是分流：配置世代变化（用户操作/安装/信任/任何 updateConfig）立即重置粘滞窗、
 * 按新集合走；没有配置写入的可用性漂移（fs.watch 重扫余波、探测结果翻转）仍然
 * 粘滞吸收。世代号只单调递增、不落盘（重启后从 0 开始，而粘滞窗状态本身也在
 * 内存里，两者生命周期一致）。
 */
let configVersion = 0;

/** 当前配置世代号（每次 updateConfig / setRuntimeConfig +1）。 */
export function getConfigVersion() {
  return configVersion;
}

/**
 * 配置写入后的订阅者（派生状态刷新）。
 *
 * 为什么挂在配置层而不是调用方：`logs.level` 这类"配置 → 运行时开关"的派生值
 * 必须由配置唯一决定。写在路由里（POST /api/config 之后顺手 setLevel）会漏掉
 * 任何不经过那条路由的写入 —— 备份恢复走 `setRuntimeConfig(loadConfig())`、
 * 脚本直接调 `updateConfig`，都让"配置说 info、实际还在 debug"重新出现
 * （K1 实测：POST /api/config 写 info 后 GET /api/logs 仍返回 debug）。
 * 所以在两条写路径的统一出口通知一次，谁派生谁自己订阅。
 */
const configAppliedListeners = new Set();

/**
 * 订阅"配置已写入"。返回退订函数。
 * 监听器内不得抛：一次配置写入会广播给所有订阅者，单个派生刷新失败
 * 不该让保存接口整体失败（该派生值下一次写入还会再刷）。
 */
export function onConfigApplied(fn) {
  configAppliedListeners.add(fn);
  return () => configAppliedListeners.delete(fn);
}

function notifyConfigApplied() {
  for (const fn of [...configAppliedListeners]) {
    try { fn(); } catch { /* 单个派生刷新失败不影响其它订阅者与保存结果 */ }
  }
}

export function updateConfig(patchOrFn) {
  // 函数式入口：先取当前配置喂给回调，再走下面同一条合并路径
  const rawPatch = typeof patchOrFn === 'function' ? patchOrFn(getConfig()) : patchOrFn;
  const cleanPatch = stripDerivedFlags(structuredClone(rawPatch ?? {}));
  // 脱敏回传的密钥保留（修"搜索 Key 离开页签就消失"）：前端拿到的配置是脱敏的
  // （apiKey 被删、hasApiKey 被加），它把整个配置/区块回传保存时，密钥字段天然
  // 缺失。对象型密钥容器 deepMerge 会保留基底值（webSearch.deepseek.apiKey 没出现
  // 在 patch 里 → 沿用现值），但数组型容器（webSearch.providers[].apiKey）是整体
  // 替换，前端回传的数组里没有 apiKey，一次普通的设置保存就把所有自定义搜索服务
  // 的 Key 静默清空（表现为掩码消失、测试报 invalid API key）。所以合并前按 id
  // 回填现值；想真清除必须显式传 apiKey: ''（专用清除按钮就是显式空串路径）。
  preserveSanitizedSecrets(getConfig(), cleanPatch);
  currentConfig = deepMerge(getConfig(), cleanPatch);
  // 磁盘上可能已经存过历史遗留的派生标记，一并清掉
  stripDerivedFlags(currentConfig);

  // 响应档位：以滑条位置为唯一真相，派生 tier 与随机概率。前端只负责上报滑条
  // 位置（contextSliderPos），档位和概率一律由这里换算，这样即使前端算错、或者
  // 有人直接调接口只传位置，配置也不会自相矛盾。
  const posRaw = currentConfig?.store?.contextSliderPos;
  if (posRaw !== undefined && posRaw !== null) {
    const { tier, randomPercent } = sliderToTier(posRaw);
    currentConfig.store.contextTier = tier;
    currentConfig.store.randomPercent = randomPercent;
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 临时名带 pid：固定名 .tmp 在双开/两核心同数据目录时，A 写一半被 B rename 走，
  // 会落一个半新半旧的 config。
  const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  configVersion += 1;   // 写盘成功才算一次世代更替（见 getConfigVersion 注释）
  // 派生状态刷新放在写盘成功之后：写盘失败时配置并没有真的生效，
  // 提前刷新会让内存态与磁盘态分裂（重启后又变回去）。
  notifyConfigApplied();
  return currentConfig;
}

/** 内存态改动（不落盘），用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
  configVersion += 1;   // 整份配置被替换，同样可能改变工具可用性
  notifyConfigApplied();
}

/**
 * 取某个会话实际生效的人设：全局 persona 被 personaByChat[id] 的同名字段覆盖。
 *
 * 只允许覆盖 roleText / participation / customRules / systemPromptOverride 四个
 * "说话风格"字段；botName / selfNickname 是账号身份，任何会话都不得单独改：
 * 换了会与 @ 判定（isAtMe 用昵称/名字匹配）、存档里"我"的称呼全部对不上。
 * 覆盖值一律做字符串 trim（空串视为"未设置"，回落全局值）。
 */
export function personaForChat(chatKey) {
  const base = getConfig().persona || {};
  const [kind, id] = String(chatKey || '').split(':');
  if (!id) return base;
  const perChat = getConfig().personaByChat || {};
  // 兼容两种键格式：UI 的隐藏 JSON 以 chatKey（group:123）为键保存，
  // 而这里按 id 段（123）查。只认一种格式时保存成功但永不生效。
  const raw = perChat[String(id)] ?? perChat[String(chatKey)];
  if (!raw || typeof raw !== 'object') return base;
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const out = { ...base };
  if (kind === 'group' || kind === 'private') {
    const roleText = pick(raw.roleText);
    const customRules = pick(raw.customRules);
    const systemPromptOverride = pick(raw.systemPromptOverride);
    if (roleText !== undefined) out.roleText = roleText;
    if (customRules !== undefined) out.customRules = customRules;
    if (systemPromptOverride !== undefined) out.systemPromptOverride = systemPromptOverride;
    if (['low', 'medium', 'high'].includes(raw.participation)) out.participation = raw.participation;
  }
  return out;
}

/**
 * 取某个会话实际生效的 store 档位配置。
 * unifiedTier 开启 → 全局 store 原样返回；
 * 关闭 → 群聊查 groupSliderPos，有单独设置就换算出该群的 tier/randomPercent，
 * 其余字段（各档读取条数、关键词表）沿用全局值。私聊永远跟随全局档位。
 *
 * 峰谷切换：peakSchedule.enabled 时，先按当前时间判定落在高峰/低谷时段，
 * 用该时段的 sliderPos 换算出档位**覆盖**全局滑条（在 unifiedTier / 分群设置之前生效）。
 */
export function storeConfigForChat(chatKey) {
  const store = getConfig().store || {};
  // ── 指令禁言：该群被禁言且未到期 → 强制 1 档（仅艾特）──
  const mutedTier = commandMuteTier(chatKey);
  if (mutedTier !== null) {
    return { ...store, contextTier: 1, randomPercent: 0 };
  }
  const [kind, id] = String(chatKey || '').split(':');
  const isGroup = kind === 'group' && !!id;
  const peakOn = store.peakSchedule?.enabled === true;
  const inPeakNow = peakOn && peakWindowActive(store.peakSchedule);

  // 四象限：
  //   统一 + 峰谷关：全局滑条（contextSliderPos）
  //   统一 + 峰谷开：全局峰谷双点按时段取高峰/低谷
  //   分群 + 峰谷关：群无单独设置 → 全局滑条；有 → groupSliderPos[群]
  //   分群 + 峰谷开：群无单独峰谷 → 全局双点按时段取；有 → groupPeakPos[群] 按时段取
  // 私聊永远跟随"全局"口径（峰谷开时同样受时段影响）。
  // 峰谷兜底：peak/valley 任一点缺失时，clampSliderPos 会对 undefined 返回 100
  // （最贵的 4 档），配置残缺反而触发最高成本，这是反直觉的失败模式。改为：缺失点
  // 先回退到全局滑条（用户明确设过的取值），全局滑条也缺失时再回退到 0（最保守的
  // 1 档）。原则是"配置残缺宁可少回，不可爆成本"。
  const fallbackPos = Number.isFinite(Number(store.contextSliderPos))
    ? clampSliderPos(store.contextSliderPos)
    : 0;
  const safePeak = (v) => (v !== undefined && v !== null) ? clampSliderPos(v) : fallbackPos;
  const safeValley = (v) => (v !== undefined && v !== null) ? clampSliderPos(v) : fallbackPos;

  let pos = clampSliderPos(store.contextSliderPos);
  if (peakOn) {
    if (isGroup && store.unifiedTier === false) {
      const gp = store.groupPeakPos?.[id];
      pos = gp
        ? (inPeakNow ? safePeak(gp.peak) : safeValley(gp.valley))
        : (inPeakNow ? safePeak(store.peakSchedule.peak?.sliderPos) : safeValley(store.peakSchedule.valley?.sliderPos));
    } else {
      pos = inPeakNow
        ? safePeak(store.peakSchedule.peak?.sliderPos)
        : safeValley(store.peakSchedule.valley?.sliderPos);
    }
  } else if (isGroup && store.unifiedTier === false) {
    const gp = store.groupSliderPos?.[id];
    if (gp !== undefined && gp !== null) pos = clampSliderPos(gp);
  }
  const { tier, randomPercent } = sliderToTier(pos);
  return { ...store, contextSliderPos: pos, contextTier: tier, randomPercent };
}

/**
 * 当前时间是否落在高峰时段内（峰谷判定的第一步，供 storeConfigForChat 复用）。
 */
function peakWindowActive(ps, at = new Date()) {
  const minutes = at.getHours() * 60 + at.getMinutes();
  const s = parseHHMM(ps?.peak?.start);
  const e = parseHHMM(ps?.peak?.end);
  if (s === null || e === null || s === e) return false;
  if (s < e) return minutes >= s && minutes < e;
  return minutes >= s || minutes < e;
}

/**
 * 指令禁言：该群是否处于禁言期（响应档位被强制为 1 档）。
 * @returns {number|null} 强制档位（1）；未禁言/已到期返回 null
 */
export function commandMuteTier(chatKey, at = Date.now()) {
  const cm = getConfig().commandMute;
  if (!cm || cm.enabled !== true) return null;
  const [kind, id] = String(chatKey || '').split(':');
  if (kind !== 'group' || !id) return null;
  const until = Number(cm.active?.[id]);
  if (!Number.isFinite(until)) return null;
  if (until === 0) return 1;              // 0 = 直到手动解除
  if (at < until) return 1;               // 未到解除时间
  return null;                            // 已到期
}

/**
 * 会话准入（白名单/黑名单），全库唯一的判定实现。
 *
 * 判定此前只存在于 app.js 的 allowed()（消息入口用），发送侧没有任何闸：群被移出
 * 白名单前设下的提醒/闹钟到点照样往那个群发消息，会话运行中途被移出时回复也照发。
 * 现在入口（app.js）与发送咽喉（sender.js 五个发送方法）统一走本函数，语义只维护
 * 这一份，杜绝两处各写一套日后漂移。
 *
 * 语义：
 *   1. deny 命中 → 一票否决
 *   2. allow 名单非空 → 必须在名单内
 *   3. allow 名单为空 → 仅当 allowAllWhenEmpty=true 才放行
 * 键名兼容单复数：allow.group / allow.groups、deny.private / deny.privates。
 */
export function isChatAllowed(kind, id, cfg = getConfig()) {
  const s = String(id);
  const k = String(kind);
  const denyList = cfg.deny?.[k] ?? cfg.deny?.[`${k}s`] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow?.[k] ?? cfg.allow?.[`${k}s`] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty === true;
}

/**
 * 峰谷切换：判定当前时间落在哪个时段，返回该时段的滑条位置（0~100）。
 * 未启用 / 时段未设定 → 返回 null（用全局滑条）。
 * 高峰窗口内 = peak.sliderPos，窗口外一律 = valley.sliderPos（低谷时段不单独编辑）。
 * 这里只算全局双点；分群峰谷（groupPeakPos）由 storeConfigForChat 处理。
 */
export function resolvePeakSliderPos(store, at = new Date()) {
  const ps = store?.peakSchedule;
  if (!ps || ps.enabled !== true) return null;
  if (peakWindowActive(ps, at)) return clampSliderPos(ps.peak?.sliderPos);
  return clampSliderPos(ps.valley?.sliderPos);
}

function parseHHMM(raw) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function clampSliderPos(pos) {
  const n = Number(pos);
  if (!Number.isFinite(n)) return 100;
  return Math.min(100, Math.max(0, n));
}

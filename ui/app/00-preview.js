// 〔预览演示模式〕—— 2026-09-20 新增
//
// 用途：没有真实机器人/后端时也能演示软件 —— 「消息」「用量」页模拟平时
// 正常运行的状态：会话列表有运行中/等待中/已发言/出错的会话，运行中的会话
// 会真的"干活"（翻记录 → 查记忆 → 联网 → 思考 → 发出），用量页三张图表、
// 五张统计卡都有像样的模拟数字，且今日数字随模拟器缓慢上涨。
//
// 入口：设置 →「界面与应用」→ 界面区块的「预览演示模式」滑动开关（切换后写入/
//       清除 #preview 哈希并重载整个界面）；或直接以 index.html#preview 打开。
//       开关的绑定在 07-settings-events.js（设置页是动态渲染的），本文件只在启动时
//       读哈希决定是否进入预览；预览中设置页那个开关会显示为「开」。
//
// 原理：拦截 window.fetch（本文件在 00-core.js 之后、init 之前执行，
//       覆盖一切 api() 调用）：
//   · 路由表命中的 GET 返回模拟数据（status/sessions/chats/usage/config/
//     skills/tools），未命中的 GET 透传真实网络 —— 本机有后端时其余页面照常；
//   · POST/DELETE 一律不落真实后端（预览绝不写脏数据），返回 {ok:true}；
//     ⚠️ 唯两例外：POST /api/config 必须回 {config: 合并后的配置}——
//     回 {ok:true} 会把 state.config 清空（saveConfig 的已知坑）；
//     DELETE /api/sessions/<id> 顺手把模拟会话删掉，否则列表里阴魂不散。
//   · SSE（connectSSE）在预览下短路（见 02-sse-sessions.js），
//     会话推进由下面的模拟器定时器负责。
'use strict';

(function () {
  const on = /preview/.test(String(location.hash || ''))
    || new URLSearchParams(location.search).get('preview') === '1';

  // 入口开关（设置 →「界面与应用」→ 界面区块的「预览演示模式」滑动开关）由设置页
  // 渲染时绑定，见 07-settings-events.js 的 #cfg-previewmode；这里只负责识别哈希并进入预览。
  if (!on) return;

  state.preview = true;   // 02-sse-sessions.js 的 connectSSE 看这个短路；
                          // 也是设置页那个滑动开关的初值来源（renderDesktopSection 读它）

  // ══════════════════ 模拟数据 ══════════════════

  const now = Date.now();
  const MODEL_ID = 'deepseek-v3.2';

  // 预览用的版本号：不再手写 '0.4.6'（发版必漏改，会出现"预览说 0.4.6、
  // 真机说 0.4.7"）。版本由后端在 <html data-app-version> 上注入
  // （真源 = package.json，见 src/app.js 的静态文件响应）；读不到就用
  // '0.0.0-preview' —— 一眼看出这是预览 mock，而不是误以为线上真有个 0.4.6。
  const PV_VERSION = document.documentElement.dataset.appVersion || '0.0.0-preview';

  // ⚠️ 字段必须与后端 GET /api/chats 同形：04-archive-usage.js 的存档左栏直接读
  //    c.total / c.lastText / c.lastTs / c.unread —— 少一个就渲染成「undefined 条」。
  //    （真机由后端补齐，只有预览 mock 会缺，属于预览失真而非产品 bug，但仍要修对。）
  const CHATS = [
    { key: 'group:7366472817', chatName: 'AI 工具交流群', total: 14, unread: 2, lastText: '这周末天气不错，正好。', lastTs: now - 12 * 60e3 },
    { key: 'group:284591630',  chatName: '洛西的开发日常', total: 9,  unread: 0, lastText: '先不用了。', lastTs: now - 48 * 60e3 },
    { key: 'private:10001',    chatName: '张同学',        total: 8,  unread: 1, lastText: '可以点「整理本群记忆」立刻跑一次，平时也会定期整理。', lastTs: now - 5 * 60e3 },
    { key: 'group:918273645',  chatName: '机器人测试群',   total: 5,  unread: 0, lastText: '好，收工。', lastTs: now - 90 * 60e3 }
  ];

  // ── OneBot 群 / 好友列表模拟（GET /api/onebot/groups | /friends，r62）──
  // ⚠️ 之前没模拟：添加会话弹窗点「拉取群聊」会落到 realFetch → 预览下 502。
  //    这里给两份小列表，其中若干已在 CHATS 里（故意留"已添加"的重复项，
  //    好验证弹窗里"已添加"会被禁选）。
  const MOCK_ONEBOT_GROUPS = [
    { id: '7366472817', name: 'AI 工具交流群' },
    { id: '284591630',  name: '洛西的开发日常' },
    { id: '918273645',  name: '机器人测试群' },
    { id: '667788990',  name: '摸鱼划水群' },
    { id: '556677889',  name: '深夜技术沙龙' },
    { id: '223344556',  name: '摄影交流群' }
  ];
  const MOCK_ONEBOT_FRIENDS = [
    { id: '10001', name: '张同学' },
    { id: '10086', name: '李老师' },
    { id: '2846117254', name: '洛西' }
  ];

  // ── 存档消息模拟（GET /api/chats/<key 下划线格式>/messages）──
  // ⚠️ 这个接口之前没有模拟，落在 `/api/chats` 那条上，返回的是 `{ chats: [...] }`，
  //    04-archive-usage.js 取 `data.messages` 得到 undefined → 存档表永远是空的
  //    （从「会话选择」左栏点「存档」时看着就像"没反应"）。
  //    模拟数据按会话生成，行数足够触发分页与滚动加载。
  const PV_ARCH = {
    'group:7366472817': [
      ['阿凯', '有没有好用的本地跑大模型的工具？显存 12G 够不够。'],
      ['洛西', '12G 跑 7B / 8B 的量化版没压力，14B 用 Q4 也塞得下，就是上下文别开太大。'],
      ['小鹿', '我一般直接用 ollama，装完就能跑，省心。'],
      ['老王', '@洛西 那 vLLM 和 llama.cpp 怎么选？'],
      ['洛西', '要并发吞吐选 vLLM，单机偶尔跑跑选 llama.cpp。你这种自己玩儿的，llama.cpp 就够了。'],
      ['阿凯', '记下了，周末试一下。'],
      ['小鹿', '对了周六下午的线下分享有人去吗？'],
      ['洛西', '周六 14:00 那场我有登记，报名的已经 9 个人了。'],
      ['老王', '我去，顺便把上次说的那套提示词带过去。'],
      ['阿凯', '带上我。'],
      ['小鹿', '好，那到时候群里喊一声。'],
      ['洛西', '收到，周五晚上我会在群里提醒一次。'],
      ['阿凯', '辛苦了。'],
      ['小鹿', '这周末天气不错，正好。']
    ],
    'group:284591630': [
      ['张同学', '存档页现在能看到未读标记了吗？'],
      ['洛西', '能了，未读的行左边会标一个「未读」，标为已读之后就没了。'],
      ['张同学', '那「仅屏蔽」和「标为已读」区别是啥？'],
      ['洛西', '标为已读只是清标记；仅屏蔽还会让这条会话不再触发回复，消息本身留着。'],
      ['张同学', '明白了。'],
      ['洛西', '另外清空存档是不可恢复的，点之前会弹确认。'],
      ['张同学', '好，我注意。'],
      ['洛西', '需要的话我可以手动发一条测试消息进去，验证链路。'],
      ['张同学', '先不用了。']
    ],
    'private:10001': [
      ['张同学', '在吗'],
      ['洛西', '在的。'],
      ['张同学', '帮我记一下，明天九点提醒我复盘。'],
      ['洛西', '记好了，明天 9:00 提醒你复盘。'],
      ['张同学', '谢谢。'],
      ['洛西', '客气。'],
      ['张同学', '顺便问下记忆整理是自动的吗？'],
      ['洛西', '可以点「整理本群记忆」立刻跑一次，平时也会定期整理。']
    ],
    'group:918273645': [
      ['测试号', '连通性测试 01'],
      ['洛西', '收到，链路正常。'],
      ['测试号', '连通性测试 02（带图）'],
      ['洛西', '图片通道也正常。'],
      ['测试号', '好，收工。']
    ]
  };
  function mockChatMessages(key) {
    const rows = PV_ARCH[key] || [];
    const base = now - 3600e3;
    return rows.map((r, i) => ({
      id: 90000 + i,
      ts: base + i * 137e3,
      self: r[0] === '洛西',
      senderName: r[0],
      text: r[1],
      read: i < rows.length - 2          // 末尾两条留成未读，好看清未读样式
    }));
  }

  // ⚠️ 必须**覆盖设置页每个分区读到的字段**。缺项不会优雅降级：
  //    06-settings-render.js 里大量是 `c.persona.botName` / `c.proactive.enabled`
  //    / `c.protocol.wsUrl` 这种不带 ?. 的直取 —— 少一个键，对应分区直接抛
  //    "Cannot read properties of undefined"，切过去看到的是空页（预览模式一度如此）。
  // 预览用的内置人设文本。**必须与 MOCK_CONFIG.persona.roleText 完全一致** ——
  // 「选择人设」是拿当前角色设定文本去反查命中的模板，不一致就永远显示"点击选择人设"。
  const PV_PERSONA_TEXT = '你是「洛西」，一个活跃在 QQ 群里的 AI 伙伴。说话口语化、简短，一次别超过三句；群里聊得热闹时可以发表情包凑趣。';

  // 人设模板：2 个内置 + 1 个自定义。选择/添加/删除人设 全读它 ——
  // 不 mock 的话预览下点「选择人设」永远弹"人设列表为空"，
  // 弹窗里的「删除当前自定义人设」按钮也永远不会出现。
  let pvCustomPersonas = [
    { name: '毒舌老哥', text: '你是个嘴上不饶人、心里很软的群友。吐槽要短、要准，别真伤人。', customRules: '玩笑止于调侃，涉及家人/外貌的话题一律不接。' }
  ];
  function mockPersonaTemplates() {
    const builtins = [
      { id: 'xiaojingyu', name: '小鲸鱼（内置）', text: PV_PERSONA_TEXT, builtin: true },
      { id: 'lengmian', name: '冷面吐槽役（内置）', text: '你话很少，只在关键处插一句，句子短、信息密度高，不寒暄。', builtin: true }
    ];
    const customs = pvCustomPersonas.map((p, i) => ({
      id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
    }));
    return [...builtins, ...customs];
  }

  const MOCK_CONFIG = {
    api: {
      baseUrl: 'https://api.preview.example.com/v1',
      model: MODEL_ID,
      provider: 'preview',
      vision: true,
      visionModel: MODEL_ID,
      videoModel: '',
      useOfficialPrice: true
    },
    // ⚠️ 后端白名单权威格式是**裸号**（src/store.js allowed() / routes.js 直接
    //    includes(String(id))）。这里以前写的是带前缀的 chatKey —— 于是预览下
    //    设置页输入框会显示 group:xxx、选择弹窗勾选态也对不上，与真机契约不一致。
    allow: { groups: ['7366472817', '284591630', '918273645'], private: ['10001'] },
    allowAllWhenEmpty: false,
    webSearch: {
      enabled: true,
      // R38：预览默认选中一条自定义服务 —— 复现真实使用场景（URL 输入框可见），
      // 也让「添加自定义搜索服务」入口按钮与上方控件间距的验收有真实上下文。
      provider: 'custom:demo-bing',
      providers: [
        { id: 'demo-bing', name: 'Bing 兼容页', type: 'bing', baseUrl: 'https://cn.bing.com/search', hasApiKey: false }
      ],
      searchUrl: 'https://cn.bing.com/search',
      deepseek: { hasApiKey: false },
      zhipu: { hasApiKey: false },
      bocha: { hasApiKey: false },
      baidu: { hasApiKey: false },
      metaso: { hasApiKey: false }
    },
    tools: { enabled: true, categories: {}, overrides: {}, crossChatSend: false },
    ui: { refreshMs: 4000, showVision: true },
    server: { autoStart: false, closeToTray: true },
    proactive: { enabled: true, checkIntervalMinMs: 900000, checkIntervalMaxMs: 1500000, probability: 0.25 },
    sticker: { enabled: true, encourage: 2, promptMaxStickers: 12 },
    persona: {
      botName: '洛西',
      selfNickname: '洛西Bot',
      participation: 'medium',
      roleText: PV_PERSONA_TEXT,   // 与内置人设 xiaojingyu 一致，选择器才认得出
      customRules: '',
      systemPromptOverride: ''
    },
    personaUnified: true,
    // 会话卡片上要显示"该群的回复频率"，预览里得能看出三档差别：
    // 故意一个用纯 id 作键、一个用 chatKey 作键 —— 同时覆盖后端 personaForChat
    // 认的两种格式（只认一种会出现"设了却不生效"）。没列的群跟随全局（普通群友）。
    personaByChat: {
      '7366472817': { participation: 'high' },        // AI 工具交流群 → 活跃型
      'group:284591630': { participation: 'low' }      // 洛西的开发日常 → 安静型
    },
    memory: {
      enabled: true,                     // r43 快捷开关「记忆功能」总开关
      consolidateEnabled: true,
      useChatModel: true,
      provider: '',
      model: '',
      consolidateMinIntervalMs: 21600000
    },
    autoReply: { enabled: true },        // r43 快捷开关「自动回复」总开关
    cacheWarm: { enabled: false, intervalMin: 10 },
    // 「会话设置」页（r33）读的三块按会话数据 —— 预览里补上有内容的样例，
    // 否则那一页永远是"跟随全局 / 未禁言 / 名单为空"，看不出"按会话"到底长什么样。
    store: {
      unifiedTier: false,                                    // 分群档位模式：档位下拉才会出现
      contextSliderPos: 100,                                 // 全局兜底 = 4 档全响应
      groupSliderPos: { '7366472817': 100, '284591630': 15 },// AI 工具交流群=4 档；开发日常=2 档(≤20)
      groupPeakPos: {}
    },
    commandMute: { enabled: true, command: '/安静', durationMin: 30, active: { '284591630': 0 } }, // 开发日常手动禁言中
    blocklist: { '7366472817': ['10086', '10087', '10088'] }, // AI 工具交流群屏蔽了 3 人
    // 2026-10-23：snowluma 块 → protocol（协议端由用户自装，配置里只剩端点与令牌）。
    protocol: {
      wsUrl: 'ws://127.0.0.1:3901',
      httpUrl: 'http://127.0.0.1:3900',
      hasAccessToken: true,
      hasHttpAccessToken: false
    }
  };

  // 提供商目录：模型配置弹窗、模型选择器、页面上的「当前：…」提示都读它。
  // 不 mock 的话这些地方在预览下全是"尚未选择模型"。
  const MOCK_PROVIDERS = [{
    id: 'preview',
    displayName: '预览渠道',
    baseURL: 'https://api.preview.example.com/v1',
    apiKey: '',
    apiKeyFrom: 'config',
    needsBaseUrl: true,
    hasKey: true,
    anthropicOrigin: false,
    apiProtocol: 'openai',
    models: [MODEL_ID, 'qwen3-235b-a22b', 'gemini-2.5-flash'],
    modelNames: {
      [MODEL_ID]: 'DeepSeek V3.2',
      'qwen3-235b-a22b': 'Qwen3 235B',
      'gemini-2.5-flash': 'Gemini 2.5 Flash'
    }
  }];

  const MODELS = [
    { key: 'deepseek:deepseek-v3.2', vendor: 'DeepSeek', model: 'deepseek-v3.2',  share: 0.46 },
    { key: 'qwen:qwen3-235b-a22b',   vendor: 'Qwen',     model: 'qwen3-235b-a22b', share: 0.28 },
    { key: 'google:gemini-2.5-flash', vendor: 'Google',  model: 'gemini-2.5-flash', share: 0.17 },
    { key: 'moonshot:kimi-k2',       vendor: 'Moonshot', model: 'kimi-k2',         share: 0.09 }
  ];

  const MOCK_SKILLS = [
    { id: 'sticker-master',  kind: 'skill', name: '表情包大师',   version: '1.2.0', description: '按聊天氛围自动挑表情包，支持收藏与备注。', dir: 'skills/sticker-master',  loaded: true, enabled: true,  active: true,  toolIds: ['send_sticker', 'list_stickers', 'collect_sticker'] },
    { id: 'web-researcher',  kind: 'skill', name: '联网研究员',   version: '2.0.1', description: '多步联网检索与网页阅读，回答前先核实事实。', dir: 'skills/web-researcher',  loaded: true, enabled: true,  active: true,  toolIds: ['web_search', 'web_fetch'], requiresSearch: true },
    { id: 'memory-keeper',   kind: 'skill', name: '记忆管家',     version: '1.4.2', description: '维护长期记忆：记录、检索与定期整理。',       dir: 'skills/memory-keeper',   loaded: true, enabled: true,  active: true,  toolIds: ['memory_append', 'memory_query'] },
    { id: 'group-watcher',   kind: 'skill', name: '群氛围观察员', version: '0.9.0', description: '统计群活跃度，在合适的时机接话。',           dir: 'skills/group-watcher',   loaded: true, enabled: false, active: false, toolIds: ['get_active_members'] },
    { id: 'img-compat',  kind: 'plugin', name: '图片兼容层',   version: '1.0.3', description: '把各类图片格式统一转成模型可读的输入。', dir: 'plugins/img-compat',  loaded: true, enabled: true, active: true, capabilities: ['vision.image'] },
    { id: 'load-balance', kind: 'plugin', name: '渠道负载均衡', version: '1.1.0', description: '多个 API 渠道间自动切换与重试。',       dir: 'plugins/load-balance', loaded: true, enabled: true, active: true, capabilities: ['provider.pick'] },
    { id: 'echo-test',   kind: 'plugin', name: '消息过滤器',   version: '0.5.1', description: '按白名单与关键词过滤入站消息。',         dir: 'plugins/echo-test',   loaded: true, enabled: true, active: true, capabilities: ['hook.message'] },
    { id: 'qr-helper',   kind: 'plugin', name: '二维码工具箱', version: '1.0.0', description: '生成与识别群二维码。',                   dir: 'plugins/qr-helper',   loaded: false, enabled: true, active: false, loadError: '插件入口缺失：plugins/qr-helper/index.js 不存在' }
  ];

  /* ── 市场模拟（r87：应用内市场页的预览数据）──
     形状刻意与后端 /api/market/list 的字段白名单一致（去掉 authorId 等内部字段），
     并混入一条 pending（无 installCode）+ 一条已安装的，覆盖三种卡片状态。
     下载量/更新时间给的是与线上同类型的真实量级，便于验证排序与紧凑格式。 */
  const MOCK_MARKET_CATS = {
    knowledge: '知识库', media: '媒体与多媒体', message: '消息与身份',
    model: '模型与推理', other: '其他', utility: '工具与运行控制'
  };
  function mockMarketItems(kind) {
    const now = Date.now();
    const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();
    if (kind === 'plugin') {
      return [
        { id: 'poke-mute', name: '被戳几次就禁言', author: '威牢二', version: '1.1.0', category: 'message', categoryName: '消息与身份', status: 'approved', downloads: 42, installCode: 'PM1A2B', updatedAt: iso(0.2), description: '在同一时间窗里被同一个人戳了设定次数后，向模型注入一条硬性规矩：用群管理技能禁言对方若干秒。只在群聊生效。' },
        { id: 'img-compat-mkt', name: '图片兼容层', author: 'kondius', version: '1.0.3', category: 'media', categoryName: '媒体与多媒体', status: 'approved', downloads: 1380, installCode: 'PM3C4D', updatedAt: iso(4), description: '把各类图片格式统一转成模型可读的输入，解决部分渠道不支持 webp 的问题。' },
        { id: 'load-balance-mkt', name: '渠道负载均衡', author: 'neuro', version: '1.1.0', category: 'model', categoryName: '模型与推理', status: 'approved', downloads: 96, installCode: 'PM5E6F', updatedAt: iso(9), description: '多个 API 渠道间自动切换与重试，某个渠道 429 时自动换下一个。' },
        { id: 'new-plugin-wip', name: '正在审核的插件', author: 'tester', version: '0.1.0', category: 'utility', categoryName: '工具与运行控制', status: 'pending', downloads: 0, updatedAt: iso(1), description: '这是一条尚未通过审核的条目，没有安装口令，卡片上应显示「待审核」且按钮不可用。' }
      ];
    }
    return [
      { id: 'bangumi-lookup', name: '番剧资料查询（Bangumi）', author: 'miawu', version: '1.1.0', category: 'knowledge', categoryName: '知识库', status: 'approved', downloads: 9, installCode: 'DWJ3M4', updatedAt: iso(0.7), description: '让机器人查得到番剧/动漫的真实资料：评分排名、放送日期、集数与更新进度、简介、制作阵容、角色与声优。数据来源 Bangumi 公开 API，不需要任何 Key。' },
      { id: 'cross-group-memory', name: '跨群记忆（避免换个群就认不出来）', author: 'kondius', version: '1.2.0', category: 'knowledge', categoryName: '知识库', status: 'approved', downloads: 1240, installCode: 'XM8K9Q', updatedAt: iso(2), description: '把不同群的同一用户识别为一个人，长期记忆跨群共享。装完在设置里选择要合并的群即可。' },
      { id: 'web-screenshot', name: '网页截图', author: '风语', version: '2.0.0', category: 'media', categoryName: '媒体与多媒体', status: 'approved', downloads: 318, installCode: 'WS2T7Y', updatedAt: iso(0.5), description: '给一个网址，直接把网页渲染成图片发出来。群友丢链接说「截个图看看」时特别好用。' },
      { id: 'sticker-master', name: '表情包大师', author: 'gulugulu', version: '1.2.0', category: 'message', categoryName: '消息与身份', status: 'approved', downloads: 5600, installCode: 'ST4R5E', updatedAt: iso(6), description: '按聊天氛围自动挑表情包，支持收藏与备注。（这条与本机已装技能同 id，预览里用于验证「已安装」卡片态。）' },
      { id: 'mood-core', name: '情绪内核', author: '洛西', version: '1.0.4', category: 'model', categoryName: '模型与推理', status: 'approved', downloads: 12, installCode: 'MO6D8E', updatedAt: iso(13), description: '给机器人加一层情绪状态：心情好时更活泼，被惹到时会顶嘴。状态会影响回复语气而非内容事实。' },
      { id: 'twenty-q', name: '动漫20问小游戏', author: 'gulugulu', version: '1.1.0', category: 'utility', categoryName: '工具与运行控制', status: 'approved', downloads: 37, installCode: 'TQ9F0G', updatedAt: iso(0.1), description: '让机器人当出题人玩「20问」：谜底由程序从内置动漫词库随机抽，只有机器人知道；最多问 20 个只能用「是/不是/不确定」回答的问题来猜。' },
      { id: 'game-card-lookup', name: '游戏王卡片效果查询', author: 'duelist', version: '1.0.1', category: 'other', categoryName: '其他', status: 'approved', downloads: 3, installCode: 'GC1H2J', updatedAt: iso(20), description: '群友报卡名或效果关键词，查出正式卡面效果与调整信息。数据来自公开卡池。' },
      { id: 'owner-persona', name: '主人改人设', author: '康仔', version: '0.9.0', category: 'message', categoryName: '消息与身份', status: 'approved', downloads: 10, installCode: 'OP3K4L', updatedAt: iso(5), description: '只有「主人」（配置里指定的 QQ 号）才允许通过聊天直接修改机器人的人设与白名单。' },
      { id: 'draft-skill-wip', name: '还没过审的技能', author: 'tester', version: '0.0.1', category: 'utility', categoryName: '工具与运行控制', status: 'pending', downloads: 0, updatedAt: iso(0.3), description: '这条是 pending 状态，用来验证「待审核」徽标与「不可用」按钮。' }
    ];
  }

  const MOCK_TOOLS = [
    { id: 'send_message',         category: 'messaging', icon: '💬', name: '发消息',     description: '把生成的回复发送到 QQ 群或私聊。', defaultEnabled: true },
    { id: 'send_sticker',         category: 'sticker',   icon: '🎴', name: '发表情包',   description: '从表情库里挑一张合适的表情包发出去。', defaultEnabled: true },
    { id: 'collect_sticker',      category: 'sticker',   icon: '⭐', name: '收藏表情',   description: '把群里的好图收进表情库。', defaultEnabled: true },
    { id: 'get_recent_messages',  category: 'query',     icon: '📜', name: '翻聊天记录', description: '查看群里最近的聊天记录。', defaultEnabled: true },
    { id: 'get_active_members',   category: 'query',     icon: '👥', name: '看活跃群友', description: '统计一段时间内最活跃的群成员。', defaultEnabled: false },
    { id: 'get_message_images',   category: 'query',     icon: '🖼️', name: '看图片',     description: '读取消息里的图片内容。', defaultEnabled: true, requiresVision: true },
    { id: 'memory_append',        category: 'memory',    icon: '🧠', name: '记一条',     description: '把值得记住的事情写进长期记忆。', defaultEnabled: true },
    { id: 'memory_query',         category: 'memory',    icon: '🧠', name: '查记忆',     description: '按关键词检索长期记忆。', defaultEnabled: true },
    { id: 'web_search',           category: 'web',       icon: '🌐', name: '联网搜索',   description: '搜索互联网获取实时信息。', defaultEnabled: true },
    { id: 'web_fetch',            category: 'web',       icon: '🔗', name: '抓网页',     description: '抓取指定网页的正文内容。', defaultEnabled: true, requiresSearch: true },
    { id: 'send_poke',            category: 'system',    icon: '👆', name: '戳一戳',     description: '回应戳一戳事件。', defaultEnabled: true },
    { id: 'report_feedback',      category: 'system',    icon: '📣', name: '汇报反馈',   description: '把运行中的问题汇报给作者。', defaultEnabled: true }
  ];

  const SYSPROMPT = '你是「洛西」，一个活跃在 QQ 群里的 AI 伙伴。说话口语化、简短，一次别超过三句；'
    + '群里聊得热闹时可以发表情包凑趣。涉及事实性问题时先用联网搜索核实再回答。'
    + '记住群友告诉你的事（用记忆工具）。不讨论政治敏感话题，不发广告。';

  // ── 记忆页模拟（loadMemoryView 需要 /api/memory-files；
  //    详情需要 /api/memory-files/<chatKey 下划线格式>）──
  const MOCK_MEMORY_FILES = [
    { chatKey: 'group:7366472817', memberCount: 3, impressionCount: 7, updatedAt: now - 3 * 864e5 },
    { chatKey: 'group:284591630',  memberCount: 2, impressionCount: 4, updatedAt: now - 9 * 864e5 },
    { chatKey: 'private:10001',    memberCount: 1, impressionCount: 5, updatedAt: now - 12 * 864e5 },
    { chatKey: 'group:918273645',  memberCount: 0, impressionCount: 0, updatedAt: now - 30 * 864e5 }
  ];
  // 键为 chatKey 里的 ":" 换成 "_"（与 loadMemoryDetail 的 .replace(':', '_') 一致）
  const MOCK_MEMORY = {
    'group_7366472817': {
      members: [
        { userId: '208812345', name: '阿凯', updatedAt: now - 2 * 864e5, impressions: [{ content: '常在群里问活动安排，语气随意。', createdAt: now - 6 * 864e5 }, { content: '对 AI 工具很感兴趣，喜欢追新。', createdAt: now - 2 * 864e5 }] },
        { userId: '208866666', name: '小鹿', updatedAt: now - 5 * 864e5, impressions: [{ content: '周六下午比较闲，常参与线下活动。', createdAt: now - 5 * 864e5 }] },
        { userId: '208877777', name: '老王', updatedAt: now - 1 * 864e5, impressions: [{ content: '爱吐槽游戏，发言频率高。', createdAt: now - 9 * 864e5 }, { content: '不太喜欢被 @，介意时直接说。', createdAt: now - 4 * 864e5 }, { content: '对价格敏感，问过几次性价比。', createdAt: now - 1 * 864e5 }] }
      ]
    },
    'group_284591630': {
      members: [
        { userId: '10001', name: '张同学', impressions: [{ content: '让机器人明天 9 点提醒复盘（已记）。' }, { content: '关注开发进度，常问下一步计划。' }] },
        { userId: '10002', name: '李工', impressions: [{ content: '负责后端，偏好简洁的技术方案。' }] }
      ]
    },
    'private_10001': {
      members: [
        { userId: '10001', name: '张同学', impressions: [{ content: '私聊里比较客气，开场常问"在吗"。' }, { content: '希望机器人能帮他总结聊天记录。' }, { content: '对提醒类功能有需求。' }] }
      ]
    },
    'group_918273645': { members: [] }
  };

  // ── 会话（列表与详情共用同一批对象）──
  // cachedTokens：让预览里的「缓存 XX%」有像样的数字（真实后端 /api/sessions 也带这个字段）
  function mkUsage(calls, pt, ct) {
    const cachedTokens = Math.round(pt * (0.58 + ((calls * 13) % 22) / 100));
    return { calls, promptTokens: pt, completionTokens: ct, totalTokens: pt + ct, cachedTokens };
  }

  const pvSessions = [
    {
      id: 'pv-run-1', chatKey: 'group:7366472817', status: 'running',
      trigger: '群消息：@洛西Bot 周末的活动定在几点来着？', triggerSummary: '群消息 · @洛西Bot',
      startedAt: now - 2 * 60e3, endedAt: null, rounds: 1, webSearchCount: 0,
      activity: '正在思考…', model: MODEL_ID, waitUntil: null,
      usage: mkUsage(2, 5640, 342), error: null, finishReason: null,
      systemPrompt: SYSPROMPT,
      userPrompt: '【群 AI 工具交流群 的最新消息】\n阿凯：@洛西Bot 周末的活动定在几点来着？\n小鹿：好像周六下午?\n\n（请回复上面与你相关的提问。）',
      messages: [
        { role: 'assistant', content: '有群友在问周末活动的时间……我记得群里之前讨论过，先翻一下最近的聊天记录确认。' }
      ],
      sent: []
    },
    {
      id: 'pv-done-1', chatKey: 'group:284591630', status: 'done',
      trigger: '群消息：@洛西Bot 明天提醒我复盘', triggerSummary: '群消息 · @洛西Bot',
      startedAt: now - 26 * 60e3, endedAt: now - 24 * 60e3, rounds: 2, webSearchCount: 0,
      activity: '', model: MODEL_ID, waitUntil: null,
      usage: mkUsage(3, 9640, 612), error: null, finishReason: 'stop',
      systemPrompt: SYSPROMPT,
      userPrompt: '【群 洛西的开发日常 的最新消息】\n张同学：@洛西Bot 明天提醒我复盘\n\n（请回复上面与你相关的提问。）',
      messages: [
        { role: 'assistant', content: '张同学要一个明天的提醒……先把这件事写进记忆，再跟他确认时间。' },
        { toolCall: { name: 'memory_append', args: { text: '提醒张同学明天 9:00 复盘' }, result: '已记住（记忆 #128）', isError: false } },
        { role: 'assistant', content: '好了，跟用户确认一下时间就发出去。' },
        { toolCall: { name: 'send_message', args: { text: '好，明天早上 9 点我会在群里提醒你复盘。' }, result: '已发送', isError: false } }
      ],
      sent: [{ at: '20:47:12', text: '好，明天早上 9 点我会在群里提醒你复盘。' }]
    },
    {
      id: 'pv-wait-1', chatKey: 'private:10001', status: 'waiting',
      trigger: '私聊消息：在吗', triggerSummary: '私聊消息',
      startedAt: now - 40e3, endedAt: null, rounds: 0, webSearchCount: 0,
      activity: '', model: MODEL_ID, waitUntil: now + 52e3,
      usage: null, error: null, finishReason: null,
      systemPrompt: SYSPROMPT, userPrompt: '【私聊 张同学】\n张同学：在吗\n\n（等待冷却结束再处理。）',
      messages: [], sent: []
    },
    {
      id: 'pv-noreply-1', chatKey: 'group:918273645', status: 'noreply',
      trigger: '群消息（未 @）：这游戏真难玩', triggerSummary: '群消息 · 未 @',
      startedAt: now - 55 * 60e3, endedAt: now - 54 * 60e3, rounds: 1, webSearchCount: 0,
      activity: '', model: MODEL_ID, waitUntil: null,
      usage: mkUsage(1, 3120, 96), error: null, finishReason: 'noreply',
      systemPrompt: SYSPROMPT,
      userPrompt: '【群 机器人测试群 的最新消息】\n老王：这游戏真难玩\n\n（消息未 @ 你；判断是否需要接话。）',
      messages: [
        { role: 'assistant', content: '他们在聊游戏吐槽，没 @ 我而且聊得正热闹，这时候插话不合适，保持沉默。' }
      ],
      sent: []
    },
    {
      // r88：这条刻意用**用户截图里那条真实报错**，用来验证「说人话」卡片。
      // errorHuman / errorRaw 的形状与后端 src/error-l10n.js 产出的完全一致。
      id: 'pv-err-1', chatKey: 'group:7366472817', status: 'error',
      trigger: '群消息：@洛西Bot 帮我算下这个', triggerSummary: '群消息 · @洛西Bot',
      startedAt: now - 88 * 60e3, endedAt: now - 87 * 60e3, rounds: 1, webSearchCount: 0,
      activity: '⚠️ 出错：模型名填错了', model: MODEL_ID, waitUntil: null,
      usage: mkUsage(1, 4880, 0), finishReason: null,
      error: '模型 API HTTP 400：{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed DS v41f. (request_id: 2f8cb36b-cd39-4504-9b95-9d33e3698f62)","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}',
      errorHuman: {
        title: '模型名填错了',
        what: '你填的「DS v41f」这个模型服务端不认。',
        fix: '改成服务商支持的其中一个：deepseek-flash / deepseek-v4-pro。',
        target: 'settings-api'
      },
      errorRaw: '模型 API HTTP 400：{"error":{"message":"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed DS v41f. (request_id: 2f8cb36b-cd39-4504-9b95-9d33e3698f62)","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}',
      systemPrompt: SYSPROMPT, userPrompt: '【群 AI 工具交流群】\n阿凯：@洛西Bot 帮我算下这个\n\n（模型请求超时。）',
      messages: [], sent: []
    },
    {
      // r88 兜底路径样本：没有 errorHuman（未知错误 / 老数据）→ 应原样显示红字，
      // 不能因为"美化"把信息吞掉。这条用来锁住那个退化行为。
      id: 'pv-err-2', chatKey: 'private:10001', status: 'error',
      trigger: '私聊：在吗', triggerSummary: '私聊 · 在吗',
      startedAt: now - 150 * 60e3, endedAt: now - 149 * 60e3, rounds: 1, webSearchCount: 0,
      activity: '⚠️ 出错：模型请求超时（30s），已放弃本次处理。', model: MODEL_ID, waitUntil: null,
      usage: mkUsage(1, 4880, 0), error: '模型请求超时（30s），已放弃本次处理。', finishReason: null,
      systemPrompt: SYSPROMPT, userPrompt: '【与 小鹿 的私聊】\n小鹿：在吗',
      messages: [], sent: []
    },
    {
      id: 'pv-done-2', chatKey: 'group:7366472817', status: 'done',
      trigger: '群消息：@洛西Bot 最近有什么 AI 新消息？', triggerSummary: '群消息 · @洛西Bot',
      startedAt: now - 132 * 60e3, endedAt: now - 128 * 60e3, rounds: 3, webSearchCount: 1,
      activity: '', model: MODEL_ID, waitUntil: null,
      usage: mkUsage(5, 14280, 1035), error: null, finishReason: 'stop',
      systemPrompt: SYSPROMPT,
      userPrompt: '【群 AI 工具交流群 的最新消息】\n小鹿：@洛西Bot 最近有什么 AI 新消息？\n\n（先联网核实再回答。）',
      messages: [
        { role: 'assistant', content: '要聊"最近的新消息"必须先联网，不能凭印象说。' },
        { toolCall: { name: 'web_search', args: { query: '本周 AI 领域 重要发布' }, result: '返回 5 条结果（3 篇新闻 + 2 个官方公告）。', isError: false } },
        { role: 'assistant', content: '挑两条最靠谱的总结给群里，语气口语一点。' },
        { toolCall: { name: 'send_message', args: { text: '这两天比较大的事：一是主流模型都把上下文拉到了百万级；二是开源侧新出的 MoE 模型性价比很高，本地部署门槛又降了。' }, result: '已发送', isError: false } }
      ],
      sent: [{ at: '19:03:47', text: '这两天比较大的事：一是主流模型都把上下文拉到了百万级；二是开源侧新出的 MoE 模型性价比很高，本地部署门槛又降了。' }]
    }
  ];

  // ── 模拟器状态：今日数字缓慢上涨 + 运行中会话按剧本推进 ──
  const sim = { todayRuns: 12, todayTokens: 45680, todayCost: 0.87, tick: 0, runSeq: 2 };

  const RUNNING_STEPS = [
    { activity: '正在翻聊天记录…', rounds: 2, msg: { toolCall: { name: 'get_recent_messages', args: { count: 20 }, result: '（最近 20 条群消息已注入）周末活动在周六 14:00，地点未定。', isError: false } } },
    { activity: '正在查记忆…', rounds: 3, msg: { toolCall: { name: 'memory_query', args: { query: '周末活动' }, result: '命中 2 条：周六 14:00 线下分享；周日全天自由交流。', isError: false } } },
    { activity: '正在联网核实地点…', rounds: 4, search: true, msg: { toolCall: { name: 'web_search', args: { query: 'AI 工具交流群 周六 活动 地点' }, result: '返回 3 条结果，已作为参考。', isError: false } } },
    { activity: '正在组织回复…', rounds: 4, msg: { role: 'assistant', content: '信息齐了：周六下午 2 点，地点还在等组织者确认。整理成两句话发到群里。' } }
  ];

  function fmtClock(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  // ⚠️ 必须按**状态**找，不能按 id 前缀找：会话 id 恒为 pv-run-*，
  //    一旦收尾变成 done，按前缀匹配仍会把它捞回来继续"推进"，
  //    结果 Account 分支永远走不到、新一轮会话永远开不起来。
  function currentRunning() { return pvSessions.find((s) => s.status === 'running'); }

  function pushNewRunningSession() {
    const chatKeys = ['group:7366472817', 'group:918273645', 'private:10001', 'group:284591630'];
    const chatKey = chatKeys[sim.runSeq % chatKeys.length];
    const triggers = [
      '群消息：@洛西Bot 在吗，问个事',
      '私聊消息：帮我总结下昨天聊的',
      '群消息（未 @）：机器人还没睡？',
      '群消息：@洛西Bot 讲个笑话'
    ];
    pvSessions.unshift({
      id: `pv-run-${sim.runSeq}`, chatKey, status: 'running', stepIdx: 0,
      trigger: triggers[sim.runSeq % triggers.length],
      triggerSummary: chatKey.startsWith('private') ? '私聊消息' : '群消息 · @洛西Bot',
      startedAt: Date.now(), endedAt: null, rounds: 1, webSearchCount: 0,
      activity: '正在思考…', model: MODEL_ID, waitUntil: null,
      usage: mkUsage(1, 1850, 64), error: null, finishReason: null,
      systemPrompt: SYSPROMPT,
      userPrompt: '【新消息到达，正在处理……（预览模拟）】',
      messages: [{ role: 'assistant', content: '先看看这条消息在说什么。' }],
      sent: []
    });
    if (pvSessions.length > 12) pvSessions.length = 12;   // 别让演示列表无限涨
    sim.runSeq += 1;
  }

  function pvTick() {
    try {
      sim.tick += 1;
      sim.todayTokens += 900 + Math.floor(Math.random() * 700);
      sim.todayCost = Math.round((sim.todayCost + 0.004) * 1000) / 1000;
      if (sim.tick % 3 === 0) sim.todayRuns += 1;

      // 等待中的会话冷却结束 → 变运行中
      for (const s of pvSessions) {
        if (s.status === 'waiting' && s.waitUntil && s.waitUntil < Date.now()) {
          s.status = 'running';
          s.activity = '正在思考…';
          s.waitUntil = null;
        }
      }

      // 运行中的会话按剧本推进；剧本演完 → 发出消息收尾，隔两拍开新会话
      const cur = currentRunning();
      if (cur) {
        // 用 stepIdx 推进剧本（不再拿 rounds 反推索引）：
        //   此前最后一步的 rounds 目标值与自身持平 → rounds 饱和在 4，
        //   而收尾条件是 `rounds > RUNNING_STEPS.length`（即 ≥5）—— 恒不成立，
        //   于是会话永远停在「正在组织回复…」、每 5 秒还往详情里 push 一条重复消息，
        //   且永远不会发言 / 完成 / 开新一轮（2026-09-24 UI 审查 P1）。
        const i = Number.isInteger(cur.stepIdx) ? cur.stepIdx : 0;
        const step = RUNNING_STEPS[i];
        if (step) {
          // 冷却结束从 waiting 转 running 的会话 usage 是 null，得兜底（否则 TypeError
          // 会被 pvTick 的 try/catch 静默吞掉，模拟器就此停摆）。
          const u = cur.usage || { calls: 0, promptTokens: 0, completionTokens: 0 };
          cur.activity = step.activity;
          cur.rounds = step.rounds;
          cur.messages.push(step.msg);
          cur.usage = mkUsage(u.calls + 1, u.promptTokens + 2600 + Math.floor(Math.random() * 900), u.completionTokens + 180);
          if (step.search) cur.webSearchCount += 1;
          cur.stepIdx = i + 1;
        } else {
          // 收尾：发出消息 → done
          cur.status = 'done';
          cur.activity = '';
          cur.endedAt = Date.now();
          cur.finishReason = 'stop';
          cur.messages.push({ role: 'assistant', content: '回复已经组织好，直接发出去。' });
          cur.sent = [{ at: fmtClock(Date.now()), text: '周六下午 2 点开始，地点定了会在群里再喊一声。' }];
          cur.cooldown = 2;
        }
      } else {
        // 没有运行中的会话：冷却计数后开新一轮
        const lastDone = pvSessions.find((s) => s.cooldown != null);
        if (lastDone) {
          lastDone.cooldown -= 1;
          if (lastDone.cooldown <= 0) { delete lastDone.cooldown; pushNewRunningSession(); }
        } else {
          pushNewRunningSession();
        }
      }

      // 页面在会话页就原地重绘（渲染函数自带指纹去重，内容没变不会动 DOM）
      if (state.tab === 'sessions') {
        renderSessionList();
        const curId = state.currentSessionId;
        const curS = curId && pvSessions.find((s) => s.id === curId);
        if (curS) renderSessionDetail(curS);
      }
    } catch { /* 模拟器任何一步出错都不能影响页面 */ }
  }

  // ── 用量统计生成 ──
  const RUNS_PATTERN = [31, 24, 38, 27, 35, 19, 42, 33, 29, 37, 26, 40, 34, 28, 36, 22, 39, 31, 44, 27, 35, 30, 38, 25, 33, 41, 29, 36, 32, 28, 39, 34, 27, 43, 30, 26, 37, 31, 35, 29, 38, 33, 28, 40, 32];
  const r2 = (v) => Math.round(v * 100) / 100;

  function dayRow(daysAgo) {
    const d = new Date(Date.now() - daysAgo * 864e5);
    const p = (n) => String(n).padStart(2, '0');
    const label = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    if (daysAgo === 0) {
      // 今天：接模拟器的实时数字（会随轮询慢慢涨）
      const promptTokens = Math.round(sim.todayTokens * 0.9);
      const completionTokens = sim.todayTokens - promptTokens;
      const cachedTokens = Math.round(promptTokens * 0.68);
      return { key: label, day: label, runs: sim.todayRuns, promptTokens, completionTokens, cachedTokens, cacheHitRate: 0.68, cost: sim.todayCost };
    }
    const runs = RUNS_PATTERN[daysAgo % RUNS_PATTERN.length];
    const promptTokens = Math.round(runs * (3100 + ((daysAgo * 137) % 900)));
    const completionTokens = Math.round(runs * (290 + ((daysAgo * 53) % 90)));
    const cachedTokens = Math.round(promptTokens * (0.62 + ((daysAgo * 7) % 14) / 100));
    return {
      key: label, day: label, runs, promptTokens, completionTokens, cachedTokens,
      cacheHitRate: cachedTokens / promptTokens,
      cost: r2(runs * (0.031 + ((daysAgo * 11) % 7) / 1000))
    };
  }

  function rowsFromTotals(t, names, shares) {
    return names.map((nm, i) => {
      const k = shares[i];
      const pt = Math.max(1, Math.round(t.promptTokens * k));
      const ct = Math.max(1, Math.round(t.completionTokens * k));
      const rate = 0.58 + ((i * 13) % 22) / 100;
      return {
        key: nm.key, vendor: nm.vendor, model: nm.model,
        runs: Math.max(1, Math.round(t.runs * k)),
        promptTokens: pt, completionTokens: ct,
        cachedTokens: Math.round(pt * rate), cacheHitRate: rate,
        cost: r2(t.cost * k)
      };
    });
  }

  function mockStats(range) {
    const r = String(range || '7');
    if (r === 'today') {
      const t = { runs: sim.todayRuns, promptTokens: Math.round(sim.todayTokens * 0.9), completionTokens: sim.todayTokens - Math.round(sim.todayTokens * 0.9), cachedTokens: Math.round(sim.todayTokens * 0.9 * 0.68), cost: sim.todayCost };
      t.cacheHitRate = t.cachedTokens / t.promptTokens;
      return {
        mode: 'today', rangeLabel: '今日', totals: t,
        days: [], chats: rowsFromTotals(t, CHATS, [0.42, 0.27, 0.19, 0.12]),
        models: rowsFromTotals(t, MODELS, MODELS.map((m) => m.share)),
        searchCount: 2, toolCounts: { web_search: 2, web_fetch: 0 }
      };
    }
    const n = r === '7' ? 7 : r === '30' ? 30 : 45;
    const days = [];
    for (let i = n - 1; i >= 0; i--) days.push(dayRow(i));
    const t = days.reduce((acc, d) => {
      acc.runs += d.runs; acc.promptTokens += d.promptTokens; acc.completionTokens += d.completionTokens;
      acc.cachedTokens += d.cachedTokens; acc.cost = r2(acc.cost + d.cost);
      return acc;
    }, { runs: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, cost: 0 });
    t.cacheHitRate = t.cachedTokens / Math.max(1, t.promptTokens);
    const searchCount = Math.max(2, Math.round(n * 0.66));
    return {
      mode: 'days', rangeLabel: r === '7' ? '近 7 天' : r === '30' ? '近 30 天' : '全部',
      totals: t,
      days,
      chats: rowsFromTotals(t, CHATS, [0.42, 0.27, 0.19, 0.12]),
      models: rowsFromTotals(t, MODELS, MODELS.map((m) => m.share)),
      searchCount,
      toolCounts: { web_search: Math.round(searchCount * 0.68), web_fetch: searchCount - Math.round(searchCount * 0.68), memory_query: Math.round(t.runs * 0.4), memory_append: Math.round(t.runs * 0.12) }
    };
  }

  function mockBreakdown(u) {
    const q = new URL(u, 'http://preview.local').searchParams;
    const by = q.get('by') || 'model';
    const key = q.get('key') || '';
    const stats = mockStats(q.get('range') || '7');
    let rows = by === 'chat' ? stats.chats : by === 'day' ? stats.days : stats.models;
    // 带了 dim/key：按 key 的散列缩放出一份"这个项目在各维度下的分布"
    if (q.get('dim')) {
      let h = 0;
      for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      const f = 0.3 + (h % 60) / 100;
      rows = rows.map((x) => ({ ...x, runs: Math.max(1, Math.round(x.runs * f)), promptTokens: Math.round(x.promptTokens * f), completionTokens: Math.round(x.completionTokens * f), cachedTokens: Math.round(x.cachedTokens * f), cost: r2(x.cost * f) }));
    }
    return { rows, totals: {} };
  }

  // r90：预览侧的「QQ 从哪儿来」开关 —— 三种形态都能眼看：
  //   portable（默认，保持原有预览画面）/ local（新版萌新流程：直接用本机 QQ）
  //   / none（真没装 QQ）。
  //   写法：index.html#preview&qq=local  或  index.html?preview=1&qq=local
  //   mock POST /api/qq-portable/setup 会置成 portable（模拟复制完成）。
  const pvQqArg = String(
    new URLSearchParams(location.search).get('qq')
    || (/[?&]qq=(local|portable|none)/.exec(String(location.hash || '')) || [])[1]
    || ''
  ).toLowerCase();
  let pvQqMode = (pvQqArg === 'local' || pvQqArg === 'none') ? pvQqArg : 'portable';
  // 只有 portable 形态才演示"全链路在线"，否则会出现"QQ 没起但 OneBot 已连"的
  // 自相矛盾画面（真机上不可能）。⚠️ 必须写成函数：pvQqMode 会被 setup POST 改，
  // 用 const 快照会一直停在装之前的状态。
  const pvOnline = () => pvQqMode === 'portable';

  function mockStatus() {
    return {
      // r42：补 diagnosis 字段 —— routes.js 未连接时会给出四种人话原因之一，
      // 「连接」页的诊断行与 OneBot 卡都读它。预览默认已连接（diagnosis 为空串），
      // 探针用外层 fetch 包装改写 connected:false 来测未连接分支。
      onebot: (() => { const on = pvOnline(); return { connected: on, everConnected: on, diagnosis: on ? '' : '等待协议端上报连接', self: { nickname: '洛西Bot', user_id: 2846117254 } }; })(),
      // ⚠️ 这几项必须给全：设置页「连接 QQ」与连接页都会读 ready/running/pid/dir/source。
      //    少给一项就会渲染出自相矛盾的画面（比如"运行中"却又提示"请先运行 pnpm run setup"）。
      // r90：ready 语义已变成"有能启动的 QQ"，所以 local 形态也是 ready:true ——
      //   靠 source 字段区分文案，靠 portableInstalled 判断独立副本装没装。
      qqPortable: (() => {
        const LOCAL = 'C:\\Program Files\\Tencent\\QQNT';
        const idleSetup = { running: false, step: '', done: 0, total: 0, error: null, ok: false };
        if (pvQqMode === 'local') {
          return {
            ready: true, running: false, pid: null,
            dir: LOCAL,
            setup: idleSetup,
            localQqDir: LOCAL, source: 'local', portableInstalled: false
          };
        }
        if (pvQqMode === 'none') {
          return {
            ready: false, running: false, pid: null,
            dir: '<安装目录>\\runtime\\qq-portable',
            setup: idleSetup,
            localQqDir: null, source: 'none', portableInstalled: false
          };
        }
        return {
          ready: true, running: true, pid: 18244,
          dir: '<安装目录>\\runtime\\QQ',
          setup: { running: false, step: '完成', done: 1, total: 1, error: null, ok: true },
          localQqDir: null, source: 'portable', portableInstalled: true
        };
      })(),
      // 2026-10-23：原 snowluma 块（running/pid/dir/webuiUrl）随内置协议端删除，
      // 只剩连接页要读的端点与端口监听状态。
      protocol: {
        wsUrl: pvConfig.protocol?.wsUrl || 'ws://127.0.0.1:3901',
        httpUrl: pvConfig.protocol?.httpUrl || 'http://127.0.0.1:3900',
        portOpen: pvOnline()
      },
      orchestrator: { model: MODEL_ID },
      usage: { runs: sim.todayRuns, totalTokens: sim.todayTokens, webSearchCount: 2 },
      cost: { cost: sim.todayCost },
      cacheHitRate: 0.68,
      paused: false, pauseReason: '', dataDir: '（预览演示 · 数据为模拟）'
    };
  }

  // ── 日志模拟：连接页的「应用日志」面板 ──
  // 2026-10-23：原 SnowLuma 运行日志 / QQ 内核日志两块随内置协议端删除
  // （协议端的日志归它自己的控制台），这里只剩应用日志。
  let pvLogLevel = 'info';
  const clock = (agoMs) => new Date(Date.now() - agoMs).toLocaleTimeString('zh-CN', { hour12: false });

  function mockQqLogs() {
    const lines = [
      '[QQ] 便携版内核启动（pid 18244）',
      '[QQ] 用户目录：runtime/QQ/userdata',
      '[QQ] 登录态已复用，跳过扫码',
      '[QQ] 协议端适配层加载完成'
    ];
    return lines.map((text, i) => ({ at: Date.now() - (lines.length - i) * 6800, stream: 'stdout', text }));
  }

  function mockAppLogs() {
    const rows = [
      ['info', 'app', 'QQ Agent 启动完成，数据目录已就绪'],
      ['info', 'app', '[skill] ✅ 加载成功：天气查询（weather-query v1.0.0，api v1）'],
      ['info', 'app', '[skill] ✅ 加载成功：文本工具（text-tools v1.0.0，api v1）'],
      ['info', 'app', '[skill] ✅ 加载成功：分层会话记忆（conversation-memory v1.0.0，api v1）'],
      ['info', 'app', '[skill] skills/：9 成功，0 失败'],
      ['info', 'app', '[skill] plugins/：11 成功，0 失败'],
      ['info', 'app', '[skill] 工具集已刷新：41 个工具'],
      ['info', 'app', '[onebot] 已连接协议端 ws://127.0.0.1:3901'],
      ['info', 'app', '控制台已就绪：http://127.0.0.1:3210'],
      ['info', 'llm', '模型 deepseek-v3.2 · 3 次调用 · 缓存命中 75%'],
      ['warn', 'llm', '请求耗时 8.4s，接近超时阈值（已自动重试 1 次）'],
      ['info', 'session', '会话 pv-done-1 已结束：已发言 2 条'],
      ['info', 'session', '会话 pv-done-2 已结束：已发言 1 条'],
      ['debug', 'memory', '记忆索引增量更新：+2 条（命中 3 条）']
    ];
    return rows.map(([level, module, text], i) => ({
      ts: Date.now() - (rows.length - i) * 5200, level, module, text
    }));
  }

  // ⚠️ 可变副本：预览下"已保存的配置"就存在这里。
  //    以前 GET 恒定返回上面那个字面量、POST 只把合并结果塞进响应就扔了 ——
  //    于是"改设置→保存→页面重新拉取"会**回滚成原值**（真实后端是持久化的）。
  //    预览模式本来就要演示"改设置并生效"，所以必须记住写回。
  let pvConfig = MOCK_CONFIG;

  // ══════════════════ fetch 拦截 ══════════════════
  const realFetch = window.fetch.bind(window);
  const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  /* 与后端 src/config.js#deepMerge **逐行同款**（含 __replace__ 整体替换约定）。
     ⚠️ r33 之前这里是"浅一层"的合并 —— 而「会话设置」页保存用的 patch 是
        `{ store: { groupSliderPos: { __replace__: {...} } } }`、`{ allow: { groups: {__replace__: [...]} } }`
        这种**嵌套**写法，浅合并会把 `{__replace__: …}` 原样存进 pvConfig；
        再读回来 `allow.groups` 就不是数组了（探针实测 `cfg.groups.indexOf is not a function`）。
        所以必须做成递归的。 */
  function deepMerge2(base, patch) {
    if (patch === null || patch === undefined) return JSON.parse(JSON.stringify(base ?? {}));
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return JSON.parse(JSON.stringify(patch));
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const key of Object.keys(patch)) {
      const value = patch[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
        out[key] = JSON.parse(JSON.stringify(value.__replace__));
        continue;
      }
      if (value && typeof value === 'object' && !Array.isArray(value) &&
          base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
        out[key] = deepMerge2(base[key], value);
      } else if (value !== undefined) {
        out[key] = JSON.parse(JSON.stringify(value));
      }
    }
    return out;
  }

  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || String(input);
      const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      const u = url.replace(/^https?:\/\/[^/]+/, '');

      if (method === 'GET') {
        if (u.startsWith('/api/status')) return Promise.resolve(jsonRes(mockStatus()));
        // 2026-10-23：/api/snowluma/logs 随 SnowLuma 页删除；连接页只读应用日志。
        // /api/onebot-token 供端点设置里的「显示」按钮读明文（真实后端同形）。
        if (u.startsWith('/api/onebot-token')) {
          const which = new URL(u, 'http://preview.local').searchParams.get('which');
          return Promise.resolve(jsonRes({ token: which === 'http' ? '' : 'pv-demo-token' }));
        }
        if (u.startsWith('/api/qq-portable/logs')) return Promise.resolve(jsonRes({ logs: mockQqLogs() }));
        // r90：「重新检测 QQ」会带 ?force=1 打这个接口 —— 必须在这里接住，
        //   落到最下面的 realFetch 就是 404（预览没有真后端），按钮会报"检测失败"。
        if (u.startsWith('/api/qq-portable/status')) return Promise.resolve(jsonRes(mockStatus().qqPortable));
        if (u.startsWith('/api/logs')) return Promise.resolve(jsonRes({ logs: mockAppLogs(), level: pvLogLevel }));
        if (u.startsWith('/api/sessions/')) {
          const id = decodeURIComponent(u.slice('/api/sessions/'.length).split('?')[0]);
          const s = pvSessions.find((x) => x.id === id);
          return Promise.resolve(s ? jsonRes(s) : jsonRes({ error: '会话不存在（预览模拟）' }, 404));
        }
        if (u.startsWith('/api/sessions')) return Promise.resolve(jsonRes({ sessions: pvSessions }));
        // ⚠️ 顺序要紧：`/api/chats/<key>/messages` 必须排在 `/api/chats` **前面**。
        //    否则存档页拿到的是 `{ chats: [...] }`，data.messages 为 undefined，
        //    「存档」视图永远是一张空表 —— 从会话选择左栏点进去看着就像"没反应"。
        if (/^\/api\/chats\/[^/?]+\/messages/.test(u)) {
          const seg = decodeURIComponent(u.slice('/api/chats/'.length).split('/')[0]);
          return Promise.resolve(jsonRes({ messages: mockChatMessages(seg.replace('_', ':')) }));
        }
        if (u.startsWith('/api/chats')) return Promise.resolve(jsonRes({ chats: CHATS }));
        if (u.startsWith('/api/onebot/groups')) return Promise.resolve(jsonRes({ groups: MOCK_ONEBOT_GROUPS }));
        if (u.startsWith('/api/onebot/friends')) return Promise.resolve(jsonRes({ friends: MOCK_ONEBOT_FRIENDS }));
        // 补两个后端真实存在、预览此前漏 mock 的 GET（routes.js 的会话与设置接口）——
        // 漏了会落到 realFetch → 预览下 502：10-feedback.js 的更新检查、
        // 02-sse-sessions.js / 05-memory-settings.js 的视觉扫描结果。
        if (u.startsWith('/api/update-check')) return Promise.resolve(jsonRes({ ok: true, current: PV_VERSION, latest: PV_VERSION, hasUpdate: false, url: 'https://kondius.cn/qq-agent', notes: '' }));
        if (u.startsWith('/api/version')) return Promise.resolve(jsonRes({ version: PV_VERSION }));
        if (u.startsWith('/api/vision/results')) return Promise.resolve(jsonRes({ results: {}, scanning: false }));
        if (u.startsWith('/api/usage/stats')) return Promise.resolve(jsonRes(mockStats(new URL(u, 'http://preview.local').searchParams.get('range') || '7')));
        if (u.startsWith('/api/usage/breakdown')) return Promise.resolve(jsonRes(mockBreakdown(u)));
        if (u.startsWith('/api/config')) return Promise.resolve(jsonRes(pvConfig));
        if (u.startsWith('/api/providers/key')) return Promise.resolve(jsonRes({ apiKey: '' }));
        if (u.startsWith('/api/providers')) return Promise.resolve(jsonRes({ providers: MOCK_PROVIDERS }));
        if (u.startsWith('/api/persona-templates')) return Promise.resolve(jsonRes({ templates: mockPersonaTemplates() }));
        if (u.startsWith('/api/model-prices')) return Promise.resolve(jsonRes({ prices: [], current: null }));
        if (u.startsWith('/api/skills')) return Promise.resolve(jsonRes({ skills: MOCK_SKILLS, summary: { total: MOCK_SKILLS.length, active: 6 }, uninstalled: [] }));
        // 市场列表（r87）：kind 取自 query，与后端字段白名单同形
        if (u.startsWith('/api/market/list')) {
          const kind = new URL(u, 'http://preview.local').searchParams.get('kind') === 'plugin' ? 'plugin' : 'skill';
          return Promise.resolve(jsonRes({ ok: true, kind, categories: MOCK_MARKET_CATS, items: mockMarketItems(kind) }));
        }
        if (u.startsWith('/api/tools')) return Promise.resolve(jsonRes({ tools: MOCK_TOOLS }));
        if (u.startsWith('/api/memory-files/')) {
          const key = decodeURIComponent(u.slice('/api/memory-files/'.length).split('?')[0]);
          return Promise.resolve(jsonRes(MOCK_MEMORY[key] || { members: [] }));
        }
        if (u.startsWith('/api/memory-files')) return Promise.resolve(jsonRes({ files: MOCK_MEMORY_FILES }));
        // 其余 GET 透传：本机有真实后端时，其余页面照常工作
        return realFetch(input, init);
      }

      // 写操作一律不落真实后端
      if (method === 'POST' && u.startsWith('/api/config')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        pvConfig = deepMerge2(pvConfig, body);
        return Promise.resolve(jsonRes({ config: pvConfig }));
      }
      // 连接页「保存并重连」（2026-10-23）：写进 pvConfig.protocol，回执与后端同形。
      if (method === 'POST' && u.startsWith('/api/protocol/apply')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        if (!body.wsUrl || !body.httpUrl) return Promise.resolve(jsonRes({ ok: false, error: '两个地址都要填' }, 400));
        pvConfig = deepMerge2(pvConfig, {
          protocol: {
            wsUrl: body.wsUrl,
            httpUrl: body.httpUrl,
            ...(body.accessToken && body.accessToken !== '******' ? { accessToken: body.accessToken, hasAccessToken: true } : {}),
            ...(body.httpAccessToken && body.httpAccessToken !== '******' ? { httpAccessToken: body.httpAccessToken, hasHttpAccessToken: true } : {})
          }
        });
        return Promise.resolve(jsonRes({ ok: true, applied: true, protocol: { wsUrl: body.wsUrl, httpUrl: body.httpUrl } }));
      }
      // 自定义搜索服务：预览里也让它"记得住"——添加后写进 pvConfig.webSearch.providers
      // 并自动选中，页面重渲染时下拉框能看到新选项（与真实后端 {provider:{id,…}} 同形）
      if (method === 'POST' && u.startsWith('/api/search-providers')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        if (!body.baseUrl) return Promise.resolve(jsonRes({ error: '接口地址不能为空' }, 400));
        const entry = {
          id: 'custom_' + Date.now(),
          name: String(body.name || '').trim() || '自定义搜索服务',
          type: String(body.type || 'openai'),
          baseUrl: String(body.baseUrl).trim(),
          hasApiKey: !!String(body.apiKey || '').trim()
        };
        if (!pvConfig.webSearch) pvConfig.webSearch = {};
        pvConfig.webSearch.providers = [...(pvConfig.webSearch.providers || []), entry];
        pvConfig.webSearch.provider = 'custom:' + entry.id;
        return Promise.resolve(jsonRes({ provider: entry }));
      }
      // 导入后的重扫（rescanSkills）：预览里直接回内存列表，不碰磁盘
      if (method === 'POST' && u.startsWith('/api/skills/reload')) {
        return Promise.resolve(jsonRes({
          ok: true,
          loaded: MOCK_SKILLS.map((s) => s.id),
          failed: [],
          skills: MOCK_SKILLS,
          summary: { total: MOCK_SKILLS.length, active: MOCK_SKILLS.filter((s) => s.active).length }
        }));
      }
      // 本地导入（R41：拖 zip / 文件夹进技能页或插件页）：预览里就地新增一条，
      // 让"拖进去 → 列表多一张卡"这条链路在演示环境可走通（不碰真实磁盘）。
      // ⚠️ 必须排在 /api/skills 其它前缀分支之前更具体的匹配。
      if (method === 'POST' && u.startsWith('/api/skills/import')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        const kind = body.kind === 'plugin' ? 'plugin' : 'skill';
        const rawName = String((body.paths && body.paths[0]) || body.zipName || '').split(/[\\/]/).filter(Boolean).pop() || 'imported';
        const id = 'imported-' + Date.now().toString(36);
        const entry = {
          id,
          kind,
          name: rawName.replace(/\.zip$/i, '').slice(0, 24) || '本地导入',
          version: '1.0.0',
          description: '本地导入的条目（预览演示，未真正写盘）。',
          dir: `${kind === 'plugin' ? 'plugins' : 'skills'}/${id}`,
          loaded: true,
          enabled: true,
          active: true,
          toolIds: kind === 'skill' ? ['imported_tool'] : [],
          capabilities: kind === 'plugin' ? ['imported.capability'] : []
        };
        MOCK_SKILLS.push(entry);
        return Promise.resolve(jsonRes({
          ok: true,
          installed: [{ kind, id, dir: entry.dir, files: (body.paths || []).length ? 3 : 2 }],
          errors: [],
          skills: MOCK_SKILLS,
          summary: { total: MOCK_SKILLS.length, active: MOCK_SKILLS.filter((s) => s.active).length },
          reloaded: true
        }));
      }
      // 单条目开关（启用 / 禁用）：预览里就地翻内存里的 enabled 并回写，
      // 让设置页「扩展」分区 / 技能·插件页的开关在演示环境可端到端验证（r91）。
      // 匹配 /api/skills/<id>（恰好一级路径，不含 reload / import 等更具体前缀）。
      if (method === 'POST' && /^\/api\/skills\/[^/]+$/.test(u)) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        const id = u.slice('/api/skills/'.length).split('?')[0];
        const entry = MOCK_SKILLS.find((s) => s.id === id);
        if (!entry) return Promise.resolve(jsonRes({ error: 'not found' }, 404));
        if (typeof body.enabled === 'boolean') {
          entry.enabled = body.enabled;
          entry.active = entry.loaded && entry.enabled;
        }
        return Promise.resolve(jsonRes({ ok: true, skill: entry, config: pvConfig }));
      }
      // 拉取模型 / 勾选并入（R37）：预览里返回一批假模型、并入第一个 mock 提供商，
      // 让"⟳ 拉取模型 → 勾选 → 加入列表 → 模型目录里能选到"整条链路在演示环境可走通
      if (method === 'POST' && u.startsWith('/api/providers/fetch-models')) {
        return Promise.resolve(jsonRes({ models: ['deepseek-v3.2', 'deepseek-r2', 'glm-5.3-flash', 'kimi-k3', 'qwen4-max', 'doubao-seed-2'] }));
      }
      if (method === 'POST' && u.startsWith('/api/providers/models')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        const p = MOCK_PROVIDERS.find((x) => x.id === body.providerId) || MOCK_PROVIDERS[0];
        for (const m of (body.models || [])) {
          if (!p.models.includes(m.id)) p.models.push(m.id);
          if (!p.modelNames[m.id]) p.modelNames[m.id] = m.name || m.id;
        }
        return Promise.resolve(jsonRes({ ok: true, models: p.models }));
      }
      // API 协议保存（2026-10-19）：预览里就地改 MOCK_PROVIDERS
      if (method === 'POST' && u.startsWith('/api/providers/protocol')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        const p = MOCK_PROVIDERS.find((x) => x.id === body.providerId) || MOCK_PROVIDERS[0];
        p.apiProtocol = String(body.apiProtocol || 'openai');
        return Promise.resolve(jsonRes({ ok: true, apiProtocol: p.apiProtocol }));
      }
      // 添加提供商（R39：模型管理子模态「添加提供商」）—— 预览里就地并入 MOCK_PROVIDERS，
      // 让「填 URL+Key → ⟳拉取模型 → 勾选 → 添加 → 左列可见、模型可选」整条链路可演示。
      // ⚠️ 必须排在 fetch-models / models 两个前缀分支之后（它们更具体）。
      if (method === 'POST' && u.startsWith('/api/providers')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        const prov = {
          id: 'pv-' + Date.now().toString(36),
          displayName: '自定义提供商',
          baseURL: String(body.baseUrl || ''),
          apiKey: '',
          apiKeyFrom: 'config',
          hasKey: !!String(body.apiKey || '').trim(),
          apiProtocol: String(body.apiProtocol || 'openai'),
          models: (body.models || []).map((m) => m.id),
          modelNames: Object.fromEntries((body.models || []).map((m) => [m.id, m.name || m.id]))
        };
        MOCK_PROVIDERS.push(prov);
        return Promise.resolve(jsonRes({ provider: prov }));
      }
      // 落盘级别：预览里让它"记得住"，否则切完一重渲染就弹回 info
      if (method === 'POST' && u.startsWith('/api/logs/level')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        if (body && body.level) pvLogLevel = String(body.level);
        return Promise.resolve(jsonRes({ ok: true, level: pvLogLevel }));
      }
      // 人设模板的增删：预览里也让它"记得住"，否则添加完再看列表还是空的
      if (method === 'POST' && u.startsWith('/api/persona-templates')) {
        let body = {};
        try { body = JSON.parse((init && init.body) || '{}'); } catch { /* 脏数据当空处理 */ }
        const name = String(body.name || '').trim();
        const text = String(body.text || '').trim();
        if (!name || !text) return Promise.resolve(jsonRes({ ok: false, error: '人设名称和角色设定都不能为空' }, 400));
        const entry = { name, text };
        if (String(body.customRules || '').trim()) entry.customRules = String(body.customRules).trim();
        pvCustomPersonas = [...pvCustomPersonas, entry];
        return Promise.resolve(jsonRes({ ok: true }));
      }
      if (method === 'DELETE' && u.startsWith('/api/persona-templates/')) {
        const m = /custom_(\d+)/.exec(u);
        if (m) {
          const idx = Number(m[1]);
          pvCustomPersonas = pvCustomPersonas.filter((_, i) => i !== idx);
        }
        return Promise.resolve(jsonRes({ ok: true }));
      }
      // r48：唤起 QQ 窗口的演示反馈（真机返回 {ok, shown, pid}，预览照形状给）
      if (method === 'POST' && u.startsWith('/api/qq-portable/show')) {
        return Promise.resolve(jsonRes({ ok: true, shown: 1, pid: 18244 }));
      }
      // r52/r90：装独立副本的预览演示 —— 即刻「装好」（真机是分钟级复制 +
      // status.qqPortable.setup 进度），形态翻到 portable，让预览能看到装完后的页面
      if (method === 'POST' && u.startsWith('/api/qq-portable/setup')) {
        pvQqMode = 'portable';
        return Promise.resolve(jsonRes({ ok: true, installed: true, dir: 'C:\\…\\runtime\\qq-portable' }));
      }
      if (method === 'DELETE') {
        const m = /\/api\/sessions\/([^/?]+)/.exec(u);
        if (m) {
          const id = decodeURIComponent(m[1]);
          const i = pvSessions.findIndex((x) => x.id === id);
          if (i >= 0) pvSessions.splice(i, 1);
        }
      }
      return Promise.resolve(jsonRes({ ok: true }));
    } catch {
      return realFetch(input, init);
    }
  };

  // ══════════════════ 启动 ══════════════════
  // 群名映射提前就位（会话/存档/用量页的标题都要用）
  try { api('/api/chats').then((d) => { state.chats = d.chats || []; }).catch(() => {}); } catch { /* 忽略 */ }

  // 右下角常驻徽标：明示当前是模拟数据（静态图层，无动画，不给软件渲染添帧负担）
  const chip = document.createElement('div');
  chip.className = 'preview-chip';
  // 小圆点靠 CSS 画（.preview-chip-dot），色彩走主题变量而不是硬编码
  chip.innerHTML = '<span class="preview-chip-dot"></span>预览演示 · 模拟数据';
  document.body.appendChild(chip);

  // 模拟器：5 秒一拍，让运行中的会话"干活"、等待中的到期、用量数字上涨
  setInterval(pvTick, 5000);
})();

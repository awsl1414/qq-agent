// 回复安全网：把"写在正文里、但没通过工具发出去"的成稿抢救成一条 send_message 调用。
//
// 这是给不遵守工具协议的模型（尤其是本地小模型）用的。它们有时把"要说的话"
// 直接写在正文里，而正文按设计不会发到 QQ，于是群友什么都收不到。
//
// 为什么抽成独立模块：这段是整条链路上最可能造成事故的一环，判错了就是把内心戏
// 发进群，比"这轮不说话"严重得多。必须能被测试用假的裁判直接驱动，
// 留在 orchestrator 的私有方法里就只能起整个会话才能试。
//
// 硬约束：
//   - 只搬原句：不生成、不改写、不润色、不"帮模型把话说完"
//   - 拿不准一律沉默：任何一级判定失败都往"不发"走
//   - 不自己发送：返回合成好的 tool_call，由核心走统一的发送链路
//     （限频/去重/分条/CQ 转义/存档/守卫都在那里，不另开旁路）

/**
 * 判断一段正文是否疑似「系统提示词 / 内部配置泄露」。
 *
 * 只匹配结构性强、正常聊天几乎不会出现的特征，不做泛化匹配：
 * 误伤一次就等于让机器人"该说话时闭嘴"，比漏判更影响日常使用。
 * 覆盖的是 prompt.js 里 securityRules/toolProtocol 的可识别首句，
 * 以及模型复述时最常带的结构性标记。
 */
const LEAK_PATTERNS = [
  /【安全规则/, /【工作方式/, /【过去状态/, /【本次唤醒/, /【此刻状态/, /【引导说明/,
  /你是[「"']?(?:一个|一位)?QQ\s*群/i, /你没有本地工具/,
  /^#\s*(?:角色|人设|设定)\s*[:：]/m,
  /^\s*(?:system|assistant)\s*[:：]\s/im,          // 模型把 system/assistant 角色标签写进正文
  /(?:apiKey|api_key|accessToken|Authorization)\s*[:=]/i,
  /sk-[A-Za-z0-9]{16,}/                            // 真的把 Key 原样写出来了
];

function looksLikeSystemPromptLeak(text) {
  const s = String(text || '');
  if (!s) return false;
  return LEAK_PATTERNS.some((re) => re.test(s));
}

/**
 * 内置的「正文疑似成稿」判定，插件没提供 reply.loose-send 时兜底。
 *
 * 为什么必须有：reply.loose-send / reply.salvage / reply.grounded-select 这几个能力
 * 在插件体系里没有任何注册者，cap() 恒为 null，整张救援网空转、永远返回"不发"。
 * 实测会话里模型把要说的话写在正文、没调 send_message，直接 noreply 收尾，
 * 群友什么都收不到（用户反馈的"思考后未回复"）。
 *
 * 判定极保守（宁可沉默，也不能把内心戏发进群）：
 *   - 1~120 字、最多 2 行（长文本大概率是思考/计划）
 *   - 不含计划腔 / 元词（"可以回""或者""应该""需要""分析""用户"…）
 *   - 不含"不接/不回/潜水/安静/无关/没叫我"这类内心决定词（否则会把"没人@我 不接"发进群）
 *   - 不含括号补充、Markdown 列表、【】段标记、纯符号
 * 任何一条命中就不救。
 *
 * @returns {{messages: string[]}|null}
 */
function builtinLooseSend(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.length > 120) return null;
  if (t.split(/\r?\n/).filter((x) => x.trim()).length > 2) return null;
  if (/【|】|```|^\s*[-*]\s|^\s*\d+[.、]/.test(t)) return null;
  if (/可以回|可以这样|或者|备选|→|->|我打算|我准备|应该|需要|判断|分析|用户|这句|这段话/.test(t)) return null;
  if (/不接|不回|潜水|安静|跳过|略过|无关|没叫我|没人叫|不插嘴|不说话|不用回/.test(t)) return null;
  if (/^我(在|要|需|应该|想先|先)/.test(t)) return null;
  if (/[（(][^）)]*[）)]/.test(t)) return null;
  if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(t)) return null;
  return { messages: [t] };
}

/**
 * 把候选正文抢救成一条 send_message 的 tool_call。
 *
 * 三级递进，一级比一级宽松：① 正则否决（reply.is-planning-text）整段放弃；
 * ② reply.loose-send 正则级抽取，不花模型调用；③ reply.salvage-lines / reply.salvage
 * 由模型当裁判。最后过一遍 reply.grounded-select，只保留确实出自已记录草稿且没发过的原句。
 *
 * @param {string} text     模型写在本轮正文里的内容
 * @param {string} trigger  本轮收到的消息（裁判判断"这是不是对它的回复"要用）
 * @param {Array}  sent     本次运行已发出的记录（[{type, text}]），用于避免重复发
 * @param {object} api      裁判用的模型参数（{baseUrl, apiKey, model, provider}）
 * @param {Function} cap    取能力提供者的函数：(name) => fn | null
 * @param {Function} log
 * @returns {Promise<Array>} tool_call 数组；[] = 什么都别发
 */
export async function rescueUnsentReply({
  text, trigger = '', sent = [], api = null, cap = () => null, log = () => {}
} = {}) {
  const body = String(text || '').trim();
  if (!body) return [];
  const asMessages = (v) => (Array.isArray(v)
    ? v.filter((m) => typeof m === 'string' && String(m).trim())
    : []);

  // 泄露兜底：这一段会把正文里的句子真的发进 QQ 群，所以它是"系统提示词泄露"的最后一道闸。
  // 攻击链是：群友用一条多行消息伪造【…】系统段 → 压制系统提示里的软约束
  // → 模型把系统提示原文写进正文 → 本函数把它抢救成一条 send_message → 原文出现在群里。
  // 命中即整段放弃：宁可这轮不说话，也不能把内部配置发出去。
  if (looksLikeSystemPromptLeak(body)) {
    log('rescue: 正文疑似系统提示词/内部配置泄露，已放弃抢救');
    return [];
  }

  // ① 计划腔/候选稿否决。
  // 模型在正文里比较几个备选说法时（"回一句…或者…→太长"），任何一句单独看都像成品，
  // 整段都不能发，这正是 isReplyPlanningText 存在的理由。
  const planningFn = cap('reply.is-planning-text');
  if (planningFn) {
    try { if (planningFn({ text: body })?.planning) return []; } catch { /* 判不了就继续往下走 */ }
  }

  const alreadySent = (sent || []).filter((s) => s?.type === 'text').map((s) => String(s.text || ''));

  // ② 正则级抢救（便宜、不花模型调用）
  let messages = [];
  const looseFn = cap('reply.loose-send');
  if (looseFn) {
    try { messages = asMessages(looseFn({ text: body })?.messages); } catch { messages = []; }
  }
  // 插件没注册这个能力，用内置保守判定兜底（见 builtinLooseSend 注释）
  if (!messages.length) {
    messages = asMessages(builtinLooseSend(body)?.messages);
  }

  // ③ 裁判级抢救。默认关闭，且只在②没捞到时才走（省一次模型调用）。
  if (!messages.length) {
    const linesFn = cap('reply.salvage-lines');
    if (linesFn) {
      try {
        const r = await linesFn({ text: body, trigger, alreadySent, api });
        if (r?.say) messages = asMessages(r.messages);
      } catch (error) { log(`salvage-lines 失败：${error?.message ?? error}`); }
    }
    if (!messages.length) {
      const salvageFn = cap('reply.salvage');
      if (salvageFn) {
        try {
          const r = await salvageFn({ text: body, trigger, api });
          if (r?.say) messages = asMessages(r.messages);
        } catch (error) { log(`salvage 失败：${error?.message ?? error}`); }
      }
    }
  }
  if (!messages.length) return [];

  // ④ 草稿溯源：确认这些句子确实出自模型自己写过的草稿、且没发过。
  // 开启后这是最后一道闸，裁判选错句子时靠它拦住。
  const groundedFn = cap('reply.grounded-select');
  if (groundedFn) {
    try {
      const r = groundedFn({ proposed: messages, sent: sent.map((s) => ({ type: s?.type, text: s?.text })) });
      if (r?.enabled) messages = asMessages(r.picked);
    } catch { return []; }   // 筛不了就不发（保守侧）
  }
  if (!messages.length) return [];

  // 合成 tool_call 交给核心统一执行：这样限频、去重、分条、存档、before-tool 守卫
  // 一个都不会被绕开。id 带一个随机后缀，避免同一轮里两次抢救撞 id。
  return [{
    id: `rescue_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name: 'send_message', arguments: JSON.stringify({ messages }) }
  }];
}

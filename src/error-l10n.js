// error-l10n.js — 把「模型 API 报错」翻译成人话
// ---------------------------------------------------------------------------
// 背景（2026-10-10 r88）：
//   会话失败时，UI 把 `session.error` 原样铺在详情面板里。那条字符串长这样：
//
//     模型 API HTTP 400：{"error":{"message":"The supported API model names are
//     deepseek-flash, deepseek-v4-pro, but you passed DS v41f. (request_id:
//     2f8cb36b-cd39-4504-9b95-9d33e3698f62)","type":"invalid_request_error",
//     "param":null,"code":"invalid_request_error"}}
//
//   对能读英文 JSON 的人是"信息完整"，对绝大多数萌新是"一堵墙"：
//   他们看到的是红字和一堆括号，读不出「到底哪儿错了、我该点哪里」。
//   实测群里的反馈就是"看不懂这玩意"。
//
// 设计：
//   **不改后端抛错的内容，只加"解释层"。** 抛错处照旧保留完整技术细节
//   （排查问题的人要它），但同时把解释结果挂在 error 对象上：
//
//     error.human    = { title, what, fix, target }   // 给最终用户看
//     error.rawDetail = '原始技术细节'                 // 折叠区里给排查者看
//
//   UI 优先渲染 error.human；拿不到 human（老数据/未知错误）就退回原样显示。
//   这样"说人话"是**纯增量**的，任何识别不了的情况都不会比现在更差。
//
//   为什么识别放在后端而不是 UI：报错文本在后端生成，HTTP 状态码、响应体、
//   模型名这些"判据"在后端都是现成的结构化变量；搬到 UI 就得从拼接后的字符串
//   里再正则抠一遍，既脆又容易错。UI 只负责渲染，不负责猜。
//
// 维护约定：新增一类错误 → 在 CASES 里加一条 { test, build }。test 只做
//   "能不能识别"的判断，build 负责产出四段文案。文案要求：
//     title  ≤ 12 字，说清是什么坏了
//     what   1 句话，说清"为什么"，不出现 HTTP / JSON / 状态码
//     fix    1 句话，说清"怎么改"，最好能对应到一个能点的地方
//     target 有对应设置页就给 key（UI 会渲染成按钮），没有就 null

/**
 * 从响应体里抠出服务端给的错误 message。
 * 各家格式不一：OpenAI 系是 {error:{message}}，有些网关直接给 {message} 或 {error:'字符串'}，
 * 更有甚者整段回显。逐个试，都拿不到就返回 ''（交给上层用原始文本兜底）。
 * @param {string} text 原始响应体
 * @returns {string}
 */
export function extractServerMessage(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  // ① 先当 JSON 解，按常见形状逐层摸
  try {
    const j = JSON.parse(raw);
    const cand = [
      j?.error?.message,
      j?.error?.error?.message,
      typeof j?.error === 'string' ? j.error : null,
      j?.message,
      j?.msg,
      j?.error_msg,
      j?.detail,
      Array.isArray(j?.errors) ? j.errors?.[0]?.message : null
    ];
    for (const c of cand) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
  } catch { /* 不是 JSON，往下走 */ }
  // ② 不是 JSON（HTML 错误页 / 纯文本）：扒掉标签，压成一行
  const stripped = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return stripped.slice(0, 300);
}

/**
 * 从服务端 message 里找出"它期望的模型名"列表。
 * 例：「The supported API model names are deepseek-flash, deepseek-v4-pro,
 *      but you passed DS v41f.」→ ['deepseek-flash', 'deepseek-v4-pro']
 * @param {string} msg
 * @returns {{expected: string[], passed: string}|null}
 */
export function parseModelNameMismatch(msg) {
  const m = String(msg || '');
  // 期望列表：出现在 "supported/available/valid ... are|is" 之后
  const exp = /(?:supported|available|valid|allowed)[^.]*?\b(?:are|is|:)\s*([^.]*)/i.exec(m);
  // 实际传入：出现在 "you passed / got / provided" 之后。
  // R86 修：原正则只抓到**第一个词** —— "you passed DS v41f." 会抓成「DS」，
  //   于是 what 显示"你填的「DS」这个模型服务端不认"，用户对不上自己填的是啥。
  //   现在取到句末/逗号/左括号之前，允许中间有空格（模型名本身不带空格）。
  const got = /\b(?:you\s+)?(?:passed|sent|provided|got)\b\s*[`"']?\s*([^"'`().,;\n]{2,}?)\s*[`"']?\s*(?:\.|,|;|\(|$)/i.exec(m);
  if (!exp) return null;
  const expected = String(exp[1] || '')
    .split(/[,、;]|\band\b/i)
    .map((x) => String(x).trim())
    // R86 修：服务端的期望列表后面常直接接一句解释 ——
    //   "…are deepseek-flash, deepseek-v4-pro, but you passed DS v41f."
    //   按逗号切开后，最后一项就是那半句话。模型名本身**不含空格**，
    //   所以"含空格的项"一定是被粘连的句子片段，必须丢掉 ——
    //   否则会渲染成"改成服务商支持的其中一个：a / b / butyoupassedDSv41f"。
    .filter((x) => x && !/\s/.test(x))
    .map((x) => x.replace(/[`"'\s.]+/g, '').trim())
    .filter((x) => x && x.length < 80);
  if (!expected.length) return null;
  return { expected, passed: got ? String(got[1]).trim() : '' };
}

/**
 * 识别并生成"人话"解释。
 *
 * @param {object} info
 * @param {number} [info.status]   HTTP 状态码（0 / undefined = 没到 HTTP 层）
 * @param {string} [info.text]     原始响应体
 * @param {string} [info.model]    本次请求的模型名
 * @param {string} [info.message]  已抛错的 message（网络层错误没有 status 时用）
 * @returns {{title:string, what:string, fix:string, target:string|null}|null}
 *          识别不了返回 null
 */
export function explainApiError({ status = 0, text = '', model = '', message = '' } = {}) {
  const raw = String(text || '');
  const serverMsg = extractServerMessage(raw) || '';
  const msg = serverMsg || String(message || '');
  const has = (re) => re.test(raw) || re.test(serverMsg);

  for (const c of CASES) {
    let hit = null;
    try { hit = c.test({ status, raw, serverMsg, msg, model, message: String(message || '') }); } catch { hit = null; }
    if (!hit) continue;
    try {
      // R86 修：ctx 里补上 message。
      //   ⑧⑨⑩ 三条规则（网络失败 / 超时 / 非 JSON）本来就要靠它区分
      //   「连不上 vs DNS 解析失败」「超时是否已发出」「HTML 错误页 vs 空响应」，
      //   而 test() 拿得到 message、build() 之前拿不到 —— 于是这三条永远走兜底文案。
      const out = c.build(hit === true ? {} : hit, { status, model, serverMsg, msg, message: String(message || '') });
      if (out && out.title && out.what && out.fix) {
        return { ...out, target: out.target ?? null };
      }
    } catch { /* 单条规则炸了不该影响其它规则 */ }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   规则表（按特异性从高到低，第一条命中即返回）
   ══════════════════════════════════════════════════════════════════════════ */

const CASES = [
  /* ── ① 模型名不被支持 ────────────────────────────────────────────
     这是反馈最多的一类：用户在中转站/官网上看到「DS v4」就手填进模型框，
     但服务端只认它自己的 id（deepseek-flash、deepseek-v4-pro…）。
     报错是 400 + 一长串英文，用户完全不知道"要填哪个"。 */
  {
    test: ({ status, msg }) =>
      (status === 400 || status === 404) &&
      /model[\s_-]*(?:name|id)?s?[^.]{0,40}(?:not\s+found|not\s+exist|unsupported|invalid|unknown|does\s+not\s+exist)/i.test(msg)
      || (status === 400 && /supported\s+API\s+model\s+names?/i.test(msg))
      || /模型(?:\s*id)?\s*(?:不存在|无效|不支持|错误)/.test(msg),
    build: (_, { model, msg }) => {
      const mm = parseModelNameMismatch(msg);
      const passed = mm?.passed || model || '';
      const expected = mm?.expected || [];
      return {
        title: '模型名填错了',
        what: passed
          ? `你填的「${passed}」这个模型服务端不认。`
          : '你填的模型名这个服务端不认。',
        fix: expected.length
          ? `改成服务商支持的其中一个：${expected.slice(0, 4).join(' / ')}${expected.length > 4 ? ' 等' : ''}。`
          : '点「去改模型名」，从列表里重新挑一个。',
        target: 'settings-api'
      };
    }
  },

  /* ── ② API Key 无效 ──────────────────────────────────────────── */
  {
    test: ({ status, msg }) =>
      status === 401 ||
      /invalid[_ ]api[_ ]key|incorrect[_ ]api[_ ]key|unauthorized|authentication[_ ]?error|invalid[_ ]token|api[_ ]key[_ ]?(?:is[_ ])?(?:invalid|expired)|密钥(?:无效|错误)|鉴权失败|未授权/i.test(msg),
    build: () => ({
      title: 'API Key 不对',
      what: '密钥无效或已过期，服务端拒绝了这次请求。',
      fix: '点「去填密钥」，把新的 Key 粘进去（注意别把末尾空格一起复制）。',
      target: 'settings-api'
    })
  },

  /* ── ③ 没权限 / 余额不足 ─────────────────────────────────────── */
  {
    test: ({ status, msg }) =>
      status === 403 ||
      /insufficient[_ ](?:quota|balance|credits?)|exceeded[_ ]your[_ ]current[_ ]quota|billing|余额不足|额度不足|欠费|充值|无权限|forbidden/i.test(msg),
    build: (_, { status }) => (status === 403
      ? {
          title: '这个 Key 没权限',
          what: '密钥有效，但没有调用该模型的权限。',
          fix: '换一个开通了该模型的 Key，或到服务商后台给这个 Key 加上权限。',
          target: 'settings-api'
        }
      : {
          title: '账户余额不足',
          what: '服务商那边没额度了，请求被拒。',
          fix: '去服务商后台充值；或点「去改模型」换一个还有额度的渠道。',
          target: 'settings-api'
        })
  },

  /* ── ④ 限流 / 触发频率限制 ───────────────────────────────────── */
  {
    test: ({ status, msg }) =>
      status === 429 || /rate[_ ]?limit|too many requests|quota[_ ]?exceeded|请求(?:过于)?频繁|限流/i.test(msg),
    build: () => ({
      title: '请求太频繁了',
      what: '短时间内请求太多，被服务商临时限流（一般是每分钟请求数/RPM 用完了）。',
      // 2026-10-18：原来的建议是"把界面刷新间隔调大"——那是控制台轮询的场景，
      // 对群聊机器人来说根因是发言频率与并发，配个备选模型（限额按渠道分开算）
      // 也是立刻能恢复的路。改成本场景真正可操作的三个动作。
      fix: '等一两分钟会自动恢复。经常这样就降低群的「参与度」，或在「模型配置」里加个备选模型（不同渠道的限额分开算）。',
      target: 'settings-api'
    })
  },

  /* ── ⑤ 上下文超长 ────────────────────────────────────────────── */
  {
    test: ({ status, msg }) =>
      status === 400 &&
      /context[_ ]length|maximum context|too many tokens|reduce the length|上下文超|超出.{0,6}上限|token.{0,10}(?:超|limit)/i.test(msg),
    build: () => ({
      title: '上下文太长了',
      what: '这次要发给模型的内容超出了它的长度上限。',
      // 2026-10-20 修：原文案写「设置 → 工具与技能」，但「全部响应」的历史条数
      // 不在那一页 —— 它在 聊天 →「⚡ 活跃设置」→「⚙ 档位设置」里，
      // 且 target 原来给的是 settings-tools，点按钮会跳到错的页。
      fix: '到 设置 → 聊天 →「⚡ 活跃设置」→「⚙ 档位设置」把「④ 其余情况」的条数调小，或关掉图片输入、少启用几个技能。',
      target: 'settings-allow'
    })
  },

  /* ── ⑥ 服务端 5xx ───────────────────────────────────────────── */
  {
    test: ({ status, msg }) =>
      (status >= 500 && status < 600) ||
      /internal[_ ]server[_ ]error|bad[_ ]gateway|service[_ ]unavailable|upstream.{0,12}(?:error|fail)|服务器(?:内部)?错误/i.test(msg),
    build: (_, { status }) => ({
      title: `服务商出故障了${status ? `（${status}）` : ''}`,
      what: '不是你的配置问题 —— 是模型服务商那边暂时不可用。',
      fix: '等几分钟再试。如果一直这样，看看服务商的公告，或换一个渠道。',
      target: null
    })
  },

  /* ── ⑦ 请求体被拒（参数不被支持） ─────────────────────────────── */
  {
    test: ({ status, msg }) =>
      (status === 400 || status === 422) &&
      /(?:unsupported|unknown|unexpected|invalid|unrecognized)[^.]{0,60}(?:param|argument|field|property|value)|\bparam\b[^.]{0,20}(?:invalid|missing)|参数(?:错误|无效|不支持)/i.test(msg),
    build: () => ({
      title: '模型不认这个参数',
      what: '请求里带了该模型不支持的参数（通常是某个技能加的）。',
      fix: '到「技能」页把最近启用的技能一个个关掉试试，找出是哪个引起的。',
      target: 'skills'
    })
  },

  /* ── ⑧ 网络层失败（没走到 HTTP） ─────────────────────────────── */
  {
    test: ({ message }) =>
      /模型请求失败|fetch failed|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|network|网络/i.test(message),
    build: (_, { message }) => {
      const dns = /ENOTFOUND|EAI_AGAIN/i.test(message);
      const refused = /ECONNREFUSED|EHOSTUNREACH/i.test(message);
      return {
        title: refused ? '连不上模型服务' : dns ? '找不到模型服务地址' : '网络不通',
        what: refused
          ? '目标地址拒绝连接，多半是「接口地址」填错了，或者那是个需要代理的站点。'
          : dns
            ? '域名解析失败了，可能是「接口地址」写错，或者本机 DNS / 代理有问题。'
            : '请求没能发出去或中途断了（网络波动、代理、防火墙都可能）。',
        fix: '点「去改接口地址」核对一下 Base URL；开了代理/VPN 的话先关掉试试。',
        target: 'settings-api'
      };
    }
  },

  /* ── ⑨ 超时 ─────────────────────────────────────────────────── */
  {
    test: ({ message }) => /模型请求超时|timeout|timed out|超时/i.test(message),
    build: (_, { message }) => {
      const afterSend = /请求已发出/.test(message);
      return {
        title: '模型响应超时',
        what: afterSend
          ? '请求发出去了，但模型很久没回。为避免重复扣费，系统没有自动重发。'
          : '等了太久没等到模型的响应。',
        fix: '稍后重试；模型太忙时换一个负载低的。',
        target: null
      };
    }
  },

  /* ── ⑩ 返回的不是 JSON ───────────────────────────────────────── */
  {
    test: ({ message }) => /无法解析的 JSON|Unexpected end|unexpected token/i.test(message),
    build: (_, { message }) => {
      const html = /HTML/.test(message);
      const empty = /响应体为空/.test(message);
      return {
        title: '服务端回了乱码',
        what: empty
          ? '服务端返回了空内容，通常是网关提前断流了。'
          : html
            ? '服务端返回的是一个网页，不是接口数据 —— 多半是网关的错误页或登录页。'
            : '服务端返回的内容不是合法数据，可能被截断了。',
        fix: '重试一次；反复这样就把「接口地址」核对一下（有些中转站要多写/少写一段路径）。',
        target: 'settings-api'
      };
    }
  }
];

/* ══════════════════════════════════════════════════════════════════════════
   挂载点：给 Error 对象贴上解释
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * 给一个 Error 对象补上 human / rawDetail，供 UI 渲染。
 * 识别不了时**什么都不做**（human 保持 undefined），UI 自然退回原样显示。
 *
 * @param {Error} error
 * @param {{status?:number, text?:string, model?:string}} ctx
 * @returns {Error} 同一个对象（方便链式抛出）
 */
export function annotateApiError(error, ctx = {}) {
  if (!error || typeof error !== 'object') return error;
  if (error.human) return error;      // 已经贴过就别重复
  try {
    const human = explainApiError({
      status: ctx.status,
      text: ctx.text,
      model: ctx.model,
      message: String(error.message ?? error)
    });
    if (human) {
      error.human = human;
      // 原始技术细节：折叠区里给排查者看。截断避免把整页刷爆。
      error.rawDetail = String(error.message ?? error).slice(0, 4000);
    }
  } catch { /* 标注失败绝不能影响原错误上抛 */ }
  return error;
}

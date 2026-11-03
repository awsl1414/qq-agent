// 修复提案的 prompt 与解析。
//
// 分工与 triage.js 一致：**本模块只负责"拼 prompt + 解析回复"**，不调模型：
// 调模型是 routes.js 的职责（插件层保持零 LLM 依赖）。
// 这样"换模型渠道 / 加缓存 / billing tag"都只需动核心一处。
//
// 输出格式的所有权在定义 prompt 的这一方，改格式必须连解析一起改，
// 否则会静默变成"提案解析出 0 条"（triage 踩过：只取 r.content 永远 undefined）。

/** 协议条款（写进 prompt 的硬性要求，必须与 checks.js 的静态检查同口径）。 */
export const PROTOCOL_CLAUSES = [
  'P1 声明义务：必须给出 rootCause（根因）、expectedEffect（预期效果）、rollback（回滚方式），每个改动项必须有 intent。',
  'P2 最小改动：只改与目标问题直接相关的行。禁止全文件格式化、重命名无关符号、调整 import 顺序、顺手升级依赖或"优化"。',
  'P3 自我指涉禁区：绝对不许改 src/harness/fix/、src/harness/doctor/、src/harness/forge/gate.js、src/plugin-loader.js —— 那是闸门与审计本身。改它等于拆掉约束。',
  'P4 凭据禁区：不许读/写 account.json、.env、任何 token。需要新配置只能写空值占位并由用户填。',
  'P5 运行态数据禁区：不许改 data/ 下用户真实数据（会话存档、群友记忆）。那要走既有的迁移/导入通道。',
  'P6 危险模式：不许引入 child_process / execSync / spawnSync / process.exit / 动态 eval / 路径穿越。',
  'P7 可回滚义务：改动必须可回滚（不要做"不可逆"的改动，例如删数据、改外部服务状态）。',
  'P8 单一目标：一次只解决一个目标问题。过程中发现的新问题请写进 residualRisk，不要顺手一起改。',
  'P9 自验诚实义务：verifyPlan 只能从白名单里选验证器。如果这次改动**无法**被任何可用手段验证，必须在 unverifiable 里显式说明，不要假装验证过了。'
];

export const VERIFY_PLAN_DOC =
  '可选验证器（只能从这里选，不能自定义命令）：\n'
  + '  · syntax   语法检查（node --check）—— 建议总是包含\n'
  + '  · protocol 协议闸（P1-P9 + 五道闸门）—— 建议总是包含\n'
  + '  · scan     扫描真实源码中本次改动目标的现存问题；不比较沙箱改动版或历史基线\n'
  + '  · tests    用 node --test 跑白名单测试脚本，file 为相对项目根的 .mjs/.js 路径；'
  + '优先 tests/（如 tests/volatile-contract.test.mjs），仅该目录不存在时采用 .workbuddy/tools/；'
  + '两者都不存在则返回 skip（不可用），届时改用 load/scan。测试按真实源码路径运行，不能证明沙箱改动版已通过\n'
  + '  · load     在子进程里 import 沙箱入口并跑一次 setup()（仅插件/技能入口改动时有意义）';

/**
 * @param {object} o
 * @param {string} o.fixId
 * @param {string} o.question   用户的原始问题
 * @param {string} o.answer     诊断结论（模型之前给出的归因）
 * @param {object} o.target     { file, line, ruleId, title }
 * @param {Array}  o.files      [{ path, scope, level, excerpt }] 相关文件原文窗口
 * @param {string} o.extraNote  人的补充要求（闸①驳回后重提时带）
 */
export function buildProposePrompt({ fixId, question, answer, target, files = [], extraNote = '' }) {
  const sys = [
    '你是 QQ Agent 的**修复提案员**。你的产物是**一份提案**，不是改动本身 —— 你没有任何写文件的能力，',
    '提案通过人工闸①之后，才会由界面驱动你按提案去改。所以提案必须**具体到能被人一眼看懂要改什么**。',
    '',
    '── 修复协议（硬性要求，违反会被协议闸就地拒绝）──',
    ...PROTOCOL_CLAUSES.map((c) => '  ' + c),
    '',
    '── ' + VERIFY_PLAN_DOC,
    '',
    '── 输出格式（严格 JSON，不要 markdown 代码围栏，不要任何解释文字）──',
    JSON.stringify({
      rootCause: '一句话说明根因（40 字内）',
      expectedEffect: '改完之后会出现什么可观察的变化',
      rollback: '怎么撤回这次改动',
      residualRisk: ['这次没解决、下一位修改者该注意的点'],
      changes: [
        { scope: 'code', path: 'src/xxx.js', level: 'L1', intent: '为什么改这里', hunks: [{ from: 100, to: 112, replacement: '改后的代码（整段替换）' }] }
      ],
      verifyPlan: [{ verifier: 'syntax' }, { verifier: 'protocol' }, { verifier: 'scan' }],
      unverifiable: ['无法被验证器覆盖的部分（没有就空数组）']
    }, null, 1),
    '',
    '要点：',
    '1. hunks 用「整段替换」表达：给出 from/to 行号与被替换后的完整文本。不要写 diff 语法，模型生成的 diff 行号经常错位。',
    '2. 只读上面给你的文件片段来定位。片段里看不到的地方**不要臆测**，宁可少改。',
    '3. 若这个问题**不该由代码修复**（例如其实是配置问题、或用户操作问题），changes 给空数组，并在 expectedEffect 里说明应该怎么做。',
    '4. 引用要具体：path + 行号。不要写"某处""相关逻辑"。'
  ].join('\n');

  const fileBlocks = files.map((f) => {
    const head = `${f.scope === 'data' ? 'data:' : ''}${f.path}（${f.level || '?'}，共 ${f.lines ?? '?'} 行）`;
    return `── 文件：${head} ──\n${f.excerpt}`;
  }).join('\n\n');

  const user = [
    `工单：${fixId}`,
    '',
    '── 用户的问题 ──',
    question || '（无）',
    '',
    '── 诊断结论（你要修的就是它）──',
    answer || '（无）',
    '',
    '── 目标问题定位 ──',
    target?.file ? `${target.file}${target.line ? ':' + target.line : ''}  ${target.ruleId || ''} ${target.title || ''}` : '（未指明，请从诊断结论里自己定位）',
    extraNote ? `\n── 人的补充要求（必须遵守）──\n${extraNote}` : '',
    '',
    '── 相关源码片段 ──',
    fileBlocks || '（没有提供文件片段）'
  ].join('\n');

  return { sys, user };
}

/** 剥 markdown 围栏 + 截取首个 { 到末个 }。 */
export function stripFence(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return s;
}

const SCOPES = new Set(['code', 'data']);

/**
 * 解析提案。容错但不放水：缺关键字段就判失败（宁可让人看到"提案失败"，
 * 也不要让一份残缺提案流到闸①）。
 * @returns {{ ok:boolean, error?:string, proposal?:object }}
 */
export function parseProposal(text) {
  const s = stripFence(text);
  let obj;
  try { obj = JSON.parse(s); } catch (e) { return { ok: false, error: `不是合法 JSON：${e.message}` }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '顶层必须是对象' };

  const proposal = {
    rootCause: String(obj.rootCause || '').slice(0, 300),
    expectedEffect: String(obj.expectedEffect || '').slice(0, 500),
    rollback: String(obj.rollback || '').slice(0, 500),
    residualRisk: Array.isArray(obj.residualRisk) ? obj.residualRisk.map((x) => String(x).slice(0, 300)).slice(0, 12) : [],
    unverifiable: Array.isArray(obj.unverifiable) ? obj.unverifiable.map((x) => String(x).slice(0, 300)).slice(0, 12) : [],
    changes: [],
    verifyPlan: []
  };

  const changes = Array.isArray(obj.changes) ? obj.changes : [];
  for (const c of changes) {
    if (!c || typeof c !== 'object') continue;
    const rel = String(c.path || '').trim().replace(/\\/g, '/');
    if (!rel) continue;
    const scope = SCOPES.has(String(c.scope)) ? String(c.scope) : 'code';
    const hunks = (Array.isArray(c.hunks) ? c.hunks : [])
      .filter((h) => h && Number.isFinite(Number(h.from)))
      .map((h) => ({
        from: Math.max(1, Number(h.from) || 1),
        to: Math.max(Number(h.from) || 1, Number(h.to) || Number(h.from) || 1),
        replacement: String(h.replacement ?? '')
      }));
    proposal.changes.push({ scope, path: rel, level: String(c.level || ''), intent: String(c.intent || '').slice(0, 300), hunks });
  }

  const plan = Array.isArray(obj.verifyPlan) ? obj.verifyPlan : [];
  for (const p of plan) {
    if (typeof p === 'string') proposal.verifyPlan.push({ verifier: p });
    else if (p && typeof p === 'object' && p.verifier) {
      const item = { verifier: String(p.verifier) };
      if (p.file) item.file = String(p.file);
      proposal.verifyPlan.push(item);
    }
  }

  return { ok: true, proposal };
}

/**
 * 把提案的 hunks 应用到原文，得到"改后文本"。
 * 不让模型直接给整份新文件：整份重写会把无关行一起动掉（违反 P2），
 * 而且长文件很容易被截断成半截。hunks 是"最小改动"在数据上的表达。
 */
export function applyHunks(original, hunks) {
  const lines = String(original ?? '').split('\n');
  const sorted = [...(hunks || [])].sort((a, b) => a.from - b.from);
  const out = [];
  let cursor = 0;   // 已消费到第几行（0-based）
  for (const h of sorted) {
    const from = Math.max(1, h.from) - 1;
    const to = Math.max(from + 1, h.to);   // 1-based、闭区间 → 转成 0-based 半开
    if (from < cursor) continue;           // 重叠的 hunk 跳过（模型偶尔会算重）
    for (let i = cursor; i < from && i < lines.length; i++) out.push(lines[i]);
    out.push(...String(h.replacement ?? '').split('\n'));
    cursor = Math.min(to, lines.length);
  }
  for (let i = cursor; i < lines.length; i++) out.push(lines[i]);
  return out.join('\n');
}

// 〔harness 页签〕，自检 / 对话审查 / 自动修复 / 自创扩展 / 升级 / 打包接收 / 开发工单
'use strict';
/*
 * 这一页是「谁在提供 doctor.report 能力」的纯前端：
 *   - GET  /api/doctor          只读体检单（5 分钟内复用上次结果）
 *   - POST /api/doctor/run      强制重扫
 *   - POST /api/doctor/scan-project  全项目静态扫描（本地规则，免费）
 *   - POST /api/doctor/triage   模型逐个审：把扫描候选交给模型判真伪（花 token）
 *   - POST /api/doctor/ask      把问题 + 体检单交给模型，做只读归因
 *
 * 插件关掉时后端返回 { ok:false, available:false }，
 * 这一页要展示"未启用 + 去哪开"，而不是空白或报错，否则用户会以为
 * 是页面坏了，而不是插件被关了。
 *
 * 多个模块并在一页，是因为它们共用同一份体检数据（report）与同一套模型配置，
 * 且"先跑自检 → 看到某条警告 → 想深入问"是最常见的动线。拆成多个顶层页签
 * 就要各自维护一份 report 与配置状态，还得处理跳转时把上下文带过去。
 */

// 页面状态放模块级：切换子模块不重建 DOM 时也能记住对话历史
const doctorState = {
  sub: 'checkup',     // 当前子模块：'checkup'（自检系统）| 'chat'（对话审查）| 'forge'（自创扩展）
  report: null,       // 最近一次体检单
  available: null,    // null=未探测 true/false=插件是否启用
  loading: false,     // 正在拉体检单
  running: false,     // 正在强制重扫
  asking: false,      // 正在等模型回答
  scanning: false,    // 正在跑全项目扫描
  project: null,      // 最近一次项目扫描结果
  projectRule: '',    // 项目扫描的规则过滤（空=全部）
  projectDir: '',     // 项目扫描的目录过滤
  triaging: false,    // 正在跑"模型逐个审"
  triage: null,       // 审阅结果 { verdicts:{file:[{index,verdict,reason}]}, entries:[{key,verdict,reason}], stats, model }
  triageProg: null,   // 审阅进度 { done, total }
  triageFilter: '',   // 审阅结果的过滤：''=全部 | 'true-problem' 等
  error: '',          // 整页级错误（后端不可达等）
  ackMsg: '',         // 忽略/恢复操作的局部反馈（失败时显示一行，不炸整页）
  turns: [],          // 对话历史 [{ role:'user'|'assistant', text, at, model? }]

  // ── 前缀缓存哨兵（自检页的量表 + 主动分析）──
  //
  // 拉数据（免费，本地读盘）与让模型解读（花 token）是两件事，按钮也分开：
  // 大多数人只想看数，不想为一次解读付钱。
  sentinel: null,        // 最近一次快照 { at, rounds, statics, prefix, headline }
  sentinelText: '',      // 后端给的纯文本版（喂给模型的那一份）
  sentinelLoading: false,
  sentinelAnalyzing: false,
  sentinelVerdict: '',   // 模型解读结果（原文）
  // 解析成 {problem, plan, benefit, cost, structured}，用户要判断的是
  // "值不值得改"，四块并排摆比一整段自由文本好读。解析失败时
  // structured=false，UI 退回原文，不丢信息。
  sentinelVerdictParsed: null,
  sentinelError: '',

  // ── 自动修复（self-fix 插件）──
  //
  // 状态机：proposed(待闸①) → applied(已入暂存区) → verifying → verified(待闸②)
  //          → committed(已落地) / discarded / failed
  // 「闸①」与「闸②」是两个独立的人工动作，中间夹着协议闸与沙箱自验。
  fix: {
    available: null,      // null=未探测 true/false=插件是否启用
    enabled: false,       // fixEnabled 总开关
    allowCoreFiles: false,
    limits: {},           // { maxReruns, verifyTimeoutSec, auditKeepDays, auditMaxRecords }
    verifiers: [],        // 白名单验证器（渲染"验证计划"的勾选项）
    counts: {},
    records: [],          // 工单列表（摘要）
    selected: '',         // 当前展开的 fixId
    detail: null,         // 当前工单详情 { ok, record, summary, preview, verify, backupExists }
    loading: false,
    busy: '',             // 正在执行的动作名（按钮转圈用）
    error: '',

    // 新建修复
    seed: null,           // { question, answer, target }，从对话审查带过来
    question: '',         // 输入框即存，防重绘丢字
    answer: '',
    targetFile: '',
    targetLine: '',
    note: '',             // 闸①驳回后的补充要求
    proposing: false,
    proposalToken: '',    // 闸①的一次性令牌（后端校验，界面只是搬运工）

    // 闸②
    discardReason: '',
    rerunHint: '',
    exporting: false,
    showAudit: false      // 是否展开"审计与导出"区
  },

  // ── 自创扩展（extension-forge）──
  forge: {
    available: null,  // null=未探测 true/false=插件是否启用
    requirement: '',  // 需求输入（放 state 里，切子模块回来还在）
    drafting: false,  // 正在起草
    trace: [],        // 起草/适配时的工具调用轨迹
    summary: '',      // 模型的收尾说明
    gate: null,       // 闸门结论
    plan: '',         // plan-then-write：模型动笔前自己定的起草计划（透明可核对）
    files: [],        // 生成的代码 [{path, content}]
    draftId: '',      // 当前草稿
    installing: false,
    installed: null,  // 安装结果
    // 同 id 冲突的现场（安装被拒时由后端带回 { id, version, dir, relDir }）。
    // 与 error 分开存：error 是"为什么不行"，conflict 决定要不要渲染
    // 「去升级 / 去卸载」这两条出路。
    conflict: null,
    allowConfirm: false, // 用户是否勾选"知悉需确认项，仍安装"
    drafts: [],       // 暂存区里的草稿列表
    error: '',

    // ── 第三方包导入 / 适配 ──
    mode: 'create',   // 'create'（自己造）| 'import'（改别人的）
    importing: false,
    imported: null,   // { zipName, files, skipped }
    adapting: false,
    adaptNote: '',    // 适配的补充说明（input 事件即存，防重绘丢字）
    reviseNote: '',   // 「继续修改」的补充说明，与 requirement 分开存，防止污染原始需求
    diff: null,       // 适配前后的差异
    gateBefore: null, // 修改/适配前的闸门结论（用来对照"修好了没"）
    revising: false,  // 正在"继续修改"已有草稿（区别于从零起草；只影响等待文案）
    // 这份草稿导入时因体积超限没解出来的文件 [{path,size,reason}]。
    // 从 /api/forge 的草稿列表带回来（解包响应是一次性的），打开老草稿时也能提示。
    oversizeLost: []
  },
  // ── 升级扩展（extension-forge 提供能力，独立 state 避免与 forge 互相踩）──
  upgrade: {
    list: [],         // 已装扩展 [{kind, dir, id, name, version, description, files}]
    listError: '',
    draft: null,      // 当前升级草稿 { draftId, kind, dir, id, name, version, source:'chat'|'zip', skipped? }
    starting: false,  // 正在起草升级（复制到暂存区）
    note: '',         // 升级要求（输入框即存）
    chatting: false,  // 模型升级中
    result: null,     // { summary, trace, gate, diff }
    importing: false, // zip 解包中
    installing: false,
    installConfirm: false,
    done: null,       // 最近一次升级结果 { kind, id, dir, versionBefore, versionAfter, backup }
    error: ''
  },

  // ── 打包 / 接收（整包：扩展 + 数据）──
  //
  // 数据落地由 migrate.js 的 applyImport 负责，这里负责收发一个 zip。
  // 接收侧不直接安装扩展：先登台（进锻造台暂存区 + 过闸），再由一次确认批量落地。
  bundle: {
    tab: 'export',        // 'export' | 'import'
    options: null,        // { modules, data, exportsDir }（只拉一次，点刷新才更新）
    loading: false,
    selModules: new Set(),
    selData: new Set(['messages', 'memory', 'usage']),
    note: '',
    exporting: false,
    result: null,         // 导出结果 { file, name, bytes, modules, dataFiles }
    // 接收侧
    path: '',
    inspecting: false,
    pkg: null,            // inspect 结果（含 bundleId / modules / data / scan）
    selPkgModules: new Set(),
    selChats: new Set(),
    memorySel: true,
    statsSel: {},
    strategy: 'merge',
    staging: false,
    drafts: null,         // [{ key, ok, draftId, gate }]
    installEnable: false, // 装完是否直接启用
    installing: false,
    installResult: null,
    importingData: false,
    dataResult: null,
    // 导入备份与回滚（原「数据移植」页的收尾能力，搬到这里：数据入口只剩这一个）
    backups: [],
    backupsLoading: false,
    rollingBack: false,
    error: ''
  },

  // ── 开发工单（dev-orders 插件）──
  orders: {
    snapshot: null,   // { whitelist, orders, sandbox, sandboxName, running }
    loading: false,
    error: '',
    busy: '',         // 正在执行的动作（'start:dev-1' 之类）
    note: '',         // 操作反馈（一句话）
    pollTimer: null,   // 当前那次轮询的定时器句柄
    polling: false,    // 「有没有一个轮询在跑」，**单实例守卫用这个布尔量，不要用 pollTimer**
    pollInFlight: false, // 上一次 tick 还没跑完（防叠加）
    renderError: '',     // 最近一次页面渲染异常（只记录不杀链，侧栏横幅提示；空=正常）
    watchdogTimer: null, // 看门狗定时器句柄（轮询链停摆自愈，见 startOrdersWatchdog）
    pendingScroll: null, // 重绘前的滚动位置快照（重绘后恢复，见 decideOrdersScroll）
    lastRenderedSelected: null, // 上一次渲染时选中的会话（用来判断"是不是刚切换了会话"）
    selected: '',     // 当前选中的工单 id
    draft: '',        // 对话框输入（输入即存，防重绘丢字）
    detail: null,     // { id, lines, nextFrom, hasMore }，对话视图的数据（nextFrom 是不透明字节游标）
    detailError: '',
    expanded: new Set() // 展开的工具卡（键=行号；append-only 所以行号稳定）
  }
};

const DOCTOR_SEV = {
  critical: { icon: '🔴', label: '严重', cls: 'is-critical' },
  warning: { icon: '🟠', label: '警告', cls: 'is-warning' },
  info: { icon: '🔵', label: '提示', cls: 'is-info' }
};

function doctorVerdictMeta(v) {
  if (v === 'critical') return { icon: '🔴', label: '发现问题', cls: 'is-critical', sub: '有严重项需要处理' };
  if (v === 'warning') return { icon: '🟠', label: '基本正常', cls: 'is-warning', sub: '有警告项建议看一下' };
  if (v === 'ok') return { icon: '🟢', label: '一切正常', cls: 'is-ok', sub: '未发现需要处理的问题' };
  return { icon: '⚪', label: '未知', cls: 'is-info', sub: '' };
}

function doctorFmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

/** 极简 Markdown → HTML：只处理换行、粗体、行内代码、无序列表。
 *  不引三方库：诊断回答是模型产出的纯文本，只要可读，不需要富格式，
 *  少一层依赖就少一处 CDN/离线失效点。所有文本都先 esc() 再替换，防注入。 */
function doctorMiniMd(text) {
  const lines = esc(text).split(/\r?\n/);
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*[-*•]\s+(.*)$/);
    if (li) {
      if (!inList) { out.push('<ul class="doctor-md-list">'); inList = true; }
      out.push(`<li>${doctorInline(li[1])}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (!line.trim()) { out.push('<div class="doctor-md-gap"></div>'); continue; }
    out.push(`<p>${doctorInline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function doctorInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+)`/g, '<code class="doctor-code">$1</code>');
}

// ── 体检单渲染 ────────────────────────────────────────────────────────────

/**
 * 体检单 issue 标题的人话映射。
 * 后端标题形如「扩展清单损坏：xxx」（固定前缀 + 动态名字），所以按前缀匹配；
 * 命中 → 显示「人话（原标题）」，未命中 → 原标题原样。
 * key 与 src/harness/doctor/index.js 里 issue() 的标题前缀一一对应。
 */
const DOCTOR_TITLE_MAP = {
  '扩展清单损坏': '有个插件坏了',
  '入口文件不存在': '插件少了关键文件',
  'plugins/ 里没有提供能力或钩子': '有个插件没写功能',
  'skills/ 里没有注册任何工具': '有个技能用不上',
  '声明能力但未提供实现': '插件说了有这功能却没写',
  '能力名撞车': '两个插件抢同一个功能',
  '清单声明了工具但入口未注册': '插件清单和实际对不上',
  '提示词片段 id 重复': '有两段说明重复了',
  '提示词片段内容重复': '有两段说明重复了',
  '硬依赖缺失': '插件缺了依赖，用不了',
  '扩展加载失败': '有个插件没加载上',
  '扩展重载失败': '插件只更新了一半（还在用旧版）',
  '扩展加载状态异常': '有个插件状态不对劲',
  '工具被排除': '有个工具被挡住了',
  '模型主动报告的失败': '模型自己报告出了问题',
  '会话报错': '有会话出错了',
  '疑似静默失败': '有话写了却没发出去',
  '轮次触顶': '有的问题聊太久没聊完',
  '未检测到缓存哨兵': '省钱缓存没开（不影响使用）',
  '缓存未命中率偏高': '缓存有点费钱',
  '系统提示漂移': '机器人设定最近老在变'
};

/** 标题命中术语表 → 返回人话前缀；未命中 → null（调用方原样显示原标题）。 */
function doctorPlainTitle(title) {
  const t = String(title || '');
  for (const k of Object.keys(DOCTOR_TITLE_MAP)) {
    if (t.startsWith(k)) return DOCTOR_TITLE_MAP[k];
  }
  return null;
}

function renderDoctorReport(report) {
  if (!report) {
    return `<div class="empty-hint">还没有体检数据。点右上角「重新扫描」跑一次。</div>`;
  }
  const v = doctorVerdictMeta(report.verdict);
  const c = report.counts || {};
  const ext = report.extension || {};
  const rt = report.runtime || {};

  const countsHtml = [
    { n: c.critical || 0, label: '严重', cls: 'is-critical' },
    { n: c.warning || 0, label: '警告', cls: 'is-warning' },
    { n: c.info || 0, label: '提示', cls: 'is-info' }
  ].map((x) => `
      <div class="doctor-stat ${x.cls}${x.n ? '' : ' is-zero'}">
        <span class="doctor-stat-n">${x.n}</span>
        <span class="doctor-stat-l">${x.label}</span>
      </div>`).join('');

  const issues = Array.isArray(report.issues) ? report.issues : [];
  // acked：用户自查后确认无妨、显式忽略的条目（后端 acked.json，跨重启生效）。
  // 它们不计入 counts/警告位，但要在界面上留痕，否则用户会以为"消失了"，
  // 也想不起来恢复。
  const acked = Array.isArray(report.acked) ? report.acked : [];
  let issuesHtml;
  if (!issues.length) {
    issuesHtml = `<div class="doctor-empty-ok">✅ 没有发现问题${acked.length ? `（<b>${acked.length}</b> 项已被你忽略）` : ''}。</div>`;
  } else {
    // 严重在前：用户第一眼要先看到能造成实际故障的
    const order = { critical: 0, warning: 1, info: 2 };
    const sorted = issues.slice().sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
    issuesHtml = sorted.map((i) => {
      const s = DOCTOR_SEV[i.severity] || DOCTOR_SEV.info;
      // 标题命中术语表 → 「人话（原标题）」，原文标题缩进括号弱化，不再满屏开发者术语。
      const plain = doctorPlainTitle(i.title);
      const titleHtml = plain ? `${esc(plain)}（${esc(i.title)}）` : esc(i.title);
      // detail/hint 是给开发者看的原文（skill.json / BOM / registerTool 之类），
      // 默认收进折叠区，不吓唬小白；里面沿用既有的两个类，样式不变。
      const devDetail = (i.detail || i.hint)
        ? `<details class="dev-detail"><summary>技术详情</summary>
        ${i.detail ? `<div class="doctor-issue-detail">${esc(i.detail)}</div>` : ''}
        ${i.hint ? `<div class="doctor-issue-hint">→ ${esc(i.hint)}</div>` : ''}
      </details>`
        : '';
      return `<div class="doctor-issue ${s.cls}">
        <div class="doctor-issue-head">
          <span class="doctor-issue-icon">${s.icon}</span>
          <span class="doctor-issue-title">${titleHtml}</span>
          <span class="doctor-issue-area">${esc(i.area || '')}</span>
          <button class="doctor-issue-ignore" type="button"
                  data-ack-ignore="${esc(i.area || '')}|${esc(i.id || '')}"
                  title="自查后确认这条无妨？忽略后不再计入警告，可随时在下方恢复">忽略</button>
        </div>
        ${devDetail}
      </div>`;
    }).join('');
  }

  const uc = (rt.userChoices || []);
  const ucHtml = uc.length
    ? `<div class="doctor-userchoices">另有 <b>${uc.length}</b> 项属于「已关闭 / 未启用」的正常状态，不计为问题${
        uc.length ? `：<span class="doctor-uc-list">${esc(uc.slice(0, 6).join('；'))}${uc.length > 6 ? ' …' : ''}</span>` : ''
      }</div>`
    : '';

  const errHtml = (report.errors && report.errors.length)
    ? `<div class="doctor-errs">⚠️ 检查过程本身出错：${esc(report.errors.join('；'))}</div>`
    : '';

  /* ── 忽略清单（doctor.ack）──
     后端 applyAckToReport 把被忽略的条目从 issues 挪进 report.acked，并按可见项
     重算 counts / verdict，所以"已忽略"必须单独渲染一块：否则用户忽略过的条目
     既不在问题列表里、也没有任何地方能看见和恢复，"忽略"就成了一个黑洞。
     条目取 report.acked，key 用 `${area}|${id}`，与 ackIssue / 后端 ackKeyOf 一致。 */
  const ackedHtml = acked.length ? `
    <div class="doctor-acked">
      <div class="doctor-acked-head">已忽略 <b>${acked.length}</b> 项 —— 你自查后确认无妨，不再计入警告：</div>
      ${acked.map((i) => `
        <span class="doctor-acked-item">
          ${esc(i.title || i.id || '')}
          <button class="doctor-acked-restore" type="button"
                  data-ack-restore="${esc(i.area || '')}|${esc(i.id || '')}">恢复</button>
        </span>`).join('')}
      <button class="doctor-acked-restore-all" type="button" data-ack-restore-all="1">全部恢复</button>
    </div>` : '';

  // 忽略/恢复操作的局部反馈（失败时），不用 doctorState.error，那会炸掉整页
  const ackMsgHtml = doctorState.ackMsg
    ? `<div class="doctor-ack-msg">⚠️ ${esc(doctorState.ackMsg)}</div>` : '';

  return `
    <div class="hint" style="margin:0 0 10px">连不上 QQ / 机器人不回话 → 去「工具 → 连接」看连接状态。</div>
    <div class="doctor-verdict ${v.cls}">
      <span class="doctor-verdict-icon">${v.icon}</span>
      <div class="doctor-verdict-text">
        <div class="doctor-verdict-label">${esc(v.label)}</div>
        <div class="doctor-verdict-sub">${esc(v.sub)}</div>
      </div>
      <div class="doctor-stat-row">${countsHtml}</div>
    </div>
    <div class="doctor-meta">
      扩展 <b>${ext.total ?? 0}</b> 个（默认启用 ${ext.enabledByDefault ?? 0}）｜
      扫描会话 <b>${rt.scanned ?? 0}</b> 个｜
      耗时 ${report.ms ?? 0}ms｜
      生成于 ${esc(doctorFmtTime(report.at))}
    </div>
    <div class="doctor-issues">${issuesHtml}</div>
    ${ackMsgHtml}
    ${ackedHtml}
    ${ucHtml}
    ${errHtml}
    <!-- 「复制诊断信息」：监听器一直挂在下面（#doctor-copy-btn），但按钮本体曾被
         合并 0.4.9 的补丁连同 doctorReportText 一起删掉，结果这个功能在界面上
         凭空消失，只剩一段永远点不到的监听器。按钮与函数一起补回。 -->
    <div style="margin-top:12px"><button class="btn btn-small" id="doctor-copy-btn">📋 复制诊断信息</button></div>`;
}

/** 把当前体检单拼成纯文本，供「复制诊断信息」按钮使用，小白拿去问人时贴一份就够。 */
function doctorReportText(report) {
  if (!report) return '（还没有体检数据，点「重新扫描」跑一次）';
  const c = report.counts || {};
  const sevLabel = { critical: '严重', warning: '警告', info: '提示' };
  const lines = [
    `[QQ Agent 体检单] ${doctorFmtTime(report.at)}`,
    `结论：${doctorVerdictMeta(report.verdict).label}（严重 ${c.critical || 0} / 警告 ${c.warning || 0} / 提示 ${c.info || 0}）`
  ];
  const issues = Array.isArray(report.issues) ? report.issues : [];
  if (!issues.length) {
    lines.push('没有发现问题。');
  } else {
    for (const i of issues) {
      let line = `- [${sevLabel[i.severity] || i.severity}] ${i.title}`;
      if (i.detail) line += `：${i.detail}`;
      if (i.hint) line += ` → ${i.hint}`;
      lines.push(line);
    }
  }
  return lines.join('\n');
}

// ── 项目扫描结果渲染 ──────────────────────────────────────────────────────

/** 规则 id → 中文短名，用于过滤下拉。 */
const DOCTOR_RULE_LABELS = {
  'empty-catch': '空白 catch',
  'unhandled-promise': '未处理 Promise',
  'hardcoded-abs-path': '硬编码绝对路径',
  'hardcoded-endpoint': '硬编码 host:port',
  'recursive-watch': '递归 fs.watch',
  'dynamic-eval': '动态执行 eval',
  'child-exec': 'shell 执行',
  'process-exit': 'process.exit',
  'console-log': 'console.log',
  'todo-marker': 'TODO/FIXME',
  'debugger': 'debugger',
  'long-function': '超长函数'
};

/** 模型给出的三档结论 → 展示元数据。 */
const DOCTOR_TRIAGE_META = {
  'true-problem':   { label: '真问题', cls: 'is-true' },
  'false-positive': { label: '误报',   cls: 'is-false' },
  'by-design':      { label: '既定设计', cls: 'is-design' }
};

/** 从审阅结果里取某条命中的结论（key = file:line:ruleId）。 */
function doctorVerdictOf(file, line, ruleId) {
  const t = doctorState.triage;
  if (!t || !t.entries) return null;
  const key = `${file}:${line}:${ruleId}`;
  return t.entries.find((e) => e.key === key) || null;
}

function renderDoctorProject() {
  const p = doctorState.project;
  if (doctorState.scanning) {
    return `<div class="doctor-proj-loading">正在扫描整个代码库…</div>`;
  }
  if (!p) {
    return `<div class="hint" style="margin-top:14px">
      点「扫描项目」对整个代码库做静态扫描（<code>src/</code> <code>ui/</code> <code>plugins/</code> <code>skills/</code>）。
      找的是潜在问题：吞异常的空白 catch、未处理的 Promise、硬编码路径、递归 watch、残留调试代码等。
      <b>结果是静态分析，含少量误报</b> —— 每条都给了文件:行号，可以自己核对。
    </div>`;
  }

  const s = p.scanned || {};
  const sev = p.bySeverity || {};
  const rules = p.rules || [];

  const ruleOpts = ['<option value="">全部规则</option>']
    .concat(rules.map((r) => `<option value="${esc(r.ruleId)}"${doctorState.projectRule === r.ruleId ? ' selected' : ''}>${esc(DOCTOR_RULE_LABELS[r.ruleId] || r.ruleId)} ×${r.count}</option>`))
    .join('');

  let body;
  if (!rules.length) {
    body = `<div class="doctor-empty-ok">✅ 未发现可疑点。</div>`;
  } else {
    // 审阅过滤：按结论筛样本（'true-problem' 只看真问题等）。未审的样本在筛选模式下隐去。
    const tf = doctorState.triageFilter;
    const shown = doctorState.projectRule ? rules.filter((r) => r.ruleId === doctorState.projectRule) : rules;
    const cards = shown.map((r) => {
      const m = DOCTOR_SEV[r.severity] || DOCTOR_SEV.info;
      let samples = r.samples;
      if (tf) {
        samples = samples.filter((x) => {
          const v = doctorVerdictOf(x.file, x.line, r.ruleId);
          return v && v.verdict === tf;
        });
      }
      if (!samples.length) return '';   // 筛选后该规则没剩样本就不渲染这张卡
      const samplesHtml = samples.map((x) => {
        const v = doctorVerdictOf(x.file, x.line, r.ruleId);
        const meta = v ? DOCTOR_TRIAGE_META[v.verdict] : null;
        const badge = meta
          ? `<span class="doctor-triage-badge ${meta.cls}" title="${esc(v.reason || '')}">${esc(meta.label)}</span>`
          : '';
        const reason = v && v.reason ? `<div class="doctor-triage-reason">└ ${esc(v.reason)}</div>` : '';
        return `<div class="doctor-proj-hit-wrap">
          <div class="doctor-proj-hit"><span class="doctor-proj-loc">${esc(x.file)}:${x.line}</span> <span class="doctor-proj-code">${esc(x.detail)}</span>${badge}</div>
          ${reason}
        </div>`;
      }).join('');
      const more = !tf && r.count > r.samples.length ? `<div class="doctor-proj-more">…另 ${r.count - r.samples.length} 处</div>` : '';
      return `<div class="doctor-issue ${m.cls}">
        <div class="doctor-issue-head">
          <span class="doctor-issue-icon">${m.icon}</span>
          <span class="doctor-issue-title">${esc(r.title)}</span>
          <span class="doctor-issue-area">×${tf ? samples.length + '/' + r.count : r.count}</span>
        </div>
        ${r.hint ? `<div class="doctor-issue-hint">→ ${esc(r.hint)}</div>` : ''}
        <div class="doctor-proj-hits">${samplesHtml}${more}</div>
      </div>`;
    }).join('');
    body = tf && !cards
      ? `<div class="doctor-empty-ok">该结论下没有条目。</div>`
      : cards;
  }

  const hottest = (p.hottest || []).slice(0, 6);
  const hotHtml = hottest.length ? `
    <div class="doctor-proj-hot">
      <span class="doctor-proj-hot-label">问题最集中：</span>
      ${hottest.map((h) => `<span class="doctor-proj-hotitem">${esc(h.rel)} <b>${h.issues}</b></span>`).join('')}
    </div>` : '';

  return `
    <div class="doctor-proj-head">
      <div class="doctor-proj-meta">
        扫描 <b>${s.files || 0}</b> 个文件 / <b>${s.lines || 0}</b> 行 ｜ 耗时 ${p.ms}ms ｜
        <span class="doctor-proj-sev is-critical">严重 ${sev.critical || 0}</span>
        <span class="doctor-proj-sev is-warning">警告 ${sev.warning || 0}</span>
        <span class="doctor-proj-sev is-info">提示 ${sev.info || 0}</span>
      </div>
      <select class="doctor-proj-filter" id="doctor-proj-filter">${ruleOpts}</select>
    </div>
    ${renderTriageBar(rules)}
    ${hotHtml}
    <div class="doctor-issues">${body}</div>`;
}

/**
 * "模型逐个审"控制条 + 审阅结果汇总。
 * 只在有 warning 及以上候选时才出现，info 级（console.log/TODO）不值得花 token。
 */
function renderTriageBar(rules) {
  const p = doctorState.project || {};
  const sev = p.bySeverity || {};
  const reviewable = (sev.warning || 0) + (sev.critical || 0);

  if (!reviewable) {
    return `<div class="doctor-triage-bar is-idle">
      <span class="doctor-triage-hint">静态扫描没有「警告 / 严重」级候选，模型无需介入（提示级不花 token）。</span>
    </div>`;
  }

  if (doctorState.triaging) {
    const g = doctorState.triageProg || {};
    const done = g.done || 0, total = g.total || 0;
    const pct = total ? Math.round((done / total) * 100) : 0;
    return `<div class="doctor-triage-bar is-running">
      <span class="doctor-triage-hint">模型正在逐个审：${done}/${total || '?'} 个文件${g.file ? `（当前 <code>${esc(g.file)}</code>）` : ''}</span>
      <div class="doctor-triage-prog"><i style="width:${pct}%"></i></div>
    </div>`;
  }

  const t = doctorState.triage;
  if (!t || !t.entries || !t.entries.length) {
    return `<div class="doctor-triage-bar">
      <span class="doctor-triage-hint">
        <b>${reviewable}</b> 条「警告/严重」候选是<b>静态规则</b>找到的，可能有误报。
        点这里让<b>模型读真实源码逐条判真伪</b>（要花 token，只审警告及以上）。
      </span>
      <!-- ⚠️ id=doctor-triage-btn 在本函数里出现两次（此处 / 下面"再审一次"）。
           两者在**互斥分支**里，同一时刻只会有一个在 DOM 中，所以安全，
           bindProjectEvents() 用 $('#doctor-triage-btn') 取，取到的就是当前那个。
           将来若再加分支，别让两个同时渲染：同 id 的元素 $() 只会命中第一个，
           第二个会变成点不动的死按钮（且没有任何报错）。 -->
      <button class="btn btn-primary btn-small" id="doctor-triage-btn">让模型自检</button>
    </div>`;
  }

  // 审阅完成：给汇总 + 过滤
  const cnt = { 'true-problem': 0, 'false-positive': 0, 'by-design': 0 };
  for (const e of t.entries) if (cnt[e.verdict] != null) cnt[e.verdict]++;
  const st = t.stats || {};
  const filters = [
    ['', `全部 ${t.entries.length}`],
    ['true-problem', `真问题 ${cnt['true-problem']}`],
    ['false-positive', `误报 ${cnt['false-positive']}`],
    ['by-design', `既定设计 ${cnt['by-design']}`]
  ].map(([v, label]) =>
    `<button class="doctor-triage-filter${doctorState.triageFilter === v ? ' is-on' : ''}" data-triage-filter="${v}">${esc(label)}</button>`
  ).join('');
  return `<div class="doctor-triage-bar is-done">
    <div class="doctor-triage-sum">
      模型已审 <b>${st.reviewed || 0}</b> 个文件（${esc(t.model || '模型')}）：
      <span class="doctor-triage-badge is-true">真问题 ${cnt['true-problem']}</span>
      <span class="doctor-triage-badge is-false">误报 ${cnt['false-positive']}</span>
      <span class="doctor-triage-badge is-design">既定设计 ${cnt['by-design']}</span>
      ${st.failed ? `<span class="doctor-triage-fail">失败 ${st.failed}</span>` : ''}
      ${st.capped ? `<span class="doctor-triage-fail">（已按上限截断，共 ${st.calls} 批）</span>` : ''}
    </div>
    <div class="doctor-triage-actions">
      <span class="doctor-triage-filters">${filters}</span>
      <button class="btn btn-small" id="doctor-triage-btn">再审一次</button>
    </div>
  </div>`;
}

// ── 对话区渲染 ────────────────────────────────────────────────────────────

function renderDoctorTurns() {
  if (!doctorState.turns.length) {
    return `<div class="doctor-chat-empty">
      问点具体的，比如：<br />
      <span class="doctor-chip" data-doctor-ask="为什么有的群机器人不回复？">为什么有的群机器人不回复？</span>
      <span class="doctor-chip" data-doctor-ask="缓存命中率低是什么原因？">缓存命中率低是什么原因？</span>
      <span class="doctor-chip" data-doctor-ask="最近一次启动有没有报错？去看日志确认">最近一次启动有没有报错？</span>
      <span class="doctor-chip" data-doctor-ask="哪些插件可能没生效？">哪些插件可能没生效？</span>
    </div>`;
  }
  return doctorState.turns.map((t, i) => {
    if (t.role === 'user') {
      return `<div class="doctor-turn is-user"><div class="doctor-bubble">${esc(t.text)}</div></div>`;
    }
    // 取证轨迹：模型自己读了哪些文件/日志。放在气泡上面（先取证后结论，
    // 与真实发生顺序一致），默认折叠，否则长轨迹会淹没答案。
    const traceHtml = renderDoctorTrace(t.trace);
    const meta = t.model ? `<div class="doctor-turn-meta">${esc(t.model)}</div>` : '';
    // 「生成修复提案」：把这条结论直接交给「自动修复」模块（诊断 → 提案 的自然动线）。
    // 只对已出结论的回答显示（pending 占位气泡、空回答不给按钮）。
    const canFix = !t.pending && String(t.text || '').trim().length > 0;
    const fixBtn = canFix
      ? `<div class="doctor-turn-actions"><button class="btn btn-small" data-fix-from="${i}">🛠 生成修复提案</button></div>`
      : '';
    return `<div class="doctor-turn is-bot">${traceHtml}<div class="doctor-bubble">${doctorMiniMd(t.text)}</div>${meta}${fixBtn}</div>`;
  }).join('');
}

/** 渲染一次回答的取证轨迹（可折叠）。trace 为空则什么都不显示。 */
function renderDoctorTrace(trace) {
  if (!Array.isArray(trace) || !trace.length) return '';
  const n = trace.length;
  const icons = {
    doctor_read_file: '📄',
    doctor_list_files: '📁',
    doctor_find_files: '🔍',
    doctor_grep: '🔎',
    doctor_list_logs: '🗂',
    doctor_tail_log: '📜'
  };
  const items = trace.map((c) => {
    const icon = icons[c.tool] || '🔧';
    const argStr = Object.entries(c.args || {})
      .map(([k, v]) => `${k}=${String(v).slice(0, 46)}`)
      .join(' ');
    const err = c.isError ? ' <span class="doctor-trace-err">被拒</span>' : '';
    return `<div class="doctor-trace-item">
      <span class="doctor-trace-tool">${icon} ${esc(c.tool.replace(/^doctor_/, ''))}</span>
      <span class="doctor-trace-args">${esc(argStr)}</span>${err}
    </div>`;
  }).join('');
  return `<details class="doctor-trace">
    <summary>🔬 取证过程：调用了 ${n} 次工具</summary>
    <div class="doctor-trace-body">
      ${items}
      <div class="doctor-trace-note">以上是模型为回答本次问题**实际读过**的文件与日志。结论里的引用应当能在这里找到出处。</div>
    </div>
  </details>`;
}

// ── 页面主渲染 ────────────────────────────────────────────────────────────
//
// 结构：harness（顶层页签）
//         ├─ 自检系统  体检单 + 全项目扫描 + 模型逐个审（确定性为主）
//         └─ 对话审查  自由问答，模型自己读源码/日志取证（模型驱动）
//
// 子页签只切换内容区，顶部的模型设置/重新扫描等公共按钮常驻。

/** 子模块定义：id 与 doctorState.sub 对应。 */
const DOCTOR_SUBS = [
  { id: 'checkup', label: '自检系统', icon: '🩺', hint: '只读体检：扩展清单 / 运行期异常 / 缓存健康，外加全项目静态扫描与模型逐个审。不花对话轮次，也不会改任何文件。' },
  { id: 'chat', label: '对话审查', icon: '🔬', hint: '模型会<b>自己去读</b>源码与日志来取证，再给结论。适合"为什么 X 不工作""昨天那个报错是什么"这类体检单覆盖不到的问题。' },
  { id: 'fix', label: '自动修复', icon: '🛠', hint: '把「对话审查」查出的问题<b>修掉</b>，但有两道人工闸：① 模型只出提案，<b>你批准</b>才动手；② 改完在沙箱里真跑一遍，<b>你看着实跑效果</b>决定通过还是重跑。全程不原地改 —— 改动先进暂存区、过协议闸与五道闸门，落地前必快照、随时可回滚。默认关闭。' },
  { id: 'forge', label: '自创扩展', icon: '⚒️', hint: '用自然语言描述需求，模型起草一个扩展（技能 / 插件）→ 过五道闸门（结构 / 语法 / 危险模式 / 声明-实现 / 环境适配）→ <b>你确认后</b>才安装。生成的代码会真的在本机执行，所以最后一步必须由你点。' },
  { id: 'upgrade', label: '升级扩展', icon: '⬆️', hint: '升级<b>已装</b>的插件 / 技能：从列表选一个让模型按你的想法改，或拖入别人的升级包自动对比"更新了什么"。全程不原地改 —— 改的是暂存区副本，你确认后先备份原版再覆盖，随时可回滚。' },
  { id: 'bundle', label: '打包 / 接收', icon: '📤', hint: '把<b>本机的扩展与数据</b>勾选打包成一个 zip 发给别人，或接收别人发来的整包：包里<b>不含</b> API Key / QQ 号 / 网关 token / 插件私有存储。接收时扩展先进锻造台过闸、由你<b>一次确认批量安装</b>，数据导入前照旧自动备份、可回滚。' },
  { id: 'orders', label: '开发工单', icon: '📝', hint: '<b>开发模式</b>：白名单成员发「开发 xxx」→ 该会话自动进入开发模式，之后的聊天直接指挥模型干活（项目内全权限：读写文件、执行命令），回复直接发回群里 —— <b>不需要再来这里确认</b>。发「结束」或「退出开发」回到正常机器人。左侧可回看/插话/删除会话，「模型设置」建议指到强模型。' }
];

/** 子页签切换：只改 state 并重绘（体检单两个模块共用同一份数据，不重复拉）。 */
function switchDoctorSub(id) {
  if (!DOCTOR_SUBS.some((s) => s.id === id)) return;
  if (doctorState.sub === id) return;
  doctorState.sub = id;
  renderDoctorPage();
  // 切到对话审查时把光标放进输入框（最常见的下一步动作就是打字）
  if (id === 'chat') $('#doctor-q')?.focus();
  // 切到自创扩展时要拉一次状态（那是另一个插件的数据）。
  // 草稿列表是易变数据，每次进子页都重拉：只在 available === null 时拉的话，
  // "第一次进来"之后每次进来都停在旧快照上，从市场装完跳过来也看不到新包。
  // /api/forge 很轻。
  if (id === 'forge') {
    refreshForgeStatusInBackground();
  }
  // 切到升级扩展时拉已装列表（幂等：失败可重试，成功后有缓存）
  if (id === 'upgrade' && !doctorState.upgrade.list.length) {
    refreshInBackground(loadUpgradeList, 'upgrade', '升级列表');
  }
  // 切到自动修复时拉一次状态 + 工单列表（幂等：失败可重试，成功后有缓存）
  if (id === 'fix') {
    refreshInBackground(loadFixList, 'fix', '修复工单列表');
  }
  // 切到打包/接收：拉一次可打包项（扩展清单 + 各类数据体积）。
  // 只在没拉过时拉，体积统计要遍历目录，不是每次切页都值得付这个开销。
  if (id === 'bundle') {
    if (!doctorState.bundle.options && !doctorState.bundle.loading) {
      refreshInBackground(loadBundleOptions, 'bundle', '可打包项');
    }
    // 备份列表很轻（一次 readdir + 读几个 manifest），每次进页都刷新，
    // 刚导入完就切走再回来，列表必须包含刚才那一次，否则用户以为没备份。
    refreshInBackground(loadBundleBackups, 'bundle', '导入备份');
  }
  // 切到开发工单：拉一次快照并开始轮询（轮询自持，离开子页自己停）。
  // 只在进入时做"首次"加载、轮询又只由"从页面发消息"启动的话，
  // 「从 QQ 发起」「刷新页面后再进来」这些路径下页面会停在旧数据上不动。
  if (id === 'orders') {
    refreshInBackground(loadDevOrdersSnapshot, 'orders', '开发工单');
    startDevPolling();
    if (doctorState.orders.selected) refreshInBackground(loadDevOrderDetail, 'orders', '开发记录');
  } else {
    stopDevPolling();
  }
}

/**
 * 后台拉一次锻造台状态并重绘。
 *
 * loadForgeStatus 自身有 try/catch，但不覆盖 `.then` 回调里的 renderDoctorPage()，
 * 渲染抛错就会变成未捕获的 Promise 拒绝，界面还会静默停在旧内容。
 * 另外"只在还停在 forge 时才重绘"的判断原本在两个调用点各写一遍，抽出来免得漏。
 */
async function refreshForgeStatusInBackground() {
  try {
    await loadForgeStatus();
    // 异步回来时用户可能已经切走了，只在还停在 forge 时才重绘
    if (doctorState.sub === 'forge') renderDoctorPage();
  } catch (e) {
    // 这是次要数据：拉不到就保持"未探测"状态，不值得把异常抛到 window
    console.warn('[harness] 锻造台状态刷新失败：', e?.message || e);
  }
}

/**
 * 后台拉数据 + 重绘，全链路兜底。
 *
 * 本文件有 9 处 `loadXxx().then(() => renderDoctorPage())` 没有配对 .catch()。
 * loadXxx 自己有 try/catch，但不覆盖 `.then` 回调，抛错点其实是回调里的
 * renderDoctorPage()，会变成 unhandledRejection，且失败是静默的：用户看到一片
 * 没更新的旧内容。逐处补 .catch() 是 9 处重复，将来新增子页签还会再犯，所以抽成函数。
 *
 * @param {() => Promise<any>} loader
 * @param {string} [sub] 传了则只在仍停留该子页时重绘（异步回来时用户可能已切走）
 * @param {string} [label] 日志里用的名字
 */
async function refreshInBackground(loader, sub = '', label = '') {
  try {
    await loader();
    // 异步回来时用户可能已经切走，只在还停在原页面时才重绘（详见上面注释②）
    if (!sub || doctorState.sub === sub) renderDoctorPage();
  } catch (e) {
    // 这些都是次要数据：拉不到就保持原状态，不值得把异常抛到 window。
    // 但必须打日志，否则界面"没更新"这件事完全无从追查。
    console.warn(`[harness] ${label || '数据'}刷新失败：`, e?.message || e);
  }
}

/**
 * 在 harness 各模块的"插件未启用"占位里，提供一个当场启用的按钮。
 *
 * 用法：
 *   $('#xxx-enable-btn')?.addEventListener('click', () =>
 *     enablePluginInline('plugin-id', $('#xxx-enable-btn'), async () => {
 *       // 启用成功后的重探逻辑（由各模块自己决定）
 *       await loadSomething();
 *       renderDoctorPage();
 *     })
 *   );
 *
 * harness 里这几个插件都是"为了用某个具体能力才会去开"，绝大多数用户
 * 进了这页才发现没开，当场一键开是最自然的动线。settings 那边仍是唯一的
 * 可视管理入口，这里只是快捷方式，启停都走同一条 `POST /api/skills/<id>` 通道。
 *
 * 错误处理：
 *   - 插件未安装 → 后端 404，api() 抛 Error，弹 qaAlert 提示去市场安装
 *   - 后端瞬时失败 → 按钮文字恢复原状（orig），用户可重试
 *   - 后端 enable 后 activate 回调可能异步完成，交由调用方的 afterEnable 重探
 */
async function enablePluginInline(pluginId, btn, afterEnable) {
  if (!btn) return;
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = '启用中…';
  try {
    await api(`/api/skills/${encodeURIComponent(pluginId)}`, {
      method: 'POST',
      body: JSON.stringify({ enabled: true })
    });
    if (afterEnable) await afterEnable();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = orig;
    qaAlert(`启用失败：${e.message}\n\n如果 ${pluginId} 没装，请去「下载 → 插件下载」装好再回来。`);
  }
}

function renderDoctorPage() {
  const box = $('#harness-page');
  if (!box) return;

  // 骨架（首次进入、还没有 report 时）
  if (doctorState.loading && !doctorState.report && doctorState.available !== false) {
    box.innerHTML = `
      <div class="usage-wrap">
        <div class="usage-head"><h2>自检</h2></div>
        <div class="sk-block">${'<div class="sk-row"></div>'.repeat(6)}</div>
        <div class="hint" style="margin-top:10px">正在体检…</div>
      </div>`;
    return;
  }

  const sub = DOCTOR_SUBS.find((s) => s.id === doctorState.sub) || DOCTOR_SUBS[0];

  // 页面外壳（标题 + 子页签）必须无条件渲染。
  //
  // harness 是多插件工作台：自检系统 / 对话审查 靠 self-doctor，自创扩展
  // 靠 extension-forge。曾经在"self-doctor 未启用"时提前 return，整页只剩
  // 一句"插件未启用"、子页签全没了，结果是关掉 self-doctor 就连自创扩展也进不去。
  // 现在每个模块自己处理"我的依赖没开"。
  box.innerHTML = `
    <div class="usage-wrap${doctorState.sub === 'fix' ? ' is-fix' : ''}">
      <div class="usage-head">
        <h2>自检</h2>
        <div class="usage-days">
          <button class="btn btn-small" id="doctor-model-btn">模型设置</button>
          <button class="btn btn-small" id="doctor-rescan-btn"${doctorState.running ? ' disabled' : ''}>${doctorState.running ? '扫描中…' : '重新扫描'}</button>
        </div>
      </div>

      <div class="doctor-subs" role="tablist">
        ${DOCTOR_SUBS.map((s) => `
          <button class="doctor-sub${doctorState.sub === s.id ? ' is-active' : ''}" type="button"
                  role="tab" aria-selected="${doctorState.sub === s.id}" data-sub="${s.id}">
            <span class="ds-icon">${s.icon}</span>${s.label}
          </button>`).join('')}
      </div>
      <div class="hint" style="margin-bottom:12px">${sub.hint}</div>

      <div class="doctor-sub-body" id="doctor-sub-body">
        ${renderDoctorSubBody()}
      </div>
    </div>`;

  // ── 公共事件 ──
  $('#doctor-rescan-btn')?.addEventListener('click', () => loadHarnessPage({ force: true }));
  $('#doctor-model-btn')?.addEventListener('click', () => openDoctorModelDialog());
  // 「复制诊断信息」：把当前体检单拼成纯文本，小白拿去问人 / 反馈时贴这一份就够。
  $('#doctor-copy-btn')?.addEventListener('click', async () => {
    const btn = $('#doctor-copy-btn');
    if (!btn) return;
    const orig = btn.textContent;
    try {
      await navigator.clipboard.writeText(doctorReportText(doctorState.report));
      btn.textContent = '已复制 ✓';
    } catch (e) {
      qaAlert('复制失败：' + (e?.message || e));
      return;
    }
    setTimeout(() => { if (btn.isConnected) btn.textContent = orig; }, 1500);
  });
  // 「重试」只出现在模块内部的"未启用/出错"占位里，两个模块都可能用到
  $('#doctor-retry-btn')?.addEventListener('click', async () => {
    doctorState.available = null;
    doctorState.forge.available = null;
    await Promise.all([
      loadHarnessPage({ force: true }),
      loadForgeStatus()
    ]);
    renderDoctorPage();
  });
  // 当场启用按钮（与 doctor-retry-btn 互斥，同一时刻只渲染一个，见 renderDoctorSubBody）
  $('#doctor-enable-btn')?.addEventListener('click', () => enablePluginInline('self-doctor', $('#doctor-enable-btn'), async () => {
    // 启用了 self-doctor 之后重探一次（覆盖自检系统 + 对话审查两个模块的依赖）
    doctorState.available = null;
    doctorState.forge.available = null;
    await Promise.all([
      loadHarnessPage({ force: true }),
      loadForgeStatus()
    ]);
    renderDoctorPage();
  }));
  $$('.doctor-sub', box).forEach((el) => {
    el.addEventListener('click', () => switchDoctorSub(el.dataset.sub));
  });

  /* ── 忽略 / 恢复体检单条目 ──
     后端：POST /api/doctor/ack {action, items} → {ok, acked}；
     落盘 data/plugin-data/self-doctor/acked.json（重启后仍生效）。
     逐个绑、不挂委托到 box：box 本身不重建（每次渲染只换 innerHTML），
     委托监听会跨渲染叠加，一次忽略能触发 N 次请求。 */
  $$('[data-ack-ignore]', box).forEach((el) => {
    el.addEventListener('click', () => ackIssue(el.getAttribute('data-ack-ignore') || ''));
  });
  $$('[data-ack-restore]', box).forEach((el) => {
    el.addEventListener('click', () => ackIssue(el.getAttribute('data-ack-restore') || '', 'restore'));
  });
  $('[data-ack-restore-all]', box)?.addEventListener('click', () => ackIssue('', 'restore-all'));

  // ── 子模块各自的事件 ──
  if (doctorState.sub === 'chat') bindChatEvents(box);
  else if (doctorState.sub === 'forge') bindForgeEvents(box);
  else if (doctorState.sub === 'upgrade') bindUpgradeEvents(box);
  else if (doctorState.sub === 'bundle') bindBundleEvents(box);
  else if (doctorState.sub === 'fix') bindFixEvents(box);
  else if (doctorState.sub === 'orders') bindOrdersEvents(box);
  else bindCheckupEvents(box);
}

/**
 * 按当前子模块渲染内容区。
 *
 * 每个模块自己处理"我的依赖插件没开"：外壳统一渲染，模块各自负责可用性，
 * 免得某个插件关掉把整页（包括不依赖它的模块）一起锁死。
 */
function renderDoctorSubBody() {
  // 自检系统 与 对话审查 都依赖 self-doctor。
  // 「orders」和「forge / upgrade / bundle / fix」一样有独立依赖（dev-orders），
  // 必须排除在这个分支之外：漏掉 'orders' 时它会落到下面的 else 分支，
  // 把自检系统的画面渲染进开发工单页。新增依赖独立插件的子模块时，记得加进这个列表。
  const SELF_DOCTOR_SUBS = ['checkup', 'chat'];
  if (SELF_DOCTOR_SUBS.includes(doctorState.sub)) {
    if (doctorState.available === false) return renderSelfDoctorOff();
    if (doctorState.error) return renderSelfDoctorError();
    return doctorState.sub === 'chat' ? renderChatModule() : renderCheckupModule();
  }
  if (doctorState.sub === 'upgrade') return renderUpgradeModule();
  if (doctorState.sub === 'bundle') return renderBundleModule();
  if (doctorState.sub === 'fix') return renderFixModule();   // fix 自己判断 self-fix 有没有开
  if (doctorState.sub === 'orders') return renderOrdersModule();   // orders 自己判断 dev-orders 有没有开
  return renderForgeModule();   // forge 自己判断 extension-forge 有没有开
}

/** 自检系统 / 对话审查 的依赖（self-doctor）没开时的占位。 */
function renderSelfDoctorOff() {
  return `<div class="empty-hint">「系统自检」插件当前未启用。</div>
    <div class="hint" style="margin-top:10px">
      去 <b>下载 → 已安装 → 插件</b> 找到 <code>self-doctor</code> 并启用它，或者直接点下面的按钮当场启用。
    </div>
    <div style="display:flex;gap:8px;margin-top:12px">
      <!-- r107：harness 各模块的"插件未启用"占位里加一个当场启用的按钮，避免
           用户跑去设置里找半天再切回来。doctor-enable-btn 与 doctor-retry-btn
           互斥，见 renderDoctorSubBody 的分发顺序（同一时刻只渲染这一组）。 -->
      <button class="btn btn-small btn-primary" id="doctor-enable-btn">立即启用 self-doctor</button>
      <button class="btn btn-small" id="doctor-retry-btn">已启用，重新检测</button>
    </div>`;
}

/** self-doctor 接口报错时的占位。 */
function renderSelfDoctorError() {
  return `<div class="empty-hint">⚠️ ${esc(doctorState.error)}</div>
    <button class="btn btn-small" id="doctor-retry-btn" style="margin-top:12px">重试</button>`;
}

/** 子模块一：自检系统，体检单 + 全项目扫描（+ 模型逐个审的进度条）。 */
function renderCheckupModule() {
  return `
    <div class="doctor-report">${renderDoctorReport(doctorState.report)}</div>
    <div class="doctor-sentinel-wrap">${renderCacheSentinel()}</div>
    <div class="doctor-proj-wrap">${renderProjectSection()}</div>`;
}

// ── 前缀缓存哨兵 ──────────────────────────────────────────────────────────
//
// 量表放在这一页：命中率是"系统健康"里唯一每天在变、且直接等于钱的指标。
// 放在插件页的深层报告里没人看，放在自检第一屏才会被看见。
//
// 两条动线刻意分开：
//   · 「刷新量表」只读盘，免费，随时点
//   · 「哨兵分析」把量表 + 静态体检交给模型解读，花 token
// 合成一个按钮会让人因为"怕花钱"而不看数据。

function sentinelBar(row, maxPrompt) {
  const wHit = Math.max(0, Math.min(100, (row.cached / maxPrompt) * 100));
  // 未命中常常只有 2%，按比例画会细成一条线；给 1.5% 的最小可见宽度，
  // 真实数值仍在 title 与右侧文字里（不靠视觉宽度表达精度）。
  const wMiss = Math.max(1.5, Math.min(100 - wHit, (row.miss / maxPrompt) * 100));
  const time = row.at ? new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : '--:--';
  const pct = (row.rate * 100).toFixed(1);
  const tip = `${time}　prompt ${row.prompt.toLocaleString()}｜命中 ${row.cached.toLocaleString()}`
    + `｜未命中 ${row.miss.toLocaleString()}｜输出 ${row.out.toLocaleString()}`
    + (row.calls > 1 ? `｜${row.calls} 次调用` : '');
  return `
    <div class="sentinel-row" title="${esc(tip)}">
      <span class="sentinel-t">${time}</span>
      <span class="sentinel-track">
        <i class="sentinel-hit" style="width:${wHit.toFixed(2)}%"></i>
        <i class="sentinel-miss" style="width:${wMiss.toFixed(2)}%"></i>
      </span>
      <span class="sentinel-pct ${row.rate >= 0.95 ? 'ok' : (row.rate >= 0.85 ? 'warn' : 'bad')}">${pct}%</span>
      <span class="sentinel-out">出 ${row.out.toLocaleString()}</span>
    </div>`;
}

// ── 击穿归因（"谁干的"）────────────────────────────────────────────────
//
// 算法在 src/harness/doctor/cache-attribution.js，两个互补的数据源：
//   · 会话间 diff，相邻两轮存档的 systemPrompt 按「▸ 标题」切段比 hash，
//     第一个变了的段就是断点（字节级，带改前/改后原文）；
//   · cache-guard 漂移记录，按调用指纹抓会话**内部**翻字（段名级）。
//     本机两次「表情包」翻字两种都记到了（判重后保留字节级那份）；会话内
//     翻字又翻回的情况相邻存档一模一样，只有漂移记录看得到。
//
// 这里只负责把结论说清楚。三条线各有各的位置：
//   · 量表，掉了多少（每轮命中/未命中）
//   · 归因，谁干的（哪一段、属于哪个模块、断点在哪、换了什么字）
//   · 静态体检，还有谁可能会干（会变的段但没标 volatile）
function renderAttributionTail(a) {
  const t = a.tail || {};
  if (!t.rounds) return '';
  return `
    <div class="sentinel-attr-tail">尾部成本（无插件责任）：<b>${t.rounds}</b> 轮 · 合计 ${(t.miss || 0).toLocaleString()} tok
      · 中位 <b>${(t.medianMiss || 0).toLocaleString()}</b> tok/轮</div>
    <div class="sentinel-note">工具集变化不在本归因范围内 —— tools 段不进 session 存档，需看 <code>[req-fp]</code> 与 <code>tools-watch</code> 日志。</div>`;
}

// 模块清单："哪个模块带来了什么"，最新存档里每一段的归属、体量、稳定性。
// 与上面的 break 时间线互补：时间线说"哪次击穿是谁"，清单说"每个模块
// 长期占着多大一块、稳不稳"。
function renderModuleInventory(a) {
  const secs = a.sections || [];
  if (!secs.length) return '';
  const rows = secs.map((s) => `
    <div class="sentinel-inv-row${s.flips ? ' is-flip' : ''}">
      <span class="sentinel-inv-sec">「${esc(s.title)}」</span>
      <span class="sentinel-inv-mod">${s.module ? esc(s.name || s.module) : '核心'}</span>
      <span class="sentinel-inv-chars">${s.chars.toLocaleString()} 字符（${(s.share * 100).toFixed(0)}%）</span>
      ${s.flips
        ? `<span class="sentinel-inv-flips">⚠️ 观测期内翻字 ${s.flips} 次</span>`
        : '<span class="sentinel-inv-flips is-clean">稳定</span>'}
    </div>`).join('');
  return `
    <div class="sentinel-inv">
      <div class="sentinel-inv-head">模块清单 · 哪个模块带来了什么</div>
      ${rows}
    </div>`;
}

function renderAttribution() {
  const a = doctorState.sentinel?.attribution;
  if (!a || !a.compared) {
    return `<div class="sentinel-attr">
      <div class="sentinel-attr-head">击穿归因</div>
      <div class="sentinel-note">没有足够的会话做跨轮对比（至少需要两轮完整对话）。</div>
    </div>`;
  }

  const src = a.sources || {};
  const head = `<div class="sentinel-attr-head">击穿归因
    <span class="sentinel-dim">对比 ${a.compared} 对相邻轮 · 读取 ${a.scanned} 个会话${src.drift ? ` · 漂移记录采用 ${src.driftUsed ?? 0}/${src.drift} 条` : ''}</span></div>`;

  if (!a.breaks.length) {
    return `<div class="sentinel-attr">${head}
      <div class="sentinel-attr-ok">观察窗口内系统提示一字未动 —— <b>没有插件造成击穿</b>，未命中全部来自尾部滚动。</div>
      ${renderAttributionTail(a)}
      ${renderModuleInventory(a)}
    </div>`;
  }

  const HOW = { changed: '段内容变化', added: '新增段', removed: '删除段' };
  const FROM = { session: '会话间对比', drift: '按调用指纹' };
  // 新的在前：用户最关心"刚才那次是谁"
  const rows = a.breaks.slice(-6).reverse().map((b) => {
    const t = b.at ? new Date(b.at).toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5) : '--:--';
    const who = b.module ? esc(b.module) : `未识别来源`;
    // "断点 4513/5507" 比 "断点 82%" 更符合"详细到断点"的诉求，
    // 后面的损失率才是后果：断点说的是位置，损失率说的是代价。
    const lossPct = b.prompt ? Math.round((b.miss / b.prompt) * 100) : 0;
    // 改前/改后原文：字节级那半来自会话间 diff；drift 事件只有段名，
    // 原文取翻字前后的最近存档（来源徽标已经标明精度，不混为一谈）。
    const ba = (b.before || b.after)
      ? `<div class="sentinel-break-ba">
          <div class="sentinel-break-ba-row"><span class="sentinel-break-ba-tag">改前</span><span class="sentinel-break-ba-text">${esc(b.before || '（无此段）')}</span></div>
          <div class="sentinel-break-ba-row"><span class="sentinel-break-ba-tag is-after">改后</span><span class="sentinel-break-ba-text">${esc(b.after || '（段已删除）')}</span></div>
        </div>`
      : (b.excerpt ? `<div class="sentinel-break-ex" title="断点附近的原文">…${esc(b.excerpt.slice(0, 90))}…</div>` : '');
    return `
      <div class="sentinel-break">
        <div class="sentinel-break-top">
          <span class="sentinel-break-time">${t}</span>
          <span class="sentinel-break-sec">「${esc((b.titles || [b.title]).join('、'))}」</span>
          <span class="sentinel-break-mod">${who}</span>
          <span class="sentinel-break-how">${esc(HOW[b.change] || b.change)}</span>
          <span class="sentinel-break-src">${FROM[b.source] || ''}</span>
          <span class="sentinel-break-pos">断点 ${b.atChar}/${b.totalChars}（${(b.ratio * 100).toFixed(0)}%）</span>
          <span class="sentinel-break-miss">miss ${b.miss.toLocaleString()}（${lossPct}%）</span>
        </div>
        ${ba}
      </div>`;
  }).join('');

  const board = (a.byModule || []).map((m) => `
    <span class="sentinel-attr-tag" title="涉及段：${esc((m.sections || []).join('、'))}">
      <b>${esc(m.name || m.module || m.title)}</b>
      <span class="sentinel-dim">${m.count} 次 · ${m.miss.toLocaleString()} tok</span>
    </span>`).join('');

  return `<div class="sentinel-attr">
    ${head}
    ${board ? `<div class="sentinel-attr-board">${board}</div>` : ''}
    <div class="sentinel-break-list">${rows}</div>
    ${renderAttributionTail(a)}
    ${renderModuleInventory(a)}
  </div>`;
}

/**
 * 渲染模型解读。
 *
 * 四块并排是因为用户真正要判断的是"值不值得改"，那需要成本收益对照。
 * 自由文本会把四件事揉成一段，读者得自己拆；拆开摆好，收益和代价左右对齐。
 *
 * 收益/代价即使模型没写也要占位显示"（模型未给出）"：缺失本身就是信息，
 * 说明这次分析没考虑代价，不该就这么动手。
 */
function renderVerdict() {
  if (doctorState.sentinelAnalyzing) {
    return `<div class="sentinel-verdict is-pending">正在把量表交给模型解读…（会读源码与日志，可能要十几秒）</div>`;
  }
  const raw = doctorState.sentinelVerdict;
  if (!raw) return '';
  const p = doctorState.sentinelVerdictParsed;

  // 模型没按四段格式回答 → 退回原文整段展示，不丢信息
  if (!p?.structured) {
    return `<div class="sentinel-verdict"><div class="sentinel-verdict-head">模型解读</div>${esc(raw)}</div>`;
  }

  const block = (label, text, cls) => `<div class="sv-block ${cls}">
      <div class="sv-label">${label}</div>
      <div class="sv-text">${text ? esc(text) : '（模型未给出）'}</div>
    </div>`;

  return `<div class="sentinel-verdict-block">
    <div class="sentinel-verdict-head">模型解读</div>
    ${block('问题', p.problem, p.problem ? 'is-problem' : 'is-problem is-empty')}
    ${block('要做什么', p.plan, p.plan ? 'is-plan' : 'is-plan is-empty')}
    <div class="sv-pair">
      ${block('收益', p.benefit, p.benefit ? 'is-benefit' : 'is-benefit is-empty')}
      ${block('代价', p.cost, p.cost ? 'is-cost' : 'is-cost is-empty')}
    </div>
  </div>`;
}

function renderCacheSentinel() {
  const s = doctorState.sentinel;
  const busy = doctorState.sentinelLoading || doctorState.sentinelAnalyzing;
  // 「送去修复」只在分析真的产出了结论之后可用：这条动线的前提是
  // "有诊断结论可作修复依据"，光有量表没有结论，模型只能瞎猜。
  // 失败提示（⚠️ 开头）不算结论，别让它带着一句报错去写代码。
  const verdictReady = !!doctorState.sentinelVerdict
    && !doctorState.sentinelVerdict.startsWith('⚠️');
  const bar = `
    <div class="doctor-module-bar">
      <div class="doctor-chat-head" style="margin:0">前缀缓存哨兵</div>
      <button class="btn btn-small" id="sentinel-load-btn"${busy ? ' disabled' : ''}>${doctorState.sentinelLoading ? '取数中…' : '刷新量表'}</button>
      <button class="btn btn-primary btn-small" id="sentinel-analyze-btn"${busy || !s ? ' disabled' : ''}>${doctorState.sentinelAnalyzing ? '分析中…' : '哨兵分析'}</button>
      <button class="btn btn-small" id="sentinel-fix-btn"${busy || !verdictReady ? ' disabled' : ''}
        title="${verdictReady ? '把这次诊断结论带进「自动修复」，由你确认后再生成提案' : '先跑一次「哨兵分析」，有结论才能送去修复'}">送去修复</button>
    </div>`;

  if (doctorState.sentinelError) {
    return `${bar}<div class="doctor-errs">⚠️ ${esc(doctorState.sentinelError)}</div>`;
  }
  if (!s) {
    return `${bar}<div class="empty-hint">点「刷新量表」读取最近几轮的缓存构成（只读本地存档，不花 token）。</div>`;
  }

  const t = s.rounds?.totals || {};
  if (!t.rounds) {
    return `${bar}<div class="empty-hint">最近没有跑完的对话轮次可统计。${esc(s.headline?.text || '')}</div>`;
  }
  const maxPrompt = Math.max(...(s.rounds.rounds || []).map((r) => r.prompt), 1);
  const rows = (s.rounds.rounds || []).map((r) => sentinelBar(r, maxPrompt)).join('');
  const lvl = s.headline?.level || 'unknown';
  const levelText = { good: '健康', warn: '偏低', bad: '异常', unknown: '未知' }[lvl] || '未知';

  // 未命中按 token 只占几个百分点，但按价常占一半以上的输入成本，
  // 这两个数必须同时出现，否则用户会以为"未命中很少，不用管"。
  const suspect = (s.statics?.sections || []).filter((x) => x.verdict === 'suspect');
  const suspectHtml = suspect.length
    ? `<div class="sentinel-suspect">⚠️ 静态体检：<b>${suspect.length}</b> 个模块往稳定区注入了疑似会变的段，且没标 <code>volatile</code>：
        ${suspect.map((x) => `<span class="sentinel-tag" title="命中线索：${esc(x.signals.join('/'))}">${esc(x.name || x.id)}</span>`).join('')}
        <div class="sentinel-note">这是启发式判断，会误报（例如读配置帧数的段只在设置变更时动）。事实判据是 cache-guard 的漂移记录。</div>
      </div>`
    : '';

  const verdict = renderVerdict();

  return `${bar}
    <div class="sentinel-card">
      <div class="sentinel-head">
        <span class="sentinel-badge ${lvl}">${levelText}</span>
        <span>最近 <b>${t.rounds}</b> 轮命中率 <b>${(t.rate * 100).toFixed(1)}%</b></span>
        <span class="sentinel-dim">未命中 ${t.miss.toLocaleString()} tok，按价占输入成本 <b>${(t.missCostShare * 100).toFixed(0)}%</b></span>
      </div>
      <div class="sentinel-legend">
        <i class="sentinel-hit"></i>命中 <i class="sentinel-miss"></i>未命中 ｜ 条长 = 该轮 prompt 量，右侧「出」= 输出 token
      </div>
      <div class="sentinel-bars">${rows}</div>
      ${s.prefix ? `<div class="sentinel-dim sentinel-prefix">前缀规模：system ${s.prefix.systemChars.toLocaleString()} 字符（≈${s.prefix.estSystemTokens.toLocaleString()} tok）＋ ${s.prefix.toolNames} 个工具</div>` : ''}
      ${renderAttribution()}
      ${suspectHtml}
      ${verdict}
    </div>`;
}

/** 只重绘哨兵区（拉完数据/分析完只看这一块，别重建整页）。 */
function repaintSentinel() {
  const wrap = $('#harness-page')?.querySelector('.doctor-sentinel-wrap');
  if (!wrap) return;
  wrap.innerHTML = renderCacheSentinel();
  bindSentinelEvents();
}

/** 拉一份哨兵快照（只读本地，不花 token）。 */
async function runSentinel() {
  if (doctorState.sentinelLoading) return;
  doctorState.sentinelLoading = true;
  doctorState.sentinelError = '';
  repaintSentinel();
  try {
    const d = await api('/api/doctor/cache-sentinel', {
      method: 'POST',
      body: JSON.stringify({ limit: 16 }),
      timeoutMs: 30000
    });
    if (d.ok && d.sentinel) {
      doctorState.sentinel = d.sentinel;
      doctorState.sentinelText = String(d.text || '');
      doctorState.sentinelVerdict = '';          // 数据变了，旧结论作废
      doctorState.sentinelVerdictParsed = null;
    } else {
      doctorState.sentinelError = d.error || '取数失败';
    }
  } catch (e) {
    doctorState.sentinelError = `请求失败：${e?.message || e}`;
  } finally {
    doctorState.sentinelLoading = false;
    repaintSentinel();
  }
}

/**
 * 把量表交给模型解读。
 *
 * 提问方式很重要：直接把原始数据丢过去，模型会复述数据；
 * 要它"只回答判断"，输出才会短而有用（也省钱）。
 */
async function analyzeSentinel() {
  if (doctorState.sentinelAnalyzing) return;
  if (!doctorState.sentinel) { await runSentinel(); }
  if (!doctorState.sentinel) return;
  doctorState.sentinelAnalyzing = true;
  doctorState.sentinelVerdict = '';
  repaintSentinel();
  // 快照走 context 字段，不塞进 question：
  // question 有 2000 字上限（给"人手打字提问"设的防呆），而整份快照
  // 两三千字起步，塞进去会被后端直接打回，表现就是点了没反应。
  // 数据在前、指令在后，模型对末尾指令更敏感。
  const question = [
    '上面是刚采集的前缀缓存哨兵数据（最近几轮的命中/未命中/输出、跨轮击穿归因、静态前缀体检、模块清单）。',
    '',
    '请严格按下面四个小标题回答，**每个标题独占一行、直接用【】包住**，不要用 markdown 列表，不要复述数据、不要贴代码：',
    '',
    '【问题】哪里不对、成因是什么。归因里如果写"系统提示一字未动"，就明确说',
    '"未命中全部来自尾部滚动，不是插件"，不要再把嫌疑推给插件。',
    '如果确实没问题，就写"没有发现会击穿前缀的问题"。',
    '',
    '【方案】具体改哪个文件里的什么逻辑、怎么改。没有问题就写"不需要改动"。',
    '',
    '【收益】改完能省多少（token / 命中率 / 每天多少钱，给数量级），以及其他好处。',
    '',
    '【代价】改动带来的风险、副作用、回滚成本、可能误伤的其它功能。没有就写"无明显代价"。',
    '',
    '每个小标题下不超过 80 字。宁可短，不要凑字数。'
  ].join('\n');

  // 上下文超过后端限额（12000）时保头保尾地截断：头部是总量与趋势、
  // 尾部是归因与边界说明，中间那段逐轮明细信息密度最低。
  // 直接 slice(0, N) 会把归因砍掉，那正是模型最需要的那段。
  let contextText = String(doctorState.sentinelText || '');
  if (contextText.length > 11000) {
    const cut = contextText.length - 11000;
    contextText = `${contextText.slice(0, 6000)}\n\n…（中间省略 ${cut} 字的逐轮明细，完整数据见界面量表）…\n\n${contextText.slice(-5000)}`;
  }

  try {
    const d = await api('/api/doctor/ask', {
      method: 'POST',
      body: JSON.stringify({ question, context: contextText }),
      timeoutMs: 200000
    });
    doctorState.sentinelVerdict = d.ok && d.answer
      ? String(d.answer)
      : `⚠️ ${d.error || '没有得到回答'}`;
    // 解析成四段（问题 / 方案 / 收益 / 代价）。解析失败不报错，
    // UI 会退回整段展示，送去修复时也退回用归因生成的描述。
    doctorState.sentinelVerdictParsed = parseVerdict(doctorState.sentinelVerdict);
  } catch (e) {
    doctorState.sentinelVerdict = `⚠️ 请求失败：${e?.message || e}`;
    doctorState.sentinelVerdictParsed = null;
  } finally {
    doctorState.sentinelAnalyzing = false;
    repaintSentinel();
  }
}

// ── 解读结果的结构化解析 ─────────────────────────────────────────────────
//
// 解析而不是直接显示整段：模型的自由文本会把"问题/方案/收益/代价"揉成一段，
// 拆成四块并排摆，收益与代价左右对照，判断成本更低。
//
// 容错优先于精确：模型可能用【问题】、## 问题、**问题**、问题：四种写法，
// 都会认；一段都认不出来就返回 structured=false，交给 UI 退回原文展示，
// 不能因为格式没守就把结论整段丢掉。
const VERDICT_LABELS = {
  问题: 'problem', 问题是什么: 'problem', 症结: 'problem',
  方案: 'plan', 要做什么: 'plan', 改动: 'plan', 修复方案: 'plan',
  收益: 'benefit', 好处: 'benefit',
  代价: 'cost', 坏处: 'cost', 风险: 'cost', 副作用: 'cost'
};

function parseVerdict(text) {
  const raw = String(text || '').trim();
  const out = { problem: '', plan: '', benefit: '', cost: '', raw, structured: false };
  if (!raw) return out;

  // 四种标题写法一次认全。【】最优先（提示词要求的就是它）
  const headRe = /(?:^|\n)[ \t]*(?:【\s*([^】\n]{1,12})\s*】|#{1,4}[ \t]*([^\n]{1,16})|\*\*[ \t]*([^*\n]{1,12})[ \t]*\*\*|([^\n：:【】*#]{1,12})[ \t]*[：:])/g;
  const marks = [];
  let m;
  while ((m = headRe.exec(raw))) {
    const label = String(m[1] || m[2] || m[3] || m[4] || '').trim();
    const key = VERDICT_LABELS[label];
    if (!key) continue;
    marks.push({ key, start: m.index, contentStart: m.index + m[0].length });
  }
  if (marks.length < 2) return out;   // 只认出一段，认为是没按格式，退回原文

  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
    const body = raw.slice(marks[i].contentStart, end)
      .replace(/^[ \t]*[：:]\s*/, '')
      .trim();
    if (!out[marks[i].key]) out[marks[i].key] = body;
  }
  // 至少有"问题"和"方案"才算结构化成功；只有收益/代价没法动手
  out.structured = Boolean(out.problem && out.plan);
  return out;
}

function bindSentinelEvents() {
  $('#sentinel-load-btn')?.addEventListener('click', () => runSentinel());
  $('#sentinel-analyze-btn')?.addEventListener('click', () => analyzeSentinel());
  $('#sentinel-fix-btn')?.addEventListener('click', () => sendSentinelToFix());
}

/**
 * 把哨兵的诊断结论送进「自动修复」。
 *
 * 带上三样东西：
 *   · 问题  从归因结果结构化生成，不是把界面文字抄一遍
 *           （模型需要"哪个模块、哪一段、断点在哪"才能直接定位）
 *   · 结论  刚才模型的解读原文，作为修复依据
 *   · 来源  seed.source 标 'sentinel'，修复页的来源行才不会写成"对话审查的提问"
 *
 * 只填空、只跳转，不自动生成提案：生成提案要花一次模型调用，
 * 该由用户在修复页看清楚问题描述后再点。
 */
function sendSentinelToFix() {
  const verdict = doctorState.sentinelVerdict;
  if (!verdict || verdict.startsWith('⚠️')) return;
  const p = doctorState.sentinelVerdictParsed;
  const digest = attributionDigest(doctorState.sentinel);

  let question;
  let answer;
  if (p?.structured) {
    // 结构化回答优先：模型的"问题"更贴近根因，"方案"是它自己给的动手方向。
    // 但量化数字仍要补进去：模型常只说"反复翻字"，不说"断在第几字节、
    // 花了多少 token"，而后者才是判断改动是否值得的依据。
    question = digest ? `${p.problem}\n\n（量化：${digest}）` : p.problem;
    answer = [
      `方案：${p.plan || '（模型未给出具体方案）'}`,
      `收益：${p.benefit || '（未量化）'}`,
      // 代价必须显式写进去：修复模型看见"代价"才会避免用大改动换小收益
      `代价：${p.cost || '（未评估 —— 动手前请自行判断风险与回滚成本）'}`
    ].join('\n');
  } else {
    // 模型没按格式回答：退回用归因生成的问题描述 + 原文当依据
    question = buildSentinelFixQuestion(doctorState.sentinel);
    answer = verdict;
  }

  const f = doctorState.fix;
  f.seed = { question, answer, source: 'sentinel', at: Date.now() };
  f.question = question;
  f.answer = answer;
  // 清掉上一次修复的残留，否则会带着上一条工单的目标文件/详情进新问题
  f.selected = '';
  f.detail = null;
  f.error = '';
  f.targetFile = '';
  f.targetLine = '';
  f.note = '';
  switchDoctorSub('fix');
}

/** 把归因压成一行量化摘要（不含结论，只讲事实）。 */
function attributionDigest(sentinel) {
  const a = sentinel?.attribution;
  if (!a?.breaks?.length) return '';
  const mods = (a.byModule || [])
    .map((m) => `${m.module || m.title} ${m.count} 次、累计 ${m.miss.toLocaleString()} tok`)
    .join('；');
  const latest = a.breaks[a.breaks.length - 1];
  const when = latest.at ? new Date(latest.at).toLocaleString('zh-CN', { hour12: false }) : '时间未知';
  return `${mods}；最近一次 ${when} 断在 systemPrompt 第 ${latest.atChar}/${latest.totalChars} 字符（「${latest.title}」段），该轮 miss ${latest.miss.toLocaleString()} tok`;
}

/** 把归因结果写成"人能看懂、模型能直接下手"的问题描述。 */
function buildSentinelFixQuestion(sentinel) {
  const t = sentinel?.rounds?.totals || {};
  const a = sentinel?.attribution || {};
  const breaks = Array.isArray(a.breaks) ? a.breaks : [];
  const rate = t.rate != null ? (t.rate * 100).toFixed(1) : '?';

  if (!breaks.length) {
    // 没有击穿也要如实写：让模型知道"没有要修的插件"，别硬编一个改动出来。
    return `前缀缓存命中率 ${rate}%（最近 ${t.rounds || 0} 轮），未命中 ${Number(t.miss || 0).toLocaleString()} tok。`
      + `跨轮归因显示：系统提示在观察窗口内一字未动，没有插件造成击穿，未命中全部来自尾部滚动（历史块 + 本次唤醒）。`
      + `请判断尾部成本还有没有可压缩余量；如果没有，直接说没有，不要为了凑一个改动而改代码。`;
  }

  const mods = (a.byModule || [])
    .map((m) => `${m.module || m.title}（${m.count} 次，累计 ${m.miss.toLocaleString()} tok）`)
    .join('；');
  const latest = breaks[breaks.length - 1];
  const when = latest.at ? new Date(latest.at).toLocaleString('zh-CN', { hour12: false }) : '（时间未知）';
  return `前缀缓存被击穿：${mods}。整体命中率 ${rate}%。`
    + `\n最近一次：${when}，「${latest.title}」段（由 ${latest.module || '未识别来源'} 提供）`
    + `在 systemPrompt 第 ${latest.atChar}/${latest.totalChars} 字符处发生变化，`
    + `导致其后整条前缀（含全部历史块）重算，该轮 miss ${latest.miss.toLocaleString()} tok。`
    + `\n定位这一段的内容生成逻辑（promptSections 或 manifest.prompt.sections），`
    + `改为内容稳定，或加节流/滞回/状态滞回，避免运行时量（库存、计数、时间）直接落进稳定区。`;
}

/**
 * 全项目扫描区（标题 + 本区专属按钮 + 结果）。
 * 凡是"只重画项目区"的地方都必须用这个函数，不能硬拼标题 + renderDoctorProject()，
 * 那样会把模块操作条（扫描项目 / 让模型自检两个按钮）一起冲掉，
 * 按钮消失且事件绑定丢失。
 */
function renderProjectSection() {
  // 「扫描项目 / 让模型自检」是本模块专属的操作，不放在顶部公共区，
  // 顶部只留"模型设置 / 重新扫描"这类共用按钮。
  const busy = doctorState.scanning || doctorState.triaging;
  return `
    <div class="doctor-module-bar">
      <div class="doctor-chat-head" style="margin:0">全项目扫描</div>
      <button class="btn btn-small" id="doctor-scan-btn"${busy ? ' disabled' : ''}>${doctorState.scanning ? '扫描中…' : '扫描项目'}</button>
      <button class="btn btn-primary btn-small" id="doctor-triage-top-btn"${busy ? ' disabled' : ''}>${doctorState.triaging ? '审阅中…' : '让模型自检'}</button>
    </div>
    ${renderDoctorProject()}`;
}

/** 子模块二：对话审查，自由问答 + 取证轨迹。 */
function renderChatModule() {
  return `
    <div class="doctor-chat-wrap">
      <div class="doctor-chat-log" id="doctor-chat-log">${renderDoctorTurns()}</div>
      <div class="doctor-chat-input">
        <textarea id="doctor-q" rows="2" placeholder="描述你遇到的问题 —— 模型会自己去读源码和日志来查证…"></textarea>
        <button class="btn btn-primary btn-small" id="doctor-send-btn"${doctorState.asking ? ' disabled' : ''}>${doctorState.asking ? '分析中…' : '发送'}</button>
      </div>
    </div>`;
}

function bindCheckupEvents(box) {
  $('#doctor-scan-btn')?.addEventListener('click', async () => {
    // 代码检查对普通用户没有意义，点下去先拦一道确认。
    // 确认放在点击处、不放 runProjectScan 里，后者还被 runTriage 的
    // autoScan 链路复用，顶栏「让模型自检」一键链路不该被弹窗打断。
    if (!(await qaConfirm('这是给会写代码的人看的代码检查，普通用户不用扫。确定继续？'))) return;
    runProjectScan();
  });
  // 「让模型自检」在自检模块内（它审的是本模块扫出来的候选，放这里最顺手）
  $('#doctor-triage-top-btn')?.addEventListener('click', () => runTriage({ autoScan: true }));
  // 规则过滤：只重绘项目区（不重建整页，避免滚动位置丢失）。
  // 用 renderProjectSection() 而不是硬拼标题，否则操作条会被冲掉（见该函数注释）。
  $('#doctor-proj-filter')?.addEventListener('change', (e) => {
    doctorState.projectRule = e.target.value || '';
    const wrap = $('#harness-page')?.querySelector('.doctor-proj-wrap');
    if (wrap) {
      wrap.innerHTML = renderProjectSection();
      bindProjectEvents();
      syncTriageTopButton();
    }
  });
}

function bindChatEvents(box) {
  const send = () => askDoctor();
  $('#doctor-send-btn')?.addEventListener('click', send);

  const ta = $('#doctor-q');
  ta?.addEventListener('keydown', (e) => {
    // Enter 发送、Shift+Enter 换行（聊天软件的肌肉记忆）
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // 示例问题变成动作
  $$('[data-doctor-ask]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const q = el.getAttribute('data-doctor-ask') || '';
      const box2 = $('#doctor-q');
      if (box2) box2.value = q;
      askDoctor();
    });
  });

  // 把某条结论直接送进「自动修复」：带上"这一问 + 这一答"作为修复依据。
  // 不自动开始跑模型，只把上下文搬过去，让用户在修复页确认后再点「生成提案」。
  $$('[data-fix-from]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const i = Number(el.getAttribute('data-fix-from'));
      const ans = doctorState.turns[i];
      if (!ans || ans.role !== 'assistant') return;
      let q = '';
      for (let k = i - 1; k >= 0; k--) {
        if (doctorState.turns[k].role === 'user') { q = doctorState.turns[k].text || ''; break; }
      }
      const f = doctorState.fix;
      f.seed = { question: q, answer: ans.text || '' };
      f.question = q;
      f.answer = ans.text || '';
      f.selected = '';
      f.detail = null;
      f.error = '';
      // switchDoctorSub 在"已经停在 fix"时会早退，所以要自己判断一次，
      // 否则重复拉取（并且会闪一下旧列表）。
      const wasFix = doctorState.sub === 'fix';
      switchDoctorSub('fix');
      if (wasFix) refreshInBackground(() => loadFixList({ force: true }), '', '修复工单列表（强制刷新）');
    });
  });

  scrollDoctorChatToBottom();
}

// ── 子模块 2.5：自动修复（self-fix）────────────────────────────────────────
//
// 本模块会改动软件代码，仅供进阶用户；普通用户遇到问题请用「对话审查」或找群管。
//
// 这一页的核心不是"让模型改代码"，而是两道人工闸：
//
//   闸①  proposed 状态：模型只产出一份提案（改哪个文件、怎么改、风险、怎么验），
//        界面上你点「批准并应用」才继续。这个动作会把一次性 approvalToken 回传后端，
//        后端校验令牌不匹配就什么都不做。所以"批准"不是界面装饰，是代码层的门。
//
//   闸②  verified 状态：改动已在沙箱里真跑过。页面展示原始产物
//        （stdout / 用例级结果 / 冒烟输出），不是模型的自述，因为模型有"报喜不报忧"
//        的倾向，闸②的价值就是让你绕过它的转述直接看事实。
//        你的四个动作：通过（落地）/ 重跑（同版本再跑，限次）/ 再改一句 / 丢弃。
//
// "重跑"要限次：真跑有抖动是事实，但不限次就会退化成"刷到通过为止"，
// 那等于把闸②废掉。所以 backend 侧硬限 maxReruns，并把已重跑次数显示出来。

const FIX_STATUS = {
  proposed: { label: '待批准', icon: '①', cls: 'is-proposed', hint: '模型已给出提案。批准前它一个字节都没写。' },
  applied: { label: '已入暂存区', icon: '②', cls: 'is-applied', hint: '改动只在暂存副本里，真实文件没动。' },
  verifying: { label: '自验中', icon: '③', cls: 'is-verifying', hint: '正在沙箱里跑验证器。' },
  verified: { label: '待决断', icon: '④', cls: 'is-verified', hint: '沙箱跑完了。看产物，决定通过还是重跑。' },
  committed: { label: '已落地', icon: '✓', cls: 'is-committed', hint: '已写进真实文件，快照已留，可回滚。' },
  discarded: { label: '已丢弃', icon: '×', cls: 'is-discarded', hint: '已放弃（理由已记录）。' },
  failed: { label: '未通过', icon: '!', cls: 'is-failed', hint: '协议闸或验证器没通过。可让模型按失败明细再改。' },
  'rolled-back': { label: '已回滚', icon: '↺', cls: 'is-rolled', hint: '已按快照还原。' }
};

const FIX_LEVEL_META = {
  L0: { label: 'L0 元部件', cls: 'is-l0', tip: '闸门/审计/加载器本体 —— 禁止模型修改' },
  L1: { label: 'L1 核心', cls: 'is-l1', tip: 'src/ui/electron —— 改动落地后需重启生效' },
  L2: { label: 'L2 扩展', cls: 'is-l2', tip: 'plugins/skills —— 会被热重载' },
  L3: { label: 'L3 配置', cls: 'is-l3', tip: '配置文件' },
  L4: { label: 'L4 本模块数据', cls: 'is-l4', tip: '自动修复自己的审计数据' }
};

function fixStatusMeta(s) { return FIX_STATUS[s] || { label: s || '?', icon: '·', cls: 'is-unknown', hint: '' }; }

// ── 页面骨架 ──────────────────────────────────────────────────────────────

function renderFixModule() {
  const f = doctorState.fix;

  if (f.available === false) {
    // 空态标题（.empty-hint 自带 text-align:center）居中，下面的说明文字与按钮
    // 也要跟着居中，否则同一块里两种对齐看着像没排好。不新增类。
    return `<div class="empty-hint">「自动修复」模块当前不可用。</div>
      <div class="hint" style="margin-top:10px;text-align:center">
        它现在是<b>软件自带功能</b>（内置工具链，不再走插件列表）。<br />
        正常情况下随启动自动注册；如果这里一直显示未启用，点「重新检测」或重启应用。<br />
        它<b>默认关闭</b>是有意的：这是「自检」里唯一会<b>真的改你文件</b>的模块。
      </div>
      <div style="display:flex;gap:8px;margin:12px auto 0;justify-content:center">
        <button class="btn btn-small" id="fix-retry-btn">重新检测</button>
      </div>`;
  }
  if (f.available === null) {
    return `<div class="sk-block">${'<div class="sk-row"></div>'.repeat(5)}</div>
      <div class="hint" style="margin-top:10px">${f.loading ? '正在读取自动修复状态…' : '正在探测「自动修复」插件…'}</div>`;
  }
  if (!f.enabled) {
    // self-fix 内置化后已从插件列表消失（kind='core' 不再出现在「下载 → 已安装」），
    // 老文案指的路不存在了，用户会卡在"开关够不着"。开关
    // （config.skills['self-fix'].fixEnabled）直接在本页给一个开启按钮，
    // 走 POST /api/config 即时生效（cfg() 每次读活配置，无需重启）。
    return `<div class="empty-hint"><b>自动修复开关是关的</b>。</div>
      <div class="hint" style="margin-top:10px;text-align:center">
        这是刻意的第一道闸：关着的时候，「对话审查」保持纯只读，这个模块的所有写能力都不可达。<br />
        它现在是<b>软件自带功能</b>（不再走插件列表），直接点下面的按钮开启即可。打开后仍然有两道人工闸拦着。
      </div>
      <div style="display:flex;gap:8px;margin:12px auto 0;justify-content:center">
        <button class="btn btn-small btn-primary" id="fix-switch-btn">开启自动修复</button>
        <button class="btn btn-small" id="fix-retry-btn">已开启，重新检测</button>
      </div>`;
  }

  return `
    ${renderFixStats()}
    ${f.error ? `<div class="fix-err">⚠️ ${esc(f.error)}</div>` : ''}
    ${f.rerunHint ? `<div class="fix-note is-warn">${esc(f.rerunHint)}</div>` : ''}
    <div class="fix-grid">
      <div class="fix-col-list">${renderFixCreate()}${renderFixList()}</div>
      <div class="fix-col-detail">${renderFixDetail()}</div>
    </div>`;
}

function renderFixStats() {
  const f = doctorState.fix;
  const by = f.counts?.byStatus || {};
  const chips = [
    ['proposed', by.proposed || 0], ['verified', by.verified || 0], ['committed', by.committed || 0],
    ['discarded', by.discarded || 0], ['failed', by.failed || 0]
  ].map(([k, n]) => `<span class="fix-chip ${fixStatusMeta(k).cls}">${fixStatusMeta(k).label} ${n}</span>`).join('');
  const scope = f.allowCoreFiles
    ? '<span class="fix-scope is-warn">可改核心（src/ui/electron）—— 落地后需重启生效</span>'
    : '<span class="fix-scope">仅可改 plugins/ 与 skills/（核心默认关闭）</span>';
  return `
    <div class="fix-stats">
      <div class="fix-stats-l">
        <div class="doctor-chat-head" style="margin:0">修复工单</div>${chips}
      </div>
      <div class="fix-stats-r">
        ${scope}
        <button class="btn btn-small" id="fix-refresh-btn"${f.loading ? ' disabled' : ''}>${f.loading ? '读取中…' : '刷新'}</button>
      </div>
    </div>`;
}

/** 新建修复：从对话审查的问题/结论出发（也可以手写）。 */
function renderFixCreate() {
  const f = doctorState.fix;
  const seed = f.seed;
  // 来源行必须跟着 seed.source 走：照抄成"对话审查的提问"会让用户
  // 找不到这次是从哨兵那边过来的（两条动线共用同一张表单）。
  const srcLabel = seed?.source === 'sentinel' ? '前缀缓存哨兵的诊断结论' : '对话审查的提问';
  return `
    <div class="fix-card">
      <div class="fix-card-h">＋ 新建修复</div>
      ${seed ? `<div class="fix-seed">来源：${srcLabel} —— <b>${esc(String(seed.question || '').slice(0, 80))}</b>
        <button class="btn btn-mini" id="fix-seed-clear-btn">清除</button></div>` : ''}
      <label class="fix-lbl">问题</label>
      <textarea id="fix-q" rows="3" placeholder="要修的问题（从「对话审查」或「哨兵 → 送去修复」带过来）">${esc(f.question)}</textarea>
      <label class="fix-lbl">诊断结论（模型修复的依据）</label>
      <textarea id="fix-a" rows="4" placeholder="诊断结论。留空的话模型只能靠问题描述和源码自己定位，命中率会低很多">${esc(f.answer)}</textarea>
      <div class="fix-row">
        <input id="fix-tf" class="fix-input" placeholder="目标文件（可选，如 plugins/xxx/index.js）" value="${esc(f.targetFile)}" />
        <input id="fix-tl" class="fix-input fix-input-num" placeholder="行号" value="${esc(f.targetLine)}" />
      </div>
      <button class="btn btn-primary btn-small" id="fix-propose-btn"${f.proposing ? ' disabled' : ''}>
        ${f.proposing ? '模型正在写提案…' : '生成修复提案（不写盘）'}</button>
      <div class="fix-note">提案只描述「改什么、怎么改、风险、怎么验」。<b>这一步不写任何文件</b>。</div>
    </div>`;
}

function renderFixList() {
  const f = doctorState.fix;
  if (f.loading && !f.records.length) return `<div class="fix-card"><div class="hint">正在读取工单…</div></div>`;
  if (!f.records.length) return `<div class="fix-card"><div class="empty-hint" style="padding:10px">还没有修复工单。</div></div>`;
  return `<div class="fix-list">${f.records.map((r) => {
    const m = fixStatusMeta(r.status);
    const on = f.selected === r.id;
    return `<div class="fix-item${on ? ' is-on' : ''}" data-fix-open="${esc(r.id)}">
      <div class="fix-item-top">
        <span class="fix-badge ${m.cls}">${m.icon} ${m.label}</span>
        <span class="fix-item-id">${esc(r.id)}</span>
      </div>
      <div class="fix-item-title">${esc(String(r.rootCause || r.question || '（无描述）').slice(0, 70))}</div>
      <div class="fix-item-meta">${esc((r.paths || []).join('、').slice(0, 80) || '（无文件改动）')}
        ${r.blocking ? `<span class="fix-flag is-block">阻断 ${r.blocking}</span>` : ''}
        ${r.warn ? `<span class="fix-flag is-warn">告警 ${r.warn}</span>` : ''}
        ${r.reruns ? `<span class="fix-flag is-warn">重跑 ${r.reruns}</span>` : ''}
        ${r.noChange ? '<span class="fix-flag is-plain">无需改动</span>' : ''}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function renderFixDetail() {
  const f = doctorState.fix;
  if (!f.selected) return `<div class="fix-card fix-detail-empty"><div class="empty-hint">左边选一个工单看详情。</div></div>`;
  if (!f.detail?.ok) return `<div class="fix-card"><div class="empty-hint">${esc(f.detail?.error || '读取中…')}</div></div>`;

  const rec = f.detail.record;
  const m = fixStatusMeta(rec.status);
  return `
    <div class="fix-card fix-detail">
      <div class="fix-card-h">
        <span class="fix-badge ${m.cls}">${m.icon} ${m.label}</span>
        <span class="fix-item-id">${esc(rec.id)}</span>
        <span class="fix-detail-time">${escapeFixTime(rec.createdAt)}</span>
      </div>
      <div class="hint" style="margin:0 0 10px">${m.hint}</div>
      ${renderFixTarget(rec)}
      ${renderFixProposal(rec)}
      ${renderFixProtocol(rec)}
      ${renderFixVerify(f.detail)}
      ${renderFixActions(rec, f.detail)}
      ${renderFixAudit(rec, f.detail)}
    </div>`;
}

function renderFixTarget(rec) {
  return `<div class="fix-sec">
    <div class="fix-sec-h">目标问题</div>
    <div class="fix-kv"><span>位置</span><code>${esc(rec.target?.file || '—')}${rec.target?.line ? ':' + rec.target.line : ''}</code></div>
    ${rec.target?.ruleId ? `<div class="fix-kv"><span>规则</span><code>${esc(rec.target.ruleId)}</code></div>` : ''}
    ${rec.question ? `<div class="fix-kv"><span>提问</span><div>${esc(rec.question)}</div></div>` : ''}
    ${rec.proposal?.rootCause ? `<div class="fix-kv"><span>根因</span><div>${esc(rec.proposal.rootCause)}</div></div>` : ''}
    ${rec.proposal?.expectedEffect ? `<div class="fix-kv"><span>预期效果</span><div>${esc(rec.proposal.expectedEffect)}</div></div>` : ''}
    ${rec.proposal?.rollback ? `<div class="fix-kv"><span>回滚方式</span><div>${esc(rec.proposal.rollback)}</div></div>` : ''}
    ${(rec.proposal?.residualRisk || []).length ? `<div class="fix-kv"><span>残余风险</span><div>${rec.proposal.residualRisk.map((x) => `<div>· ${esc(x)}</div>`).join('')}</div></div>` : ''}
    ${(rec.proposal?.unverifiable || []).length ? `<div class="fix-kv"><span class="is-warn">无法自验</span><div class="is-warn">${rec.proposal.unverifiable.map((x) => `<div>· ${esc(x)}</div>`).join('')}</div></div>` : ''}
  </div>`;
}

/** 闸① 的提案卡：改动清单 + diff + 验证计划 + 批准/驳回。 */
function renderFixProposal(rec) {
  const f = doctorState.fix;
  const preview = f.detail?.preview || [];
  const plan = rec.proposal?.verifyPlan || [];
  const isProposed = rec.status === 'proposed';
  // 无改动提案（模型判定"配置/使用问题、无需改代码"）：闸① 的按钮组必须分流，
  // 「批准并应用」对它是必然失败的（后端按设计拒绝空应用）。
  const noChange = rec.noChange === true || !(rec.proposal?.changes || []).length;
  const vById = new Map((f.verifiers || []).map((v) => [v.id, v]));

  const changes = preview.length
    ? preview.map((p, i) => {
      const lv = FIX_LEVEL_META[p.level] || FIX_LEVEL_META.L1;
      return `<details class="fix-diff"${i === 0 ? ' open' : ''}>
        <summary>
          <span class="fix-lvl ${lv.cls}" title="${esc(lv.tip)}">${esc(lv.label)}</span>
          <code>${esc(p.scope === 'data' ? 'data:' : '')}${esc(p.path)}</code>
          <span class="fix-diff-stat">+${p.stat?.added ?? 0} / -${p.stat?.removed ?? 0}</span>
        </summary>
        <div class="fix-diff-body">
          ${p.intent ? `<div class="fix-intent">意图：${esc(p.intent)}</div>` : ''}
          <pre class="fix-code">${(p.lines || []).map((l) => {
            const cls = l.t === '+' ? 'is-add' : (l.t === '-' ? 'is-del' : '');
            return `<span class="${cls}">${esc(l.t)}${String(l.n).padStart(5)} | ${esc(l.s)}</span>`;
          }).join('\n')}</pre>
        </div>
      </details>`;
    }).join('')
    : '<div class="hint">本次提案没有改动任何文件（可能是配置/使用问题，而不是代码问题）。</div>';

  return `<div class="fix-sec">
    <div class="fix-sec-h">提案（闸①：你批准前，一个字节都没写）</div>
    ${changes}
    <div class="fix-row" style="margin-top:10px">
      <span class="fix-lbl-inline">验证计划</span>
      ${plan.length ? plan.map((p) => {
        const v = vById.get(p.verifier);
        return `<span class="fix-plan${v?.hard ? ' is-hard' : ''}">${esc(v?.label || p.verifier)}${p.file ? ` · ${esc(p.file)}` : ''}</span>`;
      }).join('') : '<span class="hint">（空 —— 协议闸会拦）</span>'}
    </div>
    ${isProposed ? `
      <label class="fix-lbl">补充要求（可选，驳回时写清"哪里不对"，模型会照着重提）</label>
      <textarea id="fix-note" rows="2" placeholder="例如：不要动这个函数的签名 / 只改第 3 个分支 / 加注释说明为什么">${esc(f.note)}</textarea>
      ${noChange ? `
      <div class="fix-note">这条提案判定为<b>无需代码改动</b>（可能是配置/使用问题）——「批准并应用」对它不适用；点「知道了（归档）」可直接结单，或补充要求后重提。</div>
      <div class="fix-actions">
        <button class="btn btn-primary btn-small" id="fix-archive-btn"${f.busy ? ' disabled' : ''}>
          ${f.busy === 'discard' ? '归档中…' : '知道了（归档）'}</button>
        <button class="btn btn-small" id="fix-repropose-btn"${f.busy ? ' disabled' : ''}>按补充要求重提</button>
        <button class="btn btn-small" id="fix-discard-top-btn"${f.busy ? ' disabled' : ''}>驳回并丢弃</button>
      </div>` : `
      <div class="fix-actions">
        <button class="btn btn-primary btn-small" id="fix-approve-btn"${f.busy ? ' disabled' : ''}>
          ${f.busy === 'apply' ? '写入暂存区…' : '批准并应用（写暂存区）'}</button>
        <button class="btn btn-small" id="fix-repropose-btn"${f.busy ? ' disabled' : ''}>按补充要求重提</button>
        <button class="btn btn-small" id="fix-discard-top-btn"${f.busy ? ' disabled' : ''}>驳回并丢弃</button>
      </div>`}
      <label class="fix-lbl">驳回理由（点「驳回并丢弃」时必填，会落盘；「知道了（归档）」不需要）</label>
      <textarea id="fix-discard-reason" rows="2" placeholder="例如：诊断方向不对 / 这不是要修的问题">${esc(f.discardReason)}</textarea>` : ''}
  </div>`;
}

/** 协议闸结论：命中项分级展示（block 红、warn 黄、info 灰）。 */
function renderFixProtocol(rec) {
  const p = rec.protocol;
  if (!p) return '';
  const vs = p.violations || [];
  const blocks = vs.filter((v) => v.level === 'block');
  const warns = vs.filter((v) => v.level === 'warn');
  const infos = vs.filter((v) => v.level === 'info');
  const head = p.passed
    ? `<span class="fix-ok">协议闸通过</span>${warns.length ? `<span class="fix-flag is-warn">告警 ${warns.length}</span>` : ''}`
    : `<span class="fix-flag is-block">协议闸阻断 ${blocks.length} 项</span>`;
  const list = (arr, cls) => arr.map((v) => `<div class="fix-viol ${cls}">
      <b>${esc(v.code)}</b> ${esc(v.title)}${v.detail ? `<div class="fix-viol-d">${esc(v.detail)}</div>` : ''}
    </div>`).join('');
  return `<div class="fix-sec">
    <div class="fix-sec-h">协议闸 / 五道闸门 ${head}</div>
    ${blocks.length ? list(blocks, 'is-block') : ''}
    ${warns.length ? list(warns, 'is-warn') : ''}
    ${infos.length ? list(infos, 'is-info') : ''}
    ${!vs.length ? '<div class="hint">没有命中任何条款。</div>' : ''}
  </div>`;
}

/** 自验结果 + **原始产物**（闸② 的核心：让人绕过模型转述直接看事实）。 */
function renderFixVerify(detail) {
  const rounds = detail?.verify?.rounds || [];
  if (!rounds.length) return '';
  const last = rounds[rounds.length - 1];
  const v = last.verify || {};
  const items = v.items || [];
  const rows = items.map((i, idx) => {
    const cls = i.status === 'pass' ? 'is-pass' : (i.status === 'fail' ? 'is-fail' : 'is-skip');
    const raw = (i.stdout || '') + (i.stderr ? '\n--- stderr ---\n' + i.stderr : '');
    return `<details class="fix-vitem ${cls}">
      <summary>
        <span class="fix-vstatus">${i.status === 'pass' ? '通过' : (i.status === 'fail' ? '失败' : '跳过')}</span>
        <span class="fix-vname">${esc(i.label || i.verifier)}${i.hard ? ' *' : ''}</span>
        <span class="fix-vfile">${esc(i.file || '')}</span>
      </summary>
      <div class="fix-vbody">
        <div class="fix-vdetail">${esc(i.detail || '')}</div>
        ${raw.trim() ? `<pre class="fix-code fix-raw" id="fix-raw-${idx}">${esc(raw.slice(-6000))}</pre>` : ''}
      </div>
    </details>`;
  }).join('');

  return `<div class="fix-sec">
    <div class="fix-sec-h">
      沙箱自验（第 ${rounds.length} 轮）
      <span class="fix-flag ${v.passed ? 'is-ok' : 'is-block'}">${v.passed ? '全部通过' : `失败 ${v.failCount} 项`}</span>
      ${v.hardSkipped ? '<span class="fix-flag is-warn">有硬性验证项未能运行（不等于通过）</span>' : ''}
      ${last.sameAsPrev ? '<span class="fix-flag is-warn">与上轮失败项相同 → 已触发收敛保护</span>' : ''}
    </div>
    <div class="fix-raw-note">下面是验证器的 <b>原始产物</b>（不是你看到的摘要）。模型有"报喜不报忧"的倾向，
      所以闸② 请以这里为准。</div>
    ${rows || '<div class="hint">本轮没有验证项。</div>'}
    ${rounds.length > 1 ? `<details class="fix-rounds"><summary>历史轮次（${rounds.length - 1} 轮）</summary>
      ${rounds.slice(0, -1).map((r) => {
        const rv = r.verify || {};
        return `<div class="fix-round">第 ${r.n} 轮：${rv.passed ? '通过' : `失败 ${rv.failCount} 项`} <code>${esc((rv.failureKey || '').slice(0, 120))}</code></div>`;
      }).join('')}
    </details>` : ''}
  </div>`;
}

/** 闸② 的动作区 + 已落地的回滚。 */
function renderFixActions(rec, detail) {
  const f = doctorState.fix;
  const st = rec.status;
  const maxRerun = f.limits?.maxReruns ?? 3;
  const reruns = rec.decision?.reruns || 0;

  if (rec.snapshot?.phase === 'writing') {
    return `<div class="fix-sec">
      <div class="fix-sec-h">提交中断，可回滚或重试</div>
      <div class="fix-note is-warn">部分文件可能已写入。原始快照已保留，重试会继续完成本次改动。</div>
      <div class="fix-actions">
        <button class="btn btn-primary btn-small" id="fix-commit-btn"${f.busy ? ' disabled' : ''}>${f.busy === 'commit' ? '落地中…' : '重试落地'}</button>
        <button class="btn btn-small" id="fix-rollback-btn"${f.busy ? ' disabled' : ''}>${f.busy === 'rollback' ? '回滚中…' : '回滚到改动前'}</button>
      </div>
    </div>`;
  }

  if (st === 'applied' || st === 'failed') {
    const blocked = (rec.protocol?.violations || []).some((v) => v.level === 'block');
    return `<div class="fix-sec">
      <div class="fix-sec-h">执行</div>
      ${blocked
        ? `<div class="fix-viol is-block">协议闸有<b>阻断项</b>，不能继续。请让模型按上面的阻断原因重提，或丢弃。</div>`
        : '<div class="hint">改动已在暂存区。下一步：在沙箱里跑一遍验证。</div>'}
      <div class="fix-actions">
        <button class="btn btn-primary btn-small" id="fix-verify-btn"${f.busy || blocked ? ' disabled' : ''}>
          ${f.busy === 'verify' ? '沙箱验证中…' : '在沙箱里跑一遍'}</button>
        <button class="btn btn-small" id="fix-repropose-btn"${f.busy ? ' disabled' : ''}>让模型按失败明细再改</button>
        <button class="btn btn-small" id="fix-discard-top-btn"${f.busy ? ' disabled' : ''}>丢弃</button>
      </div>
      <label class="fix-lbl">丢弃理由（点「丢弃」时必填，会落盘）</label>
      <textarea id="fix-discard-reason" rows="2" placeholder="例如：不打算修这个 / 改法方向不对">${esc(f.discardReason)}</textarea>
    </div>`;
  }

  if (st === 'verified') {
    return `<div class="fix-sec">
      <div class="fix-sec-h">闸②：看完沙箱产物，你来决定</div>
      <div class="fix-actions">
        <button class="btn btn-primary btn-small" id="fix-commit-btn"${f.busy ? ' disabled' : ''}>
          ${f.busy === 'commit' ? '落地中…' : '通过并落地（先快照）'}</button>
        <button class="btn btn-small" id="fix-rerun-btn"${f.busy || reruns >= maxRerun ? ' disabled' : ''}>
          ${f.busy === 'rerun' ? '重跑中…' : `重跑一遍（${reruns}/${maxRerun}）`}</button>
        <button class="btn btn-small" id="fix-rework-btn"${f.busy ? ' disabled' : ''}>再改一句</button>
        <button class="btn btn-small" id="fix-discard-top-btn"${f.busy ? ' disabled' : ''}>丢弃</button>
      </div>
      ${reruns >= maxRerun ? `<div class="fix-note is-warn">重跑已达上限 ${maxRerun} 次。真跑有抖动，但不能无限重跑到"通过"为止 —— 请直接看产物决定。</div>` : ''}
      <label class="fix-lbl">"再改一句"或"丢弃"要写清理由（会落盘，是比"采纳"更有信息量的信号）</label>
      <textarea id="fix-discard-reason" rows="2" placeholder="例如：改法太粗暴会误伤同名不同人 / 没解决根因只压了症状">${esc(f.discardReason)}</textarea>
    </div>`;
  }

  if (st === 'committed') {
    const lv = (detail?.record?.snapshot?.files || []).map((x) => FIX_LEVEL_META[x.level]?.label || x.level);
    const core = (detail?.record?.snapshot?.files || []).some((x) => x.level === 'L1');
    return `<div class="fix-sec">
      <div class="fix-sec-h">已落地</div>
      <div class="fix-kv"><span>快照</span><div>${(detail?.record?.snapshot?.files || []).length} 个文件${lv.length ? `（${[...new Set(lv)].join('、')}）` : ''}</div></div>
      ${core ? '<div class="fix-note is-warn">本次改到了核心代码，需要<b>重启</b>才生效。</div>' : ''}
      <div class="fix-actions">
        <button class="btn btn-small" id="fix-rollback-btn"${f.busy ? ' disabled' : ''}>
          ${f.busy === 'rollback' ? '回滚中…' : '回滚到改动前'}</button>
      </div>
    </div>`;
  }

  if (st === 'discarded' || st === 'rolled-back') {
    return `<div class="fix-sec">
      <div class="fix-sec-h">${st === 'discarded' ? '已丢弃' : '已回滚'}</div>
      ${rec.decision?.reason ? `<div class="fix-kv"><span>理由</span><div>${esc(rec.decision.reason)}</div></div>` : ''}
    </div>`;
  }
  return '';
}

/** 审计与导出：删 / 导出 Markdown / 导出 Word（含"先导出再删"的动线）。 */
function renderFixAudit(rec, detail) {
  const f = doctorState.fix;
  return `<div class="fix-sec fix-audit">
    <div class="fix-sec-h">审计与导出</div>
    <div class="hint" style="margin:0 0 8px">
      报告内容：① 问题出在哪 ② 什么 bug 导致的 ③ 修改意见 ④ 容易踩的坑。
      数据来自<b>审计记录 + 日志 + 改动 diff</b>，每条结论都能回溯到具体位置。
    </div>
    <div class="fix-actions">
      <button class="btn btn-small" id="fix-export-md-btn"${f.exporting ? ' disabled' : ''}>导出 Markdown</button>
      <button class="btn btn-primary btn-small" id="fix-export-docx-btn"${f.exporting ? ' disabled' : ''}>
        ${f.exporting ? '生成中…' : '导出 Word（.docx）'}</button>
      <button class="btn btn-small" id="fix-delete-btn"${f.busy ? ' disabled' : ''}>删除这条审计</button>
    </div>
    <div class="fix-note">
      删除默认<b>不删快照</b> —— 快照是回滚的唯一依据，删掉就永久失去回滚能力。
      ${detail?.backupExists ? '本工单<b>有快照</b>，删除时会单独问你。' : ''}
    </div>
  </div>`;
}

function escapeFixTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── 事件绑定 ──────────────────────────────────────────────────────────────

function bindFixEvents(box) {
  const f = doctorState.fix;

  // self-fix 内置化后不再走"插件未启用"态，enablePluginInline 通道对 core 模块无意义，
  // 开关直连走下面的 fix-switch-btn。
  $('#fix-retry-btn')?.addEventListener('click', () => {
    f.available = null;
    refreshInBackground(loadFixList, '', '修复工单列表');
  });
  // 内置化后开关的直接入口：模块启用（/api/skills）与功能总开关
  // （fixEnabled，属于模块设置）是两回事，后者原本只能去插件设置面板改，
  // 而内置模块不再有那个面板，所以这里直连 POST /api/config。
  $('#fix-switch-btn')?.addEventListener('click', async () => {
    const btn = $('#fix-switch-btn');
    const orig = btn.textContent;
    btn.disabled = true;
    btn.textContent = '开启中…';
    try {
      await api('/api/config', {
        method: 'POST',
        body: JSON.stringify({ skills: { 'self-fix': { fixEnabled: true } } })
      });
      f.available = null;
      await loadFixStatus();
      renderDoctorPage();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = orig;
      qaAlert(`开启失败：${e?.message || e}`);
    }
  });
  $('#fix-refresh-btn')?.addEventListener('click', () => {
    refreshInBackground(() => loadFixList({ force: true }), '', '修复工单列表（手动刷新）');
  });

  // 输入即存：重绘（比如切换子页签回来）不会把已输入的内容冲掉
  $('#fix-q')?.addEventListener('input', (e) => { f.question = e.target.value; });
  $('#fix-a')?.addEventListener('input', (e) => { f.answer = e.target.value; });
  $('#fix-tf')?.addEventListener('input', (e) => { f.targetFile = e.target.value; });
  $('#fix-tl')?.addEventListener('input', (e) => { f.targetLine = e.target.value; });
  const note = $('#fix-note');
  note?.addEventListener('input', (e) => { f.note = e.target.value; });
  const dr = $('#fix-discard-reason');
  dr?.addEventListener('input', (e) => { f.discardReason = e.target.value; });

  $('#fix-seed-clear-btn')?.addEventListener('click', () => {
    f.seed = null;
    renderDoctorPage();
  });

  $('#fix-propose-btn')?.addEventListener('click', () => runFixPropose());
  $('#fix-approve-btn')?.addEventListener('click', () => runFixApply());
  $('#fix-archive-btn')?.addEventListener('click', () => runFixArchive());
  $('#fix-repropose-btn')?.addEventListener('click', () => runFixRework());
  $('#fix-verify-btn')?.addEventListener('click', () => runFixVerify());
  $('#fix-rerun-btn')?.addEventListener('click', () => runFixRerun());
  $('#fix-commit-btn')?.addEventListener('click', () => runFixCommit());
  $('#fix-rollback-btn')?.addEventListener('click', () => runFixRollback());
  $('#fix-rework-btn')?.addEventListener('click', () => runFixRework());

  $$('[data-fix-open]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.getAttribute('data-fix-open');
      if (!id) return;
      f.selected = id;
      refreshInBackground(() => loadFixDetail(id), '', '修复工单详情');
    });
  });

  $('#fix-discard-top-btn')?.addEventListener('click', () => runFixDiscard());
  $('#fix-export-md-btn')?.addEventListener('click', () => runFixExport('md'));
  $('#fix-export-docx-btn')?.addEventListener('click', () => runFixExport('docx'));
  $('#fix-delete-btn')?.addEventListener('click', () => runFixDelete());
}

// ── 动作 ──────────────────────────────────────────────────────────────────

async function loadFixStatus() {
  const f = doctorState.fix;
  try {
    const d = await api('/api/fix/status', { timeoutMs: 15000 });
    f.available = d.available !== false;
    f.enabled = !!d.enabled;
    f.allowCoreFiles = !!d.allowCoreFiles;
    f.limits = d.limits || {};
    f.verifiers = Array.isArray(d.verifiers) ? d.verifiers : [];
    f.counts = d.counts || {};
    f.error = d.available === false ? (d.error || '插件未启用') : '';
  } catch (e) {
    f.available = false;
    f.error = e?.message || String(e);
  }
}

async function loadFixList({ force = false } = {}) {
  const f = doctorState.fix;
  if (f.loading && !force) return;
  f.loading = true;
  try {
    await loadFixStatus();
    if (f.available !== false && f.enabled) {
      const d = await api('/api/fix/list?limit=200', { timeoutMs: 20000 });
      f.records = Array.isArray(d.records) ? d.records : [];
      // 选中的工单没了（被删/被清）就退回首条
      if (f.selected && !f.records.some((r) => r.id === f.selected)) f.selected = '';
      if (!f.selected && f.records.length) {
        f.selected = f.records[0].id;
        await loadFixDetail(f.selected);
      }
    } else {
      f.records = [];
      f.selected = '';
      f.detail = null;
    }
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.loading = false;
  }
}

async function loadFixDetail(fixId) {
  const f = doctorState.fix;
  try {
    const d = await api(`/api/fix/detail?fixId=${encodeURIComponent(fixId)}`, { timeoutMs: 20000 });
    f.detail = d;
    // 待批准的工单带一份一次性票据，刷新页面后仍能批准同一份提案（否则它会永远卡在闸①）。
    if (d?.approvalTicket) f.proposalToken = d.approvalTicket;
  } catch (e) {
    f.detail = { ok: false, error: e?.message || String(e) };
  }
}

async function runFixPropose() {
  const f = doctorState.fix;
  if (f.proposing) return;
  const q = ($('#fix-q')?.value || f.question || '').trim();
  const a = ($('#fix-a')?.value || f.answer || '').trim();
  f.question = q; f.answer = a;
  f.targetFile = ($('#fix-tf')?.value || f.targetFile || '').trim();
  f.targetLine = ($('#fix-tl')?.value || f.targetLine || '').trim();
  if (!q && !a) { f.error = '至少填「问题」或「诊断结论」'; renderDoctorPage(); return; }

  f.proposing = true; f.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/fix/propose', {
      method: 'POST',
      body: JSON.stringify({
        question: q, answer: a,
        target: f.targetFile ? { file: f.targetFile, line: Number(f.targetLine) || 0 } : null,
        extraNote: f.note || ''
      }),
      timeoutMs: 140000
    });
    if (!d.ok) { f.error = d.error || '生成提案失败'; return; }
    f.proposalToken = d.approvalToken || '';
    f.selected = d.fixId;
    await loadFixList({ force: true });
    await loadFixDetail(d.fixId);
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.proposing = false;
    renderDoctorPage();
  }
}

/** 闸①：批准 → 带一次性令牌写暂存区。 */
async function runFixApply() {
  const f = doctorState.fix;
  if (f.busy) return;
  f.note = $('#fix-note')?.value ?? f.note;
  f.error = '';   // 每次动作开始先清旧错误（错误条"保留至下一次操作"）
  f.busy = 'apply';
  renderDoctorPage();
  try {
    const d = await api('/api/fix/apply', {
      method: 'POST',
      body: JSON.stringify({ fixId: f.selected, approvalToken: f.proposalToken, extraNote: f.note || '' }),
      timeoutMs: 60000
    });
    // 失败必须就地返回：继续走 loadFixList → loadFixStatus 会把刚写入的
    // f.error 清空，用户点"批准"后看不到任何反馈，表现为"点了没反应"。
    // 同族动作一并按此处理。
    if (!d.ok) { f.error = d.error || '应用失败'; return; }
    await loadFixList({ force: true });
    await loadFixDetail(f.selected);
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.busy = '';
    renderDoctorPage();
  }
}

async function runFixVerify() {
  const f = doctorState.fix;
  if (f.busy) return;
  f.error = '';
  f.busy = 'verify';
  renderDoctorPage();
  try {
    const d = await api('/api/fix/verify', {
      method: 'POST', body: JSON.stringify({ fixId: f.selected }),
      timeoutMs: 200000   // 沙箱真跑可能跑到 verifyTimeoutSec × 验证器个数
    });
    if (!d.ok) { f.error = d.error || '验证失败'; return; }   // 失败即返回：错误不能被列表刷新吞掉
    if (d.converged) f.rerunHint = '连续两轮失败项相同 → 已触发收敛保护，建议直接看产物决定。';
    await loadFixList({ force: true });
    await loadFixDetail(f.selected);
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.busy = '';
    renderDoctorPage();
  }
}

async function runFixRerun() {
  const f = doctorState.fix;
  if (f.busy) return;
  f.error = '';
  f.busy = 'rerun';
  renderDoctorPage();
  try {
    const d = await api('/api/fix/rerun', {
      method: 'POST', body: JSON.stringify({ fixId: f.selected }), timeoutMs: 200000
    });
    if (!d.ok) { f.error = d.error || '重跑失败'; return; }   // 失败即返回：错误不能被列表刷新吞掉
    await loadFixList({ force: true });
    await loadFixDetail(f.selected);
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.busy = '';
    renderDoctorPage();
  }
}

async function runFixCommit() {
  const f = doctorState.fix;
  if (f.busy) return;
  f.error = '';
  f.busy = 'commit';
  renderDoctorPage();
  try {
    const d = await api('/api/fix/commit', {
      method: 'POST', body: JSON.stringify({ fixId: f.selected }), timeoutMs: 60000
    });
    if (!d.ok) {
      await loadFixList({ force: true });
      await loadFixDetail(f.selected);
      f.error = d.error || '落地失败';
      return;
    }
    if (d.needsRestart) f.rerunHint = '含核心代码改动，需要重启应用才生效。';
    await loadFixList({ force: true });
    await loadFixDetail(f.selected);
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.busy = '';
    renderDoctorPage();
  }
}

async function runFixRollback() {
  const f = doctorState.fix;
  if (f.busy) return;
  f.error = '';
  f.busy = 'rollback';
  renderDoctorPage();
  try {
    const d = await api('/api/fix/rollback', {
      method: 'POST', body: JSON.stringify({ fixId: f.selected }), timeoutMs: 60000
    });
    if (!d.ok) { f.error = d.error || '回滚失败'; return; }   // 失败即返回：错误不能被列表刷新吞掉
    await loadFixList({ force: true });
    await loadFixDetail(f.selected);
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.busy = '';
    renderDoctorPage();
  }
}

async function runFixDiscard() {
  const f = doctorState.fix;
  const reason = ($('#fix-discard-reason')?.value || f.discardReason || '').trim();
  f.discardReason = reason;
  if (!reason) { f.error = '丢弃请写清理由 —— "不采纳"比"采纳"信息量大得多'; renderDoctorPage(); return; }
  if (f.busy) return;
  f.error = '';
  f.busy = 'discard';
  renderDoctorPage();
  try {
    const d = await api('/api/fix/discard', {
      method: 'POST', body: JSON.stringify({ fixId: f.selected, reason }), timeoutMs: 30000
    });
    if (!d.ok) { f.error = d.error || '丢弃失败'; return; }   // 失败即返回：错误不能被列表刷新吞掉
    await loadFixList({ force: true });
    await loadFixDetail(f.selected);
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.busy = '';
    renderDoctorPage();
  }
}

/**
 * 无改动提案的"结单"动作：一键归档（= 以默认理由丢弃）。
 * 不复用 runFixDiscard：丢弃要求人工写理由（那是对"有改动提案"的正确约束）；
 * 无改动提案的"不采纳"理由只有一种，判定为无需代码修复。预填它，
 * 让这类场景有一个明确的终态出口，否则点"批准"会撞上"无需应用"的拒绝，
 * 且提示被列表刷新吞掉，表现为"点了没反应"。
 */
async function runFixArchive() {
  const f = doctorState.fix;
  if (f.busy) return;
  f.error = '';
  f.busy = 'discard';
  renderDoctorPage();
  try {
    const d = await api('/api/fix/discard', {
      method: 'POST',
      body: JSON.stringify({ fixId: f.selected, reason: '归档：判定为无需代码修复（配置/使用问题），一键结单' }),
      timeoutMs: 30000
    });
    if (!d.ok) { f.error = d.error || '归档失败'; return; }
    await loadFixList({ force: true });
    await loadFixDetail(f.selected);
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.busy = '';
    renderDoctorPage();
  }
}

/**
 * "再改一句"：带着上一轮的失败明细，让模型重新出一份提案（**回到闸①**）。
 * 为什么回到闸①而不是直接改：改法变了就必须重新被人批准一次，
 * 否则人批准的是 A 方案，落地的却可能变成 B 方案。
 */
async function runFixRework() {
  const f = doctorState.fix;
  const rec = f.detail?.record;
  if (!rec) return;
  const reason = ($('#fix-discard-reason')?.value || f.discardReason || '').trim();
  const fails = (f.detail?.verify?.rounds || []).slice(-1)[0]?.verify?.items || [];
  const failText = fails.filter((i) => i.status !== 'pass')
    .map((i) => `· [${i.verifier}] ${i.file} → ${i.status}：${String(i.detail || '').split('\n')[0]}`).join('\n');
  f.question = rec.question || f.question;
  f.answer = [
    rec.answer || '',
    '',
    `【上一轮修复的失败明细】\n${failText || '（无验证失败，是人工要求再改）'}`,
    reason ? `【人工补充】\n${reason}` : ''
  ].join('\n').trim();
  f.targetFile = rec.target?.file || f.targetFile;
  f.targetLine = rec.target?.line ? String(rec.target.line) : f.targetLine;
  f.note = reason;
  await runFixPropose();
}

// 下载 .docx：必须自己 fetch 成 blob，api() 会把响应当 JSON 解析，二进制会炸。
async function runFixExport(format) {
  const f = doctorState.fix;
  if (!f.selected || f.exporting) return;
  f.exporting = true;
  f.error = '';
  renderDoctorPage();
  try {
    const res = await fetch('/api/fix/export', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': CONSOLE_AUTH_TOKEN || CONSOLE_MARKER },
      body: JSON.stringify({ fixId: f.selected, format })
    });
    if (format === 'docx') {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `修复报告-${f.selected}.docx`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    } else {
      const d = await res.json().catch(() => ({}));
      if (!d.ok) throw new Error(d.error || '导出失败');
      const blob = new Blob([d.markdown || ''], { type: 'text/markdown;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = d.filename || `修复报告-${f.selected}.md`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 3000);
    }
  } catch (e) {
    f.error = `导出失败：${e?.message || e}`;
  } finally {
    f.exporting = false;
    renderDoctorPage();
  }
}

async function runFixDelete() {
  const f = doctorState.fix;
  const rec = f.detail?.record;
  if (!rec) return;
  // 有快照时必须单独确认：删掉就永久失去回滚能力，这是不可逆动作。
  // 不用原生 window.confirm：它在 frame:false + transparent 的无边框窗里会阻塞
  // 渲染进程，拖长主进程看门狗心跳（可能被判 hung 重建窗口），且样式脱离主题。
  // 统一用非阻塞的 qaConfirm。
  let deleteSnapshot = false;
  if (f.detail?.backupExists) {
    deleteSnapshot = await qaConfirm({
      title: '删除工单',
      danger: true,
      confirmText: '连快照一起删',
      cancelText: '取消',
      message:
        '这笔工单还留着快照（回滚的唯一依据）。\n\n' +
        '「连快照一起删」= 审计记录与快照一并删除，「永久失去回滚能力」。\n' +
        '「取消」= 什么都不删，先退出。建议先「导出 Word」再回来删。'
    });
    if (!deleteSnapshot) return;   // 取消 = 整个操作中止（不是"只删记录"）
  } else {
    if (!await qaConfirm({
      title: '删除审计记录',
      danger: true,
      confirmText: '删除',
      message: '删除这条审计记录？此操作不可逆。'
    })) return;
  }
  if (f.busy) return;
  f.busy = 'delete';
  renderDoctorPage();
  try {
    const d = await api('/api/fix', {
      method: 'DELETE',
      body: JSON.stringify({ fixId: f.selected, deleteSnapshot }),
      timeoutMs: 30000
    });
    if (!d.ok) f.error = d.error || '删除失败';
    else {
      f.selected = '';
      f.detail = null;
      await loadFixList({ force: true });
    }
  } catch (e) {
    f.error = e?.message || String(e);
  } finally {
    f.busy = '';
    renderDoctorPage();
  }
}

// ── 子模块三：自创扩展（extension-forge）────────────────────────────────────
//
// 流程：描述需求 → 起草（模型写进暂存区）→ 看闸门结论 + 生成代码 → 确认安装。
//
// 界面上必须有"你确认后才安装"这道关。原因见 src/harness/forge/index.js：
// 进程内 Node 模块无法被真沙箱，生成的代码装上去就有完整权限。
// 闸门是"让确认这个动作有据可依"，真正的防线是这个按钮由人来点。

/**
 * 轨迹里一条工具调用的参数摘要。
 *
 * forge_read_file 的分页参数必须露出来：用户看"模型读了哪些文件"时，
 * 真正想知道的是"它有没有读到文件后半段"。只显示 path 的话，读到 1–400 行
 * 和读到 719–918 行在界面上长得一模一样。
 */
function forgeTraceArg(t) {
  const p = t?.args?.path || '';
  if (t?.tool !== 'forge_read_file') return p;
  const off = Number(t.args?.offset);
  const lim = Number(t.args?.limit);
  if (!Number.isFinite(off) && !Number.isFinite(lim)) return p;
  // 段末行号要按**分页默认值**算：模型只传 offset 时（很常见），limit 走默认 400，
  // 写成 "1 起" 就看不出它到底读到了哪一段 —— 而这正是用户要核对的事。
  const from = Number.isFinite(off) && off > 0 ? off : 1;
  const span = Number.isFinite(lim) && lim > 0 ? lim : 400;
  return `${p}（第 ${from}–${from + span - 1} 行）`;
}

/** 起草/升级轨迹的公共渲染（两条路径同一套展示）。 */
function renderForgeTrace(trace, summaryText) {
  if (!trace?.length) return '';
  return `<details class="forge-trace">
      <summary>${summaryText}</summary>
      <div class="forge-trace-body">
        ${trace.map((t) => `<div class="ft-item">
          <span class="ft-tool">${esc(String(t.tool).replace(/^forge_/, ''))}</span>
          <span class="ft-arg">${esc(forgeTraceArg(t))}</span>
          ${t.isError ? '<span class="ft-err">被拒</span>' : ''}
        </div>`).join('')}
      </div>
    </details>`;
}

/** 闸门问题等级 → 展示元数据。 */
const FORGE_LEVEL = {
  block: { icon: '⛔', label: '阻断', cls: 'is-block' },
  confirm: { icon: '⚠️', label: '需确认', cls: 'is-confirm' },
  notice: { icon: '💡', label: '提示', cls: 'is-notice' }
};

/**
 * 渲染闸门问题清单（一张卡 = 一条规则）。
 *
 * 优先用后端聚合好的 `gate.issueGroups`：同一规则在多个文件命中时只出一张卡，
 * 卡里列清全部命中位置。为什么不在这里聚合：计数（blocking / confirm / notice）
 * 与确认票据的 digest 都由后端按**逐条**命中算，界面另算一套聚合口径迟早会漂；
 * 而且逐条 `issues` 还要回喂给模型做自动修复，不能为了展示把它改掉。
 *
 * 两个计数口径要分清：
 *   · `count` 是**逐条命中数**（真实发生了 N 次），
 *   · `files.length` 是**互不相同的命中位置数**（同一文件同一行重复命中只算一个）。
 * 徽标显示 count（"共 N 处"）；files 非空时把位置摊开，files 为空而 count>1 时
 * 必须把全部 title 逐条列出 —— 否则一行只描述一个对象、又没有 file 的规则
 * （硬依赖缺失 / 未知 api 成员等）会让后面的命中从界面上消失，用户改完第一条
 * 重新过闸仍被挡住，无法收敛。
 *
 * 兼容：老响应没有 issueGroups（例如后端未重启）时退回逐条渲染，不会空白。
 */
function renderForgeIssueList(g) {
  const groups = Array.isArray(g?.issueGroups) && g.issueGroups.length
    ? g.issueGroups
    : (Array.isArray(g?.issues) ? g.issues.map((it) => ({ ...it, files: it.file ? [`${it.file}${it.line ? `:${it.line}` : ''}`] : [], count: 1 })) : []);
  if (!groups.length) return '';
  return `<div class="forge-issues">
      ${groups.map((it) => {
        const m = FORGE_LEVEL[it.level] || FORGE_LEVEL.notice;
        const files = Array.isArray(it.files) ? it.files : [];
        const count = Number(it.count) > 0 ? Number(it.count) : 1;
        // 无位置可摊，但确实命中多次：只能逐条列 title（每条的 title 各自指名了对象）。
        const titles = Array.isArray(it.titles) ? it.titles : [];
        const listOnly = !files.length && count > 1;
        // 多命中时把位置摊开（这是聚合卡的全部价值：一眼看到"这个问题在哪些文件里"）；
        // 单命中时沿用原来的紧凑写法，不为一个位置多占一行。
        const where = listOnly
          ? `<ul class="fi-files">${(titles.length > 1 ? titles : [it.title]).map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`
          : files.length > 1
            ? `<ul class="fi-files">${files.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>`
            : (files[0] ? `<div class="fi-where">${esc(files[0])}</div>` : '');
        return `<div class="forge-issue ${m.cls}">
          <div class="fi-head"><span class="fi-badge">${m.icon} ${m.label}</span>${esc(it.title)}${count > 1 ? `<span class="fi-count">共 ${count} 处</span>` : ''}</div>
          ${where}
          ${it.why ? `<div class="fi-why">${esc(it.why)}</div>` : ''}
          ${count === 1 && it.snippet ? `<pre class="fi-code">${esc(it.snippet)}</pre>` : ''}
        </div>`;
      }).join('')}
    </div>`;
}

function renderForgeModule() {
  const f = doctorState.forge;

  // 插件未启用：给"去哪开"，并说明为什么默认关闭
  if (f.available === false) {
    return `<div class="usage-wrap" style="padding:0">
      <div class="empty-hint">「扩展锻造台」插件当前未启用。</div>
      <div class="hint" style="margin-top:10px">
        去 <b>下载 → 已安装 → 插件</b> 找到 <code>extension-forge</code> 并启用它，或者直接点下面的按钮当场启用。<br />
        它<b>默认关闭</b>是有意的 —— 这个模块会让模型生成并在本机执行 JavaScript，
        应当由你显式决定是否开启。
      </div>
      <div style="display:flex;gap:8px;margin-top:12px">
        <!-- r107：当场启用按钮（见 enablePluginInline 注释） -->
        <button class="btn btn-small btn-primary" id="forge-enable-btn">立即启用 extension-forge</button>
        <button class="btn btn-small" id="forge-retry-btn">已启用，重新检测</button>
      </div>
    </div>`;
  }

  // 已安装：给明确结果 + 去插件/技能页看
  if (f.installed) {
    const it = f.installed;
    const kindLabel = it.kind === 'plugin' ? '插件' : '技能';
    // 「装好了但没开」必须说清楚，否则用户会以为功能坏了：
    // 扩展已装载（列表里能看到），但按设计**没有自动启用**，工具也不会发给模型。
    const offHint = it.autoDisabled
      ? `<div class="fd-off">
           ⏸ <b>已装载，但还没启用</b> —— 按设计它不会自己开始工作。
           去「下载 → 已安装 → ${esc(kindLabel)}」找到 <code>${esc(it.id || it.dir || '')}</code> 点开启，它才会生效。
         </div>`
      : '';
    // id 与目录名正常路径上相等（目录名就是清单 id）。不等只可能出现在历史
    // 数据里（旧版本撞名加过后缀），提示一句以免用户按 id 找不到目录。
    const idLine = it.id && it.id !== it.dir
      ? `<div class="fd-sub">清单 id 是 <code>${esc(it.id)}</code>，但这个扩展的目录名是 <code>${esc(it.dir)}</code>。</div>`
      : '';
    return `
      <div class="forge-done">
        <div class="fd-icon">✅</div>
        <div class="fd-body">
          <div class="fd-title">已安装：${esc(it.id || it.dir || '')}</div>
          <div class="fd-sub">
            落到 <code>${esc(it.kind === 'plugin' ? 'plugins/' : 'skills/')}${esc(it.dir || '')}/</code>
            （${(it.files || []).length} 个文件）—— 热重载会自动装载，无需重启。
          </div>
          ${idLine}
          ${offHint}
          <div class="fd-actions">
            <button class="btn btn-small" id="forge-again-btn">再做一个</button>
            <button class="btn btn-primary btn-small" id="forge-goto-btn">去${esc(kindLabel)}页开启</button>
          </div>
        </div>
      </div>`;
  }

  return `
    <div class="forge-modes" role="tablist">
      <button class="forge-mode${f.mode === 'create' ? ' is-active' : ''}" type="button" data-forge-mode="create">
        ✏️ 自己造一个
      </button>
      <button class="forge-mode${f.mode === 'import' ? ' is-active' : ''}" type="button" data-forge-mode="import">
        📦 改别人的包
      </button>
    </div>

    ${f.mode === 'import' ? renderForgeImportArea() : renderForgeCreateArea()}

    ${f.conflict ? '' : (f.error ? `<div class="forge-error">⚠️ ${esc(f.error)}</div>` : '')}
    ${renderForgeConflict()}
    ${f.drafting ? `<div class="forge-wait">${f.revising ? '🔧 正在修改草稿…模型会在原草稿上修，改完自动重跑闸门。' : '⚒️ 正在起草…模型会先把文件写进暂存区，完成后自动过闸门。'}</div>` : ''}
    ${f.importing ? `<div class="forge-wait">📦 正在解包…内容会落到暂存区（不会被执行）。</div>` : ''}
    ${f.adapting ? `<div class="forge-wait">🔧 正在适配…模型会读草稿和诊断，改完自动重跑闸门。</div>` : ''}

    ${renderForgeImported()}
    ${renderForgeResult()}
    ${renderForgeDiff()}
    ${renderForgeDraftsList()}`;
}

/** 「自己造」：需求输入框。 */
function renderForgeCreateArea() {
  const f = doctorState.forge;
  // 「继续修改」模式：当前展示的草稿存在且闸门未通过，起草输入框就地变成修改入口。
  // （openForgeDraft 打开暂存区老草稿时同样成立，那些没装完的失败草稿由此获得"救回来"的入口。）
  const revise = !!(f.draftId && f.gate && f.gate.ok === false && !f.installed);
  return `
    <div class="forge-lead">
      ${revise
        ? `<b>这个草稿还没过闸门</b> —— 在下面补充要改什么（可留空），点「继续修改这个草稿」，模型会在原草稿上修，不推倒重来。`
        : `<b>用一句话描述你要什么</b>，模型会起草一个扩展，过完闸门后由你确认安装。`}
      <span class="forge-lead-warn">生成的代码会真的在本机执行 —— 所以最后一步必须由你点。</span>
    </div>
    <div class="forge-input">
      <textarea id="forge-req" rows="3" placeholder="${revise
        ? '例如：把 fetch 去掉，改成读本地缓存 / 把 id 换成别的…（可留空 —— 模型会按上面的闸门问题清单逐项修）'
        : '①做什么：人民币金额转中文大写  ②什么时候用：有人发金额转换时  ③返回什么：大写金额文本 —— 按「做什么 / 什么时候用 / 返回什么」三要素写，写得越清楚做得越准'}">${esc(revise ? (f.reviseNote || '') : f.requirement)}</textarea>
      <div class="forge-input-foot">
        <span class="forge-hint">${revise
          ? '修改和起草一样只在暂存区里进行，改完会自动重跑闸门。'
          : '起草通常几秒到半分钟。模型只会写进暂存区，不会影响正在运行的系统。'}</span>
        <button class="btn btn-primary btn-small" id="forge-draft-btn"${forgeBusy() ? ' disabled' : ''}>${f.drafting ? (f.revising ? '修改中…' : '起草中…') : (revise ? '继续修改这个草稿' : '开始起草')}</button>
      </div>
    </div>`;
}

/** 「改别人的包」：拖放 / 选 zip。 */
function renderForgeImportArea() {
  const f = doctorState.forge;
  return `
    <div class="forge-lead">
      <b>把别人发来的扩展包拖进来</b>（或点下面的按钮选 .zip）。它<b>不会</b>被直接安装 ——
      先进暂存区、跑一遍闸门，让你看清这个包是什么样；需要的话再让模型适配到本机环境。
      <span class="forge-lead-warn">第三方代码的来源未知，闸门的静态扫描对"故意构造的绕过"天然不如对"模型手滑"有效 —— 所以代码会完整摊开给你看。</span>
    </div>
    <div class="forge-drop${forgeBusy() ? ' is-busy' : ''}" id="forge-drop">
      <div class="fdrop-icon">📦</div>
      <div class="fdrop-main">${forgeBusy() ? '⏳ 正在忙，请等当前操作完成' : '把 .zip 拖到这里'}</div>
      <div class="fdrop-sub">或在<b>下载 → 已安装 → 插件</b>页用「本地导入」装 —— 但那条路是"装上就跑"，不会经过这里的闸门与适配。</div>
      <label class="btn btn-small fdrop-btn">
        选择 zip 文件
        <input type="file" id="forge-file" accept=".zip,application/zip" hidden />
      </label>
    </div>`;
}

/**
 * 解包跳过项的一句话描述。
 *
 * 后端给的是结构化的 { path, size, reason }（原因不再拼在字符串里），
 * 这里翻译成人话。未知 reason 原样显示 —— 新后端加原因时界面不会变成空白。
 */
const FORGE_SKIP_REASON = {
  'single-file-too-large': '单文件超过上限',
  'total-too-large': '累计体积超过上限',
  'outside-module-root': '不在扩展根目录下',
  'directory-entry': '目录条目',
  'packaging-junk': '系统打包垃圾',
  'path-rejected': '路径不允许',
  'write-failed': '写盘失败'
};

/** 体积类原因（与 forge-tools.js 的 SKIP_REASONS.FILE_TOO_LARGE / TOTAL_TOO_LARGE 同步：这些意味着包不完整）。 */
const FORGE_SKIP_SIZE_REASONS = new Set(['single-file-too-large', 'total-too-large']);

/** 体积单位：跳过项要能一眼看出"1.5MB"这种量级，而不是一串字节数。 */
function forgeBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`;
  if (b >= 1024) return `${Math.round(b / 1024)}KB`;
  return `${b}B`;
}

/** 一条跳过项的展示文本（兼容旧后端：那时 skipped 是纯字符串）。 */
function forgeSkipText(s) {
  if (typeof s === 'string') return s;
  const reason = FORGE_SKIP_REASON[s?.reason] || s?.reason || '';
  const size = s?.size ? `，${forgeBytes(s.size)}` : '';
  const detail = s?.detail ? `：${s.detail}` : '';
  return `${s?.path || '(未知条目)'}（${reason}${size}${detail}）`;
}

/**
 * 体积超限提示。
 *
 * 实测事故：1.5MB 的 lib/dict.json 被静默丢弃，响应仍是 ok:true，界面只在一个
 * 默认折叠的 details 里留了一行 —— 用户装完才发现功能缺失，没有任何线索。
 * 体积超限不是打包垃圾：它意味着**这个包少了解包出来的内容**，很可能跑不起来，
 * 所以必须醒目地放在文件清单上方，而不是折叠在角落里。
 */
function renderForgeSkipped(im) {
  const skipped = Array.isArray(im?.skipped) ? im.skipped : [];
  if (!skipped.length) return '';
  const sizeHits = skipped.filter((s) => typeof s === 'object' && FORGE_SKIP_SIZE_REASONS.has(s.reason));
  const otherHits = skipped.filter((s) => !sizeHits.includes(s));

  const sizeWarn = sizeHits.length ? `
    <div class="forge-skipped-warn" role="alert">
      <div class="fsw-title">⚠️ 有 ${sizeHits.length} 个文件因体积超限未解出</div>
      <div class="fsw-list">${sizeHits.map((s) => `<div class="fsk-row">${esc(forgeSkipText(s))}</div>`).join('')}</div>
      <div class="fsw-note">这些文件不在草稿里，<b>这个技能可能无法正常工作</b> —— 需要它们的话请让作者拆分大文件后重新打包。</div>
    </div>` : '';

  const otherBlock = otherHits.length ? `
    <details class="forge-skipped">
      <summary>ℹ️ 另有 ${otherHits.length} 个条目被跳过（未落盘）</summary>
      <div class="fs-body">${otherHits.map((s) => `<div class="fsk-row">${esc(forgeSkipText(s))}</div>`).join('')}</div>
    </details>` : '';

  return `${sizeWarn}${otherBlock}`;
}

/** 导入结果：文件清单 + 跳过的条目 + 闸门结论（在 renderForgeResult 里复用闸门展示）。 */
function renderForgeImported() {
  const f = doctorState.forge;
  if (!f.imported) return '';
  const im = f.imported;
  return `
    <div class="forge-imported">
      <div class="fi-title">📦 已解包：<b>${esc(im.zipName || '(未命名)')}</b>
        <span class="fi-count">${(im.files || []).length} 个文件</span>
      </div>
      ${renderForgeSkipped(im)}
      <div class="fi-note">内容在暂存区，<b>尚未安装</b>。下面是这个包的原样清单与闸门结论。</div>
      ${f.gate && f.gate.ok && !f.gate.confirm ? '' : `
        <div class="fi-adapt">
          <input type="text" id="forge-adapt-note" class="fi-adapt-input"
            placeholder="补充说明（可留空），如：去掉联网，改成读本地缓存"
            value="${esc(f.adaptNote || '')}" />
          <button class="btn btn-primary btn-small" id="forge-adapt-btn"${forgeBusy() ? ' disabled' : ''}>
            ${f.adapting ? '适配中…' : '🔧 让模型适配到本机'}
          </button>
          <span class="fi-adapt-note">模型只改清单、代码只做最小修补，改完会把 diff 给你看。</span>
        </div>`}
    </div>`;
}

/** 适配 diff：改了哪些文件、改了什么。第三方场景下这是最重要的透明度保障。 */
function renderForgeDiff() {
  const f = doctorState.forge;
  if (!f.diff || !f.diff.files) return '';
  const changed = f.diff.files.filter((x) => x.status !== 'same');
  const sm = f.diff.summary || {};

  if (!changed.length) {
    return `<div class="forge-diff is-none">
      <div class="fdh-title">🔍 适配 diff</div>
      <div class="fdh-sub">模型没有改动任何文件${f.summary ? '（它的说明见下）' : ''}。</div>
    </div>`;
  }

  const label = { added: '新增', changed: '修改', removed: '删除' };
  return `
    <div class="forge-diff">
      <div class="fdh-title">🔍 适配 diff —— 模型改了 ${changed.length} 个文件</div>
      <div class="fdh-sub">
        新增 ${sm.added || 0} · 修改 ${sm.changed || 0} · 删除 ${sm.removed || 0}
        。<b>下面是你和作者之间唯一的差异记录，安装前请过一遍。</b>
      </div>
      ${changed.map((x) => `
        <details class="forge-dfile">
          <summary>
            <span class="fd-status is-${x.status}">${label[x.status] || x.status}</span>
            ${esc(x.path)}
          </summary>
          <div class="fd-body">
            ${x.before ? `<div class="fd-side-t">原（作者写的）</div><pre class="forge-pre">${esc(x.before)}</pre>` : ''}
            ${x.after ? `<div class="fd-side-t">改后（模型写的）</div><pre class="forge-pre">${esc(x.after)}</pre>` : ''}
          </div>
        </details>`).join('')}
    </div>`;
}

/** 起草结果：闸门结论 + 生成代码 + 安装按钮。 */
function renderForgeResult() {
  const f = doctorState.forge;
  if (!f.gate && !f.trace.length) return '';

  const g = f.gate || {};
  const blocking = g.blocking || 0;
  const confirm = g.confirm || 0;
  const notice = g.notice || 0;

  // 闸门结论横幅
  // 修改/适配过的话额外给出"改前 → 改后"的对照，用户最想知道的是"模型到底修好了没"
  const before = f.gateBefore;
  const delta = (before && before.blocking !== undefined && before.blocking !== blocking)
    ? `<div class="fv-delta">改前：阻断 ${before.blocking} / 需确认 ${before.confirm || 0} &nbsp;→&nbsp; 现在：阻断 ${blocking} / 需确认 ${confirm}</div>`
    : '';
  // 后端自动修复了几轮（闸门有阻断项时系统自己喂问题清单重跑，不用用户点"继续修改"）
  const autoFixNote = f.autoFix > 0
    ? `<div class="fv-delta">♻️ 闸门曾报阻断，系统已自动把问题清单喂回模型修复了 ${f.autoFix} 轮</div>`
    : '';
  let verdict;
  if (!g.ok) {
    verdict = `<div class="forge-verdict is-block">
      <span class="fv-icon">⛔</span>
      <div><b>闸门未通过</b><div class="fv-sub">${blocking} 项阻断 —— 已自动修复 ${f.autoFix || 0} 轮仍未清零。在上方输入框补充说明（可留空），点「继续修改这个草稿」让模型在原稿上修。</div>${delta}${autoFixNote}</div>
    </div>`;
  } else if (confirm > 0) {
    verdict = `<div class="forge-verdict is-confirm">
      <span class="fv-icon">⚠️</span>
      <div><b>通过，但有 ${confirm} 项需要你确认</b><div class="fv-sub">这些不是错误，是需要你知道的能力（如联网 / 动态执行）。看下面的说明再决定。</div>${delta}${autoFixNote}</div>
    </div>`;
  } else {
    verdict = `<div class="forge-verdict is-ok">
      <span class="fv-icon">✅</span>
      <div><b>闸门通过</b><div class="fv-sub">结构 / 语法 / 危险模式 / 声明-实现 / 本地环境 五项检查都过了${notice ? `（另有 ${notice} 条提示）` : ''}。</div>${delta}${autoFixNote}</div>
    </div>`;
  }

  // 问题明细
  // 起草计划卡片：plan-then-write 让模型动笔前先定方向，这里把计划亮出来，
  // 用户能第一时间核对"做的是不是我想的"，不对就点"继续修改"纠偏，成本最低的时刻。
  const planHtml = f.plan ? `
    <div class="forge-summary">
      <div class="fs-title">📋 起草计划（模型动笔前定的方向）</div>
      <div class="fs-body">${doctorMiniMd(f.plan)}</div>
    </div>` : '';
  const issues = renderForgeIssueList(g);

  // 解包残缺提示（体积超限）：记录来自草稿列表（解包响应是一次性的），
  // 打开老草稿时同样要出现 —— 少了文件的包装上多半跑不起来。
  const oversizeHtml = (f.oversizeLost || []).length
    ? renderForgeSkipped({ skipped: f.oversizeLost })
    : '';

  // 清单摘要
  const man = g.manifest || {};
  const meta = man.id ? `
    <div class="forge-meta">
      <span>类型 <b>${esc(g.kind === 'plugin' ? '插件' : '技能')}</b></span>
      <span>id <b>${esc(man.id)}</b></span>
      <span>名称 <b>${esc(man.name || '-')}</b></span>
      <span>工具 <b>${(man.tools || []).length}</b></span>
      <span>文件 <b>${f.files.length}</b></span>
    </div>` : '';

  // 生成代码
  const codeHtml = f.files.length ? `
    <details class="forge-code"${f.files.length === 1 ? ' open' : ''}>
      <summary>📄 查看生成的代码（${f.files.length} 个文件）</summary>
      <div class="forge-code-body">
        ${f.files.map((file) => `
          <details class="forge-file">
            <summary>${esc(file.path)}</summary>
            <pre class="forge-pre">${esc(file.content)}</pre>
          </details>`).join('')}
      </div>
    </details>` : '';

  // 起草轨迹
  const traceHtml = renderForgeTrace(f.trace, `⚒️ 起草过程：模型写了 ${f.trace.length} 次`);

  // 安装区
  const canInstall = g.ok === true;
  const needCheck = confirm > 0;
  const installHtml = `
    <div class="forge-install">
      ${needCheck ? `
        <label class="forge-confirm-check">
          <input type="checkbox" id="forge-allow-confirm"${f.allowConfirm ? ' checked' : ''} />
          <span>我已知悉上面 <b>${confirm}</b> 项需确认的能力，仍要安装</span>
        </label>` : ''}
      <button class="btn ${canInstall ? 'btn-primary' : ''} btn-small" id="forge-install-btn"
        ${!canInstall || f.installing || (forgeBusy() && !f.installing) || (needCheck && !f.allowConfirm) ? ' disabled' : ''}>
        ${f.installing ? '安装中…' : '我已核对，确认安装'}
      </button>
      <button class="btn btn-small" id="forge-discard-btn">丢弃草稿</button>
      ${!canInstall ? '<span class="forge-install-note">有阻断项 —— 在上方补充说明（可留空）后点「继续修改这个草稿」。</span>' : ''}
      ${canInstall && needCheck && !f.allowConfirm ? '<span class="forge-install-note">勾选上面的确认框后按钮才会可用。</span>' : ''}
    </div>
    ${canInstall ? `<div class="forge-install-warn">
      ⏸ 装好后它是<b>关闭状态</b>，不会自己开始工作 —— 去「下载 → 已安装 → ${esc(g.kind === 'plugin' ? '插件' : '技能')}」里点开启才会生效。<br />
      🔐 点「我已核对，确认安装」= 你本人签一张 <b>10 分钟内有效、一次性的</b>确认票据，
      绑定当前这份代码；这期间代码若有任何改动，票据自动失效，需要你重新核对。
    </div>` : ''}`;

  return `${verdict}${oversizeHtml}${planHtml}${issues}${meta}${codeHtml}${traceHtml}${f.summary ? `
    <div class="forge-summary">
      <div class="fs-title">模型说明</div>
      <div class="fs-body">${doctorMiniMd(f.summary)}</div>
    </div>` : ''}${installHtml}`;
}

/** 同 id 冲突：说清现状 + 两条出路（升级 / 卸载）。 */
function renderForgeConflict() {
  const c = doctorState.forge.conflict;
  if (!c?.id) return '';
  const loc = c.relDir || c.dir || c.id;
  // 复用 .forge-error 外壳与已有的 .fd-sub / .fd-actions 排版类：
  // 本页样式集中在 ui/style.css，不为一个提示框另立新类。
  return `
    <div class="forge-error">
      <div><b>已经装过一个同名扩展：</b><code>${esc(c.id)}</code>${c.version ? ` v${esc(c.version)}` : ''}</div>
      <div class="fd-sub">
        它在 <code>${esc(loc)}</code>，这次<b>没有落盘</b>（不会产生第二份副本）。
        <br />想换成新版：用「升级扩展」，它会先备份原版再覆盖，出问题能回滚。
        <br />想重装成干净的一份：先去「下载 → 已安装」卸载它，再回来装。
      </div>
      <div class="fd-actions">
        <button class="btn btn-small" id="forge-conflict-upgrade-btn">去升级扩展</button>
      </div>
    </div>`;
}

/** 暂存区里已有的草稿（往往是上次没装完的）。 */
function renderForgeDraftsList() {
  const f = doctorState.forge;
  if (!f.drafts.length) return '';
  return `
    <details class="forge-drafts"${document.querySelector('.forge-drafts')?.open === false ? '' : ' open'}>
      <summary>🗂 暂存区里的草稿（${f.drafts.length}）</summary>
      <div class="forge-drafts-body">
        ${f.drafts.map((d) => `
          <div class="fd-row">
            <span class="fd-name">
              ${esc(d.name || d.draftId)}
              ${d.kind ? `<span class="fd-kind">${esc(d.kind === 'plugin' ? '插件' : '技能')}</span>` : ''}
              ${d.source === 'market' ? `<span class="fd-kind">市场 · ${esc(d.originName || d.originCode || '')}</span>` : ''}
            </span>
            <span class="fd-info">${d.files} 文件</span>
            <span class="fd-state ${d.ok ? 'is-ok' : 'is-bad'}">
              ${d.ok ? (d.confirm ? `待确认 ${d.confirm} 项` : '已过闸 · 待安装') : `阻断 ${d.blocking}`}
            </span>
            ${(d.skippedOversize || []).length ? `<span class="fd-state is-bad" title="${esc((d.skippedOversize || []).map((s) => s.path).join('、'))}">缺 ${d.skippedOversize.length} 个文件</span>` : ''}
            <button class="btn btn-small" data-forge-open="${esc(d.draftId)}">查看</button>
            <button class="btn btn-small" data-forge-drop-draft="${esc(d.draftId)}">删除</button>
          </div>`).join('')}
      </div>
      <div class="forge-drafts-note">草稿放在 <code>data/plugin-data/extension-forge/staging/</code>，不会被执行。</div>
    </details>`;
}

// ── 子模块四：升级扩展（extension-forge 的 upgrade 系列能力）────────────────
//
// 两条升级路径，同一个安全底座（暂存区副本 → 闸门 → diff → 确认 → 备份+覆盖 → 可回滚）：
//   A. 对话升级：从列表选已装扩展 → 起草升级（复制进暂存区）→ 一句话告诉模型怎么改
//   B. zip 升级：拖入升级包 → 按 manifest.id 匹配已装扩展 → 自动对比"更新了什么"
// 升级永远不原地改，覆盖安装由后端强制"备份原版 + id 一致 + 闸门通过"三关。

/** 升级模块的统一忙判定（模块内部互斥，避免两个请求同时改同一草稿）。 */
function upgradeBusy() {
  const u = doctorState.upgrade;
  return !!(u.starting || u.chatting || u.importing || u.installing);
}

function renderUpgradeModule() {
  const u = doctorState.upgrade;
  // 依赖 extension-forge（能力提供方），未启用时给"去哪开"
  if (doctorState.forge.available === false) {
    return `<div class="usage-wrap" style="padding:0">
      <div class="empty-hint">「扩展锻造台」插件当前未启用 —— 升级扩展由它提供能力。</div>
      <div class="hint" style="margin-top:10px">去 <b>下载 → 已安装 → 插件</b> 找到 <code>extension-forge</code> 并启用它，然后回到这一页。</div>
    </div>`;
  }

  return `
    ${u.error ? `<div class="forge-error">⚠️ ${esc(u.error)}</div>` : ''}
    ${u.starting ? `<div class="forge-wait">⬆️ 正在创建升级草稿…复制原扩展进暂存区。</div>` : ''}
    ${u.chatting ? `<div class="forge-wait">⬆️ 正在按你的要求升级…模型会改暂存区里的副本，改完自动跑闸门并对比原版。</div>` : ''}
    ${u.importing ? `<div class="forge-wait">📦 正在解包升级文件…内容落到暂存区，不会直接生效。</div>` : ''}
    ${u.installing ? `<div class="forge-wait">⬆️ 正在升级…先备份原版，再覆盖安装。</div>` : ''}

    ${renderUpgradeDraft()}
    ${renderUpgradeDone()}

    ${u.draft ? '' : `
      <div class="forge-lead"><b>方式一：升级已装的扩展</b> —— 选一个，用一句话告诉模型你想怎么改。</div>
      ${renderUpgradeList()}
      <div class="forge-lead" style="margin-top:16px"><b>方式二：导入升级包</b> —— 拖入 .zip，自动匹配对应的已装扩展并对比"更新了什么"。</div>
      <div class="forge-drop${upgradeBusy() ? ' is-busy' : ''}" id="upgrade-drop">
        <div class="fdrop-icon">⬆️</div>
        <div class="fdrop-main">${upgradeBusy() ? '⏳ 正在忙，请等当前操作完成' : '把升级 .zip 拖到这里'}</div>
        <label class="btn btn-small fdrop-btn">
          选择 zip 文件
          <input type="file" id="upgrade-file" accept=".zip,application/zip" hidden />
        </label>
      </div>`}
  `;
}

/** 已装扩展列表（方式一的选单）。 */
function renderUpgradeList() {
  const u = doctorState.upgrade;
  if (u.listError) return `<div class="hint" style="margin-top:8px">读取已装扩展失败：${esc(u.listError)}</div>`;
  if (!u.list.length) return `<div class="hint" style="margin-top:8px">还没有已装的扩展（或清单都不可读）。</div>`;
  return `<div class="upg-list">
    ${u.list.map((it) => `
      <div class="fd-row">
        <span class="fd-name">
          ${esc(it.name || it.id)}
          <span class="fd-kind">${esc(it.kind === 'plugin' ? '插件' : '技能')}</span>
          ${it.version ? `<span class="fd-kind">v${esc(it.version)}</span>` : ''}
        </span>
        <span class="fd-info">${esc(it.id)} · ${it.files} 文件</span>
        <button class="btn btn-small" data-upg-start="${esc(it.kind)}|${esc(it.dir)}"${upgradeBusy() ? ' disabled' : ''}>起草升级</button>
      </div>`).join('')}
  </div>`;
}

/** 升级草稿工作区：目标信息 + 升级要求输入框（对话路径）+ 结果 + 确认/放弃。 */
function renderUpgradeDraft() {
  const u = doctorState.upgrade;
  if (!u.draft) return '';
  const d = u.draft;
  return `
    <div class="forge-imported">
      <div class="fi-title">⬆️ 升级目标：<b>${esc(d.name || d.id)}</b>
        <span class="fd-kind">${esc(d.kind === 'plugin' ? '插件' : '技能')}</span>
        ${d.version ? `<span class="fd-kind">当前 v${esc(d.version)}</span>` : ''}
      </div>
      <div class="fi-note">已复制进暂存区（<code>${esc(d.draftId)}</code>）。${d.source === 'zip' ? '这是导入的升级包，改动对比见下。' : '下面的修改不会影响正在运行的扩展 —— 确认后才会覆盖。'}</div>
      ${d.source === 'zip'
        // 升级包走的是同一套解包（skipped 带原因），体积超限同样要醒目提示：
        // 少了文件的升级包覆盖上去，等于把已装扩展改坏。
        ? renderForgeSkipped(d)
        : ((d.skipped || []).length ? `
        <details class="forge-skipped">
          <summary>⚠️ ${d.skipped.length} 个白名单外文件未复制（安装时也不允许）</summary>
          <div class="fs-body">${d.skipped.map((s) => `<div class="fsk-row">${esc(typeof s === 'string' ? s : (s?.path || ''))}</div>`).join('')}</div>
        </details>` : '')}

      ${d.source === 'chat' && !u.result ? `
        <div class="forge-input" style="margin-top:10px">
          <textarea id="upgrade-note" rows="3" placeholder="例如：给查天气技能加一个『明天』参数的支持 / 把工具的输出改成表格形式 / 修复大金额时的四舍五入问题…">${esc(u.note)}</textarea>
          <div class="forge-input-foot">
            <span class="forge-hint">模型会读整个扩展再改；manifest.id 与已有工具签名会保持稳定。</span>
            <button class="btn btn-primary btn-small" id="upgrade-chat-btn"${upgradeBusy() ? ' disabled' : ''}>${u.chatting ? '升级中…' : '让模型升级'}</button>
          </div>
        </div>` : ''}

      ${renderUpgradeResult()}
    </div>`;
}

/** 升级结果：闸门横幅 + "更新了什么" diff + 模型说明 + 确认/放弃/回滚。 */
function renderUpgradeResult() {
  const u = doctorState.upgrade;
  if (!u.result) return '';
  const g = u.result.gate || {};
  const blocking = g.blocking || 0;
  const confirm = g.confirm || 0;
  const needCheck = confirm > 0;
  const canUpgrade = g.ok === true;

  // 自动修复轮数（升级路径与 draft 同款反馈回路）
  const autoFixNote = (u.result.autoFixAttempts || 0) > 0
    ? `<div class="fv-delta">♻️ 闸门曾报阻断，系统已自动喂回模型修复了 ${u.result.autoFixAttempts} 轮</div>`
    : '';

  let verdict;
  if (!g.ok) {
    verdict = `<div class="forge-verdict is-block">
      <span class="fv-icon">⛔</span>
      <div><b>闸门未通过</b><div class="fv-sub">${blocking} 项阻断 —— 修掉后才能升级安装。</div>${autoFixNote}</div>
    </div>`;
  } else if (needCheck) {
    verdict = `<div class="forge-verdict is-confirm">
      <span class="fv-icon">⚠️</span>
      <div><b>通过，但有 ${confirm} 项需要你确认</b><div class="fv-sub">这些不是错误，是需要你知道的能力。看明细再决定。</div>${autoFixNote}</div>
    </div>`;
  } else {
    verdict = `<div class="forge-verdict is-ok">
      <span class="fv-icon">✅</span>
      <div><b>闸门通过</b><div class="fv-sub">升级后的扩展通过了全部检查。</div>${autoFixNote}</div>
    </div>`;
  }

  const issues = renderForgeIssueList(g);

  // "更新了什么"，升级场景下最重要的透明度保障
  const diff = u.result.diff;
  let diffHtml = '';
  if (diff?.files) {
    const changed = diff.files.filter((x) => x.status !== 'same');
    diffHtml = changed.length ? `
      <details class="forge-dfile" open>
        <summary>🔍 更新了什么 —— ${changed.length} 个文件有变化（新增 ${diff.summary.added} / 修改 ${diff.summary.changed} / 删除 ${diff.summary.removed}）</summary>
        <div class="fd-body">
          ${changed.map((x) => `
            <details class="forge-dfile">
              <summary><span class="fd-status is-${x.status}">${x.status === 'added' ? '新增' : x.status === 'removed' ? '删除' : '修改'}</span>${esc(x.path)}</summary>
              <div class="fd-body">
                ${x.before ? `<div class="fd-side-t">原版</div><pre class="forge-pre">${esc(x.before)}</pre>` : ''}
                ${x.after ? `<div class="fd-side-t">升级后</div><pre class="forge-pre">${esc(x.after)}</pre>` : ''}
              </div>
            </details>`).join('')}
        </div>
      </details>` : `<div class="forge-diff is-none"><div class="fdh-title">🔍 没有检测到文件变化</div></div>`;
  }

  return `
    ${verdict}${issues}${diffHtml}
    ${u.result.summary ? `
      <div class="forge-summary">
        <div class="fs-title">模型说明</div>
        <div class="fs-body">${doctorMiniMd(u.result.summary)}</div>
      </div>` : ''}
    ${renderForgeTrace(u.result.trace, `⬆️ 升级过程：模型改了 ${(u.result.trace || []).length} 次`)}
    <div class="forge-install">
      ${needCheck && canUpgrade ? `
        <label class="forge-confirm-check">
          <input type="checkbox" id="upgrade-allow-confirm"${u.installConfirm ? ' checked' : ''} />
          <span>我已知悉上面 <b>${confirm}</b> 项需确认的能力，仍要升级</span>
        </label>` : ''}
      ${canUpgrade ? `
        <button class="btn btn-primary btn-small" id="upgrade-install-btn"
          ${u.installing || upgradeBusy() || (needCheck && !u.installConfirm) ? ' disabled' : ''}>
          ${u.installing ? '升级中…' : '确认升级（备份原版后覆盖）'}
        </button>` : ''}
      <button class="btn btn-small" id="upgrade-discard-btn"${upgradeBusy() ? ' disabled' : ''}>放弃这次升级</button>
      ${!canUpgrade ? '<span class="forge-install-note">有阻断项 —— 回到输入框补充说明再让模型改。</span>' : ''}
    </div>
    ${canUpgrade ? `<div class="forge-install-warn">⬆️ 升级会<b>覆盖原目录</b>。原版会先备份到 <code>data/plugin-data/extension-forge/backups/</code>，升级后可一键回滚。扩展的热重载会自动装载新版本。</div>` : ''}`;
}

/** 升级完成卡。 */
function renderUpgradeDone() {
  const u = doctorState.upgrade;
  if (!u.done) return '';
  const d = u.done;
  return `
    <div class="forge-done">
      <div class="fd-icon">⬆️</div>
      <div class="fd-body">
        <div class="fd-title">已升级：${esc(d.id || d.dir || '')}</div>
        <div class="fd-sub">
          ${d.versionBefore || d.versionAfter ? `版本 v${esc(d.versionBefore || '?')} → v${esc(d.versionAfter || '?')}。` : ''}
          原版备份在 <code>${esc(d.backup || '')}</code>，热重载已自动装载新版本。
        </div>
        <div class="fd-actions">
          <button class="btn btn-small" id="upgrade-rollback-btn"${u.installing || upgradeBusy() ? ' disabled' : ''}>${u.installing ? '回滚中…' : '↩️ 出问题了？回滚到上一版'}</button>
          <button class="btn btn-small" id="upgrade-again-btn">再升级别的扩展</button>
        </div>
      </div>
    </div>`;
}

/** 升级模块事件绑定。 */
function bindUpgradeEvents(box) {
  $$('[data-upg-start]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const [kind, dir] = String(el.getAttribute('data-upg-start') || '').split('|');
      runUpgradeStart(kind, dir);
    });
  });

  $('#upgrade-chat-btn')?.addEventListener('click', () => runUpgradeChat());
  const ta = $('#upgrade-note');
  ta?.addEventListener('input', () => { doctorState.upgrade.note = ta.value; });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      runUpgradeChat();
    }
  });

  $('#upgrade-allow-confirm')?.addEventListener('change', (e) => {
    doctorState.upgrade.installConfirm = !!e.target.checked;
    renderDoctorPage();
  });
  $('#upgrade-install-btn')?.addEventListener('click', () => runUpgradeInstall());
  $('#upgrade-discard-btn')?.addEventListener('click', () => runUpgradeDiscard());
  $('#upgrade-rollback-btn')?.addEventListener('click', () => runUpgradeRollback());
  $('#upgrade-again-btn')?.addEventListener('click', () => {
    Object.assign(doctorState.upgrade, { draft: null, result: null, done: null, note: '', installConfirm: false, error: '' });
    renderDoctorPage();
  });

  const drop = $('#upgrade-drop');
  if (drop) {
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const f0 = e.dataTransfer?.files?.[0];
      if (f0) runUpgradeZip(f0);
    });
  }
  $('#upgrade-file')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) runUpgradeZip(files[0]);
  });
}

/** 拉已装扩展列表。 */
async function loadUpgradeList() {
  const u = doctorState.upgrade;
  try {
    const d = await api('/api/forge/installed', { timeoutMs: 15000 });
    if (d.available === false) { u.listError = '「扩展锻造台」插件未启用'; return; }
    u.list = Array.isArray(d.installed) ? d.installed : [];
    u.listError = '';
  } catch (e) {
    u.listError = e?.message || '接口不可达';
  }
}

/** 方式一：起草升级（复制已装扩展进暂存区）。 */
async function runUpgradeStart(kind, dir) {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !kind || !dir) return;
  u.starting = true; u.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/forge/upgrade-start', {
      method: 'POST',
      body: JSON.stringify({ kind, dir }),
      timeoutMs: 60000
    });
    u.starting = false;
    if (!d.ok) { u.error = d.error || '起草升级失败'; }
    else {
      u.draft = { draftId: d.draftId, kind: d.kind, dir: d.dir, id: d.id, name: d.name, version: d.version, source: 'chat', skipped: d.skipped };
      u.note = ''; u.result = null; u.done = null;
    }
  } catch (e) {
    u.starting = false;
    u.error = e?.message || '起草升级请求失败';
  }
  renderDoctorPage();
}

/** 对话升级：让模型按 note 改草稿。 */
async function runUpgradeChat() {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !u.draft) return;
  const ta = $('#upgrade-note');
  const note = (ta?.value || '').trim();
  if (!note) { ta?.focus(); return; }
  u.note = note;
  u.chatting = true; u.error = ''; u.result = null;
  renderDoctorPage();
  try {
    const d = await api('/api/forge/upgrade', {
      method: 'POST',
      body: JSON.stringify({ draftId: u.draft.draftId, note }),
      timeoutMs: 260000
    });
    u.chatting = false;
    if (!d.ok) { u.error = d.error || '升级失败'; }
    else {
      u.result = { summary: d.summary || '', trace: Array.isArray(d.trace) ? d.trace : [], gate: d.gate || null, diff: d.diff || null };
      u.installConfirm = false;
    }
  } catch (e) {
    u.chatting = false;
    u.error = e?.message || '升级请求失败';
  }
  renderDoctorPage();
}

/** 方式二：zip 升级包，解包 → 按 manifest.id 匹配已装扩展 → 对比"更新了什么"。 */
async function runUpgradeZip(file) {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !file) return;
  u.importing = true; u.error = ''; u.result = null; u.done = null;
  renderDoctorPage();
  try {
    const payload = await forgeFileToBase64(file);
    const imp = await api('/api/forge/import', {
      method: 'POST',
      body: JSON.stringify({ zipBase64: payload.zipBase64, zipName: payload.zipName }),
      timeoutMs: 60000
    });
    if (!imp.ok) {
      u.importing = false;
      u.error = imp.error || '解包失败';
      renderDoctorPage();
      return;
    }
    // 跑闸门拿 manifest.id，再匹配已装扩展
    const gd = await api('/api/forge/gate', {
      method: 'POST', body: JSON.stringify({ draftId: imp.draftId }), timeoutMs: 20000
    });
    const pkgId = String(gd?.gate?.manifest?.id || '');
    const target = u.list.find((it) => it.id === pkgId);
    if (!target) {
      u.importing = false;
      u.error = `升级包的 id 是「${pkgId || '（读不出）'}」，但没有匹配的已装扩展 —— 这是新扩展？去「自创扩展」页用导入安装。`;
      renderDoctorPage();
      return;
    }
    const cmp = await api('/api/forge/compare', {
      method: 'POST', body: JSON.stringify({ draftId: imp.draftId }), timeoutMs: 30000
    });
    u.importing = false;
    u.draft = { draftId: imp.draftId, kind: target.kind, dir: target.dir, id: target.id, name: target.name, version: target.version, source: 'zip', skipped: imp.skipped || [] };
    u.result = { summary: `导入包：${imp.zipName || '(未命名)'}，${(imp.files || []).length} 个文件。下面的对比是它相对已装版本的差异。`, trace: [], gate: gd.gate || null, diff: cmp?.ok ? cmp : null };
    u.installConfirm = false;
  } catch (e) {
    u.importing = false;
    u.error = e?.message || '升级包处理失败';
  }
  renderDoctorPage();
}

/** 确认升级：备份原版 → 覆盖安装。 */
async function runUpgradeInstall() {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !u.draft) return;
  u.installing = true; u.error = '';
  renderDoctorPage();
  try {
    // 覆盖已装扩展同样要人工确认票据（比装新的更不可逆），见 runForgeInstall 的说明。
    const ticket = await api('/api/forge/confirm', {
      method: 'POST',
      body: JSON.stringify({ draftId: u.draft.draftId, digest: u.result?.gate?.digest || '' }),
      timeoutMs: 20000
    });
    if (!ticket.ok) {
      u.installing = false;
      u.error = ticket.error || '确认失败（票据未签发）';
      if (ticket.gate) u.result = { ...(u.result || {}), gate: ticket.gate };
      renderDoctorPage();
      return;
    }
    const d = await api('/api/forge/upgrade-install', {
      method: 'POST',
      body: JSON.stringify({
        draftId: u.draft.draftId, kind: u.draft.kind, dir: u.draft.dir,
        confirmIssues: u.installConfirm,
        approvalToken: ticket.approvalToken
      }),
      timeoutMs: 60000
    });
    u.installing = false;
    if (!d.ok) {
      u.error = d.error || '升级安装失败';
      if (d.gate) u.result = { ...(u.result || {}), gate: d.gate };
    } else {
      u.done = d;
      u.draft = null; u.result = null; u.note = ''; u.installConfirm = false;
      refreshInBackground(loadUpgradeList, 'upgrade', '升级列表');
    }
  } catch (e) {
    u.installing = false;
    u.error = e?.message || '升级安装请求失败';
  }
  renderDoctorPage();
}

/** 放弃升级草稿（复用 forge 的 discard，草稿、快照、meta 一起清）。 */
async function runUpgradeDiscard() {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !u.draft) return;
  try {
    await api('/api/forge/discard', {
      method: 'POST', body: JSON.stringify({ draftId: u.draft.draftId }), timeoutMs: 15000
    });
  } catch { /* 丢弃失败不阻断界面复位 */ }
  Object.assign(u, { draft: null, result: null, note: '', installConfirm: false, error: '' });
  renderDoctorPage();
}

/** 回滚：恢复到最近一次升级前的备份。 */
async function runUpgradeRollback() {
  const u = doctorState.upgrade;
  if (upgradeBusy() || !u.done) return;
  u.installing = true; u.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/forge/rollback', {
      method: 'POST',
      body: JSON.stringify({ kind: u.done.kind, dir: u.done.dir }),
      timeoutMs: 60000
    });
    u.installing = false;
    if (!d.ok) { u.error = d.error || '回滚失败'; }
    else { u.done = null; refreshInBackground(loadUpgradeList, 'upgrade', '升级列表'); }
  } catch (e) {
    u.installing = false;
    u.error = e?.message || '回滚请求失败';
  }
  renderDoctorPage();
}

function bindForgeEvents(box) {
  // 模式切换（自己造 / 改别人的包）
  $$('[data-forge-mode]', box).forEach((el) => {
    el.addEventListener('click', () => {
      const m = el.getAttribute('data-forge-mode');
      if (m !== 'create' && m !== 'import') return;
      doctorState.forge.mode = m;
      renderDoctorPage();
    });
  });

  $('#forge-enable-btn')?.addEventListener('click', () => enablePluginInline('extension-forge', $('#forge-enable-btn'), async () => {
    // 启用了 extension-forge 之后重探一次状态（供本页 + 升级扩展子页共用）
    doctorState.forge.available = null;
    await loadForgeStatus();
    renderDoctorPage();
  }));
  $('#forge-retry-btn')?.addEventListener('click', async () => {
    doctorState.forge.available = null;
    await loadForgeStatus();
    renderDoctorPage();
  });

  $('#forge-again-btn')?.addEventListener('click', () => {
    const f = doctorState.forge;
    Object.assign(f, {
      installed: null, conflict: null, gate: null, gateBefore: null, files: [], trace: [],
      summary: '', draftId: '', error: '', allowConfirm: false,
      imported: null, diff: null
    });
    renderDoctorPage();
  });

  $('#forge-goto-btn')?.addEventListener('click', () => {
    const kind = doctorState.forge.installed?.kind === 'plugin' ? 'plugins' : 'skills';
    switchTab(kind);
  });

  $('#forge-draft-btn')?.addEventListener('click', () => runForgeDraft());

  const ta = $('#forge-req');
  ta?.addEventListener('input', () => {
    const f2 = doctorState.forge;
    // 「继续修改」模式下这个输入框装的是补充说明，必须与原始需求分开存，
    // 否则补充说明会覆盖 requirement（回填与后端兜底都会带上错误内容）
    if (f2.draftId && f2.gate && f2.gate.ok === false) f2.reviseNote = ta.value;
    else f2.requirement = ta.value;
  });
  ta?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      runForgeDraft();
    }
  });

  // ── 导入第三方包 ──
  $('#forge-file')?.addEventListener('change', (e) => {
    const files = e.target.files;
    if (files && files.length) runForgeImport(files[0]);
  });
  const drop = $('#forge-drop');
  if (drop) {
    // dragover 必须 preventDefault，否则浏览器不会触发 drop
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
      const f0 = e.dataTransfer?.files?.[0];
      if (f0) runForgeImport(f0);
    });
  }
  $('#forge-adapt-btn')?.addEventListener('click', () => runForgeAdapt());
  // 补充说明边打边存，适配过程中状态重绘会重建输入框，只靠 value 回填会丢字
  $('#forge-adapt-note')?.addEventListener('input', (e) => { doctorState.forge.adaptNote = e.target.value; });

  $('#forge-allow-confirm')?.addEventListener('change', (e) => {
    doctorState.forge.allowConfirm = !!e.target.checked;
    // 只重画结果区，别把输入框内容弄丢
    const box2 = $('#doctor-sub-body');
    if (box2) { box2.innerHTML = renderForgeModule(); bindForgeEvents(box2); }
  });

  $('#forge-install-btn')?.addEventListener('click', () => runForgeInstall());
  $('#forge-discard-btn')?.addEventListener('click', () => discardForgeDraft(doctorState.forge.draftId));
  $('#forge-conflict-upgrade-btn')?.addEventListener('click', () => switchDoctorSub('upgrade'));

  $$('[data-forge-drop-draft]', box).forEach((el) => {
    el.addEventListener('click', () => discardForgeDraft(el.getAttribute('data-forge-drop-draft')));
  });
  $$('[data-forge-open]', box).forEach((el) => {
    el.addEventListener('click', () => openForgeDraft(el.getAttribute('data-forge-open')));
  });
}

/** 查锻造台状态 + 草稿列表。 */
async function loadForgeStatus() {
  const f = doctorState.forge;
  try {
    const d = await api('/api/forge', { timeoutMs: 15000 });
    f.available = d.available !== false;
    f.drafts = Array.isArray(d.drafts) ? d.drafts : [];
    if (!f.available) f.error = '';
  } catch (e) {
    f.available = false;
    f.error = e?.message || '锻造台接口不可达';
  }
}

/**
 * 锻造台是否正忙（起草 / 导入 / 适配 / 安装任一在跑）。
 *
 * 必须统一判而不是各守各的标志：这四个动作都会写 f.draftId / f.files / f.gate，
 * 只看自己那一个标志的话，"起草中还去点导入"会让两个请求同时在飞，
 * 谁后返回谁说了算，界面出现"文件和草稿对不上"。它们本该互斥。
 * 安装也纳入：安装期间草稿被改会让闸门结论与落地内容不一致。
 */
function forgeBusy() {
  const f = doctorState.forge;
  return !!(f.drafting || f.importing || f.adapting || f.installing);
}


async function runForgeDraft() {
  const f = doctorState.forge;
  if (forgeBusy()) return;
  // 「继续修改」判定必须在清状态之前算好（f.gate 马上会被置空）：
  // 当前展示的草稿存在且闸门没过 → 这次点击是在原草稿上修，而不是新建。
  const revise = !!(f.draftId && f.gate && f.gate.ok === false);
  const ta = $('#forge-req');
  const req = (ta?.value || '').trim();
  // 新建模式必须有需求描述；修改模式下输入框是"补充说明"，可以为空（模型按闸门问题清单修）
  if (!req && !revise) { ta?.focus(); return; }
  if (req.length > 2000) { f.error = '需求描述太长了（上限 2000 字）'; renderDoctorPage(); return; }
  // 小白保护（软提示，不阻断）：需求太短 = 模型只能靠猜，猜错的返工成本比多写一句高。
  // 仍然允许直接起草（有些需求一句话就够清楚，比如"做个掷骰子工具"）。
  if (!revise && req.length < 15) {
    // 原生 confirm 会阻塞渲染进程，理由见 runFixDelete
    const go = await qaConfirm({
      title: '需求是不是太短了？',
      confirmText: '仍然起草',
      cancelText: '我再去补充',
      message: `需求只有 ${req.length} 个字 —— 模型会靠"猜"来补全细节，做出来可能不是你想要的。\n\n建议按三要素补充：①做什么 ②什么时候用 ③返回什么（例如：查今天星座运势；有人问运势时用；返回文字版运势）。\n\n仍然直接起草吗？`
    });
    if (!go) { ta?.focus(); return; }
  }

  const prevGate = f.gate;
  if (!revise) f.requirement = req;   // 修改轮不动原始需求，输入框里装的是补充说明
  f.drafting = true; f.revising = revise; f.error = ''; f.gate = null; f.files = []; f.trace = [];
  f.summary = ''; f.installed = null; f.allowConfirm = false; f.autoFix = 0; f.plan = '';
  f.conflict = null; f.imported = null; f.diff = null;
  f.gateBefore = revise ? prevGate : null;   // 修改轮保留"改前"结论，结果区给"改前→改后"对照
  renderDoctorPage();

  try {
    const d = await api('/api/forge/draft', {
      method: 'POST',
      // 修改轮带 draftId（后端据此读取现有文件 + 闸门问题清单注入 prompt），
      // requirement 传会话内记忆的原始需求（老草稿没有元数据时的兜底），note 传补充说明。
      body: JSON.stringify(revise
        ? { draftId: f.draftId, requirement: f.requirement || '', note: req }
        : { requirement: req }),
      timeoutMs: 560000   // 后端最坏 = 计划 30s + 起草 240s + 自动修复 2×240s ≈ 510s，前端留余量
    });
    f.drafting = false; f.revising = false;
    if (!d.ok) { f.error = d.error || '起草失败'; }
    else {
      f.reviseNote = '';   // 补充说明已消费（进了模型的 prompt），清掉防止误带回填
      f.draftId = d.draftId || '';
      f.summary = d.summary || '';
      f.autoFix = Number(d.autoFixAttempts) || 0;
      f.plan = typeof d.plan === 'string' ? d.plan : '';
      f.trace = Array.isArray(d.trace) ? d.trace : [];
      f.gate = d.gate || null;
      // 拉一次代码内容（起草接口只回结论，代码单独取，避免响应体过大）
      if (f.draftId) {
        try {
          const rd = await api('/api/forge/read', {
            method: 'POST', body: JSON.stringify({ draftId: f.draftId }), timeoutMs: 15000
          });
          f.files = Array.isArray(rd.files) ? rd.files : [];
        } catch { f.files = []; }
      }
    }
    await loadForgeStatus();
  } catch (e) {
    f.drafting = false; f.revising = false;
    f.error = e?.message || '起草请求失败';
  }
  renderDoctorPage();
}

/** 安装。 */
async function runForgeInstall() {
  const f = doctorState.forge;
  if (forgeBusy() || !f.draftId) return;
  f.installing = true; f.error = '';
  renderDoctorPage();
  try {
    // ① 先签人工确认票据。
    //    闸门通过 ≠ 可以装：静态扫描是启发式的，它回答"这份东西看着安全吗"，
    //    回答不了"有人同意装它吗"。票据由后端签发，只认控制台发起的请求
    //    （渲染进程私有凭据），并且绑死"界面上这一刻"的内容摘要，
    //    确认期间草稿若被改过，签名会直接失败，让你重新核对而不是悄悄装新版。
    const ticket = await api('/api/forge/confirm', {
      method: 'POST',
      body: JSON.stringify({ draftId: f.draftId, digest: f.gate?.digest || '' }),
      timeoutMs: 20000
    });
    if (!ticket.ok) {
      f.installing = false;
      f.error = ticket.error || '确认失败（票据未签发）';
      if (ticket.gate) f.gate = ticket.gate;
      renderDoctorPage();
      return;
    }
    // ② 带票安装
    const d = await api('/api/forge/install', {
      method: 'POST',
      body: JSON.stringify({
        draftId: f.draftId,
        confirmIssues: f.allowConfirm,
        approvalToken: ticket.approvalToken
      }),
      timeoutMs: 30000
    });
    f.installing = false;
    if (d.ok) {
      f.installed = d;
      await loadForgeStatus();
    } else if (d.conflict) {
      // 同 id 已装：这不是"安装失败"，是"这里已经有一个同名扩展"。
      // 笼统报一句错误会让人反复重试（结果每次都一样），必须说清现状与两条出路。
      f.conflict = d.existing || {};
      f.error = d.error || '同名扩展已安装';
      if (d.gate) f.gate = d.gate;
    } else {
      f.error = d.error || '安装失败';
      if (d.gate) f.gate = d.gate;
    }
  } catch (e) {
    f.installing = false;
    f.error = e?.message || '安装请求失败';
  }
  renderDoctorPage();
}

/**
 * 丢弃草稿。
 *
 * 必须二次确认（对齐 runFixDelete 的 qaConfirm 用法）：丢掉的草稿内容与快照
 * 一并删除，市场来源的还会连原始包一起删 —— 反悔只能重新下载，而口令未必还在
 * 手上。市场来源与非市场来源的后果不同，提示语分开写，让人知道自己在删什么。
 */
async function discardForgeDraft(draftId) {
  if (!draftId) return;
  const f = doctorState.forge;
  // 来源以草稿列表里的 source 为准（后端 _meta 里的 origin 字段，由市场下载时写入）。
  // 列表可能还没加载过（刚点开页面就点删除），那种情况按"未安装草稿"处理：
  // 提示语更保守，不会让人误以为只是删了个下载缓存。
  const fromMarket = (f.drafts || []).some((d) => d.draftId === draftId && d.source === 'market');
  const ok = await qaConfirm({
    title: fromMarket ? '删除市场来源的草稿' : '丢弃草稿',
    danger: true,
    confirmText: fromMarket ? '删除' : '丢弃',
    cancelText: '取消',
    message: fromMarket
      ? '删除市场来源的草稿？原始包会一起删除，只能重新下载。'
      : '丢弃这个草稿？草稿内容会删除，需要时得重新下载。'
  });
  if (!ok) return;
  try {
    await api('/api/forge/discard', {
      method: 'POST', body: JSON.stringify({ draftId }), timeoutMs: 15000
    });
  } catch { /* 丢弃失败不阻断，下面刷新状态时自然会暴露 */ }
  if (f.draftId === draftId) {
    Object.assign(f, {
      draftId: '', gate: null, gateBefore: null, files: [], trace: [],
      summary: '', allowConfirm: false, imported: null, diff: null, conflict: null
    });
  }
  await loadForgeStatus();
  renderDoctorPage();
}

/**
 * 导入第三方 zip：读成 base64 → 后端解到暂存区 → 展示清单与闸门结论。
 * 这里只导入，不安装：安装是用户看过代码之后的独立动作。
 */
async function runForgeImport(file) {
  const f = doctorState.forge;
  if (forgeBusy() || !file) return;

  f.importing = true; f.error = '';
  f.imported = null; f.diff = null; f.gateBefore = null;
  f.gate = null; f.files = []; f.trace = []; f.summary = '';
  f.installed = null; f.conflict = null; f.allowConfirm = false;
  renderDoctorPage();

  try {
    // 复用「本地导入」那套取内容的方式（桌面端反查真实路径，浏览器退化为 base64）。
    // 这里只要 base64，后端走的是"字节进暂存区"，不是"按路径读盘"，
    // 所以刻意不用 paths 分支：第三方文件的来源路径不该被消费。
    const payload = await forgeFileToBase64(file);
    const d = await api('/api/forge/import', {
      method: 'POST',
      body: JSON.stringify({ zipBase64: payload.zipBase64, zipName: payload.zipName }),
      timeoutMs: 60000
    });
    f.importing = false;

    if (!d.ok) {
      f.error = d.error || '导入失败';
      // 安全拒绝与"读不了"要给不同的话，前者是包的问题，后者是文件的问题
      if (d.rejected) f.error = `⛔ 这个包被安全校验拒绝：${d.error}`;
    } else {
      f.draftId = d.draftId || '';
      f.gate = d.gate || null;
      f.imported = { zipName: d.zipName, files: d.files || [], skipped: d.skipped || [] };
      await refreshForgeFiles();
    }
    await loadForgeStatus();
  } catch (e) {
    f.importing = false;
    f.error = e?.message || '导入失败';
  }
  renderDoctorPage();
}

/** 把 File 读成 base64（只接受 zip）。 */
async function forgeFileToBase64(file) {
  if (!/\.zip$/i.test(file.name || '')) {
    throw new Error(`「${file.name}」不是 zip 包；请先把它压缩成 .zip 再拖进来`);
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error(`「${file.name}」有 ${(file.size / 1024 / 1024).toFixed(1)}MB，超过 8MB 上限`);
  }
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  // 分块拼接：一次性 apply 整个大数组会爆调用栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return { zipBase64: btoa(binary), zipName: file.name };
}

/** 拉一次当前草稿的文件内容（导入后、适配后都要更新视图）。 */
async function refreshForgeFiles() {
  const f = doctorState.forge;
  if (!f.draftId) { f.files = []; return; }
  try {
    const rd = await api('/api/forge/read', {
      method: 'POST', body: JSON.stringify({ draftId: f.draftId }), timeoutMs: 20000
    });
    f.files = Array.isArray(rd.files) ? rd.files : [];
  } catch { f.files = []; }
}

/** 让模型把草稿适配到本机环境。 */
async function runForgeAdapt(noteOverride = null) {
  const f = doctorState.forge;
  if (forgeBusy() || !f.draftId) return;
  // note 与按钮同时读：后端支持补充说明（已拼进适配 prompt），这里只是把口子接到 UI。
  // noteOverride 给"自动开始的适配"用（市场安装后直接开跑，没有输入框可读）。
  const note = (noteOverride ?? ($('#forge-adapt-note')?.value || '')).trim().slice(0, 1000);
  f.adapting = true; f.error = ''; f.diff = null;
  renderDoctorPage();

  try {
    const d = await api('/api/forge/adapt', {
      method: 'POST',
      body: JSON.stringify({ draftId: f.draftId, note }),
      // 预算配套：后端适配 = 前置闸门 + 最多 2 段 × 240s + 后置闸门/diff + 余量。
      // 改动 routes.js 的 ADAPT_SEGMENT_MS / ADAPT_MAX_SEGMENTS 时必须同步这里，别让两层漂移。
      timeoutMs: 560000
    });
    f.adapting = false;
    if (!d.ok) {
      f.error = d.error || '适配失败';
    } else {
      f.adaptNote = '';   // 已消费：成功后清空，避免下次误带旧说明
      f.gateBefore = d.gateBefore || f.gate;
      f.gate = d.gate || null;
      // 时间用尽但有进展：把"已改多少 / 还剩多少阻断"说清楚（超时也交付现场，不再全丢）
      const sm = d.diff?.summary || {};
      const changed = Number(sm.added || 0) + Number(sm.changed || 0) + Number(sm.removed || 0);
      const blocking = Number(d.gate?.blocking || 0);
      f.summary = (d.timedOut
        ? `⏱ 本轮时间用尽（已保留进度）：改动 ${changed} 个文件，闸门阻断还剩 ${blocking} 项。可再次点击「让模型适配到本机」从当前草稿接着改。\n`
        : '') + (d.summary || '');
      f.trace = Array.isArray(d.trace) ? d.trace : [];
      f.diff = d.diff || null;
    }
    // 失败也要刷新文件列表：草稿可能已被改了一部分（写工具是即时落盘的），
    // 不给用户看现场，他会以为"什么都没发生"。
    await refreshForgeFiles();
    await loadForgeStatus();
  } catch (e) {
    f.adapting = false;
    f.error = e?.message || '适配请求失败';
    await refreshForgeFiles();
    await loadForgeStatus();
  }
  renderDoctorPage();
}

/** 打开一个已有草稿：读代码 + 重跑闸门。 */
async function openForgeDraft(draftId) {
  const f = doctorState.forge;
  f.draftId = draftId; f.error = ''; f.installed = null; f.conflict = null; f.allowConfirm = false;
  f.imported = null; f.diff = null; f.gateBefore = null; f.oversizeLost = [];
  // 草稿列表可能还没加载过（刚切到这一页就点开老草稿）：先取一次，
  // 否则"这份包当初少解出哪些文件"的记录会取不到。
  if (!Array.isArray(f.drafts) || !f.drafts.length) await loadForgeStatus();
  renderDoctorPage();
  try {
    const [rd, gd] = await Promise.all([
      api('/api/forge/read', { method: 'POST', body: JSON.stringify({ draftId }), timeoutMs: 15000 }),
      api('/api/forge/gate', { method: 'POST', body: JSON.stringify({ draftId }), timeoutMs: 20000 })
    ]);
    // 丢弃过期响应：两个请求各要几秒，用户完全可能在等待期间点开另一个草稿。
    // 没有这道判断，先发的响应后到就会把界面刷成另一个草稿的内容，
    // 而顶部 draftId 已经是新的，文件和草稿对不上，比"没反应"更难排查。
    // 这类竞态靠禁用按钮治不了：按钮在 await 期间是活的。
    if (f.draftId !== draftId) return;
    f.files = Array.isArray(rd.files) ? rd.files : [];
    f.gate = gd.gate || null;
    f.summary = '';
    f.trace = [];
    // 解包残缺记录只在导入那一刻的响应里，重新打开草稿时从草稿列表（/api/forge）
    // 里取回：少了文件的包事后也得能提醒，否则隔天回来只看到"已过闸 · 待安装"。
    const row = (f.drafts || []).find((d) => d.draftId === draftId);
    f.oversizeLost = Array.isArray(row?.skippedOversize) ? row.skippedOversize : [];
  } catch (e) {
    if (f.draftId !== draftId) return;
    f.error = e?.message || '打开草稿失败';
  }
  renderDoctorPage();
}

/**
 * 从别处（市场安装 / 批量口令）一步进到锻造台：切页 → 打开草稿 → 直接开始适配。
 *
 * 用户点的是「安装」，心里想的是"装好就能用"。中间那几步（记住草稿 id →
 * 切到 harness → 在草稿堆里找到它 → 点查看 → 点适配）全是系统视角的步骤，
 * 能省的都省掉，只留真正需要人的那一步：看闸门结论、点确认安装。
 *
 * 自动开始适配不构成"未经确认就安装"：适配只写暂存区，碰不到 skills/ 与 plugins/，
 * 落地仍然必须由人签票（见 /api/forge/confirm）。
 */
async function forgeOpenAndAdapt(draftId, { adapt = true } = {}) {
  if (!draftId) return;
  const f = doctorState.forge;
  // 有任务在跑就不抢：两个适配同时写同一份草稿会互相覆盖，比"没自动开始"糟得多。
  // 但仍然把人送到锻造台，他要看的是"现在在忙什么"，而不是回到原页面什么都不知道。
  if (forgeBusy()) {
    doctorState.sub = 'forge';
    switchTab('harness');
    return;
  }
  doctorState.sub = 'forge';
  switchTab('harness');
  await loadForgeStatus();
  await openForgeDraft(draftId);
  if (!adapt) return;
  // 打开失败（草稿被删 / 接口报错）就别硬跑适配，那只会拿一个空草稿去烧 token
  if (f.draftId !== draftId || f.error || !f.files?.length) return;
  // 自动跑的这一轮要收着改：它没有输入框可写补充说明，默认话术把范围钉死在
  // "装得上、跑得起来"，避免对本来就好用的包做无谓重写（那种改动最容易被用户当成"改坏了"）。
  await runForgeAdapt(
    '（自动适配）这是刚从市场下载的第三方扩展包。只做让它在本机装得上、装完能工作所必需的'
    + '最小修改：清单字段缺失/非法、apiVersion 或入口对不上、requires 了本机没有的能力、'
    + '调用了本地不存在的 api 成员。若它本来就能正常安装与运行，不要改任何代码，直接说明即可。'
  );
}

function scrollDoctorChatToBottom() {
  const log = $('#doctor-chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

/** 只重绘项目扫描区（过滤切换 / 扫描完成后用，不重建整页）。 */
function repaintDoctorProject() {
  const wrap = $('#harness-page')?.querySelector('.doctor-proj-wrap');
  if (!wrap) return;
  // 同样必须走 renderProjectSection()：直接拼标题会把操作条冲掉。
  wrap.innerHTML = renderProjectSection();
  bindProjectEvents();
  syncTriageTopButton();
}

/**
 * 同步顶栏「让模型自检」按钮的文案/禁用态。
 * 顶栏在项目区之外，repaintDoctorProject 换不到它，所以单独同步一次。
 * 也顺带禁用「扫描项目」，审阅期间再点扫描会把候选集换掉，结论就对不上了。
 */
function syncTriageTopButton() {
  const b = $('#doctor-triage-top-btn');
  if (b) {
    b.disabled = !!doctorState.triaging || !!doctorState.scanning;
    b.textContent = doctorState.triaging ? '审阅中…' : '让模型自检';
  }
  const s = $('#doctor-scan-btn');
  if (s) {
    s.disabled = !!doctorState.scanning || !!doctorState.triaging;
    s.textContent = doctorState.scanning ? '扫描中…' : '扫描项目';
  }
}

/** 重新绑定项目区内的控件（内容被 innerHTML 换掉后旧监听就没了）。 */
function bindProjectEvents() {
  $('#doctor-proj-filter')?.addEventListener('change', (e) => {
    doctorState.projectRule = e.target.value || '';
    repaintDoctorProject();
  });
  $('#doctor-triage-btn')?.addEventListener('click', () => runTriage());
  $$('[data-triage-filter]').forEach((el) => {
    el.addEventListener('click', () => {
      doctorState.triageFilter = el.getAttribute('data-triage-filter') || '';
      repaintDoctorProject();
    });
  });
}

/**
 * 跑一次"模型逐个审"。
 * @param {{ autoScan?: boolean }} opts
 *   autoScan=true 时，若还没扫过项目就先扫一遍再交给模型（顶栏一键链路的用法）。
 */
async function runTriage(opts = {}) {
  if (doctorState.triaging) return;
  // 因为按钮可能插在别处（例如原生工具栏），补一个 onTriage 回调
  const emit = () => { try { opts.onTriage?.(); } catch { /* 回调炸了不影响主流程 */ } };
  // 没扫过 → 先扫（顶栏按钮不该要求用户先手动点一次"扫描项目"）
  if (!doctorState.project && opts.autoScan !== false) {
    await runProjectScan();
    if (!doctorState.project) return;   // 扫描就失败了，错误已进对话区
  }
  if (!doctorState.project) return;

  // 一眼看上去就没有可审项 → 直接说清楚，不必白跑一趟模型
  const sev = doctorState.project.bySeverity || {};
  if (!((sev.warning || 0) + (sev.critical || 0))) {
    doctorState.turns.push({
      role: 'assistant',
      at: Date.now(),
      text: '静态扫描没有发现「警告 / 严重」级候选，模型无需介入。\n\n'
        + `（提示级 ${sev.info || 0} 条不送模型 —— 那些是 console.log / TODO 这类，为它们花 token 不值。）`
    });
    repaintDoctorChat();
    emit();
    return;
  }

  doctorState.triaging = true;
  doctorState.triageProg = { done: 0, total: 0, file: '' };
  doctorState.triage = null;
  doctorState.triageFilter = '';
  repaintDoctorProject();
  emit();
  try {
    const d = await api('/api/doctor/triage', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 15 * 60 * 1000      // 逐个审可能几分钟，给足
    });
    if (d.ok) {
      doctorState.triage = { entries: d.entries || [], stats: d.stats || {}, model: d.model || '' };
    } else {
      doctorState.turns.push({ role: 'assistant', text: `⚠️ 模型审阅未完成：${d.error || '未知原因'}` });
      repaintDoctorChat();
    }
  } catch (e) {
    doctorState.turns.push({ role: 'assistant', text: `⚠️ 模型审阅请求失败：${e?.message || e}` });
    repaintDoctorChat();
  } finally {
    doctorState.triaging = false;
    doctorState.triageProg = null;
    repaintDoctorProject();
    emit();
  }
}

/** 跑一次全项目扫描。 */
async function runProjectScan() {
  if (doctorState.scanning) return;
  doctorState.scanning = true;
  // 禁用态一律交给 syncTriageTopButton()（repaintDoctorProject 里会调），
  // 这里不再手动改按钮，两处都写会互相覆盖。
  repaintDoctorProject();

  try {
    const d = await api('/api/doctor/scan-project', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 60000
    });
    if (d.ok && d.result) {
      doctorState.project = d.result;
      doctorState.projectRule = '';
    } else {
      doctorState.project = null;
      doctorState.turns.push({ role: 'assistant', text: `⚠️ 项目扫描失败：${d.error || '未知原因'}` });
      repaintDoctorChat();
    }
  } catch (e) {
    doctorState.project = null;
    doctorState.turns.push({ role: 'assistant', text: `⚠️ 项目扫描请求失败：${e?.message || e}` });
    repaintDoctorChat();
  } finally {
    doctorState.scanning = false;
    repaintDoctorProject();   // 顺带把顶栏两个按钮恢复成可点
  }
}

/** 只重绘对话区（追加一轮问答时不重建整页，避免输入框失焦 / 滚动跳动）。 */
function repaintDoctorChat() {
  const log = $('#doctor-chat-log');
  if (log) log.innerHTML = renderDoctorTurns();
  scrollDoctorChatToBottom();
}

// ── 模型设置弹窗 ──────────────────────────────────────────────────────────
/*
 * 「自检专用模型」：默认关闭 = 跟随全局（和群聊同一套）。
 * 打开 = 这一页的「对话排查」走独立端点/模型/密钥，例如用小模型省钱，
 * 或诊断流量导到另一个网关避开群聊限流。
 *
 * 密钥是"只写不读"的：sanitizeConfig 把 doctorApi.apiKey 脱敏成 hasApiKey 布尔，
 * 前端拿不到明文，所以输入框初始必须留空，placeholder 提示"留空=不修改"。
 * 用户点眼睛时才走 /api/doctor/config-key 取明文（该端点有来源校验）。
 */
async function openDoctorModelDialog() {
  let data;
  try {
    data = await api('/api/doctor/config', { timeoutMs: 15000 });
  } catch (e) {
    doctorState.turns.push({ role: 'assistant', text: `⚠️ 读取模型配置失败：${e?.message || e}` });
    repaintDoctorChat();
    return;
  }
  const c = data.config || {};
  const g = data.global || {};

  const overlay = modelModalShell({
    head: '自检专用模型',
    closeOnBackdrop: false,   // 编辑型：点外部不关闭，防误触丢内容
    body: `
      <div class="doctor-cfg-note">
        关闭时<b>跟随全局</b>（当前：<code>${esc(g.model || '未配置')}</code> @ <code>${esc(g.baseUrl || '未配置')}</code>）。
        打开后本页的「对话排查」走下面这套，<b>群聊与记忆整理不受影响</b>。
      </div>
      <label class="doctor-cfg-row doctor-cfg-toggle">
        <input type="checkbox" id="dc-enabled"${c.enabled ? ' checked' : ''} />
        <span>使用独立配置</span>
      </label>
      <div id="dc-fields" class="${c.enabled ? '' : 'is-muted'}">
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">Base URL</span>
          <input type="text" id="dc-baseurl" placeholder="https://api.deepseek.com/v1" value="${esc(c.baseUrl || '')}" />
        </label>
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">模型</span>
          <input type="text" id="dc-model" placeholder="deepseek-flash" value="${esc(c.model || '')}" />
        </label>
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">API Key</span>
          <span class="doctor-cfg-keywrap">
            <input type="password" id="dc-apikey" placeholder="${c.hasApiKey ? '已配置（留空 = 不修改）' : '尚未配置'}" value="" />
            <button class="btn btn-small doctor-cfg-eye" type="button" id="dc-eye" title="显示当前密钥">显示</button>
          </span>
        </label>
        ${c.hasApiKey ? '<div class="doctor-cfg-hint">已保存一把密钥。要清空它，勾选下面的「清除已保存的密钥」。</div>' : ''}
        <label class="doctor-cfg-row doctor-cfg-toggle">
          <input type="checkbox" id="dc-clear" />
          <span>清除已保存的密钥</span>
        </label>
      </div>
      <div class="doctor-cfg-err" id="dc-err" hidden></div>`,
    foot: `
      <button class="btn doctor-cfg-cancel" type="button">取消</button>
      <button class="btn btn-primary doctor-cfg-save" type="button">保存</button>`
  });

  const $f = (s) => overlay.querySelector(s);
  const errEl = $f('#dc-err');
  const showErr = (m) => { errEl.textContent = m; errEl.hidden = !m; };

  // 勾选框联动：关掉时把字段灰掉（表达"这套暂时不生效"）
  const toggleFields = () => {
    const on = $f('#dc-enabled').checked;
    $f('#dc-fields').classList.toggle('is-muted', !on);
  };
  $f('#dc-enabled').addEventListener('change', toggleFields);

  // 显示明文：仅在用户点眼睛时向带来源校验的端点取一次，取到后切回按钮可再次隐藏
  let plainShown = false;
  let plainKey = null;
  $f('#dc-eye').addEventListener('click', async () => {
    const input = $f('#dc-apikey');
    const btn = $f('#dc-eye');
    if (plainShown) {
      input.value = '';
      input.type = 'password';
      btn.textContent = '显示';
      plainShown = false;
      return;
    }
    try {
      if (plainKey === null) {
        const r = await api('/api/doctor/config-key', { timeoutMs: 15000 });
        plainKey = r.apiKey || '';
      }
      if (!plainKey) { showErr('没有已保存的密钥可显示。'); return; }
      input.value = plainKey;
      input.type = 'text';
      btn.textContent = '隐藏';
      plainShown = true;
      showErr('');
    } catch (e) {
      showErr(`读取明文密钥失败：${e?.message || e}`);
    }
  });

  // 用户手动改过输入框后，眼睛的"显示原值"语义就失效了
  $f('#dc-apikey').addEventListener('input', () => { plainShown = false; plainKey = null; });

  $f('.doctor-cfg-cancel').addEventListener('click', () => closeModelModal(overlay));
  $f('.doctor-cfg-save').addEventListener('click', async () => {
    const payload = {
      enabled: $f('#dc-enabled').checked,
      baseUrl: $f('#dc-baseurl').value.trim(),
      model: $f('#dc-model').value.trim()
    };
    const kv = $f('#dc-apikey').value.trim();
    // 空 = 不修改（前端拿不到原文，无法回传）；填了才覆盖
    if (kv) payload.apiKey = kv;
    if ($f('#dc-clear').checked) payload.clearApiKey = true;

    // 前端先做一遍显而易见的校验，省一次往返
    if (payload.enabled && !payload.model) { showErr('启用独立配置时必须填模型名。'); return; }
    if (payload.enabled && !payload.baseUrl) { showErr('启用独立配置时必须填 Base URL。'); return; }

    const btn = $f('.doctor-cfg-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await api('/api/doctor/config', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: 15000
      });
      closeModelModal(overlay);
      // 配置变了，把当前模型提示同步给对话区。
      //
      // 这条提示写在对话里，所以必须确保用户在对话模块上才看得见，
      // 否则（比如在「自检系统」里改配置）弹窗一关就什么反馈都没有。
      // 这里直接切过去，而不是另造一套 toast。
      if (doctorState.sub !== 'chat') switchDoctorSub('chat');
      doctorState.turns.push({
        role: 'assistant',
        text: payload.enabled
          ? `已切换为独立配置：\`${payload.model}\` @ \`${payload.baseUrl}\`。之后的排查走这套。`
          : '已改回跟随全局模型。'
      });
      repaintDoctorChat();
    } catch (e) {
      showErr(`保存失败：${e?.message || e}`);
      btn.disabled = false;
      btn.textContent = '保存';
    }
  });
}

// ── 数据交互 ──────────────────────────────────────────────────────────────

/**
 * 忽略 / 恢复体检单上的一条问题。
 *
 * key = `${area}|${id}`（与后端 ackKeyOf 一致）；restore-all 时 key 传空串。
 * 体检单的问题都是从磁盘现状推导的，用户自查后确认某条无妨，原先没有任何地方
 * 能表达"我知道了"，下次体检原样回来，一直挂在警告位上。
 * 忽略清单落盘在后端（data/plugin-data/self-doctor/acked.json），重启后仍生效。
 */
async function ackIssue(key, action = 'ignore') {
  const [area = '', id = ''] = key.split('|');
  const items = action === 'restore-all' ? [] : [{ area, id }];
  try {
    const d = await api('/api/doctor/ack', {
      method: 'POST',
      body: JSON.stringify({ action, items }),
      timeoutMs: 15000
    });
    if (!d.ok) { doctorState.ackMsg = d.error || '忽略操作失败'; renderDoctorPage(); return; }
    doctorState.ackMsg = '';
  } catch (e) {
    // 不用 doctorState.error，那会把整个自检模块替换成出错占位，
    // 一次忽略失败不该炸掉整页体检单。只在报告顶部显示一行。
    doctorState.ackMsg = e?.message || '忽略操作失败';
    renderDoctorPage();
    return;
  }
  // 静默刷新即可：5 分钟缓存在 provider 侧会重套忽略清单，不必强制重扫
  // （force 要等满扫完成，忽略这种纯本地操作不该有那个等待）。
  await loadHarnessPage({ quiet: true });
}

async function loadHarnessPage({ quiet = false, force = false } = {}) {
  const box = $('#harness-page');
  if (!box) return;
  // 已经渲染过正式内容且是 quiet 轮询：不动 DOM，只静默刷新数据
  const hasContent = !!box.querySelector('.doctor-report, .doctor-chat-wrap');

  if (force) {
    // 强制重扫最长要等 60s；先把按钮切成"扫描中…"并禁用，
    // 否则用户点了按钮后界面毫无反馈，只会以为点空了而反复点。
    doctorState.running = true;
    renderDoctorPage();
  } else if (!quiet && !hasContent) {
    doctorState.loading = true;
    renderDoctorPage();
  }

  try {
    const path = force ? '/api/doctor/run' : '/api/doctor';
    const data = force
      ? await api(path, { method: 'POST', body: '{}', timeoutMs: 60000 })
      : await api(path, { timeoutMs: 30000 });

    doctorState.error = '';
    doctorState.ackMsg = '';
    doctorState.available = data.available !== false;
    if (data.ok && data.report) doctorState.report = data.report;
    // 后端明确报错（如执行失败）也展示出来，但不算"后端不可达"
    if (!data.ok && data.error) doctorState.error = data.error;
  } catch (e) {
    doctorState.error = e?.message || '体检接口调用失败';
  } finally {
    doctorState.loading = false;
    doctorState.running = false;
  }
  renderDoctorPage();

  // 停在「自创扩展」子模块时，顺带拉一次锻造台状态，
  // 那是另一个插件的数据，体检接口不会带回来（表现会是"永远显示未探测"）。
  if (doctorState.sub === 'forge' && doctorState.forge.available === null) {
    refreshForgeStatusInBackground();
  }

  // 首次进「自检系统」时自动取一次哨兵量表：量表是这一页的主信息，
  // 让用户先看到一个空框再自己去点按钮，等于白做。
  // 只在哨兵为空时拉，且不挂进定时刷新：每取一次要读 24 个 session
  // 文件（实测约 300ms），秒级变化也没有，轮询纯属浪费。
  if (doctorState.sub === 'checkup' && doctorState.available !== false
      && !doctorState.sentinel && !doctorState.sentinelLoading) {
    runSentinel();
  }
}

async function askDoctor() {
  if (doctorState.asking) return;
  const ta = $('#doctor-q');
  const question = (ta?.value || '').trim();
  if (!question) { ta?.focus(); return; }
  if (question.length > 2000) {
    doctorState.turns.push({ role: 'assistant', text: '问题太长了（上限 2000 字），精简一下再问。' });
    repaintDoctorChat();
    return;
  }

  doctorState.turns.push({ role: 'user', text: question, at: Date.now() });
  if (ta) ta.value = '';
  doctorState.asking = true;
  // 占位气泡：告诉用户"在想"，而不是界面卡住。
  // 模型会自己去读日志/源码（可能要跑好几轮），文案要预先说明"会去看文件"，
  // 否则用户等 30 秒会以为卡死。
  doctorState.turns.push({
    role: 'assistant',
    text: '_正在分析…（模型会自己去读相关的源码与日志，可能需要十几秒到一分钟）_',
    at: Date.now(),
    pending: true
  });
  repaintDoctorChat();

  const btn = $('#doctor-send-btn');
  if (btn) { btn.disabled = true; btn.textContent = '分析中…'; }

  try {
    const data = await api('/api/doctor/ask', {
      method: 'POST',
      body: JSON.stringify({ question }),
      timeoutMs: 200000   // 后端 180s 超时（工具循环可能跑多轮），前端留 20s 余量
    });
    // 摘掉占位
    const i = doctorState.turns.findIndex((t) => t.pending);
    if (i >= 0) doctorState.turns.splice(i, 1);

    if (data.ok && data.answer) {
      doctorState.turns.push({
        role: 'assistant',
        text: String(data.answer),
        at: Date.now(),
        model: data.model + (data.toolsEnabled ? ` · 取证 ${data.toolCount} 工具 / ${data.rounds} 轮` : ''),
        trace: Array.isArray(data.trace) ? data.trace : []
      });
    } else {
      doctorState.turns.push({ role: 'assistant', text: `⚠️ ${data.error || '没有得到回答'}`, at: Date.now() });
    }
  } catch (e) {
    const i = doctorState.turns.findIndex((t) => t.pending);
    if (i >= 0) doctorState.turns.splice(i, 1);
    doctorState.turns.push({ role: 'assistant', text: `⚠️ 请求失败：${e?.message || e}`, at: Date.now() });
  } finally {
    doctorState.asking = false;
    if (btn) { btn.disabled = false; btn.textContent = '发送'; }
    repaintDoctorChat();
  }
}

/** 短时间格式（备份列表 / 工单列表共用）：2026-09-30 12:08 */
function fmtShortTs(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}


// ── 子模块七：开发工单（dev-orders 插件）────────────────────────────────────
//
// 链路：群友（白名单）在群里发「开发 xxxx」→ 插件钩子自动登记工单 →
// 主人在这个页面点【开工】→ 模型在 dev-sandbox/ 沙箱里执行 → 跑完【发布回群】。
// 页面只负责三件事：看快照 / 点动作 / 管白名单，重活全在插件里。
// 「开工」与「发布」是两个独立的人工闸：写完不等于发出去，发出去收不回来。

const DEV_ORDER_STATUS = {
  // 新模型（开发模式）：会话只有 开/档 两态；"正在干活"由 snapshot.running 叠加显示
  active: { label: '开发模式', cls: 'is-ready' },
  closed: { label: '已归档', cls: 'is-discarded' },
  // 旧工单状态（历史记录兼容渲染）
  new: { label: '新单', cls: 'is-new' },
  running: { label: '开发中', cls: 'is-running' },
  ready: { label: '待验收', cls: 'is-ready' },
  published: { label: '已发回', cls: 'is-published' },
  failed: { label: '失败', cls: 'is-failed' },
  discarded: { label: '已丢弃', cls: 'is-discarded' }
};

async function loadDevOrdersSnapshot() {
  const o = doctorState.orders;
  o.loading = true;
  try {
    // 携带 selected：服务端会把选中会话兜底追加进截断列表（否则选中的老会话
    // 不在最新 100 条里时，下面"选中项不在列表就复位"会每秒把用户选中清掉）。
    const q = o.selected ? `?selected=${encodeURIComponent(o.selected)}` : '';
    const d = await api(`/api/dev/snapshot${q}`, { timeoutMs: 15000 });
    if (d.available === false) {
      o.snapshot = null;
      o.error = d.error || '「开发工单」插件未启用（下载 → 已安装 → 插件 → dev-orders）';
    } else if (d.ok === false) {
      o.error = d.error || '加载失败';
    } else {
      o.snapshot = d;
      o.error = '';
      // 选中态跟着快照走：没选就选第一个会话；选中的被清了就复位
      const list = Array.isArray(d.sessions) ? d.sessions : (Array.isArray(d.orders) ? d.orders : []);
      if (o.selected && !list.some((x) => x.id === o.selected)) {
        o.selected = '';
        o.detail = null;
        o.detailError = '';
        o.expanded = new Set();
      }
      if (!o.selected && list.length) {
        o.selected = list[0].id;
        o.detail = null;
        o.detailError = '';
        o.expanded = new Set();
      }
    }
  } catch (e) {
    o.error = e?.message || '加载失败';
  } finally {
    o.loading = false;
  }
}

// 对话流最多保留 / 一次最多渲染多少行。
//
// 每次重绘都是把整个 lines 数组拼成一个 HTML 字符串再塞进 innerHTML，
// 而工具卡里带的是最多 8k 字的命令输出 / 文件内容。跑单时每秒重绘一次，
// 行数不封顶的话，几百个工具轮之后每秒要拼几十 MB 字符串 + 重建上万个节点，
// 标签页直接卡死。行数封顶后，重绘开销是常数。
const DEV_DETAIL_KEEP_LINES = 1200;    // 常态（跟着最新）内存里最多留多少行
const DEV_DETAIL_HARD_LINES = 4000;    // 翻过历史之后允许留到多少行（用户明确要看更早的）
const DEV_DETAIL_RENDER_LINES = 400;   // 一次最多渲染多少行（渲染窗口，可前后移动）

/** 展开态（o.expanded）是按行号记的：lines 前面增删多少行，键就整体平移多少。 */
function shiftLineKeys(set, delta) {
  const out = new Set();
  for (const i of (set || new Set())) { const j = i + delta; if (j >= 0) out.add(j); }
  return out;
}

/**
 * 拉选中工单的"开发记录"。
 * @param {boolean} append 跑单轮询用：只取增量
 * @param {number} before 「载入更早」用：往前翻一页（不透明字节偏移，取自 detail.prevFrom）
 */
async function loadDevOrderDetail({ append = false, before = 0 } = {}) {
  const o = doctorState.orders;
  if (!o.selected) return;
  const id = o.selected;
  const cur = o.detail;
  const same = !!(cur && cur.id === id);
  try {
    // ── 往前翻页：更早的一批**接在前面**（不是替换）──
    if (before > 0) {
      if (!same) return;
      const d = await api(`/api/dev/detail?id=${encodeURIComponent(id)}&before=${before}`, { timeoutMs: 15000 });
      if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
      if (!d.ok) throw new Error(d.error || '读取失败');
      if (o.selected !== id || o.detail !== cur) return;   // 期间切走了单子
      const add = Array.isArray(d.lines) ? d.lines : [];
      if (!add.length) {                    // 已经到最前面了
        o.detail = { ...cur, prevFrom: 0, hasMore: false };
        o.detailError = '';
        return;
      }
      let lines = [...add, ...(cur.lines || [])];
      let dropped = 0;
      if (lines.length > DEV_DETAIL_HARD_LINES) {
        dropped = lines.length - DEV_DETAIL_HARD_LINES;
        lines = lines.slice(dropped);
      }
      // 渲染窗口整体后退一屏，正好落在刚载入的那一页上
      const winEnd = Math.max(DEV_DETAIL_RENDER_LINES, Math.min(
        (cur.winEnd ?? (cur.lines || []).length) + add.length - DEV_DETAIL_RENDER_LINES - dropped,
        lines.length
      ));
      o.expanded = shiftLineKeys(o.expanded, add.length - dropped);
      o.detail = {
        ...cur,
        lines,
        winEnd,
        paged: true,
        prevFrom: dropped ? 0 : (d.prevFrom || 0),   // 前面已被裁掉 → 不能再往前翻
        hasMore: dropped ? false : !!d.hasMore
      };
      o.detailError = '';
      o.pendingScroll = { atBottom: false, top: 0 };  // 载入的那一页从顶部开始看
      return;
    }

    // ── 增量 / 首次加载 ──
    // from = 不透明游标（后端语义是字节偏移，前端只负责原样回传）；0 = 首次打开 → 后端给尾部窗口
    const from = append && same ? (cur.nextFrom || 0) : 0;
    const d = await api(`/api/dev/detail?id=${encodeURIComponent(id)}&from=${from}`, { timeoutMs: 15000 });
    if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
    if (!d.ok) throw new Error(d.error || '读取失败');
    if (o.selected !== id) return;   // 期间用户切走了单子
    // 游标幂等：若期间已有别的请求把 nextFrom 推进了，这次的增量就是重复的，丢掉。
    // （并发的 append 是「记录里冒出大量重复行」的直接原因。）
    if (append && same && (cur.nextFrom || 0) !== from) return;

    const add = Array.isArray(d.lines) ? d.lines : [];
    const prev = (from > 0 && same) ? (cur.lines || []) : [];
    let lines = [...prev, ...add];
    let dropped = 0;
    const cap = (append && same && cur.paged) ? DEV_DETAIL_HARD_LINES : DEV_DETAIL_KEEP_LINES;
    if (lines.length > cap) { dropped = lines.length - cap; lines = lines.slice(dropped); }
    if (dropped) o.expanded = shiftLineKeys(o.expanded, -dropped);

    // 渲染窗口：原本贴着最新就继续跟到底；在翻历史就原地不动（只跟着裁剪平移）
    const wasAtLatest = !same || cur.winEnd == null || cur.winEnd >= (cur.lines || []).length;
    const winEnd = wasAtLatest
      ? lines.length
      : Math.max(DEV_DETAIL_RENDER_LINES, Math.min(cur.winEnd + add.length - dropped, lines.length));

    o.detail = {
      ...d,
      lines,
      winEnd,
      paged: (append && same) ? !!cur.paged : false,
      prevFrom: (append && same) ? (cur.prevFrom ?? cur.from ?? 0) : (d.prevFrom || d.from || 0),
      hasMore: (append && same) ? !!cur.hasMore : !!d.hasMore
    };
    o.detailError = '';
  } catch (e) {
    o.detailError = e?.message || '读取失败';
    if (!append && !before) o.detail = null;
  }
}

function renderOrdersModule() {
  const o = doctorState.orders;
  if (!o.snapshot) {
    if (o.error) {
      return `
        <div class="hint" style="margin:12px 0">${esc(o.error)}</div>
        <button class="btn btn-small" id="devord-retry">重试</button>`;
    }
    return `
      <div class="sk-block">${'<div class="sk-row"></div>'.repeat(4)}</div>
      <div class="hint" style="margin-top:10px">正在加载工单…</div>`;
  }
  const s = o.snapshot;
  const orders = Array.isArray(s.sessions) ? s.sessions : (Array.isArray(s.orders) ? s.orders : []);
  const wl = Array.isArray(s.whitelist) ? s.whitelist : [];

  // ── 左栏：会话列表 ──
  const rows = orders.length ? orders.map((it) => {
    const st = DEV_ORDER_STATUS[it.status] || { label: String(it.status || ''), cls: '' };
    const isRunning = s.running === it.id;
    const title = String(it.title || '').trim() || `会话 #${it.seq}`;
    const active = o.selected === it.id ? ' is-active' : '';
    return `
      <div class="devorder-row${active}" data-dev-id="${esc(it.id)}" title="${esc(title)}">
        <div class="devorder-row-top">
          <span class="devorder-dot ${isRunning ? 'is-running' : st.cls}"></span>
          <span class="devorder-title">#${esc(String(it.seq))} ${esc(title)}</span>
        </div>
        <div class="devorder-sub">
          <span>${isRunning ? '干活中' : esc(st.label)}</span><span>${it.source === 'local' ? '本机' : esc(it.chatKey || '')}</span><span>${esc(fmtShortTs(it.updatedAt || it.createdAt))}</span>
        </div>
      </div>`;
  }).join('') : '<div class="devorder-empty">还没有会话。<br>白名单成员在群里发「开发 xxxx」就会出现在这里。</div>';

  return `
    ${o.note ? `<div class="hint" style="margin:0 0 10px">${esc(o.note)}</div>` : ''}
    <div class="devorder-panes">
      <div class="devorder-side">
        ${o.renderError ? `<div class="hint" style="margin:0 0 8px;color:#e8862a" title="页面渲染出现异常，已自动恢复；数据不受影响。若反复出现请把此信息反馈给维护者">⚠ 渲染异常（已自动恢复）：${esc(o.renderError)}</div>` : ''}
        <div class="devorder-side-head">
          <span class="devorder-side-title">会话 ${orders.length}${Number(s.sessionsTotal) > orders.length ? ` / ${s.sessionsTotal}` : ''}</span>
          <span style="flex:1"></span>
          <button class="btn btn-small" id="devord-model">模型设置</button>
          <button class="btn btn-small" id="devord-refresh">刷新</button>
          <button class="btn btn-small" id="devord-whitelist">白名单</button>
        </div>
        <div class="devorder-side-list">${rows}</div>
        ${usageBarHtml('全部会话', s.usageTotal, DEV_USAGE_HINT + '（全部历史会话累计）')}
        <div class="hint">白名单 ${wl.length} 人 · 权限范围 <code>${esc(s.projectRoot || '项目根')}</code></div>
      </div>
      <div class="devorder-main">${renderOrdersDetail()}</div>
    </div>`;
}

/** 右栏：选中工单的对话流（需求 → 执行过程 → 收尾）。 */
/** 底部对话框：直接说话，发给选中的会话；没选会话时开一个新的（本机）。 */
function renderOrdersComposer(hasSelected) {
  const o = doctorState.orders;
  return `
    <div class="devorder-composer">
      <input type="text" id="devorder-input"
        placeholder="${hasSelected ? '直接说 —— 回车发给这个会话（模型会直接动手）…' : '说点什么，回车开一个新开发会话…'}"
        value="${esc(o.draft || '')}" />
      <button class="btn btn-small btn-primary" id="devorder-send">${hasSelected ? '发送' : '开新会话'}</button>
      ${hasSelected ? '<button class="btn btn-small" id="devorder-newsession">新会话</button>' : ''}
    </div>`;
}

/** token 数友好格式：1_223 → 1.2k；12_345_678 → 12.35M；千万级（1.2B）也不溢出。 */
function fmtTokCompact(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

const DEV_USAGE_HINT = '输入=prompt_tokens；输出=completion_tokens；命中=prompt_tokens_details.cached_tokens（占输入的比例）';

/**
 * 用量条公共骨架：token 用量 + 缓存命中率（口径与项目其它地方一致：cached/prompt）。
 * title 区分「本会话 / 全部会话」。
 */
function usageBarHtml(title, u, hint) {
  if (!u || !u.calls) return '';
  const hit = Math.round((Number(u.hitRate) || 0) * 100);
  const cls = hit >= 70 ? 'is-good' : (hit >= 30 ? '' : 'is-bad');
  return `<div class="devorder-usage" title="${hint || DEV_USAGE_HINT}">
    <span class="devorder-usage-t">${title}</span>
    <span>输入 <b>${fmtTokCompact(u.promptTokens)}</b></span>
    <span>输出 <b>${fmtTokCompact(u.completionTokens)}</b></span>
    <span>合计 <b>${fmtTokCompact(u.totalTokens)}</b></span>
    <span class="${cls}">缓存命中 <b>${hit}%</b>（${fmtTokCompact(u.cachedTokens)} tok）</span>
    <span>${u.turns || 0} 轮 / ${u.calls} 次调用</span>
  </div>`;
}

/** 本会话用量条（原「本次开发」，改名以与侧栏「全部会话」累计条区分）。 */
function renderOrdersUsage(it) {
  return usageBarHtml('本会话', it && it.usage, DEV_USAGE_HINT);
}

function renderOrdersDetail() {
  const o = doctorState.orders;
  const s = o.snapshot || {};
  const list = Array.isArray(s.sessions) ? s.sessions : (Array.isArray(s.orders) ? s.orders : []);
  const it = list.find((x) => x.id === o.selected);
  if (!it) {
    return `
      <div class="devorder-empty">这里是「开发模式」的对话台：<br>白名单成员在群里发「开发 xxx」会自动开一个会话，之后的聊天直接指挥模型改文件；<br>发 <code>开发#6</code> 可重开 #6 号旧工单（上下文都在，接着干）；<br>也可以在下面输入框直接开一个新会话（本机）。<br><br>左侧选一个会话看它的开发过程。</div>
      ${renderOrdersComposer(false)}`;
  }
  const st = DEV_ORDER_STATUS[it.status] || { label: String(it.status || ''), cls: '' };
  const runningNow = s.running === it.id;
  const acts = [];
  // 「中止」：一轮最长能跑 1 小时，而调度是全局单飞，不结束的话所有会话都排队、
  // 界面只显示"模型正在干活…"，用户会以为卡死了。
  if (runningNow) {
    const since = Number(s.runningSince) || 0;
    const mins = since ? Math.max(0, Math.round((Date.now() - since) / 60000)) : 0;
    acts.push(`<button class="btn btn-small btn-primary" data-dev-act="abort" data-dev-id="${esc(it.id)}" title="打断这一轮（模型调用与工具执行都会停下，会话保留）">中止${since ? `（已跑 ${mins} 分）` : ''}</button>`);
  }
  // 「重开」：归档的工单回到 active，追加式上下文还在，能接着上次的工作现场继续干
  if (it.status !== 'active') {
    acts.push(`<button class="btn btn-small btn-primary" data-dev-act="reopen" data-dev-id="${esc(it.id)}" title="回到这个工单继续干（上下文都在）">重开</button>`);
  }
  if (it.status === 'active') {
    acts.push(`<button class="btn btn-small" data-dev-act="close" data-dev-id="${esc(it.id)}">归档会话</button>`);
  }
  if (s.running !== it.id) {
    acts.push(`<button class="btn btn-small" data-dev-act="delete" data-dev-id="${esc(it.id)}">删除</button>`);
  }

  const d = (o.detail && o.detail.id === it.id) ? o.detail : null;
  const lines = d ? (d.lines || []) : [];
  // 渲染窗口 [renderFrom, renderTo)：窗口可以在 lines 上前后移动（「载入更早」/「回到最新」）。
  // 键仍是 lines 里的**绝对下标**，所以展开态不会错位（见 DEV_DETAIL_KEEP_LINES）。
  const renderTo = Math.min(lines.length, Math.max(DEV_DETAIL_RENDER_LINES, (d && d.winEnd != null) ? d.winEnd : lines.length));
  const renderFrom = Math.max(0, renderTo - DEV_DETAIL_RENDER_LINES);
  const hasOlder = renderFrom > 0 || !!(d && d.hasMore);
  const hasNewer = renderTo < lines.length;

  const parts = [];
  if (hasOlder) {
    const canLoad = !!(d && d.prevFrom) && lines.length < DEV_DETAIL_HARD_LINES;
    parts.push(`<div class="devorder-divider">更早的记录没有展开${canLoad
      ? ' <button class="btn btn-small" id="devord-earlier" type="button">载入更早</button>'
      : `（已到显示上限 ${DEV_DETAIL_HARD_LINES} 条）`}</div>`);
  }
  for (let i = renderFrom; i < renderTo; i++) parts.push(renderOrdersDetailLine(lines[i], i));
  if (runningNow) parts.push('<div class="devorder-divider">模型正在干活…（实时刷新）</div>');
  if (hasNewer) {
    parts.push('<div class="devorder-divider">下面是更新的记录 <button class="btn btn-small" id="devord-latest" type="button">回到最新</button></div>');
  }
  if (!lines.length && !runningNow) {
    parts.push('<div class="devorder-empty">这个会话还没有消息。</div>');
  }
  if (!d && o.detailError) {
    parts.push(`<div class="devorder-empty">记录读取失败：${esc(o.detailError)}</div>`);
  } else if (!d && !o.detailError) {
    parts.push('<div class="devorder-empty">正在读取记录…</div>');
  }

  return `
    <div class="devorder-main-head">
      <span class="devorder-dot ${runningNow ? 'is-running' : st.cls}"></span>
      <span class="devorder-head-title">#${esc(String(it.seq))} ${esc(it.title || '')}</span>
      <span class="hint">${it.source === 'local' ? '本机' : esc(it.chatKey || '')} · ${esc(fmtShortTs(it.updatedAt || it.createdAt))}</span>
      <span style="flex:1"></span>
      ${acts.join('')}
    </div>
    <div class="devorder-chat" id="devorder-chat">${parts.join('')}</div>
    ${renderOrdersUsage(it)}
    ${renderOrdersComposer(true)}`;
}

/**
 * 单条记录 → DOM。
 * 行号（i）是稳定键：transcript 是 append-only，展开状态按行号记在 state 里，
 * 所以跑单时的 2 秒重绘不会把已展开的工具卡收回去。
 */
function renderOrdersDetailLine(ln, i) {
  const o = doctorState.orders;
  if (!ln || typeof ln !== 'object') return '';
  if (ln.kind === 'user') {
    return `
      <div class="devorder-usermsg">
        <span class="devorder-usermsg-who">${esc(ln.from || '')}${ln.at ? ` · ${esc(fmtShortTs(ln.at))}` : ''}</span>
        <div class="devorder-msg-text">${esc(ln.text || '')}</div>
      </div>`;
  }
  if (ln.kind === 'run-start') {   // 旧记录兼容
    return `<div class="devorder-divider">开工 · ${esc(fmtShortTs(ln.at))}${ln.note ? ` · 补充：${esc(String(ln.note).slice(0, 120))}` : ''}</div>`;
  }
  if (ln.kind === 'assistant') {
    return `<div class="devorder-msg"><span class="devorder-dot"></span><div class="devorder-msg-text">${esc(ln.text || '')}</div></div>`;
  }
  if (ln.kind === 'tool') {
    const open = o.expanded.has(i);
    return `
      <div class="devorder-tool${ln.ok ? '' : ' is-error'}${open ? ' is-open' : ''}" data-dev-line="${i}">
        <div class="devorder-tool-head">
          <span class="devorder-tool-ic${ln.ok ? '' : ' is-error'}"></span>
          <span class="devorder-tool-brief">${esc(ln.label || ln.name || '工具')}${ln.brief ? ` — ${esc(ln.brief)}` : ''}</span>
          <span class="devorder-tool-toggle">${open ? '收起' : '展开'}</span>
        </div>
        <pre class="devorder-tool-full"${open ? '' : ' hidden'}>${open ? esc(ln.full || '') : ''}</pre>
      </div>`;
  }
  if (ln.kind === 'delivered') {
    return `<div class="devorder-divider">${ln.ok ? '已回群' : '（回群失败）'}</div>`;
  }
  // 「正在连接 X…」（思考前提示）：小字弱化，不抢正文的位置。
  if (ln.kind === 'notice') {
    return `<div class="devorder-notice">${esc(String(ln.text || ''))}</div>`;
  }
  if (ln.kind === 'closed') {
    return '<div class="devorder-divider">会话已归档</div>';
  }
  if (ln.kind === 'done') {   // 旧记录兼容
    const files = Array.isArray(ln.files) ? ln.files : [];
    return `
      <div class="devorder-done">
        <div class="devorder-done-title">已完成 · ${files.length} 个文件</div>
        ${ln.summary ? `<div class="devorder-done-sub">${esc(String(ln.summary))}</div>` : ''}
      </div>`;
  }
  if (ln.kind === 'error') {
    return `
      <div class="devorder-fail">
        <div class="devorder-done-title">失败</div>
        <div class="devorder-done-sub">${esc(String(ln.message || '未知错误'))}</div>
      </div>`;
  }
  return '';
}

function bindOrdersEvents(box) {
  const o = doctorState.orders;
  box.querySelector('#devord-retry')?.addEventListener('click', () => {
    refreshInBackground(loadDevOrdersSnapshot, 'orders', '开发工单');
  });
  box.querySelector('#devord-refresh')?.addEventListener('click', () => {
    refreshInBackground(loadDevOrdersSnapshot, 'orders', '开发工单');
    if (o.selected) refreshInBackground(loadDevOrderDetail, 'orders', '开发记录');
  });
  // 「载入更早」：往前翻一页（后端按字节偏移往前读，前端只把游标原样回传）
  box.querySelector('#devord-earlier')?.addEventListener('click', () => {
    const pf = o.detail && o.detail.prevFrom;
    if (!pf) return;
    refreshInBackground(() => loadDevOrderDetail({ before: pf }), 'orders', '开发记录');
  });
  // 「回到最新」：渲染窗口弹回尾部，并跟到底
  box.querySelector('#devord-latest')?.addEventListener('click', () => {
    if (!o.detail) return;
    o.detail.winEnd = (o.detail.lines || []).length;
    o.pendingScroll = { atBottom: true, top: 0 };
    renderDoctorPage();
  });
  box.querySelector('#devord-whitelist')?.addEventListener('click', () => openDevWhitelistDialog());
  box.querySelector('#devord-model')?.addEventListener('click', () => openDevModelDialog());

  // 底部对话框：输入即存（2 秒轮询重绘不丢字）；回车 = 发送（没选会话就是开新会话）
  const input = box.querySelector('#devorder-input');
  if (input) {
    input.addEventListener('input', () => { o.draft = input.value; });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        devOrderSend();
      }
    });
  }
  box.querySelector('#devorder-send')?.addEventListener('click', () => devOrderSend());
  box.querySelector('#devorder-newsession')?.addEventListener('click', () => devOrderNewSession());

  // 左栏选单
  box.querySelectorAll('.devorder-row').forEach((el) => {
    el.addEventListener('click', () => {
      const id = el.dataset.devId;
      if (!id || o.selected === id) return;
      o.selected = id;
      o.detail = null;
      o.detailError = '';
      o.expanded = new Set();
      renderDoctorPage();
      refreshInBackground(loadDevOrderDetail, 'orders', '开发记录');
    });
  });

  // 动作按钮（右栏头部）
  box.querySelectorAll('.devorder-main-head [data-dev-act]').forEach((btn) => {
    btn.addEventListener('click', () => devOrderAction(btn.dataset.devAct, btn.dataset.devId));
  });

  // 工具卡展开/收起：只动这一张卡，不重绘（状态记在 state.expanded，重绘后仍在）
  box.querySelectorAll('.devorder-tool').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = Number(el.dataset.devLine);
      if (!Number.isFinite(idx)) return;
      const open = !o.expanded.has(idx);
      if (open) o.expanded.add(idx); else o.expanded.delete(idx);
      el.classList.toggle('is-open', open);
      const full = el.querySelector('.devorder-tool-full');
      const tog = el.querySelector('.devorder-tool-toggle');
      if (full) {
        // 内容是按需填的：收起时 DOM 里不放，否则每次重绘都要给每张卡拼一份最多 8k
        // 的文本，这正是"行数一多、每秒重绘就卡死"的主因。展开时才从 lines 里取。
        full.textContent = open ? String((o.detail?.lines || [])[idx]?.full || '') : '';
        full.hidden = !open;
      }
      if (tog) tog.textContent = open ? '收起' : '展开';
    });
  });

  // 选中了单但还没详情 → 拉一次（失败过就不自动重试，等用户点刷新/换单）
  if (o.selected && !o.detail && !o.detailError) {
    refreshInBackground(loadDevOrderDetail, 'orders', '开发记录');
  }

  // 对话流的滚动位置：重绘会重建 DOM（scrollTop 归零），所以这里按"重绘前的位置"决定。
  const chat = box.querySelector('#devorder-chat');
  if (chat) {
    const switched = o.lastRenderedSelected !== o.selected;
    o.lastRenderedSelected = o.selected;
    const pend = o.pendingScroll || null;
    o.pendingScroll = null;
    const how = decideOrdersScroll({ pending: pend, switched, running: o.snapshot?.running === o.selected });
    if (how === 'bottom') chat.scrollTop = chat.scrollHeight;
    else if (pend) chat.scrollTop = pend.top;   // 原本没贴底 → 原地不动（别把回看历史的用户弹走）
  }

  // 页面渲染出来了就保证轮询在跑（幂等），解决"从 QQ 发起 / 刷新页面后不刷新"
  startDevPolling();
}

/** 「开发工单」专用模型设置：devApi 优先级最高（本页 > 自检专用 > 全局聊天模型）。
 *  开发模式要改文件、跑命令，对模型能力要求最高，想提命中率就把这里指到更强的模型。 */
async function openDevModelDialog() {
  const oo = doctorState.orders;
  let data;
  try {
    data = await api('/api/dev/config', { timeoutMs: 15000 });
  } catch (e) {
    oo.note = `读取模型配置失败：${e?.message || e}`;
    if (doctorState.sub === 'orders') renderDoctorPage();
    return;
  }
  const c = data.config || {};
  const g = data.global || {};
  const doc = data.doctorApi || {};

  const overlay = modelModalShell({
    head: '开发专用模型',
    body: `
      <div class="doctor-cfg-note">
        优先级：本页专用 > 自检专用${doc.enabled ? `（当前：<code>${esc(doc.model)}</code>` : '（未启用）'}） > 全局（当前：<code>${esc(g.model || '未配置')}</code>）。
        开发模式改文件、跑命令都在用这套模型 —— <b>想提高命中率就把这里指到更强的模型</b>。
      </div>
      <div class="doctor-cfg-note">
        ⚠️ <strong>建议给开发模式配一个与正常对话<strong>不同</strong>的模型</strong>（哪怕能力相近）：
        前缀缓存的容量按「账号 + 模型」共享，开发模式与正常对话共用同一个模型时，
        两边的缓存会<strong>互相挤占</strong> —— 开发模式上下文更长，更容易把正常对话的前缀挤出去，
        正常聊天的命中率就会掉。分开模型 = 两套缓存池，互不干扰。
      </div>
      <label class="doctor-cfg-row doctor-cfg-toggle">
        <input type="checkbox" id="dv-enabled"${c.enabled ? ' checked' : ''} />
        <span>使用独立配置</span>
      </label>
      <div id="dv-fields" class="${c.enabled ? '' : 'is-muted'}">
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">Base URL</span>
          <input type="text" id="dv-baseurl" placeholder="https://api.deepseek.com/v1" value="${esc(c.baseUrl || '')}" />
        </label>
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">模型</span>
          <input type="text" id="dv-model" placeholder="deepseek-v4-pro" value="${esc(c.model || '')}" />
        </label>
        <label class="doctor-cfg-row">
          <span class="doctor-cfg-label">API Key</span>
          <span class="doctor-cfg-keywrap">
            <input type="password" id="dv-apikey" placeholder="${c.hasApiKey ? '已配置（留空 = 不修改）' : '尚未配置'}" value="" />
            <button class="btn btn-small doctor-cfg-eye" type="button" id="dv-eye" title="显示当前密钥">显示</button>
          </span>
        </label>
        ${c.hasApiKey ? '<div class="doctor-cfg-hint">已保存一把密钥。要清空它，勾选下面的「清除已保存的密钥」。</div>' : ''}
        <label class="doctor-cfg-row doctor-cfg-toggle">
          <input type="checkbox" id="dv-clear" />
          <span>清除已保存的密钥</span>
        </label>
      </div>
      <div class="doctor-cfg-err" id="dv-err" hidden></div>`,
    foot: `
      <button class="btn doctor-cfg-cancel" type="button">取消</button>
      <button class="btn btn-primary doctor-cfg-save" type="button">保存</button>`
  });

  const $f = (s) => overlay.querySelector(s);
  const errEl = $f('#dv-err');
  const showErr = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };

  const toggleFields = () => {
    const on = $f('#dv-enabled').checked;
    $f('#dv-fields').classList.toggle('is-muted', !on);
  };
  $f('#dv-enabled').addEventListener('change', toggleFields);

  let plainShown = false;
  let plainKey = null;
  $f('#dv-eye').addEventListener('click', async () => {
    const input = $f('#dv-apikey');
    const btn = $f('#dv-eye');
    if (plainShown) {
      input.value = '';
      input.type = 'password';
      btn.textContent = '显示';
      plainShown = false;
      return;
    }
    try {
      if (plainKey === null) {
        const r = await api('/api/dev/config-key', { timeoutMs: 15000 });
        plainKey = r.apiKey || '';
      }
      if (!plainKey) { showErr('没有已保存的密钥可显示。'); return; }
      input.value = plainKey;
      input.type = 'text';
      btn.textContent = '隐藏';
      plainShown = true;
      showErr('');
    } catch (e) {
      showErr(`读取明文密钥失败：${e?.message || e}`);
    }
  });
  $f('#dv-apikey').addEventListener('input', () => { plainShown = false; plainKey = null; });

  $f('.doctor-cfg-cancel').addEventListener('click', () => closeModelModal(overlay));
  $f('.doctor-cfg-save').addEventListener('click', async () => {
    const payload = {
      enabled: $f('#dv-enabled').checked,
      baseUrl: $f('#dv-baseurl').value.trim(),
      model: $f('#dv-model').value.trim()
    };
    const kv = $f('#dv-apikey').value.trim();
    if (kv) payload.apiKey = kv;
    if ($f('#dv-clear').checked) payload.clearApiKey = true;

    if (payload.enabled && !payload.model) { showErr('启用独立配置时必须填模型名。'); return; }
    if (payload.enabled && !payload.baseUrl) { showErr('启用独立配置时必须填 Base URL。'); return; }

    const btn = $f('.doctor-cfg-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await api('/api/dev/config', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: 15000
      });
      closeModelModal(overlay);
      oo.note = payload.enabled
        ? `开发模式已切换为独立模型：${payload.model}。下一轮对话生效。`
        : '开发模式已改回跟随（自检专用 / 全局模型）。';
      if (doctorState.sub === 'orders') renderDoctorPage();
    } catch (e) {
      showErr(`保存失败：${e?.message || e}`);
      btn.disabled = false;
      btn.textContent = '保存';
    }
  });
}

/** 对话框：发送，有选中会话就发给它；没有就开一个新会话（本机）。 */
async function devOrderSend() {
  const o = doctorState.orders;
  const text = String(o.draft || '').trim();
  if (!text) { o.note = '先在输入框写一句话。'; if (doctorState.sub === 'orders') renderDoctorPage(); return; }
  if (o.busy) return;
  o.busy = 'send';
  o.note = '';
  try {
    let d;
    if (o.selected) {
      d = await api('/api/dev/send', { method: 'POST', body: JSON.stringify({ id: o.selected, text }), timeoutMs: 20000 });
      if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
      if (!d.ok) throw new Error(d.error || '发送失败');
    } else {
      d = await api('/api/dev/new', { method: 'POST', body: JSON.stringify({ text }), timeoutMs: 20000 });
      if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
      if (!d.ok) throw new Error(d.error || '创建失败');
      o.selected = d.id;
      o.detail = null;
      o.detailError = '';
      o.expanded = new Set();
    }
    o.draft = '';
    o.note = '已发送 —— 模型正在干活，过程实时显示。';
    startDevPolling();
    await loadDevOrdersSnapshot();
    await loadDevOrderDetail();
  } catch (e) {
    o.note = `发送失败：${e?.message || e}`;
  } finally {
    o.busy = '';
    if (doctorState.sub === 'orders') renderDoctorPage();
  }
}

/** 对话框：明开一个新会话（本机），输入框里有字就带上。 */
async function devOrderNewSession() {
  const o = doctorState.orders;
  if (o.busy) return;
  const text = String(o.draft || '').trim();
  o.busy = 'newsession';
  o.note = '';
  try {
    const d = await api('/api/dev/new', { method: 'POST', body: JSON.stringify({ text: text || '' }), timeoutMs: 20000 });
    if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
    if (!d.ok) throw new Error(d.error || '创建失败');
    o.draft = '';
    o.selected = d.id;
    o.detail = null;
    o.detailError = '';
    o.expanded = new Set();
    o.note = text ? '新会话已创建并发送。' : '新会话已创建。';
    if (text) startDevPolling();
    await loadDevOrdersSnapshot();
    await loadDevOrderDetail();
  } catch (e) {
    o.note = `创建失败：${e?.message || e}`;
  } finally {
    o.busy = '';
    if (doctorState.sub === 'orders') renderDoctorPage();
  }
}

/** 会话动作（当前只有：归档）。 */
async function devOrderAction(act, id) {
  const o = doctorState.orders;
  if (!id || o.busy) return;
  if (act === 'reopen') {
    o.busy = `reopen:${id}`;
    o.note = '';
    try {
      const d = await api('/api/dev/reopen', { method: 'POST', body: JSON.stringify({ id }), timeoutMs: 15000 });
      if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
      if (!d.ok) throw new Error(d.error || '重开失败');
      o.note = `工单 #${d.seq} 已重开 —— 直接在下面说需求就能继续（上次的上下文都在）。`;
      await loadDevOrdersSnapshot();
      await loadDevOrderDetail();
    } catch (e) {
      o.note = `重开失败：${e?.message || e}`;
    } finally {
      o.busy = '';
      if (doctorState.sub === 'orders') renderDoctorPage();
    }
    return;
  }
  if (act === 'abort') {
    if (!(await qaConfirm(`中止会话 ${id} 正在跑的这一轮？\n\n模型调用与工具执行都会立刻停下，会话保留（可以接着发新指令）。\n同时会丢弃这一轮排队中的消息。`))) return;
    o.busy = `abort:${id}`;
    o.note = '';
    try {
      const d = await api('/api/dev/abort', { method: 'POST', body: JSON.stringify({ id }), timeoutMs: 15000 });
      if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
      if (!d.ok) throw new Error(d.error || '中止失败');
      o.note = `已请求中止${d.dropped ? `（同时丢弃排队 ${d.dropped} 条）` : ''}。这一轮停下后会话仍可继续用。`;
      await loadDevOrdersSnapshot();
    } catch (e) {
      o.note = `中止失败：${e?.message || e}`;
    } finally {
      o.busy = '';
      if (doctorState.sub === 'orders') renderDoctorPage();
    }
    return;
  }
  if (act === 'close') {
    if (!(await qaConfirm(`归档会话 ${id}？\n\n归档后停止接收新消息（再发一条会自动重新激活）；开发记录保留。`))) return;
    o.busy = `close:${id}`;
    o.note = '';
    try {
      const d = await api('/api/dev/close', { method: 'POST', body: JSON.stringify({ id }), timeoutMs: 15000 });
      if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
      if (!d.ok) throw new Error(d.error || '归档失败');
      o.note = `会话 ${id} 已归档。`;
      await loadDevOrdersSnapshot();
    } catch (e) {
      o.note = `归档失败：${e?.message || e}`;
    } finally {
      o.busy = '';
      if (doctorState.sub === 'orders') renderDoctorPage();
    }
    return;
  }
  if (act === 'delete') {
    if (!(await qaConfirm(`永久删除会话 ${id}？将同时清掉它的开发记录与对话历史，不可恢复；沙箱产出文件保留（dev-sandbox/）。`))) return;
    o.busy = `delete:${id}`;
    o.note = '';
    try {
      const d = await api('/api/dev/delete', { method: 'POST', body: JSON.stringify({ id }), timeoutMs: 15000 });
      if (d.available === false) throw new Error(d.error || '「开发工单」插件未启用');
      if (!d.ok) throw new Error(d.error || '删除失败');
      o.note = `会话 ${id} 已删除（沙箱产出文件保留）。`;
      if (o.selected === id) {
        o.selected = '';
        o.detail = null;
        o.detailError = '';
        o.expanded = new Set();
      }
      await loadDevOrdersSnapshot();
    } catch (e) {
      o.note = `删除失败：${e?.message || e}`;
    } finally {
      o.busy = '';
      if (doctorState.sub === 'orders') renderDoctorPage();
    }
    return;
  }
}

/** 读当前对话流的滚动状态（重绘前捕获）。 */
function readOrdersScroll() {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
  const el = document.getElementById('devorder-chat');
  if (!el) return null;
  return { atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 24, top: el.scrollTop };
}

/**
 * 重绘后该把对话滚到哪（纯函数，便于测试）。
 *
 * 原来只在"正在跑"时 `scrollTop = scrollHeight`，一旦跑完，那次重绘
 * 会让新 DOM 的 scrollTop 归零，视窗弹回顶部；跑着的时候用户往上翻看历史，
 * 也会被硬拽回底部。现在：重绘前捕获位置，原本贴着底就继续跟到底，否则原地不动。
 * @param {{pending?: {atBottom:boolean,top:number}|null, switched?:boolean, running?:boolean}} o
 * @returns {'bottom'|'keep'}
 */
function decideOrdersScroll({ pending = null, switched = false, running = false } = {}) {
  if (pending) return pending.atBottom ? 'bottom' : 'keep';
  if (switched || running) return 'bottom';   // 刚切会话 / 正在干活 → 跟到底
  return 'keep';
}

/**
 * 开发工单轮询：快照 + 选中会话的增量记录。
 *
 * 上一版把间隔改成 1 秒时，重入守卫写的是 `if (o.pollTimer) return;`，
 * 而 tick 一开头就把 `o.pollTimer = null`。链路是：
 *   tick → renderDoctorPage() → bindOrdersEvents() → startDevPolling()
 * 此刻守卫看到的句柄是空的，于是又起一个定时器并把句柄写进 o.pollTimer；
 * 紧接着原来那次 tick 末尾的 schedule() 再把 o.pollTimer 覆盖成自己的，
 * 前一个定时器永远没人清。结果每秒多一路轮询：几十路并发拉快照 + 拉记录 +
 * 全量重绘，UI 卡死到被迫重启，记录还被并发 append 出大量重复行。
 * 现在：① 单实例守卫用布尔 o.polling（不受句柄影响）；
 *       ② o.pollInFlight 防叠加；③ 数据没变就不重绘；
 *       ④ 记录 append 侧另有游标幂等校验（见 loadDevOrderDetail）。
 * 节奏：干活中 1 秒（实时感），空闲 5 秒（群里发起的会话也要能看见）；离开子页自动停。
 */
const DEV_POLL_RUNNING_MS = 1000;
const DEV_POLL_IDLE_MS = 5000;

function stopDevPolling() {
  const o = doctorState.orders;
  o.polling = false;
  if (o.pollTimer) { clearTimeout(o.pollTimer); o.pollTimer = null; }
  if (o.watchdogTimer) { clearInterval(o.watchdogTimer); o.watchdogTimer = null; }
}

/**
 * 看门狗：轮询链停摆自愈。
 *
 * tick 里任何未捕获的异常都可能让 schedule() 不被调用，链断了而 o.polling 仍为 true，
 * startDevPolling() 的单实例守卫会把任何重启挡在门外，用户只能手动刷页面。
 * tick 的 finally 已保证"无论成败链必续"，这里是第二道保险：
 * 每 20 秒检查一次，polling 为真却既无在途请求也无待跑定时器 = 链停摆 → 重启。
 */
function startOrdersWatchdog() {
  const o = doctorState.orders;
  if (o.watchdogTimer) return;
  o.watchdogTimer = setInterval(() => {
    if (!o.polling) return;
    if (o.pollInFlight) return;    // 有在途请求，正常
    if (o.pollTimer) return;       // 有待跑定时器，正常
    // 链停摆 → 重启（先摘旧定时器，再走正常启动路径）
    o.polling = false;
    if (o.pollTimer) { clearTimeout(o.pollTimer); o.pollTimer = null; }
    startDevPolling();
  }, 20000);
}

/** 数据指纹：没变就不重绘（这是"每秒全量重绘把 UI 拖死"的第二道防线）。 */
function devOrdersSignature() {
  const o = doctorState.orders;
  const s = o.snapshot || {};
  const d = o.detail || {};
  const sessions = (Array.isArray(s.sessions) ? s.sessions : [])
    .map((x) => `${x.id}:${x.status}:${x.updatedAt || 0}`).join(',');
  const lines = Array.isArray(d.lines) ? d.lines.length : 0;
  return [
    s.running || '', sessions, o.selected || '',
    d.id || '', lines, d.nextFrom || 0,
    o.detailError || '', o.note || '', o.busy || ''
  ].join('|');
}

function startDevPolling() {
  const o = doctorState.orders;
  if (o.polling) return;               // ← 单实例守卫（布尔，不受句柄置空影响）
  o.polling = true;
  startOrdersWatchdog();               // 看门狗：链停摆自愈
  let ticks = 0;
  let fails = 0;
  const schedule = (ms) => {
    if (!o.polling) return;
    o.pollTimer = setTimeout(tick, ms);
  };
  const tick = async () => {
    if (!o.polling) return;
    if (doctorState.sub !== 'orders') { stopDevPolling(); return; }   // 离开子页 → 停
    if (o.pollInFlight) { schedule(DEV_POLL_RUNNING_MS); return; }    // 上一次还没跑完 → 跳过，别叠加
    o.pollInFlight = true;
    let runningId = '';
    let delay = DEV_POLL_RUNNING_MS;
    try {
      ticks += 1;
      if (ticks > 72000) { stopDevPolling(); return; }                // ~10 小时兜底（stop 后 finally 里的 schedule 是空操作）
      const before = devOrdersSignature();
      let failed = false;
      try { await loadDevOrdersSnapshot(); } catch { failed = true; }
      runningId = (o.snapshot && o.snapshot.running) || '';
      if (runningId && o.selected === runningId) {
        try { await loadDevOrderDetail({ append: true }); } catch { failed = true; }
      }
      // 数据没变就不重绘，全量重绘是上一版把 UI 拖死的直接原因之一。
      // 用户正在输入框里打字时也不重绘（重绘会重建 DOM、把焦点和光标弄丢）。
      const typing = typeof document !== 'undefined'
        && document.activeElement && document.activeElement.id === 'devorder-input';
      if (devOrdersSignature() !== before && !typing && doctorState.sub === 'orders' && !o.busy) {
        o.pendingScroll = readOrdersScroll();   // 重绘前捕获滚动位置 → 重绘后恢复
        try {
          renderDoctorPage();
          o.renderError = '';
        } catch (e) {
          // 渲染异常曾经把 schedule() 跳掉，轮询链永久死亡（o.polling 仍为 true，
          // 单实例守卫把重启挡在门外，用户只能手动刷页面）。
          // 现在只记录、不杀链；侧栏横幅提示，看门狗兜底自愈。
          o.renderError = String(e?.message || e);
        }
      }
      // 连续失败就退避（最多 30 秒一次）：后端一忙（或插件没开）时，
      // 原来会按 1 秒一次的节奏一直打，越忙越打，把"慢"放大成"死"。
      fails = failed ? fails + 1 : 0;
      const base = runningId ? DEV_POLL_RUNNING_MS : DEV_POLL_IDLE_MS;
      delay = fails ? Math.min(base * (2 ** Math.min(fails, 5)), 30000) : base;
    } catch (e) {
      // 兜底：上面任何未预料到的异常也一样只记录、不杀链
      o.renderError = String(e?.message || e);
      fails += 1;
      delay = Math.min(DEV_POLL_RUNNING_MS * (2 ** Math.min(fails, 5)), 30000);
    } finally {
      o.pollInFlight = false;
      schedule(delay);   // ← 无论成败，链必续（这就是「自动刷新暴毙」的修复）
    }
  };
  schedule(DEV_POLL_RUNNING_MS);
}

/** 白名单管理窗口：输入 QQ 号维护「谁能在群里点单」。 */
async function openDevWhitelistDialog() {
  const listHtml = (list) => (Array.isArray(list) && list.length
    ? list.map((qq) => `<span class="devorder-wl-chip">${esc(qq)}<button class="devorder-wl-del" data-qq="${esc(qq)}" type="button" title="移出白名单">×</button></span>`).join('')
    : '<span class="hint">名单为空 —— 群里发「开发 xxxx」不会生效。</span>');

  const overlay = modelModalShell({
    head: '开发工单 · 白名单',
    body: `
      <div class="doctor-cfg-note">只有名单里的 QQ 号，在群里发「开发 xxxx」才会被登记成工单；其他人发的会被忽略（不打扰群聊）。</div>
      <div class="devorder-wl-add">
        <input type="text" id="devwl-input" placeholder="输入 QQ 号，如 123456789" />
        <button class="btn btn-small btn-primary" id="devwl-add" type="button">添加</button>
      </div>
      <div class="devorder-wl-list" id="devwl-list">加载中…</div>
      <div class="doctor-cfg-err" id="devwl-err" hidden></div>`,
    foot: `<button class="btn devwl-close" type="button">关闭</button>`
  });
  const $f = (sel) => overlay.querySelector(sel);
  const errEl = $f('#devwl-err');
  const showErr = (m) => { errEl.textContent = m || ''; errEl.hidden = !m; };

  const applyWhitelist = (list) => {
    $f('#devwl-list').innerHTML = listHtml(list);
    overlay.querySelectorAll('.devorder-wl-del').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          const d = await api('/api/dev/whitelist', { method: 'POST', body: JSON.stringify({ action: 'remove', qq: b.dataset.qq }), timeoutMs: 15000 });
          if (!d.ok) throw new Error(d.error || '移除失败');
          showErr('');
          applyWhitelist(d.whitelist);
          if (doctorState.orders.snapshot) doctorState.orders.snapshot.whitelist = d.whitelist || [];
          if (doctorState.sub === 'orders') renderDoctorPage();
        } catch (e) { showErr(`移除失败：${e?.message || e}`); }
      });
    });
  };

  $f('.devwl-close').addEventListener('click', () => closeModelModal(overlay));
  $f('#devwl-add').addEventListener('click', async () => {
    const qq = String($f('#devwl-input').value || '').trim();
    if (!qq) { showErr('先输入 QQ 号'); return; }
    try {
      const d = await api('/api/dev/whitelist', { method: 'POST', body: JSON.stringify({ action: 'add', qq }), timeoutMs: 15000 });
      if (!d.ok) throw new Error(d.error || '添加失败');
      $f('#devwl-input').value = '';
      showErr('');
      applyWhitelist(d.whitelist);
      if (doctorState.orders.snapshot) doctorState.orders.snapshot.whitelist = d.whitelist || [];
      if (doctorState.sub === 'orders') renderDoctorPage();
    } catch (e) { showErr(`添加失败：${e?.message || e}`); }
  });
  $f('#devwl-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $f('#devwl-add').click(); });

  const snap = doctorState.orders.snapshot;
  if (snap && Array.isArray(snap.whitelist)) {
    applyWhitelist(snap.whitelist);
  } else {
    try {
      await loadDevOrdersSnapshot();
      applyWhitelist(doctorState.orders.snapshot?.whitelist || []);
    } catch {
      applyWhitelist([]);
    }
  }
}

// 供 00-core.js 的 switchTab 调用：命名与其它页一致（loadXxxPage）。
// 函数已改名为 loadHarnessPage（页签从「系统自检」升级为 harness），
// 旧名保留做兼容导出，万一有旧书签/其它脚本还在调它不至于直接报错。
window.loadHarnessPage = loadHarnessPage;
window.loadDoctorPage = loadHarnessPage;

// ── 子模块七：打包 / 接收（整包：扩展 + 数据）────────────────────────────────
//
// 数据落地复用 migrate.applyImport，这里只负责收/发一个 zip。
// 接收侧的安全立场：解包 ≠ 安装。包只解到 data/import-bundles/<id>/ 临时区，
// 扩展必须逐个进锻造台过闸，最后由一次确认批量落地（每个草稿仍各签一张票）。

function bundleBusy() {
  const b = doctorState.bundle;
  return !!(b.loading || b.exporting || b.inspecting || b.staging || b.installing || b.importingData);
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v}B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)}KB`;
  return `${(v / 1048576).toFixed(1)}MB`;
}

async function loadBundleOptions() {
  const b = doctorState.bundle;
  b.loading = true;
  try {
    const d = await api('/api/bundle/options', { timeoutMs: 30000 });
    b.options = d?.ok ? d : null;
    if (!d?.ok) b.error = d?.error || '读取可打包项失败';
  } catch (e) {
    b.error = e?.message || '读取可打包项失败';
  }
  b.loading = false;
}

function renderBundleModule() {
  const b = doctorState.bundle;
  return `
    ${b.error ? `<div class="forge-error">⚠️ ${esc(b.error)}</div>` : ''}
    <div class="doctor-subs" role="tablist" style="margin-bottom:10px">
      <button class="doctor-sub${b.tab === 'export' ? ' is-active' : ''}" type="button" role="tab"
              aria-selected="${b.tab === 'export'}" data-bundle-tab="export">📦 打包带走</button>
      <button class="doctor-sub${b.tab === 'import' ? ' is-active' : ''}" type="button" role="tab"
              aria-selected="${b.tab === 'import'}" data-bundle-tab="import">📥 接收整包</button>
    </div>
    ${b.tab === 'export' ? renderBundleExport() : renderBundleImport()}
  `;
}

/* ── 打包 ─────────────────────────────────────────────────────────────── */

function renderBundleExport() {
  const b = doctorState.bundle;
  const o = b.options;
  if (b.loading && !o) return `<div class="forge-wait">📦 正在统计可打包的扩展与数据…</div>`;
  if (!o) return `<div class="forge-error">⚠️ 读不到可打包项。${esc(b.error || '')}</div>`;

  const modRows = (o.modules || []).map((m) => `
    <div class="fd-row">
      <label class="mig-row">
        <input type="checkbox" data-bundle-mod="${esc(m.key)}"${b.selModules.has(m.key) ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} />
        <span class="fd-name"><b>${esc(m.name)}</b> <span class="fd-kind">${m.kind === 'plugin' ? '插件' : '技能'}</span>${m.builtin ? '<span class="fd-kind">内置</span>' : ''}</span>
        <span class="fd-info">${esc(m.version || '-')} · ${m.files} 文件 · ${fmtBytes(m.bytes)}${m.builtin ? '' : ' · 你自己装的'}</span>
      </label>
    </div>`).join('');

  const dataRows = (o.data || []).map((d) => `
    <div class="fd-row">
      <label class="mig-row">
        <input type="checkbox" data-bundle-data="${esc(d.key)}"${b.selData.has(d.key) ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} />
        <span class="fd-name"><b>${esc(d.label)}</b></span>
        <span class="fd-info">${d.files} 文件 · ${fmtBytes(d.bytes)}</span>
      </label>
    </div>`).join('');

  const selMods = (o.modules || []).filter((m) => b.selModules.has(m.key));
  const estBytes = selMods.reduce((n, m) => n + m.bytes, 0)
    + (o.data || []).filter((d) => b.selData.has(d.key)).reduce((n, d) => n + d.bytes, 0);

  const res = b.result ? `
    <div class="forge-summary">
      <div class="fs-title">✅ 已打包</div>
      <div class="fs-body">
        文件：<b>${esc(b.result.name)}</b>（${fmtBytes(b.result.bytes)}）<br />
        内容：${b.result.modules} 个扩展 · ${b.result.dataFiles} 个数据文件<br />
        位置：<code>${esc(b.result.file)}</code><br />
        <span class="forge-hint">把这个 zip 发给对方，他在「接收整包」里选它即可。</span>
      </div>
    </div>` : '';

  return `
    <div class="forge-lead"><b>勾选要带走的东西</b>，打成一个 zip。包里<b>不含</b> API Key、QQ 号、网关 token、插件私有存储（<code>plugin-data/</code>）与运行态缓存。</div>
    <div class="forge-meta" style="margin:8px 0">
      <span>扩展 <b>${selMods.length}</b>/${(o.modules || []).length}</span>
      <span>数据 <b>${b.selData.size}</b> 类</span>
      <span>预计 <b>${fmtBytes(estBytes)}</b></span>
      <span><button class="btn btn-small" id="bundle-refresh"${bundleBusy() ? ' disabled' : ''}>重新统计</button></span>
    </div>
    <div class="forge-input" style="margin-bottom:10px">
      <div class="forge-hint" style="margin-bottom:6px">扩展（勾上你自己装的那些；内置的也可以带，但对方本来就有）</div>
      ${modRows || '<div class="forge-hint">没有可打包的扩展。</div>'}
    </div>
    <div class="forge-input" style="margin-bottom:10px">
      <div class="forge-hint" style="margin-bottom:6px">数据</div>
      ${dataRows}
      <div class="forge-hint">群友印象与用量在对方机器上是<b>合并</b>，不会覆盖他已有的数据。</div>
    </div>
    <div class="forge-input" style="margin-bottom:10px">
      <input type="text" id="bundle-note" class="mig-input" maxlength="200" placeholder="备注（可选）：例如「给你带了我调的梗图技能」"
             value="${esc(b.note)}"${bundleBusy() ? ' disabled' : ''} />
    </div>
    <div class="forge-install">
      <button class="btn btn-primary btn-small" id="bundle-export-btn"${bundleBusy() || (!b.selModules.size && !b.selData.size) ? ' disabled' : ''}>
        ${b.exporting ? '打包中…' : '打包成 zip'}
      </button>
      <button class="btn btn-small" id="bundle-reveal-btn"${bundleBusy() ? ' disabled' : ''}>打开导出目录</button>
    </div>
    ${res}
  `;
}

async function runBundleExport() {
  const b = doctorState.bundle;
  if (bundleBusy()) return;
  if (!b.selModules.size && !b.selData.size) { b.error = '没有勾选任何内容'; renderDoctorPage(); return; }
  b.exporting = true; b.error = ''; b.result = null;
  renderDoctorPage();
  try {
    const d = await api('/api/bundle/export', {
      method: 'POST',
      body: JSON.stringify({
        modules: [...b.selModules],
        data: [...b.selData],
        note: b.note
      }),
      timeoutMs: 300000
    });
    if (!d.ok) b.error = d.error || '打包失败';
    else b.result = d;
  } catch (e) {
    b.error = e?.message || '打包请求失败';
  }
  b.exporting = false;
  renderDoctorPage();
}

/* ── 接收 ─────────────────────────────────────────────────────────────── */

function renderBundleImport() {
  const b = doctorState.bundle;
  const pkg = b.pkg;

  const head = `
    <div class="forge-lead">选一个别人发来的 <code>qqagent-bundle-*.zip</code>。读取只解到临时区，<b>不装任何东西</b>。</div>
    <div class="forge-input" style="margin:8px 0">
      <div style="display:flex;gap:8px;align-items:center">
        <input type="text" id="bundle-path" class="mig-input" placeholder="例如：D://下载//qqagent-bundle-20261022-1200.zip"
               value="${esc(b.path)}"${bundleBusy() ? ' disabled' : ''} />
        <button class="btn btn-primary btn-small" id="bundle-inspect-btn"${bundleBusy() ? ' disabled' : ''}>${b.inspecting ? '读取中…' : '读取'}</button>
      </div>
      <div class="forge-hint">填完整路径（含 .zip）。包里只有扩展没有数据也能收。</div>
    </div>`;

  if (!pkg?.ok) return head + (pkg && !pkg.ok ? `<div class="forge-error">⚠️ ${esc(pkg.error || '读取失败')}</div>` : '');

  const draftsByKey = new Map((b.drafts || []).map((d) => [d.key, d]));

  const modRows = (pkg.modules || []).map((m) => {
    const dr = draftsByKey.get(m.key);
    const gateTxt = !dr ? '<span class="fd-kind">未检查</span>'
      : (!dr.ok ? `<span class="fd-state is-bad">导入失败</span>`
        : (dr.gate?.ok
          ? `<span class="fd-state is-ok">${dr.gate.confirm ? `待确认 ${dr.gate.confirm}` : '闸门通过'}</span>`
          : `<span class="fd-state is-bad">阻断 ${dr.gate?.blocking ?? '?'}</span>`));
    return `
      <div class="fd-row">
        <label class="mig-row">
          <input type="checkbox" data-bundle-pkgmod="${esc(m.key)}"${b.selPkgModules.has(m.key) ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} />
          <span class="fd-name"><b>${esc(m.name)}</b> <span class="fd-kind">${m.kind === 'plugin' ? '插件' : '技能'}</span></span>
          <span class="fd-info">${esc(m.version || '-')} · ${m.files} 文件 · ${fmtBytes(m.bytes)}</span>
        </label>
        ${gateTxt}
      </div>`;
  }).join('');

  const scan = pkg.scan?.ok ? pkg.scan : null;
  const chatRows = (scan?.messages || []).map((it) => `
    <div class="fd-row">
      <label class="mig-row">
        <input type="checkbox" data-bundle-chat="${esc(it.chatKey)}"${b.selChats.has(it.chatKey) ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} />
        <span class="fd-name"><b>${esc(it.chatKey)}</b></span>
        <span class="fd-info">源 ${it.source?.count ?? 0} 条 ｜ 本机 ${it.target ? it.target.count + ' 条' : '暂无'}</span>
        ${!it.target ? '<span class="fd-kind">新会话</span>' : (it.extra > 0 ? `<span class="fd-kind">约 +${it.extra} 条</span>` : '<span class="fd-kind">疑似无新增</span>')}
      </label>
    </div>`).join('');

  const statRows = (scan?.stats || []).map((st) => `
    <div class="fd-row">
      <label class="mig-row">
        <input type="checkbox" data-bundle-stat="${esc(st.id)}"${b.statsSel[st.id] ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} />
        <span class="fd-name">${esc(st.label)}</span>
        <span class="fd-info">${st.targetExists ? '与本机合并' : '本机没有，直接导入'}</span>
      </label>
    </div>`).join('');

  const meta = pkg.manifest || {};
  const metaHtml = `
    <div class="forge-meta">
      <span>打包时间 <b>${esc(String(meta.createdAt || '').slice(0, 19).replace('T', ' ') || '-')}</b></span>
      <span>来自版本 <b>${esc(meta.appVersion || '-')}</b></span>
      <span>扩展 <b>${(pkg.modules || []).length}</b></span>
      <span>文件 <b>${pkg.files}</b></span>
    </div>
    ${meta.note ? `<div class="forge-hint">备注：${esc(meta.note)}</div>` : ''}`;

  const installRows = (b.drafts || []).filter((d) => d.ok);
  const installable = installRows.filter((d) => d.gate?.ok && b.selPkgModules.has(d.key));
  const confirmTotal = installable.reduce((n, d) => n + (d.gate?.confirm || 0), 0);

  const installRes = b.installResult ? `
    <div class="forge-summary">
      <div class="fs-title">${b.installResult.installed ? '✅' : '⚠️'} 安装结果：${b.installResult.installed}/${b.installResult.total}</div>
      <div class="fs-body">
        ${(b.installResult.results || []).map((r) => `· ${esc(r.id || r.draftId)}：${r.ok ? '已安装' : '失败 —— ' + esc(r.error || '')}`).join('<br />')}
      </div>
    </div>` : '';

  const dataRes = b.dataResult ? `
    <div class="forge-summary">
      <div class="fs-title">✅ 数据已导入</div>
      <div class="fs-body">
        备份：<code>${esc(b.dataResult.backupDir || b.dataResult.backup || '')}</code><br />
        ${esc((b.dataResult.summary || b.dataResult.note || '') + '')}
        <span class="forge-hint">可在下方「导入备份」里一键回滚。</span>
      </div>
    </div>` : '';

  return `${head}
    <div class="forge-input">${metaHtml}</div>

    <div class="forge-input" style="margin-bottom:10px">
      <div class="forge-hint" style="margin-bottom:6px">扩展（${(pkg.modules || []).length} 个）—— 先「检查并登台」过闸，再确认安装</div>
      ${modRows || '<div class="forge-hint">包里没有可安装的扩展。</div>'}
      <div class="forge-install" style="margin-top:8px">
        <button class="btn btn-small" id="bundle-stage-btn"${bundleBusy() || b.drafts ? ' disabled' : ''}>${b.staging ? '检查中…' : (b.drafts ? '已登台' : '检查并登台（过闸）')}</button>
        <button class="btn btn-primary btn-small" id="bundle-install-btn"${bundleBusy() || !installable.length ? ' disabled' : ''}>
          ${b.installing ? '安装中…' : `确认安装所选${installable.length ? `（${installable.length}）` : ''}`}
        </button>
        <label class="forge-confirm-check">
          <input type="checkbox" id="bundle-install-enable"${b.installEnable ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} />
          <span>装完直接启用</span>
        </label>
        ${confirmTotal ? `<span class="forge-install-note">这些扩展共 ${confirmTotal} 项「需确认」能力（fs / 联网 / 子进程等），点安装即表示你已知悉。</span>` : ''}
      </div>
      ${b.staging ? '<div class="forge-wait">⚒️ 正在把扩展送进锻造台暂存区并跑闸门…</div>' : ''}
    </div>
    ${installRes}

    <div class="forge-input" style="margin-bottom:10px">
      <div class="forge-hint" style="margin-bottom:6px">数据</div>
      ${scan ? `
        ${chatRows ? `<div class="forge-hint">会话存档（按消息 id 合并去重，也可以整会话覆盖）</div>${chatRows}` : '<div class="forge-hint">包里没有会话存档。</div>'}
        ${(scan.memory?.chats || []).length ? `
          <div class="fd-row"><label class="mig-row">
            <input type="checkbox" id="bundle-memory-sel"${b.memorySel ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} />
            <span class="fd-name">群友印象</span>
            <span class="fd-info">${(scan.memory.chats || []).length} 个会话 · ${(scan.memory.chats || []).reduce((n, c) => n + (c.notes || 0), 0)} 条印象</span>
          </label></div>` : ''}
        ${statRows}
        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <label class="mig-strategy"><input type="radio" name="bundle-strategy" value="merge"${b.strategy === 'merge' ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} /> 合并（按消息 id 去重，推荐）</label>
          <label class="mig-strategy"><input type="radio" name="bundle-strategy" value="overwrite"${b.strategy === 'overwrite' ? ' checked' : ''}${bundleBusy() ? ' disabled' : ''} /> 覆盖（以包为准）</label>
          <button class="btn btn-primary btn-small" id="bundle-data-btn"${bundleBusy() ? ' disabled' : ''}>${b.importingData ? '导入中…' : '导入所选数据'}</button>
        </div>
        <div class="forge-hint">导入前自动备份到 <code>data/import-backups/</code>，可一键回滚；导入的历史消息一律置为已读。</div>
      ` : `<div class="forge-error">⚠️ 包里的数据没能扫描：${esc(pkg.scan?.error || '未知原因')}</div>`}
    </div>
    ${dataRes}
    ${renderBundleBackups()}
  `;
}

async function runBundleInspect() {
  const b = doctorState.bundle;
  if (bundleBusy()) return;
  const p = String(b.path || '').trim();
  if (!p) { b.error = '请填写包文件路径'; renderDoctorPage(); return; }
  b.inspecting = true; b.error = ''; b.pkg = null; b.drafts = null;
  b.installResult = null; b.dataResult = null;
  renderDoctorPage();
  try {
    const d = await api('/api/bundle/inspect', {
      method: 'POST', body: JSON.stringify({ path: p }), timeoutMs: 120000
    });
    b.pkg = d;
    if (d.ok) {
      // 默认全选包里能装的扩展 + 有新增的会话
      b.selPkgModules = new Set((d.modules || []).map((m) => m.key));
      b.selChats = new Set((d.scan?.messages || []).filter((it) => !it.target || it.extra > 0).map((it) => it.chatKey));
      b.memorySel = !!(d.scan?.memory?.chats || []).length;
      b.statsSel = {};
      for (const st of d.scan?.stats || []) b.statsSel[st.id] = true;
      b.strategy = 'merge';
    } else {
      b.error = d.error || '读取失败';
    }
  } catch (e) {
    b.error = e?.message || '读取请求失败';
  }
  b.inspecting = false;
  renderDoctorPage();
}

async function runBundleStage() {
  const b = doctorState.bundle;
  if (bundleBusy() || !b.pkg?.ok || !b.selPkgModules.size) return;
  b.staging = true; b.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/bundle/stage', {
      method: 'POST',
      body: JSON.stringify({ bundleId: b.pkg.bundleId, keys: [...b.selPkgModules] }),
      timeoutMs: 180000
    });
    if (!d.ok) b.error = d.error || '登台失败';
    else b.drafts = d.drafts || [];
  } catch (e) {
    b.error = e?.message || '登台请求失败';
  }
  b.staging = false;
  renderDoctorPage();
}

async function runBundleInstall() {
  const b = doctorState.bundle;
  if (bundleBusy() || !b.drafts) return;
  const targets = b.drafts.filter((d) => d.ok && d.gate?.ok && b.selPkgModules.has(d.key));
  if (!targets.length) { b.error = '没有可安装的扩展（未登台 / 被闸门阻断）'; renderDoctorPage(); return; }
  const confirmTotal = targets.reduce((n, d) => n + (d.gate?.confirm || 0), 0);
  const names = targets.map((d) => d.key.split(':')[1]).join('、');
  if (!await qaConfirm({
    title: '确认安装',
    confirmText: '安装',
    message: `确认安装这 ${targets.length} 个扩展？\n\n${names}\n\n`
      + (confirmTotal ? `其中共 ${confirmTotal} 项「需确认」能力（文件系统 / 联网 / 子进程等）。\n\n` : '')
      + '每个扩展仍然单独过闸并各签一张票（一次确认不等于免检）。'
      + (b.installEnable ? '\n装完会直接启用。' : '\n装完是关闭状态，需要你到模块页手动开启。')
  })) return;

  b.installing = true; b.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/bundle/install', {
      method: 'POST',
      body: JSON.stringify({
        items: targets.map((t) => ({ draftId: t.draftId, confirmIssues: (t.gate?.confirm || 0) > 0 })),
        enable: b.installEnable === true
      }),
      timeoutMs: 120000
    });
    b.installResult = d;
    if (!d.ok && d.error) b.error = d.error;
    try { await loadForgeStatus(); } catch { /* 刷新草稿列表失败不影响安装结果 */ }
  } catch (e) {
    b.error = e?.message || '安装请求失败';
  }
  b.installing = false;
  renderDoctorPage();
}

async function runBundleImportData() {
  const b = doctorState.bundle;
  if (bundleBusy() || !b.pkg?.ok) return;
  const chatKeys = [...b.selChats];
  const statsOn = Object.entries(b.statsSel).filter(([, v]) => v).map(([k]) => k);
  const memChats = b.pkg.scan?.memory?.chats || [];
  if (!chatKeys.length && !(b.memorySel && memChats.length) && !statsOn.length) {
    b.error = '没有勾选任何要导入的数据'; renderDoctorPage(); return;
  }
  const summary = [
    chatKeys.length ? `会话存档 ${chatKeys.length} 个` : '',
    (b.memorySel && memChats.length) ? '群友印象' : '',
    statsOn.length ? `统计 ${statsOn.length} 项` : ''
  ].filter(Boolean).join(' + ');
  if (!await qaConfirm({
    title: '导入数据',
    confirmText: '开始导入',
    message: `确认导入？\n\n${summary}\n\n导入前会自动备份被改动的文件，导入后可一键回滚。\n导入的历史消息一律置为已读，不会触发机器人回复。`
  })) return;

  b.importingData = true; b.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/bundle/import-data', {
      method: 'POST',
      body: JSON.stringify({
        bundleId: b.pkg.bundleId,
        selection: {
          messages: { chatKeys, strategy: b.strategy },
          memory: !!(b.memorySel && memChats.length),
          stats: b.statsSel
        }
      }),
      timeoutMs: 300000
    });
    b.dataResult = d.ok ? d : null;
    if (!d.ok) b.error = d.error || '导入失败';
  } catch (e) {
    b.error = e?.message || '导入请求失败';
  }
  b.importingData = false;
  renderDoctorPage();
}

function bindBundleEvents(box) {
  const b = doctorState.bundle;
  const $b = (sel) => box.querySelector(sel);

  box.querySelectorAll('[data-bundle-tab]').forEach((el) => {
    el.addEventListener('click', () => {
      const t = el.getAttribute('data-bundle-tab');
      if (!t || b.tab === t) return;
      b.tab = t;
      renderDoctorPage();
    });
  });

  $b('#bundle-refresh')?.addEventListener('click', async () => {
    b.options = null;
    await loadBundleOptions();
    renderDoctorPage();
  });
  $b('#bundle-note')?.addEventListener('input', (e) => { b.note = e.target.value; });
  $b('#bundle-export-btn')?.addEventListener('click', () => runBundleExport());
  $b('#bundle-reveal-btn')?.addEventListener('click', async () => {
    try { await api('/api/bundle/reveal', { method: 'POST', body: '{}', timeoutMs: 10000 }); }
    catch (e) { b.error = e?.message || '打开目录失败'; renderDoctorPage(); }
  });

  box.querySelectorAll('[data-bundle-mod]').forEach((el) => {
    el.addEventListener('change', () => {
      const k = el.getAttribute('data-bundle-mod');
      if (!k) return;
      if (el.checked) b.selModules.add(k); else b.selModules.delete(k);
      renderDoctorPage();
    });
  });
  box.querySelectorAll('[data-bundle-data]').forEach((el) => {
    el.addEventListener('change', () => {
      const k = el.getAttribute('data-bundle-data');
      if (!k) return;
      if (el.checked) b.selData.add(k); else b.selData.delete(k);
      renderDoctorPage();
    });
  });

  $b('#bundle-path')?.addEventListener('input', (e) => { b.path = e.target.value; });
  $b('#bundle-inspect-btn')?.addEventListener('click', () => runBundleInspect());

  box.querySelectorAll('[data-bundle-pkgmod]').forEach((el) => {
    el.addEventListener('change', () => {
      const k = el.getAttribute('data-bundle-pkgmod');
      if (!k) return;
      if (el.checked) b.selPkgModules.add(k); else b.selPkgModules.delete(k);
      renderDoctorPage();
    });
  });
  $b('#bundle-stage-btn')?.addEventListener('click', () => runBundleStage());
  $b('#bundle-install-btn')?.addEventListener('click', () => runBundleInstall());
  $b('#bundle-install-enable')?.addEventListener('change', (e) => { b.installEnable = !!e.target.checked; renderDoctorPage(); });
  $b('#bundle-memory-sel')?.addEventListener('change', (e) => { b.memorySel = !!e.target.checked; renderDoctorPage(); });
  box.querySelectorAll('[data-bundle-chat]').forEach((el) => {
    el.addEventListener('change', () => {
      const k = el.getAttribute('data-bundle-chat');
      if (!k) return;
      if (el.checked) b.selChats.add(k); else b.selChats.delete(k);
      renderDoctorPage();
    });
  });
  box.querySelectorAll('[data-bundle-stat]').forEach((el) => {
    el.addEventListener('change', () => {
      const k = el.getAttribute('data-bundle-stat');
      if (!k) return;
      b.statsSel[k] = !!el.checked;
      renderDoctorPage();
    });
  });
  box.querySelectorAll('input[name="bundle-strategy"]').forEach((el) => {
    el.addEventListener('change', () => { if (el.checked) b.strategy = el.value; });
  });
  $b('#bundle-data-btn')?.addEventListener('click', () => runBundleImportData());
  $b('#bundle-reload-backups')?.addEventListener('click', async () => {
    await loadBundleBackups();
    renderDoctorPage();
  });
  box.querySelectorAll('[data-bundle-rollback]').forEach((el) => {
    el.addEventListener('click', () => runBundleRollback(el.getAttribute('data-bundle-rollback')));
  });
}

/* ── 导入备份与回滚 ───────────────────────────────────────────────────────
 * 这一块从原「数据移植」页搬过来。数据导入前的备份如果界面上没有入口，
 * "可回滚"就等于要手工去 data/import-backups 里翻。
 * 数据入口现在只有「接收整包」一个，回滚就必须跟着它。
 */

async function loadBundleBackups() {
  const b = doctorState.bundle;
  b.backupsLoading = true;
  try {
    const d = await api('/api/migrate/backups', { timeoutMs: 15000 });
    b.backups = Array.isArray(d?.backups) ? d.backups : [];
  } catch {
    b.backups = b.backups || [];   // 拉不到就保留上一次的，不清空（清空会让用户以为备份丢了）
  }
  b.backupsLoading = false;
}

function renderBundleBackups() {
  const b = doctorState.bundle;
  const list = b.backups || [];
  return `
    <div class="forge-input" style="margin-top:10px">
      <div class="forge-hint" style="margin-bottom:6px">
        导入备份（${list.length}）· 存在 <code>data/import-backups/</code>
        <button class="btn btn-small" id="bundle-reload-backups" style="margin-left:8px"${bundleBusy() ? ' disabled' : ''}>刷新</button>
      </div>
      ${list.length ? list.slice(0, 20).map((x) => `
        <div class="fd-row">
          <span class="fd-name"><b>${esc(x.id)}</b></span>
          <span class="fd-info">${esc(String(x.manifest?.sourceDir || x.manifest?.source || '来源未知'))} · ${(x.manifest?.actions || []).length} 个文件</span>
          <button class="btn btn-small" data-bundle-rollback="${esc(x.id)}"${bundleBusy() ? ' disabled' : ''}>回滚</button>
        </div>`).join('')
      : `<div class="forge-hint">${b.backupsLoading ? '正在读取…' : '还没有导入过数据（或备份已被清理）。'}</div>`}
      <div class="forge-hint">回滚 = 把备份里的文件原样搬回 <code>data/</code>，并重建相关会话的记忆索引。备份之后新产生的消息会被覆盖（以备份为准）。</div>
    </div>`;
}

async function runBundleRollback(backupId) {
  const b = doctorState.bundle;
  if (bundleBusy() || !backupId) return;
  if (!await qaConfirm({
    title: '回滚备份',
    danger: true,
    confirmText: '确认回滚',
    message: `回滚备份 ${backupId}？\n\n备份里的文件会原样搬回 data/，之后重建相关会话的记忆索引。\n备份与现在之间新产生的消息会被覆盖（以备份为准）。`
  })) return;
  b.rollingBack = true; b.error = '';
  renderDoctorPage();
  try {
    const d = await api('/api/migrate/rollback', {
      method: 'POST', body: JSON.stringify({ backupId }), timeoutMs: 300000
    });
    b.rollingBack = false;
    if (!d.ok) b.error = d.error || '回滚失败';
    else {
      b.dataResult = null;
      await loadBundleBackups();
      qaAlert(`已回滚到备份 ${backupId}。\n\n相关会话的记忆索引已重建。`);
    }
  } catch (e) {
    b.rollingBack = false;
    b.error = e?.message || '回滚请求失败';
  }
  renderDoctorPage();
}

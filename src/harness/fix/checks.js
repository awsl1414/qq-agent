// 协议闸 + 自验验证器。
//
// ── 两个东西为什么放在一起 ──
//   它们回答的是同一个问题："这版改动能不能交给人工看一眼？"
//   协议闸判**合规**（是不是碰了禁区、是不是最小改动、声明齐不齐），
//   验证器判**可运行**（语法过不过、自检有没有新增问题、测试绿不绿）。
//   协议闸读取暂存区与原文件；各验证器的数据来源见各自结果，不能统称沙箱验证。
//
// 静态检查是启发式的，不是沙箱。它挡得住"模型顺手写出危险东西"，
// 挡不住精心构造的绕过。所以它必须与人工闸②配合使用。
//
// src/harness/forge/gate.js 管生成的新扩展，本文件管改现有代码。
// 两者现均为内置核心模块；危险规则表各自维护，新增安全规则时应同时核对两条链路。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stagedPath, resolveTarget, diffStat, sandboxDir, backupPath } from './core.js';

// ── 危险模式（block 一票否决 / confirm 标红 / notice 提示）────────────────
//
// 与 `src/harness/forge/gate.js` 的 DANGER_RULES 有交集，但不是相同的检查集合。
// 曾经凭据漏洞的修复只落到 gate.js、这份漏了，于是
// `import fs from 'node:fs'` + 读 `config.json` 的改动能通过本协议闸，
// 而协议闸正是 self-fix 落盘前唯一的自动防线。
// **改这两张表的任何一张时，必须同步另一张。**
const DANGER_RULES = [
  { id: 'child-process', level: 'block', re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexecFileSync\b/,
    title: 'shell 执行（child_process）', why: '修复不应引入系统命令调用 —— 这等于把整台机器交给改动的代码。' },
  { id: 'process-exit', level: 'block', re: /\bprocess\.exit\s*\(|\bprocess\.abort\s*\(/,
    title: '终止进程（process.exit）', why: '会直接杀掉整个应用。要表达"这次调用失败"请 return { isError: true }。' },
  // 凭据：必须覆盖**真实存放凭据的文件名**。
  // 教训（与 gate.js 的 DANGER_RULES 同源）：只认 account.json 时，API Key
  // 实际在 data/config.json 里：`JSON.parse(fs.readFileSync('data/config.json')).apiKey`
  // 完整地穿了过去。`apiKey\s*[:=]\s*['"]…` 只挡得住"硬编码字面量"。
  { id: 'credential-read', level: 'block',
    re: /account\.json|config\.json|\.env\b|apiKey\s*[:=]\s*['"][^'"]{8,}|dshProviderKeys|accessToken|httpAccessToken|\bcookie\b/i,
    title: '读取凭据', why: '凭据泄露的一票否决项：API Key 在 config.json，网关 token 也在配置里。需要配置请走既有的配置 API。' },
  // 能力闸：字符串黑名单追不上 require('f'+'s') 这类等价写法，import 目标
  // 在静态字面量形式下可检查（含 export … from）；变量 import 等动态形式仍有局限，
  // 完整语义分析不能靠正则替代，这里先守住常见形态。
  { id: 'dangerous-import', level: 'block',
    re: /(?:^|[^\w$.])(?:import\s[\s\S]{0,80}?from\s*|\bexport\s[\s\S]{0,80}?from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:node:)?(?:fs(?:\/promises)?|child_process|cluster|dgram|net|tls|worker_threads|inspector|v8|vm|module)['"]/,
    title: '导入高危 Node 模块（fs / child_process / net / vm 等）',
    why: '修复不应直接读文件、起进程或开 socket —— 那会绕过整套权限体系，也正是凭据泄露与命令执行的入口。' },
  { id: 'env-read', level: 'block', re: /\bprocess\.env\b/,
    title: '读取环境变量（process.env）', why: '环境变量里有 token / 密钥。与读 config.json 同等级。' },
  { id: 'path-escape', level: 'block', re: /\.\.\s*\/|\.\.\\\\/,
    title: '向上穿越路径', why: '改动引入了越出自身目录的路径访问。' },
  { id: 'dynamic-eval', level: 'confirm', re: /\beval\s*\(|new\s+Function\s*\(|vm\.runIn/,
    title: '动态执行（eval / new Function）', why: '入参若可被外部影响，等于任意代码执行。' },
  { id: 'destructive-fs', level: 'confirm', re: /\brmSync\s*\(|\brmdirSync\s*\(|\brimraf\b|\btruncateSync\b/,
    title: '删除类文件操作', why: '修复不应删除文件。需要重置状态请覆盖写为初始值。' },
  { id: 'write-outside', level: 'confirm', re: /\bwriteFileSync\s*\(/,
    title: '写文件', why: '确认这个写操作的范围是否只在自己目录内。' },
  { id: 'console-log', level: 'notice', re: /\bconsole\.log\s*\(/,
    title: '残留调试输出', why: '生产代码请用 logger / api.log()。' }
];

/** 白名单验证器：模型只能从这张表里选，不能提供任意命令。 */
export const VERIFIERS = [
  { id: 'syntax', label: '语法检查', hard: true, desc: 'node --check 解析每个改动的 JS 文件' },
  { id: 'protocol', label: '协议闸', hard: true, desc: 'P1-P9 合规检查 + 五道闸门' },
  { id: 'scan', label: '自检扫描', hard: false, desc: '扫描真实源码中的改动目标，不对比沙箱改动或历史基线' },
  { id: 'tests', label: '回归测试', hard: false, desc: '跑 tests/（缺失时 .workbuddy/tools/）内的真实测试脚本，未覆盖沙箱改动版' },
  { id: 'load', label: '加载冒烟', hard: false, desc: '在子进程里 import 沙箱入口并跑一次 setup()' }
];

export const VERIFIER_IDS = VERIFIERS.map((v) => v.id);

// ── 协议闸 ────────────────────────────────────────────────────────────────

/**
 * 跑协议闸 P1-P9。P10（不得重试到通过）由 routes 的回炉循环控制，不在这里。
 * @returns {{passed:boolean, blocking:number, violations:Array<{code,level,title,detail}>}}
 */
export function runProtocolGate(root, appRoot, dataRoot, rec) {
  const V = [];
  const push = (code, level, title, detail) => V.push({ code, level, title, detail: detail || '' });

  const prop = rec?.proposal || {};
  const changes = Array.isArray(prop.changes) ? prop.changes : [];

  // ── 空提案 = 「本次无需代码修复」（合法终态，**不是**违规）──────────────────
  // 必须在这里早返回：prompt.js 明确允许这种产物：
  //   「若这个问题不该由代码修复（例如其实是配置问题、或用户操作问题），changes 给空数组，
  //     并在 expectedEffect 里说明应该怎么做。」
  // 把空 changes 当 P1 阻断会形成**自相矛盾的死循环**：
  //   诊断说"静态扫描无警告/严重，模型无需介入" → 模型照 prompt 给空 changes
  //   → P1/P8 阻断 → 界面提示"让模型按上面的阻断原因重提" → 模型还是给空 changes
  //   → 永远过不了闸门，也永远不落地任何改动；还堆了一屏"阻断 2 项"的工单。
  // 放行是安全的：空提案没有任何可落地内容：core.js 的 commit 对空 changes 直接拒绝
  //   （'没有改动可落地'），fix.apply 也只会 stage 0 个文件。所以放行只等于"无事可做"，不是放水。
  if (!changes.length) {
    const advice = String(prop.expectedEffect || '').trim();
    return {
      passed: true, blocking: 0, noChange: true,
      violations: [{
        code: 'N0', level: 'info',
        title: '本次无需代码修复（提案没有改动项）',
        detail: '提案的 changes 为空 —— 这是 prompt 允许的合法产物（问题不该由代码修复时如此）。'
          + '没有可落地、也没有可验证的内容，因此判定为「无事可做」，而不是协议违规。'
          + (advice ? `\n提案给出的建议：${advice.slice(0, 300)}` : '')
      }]
    };
  }

  // ── P1 声明义务 ──
  const need = [
    ['rootCause', String(prop.rootCause || '').trim(), '根因'],
    ['expectedEffect', String(prop.expectedEffect || '').trim(), '预期效果'],
    ['rollback', String(prop.rollback || '').trim(), '回滚方式']
  ];
  for (const [k, v, label] of need) {
    if (!v) push('P1', 'block', `P1 声明缺失：${label}`, `提案必须有「${label}」字段（k=${k}）。`);
  }
  // （原「changes 为空 → P1 block」已上移为上面的 noChange 早返回：空提案不再算违规。）
  for (const c of changes) {
    if (!String(c.intent || '').trim()) push('P1', 'block', `P1 声明缺失：${c.path} 没说意图`, '每个改动项都要写"为什么改这里"。');
  }

  // ── P8 单一目标 ──
  if (!rec?.target?.file && !prop.targetFile) {
    push('P8', 'block', 'P8 单一目标：没有指明目标问题', '一次修复必须绑定一个明确的目标问题（file/line/ruleId）。');
  }
  if (changes.length > 6) {
    push('P8', 'warn', `P8 单一目标：涉及 ${changes.length} 个文件`, '一次修复只解决一个问题。涉及文件过多时，很可能夹带了无关改动。');
  }

  // ── P3 自我指涉 / P4 凭据 / P5 用户数据 / 后缀 ──
  for (const c of changes) {
    const r = resolveTarget(root, appRoot, dataRoot, c);
    if (!r.ok) {
      const lvl = r.level === 'L0' ? 'block' : 'block';
      push(r.level === 'L0' ? 'P3' : 'P4/P5', lvl, `禁止的改动目标：${c.path}`, r.error);
      continue;
    }
    // L1 核心是否放行由配置决定；这里先记录级别，路由层按 allowCoreFiles 再加一条 block
    c.level = r.level;
  }

  // ── P2 最小改动 + P6 危险模式 ──
  for (const c of changes) {
    const st = stagedPath(root, idOf(rec), c);
    let after = null;
    try { after = fs.readFileSync(st, 'utf8'); } catch { after = null; }
    if (after === null) {
      push('P2', 'block', `P2 暂存区缺少文件：${c.path}`, '提案声明要改，但暂存区里没有这个文件 —— 请重新 apply。');
      continue;
    }
    // 改动前的内容：优先快照，其次真实文件；都没有则视为新建
    let before = '';
    try { before = fs.readFileSync(backupPath(root, idOf(rec), c), 'utf8'); }
    catch {
      const r = resolveTarget(root, appRoot, dataRoot, c);
      try { before = r.ok ? fs.readFileSync(r.abs, 'utf8') : ''; } catch { before = ''; }
    }
    const stat = diffStat(before, after);
    const limit = Math.min(Math.max(40, Math.ceil(stat.oldLines * 0.3)), 200);
    if (stat.changed > limit) {
      push('P2', 'warn', `P2 大改动：${c.path}（${stat.changed} 行）`,
        `改动行数 ${stat.changed} 超过阈值 ${limit}（该文件 ${stat.oldLines} 行 × 30%，上限 200）。请确认没有夹带格式化/重命名/顺手重构。`);
    }
    if (/\.(js|mjs|cjs)$/i.test(c.path)) {
      const lines = after.split('\n');
      for (const rule of DANGER_RULES) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
          if (!rule.re.test(line.replace(/\/\/.*$/, ''))) continue;
          push('P6', rule.level === 'block' ? 'block' : (rule.level === 'confirm' ? 'warn' : 'info'),
            `${rule.title}（${c.path}:${i + 1}）`, rule.why);
          break;
        }
      }
    }
  }

  // ── P9 自验诚实义务 ──
  const plan = Array.isArray(prop.verifyPlan) ? prop.verifyPlan : [];
  if (!plan.length) {
    push('P9', 'block', 'P9 验证计划为空', '模型必须给出验证计划（从白名单验证器里选）。没有计划就无法自验。');
  }
  for (const p of plan) {
    if (!VERIFIER_IDS.includes(String(p?.verifier || ''))) {
      push('P9', 'block', `P9 验证器不在白名单：${p?.verifier}`, `只允许：${VERIFIER_IDS.join(' / ')}。`);
    }
  }
  if (!plan.some((p) => p?.verifier === 'syntax') || !plan.some((p) => p?.verifier === 'protocol')) {
    push('P9', 'warn', 'P9 缺少硬性验证器', 'syntax 与 protocol 是硬性项，建议始终包含。');
  }

  // ── P7 可回滚义务（预检：落地时还会再强制一次）──
  for (const c of changes) {
    const r = resolveTarget(root, appRoot, dataRoot, c);
    if (r.ok && fs.existsSync(r.abs)) {
      // 已存在的文件必须有快照，但 apply 阶段还没快照，所以这里只是提醒
      continue;
    }
  }

  const blocking = V.filter((v) => v.level === 'block').length;
  return { passed: blocking === 0, blocking, violations: V };
}

/** 从 rec 上取 id（协议闸需要它定位暂存区）。 */
function idOf(rec) { return String(rec?.id || ''); }

// ── 验证器 ────────────────────────────────────────────────────────────────

function nodePathOf(ctx) {
  return String(ctx?.nodePath || process.execPath);
}

/** node --check，逐个改动文件。Electron 主进程里必须带 ELECTRON_RUN_AS_NODE。 */
function vSyntax(root, rec, ctx) {
  const items = [];
  for (const c of rec.proposal.changes || []) {
    if (!/\.(js|mjs|cjs)$/i.test(c.path)) continue;
    const st = stagedPath(root, rec.id, c);
    let code = '';
    try { code = fs.readFileSync(st, 'utf8'); } catch { items.push({ file: c.path, status: 'fail', detail: '暂存区缺少文件' }); continue; }
    if (!code.trim()) continue;
    if (code.charCodeAt(0) === 0xFEFF) code = code.slice(1);
    const inputType = /\.cjs$/i.test(c.path) ? 'commonjs' : 'module';
    const res = spawnSync(nodePathOf(ctx), ['--check', `--input-type=${inputType}`], {
      input: code, timeout: (ctx?.timeoutSec || 30) * 1000, encoding: 'utf8',
      windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    if (res.error || res.status === null) {
      items.push({ file: c.path, status: 'skip', detail: res.error?.code === 'ETIMEDOUT' ? '检查器超时' : `检查器未启动（${res.error?.code || '未知'}）` });
      continue;
    }
    items.push(res.status === 0
      ? { file: c.path, status: 'pass', detail: '解析通过' }
      : { file: c.path, status: 'fail', detail: String(res.stderr || res.stdout || '').trim().split('\n').slice(0, 4).join('\n').slice(0, 600) });
  }
  return items;
}

/** 协议闸作为验证器的一项（与 propose 阶段的预检同一套规则，保证口径一致）。 */
function vProtocol(root, appRoot, dataRoot, rec) {
  const g = runProtocolGate(root, appRoot, dataRoot, rec);
  return [{ file: '(协议闸)', status: g.passed ? 'pass' : 'fail', detail: g.passed ? `通过（告警 ${g.violations.filter((v) => v.level === 'warn').length} 项）` : g.violations.filter((v) => v.level === 'block').map((v) => `${v.code} ${v.title}`).join('；') }];
}

/**
 * 静态扫描：筛出真实源码中本次改动目标的 finding，不比较沙箱或历史基线。
 * 依赖内置自检的 doctor.scan-project 能力；不可用时 skip 并说明。
 */
function vScan(root, rec, ctx) {
  const scan = ctx?.scanProject;
  if (typeof scan !== 'function') {
    return [{ file: '(自检扫描)', status: 'skip', detail: '内置自检扫描能力不可用，跳过（不影响其它验证项）' }];
  }
  const changed = new Set((rec.proposal.changes || []).map((c) => c.path));
  let after;
  try { after = scan({}); } catch (e) { return [{ file: '(自检扫描)', status: 'skip', detail: `扫描失败：${e?.message || e}` }]; }
  if (!Array.isArray(after?.result?.findings)) {
    return [{ file: '(自检扫描)', status: 'skip', detail: '自检未返回扫描结果，无法确认目标文件状态' }];
  }
  const findings = after.result.findings;
  const hits = findings.filter((f) => changed.has(f.file) || changed.has(f.file?.replace(/\\/g, '/')));
  const critical = hits.filter((f) => f.severity === 'critical');
  return [{
    file: '(自检扫描)',
    status: critical.length ? 'fail' : 'pass',
    detail: '扫描真实源码，未验证沙箱改动版或比较历史基线。\n' + (hits.length
      ? `改动文件上有 ${hits.length} 处静态命中（critical ${critical.length}）：\n` + hits.slice(0, 12).map((f) => `  ${f.file}:${f.line} [${f.ruleId}] ${f.detail}`).join('\n')
      : '改动文件上没有静态命中'),
    hits: hits.slice(0, 50)
  }];
}

/**
 * 白名单测试：优先项目 tests/，不存在时采用上游 .workbuddy/tools/，仅 .mjs/.js。
 * 测试脚本本身不知道沙箱的存在，所以它**读的是真实副本**，不是沙箱里的改动版。
 * 这一点必须在结果里说明，不能让人误以为"沙箱验过了"。
 */
function vTests(root, rec, ctx, args) {
  const rel = String(args?.file || '').trim();
  if (!rel) return [{ file: '(回归测试)', status: 'skip', detail: '验证计划没有指定测试文件' }];
  const projectRoot = String(ctx?.projectRoot || '');
  if (!projectRoot) return [{ file: rel, status: 'skip', detail: '未提供项目根目录，无法定位白名单测试目录' }];
  const testDir = ['tests', '.workbuddy/tools'].find((dir) => {
    try { return fs.statSync(path.join(projectRoot, dir)).isDirectory(); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw e; }
  });
  if (!testDir) {
    return [{
      file: rel,
      status: 'skip',
      detail: '本环境没有测试目录（tests/ 或 .workbuddy/tools/）—— tests 验证不可用，已跳过。'
        + '请改用 load（加载冒烟）/ scan（静态扫描）验证本次改动。'
    }];
  }
  const allowedRoot = path.resolve(projectRoot, testDir);
  const abs = path.resolve(projectRoot, rel);
  const isInside = (base, file) => {
    const back = path.relative(base, file);
    return back !== '' && back !== '..' && !back.startsWith(`..${path.sep}`) && !path.isAbsolute(back);
  };
  const denied = () => [{ file: rel, status: 'fail', detail: `测试文件不在白名单目录（只允许 ${testDir}/ 下的 .mjs/.js，禁止链接越界）` }];
  if (!isInside(allowedRoot, abs) || !/\.(mjs|js)$/i.test(abs)) {
    return denied();
  }
  if (!fs.existsSync(abs)) return [{ file: rel, status: 'fail', detail: '测试文件不存在' }];
  const realRoot = fs.realpathSync(allowedRoot);
  const realFile = fs.realpathSync(abs);
  // 白名单根本身也不能借 junction 改指 src/ 或项目外；项目根的真实路径可正常规范化。
  if (path.relative(path.join(fs.realpathSync(projectRoot), testDir), realRoot) !== ''
      || !isInside(realRoot, realFile) || !/\.(mjs|js)$/i.test(realFile) || !fs.statSync(realFile).isFile()) {
    return denied();
  }
  const res = spawnSync(nodePathOf(ctx), ['--test', realFile], {
    cwd: String(ctx?.sandbox || projectRoot), timeout: (ctx?.timeoutSec || 30) * 1000,
    encoding: 'utf8', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', QQ_AGENT_FIX_SANDBOX: String(ctx?.sandbox || '') }
  });
  if (res.error || res.status === null) {
    return [{ file: rel, status: 'skip', detail: res.error?.code === 'ETIMEDOUT' ? `超时（>${ctx?.timeoutSec || 30}s）` : `未启动（${res.error?.code || '未知'}）` }];
  }
  const out = String(res.stdout || '').slice(-8000);
  const err = String(res.stderr || '').slice(-4000);
  return [{
    file: rel, status: res.status === 0 ? 'pass' : 'fail',
    detail: `退出码 ${res.status}（⚠️ 测试脚本按真实路径运行，未隔离到沙箱改动版）`,
    stdout: out, stderr: err
  }];
}

/**
 * 加载冒烟：在**子进程**里 import 沙箱里的插件/技能入口并跑一次 setup()。
 * 必须进子进程：模型改的代码一旦 import 进主进程就有完整权限，
 * 崩了/挂死了会拖垮整个机器人。子进程 + 超时是最低成本的隔离。
 */
function vLoad(root, rec, ctx) {
  const entries = (rec.proposal.changes || [])
    .filter((c) => /^plugins\/[^/]+\/index\.(js|mjs|cjs)$/.test(c.path) || /^skills\/[^/]+\/index\.(js|mjs|cjs)$/.test(c.path));
  if (!entries.length) return [{ file: '(加载冒烟)', status: 'skip', detail: '本次改动不涉及插件/技能入口，无需冒烟' }];
  const sb = sandboxDir(root, rec.id);
  const boot = [
    'const path=require("node:path");',
    'const {pathToFileURL}=require("node:url");',
    'const entry=pathToFileURL(process.env.FIX_ENTRY).href;',
    'const mock={registerTool(){},config(){return{}},log(){},warn(){},error(){},',
    '  capability(){return undefined},hasCapability(){return false},fetch:globalThis.fetch,utils:{}};',
    '(async()=>{try{const m=await import(entry);',
    '  if(typeof m.setup==="function")await m.setup(mock);',
    '  else if(typeof m.register==="function")await m.register(mock);',
    '  console.log("SMOKE_OK");',
    '}catch(e){console.log("SMOKE_FAIL "+(e&&e.stack||e));process.exitCode=1;}})();'
  ].join('\n');
  const items = [];
  for (const c of entries) {
    const st = stagedPath(root, rec.id, c);
    if (!fs.existsSync(st)) { items.push({ file: c.path, status: 'fail', detail: '暂存区缺少入口文件' }); continue; }
    const res = spawnSync(nodePathOf(ctx), ['--input-type=commonjs', '-e', boot], {
      cwd: sb, timeout: (ctx?.timeoutSec || 30) * 1000, encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', FIX_ENTRY: st }
    });
    if (res.error || res.status === null) { items.push({ file: c.path, status: 'skip', detail: '冒烟未完成（超时或未启动）' }); continue; }
    const out = String(res.stdout || '');
    items.push({
      file: c.path,
      status: out.includes('SMOKE_OK') && res.status === 0 ? 'pass' : 'fail',
      detail: (out.includes('SMOKE_OK') ? 'setup() 正常返回' : 'setup() 抛错'),
      stdout: out.slice(-4000), stderr: String(res.stderr || '').slice(-2000)
    });
  }
  return items;
}

/**
 * 跑一整套验证计划，返回逐项结果。
 * @returns {{ plan, items, passed, hardFailed, newProblems }}
 */
export function runVerifyPlan(root, appRoot, dataRoot, rec, ctx) {
  const plan = Array.isArray(rec?.proposal?.verifyPlan) ? rec.proposal.verifyPlan : [];
  const items = [];
  for (const p of plan) {
    const vid = String(p?.verifier || '');
    let rows = [];
    try {
      if (vid === 'syntax') rows = vSyntax(root, rec, ctx);
      else if (vid === 'protocol') rows = vProtocol(root, appRoot, dataRoot, rec);
      else if (vid === 'scan') rows = vScan(root, rec, ctx);
      else if (vid === 'tests') rows = vTests(root, rec, ctx, p);
      else if (vid === 'load') rows = vLoad(root, rec, ctx);
      else rows = [{ file: vid || '(未知)', status: 'fail', detail: `不在白名单：${vid}` }];
    } catch (e) {
      rows = [{ file: vid || '(未知)', status: 'fail', detail: `验证器抛错：${e?.message || e}` }];
    }
    const meta = VERIFIERS.find((v) => v.id === vid) || { label: vid, hard: false };
    for (const r of rows) items.push({ verifier: vid, label: meta.label, hard: !!meta.hard, ...r });
  }
  const hardIds = new Set(['syntax', 'protocol']);
  const hardFailed = items.some((i) => i.status === 'fail' && hardIds.has(i.verifier));
  const anyFailed = items.some((i) => i.status === 'fail');
  // 「硬性验证项没跑成」必须和「通过」区分开：
  //   检查器起不来（环境问题）时我们**并不知道**代码是否合法，静默算通过是危险的。
  //   这里单独标出来，UI 上会显示"有硬性项未能运行"，让闸②的人工决断带上这层怀疑。
  const hardSkipped = items.some((i) => i.status === 'skip' && hardIds.has(i.verifier));
  const failures = items.filter((i) => i.status === 'fail');
  return {
    at: Date.now(),
    plan,
    items,
    passed: !anyFailed,
    hardFailed,
    hardSkipped,
    // 收敛保护用：失败项指纹（集合没缩小就停）
    failureKey: failures.map((i) => `${i.verifier}:${i.file}`).sort().join('|'),
    failCount: failures.length,
    skipped: items.filter((i) => i.status === 'skip').length
  };
}

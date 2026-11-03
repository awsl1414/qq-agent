// 自创扩展的**五道闸门**：结构 → 语法 → 危险模式 → 声明-实现一致 → 环境适配。
//
// 全部通过才允许进入"人工确认 → 落地"环节。任一不过就把逐条原因回给模型，
// 让它自己改（这比直接拒绝更好用：模型看到"第 12 行用了 child_process"就会换实现）。
//
// ── 为什么不用 self-doctor/scan.js 的规则 ──
//   1. **语义不同**。scan.js 是 lint（severity: info/warning，"你可能想看看"），
//      对 `eval` 的态度是注释里明写的"计算器技能属预期用法"，刻意宽松。
//      这里要的是**安全策略**（block/confirm/allow），尺度必须更严。
//   2. **项目约定**：每个 Skill 自包含，不跨插件 import
//      （plugin-loader.js 明确把"逃出自包含模型"列为要防的事）。
//   3. 两者的重叠部分（child_process / dynamic-eval / process-exit）在这里都覆盖到了，
//      并额外补上了凭据读取、符号链接等在**生成代码**场景下才特别危险的项。
//
// 静态扫描是启发式的，不是沙箱。它挡的是"模型顺手写出危险调用"，
// 挡不住精心构造的绕过。所以它必须与**人工确认**配合使用，见 index.js 的注释。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';   // 语法闸结果缓存的哈希
import { spawnSync } from 'node:child_process';
import { draftDir } from './forge-tools.js';

// 闸门的文件数上限。**注意与写盘时的防跑飞上限（forge-tools 的 20）是两件事**：
// 写盘那道上限管的是"模型别一次生成上百个文件"；这道只管"这个包是不是离谱地大"。
// 用 20 会拦死正常的第三方包：27 个文件的包（emotion-core）在「改别人的包」里被拦死，
// 且结构闸一失败后面四道检查全跳过，用户以为"配置坏了"。
export const GATE_MAX_FILES = 200;

// ── 闸门 2 的策略表 ────────────────────────────────────────────────────────
//
// level 的含义：
//   block：一票否决。模型必须换实现，用户也无法放行。
//   confirm：标红，但用户在界面上可以显式放行（有些是正当用法）。
//   notice：只提示，不拦。
//
// why 会直接展示给模型，所以要写成"为什么不行 + 怎么改"。
const DANGER_RULES = [
  {
    id: 'child-process',
    level: 'block',
    // 查 import 与调用两种形态：只要出现就说明要用 shell
    re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexecFileSync\b|\bspawn\s*\(|\bexec\s*\(/,
    title: 'shell 执行（child_process）',
    why: '自动生成的扩展没有理由调用系统命令 —— 这等于把整台机器交给模型生成的代码。'
      + '如果确实需要跑外部程序，请改成用纯 JS 实现，或把需求告诉用户由人工实现。'
  },
  {
    id: 'process-exit',
    level: 'block',
    re: /\bprocess\.exit\s*\(|\bprocess\.abort\s*\(/,
    title: '终止进程（process.exit）',
    why: '会直接杀掉整个应用，且在工具调用中触发时用户看不到任何解释。'
      + '要表达"这次调用失败"，请 return { isError: true }。'
  },
  {
    id: 'credential-read',
    level: 'block',
    // 必须覆盖**真实存放凭据的文件名**，而不只是"代码里硬编码了一个字面量"。
    // 教训（审查）：只认 account.json 时，
    //   JSON.parse(fs.readFileSync('data/config.json')).apiKey
    // 完整地穿了过去，而 apiKey 恰恰就存在 data/config.json 里（不是 account.json）。
    // `apiKey\s*[:=]\s*['"]…` 只能挡住"硬编码字面量"，挡不住"读文件再取字段"这一真实攻击形态。
    re: /account\.json|config\.json|\.env\b|apiKey\s*[:=]\s*['"][^'"]{8,}|dshProviderKeys|accessToken|httpAccessToken|\bcookie\b/i,
    title: '读取凭据',
    why: '这是凭据泄露的一票否决项：API Key 在 data/config.json，OneBot/网关 token 也在配置里。'
      + '需要配置请通过 api.config()（清单 settings 声明过的项），不要直接读文件。'
  },
  {
    // ── 能力闸（比字符串黑名单更可靠的一条路）────────────────────────────
    // `credential-read` 这类正则永远追不上等价写法
    // （require('f'+'s')、fs['readFileSync']、动态 import）。真正稳定的判据是
    // **代码需不需要这些模块的能力**：出现了就说明要碰文件系统/进程/网络栈，
    // 而自动生成的扩展没有任何正当理由需要它们。
    id: 'dangerous-import',
    level: 'block',
    re: /(?:^|[^\w$.])(?:import\s[\s\S]{0,80}?from\s*|import\s*\(?\s*|require\s*\(\s*|import\s+)['"](?:node:)?(?:fs(?:\/promises)?|child_process|cluster|dgram|net|tls|worker_threads|inspector|v8|vm|module)['"]/,
    title: '导入高危 Node 模块（fs / child_process / net / vm 等）',
    why: '自动生成的扩展不需要直接读文件、起进程或开 socket —— 扩展的数据应当通过 '
      + 'api.storage.get(key) / api.storage.set(key, value) 持久化（宿主落在扩展自己的数据目录），'
      + '网络必须走 api.fetch()（有权限声明与审计）。直接 import 这些模块等于绕过整套权限体系，'
      + '也正是凭据泄露（读 config.json）与命令执行的入口。请改用 api.* 能力。'
  },
  {
    // process.getBuiltinModule 是 **Node 22+ 内置**的取模块通道：
    //   它既不写 import 也不写 require，任何基于这两者的正则都结构性看不见它
    //   （`process.getBuiltinModule('child_process')` 即可拿到完整进程能力）。
    //   自动生成的扩展没有任何正当用途需要它 → 与导入高危模块同档，直接 block。
    id: 'builtin-module-bypass',
    level: 'block',
    re: /process\s*\.\s*getBuiltinModule\b/,
    title: 'process.getBuiltinModule（绕过模块导入检查）',
    why: 'Node 22+ 的 process.getBuiltinModule 能不经 import/require 直接拿到 fs / child_process '
      + '等模块，等于绕开本闸门的模块检查。扩展需要的能力请走 api.*。'
  },
  {
    id: 'path-escape',
    level: 'block',
    re: /\.\.\s*\/|\.\.\\\\|path\.join\([^)]*process\.cwd\(\)\s*,\s*['"]\.\./,
    title: '向上穿越路径',
    why: '试图访问扩展目录之外的位置。扩展只应操作自己的目录或 api 提供的路径。'
  },
  {
    id: 'dynamic-eval',
    level: 'confirm',
    // eslint-disable-next-line no-useless-escape
    re: /\beval\s*\(|new\s+Function\s*\(|vm\.runIn/,
    title: '动态执行（eval / new Function）',
    why: '入参若可被外部影响，等于任意代码执行。计算器这类"只算数字表达式"是正当用法，'
      + '但请确保入参先经过严格白名单校验（例如只允许数字与运算符）。'
  },
  {
    id: 'network',
    level: 'confirm',
    re: /\bfetch\s*\(|https?:\/\/|require\(['"]https?['"]\)|node:https?/,
    title: '网络访问',
    why: '生成的扩展要联网必须有清单权限声明。请确认这是需求的必要部分，'
      + '并在 skill.json 的 permissions 里加上 web_fetch。'
  },
  {
    id: 'destructive-fs',
    level: 'confirm',
    re: /\bunlinkSync\b|\brmSync\b|\brmdirSync\b|\brimraf\b|\btruncateSync\b/,
    title: '删除类文件操作',
    why: '扩展不应删除文件（哪怕是自己的）。需要重置状态请覆盖写为初始值。'
  },
  {
    id: 'env-read',
    level: 'block',
    re: /\bprocess\.env\b/,
    title: '读取环境变量（process.env）',
    why: '环境变量里常有 token / 密钥（QQ_AGENT_* 系列、以及本进程继承来的任何机密）。'
      + '把环境变量的值返回给模型等于把整台机器的机密放进聊天记录 —— 与读 config.json 同等级，'
      + '故与凭据读取一并 block。需要配置请用 api.config()（清单 settings 声明的项）。'
  },
  {
    id: 'dynamic-import',
    level: 'confirm',
    // import(变量)：import() 后面不是引号/反引号开头 → 运行期才决定加载什么，
    // 静态分析全部失效（含本闸门的其它规则），闸门拦不住你真正 import 的东西。
    re: /\bimport\s*\(\s*[^'"`)]/,
    title: '动态 import（加载目标在运行期才确定）',
    why: 'import(变量) 会绕过所有静态检查 —— 闸门无法知道你最终加载了什么代码。'
      + '请改为静态 import 声明，或 import 字符串字面量。'
  },
  {
    // 上一条规则只拦"import( 后面不是引号"的形态，
    //   而**引号里的拼接**同样让加载目标在运行期才确定：
    //     require('node:child' + '_process') / import('node:' + m)（拼接）
    //     await import(`node:${m}`)（模板串）
    //   两者都能拿到完整 Node 能力，却完全不过上一条正则（首字符是引号）。
    //   定 confirm 而不是 block：本地动态加载（拼接自己的文件路径）是正当用法，
    //   交给人工确认；提示文字里说清"运行期决定的加载目标"这个实质。
    id: 'dynamic-load-nonliteral',
    level: 'confirm',
    re: /(?:require|import)\s*\(\s*(?:[^()"'`;]|\([^()]*\)|['"][^'"]*['"])*?\+|(?:require|import)\s*\(\s*`[^`]*\$\{/,
    title: '运行期拼接模块名（require/import 参数是表达式）',
    why: 'require/import 的参数字符串是拼出来或模板串插值的 —— 加载目标在运行期才确定，'
      + '静态闸门无法判断它最终加载了什么（拼接出 node:child_process 这类即可拿到完整进程能力）。'
      + '请改成字符串字面量；确实要动态加载自己目录下的文件，请人工确认后继续。'
  },
  {
    id: 'write-protected',
    level: 'confirm',
    // 写调用 + 敏感目标出现在同一调用括号内：往应用关键路径写 = 自装/自改/清配置
    re: /write\s?File(Sync)?\s*\([^)]{0,160}(config\.json|plugins|skills|\.env|package\.json)|createWriteStream\s*\([^)]{0,160}(config\.json|plugins|skills|\.env)/,
    title: '写入应用关键路径',
    why: '往 plugins/ / skills/ / config.json 等路径写文件，等于扩展给自己开后门：'
      + '重启后会被当正式扩展加载，或直接改掉应用配置。扩展只应写自己目录内的文件。'
  },
  {
    id: 'timer-leak',
    level: 'notice',
    // 全文级规则（check 而非 re）：单看一行判断不了：setInterval 出现但
    // 同文件没有 clearInterval 才算泄漏；deactivate 里清了就是正经写法。
    check: (code) => /setInterval\s*\(/.test(code) && !/clearInterval\s*\(/.test(code),
    title: 'setInterval 没有 clearInterval（疑似定时器泄漏）',
    why: '定时器会让扩展卸载后仍在后台跑。请在合适的时机（如 dispose / deactivate）clearInterval。'
  },
  {
    id: 'huge-literal',
    level: 'notice',
    // 单个字符串字面量 >32KB：体积炸弹，git/编辑器/闸门扫描都被拖慢，模型读不动
    re: /'[^'\n]{32768,}'|"[^"\n]{32768,}"|`[^`]{32768,}`/,
    title: '超大字符串字面量（>32KB）',
    why: '内置大段文本请放到独立数据文件并分段读取，不要内联进代码。'
  },
  {
    id: 'unbounded-loop',
    level: 'notice',
    re: /while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/,
    title: '看似无界的循环',
    why: '若循环条件依赖外部输入，可能卡死主进程。请确保有明确的退出条件。'
  },
  {
    id: 'console-log',
    level: 'notice',
    re: /\bconsole\.log\s*\(/,
    title: '残留调试输出',
    why: '生产扩展请用 api.log()，它带 skillId 前缀，便于在日志里定位来源。'
  }
];

/** 清单必填项与格式。 */
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const API_VERSION = 1;

/**
 * 跑完五道闸门。
 *
 * 前四道（结构 / 语法 / 危险模式 / 声明-实现）回答的是"这东西**安全吗、能装上吗**"。
 * 第五道 `env`（本地环境适配）回答的是另一个问题：**装上之后能正常工作吗**：
 * 第三方扩展常常用着本机没有的能力、或调用了本地不存在的 API。
 * 这一道只在调用方提供了 env 时才跑（纯函数不知道本机装了啥）。
 *
 * @param {object} ctx
 * @param {string} draftId
 * @param {object} [opts]
 * @param {boolean} [opts.allowNetwork]
 * @param {{hasCapability?: (n:string)=>boolean, existingIds?: Set<string>, envReady?: boolean}} [opts.env]
 * @returns {{
 *   ok: boolean, canInstall: boolean, blocking: number, confirm: number, notice: number,
 *   gates: object, kind: 'skill'|'plugin'|null, manifest: object|null, entry: string|null,
 *   issues: Array
 * }}
 */
export function runGates(ctx, draftId, opts = {}) {
  const base = draftDir(ctx, draftId);
  // 闸门档位：模型现写的（generated，最严）vs 别人打包的（third-party）。
  // 见 gateDanger 里的 THIRD_PARTY_CONFIRM 说明。
  const profile = opts.profile === 'third-party' ? 'third-party' : 'generated';
  const gopts = { ...opts, profile };
  const structure = gateStructure(base, gopts);
  const manifest = structure.manifest || null;
  const entry = structure.entry || null;

  const skip = (why) => ({ ok: false, issues: [{ level: 'block', code: 'skipped', title: why, why: '' }] });

  // 结构不过就没必要往下扫。连入口文件都没有，扫什么
  const syntax = structure.ok
    ? gateSyntax(base, gopts)
    : skip('结构未通过，跳过语法检查');
  const danger = structure.ok
    ? gateDanger(base, manifest, entry, gopts)
    : skip('结构未通过，跳过危险扫描');
  const contract = structure.ok
    ? gateContract(manifest, entry, base)
    : skip('结构未通过，跳过契约检查');
  const env = structure.ok
    ? gateEnv(base, manifest, entry, gopts.env)
    : skip('结构未通过，跳过环境适配检查');

  const all = [...structure.issues, ...syntax.issues, ...danger.issues, ...contract.issues, ...env.issues];
  const blocking = all.filter((i) => i.level === 'block').length;
  const confirm = all.filter((i) => i.level === 'confirm').length;

  return {
    ok: structure.ok && blocking === 0,
    canInstall: structure.ok && blocking === 0,
    blocking,
    confirm,
    // 内容摘要：人工确认与落盘之间的"这份东西没被改过"凭据。
    // 闸门结论与安装之间隔着人看界面 + 点按钮，草稿完全可能在这段时间被改
    // （模型继续修改、另一个请求覆盖写）。只按 draftId 发许可，等于许可的是
    // "这个名字"，不是"这份内容"。所以票要绑摘要，安装时再算一遍比对。
    digest: draftDigest(base),
    notice: all.filter((i) => i.level === 'notice').length,
    gates: { structure, syntax, danger, contract, env },
    kind: structure.kind,
    manifest,
    entry,
    issues: all
  };
}

// ── 闸门 4：语法 ──────────────────────────────────────────────────────────
//
// 结构检查（以及原来的危险/契约两道）全是正则级检查，抓不住**语法错误**：
// 而那是最坑小白的失败模式：模型写出一个 SyntaxError 的 index.js，全部闸过、
// 装上、开启，然后 register() 在加载时直接抛错，用户看到的是"装了、开了、没反应"。
//
// 做法：node --check（只解析不执行，~100ms/文件）。两个关键细节：
//   · Electron 主进程里 process.execPath 是 electron.exe，直接跑 --check
//     会启动 GUI。必须带 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式运行。
//   · 生成代码是 ESM（模板教的就是 export function register），所以 stdin
//     模式配 --input-type=module。module 语法是 CJS 的严格超集，CJS 风格
//     的草稿（require 调用）在这个模式下也能通过：require 只是普通标识符。
//
// 检查器起不来（极端环境）时降级为 notice：语法闸缺失不能把整条安装链堵死，
// 三道静态闸与人工确认仍然在。
/**
 * 语法检查结果缓存。
 * key = 「输入模式 + 代码内容」的 sha1；value = { verdict, detail, at }。
 * verdict：'ok' | 'error'（有语法错，detail 是 node --check 的正文）| 'unavailable'（检查器起不来）。
 * 只缓存与文件名无关的信息：issue 的标题（含文件名）在使用处重建。
 * 上限 512 条，满了淘汰最久未访问的一半。
 */
const SYNTAX_CACHE = new Map();
const SYNTAX_CACHE_MAX = 512;
function cacheSyntaxResult(key, verdict, detail) {
  if (SYNTAX_CACHE.size >= SYNTAX_CACHE_MAX) {
    const byAge = [...SYNTAX_CACHE.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
    for (let i = 0; i < Math.ceil(byAge.length / 2); i++) SYNTAX_CACHE.delete(byAge[i][0]);
  }
  SYNTAX_CACHE.set(key, { verdict, detail, at: Date.now() });
}

function gateSyntax(base, opts = {}) {
  // opts.nodePath：显式指定检查器（测试注入 / 特殊环境适配）。
  // 默认 process.execPath：Electron 主进程里是 electron.exe，
  // 由下面的 ELECTRON_RUN_AS_NODE=1 切成纯 Node 模式（Electron 官方开关）。
  const nodePath = String(opts.nodePath || process.execPath);
  const issues = [];
  const jsFiles = listAll(base).filter((f) => /\.(js|mjs|cjs)$/i.test(f));
  if (!jsFiles.length) return { ok: true, issues };

  // 两个防"主进程冻结"的加护：
  //   ① 结果按**代码内容哈希**记忆：spawnSync 是同步阻塞（~50-150ms/文件，
  //      检查器挂起时 8s/文件，200 个文件最坏能把主进程冻住几十分钟）。
  //      而 forge.list（被 UI、被 install 预检、被**每轮提示词组装** promptSections
  //      调用）会对同一份草稿反复跑全套闸门：内容没变就不该反复起进程。
  //   ② 整轮时间预算：超出即停止起新进程，剩余文件如实记为"未检查"（notice），
  //      宁可标注"没查完"也不把应用冻死。
  const startAt = Date.now();
  const SYNTAX_BUDGET_MS = 20000;
  for (const rel of jsFiles) {
    let code = '';
    try {
      code = fs.readFileSync(path.join(base, rel), 'utf8');
    } catch { continue; }
    if (!code.trim()) continue;
    if (code.charCodeAt(0) === 0xFEFF) code = code.slice(1);

    // .cjs 按 CommonJS 解析，其余按 ESM
    const inputType = /\.cjs$/i.test(rel) ? 'commonjs' : 'module';

    // ① 内容哈希命中 → 直接复用上次裁决（不 spawn 进程）
    const cacheKey = crypto.createHash('sha1').update(`${inputType}\n${code}`).digest('hex');
    const cached = SYNTAX_CACHE.get(cacheKey);
    if (cached) {
      cached.at = Date.now();
      if (cached.verdict === 'ok') continue;
      if (cached.verdict === 'unavailable') {
        issues.push({ level: 'notice', code: 'syntax-check-unavailable', title: `语法检查未完成：${rel}`, why: cached.detail });
        continue;
      }
      issues.push({ level: 'block', code: 'syntax-error', title: `语法错误（${rel}）`, why: cached.detail });
      continue;
    }

    // ② 时间预算用尽 → 不再起进程，如实标注"未检查"
    if (Date.now() - startAt > SYNTAX_BUDGET_MS) {
      issues.push({
        level: 'notice',
        code: 'syntax-check-budget',
        title: `语法检查未完成：${rel} 及后续文件`,
        why: `语法检查（node --check）超过 ${SYNTAX_BUDGET_MS / 1000} 秒预算已停止，剩下的文件没查 —— 请人工确认代码能运行。`
      });
      break;
    }
    let res;
    try {
      res = spawnSync(nodePath, ['--check', `--input-type=${inputType}`], {
        input: code,
        timeout: 8000,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      });
    } catch {
      issues.push({ level: 'notice', code: 'syntax-check-unavailable', title: '语法检查未运行（检查器不可用）', why: '本机无法启动语法检查器 —— 请人工确认代码能运行。' });
      continue;
    }
    // spawnSync 不抛异常，错误在 res.error / res.status=null。
    // 必须先分清"检查器没跑起来"（降级 notice，绝不能误报 block）
    // 与"检查器跑了、代码真有语法错"（block）。
    if (res.error || res.status === null) {
      const why = res.error?.code === 'ETIMEDOUT'
        ? '检查器没在时限内返回 —— 请人工确认代码能运行。'
        : `检查器启动失败（${res.error?.code || '未知原因'}）—— 请人工确认代码能运行。`;
      issues.push({ level: 'notice', code: res.error?.code === 'ETIMEDOUT' ? 'syntax-check-timeout' : 'syntax-check-unavailable', title: `语法检查未完成：${rel}`, why });
      cacheSyntaxResult(cacheKey, 'unavailable', why);
      continue;
    }
    if (res.status === 0) {
      cacheSyntaxResult(cacheKey, 'ok', '');
      continue;
    }

    // status !== 0：语法错误。错误输出第一段含行号列号，截给用户看关键行。
    const errText = String(res.stderr || res.stdout || '语法错误').trim();
    const firstLines = errText.split('\n').slice(0, 4).join('\n').slice(0, 600);
    const issue = {
      level: 'block',
      code: 'syntax-error',
      title: `语法错误（${rel}）`,
      why: `代码无法通过解析 —— 装上后扩展会加载失败。node --check 的报告：\n${firstLines}`
    };
    issues.push(issue);
    // 出错结果**也缓存**（同一份坏代码反复触发时不必反复起进程）；
    // 缓存的是与文件名无关的错误正文，标题按当前文件重建。
    cacheSyntaxResult(cacheKey, 'error', issue.why);
  }
  return { ok: !issues.some((i) => i.level === 'block'), issues };
}

// ── 闸门 1：结构 ──────────────────────────────────────────────────────────

function gateStructure(base, opts = {}) {
  const issues = [];
  const push = (level, code, title, why) => issues.push({ level, code, title, why });

  if (!fs.existsSync(base)) {
    push('block', 'no-draft', '草稿不存在', '还没有生成任何文件。请先写 skill.json 与 index.js。');
    return { ok: false, issues, kind: null, manifest: null, entry: null };
  }

  const files = listAll(base);

  if (!files.length) {
    push('block', 'empty', '草稿是空的', '还没有写任何文件。');
    return { ok: false, issues, kind: null, manifest: null, entry: null };
  }

  // 后缀白名单（写工具已经拦过，这里二次确认：不信任任何单一环节）
  for (const f of files) {
    if (!/\.(js|mjs|cjs|json|md|txt|css|html)$/i.test(f)) {
      push('block', 'bad-ext', `不允许的文件类型：${f}`, '只能放 js/mjs/cjs/json/md/txt/css/html。');
    }
  }

  // 清单：优先 skill.json，其次 plugin.json（与 plugin-loader.js readManifest 同序）
  let kind = null;
  let manifestRel = null;
  if (files.includes('skill.json')) { kind = 'skill'; manifestRel = 'skill.json'; }
  else if (files.includes('plugin.json')) { kind = 'plugin'; manifestRel = 'plugin.json'; }
  else {
    push('block', 'no-manifest', '缺少清单文件',
      '必须有一个 skill.json（技能）或 plugin.json（插件）。没有清单的目录会被装载器直接忽略。');
    return { ok: false, issues, kind: null, manifest: null, entry: null };
  }

  // 解析清单（含 BOM 处理：Windows 编辑器常写 BOM，JSON.parse 会直接抛）
  let manifest = null;
  try {
    let text = fs.readFileSync(path.join(base, manifestRel), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    manifest = JSON.parse(text);
  } catch (e) {
    push('block', 'manifest-parse', '清单 JSON 解析失败', `${manifestRel} 不是合法 JSON：${e.message}`);
    return { ok: false, issues, kind, manifest: null, entry: null };
  }

  if (!manifest || typeof manifest !== 'object') {
    push('block', 'manifest-shape', '清单不是对象', `${manifestRel} 顶层必须是 JSON 对象。`);
    return { ok: false, issues, kind, manifest: null, entry: null };
  }

  if (!manifest.id || !ID_RE.test(String(manifest.id))) {
    push('block', 'bad-id', `id 不合法：${manifest.id ?? '(缺失)'}`,
      'id 必须匹配 [a-zA-Z0-9][a-zA-Z0-9._-]{0,63}，它会成为目录名。');
  }
  if (!String(manifest.name || '').trim()) {
    push('block', 'no-name', '缺少 name', '清单必须有可读的中文名（会显示在扩展列表里）。');
  }
  const av = Number(manifest.apiVersion);
  if (av !== API_VERSION) {
    push('block', 'bad-api-version', `apiVersion 应为 ${API_VERSION}，实际 ${manifest.apiVersion ?? '(缺失)'}`,
      `当前核心的扩展 API 版本是 ${API_VERSION}。`);
  }

  // ── 清单字段结构校验 ───────────────────────────────────────────────────
  // 为什么要在这里拦：加载器对这些字段全部"宽进 + 静默降级"：
  // tools 写成字符串 → 声明-实现对账空转；prompt 写成字符串 → 静默丢弃；
  // permissions 写成字符串 → 零权限；category 拿错词表 → 回退 utility。
  // 运行时不报错、UI 无提示，模型与用户都毫无线索。闸门必须在装之前指出。
  // （运行时侧的宽容化：字符串 prompt 转 instruction、permissions 归一化：
  //   已在 src/skills/manifest.js 落地；这里拦的是"作者明显写错了"，教他改对。）

  // tools：字符串数组或 {id,...} 对象数组。它是"声明-实现对账"与人工确认的输入，
  // 结构错了对账就空转："静默错配"的温床之一。
  if (manifest.tools !== undefined && !Array.isArray(manifest.tools)) {
    push('block', 'bad-tools', 'tools 必须是数组',
      `当前是 ${Array.isArray(manifest.tools) ? '' : `${typeof manifest.tools} 类型`}。`
      + `正确写法：tools: ["工具id"] 或 tools: [{ "id": "工具id", "name": "显示名", "description": "一句话说明" }]。`);
  } else if (Array.isArray(manifest.tools)) {
    const badItem = manifest.tools.find((t) =>
      !(typeof t === 'string' && t.trim()) && !(t && typeof t === 'object' && String(t.id || '').trim()));
    if (badItem !== undefined) {
      push('block', 'bad-tools-item', 'tools 数组里有缺 id 的元素',
        '每个元素要么是字符串（工具 id），要么是带 id 字段的对象。缺 id 的元素对账时会被静默跳过。');
    }
  }

  // prompt：加载器只认 { instruction } 或 { sections: [...] }。
  // 字符串写法在运行时已被宽容成 instruction（manifest.js），但金标准示例与
  // 生成约定都是对象：写字符串多半是作者没看懂格式，当场纠正比静默收下好。
  if (manifest.prompt !== undefined) {
    if (typeof manifest.prompt !== 'object' || manifest.prompt === null || Array.isArray(manifest.prompt)) {
      push('block', 'bad-prompt', 'prompt 必须是对象（不能是字符串/数组）',
        '正确写法：prompt: { "instruction": "什么时候调用、怎么用（一两句话）" }，'
        + '或分段式 prompt: { "sections": [{ "id": "main", "title": "标题", "content": "内容", "priority": 50 }] }。');
    } else if (!String(manifest.prompt.instruction || '').trim() && !Array.isArray(manifest.prompt.sections)) {
      push('block', 'bad-prompt', 'prompt 缺少 instruction 或 sections',
        'prompt 对象至少要有 instruction（字符串）或 sections（数组）之一，否则加载后不会产生任何提示词。');
    }
  }

  // permissions：必须是字符串数组（当前白名单只有 web_fetch）。
  // 写成字符串会静默变零权限；写不认识的值也不会生效（见第 4 道闸）。
  if (manifest.permissions !== undefined && !Array.isArray(manifest.permissions)) {
    push('block', 'bad-permissions', 'permissions 必须是字符串数组',
      `当前是 ${typeof manifest.permissions} 类型。正确写法：permissions: ["web_fetch"]。`
      + `写作字符串会被当成没有声明任何权限，api.fetch 会直接拒绝。`);
  }

  // category：清单级白名单（与 src/skills/manifest.js 的 VALID_CATEGORIES 同口径）。
  // 与工具的 category 是**两套词表**：清单级 = model/message/knowledge/media/utility/fun/query；
  //    工具级（tools[] 里）= messaging/sticker/query/memory/web/system/media/knowledge/utility/...
  //    金标准示例两级并存，模型最容易把 "system"（工具级）抄到清单级：装上后被
  //    静默回退成 utility，在这里拦住并讲清区别。
  const VALID_CATEGORIES = new Set(['model', 'message', 'knowledge', 'media', 'utility', 'fun', 'query']);
  if (manifest.category !== undefined && !VALID_CATEGORIES.has(manifest.category)) {
    push('block', 'bad-category', `清单级 category 非法：${manifest.category}`,
      `清单级 category 只能是 model / message / knowledge / media / utility / fun / query 之一。`
      + `注意别和 tools[] 里**工具级** category 混用（那套词表是 messaging/sticker/query/memory/web/system 等）。`
      + `不确定就用 "utility"。`);
  }

  // 入口文件：entry 字段，默认 index.js
  const entryRel = String(manifest.entry || 'index.js');
  // 入口必须锁死在草稿目录内（与 plugin-loader.js 同一判据）
  const entryAbs = path.resolve(base, entryRel);
  const relToBase = path.relative(base, entryAbs);
  if (!relToBase || relToBase.startsWith('..') || path.isAbsolute(relToBase)) {
    push('block', 'entry-escape', `entry 越界：${entryRel}`, 'entry 必须是草稿目录内的相对路径。');
  } else if (!files.includes(relToBase.replace(/\\/g, '/'))) {
    push('block', 'no-entry', `入口文件不存在：${entryRel}`,
      `清单声明 entry=${entryRel}，但草稿里没有这个文件。`);
  }

  // 限额（写工具已按文件拦过，这里按整体再确认一次）
  //
  // maxFiles 是"防跑飞启发式"，**不是安全边界**：真正的防跑飞在**写盘时**
  //    （forge-tools 的 write-new：生成草稿时第 21 个文件就被拒）。闸门这道只该拦
  //    "离谱的大包"，不该拦正常的第三方包。`emotion-core`（27 个文件）曾在
  //    「改别人的包」里被这里拦死，而且因为结构闸先失败，后面语法/危险/契约/环境
  //    四道检查全被跳过：用户看到的是"配置一样，全是阻断"，三个扩展一个都装不了。
  const maxFiles = Number(opts.maxFiles) || GATE_MAX_FILES;
  if (files.length > maxFiles) push('block', 'too-many-files', `文件过多（${files.length}）`, `一个扩展不该有这么多文件（上限 ${maxFiles}）。`);

  return { ok: issues.every((i) => i.level !== 'block'), issues, kind, manifest, entry: entryRel };
}

// ── 闸门 2：危险模式 ──────────────────────────────────────────────────────
//
// ⚠️ 两档尺度：同一把尺子量不了两种东西。
//   · generated（模型现写的代码）：fs / child_process / net 一票否决：自动生成的扩展
//     没有正当理由读文件、起进程。
//   · third-party（别人打的包 / 市场下载的）：这三类降为 **confirm**（勾选可放行）。
//     原因很实际：本机自带的 media-download 要 fs 落盘、video-frames 要调 ffmpeg、
//     sticker 要读素材：真实插件几乎都需要。一律 block 的结果不是"更安全"，
//     而是市场包 100% 装不上，用户只会把整条链路关掉。
//   不可降的两条：credential-read（读 config.json / apiKey）、process-exit（杀进程）：
//   它们没有任何第三方扩展的正当用途。
const THIRD_PARTY_CONFIRM = new Set(['child-process', 'dangerous-import']);
const THIRD_PARTY_NOTE = '\n第三方扩展包通常需要这些能力（本机自带插件大多如此），因此这里降为「需确认」：你勾选后仍可安装。';

function gateDanger(base, manifest, entryRel, opts) {
  const issues = [];
  const allowNetwork = opts.allowNetwork === true;
  const thirdParty = opts.profile === 'third-party';

  // 只扫代码文件（.md/.txt 里的示例代码不该触发拦截）
  const srcs = [];
  for (const f of listAll(base)) {
    if (!/\.(js|mjs|cjs)$/i.test(f)) continue;
    try { srcs.push({ path: f, text: fs.readFileSync(path.join(base, f), 'utf8') }); } catch { /* ignore */ }
  }
  if (!srcs.length) {
    return { ok: false, issues: [{ level: 'block', code: 'no-code', title: '没有任何 JS 文件', why: '扩展至少需要一个可执行的入口 .js。' }] };
  }

  for (const rule of DANGER_RULES) {
    // 网络规则在"允许联网"时降级为 notice
    let level = (rule.id === 'network' && allowNetwork) ? 'notice' : rule.level;
    let why = rule.why;
    if (thirdParty && level === 'block' && THIRD_PARTY_CONFIRM.has(rule.id)) {
      level = 'confirm';
      why = `${rule.why}${THIRD_PARTY_NOTE}`;
    }

    // 全文级规则：check(fullText)：单看一行判断不了的模式（见 timer-leak 注释）
    if (rule.check) {
      for (const s of srcs) {
        if (!rule.check(s.text)) continue;
        issues.push({
          level,
          code: rule.id,
          title: `${rule.title}（${s.path}）`,
          why,
          file: s.path,
          line: null,
          snippet: ''
        });
      }
      continue;
    }

    // 逐行扫：报出具体行号，模型才知道改哪里
    for (const s of srcs) {
      const lines = s.text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const code = line.replace(/\/\/.*$/, '');      // 去掉行尾注释，减少误报
        if (!rule.re.test(code)) continue;
        // 跳过明显的注释整行
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
        issues.push({
          level,
          code: rule.id,
          title: `${rule.title}（${s.path}:${i + 1}）`,
          why,
          file: s.path,
          line: i + 1,
          snippet: line.trim().slice(0, 160)
        });
        break;   // 同一规则同一文件只报第一处，避免刷屏
      }
    }
  }
  return { ok: issues.every((i) => i.level !== 'block'), issues };
}

// ── 闸门 3：声明-实现一致 ────────────────────────────────────────────────

function gateContract(manifest, entryRel, base) {
  const issues = [];
  const declared = Array.isArray(manifest.tools)
    ? manifest.tools.map((t) => (typeof t === 'string' ? t : t?.id)).filter(Boolean).map(String)
    : [];

  let entrySrc = '';
  try { entrySrc = fs.readFileSync(path.join(base, entryRel), 'utf8'); } catch { /* 上面已拦 */ }

  // 静态找 registerTool({ id: 'xxx' })
  // 这是启发式：抓 `<...id: 'xxx'...>` 且附近有 registerTool。
  //    抓不到 ≠ 没实现（可能是变量拼接）。所以"抓不到就报 confirm 让人看一眼"，
  //    绝不静默放行。这正是 self-doctor 那条"声明了工具但入口未注册"的规则精神。
  //
  // 块提取：**等长脱敏**后按括号配对取整个 registerTool(...) 调用：
  // 字符串内容换成 X 占位、注释换成空格，长度不变、索引与原 src 一一对应：
  //   · 括号配对在脱敏文本上做（不受字符串里的怪括号干扰）；
  //   · 返回的块从**原 src** 按同一区间切：id 提取要的是真实字符串内容。
  //
  // 必须等长脱敏：把字符串剥成 ''/""/`` 后**从剥过的文本里提 id** 的话，
  //    `id: 'foo'` 早已变成 `id: ''`：registered 集合恒为空，
  //    possibly-missing / registered-not-declared 两道对账从此全部空转，
  //    "清单声明 A、代码注册 B"静默穿过。
  const extractRegisterBlocks = (src) => {
    const scrubbed = src
      .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length))
      .replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length))
      .replace(/'(?:\\.|[^'\\\n])*'/g, (m) => `'${'X'.repeat(Math.max(0, m.length - 2))}'`)
      .replace(/"(?:\\.|[^"\\\n])*"/g, (m) => `"${'X'.repeat(Math.max(0, m.length - 2))}"`)
      .replace(/`(?:\\.|[^`\\])*`/g, (m) => `\`${'X'.repeat(Math.max(0, m.length - 2))}\``);
    const blocks = [];
    const re = /registerTool\s*\(/g;
    let m;
    while ((m = re.exec(scrubbed))) {
      let i = m.index + m[0].length - 1, depth = 0, end = -1;
      for (; i < scrubbed.length; i++) {
        if (scrubbed[i] === '(') depth++;
        else if (scrubbed[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
      }
      if (end > 0) blocks.push(src.slice(m.index, end + 1));
    }
    return blocks;
  };

  const registered = new Set();
  const blocks = extractRegisterBlocks(entrySrc);
  for (const b of blocks) {
    const idm = b.match(/id\s*:\s*['"`]([^'"`]+)['"`]/);
    if (idm) registered.add(idm[1]);
  }
  // 提取失败（字符串里怪括号等）时保守退回旧行为：只要源码提到 registerTool
  // 就不算"完全没注册"，让下游的 confirm 分支接手，不冤枉人。
  const sawRegisterCall = blocks.length > 0 || /registerTool\s*\(/.test(entrySrc);

  // 注册块缺 execute：回调键名写错（如 handler: / run:）会让工具在加载器注册失败，
  // **整个扩展**加载失败，UI 只能看到 v0.0.0 占位：实战事故（bmi-helper 适配）：
  // 模型写了 handler:，五道闸全放行，装上去才炸。闸门必须拦在装之前。
  const noExecute = blocks.filter((b) => !/\bexecute\b/.test(b) && /['"`]?[a-zA-Z_$][\w$]*['"`]?\s*:/.test(b));
  for (const b of noExecute) {
    const idm = b.match(/id\s*:\s*['"`]([^'"`]+)['"`]/);
    issues.push({
      level: 'block', code: 'register-missing-execute',
      title: `工具注册缺少 execute 函数${idm ? `：${idm[1]}` : ''}`,
      why: 'registerTool 的回调键名必须是 execute(ctx, args) —— 写成 handler / run / callback 等'
        + '任何别的名字，工具都会在加载器注册失败，整个扩展加载失败。请把回调键名改成 execute。'
    });
  }

  if (declared.length && !sawRegisterCall) {
    issues.push({
      level: 'block', code: 'declared-not-registered',
      title: `清单声明了 ${declared.length} 个工具，但入口没有 registerTool 调用`,
      why: `清单 tools[] 只是元数据，真正让模型看见工具的是 api.registerTool()。`
        + `请在入口里为 ${declared.join('、')} 各写一次 api.registerTool({ id: ... }) —— `
        + `注意 id 会被自动加上 "${manifest.id}__" 前缀。`
    });
  } else if (declared.length && sawRegisterCall && registered.size) {
    // registered 非空 = 从源码里真的提取到了字面量 id，可以对账了。
    const missing = declared.filter((d) => !registered.has(d));
    const undeclared = [...registered].filter((r) => !declared.includes(r));

    if (missing.length === declared.length) {
      // 声明与注册**完全错位**（零交集）。这不是"可能漏了"，是 id 写岔了：
      // 装上后清单与实现永久脱节，人工确认看清单、运行时跑的是另一套 id。
      // 两边都是字面量、可信度高，直接 block。
      issues.push({
        level: 'block', code: 'id-mismatch',
        title: `清单声明的工具与实际注册的完全对不上`,
        why: `清单 tools[] 声明：${declared.join('、')}；入口 registerTool 注册：${[...registered].join('、')}。`
          + `两边的 id 必须一字不差（registerTool 里的 id 不带前缀，加载器会自动加 "${manifest.id}__"）。`
          + `请把 tools[] 与 registerTool 的 id 改成同一组。`
      });
    } else if (missing.length) {
      issues.push({
        level: 'confirm', code: 'possibly-missing-tools',
        title: `清单声明了但没能静态确认注册：${missing.join('、')}`,
        why: '可能是动态拼接的 id（无妨），也可能是真的漏了。请人工看一眼入口代码。'
      });
    }

    // 反向：注册了但清单没声明。不影响功能，但清单与实现对不上会误导后续维护
    if (undeclared.length) {
      issues.push({
        level: 'notice', code: 'registered-not-declared',
        title: `入口注册了但清单未声明：${undeclared.join('、')}`,
        why: '功能不受影响，但建议把 tools[] 补齐 —— 清单是给用户看的目录。'
      });
    }
  }

  // prompt 段：技能靠它让模型知道"什么时候该用我"
  if (!manifest.prompt && !declared.length) {
    issues.push({
      level: 'notice', code: 'no-prompt-no-tools',
      title: '既没有 prompt 也没有工具',
      why: '这样的扩展装上去不会产生任何行为 —— 请至少提供 tools[] 或 prompt。'
    });
  }

  return { ok: issues.every((i) => i.level !== 'block'), issues, declared, registered: [...registered] };
}

// ── 闸门 4：本地环境适配 ─────────────────────────────────────────────────
//
// 与前三道的分工：那三道判"安全 / 能不能装上"，这一道判"装上后能不能工作"。
// 对**第三方**扩展尤其重要，它们往往对着另一套环境写的：
//   · requires 声明了一个本机没人提供的能力 → 核心判定它不可用，永远不激活
//   · 调用了本地 createSkillApi 没有的 api.xxx → 运行时 TypeError
//   · id 与已装扩展撞车 → 会被自动加 _1 后缀，但扩展自身若硬编码自己的 id 就会行为异常
//
// 这一道只在调用方给了 env 时才跑。gate.js 是纯模块，不知道本机装了什么：
//    硬要它猜只会产生假结论，不如明确地"不检查"。

/** createSkillApi 实际提供的成员（src/plugin-loader.js）。
 *  改动核心 API 时这里要同步：漏了只表现为"少报一个不适配"，不会误伤。
 *  三处必须同步：本表 / extension-forge index.js 的 envBrief.knownApis /
 *     plugin-loader.js 的 createSkillApi 本体。教训：闸门文案推荐 api.storage()，
 *     但 createSkillApi 与本表都没有它：模型按文案改用 storage 反而撞上
 *     unknown-api，两头死路。现在 storage 已真实实现，表里必须保留。 */
const KNOWN_APIS = new Set([
  'registerTool', 'config', 'isSkillActive', 'capability', 'hasCapability',
  'storage', 'log', 'warn', 'error', 'fetch', 'utils'
]);

function gateEnv(base, manifest, entryRel, env) {
  const issues = [];
  if (!env?.envReady) return { ok: true, issues, skipped: true };

  // ① 硬依赖要有提供者，否则该扩展永远不会被激活（装了等于没装）
  const requires = Array.isArray(manifest.requires) ? manifest.requires.map(String) : [];
  if (requires.length && typeof env.hasCapability === 'function') {
    for (const need of requires) {
      if (env.hasCapability(need)) continue;
      issues.push({
        level: 'confirm',
        code: 'missing-requires',
        title: `硬依赖的能力本机没有提供者：${need}`,
        why: `清单 requires 声明了 ${need}，但本机没有任何扩展提供它 —— `
          + `核心会把本扩展判为"依赖未就绪"，永远不会激活它（装了也用不上）。`
          + `如果只是想要"有就增强、没有也能跑"，应该改用软依赖 api.capability()；`
          + `如果确实需要它，就要先把提供者装上。`
      });
    }
  }

  // ② id 撞车：会被自动改成 xxx_1，但扩展自身写死 id 的地方会错位
  if (env.existingIds && env.existingIds.has(String(manifest.id || ''))) {
    issues.push({
      level: 'notice',
      code: 'id-conflict',
      title: `已有一个同名扩展：${manifest.id}`,
      why: '安装时会自动加 _1 后缀落到新目录（不覆盖已有的），所以功能上没问题。'
        + '但如果这个扩展在代码里写死了自己的 id（比如去读自己的配置目录），加后缀后会读错地方。'
    });
  }

  // ③ 调用了本地没有的 api 成员：运行时才会炸，是最典型的"水土不服"
  //
  // 认定"哪个标识符是 skill API 对象"不能只看名字：
  //    写死匹配 `api.xxx` 时，仓库里只有少数扩展用 `register(api)`，其余用
  //    `setup(x)` 之类，这条检查对它们**完全失效**（假阴性）。
  //    改成按行为认定：**谁身上调过 registerTool，谁就是 api 对象**
  //    （那是 createSkillApi 独有的方法，别的对象不会有）。
  //    这个判据不依赖命名习惯，也不会因为作者把形参叫 ctx/a/theApi 就漏掉。
  let entrySrc = '';
  try { entrySrc = fs.readFileSync(path.join(base, entryRel), 'utf8'); } catch { /* 上面已拦 */ }

  const apiVars = new Set();
  for (const mm of entrySrc.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*registerTool\s*\(/g)) apiVars.add(mm[1]);
  // 兜底：一个 registerTool 都没调的入口，按约定名 api 认（聊胜于无）
  if (!apiVars.size) apiVars.add('api');

  const unknown = new Set();
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(?:${[...apiVars].map(esc).join('|')})\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
  let m;
  while ((m = re.exec(entrySrc))) {
    const name = m[1];
    if (!KNOWN_APIS.has(name)) unknown.add(name);
  }
  if (unknown.size) {
    issues.push({
      level: 'confirm',
      code: 'unknown-api',
      title: `用到了本机没有的 api 成员：${[...unknown].join('、')}`,
      why: `入口代码里出现了 ${[...apiVars][0]}.${[...unknown][0]}()，但本地 skill API 只提供：`
        + `${[...KNOWN_APIS].join(' / ')}。这多半是照着别的（或更新版本的）核心写的 —— `
        + `运行到那一行会直接抛 TypeError。需要把这些调用改成等价的本地写法，或删掉依赖它的功能。`
    });
  }

  // ④ permissions 里有本地不认的值：声明了也不会生效，容易让人误以为"已授权"
  const perms = Array.isArray(manifest.permissions) ? manifest.permissions.map(String) : [];
  const knownPerms = new Set(['web_fetch']);
  const badPerms = perms.filter((p) => !knownPerms.has(p));
  if (badPerms.length) {
    issues.push({
      level: 'notice',
      code: 'unknown-permission',
      title: `清单声明了本地不认的权限：${badPerms.join('、')}`,
      why: `本地权限白名单只有：${[...knownPerms].join(' / ')}。`
        + `${badPerms[0]} 不会被授予 —— 依赖它的代码会拿到拒绝（fetch 会直接 reject）。`
    });
  }

  return { ok: issues.every((i) => i.level !== 'block'), issues };
}

/** 列出草稿内所有文件（相对路径，正斜杠）。 */
function listAll(base) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      out.push(path.relative(base, fp).replace(/\\/g, '/'));
    }
  };
  walk(base, 0);
  return out.sort();
}

/**
 * 草稿内容摘要（sha256，按路径排序后把「路径 + 长度 + 字节」依次喂进去）。
 *
 * 为什么需要它：**闸门通过 ≠ 安装许可**。两者之间隔着"人看界面、点确认"的
 * 时间窗，而草稿在这段时间里可能被模型改（修改轮）、被另一个请求覆盖写。
 * 只凭 draftId 发许可，许可的是"这个名字"，不是"这份字节"。
 * 所以确认动作要签发一张**绑摘要**的一次性票，落盘前重算比对：内容变了票自动失效。
 *
 * 路径也进摘要：只哈希内容的话，把 a.js 改名成 b.js 能绕过
 * （而文件名恰恰参与入口判定 / 契约校验）。
 */
export function draftDigest(base) {
  try {
    const h = crypto.createHash('sha256');
    for (const rel of listAll(base)) {
      let buf;
      try { buf = fs.readFileSync(path.join(base, ...rel.split('/'))); } catch { continue; }
      h.update(rel, 'utf8');
      h.update('\0');
      h.update(String(buf.length), 'utf8');
      h.update('\0');
      h.update(buf);
      h.update('\0');
    }
    return h.digest('hex');
  } catch {
    return '';   // 算不出来时返回空串：调用方据此拒绝签发 / 校验票据，不会误放行
  }
}

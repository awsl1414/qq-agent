#!/usr/bin/env node
/**
 * 构建前静态校验：在 electron-builder 真正开始打包前，把「配置错了但能构建成功、
 * 装出来才发现坏了」的情况拦下来。
 *
 * electron-builder 对 `files` 的错误是宽容的：少写一个白名单目录只会让功能
 * 静默消失（市场装不了扩展、图标空白），多写一个排除项则可能把 1.5GB 的便携 QQ
 * 带进包。两种都不会让构建失败，只会在用户机器上暴露。
 *
 * 用法：node scripts/prepack-check.mjs
 * 退出码：0 = 全部通过；1 = 有失败项（会逐条打印原因）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as parseYaml } from 'js-yaml';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const BUILDER_CONFIG = path.join(REPO_ROOT, 'electron-builder.yml');

/** 打包态必需存在的文件，缺一个对应功能就整体失效 */
const REQUIRED_FILES = [
  ['electron/main.js', 'Electron 主进程入口'],
  ['src/server.js', 'headless 入口'],
  ['ui/index.html', '控制台界面'],
  ['builtin-modules.json', '内置模块指纹基线（缺失会让全部内置扩展被拒载）'],
  ['prices.json', '内置价格表']
];

/**
 * 各平台各自的图标资源。
 *
 * 分开列而不是并进 REQUIRED_FILES：图标是平台专属的，Windows 构建不该因为
 * macOS 的 icns 没生成而失败（反之亦然）。但「本平台该有的那份缺了」必须失败 ——
 * 缺图标时 electron-builder 不报错，只会静默改用 Electron 的默认图标，
 * 装出来的应用长得像别的软件。
 *
 * 平台由构建命令决定，不按当前操作系统猜：在 macOS 上跑 build:dir 出的是 Windows 包，
 * 缺的应该是 ico 而不是 icns。
 */
const PLATFORM_ICONS = {
  win: [['assets/icon.ico', 'Windows 应用图标（含 16~256 全套尺寸）']],
  mac: [['assets/icon.icns', 'macOS 应用图标（由 assets/icon.png 放大生成，见 assets/README-icons.md）']],
  linux: [['assets/icons', 'Linux 多尺寸图标目录（electron-builder 需要 512px 以上，单张 png 不够）']]
};

/**
 * 允许「既不打包也不排除」的顶层目录，以及为什么可以不处理。
 *
 * 自动推导的逻辑：扫仓库根的每个顶层条目，凡是既不在 files 白名单里、
 * 也没被 files 的 `!` 规则排除的，都必须在这里登记原因，否则构建失败。
 * 这样新增目录时不用记得同时改两份清单 —— 漏了会被拦下并告诉你该做什么。
 *
 * 只登记「确实不需要进包、也不必写排除规则」的：
 *   - 白名单是正向列举，没被列出的目录本来就不会进包；
 *   - 排除规则是防御，防的是将来有人把白名单放宽成 `**\/*`。
 * 体积大或含隐私的目录不走这里，它们必须真的写进 files 的排除项。
 */
const IGNORED_TOP_LEVEL = new Map([
  ['.git', '版本库，electron-builder 不会打包'],
  ['.github', 'CI 配置，不进包'],
  ['.claude', '开发规则与设置，不进包'],
  ['.vscode', '编辑器配置，不进包'],
  ['.idea', '编辑器配置，不进包'],
  ['.workbuddy', '上游开发工具目录，本机不存在时也无妨'],
  ['node_modules', '依赖由收集器按 dependencies 自动收集，白名单不列它'],
  ['tests', '测试脚本，不进包'],
  ['scripts', '构建脚本，不进包'],
  ['dev-sandbox', '开发沙箱，已被 files 排除'],
  ['logs', '运行日志，已被 files 排除'],
  ['dist', '构建产物，已被 files 排除'],
  ['runtime', '旧版随包运行时（含便携 QQ），已被 files 排除'],
  ['graphify-out', '知识图谱缓存，已被 files 排除'],
  ['data', '用户数据，已被 files 排除'],
  ['data-2', '多实例用户数据，已被 files 排除']
]);

/**
 * 仓库根的散落文件：白名单不列、也不必写排除规则的那些。
 *
 * 与目录分开：文件没有「将来白名单放宽会误打包」的风险（`**\/*` 才需要
 * 逐个排除），所以这里只做「确认它是有意不打包的」这一件事。
 * 按名字登记而非扩展名：`VERSION` 要进包、`CLAUDE.md` 不进，两者都是
 * 根目录的普通文件，靠扩展名区分不了。
 */
const IGNORED_ROOT_FILES = new Map([
  ['.gitattributes', 'Git 换行规则，不进包'],
  ['.gitignore', 'Git 忽略规则，不进包'],
  ['.gituntracked', 'worktree 同步配置，不进包'],
  ['.npmrc', 'pnpm 配置，不进包'],
  ['.style-audit-report.md', '一次性审计报告，不进包'],
  ['AGENTS.md', '开发规则，不进包'],
  ['CLAUDE.md', '开发规则，不进包'],
  ['electron-builder.yml', '构建配置，不进包'],
  ['pnpm-lock.yaml', '依赖锁文件，不进包'],
  ['pnpm-workspace.yaml', '工作区配置，不进包']
]);

/**
 * 体积或隐私上「绝不能进包」的顶层目录。
 *
 * 与 IGNORED_TOP_LEVEL 分开：这些即使被列进白名单也必须同时出现在
 * files 的 `!` 规则里，作为白名单被放宽时的最后一道防线。
 */
const MUST_EXCLUDE_IF_PRESENT = [
  ['data', '用户数据（含 API Key、群聊记录）'],
  ['data-2', '多实例用户数据'],
  ['runtime/qq-portable', '便携 QQ（约 1.5GB）'],
  ['graphify-out', '知识图谱缓存（可重建）']
];

/** 其它包管理器留下的锁文件会误导贡献者，见 .npmrc */
const FORBIDDEN_LOCKFILES = ['package-lock.json', 'yarn.lock'];

/** Linux 桌面图标的最高档：低于这个尺寸时桌面环境会把小图拉大，显示发糊 */
const LINUX_ICON_MIN_SIZE = 512;

/**
 * 从命令行参数认出目标平台。
 *
 * 显式参数优先（build:mac 在 macOS 上也可能构建 Windows 包），
 * 都没有时按当前平台推断 —— 与 electron-builder 自己的默认行为一致。
 */
function detectPlatform(argv) {
  if (argv.includes('--win') || argv.includes('-w')) return 'win';
  if (argv.includes('--mac') || argv.includes('-m')) return 'mac';
  if (argv.includes('--linux') || argv.includes('-l')) return 'linux';
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'linux') return 'linux';
  return 'win';
}

const failures = [];
const passes = [];

function fail(message) {
  failures.push(message);
}
function pass(message) {
  passes.push(message);
}

function exists(rel) {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

/**
 * 把 electron-builder 的 glob 转成正则，只支持本项目用到的语法。
 *
 * 这里要判断的是「某目录是否被排除」，需要真的做匹配而不是字符串包含：
 * `data-*` 形式的规则必须能覆盖 `data-2`，而 `runtime` 规则必须能覆盖
 * `runtime/qq-portable`。字符串前缀比较在这两种情况下都会给出错误答案。
 */
function globToRegExp(pattern) {
  let source = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**` 跨目录：吃掉任意层（含零层）
        source += '.*';
        i += 1;
        // `**/` 也要能匹配「零层目录」，即把后面的斜杠一起吞掉
        if (pattern[i + 1] === '/') i += 1;
      } else {
        // `*` 不跨目录分隔符
        source += '[^/]*';
      }
    } else if (ch === '?') {
      source += '[^/]';
    } else {
      source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

/** 判断目录 dir 下的内容是否会被 excludePatterns 全部挡掉 */
function isDirExcluded(dir, excludePatterns) {
  const probe = `${dir.split(path.sep).join('/')}/__prepack_probe__`;
  return excludePatterns.some((pattern) => globToRegExp(pattern).test(probe));
}

function checkBuilderConfig() {
  if (!fs.existsSync(BUILDER_CONFIG)) {
    fail('electron-builder.yml 不存在：构建无从谈起');
    return null;
  }

  let config;
  try {
    config = parseYaml(fs.readFileSync(BUILDER_CONFIG, 'utf8')) ?? {};
  } catch (error) {
    fail(`electron-builder.yml 解析失败：${error?.message ?? error}`);
    return null;
  }
  pass('electron-builder.yml 存在且可解析');

  // asar=true 会让运行时对 plugins/ 与 skills/ 的写入全部失败（见配置文件头注释）
  if (config.asar === true) {
    fail(
      'asar 被设为 true。运行时会写代码根：市场装扩展写 plugins/ 与 skills/，' +
        'builtin-modules.json 也会被 refreshBuiltinEntry 重写；asar 打包后这些路径不可写。' +
        '实测（asar + asarUnpack 解包上述目录）还会让 fs.watch 报 ENOENT 导致热重载失效、' +
        '桌宠默认角色模型导入失败，而体积只从 332MB 降到 331MB。请改回 asar: false。'
      );
  } else {
    pass(`asar = ${config.asar === undefined ? '未设置（默认 false）' : config.asar}，符合硬约束`);
  }

  const files = Array.isArray(config.files) ? config.files.map(String) : [];
  if (files.length === 0) {
    fail('electron-builder.yml 的 files 为空：默认会整目录打包，用户数据会被带进包');
    return config;
  }
  const excludePatterns = files
    .filter((entry) => entry.startsWith('!'))
    .map((entry) => entry.slice(1).replace(/^\.\//, ''));

  for (const [dir, why] of MUST_EXCLUDE_IF_PRESENT) {
    if (!exists(dir)) {
      pass(`${dir}/ 不存在，无需排除`);
      continue;
    }
    if (isDirExcluded(dir, excludePatterns)) {
      pass(`${dir}/ 存在，且已被 files 排除`);
    } else {
      fail(`${dir}/ 存在，但不在 electron-builder.yml 的 files 排除项里（${why}）`);
    }
  }

  checkTopLevelCoverage(files, excludePatterns);

  return config;
}

/**
 * 扫仓库根的每个顶层条目，确认它「要么会被打包、要么被排除、要么已登记不需要」。
 *
 * 这个检查替代了「记得同时改两份清单」的人工约定：新增目录时若两边都没提，
 * 构建会失败并直接告诉你三种处理方式。
 *
 * 判断口径与 electron-builder 一致：白名单是正向列举，没列出的不会进包；
 * 这里要抓的是「没被任何规则覆盖、也没登记」的情况 —— 那种目录要么被误
 * 打包（如果将来白名单放宽），要么让人不确定它到底进不进包。
 */
function checkTopLevelCoverage(files, excludePatterns) {
  const entries = fs.readdirSync(REPO_ROOT, { withFileTypes: true });
  const uncovered = [];
  for (const entry of entries) {
    const name = entry.name;
    // 白名单里出现过这个名字（含 glob 前缀）就算覆盖
    const inWhitelist = files.some((pattern) => {
      if (pattern.startsWith('!')) return false;
      const first = pattern.split('/')[0];
      return first === name || first === '**' || globToRegExp(first).test(name);
    });
    if (inWhitelist) continue;
    if (isDirExcluded(name, excludePatterns)) continue;
    const registry = entry.isDirectory() ? IGNORED_TOP_LEVEL : IGNORED_ROOT_FILES;
    if (registry.has(name)) continue;
    uncovered.push({ name, isDir: entry.isDirectory() });
  }
  if (!uncovered.length) {
    pass(`仓库根 ${entries.length} 个顶层条目均已覆盖（打包 / 排除 / 已登记）`);
    return;
  }
  for (const { name, isDir } of uncovered) {
    const registry = isDir ? 'IGNORED_TOP_LEVEL' : 'IGNORED_ROOT_FILES';
    const action = isDir
      ? '① 要打包 → 加进 electron-builder.yml 的 files 白名单；② 不要打包但体积大或含隐私 → 加进 files 的 `!` 排除项；'
      : '① 要打包 → 加进 files 白名单；';
    fail(
      `仓库根的 ${name} 既不在 files 白名单、也没被排除规则覆盖、也没登记在 ${registry}。` +
        ` 处理方式：${action}③ 确实不需要进包 → 在 scripts/prepack-check.mjs 的 ${registry} 里登记原因。`
    );
  }
}

function checkRequiredFiles() {
  for (const [rel, why] of REQUIRED_FILES) {
    if (exists(rel)) pass(`${rel} 存在（${why}）`);
    else fail(`缺少 ${rel}（${why}）`);
  }
}

/**
 * 只校验本次要构建的平台的图标。
 *
 * 目标平台从脚本参数里读（`--win` / `--mac` / `--linux`），与 package.json 的
 * build:xxx 脚本一致；没传时按当前平台推断，因为 electron-builder 默认也是这么做的。
 */
function checkPlatformIcons(platform) {
  const icons = PLATFORM_ICONS[platform];
  if (!icons) {
    fail(`无法识别目标平台 "${platform}"，图标校验跳过`);
    return;
  }
  for (const [rel, why] of icons) {
    if (exists(rel)) pass(`${rel} 存在（${why}）`);
    else fail(`缺少 ${rel}（${why}）`);
  }

  // Linux 用目录形式时，electron-builder 要求目录里有 ≥512px 的 PNG：
  // 只有小图时它不会报错，而是把 16px 的图标塞进 hicolor 的 512 目录，桌面环境显示成糊图。
  if (platform === 'linux' && exists('assets/icons')) {
    const sizes = fs.readdirSync(path.join(REPO_ROOT, 'assets', 'icons'))
      .map((name) => /^(\d+)x\d+\.png$/i.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]));
    const max = sizes.length > 0 ? Math.max(...sizes) : 0;
    if (max >= LINUX_ICON_MIN_SIZE) pass(`assets/icons 最大尺寸 ${max}px（≥${LINUX_ICON_MIN_SIZE}px）`);
    else fail(`assets/icons 最大尺寸只有 ${max}px，electron-builder 要求至少 ${LINUX_ICON_MIN_SIZE}px`);
  }
}

function checkLockfiles() {
  for (const name of FORBIDDEN_LOCKFILES) {
    if (exists(name)) fail(`发现 ${name}：本项目只用 pnpm，请删除该文件`);
    else pass(`无 ${name}`);
  }
}

/**
 * 清掉 dist 里上一次构建留下的产物。
 *
 * 每次构建产出约 287MB（安装包 + 免安装包），不清理时几个版本就会堆到
 * 1.5GB。只删本目录下的 *.exe / *.zip / *.blockmap 与 win-unpacked，
 * 不碰 dist 里其它东西（比如手动放进去的测试包）。
 *
 * 默认只在真正构建时执行；`--check-only` 只校验不动文件。
 */
function cleanPreviousArtifacts({ checkOnly }) {
  const distDir = path.join(REPO_ROOT, 'dist');
  if (!fs.existsSync(distDir)) {
    pass('dist/ 不存在，无需清理');
    return;
  }
  const stale = [];
  for (const entry of fs.readdirSync(distDir, { withFileTypes: true })) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (name === 'win-unpacked' || name === 'mac' || name === 'linux-unpacked') stale.push(name);
      continue;
    }
    if (/\.(exe|zip|blockmap|dmg|AppImage|deb)$/i.test(name)) stale.push(name);
  }
  if (!stale.length) {
    pass('dist/ 没有上次构建的产物');
    return;
  }
  if (checkOnly) {
    pass(`dist/ 有 ${stale.length} 项上次构建的产物（构建时会清理）`);
    return;
  }
  let freed = 0;
  for (const name of stale) {
    const target = path.join(distDir, name);
    try {
      freed += dirSize(target);
      fs.rmSync(target, { recursive: true, force: true });
    } catch (error) {
      fail(`清理 dist/${name} 失败：${error?.message ?? error}`);
      return;
    }
  }
  pass(`已清理 dist/ 中 ${stale.length} 项上次构建的产物（约 ${(freed / 1048576).toFixed(0)}MB）`);
}

/** 递归统计大小，只用于给出「清理了多少」的提示。 */
function dirSize(target) {
  let total = 0;
  const walk = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return; }
    if (st.isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(p); } catch { return; }
      for (const name of entries) walk(path.join(p, name));
    } else {
      total += st.size;
    }
  };
  walk(target);
  return total;
}

function main() {
  const argv = process.argv.slice(2);
  const platform = detectPlatform(argv);
  // 只校验不动文件：用于 CI 或本地想先看一眼配置对不对。
  const checkOnly = argv.includes('--check-only');
  console.log(`== 构建前校验（目标平台：${platform}）==`);
  checkBuilderConfig();
  checkRequiredFiles();
  checkPlatformIcons(platform);
  checkLockfiles();
  cleanPreviousArtifacts({ checkOnly });

  for (const line of passes) console.log(`  [ok]   ${line}`);
  for (const line of failures) console.log(`  [fail] ${line}`);

  if (failures.length > 0) {
    console.error(`\n构建前校验失败：${failures.length} 项。修正后再运行 build。`);
    process.exit(1);
  }
  console.log(`\n构建前校验通过（${passes.length} 项）。`);
}

main();

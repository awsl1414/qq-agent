#!/usr/bin/env node
/**
 * 构建前静态校验：在 electron-builder 真正开始打包前，把「配置错了但能构建成功、
 * 装出来才发现坏了」的情况拦下来。
 *
 * 为什么需要这一步：electron-builder 对 `files` 的错误是宽容的 —— 少写一个
 * 白名单目录只会让功能静默消失（市场装不了扩展、图标空白），多写一个排除项
 * 则可能把 1.5GB 的便携 QQ 带进包。两种都不会让构建失败，只会在用户机器上暴露。
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
  ['prices.json', '内置价格表'],
  ['assets/icon.ico', '应用图标']
];

/**
 * 存在时必须在 files 排除项里的目录。
 * 前三个是「本机才有、且体积大或含隐私」的目录；命中说明配置漏了。
 */
const MUST_EXCLUDE_IF_PRESENT = [
  ['data', '用户数据（含 API Key、群聊记录）'],
  ['data-2', '多实例用户数据'],
  ['runtime/qq-portable', '便携 QQ（约 1.5GB）'],
  ['graphify-out', '知识图谱缓存（可重建）']
];

/** 其它包管理器留下的锁文件会误导贡献者，见 .npmrc */
const FORBIDDEN_LOCKFILES = ['package-lock.json', 'yarn.lock'];

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
 * 为什么要自己转：这里要判断的是「某目录是否被排除」，需要真的做匹配而不是
 * 字符串包含 —— `data-*` 形式的规则必须能覆盖 `data-2`，而 `runtime` 规则必须
 * 能覆盖 `runtime/qq-portable`。字符串前缀比较在这两种情况下都会给出错误答案。
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
        'builtin-modules.json 也会被 refreshBuiltinEntry 重写；asar 打包后这些路径不可写，' +
        '上述功能会集体失效。请改回 asar: false。'
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

  return config;
}

function checkRequiredFiles() {
  for (const [rel, why] of REQUIRED_FILES) {
    if (exists(rel)) pass(`${rel} 存在（${why}）`);
    else fail(`缺少 ${rel}（${why}）`);
  }
}

function checkLockfiles() {
  for (const name of FORBIDDEN_LOCKFILES) {
    if (exists(name)) fail(`发现 ${name}：本项目只用 pnpm，请删除该文件`);
    else pass(`无 ${name}`);
  }
}

function main() {
  console.log('== 构建前校验 ==');
  checkBuilderConfig();
  checkRequiredFiles();
  checkLockfiles();

  for (const line of passes) console.log(`  [ok]   ${line}`);
  for (const line of failures) console.log(`  [fail] ${line}`);

  if (failures.length > 0) {
    console.error(`\n构建前校验失败：${failures.length} 项。修正后再运行 build。`);
    process.exit(1);
  }
  console.log(`\n构建前校验通过（${passes.length} 项）。`);
}

main();

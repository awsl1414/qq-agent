#!/usr/bin/env node
/**
 * electron-builder 的启动包装器：把本项目的四段式版本号转换成 semver。
 *
 * electron-builder 26 在 validateConfig 阶段用 `semver.valid(pkg.version, true)`
 * 校验 package.json 的 version，四段式（本项目的 `0.4.9.1`）直接抛
 * `Invalid version`，构建无法开始。这是上游的硬校验，没有配置开关能绕过
 * （已核对 app-builder-lib 的 normalizePackageData.js）。
 *
 * 做法：构建期间把 package.json 的 version 临时写成 semver 合法形式
 * （`0.4.9.1` → `0.4.9-1`），再用 -c.extraMetadata.version 把真实四段版本
 * 写回包内 package.json，让 src/app.js 的更新检查与界面看到的仍是 0.4.9.1。
 * 构建结束（含异常与 Ctrl-C）后恢复原文件内容。
 *
 * 不直接把 package.json 改成三段：版本号是用户可见的发布标识，且 src/app.js 的
 * compareSemver 按段数取最大值比较，少一段会让第四段的更新永远检测不到。
 * 改版本号属于改业务语义，不该由打包层做。
 *
 * 用法：node scripts/run-builder.mjs --win [--dir]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const BUILDER_CLI = path.join(REPO_ROOT, 'node_modules', 'electron-builder', 'cli.js');

/** 四段式版本：每段都是纯数字 */
const FOUR_PART_VERSION = /^\d+\.\d+\.\d+\.\d+$/;
/** 三段式 semver，可选预发布 / 构建元数据 */
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * 把四段版本转成 semver 合法形式：0.4.9.1 → 0.4.9-1。
 *
 * 用 `-` 而不是 `.`：semver 只允许三段数字，第四段必须落在预发布位。
 * 这里仅用于骗过校验，包内真实版本由 extraMetadata 覆盖回四段。
 */
function toSemverVersion(version) {
  const parts = version.split('.');
  return `${parts[0]}.${parts[1]}.${parts[2]}-${parts[3]}`;
}

function main() {
  const builderArgs = process.argv.slice(2);

  const originalText = fs.readFileSync(PACKAGE_JSON, 'utf8');
  const version = String(JSON.parse(originalText).version ?? '').trim();

  if (!version) {
    console.error('run-builder：package.json 缺少 version 字段');
    process.exit(1);
  }

  const isFourPart = FOUR_PART_VERSION.test(version);
  if (!isFourPart && !SEMVER.test(version)) {
    console.error(`run-builder：无法识别的版本号 "${version}"（期望三段 semver 或四段数字）`);
    process.exit(1);
  }

  // 三段版本 electron-builder 直接接受，不必改写文件
  if (!isFourPart) {
    runBuilder(builderArgs);
    return;
  }

  const tempVersion = toSemverVersion(version);
  const extraArgs = [
    `-c.extraMetadata.version=${version}`,
    // buildVersion 决定 exe 的 FileVersion；显式给四段，避免被 buildNumber 追加
    `-c.buildVersion=${version}`,
    // buildNumber 决定 exe 的 ProductVersion（getVersionInWeirdWindowsForm 的第四段），
    // 不设的话四段版本会被截成 0.4.9.0
    `-c.buildNumber=${version.split('.')[3]}`
  ];

  console.log(`run-builder：版本 ${version} 不是 semver，构建期间临时写为 ${tempVersion}`);

  const data = JSON.parse(originalText);
  data.version = tempVersion;
  fs.writeFileSync(PACKAGE_JSON, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  // 恢复必须在所有退出路径上发生：正常结束、构建失败、Ctrl-C。
  // 留下改过的 package.json 会让下一次 pnpm install 与 verify-version 全部错乱。
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      fs.writeFileSync(PACKAGE_JSON, originalText, 'utf8');
    } catch (error) {
      console.error(`run-builder：恢复 package.json 失败，请手动把 version 改回 ${version}：${error?.message ?? error}`);
    }
  };
  process.on('exit', restore);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      restore();
      process.exit(1);
    });
  }

  try {
    runBuilder([...builderArgs, ...extraArgs]);
  } finally {
    restore();
  }
}

function runBuilder(args) {
  const result = spawnSync(process.execPath, [BUILDER_CLI, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit'
  });

  if (result.error) {
    console.error(`run-builder：启动 electron-builder 失败：${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

main();

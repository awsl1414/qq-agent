#!/usr/bin/env node
/**
 * 校验三处版本号一致：`VERSION` / `package.json` / `CHANGELOG.md` 顶部第一个已发布版本。
 *
 * 历史上出过「同一版本号对应两份不同内容」的发布事故：作者本地改了代码但忘了升
 * 版本，安装包停在旧构建上，用户装到的和 CHANGELOG 描述的不是一回事。
 * 这个脚本把「版本号对不上」变成构建期与 CI 期可见的失败。
 *
 * VERSION 这个纯文本文件是给人看的唯一入口：版本号原本只写在 package.json，
 * 而界面标题、更新报告等处又各自抄了一份，升版本时总漏改。升版本时先改它，
 * 再同步另外两处。它不参与运行时（运行时仍以 package.json 为准，
 * 因为 Electron 与打包工具只认那里）。
 *
 * 只比较第一个已发布条目，跳过 `## 未发布` 段：开发期间往未发布段追加内容
 * 是正常流程，不该因此报错。
 *
 * 用法：node scripts/verify-version.mjs
 * 退出码：0 = 一致；1 = 不一致或读不到
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const VERSION_FILE = path.join(REPO_ROOT, 'VERSION');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md');

/** 形如 `## 0.4.9.1 · ffmpeg 改为按需下载（2026-11-03，需重启）` */
const VERSION_HEADING = /^##\s+(\d+\.\d+\.\d+(?:\.\d+)?)\s+·/;
/** `## 未发布` 及其变体（未发布 / Unreleased） */
const UNRELEASED_HEADING = /^##\s+(未发布|Unreleased)\s*$/i;

function readVersionFile() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function readVersionFromPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  return String(pkg.version ?? '').trim();
}

function readFirstReleasedVersionFromChangelog() {
  const lines = fs.readFileSync(CHANGELOG, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (UNRELEASED_HEADING.test(line)) continue;
    const match = VERSION_HEADING.exec(line);
    if (match) return match[1];
  }
  return '';
}

function main() {
  const fileVersion = readVersionFile();
  const pkgVersion = readVersionFromPackage();
  const changelogVersion = readFirstReleasedVersionFromChangelog();

  const problems = [];
  if (!fileVersion) problems.push('VERSION 不存在或为空');
  if (!pkgVersion) problems.push('package.json 没有 version 字段');
  if (!changelogVersion) {
    problems.push('CHANGELOG.md 里找不到形如 "## 0.4.9.1 · 主题（日期）" 的已发布版本标题');
  }

  if (problems.length === 0 && !(fileVersion === pkgVersion && pkgVersion === changelogVersion)) {
    problems.push('三处版本号不一致');
  }

  if (problems.length > 0) {
    console.error('版本校验失败：');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    console.error('  当前值：');
    console.error(`    VERSION       = ${fileVersion || '(缺失)'}`);
    console.error(`    package.json  = ${pkgVersion || '(缺失)'}`);
    console.error(`    CHANGELOG     = ${changelogVersion || '(缺失)'}`);
    console.error('');
    console.error('升版本时三处必须一起改（见 .claude/rules/conventions.md 的更新日志一节）。');
    process.exit(1);
  }

  console.log(`版本号一致：${pkgVersion}（VERSION / package.json / CHANGELOG）`);
}

main();

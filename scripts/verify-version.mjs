#!/usr/bin/env node
/**
 * 校验 package.json 的 version 与 CHANGELOG.md 顶部第一个**已发布**版本一致。
 *
 * 为什么需要：历史上出过「同一版本号对应两份不同内容」的发布事故 —— 作者本地
 * 改了代码但忘了升版本，安装包停在旧构建上，用户装到的和 CHANGELOG 描述的不是
 * 一回事。这个脚本把「版本号与更新日志对不上」变成构建期可见的失败。
 *
 * 只比较第一个已发布条目，跳过 `## 未发布` 段：开发期间往未发布段追加内容是
 * 正常流程，不该因此报错。
 *
 * 用法：node scripts/verify-version.mjs
 * 退出码：0 = 一致；1 = 不一致或读不到
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PACKAGE_JSON = path.join(REPO_ROOT, 'package.json');
const CHANGELOG = path.join(REPO_ROOT, 'CHANGELOG.md');

/** 形如 `## 0.4.9.1 · ffmpeg 改为按需下载（2026-11-03，需重启）` */
const VERSION_HEADING = /^##\s+(\d+\.\d+\.\d+(?:\.\d+)?)\s+·/;
/** `## 未发布` 及其变体（未发布 / Unreleased） */
const UNRELEASED_HEADING = /^##\s+(未发布|Unreleased)\s*$/i;

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
  const pkgVersion = readVersionFromPackage();
  const changelogVersion = readFirstReleasedVersionFromChangelog();

  if (!pkgVersion) {
    console.error('校验失败：package.json 没有 version 字段');
    process.exit(1);
  }
  if (!changelogVersion) {
    console.error('校验失败：CHANGELOG.md 里找不到形如 "## 0.4.9.1 · 主题（日期）" 的已发布版本标题');
    process.exit(1);
  }

  if (pkgVersion !== changelogVersion) {
    console.error('版本号不一致：');
    console.error(`  package.json=${pkgVersion}`);
    console.error(`  CHANGELOG=${changelogVersion}`);
    console.error('请让两者一致后再构建（见 .claude/rules/conventions.md 的更新日志一节）。');
    process.exit(1);
  }

  console.log(`版本号一致：${pkgVersion}`);
}

main();

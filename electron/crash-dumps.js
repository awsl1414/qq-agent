// 崩溃转储保留上限（2026-10-16 外部审查 #3）
//
// 病灶：每个 minidump 约 34MB，而全库没有任何清理 —— 崩溃几次就永久占几百 MB，
// 且"崩溃趋势"完全不可观测（不聚合、不上报、不清理）。
// 本机 2026-10-16 一天内 GPU 子进程连崩 4 次，Crashpad/reports 下堆了 3 份共 100MB。
//
// 口径：按 mtime 保留最近 keep 份，更旧的删掉。目录不存在 / 读失败一律静默跳过 ——
//       清理失败不该影响启动。
// 说明：crashpad 实际落在 <userData>/Crashpad/reports/（main.js 里 startCrashReporter
//       的注释写的是 dumps/），所以整个 Crashpad 目录递归扫，只认 .dmp。
//
// 为什么单独成文件：main.js import 了 electron，纯 node 下跑不起来，逻辑塞在里面
// 就等于没有测试。抽出来之后 .workbuddy 下的套件可以直接喂临时目录验证。

import fs from 'node:fs';
import path from 'node:path';

export const CRASH_DUMP_KEEP = 5;

/**
 * @param {string} baseDir  Crashpad 目录（通常是 <userData>/Crashpad）
 * @param {object} [opts]   { keep?: number, log?: (msg:string)=>void }
 * @returns {{total:number, removed:number, freed:number}}
 */
export function pruneCrashDumps(baseDir, { keep = CRASH_DUMP_KEEP, log = () => {} } = {}) {
  const out = { total: 0, removed: 0, freed: 0 };
  if (!baseDir || !fs.existsSync(baseDir)) return out;

  const dumps = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.name.toLowerCase().endsWith('.dmp')) continue;
      try {
        const st = fs.statSync(full);
        dumps.push({ fp: full, size: st.size, mtime: st.mtimeMs });
      } catch { /* 读盘间隙文件没了，跳过 */ }
    }
  };
  walk(baseDir);
  out.total = dumps.length;
  if (dumps.length <= keep) return out;

  dumps.sort((a, b) => b.mtime - a.mtime);            // 新的在前，保留前 keep 个
  for (const d of dumps.slice(keep)) {
    try {
      fs.unlinkSync(d.fp);
      out.removed += 1;
      out.freed += d.size;
    } catch { /* 被占用就跳过，下次启动再清 */ }
  }
  if (out.removed) {
    log(`崩溃转储清理：删除 ${out.removed} 份旧的，腾出 ${(out.freed / 1048576).toFixed(1)}MB`
      + `（保留最近 ${keep} 份，现存 ${out.total - out.removed} 份）`);
  }
  return out;
}

// 可观测：记下"记忆到底有没有被用上"。
//
// 内置版只有块数/词项数/当日 token，没有检索命中率，也没有"模型到底调过几次检索工具"
// —— 于是"记忆是不是白开了"永远无法回答。这里补上最小可用的一组计数，
// 由 memory.status 能力暴露（宿主自带的 memory_status 工具会直接显示它）。
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from './util.js';

const FLUSH_INTERVAL_MS = 20000;

const EMPTY = () => ({
  version: 1,
  since: Date.now(),
  counters: {
    searches: 0,      // 检索次数（含每轮自动检索）
    hitSearches: 0,   // 有命中的检索次数
    autoInject: 0,    // 自动注入次数
    injectedChars: 0, // 自动注入的字符总量（≈token 成本）
    injectedLines: 0, // 自动注入的行数总量（一条注入里放了几行旧事）
    skippedStale: 0,  // 碎片级跨轮去重跳过的行数（省下来的 token）
    skippedLowScore: 0, // 相关度低于 autoRecallMinRel 被丢掉的候选块数
    autoInjectSkipAll: 0, // 候选全是上轮给过的原话 → 整段不注入的次数
    toolSearch: 0,    // 模型主动调检索工具的次数
    toolArchive: 0,   // 模型主动调归档的次数
    toolStatus: 0,
    consolidateRuns: 0,
    blocksAdded: 0,
    rollups: 0,
    forgotten: 0,
    prunedTokens: 0,
    cardsDropped: 0,
    crossTurnDropped: 0,
    todosDropped: 0,
    gistRevived: 0,   // 梗概墓碑被成功重建的次数（节省效应到底救回了多少）
    selfHealed: 0     // 索引里有、块文件没了的项被自愈摘掉的次数
  },
  last: {},
  days: {}
});

function todayKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Stats {
  constructor(root) {
    this.file = path.join(path.resolve(root), 'stats.json');
    ensureDir(path.dirname(this.file));
    const raw = readJson(this.file, null);
    this.data = raw && raw.counters ? raw : EMPTY();
    if (!this.data.counters) this.data.counters = EMPTY().counters;
    if (!this.data.days) this.data.days = {};
    this.lastFlushAt = 0;
  }

  /** 累加计数；patch 里非数字的键会覆盖写进 last（如 lastQuery）。 */
  bump(patch = {}) {
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        this.data.counters[k] = (Number(this.data.counters[k]) || 0) + v;
        const day = todayKey();
        if (!this.data.days[day]) this.data.days[day] = {};
        this.data.days[day][k] = (Number(this.data.days[day][k]) || 0) + v;
      } else {
        this.data.last[k] = v;
      }
    }
    this.data.last.at = Date.now();
    // 节流落盘：钩子里每次都写文件既没必要也会拖慢主流程
    if (Date.now() - this.lastFlushAt > FLUSH_INTERVAL_MS) this.flush({ force: true });
  }

  flush({ force = false } = {}) {
    if (!force && Date.now() - this.lastFlushAt < FLUSH_INTERVAL_MS) return false;
    // 只留最近 30 天，别让统计文件自己长成负担
    const days = Object.keys(this.data.days).sort();
    while (days.length > 30) delete this.data.days[days.shift()];
    writeJson(this.file, this.data);
    this.lastFlushAt = Date.now();
    return true;
  }

  snapshot() {
    const c = this.data.counters;
    const searches = Number(c.searches) || 0;
    return {
      since: this.data.since,
      searches,
      hitRate: searches ? Math.round(((Number(c.hitSearches) || 0) / searches) * 100) / 100 : 0,
      autoInject: Number(c.autoInject) || 0,
      injectedChars: Number(c.injectedChars) || 0,
      injectedLines: Number(c.injectedLines) || 0,
      skippedStale: Number(c.skippedStale) || 0,
      skippedLowScore: Number(c.skippedLowScore) || 0,
      autoInjectSkipAll: Number(c.autoInjectSkipAll) || 0,
      // 三个直接回答"token 花得值不值"的派生量：
      //   linesPerInject 每次注入真的放了几行（越接近 cap 说明预算用得好）
      //   charsPerLine   平均每行多长（行宽联动之后应当明显低于旧的 ~90 上限）
      //   staleSavedChars 跨轮去重省下的字符量级（按跳过的行 × 当前行宽估）
      linesPerInject: (Number(c.autoInject) || 0)
        ? Math.round(((Number(c.injectedLines) || 0) / (Number(c.autoInject) || 1)) * 100) / 100 : 0,
      charsPerLine: (Number(c.injectedLines) || 0)
        ? Math.round(((Number(c.injectedChars) || 0) / (Number(c.injectedLines) || 1)) * 10) / 10 : 0,
      // 这个数字是回答"记忆有没有被用上"的关键：模型主动检索 + 自动注入
      toolCalls: (Number(c.toolSearch) || 0) + (Number(c.toolArchive) || 0),
      toolSearch: Number(c.toolSearch) || 0,
      toolArchive: Number(c.toolArchive) || 0,
      consolidateRuns: Number(c.consolidateRuns) || 0,
      blocksAdded: Number(c.blocksAdded) || 0,
      rollups: Number(c.rollups) || 0,
      forgotten: Number(c.forgotten) || 0,
      prunedTokens: Number(c.prunedTokens) || 0,
      cardsDropped: Number(c.cardsDropped) || 0,
      crossTurnDropped: Number(c.crossTurnDropped) || 0,
      todosDropped: Number(c.todosDropped) || 0,
      // 「节省效应到底救回了多少」—— 墓碑从"只有印象"被重建回"完整回忆"的次数
      gistRevived: Number(c.gistRevived) || 0,
      // 索引与块文件不一致、被懒自愈摘掉的项数。长期 > 0 说明磁盘/文件有问题
      selfHealed: Number(c.selfHealed) || 0,
      last: this.data.last
    };
  }
}

/** 文件系统层面的体积概览（统计文件之外的真实占用）。 */
export function dirSize(dir) {
  let total = 0;
  let files = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { total += fs.statSync(p).size; files += 1; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { bytes: total, files, kb: Math.round(total / 1024) };
}

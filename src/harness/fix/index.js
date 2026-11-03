// 自动修复（self-fix）：带两道人工闸的修复链路的行为层入口。
//
// 全链路（每一步都对应一个 capability，核心只按能力名取，不 import 本插件）：
//
//   fix.prompt  拼提案 prompt（本地读文件片段，不调模型）
//   fix.parse   解析提案 JSON（校验 P1 schema / P8 单一目标 / P9 计划完整性）
//   fix.create  落一笔工单（status=proposed），发一次性 approvalToken  ← 闸①之前，不写任何真实文件
//   fix.apply   校验令牌 → 把 hunks 确定性地写进暂存区 → 跑协议闸      ← 闸①在这里被强制执行
//   fix.verify  跑白名单验证器并记录来源（暂存副本或真实源码），记一轮
//   fix.rerun   同一版本重跑（不改码），限次
//   fix.commit  持久化快照与事务清单 → 替换真实文件
//   fix.rollback 从快照回滚
//   fix.discard 丢弃（理由落盘）
//   fix.list / fix.detail / fix.delete / fix.prune / fix.export / fix.status
//
// ── 与 self-doctor 的关系 ──
//   `api.capability('doctor.scan-project', args)` 调用内置自检，返回扫描结果。
//   能力不可用或未返回结果 → 该项验证降级为 skip，其余照跑。
//
// ── 红线 ──
//   1. 工单、暂存与快照写在 <DATA_DIR>/plugin-data/self-fix/；commit / rollback 会写真实目标及内置基线。
//      commit 必须先持久化原始快照和 writing 清单，才允许替换真实文件。
//   2. 模型没有任何写盘工具："应用改动"是把提案里的 hunks **确定性地**套到暂存区副本上，
//      不是让模型再写一遍文件。这样 P2（最小改动）才有可能被静态校验。
//   3. 模块作为 kind='core' 常驻，自动修复操作由默认 false 的 fixEnabled 控制。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDir, newFixId, newApprovalToken, sanitizeId, fixesDir,
  stagingDir, sandboxDir, backupDir, recordFile,
  readRecord, writeRecord, writeVerify, readVerify, listRecords, deleteRecord, pruneRecords,
  resolveTarget, stagedPath, backupPath, commit, rollback, classify,
  writeJsonAtomic, diffStat, simpleDiff, sha1, SNAPSHOT_PHASE, pendingCommit
} from './core.js';
import { runProtocolGate, runVerifyPlan, VERIFIERS, VERIFIER_IDS } from './checks.js';
import { buildProposePrompt, parseProposal, applyHunks } from './prompt.js';
import { buildEvidencePack, packToMarkdown, buildDocx, buildReportPrompt, parseReport, grepLogs } from './doc.js';
// 数据目录的唯一真源（与 forge / dev / doctor 同源）。不能写 `QQ_AGENT_DATA_DIR || '.'`：
// 该 env 只有 electron/main.js 会设：headless（node src/server.js）下回落进程 cwd，
// 工单会写进 <仓库根>/plugin-data/self-fix/，而 UI 读 data/ 下的真目录。
import { DATA_DIR } from '../../config.js';
import { harnessProjectRoot } from '../paths.js';

const DEFAULTS = {
  fixEnabled: false,
  maxReruns: 3,
  verifyTimeoutSec: 30,
  auditKeepDays: 90,
  auditMaxRecords: 500,
  snapshotKeepDays: 30,
  allowCoreFiles: false
};

let cfg = () => DEFAULTS;
let log = (..._a) => {};
let askCapability = () => undefined;

let root = null;        // <DATA_DIR>/plugin-data/self-fix
let dataRoot = null;    // <DATA_DIR>（寻址 scope='data' 用）
let appRoot = null;     // 源码根或 resources/app（寻址 scope='code' 用）
let projectRoot = null; // 项目根（tests/，上游布局可用 .workbuddy/tools/）
let logsDir = null;
let isEnabled = false;

function ctxOf() {
  return {
    root, dataRoot, appRoot, projectRoot, logsDir,
    nodePath: process.execPath,
    timeoutSec: Math.max(5, Number(cfg().verifyTimeoutSec) || 30),
    sandbox: null
  };
}

function nowEnabled() {
  return cfg().fixEnabled === true;
}

function guardEnabled() {
  if (!nowEnabled()) return { ok: false, available: true, enabled: false, error: '「自动修复」未启用（自检 → 自动修复 页可当场开启）' };
  return null;
}

function guardPendingCommit(rec) {
  return pendingCommit(rec)
    ? { ok: false, error: '提交中断，可回滚或重试；完成恢复前不能修改暂存内容、验证或丢弃工单' }
    : null;
}

// ── 相关文件收集（给提案 prompt 用）────────────────────────────────────────
//
// 在插件侧做：这与 doctor-tools 的"沙箱是唯一路径解析入口"同一逻辑：
// 核心不该懂路径规则。核心只把 question/answer/target 交给插件，插件回一段拼好的 prompt。

const WINDOW = 60;      // 命中行上下各留多少行
const MAX_CHARS = 24000;

function readWindow(abs, line) {
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  const c = Number(line) || 0;
  const lo = c > 0 ? Math.max(1, c - WINDOW) : 1;
  const hi = c > 0 ? Math.min(lines.length, c + WINDOW) : Math.min(lines.length, 240);
  const body = lines.slice(lo - 1, hi)
    .map((l, i) => `${String(lo + i).padStart(5)}| ${l}`).join('\n');
  return { total: lines.length, excerpt: body.slice(0, MAX_CHARS) };
}

/** 从诊断结论里抠出被提到的文件名，作为"顺带看看"的候选。 */
function mentionedFiles(text, appRoot) {
  const out = new Set();
  const re = /([\w./-]+\.(?:js|mjs|cjs|json|css|html))/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const rel = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
    if (!/^(src|ui|plugins|skills)\//.test(rel)) continue;
    if (/(^|\/)node_modules\//.test(rel)) continue;
    if (fs.existsSync(path.join(appRoot, rel))) out.add(rel);
    if (out.size >= 3) break;
  }
  return [...out];
}

function collectRelevantFiles({ target, answer }) {
  const files = [];
  const push = (rel, line, scope = 'code') => {
    if (files.some((f) => f.path === rel)) return;
    const abs = path.join(scope === 'code' ? appRoot : dataRoot, rel);
    const w = readWindow(abs, line);
    if (!w) return;
    files.push({ scope, path: rel, level: classify(rel), lines: w.total, excerpt: w.excerpt });
  };
  if (target?.file) push(String(target.file).replace(/\\/g, '/'), target.line, target.scope === 'data' ? 'data' : 'code');
  for (const rel of mentionedFiles(answer, appRoot)) push(rel, 0);
  return files;
}

// ── 暂存区写入（确定性地套 hunks）──────────────────────────────────────────

/**
 * 把一个改动项的 hunks 套到"改动前文本"上，写进暂存区。
 * 改动前文本的来源是真实文件（首次 apply），因为暂存区是"待落地的完整新版本"。
 */
function stageOne(id, change) {
  const r = resolveTarget(root, appRoot, dataRoot, change);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.level === 'L1' && cfg().allowCoreFiles !== true) {
    return { ok: false, error: `核心文件默认不允许修改（${change.path}）—— 需要在设置里打开「允许修改核心代码」` };
  }
  let before = '';
  let exists = false;
  try { before = fs.readFileSync(r.abs, 'utf8'); exists = true; } catch { before = ''; }
  if (!exists && !change.hunks.some((h) => h.from <= 1)) {
    // 新文件：必须从第 1 行开始写整段，否则会静默产出半截文件
    return { ok: false, error: `目标文件不存在（${change.path}）：新建文件时 hunk 必须从第 1 行开始` };
  }
  const after = applyHunks(before, change.hunks);
  const st = stagedPath(root, id, change);
  ensureDir(path.dirname(st));
  fs.writeFileSync(st, after, 'utf8');
  return { ok: true, path: change.path, level: r.level, isNew: !exists, stat: diffStat(before, after) };
}

/**
 * 算一份改动预览（改动前 / 改动后 / diff 行），给 UI 与报告用。
 *
 * 闸① 之前**暂存区里还没有文件**（批准前一个字节都不写），所以这里必须能
 * 在内存里把 hunks 套一遍得到"改后文本"。否则提案卡会显示成"整份文件被删光了"：
 * 那会让所有人在批准前误判。批准之后暂存区就有文件了，两条路径结果一致。
 */
function previewAll(id, rec) {
  const readMaybe = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  return (rec?.proposal?.changes || []).map((c) => {
    const r = resolveTarget(root, appRoot, dataRoot, c);
    const st = stagedPath(root, id, c);
    const exists = fs.existsSync(st);
    const before = (exists ? readMaybe(backupPath(root, id, c)) : null)
      ?? (r.ok ? readMaybe(r.abs) : null)
      ?? '';
    const after = exists ? (readMaybe(st) ?? '') : applyHunks(before, c.hunks || []);
    return {
      scope: c.scope, path: c.path, level: r.ok ? r.level : (c.level || '?'), intent: c.intent,
      staged: exists,
      stat: diffStat(before, after),
      lines: simpleDiff(before, after, 2),
      protocol: (rec.protocol?.violations || []).filter((v) => (v.title || '').includes(c.path) || (v.detail || '').includes(c.path))
    };
  });
}

function summarize(rec) {
  return {
    id: rec.id, createdAt: rec.createdAt, updatedAt: rec.updatedAt, status: rec.status,
    recovery: pendingCommit(rec) ? '提交中断，可回滚或重试' : null,
    question: rec.question || '', target: rec.target || {},
    rootCause: rec.proposal?.rootCause || '',
    paths: (rec.proposal?.changes || []).map((c) => `${c.scope === 'data' ? 'data:' : ''}${c.path}`),
    noChange: rec.noChange === true || !(rec.proposal?.changes || []).length,
    blocking: rec.protocol?.blocking || 0,
    warn: (rec.protocol?.violations || []).filter((v) => v.level === 'warn').length,
    rounds: (rec.rounds || []).length,
    reruns: rec.decision?.reruns || 0,
    verdict: rec.decision?.verdict || null,
    reason: rec.decision?.reason || '',
    unverifiable: rec.proposal?.unverifiable || []
  };
}

// ── 批准令牌的生命周期 ─────────────────────────────────────────────────────
//
// 曾出现过：模型把代码改到闸门能通过了，闸门却始终不放行。
//   根因不是闸门判定，而是 approve 令牌只消费、不归还：
//     fix.apply 置 consumed=true → 自验失败(status=failed) / 人工回滚(rolled-back)
//     → 再想 apply 直接 403「批准令牌已使用过」，而 commit 又要求 status=verified
//     → 这笔工单就此死透，界面上表现为"改好了、点了没反应"。
//
// 修法两条，缺一不可：
//   ① 令牌绑定**提案内容**（指纹）：人工批准的是这份 diff，不是这个工单号。
//      内容改了就作废旧令牌、要求重新批准。这是安全性，不能靠"允许重复 apply"换来。
//   ② 失败/回滚时**重发**令牌并把状态退回 proposed：工单能继续用，但每次都是新的一次人工批准。

/** 提案指纹：内容任何一处变化都会变。旧记录没有该字段时按"无指纹"处理（向后兼容）。 */
function proposalFingerprint(p) {
  const changes = (Array.isArray(p?.changes) ? p.changes : []).map((c) => ({
    scope: String(c?.scope || 'code'),
    path: String(c?.path || ''),
    level: String(c?.level || ''),
    intent: String(c?.intent || ''),
    hunks: (Array.isArray(c?.hunks) ? c.hunks : []).map((h) => [
      Number(h?.from) || 0, Number(h?.to) || 0, String(h?.replacement ?? '')
    ])
  }));
  return sha1(JSON.stringify({
    rootCause: String(p?.rootCause || ''),
    expectedEffect: String(p?.expectedEffect || ''),
    rollback: String(p?.rollback || ''),
    changes
  }));
}

/**
 * 重发一张批准令牌，把工单退回 proposed（detail 接口据此重新下发 approvalTicket）。
 * 只在"改动没有落地、且需要模型/人再试一次"的分支调用：写暂存区失败、自验未通过、人工回滚。
 */
function reissueApproval(rec, why = '') {
  rec.approval = {
    token: newApprovalToken(),
    approvedAt: null,
    consumed: false,
    fingerprint: proposalFingerprint(rec.proposal)
  };
  rec.status = 'proposed';           // 回到"待批准"，不是"已废弃"
  rec.reissues = (Number(rec.reissues) || 0) + 1;
  rec.lastReissueAt = Date.now();
  if (why) rec.reissueReason = String(why).slice(0, 200);
  return rec.approval.token;
}

// ── Skill 接口 ────────────────────────────────────────────────────────────

export function setup(api) {
  cfg = () => ({ ...DEFAULTS, ...(api.config() || {}) });
  log = api.log;
  askCapability = api.capability || (() => undefined);

  root = path.join(DATA_DIR, 'plugin-data', 'self-fix');
  // <DATA_DIR> = root 往上两级（root=<DATA>/plugin-data/self-fix）
  dataRoot = path.dirname(path.dirname(root));
  // appRoot：本文件位于 <appRoot>/src/harness/fix/index.js
  // 必须用 fileURLToPath：new URL().pathname 在 Windows 上会给 /E:/... 前导斜杠。
  // 优先用宿主注入的 appRoot（见 src/harness/index.js），算错会让自检/修复指向 src/。
  appRoot = api.appRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  projectRoot = harnessProjectRoot(appRoot);
  logsDir = path.join(dataRoot, 'logs');

  try { ensureDir(fixesDir(root)); } catch { /* 无权限时后续每步都会明确报错 */ }

  isEnabled = nowEnabled();
  log(`已启动（自动修复 ${isEnabled ? '开启' : '关闭'}；数据目录 ${root}）；` +
      `可改范围：plugins/ skills/${cfg().allowCoreFiles ? ' + src/ ui/ electron/（核心）' : '（核心默认关闭）'}`);

  // writing 清单就是恢复标记；启动时报告中断，保留原状态供重试，禁止清理。
  for (const rec of listRecords(root).records) {
    if (pendingCommit(rec)) log(`工单 ${rec.id} 提交中断，可回滚或重试`);
  }
  // 启动时只清理未落地且没有未完成事务的记录。
  try {
    const days = Math.max(0, Number(cfg().auditKeepDays) || 0);
    const maxRec = Math.max(0, Number(cfg().auditMaxRecords) || 0);
    const before = days ? Date.now() - days * 86400000 : 0;
    const r = pruneRecords(root, {
      before, maxRecords: days === 0 && maxRec === 0 ? 0 : maxRec, dryRun: false
    });
    if (r.removed) log(`按保留策略清理了 ${r.removed} 笔过期审计记录`);
  } catch (e) {
    log('保留策略清理失败：', e?.message || e);
  }
}

export function deactivate() { /* 无需定时器：全部落盘即时完成 */ }
export function dispose() { deactivate(); }

export const providers = {
  'fix.status': () => {
    const { records, corrupt } = listRecords(root);
    const by = {};
    for (const r of records) by[r.status] = (by[r.status] || 0) + 1;
    return {
      available: true,
      enabled: nowEnabled(),
      root,
      allowCoreFiles: cfg().allowCoreFiles === true,
      limits: {
        maxReruns: Number(cfg().maxReruns) || 3,
        verifyTimeoutSec: Number(cfg().verifyTimeoutSec) || 30,
        auditKeepDays: Number(cfg().auditKeepDays) || 0,
        auditMaxRecords: Number(cfg().auditMaxRecords) || 0
      },
      verifiers: VERIFIERS.map((v) => ({ id: v.id, label: v.label, hard: !!v.hard, desc: v.desc })),
      counts: { total: records.length, byStatus: by, corrupt }
    };
  },

  'fix.list': ({ status = '', limit = 200 } = {}) => {
    const { records, corrupt } = listRecords(root);
    const filtered = status ? records.filter((r) => r.status === status) : records;
    return { records: filtered.slice(0, Math.max(1, Number(limit) || 200)).map(summarize), total: filtered.length, corrupt };
  },

  'fix.detail': ({ fixId } = {}) => {
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    return {
      ok: true, record: rec, summary: summarize(rec),
      preview: previewAll(rec.id, rec),
      verify: readVerify(root, rec.id) || { rounds: [] },
      backupExists: fs.existsSync(backupDir(root, rec.id)),
      // 闸①的批准票据。**它保证的不是"保密"，而是"批准必须是一次独立的、人驱动的请求"**：
      //   一次性 + 与 fixId 绑定，所以「propose→apply」不可能被同一条链路自动串起来，
      //   重复点也不会二次写入。这里回给 UI 是为了让页面刷新后仍能批准同一份提案
      //   （否则一笔"待批准"的工单会永远卡住，只能丢弃）。
      //   真正的边界仍然是：只有人驱动的界面会发 HTTP 请求，模型拿不到这条通道。
      approvalTicket: (rec.status === 'proposed' && rec.approval && !rec.approval.consumed)
        ? rec.approval.token : ''
    };
  },

  /** 拼提案 prompt（不调模型）。 */
  'fix.prompt': ({ fixId, question = '', answer = '', target = null, extraNote = '' } = {}) => {
    const g = guardEnabled(); if (g) return g;
    const files = collectRelevantFiles({ target, answer });
    const p = buildProposePrompt({ fixId: fixId || newFixId(), question, answer, target, files, extraNote });
    return { ok: true, sys: p.sys, user: p.user, files: files.map((f) => ({ path: f.path, level: f.level, lines: f.lines })) };
  },

  /** 解析提案（不调模型）。 */
  'fix.parse': ({ text } = {}) => {
    const r = parseProposal(text);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, proposal: r.proposal };
  },

  /** 落一笔工单（status=proposed）。**不写任何真实文件**。 */
  'fix.create': ({ question = '', answer = '', target = null, proposal = null, model = '' } = {}) => {
    const g = guardEnabled(); if (g) return g;
    if (!proposal || !Array.isArray(proposal.changes)) return { ok: false, error: '缺少 proposal' };
    // 空提案 = 「本次无需代码修复」（prompt 允许的合法产物，见 checks.js 的同名注释）。
    // 标出来，好让界面把它显示成正常终态，而不是"被闸门拦下的失败单"。
    const noChange = proposal.changes.length === 0;
    const id = newFixId();
    const rec = {
      id,
      createdAt: Date.now(), updatedAt: Date.now(),
      status: 'proposed',
      noChange,
      question: String(question).slice(0, 2000),
      answer: String(answer).slice(0, 8000),
      model: String(model || ''),
      target: {
        file: String(target?.file || proposal.changes[0]?.path || '').replace(/\\/g, '/'),
        line: Number(target?.line) || 0,
        ruleId: String(target?.ruleId || ''),
        title: String(target?.title || '')
      },
      proposal,
      protocol: null,
      rounds: [],
      approval: {
        token: newApprovalToken(),
        approvedAt: null,
        consumed: false,
        // 指纹先留空：协议闸预检会**改写 change.level**（checks.js 的 `resolveTarget` 按路径重算等级），
        // 必须在预检之后再算，否则 create 与 apply 两端算出的指纹天然不一致。
        fingerprint: ''
      },
      decision: null,
      snapshot: { files: [] },
      appliedAt: null, committedAt: null
    };
    // 预检一次协议闸（不改 status，只是让闸① 的界面上能有结论可看）
    try { rec.protocol = runProtocolGate(root, appRoot, dataRoot, rec); } catch (e) { rec.protocol = { passed: false, blocking: 1, violations: [{ code: 'P?', level: 'block', title: '协议闸预检失败', detail: String(e?.message || e) }] }; }
    // 预检会归一化 changes（含 level），指纹必须在这一步之后算，才是"用户将看到并批准的那份内容"
    rec.approval.fingerprint = proposalFingerprint(rec.proposal);
    writeRecord(root, id, rec);
    return { ok: true, fixId: id, approvalToken: rec.approval.token, record: rec, summary: summarize(rec), noChange };
  },

  /**
   * 闸①：校验一次性批准令牌 → 把改动写进暂存区 → 跑协议闸。
   * 令牌不对/过期/已用过一律 403 语义（ok:false），**什么都不做**：
   * 这让"人工批准"成为后端绕不过去的门，而不是界面上的一个装饰按钮。
   */
  'fix.apply': ({ fixId, approvalToken, extraNote = '' } = {}) => {
    const g = guardEnabled(); if (g) return g;
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const pending = guardPendingCommit(rec); if (pending) return pending;
    // 空提案没有任何可应用的内容：明确拒绝，别让它在 apply 之后变成一个"空的暂存区工单"。
    if (rec.noChange === true || !(rec.proposal?.changes || []).length) {
      return { ok: false, noChange: true, error: '本次提案没有任何改动（判定为「无需代码修复」）—— 无需应用，直接丢弃这条即可。' };
    }
    if (!rec.approval || rec.approval.consumed) return { ok: false, code: 403, error: '批准令牌已使用过（一个令牌只能批准一次）' };
    if (String(approvalToken || '') !== String(rec.approval.token || '')) {
      return { ok: false, code: 403, error: '批准令牌不匹配 —— 必须由人工点击「批准并应用」才会带上正确的令牌' };
    }
    // 指纹校验：批准的是"这份提案"，不是"这个工单号"。
    // 没有 fingerprint 的老记录跳过（向后兼容）；新记录一律要求内容未变。
    const currentFp = proposalFingerprint(rec.proposal);
    if (rec.approval.fingerprint && rec.approval.fingerprint !== currentFp) {
      return {
        ok: false, code: 403,
        error: '提案在批准之后又被改动过 —— 旧批准作废。请重新审阅当前提案再批准（工单详情里会给出新的批准入口）。'
      };
    }
    if (extraNote) rec.note = String(extraNote).slice(0, 1000);

    const staged = [];
    for (const c of rec.proposal.changes) {
      const r = stageOne(rec.id, c);
      if (!r.ok) {
        // 写暂存区失败**不能**把令牌一起吃掉：consumed 若在循环之前就置位，
        // 一次写盘异常 = 这笔工单永久无法再应用。改为"全部写成功才消费"，
        // 失败则原地换一张新票，用户可以立刻重试。
        rec.status = 'failed';
        rec.failReason = r.error;
        reissueApproval(rec, `写暂存区失败：${r.error}`.slice(0, 180));
        writeRecord(root, fixId, rec);
        return { ok: false, error: r.error, applied: staged, approvalToken: rec.approval.token, retryable: true };
      }
      staged.push(r);
    }
    // 全部落进暂存区之后再消费令牌 + 记批准时间（commit 据此确认"确有人批准过"）
    rec.approval.consumed = true;
    rec.approval.approvedAt = Date.now();
    rec.status = 'applied';
    rec.appliedAt = Date.now();
    rec.protocol = runProtocolGate(root, appRoot, dataRoot, rec);
    // 协议闸会再做一次 changes 归一化（level 等），指纹必须在它之后落定，
    // 否则下一次 apply 算出的指纹会和这里存的不一致（create 里也踩过同一条）。
    rec.approval.fingerprint = proposalFingerprint(rec.proposal);
    writeRecord(root, fixId, rec);
    return { ok: true, fixId, staged, protocol: rec.protocol, preview: previewAll(rec.id, rec) };
  },

  /** 重新跑一次协议闸（人工改过暂存区、或只想复核）。 */
  'fix.gate': ({ fixId } = {}) => {
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const pending = guardPendingCommit(rec); if (pending) return pending;
    rec.protocol = runProtocolGate(root, appRoot, dataRoot, rec);
    writeRecord(root, fixId, rec);
    return { ok: true, protocol: rec.protocol };
  },

  /** 自验：准备改动副本，按各验证器的数据来源执行并记录结果。 */
  'fix.verify': ({ fixId } = {}) => {
    const g = guardEnabled(); if (g) return g;
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const pending = guardPendingCommit(rec); if (pending) return pending;
    if (!Array.isArray(rec.proposal?.changes) || !rec.proposal.changes.length) {
      rec.status = 'verified';
      writeRecord(root, fixId, rec);
      return { ok: true, verify: { plan: [], items: [], passed: true, failCount: 0, failureKey: '' }, note: '本次没有改动，无需自验' };
    }
    // 沙箱：先把受影响文件复制过去（改动后的版本）
    const sb = sandboxDir(root, rec.id);
    try {
      fs.rmSync(sb, { recursive: true, force: true });
      ensureDir(sb);
      for (const c of rec.proposal.changes) {
        const st = stagedPath(root, rec.id, c);
        const dst = path.join(sb, c.scope === 'data' ? 'data' : 'code', ...String(c.path).split('/'));
        ensureDir(path.dirname(dst));
        fs.copyFileSync(st, dst);
      }
    } catch (e) {
      return { ok: false, error: `准备沙箱失败：${e.message}` };
    }

    const scanProject = (args) => askCapability('doctor.scan-project', args);

    const ctx = { ...ctxOf(), sandbox: sb, scanProject };
    const res = runVerifyPlan(root, appRoot, dataRoot, rec, ctx);

    const priorRounds = Array.isArray(rec.rounds) ? rec.rounds : [];
    const n = priorRounds.length + 1;
    // 收敛保护：连续两轮失败项集合没有缩小 → 停（由 routes 读 lastTwoSameFailure 决定）
    const prev = priorRounds[priorRounds.length - 1];
    const sameAsPrev = !!prev?.verify && prev.verify.failureKey === res.failureKey && res.failCount > 0;
    const round = { n, at: Date.now(), verify: res, sameAsPrev };
    rec.rounds = [...priorRounds, round];
    rec.status = res.passed ? 'verified' : 'failed';
    rec.lastVerifyPassed = !!res.passed;
    // 自验没过 → 换一张新票退回"待批准"。
    // 为什么：验失败后工单若停在 failed，apply 会被已消费的令牌挡住，commit 又要求 verified
    //：用户只能看着"改好了却推不动"。换票后模型改完可直接再应用一次。
    // 暂存区**保留**：fix.rerun 仍能对同一份暂存重跑（验证抖动时不丢当前成果）。
    if (!res.passed) reissueApproval(rec, `自验未通过（第 ${n} 轮，${res.failCount} 项失败）`);
    writeRecord(root, fixId, rec);
    writeVerify(root, fixId, { fixId: rec.id, rounds: rec.rounds });

    // 跑完就清沙箱（原始产物已进 rounds[].verify，不需要留目录）
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }

    return { ok: true, round: n, verify: res, sameAsPrev, converged: sameAsPrev };
  },

  /** 闸②的「重跑」：同一版本再跑一遍验证，**不改码**。限次。 */
  'fix.rerun': ({ fixId } = {}) => {
    const g = guardEnabled(); if (g) return g;
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const max = Math.max(0, Number(cfg().maxReruns) || 0);
    const used = Number(rec.decision?.reruns || 0);
    if (used >= max) {
      return { ok: false, error: `重跑已达上限（${max} 次）。真跑有抖动，但不能无限重跑到"通过"为止 —— 请直接看产物决定通过或丢弃。` };
    }
    // 重跑不改码：暂存区原样，只是重新执行一遍验证器
    const out = providers['fix.verify']({ fixId });
    if (!out.ok) return out;
    const rec2 = readRecord(root, fixId);
    rec2.decision = { ...(rec2.decision || {}), reruns: used + 1 };
    writeRecord(root, fixId, rec2);
    return { ok: true, reruns: used + 1, maxReruns: max, round: out.round, verify: out.verify, converged: out.converged };
  },

  /** 闸②的「通过」：快照 → 写真实文件。 */
  'fix.commit': ({ fixId } = {}) => {
    const g = guardEnabled(); if (g) return g;
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    if (rec.status === 'committed') return { ok: false, error: '这笔工单已经落地过了' };
    if (!rec.approval?.approvedAt) return { ok: false, error: '没有人工批准的记录，拒绝落地' };
    // 闸②必须真的成立：**必须先通过自验**（status='verified'，由 fix.verify 在 passed 时写入），
    // 否则「闸②」只是个装饰按钮：跳过 verify 直接 commit 会让未经任何验证、协议闸明确不合规的
    // 改动被写进 src/ ui/，随后热重载。这两条是闸②的全部价值所在，不能省。
    if (rec.status !== 'verified') {
      return {
        ok: false,
        error: `尚未通过自验，拒绝落地（当前状态：${rec.status || '未知'}）。`
          + '下一步：在闸②点「运行验证」；若验证项本身要改代码，请改完后重新批准应用（工单详情里会给新的批准入口）。'
      };
    }
    // fail-closed：`!rec.protocol` 也要拒。写成 `if (rec.protocol && rec.protocol.passed === false)`
    // 的话，protocol 为 null/undefined 时整个协议复检被**跳过**，于是
    // `{status:'verified', protocol:null}` 就能直接落地（实测真实文件被写入）。
    // 工单是普通 JSON（<DATA_DIR>/plugin-data/self-fix/fixes/*.json），
    // status/protocol 全部自报、无完整性校验，所以判据必须要求"确凿通过"。
    if (!rec.protocol || rec.protocol.passed !== true) {
      const why = rec.protocol
        ? `协议闸未通过（${rec.protocol.blocking ?? '?'} 项阻断）`
        : '缺少协议闸结果（工单可能被外部改动过）';
      const detail = (rec.protocol?.violations || [])
        .filter((v) => v.level === 'block')
        .map((v) => `${v.code} ${v.title}`).join('；');
      return { ok: false, error: `${why}，拒绝落地。${detail}` };
    }
    const out = commit(root, rec.id, appRoot, dataRoot, rec);
    if (!out.ok) return out;
    // 落地动到内置模块的话，core 里已同步重算过基线（见 core.js refreshTouchedBuiltins）
    for (const b of (out.baseline || [])) log(`已重算内置基线：${b.dir}（${b.files} 个文件）`);
    // core 已将 committed 阶段、工单状态与人工决断作为同一条记录持久化。
    return { ok: true, fixId, files: out.files, coreChanged: out.files.some((f) => f.level === 'L1'), needsRestart: out.files.some((f) => f.level === 'L1') };
  },

  /** 回滚（按工单）。 */
  'fix.rollback': ({ fixId } = {}) => {
    const g = guardEnabled(); if (g) return g;
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const out = rollback(root, rec.id, appRoot, dataRoot, rec);
    if (!out.ok) return out;
    for (const b of (out.baseline || [])) log(`已重算内置基线：${b.dir}（${b.files} 个文件）`);
    rec.status = 'rolled-back';
    rec.snapshot.phase = SNAPSHOT_PHASE.ROLLED_BACK;
    rec.rolledBackAt = Date.now();
    // 回滚 = 改动没留在磁盘上。工单不能就此作废：换票退回待批准，
    // 模型可以按新的诊断再改一版、重新走一次人工批准（旧快照与验证轮次都保留）。
    reissueApproval(rec, '已回滚，等待重新批准');
    writeRecord(root, fixId, rec);
    return { ok: true, fixId, ...out, approvalToken: rec.approval.token };
  },

  /** 丢弃（理由必填并落盘："不采纳"比"采纳"信息量大得多）。 */
  'fix.discard': ({ fixId, reason = '' } = {}) => {
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const pending = guardPendingCommit(rec); if (pending) return pending;
    if (rec.status === 'committed') return { ok: false, error: '已落地的工单不能丢弃，请用「回滚」' };
    rec.status = 'discarded';
    rec.decision = { ...(rec.decision || {}), verdict: 'reject', reason: String(reason).slice(0, 1000) || '（未填写理由）', decidedAt: Date.now() };
    writeRecord(root, fixId, rec);
    try {
      fs.rmSync(stagingDir(root, rec.id), { recursive: true, force: true });
    } catch { /* ignore */ }
    return { ok: true, fixId };
  },

  /** 删一笔审计（是否连删快照要显式指定）。 */
  'fix.delete': ({ fixId, deleteSnapshot = false } = {}) => deleteRecord(root, fixId, { deleteBackup: !!deleteSnapshot }),

  /** 批量清理（dryRun 先给预览）。 */
  'fix.prune': ({ before = 0, status = '', maxRecords = 0, dryRun = true } = {}) =>
    pruneRecords(root, { before: Number(before) || 0, status: String(status || ''), maxRecords: Number(maxRecords) || 0, dryRun: dryRun !== false }),

  /** 导出报告：Markdown（主产物）或 .docx（分发形态）。 */
  'fix.export': ({ fixId, format = 'md' } = {}) => {
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const preview = previewAll(rec.id, rec);
    const pack = buildEvidencePack({ root, rec, preview });
    pack.logs = grepLogs(logsDir, [rec?.target?.file, ...(rec?.proposal?.changes || []).map((c) => c.path), rec?.target?.ruleId].filter(Boolean), { maxFiles: 2, maxLines: 25 });
    const md = packToMarkdown(pack, rec.report || null);
    if (String(format) === 'docx') {
      return { ok: true, format: 'docx', filename: `修复报告-${rec.id}.docx`, buffer: buildDocx(md), markdown: md };
    }
    return { ok: true, format: 'md', filename: `修复报告-${rec.id}.md`, markdown: md };
  },

  /** 报告叙事化的 prompt（核心拿去调模型）。 */
  'fix.report-prompt': ({ fixId } = {}) => {
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const pack = buildEvidencePack({ root, rec, preview: previewAll(rec.id, rec) });
    const p = buildReportPrompt(pack);
    return { ok: true, sys: p.sys, user: p.user };
  },

  /** 存下模型写的叙事（导出时用）。 */
  'fix.report-save': ({ fixId, text } = {}) => {
    const rec = readRecord(root, fixId);
    if (!rec) return { ok: false, error: '工单不存在' };
    const parsed = parseReport(text);
    if (!parsed) return { ok: false, error: '报告叙事不是合法 JSON' };
    rec.report = parsed;
    writeRecord(root, fixId, rec);
    return { ok: true };
  }
};

// 自动修复的**行为层**：工单存储、暂存区、快照、落地、回滚、路径分级。
//
// ── 为什么独立成模块，而不是塞进 self-doctor ──
//   self-doctor 的清单与文件头都写死「全程只读，不写任何被检对象」，
//   把写能力塞进去会直接违背它自己的身份契约（而"扩展契约自洽"正是 self-doctor 自己查的东西）。
//   本项目约定每个扩展自包含、不跨插件 import。所以修复能力独立成 self-fix，
//   通过软依赖 api.capability('doctor.report' / 'doctor.scan-project') 取诊断信息。
//
// ── 红线（与 forge-tools.js 同构，方向是"写"）──
//   1. 所有写盘只落在 <DATA_DIR>/plugin-data/self-fix/ 之下（暂存区 / 快照 / 工单 / 沙箱）。
//      **只有 fix.commit 这一个函数**才允许把暂存区内容搬回真实路径，
//      且搬运前必须先落快照 + fsync。
//   2. 路径解析四道闸：语法干净 → 无 `..` / 绝对路径 → realpath 后仍在允许根内 → 后缀白名单。
//   3. 分级：L0 元部件一票否决（连人工都不能一键放行）。
//
// 这里拦得住"路径逃逸"，拦不住"改动本身有问题"：后者靠 checks.js 的协议闸 + 人工闸。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 内置基线重算：fix.commit / fix.rollback 动到内置模块目录时，把指纹刷新回
// builtin-modules.json（不管的话，下轮热重扫会把改动过的内置模块当"占名顶替"拦下）。
// 细节见 plugin-loader.js 的 refreshBuiltinEntry 注释。
import { refreshBuiltinEntry } from '../../plugin-loader.js';

// ── 允许写入的后缀 ────────────────────────────────────────────────────────
export const ALLOWED_EXT = /\.(js|mjs|cjs|json|md|txt|css|html|yml|yaml)$/i;

/**
 * L0「元部件」：一票否决，模型不得修改。
 *
 * 判据不是"重要"，而是**「模型若能改它，就等于改掉了约束本身」**：
 *   · 本模块自身（self-fix）：能改自己就能拆掉闸门与令牌校验；
 *   · 闸门（extension-forge/gate.js）与协议闸（checks.js）：规则本体；
 *   · 体检/取证（self-doctor）：能改它就能让"问题清单"失真；
 *   · 加载器沙箱与清单校验（plugin-loader.js）：能改它就能让写盘不受限；
 *   · 审计、备份、暂存目录：能改它们就能抹掉痕迹。
 */
// 四个开发工具链模块已内置化到 src/harness/（见 src/harness/index.js），
// `plugins/` 下的同名目录已删除。这份前缀表若继续写旧路径，L0 会**全部落空**：
// 模型可以改掉闸门本身，等于约束失效。改目录结构时这里必须同步。
export const L0_PREFIXES = [
  'src/harness/fix/',
  'src/harness/doctor/',
  'src/harness/forge/gate.js',
  'src/plugin-loader.js'
];

/** 凭据类路径：既不读也不写（P4）。 */
const CREDENTIAL_RE = /(^|\/)(account\.json|\.env|credentials?\.json)$|\.env$/i;

/**
 * 给一个项目内相对路径定级。
 * L0 元部件 / L1 核心 / L2 扩展 / L3 配置 / L4 本模块数据。
 */
export function classify(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  if (L0_PREFIXES.some((x) => p === x || p.startsWith(x))) return 'L0';
  if (/^plugin-data\/self-fix\//.test(p)) return 'L4';
  if (/^plugin-data\//.test(p)) return 'L3';
  if (/^(config|prices|version)\b/.test(p)) return 'L3';
  if (/^plugins\//.test(p) || /^skills\//.test(p)) return 'L2';
  if (/^(src|ui|electron)\//.test(p)) return 'L1';
  return 'L1';   // 其余一律按核心对待（从严）
}

/**
 * 「运行态用户数据」禁区（P5）。
 * 判据。这是**用户的资产**，不是程序的逻辑，改坏了不可逆，而且正确做法是走
 * 既有的迁移/导入通道（那些通道自带备份与回滚），不是让修复链路顺手改。
 */
export function isUserDataPath(rel) {
  const p = String(rel || '').replace(/\\/g, '/');
  return /^(chats|memory|sessions|archive|logs|import-backups|ui)\//.test(p);
}

// ── 路径与目录 ────────────────────────────────────────────────────────────
//
// 统一寻址：{ scope:'code'|'data', path:'...' }
//   code → appRoot 之内（src / ui / plugins / skills）
//   data → DATA_DIR 之内（config.json、plugin-data/**）

export function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function fixesDir(root) { return path.join(root, 'fixes'); }
export function stagingDir(root, id) { return path.join(root, 'staging', id); }
export function sandboxDir(root, id) { return path.join(root, 'sandbox', id); }
export function backupDir(root, id) { return path.join(root, 'backups', id); }

export function recordFile(root, id) { return path.join(fixesDir(root), `${sanitizeId(id)}.json`); }
export function verifyFile(root, id) { return path.join(fixesDir(root), `${sanitizeId(id)}.json`).replace(/\.json$/, '.verify.json'); }

export function sanitizeId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
  if (!s || s.includes('..')) return 'fix';
  return s.slice(0, 64);
}

export function newFixId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

export function newApprovalToken() {
  return crypto.randomBytes(12).toString('hex');
}

/**
 * 把一个 { scope, path } 解析成绝对路径，并做四道闸。
 * 返回 { ok, abs, scope, rel } 或 { ok:false, error }。
 */
export function resolveTarget(root, appRoot, dataRoot, target) {
  const scope = target?.scope === 'data' ? 'data' : 'code';
  const raw = String(target?.path || '').trim().replace(/\\/g, '/');
  if (!raw) return { ok: false, error: '路径为空' };
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) return { ok: false, error: '只接受相对路径' };
  if (raw.split('/').includes('..')) return { ok: false, error: '路径中不允许 ..' };
  if (/(^|\/)(node_modules|\.git)(\/|$)/.test(raw)) return { ok: false, error: '不允许触碰 node_modules / .git' };
  const abs0 = path.join(scope === 'code' ? appRoot : dataRoot, raw);

  // L0 一票否决发生在解析阶段：连暂存都不许，谈不上落地
  const level = classify(scope === 'code' ? raw : `plugin-data/${raw}`.replace(/^plugin-data\/plugin-data\//, 'plugin-data/'));
  if (level === 'L0') {
    return { ok: false, error: `L0 元部件禁止修改（${raw}）—— 模型若能改闸门/审计/加载器，等于约束失效`, level };
  }
  if (CREDENTIAL_RE.test(raw)) return { ok: false, error: `凭据类文件禁止读写（${raw}）`, level };
  if (scope === 'data' && isUserDataPath(raw.replace(/^plugin-data\//, ''))) {
    return { ok: false, error: `运行态用户数据禁止修改（${raw}）—— 请走既有的迁移/导入通道`, level };
  }
  if (!ALLOWED_EXT.test(raw)) return { ok: false, error: `后缀不允许（允许 ${ALLOWED_EXT}）`, level };

  // realpath：父目录可能被建成符号链接指向外面
  const probe = nearestExisting(abs0);
  if (probe) {
    let real, base;
    try { real = fs.realpathSync(probe); } catch { return { ok: false, error: '路径不存在' }; }
    try { base = fs.realpathSync(scope === 'code' ? appRoot : dataRoot); } catch { base = null; }
    if (base) {
      const r = path.relative(base, real);
      if (r.startsWith('..') || path.isAbsolute(r)) return { ok: false, error: '路径解析后越出允许根（疑似符号链接逃逸）' };
    }
  }
  return { ok: true, abs: abs0, scope, rel: raw, level };
}

function nearestExisting(abs) {
  let p = abs;
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(p)) return p;
    const up = path.dirname(p);
    if (up === p) return null;
    p = up;
  }
  return null;
}

/** 暂存区里一个目标文件的路径。 */
export function stagedPath(root, id, target) {
  const scope = target?.scope === 'data' ? 'data' : 'code';
  const raw = String(target?.path || '').replace(/\\/g, '/');
  return path.join(stagingDir(root, id), scope, ...raw.split('/').filter(Boolean));
}

/** 快照里一个原文件的路径。 */
export function backupPath(root, id, target) {
  const scope = target?.scope === 'data' ? 'data' : 'code';
  const raw = String(target?.path || '').replace(/\\/g, '/');
  return path.join(backupDir(root, id), scope, ...raw.split('/').filter(Boolean));
}

// ── 工单存储 ──────────────────────────────────────────────────────────────

export function readJsonSafe(f) {
  try {
    let t = fs.readFileSync(f, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch { return null; }
}

/** 原子写（tmp + rename），避免崩溃窗口写坏 JSON。 */
export function writeJsonAtomic(f, obj) {
  ensureDir(path.dirname(f));
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, f);
}

export function readRecord(root, id) {
  return readJsonSafe(recordFile(root, id));
}

export function writeRecord(root, id, rec) {
  rec.updatedAt = Date.now();
  writeJsonAtomic(recordFile(root, sanitizeId(id)), rec);
  return rec;
}

export function readVerify(root, id) { return readJsonSafe(verifyFile(root, id)); }
export function writeVerify(root, id, data) { writeJsonAtomic(verifyFile(root, id), data); }

/** 列出全部工单（新的在前）。损坏的文件跳过但不隐藏：计数里体现。 */
export function listRecords(root) {
  const dir = fixesDir(root);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { records: [], corrupt: 0 }; }
  const records = [];
  let corrupt = 0;
  for (const n of names) {
    if (!n.endsWith('.json') || n.endsWith('.verify.json')) continue;
    const rec = readJsonSafe(path.join(dir, n));
    if (!rec || !rec.id) { corrupt++; continue; }
    records.push(rec);
  }
  records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { records, corrupt };
}

/** 删除一笔审计。**不连删快照**：快照是回滚的唯一依据，要删必须显式指定。 */
export function deleteRecord(root, id, { deleteBackup = false } = {}) {
  const rec = readRecord(root, id);
  if (!rec) return { ok: false, error: '工单不存在' };
  if (rec.status === 'committed' && !deleteBackup) {
    // 允许删审计、保留快照：只删 json，把"仍有快照"这件事写进删除账本
  }
  try { fs.rmSync(recordFile(root, id), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(verifyFile(root, id), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(stagingDir(root, id), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(sandboxDir(root, id), { recursive: true, force: true }); } catch { /* ignore */ }
  if (deleteBackup) {
    try { fs.rmSync(backupDir(root, id), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  // 删除动作本身也要记账，否则"审计被谁清了"无从追溯（审计系统的全部意义就是可追溯）
  try {
    ensureDir(fixesDir(root));
    fs.appendFileSync(path.join(root, 'fixes', '_deleted.log'),
      `${new Date().toISOString()}  delete  ${rec.id}  status=${rec.status}  snapshot=${deleteBackup ? 'removed' : 'kept'}  target=${rec?.target?.path || '?'}\n`,
      'utf8');
  } catch { /* ignore */ }
  return { ok: true, snapshotRemoved: !!deleteBackup };
}

/**
 * 按条件清理（dryRun 先给预览）。
 * 只自动清「未落地」的记录；committed 记录不自动删（快照还在，回滚能力要保住）。
 */
export function pruneRecords(root, { before = 0, status = '', maxRecords = 0, dryRun = false } = {}) {
  const { records } = listRecords(root);
  const doomed = [];
  // ① 按时间
  if (before > 0) {
    for (const r of records) {
      if (r.status === 'committed') continue;
      if ((r.createdAt || 0) < before) doomed.push(r);
    }
  }
  // ② 按状态
  if (status) {
    for (const r of records) {
      if (r.status === 'committed') continue;
      if (r.status === status && !doomed.includes(r)) doomed.push(r);
    }
  }
  // ③ 按条数（最旧的未落地记录优先）
  if (maxRecords > 0 && records.length > maxRecords) {
    const overflow = records.length - maxRecords;
    const pool = records.filter((r) => r.status !== 'committed' && !doomed.includes(r))
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (let i = 0; i < overflow && i < pool.length; i++) doomed.push(pool[i]);
  }
  if (dryRun) return { ok: true, dryRun: true, removed: doomed.length, ids: doomed.map((r) => r.id), kept: records.length - doomed.length };
  for (const r of doomed) deleteRecord(root, r.id, { deleteBackup: false });
  return { ok: true, dryRun: false, removed: doomed.length, ids: doomed.map((r) => r.id), kept: records.length - doomed.length };
}

// ── 文本比较（最小改动判定 / diff 展示）────────────────────────────────────

/** 多集差：返回 { added, removed } 行数（忽略纯空行差异的噪声）。 */
export function diffStat(oldText, newText) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  const count = (arr) => {
    const m = new Map();
    for (const l of arr) m.set(l, (m.get(l) || 0) + 1);
    return m;
  };
  const ma = count(a), mb = count(b);
  let added = 0, removed = 0;
  for (const [l, n] of mb) { const k = ma.get(l) || 0; if (n > k) added += n - k; }
  for (const [l, n] of ma) { const k = mb.get(l) || 0; if (n > k) removed += n - k; }
  return { added, removed, changed: added + removed, oldLines: a.length, newLines: b.length };
}

/** 生成可供 UI 展示的极简行级 diff（共同前后缀 + 中间块整体标注）。 */
export function simpleDiff(oldText, newText, ctx = 2) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head &&
         a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out = [];
  const from = Math.max(0, head - ctx);
  for (let i = from; i < head; i++) out.push({ t: ' ', n: i + 1, s: a[i] });
  for (let i = head; i < a.length - tail; i++) out.push({ t: '-', n: i + 1, s: a[i] });
  for (let i = head; i < b.length - tail; i++) out.push({ t: '+', n: i + 1, s: b[i] });
  const toEnd = Math.min(a.length, a.length - tail + ctx);
  for (let i = a.length - tail; i < toEnd; i++) out.push({ t: ' ', n: i + 1, s: a[i] });
  return out;
}

export function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
}

/**
 * 把"本次落地 / 回滚触碰到的模块目录"里属于内置模块的那些，重算一遍基线指纹。
 * 只认 plugins/ 与 skills/ 下的一级目录（src/、ui/ 这些不在基线清单里，自然跳过）。
 * @returns {Array<{dir:string, files:number}>}：给上层记日志 / 测试断言用
 */
function refreshTouchedBuiltins(paths, appRoot) {
  const out = [];
  const dirs = new Set();
  for (const p of paths) {
    const m = /^(?:plugins|skills)\/([^/]+)\//.exec(String(p || '').replace(/\\/g, '/'));
    if (m) dirs.add(m[1]);
  }
  for (const d of dirs) {
    try {
      const r = refreshBuiltinEntry(d, { appRoot });
      if (r.ok && r.updated) out.push({ dir: d, files: r.files });
    } catch { /* 基线刷新失败不阻断落地：下一次热重扫会给出（改进后的）一致提示 */ }
  }
  return out;
}

// ── 快照 / 落地 / 回滚 ───────────────────────────────────────────────────

/**
 * 落地：**先快照，再写真实文件**。
 * 顺序不能反：反了的话崩溃窗口会留下"改了一半且无法回滚"的状态。
 * 返回 { ok, files:[{scope,path,backupRel,hash,isNew}], error? }。
 */
export function commit(root, id, appRoot, dataRoot, rec) {
  const changes = rec?.proposal?.changes || [];
  if (!changes.length) return { ok: false, error: '没有改动可落地' };
  const files = [];
  // ① 全部快照先落盘
  for (const c of changes) {
    const r = resolveTarget(root, appRoot, dataRoot, c);
    if (!r.ok) return { ok: false, error: `快照前解析失败：${r.error}` };
    const st = stagedPath(root, id, c);
    if (!fs.existsSync(st)) return { ok: false, error: `暂存区缺少文件：${c.path}（请先 apply）` };
    const exists = fs.existsSync(r.abs);
    const backupRel = backupPath(root, id, c);
    try {
      if (exists) {
        ensureDir(path.dirname(backupRel));
        const buf = fs.readFileSync(r.abs);
        fs.writeFileSync(backupRel, buf);
        const fd = fs.openSync(backupRel, 'r');
        try { fs.fsyncSync(fd); } catch { /* 某些平台不支持，忽略 */ }
        fs.closeSync(fd);
      }
    } catch (e) {
      return { ok: false, error: `快照失败：${c.path} —— ${e.message}` };
    }
    files.push({
      scope: r.scope, path: r.rel, level: r.level,
      backupRel: exists ? path.relative(root, backupRel).replace(/\\/g, '/') : null,
      hash: exists ? sha1(fs.readFileSync(r.abs, 'utf8')) : null,
      isNew: !exists
    });
  }
  // ② 快照齐了才写真实文件
  for (let i = 0; i < changes.length; i++) {
    const r = resolveTarget(root, appRoot, dataRoot, changes[i]);
    if (!r.ok) return { ok: false, error: r.error };
    const st = stagedPath(root, id, changes[i]);
    try {
      ensureDir(path.dirname(r.abs));
      fs.copyFileSync(st, r.abs);
    } catch (e) {
      return { ok: false, error: `写盘失败：${changes[i].path} —— ${e.message}（快照已留，可回滚）` };
    }
  }
  // ③ 改动落在内置模块目录里 → 即时重算基线指纹（见文件头 import 处的注释）。
  const baseline = refreshTouchedBuiltins(files.map((f) => f.path), appRoot);
  return { ok: true, files, baseline };
}

/** 回滚：把快照写回；快照里没有的（新增文件）就删掉。 */
export function rollback(root, id, appRoot, dataRoot, rec) {
  const snap = rec?.snapshot?.files || [];
  if (!snap.length) return { ok: false, error: '这个工单没有快照，无法回滚' };
  if (typeof id !== 'string' || id !== sanitizeId(id)) return { ok: false, error: '非法工单 id' };
  const plans = [];
  try {
    const boundary = path.resolve(backupDir(root, id));
    for (const f of snap) {
      const r = resolveTarget(root, appRoot, dataRoot, { scope: f.scope, path: f.path });
      if (!r.ok) throw new Error(r.error);
      let source = null;
      if (!f.isNew) {
        if (typeof f.backupRel !== 'string' || !f.backupRel) throw new Error(`快照缺失：${f.path}`);
        source = path.resolve(root, f.backupRel);
        const relative = path.relative(boundary, source);
        if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          throw new Error('快照源越出本工单备份目录');
        }
        let cursor = path.resolve(root);
        for (const part of path.relative(cursor, source).split(path.sep)) {
          cursor = path.join(cursor, part);
          if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('快照源不能包含符号链接或目录联接');
        }
        if (!fs.statSync(source).isFile()) throw new Error(`快照不是文件：${f.backupRel}`);
      }
      plans.push({ f, r, source });
    }
  } catch (error) { return { ok: false, error: `回滚预检失败：${error.message}` }; }
  const restored = [], removed = [];
  for (const { f, r, source } of plans) {
    if (f.isNew) {
      try { fs.rmSync(r.abs, { force: true }); removed.push(f.path); }
      catch (error) { return { ok: false, error: `回滚删除失败：${f.path} —— ${error.message}` }; }
      continue;
    }
    try {
      ensureDir(path.dirname(r.abs));
      fs.copyFileSync(source, r.abs);
      restored.push(f.path);
    } catch (e) {
      return { ok: false, error: `回滚失败：${f.path} —— ${e.message}` };
    }
  }
  // 回滚把文件换回旧版本：基线若在落地时重算过，这里要同步重算回来。
  const baseline = refreshTouchedBuiltins(snap.map((f) => f.path), appRoot);
  return { ok: true, restored, removed, baseline };
}

/** 单文件预览：改动前 / 改动后（从快照与暂存区读）。 */
export function previewChange(root, id, change, appRoot, dataRoot) {
  const r = resolveTarget(root, appRoot, dataRoot, change);
  const st = stagedPath(root, id, change);
  const b = backupPath(root, id, change);
  const readMaybe = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
  const after = readMaybe(st);
  const before = readMaybe(b) ?? (r.ok ? readMaybe(r.abs) : null);
  return { before, after, stat: diffStat(before ?? '', after ?? '') };
}

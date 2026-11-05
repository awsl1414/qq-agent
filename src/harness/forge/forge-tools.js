// 自创扩展的**暂存区写盘层**：模型把草稿写在这里，确认后才搬进 skills//plugins/。
//
// ── 为什么必须有暂存区 ──
//   plugins/ 与 skills/ 目录被 fs.watch 递归监听（plugin-loader.js watchPlugins），
//   写进去 500ms 后就会被当成正式扩展加载执行。也就是说：**直接往那两个目录写文件
//   = 让模型生成的代码立刻在本进程里跑起来**。暂存区把"生成"与"生效"隔开，
//   中间插进闸门与人工确认。
//
// ── 安全边界（与 doctor-tools.js 同构，但方向相反：这里是**写**）──
//   1. **四道闸**：语法干净 → 落在暂存目录内 → realpath 后仍在暂存内（防符号链接逃逸）
//      → 后缀白名单。
//   2. **只碰暂存区**。本文件所有路径解析都以 stagingRoot 为根，
//      `..`/绝对路径/node_modules 一律拒。它**没有**任何通往 plugins/ 的写通道：
//      搬运是 index.js 里 forge.install 的职责，且只搬闸门放行过的草稿。
//   3. **限额**：文件数、单文件字节、总体积三重上限（见 plugin.json 的 settings）。
//
// 这里拦得住"路径逃逸"，拦不住"生成的代码本身干坏事"：
// 后者靠 gate.js 的静态危险扫描 + 人工确认。三层防线各管一段，缺一不可。

import fs from 'node:fs';
import path from 'node:path';

/** 草稿允许的后缀。扩展本体是 .js/.json，其余是给文档与资源留的口子。 */
export const ALLOWED_EXT = /\.(js|mjs|cjs|json|md|txt|css|html)$/i;

/** 即便在暂存区内也不该出现的（模型爱顺手写这些）。 */
const FORBIDDEN_PATH = /(^|\/)(node_modules|\.git|\.env)(\/|$)|\.env$/i;

/** 默认限额（会被 plugin.json 的 settings 覆盖）。 */
export const DEFAULT_LIMITS = {
  maxFiles: 20,
  maxFileBytes: 262144,      // 256KB
  maxTotalBytes: 1048576     // 1MB
};

/**
 * zip 导入时的条目数上限。**独立于 maxFiles(20)**：
 * maxFiles 管的是"模型生成草稿时别跑飞"（写盘时按文件拦），
 * 而这里面对的是**别人打的包**：27 个文件的正常扩展不该在读取阶段就被拒。
 */
export const ZIP_MAX_ENTRIES = 600;

/**
 * 暂存区根目录：<DATA_DIR>/plugin-data/extension-forge/staging
 * 必须在 plugin-data 下，不能放 plugins/（那是 fs.watch 监听范围，写进去就被当扩展加载）。
 */
export function stagingRoot(ctx) {
  return path.join(ctx.dataRoot, 'plugin-data', 'extension-forge', 'staging');
}

/** 一个草稿的目录：staging/<draftId>/ */
export function draftDir(ctx, draftId) {
  return path.join(stagingRoot(ctx), sanitizeDraftId(draftId));
}

/** 草稿 id 只允许安全字符，它会成为目录名。 */
export function sanitizeDraftId(id) {
  const s = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '');
  return s.slice(0, 64) || 'draft';
}

/** 生成一个新草稿 id（时间序 + 随机后缀，便于人工按名字排序辨认）。 */
export function newDraftId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${ts}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 把草稿内的相对路径解析成绝对路径，并做四道校验。
 * 任一条不过 → { ok:false, error }。
 */
export function resolveDraftPath(ctx, draftId, rel) {
  const raw = String(rel || '').trim().replace(/\\/g, '/');
  if (!raw) return { ok: false, error: '路径为空' };
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
    return { ok: false, error: '只接受草稿目录内的相对路径（不接受绝对路径）' };
  }
  if (raw.split('/').includes('..')) return { ok: false, error: '路径中不允许 ..' };
  if (FORBIDDEN_PATH.test(raw)) return { ok: false, error: '该路径不在可写范围（敏感或第三方目录）' };
  if (!ALLOWED_EXT.test(raw)) {
    return { ok: false, error: `后缀不允许（允许：js/mjs/cjs/json/md/txt/css/html）` };
  }

  const base = draftDir(ctx, draftId);
  const abs = path.join(base, ...raw.split('/'));

  // realpath 校验：父目录可能已被建成符号链接指向外面。
  // 目录还不存在时（首次写），退到最近的存在祖先上校验，否则新草稿第一次写必然失败。
  const probe = nearestExisting(abs);
  if (probe) {
    let realProbe, realBase;
    try { realProbe = fs.realpathSync(probe); } catch { return { ok: false, error: '路径不存在' }; }
    try { realBase = fs.realpathSync(base); } catch { realBase = null; }
    if (realBase) {
      const r = path.relative(realBase, realProbe);
      if (r.startsWith('..') || path.isAbsolute(r)) {
        return { ok: false, error: '路径解析后越出草稿目录（疑似符号链接逃逸）' };
      }
    }
  }
  return { ok: true, abs, rel: raw };
}

/** 从 abs 往上找到第一个存在的祖先（用于 realpath 校验）。 */
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

/** 统计一个草稿的当前状态（文件数 / 各文件大小 / 总体积）。 */
export function draftStats(ctx, draftId) {
  const base = draftDir(ctx, draftId);
  const files = [];
  let total = 0;
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      const rel = path.relative(base, fp).replace(/\\/g, '/');
      files.push({ path: rel, bytes: st.size });
      total += st.size;
    }
  };
  walk(base, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, count: files.length, total, exists: fs.existsSync(base) };
}

// ── 工具实现：(ctx, args)，与 src/tools.js 的 executeTool 约定一致 ──────────
//
// 参数顺序是 (ctx, args)，不是 (args, ctx)。写反了不会报错、只会拿到 undefined。
//
// 各工具里 `ctx.draftId || args.draft_id` 的优先级也是 **ctx 优先**：
//   ctx.draftId 由调用方（routes）在发起时固定，是「这次操作只准动这个草稿」的约定；
//   args.draft_id 则是模型自己填的参数。若让它优先，模型只要多传一个 draft_id
//   就能把写入重定向到**另一个草稿**（仍在暂存区内，逃不出去，但会悄悄改坏别的东西）。
//   工具 schema 里本来就没暴露 draft_id，所以正常调用永远走 ctx 这一支；
//   保留 args 兜底只是让本文件能被直接调用（测试/未来复用），不改变优先级。

/** 写一个文件（覆盖写）。 */
export function writeFileTool(ctx, args) {
  const draftId = ctx.draftId || args.draft_id;
  if (!draftId) return { content: '缺少 draft_id', isError: true };
  const r = resolveDraftPath(ctx, draftId, args.path);
  if (!r.ok) return { content: `写入被拒：${r.error}`, isError: true };

  const content = String(args.content ?? '');
  const bytes = Buffer.byteLength(content, 'utf8');
  const lim = { ...DEFAULT_LIMITS, ...(ctx.limits || {}) };
  if (bytes > lim.maxFileBytes) {
    return { content: `写入被拒：单文件 ${(bytes / 1024).toFixed(0)}KB 超过上限 ${(lim.maxFileBytes / 1024).toFixed(0)}KB`, isError: true };
  }

  const cur = draftStats(ctx, draftId);
  const isNew = !cur.files.some((f) => f.path === r.rel);
  if (isNew && cur.count + 1 > lim.maxFiles) {
    return { content: `写入被拒：草稿文件数已达上限 ${lim.maxFiles}`, isError: true };
  }
  const prevBytes = cur.files.find((f) => f.path === r.rel)?.bytes || 0;
  if (cur.total - prevBytes + bytes > lim.maxTotalBytes) {
    return { content: `写入被拒：草稿总体积超过上限 ${(lim.maxTotalBytes / 1024 / 1024).toFixed(1)}MB`, isError: true };
  }

  try {
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    fs.writeFileSync(r.abs, content, 'utf8');
  } catch (e) {
    return { content: `写盘失败：${e.message}`, isError: true };
  }
  const after = draftStats(ctx, draftId);
  return {
    content: `已写入 ${r.rel}（${bytes}B）。草稿现有 ${after.count} 个文件 / 共 ${(after.total / 1024).toFixed(1)}KB。`
  };
}

/**
 * 分页读取的默认行数与单页硬上限。
 *
 * 为什么必须分页而不是把上限调大：市场里的真实技能有 918 行的 index.js，
 * 下一个可能 2000 行。只要"一次把整个文件塞回模型"这个前提还在，
 * 任何固定上限都会在更大的文件上重演"反复读 8 次也拿不到中间段"。
 * 分页把"读不完"变成可续读的确定性行为：每次明确告诉模型还剩多少行、
 * 下次该用哪个 offset。
 */
export const READ_PAGE_DEFAULT_LINES = 400;
export const READ_PAGE_MAX_LINES = 800;

/** 把模型给的数字参数归一成 >=1 的整数；缺失/非法时取默认值。 */
function positiveInt(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** 按行切分；结尾换行不额外算一行（918 行 + 结尾 \n 的 split 结果是 919 项）。 */
function splitLines(text) {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 读回一个文件（带行号 + 分页信息，便于模型自查）。
 *
 * 返回头部固定写清「共 N 行 / 本次显示 a–b」，末尾写清还剩多少行、
 * 下一次该用哪个 offset：模型据此知道"不是我读不到，而是该续读了"，
 * 否则它只会用同样的参数反复重读（实战里连读 8 次都是前 400 行）。
 */
export function readFileTool(ctx, args) {
  const draftId = ctx.draftId || args.draft_id;
  const r = resolveDraftPath(ctx, draftId, args.path);
  if (!r.ok) return { content: `读取被拒：${r.error}`, isError: true };
  let text;
  try { text = fs.readFileSync(r.abs, 'utf8'); }
  catch { return { content: `文件不存在：${r.rel}`, isError: true }; }

  const lines = splitLines(text);
  const total = lines.length;
  if (!total) return { content: `${r.rel}（空文件）` };

  const offset = positiveInt(args.offset, 1);
  const limit = Math.min(positiveInt(args.limit, READ_PAGE_DEFAULT_LINES), READ_PAGE_MAX_LINES);
  if (offset > total) {
    return {
      content: `${r.rel}（共 ${total} 行）\n起始行 ${offset} 已超出文件末尾 —— 用 offset=1 从头读，或 offset=${total} 读最后一行。`
    };
  }

  const start = offset;
  const end = Math.min(total, start + limit - 1);
  const body = lines.slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(4)}| ${l}`)
    .join('\n');

  const head = end - start + 1 < total || start > 1
    ? `${r.rel}（共 ${total} 行，本次显示 ${start}–${end}）`
    : `${r.rel}（共 ${total} 行）`;
  const rest = total - end;
  const foot = rest > 0
    ? `\n（还有 ${rest} 行未显示，用 offset=${end + 1} 继续读）`
    : '';
  return { content: `${head}\n${body}${foot}` };
}

/** 列出草稿里的文件。 */
export function listFilesTool(ctx, args) {
  const draftId = ctx.draftId || args.draft_id;
  if (!draftId) return { content: '缺少 draft_id', isError: true };
  const s = draftStats(ctx, draftId);
  if (!s.exists || !s.count) return { content: '（草稿还是空的）' };
  const list = s.files.map((f) => `  ${f.path}  ${(f.bytes / 1024).toFixed(1)}KB`).join('\n');
  return { content: `${s.count} 个文件 / 共 ${(s.total / 1024).toFixed(1)}KB：\n${list}` };
}

/** 删掉草稿里的一个文件（模型改主意时用）。 */
export function deleteFileTool(ctx, args) {
  const draftId = ctx.draftId || args.draft_id;
  const r = resolveDraftPath(ctx, draftId, args.path);
  if (!r.ok) return { content: `删除被拒：${r.error}`, isError: true };
  try { fs.unlinkSync(r.abs); }
  catch { return { content: `文件不存在：${r.rel}`, isError: true }; }
  return { content: `已删除 ${r.rel}。` };
}

/** 清空整个草稿目录（重新来过）。 */
export function clearDraft(ctx, draftId) {
  const base = draftDir(ctx, draftId);
  try { fs.rmSync(base, { recursive: true, force: true }); return true; }
  catch { return false; }
}

// ── 从外部 zip 解包到暂存区 ───────────────────────────────────────────────
//
// 用途：把"别人发来的扩展包"读进来，之后由模型适配、用户确认后安装。
//
// 解到**暂存区**而不是直接 unzipToModuleDir：
//    zip-install.js 那条路是"校验后直接落 skills//plugins/"，落地即被执行。
//    第三方包必须先能被人看过、改过、确认过，所以只能落到暂存区。
//
// ── 与 parseZip 的分工 ──
//   parseZip（src/zip-install.js）不只是解压，它**自带两项安全校验**并且
//   **整包拒绝**（throw，不逐条跳过）：
//     · 绝对路径 或 含 `..` → 抛错
//     · 禁用后缀（.exe/.dll/.bat/.cmd/.ps1/.vbs/.sh）→ 抛错
//     目录条目（以 / 结尾）由它直接跳过。
//   所以"一个包里混了个 setup.sh"的结局是**整个包被拒**，而不是悄悄扔掉那个文件。
//   这是刻意的：与市场安装路径保持同一把尺子，不给导入开更松的口子。
//   我们**不弱化它**：拒绝时把 parseZip 的原话（它点名了是哪个条目）透给用户。
//
//   本文件这一层负责 parseZip **不管**的那些：
//     · mac 打包垃圾（__MACOSX / .DS_Store / Thumbs.db）
//     · 单文件与总体积超限
//     · 剥掉统一根目录（包名/）
//     · 每个条目再走一次 resolveDraftPath（四道闸）：纵深防御，不依赖上游

/**
 * zip 解包时条目被丢弃的原因。
 *
 * 必须**结构化**而不是一段中文：前端要据此决定怎么提示（体积超限是"这个包可能
 * 装不全，多半用不了"，其余是打包杂质，基本无害），而拼在字符串里的原因只能整段
 * 原样展示。实测事故：1.5MB 的 lib/dict.json 被静默丢掉，响应仍是 ok:true，
 * 用户装完才发现"少了文件"，却没有任何地方能查到少了什么、为什么少。
 *
 * FILE_TOO_LARGE / TOTAL_TOO_LARGE 意味着**包不完整、多半跑不起来**，界面必须醒目提示；
 * 其余是打包杂质或本来就该丢的条目。前端是普通脚本（不能 import 本模块），
 * ui/app/13-doctor.js 的 FORGE_SKIP_REASON / FORGE_SKIP_SIZE_REASONS 是它的镜像 ——
 * 增删原因时两处一起改。
 *
 * 总量上限触发后，剩余条目**逐个按同一判据**重新分类（见 extractZipToDraft 的
 * classifyEntry）：只有本可解出、被总量挡下的才记 TOTAL_TOO_LARGE，打包垃圾与
 * 越界路径仍按各自原因记账 —— 否则"体积超限未解出"的红框会被垃圾文件撑大。
 */
export const SKIP_REASONS = {
  OUTSIDE_ROOT: 'outside-module-root',   // 不在清单所在的模块根下（根级 README / 外层文件夹）
  DIRECTORY: 'directory-entry',          // 目录条目（解包只处理文件）
  PACKAGING_JUNK: 'packaging-junk',      // __MACOSX / .DS_Store / Thumbs.db
  PATH_REJECTED: 'path-rejected',        // 没通过草稿路径闸（后缀 / 越界 / 敏感路径）
  FILE_TOO_LARGE: 'single-file-too-large',
  TOTAL_TOO_LARGE: 'total-too-large',
  WRITE_FAILED: 'write-failed'
};

/**
 * 把 zip 内容解到指定草稿。
 * @param {object} ctx
 * @param {string} draftId
 * @param {Buffer} buffer zip 字节
 * @param {(buf: Buffer) => Array<{name:string,data:Buffer}>} parseZip 注入的解析器（含安全校验）
 * @returns {{ok:boolean, error?:string, rejected?:boolean, files:string[],
 *   skipped: Array<{path:string,size:number,reason:string}>, kind?:string}}
 *   skipped 的每一条都带原因，前端据此提示"哪些文件没解出来、为什么"。
 */
export function extractZipToDraft(ctx, draftId, buffer, parseZip) {
  let entries;
  try {
    entries = parseZip(buffer);
  } catch (e) {
    // rejected=true。这是**安全校验**拒绝（非法路径 / 禁用后缀），不是"文件坏了"。
    // 前端据此给出不同的提示：前者是"这个包有问题"，后者是"这个包读不了"。
    //
    // 判定方式是按文案前缀匹配，与 zip-install.js 里那两条消息耦合。
    // 为什么仍这么做：parseZip 把"安全校验"和"结构解析"混在一个函数里抛错，
    // 没有可用的结构化区分。匹配失手的**唯一后果是提示语不够准确**：ok:false
    // 这条结论不受影响，安全判定永远由 parseZip 决定。
    const msg = String(e?.message || e);
    const isSecurity = /^安装包包含/.test(msg);
    return { ok: false, rejected: isSecurity, error: msg, files: [], skipped: [] };
  }
  if (!entries.length) return { ok: false, error: 'zip 是空的（里面没有文件）', files: [], skipped: [] };

  const lim = { ...DEFAULT_LIMITS, ...(ctx.limits || {}) };
  // 这里的上限必须**独立于** maxFiles(20)：maxFiles 是"模型生成时别跑飞"的写盘上限，
  // 而 zip 导入是"别人打的包"：27 个文件的正常包不该在读取阶段就被拒。
  // 用 `lim.maxFiles * 3`(=60) 会让稍大一点的包直接读不进来。
  if (entries.length > ZIP_MAX_ENTRIES) {
    // 先粗筛：条目数远超上限说明这多半不是一个小扩展
    return { ok: false, error: `zip 里有 ${entries.length} 个条目，远超上限（${ZIP_MAX_ENTRIES}）`, files: [], skipped: [] };
  }

  // ── 定位模块根：以**清单文件**为锚，把它上面的所有层级剥掉 ──────────────────
  //
  // 只认"所有条目共享同一个第一段"这一种形态（`names.every(...)`）是不够的：
  //   只要包里混进一个根级杂物：macOS 打包的 `__MACOSX/`、作者顺手放进去的
  //   README、.gitignore：every() 立刻为 false，整层不剥，清单就落在
  //   `<草稿>/reply-meme/skill.json`；而结构闸只在**草稿根**找 skill.json /
  //   plugin.json → 直接判"缺少清单"，这个包永远装不上。
  // 现在按清单所在目录定根：嵌套多深剥多深，与 zip-install.unzipToModuleDir 同口径。
  const names = entries.map((e) => String(e.name || '').replace(/\\/g, '/'));
  let prefix = '';
  {
    // 与闸门同序：skill.json 优先，其次 plugin.json；取**最浅**的那个
    // （包子目录里的示例清单不配当模块根）。
    let best = null;
    for (const want of ['skill.json', 'plugin.json']) {
      for (const n of names) {
        if (n !== want && !n.endsWith('/' + want)) continue;
        const depth = n.split('/').length - 1;
        if (!best || depth < best.depth) best = { n, depth };
      }
      if (best) break;
    }
    if (best) {
      prefix = best.depth > 0 ? best.n.split('/').slice(0, best.depth).join('/') + '/' : '';
    } else {
      // 没有清单：退回"剥统一根目录"，但判定时先排除已知垃圾：
      // 否则一个 __MACOSX/ 就让整包结构错位，而真正的错误会以"缺少清单"呈现，
      // 把排查方向带偏（用户以为包坏了，其实是解包路径错了）。
      const clean = names.filter((n) => !/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(n));
      const firstSeg = clean[0]?.split('/')[0];
      if (firstSeg && clean.every((n) => n === firstSeg || n.startsWith(firstSeg + '/'))) {
        prefix = firstSeg + '/';
      }
    }
  }

  const files = [];
  const skipped = [];
  let totalBytes = 0;
  /** 记一条跳过项：path 用**包内原始名**（用户要在自己的 zip 里找得到它）。 */
  const skipEntry = (i, reason, detail = '') => {
    skipped.push({
      path: names[i],
      size: Number(entries[i]?.data?.length) || 0,
      reason,
      ...(detail ? { detail: String(detail) } : {})
    });
  };

  /**
   * 单个条目的分类判据：返回 `{ reason, detail }` 表示该跳过，返回
   * `{ rel, abs, data }` 表示可解。
   *
   * 主循环与"总量耗尽之后"的剩余条目**共用这一份**，不能再各自写一套：
   * 之前剩余条目只区分目录、其余一律记 TOTAL_TOO_LARGE，于是 `__MACOSX/._x.js`
   * 与根级 `README.md` 也被算进"因体积超限未解出"，界面上那条红色告警
   * （"这个技能可能无法正常工作"）被打包垃圾撑大，夸大了残缺程度。
   *
   * 判据顺序即语义优先级：打包垃圾先认（它在包里哪个位置都是垃圾），
   * 再判模块根越界，再判目录 / 路径闸 / 单文件体积。
   */
  const classifyEntry = (i) => {
    // mac 打包垃圾会原样出现在 zip 里（parseZip 不管这个），这里丢掉
    if (/(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db)(\/|$)/i.test(names[i])) {
      return { reason: SKIP_REASONS.PACKAGING_JUNK };
    }
    // 模块根之外的条目（根级 README / 作者套的外层文件夹）一律丢弃。
    // 必须"不在 prefix 下就跳过"，不能一律 slice(prefix.length)：
    // `__MACOSX/._index.js` 切掉同样长度会得到 `index.js`，凭空写出一份假入口。
    if (prefix && !names[i].startsWith(prefix)) return { reason: SKIP_REASONS.OUTSIDE_ROOT };
    const rel = names[i].slice(prefix.length);
    // 目录条目 parseZip 已滤掉，这里兜一层（剥根目录后可能剩下空串）
    if (!rel || rel.endsWith('/')) return { reason: SKIP_REASONS.DIRECTORY };

    // 纵深防御：parseZip 已查过非法路径与禁用后缀，这里再走一遍本文件的四道闸。
    // 不依赖上游：上游改了校验规则不该导致这里变松。
    const r = resolveDraftPath(ctx, draftId, rel);
    if (!r.ok) return { reason: SKIP_REASONS.PATH_REJECTED, detail: r.error };

    const data = entries[i].data;
    if (data.length > lim.maxFileBytes) return { reason: SKIP_REASONS.FILE_TOO_LARGE };
    return { rel, abs: r.abs, data };
  };

  for (let i = 0; i < entries.length; i++) {
    const c = classifyEntry(i);
    if (c.reason) { skipEntry(i, c.reason, c.detail); continue; }

    if (totalBytes + c.data.length > lim.maxTotalBytes) {
      // 到这里就不能再解了，但**后续条目同样"没解出来"**：不记账的话用户会以为
      // 包里只有这几项，装完发现功能缺失却无从查起。逐个按同一判据记原因，
      // 只有真正"本来能解、被总量挡下"的条目才记 TOTAL_TOO_LARGE。
      for (let j = i; j < entries.length; j++) {
        const cj = classifyEntry(j);
        skipEntry(j, cj.reason || SKIP_REASONS.TOTAL_TOO_LARGE, cj.detail);
      }
      break;
    }

    try {
      fs.mkdirSync(path.dirname(c.abs), { recursive: true });
      fs.writeFileSync(c.abs, c.data);
      files.push(c.rel);
      totalBytes += c.data.length;
    } catch (e) {
      skipEntry(i, SKIP_REASONS.WRITE_FAILED, e.message);
    }
  }

  if (!files.length) {
    return {
      ok: false,
      error: 'zip 里没有任何可用的扩展文件（可能全是目录、mac 打包垃圾，或体积超限）',
      files: [], skipped
    };
  }

  // 判类型：有 skill.json → 技能；否则 plugin.json → 插件
  const has = (n) => files.includes(n);
  const kind = has('skill.json') ? 'skill' : (has('plugin.json') ? 'plugin' : null);
  return { ok: true, files, skipped, kind };
}

// ── 工具清单（给模型看的 schema）────────────────────────────────────────────

export const FORGE_TOOLS = [
  {
    id: 'forge_write_file',
    name: '写草稿文件',
    description: '把内容写进当前草稿（可覆盖）。path 是草稿内的相对路径，如 skill.json 或 index.js。'
      + '只允许写 .js/.json/.md/.txt/.css/.html。所有写入都关在暂存区里，不会影响正在运行的系统。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '草稿内相对路径，如 index.js' },
        content: { type: 'string', description: '文件的完整内容' }
      },
      required: ['path', 'content']
    },
    execute: writeFileTool
  },
  {
    id: 'forge_read_file',
    name: '读草稿文件',
    description: '读回自己刚写的文件（带行号）。改之前先读一遍，避免漏掉已有内容。'
      + `大文件分段读：一次最多回 ${READ_PAGE_DEFAULT_LINES} 行，返回头部会写「共 N 行，本次显示 a–b」，`
      + '末尾会写还剩多少行、下次该用哪个 offset —— 看到"还有 N 行未显示"就接着读，'
      + `不要用同样的参数反复读（那样永远只能拿到前 ${READ_PAGE_DEFAULT_LINES} 行）。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '草稿内相对路径' },
        offset: { type: 'number', description: '起始行号（1 起），不填从头开始' },
        limit: { type: 'number', description: `本次读取行数，默认 ${READ_PAGE_DEFAULT_LINES}，上限 ${READ_PAGE_MAX_LINES}` }
      },
      required: ['path']
    },
    execute: readFileTool
  },
  {
    id: 'forge_list_files',
    name: '列草稿文件',
    description: '列出当前草稿里的所有文件与体积。',
    parameters: { type: 'object', properties: {} },
    execute: listFilesTool
  },
  {
    id: 'forge_delete_file',
    name: '删草稿文件',
    description: '删除草稿里的一个文件（写错了要重来时用）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '草稿内相对路径' } },
      required: ['path']
    },
    execute: deleteFileTool
  }
];

/** 转成 OpenAI function 定义。 */
export function toOpenAiTools(defs = FORGE_TOOLS) {
  return defs.map((d) => ({
    type: 'function',
    function: { name: d.id, description: d.description, parameters: d.parameters }
  }));
}

/** zip 解压安装：把市场下载的安装包安全地落到 skills/ 或 plugins/ 目录。
 *
 * 独立成模块的原因：这段是"往磁盘写可执行 JS"的入口，安全边界必须集中、可单测。
 * 与 server/community_app.py 的 validate_zip 规则对齐（那里上传时校验一次，
 * 这里安装前再校验一次，不信任任何传输环节）。
 *
 * 目录名冲突口径（2026-11 统一）：**同 id 拒绝，不同 id 撞目录名也拒绝**。
 * 历史实现的 `_1/_2` 递增产生了"磁盘两份、注册表一份"——注册表按 manifest.id
 * 去重只剩一条，先装的那份目录既不在列表里也没人管，卸载时删的是注册表那条，
 * 原目录变成孤儿；孤儿在下次热重扫时又被加载，等于"卸载反而把它复活了"。
 * 现在写入方只做独占 mkdir：目录已存在就报错，语义是"绝不覆盖、也不造第二份"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SKILL_API_VERSION } from './skills/manifest.js';
import { findModuleIdConflict, ModuleIdConflictError } from './module-id.js';

// 与 module-import.js 的黑名单对齐。漏 com/msi/scr/lnk 四种可执行后缀不构成逃逸
// （落地层有 relCheck），但两条安装路径的口径应该一致。
const BANNED_EXT = /\.(exe|dll|bat|cmd|com|msi|scr|ps1|vbs|sh|lnk)$/i;
const MAX_FILES = 100;
const MAX_TOTAL = 32 * 1024 * 1024;
// 沙箱同名候选上限：与历史实现一致。沙箱里连拉 101 个同名版本不是真实场景，
// 到上限说明调用方在循环拉取，报错比继续堆目录更有用。
const MAX_SANDBOX_SUFFIX = 100;

/**
 * 在已独占创建的目录里写文件；失败只清理本次拥有的目录。
 * @param {string} dir 已由 mkdir（非 recursive）成功创建的目录
 * @param {(target: string) => void} writeFiles
 */
function writeIntoNewDir(dir, writeFiles) {
  try { writeFiles(dir); }
  catch (error) {
    try { fs.rmSync(dir, { recursive: true, force: true }); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `扩展写入失败且清理 ${dir} 失败：${error.message}；${cleanupError.message}`);
    }
    throw error;
  }
}

/**
 * 独占创建一个扩展目录；目录已存在即抛错，绝不合并、也绝不造出第二份副本。
 *
 * **只用于安装路径**（unzipToModuleDir 与本地导入 importPath）。安装的语义是
 * 「这个 id 从此归这一份」，多一份就会产生磁盘两份、注册表一份的孤儿。
 * 沙箱路径不适用，见 writeSandboxDirectory。
 *
 * 写入失败只清理本次拥有的目录（独占 mkdir 保证它一定是本轮出现的）。
 */
export function writeModuleDirectory(baseDir, name, writeFiles) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('非法扩展目录名');
  fs.mkdirSync(baseDir, { recursive: true });
  const dir = path.join(baseDir, name);
  try {
    fs.mkdirSync(dir);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`扩展目录 ${name} 已存在，未覆盖现有扩展（要换版本请先卸载，或走「升级扩展」）`);
    }
    throw error;
  }
  writeIntoNewDir(dir, writeFiles);
  return { id: name, dir };
}

/**
 * 沙箱专用：同名目录已存在时按 `名_1`、`名_2` … 取下一个空位。
 *
 * 为什么沙箱要递增而安装不能：沙箱里的东西**永远不会被加载执行**，同一个扩展
 * 拉两版做对比（改一版、再拉原版）是 dev_market_pull 的正常用法；而安装路径的
 * 「一个 id 只能有一份」是注册表的硬约束。两条路径共用一套递增会让孤儿目录
 * 重新长回来，共用一套拒绝则会挡住正当的开发动作——所以按语义分开。
 *
 * @throws {Error} 候选全部占用（说明调用方在循环拉取）
 */
function writeSandboxDirectory(baseDir, name, writeFiles) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) throw new Error('非法扩展目录名');
  fs.mkdirSync(baseDir, { recursive: true });
  for (let suffix = 0; suffix <= MAX_SANDBOX_SUFFIX; suffix++) {
    const id = suffix ? `${name}_${suffix}` : name;
    const dir = path.join(baseDir, id);
    try { fs.mkdirSync(dir); }
    catch (error) {
      if (error.code === 'EEXIST') continue;
      throw error;
    }
    writeIntoNewDir(dir, writeFiles);
    return { id, dir };
  }
  throw new Error(`沙箱里 ${name} 的同名候选已占用 ${MAX_SANDBOX_SUFFIX + 1} 个，请先清理 dev-sandbox 目录`);
}

/**
 * 落地前的同 id 检查（与锻造台安装、本地导入同一判据，见 src/module-id.js）。
 * @param {string} manifestId
 * @param {string} root 应用根（<root>/skills 与 <root>/plugins 就是两份磁盘真源）
 * @throws {ModuleIdConflictError} id 已被内置模块或已装扩展占用
 */
function assertIdFree(manifestId, root) {
  const existing = findModuleIdConflict(manifestId, { appRoot: root });
  if (existing) throw new ModuleIdConflictError(existing);
}

/**
 * 结构校验（抛错 = 拒绝安装）：
 *   · zip 中央目录里的每个条目：禁绝对路径/..、禁可执行后缀
 *   · 文件数与解压总量上限（zip 炸弹防护）
 * 返回 [{ name, data }]（仅文件条目，目录跳过）。
 */
export function validateZipStructure(buffer) {
  const entries = parseZip(buffer);
  if (entries.length > MAX_FILES) throw new Error(`文件数量过多（${entries.length} > ${MAX_FILES}）`);
  let total = 0;
  for (const e of entries) total += e.data.length;
  if (total > MAX_TOTAL) throw new Error('解压后总大小超过 32MB');
  return entries;
}

/**
 * 兼容性预检：在落地之前把"装完才发现不能用"的三类高频问题拦下。
 *
 * 为什么做在这里：结构校验只保证"不炸机、不穿越"，用户视角的黑盒问题要等
 * 热重载加载失败后去模块页看红字才知道，市场页那一刻还弹着"已安装"绿字。
 * 三类问题在市场包里最常见（都是作者侧的低级失误，却是用户侧的完整死局）：
 *   ① 清单 JSON 坏了（BOM / 少个逗号），loader 会报，但那时磁盘已经落下垃圾目录
 *   ② apiVersion 比本机新，这是唯一的"真兼容性"硬伤，只能升级应用解决
 *   ③ 清单声明的入口文件不在包里，作者漏打包，装 100 遍也不会好
 * 拦成抛错（unzipToModuleDir / unzipToSandboxDir 的调用方转成界面提示），
 * 磁盘不留残骸，报错一眼能看懂。
 *
 * 口径与 plugin-loader 的 readManifest / normalizeManifest 同源：
 *   - BOM 容错：Windows 记事本/PowerShell 写出的清单常带 BOM，JSON.parse 直接炸
 *   - apiVersion 缺失/非法按 SKILL_API_VERSION 兜底（normalizeManifest 同款宽容）
 *   - entry 缺省 = index.js
 * @param {Buffer} manifestData 清单文件的原始字节
 * @param {Set<string>} keptRel 模块根下的相对路径集合（'/' 分隔）
 * @returns {{ id: string }} 解析出的清单（id 供调用方日志用）
 */
function precheckManifest(manifestData, keptRel) {
  let text = manifestData.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`安装包的清单（plugin.json / skill.json）不是有效 JSON：${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('安装包的清单内容异常（顶层必须是 JSON 对象）');
  }
  const apiVer = Number(raw.apiVersion) || SKILL_API_VERSION;
  if (apiVer > SKILL_API_VERSION) {
    throw new Error(`版本不兼容：该扩展要求 API v${apiVer}，本机支持到 v${SKILL_API_VERSION}`
      + '（需要升级 QQ Agent 后才能安装这个包）');
  }
  const id = String(raw.id ?? '').trim();
  if (id && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    throw new Error(`清单 id 非法："${id.slice(0, 64)}"（只允许字母数字与 . _ -，以字母或数字开头）`);
  }
  // entry 路径校验：与 loader 同口径（相对路径、锁死在模块目录内），
  // 但这里是"落包前"，能在解压前就告诉作者"你漏打包了入口文件"。
  const entryRel = String(raw.entry || 'index.js').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!entryRel || entryRel.startsWith('/') || entryRel.split('/').includes('..') || /^[a-zA-Z]:/.test(entryRel)) {
    throw new Error(`清单 entry 路径非法：${String(raw.entry).slice(0, 80)}`);
  }
  if (!keptRel.has(entryRel)) {
    throw new Error(`不完整的安装包：清单声明入口为 ${entryRel}，但包里没有这个文件`
      + '（作者漏打包了入口 —— 这个包装多少遍都不会好，建议联系作者重新发布）');
  }
  return { id };
}

/**
 * 解包并定位模块根（**不落盘**）：把 zip 条目剥成"模块目录里应该有的那些文件"。
 *
 * 目录名规则：
 *   - 以清单文件为锚点定位模块根：zip 里找到 plugin.json/skill.json 的那条路径，
 *     其所在目录才是真正的模块根。它上面的所有层级（发布者多套的文件夹、
 *     GitHub 的 repo-main/ 包装层）全部剥掉。嵌套多深剥多深，
 *     模块根永远等于清单所在目录。
 *   - 目录名 = 清单所在目录名（清单在包根时用 preferId）。
 *
 * 拆成独立函数是因为落地有两种语义：安装（写进 skills/ 或 plugins/，必须查 id）
 * 与沙箱拉取（写进开发沙箱的临时目录，不是安装，同 id 是常态）。
 *
 * @returns {{ dirName: string, manifestId: string, kept: Array<{rel: string, data: Buffer}> }}
 * @throws 结构 / 清单 / 兼容性问题（磁盘不落任何东西）
 */
function extractModuleFromZip(buffer, { type, preferId = '' }) {
  const entries = validateZipStructure(buffer);
  if (!entries.length) throw new Error('安装包是空的');

  // ── 定位模块根：清单文件（plugin.json / skill.json）所在目录 ──
  // 优先当前 type 对应的清单，找不到再认另一种（装错页的包也能正确归位）。
  // 取最浅的那个：包内子目录（示例/demo）里的同名清单不配当模块根。
  const manifestNames = type === 'plugin'
    ? ['plugin.json', 'skill.json']
    : ['skill.json', 'plugin.json'];
  let manifestDepth = -1;      // 清单所在目录的路径段数（0 = 就在包根）
  let manifestDirName = '';    // 清单所在目录名（模块根名）
  for (const want of manifestNames) {
    let best = null;
    for (const e of entries) {
      if (e.name !== want && !e.name.endsWith('/' + want)) continue;
      const depth = e.name.split('/').length - 1;
      if (!best || depth < best.depth) best = { e, depth };
    }
    if (best) {
      const segs = best.e.name.split('/');
      manifestDepth = best.depth;
      manifestDirName = segs.length >= 2 ? segs[segs.length - 2] : '';
      break;
    }
  }

  // ── 组装要落地的条目（模块根前缀剥离 + 根外条目过滤）──
  // 模块根前缀：清单所在目录的路径前缀（清单深度 0 时为空串 = 就在包根）。
  // 不在模块根下的条目（仓库根的 README/LICENSE/.gitignore 这类包装层杂物）
  // 直接丢弃，留着反而会在模块目录里堆一层没有的嵌套。
  let dirName = manifestDirName || '';   // 有清单时用清单所在目录名（嵌套多深都是它）
  const kept = [];   // [{ rel, data }]
  let manifestId = '';
  if (manifestDepth >= 0) {
    const hit = entries.find((e) => {
      for (const want of manifestNames) {
        if (e.name !== want && !e.name.endsWith('/' + want)) continue;
        if (e.name.split('/').length - 1 === manifestDepth) return true;
      }
      return false;
    });
    const segs = hit ? hit.name.split('/') : [];
    const prefix = manifestDepth > 0 ? segs.slice(0, manifestDepth).join('/') + '/' : '';
    for (const e of entries) {
      if (prefix && !e.name.startsWith(prefix)) continue;      // 模块根之外 → 丢
      const rel = e.name.slice(prefix.length);
      if (rel) kept.push({ rel, data: e.data });
    }
    if (!kept.length) throw new Error('安装包结构异常（模块根目录下没有文件）');
    // ── 兼容性预检（落地前拦，见 precheckManifest 头注释）──
    // 顺带拿回清单 id：同 id 检查要用，不再重复解析一遍字节。
    manifestId = precheckManifest(hit.data, new Set(kept.map((k) => k.rel))).id;
  } else {
    // 没有清单 = 不是完整的可安装扩展，直接拒绝，不落地。
    // 剥统一根目录照装的话，落地后 loader 报"缺少 skill.json / plugin.json"，
    // 报错没错，但磁盘已落下垃圾目录，而市场页/导入页此刻只显示成功。
    // fail-fast 让用户在安装动作当场拿到明确原因。
    throw new Error('安装包里没有 plugin.json / skill.json —— 不是完整的可安装扩展'
      + '（请确认下载的是模块包，而不是整个仓库或文档压缩包）');
  }
  if (!dirName) dirName = preferId || 'module';
  // 不合法时一律回退 'module'。回退 preferId 没用：dirName 本来就可能就是
  // 未校验的 preferId，回退等于没回退，还把未校验的值放进了路径拼接。
  // precheckManifest 已经校验过清单 id，这里是第二道防线。
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(dirName)) dirName = 'module';
  return { dirName, manifestId, kept };
}

/** 把解包结果写进一个已独占创建的目录（路径穿越的第二道防线在这里）。 */
function writeExtracted(target, kept) {
  for (const item of kept) {
    // 二次防线：拼接结果必须仍在 target 内（解析后 path.relative 检查）
    const dest = path.join(target, ...item.rel.split('/'));
    const relCheck = path.relative(target, dest);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`安装包包含非法路径：${item.rel}`);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, item.data);
  }
}

/**
 * 解压安装到 <root>/skills/ 或 <root>/plugins/ 下的一个目录。
 *
 * **不做同名递增**：目录已存在直接拒绝（见 writeModuleDirectory）。同 id 的包在
 * 落地前就被 ModuleIdConflictError 拦下；不同 id 但撞目录名同样拒绝，因为目录名
 * 就是用户在主控台里看到的那个操作对象，多一份 `_1` 只会造成"磁盘两份、注册表一份"。
 *
 * @returns {Promise<string>} 实际落地的目录名
 * @throws {ModuleIdConflictError} 该 id 已被内置模块或已装扩展占用（conflict/existing 供界面提示）
 */
export async function unzipToModuleDir(buffer, { root, type, preferId = '' }) {
  const { dirName, manifestId, kept } = extractModuleFromZip(buffer, { type, preferId });
  // 同 id 检查必须在写盘之前：目录已落下再报冲突，用户面对的是"装了一半"的现场。
  if (manifestId) assertIdFree(manifestId, root);
  const baseDir = path.join(root, type === 'plugin' ? 'plugins' : 'skills');
  return writeModuleDirectory(baseDir, dirName, (target) => writeExtracted(target, kept)).id;
}

/**
 * 解压到开发沙箱（**不是安装**）：不查 id、不碰 skills/ 与 plugins/。
 *
 * 沙箱里同一扩展被拉两次是常态（改一版再拉一版对比），而且沙箱里的东西永远不会
 * 被加载执行 —— 用安装口径拒绝它只会挡住正当的开发动作。所以这里**保留同名递增**
 * （`demo` / `demo_1` / …），与安装路径的「目录已存在即拒绝」是两个语义，
 * 不能共用同一个写入函数（见 writeSandboxDirectory 的说明）。
 *
 * @returns {Promise<string>} 沙箱内的目录名
 */
export async function unzipToSandboxDir(buffer, { root, type, preferId = '' }) {
  const { dirName, kept } = extractModuleFromZip(buffer, { type, preferId });
  const baseDir = path.join(root, type === 'plugin' ? 'plugins' : 'skills');
  return writeSandboxDirectory(baseDir, dirName, (target) => writeExtracted(target, kept)).id;
}

/** 极简 zip 读取器：中央目录定位 + 解压全部文件条目。不支持的特性直接抛错。
 *  导出给本地导入（src/module-import.js）复用：那里要在解压之前先看一眼
 *  包里有没有 plugin.json/skill.json，才能决定装进哪一页。 */
export function parseZip(buffer, limits = {}) {
  // 限额可覆盖。默认值仍是"单个扩展包"的尺度（100 文件 / 32MB）；
  // 「打包带走」那种整包（模块 + 存档，上千文件）要传更大的值。
  // 调用方不给就还是既有行为，不能因为加了参数就把安装链的防线放松。
  const maxFiles = Number(limits.maxFiles) || MAX_FILES;
  const maxTotal = Number(limits.maxTotal) || MAX_TOTAL;
  const sig = (off) => buffer.readUInt32LE(off);
  // 定位 EOCD（22 字节，从尾部向前扫，允许有注释）
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 65536); i--) {
    if (sig(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let ptr = buffer.readUInt32LE(eocd + 16);

  const out = [];
  // 边解析边限额。先全部解压进内存再在 validateZipStructure 里检查总量的话，
  // 峰值内存已经等于声明的解压后体积，正是 zip bomb 想达到的效果
  // （实测 150×1MB 的包 parseZip 成功返回、150MB 全部驻留，之后才被拒绝）。
  // 更严重的是 module-import.js 调的是 parseZip 而非 validateZipStructure，
  // 那条路径完全绕过上限。限制下沉进 parseZip，所有调用方自动受约束。
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (out.length >= maxFiles) throw new Error(`文件数量过多（超过 ${maxFiles}）`);
    if (sig(ptr) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buffer.readUInt16LE(ptr + 10);
    const compSize = buffer.readUInt32LE(ptr + 20);
    const uncompSize = buffer.readUInt32LE(ptr + 24);   // 声明的解压后大小
    const nameLen = buffer.readUInt16LE(ptr + 28);
    const extraLen = buffer.readUInt16LE(ptr + 30);
    const commentLen = buffer.readUInt16LE(ptr + 32);
    const localOff = buffer.readUInt32LE(ptr + 42);
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // 目录条目（以 / 结尾）跳过
    if (!name.endsWith('/')) {
      // 先按声明值预检：不用 inflate 就能拒绝超限条目，避免"先解压再拒绝"
      if (uncompSize > maxTotal) {
        throw new Error(`安装包体积异常：单个文件声明解压后 ${(uncompSize / 1048576).toFixed(1)}MB，超过 32MB 上限（${name}）`);
      }
      // 本地头：定位到实际数据
      if (sig(localOff) !== 0x04034b50) throw new Error('zip 本地头损坏');
      const lNameLen = buffer.readUInt16LE(localOff + 26);
      const lExtraLen = buffer.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buffer.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      // maxOutputLength 必须给：单条目声明的 uncompSize 是压缩包里自报的、可造假。
      // 实测：声明 1 字节、deflate 流实际膨胀到 1GB 时，不带此参数的 inflateRawSync
      // 会先完整解压（峰值内存 = 实际膨胀体积），之后才在下面被 total 检查拒绝，
      // 经典单文件 zip bomb。加了之后超出即抛，不会先吃满内存。
      else if (method === 8) data = inflateRawSync(raw, { maxOutputLength: maxTotal });
      else throw new Error(`不支持的压缩方式（method=${method}）：${name}`);
      total += data.length;
      if (total > maxTotal) {
        throw new Error(`解压后总大小超过 32MB（已读到 ${(total / 1048576).toFixed(1)}MB）`);
      }
      out.push({ name: name.replace(/\\/g, '/'), data });
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  // 安全规则（与后端一致）
  for (const e of out) {
    const parts = e.name.split('/');
    // 补上盘符/UNC 形式：只拦 startsWith('/') 与 '..' 的话，`C:/evil.js`
    // 能通过解析层（实测确实返回了该条目）。落地层的 path.relative 二次防线
    // 能拦住它，不是真实逃逸，但第一层漏形态属于防御纵深不足，
    // 与后端 validate_zip 规则对齐。
    if (e.name.startsWith('/') || /^[a-zA-Z]:/.test(e.name) || parts.includes('..')) {
      throw new Error(`安装包包含非法路径：${e.name}`);
    }
    if (BANNED_EXT.test(e.name)) throw new Error(`安装包包含禁止的文件类型：${e.name}`);
  }
  return out;
}

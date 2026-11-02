// zip 解压安装：把市场下载的安装包安全地落到 skills/ 或 plugins/ 目录。
//
// 独立成模块的原因：这段是"往磁盘写可执行 JS"的入口，安全边界必须集中、可单测。
// 与 server/community_app.py 的 validate_zip 规则对齐（那里上传时校验一次，
// 这里安装前再校验一次 —— 不信任任何传输环节）。
import fs from 'node:fs';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { SKILL_API_VERSION } from './skills/manifest.js';

// r92：与 module-import.js 的黑名单对齐（原先漏 com/msi/scr/lnk 四种可执行
// 后缀 —— 不构成逃逸，落地层有 relCheck，但两条安装路径的口径应该一致）。
const BANNED_EXT = /\.(exe|dll|bat|cmd|com|msi|scr|ps1|vbs|sh|lnk)$/i;
const MAX_FILES = 100;
const MAX_TOTAL = 32 * 1024 * 1024;

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
 * 兼容性预检（2026-10-19）：在落地**之前**把"装完才发现不能用"的三类高频问题拦下。
 *
 * 为什么做在这里：结构校验只保证"不炸机、不穿越"，用户视角的黑盒问题要等
 * 热重载加载失败后去模块页看红字才知道 —— 市场页那一刻还弹着"已安装"绿字。
 * 三类问题在市场包里最常见（都是作者侧的低级失误，却是用户侧的完整死局）：
 *   ① 清单 JSON 坏了（BOM / 少个逗号）—— loader 会报，但那时磁盘已经落下垃圾目录
 *   ② apiVersion 比本机新 —— 唯一的"真兼容性"硬伤，只能升级应用解决
 *   ③ 清单声明的入口文件不在包里 —— 作者漏打包，装 100 遍也不会好
 * 拦成抛错（market.js installByCode → toast；module-import → errors 数组），
 * 磁盘不留残骸，报错一眼能看懂。
 *
 * 口径与 plugin-loader 的 readManifest / normalizeManifest 同源：
 *   · BOM 容错：Windows 记事本/PowerShell 写出的清单常带 \uFEFF，JSON.parse 直接炸
 *   · apiVersion 缺失/非法按 SKILL_API_VERSION 兜底（normalizeManifest 同款宽容）
 *   · entry 缺省 = index.js
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
 * 解压安装到 <root>/skills/ 或 <root>/plugins/ 下的一个目录。
 *
 * 目录名规则：
 *   · 以**清单文件为锚点**定位模块根：zip 里找到 plugin.json/skill.json 的
 *     那条路径，其所在目录才是真正的模块根 —— 它上面的所有层级
 *     （发布者多套的文件夹、GitHub 的 repo-main/ 包装层）全部剥掉
 *   · 找不到清单时回退：所有条目共享同一个第一段则剥掉它，否则用 preferId
 *   · 与本地已有目录冲突 → 自动 _1/_2（重装场景：同 id 覆盖会丢用户改动，
 *     而且插件热重载正在 watch 旧目录，覆盖写一半会加载出半截代码）
 *
 * ⚠️ 2026-10-16 修「下载的插件嵌套文件夹导致缺少文件」：旧实现只剥**一层**
 *    统一根目录。双层包装（如 GitHub 下载的 `repo-main/插件名/index.js`、
 *    发布者把整个项目文件夹又套了一层）解压后清单落在
 *    `<模块目录>/<内层文件夹>/plugin.json`，而 loader 的 readManifest 只在
 *    模块根找 plugin.json/skill.json → 报"缺少 skill.json / plugin.json"。
 *    改为按清单深度剥层：嵌套多深剥多深，模块根永远等于清单所在目录。
 *
 * @returns {Promise<string>} 实际落地的目录名
 */
export async function unzipToModuleDir(buffer, { root, type, preferId = '' }) {
  const entries = validateZipStructure(buffer);
  if (!entries.length) throw new Error('安装包是空的');
  const baseDir = path.join(root, type === 'plugin' ? 'plugins' : 'skills');

  // ── 定位模块根：清单文件（plugin.json / skill.json）所在目录 ──
  // 优先当前 type 对应的清单，找不到再认另一种（装错页的包也能正确归位）。
  // 取**最浅**的那个：包内子目录（示例/demo）里的同名清单不配当模块根。
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
  // 直接丢弃 —— 留着反而会在模块目录里堆一层没有的嵌套。
  let dirName = manifestDirName || '';   // 有清单时用清单所在目录名（嵌套多深都是它）
  let kept = [];   // [{ rel, data }]
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
    precheckManifest(hit.data, new Set(kept.map((k) => k.rel)));
  } else {
    // 没有清单 = 不是完整的可安装扩展（2026-10-19 起直接拒绝，不再落地）。
    // 旧行为是"剥统一根目录照装"，落地后 loader 报"缺少 skill.json / plugin.json"
    // —— 报错没错，但磁盘已落下垃圾目录，而市场页/导入页此刻只显示成功。
    // fail-fast 让用户在安装动作当场拿到明确原因。
    throw new Error('安装包里没有 plugin.json / skill.json —— 不是完整的可安装扩展'
      + '（请确认下载的是模块包，而不是整个仓库或文档压缩包）');
  }
  if (!dirName) dirName = preferId || 'module';
  // r92：不合法时一律回退 'module'。原实现回退 preferId —— 而 !strip 时
  // dirName 本来就是 preferId（刚被判定不合法），等于没回退；strip 时也会
  // 把未校验的 preferId 放进路径拼接。market.js 的 installByCode 现在也校验
  // id，这里是第二道防线。
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(dirName)) dirName = 'module';
  // 冲突递增
  let finalName = dirName;
  for (let n = 1; n <= 100; n++) {
    if (!fs.existsSync(path.join(baseDir, finalName))) break;
    finalName = `${dirName}_${n}`;
  }
  const target = path.join(baseDir, finalName);
  fs.mkdirSync(target, { recursive: true });

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
  return finalName;
}

/** 极简 zip 读取器：中央目录定位 + 解压全部文件条目。不支持的特性直接抛错。
 *  导出给本地导入（src/module-import.js）复用 —— 那里要在解压**之前**先看一眼
 *  包里有没有 plugin.json/skill.json，才能决定装进哪一页。 */
export function parseZip(buffer, limits = {}) {
  // 2026-10-22：限额可覆盖。默认值仍是"单个扩展包"的尺度（100 文件 / 32MB）；
  // 「打包带走」那种整包（模块 + 存档，上千文件）要传更大的值。
  // 调用方不给就还是既有行为 —— 不能因为加了参数就把安装链的防线放松。
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
  // ⚠️ 边解析边限额（2026-10-07 修）。原实现是"先把全部条目解压进内存，
  //   之后才在 validateZipStructure 里检查总量" —— 那时峰值内存已经等于
  //   声明的解压后体积，正是 zip bomb 想达到的效果（实测 150×1MB 的包
  //   parseZip 成功返回、150MB 全部驻留，之后才被拒绝）。
  //   更严重的是 module-import.js 调的是 parseZip 而非 validateZipStructure，
  //   那条路径**完全绕过**上限。现在限制下沉进 parseZip，所有调用方自动受约束。
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
      // 先按**声明值**预检：不用 inflate 就能拒绝超限条目，避免"先解压再拒绝"
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
      // ⚠️ maxOutputLength 必须给（2026-10-07 补）：单条目声明的 uncompSize 是
      //   压缩包里自报的、可造假。实测：声明 1 字节、deflate 流实际膨胀到 1GB 时，
      //   不带此参数的 inflateRawSync 会先完整解压（峰值内存 = 实际膨胀体积），
      //   之后才在下面被 total 检查拒绝 —— 经典单文件 zip bomb。
      //   加了之后超出即抛，不会先吃满内存。
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
    // ⚠️ 补上盘符/UNC 形式（2026-10-07）：原先只拦 startsWith('/') 与 '..'，
    //   `C:/evil.js` 能通过解析层（实测确实返回了该条目）。
    //   落地层的 path.relative 二次防线能拦住它，所以不是真实逃逸，
    //   但第一层漏形态属于防御纵深不足 —— 与后端 validate_zip 规则对齐。
    if (e.name.startsWith('/') || /^[a-zA-Z]:/.test(e.name) || parts.includes('..')) {
      throw new Error(`安装包包含非法路径：${e.name}`);
    }
    if (BANNED_EXT.test(e.name)) throw new Error(`安装包包含禁止的文件类型：${e.name}`);
  }
  return out;
}

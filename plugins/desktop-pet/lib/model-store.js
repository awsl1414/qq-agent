import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TYPES = { '.json': 'application/json; charset=utf-8', '.moc3': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.license': 'text/plain; charset=utf-8' };
export const MODEL_LIMITS = Object.freeze({ files: 2048, total: 256 * 1024 * 1024, file: 64 * 1024 * 1024, json: 4 * 1024 * 1024 });
const safeId = (s) => /^[a-z0-9-]{1,80}$/.test(String(s));
const PREVIEW_RESOURCE = '__qqa_preview.png';
const PREVIEW_LIMIT = 512 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function previewPng(dataUrl) {
  const prefix = 'data:image/png;base64,';
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) || dataUrl.length > prefix.length + Math.ceil(PREVIEW_LIMIT / 3) * 4) throw new Error('角色预览必须是小于 512 KB 的 PNG 图片');
  const encoded = dataUrl.slice(prefix.length);
  if (!encoded || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('角色预览的 Base64 编码无效');
  const data = Buffer.from(encoded, 'base64');
  if (data.length >= PREVIEW_LIMIT || data.toString('base64') !== encoded || !data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('角色预览不是有效的小型 PNG 图片');
  let offset = 8, header = false, pixels = false, end = false;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (length > data.length - offset - 12) throw new Error('角色预览 PNG 数据不完整');
    const type = data.toString('ascii', offset + 4, offset + 8);
    if (!header) {
      if (type !== 'IHDR' || length !== 13) throw new Error('角色预览 PNG 缺少尺寸信息');
      const width = data.readUInt32BE(offset + 8), height = data.readUInt32BE(offset + 12);
      if (width < 1 || height < 1 || width > 512 || height > 512) throw new Error('角色预览尺寸不能超过 512 × 512');
      header = true;
    } else if (type === 'IHDR') throw new Error('角色预览 PNG 包含重复尺寸信息');
    if (type === 'IDAT') pixels = true;
    offset += length + 12;
    if (type === 'IEND') { if (length !== 0 || offset !== data.length) throw new Error('角色预览 PNG 结尾无效'); end = true; break; }
  }
  if (!header || !pixels || !end) throw new Error('角色预览 PNG 数据不完整');
  return data;
}

export function isWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function safeRelative(raw) {
  const s = String(raw ?? '');
  if (!s || /[\x00-\x1f:#?]/.test(s) || /^(?:[a-z]+:|[\\/])/i.test(s)) throw new Error('模型资源必须是目录内的相对路径');
  const parts = s.replace(/\\/g, '/').split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || /[<>"|*]/.test(p) || /[. ]$/.test(p))) throw new Error('模型资源路径包含不安全片段');
  return parts.join('/');
}

function readBounded(file, limit = MODEL_LIMITS.file) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error('模型目录不能包含符号链接或特殊文件');
  if (st.size > limit) throw new Error('模型单个文件过大');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > limit || opened.dev !== st.dev || opened.ino !== st.ino) throw new Error('模型文件在导入过程中发生变化');
    const data = fs.readFileSync(fd);
    if (data.length > limit) throw new Error('模型单个文件过大');
    return data;
  } finally { fs.closeSync(fd); }
}

function parseJson(file) {
  try { return JSON.parse(readBounded(file, MODEL_LIMITS.json).toString('utf8').replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error(`模型 JSON 无效（${path.basename(file)}）：${e.message}`); }
}

function enumerate(root, limits) {
  const out = [];
  let total = 0;
  function walk(dir, depth) {
    if (depth > 16) throw new Error('模型目录嵌套过深');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink()) throw new Error('模型目录不能包含符号链接');
      const rel = safeRelative(path.relative(root, file));
      if (!isWithin(root, fs.realpathSync(file))) throw new Error('模型资源超出所选目录');
      if (st.isDirectory()) walk(file, depth + 1);
      else {
        if (!st.isFile() || !TYPES[path.extname(file).toLowerCase()]) throw new Error(`模型目录包含不支持的文件：${rel}`);
        total += st.size;
        out.push({ rel, size: st.size });
        if (out.length > limits.files || total > limits.total || st.size > limits.file) throw new Error('模型超过文件数量或体积限制（最多 2048 个文件、256 MB，单文件 64 MB）');
      }
    }
  }
  walk(root, 0);
  return out;
}

export function inspectModel(entry, files = null) {
  const root = path.dirname(entry);
  if (!/\.model3\.json$/i.test(entry)) throw new Error('请选择 Live2D 的 .model3.json 入口文件');
  const doc = parseJson(entry);
  if (doc.Version !== 3 || !doc.FileReferences || typeof doc.FileReferences !== 'object') throw new Error('模型不是有效的 Cubism 3/4/5 model3 格式');
  const refs = doc.FileReferences;
  if (typeof refs.Moc !== 'string' || !/\.moc3$/i.test(refs.Moc) || !Array.isArray(refs.Textures) || !refs.Textures.length) throw new Error('模型必须包含 .moc3 和贴图引用');
  const known = files ? new Set(files.map((f) => typeof f === 'string' ? f : f.rel)) : null;
  const check = (name, base = root) => {
    const rel = safeRelative(name);
    const full = path.resolve(base, rel);
    if (!isWithin(root, full) || !isWithin(root, fs.realpathSync(full))) throw new Error('模型资源引用超出目录');
    if (known && !known.has(path.relative(root, full).split(path.sep).join('/'))) throw new Error(`模型缺少资源：${rel}`);
    const data = readBounded(full);
    return { full, data };
  };
  check(refs.Moc);
  for (const tex of refs.Textures) {
    if (!/\.(png|jpe?g|webp)$/i.test(String(tex))) throw new Error('模型贴图格式不支持');
    check(tex);
  }
  for (const k of ['Physics', 'Pose', 'UserData', 'DisplayInfo']) if (refs[k]) { check(refs[k]); parseJson(path.resolve(root, safeRelative(refs[k]))); }
  const motions = [];
  for (const [group, items] of Object.entries(refs.Motions || {})) {
    if (!Array.isArray(items) || group.length > 200 || items.length > 1000) throw new Error('模型动作列表格式无效');
    items.forEach((m, index) => {
      if (!m || typeof m.File !== 'string') throw new Error('模型动作缺少文件');
      const { full } = check(m.File);
      parseJson(full);
      if (m.Sound) check(m.Sound);
      motions.push({ id: `${group}:${index}`, group, index, name: `${group} · ${index + 1}` });
    });
  }
  const expressions = [];
  if (refs.Expressions && !Array.isArray(refs.Expressions)) throw new Error('模型表情列表格式无效');
  (refs.Expressions || []).forEach((e, index) => {
    if (!e || typeof e.File !== 'string') throw new Error('模型表情缺少文件');
    const { full } = check(e.File);
    parseJson(full);
    expressions.push({ id: String(e.Name || `expression-${index}`), name: String(e.Name || `表情 ${index + 1}`).slice(0, 200) });
  });
  return { motions, expressions };
}

export class ModelStore {
  constructor(root, { limits = MODEL_LIMITS } = {}) { this.root = path.resolve(root); this.previewRoot = path.join(path.dirname(this.root), 'previews'); this.limits = limits; }
  import(entryPath) {
    if (typeof entryPath !== 'string' || !path.isAbsolute(entryPath)) throw new Error('请通过原生文件选择器选择模型入口');
    const entry = path.resolve(entryPath);
    const source = path.dirname(entry);
    if (fs.lstatSync(source).isSymbolicLink() || fs.lstatSync(entry).isSymbolicLink()) throw new Error('模型入口和目录不能是符号链接');
    if (isWithin(this.root, source) || isWithin(source, this.root)) throw new Error('请从桌宠数据目录之外导入模型');
    const files = enumerate(source, this.limits);
    const info = inspectModel(entry, files);
    fs.mkdirSync(this.root, { recursive: true });
    const id = `pet-${crypto.randomUUID()}`;
    const stage = path.join(this.root, `.import-${id}`);
    const dest = path.join(this.root, id);
    if (!isWithin(this.root, stage) || !isWithin(this.root, dest)) throw new Error('无效的模型目标路径');
    try {
      fs.mkdirSync(stage);
      for (const f of files) {
        const from = path.join(source, f.rel);
        if (!isWithin(fs.realpathSync(source), fs.realpathSync(from))) throw new Error('模型资源超出所选目录');
        const data = readBounded(from, Math.min(this.limits.file, f.size));
        if (data.length !== f.size) throw new Error('模型文件在导入过程中发生变化');
        const to = path.join(stage, f.rel);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.writeFileSync(to, data, { flag: 'wx' });
      }
      inspectModel(path.join(stage, path.basename(entry)), files);
      fs.renameSync(stage, dest);
      return { id, name: path.basename(entry).replace(/\.model3\.json$/i, '').slice(0, 100), entry: path.basename(entry), files: files.map((f) => f.rel), bytes: files.reduce((n, f) => n + f.size, 0), ...info };
    } catch (e) {
      if (isWithin(this.root, stage) && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
      throw e;
    }
  }
  publicModel(model) {
    if (!model || !safeId(model.id)) return null;
    let previewUrl = '';
    try {
      const file = this.#previewFile(model.id);
      const st = fs.lstatSync(file);
      if (st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size < PREVIEW_LIMIT && isWithin(this.previewRoot, fs.realpathSync(file))) previewUrl = `${this.url(model.id, PREVIEW_RESOURCE)}?v=${Math.trunc(st.mtimeMs)}`;
    } catch {}
    return { id: model.id, name: model.name, bytes: model.bytes, entryUrl: this.url(model.id, model.entry), previewUrl, previewKind: previewUrl ? 'render' : '', motions: model.motions || [], expressions: model.expressions || [] };
  }
  #previewFile(id, create = false) {
    if (!safeId(id)) throw new Error('角色预览标识无效');
    if (create) fs.mkdirSync(this.previewRoot, { recursive: true });
    const dir = fs.lstatSync(this.previewRoot);
    if (!dir.isDirectory() || dir.isSymbolicLink() || !isWithin(this.previewRoot, fs.realpathSync(this.previewRoot))) throw new Error('角色预览缓存目录无效');
    const file = path.join(this.previewRoot, `${id}.png`);
    if (!isWithin(this.previewRoot, file)) throw new Error('角色预览路径无效');
    return file;
  }
  savePreview(id, dataUrl) {
    const data = previewPng(dataUrl);
    const file = this.#previewFile(id, true);
    const tmp = path.join(this.previewRoot, `.preview-${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 });
      fs.renameSync(tmp, file);
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    return { ok: true };
  }
  url(id, rel) { return `/api/desktop-pet/model/${encodeURIComponent(id)}/${safeRelative(rel).split('/').map(encodeURIComponent).join('/')}`; }
  asset(model, raw) {
    if (!model || !safeId(model.id)) throw new Error('模型不存在');
    const rel = safeRelative(raw);
    if (rel === PREVIEW_RESOURCE) {
      try {
        const file = this.#previewFile(model.id);
        if (!isWithin(this.previewRoot, fs.realpathSync(file))) throw new Error('角色预览资源超出目录');
        return { data: readBounded(file, PREVIEW_LIMIT - 1), mime: 'image/png' };
      } catch { throw new Error('角色预览不存在或缓存无效'); }
    }
    if (!(model.files || []).includes(rel)) throw new Error('模型资源不存在');
    const dir = path.join(this.root, model.id);
    const file = path.join(dir, rel);
    if (!isWithin(this.root, file) || !isWithin(dir, fs.realpathSync(file)) || fs.lstatSync(dir).isSymbolicLink()) throw new Error('模型资源超出目录');
    return { data: readBounded(file), mime: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
  }
}

// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';
import { safeFetchBinary } from '../../../src/safe-fetch.js';
import { detectImageExt } from '../../../src/image-type.js';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary, isStickerFetchComplete,
  findSticker, findStickerExact, formatStickerList, applyStickerNote, markStickerUsed,
  loadHiddenSet, saveHiddenSet, visibleEntries, isHidden
} from './stickers.js';

/**
 * 同步收藏时向协议端请求的条数。
 *
 * 这个数不该跟 `promptMaxStickers` 挂钩。`promptMaxStickers` 是「每次往提示词里
 * 列几个表情」，一个提示词预算设置，默认 10；旧实现用 `promptMaxStickers * 10`
 * 当拉取量（默认 100），等于让"提示词里想列几个"顺手决定了"本地库最多存几个"：
 * 收藏超过 100 张的用户每次同步都会把多出来的永久删掉。两件事没有关系，
 * 所以这里用独立的常量。
 *
 * 500 是协议端的上限。请求上限值还有个额外好处：「拿到的条数 < 请求的条数」
 * 就成了"服务端已经把收藏给完了"的可靠证据（见 stickers.js 的
 * isStickerFetchComplete），剪枝只在这条证据成立时才做。
 */
const SYNC_FETCH_COUNT = 500;

function stickerImagesDir() {
  return path.join(DATA_DIR, 'sticker-images');
}

export function localStickerPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  const root = path.resolve(stickerImagesDir()) + path.sep;
  const full = path.resolve(pathname);
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return null;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
    // 必须校验非空：写入被中断会留下 0 字节的残骸，它"存在且是文件"，
    // 于是会被当成可用的本地转存，表情从此永久发不出去
    // （每次同步都把它粘回来，也换不回远端直链）。
    if (fs.statSync(full).size <= 0) return null;
  } catch { return null; }
  return full;
}

export class StickerManager {
  constructor(api) {
    this.api = api;
    // entries 始终是完整库（含已隐藏条目）。隐藏只是把 id 记进 this.hidden，
    // 由 visible() 在消费点摘出去，详见 lib/stickers.js 的隐藏名单注释。
    this.entries = loadStickerStore();
    this.hidden = loadHiddenSet();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
  }

  /** 可见（未被隐藏）的那部分库。提示词 / list / 快照 / 发送一律用它。 */
  get visible() {
    return visibleEntries(this.entries, this.hidden);
  }

  /**
   * 隐藏（软删除）一个表情。
   * @returns {{ok: boolean, id: string|null, alreadyHidden?: boolean}}
   */
  hide(ref) {
    // 用精确匹配（`findStickerExact`），不用 findSticker 的 url 子串兜底：
    // 删除是破坏性操作，模糊匹配会删错对象（详见 stickers.js 的 findStickerExact 注释）。
    const target = findStickerExact(this.entries, String(ref ?? ''));
    if (!target) return { ok: false, id: null };
    const alreadyHidden = isHidden(target, this.hidden);
    // 只记 id，不记 resId：A 的 resId 有可能恰好等于 B 的 id，记了就会误伤 B。
    this.hidden.add(target.id);
    saveHiddenSet(this.hidden);
    return { ok: true, id: target.id, alreadyHidden };
  }

  /**
   * 取消隐藏（恢复）。返回被恢复的条目，供调用方回话。
   * @returns {{ok: boolean, id: string|null}}
   */
  unhide(ref) {
    const target = findStickerExact(this.entries, String(ref ?? ''));
    if (!target) return { ok: false, id: null };
    this.hidden.delete(target.id);
    saveHiddenSet(this.hidden);
    return { ok: true, id: target.id };
  }

  /** 被隐藏的条目（查看器列出"已删除"用）。 */
  hiddenEntries() {
    return this.entries.filter((e) => isHidden(e, this.hidden));
  }

  /**
   * 把"本地转存"的表情图导出一份到页面读得到的地方。
   *
   * 病灶：查看器跑在 iframe 里，只有 `/plugin-panel/sticker/@data/`
   *   （= `<DATA_DIR>/plugin-data/sticker/`）这一条通道，而本地转存是
   *   `file:///`，浏览器读不了，所以面板上一律画占位。
   *   本地缓存还没接管 url 时影响不大（同步会把 url 覆盖回图床直链，能热链显示），
   *   让 url 稳定指向本地文件之后，凡是发出过的表情在面板上就都看不见了。
   *   修发送健壮性反而弄坏了面板，所以这边必须补上。
   *
   * 做法：复制到 `plugin-data/sticker/img/`，由 buildViewSnapshot 换成
   *   `../@data/img/<name>`。该目录走的是既有通道，扩展名白名单里本来就有
   *   png/jpg/webp/gif，不用动宿主，也不需要 ffmpeg/缩略图库。
   *   是原样复制不是压缩：表情本来就小（几十 KB），没必要引入图像依赖。
   *
   * @returns {Map<string,string>} id → 相对 URL（页面可直接拼到 src 上）
   */
  materializeThumbs() {
    const map = new Map();
    const dir = path.join(DATA_DIR, 'plugin-data', 'sticker', 'img');
    const wanted = new Set();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return map; }
    for (const e of this.entries || []) {
      const url = String(e?.url || '').trim();
      if (!url.toLowerCase().startsWith('file:///')) continue;
      const src = localStickerPath(url);   // 顺带做了路径逃逸 + 非空校验
      if (!src) continue;
      const safeId = String(e.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'sticker';
      const ext = path.extname(src).toLowerCase() || '.png';
      const name = `${safeId}${ext}`;
      const dest = path.join(dir, name);
      wanted.add(path.resolve(dest).toLowerCase());
      try {
        const srcSize = fs.statSync(src).size;
        // 只在"不存在"或"大小对不上"时复制，避免每次同步都重拷一遍
        let need = true;
        try { need = !fs.existsSync(dest) || fs.statSync(dest).size !== srcSize; } catch { /* 读不到目标文件就按"需要复制"处理 */ }
        if (need) fs.copyFileSync(src, dest);
        map.set(e.id, `../@data/img/${name}`);
      } catch { /* 复制失败就让它退回占位，不能影响表情功能本身 */ }
    }
    this.#pruneThumbs(dir, wanted);
    return map;
  }

  /**
   * 清掉没人引用的缩略图。
   * 两道保险：库为空时完全不动（否则一次加载时序问题就会把缩略图全删光）；
   * 以及 10 分钟宽限（跟 pruneOrphanImages 一致），避免同步中途误删。
   */
  #pruneThumbs(dir, wanted) {
    if (!(this.entries || []).length) return 0;
    const GRACE_MS = 10 * 60 * 1000;
    const now = Date.now();
    let removed = 0;
    try {
      for (const name of fs.readdirSync(dir)) {
        const fp = path.join(dir, name);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          if (wanted.has(path.resolve(fp).toLowerCase())) continue;
          if (now - st.mtimeMs < GRACE_MS) continue;
          fs.unlinkSync(fp);
          removed += 1;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    return removed;
  }

  get config() {
    return this.api.config();
  }

  get enabled() {
    return this.config?.enabled !== false;
  }

  get promptMaxStickers() {
    return Math.max(1, Math.min(60, Number(this.config?.promptMaxStickers) || 10));
  }

  get encourageLevel() {
    return Math.min(3, Math.max(0, Number(this.config?.encourage) || 1));
  }

  get rotatePeriodMin() {
    const v = this.config?.rotatePeriodMin;
    return v === undefined ? 60 : Math.max(0, Number(v) || 0);
  }

  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = SYNC_FETCH_COUNT;
        const data = await this.api.qqCall('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有"这次拉取是完整的一份"才允许剪枝。拿满 count 条 = 后面还有，
        // 此时不在列表里的表情只是"没翻到"，删掉就是永久丢数据（含备注/标签/使用次数）。
        const complete = isStickerFetchComplete(fetched.length, count);
        const before = this.entries.length;
        const merged = mergeStickerLibrary(this.entries, fetched, { prune: complete });
        this.entries = merged;
        // D2：把被远端 url 覆盖掉的本地转存路径换回来（详见 #restoreLocalUrls 注释）
        const restored = this.#restoreLocalUrls();
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        this.pruneOrphanImages();
        if (merged.length < before) {
          this.api.log(`收藏同步：QQ 侧已移除 ${before - merged.length} 个表情，本地库同步删除`);
        } else if (!complete) {
          // 不剪枝时说明一句，免得用户看到"本地有 200 张、QQ 只有 150 张"时以为是 bug
          this.api.log(`收藏同步：本次拿到 ${fetched.length} 条（请求 ${count}），已按"不完整"处理 —— 只增不删`);
        }
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  /**
   * 把"同步时被远端 url 覆盖回去"的本地转存路径换回来。
   *
   * 病灶：`mergeStickerLibrary` 里是 `url: item.url || old.url`，远端有 url 就
   *   无脑覆盖。而 QQ 图床直链带 rkey，大约 1 小时过期，过期后表情就发不出去。
   *   `ensureSendable` 本来会在发送前重新落地一份，但那要等到真要发的时候，
   *   而且落地失败的兜底链（get_image / 重新下载）在直链过期时也救不回来。
   *   更糟的是 `localFile` 以前没进 `normalizeStickerEntry`，存一轮就没了。
   *
   * 改法：同步后逐个回填，只要本地文件还在受控目录里，就用它，不信任远端直链。
   * `localStickerPath` 顺带保证了路径没跑出 sticker-images/，免得回填成任意文件。
   *
   * @returns {number} 回填的条数
   */
  #restoreLocalUrls() {
    let restored = 0;
    for (const e of this.entries || []) {
      const local = String(e?.localFile || '').trim();
      if (!local.toLowerCase().startsWith('file:///')) continue;
      if (String(e?.url || '').trim().toLowerCase().startsWith('file:///')) continue;
      // 文件没了 / 不在受控目录内 → 不回填，留着远端 url 让 ensureSendable 重新落地
      if (!localStickerPath(local)) continue;
      e.url = local;
      restored += 1;
    }
    return restored;
  }

  async ensureSendable(sticker) {
    if (!sticker?.id || !sticker?.url) return sticker;
    const url = String(sticker.url);
    if (url.toLowerCase().startsWith('file:///')) return sticker;
    if (sticker._persistTried) return sticker;
    sticker._persistTried = true;
    try {
      const local = await this.#persistImage(`st_${sticker.id}`, { url });
      if (local) {
        sticker.url = local;
        sticker.localFile = local;
        try { saveStickerStore(this.entries); } catch { /* 落盘失败不致命：下次同步会重写 */ }
      }
    } catch {
      try {
        const fresh = await this.sync(true);
        const updated = findSticker(fresh.entries, sticker.id);
        const freshUrl = updated?.url ? String(updated.url).trim() : '';
        if (freshUrl && !freshUrl.toLowerCase().startsWith('file:///') && freshUrl !== url) {
          const local = await this.#persistImage(`st_${sticker.id}`, { url: freshUrl });
          if (local) {
            sticker.url = local;
            sticker.localFile = local;
            try { saveStickerStore(this.entries); } catch { /* 落盘失败不致命：下次同步会重写 */ }
          }
        }
      } catch { /* 重同步也失败：就用手上这份原始 URL，不影响发表情 */ }
    }
    return sticker;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit, { hidden: this.hidden });
  }

  /**
   * 找一个可用的表情：已隐藏的算找不到，这样发送/看图/备注都会被挡住，
   * 不会出现"删了还能发"的漏网之鱼。
   */
  async find(ref) {
    const synced = await this.sync(false);
    const hit = findSticker(synced.entries, ref);
    if (!hit) return null;
    return isHidden(hit, this.hidden) ? null : hit;
  }

  note(id, patch) {
    // 已删除的表情不能再备注，否则"删了还能改"，而且改 updatedAt 会让它
    // 在「按最近更新」排序里往前冒，等于删了个寂寞。
    const target = findStickerExact(this.entries, String(id ?? ''));
    if (target && isHidden(target, this.hidden)) return null;
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  async collect(messageId, { url, note = '', file = '', tags = [], usage = '' } = {}) {
    if (!this.config?.collectEnabled) throw new Error('收藏表情功能未开启');
    const now = Date.now();
    // 标签归一化：模型可能给数组、也可能给"无语,翻白眼"这种串，两种都收。
    // 上限 20 个（与 applyStickerNote 同口径），空串丢掉。
    const normTags = (Array.isArray(tags) ? tags : String(tags ?? '').split(/[,，、;；\s]+/))
      .map((t) => String(t ?? '').trim())
      .filter(Boolean)
      .slice(0, 20);
    const normUsage = String(usage ?? '').trim().slice(0, 60);
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(this.config?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url && !file) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      // 重新收藏一条"删掉过的"= 用户想要它回来，顺手取消隐藏。
      // 不这么做的话：note() 会因为我们刚加的隐藏拦截返回 null，
      // 表现为"说了一句收藏，机器人回你『找不到』"，很莫名。
      if (isHidden(existing, this.hidden)) this.unhide(id);
      return this.note(id, { note: String(note || ''), tags: normTags, usage: normUsage });
    }

    let localFile = '';
    try {
      localFile = await this.#persistImage(id, { url, file });
    } catch (error) {
      this.api.warn(`收藏图片转存失败，退回存 url（可能 1 小时后失效）: ${error?.message ?? error}`);
    }

    const entry = {
      id,
      resId: id,
      url: localFile || url,
      sourceUrl: url,
      localFile: localFile || '',
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: normTags,
      usage: normUsage,
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);
    return entry;
  }

  async #persistImage(id, { url, file }) {
    const imgDir = stickerImagesDir();
    fs.mkdirSync(imgDir, { recursive: true });
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'sticker';
    if (file) {
      try {
        const ret = await this.api.qqCall('get_image', { file: String(file) });
        const srcPath = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
        if (srcPath) {
          const buf = fs.readFileSync(srcPath);
          if (buf.length) {
            const dest = path.join(imgDir, `${safeId}${detectImageExt(buf)}`);
            fs.writeFileSync(dest, buf);
            return `file:///${dest.replace(/\\/g, '/')}`;
          }
        }
        if (ret?.url) {
          const buf = await this.#downloadBytes(String(ret.url));
          if (buf) {
            const dest = path.join(imgDir, `${safeId}${detectImageExt(buf)}`);
            fs.writeFileSync(dest, buf);
            return `file:///${dest.replace(/\\/g, '/')}`;
          }
        }
      } catch { /* 本地落盘失败：沿用原始 URL */ }
    }
    if (url) {
      const buf = await this.#downloadBytes(url);
      if (buf) {
        const dest = path.join(imgDir, `${safeId}${detectImageExt(buf)}`);
        fs.writeFileSync(dest, buf);
        return `file:///${dest.replace(/\\/g, '/')}`;
      }
    }
    throw new Error('图片转存失败（get_image 无缓存且 url 下载失败）');
  }

  async #downloadBytes(url, timeoutMs = 15000) {
    try {
      void timeoutMs;
      const { buffer } = await safeFetchBinary(String(url), 15 * 1024 * 1024);
      return buffer?.length ? buffer : null;
    } catch {
      return null;
    }
  }

  pruneOrphanImages() {
    const imgDir = stickerImagesDir();
    let removed = 0;
    try {
      if (!fs.existsSync(imgDir)) return 0;
      const referenced = new Set();
      for (const e of this.entries || []) {
        const m = /^file:\/\/\/?(.*)$/i.exec(String(e?.localFile || e?.url || ''));
        if (!m) continue;
        try { referenced.add(path.resolve(decodeURIComponent(m[1])).toLowerCase()); } catch { /* 坏路径跳过：只影响这一条 */ }
      }
      const now = Date.now();
      const GRACE_MS = 10 * 60 * 1000;
      for (const name of fs.readdirSync(imgDir)) {
        const fp = path.join(imgDir, name);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          if (referenced.has(path.resolve(fp).toLowerCase())) continue;
          if (now - st.mtimeMs < GRACE_MS) continue;
          fs.unlinkSync(fp);
          removed += 1;
        } catch { /* 单个文件删不掉（占用/权限）：跳过，不中断整轮清理 */ }
      }
    } catch { /* 清理失败不影响主流程：少删几张图，下次再来 */ }
    return removed;
  }
}

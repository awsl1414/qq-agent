// 归档：按天/时段回读**原始**聊天记录（不是碎片摘要）。
//
// 这是"长时块可以放心压缩、放心淘汰"的前提：块文件删掉了也不丢信息，
// 真相源始终是 data/messages。所以遗忘只影响"自动想起来"的概率，
// 不影响"用户明确要查某天"的能力。
import { loadMessages } from './consolidate.js';
import { dayKeyOf, hourKeyOf, formatWhen } from './util.js';

function fmtLine(m) {
  const text = String(m.text || '').replace(/\s+/g, ' ').trim();
  const media = Array.isArray(m.media) && m.media.length ? `[媒体x${m.media.length}]` : '';
  return {
    ts: Number(m.ts) || 0,
    when: formatWhen(m.ts),
    mid: m.mid ?? null,
    localId: m.id ?? null,
    who: m.self ? '我' : (m.senderName || m.senderId || '?'),
    self: !!m.self,
    text: (text + (media && !text.includes(media) ? ` ${media}` : '')).slice(0, 300)
  };
}

export class ArchiveReader {
  constructor({ messagesDir, batchMax = 20000 }) {
    this.messagesDir = messagesDir;
    this.batchMax = batchMax;
  }

  #all(chatKey) {
    // 归档要的是"最近的记录"，所以走 tail 读法（取文件末尾一批）。
    // 巩固走的是另一条路（按 id 分页往前推），见 consolidate.js 的 loadMessages 注释。
    return loadMessages(this.messagesDir, chatKey, { batchMax: this.batchMax, tail: true });
  }

  /** 该会话有哪些天（从原始消息扫，比索引全）。 */
  listDays(chatKey, { limit = 40 } = {}) {
    const days = new Map();
    for (const m of this.#all(chatKey)) {
      const dk = dayKeyOf(m.ts);
      const cur = days.get(dk) || { dayKey: dk, count: 0, firstTs: m.ts, lastTs: m.ts };
      cur.count += 1;
      if (m.ts < cur.firstTs) cur.firstTs = m.ts;
      if (m.ts > cur.lastTs) cur.lastTs = m.ts;
      days.set(dk, cur);
    }
    return [...days.values()]
      .sort((a, b) => (a.dayKey < b.dayKey ? 1 : -1))
      .slice(0, Math.max(1, limit))
      .map((d) => ({ ...d, firstAt: formatWhen(d.firstTs), lastAt: formatWhen(d.lastTs) }));
  }

  /**
   * 按天 / 时段 / 区间翻原始记录。
   * @param {{chatKey:string, day?:string, hour?:string, dayFrom?:string, dayTo?:string, offset?:number, limit?:number, query?:string, direction?:'asc'|'desc'}} opts
   */
  load(opts = {}) {
    const chatKey = String(opts.chatKey || '');
    if (!chatKey) return { ok: false, error: '需要 chatKey' };
    const limit = Math.min(80, Math.max(1, Number(opts.limit) || 40));
    const offset = Math.max(0, Number(opts.offset) || 0);
    const direction = opts.direction === 'desc' ? 'desc' : 'asc';
    const day = opts.day ? String(opts.day) : null;
    const hour = opts.hour ? String(opts.hour).slice(0, 13) : null;
    const dayFrom = opts.dayFrom ? String(opts.dayFrom) : null;
    const dayTo = opts.dayTo ? String(opts.dayTo) : null;
    const q = String(opts.query || '').trim().toLowerCase();

    let msgs = this.#all(chatKey);
    if (hour) msgs = msgs.filter((m) => hourKeyOf(m.ts) === hour);
    else if (day) msgs = msgs.filter((m) => dayKeyOf(m.ts) === day);
    else if (dayFrom || dayTo) {
      msgs = msgs.filter((m) => {
        const dk = dayKeyOf(m.ts);
        if (dayFrom && dk < dayFrom) return false;
        if (dayTo && dk > dayTo) return false;
        return true;
      });
    }
    if (q) msgs = msgs.filter((m) => String(m.text || '').toLowerCase().includes(q));
    msgs = msgs.slice().sort((a, b) => Number(a.ts) - Number(b.ts));

    const total = msgs.length;
    if (direction === 'desc') {
      const end = Math.max(0, total - offset);
      const start = Math.max(0, end - limit);
      const page = msgs.slice(start, end).reverse().map(fmtLine);
      return {
        ok: true, chatKey, day: hour || day || null, total, offset, limit, direction,
        returned: page.length, nextOffset: end, hasMore: start > 0,
        note: total === 0 ? '这一天/这段时间没有存档。' : '原始存档切片（不是摘要）；翻更早用 nextOffset。',
        lines: page
      };
    }
    const page = msgs.slice(offset, offset + limit).map(fmtLine);
    return {
      ok: true, chatKey, day: hour || day || null, total, offset, limit, direction,
      returned: page.length, nextOffset: offset + page.length, hasMore: offset + page.length < total,
      note: total === 0 ? '这一天/这段时间没有存档。' : '原始存档切片；接着往后翻用 nextOffset。',
      lines: page
    };
  }

  /** 围绕命中点取前后文（比整块回读更省）。 */
  contextAround({ chatKey, day, hour, anchor = '', before = 8, after = 8, maxChars = 1200 } = {}) {
    if (!chatKey) return { ok: false, error: '需要 chatKey' };
    let msgs = this.#all(chatKey);
    if (hour) msgs = msgs.filter((m) => hourKeyOf(m.ts) === hour);
    else if (day) msgs = msgs.filter((m) => dayKeyOf(m.ts) === day);
    msgs = msgs.slice().sort((a, b) => Number(a.ts) - Number(b.ts));
    if (!msgs.length) return { ok: true, lines: [], note: '该时段无原始存档' };

    let idx = Math.floor(msgs.length / 2);
    const a = String(anchor || '').trim();
    if (a) {
      let best = -1;
      let bestScore = 0;
      for (let i = 0; i < msgs.length; i += 1) {
        const t = String(msgs[i].text || '');
        if (!t) continue;
        let sc = 0;
        if (t.includes(a) || a.includes(t.slice(0, 20))) sc = 100;
        else {
          for (const w of a.match(/[\u4e00-\u9fff]{2}|[a-z0-9]{3,}/g) || []) {
            if (w.length >= 2 && t.includes(w)) sc += 2;
          }
        }
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
      if (best >= 0 && bestScore >= 2) idx = best;
    }
    const start = Math.max(0, idx - Math.max(1, Number(before) || 8));
    const end = Math.min(msgs.length, idx + 1 + Math.max(1, Number(after) || 8));
    let chars = 0;
    const lines = [];
    for (let i = start; i < end; i += 1) {
      const f = fmtLine(msgs[i]);
      const line = `${f.when.slice(5)} ${f.self ? '我' : f.who}: ${f.text}`;
      if (chars + line.length > maxChars) break;
      chars += line.length;
      lines.push(i === idx ? `${line} ◄命中` : line);
    }
    return { ok: true, chatKey, anchorIndex: idx, totalInSlice: msgs.length, lines, note: '命中点附近的原始对话。' };
  }

  /** 某词在原始存档里出现多少条（按消息条数计）。 */
  count({ chatKey, query, day = null, dayFrom = null, dayTo = null, maxSamples = 8 } = {}) {
    const q0 = String(query || '').trim();
    if (!chatKey) return { ok: false, error: '需要 chatKey' };
    if (!q0) return { ok: false, error: 'query 不能为空' };
    const needle = q0.toLowerCase();
    let msgs = this.#all(chatKey);
    if (day) msgs = msgs.filter((m) => dayKeyOf(m.ts) === day);
    else if (dayFrom || dayTo) {
      msgs = msgs.filter((m) => {
        const dk = dayKeyOf(m.ts);
        if (dayFrom && dk < dayFrom) return false;
        if (dayTo && dk > dayTo) return false;
        return true;
      });
    }
    const byDay = new Map();
    const byWho = new Map();
    const samples = [];
    let hitMsgs = 0;
    let occurrences = 0;
    for (const m of msgs) {
      const hay = String(m.text || '').toLowerCase();
      if (!hay.includes(needle)) continue;
      hitMsgs += 1;
      occurrences += Math.max(1, hay.split(needle).length - 1);
      const dk = dayKeyOf(m.ts);
      byDay.set(dk, (byDay.get(dk) || 0) + 1);
      const who = m.self ? '我' : (m.senderName || m.senderId || '?');
      byWho.set(who, (byWho.get(who) || 0) + 1);
      if (samples.length < Math.max(1, maxSamples)) {
        const f = fmtLine(m);
        samples.push({ when: f.when, who: f.who, self: f.self, text: f.text, mid: f.mid, dayKey: dk });
      }
    }
    return {
      ok: true, chatKey, query: q0,
      note: '按「消息条数」计；occurrences 是条内出现总次数。',
      messages: hitMsgs, occurrences, daysTouched: byDay.size,
      byDay: [...byDay.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([d, n]) => ({ dayKey: d, messages: n })),
      byWho: [...byWho.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => ({ who: w, messages: n })),
      samples
    };
  }
}

// 复现探针 2：墓碑复活时 hits 是否继承原块的累计命中数
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LayeredStore } from '../lib/store.js';
import { Consolidator } from '../lib/consolidate.js';
import { GistStore } from '../lib/gist.js';
import { Recall } from '../lib/recall.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlayered-repro2-'));
const messagesDir = path.join(tmp, 'messages');
const root = path.join(tmp, 'memory-v3');
fs.mkdirSync(messagesDir, { recursive: true });

const DAY = 200;
const base = new Date();
base.setDate(base.getDate() - DAY);
base.setHours(10, 0, 0, 0);
const at = (h, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m).getTime();
const chatKey = 'group:888';
const file = path.join(messagesDir, 'group_888.json');
const mkMsg = (id, ts, text) => ({ id, ts, mid: `m${id}`, senderId: '1001', senderName: '阿甲', text, self: false });
fs.writeFileSync(file, JSON.stringify({
  messages: [mkMsg(1, at(10, 0), '那家火锅店真不错'), mkMsg(2, at(10, 5), '下次还去')]
}));

// 第一阶段：forgetAfterDays=0（不淘汰），把库建起来
const settings = () => ({ decayHalfLifeDays: 45, rollupAfterDays: 7, forgetAfterDays: 0, gistEnabled: true });
const store = new LayeredStore(root, settings);
const gist = new GistStore(root, settings);
const con = new Consolidator({ store, messagesDir, settings, gist });

con.consolidateChat(chatKey);
const dayId = store.listBlockIds(chatKey)[0];
console.log('块:', dayId);

// 直接构造"被想起过 20 次、但已经 150 天没人想起"的块（绕开 markHit 动力学）
const meta0 = store.blockMeta(chatKey, dayId);
meta0.hits = 20; meta0.score = 1.0; meta0.S = 45;
meta0.lastHitAt = Date.now() - 150 * 86400000;
store.noteBlock(chatKey, dayId, { hits: 20, score: 1.0, S: 45, lastHitAt: meta0.lastHitAt });
const before = store.blockMeta(chatKey, dayId);
console.log('淘汰前: hits =', before.hits, ' score =', before.score.toFixed(2), ' effective =', store.effectiveScore(before).toFixed(3));

// 淘汰（留墓碑）
const gone = store.forgetSweep(chatKey, { forgetAfterDays: 120, onEvict: (id, meta, block) => gist.remember(chatKey, block, meta) });
console.log('淘汰:', gone, ' 墓碑数:', gist.stats().gists);
const stored = gist.list(chatKey)[0];
console.log('墓碑里存的 hits =', stored.hits, ' score =', Number(stored.score).toFixed(2), ' S =', stored.S);

// 检索命中墓碑 → 复活
const recall = new Recall({ store, settings: () => ({ decayHalfLifeDays: 45, gistEnabled: true }), gistSearch: (q, o) => gist.search(q, o), revive: (k, g) => { console.log('>>> revive 收到的 g.hits =', g.hits, ' score =', g.score, ' S =', g.S); return con.reviveBlock(k, g); } });
const hits = recall.search('火锅店', { chatKey, limit: 3 });
console.log('检索命中:', hits.map((h) => `${h.chunkId} gistOnly=${!!h.gistOnly} revived=${!!h.revivedFromGist}`));
const after = store.blockMeta(chatKey, dayId);
console.log('复活后: hits =', after.hits, ' score =', after.score.toFixed(2), ' S =', after.S);
console.log(after.hits >= before.hits
  ? '✅ hits 正确继承'
  : `❌ BUG：hits 从 ${before.hits} 掉到 ${after.hits} —— 被 gist.search 的检索打分临时值覆盖，reviveBlock 注释承诺的"把当初攒下的记忆强度还给它"对 hits 没兑现`);
fs.rmSync(tmp, { recursive: true, force: true });

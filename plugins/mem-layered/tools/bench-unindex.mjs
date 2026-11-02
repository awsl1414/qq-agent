// 量化探针：unindexBlock 全表扫描 + pruneVocab 的成本随词表的增长
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LayeredStore } from '../lib/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlayered-bench-'));
const root = path.join(tmp, 'memory-v3');
const store = new LayeredStore(root, () => ({}));
const chatKey = 'group:bench';

// 造 N 个块，每块 100 个唯一词 → 词表随块数线性增长
const N = Number(process.argv[2] || 300);
for (let b = 0; b < N; b += 1) {
  const words = Array.from({ length: 100 }, (_, i) => `词${b}_${i}${'x'.repeat((b + i) % 5)}`);
  const snippets = words.map((w, i) => ({ ts: 1700000000000 + b * 3600000 + i * 1000, mid: `m${b}_${i}`, localId: b * 1000 + i, who: '阿甲', uid: '1001', self: false, text: `${w} 聊点别的` }));
  store.writeBlock(chatKey, { id: `hour_bench_${b}`, kind: 'hour', chatKey, dayKey: '2026-01-01', hourKey: '2026-01-01 00', when: 1700000000000 + b * 3600000, title: 't', summary: 's', keywords: words.slice(0, 8), snippets, msgCount: snippets.length });
  store.indexBlock(chatKey, { id: `hour_bench_${b}`, kind: 'hour', chatKey, dayKey: '2026-01-01', hourKey: '2026-01-01 00', when: 1700000000000 + b * 3600000, title: 't', summary: 's', keywords: words.slice(0, 8), snippets, msgCount: snippets.length });
}
const vocab = Object.keys(store.index(chatKey).postings).length;
console.log(`块数=${N} 词表=${vocab}`);

let t = Date.now();
store.unindexBlock(chatKey, 'hour_bench_0', { flush: false });
console.log(`unindexBlock 单次: ${Date.now() - t}ms（每 10 分钟巩固要重索引的块数 × 这个成本）`);

t = Date.now();
store.pruneVocab(chatKey, { maxVocab: 1000000, dfCutoffRatio: 1 });
console.log(`pruneVocab(不剪) 单次: ${Date.now() - t}ms（每个会话每次巩固都跑）`);

t = Date.now();
for (let b = 1; b < N; b += 1) store.unindexBlock(chatKey, `hour_bench_${b}`, { flush: false });
console.log(`全量重索引 ${N - 1} 个块: ${Date.now() - t}ms（= force 重建 / 首日回填的量级）`);
fs.rmSync(tmp, { recursive: true, force: true });

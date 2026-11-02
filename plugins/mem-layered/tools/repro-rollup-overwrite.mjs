// 复现探针：迟到的旧时间戳消息 → rollupChat 是否会覆盖已存在的日块
// 只读插件自身模块，全部在临时目录里跑，不碰宿主。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LayeredStore } from '../lib/store.js';
import { Consolidator } from '../lib/consolidate.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memlayered-repro-'));
const messagesDir = path.join(tmp, 'messages');
const root = path.join(tmp, 'memory-v3');
fs.mkdirSync(messagesDir, { recursive: true });

const DAY = 10; // 10 天前（超过 rollupAfterDays=7，必被汇总）
const base = new Date();
base.setDate(base.getDate() - DAY);
base.setHours(10, 0, 0, 0); // 对齐整点
const at = (h, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m).getTime();

const chatKey = 'group:999';
const file = path.join(messagesDir, 'group_999.json');
const mkMsg = (id, ts, text, senderId = '1001') => ({
  id, ts, mid: `m${id}`, senderId, senderName: `用户${senderId}`, text, self: false
});

// 第一批：10 点、11 点各两条
const batch1 = [
  mkMsg(1, at(10, 0), '今天中午一起去吃火锅吧'),
  mkMsg(2, at(10, 5), '好啊我订位置'),
  mkMsg(3, at(11, 0), '显卡最近涨价了你知道吗'),
  mkMsg(4, at(11, 5), '知道啊郁闷')
];
fs.writeFileSync(file, JSON.stringify({ messages: batch1 }));

const settings = () => ({});
const store = new LayeredStore(root, settings);
const con = new Consolidator({ store, messagesDir, settings });

console.log('--- 第 1 轮巩固（建立小时块）');
console.log(con.consolidateChat(chatKey));
console.log('块文件:', store.listBlockIds(chatKey));

console.log('--- rollup（小时块 → 日块）');
console.log('rolled:', con.rollupChat(chatKey));
console.log('块文件:', store.listBlockIds(chatKey));
const dayId = store.listBlockIds(chatKey).find((id) => id.startsWith('day_'));
const dayBlock1 = store.readBlock(chatKey, dayId);
console.log('日块碎片数:', dayBlock1.snippets.length, '| 内容:', dayBlock1.snippets.map((s) => s.text).join(' / '));

// 第二批：同一天 12 点的"迟到"消息（旧时间戳，晚于 rollup 才到）
const batch2 = [...batch1, mkMsg(5, at(12, 0), '晚上开黑记得叫我')];
fs.writeFileSync(file, JSON.stringify({ messages: batch2 }));

console.log('--- 第 2 轮巩固（迟到消息进小时块）');
console.log(con.consolidateChat(chatKey));
console.log('块文件:', store.listBlockIds(chatKey));
console.log('--- rollup 再次执行');
console.log('rolled:', con.rollupChat(chatKey));
console.log('块文件:', store.listBlockIds(chatKey));

const dayBlock2 = store.readBlock(chatKey, dayId);
console.log('--- 覆盖后的日块碎片数:', dayBlock2.snippets.length);
console.log('内容:', dayBlock2.snippets.map((s) => s.text).join(' / '));
const lost = dayBlock1.snippets.filter((s) => !dayBlock2.snippets.some((n) => n.mid === s.mid));
console.log('--- 丢失的碎片:', lost.map((s) => `${s.mid}:${s.text}`));
console.log(lost.length > 0 ? '❌ 确认 BUG：rollupChat 覆盖了已存在的日块，旧碎片丢失' : '✅ 无问题：日块被正确合并');
fs.rmSync(tmp, { recursive: true, force: true });

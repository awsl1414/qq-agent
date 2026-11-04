// 「已发送到 QQ」补记的判定：工具结果是否明确说了"没发出去"。
//
// 真实故障（已从线上会话数据确认）：send_image 的预览调用返回
//   { content: [{type:'text'},…], sent: false, preview: true }
// 标志位挂在 result 顶层，而旧实现只检查 result.content 的文本，
// 于是预览被判成"没明说 0 条" → 补记一条 [消息 · send_image]。
// 界面显示「已发送到 QQ」，实际一张图都没发出去。
//
// 这里锁定四种形态，任何一处回归都会让"预览被当发送"重现。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportsNothingSent } from '../src/orchestrator.js';

const parts = (text) => [
  { type: 'text', text },
  { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } }
];

test('预览：顶层 sent:false 必须被识别为"没发出去"', () => {
  const result = { content: parts('这张图（image/jpeg，约 190KB）——觉得合适就立刻调 send_image(url) 发出去'), sent: false, preview: true };
  assert.equal(reportsNothingSent(result), true,
    'content 里没有 "sent":false，标志位在顶层——旧实现正是在这里漏判');
});

test('真发送：顶层 sent:true 不算"没发出去"', () => {
  assert.equal(reportsNothingSent({ content: '图片已发送。', sent: true }), false);
});

test('ok() 包装：content 里的 "sent":false 仍被识别', () => {
  assert.equal(reportsNothingSent({ content: '{"sent":false,"note":"全部去重"}' }), true);
  assert.equal(reportsNothingSent({ content: '{"sent":0}' }), true);
});

test('普通文本结果不算"没发出去"', () => {
  assert.equal(reportsNothingSent({ content: '已发送 3 张图片' }), false);
  assert.equal(reportsNothingSent({ content: parts('图片已发出') }), false);
});

test('delivered 字段与字符串形态同样生效', () => {
  assert.equal(reportsNothingSent({ content: 'x', delivered: false }), true);
  assert.equal(reportsNothingSent({ content: '{"delivered":0}' }), true);
  assert.equal(reportsNothingSent({ content: 'x', delivered: true }), false);
});

test('空/异常输入不误判', () => {
  assert.equal(reportsNothingSent({}), false);
  assert.equal(reportsNothingSent(null), false);
  assert.equal(reportsNothingSent(undefined), false);
  assert.equal(reportsNothingSent({ content: null }), false);
});

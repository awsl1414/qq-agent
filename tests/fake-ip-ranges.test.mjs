// 代理 fake-ip 网段与真实内网网段的判定边界（不联网）。
//
// 背景：Clash Verge Rev 的 TUN + fake-ip 模式把任意域名解析到
// 198.18.0.1/16（IPv4）与 2001:2::/64（IPv6），这两段是 RFC 2544 / RFC 5180
// 的基准测试保留段。原实现把它们归入 isPrivateIp，导致所有网页抓取与图片搜索
// 被 SSRF 防护拒绝（"域名解析到内网/本机地址，已阻止"）。
//
// 关键安全约束：把基准测试段移出内网分类，不能让任何真实内网段漏判。
// 下面的回归断言逐项钉住这一点。
//
// 运行：node --test tests/fake-ip-ranges.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { isPrivateIp, isProxyFakeIp } = await import('../src/safe-fetch.js');

test('isProxyFakeIp：RFC 2544 的 198.18.0.0/15 整段命中', () => {
  for (const ip of ['198.18.0.0', '198.18.0.156', '198.18.255.255', '198.19.0.0', '198.19.255.255']) {
    assert.equal(isProxyFakeIp(ip), true, ip);
  }
});

test('isProxyFakeIp：段外 IPv4 一律不命中', () => {
  for (const ip of ['198.20.0.1', '198.17.255.255', '192.168.1.1', '127.0.0.1', '10.0.0.1', '2001:db8::1']) {
    assert.equal(isProxyFakeIp(ip), false, ip);
  }
});

test('isProxyFakeIp：RFC 5180 的 2001:2::/48 命中，相邻段不命中', () => {
  for (const ip of ['2001:2::9e', '2001:2::', '2001:2:0:ffff::1']) {
    assert.equal(isProxyFakeIp(ip), true, ip);
  }
  for (const ip of ['2001:3::1', '2001:db8::1', '2001:2:1::1', '::1']) {
    assert.equal(isProxyFakeIp(ip), false, ip);
  }
});

test('isProxyFakeIp：方括号写法与非法输入', () => {
  assert.equal(isProxyFakeIp('[2001:2::9e]'), true);
  assert.equal(isProxyFakeIp(''), false);
  assert.equal(isProxyFakeIp(null), false);
  assert.equal(isProxyFakeIp('not-an-ip'), false);
});

test('isProxyFakeIp：内嵌 IPv4 按内嵌地址判定', () => {
  assert.equal(isProxyFakeIp('::ffff:198.18.0.1'), true);
  assert.equal(isProxyFakeIp('::ffff:192.168.1.1'), false);
});

test('isProxyFakeIp：6to4（2002::/16）内嵌 IPv4 按内嵌地址判定', () => {
  // 6to4 与 isPrivateIp 共用同一个提取函数（ipv4From6to4）：内嵌 fake-ip 命中，
  // 内嵌内网仍由 isPrivateIp 拦，内嵌公网两者都不拦。
  assert.equal(isProxyFakeIp('2002:c612:1::1'), true);    // 198.18.0.1
  assert.equal(isProxyFakeIp('2002:7f00:1::1'), false);   // 127.0.0.1
  assert.equal(isProxyFakeIp('2002:0808:0808::1'), false); // 8.8.8.8
  assert.equal(isPrivateIp('2002:7f00:1::1'), true);
  assert.equal(isPrivateIp('2002:c612:1::1'), false);
  assert.equal(isPrivateIp('2002:0808:0808::1'), false);
});

// ── 安全回归：真实内网段一条都不能漏 ──────────────────────────────────
test('isPrivateIp 安全回归：IPv4 内网/本机/链路本地/CGNAT/保留/组播全部仍为 true', () => {
  const privates = [
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.20.0.1', '172.31.255.255',
    '192.168.1.5', '169.254.1.1', '100.64.0.1', '100.127.255.255', '0.0.0.0',
    '192.0.0.1', '224.0.0.1', '239.255.255.255', '255.255.255.255'
  ];
  for (const ip of privates) assert.equal(isPrivateIp(ip), true, ip);
});

test('isPrivateIp 安全回归：私网段外沿仍为 false（证明没有整段放宽）', () => {
  for (const ip of ['172.15.255.255', '172.32.0.0', '100.63.255.255', '100.128.0.0', '11.0.0.1', '192.169.0.1']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('isPrivateIp 安全回归：IPv6 本机/ULA/链路本地/文档段全部仍为 true', () => {
  const privates = ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1', '2001:db8::1'];
  for (const ip of privates) assert.equal(isPrivateIp(ip), true, ip);
});

// 2001:10::/28（ORCHID）与 2001:20::/28（ORCHIDv2）是 IANA 保留段，任何形态都必须拦。
// 实现按字面前缀 `2001:10:` / `2001:20:` 判断，所以这里只断言该实现覆盖的形态：
// 这两条断言的职责是「删掉对应判定就变红」，不是证明 /28 全段覆盖
// （2001:11::–2001:1f:: 不在字面前缀内，属已知缺口，见交付报告）。
test('isPrivateIp 安全回归：2001:10::/28 与 2001:20::/28 的 ORCHID 保留段仍为 true', () => {
  for (const ip of ['2001:10::1', '2001:10:ffff::1', '2001:20::1', '2001:20:ffff::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  // 相邻段不误伤
  for (const ip of ['2001:30::1', '2001:1::1', '2001:db8::1']) {
    assert.equal(isPrivateIp(ip), ip === '2001:db8::1', ip);
  }
});

test('isPrivateIp：基准测试段已移出内网分类', () => {
  assert.equal(isPrivateIp('198.18.0.156'), false);
  assert.equal(isPrivateIp('198.18.0.0'), false);
  assert.equal(isPrivateIp('198.19.255.255'), false);
  assert.equal(isPrivateIp('2001:2::9e'), false);
  assert.equal(isPrivateIp('2001:2::'), false);
});

test('isPrivateIp：IPv4-mapped / 内嵌形态按内嵌地址判定', () => {
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIp('::ffff:198.18.0.1'), false);
  assert.equal(isPrivateIp('::ffff:192.168.1.1'), true);
  // 6to4 内嵌内网地址仍拦
  assert.equal(isPrivateIp('2002:c0a8:101::1'), true);
  assert.equal(isPrivateIp('2002:c612:1::1'), false);
});

test('两个判定集合互不重叠（fake-ip 地址不再是"内网"）', () => {
  for (const ip of ['198.18.0.156', '198.19.1.1', '2001:2::9e']) {
    assert.equal(isProxyFakeIp(ip), true, ip);
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

// ffmpeg 下载源拼接与安装前置条件
//
// ffmpeg 改为按需下载后，有两条容易回归的约束：
//   ① 下载源前缀拼接要对，用户填不填尾斜杠都得拼对，否则下载 404
//   ② Token 只发给 github.com / api.github.com，绝不能发给镜像站
//      （镜像站是第三方，把 Token 递过去等于把凭据交给它）
// 这里钉住这两条，外加校验值常量与 zip 兜底路径的存在性。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), `qqa-ffsetup-${process.pid}-${Date.now()}`);
process.env.QQ_AGENT_DATA_DIR = TMP;
fs.mkdirSync(TMP, { recursive: true });

const setup = await import('../src/ffmpeg-setup.js');
const resolve = await import('../src/ffmpeg-resolve.js');

const OFFICIAL = `https://github.com/GyanD/codexffmpeg/releases/download/${resolve.FFMPEG_VERSION}/`;

test('assetUrl：默认源是 yylx', () => {
  assert.equal(setup.assetUrl('a.7z'), `https://git.yylx.win/${OFFICIAL}a.7z`);
});

test('assetUrl：gh-proxy 前缀拼在官方地址前面', () => {
  const u = setup.assetUrl('a.7z', { mirror: 'gh-proxy' });
  assert.equal(u, `https://gh-proxy.org/${OFFICIAL}a.7z`);
});

test('assetUrl：yylx 前缀拼在官方地址前面', () => {
  const u = setup.assetUrl('a.7z', { mirror: 'yylx' });
  assert.equal(u, `https://git.yylx.win/${OFFICIAL}a.7z`);
});

test('镜像表里的每一项都是「前缀 + 完整 GitHub 地址」形态', () => {
  // 加新镜像时最容易犯的错：漏尾斜杠、或写成域名替换式（git.yylx.win/GyanD/…）。
  // 后者实测 404，这个站只认完整 GitHub 地址拼在后面。
  for (const [key, prefix] of Object.entries(setup.MIRRORS)) {
    if (!prefix) continue;   // direct 是空前缀
    assert.ok(prefix.endsWith('/'), `${key} 的前缀应以 / 结尾：${prefix}`);
    assert.match(prefix, /^https:\/\//, `${key} 应使用 https`);
  }
  assert.ok(setup.MIRRORS.yylx, 'MIRRORS 里应有 yylx');
  assert.ok(setup.MIRRORS['gh-proxy'], 'MIRRORS 里应有 gh-proxy');
});

test('assetUrl：direct 不加任何前缀', () => {
  assert.equal(setup.assetUrl('a.7z', { mirror: 'direct' }), `${OFFICIAL}a.7z`);
});

test('assetUrl：自定义前缀缺尾斜杠也能拼对', () => {
  const withSlash = setup.assetUrl('a.7z', { mirror: 'custom', customMirror: 'https://example.org/' });
  const without = setup.assetUrl('a.7z', { mirror: 'custom', customMirror: 'https://example.org' });
  assert.equal(withSlash, `https://example.org/${OFFICIAL}a.7z`);
  assert.equal(without, withSlash, '有没有尾斜杠应拼出同一个地址');
});

test('assetUrl：自定义前缀为空时退回官方直连（不拼出半截地址）', () => {
  assert.equal(setup.assetUrl('a.7z', { mirror: 'custom', customMirror: '' }), `${OFFICIAL}a.7z`);
});

test('assetUrl：未知 mirror 值按默认源处理（配置写坏时不至于下不动）', () => {
  assert.equal(setup.assetUrl('a.7z', { mirror: 'nonsense' }), `https://git.yylx.win/${OFFICIAL}a.7z`);
});

test('DEFAULT_MIRROR 在 MIRRORS 里，且是 yylx', () => {
  assert.equal(setup.DEFAULT_MIRROR, 'yylx');
  assert.ok(setup.MIRRORS[setup.DEFAULT_MIRROR], '默认源必须存在于 MIRRORS 表中');
});

test('isValidMirrorPrefix：只认 http(s)', () => {
  assert.equal(setup.isValidMirrorPrefix('https://gh-proxy.org/'), true);
  assert.equal(setup.isValidMirrorPrefix('http://127.0.0.1:8080/'), true);
  assert.equal(setup.isValidMirrorPrefix('ftp://x.org'), false);
  assert.equal(setup.isValidMirrorPrefix('gh-proxy.org'), false);
  assert.equal(setup.isValidMirrorPrefix(''), false);
  assert.equal(setup.isValidMirrorPrefix(null), false);
});

test('下载源里不能出现 Token 的痕迹（前缀只由用户配置拼出）', () => {
  // 这条是回归哨兵：如果将来有人图省事把 Token 拼进 URL，这里会立刻炸。
  const u = setup.assetUrl('a.7z', { mirror: 'gh-proxy' });
  assert.ok(!/token|authorization|ghp_/i.test(u), `下载地址里不应含凭据：${u}`);
});

test('tarPath：Windows 上必须指向 System32（Git 的 GNU tar 读不了 7z/zip）', () => {
  if (process.platform !== 'win32') return;
  const p = setup.tarPath();
  assert.match(p, /System32[\\/]tar\.exe$/i, `应使用系统自带 bsdtar，实际 ${p}`);
  assert.ok(fs.existsSync(p), '系统 tar.exe 应存在');
});

test('两个格式都准备了校验值（7z 失败要能自动降级到 zip）', () => {
  assert.ok(resolve.FFMPEG_ASSETS.win32['7z'], 'win32 资产组里应有 7z');
  assert.ok(resolve.FFMPEG_ASSETS.win32.zip, 'win32 资产组里应有 zip');
  assert.notEqual(
    resolve.FFMPEG_ASSETS.win32['7z'].sha256,
    resolve.FFMPEG_ASSETS.win32.zip.sha256,
    '7z 与 zip 是不同格式，校验值不应相同'
  );
});

test('Linux x64 资产指向 amd64 发布包（架构拼错会下到别的包或 404）', () => {
  const a = resolve.FFMPEG_ASSETS.linux.x64.ffmpeg;
  assert.ok(a, 'linux.x64 资产组里应有 ffmpeg');
  assert.match(a.url, /^https:\/\//, `Linux 资产应走 https：${a.url}`);
  assert.ok(a.url.includes('linux/amd64'), `x64 资产应指向 linux/amd64，实际 ${a.url}`);
});

test('sha256OfFile：对已知内容算出正确摘要', async () => {
  const f = path.join(TMP, 'probe.txt');
  fs.writeFileSync(f, 'abc');
  // SHA-256("abc") 的标准值
  assert.equal(
    await setup.sha256OfFile(f),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  );
});

test('setupStatus 初始形态字段齐全（UI 靠它渲染进度）', () => {
  const s = setup.setupStatus();
  for (const k of ['running', 'step', 'channel', 'received', 'total', 'error', 'ok']) {
    assert.ok(k in s, `缺少字段 ${k}`);
  }
  assert.equal(typeof s.running, 'boolean');
});

// ── 通道决策：镜像 × 代理 的组合表 ──────────────────────────────────────
// 这两件事正交，组合错会互相拖后腿（代理 → 镜像 → GitHub 多绕一跳）。
// resolveDownloadRoute 把决策收在一处，这里逐格钉住。
//
// 代理探测依赖本机环境，所以用 __setProxyProbeForTest 注入固定值。
// 直接改写模块导出的属性会在 ESM 下抛 "Cannot redefine property"。
const originalProxyProbe = setup.__getProxyProbeForTest();

function withProxy(value, fn) {
  setup.__setProxyProbeForTest(async () => value);
  return Promise.resolve(fn()).finally(() => setup.__setProxyProbeForTest(originalProxyProbe));
}

test('通道：有代理 + 选镜像 → 走官方直连（镜像让位，避免多绕一跳）', () =>
  withProxy('http://127.0.0.1:7897', async () => {
    const r = await setup.resolveDownloadRoute('a.7z', { mirror: 'gh-proxy' });
    assert.equal(r.url, `${OFFICIAL}a.7z`, '有代理时不该再拼镜像前缀');
    assert.equal(r.proxy, 'http://127.0.0.1:7897');
  }));

test('通道：无代理 + 选镜像 → 走镜像', () =>
  withProxy('', async () => {
    const r = await setup.resolveDownloadRoute('a.7z', { mirror: 'gh-proxy' });
    assert.equal(r.url, `https://gh-proxy.org/${OFFICIAL}a.7z`);
    assert.equal(r.proxy, '');
  }));

test('通道：无代理 + 选 yylx → 走 yylx', () =>
  withProxy('', async () => {
    const r = await setup.resolveDownloadRoute('a.7z', { mirror: 'yylx' });
    assert.equal(r.url, `https://git.yylx.win/${OFFICIAL}a.7z`);
    assert.equal(r.proxy, '');
  }));

test('通道：有代理时 yylx 也让位给官方直连', () =>
  withProxy('http://127.0.0.1:7897', async () => {
    const r = await setup.resolveDownloadRoute('a.7z', { mirror: 'yylx' });
    assert.equal(r.url, `${OFFICIAL}a.7z`, '有代理时任何镜像都让位');
  }));

test('通道：无代理 + 选直连 → 官方地址，且说明可能慢', () =>
  withProxy('', async () => {
    const r = await setup.resolveDownloadRoute('a.7z', { mirror: 'direct' });
    assert.equal(r.url, `${OFFICIAL}a.7z`);
    assert.match(r.reason, /较慢/);
  }));

test('通道：自定义源始终按用户填的前缀，代理照用（可能是内网镜像）', () =>
  withProxy('http://127.0.0.1:7897', async () => {
    const r = await setup.resolveDownloadRoute('a.7z', { mirror: 'custom', customMirror: 'https://mirror.example/' });
    assert.equal(r.url, `https://mirror.example/${OFFICIAL}a.7z`);
    assert.equal(r.proxy, 'http://127.0.0.1:7897', '自定义源也可能需要代理（内网镜像）');
  }));

test('通道：自定义源无代理时也不拼镜像', () =>
  withProxy('', async () => {
    const r = await setup.resolveDownloadRoute('a.7z', { mirror: 'custom', customMirror: 'https://mirror.example/' });
    assert.equal(r.url, `https://mirror.example/${OFFICIAL}a.7z`);
    assert.equal(r.proxy, '');
  }));

// ── GitHub Token：只发给 GitHub 自己的主机 ────────────────────────────────
// 这个设置项存在的理由是「代理节点是共享出口 IP，匿名请求按 IP 限流 60 次/小时，
// 带 Token 后按 Token 计额度 5000 次/小时」。它是用户凭据，绝不能外发。

test('githubAuthHeaders：github.com 系主机带 Bearer', () => {
  for (const u of [
    'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/a.7z',
    'https://api.github.com/repos/GyanD/codexffmpeg/releases/latest',
    'https://objects.githubusercontent.com/x/y',
    'https://release-assets.githubusercontent.com/x',
    'https://codeload.github.com/x/y'
  ]) {
    assert.deepEqual(setup.githubAuthHeaders(u, 'ghp_test'), { authorization: 'Bearer ghp_test' }, u);
  }
});

test('githubAuthHeaders：镜像站绝不带 Token（前缀形态里含 github.com 也不行）', () => {
  const official = `https://github.com/GyanD/codexffmpeg/releases/download/${resolve.FFMPEG_VERSION}/a.7z`;
  for (const prefix of Object.values(setup.MIRRORS)) {
    if (!prefix) continue;
    const u = `${prefix}${official}`;
    assert.equal(setup.githubAuthHeaders(u, 'ghp_test'), null, `镜像站不该收到 Token：${u}`);
  }
});

test('githubAuthHeaders：相似域名不能被误判为 GitHub', () => {
  for (const u of [
    'https://github.com.evil.example/x',
    'https://notgithub.com/x',
    'https://github.com.cn/x',
    'https://evil.example/?u=https://github.com/'
  ]) {
    assert.equal(setup.githubAuthHeaders(u, 'ghp_test'), null, u);
  }
});

test('githubAuthHeaders：token 为空 / 地址非法时返回 null', () => {
  assert.equal(setup.githubAuthHeaders('https://github.com/x', ''), null);
  assert.equal(setup.githubAuthHeaders('https://github.com/x', '   '), null);
  assert.equal(setup.githubAuthHeaders('not a url', 'ghp_test'), null);
});

test('镜像站 URL 里不会出现 Token 的任何形态', () => {
  // 回归哨兵：如果将来有人图省事把 Token 拼进 URL 或统一传 headers，这里会炸。
  const official = `https://github.com/GyanD/codexffmpeg/releases/download/${resolve.FFMPEG_VERSION}/a.7z`;
  for (const prefix of Object.values(setup.MIRRORS)) {
    if (!prefix) continue;
    assert.ok(!/token|authorization|ghp_/i.test(`${prefix}${official}`));
  }
});

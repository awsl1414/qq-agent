import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const mainUrl = new URL('../electron/main.js', import.meta.url);
const source = fs.readFileSync(mainUrl, 'utf8');

// 直接运行入口中的路径与日志函数，避免为测试加载 Electron、创建窗口和启动服务器。
function mainFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `缺少 ${name}`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(end, -1, `${name} 缺少函数结尾`);
  return source.slice(start, end + 2).replaceAll('import.meta.url', 'mainUrl');
}

const renderStart = source.indexOf('const RENDER_DATA_DIR =');
const renderEnd = source.indexOf('const RENDER_GPU_OFF_FLAG =', renderStart);
assert.ok(renderStart >= 0 && renderEnd > renderStart);
const probeStart = source.indexOf('    if (gotLock) {', source.indexOf('app.whenReady().then(async () => {'));
const probeEnd = source.indexOf('    // 崩溃证据链', probeStart);
assert.ok(probeStart >= 0 && probeEnd > probeStart);

function harness({
  isPackaged = true, platform = 'win32', profile = '', env = {},
  userData = path.join(os.tmpdir(), 'qq-agent-user-data'),
  exe = path.join(os.tmpdir(), 'qq-agent-portable', 'QQ Agent.exe'),
  installed = true, pathApi = path, fsApi = {}
} = {}) {
  const errors = [];
  const exits = [];
  const processApi = { platform, arch: 'x64', argv: [exe], pid: 123, env: { ...env } };
  const context = vm.createContext({
    app: {
      isPackaged,
      getName: () => 'qq-agent',
      getVersion: () => 'test',
      exit: code => exits.push(code),
      getPath: name => {
        if (name === 'userData') return userData;
        if (name === 'exe') return exe;
        throw new Error(`Unexpected app path: ${name}`);
      }
    },
    process: processApi,
    path: pathApi,
    fs: {
      existsSync: file => installed && file === pathApi.join(pathApi.dirname(exe), 'Uninstall QQ Agent.exe'),
      ...fsApi
    },
    dialog: { showErrorBox: (title, message) => errors.push({ title, message }) },
    console: { error() {} },
    gotLock: true,
    fileURLToPath, mainUrl: mainUrl.href,
    dataDirName: () => profile ? `data-${profile}` : 'data'
  });
  const api = vm.runInContext([
    ...['isPortableInstall', 'packagedDataDir', 'resolveDataDir', 'fallbackLog',
      'describeError', 'probeDataDirWritable', 'reportDataDirFailure'].map(mainFunction),
    source.slice(renderStart, renderEnd),
    `function runStartupProbe() { ${source.slice(probeStart, probeEnd)} return true; }`,
    '({ isPortableInstall, packagedDataDir, resolveDataDir, fallbackLog, runStartupProbe, RENDER_DATA_DIR })'
  ].join('\n'), context);
  // 与入口接线一致：启动自检读取的是解析后写回环境变量的数据目录。
  processApi.env.QQ_AGENT_DATA_DIR = api.resolveDataDir();
  return { ...api, errors, exits, env: processApi.env };
}

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} 安装版：有卸载器时使用 userData，并保留多实例后缀`, () => {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const userData = platform === 'win32' ? 'C:\\Users\\tester\\AppData\\Roaming\\qq-agent' : '/home/tester/qq-agent';
    for (const profile of ['', '2']) {
      const h = harness({ platform, pathApi, userData, profile });
      const expected = pathApi.join(userData, profile ? `data-${profile}` : 'data');
      assert.equal(h.isPortableInstall(), false);
      assert.equal(h.packagedDataDir(), expected);
      assert.equal(h.resolveDataDir(), expected);
      assert.equal(h.RENDER_DATA_DIR, expected);
    }
  });

  test(`${platform} 无卸载器时：仅 Windows 走便携，其余平台仍用 userData`, () => {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const exe = platform === 'win32' ? 'D:\\Tools\\QQ Agent\\QQ Agent.exe' : '/home/tester/qq-agent/qq-agent';
    // 显式传入与平台匹配的 userData，避免落到宿主平台的 os.tmpdir() 路径。
    const userDataRoot = platform === 'win32' ? 'C:\\Users\\tester\\AppData\\Roaming\\qq-agent' : '/home/tester/.config/qq-agent';
    for (const profile of ['', '2']) {
      const h = harness({ platform, pathApi, exe, profile, installed: false, userData: userDataRoot });
      const portable = pathApi.join(pathApi.dirname(exe), profile ? `data-${profile}` : 'data');
      const userData = pathApi.join(userDataRoot, profile ? `data-${profile}` : 'data');
      if (platform === 'win32') {
        // 便携语义只存在于 Windows 的 zip 分发。
        assert.equal(h.isPortableInstall(), true);
        assert.equal(h.packagedDataDir(), portable);
        assert.equal(h.resolveDataDir(), portable);
        assert.equal(h.RENDER_DATA_DIR, portable);
      } else {
        // macOS 的 .app 与 Linux 的 AppImage 没有"解压即用"形态，判成便携会把
        // 数据写进只读挂载点，启动即失败。
        assert.equal(h.isPortableInstall(), false);
        assert.equal(h.packagedDataDir(), userData);
        assert.equal(h.resolveDataDir(), userData);
        assert.equal(h.RENDER_DATA_DIR, userData);
      }
    }
  });
}

test('开发态：使用项目内 data，保留多实例后缀', () => {
  for (const profile of ['', '2']) {
    const h = harness({ isPackaged: false, profile, fsApi: {
      existsSync() { assert.fail('开发态不应检测卸载器'); }
    } });
    const expected = fileURLToPath(new URL(profile ? '../data-2' : '../data', import.meta.url));
    assert.equal(h.packagedDataDir(), expected);
    assert.equal(h.resolveDataDir(), expected);
    assert.equal(h.RENDER_DATA_DIR, expected);
  }
});

test('环境变量覆盖优先于打包态、开发态和 profile，渲染与日志使用同一目录', () => {
  for (const isPackaged of [true, false]) {
    for (const installed of [true, false]) {
      const override = path.join(os.tmpdir(), 'qq-agent-portable-data');
      const writes = [];
      const h = harness({
        isPackaged, installed, profile: '2', env: { QQ_AGENT_DATA_DIR: override },
        fsApi: {
          existsSync() { assert.fail('环境变量覆盖时不应检测卸载器'); },
          mkdirSync() {},
          appendFileSync: (file, content) => writes.push({ file, content })
        }
      });
      assert.equal(h.resolveDataDir(), override);
      assert.equal(h.RENDER_DATA_DIR, override);
      h.fallbackLog('ERROR', 'test', 'portable');
      assert.equal(writes.length, 1);
      assert.equal(writes[0].file, path.join(override, 'logs', 'boot-fallback.log'));
    }
  }
});

for (const installed of [true, false]) {
  test(`未设置环境变量时，${installed ? '安装版' : '便携版'}兜底日志跟随数据目录`, () => {
    const writes = [];
    const userData = path.join(os.tmpdir(), 'qq-agent-user-data');
    const exe = path.join(os.tmpdir(), 'qq-agent-portable', 'QQ Agent.exe');
    const h = harness({
      installed, userData, exe, profile: '2',
      fsApi: { mkdirSync() {}, appendFileSync: file => writes.push(file) }
    });
    delete h.env.QQ_AGENT_DATA_DIR;
    h.fallbackLog('ERROR', 'test', 'default');
    const base = installed ? userData : path.dirname(exe);
    assert.deepEqual(writes, [path.join(base, 'data-2', 'logs', 'boot-fallback.log')]);
  });
}

for (const failureAt of ['mkdir', 'write']) {
  test(`便携目录 ${failureAt} 不可写：明确报错退出，不回退业务数据目录`, () => {
    const exe = 'C:\\Program Files\\QQ Agent\\QQ Agent.exe';
    const userData = 'C:\\Users\\tester\\AppData\\Roaming\\qq-agent';
    const dataDir = path.win32.join(path.win32.dirname(exe), 'data-2');
    const created = [];
    const writes = [];
    const h = harness({
      exe, userData, pathApi: path.win32, installed: false, profile: '2',
      fsApi: {
        mkdirSync(dir) {
          created.push(dir);
          if (dir === dataDir && failureAt === 'mkdir') throw new Error('EACCES: permission denied');
        },
        writeFileSync(file) {
          writes.push(file);
          throw new Error('EACCES: permission denied');
        },
        appendFileSync: file => writes.push(file)
      }
    });
    assert.equal(h.runStartupProbe(), undefined, '写入失败应在业务启动前返回');
    assert.deepEqual(h.exits, [2]);
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].title, 'QQ Agent 无法启动');
    assert.ok(h.errors[0].message.includes('便携版需要可写的安装目录，当前目录不可写：'));
    assert.ok(h.errors[0].message.includes(path.win32.dirname(exe)));
    assert.ok(h.errors[0].message.includes('请把程序移到用户目录（如 D:\\Tools\\QQ Agent）'));
    assert.ok(h.errors[0].message.includes('或改用安装版（数据会存在 %APPDATA%\\qq-agent）'));
    assert.equal(h.env.QQ_AGENT_DATA_DIR, dataDir);
    assert.equal(h.resolveDataDir(), dataDir);
    assert.deepEqual(created, [dataDir, userData]);
    assert.deepEqual(writes, [
      ...(failureAt === 'write' ? [path.win32.join(dataDir, '.write-probe-123')] : []),
      path.win32.join(userData, 'data-dir-error.log')
    ], 'userData 只允许写诊断文件，不创建替代业务数据目录');
  });
}

test('便携版的环境变量覆盖目录不可写：保留覆盖路径并提示环境变量问题', () => {
  const override = path.join(os.tmpdir(), 'readonly-override');
  const h = harness({ installed: false, env: { QQ_AGENT_DATA_DIR: override }, fsApi: {
    mkdirSync() { throw new Error('EACCES: permission denied'); }
  } });
  assert.equal(h.runStartupProbe(), undefined);
  assert.deepEqual(h.exits, [2]);
  assert.equal(h.env.QQ_AGENT_DATA_DIR, override);
  assert.ok(h.errors[0].message.includes(override));
  assert.ok(h.errors[0].message.includes('QQ_AGENT_DATA_DIR 指向了'));
  assert.ok(!h.errors[0].message.includes('便携版需要可写的安装目录'));
});

test('可写便携目录通过启动自检并删除探测文件', () => {
  const removed = [];
  const h = harness({ installed: false, fsApi: {
    mkdirSync() {}, writeFileSync() {}, unlinkSync: file => removed.push(file)
  } });
  assert.equal(h.runStartupProbe(), true);
  assert.deepEqual(h.exits, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(removed, [path.join(h.resolveDataDir(), '.write-probe-123')]);
});


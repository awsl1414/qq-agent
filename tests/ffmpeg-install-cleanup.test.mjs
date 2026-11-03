import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-install-cleanup-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
// 执行真实私有安装函数，省去下载与运行外部二进制；文件操作使用真实临时目录。
const source = fs.readFileSync(new URL('../src/ffmpeg-setup.js', import.meta.url), 'utf8');
const start = source.indexOf('function installBinaries(found)');
const end = source.indexOf('/** 删除已下载的那份', start);
const exeName = (name) => process.platform === 'win32' ? `${name}.exe` : name;

test('ffprobe 复制失败清除安装暂存目录并保留旧 ffmpeg', () => {
  const dest = path.join(temp, 'bin');
  fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, exeName('ffmpeg')), 'old');
  const extracted = path.join(temp, 'extracted-ffmpeg');
  fs.writeFileSync(extracted, 'new');
  const install = vm.runInNewContext(`(${source.slice(start, end)})`, {
    fs, path, process, state: {}, managedBinDir: () => dest, exeName
  });
  const result = install({ ffmpeg: extracted, ffprobe: path.join(temp, 'missing-ffprobe') });
  assert.equal(result.ok, false);
  assert.match(result.error, /安装失败/);
  assert.equal(fs.readFileSync(path.join(dest, exeName('ffmpeg')), 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(temp).sort(), ['bin', 'extracted-ffmpeg']);
});

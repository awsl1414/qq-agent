// 子进程执行助手（移植自 zcode-beautify MIT，https://github.com/Logocceai/zcode-beautify）
// promisified execFile：非零退出码按错误抛（带 stdout/stderr），带超时与输出上限。
import { execFile } from 'node:child_process';

export function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      windowsHide: true,
      timeout: opts.timeout ?? 60_000,
      maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024,
      ...opts
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
      } else {
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      }
    });
  });
}

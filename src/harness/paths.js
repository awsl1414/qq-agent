import path from 'node:path';

/** 源码目录就是项目根；仅 resources/app 安装布局需要向上取安装根。 */
export function harnessProjectRoot(appRoot) {
  const root = path.resolve(appRoot);
  return path.basename(root).toLowerCase() === 'app' && path.basename(path.dirname(root)).toLowerCase() === 'resources'
    ? path.dirname(path.dirname(root))
    : root;
}

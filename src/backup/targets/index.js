// 备份目标适配器：注册位 + 工厂。
//
// 统一接口（所有适配器必须实现，后续 WebDAV / S3 两个 worker 按此对齐）：
//
//   @typedef {object} BackupTarget
//   @property {string} type                     'local' | 'webdav' | 's3'
//   @property {() => Promise<{ok:boolean,message:string,detail?:any}>} test
//   @property {() => Promise<Array<{key:string,size:number,mtimeMs:number}>>} list
//   @property {(key:string, buffer:Buffer) => Promise<void>} put
//   @property {(key:string) => Promise<Buffer>} get
//   @property {(key:string) => Promise<void>} remove
//
// 约定：
//   · key 是目标内的相对路径，形如 qq-agent/backup-20261103-0300.qqab；
//   · test() 永不抛错，失败以 { ok:false, message } 返回（界面要直接展示）；
//   · list() 返回目标里实际存在的文件，mtimeMs 不能取到时给 0；
//   · put/get/remove 失败抛错，由 index.js 聚合成逐目标的结果。
import { createLocalTarget } from './local.js';
import { createWebdavTarget } from './webdav.js';
import { createS3Target } from './s3.js';
import { decryptCredential } from '../crypto.js';

/** 已实现的适配器构造函数。新增类型只需往这里加一行。 */
const ADAPTERS = new Map([
  ['local', createLocalTarget],
  ['webdav', createWebdavTarget],
  ['s3', createS3Target]
]);

/** 预留但尚未实现的类型：工厂仍返回一个适配器，调用时才明确报 not-implemented。 */
const RESERVED_TYPES = [];

export const TARGET_TYPES = [...ADAPTERS.keys(), ...RESERVED_TYPES];

export class TargetNotImplementedError extends Error {
  constructor(type) {
    super(`备份目标类型「${type}」尚未实现（${RESERVED_TYPES.join(' / ')} 由后续版本提供）`);
    this.name = 'TargetNotImplementedError';
    this.code = 'not-implemented';
    this.type = type;
  }
}

function notImplementedTarget(type) {
  const fail = async () => { throw new TargetNotImplementedError(type); };
  return {
    type,
    // test() 的契约是"不抛错"，所以这里把 not-implemented 折成 ok:false，
    // 让设置页的「测试连接」按钮给出可读提示，而不是一个未捕获异常。
    test: async () => ({ ok: false, message: new TargetNotImplementedError(type).message }),
    list: fail,
    put: fail,
    get: fail,
    remove: fail
  };
}

/**
 * 由配置项创建适配器。
 *
 * 凭据在这一层统一解封：配置里存的是密文（crypto.js 的 encryptCredential），
 * 适配器只该拿到明文。曾经 S3 自己调 decryptCredential、WebDAV 却要求调用方
 * 传明文 password —— 同一个概念两种口径，结果是 WebDAV 永远用空密码认证，
 * 而且失败信息看起来像"服务器拒绝"，排查会绕远路。
 *
 * 解封失败不在这里抛：适配器的 test() 契约是"永不抛错、以 ok:false 汇报"，
 * 提前抛会让设置页的「测试连接」变成未捕获异常。把失败标记带下去，由适配器
 * 在自己的错误路径里转成可读消息。
 *
 * @param {{id?:string, type?:string, [key:string]:any}} entry config.backup.targets[] 的一项
 * @returns {BackupTarget}
 */
export function createTarget(entry = {}) {
  const type = String(entry?.type || '').trim();
  if (!type) throw new Error('备份目标缺少 type');
  const make = ADAPTERS.get(type);
  if (make) return make(withPlainCredentials(entry));
  if (RESERVED_TYPES.includes(type)) return notImplementedTarget(type);
  throw new Error(`未知的备份目标类型：${type}（可用：${TARGET_TYPES.join(' / ')}）`);
}

/**
 * 把 entry 里的密文凭据解成适配器可直接用的明文字段。
 *
 * 只在"字段存在且是字符串"时尝试解密；解密失败写进 `__credentialError`，
 * 不抛错也不保留密文（避免密文被当成明文密码发出去）。
 *
 * @param {object} entry
 * @returns {object} 新对象，不改原 entry（调用方可能还要拿去脱敏回显）
 */
function withPlainCredentials(entry) {
  const out = { ...entry };
  const fail = (message) => { out.__credentialError = message; };
  const decrypt = (cipher, label) => {
    if (typeof cipher !== 'string' || !cipher.trim()) return '';
    try {
      return decryptCredential(cipher);
    } catch {
      // 机器标识或 salt 变了会让旧密文解不开。这属于"需要用户重新填写凭据"，
      // 不是程序缺陷，所以降级成可读提示而不是抛错。
      fail(`${label}解密失败，请重新填写该目标的凭据`);
      return '';
    }
  };

  if (out.type === 'webdav') {
    out.password = decrypt(out.credentials, 'WebDAV 密码');
    delete out.credentials;
  } else if (out.type === 's3') {
    out.secretAccessKey = decrypt(out.secretAccessKeyCipher, 'S3 密钥');
    delete out.secretAccessKeyCipher;
  }
  return out;
}

/** 类型是否已实现（界面上可以据此标注「即将支持」）。 */
export function isTargetImplemented(type) {
  return ADAPTERS.has(String(type || ''));
}

/** 注册位：后续 worker 若想把实现拆到不在这里 import 的文件，可从外部注册。 */
export function registerTarget(type, factory) {
  const t = String(type || '').trim();
  if (!t) throw new Error('注册备份目标类型需要非空 type');
  if (typeof factory !== 'function') throw new Error(`备份目标类型「${t}」的工厂不是函数`);
  ADAPTERS.set(t, factory);
  if (!TARGET_TYPES.includes(t)) TARGET_TYPES.push(t);
}

export default { TARGET_TYPES, createTarget, isTargetImplemented, registerTarget, TargetNotImplementedError };

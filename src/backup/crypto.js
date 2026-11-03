// 清单认证是同一主密钥的第三个用途，必须独立派生以隔离用途，
// 避免清单认证密钥泄露时同时暴露凭据或载荷加密密钥。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv, createHmac, timingSafeEqual } from 'node:crypto';
import { DATA_DIR } from '../config.js';
import { atomicWriteText } from '../atomic-write.js';

const KEY_BYTES = 32;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MACHINE_QUERY_TIMEOUT_MS = 5_000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const ALGORITHM = 'aes-256-gcm';
const CREDENTIAL_PREFIX = 'qqac:v1:';
const PAYLOAD_HEADER = Buffer.from('QQABENC1');
const CREDENTIAL_CONTEXT = Buffer.from(CREDENTIAL_PREFIX);
const MANIFEST_CONTEXT = 'qqab-manifest-v2';
export const BACKUP_SALT_FILE = path.join(DATA_DIR, 'backup-crypto.salt');

let machineIdentity;
let cachedSalt;
let cachedKey;

function getMachineIdentity() {
  if (machineIdentity !== undefined) return machineIdentity;
  const hostname = os.hostname();
  let platformId = '';
  try {
    const options = { encoding: 'utf8', timeout: MACHINE_QUERY_TIMEOUT_MS, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
    if (process.platform === 'win32') {
      const output = execFileSync('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], options);
      platformId = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/i)?.[1] || '';
    } else if (process.platform === 'darwin') {
      const output = execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], options);
      platformId = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1] || '';
    } else if (process.platform === 'linux') {
      platformId = fs.readFileSync('/etc/machine-id', 'utf8').trim();
    }
  } catch {
    // 沙箱、权限或平台工具缺失不应阻止备份，按约定退回主机名绑定。
  }
  machineIdentity = JSON.stringify([hostname, platformId || hostname]);
  return machineIdentity;
}

function tightenPermissions(file) {
  try {
    fs.chmodSync(file, PRIVATE_FILE_MODE);
  } catch (error) {
    // Windows 的 ACL 不完整映射到 POSIX mode；其他平台的权限失败不能忽略。
    if (process.platform !== 'win32') throw error;
  }
}

function readSalt() {
  let text;
  try {
    text = fs.readFileSync(BACKUP_SALT_FILE, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const stagingDir = fs.mkdtempSync(path.join(DATA_DIR, '.backup-salt-'));
    const stagingFile = path.join(stagingDir, 'salt');
    try {
      fs.chmodSync(stagingDir, PRIVATE_DIR_MODE);
      atomicWriteText(stagingFile, randomBytes(SALT_BYTES).toString('hex'));
      tightenPermissions(stagingFile);
      try {
        // 原子写工具会覆盖目标；硬链接以独占方式发布，避免并发实例替换已使用的 salt。
        fs.linkSync(stagingFile, BACKUP_SALT_FILE);
      } catch (publishError) {
        if (publishError.code !== 'EEXIST') throw publishError;
        // 另一个进程已经发布完整 salt，必须复用赢家，不能覆盖它。
      }
    } finally {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    text = fs.readFileSync(BACKUP_SALT_FILE, 'utf8');
  }
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('备份加密 salt 文件无效，不能重新生成以免丢失解密能力');
  tightenPermissions(BACKUP_SALT_FILE);
  return text;
}

function masterKey() {
  const salt = readSalt();
  if (salt !== cachedSalt) {
    const key = scryptSync(getMachineIdentity(), Buffer.from(salt, 'hex'), KEY_BYTES);
    cachedKey?.fill(0);
    cachedKey = key;
    cachedSalt = salt;
  }
  return cachedKey;
}

function canonicalManifest(manifest) {
  const stable = value => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
    }
    return value;
  };
  const { hmac, ...fields } = manifest;
  return JSON.stringify(stable(fields));
}

/** 认证整个规范化清单（除签名自身），摘要将载荷也绑定到本机实例。 */
export function signManifest(manifest) {
  const key = createHmac('sha256', masterKey()).update(MANIFEST_CONTEXT).digest();
  try {
    return createHmac('sha256', key).update(canonicalManifest(manifest)).digest('hex');
  } finally { key.fill(0); }
}

export function verifyManifest(manifest) {
  if (typeof manifest?.hmac !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.hmac)) return false;
  return timingSafeEqual(Buffer.from(manifest.hmac, 'hex'), Buffer.from(signManifest(manifest), 'hex'));
}

function encrypt(buffer, context) {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, masterKey(), nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decrypt(buffer, context, message) {
  if (buffer.length < NONCE_BYTES + AUTH_TAG_BYTES) throw new Error(message);
  const key = masterKey();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, buffer.subarray(0, NONCE_BYTES), { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(context);
    decipher.setAuthTag(buffer.subarray(NONCE_BYTES, NONCE_BYTES + AUTH_TAG_BYTES));
    return Buffer.concat([decipher.update(buffer.subarray(NONCE_BYTES + AUTH_TAG_BYTES)), decipher.final()]);
  } catch {
    // 不暴露底层异常或解密出的未认证内容，调用方只收到固定错误。
    throw new Error(message);
  }
}

/** 同步 API；凭据格式为 qqac:v1:<base64(nonce || tag || ciphertext)>。 */
export function encryptCredential(plaintext) {
  if (typeof plaintext !== 'string') throw new TypeError('凭据必须是字符串');
  return CREDENTIAL_PREFIX + encrypt(Buffer.from(plaintext, 'utf8'), CREDENTIAL_CONTEXT).toString('base64');
}

export function decryptCredential(ciphertext) {
  if (typeof ciphertext !== 'string' || !ciphertext.startsWith(CREDENTIAL_PREFIX)) throw new Error('不支持的凭据密文版本');
  const encoded = ciphertext.slice(CREDENTIAL_PREFIX.length);
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.toString('base64') !== encoded) throw new Error('凭据密文格式无效');
  return decrypt(buffer, CREDENTIAL_CONTEXT, '凭据解密失败：密文已损坏、被篡改或不属于本机实例').toString('utf8');
}

/** payload.enc 格式为 QQABENC1 || nonce || tag || ciphertext；返回 Buffer。 */
export function encryptPayload(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('备份载荷必须是 Buffer');
  return Buffer.concat([PAYLOAD_HEADER, encrypt(buffer, PAYLOAD_HEADER)]);
}

export function decryptPayload(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('备份载荷必须是 Buffer');
  const message = '备份包已损坏或被篡改（或不属于本机实例）';
  if (!buffer.subarray(0, PAYLOAD_HEADER.length).equals(PAYLOAD_HEADER)) throw new Error(message);
  return decrypt(buffer.subarray(PAYLOAD_HEADER.length), PAYLOAD_HEADER, message);
}

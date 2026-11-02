// 最小 zip 打包器（只写不读；读走 zip-install.js 的 parseZip）。
//
// 为什么需要它：市场安装那条链只需要**解**，所以项目里一直只有 parseZip。
// 「打包带走」要反过来——把若干目录 + 若干文件装进一个 zip 交给用户。
// 不引第三方库：一是应用是免安装分发，少一个依赖少一份体积；二是
// 这里只需要 store/deflate 两种方法，标准格式两百行足够，而且能保证
// 输出能被 parseZip 自己读回来（同一套字段口径，不会出现"我打的包我自己解不开"）。
//
// ⚠️ 文件名一律 UTF-8 且置 0x0800 标志位（EFS）。Windows 资源管理器对不带该
//    标志的 UTF-8 名会按 GBK 解码 —— 中文目录会变成乱码，解压出来是乱码目录。
import { deflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d = new Date()) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    // DOS 日期从 1980 起算；年份越界时夹到合法区间（不会有人真拿它看时间，但不能写坏字段）
    date: ((Math.max(1980, Math.min(2107, d.getFullYear())) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

/**
 * 把 entries 打成 zip。
 *
 * @param {Array<{name: string, data: Buffer|string}>} entries
 *   name 用正斜杠分隔（内部会再规范一次）；目录条目不需要传，parseZip 也会跳过。
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  const { time, date } = dosTime();
  let offset = 0;

  for (const e of entries || []) {
    const nameStr = String(e?.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!nameStr) continue;
    const name = Buffer.from(nameStr, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e?.data ?? ''), 'utf8');
    const comp = deflateRawSync(data, { level: 6 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);        // version needed
    local.writeUInt16LE(0x0800, 6);    // UTF-8 文件名
    local.writeUInt16LE(8, 8);         // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);           // version made by
    cd.writeUInt16LE(20, 6);           // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);           // extra
    cd.writeUInt16LE(0, 32);           // comment
    cd.writeUInt16LE(0, 34);           // disk
    cd.writeUInt16LE(0, 36);           // internal attr
    cd.writeUInt32LE(0, 38);           // external attr
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, name]));

    offset += local.length + name.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(central.length, 8);
  eocd.writeUInt16LE(central.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, cdBuf, eocd]);
}

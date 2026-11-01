'use strict';

/**
 * 打包成云函数可直接上传的 zip（不依赖系统 zip 命令，纯 Node 实现）
 * 用法：node tools/pack.js
 * 产物：dist/suiyin.zip
 *
 * 只打运行必需的东西：index.js + package.json + src/**
 * 不会把 .env（里面有密钥）和测试文件打进去。
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'suiyin.zip');

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

// ---------- 收集文件 ----------
function collect(dir, base = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(abs, rel));
    else out.push({ rel, abs });
  }
  return out;
}

const files = [];
files.push({ rel: 'index.js', abs: path.join(ROOT, 'index.js') });
files.push({ rel: 'package.json', abs: path.join(ROOT, 'package.json') });
for (const f of collect(path.join(ROOT, 'src'), 'src')) files.push(f);

// ---------- 构造 zip ----------
function dosTime(d) {
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
    date:
      (((d.getFullYear() - 1980) & 0x7f) << 9) |
      (((d.getMonth() + 1) & 0x0f) << 5) |
      (d.getDate() & 0x1f),
  };
}

const now = new Date();
const { time, date } = dosTime(now);
const localParts = [];
const centralParts = [];
let offset = 0;
let rawTotal = 0;

for (const f of files) {
  const raw = fs.readFileSync(f.abs);
  rawTotal += raw.length;
  const deflated = zlib.deflateRawSync(raw, { level: 9 });
  const useDeflate = deflated.length < raw.length;
  const data = useDeflate ? deflated : raw;
  const method = useDeflate ? 8 : 0;
  const nameBuf = Buffer.from(f.rel, 'utf8');
  const sum = crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // 文件名 UTF-8
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  localParts.push(local, nameBuf, data);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);
  centralParts.push(central, nameBuf);

  offset += local.length + nameBuf.length + data.length;
}

const centralBuf = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.mkdirSync(DIST, { recursive: true });
const zipBuf = Buffer.concat([...localParts, centralBuf, end]);
fs.writeFileSync(OUT, zipBuf);

console.log('✅ 已生成 ' + path.relative(ROOT, OUT));
console.log('   文件数 ' + files.length + '，原始 ' + (rawTotal / 1024).toFixed(1) + ' KB，' +
  '压缩后 ' + (zipBuf.length / 1024).toFixed(1) + ' KB\n');
for (const f of files) {
  console.log('   + ' + f.rel);
}
console.log('\n上传时：代码入口填 index.js，执行方法填 main，运行环境选 Node.js 18 及以上');

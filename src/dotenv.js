'use strict';

/** 极简 .env 加载器（避免引入 dotenv 依赖，云函数上也不必谈判） */

const fs = require('node:fs');
const path = require('node:path');

function load(file) {
  const target = file || path.join(process.cwd(), '.env');
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (_) {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line || /^\s*#/.test(line)) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
      (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}

module.exports = { load };

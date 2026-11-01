'use strict';

/**
 * 本地存储适配器：memory（进程内）与 json（文件）
 * 用于本地开发调试、以及不想用飞书时的备用落地方式。
 * 接口与 feishu 适配器完全一致，可直接替换。
 */

const fs = require('node:fs');
const path = require('node:path');

function matchRange(rec, from, to) {
  if (from != null && rec.date < from) return false;
  if (to != null && rec.date >= to) return false;
  return true;
}

/** 统一的排序 + 截断：latest=true 取最新 N 条，时间相同用写入顺序兜底 */
function pick(all, { from, to, limit, latest }) {
  const picked = [];
  all.forEach((r, i) => {
    if (matchRange(r, from, to)) picked.push({ r, i });
  });
  picked.sort((a, b) =>
    latest ? b.r.date - a.r.date || b.i - a.i : a.r.date - b.r.date || a.i - b.i
  );
  return picked.slice(0, limit).map((x) => x.r);
}

function createMemoryStore() {
  const rows = [];
  let seq = 0;
  return {
    name: 'memory',
    async add(rec) {
      const row = { ...rec, id: 'm_' + ++seq };
      rows.push(row);
      return { id: row.id };
    },
    async list({ from, to, limit = 500, latest = false } = {}) {
      return pick(rows, { from, to, limit, latest });
    },
    async remove(id) {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
    async all(limit = 500) {
      return this.list({ limit });
    },
    _rows: rows,
  };
}

function createJsonStore(filePath) {
  const abs = path.resolve(filePath);
  let rows = null;
  let seq = 0;

  function load() {
    if (rows) return rows;
    try {
      const raw = fs.readFileSync(abs, 'utf8');
      rows = JSON.parse(raw);
      seq = rows.length;
    } catch (_) {
      rows = [];
      seq = 0;
    }
    return rows;
  }

  function save() {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify(rows, null, 2), 'utf8');
  }

  return {
    name: 'json',
    async add(rec) {
      load();
      const row = { ...rec, id: 'j_' + ++seq };
      rows.push(row);
      save();
      return { id: row.id };
    },
    async list({ from, to, limit = 500, latest = false } = {}) {
      load();
      return pick(rows, { from, to, limit, latest });
    },
    async remove(id) {
      load();
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      save();
      return true;
    },
    async all(limit = 500) {
      return this.list({ limit });
    },
  };
}

module.exports = { createMemoryStore, createJsonStore };

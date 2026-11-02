'use strict';

/**
 * 业务编排：把一条文本变成一段回复
 * 这里只负责"读一句话 → 做事 → 说一句话"，不关心消息从哪来、存到哪去。
 */

const { parse, HELP_TEXT } = require('./parse');
const t = require('./time');

function summarize(rows, tz, now) {
  const dayStart = t.startOfDay(now, tz);
  const s = {
    expense: 0,
    income: 0,
    count: 0,
    todayExpense: 0,
    todayIncome: 0,
    todayCount: 0,
    byCategory: new Map(),
  };
  for (const r of rows) {
    const amt = Number(r.amount) || 0;
    s.count++;
    if (r.type === 'income') s.income += amt;
    else {
      s.expense += amt;
      const cat = r.category || '其他';
      const cur = s.byCategory.get(cat) || { amount: 0, count: 0 };
      cur.amount += amt;
      cur.count++;
      s.byCategory.set(cat, cur);
    }
    if (r.date >= dayStart) {
      if (r.type === 'income') s.todayIncome += amt;
      else s.todayExpense += amt;
      s.todayCount++;
    }
  }
  return s;
}

function money(n) {
  return t.formatMoney(n);
}

// ---------- 预算与耗时 ----------

/** 本次请求还剩多少毫秒可用（没有 deadline 就当无限） */
function remainingMs(ctx) {
  return ctx.deadline ? ctx.deadline - Date.now() : Number.MAX_SAFE_INTEGER;
}

function note(ctx, msg) {
  if (ctx.logger && ctx.logger.log) ctx.logger.log('[ledger] ' + msg);
}

/**
 * 单次飞书请求能给多少毫秒。
 * 既要 ≤ 配置上限，也要 ≤ 本次消息的剩余预算，且不低于 1.2 秒（太低必然白给）。
 */
function callTimeout(ctx, cfg, minMs = 1200) {
  const left = remainingMs(ctx) - 350; // 留出组装回包的时间
  const cap = cfg.app.feishuTimeoutMs || 3800;
  return Math.max(minMs, Math.min(cap, left));
}

/**
 * 最近写进库的记录（实例内存，只存 id 和展示用的字段）。
 * 「删1」命中这里就能省掉一次 2 秒级的查询，两步并一步。
 */
const recentAdded = [];
const RECENT_MAX = 20;

/** 给任意 promise 套一个上限，超了返回哨兵值（不抛错，调用方自行判断） */
const TIMEOUT = Symbol('timeout');

function withinBudget(promise, ms) {
  if (!(ms > 0)) return Promise.resolve(TIMEOUT);
  let timer;
  const cap = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

/**
 * 在记录里找「和刚写的这条一模一样」的孪生记录。
 * 判据：类型、金额、备注都相同，时间相差 90 秒以内，且不是自己。
 * 同一句话在 90 秒内连记两笔几乎不会是有意的，多半是同一条消息被平台重投。
 */
const TWIN_WINDOW_MS = 90 * 1000;

/**
 * 「读到了记录，字段却全是空的」——这不是账本没数据，是飞书不给看。
 * 官方 FAQ：多维表格开了「高级权限」时，调用身份得是「可管理」，
 * 只有「可编辑」会出现「调用成功但返回数据为空」。
 */
function EMPTY_FIELDS_HINT(count) {
  return [
    '⚠️ 读到了 ' + (count || '') + ' 条记录，但字段值全是空的',
    '不是账本坏了，是飞书那边没给读的权限：',
    '多维表格右上角 ··· → ···更多 → 添加文档应用',
    '找到这个应用，权限选「可管理」→ 添加',
    '（「可编辑」不够，字段值会被涂掉）',
  ].join('\n');
}

function findTwin(rows, rec, added) {
  const norm = (s) => String(s == null ? '' : s).trim();
  for (const r of rows) {
    if (added && added.id && r.id === added.id) continue;
    if (r.type !== rec.type) continue;
    if (Math.abs(Number(r.amount) - Number(rec.amount)) > 0.001) continue;
    if (norm(r.note) !== norm(rec.note)) continue;
    if (Math.abs(Number(r.date) - Number(rec.date)) > TWIN_WINDOW_MS) continue;
    return r;
  }
  return null;
}

/**
 * 记账成功后顺手算「今日/本月合计」。
 * 这是锦上添花的一行，拿不到就整行省略 —— 绝不因为它让回执超时。
 * 同一次查询顺带看一眼有没有重复记录，不额外花时间。
 */
async function loadStatsQuietly(ctx, rec, added, now, tz) {
  const { store, cfg } = ctx;
  const empty = { stats: null, twin: null };
  // 不看合计也不查重，就没必要多发这次请求
  if (!cfg.app.showTodayTotal && !cfg.app.dedupeCheck) return empty;

  const budget = Math.min(
    cfg.app.statsBudgetMs || 1500,
    remainingMs(ctx) - 400 // 留出发回包和网络的时间
  );
  if (budget < 350) {
    note(ctx, '跳过今日合计（剩余预算 ' + Math.max(0, remainingMs(ctx)) + 'ms 不够）');
    return empty;
  }

  const startedAt = Date.now();
  const work = (async () => {
    const monthStart = t.startOfMonth(now, tz);
    const rows = await store.list({
      from: monthStart,
      to: now + 24 * 3600 * 1000,
      limit: 500,
      timeout: budget,
    });
    // 刚写的这条可能还没被索引到，缺了就手动补上，避免合计少一笔
    const hasIt = added && added.id
      ? rows.some((r) => r.id === added.id)
      : rows.some((r) => r.date === rec.date && r.amount === rec.amount);
    return {
      stats: cfg.app.showTodayTotal
        ? summarize(hasIt ? rows : rows.concat(rec), tz, now)
        : null,
      twin: cfg.app.dedupeCheck ? findTwin(rows, rec, added) : null,
    };
  })();
  work.catch(() => {}); // 超时后可能才失败，别让它变成未处理 rejection

  const out = await withinBudget(work.catch(() => null), budget);
  if (out === TIMEOUT) {
    note(ctx, '今日合计超预算（>' + budget + 'ms），本次不显示');
    return empty;
  }
  note(ctx, '今日合计 ' + (Date.now() - startedAt) + 'ms' + (out && out.twin ? '｜发现重复记录' : ''));
  return out || empty;
}

/** 记账成功的回执 */
function recordReply(rec, stats, tz, twin) {
  const typeLabel = rec.type === 'income' ? '收入' : '支出';
  const sign = rec.type === 'income' ? '+' : '';
  const lines = [];

  const catPart =
    rec.category && rec.category !== '收入' ? '（' + rec.category + '）' : '';
  const notePart = rec.note && rec.note !== '收入' && rec.note !== '支出' ? ' · ' + rec.note : '';
  lines.push('✅ ' + typeLabel + ' ' + sign + '¥' + money(rec.amount) + notePart + catPart);

  if (stats) {
    if (rec.type === 'income') {
      const balance = stats.income - stats.expense;
      lines.push(
        '本月收入 ¥' + money(stats.income) + ' ｜ 结余 ' +
        (balance >= 0 ? '+' : '-') + '¥' + money(Math.abs(balance))
      );
    } else {
      lines.push('今日 ¥' + money(stats.todayExpense) + ' ｜ 本月 ¥' + money(stats.expense));
    }
  }
  if (twin) {
    lines.push('');
    lines.push('⚠️ 90 秒内还有一条一模一样的记录，可能是同一条消息被重投了');
    lines.push('发「去重」清掉多出来的那条');
  }
  return lines.join('\n');
}

function monthReply(rows, stats, now, tz) {
  const p = t.localParts(now, tz);
  if (stats.count === 0) return '📊 ' + p.year + '年' + (p.month + 1) + '月还没有记录～';

  const balance = stats.income - stats.expense;
  const lines = [];
  lines.push('📊 ' + p.year + '年' + (p.month + 1) + '月 · 共 ' + stats.count + ' 笔');
  lines.push('支出 ¥' + money(stats.expense) + (stats.income > 0 ? ' ｜ 收入 ¥' + money(stats.income) : ''));
  if (stats.income > 0) {
    lines.push('结余 ' + (balance >= 0 ? '+' : '-') + '¥' + money(Math.abs(balance)));
  }

  const cats = [...stats.byCategory.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 6);
  if (cats.length) {
    lines.push('');
    for (const [cat, v] of cats) {
      const pct = stats.expense > 0 ? Math.round((v.amount / stats.expense) * 100) : 0;
      lines.push(cat + ' ¥' + money(v.amount) + ' · ' + v.count + '笔 · ' + pct + '%');
    }
  }
  return lines.join('\n');
}

function dayReply(rows, now, tz) {
  const dayStart = t.startOfDay(now, tz);
  const dayEnd = t.endOfDay(now, tz);
  // 同一分钟的多条记录靠原始顺序保证先后
  const today = rows
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r.date >= dayStart && x.r.date <= dayEnd)
    .sort((a, b) => a.r.date - b.r.date || a.i - b.i)
    .map((x) => x.r);
  const p = t.localParts(now, tz);
  const label = (p.month + 1) + '月' + p.day + '日';

  if (!today.length) return '📅 ' + label + ' 还没有记录～';

  let exp = 0;
  let inc = 0;
  const lines = ['📅 ' + label + ' · ' + today.length + ' 笔'];
  for (const r of today) {
    if (r.type === 'income') inc += r.amount;
    else exp += r.amount;
    lines.push(
      t.formatShort(r.date, tz) + '  ' + (r.type === 'income' ? '+' : '-') + money(r.amount) +
      (r.note ? '  ' + r.note : '')
    );
  }
  lines.push('');
  lines.push('支出 ¥' + money(exp) + (inc > 0 ? ' ｜ 收入 ¥' + money(inc) : ''));
  return lines.join('\n');
}

function recentReply(rows, tz, limit = 10) {
  if (!rows.length) return '还没有任何记录～\n发一句「25 午饭」试试';
  // rows 由 store 按「最新优先」返回
  const list = rows.slice(0, limit);
  const lines = ['📋 最近 ' + list.length + ' 笔'];
  for (const r of list) {
    lines.push(
      t.formatShort(r.date, tz) + '  ' + (r.type === 'income' ? '+' : '-') + money(r.amount) +
      (r.note ? '  ' + r.note : '')
    );
  }
  return lines.join('\n');
}

/**
 * 「去重」：把最近记录里 3 分钟内完全相同的几条并成一条。
 *
 * 飞书的写入接口没有幂等（client_token 实测无效），跨实例的重投挡不住，
 * 所以留一个手动兜底：真的多记了一条，发一句「去重」就干净了。
 * 只在同一类型 + 同一金额 + 同一备注、且时间紧挨着的时候才算重复，
 * 相隔超过 3 分钟的相同开销（比如连着两天都买同一份早餐）不会被误删。
 */
const DEDUPE_SCAN_LIMIT = 200;
const DEDUPE_WINDOW_MS = 180 * 1000;
const DEDUPE_MAX_DELETE = 6;

async function runDedupe({ store, cfg, ctx, tz }) {
  const tRead = Date.now();
  let rows;
  try {
    rows = await store.list({
      limit: DEDUPE_SCAN_LIMIT,
      latest: true,
      timeout: callTimeout(ctx, cfg),
    });
  } catch (e) {
    if (e && e.code === 'EMPTY_FIELDS') return EMPTY_FIELDS_HINT(e.count);
    return '⚠️ 读不到记录：' + String(e.message || e).slice(0, 100);
  }
  note(ctx, '去重：读 ' + rows.length + ' 条 ' + (Date.now() - tRead) + 'ms');

  // 从旧到新扫，每组保留最早那条
  const sorted = rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => a.r.date - b.r.date || a.i - b.i)
    .map((x) => x.r);

  const lastKept = new Map();
  const groups = new Map();
  const toRemove = [];

  for (const r of sorted) {
    const key = r.type + '|' + Number(r.amount).toFixed(2) + '|' + String(r.note || '').trim();
    const prev = lastKept.get(key);
    if (prev && r.id && Math.abs(r.date - prev.date) <= DEDUPE_WINDOW_MS) {
      toRemove.push(r);
      const g = groups.get(key) || { rec: prev, extra: 0 };
      g.extra += 1;
      groups.set(key, g);
    } else {
      lastKept.set(key, r);
    }
  }

  if (!toRemove.length) {
    return '🧹 最近 ' + rows.length + ' 条里没有重复记录 ✓';
  }

  let removed = 0;
  for (const r of toRemove) {
    if (removed >= DEDUPE_MAX_DELETE) break;
    const left = remainingMs(ctx);
    if (left < 1800) break; // 快到回包时限了，剩下的留给下一次
    try {
      const ok = await store.remove(r.id, {
        timeout: Math.min(cfg.app.feishuTimeoutMs || 3800, left - 1200),
      });
      if (ok !== false) removed += 1;
    } catch (e) {
      note(ctx, '去重：删 ' + r.id + ' 失败 ' + (e.message || e));
      break;
    }
  }
  note(ctx, '去重：删掉 ' + removed + '/' + toRemove.length + ' 条 ' + (Date.now() - tRead) + 'ms');

  const lines = ['🧹 清理重复'];
  lines.push('判定：类型+金额+备注 相同，且相隔不超过 3 分钟');
  lines.push('删掉 ' + removed + ' 条，涉及 ' + groups.size + ' 组：');
  for (const [, g] of groups) {
    const label = (g.rec.type === 'income' ? '+' : '-') + '¥' + money(g.rec.amount) +
      (g.rec.note ? ' ' + g.rec.note : '');
    lines.push('· ' + label + ' — ' + (g.extra + 1) + ' 条并 1 条');
  }
  if (removed < toRemove.length) {
    lines.push('');
    lines.push('还剩 ' + (toRemove.length - removed) + ' 条没删完（一次删太多会超时），再发一次「去重」');
  }
  return lines.join('\n');
}

/** 查询类命令的执行体：按 scope 取数并组织文案 */
async function runQuery(parsed, { store, now, tz, monthStart, nextMonth, timeout }) {
  if (parsed.scope === 'month') {
    const rows = await store.list({ from: monthStart, to: nextMonth, limit: 500, timeout });
    return monthReply(rows, summarize(rows, tz, now), now, tz);
  }
  if (parsed.scope === 'today') {
    const rows = await store.list({
      from: t.startOfDay(now, tz),
      to: t.endOfDay(now, tz) + 1,
      limit: 500,
      timeout,
    });
    return dayReply(rows, now, tz);
  }
  if (parsed.scope === 'yesterday') {
    const yNow = now - 24 * 3600 * 1000;
    const rows = await store.list({
      from: t.startOfDay(yNow, tz),
      to: t.endOfDay(yNow, tz) + 1,
      limit: 500,
      timeout,
    });
    return dayReply(rows, yNow, tz);
  }
  // recent
  const rows = await store.list({ limit: 10, latest: true, timeout });
  return recentReply(rows, tz, 10);
}

/**
 * 主入口
 * @param {string} text 用户发的文本
 * @param {{store: object, cfg: object, now?: number, deadline?: number,
 *          logger?: object, channel?: string, coldStart?: boolean}} ctx
 * @returns {Promise<string>} 回复文本
 */
async function handleText(text, ctx) {
  const { store, cfg } = ctx;
  const now = ctx.now || Date.now();
  const tz = cfg.app.tzOffset;
  const parsed = parse(text);

  switch (parsed.kind) {
    case 'help':
      return parsed.text || HELP_TEXT;

    case 'unknown':
      return (
        '没看懂这句 🤔\n' +
        '记账这样发：25 午饭\n' +
        '发「帮助」看全部用法'
      );

    case 'record': {
      const rec = {
        amount: parsed.amount,
        type: parsed.type,
        note: parsed.note,
        category: parsed.category,
        date: now,
      };

      // 先落库：落库失败必须如实告诉用户，不能假成功
      const tAdd = Date.now();
      let added;
      try {
        added = await store.add(rec, { timeout: callTimeout(ctx, cfg) });
      } catch (e) {
        note(ctx, 'store.add 失败 ' + (Date.now() - tAdd) + 'ms：' + (e.message || e));
        // 超时这类错误，飞书那边很可能已经写进去了，不能一口咬定「没记上」
        if (/超时|timeout/i.test(String(e.message || ''))) {
          return '⚠️ 这次超时了，这笔可能已经记上了\n' +
            '先发「明细」看一眼，别急着重发（重发会变成两条）';
        }
        return '⚠️ 记账失败（数据没写进去）\n' + String(e.message || e).slice(0, 120) +
          '\n请稍后重发一次';
      }
      note(ctx, 'store.add 成功 ' + (Date.now() - tAdd) + 'ms');
      if (added && added.id) {
        recentAdded.unshift({
          id: added.id,
          amount: rec.amount,
          type: rec.type,
          note: rec.note,
        });
        if (recentAdded.length > RECENT_MAX) recentAdded.pop();
      }

      // 写到这儿这笔账已经成了，剩下的统计可有可无
      const { stats, twin } = await loadStatsQuietly(ctx, rec, added, now, tz);
      return recordReply(rec, stats, tz, twin);
    }

    case 'dedupe': {
      return await runDedupe({ store, cfg, ctx, now, tz });
    }

    case 'diag': {
      const region = cfg.app.region ? ' · 地域 ' + cfg.app.region : '';
      const lines = ['🩺 诊断'];
      lines.push('通道 ' + (ctx.channel || '未知') + ' · 存储 ' + (store.name || '?') + region);

      let tokenMs = -1;
      let queryMs = 0;
      let probeOk = true;
      let probeErr = '';

      if (typeof store.probe === 'function') {
        const p = await store.probe({ timeout: callTimeout(ctx, cfg) });
        tokenMs = p.tokenMs;
        queryMs = p.queryMs;
        probeOk = p.queryOk !== false && p.tokenOk !== false;
        probeErr = p.queryErr || p.tokenErr || '';
        lines.push(
          '取 token ' + p.tokenMs + 'ms' + (p.tokenMs < 50 ? '（缓存命中）' : '（重新获取）')
        );
      } else {
        const tProbe = Date.now();
        try {
          await store.list({ limit: 1, latest: true, timeout: callTimeout(ctx, cfg) });
        } catch (e) {
          probeOk = false;
          probeErr = String(e.message || e);
        }
        queryMs = Date.now() - tProbe;
      }

      lines.push('读一条记录 ' + (probeOk ? queryMs + 'ms' : '失败 ' + queryMs + 'ms'));
      if (!probeOk) lines.push('❌ ' + String(probeErr).slice(0, 100));

      if (queryMs > 1500) {
        lines.push('⚠️ 数据链路偏慢：单次就 ' + queryMs + 'ms，5 秒上限很容易被吃满');
        lines.push('   换到离飞书近的地域（上海/北京），或设 APP_SHOW_TODAY_TOTAL=0 省一次查询');
      } else if (tokenMs > 800) {
        lines.push('⚠️ 取 token 慢：实例刚启动，闲置后的第一条会慢');
      }

      lines.push('本实例 ' + (ctx.coldStart ? '冷启动（首条消息容易慢）' : '已预热'));
      if (ctx.deadline) lines.push('剩余预算 ' + Math.max(0, remainingMs(ctx)) + 'ms');
      lines.push('回包上限 4500ms · 飞书单请求 ' + cfg.app.feishuTimeoutMs + 'ms');
      return lines.join('\n');
    }

    case 'query': {
      const monthStart = t.startOfMonth(now, tz);
      const nextMonth = t.startOfNextMonth(now, tz);
      const tRead = Date.now();
      let replyText;
      try {
        replyText = await runQuery(parsed, {
          store, now, tz, monthStart, nextMonth, timeout: callTimeout(ctx, cfg),
        });
      } catch (e) {
        if (e && e.code === 'EMPTY_FIELDS') return EMPTY_FIELDS_HINT(e.count);
        throw e;
      } finally {
        note(ctx, '查询 ' + parsed.scope + ' ' + (Date.now() - tRead) + 'ms');
      }
      return replyText;
    }

    case 'delete': {
      // 删最新一条时，先看实例内存里记着的 record_id：
      // 命中就省掉一次 2 秒级的查询，两步变一步，才来得及在 5 秒内回包。
      if (parsed.offset === 1 && recentAdded.length) {
        const hit = recentAdded[0];
        try {
          const ok = await store.remove(hit.id, { timeout: callTimeout(ctx, cfg) });
          if (ok === false) throw new Error('该记录已不存在');
          recentAdded.shift();
          return (
            '🗑 已删除 ' + (hit.type === 'income' ? '+' : '-') + '¥' + money(hit.amount) +
            (hit.note ? ' ' + hit.note : '') +
            '\n发「明细」看看剩下的'
          );
        } catch (e) {
          // 记录可能已经在飞书里被手动删了，退回正常路径重新查
          note(ctx, '按缓存删除失败，回退查询：' + (e.message || e));
          recentAdded.shift();
        }
      }

      // 最新优先，rows[0] 就是刚记的那条
      let rows;
      try {
        rows = await store.list({
          limit: Math.max(1, parsed.offset),
          latest: true,
          timeout: callTimeout(ctx, cfg),
        });
      } catch (e) {
        if (e && e.code === 'EMPTY_FIELDS') return EMPTY_FIELDS_HINT(e.count);
        throw e;
      }
      if (!rows.length) return '还没有记录可以删～';
      const target = rows[parsed.offset - 1];
      if (!target) {
        return '只有 ' + rows.length + ' 条记录，删不了第 ' + parsed.offset + ' 条';
      }
      try {
        await store.remove(target.id, { timeout: callTimeout(ctx, cfg) });
      } catch (e) {
        return '⚠️ 删除失败：' + String(e.message || e).slice(0, 120);
      }
      return (
        '🗑 已删除 ' + (target.type === 'income' ? '+' : '-') + '¥' + money(target.amount) +
        (target.note ? ' ' + target.note : '') +
        '\n发「明细」看看剩下的'
      );
    }

    default:
      return HELP_TEXT;
  }
}

module.exports = { handleText, summarize, monthReply, dayReply, recentReply, recordReply };

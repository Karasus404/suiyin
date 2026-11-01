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
 * 记账成功后顺手算「今日/本月合计」。
 * 这是锦上添花的一行，拿不到就整行省略 —— 绝不因为它让回执超时。
 */
async function loadStatsQuietly(ctx, rec, added, now, tz) {
  const { store, cfg } = ctx;
  if (!cfg.app.showTodayTotal) return null;

  const budget = Math.min(
    cfg.app.statsBudgetMs || 1500,
    remainingMs(ctx) - 400 // 留出发回包和网络的时间
  );
  if (budget < 350) {
    note(ctx, '跳过今日合计（剩余预算 ' + Math.max(0, remainingMs(ctx)) + 'ms 不够）');
    return null;
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
    return summarize(hasIt ? rows : rows.concat(rec), tz, now);
  })();
  work.catch(() => {}); // 超时后可能才失败，别让它变成未处理 rejection

  const out = await withinBudget(work.catch(() => null), budget);
  if (out === TIMEOUT) {
    note(ctx, '今日合计超预算（>' + budget + 'ms），本次不显示');
    return null;
  }
  note(ctx, '今日合计 ' + (Date.now() - startedAt) + 'ms');
  return out;
}

/** 记账成功的回执 */
function recordReply(rec, stats, tz) {
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
      const stats = await loadStatsQuietly(ctx, rec, added, now, tz);
      return recordReply(rec, stats, tz);
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
      const rows = await store.list({
        limit: Math.max(1, parsed.offset),
        latest: true,
        timeout: callTimeout(ctx, cfg),
      });
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

'use strict';

/**
 * 飞书多维表格存储适配器
 *
 * 用到的三个接口（全部走 https://open.feishu.cn）：
 *   1. POST /open-apis/auth/v3/tenant_access_token/internal   拿 token（缓存 2 小时）
 *   2. POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records            新增记录
 *   3. POST /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search     条件查询
 *   4. DELETE .../records/{record_id}                                                   删除记录
 *
 * 设计原则：所有网络请求都带超时，超时/失败抛错由上层降级，
 * 保证企业微信 5 秒内一定能拿到回包。
 */

const BASE = 'https://open.feishu.cn/open-apis';

function createFeishuStore(cfg) {
  const { appId, appSecret, appToken, tableId, fields, typeValues } = cfg.feishu;
  const timeoutMs = cfg.app.feishuTimeoutMs;

  let cachedToken = null;
  let tokenExpireAt = 0;
  let tokenInflight = null;

  async function request(path, { method = 'GET', body, token, timeout } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout || timeoutMs);
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (token) headers.Authorization = 'Bearer ' + token;

    try {
      const res = await fetch(BASE + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {
        /* 非 JSON 响应 */
      }
      if (!json) throw new Error('飞书返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200));
      if (!res.ok || (json.code !== undefined && json.code !== 0)) {
        throw new Error('飞书接口报错 code=' + json.code + ' msg=' + json.msg + ' path=' + path);
      }
      return json.data || json;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('飞书接口超时（' + (timeout || timeoutMs) + 'ms）：' + path);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getToken(opts = {}) {
    const now = Date.now();
    if (cachedToken && now < tokenExpireAt) return cachedToken;
    // 并发时只发一次 token 请求，其余复用同一个 Promise
    if (!tokenInflight) {
      tokenInflight = (async () => {
        const data = await request('/auth/v3/tenant_access_token/internal', {
          method: 'POST',
          body: { app_id: appId, app_secret: appSecret },
          timeout: opts.timeout,
        });
        cachedToken = data.tenant_access_token;
        const expire = Number(data.expire) || 7200;
        tokenExpireAt = Date.now() + (expire - 300) * 1000; // 提前 5 分钟过期
        return cachedToken;
      })().finally(() => {
        tokenInflight = null;
      });
    }
    return tokenInflight;
  }

  function toFields(rec) {
    const f = {};
    f[fields.amount] = Number(rec.amount);
    f[fields.type] = typeValues[rec.type] || rec.type;
    f[fields.note] = rec.note || '';
    if (rec.category) f[fields.category] = rec.category;
    f[fields.date] = Number(rec.date);
    return f;
  }

  // ---- 字段值反解：飞书返回类型不固定，统一搓成基础类型 ----
  function toText(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (Array.isArray(v)) return v.map(toText).join('');
    if (typeof v === 'object') return v.text || v.name || v.value || '';
    return '';
  }
  function toNumber(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return Number(v.replace(/[^\d.\-]/g, '')) || 0;
    if (Array.isArray(v)) return toNumber(v[0]);
    if (v && typeof v === 'object') return Number(v.value) || 0;
    return 0;
  }
  /**
   * 日期字段吐出来的是「毫秒」时间戳，跟本项目内部一致，原样用。
   * 只在碰到 ISO 字符串时兜一下。
   */
  function toDate(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Date.parse(v);
      return Number.isNaN(n) ? 0 : n;
    }
    if (Array.isArray(v)) return toDate(v[0]);
    return 0;
  }

  function fromFields(f, recordId) {
    const typeText = toText(f[fields.type]);
    return {
      id: recordId,
      amount: toNumber(f[fields.amount]),
      type: typeText === typeValues.income ? 'income' : 'expense',
      note: toText(f[fields.note]),
      category: toText(f[fields.category]),
      date: toDate(f[fields.date]),
    };
  }

  return {
    name: 'feishu',

    /**
     * 新增一条。
     * 注：接口文档里有 client_token 幂等参数，但实测无论放在 query 还是 body
     * （单条 / batch_create 都试过）都不生效，同 token 连发仍是两条记录。
     * 所以这里不做写入幂等，重复由上层「记账后自检 + 去重命令」处理。
     */
    async add(rec, opts = {}) {
      const token = await getToken(opts);
      const data = await request(
        '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records',
        { method: 'POST', body: { fields: toFields(rec) }, token, timeout: opts.timeout }
      );
      return { id: (data.record && data.record.record_id) || '' };
    },

    /**
     * 按时间范围查（from 含，to 不含）。
     * 注意：飞书的日期字段只支持 isGreater / isLess / is，不支持 isGreaterEqual，
     *      所以 ">= from" 用 isGreater(from-1) 来表达。
     * latest=true 时按时间倒序取最新的 N 条（查明细、删记录要用）。
     */
    async list({ from, to, limit = 500, latest = false, timeout } = {}) {
      const token = await getToken({ timeout });
      const conditions = [];
      // 飞书的日期字段认「毫秒」时间戳，本项目内部也一律用毫秒，直接传
      if (from != null) {
        conditions.push({
          field_name: fields.date,
          operator: 'isGreater',
          value: ['ExactDate', String(Number(from) - 1)],
        });
      }
      if (to != null) {
        conditions.push({
          field_name: fields.date,
          operator: 'isLess',
          value: ['ExactDate', String(to)],
        });
      }

      const out = [];
      let pageToken = '';
      for (let page = 0; page < 10; page++) {
        const body = {
          automatic_fields: false,
          page_size: Math.max(1, Math.min(500, limit - out.length)),
        };
        if (conditions.length) body.filter = { conjunction: 'and', conditions };
        if (latest) body.sort = [{ field_name: fields.date, desc: true }];
        if (pageToken) body.page_token = pageToken;

        const data = await request(
          '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/search',
          { method: 'POST', body, token, timeout }
        );
        const items = data.items || [];
        // 记录能列出来、字段值却是空的 —— 不是表里没数据，是飞书不给你看。
        // 官方 FAQ：多维表格开了「高级权限」时，调用身份必须有「可管理」，
        // 只有「可编辑」时会「调用成功但返回数据为空」。这种情况必须喊出来，
        // 否则界面上一片 ¥0.00，看着像账本坏了。
        if (items.length && items.every((it) => !it.fields || !Object.keys(it.fields).length)) {
          const err = new Error('EMPTY_FIELDS');
          err.code = 'EMPTY_FIELDS';
          err.count = items.length;
          throw err;
        }
        for (const it of items) out.push(fromFields(it.fields || {}, it.record_id));
        pageToken = data.page_token || '';
        if (!data.has_more || !pageToken || out.length >= limit) break;
      }
      if (!latest) out.sort((a, b) => a.date - b.date);
      return out;
    },

    async remove(recordId, opts = {}) {
      const token = await getToken(opts);
      await request('/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/' + recordId, {
        method: 'DELETE',
        token,
        timeout: opts.timeout,
      });
      return true;
    },

    /**
     * 诊断用：把「取 token」和「查一条」分开计时。
     * 两个数一看就知道慢在凭证还是慢在数据链路。
     */
    async probe(opts = {}) {
      const tToken = Date.now();
      let tokenOk = true;
      let tokenErr = '';
      try {
        await getToken(opts);
      } catch (e) {
        tokenOk = false;
        tokenErr = String(e.message || e);
      }
      const tokenMs = Date.now() - tToken;
      if (!tokenOk) return { tokenMs, tokenOk, tokenErr, queryMs: 0, queryOk: false };

      const tQuery = Date.now();
      let queryOk = true;
      let queryErr = '';
      try {
        await this.list({ limit: 1, latest: true, timeout: opts.timeout });
      } catch (e) {
        queryOk = false;
        queryErr = String(e.message || e);
      }
      return { tokenMs, tokenOk, queryMs: Date.now() - tQuery, queryOk, queryErr };
    },

    /** 尽量取到全量（本地测试/兜底用） */
    async all(limit = 500) {
      return this.list({ limit });
    },
  };
}

module.exports = { createFeishuStore };

'use strict';

/**
 * 全部配置来自环境变量，方便云函数里直接配。
 * 本地调试可用 .env 文件（src/local-server.js 会自动读取）。
 */

function readEnv() {
  // 如果存在 .env 就加载（云函数环境里没有也没关系）
  try {
    const path = require('node:path');
    require('./dotenv').load(path.join(__dirname, '..', '.env'));
  } catch (e) {
    /* ignore */
  }
}

readEnv();

const env = process.env;

const config = {
  // ===== 企业微信 =====
  wecom: {
    corpId: env.WECOM_CORP_ID || '',
    token: env.WECOM_TOKEN || '',
    aesKey: env.WECOM_AES_KEY || '',
    // 校验签名时是否强制比对 receiveId，本地模拟时关掉
    strictReceiveId: env.WECOM_STRICT_RECEIVEID !== '0',
  },

  // ===== 微信公众号（含测试号）=====
  // 与企业微信用同一套加解密算法，差别只在验签参数名和 receiveid：
  //   企业微信 receiveid = CorpID，公众号 receiveid = AppID
  wechat: {
    appId: env.WECHAT_APP_ID || '',
    token: env.WECHAT_TOKEN || '',
    aesKey: env.WECHAT_AES_KEY || '',
    // auto = 按请求特征自动判断；也可强制 safe / plain
    mode: env.WECHAT_MODE || 'auto',
  },

  // ===== 飞书多维表格 =====
  feishu: {
    appId: env.FEISHU_APP_ID || '',
    appSecret: env.FEISHU_APP_SECRET || '',
    appToken: env.FEISHU_APP_TOKEN || '',
    tableId: env.FEISHU_TABLE_ID || '',
    // 字段名映射：你表里叫什么就配什么
    fields: {
      amount: env.FEISHU_FIELD_AMOUNT || '金额',
      type: env.FEISHU_FIELD_TYPE || '类型',
      note: env.FEISHU_FIELD_NOTE || '备注',
      category: env.FEISHU_FIELD_CATEGORY || '分类',
      date: env.FEISHU_FIELD_DATE || '日期',
    },
    // 表里"类型"字段的选项值
    typeValues: {
      expense: env.FEISHU_TYPE_EXPENSE || '支出',
      income: env.FEISHU_TYPE_INCOME || '收入',
    },
  },

  // ===== 行为 =====
  app: {
    tzOffset: Number(env.APP_TZ_OFFSET || 8), // 时区偏移（小时）
    // 回执里是否附带"今日合计"。多查一次飞书，约慢 200~500ms
    showTodayTotal: env.APP_SHOW_TODAY_TOTAL !== '0',
    // 查飞书的超时（毫秒），超时就降级，保证 5 秒内回包。
    // 跨云链路（腾讯云 → open.feishu.cn）单次要 1.5~3 秒是常态，
    // 设太小会把「慢但成功」的请求活活掐死，所以留到 3800。
    feishuTimeoutMs: Number(env.APP_FEISHU_TIMEOUT_MS || 3800),
    // 「今日合计」单独的时间预算（毫秒）。记账已经成功，合计拿不到就不显示，
    // 绝不为了多一行统计让整条消息超时。
    // 跨云链路单次查询 1.3 秒左右，给 1500 才够；加完仍在 4.5 秒预算内。
    statsBudgetMs: Number(env.APP_STATS_BUDGET_MS || 1500),
    // 数据落地适配器：feishu | memory | json
    store: env.APP_STORE || 'feishu',
    // 云函数所在地域（诊断里显示，跨云链路快慢跟它强相关）
    region: env.TENCENTCLOUD_REGION || env.SCF_REGION || '',
    // 当 store=json 时，本地文件路径
    jsonFile: env.APP_JSON_FILE || './data/ledger.json',
  },
};

/** 配置自检：返回缺失项列表，空数组代表齐全 */
function validate(cfg) {
  const missing = [];
  if (cfg.app.store === 'feishu') {
    if (!cfg.feishu.appId) missing.push('FEISHU_APP_ID');
    if (!cfg.feishu.appSecret) missing.push('FEISHU_APP_SECRET');
    if (!cfg.feishu.appToken) missing.push('FEISHU_APP_TOKEN');
    if (!cfg.feishu.tableId) missing.push('FEISHU_TABLE_ID');
  }

  // 企业微信、公众号两套通道至少要完整配一套；两套都配也行，运行时自动分流
  const wecomOk = cfg.wecom.token && cfg.wecom.aesKey && cfg.wecom.corpId;
  const wechatOk = cfg.wechat.token && cfg.wechat.appId;
  // 公众号安全模式必须有 AESKey，明文模式可以没有
  const wechatSafeOk = wechatOk && cfg.wechat.aesKey;

  if (!wecomOk && !wechatSafeOk) {
    if (cfg.wecom.token || cfg.wecom.aesKey || cfg.wecom.corpId) {
      if (!cfg.wecom.token) missing.push('WECOM_TOKEN');
      if (!cfg.wecom.aesKey) missing.push('WECOM_AES_KEY');
      if (!cfg.wecom.corpId) missing.push('WECOM_CORP_ID');
    }
    if (cfg.wechat.token || cfg.wechat.appId) {
      if (!cfg.wechat.token) missing.push('WECHAT_TOKEN');
      if (!cfg.wechat.appId) missing.push('WECHAT_APP_ID');
    }
    if (!missing.length) {
      missing.push('WECOM_TOKEN/WECHAT_TOKEN（至少配一套通道）');
    }
  }
  return missing;
}

/** 当前启用了哪些通道，启动日志用 */
function channels(cfg) {
  const out = [];
  if (cfg.wecom.token && cfg.wecom.aesKey && cfg.wecom.corpId) out.push('企业微信');
  if (cfg.wechat.token && cfg.wechat.aesKey && cfg.wechat.appId) out.push('公众号安全模式');
  else if (cfg.wechat.token && cfg.wechat.appId) out.push('公众号明文模式');
  return out;
}

module.exports = { config, validate, channels };


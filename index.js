'use strict';

/**
 * 云函数统一入口
 * 腾讯云 SCF（函数 URL）/ 腾讯云 CloudBase / 阿里云 FC3 / 本地 server 都走这里
 *
 * 部署时：
 *   - 函数类型：事件函数（不能选 Web 函数）
 *   - 入口文件：index.js
 *   - 执行方法：main（或 index.main）
 *   - 运行环境：Node.js 18 及以上
 *   - HTTP 入口：函数 URL（API 网关已于 2025-06-30 下线，不再支持新建触发器）
 *
 * 返回值 { statusCode, headers, body } 会被函数 URL 原生解析成真实 HTTP 响应，
 * 不需要任何「集成响应」开关。
 */

const { config, validate, channels } = require('./src/config');
const { createStore } = require('./src/store');
const { createHandler } = require('./src/handler');
const { normalizeEvent } = require('./src/normalize');

let _handler = null;

function getHandler() {
  if (_handler) return _handler;
  const missing = validate(config);
  if (missing.length) {
    console.error('[boot] 缺少配置：' + missing.join(', '));
  }
  const store = createStore(config);
  _handler = createHandler({ config, store });
  const chs = channels(config);
  console.log(
    '[boot] 启动完成 store=' + store.name +
      ' tz=+' + config.app.tzOffset +
      ' 通道=' + (chs.length ? chs.join('+') : '无')
  );
  return _handler;
}

exports.main = async (event, context) => {
  const req = normalizeEvent(event);
  const res = await getHandler()(req);
  return {
    statusCode: res.statusCode || 200,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', ...(res.headers || {}) },
    body: res.body || '',
    isBase64Encoded: false,
  };
};

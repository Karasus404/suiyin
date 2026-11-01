'use strict';

/**
 * 云平台事件格式归一化
 * 一次写好，腾讯云 SCF（API 网关 / 函数 URL）/ 腾讯云 CloudBase / 阿里云 FC 都能用。
 *
 * 腾讯云 2025-06-30 下线 API 网关后，HTTP 入口只剩【函数 URL】，它的事件长这样：
 *   { body, headers, httpMethod, path, queryString: { a: '1' } }
 * 官方说明：兼容 apigw 协议，但去掉 headerParameters、isBase64Encoded、
 * pathParameters、queryStringParameters、requestContext。
 * 所以 query 只能从 event.queryString（对象）里取 —— 下面的分支顺序已经照顾到了。
 */

function isEmpty(obj) {
  return !obj || Object.keys(obj).length === 0;
}

function normalizeEvent(event) {
  if (!event) return { method: 'GET', query: {}, body: '' };

  // 方法：腾讯云 httpMethod / 阿里云 requestContext.http.method / API 网关 v2 requestContext.httpMethod
  const method =
    event.httpMethod ||
    (event.requestContext &&
      event.requestContext.http &&
      event.requestContext.http.method) ||
    (event.requestContext && event.requestContext.httpMethod) ||
    'GET';

  // Query：腾讯云 queryStringParameters(对象) / 阿里云 queryParameters(对象)
  let query = {};
  if (!isEmpty(event.queryStringParameters)) query = { ...event.queryStringParameters };
  else if (!isEmpty(event.queryParameters)) query = { ...event.queryParameters };

  // 腾讯云 SCF 还有一种 queryString 是对象；阿里云是字符串
  if (!isEmpty(event.queryString)) {
    if (typeof event.queryString === 'string') {
      for (const [k, v] of new URLSearchParams(event.queryString)) query[k] = v;
    } else {
      query = { ...event.queryString, ...query };
    }
  }

  if (isEmpty(query) && typeof event.rawQueryString === 'string' && event.rawQueryString) {
    for (const [k, v] of new URLSearchParams(event.rawQueryString)) query[k] = v;
  }

  let body = event.body || '';
  if (typeof body === 'object') body = JSON.stringify(body);
  if (event.isBase64Encoded && typeof body === 'string' && body) {
    body = Buffer.from(body, 'base64').toString('utf8');
  }

  return { method: String(method).toUpperCase(), query, body, headers: event.headers || {} };
}

module.exports = { normalizeEvent };

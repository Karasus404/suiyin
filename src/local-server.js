'use strict';

/**
 * 本地调试服务器
 * 用途一：用 tools/sim.js 发模拟消息，验证整条链路
 * 用途二：配内网穿透（cpolar / ngrok）后可直接接企业微信回调
 *
 * 启动： node src/local-server.js
 * 默认端口 3000
 */

const http = require('node:http');
const { config, validate } = require('./config');
const { createStore } = require('./store');
const { createHandler } = require('./handler');

const PORT = Number(process.env.PORT || 3000);

const missing = validate(config);
if (missing.length) {
  console.log('⚠️  以下配置还没填：' + missing.join(', '));
  console.log('   本地调试可以先用 APP_STORE=memory 跳过飞书配置\n');
}

const store = createStore(config);
const handler = createHandler({ config, store });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const query = Object.fromEntries(url.searchParams);

    if (url.pathname === '/' && req.method === 'GET' && !query.echostr) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('suiyin is running\nstore=' + store.name + '\n');
      return;
    }

    try {
      const out = await handler({ method: req.method, query, body });
      res.writeHead(out.statusCode || 200, out.headers || { 'Content-Type': 'text/plain' });
      res.end(out.body || '');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('error: ' + e.message);
    }
  });
});

server.listen(PORT, () => {
  console.log('✅ 本地服务已启动: http://127.0.0.1:' + PORT);
  console.log('   数据源: ' + store.name);
  console.log('   发模拟消息: node tools/sim.js "25 午饭"');
});

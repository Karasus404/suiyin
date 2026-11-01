'use strict';

const { createFeishuStore } = require('./feishu');
const { createMemoryStore, createJsonStore } = require('./local');

function createStore(cfg) {
  switch (cfg.app.store) {
    case 'feishu':
      return createFeishuStore(cfg);
    case 'json':
      return createJsonStore(cfg.app.jsonFile);
    case 'memory':
      return createMemoryStore();
    default:
      throw new Error('未知的 APP_STORE：' + cfg.app.store);
  }
}

module.exports = { createStore };

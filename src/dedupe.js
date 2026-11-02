'use strict';

/**
 * 消息级去重
 *
 * 平台在 5 秒内没拿到回包就会重投同一条消息（企业微信最多重投 3 次）。
 * 同一个函数实例里，按 MsgId 记住上次的回执就够了：重投时原样再发一遍，
 * 不再执行第二遍业务逻辑，也就不会记两笔、不会「删1」连删两条。
 *
 * 注意这里只是**进程内**去重。跨实例的重投（function 冷启动新实例、
 * 或者平台把两次投递分到不同实例）它挡不住 —— 飞书多维表格的新增记录接口
 * 即使带 client_token 也不做幂等（实测同 token 连发两次会落两条），
 * 所以跨实例那一层靠「记账后自检」和「去重」命令兜底，见 ledger.js。
 */

/** 进程内去重用的键：同一通道下的同一个 MsgId */
function messageKey(channelName, msgId) {
  if (!msgId) return '';
  return String(channelName) + ':' + String(msgId);
}

module.exports = { messageKey };

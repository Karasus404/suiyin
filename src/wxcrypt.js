'use strict';

/**
 * 企业微信 / 公众号 消息加解密
 *
 * 规则（官方「加解密方案说明」）：
 *  - AESKey = Base64Decode(EncodingAESKey + "=")，43 位 -> 32 字节
 *  - 加密算法 AES-256-CBC，IV = AESKey 前 16 字节
 *  - 明文结构：random(16B) + msg_len(4B, 网络字节序) + msg + receiveid
 *  - 填充：PKCS#7，块长 32 字节
 *  - 签名：sha1(字典序排序后的 [token, timestamp, nonce, encrypt] 拼接)
 */

const crypto = require('node:crypto');

const BLOCK_SIZE = 32;

function getAesKey(encodingAesKey) {
  if (!encodingAesKey) throw new Error('EncodingAESKey 未配置');
  if (encodingAesKey.length !== 43) {
    throw new Error('EncodingAESKey 应为 43 位字符，当前 ' + encodingAesKey.length + ' 位');
  }
  const key = Buffer.from(encodingAesKey + '=', 'base64');
  if (key.length !== 32) throw new Error('EncodingAESKey 解码后不是 32 字节');
  return key;
}

function signature(...parts) {
  const raw = parts.map((p) => String(p)).sort().join('');
  return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
}

/** 校验回调签名：msg_signature = sha1(sort(token, timestamp, nonce, encrypt)) */
function verifySignature({ token, msgSignature, timestamp, nonce, encrypt }) {
  if (!msgSignature) return false;
  const expect = signature(token, timestamp, nonce, encrypt);
  // 定长比较，避免时序侧信道
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(String(msgSignature).toLowerCase(), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function pkcs7Pad(buf) {
  const amount = BLOCK_SIZE - (buf.length % BLOCK_SIZE);
  return Buffer.concat([buf, Buffer.alloc(amount, amount)]);
}

function pkcs7Unpad(buf) {
  if (buf.length === 0) return buf;
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > BLOCK_SIZE) return buf; // 容错：不合法就不裁
  return buf.subarray(0, buf.length - pad);
}

/**
 * 解密，返回 { msg, receiveId }（不做 receiveid 校验，交给调用方判断，
 * 这样报错能精确说明「期望什么、实际收到什么」）
 */
function decryptFull(encryptBase64, aesKey) {
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
  decipher.setAutoPadding(false);
  let plain = Buffer.concat([
    decipher.update(Buffer.from(encryptBase64, 'base64')),
    decipher.final(),
  ]);
  plain = pkcs7Unpad(plain);
  if (plain.length < 20) throw new Error('解密失败：明文长度异常');

  const msgLen = plain.readUInt32BE(16);
  const msg = plain.subarray(20, 20 + msgLen).toString('utf8');
  const receiveId = plain.subarray(20 + msgLen).toString('utf8');
  return { msg, receiveId };
}

/**
 * 解密
 * @param {string} encryptBase64 密文（base64）
 * @param {Buffer} aesKey 32 字节 key
 * @param {string} [receiveId] 期望的接收方 ID（企业微信为 corpid，公众号为 AppID）
 */
function decrypt(encryptBase64, aesKey, receiveId) {
  const { msg, receiveId: fromId } = decryptFull(encryptBase64, aesKey);
  if (receiveId && fromId && fromId !== receiveId) {
    throw new Error('解密失败：receiveid 不匹配（得到 ' + fromId + '）');
  }
  return msg;
}

/** 加密 */
function encrypt(msg, aesKey, receiveId) {
  const random = crypto.randomBytes(16);
  const msgBuf = Buffer.from(msg, 'utf8');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBuf.length, 0);
  const idBuf = Buffer.from(receiveId || '', 'utf8');

  const plain = pkcs7Pad(Buffer.concat([random, lenBuf, msgBuf, idBuf]));
  const iv = aesKey.subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
  cipher.setAutoPadding(false);
  const out = Buffer.concat([cipher.update(plain), cipher.final()]);
  return out.toString('base64');
}

/** 便捷方法：用字符串 key 解密 */
function decryptWith(strKey, encryptBase64, receiveId) {
  return decrypt(encryptBase64, getAesKey(strKey), receiveId);
}

/** 便捷方法：解密并拿到 receiveId（不校验） */
function decryptWithFull(strKey, encryptBase64) {
  return decryptFull(encryptBase64, getAesKey(strKey));
}

/** 便捷方法：用字符串 key 加密 */
function encryptWith(strKey, msg, receiveId) {
  return encrypt(msg, getAesKey(strKey), receiveId);
}

// ============ XML 小工具 ============

/** 取 XML 中某个标签的文本（兼容 CDATA） */
function xmlPick(xml, tag) {
  const re = new RegExp('<' + tag + '>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</' + tag + '>');
  const m = re.exec(xml);
  return m ? m[1].trim() : '';
}

function cdata(s) {
  return '<![CDATA[' + String(s == null ? '' : s).replace(/\]\]>/g, ']]]]><![CDATA[>') + ']]>';
}

/** 构造被动回复的加密信封 */
function buildEncryptedEnvelope(encryptedMsg, token, timestamp, nonce) {
  const sig = signature(token, timestamp, nonce, encryptedMsg);
  return (
    '<xml>' +
    '<Encrypt>' + cdata(encryptedMsg) + '</Encrypt>' +
    '<MsgSignature>' + cdata(sig) + '</MsgSignature>' +
    '<TimeStamp>' + timestamp + '</TimeStamp>' +
    '<Nonce>' + cdata(nonce) + '</Nonce>' +
    '</xml>'
  );
}

/** 构造明文文本消息体（被动回复用） */
function buildTextMessage({ toUser, fromUser, content, createTime }) {
  return (
    '<xml>' +
    '<ToUserName>' + cdata(toUser) + '</ToUserName>' +
    '<FromUserName>' + cdata(fromUser) + '</FromUserName>' +
    '<CreateTime>' + createTime + '</CreateTime>' +
    '<MsgType>' + cdata('text') + '</MsgType>' +
    '<Content>' + cdata(content) + '</Content>' +
    '</xml>'
  );
}

module.exports = {
  getAesKey,
  signature,
  verifySignature,
  encrypt,
  decrypt,
  decryptFull,
  encryptWith,
  decryptWith,
  decryptWithFull,
  xmlPick,
  cdata,
  buildEncryptedEnvelope,
  buildTextMessage,
};

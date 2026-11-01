'use strict';

/**
 * 模拟微信服务器：把一条文本加密后 POST 给本地服务，再把回复解密打印出来。
 * 用来在没有真实账号的情况下验证整条链路。
 *
 * 用法：
 *   node tools/sim.js "25 午饭"                  # 走企业微信（默认）
 *   node tools/sim.js --wechat "25 午饭"          # 走公众号安全模式
 *   node tools/sim.js --wechat --plain "25 午饭"  # 走公众号明文模式
 *   SIM_URL=http://127.0.0.1:3000 node tools/sim.js "帮助"
 */

const { config } = require('../src/config');
const wxcrypt = require('../src/wxcrypt');

const SIM_URL = process.env.SIM_URL || 'http://127.0.0.1:3000';
const SIM_USER = process.env.SIM_USER || 'sim_user';

const argv = process.argv.slice(2);
const useWechat = argv.includes('--wechat');
const usePlain = argv.includes('--plain');
const text =
  argv.filter((a) => !a.startsWith('--')).join(' ') || '25 午饭';

/** 选通道：企业微信 vs 公众号 */
function pickChannel() {
  if (useWechat) {
    const { appId, token, aesKey } = config.wechat;
    if (!token || !appId) {
      throw new Error('先配好 WECHAT_TOKEN / WECHAT_APP_ID（可写在 .env 里）');
    }
    const plain = usePlain || !aesKey;
    return {
      label: plain ? '公众号 · 明文模式' : '公众号 · 安全模式',
      token,
      aesKey: plain ? '' : aesKey,
      receiveId: appId,
      toUser: 'gh_sim0000000000',
      plain,
    };
  }

  const { token, aesKey, corpId } = config.wecom;
  if (!token || !aesKey || !corpId) {
    throw new Error('先配好 WECOM_TOKEN / WECOM_AES_KEY / WECOM_CORP_ID（可写在 .env 里）');
  }
  return {
    label: '企业微信',
    token,
    aesKey,
    receiveId: corpId,
    toUser: corpId,
    plain: false,
  };
}

async function send(text) {
  const ch = pickChannel();
  if (!ch.plain && ch.aesKey.length !== 43) {
    throw new Error('EncodingAESKey 必须是 43 位');
  }

  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = Math.random().toString(36).slice(2, 12);
  const msgId = String(Date.now());

  const plainMsg =
    '<xml>' +
    '<ToUserName>' + wxcrypt.cdata(ch.toUser) + '</ToUserName>' +
    '<FromUserName>' + wxcrypt.cdata(SIM_USER) + '</FromUserName>' +
    '<CreateTime>' + ts + '</CreateTime>' +
    '<MsgType>' + wxcrypt.cdata('text') + '</MsgType>' +
    '<Content>' + wxcrypt.cdata(text) + '</Content>' +
    '<MsgId>' + msgId + '</MsgId>' +
    '</xml>';

  let url;
  let body;

  if (ch.plain) {
    // 明文模式：body 就是消息本身，只带 signature
    const sig = wxcrypt.signature(ch.token, ts, nonce);
    url =
      SIM_URL + '?signature=' + encodeURIComponent(sig) +
      '&timestamp=' + ts + '&nonce=' + nonce;
    body = plainMsg;
  } else {
    const encrypted = wxcrypt.encryptWith(ch.aesKey, plainMsg, ch.receiveId);
    const sig = wxcrypt.signature(ch.token, ts, nonce, encrypted);
    url =
      SIM_URL + '?msg_signature=' + encodeURIComponent(sig) +
      '&timestamp=' + ts + '&nonce=' + nonce;
    body =
      '<xml>' +
      '<ToUserName>' + wxcrypt.cdata(ch.toUser) + '</ToUserName>' +
      '<Encrypt>' + wxcrypt.cdata(encrypted) + '</Encrypt>' +
      '</xml>';
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body,
  });
  const respText = await res.text();

  console.log('→ 通道: ' + ch.label);
  console.log('→ 发送: ' + text);
  console.log('  HTTP ' + res.status);

  let content = '';

  if (ch.plain) {
    if (!respText.trim()) {
      console.log('  (空回包)');
      return;
    }
    content = wxcrypt.xmlPick(respText, 'Content');
    if (!content) {
      console.log('  原始响应: ' + respText.slice(0, 500));
      return;
    }
  } else {
    const enc = wxcrypt.xmlPick(respText, 'Encrypt');
    if (!enc) {
      console.log('  原始响应: ' + respText.slice(0, 500));
      return;
    }
    const sigOk = wxcrypt.verifySignature({
      token: ch.token,
      msgSignature: wxcrypt.xmlPick(respText, 'MsgSignature'),
      timestamp: wxcrypt.xmlPick(respText, 'TimeStamp'),
      nonce: wxcrypt.xmlPick(respText, 'Nonce'),
      encrypt: enc,
    });
    console.log('  回复签名校验: ' + (sigOk ? '✅ 通过' : '❌ 失败'));
    const plainReply = wxcrypt.decryptWith(ch.aesKey, enc, ch.receiveId);
    content = wxcrypt.xmlPick(plainReply, 'Content');
  }

  console.log('\n← 机器人回复:');
  for (const line of String(content).split('\n')) console.log('  ' + line);
}

send(text).catch((e) => {
  console.error('❌ ' + e.message);
  process.exit(1);
});

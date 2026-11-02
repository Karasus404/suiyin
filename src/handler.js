'use strict';

/**
 * 平台无关的 HTTP 处理器
 * 输入 { method, query, body }，输出 { statusCode, headers, body }
 * 各云平台的适配层只做"事件格式 → 这个结构"的翻译。
 *
 * 同时支持两条通道：
 *   企业微信自建应用 —— msg_signature，加密，receiveid = CorpID
 *   微信公众号/测试号 —— 安全模式同企业微信；明文/兼容模式用 signature，receiveid = AppID
 *
 * 两套凭证可以同时配，靠"签名校验通过"自动分流，不需要人工指定通道。
 */

const crypto = require('node:crypto');
const wxcrypt = require('./wxcrypt');
const { handleText } = require('./ledger');
const dedupe = require('./dedupe');

// 企业微信/微信都要求 5 秒内响应，留 0.5 秒给网络
const REPLY_BUDGET_MS = 4500;

function safeDecode(v) {
  if (typeof v !== 'string') return v;
  if (!v.includes('%')) return v;
  try {
    return decodeURIComponent(v.replace(/\+/g, ' '));
  } catch (_) {
    return v;
  }
}

/** 定长比较，避免时序侧信道 */
function safeEqual(a, b) {
  const x = Buffer.from(String(a).toLowerCase(), 'utf8');
  const y = Buffer.from(String(b).toLowerCase(), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 从配置里整理出可用的通道清单 */
function buildChannels(config) {
  const list = [];
  const wecom = config.wecom || {};
  const wechat = config.wechat || {};

  if (wecom.token && wecom.aesKey && wecom.corpId) {
    list.push({
      name: 'wecom',
      label: '企业微信',
      token: wecom.token,
      aesKey: wecom.aesKey,
      receiveId: wecom.corpId,
      strict: wecom.strictReceiveId !== false,
    });
  }

  if (wechat.token && wechat.appId) {
    list.push({
      name: 'wechat',
      label: '公众号',
      token: wechat.token,
      aesKey: wechat.aesKey || '',
      receiveId: wechat.appId,
      // 安全模式下 receiveid 一定等于 AppID；明文模式没有加密也没有 receiveid
      strict: !!wechat.aesKey,
      mode: wechat.mode || 'auto',
    });
  }

  return list;
}

function createHandler({ config, store, logger = console }) {
  const channels = buildChannels(config);
  if (!channels.length) {
    logger.error('[handler] 没有可用的通道配置（企业微信或公众号至少配一套）');
  }

  // 实例级状态：第一条消息记冷启动，并缓存最近的回执用于去重
  let sawFirstMessage = false;
  const DEDUPE_TTL = 5 * 60 * 1000;
  const DEDUPE_MAX = 300;
  const replyCache = new Map();
  // 同一条消息正在处理中（并发的两次重投）：等着一起用，别再执行一遍
  const inflight = new Map();

  /**
   * 平台在 5 秒内没收到回包会重投同一条消息（企业微信最多 3 次）。
   * 同一条消息只办一次事：认 MsgId，重复的直接把上次的回执再发一遍。
   * 否则「删1」会被连删两条、记账会记两笔。
   */
  function cacheGet(ch, msgId) {
    if (!msgId) return null;
    const hit = replyCache.get(ch.name + ':' + msgId);
    if (!hit) return null;
    if (Date.now() - hit.at > DEDUPE_TTL) {
      replyCache.delete(ch.name + ':' + msgId);
      return null;
    }
    return hit.text;
  }

  function cachePut(ch, msgId, text) {
    if (!msgId || !text) return;
    if (replyCache.size >= DEDUPE_MAX) {
      replyCache.delete(replyCache.keys().next().value);
    }
    replyCache.set(ch.name + ':' + msgId, { at: Date.now(), text });
  }

  /**
   * 找出这条请求属于哪个通道。
   * 判断依据是「签名能对上」——签名本身就是身份证明，不用额外配置项。
   * @returns {{ch, encrypted:boolean}}
   */
  function matchChannel(query, encrypt) {
    const msgSig = safeDecode(query.msg_signature || query.msgsignature);
    const plainSig = safeDecode(query.signature);
    const timestamp = safeDecode(query.timestamp);
    const nonce = safeDecode(query.nonce);

    if (!timestamp || !nonce) throw new Error('缺少 timestamp / nonce 参数');

    // ---- 密文模式：msg_signature = sha1(sort(token, timestamp, nonce, encrypt))
    if (encrypt && msgSig) {
      for (const ch of channels) {
        if (!ch.aesKey) continue;
        if (
          wxcrypt.verifySignature({
            token: ch.token,
            msgSignature: msgSig,
            timestamp,
            nonce,
            encrypt,
          })
        ) {
          return { ch, encrypted: true };
        }
      }
      throw new Error('签名校验失败（密文）：Token 和后台填的不一致');
    }

    // ---- 明文模式：signature = sha1(sort(token, timestamp, nonce))，不含 encrypt
    if (plainSig) {
      for (const ch of channels) {
        if (safeEqual(wxcrypt.signature(ch.token, timestamp, nonce), plainSig)) {
          return { ch, encrypted: false };
        }
      }
      throw new Error('签名校验失败（明文）：Token 和后台填的不一致');
    }

    throw new Error('缺少签名参数：既没有 msg_signature 也没有 signature');
  }

  /** 解密并校验 receiveid，失败给出精确原因 */
  function decryptFor(ch, encrypt) {
    if (!ch.aesKey) {
      throw new Error('该通道未配置 AESKey，无法解密');
    }
    let out;
    try {
      out = wxcrypt.decryptWithFull(ch.aesKey, encrypt);
    } catch (e) {
      throw new Error('解密失败：' + e.message + '（AESKey 可能抄错了）');
    }
    if (ch.strict && out.receiveId && out.receiveId !== ch.receiveId) {
      const hint =
        ch.name === 'wechat'
          ? '期望公众号 AppID（wx 开头），实际收到 ' + out.receiveId
          : '期望企业 CorpID（ww 开头），实际收到 ' + out.receiveId;
      throw new Error('解密成功但 receiveid 不匹配：' + hint);
    }
    return out.msg;
  }

  /** GET：保存回调配置时的 URL 有效性验证 */
  function handleVerify(query) {
    const echostr = safeDecode(query.echostr || '');
    if (!echostr) return { statusCode: 400, body: 'missing echostr' };

    // 密文模式下 echostr 是密文；明文模式下就是一段随机串，原样返回
    const looksEncrypted = !!safeDecode(query.msg_signature || query.msgsignature);

    try {
      if (!looksEncrypted) {
        const { ch } = matchChannel(query, '');
        logger.log('[verify] URL 验证通过（' + ch.label + ' · 明文模式）');
        return {
          statusCode: 200,
          headers: { 'Content-Type': 'text/plain' },
          body: echostr,
        };
      }
      const { ch } = matchChannel(query, echostr);
      const plain = decryptFor(ch, echostr);
      logger.log('[verify] URL 验证通过（' + ch.label + ' · 安全模式）');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: plain,
      };
    } catch (e) {
      logger.error('[verify] URL 验证失败：', e.message);
      return { statusCode: 401, body: 'verify failed: ' + e.message };
    }
  }

  /** POST：接收用户消息 */
  async function handleMessage(query, body) {
    const startedAt = Date.now();
    const encrypt = wxcrypt.xmlPick(body, 'Encrypt');

    // 既没有密文、也没有明文模式才有的 signature —— 不是正常的消息推送
    // （可能是网关探测、或后台的连通性检查）。
    // 返回 200 空包忽略掉：回 4xx 会让企业微信/微信认为投递失败并反复重试。
    const plainSig = query.signature;
    if (!encrypt && !plainSig) {
      logger.warn('[msg] 请求体既无 Encrypt 也无明文签名，忽略');
      return { statusCode: 200, body: '' };
    }

    let ch;
    let plainMsg;
    let encrypted = false;
    try {
      if (encrypt) {
        const matched = matchChannel(query, encrypt);
        ch = matched.ch;
        plainMsg = decryptFor(ch, encrypt);
        encrypted = true;
      } else {
        // 明文模式：body 本身就是消息 XML
        const matched = matchChannel(query, '');
        ch = matched.ch;
        plainMsg = body;
      }
    } catch (e) {
      logger.error('[msg] 校验/解密失败：', e.message);
      return { statusCode: 401, body: 'reject: ' + e.message };
    }

    const fromUser = wxcrypt.xmlPick(plainMsg, 'FromUserName');
    const toUser = wxcrypt.xmlPick(plainMsg, 'ToUserName') || ch.receiveId;
    const msgType = wxcrypt.xmlPick(plainMsg, 'MsgType');
    const content = wxcrypt.xmlPick(plainMsg, 'Content');
    const msgId = wxcrypt.xmlPick(plainMsg, 'MsgId');
    const event = wxcrypt.xmlPick(plainMsg, 'Event');
    logger.log(
      '[' + ch.name + '] 收到 ' + msgType + (event ? '/' + event : '') +
        ' | ' + fromUser + ' | ' + JSON.stringify(content) + ' | msgId=' + msgId
    );

    const now = Math.floor(Date.now() / 1000);
    const coldStart = !sawFirstMessage;
    sawFirstMessage = true;

    // 同一条消息被重投（上次回包慢了）→ 直接重发上次的回执，绝不重复记账
    const mkey = dedupe.messageKey(ch.name, msgId);
    const dup = cacheGet(ch, msgId);
    if (dup) {
      logger.log('[' + ch.name + '] 重复投递 msgId=' + msgId + '，直接复用上次回执');
      return buildReply({
        ch, encrypted, toUser: fromUser, fromUser: toUser, replyText: dup, now, startedAt, logger,
      });
    }

    // 同一条消息的另一次投递还在处理中（并发的两次重投）：等它的结果，别再执行一遍
    const running = mkey ? inflight.get(mkey) : null;
    if (running) {
      logger.log('[' + ch.name + '] msgId=' + msgId + ' 上一次投递仍在处理，等它的结果');
      let text = '';
      try {
        text = await running;
      } catch (_) {
        text = '⏳ 上一条还在处理，稍等几秒再发一次';
      }
      return buildReply({
        ch, encrypted, toUser: fromUser, fromUser: toUser, replyText: text, now, startedAt, logger,
      });
    }

    // 关注/取消关注等事件，回一句欢迎语就够了
    if (msgType === 'event') {
      const replyText = event === 'subscribe'
        ? '你好，我是碎银，你的记账小助手 👋\n\n发「25 午饭」我帮你记一笔\n发「帮助」看完整用法'
        : '';
      if (!replyText) return { statusCode: 200, body: '' };
      return buildReply({
        ch, encrypted, toUser: fromUser, fromUser: toUser, replyText, now, startedAt, logger,
      });
    }

    let replyText;
    if (msgType !== 'text') {
      replyText = '暂时只认文字消息～\n发「帮助」看记账格式';
    } else {
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          logger.warn('[msg] 超过 ' + REPLY_BUDGET_MS + 'ms 未完成，回超时提示');
          resolve('⏳ 这次有点慢，命令可能已经执行了\n发「明细」确认一下，别急着重发');
        }, REPLY_BUDGET_MS);
      });

      const work = (async () => {
        try {
          const ledgerWork = handleText(content, {
            store,
            cfg: config,
            deadline: startedAt + REPLY_BUDGET_MS - 300, // 留 300ms 组装并发出回包
            logger,
            channel: ch.label,
            coldStart,
          });
          // 就算这边先超时回了话，等它真跑完也把结果补进缓存，
          // 下次重投就能拿到「确实记上了」的回执，而不是继续等
          ledgerWork
            .then((real) => cachePut(ch, msgId, real))
            .catch(() => {});
          return await Promise.race([ledgerWork, timeout]);
        } catch (e) {
          logger.error('[ledger] 处理失败：', e.stack || e.message);
          return '⚠️ 出错了：' + String(e.message || e).slice(0, 100) + '\n稍后再试一次';
        } finally {
          clearTimeout(timer);
        }
      })();

      if (mkey) inflight.set(mkey, work);
      try {
        replyText = await work;
      } finally {
        if (mkey) inflight.delete(mkey);
      }
      cachePut(ch, msgId, replyText);
    }

    return buildReply({
      ch, encrypted, toUser: fromUser, fromUser: toUser, replyText, now, startedAt, logger,
    });
  }

  /**
   * 组装回包。
   * 是否加密取决于「这条请求本身是否加密」，而不是配置里有没有 AESKey ——
   * 公众号明文模式下即使填了 EncodingAESKey，回包也必须是明文。
   */
  function buildReply({ ch, encrypted, toUser, fromUser, replyText, now, startedAt, logger }) {
    const plainReply = wxcrypt.buildTextMessage({
      toUser,
      fromUser,
      content: replyText || '',
      createTime: now,
    });

    let body;
    if (encrypted && ch.aesKey) {
      const cipher = wxcrypt.encryptWith(ch.aesKey, plainReply, ch.receiveId);
      const nonce = Math.random().toString(36).slice(2, 12);
      body = wxcrypt.buildEncryptedEnvelope(cipher, ch.token, String(now), nonce);
    } else {
      body = plainReply;
    }

    // 这行是排查「有记录、没回信」的关键线索：
    // 日志里有它 = 回包已经发出，问题在传输侧；
    // 没有它 = 函数在中途被掐断了（多半是云函数超时时间太小）
    const elapsed = Date.now() - startedAt;
    logger.log(
      '[' + ch.name + '] 回包完成 耗时 ' + elapsed + 'ms' +
        (elapsed > 4500 ? ' ⚠️ 超过 5 秒上限' : '')
    );

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'X-Reply-Elapsed': String(elapsed),
      },
      body,
    };
  }

  return async function handle(req) {
    const method = String(req.method || 'GET').toUpperCase();
    try {
      if (method === 'GET') return handleVerify(req.query || {});
      if (method === 'POST') return handleMessage(req.query || {}, req.body || '');
      return { statusCode: 405, body: 'method not allowed' };
    } catch (e) {
      logger.error('[handler] 未捕获异常：', e.stack || e.message);
      return { statusCode: 500, body: 'internal error' };
    }
  };
}

module.exports = { createHandler, REPLY_BUDGET_MS, buildChannels };

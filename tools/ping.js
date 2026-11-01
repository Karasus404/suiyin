'use strict';

/**
 * 远程探测已部署的云函数 —— 判断「收不到回信」到底卡在哪一段
 *
 * 用法：
 *   node tools/ping.js https://xxxx-yyyy.ap-guangzhou.tencentscf.com
 *   node tools/ping.js https://xxx.tencentscf.com --msg "25 午饭"
 *
 * 三步探测，每步只验证一件事，坏在哪一步一目了然：
 *   1. 裸 GET        → URL 对不对、公网通不通、函数起没起来
 *   2. 模拟验证请求  → Token / AESKey / CorpID 三个配置对不对
 *   3. 模拟推送消息  → 业务逻辑 + 飞书写入 + 加密回包
 *
 * 第 3 步默认发「帮助」（只读，不写任何数据）。
 */

const { config } = require('../src/config');
const wxcrypt = require('../src/wxcrypt');

const TIMEOUT_MS = 15000;

function color(s, code) {
  if (!process.stdout.isTTY) return s;
  return '\u001b[' + code + 'm' + s + '\u001b[0m';
}
const dim = (s) => color(s, '90');
const green = (s) => color(s, '32');
const red = (s) => color(s, '31');
const yellow = (s) => color(s, '33');
const bold = (s) => color(s, '1');

function step(n, title) {
  console.log('');
  console.log(bold('【' + n + '】' + title));
}

function line(label, value) {
  console.log('    ' + dim(label + '：') + value);
}

function ok(msg) {
  console.log('    ' + green('✅ ' + msg));
}

function bad(msg, hint) {
  console.log('    ' + red('❌ ' + msg));
  if (hint) console.log('       ' + yellow('→ ' + hint));
}

function warn(msg) {
  console.log('    ' + yellow('⚠️  ' + msg));
}

function clip(s, n = 160) {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

async function request(url, opts) {
  const t0 = Date.now();
  const res = await fetch(url, {
    ...opts,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.text();
  const headers = {};
  for (const [k, v] of res.headers.entries()) headers[k] = v;
  return {
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    headers,
    body,
    ms: Date.now() - t0,
  };
}

function printRaw(r) {
  line('HTTP', String(r.status) + ' · ' + r.ms + 'ms');
  if (r.contentType) line('Content-Type', r.contentType);
  // 回包是否被网关改写，全看这几个头
  const keys = ['content-length', 'transfer-encoding', 'x-scf-request-id', 'x-reply-elapsed'];
  const extra = keys.filter((k) => r.headers && r.headers[k]).map((k) => k + '=' + r.headers[k]);
  if (extra.length) line('其他响应头', extra.join('  '));
  line('返回内容', clip(r.body, 220) || dim('(空)'));
}

/** 耗时解读：分档说明，越界就是超时嫌疑 */
function explainTiming(ms) {
  if (ms > 4800) {
    return bad(
      '耗时 ' + ms + 'ms 超过企业微信 5 秒上限',
      '真实推送时企业微信会先断开、再重试，你看到的就是「没回信」，而飞书里会留下 2-4 条重复记录'
    );
  }
  if (ms > 3000) {
    return warn(
      '耗时 ' + ms + 'ms，已经逼近企业微信上限',
      '如果云函数的「超时时间」还停在默认 3 秒，这一笔在写进飞书之后就会被强制中断 —— 飞书有记录、微信没回信，症状完全一致'
    );
  }
  if (ms > 1200) {
    return line('耗时', ms + 'ms（偏慢但可接受，多半是冷启动）');
  }
  return ok('耗时 ' + ms + 'ms，很快');
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith('--'));
  const msgIdx = args.indexOf('--msg');
  const testMsg = msgIdx >= 0 ? args[msgIdx + 1] : '帮助';

  if (!url) {
    console.log('');
    console.log('  用法：node tools/ping.js <函数URL> [--msg "要发的内容"]');
    console.log('');
    console.log('  例：node tools/ping.js https://abc12345-xyz98765.ap-guangzhou.tencentscf.com');
    console.log('');
    process.exit(1);
  }

  let base;
  try {
    base = new URL(url);
  } catch (e) {
    console.log(red('  URL 格式不对：' + url));
    process.exit(1);
  }

  // 通道选择：命令行 --wechat / --wecom 优先；否则用配置完整的那套
  const argvAll = process.argv.slice(2);
  const wantCh = argvAll.includes('--wechat')
    ? 'wechat'
    : argvAll.includes('--wecom')
    ? 'wecom'
    : '';

  function pickChannel() {
    const wc = config.wecom || {};
    const wx = config.wechat || {};
    const wecomOk = !!(wc.token && wc.aesKey && wc.corpId);
    const wechatOk = !!(wx.token && wx.appId);
    const name = wantCh || (wecomOk ? 'wecom' : wechatOk ? 'wechat' : 'wecom');

    if (name === 'wechat') {
      const miss = [];
      if (!wx.token) miss.push('WECHAT_TOKEN');
      if (!wx.appId) miss.push('WECHAT_APP_ID');
      if (miss.length) {
        console.log(red('  .env 里缺少：' + miss.join(', ') + '（探测需要本地这两个值）'));
        process.exit(1);
      }
      const plain = !wx.aesKey;
      return {
        label: '公众号',
        mode: plain ? '明文模式' : '安全模式',
        token: wx.token,
        aesKey: wx.aesKey,
        receiveId: wx.appId,
        plain,
      };
    }

    const miss = [];
    if (!wc.token) miss.push('WECOM_TOKEN');
    if (!wc.aesKey) miss.push('WECOM_AES_KEY');
    if (!wc.corpId) miss.push('WECOM_CORP_ID');
    if (miss.length) {
      console.log(red('  .env 里缺少：' + miss.join(', ') + '（探测需要本地这三个值）'));
      if (wechatOk) {
        console.log(dim('  你配的是公众号，加 --wechat 参数：'));
        console.log(dim('  .\\ping.cmd <URL> --wechat'));
      }
      process.exit(1);
    }
    return {
      label: '企业微信',
      mode: '安全模式',
      token: wc.token,
      aesKey: wc.aesKey,
      receiveId: wc.corpId,
      plain: false,
    };
  }

  const ch = pickChannel();
  const { token, aesKey, receiveId: corpId, plain: isPlain } = ch;

  console.log('');
  console.log(bold('探测目标：') + base.origin);
  console.log(
    dim(
      '本地凭证：' + ch.label + ' · ' + ch.mode +
        '  id=' + corpId +
        '  token=' + token.length + '位' +
        (aesKey ? '  aesKey=' + aesKey.length + '位' : '')
    )
  );

  let reachable = false;
  let authOk = false;
  let endToEndOk = false;

  // ---------- 1. 裸 GET ----------
  step(1, '裸 GET（不带任何参数）—— 验证 URL 和公网访问');
  try {
    const r = await request(base.href, { method: 'GET' });
    printRaw(r);
    if (/missing echostr/i.test(r.body)) {
      reachable = true;
      ok('函数通了，URL 正确，公网访问已开启');
    } else if (r.status >= 200 && r.status < 300) {
      reachable = true;
      warn('能访问，但返回的不是 missing echostr —— 可能是别的服务占了这个地址');
    } else if (r.status === 401 || r.status === 403) {
      bad(
        'HTTP ' + r.status + '，请求被挡在函数外面',
        '函数 URL 的「授权类型」选成了「CAM 鉴权」，改成「开放」'
      );
    } else if (/statusCode/.test(r.body)) {
      bad(
        '返回的是 JSON 原文而不是纯文本',
        '函数返回结构不对，检查 index.js 是否被改动过'
      );
    } else {
      bad('HTTP ' + r.status, '函数里抛错了，去 SCF「日志查询」看堆栈');
    }
  } catch (e) {
    bad(
      '连不上：' + (e.name === 'TimeoutError' ? '超时 ' + TIMEOUT_MS / 1000 + ' 秒' : e.message),
      '① 函数 URL 的「公网访问」没启用；② 地址抄错；③ 地域不通'
    );
  }

  // ---------- 2. 模拟平台的 URL 验证 ----------
  step(
    2,
    '模拟' + ch.label + '的 URL 验证 —— 验证 Token' +
      (isPlain ? '' : ' / AESKey / receiveid')
  );
  if (!reachable) {
    console.log('    ' + dim('第 1 步没过，跳过'));
  } else {
    const plain = 'wl-ping-' + Date.now();
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = Math.random().toString(36).slice(2, 12);
    let qs = null;
    let enc = null;

    if (isPlain) {
      // 公众号明文模式：签名不含密文，echostr 就是明文
      qs = {
        signature: wxcrypt.signature(token, ts, nonce),
        timestamp: ts,
        nonce,
        echostr: plain,
      };
    } else {
      try {
        enc = wxcrypt.encryptWith(aesKey, plain, corpId);
      } catch (e) {
        bad('本地加密失败：' + e.message, 'EncodingAESKey 不是合法的 43 位 base64');
        enc = null;
      }
      if (enc) {
        qs = {
          msg_signature: wxcrypt.signature(token, ts, nonce, enc),
          timestamp: ts,
          nonce,
          echostr: enc,
        };
      }
    }

    if (qs) {
      const u = new URL(base.href);
      u.search = new URLSearchParams(qs).toString();

      try {
        const r = await request(u.href, { method: 'GET' });
        printRaw(r);
        if (r.body.trim() === plain) {
          authOk = true;
          ok('签名校验、回包全部正确 —— ' + (isPlain ? '两个' : '三个') + '凭证都对');
        } else if (r.status === 401 && /签名校验失败/.test(r.body)) {
          bad('签名校验失败', 'Token 和后台填的不一致（' + (isPlain ? 'WECHAT_TOKEN' : 'WECOM_TOKEN') + '）');
        } else if (/解密失败/.test(r.body)) {
          bad('解密失败', 'AESKey 不一致，或者 receiveid 对不上（企业微信要 CorpID，公众号要 AppID）');
        } else if (!r.body.trim()) {
          bad('返回空', 'handler 没走到回包分支，看 SCF 日志');
        } else if (!/^[\x20-\x7E\u4e00-\u9fa5\s]*$/.test(r.body.trim())) {
          // 服务端用自己的 key 解出了一堆乱码：说明两边的 AESKey 不是同一个
          bad(
            '返回了一段乱码（不是明文，也不是错误提示）',
            'EncodingAESKey 不一致 —— 本地 .env 里的和云函数环境变量里的必须完全相同'
          );
        } else {
          bad('返回内容和预期不符', '预期 "' + plain + '"，实际见上方');
        }
      } catch (e) {
        bad('请求失败：' + e.message);
      }
    }
  }

  // ---------- 3. 模拟推送一条消息 ----------
  step(3, '模拟' + ch.label + '推送一条消息「' + testMsg + '」—— 验证完整链路');
  if (!authOk) {
    console.log('    ' + dim('第 2 步没过，跳过'));
  } else {
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = Math.random().toString(36).slice(2, 12);

    const innerMsg =
      '<xml>' +
      '<ToUserName><![CDATA[' + corpId + ']]></ToUserName>' +
      '<FromUserName><![CDATA[wl-ping-user]]></FromUserName>' +
      '<CreateTime>' + ts + '</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[' + testMsg + ']]></Content>' +
      '<MsgId>1234567890123456</MsgId>' +
      (isPlain ? '' : '<AgentID>1000002</AgentID>') +
      '</xml>';

    let envelope;
    let qs3;
    if (isPlain) {
      envelope = innerMsg;
      qs3 = {
        signature: wxcrypt.signature(token, ts, nonce),
        timestamp: ts,
        nonce,
      };
    } else {
      const encMsg = wxcrypt.encryptWith(aesKey, innerMsg, corpId);
      envelope = wxcrypt.buildEncryptedEnvelope(encMsg, token, ts, nonce);
      qs3 = {
        msg_signature: wxcrypt.signature(token, ts, nonce, encMsg),
        timestamp: ts,
        nonce,
      };
    }

    const u = new URL(base.href);
    u.search = new URLSearchParams(qs3).toString();

    try {
      const r = await request(u.href, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml' },
        body: envelope,
      });
      printRaw(r);
      explainTiming(r.ms);
      if (r.headers && r.headers['x-reply-elapsed']) {
        line('函数内部耗时', r.headers['x-reply-elapsed'] + 'ms（从收到消息到生成回包）');
      }

      const backEnc = wxcrypt.xmlPick(r.body, 'Encrypt');

      // 明文模式：回包本身就是 XML，没有 Encrypt 节点，直接取 Content
      if (isPlain && r.body.trim() && !backEnc) {
        const content = wxcrypt.xmlPick(r.body, 'Content');
        const toUser = wxcrypt.xmlPick(r.body, 'ToUserName');
        const fromUser = wxcrypt.xmlPick(r.body, 'FromUserName');

        if (!content) {
          bad('回包里没有 Content 节点', '返回内容见上方，去函数日志看原因');
        } else {
          const ct = (r.contentType || '').toLowerCase();
          if (/xml/.test(ct)) {
            ok('Content-Type 是 ' + ct + '，微信认得');
          } else if (!ct) {
            warn('响应里没有 Content-Type 头，通常也能收，但先记一笔');
          } else {
            bad(
              'Content-Type 是 ' + ct + '，不是 xml',
              '微信可能因此不解析回包 → 表现就是「账记上了、微信没回信」'
            );
          }

          console.log('');
          console.log('    ' + bold(ch.label + '实际会收到：'));
          String(content).split('\n').forEach((l) => console.log('      ' + green(l)));
          console.log('');
          line('ToUserName（收件人）', toUser || dim('(空)'));
          line('FromUserName（发件人）', fromUser || dim('(空)'));

          if (content && toUser && fromUser) {
            ok('回包结构完整，收/发件人对调正确');
            endToEndOk = true;
          } else {
            bad(
              '回包缺少必要字段',
              'ToUserName / FromUserName / Content 缺一个微信都不会显示'
            );
          }
        }
      } else if (!backEnc) {
        if (!r.body.trim()) {
          bad(
            '响应是空的 —— 函数收到了消息，但没把回包送出来',
            '最常见就两种：① 云函数「超时时间」还是默认的 3 秒，写飞书用完后被强制中断；' +
              '② 消息里没有 Encrypt 节点（平台若开了「明文模式」就会这样）'
          );
        } else if (r.status >= 500) {
          bad(
            'HTTP ' + r.status + '，函数内部报错了',
            '去 SCF「日志查询」找堆栈。如果是 isBase64Encoded 之类的字段问题，说明返回值结构被改过'
          );
        } else {
          bad('响应里没有 Encrypt 节点', '返回内容见上方，去函数日志看原因');
        }
      } else {
        // 回包结构自检：签名自洽 + 解密后的 XML 字段齐全
        const backSig = wxcrypt.xmlPick(r.body, 'MsgSignature');
        const backTs = wxcrypt.xmlPick(r.body, 'TimeStamp');
        const backNonce = wxcrypt.xmlPick(r.body, 'Nonce');
        const expectSig = wxcrypt.signature(token, backTs, backNonce, backEnc);
        if (backSig === expectSig) {
          ok('回包签名自洽（' + ch.label + '会用同样的算法复核）');
        } else {
          bad('回包签名对不上', ch.label + '会直接丢弃这条回复。检查云函数里的 Token 是否和后台一致');
        }

        const ct = (r.contentType || '').toLowerCase();
        if (/xml/.test(ct)) {
          ok('Content-Type 是 ' + ct + '，' + ch.label + '认得');
        } else if (!ct) {
          warn('响应里没有 Content-Type 头，通常也能收，但先记一笔');
        } else {
          bad(
            'Content-Type 是 ' + ct + '，不是 xml',
            ch.label + '可能因此不解析回包 → 表现就是「飞书有记录、没回信」'
          );
        }

        let backPlain;
        try {
          backPlain = wxcrypt.decryptWith(aesKey, backEnc, corpId);
        } catch (e) {
          backPlain = '';
          bad('回包解密失败：' + e.message);
        }
        if (backPlain) {
          const content = wxcrypt.xmlPick(backPlain, 'Content');
          const toUser = wxcrypt.xmlPick(backPlain, 'ToUserName');
          const fromUser = wxcrypt.xmlPick(backPlain, 'FromUserName');
          console.log('');
          console.log('    ' + bold(ch.label + '实际会收到：'));
          String(content || '(空)')
            .split('\n')
            .forEach((l) => console.log('      ' + green(l)));
          console.log('');
          line('ToUserName（收件人）', toUser || dim('(空)'));
          line('FromUserName（发件人）', fromUser || dim('(空)'));

          const structureOk = Boolean(content && toUser && fromUser);
          if (structureOk) {
            ok('回包结构完整，收/发件人对调正确');
          } else {
            bad('回包缺少必要字段', 'ToUserName / FromUserName / Content 缺一个' + ch.label + '都不会显示');
          }
          endToEndOk = structureOk && backSig === expectSig;
        }
      }
    } catch (e) {
      bad('请求失败：' + (e.name === 'TimeoutError' ? '超时 ' + TIMEOUT_MS / 1000 + ' 秒' : e.message));
    }
  }

  // ---------- 结论 ----------
  console.log('');
  console.log(bold('━'.repeat(52)));
  if (endToEndOk) {
    console.log(green(bold('  云函数侧完全正常：收消息 → 记账 → 回包，全对。')));
    console.log('');
    console.log('  如果微信里仍然没回信，按这个顺序查：');
    console.log('');
    console.log('  ' + bold('1. 云函数「超时时间」是不是还是默认 3 秒'));
    console.log('     函数配置 → 编辑 → 超时时间改成 10 秒。');
    console.log('     3 秒的坑最阴：飞书写完就被掐断，飞书有记录、微信没回信。');
    console.log('');
    console.log('  ' + bold('2. 手机端是不是进错了地方'));
    console.log('     要从「工作台 → 你的应用」对话框发，搜索框里发是收不到的');
    console.log('');
    console.log('  ' + bold('3. 应用可见范围'));
    console.log('     应用详情 → 可见范围 → 确认自己（或所在部门）在里面');
  } else if (authOk) {
    console.log(yellow(bold('  凭证和入口都对，但回包这一步没走通。')));
    console.log('');
    console.log('  修复顺序（第一项命中率最高）：');
    console.log('  ' + bold('1. 超时时间改成 10 秒') + ' —— 函数配置 → 编辑 → 超时时间');
    console.log('  ' + bold('2. 内存调到 256 MB') + ' —— 128 MB 在冷启动 + 飞书请求时可能不够');
    console.log('  ' + bold('3. 去 SCF「日志查询」看那次调用的最后一行'));
  } else if (reachable) {
    console.log(red(bold('  地址能访问，但三个凭证有对不上的。')));
    console.log('  按第 2 步的提示改，改完重新跑这个工具。');
  } else {
    console.log(red(bold('  连地址都访问不到。')));
    console.log('  先把函数 URL 打通：函数详情 → 左侧「函数 URL」→ 确认公网访问已启用、授权类型是「开放」。');
  }
  console.log(bold('━'.repeat(52)));
  console.log('');
  console.log(dim('  提示：第 3 步发的是「' + testMsg + '」，只读不写账本（除非你发了记账格式）。'));
  console.log(dim('  发真实记账语句可以用：--msg "0.01 测试"'));
  console.log('');
}

main().catch((e) => {
  console.error(red('探测脚本异常：' + (e.stack || e.message)));
  process.exit(1);
});

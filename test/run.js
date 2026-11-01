'use strict';

/**
 * 自测：不联网、不依赖任何账号
 * 跑法： node test/run.js
 */

const assert = require('node:assert');
const wxcrypt = require('../src/wxcrypt');
const { parse } = require('../src/parse');
const { handleText } = require('../src/ledger');
const { createMemoryStore } = require('../src/store/local');
const { createHandler } = require('../src/handler');
const t = require('../src/time');

let pass = 0;
let fail = 0;

function group(name) {
  console.log('\n── ' + name + ' ' + '─'.repeat(Math.max(0, 56 - name.length)));
}
function eq(actual, expected, name) {
  try {
    assert.deepStrictEqual(actual, expected);
    pass++;
    console.log('  ✅ ' + name);
  } catch (e) {
    fail++;
    console.log('  ❌ ' + name);
    console.log('     期望: ' + JSON.stringify(expected));
    console.log('     实际: ' + JSON.stringify(actual));
  }
}
function has(hay, needle, name) {
  const ok = String(hay).includes(needle);
  if (ok) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name);
    console.log('     期望包含: ' + JSON.stringify(needle));
    console.log('     实际输出:\n' + String(hay).split('\n').map((l) => '       | ' + l).join('\n'));
  }
}
function notHas(hay, needle, name) {
  const ok = !String(hay).includes(needle);
  if (ok) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    console.log('  ❌ ' + name + '（不该包含 ' + JSON.stringify(needle) + '）');
  }
}

// ============ 测试配置 ============
const AES_KEY = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'; // 43 位
const TEST_CFG = {
  wecom: {
    corpId: 'wwtest0000000001',
    token: 'testtoken123',
    aesKey: AES_KEY,
    strictReceiveId: true,
  },
  feishu: {
    appId: '', appSecret: '', appToken: '', tableId: '',
    fields: { amount: '金额', type: '类型', note: '备注', category: '分类', date: '日期' },
    typeValues: { expense: '支出', income: '收入' },
  },
  app: {
    tzOffset: 8,
    showTodayTotal: true,
    feishuTimeoutMs: 3000,
    store: 'memory',
    jsonFile: '',
  },
};

const silent = { log() {}, warn() {}, error() {} };
// 2026-11-01 10:00:00 +08:00
const NOW = Date.UTC(2026, 10, 1, 2, 0, 0);

async function main() {
  // ---------- 1. 加解密 ----------
  group('1. 企业微信加解密');
  {
    const aesKey = wxcrypt.getAesKey(AES_KEY);
    eq(aesKey.length, 32, 'AESKey 解码为 32 字节');

    const origin = '<xml><Content><![CDATA[25 午饭]]></Content></xml>';
    const enc = wxcrypt.encryptWith(AES_KEY, origin, TEST_CFG.wecom.corpId);
    eq(typeof enc, 'string', '加密产出 base64 字符串');
    eq(wxcrypt.decryptWith(AES_KEY, enc, TEST_CFG.wecom.corpId), origin, '加密→解密 还原一致');

    let threw = false;
    try {
      wxcrypt.decryptWith(AES_KEY, enc, 'wwother999');
    } catch (e) {
      threw = true;
    }
    eq(threw, true, 'receiveId 不匹配时报错');

    const sig = wxcrypt.signature('tok', '123', 'nonce', 'abc');
    eq(sig.length, 40, '签名为 40 位 sha1');
    eq(
      wxcrypt.verifySignature({ token: 'tok', msgSignature: sig, timestamp: '123', nonce: 'nonce', encrypt: 'abc' }),
      true,
      '签名自校验通过'
    );
    eq(
      wxcrypt.verifySignature({ token: 'tok', msgSignature: sig, timestamp: '999', nonce: 'nonce', encrypt: 'abc' }),
      false,
      '参数被改后签名校验失败'
    );

    // 中文 / emoji / 超长内容
    const tricky = '<xml>' + wxcrypt.cdata('午饭🍜 25元 ]]>\n第二行') + '</xml>';
    const enc2 = wxcrypt.encryptWith(AES_KEY, tricky, TEST_CFG.wecom.corpId);
    eq(wxcrypt.decryptWith(AES_KEY, enc2, TEST_CFG.wecom.corpId), tricky, '含 emoji/CDATA 转义/换行 也能还原');
  }

  // ---------- 2. 语句解析 ----------
  group('2. 记账语句解析');
  {
    const cases = [
      ['25 午饭', { kind: 'record', type: 'expense', amount: 25, note: '午饭', category: '餐饮' }],
      ['午饭 25', { kind: 'record', type: 'expense', amount: 25, note: '午饭', category: '餐饮' }],
      ['-25 午饭', { kind: 'record', type: 'expense', amount: 25, note: '午饭', category: '餐饮' }],
      ['+3000 工资', { kind: 'record', type: 'income', amount: 3000, note: '工资' }],
      ['25.5 奶茶', { kind: 'record', type: 'expense', amount: 25.5, note: '奶茶', category: '餐饮' }],
      ['12.80 地铁', { kind: 'record', type: 'expense', amount: 12.8, note: '地铁', category: '交通' }],
      ['25', { kind: 'record', type: 'expense', amount: 25, note: '支出', category: '其他' }],
      ['发红包 200', { kind: 'record', type: 'expense', amount: 200, note: '发红包' }],
      ['收红包 200', { kind: 'record', type: 'income', amount: 200, note: '收红包' }],
      ['地铁 3 #交通', { kind: 'record', type: 'expense', amount: 3, note: '地铁', category: '交通' }],
    ];
    for (const [input, expected] of cases) {
      const got = parse(input);
      const actual = {};
      for (const k of Object.keys(expected)) actual[k] = got[k];
      eq(actual, expected, input);
    }

    // 量词不能当金额
    eq(parse('奶茶 18 2杯').amount, 18, '「18 2杯」取 18 不取 2');
    eq(parse('买了2杯奶茶 18').amount, 18, '「买了2杯奶茶 18」取 18');
    eq(parse('买了2杯奶茶 18').note, '买了 奶茶', '量词残留被清掉');

    // 指令
    eq(parse('本月').kind, 'query', '「本月」识别为查询');
    eq(parse('本月').scope, 'month', '「本月」范围=month');
    eq(parse('今天').scope, 'today', '「今天」范围=today');
    eq(parse('昨天').scope, 'yesterday', '「昨天」范围=yesterday');
    eq(parse('明细').scope, 'recent', '「明细」范围=recent');
    eq(parse('帮助').kind, 'help', '「帮助」识别为帮助');
    eq(parse('?').kind, 'help', '「?」识别为帮助');
    eq(parse('删1').kind, 'delete', '「删1」识别为删除');
    eq(parse('删1').offset, 1, '「删1」偏移=1');
    eq(parse('撤销').offset, 1, '「撤销」默认删最近一条');
    eq(parse('今天天气不错').kind, 'unknown', '无关文本不误判');
    eq(parse('').kind, 'unknown', '空文本不报错');
    // 全角
    eq(parse('２５　午饭').amount, 25, '全角数字与全角空格也能识别');
  }

  // ---------- 3. 记账业务 ----------
  group('3. 记账业务逻辑');
  {
    const store = createMemoryStore();
    const ctx = { store, cfg: TEST_CFG, now: NOW };

    const r1 = await handleText('25 午饭', ctx);
    has(r1, '支出 ¥25.00', '首笔回执金额正确');
    has(r1, '午饭', '回执带备注');
    has(r1, '餐饮', '回执带分类');
    has(r1, '今日 ¥25.00', '回执带今日合计');
    has(r1, '本月 ¥25.00', '回执带本月合计');

    const r2 = await handleText('18 奶茶', ctx);
    has(r2, '今日 ¥43.00', '第二笔今日合计累加');

    const r3 = await handleText('+3000 工资', ctx);
    has(r3, '收入 +¥3,000.00', '收入回执带 + 号与千分位');
    has(r3, '本月收入 ¥3,000.00', '收入回执显示本月收入');

    const rm = await handleText('本月', ctx);
    has(rm, '共 3 笔', '月度汇总笔数正确');
    has(rm, '支出 ¥43.00', '月度支出正确');
    has(rm, '收入 ¥3,000.00', '月度收入正确');
    has(rm, '结余 +¥2,957.00', '结余正确');
    has(rm, '餐饮 ¥43.00', '分类统计正确');

    const rd = await handleText('今天', ctx);
    has(rd, '3 笔', '今日明细笔数');
    has(rd, '支出 ¥43.00', '今日明细合计');

    const rl = await handleText('明细', ctx);
    has(rl, '最近 3 笔', '明细列表条数');

    const del = await handleText('删1', ctx);
    has(del, '已删除', '删除回执');
    has(del, '+¥3,000.00', '删掉的是最近一条（收入那条）');

    const after = await handleText('明细', ctx);
    has(after, '最近 2 笔', '删除后剩 2 条');
    notHas(after, '工资', '被删的记录不再出现');

    const help = await handleText('帮助', ctx);
    has(help, '记账用法', '帮助文案');

    const unknown = await handleText('今天天气不错', ctx);
    has(unknown, '没看懂', '无法识别时给出提示');

    // 空库时的查询
    const emptyStore = createMemoryStore();
    const emptyCtx = { store: emptyStore, cfg: TEST_CFG, now: NOW };
    has(await handleText('本月', emptyCtx), '还没有记录', '空库查本月有友好提示');
    has(await handleText('删1', emptyCtx), '还没有记录可以删', '空库删除有友好提示');
  }

  // ---------- 4. 存储失败要如实报错 ----------
  group('4. 异常处理');
  {
    const brokenStore = {
      name: 'broken',
      async add() {
        throw new Error('飞书接口超时（3500ms）');
      },
      async list() {
        return [];
      },
      async remove() {
        return false;
      },
    };
    const r = await handleText('25 午饭', { store: brokenStore, cfg: TEST_CFG, now: NOW });
    has(r, '⚠️ 记账失败', '写库失败时不谎报成功');
    has(r, '超时', '错误信息透传给用户');
  }

  // ---------- 5. 企业微信回调全链路 ----------
  group('5. 企业微信回调全链路');
  {
    const store = createMemoryStore();
    const handler = createHandler({ config: TEST_CFG, store, logger: silent });
    const { token, corpId } = TEST_CFG.wecom;

    // --- GET 验证 ---
    const echostr = wxcrypt.encryptWith(AES_KEY, 'echo-hello-123', corpId);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'n12345';
    const sig = wxcrypt.signature(token, ts, nonce, echostr);
    const vRes = await handler({
      method: 'GET',
      query: { msg_signature: sig, timestamp: ts, nonce, echostr },
      body: '',
    });
    eq(vRes.statusCode, 200, 'GET 验证返回 200');
    eq(vRes.body, 'echo-hello-123', 'GET 验证返回解密后的 echostr');

    // --- GET 签名错误 ---
    const badRes = await handler({
      method: 'GET',
      query: { msg_signature: 'deadbeef', timestamp: ts, nonce, echostr },
      body: '',
    });
    eq(badRes.statusCode, 401, '签名错误返回 401');

    // --- POST 一条记账消息 ---
    let msgSeq = 0;
    async function postText(text) {
      const p = String(Math.floor(Date.now() / 1000));
      const n = Math.random().toString(36).slice(2, 10);
      const plain =
        '<xml>' +
        '<ToUserName>' + wxcrypt.cdata(corpId) + '</ToUserName>' +
        '<FromUserName>' + wxcrypt.cdata('zhangsan') + '</FromUserName>' +
        '<CreateTime>' + p + '</CreateTime>' +
        '<MsgType>' + wxcrypt.cdata('text') + '</MsgType>' +
        '<Content>' + wxcrypt.cdata(text) + '</Content>' +
        '<MsgId>' + (1000000000 + (msgSeq++)) + '</MsgId>' +
        '<AgentID>1000002</AgentID>' +
        '</xml>';
      const enc = wxcrypt.encryptWith(AES_KEY, plain, corpId);
      const s = wxcrypt.signature(token, p, n, enc);
      const body =
        '<xml><ToUserName>' + wxcrypt.cdata(corpId) + '</ToUserName>' +
        '<AgentID>1000002</AgentID>' +
        '<Encrypt>' + wxcrypt.cdata(enc) + '</Encrypt></xml>';

      const res = await handler({ method: 'POST', query: { msg_signature: s, timestamp: p, nonce: n }, body });

      const respEnc = wxcrypt.xmlPick(res.body, 'Encrypt');
      const respSig = wxcrypt.xmlPick(res.body, 'MsgSignature');
      const respTs = wxcrypt.xmlPick(res.body, 'TimeStamp');
      const respNonce = wxcrypt.xmlPick(res.body, 'Nonce');
      const sigOk = wxcrypt.verifySignature({
        token, msgSignature: respSig, timestamp: respTs, nonce: respNonce, encrypt: respEnc,
      });
      const plainReply = wxcrypt.decryptWith(AES_KEY, respEnc, corpId);
      return {
        statusCode: res.statusCode,
        sigOk,
        toUser: wxcrypt.xmlPick(plainReply, 'ToUserName'),
        fromUser: wxcrypt.xmlPick(plainReply, 'FromUserName'),
        msgType: wxcrypt.xmlPick(plainReply, 'MsgType'),
        content: wxcrypt.xmlPick(plainReply, 'Content'),
      };
    }

    const r = await postText('25 午饭');
    eq(r.statusCode, 200, 'POST 返回 200');
    eq(r.sigOk, true, '回复包签名可被校验通过');
    eq(r.toUser, 'zhangsan', '回复的 ToUserName = 发送者');
    eq(r.fromUser, corpId, '回复的 FromUserName = 企业 ID');
    eq(r.msgType, 'text', '回复类型为 text');
    has(r.content, '支出 ¥25.00', '回复内容包含记账结果');

    // --- POST 非文本消息 ---
    const pf = String(Math.floor(Date.now() / 1000));
    const nf = 'nnn';
    const plainImg =
      '<xml><ToUserName>' + wxcrypt.cdata(corpId) + '</ToUserName>' +
      '<FromUserName>' + wxcrypt.cdata('zhangsan') + '</FromUserName>' +
      '<CreateTime>' + pf + '</CreateTime><MsgType>' + wxcrypt.cdata('image') + '</MsgType>' +
      '<PicUrl><![CDATA[http://x/y.jpg]]></PicUrl><MsgId>2</MsgId><AgentID>1000002</AgentID></xml>';
    const encImg = wxcrypt.encryptWith(AES_KEY, plainImg, corpId);
    const sigImg = wxcrypt.signature(token, pf, nf, encImg);
    const bodyImg = '<xml><Encrypt>' + wxcrypt.cdata(encImg) + '</Encrypt></xml>';
    const imgRes = await handler({ method: 'POST', query: { msg_signature: sigImg, timestamp: pf, nonce: nf }, body: bodyImg });
    const imgPlain = wxcrypt.decryptWith(AES_KEY, wxcrypt.xmlPick(imgRes.body, 'Encrypt'), corpId);
    has(wxcrypt.xmlPick(imgPlain, 'Content'), '暂时只认文字', '非文本消息给出提示');

    // --- POST 签名错误 ---
    const badPost = await handler({
      method: 'POST',
      query: { msg_signature: 'bad', timestamp: pf, nonce: nf },
      body: bodyImg,
    });
    eq(badPost.statusCode, 401, 'POST 签名错误返回 401');
  }

  // ---------- 6. 时间与金额格式 ----------
  group('6. 时间与金额');
  {
    eq(t.formatMoney(1234.5), '1,234.50', '金额千分位');
    eq(t.formatMoney(0), '0.00', '零金额');
    eq(t.formatMoney(3000), '3,000.00', '整数金额补两位');
    const dayStart = t.startOfDay(NOW, 8);
    eq(t.formatDateTime(dayStart, 8), '2026-11-01 00:00', '当天起点按 +8 时区');
    const monthStart = t.startOfMonth(NOW, 8);
    eq(t.formatDateTime(monthStart, 8), '2026-11-01 00:00', '月初起点正确');
    const nextMonth = t.startOfNextMonth(NOW, 8);
    eq(t.formatDateTime(nextMonth, 8), '2026-12-01 00:00', '下月初正确');
  }

  // ---------- 7. 飞书接口契约（不断言真实网络，只断言我们发的请求对不对） ----------
  group('7. 飞书接口调用契约');
  {
    const realFetch = global.fetch;
    const calls = [];
    const queue = [];
    global.fetch = async (url, init) => {
      calls.push({ url, init });
      const payload = queue.shift() || { code: 0, data: {} };
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    };

    try {
      const { createFeishuStore } = require('../src/store/feishu');
      const cfg = {
        ...TEST_CFG,
        feishu: {
          ...TEST_CFG.feishu,
          appId: 'cli_test', appSecret: 'sec_test', appToken: 'appTOKEN', tableId: 'tblTOKEN',
        },
      };
      const store = createFeishuStore(cfg);

      // --- 新增记录 ---
      queue.push({ code: 0, tenant_access_token: 't-fake', expire: 7200 });
      queue.push({ code: 0, data: { record: { record_id: 'rec_1' } } });
      const added = await store.add({
        amount: 25, type: 'expense', note: '午饭', category: '餐饮', date: 1762000000000,
      });
      eq(added.id, 'rec_1', '新增记录返回 record_id');
      eq(
        calls[0].url,
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        '先取 tenant_access_token'
      );
      eq(JSON.parse(calls[0].init.body).app_id, 'cli_test', 'token 请求体带 app_id');
      eq(
        calls[1].url,
        'https://open.feishu.cn/open-apis/bitable/v1/apps/appTOKEN/tables/tblTOKEN/records',
        '新增记录 URL 正确'
      );
      eq(calls[1].init.headers.Authorization, 'Bearer t-fake', '新增记录带 Bearer token');
      const addFields = JSON.parse(calls[1].init.body).fields;
      eq(addFields['金额'], 25, '字段映射：金额');
      eq(addFields['类型'], '支出', '字段映射：类型');
      eq(addFields['备注'], '午饭', '字段映射：备注');
      eq(addFields['分类'], '餐饮', '字段映射：分类');
      eq(addFields['日期'], 1762000000000, '字段映射：日期写成毫秒时间戳');

      // --- 按时间范围查询（token 已缓存，不应再请求） ---
      calls.length = 0;
      queue.push({
        code: 0,
        data: {
          items: [
            {
              record_id: 'rec_2',
              fields: {
                '金额': 18,
                '类型': ['支出'],
                '备注': '奶茶',
                '分类': '餐饮',
                '日期': 1762000100000,
              },
            },
          ],
          has_more: false,
        },
      });
      const rows = await store.list({ from: 1762000000000, to: 1762086400000 });
      eq(calls.length, 1, 'token 已缓存，查询不再重复获取');
      eq(
        calls[0].url,
        'https://open.feishu.cn/open-apis/bitable/v1/apps/appTOKEN/tables/tblTOKEN/records/search',
        '查询走 records/search'
      );
      const searchBody = JSON.parse(calls[0].init.body);
      eq(searchBody.filter.conditions[0].operator, 'isGreater', '日期下界用 isGreater（飞书不支持 isGreaterEqual）');
      eq(searchBody.filter.conditions[0].value, ['ExactDate', '1761999999999'], '下界值 = from - 1 毫秒');
      eq(searchBody.filter.conditions[1].operator, 'isLess', '日期上界用 isLess');
      eq(searchBody.filter.conditions[1].value, ['ExactDate', '1762086400000'], '上界值 = to 毫秒');
      eq(rows.length, 1, '解析出 1 条记录');
      eq(rows[0].amount, 18, '解析金额');
      eq(rows[0].type, 'expense', '类型字段返回数组时也能解析');
      eq(rows[0].category, '餐饮', '解析分类');

      // --- latest=true 要带倒序 sort ---
      calls.length = 0;
      queue.push({ code: 0, data: { items: [], has_more: false } });
      await store.list({ limit: 10, latest: true });
      const latestBody = JSON.parse(calls[0].init.body);
      eq(
        JSON.stringify(latestBody.sort),
        JSON.stringify([{ field_name: '日期', desc: true }]),
        'latest=true 时按日期倒序，取到的是最新而不是最早的'
      );

      // --- 删除 ---
      calls.length = 0;
      queue.push({ code: 0, data: {} });
      await store.remove('rec_1');
      eq(
        calls[0].url,
        'https://open.feishu.cn/open-apis/bitable/v1/apps/appTOKEN/tables/tblTOKEN/records/rec_1',
        '删除记录 URL 正确'
      );
      eq(calls[0].init.method, 'DELETE', '删除用 DELETE');

      // --- 飞书报错要抛出来，不能被吞 ---
      queue.push({ code: 1254005, msg: 'FieldNameNotFound' });
      let caught = '';
      try {
        await store.add({ amount: 1, type: 'expense', note: 'x', category: '', date: 1 });
      } catch (e) {
        caught = e.message;
      }
      has(caught, 'FieldNameNotFound', '飞书报错信息完整抛出（便于定位字段名配错）');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ---------- 8. 云函数入口 + 各平台事件格式 ----------
  group('8. 云函数入口（腾讯云 / 阿里云事件格式）');
  {
    Object.assign(process.env, {
      WECOM_CORP_ID: TEST_CFG.wecom.corpId,
      WECOM_TOKEN: TEST_CFG.wecom.token,
      WECOM_AES_KEY: TEST_CFG.wecom.aesKey,
      WECOM_STRICT_RECEIVEID: '1',
      APP_STORE: 'memory',
      APP_TZ_OFFSET: '8',
    });
    const { main } = require('../index.js');
    const { normalizeEvent } = require('../src/normalize');

    const enc = wxcrypt.encryptWith(AES_KEY, 'event-echo', TEST_CFG.wecom.corpId);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = 'nonce8';
    const sig = wxcrypt.signature(TEST_CFG.wecom.token, ts, nonce, enc);
    const queryObj = { msg_signature: sig, timestamp: ts, nonce, echostr: enc };

    // 腾讯云 API 网关 / 函数URL
    const scfEvent = {
      path: '/',
      httpMethod: 'GET',
      headers: { 'content-type': 'text/plain' },
      queryStringParameters: queryObj,
      queryString: queryObj,
      body: '',
      isBase64Encoded: false,
      requestContext: { httpMethod: 'GET', requestId: 'req-1' },
    };
    const scfRes = await main(scfEvent, {});
    eq(scfRes.statusCode, 200, '腾讯云事件：返回 200');
    eq(scfRes.body, 'event-echo', '腾讯云事件：URL 验证通过');
    eq(scfRes.isBase64Encoded, false, '腾讯云事件：返回值带 isBase64Encoded');

    // 腾讯云【函数 URL】—— 2025-06-30 API 网关下线后的唯一 HTTP 入口。
    // 官方原文：兼容 apigw 协议，但【去掉 headerParameters、isBase64Encoded、
    // pathParameters、queryStringParameters、requestContext 相关字段】。
    // 也就是说只有 body / headers / httpMethod / path / queryString，且 queryString 是对象。
    const urlEvent = {
      body: '',
      headers: { 'x-scf-remote-addr': '111.206.96.145' },
      httpMethod: 'GET',
      path: '/',
      queryString: queryObj,
    };
    const urlRes = await main(urlEvent, {});
    eq(urlRes.statusCode, 200, '函数URL：返回 200');
    eq(urlRes.body, 'event-echo', '函数URL：URL 验证通过');
    eq(
      urlRes.headers['Content-Type'],
      'text/plain',
      '函数URL：Content-Type 透传'
    );

    const urlPostRes = await main(
      { ...urlEvent, httpMethod: 'POST', body: '<xml>no-encrypt</xml>' },
      {}
    );
    eq(urlPostRes.statusCode, 200, '函数URL：POST 无 Encrypt 时返回 200');
    eq(urlPostRes.body, '', '函数URL：POST 空回包');

    // 阿里云 FC 3.0 HTTP 触发器
    const fcEvent = {
      version: 'v1',
      rawPath: '/',
      headers: {},
      queryParameters: queryObj,
      body: '',
      isBase64Encoded: false,
      requestContext: {
        accountId: '123',
        domainName: 'x.cn-hangzhou.fcapp.run',
        http: { method: 'GET', path: '/', protocol: 'HTTP/1.1' },
      },
    };
    const fcRes = await main(fcEvent, {});
    eq(fcRes.statusCode, 200, '阿里云事件：返回 200');
    eq(fcRes.body, 'event-echo', '阿里云事件：URL 验证通过');

    // 事件归一化边界
    eq(
      normalizeEvent({ requestContext: { http: { method: 'post' } } }).method,
      'POST',
      '方法名统一大写'
    );
    eq(
      normalizeEvent({ queryString: 'a=1&b=2' }).query.b,
      '2',
      'queryString 为字符串也能解析'
    );
    eq(
      normalizeEvent({
        body: Buffer.from('<xml>hi</xml>').toString('base64'),
        isBase64Encoded: true,
      }).body,
      '<xml>hi</xml>',
      'Base64 请求体能自动解码'
    );
  }

  // ---------- 9. 公众号通道 ----------
  group('9. 公众号 / 微信测试号');
  {
    // 故意用和企业微信不同的 AESKey，验证"靠签名分流"而不是靠配置顺序
    const WX_KEY = Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
    const WX_APPID = 'wx1234567890abcdef';
    const WX_TOKEN = 'wxtoken456';
    const ts = '1730000000';
    const nonce = 'n0nce123';

    const wxCfg = {
      ...TEST_CFG,
      wechat: { appId: WX_APPID, token: WX_TOKEN, aesKey: WX_KEY, mode: 'auto' },
    };

    const msgXml =
      '<xml><ToUserName><![CDATA[gh_abc123]]></ToUserName>' +
      '<FromUserName><![CDATA[oUser123]]></FromUserName>' +
      '<CreateTime>1730000000</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[25 午饭]]></Content>' +
      '<MsgId>123456789</MsgId></xml>';

    function wrap(enc) {
      return '<xml><ToUserName><![CDATA[gh_abc123]]></ToUserName>' +
        '<Encrypt><![CDATA[' + enc + ']]></Encrypt><AgentID>1</AgentID></xml>';
    }

    const h = createHandler({ config: wxCfg, store: createMemoryStore(), logger: silent });

    // --- 安全模式：URL 验证
    const echoPlain = 'echo-verify-8899';
    const echoEnc = wxcrypt.encryptWith(WX_KEY, echoPlain, WX_APPID);
    const r1 = await h({
      method: 'GET',
      query: {
        msg_signature: wxcrypt.signature(WX_TOKEN, ts, nonce, echoEnc),
        timestamp: ts,
        nonce,
        echostr: echoEnc,
      },
    });
    eq(r1.statusCode, 200, '公众号安全模式：URL 验证返回 200');
    eq(r1.body, echoPlain, '公众号安全模式：echostr 解密后原样返回');

    // --- 明文模式：URL 验证（只有 signature，没有 msg_signature）
    const r2 = await h({
      method: 'GET',
      query: {
        signature: wxcrypt.signature(WX_TOKEN, ts, nonce),
        timestamp: ts,
        nonce,
        echostr: 'plain-echo-123',
      },
    });
    eq(r2.statusCode, 200, '公众号明文模式：URL 验证返回 200');
    eq(r2.body, 'plain-echo-123', '公众号明文模式：echostr 原样返回');

    // --- 安全模式：发一条记账消息，收到加密回包
    const enc = wxcrypt.encryptWith(WX_KEY, msgXml, WX_APPID);
    const r3 = await h({
      method: 'POST',
      query: { msg_signature: wxcrypt.signature(WX_TOKEN, ts, nonce, enc), timestamp: ts, nonce },
      body: wrap(enc),
    });
    eq(r3.statusCode, 200, '公众号安全模式：消息返回 200');
    const backEnc = wxcrypt.xmlPick(r3.body, 'Encrypt');
    const backPlain = wxcrypt.decryptWith(WX_KEY, backEnc, WX_APPID);
    has(backPlain, '支出', '公众号安全模式：回执里有记账结果');
    has(backPlain, '午饭', '公众号安全模式：回执带备注');
    eq(
      wxcrypt.xmlPick(backPlain, 'ToUserName'),
      'oUser123',
      '公众号：回复的 ToUserName 是用户自己'
    );
    eq(
      wxcrypt.xmlPick(backPlain, 'FromUserName'),
      'gh_abc123',
      '公众号：回复的 FromUserName 是公众号'
    );

    // --- 明文模式：发消息，收到明文回包
    const r4 = await h({
      method: 'POST',
      query: { signature: wxcrypt.signature(WX_TOKEN, ts, nonce), timestamp: ts, nonce },
      body: msgXml,
    });
    eq(r4.statusCode, 200, '公众号明文模式：消息返回 200');
    has(r4.body, '<Content>', '公众号明文模式：返回明文 XML');
    notHas(r4.body, 'Encrypt', '公众号明文模式：回包不加密');

    // --- receiveid 不匹配要拦住
    const badEnc = wxcrypt.encryptWith(WX_KEY, msgXml, 'wwwrongcorpid');
    const r5 = await h({
      method: 'POST',
      query: {
        msg_signature: wxcrypt.signature(WX_TOKEN, ts, nonce, badEnc),
        timestamp: ts,
        nonce,
      },
      body: wrap(badEnc),
    });
    eq(r5.statusCode, 401, '公众号：receiveid 不匹配时拒绝');
    has(r5.body, 'receiveid', '公众号：报错指明是 receiveid 问题');

    // --- Token 写错也要拦住
    const r6 = await h({
      method: 'POST',
      query: {
        msg_signature: wxcrypt.signature('wrongtoken', ts, nonce, enc),
        timestamp: ts,
        nonce,
      },
      body: wrap(enc),
    });
    eq(r6.statusCode, 401, '公众号：Token 错时拒绝');
    has(r6.body, '签名校验失败', '公众号：报错指明是 Token 问题');

    // --- 关注事件回欢迎语
    const evXml =
      '<xml><ToUserName><![CDATA[gh_abc123]]></ToUserName>' +
      '<FromUserName><![CDATA[oUser123]]></FromUserName>' +
      '<CreateTime>1730000000</CreateTime>' +
      '<MsgType><![CDATA[event]]></MsgType>' +
      '<Event><![CDATA[subscribe]]></Event></xml>';
    const evEnc = wxcrypt.encryptWith(WX_KEY, evXml, WX_APPID);
    const r7 = await h({
      method: 'POST',
      query: { msg_signature: wxcrypt.signature(WX_TOKEN, ts, nonce, evEnc), timestamp: ts, nonce },
      body: wrap(evEnc),
    });
    const evBack = wxcrypt.decryptWith(WX_KEY, wxcrypt.xmlPick(r7.body, 'Encrypt'), WX_APPID);
    has(evBack, '记账', '公众号：关注时回欢迎语');
    has(evBack, '25 午饭', '公众号：欢迎语里带格式示例');
  }

  // ---------- 10. 双通道共存 ----------
  group('10. 企业微信 + 公众号 共存');
  {
    const WX_KEY = Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '');
    const WX_APPID = 'wx1234567890abcdef';
    const WX_TOKEN = 'wxtoken456';
    const ts = '1730000000';
    const nonce = 'n0nce123';

    const dualCfg = {
      ...TEST_CFG,
      wechat: { appId: WX_APPID, token: WX_TOKEN, aesKey: WX_KEY, mode: 'auto' },
    };
    const h = createHandler({ config: dualCfg, store: createMemoryStore(), logger: silent });

    const mk = (content, toUser) =>
      '<xml><ToUserName><![CDATA[' + toUser + ']]></ToUserName>' +
      '<FromUserName><![CDATA[oUser123]]></FromUserName>' +
      '<CreateTime>1730000000</CreateTime>' +
      '<MsgType><![CDATA[text]]></MsgType>' +
      '<Content><![CDATA[' + content + ']]></Content>' +
      '<MsgId>1</MsgId></xml>';
    const wrap = (enc) => '<xml><Encrypt><![CDATA[' + enc + ']]></Encrypt></xml>';

    // 企业微信那条：用 corpId 加密、corpId 签名
    const wEnc = wxcrypt.encryptWith(AES_KEY, mk('18 奶茶', 'wwtest0000000001'), 'wwtest0000000001');
    const rW = await h({
      method: 'POST',
      query: {
        msg_signature: wxcrypt.signature('testtoken123', ts, nonce, wEnc),
        timestamp: ts,
        nonce,
      },
      body: wrap(wEnc),
    });
    eq(rW.statusCode, 200, '共存：企业微信请求被正确处理');
    has(
      wxcrypt.decryptWith(AES_KEY, wxcrypt.xmlPick(rW.body, 'Encrypt'), 'wwtest0000000001'),
      '奶茶',
      '共存：企业微信回执用企业微信的 key 加密'
    );

    // 公众号那条：用 AppID 加密、公众号 token 签名
    const mEnc = wxcrypt.encryptWith(WX_KEY, mk('30 打车', 'gh_abc123'), WX_APPID);
    const rM = await h({
      method: 'POST',
      query: {
        msg_signature: wxcrypt.signature(WX_TOKEN, ts, nonce, mEnc),
        timestamp: ts,
        nonce,
      },
      body: wrap(mEnc),
    });
    eq(rM.statusCode, 200, '共存：公众号请求被正确处理');
    has(
      wxcrypt.decryptWith(WX_KEY, wxcrypt.xmlPick(rM.body, 'Encrypt'), WX_APPID),
      '打车',
      '共存：公众号回执用公众号的 key 加密'
    );
  }

  // ---------- 11. 慢存储与重复投递 ----------
  group('11. 超时防护与重复投递');
  {
    // 统计查询挂住时，记账回执不能跟着挂
    const hangStore = {
      name: 'hang',
      async add() {
        return { id: 'h1' };
      },
      list() {
        return new Promise(() => {}); // 永远不返回
      },
      async remove() {
        return true;
      },
    };
    const t0 = Date.now();
    const slow = await handleText('25 午饭', {
      store: hangStore,
      cfg: TEST_CFG,
      now: NOW,
      deadline: Date.now() + 4500,
      logger: silent,
    });
    const slowMs = Date.now() - t0;
    has(slow, '支出 ¥25.00', '统计卡住时回执照常返回');
    notHas(slow, '今日 ¥', '统计拿不到就不显示合计行');
    eq(slowMs < 1700, true, '回执没被统计拖住（' + slowMs + 'ms）');

    // 剩余预算不足 → 直接跳过合计
    const t1 = Date.now();
    const tight = await handleText('18 奶茶', {
      store: createMemoryStore(),
      cfg: TEST_CFG,
      now: NOW,
      deadline: Date.now() + 200,
      logger: silent,
    });
    has(tight, '支出 ¥18.00', '预算紧张时照样记账');
    notHas(tight, '今日 ¥', '预算紧张时跳过今日合计');
    eq(Date.now() - t1 < 300, true, '跳过合计后回执很快');

    // 诊断命令
    const diag = await handleText('诊断', {
      store: createMemoryStore(),
      cfg: TEST_CFG,
      now: NOW,
      deadline: Date.now() + 4500,
      logger: silent,
      channel: '企业微信',
    });
    has(diag, '🩺 诊断', '诊断命令有回执');
    has(diag, '读一条记录', '诊断报告存储耗时');
    has(diag, '企业微信', '诊断报告通道名');

    // 同一条消息重投 → 只记一笔，回执复用
    const storeDup = createMemoryStore();
    const hDup = createHandler({ config: TEST_CFG, store: storeDup, logger: silent });
    async function postFixed(msgId) {
      const p = String(Math.floor(Date.now() / 1000));
      const n = 'dup' + Math.random().toString(36).slice(2, 8);
      const plain =
        '<xml><ToUserName>' + wxcrypt.cdata(TEST_CFG.wecom.corpId) + '</ToUserName>' +
        '<FromUserName>' + wxcrypt.cdata('lisi') + '</FromUserName>' +
        '<CreateTime>' + p + '</CreateTime>' +
        '<MsgType>' + wxcrypt.cdata('text') + '</MsgType>' +
        '<Content>' + wxcrypt.cdata('25 午饭') + '</Content>' +
        '<MsgId>' + msgId + '</MsgId>' +
        '<AgentID>1000002</AgentID></xml>';
      const enc = wxcrypt.encryptWith(AES_KEY, plain, TEST_CFG.wecom.corpId);
      const body = '<xml><Encrypt>' + wxcrypt.cdata(enc) + '</Encrypt></xml>';
      const res = await hDup({
        method: 'POST',
        query: {
          msg_signature: wxcrypt.signature(TEST_CFG.wecom.token, p, n, enc),
          timestamp: p,
          nonce: n,
        },
        body,
      });
      const txt = wxcrypt.decryptWith(
        AES_KEY,
        wxcrypt.xmlPick(res.body, 'Encrypt'),
        TEST_CFG.wecom.corpId
      );
      return wxcrypt.xmlPick(txt, 'Content');
    }
    const d1 = await postFixed(777001);
    const d2 = await postFixed(777001);
    eq(storeDup._rows.length, 1, '同一条消息重投只记一笔');
    eq(d2, d1, '重投返回同一份回执');
    const d3 = await postFixed(777002);
    eq(storeDup._rows.length, 2, '换了 MsgId 才算新消息');
    has(d3, '支出 ¥25.00', '新消息正常记账');
  }

  // ---------- 汇总 ----------
  console.log('\n' + '═'.repeat(60));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail === 0) console.log('🎉 全部通过');
  console.log('═'.repeat(60));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('测试脚本自身出错：', e);
  process.exit(2);
});

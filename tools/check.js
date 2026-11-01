'use strict';

/**
 * 上线前自检：把 7 个凭证全部实测一遍，不通过就不让你去部署
 *
 * 用法：
 *   node tools/check.js              只读检查（不写入任何数据）
 *   node tools/check.js --write      额外试写一条测试记录，验证写权限和字段类型，写完立刻删除
 *
 * 检查内容：
 *   1. 配置项格式（长度、前缀），含企业微信三件套
 *   2. 飞书 AppID / AppSecret（换取 token）
 *   3. 飞书应用是否开启「机器人能力」（不开的话表格里搜不到应用）
 *   4. 飞书表格是否可访问（app_token / table_id / 添加文档应用）
 *   5. 表里的列名、列类型是否和记账需要的一致
 *   6. "类型"单选的选项里是否有「支出」「收入」
 *   7. （--write）真实写入一条再删掉，验证写权限
 *   8. 日期字段能否被筛选查询
 */

const { config } = require('../src/config');
const wxcrypt = require('../src/wxcrypt');

const DO_WRITE = process.argv.includes('--write');
const BASE = 'https://open.feishu.cn/open-apis';

let problems = 0;
let warns = 0;

function ok(msg) {
  console.log('  ✅ ' + msg);
}
function bad(msg, hint) {
  problems++;
  console.log('  ❌ ' + msg);
  if (hint) console.log('     → ' + hint);
}
function warn(msg, hint) {
  warns++;
  console.log('  ⚠️  ' + msg);
  if (hint) console.log('     → ' + hint);
}
function info(msg) {
  console.log('     ' + msg);
}
function section(t) {
  console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 52 - t.length)));
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error('返回的不是 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200));
    }
    return { status: res.status, json };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时（15 秒），检查网络或代理设置');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 飞书字段类型编号 → 中文
const FIELD_TYPES = {
  1: '多行文本', 2: '数字', 3: '单选', 4: '多选', 5: '日期', 7: '复选框',
  11: '人员', 13: '电话号码', 15: '超链接', 17: '附件', 18: '单向关联',
  19: '查找引用', 20: '公式', 21: '双向关联', 22: '地理位置', 23: '群组',
  1001: '创建时间', 1002: '最后更新时间', 1003: '创建人', 1004: '修改人', 1005: '自动编号',
};

async function main() {
  console.log('');
  console.log('  碎银 Suiyin · 上线前自检');
  console.log('  ' + '-'.repeat(46));

  const cfg = config;
  const { wecom, feishu, app } = cfg;

  // ============ 1. 格式检查 ============
  section('1. 配置格式');

  if (!wecom.corpId) bad('WECOM_CORP_ID 是空的', '「我的企业」→「企业信息」→ 最下方企业ID');
  else if (!/^ww[0-9a-zA-Z]{10,}$/.test(wecom.corpId)) {
    warn('WECOM_CORP_ID 格式可疑：' + wecom.corpId, '正常应该是以 ww 开头的一串字符');
  } else ok('WECOM_CORP_ID 格式正常（' + wecom.corpId + '）');

  if (!wecom.token) bad('WECOM_TOKEN 是空的', '在「设置API接收」页面点「随机获取」');
  else if (wecom.token.length < 3 || wecom.token.length > 32) {
    bad('WECOM_TOKEN 长度应为 3~32 位，当前 ' + wecom.token.length + ' 位');
  } else ok('WECOM_TOKEN 长度正常（' + wecom.token.length + ' 位）');

  if (!wecom.aesKey) bad('WECOM_AES_KEY 是空的', '在「设置API接收」页面点「随机获取」');
  else if (wecom.aesKey.length !== 43) {
    bad(
      'WECOM_AES_KEY 必须是 43 位，当前 ' + wecom.aesKey.length + ' 位',
      '多半是复制时少了字符或多带了空格'
    );
  } else {
    try {
      wxcrypt.getAesKey(wecom.aesKey);
      ok('WECOM_AES_KEY 可正确解码为 32 字节密钥');
    } catch (e) {
      bad('WECOM_AES_KEY 无法解码：' + e.message);
    }
  }

  if (app.store !== 'feishu') {
    info('APP_STORE=' + app.store + '，跳过飞书检查（只做本地存储）');
  } else {
    if (!/^cli_/.test(feishu.appId)) {
      warn('FEISHU_APP_ID 一般以 cli_ 开头，当前：' + (feishu.appId || '（空）'));
    } else ok('FEISHU_APP_ID 格式正常');

    if (!feishu.appSecret) bad('FEISHU_APP_SECRET 是空的', '开发者后台 → 凭证与基础信息');
    else if (feishu.appSecret.length < 20) warn('FEISHU_APP_SECRET 偏短，确认没复制漏');
    else ok('FEISHU_APP_SECRET 已填写（' + feishu.appSecret.length + ' 位）');

    if (!feishu.appToken) bad('FEISHU_APP_TOKEN 是空的', '表格链接 /base/ 后面那一串');
    if (!feishu.tableId) bad('FEISHU_TABLE_ID 是空的', '表格链接 table= 后面那一串');
    else if (!/^tbl/.test(feishu.tableId)) {
      warn('FEISHU_TABLE_ID 一般以 tbl 开头，当前：' + feishu.tableId);
    } else ok('FEISHU_TABLE_ID 格式正常');
  }

  if (problems > 0) {
    console.log('\n先把手上的配置补齐，再跑一次。');
    return finish();
  }

  // ============ 2. 飞书 token ============
  let token = '';
  if (app.store === 'feishu') {
    section('2. 飞书应用认证');
    try {
      const { json } = await call('/auth/v3/tenant_access_token/internal', {
        method: 'POST',
        body: { app_id: feishu.appId, app_secret: feishu.appSecret },
      });
      if (json.code !== 0) {
        // 21001 = 平台策略拒绝。最容易误判成"配置错了"，其实配置往往全对。
        // 做个对照实验：故意把 Secret 改错再请求一次。
        // 若返回 10014（app secret invalid），证明 App ID/Secret 正确、请求确实到了飞书，
        // 被拒的是租户资质那一层 —— 改配置永远改不好。
        if (json.code === 21001) {
          bad('换取 token 被平台策略拒绝：code 21001');
          let secretOk = false;
          try {
            const probe = await call('/auth/v3/tenant_access_token/internal', {
              method: 'POST',
              body: {
                app_id: feishu.appId,
                app_secret: String(feishu.appSecret).slice(0, -4) + 'zzzz',
              },
            });
            secretOk = probe.json.code === 10014;
            info(
              '对照实验：故意填错 Secret → 返回 code ' + probe.json.code +
                (secretOk ? '（密钥本身没问题，请求也确实到达了飞书）' : '')
            );
          } catch (e) {
            info('对照实验没做成：' + e.message);
          }
          if (secretOk) {
            info('');
            info('结论：不是你的配置问题，改配置改不好。');
            info('飞书硬性要求「开发者必须是飞书企业用户」，个人版账号能建应用、能发版，');
            info('但调 OpenAPI 会被策略层拦下。');
            info('');
            info('解决：飞书客户端 → 创建一个团队（免费，1 分钟）→');
            info('      在新团队下重建自建应用 → 换新的 App ID / Secret 重新跑本工具');
          } else {
            info('结论：密钥或应用状态有问题，去开发者后台「凭证与基础信息」重新核对');
          }
          return finish();
        }
        bad(
          '换取 token 失败：' + json.msg + '（code ' + json.code + '）',
          json.code === 10014
            ? 'App Secret 不对，重新复制一次'
            : json.code === 10003
            ? 'App ID 不存在，检查是否复制了别的应用'
            : '去飞书开发者后台确认应用状态'
        );
        return finish();
      }
      token = json.tenant_access_token;
      ok('AppID / AppSecret 正确，已拿到 tenant_access_token');
    } catch (e) {
      bad('连不上飞书开放平台：' + e.message, '检查网络、代理，或公司网络是否拦截了 open.feishu.cn');
      return finish();
    }

    // ============ 3. 机器人能力 ============
    // 飞书官方规定：用应用身份访问「别人的」云文档，前提是应用已开启机器人能力。
    // 没开的话，表格的「添加文档应用」窗口里根本搜不到这个应用。
    section('3. 机器人能力');
    try {
      const { json } = await call('/bot/v3/info', { token });
      if (json.code === 0) {
        const name = (json.bot && json.bot.app_name) || '';
        ok('已开启机器人能力' + (name ? '（' + name + '）' : ''));
      } else {
        warn(
          '机器人能力可能没开：' + json.msg + '（code ' + json.code + '）',
          '开发者后台左侧「添加应用能力」→「机器人」卡片 → +添加 → 然后重新创建版本并发布'
        );
      }
    } catch (e) {
      warn('机器人能力检查没跑通：' + e.message);
    }

    // ============ 4. 表格可访问性 ============
    section('4. 表格访问权限');
    let fields = [];
    try {
      const { json } = await call(
        '/bitable/v1/apps/' + feishu.appToken + '/tables/' + feishu.tableId + '/fields?page_size=100',
        { token }
      );
      if (json.code !== 0) {
        const hint =
          json.code === 1254004 || json.code === 1254040
            ? 'app_token 或 table_id 不对，重新从地址栏复制'
            : json.code === 1254302 || json.code === 91403
            ? '应用没被加进这张表。正确入口：表格右上角「···」→「···更多」→「添加文档应用」→ 搜应用名 → 权限「可编辑」。注意「分享」那个弹窗是给人用的，搜不到应用'
            : '确认表格链接是 /base/ 开头（不是 /wiki/）';
        bad('读取表结构失败：' + json.msg + '（code ' + json.code + '）', hint);
        return finish();
      }
      fields = json.data.items || [];
      ok('能读到表格，共 ' + fields.length + ' 个字段');
    } catch (e) {
      bad('读取表结构出错：' + e.message);
      return finish();
    }

    // ============ 5. 列名校验 ============
    section('5. 表结构核对');
    const byName = new Map(fields.map((f) => [f.field_name, f]));
    info('表里的列：' + fields.map((f) => f.field_name + '(' + (FIELD_TYPES[f.type] || f.type) + ')').join('、'));

    const need = [
      { name: feishu.fields.amount, allow: [2], label: '金额', hint: '应该是「数字」类型' },
      { name: feishu.fields.type, allow: [3, 1], label: '类型', hint: '「单选」或「文本」都行' },
      { name: feishu.fields.note, allow: [1], label: '备注', hint: '应该是「多行文本」' },
      { name: feishu.fields.category, allow: [1, 3, 4], label: '分类', hint: '「文本」最省事，「单选」也可以' },
      { name: feishu.fields.date, allow: [5], label: '日期', hint: '必须是「日期」类型，不能是文本' },
    ];

    for (const n of need) {
      const f = byName.get(n.name);
      if (!f) {
        bad(
          '表里找不到列「' + n.name + '」',
          fields.length
            ? '现有列名是：' + fields.map((x) => '「' + x.field_name + '」').join('、') +
              '。要么改列名，要么改环境变量 FEISHU_FIELD_*'
            : '表格里还没有列，先按手册建 5 列'
        );
        continue;
      }
      if (!n.allow.includes(f.type)) {
        bad(
          '列「' + n.name + '」类型是「' + (FIELD_TYPES[f.type] || f.type) + '」，' + n.hint,
          n.label === '日期'
            ? '点列标题 → 编辑字段 → 类型改成「日期」，并把格式设为含时间'
            : '点列标题 → 编辑字段 → 改类型'
        );
        continue;
      }
      ok('列「' + n.name + '」存在，类型「' + (FIELD_TYPES[f.type] || f.type) + '」正确');
    }

    // ============ 6. 单选选项 ============
    const typeField = byName.get(feishu.fields.type);
    if (typeField && typeField.type === 3) {
      const opts = ((typeField.property && typeField.property.options) || []).map((o) => o.name);
      const missing = [feishu.typeValues.expense, feishu.typeValues.income].filter(
        (v) => !opts.includes(v)
      );
      if (missing.length) {
        bad(
          '「' + feishu.fields.type + '」单选里缺少选项：' + missing.join('、'),
          '点列标题 → 编辑字段 → 给单选补上这些选项（当前有：' + (opts.join('、') || '无') + '）'
        );
      } else {
        ok('「' + feishu.fields.type + '」的选项齐全（' + opts.join('、') + '）');
      }
    }

    // ============ 7. 试写 ============
    section('7. 写入测试' + (DO_WRITE ? '' : '（加 --write 参数可真实写入一条验证）'));
    if (!DO_WRITE) {
      info('跳过了。想验证写权限，就再跑： node tools/check.js --write');
    } else if (problems > 0) {
      info('前面有错误，先修好再试写');
    } else {
      let recordId = '';
      try {
        const nowMs = Date.now();
        const { json } = await call(
          '/bitable/v1/apps/' + feishu.appToken + '/tables/' + feishu.tableId + '/records',
          {
            method: 'POST',
            token,
            body: {
              fields: {
                [feishu.fields.amount]: 0.01,
                [feishu.fields.type]: feishu.typeValues.expense,
                [feishu.fields.note]: '自检测试，稍后自动删除',
                [feishu.fields.category]: '其他',
                [feishu.fields.date]: nowMs,
              },
            },
          }
        );
        if (json.code !== 0) {
          bad('写入失败：' + json.msg + '（code ' + json.code + '）',
            json.code === 1254045 ? '字段名对不上，检查上面的列名核对结果' : '看飞书返回的 msg 定位');
          return finish();
        }
        recordId = json.data.record.record_id;
        ok('写入成功（record_id: ' + recordId + '）');

        const del = await call(
          '/bitable/v1/apps/' + feishu.appToken + '/tables/' + feishu.tableId + '/records/' + recordId,
          { method: 'DELETE', token }
        );
        if (del.json.code === 0) ok('测试数据已删除，表格干净');
        else warn('测试记录没删掉（code ' + del.json.code + '），手动删一下 record_id=' + recordId);
      } catch (e) {
        bad('写入测试出错：' + e.message);
      }
    }

    // ============ 8. 查询测试 ============
    section('8. 查询测试（日期筛选）');
    try {
      const now = Date.now();
      const { json } = await call(
        '/bitable/v1/apps/' + feishu.appToken + '/tables/' + feishu.tableId + '/records/search',
        {
          method: 'POST',
          token,
          body: {
            automatic_fields: false,
            page_size: 10,
            filter: {
              conjunction: 'and',
              conditions: [
                {
                  field_name: feishu.fields.date,
                  operator: 'isGreater',
                  value: ['ExactDate', String(now - 30 * 24 * 3600 * 1000)],
                },
              ],
            },
          },
        }
      );
      if (json.code !== 0) {
        bad(
          '查询失败：' + json.msg + '（code ' + json.code + '）',
          '如果提示日期字段不支持，说明「' + feishu.fields.date + '」不是日期类型'
        );
      } else {
        const n = (json.data.items || []).length;
        ok('查询正常，最近 30 天有 ' + n + ' 条记录');
        if (n > 0) {
          const sample = json.data.items[0].fields || {};
          info('抽样一条：' + JSON.stringify(sample).slice(0, 160));
          const d = sample[feishu.fields.date];
          if (d === undefined || d === null) {
            warn('抽样记录里读不到「' + feishu.fields.date + '」的值，确认列名配置对不对');
          }
        }
      }
    } catch (e) {
      bad('查询测试出错：' + e.message);
    }
  }

  finish();
}

function finish() {
  console.log('\n' + '═'.repeat(54));
  if (problems === 0 && warns === 0) {
    console.log('🎉 全部通过，可以去部署云函数了');
  } else if (problems === 0) {
    console.log('✅ 没有阻塞问题（' + warns + ' 条提醒，通常可以忽略）');
  } else {
    console.log('❌ 有 ' + problems + ' 个必须修的问题' + (warns ? '，另外 ' + warns + ' 条提醒' : ''));
    console.log('   按上面的提示逐条修完，再跑一次 node tools/check.js');
  }
  console.log('═'.repeat(54) + '\n');
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n自检脚本自身出错：', e);
  process.exit(2);
});

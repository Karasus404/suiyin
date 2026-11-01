#!/usr/bin/env node
'use strict';

/**
 * 把凭证写进 .env
 *
 * 用法（按省事程度排序）：
 *   node tools/setenv.js --paste        整段粘贴（推荐）
 *   node tools/setenv.js                逐项问答
 *   node tools/setenv.js --channel=wechat    只问公众号那 3 项
 *   node tools/setenv.js --corp-id=ww.. --token=.. --aes-key=.. --app-id=cli_.. --app-secret=.. --app-token=.. --table-id=tbl..
 *   node tools/setenv.js --wechat-app-id=wx.. --wechat-token=.. --wechat-aes-key=..
 *   node tools/setenv.js --show         看当前 .env 里填了什么（密钥打码）
 *
 * 通道规则：
 *   企业微信、公众号两套，至少完整配一套；只配一套也行，两套都配也行（程序自动分流）。
 *
 * 它会做的事：
 *   1. 拿 .env.example 做骨架（注释、默认值都保留）把值填进去
 *   2. 写完逐项校验格式（AESKey 43 位且能解码、CorpID 以 ww 开头、TableID 以 tbl 开头…）
 *   3. 原 .env 备份成 .env.bak
 *   4. 打印打码后的摘要，让你确认没粘错行
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');
const TPL_PATH = path.join(ROOT, '.env.example');
const BAK_PATH = path.join(ROOT, '.env.bak');

const checkAesKey = (v) => {
  if (v.length !== 43) return false;
  try {
    require('../src/wxcrypt').getAesKey(v);
    return true;
  } catch (e) {
    return false;
  }
};

// ============ 通道 A：企业微信 ============
const CH_wecom = [
  {
    env: 'WECOM_CORP_ID',
    label: '企业微信 · 企业 ID',
    where: '企业微信管理后台 →「我的企业」→ 企业信息 → 最下方「企业ID」',
    check: (v) => /^ww[0-9A-Za-z]{8,}$/.test(v),
    warn: '一般以 ww 开头，后面一串字母数字',
  },
  {
    env: 'WECOM_TOKEN',
    label: '企业微信 · Token',
    where: '应用 →「接收消息」→「设置API接收」页面的 Token（自己定的，3~32 位）',
    check: (v) => v.length >= 3 && v.length <= 32,
    warn: '长度要在 3~32 位之间',
    hard: true,
  },
  {
    env: 'WECOM_AES_KEY',
    label: '企业微信 · EncodingAESKey',
    where: '同一个「设置API接收」页面，点「随机获取」得到的那串 43 位字符',
    check: checkAesKey,
    warn: '必须正好 43 位，且能按 base64 解码成 32 字节',
    hard: true,
  },
];

// ============ 通道 B：公众号 / 微信测试号 ============
const CH_wechat = [
  {
    env: 'WECHAT_APP_ID',
    label: '公众号 · AppID',
    where: '公众平台 →「设置与开发」→「基本配置」→ AppID（wx 开头）；测试号在管理页顶部',
    check: (v) => /^wx[0-9A-Za-z]{10,}$/.test(v),
    warn: '一般以 wx 开头，后面一串字母数字',
  },
  {
    env: 'WECHAT_TOKEN',
    label: '公众号 · Token',
    where: '「基本配置」→「服务器配置」里你自己填的 Token（3~32 位字母数字）',
    check: (v) => v.length >= 3 && v.length <= 32,
    warn: '长度要在 3~32 位之间',
    hard: true,
  },
  {
    env: 'WECHAT_AES_KEY',
    label: '公众号 · EncodingAESKey（明文模式可留空）',
    where: '同一个「服务器配置」页面，点「随机生成」得到的那串 43 位字符',
    check: (v) => !v || checkAesKey(v),
    warn: '要么留空（明文模式），要么正好 43 位',
    hard: true,
    allowEmpty: true,
  },
];

// ============ 飞书 ============
const CH_feishu = [
  {
    env: 'FEISHU_APP_ID',
    label: '飞书 · App ID',
    where: '开发者后台 →「凭证与基础信息」→ App ID',
    check: (v) => /^cli_/.test(v),
    warn: '一般以 cli_ 开头',
  },
  {
    env: 'FEISHU_APP_SECRET',
    label: '飞书 · App Secret',
    where: '同一个页面，App Secret 点眼睛图标显示后复制',
    check: (v) => v.length >= 20,
    warn: '一般 32 位左右，太短多半是复制漏了',
  },
  {
    env: 'FEISHU_APP_TOKEN',
    label: '飞书 · App Token（多维表格）',
    where: '表格地址栏 /base/ 后面那一串',
    check: (v) => v.length >= 10,
    warn: '看起来太短，确认没漏字符',
  },
  {
    env: 'FEISHU_TABLE_ID',
    label: '飞书 · Table ID',
    where: '表格地址栏 table= 后面那一串',
    check: (v) => /^tbl/.test(v),
    warn: '一般以 tbl 开头',
  },
];

const KEYS = [...CH_wecom, ...CH_wechat, ...CH_feishu];

function mask(v) {
  if (!v) return '（空）';
  if (v.length <= 8) return v.slice(0, 2) + '*'.repeat(Math.max(1, v.length - 2));
  return v.slice(0, 4) + '*'.repeat(Math.min(18, v.length - 8)) + v.slice(-4);
}

function readTemplate() {
  try {
    return fs.readFileSync(TPL_PATH, 'utf8');
  } catch (e) {
    return KEYS.map((k) => k.env + '=\n').join('') + 'APP_STORE=feishu\n';
  }
}

/** 在模板文本里替换 KEY=xxx，没有就追加 */
function upsert(text, key, value) {
  const re = new RegExp('^' + key + '=.*$', 'm');
  if (re.test(text)) return text.replace(re, key + '=' + value);
  return text.replace(/\s*$/, '') + '\n' + key + '=' + value + '\n';
}

/** 从任意文本里抽 KEY=VALUE（忽略注释和空行） */
function parseKV(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    v = v.replace(/^["']|["']$/g, '');
    if (k) out[k] = v;
  }
  return out;
}

/** 读已有的 .env（--paste 只贴了部分值时，用它补全） */
function readCurrent() {
  try {
    return parseKV(fs.readFileSync(ENV_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function show() {
  let text = '';
  try {
    text = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (e) {
    console.log('\n还没有 .env 文件。跑 node tools/setenv.js --paste 就能生成一个。\n');
    return;
  }
  console.log('\n当前 .env（密钥已打码）：');
  console.log('─'.repeat(58));
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) {
      console.log('');
      continue;
    }
    if (t.startsWith('#')) {
      console.log(line);
      continue;
    }
    const i = t.indexOf('=');
    if (i <= 0) {
      console.log(line);
      continue;
    }
    const k = t.slice(0, i);
    const v = t.slice(i + 1);
    const secretish = /SECRET|AES_KEY|TOKEN/.test(k);
    console.log(k + '=' + (secretish ? mask(v) : v || '（空）'));
  }
  console.log('─'.repeat(58));

  // 顺便告诉用户当前实际启用的是哪套通道
  const cur = parseKV(text);
  const wecomOk = !!(cur.WECOM_TOKEN && cur.WECOM_AES_KEY && cur.WECOM_CORP_ID);
  const wechatOk = !!(cur.WECHAT_TOKEN && cur.WECHAT_APP_ID);
  console.log('\n当前启用的通道：');
  if (wecomOk) console.log('  ✅ 企业微信');
  if (wechatOk) {
    console.log('  ✅ 公众号' + (cur.WECHAT_AES_KEY ? '（安全模式）' : '（明文模式）'));
  }
  if (!wecomOk && !wechatOk) console.log('  ❌ 还没有任何一套是完整的');
  console.log('');
}

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function interactive(only) {
  const list =
    only === 'wechat' ? [...CH_wechat, ...CH_feishu] : only === 'feishu' ? CH_feishu : KEYS;
  const current = readCurrent();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const got = {};
  console.log('\n共 ' + list.length + ' 项，逐项粘贴后回车。直接回车 = 保持原值/跳过。\n');
  for (let i = 0; i < list.length; i++) {
    const k = list[i];
    let v = '';
    let ok = false;
    while (!ok) {
      console.log('【' + (i + 1) + '/' + list.length + '】' + k.label);
      console.log('    从哪抄：' + k.where);
      const cur = current[k.env] ? '（当前：' + mask(current[k.env]) + '，回车保持不变）' : '';
      if (cur) console.log('    ' + cur);
      v = (await ask(rl, '    > ')).trim();
      if (!v && current[k.env]) {
        v = current[k.env];
        ok = true;
        console.log('    ↳ 保持原值\n');
        break;
      }
      if (k.allowEmpty && !v) {
        ok = true;
      } else if (k.check(v)) {
        ok = true;
      } else if (k.hard) {
        console.log('    ❌ ' + k.warn + '（当前 ' + v.length + ' 位），重新粘贴\n');
      } else {
        console.log('    ⚠️  ' + k.warn + '，先记下，最后一起看\n');
        ok = true;
      }
    }
    got[k.env] = v;
    console.log('');
  }
  rl.close();
  return got;
}

function pasteMode() {
  return new Promise((resolve) => {
    console.log('');
    console.log('把生成的配置整段粘进来（Ctrl+V 或右键粘贴）。');
    console.log('可以带 # 注释行，只有 KEY=VALUE 会被读取。');
    console.log('粘贴完按一次回车，再按一次回车表示结束。');
    console.log('');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const lines = [];
    let sawBlank = false;
    rl.on('line', (l) => {
      if (!l.trim()) {
        if (lines.length === 0) return; // 开头空行忽略
        if (sawBlank) {
          rl.close();
          return;
        }
        sawBlank = true;
        return;
      }
      sawBlank = false;
      lines.push(l);
    });
    rl.on('close', () => resolve(parseKV(lines.join('\n'))));
  });
}

function fromArgs(argv) {
  const map = {
    'corp-id': 'WECOM_CORP_ID',
    token: 'WECOM_TOKEN',
    'aes-key': 'WECOM_AES_KEY',
    'wechat-app-id': 'WECHAT_APP_ID',
    'wechat-token': 'WECHAT_TOKEN',
    'wechat-aes-key': 'WECHAT_AES_KEY',
    'app-id': 'FEISHU_APP_ID',
    'app-secret': 'FEISHU_APP_SECRET',
    'app-token': 'FEISHU_APP_TOKEN',
    'table-id': 'FEISHU_TABLE_ID',
  };
  const got = {};
  for (const a of argv) {
    const m = a.match(/^--([a-z-]+)=(.+)$/);
    if (m && map[m[1]]) got[map[m[1]]] = m[2].trim();
  }
  return got;
}

function validate(values) {
  const problems = [];
  const warns = [];

  // 逐项格式
  for (const k of KEYS) {
    const v = values[k.env];
    if (!v) continue; // 空值单独按通道完整性判断
    if (!k.check(v)) (k.hard ? problems : warns).push(k.env + ' ' + k.warn);
  }

  // 通道完整性：至少一套；填了一半的要补齐
  const wecomFilled = CH_wecom.filter((k) => values[k.env]).length;
  const wechatFilled = CH_wechat.filter((k) => values[k.env]).length;

  if (wecomFilled > 0 && wecomFilled < CH_wecom.length) {
    const miss = CH_wecom.filter((k) => !values[k.env]).map((k) => k.env);
    problems.push('企业微信只填了一半，缺：' + miss.join('、'));
  }
  if (wechatFilled > 0 && !(values.WECHAT_APP_ID && values.WECHAT_TOKEN)) {
    const miss = CH_wechat.filter(
      (k) => !values[k.env] && !k.allowEmpty
    ).map((k) => k.env);
    problems.push('公众号只填了一半，缺：' + miss.join('、'));
  }
  if (wecomFilled === 0 && wechatFilled === 0) {
    problems.push('企业微信和公众号都没配，至少完整配一套');
  }

  // 飞书必填
  for (const k of CH_feishu) {
    if (!values[k.env]) problems.push(k.env + ' 没有值');
  }

  return { problems, warns };
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--show')) return show();

  console.log('');
  console.log('  把凭证写进 .env');
  console.log('  ' + '─'.repeat(50));

  let values;
  if (argv.includes('--paste')) {
    values = { ...readCurrent(), ...(await pasteMode()) };
  } else if (argv.some((a) => a.startsWith('--') && a.includes('='))) {
    values = { ...readCurrent(), ...fromArgs(argv) };
  } else {
    const chArg = (argv.find((a) => a.startsWith('--channel=')) || '').split('=')[1];
    values = { ...readCurrent(), ...(await interactive(chArg)) };
  }

  // 空字符串也算"显式清空"，从模板里删掉占位值
  const { problems, warns } = validate(values);

  if (problems.length) {
    console.log('\n❌ 有 ' + problems.length + ' 个问题，先改好再写：');
    for (const p of problems) console.log('   · ' + p);
    console.log('\n什么都没写，.env 保持原样。\n');
    process.exit(1);
  }

  // 备份
  let backed = '';
  try {
    fs.copyFileSync(ENV_PATH, BAK_PATH);
    backed = BAK_PATH;
  } catch (e) {
    /* 原本就没有 .env，不用备份 */
  }

  // 以 .env.example 为骨架重建，注释和默认值都留着
  let text = readTemplate();
  for (const k of KEYS) {
    if (values[k.env] !== undefined) text = upsert(text, k.env, values[k.env]);
  }
  text = upsert(text, 'APP_STORE', 'feishu'); // 真实环境用飞书存储

  fs.writeFileSync(ENV_PATH, text, 'utf8');

  console.log('\n✅ 已写入 ' + ENV_PATH);
  if (backed) console.log('   原文件备份在 .env.bak');
  console.log('   顺手把 APP_STORE 改成了 feishu（连真实表格），本地测试要换回来就改回 json');
  console.log('');
  console.log('   写入的内容（密钥打码）：');
  for (const k of KEYS) {
    if (values[k.env] === undefined) continue;
    console.log('   ' + (k.env + '=').padEnd(22, ' ') + mask(values[k.env]));
  }

  const wecomOk = !!(values.WECOM_TOKEN && values.WECOM_AES_KEY && values.WECOM_CORP_ID);
  const wechatOk = !!(values.WECHAT_TOKEN && values.WECHAT_APP_ID);
  console.log('\n   启用的通道：' + [
    wecomOk ? '企业微信' : '',
    wechatOk ? '公众号' + (values.WECHAT_AES_KEY ? '（安全模式）' : '（明文模式）') : '',
  ].filter(Boolean).join(' + '));

  if (warns.length) {
    console.log('\n⚠️  有几项格式可疑，能跑但建议核对：');
    for (const w of warns) console.log('   · ' + w);
  }

  console.log('\n下一步：');
  console.log('   node tools/check.js --write');
  console.log('   它会真连飞书验一遍，全绿再去部署。\n');
}

main().catch((e) => {
  console.error('\n出错了：', e.message);
  process.exit(2);
});

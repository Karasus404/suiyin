'use strict';

/**
 * 记账语句解析
 *
 * 支持：
 *   25 午饭          -> 支出 25，备注"午饭"
 *   午饭 25          -> 同上（金额位置随意）
 *   -25 午饭         -> 支出 25
 *   +3000 工资       -> 收入 3000
 *   25 午饭 #餐饮    -> 指定分类
 *   25 午饭 分类=餐饮 -> 指定分类
 *   奶茶 18 2杯      -> 支出 18（"2杯"里的 2 会被量词规则跳过）
 *
 * 指令：
 *   本月 / 统计      -> 本月汇总
 *   今天 / 今日      -> 今日明细
 *   删除 / 删1 / 撤销 -> 撤掉最近一条
 *   帮助 / ?         -> 用法
 */

// 量词：数字后面跟这些词时，它不是金额
const UNITS = [
  '杯', '个', '瓶', '包', '斤', '件', '张', '次', '份', '只', '根', '盒',
  '袋', '双', '条', '天', '小时', '分钟', '点', '人', '位', '台', '本', '支',
  '块儿', 's', 'kg', 'g', 'ml', 'l', 'km',
];

// 备注里出现这些词，判定为收入
const INCOME_WORDS = [
  '工资', '奖金', '红包', '退款', '退费', '报销', '入账', '进账', '收到',
  '收入', '借到', '卖出', '卖二手', '利息', '分红', '补贴', '压岁钱',
];

// 备注以这些词开头/包含时，强制判为支出（避免"发红包"被当成收入）
const EXPENSE_HINTS = [
  '发红包', '发给', '给了', '买', '交', '充', '还', '付', '借出', '支出',
  '打赏', '捐', '缴',
];

// 分类关键词（按顺序匹配，先命中先得）
const CATEGORY_RULES = [
  ['餐饮', ['饭', '早餐', '午餐', '晚餐', '晚饭', '午饭', '夜宵', '外卖', '奶茶', '咖啡', '零食',
    '水果', '食堂', '火锅', '烧烤', '烤串', '面', '粉', '餐', '吃', '麦当劳', '肯德基',
    '星巴克', '瑞幸', '蛋糕', '饮料', '可乐', '酒吧', '啤酒']],
  ['交通', ['公交', '地铁', '打车', '出租', '滴滴', '高铁', '火车', '机票', '飞机', '加油',
    '油费', '停车', '单车', '车费', '路费', '过路', 'ETC', '顺风车', '船票', '大巴']],
  ['购物', ['衣服', '鞋', '裤', '外套', '日用品', '超市', '淘宝', '京东', '拼多多', '网购',
    '快递', '化妆', '护肤', '数码', '耳机', '电脑', '键盘', '鼠标', '充电', '数据线']],
  ['学习', ['书', '教材', '文具', '笔', '本子', '学费', '网课', '课程', '打印', '复印',
    '考试', '报名', '资料', '图书馆', '培训', '练习册', '卷子']],
  ['娱乐', ['电影', '游戏', 'KTV', '会员', '门票', '演出', '演唱会', '剧本杀', '桌游',
    '健身', '旅游', '景点', '皮肤', '充值', 'b站', '视频会员']],
  ['医疗', ['药', '医院', '挂号', '看病', '体检', '牙', '眼镜', '门诊', '口罩', '疫苗']],
  ['居住', ['房租', '水电', '电费', '水费', '物业', '话费', '网费', '宽带', '燃气',
    '煤气', '暖气', '家具', '装修']],
  ['人情', ['红包', '礼物', '礼金', '请客', '人情', '份子', '随礼', '生日']],
];

const HELP_TEXT = [
  '💰 记账用法',
  '25 午饭        记一笔支出',
  '+3000 工资    记一笔收入',
  '25 奶茶 #餐饮  指定分类',
  '',
  '📊 查询',
  '本月 / 今天     看汇总',
  '明细           看最近 10 条',
  '删1 / 撤销     删掉最近一条',
  '诊断           看通道和耗时',
].join('\n');

/** 全角转半角 + 统一空白 */
function normalize(input) {
  let s = String(input == null ? '' : input);
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  s = s.replace(/\u3000/g, ' ').replace(/[\u200B-\u200D]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

function bigramsContains(text, word) {
  return text.includes(word);
}

/** 判断分类 */
function detectCategory(note, explicit) {
  if (explicit) return explicit;
  if (!note) return '';
  const lower = note.toLowerCase();
  for (const [cat, words] of CATEGORY_RULES) {
    for (const w of words) {
      if (bigramsContains(lower, w)) return cat;
    }
  }
  return '';
}

/** 从文本里抽出金额与备注 */
function extractAmount(text) {
  // 候选：可选正负号 + 数字（可带小数）
  const re = /([+\-])?\s*(?:[¥￥])?\s*(\d+(?:[.,]\d{1,2})?)\s*(?:元|块钱|块|钱|¥|￥)?/g;
  let m;
  const candidates = [];
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const after = text.slice(end).trimStart();
    const unitHit = UNITS.find((u) => after.toLowerCase().startsWith(u.toLowerCase()));
    if (unitHit) continue; // "2杯" 不是金额
    candidates.push({
      sign: m[1] || '',
      value: Number(m[2].replace(',', '.')),
      raw: m[0],
      start,
      end,
    });
  }
  if (candidates.length === 0) return null;
  const picked = candidates[0];

  // 备注 = 原文本去掉金额片段
  let note = (text.slice(0, picked.start) + ' ' + text.slice(picked.end)).replace(/\s+/g, ' ').trim();
  note = note.replace(/^[-—–·,，、:：]+|[-—–·,，、:：]+$/g, '').trim();
  // 顺手清掉"2杯""3个"这类量词残留
  note = note
    .replace(/\d+\s*(?:杯|个|瓶|包|斤|件|张|次|份|只|根|盒|袋|双|条|人|位|台|本|支|天|小时|分钟)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { ...picked, note };
}

/** 主页：解析一条用户输入 */
function parse(input) {
  const text = normalize(input);
  if (!text) return { kind: 'unknown', raw: '' };

  // ---------- 指令 ----------
  const compact = text.replace(/\s/g, '');

  if (/^(帮助|help|用法|说明|\?|？)$/i.test(compact)) {
    return { kind: 'help', text: HELP_TEXT };
  }
  if (/^(诊断|状态|自检|测速|ping|debug)$/i.test(compact)) {
    return { kind: 'diag' };
  }
  if (/^(本月|这个月|当月|月统计|月报|月汇总|统计)$/.test(compact)) {
    return { kind: 'query', scope: 'month' };
  }
  if (/^(今天|今日|今日汇总|今天花了多少|今日统计)$/.test(compact)) {
    return { kind: 'query', scope: 'today' };
  }
  if (/^(昨天|昨日)$/.test(compact)) {
    return { kind: 'query', scope: 'yesterday' };
  }
  if (/^(明细|记录|最近|列表|最近记录|最近10条)$/.test(compact)) {
    return { kind: 'query', scope: 'recent' };
  }

  const delMatch = /^(?:删除|删掉|删|撤销|撤回|undo)(\d{0,2})$/.exec(compact);
  if (delMatch) {
    const n = delMatch[1] ? Number(delMatch[1]) : 1;
    return { kind: 'delete', offset: n <= 0 ? 1 : n };
  }

  // ---------- 记账 ----------
  const found = extractAmount(text);
  if (!found || !(found.value > 0)) {
    return { kind: 'unknown', raw: text };
  }

  // 显式分类：#餐饮  或  分类=餐饮  或  分类:餐饮
  let note = found.note;
  let explicitCategory = '';
  const tagMatch = /(?:#|分类\s*[=:：]\s*)([^\s#=:：]{1,8})/.exec(note);
  if (tagMatch) {
    explicitCategory = tagMatch[1];
    note = (note.slice(0, tagMatch.index) + ' ' + note.slice(tagMatch.index + tagMatch[0].length))
      .replace(/\s+/g, ' ')
      .trim();
  }

  let type = 'expense';
  if (found.sign === '+') {
    type = 'income';
  } else if (found.sign === '-') {
    type = 'expense';
  } else if (note && EXPENSE_HINTS.some((w) => note.includes(w))) {
    type = 'expense';
  } else if (note && INCOME_WORDS.some((w) => note.includes(w))) {
    type = 'income';
  }

  const category = detectCategory(note, explicitCategory) || (type === 'income' ? '收入' : '其他');

  return {
    kind: 'record',
    type,
    amount: Math.round(found.value * 100) / 100,
    note: note || (type === 'income' ? '收入' : '支出'),
    category,
    raw: text,
  };
}

module.exports = { parse, normalize, extractAmount, detectCategory, HELP_TEXT, CATEGORY_RULES };

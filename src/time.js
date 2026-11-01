'use strict';

/** 时区相关的日期计算（云函数默认 UTC，这里统一按配置时区算"今天/本月"） */

const HOUR = 3600 * 1000;

function offsetMs(tzOffsetHours) {
  return tzOffsetHours * HOUR;
}

/** 取某个时间点在指定时区下的年月日时分 */
function localParts(ts, tzOffsetHours) {
  const d = new Date(ts + offsetMs(tzOffsetHours));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth(),
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

/** 当天 00:00 的真实时间戳 */
function startOfDay(ts, tzOffsetHours) {
  const p = localParts(ts, tzOffsetHours);
  return Date.UTC(p.year, p.month, p.day) - offsetMs(tzOffsetHours);
}

/** 当天 23:59:59.999 */
function endOfDay(ts, tzOffsetHours) {
  return startOfDay(ts, tzOffsetHours) + 24 * HOUR - 1;
}

/** 本月 1 号 00:00 */
function startOfMonth(ts, tzOffsetHours) {
  const p = localParts(ts, tzOffsetHours);
  return Date.UTC(p.year, p.month, 1) - offsetMs(tzOffsetHours);
}

/** 下月 1 号 00:00（开区间上界） */
function startOfNextMonth(ts, tzOffsetHours) {
  const p = localParts(ts, tzOffsetHours);
  return Date.UTC(p.year, p.month + 1, 1) - offsetMs(tzOffsetHours);
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

/** 格式化为 YYYY-MM-DD HH:mm */
function formatDateTime(ts, tzOffsetHours) {
  const p = localParts(ts, tzOffsetHours);
  return (
    p.year + '-' + pad2(p.month + 1) + '-' + pad2(p.day) + ' ' + pad2(p.hour) + ':' + pad2(p.minute)
  );
}

/** 格式化为 YYYY-MM-DD */
function formatDate(ts, tzOffsetHours) {
  const p = localParts(ts, tzOffsetHours);
  return p.year + '-' + pad2(p.month + 1) + '-' + pad2(p.day);
}

/** 格式化为 MM-DD HH:mm */
function formatShort(ts, tzOffsetHours) {
  const p = localParts(ts, tzOffsetHours);
  return pad2(p.month + 1) + '-' + pad2(p.day) + ' ' + pad2(p.hour) + ':' + pad2(p.minute);
}

/** 金额格式化：1234.5 -> 1,234.50 */
function formatMoney(n) {
  const v = Math.abs(Number(n) || 0);
  const s = v.toFixed(2);
  const [intPart, decPart] = s.split('.');
  const withComma = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = Number(n) < 0 ? '-' : '';
  return sign + withComma + '.' + decPart;
}

module.exports = {
  HOUR,
  offsetMs,
  localParts,
  startOfDay,
  endOfDay,
  startOfMonth,
  startOfNextMonth,
  formatDateTime,
  formatDate,
  formatShort,
  formatMoney,
};

/**
 * js/format.js — 通用格式化工具（零依赖 ES Module）
 *
 * 供 app.js / panel.js / map.js 等模块共享，统一中文文案与数字格式。
 * 所有时间均按浏览器本地时区显示。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 把 Date / 毫秒时间戳 / ISO 字符串安全地转成 Date。
 * @param {Date|number|string|null|undefined} value
 * @returns {Date|null} 无效值返回 null
 */
export function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const text = String(value).trim();
  if (/^\d{10,}$/.test(text)) {
    const d = new Date(Number(text));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 补零到两位。 */
export function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 绝对时间：HH:MM（24 小时制）。
 * @param {Date|number|string} value
 * @returns {string} 例 "14:05"；无效值返回 "--:--"
 */
export function formatClock(value) {
  const d = toDate(value);
  if (!d) return '--:--';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 日期：YYYY-MM-DD。
 * @param {Date|number|string} value
 * @param {{ monthDay?: boolean }} [options] monthDay 为 true 时输出 "11月9日"
 * @returns {string} 无效值返回 "—"
 */
export function formatDate(value, options = {}) {
  const d = toDate(value);
  if (!d) return '—';
  if (options.monthDay) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 日期 + 时间：YYYY-MM-DD HH:MM。
 * @param {Date|number|string} value
 * @returns {string} 无效值返回 "—"
 */
export function formatDateTime(value) {
  const d = toDate(value);
  if (!d) return '—';
  return `${formatDate(d)} ${formatClock(d)}`;
}

/**
 * 时长（毫秒）转中文，最多保留两级单位：
 *  "1 小时 23 分"、"23 分钟"、"2 天 3 小时"、"45 秒"。
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0));
  if (total < MINUTE) {
    const seconds = Math.max(1, Math.round(total / 1000));
    return `${seconds} 秒`;
  }
  if (total < HOUR) {
    return `${Math.floor(total / MINUTE)} 分钟`;
  }
  if (total < DAY) {
    const hours = Math.floor(total / HOUR);
    const minutes = Math.floor((total % HOUR) / MINUTE);
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  }
  const days = Math.floor(total / DAY);
  const hours = Math.floor((total % DAY) / HOUR);
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

/**
 * 预计结束时间的相对文案，用于充电插口：
 *  未来 → "还有 1 小时 23 分"；不足 1 分钟 → "即将结束"；已过 → "已结束"。
 * @param {Date|number|string} value 结束时间
 * @param {Date|number|string} [now=Date.now()] 当前时间（便于测试/统一时钟）
 * @returns {string} 无效值返回 "时间未知"
 */
export function formatRelativeTime(value, now = Date.now()) {
  const end = toDate(value);
  const base = toDate(now);
  if (!end) return '时间未知';
  if (!base) return '时间未知';
  const diff = end.getTime() - base.getTime();
  if (diff <= 0) return '已结束';
  if (diff < MINUTE) return '即将结束';
  return `还有 ${formatDuration(diff)}`;
}

/**
 * 数字分组格式化（默认整数，中文千分位）。
 * @param {number|string} value
 * @param {{ digits?: number, fallback?: string }} [options]
 * @returns {string}
 */
export function formatNumber(value, options = {}) {
  const { digits = 0, fallback = '—' } = options;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  try {
    return new Intl.NumberFormat('zh-CN', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return String(n);
  }
}

/**
 * 插口数量文案：0 视为“待采集”（电动汽车站点暂无数据）。
 * @param {number|string} value
 * @returns {string} 例 "10 个" / "待采集"
 */
export function formatSockets(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '待采集';
  return `${formatNumber(n)} 个`;
}

/**
 * 防抖：延迟 wait 毫秒执行，连续调用只保留最后一次。
 * 返回函数带 cancel() 与 flush()。
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @param {number} [wait=200]
 * @param {{ immediate?: boolean }} [options] immediate 为 true 时先立即执行一次
 * @returns {F & { cancel: () => void, flush: () => void }}
 */
export function debounce(fn, wait = 200, options = {}) {
  const { immediate = false } = options;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;

  function debounced(...args) {
    const callNow = immediate && timer === null;
    lastArgs = args;
    lastThis = this;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!immediate && lastArgs) {
        fn.apply(lastThis, lastArgs);
        lastArgs = null;
        lastThis = null;
      }
    }, wait);
    if (callNow) fn.apply(this, args);
  }

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    lastArgs = null;
    lastThis = null;
  };

  debounced.flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      if (!immediate && lastArgs) {
        fn.apply(lastThis, lastArgs);
      }
      lastArgs = null;
      lastThis = null;
    }
  };

  return debounced;
}
/**
 * 津电云 · 模拟数据适配器
 * ==================================================================
 * 实现 `adapter.js` 中描述的契约，用确定性伪随机 + 真实作息曲线生成
 * 看起来合理、且会随时间自然演化的充电状态。
 *
 * 设计要点：
 *  - 同一站点在同一「时段」内的状态是稳定的（刷新不会乱跳）；
 *  - 占用率随一天中的时间变化：凌晨最低，早高峰 7–9 点、晚高峰 17–22 点最高；
 *  - 宿舍区站点晚高峰更满，教学区站点午间更满；
 *  - 每个充电中的插口都有 startedAt / endsAt，可据此显示「预计结束时间」；
 *  - 约 1% 的插口处于故障状态；
 *  - 每 30 秒重新计算一次并通知订阅者。
 *
 * 想接真实数据源：复制本文件结构，把 `computeDetail` 换成真实请求即可。
 */

import { SOCKET_STATUS } from './adapter.js';

const TICK_MS = 30 * 1000;
const SLOT_MS = 15 * 60 * 1000; // 15 分钟一个时段，状态在该时段内稳定

/* ------------------------------------------------------------ 伪随机 */

/** 32 位字符串哈希（FNV-1a 变体），把 "站点id:时段" 映射成稳定种子。 */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32：小而稳定的 PRNG，返回 [0,1)。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------ 作息曲线 */

/** 一天 24 小时的占用率基线（0–1），按站点类型区分。 */
const CURVES = {
  // 宿舍区：凌晨低，早晚高峰高，晚高峰最高
  dorm: [0.08, 0.05, 0.04, 0.03, 0.03, 0.05, 0.15, 0.45, 0.62, 0.5, 0.4, 0.35,
         0.32, 0.3, 0.3, 0.32, 0.38, 0.55, 0.72, 0.82, 0.85, 0.8, 0.62, 0.3],
  // 教学区：早高峰明显，午间小高峰，晚间回落
  teach: [0.05, 0.03, 0.02, 0.02, 0.02, 0.04, 0.12, 0.5, 0.7, 0.62, 0.55, 0.6,
          0.68, 0.6, 0.52, 0.5, 0.55, 0.62, 0.55, 0.42, 0.3, 0.2, 0.12, 0.07],
  // 食堂 / 公共区域：三餐时段高峰
  dining: [0.04, 0.03, 0.02, 0.02, 0.02, 0.03, 0.1, 0.55, 0.6, 0.3, 0.25, 0.55,
           0.65, 0.35, 0.25, 0.25, 0.35, 0.6, 0.68, 0.4, 0.2, 0.1, 0.06, 0.04],
  // 电动汽车：整体偏低，白天有起伏
  car: [0.1, 0.08, 0.06, 0.05, 0.05, 0.06, 0.1, 0.2, 0.35, 0.45, 0.5, 0.5,
        0.45, 0.42, 0.4, 0.42, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15, 0.12],
};

/** 根据站点名称推断作息类型。 */
function curveFor(station) {
  if (station.type === 'car') return CURVES.car;
  const name = station.name || '';
  if (/餐厅|食堂|行政楼|体育馆|学生中心|南门/.test(name)) return CURVES.dining;
  if (/教|图书馆/.test(name)) return CURVES.teach;
  return CURVES.dorm;
}

/* ------------------------------------------------------------ 状态计算 */

/**
 * 计算某站点在给定时刻的 detail。
 * @param {object} station data/stations.json 中的一条
 * @param {number} now 毫秒时间戳
 */
function computeDetail(station, now) {
  const total = Math.max(0, Number(station.sockets) || 0);
  const date = new Date(now);
  const hour = date.getHours() + date.getMinutes() / 60;
  const curve = curveFor(station);

  // 相邻两小时线性插值，避免整点跳变
  const h0 = Math.floor(hour) % 24;
  const h1 = (h0 + 1) % 24;
  const frac = hour - Math.floor(hour);
  let base = curve[h0] * (1 - frac) + curve[h1] * frac;

  // 周末整体略低（宿舍更高一些）
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  if (weekend) base *= curve === CURVES.dorm ? 1.05 : 0.8;

  const slot = Math.floor(now / SLOT_MS);
  // 会话时间锚定到时段起点，而不是当前的 now；否则每次 tick 都会把
  // startedAt / endsAt 一起后移，倒计时永远不减少。
  const slotStart = slot * SLOT_MS;
  const rand = mulberry32(hashString(`${station.id}:${slot}`));

  // 站点个体差异：有的总是偏满，有的偏空
  const bias = 0.85 + mulberry32(hashString(station.id))() * 0.3;
  const target = Math.min(0.98, Math.max(0, base * bias));

  const sockets = [];
  for (let i = 0; i < total; i += 1) {
    const r = rand();
    const no = i + 1;
    if (r < 0.01) {
      sockets.push({ no, status: SOCKET_STATUS.FAULT, startedAt: null, endsAt: null, soc: null });
      continue;
    }
    if (r < 0.01 + target) {
      // 充电中：会话时长 1–8 小时，开始时间落在时段起点之前
      const sessionMs = (1 + rand() * 7) * 3600 * 1000;
      // 让会话「已经进行了一部分」；以时段起点为锚，
      // 同一时段内 startedAt / endsAt 保持不变，倒计时才会逐秒减少
      const elapsed = rand() * sessionMs * 0.9;
      const startedAt = slotStart - elapsed;
      const endsAt = startedAt + sessionMs;
      const soc = Math.min(99, Math.round((elapsed / sessionMs) * 100));
      sockets.push({ no, status: SOCKET_STATUS.CHARGING, startedAt, endsAt, soc });
    } else {
      sockets.push({ no, status: SOCKET_STATUS.IDLE, startedAt: null, endsAt: null, soc: null });
    }
  }

  const cabinets = [];
  const cabinetCount = Math.max(0, Number(station.cabinets) || 0);
  for (let c = 0; c < cabinetCount; c += 1) {
    const cr = mulberry32(hashString(`${station.id}:cab:${c}:${slot}`))();
    const totalSlots = 6;
    cabinets.push({
      no: c + 1,
      name: `锂电柜 ${c + 1}`,
      status: cr < 0.02 ? 'fault' : 'ok',
      total: totalSlots,
      available: cr < 0.02 ? 0 : Math.round(cr * totalSlots),
    });
  }

  return { stationId: station.id, updatedAt: now, sockets, cabinets };
}

/* ------------------------------------------------------------ 适配器 */

/**
 * 创建模拟数据适配器。
 * @param {Array<object>} stations data/stations.json 的内容
 */
export function createMockAdapter(stations) {
  const list = Array.isArray(stations) ? stations : (stations?.stations ?? []);
  const byId = new Map(list.map((s) => [s.id, s]));
  const listeners = new Set();
  let timer = null;
  let updatedAt = Date.now();

  function detailFor(id, now = Date.now()) {
    const station = byId.get(id);
    if (!station) return null;
    return computeDetail(station, now);
  }

  function snapshot(now = Date.now()) {
    const out = {};
    for (const station of list) out[station.id] = computeDetail(station, now);
    return out;
  }

  function emit() {
    updatedAt = Date.now();
    const payload = { updatedAt };
    for (const cb of listeners) {
      try { cb(payload); } catch (err) { console.error('[mock-adapter] 订阅回调出错', err); }
    }
  }

  function start() {
    if (timer != null) return;
    timer = setInterval(emit, TICK_MS);
  }

  start();

  return {
    get updatedAt() { return updatedAt; },
    getStationDetail: (id) => detailFor(id),
    getDetail: (id) => detailFor(id),
    getState: (id) => detailFor(id),
    getSnapshot: () => snapshot(),
    subscribe(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.add(cb);
      start();
      return () => listeners.delete(cb);
    },
    async refresh() {
      emit();
    },
    /** 测试 / 调试用：停止定时器。 */
    stop() {
      if (timer != null) { clearInterval(timer); timer = null; }
    },
  };
}

export { computeDetail, CURVES };

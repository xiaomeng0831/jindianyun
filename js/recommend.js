/**
 * 津电云 · 智能寻桩推荐、全校状态聚合与哈希解析纯函数库
 * ------------------------------------------------------------------
 * 零依赖 ES 模块，供浏览器端 (js/app.js) 与自动化测试 (scripts/verify_all.mjs) 共用。
 */

export const CAMPUS_CENTER = {
  lon: 117.30754,
  lat: 38.99658,
  name: '郑东图书馆（校区中心）',
};

const EARTH_RADIUS_M = 6371000;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/**
 * 计算两点间球面距离（米，Haversine 公式）。
 */
export function haversineMeters(lon1, lat1, lon2, lat2) {
  if (![lon1, lat1, lon2, lat2].every(Number.isFinite)) return Infinity;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return Math.round(EARTH_RADIUS_M * c);
}

/**
 * 估算校园内步行耗时（分钟）：按直线距离 × 1.25 绕行系数，步速 80m/分钟。
 */
export function estimateWalkMinutes(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return 1;
  return Math.max(1, Math.round((meters * 1.25) / 80));
}

/**
 * 校验起点是否在北洋园校区周边（默认 3000m 内），若超出则自动回退至校区中心。
 */
export function resolveCampusOrigin(lon, lat, name = '当前位置', maxDistanceMeters = 3000) {
  const dist = haversineMeters(lon, lat, CAMPUS_CENTER.lon, CAMPUS_CENTER.lat);
  if (!Number.isFinite(dist) || dist > maxDistanceMeters) {
    return {
      lon: CAMPUS_CENTER.lon,
      lat: CAMPUS_CENTER.lat,
      name: CAMPUS_CENTER.name,
      fallback: true,
      distanceFromCampus: dist,
    };
  }
  return {
    lon: Number(lon),
    lat: Number(lat),
    name: String(name || '当前位置'),
    fallback: false,
    distanceFromCampus: dist,
  };
}

/**
 * 按起点坐标与实时空闲状态智能推荐最优充电站（默认返回 Top 3）。
 * 评分规则：
 *   - 优先推荐有空闲插口（idle > 0）的站点；
 *   - 综合得分 score = 距离米数 - 空闲插口数 × 18（兼顾距离近与空位充裕）；
 *   - 若全部站点均无空闲，则按距离由近到远回退返回。
 */
export function recommendStations(origin, stations, summarizeFn, detailReader, options = {}) {
  if (!origin || !Number.isFinite(origin.lon) || !Number.isFinite(origin.lat)) return [];
  const limit = Math.max(1, Number(options.limit) || 3);
  const filter = options.filter || 'all';

  const candidates = [];
  for (const station of stations || []) {
    if (!station || !Number.isFinite(station.lon) || !Number.isFinite(station.lat)) continue;
    if (filter === 'bike' && station.type !== 'bike') continue;
    if (filter === 'car' && station.type !== 'car') continue;
    if (filter === 'cabinet' && !(Number(station.cabinets) > 0)) continue;

    const detail = typeof detailReader === 'function' ? detailReader(station.id) : null;
    const summary = typeof summarizeFn === 'function'
      ? summarizeFn(station, detail)
      : { total: Number(station.sockets) || 0, idle: 0, charging: 0, fault: 0 };

    const meters = haversineMeters(origin.lon, origin.lat, station.lon, station.lat);
    const walkMinutes = estimateWalkMinutes(meters);
    const idle = Number(summary.idle) || 0;
    const charging = Number(summary.charging) || 0;
    const fault = Number(summary.fault) || 0;
    const total = Number(summary.total) || Number(station.sockets) || 0;

    // 有空闲站点获得显著优先权，同为有空闲时综合距离与空闲数排序
    const penalty = idle > 0 ? 0 : 100000;
    const score = penalty + meters - Math.min(idle, 12) * 18;

    candidates.push({
      station,
      meters,
      walkMinutes,
      idle,
      charging,
      fault,
      total,
      score,
    });
  }

  candidates.sort((a, b) => a.score - b.score || a.meters - b.meters);
  return candidates.slice(0, limit);
}

/**
 * 聚合计算全校充电桩与锂电柜实时运行总览。
 */
export function computeCampusOverview(stations, summarizeFn, detailReader) {
  const result = {
    totalStations: 0,
    totalSockets: 0,
    totalIdle: 0,
    totalCharging: 0,
    totalFault: 0,
    occupancyRate: 0,
    bike: { stations: 0, sockets: 0, idle: 0, charging: 0, fault: 0 },
    car: { stations: 0, sockets: 0, idle: 0, charging: 0, fault: 0 },
    cabinets: { stations: 0, totalGroups: 0, availableSlots: 0, totalSlots: 0 },
    topIdle: [],
    topCrowded: [],
  };

  const rows = [];

  for (const station of stations || []) {
    if (!station) continue;
    result.totalStations += 1;
    const detail = typeof detailReader === 'function' ? detailReader(station.id) : null;
    const summary = typeof summarizeFn === 'function'
      ? summarizeFn(station, detail)
      : { total: Number(station.sockets) || 0, idle: 0, charging: 0, fault: 0 };

    const total = Number(summary.total) || Number(station.sockets) || 0;
    const idle = Number(summary.idle) || 0;
    const charging = Number(summary.charging) || 0;
    const fault = Number(summary.fault) || 0;
    const ratio = total > 0 ? charging / total : 0;

    result.totalSockets += total;
    result.totalIdle += idle;
    result.totalCharging += charging;
    result.totalFault += fault;

    const bucket = station.type === 'car' ? result.car : result.bike;
    bucket.stations += 1;
    bucket.sockets += total;
    bucket.idle += idle;
    bucket.charging += charging;
    bucket.fault += fault;

    const cabGroups = Number(station.cabinets) || 0;
    if (cabGroups > 0) {
      result.cabinets.stations += 1;
      result.cabinets.totalGroups += cabGroups;
      const cabList = Array.isArray(detail?.cabinets) ? detail.cabinets : [];
      for (const c of cabList) {
        if (Number.isFinite(c?.available)) result.cabinets.availableSlots += Number(c.available);
        if (Number.isFinite(c?.total)) result.cabinets.totalSlots += Number(c.total);
      }
    }

    rows.push({
      station,
      total,
      idle,
      charging,
      fault,
      ratio,
    });
  }

  result.occupancyRate = result.totalSockets > 0
    ? Math.round((result.totalCharging / result.totalSockets) * 100)
    : 0;

  result.topIdle = [...rows]
    .filter((r) => r.idle > 0)
    .sort((a, b) => b.idle - a.idle || a.ratio - b.ratio)
    .slice(0, 5);

  result.topCrowded = [...rows]
    .filter((r) => r.total > 0)
    .sort((a, b) => b.ratio - a.ratio || a.idle - b.idle)
    .slice(0, 5);

  return result;
}

/**
 * 解析 URL 哈希中的站点 ID，兼容：
 *   - #station=bike-geyuan-1
 *   - #station-bike-geyuan-1
 *   - #bike-geyuan-1
 */
export function parseStationHash(rawHash) {
  if (!rawHash || typeof rawHash !== 'string') return '';
  let decoded = '';
  try {
    decoded = decodeURIComponent(rawHash.replace(/^#/, '').trim());
  } catch {
    return '';
  }
  if (!decoded) return '';
  if (decoded.startsWith('station=')) return decoded.slice('station='.length).trim();
  if (decoded.startsWith('station-')) return decoded.slice('station-'.length).trim();
  return decoded;
}

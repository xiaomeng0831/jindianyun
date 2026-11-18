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

const DEFAULT_TYPE_TEXT = { bike: '电动自行车', car: '电动汽车' };

/**
 * 本地实时事实问答纯函数引擎：
 * 当远端问答接口被 CORS 拦截（如 file:// 或 localhost）或远端模型缺少实时状态时，
 * 直接基于当前站点、楼宇与实时插口统计生成精准 Markdown 回答。
 */
export function answerChatLocally(
  rawQuestion,
  stations = [],
  buildings = [],
  summarizeFn,
  detailReader,
  typeText = DEFAULT_TYPE_TEXT,
) {
  const q = String(rawQuestion || '').trim();
  const ov = computeCampusOverview(stations, summarizeFn, detailReader);

  // 1. 地图用法与帮助类问题
  if (/怎么用|怎么使用|用法|指南|颜色|筛选|搜索|功能/.test(q)) {
    return [
      '**津电云地图使用指南：**',
      '1. **看颜色识空闲**：绿色图钉代表空闲充裕，橙色代表较满，红色代表接近满载；圆形为电动自行车桩，圆角方形为电动汽车桩，带 `柜` 角标表示配有锂电换电柜。',
      '2. **搜楼宇自动导引**：在顶部搜索框输入任意教学楼或宿舍（如 `38教学楼`、`郑东图书馆`），地图会自动画出到最近空闲充电站的**彩色虚线导引路径**并估算步行耗时。',
      '3. **全校总览与筛选**：点击顶部 `全校总览` 可查看空闲 Top 5 排行榜与切换数据源；点击右下角定位按钮可一键推荐附近空闲桩。',
    ].join('\n');
  }

  // 2. 锂电柜 / 换电类问题
  if (/锂电|换电|电池柜|电柜/.test(q)) {
    const cabStations = (stations || []).filter((s) => Number(s.cabinets) > 0);
    const lines = cabStations.map((s) => {
      const detail = typeof detailReader === 'function' ? detailReader(s.id) : null;
      const sum = typeof summarizeFn === 'function'
        ? summarizeFn(s, detail)
        : { idle: 0, total: Number(s.sockets) || 0 };
      return `- **${s.name}**：配 **${s.cabinets} 组**锂电柜（充电插口空闲 ${sum.idle}/${sum.total}）`;
    });
    return [
      `北洋园校区共有 **${ov.cabinets.stations} 处**站点配备锂电换电柜（合计 **${ov.cabinets.totalGroups} 组**，当前可用电池仓 **${ov.cabinets.availableSlots}/${ov.cabinets.totalSlots || 48}**）：`,
      ...lines,
      '你可以在顶部筛选栏点击 `含锂电柜` 只看换电点位。',
    ].join('\n');
  }

  // 3. 电动汽车 / 快慢充类问题
  if (/汽车|电车|快充|慢充|四轮/.test(q)) {
    const carStations = (stations || []).filter((s) => s.type === 'car');
    const lines = carStations.map((s) => {
      const detail = typeof detailReader === 'function' ? detailReader(s.id) : null;
      const sum = typeof summarizeFn === 'function'
        ? summarizeFn(s, detail)
        : { idle: 0, total: Number(s.sockets) || 0 };
      return `- **${s.name}**：空闲 **${sum.idle}/${sum.total}** 车位`;
    });
    return [
      `全校共有 **${ov.car.stations} 处**电动汽车充电站（合计 **${ov.car.sockets} 个**车位，当前空闲 **${ov.car.idle}** 个）：`,
      ...lines,
      '其中 **1895行政楼北侧**（14口：快8+慢6）与 **桃园餐厅东侧**（7口：快4+慢3）为实测配比。',
    ].join('\n');
  }

  // 4. 特定园区 / 楼宇 / 站点附近寻桩（匹配站点名、园区关键词或楼宇名）
  const cleanQ = q.replace(/附近|周围|旁边|有没有|有吗|在哪|去哪|充电桩|充电站|充电|请问|现在|的/g, '').trim();
  if (cleanQ.length >= 2) {
    const matchedStations = (stations || []).filter((s) => s.name.includes(cleanQ) || cleanQ.includes(s.name));
    if (matchedStations.length > 0) {
      const lines = matchedStations.map((s) => {
        const detail = typeof detailReader === 'function' ? detailReader(s.id) : null;
        const sum = typeof summarizeFn === 'function'
          ? summarizeFn(s, detail)
          : { idle: 0, charging: 0, total: Number(s.sockets) || 0 };
        const cab = Number(s.cabinets) > 0 ? `，含 ${s.cabinets} 组锂电柜` : '';
        return `- **${s.name}**（${typeText[s.type] || '充电站'}）：当前空闲 **${sum.idle}/${sum.total}** 口（使用中 ${sum.charging} 口${cab}）`;
      });
      const origin = { lon: matchedStations[0].lon, lat: matchedStations[0].lat, name: matchedStations[0].name };
      const nearby = recommendStations(origin, stations, summarizeFn, detailReader, { limit: 3 });
      const nearText = nearby
        .map((r, i) => `${i + 1}. **${r.station.name}**（约 ${r.meters}m，空闲 **${r.idle}/${r.total}** 口）`)
        .join('\n');
      return [
        `为你找到与「**${cleanQ}**」匹配的充电站实时状态：`,
        ...lines,
        '',
        '**该区域就近空闲推荐：**',
        nearText,
      ].join('\n');
    }

    const matchedBuilding = (buildings || []).find((b) => b.name && (b.name.includes(cleanQ) || cleanQ.includes(b.name)));
    if (matchedBuilding) {
      const recs = recommendStations(matchedBuilding, stations, summarizeFn, detailReader, { limit: 3 });
      const recLines = recs.map((r, i) => (
        `${i + 1}. **${r.station.name}**（距此约 **${r.meters}m** · 步行约 ${r.walkMinutes} 分钟）：空闲 **${r.idle}/${r.total}** 口`
      ));
      return [
        `从 **${matchedBuilding.name}** 出发，为你推荐距离最近且有空位的充电站：`,
        ...recLines,
        '在顶部搜索框选中该楼宇即可在地图上显示彩色导引虚线。',
      ].join('\n');
    }
  }

  // 5. 默认 / 哪些站点比较空 / 全校概况
  const topIdleLines = ov.topIdle.map((it, idx) => (
    `${idx + 1}. **${it.station.name}**（${typeText[it.station.type] || '充电站'}）：空闲 **${it.idle}/${it.total}** 口`
  ));
  const crowdedNames = ov.topCrowded.slice(0, 3).map((it) => (
    `**${it.station.name}**（余 ${it.idle} 口）`
  )).join('、');

  return [
    `当前全校 **${ov.totalStations}** 个站点共有空闲插口 **${ov.totalIdle}/${ov.totalSockets}** 个（电动自行车空闲 ${ov.bike.idle}/${ov.bike.sockets}，汽车空闲 ${ov.car.idle}/${ov.car.sockets}，总占用率 ${ov.occupancyRate}%）。`,
    '',
    '**目前空闲最充裕的站点 Top 5：**',
    ...topIdleLines,
    '',
    `当前较满站点：${crowdedNames}，建议错峰或前往上方空闲站点。`,
  ].join('\n');
}

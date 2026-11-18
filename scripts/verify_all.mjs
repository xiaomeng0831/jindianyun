#!/usr/bin/env node
/**
 * 津电云 · 全链路自动化回归与数据契约校验套件
 * ------------------------------------------------------------------
 * 运行方式：
 *   node scripts/verify_all.mjs
 *
 * 校验范围：
 *   1. 离线底图规范（data/basemap.json）
 *   2. 站点数据完整性（data/stations.json）
 *   3. 模拟数据适配器（js/mock-adapter.js 与 24h 趋势生成）
 *   4. 通用格式化工具库（js/format.js）
 *   5. 状态归一化与时间解析契约（js/panel.js 与 js/adapter.js）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// 导入核心模块
import { createMockAdapter, computeHourlyTrend, CURVES } from '../js/mock-adapter.js';
import {
  formatDuration, formatRelativeTime, formatClock, formatDate,
  formatSockets, formatNumber, toDate, debounce
} from '../js/format.js';
import { normalizeStatus, toTimestamp, escapeHtml, formatRemaining, summarizeStation } from '../js/panel.js';
import { SOCKET_STATUS } from '../js/adapter.js';
import {
  haversineMeters, estimateWalkMinutes, recommendStations,
  computeCampusOverview, parseStationHash, resolveCampusOrigin,
} from '../js/recommend.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    failed += 1;
    console.error(`  ✖ 失败: ${message}`);
    throw new Error(message);
  }
}

function testSection(title, fn) {
  console.log(`\n▶ ${title}`);
  try {
    fn();
    passed += 1;
    console.log(`  ✓ 校验通过`);
  } catch (err) {
    console.error(`  ✖ 该项测试未通过: ${err.message}`);
  }
}

async function testAsyncSection(title, fn) {
  console.log(`\n▶ ${title}`);
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ 校验通过`);
  } catch (err) {
    console.error(`  ✖ 该项测试未通过: ${err.message}`);
  }
}

console.log('='.repeat(60));
console.log('津电云 · 静态地图与适配器全链路校验套件');
console.log('='.repeat(60));

// 1. 底图数据校验
testSection('1. 离线底图数据 (data/basemap.json) 校验', () => {
  const p = path.join(ROOT, 'data', 'basemap.json');
  assert(fs.existsSync(p), 'basemap.json 文件不存在');
  const raw = fs.readFileSync(p, 'utf8');
  const d = JSON.parse(raw);

  // bbox 校验
  assert(Array.isArray(d.bbox) && d.bbox.length === 4, 'bbox 必须是包含 4 个元素的数组');
  const [minLon, minLat, maxLon, maxLat] = d.bbox;
  assert(minLon < maxLon && minLat < maxLat, 'bbox 坐标顺序不合规');
  assert(minLon > 117.28 && maxLon < 117.33, 'bbox 经度偏离北洋园校区');
  assert(minLat > 38.98 && maxLat < 39.02, 'bbox 纬度偏离北洋园校区');

  // 边界
  const ring = Array.isArray(d.boundary?.[0]) ? d.boundary[0] : d.boundary;
  assert(Array.isArray(ring) && ring.length >= 20, '校区边界点数量过少');

  // 建筑与道路
  assert(Array.isArray(d.buildings) && d.buildings.length >= 100, `建筑数量少于 100（当前: ${d.buildings?.length}）`);
  const named = d.buildings.filter(b => b.name && b.name.trim().length > 0);
  assert(named.length >= 80, `命名建筑数量过少（当前: ${named.length}）`);

  // 多边形闭合性与数值合法性
  for (const b of d.buildings) {
    const pts = b.poly || b.polygon;
    assert(Array.isArray(pts) && pts.length >= 3, `建筑 ${b.name || b.id} 多边形点少于 3 个`);
    for (const [lon, lat] of pts) {
      assert(Number.isFinite(lon) && Number.isFinite(lat), `建筑坐标存在 NaN 或非法值`);
      assert(lon >= minLon - 0.005 && lon <= maxLon + 0.005, `建筑坐标超出校区经度范围: ${lon}`);
      assert(lat >= minLat - 0.005 && lat <= maxLat + 0.005, `建筑坐标超出校区纬度范围: ${lat}`);
    }
  }

  assert(Array.isArray(d.roads) && d.roads.length >= 200, `道路数量少于 200（当前: ${d.roads?.length}）`);
  assert(Array.isArray(d.areas) && d.areas.length >= 50, `水体与绿地数量过少`);
  console.log(`    - 建筑: ${d.buildings.length} 栋（其中 ${named.length} 栋已命名）`);
  console.log(`    - 道路: ${d.roads.length} 条，水系/绿地: ${d.areas.length} 处`);
});

// 2. 站点数据校验
testSection('2. 充电站点数据 (data/stations.json) 校验', () => {
  const p = path.join(ROOT, 'data', 'stations.json');
  assert(fs.existsSync(p), 'stations.json 文件不存在');
  const stations = JSON.parse(fs.readFileSync(p, 'utf8'));

  assert(Array.isArray(stations), 'stations.json 必须是数组');
  assert(stations.length === 26, `站点总数应为 26 处，当前实际为 ${stations.length}`);

  const ids = new Set();
  let bikes = 0;
  let cars = 0;
  let bikeSockets = 0;
  let cabinets = 0;

  for (const s of stations) {
    assert(s.id && typeof s.id === 'string', '站点缺少 id 字符串');
    assert(!ids.has(s.id), `站点 ID 重复: ${s.id}`);
    ids.add(s.id);

    assert(s.name && typeof s.name === 'string', `站点 ${s.id} 缺少名称`);
    assert(Number.isFinite(s.lon) && Number.isFinite(s.lat), `站点 ${s.id} 坐标非法`);
    assert(s.lon > 117.29 && s.lon < 117.33, `站点 ${s.id} 经度不在北洋园范围内: ${s.lon}`);
    assert(s.lat > 38.98 && s.lat < 39.02, `站点 ${s.id} 纬度不在北洋园范围内: ${s.lat}`);

    if (s.type === 'bike') {
      bikes += 1;
      bikeSockets += Number(s.sockets || 0);
      cabinets += Number(s.cabinets || 0);
    } else if (s.type === 'car') {
      cars += 1;
    } else {
      assert(false, `未知站点类型: ${s.type}`);
    }
  }

  assert(bikes === 18, `自行车站点数应为 18，实为 ${bikes}`);
  assert(cars === 8, `汽车站点数应为 8，实为 ${cars}`);
  assert(bikeSockets === 229, `自行车插口总数应与北洋维基校对一致为 229，实为 ${bikeSockets}`);
  assert(cabinets === 8, `锂电柜总数应为 8 组，实为 ${cabinets}`);
  console.log(`    - 自行车站: 18 处（共 ${bikeSockets} 插口，${cabinets} 组锂电柜）`);
  console.log(`    - 汽车站: 8 处`);
});

// 3. 模拟适配器与趋势算法校验
testSection('3. 模拟数据适配器 (js/mock-adapter.js) 校验', () => {
  const p = path.join(ROOT, 'data', 'stations.json');
  const stations = JSON.parse(fs.readFileSync(p, 'utf8'));

  const adapter = createMockAdapter(stations);
  assert(adapter && typeof adapter.getSnapshot === 'function', '适配器对象缺少 getSnapshot 方法');

  const snapshot = adapter.getSnapshot();
  assert(Object.keys(snapshot).length === 26, '快照应包含 26 个站点的状态');

  // 逐站检查 detail 结构
  for (const s of stations) {
    const detail = snapshot[s.id];
    assert(detail, `站点 ${s.id} 缺少详情快照`);
    assert(detail.stationId === s.id, `详情 stationId 不匹配: ${detail.stationId}`);
    assert(Number.isFinite(detail.updatedAt), `updatedAt 非法`);
    assert(Array.isArray(detail.sockets), `sockets 必须是数组`);
    assert(detail.sockets.length === Number(s.sockets || 0), `插口数不符合配置`);

    // 检查插口属性与倒计时
    for (const sk of detail.sockets) {
      assert(sk.no >= 1, `插口编号非法: ${sk.no}`);
      assert([SOCKET_STATUS.CHARGING, SOCKET_STATUS.IDLE, SOCKET_STATUS.FAULT].includes(sk.status),
        `插口状态值不合法: ${sk.status}`);
      if (sk.status === SOCKET_STATUS.CHARGING) {
        assert(Number.isFinite(sk.startedAt) && Number.isFinite(sk.endsAt), '充电插口必须有 startedAt/endsAt');
        assert(sk.endsAt >= sk.startedAt, 'endsAt 不能早于 startedAt');
        assert(sk.soc == null || (sk.soc >= 0 && sk.soc <= 100), `SOC 百分比超出 0-100: ${sk.soc}`);
      }
    }

    // 检查 24 小时趋势
    const trend = detail.hourlyTrend;
    assert(Array.isArray(trend) && trend.length === 24, `24h 趋势必须包含 24 个点`);
    for (let h = 0; h < 24; h += 1) {
      assert(trend[h] >= 0 && trend[h] <= 1, `小时 ${h} 占用率超出 0~1 范围: ${trend[h]}`);
    }
  }

  // 单独测试 computeHourlyTrend
  const sampleTrend = computeHourlyTrend(stations[0]);
  assert(sampleTrend.length === 24, 'computeHourlyTrend 必须返回 24 小时数组');

  adapter.stop();
  console.log(`    - 26 个站点实时插口状态、倒计时与 24h 趋势演算通过`);
});

// 4. 格式化工具单元校验
testSection('4. 通用格式化工具 (js/format.js) 校验', () => {
  // 时长
  assert(formatDuration(45 * 1000) === '45 秒', 'formatDuration 秒测试未通过');
  assert(formatDuration(15 * 60 * 1000) === '15 分钟', 'formatDuration 分钟测试未通过');
  assert(formatDuration(90 * 60 * 1000) === '1 小时 30 分', 'formatDuration 小时分钟测试未通过');
  assert(formatDuration(2 * 3600 * 1000) === '2 小时', 'formatDuration 整小时测试未通过');

  // 相对时间
  const base = new Date('2026-11-11T12:00:00Z').getTime();
  assert(formatRelativeTime(base + 120000, base) === '还有 2 分钟', '相对时间未来测试');
  assert(formatRelativeTime(base + 30000, base) === '即将结束', '相对时间即将结束测试');
  assert(formatRelativeTime(base - 10000, base) === '已结束', '相对时间已结束测试');
  assert(formatRelativeTime(null) === '时间未知', '相对时间空值测试');

  // 钟点
  const d = new Date(2026, 10, 11, 14, 5);
  assert(formatClock(d) === '14:05', 'formatClock 测试');
  assert(formatSockets(10) === '10 个', 'formatSockets 正常测试');
  assert(formatSockets(0) === '待采集', 'formatSockets 待采集测试');
  assert(formatNumber(1234567) === '1,234,567', 'formatNumber 千分位测试');
});

// 5. 状态归一化与 HTML 转义
testSection('5. 状态归一化与 HTML 安全转义 (js/panel.js) 校验', () => {
  assert(normalizeStatus('in_use') === 'charging', 'in_use 别名');
  assert(normalizeStatus('使用中') === 'charging', '中文使用中 别名');
  assert(normalizeStatus('available') === 'idle', 'available 别名');
  assert(normalizeStatus('free') === 'idle', 'free 别名');
  assert(normalizeStatus('故障') === 'fault', '中文故障 别名');
  assert(normalizeStatus(null) === 'unknown', '空值归一化');

  assert(escapeHtml('<script>alert("1")&</script>') === '&lt;script&gt;alert(&quot;1&quot;)&amp;&lt;/script&gt;',
    'HTML 危险字符转义测试');

  assert(toTimestamp('14:30') > 0, 'HH:mm 转时间戳');
  assert(toTimestamp(1762860000000) === 1762860000000, '毫秒时间戳转换');
});

// 6. 智能寻桩推荐、全校概览聚合与哈希解析校验
testSection('6. 智能寻桩推荐与全校概览聚合 (js/recommend.js) 校验', () => {
  const stations = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'stations.json'), 'utf8'));
  const adapter = createMockAdapter(stations);
  const snapshot = adapter.getSnapshot();
  adapter.stop();

  // 球面距离与步行耗时
  const dist = haversineMeters(117.30754, 38.99658, 117.309987, 39.002503);
  assert(dist > 600 && dist < 800, `球面距离计算异常: ${dist}`);
  assert(estimateWalkMinutes(120) === 2, '步行时间估算异常');

  // 校外定位回退至校区中心
  const farOrigin = resolveCampusOrigin(116.4, 39.9, '校外测试点');
  assert(farOrigin.fallback === true, '超过 3000m 的校外坐标应触发校区中心回退');
  const insideOrigin = resolveCampusOrigin(117.308, 38.997, '郑东图书馆');
  assert(insideOrigin.fallback === false && insideOrigin.name === '郑东图书馆', '校内坐标不应触发回退');

  // 智能推荐 Top 3
  const recs = recommendStations(
    { lon: 117.3099, lat: 39.0024, name: '格园1斋' },
    stations,
    summarizeStation,
    (id) => snapshot[id],
    { limit: 3, filter: 'bike' },
  );
  assert(Array.isArray(recs) && recs.length === 3, '应返回 Top 3 推荐站点');
  assert(recs[0].station.id === 'bike-geyuan-1', `格园1斋起点应首选格园1斋充电站，实际为 ${recs[0].station.id}`);
  assert(Number.isFinite(recs[0].meters) && recs[0].walkMinutes >= 1, '推荐结果需包含距离与步行分钟');

  // 全满极端情况测试：所有站点空闲均为 0 时仍返回最近站点
  const zeroReader = (id) => ({
    stationId: id,
    updatedAt: Date.now(),
    sockets: Array.from({ length: 10 }, (_, i) => ({ no: i + 1, status: 'charging' })),
  });
  const fullRecs = recommendStations(
    { lon: 117.3099, lat: 39.0024, name: '格园1斋' },
    stations,
    summarizeStation,
    zeroReader,
    { limit: 2, filter: 'bike' },
  );
  assert(fullRecs.length === 2 && fullRecs[0].idle === 0, '全满极端情况下应按距离回退返回站点');

  // 全校总览聚合
  const overview = computeCampusOverview(stations, summarizeStation, (id) => snapshot[id]);
  assert(overview.totalStations === 26, '全校总站点数应为 26');
  assert(overview.bike.stations === 18 && overview.bike.sockets === 229, '自行车站汇总应为 18 站 229 口');
  assert(overview.car.stations === 8 && overview.car.sockets === 61, '汽车站汇总应为 8 站 61 口');
  assert(overview.cabinets.totalGroups === 8, '锂电柜组数应为 8');
  assert(Array.isArray(overview.topIdle) && overview.topIdle.length > 0, '空闲榜不应为空');

  // 哈希解析兼容
  assert(parseStationHash('#station=bike-geyuan-1') === 'bike-geyuan-1', '应支持 #station= 格式');
  assert(parseStationHash('#station-bike-geyuan-1') === 'bike-geyuan-1', '应兼容 #station- 格式');
  assert(parseStationHash('#bike-geyuan-1') === 'bike-geyuan-1', '应兼容裸 id 格式');
  assert(parseStationHash('#%') === '', '非法百分号编码应安全返回空串');

  // 代理脚本与面板哈希一致性静态断言
  const proxySrc = fs.readFileSync(path.join(ROOT, 'scripts', 'cqt_proxy.mjs'), 'utf8');
  assert(!proxySrc.includes("'/ NearDevice'"), 'cqt_proxy.mjs 不应包含带空格的 / NearDevice');
  assert(proxySrc.includes("'/NearDevice'"), 'cqt_proxy.mjs 应使用 /NearDevice');
  assert(proxySrc.includes('CQT_OPEN_ID') && proxySrc.includes('/api/stations'), 'cqt_proxy.mjs 应兼容 CQT_OPEN_ID 与 /api/stations');

  const panelSrc = fs.readFileSync(path.join(ROOT, 'js', 'panel.js'), 'utf8');
  assert(panelSrc.includes('station=${encodeURIComponent'), 'panel.js 分享链接应使用 #station= 格式');

  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert(indexHtml.includes('id="overview-btn"') && indexHtml.includes('id="overview-modal"'), 'index.html 应包含全校总览按钮与弹窗');
  assert(indexHtml.includes('id="guide-banner"') && indexHtml.includes('id="map-locate"'), 'index.html 应包含附近寻桩按钮与导引浮层');

  const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
  assert(swSrc.includes('./js/recommend.js'), 'sw.js 离线预缓存列表应包含 ./js/recommend.js');

  const fallbackPath = path.join(ROOT, 'js', 'file-fallback.js');
  assert(fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).size > 100000, 'js/file-fallback.js 必须存在且包含完整回退包');
  assert(indexHtml.includes('js/file-fallback.js'), 'index.html 应在 file:// 协议下自动挂载 js/file-fallback.js');
});

console.log('='.repeat(60));
if (failed === 0) {
  console.log(`ALL TESTS PASSED! (${passed}/${passed} 项验证全部通过)`);
  console.log('='.repeat(60));
  process.exit(0);
} else {
  console.error(`TESTS FAILED: ${failed} 项失败`);
  console.log('='.repeat(60));
  process.exit(1);
}

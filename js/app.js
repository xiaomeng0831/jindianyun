/**
 * 津电云 · 应用入口
 * ------------------------------------------------------------------
 * 零构建 ES 模块：直接由 index.html 中的
 *   <script type="module" src="js/app.js"></script>
 * 加载。负责把 MapView（地图）与 MockAdapter（实时数据）接起来，
 * 渲染站点列表 / 搜索结果，并在选中时打开详情面板。
 *
 * 与其它模块的约定：
 *   map.js     → export class MapView(canvas, { stations, onSelect })
 *                可选方法：setStations / setSelected / focusStation / resize
 *   mock-adapter.js → export function createMockAdapter(stations)
 *                返回：getStationDetail(id) | getDetail(id) | getState(id)
 *                      subscribe(fn) / refresh() / updatedAt
 * 以上缺失的成员会被安全降级（见下方 callFirst / readDetail）。
 */

import { MapView } from './map.js';
import { loadBasemap } from './basemap.js';
import { createMockAdapter, computeHourlyTrend } from './mock-adapter.js';
import { createHttpAdapter } from './http-adapter.js';
import { createStationPanel, summarizeStation, escapeHtml } from './panel.js';
import {
  recommendStations, computeCampusOverview, parseStationHash,
  resolveCampusOrigin, CAMPUS_CENTER,
} from './recommend.js';
import { mountChatWidget } from './chat.js';

const STATIONS_URL = new URL('../data/stations.json', import.meta.url);
const BASEMAP_URL = new URL('../data/basemap.json', import.meta.url);
const TYPE_TEXT = { bike: '电动自行车', car: '电动汽车' };
const FAVORITES_KEY = 'jindianyun:favorites';
const ADAPTER_CONFIG_KEY = 'jindianyun:adapter_config';
const DEFAULT_HTTP_ENDPOINT = 'http://localhost:8787/api/charging/status';

const state = {
  stations: [],
  byId: new Map(),
  adapter: null,
  unsubscribeAdapter: null,
  adapterMode: 'mock',
  adapterEndpoint: DEFAULT_HTTP_ENDPOINT,
  mapView: null,
  panel: null,
  selectedId: null,
  query: '',
  results: [],
  activeIndex: -1,
  resultsEl: null,
  searchInput: null,
  refreshing: false,
  buildings: [],
  filter: 'all',
  favorites: new Set(),
  guideOrigin: null,
  guideCandidates: [],
  guideActiveId: null,
  liveMode: 'live',
};

/* ---------------------------------------------------------------- 启动 */

boot().catch((error) => {
  console.error('[津电云] 启动失败', error);
  hideLoading(true);
  showFatalError(error);
});

async function boot() {
  const canvas = document.getElementById('map');
  const panelRoot = document.getElementById('panel');
  if (!canvas) throw new Error('页面缺少 <canvas id="map">');
  if (!panelRoot) throw new Error('页面缺少 <aside id="panel">');

  // 底图失败不应拖垮站点列表：两边并行加载，只有站点数据失败才中断启动。
  const [stationsResult, basemapResult] = await Promise.allSettled([
    loadStations(),
    loadBasemap(BASEMAP_URL),
  ]);
  if (stationsResult.status === 'rejected') {
    throw resourceError(stationsResult.reason, 'data/stations.json', '站点数据加载失败');
  }
  const stations = stationsResult.value;
  let basemap = null;
  let basemapError = null;
  if (basemapResult.status === 'rejected') {
    basemapError = resourceError(basemapResult.reason, 'data/basemap.json', '底图加载失败');
    console.error('[津电云] 底图加载失败', basemapError);
  } else {
    basemap = basemapResult.value;
  }

  state.stations = stations;
  state.byId = new Map(stations.map((station) => [station.id, station]));
  state.buildings = buildBuildingIndex(basemap);
  loadFavorites();
  syncFavoritesToStations();

  loadAdapterConfig();
  state.adapter = createAdapter(stations);
  applyOccupancyToStations();

  state.panel = createStationPanel(panelRoot, {
    onClose: handlePanelClose,
    onRefresh: handleRefresh,
    onToggleFavorite: toggleFavorite,
    isFavorite: (id) => state.favorites.has(id),
  });

  try {
    state.mapView = createMap(canvas, basemapForMap(basemap, getVisibleStations()), getVisibleStations());
    state.mapView.bindControls({
      zoomIn: '#map-zoom-in',
      zoomOut: '#map-zoom-out',
      reset: '#map-reset',
    });
  } catch (error) {
    console.error('[津电云] 地图初始化失败', error);
    if (!basemapError) showMapNotice(error);
  }
  if (basemapError) showMapNotice(basemapError);

  setupFilters();
  setupOverviewModal();
  setupGuideAndLocate();
  setupSearch();
  populateLegend();
  subscribeAdapter();
  setupGlobalHandlers();
  restoreFromHash();
  try {
    mountChatWidget(document.getElementById('chat-widget'), {
      getContext: buildChatContext,
      localReply: answerChatLocally,
    });
  } catch (error) {
    console.error('[津电云] 助手初始化失败', error);
  }
  document.body.classList.add('app-ready');
  hideLoading();
  registerServiceWorker();
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator && (location.protocol === 'http:' || location.protocol === 'https:')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        console.debug('[津电云] ServiceWorker 注册跳过', err);
      });
    });
  }
}

/**
 * 本地实时事实问答引擎：当远端问答接口被 CORS 拦截（如 file:// 或 localhost）
 * 或远端模型缺少实时状态时，直接根据当前页面内存中的站点、楼宇与空闲统计生成精准回答。
 */
function answerChatLocally(rawQuestion) {
  const q = String(rawQuestion || '').trim();
  const ov = computeCampusOverview(state.stations, summarizeStation, readDetail);

  // 1. 地图用法与帮助类问题
  if (/怎么用|怎么使用|用法|指南|颜色|筛选|搜索|功能/.test(q)) {
    return [
      '**津电云地图使用指南：**',
      '1. **看颜色识空闲**：绿色图钉代表空闲充裕，橙色代表较满，红色代表接近满载；圆形为电动自行车桩，圆角方形为电动汽车桩，带 `柜` 角标表示配有锂电换电柜。',
      '2. **搜楼宇自动导引**：在顶部搜索框输入任意教学楼或宿舍（如 `38教学楼`、`郑东图书馆`），地图会自动画出到最近空闲充电站的**彩色虚线导引路径**并估算步行耗时。',
      '3. **全校总览与筛选**：点击顶部 `📊 全校总览` 可查看空闲 Top 5 排行榜与切换数据源；点击右下角 `📍` 可一键定位推荐附近空闲桩。',
    ].join('\n');
  }

  // 2. 锂电柜 / 换电类问题
  if (/锂电|换电|电池柜|电柜/.test(q)) {
    const cabStations = state.stations.filter((s) => Number(s.cabinets) > 0);
    const lines = cabStations.map((s) => {
      const detail = readDetail(s.id);
      const sum = summarizeStation(s, detail);
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
    const carStations = state.stations.filter((s) => s.type === 'car');
    const lines = carStations.map((s) => {
      const detail = readDetail(s.id);
      const sum = summarizeStation(s, detail);
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
    const matchedStations = state.stations.filter((s) => s.name.includes(cleanQ) || cleanQ.includes(s.name));
    if (matchedStations.length > 0) {
      const lines = matchedStations.map((s) => {
        const sum = summarizeStation(s, readDetail(s.id));
        const cab = Number(s.cabinets) > 0 ? `，含 ${s.cabinets} 组锂电柜` : '';
        return `- **${s.name}**（${TYPE_TEXT[s.type]}）：当前空闲 **${sum.idle}/${sum.total}** 口（使用中 ${sum.charging} 口${cab}）`;
      });
      const origin = { lon: matchedStations[0].lon, lat: matchedStations[0].lat, name: matchedStations[0].name };
      const nearby = recommendStations(origin, state.stations, summarizeStation, readDetail, { limit: 3 });
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

    const matchedBuilding = state.buildings.find((b) => b.name.includes(cleanQ) || cleanQ.includes(b.name));
    if (matchedBuilding) {
      const recs = recommendStations(matchedBuilding, state.stations, summarizeStation, readDetail, { limit: 3 });
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
    `${idx + 1}. **${it.station.name}**（${TYPE_TEXT[it.station.type]}）：空闲 **${it.idle}/${it.total}** 口`
  ));
  const crowdedNames = ov.topCrowded.slice(0, 3).map((it) => (
    `**${it.station.name}**（余 ${it.idle} 口）`
  )).join('、');

  return [
    `当前全校 **${ov.totalStations}** 个站点共有空闲插口 **${ov.totalIdle}/${ov.totalSockets}** 个（电动自行车空闲 ${ov.bike.idle}/${ov.bike.sockets}，汽车空闲 ${ov.car.idle}/${ov.car.sockets}，总占用率 ${ov.occupancyRate}%）。`,
    '',
    '**🟢 目前空闲最充裕的站点 Top 5：**',
    ...topIdleLines,
    '',
    `🟠 当前较满站点：${crowdedNames}，建议错峰或前往上方空闲站点。`,
  ].join('\n');
}

/** 当前内存中的站点名称与插口统计，供助手接口的 context 字段使用。 */
function buildChatContext() {
  const stations = state.stations;
  if (!stations.length) return '';

  let idle = 0;
  let charging = 0;
  let fault = 0;
  let known = 0;
  let bike = 0;
  let car = 0;
  const parts = [];

  for (const station of stations) {
    const type = station.type === 'car' ? '汽车' : '自行车';
    if (station.type === 'car') car += 1;
    else bike += 1;
    const cabinet = Number(station.cabinets) > 0 ? `，锂电柜${station.cabinets}` : '';
    const detail = readDetail(station.id);
    const summary = detail ? summarizeStation(station, detail) : null;
    if (summary?.known) {
      known += 1;
      idle += summary.idle;
      charging += summary.charging;
      fault += summary.fault;
      parts.push(`${station.name}（${type}，空闲${summary.idle}/占用${summary.charging}/故障${summary.fault}${cabinet}）`);
    } else {
      const sockets = Number.isFinite(Number(station.sockets)) ? Number(station.sockets) : '?';
      parts.push(`${station.name}（${type}，插口${sockets}，状态未知${cabinet}）`);
    }
  }

  const head = `北洋园校区当前已加载${stations.length}个充电站（自行车${bike}，汽车${car}）。`
    + (known
      ? `其中${known}个站有插口统计：空闲${idle}，占用${charging}，故障${fault}。`
      : '暂无插口统计。');
  let text = `${head}站点：${parts.join('；')}。以上为页面当前内存中的数据，可能是模拟数据，实际以地图显示为准。`;
  if (text.length > 1800) text = `${text.slice(0, 1799)}…`;
  return text;
}

function hideLoading(immediate = false) {
  const overlay = document.getElementById('app-loading');
  if (!overlay) return;
  overlay.classList.add('is-hidden');
  if (immediate) {
    overlay.remove();
    return;
  }
  window.setTimeout(() => overlay.remove(), 450);
}

async function loadStations() {
  const response = await fetch(STATIONS_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`站点数据加载失败（HTTP ${response.status}）`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('站点数据格式不正确');
  return data.filter((station) => (
    station && typeof station.id === 'string'
    && Number.isFinite(station.lon) && Number.isFinite(station.lat)
  ));
}

/* -------------------------------------------------------------- 地图桥接 */

function createMap(canvas, basemap, stations) {
  const onSelect = (id, station) => {
    if (id == null || !station) {
      if (state.panel?.isOpen) state.panel.close();
      return;
    }
    const resolved = resolveStation(station) || resolveStation(id);
    if (resolved) selectStation(resolved);
  };
  return new MapView(canvas, basemap, stations, { onSelect });
}

function resolveStation(value) {
  if (!value) return null;
  if (typeof value === 'string') return state.byId.get(value) || null;
  if (typeof value === 'object') {
    if (value.station && typeof value.station === 'object') return resolveStation(value.station);
    if (value.id && state.byId.has(value.id)) return state.byId.get(value.id);
    if (value.properties?.id && state.byId.has(value.properties.id)) return state.byId.get(value.properties.id);
    if (value.id) return value;
  }
  return null;
}

function callFirst(target, names, ...args) {
  if (!target) return undefined;
  for (const name of names) {
    const fn = target[name];
    if (typeof fn !== 'function') continue;
    try { return fn.apply(target, args); } catch { /* 尝试下一个方法名 */ }
  }
  return undefined;
}

function selectStation(stationLike, options = {}) {
  const station = resolveStation(stationLike);
  if (!station) return;
  if (!options.force && state.selectedId === station.id && state.panel?.isOpen) {
    closeResults();
    return;
  }

  // 若选中的站点不在当前筛选范围内，自动切回「全部」以确保图钉可见
  if (state.filter !== 'all' && !matchesFilter(station, state.filter)) {
    setFilter('all', { silentSelect: true });
  }

  state.selectedId = station.id;
  const detail = readDetail(station.id);
  const liveMode = currentLiveMode(station.id);
  state.liveMode = liveMode;
  state.panel.open(station, detail, { updatedAt: readUpdatedAt(detail), liveMode });

  if (state.mapView) {
    const focused = callFirst(
      state.mapView,
      ['focusStation', 'focusOnStation', 'flyToStation', 'centerOnStation'],
      station.id,
    );
    if (focused === undefined) {
      callFirst(state.mapView, ['focus', 'flyTo', 'panTo', 'centerOn'], station.lon, station.lat);
    }
    callFirst(state.mapView, ['setSelected', 'selectStation', 'highlightStation', 'setSelection'], station.id);
  }

  closeResults();
  updateHash(station.id);
}

function handlePanelClose() {
  state.selectedId = null;
  updateHash(null);
  const map = state.mapView;
  if (map) {
    callFirst(map, ['clearSelection', 'clearSelected', 'deselect'], undefined);
    callFirst(map, ['setSelected', 'setSelection'], null);
  }
}

/* ------------------------------------------------------------ 适配器桥接 */

function loadAdapterConfig() {
  try {
    const raw = localStorage.getItem(ADAPTER_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.mode === 'http' || parsed.mode === 'mock') state.adapterMode = parsed.mode;
      if (typeof parsed.endpoint === 'string' && parsed.endpoint.trim()) {
        state.adapterEndpoint = parsed.endpoint.trim();
      }
    }
  } catch { /* 隐私模式忽略 */ }

  try {
    const params = new URLSearchParams(location.search);
    const mode = params.get('adapter') || window.JINDIANYUN_CONFIG?.adapter;
    const endpoint = params.get('endpoint') || window.JINDIANYUN_CONFIG?.endpoint;
    if (mode === 'http' || endpoint) {
      state.adapterMode = 'http';
      if (endpoint) state.adapterEndpoint = endpoint;
    } else if (mode === 'mock') {
      state.adapterMode = 'mock';
    }
  } catch { /* 忽略 URL 解析异常 */ }
  syncFooterModeLabel();
}

function saveAdapterConfig(mode, endpoint) {
  state.adapterMode = mode === 'http' ? 'http' : 'mock';
  if (typeof endpoint === 'string' && endpoint.trim()) {
    state.adapterEndpoint = endpoint.trim();
  }
  try {
    localStorage.setItem(ADAPTER_CONFIG_KEY, JSON.stringify({
      mode: state.adapterMode,
      endpoint: state.adapterEndpoint,
    }));
  } catch { /* 忽略 */ }
  syncFooterModeLabel();
}

function syncFooterModeLabel() {
  const el = document.getElementById('footer-mode-label');
  if (!el) return;
  el.textContent = state.adapterMode === 'http' ? '实时代理（含模拟兜底）' : '模拟数据';
}

function createAdapter(stations) {
  let mock = null;
  const attempts = [
    () => createMockAdapter(stations),
    () => createMockAdapter({ stations }),
    () => createMockAdapter(),
  ];

  for (const attempt of attempts) {
    try {
      const adapter = attempt();
      if (!adapter || typeof adapter !== 'object') continue;
      if (probeAdapter(adapter)) {
        mock = adapter;
        break;
      }
      if (!mock) mock = adapter;
    } catch { /* 尝试下一种签名 */ }
  }
  const fallback = mock || createFallbackAdapter(stations);

  if (state.adapterMode === 'http') {
    return createHttpAdapter(stations, {
      endpoint: state.adapterEndpoint || DEFAULT_HTTP_ENDPOINT,
      fallbackAdapter: fallback,
    });
  }

  return fallback;
}

function switchAdapterMode(mode, endpoint) {
  if (state.unsubscribeAdapter) {
    try { state.unsubscribeAdapter(); } catch { /* 忽略 */ }
    state.unsubscribeAdapter = null;
  }
  if (state.adapter && typeof state.adapter.stop === 'function') {
    try { state.adapter.stop(); } catch { /* 忽略 */ }
  }
  saveAdapterConfig(mode, endpoint);
  detailCache.clear();
  state.adapter = createAdapter(state.stations);
  subscribeAdapter();
  handleAdapterUpdate();
  showAppToast(state.adapterMode === 'http' ? '已切换至 HTTP 实时代理数据源' : '已切换至本地确定性模拟数据源');
}

function probeAdapter(adapter) {
  return [
    'getStationDetail', 'getDetail', 'getStationState', 'getState', 'getSnapshot',
  ].some((name) => typeof adapter[name] === 'function');
}

const detailCache = new Map();
const pendingDetails = new Map();
let pendingSnapshot = null;

function readDetail(stationId) {
  const adapter = state.adapter;
  if (!adapter) return detailCache.get(stationId) || null;
  if (detailCache.has(stationId)) return detailCache.get(stationId);

  const consume = (raw) => {
    if (raw === undefined || raw === null) return null;
    if (typeof raw.then === 'function') {
      trackDetailPromise(stationId, raw);
      return null;
    }
    const detail = normalizeDetail(raw, stationId);
    if (detail) detailCache.set(stationId, detail);
    return detail;
  };

  try {
    if (typeof adapter.getStationDetail === 'function') {
      const value = consume(adapter.getStationDetail(stationId));
      if (value) return value;
    }
    if (typeof adapter.getDetail === 'function') {
      const value = consume(adapter.getDetail(stationId));
      if (value) return value;
    }
    if (typeof adapter.getSnapshot === 'function') {
      const snapshot = adapter.getSnapshot();
      if (snapshot && typeof snapshot.then === 'function') {
        trackSnapshotPromise(snapshot);
      } else if (snapshot && typeof snapshot === 'object') {
        const value = consume(snapshot[stationId]);
        if (value) return value;
      }
    }
    for (const name of ['getStationState', 'getState']) {
      const fn = adapter[name];
      if (typeof fn !== 'function') continue;
      const value = consume(fn.call(adapter, stationId));
      if (value) return value;
    }
  } catch { /* 继续尝试其它读取方式 */ }

  const store = adapter.states || adapter.data || adapter.details;
  if (store && typeof store === 'object') {
    const value = store[stationId] ?? store.byId?.[stationId];
    const detail = consume(value);
    if (detail) return detail;
  }
  return detailCache.get(stationId) || null;
}

function trackDetailPromise(stationId, promise) {
  if (pendingDetails.has(stationId)) return;
  const tracked = Promise.resolve(promise).then((raw) => {
    pendingDetails.delete(stationId);
    const detail = normalizeDetail(raw, stationId);
    if (!detail) return;
    detailCache.set(stationId, detail);
    applySingleDetail(stationId, detail);
  }).catch(() => {
    pendingDetails.delete(stationId);
  });
  pendingDetails.set(stationId, tracked);
}

function trackSnapshotPromise(promise) {
  if (pendingSnapshot) return;
  pendingSnapshot = Promise.resolve(promise).then((snapshot) => {
    pendingSnapshot = null;
    if (!snapshot || typeof snapshot !== 'object') return;
    for (const [id, raw] of Object.entries(snapshot)) {
      const detail = normalizeDetail(raw, id);
      if (detail) detailCache.set(id, detail);
    }
    const selected = state.selectedId;
    if (selected && detailCache.has(selected) && state.panel) {
      const detail = detailCache.get(selected);
      state.panel.setDetail(detail, { updatedAt: readUpdatedAt(detail) });
    }
  }).catch(() => {
    pendingSnapshot = null;
  });
}

function applySingleDetail(stationId, detail) {
  const station = state.byId.get(stationId);
  if (!station) return;
  const summary = summarizeStation(station, detail);
  if (summary.total) {
    station.occupied = summary.charging;
    station.occupancy = summary.charging / summary.total;
    callFirst(state.mapView, ['updateStation'], stationId, {
      occupied: station.occupied,
      occupancy: station.occupancy,
    });
  }
  if (state.selectedId === stationId && state.panel) {
    state.panel.setDetail(detail, { updatedAt: readUpdatedAt(detail) });
  }
  if (state.resultsEl && !state.resultsEl.hidden) {
    renderResults(state.query, { preserveActive: true });
  }
}

function normalizeDetail(value, stationId) {
  if (value == null) return null;
  const detail = Array.isArray(value) ? { sockets: value } : (typeof value === 'object' ? value : null);
  if (!detail) return null;
  if (!Array.isArray(detail.hourlyTrend) && stationId) {
    const station = state.byId.get(stationId);
    if (station) detail.hourlyTrend = computeHourlyTrend(station);
  }
  return detail;
}

function readUpdatedAt(detail) {
  const adapter = state.adapter;
  return detail?.updatedAt
    ?? adapter?.updatedAt
    ?? adapter?.lastUpdated
    ?? Date.now();
}

/** 把实时占用情况写回站点对象，供地图图钉按占用比例着色，并同步全校总览数字。 */
function applyOccupancyToStations() {
  for (const station of state.stations) {
    const detail = readDetail(station.id);
    if (!detail) continue;
    const summary = summarizeStation(station, detail);
    if (!summary.total) continue;
    station.occupied = summary.charging;
    station.occupancy = summary.charging / summary.total;
  }
  updateOverviewBadge();
}

function updateOverviewBadge() {
  const badge = document.getElementById('overview-idle-badge');
  if (!badge) return;
  const ov = computeCampusOverview(state.stations, summarizeStation, readDetail);
  badge.textContent = `空闲 ${ov.totalIdle}/${ov.totalSockets}`;
}

function subscribeAdapter() {
  const adapter = state.adapter;
  if (!adapter) return;
  const onChange = (payload) => handleAdapterUpdate(payload);

  if (typeof adapter.subscribe === 'function') {
    try {
      state.unsubscribeAdapter = adapter.subscribe(onChange);
      return;
    } catch { /* 继续 */ }
  }
  if (typeof adapter.onUpdate === 'function') {
    try { adapter.onUpdate(onChange); return; } catch { /* 继续 */ }
  }
  if (typeof adapter.on === 'function') {
    try { adapter.on('update', onChange); return; } catch { /* 继续 */ }
    try { adapter.on('change', onChange); return; } catch { /* 继续 */ }
  }
  // 无订阅能力时轮询，保证面板与列表不会停留在旧数据
  const timerId = window.setInterval(() => handleAdapterUpdate(), 5000);
  state.unsubscribeAdapter = () => window.clearInterval(timerId);
}

function handleAdapterUpdate() {
  detailCache.clear();
  applyOccupancyToStations();
  callFirst(state.mapView, ['setStations'], getVisibleStations());

  const stationId = state.selectedId;
  const liveMode = currentLiveMode(stationId);
  state.liveMode = liveMode;
  if (stationId && state.panel) {
    const detail = readDetail(stationId);
    if (detail) {
      state.panel.setDetail(detail, { updatedAt: readUpdatedAt(detail), liveMode });
    } else if (typeof state.panel.setLiveMode === 'function') {
      state.panel.setLiveMode(liveMode);
    }
  } else if (typeof state.panel?.setLiveMode === 'function') {
    state.panel.setLiveMode(liveMode);
  }
  if (state.guideOrigin) {
    refreshGuideCandidates();
  }
  const modal = document.getElementById('overview-modal');
  if (modal && !modal.hidden) {
    renderOverviewModal();
  }
  if (state.refreshing) {
    state.refreshing = false;
    state.panel.setRefreshing(false);
  }
  if (state.resultsEl && !state.resultsEl.hidden) {
    renderResults(state.query, { preserveActive: true });
  }
}

function handleRefresh(stationId) {
  state.refreshing = true;
  state.panel.setRefreshing(true);
  if (stationId) detailCache.delete(stationId);
  else detailCache.clear();

  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    const id = stationId || state.selectedId;
    const liveMode = currentLiveMode(id);
    state.liveMode = liveMode;
    state.refreshing = false;
    state.panel.setRefreshing(false);
    if (id) {
      const detail = readDetail(id);
      if (detail) {
        state.panel.setDetail(detail, { updatedAt: readUpdatedAt(detail), liveMode });
      } else if (typeof state.panel.setLiveMode === 'function') {
        state.panel.setLiveMode(liveMode);
      }
    }
    if (state.resultsEl && !state.resultsEl.hidden) {
      renderResults(state.query, { preserveActive: true });
    }
  };

  const result = callFirst(state.adapter, ['refresh', 'tick', 'update', 'simulate', 'step'], stationId);
  if (result && typeof result.then === 'function') {
    result.then(finish, finish);
    window.setTimeout(finish, 2000);
  } else {
    window.setTimeout(finish, 320);
  }
}

/* ---------------------------------------------------------------- 搜索 */

function setupSearch() {
  const header = document.querySelector('.site-header') || document.querySelector('header');
  let input = document.getElementById('search-input')
    || document.querySelector('.site-header input[type="search"], header input[type="search"], #search');

  if (!input && header) {
    const box = document.createElement('div');
    box.className = 'search-box';
    input = document.createElement('input');
    input.type = 'search';
    box.appendChild(input);
    header.appendChild(box);
  }
  if (!input) return;

  const form = document.getElementById('search-form') || input.closest('form');
  if (form) form.addEventListener('submit', (event) => event.preventDefault());

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', 'search-results');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('autocomplete', 'off');
  if (!input.placeholder) input.placeholder = '搜索宿舍楼、餐厅或站点';
  state.searchInput = input;

  const clearBtn = document.getElementById('search-clear');
  const toggleClear = () => {
    if (clearBtn) clearBtn.hidden = !input.value;
  };
  toggleClear();
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      toggleClear();
      closeResults();
    });
  }

  let results = document.getElementById('search-results');
  if (!results) {
    results = document.createElement('div');
    results.id = 'search-results';
    results.className = 'search-results';
    results.setAttribute('role', 'listbox');
    results.setAttribute('aria-label', '站点搜索结果');
  }
  results.classList.add('search-results');
  if (!results.getAttribute('role')) results.setAttribute('role', 'listbox');
  if (!results.getAttribute('aria-label')) results.setAttribute('aria-label', '站点搜索结果');
  results.hidden = true;
  if (results.parentElement !== document.body) document.body.appendChild(results);
  state.resultsEl = results;

  input.addEventListener('focus', () => openResults(input.value));
  input.addEventListener('input', () => {
    toggleClear();
    openResults(input.value);
  });
  input.addEventListener('keydown', handleSearchKeydown);

  results.addEventListener('mousedown', (event) => event.preventDefault());
  results.addEventListener('click', (event) => {
    const item = event.target.closest('.search-item');
    if (!item) return;
    const station = state.byId.get(item.dataset.id);
    if (item.dataset.building) {
      const building = state.buildings.find((b) => b.name === item.dataset.building);
      if (!building) return;
      input.value = '';
      toggleClear();
      input.blur();
      focusBuilding(building);
      return;
    }
    if (!station) return;
    input.value = '';
    toggleClear();
    input.blur();
    selectStation(station);
  });
  results.addEventListener('mousemove', (event) => {
    const item = event.target.closest('.search-item');
    if (!item) return;
    const index = Number(item.dataset.index);
    if (Number.isFinite(index) && index !== state.activeIndex) {
      state.activeIndex = index;
      syncActiveOption();
    }
  });

  document.addEventListener('pointerdown', (event) => {
    if (results.hidden) return;
    if (input.contains(event.target) || results.contains(event.target)) return;
    closeResults();
  });
  window.addEventListener('resize', () => { if (!results.hidden) positionResults(); });
  window.addEventListener('scroll', () => { if (!results.hidden) positionResults(); }, true);
}

/* ---------------------------------------------------------- 收藏与筛选 */

function loadFavorites() {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      state.favorites = new Set(arr.filter((id) => typeof id === 'string' && state.byId.has(id)));
    }
  } catch { /* 隐私模式忽略 */ }
}

function saveFavorites() {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...state.favorites]));
  } catch { /* 隐私模式忽略 */ }
}

function syncFavoritesToStations() {
  for (const station of state.stations) {
    station.favorite = state.favorites.has(station.id);
  }
}

function toggleFavorite(stationId) {
  if (!stationId || !state.byId.has(stationId)) return;
  if (state.favorites.has(stationId)) state.favorites.delete(stationId);
  else state.favorites.add(stationId);
  saveFavorites();
  syncFavoritesToStations();
  updateFilterCounts();
  callFirst(state.mapView, ['setStations'], getVisibleStations());
  if (state.resultsEl && !state.resultsEl.hidden) {
    renderResults(state.query, { preserveActive: true });
  }
}

function matchesFilter(station, filter = state.filter) {
  if (!station) return false;
  switch (filter) {
    case 'bike': return station.type === 'bike';
    case 'car': return station.type === 'car';
    case 'cabinet': return (Number(station.cabinets) || 0) > 0;
    case 'fav': return state.favorites.has(station.id);
    default: return true;
  }
}

function getVisibleStations() {
  if (state.filter === 'all') return state.stations;
  return state.stations.filter((station) => matchesFilter(station, state.filter));
}

function updateFilterCounts() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  const counts = {
    all: state.stations.length,
    bike: state.stations.filter((s) => s.type === 'bike').length,
    car: state.stations.filter((s) => s.type === 'car').length,
    cabinet: state.stations.filter((s) => (Number(s.cabinets) || 0) > 0).length,
    fav: state.favorites.size,
  };
  for (const [key, val] of Object.entries(counts)) {
    const el = bar.querySelector(`[data-count="${key}"]`);
    if (el) el.textContent = String(val);
  }
  updateFilterScrollHint();
}

function setFilter(next, opts = {}) {
  state.filter = next || 'all';
  const bar = document.getElementById('filter-bar');
  if (bar) {
    bar.querySelectorAll('.filter-chip').forEach((btn) => {
      const active = btn.dataset.filter === state.filter;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }
  const visible = getVisibleStations();
  callFirst(state.mapView, ['setStations'], visible);
  if (!opts.silentSelect && state.selectedId && !visible.some((s) => s.id === state.selectedId)) {
    if (state.panel?.isOpen) state.panel.close();
  }
  if (state.resultsEl && !state.resultsEl.hidden) {
    renderResults(state.query);
  }
}

function setupFilters() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  updateFilterCounts();
  bar.addEventListener('click', (event) => {
    const chip = event.target.closest('.filter-chip[data-filter]');
    if (!chip) return;
    const next = chip.dataset.filter || 'all';
    setFilter(next === state.filter && next !== 'all' ? 'all' : next);
  });
  bar.addEventListener('scroll', updateFilterScrollHint, { passive: true });
  window.addEventListener('resize', updateFilterScrollHint);
  requestAnimationFrame(updateFilterScrollHint);
}

/** 窄屏横滑时给右侧加渐隐，提示后面还有筛选项。 */
function updateFilterScrollHint() {
  const bar = document.getElementById('filter-bar');
  if (!bar) return;
  const overflows = bar.scrollWidth - bar.clientWidth > 4;
  bar.classList.toggle('can-scroll', overflows);
  const atEnd = !overflows || bar.scrollLeft + bar.clientWidth >= bar.scrollWidth - 4;
  bar.classList.toggle('is-scrolled-end', atEnd);
}

function openResults(query) {
  state.query = query;
  state.activeIndex = 0;
  renderResults(query);
}

function renderResults(query, options = {}) {
  const resultsEl = state.resultsEl;
  const input = state.searchInput;
  if (!resultsEl) return;

  if (!options.preserveActive) state.activeIndex = 0;
  const q = String(query || '').trim().toLowerCase();
  const basePool = q ? state.stations : getVisibleStations();
  const matches = basePool.filter((station) => {
    if (!q) return true;
    const haystack = `${station.name} ${station.id} ${station.note || ''} ${TYPE_TEXT[station.type] || ''}`.toLowerCase();
    return haystack.includes(q);
  });

  // 无关键词且处于全部/非仅收藏筛选时，把已收藏站点排在最前（常用收藏组）
  let orderedStations = matches;
  if (!q && state.filter !== 'fav' && state.favorites.size > 0) {
    const favList = matches
      .filter((s) => state.favorites.has(s.id))
      .map((s) => ({ ...s, _group: '★ 常用收藏' }));
    const restList = matches.filter((s) => !state.favorites.has(s.id));
    orderedStations = favList.concat(restList);
  }

  // 楼宇结果：仅在有关键词时追加，最多 6 条，排在站点之后
  const buildingMatches = q ? searchBuildings(q, 6) : [];
  state.results = orderedStations.concat(buildingMatches);

  const listMode = resultsEl.tagName === 'UL';
  const groupTag = listMode ? 'li' : 'div';
  const itemTag = listMode ? 'li' : 'button';
  const itemAttrs = listMode ? 'tabindex="-1"' : 'type="button"';

  if (!state.results.length) {
    const emptyMsg = !q && state.filter === 'fav'
      ? '尚未收藏常用站点，点击站点详情右上角的 ★ 即可收藏'
      : `没有找到与「${escapeHtml(query)}」匹配的站点或楼宇`;
    resultsEl.innerHTML = `<${groupTag} class="search-empty" role="presentation">${emptyMsg}</${groupTag}>`;
    state.activeIndex = -1;
  } else {
    if (state.activeIndex >= state.results.length) state.activeIndex = state.results.length - 1;
    let previousGroup = null;
    let html = '';
    state.results.forEach((station, index) => {
      if (station.kind === 'building') {
        if (previousGroup !== '__building') {
          previousGroup = '__building';
          html += `<${groupTag} class="search-group" role="presentation">楼宇</${groupTag}>`;
        }
        html += `
        <${itemTag} ${itemAttrs} class="search-item search-item-building" role="option" id="search-option-${index}"
          data-building="${escapeHtml(station.name)}" data-index="${index}" aria-selected="false">
          <span class="search-item-main">
            <span class="search-item-name">${highlightMatch(station.name, q)}</span>
            <span class="search-item-meta">寻最近空闲桩 · 地图导引</span>
          </span>
        </${itemTag}>`;
        return;
      }
      const groupName = station._group || TYPE_TEXT[station.type] || '充电站';
      if (groupName !== previousGroup) {
        previousGroup = groupName;
        html += `<${groupTag} class="search-group" role="presentation">${escapeHtml(groupName)}</${groupTag}>`;
      }
      const live = liveInfoFor(station);
      const socketLabel = station.sockets > 0
        ? (station.socketsApprox ? ` · 约 ${station.sockets} 口` : ` · ${station.sockets} 口`)
        : ' · 插口待采集';
      const cabinetLabel = (Number(station.cabinets) || 0) > 0 ? ` · ${station.cabinets} 柜` : '';
      const meta = `${TYPE_TEXT[station.type] || '充电站'}${socketLabel}${cabinetLabel}`;
      const favStar = state.favorites.has(station.id) ? '<span class="search-fav-star" aria-hidden="true">★</span>' : '';
      html += `
        <${itemTag} ${itemAttrs} class="search-item" role="option" id="search-option-${index}"
          data-id="${escapeHtml(station.id)}" data-index="${index}" aria-selected="false">
          <span class="search-item-main">
            <span class="search-item-name">${favStar}${highlightMatch(station.name, q)}</span>
            <span class="search-item-meta">${escapeHtml(meta)}</span>
          </span>
          <span class="search-item-live live-${live.tone}">
            <i class="mini-dot" aria-hidden="true"></i>${escapeHtml(live.text)}
          </span>
        </${itemTag}>`;
    });
    resultsEl.innerHTML = html;
  }

  resultsEl.hidden = false;
  if (input) input.setAttribute('aria-expanded', 'true');
  positionResults();
  syncActiveOption();
}

/* ------------------------------------------------------------ 楼宇搜索 */

/**
 * 从底图建筑多边形建立可搜索索引：同名多边形的两翼合并成一个条目，
 * 位置取所有顶点的平均（近似中心）。
 */
function buildBuildingIndex(basemap) {
  const groups = new Map();
  for (const b of basemap?.buildings || []) {
    const name = (b.name || '').trim();
    if (!name || !Array.isArray(b.poly) || !b.poly.length) continue;
    let g = groups.get(name);
    if (!g) { g = { name, lon: 0, lat: 0, n: 0 }; groups.set(name, g); }
    for (const [lon, lat] of b.poly) { g.lon += lon; g.lat += lat; g.n += 1; }
  }
  return [...groups.values()].map((g) => ({ name: g.name, lon: g.lon / g.n, lat: g.lat / g.n }));
}

/** 按名称子串匹配楼宇，前缀命中优先，最多返回 limit 条。 */
function searchBuildings(q, limit) {
  const hits = [];
  for (const b of state.buildings) {
    const name = b.name.toLowerCase();
    const idx = name.indexOf(q);
    if (idx === -1) continue;
    hits.push({ b, rank: idx === 0 ? 0 : 1 });
  }
  hits.sort((x, y) => x.rank - y.rank || x.b.name.length - y.b.name.length);
  return hits.slice(0, limit).map(({ b }) => ({ ...b, kind: 'building' }));
}

/** 把地图移到某栋楼，并自动推荐该楼宇附近的空闲充电桩与绘制导引线。 */
function focusBuilding(building) {
  closeResults();
  startGuideFromOrigin({
    lon: building.lon,
    lat: building.lat,
    name: building.name,
  });
}

function handleSearchKeydown(event) {
  const resultsEl = state.resultsEl;
  if (!resultsEl) return;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (resultsEl.hidden) {
      openResults(event.currentTarget.value);
      event.preventDefault();
      return;
    }
    if (!state.results.length) return;
    event.preventDefault();
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    state.activeIndex = (state.activeIndex + delta + state.results.length) % state.results.length;
    syncActiveOption();
    return;
  }

  if (event.key === 'Enter') {
    if (resultsEl.hidden) return;
    const station = state.results[state.activeIndex];
    if (!station) return;
    event.preventDefault();
    event.currentTarget.value = '';
    const clearBtn = document.getElementById('search-clear');
    if (clearBtn) clearBtn.hidden = true;
    event.currentTarget.blur();
    if (station.kind === 'building') focusBuilding(station);
    else selectStation(station);
    return;
  }

  if (event.key === 'Escape') {
    if (!resultsEl.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeResults();
    }
  }
}

function syncActiveOption() {
  const resultsEl = state.resultsEl;
  const input = state.searchInput;
  if (!resultsEl) return;
  const items = resultsEl.querySelectorAll('.search-item');
  items.forEach((item) => {
    const isActive = Number(item.dataset.index) === state.activeIndex;
    item.classList.toggle('is-active', isActive);
    item.setAttribute('aria-selected', String(isActive));
  });
  const active = resultsEl.querySelector('.search-item.is-active');
  if (active) {
    active.scrollIntoView({ block: 'nearest' });
    if (input) input.setAttribute('aria-activedescendant', active.id);
  } else if (input) {
    input.removeAttribute('aria-activedescendant');
  }
}

function closeResults() {
  const resultsEl = state.resultsEl;
  if (!resultsEl) return;
  resultsEl.hidden = true;
  state.searchInput?.setAttribute('aria-expanded', 'false');
  state.searchInput?.removeAttribute('aria-activedescendant');
  state.activeIndex = -1;
}

function positionResults() {
  const resultsEl = state.resultsEl;
  const input = state.searchInput;
  if (!resultsEl || !input) return;
  const rect = input.getBoundingClientRect();
  const viewport = window.innerWidth;
  const width = Math.min(Math.max(rect.width, 300), viewport - 24);
  const left = Math.min(Math.max(12, rect.left), viewport - width - 12);
  resultsEl.style.width = `${width}px`;
  resultsEl.style.left = `${left}px`;
  resultsEl.style.top = `${Math.round(rect.bottom + 8)}px`;
}

function highlightMatch(text, query) {
  const source = String(text ?? '');
  if (!query) return escapeHtml(source);
  const index = source.toLowerCase().indexOf(query);
  if (index < 0) return escapeHtml(source);
  return `${escapeHtml(source.slice(0, index))}<mark>${escapeHtml(source.slice(index, index + query.length))}</mark>${escapeHtml(source.slice(index + query.length))}`;
}

function liveInfoFor(station) {
  const detail = readDetail(station.id);
  const summary = summarizeStation(station, detail);
  if (!summary.known) {
    return { text: station.sockets > 0 ? '同步中' : '待采集', tone: 'unknown' };
  }
  const tone = summary.idle > 0 ? 'idle' : (summary.charging > 0 ? 'charging' : 'fault');
  const text = summary.total ? `空闲 ${summary.idle}/${summary.total}` : '待采集';
  return { text, tone };
}

/* ---------------------------------------------------------------- 其它 */

function populateLegend() {
  const legend = document.getElementById('legend');
  if (!legend) return;
  legend.innerHTML = `
    <span class="legend-item"><i class="legend-dot is-free" aria-hidden="true"></i>空闲较多</span>
    <span class="legend-item"><i class="legend-dot is-mid" aria-hidden="true"></i>较满</span>
    <span class="legend-item"><i class="legend-dot is-full" aria-hidden="true"></i>接近满</span>
    <span class="legend-divider" aria-hidden="true"></span>
    <span class="legend-item"><i class="legend-shape is-bike" aria-hidden="true"></i>电动自行车</span>
    <span class="legend-item"><i class="legend-shape is-car" aria-hidden="true"></i>电动汽车</span>
    <span class="legend-item"><i class="legend-badge" aria-hidden="true">柜</i>锂电柜</span>`;
}

/* ---------------------------------------------------- 智能寻桩与地图导引 */

function setupGuideAndLocate() {
  const locateBtn = document.getElementById('map-locate');
  if (locateBtn) {
    locateBtn.addEventListener('click', () => handleLocateRecommend());
  }
  const banner = document.getElementById('guide-banner');
  if (banner) {
    banner.addEventListener('click', (event) => {
      if (event.target.closest('[data-guide-close]')) {
        clearGuide();
        return;
      }
      const chip = event.target.closest('.guide-item[data-guide-id]');
      if (chip) {
        activateGuideCandidate(chip.dataset.guideId);
      }
    });
  }
}

function handleLocateRecommend() {
  if (!navigator.geolocation) {
    showAppToast('浏览器不支持定位，已按校区中心（郑东图书馆）推荐附近空闲桩');
    startGuideFromOrigin(CAMPUS_CENTER);
    return;
  }
  showAppToast('正在获取位置并计算最近空闲充电桩…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const resolved = resolveCampusOrigin(
        pos.coords.longitude,
        pos.coords.latitude,
        '我的位置',
      );
      if (resolved.fallback) {
        showAppToast('当前定位不在北洋园校区内，已按郑东图书馆推荐附近空闲桩');
      } else {
        showAppToast('已为您推荐距离最近且有空位的充电站');
      }
      startGuideFromOrigin(resolved);
    },
    () => {
      showAppToast('未能获取定位权限，已按校区中心（郑东图书馆）推荐附近空闲桩');
      startGuideFromOrigin(CAMPUS_CENTER);
    },
    { enableHighAccuracy: true, timeout: 4000, maximumAge: 60000 },
  );
}

function startGuideFromOrigin(origin) {
  if (!origin || !Number.isFinite(origin.lon) || !Number.isFinite(origin.lat)) return;
  state.guideOrigin = { lon: Number(origin.lon), lat: Number(origin.lat), name: String(origin.name || '当前位置') };
  state.guideCandidates = recommendStations(
    state.guideOrigin,
    state.stations,
    summarizeStation,
    readDetail,
    { limit: 3, filter: state.filter === 'car' ? 'car' : (state.filter === 'cabinet' ? 'cabinet' : 'all') },
  );
  if (!state.guideCandidates.length) return;
  const best = state.guideCandidates[0];
  state.guideActiveId = best.station.id;
  renderGuideBanner();
  applyGuideToMap(best, true);
}

function refreshGuideCandidates() {
  if (!state.guideOrigin) return;
  state.guideCandidates = recommendStations(
    state.guideOrigin,
    state.stations,
    summarizeStation,
    readDetail,
    { limit: 3, filter: state.filter === 'car' ? 'car' : (state.filter === 'cabinet' ? 'cabinet' : 'all') },
  );
  if (!state.guideCandidates.length) {
    clearGuide();
    return;
  }
  const active = state.guideCandidates.find((c) => c.station.id === state.guideActiveId) || state.guideCandidates[0];
  state.guideActiveId = active.station.id;
  renderGuideBanner();
  applyGuideToMap(active, false);
}

function activateGuideCandidate(stationId) {
  const found = state.guideCandidates.find((c) => c.station.id === stationId);
  if (!found) return;
  state.guideActiveId = found.station.id;
  renderGuideBanner();
  applyGuideToMap(found, true);
}

function applyGuideToMap(candidate, focusViewport = false) {
  if (!candidate || !state.guideOrigin) return;
  selectStation(candidate.station, { force: true });
  const map = state.mapView;
  if (map) {
    callFirst(map, ['setGuideRoute'], state.guideOrigin, candidate.station, {
      meters: candidate.meters,
      walkMinutes: candidate.walkMinutes,
      idle: candidate.idle,
    });
    if (focusViewport) {
      callFirst(map, ['focusGuideRoute'], state.guideOrigin, candidate.station);
    }
  }
}

function renderGuideBanner() {
  const banner = document.getElementById('guide-banner');
  if (!banner) return;
  if (!state.guideOrigin || !state.guideCandidates.length) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  const itemsHtml = state.guideCandidates.map((item, idx) => {
    const active = item.station.id === state.guideActiveId;
    const rankLabel = idx === 0 ? '首选' : `备选 ${idx}`;
    return `
      <button type="button" class="guide-item${active ? ' is-active' : ''}" data-guide-id="${escapeHtml(item.station.id)}">
        <span class="guide-item-name">${rankLabel} · ${escapeHtml(item.station.name)}</span>
        <span class="guide-item-meta">约 ${item.meters}m（步行 ${item.walkMinutes} 分钟）· <span class="guide-item-idle">空闲 ${item.idle}/${item.total}</span></span>
      </button>`;
  }).join('');

  banner.innerHTML = `
    <div class="guide-head">
      <span class="guide-title">📍 从 <strong>${escapeHtml(state.guideOrigin.name)}</strong> 出发推荐最近空闲桩</span>
      <button type="button" class="guide-close" data-guide-close aria-label="关闭寻桩导引">×</button>
    </div>
    <div class="guide-list">${itemsHtml}</div>`;
  banner.hidden = false;
}

function clearGuide() {
  state.guideOrigin = null;
  state.guideCandidates = [];
  state.guideActiveId = null;
  const banner = document.getElementById('guide-banner');
  if (banner) {
    banner.hidden = true;
    banner.innerHTML = '';
  }
  if (state.mapView) {
    callFirst(state.mapView, ['clearGuideRoute']);
  }
}

/* ---------------------------------------------------- 全校总览与数据源弹窗 */

function setupOverviewModal() {
  const trigger = document.getElementById('overview-btn');
  const modal = document.getElementById('overview-modal');
  if (!trigger || !modal) return;

  trigger.addEventListener('click', () => openOverviewModal());
  modal.addEventListener('click', (event) => {
    if (event.target.closest('[data-overview-close]')) {
      closeOverviewModal();
      return;
    }
    const stationBtn = event.target.closest('[data-overview-station]');
    if (stationBtn) {
      const id = stationBtn.dataset.overviewStation;
      closeOverviewModal();
      const station = state.byId.get(id);
      if (station) selectStation(station, { force: true });
      return;
    }
    const modeBtn = event.target.closest('[data-ds-mode]');
    if (modeBtn) {
      const nextMode = modeBtn.dataset.dsMode;
      const input = document.getElementById('ds-endpoint-input');
      const ep = input ? input.value.trim() : state.adapterEndpoint;
      switchAdapterMode(nextMode, ep);
      renderOverviewModal();
      return;
    }
    if (event.target.closest('[data-ds-apply]')) {
      const input = document.getElementById('ds-endpoint-input');
      const ep = input ? input.value.trim() : state.adapterEndpoint;
      switchAdapterMode('http', ep || DEFAULT_HTTP_ENDPOINT);
      renderOverviewModal();
    }
  });
}

function openOverviewModal() {
  const modal = document.getElementById('overview-modal');
  if (!modal) return;
  renderOverviewModal();
  modal.hidden = false;
}

function closeOverviewModal() {
  const modal = document.getElementById('overview-modal');
  if (!modal) return;
  modal.hidden = true;
}

function renderOverviewModal() {
  const body = document.getElementById('overview-body');
  if (!body) return;
  const ov = computeCampusOverview(state.stations, summarizeStation, readDetail);

  const renderRankItem = (item, isBusy = false) => {
    const pct = Math.round(item.ratio * 100);
    return `
      <li>
        <button type="button" class="overview-rank-btn" data-overview-station="${escapeHtml(item.station.id)}">
          <span>${escapeHtml(item.station.name)}</span>
          <span class="overview-rank-badge ${isBusy ? 'is-busy' : 'is-idle'}">
            ${isBusy ? `占用 ${pct}%（余 ${item.idle} 口）` : `空闲 ${item.idle}/${item.total} 口`}
          </span>
        </button>
      </li>`;
  };

  const isHttp = state.adapterMode === 'http';

  body.innerHTML = `
    <div class="overview-kpis">
      <div class="overview-kpi">
        <div class="overview-kpi-val is-idle">${ov.totalIdle} <small style="font-size:0.8rem;font-weight:500;color:var(--text-3)">/ ${ov.totalSockets}</small></div>
        <div class="overview-kpi-label">全校当前空闲插口（总占用率 ${ov.occupancyRate}%）</div>
      </div>
      <div class="overview-kpi">
        <div class="overview-kpi-val">${ov.bike.idle} <small style="font-size:0.8rem;font-weight:500;color:var(--text-3)">/ ${ov.bike.sockets}</small></div>
        <div class="overview-kpi-label">电动自行车空闲（${ov.bike.stations} 站）</div>
      </div>
      <div class="overview-kpi">
        <div class="overview-kpi-val">${ov.car.idle} <small style="font-size:0.8rem;font-weight:500;color:var(--text-3)">/ ${ov.car.sockets}</small></div>
        <div class="overview-kpi-label">电动汽车空闲（${ov.car.stations} 站）</div>
      </div>
      <div class="overview-kpi">
        <div class="overview-kpi-val">${ov.cabinets.availableSlots} <small style="font-size:0.8rem;font-weight:500;color:var(--text-3)">/ ${ov.cabinets.totalSlots || 48}</small></div>
        <div class="overview-kpi-label">锂电柜可用电池（${ov.cabinets.totalGroups} 组换电柜）</div>
      </div>
    </div>

    <div class="overview-cols">
      <div class="overview-box">
        <h3>🟢 当前空闲最充裕 Top 5（点击直接前往）</h3>
        <ul class="overview-rank">
          ${ov.topIdle.map((it) => renderRankItem(it, false)).join('')}
        </ul>
      </div>
      <div class="overview-box">
        <h3>🟠 当前高峰繁忙站点 Top 5（建议错峰）</h3>
        <ul class="overview-rank">
          ${ov.topCrowded.map((it) => renderRankItem(it, true)).join('')}
        </ul>
      </div>
    </div>

    <div class="datasource-card">
      <div class="datasource-head">
        <span class="datasource-title">🔌 数据源模式切换</span>
        <div class="datasource-modes" role="group" aria-label="选择数据源模式">
          <button type="button" class="datasource-mode-btn${!isHttp ? ' is-active' : ''}" data-ds-mode="mock">确定性模拟数据</button>
          <button type="button" class="datasource-mode-btn${isHttp ? ' is-active' : ''}" data-ds-mode="http">常青藤 HTTP 实时代理</button>
        </div>
      </div>
      <div class="datasource-endpoint-row">
        <input id="ds-endpoint-input" class="datasource-input" type="url" value="${escapeHtml(state.adapterEndpoint)}" placeholder="http://localhost:8787/api/charging/status">
        <button type="button" class="datasource-apply-btn" data-ds-apply>应用代理</button>
      </div>
      <p class="datasource-hint">
        当前状态：<strong>${isHttp ? 'HTTP 实时代理模式（未覆盖站点或代理离线时自动无缝回退模拟数据）' : '本地确定性模拟模式（按校园四大作息曲线每 30 秒实时演化）'}</strong>。本地联调可运行 <code>node scripts/cqt_proxy.mjs</code>。
      </p>
    </div>`;
}

let appToastTimer = 0;
function showAppToast(msg) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('is-visible');
  window.clearTimeout(appToastTimer);
  appToastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2500);
}

function setupGlobalHandlers() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const modal = document.getElementById('overview-modal');
    if (modal && !modal.hidden) {
      closeOverviewModal();
      return;
    }
    if (state.resultsEl && !state.resultsEl.hidden) return;
    if (state.panel?.isOpen) state.panel.close();
  });

  const map = state.mapView;
  const resize = () => callFirst(map, ['resize', 'handleResize', 'invalidate', 'scheduleRender']);
  let resizeRaf = 0;
  const scheduleResize = () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(resize);
  };
  window.addEventListener('resize', scheduleResize);
  if (typeof ResizeObserver === 'function') {
    try {
      new ResizeObserver(scheduleResize).observe(document.getElementById('map'));
    } catch { /* 忽略 */ }
  }
}

function updateHash(stationId) {
  const base = `${location.pathname}${location.search}`;
  const hash = stationId ? `#station=${encodeURIComponent(stationId)}` : '';
  try {
    history.replaceState(null, '', `${base}${hash}`);
  } catch { /* file:// 下可能不可用 */ }
}

function restoreFromHash() {
  const id = parseStationHash(location.hash);
  if (!id) return;
  const station = state.byId.get(id);
  if (station) selectStation(station);
}

function showMapNotice(error) {
  if (document.querySelector('.map-notice')) return;
  const notice = document.createElement('div');
  notice.className = 'map-notice';
  const resource = error?.resource ? `${error.resource} 未能加载。` : '';
  notice.innerHTML = `<strong>地图未能加载</strong><span>${escapeHtml(resource)}仍可通过顶部搜索查看站点详情。</span>`;
  notice.title = error?.message || '';
  document.body.appendChild(notice);
}

function showFatalError(error) {
  const overlay = document.createElement('div');
  overlay.className = 'app-error';
  const resource = error?.resource || '';
  const hint = resource
    ? `请通过本地静态服务器打开（例如 python3 -m http.server），并确认 ${resource} 可访问。`
    : '请通过本地静态服务器打开（例如 python3 -m http.server）后重试。';
  overlay.innerHTML = `
    <div class="app-error-card">
      <strong>页面加载失败</strong>
      <p>${escapeHtml(error?.message || '未知错误')}</p>
      <p class="app-error-hint">${escapeHtml(hint)}</p>
      <button type="button">重新加载</button>
    </div>`;
  overlay.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(overlay);
}

/** 把底层 fetch 异常改写成带资源路径的错误，避免失败提示张冠李戴。 */
function resourceError(error, resource, label) {
  if (error?.resource === resource) return error;
  const reason = error?.message || '未知错误';
  const wrapped = new Error(`${label}：${resource}（${reason}）`);
  wrapped.resource = resource;
  if (error) wrapped.cause = error;
  return wrapped;
}

/** 底图缺失时用站点范围撑开视野，让图钉仍然画得出来。 */
function basemapForMap(basemap, stations) {
  if (basemap) return basemap;
  const points = (stations || []).filter((station) => (
    Number.isFinite(station.lon) && Number.isFinite(station.lat)
  ));
  if (!points.length) return { bbox: [117.15, 38.99, 117.2, 39.02] };
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const station of points) {
    minLon = Math.min(minLon, station.lon);
    minLat = Math.min(minLat, station.lat);
    maxLon = Math.max(maxLon, station.lon);
    maxLat = Math.max(maxLat, station.lat);
  }
  const padLon = Math.max(0.002, (maxLon - minLon) * 0.08);
  const padLat = Math.max(0.002, (maxLat - minLat) * 0.08);
  return {
    bbox: [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat],
  };
}

/** HTTP 适配器在接口失败后改走模拟数据时，面板要标明来源。 */
function currentLiveMode(stationId) {
  const adapter = state.adapter;
  if (adapter && typeof adapter.isUsingFallback === 'function') {
    return adapter.isUsingFallback(stationId) ? 'fallback' : 'live';
  }
  return 'live';
}

/* ------------------------------------------------- 无适配器时的兜底模拟 */

function createFallbackAdapter(stations) {
  const listeners = new Set();
  const details = new Map();
  let updatedAt = Date.now();

  const hash = (text) => {
    let value = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      value ^= text.charCodeAt(i);
      value = Math.imul(value, 16777619);
    }
    return Math.abs(value);
  };

  const build = (station) => {
    const now = Date.now();
    const total = Math.max(0, Number(station.sockets) || 0);
    const sockets = [];
    for (let i = 1; i <= total; i += 1) {
      const seed = hash(`${station.id}:${i}:${Math.floor(now / 60000)}`);
      let status = 'idle';
      if (seed % 11 === 0) status = 'fault';
      else if (seed % 3 === 0) status = 'charging';
      sockets.push({
        no: i,
        status,
        endTime: status === 'charging' ? now + (10 + (seed % 80)) * 60000 : null,
      });
    }
    return { updatedAt: now, sockets };
  };

  const rebuild = () => {
    updatedAt = Date.now();
    stations.forEach((station) => details.set(station.id, build(station)));
  };

  rebuild();
  window.setInterval(() => {
    rebuild();
    listeners.forEach((listener) => {
      try { listener({ updatedAt }); } catch { /* 忽略 */ }
    });
  }, 20000);

  return {
    get updatedAt() { return updatedAt; },
    getStationDetail(stationId) { return details.get(stationId) || null; },
    getDetail(stationId) { return details.get(stationId) || null; },
    refresh() { rebuild(); listeners.forEach((listener) => listener({ updatedAt })); },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
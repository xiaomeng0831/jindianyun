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
import { createMockAdapter } from './mock-adapter.js';
import { createStationPanel, summarizeStation, escapeHtml } from './panel.js';

const STATIONS_URL = new URL('../data/stations.json', import.meta.url);
const BASEMAP_URL = new URL('../data/basemap.json', import.meta.url);
const TYPE_TEXT = { bike: '电动自行车', car: '电动汽车' };

const state = {
  stations: [],
  byId: new Map(),
  adapter: null,
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

  const [stations, basemap] = await Promise.all([
    loadStations(),
    loadBasemap(BASEMAP_URL),
  ]);
  state.stations = stations;
  state.byId = new Map(stations.map((station) => [station.id, station]));
  state.buildings = buildBuildingIndex(basemap);

  state.adapter = createAdapter(stations);
  applyOccupancyToStations();

  state.panel = createStationPanel(panelRoot, {
    onClose: handlePanelClose,
    onRefresh: handleRefresh,
  });

  try {
    state.mapView = createMap(canvas, basemap, stations);
  } catch (error) {
    console.error('[津电云] 地图初始化失败', error);
    showMapNotice(error);
  }

  setupSearch();
  populateLegend();
  subscribeAdapter();
  setupGlobalHandlers();
  restoreFromHash();
  document.body.classList.add('app-ready');
  hideLoading();
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

  state.selectedId = station.id;
  const detail = readDetail(station.id);
  state.panel.open(station, detail, { updatedAt: readUpdatedAt(detail) });

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

function createAdapter(stations) {
  const attempts = [
    () => createMockAdapter(stations),
    () => createMockAdapter({ stations }),
    () => createMockAdapter(),
  ];
  let fallback = null;

  for (const attempt of attempts) {
    try {
      const adapter = attempt();
      if (!adapter || typeof adapter !== 'object') continue;
      if (probeAdapter(adapter)) return adapter;
      if (!fallback) fallback = adapter;
    } catch { /* 尝试下一种签名 */ }
  }
  return fallback || createFallbackAdapter(stations);
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
    const detail = normalizeDetail(raw);
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
    const detail = normalizeDetail(raw);
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
      const detail = normalizeDetail(raw);
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

function normalizeDetail(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return { sockets: value };
  if (typeof value !== 'object') return null;
  return value;
}

function readUpdatedAt(detail) {
  const adapter = state.adapter;
  return detail?.updatedAt
    ?? adapter?.updatedAt
    ?? adapter?.lastUpdated
    ?? Date.now();
}

/** 把实时占用情况写回站点对象，供地图图钉按占用比例着色。 */
function applyOccupancyToStations() {
  for (const station of state.stations) {
    const detail = readDetail(station.id);
    if (!detail) continue;
    const summary = summarizeStation(station, detail);
    if (!summary.total) continue;
    station.occupied = summary.charging;
    station.occupancy = summary.charging / summary.total;
  }
}

function subscribeAdapter() {
  const adapter = state.adapter;
  if (!adapter) return;
  const onChange = (payload) => handleAdapterUpdate(payload);

  if (typeof adapter.subscribe === 'function') {
    try { adapter.subscribe(onChange); return; } catch { /* 继续 */ }
  }
  if (typeof adapter.onUpdate === 'function') {
    try { adapter.onUpdate(onChange); return; } catch { /* 继续 */ }
  }
  if (typeof adapter.on === 'function') {
    try { adapter.on('update', onChange); return; } catch { /* 继续 */ }
    try { adapter.on('change', onChange); return; } catch { /* 继续 */ }
  }
  // 无订阅能力时轮询，保证面板与列表不会停留在旧数据
  window.setInterval(() => handleAdapterUpdate(), 5000);
}

function handleAdapterUpdate() {
  detailCache.clear();
  applyOccupancyToStations();
  callFirst(state.mapView, ['setStations'], state.stations);

  const stationId = state.selectedId;
  if (stationId) {
    const detail = readDetail(stationId);
    if (detail) {
      state.panel.setDetail(detail, { updatedAt: readUpdatedAt(detail) });
    }
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
    if (id) {
      const detail = readDetail(id);
      if (detail) {
        state.panel.setDetail(detail, { updatedAt: readUpdatedAt(detail) });
      }
    }
    state.refreshing = false;
    state.panel.setRefreshing(false);
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
  const matches = state.stations.filter((station) => {
    if (!q) return true;
    const haystack = `${station.name} ${station.id} ${station.note || ''} ${TYPE_TEXT[station.type] || ''}`.toLowerCase();
    return haystack.includes(q);
  });
  // 楼宇结果：仅在有关键词时追加，最多 6 条，排在站点之后
  const buildingMatches = q ? searchBuildings(q, 6) : [];
  state.results = matches.concat(buildingMatches);

  const listMode = resultsEl.tagName === 'UL';
  const groupTag = listMode ? 'li' : 'div';
  const itemTag = listMode ? 'li' : 'button';
  const itemAttrs = listMode ? 'tabindex="-1"' : 'type="button"';

  if (!state.results.length) {
    resultsEl.innerHTML = `<${groupTag} class="search-empty" role="presentation">没有找到与「${escapeHtml(query)}」匹配的站点或楼宇</${groupTag}>`;
    state.activeIndex = -1;
  } else {
    if (state.activeIndex >= state.results.length) state.activeIndex = state.results.length - 1;
    let previousType = null;
    let html = '';
    state.results.forEach((station, index) => {
      if (station.kind === 'building') {
        if (previousType !== '__building') {
          previousType = '__building';
          html += `<${groupTag} class="search-group" role="presentation">楼宇</${groupTag}>`;
        }
        html += `
        <${itemTag} ${itemAttrs} class="search-item search-item-building" role="option" id="search-option-${index}"
          data-building="${escapeHtml(station.name)}" data-index="${index}" aria-selected="false">
          <span class="search-item-main">
            <span class="search-item-name">${highlightMatch(station.name, q)}</span>
            <span class="search-item-meta">地图定位</span>
          </span>
        </${itemTag}>`;
        return;
      }
      if (station.type !== previousType) {
        previousType = station.type;
        html += `<${groupTag} class="search-group" role="presentation">${escapeHtml(TYPE_TEXT[station.type] || '充电站')}</${groupTag}>`;
      }
      const live = liveInfoFor(station);
      const meta = `${TYPE_TEXT[station.type] || '充电站'}${station.sockets > 0 ? ` · ${station.sockets} 口` : ' · 插口待采集'}`;
      html += `
        <${itemTag} ${itemAttrs} class="search-item" role="option" id="search-option-${index}"
          data-id="${escapeHtml(station.id)}" data-index="${index}" aria-selected="false">
          <span class="search-item-main">
            <span class="search-item-name">${highlightMatch(station.name, q)}</span>
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

/** 把地图移到某栋楼（不打开站点面板）。 */
function focusBuilding(building) {
  state.selectedId = null;
  if (state.panel?.isOpen) state.panel.close();
  const map = state.mapView;
  if (map) {
    callFirst(map, ['focusPoint', 'focus', 'flyTo', 'panTo', 'centerOn'], building.lon, building.lat);
    callFirst(map, ['setSelected', 'selectStation', 'highlightStation', 'setSelection'], null);
  }
  updateHash(null);
  closeResults();
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

function setupGlobalHandlers() {
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
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
  let raw = '';
  try {
    raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  } catch {
    // 哈希中有非法百分号编码（例如 #%），当作没有哈希处理
    raw = '';
  }
  if (!raw) return;
  const id = raw.startsWith('station=') ? raw.slice('station='.length) : raw;
  const station = state.byId.get(id);
  if (station) selectStation(station);
}

function showMapNotice(error) {
  const notice = document.createElement('div');
  notice.className = 'map-notice';
  notice.innerHTML = `<strong>地图未能加载</strong><span>仍可通过顶部搜索查看站点详情。</span>`;
  notice.title = error?.message || '';
  document.body.appendChild(notice);
}

function showFatalError(error) {
  const overlay = document.createElement('div');
  overlay.className = 'app-error';
  overlay.innerHTML = `
    <div class="app-error-card">
      <strong>页面加载失败</strong>
      <p>${escapeHtml(error?.message || '未知错误')}</p>
      <p class="app-error-hint">请通过本地静态服务器打开（例如 python3 -m http.server），并确认 data/stations.json 可访问。</p>
      <button type="button">重新加载</button>
    </div>`;
  overlay.querySelector('button').addEventListener('click', () => location.reload());
  document.body.appendChild(overlay);
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
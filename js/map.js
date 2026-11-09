/**
 * 津电云 · 交互地图
 * ------------------------------------------------------------------
 * Canvas 2D 矢量地图。功能：
 *   - 拖拽平移 / 双指缩放 / 滚轮缩放 / 按钮缩放；
 *   - 载入即适配整个校区；
 *   - 充电站图钉按占用比例着色（绿=空闲多 / 橙=较满 / 红=接近满）；
 *   - 悬停提示、点击选中并回调、选中高亮；
 *   - 适配 devicePixelRatio，静态底图按缩放级别缓存到离屏 canvas。
 *
 * 用法：
 *   import { MapView } from './js/map.js';
 *   import { loadBasemap } from './js/basemap.js';
 *   const basemap = await loadBasemap();
 *   const stations = await (await fetch('data/stations.json')).json();
 *   const map = new MapView(canvas, basemap, stations, {
 *     onSelect(id, station) { ... },   // 点击空白时 id 为 null
 *   });
 *
 * 站点对象动态字段约定（任选其一，均由数据适配器写入）：
 *   occupied: 已占用插口数（优先）
 *   busy:     同上（别名）
 *   occupancy: 0..1 的占用比例
 * 站点静态字段：id, name, type('bike'|'car'), sockets, cabinets, lon, lat, approx, note。
 */

import {
  BasemapRenderer,
  fitView,
  projectLonLat,
  unprojectPoint,
  resolveTheme,
  metersPerPixel,
} from './basemap.js';

const MIN_ZOOM = -0.7;
const MAX_ZOOM = 5.2;
const MAX_DPR = 3;
const CACHE_MARGIN_MAX = 200;
const CACHE_MARGIN_MIN = 64;
const CACHE_PIXEL_BUDGET = 9e6; // 单张离屏画布像素上限（约 36 MB）
const CACHE_MAX_ENTRIES = 2;
const LABEL_FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, -apple-system, sans-serif';

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * 归一化站点的占用数据。
 * @returns {{sockets:number, occupied:number, free:number|null, ratio:number|null}}
 *          sockets=0 时 ratio/free 为 null（插口数待采集）。
 */
export function getStationOccupancy(station) {
  const sockets = Math.max(0, Math.round(Number(station && station.sockets) || 0));
  let occupiedKnown = false;
  let occupied = 0;
  if (station && Number.isFinite(station.occupied)) {
    occupied = station.occupied;
    occupiedKnown = true;
  } else if (station && Number.isFinite(station.busy)) {
    occupied = station.busy;
    occupiedKnown = true;
  } else if (station && Number.isFinite(station.occupancy) && sockets > 0) {
    occupied = Math.round(station.occupancy * sockets);
    occupiedKnown = true;
  }
  occupied = Math.round(clamp(occupied, 0, sockets));
  const hasData = occupiedKnown && sockets > 0;
  return {
    sockets,
    occupied,
    free: hasData ? sockets - occupied : null,
    ratio: hasData ? occupied / sockets : null,
  };
}

/** 占用比例 → 图钉颜色（从主题取色）。 */
export function occupancyColor(ratio, theme) {
  if (ratio == null) return theme.pinUnknown;
  if (ratio >= 0.85) return theme.pinFull;
  if (ratio >= 0.5) return theme.pinMid;
  return theme.pinFree;
}

export class MapView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} basemap  data/basemap.json 的解析结果
   * @param {Array<object>} stations
   * @param {{onSelect?:Function, theme?:object, padding?:number,
   *          controls?:{zoomIn?:any, zoomOut?:any, reset?:any},
   *          cacheStatic?:boolean, scaleBar?:boolean}} [options]
   */
  constructor(canvas, basemap, stations, options = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new Error('MapView 需要一个 <canvas> 元素');
    }
    this.canvas = canvas;
    this.options = options;
    this.onSelect = typeof options.onSelect === 'function' ? options.onSelect : null;
    this.renderer = new BasemapRenderer(basemap);
    this.theme = resolveTheme(canvas, options.theme);

    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');

    this.stations = [];
    this._byId = new Map();
    this.selectedId = null;
    this.hoveredId = null;

    this._zoom = 0;
    this._center = { x: 0, y: 0 };
    this._fit = { cx: 0, cy: 0, scale: 1 };
    this._baseScale = 1;
    this._size = { w: 0, h: 0, dpr: 1 };
    this._usingFit = true;
    this._gesturing = false;
    this._animating = false;
    this._animHandle = 0;
    this._gestureTimer = 0;
    this._frame = 0;
    this._destroyed = false;
    this._themeDark = false;
    this._cache = new Map();
    this._controls = [];
    this._listeners = [];
    this._tooltip = null;
    this._tooltipStationId = null;

    this._pointers = new Map();
    this._drag = null;
    this._pinch = null;

    this.canvas.style.touchAction = 'none';
    if (!this.canvas.style.cursor) this.canvas.style.cursor = 'grab';
    if (!this.canvas.hasAttribute('tabindex')) this.canvas.tabIndex = 0;
    if (!this.canvas.getAttribute('role')) this.canvas.setAttribute('role', 'application');
    if (!this.canvas.getAttribute('aria-label')) {
      this.canvas.setAttribute('aria-label', '天津大学北洋园校区充电站地图，可拖拽、滚轮缩放，点击图钉查看站点');
    }

    this._bindEvents();
    this._bindControls(options.controls);
    this._observeSize();
    this._handleResize(true);
    this.setStations(stations || []);
    this._watchColorScheme();
  }

  /* ------------------------------------------------------------------ */
  /* 公开 API                                                            */
  /* ------------------------------------------------------------------ */

  /** 当前视口（世界坐标中心 + 每世界单位像素数）。 */
  get view() {
    return {
      cx: this._center.x,
      cy: this._center.y,
      scale: this._baseScale * Math.pow(2, this._zoom),
    };
  }

  /** 相对“全校区适配”的缩放级别，0 表示整校区正好铺满。 */
  get zoom() {
    return this._zoom;
  }

  /** 替换站点列表（例如模拟数据周期性刷新后整体更新）。 */
  setStations(stations, opts = {}) {
    const list = [];
    for (const st of stations || []) {
      if (!st || !Number.isFinite(st.lon) || !Number.isFinite(st.lat)) continue;
      list.push(st);
    }
    this.stations = list;
    this._byId = new Map();
    for (const st of list) {
      if (st.id != null) this._byId.set(st.id, st);
    }
    if (this.selectedId != null && !this._byId.has(this.selectedId)) {
      this.selectedId = null;
      this._hideTooltip();
    }
    this._requestDraw();
    if (!opts.silent) this._refreshTooltip();
  }

  /** 局部更新单个站点（占用状态变化时用，比整体替换更省）。 */
  updateStation(id, patch) {
    const st = this._byId.get(id);
    if (!st) return false;
    if (patch && typeof patch === 'object') Object.assign(st, patch);
    this._requestDraw();
    this._refreshTooltip();
    return true;
  }

  /** 外部同步选中状态（不会触发 onSelect 回调）。 */
  setSelected(id) {
    const next = id != null && this._byId.has(id) ? id : null;
    if (next === this.selectedId) return;
    this.selectedId = next;
    this._requestDraw();
    if (next) this._showTooltipForStation(this._byId.get(next));
    else this._hideTooltip();
  }

  /** 切换主题覆盖值（未给出的键沿用 CSS 变量/明暗默认值）。 */
  setTheme(overrides) {
    this.theme = resolveTheme(this.canvas, overrides);
    this._cache.clear();
    if (this._tooltip && this._tooltipStationId) {
      this._showTooltipForStation(this._byId.get(this._tooltipStationId));
    }
    this._requestDraw();
  }

  zoomIn() {
    this._animateZoom(clamp(this._zoom + 1, MIN_ZOOM, MAX_ZOOM));
  }

  zoomOut() {
    this._animateZoom(clamp(this._zoom - 1, MIN_ZOOM, MAX_ZOOM));
  }

  /** 回到整校区视野。 */
  resetView() {
    this._cancelAnimation();
    this._usingFit = true;
    this._zoom = 0;
    this._center = { x: this._fit.cx, y: this._fit.cy };
    this._cache.clear();
    this._requestDraw();
  }

  /** 缩放并平移到某个站点（详情面板跳转用）。第二参数可为缩放级别或 {zoom}。 */
  focusStation(id, targetZoom = 3) {
    const st = this._byId.get(id);
    if (!st) return;
    let z = targetZoom;
    if (z && typeof z === 'object') z = Number.isFinite(z.zoom) ? z.zoom : 3;
    if (!Number.isFinite(z)) z = 3;
    const p = projectLonLat(st.lon, st.lat);
    this._cancelAnimation();
    this._usingFit = false;
    this._zoom = clamp(Math.max(this._zoom, z), MIN_ZOOM, MAX_ZOOM);
    this._center = { x: p.x, y: p.y };
    this._requestDraw();
    if (this.selectedId === id) this._showTooltipForStation(st);
  }

  /** 让所有站点点位铺满视野。 */
  fitToStations() {
    if (!this.stations.length) {
      this.resetView();
      return;
    }
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    for (const st of this.stations) {
      minLon = Math.min(minLon, st.lon);
      maxLon = Math.max(maxLon, st.lon);
      minLat = Math.min(minLat, st.lat);
      maxLat = Math.max(maxLat, st.lat);
    }
    // 单点或极小范围时给一个合理的默认跨度（约 400 米）
    const lonSpan = Math.max(maxLon - minLon, 0.0045);
    const latSpan = Math.max(maxLat - minLat, 0.0032);
    const clon = (minLon + maxLon) / 2;
    const clat = (minLat + maxLat) / 2;
    const fb = fitView(
      [clon - lonSpan / 2, clat - latSpan / 2, clon + lonSpan / 2, clat + latSpan / 2],
      this._size.w,
      this._size.h,
      Math.max(48, Number(this.options.padding) || 26),
    );
    const z = Math.log2(fb.scale / this._baseScale);
    this._cancelAnimation();
    this._usingFit = false;
    this._zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
    this._center = { x: fb.cx, y: fb.cy };
    this._requestDraw();
  }

  /** 绑定外部缩放/复位按钮（元素或选择器）。可重复调用。 */
  bindControls(controls) {
    this._bindControls(controls);
  }

  /** 站点当前屏幕坐标（CSS 像素，相对 canvas 左上角），供外部定位气泡等。 */
  getStationScreenPosition(id) {
    const st = this._byId.get(id);
    if (!st) return null;
    const view = this.view;
    const p = projectLonLat(st.lon, st.lat);
    return {
      x: (p.x - view.cx) * view.scale + this._size.w / 2,
      y: (p.y - view.cy) * view.scale + this._size.h / 2,
    };
  }

  /** 强制重绘（容器尺寸/主题由外部 CSS 驱动变化后调用）。 */
  invalidate() {
    this._handleResize(false);
    this._cache.clear();
    this._requestDraw();
  }

  /** invalidate 的别名，兼容外部 resize 调用。 */
  resize() {
    this.invalidate();
  }

  /** 清除选中状态（不触发 onSelect）。 */
  clearSelection() {
    this.setSelected(null);
  }

  destroy() {
    this._destroyed = true;
    this._cancelAnimation();
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = 0;
    if (this._gestureTimer) clearTimeout(this._gestureTimer);
    for (const { target, type, handler, opts } of this._listeners) {
      target.removeEventListener(type, handler, opts);
    }
    this._listeners.length = 0;
    for (const { el, handler } of this._controls) el.removeEventListener('click', handler);
    this._controls.length = 0;
    if (this._resizeObserver) this._resizeObserver.disconnect();
    if (this._mqListener && this._mq) this._mq.removeEventListener('change', this._mqListener);
    if (this._tooltip && this._tooltip.parentNode) this._tooltip.parentNode.removeChild(this._tooltip);
    this._tooltip = null;
  }

  /* ------------------------------------------------------------------ */
  /* 尺寸与生命周期                                                      */
  /* ------------------------------------------------------------------ */

  _addListener(target, type, handler, opts) {
    target.addEventListener(type, handler, opts);
    this._listeners.push({ target, type, handler, opts });
  }

  _observeSize() {
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this._handleResize(false));
      this._resizeObserver.observe(this.canvas.parentElement || this.canvas);
    }
    this._addListener(window, 'resize', () => this._handleResize(false));
    this._addListener(window, 'orientationchange', () => {
      setTimeout(() => this._handleResize(false), 120);
    });
  }

  _handleResize(initial) {
    const rect = this.canvas.getBoundingClientRect();
    let w = Math.round(rect.width);
    let h = Math.round(rect.height);
    if (!w || !h) {
      const parent = this.canvas.parentElement;
      w = Math.round((parent && parent.clientWidth) || 0) || 800;
      h = Math.round((parent && parent.clientHeight) || 0) || 600;
      if (!this.canvas.style.width) this.canvas.style.width = '100%';
      if (!this.canvas.style.height) this.canvas.style.height = '100%';
    }
    if (w < 1 || h < 1) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (!initial && w === this._size.w && h === this._size.h && dpr === this._size.dpr) return;

    const hadSize = this._size.w > 0 && this._size.h > 0;
    this._size = { w, h, dpr };
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx = this.canvas.getContext('2d', { alpha: false, desynchronized: true }) || this.canvas.getContext('2d');

    this._fit = fitView(this.renderer.bbox, w, h, Number(this.options.padding) || 26);
    this._baseScale = this._fit.scale;
    this._cache.clear();

    if (initial || !hadSize || this._usingFit) {
      this._zoom = 0;
      this._center = { x: this._fit.cx, y: this._fit.cy };
      this._usingFit = true;
    } else {
      this._zoom = clamp(this._zoom, MIN_ZOOM, MAX_ZOOM);
    }
    this._requestDraw();
  }

  _watchColorScheme() {
    if (typeof window.matchMedia !== 'function') return;
    try {
      this._mq = window.matchMedia('(prefers-color-scheme: dark)');
      this._mqListener = () => {
        this.theme = resolveTheme(this.canvas, this.options.theme);
        this._cache.clear();
        this._requestDraw();
      };
      this._mq.addEventListener('change', this._mqListener);
    } catch (_) { /* 旧浏览器忽略 */ }
  }

  /* ------------------------------------------------------------------ */
  /* 事件绑定                                                            */
  /* ------------------------------------------------------------------ */

  _bindEvents() {
    const c = this.canvas;
    const passiveFalse = { passive: false };
    const handlers = {
      pointerdown: (e) => this._onPointerDown(e),
      pointermove: (e) => this._onPointerMove(e),
      pointerup: (e) => this._onPointerUp(e),
      pointercancel: (e) => this._onPointerUp(e),
      pointerleave: () => this._onPointerLeave(),
      wheel: (e) => this._onWheel(e),
      dblclick: (e) => this._onDoubleClick(e),
      keydown: (e) => this._onKeyDown(e),
    };
    this._addListener(c, 'pointerdown', handlers.pointerdown, passiveFalse);
    this._addListener(c, 'pointermove', handlers.pointermove, passiveFalse);
    this._addListener(c, 'pointerup', handlers.pointerup, passiveFalse);
    this._addListener(c, 'pointercancel', handlers.pointercancel, passiveFalse);
    this._addListener(c, 'pointerleave', handlers.pointerleave);
    this._addListener(c, 'wheel', handlers.wheel, passiveFalse);
    this._addListener(c, 'dblclick', handlers.dblclick, passiveFalse);
    this._addListener(c, 'keydown', handlers.keydown);
    this._addListener(c, 'contextmenu', (e) => e.preventDefault());
  }

  _bindControls(controls) {
    if (!controls) return;
    const bind = (ref, fn) => {
      if (!ref) return;
      let el = ref;
      if (typeof ref === 'string') {
        try { el = document.querySelector(ref); } catch (_) { el = null; }
      }
      if (!el || typeof el.addEventListener !== 'function') return;
      if (this._controls.some((c) => c.el === el)) return;
      const handler = (ev) => { ev.preventDefault(); fn(); };
      el.addEventListener('click', handler);
      this._controls.push({ el, handler });
    };
    bind(controls.zoomIn, () => this.zoomIn());
    bind(controls.zoomOut, () => this.zoomOut());
    bind(controls.reset, () => this.resetView());
  }

  /* ------------------------------------------------------------------ */
  /* 绘制主循环                                                          */
  /* ------------------------------------------------------------------ */

  _requestDraw() {
    if (this._frame || this._destroyed) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      this._draw();
    });
  }

  _draw() {
    if (this._destroyed) return;
    const { w, h, dpr } = this._size;
    if (!w || !h) return;
    const ctx = this.ctx;
    const view = this.view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = this.theme.bg;
    ctx.fillRect(0, 0, w, h);

    this._drawStaticLayer(ctx, view, w, h);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawStations(ctx, view, w, h);
    if (this.options.scaleBar !== false) this._drawScaleBar(ctx, view, w, h);
    if (this.options.attribution !== false) this._drawAttribution(ctx, w, h);
  }

  _drawStaticLayer(ctx, view, w, h) {
    const useCache = this.options.cacheStatic !== false && !this._gesturing && !this._animating;
    if (!useCache) {
      this.renderer.renderStatic(ctx, view, {
        width: w, height: h, theme: this.theme, zoom: this._zoom,
      });
      return;
    }
    const entry = this._prepareCache(view);
    const dpr = this._size.dpr;
    const sx = (entry.cssW / 2 + (view.cx - entry.cx) * view.scale - w / 2) * dpr;
    const sy = (entry.cssH / 2 + (view.cy - entry.cy) * view.scale - h / 2) * dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(entry.canvas, sx, sy, w * dpr, h * dpr, 0, 0, w * dpr, h * dpr);
    ctx.restore();
  }

  _cacheMargin() {
    const dpr = this._size.dpr;
    const maxCssArea = CACHE_PIXEL_BUDGET / (dpr * dpr);
    const room = Math.sqrt(maxCssArea) - Math.max(this._size.w, this._size.h);
    return Math.round(clamp(room / 2, CACHE_MARGIN_MIN, CACHE_MARGIN_MAX));
  }

  _prepareCache(view) {
    const { w, h, dpr } = this._size;
    const margin = this._cacheMargin();
    const cssW = w + margin * 2;
    const cssH = h + margin * 2;
    const key = Math.round(this._zoom * 2);
    const viewScale = view.scale;
    let entry = this._cache.get(key);

    const sameScale = entry && Math.abs(entry.scale / viewScale - 1) < 0.004;
    const sameBitmap = entry && entry.dpr === dpr && entry.cssW === cssW && entry.cssH === cssH;
    if (entry && sameScale && sameBitmap) {
      const dx = (view.cx - entry.cx) * viewScale;
      const dy = (view.cy - entry.cy) * viewScale;
      if (Math.abs(dx) <= margin - 40 && Math.abs(dy) <= margin - 40) {
        this._cache.delete(key);
        this._cache.set(key, entry);
        return entry;
      }
    }

    if (!entry || entry.dpr !== dpr || entry.cssW !== cssW || entry.cssH !== cssH) {
      const cnv = document.createElement('canvas');
      cnv.width = Math.round(cssW * dpr);
      cnv.height = Math.round(cssH * dpr);
      entry = { canvas: cnv, cssW, cssH, dpr, scale: viewScale, cx: view.cx, cy: view.cy };
      this._cache.set(key, entry);
      this._trimCache();
    }
    entry.scale = viewScale;
    entry.cx = view.cx;
    entry.cy = view.cy;
    const cctx = entry.canvas.getContext('2d', { alpha: false });
    cctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    cctx.fillStyle = this.theme.bg;
    cctx.fillRect(0, 0, cssW, cssH);
    this.renderer.renderStatic(cctx, { cx: view.cx, cy: view.cy, scale: viewScale }, {
      width: cssW, height: cssH, theme: this.theme, zoom: this._zoom,
    });
    this._cache.delete(key);
    this._cache.set(key, entry);
    return entry;
  }

  _trimCache() {
    while (this._cache.size > CACHE_MAX_ENTRIES) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 站点图钉                                                            */
  /* ------------------------------------------------------------------ */

  _pinRadius() {
    return 7 + clamp(this._zoom, 0, 3) * 0.75;
  }

  _drawStations(ctx, view, w, h) {
    const r = this._pinRadius();
    const items = [];
    for (const st of this.stations) {
      const p = projectLonLat(st.lon, st.lat);
      const x = (p.x - view.cx) * view.scale + w / 2;
      const y = (p.y - view.cy) * view.scale + h / 2;
      if (x < -40 || y < -70 || x > w + 40 || y > h + 40) continue;
      items.push({ st, x, y, stats: getStationOccupancy(st) });
    }
    const rank = (item) => {
      if (item.st.id === this.selectedId) return 2;
      if (item.st.id === this.hoveredId) return 1;
      return 0;
    };
    items.sort((a, b) => rank(a) - rank(b));
    for (const item of items) this._drawPin(ctx, item.x, item.y, r, item.st, item.stats);
  }

  _drawPin(ctx, x, y, r, station, stats) {
    const theme = this.theme;
    const color = occupancyColor(stats.ratio, theme);
    const headY = -r * 1.6;
    ctx.save();
    ctx.translate(x, y);

    if (station.id === this.selectedId) {
      ctx.beginPath();
      ctx.arc(0, headY, r * 2.15, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.16;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(0, headY, r + 3.4, 0, Math.PI * 2);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
    } else if (station.id === this.hoveredId) {
      ctx.beginPath();
      ctx.arc(0, headY, r + 3.6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.14;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    /* 落地阴影 */
    ctx.beginPath();
    ctx.ellipse(0, 0.5, r * 0.55, r * 0.24, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.fill();

    /* 图钉本体 */
    tracePin(ctx, r);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = theme.pinEdge;
    ctx.lineWidth = 1;
    ctx.stroke();

    /* 内部符号：自行车=圆点，汽车=圆角方块 */
    if (station.type === 'car') {
      const s = r * 0.66;
      const rr = s * 0.28;
      const x0 = -s / 2;
      const y0 = headY - s / 2;
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function') {
        ctx.roundRect(x0, y0, s, s, rr);
      } else {
        ctx.moveTo(x0 + rr, y0);
        ctx.lineTo(x0 + s - rr, y0);
        ctx.quadraticCurveTo(x0 + s, y0, x0 + s, y0 + rr);
        ctx.lineTo(x0 + s, y0 + s - rr);
        ctx.quadraticCurveTo(x0 + s, y0 + s, x0 + s - rr, y0 + s);
        ctx.lineTo(x0 + rr, y0 + s);
        ctx.quadraticCurveTo(x0, y0 + s, x0, y0 + s - rr);
        ctx.lineTo(x0, y0 + rr);
        ctx.quadraticCurveTo(x0, y0, x0 + rr, y0);
        ctx.closePath();
      }
    } else {
      ctx.beginPath();
      ctx.arc(0, headY, r * 0.36, 0, Math.PI * 2);
    }
    ctx.fillStyle = theme.pinText;
    ctx.fill();

    ctx.restore();
  }

  /** 屏幕坐标命中测试，返回最近的站点或 null。 */
  _hitTest(sx, sy) {
    const r = this._pinRadius();
    const view = this.view;
    const { w, h } = this._size;
    let best = null;
    let bestD = Infinity;
    for (const st of this.stations) {
      const p = projectLonLat(st.lon, st.lat);
      const x = (p.x - view.cx) * view.scale + w / 2;
      const y = (p.y - view.cy) * view.scale + h / 2;
      if (x < -40 || y < -70 || x > w + 40 || y > h + 40) continue;
      const headY = y - r * 1.6;
      const dHead = Math.hypot(sx - x, sy - headY);
      const ty = clamp(sy, headY, y);
      const dTail = Math.hypot(sx - x, sy - ty);
      const d = Math.min(dHead, dTail);
      if (d <= r + 4 && d < bestD) {
        bestD = d;
        best = st;
      }
    }
    return best;
  }

  /** 选中（或清除选中）并派发回调/事件。 */
  _select(id) {
    const station = id != null ? this._byId.get(id) || null : null;
    const next = station ? station.id : null;
    this.selectedId = next;
    this.hoveredId = null;
    this._cancelAnimation();
    this._requestDraw();
    if (station) this._showTooltipForStation(station);
    else this._hideTooltip();
    if (this.onSelect) this.onSelect(next, station);
    try {
      this.canvas.dispatchEvent(new CustomEvent('stationselect', {
        detail: { id: next, station },
        bubbles: true,
      }));
    } catch (_) { /* 忽略构造异常 */ }
  }

  _screenToWorld(sx, sy) {
    const view = this.view;
    return {
      x: view.cx + (sx - this._size.w / 2) / view.scale,
      y: view.cy + (sy - this._size.h / 2) / view.scale,
    };
  }

  _cancelAnimation() {
    if (this._animHandle) cancelAnimationFrame(this._animHandle);
    this._animHandle = 0;
    if (this._animating) {
      this._animating = false;
      this._requestDraw();
    }
  }

  _animateZoom(target) {
    const to = clamp(target, MIN_ZOOM, MAX_ZOOM);
    const from = this._zoom;
    if (Math.abs(to - from) < 1e-4) return;
    this._cancelAnimation();
    const anchorX = this._size.w / 2;
    const anchorY = this._size.h / 2;
    const world = this._screenToWorld(anchorX, anchorY);
    this._animating = true;
    this._usingFit = false;
    const start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const duration = 200;
    const step = () => {
      if (this._destroyed) { this._animating = false; return; }
      const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      const t = clamp((now - start) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      this._zoom = from + (to - from) * eased;
      const scale = this._baseScale * Math.pow(2, this._zoom);
      this._center = {
        x: world.x - (anchorX - this._size.w / 2) / scale,
        y: world.y - (anchorY - this._size.h / 2) / scale,
      };
      this._requestDraw();
      if (t < 1) {
        this._animHandle = requestAnimationFrame(step);
      } else {
        this._animHandle = 0;
        this._animating = false;
        this._zoom = to;
        this._cache.clear();
        this._requestDraw();
      }
    };
    this._animHandle = requestAnimationFrame(step);
  }

  /* ------------------------------------------------------------------ */
  /* 悬停提示                                                            */
  /* ------------------------------------------------------------------ */

  _ensureTooltip() {
    if (this._tooltip) return this._tooltip;
    const parent = this.canvas.parentElement;
    const el = document.createElement('div');
    el.className = 'map-tooltip';
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = [
      'position:absolute',
      'left:0',
      'top:0',
      'display:none',
      'opacity:0',
      'pointer-events:none',
      'z-index:20',
      'max-width:240px',
      'padding:9px 11px',
      'border-radius:10px',
      `font:12px/1.45 ${LABEL_FONT_STACK}`,
      'box-shadow:0 8px 24px rgba(0,0,0,0.18)',
      'transition:opacity 120ms ease',
      'will-change:transform',
    ].join(';');
    if (parent) {
      try {
        if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      } catch (_) { /* 忽略 */ }
      parent.appendChild(el);
    }
    this._tooltip = el;
    return el;
  }

  _showTooltipForStation(station, force) {
    if (!station) return;
    const pos = this.getStationScreenPosition(station.id);
    if (!pos) return;
    this._showTooltip(station, pos.x, pos.y, !!force);
  }

  _showTooltip(station, x, y, force) {
    if (!station) return;
    const el = this._ensureTooltip();
    if (!force && this._tooltipStationId === station.id && el.style.display !== 'none') {
      this._positionTooltip(x, y);
      return;
    }
    const stats = getStationOccupancy(station);
    const theme = this.theme;
    el.style.display = 'block';
    el.style.background = theme.tooltipBg;
    el.style.color = theme.tooltipFg;
    el.style.border = `1px solid ${theme.tooltipBorder}`;
    el.innerHTML = '';

    const name = document.createElement('div');
    name.textContent = station.name || '未命名站点';
    name.style.cssText = 'font-weight:650;font-size:13px;letter-spacing:0.01em;line-height:1.35;';
    el.appendChild(name);

    const typeLabel = station.type === 'car' ? '电动汽车' : '电动自行车';
    const meta = document.createElement('div');
    meta.textContent = stats.sockets > 0
      ? `${typeLabel} · ${stats.sockets} 个插口`
      : `${typeLabel} · 插口数待采集`;
    meta.style.cssText = `margin-top:2px;font-size:11px;color:${theme.tooltipMuted};`;
    el.appendChild(meta);

    if (stats.ratio != null) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:7px;';
      const free = document.createElement('span');
      free.textContent = `空闲 ${stats.free}`;
      free.style.cssText = `font-weight:650;font-size:12px;color:${theme.pinFree};`;
      const used = document.createElement('span');
      used.textContent = `占用 ${stats.occupied}`;
      const usedColor = stats.ratio >= 0.85 ? theme.pinFull
        : stats.ratio >= 0.5 ? theme.pinMid : theme.tooltipMuted;
      used.style.cssText = `font-weight:650;font-size:12px;color:${usedColor};`;
      row.appendChild(free);
      row.appendChild(used);
      el.appendChild(row);

      const bar = document.createElement('div');
      bar.style.cssText = 'margin-top:6px;height:4px;border-radius:2px;overflow:hidden;background:rgba(127,127,127,0.22);';
      const fill = document.createElement('div');
      fill.style.cssText = `height:100%;width:${Math.round(stats.ratio * 100)}%;border-radius:2px;background:${occupancyColor(stats.ratio, theme)};`;
      bar.appendChild(fill);
      el.appendChild(bar);
    } else {
      const note = document.createElement('div');
      note.textContent = '实时占用数据尚未接入';
      note.style.cssText = `margin-top:6px;font-size:11px;color:${theme.tooltipMuted};`;
      el.appendChild(note);
    }

    if (station.approx) {
      const approx = document.createElement('div');
      approx.textContent = '位置为估算';
      approx.style.cssText = `margin-top:5px;font-size:10.5px;color:${theme.tooltipMuted};`;
      el.appendChild(approx);
    }

    this._tooltipStationId = station.id;
    this._positionTooltip(x, y);
    void el.offsetWidth;
    el.style.opacity = '1';
  }

  _positionTooltip(x, y) {
    const el = this._tooltip;
    const parent = this.canvas.parentElement;
    if (!el || !parent) return;
    const canvasRect = this.canvas.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const offX = canvasRect.left - parentRect.left;
    const offY = canvasRect.top - parentRect.top;
    const tw = el.offsetWidth || 180;
    const th = el.offsetHeight || 64;
    let left = offX + x + 14;
    let top = offY + y - th - 18;
    if (left + tw > offX + canvasRect.width - 6) left = offX + x - tw - 14;
    if (left < offX + 6) left = offX + 6;
    if (top < offY + 6) top = offY + y + 16;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  _refreshTooltip() {
    if (this._tooltipStationId == null) return;
    const el = this._tooltip;
    if (!el || el.style.display === 'none') return;
    const station = this._byId.get(this._tooltipStationId);
    if (!station) {
      this._tooltipStationId = null;
      this._hideTooltip();
      return;
    }
    this._showTooltipForStation(station, true);
  }

  _hideTooltip() {
    if (this._tooltip) {
      this._tooltip.style.opacity = '0';
      this._tooltip.style.display = 'none';
    }
    this._tooltipStationId = null;
  }

  /* ------------------------------------------------------------------ */
  /* 比例尺与版权                                                        */
  /* ------------------------------------------------------------------ */

  _drawScaleBar(ctx, view, w, h) {
    if (w < 260) return;
    const center = unprojectPoint(view.cx, view.cy);
    const mpp = metersPerPixel(center[1], view.scale);
    const targetPx = clamp(w * 0.16, 64, 150);
    const meters = niceDistance(targetPx * mpp);
    const px = Math.max(24, meters / mpp);
    const x = 14;
    const inset = Number.isFinite(this.options.overlayInset) ? this.options.overlayInset : 96;
    const y = h - inset;
    const theme = this.theme;
    ctx.save();
    ctx.strokeStyle = theme.scaleBar;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y);
    ctx.lineTo(x + px, y);
    ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.font = `500 10px ${LABEL_FONT_STACK}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const text = meters >= 1000
      ? `${Number((meters / 1000).toFixed(1))} 公里`
      : `${meters} 米`;
    ctx.strokeStyle = theme.labelHalo;
    ctx.lineWidth = 3;
    ctx.strokeText(text, x, y - 6);
    ctx.fillStyle = theme.scaleBar;
    ctx.fillText(text, x, y - 6);
    ctx.restore();
  }

  _drawAttribution(ctx, w, h) {
    const theme = this.theme;
    const text = '底图 © OpenStreetMap 贡献者';
    const inset = Number.isFinite(this.options.overlayInset) ? this.options.overlayInset : 96;
    const y = h - inset;
    ctx.save();
    ctx.font = `500 9.5px ${LABEL_FONT_STACK}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.strokeStyle = theme.labelHalo;
    ctx.lineWidth = 3;
    ctx.strokeText(text, w - 10, y);
    ctx.fillStyle = theme.attribution;
    ctx.fillText(text, w - 10, y);
    ctx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* 手势：拖拽 / 双指缩放 / 滚轮                                        */
  /* ------------------------------------------------------------------ */

  _eventPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const pt = this._eventPoint(e);
    this._pointers.set(e.pointerId, pt);
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    this._cancelAnimation();
    this._gesturing = true;

    if (this._pointers.size === 1) {
      this._drag = {
        pointerId: e.pointerId,
        startX: pt.x,
        startY: pt.y,
        lastX: pt.x,
        lastY: pt.y,
        moved: false,
        time: Date.now(),
        type: e.pointerType,
      };
      this._pinch = null;
      this.canvas.style.cursor = 'grabbing';
    } else if (this._pointers.size === 2) {
      this._drag = null;
      this._startPinch();
    }
    this._hideTooltip();
    if (e.pointerType === 'mouse' && typeof this.canvas.focus === 'function') {
      try { this.canvas.focus({ preventScroll: true }); } catch (_) { /* 忽略 */ }
    }
  }

  _startPinch() {
    const pts = [...this._pointers.values()];
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    this._pinch = {
      dist,
      zoom: this._zoom,
      world: this._screenToWorld(mx, my),
    };
  }

  _handlePinch() {
    if (!this._pinch) return;
    const pts = [...this._pointers.values()].slice(0, 2);
    const a = pts[0];
    const b = pts[1];
    if (!a || !b) return;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    this._zoom = clamp(
      this._pinch.zoom + Math.log2(dist / this._pinch.dist),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    const scale = this._baseScale * Math.pow(2, this._zoom);
    this._usingFit = false;
    this._center = {
      x: this._pinch.world.x - (mx - this._size.w / 2) / scale,
      y: this._pinch.world.y - (my - this._size.h / 2) / scale,
    };
    this._requestDraw();
  }

  _onPointerMove(e) {
    const pt = this._eventPoint(e);
    if (!this._pointers.has(e.pointerId)) {
      if (e.pointerType === 'mouse') this._onHover(pt.x, pt.y);
      return;
    }
    this._pointers.set(e.pointerId, pt);
    if (this._pointers.size >= 2 && this._pinch) {
      this._handlePinch();
      return;
    }
    const drag = this._drag;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const dx = pt.x - drag.lastX;
    const dy = pt.y - drag.lastY;
    if (!drag.moved && Math.hypot(pt.x - drag.startX, pt.y - drag.startY) > 4) {
      drag.moved = true;
    }
    drag.lastX = pt.x;
    drag.lastY = pt.y;
    if (!drag.moved) return;
    const view = this.view;
    this._center = {
      x: this._center.x - dx / view.scale,
      y: this._center.y - dy / view.scale,
    };
    this._usingFit = false;
    this._requestDraw();
  }

  _onPointerUp(e) {
    const had = this._pointers.delete(e.pointerId);
    try { this.canvas.releasePointerCapture(e.pointerId); } catch (_) { /* 忽略 */ }
    if (!had) return;

    if (this._pinch && this._pointers.size < 2) {
      this._pinch = null;
      if (this._pointers.size === 1) {
        const entry = [...this._pointers.entries()][0];
        const [id, pt] = entry;
        this._drag = {
          pointerId: id,
          startX: pt.x,
          startY: pt.y,
          lastX: pt.x,
          lastY: pt.y,
          moved: true,
          time: Date.now(),
          type: 'touch',
        };
      }
    }

    const drag = this._drag;
    if (drag && drag.pointerId === e.pointerId) {
      this._drag = null;
      if (e.type !== 'pointercancel' && !drag.moved && Date.now() - drag.time < 700) {
        const pt = this._eventPoint(e);
        const hit = this._hitTest(pt.x, pt.y);
        this._select(hit ? hit.id : null);
      }
    }

    if (this._pointers.size === 0) {
      this.canvas.style.cursor = 'grab';
      this._finishGesture();
    } else {
      this._requestDraw();
    }
  }

  _finishGesture() {
    this._gesturing = false;
    if (this._gestureTimer) clearTimeout(this._gestureTimer);
    this._gestureTimer = setTimeout(() => {
      this._gestureTimer = 0;
      this._requestDraw();
    }, 0);
  }

  _onPointerLeave() {
    if (this._pointers.size) return;
    let changed = false;
    if (this.hoveredId != null) {
      this.hoveredId = null;
      changed = true;
    }
    if (this._tooltipStationId != null && this._tooltipStationId !== this.selectedId) {
      this._hideTooltip();
    }
    if (changed) this._requestDraw();
  }

  _onHover(x, y) {
    const hit = this._hitTest(x, y);
    const id = hit ? hit.id : null;
    if (id !== this.hoveredId) {
      this.hoveredId = id;
      this.canvas.style.cursor = id ? 'pointer' : 'grab';
      this._requestDraw();
    }
    if (hit) {
      this._showTooltip(hit, x, y, false);
    } else if (this.selectedId != null) {
      if (this._tooltipStationId !== this.selectedId) {
        this._showTooltipForStation(this._byId.get(this.selectedId));
      }
    } else if (this._tooltipStationId != null) {
      this._hideTooltip();
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const pt = this._eventPoint(e);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this._size.h : 1;
    const dy = e.deltaY * unit;
    if (!dy) return;
    const delta = clamp(-dy * 0.0022, -0.9, 0.9);
    const target = clamp(this._zoom + delta, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(target - this._zoom) < 1e-5) return;

    this._cancelAnimation();
    const world = this._screenToWorld(pt.x, pt.y);
    this._zoom = target;
    const scale = this._baseScale * Math.pow(2, this._zoom);
    this._usingFit = false;
    this._center = {
      x: world.x - (pt.x - this._size.w / 2) / scale,
      y: world.y - (pt.y - this._size.h / 2) / scale,
    };

    this._gesturing = true;
    if (this._gestureTimer) clearTimeout(this._gestureTimer);
    this._gestureTimer = setTimeout(() => {
      this._gestureTimer = 0;
      this._gesturing = false;
      this._cache.clear();
      this._requestDraw();
    }, 180);
    this._hideTooltip();
    this._requestDraw();
  }

  _onDoubleClick(e) {
    e.preventDefault();
    const pt = this._eventPoint(e);
    this._zoomAround(pt.x, pt.y, 1);
  }

  _zoomAround(screenX, screenY, delta) {
    const target = clamp(this._zoom + delta, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(target - this._zoom) < 1e-5) return;
    const world = this._screenToWorld(screenX, screenY);
    this._cancelAnimation();
    this._zoom = target;
    const scale = this._baseScale * Math.pow(2, this._zoom);
    this._usingFit = false;
    this._center = {
      x: world.x - (screenX - this._size.w / 2) / scale,
      y: world.y - (screenY - this._size.h / 2) / scale,
    };
    this._requestDraw();
  }

  _onKeyDown(e) {
    const step = 56;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft': this._panBy(-step, 0); break;
      case 'ArrowRight': this._panBy(step, 0); break;
      case 'ArrowUp': this._panBy(0, -step); break;
      case 'ArrowDown': this._panBy(0, step); break;
      case '+':
      case '=': this.zoomIn(); break;
      case '-':
      case '_': this.zoomOut(); break;
      case 'Home': this.resetView(); break;
      case 'Escape': this._select(null); break;
      default: handled = false;
    }
    if (handled) e.preventDefault();
  }

  _panBy(dx, dy) {
    const view = this.view;
    this._cancelAnimation();
    this._center = {
      x: this._center.x + dx / view.scale,
      y: this._center.y + dy / view.scale,
    };
    this._usingFit = false;
    this._requestDraw();
  }
}

/* ------------------------------------------------------------------ */
/* 模块级工具                                                          */
/* ------------------------------------------------------------------ */

/* 图钉路径：锚点在 (0,0)，针尖朝下，头部圆心在 (0, -1.6r)。 */
function tracePin(ctx, r) {
  const headY = -r * 1.6;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(-r * 0.22, -r * 0.55, -r, -r * 1.05, -r, headY);
  ctx.arc(0, headY, r, Math.PI, 0, false);
  ctx.bezierCurveTo(r, -r * 1.05, r * 0.22, -r * 0.55, 0, 0);
  ctx.closePath();
}

/* 比例尺取整：返回不超过给定米数的“好看”刻度。 */
function niceDistance(maxMeters) {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  let best = steps[0];
  for (const step of steps) {
    if (step <= maxMeters) best = step;
  }
  return best;
}
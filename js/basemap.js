/**
 * 津电云 · 离线矢量底图
 * ------------------------------------------------------------------
 * 纯 ES module，零依赖。负责：
 *   1. 读取 data/basemap.json；
 *   2. 经纬度 ⇄ Web Mercator 世界坐标 ⇄ 画布像素的投影换算；
 *   3. 以制图风格绘制校园边界、绿地/水域/运动场、道路、建筑与注记。
 *
 * 坐标约定：
 *   - 经纬度一律 [lon, lat]（GeoJSON 顺序）；
 *   - 世界坐标为 Web Mercator 弧度（x = lon·π/180）；
 *   - 视口 view = { cx, cy, scale }，scale 为“每世界单位多少 CSS 像素”，
 *     屏幕坐标 = (world - center) * scale + 画布中心。
 *
 * 静态图层由 MapView 缓存到离屏 canvas；本模块只做无状态绘制。
 */

const DEG = Math.PI / 180;
const EARTH_RADIUS = 6378137;

/* ------------------------------------------------------------------ */
/* 投影与视口                                                          */
/* ------------------------------------------------------------------ */

/** 经纬度 → Web Mercator 世界坐标（弧度）。 */
export function projectLonLat(lon, lat) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  return {
    x: lon * DEG,
    y: Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2)),
  };
}

/** 世界坐标 → 经纬度。 */
export function unprojectPoint(x, y) {
  return [
    x / DEG,
    (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG,
  ];
}

/** 经纬度 bbox [minLon, minLat, maxLon, maxLat] → 世界坐标 bbox。 */
export function bboxToWorld(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const a = projectLonLat(minLon, minLat);
  const b = projectLonLat(maxLon, maxLat);
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

/** 计算让 bbox 完整落在画布内的视口。 */
export function fitView(bbox, width, height, padding = 28) {
  const wb = bboxToWorld(bbox);
  const availW = Math.max(40, width - padding * 2);
  const availH = Math.max(40, height - padding * 2);
  const spanX = Math.max(1e-9, wb.maxX - wb.minX);
  const spanY = Math.max(1e-9, wb.maxY - wb.minY);
  const scale = Math.min(availW / spanX, availH / spanY);
  return {
    cx: (wb.minX + wb.maxX) / 2,
    cy: (wb.minY + wb.maxY) / 2,
    scale,
  };
}

/** 某一纬度下、指定 scale 时 1 CSS 像素对应的地面米数（用于比例尺）。 */
export function metersPerPixel(lat, scale) {
  return (1 / Math.max(1e-9, scale)) * EARTH_RADIUS * Math.cos(lat * DEG);
}

/* ------------------------------------------------------------------ */
/* 主题                                                                */
/* ------------------------------------------------------------------ */

export const LIGHT_THEME = {
  bg: '#edf1e8',
  campus: '#e4ebd7',
  water: '#9ecfe4',
  waterEdge: '#83bcd2',
  park: '#c8e2b4',
  grass: '#d7e7c4',
  forest: '#bcd6a6',
  pitch: '#cfe0b6',
  pitchLine: '#ffffff',
  building: '#ddd8c9',
  buildingEdge: '#b8af9d',
  roadCasing: '#c9c2b2',
  roadMajor: '#ffffff',
  roadMinor: '#fbfaf6',
  roadService: '#f4f1e9',
  pedestrian: '#ece6d7',
  cycleway: '#c8dfb5',
  path: '#b3a78f',
  boundary: '#5f8452',
  label: '#36402f',
  labelHalo: 'rgba(250,252,247,0.92)',
  roadLabel: '#5f6a59',
  pinFree: '#1f9d63',
  pinMid: '#e09a1a',
  pinFull: '#d64545',
  pinUnknown: '#6b7a87',
  pinEdge: 'rgba(0,0,0,0.22)',
  pinText: '#ffffff',
  tooltipBg: 'rgba(255,255,255,0.97)',
  tooltipFg: '#1f2a24',
  tooltipMuted: '#5c6b62',
  tooltipBorder: 'rgba(0,0,0,0.08)',
  scaleBar: '#3d4839',
  attribution: 'rgba(61,72,57,0.62)',
};

export const DARK_THEME = {
  bg: '#121815',
  campus: '#17201a',
  water: '#173542',
  waterEdge: '#1e4657',
  park: '#1b2c1f',
  grass: '#1a271d',
  forest: '#172219',
  pitch: '#223327',
  pitchLine: '#7fa88c',
  building: '#2a322c',
  buildingEdge: '#46544b',
  roadCasing: '#0d1210',
  roadMajor: '#37423a',
  roadMinor: '#313a33',
  roadService: '#2b342d',
  pedestrian: '#2c332d',
  cycleway: '#2e4636',
  path: '#3a3a33',
  boundary: '#5c8a6a',
  label: '#c6d5c9',
  labelHalo: 'rgba(12,17,14,0.82)',
  roadLabel: '#93a497',
  pinFree: '#2fbf7f',
  pinMid: '#f0b23a',
  pinFull: '#f06a5e',
  pinUnknown: '#7c8a97',
  pinEdge: 'rgba(0,0,0,0.4)',
  pinText: '#ffffff',
  tooltipBg: 'rgba(24,31,27,0.98)',
  tooltipFg: '#e8efe9',
  tooltipMuted: '#9fb0a4',
  tooltipBorder: 'rgba(255,255,255,0.12)',
  scaleBar: '#c6d5c9',
  attribution: 'rgba(198,213,201,0.55)',
};

const THEME_VARS = {
  bg: '--map-bg',
  campus: '--map-campus',
  water: '--map-water',
  waterEdge: '--map-water-edge',
  park: '--map-park',
  grass: '--map-grass',
  forest: '--map-forest',
  pitch: '--map-pitch',
  pitchLine: '--map-pitch-line',
  building: '--map-building',
  buildingEdge: '--map-building-edge',
  roadCasing: '--map-road-casing',
  roadMajor: '--map-road-major',
  roadMinor: '--map-road-minor',
  roadService: '--map-road-service',
  pedestrian: '--map-pedestrian',
  cycleway: '--map-cycleway',
  path: '--map-path',
  boundary: '--map-boundary',
  label: '--map-label',
  labelHalo: '--map-label-halo',
  roadLabel: '--map-road-label',
  pinFree: '--map-pin-free',
  pinMid: '--map-pin-mid',
  pinFull: '--map-pin-full',
  pinUnknown: '--map-pin-unknown',
  pinEdge: '--map-pin-edge',
  pinText: '--map-pin-text',
  tooltipBg: '--map-tooltip-bg',
  tooltipFg: '--map-tooltip-fg',
  tooltipMuted: '--map-tooltip-muted',
  tooltipBorder: '--map-tooltip-border',
  scaleBar: '--map-scale-bar',
  attribution: '--map-attribution',
};

/**
 * 解析主题：先跟随 prefers-color-scheme 选默认明/暗色，再用宿主页面上
 * canvas 继承到的 --map-* 自定义属性逐项覆盖，最后叠加调用方覆盖值。
 */
export function resolveTheme(canvas, overrides) {
  let dark = false;
  try {
    dark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (_) { /* 非浏览器环境忽略 */ }
  const theme = Object.assign({}, dark ? DARK_THEME : LIGHT_THEME);
  if (canvas && typeof getComputedStyle === 'function') {
    let cs = null;
    try { cs = getComputedStyle(canvas); } catch (_) { cs = null; }
    if (cs) {
      for (const key of Object.keys(THEME_VARS)) {
        const val = cs.getPropertyValue(THEME_VARS[key]).trim();
        if (val) theme[key] = val;
      }
    }
  }
  if (overrides) Object.assign(theme, overrides);
  return theme;
}

/* ------------------------------------------------------------------ */
/* 几何预处理                                                          */
/* ------------------------------------------------------------------ */

function projectRing(poly) {
  const n = poly.length;
  const pts = new Float64Array(n * 2);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = projectLonLat(poly[i][0], poly[i][1]);
    const j = i * 2;
    pts[j] = p.x;
    pts[j + 1] = p.y;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { pts, minX, minY, maxX, maxY };
}

function ringMetrics(geom) {
  const p = geom.pts;
  const n = p.length / 2;
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = p[i * 2];
    const yi = p[i * 2 + 1];
    const xj = p[j * 2];
    const yj = p[j * 2 + 1];
    const cross = xi * yj - xj * yi;
    area2 += cross;
    cx += (xi + xj) * cross;
    cy += (yi + yj) * cross;
  }
  const area = area2 / 2;
  let centroid;
  if (Math.abs(area) < 1e-18) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) { sx += p[i * 2]; sy += p[i * 2 + 1]; }
    centroid = { x: sx / n, y: sy / n };
  } else {
    centroid = { x: cx / (6 * area), y: cy / (6 * area) };
  }
  return { area: Math.abs(area), centroid };
}

function traceRing(ctx, pts, s) {
  ctx.beginPath();
  ctx.moveTo((pts[0] - s.cx) * s.scale + s.ox, (pts[1] - s.cy) * s.scale + s.oy);
  for (let i = 2; i < pts.length; i += 2) {
    ctx.lineTo((pts[i] - s.cx) * s.scale + s.ox, (pts[i + 1] - s.cy) * s.scale + s.oy);
  }
  ctx.closePath();
}

function traceLine(ctx, pts, s) {
  ctx.beginPath();
  ctx.moveTo((pts[0] - s.cx) * s.scale + s.ox, (pts[1] - s.cy) * s.scale + s.oy);
  for (let i = 2; i < pts.length; i += 2) {
    ctx.lineTo((pts[i] - s.cx) * s.scale + s.ox, (pts[i + 1] - s.cy) * s.scale + s.oy);
  }
}

/* 屏幕空间矩形相交检测（注记避让用）。 */
function rectsOverlap(a, b) {
  return a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
}

/* 道路类别 → 制图样式。width 为 CSS 像素基准值。 */
const ROAD_STYLES = {
  tertiary:      { width: 6.6, casing: 2.6, color: 'roadMajor' },
  unclassified:  { width: 5.4, casing: 2.2, color: 'roadMinor' },
  residential:   { width: 5.0, casing: 2.1, color: 'roadMajor' },
  living_street: { width: 4.4, casing: 1.9, color: 'roadMinor' },
  service:       { width: 3.4, casing: 1.7, color: 'roadService' },
  pedestrian:    { width: 3.4, casing: 0,   color: 'pedestrian' },
  cycleway:      { width: 2.4, casing: 0.9, color: 'cycleway' },
  footway:       { width: 1.5, casing: 0,   color: 'path', dash: [2.5, 2.5] },
  path:          { width: 1.4, casing: 0,   color: 'path', dash: [3, 3] },
  steps:         { width: 2.0, casing: 0,   color: 'path', dash: [1, 2] },
  track:         { width: 1.6, casing: 0,   color: 'path', dash: [5, 4] },
};

const CASED_ROADS = new Set(['tertiary', 'unclassified', 'residential', 'living_street', 'service']);

const AREA_STYLE = { grass: 'grass', forest: 'forest', park: 'park' };

const LABEL_FONT_STACK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, -apple-system, sans-serif';

/* ------------------------------------------------------------------ */
/* BasemapRenderer                                                     */
/* ------------------------------------------------------------------ */

export class BasemapRenderer {
  /** @param {object} basemap data/basemap.json 解析后的对象 */
  constructor(basemap) {
    this.basemap = basemap || {};
    this.bbox = this.basemap.bbox || [0, 0, 0, 0];
    this.boundary = (this.basemap.boundary || []).map(projectRing);
    this.areas = (this.basemap.areas || []).map((a) => {
      const geom = projectRing(a.poly);
      return Object.assign({ kind: a.kind || 'grass' }, geom);
    });
    this.sports = (this.basemap.sports || []).map((s) => {
      const geom = projectRing(s.poly);
      return Object.assign({ sport: s.sport || '' }, geom);
    });
    this.roads = (this.basemap.roads || []).map((r) => {
      const geom = projectRing(r.line);
      return Object.assign({ cls: r.class || 'residential', name: r.name || '' }, geom);
    });
    this.buildings = [];
    for (const b of this.basemap.buildings || []) {
      const geom = projectRing(b.poly);
      const m = ringMetrics(geom);
      this.buildings.push(Object.assign({
        name: b.name || '',
        area: m.area,
        centroid: m.centroid,
      }, geom));
    }
    this._buildLabelAnchors();
    this._buildRoadLabelCandidates();
  }

  /* 同名建筑（如平园两翼、克拉酒店两栋）合并为一个注记锚点。 */
  _buildLabelAnchors() {
    const groups = new Map();
    for (const b of this.buildings) {
      if (!b.name) continue;
      let g = groups.get(b.name);
      if (!g) {
        g = { name: b.name, weight: 0, x: 0, y: 0, area: 0, bbox: [Infinity, Infinity, -Infinity, -Infinity] };
        groups.set(b.name, g);
      }
      const w = Math.max(b.area, 1e-12);
      g.weight += w;
      g.x += b.centroid.x * w;
      g.y += b.centroid.y * w;
      g.area += b.area;
      g.bbox[0] = Math.min(g.bbox[0], b.minX);
      g.bbox[1] = Math.min(g.bbox[1], b.minY);
      g.bbox[2] = Math.max(g.bbox[2], b.maxX);
      g.bbox[3] = Math.max(g.bbox[3], b.maxY);
    }
    this.labelAnchors = [...groups.values()].map((g) => ({
      name: g.name,
      x: g.x / Math.max(g.weight, 1e-12),
      y: g.y / Math.max(g.weight, 1e-12),
      area: g.area,
      bbox: g.bbox,
    }));
  }

  _buildRoadLabelCandidates() {
    const best = new Map();
    for (const r of this.roads) {
      if (!r.name) continue;
      const prev = best.get(r.name);
      const span = Math.hypot(r.maxX - r.minX, r.maxY - r.minY);
      if (!prev || span > prev.span) best.set(r.name, { road: r, span });
    }
    this.roadLabels = [...best.values()].map((v) => v.road);
  }

  /**
   * 绘制静态底图。调用方负责设置 DPR 变换；这里的坐标均为 CSS 像素。
   * @param {CanvasRenderingContext2D} ctx
   * @param {{cx:number, cy:number, scale:number}} view
   * @param {{width:number, height:number, theme:object, zoom?:number}} opts
   *        zoom 为相对“全校区适配”的对数级别（0 = 适配全览）。
   */
  renderStatic(ctx, view, opts) {
    const width = opts.width;
    const height = opts.height;
    const theme = opts.theme || LIGHT_THEME;
    const zoom = Number.isFinite(opts.zoom) ? opts.zoom : 0;
    const scale = view.scale;
    const ox = width / 2;
    const oy = height / 2;
    const zoomFactor = Math.min(1.9, Math.max(0.85, 1 + zoom * 0.22));

    const scr = { cx: view.cx, cy: view.cy, scale, ox, oy };
    const isVisible = (g, pad) => {
      const x0 = (g.minX - view.cx) * scale + ox;
      const x1 = (g.maxX - view.cx) * scale + ox;
      const y0 = (g.minY - view.cy) * scale + oy;
      const y1 = (g.maxY - view.cy) * scale + oy;
      return x1 >= -pad && y1 >= -pad && x0 <= width + pad && y0 <= height + pad;
    };

    ctx.save();

    /* 背景 */
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, width, height);

    /* 校园范围底色 */
    ctx.fillStyle = theme.campus;
    for (const ring of this.boundary) {
      if (!isVisible(ring, 4)) continue;
      traceRing(ctx, ring.pts, scr);
      ctx.fill();
    }

    /* 绿地 / 水域 */
    for (const a of this.areas) {
      if (!isVisible(a, 4)) continue;
      if (a.kind === 'water') continue; // 水域放到最后，压在绿地之上
      const colorKey = AREA_STYLE[a.kind];
      if (!colorKey) continue;
      ctx.fillStyle = theme[colorKey];
      traceRing(ctx, a.pts, scr);
      ctx.fill();
    }
    for (const a of this.areas) {
      if (a.kind !== 'water' || !isVisible(a, 4)) continue;
      ctx.fillStyle = theme.water;
      traceRing(ctx, a.pts, scr);
      ctx.fill();
      ctx.strokeStyle = theme.waterEdge;
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }

    /* 运动场地 */
    if (this.sports.length) {
      ctx.fillStyle = theme.pitch;
      ctx.strokeStyle = theme.pitchLine;
      ctx.globalAlpha = 0.65;
      ctx.lineWidth = 0.8;
      for (const s of this.sports) {
        if (!isVisible(s, 4)) continue;
        traceRing(ctx, s.pts, scr);
        ctx.fill();
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    /* 道路：先描边（casing）再填面，保证交叉口干净 */
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const pass of ['casing', 'fill']) {
      for (const road of this.roads) {
        const style = ROAD_STYLES[road.cls];
        if (!style || !CASED_ROADS.has(road.cls)) continue;
        if (pass === 'casing' && !style.casing) continue;
        if (!isVisible(road, 30)) continue;
        traceLine(ctx, road.pts, scr);
        if (pass === 'casing') {
          ctx.strokeStyle = theme.roadCasing;
          ctx.lineWidth = style.width * zoomFactor + style.casing;
        } else {
          ctx.strokeStyle = theme[style.color];
          ctx.lineWidth = style.width * zoomFactor;
        }
        ctx.stroke();
      }
    }

    /* 建筑 */
    for (const b of this.buildings) {
      if (!isVisible(b, 4)) continue;
      traceRing(ctx, b.pts, scr);
      ctx.fillStyle = theme.building;
      ctx.fill();
      ctx.strokeStyle = theme.buildingEdge;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }

    /* 慢行路 / 人行路 / 台阶：画在建筑之上，保证广场与求是大道贯通 */
    for (const road of this.roads) {
      const style = ROAD_STYLES[road.cls];
      if (!style || CASED_ROADS.has(road.cls)) continue;
      if (!isVisible(road, 24)) continue;
      if (road.cls === 'cycleway' && style.casing) {
        traceLine(ctx, road.pts, scr);
        ctx.strokeStyle = theme.roadCasing;
        ctx.lineWidth = style.width * zoomFactor + style.casing;
        ctx.stroke();
      }
      traceLine(ctx, road.pts, scr);
      ctx.strokeStyle = theme[style.color];
      ctx.lineWidth = Math.max(1, style.width * zoomFactor);
      ctx.setLineDash(style.dash || []);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* 校园边界线（覆盖在建筑之上） */
    ctx.strokeStyle = theme.boundary;
    ctx.lineWidth = 1.6;
    ctx.setLineDash([7, 3, 2, 3]);
    for (const ring of this.boundary) {
      if (!isVisible(ring, 10)) continue;
      traceRing(ctx, ring.pts, scr);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    /* 注记 */
    const labelBoxes = [];
    this._drawBuildingLabels(ctx, view, width, height, theme, zoom, labelBoxes);
    this._drawRoadLabels(ctx, view, width, height, theme, zoom, labelBoxes);

    ctx.restore();
  }

  /* 建筑名注记：按面积从大到小排布，互相避让。 */
  _drawBuildingLabels(ctx, view, width, height, theme, zoom, boxes) {
    if (zoom < 0.7) return;
    const scale = view.scale;
    const ox = width / 2;
    const oy = height / 2;
    const fontSize = zoom > 2.2 ? 12.5 : zoom > 1.4 ? 11.5 : 10.5;
    ctx.font = `500 ${fontSize}px ${LABEL_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    const anchors = this.labelAnchors.slice().sort((a, b) => b.area - a.area);
    for (const a of anchors) {
      const sx = (a.x - view.cx) * scale + ox;
      const sy = (a.y - view.cy) * scale + oy;
      if (sx < -100 || sy < -40 || sx > width + 100 || sy > height + 40) continue;
      const screenArea = a.area * scale * scale;
      const minArea = zoom < 1.2 ? 1600 : 460;
      if (screenArea < minArea) continue;
      const textW = ctx.measureText(a.name).width;
      if (textW > 280) continue;
      const padX = 3;
      const boxH = fontSize + 2;
      const box = [sx - textW / 2 - padX, sy - boxH / 2, sx + textW / 2 + padX, sy + boxH / 2];
      if (box[0] < 2 || box[2] > width - 2 || box[1] < 2 || box[3] > height - 2) continue;
      let collide = false;
      for (const b of boxes) {
        if (rectsOverlap(box, b)) { collide = true; break; }
      }
      if (collide) continue;
      boxes.push(box);

      ctx.strokeStyle = theme.labelHalo;
      ctx.lineWidth = 3;
      ctx.strokeText(a.name, sx, sy);
      ctx.fillStyle = theme.label;
      ctx.fillText(a.name, sx, sy);
    }
  }

  /* 道路名注记：沿最长命名路段中点、按走向旋转。 */
  _drawRoadLabels(ctx, view, width, height, theme, zoom, boxes) {
    if (zoom < 2.0) return;
    const scale = view.scale;
    const ox = width / 2;
    const oy = height / 2;
    const fontSize = 10;
    ctx.font = `500 ${fontSize}px ${LABEL_FONT_STACK}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const road of this.roadLabels) {
      const pts = road.pts;
      const n = pts.length / 2;
      const segs = [];
      let total = 0;
      for (let i = 0; i < n - 1; i++) {
        const x1 = pts[i * 2];
        const y1 = pts[i * 2 + 1];
        const x2 = pts[(i + 1) * 2];
        const y2 = pts[(i + 1) * 2 + 1];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len <= 0) continue;
        segs.push([x1, y1, x2, y2, len]);
        total += len;
      }
      if (!segs.length || total * scale < 130) continue;

      const target = total / 2;
      let acc = 0;
      let seg = segs[segs.length - 1];
      for (const s of segs) {
        if (acc + s[4] >= target) { seg = s; break; }
        acc += s[4];
      }
      const t = Math.max(0, Math.min(1, (target - acc) / seg[4]));
      const wx = seg[0] + (seg[2] - seg[0]) * t;
      const wy = seg[1] + (seg[3] - seg[1]) * t;
      const sx = (wx - view.cx) * scale + ox;
      const sy = (wy - view.cy) * scale + oy;
      if (sx < -60 || sy < -30 || sx > width + 60 || sy > height + 30) continue;

      let angle = Math.atan2(seg[3] - seg[1], seg[2] - seg[0]);
      if (angle > Math.PI / 2) angle -= Math.PI;
      else if (angle < -Math.PI / 2) angle += Math.PI;

      const textW = ctx.measureText(road.name).width;
      const sin = Math.abs(Math.sin(angle));
      const cos = Math.abs(Math.cos(angle));
      const halfW = (textW * cos + fontSize * sin) / 2 + 3;
      const halfH = (textW * sin + fontSize * cos) / 2 + 2;
      const box = [sx - halfW, sy - halfH, sx + halfW, sy + halfH];
      if (box[0] < 2 || box[2] > width - 2 || box[1] < 2 || box[3] > height - 2) continue;
      let collide = false;
      for (const b of boxes) {
        if (rectsOverlap(box, b)) { collide = true; break; }
      }
      if (collide) continue;
      boxes.push(box);

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angle);
      ctx.strokeStyle = theme.labelHalo;
      ctx.lineWidth = 3;
      ctx.strokeText(road.name, 0, 0);
      ctx.fillStyle = theme.roadLabel;
      ctx.fillText(road.name, 0, 0);
      ctx.restore();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */

/** 读取底图 JSON。 */
export async function loadBasemap(url = 'data/basemap.json') {
  const res = await fetch(url, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`底图加载失败：HTTP ${res.status}（${url}）`);
  return res.json();
}

export { ROAD_STYLES };
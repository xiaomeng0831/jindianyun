/**
 * 津电云 · 站点详情面板
 * ------------------------------------------------------------------
 * 零依赖 ES 模块。由 app.js 创建并驱动，自身只负责渲染与交互。
 *
 * 详情数据契约（mock-adapter 可选提供，缺省时优雅降级）：
 *   detail = {
 *     updatedAt: number | string | Date,            // 最后更新时间
 *     sockets: [
 *       { no: 1, status: 'charging' | 'idle' | 'fault', endTime: <毫秒|ISO 字符串> }
 *     ],
 *     cabinets: [
 *       { name: '锂电柜 1', status: 'ok', available: 4, total: 6 }
 *     ]
 *   }
 * 兼容：sockets 也可以是 ['charging', 'idle', ...]、{ "1": 'charging' }、
 *       或带 occupied / charging / fault 布尔字段的对象数组。
 */

const TYPE_LABEL = { bike: '电动自行车', car: '电动汽车' };
const STATUS_LABEL = { charging: '使用中', idle: '空闲', fault: '故障', unknown: '同步中' };
const STATUS_ORDER = ['charging', 'idle', 'fault', 'unknown'];

const STATUS_ALIASES = new Map([
  ['charging', 'charging'], ['charge', 'charging'], ['occupied', 'charging'],
  ['inuse', 'charging'], ['in-use', 'charging'], ['in_use', 'charging'],
  ['using', 'charging'], ['busy', 'charging'], ['占用', 'charging'],
  ['使用中', 'charging'], ['充电中', 'charging'],
  ['idle', 'idle'], ['free', 'idle'], ['available', 'idle'], ['空闲', 'idle'], ['可用', 'idle'],
  ['fault', 'fault'], ['error', 'fault'], ['broken', 'fault'], ['offline', 'fault'],
  ['故障', 'fault'], ['维修', 'fault'], ['维修中', 'fault'],
]);

const ICONS = {
  close: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M20.5 11a8.5 8.5 0 1 0-2.6 6.1M20.5 4.5V11h-6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cabinet: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="7" width="15" height="10" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M21 10.5v3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M8 10v4M11 10v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity=".55"/></svg>',
  plug: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M13 2 4.5 14H11l-1 8 8.5-12H12l1-8Z" fill="currentColor"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 3.6 2.6 5.3 5.9.85-4.25 4.14 1 5.86L12 17l-5.25 2.75 1-5.86L3.5 9.75l5.9-.85L12 3.6Z" fill="currentColor" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
};

/** 把任意状态写法归一为 charging / idle / fault / unknown */
export function normalizeStatus(value) {
  if (typeof value === 'boolean') return value ? 'charging' : 'idle';
  if (value == null) return 'unknown';
  const key = String(value).trim().toLowerCase().replace(/\s+/g, '');
  return STATUS_ALIASES.get(key) || 'unknown';
}

/** 把毫秒数、秒数、ISO 字符串、HH:mm 时间统一成毫秒时间戳 */
export function toTimestamp(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;          // 毫秒
    if (value > 1e9) return value * 1000;    // 秒
    return null;                             // 小数字（如剩余分钟）不当作时间戳
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{10,13}$/.test(trimmed)) return toTimestamp(Number(trimmed));
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
    const hm = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (hm) {
      const d = new Date();
      d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] || 0), 0);
      return d.getTime();
    }
  }
  return null;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

export function formatRemaining(ms) {
  if (ms == null || !Number.isFinite(ms)) return '';
  const minutes = Math.ceil(ms / 60000);
  if (minutes <= 0) return '即将结束';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function pad2(n) { return String(n).padStart(2, '0'); }

export function formatClock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatUpdated(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  if (sameDay) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatRelative(ts, now = Date.now()) {
  const diff = Math.max(0, now - ts);
  if (diff < 5000) return '刚刚更新';
  if (diff < 60000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  return formatClock(ts);
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null && value !== '') return value;
  return undefined;
}

function extractSocketNo(item, index) {
  const raw = firstDefined(item.no, item.index, item.number, item.socketNo, item.socket, item.port, item.id, item.label);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const parsed = parseInt(String(raw ?? '').replace(/[^\d]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : index + 1;
}

function extractEndTime(item) {
  const direct = firstDefined(
    item.endTime, item.endsAt, item.estimatedEndTime, item.estimateEndTime,
    item.expectedEndTime, item.expectedEnd, item.finishAt, item.finishTime,
    item.endAt, item.end,
  );
  const ts = toTimestamp(direct);
  if (ts != null) return ts;
  const remainingMinutes = firstDefined(item.remainingMinutes, item.remainingMin, item.remainMinutes);
  if (typeof remainingMinutes === 'number' && Number.isFinite(remainingMinutes)) {
    return Date.now() + remainingMinutes * 60000;
  }
  const remainingSeconds = firstDefined(item.remainingSeconds, item.remainingSec);
  if (typeof remainingSeconds === 'number' && Number.isFinite(remainingSeconds)) {
    return Date.now() + remainingSeconds * 1000;
  }
  return null;
}

/**
 * 把 station.sockets 数量与 adapter 的 detail 归一成插口数组。
 * 返回 [{ no, status, endTime }]，按插口号排序。
 */
export function normalizeSockets(station, detail) {
  const stationTotal = Math.max(0, Number(station?.sockets) || 0);
  const raw = Array.isArray(detail)
    ? detail
    : firstDefined(detail?.sockets, detail?.ports, detail?.plugs, detail?.outlets, detail?.socketStates);
  const sockets = [];

  if (Array.isArray(raw)) {
    raw.forEach((item, index) => {
      if (item == null) {
        sockets.push({ no: index + 1, status: 'unknown', endTime: null });
        return;
      }
      if (typeof item === 'string' || typeof item === 'number') {
        sockets.push({ no: index + 1, status: normalizeStatus(item), endTime: null });
        return;
      }
      let status = firstDefined(item.status, item.state, item.occupancy, item.situation);
      if (status === undefined && typeof item.occupied === 'boolean') status = item.occupied ? 'charging' : 'idle';
      if (status === undefined && typeof item.charging === 'boolean') status = item.charging ? 'charging' : 'idle';
      if (status === undefined && typeof item.fault === 'boolean' && item.fault) status = 'fault';
      sockets.push({
        no: extractSocketNo(item, index),
        status: normalizeStatus(status),
        endTime: extractEndTime(item),
        soc: typeof item.soc === 'number' && Number.isFinite(item.soc) ? Math.round(item.soc) : null,
      });
    });
  } else if (raw && typeof raw === 'object') {
    // 形如 { "1": "charging", "2": "idle" } 的映射
    const entries = Object.entries(raw)
      .map(([key, value]) => ({ key, value }))
      .filter(({ key }) => /^\d+$/.test(key))
      .sort((a, b) => Number(a.key) - Number(b.key));
    entries.forEach(({ key, value }, index) => {
      sockets.push({
        no: Number(key),
        status: normalizeStatus(typeof value === 'object' && value ? value.status : value),
        endTime: typeof value === 'object' && value ? extractEndTime(value) : null,
        soc: typeof value === 'object' && value && typeof value.soc === 'number' ? Math.round(value.soc) : null,
      });
    });
    if (!entries.length) {
      for (let i = 0; i < stationTotal; i += 1) sockets.push({ no: i + 1, status: 'unknown', endTime: null });
    }
  } else {
    for (let i = 0; i < stationTotal; i += 1) sockets.push({ no: i + 1, status: 'unknown', endTime: null });
  }

  return sockets.sort((a, b) => a.no - b.no);
}

/** 面板与列表共用的统计 */
export function summarizeStation(station, detail) {
  const sockets = normalizeSockets(station, detail);
  const summary = { total: sockets.length, charging: 0, idle: 0, fault: 0, unknown: 0, known: false };
  for (const socket of sockets) {
    if (socket.status === 'charging') { summary.charging += 1; summary.known = true; }
    else if (socket.status === 'idle') { summary.idle += 1; summary.known = true; }
    else if (socket.status === 'fault') { summary.fault += 1; summary.known = true; }
    else summary.unknown += 1;
  }
  return summary;
}

export class StationPanel {
  constructor(root, options = {}) {
    if (!root) throw new Error('StationPanel 需要一个根元素（#panel）');
    this.root = root;
    this.root.classList.add('panel');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.setAttribute('inert', '');
    this.onClose = options.onClose || null;
    this.onRefresh = options.onRefresh || null;
    this.onSocketSelect = options.onSocketSelect || null;
    this.onToggleFavorite = options.onToggleFavorite || null;
    this.isFavorite = options.isFavorite || null;

    this._station = null;
    this._detail = null;
    this._meta = {};
    this._selectedNo = null;
    this._sockets = [];
    this._lastDataAt = null;
    this._timer = null;
    this._dom = null;
    this._refreshing = false;

    this._handleClick = this._handleClick.bind(this);
    this._handleKeydown = this._handleKeydown.bind(this);
    this.root.addEventListener('click', this._handleClick);
    this.root.addEventListener('keydown', this._handleKeydown);
  }

  get isOpen() {
    return this.root.classList.contains('is-open');
  }

  get stationId() {
    return this._station?.id ?? null;
  }

  get station() {
    return this._station;
  }

  /* ---------------------------------------------------------------- DOM */

  _ensureDom() {
    if (this._dom) return this._dom;

    this.root.innerHTML = `
      <div class="panel-grabber" aria-hidden="true"><span></span></div>
      <div class="panel-head">
        <div class="panel-title">
          <div class="title-row">
            <span class="type-badge type-bike"></span>
            <h2 class="station-name" id="panel-title"></h2>
          </div>
          <p class="station-sub"></p>
        </div>
        <div class="panel-actions">
          <button type="button" class="icon-btn favorite-btn" data-action="favorite" aria-label="收藏常用站点" aria-pressed="false" title="收藏常用站点">${ICONS.star}</button>
          <button type="button" class="icon-btn panel-close" data-action="close" aria-label="关闭详情">${ICONS.close}</button>
        </div>
      </div>
      <div class="panel-body">
        <section class="stat-row" aria-label="插口统计"></section>
        <section class="section sockets-section">
          <div class="section-head">
            <h3>插口状态</h3>
            <span class="section-hint"></span>
          </div>
          <div class="socket-grid" role="group" aria-label="插口编号"></div>
          <div class="socket-detail" hidden></div>
        </section>
        <section class="section cabinets-section" hidden>
          <div class="section-head"><h3>锂电柜</h3><span class="section-hint"></span></div>
          <div class="cabinet-list"></div>
        </section>
        <section class="section trend-section" hidden>
          <div class="section-head">
            <h3>24 小时占用趋势</h3>
            <span class="section-hint trend-hint"></span>
          </div>
          <div class="trend-card">
            <div class="trend-bars" role="img" aria-label="24 小时预计占用率柱状图"></div>
            <div class="trend-axis" aria-hidden="true">
              <span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:00</span>
            </div>
            <p class="trend-advice"></p>
          </div>
        </section>
        <p class="station-note" hidden></p>
      </div>
      <div class="panel-foot">
        <div class="live-status" role="status">
          <span class="live-dot" aria-hidden="true"></span>
          <span class="live-text">实时刷新</span>
          <span class="live-sep" aria-hidden="true">·</span>
          <span class="updated">等待实时数据</span>
        </div>
        <button type="button" class="refresh-btn" data-action="refresh">
          <span class="refresh-icon">${ICONS.refresh}</span><span>刷新</span>
        </button>
      </div>`;

    const q = (selector) => this.root.querySelector(selector);

    this._dom = {
      grabber: q('.panel-grabber'),
      typeBadge: q('.type-badge'),
      name: q('.station-name'),
      sub: q('.station-sub'),
      favBtn: q('.favorite-btn'),
      body: q('.panel-body'),
      statRow: q('.stat-row'),
      socketsSection: q('.sockets-section'),
      socketHint: q('.sockets-section .section-hint'),
      grid: q('.socket-grid'),
      socketDetail: q('.socket-detail'),
      cabinetsSection: q('.cabinets-section'),
      cabinetHint: q('.cabinets-section .section-hint'),
      cabinetList: q('.cabinet-list'),
      trendSection: q('.trend-section'),
      trendHint: q('.trend-hint'),
      trendBars: q('.trend-bars'),
      trendAdvice: q('.trend-advice'),
      note: q('.station-note'),
      liveText: q('.live-text'),
      updated: q('.updated'),
      refreshBtn: q('.refresh-btn'),
    };

    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', '充电站详情');
    this.root.setAttribute('aria-hidden', 'true');
    this._bindDrag();
    return this._dom;
  }

  _bindDrag() {
    const grabber = this._dom.grabber;
    let dragging = false;
    let startY = 0;
    let delta = 0;

    grabber.addEventListener('pointerdown', (event) => {
      if (!window.matchMedia('(max-width: 899px)').matches) return;
      dragging = true;
      startY = event.clientY;
      delta = 0;
      this.root.classList.add('is-dragging');
      if (grabber.setPointerCapture) grabber.setPointerCapture(event.pointerId);
    });

    grabber.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      delta = Math.max(0, event.clientY - startY);
      this.root.style.transform = `translateY(${delta}px)`;
    });

    const finish = () => {
      if (!dragging) return;
      dragging = false;
      this.root.classList.remove('is-dragging');
      this.root.style.transform = '';
      if (delta > 90) this.close();
    };

    grabber.addEventListener('pointerup', finish);
    grabber.addEventListener('pointercancel', finish);
  }

  /* ------------------------------------------------------------- public */

  open(station, detail = null, meta = {}) {
    if (!station) return;
    const isSameStation = this._station?.id === station.id;
    this._station = station;
    this._detail = detail;
    this._meta = { ...meta };
    if (!isSameStation) this._selectedNo = null;
    this._lastDataAt = toTimestamp(meta.updatedAt) ?? toTimestamp(detail?.updatedAt) ?? Date.now();

    this._ensureDom();
    this._renderAll();
    this.root.classList.add('is-open');
    this.root.removeAttribute('inert');
    this.root.setAttribute('aria-hidden', 'false');
    this._dom.body.scrollTop = 0;
    this._startTimer();
  }

  setDetail(detail, meta = {}) {
    this._detail = detail;
    this._meta = { ...this._meta, ...meta };
    const ts = toTimestamp(meta.updatedAt) ?? toTimestamp(detail?.updatedAt);
    if (ts != null) this._lastDataAt = ts;
    if (!this._station) return;
    this._renderAll();
  }

  setMeta(meta = {}) {
    this._meta = { ...this._meta, ...meta };
    if (!this._station) return;
    this._renderFooter();
  }

  setRefreshing(refreshing) {
    this._refreshing = Boolean(refreshing);
    this.root.classList.toggle('is-refreshing', this._refreshing);
    this._dom?.refreshBtn?.classList.toggle('is-spinning', this._refreshing);
    if (this._dom?.liveText) this._dom.liveText.textContent = this._refreshing ? '刷新中…' : '实时刷新';
  }

  close() {
    if (!this._station) {
      this.root.classList.remove('is-open');
      return;
    }
    const wasOpen = this.isOpen;
    this.root.classList.remove('is-open');
    this.root.setAttribute('aria-hidden', 'true');
    this.root.setAttribute('inert', '');
    this.root.style.transform = '';
    this._stopTimer();
    this._station = null;
    this._detail = null;
    this._selectedNo = null;
    if (wasOpen && this.onClose) this.onClose();
  }

  destroy() {
    this._stopTimer();
    this.root.removeEventListener('click', this._handleClick);
    this.root.removeEventListener('keydown', this._handleKeydown);
    this.root.innerHTML = '';
    this.root.classList.remove('panel', 'is-open', 'is-refreshing');
    this._dom = null;
  }

  /* ------------------------------------------------------------- render */

  _renderAll() {
    const station = this._station;
    if (!station) return;
    const detail = this._detail;
    const dom = this._ensureDom();
    const type = station.type === 'car' ? 'car' : 'bike';

    dom.typeBadge.className = `type-badge type-${type}`;
    dom.typeBadge.textContent = TYPE_LABEL[type];
    dom.name.textContent = station.name || '未命名站点';

    const sockets = normalizeSockets(station, detail);
    this._sockets = sockets;

    const subParts = [];
    if (sockets.length) {
      subParts.push(station.socketsApprox ? `约 ${sockets.length} 个插口（预估）` : `${sockets.length} 个插口`);
    } else {
      subParts.push('插口数待采集');
    }
    const cabinetCount = this._getCabinetCount();
    if (cabinetCount) subParts.push(`${cabinetCount} 组锂电柜`);
    dom.sub.textContent = subParts.join(' · ');

    this._renderFavorite();
    this._renderStats(sockets);
    this._renderSockets(sockets);
    this._renderCabinets();
    this._renderTrend();
    this._renderNote();
    this._renderFooter();
  }

  _renderFavorite() {
    const dom = this._dom;
    if (!dom?.favBtn || !this._station) return;
    const fav = typeof this.isFavorite === 'function'
      ? Boolean(this.isFavorite(this._station.id))
      : Boolean(this._station.favorite);
    dom.favBtn.classList.toggle('is-active', fav);
    dom.favBtn.setAttribute('aria-pressed', String(fav));
    const label = fav ? '取消收藏该站点' : '收藏常用站点';
    dom.favBtn.setAttribute('aria-label', label);
    dom.favBtn.title = label;
  }

  _renderStats(sockets) {
    const dom = this._dom;
    const counts = { charging: 0, idle: 0, fault: 0, unknown: 0 };
    sockets.forEach((socket) => { counts[socket.status] = (counts[socket.status] || 0) + 1; });
    const hasKnown = counts.charging + counts.idle + counts.fault > 0;
    const tiles = [
      { key: 'charging', label: '使用中', value: hasKnown ? counts.charging : '—' },
      { key: 'idle', label: '空闲', value: hasKnown ? counts.idle : '—' },
      { key: 'fault', label: '故障', value: hasKnown ? counts.fault : '—' },
      { key: 'total', label: '插口总数', value: sockets.length || '—' },
    ];
    dom.statRow.innerHTML = tiles.map((tile) => {
      const muted = tile.key !== 'total' && (tile.value === 0 || tile.value === '—');
      return `
      <div class="stat stat-${tile.key}${muted ? ' is-zero' : ''}">
        <span class="stat-value">${tile.value}</span>
        <span class="stat-label">${tile.label}</span>
      </div>`;
    }).join('');
  }

  _renderSockets(sockets) {
    const dom = this._dom;
    const waiting = !this._detail && sockets.length > 0;
    dom.socketHint.textContent = waiting ? '正在同步实时状态…' : '点击插口查看预计结束时间';

    if (!sockets.length) {
      dom.socketHint.textContent = '暂无插口数据';
      dom.grid.innerHTML = `
        <div class="empty-state">
          <span class="empty-icon">${ICONS.plug}</span>
          <strong>插口信息待采集</strong>
          <span>该站点暂未录入插口数量，实时数据接入后将在这里显示。</span>
        </div>`;
      dom.socketDetail.hidden = true;
      dom.socketDetail.innerHTML = '';
      this._selectedNo = null;
      return;
    }

    if (this._selectedNo != null && !sockets.some((socket) => socket.no === this._selectedNo)) {
      this._selectedNo = null;
    }

    dom.grid.innerHTML = sockets.map((socket) => {
      const selected = socket.no === this._selectedNo;
      return `
        <button type="button"
          class="socket socket-${socket.status}${selected ? ' is-selected' : ''}${waiting ? ' is-waiting' : ''}"
          data-socket="${socket.no}"
          aria-pressed="${selected}"
          aria-label="${socket.no} 号插口，${STATUS_LABEL[socket.status]}"
          title="${socket.no} 号插口 · ${STATUS_LABEL[socket.status]}">
          <span class="socket-no">${socket.no}</span>
          <span class="socket-dot" aria-hidden="true"></span>
        </button>`;
    }).join('');

    this._renderSocketDetail();
  }

  _renderSocketDetail() {
    const dom = this._dom;
    if (this._selectedNo == null) {
      dom.socketDetail.hidden = true;
      dom.socketDetail.innerHTML = '';
      return;
    }
    const socket = this._sockets.find((item) => item.no === this._selectedNo);
    if (!socket) {
      dom.socketDetail.hidden = true;
      dom.socketDetail.innerHTML = '';
      return;
    }

    let title;
    let subtitle;
    if (socket.status === 'charging') {
      title = `${socket.no} 号插口 · 充电中`;
      const socPrefix = socket.soc != null ? `当前约 ${socket.soc}% · ` : '';
      subtitle = socket.endTime
        ? `${socPrefix}预计 ${formatClock(socket.endTime)} 结束 · 剩余 ${formatRemaining(socket.endTime - Date.now())}`
        : `${socPrefix}预计结束时间待同步`;
    } else if (socket.status === 'idle') {
      title = `${socket.no} 号插口 · 空闲`;
      subtitle = '当前可用，可立即充电';
    } else if (socket.status === 'fault') {
      title = `${socket.no} 号插口 · 故障`;
      subtitle = '维护中，暂不可用';
    } else {
      title = `${socket.no} 号插口 · 状态同步中`;
      subtitle = '实时数据到达后自动更新';
    }

    dom.socketDetail.className = `socket-detail is-${socket.status}`;
    dom.socketDetail.innerHTML = `
      <span class="socket-detail-no">${socket.no}</span>
      <div class="socket-detail-text">
        <strong>${escapeHtml(title)}</strong>
        <span class="socket-detail-sub">${escapeHtml(subtitle)}</span>
      </div>`;
    dom.socketDetail.hidden = false;
    dom.socketDetail.dataset.socket = String(socket.no);
  }

  _getCabinetCount() {
    const detail = this._detail;
    const raw = firstDefined(detail?.cabinets, detail?.cabinetList, detail?.batteryCabinets);
    if (Array.isArray(raw)) return raw.length;
    if (typeof raw === 'number') return raw;
    return Number(this._station?.cabinets) || 0;
  }

  _normalizeCabinets() {
    const detail = this._detail;
    const station = this._station;
    const raw = firstDefined(detail?.cabinets, detail?.cabinetList, detail?.batteryCabinets);
    const cabinets = [];

    if (Array.isArray(raw)) {
      raw.forEach((item, index) => {
        if (item == null) {
          cabinets.push({ name: `锂电柜 ${index + 1}`, status: null, available: null, total: null });
          return;
        }
        if (typeof item === 'string' || typeof item === 'number') {
          cabinets.push({ name: `锂电柜 ${index + 1}`, status: String(item), available: null, total: null });
          return;
        }
        cabinets.push({
          name: item.name || item.label || `锂电柜 ${index + 1}`,
          status: firstDefined(item.status, item.state, item.health),
          available: firstDefined(item.available, item.availableBatteries, item.spare, item.free),
          total: firstDefined(item.total, item.capacity, item.slots, item.totalBatteries),
        });
      });
      return cabinets;
    }

    const count = typeof raw === 'number' ? raw : (Number(station?.cabinets) || 0);
    for (let i = 0; i < count; i += 1) {
      cabinets.push({ name: `锂电柜 ${i + 1}`, status: null, available: null, total: null });
    }
    return cabinets;
  }

  _renderCabinets() {
    const dom = this._dom;
    const cabinets = this._normalizeCabinets();
    dom.cabinetsSection.hidden = !cabinets.length;
    if (!cabinets.length) return;

    dom.cabinetHint.textContent = `${cabinets.length} 组`;
    dom.cabinetList.innerHTML = cabinets.map((cabinet) => {
      const statusText = this._cabinetStatusText(cabinet.status);
      let batteryText = '换电状态待接入';
      const available = cabinet.available == null ? NaN : Number(cabinet.available);
      const total = cabinet.total == null ? NaN : Number(cabinet.total);
      if (Number.isFinite(available) && Number.isFinite(total) && total > 0) {
        batteryText = `可用电池 ${available}/${total} 块`;
      } else if (Number.isFinite(available)) {
        batteryText = `可用电池 ${available} 块`;
      }
      return `
        <div class="cabinet-card">
          <span class="cabinet-icon">${ICONS.cabinet}</span>
          <div class="cabinet-main">
            <strong>${escapeHtml(cabinet.name)}</strong>
            <span>${escapeHtml(batteryText)}</span>
          </div>
          <span class="cabinet-status">${escapeHtml(statusText)}</span>
        </div>`;
    }).join('');
  }

  _cabinetStatusText(status) {
    if (status == null || status === '') return '状态待接入';
    const key = String(status).trim().toLowerCase();
    if (['ok', 'online', 'normal', 'running', 'ready', '正常', '运行中', '在线'].includes(key)) return '运行中';
    if (['fault', 'error', 'offline', 'broken', '故障', '离线'].includes(key)) return '异常';
    return String(status);
  }

  _renderTrend() {
    const dom = this._dom;
    if (!dom?.trendSection) return;
    const trend = Array.isArray(this._detail?.hourlyTrend) && this._detail.hourlyTrend.length === 24
      ? this._detail.hourlyTrend
      : null;
    if (!trend) {
      dom.trendSection.hidden = true;
      return;
    }

    dom.trendSection.hidden = false;
    const nowHour = new Date().getHours();
    const currentRatio = Math.round((trend[nowHour] || 0) * 100);
    dom.trendHint.textContent = `当前 ${pad2(nowHour)}:00 · 预计 ${currentRatio}%`;

    dom.trendBars.innerHTML = trend.map((ratio, hour) => {
      const pct = Math.max(8, Math.min(100, Math.round(ratio * 100)));
      const level = ratio >= 0.85 ? 'high' : ratio >= 0.5 ? 'mid' : 'low';
      const isNow = hour === nowHour;
      return `
        <div class="trend-bar-wrap${isNow ? ' is-now' : ''}" title="${pad2(hour)}:00 预计占用约 ${Math.round(ratio * 100)}%">
          <span class="trend-bar is-${level}" style="height:${pct}%"></span>
        </div>`;
    }).join('');

    // 计算 07:00–22:00 活跃时段中预计占用最低的连续 2 小时错峰窗口
    let bestHour = 7;
    let bestAvg = Infinity;
    for (let h = 7; h <= 20; h += 1) {
      const avg = (trend[h] + trend[h + 1]) / 2;
      if (avg < bestAvg) {
        bestAvg = avg;
        bestHour = h;
      }
    }
    dom.trendAdvice.textContent = `错峰建议：${pad2(bestHour)}:00–${pad2(bestHour + 2)}:00 空闲较多（预计占用约 ${Math.round(bestAvg * 100)}%）`;
  }

  _renderNote() {
    const dom = this._dom;
    const note = String(this._station?.note || '').trim();
    const cleaned = note
      .replace(/OSM\s*multipolygon\s*relation[，,]\s*已并入底图/gi, '')
      .replace(/OSM\s*校门节点「[^」]*」（[^）]*）[；;，,\s]*/g, '')
      .replace(/；?\s*电动汽车站点，插口数待采集。?/g, '')
      .replace(/[，,；;]?\s*含锂电柜\s*\d*\s*组?/g, '')
      .trim();
    if (!note || !cleaned) {
      dom.note.hidden = true;
      dom.note.textContent = '';
      return;
    }
    dom.note.hidden = false;
    dom.note.textContent = `注：${cleaned}`;
  }

  _renderFooter() {
    const dom = this._dom;
    if (!dom) return;
    if (this._lastDataAt) {
      dom.updated.textContent = `最后更新 ${formatUpdated(this._lastDataAt)}`;
      dom.updated.title = formatRelative(this._lastDataAt);
    } else {
      dom.updated.textContent = '等待实时数据';
      dom.updated.title = '';
    }
    dom.liveText.textContent = this._refreshing ? '刷新中…' : '实时刷新';
  }

  _refreshTimeSensitive() {
    if (!this.isOpen) return;
    const dom = this._dom;
    if (!dom) return;
    if (this._lastDataAt) {
      dom.updated.textContent = `最后更新 ${formatUpdated(this._lastDataAt)}`;
      dom.updated.title = formatRelative(this._lastDataAt);
    }
    if (this._selectedNo != null) {
      const socket = this._sockets.find((item) => item.no === this._selectedNo);
      if (socket?.status === 'charging' && socket.endTime) {
        const sub = dom.socketDetail.querySelector('.socket-detail-sub');
        const socPrefix = socket.soc != null ? `当前约 ${socket.soc}% · ` : '';
        if (sub) sub.textContent = `${socPrefix}预计 ${formatClock(socket.endTime)} 结束 · 剩余 ${formatRemaining(socket.endTime - Date.now())}`;
      }
    }
  }

  _startTimer() {
    this._stopTimer();
    this._timer = window.setInterval(() => this._refreshTimeSensitive(), 1000);
    this._refreshTimeSensitive();
  }

  _stopTimer() {
    if (this._timer) {
      window.clearInterval(this._timer);
      this._timer = null;
    }
  }

  /* ------------------------------------------------------------- events */

  _handleClick(event) {
    const actionEl = event.target.closest('[data-action]');
    if (actionEl && this.root.contains(actionEl)) {
      const { action } = actionEl.dataset;
      if (action === 'close') {
        this.close();
        return;
      }
      if (action === 'favorite') {
        if (this._station && this.onToggleFavorite) {
          this.onToggleFavorite(this._station.id);
          this._renderFavorite();
        }
        return;
      }
      if (action === 'refresh') {
        if (this.onRefresh) this.onRefresh(this._station?.id ?? null);
        return;
      }
    }

    const chip = event.target.closest('.socket[data-socket]');
    if (chip && this.root.contains(chip)) {
      this._toggleSocket(Number(chip.dataset.socket));
    }
  }

  _toggleSocket(no) {
    this._selectedNo = this._selectedNo === no ? null : no;
    this._dom.grid.querySelectorAll('.socket').forEach((button) => {
      const selected = button.dataset.socket === String(this._selectedNo);
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    this._renderSocketDetail();
    if (this._selectedNo != null && this.onSocketSelect) {
      const socket = this._sockets.find((item) => item.no === this._selectedNo);
      if (socket) this.onSocketSelect(socket, this._station);
    }
  }

  _handleKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.close();
    }
  }
}

export function createStationPanel(root, options = {}) {
  return new StationPanel(root, options);
}
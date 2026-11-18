/**
 * 津电云 · HTTP 实时数据适配器
 * ==================================================================
 * 零依赖 ES Module，实现 `js/adapter.js` 与 `docs/adapter-guide.md` 的 v1 契约。
 *
 * 特性：
 *  - 单飞请求（single-flight）与超时中断（AbortController）；
 *  - 页面隐藏时自动暂停轮询（visibilitychange），切回前台立即刷新；
 *  - 连续失败指数退避（60s → 120s → 300s），恢复后回到正常间隔；
 *  - Stale-if-error：网络异常时保留上一份有效快照，避免界面闪烁或白屏；
 *  - 可选混合回退（fallbackAdapter）：上游未覆盖的站点（例如仅接入了常青藤自行车桩、
 *    未接入优易充汽车桩）或本地代理未启动时，自动回退到模拟适配器。
 */

import { SOCKET_STATUS } from './adapter.js';

const OCCUPIED_STATUSES = new Set([
  'charging', 'charge', 'occupied', 'inuse', 'in-use', 'in_use', 'using', 'busy',
  '占用', '使用中', '充电中',
]);

const FAULT_STATUSES = new Set([
  'fault', 'error', 'broken', 'offline', '故障', '维修', '维修中',
]);

function normalizeSocketStatus(status) {
  const key = String(status ?? '').trim().toLowerCase();
  if (OCCUPIED_STATUSES.has(key)) return SOCKET_STATUS.CHARGING;
  if (FAULT_STATUSES.has(key)) return SOCKET_STATUS.FAULT;
  return SOCKET_STATUS.IDLE;
}

function toMillis(value, fallback = Date.now()) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;
    if (value > 1e9) return value * 1000;
    return fallback;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toTimestampOrNull(value) {
  const ms = toMillis(value, NaN);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 创建 HTTP 实时数据适配器。
 * @param {Array<object>} stations data/stations.json 站点列表
 * @param {{
 *   endpoint?: string,
 *   pollMs?: number,
 *   timeoutMs?: number,
 *   headers?: Record<string, string>,
 *   fallbackAdapter?: object | null,
 * }} [options]
 */
export function createHttpAdapter(stations, options = {}) {
  const {
    endpoint = 'http://localhost:8787/api/charging/status',
    pollMs = 60_000,
    timeoutMs = 8_000,
    headers = {},
    fallbackAdapter = null,
  } = options;

  const list = Array.isArray(stations) ? stations : (stations?.stations ?? []);
  const byId = new Map(list.map((station) => [station.id, station]));
  const listeners = new Set();
  const details = new Map();

  let updatedAt = null;
  let lastError = null;
  let failCount = 0;
  let pollTimer = 0;
  let inflight = null;
  let unsubFallback = null;

  function emit() {
    const payload = {
      updatedAt: updatedAt ?? fallbackAdapter?.updatedAt ?? Date.now(),
      error: lastError,
      source: details.size > 0 ? 'http' : 'fallback',
    };
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (error) {
        console.error('[http-adapter] 订阅回调出错', error);
      }
    }
  }

  function normalizeDetail(raw, stationId) {
    if (!raw || typeof raw !== 'object') return null;

    let sockets = [];
    const rawSockets = raw.sockets ?? raw.ports ?? raw.outlets;
    if (Array.isArray(rawSockets)) {
      sockets = rawSockets.map((item, index) => {
        if (typeof item === 'string' || typeof item === 'number') {
          return {
            no: index + 1,
            status: normalizeSocketStatus(item),
            startedAt: null,
            endsAt: null,
            soc: null,
          };
        }
        return {
          no: Number(item?.no ?? item?.index) > 0 ? Number(item.no ?? item.index) : index + 1,
          status: normalizeSocketStatus(item?.status ?? (item?.charging ? 'charging' : item?.fault ? 'fault' : 'idle')),
          startedAt: toTimestampOrNull(item?.startedAt ?? item?.startTime),
          endsAt: toTimestampOrNull(item?.endsAt ?? item?.endTime ?? item?.estimatedEndTime),
          soc: typeof item?.soc === 'number' ? item.soc : null,
        };
      });
    } else if (rawSockets && typeof rawSockets === 'object') {
      sockets = Object.entries(rawSockets).map(([no, value]) => {
        const item = value && typeof value === 'object' ? value : {};
        return {
          no: Number(no),
          status: normalizeSocketStatus(typeof value === 'object' && value ? value.status : value),
          startedAt: toTimestampOrNull(item.startedAt),
          endsAt: toTimestampOrNull(item.endsAt ?? item.endTime),
          soc: typeof item.soc === 'number' ? item.soc : null,
        };
      });
    }

    return {
      stationId: raw.stationId ?? stationId,
      updatedAt: toMillis(raw.updatedAt ?? updatedAt, Date.now()),
      sockets,
      cabinets: Array.isArray(raw.cabinets) ? raw.cabinets : [],
      source: raw.source || 'http',
    };
  }

  function syncOccupancy(station, detail) {
    const sockets = detail?.sockets || [];
    if (!sockets.length) return;
    station.occupied = sockets.filter((socket) => socket.status === SOCKET_STATUS.CHARGING).length;
    station.occupancy = station.occupied / sockets.length;
  }

  async function load() {
    if (inflight) return inflight;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    inflight = (async () => {
      try {
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: { Accept: 'application/json', ...headers },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const payload = await response.json();
        const source = payload?.stations ?? payload;
        const next = new Map();

        for (const [id, raw] of Object.entries(source || {})) {
          const station = byId.get(id);
          if (!station) continue;
          const detail = normalizeDetail(raw, id);
          if (!detail) continue;
          next.set(id, detail);
          syncOccupancy(station, detail);
        }

        if (next.size > 0) {
          for (const [id, detail] of next) details.set(id, detail);
        }

        updatedAt = toMillis(payload?.updatedAt, Date.now());
        lastError = null;
        failCount = 0;
        scheduleNextPoll();
        emit();
      } catch (error) {
        lastError = error;
        failCount = Math.min(failCount + 1, 4);
        scheduleNextPoll();
        emit();
      } finally {
        clearTimeout(timeout);
        inflight = null;
      }
    })();

    return inflight;
  }

  function nextDelayMs() {
    if (pollMs <= 0) return 0;
    const multipliers = [1, 2, 5, 10, 15];
    const mult = multipliers[Math.min(failCount, multipliers.length - 1)];
    const jitter = Math.round((Math.random() - 0.5) * 4000);
    return Math.max(15_000, pollMs * mult + jitter);
  }

  function scheduleNextPoll() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = 0;
    }
    if (listeners.size === 0 || pollMs <= 0) return;
    pollTimer = setTimeout(() => {
      pollTimer = 0;
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        load();
      } else {
        scheduleNextPoll();
      }
    }, nextDelayMs());
  }

  function handleVisibilityChange() {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && listeners.size > 0) {
      load();
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }

  function readStation(stationId) {
    if (details.has(stationId)) return details.get(stationId);
    if (fallbackAdapter && typeof fallbackAdapter.getStationDetail === 'function') {
      return fallbackAdapter.getStationDetail(stationId);
    }
    return null;
  }

  /**
   * 接口请求失败、该站点又没有可用的 HTTP 快照时，详情来自 fallbackAdapter。
   * 不传 id 时表示整份数据都在用回退（代理未启动等）。
   */
  function isUsingFallback(stationId) {
    if (!fallbackAdapter || lastError == null) return false;
    if (stationId) return !details.has(stationId);
    return details.size === 0;
  }

  return {
    id: 'http',
    label: '实时接口',
    endpoint,

    get updatedAt() {
      return updatedAt ?? fallbackAdapter?.updatedAt ?? Date.now();
    },

    get lastError() {
      return lastError;
    },

    get usingFallback() {
      return isUsingFallback();
    },

    isUsingFallback,

    getStationDetail: readStation,
    getDetail: readStation,
    getState: readStation,

    getSnapshot() {
      const out = {};
      for (const station of list) {
        const d = readStation(station.id);
        if (d) out[station.id] = d;
      }
      return out;
    },

    refresh() {
      return load();
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      if (fallbackAdapter && typeof fallbackAdapter.subscribe === 'function' && !unsubFallback) {
        unsubFallback = fallbackAdapter.subscribe(() => {
          if (details.size < list.length) emit();
        });
      }
      if (!updatedAt && !inflight) load();
      scheduleNextPoll();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearTimeout(pollTimer);
          pollTimer = 0;
          if (unsubFallback) {
            unsubFallback();
            unsubFallback = null;
          }
        }
      };
    },

    dispose() {
      clearTimeout(pollTimer);
      pollTimer = 0;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }
      if (unsubFallback) {
        unsubFallback();
        unsubFallback = null;
      }
      listeners.clear();
      details.clear();
    },
  };
}

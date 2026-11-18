# 津电云数据适配器开发指南

本文说明如何为津电云编写自定义数据适配器，把「模拟数据」替换为真实充电平台或自建后端的数据。适用于当前零构建 ES Modules 版本的代码结构。

- 适用版本：接口契约 v1
- 相关文件：`js/adapter.js`（契约与校验）、`js/app.js`、`js/panel.js`、`js/map.js`、`js/mock-adapter.js`、`data/stations.json`

## 1. 适配器在架构中的位置

津电云把「站点静态信息」与「运行时状态」分开：

- `data/stations.json` 保存不会频繁变化的站点资料：`id`、`name`、`type`、`sockets`、`cabinets`、`lon`、`lat`、`approx`、`note`；
- 适配器负责在运行时产出每个站点的 `detail`（插口状态、预计结束时间、锂电柜状态），并维护地图图钉着色所需的占用字段；
- `js/app.js` 只通过一组固定的方法名读取适配器，不关心数据来自模拟、HTTP 还是本地缓存。

```text
data/stations.json ──┐
                     ├──> 适配器（js/mock-adapter.js 或你的实现）
上游平台 / 自建后端 ─┘        │
                              ├─ getStationDetail(id) → detail
                              ├─ app.js 据 detail 计算 occupied / occupancy（地图着色）
                              ├─ subscribe(fn)（数据变化通知）
                              └─ updatedAt（数据时间戳）
                                       │
                                       ▼
                         js/app.js → js/panel.js / js/map.js
```

默认实现为 `js/mock-adapter.js` 中的 `createMockAdapter(stations)`。它按时间演化插口状态，使界面在没有真实接口时也能完整运行。

## 2. 接口契约（v1）

### 2.1 工厂函数

```js
createXxxAdapter(stations, options?) -> adapter
```

| 参数 | 说明 |
| --- | --- |
| `stations` | `data/stations.json` 解析后的数组。适配器可以给站点对象添加动态字段（见 2.4），但不应删除或改写静态字段。 |
| `options` | 可选配置对象，例如 `endpoint`、轮询间隔、超时时间。具体字段由适配器自行定义。 |
| 返回值 | 一个非空对象。至少实现一个单站 getter（`getStationDetail` 或其别名）或 `getSnapshot` 才能显示站点详情；推荐同时实现 `refresh` 与 `subscribe`。返回 `null` / `undefined` 时，应用会回退到内置降级适配器。 |

`js/app.js` 在启动时会尝试 `createMockAdapter(stations)`、`createMockAdapter({ stations })`、`createMockAdapter()` 三种调用方式；自定义适配器只需保证上表的签名即可。

### 2.2 适配器对象成员

`js/app.js` 对方法名做了容错探测，以下别名任选其一即可（权威定义见 `js/adapter.js`）：

| 成员 | 必需性 | 说明 |
| --- | --- | --- |
| `getStationDetail(id)` | 二选一 | 返回该站点的 `detail`；无数据时返回 `null`。也可返回 `Promise`，应用会异步落地并在完成后刷新面板。别名：`getDetail`、`getStationState`、`getState`。 |
| `getSnapshot()` | 二选一 | 一次返回 `id → detail` 的映射（不是单个站点的 detail），也可返回 `Promise`。与单站 getter 至少实现一个。 |
| `refresh(id?)` | 推荐 | 立即拉取一次数据，可返回 `Promise`。`js/app.js` 会把当前站点 `id` 作为可选参数传入。别名：`tick`、`update`、`simulate`、`step`。 |
| `subscribe(fn)` | 推荐 | 订阅数据更新，返回取消订阅函数。数据变化后调用 `fn({ updatedAt, error })`。别名：`onUpdate`、`on('update', fn)`、`on('change', fn)`。缺省时应用每 5 秒轮询一次 getter。 |
| `updatedAt` | 推荐 | 最近一次成功更新的毫秒时间戳（也接受 ISO 字符串或 `Date`）。别名：`lastUpdated`。 |
| `states` / `data` / `details` | 可选 | `id → detail` 的映射，作为 getter 的替代；也支持 `store.byId[id]`。 |
| `id` / `label` | 可选 | 数据源标识与界面显示名称，例如 `'http'` / `'实时数据'`。 |
| `lastError` | 可选 | 最近一次错误对象；无错误时为 `null`。 |
| `dispose()` | 可选 | 释放定时器、连接等资源。 |

`js/app.js` 的 `probeAdapter()` 要求对象至少实现一个单站 getter（`getStationDetail`、`getDetail`、`getStationState`、`getState`）或 `getSnapshot`；否则会使用内置降级适配器。`refresh` 与 `subscribe` 只影响自动刷新能力，不影响适配器是否被接受。

### 2.3 detail 数据结构

权威定义见 `js/adapter.js`。推荐返回以下标准结构：

```js
{
  stationId: 'bike-geyuan-1',
  updatedAt: 1762603200000, // 毫秒时间戳
  sockets: [
    { no: 1, status: 'charging', startedAt: 1762596000000, endsAt: 1762603200000, soc: 62 },
    { no: 2, status: 'idle', startedAt: null, endsAt: null, soc: null },
    { no: 3, status: 'fault', startedAt: null, endsAt: null, soc: null },
  ],
  cabinets: [
    { no: 1, name: '锂电柜 1', status: 'ok', total: 6, available: 4 },
  ],
}
```

字段约定：

| 字段 | 说明 |
| --- | --- |
| `stationId` | 站点 `id`，必须与 `data/stations.json` 一致。 |
| `updatedAt` | 该站点数据的采集时间，毫秒时间戳。 |
| `sockets` | 插口数组。建议按 `station.sockets` 的数量返回；缺失的插口会显示为「同步中」（`unknown`）。 |
| `sockets[].no` | 插口号，number，从 1 开始。 |
| `sockets[].status` | `'charging'`（使用中）、`'idle'`（空闲）、`'fault'`（故障）。 |
| `sockets[].startedAt` | 开始充电时间，毫秒时间戳或 `null`。 |
| `sockets[].endsAt` | 预计结束时间，毫秒时间戳或 `null`；`charging` 时应有值。 |
| `sockets[].soc` | 可选，当前电量百分比 0–100，或 `null`。 |
| `cabinets` | 锂电柜数组；没有锂电柜时返回 `[]`。 |

锂电柜（`cabinets`）字段：

| 字段 | 说明 |
| --- | --- |
| `no` | 柜编号，从 1 开始。 |
| `name` | 显示名称，如「锂电柜 1」。 |
| `status` | `'ok'` 或 `'fault'`。 |
| `total` | 柜内格口总数。 |
| `available` | 当前可借格口数。 |

开发期校验：`js/adapter.js` 导出 `validateDetail(detail)`，返回 `{ ok, errors }`。可在适配器返回前调用，尽早发现字段缺失或状态值错误：

```js
import { validateDetail } from './adapter.js';

const result = validateDetail(detail);
if (!result.ok) console.warn('[津电云] detail 不符合契约', result.errors);
```

`js/panel.js` 会做宽容归一化，以下写法也能显示，但不建议用于新适配器：

| 归一化结果 | 可接受的写法 |
| --- | --- |
| `charging` | `charging`、`charge`、`occupied`、`inuse`、`in-use`、`in_use`、`using`、`busy`、`占用`、`使用中`、`充电中`；布尔字段 `occupied: true` / `charging: true` |
| `idle` | `idle`、`free`、`available`、`空闲`、`可用`；布尔字段 `occupied: false` / `charging: false` |
| `fault` | `fault`、`error`、`broken`、`offline`、`故障`、`维修`、`维修中` |
| `unknown` | 其他值、缺失值 |

兼容写法：`detail` 可以直接是插口数组；`sockets` 也可以是 `['charging', 'idle', ...]` 这样的字符串数组，或 `{ "1": "charging", "2": "idle" }` 这样的映射；结束时间也识别 `endTime`、`estimatedEndTime`、`remainingMinutes`、`remainingSeconds` 等别名。新代码建议严格使用 2.3 的标准结构。

锂电柜的兼容写法（来自 `js/panel.js`）：

| 字段 | 说明 |
| --- | --- |
| 容器 | `cabinets`、`cabinetList`、`batteryCabinets` 均可；`cabinets` 也可直接给数字（按数量生成占位卡）。完全缺省时回退到 `station.cabinets` 的静态数量。 |
| `name` | 显示名称，缺省为「锂电柜 N」。别名：`label`。 |
| `status` | 字符串，`ok` / `正常` / `可用` 视为正常，`fault` / `error` / `offline` / `故障` / `离线` 视为异常；`null` 显示「状态待接入」。别名：`state`、`health`。 |
| `available` | 可用电池数。别名：`availableBatteries`、`spare`、`free`。 |
| `total` | 电池仓总数。别名：`capacity`、`slots`、`totalBatteries`。 |

### 2.4 站点占用字段（地图图钉着色）

地图图钉按占用比例着色（空闲多 → 绿色，较满 → 橙色，接近满 → 红色）。`js/map.js` 从站点对象上读取以下任一字段，**必须是数字**：

| 字段 | 说明 |
| --- | --- |
| `station.occupied` | 已占用插口数（优先） |
| `station.busy` | `occupied` 的别名 |
| `station.occupancy` | 0–1 的占用比例；仅在 `station.sockets > 0` 时有效 |

当前 `js/app.js` 会在读取到 `detail` 后自动计算并写回这两个字段：`applySingleDetail()` 与 `applyOccupancyToStations()` 通过 `summarizeStation()` 统计使用中的插口数，设置 `station.occupied` 与 `station.occupancy`。因此适配器只要按 2.3 返回正确的 `detail`，通常**无需手动维护**占用字段。

如果你选择自己设置这些字段，请确保它们是数字（`Number.isFinite` 成立），并覆盖全部有插口数据的站点；否则图钉会回退到默认样式。

电动汽车站点的 `sockets` 目前为 `0`（待采集），此时无法计算比例；适配器可以补充插口数，或让图钉保持默认样式。

### 2.5 错误处理与数据新鲜度

- **getter 不要抛错**：`js/app.js` 会捕获异常并按「无数据」处理，但静默失败不利于排查。
- **刷新失败保留旧快照**：网络错误或后端 5xx 时不要清空已有 `detail`，继续展示上一次成功的数据（stale-if-error），并记录 `lastError`。
- **区分「无数据」与「0 个占用」**：尚未成功获取过数据时返回 `null`；获取成功但没有占用时返回每个插口为 `idle` 的 detail。
- **`updatedAt` 要真实**：面板会显示「最后更新」时间；不要每次调用都刷新为当前时间。

### 2.6 刷新与调度建议

- 真实接口轮询间隔建议 **不低于 60 秒**；模拟适配器可以更短（10–30 秒）。
- 页面不可见时暂停请求：监听 `document.visibilityState === 'hidden'`。
- 单飞（single-flight）：上一次请求未结束时复用同一个 Promise，避免并发打爆上游。
- 失败退避：连续失败时按 1 → 2 → 5 → 15 分钟递增，恢复后回到正常间隔。
- 加入随机抖动（jitter），避免所有用户在同一秒请求。
- `subscribe()` 返回的取消函数要能清理定时器；`dispose()` 应可重复调用。
- 用户点击刷新时，`js/app.js` 会调用 `refresh()`；若返回 `Promise`，会等待其完成（最长约 2 秒）后重读 `detail`，否则约 320ms 后重读。真实请求可能更慢，建议请求完成后通过 `subscribe` 推送一次，确保面板最终显示新数据。

## 3. 接入自定义适配器的步骤

### 3.1 新建适配器文件

在 `js/` 下新建文件，例如 `js/http-adapter.js`。新模块必须是原生 ES Module（`import` / `export`），不得引入 npm 依赖。

### 3.2 修改 `js/app.js` 的工厂入口

当前 `js/app.js` 顶部导入默认模拟适配器：

```js
import { createMockAdapter } from './mock-adapter.js';
```

并有一个内部函数 `createAdapter(stations)` 负责创建适配器。接入自定义适配器的最小改动是：

```js
// 1) 换成你的工厂
import { createHttpAdapter } from './http-adapter.js';

// 2) 让 createAdapter 返回你的适配器
function createAdapter(stations) {
  return createHttpAdapter(stations, {
    endpoint: '/api/charging/status',
  });
}
```

如果希望后端故障时仍能演示界面，可以保留模拟适配器作为兜底：

```js
import { createMockAdapter } from './mock-adapter.js';
import { createHttpAdapter } from './http-adapter.js';

function createAdapter(stations) {
  try {
    return createHttpAdapter(stations, { endpoint: '/api/charging/status' });
  } catch {
    return createMockAdapter(stations);
  }
}
```

注意：`createHttpAdapter` 的构造阶段通常不会失败（网络请求是异步的）；真正的兜底应放在适配器内部（请求失败保留旧快照），或者由你的适配器在长时间无数据时切换到模拟数据。

### 3.3 验证

1. 用静态服务器打开站点（`python3 -m http.server 8000`）；
2. 在地图上点击站点，确认插口网格与数量正确；
3. 观察地图图钉颜色是否随占用率变化；
4. 在浏览器 DevTools 的 Network 面板确认轮询频率符合预期；
5. 断网或让后端返回 500，确认界面保留旧数据而不是白屏。

## 4. 示例：对接真实 HTTP 后端

以下示例假设你有权访问一个返回站点状态的后端（自建代理，或校方 / 运营方提供的接口）。前端只与这个后端通信，**不直接抓取第三方平台**。

### 4.1 后端响应格式

`GET /api/charging/status` 返回 `application/json`：

```json
{
  "updatedAt": 1762603200000,
  "stations": {
    "bike-geyuan-1": {
      "stationId": "bike-geyuan-1",
      "updatedAt": 1762603200000,
      "sockets": [
        { "no": 1, "status": "charging", "startedAt": 1762596000000, "endsAt": 1762603200000, "soc": 62 },
        { "no": 2, "status": "idle", "startedAt": null, "endsAt": null, "soc": null }
      ],
      "cabinets": [
        { "no": 1, "name": "锂电柜 1", "status": "ok", "total": 6, "available": 4 }
      ]
    },
    "car-gymnasium": {
      "stationId": "car-gymnasium",
      "sockets": []
    }
  }
}
```

要求：

- 站点 `id` 必须与 `data/stations.json` 一致；示例适配器会忽略未知 `id`；
- 时间统一使用毫秒时间戳（契约要求）；适配器也接受 ISO 8601 字符串，但推荐毫秒；
- 如果只返回发生变化的站点，请把示例中的 `details.clear()` 改成增量合并；
- 建议响应头包含 `Cache-Control: public, max-age=30`，减少重复请求。

### 4.2 前端适配器骨架

```js
// js/http-adapter.js
/**
 * 津电云 · 真实 HTTP 后端适配器骨架
 * 零依赖 ES Module，实现 docs/adapter-guide.md 的 v1 契约。
 */

const OCCUPIED_STATUSES = new Set([
  'charging', 'charge', 'occupied', 'inuse', 'in-use', 'in_use', 'using', 'busy',
  '占用', '使用中', '充电中',
]);

function isOccupied(status) {
  return OCCUPIED_STATUSES.has(String(status ?? '').trim().toLowerCase());
}

function toMillis(value, fallback = Date.now()) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1e12) return value;        // 毫秒
    if (value > 1e9) return value * 1000;  // 秒
    return fallback;
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? fallback : parsed;
}

function toTimestampOrNull(value) {
  const ms = toMillis(value, NaN);
  return Number.isFinite(ms) ? ms : null;
}

export function createHttpAdapter(stations, options = {}) {
  const {
    endpoint = '/api/charging/status',
    pollMs = 60_000,   // 轮询间隔，建议不低于 60 秒
    timeoutMs = 8_000,
    headers = {},
  } = options;

  const byId = new Map((stations || []).map((station) => [station.id, station]));
  const listeners = new Set();
  const details = new Map(); // stationId -> detail
  let updatedAt = null;
  let lastError = null;
  let pollTimer = 0;
  let inflight = null;

  function emit() {
    const payload = { updatedAt, error: lastError };
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (error) {
        console.error('[津电云] 适配器订阅回调出错', error);
      }
    }
  }

  /** 把后端返回的单站数据归一成 js/adapter.js 契约要求的 detail。 */
  function normalizeDetail(raw, stationId) {
    if (!raw || typeof raw !== 'object') return null;

    let sockets = [];
    if (Array.isArray(raw.sockets)) {
      sockets = raw.sockets.map((item, index) => {
        if (typeof item === 'string' || typeof item === 'number') {
          return {
            no: index + 1,
            status: String(item),
            startedAt: null,
            endsAt: null,
            soc: null,
          };
        }
        return {
          no: Number(item?.no) > 0 ? Number(item.no) : index + 1,
          status: item?.status ?? 'unknown',
          startedAt: toTimestampOrNull(item?.startedAt),
          endsAt: toTimestampOrNull(item?.endsAt ?? item?.endTime ?? item?.estimatedEndTime),
          soc: typeof item?.soc === 'number' ? item.soc : null,
        };
      });
    } else if (raw.sockets && typeof raw.sockets === 'object') {
      sockets = Object.entries(raw.sockets).map(([no, value]) => {
        const item = value && typeof value === 'object' ? value : {};
        return {
          no: Number(no),
          status: typeof value === 'object' && value ? value.status : value,
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
    };
  }

  /** 可选：应用也会根据 detail 自动计算；提前写回可让图钉更及时刷新。 */
  function syncOccupancy(station, detail) {
    const sockets = detail?.sockets || [];
    if (!sockets.length) return;
    station.occupied = sockets.filter((socket) => isOccupied(socket.status)).length;
  }

  async function load() {
    if (inflight) return inflight; // 单飞：并发调用复用同一个请求

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
        const source = payload?.stations ?? payload; // 允许 { id: detail } 平铺格式
        const next = new Map();

        for (const [id, raw] of Object.entries(source || {})) {
          const station = byId.get(id);
          if (!station) continue; // 忽略未知站点，避免污染地图
          const detail = normalizeDetail(raw, id);
          if (!detail) continue;
          next.set(id, detail);
          syncOccupancy(station, detail);
        }

        if (next.size > 0) {
          details.clear(); // 若后端只返回增量，改为逐项合并
          for (const [id, detail] of next) details.set(id, detail);
        }

        updatedAt = toMillis(payload?.updatedAt, Date.now());
        lastError = null;
        emit();
      } catch (error) {
        lastError = error; // 保留上一份快照：stale-if-error
        emit();
      } finally {
        clearTimeout(timeout);
        inflight = null;
      }
    })();

    return inflight;
  }

  function startPolling() {
    if (pollTimer || pollMs <= 0) return;
    pollTimer = setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, pollMs);
  }

  return {
    id: 'http',
    label: '实时数据',

    get updatedAt() { return updatedAt; },
    get lastError() { return lastError; },

    getStationDetail(stationId) {
      return details.get(stationId) ?? null;
    },

    refresh() {
      return load();
    },

    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      startPolling();
      if (!updatedAt && !inflight) load();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          clearInterval(pollTimer);
          pollTimer = 0;
        }
      };
    },

    dispose() {
      clearInterval(pollTimer);
      pollTimer = 0;
      listeners.clear();
      details.clear();
    },
  };
}
```

### 4.3 后端最小骨架（Node.js 18+，无依赖）

GitHub Pages 只能托管静态文件，真实后端需要单独部署。下面是一个只负责「取数 + 归一化 + 跨域」的最小 HTTP 服务示例：

```js
// server.mjs — Node.js 18+ 原生 http，无第三方依赖
import { createServer } from 'node:http';

const PORT = process.env.PORT || 8787;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'https://<你的用户名>.github.io';

/** 在这里接入校方 / 运营方的接口，或在服务端做频率受限的抓取。 */
async function fetchUpstream() {
  // 返回 { updatedAt, stations: { [stationId]: { sockets, cabinets } } }
  throw new Error('尚未接入上游数据源');
}

createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  if (req.method !== 'GET' || req.url !== '/api/charging/status') {
    res.writeHead(404, cors);
    return res.end('not found');
  }

  try {
    const payload = await fetchUpstream();
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=30',
    });
    res.end(JSON.stringify(payload));
  } catch (error) {
    res.writeHead(502, {
      ...cors,
      'Content-Type': 'application/json; charset=utf-8',
    });
    res.end(JSON.stringify({ error: String(error?.message || error) }));
  }
}).listen(PORT, () => {
  console.log(`津电云后端示例已启动：http://localhost:${PORT}/api/charging/status`);
});
```

### 4.4 跨域与部署注意

- GitHub Pages 站点是 HTTPS，后端也必须是 HTTPS，否则浏览器会拦截混合内容；
- 后端需返回 `Access-Control-Allow-Origin`，值为 Pages 站点的来源（如 `https://<用户名>.github.io`），不要使用 `*` 搭配凭据；
- 如果后端与前端同域（自定义域名 + 反向代理），可直接使用 `/api/...` 相对路径，无需 CORS；
- **不要把密钥、token、Cookie 写进前端代码**：Pages 上的 JS 是公开的。上游鉴权应全部放在后端；
- 后端应设置请求超时、上游重试与缓存，避免每个浏览器各自请求上游。

## 5. 抓取第三方小程序接口：频率限制与合规

部分同学会尝试直接抓取充电运营方的小程序接口。请务必先阅读本节。

### 5.1 先确认授权与条款

- 优先联系校方或运营方申请**正式数据接口或书面授权**；
- 未公开的小程序接口不等于可以自由调用。请阅读平台的用户协议与开发者条款；对网站接口还应遵守 `robots.txt`；
- 不要绕过登录、签名、加密、验证码、风控或付费限制；
- 若仅用于个人本地学习，也应控制请求量，并避免公开部署抓取结果；
- 公开部署前请自行确认是否涉及个人信息保护、网络安全等合规要求。本文不构成法律意见。

### 5.2 频率限制与退避

- 轮询间隔建议 **不低于 60 秒**；充电状态本身不需要秒级刷新；
- 失败时指数退避，例如 1 分钟 → 2 分钟 → 5 分钟 → 15 分钟，成功后再恢复；
- 页面隐藏、长时间无操作、深夜时段应暂停或降频；
- 加入随机抖动，避免整点集中请求；
- 使用服务端缓存（30–60 秒）合并多个用户的请求；
- 单飞：同一时刻只允许一个上游请求，避免并发放大。

### 5.3 数据最小化

- 只保留站点级的聚合状态（占用数、插口状态、预计结束时间）；
- 不收集、不存储、不转发他人的账号、手机号、订单、支付信息等个人数据；
- 日志中不要记录完整响应体、token 或用户标识；
- 若上游返回了不需要的字段，在服务端丢弃后再转发给前端。

### 5.4 密钥与部署

- 抓包得到的 token、sign、Cookie 会过期，且一旦写入前端或仓库即视为泄露；
- GitHub Pages 无法运行服务端代码，也无法隐藏任何密钥；
- 若必须代理，需自建后端（学校服务器、云函数等），并在后端保存凭据、限制来源与频率；
- 不要将他人的登录态用于公共服务。

问答助手用的是另一套后端，见 [`server/README.md`](../server/README.md)。那个服务只回答页面上的提问，不读取常青藤或优易充，也不能代替本节的充电状态适配器。它的密钥同样只能留在服务器上。

### 5.5 推荐做法

1. 先做「模拟适配器 + 自建后端」两段式结构；
2. 后端只负责取数、归一化、缓存与限流；
3. 前端适配器只访问自己的后端；
4. 在上游明确授权前，不公开部署真实数据；
5. 页面保留「模拟数据」标识与免责声明，避免误导使用者。

## 6. 验收清单

接入自定义适配器后，请逐项确认：

- [ ] 地图上所有站点图钉正常显示，点击可打开详情；
- [ ] 站点详情中的插口总数与 `station.sockets` 一致；
- [ ] 使用中 / 空闲 / 故障数量与插口网格一致；
- [ ] 占用插口显示预计结束时间，倒计时随时间减少；
- [ ] 状态为空的插口显示「同步中」，而不是报错；
- [ ] 锂电柜数量与状态正确，缺省时显示「状态待接入」；
- [ ] 地图图钉颜色随占用率变化（`station.occupied` 为数字）；
- [ ] 刷新按钮能立即拉取新数据；
- [ ] 断网或后端 5xx 时保留旧数据，不白屏；
- [ ] 页面切到后台后停止轮询，回到前台后恢复；
- [ ] 浏览器控制台无未捕获异常；
- [ ] 移动端触摸与键盘操作正常。

## 7. 兼容性与版本

本指南对应当前仓库中的 `js/adapter.js`、`js/app.js`、`js/panel.js`、`js/map.js` 实现（契约 v1）。如果这些模块的方法名或数据结构发生变化，请同步更新本文与 README 的「架构概览」。

新增站点时，先在 `data/stations.json` 中补充静态字段（`id` 必须唯一，经纬度为 `[lon, lat]` 顺序的数值），再让适配器返回对应 `id` 的 `detail`；未知 `id` 会被前端忽略。
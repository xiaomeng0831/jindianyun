#!/usr/bin/env node
/**
 * 津电云 · 常青藤智能充电本地代理服务（可选）
 * ==================================================================
 * 零第三方依赖（Node.js 18+ 原生 http + fetch）。
 *
 * 用途：
 *  1. 在本地安全读取 `.env` 中的个人凭据（OPEN_ID / PHONENUMBER），不暴露给前端；
 *  2. 内置 60 秒内存缓存与单飞锁，严格限制请求频率（远低于 15 次/分钟上限）；
 *  3. 将上游返回的点位/端口状态归一化为 `docs/adapter-guide.md` 规定的 v1 契约格式；
 *  4. 未配置凭据或传入 `--mock` 时，自动生成与契约一致的本地测试响应，方便联调。
 *
 * 启动方式：
 *  node scripts/cqt_proxy.mjs
 *  # 然后打开 http://localhost:8000/?adapter=http
 */

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/* ---------------------------------------------------------- 读取 .env */

function loadDotEnv() {
  const envPath = resolve(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadDotEnv();

const PORT = Number(process.env.PORT) || 8787;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const CQT_BASE_URL = process.env.CQT_BASE_URL || 'https://m.sgdq123.com:8601';
const OPEN_ID = process.env.OPEN_ID || '';
const PHONENUMBER = process.env.PHONENUMBER || '';
const CACHE_TTL_MS = Math.max(30_000, Number(process.env.CACHE_TTL_MS) || 60_000);
const FORCE_MOCK = process.argv.includes('--mock') || !OPEN_ID;

const stations = JSON.parse(readFileSync(resolve(ROOT, 'data/stations.json'), 'utf8'));

/* ---------------------------------------------------------- 缓存与单飞 */

let cachedPayload = null;
let cachedAt = 0;
let inflight = null;

/**
 * 向上游常青藤小程序接口请求（需在 .env 配置 OPEN_ID 与 PHONENUMBER）。
 * 若未配置凭据或开启 --mock，则生成符合契约的联调测试数据。
 */
async function fetchUpstream() {
  if (FORCE_MOCK) {
    return buildMockPayload();
  }

  // 北洋园校区中心坐标
  const lon = process.env.LONGITUDE || '117.3085';
  const lat = process.env.LATITUDE || '38.9965';
  const url = new URL('/ NearDevice', CQT_BASE_URL.endsWith('/') ? CQT_BASE_URL : `${CQT_BASE_URL}/`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) MicroMessenger/8.0',
    },
    body: new URLSearchParams({
      openid: OPEN_ID,
      phone: PHONENUMBER,
      longitude: String(lon),
      latitude: String(lat),
    }),
  });

  if (!response.ok) {
    throw new Error(`上游请求失败：HTTP ${response.status}`);
  }

  const raw = await response.json();
  return normalizeCqtPayload(raw);
}

/**
 * 将常青藤返回的数据映射为津电云 v1 契约格式。
 * 未匹配到的站点保持缺省，由前端 fallbackAdapter 补齐。
 */
function normalizeCqtPayload(raw) {
  const now = Date.now();
  const list = Array.isArray(raw?.data) ? raw.data : (Array.isArray(raw) ? raw : []);
  const out = {};

  for (const station of stations) {
    if (station.type !== 'bike') continue;
    const matched = list.find((item) => {
      const title = String(item?.name || item?.deviceName || item?.address || '');
      return title && (title.includes(station.name) || station.name.includes(title));
    });
    if (!matched) continue;

    const rawPorts = Array.isArray(matched.ports || matched.sockets) ? (matched.ports || matched.sockets) : [];
    const sockets = rawPorts.map((p, idx) => {
      const st = String(p?.status ?? p?.state ?? '').toLowerCase();
      let status = 'idle';
      if (st === '1' || st === 'charging' || st === 'busy' || p?.charging) status = 'charging';
      else if (st === '2' || st === 'fault' || st === 'error' || p?.fault) status = 'fault';
      return {
        no: Number(p?.no ?? p?.port ?? idx + 1),
        status,
        startedAt: p?.startTime ? Date.parse(p.startTime) : null,
        endsAt: p?.endTime ? Date.parse(p.endTime) : (status === 'charging' ? now + 90 * 60_000 : null),
        soc: typeof p?.soc === 'number' ? p.soc : null,
      };
    });

    out[station.id] = {
      stationId: station.id,
      updatedAt: now,
      sockets,
      cabinets: [],
      source: 'cqt-live',
    };
  }

  return {
    updatedAt: now,
    mode: 'live',
    stations: out,
  };
}

/** 本地联调模拟响应（无需真实微信 OpenID 即可验证前后端完整链路）。 */
function buildMockPayload() {
  const now = Date.now();
  const out = {};
  for (const station of stations) {
    const total = Math.max(0, Number(station.sockets) || 0);
    const sockets = [];
    for (let i = 1; i <= total; i += 1) {
      const busy = ((i + Math.floor(now / 60_000)) % 3) === 0;
      sockets.push({
        no: i,
        status: busy ? 'charging' : 'idle',
        startedAt: busy ? now - 35 * 60_000 : null,
        endsAt: busy ? now + (25 + (i * 7) % 95) * 60_000 : null,
        soc: busy ? Math.min(98, 35 + ((i * 13) % 60)) : null,
      });
    }
    const cabinets = [];
    for (let c = 1; c <= (Number(station.cabinets) || 0); c += 1) {
      cabinets.push({
        no: c,
        name: `锂电柜 ${c}`,
        status: 'ok',
        total: 6,
        available: 2 + (c % 4),
      });
    }
    out[station.id] = {
      stationId: station.id,
      updatedAt: now,
      sockets,
      cabinets,
      source: 'proxy-mock',
    };
  }
  return {
    updatedAt: now,
    mode: 'proxy-mock',
    stations: out,
  };
}

async function getStatusSnapshot() {
  const now = Date.now();
  if (cachedPayload && now - cachedAt < CACHE_TTL_MS) {
    return cachedPayload;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const next = await fetchUpstream();
      cachedPayload = next;
      cachedAt = Date.now();
      return next;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/* ---------------------------------------------------------- HTTP 服务 */

createServer(async (req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization',
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/api/charging/status') {
    try {
      const payload = await getStatusSnapshot();
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
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, mode: FORCE_MOCK ? 'proxy-mock' : 'live', cachedAt }));
    return;
  }

  res.writeHead(404, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: 'Not Found', hint: 'GET /api/charging/status' }));
}).listen(PORT, () => {
  const modeText = FORCE_MOCK
    ? '本地联调模拟模式（未检测到 OPEN_ID 或已传 --mock）'
    : '常青藤实时代理模式（已加载 OPEN_ID）';
  console.log(`[津电云代理] ${modeText}`);
  console.log(`[津电云代理] 接口地址: http://localhost:${PORT}/api/charging/status`);
  console.log(`[津电云代理] 前端接入: 打开站点并附加 ?adapter=http`);
});

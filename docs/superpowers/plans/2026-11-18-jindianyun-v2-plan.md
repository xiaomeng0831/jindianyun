# 津电云 v2（智能寻桩导引、全校总览看板、数据源切换与线上同步）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为津电云新增按楼宇/定位智能推荐最近空闲充电桩与 Canvas 导引连线、全校充电状态总览看板、可视化数据源切换器，修复代理与哈希细节问题并推送到 GitHub Pages。

**Architecture:** 新增零依赖纯函数模块 `js/recommend.js` 负责球面距离计算、Top-K 站点推荐评分、全校实时指标聚合与 URL 哈希解析；扩展 `js/map.js` 在 Canvas 底图与图钉之间绘制起点脉冲标记、虚线导引路径与距离胶囊标签；在 `index.html`、`css/style.css` 与 `js/app.js` 中集成浮动推荐栏、全校总览弹窗与数据源热切换。

**Tech Stack:** 原生 ES Modules (Node.js 18+ / 现代浏览器)、HTML5 Canvas 2D、CSS Custom Properties、Service Worker。

**Spec:** `docs/superpowers/specs/2026-11-18-jindianyun-v2-design.md`

## Global Constraints
- 零构建、零第三方依赖：纯 HTML + 原生 ES Modules + Canvas 2D，不引入 npm 包或打包工具。
- 自行车站总插口保持 229 个（18 站）、锂电柜 8 组、汽车站 8 处（61 车位）。
- 移动端与桌面端自适应，支持浅色与深色模式（`prefers-color-scheme`）。

## Review Focus
- 校外定位回退：当用户浏览器定位距离北洋园校区中心超过 3000m 或定位权限被拒绝时，自动回退以校区中心（郑东图书馆 `117.30754, 38.99658`）为起点并给出友好提示。
- 全满极端情况：当候选站点全部 `idle === 0` 时，`recommendStations` 仍能按距离返回最近的非故障站点并明确标识 `空闲 0`。
- 哈希格式兼容：`#station=bike-geyuan-1`、`#station-bike-geyuan-1` 与 `#bike-geyuan-1` 均能正确解析出 `bike-geyuan-1`。

---

### Task 1: 智能寻桩推荐、全校概览聚合与哈希解析纯函数模块 (`js/recommend.js`)

**Files:**
- Create: `js/recommend.js`
- Modify: `scripts/verify_all.mjs`

**Interfaces:**
- Produces:
  - `haversineMeters(lon1, lat1, lon2, lat2) -> number`
  - `estimateWalkMinutes(meters) -> number`
  - `recommendStations(origin, stations, summarizeFn, detailReader, options) -> Array<{station, meters, walkMinutes, idle, charging, fault, total, score}>`
  - `computeCampusOverview(stations, summarizeFn, detailReader) -> object`
  - `parseStationHash(rawHash) -> string`

- [ ] **Step 1: 在 `scripts/verify_all.mjs` 中编写针对 `js/recommend.js` 的失败测试**
- [ ] **Step 2: 运行 `node scripts/verify_all.mjs` 确认因模块尚未创建而失败**
- [ ] **Step 3: 实现 `js/recommend.js`**
- [ ] **Step 4: 运行 `node scripts/verify_all.mjs` 确认测试全部通过**

---

### Task 2: 修复 `scripts/cqt_proxy.mjs` 与 `js/panel.js` 哈希分享链接一致性

**Files:**
- Modify: `scripts/cqt_proxy.mjs`
- Modify: `js/panel.js`
- Modify: `docs/real-data.md`
- Modify: `scripts/verify_all.mjs`

- [ ] **Step 1: 在 `scripts/verify_all.mjs` 中增加对代理脚本内容与哈希链接格式的校验断言**
- [ ] **Step 2: 修复 `scripts/cqt_proxy.mjs`（`/NearDevice` 路径、`CQT_OPEN_ID`/`OPEN_ID` 双变量、`/api/charging/status` 与 `/api/stations` 双路由）及 `js/panel.js` 的 `#station=` 哈希**
- [ ] **Step 3: 运行 `node scripts/verify_all.mjs` 验证通过**

---

### Task 3: Canvas 地图导引线与起点标记绘制 (`js/map.js`)

**Files:**
- Modify: `js/map.js`

**Interfaces:**
- Produces on `MapView`:
  - `setGuideRoute(origin, targetStation, meta)`
  - `clearGuideRoute()`
  - `focusGuideRoute(origin, targetStation)`

- [ ] **Step 1: 在 `js/map.js` 中扩展 `_guideRoute` 状态、`setGuideRoute`、`clearGuideRoute`、`focusGuideRoute` 及 `_drawGuideRoute(ctx)` 渲染方法**
- [ ] **Step 2: 运行 `node --check js/map.js` 与 `node scripts/verify_all.mjs` 验证无语法与回归错误**

---

### Task 4: 全校总览看板、附近寻桩浮层与数据源切换 UI 集成 (`index.html`, `css/style.css`, `js/app.js`, `sw.js`)

**Files:**
- Modify: `index.html`
- Modify: `css/style.css`
- Modify: `js/app.js`
- Modify: `sw.js`

- [ ] **Step 1: 在 `index.html` 中添加筛选栏总览按钮 `#overview-btn`、地图定位寻桩按钮 `#map-locate`、底部导引浮层 `#guide-banner` 与全校总览弹窗 `#overview-modal`**
- [ ] **Step 2: 在 `css/style.css` 中添加对应浅色/深色响应式样式**
- [ ] **Step 3: 在 `js/app.js` 中接入楼宇寻桩、定位寻桩、全校总览弹窗渲染、数据源热切换与 `parseStationHash`**
- [ ] **Step 4: 更新 `sw.js` 缓存列表（加入 `./js/recommend.js`，升级缓存键为 `jindianyun-v3`）**
- [ ] **Step 5: 运行全套语法检查与 `node scripts/verify_all.mjs`**

---

### Task 5: 文档同步 (`PROGRESS.md`, `README.md`) 与 GitHub Pages 推送部署

**Files:**
- Modify: `PROGRESS.md`
- Modify: `README.md`

- [ ] **Step 1: 更新 `PROGRESS.md` 与 `README.md` 记录 v2 新特性与交接说明**
- [ ] **Step 2: 提交 Git 并推送至 `origin/main`**

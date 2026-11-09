# 进度：津电云

## 目标
天津大学北洋园校区电动车充电桩实时状态在线查看。地图上显示点位 → 点进去看插口总数、占用/空闲编号、占用插口的预计结束时间。最终发布到 GitHub。

## 已完成
- 上一会话侦察（数据在 `osm_raw.json` / `campus_boundary.json`）：
  - 电动自行车：19 处点位 / 220 插口 + 5 组锂电柜
  - 电动汽车：9 处点位
  - OSM 北洋园校区底图（边界、79 栋命名建筑、道路）
- 项目目录 `~/Desktop/津电云/`，已 git init
- **2026-11-09 数据阶段**
  - `data/basemap.json`（约 100KB）：
    - bbox `[117.292157, 38.988705, 117.319552, 39.005057]`，边界 32 点
    - 98 个建筑多边形（88 个有名称）、212 条道路、73 个绿地/水域、32 个运动场地
    - 坐标全部 6 位小数，无重复/空几何，已通过 bbox/闭合校验
  - `data/stations.json`：28 个站点（19 自行车 / 220 插口 / 5 锂电柜；9 电动汽车），全部按命名建筑多边形定位
  - 脚本：`scripts/build_basemap.js`、`scripts/fetch_relations.js`、`scripts/build_stations.js`、
    `scripts/render_preview.py`、`scripts/render_stations.py`

- **2026-11-09 实现阶段**（commit `6f75e79`，25 个文件）
  - `index.html` / `css/style.css`（33KB，浅色+深色、移动端底部抽屉）
  - `js/basemap.js` + `js/map.js`：Canvas 2D 离线底图，平移/缩放/图钉着色/选中
  - `js/adapter.js`：适配器契约（JSDoc + validateDetail）
  - `js/mock-adapter.js`：确定性模拟（FNV 哈希 + mulberry32，15 分钟时段稳定，
    宿舍/教学/食堂/汽车四套作息曲线，周末修正，1% 故障，30s 刷新）
  - `js/panel.js` + `js/app.js` + `js/format.js`：搜索、详情面板、插口点击看预计结束时间
  - `README.md`、`docs/adapter-guide.md`、`LICENSE`（MIT）、`404.html`、`.gitignore`

- **2026-11-09 缺陷修复阶段**（5 个文件，未提交）
  - `js/mock-adapter.js`：充电会话的 startedAt/endsAt 锚定到 15 分钟时段起点，30s tick 不再把结束时间后移，倒计时正常减少；`updatedAt` 仍随 tick 前进
  - `js/app.js`：周期刷新调用 `MapView.setStations` 不再传 `{silent:true}`，已打开的地图 tooltip 会同步刷新
  - `js/app.js`：搜索框按 Enter 选中结果后同步隐藏 `#search-clear`
  - `js/app.js`：`restoreFromHash` 用 try/catch 包裹 `decodeURIComponent`，`#%` 等非法哈希不再触发“页面加载失败”
  - `js/map.js`：比例尺与版权信息的默认 `overlayInset` 58→96，不再被 `#legend` 遮挡（桌面/移动端均验证）
  - `js/panel.js`：锂电柜 available/total 为 null 时回退“换电状态待接入”，不再误显示“可用电池 0 块”
  - `css/style.css`：移动端搜索框字号 16px，避免 iOS Safari 聚焦时自动放大页面
  - 验证：`node --check` 7 个 JS 全部通过；重启本地 8765 静态服务并 curl 全部资源 200；
    ego lite 实测桌面/移动端布局、65s 倒计时递减、tooltip 随刷新更新、Enter 清空搜索、
    `index.html#%` 正常加载、锂电柜占位文案

- **2026-11-09 地图更新 + 数据校正**
  - 重新抓取 OSM（2026-11-09 12:59 UTC），`scripts/build_basemap.js` 改为**原生支持
    multipolygon relation**（不再需要手工补 `extra_buildings.json`，已删除）
  - 底图：98→**112** 栋建筑（88→**95** 命名）、212→**276** 条道路、水域 3→**9**
  - 新增建筑：**38教学楼、39教学楼、工会、天津大学北洋园校区站（地铁）**、平园21–24斋、郑东图书馆
  - 站点数据按**北洋维基**校正：留园A 10→20、竹园光伏 10→20、治园17 锂电柜 18 点位、
    25/26斋 3 组柜、31教 2 组柜；**删除修园11斋**（不在维基名单）、**删除图书馆汽车站**（维基无）
  - 电动汽车：1895 行政楼 14 口（快8+慢6）、桃园东 7 口（快4+慢3）
  - **数据矛盾**：维基正文写「19 处 / 220 口」，其明细表只有 18 处 / **229** 口 → 采用明细表
  - 新增**楼宇搜索**（`buildBuildingIndex` / `searchBuildings` / `focusBuilding`，
    MapView 新增 `focusPoint(lon,lat)`）
  - 新增 `docs/real-data.md`：真实数据获取路线

## 剩余待办
- [x] 离线矢量底图数据（OSM → basemap.json）
- [x] 19+9 个点位坐标（按命名建筑定位）
- [x] 底图渲染组件（Canvas 读取 basemap.json）
- [x] 静态站骨架（无构建步骤，直接 GitHub Pages 可跑）
- [x] 模拟数据适配器（占用/空闲/预计结束时间，随时间演化）
- [x] 点位详情面板
- [x] README / LICENSE
- [ ] **发布到 GitHub**：本机没有 `gh` CLI，需用户提供仓库地址或安装 gh
- [ ] 后续改进：电动汽车 9 站插口数待采集；锂电柜位置待核实；真实数据适配器

## 关键决策与坑
- **数据源**：模拟数据 + 可插拔适配器（用户选定）。真实接口（常青藤智能充电 m.sgdq123.com:8601）只留接口位，不实现。
- **技术形态**：纯前端静态站（用户选定），零后端、零构建，GitHub Pages 直接部署。
- **底图**：不用高德/百度（要 key），用 OSM 离线数据自绘。
- **OSM 关系漏建筑**：`osm_raw.json` 只有 way；郑东图书馆和 平园21–24斋 是 multipolygon **relation**，初次提取漏掉。
  已用 OSM API `relation/{id}/full.json` 取外环补齐（中间文件 `data/extra_buildings.json`）。
- **郑东图书馆**骑在求是大道上，中央有内院/通道；basemap 里按外环填成整块，渲染时道路要画在建筑之上（或后续挖洞）。
- **平园**每栋 relation 有 2 个 outer ring（两翼），basemap 里表现为两个同名多边形，标注时需去重。
- **留园A**：OSM 有两栋同名 `Overseas Students Apartment (Liuyuan)`，取靠留园餐厅的西南栋（推测 A 座），`approx:true`。
- **南门**用 OSM 节点「天津大学新校南门」`(117.311285, 38.98909)`，在同砚路上、校园边界外约 80m（仍在 bbox 内）。
- **电动汽车 9 站没有插口数**：`sockets:0`，`note` 标注“插口数待采集”；后续若拿到数据再填。
- **31教**在 OSM 只有英文名 `No.31 Teaching Building`，底图 name 按规范回退到 name。
- **自行车插口**：修园11斋 10→11，使 19 站合计 220。
- **5 组锂电柜为假设分布**：格园1斋、治园17斋、25/26斋、桃园餐厅南侧、31教北侧（真实位置待核）。
- 上一会话因上下文超限（508k tokens）崩溃，无代码产出。
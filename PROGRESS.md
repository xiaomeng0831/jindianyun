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

- **2026-11-09 交互增强 + 数据补全 + 真实适配器落盘**
  - **数据补全**：`data/stations.json` 与 `scripts/build_stations.js` 为其余 6 处电动汽车站点补齐预估插口数并标记 `socketsApprox: true`（体育馆 8、大通学生中心 6、34教 6、37教 6、55教 6、南门内侧 8），连同 1895 行政楼（14）和桃园东（7）共计 **61 个汽车充电位**；地图悬浮提示与详情面板对 `socketsApprox` 显示「约 N 个插口（预估）」
  - **分类与收藏筛选栏（`#filter-bar`）**：支持「全部 26」「自行车 18」「汽车 8」「含锂电柜 5」「★ 收藏 N」一键筛选，地图图钉、顶部统计指标（站点/空闲/占用）与搜索下拉列表实时联动
  - **站点收藏夹（`localStorage`）**：详情面板头部新增 `★ 收藏 / ☆ 收藏` 按钮（持久化至 `jindianyun:favorites`），地图为已收藏站点绘制金色星标角标，搜索框聚焦时置顶展示「★ 常用收藏」分组
  - **地图浮动缩放/复位控件（`.map-controls`）**：右下角新增放大（`+`）、缩小（`−`）、全校视野复位（`⌂`）按钮；优化 `focusStation` 在宽屏下考虑右侧面板宽度偏置并将缩放倍率调整为 `1.65`，保留周边楼宇参照；调整比例尺/署名位置避免与控件重叠
  - **24 小时繁忙度趋势与错峰建议**：`js/mock-adapter.js` 导出 `computeHourlyTrend(station, now)`，`js/panel.js` 渲染 24 小时柱状图（高亮当前小时）并自动计算未来 12 小时内空闲率最高的 2 小时错峰充电窗口；支持在插口列表中展示估算 `SOC` 百分比
  - **真实数据 HTTP 适配器与代理脚手架**：新增 `js/http-adapter.js`（单飞请求、超时中断、页面不可见暂停、指数退避、Stale-if-Error、混合回退 `fallbackAdapter`），支持通过 `?adapter=http` 或 `?endpoint=...` 启用；新增 `scripts/cqt_proxy.mjs` 与 `.env.example`（零依赖 Node.js 18+ 本地代理，含 60s 缓存与 `--mock` 联调模式）
  - **文档与预览图同步**：更新 `README.md`、`docs/real-data.md`，并通过 Ego Lite 浏览器实测生成 `docs/screenshots/` 四张桌面/移动端浅色与深色模式截图

- **2026-11-11 工程化全面完善与质量保证阶段**
  - **自动化回归套件（`scripts/verify_all.mjs`）**：编写了零依赖的端到端自动化测试脚本，覆盖：
    - 底图几何校验（`data/basemap.json`：bbox 范围、边界闭合、112 栋建筑、95 栋命名建筑、276 条道路）；
    - 站点数据校验（`data/stations.json`：26 个站点唯一 ID、坐标在校区内、18 自行车站 229 插口与 8 组锂电柜、8 汽车站）；
    - 适配器契约与趋势演算（`js/mock-adapter.js`：快照完备性、插口状态与 `startedAt`/`endsAt`/`soc`、24h 趋势曲线）；
    - 通用格式化工具单元测试（`js/format.js` 与 `js/panel.js` 的 `normalizeStatus` / `escapeHtml` / `toTimestamp`）；
    - 执行 `node scripts/verify_all.mjs` 5/5 项验证全部通过。
  - **一键本地启动（`启动服务.command`）**：根目录新增 macOS 双击启动脚本，默认监听 8080 端口（端口被占用时自动顺延至 8081），自动拉起默认浏览器，彻底避免占用 8765 端口而与宣威周报系统产生冲突。
  - **站点一键分享交互**：详情面板头部新增「🔗 复制站点分享链接」按钮（`data-action="share"`），点击将 `index.html#station-<id>` 写入剪贴板并弹出平滑 Toast 提示，方便师生快速分享点位。
  - **PWA 与离线支持**：新增 `manifest.webmanifest` 与矢量图标 `icon.svg`，编写 `sw.js` 实现核心资源（底图、站点、JS/CSS）的 Stale-While-Revalidate 离线缓存，支持移动端“添加到主屏幕”秒开底图。

## 剩余待办
- [x] 离线矢量底图数据（OSM → basemap.json）
- [x] 18+8 个点位坐标（按命名建筑 + 北洋维基校正）
- [x] 底图渲染组件（Canvas 读取 basemap.json）
- [x] 静态站骨架（无构建步骤，直接 GitHub Pages 可跑）
- [x] 模拟数据适配器（占用/空闲/预计结束时间/24h 趋势，随时间演化）
- [x] 点位详情面板（含收藏、24h 趋势与错峰建议、插口级倒计时、分享链接）
- [x] 分类筛选栏与地图缩放/复位浮动控件
- [x] 电动汽车 6 站预估插口数补齐（标记 `socketsApprox: true`）
- [x] 真实数据 HTTP 适配器（`js/http-adapter.js`）与本地代理脚手架（`scripts/cqt_proxy.mjs`）
- [x] PWA 离线支持（`manifest.webmanifest` + `sw.js`）与全链路测试套件（`scripts/verify_all.mjs`）
- [x] README / LICENSE / 预览截图
- [x] **发布到 GitHub**：<https://github.com/xiaomeng0831/jindianyun>
  - 线上站点：<https://xiaomeng0831.github.io/jindianyun/>（GitHub Pages，main / root）
  - 推送走 SSH（`~/.ssh/id_ed25519` 已加入账号，标题 `MacBook Pro (Claude Code)`）
- [ ] 后续改进：实地核实 6 处汽车站精确快/慢充配比与 5 处锂电柜坐标；接入优易充汽车桩实时接口

## 给后续接手 AI / 开发者的交接与速查指南

### 1. 架构速览
```text
津电云/
├── index.html                  # 页面结构（含 meta、filter-bar、map、panel、legend）
├── manifest.webmanifest        # PWA Web App 清单
├── sw.js                       # Service Worker 离线缓存
├── icon.svg                    # 矢量品牌图标
├── css/style.css               # 主题变量、深浅色适配、响应式栅格与抽屉面板
├── js/
│   ├── app.js                  # 入口与中枢：数据装载、事件编排、搜索与筛选联动、SW 注册
│   ├── map.js                  # Canvas 2D 交互式地图渲染器（平移、缩放、图钉、视口变换）
│   ├── basemap.js              # 离线底图图层绘制（建筑、道路、水体、绿地、操场、文字注记）
│   ├── panel.js                # 抽屉式详情面板：插口状态、24h 趋势图、错峰建议、收藏与分享
│   ├── mock-adapter.js         # 确定性模拟适配器（作息曲线、15min 时段稳定、插口倒计时）
│   ├── http-adapter.js         # 真实 HTTP 数据源适配器（带超时、重试与回退）
│   └── format.js               # 中文时间、时长、数字格式化工具
├── data/
│   ├── basemap.json            # 北洋园校区矢量底图（112 建筑、276 道路、87 水绿）
│   └── stations.json           # 26 个充电点位基准定义（18 自行车 229 插口 8 柜，8 汽车 61 车位）
├── scripts/
│   ├── verify_all.mjs          # 全套自动化回归与契约测试套件（接手前请先运行！）
│   ├── build_basemap.js        # 从 osm_raw.json 提取底图几何
│   ├── build_stations.js       # 站点坐标定位与插口汇总
│   └── cqt_proxy.mjs           # 常青藤接口本地中继代理
└── 启动服务.command            # macOS 双击启动脚本（默认 8080 端口）
```

### 2. 常用命令
- **全链路自检**：
  ```bash
  node scripts/verify_all.mjs
  ```
- **语法检查**：
  ```bash
  node --check sw.js
  for f in js/*.js scripts/*.js scripts/*.mjs; do node --check "$f"; done
  ```
- **启动服务**：
  双击 `启动服务.command` 或命令行运行：
  ```bash
  python3 -m http.server 8080
  # 打开 http://127.0.0.1:8080
  ```

### 3. 数据规范与注意事项
- 自行车站总插口为 **229** 个（对齐北洋维基明细表，勿改回 220）；锂电柜为 **8** 组；
- 底图为零依赖离线矢量，绘制直接基于 Canvas 2D，无外部地图供应商 API Key；
- 本地开发请通过 HTTP 服务器访问，`file://` 会被浏览器阻止加载 ES Modules 与 JSON 数据。

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
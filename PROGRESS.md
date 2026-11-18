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

- **2026-11-10 悬浮问答助手**（squash `12caabd`，PR #2，已在 GitHub Pages）
  - `js/chat.js`、`index.html`、`css/style.css`：地图就绪后出现悬浮问答。地址常量是 `CHAT_API_URL`
  - 请求带最近 12 轮对话和当前站点摘要；回复按纯文本渲染；记录只在 `sessionStorage`
  - `tests/chat.spec.js` 拦截接口做冒烟，不访问线上后端
  - 线上路径：浏览器 → Caddy（Let's Encrypt，反代到 `127.0.0.1:8765`）→ systemd 服务 `jindianyun-chat.service` 里的 uvicorn / FastAPI → SiliconFlow `Qwen/Qwen3-8B`
  - 限额：每 IP 每分钟 10 次、每天 100 次；服务端把最后 12 条消息发给模型，正文字符合计不超过 4000。CORS 只允许 `https://xiaomeng0831.github.io`
  - 密钥只在服务器文件 `~/.sf_key`（可用 `SILICONFLOW_KEY_FILE` 改路径）

- **2026-11-10 文档与参考后端**
  - `server/`：与线上一致的 `app.py` / `requirements.txt`（仓库内无密钥）、systemd 单元、Caddy 示例（域名和 ACME 邮箱是占位符）
  - README、PROGRESS、CONTRIBUTING、`server/README.md` 写明上面的架构和部署步骤
  - 进度更早处写过「本地 8765 静态服务」，那是当时预览静态页用的端口。现在 `127.0.0.1:8765` 是问答进程
  - 小组件在服务不可达时改为说明地图仍可使用；能安全显示的中文接口错误会直接展示

- **2026-11-11 工程化全面完善与质量保证阶段**
  - **自动化回归套件（`scripts/verify_all.mjs`）**：编写了零依赖的端到端自动化测试脚本，覆盖底图几何、26 站点完整性、模拟适配器契约与通用格式化工具，全部通过。
  - **一键本地启动（`启动服务.command`）**：根目录新增 macOS 双击启动脚本，默认监听 8080 端口（端口被占用时自动顺延至 8081），自动拉起默认浏览器，彻底避免占用 8765 端口。
  - **站点一键分享交互**：详情面板头部新增「🔗 复制站点分享链接」按钮（`data-action="share"`），点击将 `index.html#station=<id>` 写入剪贴板并弹出平滑 Toast 提示。
  - **PWA 与离线支持**：新增 `manifest.webmanifest` 与矢量图标 `icon.svg`，编写 `sw.js` 实现核心资源（底图、站点、JS/CSS）的 Stale-While-Revalidate 离线缓存，支持移动端“添加到主屏幕”秒开底图。

- **2026-11-18 v2 阶段：智能寻桩导引、全校总览看板、数据源切换与线上同步**
  - **智能最近空闲桩推荐与地图导引线（`js/recommend.js` + `js/map.js`）**：
    - 新增零依赖算法模块 `js/recommend.js`：实现球面距离计算 `haversineMeters`、步行耗时估算 `estimateWalkMinutes`、校外定位自动回退 `resolveCampusOrigin`（超出校区中心 3000m 时平滑回退至郑东图书馆）及综合推荐算法 `recommendStations`（兼顾距离近与空闲插口充裕：`score = 距离米数 - 空闲口数 × 18`）；
    - 搜索框选中任意楼宇（如“38教学楼”“格园1斋”）或点击地图右下角新增的「📍 附近寻桩」按钮时，自动计算 Top 3 推荐充电站，弹出浮动导引栏 `#guide-banner` 支持一键切换候选；
    - `MapView` 新增 `setGuideRoute` / `clearGuideRoute` / `focusGuideRoute`，在 Canvas 上原生绘制起点脉冲圆环、彩色虚线导引线与中点距离/步行时间胶囊标签（如 `约 145m · 步行 2 分钟`）。
  - **全校充电状态总览看板（`#overview-btn` + `#overview-modal`）**：
    - 顶部筛选栏右侧常驻显示全校实时空闲汇总（`📊 全校总览 · 空闲 X/290`）；
    - 点击展开全校总览弹窗：展示全校总空闲插口、电动自行车（18站/229口）、电动汽车（8站/61口）、锂电柜（8组）四大 KPI 卡片，以及「🟢 当前空闲最充裕 Top 5」与「🟠 当前高峰繁忙站点 Top 5」双榜，点击任一站点直接定位并打开详情。
  - **可视化数据源热切换与代理修复**：
    - 总览弹窗底部内置「🔌 数据源模式切换」（确定性模拟数据 / 常青藤 HTTP 实时代理 + Endpoint 配置持久化 `jindianyun:adapter_config`），无需手改 URL 参数即可一键热切换；
    - 修复 `scripts/cqt_proxy.mjs` 中 `/ NearDevice` 路径多余空格 bug，兼容 `OPEN_ID`/`CQT_OPEN_ID` 与 `PHONENUMBER`/`CQT_PHONENUMBER` 双变量名，同时支持 `/api/charging/status` 与 `/api/stations` 双路由；
    - 修复 `js/panel.js` 分享链接哈希为 `#station=<id>`，并在 `parseStationHash` 中兼容 `#station=`、`#station-` 与裸 ID 三种格式。
  - **测试扩展与线上同步**：合并 GitHub 远端 PR #1~#3（悬浮问答助手与边缘修复），`scripts/verify_all.mjs` 6/6 项全部通过并同步推送至 GitHub `origin/main`。
  - **修复 `file://` 直接双击打开卡在“正在加载”问题**：
    - **根因**：用户在本地直接双击打开 `file:///.../津电云/index.html` 时，Chromium 内核（Ego Lite / Chrome）会因 `CorsDisabledScheme` 拦截 `<script type="module" src="js/app.js">` 与 `fetch('data/*.json')`，导致入口脚本根本未执行、加载动画一直转圈；
    - **修复方案**：新增零依赖打包脚本 `scripts/build_file_fallback.mjs` 生成传统非模块单文件回退包 `js/file-fallback.js`（内联 `stations.json` 与 `basemap.json` 并按模块作用域封装全部 JS）；`index.html` 检测到 `location.protocol === 'file:'` 时自动加载 `js/file-fallback.js`，使本地直接双击 `index.html` 也能 100% 完整运行地图、寻桩导引、总览看板与问答助手（`http://`/`https://` 下仍走原生零构建 ES Modules）。
  - **修复地图南北方向颠倒（上下镜像校正）与本地问答助手回退引擎**：
    - **地图上下镜像校正（`js/basemap.js`）**：原 `projectLonLat(lon, lat)` 中 Web Mercator 的 `y` 未取反，而 Canvas 屏幕坐标系 `y` 向下递增，导致北侧（高纬度）被画在屏幕下方、南侧（低纬度）被画在屏幕上方，与实际地图上下颠倒。现已将 `projectLonLat` 的 `y` 取反（`y: -Math.log(...)`）并同步修正 `unprojectPoint`（`Math.exp(-y)`），使底图、道路注记与站点图钉严格遵循**上北下南、左西右东**（与高德/苹果地图完全一致）；
    - **津电云助手本地实时事实问答回退（`js/chat.js` + `js/app.js`）**：远端接口 `23-100-88-70.sslip.io` 的 CORS 仅放行 `https://xiaomeng0831.github.io`，在本地 `file://` 或 `localhost` 下会被浏览器拦截，且远端模型未读取前端实时模拟状态。现已在 `js/app.js` 内置 `answerChatLocally` 实时事实问答引擎并注入 `mountChatWidget`，支持针对“哪些站点现在比较空”“某园区/某教学楼附近有没有充电桩”“锂电柜/汽车桩分布”“地图怎么用”等问题直接基于页面实时数据秒级精准回答；
    - **桌面端悬浮按钮间距微调（`css/style.css`）**：将宽屏下 `.chat-widget` 的 `bottom` 从 `184px` 调整为 `226px`，避免压住新增的「📍 附近寻桩」按钮。

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
- [x] 悬浮问答助手（Pages 上的小组件 + 虚拟机上的 FastAPI；密钥不入库）
- [x] PWA 离线支持（`manifest.webmanifest` + `sw.js`）与全链路测试套件（`scripts/verify_all.mjs`）
- [x] 智能寻桩导引线（`js/recommend.js` + Canvas 导引层）、全校状态总览看板与数据源热切换 UI
- [x] README / LICENSE / 预览截图（含助手收起与展开）
- [x] **发布到 GitHub**：<https://github.com/xiaomeng0831/jindianyun>
  - 线上站点：<https://xiaomeng0831.github.io/jindianyun/>（GitHub Pages，main / root）
  - 推送走 SSH（`~/.ssh/id_ed25519` 已加入账号，标题 `MacBook Pro (Claude Code)`）
- [ ] 后续改进：实地核实 6 处汽车站精确快/慢充配比与 5 处锂电柜坐标；接入优易充汽车桩实时接口

## 给后续接手 AI / 开发者的交接与速查指南

### 1. 架构速览
```text
津电云/
├── index.html                  # 页面结构（含 meta、filter-bar、guide-banner、map、panel、overview-modal）
├── manifest.webmanifest        # PWA Web App 清单
├── sw.js                       # Service Worker 离线缓存（v3）
├── icon.svg                    # 矢量品牌图标
├── css/style.css               # 主题变量、深浅色适配、响应式栅格、导引条与总览弹窗
├── js/
│   ├── app.js                  # 入口与中枢：数据装载、事件编排、寻桩导引、总览看板、数据源热切换
│   ├── recommend.js            # 智能寻桩推荐、球面距离/步行估算、全校统计聚合与哈希解析纯函数库
│   ├── map.js                  # Canvas 2D 交互式地图渲染器（平移、缩放、导引虚线、图钉、视口变换）
│   ├── basemap.js              # 离线底图图层绘制（建筑、道路、水体、绿地、操场、文字注记）
│   ├── panel.js                # 抽屉式详情面板：插口状态、24h 趋势图、错峰建议、收藏与分享
│   ├── mock-adapter.js         # 确定性模拟适配器（作息曲线、15min 时段稳定、插口倒计时）
│   ├── http-adapter.js         # 真实 HTTP 数据源适配器（带超时、重试与回退）
│   └── format.js               # 中文时间、时长、数字格式化工具
├── data/
│   ├── basemap.json            # 北洋园校区矢量底图（112 建筑、276 道路、87 水绿）
│   └── stations.json           # 26 个充电点位基准定义（18 自行车 229 插口 8 柜，8 汽车 61 车位）
├── scripts/
│   ├── verify_all.mjs          # 全套自动化回归与契约测试套件（6 大项，接手前请先运行！）
│   ├── build_basemap.js        # 从 osm_raw.json 提取底图几何
│   ├── build_stations.js       # 站点坐标定位与插口汇总
│   └── cqt_proxy.mjs           # 常青藤接口本地中继代理（支持 /api/charging/status 与 /api/stations）
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
- **技术形态**：地图是纯前端静态站，GitHub Pages 直接部署，页面本身零构建。问答助手另有一台小型 Linux 虚拟机上的后端（Caddy + `jindianyun-chat.service`），不随 Pages 发布。
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
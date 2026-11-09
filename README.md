# 津电云

> 天津大学北洋园校区电动车充电桩实时状态地图

津电云是一个面向天津大学北洋园校区的充电桩状态地图：在离线矢量校园底图上查看电动自行车与电动汽车充电点的位置、插口占用情况与预计结束时间，帮助师生少走空路、错峰充电。

> **数据声明**
>
> 本站当前展示的是**模拟数据**，与天津大学及任何充电运营方均无隶属关系；点位信息整理自 OpenStreetMap 等公开资料，**并非官方数据**，可能存在偏差。实际充电状态请以学校及运营方公布的信息为准。

## 界面预览

![津电云桌面端（浅色）](docs/screenshots/desktop-light.png)

![津电云站点详情（浅色）](docs/screenshots/desktop-station.png)

| 深色模式 | 移动端 |
| --- | --- |
| ![津电云桌面端（深色）](docs/screenshots/desktop-dark.png) | ![津电云移动端（深色）](docs/screenshots/mobile-dark.png) |

## 功能特性

- **离线矢量底图** — 基于 OpenStreetMap 数据自绘北洋园校区（112 个建筑轮廓、276 段道路、87 个绿地/水域、32 个运动场地），不依赖在线瓦片、地图 Key 或外部 CDN。
- **充电点状态（模拟）** — 26 个充电站点：18 个电动自行车站点（229 个插口、8 组锂电柜）与 8 个电动汽车站点；展示使用中 / 空闲 / 故障数量与逐插口状态，占用插口显示预计结束时间并倒计时。
- **站点检索** — 支持按站点名、楼栋名与备注搜索，键盘可操作。
- **详情面板** — 移动优先的详情面板，展示插口网格、锂电柜状态与最后更新时间，数据刷新时局部更新。
- **深浅色主题** — 跟随系统 `prefers-color-scheme`，颜色统一由 CSS 自定义属性驱动。
- **零构建、零依赖** — 纯 HTML + 原生 ES Modules + Canvas 2D，无 npm、无打包器、无框架，静态托管即可运行。
- **可插拔数据源** — 适配器模式，自带模拟适配器，也可接入真实充电平台接口，见 [适配器开发指南](docs/adapter-guide.md)；真实数据从哪来见 [真实数据获取路线](docs/real-data.md)。
- **楼宇搜索** — 搜索框可搜站点，也可搜楼宇（38/39 教、工会、郑东图书馆等），选中后地图直接定位。
- **无障碍与移动端优化** — 语义化结构、键盘操作、`focus-visible`、安全区适配、按 `devicePixelRatio` 清晰渲染。

## 快速开始

本站不需要安装任何依赖，也不需要构建。由于浏览器对 ES Modules 与 `fetch()` 的限制，**请通过静态服务器打开**；直接双击 `index.html`（`file://` 协议）会因跨域限制而加载失败。

```bash
cd 津电云      # 或你的项目目录
python3 -m http.server 8000
```

然后访问 <http://localhost:8000>。

其他等价方式（任选其一）：

```bash
npx serve .          # Node.js 环境
php -S localhost:8000
```

浏览器要求：支持 ES Modules、Canvas 2D、`fetch` 与 CSS 自定义属性的现代浏览器（Chrome / Edge / Firefox / Safari 近两年版本均可）。

## 部署到 GitHub Pages

本项目是纯静态站点，**无需构建**，可直接部署到 GitHub Pages。

1. 在 GitHub 新建仓库（例如 `jindianyun`），将代码推送到 `main` 分支：

   ```bash
   cd 津电云
   git init
   git add .
   git commit -m "feat: 津电云静态站点"
   git branch -M main
   git remote add origin https://github.com/<你的用户名>/<仓库名>.git
   git push -u origin main
   ```

2. 打开仓库的 **Settings → Pages**；
3. **Build and deployment → Source** 选择 **Deploy from a branch**；
4. **Branch** 选择 `main`，目录选择 `/ (root)`，点击 **Save**；
5. 等待 1–2 分钟，访问 `https://<你的用户名>.github.io/<仓库名>/`。

之后每次推送到 `main`，GitHub Pages 会自动重新发布。

补充说明：

- 站内资源全部使用相对路径，部署在 `/<仓库名>/` 子路径下无需修改配置；
- 无需 GitHub Actions 或任何构建配置；
- 如需绑定自定义域名，可在 **Settings → Pages → Custom domain** 中设置；
- 若后续添加以 `_` 开头的文件或目录，请在根目录放一个空的 `.nojekyll` 文件以跳过 Jekyll 处理。

## 架构概览

### 零构建静态站

`index.html` 通过 `<script type="module" src="js/app.js">` 直接加载源码，浏览器原生解析 ES Modules；没有 npm、打包器或 TypeScript。所有样式与脚本均自包含，不引用任何 CDN。

### 分层与模块

```text
index.html + css/                页面结构与主题
└── js/app.js                    应用入口与状态编排
    ├── js/map.js                地图交互（平移 / 缩放 / 选点）
    ├── js/basemap.js            离线矢量底图渲染（Canvas）
    ├── js/panel.js              站点详情面板
    └── js/format.js             中文格式化工具

数据适配器（默认 js/mock-adapter.js）
└── getStationDetail(id) / subscribe / refresh

data/basemap.json                OSM 矢量底图
data/stations.json               26 个站点静态信息
```

### 适配器模式

运行时的“插口占用状态”与“站点静态信息”分离：

- `data/stations.json` 只保存站点静态资料（名称、类型、插口数、经纬度等）；
- 适配器负责产出每个站点的实时 `detail`（插口状态、预计结束时间、锂电柜状态）；应用再据此计算地图着色所需的占用字段；
- 默认的模拟适配器按时间演化数据，使界面在没有真实接口时也能完整体验；
- 替换适配器即可接入真实数据源，地图渲染与详情面板无需改动。

完整的接口契约、示例代码与合规注意事项见 [docs/adapter-guide.md](docs/adapter-guide.md)。

### 目录结构

```text
.
├── index.html               单页入口
├── 404.html                 GitHub Pages 404 页面
├── css/                     样式（CSS 自定义属性 + 深浅色主题）
├── js/                      零构建 ES Modules
│   ├── app.js               应用入口与状态编排
│   ├── basemap.js           离线矢量底图渲染
│   ├── map.js               地图交互与站点图钉
│   ├── panel.js             站点详情面板
│   ├── format.js            中文格式化工具
│   ├── adapter.js           数据适配器契约与校验工具
│   └── mock-adapter.js      默认模拟数据适配器
├── data/
│   ├── basemap.json         OSM 提取的校园矢量底图
│   └── stations.json        26 个充电站点静态信息
├── docs/
│   ├── adapter-guide.md     数据源适配器开发指南
│   └── real-data.md         真实数据获取路线（常青藤接口 / 优易充 / 北洋维基）
└── scripts/                 数据构建辅助脚本（不参与运行时）
```

## 数据说明

| 数据 | 内容 | 来源 |
| --- | --- | --- |
| `data/basemap.json` | 校园边界、98 个建筑轮廓（88 个有名称）、212 段道路、73 个绿地 / 水域、32 个运动场地 | 从 OpenStreetMap 提取（脚本见 `scripts/`） |
| `data/stations.json` | 26 个充电站点：18 个电动自行车站点（229 个插口、8 组锂电柜）与 8 个电动汽车站点（其中 2 处有插口数） | 按[北洋维基](https://wiki.tjubot.cn/campus-infrastructure/charging-pile)整理；部分点位为近似位置（`approx: true`） |
| 插口实时状态 | 使用中 / 空闲 / 故障、预计结束时间 | 当前为**模拟数据**，由 `js/mock-adapter.js` 生成 |

**免责声明**

- 本项目为个人学习性质的非官方项目，不代表天津大学或任何充电运营方；
- 所有实时状态均为模拟数据，**不可用于实际出行决策**；
- 点位信息来自公开资料，可能与实际情况存在偏差；
- 底图数据 © OpenStreetMap 贡献者，遵循 [ODbL 许可](https://www.openstreetmap.org/copyright)。

## 接入真实数据源

当前默认使用模拟适配器。若你已获得校方或运营方的数据授权，可编写自定义适配器替换数据源，无需改动地图与界面代码。步骤、接口契约与 HTTP 后端示例骨架见 [docs/adapter-guide.md](docs/adapter-guide.md)。

> 请勿绕过第三方平台的登录、签名或风控机制抓取数据，也不要将任何密钥写入前端代码或提交到仓库。

## 路线图

- [x] 离线矢量校园底图（OSM → `data/basemap.json`）
- [x] 充电站点静态数据（18 个自行车站点 / 229 个插口 / 8 组锂电柜 + 8 个电动汽车站点）
- [x] 地图渲染、站点检索与详情面板
- [x] 模拟数据适配器（占用状态随时间演化）
- [ ] 接入真实充电平台数据（需授权）
- [ ] 补齐 6 个电动汽车站点的插口数
- [ ] PWA / 离线缓存与主屏图标
- [ ] 历史占用趋势与常用站点收藏
- [ ] 多校区支持

## 参与贡献

欢迎提交 Issue 与 Pull Request。请遵循以下约定：

- **保持零依赖**：不要引入 npm 包、框架、CDN 资源或构建步骤；
- **原生 ES Modules**：新增模块使用 `import` / `export`，保证纯浏览器可直接运行；
- **中文界面**：所有用户可见文案使用简体中文；
- **数据修正**：请附上可核实的来源；不要提交通过非公开接口抓取的个人数据或凭据；
- **本地验证**：提交前用 `python3 -m http.server` 打开页面，检查桌面端与移动端、浅色与深色主题；
- **适配器改动**：遵循 [适配器开发指南](docs/adapter-guide.md) 的接口契约。

## 许可证

本项目基于 [MIT License](LICENSE) 开源，Copyright (c) 2026 津电云项目贡献者。
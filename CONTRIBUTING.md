# 参与贡献

感谢你愿意改进津电云。地图页面保持简单：**零构建、零依赖、纯静态**。本地预览和 GitHub Pages 都不需要 npm，也不需要构建：Pages 直接发布 `main` 上的文件。唯一的 npm 用途是可选的 Playwright 冒烟测试（`npm run test:e2e`），不参与部署。

问答助手是页面里的一个模块，请求发到单独的后端。参考实现在 [`server/`](server/README.md)，密钥不在这个仓库里。Pages 不会启动那个 Python 进程。

## 本地运行

不需要安装任何东西，只需要一个静态服务器：

```bash
git clone https://github.com/xiaomeng0831/jindianyun.git
cd jindianyun
python3 -m http.server 8000
# 打开 http://localhost:8000
```

> 直接双击 `index.html` 用 `file://` 打开**不行**——ES 模块和 `fetch` 会被浏览器的同源策略拦住。

本地可以点开问答面板。生产接口只允许来源 `https://xiaomeng0831.github.io`，所以在 localhost 里发送会提示助手服务暂时连不上。这不影响地图。冒烟测试会拦截该请求。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `index.html` | 页面骨架（只有结构，没有内联逻辑） |
| `css/style.css` | 全部样式，CSS 变量控制浅色/深色 |
| `js/app.js` | 入口：加载数据、接线、搜索、面板调度 |
| `js/map.js` | Canvas 地图视图：平移、缩放、图钉、tooltip |
| `js/basemap.js` | 读取 `data/basemap.json` 并绘制各图层 |
| `js/panel.js` | 站点详情面板 |
| `js/chat.js` | 悬浮问答助手。接口地址只改 `CHAT_API_URL` |
| `js/http-adapter.js` | 可选的 HTTP 实时数据适配器（`?adapter=http`） |
| `js/adapter.js` | 数据适配器契约（权威定义） |
| `js/mock-adapter.js` | 模拟数据实现 |
| `server/` | 问答后端参考实现、systemd 单元和 Caddy 示例。见 [`server/README.md`](server/README.md) |
| `data/stations.json` | 站点静态信息 |
| `data/basemap.json` | 离线底图（由 `scripts/build_basemap.js` 生成，**不要手改**） |

## 改动约定

- **保持零依赖**。页面运行时不要引入 npm 包、框架、CDN 资源或构建步骤（可选的 Playwright 冒烟测试不参与部署）。不加打包器、不加 TypeScript。浏览器直接跑 ES 模块。
- **不要引入外部 CDN**。地图、字体、图标全部自包含，离线可用。
- **不要手改 `data/basemap.json`**。它是脚本产物；改数据请改 `scripts/build_basemap.js` 后重新生成。
- **数据改动请注明来源**。`data/stations.json` 的每个 `note` 字段应写清出处（如「北洋维基 2024-04」）。
- **保持中文界面**。注释可以用中文，变量名用英文。
- **不要提交密钥**。问答接口的密钥放在服务器的 `~/.sf_key`（或 `SILICONFLOW_KEY_FILE` 指向的文件），权限 `600`。`.gitignore` 已忽略 `.sf_key`、`*.sf_key` 和 `sf_key`。Caddy 示例里的域名和邮箱保持占位符，不要写回真实值。

## 提交前检查

```bash
# 1. 语法检查（ES 模块）
for f in js/*.js; do node --input-type=module --check < "$f" || echo "FAIL $f"; done

# 2. 起服务器，浏览器里实际点一遍
python3 -m http.server 8000
```

请确认：地图能画出来、搜索能出结果、点站点能开面板、点插口能看到预计结束时间、移动端没有横向滚动。本地打开时可以点开问答面板；向生产接口提问会被 CORS 拒绝，页面会提示助手服务暂时连不上，地图应仍能使用。

改过 `server/app.py` 时再跑一次语法检查：

```bash
python3 -m py_compile server/app.py
```

可选冒烟测试（不参与 GitHub Pages 部署）：

```bash
npm install
npx playwright install chromium
npm run test:e2e
```

`tests/smoke.spec.js` 会打开页面、搜索「格园」并确认站点面板打开。`tests/chat.spec.js` 拦截 `CHAT_API_URL`，不访问线上问答接口。Pages 不会运行这条命令。

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/) 风格，中文描述：

```
fix: 修复移动端搜索框聚焦时页面缩放
feat: 支持按楼宇搜索定位
docs: 补充真实数据获取路线
```

## 关于真实数据

如果你想接入真实充电桩数据，请先读 [`docs/real-data.md`](docs/real-data.md) 和 [`docs/adapter-guide.md`](docs/adapter-guide.md)。

**重要**：不要把任何个人凭据（OpenID、手机号、token、SiliconFlow 密钥）提交到仓库。抓取第三方商业接口的代码请保持为本地可选模块，并在文档中写明合规风险。问答后端的部署、密钥文件和日志见 [`server/README.md`](server/README.md)。

## 数据来源与许可

- 底图：© OpenStreetMap 贡献者，[ODbL](https://www.openstreetmap.org/copyright)
- 站点静态信息：整理自[北洋维基](https://wiki.tjubot.cn/campus-infrastructure/charging-pile)及公开资料
- 代码：MIT

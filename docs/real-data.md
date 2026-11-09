# 怎么拿到真实充电桩数据

津电云默认跑模拟数据。本文说明**真实数据到底从哪来、各条路线的可行性、以及怎么接进项目**。

先说结论：**天津大学没有公开的充电桩实时接口**。要拿到真实状态，只有下面几条路，按推荐程度排列。

---

## 路线一：抓「常青藤智能充电」小程序接口（唯一能拿到实时状态的）

北洋园校区的电动自行车充电桩由**常青藤新能源科技发展（天津）有限公司**运营，状态在微信小程序「常青藤智能充电」里。

**接口**：`https://m.sgdq123.com:8601`

**需要的东西**（缺一不可）：

| 参数 | 怎么拿 |
| --- | --- |
| `OPEN_ID` | 你自己的微信 OpenID。用 Charles / Proxyman / mitmproxy 抓小程序登录请求得到 |
| `PHONENUMBER` | 你登录小程序用的手机号 |
| `LONGITUDE` / `LATITUDE` | 充电桩附近的坐标（接口按位置返回附近站点） |

**可参考的开源实现**：[`PairZhu/CQT_Charge`](https://github.com/PairZhu/CQT_Charge) —— 一个订阅常青藤充电桩状态的 QQ 机器人，README 里写明了上面这几个环境变量。它的登录/查询逻辑可以直接读来学。

**真实存在的限制**（别指望它很稳）：

- **需要你自己的账号**：别人 clone 你的仓库跑不起来，因为 OpenID 是你的。
- **频率限制**：社区实测大约每分钟 15 次请求上限，超了会被限流甚至封号。
- **接口随时会变**：没有文档、没有版本、没有承诺，运营方改一版前端就可能失效。
- **合规**：这是抓第三方商业服务的私有接口。**自己学习用没问题**，但公开分发、高频轮询、商业化使用都有风险。README 里必须写明这一点。

**建议做法**：写成一个**本地运行的可选适配器**，凭据放 `.env`（已 gitignore），默认不启用。不要把它做成 GitHub Pages 上的公开服务——那样所有人的请求都会打到你一个人的账号上。

---

## 路线二：电动汽车充电桩（优易充 App）

北洋园校区的电动汽车充电桩走**「优易充」App**，运营商不同，接口也不一样。

目前**没有找到公开的接口资料**。可行性和路线一类似（抓包 + 自己的账号），但需要你自己探索。已知信息：

- 1895 行政楼北侧：快充 8 + 慢充 6
- 桃园餐厅东侧：快充 4 + 慢充 3
- 其余 6 处点位插口数暂缺

---

## 路线三：静态信息（点位、插口数）—— 这个已经有权威来源

实时状态难拿，但**静态信息是公开的**，而且比我们项目里现在用的更准：

**北洋维基**（天大民间维基，维护质量很高）：
<https://wiki.tjubot.cn/campus-infrastructure/charging-pile>

它按「地点 / 充电桩类型」列出了北洋园校区全部点位和插口数，最后编辑于 2023-06，表格数据截至 2024-04。本项目 `data/stations.json` 已按这张表校正过。

**注意一个数据矛盾**：维基正文写「19 处自行车充电桩（220 个充电点位、5 组充电柜）」，但它自己的明细表只有 **18 处、合计 229 个车位**。本项目采用明细表的 229，并在站点 `note` 里保留来源。如果你在学校里实地数过，以实测为准。

**官方渠道**（可以打电话问，但不会给你接口）：
- 后勤基建部能源服务管理二科：022-85356683
- 电动汽车故障报修：400-655-6620、022-85356683
- 现场维修：13502119558

---

## 路线四：自己架设（最稳，但要硬件）

如果你有权限在某个点位装一个**电流传感器**（比如带 CT 钳的 ESP32 + 上报到自己的服务器），那就是完全合法、完全可控的真实数据。适合做课程设计/毕业设计的「硬件 + 软件」完整项目。

---

## 怎么接进津电云

不管走哪条路线，最终都是实现 `js/adapter.js` 里定义的适配器契约。骨架：

```js
// js/http-adapter.js
import { SOCKET_STATUS } from './adapter.js';

export function createHttpAdapter(stations, { endpoint, token }) {
  let cache = {};
  let updatedAt = 0;
  const listeners = new Set();

  async function pull() {
    const res = await fetch(`${endpoint}/stations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();          // 你的后端返回的数据
    cache = raw.map(toDetail);             // 转成契约要求的 detail
    updatedAt = Date.now();
    listeners.forEach((cb) => cb({ updatedAt }));
  }

  function toDetail(item) {
    return {
      stationId: item.id,
      updatedAt: Date.now(),
      sockets: item.ports.map((p) => ({
        no: p.index,
        status: p.charging ? SOCKET_STATUS.CHARGING
              : p.fault ? SOCKET_STATUS.FAULT : SOCKET_STATUS.IDLE,
        startedAt: p.startTime ?? null,
        endsAt: p.estimatedEnd ?? null,
        soc: p.soc ?? null,
      })),
      cabinets: [],
    };
  }

  setInterval(() => pull().catch(() => {}), 60_000); // 注意频率限制！

  return {
    get updatedAt() { return updatedAt; },
    getStationDetail: (id) => cache[id] ?? null,
    getSnapshot: () => cache,
    subscribe(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    refresh: pull,
  };
}
```

然后在 `js/app.js` 的 `createAdapter()` 里把它排在 `createMockAdapter` 之前（或按 URL 参数 / 环境判断启用）。

**安全提醒**：任何凭据都不要写进前端代码。前端是公开的，`token` 会出现在浏览器的网络面板里。真实部署时，凭据必须留在后端，前端只调你自己的后端。

---

## 本项目现在的状态

- `data/stations.json`：**静态点位信息已按北洋维基校正**（18 处自行车 / 229 车位 / 8 组锂电柜；8 处电动汽车点位，其中 2 处有插口数）
- `js/mock-adapter.js`：模拟数据，按作息曲线演化
- 真实适配器：**未实现**，只留了契约和本文档

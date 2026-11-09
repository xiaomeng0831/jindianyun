/**
 * 津电云 · 数据适配器契约
 * ==================================================================
 * 应用只通过本文件描述的接口取数据。默认实现是 `mock-adapter.js`
 * （模拟数据）；要接真实数据源，实现同样的接口后在 `app.js` 里替换
 * `createMockAdapter` 即可，其余代码无需改动。
 *
 * 详细接入指南见 `docs/adapter-guide.md`。
 *
 * ------------------------------------------------------------------
 * 站点静态信息（data/stations.json，每个元素）
 * ------------------------------------------------------------------
 *   {
 *     type:    'bike' | 'car',   // 电动自行车 / 电动汽车
 *     id:      string,           // 唯一标识，如 'bike-geyuan-1'
 *     name:    string,           // 显示名，如 '格园1斋'
 *     sockets: number,           // 插口总数（0 表示待采集）
 *     cabinets:number,           // 锂电柜组数
 *     lon, lat:number,           // WGS-84 经纬度
 *     approx:  boolean,          // 坐标是否为估算
 *     note:    string
 *   }
 *
 * ------------------------------------------------------------------
 * 实时状态（适配器返回的 detail）
 * ------------------------------------------------------------------
 *   {
 *     stationId: string,
 *     updatedAt: number,         // 毫秒时间戳
 *     sockets: [
 *       {
 *         no:        number,     // 插口编号，从 1 开始
 *         status:    'charging' | 'idle' | 'fault',
 *         startedAt: number|null,// 开始充电时间（毫秒），空闲时为 null
 *         endsAt:    number|null,// 预计结束时间（毫秒），空闲时为 null
 *         soc:       number|null // 可选：当前电量百分比 0-100
 *       }
 *     ],
 *     cabinets: [                // 锂电柜（没有则为空数组）
 *       {
 *         no:        number,
 *         name:      string,     // 如 '锂电柜 1'
 *         status:    'ok' | 'fault',
 *         total:     number,     // 柜内格口总数
 *         available: number      // 当前可借格口数
 *       }
 *     ]
 *   }
 *
 * ------------------------------------------------------------------
 * 适配器对象（工厂函数返回）
 * ------------------------------------------------------------------
 *   getStationDetail(id: string): detail | null
 *   getDetail(id: string): detail | null          // 别名
 *   getSnapshot(): Record<string, detail>         // 全部站点
 *   subscribe(cb: (payload?) => void): () => void // 数据变化时回调，返回取消订阅函数
 *   refresh(id?: string): Promise<void>           // 主动拉取（可选）
 *   updatedAt: number                             // 最近一次更新时间
 *
 * 所有方法都允许是同步或异步；`app.js` 会安全地处理两种返回值。
 */

/** 插口状态取值。 */
export const SOCKET_STATUS = Object.freeze({
  CHARGING: 'charging',
  IDLE: 'idle',
  FAULT: 'fault',
});

/**
 * 校验一个 detail 对象是否符合契约，开发期用来尽早发现接入错误。
 * @param {any} detail
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDetail(detail) {
  const errors = [];
  if (!detail || typeof detail !== 'object') {
    return { ok: false, errors: ['detail 不是对象'] };
  }
  if (!Array.isArray(detail.sockets)) errors.push('sockets 必须是数组');
  else {
    detail.sockets.forEach((socket, i) => {
      if (typeof socket?.no !== 'number') errors.push(`sockets[${i}].no 必须是数字`);
      if (!Object.values(SOCKET_STATUS).includes(socket?.status)) {
        errors.push(`sockets[${i}].status 必须是 charging/idle/fault`);
      }
      if (socket?.status === SOCKET_STATUS.CHARGING && typeof socket.endsAt !== 'number') {
        errors.push(`sockets[${i}] 充电中但缺少 endsAt`);
      }
    });
  }
  if (detail.cabinets != null && !Array.isArray(detail.cabinets)) {
    errors.push('cabinets 必须是数组');
  }
  return { ok: errors.length === 0, errors };
}

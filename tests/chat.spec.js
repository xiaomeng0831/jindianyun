import { test, expect } from '@playwright/test';
import { CHAT_API_URL as CHAT_URL, REQUEST_TIMEOUT_MS } from '../js/chat.js';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, accept',
};

async function fulfillChat(route, status, body) {
  if (route.request().method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: CORS });
    return false;
  }
  await route.fulfill({
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return true;
}

function overlaps(a, b) {
  if (!a || !b) return false;
  return a.x < b.x + b.width - 1
    && a.x + a.width > b.x + 1
    && a.y < b.y + b.height - 1
    && a.y + a.height > b.y + 1;
}

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/app-ready/, { timeout: 15_000 });
}

test('提问后安全渲染回复，并带上站点摘要', async ({ page }) => {
  let dialog = false;
  page.on('dialog', () => { dialog = true; });

  let payload = null;
  await page.route(CHAT_URL, async (route) => {
    const posted = await fulfillChat(route, 200, {
      reply: '格园1斋现在较空。\n**建议**先看地图上的绿色图钉。\n<script>alert(1)</script>',
    });
    if (posted) payload = route.request().postDataJSON();
  });

  await ready(page);
  await page.locator('#chat-launcher').click();
  await expect(page.locator('#chat-panel')).toBeVisible();
  await expect(page.locator('#chat-launcher')).toHaveAttribute('aria-expanded', 'true');

  await page.locator('#chat-input').fill('格园附近有充电桩吗？');
  await page.locator('#chat-send').click();

  const assistant = page.locator('.chat-bubble.is-assistant');
  await expect(assistant).toBeVisible();
  await expect(assistant.locator('strong')).toHaveText('建议');
  await expect(assistant).toContainText('格园1斋现在较空。');
  await expect(assistant).toContainText('<script>alert(1)</script>');
  await expect(page.locator('#chat-log script')).toHaveCount(0);
  expect(dialog).toBe(false);

  const text = await assistant.innerText();
  expect(text).toMatch(/较空。\s*\n建议/);

  expect(payload.messages).toEqual([
    { role: 'user', content: '格园附近有充电桩吗？' },
  ]);
  expect(payload.context).toContain('格园1斋');
  const context = JSON.parse(payload.context);
  expect(context.v).toBe(1);
  expect(context.stations.some((station) => station.name === '格园1斋' && Number.isFinite(station.idle))).toBe(true);
  expect(context.buildings.some((building) => building.name === '郑东图书馆')).toBe(true);
  expect(payload.context.length).toBeLessThanOrEqual(12000);
  expect(REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(30000);
  expect(JSON.stringify(payload)).not.toMatch(/api[_-]?key|authorization/i);

  await page.keyboard.press('Escape');
  await expect(page.locator('#chat-panel')).toBeHidden();
});

test('等待回复时显示加载状态', async ({ page }) => {
  await page.route(CHAT_URL, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    await fulfillChat(route, 200, { reply: '到了' });
  });

  await ready(page);
  await page.locator('#chat-launcher').click();
  await page.locator('#chat-input').fill('在吗');
  await page.locator('#chat-send').click();
  const pending = page.locator('.chat-bubble.is-pending');
  await expect(pending).toBeVisible();
  await expect(pending).toContainText('正在回复');
  await expect(page.locator('#chat-send')).toBeDisabled();
  await expect(page.locator('.chat-bubble.is-assistant')).toContainText('到了');
  await expect(pending).toHaveCount(0);
});

test('接口失败时显示中文提示，且错误不会被当作助手回复发回去', async ({ page }) => {
  let calls = 0;
  await page.route(CHAT_URL, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    calls += 1;
    if (calls === 1) {
      await fulfillChat(route, 429, { error: 'slow down' });
      return;
    }
    const body = route.request().postDataJSON();
    expect(body.messages.some((message) => message.content.includes('提问太频繁'))).toBe(false);
    expect(body.messages.every((message) => message.role === 'user' || message.role === 'assistant')).toBe(true);
    await route.abort();
  });

  await ready(page);
  await page.locator('#chat-launcher').click();
  await page.locator('.chat-suggest').first().click();
  await expect(page.locator('.chat-bubble.is-error')).toContainText('提问太频繁了，请稍等一会儿再试。');

  await page.locator('#chat-input').fill('再试一次');
  await page.locator('#chat-send').click();
  await expect(page.locator('.chat-bubble.is-error').last()).toContainText('助手服务暂时连不上，请稍后再试。地图仍可正常使用。');
  expect(calls).toBe(2);
});

test('对话保存在 sessionStorage，清空后删除，请求只带最近 12 轮', async ({ page }) => {
  const seeded = [];
  for (let i = 0; i < 20; i += 1) {
    seeded.push({ role: 'user', content: `问${i}` });
    seeded.push({ role: 'assistant', content: `答${i}` });
  }
  await page.addInitScript((history) => {
    if (sessionStorage.getItem('jindianyun:chat-seeded')) return;
    sessionStorage.setItem('jindianyun:chat', JSON.stringify(history));
    sessionStorage.setItem('jindianyun:chat-seeded', '1');
  }, seeded);

  let payload = null;
  await page.route(CHAT_URL, async (route) => {
    const posted = await fulfillChat(route, 200, { reply: '好的' });
    if (posted) payload = route.request().postDataJSON();
  });

  await ready(page);
  await page.locator('#chat-launcher').click();
  await expect(page.locator('.chat-bubble.is-user').first()).toContainText('问0');

  await page.locator('#chat-input').fill('新问题');
  await page.locator('#chat-send').click();
  await expect(page.locator('.chat-bubble.is-assistant').last()).toContainText('好的');

  expect(payload.messages).toHaveLength(24);
  expect(payload.messages[0]).toEqual({ role: 'assistant', content: '答8' });
  expect(payload.messages.at(-1)).toEqual({ role: 'user', content: '新问题' });
  expect(payload.messages.some((message) => message.content === '问0')).toBe(false);

  await page.reload();
  await expect(page.locator('body')).toHaveClass(/app-ready/, { timeout: 15_000 });
  await page.locator('#chat-launcher').click();
  await expect(page.locator('.chat-bubble.is-user').last()).toContainText('新问题');
  await expect(page.locator('.chat-bubble.is-assistant').last()).toContainText('好的');

  await page.locator('#chat-clear').click();
  await expect(page.locator('.chat-bubble')).toHaveCount(0);
  await expect(page.locator('#chat-empty')).toBeVisible();
  const stored = await page.evaluate(() => sessionStorage.getItem('jindianyun:chat'));
  expect(stored).toBeNull();
});

test('服务端的中文错误会显示，过长或非中文错误仍用固定提示', async ({ page }) => {
  let calls = 0;
  await page.route(CHAT_URL, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    calls += 1;
    if (calls === 1) {
      await fulfillChat(route, 400, { error: '输入过长，请将对话内容控制在 4000 字以内' });
      return;
    }
    await fulfillChat(route, 502, { error: 'upstream token leaked <script>' });
  });

  await ready(page);
  await page.locator('#chat-launcher').click();
  await expect(page.locator('#chat-panel')).toHaveAttribute('aria-modal', 'false');
  await page.locator('#chat-input').fill('太长了');
  await page.locator('#chat-send').click();
  await expect(page.locator('.chat-bubble.is-error')).toContainText('输入过长，请将对话内容控制在 4000 字以内');

  await page.locator('#chat-input').fill('再试');
  await page.locator('#chat-send').click();
  const last = page.locator('.chat-bubble.is-error').last();
  await expect(last).toContainText('助手暂时没能回答，请稍后再试。');
  await expect(last).not.toContainText('token');
  await expect(last).not.toContainText('script');
});

test('损坏的会话记录不会挡住地图，助手按钮也不遮挡缩放和图例', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('jindianyun:chat', '{not json');
  });
  await ready(page);

  const launcher = await page.locator('#chat-launcher').boundingBox();
  const zoom = await page.locator('.map-controls').boundingBox();
  const legend = await page.locator('#legend').boundingBox();
  expect(overlaps(launcher, zoom)).toBe(false);
  expect(overlaps(legend, launcher)).toBe(false);

  await page.locator('#map-zoom-in').click();
  await page.locator('#chat-launcher').click();
  await expect(page.locator('#chat-empty')).toBeVisible();

  const panel = await page.locator('#chat-panel').boundingBox();
  const viewport = page.viewportSize();
  expect(panel.x).toBeGreaterThanOrEqual(-1);
  expect(panel.y).toBeGreaterThanOrEqual(-1);
  expect(panel.x + panel.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(panel.y + panel.height).toBeLessThanOrEqual(viewport.height + 1);

  await page.locator('#search-input').fill('格园');
  const item = page.locator('.search-item[data-id]').filter({ hasText: '格园1斋' }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('#panel-title')).toHaveText('格园1斋');

  const launcherOpen = await page.locator('#chat-launcher').boundingBox();
  const station = await page.locator('#panel').boundingBox();
  expect(overlaps(launcherOpen, station)).toBe(false);
  await page.locator('#map-zoom-out').click();
});

test('320 宽输入框的占位文字完整可见', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page);
  await page.locator('#chat-launcher').click();
  const input = page.locator('#chat-input');
  await expect(input).toHaveAttribute('placeholder', '输入你的问题');
  const fits = await input.evaluate((el) => {
    const style = getComputedStyle(el);
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.font = style.font;
    const textWidth = canvas.measureText(el.placeholder).width;
    const pad = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return textWidth <= el.clientWidth - pad + 1;
  });
  expect(fits).toBe(true);
});

test('窄屏打开站点抽屉后仍能点到助手', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);

  const launcher = await page.locator('#chat-launcher').boundingBox();
  const zoom = await page.locator('.map-controls').boundingBox();
  const legend = await page.locator('#legend').boundingBox();
  expect(overlaps(launcher, zoom)).toBe(false);
  expect(overlaps(launcher, legend)).toBe(false);

  await page.locator('#search-input').fill('格园');
  await page.locator('.search-item[data-id]').filter({ hasText: '格园1斋' }).first().click();
  await expect(page.locator('#panel')).toHaveClass(/is-open/);

  const box = await page.locator('#chat-launcher').boundingBox();
  const hit = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return Boolean(el && el.closest('#chat-launcher'));
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  expect(hit).toBe(true);

  await page.locator('#chat-launcher').click();
  const panel = await page.locator('#chat-panel').boundingBox();
  expect(panel.x).toBeGreaterThanOrEqual(-1);
  expect(panel.x + panel.width).toBeLessThanOrEqual(391);
  expect(panel.y).toBeGreaterThanOrEqual(-1);
});

test('长回复滚到答案开头，而不是末尾', async ({ page }) => {
  const reply = Array.from({ length: 40 }, (_, index) => `${index + 1}. 这是很长的一行说明，用来撑开气泡。`).join('\n');
  await page.route(CHAT_URL, async (route) => {
    await fulfillChat(route, 200, { reply });
  });
  await ready(page);
  await page.locator('#chat-launcher').click();
  await page.locator('#chat-input').fill('哪些站点现在比较空？');
  await page.locator('#chat-send').click();
  const bubble = page.locator('.chat-bubble.is-assistant');
  await expect(bubble).toBeVisible();
  const placed = await bubble.evaluate((node) => {
    const log = node.closest('#chat-log');
    const bubbleRect = node.getBoundingClientRect();
    const logRect = log.getBoundingClientRect();
    return {
      topGap: Math.abs(bubbleRect.top - logRect.top),
      taller: node.offsetHeight > log.clientHeight,
      notAtEnd: log.scrollTop + log.clientHeight < log.scrollHeight - 20,
    };
  });
  expect(placed.taller).toBe(true);
  expect(placed.notAtEnd).toBe(true);
  expect(placed.topGap).toBeLessThan(8);
});

test('围栏代码块按代码渲染，标签不会执行', async ({ page }) => {
  let dialog = false;
  page.on('dialog', () => { dialog = true; });
  await page.route(CHAT_URL, async (route) => {
    await fulfillChat(route, 200, {
      reply: '看这段：\n```python\n<script>alert(1)</script>\nprint(1)\n```\n**结束**',
    });
  });
  await ready(page);
  await page.locator('#chat-launcher').click();
  await page.locator('#chat-input').fill('看代码');
  await page.locator('#chat-send').click();
  const bubble = page.locator('.chat-bubble.is-assistant');
  await expect(bubble.locator('pre code')).toContainText('print(1)');
  await expect(bubble.locator('pre code')).toContainText('<script>');
  await expect(bubble.locator('strong')).toHaveText('结束');
  await expect(bubble.locator('script')).toHaveCount(0);
  expect(dialog).toBe(false);
});

test('搜索建议不会盖住已经打开的助手', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page);
  await page.locator('#chat-launcher').click();
  await expect(page.locator('#chat-panel')).toBeVisible();
  const layers = await page.evaluate(() => ({
    chat: Number(getComputedStyle(document.querySelector('.chat-widget')).zIndex),
    search: Number(getComputedStyle(document.querySelector('#search-results')).zIndex),
  }));
  expect(layers.chat).toBeGreaterThan(layers.search);

  await page.locator('#search-input').fill('格园');
  await expect(page.locator('#search-results')).toBeVisible();
  await expect(page.locator('#chat-panel')).toBeHidden();

  await page.locator('#chat-launcher').click();
  await expect(page.locator('#chat-panel')).toBeVisible();
  await expect(page.locator('#search-results')).toBeHidden();
});

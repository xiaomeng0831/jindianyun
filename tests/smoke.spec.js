import { test, expect } from '@playwright/test';

test('页面加载后搜索「格园」并打开站点面板', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/app-ready/, { timeout: 15_000 });

  await page.locator('#search-input').fill('格园');
  const item = page.locator('.search-item[data-id]').filter({ hasText: '格园1斋' }).first();
  await expect(item).toBeVisible();
  await item.click();

  await expect(page.locator('#panel')).toHaveClass(/is-open/);
  await expect(page.locator('#panel-title')).toHaveText('格园1斋');

  const chipTops = await page.locator('.filter-chip').evaluateAll((els) => (
    els.map((el) => el.getBoundingClientRect().top)
  ));
  expect(Math.max(...chipTops) - Math.min(...chipTops)).toBeLessThan(2);
});

test('底图失败不阻断站点搜索', async ({ page }) => {
  await page.route('**/data/basemap.json', (route) => route.abort());
  await page.goto('/');

  await expect(page.locator('body')).toHaveClass(/app-ready/, { timeout: 15_000 });
  await expect(page.locator('.app-error')).toHaveCount(0);
  const notice = page.locator('.map-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('data/basemap.json');

  await page.locator('#search-input').fill('格园');
  const item = page.locator('.search-item[data-id]').filter({ hasText: '格园1斋' }).first();
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('#panel-title')).toHaveText('格园1斋');
});

test('站点数据失败时错误点名 stations.json', async ({ page }) => {
  await page.route('**/data/stations.json', (route) => route.abort());
  await page.goto('/');

  const error = page.locator('.app-error');
  await expect(error).toBeVisible({ timeout: 15_000 });
  await expect(error).toContainText('data/stations.json');
  await expect(error).not.toContainText('data/basemap.json');
  await expect(page.locator('body')).not.toHaveClass(/app-ready/);
  await expect(page.locator('.map-notice')).toHaveCount(0);
});

test('禁用 JavaScript 时 noscript 提示可见', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('/');

  await expect(page.locator('#app-loading')).toBeHidden();
  const note = page.locator('.noscript-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('JavaScript');
  await context.close();
});

test('HTTP 适配器在代理不可用时标明模拟数据', async ({ page }) => {
  await page.goto('/?adapter=http');
  await expect(page.locator('body')).toHaveClass(/app-ready/, { timeout: 15_000 });

  await page.locator('#search-input').fill('格园');
  await page.locator('.search-item[data-id]').filter({ hasText: '格园1斋' }).first().click();

  const live = page.locator('.live-text');
  await expect(live).toHaveAttribute('data-mode', 'fallback', { timeout: 10_000 });
  await expect(live).toHaveText('接口不可用，已使用模拟数据');
});

test('390 宽视口下收藏筛选完整可见', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/app-ready/, { timeout: 15_000 });

  const bar = page.locator('#filter-bar');
  const fav = bar.locator('.filter-chip[data-filter="fav"]');
  await expect(fav).toBeVisible();

  const metrics = await bar.evaluate((el) => {
    const chip = el.querySelector('[data-filter="fav"]');
    const barRect = el.getBoundingClientRect();
    const chipRect = chip.getBoundingClientRect();
    return {
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      chipLeft: chipRect.left,
      chipRight: chipRect.right,
      barLeft: barRect.left,
      barRight: barRect.right,
    };
  });

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  expect(metrics.chipLeft).toBeGreaterThanOrEqual(metrics.barLeft - 1);
  expect(metrics.chipRight).toBeLessThanOrEqual(metrics.barRight + 1);
});

test('窄屏页脚免责声明完整换行，不被截成省略号', async ({ page }) => {
  const expected = '本站数据为模拟数据，非官方信息，仅供学习与参考；实际状态请以学校及运营方公布的信息为准。';
  for (const viewport of [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/app-ready/, { timeout: 15_000 });
    const disclaimer = page.locator('.footer-disclaimer');
    await expect(disclaimer).toHaveText(expected);
    const box = await disclaimer.evaluate((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        whiteSpace: style.whiteSpace,
        overflowX: style.overflowX,
        textOverflow: style.textOverflow,
        bottom: rect.bottom,
        height: rect.height,
      };
    });
    expect(box.whiteSpace).not.toBe('nowrap');
    expect(box.overflowX).not.toBe('hidden');
    expect(box.textOverflow).not.toBe('ellipsis');
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
    expect(box.height).toBeGreaterThan(20);
    expect(box.bottom).toBeLessThanOrEqual(viewport.height + 1);
  }
});

import { defineConfig, devices } from '@playwright/test';

/**
 * 可选冒烟测试。GitHub Pages 直接发布静态文件，不运行这里。
 * 运行：npm install && npx playwright install chromium && npm run test:e2e
 */
export default defineConfig({
  testDir: 'tests',
  timeout: 30_000,
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'python3 -m http.server 4173 --bind 127.0.0.1',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
});

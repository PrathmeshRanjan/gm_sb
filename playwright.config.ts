import { defineConfig } from '@playwright/test';

const localUrl = 'http://127.0.0.1:4173';
const deployedUrl = process.env.FEASIBILITY_URL;
const hardware = process.env.FEASIBILITY_HARDWARE_WEBGL === '1';

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.pw.ts',
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: deployedUrl ?? localUrl,
    viewport: { width: 1440, height: 980 },
    headless: !hardware,
    launchOptions: {
      channel: 'chromium',
      args: hardware ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  webServer: deployedUrl
    ? undefined
    : {
        command: 'npm run preview -- --host 127.0.0.1 --port 4173 --strictPort',
        url: localUrl,
        reuseExistingServer: false,
      },
});

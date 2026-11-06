// Opens the built web app against the real webcam (local only) and reports what a user would get.
// Usage: node eval/live-web.mjs [--seconds 15]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import { buildWeb, serveDist } from '../apps/web/build.mjs';

const args = process.argv.slice(2);
const seconds = Number(args.includes('--seconds') ? args[args.indexOf('--seconds') + 1] : 15);
await buildWeb();
const server = await serveDist(0);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.waitForFunction(() => window.__sunroom?.session, null, { timeout: 30000 });
const rows = [];
for (let t = 1; t <= seconds; t++) {
  await page.waitForTimeout(1000);
  rows.push(
    await page.evaluate(() => {
      const s = window.__sunroom.session.status;
      return { fps: +s.cameraFps.toFixed(1), ms: +s.processMs.toFixed(1), face: !!s.face, mode: s.director.mode, reason: s.director.lastReason, error: s.error, text: document.querySelector('[data-status], #status, .status')?.textContent?.trim() ?? null };
    }),
  );
}
fs.mkdirSync('data/live', { recursive: true });
await page.screenshot({ path: 'data/live/web.png' });
// leave the page the way a user would, so the session restores the camera
await page.goto('about:blank');
await page.waitForTimeout(800);
await browser.close();
server.close();
rows.forEach((r, i) => console.log(`${String(i + 1).padStart(2)}s  ${String(r.fps).padStart(5)} fps  ${String(r.ms).padStart(5)} ms  face ${r.face ? 'yes' : 'no '}  ${r.mode.padEnd(8)} ${r.text ?? ''}${r.error ? '  ERROR ' + r.error : ''}`));
console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'no page errors');

// Live check of the extension on the real webcam (local only: it opens the camera).
// A plain page asks for the camera; the extension should hand it enhanced video, steer the camera,
// and put the camera's settings back, both when the page stops the track and when the tab just closes.
// Usage: node apps/extension/build.mjs && node eval/live-extension.mjs [--browser <chromium>]
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findChromium } from '../tools/chromium.mjs';

const dist = path.resolve('apps/extension/dist');
const exe = findChromium();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Windows only: what the camera driver itself says, independent of the browser
const camera = () => {
  const exeCtl = path.resolve('tools/bin/camctl.exe');
  if (!fs.existsSync(exeCtl)) return null;
  const out = execFileSync(exeCtl, ['list'], { encoding: 'utf8' });
  const row = (name) => out.split('\n').find((l) => l.includes(name))?.trim().split(/\s+/) ?? [];
  const [gain, exposure] = [row(' Gain '), row(' Exposure ')];
  return { gain: Number(gain.at(-2)), exposureAuto: exposure.at(-1) === '1' };
};

const page_html = `<!doctype html><meta charset="utf-8"><video id="v" autoplay muted playsinline></video><script>
  window.start = async () => {
    window.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    document.getElementById('v').srcObject = window.stream;
    return window.stream.getVideoTracks()[0].label;
  };
  // mean brightness of the whole picture
  window.luma = () => { const v = document.getElementById('v'); const c = document.createElement('canvas'); c.width = 64; c.height = 36;
    const x = c.getContext('2d'); x.drawImage(v, 0, 0, 64, 36); const d = x.getImageData(0, 0, 64, 36).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i + 1]; return Math.round(s / (d.length / 4)); };
</script>`;
const server = http.createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(page_html)).listen(0);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunroom-live-ext-'));
const context = await chromium.launchPersistentContext(dir, {
  executablePath: exe,
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const url = `http://localhost:${server.address().port}/`;
const result = { before: camera() };
try {
  for (const how of ['stop', 'close']) {
    const page = await context.newPage();
    page.on('pageerror', (e) => console.error('[page error]', e.message));
    await page.goto(url);
    const label = await page.evaluate(() => window.start());
    await sleep(14000);
    const during = { label, luma: await page.evaluate(() => window.luma()), camera: camera() };
    if (how === 'stop') await page.evaluate(() => window.stream.getTracks().forEach((t) => t.stop()));
    else await page.close();
    await sleep(2500);
    result[how] = { during, after: camera() };
    if (how === 'stop') await page.close();
  }
} finally {
  await context.close();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(result, null, 1));

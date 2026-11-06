// Closed-loop test on the real webcam (local only: it opens the camera).
// Usage: node eval/live.mjs <name> [--seconds 20] [--no-director] [--off] [--headed]
// Prints what the session did over time and saves one enhanced frame to data/live/<name>.jpg.
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const name = args[0] ?? 'live';
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const seconds = Number(flag('--seconds', '20'));

await build({ entryPoints: ['eval/live-page.ts'], bundle: true, format: 'iife', outfile: 'data/.cache/live-page.js', logLevel: 'warning' });

const roots = {
  '/mp/': path.resolve('node_modules/@mediapipe/tasks-vision/wasm'),
  '/models/': path.resolve('data/models'),
};
const types = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream' };
const server = http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><script src="/page.js"></script>');
    let file = url === '/page.js' ? path.resolve('data/.cache/live-page.js') : null;
    for (const [prefix, root] of Object.entries(roots)) if (url.startsWith(prefix)) file = path.join(root, url.slice(prefix.length));
    if (!file || !fs.existsSync(file)) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
  })
  .listen(0);

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !args.includes('--headed'),
  args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await browser.newPage();
page.on('console', (m) => console.error('[page]', m.text()));
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`http://localhost:${server.address().port}/`);
const r = await page.evaluate((o) => window.runLive(o), { seconds, director: !args.includes('--no-director'), enabled: !args.includes('--off') });
await browser.close();
server.close();

fs.mkdirSync('data/live', { recursive: true });
fs.writeFileSync(`data/live/${name}.jpg`, Buffer.from(r.png.split(',')[1], 'base64'));
fs.writeFileSync(`data/live/${name}.json`, JSON.stringify({ transport: r.transport, outFps: r.outFps, samples: r.samples }, null, 1));
console.log(`transport ${r.transport}, enhanced output ${r.outFps} fps`);
console.log('   t  camFps  ms  mode     expMode     expTime gain bright face faceLuma shortfall  reason');
let lastReason = null;
for (const s of r.samples.filter((_, i) => i % 4 === 3)) {
  console.log(
    `${String(s.t).padStart(5)} ${String(s.cameraFps).padStart(6)} ${String(s.processMs).padStart(4)}  ${s.mode.padEnd(8)} ${String(s.exposureMode).padEnd(11)} ${String(s.exposureTime).padStart(7)} ${String(s.gain).padStart(4)} ${String(s.brightness).padStart(6)} ${s.face ? 'yes ' : 'no  '} ${String(s.faceLumaOut ?? '-').padStart(8)} ${String(s.shortfall ?? '-').padStart(9)}  ${s.reason !== lastReason ? s.reason ?? '' : ''}`,
  );
  lastReason = s.reason;
}

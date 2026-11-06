// Pushes every clip through the real WebGL pipeline in Chrome, saves the frames, then scores them.
// Usage: node eval/run.mjs <variant> [--faces oracle|none|detect] [--clips a,b] [--opts <json>] [--headed] [--off]
// --faces oracle: annotated boxes; none: centre-weighted metering; detect: the shipped detector on the output
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const variant = args[0];
if (!variant) throw new Error('variant name required');
const flag = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
const facesMode = flag('--faces', 'oracle');
const options = JSON.parse(flag('--opts', '{}'));
const framesRoot = path.resolve('data/frames');
const outRoot = path.resolve('data/out');
const only = flag('--clips', '');
const clips = fs
  .readdirSync(framesRoot)
  .filter((d) => fs.existsSync(path.join(framesRoot, d, 'faces.json')) && (!only || only.split(',').includes(d)));

await build({ entryPoints: ['eval/page.ts'], bundle: true, format: 'iife', outfile: 'data/.cache/eval-page.js', logLevel: 'warning' });

const server = http
  .createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (req.method === 'POST' && url.startsWith('/out/')) {
      const file = path.join(outRoot, url.slice(5));
      if (!file.startsWith(outRoot)) return res.writeHead(403).end();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.writeFileSync(file, Buffer.concat(chunks));
        res.writeHead(204).end();
      });
      return;
    }
    if (url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><script src="/page.js"></script>');
    const file =
      url === '/page.js' ? path.resolve('data/.cache/eval-page.js')
      : url.startsWith('/frames/') ? path.join(framesRoot, url.slice(8))
      : url.startsWith('/mp/') ? path.join(path.resolve('node_modules/@mediapipe/tasks-vision/wasm'), url.slice(4))
      : url.startsWith('/models/') ? path.join(path.resolve('packages/core/assets'), url.slice(8))
      : null;
    if (!file || !fs.existsSync(file)) return res.writeHead(404).end();
    const type = { '.js': 'text/javascript', '.wasm': 'application/wasm', '.jpg': 'image/jpeg' }[path.extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
  })
  .listen(0);
const port = server.address().port;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: !args.includes('--headed'),
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await browser.newPage();
page.on('console', (m) => console.error('[page]', m.text()));
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`http://localhost:${port}/`);

fs.rmSync(path.join(outRoot, variant), { recursive: true, force: true });
const summary = {};
for (const clip of clips) {
  const dir = path.join(framesRoot, clip);
  const count = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).length;
  const faces = facesMode === 'oracle' ? JSON.parse(fs.readFileSync(path.join(dir, 'faces.json'), 'utf8')) : null;
  const r = await page.evaluate((job) => window.runClip(job), { clip, count, variant, faces, detect: facesMode === 'detect', options, enabled: !args.includes('--off') });
  summary[clip] = r;
  console.log(`${clip.padEnd(22)} ${count} frames  ${r.msMedian.toFixed(1)} ms median  ${r.msP95.toFixed(1)} ms p95${r.detect ? `  face found ${r.detect}` : ''}  [${r.renderer}]`);
}
await browser.close();
server.close();
fs.writeFileSync(path.join(outRoot, `${variant}.trace.json`), JSON.stringify(summary, null, 1));
const py = spawnSync('python', ['eval/metrics.py', 'data/frames', path.join('data/out', variant), '--json', path.join('data/out', `${variant}.json`)], { stdio: 'inherit' });
process.exit(py.status ?? 0);

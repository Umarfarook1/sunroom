// Cross-platform smoke test: does the engine run in this OS's Chromium, with or without a GPU, and does
// the extension hand a page the enhanced camera? Uses the browser's fake camera, so it runs on CI.
// Usage: node apps/extension/build.mjs && node eval/smoke.mjs <clip.y4m|clip.mjpeg> [--browser <chromium>]
//        make a clip with: node tools/make_synthetic_clip.mjs data/fake/synthetic.y4m
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { findChromium } from '../tools/chromium.mjs';

const clip = path.resolve(process.argv[2] ?? 'data/fake/synthetic.y4m');
if (!fs.existsSync(clip)) throw new Error(`no clip at ${clip}; make one with tools/make_synthetic_clip.mjs`);
const dist = path.resolve('apps/extension/dist');
if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error('build the extension first: node apps/extension/build.mjs');
const exe = findChromium();
const SECONDS = 12;

fs.mkdirSync('data/.cache', { recursive: true });
await build({
  stdin: {
    contents: `
      import { CameraSession } from './packages/core/src/index';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // mean brightness of what a track shows, and how many frames arrived while we watched
      async function watch(track, ms) {
        const video = document.createElement('video');
        video.muted = true;
        video.srcObject = new MediaStream([track]);
        document.body.appendChild(video);
        await video.play();
        let frames = 0;
        const count = () => { frames++; video.requestVideoFrameCallback(count); };
        video.requestVideoFrameCallback(count);
        await sleep(ms);
        const c = document.createElement('canvas');
        c.width = 64; c.height = 36;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(video, 0, 0, 64, 36);
        const d = x.getImageData(0, 0, 64, 36).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        video.remove();
        return { frames, luma: Math.round(sum / (d.length / 4)), size: [video.videoWidth, video.videoHeight] };
      }
      // the engine alone, on the camera exactly as the browser gives it
      window.engine = async (ms) => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const camera = stream.getVideoTracks()[0];
        const raw = await watch(camera.clone(), 1500);
        const session = new CameraSession(camera, { director: false });
        const out = await watch(session.track, ms);
        const s = session.status;
        const gl = document.createElement('canvas').getContext('webgl2');
        const info = gl?.getExtension('WEBGL_debug_renderer_info');
        const report = { raw, out, error: s.error, transport: s.transport, processMs: +s.processMs.toFixed(1), outputFps: +s.outputFps.toFixed(1), renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'unknown' };
        await session.stop();
        camera.stop();
        return report;
      };
      // what a call page would do; with the extension loaded, the stream it gets back is Sunroom's
      window.page = async (ms) => {
        const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = stream.getVideoTracks()[0];
        await sleep(3000);
        const out = await watch(track.clone(), ms);
        const report = { out, label: track.label, cameraLabels: cameras.map((d) => d.label), readyState: track.readyState };
        track.stop();
        return report;
      };`,
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  outfile: 'data/.cache/smoke-page.js',
  logLevel: 'warning',
});
const server = http
  .createServer((req, res) => {
    if (req.url === '/page.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync('data/.cache/smoke-page.js'));
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><script src="/page.js"></script>');
  })
  .listen(0);
const url = `http://localhost:${server.address().port}/`;
// software WebGL where there is no GPU (most CI machines)
const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--autoplay-policy=no-user-gesture-required', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

const results = {};
const logs = [];
const listen = (page) => page.on('console', (m) => ['error', 'warning'].includes(m.type()) && logs.push(m.text().slice(0, 200))).on('pageerror', (e) => logs.push(`page error: ${e.message}`));
try {
  const browser = await chromium.launch({ executablePath: exe, headless: true, args });
  results.browser = browser.version();
  const page = await browser.newPage();
  listen(page);
  await page.goto(url);
  results.engine = await page.evaluate((ms) => window.engine(ms), SECONDS * 1000);
  await browser.close();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunroom-smoke-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath: exe, headless: true, args: [...args, `--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  const page2 = await context.newPage();
  listen(page2);
  await page2.goto(url);
  results.extension = await page2.evaluate((ms) => window.page(ms), 6000);
  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
} finally {
  server.close();
}

const { engine: e, extension: x } = results;
console.log(JSON.stringify({ os: `${os.platform()} ${os.release()} ${os.arch()}`, ...results }, null, 1));
if (logs.length) console.log('browser said:\n  ' + [...new Set(logs)].slice(0, 12).join('\n  '));
const checks = [
  ['engine: no error', e.error === null],
  ['engine: frames keep coming', e.out.frames >= SECONDS * 2],
  ['engine: output keeps the camera size', e.out.size.join() === e.raw.size.join()],
  ['engine: a dark picture comes out brighter', e.out.luma >= e.raw.luma + 15],
  ['extension: the page gets a live track that carries the camera label', x.readyState === 'live' && x.cameraLabels.includes(x.label)],
  ['extension: the page gets the brighter picture', x.out.luma >= e.raw.luma + 15 && x.out.frames >= 12],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);

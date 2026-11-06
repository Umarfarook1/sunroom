// Fail-safe test: kill the GPU context mid-stream and check the output track keeps carrying video.
// Uses Chrome's fake camera, so it never opens the real webcam.
// Usage: node eval/failsafe.mjs <clip.mjpeg>
import { chromium } from 'playwright-core';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const clip = path.resolve(process.argv[2] ?? 'data/fake/asfound_auto.mjpeg');
if (!fs.existsSync(clip)) throw new Error(`fake camera clip not found: ${clip}`);
await build({
  stdin: {
    contents: `
      import { CameraSession } from './packages/core/src/index';
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      window.run = async () => {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        const session = new CameraSession(stream.getVideoTracks()[0], { director: false });
        const video = document.createElement('video');
        video.muted = true;
        video.srcObject = new MediaStream([session.track]);
        document.body.appendChild(video);
        await video.play();
        let frames = 0;
        const count = () => { frames++; video.requestVideoFrameCallback(count); };
        video.requestVideoFrameCallback(count);
        const probe = document.createElement('canvas');
        probe.width = 64; probe.height = 36;
        const ctx = probe.getContext('2d', { willReadFrequently: true });
        const luma = () => { ctx.drawImage(video, 0, 0, 64, 36); const d = ctx.getImageData(0, 0, 64, 36).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i + 1]; return s / (d.length / 4); };
        await sleep(2500);
        const before = { frames, luma: luma(), error: session.status.error };
        session.canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext();
        await sleep(500);
        const at = frames;
        await sleep(2500);
        const after = { frames: frames - at, luma: luma(), error: session.status.error, track: session.track.readyState };
        await session.stop();
        return { before, after };
      };`,
    resolveDir: process.cwd(),
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  outfile: 'data/.cache/failsafe-page.js',
  logLevel: 'warning',
});
const server = http
  .createServer((req, res) => {
    if (req.url === '/page.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(fs.readFileSync('data/.cache/failsafe-page.js'));
    res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><script src="/page.js"></script>');
  })
  .listen(0);
const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page error]', e.message));
await page.goto(`http://localhost:${server.address().port}/`);
const r = await page.evaluate(() => window.run());
await browser.close();
server.close();

console.log(JSON.stringify(r));
const checks = [
  ['enhancing before the failure', r.before.frames > 30 && r.before.error === null],
  ['failure is reported', typeof r.after.error === 'string' && r.after.error.length > 0],
  ['track is still live', r.after.track === 'live'],
  ['frames keep arriving after the failure', r.after.frames > 30],
  ['the picture is real video, not black', r.after.luma > 8],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);

// The whole Windows chain on real hardware: real webcam -> Sunroom desktop app -> the registered
// "Sunroom Camera" -> two real readers (ffmpeg through DirectShow, then Chrome through getUserMedia).
// Needs the camera registered (apps/desktop/tools/register-virtual-camera.ps1) and ffmpeg on PATH.
// Usage: node apps/desktop/build.mjs && node eval/live-vcam.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, chromium } from 'playwright-core';

const root = path.resolve('apps/desktop');
const out = path.resolve('data/live');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = {};

const app = await _electron.launch({ executablePath: createRequire(path.join(root, 'package.json'))('electron'), args: [root] });
try {
  const page = await app.firstWindow();
  const status = () =>
    page.evaluate(() => {
      const s = window.__sunroom?.session?.status;
      return s && { cameraFps: +s.cameraFps.toFixed(1), outputFps: +s.outputFps.toFixed(1), ms: +s.processMs.toFixed(1), director: s.director.mode, vcam: document.getElementById('sunroom-vcam')?.dataset.state };
    });
  await sleep(12000);
  result.appBefore = await status();

  // reader 1: a DirectShow program
  const png = path.join(out, 'vcam_ffmpeg.png');
  const t0 = Date.now();
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow', '-video_size', '1280x720', '-framerate', '30', '-i', 'video=Sunroom Camera', '-frames:v', '150', '-update', '1', png], { encoding: 'utf8' });
  result.ffmpeg = { ok: ff.status === 0, seconds: +((Date.now() - t0) / 1000).toFixed(1), error: ff.stderr.trim().slice(0, 300), png };
  result.appWhileFfmpegRead = await status();

  // reader 2: a browser, the way a web call would open it
  const server = http.createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><video id="v" autoplay muted playsinline></video>')).listen(0);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const web = await browser.newPage();
  await web.goto(`http://localhost:${server.address().port}/`);
  result.chrome = await web.evaluate(async () => {
    // labels only appear after a permission grant; ask for the virtual camera by name afterwards
    const probe = await navigator.mediaDevices.getUserMedia({ video: true }).catch((e) => e.name);
    if (probe instanceof MediaStream) probe.getTracks().forEach((t) => t.stop());
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const cam = cams.find((d) => d.label.includes('Sunroom Camera'));
    if (!cam) return { listed: cams.map((d) => d.label), opened: false };
    const stream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: cam.deviceId }, width: 1280, height: 720 } });
    const v = document.getElementById('v');
    v.srcObject = stream;
    await v.play();
    let frames = 0;
    const count = () => { frames++; v.requestVideoFrameCallback(count); };
    v.requestVideoFrameCallback(count);
    await new Promise((r) => setTimeout(r, 4000));
    const c = document.createElement('canvas');
    c.width = 64; c.height = 36;
    const x = c.getContext('2d');
    x.drawImage(v, 0, 0, 64, 36);
    const d = x.getImageData(0, 0, 64, 36).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += d[i + 1];
    return { listed: cams.map((d) => d.label), opened: true, label: stream.getVideoTracks()[0].label, size: [v.videoWidth, v.videoHeight], fps: +(frames / 4).toFixed(1), meanLuma: Math.round(s / (d.length / 4)) };
  });
  if (result.chrome.opened) await web.locator('video').screenshot({ path: path.join(out, 'vcam_chrome.png') });
  result.appWhileChromeRead = await status();
  await browser.close();
  server.close();
  await sleep(6000);
  result.appAfterReaders = await status(); // back to "waiting": nothing is read from the camera track for the virtual camera now
} finally {
  console.log(JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(out, 'vcam.json'), JSON.stringify(result, null, 1));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await sleep(1500);
}

// The whole virtual camera chain: camera -> Sunroom desktop app -> the system's "Sunroom Camera" -> two real
// readers (ffmpeg through the OS camera API, then a browser through getUserMedia).
// Windows: needs the camera registered (apps/desktop/tools/register-virtual-camera.ps1). Reads through DirectShow.
// Linux: needs v4l2loopback loaded (apps/desktop/PLATFORMS.md). Reads through V4L2.
// Both need ffmpeg on PATH. With a clip, the app runs on the browser's fake camera instead of the real webcam.
// Usage: npm run build && node eval/live-vcam.mjs [clip.y4m|clip.mjpeg]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron, chromium } from 'playwright-core';
import { findChromium } from '../tools/chromium.mjs';

const clip = process.argv[2] && path.resolve(process.argv[2]);
const linux = process.platform === 'linux';
const root = path.resolve('apps/desktop');
const out = path.resolve('data/live');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { os: `${process.platform} ${process.arch}`, camera: clip ? path.basename(clip) : 'real webcam' };

const app = await _electron.launch({
  executablePath: createRequire(path.join(root, 'package.json'))('electron'),
  // CI machines have no GPU and no user namespace for the sandbox
  args: [root, ...(linux ? ['--no-sandbox', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : [])],
  env: { ...process.env, ...(clip && { SUNROOM_FAKE_CAMERA: clip }) },
});
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error('[app page error]', e.message));
  const status = () =>
    page.evaluate(() => {
      const s = window.__sunroom?.session?.status;
      return s ? { cameraFps: +s.cameraFps.toFixed(1), outputFps: +s.outputFps.toFixed(1), ms: +s.processMs.toFixed(1), size: `${s.width}x${s.height}`, director: s.director.mode, vcam: document.getElementById('sunroom-vcam')?.dataset.state, input: window.__sunroom.session.camera.label, offered: [...document.querySelectorAll('select option')].map((o) => o.textContent) } : null;
    });
  const until = async (cond, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await cond()) return true;
    return false;
  };
  await until(async () => ((await status())?.outputFps ?? 0) > 3, 60_000);
  await sleep(clip ? 3000 : 12000); // the real camera needs time for the director to settle
  if (linux) await until(async () => (await status())?.vcam === 'sending', 30_000);
  result.appBefore = await status();

  // reader 1: a native program
  const png = path.join(out, 'vcam_ffmpeg.png');
  fs.rmSync(png, { force: true });
  const source = linux ? ['-f', 'v4l2', '-i', process.env.SUNROOM_V4L2_DEVICE ?? '/dev/video10'] : ['-f', 'dshow', '-video_size', '1280x720', '-framerate', '30', '-i', 'video=Sunroom Camera'];
  const t0 = Date.now();
  const ff = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...source, '-frames:v', clip ? '30' : '150', '-update', '1', png], { encoding: 'utf8', timeout: 120_000 });
  result.ffmpeg = { ok: ff.status === 0 && fs.existsSync(png) && fs.statSync(png).size > 0, seconds: +((Date.now() - t0) / 1000).toFixed(1), error: (ff.stderr ?? String(ff.error ?? '')).trim().slice(0, 300), png };
  result.appWhileFfmpegRead = await status();

  // reader 2: a browser, the way a web call would open it
  const server = http.createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8"><video id="v" autoplay muted playsinline></video>')).listen(0);
  const flags = ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
  const browser = linux ? await chromium.launch({ executablePath: findChromium(), headless: true, args: flags }) : await chromium.launch({ channel: 'chrome', headless: true, args: flags });
  result.browser = browser.version();
  const web = await browser.newPage();
  await web.goto(`http://localhost:${server.address().port}/`);
  result.chrome = await web.evaluate(async () => {
    // labels only appear after a permission grant; ask for the virtual camera by name afterwards
    const probe = await navigator.mediaDevices.getUserMedia({ video: true }).catch((e) => e.name);
    if (probe instanceof MediaStream) probe.getTracks().forEach((t) => t.stop());
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const cam = cams.find((d) => d.label.includes('Sunroom Camera'));
    if (!cam) return { listed: cams.map((d) => d.label), opened: false, probe: String(probe) };
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
  result.appAfterReaders = await status();
} finally {
  console.log(JSON.stringify(result, null, 1));
  fs.writeFileSync(path.join(out, 'vcam.json'), JSON.stringify(result, null, 1));
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await sleep(1500);
}

const { chrome: c = {} } = result;
const checks = [
  ['the app enhances the camera', (result.appBefore?.outputFps ?? 0) > 3],
  ['the app reads a real camera and does not offer its own output as an input', !!result.appBefore && !`${result.appBefore.input}|${result.appBefore.offered}`.includes('Sunroom Camera')],
  ['a native program (ffmpeg) reads Sunroom Camera', result.ffmpeg?.ok === true],
  ['the browser lists Sunroom Camera', c.listed?.some((l) => l.includes('Sunroom Camera')) === true],
  ['the browser opens it and frames keep coming', c.opened === true && c.fps > 2],
  ['the browser sees a lit picture, not a black one', c.meanLuma > 40],
  ['the app says it is sending while the browser reads', result.appWhileChromeRead?.vcam === 'sending'],
  // Windows hears the reader leave; v4l2loopback never says, so Linux keeps sending
  [linux ? 'the app keeps feeding the device' : 'the app stops sending once the readers leave', result.appAfterReaders?.vcam === (linux ? 'sending' : 'waiting')],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);

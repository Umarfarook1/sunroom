// End to end on Windows: the Electron app on Chromium's fake camera feeding the simulated filter.
// Usage: node test/e2e.mjs [clip.mjpeg]   (build first: node build.mjs)
// Saves test/shots/received.png (a frame as the filter got it) and test/shots/window.png, prints a JSON summary.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const clip = path.resolve(process.argv[2] ?? path.join(root, '../../data/fake/dim_exp-5_gain1.mjpeg'));
const shots = path.join(root, 'test/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
assert.ok(fs.existsSync(clip), `no clip at ${clip}`);
fs.mkdirSync(shots, { recursive: true });

const app = await _electron.launch({
  executablePath: createRequire(import.meta.url)('electron'),
  args: [root],
  env: { ...process.env, SUNROOM_FAKE_CAMERA: clip },
});
const summary = {};
try {
  const page = await app.firstWindow();
  page.on('console', (m) => console.error('[page]', m.text()));
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  const vcamState = () => page.evaluate(() => document.getElementById('sunroom-vcam')?.dataset.state ?? null);
  const until = async (what, cond, ms) => {
    const end = Date.now() + ms;
    while (!(await cond())) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(100);
    }
  };
  /** CPU per process and the enhancer's own frame rate over a window of `ms`. */
  const phase = async (ms) => {
    await app.evaluate(({ app }) => app.getAppMetrics());
    const main0 = await app.evaluate(() => [process.cpuUsage(), performance.now()]);
    const fps = [];
    for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) fps.push(await page.evaluate(() => window.__sunroom.session.status.outputFps));
    const procs = await app.evaluate(({ app }) => app.getAppMetrics().map((p) => ({ type: p.type, cpu: p.cpu.percentCPUUsage })));
    const mainCoreShare = await app.evaluate((_, [u, t]) => {
      const d = process.cpuUsage(u);
      return ((d.user + d.system) / 1000 / (performance.now() - t)) * 100;
    }, main0);
    return {
      // Electron reports percentCPUUsage as a share of the whole machine; the main process's own counter checks that
      cpuTotalOfMachine: +procs.reduce((s, p) => s + p.cpu, 0).toFixed(1),
      cpuByProcess: procs.map((p) => `${p.type} ${p.cpu.toFixed(1)}`).join(', '),
      mainProcessOfOneCore: +mainCoreShare.toFixed(1),
      enhancerFps: +(fps.reduce((a, b) => a + b, 0) / fps.length).toFixed(1),
    };
  };
  const exportStats = () => page.evaluate(() => ({ frames: 0, ...window.__sunroomExport, elapsedMs: performance.now() - window.__sunroomExport.startedAt }));

  await until('the enhanced camera to run', () => page.evaluate(() => (window.__sunroom?.session?.status.outputFps ?? 0) > 20), 30_000);
  summary.session = await page.evaluate(() => {
    const s = window.__sunroom.session.status;
    return { width: s.width, height: s.height, cameraFps: +s.cameraFps.toFixed(1), processMs: +s.processMs.toFixed(1), transport: s.transport };
  });
  summary.stateBeforeApp = await vcamState();
  summary.noApp = await phase(5000);
  summary.framesExportedWithNoApp = (await exportStats()).frames;

  const sim = spawn(process.execPath, [path.join(root, 'test/receiver-sim.mjs'), '--frames', '100000', '--seconds', '12', '--png', path.join(shots, 'received.png')], { stdio: ['ignore', 'pipe', 'inherit'] });
  let simOut = '';
  sim.stdout.on('data', (d) => (simOut += d));
  const simDone = new Promise((r) => sim.on('exit', r));

  await until('the virtual camera to start sending', async () => (await vcamState()) === 'sending', 6000);
  summary.stateWithApp = 'sending';
  summary.sending = await phase(5000);
  const s = await exportStats();
  summary.export = {
    frames: s.frames,
    dropped: s.dropped + s.pageDropped,
    fps: +((s.frames * 1000) / s.elapsedMs).toFixed(1),
    size: `${s.width}x${s.height}`,
    workerReadbackMs: +(s.readMs / s.reads).toFixed(2),
    workerPostMessageMs: +(s.postMs / s.frames).toFixed(2),
    mainSendMs: +(s.mainMs / s.acks).toFixed(2),
    rendererToMainMs: +(s.transitMs / s.acks).toFixed(2),
  };
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  const shownFrames = (await exportStats()).frames;
  await sleep(3000);
  summary.exportFpsWhileHidden = +(((await exportStats()).frames - shownFrames) / 3).toFixed(1);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

  await simDone;
  summary.receiver = JSON.parse(simOut);
  // after the receiver is done, since capturing stalls the renderer (one 580 ms gap measured); the badge still reads "Sending" here
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(path.join(shots, 'window.png'), Buffer.from(png, 'base64'));
  summary.rawLuma = await page.evaluate(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
    const track = stream.getVideoTracks()[0];
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let sum = 0;
    for (let f = 0; f < 60; f++) {
      const { value: frame } = await reader.read();
      const { width, height } = frame.visibleRect;
      const px = new Uint8Array(width * height * 4);
      await frame.copyTo(px, { format: 'RGBA' });
      frame.close();
      let s = 0;
      let n = 0;
      for (let y = 0; y < height; y += 8) for (let x = 0; x < width; x += 8, n++) s += 0.2126 * px[(y * width + x) * 4] + 0.7152 * px[(y * width + x) * 4 + 1] + 0.0722 * px[(y * width + x) * 4 + 2];
      sum += s / n;
    }
    track.stop();
    return +(sum / 60).toFixed(1);
  });

  await until('the camera to go idle after the app left', async () => (await vcamState()) === 'waiting', 6000);
  const before = (await exportStats()).frames;
  await sleep(2000);
  summary.framesExportedWhileIdle = (await exportStats()).frames - before;
  summary.badgeText = await page.evaluate(() => document.getElementById('sunroom-vcam').textContent);
} finally {
  console.log(JSON.stringify(summary, null, 2));
  await app.close();
}

const rx = summary.receiver;
assert.ok(['not-installed', 'waiting'].includes(summary.stateBeforeApp), 'no app yet, so not sending');
assert.equal(summary.framesExportedWithNoApp, 0, 'nothing is read from the track while no app wants frames');
assert.deepEqual(rx.errors, []);
assert.deepEqual([rx.width, rx.height, rx.stride, rx.format], [1280, 720, 1280, 0]);
assert.ok(rx.frames >= 100, `${rx.frames} frames received`);
assert.ok(rx.fps >= 0.8 * summary.sending.enhancerFps, `received ${rx.fps.toFixed(1)} fps while the enhancer made ${summary.sending.enhancerFps}`);
assert.ok(rx.meanLuma > summary.rawLuma + 30, `received luma ${rx.meanLuma.toFixed(1)} vs raw ${summary.rawLuma}`);
assert.equal(summary.framesExportedWhileIdle, 0, 'export stops once the app stops reading');
assert.ok(summary.exportFpsWhileHidden >= 0.8 * summary.export.fps, `exported ${summary.exportFpsWhileHidden} fps while hidden vs ${summary.export.fps} shown`);
console.log('e2e passed');

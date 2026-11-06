// Live check of the desktop app on the real webcam: runs it for a few seconds with the simulated camera
// filter attached, saves what the filter received, quits the way the tray's Quit does.
// Check afterwards that the camera was handed back: tools/bin/camctl.exe list
// Usage: node apps/desktop/build.mjs && node eval/live-desktop.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron } from 'playwright-core';

const root = path.resolve('apps/desktop');
const out = path.resolve('data/live');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({ executablePath: createRequire(path.join(root, 'package.json'))('electron'), args: [root] });
const page = await app.firstWindow();
page.on('pageerror', (e) => console.error('[page error]', e.message));
const status = () =>
  page.evaluate(() => {
    const s = window.__sunroom?.session?.status;
    return s && { fps: +s.cameraFps.toFixed(1), outFps: +s.outputFps.toFixed(1), ms: +s.processMs.toFixed(1), busy: +s.busy.toFixed(2), face: !!s.face, director: s.director, error: s.error, line: document.getElementById('status')?.textContent };
  });

const samples = [];
for (let i = 0; i < 10; i++) {
  await sleep(1000);
  samples.push(await status());
}
const sim = spawn(process.execPath, [path.join(root, 'test/receiver-sim.mjs'), '--frames', '100000', '--seconds', '6', '--png', path.join(out, 'desktop_received.png')], { stdio: ['ignore', 'pipe', 'inherit'] });
let simOut = '';
sim.stdout.on('data', (d) => (simOut += d));
await new Promise((r) => sim.on('exit', r));
const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
fs.writeFileSync(path.join(out, 'desktop_window.png'), Buffer.from(png, 'base64'));
const result = { samples, last: await status(), receiver: JSON.parse(simOut) };
fs.writeFileSync(path.join(out, 'desktop.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1));
await app.evaluate(({ app }) => app.quit()).catch(() => {});
await sleep(1500);

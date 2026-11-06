// The packaged app as a user gets it, on Chromium's fake camera: it must show the web UI, enhance, run its
// virtual camera backend (koffi) and carry its register script as a real file inside its own folder.
// Usage: node apps/desktop/test/installed.mjs <Sunroom.exe> <clip.y4m> [--setup]
// --setup also clicks "Set up Sunroom Camera", which WRITES THIS USER'S REGISTRY. Meant for throwaway CI machines.
// The exe is the installed one, or apps/desktop/release/win-unpacked/Sunroom.exe after npm run dist -w apps/desktop.
import fs from 'node:fs';
import path from 'node:path';
import { _electron } from 'playwright-core';

const setup = process.argv.includes('--setup');
const [exe, clip] = process.argv.slice(2).filter((a) => !a.startsWith('--')).map((p) => path.resolve(p));
if (!exe || !clip || !fs.existsSync(exe) || !fs.existsSync(clip)) throw new Error('usage: installed.mjs <Sunroom.exe> <clip.y4m>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inside = (dir, file) => file.toLowerCase().startsWith(dir.toLowerCase() + path.sep);

const app = await _electron.launch({
  executablePath: exe,
  // CI machines have no GPU
  args: process.env.CI ? ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : [],
  env: { ...process.env, SUNROOM_FAKE_CAMERA: clip },
});
const result = { exe };
try {
  const page = await app.firstWindow();
  page.on('pageerror', (e) => console.error('[app page error]', e.message));
  result.appPath = await app.evaluate(({ app }) => app.getAppPath());
  const look = () =>
    page.evaluate(() => {
      const s = window.__sunroom?.session?.status;
      const badge = document.getElementById('sunroom-vcam');
      return { webUi: document.querySelector('meta[name="sunroom"]')?.content === 'app', outputFps: s ? +s.outputFps.toFixed(1) : 0, size: s ? `${s.width}x${s.height}` : null, error: s ? s.error : 'no session', vcam: badge?.dataset.state ?? null, vcamText: badge?.textContent ?? '' };
    });
  for (const end = Date.now() + 60_000; Date.now() < end; await sleep(250)) {
    result.app = await look();
    if (result.app.outputFps > 3 && result.app.vcam) break;
  }
  if (setup) {
    result.before = result.app.vcam;
    await page.click('#sunroom-vcam button');
    for (const end = Date.now() + 60_000; Date.now() < end; await sleep(250)) {
      result.app = await look();
      if (result.app.vcam === 'waiting') break;
    }
  }
} finally {
  console.log(JSON.stringify(result, null, 1));
  await app.close();
}

const { app: seen = {} } = result;
const script = path.join(result.appPath, 'tools', 'register-virtual-camera.ps1');
const checks = [
  ['shows the web UI, not the built-in fallback page', seen.webUi === true],
  ['enhances the camera', seen.outputFps > 3],
  ['the engine reports no error', seen.error === null],
  ['the virtual camera backend runs (koffi loaded)', ['not-installed', 'waiting', 'sending'].includes(seen.vcam)],
  ['the camera filter files are inside the app folder', ['UnityCaptureFilter64.dll', 'UnityCaptureFilter32.dll', 'LICENSE.txt'].every((f) => fs.existsSync(path.join(result.appPath, 'vendor', 'unitycapture', f)))],
  ...(setup ? [['one click on "Set up Sunroom Camera" takes the app from not set up to ready', result.before === 'not-installed' && seen.vcam === 'waiting']] : []),
  [`the register script is a real file inside the app folder: ${script}`, inside(path.dirname(exe), script) && fs.statSync(script, { throwIfNoEntry: false })?.isFile() === true],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);

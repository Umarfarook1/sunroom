// The Windows desktop app the way a new user meets it, on the real webcam:
// no "Sunroom Camera" yet -> the app's own setup button adds it -> the webcam is let go while the window is hidden
// and nothing reads the camera -> an app opening Sunroom Camera brings it back -> it is let go again.
// CHANGES THIS USER'S REGISTRY: removes the per-user "Sunroom Camera" entries, then adds them back through the app.
// Usage: npm run build && node eval/live-windows-app.mjs "<name of the real webcam as ffmpeg lists it>"
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { _electron } from 'playwright-core';

if (process.platform !== 'win32') throw new Error('Windows only');
const webcam = process.argv[2];
if (!webcam) throw new Error('usage: node eval/live-windows-app.mjs "<webcam name>"  (see: ffmpeg -list_devices true -f dshow -i dummy)');
const root = path.resolve('apps/desktop');
const out = path.resolve('data/live');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dllDir = path.join(process.env.LOCALAPPDATA, 'sunroom', 'vcam');
const script = path.join(root, 'tools', 'register-virtual-camera.ps1');
const cameras = () => spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' }).stderr;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// a machine that never had the camera: no registry entries, no filter files
const removed = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Uninstall', '-Yes'], { encoding: 'utf8' });
const backup = `${dllDir}.before-test`;
fs.rmSync(backup, { recursive: true, force: true });
if (fs.existsSync(dllDir)) fs.renameSync(dllDir, backup);
check('start: the camera is not registered', removed.status === 0 && !cameras().includes('Sunroom Camera'), removed.stdout.trim().split('\n').pop());

const app = await _electron.launch({ executablePath: createRequire(path.join(root, 'package.json'))('electron'), args: [root] });
try {
  const page = await app.firstWindow();
  const look = () =>
    page.evaluate(() => ({
      vcam: document.getElementById('sunroom-vcam')?.dataset.state,
      text: document.querySelector('#sunroom-vcam span')?.textContent,
      button: !document.querySelector('#sunroom-vcam button')?.hidden,
      view: document.body.dataset.view,
      camera: window.__sunroom?.session?.camera?.readyState ?? null,
      fps: +(window.__sunroom?.session?.status.outputFps ?? 0).toFixed(1),
    }));
  const until = async (cond, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (cond(await look())) return true;
    return false;
  };
  const setWindow = (how) => app.evaluate(({ BrowserWindow }, how) => BrowserWindow.getAllWindows()[0][how](), how);
  // one frame straight from the webcam: only works while Sunroom is not holding it
  const webcamFree = () => spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `video=${webcam}`, '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8', timeout: 20_000 }).status === 0;

  await until((s) => s.fps > 10 && s.vcam === 'not-installed', 30_000);
  let s = await look();
  check('the app runs and offers to set the camera up', s.fps > 10 && s.vcam === 'not-installed' && s.button, JSON.stringify(s));

  await page.click('#sunroom-vcam button');
  const ready = await until((s) => s.vcam === 'waiting', 30_000);
  s = await look();
  check('one click sets up Sunroom Camera', ready && !s.button, s.text);
  const files = ['UnityCaptureFilter64.dll', 'UnityCaptureFilter32.dll'];
  check('the filter files it installed are the shipped ones', files.every((f) => fs.existsSync(path.join(dllDir, f)) && sha(path.join(dllDir, f)) === sha(path.join(root, 'vendor', 'unitycapture', f))));
  // the app says ready as soon as the first registry key exists; the script needs a moment more for the rest
  let listed = false;
  for (const end = Date.now() + 10_000; !listed && Date.now() < end; await sleep(500)) listed = cameras().includes('Sunroom Camera');
  check('Windows lists Sunroom Camera for other apps', listed);

  check('while the window shows, Sunroom holds the webcam', !webcamFree());
  await setWindow('hide');
  const rested = await until((s) => s.camera === null && s.view === 'resting', 15_000);
  check('hidden and unused: the webcam is let go', rested && webcamFree(), JSON.stringify(await look()));

  // an app opens Sunroom Camera while Sunroom sits in the tray
  const png = path.join(out, 'setup_reader.png');
  fs.rmSync(png, { force: true });
  const reader = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow', '-video_size', '1280x720', '-framerate', '30', '-i', 'video=Sunroom Camera', '-frames:v', '300', '-update', '1', png], { stdio: 'ignore' });
  const done = new Promise((r) => reader.on('close', r));
  const t0 = Date.now();
  const woke = await until((s) => s.vcam === 'sending' && s.fps > 10, 20_000);
  check('an app opening Sunroom Camera turns the webcam back on', woke, `${((Date.now() - t0) / 1000).toFixed(1)} s, ${JSON.stringify(await look())}`);
  check('the reader finished and got a picture', (await done) === 0 && fs.existsSync(png) && fs.statSync(png).size > 20_000, png);

  const restedAgain = await until((s) => s.camera === null && s.view === 'resting', 20_000);
  check('the reader left: the webcam is let go again', restedAgain && webcamFree());
  // a second app, while another program holds the webcam: Sunroom must keep trying and recover by itself
  const holder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', `video=${webcam}`, '-t', '12', '-f', 'null', '-'], { stdio: 'ignore' });
  const released = new Promise((r) => holder.on('close', r));
  await sleep(3000);
  const second = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow', '-video_size', '1280x720', '-framerate', '30', '-i', 'video=Sunroom Camera', '-frames:v', '900', '-f', 'null', '-'], { stdio: 'ignore' });
  await sleep(5000);
  const blocked = await look();
  check('while another program holds the webcam, Sunroom says so and waits', blocked.camera === null && blocked.view === 'problem', JSON.stringify(blocked));
  await released;
  const t1 = Date.now();
  const recovered = await until((s) => s.vcam === 'sending' && s.fps > 10, 30_000);
  check('once the webcam is free, Sunroom takes it and sends without being asked', recovered, `${((Date.now() - t1) / 1000).toFixed(1)} s after the other program let go`);
  second.kill();
  check('the second reader left: the webcam is let go again', await until((s) => s.camera === null && s.view === 'resting', 20_000));

  await setWindow('show');
  check('opening the window turns the webcam on', await until((s) => s.fps > 10 && s.view === 'live', 20_000));
} finally {
  await app.evaluate(({ app }) => app.quit()).catch(() => {});
  await sleep(1500);
  // never leave the machine without the files it had
  if (!fs.existsSync(dllDir) && fs.existsSync(backup)) fs.renameSync(backup, dllDir);
  else fs.rmSync(backup, { recursive: true, force: true });
}
console.log(`${checks.filter(Boolean).length}/${checks.length} passed`);
process.exit(checks.every(Boolean) ? 0 : 1);

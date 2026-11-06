// End-to-end test of the extension on Chromium's fake camera, fed real dark footage from data/fake.
// Usage: node apps/extension/test/e2e.mjs [--browser <path to a Chromium-based browser>] [--offline]
// --browser defaults to Playwright's own Chromium (npx playwright-core install chromium): branded Chrome 137+
// ignores --load-extension. Microsoft Edge works too.
// --offline skips the public WebRTC sample page. Everything runs headless.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const dist = path.resolve(here, '../dist');
const shots = path.join(here, 'shots');
// any Chromium that Playwright has downloaded will do, newest first
const cache = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.cache'), 'ms-playwright');
const cached = fs.existsSync(cache)
  ? fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse().flatMap((d) => ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux/chrome'].map((f) => path.join(cache, d, f)))
  : [];
const exe = process.argv.includes('--browser') ? process.argv[process.argv.indexOf('--browser') + 1] : [chromium.executablePath(), ...cached].find((f) => fs.existsSync(f));
if (!exe || !fs.existsSync(exe)) throw new Error('no Chromium found; run "npx playwright-core install chromium" or pass --browser <path>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The fake camera plays Y4M copies of the recorded clips. Fed the .mjpeg files directly, Chromium's reader ends
// the track within two seconds (each JPEG is followed by zero padding) and, in a visible window, Edge 156's
// capture service crashes. Converted once with ffmpeg and kept in the temp folder.
const clipDir = path.join(os.tmpdir(), 'sunroom-e2e-clips');
fs.mkdirSync(clipDir, { recursive: true });
const clips = ['dim_exp-5_gain1', 'asfound_auto', 'dark_exp-7_gain8'].map((name) => {
  const out = path.join(clipDir, `${name}.y4m`);
  if (!fs.existsSync(out)) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'mjpeg', '-framerate', '30', '-i', path.join(root, 'data/fake', `${name}.mjpeg`), '-pix_fmt', 'yuv420p', `${out}.part.y4m`]);
    fs.renameSync(`${out}.part.y4m`, out);
  }
  return out;
});

execFileSync(process.execPath, [path.join(here, '../build.mjs')], { stdio: 'inherit' });
fs.mkdirSync(shots, { recursive: true });

// Chromium names an unpacked extension after its path: sha256 of the path (UTF-16 on Windows), first 16 bytes, nibbles as a..p
const idPath = process.platform === 'win32' ? Buffer.from(dist.replace(/^[a-z]:/, (d) => d.toUpperCase()), 'utf16le') : Buffer.from(dist);
const extensionId = [...crypto.createHash('sha256').update(idPath).digest().subarray(0, 16)].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');

const server = http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.join(here, 'pages', path.basename(url.pathname) || 'gum.html');
    if (!fs.existsSync(file)) return res.writeHead(404).end();
    const headers = { 'content-type': file.endsWith('.js') ? 'text/javascript' : 'text/html' };
    if (url.pathname.startsWith('/csp/')) headers['content-security-policy'] = "script-src 'self'";
    res.writeHead(200, headers).end(fs.readFileSync(file));
  })
  .listen(0);
const port = server.address().port;
const site = `http://localhost:${port}`;

const results = [];
const check = (name, ok, detail) => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol * b;
const brighter = (on, off) => on >= off + 20 && on >= off * 1.3;

const browserArgs = (clip) => [
  `--disable-extensions-except=${dist}`,
  `--load-extension=${dist}`,
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-video-capture=${clip}`,
  '--autoplay-policy=no-user-gesture-required',
  '--enable-gpu',
  '--ignore-gpu-blocklist',
  '--use-angle=d3d11',
];

async function launch(clip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunroom-e2e-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath: exe, headless: true, viewport: { width: 900, height: 640 }, args: browserArgs(clip) });
  context.on('page', (p) => p.on('console', (m) => ['error', 'warning'].includes(m.type()) && console.log(`  [page ${m.type()}] ${m.text().slice(0, 200)}`)));
  // an extension page drives chrome.storage and asks tabs for their reports, as the popup does
  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/popup.html`);
  const ext = {
    set: (s) => control.evaluate((s) => chrome.storage.local.set(s), s),
    tab: (host) =>
      control.evaluate(async (host) => {
        for (const t of await chrome.tabs.query({})) {
          const r = await chrome.tabs.sendMessage(t.id, { type: 'sunroom:top' }, { frameId: 0 }).catch(() => null);
          if (r?.site === host) return t.id;
        }
        return null;
      }, host),
    top: (tabId) => control.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'sunroom:top' }, { frameId: 0 }), tabId),
    live: (tabId) => control.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'sunroom:live' }).catch(() => []), tabId),
  };
  const popupShot = async (tabId, name) => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 300, height: 300 });
    await popup.goto(`chrome-extension://${extensionId}/popup.html?tab=${tabId}`);
    await popup.waitForTimeout(1200);
    await popup.locator('body').screenshot({ path: path.join(shots, `${name}.png`) });
    const text = await popup.locator('#status').textContent();
    await popup.close();
    return text;
  };
  const close = async () => {
    await context.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { context, ext, popupShot, close };
}

/**
 * Frames per second a call page receives while another tab is in front. Playwright's focus emulation keeps every
 * page it drives visible, so this run starts the browser itself and talks raw CDP to the extension page only.
 */
async function backgroundRun(clip) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunroom-e2e-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, ...browserArgs(clip), `chrome-extension://${extensionId}/popup.html`]);
  const portFile = path.join(dir, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(200);
  await sleep(1000);
  const devtools = fs.readFileSync(portFile, 'utf8').split('\n')[0];
  const attach = async (urlPart) => {
    const target = (await (await fetch(`http://127.0.0.1:${devtools}/json/list`)).json()).find((t) => t.url.includes(urlPart));
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let next = 0;
    return (expression) =>
      new Promise((resolve) => {
        const id = ++next;
        ws.addEventListener('message', function onMessage(e) {
          const m = JSON.parse(e.data);
          if (m.id !== id) return;
          ws.removeEventListener('message', onMessage);
          resolve(m.result?.result?.value);
        });
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
  };
  const control = await attach(`chrome-extension://${extensionId}/popup.html`);
  const tab = await control(`chrome.tabs.create({ url: '${site}/gum.html?log', active: true }).then((t) => t.id)`);
  await sleep(5000);
  const cover = await control(`chrome.tabs.get(${tab}).then(({ windowId }) => chrome.tabs.create({ windowId, url: 'about:blank', active: true })).then((t) => t.id)`);
  await sleep(10000);
  const handling = await control(`chrome.tabs.sendMessage(${tab}, { type: 'sunroom:top' }, { frameId: 0 }).then((r) => r.cameras.at(-1).handling)`);
  await control(`chrome.tabs.update(${tab}, { active: true }).then(() => chrome.tabs.remove(${cover}))`);
  await sleep(2000);
  const perSecond = await (await attach('gum.html?log'))('window.perSecond');
  proc.kill();
  await new Promise((r) => proc.once('exit', r));
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  // whole seconds only: the first and last hidden second straddle the tab switches
  const first = perSecond.findIndex((s) => s?.visibility === 'hidden');
  const last = perSecond.findLastIndex((s) => s?.visibility === 'hidden');
  const hidden = Array.from({ length: Math.max(last - first - 1, 0) }, (_, i) => perSecond[first + 1 + i]?.frames ?? 0);
  const fps = Math.round((hidden.reduce((a, b) => a + b, 0) / Math.max(hidden.length, 1)) * 10) / 10;
  return { handling, seconds: hidden.length, fps, perSecond: hidden.join(' ') };
}

/** Centre luma of a page's camera with Sunroom off, then on, from fresh page loads. */
async function offThenOn(b, page) {
  await b.ext.set({ enabled: false });
  await page.goto(`${site}/gum.html`);
  const raw = await page.evaluate(() => cam.open());
  await page.waitForTimeout(1500);
  const rawLuma = await page.evaluate(() => cam.luma());
  const rawRate = await page.evaluate(() => cam.count(3000));
  await page.locator('video').screenshot({ path: path.join(shots, `page-off-${path.basename(b.clip, '.y4m')}.png`) });
  await b.ext.set({ enabled: true });
  await page.goto(`${site}/gum.html`);
  const got = await page.evaluate(() => cam.open());
  await page.waitForTimeout(2000);
  const onLuma = await page.evaluate(() => cam.luma());
  await page.locator('video').screenshot({ path: path.join(shots, `page-on-${path.basename(b.clip, '.y4m')}.png`) });
  return { raw, rawLuma, rawRate, got, onLuma };
}

const b = Object.assign(await launch(clips[0]), { clip: clips[0] });
const page = await b.context.newPage();
console.log(`browser: ${exe} (${b.context.browser()?.version()}), headless, extension ${extensionId}`);

const { raw, rawLuma, rawRate, got, onLuma } = await offThenOn(b, page);
check('(a) brighter with Sunroom on', brighter(onLuma, rawLuma), `centre luma ${rawLuma} off -> ${onLuma} on (${path.basename(clips[0])}); getUserMedia took ${raw.ms} ms off, ${got.ms} ms on`);

const [device] = await page.evaluate(() => cam.cameras());
// groupId is salted per document, so the reference is enumerateDevices() on this page
const differ = ['width', 'height', 'frameRate'].filter((k) => got.settings[k] !== raw.settings[k]);
check(
  '(b) track looks like the camera',
  got.label === device.label && got.settings.deviceId === device.deviceId && got.settings.groupId === device.groupId && differ.length === 0 && got.capabilities.includes('width'),
  `label "${got.label}" vs camera "${device.label}", deviceId match ${got.settings.deviceId === device.deviceId}, groupId match ${got.settings.groupId === device.groupId}, getSettings fields differing from the raw track: [${differ}], ${got.settings.width}x${got.settings.height}@${got.settings.frameRate}, capabilities [${got.capabilities.slice(0, 6)}...]`,
);
await page.evaluate(() => cam.apply({ width: 320, height: 240 }));
await page.waitForTimeout(1000);
const small = await page.evaluate(() => ({ size: cam.size(), track: cam.track() }));
await page.evaluate((s) => cam.apply({ width: s.width, height: s.height }), got.settings);
await page.waitForTimeout(1000);
const restored = await page.evaluate(() => cam.size());
check(
  '(b) applyConstraints reaches the camera',
  small.size[0] === 320 && small.track.settings.width === 320 && small.track.constraints.width === 320 && restored[0] === got.settings.width,
  `video ${small.size.join('x')} after asking 320x240, getSettings width ${small.track.settings.width}, getConstraints ${JSON.stringify(small.track.constraints)}; ${restored.join('x')} after asking for the original size back`,
);

const tabId = await b.ext.tab('localhost');
await page.waitForTimeout(1500);
const report = (await b.ext.top(tabId)).cameras.at(-1);
const popupOn = await b.popupShot(tabId, 'popup-enhancing');
console.log(`INFO face metering on a normal page: ${report.face}; popup says "${popupOn}"`);

const front = await page.evaluate(() => cam.count(10000));

await b.ext.set({ enabled: false });
await page.waitForTimeout(800);
const offLive = await page.evaluate(() => cam.luma());
await b.ext.set({ enabled: true });
await page.waitForTimeout(1500);
const onAgain = await page.evaluate(() => cam.luma());
await b.ext.set({ disabledSites: ['localhost'] });
await page.waitForTimeout(800);
const siteOff = await page.evaluate(() => cam.luma());
const popupSiteOff = await b.popupShot(tabId, 'popup-site-off');
await b.ext.set({ disabledSites: [] });
await page.waitForTimeout(1500);
const siteOn = await page.evaluate(() => cam.luma());
check(
  '(e) settings switch enhancement live',
  near(offLive, rawLuma, 0.15) && brighter(onAgain, rawLuma) && near(siteOff, rawLuma, 0.15) && brighter(siteOn, rawLuma),
  `master: ${onLuma} -> off ${offLive} -> on ${onAgain}; this site: off ${siteOff} -> on ${siteOn} (raw ${rawLuma}); popup with site off says "${popupSiteOff}"`,
);

await page.evaluate(() => cam.open());
await page.waitForTimeout(500);
const states = async () => (await b.ext.top(tabId)).cameras.map((c) => c.camera).join(',');
const bothLive = await states();
await page.evaluate(() => cam.stopVideo(0));
await page.waitForTimeout(1000);
const firstStopped = await states();
const secondRuns = await page.evaluate(() => cam.count(1000));
await page.evaluate(() => cam.stopAll());
await page.waitForTimeout(1000);
const allStopped = await states();
check(
  '(d) track.stop() ends the real camera',
  bothLive === 'live,live' && firstStopped === 'ended,live' && secondRuns.frames > 10 && allStopped === 'ended,ended',
  `real camera tracks for two getUserMedia calls: ${bothLive} -> stop first -> ${firstStopped} (second still ${secondRuns.fps} fps) -> stop all -> ${allStopped}`,
);
const audio = await page.evaluate(() => cam.open({ audio: true, video: false }));
const afterAudio = await states();
check('(d) audio-only request passes through', audio.audio === 1 && audio.video === 0 && afterAudio === allStopped, `audio ${audio.audio}, video ${audio.video}, cameras handled ${afterAudio}`);

const cloned = await page.evaluate(() => cam.cloneThenStop());
await page.waitForTimeout(1500);
const afterClone = (await states()).split(',').at(-1);
check(
  '(d) MediaStream.clone() keeps the camera, a stop through the prototype releases it',
  cloned.labels.every((l) => l === device.label) && cloned.cloneAfterOriginalStopped === 'live' && cloned.frames > 10 && afterClone === 'ended',
  `labels ${JSON.stringify(cloned.labels)}, clone after its original stopped: ${cloned.cloneAfterOriginalStopped}, ${cloned.frames} frames in 1 s, real camera after the last stop: ${afterClone}`,
);

await page.goto(`${site}/csp/gum.html`);
const csp = await page.evaluate(() => cam.open());
await page.waitForTimeout(3000);
const cspLuma = await page.evaluate(() => cam.luma());
const cspRate = await page.evaluate(() => cam.count(2000));
const cspReport = (await b.ext.top(tabId)).cameras.at(-1);
await page.screenshot({ path: path.join(shots, 'page-csp.png') });
check(
  "(f) page with CSP script-src 'self'",
  (brighter(cspLuma, rawLuma) || near(cspLuma, rawLuma, 0.15)) && cspRate.fps >= rawRate.fps * 0.85 && csp.label === device.label,
  `luma ${cspLuma} (raw ${rawLuma}), ${cspRate.fps} fps, handling ${cspReport.handling}, face metering ${cspReport.face}`,
);

await page.evaluate(() => cam.stopAll());
await page.goto(`${site}/gum.html?frame=${encodeURIComponent(`http://127.0.0.1:${port}/gum.html`)}`);
await page.waitForFunction(() => document.querySelector('iframe')?.contentWindow);
const frame = page.frames().find((f) => f.url().startsWith('http://127.0.0.1'));
await frame.waitForFunction(() => window.cam);
const inFrame = await frame.evaluate(() => cam.open());
await page.waitForTimeout(2000);
const frameLuma = await frame.evaluate(() => cam.luma());
const frameLive = await b.ext.live(tabId);
await page.screenshot({ path: path.join(shots, 'page-iframe.png') });
check(
  '(g) cross-origin iframe gets the enhanced camera',
  inFrame.video === 1 && inFrame.label === device.label && brighter(frameLuma, rawLuma) && frameLive.some((c) => c.handling === 'enhancing'),
  `iframe luma ${frameLuma} (raw ${rawLuma}), label "${inFrame.label}", live report from the tab: ${frameLive.map((c) => c.handling)}`,
);
await frame.evaluate(() => cam.stopAll());

const breakers = {
  'no WebGL2': () => {
    const get = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (type, ...rest) {
      return type === 'webgl2' ? null : get.call(this, type, ...rest);
    };
  },
  'no float render targets (fails on the first frame)': () => {
    const get = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function (name) {
      return name === 'EXT_color_buffer_float' ? null : get.call(this, name);
    };
  },
};
for (const [name, breakIt] of Object.entries(breakers)) {
  await page.goto(`${site}/gum.html`);
  await page.evaluate(breakIt);
  const r = await page.evaluate(() => cam.open());
  await page.waitForTimeout(800);
  const l = await page.evaluate(() => cam.luma());
  const rate = await page.evaluate(() => cam.count(1500));
  const rep = (await b.ext.top(tabId)).cameras.at(-1);
  check(`(h) ${name}: page gets the untouched camera`, rep.handling === 'untouched' && near(l, rawLuma, 0.15) && rate.frames > 10 && r.label === device.label, `getUserMedia took ${r.ms} ms, luma ${l} (raw ${rawLuma}), ${rate.fps} fps, note "${rep.note}"`);
  await page.evaluate(() => cam.stopAll());
}

if (!process.argv.includes('--offline')) {
  const web = await b.context.newPage();
  try {
    await web.goto('https://webrtc.github.io/samples/src/content/getusermedia/gum/', { timeout: 30000 });
    await web.click('#showVideo');
    await web.waitForTimeout(3000);
    const seen = await web.evaluate(async () => {
      const v = document.querySelector('video');
      const t = v.srcObject.getVideoTracks()[0];
      const ctx = new OffscreenCanvas(96, 54).getContext('2d');
      ctx.drawImage(v, 0, 0, 96, 54);
      const d = ctx.getImageData(32, 18, 32, 18).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      return { label: t.label, playing: !v.paused && v.videoWidth > 0, size: `${v.videoWidth}x${v.videoHeight}`, luma: Math.round(sum / (d.length / 4)), error: document.querySelector('#errorMsg')?.textContent ?? '' };
    });
    const webTab = await b.ext.tab('webrtc.github.io');
    const webReport = webTab === null ? null : (await b.ext.top(webTab)).cameras.at(-1);
    await web.screenshot({ path: path.join(shots, 'webrtc-sample.png') });
    console.log(`INFO webrtc.github.io gum sample: ${JSON.stringify(seen)}; Sunroom report: ${webReport ? `${webReport.handling}, face ${webReport.face}, "${webReport.note}"` : 'none'}`);
  } catch (err) {
    console.log(`INFO webrtc.github.io gum sample could not be checked: ${err.message.split('\n')[0]}`);
  }
  await web.close();
}
await b.close();

// alone on the machine: a second browser decoding and enhancing at the same time halved the hidden tab's rate on a 4-core laptop
const behind = await backgroundRun(clips[0]);
check(
  '(c) frames keep arriving, also in a background tab',
  front.fps >= rawRate.fps * 0.85 && behind.seconds >= 8 && behind.fps >= rawRate.fps * 0.85 && behind.handling === 'enhancing' && front.cloneLabel === device.label,
  `camera ${rawRate.fps} fps; enhanced ${front.fps} fps over ${front.seconds} s in front (counted on clone() labelled "${front.cloneLabel}"); ${behind.fps} fps over ${behind.seconds} whole seconds with document.visibilityState hidden behind another tab [${behind.perSecond}], Sunroom ${behind.handling}`,
);

for (const clip of clips.slice(1)) {
  const c = Object.assign(await launch(clip), { clip });
  const p = await c.context.newPage();
  const r = await offThenOn(c, p);
  check(`(a) brighter with Sunroom on, ${path.basename(clip)}`, brighter(r.onLuma, r.rawLuma), `centre luma ${r.rawLuma} off -> ${r.onLuma} on`);
  await c.close();
}

server.close();
const failed = results.filter((ok) => !ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

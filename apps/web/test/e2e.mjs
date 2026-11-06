// End-to-end check of the web app in real Chrome with a fake camera playing a recorded dark clip.
// Usage: node apps/web/test/e2e.mjs [clip.mjpeg]   (clip name from data/fake, default dim_exp-5_gain1.mjpeg)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { buildWeb, serveDist } from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const shots = path.join(here, 'shots');
fs.mkdirSync(shots, { recursive: true });

// a clip made by tools/make_fake_camera.mjs
const clip = path.join(repo, 'data/fake', process.argv[2] ?? 'dim_exp-5_gain1.mjpeg');
assert(fs.existsSync(clip), `fake camera clip missing: ${clip}`);

await buildWeb();
const server = await serveDist(0);
const url = `http://127.0.0.1:${server.address().port}/`;

const gpu = ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'];
// every browser here gets the fake camera, so the real webcam is never opened
const fakeCamera = ['--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`];
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', ...fakeCamera, ...gpu] });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pass = (name, detail = '') => {
  results.push(name);
  console.log(`ok  ${name}${detail ? `  (${detail})` : ''}`);
};

async function open(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  // MediaPipe prints its own INFO lines as console errors, so only Sunroom's are counted
  page.on('console', (m) => m.type() === 'error' && m.text().includes('[sunroom]') && errors.push(m.text()));
  await page.goto(url);
  return { page, errors };
}

const waitLive = (page) =>
  page.waitForFunction(() => document.body.dataset.view === 'live' && window.__sunroom.session?.status.frame && document.getElementById('enhanced').readyState >= 2, null, { timeout: 30000 });

// mean luma of the centre half of both videos, plus mean absolute difference between them
const centre = (page) =>
  page.evaluate(() => {
    const read = (id) => {
      const c = Object.assign(document.createElement('canvas'), { width: 64, height: 36 });
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(document.getElementById(id), 0, 0, 64, 36);
      const d = ctx.getImageData(16, 9, 32, 18).data;
      const l = [];
      for (let i = 0; i < d.length; i += 4) l.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
      return l;
    };
    const a = read('enhanced');
    const b = read('original');
    const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    return { enhanced: mean(a), original: mean(b), diff: mean(a.map((x, i) => Math.abs(x - b[i]))) };
  });

const framesInOneSecond = (page, id) =>
  page.evaluate(
    (id) =>
      new Promise((resolve) => {
        const v = document.getElementById(id);
        let n = 0;
        const count = () => {
          n++;
          v.requestVideoFrameCallback(count);
        };
        v.requestVideoFrameCallback(count);
        setTimeout(() => resolve(n), 1000);
      }),
    id,
  );

try {
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const { page, errors } = await open(context);
    await waitLive(page);
    const frames = await framesInOneSecond(page, 'enhanced');
    assert(frames >= 10, `enhanced video should be playing, got ${frames} frames in 1 s`);
    pass('enhanced video is playing', `${frames} frames in 1 s`);

    await sleep(2500); // the controller settles in about 0.6 s; give face detection time too
    const on = await centre(page);
    assert(on.enhanced > on.original + 20 && on.enhanced > on.original * 1.4, `enhanced centre should be clearly brighter: ${JSON.stringify(on)}`);
    pass('enhanced is brighter than the original in the centre', `luma ${on.enhanced.toFixed(1)} vs ${on.original.toFixed(1)}`);

    const status = (await page.textContent('#status')).trim();
    assert(status.length > 0 && status !== 'Starting', `status line should describe the work, got "${status}"`);
    pass('status line is filled', `"${status}"`);
    const numbers = await page.textContent('.numbers');
    assert(/Camera \d+ fps/.test(numbers) && /Processing [\d.]+ ms/.test(numbers) && /\d+ × \d+/.test(numbers), `numbers line: "${numbers}"`);
    pass('fps, processing time and resolution shown', numbers.replace(/\s+/g, ' ').trim());

    await page.screenshot({ path: path.join(shots, 'desktop.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(shots, 'desktop-dark.png') });
    await page.emulateMedia({ colorScheme: 'light' });

    await page.getByRole('switch', { name: 'Enhance' }).click();
    assert.equal(await page.evaluate(() => window.__sunroom.session.enabled), false);
    await sleep(800);
    const off = await centre(page);
    assert(Math.abs(off.enhanced - off.original) < 4 && off.diff < 8, `with Enhance off both sides should match: ${JSON.stringify(off)}`);
    pass('Enhance off makes both sides match', `luma ${off.enhanced.toFixed(1)} vs ${off.original.toFixed(1)}, mean abs diff ${off.diff.toFixed(1)}`);
    assert.match(await page.textContent('#status'), /Enhance is off/);
    await page.screenshot({ path: path.join(shots, 'desktop-off.png') });
    await page.getByRole('switch', { name: 'Enhance' }).press('Space');
    assert.equal(await page.evaluate(() => window.__sunroom.session.enabled), true, 'Space on the focused switch turns Enhance back on');
    pass('Enhance switch works from the keyboard');

    const box = await page.locator('#stage').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const dragged = await page.evaluate(() => ({ value: Number(document.getElementById('split').value), css: document.getElementById('stage').style.getPropertyValue('--split') }));
    assert(Math.abs(dragged.value - 25) <= 2 && dragged.css === `${dragged.value}%`, `drag to a quarter should move the split there: ${JSON.stringify(dragged)}`);
    const handle = await page.evaluate(() => {
      const d = document.querySelector('.divider').getBoundingClientRect();
      return d.left + d.width / 2;
    });
    assert(Math.abs(handle - (box.x + box.width * 0.25)) < 6, `divider should sit under the pointer: ${handle} vs ${box.x + box.width * 0.25}`);
    pass('dragging moves the split and the divider follows', `value ${dragged.value}`);

    await page.focus('#split');
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    assert.equal(Number(await page.inputValue('#split')), dragged.value + 5, 'arrow keys move the split');
    await page.keyboard.press('End');
    assert.equal(await page.inputValue('#split'), '100');
    pass('split handle works from the keyboard');
    await page.evaluate(() => {
      const s = document.getElementById('split');
      s.value = '50';
      s.dispatchEvent(new Event('input'));
    });

    await page.click('summary');
    await sleep(400);
    const rows = await page.locator('#advanced-list > div').count();
    assert(rows >= 6, `Advanced should list live numbers, got ${rows} rows`);
    pass('Advanced shows live numbers', `${rows} rows`);
    await page.screenshot({ path: path.join(shots, 'desktop-advanced.png'), fullPage: true });

    assert.deepEqual(errors, [], 'no page errors');
    pass('no page errors on the main page');
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const { page } = await open(context);
    await waitLive(page);
    await sleep(2500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(overflow <= 0, `phone layout should not scroll sideways, overflows by ${overflow}px`);
    pass('phone width has no sideways scroll');
    await page.screenshot({ path: path.join(shots, 'phone.png'), fullPage: true });
    await context.close();
  }

  {
    // a second, made-up camera in the list; the fake camera still answers whichever is asked for
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      const md = navigator.mediaDevices;
      const list = md.enumerateDevices.bind(md);
      md.enumerateDevices = async () => [...(await list()), { kind: 'videoinput', deviceId: 'second-camera', label: 'Second camera', groupId: 'g2' }];
      const open = md.getUserMedia.bind(md);
      window.__asked = [];
      md.getUserMedia = (c) => (window.__asked.push(c.video.deviceId ?? null), open(c));
    });
    const { page, errors } = await open(context);
    await waitLive(page);
    await page.waitForSelector('#camera-picker:not([hidden])');
    assert.equal(await page.locator('#camera option').count(), 2);
    await page.selectOption('#camera', 'second-camera');
    await page.waitForFunction(() => window.__asked.length === 2);
    await waitLive(page);
    assert.deepEqual(await page.evaluate(() => window.__asked), [null, { ideal: 'second-camera' }]);
    await page.reload();
    await waitLive(page);
    assert.deepEqual(await page.evaluate(() => window.__asked), [{ ideal: 'second-camera' }], 'the choice is remembered across reloads');
    assert.deepEqual(errors, []);
    pass('camera picker appears for two cameras, switches live and remembers the choice');
    await context.close();
  }

  // getUserMedia failures, injected so they do not depend on the machine's devices
  for (const [name, title] of [
    ['NotFoundError', 'No camera found'],
    ['NotReadableError', 'Your camera is busy'],
  ]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((name) => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('injected', name));
    }, name);
    const { page } = await open(context);
    await page.waitForFunction(() => document.body.dataset.view === 'problem');
    assert.equal(await page.textContent('#message-title'), title);
    assert(await page.isVisible('#retry'), 'a way to try again is offered');
    pass(`${name} shows "${title}"`);
    await context.close();
  }

  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      for (const C of [HTMLCanvasElement, OffscreenCanvas]) {
        const get = C.prototype.getContext;
        C.prototype.getContext = function (type, ...rest) {
          return type === 'webgl2' ? null : get.call(this, type, ...rest);
        };
      }
    });
    const { page } = await open(context);
    await page.waitForFunction(() => document.body.dataset.view === 'untouched' && document.getElementById('original').readyState >= 2, null, { timeout: 20000 });
    assert.match(await page.textContent('#status'), /WebGL2/);
    assert(await page.isVisible('#original'), 'the untouched camera is shown');
    const frames = await framesInOneSecond(page, 'original');
    assert(frames >= 10, `untouched camera should play, got ${frames} frames`);
    pass('without WebGL2 the untouched camera plays with the reason', `${frames} frames in 1 s`);
    await page.screenshot({ path: path.join(shots, 'no-webgl2.png') });
    await context.close();
  }
} finally {
  await browser.close();
}

// no fake-ui flag: the permission prompt is not auto-accepted, and no permission is granted
const strict = await chromium.launch({ channel: 'chrome', headless: true, args: [...fakeCamera, ...gpu] });
try {
  const context = await strict.newContext({ viewport: { width: 1440, height: 900 }, permissions: [] });
  const { page } = await open(context);
  await page.waitForFunction(() => document.body.dataset.view === 'problem', null, { timeout: 15000 });
  assert.equal(await page.textContent('#message-title'), 'Sunroom needs your camera');
  pass('denied permission explains how to allow the camera');
  await page.screenshot({ path: path.join(shots, 'denied.png') });
} finally {
  await strict.close();
  server.close();
}

console.log(`\n${results.length} checks passed. Screenshots in ${path.relative(process.cwd(), shots)}`);

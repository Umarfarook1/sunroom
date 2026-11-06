// The extension on real third-party pages that use the camera without a login. Each page is opened twice,
// without and with the extension, on the browser's fake camera, and the picture the page shows is measured.
// Nothing is joined or sent to anyone: a loopback call inside one page, and previews.
// Usage: node apps/extension/build.mjs && node eval/real-sites.mjs [clip.y4m] [--browser <chromium>]
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChromium } from '../tools/chromium.mjs';

const clip = path.resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'data/fake/synthetic.y4m');
const dist = path.resolve('apps/extension/dist');
const exe = findChromium();
const shots = path.resolve('data/live/sites');
fs.mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The playing video with the most pixels on the page (or in its frames): size, brightness, frames in 2 s. */
async function biggestVideo(page, pick) {
  for (const frame of page.frames()) {
    const r = await frame
      .evaluate(async (pick) => {
        const videos = [...document.querySelectorAll(pick ?? 'video')].filter((v) => v.videoWidth > 0 && !v.paused);
        const v = videos.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight)[0];
        if (!v) return null;
        let frames = 0;
        const count = () => { frames++; v.requestVideoFrameCallback(count); };
        v.requestVideoFrameCallback(count);
        await new Promise((r) => setTimeout(r, 2000));
        const c = document.createElement('canvas');
        c.width = 64; c.height = 36;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(v, 0, 0, 64, 36);
        const d = x.getImageData(0, 0, 64, 36).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        const track = v.srcObject?.getVideoTracks?.()[0];
        return { size: `${v.videoWidth}x${v.videoHeight}`, luma: Math.round(sum / (d.length / 4)), fps: frames / 2, id: v.id || null, label: track?.label ?? null };
      }, pick)
      .catch(() => null);
    if (r) return r;
  }
  return null;
}

const sites = [
  {
    name: 'WebRTC sample: peer connection (a real call inside one page; measures the far end)',
    url: 'https://webrtc.github.io/samples/src/content/peerconnection/pc1/',
    async drive(page) {
      await page.click('#startButton');
      await page.waitForFunction(() => !document.querySelector('#callButton').disabled, null, { timeout: 15000 });
      await page.click('#callButton');
      await page.waitForFunction(() => document.querySelector('#remoteVideo').videoWidth > 0, null, { timeout: 20000 });
      await sleep(5000);
      return biggestVideo(page, '#remoteVideo');
    },
  },
  {
    name: 'Jitsi Meet pre-join screen (a full call app; not joined, preview only)',
    url: `https://meet.jit.si/sunroom-check-${Math.random().toString(36).slice(2, 10)}`,
    async drive(page) {
      await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0), null, { timeout: 45000 });
      await sleep(6000);
      return biggestVideo(page);
    },
  },
  {
    name: 'webcamtests.com (a webcam test site)',
    url: 'https://webcamtests.com/',
    async drive(page) {
      await page.click('#webcam-launcher', { timeout: 15000 });
      await page.waitForFunction(() => [...document.querySelectorAll('video')].some((v) => v.videoWidth > 0), null, { timeout: 30000 });
      await sleep(6000);
      return biggestVideo(page);
    },
  },
];

const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--autoplay-policy=no-user-gesture-required', '--enable-gpu', '--ignore-gpu-blocklist'];
async function run(withExtension) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunroom-sites-'));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: exe,
    headless: true,
    viewport: { width: 1100, height: 800 },
    args: withExtension ? [...args, `--disable-extensions-except=${dist}`, `--load-extension=${dist}`] : args,
  });
  const out = [];
  for (const [i, site] of sites.entries()) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 160)));
    let seen = null;
    let failure = null;
    try {
      await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      seen = await site.drive(page);
      if (withExtension) await page.screenshot({ path: path.join(shots, `site-${i}.png`) });
    } catch (err) {
      failure = String(err.message ?? err).split('\n')[0].slice(0, 200);
    }
    out.push({ seen, failure, pageErrors: errors.slice(0, 3) });
    await page.close();
  }
  await context.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const plain = await run(false);
const worn = await run(true);
let failed = 0;
for (const [i, site] of sites.entries()) {
  const [a, b] = [plain[i], worn[i]];
  const usable = a.seen && b.seen;
  const ok = usable && b.seen.luma >= a.seen.luma + 15 && b.seen.fps >= Math.min(a.seen.fps, 30) * 0.7 && b.seen.size === a.seen.size;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : usable ? 'FAIL' : 'N/A '}  ${site.name}`);
  console.log(`      without: ${a.seen ? JSON.stringify(a.seen) : `no video (${a.failure})`}`);
  console.log(`      with:    ${b.seen ? JSON.stringify(b.seen) : `no video (${b.failure})`}${b.pageErrors.length ? `  page errors: ${JSON.stringify(b.pageErrors)}` : ''}`);
}
fs.writeFileSync(path.join(shots, 'result.json'), JSON.stringify({ sites: sites.map((s) => s.name), plain, worn }, null, 1));
process.exit(failed ? 1 : 0);

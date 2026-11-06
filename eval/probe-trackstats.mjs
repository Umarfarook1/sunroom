// Probe on the real webcam: does MediaStreamTrack.stats report the camera's own frame count when the reader is slow?
// Usage: node eval/probe-trackstats.mjs   (measured here: 29.7 fps counted while a reader took 5 per second)
import { chromium } from 'playwright-core';
import http from 'node:http';

const server = http.createServer((_q, res) => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><meta charset="utf-8">')).listen(0);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
await page.goto(`http://localhost:${server.address().port}/`);
const r = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
  const track = stream.getVideoTracks()[0];
  if (!('stats' in track)) return { has: false };
  const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
  const out = [];
  let read = 0;
  const t0 = performance.now();
  let last = { t: t0, total: track.stats.totalFrames };
  while (performance.now() - t0 < 6000) {
    const { value } = await reader.read();
    value.close();
    read++;
    await sleep(200); // a slow consumer
    const now = performance.now();
    if (now - last.t > 1000) {
      const s = track.stats;
      out.push({ t: Math.round(now - t0), fpsFromStats: +(((s.totalFrames - last.total) * 1000) / (now - last.t)).toFixed(1), delivered: s.deliveredFrames, discarded: s.discardedFrames, total: s.totalFrames, read });
      last = { t: now, total: s.totalFrames };
    }
  }
  track.stop();
  return { has: true, settings: track.getSettings().frameRate, out };
});
console.log(JSON.stringify(r, null, 1));
await browser.close();
server.close();

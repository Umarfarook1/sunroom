// The Linux virtual camera end to end: pattern frames go through the backend into a v4l2loopback device while a
// second ffmpeg reads the device the way an app would. Runs only on Linux with the device loaded and ffmpeg on PATH:
//   sudo modprobe v4l2loopback video_nr=10 card_label="Sunroom Camera" exclusive_caps=1
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { V4l2FfmpegOutput } from '../src/vcam/v4l2-ffmpeg.ts';
import { fillPattern } from './receiver-sim.mjs';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const device = process.env.SUNROOM_V4L2_DEVICE ?? '/dev/video10';
const skip = process.platform !== 'linux' ? 'not Linux'
  : !fs.existsSync(device) ? `no ${device} (load v4l2loopback first)`
  : spawnSync('ffmpeg', ['-version']).status !== 0 ? 'ffmpeg is not on PATH'
  : '';
if (skip) console.log(`v4l2-device.test: skipped, ${skip}`);
const W = 1280;
const H = 720;
const READ_FRAMES = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The device carries yuv420p: Y per pixel in limited range (219 steps for 256 values), U and V per 2x2 block. Away
// from the pattern's 255 -> 0 seams the colour changes by 1 per pixel, so the round trip moves a channel a few steps.
// Measured with ffmpeg N-125299 doing the writer's and reader's conversions (RGBA -> yuv420p -> RGBA) on this
// pattern: worst 4 at 4 or more pixels from a seam, 5 at 2-3 pixels, 13 at 0-1. Twice the worst, because CI runs
// Ubuntu's older ffmpeg. A shift of the whole picture by fewer than 9 pixels therefore passes.
export const TOLERANCE = 8;
// pixels this close to a seam mix two colours 255 apart through the shared chroma; they are not compared
const SEAM = 4;

/** Checks one RGBA frame read from the device against fillPattern; returns its frame number, worst error and any mismatch. */
export function checkFrame(px, width, height) {
  const nearSeam = (v) => (v & 255) < SEAM || (v & 255) > 255 - SEAM;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    if (nearSeam(y)) continue;
    for (let x = 0; x < width; x++) {
      if (nearSeam(x)) continue;
      sum += px[(y * width + x) * 4 + 2];
      count++;
    }
  }
  // B carries the frame number; it reads about 1 low after the round trip, which is fine as only the order is checked
  const n = Math.round(sum / count);
  let worst = 0;
  for (let y = 0; y < height; y++) {
    if (nearSeam(y)) continue;
    for (let x = 0; x < width; x++) {
      if (nearSeam(x)) continue;
      const i = (y * width + x) * 4;
      const want = [x & 255, y & 255, n & 255];
      for (let c = 0; c < 3; c++) {
        const d = Math.abs(px[i + c] - want[c]);
        if (d > TOLERANCE) return { n, worst: d, error: `pixel (${x},${y}) is [${Array.from(px.subarray(i, i + 4))}], pattern ${n} wants [${want},255] within ${TOLERANCE}` };
        worst = Math.max(worst, d);
      }
      if (px[i + 3] !== 255) return { n, worst, error: `pixel (${x},${y}) has alpha ${px[i + 3]}, expected 255` };
    }
  }
  return { n, worst, error: null };
}

(skip ? test.skip : test)(
  `sends ${W}x${H} pattern frames into ${device}, and a second ffmpeg reads them back`,
  async () => {
    const states = [];
    const out = new V4l2FfmpegOutput((s) => states.push(s), { device });
    const frame = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    let pumping = true;
    const pump = (async () => {
      const t0 = performance.now();
      for (let n = 0; pumping; n++) {
        fillPattern(frame.data, W, H, n);
        out.send(frame);
        await sleep(Math.max(0, t0 + ((n + 1) * 1000) / 30 - performance.now()));
      }
    })();
    let reader;
    try {
      for (const end = Date.now() + 10_000; out.state !== 'sending' && Date.now() < end; ) await sleep(50);
      assert.equal(out.state, 'sending', `the backend never got ffmpeg to take a frame; states: ${states.join(' > ') || 'none'}`);
      await sleep(1000); // exclusive_caps=1 offers the capture side only once the writer is streaming

      reader = spawn('ffmpeg', ['-v', 'error', '-f', 'v4l2', '-i', device, '-frames:v', String(READ_FRAMES), '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks = [];
      let stderr = '';
      reader.stdout.on('data', (d) => chunks.push(d));
      reader.stderr.on('data', (d) => (stderr += d));
      const code = await new Promise((resolve) => {
        reader.on('close', (c, signal) => resolve(c ?? signal));
        setTimeout(() => reader.kill(), 20_000).unref();
      });
      const bytes = Buffer.concat(chunks);
      assert.equal(code, 0, `reader ffmpeg exited with ${code} after ${bytes.length} bytes: ${stderr.trim() || 'no message'}`);
      assert.equal(bytes.length, READ_FRAMES * W * H * 4, `read ${bytes.length} bytes, expected ${READ_FRAMES} frames of ${W}x${H} RGBA (${READ_FRAMES * W * H * 4} bytes)`);

      const results = [];
      for (let i = 0; i < READ_FRAMES; i++) results.push(checkFrame(bytes.subarray(i * W * H * 4, (i + 1) * W * H * 4), W, H));
      const numbers = results.map((r) => r.n);
      console.log(`read frames numbered ${numbers.join(',')}; largest channel error ${Math.max(...results.map((r) => r.worst))} (tolerance ${TOLERANCE})`);
      assert.deepEqual(results.flatMap((r, i) => (r.error ? [`frame ${i}: ${r.error}`] : [])), [], 'frames that differ from the pattern');
      assert.ok(numbers.every((n, i) => i === 0 || n >= numbers[i - 1]), `frame numbers went backwards: ${numbers.join(',')}`);
      assert.ok(numbers.at(-1) > numbers[0], `all ${READ_FRAMES} frames carry number ${numbers[0]}: the picture froze`);
    } finally {
      reader?.kill();
      pumping = false;
      await pump;
      out.close();
    }
  },
  60_000,
);

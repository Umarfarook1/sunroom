// The sender against the real UnityCapture filter, read by a real DirectShow program (ffmpeg).
// Runs only on Windows when "Sunroom Camera" is registered (tools/register-virtual-camera.ps1) and ffmpeg is on PATH.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UnityCaptureOutput } from '../src/vcam/unity-capture.ts';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const W = 1280;
const H = 720;
const FRAMES = 90;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const listed = () => {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('ffmpeg', ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8' });
  return !r.error && /"Sunroom Camera" \(video\)/.test(r.stderr);
};

/** A picture with a known colour at every position: red grows to the right, green grows downwards, blue is the frame number. */
function gradient(buf, n) {
  for (let y = 0, i = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i += 4) {
      buf[i] = Math.round((x * 255) / (W - 1));
      buf[i + 1] = Math.round((y * 255) / (H - 1));
      buf[i + 2] = n & 255;
      buf[i + 3] = 255;
    }
  }
}

(listed() ? test : test.skip)(
  'a real DirectShow reader gets the sent pictures upright, in the right colours and in order',
  async () => {
    const file = path.join(os.tmpdir(), `sunroom-real-filter-${process.pid}.rgb`);
    const states = [];
    const out = new UnityCaptureOutput((s) => states.push(s));
    const frame = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'dshow', '-video_size', `${W}x${H}`, '-framerate', '30', '-i', 'video=Sunroom Camera', '-frames:v', String(FRAMES), '-pix_fmt', 'rgb24', '-f', 'rawvideo', file];
      const reader = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      reader.stderr.on('data', (d) => (stderr += d));
      let exited = false;
      const exit = new Promise((resolve) => reader.on('exit', resolve)).then(() => (exited = true));
      const t0 = performance.now();
      let sendingAt = 0;
      for (let n = 0; !exited && n < 30 * 20; n++) {
        gradient(frame.data, n);
        out.send(frame);
        if (!sendingAt && out.state === 'sending') sendingAt = performance.now();
        await sleep(Math.max(0, t0 + ((n + 1) * 1000) / 30 - performance.now()));
      }
      await exit;
      const seconds = (performance.now() - sendingAt) / 1000;

      assert.ok(sendingAt, `the filter never asked for frames; ffmpeg said: ${stderr}`);
      const got = fs.readFileSync(file);
      assert.equal(got.length, FRAMES * W * H * 3, `ffmpeg wrote ${got.length} bytes; it said: ${stderr}`);
      const last = got.subarray((FRAMES - 1) * W * H * 3);
      const at = (x, y) => [...last.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
      // blue carries the frame number: read it from every received frame
      const numbers = Array.from({ length: FRAMES }, (_, f) => got[f * W * H * 3 + 2]);
      const steps = numbers.slice(1).map((b, i) => (b - numbers[i] + 256) & 255);
      const want = (x, y) => [Math.round((x * 255) / (W - 1)), Math.round((y * 255) / (H - 1)), numbers[FRAMES - 1]];
      const spots = [[10, 10], [W - 11, 10], [10, H - 11], [W - 11, H - 11], [W >> 1, H >> 1]];
      const seen = spots.map(([x, y]) => ({ x, y, got: at(x, y), want: want(x, y) }));
      const distinct = new Set(numbers).size;
      console.log('real filter', JSON.stringify({ frames: got.length / (W * H * 3), seconds: +seconds.toFixed(1), distinctPictures: distinct, states: [...new Set(states)], seen }));
      // the filter shows its own placeholder until the sender connects; from then on every sent picture arrives once, in order
      assert.ok(steps.slice(-25).every((d) => d === 1), `the last 25 pictures are not consecutive: ${numbers.join(' ')}`);
      for (const s of seen) for (let c = 0; c < 3; c++) assert.ok(Math.abs(s.got[c] - s.want[c]) <= 2, `pixel ${s.x},${s.y} is ${s.got}, sent ${s.want}`);
    } finally {
      out.close();
      fs.rmSync(file, { force: true });
    }
  },
  40_000,
);

// The Linux virtual camera's ffmpeg pipe with its output pointed at a raw RGBA file instead of /dev/video10,
// so it runs on any OS with ffmpeg on PATH. v4l2-device.test.mjs covers the real loopback device.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { V4l2FfmpegOutput } from '../src/vcam/v4l2-ffmpeg.ts';
import { fillPattern } from './receiver-sim.mjs';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
if (!hasFfmpeg) console.log('v4l2-pipe.test: ffmpeg is not on PATH, so the tests that run it are skipped');
const withFfmpeg = hasFfmpeg ? test : test.skip;
const W = 320;
const H = 240;
const BYTES = W * H * 4;
const FRAMES = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(condition, ms) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) return false;
    await sleep(20);
  }
  return true;
}

/** A writable file that stands in for the device node, in its own temp folder. */
function fakeDevice() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sunroom-v4l2-')), 'video10.rgba');
  fs.writeFileSync(file, '');
  return file;
}
async function removeDevice(file) {
  // on Windows the folder stays locked until the ffmpeg that close() ended has exited
  for (let i = 0; ; i++) {
    try {
      return fs.rmSync(path.dirname(file), { recursive: true, force: true });
    } catch (err) {
      if (i >= 50) throw err;
      await sleep(100);
    }
  }
}

/** Where two frames first differ, as a pixel and channel. */
function firstDifference(got, want) {
  const i = got.findIndex((v, k) => v !== want[k]);
  const p = i >> 2;
  return `pixel (${p % W},${Math.floor(p / W)}) channel ${'RGBA'[i & 3]} is ${got[i]}, expected ${want[i]}`;
}

test('reports not-installed and starts nothing while the device node is missing', () => {
  const out = new V4l2FfmpegOutput(undefined, { device: path.join(os.tmpdir(), 'sunroom-no-such-video10') });
  out.send({ width: 2, height: 2, data: new Uint8Array(16) });
  assert.equal(out.state, 'not-installed');
  out.close();
});

test('notices the device node appearing later, without being sent a frame', async () => {
  const file = fakeDevice();
  fs.rmSync(file);
  const out = new V4l2FfmpegOutput(undefined, { device: file });
  try {
    assert.equal(out.state, 'not-installed');
    fs.writeFileSync(file, '');
    assert.ok(await until(() => out.state === 'waiting', 6000), `still ${out.state} 6 s after the device appeared`);
  } finally {
    out.close();
    await removeDevice(file);
  }
});

test('reports not-installed when ffmpeg is not on PATH', async () => {
  const file = fakeDevice();
  const PATH = process.env.PATH;
  process.env.PATH = '';
  const out = new V4l2FfmpegOutput(undefined, { device: file });
  try {
    assert.equal(out.state, 'waiting');
    out.send({ width: 2, height: 2, data: new Uint8Array(16) });
    await until(() => out.state !== 'waiting', 5000);
    assert.equal(out.state, 'not-installed');
  } finally {
    process.env.PATH = PATH;
    out.close();
    await removeDevice(file);
  }
});

withFfmpeg(
  'writes every accepted frame whole and in order, restarts on a new size, and drops a frame while the pipe is busy',
  async () => {
    const file = fakeDevice();
    const states = [];
    const out = new V4l2FfmpegOutput((s) => states.push(s), { device: file, outputArgs: ['-f', 'rawvideo', '-pix_fmt', 'rgba'] });
    try {
      assert.equal(out.state, 'waiting');
      out.send({ width: 200, height: 100, data: new Uint8Array(200 * 100 * 4) });
      assert.ok(await until(() => out.state === 'sending', 10_000), 'ffmpeg took the first 200x100 frame');

      const frame = { width: W, height: H, data: new Uint8Array(BYTES) };
      fillPattern(frame.data, W, H, 0);
      out.send(frame);
      assert.ok(await until(() => out.state === 'waiting', 10_000), `the 200x100 ffmpeg exited on the first ${W}x${H} frame`);
      out.send(frame);
      assert.ok(await until(() => out.state === 'sending', 10_000), `a ${W}x${H} ffmpeg took frame 0`);
      const t0 = performance.now();
      for (let n = 1; n < FRAMES; n++) {
        await sleep(Math.max(0, t0 + (n * 1000) / 30 - performance.now()));
        fillPattern(frame.data, W, H, n);
        out.send(frame);
      }
      // the pipe is still taking frame FRAMES when FRAMES + 1 arrives, so that one must be dropped, not queued
      await sleep(1000 / 30);
      fillPattern(frame.data, W, H, FRAMES);
      out.send(frame);
      fillPattern(frame.data, W, H, FRAMES + 1);
      out.send(frame);
    } finally {
      out.close();
    }

    try {
      await until(() => fs.statSync(file).size >= (FRAMES + 1) * BYTES, 10_000);
      await sleep(300); // anything ffmpeg still flushes after close
      const bytes = fs.readFileSync(file);
      console.log(`file holds ${bytes.length} bytes = ${bytes.length / BYTES} frames of ${W}x${H} RGBA; states ${states.join(' > ')}`);
      assert.equal(bytes.length % BYTES, 0, `${bytes.length} bytes is not a whole number of ${W}x${H} RGBA frames`);
      const want = new Uint8Array(BYTES);
      const numbers = [];
      for (let i = 0; i < bytes.length / BYTES; i++) {
        const got = bytes.subarray(i * BYTES, (i + 1) * BYTES);
        const n = got[2];
        fillPattern(want, W, H, n);
        assert.ok(Buffer.compare(got, want) === 0, `frame ${i} (pattern ${n}): ${firstDifference(got, want)}`);
        numbers.push(n);
      }
      assert.deepEqual(numbers, Array.from({ length: FRAMES + 1 }, (_, n) => n), 'pattern numbers of the frames in the file');
      assert.deepEqual(states, ['sending', 'waiting', 'sending']);
    } finally {
      await removeDevice(file);
    }
  },
  30_000,
);

withFfmpeg(
  'starts ffmpeg again after it exits, on a later frame, waiting longer after each exit',
  async () => {
    const file = fakeDevice();
    const events = [];
    // -frames:v 1 makes ffmpeg exit after one frame, as if it had died
    const out = new V4l2FfmpegOutput((s) => events.push({ s, t: performance.now() }), { device: file, outputArgs: ['-f', 'rawvideo', '-frames:v', '1'] });
    const frame = { width: 64, height: 48, data: new Uint8Array(64 * 48 * 4) };
    try {
      // until the third ffmpeg has exited too, so none is left writing into the folder removed below
      for (const end = Date.now() + 15_000; events.length < 6 && Date.now() < end; await sleep(1000 / 30)) out.send(frame);
    } finally {
      out.close();
    }
    try {
      assert.deepEqual(events.map((e) => e.s), ['sending', 'waiting', 'sending', 'waiting', 'sending', 'waiting']);
      const waits = [events[2].t - events[1].t, events[4].t - events[3].t].map(Math.round);
      console.log(`restarted ${waits.join(' ms and ')} ms after ffmpeg exited`);
      assert.ok(waits[0] >= 1000 && waits[1] >= 2000, `restarted after ${waits.join(' and ')} ms; expected at least 1000, then 2000`);
    } finally {
      await removeDevice(file);
    }
  },
  30_000,
);

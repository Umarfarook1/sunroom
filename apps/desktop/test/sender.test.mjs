// The sender against a simulated UnityCapture filter in a separate process: the main proof of the Windows virtual camera.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UnityCaptureOutput } from '../src/vcam/unity-capture.ts';
import { fillPattern } from './receiver-sim.mjs';

const { test } = process.env.VITEST ? await import('vitest') : await import('node:test');
const windowsOnly = process.platform === 'win32' ? test : test.skip;
const sim = fileURLToPath(new URL('./receiver-sim.mjs', import.meta.url));
const W = 1280;
const H = 720;
const FRAMES = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(condition, ms, what) {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

windowsOnly(
  'sends 150 frames at 30 fps, intact and in order, to a simulated filter',
  async () => {
    const states = [];
    const out = new UnityCaptureOutput((s) => states.push(s));
    const frame = { width: W, height: H, data: new Uint8Array(W * H * 4) };
    try {
      assert.notEqual(out.state, 'sending', 'no app has opened the camera yet');
      out.send(frame);

      const child = spawn(process.execPath, [sim, '--frames', String(FRAMES), '--seconds', '20', '--width', String(W), '--height', String(H), '--pattern'], { stdio: ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout.on('data', (d) => (stdout += d));
      let exited = false;
      const exit = new Promise((resolve) => child.on('exit', resolve)).then(() => (exited = true));

      await until(() => out.state === 'sending', 5000, 'the sender to connect');
      const costs = [];
      const t0 = performance.now();
      for (let n = 0; !exited && n < FRAMES * 4; n++) {
        fillPattern(frame.data, W, H, n);
        const s = performance.now();
        out.send(frame);
        costs.push(performance.now() - s);
        await sleep(Math.max(0, t0 + ((n + 1) * 1000) / 30 - performance.now()));
      }
      await exit;

      const r = JSON.parse(stdout);
      costs.sort((a, b) => a - b);
      console.log('receiver', JSON.stringify(r));
      console.log(`send() of ${W}x${H}: median ${costs[costs.length >> 1].toFixed(2)} ms, p95 ${costs[Math.floor(costs.length * 0.95)].toFixed(2)} ms over ${costs.length} frames`);

      assert.deepEqual(r.errors, []);
      assert.equal(r.frames, FRAMES);
      assert.deepEqual([r.width, r.height, r.stride, r.format, r.resizemode, r.mirrormode, r.timeout], [W, H, W, 0, 1, 0, 1000]);
      assert.equal((r.last - r.first + 256) & 255, (FRAMES - 1 + r.skipped) & 255, 'frame numbers only move forward');
      assert.ok(r.skipped <= 3, `${r.skipped} frames skipped`);
      assert.ok(r.fps > 27 && r.fps < 33, `received at ${r.fps.toFixed(1)} fps`);

      await until(() => out.state === 'waiting', 5000, 'the sender to notice the app stopped reading');
      assert.deepEqual(states.filter((s) => s !== 'not-installed'), ['sending', 'waiting']);
    } finally {
      out.close();
    }
  },
  60_000,
);

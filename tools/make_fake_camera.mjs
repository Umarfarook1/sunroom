// Turns a recorded clip into a file Chrome's fake camera can play
// (--use-file-for-fake-video-capture=<out.mjpeg>), keeping the camera's own JPEG frames.
// Usage: node tools/make_fake_camera.mjs <clip.avi|clip.mjpeg> <out.mjpeg>
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) throw new Error('usage: make_fake_camera.mjs <clip> <out.mjpeg>');
let raw = src;
if (!src.endsWith('.mjpeg')) {
  raw = path.join(os.tmpdir(), `sunroom-${process.pid}.mjpeg`);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, '-c:v', 'copy', '-f', 'mjpeg', raw], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
}
const b = fs.readFileSync(raw);
const SOI = Buffer.from([0xff, 0xd8, 0xff]);
const EOI = Buffer.from([0xff, 0xd9]);
const frames = [];
// ffmpeg leaves padding bytes after each frame's end marker, and Chrome's fake camera stops at them
for (let i = b.indexOf(SOI); i >= 0; ) {
  const end = b.indexOf(EOI, i) + 2;
  if (end < 2) throw new Error(`unterminated frame at byte ${i}`);
  frames.push(b.subarray(i, end));
  i = b.indexOf(SOI, end);
}
fs.writeFileSync(out, Buffer.concat(frames));
if (raw !== src) fs.rmSync(raw);
console.log(`${out}: ${frames.length} frames`);

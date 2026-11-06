// Writes a dark, grainy test clip with nobody in it, for machines that have no recorded clips (CI).
// Y4M, which Chromium's fake camera plays: --use-file-for-fake-video-capture=<out.y4m>
// Usage: node tools/make_synthetic_clip.mjs <out.y4m> [frames=60] [width=640] [height=360]
import fs from 'node:fs';
import path from 'node:path';

const [out, frames = '60', width = '640', height = '360'] = process.argv.slice(2);
if (!out) throw new Error('usage: make_synthetic_clip.mjs <out.y4m> [frames] [width] [height]');
const [n, w, h] = [Number(frames), Number(width), Number(height)];

// same picture on every machine
let seed = 12345;
const noise = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return (seed >>> 24) / 255 - 0.5;
};

// a dim room: dark wall with a soft gradient, a lighter oval where a person would sit, a bright strip like a window edge
const scene = new Float32Array(w * h);
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const dx = (x - w / 2) / (w * 0.16);
    const dy = (y - h * 0.45) / (h * 0.3);
    const oval = Math.max(0, 1 - dx * dx - dy * dy);
    scene[y * w + x] = 22 + 10 * (x / w) + 26 * oval + (x > w * 0.93 ? 120 : 0);
  }
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
const fd = fs.openSync(out, 'w');
fs.writeSync(fd, `YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`);
const luma = Buffer.alloc(w * h);
// slightly warm, flat chroma
const chroma = Buffer.concat([Buffer.alloc((w * h) / 4, 124), Buffer.alloc((w * h) / 4, 134)]);
for (let f = 0; f < n; f++) {
  for (let i = 0; i < luma.length; i++) luma[i] = Math.max(16, Math.min(235, Math.round(scene[i] + 14 * noise())));
  fs.writeSync(fd, 'FRAME\n');
  fs.writeSync(fd, luma);
  fs.writeSync(fd, chroma);
}
fs.closeSync(fd);
console.log(`${out}: ${n} frames, ${w}x${h}`);

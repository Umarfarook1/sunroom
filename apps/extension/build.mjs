// Builds the unpacked extension into dist/. Usage: node apps/extension/build.mjs
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const dist = path.join(here, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));

fs.rmSync(dist, { recursive: true, force: true });
await build({
  entryPoints: { main: 'src/main.ts', isolated: 'src/isolated.ts', popup: 'src/popup.ts' },
  absWorkingDir: here,
  outdir: dist,
  bundle: true,
  // one classic script per entry: MAIN-world content scripts cannot be modules, so the face tracker's dynamic import is inlined
  format: 'iife',
  target: 'chrome111',
  minify: true,
  logLevel: 'warning',
});

fs.copyFileSync(path.join(here, 'src/popup.html'), path.join(dist, 'popup.html'));
fs.mkdirSync(path.join(dist, 'models'));
fs.copyFileSync(path.join(root, 'packages/core/assets/blaze_face_short_range.tflite'), path.join(dist, 'models/blaze_face_short_range.tflite'));
// FilesetResolver.forVisionTasks loads only these two; the *_module_* pair would add 15 MB for nothing
fs.mkdirSync(path.join(dist, 'mediapipe'));
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']) {
  fs.copyFileSync(path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm', f), path.join(dist, 'mediapipe', f));
}

// An amber sun disc on an off-white rounded square, anti-aliased by pixel coverage.
function icon(size) {
  const bg = [0xfa, 0xf7, 0xf2];
  const sun = [0xd9, 0x82, 0x2b];
  const half = size / 2;
  const radius = size * 0.3;
  const corner = size * 0.22;
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride); // each row starts with filter byte 0
  const cover = (d) => Math.min(Math.max(d + 0.5, 0), 1);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - half;
      const dy = y + 0.5 - half;
      const disc = cover(radius - Math.hypot(dx, dy));
      const box = cover(corner - Math.hypot(Math.max(Math.abs(dx) - half + corner, 0), Math.max(Math.abs(dy) - half + corner, 0)));
      const o = y * stride + 1 + x * 4;
      for (let c = 0; c < 3; c++) raw[o + c] = Math.round(bg[c] + (sun[c] - bg[c]) * disc);
      raw[o + 3] = Math.round(box * 255);
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
fs.mkdirSync(path.join(dist, 'icons'));
for (const size of [16, 48, 128]) fs.writeFileSync(path.join(dist, `icons/${size}.png`), icon(size));

const frames = { matches: ['<all_urls>'], run_at: 'document_start', all_frames: true, match_about_blank: true, match_origin_as_fallback: true };
const manifest = {
  manifest_version: 3,
  name: 'Sunroom',
  version: pkg.version,
  description: 'Makes a weak webcam in bad light look good on any site. Everything runs on your device.',
  minimum_chrome_version: '111',
  permissions: ['storage'],
  icons: { 16: 'icons/16.png', 48: 'icons/48.png', 128: 'icons/128.png' },
  action: { default_title: 'Sunroom', default_popup: 'popup.html', default_icon: { 16: 'icons/16.png', 48: 'icons/48.png' } },
  content_scripts: [
    { ...frames, js: ['main.js'], world: 'MAIN' },
    { ...frames, js: ['isolated.js'] },
  ],
  web_accessible_resources: [{ resources: ['mediapipe/*', 'models/*'], matches: ['<all_urls>'] }],
};
fs.writeFileSync(path.join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`built ${path.relative(root, dist)}`);

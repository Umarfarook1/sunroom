// Builds the web app into dist/. `node build.mjs --serve [--port 4173]` also serves dist/ locally.
import { build } from 'esbuild';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
export const dist = path.join(here, 'dist');

export async function buildWeb() {
  fs.rmSync(dist, { recursive: true, force: true });
  await build({
    entryPoints: [path.join(here, 'src/main.ts')],
    bundle: true,
    splitting: true, // MediaPipe is imported lazily and lands in its own chunk
    format: 'esm',
    target: 'es2022',
    outdir: dist,
    minify: true,
    sourcemap: true,
    logLevel: 'warning',
  });
  fs.copyFileSync(path.join(here, 'index.html'), path.join(dist, 'index.html'));
  for (const css of ['theme.css', 'app.css']) fs.copyFileSync(path.join(here, 'src', css), path.join(dist, css));
  fs.mkdirSync(path.join(dist, 'models'));
  fs.copyFileSync(path.join(repo, 'packages/core/assets/blaze_face_short_range.tflite'), path.join(dist, 'models/blaze_face_short_range.tflite'));
  fs.cpSync(path.join(repo, 'node_modules/@mediapipe/tasks-vision/wasm'), path.join(dist, 'mediapipe'), { recursive: true });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
};

/** Serves dist/ on 127.0.0.1 (a secure context, so the camera works). Port 0 picks a free one. */
export function serveDist(port = 4173) {
  const server = http.createServer((req, res) => {
    let file;
    try {
      const url = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      file = path.join(dist, url.endsWith('/') ? `${url}index.html` : url);
    } catch {
      return res.writeHead(400).end('Bad request');
    }
    if (!file.startsWith(dist + path.sep) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return res.writeHead(404).end('Not found');
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await buildWeb();
  console.log(`built ${path.relative(process.cwd(), dist) || '.'}`);
  if (process.argv.includes('--serve')) {
    const i = process.argv.indexOf('--port');
    const server = await serveDist(i > 0 ? Number(process.argv[i + 1]) : 4173);
    console.log(`Sunroom at http://127.0.0.1:${server.address().port}/`);
  }
}

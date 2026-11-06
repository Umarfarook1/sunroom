// Bundles the Electron main process, the preload, the injected frame exporter and the built-in page into dist/.
import fs from 'node:fs';
import { build } from 'esbuild';

process.chdir(import.meta.dirname);
const common = { absWorkingDir: import.meta.dirname, bundle: true, logLevel: 'warning', sourcemap: 'linked' };
const node = { ...common, platform: 'node', format: 'cjs', target: 'node20' };
const web = { ...common, platform: 'browser', format: 'iife', target: 'chrome130' };

fs.rmSync('dist', { recursive: true, force: true });
await Promise.all([
  build({ ...node, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', external: ['electron', 'koffi'] }),
  build({ ...node, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs', external: ['electron'] }),
  build({ ...web, entryPoints: ['src/exporter.ts'], outfile: 'dist/exporter.js', sourcemap: false }),
  build({ ...web, entryPoints: ['src/export-worker.ts'], outfile: 'dist/export-worker.js', sourcemap: false }),
  build({ ...web, entryPoints: ['src/page/page.ts'], outfile: 'dist/page/page.js' }),
]);
fs.copyFileSync('src/page/index.html', 'dist/page/index.html');

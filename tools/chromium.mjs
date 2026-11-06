// Finds a Chromium that loads unpacked extensions: the one Playwright downloads
// (npx playwright-core install chromium), or an older one it downloaded before. Branded Chrome 137+ refuses
// --load-extension. Pass --browser <path> to any script that uses this to choose another.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const BINARIES = ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe', 'chrome-linux64/chrome', 'chrome-linux/chrome', 'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'];

export function findChromium() {
  const flag = process.argv.indexOf('--browser');
  if (flag >= 0) return process.argv[flag + 1];
  const expected = chromium.executablePath();
  if (fs.existsSync(expected)) return expected;
  const cache = path.resolve(expected, '../../..');
  const older = fs.existsSync(cache)
    ? fs.readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort().reverse().flatMap((d) => BINARIES.map((b) => path.join(cache, d, b)))
    : [];
  const found = older.find((f) => fs.existsSync(f));
  if (!found) throw new Error('no Chromium found; run "npx playwright-core install chromium" or pass --browser <path>');
  return found;
}

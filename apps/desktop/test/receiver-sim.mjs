// Stand-in for the UnityCapture filter: the receiving half of SharedImageMemory (Source/shared.inl 50-62, 94-144),
// run in its own process, so the sender can be proven without registering anything.
// Usage: node receiver-sim.mjs [--frames N] [--seconds S] [--width W --height H] [--pattern] [--png out.png]
// Prints one JSON line with what it received, then exits.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import koffi from 'koffi';

const NAMES = { mutex: 'UnityCapture_Mutx', want: 'UnityCapture_Want', sent: 'UnityCapture_Sent', data: 'UnityCapture_Data' };
const MAX_IMAGE_BYTES = 3840 * 2160 * 4 * 2;
const HEADER_BYTES = 32;
const RECEIVE_MAX_WAIT = 200;

/** The sender test's picture for frame n: R = x, G = y, B = n (all mod 256), A = 255, rows top-down. */
export function fillPattern(buf, width, height, n) {
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i += 4) {
      buf[i] = x & 255;
      buf[i + 1] = y & 255;
      buf[i + 2] = n & 255;
      buf[i + 3] = 255;
    }
  }
}

/** Mean Rec.709 luma (0..255) of an RGBA image, sampled on a grid. */
function meanLuma(px, width, height) {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < height; y += 8) {
    for (let x = 0; x < width; x += 8) {
      const i = (y * width + x) * 4;
      sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      count++;
    }
  }
  return sum / count;
}

/** Writes a bottom-up RGBA image as a top-down RGB PNG. */
function savePng(file, px, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * (width * 3 + 1) + 1;
    for (let x = 0; x < width; x++) {
      raw[dst + x * 3] = px[src + x * 4];
      raw[dst + x * 3 + 1] = px[src + x * 4 + 1];
      raw[dst + x * 3 + 2] = px[src + x * 4 + 2];
    }
  }
  const chunk = (type, body) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** Checks one received pattern frame; returns the frame number it carries, or an error string. */
function checkPattern(px, width, height) {
  const n = px[(height - 1) * width * 4 + 2];
  const ys = [0, 1, height >> 1, height - 2, height - 1];
  for (let y = 0; y < height; y += 7) ys.push(y);
  for (const y of ys) {
    for (const x of [0, 1, 255, 256, width >> 1, width - 1]) {
      const i = ((height - 1 - y) * width + x) * 4;
      const got = [px[i], px[i + 1], px[i + 2], px[i + 3]];
      const want = [x & 255, y & 255, n, 255];
      if (got.some((v, k) => v !== want[k])) return `pixel (${x},${y}) is ${got} but frame ${n} should be ${want}`;
    }
  }
  return n;
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, def) => (args.includes(name) ? args[args.indexOf(name) + 1] : def);
  const wantFrames = Number(flag('--frames', '150'));
  const seconds = Number(flag('--seconds', '20'));
  const expectW = Number(flag('--width', '0'));
  const expectH = Number(flag('--height', '0'));
  const pattern = args.includes('--pattern');
  const png = flag('--png', '');

  const k = koffi.load('kernel32.dll');
  const CreateMutexA = k.func('void * __stdcall CreateMutexA(void *attributes, int initialOwner, const char *name)');
  const CreateEventA = k.func('void * __stdcall CreateEventA(void *attributes, int manualReset, int initialState, const char *name)');
  const OpenEventA = k.func('void * __stdcall OpenEventA(uint32_t access, int inherit, const char *name)');
  const CreateFileMappingA = k.func('void * __stdcall CreateFileMappingA(intptr_t file, void *attributes, uint32_t protect, uint32_t sizeHigh, uint32_t sizeLow, const char *name)');
  const MapViewOfFile = k.func('void * __stdcall MapViewOfFile(void *mapping, uint32_t access, uint32_t offsetHigh, uint32_t offsetLow, size_t bytes)');
  const WaitForSingleObject = k.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)');
  const ReleaseMutex = k.func('int __stdcall ReleaseMutex(void *mutex)');
  const SetEvent = k.func('int __stdcall SetEvent(void *event)');
  const ReadMemory = k.func('void __stdcall RtlMoveMemory(void *dst, uintptr_t src, size_t bytes)');
  const WriteMemory = k.func('void __stdcall RtlMoveMemory(uintptr_t dst, const void *src, size_t bytes)');
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  const h = { mutex: null, want: null, sent: null, mapping: null, view: null };
  const open = () => {
    if (h.view) return true;
    h.mutex ??= CreateMutexA(null, 0, NAMES.mutex);
    if (!h.mutex) return false;
    WaitForSingleObject(h.mutex, 0xffffffff);
    try {
      h.want ??= OpenEventA(0x0002 /* EVENT_MODIFY_STATE */, 0, NAMES.want);
      if (!h.want) return false;
      h.sent ??= CreateEventA(null, 0, 0, NAMES.sent);
      if (!h.sent) return false;
      h.mapping ??= CreateFileMappingA(-1 /* INVALID_HANDLE_VALUE: pagefile-backed */, null, 0x04 /* PAGE_READWRITE */, 0, HEADER_BYTES + MAX_IMAGE_BYTES, NAMES.data);
      if (!h.mapping) return false;
      h.view = MapViewOfFile(h.mapping, 0x0002 /* FILE_MAP_WRITE */, 0, 0, 0);
      if (!h.view) return false;
      if (koffi.decode(h.view, 'uint32_t') !== MAX_IMAGE_BYTES) WriteMemory(Number(koffi.address(h.view)), new Uint8Array(new Uint32Array([MAX_IMAGE_BYTES]).buffer), 4);
      return true;
    } finally {
      ReleaseMutex(h.mutex);
    }
  };

  const header = new Uint8Array(HEADER_BYTES);
  let px = new Uint8Array(0);
  const result = { frames: 0, oldFrames: 0, fps: 0, width: 0, height: 0, stride: 0, format: -1, resizemode: -1, mirrormode: -1, timeout: -1, first: -1, last: -1, skipped: 0, errors: [], meanLuma: 0, png: '' };
  const times = [];
  let lumaSum = 0;
  let prevN = -1;
  const deadline = performance.now() + seconds * 1000;
  while (result.frames < wantFrames && performance.now() < deadline) {
    // the filter's Receive: nothing until the sender wrote a width, then ask (Want) and wait for Sent
    if (!open() || koffi.decode(h.view, 4, 'int32_t') === 0) {
      sleep(33);
      continue;
    }
    SetEvent(h.want);
    const isNew = WaitForSingleObject(h.sent, RECEIVE_MAX_WAIT) === 0;
    const t = performance.now();
    WaitForSingleObject(h.mutex, 0xffffffff);
    try {
      const base = Number(koffi.address(h.view));
      ReadMemory(header, base, HEADER_BYTES);
      const dv = new DataView(header.buffer);
      const [w, hh] = [dv.getInt32(4, true), dv.getInt32(8, true)];
      if (px.length !== w * hh * 4) px = new Uint8Array(w * hh * 4);
      ReadMemory(px, base + HEADER_BYTES, px.length);
      Object.assign(result, { width: w, height: hh, stride: dv.getInt32(12, true), format: dv.getInt32(16, true), resizemode: dv.getInt32(20, true), mirrormode: dv.getInt32(24, true), timeout: dv.getInt32(28, true) });
    } finally {
      ReleaseMutex(h.mutex);
    }
    if (!isNew) {
      result.oldFrames++;
      continue;
    }
    result.frames++;
    times.push(t);
    lumaSum += meanLuma(px, result.width, result.height);
    if (expectW && (result.width !== expectW || result.height !== expectH)) result.errors.push(`frame is ${result.width}x${result.height}, expected ${expectW}x${expectH}`);
    if (result.stride !== result.width) result.errors.push(`stride ${result.stride} is not the width ${result.width}`);
    if (pattern) {
      const n = checkPattern(px, result.width, result.height);
      if (typeof n === 'string') result.errors.push(n);
      else {
        if (prevN >= 0) {
          const step = (n - prevN + 256) & 255;
          if (step === 0) result.errors.push(`frame ${n} arrived twice`);
          else result.skipped += step - 1;
        }
        if (result.first < 0) result.first = n;
        result.last = prevN = n;
      }
    }
  }
  if (times.length > 1) result.fps = ((times.length - 1) * 1000) / (times.at(-1) - times[0]);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  result.maxGapMs = Math.round(Math.max(0, ...gaps));
  result.gapsOver100ms = gaps.filter((g) => g > 100).map((g, i) => `${Math.round(times[gaps.indexOf(g)] - times[0])}ms+${Math.round(g)}`).slice(0, 12);
  if (result.frames) result.meanLuma = lumaSum / result.frames;
  if (png && px.length) savePng((result.png = path.resolve(png)), px, result.width, result.height);
  result.errors = result.errors.slice(0, 10);
  fs.writeSync(1, `${JSON.stringify(result)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();

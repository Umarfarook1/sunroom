// Windows virtual camera: feeds the UnityCapture DirectShow filter (MIT, https://github.com/schellingb/UnityCapture)
// through its named shared memory, with koffi so nothing is compiled.
//
// Protocol, read from Source/shared.inl and Source/UnityCaptureFilter.cpp on master (fetched 2026-11-06):
// - The filter, loaded inside the app that opened the camera, creates the mutex, the "Sent" event and the mapping.
//   The sender opens those and creates the "Want" event (shared.inl 106-135). So we can only connect after an app
//   has opened the camera, and we keep half-open handles between attempts so that handshake converges.
// - Mapping: DWORD maxSize; int width, height, stride, format, resizemode, mirrormode, timeout; then pixels
//   (shared.inl 146-157). The receiver sets maxSize (shared.inl 140-141); the sender writes the rest (shared.inl 76-85).
// - FORMAT_UINT8 pixels are R,G,B,A bytes: the filter's RGBATOBGRA swaps bytes 0 and 2 to make its BGRA output
//   (UnityCaptureFilter.cpp 226), and Unity's own sender labels DXGI_FORMAT_R8G8B8A8 textures FORMAT_UINT8
//   (UnityCapturePlugin.cpp 124).
// - stride counts pixels, not bytes: Unity sends RowPitch / 4 (UnityCapturePlugin.cpp 134) and the filter steps a
//   uint32_t pointer by it (UnityCaptureFilter.cpp 190).
// - Rows go bottom-up: the filter copies source row 0 to row 0 of a DIB with positive biHeight
//   (UnityCaptureFilter.cpp 584-587, 866), which DirectShow reads bottom-up, and pyvirtualcam flips every frame
//   vertically before sending (pyvirtualcam native_windows_unity_capture/virtual_output.h 141-142).
// - The filter sets "Want" each time it reads, but only once the header width is non-zero (shared.inl 52-54).

import { setInterval } from 'node:timers';
import koffi from 'koffi';
import type { RgbaFrame, VirtualCameraOutput, VirtualCameraState } from './output';

/** Shared-object names for device 0; device N appends the digit N (shared.inl 100-104). */
export const NAMES = { mutex: 'UnityCapture_Mutx', want: 'UnityCapture_Want', sent: 'UnityCapture_Sent', data: 'UnityCapture_Data' };
/** Pixel bytes the filter's mapping holds (shared.inl 16). */
export const MAX_IMAGE_BYTES = 3840 * 2160 * 4 * 2;
export const HEADER_BYTES = 32;
/** The 64-bit filter's COM class; the 32-bit build uses ...0020 (UnityCaptureFilter.cpp 39-45). */
export const FILTER_CLSID_64 = '{5C2CD55C-92AD-4999-8666-912BD3E70010}';

const FORMAT_UINT8 = 0;
// the app picks the size it wants; without resizing the filter shows an error pattern on any mismatch (UnityCaptureFilter.cpp 537-549)
const RESIZEMODE_LINEAR = 1;
const MIRRORMODE_DISABLED = 0;
// after this long without frames the filter shows its "stopped sending" pattern instead of a frozen face (UnityCaptureFilter.cpp 535)
const TIMEOUT_MS = 1000;
const POLL_MS = 1000;
// a reading app sets Want at least every 200 ms (shared.inl 42, 54), so 2.5 s of silence means it stopped
const LIVE_MS = 2500;
// after an app connects, the real camera may have to start before our first frame can go out
const CONNECT_MS = 8000;
const LOCK_MS = 100;

const SYNCHRONIZE = 0x00100000;
const EVENT_MODIFY_STATE = 0x0002;
const FILE_MAP_WRITE = 0x0002;
const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const HKEY_CLASSES_ROOT = -0x80000000; // (HKEY)(ULONG_PTR)(LONG)0x80000000, sign-extended on x64
const RRF_RT_ANY = 0xffff;

/**
 * Lays out one frame the way the filter reads it, starting at mapping offset 4 (after maxSize):
 * the seven header ints, then the rows bottom-up.
 */
export function packFrame(frame: RgbaFrame, reuse?: Uint8Array): Uint8Array {
  const { width, height, data } = frame;
  const row = width * 4;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.length !== row * height) {
    throw new RangeError(`frame ${width}x${height} with ${data.length} bytes is not tightly packed RGBA`);
  }
  const size = HEADER_BYTES - 4 + row * height;
  const out = reuse?.length === size ? reuse : new Uint8Array(size);
  const header = new DataView(out.buffer, out.byteOffset, HEADER_BYTES - 4);
  [width, height, width, FORMAT_UINT8, RESIZEMODE_LINEAR, MIRRORMODE_DISABLED, TIMEOUT_MS].forEach((v, i) => header.setInt32(i * 4, v, true));
  for (let y = 0; y < height; y++) out.set(data.subarray(y * row, (y + 1) * row), HEADER_BYTES - 4 + (height - 1 - y) * row);
  return out;
}

function bind() {
  const k = koffi.load('kernel32.dll');
  const a = koffi.load('advapi32.dll');
  return {
    OpenMutexA: k.func('void * __stdcall OpenMutexA(uint32_t access, int inherit, const char *name)'),
    CreateEventA: k.func('void * __stdcall CreateEventA(void *attributes, int manualReset, int initialState, const char *name)'),
    OpenEventA: k.func('void * __stdcall OpenEventA(uint32_t access, int inherit, const char *name)'),
    OpenFileMappingA: k.func('void * __stdcall OpenFileMappingA(uint32_t access, int inherit, const char *name)'),
    MapViewOfFile: k.func('void * __stdcall MapViewOfFile(void *mapping, uint32_t access, uint32_t offsetHigh, uint32_t offsetLow, size_t bytes)'),
    UnmapViewOfFile: k.func('int __stdcall UnmapViewOfFile(void *view)'),
    WaitForSingleObject: k.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t ms)'),
    ReleaseMutex: k.func('int __stdcall ReleaseMutex(void *mutex)'),
    SetEvent: k.func('int __stdcall SetEvent(void *event)'),
    CloseHandle: k.func('int __stdcall CloseHandle(void *handle)'),
    // dst as an integer address: Electron forbids koffi.view() over foreign memory, so we copy into it instead
    RtlMoveMemory: k.func('void __stdcall RtlMoveMemory(uintptr_t dst, const void *src, size_t bytes)'),
    RegGetValueA: a.func('int32_t __stdcall RegGetValueA(intptr_t key, const char *subKey, const char *value, uint32_t flags, void *type, void *data, void *bytes)'),
  };
}
let win32: ReturnType<typeof bind> | null = null;
const api = () => (win32 ??= bind());

function lock(mutex: unknown): boolean {
  const r = api().WaitForSingleObject(mutex, LOCK_MS);
  return r === WAIT_OBJECT_0 || r === WAIT_ABANDONED;
}

/** Read-only: is the 64-bit filter registered (machine-wide or per-user, as HKCR merges both)? */
function filterRegistered(): boolean {
  return api().RegGetValueA(HKEY_CLASSES_ROOT, `CLSID\\${FILTER_CLSID_64}\\InprocServer32`, null, RRF_RT_ANY, null, null, null) === 0;
}

export class UnityCaptureOutput implements VirtualCameraOutput {
  state: VirtualCameraState = 'waiting';
  private readonly onState: (state: VirtualCameraState) => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private mutex: unknown = null;
  private want: unknown = null;
  private sent: unknown = null;
  private mapping: unknown = null;
  private view: unknown = null;
  private maxSize = 0;
  private lastWantMs = -Infinity;
  private sentAny = false;
  private packed: Uint8Array | undefined;

  constructor(onState: (state: VirtualCameraState) => void = () => {}) {
    this.onState = onState;
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS).unref();
  }

  send(frame: RgbaFrame): void {
    if (!this.view) return;
    const k = api();
    const packed = (this.packed = packFrame(frame, this.packed));
    if (packed.length - (HEADER_BYTES - 4) > this.maxSize) throw new RangeError(`frame ${frame.width}x${frame.height} exceeds the camera's ${this.maxSize} bytes`);
    // the filter holds the lock while converting a frame; if it is stuck, drop this frame rather than stall the app
    if (!lock(this.mutex)) return;
    try {
      k.RtlMoveMemory(Number(koffi.address(this.view)) + 4, packed, packed.length);
    } finally {
      k.ReleaseMutex(this.mutex);
    }
    k.SetEvent(this.sent);
    this.sentAny = true;
    this.noteWant();
  }

  close(): void {
    clearInterval(this.timer);
    this.disconnect();
  }

  private disconnect(): void {
    const k = api();
    if (this.view) k.UnmapViewOfFile(this.view);
    for (const h of [this.mapping, this.sent, this.want, this.mutex]) if (h) k.CloseHandle(h);
    this.view = this.mapping = this.sent = this.want = this.mutex = null;
    this.sentAny = false;
  }

  private tick(): void {
    const now = performance.now();
    if (this.view) {
      this.noteWant();
      // Until our first frame the filter asks for nothing. A connect that got no frame within its grace (the webcam
      // was busy, or slow to start) would leave us connected and deaf. Let go, so the next tick connects again.
      if (!this.sentAny && now - this.lastWantMs >= LIVE_MS) this.disconnect();
    } else if (this.open()) {
      // a new mapping has width 0: count the connect itself as a request
      this.lastWantMs = now + CONNECT_MS - LIVE_MS;
    }
    // looked up every time, so removing the camera shows at once, also after an app has connected
    const next: VirtualCameraState = !filterRegistered() ? 'not-installed' : this.view && now - this.lastWantMs < LIVE_MS ? 'sending' : 'waiting';
    if (next === this.state) return;
    this.state = next;
    this.onState(next);
  }

  private noteWant(): void {
    if (api().WaitForSingleObject(this.want, 0) === WAIT_OBJECT_0) this.lastWantMs = performance.now();
  }

  /** The sender half of SharedImageMemory::Open (shared.inl 94-144). */
  private open(): boolean {
    const k = api();
    this.mutex ??= k.OpenMutexA(SYNCHRONIZE, 0, NAMES.mutex);
    if (!this.mutex || !lock(this.mutex)) return false;
    try {
      this.want ??= k.CreateEventA(null, 0, 0, NAMES.want);
      if (!this.want) return false;
      this.sent ??= k.OpenEventA(EVENT_MODIFY_STATE, 0, NAMES.sent);
      if (!this.sent) return false;
      this.mapping ??= k.OpenFileMappingA(FILE_MAP_WRITE, 0, NAMES.data);
      if (!this.mapping) return false;
      const view = k.MapViewOfFile(this.mapping, FILE_MAP_WRITE, 0, 0, 0);
      if (!view) return false;
      this.maxSize = koffi.decode(view, 'uint32_t');
      this.view = view;
      return true;
    } finally {
      k.ReleaseMutex(this.mutex);
    }
  }
}

// Worker started by the injected exporter. It owns the port to the main process, turns each enhanced frame into
// RGBA and posts it there, all off the page's main thread so the enhancer keeps its frame rate.

type FromPage = { type: 'port'; port: MessagePort } | { type: 'frame'; frame: VideoFrame } | { type: 'stop' } | { type: 'setup' };
type FromMain = { type: 'state' } | { type: 'ack'; mainMs: number; transitMs: number };

const MAX_IN_FLIGHT = 2;
/** Running totals: readMs per frame read, postMs per frame posted, mainMs and transitMs per ack. */
const stats = { reads: 0, frames: 0, dropped: 0, readMs: 0, postMs: 0, mainMs: 0, transitMs: 0, acks: 0, width: 0, height: 0 };
let port: MessagePort | null = null;
let inFlight = 0;
let rb: Readback | null = null;

/**
 * Frames on a track arrive as NV12, and VideoFrame.copyTo({ format: 'RGBA' }) converts them on the CPU
 * (18 ms per 1280x720 frame measured). A WebGL upload plus a pixel-buffer readback converts on the GPU;
 * each copy lands a frame or two later.
 */
class Readback {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
  private readonly gl: WebGL2RenderingContext;
  // a fence often shows as done only after the next frame has arrived, so one buffer would drop every few frames
  private readonly slots: { pbo: WebGLBuffer; fence: WebGLSync | null }[] = [];
  private readonly pending: number[] = []; // slots being copied, oldest first

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height * 4);
    const gl = (this.gl = new OffscreenCanvas(1, 1).getContext('webgl2')!);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, gl.createFramebuffer());
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, gl.getParameter(gl.TEXTURE_BINDING_2D), 0);
    for (let i = 0; i < 2; i++) {
      const pbo = gl.createBuffer()!;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.pixels.length, gl.STREAM_READ);
      this.slots.push({ pbo, fence: null });
    }
  }

  /** Starts copying a frame, rows top-down, into a free pixel buffer; false when none is free. */
  start(frame: VideoFrame): boolean {
    const i = this.slots.findIndex((s) => !s.fence);
    const slot = this.slots[i];
    if (!slot) return false;
    const gl = this.gl;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.pending.push(i);
    return true;
  }

  /** Moves the oldest started copy into `pixels` if the GPU has finished it. Never waits. */
  collect(): boolean {
    const slot = this.slots[this.pending[0] ?? -1];
    if (!slot?.fence) return false;
    const gl = this.gl;
    const r = gl.clientWaitSync(slot.fence, 0, 0);
    if (r !== gl.ALREADY_SIGNALED && r !== gl.CONDITION_SATISFIED) return false;
    gl.deleteSync(slot.fence);
    slot.fence = null;
    this.pending.shift();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels);
    return true;
  }

  dispose(): void {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function post(from: Readback): void {
  if (!port || inFlight >= MAX_IN_FLIGHT) {
    stats.dropped++; // main is behind: drop rather than queue, so the app sees the newest picture
    return;
  }
  const t = performance.now();
  // copied, not transferred: Electron's MessagePortMain silently drops messages that transfer an ArrayBuffer
  port.postMessage({ type: 'frame', width: from.width, height: from.height, data: from.pixels.buffer, sentAt: performance.timeOrigin + t });
  inFlight++;
  Object.assign(stats, { frames: stats.frames + 1, postMs: stats.postMs + performance.now() - t, width: from.width, height: from.height });
}

function exportFrame(frame: VideoFrame): void {
  const t0 = performance.now();
  try {
    while (rb?.collect()) post(rb);
    const { width, height } = frame.visibleRect!;
    if (rb?.width !== width || rb.height !== height) {
      rb?.dispose();
      rb = new Readback(width, height);
    }
    if (!rb.start(frame)) stats.dropped++;
  } finally {
    frame.close();
  }
  stats.reads++;
  stats.readMs += performance.now() - t0;
}

addEventListener('message', ({ data }: MessageEvent<FromPage>) => {
  if (data.type === 'frame') {
    exportFrame(data.frame);
    postMessage({ type: 'took', stats }); // lets the page bound how many frames wait here
  } else if (data.type === 'stop') {
    rb?.dispose(); // no stale picture is left to send when an app connects again
    rb = null;
  } else if (data.type === 'setup') {
    port?.postMessage({ type: 'setup' });
  } else {
    port?.close();
    port = data.port;
    inFlight = 0;
    port.onmessage = ({ data: m }: MessageEvent<FromMain>) => {
      if (m.type === 'state') return postMessage(m);
      inFlight--;
      Object.assign(stats, { acks: stats.acks + 1, mainMs: stats.mainMs + m.mainMs, transitMs: stats.transitMs + m.transitMs });
    };
  }
});

export {}; // a module, so its top-level names stay its own

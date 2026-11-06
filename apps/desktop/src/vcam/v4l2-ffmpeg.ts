// Linux virtual camera: a v4l2loopback device (GPL-2.0, https://github.com/v4l2loopback/v4l2loopback) fed by one
// ffmpeg child process that reads raw RGBA frames on stdin. Root loads the module once (PLATFORMS.md); after that
// ffmpeg writes to the device as the user. v4l2loopback never tells the writer whether an app is reading, so
// 'sending' means only that ffmpeg takes our frames.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Writable } from 'node:stream';
import type { RgbaFrame, VirtualCameraOutput, VirtualCameraState } from './output';

const DEFAULT_DEVICE = '/dev/video10';
// the documented ffmpeg route into v4l2loopback (https://github.com/v4l2loopback/v4l2loopback/wiki/Ffmpeg)
const V4L2_OUTPUT = ['-f', 'v4l2', '-pix_fmt', 'yuv420p'];
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 10_000;
const POLL_MS = 2000;

interface Ffmpeg {
  proc: ChildProcessByStdio<Writable, null, null>;
  width: number;
  height: number;
  startedAt: number;
}

export interface V4l2Options {
  /** Device node to write to. Default: $SUNROOM_V4L2_DEVICE, else /dev/video10. */
  device?: string;
  /** ffmpeg output options placed before the device path; tests swap them to write a plain file. */
  outputArgs?: string[];
}

export class V4l2FfmpegOutput implements VirtualCameraOutput {
  state: VirtualCameraState;
  private readonly onState: (state: VirtualCameraState) => void;
  private readonly device: string;
  private readonly outputArgs: string[];
  private ffmpeg: Ffmpeg | null = null;
  private retryAt = -Infinity;
  private backoffMs = MIN_BACKOFF_MS;
  private closed = false;
  private readonly poll: NodeJS.Timeout;

  constructor(onState: (state: VirtualCameraState) => void = () => {}, options: V4l2Options = {}) {
    this.onState = onState;
    this.device = options.device ?? process.env.SUNROOM_V4L2_DEVICE ?? DEFAULT_DEVICE;
    this.outputArgs = options.outputArgs ?? V4L2_OUTPUT;
    this.state = this.writable() ? 'waiting' : 'not-installed';
    // no frames arrive while the camera is not set up, so nothing else would notice the device or ffmpeg appearing
    this.poll = setInterval(() => {
      if (this.state === 'not-installed' && performance.now() >= this.retryAt && this.writable()) this.setState('waiting');
    }, POLL_MS);
    this.poll.unref();
  }

  send(frame: RgbaFrame): void {
    const { width, height, data } = frame;
    // ffmpeg cuts stdin into fixed-size frames, so one wrong length would shift every frame after it
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || data.length !== width * height * 4) {
      throw new RangeError(`frame ${width}x${height} with ${data.length} bytes is not tightly packed RGBA`);
    }
    const f = (this.ffmpeg ??= this.start(width, height));
    if (!f?.proc.stdin.writable) return;
    if (f.width !== width || f.height !== height) {
      f.proc.stdin.end(); // the first frame after this ffmpeg exits starts one at the new size
      return;
    }
    if (f.proc.stdin.writableNeedDrain) return; // still writing an older frame: drop this one rather than queue it
    // a copy, because the caller may refill its buffer before the pipe drains
    f.proc.stdin.write(Buffer.from(data), (err) => {
      if (!err && this.ffmpeg === f) this.setState('sending');
    });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.poll);
    this.ffmpeg?.proc.stdin.end();
  }

  private start(width: number, height: number): Ffmpeg | null {
    if (this.closed || performance.now() < this.retryAt) return null;
    if (!this.writable()) {
      this.retry('not-installed');
      return null;
    }
    const args = ['-v', 'error', '-nostats', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', '30', '-i', '-', ...this.outputArgs, this.device];
    const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'inherit'] });
    const f: Ffmpeg = { proc, width, height, startedAt: performance.now() };
    proc.stdin.on('error', () => {}); // EPIPE after ffmpeg dies; 'close' below handles that
    proc.on('error', (err) => console.error('[sunroom] ffmpeg:', err.message)); // ENOENT when ffmpeg is not on PATH
    proc.on('close', (code, signal) => {
      if (this.ffmpeg === f) this.ffmpeg = null;
      if (this.closed) return;
      if (proc.stdin.writableEnded) return this.setState('waiting'); // we ended it for a new frame size
      // a run that outlasted the longest wait was healthy, so this failure starts the back-off over
      if (performance.now() - f.startedAt > MAX_BACKOFF_MS) this.backoffMs = MIN_BACKOFF_MS;
      console.error(`[sunroom] ffmpeg exited (${signal ?? code}); starting it again in ${this.backoffMs} ms`);
      this.retry(proc.pid === undefined || !this.writable() ? 'not-installed' : 'waiting');
    });
    return f;
  }

  private retry(state: VirtualCameraState): void {
    this.retryAt = performance.now() + this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    this.setState(state);
  }

  private writable(): boolean {
    try {
      fs.accessSync(this.device, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  private setState(state: VirtualCameraState): void {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }
}

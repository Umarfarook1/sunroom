// A live camera made better: real camera track in, enhanced track out.
// Every shell (web page, browser extension, desktop app) is a thin wrapper around this.

import { type CameraCaps, type CameraSettings, type Command, type DirectorState, direct, initialDirectorState } from './director';
import { Enhancer, type EnhancerOptions, type FrameReport } from './enhancer';
import { type FaceTracker, FaceSmoother } from './face';
import type { FaceBox } from './meter';

/** How long after the first frame the director waits before it judges the camera. */
const WARM_UP_MS = 2500;

export interface SessionOptions extends EnhancerOptions {
  /** Supplies face positions for metering. Without one, metering is centre-weighted. The caller owns and closes it. */
  faceTracker?: FaceTracker | null;
  /** Let Sunroom drive the camera's exposure, gain and white balance. Default true. */
  director?: boolean;
  /** Milliseconds between face detections. Default 200. */
  faceIntervalMs?: number;
  /**
   * Put the camera's controls back when the session stops: gain, black level and a hand-fixed white
   * balance as found, exposure to automatic. Default true.
   */
  restoreCameraOnStop?: boolean;
}

export interface SessionStatus {
  /** Frames per second the camera itself produces, from the browser's own frame count where it keeps one. */
  cameraFps: number;
  /** Enhanced frames per second leaving the session. Well below cameraFps, this device cannot keep up. */
  outputFps: number;
  /** Milliseconds spent enhancing the last frame. */
  processMs: number;
  /** Share of the last second spent enhancing, 0..1. Above about 0.7 the device cannot keep up. */
  busy: number;
  width: number;
  height: number;
  face: FaceBox | null;
  frame: FrameReport | null;
  director: { mode: DirectorState['mode']; lastReason: string | null; lastCommand: Command | null };
  /** How frames are pumped: 'streams' survives background tabs, 'canvas' is the fallback. */
  transport: 'streams' | 'canvas';
  /**
   * Set when enhancing failed. On the streams transport the track keeps running and carries the
   * camera's frames untouched, so a call never loses video; on the canvas transport it ends.
   */
  error: string | null;
}

// Insertable Streams types are not in lib.dom yet.
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>;
}
interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}
declare const MediaStreamTrackProcessor: { new (init: { track: MediaStreamTrack; maxBufferSize?: number }): TrackProcessor } | undefined;
declare const MediaStreamTrackGenerator: { new (init: { kind: 'video' }): TrackGenerator } | undefined;

type ImageCaps = MediaTrackCapabilities & {
  exposureMode?: string[];
  exposureTime?: { min: number; max: number; step: number };
  exposureCompensation?: { min: number; max: number; step: number };
  whiteBalanceMode?: string[];
  brightness?: { min: number; max: number; step: number };
};
type ImageSettings = MediaTrackSettings & {
  exposureMode?: string;
  exposureTime?: number;
  exposureCompensation?: number;
  whiteBalanceMode?: string;
  colorTemperature?: number;
  brightness?: number;
};

function readCaps(track: MediaStreamTrack): CameraCaps {
  const c = (track.getCapabilities?.() ?? {}) as ImageCaps;
  return {
    exposureTime: c.exposureTime,
    gain: c.exposureCompensation,
    manualExposure: !!c.exposureMode?.includes('manual'),
    autoExposure: !!c.exposureMode?.includes('continuous'),
    autoWhiteBalance: !!c.whiteBalanceMode?.includes('continuous'),
    brightness: c.brightness,
  };
}

function readSettings(track: MediaStreamTrack): CameraSettings {
  const s = track.getSettings() as ImageSettings;
  return {
    exposureMode: s.exposureMode,
    exposureTime: s.exposureTime,
    gain: s.exposureCompensation,
    whiteBalanceMode: s.whiteBalanceMode,
    colorTemperature: s.colorTemperature,
    brightness: s.brightness,
  };
}

export class CameraSession {
  /** The enhanced video track. Give this to the call instead of the camera's own. */
  readonly track: MediaStreamTrack;
  readonly status: SessionStatus;
  private readonly enhancer: Enhancer;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly smoother = new FaceSmoother();
  private readonly caps: CameraCaps;
  private readonly original: CameraSettings;
  private readonly touched = new Set<keyof Command>();
  private directorState = initialDirectorState();
  private directorOn: boolean;
  private stopped = false;
  private arrivals: number[] = [];
  private firstFrameMs = 0;
  private readonly counted = { atMs: 0, total: 0, fps: null as number | null };
  private work: number[] = [];
  private lastFaceMs = -1e9;
  private faceBusy = false;
  private video: HTMLVideoElement | null = null;

  constructor(private readonly camera: MediaStreamTrack, private readonly opts: SessionOptions = {}) {
    const useStreams = typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined';
    this.canvas = useStreams && typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
    this.enhancer = new Enhancer(this.canvas, opts);
    this.caps = readCaps(camera);
    this.original = this.baseline();
    this.directorOn = opts.director ?? true;
    this.status = {
      cameraFps: 0,
      outputFps: 0,
      processMs: 0,
      busy: 0,
      width: 0,
      height: 0,
      face: null,
      frame: null,
      director: { mode: 'observe', lastReason: null, lastCommand: null },
      transport: useStreams ? 'streams' : 'canvas',
      error: null,
    };
    this.canvas.addEventListener('webglcontextlost', () => this.fail('the graphics context was lost'));
    this.track = useStreams ? this.pumpStreams() : this.pumpCanvas();
    camera.addEventListener('ended', () => void this.stop());
  }

  get enabled(): boolean {
    return this.enhancer.enabled;
  }
  set enabled(on: boolean) {
    this.enhancer.enabled = on;
  }

  /** Gives a running session its face detector, for one that finished loading after the call started. */
  set faceTracker(tracker: FaceTracker | null) {
    this.opts.faceTracker = tracker ?? undefined;
  }

  get director(): boolean {
    return this.directorOn;
  }
  /** Turning the director off hands the camera's controls back as they were found. */
  set director(on: boolean) {
    if (this.directorOn && !on) {
      void this.restoreCamera();
      this.directorState = initialDirectorState();
      this.status.director = { mode: 'observe', lastReason: null, lastCommand: null };
    }
    this.directorOn = on;
  }

  /**
   * Stops enhancing, releases the GPU and puts the camera's controls back.
   * The camera track itself is left to its owner; await this before stopping that track.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.track.stop();
    this.video?.remove();
    this.enhancer.dispose();
    if (this.opts.restoreCameraOnStop ?? true) await this.restoreCamera();
  }

  private async restoreCamera(): Promise<void> {
    if (!this.touched.size || this.camera.readyState !== 'live') return;
    const o = this.original;
    const back: Command = {};
    if (this.touched.has('exposureMode') && o.exposureMode) back.exposureMode = o.exposureMode as Command['exposureMode'];
    if (this.touched.has('exposureTime') && o.exposureMode === 'manual') back.exposureTime = o.exposureTime;
    if (this.touched.has('exposureCompensation')) back.exposureCompensation = o.gain;
    if (this.touched.has('brightness')) back.brightness = o.brightness;
    if (this.touched.has('whiteBalanceMode') && o.whiteBalanceMode === 'manual') {
      back.whiteBalanceMode = 'manual';
      back.colorTemperature = o.colorTemperature;
    }
    this.touched.clear();
    const ok = await this.camera.applyConstraints({ advanced: [back as MediaTrackConstraintSet] }).then(
      () => true,
      () => false,
    );
    if (ok) this.remember(null);
  }

  /**
   * The camera state to return to. A tab can be closed before the controls are put back, and the
   * camera keeps them, so what we find at start may be our own leftovers: gain and black level
   * are recovered from a note left at first touch, and exposure goes back to automatic.
   */
  private baseline(): CameraSettings {
    const found = readSettings(this.camera);
    let saved: Partial<CameraSettings> = {};
    try {
      saved = JSON.parse(localStorage.getItem(this.noteKey()) ?? '{}') as Partial<CameraSettings>;
    } catch {
      // no storage here: the found state is the best we have
    }
    return { ...found, ...saved, exposureMode: this.caps.autoExposure ? 'continuous' : found.exposureMode };
  }

  private noteKey(): string {
    return `sunroom.camera.${this.camera.getSettings().deviceId ?? 'default'}`;
  }

  private remember(original: CameraSettings | null): void {
    try {
      if (original) localStorage.setItem(this.noteKey(), JSON.stringify({ gain: original.gain, brightness: original.brightness }));
      else localStorage.removeItem(this.noteKey());
    } catch {
      // best effort
    }
  }

  private fail(why: string): void {
    if (this.stopped || this.status.error) return;
    this.status.error = why;
    console.error('[sunroom] enhancing stopped:', why);
    void this.restoreCamera();
    if (this.status.transport === 'canvas') void this.stop();
  }

  private pumpStreams(): MediaStreamTrack {
    const processor = new MediaStreamTrackProcessor!({ track: this.camera, maxBufferSize: 1 });
    const generator = new MediaStreamTrackGenerator!({ kind: 'video' });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    void (async () => {
      try {
        while (!this.stopped) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;
          // stop() may have run while we waited: enhancing this frame would rebuild the GPU pipeline it
          // disposed and could send the camera a command after its controls were put back
          if (this.stopped) {
            frame.close();
            break;
          }
          let out: VideoFrame = frame;
          if (!this.status.error) {
            try {
              this.step(frame, frame.displayWidth, frame.displayHeight, frame.timestamp / 1000);
              out = new VideoFrame(this.canvas, { timestamp: frame.timestamp, alpha: 'discard' });
            } catch (err) {
              // an unenhanced call beats a frozen one: from here on the camera's frames pass straight through
              this.fail(err instanceof Error ? err.message : String(err));
            }
          }
          if (out !== frame) frame.close();
          await writer.write(out);
          out.close();
        }
      } catch (err) {
        if (!this.stopped) console.error('[sunroom] frame pump stopped', err);
      } finally {
        reader.releaseLock();
        writer.close().catch(() => {});
      }
    })();
    return generator;
  }

  private pumpCanvas(): MediaStreamTrack {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([this.camera]);
    this.video = video;
    void video.play();
    const canvas = this.canvas as HTMLCanvasElement;
    const out = canvas.captureStream().getVideoTracks()[0]!;
    const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
      if (this.stopped) return;
      if (video.videoWidth > 0) this.step(video, video.videoWidth, video.videoHeight, meta.mediaTime * 1000);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    return out;
  }

  private step(source: TexImageSource, w: number, h: number, timeMs: number): void {
    const t0 = performance.now();
    const frame = this.enhancer.process(source, w, h, timeMs);
    const now = performance.now();
    this.arrivals.push(now);
    this.work.push(now - t0);
    while (this.arrivals.length > 2 && now - this.arrivals[0]! > 1000) {
      this.arrivals.shift();
      this.work.shift();
    }
    const span = now - this.arrivals[0]!;
    const s = this.status;
    s.processMs = now - t0;
    s.busy = span > 200 ? Math.min(1, this.work.slice(1).reduce((a, b) => a + b, 0) / span) : s.busy;
    s.outputFps = span > 200 ? ((this.arrivals.length - 1) * 1000) / span : s.outputFps;
    s.cameraFps = this.cameraRate(now) ?? s.outputFps;
    s.width = w;
    s.height = h;
    s.frame = frame;
    this.trackFace(w, h, now);
    this.firstFrameMs ||= now;
    // a cold start (shaders compiling, the detector loading) is slow in ways that say nothing about the camera
    if (this.directorOn && span > 900 && now - this.firstFrameMs > WARM_UP_MS) this.runDirector(frame, now);
  }

  /**
   * The camera's rate from the browser's count of frames it produced (Chrome's MediaStreamTrack.stats).
   * Unlike arrival times it does not fall when we are the slow part. Null where the browser keeps no count.
   */
  private cameraRate(now: number): number | null {
    const c = this.counted;
    if (c.atMs && now - c.atMs < 1000) return c.fps;
    const total = (this.camera as MediaStreamTrack & { stats?: { totalFrames: number } }).stats?.totalFrames;
    if (total === undefined) return null;
    if (c.atMs) c.fps = ((total - c.total) * 1000) / (now - c.atMs);
    c.atMs = now;
    c.total = total;
    return c.fps;
  }

  private trackFace(w: number, h: number, now: number): void {
    const tracker = this.opts.faceTracker;
    if (!tracker || this.faceBusy || now - this.lastFaceMs < (this.opts.faceIntervalMs ?? 200)) return;
    this.lastFaceMs = now;
    this.faceBusy = true;
    // detect on the enhanced picture: a face too dark for the detector in the raw frame is visible here
    createImageBitmap(this.canvas, { resizeWidth: 320, resizeHeight: Math.round((320 * h) / w), resizeQuality: 'low' })
      .then((bmp) => {
        const box = this.stopped ? null : tracker.detect(bmp);
        bmp.close();
        this.status.face = this.smoother.update(box, performance.now());
        this.enhancer.setFace(this.status.face);
      })
      .catch(() => {})
      .finally(() => {
        this.faceBusy = false;
      });
  }

  private runDirector(frame: FrameReport, now: number): void {
    if (this.stopped) return;
    const nominalFps = this.camera.getSettings().frameRate ?? 30;
    const d = direct(this.directorState, this.caps, readSettings(this.camera), {
      nowMs: now,
      fps: this.status.cameraFps,
      nominalFps,
      // a rate counted by the browser cannot be dragged down by our own load
      busy: this.counted.fps === null ? this.status.busy : 0,
      shortfallStops: frame.decision.shortfallStops,
      p98: frame.stats.p98,
      p02: frame.stats.p02,
    });
    this.directorState = d.state;
    this.status.director.mode = d.state.mode;
    if (!d.command) return;
    this.status.director.lastCommand = d.command;
    this.status.director.lastReason = d.reason;
    if (!this.touched.size) this.remember(this.original);
    for (const key of Object.keys(d.command) as (keyof Command)[]) this.touched.add(key);
    this.camera.applyConstraints({ advanced: [d.command as MediaTrackConstraintSet] }).catch((err) => {
      // a camera that refuses a control keeps working; we just stop steering it
      console.warn('[sunroom] camera refused', d.command, err);
      this.directorOn = false;
    });
  }
}

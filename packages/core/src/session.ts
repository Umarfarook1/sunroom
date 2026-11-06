// A live camera made better: real camera track in, enhanced track out.
// Every shell (web page, browser extension, desktop app) is a thin wrapper around this.

import { type CameraCaps, type CameraSettings, type Command, type DirectorState, direct, initialDirectorState } from './director';
import { Enhancer, type EnhancerOptions, type FrameReport } from './enhancer';
import { type FaceTracker, FaceSmoother } from './face';
import type { FaceBox } from './meter';

export interface SessionOptions extends EnhancerOptions {
  /** Supplies face positions for metering. Without one, metering is centre-weighted. */
  faceTracker?: FaceTracker | null;
  /** Let Sunroom drive the camera's exposure, gain and white balance. Default true. */
  director?: boolean;
  /** Milliseconds between face detections. Default 200. */
  faceIntervalMs?: number;
  /** Put back every camera control the director changed when the session stops. Default true. */
  restoreCameraOnStop?: boolean;
}

export interface SessionStatus {
  /** Real frames per second arriving from the camera. */
  cameraFps: number;
  /** Milliseconds spent enhancing the last frame. */
  processMs: number;
  width: number;
  height: number;
  face: FaceBox | null;
  frame: FrameReport | null;
  director: { mode: DirectorState['mode']; lastReason: string | null; lastCommand: Command | null };
  /** How frames are pumped: 'streams' survives background tabs, 'canvas' is the fallback. */
  transport: 'streams' | 'canvas';
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
  brightness?: number;
};

function readCaps(track: MediaStreamTrack): CameraCaps {
  const c = (track.getCapabilities?.() ?? {}) as ImageCaps;
  return {
    exposureTime: c.exposureTime,
    gain: c.exposureCompensation,
    manualExposure: !!c.exposureMode?.includes('manual'),
    autoWhiteBalance: !!c.whiteBalanceMode?.includes('continuous'),
    brightness: c.brightness,
  };
}

function readSettings(track: MediaStreamTrack): CameraSettings {
  const s = track.getSettings() as ImageSettings;
  return { exposureMode: s.exposureMode, exposureTime: s.exposureTime, gain: s.exposureCompensation, whiteBalanceMode: s.whiteBalanceMode, brightness: s.brightness };
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
  private lastFaceMs = -1e9;
  private faceBusy = false;
  private video: HTMLVideoElement | null = null;

  constructor(private readonly camera: MediaStreamTrack, private readonly opts: SessionOptions = {}) {
    const useStreams = typeof MediaStreamTrackProcessor !== 'undefined' && typeof MediaStreamTrackGenerator !== 'undefined';
    this.canvas = useStreams && typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(2, 2) : document.createElement('canvas');
    this.enhancer = new Enhancer(this.canvas, opts);
    this.caps = readCaps(camera);
    this.original = readSettings(camera);
    this.directorOn = opts.director ?? true;
    this.status = {
      cameraFps: 0,
      processMs: 0,
      width: 0,
      height: 0,
      face: null,
      frame: null,
      director: { mode: 'observe', lastReason: null, lastCommand: null },
      transport: useStreams ? 'streams' : 'canvas',
    };
    this.track = useStreams ? this.pumpStreams() : this.pumpCanvas();
    camera.addEventListener('ended', () => this.stop());
  }

  get enabled(): boolean {
    return this.enhancer.enabled;
  }
  set enabled(on: boolean) {
    this.enhancer.enabled = on;
  }

  get director(): boolean {
    return this.directorOn;
  }
  set director(on: boolean) {
    this.directorOn = on;
  }

  /** Stops enhancing and releases the GPU. The camera track itself is left to its owner. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.touched.size && (this.opts.restoreCameraOnStop ?? true) && this.camera.readyState === 'live') {
      const o = this.original;
      const back: Command = {};
      if (this.touched.has('exposureMode') && o.exposureMode) back.exposureMode = o.exposureMode as Command['exposureMode'];
      if (this.touched.has('exposureTime') && o.exposureMode === 'manual') back.exposureTime = o.exposureTime;
      if (this.touched.has('exposureCompensation')) back.exposureCompensation = o.gain;
      if (this.touched.has('brightness')) back.brightness = o.brightness;
      this.camera.applyConstraints({ advanced: [back as MediaTrackConstraintSet] }).catch(() => {});
    }
    this.track.stop();
    this.video?.remove();
    this.opts.faceTracker?.close();
    this.enhancer.dispose();
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
          const ts = frame.timestamp;
          this.step(frame, frame.displayWidth, frame.displayHeight, ts / 1000);
          frame.close();
          const out = new VideoFrame(this.canvas, { timestamp: ts, alpha: 'discard' });
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
    while (this.arrivals.length > 2 && now - this.arrivals[0]! > 1000) this.arrivals.shift();
    const span = now - this.arrivals[0]!;
    const s = this.status;
    s.processMs = now - t0;
    s.cameraFps = span > 200 ? ((this.arrivals.length - 1) * 1000) / span : s.cameraFps;
    s.width = w;
    s.height = h;
    s.frame = frame;
    this.trackFace(w, h, now);
    if (this.directorOn && span > 900) this.runDirector(frame, now);
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
    const nominalFps = this.camera.getSettings().frameRate ?? 30;
    const d = direct(this.directorState, this.caps, readSettings(this.camera), {
      nowMs: now,
      fps: this.status.cameraFps,
      nominalFps,
      shortfallStops: frame.decision.shortfallStops,
      p98: frame.stats.p98,
      p02: frame.stats.p02,
    });
    this.directorState = d.state;
    this.status.director.mode = d.state.mode;
    if (!d.command) return;
    this.status.director.lastCommand = d.command;
    this.status.director.lastReason = d.reason;
    for (const key of Object.keys(d.command) as (keyof Command)[]) this.touched.add(key);
    this.camera.applyConstraints({ advanced: [d.command as MediaTrackConstraintSet] }).catch((err) => {
      // a camera that refuses a control keeps working; we just stop steering it
      console.warn('[sunroom] camera refused', d.command, err);
      this.directorOn = false;
    });
  }
}

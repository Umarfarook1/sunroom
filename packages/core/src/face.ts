// Face location for metering. The enhancer only needs a box; any detector can supply it.

import type { FaceBox } from './meter';

export interface FaceTracker {
  /** Largest face in the image, or null. Coordinates normalised, origin top-left. */
  detect(image: ImageBitmap): FaceBox | null;
  close(): void;
}

export interface MediaPipeAssets {
  /** Folder holding MediaPipe's vision_wasm_internal.{js,wasm}. */
  wasmBaseUrl: string;
  /** URL of blaze_face_short_range.tflite. */
  modelUrl: string;
}

/** BlazeFace through MediaPipe Tasks (Apache-2.0). Loaded lazily so shells without it stay small. */
export async function createMediaPipeFaceTracker(assets: MediaPipeAssets): Promise<FaceTracker> {
  const { FaceDetector, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const fileset = await FilesetResolver.forVisionTasks(assets.wasmBaseUrl);
  const detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: assets.modelUrl, delegate: 'CPU' },
    runningMode: 'IMAGE',
    minDetectionConfidence: 0.5,
  });
  return {
    detect(image) {
      let best: FaceBox | null = null;
      for (const d of detector.detect(image).detections) {
        const b = d.boundingBox;
        if (!b) continue;
        const box = { x: b.originX / image.width, y: b.originY / image.height, w: b.width / image.width, h: b.height / image.height };
        if (!best || box.w * box.h > best.w * best.h) best = box;
      }
      return best;
    },
    close: () => detector.close(),
  };
}

/** Steadies a detector's jittery boxes and rides through short losses. */
export class FaceSmoother {
  private box: FaceBox | null = null;
  private lastSeenMs = -1e9;

  constructor(private readonly holdMs = 1500) {}

  update(detected: FaceBox | null, nowMs: number): FaceBox | null {
    if (detected) {
      const p = this.box;
      const k = 0.5;
      this.box = p ? { x: p.x + (detected.x - p.x) * k, y: p.y + (detected.y - p.y) * k, w: p.w + (detected.w - p.w) * k, h: p.h + (detected.h - p.h) * k } : detected;
      this.lastSeenMs = nowMs;
    } else if (nowMs - this.lastSeenMs > this.holdMs) {
      this.box = null;
    }
    return this.box;
  }
}

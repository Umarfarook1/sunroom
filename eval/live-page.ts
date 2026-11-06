// Runs inside Chrome against the real webcam: starts a CameraSession and samples what it does.
import { CameraSession, createMediaPipeFaceTracker } from '../packages/core/src/index';

interface Sample {
  t: number;
  cameraFps: number;
  processMs: number;
  mode: string;
  reason: string | null;
  exposureMode: unknown;
  exposureTime: unknown;
  gain: unknown;
  brightness: unknown;
  face: boolean;
  faceLumaOut: number | null;
  shortfall: number | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(window as unknown as { runLive: (o: { seconds: number; director: boolean; enabled: boolean }) => Promise<unknown> }).runLive = async (o) => {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
  const camera = stream.getVideoTracks()[0]!;
  const faceTracker = await createMediaPipeFaceTracker({ wasmBaseUrl: '/mp', modelUrl: '/models/blaze_face_short_range.tflite' });
  const session = new CameraSession(camera, { faceTracker, director: o.director });
  session.enabled = o.enabled;
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = new MediaStream([session.track]);
  document.body.appendChild(video);
  await video.play();
  const probe = document.createElement('canvas');
  probe.width = 160;
  probe.height = 90;
  const ctx = probe.getContext('2d', { willReadFrequently: true })!;
  const samples: Sample[] = [];
  const t0 = performance.now();
  let outFrames = 0;
  const count = () => {
    outFrames++;
    video.requestVideoFrameCallback(count);
  };
  video.requestVideoFrameCallback(count);
  while (performance.now() - t0 < o.seconds * 1000) {
    await sleep(250);
    const s = session.status;
    const set = camera.getSettings() as Record<string, unknown>;
    let faceLumaOut: number | null = null;
    if (s.face) {
      ctx.drawImage(video, 0, 0, 160, 90);
      const f = s.face;
      const x = Math.floor((f.x + f.w * 0.2) * 160);
      const y = Math.floor((f.y + f.h * 0.2) * 90);
      const w = Math.max(1, Math.floor(f.w * 0.6 * 160));
      const h = Math.max(1, Math.floor(f.h * 0.6 * 90));
      const d = ctx.getImageData(x, y, w, h).data;
      const l: number[] = [];
      for (let i = 0; i < d.length; i += 4) l.push(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
      l.sort((a, b) => a - b);
      faceLumaOut = l[l.length >> 1] ?? null;
    }
    samples.push({
      t: +((performance.now() - t0) / 1000).toFixed(2),
      cameraFps: +s.cameraFps.toFixed(1),
      processMs: +s.processMs.toFixed(1),
      mode: s.director.mode,
      reason: s.director.lastReason,
      exposureMode: set.exposureMode,
      exposureTime: set.exposureTime,
      gain: set.exposureCompensation,
      brightness: set.brightness,
      face: !!s.face,
      faceLumaOut: faceLumaOut === null ? null : +faceLumaOut.toFixed(1),
      shortfall: s.frame ? +s.frame.decision.shortfallStops.toFixed(2) : null,
    });
  }
  const outFps = outFrames / ((performance.now() - t0) / 1000);
  // one enhanced frame for the record
  const shot = document.createElement('canvas');
  shot.width = video.videoWidth;
  shot.height = video.videoHeight;
  shot.getContext('2d')!.drawImage(video, 0, 0);
  const png = shot.toDataURL('image/jpeg', 0.9);
  const transport = session.status.transport;
  session.stop();
  await sleep(400);
  camera.stop();
  return { transport, outFps: +outFps.toFixed(1), samples, png };
};

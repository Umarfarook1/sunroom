// Stand-in UI until apps/web/dist exists: camera in, enhanced preview out, session published for the exporter.
// No face tracker here, so metering is centre-weighted; the web UI brings faces.
import { CameraSession } from '@sunroom/core';

const info = document.querySelector('#info')!;

async function start(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
  const session = new CameraSession(stream.getVideoTracks()[0]!);
  (window as unknown as { __sunroom: { session: CameraSession } }).__sunroom = { session };
  document.querySelector('video')!.srcObject = new MediaStream([session.track]);
  setInterval(() => {
    const s = session.status;
    info.textContent = `${s.width}x${s.height}, camera ${s.cameraFps.toFixed(1)} fps, ${s.processMs.toFixed(1)} ms per frame (${s.transport})`;
  }, 1000);
}

start().catch((err: Error) => {
  info.textContent = `Camera failed: ${err.message}`;
});

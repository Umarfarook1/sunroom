// Test call page: opens the camera like a call app and exposes probes on window.cam for the e2e test.
const video = document.querySelector('video');
const streams = [];
const frameUrl = new URLSearchParams(location.search).get('frame');
if (frameUrl) {
  const f = document.createElement('iframe');
  f.src = frameUrl;
  f.allow = 'camera';
  f.width = 420;
  f.height = 320;
  document.body.append(f);
}

const describe = (t) => ({
  label: t.label,
  readyState: t.readyState,
  settings: t.getSettings(),
  constraints: t.getConstraints(),
  capabilities: Object.keys(t.getCapabilities()),
});

async function luma() {
  await new Promise((resolve, reject) => {
    video.requestVideoFrameCallback(resolve);
    setTimeout(() => reject(new Error('no video frame for 3 s')), 3000);
  });
  const ctx = new OffscreenCanvas(96, 54).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 96, 54);
  const d = ctx.getImageData(32, 18, 32, 18).data; // centre ninth of the frame
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  return sum / (d.length / 4);
}

window.cam = {
  async open(constraints = { video: true, audio: false }) {
    const t0 = performance.now();
    const s = await navigator.mediaDevices.getUserMedia(constraints);
    const ms = Math.round(performance.now() - t0);
    streams.push(s);
    const v = s.getVideoTracks()[0];
    if (v) {
      video.srcObject = s;
      await video.play();
    }
    return { ms, audio: s.getAudioTracks().length, video: s.getVideoTracks().length, ...(v && describe(v)) };
  },
  track: (i = -1) => describe(streams.at(i).getVideoTracks()[0]),
  async cameras() {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').map((d) => ({ label: d.label, deviceId: d.deviceId, groupId: d.groupId }));
  },
  // the fake camera restarts its clip on every open; 136 frames cover whole loops of every test clip
  async luma(n = 136) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += await luma();
    return Math.round((sum / n) * 10) / 10;
  },
  size: () => [video.videoWidth, video.videoHeight],
  // counts frames on a clone, the way a second consumer (an encoder, a preview) would see them
  async count(ms) {
    const t = streams.at(-1).getVideoTracks()[0].clone();
    const reader = new MediaStreamTrackProcessor({ track: t }).readable.getReader();
    const visibility = [document.visibilityState];
    const t0 = performance.now();
    setTimeout(() => reader.cancel(), ms);
    let frames = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      value.close();
      frames++;
    }
    const seconds = (performance.now() - t0) / 1000;
    visibility.push(document.visibilityState);
    t.stop();
    return { fps: Math.round((frames / seconds) * 10) / 10, frames, seconds: Math.round(seconds * 10) / 10, visibility, cloneLabel: t.label };
  },
  apply: (c, i = -1) => streams.at(i).getVideoTracks()[0].applyConstraints(c),
  stopVideo: (i = -1) => streams.at(i).getVideoTracks()[0].stop(),
  stopAll: () => streams.forEach((s) => s.getTracks().forEach((t) => t.stop())),
};

// ?log: open the camera on load and record frames per second with the page's visibility, without timers
if (new URLSearchParams(location.search).has('log')) {
  window.perSecond = [];
  cam.open().then(async () => {
    const reader = new MediaStreamTrackProcessor({ track: streams[0].getVideoTracks()[0].clone() }).readable.getReader();
    const t0 = performance.now();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      value.close();
      const s = Math.floor((performance.now() - t0) / 1000);
      window.perSecond[s] ??= { frames: 0, visibility: document.visibilityState };
      window.perSecond[s].frames++;
    }
  });
}

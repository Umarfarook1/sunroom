import { CameraSession, createMediaPipeFaceTracker, type FaceTracker, type SessionStatus } from '../../../packages/core/src/index';
import { NO_FLOAT_TARGETS, NO_WEBGL2, PROBLEMS, type Problem, problemFrom, statusLine } from './words';

declare global {
  interface Window {
    __sunroom: { session: CameraSession | null };
  }
}

type View = { kind: 'waiting' } | { kind: 'live' } | { kind: 'untouched'; why: string } | { kind: 'problem'; problem: Problem };

const CAMERA_KEY = 'sunroom.camera';

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  viewer: el<HTMLElement>('viewer'),
  stage: el<HTMLElement>('stage'),
  enhanced: el<HTMLVideoElement>('enhanced'),
  original: el<HTMLVideoElement>('original'),
  split: el<HTMLInputElement>('split'),
  tagBefore: el<HTMLElement>('tag-before'),
  tagAfter: el<HTMLElement>('tag-after'),
  messageTitle: el<HTMLElement>('message-title'),
  messageBody: el<HTMLElement>('message-body'),
  retry: el<HTMLButtonElement>('retry'),
  status: el<HTMLElement>('status'),
  fps: el<HTMLElement>('fps'),
  ms: el<HTMLElement>('ms'),
  res: el<HTMLElement>('res'),
  enhance: el<HTMLInputElement>('enhance'),
  director: el<HTMLInputElement>('director'),
  compare: el<HTMLInputElement>('compare'),
  picker: el<HTMLElement>('camera-picker'),
  camera: el<HTMLSelectElement>('camera'),
  advanced: el<HTMLDetailsElement>('advanced'),
  advancedList: el<HTMLElement>('advanced-list'),
};

const asset = (p: string) => new URL(p, location.href).href;
// one detector for the page's lifetime; failing to load it only costs face metering
const tracker = createMediaPipeFaceTracker({ wasmBaseUrl: asset('mediapipe'), modelUrl: asset('models/blaze_face_short_range.tflite') }).catch((err) => {
  console.warn('[sunroom] face detector unavailable, metering the centre instead', err);
  return null;
});

let camera: MediaStreamTrack | null = null;
let session: CameraSession | null = null;
let generation = 0;
let droppedTo: number | null = null;
window.__sunroom = { session: null };

function show(view: View): void {
  document.body.dataset.view = view.kind;
  if (view.kind === 'waiting') {
    ui.messageTitle.textContent = 'Waiting for your camera';
    ui.messageBody.textContent = 'Allow camera access when your browser asks.';
    ui.retry.hidden = true;
  } else if (view.kind === 'problem') {
    const p = PROBLEMS[view.problem];
    ui.messageTitle.textContent = p.title;
    ui.messageBody.textContent = p.body;
    ui.retry.hidden = !p.retry;
  } else if (view.kind === 'untouched') {
    ui.status.textContent = view.why;
  }
}

async function release(): Promise<void> {
  const [s, c] = [session, camera];
  session = null;
  camera = null;
  window.__sunroom = { session: null };
  await s?.stop(); // puts the camera's own controls back before the track closes
  c?.stop();
}

function gpuProblem(): string | null {
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) return NO_WEBGL2;
  const ok = !!gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return ok ? null : NO_FLOAT_TARGETS;
}

async function start(): Promise<void> {
  const gen = ++generation;
  await release();
  show({ kind: 'waiting' });
  if (!navigator.mediaDevices?.getUserMedia) return show({ kind: 'problem', problem: 'insecure' });
  const saved = localStorage.getItem(CAMERA_KEY);
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: saved ? { ideal: saved } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    });
  } catch (err) {
    console.warn('[sunroom] camera did not open', err);
    if (gen === generation) show({ kind: 'problem', problem: problemFrom(err) });
    return;
  }
  const track = stream.getVideoTracks()[0]!;
  if (gen !== generation) return track.stop();
  camera = track;
  track.addEventListener('ended', () => {
    if (camera === track) show({ kind: 'problem', problem: 'ended' });
  });
  void listCameras(track);
  ui.original.srcObject = stream;
  void ui.original.play().catch(() => {});

  const why = gpuProblem();
  if (why) return show({ kind: 'untouched', why });
  const faceTracker = await tracker;
  if (gen !== generation) return;
  try {
    session = new CameraSession(track, { faceTracker, director: ui.director.checked });
  } catch (err) {
    console.error('[sunroom] could not start enhancing', err);
    return show({ kind: 'untouched', why: NO_WEBGL2 });
  }
  session.enabled = ui.enhance.checked;
  droppedTo = null;
  window.__sunroom = { session };
  ui.enhanced.srcObject = new MediaStream([session.track]);
  void ui.enhanced.play().catch(() => {});
  show({ kind: 'live' });
  tick();
}

async function listCameras(current: MediaStreamTrack): Promise<void> {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  const id = current.getSettings().deviceId;
  ui.camera.replaceChildren(...cams.map((d, i) => new Option(d.label || `Camera ${i + 1}`, d.deviceId, false, d.deviceId === id)));
  ui.picker.hidden = cams.length < 2;
}

const fixed = (n: number, digits = 2) => (n >= 0 ? '+' : '') + n.toFixed(digits);

function advancedRows(s: SessionStatus): [string, string][] {
  const d = s.frame?.decision;
  const st = s.frame?.stats;
  return [
    ['Face', s.face ? `Found, ${Math.round(s.face.w * 100)}% of the width` : 'Not found'],
    ['Brightening', d ? `${fixed(d.render.target - d.render.anchor)} stops` : '-'],
    ['Highlight compression', d ? d.render.cHi.toFixed(2) : '-'],
    ['Colour correction', d ? `red ${fixed(d.state.wbRG)}, blue ${fixed(d.state.wbBG)}` : '-'],
    ['Shadows and highlights', st ? `${(st.p02 * 100).toFixed(1)}% to ${(st.p98 * 100).toFixed(1)}%` : '-'],
    ['Sensor noise', st ? st.sigmaDark.toFixed(4) : '-'],
    ['Camera exposure', !ui.director.checked ? 'Left to the camera' : s.director.mode === 'manual' ? 'Set by Sunroom' : 'Camera automatic, watched'],
    ['Last camera change', s.director.lastReason ?? 'None yet'],
    ['Frame path', s.transport === 'streams' ? 'Insertable streams' : 'Canvas'],
    ['Load', `${Math.round(s.busy * 100)}% of each second spent enhancing`],
  ];
}

function tick(): void {
  if (!session) return;
  const s = session.status;
  if (s.error) {
    // the enhanced track has ended; the original camera underneath is still playing
    session = null;
    window.__sunroom = { session: null };
    return show({ kind: 'untouched', why: `Enhancing stopped (${s.error}). This is the picture your camera gives.` });
  }
  if (s.director.mode === 'observe') droppedTo = s.cameraFps;
  ui.status.textContent = statusLine(s, { enabled: session.enabled, director: session.director, droppedTo });
  ui.fps.textContent = `Camera ${Math.round(s.cameraFps)} fps`;
  ui.ms.textContent = `Processing ${s.processMs.toFixed(1)} ms`;
  ui.res.textContent = s.width ? `${s.width} × ${s.height}` : '';
  if (ui.advanced.open) {
    ui.advancedList.replaceChildren(
      ...advancedRows(s).map(([k, v]) => {
        const row = document.createElement('div');
        row.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
        return row;
      }),
    );
  }
}

function setSplit(): void {
  const v = Number(ui.split.value);
  ui.stage.style.setProperty('--split', `${v}%`);
  ui.split.setAttribute('aria-valuetext', `${v}% before, ${100 - v}% after`);
  ui.tagBefore.style.opacity = v > 12 ? '1' : '0';
  ui.tagAfter.style.opacity = v < 88 ? '1' : '0';
}

function setRatio(): void {
  const { videoWidth: w, videoHeight: h } = ui.original;
  if (w && h) ui.viewer.style.setProperty('--ratio', String(w / h));
}

ui.split.addEventListener('input', setSplit);
ui.compare.addEventListener('change', () => (ui.stage.dataset.compare = ui.compare.checked ? 'on' : 'off'));
ui.enhance.addEventListener('change', () => {
  if (session) session.enabled = ui.enhance.checked;
  tick();
});
ui.director.addEventListener('change', () => {
  if (session) session.director = ui.director.checked;
  tick();
});
ui.camera.addEventListener('change', () => {
  localStorage.setItem(CAMERA_KEY, ui.camera.value);
  void start();
});
ui.retry.addEventListener('click', () => void start());
ui.advanced.addEventListener('toggle', tick);
ui.original.addEventListener('loadedmetadata', setRatio);
ui.original.addEventListener('resize', setRatio);
navigator.mediaDevices?.addEventListener('devicechange', () => camera && void listCameras(camera));
addEventListener('pagehide', () => session?.stop());

setSplit();
setInterval(tick, 250);
void start();

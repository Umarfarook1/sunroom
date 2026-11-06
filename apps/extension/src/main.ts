// MAIN world: when a page asks for the camera, it gets Sunroom's enhanced video instead.
// Rule one: if anything here fails, the page gets the camera exactly as the browser gave it.
import { CameraSession, createMediaPipeFaceTracker, type FaceTracker } from '../../../packages/core/src/index';
import { statusLine } from '../../web/src/words';
import { type CameraReport, channel, HELLO, type PageSettings, READY } from './shared';

type Handled =
  | { kind: 'untouched'; camera: MediaStreamTrack }
  | { kind: 'failed'; camera: MediaStreamTrack; error: string }
  | { kind: 'session'; camera: MediaStreamTrack; session: CameraSession; face: CameraReport['face']; tracker: FaceTracker | null; release: () => void };

const nativeGetUserMedia = MediaDevices.prototype.getUserMedia;
const nativeStop = MediaStreamTrack.prototype.stop;
const nativeClone = MediaStreamTrack.prototype.clone;
const SETTINGS_WAIT_MS = 1000;
const FIRST_FRAME_MS = 3000;
const KEEP = 6;
const FALLBACK: PageSettings = { enabled: true, siteEnabled: true, director: true, assetBase: '' };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let settings: PageSettings | null = null;
let settingsArrived!: () => void;
const settingsReady = new Promise<void>((r) => (settingsArrived = r));
const handled: Handled[] = [];
const isOn = (s: PageSettings | null) => !s || (s.enabled && s.siteEnabled);

function apply(s: PageSettings): void {
  settings = s;
  settingsArrived();
  for (const h of handled) {
    if (h.kind !== 'session') continue;
    h.session.enabled = isOn(s);
    h.session.director = isOn(s) && s.director;
  }
}

function describe(h: Handled): CameraReport {
  const base = { camera: h.camera.readyState, face: 'centre' as const, fps: 0, ms: 0 };
  const off = settings?.enabled === false ? 'Sunroom is off.' : 'Sunroom is off on this site.';
  if (h.kind === 'failed') return { ...base, handling: 'untouched', note: `Sunroom could not start here (${h.error}), so the camera is untouched.` };
  if (h.kind === 'untouched') return { ...base, handling: 'untouched', note: isOn(settings) ? 'Turn the camera off and on again to use Sunroom.' : `${off} The camera is untouched.` };
  const st = h.session.status;
  if (st.error) return { ...base, handling: 'untouched', note: `Sunroom stopped (${st.error}), so the camera is shown as it is.` };
  if (!isOn(settings)) return { ...base, face: h.face, handling: 'paused', note: `${off} The camera is shown as it is.` };
  const fps = Math.round(st.cameraFps);
  const ms = Math.round(st.processMs * 10) / 10;
  // the same sentence the web app shows
  const what = statusLine(st, { enabled: true, director: h.session.director, droppedTo: null }).replace(/\.$/, '');
  return { camera: h.camera.readyState, handling: 'enhancing', face: h.face, fps, ms, note: `${what}. ${fps} fps, ${ms} ms per frame.` };
}

function remember(h: Handled): void {
  handled.push(h);
  while (handled.length > KEEP) {
    const i = handled.findIndex((x) => x.camera.readyState === 'ended');
    if (i < 0) break;
    handled.splice(i, 1);
  }
}

function onHello(e: Event): void {
  document.removeEventListener(HELLO, onHello);
  const ch = channel((e as CustomEvent<string>).detail);
  const report = () => document.dispatchEvent(new CustomEvent(ch.report, { detail: JSON.stringify(handled.map(describe)) }));
  document.addEventListener(ch.settings, (ev) => apply(JSON.parse((ev as CustomEvent<string>).detail) as PageSettings));
  document.addEventListener(ch.ask, report);
  report();
}
document.addEventListener(HELLO, onHello);
document.dispatchEvent(new CustomEvent(READY));
// a closing tab never calls stop(); hand the camera's controls back while the page can still send it
addEventListener('pagehide', () => {
  for (const h of handled) if (h.kind === 'session') h.release();
});

/** Resolves once the session has enhanced one frame; throws if it failed or stays silent. */
async function firstFrame(session: CameraSession): Promise<void> {
  const until = performance.now() + FIRST_FRAME_MS;
  for (;;) {
    if (session.status.error) throw new Error(session.status.error);
    if (session.status.frame) return;
    if (performance.now() > until) throw new Error('no enhanced frame within 3 s');
    await sleep(20);
  }
}

function trackFaces(h: Extract<Handled, { kind: 'session' }>, assetBase: string): void {
  if (!assetBase) {
    h.face = 'centre';
    return;
  }
  createMediaPipeFaceTracker({ wasmBaseUrl: `${assetBase}mediapipe`, modelUrl: `${assetBase}models/blaze_face_short_range.tflite` }).then(
    (tracker) => {
      if (h.session.track.readyState === 'ended') return tracker.close();
      h.session.faceTracker = h.tracker = tracker;
      h.face = 'tracking';
    },
    (err: unknown) => {
      // a strict page CSP blocks the WASM; the enhancer then meters the centre of the frame
      h.face = 'centre';
      console.info('[sunroom] face tracking is not available on this page; metering the centre', err);
    },
  );
}

/** Starts a session on the camera and returns its output dressed as the camera's own track. */
async function start(camera: MediaStreamTrack, s: PageSettings, asked: MediaTrackConstraints): Promise<MediaStreamTrack> {
  const live = new Set<MediaStreamTrack>();
  // registered before the session's own 'ended' listener, so the page's tracks end (and say so) first
  camera.addEventListener('ended', () => {
    for (const t of live) {
      nativeStop.call(t);
      t.dispatchEvent(new Event('ended'));
    }
    live.clear();
  });
  const session = new CameraSession(camera, { director: s.director });
  try {
    await firstFrame(session);
  } catch (err) {
    void session.stop();
    throw err;
  }
  let releasing = false;
  // session.stop() resolves once the camera's own controls are back, and calls the dressed stop() below on the way
  const release = () => {
    if (releasing) return;
    releasing = true;
    void session.stop().finally(() => {
      camera.stop();
      h.tracker?.close();
    });
  };
  const h: Extract<Handled, { kind: 'session' }> = { kind: 'session', camera, session, face: 'loading', tracker: null, release };
  remember(h);
  trackFaces(h, s.assetBase);

  let constraints = structuredClone(asked);
  const own = (value: unknown): PropertyDescriptor => ({ value, configurable: true, writable: true });
  const wear = (t: MediaStreamTrack): MediaStreamTrack => {
    if (t.readyState === 'live') live.add(t);
    Object.defineProperties(t, {
      label: { get: () => camera.label, configurable: true },
      getSettings: own(() => camera.getSettings()),
      getCapabilities: own(() => camera.getCapabilities()),
      getConstraints: own(() => structuredClone(constraints)),
      applyConstraints: own(async (c: MediaTrackConstraints = {}) => {
        await camera.applyConstraints(c);
        constraints = structuredClone(c);
      }),
      clone: own(() => wear(nativeClone.call(t))),
      stop: own(() => {
        nativeStop.call(t);
        live.delete(t);
        // the camera light goes off with the last of the page's copies
        if (!live.size) release();
      }),
    });
    return t;
  };
  return wear(session.track);
}

async function enhance(stream: MediaStream, camera: MediaStreamTrack, constraints: MediaStreamConstraints | undefined): Promise<MediaStream> {
  await Promise.race([settingsReady, sleep(SETTINGS_WAIT_MS)]);
  const s = settings ?? FALLBACK;
  if (!isOn(s)) {
    remember({ kind: 'untouched', camera });
    return stream;
  }
  const out = await start(camera, s, typeof constraints?.video === 'object' ? constraints.video : {});
  return new MediaStream(stream.getTracks().map((t) => (t === camera ? out : t)));
}

MediaDevices.prototype.getUserMedia = async function getUserMedia(this: MediaDevices, constraints?: MediaStreamConstraints): Promise<MediaStream> {
  const stream = await nativeGetUserMedia.call(this, constraints);
  const camera = stream.getVideoTracks()[0];
  // audio only, or a screen asked for through legacy getUserMedia constraints
  if (!camera || 'displaySurface' in camera.getSettings()) return stream;
  try {
    return await enhance(stream, camera, constraints);
  } catch (err) {
    remember({ kind: 'failed', camera, error: err instanceof Error ? err.message : String(err) });
    console.warn('[sunroom] left the camera untouched:', err);
    return stream;
  }
};

type LegacyGetUserMedia = (c: MediaStreamConstraints, ok: (s: MediaStream) => void, fail: (e: unknown) => void) => void;
const legacy = Navigator.prototype as unknown as Record<string, LegacyGetUserMedia | undefined>;
for (const name of ['getUserMedia', 'webkitGetUserMedia']) {
  if (typeof legacy[name] !== 'function') continue;
  legacy[name] = function (this: Navigator, c, ok, fail) {
    this.mediaDevices.getUserMedia(c).then(ok, fail);
  };
}

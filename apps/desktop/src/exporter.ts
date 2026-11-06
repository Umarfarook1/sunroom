// Injected by the main process into whichever page the window shows (the web UI or the built-in page).
// While the virtual camera wants frames, it hands each enhanced frame from window.__sunroom.session.track to a
// worker that converts and posts it to the main process; otherwise it reads nothing. It also shows the camera state.

declare const MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<VideoFrame> };

type FromWorker =
  | { type: 'state'; state: string; text: string; pump: boolean; camera: boolean; setup: boolean }
  | { type: 'took'; stats: object };

const MAX_QUEUED = 2; // frames waiting in the worker; each one holds a camera buffer
/** The worker's running totals, plus frames this page dropped because the worker was behind. */
const stats = { pageDropped: 0, startedAt: 0 };
(window as unknown as { __sunroomExport: typeof stats }).__sunroomExport = stats;

const worker = new Worker('/__sunroom/export-worker.js');
let sending = false;
let pumping = false;
let queued = 0;

const badge = document.createElement('div');
badge.id = 'sunroom-vcam';
badge.setAttribute('role', 'status');
Object.assign(badge.style, {
  position: 'fixed', left: '8px', bottom: '8px', maxWidth: 'calc(100% - 16px)', zIndex: '2147483647', padding: '6px 10px', borderRadius: '6px',
  font: '12px/1.4 system-ui, sans-serif', color: '#f4f4f4', background: 'rgba(0, 0, 0, 0.7)', userSelect: 'text', overflowWrap: 'anywhere',
});
const text = document.createElement('span');
const setup = Object.assign(document.createElement('button'), { textContent: 'Set up Sunroom Camera', hidden: true });
Object.assign(setup.style, { marginLeft: '8px', font: 'inherit', padding: '2px 8px', cursor: 'pointer' });
setup.addEventListener('click', () => {
  setup.disabled = true; // until the main process answers with a new state
  worker.postMessage({ type: 'setup' });
});
badge.append(text, setup);
document.body.append(badge);

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin || e.data !== 'sunroom:port' || !e.ports[0]) return;
  worker.postMessage({ type: 'port', port: e.ports[0] }, [e.ports[0]]);
});
worker.onerror = (e) => console.error('[sunroom] frame export worker failed:', e.message);

worker.onmessage = ({ data }: MessageEvent<FromWorker>) => {
  if (data.type === 'took') {
    queued--;
    Object.assign(stats, data.stats);
    return;
  }
  text.textContent = data.text;
  badge.dataset.state = data.state;
  setup.hidden = !data.setup;
  setup.disabled = false;
  // the page owns the camera; this tells it when nothing shows or reads the picture
  window.dispatchEvent(new CustomEvent('sunroom:camera', { detail: data.camera }));
  sending = data.pump;
  if (sending) void pump();
  else worker.postMessage({ type: 'stop' });
};

function sessionTrack(): MediaStreamTrack | undefined {
  return (window as unknown as { __sunroom?: { session?: { track?: MediaStreamTrack } } }).__sunroom?.session?.track;
}

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (sending) {
      const track = sessionTrack();
      if (track?.readyState === 'live') await exportFrom(track);
      else await new Promise((r) => setTimeout(r, 250));
    }
  } finally {
    pumping = false;
  }
}

async function exportFrom(track: MediaStreamTrack): Promise<void> {
  const copy = track.clone(); // ending a processor's input must never end the page's own track
  const reader = new MediaStreamTrackProcessor({ track: copy, maxBufferSize: 1 }).readable.getReader();
  stats.startedAt ||= performance.now();
  try {
    while (sending && sessionTrack() === track) {
      const { value: frame, done } = await reader.read();
      if (done) return;
      if (queued >= MAX_QUEUED) {
        frame.close();
        stats.pageDropped++;
        continue;
      }
      queued++;
      worker.postMessage({ type: 'frame', frame }, [frame]);
    }
  } finally {
    reader.cancel().catch(() => {});
    copy.stop();
  }
}

export {}; // a module, so its top-level names stay its own

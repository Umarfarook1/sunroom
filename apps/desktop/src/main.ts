// Sunroom desktop: one window running the web UI, whose enhanced frames feed a system virtual camera
// that native apps (Zoom, Teams, Discord, OBS) can pick.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, MessageChannelMain, type MessagePortMain, type NativeImage, Tray, app, nativeImage, net, protocol, session } from 'electron';
import type { VirtualCameraOutput, VirtualCameraState } from './vcam/output';
import { UnityCaptureOutput } from './vcam/unity-capture';

const fakeCamera = process.env.SUNROOM_FAKE_CAMERA;
if (fakeCamera) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-video-capture', fakeCamera);
}

const webDist = path.join(__dirname, '../../web/dist');
// The shared web UI once it is built, otherwise this app's own minimal page.
const pageRoot = fs.existsSync(path.join(webDist, 'index.html')) ? webDist : path.join(__dirname, 'page');
const ORIGIN = 'sunroom://app';
const isOwn = (url: string) => url.startsWith(`${ORIGIN}/`);
const registerScript = path.join(app.getAppPath(), 'tools', 'register-virtual-camera.ps1');

const STATE_TEXT: Record<VirtualCameraState, string> = {
  'not-installed': `Virtual camera not installed. To try it (per-user, unverified), run: powershell -ExecutionPolicy Bypass -File "${registerScript}" -Install`,
  waiting: 'Virtual camera ready. Waiting for an app to open "Sunroom Camera".',
  sending: 'Sending to an app that opened "Sunroom Camera".',
  unsupported: 'No virtual camera on this OS yet. See apps/desktop/PLATFORMS.md.',
};

protocol.registerSchemesAsPrivileged([{ scheme: 'sunroom', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) app.exit(0); // two senders would interleave frames on the one camera

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let port: MessagePortMain | null = null;
let vcam: VirtualCameraOutput | null = null;
let quitting = false;

const onState = (state: VirtualCameraState) => {
  port?.postMessage({ type: 'state', state, text: STATE_TEXT[state] });
  tray?.setToolTip(`Sunroom: ${STATE_TEXT[state]}`);
};

interface FrameMessage {
  type: 'frame';
  width: number;
  height: number;
  data: ArrayBuffer;
  sentAt: number;
}

/** Gives the page a fresh port: frames come in, virtual camera state and per-frame acks go out. */
function connectPage(w: BrowserWindow): void {
  port?.close();
  const { port1, port2 } = new MessageChannelMain();
  port = port1;
  port1.on('message', ({ data }: { data: FrameMessage }) => {
    if (data?.type !== 'frame') return;
    const t0 = performance.now();
    try {
      vcam?.send({ width: data.width, height: data.height, data: new Uint8Array(data.data) });
    } catch (err) {
      console.error('[sunroom] virtual camera dropped a frame:', err);
    }
    port1.postMessage({ type: 'ack', mainMs: performance.now() - t0, transitMs: performance.timeOrigin + t0 - data.sentAt });
  });
  port1.start();
  w.webContents.postMessage('sunroom:port', null, [port2]);
  if (vcam) onState(vcam.state);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1000,
    height: 780,
    title: 'Sunroom',
    backgroundColor: '#101010',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // keep enhancing and sending while hidden or minimised
    },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e, url) => {
    if (!isOwn(url)) e.preventDefault();
  });
  const exporter = fs.readFileSync(path.join(__dirname, 'exporter.js'), 'utf8');
  w.webContents.on('did-finish-load', () => {
    // install the exporter's listener first, then hand it the port
    w.webContents.executeJavaScript(exporter).then(() => connectPage(w), (err) => console.error('[sunroom] exporter failed:', err));
  });
  w.on('close', (e) => {
    if (quitting || !tray) return;
    e.preventDefault(); // the camera keeps feeding other apps from the tray
    w.hide();
  });
  void w.loadURL(`${ORIGIN}/index.html`);
  return w;
}

/** A 16x16 amber disc, so the tray needs no image file. */
function trayIcon(): NativeImage {
  const size = 16;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) < size * 0.42) px.set([0x2a, 0xb4, 0xff, 0xff], (y * size + x) * 4); // BGRA
    }
  }
  return nativeImage.createFromBitmap(px, { width: size, height: size });
}

app.on('second-instance', () => {
  win?.show();
  win?.focus();
});
app.on('before-quit', () => {
  quitting = true;
});
app.on('will-quit', () => vcam?.close());

void app.whenReady().then(() => {
  vcam = process.platform === 'win32' ? new UnityCaptureOutput(onState) : { state: 'unsupported', send() {}, close() {} };
  protocol.handle('sunroom', (req) => {
    const { pathname } = new URL(req.url);
    // served from the page's own origin so any page CSP that allows 'self' allows the worker
    if (pathname === '/__sunroom/export-worker.js') return net.fetch(pathToFileURL(path.join(__dirname, 'export-worker.js')).toString());
    const file = path.join(pageRoot, decodeURIComponent(pathname));
    if (!file.startsWith(pageRoot + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  const ses = session.defaultSession;
  ses.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    callback(permission === 'media' && isOwn(details.requestingUrl) && !mediaTypes.includes('audio'));
  });
  // Chromium passes "sunroom://app/" here, and a "no" ends the live camera track
  ses.setPermissionCheckHandler((_wc, permission, origin) => permission === 'media' && isOwn(origin));

  win = createWindow();
  tray = new Tray(trayIcon());
  const toggle = () => (win?.isVisible() ? win.hide() : win?.show());
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggle },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', toggle);
  onState(vcam.state);
});

// Sunroom desktop: one window running the web UI, whose enhanced frames feed a system virtual camera
// that native apps (Zoom, Teams, Discord, OBS) can pick.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, Menu, MessageChannelMain, type MessagePortMain, type NativeImage, Tray, app, nativeImage, net, protocol, session } from 'electron';
import type { VirtualCameraOutput, VirtualCameraState } from './vcam/output';
import { UnityCaptureOutput } from './vcam/unity-capture';
import { V4l2FfmpegOutput } from './vcam/v4l2-ffmpeg';

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
const filterDir = path.join(app.getAppPath(), 'vendor', 'unitycapture');

const STATE_TEXT: Record<VirtualCameraState, string> = {
  'not-installed': 'Other apps cannot see "Sunroom Camera" yet.',
  waiting: 'Virtual camera ready. Waiting for an app to open "Sunroom Camera".',
  sending: 'Sending to an app that opened "Sunroom Camera".',
  unsupported: 'No virtual camera on this OS yet. See apps/desktop/PLATFORMS.md.',
  // v4l2loopback never tells the sender whether an app is reading, so Linux can only say whether frames flow
  ...(process.platform === 'linux' && {
    'not-installed': 'Virtual camera not set up. Install ffmpeg, then run once: sudo modprobe v4l2loopback video_nr=10 card_label="Sunroom Camera" exclusive_caps=1. Your user needs write access to /dev/video10 (usually the video group).',
    waiting: 'Virtual camera ready. Starting ffmpeg for "Sunroom Camera".',
    sending: 'Sending to "Sunroom Camera". Any app can open it.',
  }),
};

protocol.registerSchemesAsPrivileged([{ scheme: 'sunroom', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

if (!app.requestSingleInstanceLock()) app.exit(0); // two senders would interleave frames on the one camera

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let port: MessagePortMain | null = null;
let vcam: VirtualCameraOutput | null = null;
let quitting = false;

// Windows hears when an app starts reading. v4l2loopback never says, so Linux feeds the device whenever it is set up.
const wantsFrames = (state: VirtualCameraState) => state === 'sending' || (process.platform === 'linux' && state === 'waiting');

const RELEASE_AFTER_MS = 5000;
let cameraOn = true;
let letGo: NodeJS.Timeout | null = null;
let setupNote: string | null = null;
let setupRunning = false;

/** Tells the page what the virtual camera is doing and whether anything needs the real camera right now. */
function tell(): void {
  const state = vcam?.state ?? 'unsupported';
  const wanted = (!!win && win.isVisible() && !win.isMinimized()) || wantsFrames(state);
  if (wanted) {
    if (letGo) clearTimeout(letGo);
    letGo = null;
    cameraOn = true;
  } else if (cameraOn && !letGo) {
    // not at once: an app that reopens the camera within a few seconds should not find it cold
    letGo = setTimeout(() => {
      letGo = null;
      cameraOn = false;
      tell();
    }, RELEASE_AFTER_MS);
  }
  const text = setupNote ?? STATE_TEXT[state];
  port?.postMessage({ type: 'state', state, text, pump: wantsFrames(state), camera: cameraOn, setup: process.platform === 'win32' && state === 'not-installed' && !setupRunning });
  tray?.setToolTip(`Sunroom: ${text}`.slice(0, 127)); // Windows cuts tray tooltips at 127 characters
}

const onState = () => {
  setupNote = null;
  tell();
};

/** Adds or removes "Sunroom Camera" for this Windows user. The backend's own poll notices the change. */
function registerCamera(flag: '-Install' | '-Uninstall'): void {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', registerScript, flag, '-Yes', ...(flag === '-Install' ? ['-SourceDir', filterDir] : [])];
  if (setupRunning) return;
  setupRunning = true;
  setupNote = flag === '-Install' ? 'Setting up "Sunroom Camera"...' : 'Removing "Sunroom Camera"...';
  tell();
  execFile('powershell.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
    setupRunning = false;
    setupNote = null;
    if (!err) return tell();
    console.error('[sunroom] camera setup failed:', stdout, stderr);
    const why = [...stderr.split(/\r?\n/), ...stdout.split(/\r?\n/)].map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ') || err.message;
    setupNote = `Could not ${flag === '-Install' ? 'set up' : 'remove'} "Sunroom Camera": ${why}`;
    tell();
  });
}

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
  port1.on('message', ({ data }: { data: FrameMessage | { type: 'setup' } }) => {
    if (data?.type === 'setup' && process.platform === 'win32' && vcam?.state === 'not-installed') return registerCamera('-Install');
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
  tell();
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
  // the real camera is let go while nobody looks at the picture and no app reads the virtual camera
  for (const event of ['show', 'hide', 'minimize', 'restore'] as const) w.on(event as 'show', tell);
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
  vcam = process.platform === 'win32' ? new UnityCaptureOutput(onState)
    : process.platform === 'linux' ? new V4l2FfmpegOutput(onState)
    : { state: 'unsupported', send() {}, close() {} };
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
    { label: 'Remove Sunroom Camera from this PC', visible: process.platform === 'win32', click: () => registerCamera('-Uninstall') },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', toggle);
  tell();
  // repeated, so a page whose camera failed to open (another program held it) tries again while it is wanted
  setInterval(tell, 3000);
});

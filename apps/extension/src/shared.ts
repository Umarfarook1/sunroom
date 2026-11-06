// Shapes shared by the popup, the ISOLATED-world script and the MAIN-world script.

/** What the user chose, as stored in chrome.storage.local. */
export interface Settings {
  enabled: boolean;
  director: boolean;
  /** Top-level hostnames where Sunroom leaves the camera alone. */
  disabledSites: string[];
}

export const DEFAULTS: Settings = { enabled: true, director: true, disabledSites: [] };

/** What the MAIN-world script needs to know about this page. */
export interface PageSettings {
  enabled: boolean;
  siteEnabled: boolean;
  director: boolean;
  /** chrome-extension://<id>/ : MAIN-world code has no chrome.runtime to ask. */
  assetBase: string;
}

export interface CameraReport {
  /** readyState of the real camera track. */
  camera: MediaStreamTrackState;
  handling: 'enhancing' | 'paused' | 'untouched';
  face: 'tracking' | 'loading' | 'centre';
  fps: number;
  ms: number;
  /** One plain-language line for the popup. */
  note: string;
}

// Settings and reports travel as DOM events whose names carry a nonce. Both content scripts run
// before any page script, so the page never sees the handshake and cannot forge either direction.
export const HELLO = 'sunroom:hello';
export const READY = 'sunroom:ready';
export const channel = (nonce: string) => ({
  settings: `sunroom:${nonce}:settings`,
  ask: `sunroom:${nonce}:ask`,
  report: `sunroom:${nonce}:report`,
});

/** Hostname of the tab's top-level page, also from inside an iframe. Empty when unknown. */
export function topSite(): string {
  const ancestors = location.ancestorOrigins;
  try {
    return new URL(ancestors?.[ancestors.length - 1] ?? location.href).hostname;
  } catch {
    return '';
  }
}

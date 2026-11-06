// ISOLATED world: owns chrome.storage and the popup's messages, relays both to the MAIN-world script.
import { type CameraReport, channel, DEFAULTS, HELLO, type PageSettings, READY, type Settings, topSite } from './shared';

const site = topSite();
const nonce = crypto.randomUUID();
const ch = channel(nonce);
let cameras: CameraReport[] = [];

const hello = () => document.dispatchEvent(new CustomEvent(HELLO, { detail: nonce }));
document.addEventListener(ch.report, (e) => {
  cameras = JSON.parse((e as CustomEvent<string>).detail) as CameraReport[];
  // the MAIN script answered, so the handshake is done; a late READY must not leak the nonce to the page
  document.removeEventListener(READY, hello);
});
// whichever content script runs second completes the handshake
document.addEventListener(READY, hello, { once: true });
hello();

async function push(): Promise<void> {
  const s = (await chrome.storage.local.get(DEFAULTS)) as Settings;
  const page: PageSettings = { enabled: s.enabled, siteEnabled: !s.disabledSites.includes(site), director: s.director, assetBase: chrome.runtime.getURL('') };
  document.dispatchEvent(new CustomEvent(ch.settings, { detail: JSON.stringify(page) }));
}
void push();
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') void push();
});

const refresh = () => document.dispatchEvent(new CustomEvent(ch.ask)); // the MAIN script answers synchronously
chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply) => {
  // sent to the top frame only
  if (msg.type === 'sunroom:top') {
    refresh();
    reply({ site, cameras });
  }
  // sent to every frame; only one with a live camera answers, so the first answer is the one that matters
  if (msg.type === 'sunroom:live') {
    refresh();
    if (cameras.some((c) => c.camera === 'live')) reply(cameras);
  }
});

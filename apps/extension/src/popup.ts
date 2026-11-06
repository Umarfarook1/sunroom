import { type CameraReport, DEFAULTS, type Settings } from './shared';

const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const master = input('enabled');
const siteSwitch = input('site');
const director = input('director');
const siteName = document.getElementById('site-name')!;
const status = document.getElementById('status')!;

async function main(): Promise<void> {
  // ?tab= lets a test open this page in a tab of its own and point it at another tab
  const tabId = Number(new URLSearchParams(location.search).get('tab')) || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  // null: no content script here (browser pages, the extension store)
  const site: string | null =
    tabId === undefined ? null : await chrome.tabs.sendMessage(tabId, { type: 'sunroom:top' }, { frameId: 0 }).then((r: { site: string }) => r.site, () => null);
  siteName.textContent = site || 'Not available on this page';

  const render = async () => {
    const s = (await chrome.storage.local.get(DEFAULTS)) as Settings;
    master.checked = s.enabled;
    director.checked = s.director;
    siteSwitch.checked = !!site && !s.disabledSites.includes(site);
    siteSwitch.disabled = !s.enabled || !site;
    director.disabled = !s.enabled;
  };
  master.onchange = () => chrome.storage.local.set({ enabled: master.checked });
  director.onchange = () => chrome.storage.local.set({ director: director.checked });
  siteSwitch.onchange = async () => {
    const { disabledSites } = (await chrome.storage.local.get(DEFAULTS)) as Settings;
    const others = disabledSites.filter((h) => h !== site);
    await chrome.storage.local.set({ disabledSites: siteSwitch.checked ? others : [...others, site!] });
  };
  chrome.storage.onChanged.addListener(() => void render());
  await render();

  const poll = async () => {
    if (tabId === undefined || site === null) {
      status.textContent = 'Sunroom cannot run on this page.';
      return;
    }
    // frames without a live camera stay silent, so no answer at all means none
    const cameras = (await chrome.tabs.sendMessage(tabId, { type: 'sunroom:live' }).catch(() => [])) as CameraReport[];
    status.textContent = cameras.filter((c) => c.camera === 'live').at(-1)?.note ?? 'No camera in use on this tab.';
  };
  await poll();
  setInterval(poll, 1000);
}
void main();

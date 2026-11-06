// The whole bridge: hand the page one MessagePort to the main process. No Node or Electron API reaches the page.
import { ipcRenderer } from 'electron';

ipcRenderer.on('sunroom:port', (event) => window.postMessage('sunroom:port', location.origin, event.ports));

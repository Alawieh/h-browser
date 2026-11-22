// Runs in every tab, but only gives the browser's own pages (hb://history,
// hb://downloads, hb://settings) a way to talk to the browser. Normal websites
// get nothing. The main process checks the page address again on every call.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'hb:') {
  contextBridge.exposeInMainWorld('hb', {
    call: (op, arg) => ipcRenderer.invoke('hb-page', op, arg),
  });
}

const { contextBridge, ipcRenderer } = require('electron');

const allowed = ['navigate', 'back', 'forward', 'reload', 'stop', 'home', 'new-tab', 'close-tab', 'switch-tab', 'toggle-blocking', 'ui-ready'];

contextBridge.exposeInMainWorld('browser', {
  send: (channel, data) => {
    if (allowed.includes(channel)) ipcRenderer.send(channel, data);
  },
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFocusAddress: (cb) => ipcRenderer.on('focus-address', () => cb()),
});

const { contextBridge, ipcRenderer } = require('electron');

const allowed = [
  'navigate', 'back', 'forward', 'reload', 'stop', 'home', 'new-tab', 'close-tab', 'switch-tab', 'move-tab', 'toggle-mute',
  'ui-ready', 'tool-unwall', 'tool-hide', 'tool-screenshot', 'open-screenshots', 'auto-walls-on', 'toggle-auto-walls',
  'toggle-bookmark', 'open-bookmark', 'find', 'find-close', 'zoom-reset', 'open-downloads', 'open-settings',
  'open-last-download', 'install-update', 'main-menu', 'shield-menu', 'tab-menu', 'bookmark-menu', 'bookmarks-overflow',
];

contextBridge.exposeInMainWorld('browser', {
  send: (channel, data) => {
    if (allowed.includes(channel)) ipcRenderer.send(channel, data);
  },
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onFocusAddress: (cb) => ipcRenderer.on('focus-address', () => cb()),
  onFocusFind: (cb) => ipcRenderer.on('focus-find', () => cb()),
  onToast: (cb) => ipcRenderer.on('toast', (_e, t) => cb(t)),
});

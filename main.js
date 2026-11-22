const { app, BaseWindow, WebContentsView, session, ipcMain, Menu, clipboard, ClipboardItem, shell } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fetch = require('cross-fetch');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');
const hider = require('./hider');

const TOOLBAR_HEIGHT = 84;
const HOME = 'https://www.google.com';
const TEST_URL = process.env.BROWSER_TEST_URL; // optional: open this URL on start (for testing)

let win, ui, browsingSession, blocker;
let videoFullscreen = false; // a page (e.g. a video player) asked for fullscreen
let f11Fullscreen = false;   // user pressed F11
let blockingEnabled = true;
let blockedTotal = 0;
const tabs = new Map(); // id -> { view, blocked }
let activeId = null;
let nextId = 1;

function send(channel, data) {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send(channel, data);
}

function tabInfo(id) {
  const t = tabs.get(id);
  const wc = t.view.webContents;
  return {
    id,
    title: wc.getTitle() || 'New Tab',
    url: wc.getURL(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    blocked: t.blocked,
    autoWalls: !!(t.tools && t.tools.isAuto()),
    active: id === activeId,
  };
}

function pushState() {
  send('state', {
    tabs: [...tabs.keys()].map(tabInfo),
    activeId,
    blockingEnabled,
    blockerReady: !!blocker,
    blockedTotal,
  });
}

function layout() {
  const { width, height } = win.getContentBounds();
  // In fullscreen the toolbar is hidden and the page fills the whole screen.
  const top = videoFullscreen || f11Fullscreen ? 0 : TOOLBAR_HEIGHT;
  ui.setVisible(top > 0);
  ui.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  for (const [id, t] of tabs) {
    t.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
    t.view.setVisible(id === activeId);
  }
}

function setF11(on) {
  f11Fullscreen = on;
  if (!videoFullscreen) win.setFullScreen(on);
  layout();
}

function normalizeInput(input) {
  const text = input.trim();
  if (!text) return HOME;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(text) || /^localhost(:\d+)?(\/.*)?$/.test(text)) {
    return 'https://' + text;
  }
  return 'https://www.google.com/search?q=' + encodeURIComponent(text);
}

function isBlockedPopup(url, sourceUrl, msSinceInput) {
  if (!blockingEnabled) return false;
  let reason = null;
  if (msSinceInput > 1000) reason = 'no user click';
  else if (blocker) {
    const { match } = blocker.match(Request.fromRawDetails({ url, sourceUrl, type: 'popup' }));
    if (match) reason = 'ad filter';
  }
  if (!reason) return false;
  blockedTotal++;
  console.log(`[popup blocked: ${reason}]`, url);
  pushState();
  return true;
}

function createTab(url = HOME) {
  const id = nextId++;
  const view = new WebContentsView({
    webPreferences: {
      session: browsingSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  tabs.set(id, { view, blocked: 0 });
  win.contentView.addChildView(view);

  const wc = view.webContents;
  // Remember when the user last clicked/typed in this tab, so we can tell
  // user-initiated popups (allowed) from script-spawned ones (blocked).
  let lastInput = 0;
  wc.on('input-event', (_e, input) => {
    if (['mouseDown', 'mouseUp', 'keyDown', 'rawKeyDown', 'char', 'gestureTap'].includes(input.type)) lastInput = Date.now();
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !isBlockedPopup(url, wc.getURL(), Date.now() - lastInput)) {
      lastInput = 0; // one popup per click
      createTab(url);
    }
    return { action: 'deny' };
  });
  for (const ev of ['did-start-loading', 'did-stop-loading', 'page-title-updated', 'did-navigate', 'did-navigate-in-page']) {
    wc.on(ev, pushState);
  }
  wc.on('enter-html-full-screen', () => {
    videoFullscreen = true;
    win.setFullScreen(true);
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    videoFullscreen = false;
    if (!f11Fullscreen) win.setFullScreen(false);
    layout();
  });
  // Esc leaves F11 fullscreen (video fullscreen handles Esc itself).
  wc.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && f11Fullscreen && !videoFullscreen) {
      e.preventDefault();
      setF11(false);
    }
  });
  wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      tabs.get(id).blocked = 0;
      pushState();
    }
  });

  tabs.get(id).tools = hider.attach(wc, { createTab, onScreenshot: takeScreenshot, onToast: toast, onChange: pushState });

  wc.loadURL(url);
  switchTab(id);
  return id;
}

function switchTab(id) {
  if (!tabs.has(id)) return;
  activeId = id;
  layout();
  tabs.get(id).view.webContents.focus();
  pushState();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  tabs.delete(id);
  if (tabs.size === 0) return createTab();
  if (activeId === id) activeId = [...tabs.keys()].pop();
  switchTab(activeId);
}

function activeWC() {
  const t = tabs.get(activeId);
  return t && t.view.webContents;
}

function toast(text, action) {
  send('toast', { text, action });
}

function activeTools() {
  const t = tabs.get(activeId);
  return t && t.tools;
}

const screenshotDir = () => path.join(app.getPath('pictures'), 'Hussein Browser');
let lastScreenshot = null;

// Saves the visible page as a PNG in Pictures\Hussein Browser and copies it to the clipboard.
async function takeScreenshot() {
  const wc = activeWC();
  if (!wc) return null;
  let img;
  try { img = await wc.capturePage(); } catch (e) {
    console.error('[screenshot] failed:', e.message);
    toast('Screenshot failed. Is the window minimized?');
    return null;
  }
  if (img.isEmpty()) { toast('Screenshot failed: page is empty.'); return null; }
  let host = 'page';
  try { host = new URL(wc.getURL()).hostname.replace(/^www\./, '') || 'page'; } catch {}
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(screenshotDir(), `${host}_${stamp}.png`);
  await fs.mkdir(screenshotDir(), { recursive: true });
  await fs.writeFile(file, img.toPNG());
  clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })])
    .catch((e) => console.error('[screenshot] clipboard failed:', e.message));
  lastScreenshot = file;
  toast('Screenshot saved and copied. Click to open folder.', 'open-screenshots');
  console.log('[screenshot]', file);
  return file;
}

async function initBlocker() {
  const cache = path.join(app.getPath('userData'), 'adblock-engine.bin');
  try {
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: cache,
      read: fs.readFile,
      write: fs.writeFile,
    });
  } catch (err) {
    console.error('[adblock] failed to load filter lists, blocking is OFF:', err.message);
    pushState();
    return;
  }

  blocker.on('request-blocked', (request) => {
    blockedTotal++;
    for (const t of tabs.values()) {
      if (!t.view.webContents.isDestroyed() && t.view.webContents.id === request.tabId) {
        t.blocked++;
        break;
      }
    }
    console.log('[blocked]', request.url);
    pushState();
  });

  if (blockingEnabled) blocker.enableBlockingInSession(browsingSession);
  console.log('[adblock] ready');
  pushState();
}

function setBlocking(on) {
  blockingEnabled = on;
  if (blocker) {
    if (on) blocker.enableBlockingInSession(browsingSession);
    else blocker.disableBlockingInSession(browsingSession);
  }
  pushState();
  const wc = activeWC();
  if (wc) wc.reload();
}

ipcMain.on('navigate', (_e, input) => activeWC()?.loadURL(normalizeInput(input)));
ipcMain.on('back', () => activeWC()?.navigationHistory.goBack());
ipcMain.on('forward', () => activeWC()?.navigationHistory.goForward());
ipcMain.on('reload', () => activeWC()?.reload());
ipcMain.on('stop', () => activeWC()?.stop());
ipcMain.on('home', () => activeWC()?.loadURL(HOME));
ipcMain.on('new-tab', () => createTab());
ipcMain.on('close-tab', (_e, id) => closeTab(id));
ipcMain.on('switch-tab', (_e, id) => switchTab(id));
ipcMain.on('toggle-blocking', () => setBlocking(!blockingEnabled));
ipcMain.on('ui-ready', pushState);
ipcMain.on('tool-unwall', () => activeTools()?.unwall());
ipcMain.on('tool-hide', () => activeTools()?.pickMode());
ipcMain.on('tool-screenshot', () => takeScreenshot());
ipcMain.on('auto-walls-on', () => activeTools()?.setAutoWalls(true));
ipcMain.on('toggle-auto-walls', () => { const t = activeTools(); if (t) t.setAutoWalls(!t.isAuto()); });
ipcMain.on('open-screenshots', () => (lastScreenshot ? shell.showItemInFolder(lastScreenshot) : shell.openPath(screenshotDir())));

function buildMenu() {
  // Hidden menu that provides keyboard shortcuts.
  const menu = Menu.buildFromTemplate([
    {
      label: 'Browser',
      submenu: [
        { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => { ui.webContents.focus(); send('focus-address'); } },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => activeWC()?.reload() },
        { label: 'Reload', accelerator: 'F5', visible: false, click: () => activeWC()?.reload() },
        { label: 'Back', accelerator: 'Alt+Left', click: () => activeWC()?.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => activeWC()?.navigationHistory.goForward() },
        { label: 'Full Screen', accelerator: 'F11', click: () => setF11(!f11Fullscreen) },
        { label: 'Developer Tools', accelerator: 'F12', click: () => activeWC()?.toggleDevTools() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

app.setAppUserModelId('com.alawieh.husseinbrowser');
// Keep rendering when the window is covered, so screenshots never come back blank.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(async () => {
  browsingSession = session.fromPartition('persist:browser');

  win = new BaseWindow({ width: 1280, height: 850, title: 'Hussein Browser', autoHideMenuBar: true, backgroundColor: '#1f2023', icon: path.join(__dirname, 'ui', 'icon.png') });
  ui = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(ui);
  ui.webContents.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', () => {
    // Window left fullscreen some other way (e.g. Windows shortcut): restore the toolbar.
    if (f11Fullscreen || videoFullscreen) {
      f11Fullscreen = false;
      if (videoFullscreen) activeWC()?.executeJavaScript('document.fullscreenElement && document.exitFullscreen()').catch(() => {});
    }
    layout();
  });
  win.on('closed', () => app.quit());
  buildMenu();

  // Start the blocker before the first tab loads so the first page is filtered too.
  await initBlocker();
  createTab(TEST_URL || HOME);
  layout();

  if (process.env.BROWSER_SCREENSHOT) {
    setTimeout(async () => {
      const img = await activeWC().capturePage();
      const bar = await ui.webContents.capturePage();
      await fs.writeFile(process.env.BROWSER_SCREENSHOT, img.toPNG());
      await fs.writeFile(process.env.BROWSER_SCREENSHOT.replace(/\.png$/, '-toolbar.png'), bar.toPNG());
      console.log('[test] blockedTotal=' + blockedTotal);
      app.quit();
    }, 12000);
  }
});

app.on('window-all-closed', () => app.quit());

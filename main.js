const { app, BaseWindow, WebContentsView, session, ipcMain, Menu, clipboard, ClipboardItem, shell, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const fetch = require('cross-fetch');
const { ElectronBlocker, Request } = require('@ghostery/adblocker-electron');
const hider = require('./hider');
const store = require('./lib/store');
const updater = require('./lib/updater');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const SEARCH = {
  google: { name: 'Google', url: 'https://www.google.com/search?q=' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q=' },
  duckduckgo: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  brave: { name: 'Brave Search', url: 'https://search.brave.com/search?q=' },
};
const DEFAULTS = {
  home: 'https://www.google.com',
  search: 'google',
  restoreTabs: true,
  showBookmarksBar: true,
  downloadDir: '',
  blockLevel: 'ads', // 'ads' = ads + trackers, 'full' = also cookie banners and annoyances
  allowSites: [], // sites where ad blocking is turned off
  zoom: {}, // host -> zoom factor
};
function settings() {
  const s = store.load('settings', {});
  for (const k of Object.keys(DEFAULTS)) if (!(k in s)) s[k] = structuredClone(DEFAULTS[k]);
  return s;
}
const engine = () => SEARCH[settings().search] || SEARCH.google;
const homeUrl = () => settings().home || DEFAULTS.home;
const downloadDir = () => settings().downloadDir || app.getPath('downloads');

function setSetting(key, value) {
  if (!(key in DEFAULTS)) throw new Error('unknown setting ' + key);
  const s = settings();
  if (key === 'home') {
    value = String(value || '').trim();
    if (value && !/^https?:\/\//i.test(value)) value = 'https://' + value;
  }
  if (key === 'search' && !SEARCH[value]) throw new Error('unknown search engine');
  if (key === 'blockLevel' && !['ads', 'full'].includes(value)) throw new Error('bad level');
  if (['restoreTabs', 'showBookmarksBar'].includes(key)) value = !!value;
  if (key === 'allowSites') value = [...new Set((value || []).map(String).filter(Boolean))];
  s[key] = value;
  store.save('settings', s);
  if (key === 'showBookmarksBar') layout();
  if (key === 'blockLevel') initBlocker().then(() => activeWC()?.reload());
  pushState();
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const BAR = { tabs: 40, toolbar: 44, bookmarks: 30, find: 40 };
const TEST_URL = process.env.BROWSER_TEST_URL; // optional: open this URL on start (for testing)

let win, ui, browsingSession, privSession, blocker;
let videoFullscreen = false; // a page (e.g. a video player) asked for fullscreen
let f11Fullscreen = false; // user pressed F11
let blockingEnabled = true; // "pause blocking everywhere" turns this off until restart
let blockedTotal = 0;
const tabs = new Map(); // id -> { view, blocked, tools, private, pendingUrl, pendingTitle, favicon }
let activeId = null;
let nextId = 1;
const closedTabs = []; // for Ctrl+Shift+T
const find = { open: false, text: '', matches: 0, active: 0 };

function send(channel, data) {
  if (ui && !ui.webContents.isDestroyed()) ui.webContents.send(channel, data);
}
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

const tabUrl = (t) => t.pendingUrl || t.view.webContents.getURL();
const tabTitle = (t) => t.pendingTitle || t.view.webContents.getTitle() || 'New Tab';

function tabInfo(id) {
  const t = tabs.get(id);
  const wc = t.view.webContents;
  const url = tabUrl(t);
  return {
    id,
    title: tabTitle(t),
    url,
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    blocked: t.blocked,
    autoWalls: !!(t.tools && t.tools.isAuto()),
    active: id === activeId,
    private: t.private,
    audible: wc.isCurrentlyAudible(),
    muted: wc.isAudioMuted(),
    favicon: t.favicon || '',
    zoom: Math.round(wc.getZoomFactor() * 100),
    bookmarked: bookmarks().some((b) => b.url === url),
    siteAllowed: settings().allowSites.includes(hostOf(url)),
  };
}

// State is sent to the toolbar at most every 30 ms (blocked-request counts
// and download progress can change hundreds of times a second).
let pushTimer = null;
function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(sendState, 30);
}
function sendState() {
  pushTimer = null;
  if (!ui) return;
  const active = downloads.filter((d) => d.state === 'progressing');
  const total = active.reduce((n, d) => n + (d.total || 0), 0);
  const got = active.reduce((n, d) => n + (d.received || 0), 0);
  send('state', {
    tabs: [...tabs.keys()].map(tabInfo),
    activeId,
    blockingEnabled,
    blockerReady: !!blocker,
    blockedTotal,
    bookmarks: bookmarks(),
    showBookmarksBar: settings().showBookmarksBar,
    find,
    downloads: { count: downloads.length, active: active.length, progress: total ? got / total : -1 },
  });
}

function uiHeight() {
  return BAR.tabs + BAR.toolbar + (settings().showBookmarksBar ? BAR.bookmarks : 0) + (find.open ? BAR.find : 0);
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  // In fullscreen the toolbar is hidden and the page fills the whole screen.
  const top = videoFullscreen || f11Fullscreen ? 0 : uiHeight();
  ui.setVisible(top > 0);
  ui.setBounds({ x: 0, y: 0, width, height: uiHeight() });
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
  if (!text) return homeUrl();
  if (/^(https?|hb):\/\//i.test(text)) return text;
  if (/^[^\s]+\.[^\s]{2,}(\/.*)?$/.test(text) || /^localhost(:\d+)?(\/.*)?$/.test(text)) {
    return 'https://' + text;
  }
  return engine().url + encodeURIComponent(text);
}

// ---------------------------------------------------------------------------
// Ad blocking
// ---------------------------------------------------------------------------
const siteAllowed = (url) => settings().allowSites.includes(hostOf(url));
// True when blocking should be skipped for requests made by this tab.
function blockingOff(wc) {
  if (!blocker || !blockingEnabled) return true;
  return !!(wc && !wc.isDestroyed() && siteAllowed(wc.getURL()));
}

function isBlockedPopup(wc, url, msSinceInput) {
  if (blockingOff(wc)) return false;
  let reason = null;
  if (msSinceInput > 1000) reason = 'no user click';
  else {
    const { match } = blocker.match(Request.fromRawDetails({ url, sourceUrl: wc.getURL(), type: 'popup' }));
    if (match) reason = 'ad filter';
  }
  if (!reason) return false;
  blockedTotal++;
  console.log(`[popup blocked: ${reason}]`, url);
  pushState();
  return true;
}

function onRequestBlocked(request) {
  blockedTotal++;
  for (const t of tabs.values()) {
    if (!t.view.webContents.isDestroyed() && t.view.webContents.id === request.tabId) {
      t.blocked++;
      break;
    }
  }
  pushState();
}

const ENGINE_MAX_AGE = 3 * 24 * 3600 * 1000; // refresh filter lists every 3 days

async function initBlocker() {
  const full = settings().blockLevel === 'full';
  const cache = path.join(app.getPath('userData'), full ? 'adblock-engine-full.bin' : 'adblock-engine.bin');
  try {
    const st = await fsp.stat(cache).catch(() => null);
    if (st && Date.now() - st.mtimeMs > ENGINE_MAX_AGE) await fsp.unlink(cache).catch(() => {});
    const make = full ? ElectronBlocker.fromPrebuiltFull : ElectronBlocker.fromPrebuiltAdsAndTracking;
    const b = await make.call(ElectronBlocker, fetch, { path: cache, read: fsp.readFile, write: fsp.writeFile });
    b.on('request-blocked', onRequestBlocked);
    blocker = b;
    console.log('[adblock] ready:', full ? 'full' : 'ads+trackers');
  } catch (err) {
    console.error('[adblock] failed to load filter lists:', err.message);
  }
  pushState();
}

// Cosmetic filters (hiding ad boxes) are requested by the adblocker's preload script.
ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', (e, url, msg) => {
  if (blockingOff(e.sender)) return;
  return blocker.onInjectCosmeticFilters(e, url, msg);
});
ipcMain.handle('@ghostery/adblocker/is-mutation-observer-enabled', () => !!(blocker && blocker.config.enableMutationObserver));

// ---------------------------------------------------------------------------
// Sessions: blocking, internal hb:// pages, downloads
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([{ scheme: 'hb', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const PAGES_DIR = path.join(__dirname, 'ui', 'pages');
const PAGES = ['history', 'downloads', 'settings'];
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml' };

function serveInternal(req) {
  const u = new URL(req.url);
  if (!PAGES.includes(u.hostname)) return new Response('Not found', { status: 404 });
  const name = u.pathname === '/' || u.pathname === '' ? u.hostname + '.html' : path.basename(u.pathname);
  try {
    const body = fs.readFileSync(path.join(PAGES_DIR, name));
    return new Response(body, { headers: { 'content-type': MIME[path.extname(name)] || 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

function setupSession(sess) {
  sess.protocol.handle('hb', serveInternal);
  sess.registerPreloadScript({ type: 'frame', filePath: require.resolve('@ghostery/adblocker-electron-preload') });
  sess.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, cb) => {
    if (blockingOff(details.webContents)) return cb({});
    blocker.onBeforeRequest(details, cb);
  });
  sess.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, (details, cb) => {
    if (blockingOff(details.webContents)) return cb({});
    blocker.onHeadersReceived(details, cb);
  });
  sess.on('will-download', onDownload);
}

function privateSession() {
  if (!privSession) {
    privSession = session.fromPartition('hb-private'); // no "persist:" = kept in memory only
    setupSession(privSession);
  }
  return privSession;
}

// ---- Downloads ----
const downloads = store.load('downloads', []).map((d) => ({ ...d, state: d.state === 'progressing' ? 'interrupted' : d.state }));
let nextDownloadId = downloads.reduce((n, d) => Math.max(n, d.id), 0) + 1;

function saveDownloads() {
  store.save('downloads', downloads.slice(0, 200).map(({ item, ...d }) => d));
}

function uniquePath(dir, name) {
  name = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'download';
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let file = path.join(dir, name);
  for (let i = 1; fs.existsSync(file) || downloads.some((d) => d.path === file && d.state === 'progressing'); i++) {
    file = path.join(dir, `${base} (${i})${ext}`);
  }
  return file;
}

function onDownload(_e, item) {
  const dir = downloadDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = uniquePath(dir, item.getFilename());
  item.setSavePath(file);
  const d = {
    id: nextDownloadId++, filename: path.basename(file), path: file, url: item.getURL(),
    received: 0, total: item.getTotalBytes(), state: 'progressing', paused: false, time: Date.now(), item,
  };
  downloads.unshift(d);
  item.on('updated', (_ev, state) => {
    d.state = state === 'interrupted' ? 'progressing' : state; // "interrupted" here can still resume
    d.received = item.getReceivedBytes();
    d.total = item.getTotalBytes();
    d.paused = item.isPaused();
    pushState();
  });
  item.once('done', (_ev, state) => {
    d.state = state; // completed | cancelled | interrupted
    d.received = item.getReceivedBytes();
    delete d.item;
    saveDownloads();
    pushState();
    if (state === 'completed') toast(`Downloaded ${d.filename}. Click to open it.`, 'open-last-download');
    else if (state === 'interrupted') toast(`Download failed: ${d.filename}`, 'open-downloads');
  });
  toast(`Downloading ${d.filename}. Click to see downloads.`, 'open-downloads');
  saveDownloads();
  pushState();
}

function downloadAction(id, action) {
  const i = downloads.findIndex((x) => x.id === id);
  const d = downloads[i];
  if (!d) return;
  if (action === 'open') shell.openPath(d.path);
  else if (action === 'show') shell.showItemInFolder(d.path);
  else if (action === 'cancel') d.item?.cancel();
  else if (action === 'pause') d.item?.pause();
  else if (action === 'resume') d.item?.resume();
  else if (action === 'retry') { const wc = activeWC(); if (wc) wc.downloadURL(d.url); }
  else if (action === 'remove') { d.item?.cancel(); downloads.splice(i, 1); }
  saveDownloads();
  pushState();
}

// ---------------------------------------------------------------------------
// History, bookmarks, open-tab session
// ---------------------------------------------------------------------------
const history = () => store.load('history', []);
function addHistory(url, title) {
  if (!/^https?:/i.test(url)) return;
  const h = history();
  const last = h[h.length - 1];
  if (last && last.url === url) last.time = Date.now();
  else h.push({ url, title: title || url, time: Date.now() });
  if (h.length > 10000) h.splice(0, h.length - 10000);
  store.save('history', h, { delay: 2000 });
}
function updateHistoryTitle(url, title) {
  const h = history();
  for (let i = h.length - 1; i >= Math.max(0, h.length - 30); i--) {
    if (h[i].url === url) { h[i].title = title; store.save('history', h, { delay: 2000 }); return; }
  }
}

const bookmarks = () => store.load('bookmarks', []);
function toggleBookmark() {
  const t = tabs.get(activeId);
  if (!t) return;
  const url = tabUrl(t);
  if (!/^(https?|hb):/i.test(url)) return;
  const list = bookmarks();
  const i = list.findIndex((b) => b.url === url);
  if (i >= 0) { list.splice(i, 1); toast('Bookmark removed.'); }
  else { list.push({ id: Date.now(), title: tabTitle(t), url, favicon: t.favicon || '' }); toast('Bookmarked. Rename or remove bookmarks in Settings.', 'open-settings'); }
  store.save('bookmarks', list);
  pushState();
}

function saveSession() {
  if (process.env.BROWSER_NO_SESSION) return;
  const normal = [...tabs.entries()].filter(([, t]) => !t.private);
  const list = normal.map(([, t]) => ({ url: tabUrl(t), title: tabTitle(t) })).filter((x) => x.url);
  store.save('session', { tabs: list, active: Math.max(0, normal.findIndex(([id]) => id === activeId)) }, { delay: 1000 });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const ZOOMS = [0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function applyZoom(wc) {
  const f = settings().zoom[hostOf(wc.getURL())] || 1;
  if (Math.abs(wc.getZoomFactor() - f) > 0.001) wc.setZoomFactor(f);
}
function zoom(dir) {
  const wc = activeWC();
  if (!wc) return;
  const cur = wc.getZoomFactor();
  let f = 1;
  if (dir > 0) f = ZOOMS.find((z) => z > cur + 0.001) || ZOOMS[ZOOMS.length - 1];
  else if (dir < 0) f = [...ZOOMS].reverse().find((z) => z < cur - 0.001) || ZOOMS[0];
  wc.setZoomFactor(f);
  const host = hostOf(wc.getURL());
  if (host) {
    const s = settings();
    if (f === 1) delete s.zoom[host]; else s.zoom[host] = f;
    store.save('settings', s);
  }
  pushState();
}

// Rebuild the tab Map in a new order.
function reorder(ids) {
  const entries = ids.map((id) => [id, tabs.get(id)]);
  tabs.clear();
  for (const [id, t] of entries) tabs.set(id, t);
}

function createTab(url = homeUrl(), opts = {}) {
  const id = nextId++;
  const isPrivate = !!opts.private;
  const view = new WebContentsView({
    webPreferences: {
      session: isPrivate ? privateSession() : browsingSession,
      preload: path.join(__dirname, 'ui', 'tab-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  view.setBackgroundColor('#ffffff');
  const t = { view, blocked: 0, private: isPrivate, pendingUrl: null, pendingTitle: null, favicon: '' };
  tabs.set(id, t);
  if (opts.after && tabs.has(opts.after)) {
    const ids = [...tabs.keys()].filter((x) => x !== id);
    ids.splice(ids.indexOf(opts.after) + 1, 0, id);
    reorder(ids);
  }
  win.contentView.addChildView(view);

  const wc = view.webContents;
  // Remember when the user last clicked/typed in this tab, so we can tell
  // user-initiated popups (allowed) from script-spawned ones (blocked).
  let lastInput = 0;
  wc.on('input-event', (_e, input) => {
    if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'rawKeyDown' || input.type === 'gestureTap') lastInput = Date.now();
  });
  wc.setWindowOpenHandler(({ url: target, disposition }) => {
    if (/^https?:/i.test(target) && !isBlockedPopup(wc, target, Date.now() - lastInput)) {
      lastInput = 0; // one popup per click
      createTab(target, { private: isPrivate, after: id, background: disposition === 'background-tab' });
    }
    return { action: 'deny' };
  });
  for (const ev of ['did-start-loading', 'did-stop-loading', 'audio-state-changed']) wc.on(ev, pushState);
  wc.on('page-title-updated', (_e, title) => {
    if (!isPrivate) updateHistoryTitle(wc.getURL(), title);
    saveSession();
    pushState();
  });
  wc.on('page-favicon-updated', (_e, icons) => {
    t.favicon = (icons || []).find((u) => /^(https?|data):/.test(u)) || '';
    pushState();
  });
  wc.on('did-navigate', (_e, navUrl) => {
    if (!isPrivate) addHistory(navUrl, wc.getTitle());
    applyZoom(wc);
    saveSession();
    pushState();
  });
  wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
    if (!isMainFrame) return;
    if (!isPrivate) addHistory(navUrl, wc.getTitle());
    saveSession();
    pushState();
  });
  wc.on('found-in-page', (_e, r) => {
    if (id !== activeId) return;
    find.matches = r.matches;
    find.active = r.activeMatchOrdinal;
    pushState();
  });
  wc.on('zoom-changed', (_e, dir) => zoom(dir === 'in' ? 1 : -1)); // Ctrl + mouse wheel
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
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape') return;
    // Esc leaves F11 fullscreen (video fullscreen handles Esc itself), or closes the find bar.
    if (f11Fullscreen && !videoFullscreen) { e.preventDefault(); setF11(false); }
    else if (find.open) { e.preventDefault(); closeFind(); }
  });
  wc.on('did-start-navigation', (_e, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      t.blocked = 0;
      pushState();
    }
  });

  t.tools = hider.attach(wc, {
    createTab: (u, o = {}) => createTab(u, { private: isPrivate, after: id, ...o }),
    onScreenshot: takeScreenshot,
    onToast: toast,
    onChange: pushState,
    onPip: (x, y) => pictureInPicture(wc, x, y),
    search: () => engine(),
  });

  if (opts.lazy) {
    // Restored tab: load it only when the user first opens it.
    t.pendingUrl = url;
    t.pendingTitle = opts.title || url;
  } else {
    wc.loadURL(url);
  }
  if (!opts.background) switchTab(id);
  else { layout(); pushState(); }
  saveSession();
  return id;
}

function switchTab(id) {
  if (!tabs.has(id)) return;
  if (find.open && id !== activeId) closeFind();
  activeId = id;
  const t = tabs.get(id);
  if (t.pendingUrl) {
    const u = t.pendingUrl;
    t.pendingUrl = t.pendingTitle = null;
    t.view.webContents.loadURL(u);
  }
  layout();
  t.view.webContents.focus();
  saveSession();
  pushState();
}

function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  const ids = [...tabs.keys()];
  const idx = ids.indexOf(id);
  const url = tabUrl(t);
  if (url) {
    closedTabs.push({ url, private: t.private });
    if (closedTabs.length > 25) closedTabs.shift();
  }
  win.contentView.removeChildView(t.view);
  t.view.webContents.close();
  tabs.delete(id);
  // Closing the last private tab wipes everything that private browsing stored.
  if (t.private && ![...tabs.values()].some((x) => x.private) && privSession) {
    privSession.clearStorageData().catch(() => {});
    privSession.clearCache().catch(() => {});
    for (let i = closedTabs.length - 1; i >= 0; i--) if (closedTabs[i].private) closedTabs.splice(i, 1);
  }
  if (tabs.size === 0) return createTab();
  if (activeId === id) {
    const rest = [...tabs.keys()];
    activeId = rest[Math.min(idx, rest.length - 1)];
  }
  switchTab(activeId);
}

function reopenClosedTab() {
  const c = closedTabs.pop();
  if (c) createTab(c.url, { private: c.private });
}

function moveTab(id, index) {
  if (!tabs.has(id)) return;
  const ids = [...tabs.keys()].filter((x) => x !== id);
  ids.splice(Math.max(0, Math.min(index, ids.length)), 0, id);
  reorder(ids);
  saveSession();
  pushState();
}

function cycleTab(dir) {
  const ids = [...tabs.keys()];
  if (ids.length < 2) return;
  switchTab(ids[(ids.indexOf(activeId) + dir + ids.length) % ids.length]);
}

function activeWC() {
  const t = tabs.get(activeId);
  return t && t.view.webContents;
}
function activeTools() {
  const t = tabs.get(activeId);
  return t && t.tools;
}
function toast(text, action) {
  send('toast', { text, action });
}
function openInternal(page) {
  const url = 'hb://' + page;
  for (const [id, t] of tabs) if (tabUrl(t).startsWith(url)) { t.view.webContents.reload(); return switchTab(id); }
  createTab(url, { after: activeId });
}

// ---------------------------------------------------------------------------
// Find on page
// ---------------------------------------------------------------------------
function openFind() {
  find.open = true;
  layout();
  pushState();
  ui.webContents.focus();
  send('focus-find');
}
function closeFind() {
  if (!find.open) return;
  find.open = false;
  find.matches = find.active = 0;
  activeWC()?.stopFindInPage('keepSelection');
  layout();
  pushState();
  activeWC()?.focus();
}
function findText({ text, forward = true, next = false } = {}) {
  const wc = activeWC();
  if (!wc) return;
  find.text = String(text || '');
  if (!find.text) {
    wc.stopFindInPage('clearSelection');
    find.matches = find.active = 0;
    return pushState();
  }
  wc.findInPage(find.text, { forward, findNext: !next });
}

// ---------------------------------------------------------------------------
// Picture in picture
// ---------------------------------------------------------------------------
const pipScript = (x, y) => `(async () => {
  if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return 'exit'; }
  const vids = [...document.querySelectorAll('video')].filter((v) => v.readyState > 0);
  if (!vids.length) return 'none';
  const at = ${x == null ? 'null' : `vids.find((v) => { const r = v.getBoundingClientRect(); return ${x} >= r.left && ${x} <= r.right && ${y} >= r.top && ${y} <= r.bottom; })`};
  const v = at || vids.find((v) => !v.paused) || vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  v.disablePictureInPicture = false;
  await v.requestPictureInPicture();
  return 'on';
})()`;

async function pictureInPicture(wc = activeWC(), x = null, y = null) {
  if (!wc) return;
  // Video players are often inside iframes, so try every frame.
  for (const frame of wc.mainFrame.framesInSubtree) {
    const isMain = frame === wc.mainFrame;
    const r = await frame.executeJavaScript(pipScript(isMain ? x : null, isMain ? y : null), true).catch((e) => 'error ' + e.message);
    if (r === 'on' || r === 'exit') return r;
  }
  toast('No playable video found on this page.');
  return 'none';
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------
const screenshotDir = () => path.join(app.getPath('pictures'), 'H Browser');
let lastScreenshot = null;

// Saves the visible page as a PNG in Pictures\H Browser and copies it to the clipboard.
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
  const host = hostOf(wc.getURL()).replace(/^www\./, '') || 'page';
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(screenshotDir(), `${host}_${stamp}.png`);
  await fsp.mkdir(screenshotDir(), { recursive: true });
  await fsp.writeFile(file, img.toPNG());
  clipboard.write([new ClipboardItem({ 'image/png': new Blob([img.toPNG()], { type: 'image/png' }) })])
    .catch((e) => console.error('[screenshot] clipboard failed:', e.message));
  lastScreenshot = file;
  toast('Screenshot saved and copied. Click to open folder.', 'open-screenshots');
  return file;
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
const commands = {
  newTab: { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab() },
  newPrivateTab: { label: 'New Private Tab', accelerator: 'CmdOrCtrl+Shift+N', click: () => createTab(homeUrl(), { private: true }) },
  reopenTab: { label: 'Reopen Closed Tab', accelerator: 'CmdOrCtrl+Shift+T', click: reopenClosedTab },
  closeTab: { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => closeTab(activeId) },
  bookmark: { label: 'Bookmark This Page', accelerator: 'CmdOrCtrl+D', click: toggleBookmark },
  bookmarksBar: { label: 'Show Bookmarks Bar', accelerator: 'CmdOrCtrl+Shift+B', click: () => setSetting('showBookmarksBar', !settings().showBookmarksBar) },
  history: { label: 'History', accelerator: 'CmdOrCtrl+H', click: () => openInternal('history') },
  downloads: { label: 'Downloads', accelerator: 'CmdOrCtrl+J', click: () => openInternal('downloads') },
  settings: { label: 'Settings', click: () => openInternal('settings') },
  find: { label: 'Find on Page', accelerator: 'CmdOrCtrl+F', click: openFind },
  zoomIn: { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoom(1) },
  zoomOut: { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-1) },
  zoomReset: { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => zoom(0) },
  print: { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => activeWC()?.print() },
  pip: { label: 'Picture in Picture', accelerator: 'CmdOrCtrl+Shift+P', click: () => pictureInPicture() },
  fullscreen: { label: 'Full Screen', accelerator: 'F11', click: () => setF11(!f11Fullscreen) },
  updates: { label: 'Check for Updates', click: async () => toast(await updater.check()) },
};
const item = (name, extra = {}) => ({ ...commands[name], ...extra });

function buildAppMenu() {
  // Hidden menu that provides the keyboard shortcuts.
  const hidden = (accelerator, click) => ({ label: accelerator, accelerator, visible: false, click });
  const menu = Menu.buildFromTemplate([
    {
      label: 'Browser',
      submenu: [
        item('newTab'), item('newPrivateTab'), item('reopenTab'), item('closeTab'),
        item('bookmark'), item('bookmarksBar'), item('history'), item('downloads'),
        item('find'), item('zoomIn'), item('zoomOut'), item('zoomReset'), item('print'), item('pip'), item('fullscreen'),
        hidden('CmdOrCtrl+Plus', () => zoom(1)),
        hidden('F3', () => (find.open ? findText({ text: find.text, next: true }) : openFind())),
        hidden('Shift+F3', () => find.open && findText({ text: find.text, forward: false, next: true })),
        hidden('CmdOrCtrl+Tab', () => cycleTab(1)),
        hidden('CmdOrCtrl+Shift+Tab', () => cycleTab(-1)),
        { label: 'Focus Address Bar', accelerator: 'CmdOrCtrl+L', click: () => { ui.webContents.focus(); send('focus-address'); } },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => activeWC()?.reload() },
        hidden('F5', () => activeWC()?.reload()),
        { label: 'Back', accelerator: 'Alt+Left', click: () => activeWC()?.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => activeWC()?.navigationHistory.goForward() },
        { label: 'Developer Tools', accelerator: 'F12', click: () => activeWC()?.toggleDevTools() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

// Menus opened from toolbar buttons. Shortcuts are shown but handled by the app menu.
const show = (name, extra) => item(name, { registerAccelerator: false, ...extra });
function popup(tpl, x, y) {
  Menu.buildFromTemplate(tpl).popup({ window: win, x: Math.round(x), y: Math.round(y) });
}

function mainMenu(x, y) {
  popup([
    show('newTab'), show('newPrivateTab'), show('reopenTab', { enabled: closedTabs.length > 0 }),
    { type: 'separator' },
    show('bookmark', { label: tabInfo(activeId).bookmarked ? 'Remove Bookmark' : 'Bookmark This Page' }),
    show('bookmarksBar', { type: 'checkbox', checked: settings().showBookmarksBar }),
    show('history'), show('downloads'),
    { type: 'separator' },
    show('find'),
    { label: `Zoom (${tabInfo(activeId).zoom}%)`, submenu: [show('zoomIn'), show('zoomOut'), show('zoomReset')] },
    show('print'), show('pip'), show('fullscreen'),
    { type: 'separator' },
    show('settings'), show('updates'),
    { label: `About H Browser ${app.getVersion()}`, click: () => shell.openExternal('https://github.com/Alawieh/hussein-browser') },
    { type: 'separator' },
    { label: 'Exit', click: () => app.quit() },
  ], x, y);
}

function tabMenu(id, x, y) {
  const t = tabs.get(id);
  if (!t) return;
  const wc = t.view.webContents;
  const ids = [...tabs.keys()];
  popup([
    { label: 'Reload', click: () => wc.reload() },
    { label: 'Duplicate', click: () => createTab(tabUrl(t), { private: t.private, after: id }) },
    { label: wc.isAudioMuted() ? 'Unmute Tab' : 'Mute Tab', click: () => { wc.setAudioMuted(!wc.isAudioMuted()); pushState(); } },
    { type: 'separator' },
    { label: 'Close Tab', click: () => closeTab(id) },
    { label: 'Close Other Tabs', enabled: ids.length > 1, click: () => ids.filter((x2) => x2 !== id).forEach(closeTab) },
    { label: 'Close Tabs to the Right', enabled: ids.indexOf(id) < ids.length - 1, click: () => ids.slice(ids.indexOf(id) + 1).forEach(closeTab) },
    { type: 'separator' },
    show('reopenTab', { enabled: closedTabs.length > 0 }),
  ], x, y);
}

function shieldMenu(x, y) {
  const url = activeWC()?.getURL() || '';
  const host = hostOf(url);
  const allowed = siteAllowed(url);
  const t = tabs.get(activeId);
  popup([
    { label: blocker ? `${t ? t.blocked : 0} blocked on this page, ${blockedTotal} in total` : 'Ad blocking is unavailable (filter lists failed to load)', enabled: false },
    { type: 'separator' },
    {
      label: host ? `Block ads on ${host}` : 'Block ads on this site', type: 'checkbox', checked: !allowed, enabled: !!host && /^https?:/.test(url),
      click: () => {
        const list = settings().allowSites.filter((h) => h !== host);
        if (!allowed) list.push(host);
        setSetting('allowSites', list);
        activeWC()?.reload();
      },
    },
    {
      label: 'Pause Blocking Everywhere', type: 'checkbox', checked: !blockingEnabled,
      click: () => { blockingEnabled = !blockingEnabled; pushState(); activeWC()?.reload(); },
    },
    { type: 'separator' },
    { label: 'Ad Blocking Settings…', click: () => openInternal('settings') },
  ], x, y);
}

function bookmarkMenu(id, x, y) {
  const b = bookmarks().find((z) => z.id === id);
  if (!b) return;
  popup([
    { label: 'Open', click: () => activeWC()?.loadURL(b.url) },
    { label: 'Open in New Tab', click: () => createTab(b.url, { after: activeId }) },
    { label: 'Open in Private Tab', click: () => createTab(b.url, { private: true }) },
    { type: 'separator' },
    { label: 'Rename or Edit…', click: () => openInternal('settings') },
    { label: 'Delete', click: () => { store.save('bookmarks', bookmarks().filter((z) => z.id !== id)); pushState(); } },
  ], x, y);
}

function bookmarksOverflow(x, y) {
  const list = bookmarks();
  popup(list.length
    ? list.map((b) => ({ label: b.title.slice(0, 60) || b.url, click: () => activeWC()?.loadURL(b.url) }))
    : [{ label: 'No bookmarks yet. Press Ctrl+D to bookmark a page.', enabled: false }], x, y);
}

// ---------------------------------------------------------------------------
// IPC from the toolbar
// ---------------------------------------------------------------------------
const fromUI = (fn) => (e, ...args) => { if (ui && e.sender === ui.webContents) fn(...args); };
const on = (ch, fn) => ipcMain.on(ch, fromUI(fn));
on('navigate', (input) => activeWC()?.loadURL(normalizeInput(String(input))));
on('back', () => activeWC()?.navigationHistory.goBack());
on('forward', () => activeWC()?.navigationHistory.goForward());
on('reload', () => activeWC()?.reload());
on('stop', () => activeWC()?.stop());
on('home', () => activeWC()?.loadURL(homeUrl()));
on('new-tab', () => createTab());
on('close-tab', (id) => closeTab(id));
on('switch-tab', (id) => switchTab(id));
on('move-tab', ({ id, index } = {}) => moveTab(id, index));
on('toggle-mute', (id) => { const t = tabs.get(id); if (t) { t.view.webContents.setAudioMuted(!t.view.webContents.isAudioMuted()); pushState(); } });
on('ui-ready', pushState);
on('tool-unwall', () => activeTools()?.unwall());
on('tool-hide', () => activeTools()?.pickMode());
on('tool-screenshot', () => takeScreenshot());
on('auto-walls-on', () => activeTools()?.setAutoWalls(true));
on('toggle-auto-walls', () => { const t = activeTools(); if (t) t.setAutoWalls(!t.isAuto()); });
on('open-screenshots', () => (lastScreenshot ? shell.showItemInFolder(lastScreenshot) : shell.openPath(screenshotDir())));
on('toggle-bookmark', toggleBookmark);
on('open-bookmark', ({ id, newTab } = {}) => {
  const b = bookmarks().find((z) => z.id === id);
  if (b) newTab ? createTab(b.url, { after: activeId, background: true }) : activeWC()?.loadURL(b.url);
});
on('find', findText);
on('find-close', closeFind);
on('zoom-reset', () => zoom(0));
on('open-downloads', () => openInternal('downloads'));
on('open-settings', () => openInternal('settings'));
on('open-last-download', () => { const d = downloads.find((x) => x.state === 'completed'); if (d) shell.openPath(d.path); });
on('install-update', () => updater.install());
on('main-menu', ({ x, y } = {}) => mainMenu(x, y));
on('shield-menu', ({ x, y } = {}) => shieldMenu(x, y));
on('tab-menu', ({ id, x, y } = {}) => tabMenu(id, x, y));
on('bookmark-menu', ({ id, x, y } = {}) => bookmarkMenu(id, x, y));
on('bookmarks-overflow', ({ x, y } = {}) => bookmarksOverflow(x, y));

// ---------------------------------------------------------------------------
// IPC from internal pages (hb://history, hb://downloads, hb://settings)
// ---------------------------------------------------------------------------
const pageOps = {
  getHistory: ({ query = '', limit = 500 } = {}) => {
    const q = String(query).toLowerCase();
    const out = [];
    const h = history();
    for (let i = h.length - 1; i >= 0 && out.length < limit; i--) {
      if (!q || h[i].url.toLowerCase().includes(q) || (h[i].title || '').toLowerCase().includes(q)) out.push(h[i]);
    }
    return out;
  },
  deleteHistory: ({ url, time }) => {
    store.save('history', history().filter((x) => !(x.url === url && x.time === time)));
  },
  clearHistory: () => store.save('history', []),
  getDownloads: () => downloads.map(({ item: _i, ...d }) => d),
  downloadAction: ({ id, action }) => downloadAction(id, action),
  clearDownloads: () => {
    for (let i = downloads.length - 1; i >= 0; i--) if (downloads[i].state !== 'progressing') downloads.splice(i, 1);
    saveDownloads();
    pushState();
  },
  getSettings: () => ({
    settings: settings(),
    version: app.getVersion(),
    engines: Object.fromEntries(Object.entries(SEARCH).map(([k, v]) => [k, v.name])),
    defaultDownloadDir: app.getPath('downloads'),
    bookmarks: bookmarks(),
    hidden: hider.listHidden(),
    autoSites: hider.listAuto(),
  }),
  setSetting: ({ key, value }) => setSetting(key, value),
  chooseDownloadDir: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], defaultPath: downloadDir() });
    if (!r.canceled && r.filePaths[0]) setSetting('downloadDir', r.filePaths[0]);
  },
  saveBookmark: ({ id, title, url }) => {
    const list = bookmarks();
    const b = list.find((z) => z.id === id);
    if (!b) return;
    if (typeof title === 'string') b.title = title.trim() || b.url;
    if (typeof url === 'string' && url.trim()) b.url = normalizeInput(url);
    store.save('bookmarks', list);
    pushState();
  },
  moveBookmark: ({ id, delta }) => {
    const list = bookmarks();
    const i = list.findIndex((z) => z.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    store.save('bookmarks', list);
    pushState();
  },
  deleteBookmark: ({ id }) => { store.save('bookmarks', bookmarks().filter((z) => z.id !== id)); pushState(); },
  unhide: ({ host, selector }) => hider.unhide(host, selector),
  setAutoSite: ({ host, on: enabled }) => { hider.setAuto(String(host).trim(), !!enabled); pushState(); },
  clearData: async ({ history: h, cookies, cache }) => {
    if (h) store.save('history', []);
    if (cookies) await browsingSession.clearStorageData();
    if (cache) await browsingSession.clearCache();
  },
  checkUpdates: () => updater.check(),
};

ipcMain.handle('hb-page', async (e, op, arg) => {
  const url = e.senderFrame ? e.senderFrame.url : '';
  if (!url.startsWith('hb://') || !pageOps[op]) throw new Error('not allowed');
  return pageOps[op](arg || {});
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
// The browser used to be called "Hussein Browser". Bring its data (cookies,
// bookmarks, hidden elements...) over to the new folder on first start.
(function migrateOldData() {
  const now = app.getPath('userData');
  const old = path.join(app.getPath('appData'), 'Hussein Browser');
  if (fs.existsSync(now) || !fs.existsSync(old)) return;
  try {
    fs.cpSync(old, now, { recursive: true, force: false, errorOnExist: false, filter: (src) => !/[\\/](Singleton\w*|lockfile|LOCK)$/.test(src) });
    console.log('[migrate] copied data from', old);
  } catch (e) {
    console.error('[migrate] failed:', e.message);
  }
})();

app.setAppUserModelId('com.alawieh.husseinbrowser');
// Keep rendering when the window is covered, so screenshots never come back blank.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(async () => {
  browsingSession = session.fromPartition('persist:browser');
  setupSession(browsingSession);

  win = new BaseWindow({ width: 1280, height: 850, title: 'H Browser', autoHideMenuBar: true, backgroundColor: '#1f2023', icon: path.join(__dirname, 'ui', 'icon.png') });
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
  buildAppMenu();

  // Start the blocker before the first tab loads so the first page is filtered too.
  await initBlocker();

  const saved = store.load('session', { tabs: [] });
  if (!TEST_URL && !process.env.BROWSER_NO_SESSION && settings().restoreTabs && saved.tabs.length) {
    saved.tabs.forEach((s, i) => createTab(s.url, { lazy: i !== saved.active, title: s.title, background: true }));
    switchTab([...tabs.keys()][saved.active] || [...tabs.keys()][0]);
  } else {
    createTab(TEST_URL || homeUrl());
  }
  layout();

  updater.init({ toast });

  if (process.env.BROWSER_SCREENSHOT) {
    setTimeout(async () => {
      const img = await activeWC().capturePage();
      const bar = await ui.webContents.capturePage();
      await fsp.writeFile(process.env.BROWSER_SCREENSHOT, img.toPNG());
      await fsp.writeFile(process.env.BROWSER_SCREENSHOT.replace(/\.png$/, '-toolbar.png'), bar.toPNG());
      console.log('[test] blockedTotal=' + blockedTotal);
      app.quit();
    }, 12000);
  }
});

app.on('before-quit', () => store.flush());
app.on('window-all-closed', () => app.quit());

module.exports = { _test: () => ({ tabs, activeWC, createTab, closeTab, reopenClosedTab, moveTab, switchTab, toggleBookmark, bookmarks, history, downloads, openFind, findText, closeFind, find, zoom, pictureInPicture, setSetting, settings, pageOps, uiHeight, blockingOff, tabInfo, ui: () => ui, win: () => win, blocked: () => blockedTotal }) };

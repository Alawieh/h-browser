// Right-click menu + "hide this element" tool, with hidden elements remembered per site.
const { app, Menu, clipboard, ClipboardItem } = require('electron');
const copyText = (text) => clipboard.write([new ClipboardItem({ 'text/plain': text })]).catch(() => {});
const path = require('path');
const fs = require('fs');

const storeFile = () => path.join(app.getPath('userData'), 'hidden-elements.json');
let store = null; // { [hostname]: [selector, ...] }

function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(storeFile(), 'utf8')); } catch { store = {}; }
  return store;
}
function save() {
  try { fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2)); } catch (e) { console.error('[hider] save failed', e.message); }
}
function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}
function cssFor(selectors) {
  return selectors.map((s) => `${s}{display:none!important}`).join('\n');
}

// Runs in the page: find the element under (x, y), climb to the outermost
// wrapper with the same size, hide it, and return a CSS selector for it.
// Shared in-page helper: element under (x, y) -> the box that should be hidden.
const CHOOSE = `const __choose = (x, y) => {
  let el = document.elementFromPoint(x, y);
  if (!el || el === document.documentElement || el === document.body) return null;
  const same = (a, b) => { const r = a.getBoundingClientRect(), s = b.getBoundingClientRect();
    return Math.abs(r.width - s.width) < 4 && Math.abs(r.height - s.height) < 4; };
  const up = (n) => n.parentElement && n.parentElement !== document.body && n.parentElement !== document.documentElement;
  // Clicking text inside a box should hide the box, not just the word.
  while (up(el) && getComputedStyle(el).display.startsWith('inline') && el.tagName !== 'IMG' && el.tagName !== 'IFRAME') el = el.parentElement;
  while (up(el) && same(el, el.parentElement)) el = el.parentElement;
  return el;
};`;

const pickScript = (x, y) => `(() => {
  ${CHOOSE}
  const el = __choose(${x}, ${y});
  if (!el) return null;
  const good = (id) => id && !/\\d{3,}|[:.]/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1;
  const parts = [];
  for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
    if (good(n.id)) { parts.unshift('#' + CSS.escape(n.id)); break; }
    let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
    parts.unshift(n.tagName.toLowerCase() + ':nth-of-type(' + i + ')');
  }
  if (!parts[0].startsWith('#')) parts.unshift('body');
  el.style.setProperty('display', 'none', 'important');
  return parts.join(' > ');
})()`;

// Runs in the page: "click to hide" mode. Highlights the box under the mouse
// and resolves with the click position (or null on Escape).
const pickModeScript = `new Promise((resolve) => {
  ${CHOOSE}
  if (window.__hbPicking) return resolve(null);
  window.__hbPicking = true;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;background:rgba(234,67,53,.25);outline:2px solid #ea4335;border-radius:3px;transition:all .05s';
  const tip = document.createElement('div');
  tip.textContent = 'Click what you want to hide - Esc to cancel';
  tip.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:#202124;color:#fff;font:13px Segoe UI,sans-serif;padding:7px 14px;border-radius:16px;box-shadow:0 2px 8px #0006';
  document.documentElement.append(box, tip);
  const move = (e) => {
    const el = __choose(e.clientX, e.clientY);
    if (!el) { box.style.width = '0'; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const block = (e) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const evs = ['mousedown', 'mouseup', 'pointerdown', 'pointerup'];
  const done = (val) => {
    removeEventListener('mousemove', move, true);
    for (const t of evs) removeEventListener(t, block, true);
    removeEventListener('click', click, true);
    removeEventListener('keydown', key, true);
    box.remove(); tip.remove(); window.__hbPicking = false;
    resolve(val);
  };
  const click = (e) => { block(e); done({ x: e.clientX, y: e.clientY }); };
  const key = (e) => { if (e.key === 'Escape') { block(e); done(null); } };
  addEventListener('mousemove', move, true);
  for (const t of evs) addEventListener(t, block, true);
  addEventListener('click', click, true);
  addEventListener('keydown', key, true);
})`;

// In-page function: remove full-screen overlays (paywalls, "disable your ad
// blocker" walls, cookie walls, invisible click-hijack layers) and undo the
// scroll-lock / blur they add. Safe to run repeatedly.
const UNWALL_FN = `function __hbUnwall() {
  let removed = 0;
  const vw = innerWidth, vh = innerHeight, area = vw * vh;
  const fs = document.fullscreenElement;
  const keep = (el) => (fs && (el === fs || el.contains(fs) || fs.contains(el))) || el.querySelector('video');
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    const z = parseInt(cs.zIndex) || 0;
    if (cs.position === 'fixed' || cs.position === 'sticky') {
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= area * 0.3 || (z > 999 && r.height > vh * 0.15)) { if (!keep(el)) { el.remove(); removed++; } }
    } else if (cs.position === 'absolute' && z > 999) {
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= area * 0.5 && !keep(el)) { el.remove(); removed++; }
    }
  }
  const set = (el, prop, val) => { if (el && el.style.getPropertyValue(prop) !== val) el.style.setProperty(prop, val, 'important'); };
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow === 'hidden' || cs.overflowY === 'hidden') set(el, 'overflow', 'auto');
    if (cs.position === 'fixed') set(el, 'position', 'static');
  }
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.filter.includes('blur')) set(el, 'filter', 'none');
  }
  if (!window.__hbUnblocked) {
    window.__hbUnblocked = true;
    // Undo right-click / selection / copy blocking.
    for (const t of ['contextmenu', 'selectstart', 'copy']) {
      window.addEventListener(t, (e) => e.stopImmediatePropagation(), true);
      document['on' + t] = null; if (document.body) document.body['on' + t] = null;
    }
    const st = document.createElement('style');
    st.textContent = '*{user-select:text!important;-webkit-user-select:text!important}';
    (document.head || document.documentElement).append(st);
  }
  return removed;
}`;

const unwallScript = `(() => { ${UNWALL_FN}; return __hbUnwall(); })()`;

// Keeps removing walls as the page changes (for sites that re-show the wall
// on every screen / after every click).
const watchScript = `(() => {
  if (window.__hbWatch) return 0;
  window.__hbWatch = true;
  ${UNWALL_FN};
  let pending = false;
  const run = () => { pending = false; try { __hbUnwall(); } catch (e) {} };
  new MutationObserver(() => { if (!pending) { pending = true; setTimeout(run, 300); } })
    .observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  return __hbUnwall();
})()`;

// Sites where walls are removed automatically.
const autoFile = () => path.join(app.getPath('userData'), 'auto-walls.json');
let autoSites = null;
function auto() {
  if (autoSites) return autoSites;
  try { autoSites = new Set(JSON.parse(fs.readFileSync(autoFile(), 'utf8'))); } catch { autoSites = new Set(); }
  return autoSites;
}
function setAuto(host, on) {
  const a = auto();
  if (on) a.add(host); else a.delete(host);
  try { fs.writeFileSync(autoFile(), JSON.stringify([...a], null, 2)); } catch {}
  console.log('[hider] auto-walls', on ? 'ON' : 'OFF', 'for', host);
}

function remember(host, sel) {
  const s = load();
  s[host] = [...new Set([...(s[host] || []), sel])];
  save();
  console.log('[hider] hid on', host + ':', sel);
}

function attach(wc, { createTab, onChange, onScreenshot, onToast }) {
  // Re-apply this site's hidden elements on every page load.
  wc.on('dom-ready', () => {
    const list = load()[hostOf(wc.getURL())];
    if (list && list.length) wc.insertCSS(cssFor(list)).catch(() => {});
    if (auto().has(hostOf(wc.getURL()))) wc.executeJavaScript(watchScript).catch(() => {});
  });

  const hideAt = async (x, y) => {
    const host = hostOf(wc.getURL());
    const sel = await wc.executeJavaScript(pickScript(x, y)).catch(() => null);
    if (!sel || !host) return null;
    remember(host, sel);
    onChange && onChange();
    return sel;
  };
  const unwall = async () => {
    const host = hostOf(wc.getURL());
    const n = await wc.executeJavaScript(unwallScript).catch(() => 0);
    console.log('[hider] removed', n, 'overlay(s) on', host);
    if (host && !auto().has(host) && onToast) {
      onToast(`Removed ${n} wall(s). Wall keeps coming back? Click here to always remove walls on ${host}.`, 'auto-walls-on');
    }
    return n;
  };
  const isAuto = () => auto().has(hostOf(wc.getURL()));
  const setAutoWalls = (on) => {
    const host = hostOf(wc.getURL());
    if (!host) return;
    setAuto(host, on);
    if (on) wc.executeJavaScript(watchScript).catch(() => {});
    else wc.reload();
    onToast && onToast(on ? `Walls will be removed automatically on ${host}.` : `Auto wall removal off for ${host}.`);
    onChange && onChange();
  };

  const pickMode = async () => {
    wc.focus();
    const pt = await wc.executeJavaScript(pickModeScript).catch(() => null);
    return pt ? hideAt(pt.x, pt.y) : null;
  };

  // Track the mouse so keyboard shortcuts can act on whatever is under the cursor.
  let mouse = { x: 0, y: 0 };
  wc.on('input-event', (_e, input) => {
    if (input.type === 'mouseMove' || input.type === 'mouseDown') mouse = { x: input.x, y: input.y };
  });

  // Shortcuts work even when a site blocks right-click: before-input-event
  // runs before the page ever sees the key press.
  wc.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || !(input.control || input.meta) || !input.shift || input.alt) return;
    const k = input.key.toLowerCase();
    if (k === 'h') { e.preventDefault(); hideAt(mouse.x, mouse.y); }
    else if (k === 'x') { e.preventDefault(); unwall(); }
    else if (k === 'm') { e.preventDefault(); showMenu({ x: mouse.x, y: mouse.y }); }
    else if (k === 's') { e.preventDefault(); onScreenshot && onScreenshot(); }
  });

  wc.on('context-menu', (_e, p) => showMenu(p));

  function showMenu(p) {
    const host = hostOf(wc.getURL());
    const hiddenCount = (load()[host] || []).length;
    const tpl = [];

    if (p.linkURL && /^https?:/i.test(p.linkURL)) {
      tpl.push(
        { label: 'Open Link in New Tab', click: () => createTab(p.linkURL) },
        { label: 'Copy Link Address', click: () => copyText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.srcURL && p.mediaType === 'image') {
      tpl.push(
        { label: 'Open Image in New Tab', click: () => createTab(p.srcURL) },
        { label: 'Copy Image Address', click: () => copyText(p.srcURL) },
        { type: 'separator' },
      );
    }
    if (p.selectionText) {
      tpl.push(
        { role: 'copy' },
        { label: `Search Google for "${p.selectionText.slice(0, 30)}${p.selectionText.length > 30 ? '…' : ''}"`,
          click: () => createTab('https://www.google.com/search?q=' + encodeURIComponent(p.selectionText)) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      tpl.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    }

    tpl.push(
      {
        label: 'Hide This Element',
        accelerator: 'CmdOrCtrl+Shift+H',
        registerAccelerator: false,
        click: () => hideAt(p.x, p.y),
      },
      {
        label: 'Remove Page Walls / Overlays',
        accelerator: 'CmdOrCtrl+Shift+X',
        registerAccelerator: false,
        click: unwall,
      },
      {
        label: 'Always Remove Walls on This Site',
        type: 'checkbox',
        checked: auto().has(host),
        enabled: !!host,
        click: (item) => setAutoWalls(item.checked),
      },
      {
        label: 'Take Screenshot',
        accelerator: 'CmdOrCtrl+Shift+S',
        registerAccelerator: false,
        click: () => onScreenshot && onScreenshot(),
      },
      {
        label: `Show Hidden Elements on This Site (${hiddenCount})`,
        enabled: hiddenCount > 0,
        click: () => {
          delete load()[host];
          save();
          wc.reload();
        },
      },
      { type: 'separator' },
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    );

    Menu.buildFromTemplate(tpl).popup();
  }

  return { hideAt, unwall, pickMode, showMenu, isAuto, setAutoWalls, getMouse: () => mouse };
}

module.exports = { attach, remember, _pickScript: pickScript, _pickModeScript: pickModeScript, _unwallScript: unwallScript, _watchScript: watchScript };

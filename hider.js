// Right-click menu + "hide this element" tool, with hidden elements remembered per site.
const { app, Menu, clipboard } = require('electron');
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
const pickScript = (x, y) => `(() => {
  let el = document.elementFromPoint(${x}, ${y});
  if (!el || el === document.documentElement || el === document.body) return null;
  const same = (a, b) => { const r = a.getBoundingClientRect(), s = b.getBoundingClientRect();
    return Math.abs(r.width - s.width) < 4 && Math.abs(r.height - s.height) < 4; };
  const up = (n) => n.parentElement && n.parentElement !== document.body && n.parentElement !== document.documentElement;
  // Clicking text inside a box should hide the box, not just the word.
  while (up(el) && getComputedStyle(el).display.startsWith('inline') && el.tagName !== 'IMG' && el.tagName !== 'IFRAME') el = el.parentElement;
  while (up(el) && same(el, el.parentElement)) el = el.parentElement;
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

// Runs in the page: remove full-screen overlays (paywalls, cookie walls, "sign up" modals)
// and undo the scroll-lock / blur they usually add.
const unwallScript = `(() => {
  let removed = 0;
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height >= vw * vh * 0.3 || (parseInt(cs.zIndex) > 999 && r.height > vh * 0.15)) { el.remove(); removed++; }
  }
  for (const el of [document.documentElement, document.body]) {
    el.style.setProperty('overflow', 'auto', 'important');
    el.style.setProperty('position', 'static', 'important');
  }
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.filter.includes('blur')) el.style.setProperty('filter', 'none', 'important');
    if (cs.pointerEvents === 'none' && el.children.length) el.style.setProperty('pointer-events', 'auto', 'important');
  }
  // Undo right-click / selection / copy blocking.
  for (const t of ['contextmenu', 'selectstart', 'copy']) {
    window.addEventListener(t, (e) => e.stopImmediatePropagation(), true);
    document['on' + t] = null; document.body['on' + t] = null;
  }
  const st = document.createElement('style');
  st.textContent = '*{user-select:text!important;-webkit-user-select:text!important}';
  document.head.append(st);
  return removed;
})()`;

function remember(host, sel) {
  const s = load();
  s[host] = [...new Set([...(s[host] || []), sel])];
  save();
  console.log('[hider] hid on', host + ':', sel);
}

function attach(wc, { createTab, onChange }) {
  // Re-apply this site's hidden elements on every page load.
  wc.on('dom-ready', () => {
    const list = load()[hostOf(wc.getURL())];
    if (list && list.length) wc.insertCSS(cssFor(list)).catch(() => {});
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
    const n = await wc.executeJavaScript(unwallScript).catch(() => 0);
    console.log('[hider] removed', n, 'overlay(s) on', hostOf(wc.getURL()));
    return n;
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
  });

  wc.on('context-menu', (_e, p) => showMenu(p));

  function showMenu(p) {
    const host = hostOf(wc.getURL());
    const hiddenCount = (load()[host] || []).length;
    const tpl = [];

    if (p.linkURL && /^https?:/i.test(p.linkURL)) {
      tpl.push(
        { label: 'Open Link in New Tab', click: () => createTab(p.linkURL) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' },
      );
    }
    if (p.srcURL && p.mediaType === 'image') {
      tpl.push(
        { label: 'Open Image in New Tab', click: () => createTab(p.srcURL) },
        { label: 'Copy Image Address', click: () => clipboard.writeText(p.srcURL) },
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

  return { hideAt, unwall, showMenu, getMouse: () => mouse };
}

module.exports = { attach, remember, _pickScript: pickScript, _unwallScript: unwallScript };

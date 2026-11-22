const $ = (id) => document.getElementById(id);
const address = $('address');
let addressDirty = false;
let lastActive = null;

for (const id of ['back', 'forward', 'home']) {
  $(id).addEventListener('click', () => window.browser.send(id));
}
$('newtab').addEventListener('click', () => window.browser.send('new-tab'));
$('shield').addEventListener('click', () => window.browser.send('toggle-blocking'));

$('addr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  addressDirty = false;
  window.browser.send('navigate', address.value);
  address.blur();
});
address.addEventListener('input', () => { addressDirty = true; });
address.addEventListener('focus', () => address.select());
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { addressDirty = false; address.blur(); }
});

window.browser.onFocusAddress(() => { address.focus(); address.select(); });

window.browser.onState((s) => {
  // Tabs
  const tabsEl = $('tabs');
  tabsEl.textContent = '';
  for (const t of s.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t.active ? ' active' : '') + (t.loading ? ' loading' : '');
    el.title = t.title;
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab (Ctrl+W)';
    close.addEventListener('click', (e) => { e.stopPropagation(); window.browser.send('close-tab', t.id); });
    el.addEventListener('click', () => window.browser.send('switch-tab', t.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) window.browser.send('close-tab', t.id); });
    el.append(title, close);
    tabsEl.append(el);
  }

  // Toolbar
  const active = s.tabs.find((t) => t.active);
  if (!active) return;
  if (active.id !== lastActive) { addressDirty = false; lastActive = active.id; }
  $('back').disabled = !active.canGoBack;
  $('forward').disabled = !active.canGoForward;
  $('reload').innerHTML = active.loading ? '&#10005;' : '&#8635;';
  $('reload').dataset.loading = active.loading ? '1' : '0';
  if (!addressDirty && document.activeElement !== address) address.value = active.url;
  document.title = active.title;

  // Walls button shows when auto-removal is on for this site
  $('tool-unwall').classList.toggle('on', !!active.autoWalls);
  $('tool-unwall').title = active.autoWalls
    ? 'Walls are removed automatically on this site. Right-click to turn off.'
    : 'Remove walls / overlays (Ctrl+Shift+X). Right-click: always remove on this site.';

  // Ad-block shield
  const shield = $('shield');
  $('count').textContent = active.blocked;
  shield.classList.toggle('off', !s.blockingEnabled);
  shield.classList.toggle('error', !s.blockerReady);
  shield.title = !s.blockerReady
    ? 'Ad blocking unavailable (filter lists failed to load)'
    : s.blockingEnabled
      ? `Ad blocking ON. ${active.blocked} blocked on this page, ${s.blockedTotal} total. Click to turn off.`
      : 'Ad blocking OFF. Click to turn on.';
});

// The reload button doubles as stop while loading.
$('reload').addEventListener('click', () => {
  window.browser.send($('reload').dataset.loading === '1' ? 'stop' : 'reload');
});

// Quick-action tools
for (const id of ['tool-unwall', 'tool-hide', 'tool-screenshot']) {
  $(id).addEventListener('click', () => {
    window.browser.send(id);
    $(id).classList.add('flash');
    setTimeout(() => $(id).classList.remove('flash'), 400);
  });
}

// Right-click the walls button = toggle "always remove walls on this site".
$('tool-unwall').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.browser.send('toggle-auto-walls');
});

let toastTimer, toastAction = null;
const toast = $('toast');
toast.addEventListener('click', () => {
  if (toastAction) window.browser.send(toastAction);
  toast.hidden = true;
});
window.browser.onToast(({ text, action }) => {
  toast.textContent = text;
  toastAction = action || null;
  toast.style.cursor = action ? 'pointer' : 'default';
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, action ? 7000 : 3500);
});

window.browser.send('ui-ready');

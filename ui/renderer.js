const $ = (id) => document.getElementById(id);
const send = (ch, data) => window.browser.send(ch, data);
const address = $('address');
let addressDirty = false;
let lastActive = null;
let state = null;

// Position just under a button, for native menus.
const below = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.bottom }; };

for (const id of ['back', 'forward', 'home']) $(id).addEventListener('click', () => send(id));
$('newtab').addEventListener('click', () => send('new-tab'));
$('shield').addEventListener('click', () => send('shield-menu', below($('shield'))));
$('menu').addEventListener('click', () => send('main-menu', below($('menu'))));
$('star').addEventListener('click', () => send('toggle-bookmark'));
$('zoom').addEventListener('click', () => send('zoom-reset'));
$('dl').addEventListener('click', () => send('open-downloads'));
$('bm-more').addEventListener('click', () => send('bookmarks-overflow', below($('bm-more'))));

$('addr-form').addEventListener('submit', (e) => {
  e.preventDefault();
  addressDirty = false;
  send('navigate', address.value);
  address.blur();
});
address.addEventListener('input', () => { addressDirty = true; });
address.addEventListener('focus', () => address.select());
address.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { addressDirty = false; address.blur(); if (state) render(state); }
});
window.browser.onFocusAddress(() => { address.focus(); address.select(); });

// ---- Find bar ----
const findInput = $('find-input');
findInput.addEventListener('input', () => send('find', { text: findInput.value }));
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') send('find', { text: findInput.value, forward: !e.shiftKey, next: true });
  else if (e.key === 'Escape') send('find-close');
});
$('find-next').addEventListener('click', () => send('find', { text: findInput.value, next: true }));
$('find-prev').addEventListener('click', () => send('find', { text: findInput.value, forward: false, next: true }));
$('find-close').addEventListener('click', () => send('find-close'));
window.browser.onFocusFind(() => {
  findInput.focus();
  findInput.select();
  if (findInput.value) send('find', { text: findInput.value });
});

// ---- Tabs (with drag to reorder) ----
let dragId = null;
function renderTabs(s) {
  const tabsEl = $('tabs');
  tabsEl.textContent = '';
  s.tabs.forEach((t, index) => {
    const el = document.createElement('div');
    el.className = 'tab' + (t.active ? ' active' : '') + (t.loading ? ' loading' : '') + (t.private ? ' private' : '');
    el.title = (t.private ? '[Private] ' : '') + t.title;
    el.draggable = true;

    let fav;
    if (t.favicon && !t.loading) {
      fav = document.createElement('img');
      fav.className = 'fav';
      fav.src = t.favicon;
      fav.onerror = () => { fav.replaceWith(Object.assign(document.createElement('span'), { className: 'fav none' })); };
    } else {
      fav = document.createElement('span');
      fav.className = 'fav none';
    }
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = t.title;
    el.append(fav, title);

    if (t.audible || t.muted) {
      const audio = document.createElement('button');
      audio.className = 'audio';
      audio.textContent = t.muted ? '\u{1F507}' : '\u{1F50A}';
      audio.title = t.muted ? 'Unmute tab' : 'Mute tab';
      audio.addEventListener('click', (e) => { e.stopPropagation(); send('toggle-mute', t.id); });
      el.append(audio);
    }
    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close tab (Ctrl+W)';
    close.addEventListener('click', (e) => { e.stopPropagation(); send('close-tab', t.id); });
    el.append(close);

    el.addEventListener('click', () => send('switch-tab', t.id));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) send('close-tab', t.id); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); send('tab-menu', { id: t.id, x: e.clientX, y: e.clientY }); });

    el.addEventListener('dragstart', (e) => { dragId = t.id; el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragend', () => { dragId = null; el.classList.remove('dragging'); });
    el.addEventListener('dragover', (e) => {
      if (dragId == null || dragId === t.id) return;
      e.preventDefault();
      const after = e.offsetX > el.clientWidth / 2;
      el.classList.toggle('drop-after', after);
      el.classList.toggle('drop-before', !after);
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-after', 'drop-before'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('drop-after', 'drop-before');
      if (dragId == null || dragId === t.id) return;
      const from = s.tabs.findIndex((x) => x.id === dragId);
      let to = index + (e.offsetX > el.clientWidth / 2 ? 1 : 0);
      if (from < to) to--;
      send('move-tab', { id: dragId, index: to });
    });
    tabsEl.append(el);
  });
}

// ---- Bookmarks bar ----
let bookmarksKey = '';
function renderBookmarks(s) {
  $('bookmarks').hidden = !s.showBookmarksBar;
  const key = JSON.stringify(s.bookmarks);
  if (key === bookmarksKey) return;
  bookmarksKey = key;
  const list = $('bm-list');
  list.textContent = '';
  if (!s.bookmarks.length) {
    list.append(Object.assign(document.createElement('span'), { className: 'bm-empty', textContent: 'Bookmark a page with the ☆ in the address bar or Ctrl+D' }));
  }
  for (const b of s.bookmarks) {
    const el = document.createElement('button');
    el.className = 'bm';
    el.title = `${b.title}\n${b.url}`;
    if (b.favicon) {
      const img = document.createElement('img');
      img.src = b.favicon;
      img.onerror = () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'dot' }));
      el.append(img);
    } else {
      el.append(Object.assign(document.createElement('span'), { className: 'dot' }));
    }
    el.append(Object.assign(document.createElement('span'), { textContent: b.title || b.url }));
    el.addEventListener('click', (e) => send('open-bookmark', { id: b.id, newTab: e.ctrlKey }));
    el.addEventListener('auxclick', (e) => { if (e.button === 1) send('open-bookmark', { id: b.id, newTab: true }); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); send('bookmark-menu', { id: b.id, x: e.clientX, y: e.clientY }); });
    list.append(el);
  }
}

function render(s) {
  renderTabs(s);
  renderBookmarks(s);

  const active = s.tabs.find((t) => t.active);
  if (!active) return;
  if (active.id !== lastActive) { addressDirty = false; lastActive = active.id; }
  $('back').disabled = !active.canGoBack;
  $('forward').disabled = !active.canGoForward;
  $('reload').innerHTML = active.loading ? '&#10005;' : '&#8635;';
  $('reload').dataset.loading = active.loading ? '1' : '0';
  if (!addressDirty && document.activeElement !== address) address.value = active.url;
  document.title = active.title;

  $('addr-form').classList.toggle('private', active.private);
  $('private-badge').hidden = !active.private;
  $('star').classList.toggle('on', active.bookmarked);
  $('star').innerHTML = active.bookmarked ? '&#9733;' : '&#9734;';
  $('star').title = active.bookmarked ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
  $('zoom').hidden = active.zoom === 100;
  $('zoom').textContent = active.zoom + '%';

  // Walls button shows when auto-removal is on for this site
  $('tool-unwall').classList.toggle('on', !!active.autoWalls);
  $('tool-unwall').title = active.autoWalls
    ? 'Walls are removed automatically on this site. Right-click to turn off.'
    : 'Remove walls / overlays (Ctrl+Shift+X). Right-click: always remove on this site.';

  // Downloads button appears once something has been downloaded
  const dl = s.downloads;
  $('dl').hidden = dl.count === 0;
  $('dl').classList.toggle('busy', dl.active > 0);
  $('dl-bar').style.transform = `scaleX(${dl.active > 0 ? Math.max(0.05, dl.progress < 0 ? 0.5 : dl.progress) : 0})`;
  $('dl').title = dl.active > 0 ? `Downloading ${dl.active} file(s)${dl.progress >= 0 ? `, ${Math.round(dl.progress * 100)}%` : ''}` : 'Downloads (Ctrl+J)';

  // Ad-block shield
  const shield = $('shield');
  const off = !s.blockingEnabled || active.siteAllowed;
  $('count').textContent = active.blocked;
  shield.classList.toggle('off', off);
  shield.classList.toggle('error', !s.blockerReady);
  shield.title = !s.blockerReady
    ? 'Ad blocking unavailable (filter lists failed to load)'
    : !s.blockingEnabled ? 'Ad blocking is paused everywhere. Click for options.'
      : active.siteAllowed ? 'Ad blocking is off on this site. Click for options.'
        : `Ad blocking ON. ${active.blocked} blocked on this page, ${s.blockedTotal} total. Click for options.`;

  // Find bar
  $('findbar').hidden = !s.find.open;
  $('find-count').textContent = s.find.open && findInput.value ? (s.find.matches ? `${s.find.active} of ${s.find.matches}` : 'No matches') : '';
  findInput.classList.toggle('nomatch', !!(findInput.value && s.find.matches === 0));
}

window.browser.onState((s) => { state = s; render(s); });

// The reload button doubles as stop while loading.
$('reload').addEventListener('click', () => send($('reload').dataset.loading === '1' ? 'stop' : 'reload'));

// Quick-action tools
for (const id of ['tool-unwall', 'tool-hide', 'tool-screenshot']) {
  $(id).addEventListener('click', () => {
    send(id);
    $(id).classList.add('flash');
    setTimeout(() => $(id).classList.remove('flash'), 400);
  });
}

// Right-click the walls button = toggle "always remove walls on this site".
$('tool-unwall').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  send('toggle-auto-walls');
});

let toastTimer, toastAction = null;
const toast = $('toast');
toast.addEventListener('click', () => {
  if (toastAction) send(toastAction);
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

send('ui-ready');

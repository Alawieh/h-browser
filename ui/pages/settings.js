const $ = (id) => document.getElementById(id);
const set = (key, value) => call('setSetting', { key, value }).then(load);
const chip = (text, onRemove, title) => h('span.chip', { title: title || text }, h('span', text), h('button', { title: 'Remove', onclick: onRemove }, '✕'));

async function load() {
  const d = await call('getSettings');
  const s = d.settings;

  if (document.activeElement !== $('home')) $('home').value = s.home;
  $('search').textContent = '';
  for (const [k, name] of Object.entries(d.engines)) $('search').append(h('option', { value: k, selected: k === s.search }, name));
  $('restoreTabs').checked = s.restoreTabs;
  $('showBookmarksBar').checked = s.showBookmarksBar;
  $('dldir').textContent = s.downloadDir || d.defaultDownloadDir;
  $('blockLevel').value = s.blockLevel;
  $('version').textContent = d.version;

  $('allow').textContent = '';
  if (!s.allowSites.length) $('allow').append(h('div.hint', 'None. Ads are blocked everywhere.'));
  for (const host of s.allowSites) $('allow').append(chip(host, () => set('allowSites', s.allowSites.filter((x) => x !== host))));

  $('auto').textContent = '';
  if (!d.autoSites.length) $('auto').append(h('div.hint', 'None yet. Right-click the wall button in the toolbar on a site to add it.'));
  for (const host of d.autoSites) $('auto').append(chip(host, () => call('setAutoSite', { host, on: false }).then(load)));

  $('hidden').textContent = '';
  const hosts = Object.keys(d.hidden).sort();
  if (!hosts.length) $('hidden').append(h('div.hint', 'Nothing hidden yet.'));
  for (const host of hosts) {
    $('hidden').append(h('h3', host, ' ', h('button.link', { onclick: () => call('unhide', { host }).then(load) }, 'show all')));
    for (const sel of d.hidden[host]) $('hidden').append(chip(sel.length > 60 ? '…' + sel.slice(-60) : sel, () => call('unhide', { host, selector: sel }).then(load), sel));
  }

  const bm = $('bmlist');
  bm.textContent = '';
  if (!d.bookmarks.length) bm.append(h('div.empty', 'No bookmarks yet. Click the ☆ in the address bar or press Ctrl+D.'));
  d.bookmarks.forEach((b, i) => {
    const title = h('input', { type: 'text', value: b.title, style: 'width:100%' });
    const url = h('input', { type: 'text', value: b.url, style: 'width:100%;margin-top:4px;font-size:12px' });
    const save = () => call('saveBookmark', { id: b.id, title: title.value, url: url.value });
    title.addEventListener('change', save);
    url.addEventListener('change', save);
    bm.append(h('div.row',
      favicon(b.url),
      h('div.grow', title, url),
      h('button.link', { title: 'Move up', disabled: i === 0, onclick: () => call('moveBookmark', { id: b.id, delta: -1 }).then(load) }, '↑'),
      h('button.link', { title: 'Move down', disabled: i === d.bookmarks.length - 1, onclick: () => call('moveBookmark', { id: b.id, delta: 1 }).then(load) }, '↓'),
      h('button.link', { title: 'Delete', onclick: () => call('deleteBookmark', { id: b.id }).then(load) }, '✕')));
  });
}

$('home').addEventListener('change', () => set('home', $('home').value));
$('search').addEventListener('change', () => set('search', $('search').value));
$('restoreTabs').addEventListener('change', () => set('restoreTabs', $('restoreTabs').checked));
$('showBookmarksBar').addEventListener('change', () => set('showBookmarksBar', $('showBookmarksBar').checked));
$('blockLevel').addEventListener('change', () => set('blockLevel', $('blockLevel').value));
$('dlchange').addEventListener('click', () => call('chooseDownloadDir').then(load));
$('dlreset').addEventListener('click', () => set('downloadDir', ''));
$('autoAddBtn').addEventListener('click', () => {
  const host = $('autoAdd').value.trim().replace(/^https?:\/\//, '').split('/')[0];
  if (!host) return;
  $('autoAdd').value = '';
  call('setAutoSite', { host, on: true }).then(load);
});
$('clearData').addEventListener('click', async () => {
  const opts = { history: $('cHistory').checked, cookies: $('cCookies').checked, cache: $('cCache').checked };
  if (!opts.history && !opts.cookies && !opts.cache) return;
  await call('clearData', opts);
  $('clearData').textContent = 'Cleared ✓';
  setTimeout(() => { $('clearData').textContent = 'Clear'; }, 2000);
});
$('checkUpd').addEventListener('click', async () => {
  $('updStatus').textContent = 'Checking…';
  $('updStatus').textContent = await call('checkUpdates');
});
load();

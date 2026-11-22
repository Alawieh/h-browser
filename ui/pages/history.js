const list = document.getElementById('list');
const q = document.getElementById('q');

async function load() {
  const items = await call('getHistory', { query: q.value, limit: 1000 });
  list.textContent = '';
  if (!items.length) {
    list.append(h('div.empty', q.value ? 'Nothing found.' : 'No history yet. Pages you visit show up here (private tabs are never saved).'));
    return;
  }
  let day = null, card = null;
  for (const it of items) {
    const label = dayLabel(it.time);
    if (label !== day) {
      day = label;
      card = h('div.card');
      list.append(h('h2', label), card);
    }
    const row = h('div.row',
      h('span.time', clock(it.time)),
      favicon(it.url),
      h('div.grow',
        h('a.ellipsis', { href: it.url, title: it.url, style: 'display:block' }, it.title || it.url),
        h('div.hint.ellipsis', it.url)),
      h('button.link', {
        title: 'Remove from history',
        onclick: async () => { await call('deleteHistory', { url: it.url, time: it.time }); row.remove(); },
      }, '✕'));
    card.append(row);
  }
}

let timer;
q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 150); });
document.getElementById('clear').addEventListener('click', async () => {
  if (!confirm('Delete all browsing history? This cannot be undone.')) return;
  await call('clearHistory');
  load();
});
load();

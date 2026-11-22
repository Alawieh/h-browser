const list = document.getElementById('list');
const act = (id, action) => call('downloadAction', { id, action }).then(load);
let lastKey = '';

async function load() {
  const items = await call('getDownloads');
  const key = JSON.stringify(items);
  if (key === lastKey) return;
  lastKey = key;
  list.textContent = '';
  if (!items.length) {
    list.append(h('div.empty', 'No downloads yet.'));
    return;
  }
  const card = h('div.card');
  list.append(card);
  for (const d of items) {
    const busy = d.state === 'progressing';
    const pct = d.total ? Math.round((d.received / d.total) * 100) : null;
    let status;
    if (busy) status = `${d.paused ? 'Paused' : 'Downloading'} · ${size(d.received)}${d.total ? ' of ' + size(d.total) : ''}${pct != null ? ` (${pct}%)` : ''}`;
    else if (d.state === 'completed') status = `${size(d.total || d.received)} · ${dayLabel(d.time)} ${clock(d.time)}`;
    else if (d.state === 'cancelled') status = 'Cancelled';
    else status = 'Failed';

    const buttons = [];
    if (d.state === 'completed') {
      buttons.push(h('button', { onclick: () => act(d.id, 'open') }, 'Open'), h('button', { onclick: () => act(d.id, 'show') }, 'Show in folder'));
    } else if (busy) {
      buttons.push(
        d.paused ? h('button', { onclick: () => act(d.id, 'resume') }, 'Resume') : h('button', { onclick: () => act(d.id, 'pause') }, 'Pause'),
        h('button.danger', { onclick: () => act(d.id, 'cancel') }, 'Cancel'));
    } else {
      buttons.push(h('button', { onclick: () => act(d.id, 'retry') }, 'Try again'));
    }
    buttons.push(h('button.link', { title: 'Remove from list', onclick: () => act(d.id, 'remove') }, '✕'));

    card.append(h('div.row',
      h('div.grow',
        d.state === 'completed'
          ? h('a.ellipsis', { href: '#', style: 'display:block', onclick: (e) => { e.preventDefault(); act(d.id, 'open'); } }, d.filename)
          : h('div.ellipsis.label', { style: d.state === 'cancelled' || d.state === 'interrupted' ? 'text-decoration:line-through;opacity:.7' : '' }, d.filename),
        h('div.hint.ellipsis', { title: d.url }, status + ' · ' + d.url),
        busy ? h('div.bar', h('div', { style: `width:${pct ?? 50}%` })) : null),
      buttons));
  }
}

document.getElementById('clear').addEventListener('click', () => call('clearDownloads').then(load));
call('getSettings').then((s) => {
  document.getElementById('where').textContent = 'Files are saved to ' + (s.settings.downloadDir || s.defaultDownloadDir) + '. Change it in Settings.';
});
load();
setInterval(load, 700);

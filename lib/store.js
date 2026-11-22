// Tiny JSON file store in the user data folder (%APPDATA%\H Browser).
// Writes are batched so frequent changes (history, open tabs) don't hammer the disk.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const cache = {};
const timers = {};

const file = (name) => path.join(app.getPath('userData'), name + '.json');

function load(name, fallback) {
  if (!(name in cache)) {
    try { cache[name] = JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { cache[name] = fallback; }
  }
  return cache[name];
}

function writeNow(name) {
  clearTimeout(timers[name]);
  delete timers[name];
  try { fs.writeFileSync(file(name), JSON.stringify(cache[name])); } catch (e) { console.error('[store] save failed', name, e.message); }
}

function save(name, value, { delay = 500 } = {}) {
  if (value !== undefined) cache[name] = value;
  clearTimeout(timers[name]);
  timers[name] = setTimeout(() => writeNow(name), delay);
}

// Flush pending writes (call before quitting).
function flush() {
  for (const name of Object.keys(timers)) writeNow(name);
}

module.exports = { load, save, flush };

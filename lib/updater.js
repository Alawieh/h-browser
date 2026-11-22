// Automatic updates from GitHub releases.
// Installed copy: downloads the update in the background and offers to restart.
// Portable copy: can't update itself, so it tells you a new version is out.
const { app, shell } = require('electron');
const fetch = require('cross-fetch');

const REPO = 'Alawieh/h-browser';
const RELEASES = `https://github.com/${REPO}/releases/latest`;
const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_DIR;

let toast = () => {};
let autoUpdater = null;
let ready = null; // version downloaded and waiting for restart

function newer(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function latestVersion() {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': 'h-browser-updater', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('GitHub answered ' + r.status);
  return (await r.json()).tag_name;
}

async function check() {
  if (!app.isPackaged) return 'Updates only work in the installed app.';
  if (ready) return `Version ${ready} is downloaded. Restart the browser to install it.`;
  try {
    if (autoUpdater) {
      const r = await autoUpdater.checkForUpdates();
      const v = r && r.updateInfo && r.updateInfo.version;
      if (v && newer(v, app.getVersion())) return `Downloading version ${v}. You'll be asked to restart when it's ready.`;
      return `You have the latest version (${app.getVersion()}).`;
    }
    const v = await latestVersion();
    if (newer(v, app.getVersion())) {
      toast(`Version ${v.replace(/^v/, '')} is out. Click to download it.`, 'install-update');
      return `Version ${v.replace(/^v/, '')} is available. Download it from the releases page.`;
    }
    return `You have the latest version (${app.getVersion()}).`;
  } catch (e) {
    return "Couldn't check for updates: " + e.message;
  }
}

function init(opts) {
  toast = opts.toast;
  if (!app.isPackaged) return;
  if (!isPortable()) {
    try {
      ({ autoUpdater } = require('electron-updater'));
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      autoUpdater.logger = null;
      autoUpdater.on('update-downloaded', (info) => {
        ready = info.version;
        toast(`Update ${info.version} is ready. Click to restart and install it.`, 'install-update');
      });
      autoUpdater.on('error', (e) => console.error('[update]', e.message));
    } catch (e) {
      console.error('[update] unavailable:', e.message);
      autoUpdater = null;
    }
  }
  const quiet = () => (autoUpdater ? autoUpdater.checkForUpdates().catch(() => {}) : check());
  setTimeout(quiet, 15 * 1000);
  setInterval(quiet, 6 * 3600 * 1000);
}

function install() {
  if (autoUpdater && ready) autoUpdater.quitAndInstall(true, true);
  else shell.openExternal(RELEASES);
}

module.exports = { init, check, install };

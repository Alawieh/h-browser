<p align="center">
  <img src="build/icon.png" width="128" alt="H Browser icon">
</p>

<h1 align="center">H Browser</h1>

<p align="center">
  A fast, simple web browser that blocks ads, trackers and popups out of the box.<br>
  <b>Free. Open source. No accounts, no telemetry.</b>
</p>

<p align="center">
  <a href="https://github.com/Alawieh/h-browser/releases/latest"><b>⬇ Download for Windows</b></a>
</p>

---

## Install (Windows)

1. Go to the **[latest release](https://github.com/Alawieh/h-browser/releases/latest)**.
2. Download **`H-Browser-Setup-x.x.x.exe`**.
3. Double-click it. It installs and opens automatically, and adds a Desktop and Start Menu shortcut.

> **"Windows protected your PC"?** That warning shows for apps without a paid code-signing certificate.
> Click **More info**, then **Run anyway**. The full source is right here if you want to check it.

**Don't want to install anything?** Download **`H-Browser-Portable-x.x.x.exe`** instead and just run it. You can keep it on a USB stick.

**Uninstall:** Windows Settings → Apps → Installed apps → *H Browser* → Uninstall.

**Updates:** the installed version updates itself. When a new version is ready you get a message to restart. The portable version tells you when a new version is out.

> Coming from **Hussein Browser** (the old name)? Install H Browser and your bookmarks, logins, hidden elements and settings come with you.

---

## Features

- **Ad and tracker blocking.** Uses the same community filter lists as popular ad blockers (EasyList, EasyPrivacy and others) through the [Ghostery adblocker engine](https://github.com/ghostery/adblocker). Lists update automatically.
- **Popup blocking.** A site can only open a new tab right after you click. Popups that match ad filters are blocked even then.
- **Wall remover.** Get rid of paywall overlays, "disable your ad blocker" boxes, cookie walls, sign-up pop-ups and invisible click-hijacking layers. It also unlocks scrolling and turns right-click and text selection back on.
- **Auto wall removal.** If a site keeps showing the wall again on every new screen, turn on *Always Remove Walls on This Site*. The browser then removes walls as soon as they appear. Video players are left alone.
- **Hide any element.** Click the 👁 button and then click anything, or right-click it and choose *Hide This Element*. It stays hidden every time you visit that site.
- **Screenshots.** One click saves the visible page to `Pictures\H Browser` and copies it to your clipboard, ready to paste.
- **Bookmarks.** Click the ☆ in the address bar or press `Ctrl+D`. They show on the bookmarks bar; rename, reorder or delete them in Settings.
- **History.** Search everything you visited (`Ctrl+H`), delete single entries or clear it all.
- **Downloads.** Progress in the toolbar, plus a downloads page (`Ctrl+J`) to open, show in folder, pause, resume, cancel or retry.
- **Private tabs.** `Ctrl+Shift+N`. Not saved to history, and cookies and site data are wiped when you close the last private tab.
- **Tabs that come back.** Your tabs reopen when you start the browser (they load when you click them, so starting stays fast). Closed one by mistake? `Ctrl+Shift+T`.
- **Tabs you can arrange.** Drag to reorder, right-click for duplicate / mute / close others, and a 🔊 icon on tabs playing sound (click to mute).
- **Find on page** (`Ctrl+F`), **zoom** (`Ctrl +` / `Ctrl −` / `Ctrl 0`, remembered per site), **print** (`Ctrl+P`).
- **Picture in picture.** Pop a video out into a small floating window (`Ctrl+Shift+P`, or right-click the video).
- **Choose your search engine.** Google by default; Bing, DuckDuckGo or Brave Search in Settings.
- **Shield menu.** The green shield shows how many things were blocked on the current page. Click it to turn blocking off for one site (remembered) or pause it everywhere.
- **Two blocking levels.** *Standard* blocks ads and trackers. *Strong* also hides cookie banners, newsletter pop-ups and other annoyances. Filter lists refresh every 3 days.
- **Settings page.** Home page, search engine, download folder, blocking level, sites with blocking off, auto-wall sites, hidden elements, bookmarks and clearing your data, all in one place (⋮ menu → Settings).

### Toolbar quick actions

The three buttons next to the address bar:

| Button | Click | Right-click |
|---|---|---|
| 🧱 **Remove walls** | Removes walls / overlays on this page now | Turns *always remove walls on this site* on or off (the button turns green while it's on) |
| 👁 **Hide element** | Then click anything on the page to hide it. Press `Esc` to cancel | — |
| 📷 **Screenshot** | Saves a PNG and copies it to the clipboard | — |

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+H` | Hide the element under your mouse |
| `Ctrl+Shift+X` | Remove walls / overlays on this page |
| `Ctrl+Shift+M` | Open the tools menu at your mouse (works even when a site blocks right-click) |
| `Ctrl+Shift+S` | Take a screenshot |
| `Ctrl+Shift+P` | Picture in picture |
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+Shift+T` | Reopen closed tab |
| `Ctrl+Shift+N` | New private tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+D` | Bookmark this page |
| `Ctrl+Shift+B` | Show / hide bookmarks bar |
| `Ctrl+H` / `Ctrl+J` | History / downloads |
| `Ctrl+F`, `F3` | Find on page, find next |
| `Ctrl +` / `Ctrl −` / `Ctrl 0` | Zoom in / out / reset |
| `Ctrl+P` | Print |
| `Ctrl+L` | Jump to the address bar |
| `Ctrl+R` or `F5` | Reload |
| `Alt+←` / `Alt+→` | Back / forward |
| `F11` | Full screen (`Esc` to exit) |
| `F12` | Developer tools |

The `Ctrl+Shift` shortcuts reach the browser before the web page sees them, so sites can't block them.

To undo hidden elements on a site, right-click → **Show Hidden Elements on This Site**, or remove single ones in Settings.

---

## Free for everyone, do whatever you want with it

This project is released under the **[MIT License](LICENSE)**. In plain words:

- ✅ Use it for free, personally or commercially
- ✅ Copy it, fork it, change it, rename it, rebrand it
- ✅ Ship it inside your own products, open source or closed
- ✅ Sell it if you like

The only condition is to keep the license text in your copy. No permission needed and no need to ask. Pull requests are welcome but never required.

---

## For developers

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
git clone https://github.com/Alawieh/h-browser.git
cd h-browser
npm install
npm start          # run the browser
npm run dist       # build the Windows installer + portable .exe into dist/
```

### How it's put together

| File | What it does |
|---|---|
| `main.js` | Main process: window, tabs (one `WebContentsView` each), ad blocker setup, popup blocking, navigation |
| `lib/` | `store.js` (saves settings, bookmarks, history as JSON) and `updater.js` (auto-update from GitHub releases) |
| `hider.js` | Right-click menu, *Hide This Element* and click-to-hide mode, wall remover and auto-removal watcher, keyboard shortcuts, per-site memory |
| `ui/` | The tab bar and toolbar (HTML/CSS/JS) and its preload bridge |
| `ui/pages/` | The browser's own pages: `hb://settings`, `hb://history`, `hb://downloads` |
| `build/` | App icon used for the installer |

Some useful places to start:

- **Change the default home page or add a search engine:** `DEFAULTS` and `SEARCH` at the top of `main.js`.
- **Use different filter lists:** change `initBlocker()` in `main.js`, for example to `ElectronBlocker.fromLists(fetch, [urls])`.
- **Publish a release with auto-update:** `npm run dist`, then upload the `.exe` files, `latest.yml` and the `.blockmap` from `dist/` to a GitHub release.
- **Build for macOS/Linux:** add `mac` / `linux` targets in the `build` section of `package.json` and run `npx electron-builder --mac` or `--linux` on that OS.

### Security

Web pages run sandboxed with `contextIsolation` on and Node.js turned off. Only the browser's own toolbar and its `hb://` pages can talk to the main process, through small allow-lists of messages that are checked on every call.

Your data stays on your computer. Browsing data and the list of hidden elements are saved in `%APPDATA%\H Browser`.

---

## Known limits

- Ad blocking is filter-list based, so **YouTube video ads are not reliably blocked**.
- Some paywalls never send the article to your browser at all. The wall remover can't bring back text that was never loaded.
- No sync or extensions yet. PRs welcome!

## Credits

- Ad blocking engine: [@ghostery/adblocker](https://github.com/ghostery/adblocker) (MPL-2.0)
- Built on [Electron](https://www.electronjs.org)

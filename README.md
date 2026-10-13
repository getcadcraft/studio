# CadCraft Studio

**The eight CadCraft apps together in one install**, with a home screen (the hub) that opens them, sends each file to
the app that reads it, and keeps their windows in touch. Studio is not another app: every app in it is the same browser
edition that ships on its own, unchanged. It comes two ways: a browser edition (one folder of plain files for any web
server) and a desktop install (the same folder inside the CadCraft desktop shell, in suite mode).

Website: https://getcadcraft.com. Every CadCraft repo: https://github.com/getcadcraft

```
studio/
  hub/                  the hub (plain JS, no build step)
    index.html          the page; pack/suite.mjs fills it in
    hub.js, hub.css     the home screen: app tiles, open and drop files, recent files, windows, account, offline
    route.js            which app opens a file (by type; the PDF question; "always use")
    channel.js          the one message channel between Studio's windows
    window.js           what every app window in Studio carries (the Studio button, the channel)
    handoff.js          hands a file to an app window without uploading it
    cloud.js            the account card's data and the queue for saves made while offline
    lang/               the hub's words (en, es-MX); the product name lives only here
  pack/                 the suite packer
    suite.mjs           eight browser editions → one folder, one origin, libraries stored once → out/studio-suite/v<build>/
    catalog.php         the lineup facts the hub shows, from the site's Catalog
    render-suite.php    each app's page rendered again so the apps beside it count (handoffs between apps)
    suite-stubs.php     what render-suite.php loads first
    sw.js               "Save for offline" for the whole folder
    INSTALL.md          the browser edition's install guide (shipped in the folder)
  test/
    test-hub.mjs        the DOM-free modules and the language file, no browser     node test/test-hub.mjs
    browser.mjs         the packed suite in Chromium (Playwright)                   node test/browser.mjs
    desktop.mjs         Studio inside the real desktop shell (WebKitGTK)            dbus-run-session -- xvfb-run -a node test/desktop.mjs
    lib.mjs             what the tests share
```

## The site's checkout

The apps' browser editions are made by the getcadcraft.com site's own packer, so building Studio needs the site's
checkout, which is not part of this repo. Scripts find it, and the desktop shell, only through environment variables,
and stop with a message when one is needed and unset:

| Variable | What it points at | Used by |
|---|---|---|
| `CADCRAFT_SITE` | the site's folder | `pack/suite.mjs` (and the two PHP files it runs), `test/browser.mjs`, `test/desktop.mjs`, `test/test-hub.mjs` (one check) |
| `CADCRAFT_SHELL` | the desktop shell's folder ([getcadcraft/desktop-shell](https://github.com/getcadcraft/desktop-shell)) | `test/desktop.mjs`, `test/test-hub.mjs` (one check) |

## Build

```
CADCRAFT_SITE=<site> node pack/suite.mjs                   # dev builds of the eight apps → out/studio-suite/vdev/
CADCRAFT_SITE=<site> node pack/suite.mjs --build 0.4 --zip # a release + out/cadcraft-studio-browser-v0.4.zip + SHA256SUMS
```

Options: `--apps a,b` (a subset), `--editions <dir>` (reuse editions packed already), `--out <dir>`, `--allow-gate`
(spikes only). Run it as root on the site's server: it runs PHP as the web server's user. An app whose edition fails
to pack, or fails the license and secrets gate, is left out and listed in `release.json`, never shipped half-built. The
finished folder goes through the same gate.

The desktop install is built by the desktop shell from that folder:

```
node build.mjs studio --edition <studio>/out/studio-suite/v0.4     # in the desktop-shell repo
```

## Tests

- `node test/test-hub.mjs`: routing, the window channel, the cloud client and its save queue, the handoff record, the
  language file and the license lines. No browser. Two checks compare with the site (`CADCRAFT_SITE`) and the desktop
  shell (`CADCRAFT_SHELL`) and skip when those are unset.
- `node test/browser.mjs [--build dev] [--shots <dir>]`: the packed suite in Chromium, served from a deep sub-folder by
  a plain static server: every app opens, files route by type, handoffs, recent files, the window channel, themes,
  offline. Fails on any console error or any request that leaves the suite's folder. Needs `playwright-core` in
  `node_modules/` (with its Chromium) and `CADCRAFT_SITE` for the test drawings.
- `dbus-run-session -- xvfb-run -a node test/desktop.mjs [--shots <dir>]`: Studio in the desktop shell's debug build,
  signed in to getcadcraft.com with the site's own test member (the helper that sets it up stays with the site). Needs
  `CADCRAFT_SHELL`, `CADCRAFT_SITE`, WebKitWebDriver and gnome-keyring.

## License

Apache-2.0 (`LICENSE`). The libraries the apps use keep their own licenses, listed in each build's `THIRD_PARTY.md`.

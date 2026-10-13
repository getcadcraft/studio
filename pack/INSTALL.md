# Install {{NAME}} (browser edition)

{{NAME}} is the home screen for the CadCraft apps, with the apps themselves, in one folder of plain files. It runs in
Chrome, Edge, Firefox or Safari from any web server, in any folder. No account, no database, nothing to build.

## 1. Get it

Download the zip from the Releases page and check its SHA-256 against the one published next to it:

    sha256sum cadcraft-studio-browser-v{{BUILD}}.zip        (Windows: certutil -hashfile <file> SHA256)

Unzip it anywhere. The folder holds:

- `index.html`: Studio, the hub
- `apps/<app>/`: each app (listed below)
- `assets/`: the libraries the apps share, stored once
- `LICENSE`, `NOTICE`, `THIRD_PARTY.md`: the licenses (each app's own list is in its folder)

{{APPS}}

## 2. Put it on a web server

Any server that serves static files works. To try it on your own computer, open a terminal in the folder and run one of:

    python3 -m http.server 8080
    php -S localhost:8080
    npx serve -l 8080

On a real server, copy the folder into the web root or any subfolder (for example `https://example.com/tools/studio/`).
The folder carries `.htaccess` (Apache) and `web.config` (IIS) with the file types it needs. For nginx and Caddy, make
sure `.wasm` files are served as `application/wasm` (the apps also work when they are not, a little slower to start).

## 3. Open it

Open the folder's address in your browser (for example `http://localhost:8080/`). Studio lists the apps; Open starts one
in a new tab. Drop a drawing, model or PDF on Studio to open it in the app that reads it.

**Why double-clicking index.html does not work:** browsers do not run apps like these from `file://` addresses (modules,
workers and offline storage need a web address). Use one of the commands above instead.

## Working offline

Choose **Save for offline** in Studio (or in any app's bar) once while you are online. After that, Studio and the saved
apps open without a connection.

## Updating

Replace the folder with the new version's folder. Your settings, recent files and unsaved work stay in your browser
(they belong to the address, not to the files).

## Removing it

Delete the folder. To clear what the browser kept (settings, recent files, the offline copy), clear the site data for
its address in your browser's settings.

# Desktop app (Electron)

CAD Modeler runs as an Electron desktop app. The production app does not start a web server: the built `dist/` folder is served to the window through a custom `app://local/` protocol.

## Running

| What | Command |
| --- | --- |
| Normal use | Double-click `Start CAD Modeler.bat`, or `npm start` / `npm run desktop` |
| Development (hot reload) | `npm run desktop:dev` |
| Browser-only development | `npm run dev` (http://localhost:5180, as before) |
| Smoke test | `npm run smoke` |
| Windows installer + portable exe | `npm run package` (output in `release/`) |
| Unpacked build for testing | `npm run package:dir` (`release/win-unpacked/CAD Modeler.exe`) |

- **Start CAD Modeler.bat** runs `npm install` if `node_modules` is missing, rebuilds `dist/` if it is missing or older than `src/`, `index.html` or `vite.config.js`, starts Electron detached, and closes its console window. If something fails, the window stays open with the error.
- **`npm start`** does the same build check, then runs Electron in the foreground so main-process logs show in the terminal.
- **`npm run desktop:dev`** starts Vite on port 5180 (strict), waits for it, and then opens Electron on `http://localhost:5180`. Closing the window stops Vite.
- **Smoke test:** `electron . --smoke` loads the page, waits for `window.__app` (that is, until OpenCascade is initialised), prints `SMOKE OK` or `SMOKE FAIL` with any console warnings and errors, and quits. `--smoke-ipc` also runs `saveBugReport`, `cfd.writeCase` and `cfd.readResults` and the path-traversal checks, then deletes what it wrote. Both flags also work with `--dev-url=...`.

If npm skipped Electron's install script, `electron/run.cjs` downloads the Electron runtime the first time it runs.

## Files

- `electron/main.cjs`: main process. Handles the window, the `app://` protocol, IPC handlers, window-state persistence, the single-instance lock and `--smoke`.
- `electron/preload.cjs`: exposes `window.desktop` through `contextBridge`. Every call goes through `ipcRenderer.invoke`.
- `electron/bugreport-writer.cjs`: writes bug-report folders. Shared by the Vite dev middleware and the main process.
- `electron/run.cjs`: launcher with the modes start, launch, build and dev.
- `src/platform.js`: the renderer's single OS interface, with browser fallbacks. App code should import this module and never use `window.desktop` directly.

## Window behaviour

- The default menu is removed. Keyboard shortcuts go to the page, except F12 and Ctrl+Shift+I (DevTools) and Ctrl+Shift+R (reload).
- Window size, position and maximized state are saved to `%APPDATA%\CAD Modeler\window-state.json`.
- Only one instance can run. Starting a second instance focuses the first.
- `window.open` and navigation away from the app are blocked. http(s) and mailto links open in the default browser.

## Storage

- The renderer's `localStorage` (autosave and preferences) lives under the stable origin `app://local`, in `%APPDATA%\CAD Modeler\`. It persists between launches; the smoke test checks this. The dev-server origin (`http://localhost:5180`) has its own separate storage, so designs autosaved in browser or dev mode do not appear in the production app. Use File > Save/Open to move them.
- `%APPDATA%\CAD Modeler\config.json` holds the CFD settings (`cfd.cfdDir`, `cfd.pythonCmd`, `cfd.exchangeDir`) and `lastDir`, the last folder used in a Save or Open dialog.
- Bug reports go to `<project>/bug-reports/` when running from source, and to `Documents\CAD Modeler\bug-reports\` in a packaged build.
- "Documents" means `%USERPROFILE%\Documents` when that folder exists, otherwise the shell's Documents folder, which may be on OneDrive.

## Security model

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. IPC handlers reject senders that are not on `app://local` or the dev URL.
- No IPC call can write to an arbitrary path. Writes go only to:
  - a path the user picked in a native Save dialog (`saveFile`)
  - `<exchangeDir>/<folderName>/…` (`cfd.writeCase`). Folder and file names are validated, and `..`, absolute paths and drive letters are rejected.
  - the bug-report folder (`saveBugReport`)
- `cfd.launch` always runs `<pythonCmd> main.py --case <dir>` with the working directory set to `cfdDir`. The case folder must be inside `exchangeDir` and must exist, and `main.py` must exist. There is no generic shell or exec API. The child's output goes to `<case>/cfd-launch.log`. If the process exits with an error within 2.5 s, `launch` returns `ok: false` with the end of that log.
- `openExternal` opens http(s) and mailto URLs. For a local path it opens the folder, or for a file it only reveals the file in Explorer, so it never executes anything.

## Packaging

`electron-builder` is configured in the `build` field of `package.json`:

- appId `com.austin.cadmodeler`
- targets: NSIS installer (per user, install folder can be changed) and a portable exe
- output folder: `release/`

The package contains only `dist/`, `electron/` and `package.json`. `node_modules` is excluded because everything is already bundled into `dist/`. The first run downloads the Electron and NSIS binaries into the electron-builder cache, which takes a few hundred MB. There is no custom icon yet, so the Electron default is used. To add one, put `build/icon.ico` in place (256×256).

Verified on 2026-10-07: both `CAD Modeler-Setup-0.1.0.exe` and `CAD Modeler-Portable-0.1.0.exe` built (about 117 MB each), and the unpacked build loads the WASM from inside `app.asar` (`"CAD Modeler.exe" --smoke`).

**Known issue:** when the output folder is `release/` inside this project, electron-builder can fail with `EPERM: operation not permitted, rename '...\release\win-unpacked.tmp' -> '...\win-unpacked'`. The likely cause is antivirus scanning the freshly extracted Electron files. If it happens, retry, or build to a folder outside Documents:

```
npx vite build
npx electron-builder --win nsis portable -c.directories.output=%LOCALAPPDATA%\cad-modeler-release
```

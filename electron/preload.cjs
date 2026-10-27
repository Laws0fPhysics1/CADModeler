// Exposes a minimal window.desktop API to the renderer. Every call goes through
// ipcRenderer.invoke to a validated handler in electron/main.cjs; there is no
// generic file-write or shell-exec channel. The renderer should use
// src/platform.js rather than calling this directly.
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);
let beforeClose = [];

let closeConfirm = null;
// window close: ack at once (so main knows we're alive), ask the page, run the before-close hooks if closing
ipcRenderer.on("desktop:close-request", async () => {
  ipcRenderer.send("desktop:close-ack");
  let ok = true;
  try { if (closeConfirm) ok = (await closeConfirm()) !== false; } catch (e) { console.error(e); ok = true; }
  if (ok) { try { for (const cb of beforeClose) await cb(); } catch (e) { console.error(e); } }
  ipcRenderer.send("desktop:close-answer", ok);
});
ipcRenderer.on("desktop:before-close", async () => {
  try { for (const cb of beforeClose) await cb(); } catch (e) { console.error(e); }
  ipcRenderer.send("desktop:before-close-done");
});

contextBridge.exposeInMainWorld("desktop", {
  isDesktop: true,
  // the path of a File dropped from Explorer (read only: used to refuse inserting a design into itself)
  pathForFile: (file) => { try { return require("electron").webUtils.getPathForFile(file) || null; } catch (e) { return null; } },
  platform: process.platform,
  saveFile: (opts) => invoke("desktop:saveFile", opts),
  saveFileTo: (filePath, data) => invoke("desktop:saveFileTo", filePath, data),
  // fn() -> Promise<boolean>: false keeps the window open (e.g. the user cancelled a save prompt)
  onCloseRequest: (fn) => { closeConfirm = typeof fn === "function" ? fn : null; invoke("desktop:registerCloseConfirm"); },
  openFile: (opts) => invoke("desktop:openFile", opts),
  parts: {
    info: () => invoke("parts:info"),
    list: () => invoke("parts:list"),
    open: (file) => invoke("parts:open", file),
    writeThumb: (filePath, png) => invoke("parts:writeThumb", filePath, png),
    reveal: () => invoke("parts:reveal"),
  },
  saveFolder: (opts) => invoke("desktop:saveFolder", opts),
  // start-page update check (git clones): check() -> {state: available|current|offline|unavailable, ...};
  // install() closes the app (save prompt first) and then runs "Update CAD Modeler.bat"
  update: {
    check: () => invoke("update:check"),
    install: () => invoke("update:install"),
  },
  saveBugReport: (payload) => invoke("desktop:saveBugReport", payload),
  listBugReports: () => invoke("desktop:listBugReports"),
  setBugStatus: (name, st) => invoke("desktop:setBugStatus", name, st),
  openExternal: (target) => invoke("desktop:openExternal", target),
  revealPath: (target) => invoke("desktop:revealPath", target),
  onBeforeClose: (cb) => {
    if (typeof cb !== "function") return () => {};
    beforeClose.push(cb);
    invoke("desktop:registerBeforeClose");
    return () => { beforeClose = beforeClose.filter((f) => f !== cb); };
  },
  // McMaster-Carr browser; onFile(cb) gets { name, data: Uint8Array } or { name, error } per CAD download
  mcmaster: {
    open: (query) => invoke("mcmaster:open", query),
    onFile: (cb) => {
      if (typeof cb !== "function") return () => {};
      const fn = (_e, f) => cb(f);
      ipcRenderer.on("mcmaster:file", fn);
      return () => ipcRenderer.removeListener("mcmaster:file", fn);
    },
  },
  cfd: {
    getConfig: () => invoke("cfd:getConfig"),
    setConfig: (partial) => invoke("cfd:setConfig", partial),
    writeCase: (folderName, files) => invoke("cfd:writeCase", folderName, files),
    launch: (casePath) => invoke("cfd:launch", casePath),
    readResults: (casePath) => invoke("cfd:readResults", casePath),
    revealCase: (casePath) => invoke("cfd:revealCase", casePath),
    run: (casePath, opts) => invoke("cfd:run", casePath, opts),
    stop: (casePath, opts) => invoke("cfd:stop", casePath, opts),
    status: (casePath) => invoke("cfd:status", casePath),
    readFile: (casePath, rel) => invoke("cfd:readFile", casePath, rel),
  },
  // FEA Sim (static stress): same calls as cfd minus launch (FEA Sim has no GUI yet)
  fea: {
    getConfig: () => invoke("fea:getConfig"),
    setConfig: (partial) => invoke("fea:setConfig", partial),
    writeCase: (folderName, files) => invoke("fea:writeCase", folderName, files),
    readResults: (casePath) => invoke("fea:readResults", casePath),
    revealCase: (casePath) => invoke("fea:revealCase", casePath),
    run: (casePath, opts) => invoke("fea:run", casePath, opts),
    stop: (casePath, opts) => invoke("fea:stop", casePath, opts),
    status: (casePath) => invoke("fea:status", casePath),
    readFile: (casePath, rel) => invoke("fea:readFile", casePath, rel),
  },
});

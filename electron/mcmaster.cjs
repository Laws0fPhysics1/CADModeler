// McMaster-Carr browser for "Insert McMaster-Carr Component".
//
// Opens mcmaster.com in its own window (own persistent session, no preload, sandboxed).
// When the user downloads a CAD file there (product page > CAD > 3-D STEP > Save), the
// download is caught, read, and handed to the main window, which imports it like
// File > Import. Other downloads (PDF drawings, ...) get the normal save dialog.
"use strict";
const { BrowserWindow, session, shell } = require("electron");
const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");

const HOME = "https://www.mcmaster.com/";
const CAD_EXT = /\.(step|stp|stl|obj)$/i;
const MAX_BYTES = 200 * 1024 * 1024;
const isMcMaster = (url) => { try { return /(^|\.)mcmaster\.com$/i.test(new URL(url).hostname); } catch (e) { return false; } };

function createMcMaster({ getMainWindow }) {
  let win = null;
  let hooked = false;
  const tmpDir = path.join(os.tmpdir(), "cadmodeler-mcmaster");

  function hookSession(ses) {
    if (hooked) return;
    hooked = true;
    ses.on("will-download", (event, item) => {
      const name = path.basename(item.getFilename() || "part.step");
      if (!CAD_EXT.test(name)) return; // not a CAD model: Electron's usual save dialog
      const file = path.join(tmpDir, `${Date.now()}_${name.replace(/[^\w.\-]+/g, "_")}`);
      item.setSavePath(file);
      item.once("done", async (_e, state) => {
        const main = getMainWindow();
        try {
          if (state !== "completed") throw new Error(`download ${state}`);
          const st = await fsp.stat(file);
          if (st.size > MAX_BYTES) throw new Error("file is larger than 200 MB");
          const data = await fsp.readFile(file);
          if (main && !main.isDestroyed()) {
            main.webContents.send("mcmaster:file", { name, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) });
            main.focus();
          }
        } catch (err) {
          if (main && !main.isDestroyed()) main.webContents.send("mcmaster:file", { name, error: String(err && err.message || err) });
        } finally {
          fsp.rm(file, { force: true }).catch(() => {});
        }
      });
    });
  }

  async function open(query) {
    const q = typeof query === "string" ? query.trim().slice(0, 120) : "";
    const url = q ? `${HOME}${encodeURIComponent(q)}/` : HOME;
    if (win && !win.isDestroyed()) {
      if (q) win.loadURL(url);
      win.show(); win.focus();
      return true;
    }
    await fsp.mkdir(tmpDir, { recursive: true });
    const ses = session.fromPartition("persist:mcmaster");
    hookSession(ses);
    const parent = getMainWindow();
    win = new BrowserWindow({
      title: "McMaster-Carr — download a 3-D STEP to insert it",
      width: 1280, height: 900,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      autoHideMenuBar: true,
      webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    win.removeMenu();
    // stay on mcmaster.com; anything else opens in the user's browser
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (isMcMaster(u)) win.loadURL(u);
      else if (/^https?:/i.test(u)) shell.openExternal(u);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, u) => {
      if (!isMcMaster(u)) { event.preventDefault(); if (/^https?:/i.test(u)) shell.openExternal(u); }
    });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (input.alt && input.key === "ArrowLeft" && win.webContents.navigationHistory.canGoBack()) { win.webContents.navigationHistory.goBack(); event.preventDefault(); }
      if (input.alt && input.key === "ArrowRight" && win.webContents.navigationHistory.canGoForward()) { win.webContents.navigationHistory.goForward(); event.preventDefault(); }
    });
    win.on("closed", () => { win = null; });
    win.loadURL(url);
    return true;
  }

  return { open, close: () => { if (win && !win.isDestroyed()) win.close(); } };
}

module.exports = { createMcMaster, isMcMaster };

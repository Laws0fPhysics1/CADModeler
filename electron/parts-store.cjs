// The Parts folder: the default home for saved designs, shown in the Parts panel as a bin with
// thumbnails (feature request 2026-10-09). Shared by electron/main.cjs (IPC) and vite.config.js
// (dev server /api/parts), so both read the same layout:
//   <Parts>/<name>.cadm.json         saved designs
//   <Parts>/.thumbs/<name>.cadm.json.png   thumbnail written at each save into the folder
// Every function takes the folder and refuses paths outside it.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const THUMBS = ".thumbs";
const isDesign = (n) => /\.cadm\.json$/i.test(n);

/**
 * Where the Parts folder lives: next to the app ("Parts" in the project folder when run from source;
 * beside the exe when installed), else Documents\CAD Modeler Parts when that isn't writable
 * (Program Files). `override` (config) wins when set.
 */
function resolvePartsDir({ appRoot, packaged, exeDir, documents, override } = {}) {
  if (override && typeof override === "string") return path.resolve(override);
  const candidates = [packaged ? path.join(exeDir, "Parts") : path.join(appRoot, "Parts"), path.join(documents || path.join(os.homedir(), "Documents"), "CAD Modeler Parts")];
  for (const dir of candidates) {
    try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; } catch {}
  }
  return candidates[candidates.length - 1];
}

/** `file` must be a plain design file name inside `dir` (no folders, no ".."); returns its full path. */
function inside(dir, file) {
  if (typeof file !== "string" || !file || file !== path.basename(file) || file.startsWith(".") || !isDesign(file)) throw new Error("bad part file name");
  const p = path.resolve(dir, file);
  if (path.dirname(p) !== path.resolve(dir)) throw new Error("outside the Parts folder");
  return p;
}
/** Is an absolute path a design file directly in the Parts folder? Returns its file name, else null. */
function partName(dir, filePath) {
  if (typeof filePath !== "string" || !filePath) return null;
  const p = path.resolve(filePath);
  return path.dirname(p).toLowerCase() === path.resolve(dir).toLowerCase() && isDesign(path.basename(p)) ? path.basename(p) : null;
}

/** [{ file, name, path, mtime, size, thumb (data URL or null) }], newest first. */
async function listParts(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  for (const ent of await fsp.readdir(dir, { withFileTypes: true })) {
    if (!ent.isFile() || !isDesign(ent.name)) continue;
    const p = path.join(dir, ent.name);
    let st; try { st = await fsp.stat(p); } catch { continue; }
    let thumb = null;
    try { thumb = "data:image/png;base64," + (await fsp.readFile(path.join(dir, THUMBS, ent.name + ".png"))).toString("base64"); } catch {}
    out.push({ file: ent.name, name: ent.name.replace(/\.cadm\.json$/i, ""), path: p, mtime: st.mtimeMs, size: st.size, thumb });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function readPart(dir, file) {
  const p = inside(dir, file);
  return { name: file, path: p, data: new Uint8Array(await fsp.readFile(p)) };
}

/** png: Buffer / Uint8Array, or a data:image/png;base64 URL. Max 2 MB. */
async function writeThumb(dir, file, png) {
  inside(dir, file);
  let buf = png;
  if (typeof png === "string") { const m = /^data:image\/png;base64,(.+)$/.exec(png); if (!m) throw new Error("thumbnail must be a PNG data URL"); buf = Buffer.from(m[1], "base64"); }
  buf = Buffer.from(buf);
  if (buf.length > 2 * 1024 * 1024) throw new Error("thumbnail too large");
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  const tdir = path.join(dir, THUMBS);
  await fsp.mkdir(tdir, { recursive: true });
  if (process.platform === "win32") { try { require("node:child_process").execFile("attrib", ["+h", tdir], { windowsHide: true }, () => {}); } catch {} }
  await fsp.writeFile(path.join(tdir, file + ".png"), buf);
  return true;
}

module.exports = { resolvePartsDir, listParts, readPart, writeThumb, partName, inside, THUMBS };

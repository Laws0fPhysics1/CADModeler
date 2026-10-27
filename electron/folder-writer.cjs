// Writes a set of files into <parentDir>/<folderName>/ for platform.saveFolder
// (robot export packages). Shared by electron/main.cjs and tests. Every name is
// validated: no "..", no absolute paths or drive letters, no reserved characters,
// and the resolved path must stay inside the target folder.
"use strict";
const path = require("node:path");
const fsp = require("node:fs/promises");

const BAD_NAME = /[<>:"|?*\x00-\x1f]/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const MAX_FILES = 10000;
const MAX_BYTES = 2 * 1024 ** 3;

function safeSegment(s, what) {
  if (typeof s !== "string" || !s.trim()) throw new Error(`${what} must be a non-empty string`);
  s = s.trim();
  if (BAD_NAME.test(s) || /[\\/]/.test(s) || s === "." || s === ".." || /[. ]$/.test(s) || RESERVED.test(s)) throw new Error(`invalid ${what}: ${s}`);
  return s;
}
function safeRelPath(s, what) {
  if (typeof s !== "string" || !s) throw new Error(`${what} must be a non-empty string`);
  if (path.isAbsolute(s) || /^[a-zA-Z]:/.test(s) || /^[\\/]/.test(s)) throw new Error(`invalid ${what}: absolute path ${s}`);
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) throw new Error(`invalid ${what}: ${s}`);
  return path.join(...parts.map((p) => safeSegment(p, what)));
}
function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}
function toBuffer(data) {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("file data must be a string, ArrayBuffer or Uint8Array");
}

/**
 * Validate everything first, then write. files: { "rel/path.ext": string|Uint8Array }.
 * Existing files with the same names are overwritten; other files in the folder are left alone.
 * @returns {Promise<string>} the folder path
 */
async function writeFolder(parentDir, folderName, files) {
  if (typeof parentDir !== "string" || !path.isAbsolute(parentDir)) throw new Error("parent folder must be an absolute path");
  const dir = path.join(path.resolve(parentDir), safeSegment(folderName, "folder name"));
  if (!files || typeof files !== "object" || Array.isArray(files)) throw new Error("files must be an object");
  const entries = Object.entries(files);
  if (!entries.length) throw new Error("no files to write");
  if (entries.length > MAX_FILES) throw new Error(`too many files (${entries.length})`);
  let total = 0;
  const plan = entries.map(([name, data]) => {
    const target = path.join(dir, safeRelPath(name, "file name"));
    if (!isInside(target, dir)) throw new Error(`file escapes the folder: ${name}`);
    const buf = toBuffer(data);
    total += buf.length;
    return { target, buf };
  });
  if (total > MAX_BYTES) throw new Error("package is too large");
  await fsp.mkdir(dir, { recursive: true });
  for (const { target, buf } of plan) {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, buf);
  }
  return dir;
}

module.exports = { writeFolder, safeRelPath, safeSegment };

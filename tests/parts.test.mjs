// Parts folder store (electron/parts-store.cjs): listing, thumbnails, path guards. node tests/parts.test.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const P = require("../electron/parts-store.cjs");
let fails = 0;
const check = (name, ok) => { console.log(ok ? "ok  " : "FAIL", name); if (!ok) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cadparts-"));
try {
  const dir = P.resolvePartsDir({ appRoot: tmp, packaged: false });
  check("Parts folder next to the app", dir === path.join(tmp, "Parts") && fs.existsSync(dir));
  check("config override wins", P.resolvePartsDir({ appRoot: tmp, override: path.join(tmp, "Mine") }) === path.join(tmp, "Mine"));
  fs.writeFileSync(path.join(dir, "Bracket.cadm.json"), JSON.stringify({ name: "Bracket", features: [] }));
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
  check("thumbnail written", await P.writeThumb(dir, "Bracket.cadm.json", "data:image/png;base64," + png.toString("base64")));
  const list = await P.listParts(dir);
  check("lists designs only", list.length === 1 && list[0].name === "Bracket");
  check("thumbnail listed", /^data:image\/png;base64,/.test(list[0].thumb || ""));
  check("reads a part", (await P.readPart(dir, "Bracket.cadm.json")).data.length > 10);
  for (const bad of ["../x.cadm.json", "..\\x.cadm.json", "sub/x.cadm.json", "C:\\x.cadm.json", "notes.txt", ".thumbs"]) {
    let threw = false; try { await P.readPart(dir, bad); } catch (e) { threw = true; }
    check(`refuses ${bad}`, threw);
  }
  let threw = false; try { await P.writeThumb(dir, "Bracket.cadm.json", Buffer.from("not a png")); } catch (e) { threw = true; }
  check("refuses a non-PNG thumbnail", threw);
  check("partName inside", P.partName(dir, path.join(dir, "Bracket.cadm.json")) === "Bracket.cadm.json");
  check("partName outside", P.partName(dir, path.join(tmp, "Bracket.cadm.json")) === null);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (fails) { console.log(fails, "failed"); process.exitCode = 1; } else console.log("parts store: all ok");

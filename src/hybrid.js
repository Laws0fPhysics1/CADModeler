// Hybrid designs: inserting one saved design into another (DOM-free, Node-testable).
//
// Document type (`doc.kind`): "part" | "assembly" | "hybrid". A hybrid is a design that contains
// inserted designs (timeline features of type "insert"); it's file-structure nomenclature, the
// third type next to part and assembly (user, bug report 2026-10-09 09:04).
//
// Insert feature (kernel.js "insert" case replays it):
//   { id, type: "insert", name, source: { id, name, file }, snapshot: { id, name, kind, features, marker, appearances },
//     translate: [x, y, z] }
// The snapshot is a copy of the source design at insert time (not a live link), so a file can be
// moved or edited without breaking the design that inserted it.
//
// Every document carries a stable `id` (generated once, saved in the file) so loop detection works
// across renames; file paths are compared too (older files have no id).

export const DOC_KINDS = ["part", "assembly", "hybrid"];
export const KIND_LABEL = { part: "Part", assembly: "Assembly", hybrid: "Hybrid" };
/** icons.js key per kind */
export const KIND_ICON = { part: "body", assembly: "component", hybrid: "hybrid" };

export const newDocId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

export const hasInserts = (d) => !!d && Array.isArray(d.features) && d.features.some((f) => f && f.type === "insert");

/**
 * The document's type. Inserted designs make it a hybrid; otherwise a stored "part" / "assembly" is
 * kept. Older docs without `kind`: an assembly when it has components or is a fresh "Untitled assembly",
 * else a part. A stored "hybrid" whose inserts were all deleted falls back the same way.
 */
export function docKind(d) {
  if (!d) return "part";
  if (hasInserts(d)) return "hybrid";
  if (d.kind === "part" || d.kind === "assembly") return d.kind;
  const comps = d.assembly && Array.isArray(d.assembly.components) ? d.assembly.components : [];
  if (comps.length || d.name === "Untitled assembly") return "assembly";
  return "part";
}

const normPath = (p) => (typeof p === "string" && p ? p.replace(/\//g, "\\").toLowerCase() : null);
export const samePath = (a, b) => { const x = normPath(a), y = normPath(b); return !!x && x === y; };

/** Every design inserted into d, recursively through the embedded snapshots: [{ id, name, file, via: [names] }] */
export function insertedRefs(d, out = [], via = [], depth = 0) {
  if (!d || !Array.isArray(d.features) || depth > 32) return out;
  for (const f of d.features) {
    if (!f || f.type !== "insert") continue;
    const s = f.source || {};
    out.push({ id: s.id || (f.snapshot && f.snapshot.id) || null, name: s.name || f.name || "design", file: s.file || null, via });
    insertedRefs(f.snapshot, out, [...via, s.name || f.name || "design"], depth + 1);
  }
  return out;
}

/**
 * Why inserting `source` (read from `sourceFile`, may be null) into `target` (saved at `targetFile`, may be null)
 * would make a loop, or null when it's fine. Refused: the same design (same id or same file), or a source whose
 * inserted-design tree already contains the target.
 */
export function insertLoop(target, targetFile, source, sourceFile) {
  const tName = (target && target.name) || "this design", sName = (source && source.name) || "That design";
  const isTarget = (id, file) => (!!id && !!target && id === target.id) || samePath(file, targetFile);
  if (isTarget(source && source.id, sourceFile)) return `"${sName}" is the design in this tab: a design can't be inserted into itself`;
  for (const r of insertedRefs(source)) {
    if (isTarget(r.id, r.file)) {
      const path = [sName, ...r.via, tName].join(" → ");
      return `"${sName}" already contains "${tName}" (${path}): inserting it would make a loop`;
    }
  }
  return null;
}

/** The timeline feature that inserts `source`. opts: { id (feature id), file (source path), name (fallback name), translate } */
export function makeInsertFeature(source, opts = {}) {
  const name = (source && source.name && source.name !== "Untitled" ? source.name : opts.name || source.name) || "Design";
  const features = JSON.parse(JSON.stringify(source.features || []));
  const marker = Number.isFinite(source.marker) ? source.marker : features.length;
  return {
    id: opts.id, type: "insert", name,
    source: { id: source.id || null, name, file: opts.file || null },
    snapshot: { id: source.id || null, name, kind: docKind(source), features, marker, appearances: JSON.parse(JSON.stringify(source.appearances || {})) },
    translate: opts.translate || [0, 0, 0],
  };
}

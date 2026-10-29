"""STEP -> quadratic tetrahedral mesh with gmsh (OpenCASCADE kernel).

* The STEP comes straight from CAD Modeler (`K.exportSTEP`, millimetres).
* Several solids are fragmented together so touching bodies share nodes
  (bonded contact). Each gmsh volume is matched to a case body.
* Every gmsh surface records its centre of mass, normal and area, so CAD face
  references (index + centre point + normal) can be matched to it.
* Element size: a fraction of the part size, capped by the part's
  characteristic thickness (2 V / A) so thin parts still get several elements
  through the thickness, plus curvature-based refinement for holes and fillets.
"""
from __future__ import annotations

import math
import time

import numpy as np

from .elements import EDGES, NODE_XI

QUALITY = {  # (fraction of the largest extent, fraction of the characteristic thickness 2V/A)
    "coarse": (0.10, 1.00),
    "medium": (0.05, 0.60),
    "fine": (0.03, 0.40),
    "finest": (0.02, 0.28),
}
CURVATURE_ELEMS = {"coarse": 8, "medium": 12, "fine": 16, "finest": 20}


class Mesh:
    """nodes (N,3) mm; tets (E,10) int (elements.py ordering); tet_volume (E,) gmsh volume tag;
    surfaces: {tag: {"tris": (m,6) int, "com", "normal", "area", "bbox"}};
    volumes: {tag: {"com", "volume", "bbox"}}"""

    def __init__(self):
        self.nodes = None
        self.tets = None
        self.tet_volume = None
        self.surfaces = {}
        self.volumes = {}
        self.size_mm = None
        self.info = {}


def _gmsh():
    try:
        import gmsh  # noqa: F401
    except ImportError as e:
        raise RuntimeError("gmsh is not installed: run  pip install gmsh") from e
    import gmsh
    return gmsh


def _tet_reorder(nodes, conn):
    """Find which gmsh mid-node slot sits on which edge (gmsh documents the order, but check by
    geometry) and return the permutation into elements.EDGES order."""
    sample = conn[: min(len(conn), 200)]
    X = nodes[sample]  # (s,10,3)
    perm = [0, 1, 2, 3]
    used = set()
    for (i, j) in EDGES:
        mid = 0.5 * (X[:, i] + X[:, j])
        d = [np.linalg.norm(X[:, k] - mid, axis=1).mean() if k not in used else np.inf for k in range(4, 10)]
        k = 4 + int(np.argmin(d))
        used.add(k)
        perm.append(k)
    if sorted(perm[4:]) != list(range(4, 10)):
        raise RuntimeError("could not identify TET10 node order")
    return conn[:, perm]


def mesh_step(step_path: str, quality: str = "medium", size_mm: float | None = None,
              order: int = 2, log=print, progress=None, should_stop=None) -> Mesh:
    gmsh = _gmsh()
    t0 = time.time()
    gmsh.initialize(["-noenv"], readConfigFiles=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.Verbosity", 2)
        gmsh.option.setString("Geometry.OCCTargetUnit", "MM")
        gmsh.model.add("part")
        ents = gmsh.model.occ.importShapes(step_path)
        vols = [t for d, t in ents if d == 3]
        gmsh.model.occ.synchronize()
        if not vols:
            vols = [t for _, t in gmsh.model.getEntities(3)]
        if not vols:
            raise RuntimeError("The STEP file contains no solid bodies (open surfaces cannot be meshed for stress analysis).")
        frag_map = None
        if len(vols) > 1:
            # bonded contact: make touching solids share their interface faces
            out, outmap = gmsh.model.occ.fragment([(3, t) for t in vols[:1]], [(3, t) for t in vols[1:]])
            gmsh.model.occ.synchronize()
            frag_map = {vols[i]: [t for d, t in outmap[i] if d == 3] for i in range(len(vols))}

        all_vols = [t for _, t in gmsh.model.getEntities(3)]
        m = Mesh()
        total_v, total_a = 0.0, 0.0
        for t in all_vols:
            com = np.array(gmsh.model.occ.getCenterOfMass(3, t))
            v = gmsh.model.occ.getMass(3, t)
            bb = gmsh.model.getBoundingBox(3, t)
            m.volumes[t] = {"com": com, "volume": v, "bbox": (bb[:3], bb[3:])}
            total_v += v
        bounds = [gmsh.model.getBoundary([(3, t)], oriented=False) for t in all_vols]
        bnd = sorted({abs(t) for b in bounds for _, t in b})
        for s in bnd:
            total_a += gmsh.model.occ.getMass(2, s)
        xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
        L = max(xmax - xmin, ymax - ymin, zmax - zmin)
        thick = 2.0 * total_v / total_a if total_a > 0 else L
        fL, ft = QUALITY.get(quality, QUALITY["medium"])
        h = float(size_mm) if size_mm else min(fL * L, ft * thick)
        h = max(h, L * 1e-3)
        m.size_mm = h
        m.info = {"extent_mm": L, "thickness_mm": thick, "quality": quality, "volume_mm3": total_v,
                  "bodies": len(vols), "fragments": frag_map}
        log(f"meshing: extent {L:.4g} mm, char. thickness {thick:.4g} mm, element size {h:.4g} mm ({quality})")

        gmsh.option.setNumber("Mesh.MeshSizeMax", h)
        gmsh.option.setNumber("Mesh.MeshSizeMin", h * 0.1)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", CURVATURE_ELEMS.get(quality, 12))
        gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 1)
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
        gmsh.option.setNumber("Mesh.Algorithm", 6)       # Frontal-Delaunay 2D
        gmsh.option.setNumber("Mesh.Algorithm3D", 10)    # HXT (parallel Delaunay)
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.option.setNumber("Mesh.HighOrderOptimize", 0)
        gmsh.option.setNumber("Mesh.SecondOrderLinear", 0)  # mid-nodes on the true curved geometry
        gmsh.option.setNumber("General.NumThreads", 0)

        if progress:
            progress(0.05, "surface mesh")
        gmsh.model.mesh.generate(2)
        if should_stop:
            should_stop()
        if progress:
            progress(0.35, "volume mesh")
        gmsh.model.mesh.generate(3)
        if should_stop:
            should_stop()
        if progress:
            progress(0.8, "second order")
        if order == 2:
            gmsh.model.mesh.setOrder(2)

        tags, coords, _ = gmsh.model.mesh.getNodes()
        tags = np.asarray(tags, np.int64)
        coords = np.asarray(coords, float).reshape(-1, 3)
        lut = np.full(int(tags.max()) + 1, -1, np.int64)
        lut[tags] = np.arange(len(tags))

        tets, owner = [], []
        for t in all_vols:
            et, _, en = gmsh.model.mesh.getElements(3, t)
            for typ, conn in zip(et, en):
                if typ != 11:  # 11 = 10-node tetrahedron
                    raise RuntimeError(f"unexpected 3D element type {typ} (expected TET10)")
                c = lut[np.asarray(conn, np.int64).reshape(-1, 10)]
                tets.append(c)
                owner.append(np.full(len(c), t, np.int32))
        if not tets:
            raise RuntimeError("gmsh produced no tetrahedra")
        conn = np.vstack(tets)
        # compact: drop nodes not used by any tet (e.g. CAD vertices / curve nodes only)
        used = np.zeros(len(coords), bool)
        used[conn.ravel()] = True
        newid = np.cumsum(used) - 1
        m.nodes = coords[used]
        m.tets = _tet_reorder(m.nodes, newid[conn])
        m.tet_volume = np.concatenate(owner)

        for s in bnd:
            et, _, en = gmsh.model.mesh.getElements(2, s)
            tris = []
            for typ, c in zip(et, en):
                if typ != 9:  # 9 = 6-node triangle
                    continue
                tris.append(newid[lut[np.asarray(c, np.int64).reshape(-1, 6)]])
            tris = np.vstack(tris) if tris else np.zeros((0, 6), np.int64)
            com = np.array(gmsh.model.occ.getCenterOfMass(2, s))
            try:
                uv = gmsh.model.getParametrization(2, s, list(com))
                nrm = np.array(gmsh.model.getNormal(s, list(uv)))
                cp = np.array(gmsh.model.getClosestPoint(2, s, list(com))[0])
            except Exception:
                nrm, cp = np.zeros(3), com
            bb = gmsh.model.getBoundingBox(2, s)
            stype = gmsh.model.getType(2, s)
            m.surfaces[s] = {"tris": tris, "com": com, "normal": nrm, "closest": cp,
                             "area": gmsh.model.occ.getMass(2, s), "bbox": (bb[:3], bb[3:]), "type": stype,
                             "volumes": [t for t, b in zip(all_vols, bounds) if s in {abs(x) for _, x in b}]}
        m.info["mesh_s"] = round(time.time() - t0, 3)
        log(f"meshing: {len(m.nodes):,} nodes, {len(m.tets):,} TET10 elements, {len(m.surfaces)} surfaces "
            f"in {m.info['mesh_s']:.1f} s")
        return m
    finally:
        gmsh.finalize()


def check_mesh_nodes(m: Mesh):
    """Sanity check that mid nodes sit near edge midpoints (debug helper)."""
    X = m.nodes[m.tets]
    errs = [np.linalg.norm(X[:, 4 + k] - 0.5 * (X[:, i] + X[:, j]), axis=1).max() for k, (i, j) in enumerate(EDGES)]
    return max(errs), NODE_XI

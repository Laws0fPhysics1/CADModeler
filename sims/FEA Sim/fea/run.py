"""Run one `cadmodeler-fea-case`: mesh, assemble, apply fixtures and loads, solve,
recover stresses, and write results.json plus viz/ back into the case folder."""
from __future__ import annotations

import os
import time
import traceback

import numpy as np
import scipy.sparse as sp

from . import elements as el
from . import solver as sv
from .caseio import (FeaCase, Reporter, StopRequested, CaseError, finite, load_case, write_json_atomic,
                     PROGRESS_FILE, RESULTS_FILE, STOP_FILE)
from .mesher import mesh_step

DEFAULT_MATERIAL = {"id": "generic", "name": "Generic steel (default)", "youngs_modulus_Pa": 200e9,
                    "poissons_ratio": 0.29, "density_kg_m3": 7850, "yield_strength_Pa": 250e6,
                    "ultimate_strength_Pa": 400e6}
FOS_CAP = 1000.0
G0 = 9.80665


# ----------------------------------------------------------------------------- materials
def material_of(body: dict, warnings: list) -> dict:
    m = body.get("material") or {}
    out = dict(DEFAULT_MATERIAL)
    if not m:
        warnings.append(f"{body.get('name') or body.get('id')}: no material assigned, using generic steel")
        return out
    out.update({k: v for k, v in m.items() if v is not None})
    E = finite(m.get("youngs_modulus_Pa"))
    nu = finite(m.get("poissons_ratio"))
    if E is None or E <= 0:
        warnings.append(f"{m.get('name')}: no Young's modulus, using 200 GPa")
        out["youngs_modulus_Pa"] = 200e9
    if nu is None or not (-0.99 < nu < 0.5):
        warnings.append(f"{m.get('name')}: invalid Poisson's ratio, using 0.3")
        out["poissons_ratio"] = 0.3
    if nu is not None and nu > 0.49:
        warnings.append(f"{m.get('name')}: nearly incompressible (nu = {nu}); linear TET10 results may be stiff")
    ys = finite(m.get("yield_strength_Pa"))
    if ys is None or ys <= 0:
        us = finite(m.get("ultimate_strength_Pa"))
        out["yield_strength_Pa"] = us if us and us > 0 else None
        out["_yield_from"] = "ultimate" if us and us > 0 else None
        warnings.append(f"{m.get('name')}: no yield strength; safety factor uses "
                        + ("the ultimate strength" if us and us > 0 else "nothing (not available)"))
    else:
        out["_yield_from"] = "yield"
    if finite(m.get("density_kg_m3")) is None:
        out["density_kg_m3"] = DEFAULT_MATERIAL["density_kg_m3"]
    return out


# ----------------------------------------------------------------------------- topology helpers
def boundary_faces(nodes, tets):
    """Oriented boundary TRI6 faces of the tet mesh: (m,6) node ids wound outward."""
    F = tets[:, np.array(el.FACE_NODES)]                    # (E,4,6)
    X = nodes[tets[:, :4]]
    vol6 = np.einsum("ei,ei->e", np.cross(X[:, 1] - X[:, 0], X[:, 2] - X[:, 0]), X[:, 3] - X[:, 0])
    flip = vol6 < 0
    if flip.any():
        F[flip] = F[flip][:, :, [0, 2, 1, 5, 4, 3]]
    F = F.reshape(-1, 6)
    key = np.sort(F[:, :3], axis=1)
    _, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    bnd = F[cnt[inv.ravel()] == 1]
    return bnd, int(flip.sum())


def _key_dict(tris):
    k = np.sort(tris[:, :3], axis=1)
    return {tuple(r): i for i, r in enumerate(k)}


def face_normals(Xf):
    """Unit outward normals and corner-triangle areas of TRI6 faces (m,6,3)."""
    n = np.cross(Xf[:, 1] - Xf[:, 0], Xf[:, 2] - Xf[:, 0])
    a = np.linalg.norm(n, axis=1)
    return n / np.maximum(a, 1e-300)[:, None], 0.5 * a


def fit_axis(Xf):
    """Axis of the cylinder(s) the TRI6 faces lie on: (point, unit direction, radius, quality).

    The facet normals of a cylinder are all perpendicular to its axis (smallest eigenvector of
    sum n n^T); the centre and radius come from a least-squares circle through the nodes (which lie
    on the true surface, unlike facet centroids) projected onto the plane across the axis.
    quality = smallest / middle eigenvalue: ~0 for a true cylinder, ~1 for a flat or round blob.
    """
    n, a = face_normals(Xf)
    M = np.einsum("m,mi,mj->ij", a, n, n)
    w, v = np.linalg.eigh(M)
    ax, e1, e2 = v[:, 0], v[:, 1], v[:, 2]
    X = np.unique(Xf.reshape(-1, 3), axis=0)
    q = np.stack([X @ e1, X @ e2], axis=1)
    # Kasa fit: |q - c|^2 = R^2  ->  2 q.c + (R^2 - |c|^2) = |q|^2, linear in (c, k)
    sol = np.linalg.lstsq(np.column_stack([2 * q, np.ones(len(q))]), (q ** 2).sum(1), rcond=None)[0]
    c2 = sol[:2]
    rad = float(np.sqrt(max(sol[2] + c2 @ c2, 0.0)))
    p = c2[0] * e1 + c2[1] * e2 + ax * float((X @ ax).mean())
    return p, ax, rad, float(w[0] / max(w[1], 1e-300))


def node_frames(X, p, ax):
    """(n,3,3) local frames per node, rows = radial, tangential, axial (global components)."""
    r = X - p
    r -= np.outer(r @ ax, ax)
    rl = np.linalg.norm(r, axis=1)
    ok = rl > 1e-9
    r[ok] /= rl[ok, None]
    # a node on the axis has no radial direction: any perpendicular will do
    perp = np.cross(ax, [1.0, 0, 0] if abs(ax[0]) < 0.9 else [0, 1.0, 0])
    r[~ok] = perp / np.linalg.norm(perp)
    t = np.cross(ax, r)
    return np.stack([r, t, np.broadcast_to(ax, r.shape)], axis=1)


def assign_surfaces(bnd, surfaces):
    """Surface tag for each boundary face (-1 if not found)."""
    lookup = {}
    for tag, s in surfaces.items():
        for r in np.sort(s["tris"][:, :3], axis=1):
            lookup[tuple(r)] = tag
    keys = np.sort(bnd[:, :3], axis=1)
    return np.array([lookup.get(tuple(r), -1) for r in keys], np.int64)


# ----------------------------------------------------------------------------- face matching
def body_volumes(case: FeaCase, mesh) -> dict:
    """case body id -> list of gmsh volume tags (STEP order; fragments followed)."""
    bodies = case.bodies
    tags = sorted(mesh.volumes)
    frag = mesh.info.get("fragments")
    out = {}
    if frag:
        orig = sorted(frag)
        for b, t in zip(bodies, orig):
            out[b["id"]] = frag[t]
    elif len(bodies) == 1:
        out[bodies[0]["id"]] = tags
    else:
        for b, t in zip(bodies, tags):
            out[b["id"]] = [t]
    return out


def match_face(ref: dict, mesh, cand: list, L: float, single_body: bool):
    """Best gmsh surface for a CAD faceRef {body, idx, pt, n, area_mm2?} among candidate tags."""
    pt = np.asarray(ref.get("pt") or [0, 0, 0], float)
    n = np.asarray(ref.get("n") or [0, 0, 0], float)
    nn = np.linalg.norm(n)
    n = n / nn if nn > 0 else n
    area = finite(ref.get("area_mm2"))
    best, bs, bd = None, np.inf, None
    for tag in cand:
        s = mesh.surfaces[tag]
        d = float(min(np.linalg.norm(s["com"] - pt), np.linalg.norm(s["closest"] - pt)))
        score = d / L
        sn = s["normal"]
        if nn > 0 and np.linalg.norm(sn) > 0 and s.get("type") == "Plane":
            score += 0.05 * (1 - abs(float(sn @ n)))
        if area:
            score += 0.05 * abs(s["area"] - area) / max(area, s["area"], 1e-9)
        if single_body and ref.get("idx") is not None and tag == int(ref["idx"]) + 1:
            score -= 1e-6  # tie-break on the B-rep order
        if score < bs:
            best, bs, bd = tag, score, d
    return best, bd


def resolve_refs(refs, case, mesh, bvols, L, warnings, what):
    tags, info = [], []
    single = len(case.bodies) == 1
    for r in refs:
        vol = bvols.get(r.get("body")) or [t for v in bvols.values() for t in v]
        cand = [t for t, s in mesh.surfaces.items() if set(s["volumes"]) & set(vol)]
        tag, d = match_face(r, mesh, cand, L, single)
        if tag is None:
            raise CaseError(f"{what}: could not find face {r.get('idx')} of {r.get('body')} in the mesh")
        if d is not None and d > 0.02 * L:
            warnings.append(f"{what}: face {r.get('idx')} matched surface {tag} only approximately ({d:.3g} mm away)")
        tags.append(tag)
        info.append({"body": r.get("body"), "face": r.get("idx"), "surface": tag, "distance_mm": round(d or 0.0, 6)})
    return tags, info


# ----------------------------------------------------------------------------- viz output
def write_viz(folder, nodes, bnd, bnd_surf, u, vm, fos, princ, manifest_extra, log=print):
    from .caseio import write_bytes_atomic
    vdir = os.path.join(folder, "viz")
    os.makedirs(vdir, exist_ok=True)
    used = np.unique(bnd.ravel())
    remap = np.full(len(nodes), -1, np.int64)
    remap[used] = np.arange(len(used))
    b = remap[bnd]
    # each TRI6 -> 4 linear triangles: (a, ab, ca) (ab, b, bc) (ca, bc, c) (ab, bc, ca)
    tris = np.concatenate([b[:, [0, 3, 5]], b[:, [3, 1, 4]], b[:, [5, 4, 2]], b[:, [3, 4, 5]]])
    tsurf = np.concatenate([bnd_surf] * 4).astype(np.int32)
    nv, nt = len(used), len(tris)
    hdr = np.array([nv, nt], "<u4").tobytes()
    surf = b"FSF1" + hdr + nodes[used].astype("<f4").tobytes() + tris.astype("<u4").tobytes() + tsurf.astype("<i4").tobytes()
    write_bytes_atomic(os.path.join(vdir, "surface.bin"), surf)
    write_bytes_atomic(os.path.join(vdir, "displacement.bin"), u.reshape(-1, 3)[used].astype("<f4").tobytes())
    write_bytes_atomic(os.path.join(vdir, "vonmises.bin"), vm[used].astype("<f4").tobytes())
    write_bytes_atomic(os.path.join(vdir, "safety.bin"), np.minimum(fos[used], FOS_CAP).astype("<f4").tobytes())
    write_bytes_atomic(os.path.join(vdir, "principal.bin"), princ[used].astype("<f4").tobytes())
    dmag = np.linalg.norm(u.reshape(-1, 3)[used], axis=1)
    man = {"kind": "viz", "format": "cadmodeler-fea-viz", "version": 1, "units": "mm", "stressUnits": "MPa",
           "surface": {"file": "surface.bin", "vertices": int(nv), "triangles": int(nt)},
           "fields": {
               "displacement": {"file": "displacement.bin", "components": 3, "units": "mm",
                                "min": float(dmag.min()), "max": float(dmag.max())},
               "vonMises": {"file": "vonmises.bin", "components": 1, "units": "MPa",
                            "min": float(vm[used].min()), "max": float(vm[used].max())},
               "safetyFactor": {"file": "safety.bin", "components": 1, "units": "", "cap": FOS_CAP,
                                "min": float(min(fos[used].min(), FOS_CAP)), "max": float(min(fos[used].max(), FOS_CAP))},
               "principal": {"file": "principal.bin", "components": 3, "units": "MPa", "order": "s1,s2,s3"},
           }}
    man.update(manifest_extra)
    write_json_atomic(os.path.join(vdir, "manifest.json"), man)
    log(f"viz: {nv:,} surface vertices, {nt:,} triangles")
    return man


# ----------------------------------------------------------------------------- the run
def solve_case(case: FeaCase, rep: Reporter | None = None, prefer_gpu=True, quality=None, size_mm=None,
               method=None, export_viz=True, log=print):
    """Run the analysis. Returns (results dict, arrays dict). Raises StopRequested / CaseError."""
    rep = rep or Reporter(case, log=log)
    warnings: list[str] = []
    timings = {}
    t = time.time()
    stop = rep.check_stop

    # ---- mesh
    mcfg = case.mesh
    q = quality or mcfg.get("quality") or "medium"
    rep.progress("meshing", 0, "importing STEP", force=True)
    mesh = mesh_step(case.step_path, quality=q, size_mm=size_mm or finite(mcfg.get("size_mm")), log=log,
                     progress=lambda f, msg: rep.progress("meshing", f, msg), should_stop=stop)
    nodes, tets = mesh.nodes, mesh.tets
    timings["meshing_s"] = round(time.time() - t, 3)
    stop()
    L = mesh.info["extent_mm"]

    # ---- materials per element
    bvols = body_volumes(case, mesh)
    mats = []
    elem_mat = np.zeros(len(tets), np.int32)
    vol2mat = {}
    for bi, b in enumerate(case.bodies):
        mats.append(material_of(b, warnings))
        for vt in bvols.get(b["id"], []):
            vol2mat[vt] = bi
    for vt in mesh.volumes:
        if vt not in vol2mat:
            warnings.append(f"gmsh volume {vt} not matched to a body; using {case.bodies[0].get('name')}'s material")
            vol2mat[vt] = 0
    lut = np.zeros(max(mesh.volumes) + 1, np.int32)
    for vt, mi in vol2mat.items():
        lut[vt] = mi
    elem_mat = lut[mesh.tet_volume]
    Dm = [el.elasticity_D(m["youngs_modulus_Pa"] * 1e-6, m["poissons_ratio"]) for m in mats]

    # ---- assembly
    t1 = time.time()
    rep.progress("assembling", 0, "element stiffness", force=True)
    K, evol, mindet = sv.assemble(nodes, tets, Dm, elem_mat, progress=lambda f, m: rep.progress("assembling", f * 0.8, m),
                                  should_stop=stop)
    if mindet <= 0:
        warnings.append("some elements are inverted (negative Jacobian); results near them are unreliable")
    ndof = 3 * len(nodes)
    f = np.zeros(ndof)

    bnd, nflip = boundary_faces(nodes, tets)
    bsurf = assign_surfaces(bnd, mesh.surfaces)
    surf_faces = {tag: bnd[bsurf == tag] for tag in mesh.surfaces}

    # ---- loads
    load_info = []
    for li, ld in enumerate(case.loads):
        tags, finfo = resolve_refs(ld["faces"], case, mesh, bvols, L, warnings, f"load {li + 1}")
        faces = np.vstack([surf_faces[tg] for tg in dict.fromkeys(tags)])
        Xf = nodes[faces]
        if ld["type"] == "force":
            vec = np.asarray(ld["vector_N"], float)
            area = el.tri6_area(Xf).sum()
            trac = np.repeat((vec / area)[None, :], len(faces), axis=0)
            Fe, _ = el.tri6_loads(Xf, traction=trac)
            entry = {"type": "force", "vector_N": vec.tolist(), "area_mm2": float(area)}
        elif ld["type"] == "bearing":
            # a shaft or pin pushing on a hole: only the half facing the push is loaded, with a cosine
            # spread (heaviest straight ahead, zero at the sides), and the resultant is exactly vector_N
            vec = np.asarray(ld["vector_N"], float)
            fh = vec / max(np.linalg.norm(vec), 1e-300)
            n, a = face_normals(Xf)
            w = np.maximum(0.0, -(n @ fh))
            area = float(a.sum())
            den = float((w * el.tri6_area(Xf)).sum())
            if den <= 1e-12 * max(area, 1e-300):
                raise CaseError(f"load {li + 1}: the bearing direction does not push on the selected faces")
            trac = (w / den)[:, None] * vec[None, :]
            Fe, _ = el.tri6_loads(Xf, traction=trac)
            p0, ax, rad, qual = fit_axis(Xf)
            if qual > 0.05:
                warnings.append(f"load {li + 1}: the bearing faces are not cylindrical; the load is spread by facing direction only")
            entry = {"type": "bearing", "vector_N": vec.tolist(), "area_mm2": area, "radius_mm": rad,
                     "loaded_area_mm2": float(a[w > 0].sum())}
        else:
            p = float(ld["magnitude_Pa"]) * 1e-6
            Fe, a = el.tri6_loads(Xf, pressure=np.full(len(faces), p))
            area = a.sum()
            entry = {"type": "pressure", "magnitude_Pa": float(ld["magnitude_Pa"]), "area_mm2": float(area),
                     "resultant_N": Fe.reshape(-1, 3).sum(0).tolist()}
        np.add.at(f, (3 * faces[:, :, None] + np.arange(3)).ravel(), Fe.reshape(-1))
        entry["faces"] = finfo
        load_info.append(entry)
    grav = case.gravity
    if grav.get("enabled"):
        gvec = np.asarray(grav.get("vector_m_s2") or [0, 0, -G0], float) * 1000.0  # mm/s^2
        rho = np.array([m["density_kg_m3"] * 1e-12 for m in mats])[elem_mat]       # t/mm^3
        f += sv.body_loads(nodes, tets, rho[:, None] * gvec[None, :])
        mass = float(np.sum(evol * np.array([m["density_kg_m3"] for m in mats])[elem_mat]) * 1e-9)
        load_info.append({"type": "gravity", "vector_m_s2": (gvec / 1000).tolist(), "mass_kg": mass,
                          "resultant_N": (mass * gvec / 1000).tolist()})
    applied = f.reshape(-1, 3).sum(0)
    if not case.loads and not grav.get("enabled"):
        warnings.append("no loads: the result is all zero")

    # ---- fixtures
    fixed = np.zeros(ndof, bool)
    fix_nodes, fix_info = [], []
    taken = np.zeros(len(nodes), bool)
    frames = {}   # node -> (3,3) local frame of a pin support (rows radial, tangential, axial)
    pin_dofs = []
    for fi, fx in enumerate(case.fixtures):
        tags, finfo = resolve_refs(fx["faces"], case, mesh, bvols, L, warnings, f"fixture {fi + 1}")
        sf = np.vstack([surf_faces[tg] for tg in dict.fromkeys(tags)])
        nn = np.unique(sf.ravel())
        own = nn[~taken[nn]]
        taken[nn] = True
        fix_nodes.append(own)
        if fx.get("type") == "pin":
            # pin support (a shaft or pin in a hole): hold the chosen directions in the cylinder's own
            # frame. Radial = the hole can't change shape or move off the shaft, axial = no sliding
            # along it, tangential = no turning about it
            p0, ax, rad, qual = fit_axis(nodes[sf])
            if qual > 0.05:
                warnings.append(f"fixture {fi + 1}: pin support faces are not cylindrical (fit {qual:.2f}); "
                                "radial / tangential follow the best-fit axis")
            R = node_frames(nodes[nn], p0, ax)
            for k, node in enumerate(nn):
                frames[int(node)] = R[k]
            hold = [i for i, key in enumerate(("radial", "tangential", "axial")) if fx.get(key)]
            pin_dofs.append((3 * nn[:, None] + np.asarray(hold)[None, :]).ravel())
            fix_info.append({"type": "pin", "faces": finfo, "nodes": int(len(nn)),
                             "radial": bool(fx.get("radial")), "axial": bool(fx.get("axial")),
                             "tangential": bool(fx.get("tangential")),
                             "axis": {"point": p0.tolist(), "direction": ax.tolist(), "radius_mm": rad}})
        else:
            fixed[(3 * nn[:, None] + np.arange(3)).ravel()] = True
            fix_info.append({"type": "fixed", "faces": finfo, "nodes": int(len(nn))})
    for d in pin_dofs:
        fixed[d] = True
    # nodes held by a pin get their dofs rotated into its frame: u = T u', solve T^T K T u' = T^T f
    T = None
    if frames:
        ids = np.fromiter(frames.keys(), np.int64)
        Rs = np.stack([frames[int(i)] for i in ids])            # u_local = R u_global, so u_global = R^T u_local
        plain = np.ones(len(nodes), bool); plain[ids] = False
        pd = (3 * np.nonzero(plain)[0][:, None] + np.arange(3)).ravel()
        ab = np.arange(3)
        br = np.broadcast_to(3 * ids[:, None, None] + ab[None, :, None], (len(ids), 3, 3)).ravel()  # T[3i+a, 3i+b] = R[b, a]
        bc = np.broadcast_to(3 * ids[:, None, None] + ab[None, None, :], (len(ids), 3, 3)).ravel()
        T = sp.csr_matrix((np.concatenate([np.ones(len(pd)), np.transpose(Rs, (0, 2, 1)).ravel()]),
                           (np.concatenate([pd, br]), np.concatenate([pd, bc]))), shape=(ndof, ndof))
    timings["assembling_s"] = round(time.time() - t1, 3)
    stop()

    # ---- solve
    t2 = time.time()
    free = ~fixed
    nfree = int(free.sum())
    rep.progress("solving", 0, f"{nfree:,} equations", force=True)
    Kl, fl = (K, f) if T is None else ((T.T @ K @ T).tocsr(), T.T @ f)
    Kff = Kl[free][:, free].tocsr()
    u = np.zeros(ndof)
    if np.abs(fl[free]).max(initial=0) > 0:
        meth = method or (case.solver.get("method") if case.solver.get("method") not in (None, "auto") else "auto")
        tol = finite(case.solver.get("tolerance"), 1e-8)
        uf, sinfo = sv.solve(Kff, fl[free], method=meth, prefer_gpu=prefer_gpu and case.solver.get("gpu", True) is not False,
                             tol=tol, log=log, should_stop=stop,
                             progress=lambda fr, m: rep.progress("solving", fr, m))
        u[free] = uf
        if T is not None:
            u = T @ u
        if not sinfo.get("converged"):
            warnings.append(f"solver did not fully converge (residual {sinfo.get('residual'):.2e}); "
                            "check that the fixtures stop all rigid-body motion")
    else:
        sinfo = {"method": "none", "backend": "cpu", "iterations": 0, "residual": 0.0, "converged": True}
    timings["solving_s"] = round(time.time() - t2, 3)
    log(f"solve: {nfree:,} equations, {sinfo['method']} on {sinfo['backend']}, {sinfo['iterations']} it, "
        f"residual {sinfo['residual']:.2e}, {timings['solving_s']:.2f} s")
    if not np.all(np.isfinite(u)):
        raise RuntimeError("The solution contains NaN: the model is probably not fully constrained "
                           "(add fixtures so it cannot slide or rotate).")
    stop()

    # ---- post: reactions, stresses
    t3 = time.time()
    rep.progress("post", 0, "stresses", force=True)
    R = (K @ u - f).reshape(-1, 3)
    reactions = []
    for fi, nn in enumerate(fix_nodes):
        reactions.append({"fixture": fi, "force_N": R[nn].sum(0).tolist()})
    rtot = R[np.concatenate(fix_nodes)].sum(0) if fix_nodes else np.zeros(3)
    bal = float(np.linalg.norm(rtot + applied) / max(np.linalg.norm(applied), 1e-30)) if np.linalg.norm(applied) > 0 else 0.0

    S = np.zeros((len(nodes), 6))
    cnt = np.zeros(len(nodes))
    ymin = np.full(len(nodes), np.inf)
    U = u.reshape(-1, 3)
    yields = np.array([(m.get("yield_strength_Pa") or np.nan) * 1e-6 for m in mats])
    for s in range(0, len(tets), sv.CHUNK):
        e = slice(s, min(len(tets), s + sv.CHUNK))
        T = tets[e]
        strain = el.nodal_strains(nodes[T], U[T])                       # (e,10,6)
        if len(Dm) == 1:
            stress = strain @ Dm[0].T
        else:
            stress = np.einsum("ekl,eal->eak", np.stack(Dm)[elem_mat[e]], strain)
        np.add.at(S, T.ravel(), stress.reshape(-1, 6))
        np.add.at(cnt, T.ravel(), 1)
        ys = yields[elem_mat[e]]
        np.minimum.at(ymin, T.ravel(), np.repeat(np.where(np.isfinite(ys), ys, np.inf), 10))
    S /= np.maximum(cnt, 1)[:, None]
    vm = el.von_mises(S)
    princ = el.principal(S)
    with np.errstate(divide="ignore", invalid="ignore"):
        fos = np.where(vm > 0, ymin / vm, np.inf)
    fos = np.where(np.isfinite(ymin), fos, np.nan)
    dmag = np.linalg.norm(U, axis=1)
    timings["post_s"] = round(time.time() - t3, 3)

    i_vm, i_d = int(np.argmax(vm)), int(np.argmax(dmag))
    has_fos = np.isfinite(fos).any() or np.isinf(fos).any()
    fos_c = np.where(np.isnan(fos), np.inf, fos)
    i_f = int(np.argmin(fos_c))
    min_fos = float(min(fos_c[i_f], FOS_CAP)) if has_fos else None
    mass = float(np.sum(evol * np.array([m["density_kg_m3"] for m in mats])[elem_mat]) * 1e-9)

    # ---- face map (every boundary surface -> CAD face, when the case lists the body's faces)
    face_map = []
    for b in case.bodies:
        for fr in b.get("faces") or []:
            vol = bvols.get(b["id"], [])
            cand = [tg for tg, s in mesh.surfaces.items() if set(s["volumes"]) & set(vol)]
            tg, d = match_face({**fr, "body": b["id"]}, mesh, cand, L, len(case.bodies) == 1)
            face_map.append({"body": b["id"], "face": fr.get("idx"), "surface": tg, "distance_mm": round(d or 0, 6)})

    results = {
        "units": {"length": "mm", "displacement": "mm", "stress": "MPa", "force": "N", "mass": "kg"},
        "analysis": "static-stress",
        "maxVonMises_MPa": float(vm[i_vm]),
        "maxDisplacement_mm": float(dmag[i_d]),
        "minSafetyFactor": min_fos,
        "maxPrincipal_MPa": float(princ[:, 0].max()), "minPrincipal_MPa": float(princ[:, 2].min()),
        "locations": {"maxVonMises": nodes[i_vm].tolist(), "maxDisplacement": nodes[i_d].tolist(),
                      "minSafetyFactor": nodes[i_f].tolist() if has_fos else None},
        "materials": [{"body": b["id"], "name": m.get("name"), "E_MPa": m["youngs_modulus_Pa"] * 1e-6,
                       "nu": m["poissons_ratio"], "density_kg_m3": m["density_kg_m3"],
                       "yield_MPa": (m.get("yield_strength_Pa") or 0) * 1e-6 or None, "yieldFrom": m.get("_yield_from")}
                      for b, m in zip(case.bodies, mats)],
        "reactions": reactions,
        "reactionTotal_N": rtot.tolist(),
        "appliedTotal_N": applied.tolist(),
        "equilibriumError": bal,
        "loads": load_info, "fixtures": fix_info,
        "mass_kg": mass, "volume_mm3": float(evol.sum()),
        "nodes": int(len(nodes)), "elements": int(len(tets)), "dofs": int(ndof), "freeDofs": nfree,
        "elementType": "TET10",
        "mesh": {"quality": q, "size_mm": mesh.size_mm, "extent_mm": L, "thickness_mm": mesh.info["thickness_mm"],
                 "surfaces": len(mesh.surfaces), "flippedElements": nflip},
        "solver": sinfo,
        "faceMap": face_map,
        "timings": timings,
        "warnings": warnings,
    }
    arrays = {"nodes": nodes, "tets": tets, "u": U, "stress": S, "vm": vm, "fos": fos, "bnd": bnd, "bsurf": bsurf}

    if export_viz:
        t4 = time.time()
        rep.progress("writing", 0.1, "viewport data", force=True)
        surfmap = {}
        for e in face_map:
            surfmap.setdefault(e["surface"], {"body": e["body"], "face": e["face"]})
        extra = {"markers": {
                    "maxVonMises": {"pos": nodes[i_vm].tolist(), "value": float(vm[i_vm])},
                    "maxDisplacement": {"pos": nodes[i_d].tolist(), "value": float(dmag[i_d])},
                    "minSafetyFactor": {"pos": nodes[i_f].tolist(), "value": min_fos} if has_fos else None},
                 "extent_mm": L,
                 "surfaces": {str(tg): {"cad": surfmap.get(tg), "area_mm2": s["area"]} for tg, s in mesh.surfaces.items()},
                 "yield_MPa": [r["yield_MPa"] for r in results["materials"]],
                 "status": "completed"}
        write_viz(case.folder, nodes, bnd, bsurf, u, vm, np.where(np.isnan(fos), np.inf, fos), princ, extra, log=log)
        timings["writing_s"] = round(time.time() - t4, 3)
    return results, arrays


def run_headless(folder: str, prefer_gpu: bool = True, quality=None, log=print) -> int:
    """CLI entry: returns the process exit code (0 = completed or stopped)."""
    folder = os.path.abspath(folder)
    for n in (STOP_FILE, RESULTS_FILE, PROGRESS_FILE):
        try:
            os.remove(os.path.join(folder, n))
        except OSError:
            pass
    try:
        case = load_case(folder)
    except Exception as e:
        log(f"error: {e}")
        if os.path.isdir(folder):
            from .caseio import FORMAT, VERSION
            write_json_atomic(os.path.join(folder, RESULTS_FILE), {"kind": "results", "format": FORMAT, "version": VERSION,
                                                                   "status": "failed", "error": str(e)})
        return 2
    rep = Reporter(case, log=log)
    rep.progress("starting", 0, "starting", force=True)
    log(f"FEA case {case.design}: {len(case.bodies)} body(ies), {len(case.fixtures)} fixture(s), {len(case.loads)} load(s)")
    try:
        res, _ = solve_case(case, rep, prefer_gpu=prefer_gpu, quality=quality, log=log)
        rep.finish("completed", res)
        log(f"done: max von Mises {res['maxVonMises_MPa']:.4g} MPa, max displacement {res['maxDisplacement_mm']:.4g} mm, "
            f"min safety factor {res['minSafetyFactor'] if res['minSafetyFactor'] is None else round(res['minSafetyFactor'], 3)}")
        return 0
    except StopRequested:
        log("Stopped by CAD Modeler.")
        rep.finish("stopped", {})
        return 0
    except Exception as e:
        tb = traceback.format_exc()
        log(tb)
        msg = str(e) if isinstance(e, (CaseError, RuntimeError)) else f"{type(e).__name__}: {e}"
        rep.finish("failed", {}, error=msg + "\n\n" + tb)
        return 1

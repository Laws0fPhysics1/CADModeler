"""In-CAD results: convert a run's frames into small binary files CAD Modeler draws in its own viewport.

Written into the case folder while the run goes (one call per frame from cadlink's frame callback):

    viz/manifest.json        frame list, colour ranges, file layout (see CAD Modeler/docs/cfd-exchange.md)
    viz/surface.bin          body surface: geometry.stl welded and subdivided to ~1 cell (see _build_surface)
    viz/surf_NNNN.bin        Cp at each surface.bin vertex              float32[nVerts]
    viz/iso_NNNN.bin         Q isosurface                               see write_iso
    viz/slice_NNNN.bin       three centre slices, speed + Cp            uint8 planes
    viz/lines_NNNN.bin       streamlines from an upstream rake          see write_lines

Everything is in CAD coordinates (mm, CAD axes) so the CAD side never needs the sim's orientation.
All writes go to <name>.tmp then os.replace, and the manifest is written last, so a reader that only
opens files listed in the manifest never sees a partial file.
"""
from __future__ import annotations

import json
import os
import struct

import numpy as np

from .geometry import load_mesh, orientation_matrix

MM = 0.001
MAGIC = {"surf": b"CSF1", "iso": b"CQI1", "slice": b"CSL1", "lines": b"CST1"}
SLICE_RANGE = {"speed": (0.0, 1.6), "cp": (-1.5, 1.0)}   # speed in units of U; uint8 quantization ranges
CP_RANGE = (-1.2, 1.0)


def _atomic_write(path: str, data: bytes):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            import time
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def trilinear(vol: np.ndarray, pts: np.ndarray, valid: np.ndarray | None = None) -> np.ndarray:
    """Sample vol[z, y, x] at fractional index points pts[:, (x, y, z)]. With `valid` (bool mask, same shape),
    only valid corners contribute (weights renormalized); points with no valid corner get NaN."""
    nz, ny, nx = vol.shape
    p = np.asarray(pts, dtype=np.float64)
    i0 = np.floor(p).astype(np.int64)
    f = p - i0
    out = np.zeros(len(p))
    wsum = np.zeros(len(p))
    for dz in (0, 1):
        for dy in (0, 1):
            for dx in (0, 1):
                xi = np.clip(i0[:, 0] + dx, 0, nx - 1)
                yi = np.clip(i0[:, 1] + dy, 0, ny - 1)
                zi = np.clip(i0[:, 2] + dz, 0, nz - 1)
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                if valid is not None:
                    w = w * valid[zi, yi, xi]
                out += w * vol[zi, yi, xi]
                wsum += w
    with np.errstate(invalid="ignore", divide="ignore"):
        return np.where(wsum > 1e-6, out / np.maximum(wsum, 1e-12), np.nan)


class VizExporter:
    """Turns run frames into viz/ files. Construct once per run; call frame(idx, run_folder) after each frame."""

    def __init__(self, case, log=print, streamlines: int = 160):
        self.case = case
        self.log = log
        self.n_lines = streamlines
        self.dir = os.path.join(case.folder, "viz")
        os.makedirs(self.dir, exist_ok=True)
        for f in os.listdir(self.dir):                   # a new run replaces the old results
            try:
                os.remove(os.path.join(self.dir, f))
            except OSError:
                pass
        self.frames = []
        self.ready = False
        self.cd_hist = []

    # ---------------------------------------------------------------- setup from the run folder
    def _setup(self, run_folder: str):
        with open(os.path.join(run_folder, "meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
        info, params = meta["info"], meta["params"]
        self.info, self.params = info, params
        self.U = float(params["speed"])
        rho = float(params.get("rho") or 1.204)
        from .solver import FLUIDS
        if params.get("fluid") in FLUIDS and FLUIDS[params["fluid"]][1] is not None:
            rho = FLUIDS[params["fluid"]][1]
        self.q = 0.5 * rho * self.U ** 2
        self.symmetry = bool(info.get("symmetry"))
        # CAD (mm) -> sim domain (m):  sim = A @ cad + b
        flow_axis, up_axis = self.case.flow["direction"], self.case.flow.get("up", "+Z")
        R = orientation_matrix(flow_axis, up_axis)
        m = load_mesh(self.case.stl_path)
        v = (R @ np.asarray(m.vertices, dtype=np.float64).T).T
        vmin = v.min(axis=0)
        ext = (v.max(axis=0) - vmin) * MM
        off = np.asarray(info["mesh_offset"], dtype=float).copy()
        if self.symmetry:
            off[1] = -float(ext[1]) / 2
        self.A = MM * R
        self.b = -MM * vmin + off
        self.Ainv = np.linalg.inv(self.A)
        # surface for Cp: the STL subdivided to about one playback cell, welded, with smooth normals
        tri = self._read_stl_corners(self.case.stl_path)
        self.corners = tri.reshape(-1, 3)
        self.body_center_cad = 0.5 * (self.corners.min(axis=0) + self.corners.max(axis=0))
        self.L_mm = float((self.corners.max(axis=0) - self.corners.min(axis=0)).max())
        h_mm = info["dx"] * info["stride"] / MM
        self._build_surface(tri, max(h_mm, self.L_mm / 160.0))
        sol = np.load(os.path.join(run_folder, "solid.npz"))
        self.solid = sol["solid"].astype(bool)
        self.ready = True

    def _build_surface(self, tri: np.ndarray, max_edge: float):
        import trimesh
        n = len(tri)
        m = trimesh.Trimesh(tri.reshape(-1, 3), np.arange(3 * n).reshape(-1, 3), process=True)   # weld
        v, f = np.asarray(m.vertices), np.asarray(m.faces)
        try:
            for _ in range(6):                         # cap the vertex count (~400k) for huge bodies
                v2, f2 = trimesh.remesh.subdivide_to_size(v, f, max_edge=max_edge, max_iter=12)
                if len(v2) <= 400_000:
                    v, f = v2, f2
                    break
                max_edge *= 1.6
        except Exception as e:
            self.log(f"viz: surface subdivision skipped ({e})")
        sm = trimesh.Trimesh(v, f, process=True)
        self.surf_v = np.asarray(sm.vertices, dtype=np.float64)
        self.surf_f = np.asarray(sm.faces, dtype=np.uint32)
        self.surf_n = np.asarray(sm.vertex_normals, dtype=np.float64)
        data = MAGIC["surf"] + struct.pack("<II", len(self.surf_v), len(self.surf_f)) +             self.surf_v.astype(np.float32).tobytes() + self.surf_f.tobytes()
        _atomic_write(os.path.join(self.dir, "surface.bin"), data)

    @staticmethod
    def _read_stl_corners(path: str) -> np.ndarray:
        with open(path, "rb") as fh:
            data = fh.read()
        if len(data) >= 84:
            n = struct.unpack_from("<I", data, 80)[0]
            if 84 + 50 * n == len(data):
                rec = np.frombuffer(data, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]), count=n, offset=84)
                return rec["v"].astype(np.float64)
        m = load_mesh(path)                              # ASCII fallback (same order for a plain STL)
        return np.asarray(m.vertices)[np.asarray(m.faces)].astype(np.float64)

    # ---------------------------------------------------------------- coordinates
    def cad_to_sim(self, p):
        return (self.A @ np.asarray(p, dtype=np.float64).T).T + self.b

    def sim_to_cad(self, p):
        return (self.Ainv @ (np.asarray(p, dtype=np.float64) - self.b).T).T

    def sim_dir_to_cad(self, d):
        return (self.Ainv @ np.asarray(d, dtype=np.float64).T).T * MM   # direction, unit-free -> rotate only

    def _index(self, sim_pts, h):
        """Fractional array index (x, y, z) on a grid of spacing h with cell centres at (i + 0.5) h."""
        return np.asarray(sim_pts) / h - 0.5

    # ---------------------------------------------------------------- per frame
    def frame(self, idx: int, run_folder: str):
        try:
            if not self.ready:
                self._setup(run_folder)
            path = os.path.join(run_folder, f"frame_{idx:04d}.npz")
            d = np.load(path)
            ux, uy, uz = (d["ux"].astype(np.float32), d["uy"].astype(np.float32), d["uz"].astype(np.float32))
            p = d["p"].astype(np.float32)
            t = float(d["t"])
            h = self.info["dx"] * self.info["stride"]
            sol = self.solid[: ux.shape[0], : ux.shape[1], : ux.shape[2]]
            if sol.shape != ux.shape:
                s2 = np.zeros(ux.shape, bool); s2[: sol.shape[0], : sol.shape[1], : sol.shape[2]] = sol; sol = s2
            fluid = ~sol
            entry = {"index": idx, "t": t}
            entry["surf"] = self.write_surface(idx, p, fluid, h)
            iso = self.write_iso(idx, run_folder)
            if iso:
                entry["iso"] = iso
            entry["slice"] = self.write_slices(idx, ux, uy, uz, p, fluid, h)
            lines = self.write_lines(idx, ux, uy, uz, fluid, h)
            if lines:
                entry["lines"] = lines
            self.frames.append(entry)
            self.write_manifest()
        except Exception as e:                            # never let visualization kill the run
            import traceback
            self.log(f"viz export frame {idx}: {e}\n{traceback.format_exc()}")

    def write_surface(self, idx, p, fluid, h):
        # probe 1.25 playback cells outward along the (rotated, unit) normal: solid cells hold no pressure
        probe = self.cad_to_sim(self.surf_v) + (self.A @ self.surf_n.T).T / MM * 1.25 * h
        cp = trilinear(p, self._index(probe, h), valid=fluid) / self.q
        cp = np.where(np.isfinite(cp), cp, 0.0).astype(np.float32)
        name = f"surf_{idx:04d}.bin"
        _atomic_write(os.path.join(self.dir, name), cp.tobytes())
        return {"file": name, "count": int(len(cp)), "min": float(np.percentile(cp, 1)), "max": float(np.percentile(cp, 99))}

    def write_iso(self, idx, run_folder):
        """iso file layout: magic 'CQI1', uint32 nPts, uint32 nTri, float32[3n] pos (mm), int8[3n] normals (pad to 4),
        uint8[n] speed/U * 100 (pad to 4), uint32[3m] triangles."""
        src = os.path.join(run_folder, f"iso_{idx:04d}.npz")
        if not os.path.isfile(src):
            return None
        d = np.load(src)
        pts, tris = d["pts"], d["tris"]
        if len(pts) == 0:
            pos = np.zeros((0, 3), np.float32); nrm = np.zeros((0, 3), np.int8); spd = np.zeros(0, np.uint8); tris = np.zeros((0, 3), np.uint32)
        else:
            nrm_s = d["normals"].astype(np.float32) / 127.0
            spd_f = d["speed"].astype(np.float32)
            if self.symmetry:
                n = len(pts)
                pts = np.concatenate([pts, pts * np.array([1, -1, 1], np.float32)])
                nrm_s = np.concatenate([nrm_s, nrm_s * np.array([1, -1, 1], np.float32)])
                spd_f = np.concatenate([spd_f, spd_f])
                tris = np.concatenate([tris, (tris + n)[:, [0, 2, 1]]])
            pos = self.sim_to_cad(pts).astype(np.float32)
            nc = (self.Ainv @ nrm_s.T).T
            nc /= np.maximum(np.linalg.norm(nc, axis=1, keepdims=True), 1e-9)
            nrm = np.clip(np.rint(nc * 127), -127, 127).astype(np.int8)
            spd = np.clip(np.rint(spd_f / self.U * 100), 0, 255).astype(np.uint8)
            # R may be a reflection-free rotation, but keep winding consistent with det(A)
            if np.linalg.det(self.A) < 0:
                tris = tris[:, [0, 2, 1]]
            tris = tris.astype(np.uint32)
        n, m = len(pos), len(tris)
        pad = lambda b: b + b"\0" * ((-len(b)) % 4)
        data = MAGIC["iso"] + struct.pack("<II", n, m) + pos.tobytes() + pad(nrm.tobytes()) + pad(spd.tobytes()) + tris.tobytes()
        name = f"iso_{idx:04d}.bin"
        _atomic_write(os.path.join(self.dir, name), data)
        return {"file": name, "points": n, "triangles": m}

    def _slice_planes(self, shape, h):
        """Three planes through the body centre: (flow, up), (flow, side), (side, up) in sim axes.
        Returns [(name, axis_fixed, index_fixed)]."""
        c = self.cad_to_sim(self.body_center_cad[None])[0]
        nz, ny, nx = shape
        ci = np.clip(np.rint(c / h - 0.5).astype(int), 0, [nx - 1, ny - 1, nz - 1])
        # cross-flow plane half a body length behind the body
        back = self.cad_to_sim(self.corners).max(axis=0)[0] + 0.5 * self.L_mm * MM
        xi = int(np.clip(np.rint(back / h - 0.5), 0, nx - 1))
        return [("side", 1, int(ci[1])), ("top", 2, int(ci[2])), ("wake", 0, xi)]

    def write_slices(self, idx, ux, uy, uz, p, fluid, h):
        """slice file: magic 'CSL1', uint32 count, then per slice: uint32 w, uint32 hgt, float32[12] corners in CAD mm
        (origin, +u end, +v end, unused) , uint8[w*h] speed, uint8[w*h] cp, uint8[w*h] solid mask (pad each to 4)."""
        spd = np.sqrt(ux * ux + uy * uy + uz * uz) / self.U
        cp = p / self.q
        planes = self._slice_planes(ux.shape, h)
        nz, ny, nx = ux.shape
        out = [MAGIC["slice"], struct.pack("<I", len(planes))]
        meta = []
        pad = lambda b: b + b"\0" * ((-len(b)) % 4)
        for name, ax, k in planes:
            if ax == 1:        # x across (u), z up (v)
                S, C, F = spd[:, k, :], cp[:, k, :], fluid[:, k, :]
                o = [0.5 * h, (k + 0.5) * h, 0.5 * h]; eu = [(nx - 0.5) * h, (k + 0.5) * h, 0.5 * h]; ev = [0.5 * h, (k + 0.5) * h, (nz - 0.5) * h]
            elif ax == 2:      # x (u), y (v)
                S, C, F = spd[k, :, :], cp[k, :, :], fluid[k, :, :]
                o = [0.5 * h, 0.5 * h, (k + 0.5) * h]; eu = [(nx - 0.5) * h, 0.5 * h, (k + 0.5) * h]; ev = [0.5 * h, (ny - 0.5) * h, (k + 0.5) * h]
            else:              # y (u), z (v)
                S, C, F = spd[:, :, k], cp[:, :, k], fluid[:, :, k]
                o = [(k + 0.5) * h, 0.5 * h, 0.5 * h]; eu = [(k + 0.5) * h, (ny - 0.5) * h, 0.5 * h]; ev = [(k + 0.5) * h, 0.5 * h, (nz - 0.5) * h]
            hh, ww = S.shape                               # rows = v, cols = u
            q = lambda a, r: np.clip(np.rint((a - r[0]) / (r[1] - r[0]) * 255), 0, 255).astype(np.uint8)
            corners = self.sim_to_cad(np.array([o, eu, ev, o])).astype(np.float32)
            out += [struct.pack("<II", ww, hh), corners.tobytes(),
                    pad(q(S, SLICE_RANGE["speed"]).tobytes()), pad(q(C, SLICE_RANGE["cp"]).tobytes()),
                    pad(F.astype(np.uint8).tobytes())]
            meta.append({"name": name, "w": ww, "h": hh})
        fname = f"slice_{idx:04d}.bin"
        _atomic_write(os.path.join(self.dir, fname), b"".join(out))
        return {"file": fname, "planes": meta}

    def write_lines(self, idx, ux, uy, uz, fluid, h):
        """Streamlines seeded on a rake upstream of the body (a grid across the frontal area).
        lines file: magic 'CST1', uint32 nLines, uint32 nPts, uint32[nLines + 1] offsets, float32[3 nPts] pos (mm),
        uint8[nPts] speed/U * 100 (padded)."""
        if self.n_lines <= 0:
            return None
        sim_body = self.cad_to_sim(self.corners)
        lo, hi = sim_body.min(axis=0), sim_body.max(axis=0)
        nz, ny, nx = ux.shape
        side = int(max(2, round(np.sqrt(self.n_lines))))
        ys = np.linspace(lo[1] - 0.15 * (hi[1] - lo[1]), hi[1] + 0.15 * (hi[1] - lo[1]), side)
        zs = np.linspace(max(lo[2] - 0.15 * (hi[2] - lo[2]), h), hi[2] + 0.15 * (hi[2] - lo[2]), side)
        Y, Z = np.meshgrid(ys, zs)
        x0 = max(lo[0] - 0.4 * (hi[0] - lo[0]), 2 * h)
        seeds = np.stack([np.full(Y.size, x0), Y.ravel(), Z.ravel()], axis=1)
        x_end = min(hi[0] + 2.5 * (hi[0] - lo[0]), (nx - 1) * h)
        step = 0.6 * h
        n_steps = int(min(2000, (x_end - x0) / step * 2.5))
        U = self.U
        P = seeds.copy()
        N = len(P)
        hist = np.full((n_steps + 1, N, 3), np.nan)
        shist = np.zeros((n_steps + 1, N))
        hist[0], shist[0] = P, 1.0
        length = np.ones(N, int)
        alive = np.ones(N, bool)
        maxi = np.array([nx - 1, ny - 1, nz - 1]) * h

        def vel(q):
            ij = self._index(q, h)
            return np.stack([trilinear(ux, ij), trilinear(uy, ij), trilinear(uz, ij)], axis=1)

        for k in range(1, n_steps + 1):
            ids = np.nonzero(alive)[0]
            if not len(ids):
                break
            q = P[ids]
            v1 = vel(q)
            s1 = np.linalg.norm(v1, axis=1)
            mid = q + 0.5 * step * v1 / np.maximum(s1, 1e-6)[:, None]
            v2 = vel(mid)
            s2 = np.linalg.norm(v2, axis=1)
            nq = q + step * v2 / np.maximum(s2, 1e-6)[:, None]
            ij = np.clip(np.rint(self._index(nq, h)).astype(int), 0, [nx - 1, ny - 1, nz - 1])
            inside = fluid[ij[:, 2], ij[:, 1], ij[:, 0]]
            ok = (s2 > 0.02 * U) & np.all(nq > 0.5 * h, axis=1) & np.all(nq < maxi, axis=1) & (nq[:, 0] < x_end) & inside
            good = ids[ok]
            P[good] = nq[ok]
            hist[k, good] = nq[ok]
            shist[k, good] = s2[ok] / U
            length[good] = k + 1
            alive[ids[~ok]] = False
        keep = [i for i in range(N) if length[i] >= 4]
        if not keep:
            return None
        offs = [0]
        pts, sp = [], []
        for i in keep:
            pts.append(hist[: length[i], i]); sp.append(shist[: length[i], i])
            offs.append(offs[-1] + int(length[i]))
        pts = self.sim_to_cad(np.concatenate(pts)).astype(np.float32)
        sp = np.clip(np.rint(np.concatenate(sp) * 100), 0, 255).astype(np.uint8)
        pad = lambda b: b + b"\0" * ((-len(b)) % 4)
        data = MAGIC["lines"] + struct.pack("<II", len(keep), len(pts)) + np.asarray(offs, np.uint32).tobytes() + \
            pts.tobytes() + pad(sp.tobytes())
        name = f"lines_{idx:04d}.bin"
        _atomic_write(os.path.join(self.dir, name), data)
        return {"file": name, "lines": len(keep), "points": int(len(pts))}

    def write_manifest(self, status: str | None = None):
        if not self.ready:
            return
        f = self.case.flow
        man = {"kind": "viz", "format": "cadmodeler-cfd-viz", "version": 1,
               "units": "mm", "speed_m_s": self.U, "q_Pa": self.q,
               "flow": {"direction": f["direction"], "up": f.get("up", "+Z")},
               "ranges": {"cp": list(CP_RANGE), "slice": {k: list(v) for k, v in SLICE_RANGE.items()},
                          "speedScale": 100, "isoSpeedScale": 100},
               "bodyLengthMm": self.L_mm, "symmetry": self.symmetry,
               "surface": {"file": "surface.bin", "vertices": int(len(self.surf_v)), "triangles": int(len(self.surf_f))},
               "frames": self.frames}
        if status:
            man["status"] = status
        data = json.dumps(man, indent=1).encode("utf-8")
        _atomic_write(os.path.join(self.dir, "manifest.json"), data)

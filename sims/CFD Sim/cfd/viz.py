"""Run loading and derived-field computation for playback."""
from __future__ import annotations

import glob
import json
import os
import threading
from collections import OrderedDict

import numpy as np
import pyvista as pv


class Run:
    """A finished (or in-progress) run folder."""

    def __init__(self, folder: str):
        self.folder = folder
        self.reload_meta()
        m = np.load(os.path.join(folder, "mesh.npz"))
        self.mesh = pv.PolyData(m["vertices"], np.hstack([np.full((len(m["faces"]), 1), 3), m["faces"]]).ravel())
        sol = np.load(os.path.join(folder, "solid.npz"))
        self.solid = sol["solid"]
        self.glb = os.path.join(folder, "body.glb") if os.path.isfile(os.path.join(folder, "body.glb")) else None
        self.display = None
        if os.path.isfile(os.path.join(folder, "display.json")):
            with open(os.path.join(folder, "display.json")) as fh:
                self.display = json.load(fh)
        self._cache: OrderedDict[str, dict] = OrderedDict()
        self._lock = threading.RLock()
        self._full = None

    # -- metadata ---------------------------------------------------------------------
    def reload_meta(self):
        with open(os.path.join(self.folder, "meta.json")) as fh:
            meta = json.load(fh)
        self.params = meta["params"]
        self.info = meta["info"]
        self.frame_times = meta["frame_times"]
        self.frames = sorted(glob.glob(os.path.join(self.folder, "frame_[0-9]*.npz")))
        self.iso_files = {int(os.path.basename(f)[4:8]): f for f in glob.glob(os.path.join(self.folder, "iso_[0-9]*.npz"))}
        self.isof_files = {int(os.path.basename(f)[5:9]): f for f in glob.glob(os.path.join(self.folder, "isof_[0-9]*.npz"))}
        self.vort_files = {int(os.path.basename(f)[5:9]): f for f in glob.glob(os.path.join(self.folder, "vort_[0-9]*.npy"))}
        self.vort_scale = meta.get("vort_scale", None)
        self.iso_level_phys = meta.get("iso_level_phys", None)
        self.dx = self.info["dx"]
        self.stride = self.info["stride"]
        self.symmetry = bool(self.info.get("symmetry", False))
        self.speed = self.params["speed"]
        self.L = float(np.max(self.mesh_extent)) if hasattr(self, "mesh") else 1.0

    @property
    def n_frames(self) -> int:
        return len(self.frames)

    @property
    def mesh_extent(self):
        b = self.mesh.bounds
        return np.array([b[1] - b[0], b[3] - b[2], b[5] - b[4]])

    @property
    def has_full(self) -> bool:
        return os.path.isfile(os.path.join(self.folder, "frame_full.npz"))

    def has_iso(self, idx: int, fine: bool = False) -> bool:
        return idx in (self.isof_files if fine else self.iso_files)

    def has_vort(self, idx: int) -> bool:
        return idx in self.vort_files

    def load_iso(self, idx: int, fine: bool = False) -> pv.PolyData:
        """Precomputed full-resolution Q isosurface with normals and speed."""
        with self._lock:
            key = f"iso{'f' if fine else ''}{idx}"
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            d = np.load((self.isof_files if fine else self.iso_files)[idx])
            pts, tris = d["pts"], d["tris"]
            if len(pts) == 0:
                mesh = pv.PolyData()
            else:
                normals = d["normals"].astype(np.float32) / 127.0
                speed = d["speed"].astype(np.float32)
                if self.symmetry:   # mirror across y = 0 (flip winding so the normals stay outward)
                    n = len(pts)
                    pts = np.concatenate([pts, pts * np.array([1, -1, 1], np.float32)])
                    normals = np.concatenate([normals, normals * np.array([1, -1, 1], np.float32)])
                    speed = np.concatenate([speed, speed])
                    tris = np.concatenate([tris, (tris + n)[:, [0, 2, 1]]])
                faces = np.empty((len(tris), 4), np.int64); faces[:, 0] = 3; faces[:, 1:] = tris
                mesh = pv.PolyData(pts, faces.ravel())
                mesh.point_data["Normals"] = normals
                mesh.point_data["speed"] = speed
                mesh.point_data.active_normals_name = "Normals"
            self._cache[key] = mesh
            self._trim_cache()
            return mesh

    def load_vort(self, idx: int) -> pv.ImageData:
        """Full-resolution |vorticity| as uint8 ImageData (0..255 = 0..vort_scale)."""
        with self._lock:
            key = f"vort{idx}"
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            v = np.load(self.vort_files[idx])
            h = self.dx
            y0 = 0.0
            if self.symmetry:
                y0 = -v.shape[1] * h
                v = np.concatenate([v[:, ::-1, :], v], axis=1)
            nz, ny, nx = v.shape
            g = pv.ImageData(dimensions=(nx, ny, nz), spacing=(h, h, h), origin=(0.5 * h, y0 + 0.5 * h, 0.5 * h))
            g.point_data["vort"] = v.ravel()
            self._cache[key] = g
            self._trim_cache()
            return g

    def _trim_cache(self):
        while len(self._cache) > 8:
            self._cache.popitem(last=False)

    def forces(self):
        path = os.path.join(self.folder, "forces.csv")
        try:
            d = np.genfromtxt(path, delimiter=",", names=True)
            return d if d.ndim else None
        except Exception:
            return None

    # -- fields -----------------------------------------------------------------------
    def load_frame(self, idx: int, full: bool = False) -> dict:
        with self._lock:
            key = "full" if full else str(idx)
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
            path = os.path.join(self.folder, "frame_full.npz") if full else self.frames[idx]
            d = np.load(path)
            ux, uy, uz = (d["ux"].astype(np.float32), d["uy"].astype(np.float32), d["uz"].astype(np.float32))
            p = d["p"].astype(np.float32)
            h = self.dx * (1 if full else self.stride)
            if full:
                sol = np.load(os.path.join(self.folder, "solid.npz"))["solid_full"]
            else:
                sol = self.solid
            sol = sol[: ux.shape[0], : ux.shape[1], : ux.shape[2]]
            y0 = 0.0
            if self.symmetry:   # mirror the half domain across y = 0
                y0 = -ux.shape[1] * h
                mir = lambda a, sgn=1.0: np.concatenate([a[:, ::-1, :] * sgn, a], axis=1)
                ux, uz, p = mir(ux), mir(uz), mir(p)
                uy = mir(uy, -1.0)
                sol = np.concatenate([sol[:, ::-1, :], sol], axis=1)
            fields = derive(ux, uy, uz, p, h)
            fields["t"] = float(d["t"])
            fields["h"] = h
            fields["y0"] = y0
            fields["solid"] = sol
            self._cache[key] = fields
            self._trim_cache()
            return fields

    def grid(self, fields: dict) -> pv.ImageData:
        nz, ny, nx = fields["speed"].shape
        h = fields["h"]
        g = pv.ImageData(dimensions=(nx, ny, nz), spacing=(h, h, h), origin=(0.5 * h, fields.get("y0", 0.0) + 0.5 * h, 0.5 * h))
        for k in ("speed", "p", "vort", "Q", "ux", "uy", "uz"):
            g.point_data[k] = fields[k].ravel(order="C")
        g.point_data["U"] = np.stack([fields["ux"].ravel(), fields["uy"].ravel(), fields["uz"].ravel()], axis=1)
        g.point_data["solid"] = fields["solid"].ravel().astype(np.uint8)
        g.set_active_vectors("U")
        g.set_active_scalars("speed")
        return g


def derive(ux, uy, uz, p, h):
    """Speed, vorticity magnitude and Q-criterion from velocity on a uniform grid (z, y, x)."""
    speed = np.sqrt(ux * ux + uy * uy + uz * uz)
    # gradients: axis 0 = z, 1 = y, 2 = x
    dux = np.gradient(ux, h, axis=(2, 1, 0))  # (d/dx, d/dy, d/dz)
    duy = np.gradient(uy, h, axis=(2, 1, 0))
    duz = np.gradient(uz, h, axis=(2, 1, 0))
    wx = duz[1] - duy[2]
    wy = dux[2] - duz[0]
    wz = duy[0] - dux[1]
    vort = np.sqrt(wx * wx + wy * wy + wz * wz)
    # Q = 0.5 (|Omega|^2 - |S|^2)
    sxx, syy, szz = dux[0], duy[1], duz[2]
    sxy = 0.5 * (dux[1] + duy[0]); sxz = 0.5 * (dux[2] + duz[0]); syz = 0.5 * (duy[2] + duz[1])
    S2 = sxx * sxx + syy * syy + szz * szz + 2 * (sxy * sxy + sxz * sxz + syz * syz)
    O2 = 0.5 * (wx * wx + wy * wy + wz * wz)
    Q = 0.5 * (O2 - S2)
    return dict(ux=ux, uy=uy, uz=uz, p=p, speed=speed, vort=vort, Q=Q.astype(np.float32))

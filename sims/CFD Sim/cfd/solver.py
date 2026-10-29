"""Case setup (physical units -> lattice units, domain, nested grids, boundary flags) and the run loop."""
from __future__ import annotations

import json
import math
import os
import time
from dataclasses import dataclass, asdict, field

import numpy as np

from .geometry import SimMesh, voxelize
from .lattice import FLUID, SOLID, INLET, OUTLET, FARFIELD, GROUND, GHOST

FLUIDS = {
    "Air (20°C)": (1.5e-5, 1.204),
    "Water (20°C)": (1.0e-6, 998.0),
    "Custom": (None, None),
}


@dataclass
class CaseParams:
    speed: float = 20.0               # free-stream speed, m/s
    fluid: str = "Air (20°C)"
    nu: float = 1.5e-5                # kinematic viscosity m^2/s (Custom fluid)
    rho: float = 1.204                # density kg/m^3 (Custom fluid)
    resolution: int = 80              # cells across the object's longest dimension, on the finest grid
    pad_up: float = 2.0               # upstream padding, multiples of object length
    pad_down: float = 4.0             # downstream
    pad_side: float = 1.5             # each lateral side
    pad_top: float = 1.5              # above (and below if no ground)
    max_blockage: float = 0.01        # widen pad_side / pad_top until bbox frontal area / tunnel section <= this (0 = off)
    ground: bool = False              # floor under the object
    ground_gap: float = 0.0           # metres between floor and object's lowest point
    moving_ground: bool = True        # belt at free-stream speed: no shear -> modelled as a free-slip floor
    symmetry: bool = False            # simulate the y >= centre half only; mirror on playback
    u_lb: float = 0.05                # lattice speed (Mach ~ u_lb / 0.577); lower = more accurate, more steps
    les: bool = True
    cs: float = 0.1                   # Smagorinsky constant
    flow_throughs: float = 4.0        # duration in domain flow-through times
    n_frames: int = 120
    playback_cells: int = 3_000_000   # frames are subsampled to about this many cells
    sponge: float = 0.5               # sponge-layer thickness, multiples of object length (0 = off)
    tau_min: float = 0.502            # viscosity floor on the coarsest grid: keeps the free stream noise-free
    iso: bool = True                  # extract the Q-criterion isosurface every frame (on every level)
    iso_level: float = 2.0            # Q level in units of (U / L)^2 (large structures)
    iso_level_fine: float = 8.0       # second, higher level (finer filaments)
    precision: str = "fp16c"          # population storage: fp16c (custom 16-bit, 39 B/cell), fp16 (IEEE half) or fp32 (77 B/cell)
    refine: bool = True               # nested refinement blocks
    levels: int = 4                   # grid levels: 1 uniform, 2 body block, 3 + near-wake block, 4 + far-wake block
    refine_up: float = 0.15           # finest (body) block padding, multiples of object length
    refine_down: float = 0.6
    refine_side: float = 0.15
    refine_top: float = 0.2
    near_up: float = 0.4              # near-wake block (2x)
    near_down: float = 2.0
    near_side: float = 0.5
    near_top: float = 0.5
    wake_up: float = 0.8              # far-wake block (4x)
    wake_down: float = 3.0
    wake_side: float = 0.9
    wake_top: float = 0.9
    store_vorticity: bool = True      # keep coarse-grid |vorticity| (uint8) for volume rendering
    name: str = "run"

    def viscosity_density(self):
        nu, rho = FLUIDS.get(self.fluid, (None, None))
        if nu is None:
            return float(self.nu), float(self.rho)
        return nu, rho


@dataclass
class LevelInfo:
    block: list          # parent index range [x0, y0, z0, x1, y1, z1] of this level's interior
    rims_low: list       # rim on the low x / y / z face?
    shape: list          # nx, ny, nz of this level's grid (incl. rims)
    origin: list         # physical origin of this grid (cell i centre at origin + (i + 0.5) dx)
    dx: float


@dataclass
class CaseInfo:
    nx: int; ny: int; nz: int
    dx: float; dt: float; tau: float; re: float; re_eff: float
    steps: int; frame_interval: int; ramp_steps: int
    origin: list
    mesh_offset: list
    frontal_area_lb: float
    stride: int
    memory_gb: float
    t_total: float
    symmetry: bool = False
    L_cells: float = 1.0                            # object length in domain-grid cells
    pad_side_m: float = 0.0                         # lateral / top padding actually used (after the blockage rule)
    pad_top_m: float = 0.0
    blockage_bbox: float = 0.0                      # bbox frontal area / tunnel cross-section (full-model equivalent)
    levels: list = field(default_factory=list)     # LevelInfo for levels 1..n-1 (level 0 is the domain)

    @property
    def cells(self):
        return self.nx * self.ny * self.nz

    @property
    def cells_levels(self):
        return [int(np.prod(l.shape)) for l in self.levels]

    @property
    def cells_total(self):
        return self.cells + sum(self.cells_levels)

    @property
    def refine(self):
        return len(self.levels) > 0

    @property
    def dx_fine(self):
        return self.levels[-1].dx if self.levels else self.dx

    @property
    def n_levels(self):
        return len(self.levels) + 1


def _nest(parent_shape, parent_dx, parent_origin, lo, hi, touch_y0, touch_z0, parent_rims, margin=0):
    """Place a child block covering the physical box [lo, hi] inside a parent grid.
    `margin` (parent cells) keeps level 1 out of the domain's sponge zones."""
    pnx, pny, pnz = parent_shape
    po = np.asarray(parent_origin, dtype=float)
    b0 = np.floor((np.asarray(lo) - po) / parent_dx).astype(int)
    b1 = np.ceil((np.asarray(hi) - po) / parent_dx).astype(int)
    # stay inside the parent's interior (its rims + one cell margin); never touch inlet / outlet / top
    lo_lim = np.array([3 if parent_rims[0] else 2, 3 if parent_rims[1] else 0, 3 if parent_rims[2] else 0]) + margin
    hi_lim = np.array([pnx, pny, pnz]) - 3 - margin
    b0 = np.maximum(b0, lo_lim); b1 = np.minimum(b1, hi_lim)
    rims_low = [True, True, True]
    if touch_y0 and not parent_rims[1]:      # symmetry plane: the child sits on it too
        b0[1] = 0; rims_low[1] = False
    if touch_z0 and not parent_rims[2]:      # floor
        b0[2] = 0; rims_low[2] = False
    b1 = np.maximum(b1, b0 + 2)
    dx = parent_dx / 2
    oi = [b0[k] - (1 if rims_low[k] else 0) for k in range(3)]
    shape = [int(2 * (b1[k] - b0[k] + (1 if rims_low[k] else 0) + 1)) for k in range(3)]
    origin = [float(po[k] + oi[k] * parent_dx) for k in range(3)]
    return LevelInfo(block=[int(v) for v in (*b0, *b1)], rims_low=rims_low, shape=shape, origin=origin, dx=dx)


def lateral_pads(sm: SimMesh, p: CaseParams):
    """Side and top padding in metres, plus the resulting bbox blockage.

    The lateral walls are free-slip, i.e. wind-tunnel walls, so a compact bluff body in a 1.5 L padded box (4 L
    across) sees ~6 % blockage and +20-35 % drag (agent test 3, 2026-10-26). Padding is therefore at least
    pad_side / pad_top x L and is widened, the same distance on every lateral face, until the bounding-box frontal
    area is <= max_blockage of the tunnel cross-section. The extra width lands only on the coarsest (domain) grid."""
    L = float(sm.extent.max())
    ex, ey, ez = [float(v) for v in sm.extent]
    ps0, pt0 = p.pad_side * L, p.pad_top * L

    def blockage(d):
        ps, pt = max(ps0, d), max(pt0, d)
        zbot = p.ground_gap if p.ground else pt
        return (ey * ez) / ((ey + 2 * ps) * (zbot + ez + pt))

    d = 0.0
    if p.max_blockage and p.max_blockage > 0 and blockage(0.0) > p.max_blockage:
        lo, hi = 0.0, L
        while blockage(hi) > p.max_blockage and hi < 1e3 * L:
            hi *= 2
        for _ in range(60):
            mid = 0.5 * (lo + hi)
            lo, hi = (mid, hi) if blockage(mid) > p.max_blockage else (lo, mid)
        d = hi
    return max(ps0, d), max(pt0, d), blockage(d)


def plan_case(sm: SimMesh, p: CaseParams) -> CaseInfo:
    """Everything derivable without voxelizing (for the UI's live estimate)."""
    L = float(sm.extent.max())
    ex, ey, ez = [float(v) for v in sm.extent]
    n_lv = max(1, int(p.levels)) if p.refine else 1
    dx_fine = L / p.resolution
    dx = dx_fine * 2 ** (n_lv - 1)              # coarsest (domain) grid
    nu, rho = p.viscosity_density()
    dt = p.u_lb * dx / p.speed
    nu_lb = nu * dt / dx ** 2
    tau = 3 * nu_lb + 0.5
    re = p.speed * L / nu
    tau = max(tau, p.tau_min)
    re_eff = p.u_lb * (L / dx) / ((tau - 0.5) / 3) * 2 ** (n_lv - 1)   # Re the finest grid can carry

    half = p.symmetry
    pad_s, pad_t, blk = lateral_pads(sm, p)
    lx = p.pad_up * L + ex + p.pad_down * L
    ly = (pad_s + ey / 2) if half else (pad_s * 2 + ey)
    zbot = p.ground_gap if p.ground else pad_t
    lz = zbot + ez + pad_t
    nx, ny, nz = (int(math.ceil(v / dx)) + 2 for v in (lx, ly, lz))
    # symmetry: the mesh is centred on y = 0 so its y >= 0 half lies in the domain
    mesh_offset = [p.pad_up * L + dx, (0.0 if half else pad_s + dx), zbot + dx]
    origin = [0.0, 0.0, 0.0]

    steps = int(p.flow_throughs * nx / p.u_lb)
    n_frames = max(1, p.n_frames)
    frame_interval = max(1, steps // n_frames)
    steps = frame_interval * n_frames
    ramp_steps = int(np.clip((L / dx) / p.u_lb * 0.5, 200, max(200, steps // 4)))
    N = nx * ny * nz
    stride = max(1, int(math.ceil((N / max(1, p.playback_cells)) ** (1 / 3))))
    info = CaseInfo(nx, ny, nz, dx, dt, tau, re, re_eff, steps, frame_interval, ramp_steps, origin, mesh_offset,
                    frontal_area_lb=0.0, stride=stride, memory_gb=0.0, t_total=steps * dt, symmetry=half, L_cells=L / dx,
                    pad_side_m=pad_s, pad_top_m=pad_t, blockage_bbox=blk)

    if n_lv > 1:
        body_lo = np.array(mesh_offset); body_hi = body_lo + np.array([ex, ey, ez])
        if half:
            body_lo[1] = 0.0; body_hi[1] = ey / 2
        pads = []
        if n_lv >= 4:
            pads.append((p.wake_up, p.wake_down, p.wake_side, p.wake_top))
        if n_lv >= 3:
            pads.append((p.near_up, p.near_down, p.near_side, p.near_top))
        pads.append((p.refine_up, p.refine_down, p.refine_side, p.refine_top))
        parent_shape, parent_dx, parent_origin = (nx, ny, nz), dx, origin
        parent_rims = (True, not half, not p.ground)    # False = that low face is a physical plane
        levels = []
        for pu, pd, ps, pt in pads:
            lo = body_lo - np.array([pu, ps, pt]) * L
            hi = body_hi + np.array([pd, ps, pt]) * L
            margin = int(round(p.sponge * L / dx)) + 1 if not levels else 0
            lv = _nest(parent_shape, parent_dx, parent_origin, lo, hi, touch_y0=half, touch_z0=p.ground,
                       parent_rims=parent_rims, margin=margin)
            levels.append(lv)
            parent_shape, parent_dx, parent_origin = tuple(lv.shape), lv.dx, lv.origin
            parent_rims = tuple(lv.rims_low)
        info.levels = levels
    from .lbm_gpu import BYTES_PER_CELL
    # populations + flags (+ padding ring / boundary lists), plus the float32 velocity / Q / vorticity
    # temporaries that output frames allocate for the largest grid
    largest = max([info.cells] + info.cells_levels)
    info.memory_gb = (info.cells_total * BYTES_PER_CELL.get(p.precision, 39) * 1.08 + largest * 24) / 1e9
    return info


def _shift_mesh(sm: SimMesh, info: CaseInfo) -> SimMesh:
    off = np.asarray(info.mesh_offset, dtype=float).copy()
    if info.symmetry:
        off[1] = -float(sm.extent[1]) / 2          # centre plane on y = 0; the y < 0 half falls outside the grid
    shifted = SimMesh(sm.vertices + off, sm.faces, sm.extent, sm.watertight, sm.source)
    shifted.matrix = sm.matrix
    return shifted


def build_flags(sm: SimMesh, p: CaseParams, info: CaseInfo):
    """Voxelize the (offset) mesh and assemble the boundary flag field of the domain (nz, ny, nx)."""
    shape = (info.nx, info.ny, info.nz)
    shifted = _shift_mesh(sm, info)
    solid = voxelize(shifted, np.asarray(info.origin), info.dx, shape)
    flags = np.full((info.nz, info.ny, info.nx), FLUID, np.uint8)
    flags[:, 0, :] = FARFIELD
    flags[:, -1, :] = FARFIELD
    flags[-1, :, :] = FARFIELD
    flags[0, :, :] = FARFIELD
    flags[:, :, 0] = INLET
    flags[:, :, -1] = OUTLET
    if p.ground and not p.moving_ground:
        # fixed floor: no-slip wall that is not part of the body (excluded from force accounting).
        # A belt at free-stream speed carries no shear, so it is the free-slip floor (default z = 0 treatment).
        flags[0, :, :] = GROUND
    flags[solid] = SOLID
    info.frontal_area_lb = float(np.any(solid, axis=2).sum())
    return flags, solid, shifted


def build_level_flags(shifted: SimMesh, p: CaseParams, info: CaseInfo):
    """Flag fields of the nested levels (index 0 = level 1): ghost rims, floor rows, body at that level's dx."""
    from .lbm_multi import Level
    out = []
    for i, lv in enumerate(info.levels):
        nx, ny, nz = lv.shape
        solid = voxelize(shifted, np.asarray(lv.origin), lv.dx, (nx, ny, nz))
        ground_rows = 2 ** (i + 1) if (p.ground and not p.moving_ground and not lv.rims_low[2]) else 0
        flags = Level.flags_template((nx, ny, nz), lv.rims_low, ground_rows)
        flags[solid & (flags == FLUID)] = SOLID
        out.append((flags, solid))
    if out:   # reference area on the finest grid
        info.frontal_area_lb = float(np.any(out[-1][1] & (out[-1][0] == SOLID), axis=2).sum())
    return out


def splice_level(parent: np.ndarray, child: np.ndarray, lv: LevelInfo, reduce: str = "mean"):
    """Write a child level's interior (2x2x2-reduced) into its parent array, in place."""
    x0, y0, z0, x1, y1, z1 = lv.block
    rx = 2 if lv.rims_low[0] else 0; ry = 2 if lv.rims_low[1] else 0; rz = 2 if lv.rims_low[2] else 0
    sub = child[rz: rz + 2 * (z1 - z0), ry: ry + 2 * (y1 - y0), rx: rx + 2 * (x1 - x0)]
    blk = sub.reshape(z1 - z0, 2, y1 - y0, 2, x1 - x0, 2)
    if reduce == "any":
        parent[z0:z1, y0:y1, x0:x1] = blk.any(axis=(1, 3, 5))
    else:
        parent[z0:z1, y0:y1, x0:x1] = blk.mean(axis=(1, 3, 5)).astype(parent.dtype)


def splice_chain(arrays, info: CaseInfo, reduce: str = "mean"):
    """arrays[0] = domain array, arrays[i] = level i array. Folds the finest into its parent up to the domain."""
    for i in range(len(arrays) - 1, 0, -1):
        splice_level(arrays[i - 1], arrays[i], info.levels[i - 1], reduce)
    return arrays[0]


class RunWriter:
    def __init__(self, folder: str, info: CaseInfo, p: CaseParams, sm: SimMesh, solids):
        self.folder = folder
        os.makedirs(folder, exist_ok=True)
        self.info = info
        self.p = p
        self.L = float(sm.extent.max())
        s = info.stride
        np.savez(os.path.join(folder, "mesh.npz"), vertices=sm.vertices, faces=sm.faces)
        solid = splice_chain([a.copy() for a in solids], info, reduce="any") if len(solids) > 1 else solids[0]
        np.savez_compressed(os.path.join(folder, "solid.npz"), solid=solid[::s, ::s, ::s], solid_full=solid)
        self.forces = open(os.path.join(folder, "forces.csv"), "w")
        self.forces.write("step,t,Fx,Fy,Fz,Cd,Cl,Cs\n")
        self.frame_times = []
        self._write_meta()

    def _write_meta(self):
        meta = {"params": asdict(self.p), "info": asdict(self.info), "frame_times": self.frame_times,
                "vort_scale": self.vort_scale, "iso_level_phys": self.iso_level_phys,
                "iso_level_fine_phys": self.iso_level_fine_phys, "L": self.L}
        with open(os.path.join(self.folder, "meta.json"), "w") as fh:
            json.dump(meta, fh, indent=1)

    def write_force(self, step, t, F, Cd, Cl, Cs):
        self.forces.write(f"{step},{t:.6g},{F[0]:.6g},{F[1]:.6g},{F[2]:.6g},{Cd:.5g},{Cl:.5g},{Cs:.5g}\n")
        self.forces.flush()

    def write_frame(self, idx, t, ux, uy, uz, p, full=False, Q=None, vort=None, level_Q=None, level_vel=None):
        """ux.. p: domain-resolution fields (finer levels already spliced in). level_Q / level_vel: per-level
        Q fields and velocities (index 0 = level 1) for the isosurface."""
        s = 1 if full else self.info.stride
        name = "frame_full.npz" if full else f"frame_{idx:04d}.npz"
        np.savez(os.path.join(self.folder, name),
                 ux=ux[::s, ::s, ::s].astype(np.float16), uy=uy[::s, ::s, ::s].astype(np.float16),
                 uz=uz[::s, ::s, ::s].astype(np.float16), p=p[::s, ::s, ::s].astype(np.float32), t=t)
        if full:
            return
        if Q is not None and self.p.iso:
            self.write_iso(idx, (ux, uy, uz), Q, self.iso_level_phys, f"iso_{idx:04d}.npz", level_Q, level_vel)
            if self.p.iso_level_fine > 0:
                self.write_iso(idx, (ux, uy, uz), Q, self.iso_level_fine_phys, f"isof_{idx:04d}.npz", level_Q, level_vel)
        if vort is not None and self.p.store_vorticity:
            np.save(os.path.join(self.folder, f"vort_{idx:04d}.npy"),
                    np.clip(vort * (255.0 / self.vort_scale), 0, 255).astype(np.uint8))
        self.frame_times.append(t)
        self._write_meta()

    @property
    def vort_scale(self):
        return 15.0 * self.p.speed / self.L

    @property
    def iso_level_phys(self):
        return self.p.iso_level * (self.p.speed / self.L) ** 2

    @property
    def iso_level_fine_phys(self):
        return self.p.iso_level_fine * (self.p.speed / self.L) ** 2

    @staticmethod
    def _contour(Q, level, origin, dx, vel):
        import pyvista as pv
        nz, ny, nx = Q.shape
        g = pv.ImageData(dimensions=(nx, ny, nz), spacing=(dx, dx, dx),
                         origin=(origin[0] + 0.5 * dx, origin[1] + 0.5 * dx, origin[2] + 0.5 * dx))
        g.point_data["Q"] = Q.ravel()
        iso = g.contour([level], scalars="Q", method="flying_edges", compute_normals=True, compute_scalars=False)
        if iso.n_points == 0:
            return None
        pts = np.asarray(iso.points, dtype=np.float32)
        ijk = np.clip(np.rint((pts - np.asarray(origin, dtype=np.float32)) / dx - 0.5).astype(np.int64), 0, [nx - 1, ny - 1, nz - 1])
        zi, yi, xi = ijk[:, 2], ijk[:, 1], ijk[:, 0]
        ux, uy, uz = vel
        iso.point_data["speed"] = np.sqrt(ux[zi, yi, xi] ** 2 + uy[zi, yi, xi] ** 2 + uz[zi, yi, xi] ** 2).astype(np.float32)
        return iso

    def write_iso(self, idx, vel, Q, level, name, level_Q=None, level_vel=None):
        """Q isosurface: each level contours its own interior (masked out of its parent), then merged."""
        parts = []
        Q = Q.copy()
        if level_Q:
            b = self.info.levels[0].block
            Q[b[2]:b[5], b[1]:b[4], b[0]:b[3]] = 0.0
        iso = self._contour(Q, level, self.info.origin, self.info.dx, vel)
        if iso is not None:
            parts.append(iso)
        if level_Q:
            for i, (Qi, vi) in enumerate(zip(level_Q, level_vel)):
                lv = self.info.levels[i]
                Qi = Qi.copy()
                if i + 1 < len(self.info.levels):   # mask the next finer block's interior
                    nb = self.info.levels[i + 1].block
                    Qi[nb[2]:nb[5], nb[1]:nb[4], nb[0]:nb[3]] = 0.0
                iso = self._contour(Qi, level, lv.origin, lv.dx, vi)
                if iso is not None:
                    parts.append(iso)
        if not parts:
            np.savez(os.path.join(self.folder, name), pts=np.zeros((0, 3), np.float32),
                     tris=np.zeros((0, 3), np.int32), normals=np.zeros((0, 3), np.int8), speed=np.zeros(0, np.float16))
            return
        iso = parts[0] if len(parts) == 1 else parts[0].merge(parts[1:], merge_points=False)
        pts = np.asarray(iso.points, dtype=np.float32)
        speed = np.asarray(iso.point_data["speed"]).astype(np.float16)
        normals = np.clip(np.asarray(iso.point_data["Normals"]) * 127, -127, 127).astype(np.int8)
        tris = np.asarray(iso.faces).reshape(-1, 4)[:, 1:].astype(np.int32)
        np.savez(os.path.join(self.folder, name), pts=pts, tris=tris, normals=normals, speed=speed)

    def close(self):
        self.forces.close()
        self._write_meta()


def make_solver(flags, tau, u_in, cs, ramp_steps, prefer_gpu=True, sponge_w=0, sponge_bottom=True, moving_ground=False,
                level_flags=None, levels=None, precision="fp16c"):
    kw = dict(sponge_w=sponge_w, tau_sponge=1.5, sponge_bottom=sponge_bottom, moving_ground=moving_ground)
    gpu_kw = dict(kw, precision=precision)
    if level_flags and not prefer_gpu:
        raise RuntimeError("Grid refinement needs the CUDA solver (untick refinement to use the NumPy solver).")
    if prefer_gpu:
        from .lbm_gpu import LBMSolverGPU, cuda_available
        if cuda_available():
            try:
                if level_flags:
                    from .lbm_multi import MultiLevelSolver, Level
                    lvls = [Level(l.block, l.rims_low) for l in levels]
                    return MultiLevelSolver([flags] + list(level_flags), lvls, tau, u_in, cs, ramp_steps, **gpu_kw)
                return LBMSolverGPU(flags, tau, u_in, cs, ramp_steps, **gpu_kw)
            except Exception as e:
                cells = flags.size + sum(f.size for f in (level_flags or []))
                from .lbm_gpu import BYTES_PER_CELL
                gb = cells * BYTES_PER_CELL.get(precision, 39) / 1e9
                raise RuntimeError(f"GPU solver could not start ({e.__class__.__name__}: {e}). The grids need about "
                                   f"{gb:.1f} GB; lower the quality / resolution or padding.") from e
        print("No CUDA device: using the NumPy solver (slow).")
    from .lbm_cpu import LBMSolverCPU
    return LBMSolverCPU(flags, tau, u_in, cs, ramp_steps, **kw)


def run_case(sm: SimMesh, p: CaseParams, out_root: str, progress=None, frame_cb=None, should_stop=None,
             prefer_gpu=True, log=print, display: dict | None = None) -> str:
    """Run a case end to end. Returns the run folder."""
    info = plan_case(sm, p)
    log(f"Domain {info.nx} x {info.ny} x {info.nz} = {info.cells/1e6:.1f} M cells, dx = {info.dx*1000:.2f} mm, "
        f"dt = {info.dt*1e6:.1f} us, tau = {info.tau:.4f}, Re = {info.re:.3g} (grid-resolved Re {info.re_eff:.3g} + LES)"
        f"{'  [half model, mirrored]' if info.symmetry else ''}")
    log(f"Lateral padding {info.pad_side_m / max(1e-12, float(sm.extent.max())):.2f} L each side, "
        f"{info.pad_top_m / max(1e-12, float(sm.extent.max())):.2f} L above; bbox blockage {info.blockage_bbox * 100:.2f} %")
    log("Voxelizing geometry...")
    flags, solid, shifted = build_flags(sm, p, info)
    level_data = build_level_flags(shifted, p, info) if info.refine else []
    for i, lv in enumerate(info.levels):
        log(f"Level {i+1}: {lv.shape[0]} x {lv.shape[1]} x {lv.shape[2]} = {np.prod(lv.shape)/1e6:.1f} M cells at dx = {lv.dx*1000:.2f} mm")
    solid_ref = level_data[-1][1] if level_data else solid
    log(f"Solid cells (finest): {int(solid_ref.sum())}, frontal area {info.frontal_area_lb:.0f} cells^2 "
        f"({info.frontal_area_lb * info.dx_fine**2 * (2 if info.symmetry else 1):.4f} m^2)")

    folder = os.path.join(out_root, p.name or "run")
    base, k = folder, 1
    while os.path.exists(folder):
        folder = f"{base}_{k}"; k += 1

    u_in = np.array([p.u_lb, 0.0, 0.0], np.float32)
    sponge_w = int(round(p.sponge * info.L_cells))
    solver = make_solver(flags, info.tau, u_in, p.cs if p.les else 0.0, info.ramp_steps, prefer_gpu,
                         sponge_w=sponge_w, sponge_bottom=not p.ground, moving_ground=False,
                         level_flags=[f for f, _ in level_data], levels=info.levels, precision=p.precision)
    log(f"Solver backend: {solver.backend}, {solver.memory_bytes/1e9:.2f} GB, {info.steps} steps, "
        f"{p.n_frames} frames, simulated time {info.t_total:.4f} s")
    writer = RunWriter(folder, info, p, shifted, [solid] + [s for _, s in level_data])
    if display and display.get("glb_path") and os.path.isfile(display["glb_path"]):
        import shutil
        shutil.copyfile(display["glb_path"], os.path.join(folder, "body.glb"))
        M = np.asarray(sm.matrix if sm.matrix is not None else np.eye(4), dtype=float).copy()
        off = np.asarray(info.mesh_offset, dtype=float).copy()
        if info.symmetry:
            off[1] = -float(sm.extent[1]) / 2
        M[:3, 3] += off
        with open(os.path.join(folder, "display.json"), "w") as fh:
            json.dump({"matrix": M.tolist(), "hidden_parts": list(display.get("hidden_parts", [])),
                       "part_bounds": display.get("part_bounds", {}), "part_faces": display.get("part_faces", {})}, fh)
    nu, rho_phys = p.viscosity_density()
    cscale = info.dx / info.dt
    sym = 2.0 if info.symmetry else 1.0
    q_lb = 0.5 * p.u_lb ** 2 * max(1.0, info.frontal_area_lb) * sym
    n_lv = info.n_levels
    dx_force, dt_force = info.dx_fine, info.dt / 2 ** (n_lv - 1)
    f_scale = rho_phys * dx_force ** 4 / dt_force ** 2
    multi = info.refine

    def macro_all():
        """[(ux, uy, uz, p)] for the domain and every level, in physical units."""
        outs = []
        srcs = [solver.macro()] + ([solver.macro_level(i) for i in range(1, n_lv)] if multi else [])
        for ux, uy, uz, rho in srcs:
            outs.append([ux * cscale, uy * cscale, uz * cscale, (rho - 1.0) / 3.0 * rho_phys * cscale ** 2])
        return outs

    batch = max(1, min(25, info.frame_interval))
    step = 0
    t0 = time.perf_counter()
    last = t0
    stopped = False
    try:
        for fi in range(p.n_frames):
            done = 0
            while done < info.frame_interval:
                n = min(batch, info.frame_interval - done)
                F = solver.run(n)
                if info.symmetry:
                    F = np.array([2 * F[0], 0.0, 2 * F[2]])
                step += n; done += n
                t = step * info.dt
                Cd, Cl, Cs = F[0] / q_lb, F[2] / q_lb, F[1] / q_lb
                writer.write_force(step, t, F * f_scale, Cd, Cl, Cs)
                now = time.perf_counter()
                if progress and (now - last > 0.25 or done >= info.frame_interval):
                    mlups = step * info.cells / (now - t0) / 1e6
                    progress(step, info.steps, mlups, Cd, Cl, Cs, t)
                    last = now
                if should_stop and should_stop():
                    stopped = True
                    break
            if not solver.is_finite():
                log("Simulation diverged (NaN). Try lower speed, lower u_lb, higher resolution or enable LES.")
                stopped = True
            fields = macro_all()
            level_vel = [f[:3] for f in fields[1:]]
            for k in range(4):   # fold the levels into the domain-resolution playback fields
                splice_chain([f[k] for f in fields], info)
            ux, uy, uz, pp = fields[0]
            Q = vort = None; level_Q = None
            if p.iso or p.store_vorticity:
                Q, vort = solver.derive()
                Q *= 1.0 / info.dt ** 2; vort *= 1.0 / info.dt
                if multi:
                    level_Q = []; vorts = [vort]
                    for i in range(1, n_lv):
                        Qi, vi = solver.derive_level(i)
                        dti = info.dt / 2 ** i
                        level_Q.append(Qi * (1.0 / dti ** 2)); vorts.append(vi * (1.0 / dti))
                    splice_chain(vorts, info)
            writer.write_frame(fi, step * info.dt, ux, uy, uz, pp, Q=Q, vort=vort, level_Q=level_Q, level_vel=level_vel)
            if frame_cb:
                frame_cb(fi, folder)
            if stopped:
                break
        fields = macro_all()
        for k in range(4):
            splice_chain([f[k] for f in fields], info)
        ux, uy, uz, pp = fields[0]
        writer.write_frame(0, step * info.dt, ux, uy, uz, pp, full=True)
    finally:
        writer.close()
        solver.close()
    el = time.perf_counter() - t0
    log(f"Done: {step} steps in {el:.1f}s ({step*info.cells/el/1e6:.0f} MLUPS on the domain grid). Output: {folder}")
    return folder

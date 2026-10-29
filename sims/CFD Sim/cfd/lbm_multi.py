"""Nested grid refinement: a chain of blocks, each at half the cell size and half the time step of its
parent, all sharing the same solver kernels.

Coupling per parent step (cell-centred, 2:1 in space and time):
  * a child's ghost rim (one parent cell = two child cells thick) is trilinearly interpolated from the
    parent's post-collision populations, time-interpolated for the second sub-step, with the
    non-equilibrium part rescaled for the finer lattice;
  * the child takes two sub-steps (recursively driving its own children);
  * parent cells covered by the child's interior are overwritten with the average of their eight
    children, non-equilibrium rescaled back.
The solvers update their populations in place (AA pattern), so the parent's pre-step populations that the
time interpolation needs are snapshotted first, only for the parent cells the rim stencils touch.
Faces of a block that lie on the domain's symmetry plane / floor carry no rim: the child grid's own
edge treatment (free-slip reflection or wall rows) applies there, matching the parent's plane.
"""
from __future__ import annotations

import numpy as np

from .lattice import NQ, FLUID, GROUND, GHOST
from .lbm_gpu import LBMSolverGPU, compile_module

_COUPLE_SRC = r"""
__device__ __forceinline__ void rescale(float* f, float s) {
    float rho = 0.f, jx = 0.f, jy = 0.f, jz = 0.f;
    for (int q = 0; q < NQ; ++q) { rho += f[q]; jx += CX[q]*f[q]; jy += CY[q]*f[q]; jz += CZ[q]*f[q]; }
    float inv = 1.0f / rho, ux = jx*inv, uy = jy*inv, uz = jz*inv, u2 = ux*ux + uy*uy + uz*uz;
    for (int q = 0; q < NQ; ++q) { float e = feq(q, rho, ux, uy, uz, u2); f[q] = e + s * (f[q] - e); }
}

// parent populations at the rim-stencil cells, before the parent's step
extern "C" __global__
void snapshot(const st_t* __restrict__ fc, const long long* __restrict__ cells, long long K, float* __restrict__ snap,
              long long Np, int PX, long long PXY, int layout)
{
    long long t = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (t >= K) return;
    long long m = cells[t];
    for (int q = 0; q < NQ; ++q) snap[(long long)q * K + t] = ld(fc, q, m, layout, GEOA);
}

// parent -> child ghost rim
extern "C" __global__
void c2f(const float* __restrict__ snap, const long long* __restrict__ cells, long long K,
         const st_t* __restrict__ fc, const unsigned char* __restrict__ flags_c, long long Npc, int PXc, long long PXYc, int layout_c,
         float alpha, const long long* __restrict__ ghosts, const int* __restrict__ corner, long long G,
         st_t* __restrict__ ff, int nfx, int nfy, long long Np, int PX, long long PXY, int layout_f,
         int ox, int oy, int oz, float s_neq)
{
    long long t = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (t >= G) return;
    long long g = ghosts[t];
    int x = (int)(g % PX) - 1, y = (int)((g / PX) % (nfy + 2)) - 1, z = (int)(g / PXY) - 1;
    float gx = ox + 0.5f * (x + 0.5f) - 0.5f;
    float gy = oy + 0.5f * (y + 0.5f) - 0.5f;
    float gz = oz + 0.5f * (z + 0.5f) - 0.5f;
    int i0 = (int)floorf(gx), j0 = (int)floorf(gy), k0 = (int)floorf(gz);
    float wx = gx - i0, wy = gy - j0, wz = gz - k0;
    float f[NQ];
    for (int q = 0; q < NQ; ++q) f[q] = 0.f;
    float wsum = 0.f;
    for (int k = 0; k < 8; ++k) {
        int dx = k & 1, dy = (k >> 1) & 1, dz = k >> 2;
        int c = corner[t * 8 + k];
        long long m = cells[c];
        unsigned char fl = flags_c[m];
        if (fl == F_SOLID || fl == F_GROUND || fl == F_GHOST) continue;
        float w = (dx ? wx : 1.f - wx) * (dy ? wy : 1.f - wy) * (dz ? wz : 1.f - wz);
        wsum += w;
        for (int q = 0; q < NQ; ++q) {
            float vnew = (alpha > 0.f) ? ld(fc, q, m, layout_c, Npc, PXc, PXYc) : 0.f;
            f[q] += w * ((1.f - alpha) * snap[(long long)q * K + c] + alpha * vnew);
        }
    }
    if (wsum <= 0.f) return;
    float inv = 1.f / wsum;
    for (int q = 0; q < NQ; ++q) f[q] *= inv;
    rescale(f, s_neq);
    for (int q = 0; q < NQ; ++q) st(ff, q, g, layout_f, f[q], GEOA);
}

// child -> parent restriction over the block interior
extern "C" __global__
void f2c(const st_t* __restrict__ ff, const unsigned char* __restrict__ flags_f, int nfx, int nfy, int nfz,
         long long Npf, int PXf, long long PXYf, int layout_f,
         st_t* __restrict__ fc, const unsigned char* __restrict__ flags_c, long long Np, int PX, long long PXY, int layout_c,
         int ox, int oy, int oz, int bx0, int by0, int bz0, int bx1, int by1, int bz1, float s_neq)
{
    int bnx = bx1 - bx0, bny = by1 - by0, bnz = bz1 - bz0;
    long long Nb = (long long)bnx * bny * bnz;
    long long t = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (t >= Nb) return;
    int cx = bx0 + (int)(t % bnx), cy = by0 + (int)((t / bnx) % bny), cz = bz0 + (int)(t / ((long long)bnx * bny));
    long long m = pidx(cx, cy, cz, PX, PXY);
    unsigned char flc = flags_c[m];
    if (flc == F_SOLID || flc == F_GROUND || flc == F_GHOST) return;
    int fx0 = 2 * (cx - ox), fy0 = 2 * (cy - oy), fz0 = 2 * (cz - oz);
    float f[NQ];
    for (int q = 0; q < NQ; ++q) f[q] = 0.f;
    int cnt = 0;
    for (int dz = 0; dz < 2; ++dz) for (int dy = 0; dy < 2; ++dy) for (int dx = 0; dx < 2; ++dx) {
        int fx = fx0 + dx, fy = fy0 + dy, fz = fz0 + dz;
        if (fx < 0 || fy < 0 || fz < 0 || fx >= nfx || fy >= nfy || fz >= nfz) continue;
        long long k = pidx(fx, fy, fz, PXf, PXYf);
        if (flags_f[k] != F_FLUID) continue;
        for (int q = 0; q < NQ; ++q) f[q] += ld(ff, q, k, layout_f, Npf, PXf, PXYf);
        cnt++;
    }
    if (cnt == 0) return;
    float inv = 1.f / cnt;
    for (int q = 0; q < NQ; ++q) f[q] *= inv;
    rescale(f, s_neq);
    for (int q = 0; q < NQ; ++q) st(fc, q, m, layout_c, f[q], GEOA);
}
"""


class Level:
    """One refinement level: block range in the parent's index space plus which low faces have a rim."""

    def __init__(self, block, rims_low):
        self.block = tuple(int(v) for v in block)          # bx0, by0, bz0, bx1, by1, bz1 (parent indices, interior)
        self.rims_low = tuple(bool(v) for v in rims_low)   # x, y, z: rim on the low face?
        b = self.block
        self.origin_idx = (b[0] - (1 if self.rims_low[0] else 0), b[1] - (1 if self.rims_low[1] else 0),
                           b[2] - (1 if self.rims_low[2] else 0))   # parent index of the child's grid origin
        self.shape = tuple(2 * (b[3 + k] - b[k] + (1 if self.rims_low[k] else 0) + 1) for k in range(3))  # nx, ny, nz

    @staticmethod
    def flags_template(shape, rims_low, ground_rows=0):
        nx, ny, nz = shape
        flags = np.full((nz, ny, nx), FLUID, np.uint8)
        flags[:, :, -2:] = GHOST; flags[:, -2:, :] = GHOST; flags[-2:, :, :] = GHOST
        if rims_low[0]:
            flags[:, :, :2] = GHOST
        if rims_low[1]:
            flags[:, :2, :] = GHOST
        if rims_low[2]:
            flags[:2, :, :] = GHOST
        elif ground_rows:
            flags[:ground_rows, :, :] = GROUND
        return flags


class _Rim:
    """Ghost cells of one child and the parent cells their trilinear stencils read."""

    def __init__(self, cp, flags_child, parent, origin_idx):
        z, y, x = np.nonzero(flags_child == GHOST)
        nfz, nfy, nfx = flags_child.shape
        ox, oy, oz = origin_idx
        pcz, pcy, pcx = parent.nz, parent.ny, parent.nx
        i0 = np.clip(np.floor(ox + 0.5 * (x + 0.5) - 0.5).astype(np.int64), 0, pcx - 2)
        j0 = np.clip(np.floor(oy + 0.5 * (y + 0.5) - 0.5).astype(np.int64), 0, pcy - 2)
        k0 = np.clip(np.floor(oz + 0.5 * (z + 0.5) - 0.5).astype(np.int64), 0, pcz - 2)
        corners = np.empty((x.size, 8), np.int64)
        for k in range(8):
            dx, dy, dz = k & 1, (k >> 1) & 1, k >> 2
            corners[:, k] = (k0 + dz + 1) * parent.PXY + (j0 + dy + 1) * parent.PX + (i0 + dx + 1)
        cells, inv = np.unique(corners.ravel(), return_inverse=True)
        PX = nfx + 2; PXY = PX * (nfy + 2)
        ghosts = (z.astype(np.int64) + 1) * PXY + (y.astype(np.int64) + 1) * PX + (x.astype(np.int64) + 1)
        self.G = int(ghosts.size); self.K = int(cells.size)
        self.ghosts = cp.asarray(ghosts)
        self.corner = cp.asarray(inv.reshape(-1, 8).astype(np.int32))
        self.cells = cp.asarray(cells.astype(np.int64))
        self.snap = cp.zeros(NQ * self.K, dtype=cp.float32)

    @property
    def nbytes(self):
        return self.G * (8 + 32) + self.K * (8 + NQ * 4)


class MultiLevelSolver:
    """Level 0 = the domain; level i is a block nested in level i-1 at half the cell size."""
    backend = "cuda-multilevel"

    def __init__(self, flags_list, levels, tau0: float, u_in, cs_les: float, ramp_steps: int,
                 sponge_w: int = 0, tau_sponge: float = 1.5, sponge_bottom: bool = True, moving_ground: bool = False,
                 precision: str = "fp16c"):
        import cupy as cp
        self.cp = cp
        assert len(flags_list) == len(levels) + 1
        self.levels = list(levels)
        self.solvers = []
        self.taus = []
        tau = float(tau0)
        for i, flags in enumerate(flags_list):
            if i == 0:
                s = LBMSolverGPU(flags, tau, u_in, cs_les, ramp_steps, sponge_w, tau_sponge, sponge_bottom,
                                 precision=precision)
            else:
                exp = self.levels[i - 1].shape
                assert flags.shape[::-1] == exp, f"level {i} flags {flags.shape[::-1]} != {exp}"
                s = LBMSolverGPU(flags, tau, u_in, cs_les, (2 ** i) * ramp_steps, 0, tau_sponge, False,
                                 precision=precision)
            self.solvers.append(s); self.taus.append(tau)
            tau = 2.0 * (tau - 0.5) + 0.5      # next (finer) level
        self.rims = [None] + [_Rim(cp, flags_list[i], self.solvers[i - 1], self.levels[i - 1].origin_idx)
                              for i in range(1, len(flags_list))]
        self.mod = compile_module(_COUPLE_SRC, precision)
        self.k_snap = self.mod.get_function("snapshot")
        self.k_c2f = self.mod.get_function("c2f")
        self.k_f2c = self.mod.get_function("f2c")
        self.step_count = 0
        self.ramp_steps = ramp_steps
        self.u_in = self.solvers[0].u_in
        # fill every rim once so first steps see sane neighbours
        for i in range(1, len(self.solvers)):
            self._snapshot(i)
            self._c2f(i, 0.0)
        cp.cuda.Device().synchronize()

    # ---- coupling launches
    def _snapshot(self, i):
        r, c = self.rims[i], self.solvers[i - 1]
        self.k_snap(((r.K + 255) // 256,), (256,), (c.f, r.cells, np.int64(r.K), r.snap, *c.geo, np.int32(c.layout)))

    def _s_c2f(self, i):
        tc, tf = self.taus[i - 1], self.taus[i]
        return (tf - 1.0) / (2.0 * (tc - 1.0))

    def _c2f(self, i, alpha):
        r, c, f = self.rims[i], self.solvers[i - 1], self.solvers[i]
        o = self.levels[i - 1].origin_idx
        self.k_c2f(((r.G + 255) // 256,), (256,),
                   (r.snap, r.cells, np.int64(r.K), c.f, c.flags, *c.geo, np.int32(c.layout),
                    np.float32(alpha), r.ghosts, r.corner, np.int64(r.G),
                    f.f, np.int32(f.nx), np.int32(f.ny), *f.geo, np.int32(f.layout),
                    np.int32(o[0]), np.int32(o[1]), np.int32(o[2]), np.float32(self._s_c2f(i))))

    def _f2c(self, i):
        c, f = self.solvers[i - 1], self.solvers[i]
        b = self.levels[i - 1].block
        o = self.levels[i - 1].origin_idx
        nb = (b[3] - b[0]) * (b[4] - b[1]) * (b[5] - b[2])
        self.k_f2c(((nb + 255) // 256,), (256,),
                   (f.f, f.flags, *f.dims, *f.geo, np.int32(f.layout),
                    c.f, c.flags, *c.geo, np.int32(c.layout),
                    np.int32(o[0]), np.int32(o[1]), np.int32(o[2]),
                    *(np.int32(v) for v in b), np.float32(1.0 / self._s_c2f(i))))

    def _step_level(self, i, v):
        """One step of level i, then two sub-steps of its child (recursively) and the restriction back."""
        s = self.solvers[i]
        child = i + 1 < len(self.solvers)
        if child:
            self._snapshot(i + 1)
        s.step_once(v)
        if child:
            for sub in (0.0, 0.5):
                self._c2f(i + 1, sub)
                self._step_level(i + 1, v)
            self._f2c(i + 1)

    # ---- public interface (mirrors LBMSolverGPU)
    @property
    def memory_bytes(self):
        return sum(s.memory_bytes for s in self.solvers) + sum(r.nbytes for r in self.rims[1:])

    @property
    def coarse(self): return self.solvers[0]
    @property
    def fine(self): return self.solvers[-1]
    @property
    def nx(self): return self.coarse.nx
    @property
    def ny(self): return self.coarse.ny
    @property
    def nz(self): return self.coarse.nz
    @property
    def N(self): return self.coarse.N
    @property
    def n_levels(self): return len(self.solvers)

    def run(self, nsteps: int) -> np.ndarray:
        """Advance nsteps coarse steps. Returns mean body force in the *finest* level's lattice units."""
        cp = self.cp
        c, f = self.coarse, self.fine
        f.force.fill(0.0)
        for _ in range(nsteps):
            self._step_level(0, c._ramped_u(self.step_count))
            self.step_count += 1
        cp.cuda.Device().synchronize()
        return cp.asnumpy(f.force) / max(1, nsteps * 2 ** (len(self.solvers) - 1))

    def macro(self):
        return self.coarse.macro()

    def macro_level(self, i):
        return self.solvers[i].macro()

    def derive(self):
        return self.coarse.derive()

    def derive_level(self, i):
        return self.solvers[i].derive()

    def is_finite(self) -> bool:
        return all(s.is_finite() for s in self.solvers)

    def close(self):
        for s in self.solvers:
            s.close()
        self.rims = []

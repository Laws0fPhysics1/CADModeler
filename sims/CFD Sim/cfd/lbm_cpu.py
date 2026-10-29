"""NumPy fallback D3Q19 solver. Same physics as the CUDA kernel, ~100x slower."""
from __future__ import annotations

import numpy as np

from .lattice import C, W, OPP, NQ, SOLID, GROUND, INLET, REFL_Y, REFL_Z


def _shift(a: np.ndarray, c) -> np.ndarray:
    """out[n] = a[n - c] without wrap-around (out-of-range sources read as False/0)."""
    out = np.zeros_like(a)
    src = [slice(max(0, -c[k]), a.shape[2 - k] - max(0, c[k])) for k in (2, 1, 0)]
    dst = [slice(max(0, c[k]), a.shape[2 - k] - max(0, -c[k])) for k in (2, 1, 0)]
    out[tuple(dst)] = a[tuple(src)]
    return out


class LBMSolverCPU:
    backend = "numpy"

    def __init__(self, flags: np.ndarray, tau0: float, u_in: np.ndarray, cs_les: float = 0.1,
                 ramp_steps: int = 1000, sponge_w: int = 0, tau_sponge: float = 1.5, sponge_bottom: bool = True,
                 moving_ground: bool = False):
        self.moving_ground = bool(moving_ground)
        self.flags = np.asarray(flags, dtype=np.uint8)
        self.nz, self.ny, self.nx = self.flags.shape
        self.N = int(self.flags.size)
        self.tau0 = float(tau0)
        self.cs2 = float(cs_les) ** 2
        self.u_in = np.asarray(u_in, dtype=np.float32)
        self.ramp_steps = max(1, int(ramp_steps))
        self.step_count = 0

        self.body = self.flags == SOLID
        self.solid = self.body | (self.flags == GROUND)
        self.fixed = self.flags == INLET
        # source-is-wall masks for each direction (pull scheme); body-only masks for force accounting
        self.src_solid = [_shift(self.solid, c) & ~self.solid for c in C]
        self.src_body = [_shift(self.body, c) & ~self.solid for c in C]
        self.src_ground = [_shift(self.flags == GROUND, c) & ~self.solid for c in C]

        shp = (self.nz, self.ny, self.nx)
        zz, yy, xx = np.mgrid[:self.nz, :self.ny, :self.nx]
        self.oob_y = [(yy == 0) if c[1] > 0 else (yy == self.ny - 1) if c[1] < 0 else np.zeros(shp, bool) for c in C]
        self.oob_z = [(zz == 0) if c[2] > 0 else (zz == self.nz - 1) if c[2] < 0 else np.zeros(shp, bool) for c in C]
        d = np.minimum.reduce([xx, self.nx - 1 - xx, yy, self.ny - 1 - yy, self.nz - 1 - zz] + ([zz] if sponge_bottom else []))
        self.sponge = np.zeros(shp, np.float32)
        self.sponge_sig = np.zeros(shp, np.float32)
        if sponge_w > 0:
            self.sponge = (np.clip(1 - d / sponge_w, 0, 1) ** 2).astype(np.float32)
            self.sponge_sig = np.where(xx >= sponge_w, self.sponge, 0).astype(np.float32)
        self.tau_sponge = float(tau_sponge)
        self.ux = np.zeros(shp, np.float32); self.uy = np.zeros(shp, np.float32); self.uz = np.zeros(shp, np.float32)
        self.rho = np.ones(shp, np.float32)
        v = self._ramped_u(0)
        self.ux[~self.solid] = v[0]; self.uy[~self.solid] = v[1]; self.uz[~self.solid] = v[2]
        self.f = self._feq(self.rho, self.ux, self.uy, self.uz)

    @property
    def memory_bytes(self) -> int:
        return self.N * (NQ * 3 * 4 + NQ + 16)

    def _ramped_u(self, step):
        r = min(1.0, step / self.ramp_steps)
        r = 0.5 - 0.5 * np.cos(np.pi * r)
        return self.u_in * r

    @staticmethod
    def _feq(rho, ux, uy, uz):
        u2 = ux * ux + uy * uy + uz * uz
        fe = np.empty((NQ,) + rho.shape, np.float32)
        for q in range(NQ):
            cu = C[q, 0] * ux + C[q, 1] * uy + C[q, 2] * uz
            fe[q] = W[q] * rho * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * u2)
        return fe

    def run(self, nsteps: int) -> np.ndarray:
        ftot = np.zeros(3)
        for _ in range(nsteps):
            v = self._ramped_u(self.step_count)
            f = self.f
            fin = np.empty_like(f)
            pu2 = self.ux ** 2 + self.uy ** 2 + self.uz ** 2
            for q in range(NQ):
                c = C[q]
                fin[q] = np.roll(f[q], (c[2], c[1], c[0]), axis=(0, 1, 2))
                if c[0] < 0:  # pressure outlet (rho = 1), non-equilibrium extrapolation
                    nux, nuy, nuz, rn = self.ux[:, :, -2], self.uy[:, :, -2], self.uz[:, :, -2], self.rho[:, :, -2]
                    cu = c[0] * nux + c[1] * nuy + c[2] * nuz
                    fin[q][:, :, -1] = f[q][:, :, -2] + W[q] * (1 - rn) * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (nux**2 + nuy**2 + nuz**2))
                # free-slip lateral boundaries: specular reflection (corners reflect both components)
                oy = self.oob_y[q]; oz = self.oob_z[q]
                if c[1] != 0: fin[q][oy & ~oz] = f[REFL_Y[q]][oy & ~oz]
                if c[2] != 0: fin[q][oz & ~oy] = f[REFL_Z[q]][oz & ~oy]
                if c[1] != 0 and c[2] != 0: fin[q][oy & oz] = f[REFL_Z[REFL_Y[q]]][oy & oz]
                m = self.src_solid[q]
                if m.any():
                    fin[q][m] = f[OPP[q]][m]
                    ftot += -2.0 * c * f[OPP[q]][self.src_body[q]].sum()
                    if self.moving_ground:
                        mg = self.src_ground[q]
                        fin[q][mg] += 6 * W[q] * self.rho[mg] * (c[0] * v[0] + c[1] * v[1] + c[2] * v[2])
            rho = fin.sum(axis=0)
            ux = np.tensordot(C[:, 0].astype(np.float32), fin, 1) / rho
            uy = np.tensordot(C[:, 1].astype(np.float32), fin, 1) / rho
            uz = np.tensordot(C[:, 2].astype(np.float32), fin, 1) / rho
            fe = self._feq(rho, ux, uy, uz)
            d = fin - fe
            P = np.zeros((6,) + rho.shape, np.float32)
            for q in range(NQ):
                cx, cy, cz = C[q]
                P[0] += cx * cx * d[q]; P[1] += cy * cy * d[q]; P[2] += cz * cz * d[q]
                P[3] += cx * cy * d[q]; P[4] += cx * cz * d[q]; P[5] += cy * cz * d[q]
            tau = np.full(rho.shape, self.tau0, np.float32)
            if self.cs2 > 0:
                Q = np.sqrt(P[0] ** 2 + P[1] ** 2 + P[2] ** 2 + 2 * (P[3] ** 2 + P[4] ** 2 + P[5] ** 2))
                tau = 0.5 * (self.tau0 + np.sqrt(self.tau0 ** 2 + 18 * np.sqrt(2) * self.cs2 * Q / rho))
            tau = tau + self.sponge * (self.tau_sponge - tau)
            fnew = np.empty_like(fin)
            for q in range(NQ):  # regularized collision
                cx, cy, cz = C[q]
                r = 4.5 * W[q] * ((cx * cx - 1 / 3) * P[0] + (cy * cy - 1 / 3) * P[1] + (cz * cz - 1 / 3) * P[2]
                                  + 2 * (cx * cy * P[3] + cx * cz * P[4] + cy * cz * P[5]))
                cu = cx * ux + cy * uy + cz * uz
                fnew[q] = fe[q] + (1 - 1 / tau) * r + W[q] * (0.05 * self.sponge_sig * (1 - rho)) * (1 + 3 * cu + 4.5 * cu * cu - 1.5 * (ux**2 + uy**2 + uz**2))
            # velocity inlet: non-equilibrium extrapolation from x = 1 (previous step)
            rn = self.rho[:, :, 1]; nux, nuy, nuz = self.ux[:, :, 1], self.uy[:, :, 1], self.uz[:, :, 1]
            fe_in = self._feq(rn, np.full_like(rn, v[0]), np.full_like(rn, v[1]), np.full_like(rn, v[2]))
            fe_nb = self._feq(rn, nux, nuy, nuz)
            for q in range(NQ):
                fnew[q][:, :, 0] = fe_in[q] + (f[q][:, :, 1] - fe_nb[q])
            rho[:, :, 0] = rn; ux[:, :, 0] = v[0]; uy[:, :, 0] = v[1]; uz[:, :, 0] = v[2]
            s = self.solid
            ux[s] = 0; uy[s] = 0; uz[s] = 0; rho[s] = 1
            self.f = fnew
            self.ux, self.uy, self.uz, self.rho = ux.astype(np.float32), uy.astype(np.float32), uz.astype(np.float32), rho.astype(np.float32)
            self.step_count += 1
        return ftot / max(1, nsteps)

    def macro(self):
        return self.ux, self.uy, self.uz, self.rho

    def derive(self):
        from .viz import derive
        f = derive(self.ux, self.uy, self.uz, self.rho, 1.0)
        m = self.sponge > 0
        Q, vort = f["Q"], f["vort"]; Q[m] = 0; vort[m] = 0
        return Q, vort

    def is_finite(self) -> bool:
        return bool(np.isfinite(self.rho).all())

    def close(self):
        pass

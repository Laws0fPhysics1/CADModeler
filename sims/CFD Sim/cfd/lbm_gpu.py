"""CUDA D3Q19 lattice-Boltzmann solver (CuPy RawModule).

Memory layout: one population buffer updated in place (AA pattern), stored as 16-bit floats shifted by
the lattice weights (f - w_q, scaled), so a cell costs 19 x 2 bytes + 1 flag byte instead of the
2 x 19 x 4 + 16 bytes of a two-buffer float32 solver. Arithmetic stays in float32.

AA pattern: the buffer alternates between two layouts. With `layout` = 0 the post-collision population q
of cell m lives in m's own slot OPP[q]; with `layout` = 1 it has already been streamed to slot q of the
neighbour m + c_q. Each step reads one layout and writes the other, and every thread reads and writes the
same 19 memory words, so no second buffer is needed.

The grid carries a one-cell padding ring. Fluid cells never apply boundary conditions themselves: before
each step a fill kernel walks the (short) list of non-fluid cells next to fluid and writes the population
each of them sends into the fluid, in the current layout. That covers half-way bounce-back on the body
(with momentum-exchange force), the floor, the velocity inlet and pressure outlet (non-equilibrium
extrapolation) and the free-slip lateral walls (padding cells). Grid-refinement ghost rims are written by
the coupling kernels in lbm_multi.py the same way.

Collision: regularized BGK with a Smagorinsky sub-grid model and a viscous / acoustic sponge.
"""
from __future__ import annotations

import warnings

import numpy as np

warnings.filterwarnings("ignore", message="CUDA path could not be detected")

from .lattice import C, W, OPP, NQ, REFL_Y, REFL_Z

OUT = 7                     # padding-ring flag (outside the domain)
FP16_SCALE = 1024.0         # shifted populations are stored as half(scale * (f - w))
BYTES_PER_CELL = {"fp16": NQ * 2 + 1, "fp16c": NQ * 2 + 1, "fp32": NQ * 4 + 1}

HEADER = r"""
#include <cuda_fp16.h>
#define NQ 19
__constant__ int   CX[NQ]  = {@CX@};
__constant__ int   CY[NQ]  = {@CY@};
__constant__ int   CZ[NQ]  = {@CZ@};
__constant__ float WQ[NQ]  = {@W@};
__constant__ int   OPPQ[NQ]= {@OPP@};
__constant__ int   RY[NQ]  = {@RY@};
__constant__ int   RZ[NQ]  = {@RZ@};

#define F_FLUID 0
#define F_SOLID 1
#define F_INLET 2
#define F_OUTLET 3
#define F_FAR 4
#define F_GROUND 5
#define F_GHOST 6
#define F_OUT 7

#if @MODE@ == 1
typedef __half st_t;
#define TOF(v) (__half2float(v) * (1.0f / @SCALE@f))
#define FROMF(v) __float2half_rn((v) * @SCALE@f)
#elif @MODE@ == 2
// custom 16-bit float (sign, 4-bit exponent, 11-bit mantissa; no inf / NaN, saturates at +-2):
// twice the precision of IEEE half over the range shifted populations actually use
typedef unsigned short st_t;
// branchless: rebias the exponent with an exact multiply by 2^-112, then round the float bits to 15 + sign.
// The multiplies need denormals, and CuPy always compiles with -ftz=true, so they are PTX without .ftz.
__device__ __forceinline__ float mul_denorm(float a, float b) {
    float r; asm("mul.rn.f32 %0, %1, %2;" : "=f"(r) : "f"(a), "f"(b)); return r;
}
__device__ __forceinline__ unsigned short c16_from(float x) {
    unsigned int b = __float_as_uint(mul_denorm(x, 1.925929944387236e-34f));
    unsigned int r = ((b & 0x7FFFFFFFu) + 0x800u) >> 12;
    return (unsigned short)(((b >> 16) & 0x8000u) | min(r, 0x7FFFu));
}
__device__ __forceinline__ float c16_to(unsigned short h) {
    unsigned int u = h;
    return mul_denorm(__uint_as_float(((u & 0x8000u) << 16) | ((u & 0x7FFFu) << 12)), 5.192296858534828e+33f);
}
#define TOF(v) c16_to(v)
#define FROMF(v) c16_from(v)
#else
typedef float st_t;
#define TOF(v) (v)
#define FROMF(v) (v)
#endif

// padded-grid geometry passed to every kernel
#define GEO long long Np, int PX, long long PXY
#define GEOA Np, PX, PXY

__device__ __forceinline__ bool is_fluid(unsigned char fl) { return fl == F_FLUID || fl == F_OUTLET || fl == F_FAR; }

__device__ __forceinline__ long long offq(int q, int PX, long long PXY) {
    return (long long)CX[q] + (long long)CY[q] * PX + (long long)CZ[q] * PXY;
}
// address of the post-collision population q of padded cell m in the given layout
__device__ __forceinline__ long long addr(int q, long long m, int layout, GEO) {
    return layout ? ((long long)q * Np + m + offq(q, PX, PXY)) : ((long long)OPPQ[q] * Np + m);
}
__device__ __forceinline__ float ld(const st_t* f, int q, long long m, int layout, GEO) {
    return WQ[q] + TOF(f[addr(q, m, layout, GEOA)]);
}
__device__ __forceinline__ void st(st_t* f, int q, long long m, int layout, float v, GEO) {
    f[addr(q, m, layout, GEOA)] = FROMF(v - WQ[q]);
}
__device__ __forceinline__ float feq(int q, float rho, float ux, float uy, float uz, float u2) {
    float cu = CX[q]*ux + CY[q]*uy + CZ[q]*uz;
    return WQ[q] * rho * (1.0f + 3.0f*cu + 4.5f*cu*cu - 1.5f*u2);
}
__device__ __forceinline__ void moments(const st_t* f, long long m, int layout, GEO,
                                        float& rho, float& ux, float& uy, float& uz) {
    float r = 0.f, jx = 0.f, jy = 0.f, jz = 0.f;
    for (int q = 0; q < NQ; ++q) { float v = ld(f, q, m, layout, GEOA); r += v; jx += CX[q]*v; jy += CY[q]*v; jz += CZ[q]*v; }
    float inv = 1.0f / r;
    rho = r; ux = jx * inv; uy = jy * inv; uz = jz * inv;
}
__device__ __forceinline__ long long pidx(int x, int y, int z, int PX, long long PXY) {
    return (long long)(z + 1) * PXY + (long long)(y + 1) * PX + (x + 1);
}
"""

_KERNEL_SRC = r"""
extern "C" __global__
void init_eq(st_t* __restrict__ f, const unsigned char* __restrict__ flags, float vx, float vy, float vz,
             int nx, int ny, int nz, GEO)
{
    long long N = (long long)nx * ny * nz;
    long long n = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (n >= N) return;
    int x = (int)(n % nx), y = (int)((n / nx) % ny), z = (int)(n / ((long long)nx * ny));
    long long pn = pidx(x, y, z, PX, PXY);
    unsigned char fl = flags[pn];
    bool wall = (fl == F_SOLID || fl == F_GROUND);
    float ax = wall ? 0.f : vx, ay = wall ? 0.f : vy, az = wall ? 0.f : vz;
    float u2 = ax*ax + ay*ay + az*az;
    for (int q = 0; q < NQ; ++q) st(f, q, pn, 0, feq(q, 1.0f, ax, ay, az, u2), GEOA);
}

// boundary conditions: populations sent into the fluid by the listed non-fluid cells, in the current layout
extern "C" __global__
void fill(st_t* __restrict__ f, const unsigned char* __restrict__ flags, const long long* __restrict__ list, long long nlist,
          int nx, int ny, int nz, GEO, int layout, float vx, float vy, float vz, double* __restrict__ force)
{
    long long t = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (t >= nlist) return;
    long long b = list[t];
    unsigned char fl = flags[b];
    int px = (int)(b % PX), py = (int)((b / PX) % (ny + 2)), pz = (int)(b / PXY);
    int bx = px - 1, by = py - 1, bz = pz - 1;

    if (fl == F_INLET) {
        // velocity inlet (non-equilibrium extrapolation): density and f_neq from the downstream neighbour
        long long nb = b + 1;
        float rn, nux, nuy, nuz;
        moments(f, nb, layout, GEOA, rn, nux, nuy, nuz);
        float u2 = vx*vx + vy*vy + vz*vz, nu2 = nux*nux + nuy*nuy + nuz*nuz;
        for (int q = 0; q < NQ; ++q)
            st(f, q, b, layout, feq(q, rn, vx, vy, vz, u2) + (ld(f, q, nb, layout, GEOA) - feq(q, rn, nux, nuy, nuz, nu2)), GEOA);
        return;
    }
    float lfx = 0.f, lfy = 0.f, lfz = 0.f;
    bool touched = false;
    for (int p = 1; p < NQ; ++p) {
        int qx = px + CX[p], qy = py + CY[p], qz = pz + CZ[p];
        if (qx < 0 || qy < 0 || qz < 0 || qx >= PX || qy >= ny + 2 || qz >= nz + 2) continue;
        long long n = b + offq(p, PX, PXY);
        if (!is_fluid(flags[n])) continue;
        float g;
        if (fl == F_SOLID || fl == F_GROUND) {
            g = ld(f, OPPQ[p], n, layout, GEOA);                    // half-way bounce-back
            if (fl == F_SOLID) { lfx -= 2.f * CX[p] * g; lfy -= 2.f * CY[p] * g; lfz -= 2.f * CZ[p] * g; touched = true; }
        } else if (bx >= nx) {
            // pressure outlet (rho = 1) with non-equilibrium extrapolation from the upstream neighbour
            long long nb = n - 1;
            float rn, nux, nuy, nuz;
            moments(f, nb, layout, GEOA, rn, nux, nuy, nuz);
            float cu = CX[p]*nux + CY[p]*nuy + CZ[p]*nuz;
            g = ld(f, p, nb, layout, GEOA) + WQ[p] * (1.0f - rn) * (1.0f + 3.0f*cu + 4.5f*cu*cu - 1.5f*(nux*nux + nuy*nuy + nuz*nuz));
        } else if (by < 0 || by >= ny || bz < 0 || bz >= nz) {
            // free-slip lateral boundary: specular reflection of the fluid cell's own population
            int r = p;
            if (by < 0 || by >= ny) r = RY[r];
            if (bz < 0 || bz >= nz) r = RZ[r];
            g = ld(f, r, n, layout, GEOA);
        } else {
            float rn, ux, uy, uz;
            moments(f, n, layout, GEOA, rn, ux, uy, uz);
            g = feq(p, 1.0f, ux, uy, uz, ux*ux + uy*uy + uz*uz);
        }
        st(f, p, b, layout, g, GEOA);
    }
    if (touched) { atomicAdd(&force[0], (double)lfx); atomicAdd(&force[1], (double)lfy); atomicAdd(&force[2], (double)lfz); }
}

extern "C" __global__
void stream_collide(st_t* __restrict__ f, const unsigned char* __restrict__ flags,
                    int nx, int ny, int nz, GEO, int layout, float tau0, float cs2,
                    int sponge_w, float tau_sponge, int sponge_bottom)
{
    long long N = (long long)nx * ny * nz;
    long long n = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (n >= N) return;
    int x = (int)(n % nx);
    int y = (int)((n / nx) % ny);
    int z = (int)(n / ((long long)nx * ny));
    long long pn = pidx(x, y, z, PX, PXY);
    if (!is_fluid(flags[pn])) return;

    float fin[NQ];
    if (layout) {
        #pragma unroll
        for (int q = 0; q < NQ; ++q) fin[q] = WQ[q] + TOF(f[(long long)q * Np + pn]);
    } else {
        #pragma unroll
        for (int q = 0; q < NQ; ++q) fin[q] = WQ[q] + TOF(f[(long long)OPPQ[q] * Np + pn - offq(q, PX, PXY)]);
    }

    float rho = 0.f, jx = 0.f, jy = 0.f, jz = 0.f;
    #pragma unroll
    for (int q = 0; q < NQ; ++q) { rho += fin[q]; jx += CX[q]*fin[q]; jy += CY[q]*fin[q]; jz += CZ[q]*fin[q]; }
    float inv = 1.0f / rho;
    float cux = jx * inv, cuy = jy * inv, cuz = jz * inv;
    float u2 = cux*cux + cuy*cuy + cuz*cuz;

    // non-equilibrium momentum flux tensor (used by both LES and regularization)
    float pxx=0.f, pyy=0.f, pzz=0.f, pxy=0.f, pxz=0.f, pyz=0.f;
    #pragma unroll
    for (int q = 0; q < NQ; ++q) {
        float d = fin[q] - feq(q, rho, cux, cuy, cuz, u2);
        pxx += CX[q]*CX[q]*d; pyy += CY[q]*CY[q]*d; pzz += CZ[q]*CZ[q]*d;
        pxy += CX[q]*CY[q]*d; pxz += CX[q]*CZ[q]*d; pyz += CY[q]*CZ[q]*d;
    }
    float tau = tau0;
    if (cs2 > 0.f) {
        // Smagorinsky sub-grid viscosity
        float Q = sqrtf(pxx*pxx + pyy*pyy + pzz*pzz + 2.f*(pxy*pxy + pxz*pxz + pyz*pyz));
        tau = 0.5f * (tau0 + sqrtf(tau0*tau0 + 18.0f * 1.41421356f * cs2 * Q * inv));
    }
    float sig = 0.f;
    if (sponge_w > 0) {
        // sponge towards the domain boundaries: raised viscosity kills wake eddies, density relaxation
        // towards rho = 1 absorbs acoustic waves (no inlet/outlet organ-pipe resonance)
        int d = min(x, nx - 1 - x);
        d = min(d, y); d = min(d, ny - 1 - y); d = min(d, nz - 1 - z);
        if (sponge_bottom) d = min(d, z);
        if (d < sponge_w) {
            float sfac = 1.0f - (float)d / (float)sponge_w;
            sfac *= sfac;
            tau = tau + sfac * (tau_sponge - tau);
            // density relaxation only away from the inlet: at the inlet it acts as a mass sink and
            // lowers the free stream; the outlet / lateral zones alone absorb the acoustic modes
            if (x >= sponge_w) sig = 0.05f * sfac;
        }
    }
    float omega = 1.0f / tau;
    float drho = sig * (1.0f - rho);   // density relaxation in the sponge
    // regularized collision: f_post = feq + (1 - omega) * R(f_neq), R = 2nd-order Hermite projection
    #pragma unroll
    for (int q = 0; q < NQ; ++q) {
        float cx = CX[q], cy = CY[q], cz = CZ[q];
        float r = 4.5f * WQ[q] * ((cx*cx - 0.333333333f)*pxx + (cy*cy - 0.333333333f)*pyy + (cz*cz - 0.333333333f)*pzz
                                   + 2.f*(cx*cy*pxy + cx*cz*pxz + cy*cz*pyz));
        float cu = cx*cux + cy*cuy + cz*cuz;
        float v = feq(q, rho, cux, cuy, cuz, u2) + (1.0f - omega) * r + WQ[q] * drho * (1.0f + 3.0f*cu + 4.5f*cu*cu - 1.5f*u2);
        if (layout) f[(long long)OPPQ[q] * Np + pn] = FROMF(v - WQ[q]);                     // -> layout 0
        else        f[(long long)q * Np + pn + offq(q, PX, PXY)] = FROMF(v - WQ[q]);       // -> layout 1
    }
}

// density and velocity of every (unpadded) cell
extern "C" __global__
void macro(const st_t* __restrict__ f, const unsigned char* __restrict__ flags, int nx, int ny, int nz, GEO, int layout,
           float* __restrict__ ux, float* __restrict__ uy, float* __restrict__ uz, float* __restrict__ rho)
{
    long long N = (long long)nx * ny * nz;
    long long n = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (n >= N) return;
    int x = (int)(n % nx), y = (int)((n / nx) % ny), z = (int)(n / ((long long)nx * ny));
    long long pn = pidx(x, y, z, PX, PXY);
    unsigned char fl = flags[pn];
    if (fl == F_SOLID || fl == F_GROUND) { ux[n] = 0.f; uy[n] = 0.f; uz[n] = 0.f; rho[n] = 1.f; return; }
    float r, a, b, c;
    moments(f, pn, layout, GEOA, r, a, b, c);
    ux[n] = a; uy[n] = b; uz[n] = c; rho[n] = r;
}

// marks padded cells whose boundary condition the fill kernel must provide
extern "C" __global__
void mark_boundary(const unsigned char* __restrict__ flags, unsigned char* __restrict__ mark, int ny, int nz, GEO)
{
    long long b = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (b >= Np) return;
    unsigned char fl = flags[b];
    mark[b] = 0;
    if (fl == F_INLET) { mark[b] = 1; return; }
    if (!(fl == F_SOLID || fl == F_GROUND || fl == F_OUT)) return;
    int px = (int)(b % PX), py = (int)((b / PX) % (ny + 2)), pz = (int)(b / PXY);
    for (int p = 1; p < NQ; ++p) {
        int qx = px + CX[p], qy = py + CY[p], qz = pz + CZ[p];
        if (qx < 0 || qy < 0 || qz < 0 || qx >= PX || qy >= ny + 2 || qz >= nz + 2) continue;
        if (is_fluid(flags[b + offq(p, PX, PXY)])) { mark[b] = 1; return; }
    }
}

extern "C" __global__
void derive(const float* __restrict__ ux, const float* __restrict__ uy, const float* __restrict__ uz,
            const unsigned char* __restrict__ flags, float* __restrict__ Qout, float* __restrict__ vort,
            int nx, int ny, int nz, GEO, int sponge_w, int sponge_bottom)
{
    long long N = (long long)nx * ny * nz;
    long long n = (long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (n >= N) return;
    int x = (int)(n % nx), y = (int)((n / nx) % ny), z = (int)(n / ((long long)nx * ny));
    unsigned char fl = flags[pidx(x, y, z, PX, PXY)];
    if (fl == F_SOLID || fl == F_GROUND || fl == F_GHOST) { Qout[n] = 0.f; vort[n] = 0.f; return; }
    {   // the sponge zones are damped, non-physical fluid: leave them out of the vortex outputs
        int d = min(x, nx - 1 - x); d = min(d, y); d = min(d, ny - 1 - y); d = min(d, nz - 1 - z);
        if (sponge_bottom) d = min(d, z);
        if (d < sponge_w) { Qout[n] = 0.f; vort[n] = 0.f; return; }
    }
    int xm = max(x - 1, 0), xp = min(x + 1, nx - 1);
    int ym = max(y - 1, 0), yp = min(y + 1, ny - 1);
    int zm = max(z - 1, 0), zp = min(z + 1, nz - 1);
    long long sxy = (long long)nx * ny;
    float ix = 1.0f / (float)(xp - xm), iy = 1.0f / (float)(yp - ym), iz = 1.0f / (float)(zp - zm);
    long long nxm = n - x + xm, nxp = n - x + xp;
    long long nym = n - (long long)y * nx + (long long)ym * nx, nyp = n - (long long)y * nx + (long long)yp * nx;
    long long nzm = n - (long long)z * sxy + (long long)zm * sxy, nzp = n - (long long)z * sxy + (long long)zp * sxy;
    float dudx = (ux[nxp] - ux[nxm]) * ix, dudy = (ux[nyp] - ux[nym]) * iy, dudz = (ux[nzp] - ux[nzm]) * iz;
    float dvdx = (uy[nxp] - uy[nxm]) * ix, dvdy = (uy[nyp] - uy[nym]) * iy, dvdz = (uy[nzp] - uy[nzm]) * iz;
    float dwdx = (uz[nxp] - uz[nxm]) * ix, dwdy = (uz[nyp] - uz[nym]) * iy, dwdz = (uz[nzp] - uz[nzm]) * iz;
    float wx = dwdy - dvdz, wy = dudz - dwdx, wz = dvdx - dudy;
    float sxy2 = 0.5f * (dudy + dvdx), sxz2 = 0.5f * (dudz + dwdx), syz2 = 0.5f * (dvdz + dwdy);
    float S2 = dudx*dudx + dvdy*dvdy + dwdz*dwdz + 2.f * (sxy2*sxy2 + sxz2*sxz2 + syz2*syz2);
    float O2 = 0.5f * (wx*wx + wy*wy + wz*wz);
    Qout[n] = 0.5f * (O2 - S2);
    vort[n] = sqrtf(wx*wx + wy*wy + wz*wz);
}
"""


def _fmt(a, f="%d"):
    return ", ".join(f % v for v in a)


def build_source(body: str, precision: str = "fp16c") -> str:
    src = HEADER + body
    for key, val in (("CX", _fmt(C[:, 0])), ("CY", _fmt(C[:, 1])), ("CZ", _fmt(C[:, 2])),
                     ("W", _fmt(W, "%.9ef")), ("OPP", _fmt(OPP)), ("RY", _fmt(REFL_Y)), ("RZ", _fmt(REFL_Z)),
                     ("MODE", {"fp32": "0", "fp16": "1", "fp16c": "2"}[precision]), ("SCALE", repr(FP16_SCALE))):
        src = src.replace("@" + key + "@", val)
    return src


def compile_module(body: str, precision: str = "fp16c"):
    import cupy as cp
    from cupy.cuda import get_cuda_path
    import os
    opts = ["--use_fast_math", "-std=c++17"]
    inc = os.path.join(get_cuda_path() or "", "include")
    if os.path.isdir(inc):
        opts.append("-I" + inc)
    return cp.RawModule(code=build_source(body, precision), options=tuple(opts))


class LBMSolverGPU:
    backend = "cuda"

    def __init__(self, flags: np.ndarray, tau0: float, u_in: np.ndarray, cs_les: float = 0.1,
                 ramp_steps: int = 1000, sponge_w: int = 0, tau_sponge: float = 1.5, sponge_bottom: bool = True,
                 moving_ground: bool = False, precision: str = "fp16c"):
        import cupy as cp
        self.cp = cp
        self.precision = precision
        self.sponge_w = int(sponge_w); self.tau_sponge = float(tau_sponge); self.sponge_bottom = int(bool(sponge_bottom))
        self.nz, self.ny, self.nx = flags.shape
        self.N = int(flags.size)
        self.PX = self.nx + 2
        self.PXY = self.PX * (self.ny + 2)
        self.Np = self.PXY * (self.nz + 2)
        self.tau0 = float(tau0)
        self.cs2 = float(cs_les) ** 2
        self.u_in = np.asarray(u_in, dtype=np.float32)
        self.ramp_steps = max(1, int(ramp_steps))
        self.step_count = 0
        self.layout = 0

        self.mod = compile_module(_KERNEL_SRC, precision)
        self.k_init = self.mod.get_function("init_eq")
        self.k_fill = self.mod.get_function("fill")
        self.k_step = self.mod.get_function("stream_collide")
        self.k_macro = self.mod.get_function("macro")
        self.k_mark = self.mod.get_function("mark_boundary")
        self.k_derive = self.mod.get_function("derive")

        pf = np.pad(np.ascontiguousarray(flags, dtype=np.uint8), 1, constant_values=OUT)
        self.flags = cp.asarray(pf.ravel())
        del pf
        dt = {"fp16": cp.float16, "fp16c": cp.uint16, "fp32": cp.float32}[precision]
        self.f = cp.zeros(NQ * self.Np, dtype=dt)
        self.force = cp.zeros(3, dtype=cp.float64)
        self.block = 256
        self.grid = (self.N + self.block - 1) // self.block

        mark = cp.empty(self.Np, dtype=cp.uint8)
        self.k_mark(((self.Np + 255) // 256,), (256,), (self.flags, mark, np.int32(self.ny), np.int32(self.nz), *self.geo))
        self.bnd = cp.flatnonzero(mark).astype(cp.int64)
        del mark
        self.nbnd = int(self.bnd.size)

        v = self._ramped_u(0)
        self.k_init((self.grid,), (self.block,),
                    (self.f, self.flags, np.float32(v[0]), np.float32(v[1]), np.float32(v[2]), *self.dims, *self.geo))
        cp.cuda.Device().synchronize()

    @property
    def geo(self):
        return (np.int64(self.Np), np.int32(self.PX), np.int64(self.PXY))

    @property
    def dims(self):
        return (np.int32(self.nx), np.int32(self.ny), np.int32(self.nz))

    @property
    def memory_bytes(self) -> int:
        return int(self.f.nbytes + self.Np + self.nbnd * 8)

    def _ramped_u(self, step: int) -> np.ndarray:
        r = min(1.0, step / self.ramp_steps)
        r = 0.5 - 0.5 * np.cos(np.pi * r)  # smooth ramp
        return self.u_in * r

    def apply_bc(self, v):
        """Write the boundary populations for the next step (current layout)."""
        if self.nbnd:
            self.k_fill(((self.nbnd + 255) // 256,), (256,),
                        (self.f, self.flags, self.bnd, np.int64(self.nbnd), *self.dims, *self.geo, np.int32(self.layout),
                         np.float32(v[0]), np.float32(v[1]), np.float32(v[2]), self.force))

    def step_once(self, v):
        """Boundary fill + one in-place stream/collide with inlet velocity v; flips the layout."""
        self.apply_bc(v)
        self.k_step((self.grid,), (self.block,),
                    (self.f, self.flags, *self.dims, *self.geo, np.int32(self.layout),
                     np.float32(self.tau0), np.float32(self.cs2),
                     np.int32(self.sponge_w), np.float32(self.tau_sponge), np.int32(self.sponge_bottom)))
        self.layout ^= 1
        self.step_count += 1

    def run(self, nsteps: int) -> np.ndarray:
        """Advance nsteps. Returns the mean body force (lattice units) over those steps."""
        cp = self.cp
        self.force.fill(0.0)
        for _ in range(nsteps):
            self.step_once(self._ramped_u(self.step_count))
        cp.cuda.Device().synchronize()
        return cp.asnumpy(self.force) / max(1, nsteps)

    def _macro_dev(self):
        cp = self.cp
        ux = cp.empty(self.N, cp.float32); uy = cp.empty(self.N, cp.float32)
        uz = cp.empty(self.N, cp.float32); rho = cp.empty(self.N, cp.float32)
        self.k_macro((self.grid,), (self.block,), (self.f, self.flags, *self.dims, *self.geo, np.int32(self.layout),
                                                   ux, uy, uz, rho))
        return ux, uy, uz, rho

    def macro(self):
        cp = self.cp
        shp = (self.nz, self.ny, self.nx)
        out = tuple(cp.asnumpy(a).reshape(shp) for a in self._macro_dev())
        cp.get_default_memory_pool().free_all_blocks()
        return out

    def derive(self):
        """Q-criterion and vorticity magnitude (lattice units) at full resolution, as host arrays."""
        cp = self.cp
        shp = (self.nz, self.ny, self.nx)
        ux, uy, uz, rho = self._macro_dev()
        del rho
        Q = cp.empty(self.N, dtype=cp.float32); vort = cp.empty(self.N, dtype=cp.float32)
        self.k_derive((self.grid,), (self.block,), (ux, uy, uz, self.flags, Q, vort, *self.dims, *self.geo,
                                                    np.int32(self.sponge_w), np.int32(self.sponge_bottom)))
        del ux, uy, uz
        out = (cp.asnumpy(Q).reshape(shp), cp.asnumpy(vort).reshape(shp))
        del Q, vort
        cp.get_default_memory_pool().free_all_blocks()
        return out

    def is_finite(self) -> bool:
        cp = self.cp
        if self.precision == "fp16c":   # no inf / NaN in the custom format: divergence saturates at 0x7FFF
            return not bool(cp.any((self.f.view(cp.uint16) & 0x7FFF) == 0x7FFF))
        return bool(cp.isfinite(self.f.sum(dtype=cp.float32)))

    def close(self):
        for a in ("f", "flags", "force", "bnd"):
            setattr(self, a, None)
        self.cp.get_default_memory_pool().free_all_blocks()


def cuda_available() -> bool:
    try:
        import cupy as cp
        cp.cuda.runtime.getDeviceCount()
        cp.RawModule(code='extern "C" __global__ void k(float* a){ a[0]=1.f; }').get_function("k")
        return True
    except Exception:
        return False

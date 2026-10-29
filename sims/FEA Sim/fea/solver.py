"""Global assembly and the linear solve K u = f.

* Assembly: element stiffness in chunks (elements.stiffness), scattered into a
  scipy CSR matrix chunk by chunk so memory stays bounded.
* Fixed DOFs are eliminated (K_ff u_f = f_f); reactions come from the full K.
* Solve: SuperLU (scipy splu) for small systems; preconditioned CG for large
  ones, on the GPU with CuPy when available (RTX 3080), else on the CPU.
  The preconditioner is block Jacobi (the inverse 3x3 nodal diagonal blocks).
"""
from __future__ import annotations

import time

import numpy as np
import scipy.sparse as sp
import scipy.sparse.linalg as spla

from . import elements as el
from .caseio import StopRequested

CHUNK = 15000
DIRECT_MAX_DOFS = 45_000    # SuperLU fill-in explodes above this for 3D TET10 meshes (41 k dofs: 1.8 s, 76 k: 220 s)


def element_dofs(tets):
    """(E,10) node ids -> (E,30) dof ids (x,y,z interleaved)."""
    return (3 * tets[:, :, None] + np.arange(3)[None, None, :]).reshape(len(tets), 30)


def assemble(nodes, tets, Dmats, elem_mat, progress=None, should_stop=None):
    """Global stiffness K (CSR, N/mm) and element volumes.

    Dmats: list of (6,6) D matrices, elem_mat: (E,) index into Dmats.
    """
    ndof = 3 * len(nodes)
    E = len(tets)
    K = None
    vols = np.zeros(E)
    mindet = np.inf
    dofs = element_dofs(tets).astype(np.int32)
    Dall = np.stack(Dmats)
    for s in range(0, E, CHUNK):
        e = slice(s, min(E, s + CHUNK))
        X = nodes[tets[e]]
        D = Dall[elem_mat[e]] if len(Dmats) > 1 else Dall[0]
        Ke, v, md = el.stiffness(X, D)
        vols[e] = v
        mindet = min(mindet, md)
        d = dofs[e]
        rows = np.repeat(d, 30, axis=1).ravel()
        cols = np.tile(d, (1, 30)).ravel()
        part = sp.csr_matrix((Ke.ravel(), (rows, cols)), shape=(ndof, ndof))
        K = part if K is None else K + part
        if should_stop:
            should_stop()
        if progress:
            progress(min(1.0, (s + CHUNK) / E), f"element stiffness {min(E, s + CHUNK):,} / {E:,}")
    K.sum_duplicates()
    return K, vols, mindet


def body_loads(nodes, tets, bvec_per_elem):
    """Assemble consistent loads for per-element body force density (E,3) N/mm^3."""
    f = np.zeros(3 * len(nodes))
    for s in range(0, len(tets), CHUNK):
        e = slice(s, min(len(tets), s + CHUNK))
        Fe = el.body_force(nodes[tets[e]], bvec_per_elem[e])
        np.add.at(f, element_dofs(tets[e]).ravel(), Fe.reshape(-1))
    return f


# ----------------------------------------------------------------------------- linear solve
def _block_jacobi(K):
    """Inverse of the 3x3 nodal diagonal blocks of K (n,3,3)."""
    n = K.shape[0] // 3
    blocks = np.zeros((n, 3, 3))
    base = np.arange(n) * 3
    for a in range(3):
        for b in range(3):
            k = b - a
            dg = K.diagonal(k)  # k >= 0: dg[j] = K[j, j+k];  k < 0: dg[j] = K[j-k, j]
            blocks[:, a, b] = dg[base + a] if k >= 0 else dg[base + b]
    # guard: if a block is singular fall back to its diagonal
    det = np.linalg.det(blocks)
    bad = ~np.isfinite(det) | (np.abs(det) < 1e-300)
    if bad.any():
        dg = np.einsum("nii->ni", blocks[bad])
        blocks[bad] = 0
        for k in range(3):
            blocks[bad, k, k] = np.where(dg[:, k] != 0, dg[:, k], 1.0)
    return np.linalg.inv(blocks)


def _gpu_available():
    try:
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            import cupy as cp
            if cp.cuda.runtime.getDeviceCount() < 1:
                return None
            cp.zeros(1).sum().item()  # forces CUDA init / kernel compile
        return cp
    except Exception:
        return None


def pcg_cpu(K, f, tol=1e-8, maxiter=None, should_stop=None, progress=None):
    n = K.shape[0]
    maxiter = maxiter or max(2000, 3 * int(np.sqrt(n)) * 20)
    Minv = _block_jacobi(K)
    nb = n // 3

    def M(r):
        return np.einsum("nij,nj->ni", Minv, r.reshape(nb, 3)).ravel()

    x = np.zeros(n)
    r = f.copy()
    z = M(r)
    p = z.copy()
    rz = r @ z
    bnorm = np.linalg.norm(f) or 1.0
    it = 0
    res = 1.0
    for it in range(1, maxiter + 1):
        Ap = K @ p
        alpha = rz / (p @ Ap)
        x += alpha * p
        r -= alpha * Ap
        res = np.linalg.norm(r) / bnorm
        if res < tol:
            break
        z = M(r)
        rz_new = r @ z
        p = z + (rz_new / rz) * p
        rz = rz_new
        if it % 50 == 0:
            if should_stop:
                should_stop()
            if progress:
                progress(min(0.99, np.log10(max(res, 1e-30)) / np.log10(tol)), f"CG iteration {it}, residual {res:.2e}")
    return x, {"method": "pcg-block-jacobi", "backend": "cpu", "iterations": it, "residual": float(res),
               "converged": bool(res < tol)}


def pcg_gpu(cp, K, f, tol=1e-8, maxiter=None, should_stop=None, progress=None):
    import cupyx.scipy.sparse as csp
    n = K.shape[0]
    maxiter = maxiter or max(2000, 3 * int(np.sqrt(n)) * 20)
    Kg = csp.csr_matrix(K.astype(np.float64))
    nb = n // 3
    Minv = cp.asarray(_block_jacobi(K))
    fg = cp.asarray(f)

    def M(r):
        return cp.einsum("nij,nj->ni", Minv, r.reshape(nb, 3)).ravel()

    x = cp.zeros(n)
    r = fg.copy()
    z = M(r)
    p = z.copy()
    rz = r @ z
    bnorm = float(cp.linalg.norm(fg)) or 1.0
    it = 0
    res = 1.0
    check = 25
    for it in range(1, maxiter + 1):
        Ap = Kg @ p
        alpha = rz / (p @ Ap)
        x += alpha * p
        r -= alpha * Ap
        if it % check == 0 or it == maxiter:
            res = float(cp.linalg.norm(r)) / bnorm
            if res < tol:
                break
            if should_stop:
                should_stop()
            if progress and it % (check * 4) == 0:
                progress(min(0.99, np.log10(max(res, 1e-30)) / np.log10(tol)), f"CG iteration {it}, residual {res:.2e}")
        z = M(r)
        rz_new = r @ z
        p = z + (rz_new / rz) * p
        rz = rz_new
    res = float(cp.linalg.norm(fg - Kg @ x)) / bnorm
    out = cp.asnumpy(x)
    del Kg, Minv, fg, x, r, z, p
    cp.get_default_memory_pool().free_all_blocks()
    return out, {"method": "pcg-block-jacobi", "backend": "gpu", "iterations": it, "residual": res,
                 "converged": bool(res < tol * 10)}


def solve_direct(K, f):
    t = time.time()
    lu = spla.splu(K.tocsc(), permc_spec="MMD_AT_PLUS_A")
    x = lu.solve(f)
    res = float(np.linalg.norm(K @ x - f) / (np.linalg.norm(f) or 1.0))
    return x, {"method": "direct-superlu", "backend": "cpu", "iterations": 1, "residual": res,
               "converged": bool(res < 1e-6), "factor_s": round(time.time() - t, 3)}


def solve(K, f, method="auto", prefer_gpu=True, tol=1e-8, log=print, should_stop=None, progress=None):
    """Solve the reduced SPD system. method: auto | direct | cg | cg-gpu."""
    n = K.shape[0]
    if method in ("auto", None):
        method = "direct" if n <= DIRECT_MAX_DOFS else "cg-gpu" if prefer_gpu else "cg"
    if method == "cg-gpu":
        cp = _gpu_available() if prefer_gpu else None
        if cp is not None:
            try:
                return pcg_gpu(cp, K, f, tol=tol, should_stop=should_stop, progress=progress)
            except StopRequested:
                raise
            except Exception as e:  # out of memory, driver trouble: fall back
                log(f"GPU solve failed ({type(e).__name__}: {e}); falling back to the CPU")
        method = "direct" if n <= DIRECT_MAX_DOFS else "cg"
    if method == "direct":
        try:
            return solve_direct(K, f)
        except MemoryError:
            log("direct solver ran out of memory; using CG")
    return pcg_cpu(K, f, tol=tol, should_stop=should_stop, progress=progress)

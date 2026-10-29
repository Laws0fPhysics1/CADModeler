"""Quadratic tetrahedron (TET10) and 6-node triangle (TRI6) element maths, vectorised.

Units throughout the solver: mm, N, MPa (N/mm^2), tonne/mm^3, mm/s^2.

Local TET10 node order (this module's convention; the mesher reorders gmsh's
nodes into it):
    0..3   corners at natural coords (0,0,0) (1,0,0) (0,1,0) (0,0,1)
    4..9   mid-edge nodes on EDGES = (0,1) (1,2) (2,0) (0,3) (1,3) (2,3)
Barycentrics: L0 = 1 - xi - eta - zeta, L1 = xi, L2 = eta, L3 = zeta.
Corner shape functions Li(2Li - 1), edge (i,j) functions 4 Li Lj.

Voigt order for strain / stress: xx, yy, zz, xy, yz, zx (engineering shear strains).
"""
from __future__ import annotations

import numpy as np

EDGES = ((0, 1), (1, 2), (2, 0), (0, 3), (1, 3), (2, 3))
CORNER_XI = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], float)
NODE_XI = np.vstack([CORNER_XI] + [0.5 * (CORNER_XI[i] + CORNER_XI[j]) for i, j in EDGES])
_DL = np.array([[-1, -1, -1], [1, 0, 0], [0, 1, 0], [0, 0, 1]], float)  # dLi/dxi

# Outward faces of a positively oriented tet (corner triples) and their TRI6 mid-edge slots
FACE_CORNERS = ((0, 2, 1), (0, 1, 3), (1, 2, 3), (0, 3, 2))


def _edge_slot(i, j):
    for k, (a, b) in enumerate(EDGES):
        if (a, b) == (i, j) or (a, b) == (j, i):
            return 4 + k
    raise KeyError((i, j))


# each face as TRI6 local node indices: corners a, b, c then mids ab, bc, ca
FACE_NODES = tuple((a, b, c, _edge_slot(a, b), _edge_slot(b, c), _edge_slot(c, a)) for a, b, c in FACE_CORNERS)


def bary(xi):
    xi = np.asarray(xi, float)
    return np.array([1.0 - xi[0] - xi[1] - xi[2], xi[0], xi[1], xi[2]])


def shape(xi):
    """N (10,) at natural point xi."""
    L = bary(xi)
    N = np.empty(10)
    N[:4] = L * (2 * L - 1)
    for k, (i, j) in enumerate(EDGES):
        N[4 + k] = 4 * L[i] * L[j]
    return N


def dshape(xi):
    """dN/dxi (10, 3) at natural point xi."""
    L = bary(xi)
    d = np.empty((10, 3))
    for i in range(4):
        d[i] = (4 * L[i] - 1) * _DL[i]
    for k, (i, j) in enumerate(EDGES):
        d[4 + k] = 4 * (L[j] * _DL[i] + L[i] * _DL[j])
    return d


# 4-point Gauss rule for tetrahedra (exact to degree 2: the TET10 stiffness of a straight-sided element)
_a, _b = 0.5854101966249685, 0.1381966011250105
GAUSS4 = (np.array([[_b, _b, _b], [_a, _b, _b], [_b, _a, _b], [_b, _b, _a]]), np.full(4, 1.0 / 24.0))
# 11-point Keast rule (degree 4) for curved elements / higher accuracy
_k = [(-0.01315555555555556, (0.25, 0.25, 0.25)),
      (0.007622222222222222, (0.0714285714285714, 0.0714285714285714, 0.0714285714285714)),
      (0.007622222222222222, (0.785714285714286, 0.0714285714285714, 0.0714285714285714)),
      (0.007622222222222222, (0.0714285714285714, 0.785714285714286, 0.0714285714285714)),
      (0.007622222222222222, (0.0714285714285714, 0.0714285714285714, 0.785714285714286)),
      (0.02488888888888889, (0.399403576166799, 0.100596423833201, 0.100596423833201)),
      (0.02488888888888889, (0.100596423833201, 0.399403576166799, 0.100596423833201)),
      (0.02488888888888889, (0.100596423833201, 0.100596423833201, 0.399403576166799)),
      (0.02488888888888889, (0.399403576166799, 0.399403576166799, 0.100596423833201)),
      (0.02488888888888889, (0.399403576166799, 0.100596423833201, 0.399403576166799)),
      (0.02488888888888889, (0.100596423833201, 0.399403576166799, 0.399403576166799))]
KEAST11 = (np.array([p for _, p in _k]), np.array([w for w, _ in _k]))


def elasticity_D(E, nu):
    """Isotropic 6x6 constitutive matrix (Voigt, engineering shear)."""
    lam = E * nu / ((1 + nu) * (1 - 2 * nu))
    mu = E / (2 * (1 + nu))
    D = np.zeros((6, 6))
    D[:3, :3] = lam
    D[0, 0] = D[1, 1] = D[2, 2] = lam + 2 * mu
    D[3, 3] = D[4, 4] = D[5, 5] = mu
    return D


def _jacobian(X, dN):
    """X (e,10,3) node coords, dN (10,3) -> J (e,3,3) with J[i,j] = dx_i/dxi_j, detJ, invJ."""
    J = np.einsum("eai,aj->eij", X, dN)
    det = np.linalg.det(J)
    inv = np.linalg.inv(J)
    return J, det, inv


def B_matrix(dNdx):
    """dNdx (e,10,3) -> B (e,6,30)."""
    e = dNdx.shape[0]
    B = np.zeros((e, 6, 30))
    dx, dy, dz = dNdx[:, :, 0], dNdx[:, :, 1], dNdx[:, :, 2]
    B[:, 0, 0::3] = dx
    B[:, 1, 1::3] = dy
    B[:, 2, 2::3] = dz
    B[:, 3, 0::3] = dy
    B[:, 3, 1::3] = dx
    B[:, 4, 1::3] = dz
    B[:, 4, 2::3] = dy
    B[:, 5, 0::3] = dz
    B[:, 5, 2::3] = dx
    return B


def stiffness(X, D, rule=GAUSS4):
    """Element stiffness matrices.

    X (e,10,3) node coordinates (mm), D (e,6,6) or (6,6) constitutive (MPa)
    Returns Ke (e,30,30) [N/mm], volumes (e,) [mm^3], min detJ.
    """
    pts, wts = rule
    e = X.shape[0]
    Ke = np.zeros((e, 30, 30))
    vol = np.zeros(e)
    mindet = np.inf
    per_elem_D = D.ndim == 3
    for p, w in zip(pts, wts):
        dN = dshape(p)
        _, det, inv = _jacobian(X, dN)
        mindet = min(mindet, float(det.min()))
        dNdx = np.einsum("aj,eji->eai", dN, inv)  # dN_a/dx_i = sum_j dN_a/dxi_j * dxi_j/dx_i
        B = B_matrix(dNdx)
        DB = np.einsum("ekl,elj->ekj", D, B) if per_elem_D else np.einsum("kl,elj->ekj", D, B)
        wd = w * np.abs(det)
        Ke += np.einsum("eki,ekj->eij", B, DB) * wd[:, None, None]
        vol += wd
    return Ke, vol, mindet


def body_force(X, bvec, rule=GAUSS4):
    """Consistent nodal loads of a uniform body force bvec (e,3) [N/mm^3] -> (e,10,3) [N]."""
    pts, wts = rule
    F = np.zeros((X.shape[0], 10, 3))
    for p, w in zip(pts, wts):
        N = shape(p)
        _, det, _ = _jacobian(X, dshape(p))
        F += (w * np.abs(det))[:, None, None] * N[None, :, None] * bvec[:, None, :]
    return F


def nodal_strains(X, U):
    """Strain (e,10,6) evaluated at each element's 10 nodes. X (e,10,3), U (e,10,3)."""
    e = X.shape[0]
    out = np.zeros((e, 10, 6))
    u = U.reshape(e, 30)
    for a in range(10):
        dN = dshape(NODE_XI[a])
        _, _, inv = _jacobian(X, dN)
        dNdx = np.einsum("aj,eji->eai", dN, inv)
        out[:, a, :] = np.einsum("ekj,ej->ek", B_matrix(dNdx), u)
    return out


def von_mises(s):
    """s (...,6) Voigt stress -> von Mises (...)."""
    sx, sy, sz, txy, tyz, tzx = (s[..., k] for k in range(6))
    return np.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3.0 * (txy ** 2 + tyz ** 2 + tzx ** 2))


def principal(s):
    """s (n,6) -> principal stresses (n,3) sorted descending (s1 >= s2 >= s3)."""
    T = np.empty((s.shape[0], 3, 3))
    T[:, 0, 0], T[:, 1, 1], T[:, 2, 2] = s[:, 0], s[:, 1], s[:, 2]
    T[:, 0, 1] = T[:, 1, 0] = s[:, 3]
    T[:, 1, 2] = T[:, 2, 1] = s[:, 4]
    T[:, 0, 2] = T[:, 2, 0] = s[:, 5]
    return np.linalg.eigvalsh(T)[:, ::-1]


# ----------------------------------------------------------------------------- TRI6 surface loads
# 6-point degree-4 triangle rule (area coords), weights sum to 1/2 (reference triangle area)
_t6a, _t6b = 0.445948490915965, 0.091576213509771
_t6wa, _t6wb = 0.223381589678011 / 2, 0.109951743655322 / 2
TRI6_RULE = (np.array([[_t6a, _t6a], [1 - 2 * _t6a, _t6a], [_t6a, 1 - 2 * _t6a],
                       [_t6b, _t6b], [1 - 2 * _t6b, _t6b], [_t6b, 1 - 2 * _t6b]]),
             np.array([_t6wa] * 3 + [_t6wb] * 3))


def tri6_shape(r, s):
    t = 1 - r - s
    N = np.array([t * (2 * t - 1), r * (2 * r - 1), s * (2 * s - 1), 4 * t * r, 4 * r * s, 4 * s * t])
    dr = np.array([-(4 * t - 1), 4 * r - 1, 0.0, 4 * (t - r), 4 * s, -4 * s])
    ds = np.array([-(4 * t - 1), 0.0, 4 * s - 1, -4 * r, 4 * r, 4 * (t - s)])
    return N, dr, ds


def tri6_loads(Xf, traction=None, pressure=None):
    """Consistent nodal loads on 6-node triangles.

    Xf (m,6,3) node coords, nodes ordered corners a,b,c then mids ab, bc, ca, wound so that
    (b - a) x (c - a) points OUT of the solid.
    traction (m,3) [MPa]: a uniform traction vector, or
    pressure (m,) [MPa]: positive pushes INTO the surface (along -outward normal).
    Returns (m,6,3) nodal forces [N] and the (m,) face areas [mm^2].
    """
    pts, wts = TRI6_RULE
    F = np.zeros(Xf.shape[:2] + (3,))
    area = np.zeros(Xf.shape[0])
    for (r, s), w in zip(pts, wts):
        N, dr, ds = tri6_shape(r, s)
        gr = np.einsum("a,mai->mi", dr, Xf)
        gs = np.einsum("a,mai->mi", ds, Xf)
        nvec = np.cross(gr, gs)  # |nvec| = area Jacobian, direction = outward normal
        jac = np.linalg.norm(nvec, axis=1)
        area += w * jac
        if traction is not None:
            F += (w * jac)[:, None, None] * N[None, :, None] * traction[:, None, :]
        if pressure is not None:
            F += -w * pressure[:, None, None] * N[None, :, None] * nvec[:, None, :]
    return F, area


def tri6_area(Xf):
    return tri6_loads(Xf)[1]

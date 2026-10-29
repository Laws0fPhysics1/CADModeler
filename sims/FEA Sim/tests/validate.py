"""Validation suite for FEA Sim.  Run:  python tests/validate.py  [--quick]

(a) cantilever 200 x 20 x 10 mm steel, 100 N tip load: tip deflection vs PL^3/3EI and the bending
    stress vs Mc/I;  (b) bar in uniaxial tension: stress = F/A, uniform;  (c) mesh convergence of (a);
(d) load checks: pressure resultant, gravity reaction = m g, multi-face force;  (e) the CLI run
    (main.py --case --headless) writes results.json, progress.json and viz/ with valid layouts.
Exit code 0 when every check passes.
"""
from __future__ import annotations

import contextlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import time

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, HERE)

from cases import STEEL, face_ref, plate_holes_step, write_case  # noqa: E402
from fea.caseio import load_case  # noqa: E402
from fea.run import solve_case  # noqa: E402

TMP = os.path.join(tempfile.gettempdir(), "fea-sim-validation")
FAILS = []


def check(cond, msg):
    print(("  ok    " if cond else "  FAIL  ") + msg)
    if not cond:
        FAILS.append(msg)


@contextlib.contextmanager
def quiet_fd():
    """gmsh's OCC STEP writer prints to the C stdout; silence it."""
    sys.stdout.flush()
    fd = os.dup(1)
    with open(os.devnull, "w") as dn:
        os.dup2(dn.fileno(), 1)
        try:
            yield
        finally:
            sys.stdout.flush()
            os.dup2(fd, 1)
            os.close(fd)


def run(folder, **kw):
    case = load_case(folder)
    return solve_case(case, log=lambda *a: None, **kw)


def make(name, **kw):
    with quiet_fd():
        return write_case(os.path.join(TMP, name), **kw)


# ----------------------------------------------------------------------------- (a) + (c) cantilever
Lb, B, H, P = 200.0, 20.0, 10.0, 100.0
E = STEEL["youngs_modulus_Pa"] * 1e-6
I = B * H ** 3 / 12
D_EB = P * Lb ** 3 / (3 * E * I)
G = E / (2 * (1 + STEEL["poissons_ratio"]))
D_TIM = D_EB + P * Lb / (5 / 6 * G * B * H)


def cantilever(quality):
    f = make(f"cantilever_{quality}", size=(Lb, B, H), quality=quality,
             fixtures=[[face_ref((0, B / 2, H / 2), (-1, 0, 0))]],
             loads=[{"type": "force", "faces": [face_ref((Lb, B / 2, H / 2), (1, 0, 0))], "vector_N": [0, 0, -P]}])
    t = time.time()
    r, a = run(f)
    wall = time.time() - t
    X, U, S = a["nodes"], a["u"], a["stress"]
    tip = np.isclose(X[:, 0], Lb, atol=1e-6)
    d_tip = -U[tip, 2].mean()
    out = {"quality": quality, "nodes": r["nodes"], "elements": r["elements"], "h": r["mesh"]["size_mm"],
           "d_tip": d_tip, "err_EB": (d_tip - D_EB) / D_EB * 100, "err_T": (d_tip - D_TIM) / D_TIM * 100,
           "vm_max": r["maxVonMises_MPa"], "solver": r["solver"]["method"] + "/" + r["solver"]["backend"],
           "solve_s": r["timings"]["solving_s"], "wall_s": wall, "r": r}
    # bending stress sxx on the top (z = H, tension) and bottom fibres at x = 50 and 100 mm
    for x in (50.0, 100.0):
        win = np.abs(X[:, 0] - x) < 0.6 * r["mesh"]["size_mm"]
        top = win & np.isclose(X[:, 2], H, atol=1e-6)
        bot = win & np.isclose(X[:, 2], 0.0, atol=1e-6)
        theory = P * (Lb - x) * (H / 2) / I
        out[f"sxx_top_{int(x)}"] = S[top, 0].mean()
        out[f"sxx_bot_{int(x)}"] = S[bot, 0].mean()
        out[f"sxx_th_{int(x)}"] = theory
    out["s_root_th"] = P * Lb * (H / 2) / I
    return out


def section_a(quick):
    print(f"\n(a) Cantilever {Lb:g} x {B:g} x {H:g} mm steel (E = {E:g} MPa), tip load {P:g} N")
    print(f"    Euler-Bernoulli PL^3/3EI = {D_EB:.5f} mm, with Timoshenko shear term = {D_TIM:.5f} mm, Mc/I at root = {P * Lb * H / 2 / I:.2f} MPa")
    c = cantilever("medium")
    print(f"    medium mesh: {c['nodes']:,} nodes, {c['elements']:,} TET10, tip deflection {c['d_tip']:.5f} mm "
          f"({c['err_EB']:+.2f} % vs EB, {c['err_T']:+.2f} % vs Timoshenko)")
    for x in (50, 100):
        print(f"    sxx at x = {x} mm: top {c[f'sxx_top_{x}']:.2f} MPa, bottom {c[f'sxx_bot_{x}']:.2f} MPa, "
              f"Mc/I = {c[f'sxx_th_{x}']:.2f} MPa")
    print(f"    max von Mises {c['vm_max']:.2f} MPa (root, includes the clamp's Poisson stress concentration)")
    check(abs(c["err_EB"]) < 2.0, f"tip deflection within 2 % of PL^3/3EI ({c['err_EB']:+.2f} %)")
    for x in (50, 100):
        e = (c[f"sxx_top_{x}"] - c[f"sxx_th_{x}"]) / c[f"sxx_th_{x}"] * 100
        eb = (-c[f"sxx_bot_{x}"] - c[f"sxx_th_{x}"]) / c[f"sxx_th_{x}"] * 100
        check(abs(e) < 2.0 and abs(eb) < 2.0, f"bending stress at x = {x} mm within 2 % of Mc/I (top {e:+.2f} %, bottom {eb:+.2f} %)")
    r = c["r"]
    check(abs(r["reactions"][0]["force_N"][2] - P) < 1e-6 * P and r["equilibriumError"] < 1e-6,
          f"reaction balances the load ({r['reactions'][0]['force_N'][2]:.6f} N)")
    check(abs(r["minSafetyFactor"] - 250 / r["maxVonMises_MPa"]) < 1e-6, "safety factor = yield / max von Mises")
    rows = [c]
    if not quick:
        rows = [cantilever(q) for q in ("coarse",)] + [c] + [cantilever(q) for q in ("fine", "finest")]
    print("\n(c) Mesh convergence (cantilever)")
    print("    | quality | h (mm) | nodes | TET10 | tip defl. (mm) | vs EB | vs Timoshenko | sxx x=100 top (MPa) | max vM (MPa) | solver | solve (s) |")
    print("    |---|---|---|---|---|---|---|---|---|---|---|")
    for c in rows:
        print(f"    | {c['quality']} | {c['h']:.2f} | {c['nodes']:,} | {c['elements']:,} | {c['d_tip']:.5f} | {c['err_EB']:+.2f} % | "
              f"{c['err_T']:+.2f} % | {c['sxx_top_100']:.2f} | {c['vm_max']:.1f} | {c['solver']} | {c['solve_s']:.2f} |")
    if len(rows) > 1:
        d = [c["d_tip"] for c in rows]
        check(all(abs(d[i + 1] - d[i]) <= abs(d[1] - d[0]) + 1e-4 for i in range(1, len(d) - 1)), "tip deflection converges with refinement")


# ----------------------------------------------------------------------------- (b) tension
def section_b():
    Lt, a, F = 100.0, 10.0, 10000.0
    print(f"\n(b) Bar {Lt:g} x {a:g} x {a:g} mm in tension, F = {F:g} N  ->  F/A = {F / a / a:.2f} MPa, FL/EA = {F * Lt / (E * a * a):.5f} mm")
    f = make("tension", size=(Lt, a, a), quality="medium",
             fixtures=[[face_ref((0, a / 2, a / 2), (-1, 0, 0))]],
             loads=[{"type": "force", "faces": [face_ref((Lt, a / 2, a / 2), (1, 0, 0))], "vector_N": [F, 0, 0]}])
    r, A = run(f)
    X, U, S = A["nodes"], A["u"], A["stress"]
    mid = (X[:, 0] > 0.3 * Lt) & (X[:, 0] < 0.7 * Lt)
    sxx = S[mid, 0]
    s0 = F / a / a
    print(f"    {r['nodes']:,} nodes; middle 40 % of the bar: sxx mean {sxx.mean():.3f} MPa, min {sxx.min():.3f}, max {sxx.max():.3f}, "
          f"other components max |{np.abs(S[mid, 1:]).max():.4f}| MPa")
    # elongation measured between two sections in the uniform zone (no clamp effect)
    s1, s2 = np.isclose(X[:, 0], 30.0, atol=0.6 * r["mesh"]["size_mm"]), np.isclose(X[:, 0], 70.0, atol=0.6 * r["mesh"]["size_mm"])
    strain = (U[s2, 0].mean() - U[s1, 0].mean()) / (X[s2, 0].mean() - X[s1, 0].mean())
    print(f"    strain between x = 30 and 70 mm: {strain:.6e} (F/AE = {s0 / E:.6e});  von Mises there {r['maxVonMises_MPa']:.2f} max overall")
    check(abs(sxx.mean() - s0) / s0 < 0.005, f"mean axial stress = F/A within 0.5 % ({(sxx.mean() - s0) / s0 * 100:+.3f} %)")
    check((sxx.max() - sxx.min()) / s0 < 0.02, f"stress uniform within 2 % in the middle ({(sxx.max() - sxx.min()) / s0 * 100:.3f} % spread)")
    check(abs(strain - s0 / E) / (s0 / E) < 0.01, f"strain = F/AE within 1 % ({(strain - s0 / E) / (s0 / E) * 100:+.3f} %)")
    check(abs(r["reactions"][0]["force_N"][0] + F) < 1e-6 * F, "reaction = -F")


# ----------------------------------------------------------------------------- (d) other loads
def section_d():
    print("\n(d) Load checks")
    # pressure 1 MPa on the top of a 100 x 40 x 10 plate fixed at both ends: reaction = p A
    p = 1e6
    f = make("pressure", size=(100, 40, 10), quality="coarse",
             fixtures=[[face_ref((0, 20, 5), (-1, 0, 0))], [face_ref((100, 20, 5), (1, 0, 0))]],
             loads=[{"type": "pressure", "faces": [face_ref((50, 20, 10), (0, 0, 1))], "magnitude_Pa": p}])
    r, _ = run(f)
    rz = sum(x["force_N"][2] for x in r["reactions"])
    check(abs(rz - 4000.0) < 1e-3, f"pressure 1 MPa on 4000 mm^2: reactions sum to {rz:.4f} N (expect 4000)")
    r0, r1 = r["reactions"][0]["force_N"][2], r["reactions"][1]["force_N"][2]
    check(abs(r0 - r1) < 0.01 * abs(rz), f"symmetric plate: end reactions {r0:.2f} / {r1:.2f} N equal within 1 % (unstructured mesh)")
    # gravity on the cantilever: reaction = m g
    f = make("gravity", size=(Lb, B, H), quality="coarse", gravity=True,
             fixtures=[[face_ref((0, B / 2, H / 2), (-1, 0, 0))]])
    r, _ = run(f)
    m = 7850 * Lb * B * H * 1e-9
    rz = r["reactions"][0]["force_N"][2]
    w_th = 7850e-12 * 9806.65 * B * H * Lb ** 4 / (8 * E * I)
    print(f"    gravity: mass {r['mass_kg']:.5f} kg (expect {m:.5f}), reaction {rz:.5f} N (m g = {m * 9.80665:.5f}), "
          f"tip deflection {r['maxDisplacement_mm']:.6f} mm (qL^4/8EI = {w_th:.6f})")
    check(abs(rz - m * 9.80665) < 1e-6 * m * 9.80665 + 1e-9, "gravity reaction = m g")
    check(abs(r["maxDisplacement_mm"] - w_th) / w_th < 0.03, f"gravity tip deflection within 3 % of qL^4/8EI")
    # force spread over two faces: the total matches
    f = make("twofaces", size=(50, 50, 50), quality="coarse",
             fixtures=[[face_ref((25, 25, 0), (0, 0, -1))]],
             loads=[{"type": "force", "faces": [face_ref((0, 25, 25), (-1, 0, 0)), face_ref((50, 25, 25), (1, 0, 0))], "vector_N": [0, 300, 0]}])
    r, _ = run(f)
    check(abs(r["reactions"][0]["force_N"][1] + 300) < 1e-6, f"force over two faces: total 300 N reacted ({r['reactions'][0]['force_N'][1]:.6f})")
    fm = [x["surface"] for x in r["loads"][0]["faces"]]
    check(len(set(fm)) == 2, f"the two load faces map to two different surfaces {fm}")


# ----------------------------------------------------------------------------- (f) pin supports, bearing loads
def section_f():
    print("\n(f) Pin supports and bearing loads (plate 100 x 40 x 10 mm, holes r = 6 mm at x = 15 and x = 50)")
    size, r0 = (100.0, 40.0, 10.0), 6.0
    holes = [(15.0, 20.0, r0), (50.0, 20.0, r0)]
    step = os.path.join(TMP, "plate_holes.step")
    with quiet_fd():
        plate_holes_step(step, size, holes)
    hole = lambda x: face_ref((x + r0, 20.0, 5.0), (-1, 0, 0))
    end = face_ref((100.0, 20.0, 5.0), (1, 0, 0))
    load = [{"type": "force", "faces": [end], "vector_N": [0, 0, -100.0]}]
    # a pin holding radial + axial + tangential is a fixed face, just in a rotated frame
    rf, af = run(make("pin_fixed_ref", step_src=step, quality="coarse", fixtures=[[hole(15)], [hole(50)]], loads=load))
    rp, ap = run(make("pin_all", step_src=step, quality="coarse", loads=load,
                      fixtures=[{"type": "pin", "faces": [hole(15)], "radial": True, "axial": True, "tangential": True},
                                {"type": "pin", "faces": [hole(50)], "radial": True, "axial": True, "tangential": True}]))
    # (the two runs mesh separately, so compare the peaks rather than node by node)
    du = abs(rp["maxDisplacement_mm"] - rf["maxDisplacement_mm"]) / rf["maxDisplacement_mm"]
    dv = abs(rp["maxVonMises_MPa"] - rf["maxVonMises_MPa"]) / rf["maxVonMises_MPa"]
    check(du < 0.01 and dv < 0.03, f"pin holding all three directions = fixed (peak displacement {du * 100:.2f} %, "
          f"peak von Mises {dv * 100:.2f} % apart)")
    ax = rp["fixtures"][0]["axis"]
    check(abs(abs(ax["direction"][2]) - 1) < 1e-6 and np.allclose(ax["point"][:2], [15, 20], atol=1e-3) and abs(ax["radius_mm"] - r0) < 0.05,
          f"pin axis fitted: point {np.round(ax['point'][:2], 4).tolist()}, radius {ax['radius_mm']:.4f} mm")
    # radial + axial pins on both holes: the plate can't turn (two axes), a pull along +X goes into the pins,
    # and the holes stay round (no radial displacement) while the walls are free to slide around the pin
    pull = [{"type": "force", "faces": [end], "vector_N": [1000.0, 0, 0]}]
    rr, ar = run(make("pin_radial", step_src=step, quality="coarse", loads=pull,
                      fixtures=[{"type": "pin", "faces": [hole(15)], "radial": True, "axial": True},
                                {"type": "pin", "faces": [hole(50)], "radial": True, "axial": True}]))
    X, U = ar["nodes"], ar["u"]
    on = np.abs(np.hypot(X[:, 0] - 15, X[:, 1] - 20) - r0) < 1e-3
    rad = (X[on, :2] - [15, 20]) / r0
    ur = np.abs(np.einsum("ni,ni->n", U[on, :2], rad)).max()
    ut = np.abs(U[on, :2] - rad * np.einsum("ni,ni->n", U[on, :2], rad)[:, None]).max()
    check(ur < 1e-2 * ut, f"radial pin (axis fitted to the mesh, so not exactly 0): hole wall radial displacement {ur:.1e} mm, tangential slip {ut:.2e} mm")
    rx = sum(x["force_N"][0] for x in rr["reactions"])
    check(abs(rx + 1000) < 1e-6 * 1000 and rr["equilibriumError"] < 1e-6, f"radial pins react the pull ({rx:.6f} N)")
    # bearing load on the free hole of a plate fixed at x = 0: exact resultant, only the pushed half loaded
    rb, _ = run(make("bearing", step_src=step, quality="coarse", fixtures=[[face_ref((0, 20, 5), (-1, 0, 0))]],
                     loads=[{"type": "bearing", "faces": [hole(50)], "vector_N": [500.0, 0, 0]}]))
    ld = rb["loads"][0]
    check(abs(rb["reactions"][0]["force_N"][0] + 500) < 1e-6 * 500, f"bearing load: reaction {rb['reactions'][0]['force_N'][0]:.6f} N (expect -500)")
    half = ld["loaded_area_mm2"] / ld["area_mm2"]
    check(0.4 < half < 0.6, f"bearing load lies on the pushed half of the hole ({half * 100:.1f} % of its area)")


# ----------------------------------------------------------------------------- (e) CLI + viz layout
def section_e():
    print("\n(e) CLI run and viz/ layout")
    f = make("cli", size=(Lb, B, H), quality="coarse",
             fixtures=[[face_ref((0, B / 2, H / 2), (-1, 0, 0), idx=0)]],
             loads=[{"type": "force", "faces": [face_ref((Lb, B / 2, H / 2), (1, 0, 0), idx=1)], "vector_N": [0, 0, -P]}])
    t = time.time()
    p = subprocess.run([sys.executable, os.path.join(ROOT, "main.py"), "--case", f, "--headless"], capture_output=True, text=True)
    check(p.returncode == 0, f"main.py exit code {p.returncode} in {time.time() - t:.1f} s")
    with open(os.path.join(f, "results.json")) as fh:
        res = json.load(fh)
    with open(os.path.join(f, "progress.json")) as fh:
        prog = json.load(fh)
    with open(os.path.join(f, "viz", "manifest.json")) as fh:
        man = json.load(fh)
    check(res["status"] == "completed" and prog["status"] == "completed", "results.json / progress.json status completed")
    with open(os.path.join(f, "viz", "surface.bin"), "rb") as fh:
        b = fh.read()
    magic, nv, nt = b[:4], *struct.unpack("<II", b[4:12])
    ok = magic == b"FSF1" and len(b) == 12 + 12 * nv + 12 * nt + 4 * nt and nv == man["surface"]["vertices"]
    sizes = {k: os.path.getsize(os.path.join(f, "viz", v["file"])) for k, v in man["fields"].items()}
    ok = ok and sizes["displacement"] == 12 * nv and sizes["vonMises"] == 4 * nv and sizes["safetyFactor"] == 4 * nv and sizes["principal"] == 12 * nv
    check(ok, f"viz binaries consistent ({nv:,} vertices, {nt:,} triangles)")
    pos = np.frombuffer(b[12:12 + 12 * nv], "<f4").reshape(-1, 3)
    check(np.allclose(pos.min(0), [0, 0, 0], atol=1e-4) and np.allclose(pos.max(0), [Lb, B, H], atol=1e-3), "viz positions in CAD mm")
    tsurf = np.frombuffer(b[12 + 12 * nv + 12 * nt:], "<i4")
    check((tsurf > 0).all(), "every viz triangle carries its gmsh surface tag")


def main():
    quick = "--quick" in sys.argv
    os.makedirs(TMP, exist_ok=True)
    t = time.time()
    section_a(quick)
    section_b()
    section_d()
    section_f()
    section_e()
    print(f"\n{len(FAILS)} failure(s), {time.time() - t:.1f} s")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())

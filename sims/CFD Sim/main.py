"""CFD Sim entry point.

GUI:       python main.py
Headless:  python main.py --headless model.stl --length 4.5 --speed 30 --res 120 [--ground] [--name car]
CAD case:  python main.py --case <case folder>                 (GUI, pre-filled from case.json)
           python main.py --case <case folder> --headless      (no GUI; writes progress.json / results.json)
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


def headless(args):
    from cfd.geometry import load_mesh, prepare_mesh
    from cfd.solver import CaseParams, run_case
    m = load_mesh(args.model)
    sm = prepare_mesh(m, args.flow_axis, args.up_axis, args.length, args.model)
    p = CaseParams(speed=args.speed, fluid=args.fluid, nu=args.nu, rho=args.rho, resolution=args.res,
                   ground=args.ground, ground_gap=args.ground_gap, moving_ground=not args.fixed_ground, flow_throughs=args.flow_throughs,
                   n_frames=args.frames, name=args.name or os.path.splitext(os.path.basename(args.model))[0],
                   pad_up=args.pad_up, pad_down=args.pad_down, pad_side=args.pad_side, pad_top=args.pad_top, max_blockage=args.max_blockage,
                   les=not args.no_les, u_lb=args.u_lb, refine=not args.no_refine,
                   precision=args.precision, levels=args.levels)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")

    def prog(step, total, mlups, cd, cl, cs, t):
        print(f"\r{step:>9,}/{total:,}  {mlups:6.0f} MLUPS  t={t:.4f}s  Cd={cd:.3f} Cl={cl:.3f}", end="", flush=True)

    folder = run_case(sm, p, out, progress=prog, prefer_gpu=not args.cpu)
    print(f"\nOpen it in the viewer: python main.py --open \"{folder}\"")


def main():
    ap = argparse.ArgumentParser(description="CFD Sim (GPU lattice-Boltzmann)")
    ap.add_argument("--headless", metavar="MODEL", dest="model", nargs="?", const="",
                    help="run without the GUI (MODEL may be omitted with --case)")
    ap.add_argument("--case", metavar="CASE_FOLDER",
                    help="CAD Modeler case folder (case.json + geometry.stl); see cfd/cadlink.py")
    ap.add_argument("--open", metavar="RUN_FOLDER", help="open the GUI on an existing run")
    ap.add_argument("--length", type=float, default=1.0, help="object's longest dimension in metres")
    ap.add_argument("--speed", type=float, default=20.0, help="free-stream speed m/s")
    ap.add_argument("--fluid", default="Air (20°C)", choices=["Air (20°C)", "Water (20°C)", "Custom"])
    ap.add_argument("--nu", type=float, default=1.5e-5); ap.add_argument("--rho", type=float, default=1.204)
    ap.add_argument("--res", type=int, default=80, help="cells across the object's longest dimension")
    ap.add_argument("--flow-axis", default="+X"); ap.add_argument("--up-axis", default="+Z")
    ap.add_argument("--ground", action="store_true"); ap.add_argument("--ground-gap", type=float, default=0.0)
    ap.add_argument("--fixed-ground", action="store_true", help="floor does not move with the flow")
    ap.add_argument("--flow-throughs", type=float, default=4.0); ap.add_argument("--frames", type=int, default=120)
    ap.add_argument("--pad-up", type=float, default=2.0); ap.add_argument("--pad-down", type=float, default=4.0)
    ap.add_argument("--pad-side", type=float, default=1.5); ap.add_argument("--pad-top", type=float, default=1.5)
    ap.add_argument("--max-blockage", type=float, default=0.01,
                    help="widen side/top padding until bbox frontal area / tunnel section <= this (0 = off)")
    ap.add_argument("--u-lb", type=float, default=0.05); ap.add_argument("--no-les", action="store_true")
    ap.add_argument("--cpu", action="store_true", help="force the NumPy solver")
    ap.add_argument("--no-refine", action="store_true", help="uniform grid instead of the nested fine block")
    ap.add_argument("--precision", default="fp16c", choices=["fp16c", "fp16", "fp32"],
                    help="population storage: fp16c custom 16-bit (default), IEEE fp16, or fp32 (2x memory; reference)")
    ap.add_argument("--levels", type=int, default=4, help="grid levels (1 = uniform)")
    ap.add_argument("--name", default="")
    args = ap.parse_args()

    if args.case:
        if args.model:
            ap.error("--case already names the geometry; use --headless without MODEL")
        if args.model is not None:          # bare --headless
            from cfd.cadlink import run_headless
            sys.exit(0 if run_headless(args.case, prefer_gpu=not args.cpu, name=args.name or None) else 1)
        from cfd.app import main as gui_main
        gui_main(case=args.case)
        return
    if args.model == "":
        ap.error("--headless needs a MODEL (or a --case folder)")
    if args.model:
        headless(args)
        return
    from cfd.app import main as gui_main
    gui_main(open_run=args.open)


if __name__ == "__main__":
    main()

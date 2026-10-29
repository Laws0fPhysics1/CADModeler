"""FEA Sim command line.

    python main.py --case <case folder> [--headless] [--cpu] [--quality coarse|medium|fine|finest]

Reads <case>/case.json (format cadmodeler-fea-case, see CAD Modeler/docs/fea-exchange.md),
solves the linear static stress problem and writes progress.json, results.json and viz/
back into the case folder. There is no GUI yet: --headless is accepted for symmetry
with CFD Sim and is the only mode.
"""
import argparse
import sys
import time


def main(argv=None):
    ap = argparse.ArgumentParser(description="FEA Sim: linear static stress (TET10) for CAD Modeler cases")
    ap.add_argument("--case", required=True, help="case folder containing case.json and the STEP geometry")
    ap.add_argument("--headless", action="store_true", help="run without a GUI (the only mode for now)")
    ap.add_argument("--cpu", action="store_true", help="do not use the GPU (CuPy) for the iterative solver")
    ap.add_argument("--quality", choices=["coarse", "medium", "fine", "finest"], help="override case mesh quality")
    a = ap.parse_args(argv)
    from fea.run import run_headless

    def log(msg):
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

    return run_headless(a.case, prefer_gpu=not a.cpu, quality=a.quality, log=log)


if __name__ == "__main__":
    sys.exit(main())

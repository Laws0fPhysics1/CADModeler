# sims - bundled simulation code (generated, do not edit here)

CAD Modeler's in-app **CFD Study** and **Static Stress** run two Python projects:

| Folder | Source (owner's PC) | What it is |
|---|---|---|
| `sims/CFD Sim/` | `Documents\CFD Sim` | Lattice-Boltzmann external-flow solver (CuPy on an NVIDIA GPU) |
| `sims/FEA Sim/` | `Documents\FEA Sim` | Linear static stress, gmsh TET10 mesher + NumPy/SciPy solver |

Both folders are **mirrored copies**. The owner's `Publish Changes.bat` refreshes them
with `robocopy /MIR` from those source folders before every commit, so any edit made
here is overwritten on the next publish. Change the code in `Documents\CFD Sim` /
`Documents\FEA Sim` instead.

Left out of the mirror: run results (`runs/`), `__pycache__`, `*.pyc`, `*.bak`, logs,
and a third-party aircraft model of unknown licence. The CFD sample meshes
(`samples/`) are copied but not committed (the sims don't need them).

## Python environment

`Update CAD Modeler.bat` creates `sims/.venv` (Python 3.10 - 3.13, ideally 3.12 from
python.org) and installs both projects' `requirements.txt` into it, re-installing only
when those files change. CuPy is installed only when an NVIDIA driver (`nvidia-smi`)
is found:

- **FEA** works on any PC (CPU solve).
- **CFD** in the app needs an NVIDIA GPU (CUDA 12 driver).

The app looks for the interpreter at `sims\.venv\Scripts\python.exe`. The venv is
never committed.

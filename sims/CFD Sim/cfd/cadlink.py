"""CAD Modeler integration: read a "cadmodeler-cfd-case" folder, map it onto CaseParams / the GUI,
and write progress.json / results.json back into the same folder.

The exchange format is specified in CAD Modeler/docs/cfd-exchange.md. In short, CAD writes

    <exchange>/<Design>_<YYYYMMDD-HHMMSS>/geometry.stl   binary STL, millimetres, CAD axes (Z up)
                                         /case.json      flow / ground / solver settings

and this module writes back, atomically,

    progress.json   while running (throttled to <= 1 per second)
    results.json    once the run completes, is stopped, diverges or fails

Nothing here touches the solver numerics: it only builds CaseParams and observes run_case's callbacks.
"""
from __future__ import annotations

import csv
import json
import math
import os
import sys
import time
import traceback
from dataclasses import dataclass, field

import numpy as np

from .geometry import AXES, load_mesh, orientation_matrix, prepare_mesh, SimMesh
from .solver import FLUIDS, CaseParams, plan_case

FORMAT = "cadmodeler-cfd-case"
VERSION = 1                      # highest case.json version this reader understands
MM = 0.001                       # metres per CAD unit

# Same cell budgets as cfd/app.py QUALITY (target cells, frames, u_lb); keyed by the case's quality id.
QUALITY = {
    "draft": (8e6, 60, 0.05),
    "standard": (25e6, 120, 0.05),
    "high": (60e6, 160, 0.05),
    "ultra": (110e6, 200, 0.05),
    "max": (150e6, 200, 0.05),
}
DEFAULT_SOLVER = {"quality": "standard", "resolution": None, "levels": 4, "precision": "fp16c",
                  "flowThroughs": 3.0, "frames": None, "gpu": True}


class CaseError(ValueError):
    pass


def fluid_name(name) -> str | None:
    """Map a case's fluid onto a FLUIDS key by its first word ("Air (20°C)", "air", "Water" ...), so a mangled
    degree sign never breaks a case."""
    if name is None:
        return "Air (20°C)"
    word = str(name).strip().split(" ")[0].lower()
    return next((k for k in FLUIDS if k.split(" ")[0].lower() == word), None)


# --------------------------------------------------------------------------------------
# Atomic JSON writes (the CAD app polls these files)
# --------------------------------------------------------------------------------------
def write_json_atomic(path: str, data: dict):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, default=_json_default)
        fh.flush()
        os.fsync(fh.fileno())
    for attempt in range(20):          # Windows: the reader may hold the old file open for a moment
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def _json_default(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


def _finite(v):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


# --------------------------------------------------------------------------------------
# Reading a case
# --------------------------------------------------------------------------------------
@dataclass
class CadCase:
    folder: str
    data: dict
    warnings: list = field(default_factory=list)

    # -- convenience accessors
    @property
    def design(self) -> str:
        return str(self.data.get("source", {}).get("design") or "Untitled")

    @property
    def app(self) -> str:
        return str(self.data.get("source", {}).get("app") or "CAD Modeler")

    @property
    def stl_path(self) -> str:
        return os.path.join(self.folder, self.data["geometry"]["file"])

    @property
    def flow(self) -> dict:
        return self.data["flow"]

    @property
    def ground(self) -> dict:
        return self.data.get("ground") or {"enabled": False, "gap_mm": 0.0, "moving": True}

    @property
    def solver(self) -> dict:
        s = dict(DEFAULT_SOLVER)
        s.update({k: v for k, v in (self.data.get("solver") or {}).items() if v is not None})
        return s

    @property
    def run_name(self) -> str:
        return os.path.basename(os.path.normpath(self.folder))

    @property
    def progress_path(self) -> str:
        return os.path.join(self.folder, (self.data.get("results") or {}).get("progress", "progress.json"))

    @property
    def results_path(self) -> str:
        return os.path.join(self.folder, (self.data.get("results") or {}).get("results", "results.json"))

    @property
    def label(self) -> str:
        return f"From {self.app}: {self.design}"


def load_case(folder: str) -> CadCase:
    """Read and validate <folder>/case.json. `folder` may also be the case.json path itself."""
    folder = os.path.abspath(folder)
    if os.path.isfile(folder):
        folder = os.path.dirname(folder)
    path = os.path.join(folder, "case.json")
    if not os.path.isfile(path):
        raise CaseError(f"No case.json in {folder}")
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    warnings = validate(data)
    case = CadCase(folder, data, warnings)
    if not os.path.isfile(case.stl_path):
        raise CaseError(f"Geometry file missing: {case.stl_path}")
    return case


def validate(d: dict) -> list:
    """Raise CaseError on anything the CFD side cannot run; return a list of warnings."""
    errs, warns = [], []
    if d.get("format") != FORMAT:
        errs.append(f'format must be "{FORMAT}"')
    ver = d.get("version")
    if not isinstance(ver, int) or ver < 1:
        errs.append("version must be a positive integer")
    elif ver > VERSION:
        warns.append(f"case.json version {ver} is newer than this reader ({VERSION}); unknown fields ignored")
    if d.get("units") != "mm":
        errs.append('units must be "mm"')
    g = d.get("geometry") or {}
    if not g.get("file"):
        errs.append("geometry.file missing")
    f = d.get("flow") or {}
    if f.get("direction") not in AXES:
        errs.append("flow.direction must be one of " + " ".join(AXES))
    up = f.get("up", "+Z")
    if up not in AXES:
        errs.append("flow.up must be one of " + " ".join(AXES))
    elif f.get("direction") in AXES and AXES[up][0] == AXES[f["direction"]][0]:
        errs.append("flow.up must be perpendicular to flow.direction")
    if not (_finite(f.get("speed_m_s")) or 0) > 0:
        errs.append("flow.speed_m_s must be > 0")
    if fluid_name(f.get("fluid")) is None:
        errs.append("flow.fluid must be one of " + ", ".join(FLUIDS))
    if fluid_name(f.get("fluid")) == "Custom" and not ((_finite(f.get("nu")) or 0) > 0 and (_finite(f.get("rho")) or 0) > 0):
        errs.append("Custom fluid needs nu > 0 and rho > 0")
    s = d.get("solver") or {}
    if s.get("quality") is not None and s["quality"] not in QUALITY:
        errs.append("solver.quality must be one of " + " ".join(QUALITY))
    if s.get("maxBlockage") is not None and not (isinstance(s["maxBlockage"], (int, float)) and 0 <= s["maxBlockage"] < 0.5):
        errs.append("solver.maxBlockage must be a fraction in [0, 0.5) (0 = classic 1.5 L padding)")
    if s.get("levels") is not None and s["levels"] not in (1, 2, 3, 4):
        errs.append("solver.levels must be 1..4")
    if s.get("precision") is not None and s["precision"] not in ("fp16c", "fp16", "fp32"):
        errs.append("solver.precision must be fp16c, fp16 or fp32")
    if errs:
        raise CaseError("Invalid case.json: " + "; ".join(errs))
    return warns


# --------------------------------------------------------------------------------------
# Mapping onto the solver
# --------------------------------------------------------------------------------------
def case_axes(case: CadCase) -> tuple[str, str]:
    """(flow_axis, up_axis) for prepare_mesh. The case's flow.direction is the free-stream velocity in CAD
    axes, which is exactly prepare_mesh's flow axis (that model axis becomes sim +X = downstream)."""
    return case.flow["direction"], case.flow.get("up", "+Z")


def case_mesh(case: CadCase) -> SimMesh:
    flow_axis, up_axis = case_axes(case)
    return prepare_mesh(load_mesh(case.stl_path), flow_axis, up_axis, source=case.stl_path, scale=MM)


def quality_resolution(sm: SimMesh, p: CaseParams, quality: str) -> int:
    """Cells across the object for a quality preset: the same cell-budget rule as the GUI's _apply_quality."""
    target = QUALITY[quality][0]
    # the budget ignores the blockage widening: the extra lateral room is coarsest-grid cells only (cheap per
    # step), so the cells across the object stay what they were with the classic 1.5 L box
    base = CaseParams(**{**p.__dict__, "resolution": 100, "max_blockage": 0.0})
    cells = plan_case(sm, base).cells_total
    res = int(round(100 * (target / cells) ** (1 / 3) / 5.0) * 5)
    return int(np.clip(res, 20, 400))


def case_params(case: CadCase, sm: SimMesh, name: str | None = None) -> CaseParams:
    f, g, s = case.flow, case.ground, case.solver
    fluid = fluid_name(f.get("fluid"))
    levels = int(s["levels"])
    p = CaseParams(speed=float(f["speed_m_s"]), fluid=fluid,
                   nu=float(f.get("nu") or 1.5e-5), rho=float(f.get("rho") or 1.204),
                   ground=bool(g.get("enabled")), ground_gap=float(g.get("gap_mm") or 0.0) * MM,
                   moving_ground=bool(g.get("moving", True)),
                   flow_throughs=float(s["flowThroughs"]), precision=str(s["precision"]),
                   refine=levels > 1, levels=max(1, levels), name=name or case.run_name)
    if s.get("maxBlockage") is not None:
        p.max_blockage = float(s["maxBlockage"])
    q = QUALITY.get(s.get("quality") or "standard", QUALITY["standard"])
    p.n_frames = int(s["frames"]) if s.get("frames") else q[1]
    p.u_lb = q[2]
    p.resolution = int(s["resolution"]) if s.get("resolution") else quality_resolution(sm, p, s.get("quality") or "standard")
    return p


# --------------------------------------------------------------------------------------
# Write-back
# --------------------------------------------------------------------------------------
class CaseReporter:
    """Observes a run started from a case and writes progress.json / results.json into the case folder.
    Use `progress(...)` as (or inside) run_case's progress callback, then `finish(run_folder)` or `fail(...)`."""

    def __init__(self, case: CadCase, params: CaseParams | None = None, interval: float = 1.0, backend: str = ""):
        self.case, self.params, self.interval, self.backend = case, params, interval, backend
        self.started = time.time()
        self.started_iso = _now_iso()
        self._last_write = 0.0
        self.last = {}
        self.run_folder = None
        self.closed = False
        try:
            if os.path.isfile(case.results_path):
                os.remove(case.results_path)     # a stale result from a previous run would confuse the poller
        except OSError:
            pass
        self._write_progress("starting", force=True)

    def _write_progress(self, status, force=False, **extra):
        now = time.time()
        if not force and status == getattr(self, "_status", None) and now - self._last_write < self.interval:
            return
        self._last_write, self._status = now, status
        d = {"kind": "progress", "format": FORMAT, "version": VERSION, "status": status,
             "step": self.last.get("step", 0), "total": self.last.get("total", 0),
             "fraction": (self.last.get("step", 0) / self.last["total"]) if self.last.get("total") else 0.0,
             "Cd": _finite(self.last.get("Cd")), "Cl": _finite(self.last.get("Cl")), "Cs": _finite(self.last.get("Cs")),
             "MLUPS": _finite(self.last.get("mlups")), "t_sim_s": _finite(self.last.get("t")),
             "elapsed_s": round(now - self.started, 2), "runFolder": self.run_folder, "updatedAt": _now_iso()}
        d.update(extra)
        try:
            write_json_atomic(self.case.progress_path, d)
        except OSError:
            pass                                 # never let write-back kill a run

    def ready(self):
        """GUI opened the case but has not started a run yet."""
        self._write_progress("ready", force=True)

    def progress(self, step, total, mlups, cd, cl, cs, t):
        self.last = {"step": int(step), "total": int(total), "mlups": mlups, "Cd": cd, "Cl": cl, "Cs": cs, "t": t}
        self._write_progress("running")

    def frame(self, idx, folder):
        self.run_folder = folder

    def finish(self, run_folder: str, stopped: bool = False):
        self.run_folder = run_folder
        res = summarize_run(run_folder)
        status = "completed"
        if res.get("diverged"):
            status = "diverged"
        elif stopped or (res.get("steps_total") and res.get("steps", 0) < res["steps_total"]):
            status = "stopped"
        self._results(status, res)
        self._write_progress(status, force=True)

    def fail(self, error: str):
        self._results("failed", summarize_run(self.run_folder) if self.run_folder else {}, error=str(error)[-4000:])
        self._write_progress("failed", force=True, error=str(error)[-500:])

    def _results(self, status, res, error=None):
        if self.closed:
            return
        self.closed = True
        end = time.time()
        d = {"kind": "results", "format": FORMAT, "version": VERSION, "status": status, "case": self.case.run_name,
             "design": self.case.design}
        d.update({k: v for k, v in res.items() if k != "diverged"})
        d["forces_cad_N"] = _forces_to_cad(self.case, res.get("forces_N"))
        d["timings"] = {"startedAt": self.started_iso, "finishedAt": _now_iso(), "wall_s": round(end - self.started, 2)}
        if res.get("steps") and end > self.started:
            d["timings"]["steps_per_s"] = round(res["steps"] / (end - self.started), 1)
        if self.backend:
            d["backend"] = self.backend
        if error:
            d["error"] = error
        try:
            write_json_atomic(self.case.results_path, d)
        except OSError:
            pass


def summarize_run(run_folder: str | None, tail: float = 0.2) -> dict:
    """Coefficients and forces from a run folder (forces.csv + meta.json): last value and mean of the last 20 %."""
    out = {"runFolder": os.path.abspath(run_folder) if run_folder else None}
    if not run_folder or not os.path.isdir(run_folder):
        return out
    meta = {}
    try:
        with open(os.path.join(run_folder, "meta.json"), encoding="utf-8") as fh:
            meta = json.load(fh)
    except (OSError, ValueError):
        pass
    rows = []
    try:
        with open(os.path.join(run_folder, "forces.csv"), newline="") as fh:
            rows = [[float(x) for x in r] for r in list(csv.reader(fh))[1:] if len(r) == 8]
    except (OSError, ValueError):
        pass
    info, params = meta.get("info", {}), meta.get("params", {})
    levels = info.get("levels") or []
    dx_fine = levels[-1]["dx"] if levels else info.get("dx")
    sym = 2.0 if info.get("symmetry") else 1.0
    area = info.get("frontal_area_lb", 0.0) * dx_fine ** 2 * sym if dx_fine else None
    rho = params.get("rho")
    if params.get("fluid") in FLUIDS and FLUIDS[params["fluid"]][1] is not None:
        rho = FLUIDS[params["fluid"]][1]
    U = params.get("speed")
    out.update({"referenceArea_m2": _finite(area), "referenceLength_m": _finite(meta.get("L")),
                "speed_m_s": _finite(U), "rho": _finite(rho), "reynolds": _finite(info.get("re")),
                "dynamicPressure_Pa": _finite(0.5 * rho * U * U) if rho and U else None,
                "cells": int(info["nx"] * info["ny"] * info["nz"] + sum(int(np.prod(l["shape"])) for l in levels)) if info else None,
                "resolution": params.get("resolution"), "levels": len(levels) + 1 if info else None,
                "steps_total": info.get("steps")})
    if rows:
        a = np.asarray(rows)
        diverged = not np.all(np.isfinite(a[-1]))
        a_ok = a[np.all(np.isfinite(a), axis=1)]
        n = len(a_ok)
        win = a_ok[int(n * (1 - tail)):] if n else a_ok
        mean = win.mean(axis=0) if len(win) else np.full(8, np.nan)
        lastr = a_ok[-1] if n else np.full(8, np.nan)
        out.update({
            "steps": int(a[-1, 0]), "t_sim_s": _finite(a[-1, 1]),
            "Cd": _finite(mean[5]), "Cl": _finite(mean[6]), "Cs": _finite(mean[7]),
            "forces_N": {"drag": _finite(mean[2]), "side": _finite(mean[3]), "lift": _finite(mean[4])},
            "final": {"Cd": _finite(lastr[5]), "Cl": _finite(lastr[6]), "Cs": _finite(lastr[7]),
                      "forces_N": {"drag": _finite(lastr[2]), "side": _finite(lastr[3]), "lift": _finite(lastr[4])}},
            "averaging": f"mean of the last {int(tail * 100)} % of steps ({len(win)} samples)",
            "diverged": bool(diverged)})
        # convergence: the averaging window against the window just before it
        prev = a_ok[max(0, int(n * (1 - 2 * tail))):int(n * (1 - tail))] if n else a_ok
        if len(win) >= 3 and len(prev) >= 3 and np.isfinite(mean[5]) and abs(mean[5]) > 1e-9:
            cd_prev = float(prev[:, 5].mean())
            drift = (float(mean[5]) - cd_prev) / abs(float(mean[5]))
            out["convergence"] = {"Cd_previous_window": _finite(cd_prev), "drift": _finite(drift),
                                  "Cd_std_window": _finite(float(win[:, 5].std())),
                                  "converged": bool(abs(drift) <= 0.03),
                                  "note": "drift = (Cd last window - Cd previous window) / Cd; |drift| <= 3 % counts as settled. "
                                          "If not settled, run more flow-throughs."}
    # blockage: voxel frontal area / free-slip tunnel cross-section (full-model equivalent), plus Maskell's
    # bluff-body correction Cd_c = Cd / (1 + 2.5 Cd S/C) as a reported extra (Cd itself is uncorrected)
    if info and area:
        dx = info.get("dx")
        section = (info["ny"] - 2) * dx * sym * (info["nz"] - 2) * dx
        if section > 0:
            blk = area / section
            out["blockage"] = _finite(blk)
            cd = out.get("Cd")
            if cd is not None:
                out["Cd_maskell"] = _finite(cd / (1 + 2.5 * cd * blk))
    ft = meta.get("frame_times") or []
    if ft:
        out["frames"] = len(ft)
    return out


def _forces_to_cad(case: CadCase, f: dict | None):
    """Sim-axis force (drag along +X sim, side +Y, lift +Z) as a vector in CAD axes [N]."""
    if not f or any(f.get(k) is None for k in ("drag", "side", "lift")):
        return None
    R = orientation_matrix(*case_axes(case))          # sim = R @ cad
    v = R.T @ np.array([f["drag"], f["side"], f["lift"]])
    return [round(float(x), 6) for x in v]


# --------------------------------------------------------------------------------------
# Headless
# --------------------------------------------------------------------------------------
STOP_FILE = "stop.request"      # CAD Modeler creates this to ask a headless run to stop


def run_headless(folder: str, prefer_gpu: bool = True, out_root: str | None = None, name: str | None = None,
                 log=print, export_viz: bool = True) -> str | None:
    """Run a case without the GUI. With export_viz each frame is also converted into <case>/viz/ for CAD
    Modeler's in-app results (cfd/cadviz.py). Creating <case>/stop.request stops the run gracefully."""
    from .solver import run_case
    try:
        os.remove(os.path.join(folder, STOP_FILE))
    except OSError:
        pass
    try:
        case = load_case(folder)
    except Exception as e:                 # still tell the CAD app why, if the folder exists
        log(f"Cannot open case: {e}")
        if os.path.isdir(folder):
            try:
                write_json_atomic(os.path.join(folder, "results.json"), {"kind": "results", "format": FORMAT, "version": VERSION,
                                                                          "status": "failed", "error": str(e)})
            except OSError:
                pass
        return None
    for w in case.warnings:
        log("warning: " + w)
    root = out_root or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runs")
    reporter = None
    try:
        sm = case_mesh(case)
        p = case_params(case, sm, name=name)
        gpu = prefer_gpu and bool(case.solver.get("gpu", True))
        e = sm.extent
        log(f"{case.label}  ({case.folder})")
        log(f"flow {case.flow['direction']} / up {case.flow.get('up', '+Z')}: sim extent "
            f"{e[0]:.4g} x {e[1]:.4g} x {e[2]:.4g} m, speed {p.speed} m/s, {p.fluid}, res {p.resolution}, "
            f"levels {p.levels if p.refine else 1}, {p.flow_throughs} flow-throughs, {p.n_frames} frames, "
            f"ground {'on, gap %.4g m' % p.ground_gap if p.ground else 'off'}")
        reporter = CaseReporter(case, p, backend="gpu" if gpu else "cpu")
        viz = None
        if export_viz:
            from .cadviz import VizExporter
            viz = VizExporter(case, log=log)
        stop_file = os.path.join(case.folder, STOP_FILE)
        stop = {"flag": False}
        tty = sys.stdout.isatty()

        def should_stop():
            if not stop["flag"] and os.path.exists(stop_file):
                stop["flag"] = True
                log("Stop requested by CAD Modeler.")
            return stop["flag"]

        def prog(step, total, mlups, cd, cl, cs, t):
            reporter.progress(step, total, mlups, cd, cl, cs, t)
            if tty:
                print(f"\r{step:>9,}/{total:,}  {mlups:6.0f} MLUPS  t={t:.4f}s  Cd={cd:.3f} Cl={cl:.3f}", end="", flush=True)

        def on_frame(idx, folder):
            reporter.frame(idx, folder)
            if viz is not None:
                viz.frame(idx, folder)

        run_folder = run_case(sm, p, root, progress=prog, frame_cb=on_frame, should_stop=should_stop,
                              prefer_gpu=gpu, log=log)
        if tty:
            print()
        reporter.finish(run_folder, stopped=stop["flag"])
        if viz is not None:
            viz.write_manifest(status=reporter._status)
        log(f"Results written to {case.results_path}")
        return run_folder
    except Exception:
        tb = traceback.format_exc()
        log(tb)
        if reporter is None:
            reporter = CaseReporter(case)
        reporter.fail(tb)
        return None


# --------------------------------------------------------------------------------------
# GUI
# --------------------------------------------------------------------------------------
class GuiLink:
    """Attaches a case to a running MainWindow: loads the geometry through the window's own load path,
    pre-fills the fields, shows the source design, and reports runs back into the case folder."""

    def __init__(self, win, case: CadCase):
        self.win, self.case = win, case
        self.reporter: CaseReporter | None = None

    def apply(self):
        from PySide6 import QtWidgets
        w, c = self.win, self.case
        w.load_model_path(c.stl_path)                       # same path as "Open model…"
        if w.model is None:
            return
        f, g, s = c.flow, c.ground, c.solver
        w._syncing = True
        try:
            w.cb_preset.blockSignals(True); w.cb_preset.setCurrentText("Custom"); w.cb_preset.blockSignals(False)
            flow_axis, up_axis = case_axes(c)
            w.cb_flow.setCurrentText(flow_axis); w.cb_up.setCurrentText(up_axis)
            w.cb_units.setCurrentText("millimetres"); w.scale = MM
            w.sp_speed.setValue(float(f["speed_m_s"]))
            w.cb_fluid.setCurrentText(fluid_name(f.get("fluid")))
            if fluid_name(f.get("fluid")) == "Custom":
                w.sp_nu.setValue(float(f["nu"])); w.sp_rho.setValue(float(f["rho"]))
            w.ck_ground.setChecked(bool(g.get("enabled"))); w.sp_gap.setValue(float(g.get("gap_mm") or 0) * MM)
            w.ck_moving.setChecked(bool(g.get("moving", True)))
            for wd, v in zip((w.sp_pad_up, w.sp_pad_down, w.sp_pad_side, w.sp_pad_top), (2.0, 4.0, 1.5, 1.5)):
                wd.setValue(v)
            levels = int(s["levels"])
            w.ck_refine.setChecked(levels > 1)
            w.cb_levels.setCurrentIndex(int(np.clip(levels - 2, 0, w.cb_levels.count() - 1)))
            w.sp_ft.setValue(float(s["flowThroughs"]))
            w.ck_gpu.setChecked(bool(s.get("gpu", True)))
            w.ed_name.setText(c.run_name)
        finally:
            w._syncing = False
        w._fluid_changed(); w._ground_changed()
        q = s.get("quality") or "standard"
        items = [w.cb_quality.itemText(i) for i in range(w.cb_quality.count())]
        label = next((k for k in items if k.lower().startswith(q)), None)
        if label:
            w.cb_quality.blockSignals(True); w.cb_quality.setCurrentText(label); w.cb_quality.blockSignals(False)
        w._update_estimate()
        w._apply_quality()                                   # resolution / frames / u_lb from the cell budget
        if s.get("resolution"):
            w.sp_res.setValue(int(s["resolution"]))          # explicit resolution wins (quality -> Custom)
        if s.get("frames"):
            w.sp_frames.setValue(int(s["frames"]))
        w._update_estimate()

        w.setWindowTitle(f"CFD Sim  ·  {c.label}")
        lbl = QtWidgets.QLabel(c.label + ("" if not c.data["geometry"].get("bodies") else
                               "  ·  " + ", ".join(b.get("name", b.get("id", "?")) for b in c.data["geometry"]["bodies"][:6])))
        lbl.setObjectName("cadSource"); lbl.setWordWrap(True)
        lbl.setStyleSheet("color: #6fb4ff; font-weight: 600;")
        lay = w.lbl_mesh.parentWidget().layout()
        lay.insertWidget(lay.indexOf(w.lbl_mesh), lbl)
        self.source_label = lbl
        w.log.appendPlainText(f"{c.label}  ·  case {c.folder}")
        for msg in c.warnings:
            w.log.appendPlainText("warning: " + msg)
        try:
            write_json_atomic(c.progress_path, {"kind": "progress", "format": FORMAT, "version": VERSION, "status": "ready",
                                                "step": 0, "total": 0, "fraction": 0.0, "updatedAt": _now_iso()})
        except OSError:
            pass

    def watch(self, worker, params: CaseParams):
        """Called by MainWindow.start_run before the worker starts."""
        params.precision = str(self.case.solver.get("precision", params.precision))
        self.reporter = rep = CaseReporter(self.case, params, backend="gpu" if worker.prefer_gpu else "cpu")
        worker.progress.connect(rep.progress)
        worker.frame.connect(rep.frame)
        worker.done.connect(lambda folder: rep.finish(folder, stopped=worker._stop))
        worker.failed.connect(rep.fail)


def attach_gui(win, folder: str) -> GuiLink | None:
    from PySide6 import QtWidgets
    try:
        case = load_case(folder)
    except Exception as e:
        QtWidgets.QMessageBox.critical(win, "Cannot open CAD case", str(e))
        return None
    link = GuiLink(win, case)
    win.cad_link = link
    link.apply()
    return link

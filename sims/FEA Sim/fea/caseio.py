"""Reading a `cadmodeler-fea-case` folder and writing progress / results back.

The case folder is the whole interface between CAD Modeler and this solver
(spec: CAD Modeler/docs/fea-exchange.md). CAD polls progress.json,
results.json and viz/manifest.json, so every file is written atomically
(<name>.<pid>.tmp, then os.replace).
"""
from __future__ import annotations

import json
import math
import os
import time

import numpy as np

FORMAT = "cadmodeler-fea-case"
VERSION = 1
STOP_FILE = "stop.request"
CASE_FILE = "case.json"
PROGRESS_FILE = "progress.json"
RESULTS_FILE = "results.json"
MESH_QUALITIES = ("coarse", "medium", "fine", "finest")


class StopRequested(Exception):
    """Raised between phases / solver iterations when CAD created stop.request."""


class CaseError(Exception):
    """The case folder is unusable (missing files, invalid case.json)."""


# ----------------------------------------------------------------------------- json helpers
def _json_default(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


def finite(v, default=None):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return v if math.isfinite(v) else default


def write_json_atomic(path: str, data: dict):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=1, default=_json_default)
        fh.flush()
        os.fsync(fh.fileno())
    for attempt in range(20):  # Windows: a reader may hold the old file open for a moment
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def write_bytes_atomic(path: str, data: bytes):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "wb") as fh:
        fh.write(data)
    for attempt in range(20):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


# ----------------------------------------------------------------------------- case reading
def validate(d: dict) -> list[str]:
    """Return a list of problems (empty = ok). Mirrors validateCase() in src/fealink.js."""
    errs = []
    if not isinstance(d, dict):
        return ["case.json is not an object"]
    if d.get("format") != FORMAT:
        errs.append(f'format must be "{FORMAT}"')
    v = d.get("version")
    if not isinstance(v, int) or v < 1:
        errs.append("version must be a positive integer")
    if d.get("units") != "mm":
        errs.append('units must be "mm"')
    g = d.get("geometry") or {}
    if not isinstance(g.get("file"), str) or not g.get("file"):
        errs.append("geometry.file missing")
    bodies = g.get("bodies")
    if not isinstance(bodies, list) or not bodies:
        errs.append("geometry.bodies must be a non-empty list")
    fx = d.get("fixtures")
    if not isinstance(fx, list) or not fx:
        errs.append("at least one fixture is required")
    for i, f in enumerate(fx or []):
        if not isinstance(f, dict) or not isinstance(f.get("faces"), list) or not f["faces"]:
            errs.append(f"fixtures[{i}].faces must be a non-empty list")
            continue
        if f.get("type", "fixed") not in ("fixed", "pin"):
            errs.append(f'fixtures[{i}].type must be "fixed" or "pin"')
        if f.get("type") == "pin" and not any(f.get(k) for k in ("radial", "axial", "tangential")):
            errs.append(f"fixtures[{i}]: a pin support must hold at least one of radial / axial / tangential")
    for i, ld in enumerate(d.get("loads") or []):
        t = ld.get("type") if isinstance(ld, dict) else None
        if t not in ("force", "pressure", "bearing"):
            errs.append(f'loads[{i}].type must be "force", "pressure" or "bearing"')
            continue
        if not isinstance(ld.get("faces"), list) or not ld["faces"]:
            errs.append(f"loads[{i}].faces must be a non-empty list")
        if t in ("force", "bearing"):
            vec = ld.get("vector_N")
            if not (isinstance(vec, list) and len(vec) == 3 and all(finite(x) is not None for x in vec)):
                errs.append(f"loads[{i}].vector_N must be [fx, fy, fz]")
        if t == "pressure" and finite(ld.get("magnitude_Pa")) is None:
            errs.append(f"loads[{i}].magnitude_Pa must be a number")
    q = (d.get("mesh") or {}).get("quality", "medium")
    if q not in MESH_QUALITIES:
        errs.append(f"mesh.quality must be one of {', '.join(MESH_QUALITIES)}")
    return errs


class FeaCase:
    def __init__(self, folder: str, data: dict):
        self.folder = os.path.abspath(folder)
        self.data = data

    @property
    def design(self) -> str:
        return (self.data.get("source") or {}).get("design") or os.path.basename(self.folder)

    @property
    def step_path(self) -> str:
        return os.path.join(self.folder, self.data["geometry"]["file"])

    @property
    def bodies(self) -> list:
        return self.data["geometry"]["bodies"]

    @property
    def fixtures(self) -> list:
        return self.data.get("fixtures") or []

    @property
    def loads(self) -> list:
        return self.data.get("loads") or []

    @property
    def gravity(self) -> dict:
        return self.data.get("gravity") or {"enabled": False}

    @property
    def mesh(self) -> dict:
        return self.data.get("mesh") or {}

    @property
    def solver(self) -> dict:
        return self.data.get("solver") or {}

    def path(self, name: str) -> str:
        return os.path.join(self.folder, name)


def load_case(folder: str) -> FeaCase:
    p = os.path.join(folder, CASE_FILE)
    if not os.path.isfile(p):
        raise CaseError(f"No {CASE_FILE} in {folder}")
    with open(p, "r", encoding="utf-8") as fh:
        d = json.load(fh)
    errs = validate(d)
    if errs:
        raise CaseError("Invalid case.json: " + "; ".join(errs))
    if d["version"] > VERSION:
        print(f"warning: case version {d['version']} is newer than this solver ({VERSION}); trying anyway")
    case = FeaCase(folder, d)
    if not os.path.isfile(case.step_path):
        raise CaseError(f"Geometry file not found: {case.step_path}")
    return case


# ----------------------------------------------------------------------------- write-back
PHASES = {  # phase -> (start fraction, end fraction)
    "starting": (0.0, 0.02),
    "meshing": (0.02, 0.30),
    "assembling": (0.30, 0.45),
    "solving": (0.45, 0.88),
    "post": (0.88, 0.94),
    "writing": (0.94, 1.0),
}


class Reporter:
    """progress.json / results.json writer plus the stop.request check."""

    def __init__(self, case: FeaCase, interval: float = 0.5, log=print):
        self.case = case
        self.interval = interval
        self.log = log
        self.t0 = time.time()
        self.started_at = now_iso()
        self._last = 0.0
        self.phase = "starting"
        self.stop_file = case.path(STOP_FILE)

    def base(self, kind: str) -> dict:
        return {"kind": kind, "format": FORMAT, "version": VERSION}

    def should_stop(self) -> bool:
        return os.path.exists(self.stop_file)

    def check_stop(self):
        if self.should_stop():
            raise StopRequested()

    def progress(self, phase: str, sub: float = 0.0, message: str = "", force: bool = False, **extra):
        now = time.time()
        changed = phase != self.phase
        self.phase = phase
        if not (force or changed) and now - self._last < self.interval:
            return
        self._last = now
        a, b = PHASES.get(phase, (0.0, 1.0))
        sub = min(max(float(sub), 0.0), 1.0)
        d = self.base("progress")
        d.update({"status": "running" if phase != "starting" else "starting", "phase": phase,
                  "fraction": round(a + (b - a) * sub, 4), "message": message,
                  "elapsed_s": round(now - self.t0, 2), "updatedAt": now_iso()})
        d.update(extra)
        try:
            write_json_atomic(self.case.path(PROGRESS_FILE), d)
        except OSError as e:  # never let a progress write kill the solve
            self.log(f"warning: could not write progress.json: {e}")

    def finish(self, status: str, results: dict, error: str | None = None):
        d = self.base("results")
        d.update({"status": status, "case": os.path.basename(self.case.folder), "design": self.case.design})
        d.update(results)
        t = d.setdefault("timings", {})
        t["startedAt"] = self.started_at
        t["finishedAt"] = now_iso()
        t["wall_s"] = round(time.time() - self.t0, 3)
        if error:
            d["error"] = error
        write_json_atomic(self.case.path(RESULTS_FILE), d)
        p = self.base("progress")
        p.update({"status": status, "phase": "done", "fraction": 1.0 if status == "completed" else None,
                  "elapsed_s": round(time.time() - self.t0, 2), "updatedAt": now_iso()})
        if error:
            p["error"] = error
        try:
            write_json_atomic(self.case.path(PROGRESS_FILE), p)
        except OSError:
            pass

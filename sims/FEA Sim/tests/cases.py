"""Helpers that build cadmodeler-fea-case folders for the validation tests (geometry made with gmsh's OCC
kernel and written as STEP, exactly like CAD Modeler's K.exportSTEP output)."""
from __future__ import annotations

import json
import os
import shutil

STEEL = {"id": "steel", "name": "Steel (test)", "density_kg_m3": 7850, "youngs_modulus_Pa": 200e9,
         "poissons_ratio": 0.3, "yield_strength_Pa": 250e6, "ultimate_strength_Pa": 400e6}


def box_step(path, size, origin=(0, 0, 0)):
    import gmsh
    gmsh.initialize(["-noenv"], readConfigFiles=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("box")
        gmsh.model.occ.addBox(*origin, *size)
        gmsh.model.occ.synchronize()
        gmsh.write(path)
    finally:
        gmsh.finalize()


def plate_holes_step(path, size, holes):
    """Box from the origin with through holes along Z: holes = [(x, y, radius), ...]."""
    import gmsh
    gmsh.initialize(["-noenv"], readConfigFiles=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("plate")
        box = gmsh.model.occ.addBox(0, 0, 0, *size)
        cyl = [gmsh.model.occ.addCylinder(x, y, -1, 0, 0, size[2] + 2, r) for x, y, r in holes]
        gmsh.model.occ.cut([(3, box)], [(3, c) for c in cyl])
        gmsh.model.occ.synchronize()
        gmsh.write(path)
    finally:
        gmsh.finalize()


def face_ref(pt, n, body="Body1", idx=None):
    return {"body": body, "idx": idx, "pt": list(map(float, pt)), "n": list(map(float, n))}


def write_case(folder, step_src=None, size=None, fixtures=(), loads=(), gravity=False, quality="medium",
               material=STEEL, size_mm=None, solver=None):
    if os.path.isdir(folder):
        shutil.rmtree(folder)
    os.makedirs(folder)
    step = os.path.join(folder, "geometry.step")
    if step_src:
        shutil.copy(step_src, step)
    else:
        box_step(step, size)
    case = {
        "format": "cadmodeler-fea-case", "version": 1, "units": "mm", "analysis": "static-stress",
        "source": {"app": "FEA Sim tests", "design": os.path.basename(folder)},
        "geometry": {"file": "geometry.step", "format": "step",
                     "bodies": [{"id": "Body1", "name": "Body1", "material": material}]},
        # a fixture is a list of face refs (fixed) or a full dict ({"type": "pin", "faces": [...], ...})
        "fixtures": [dict(f) if isinstance(f, dict) else {"type": "fixed", "faces": list(f)} for f in fixtures],
        "loads": list(loads),
        "gravity": {"enabled": bool(gravity), "vector_m_s2": [0, 0, -9.80665]},
        "mesh": {"quality": quality, "size_mm": size_mm},
        "solver": solver or {"method": "auto", "gpu": True},
    }
    with open(os.path.join(folder, "case.json"), "w") as fh:
        json.dump(case, fh, indent=1)
    return folder

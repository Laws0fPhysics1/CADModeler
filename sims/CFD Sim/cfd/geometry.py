"""Model loading (OBJ / STL / GLB / FBX / .blend), orientation into sim coordinates, voxelization.

Sim coordinates: +X = flow direction, +Z = up, +Y = right-handed remainder.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass

import numpy as np
import trimesh

AXES = {"+X": (0, 1), "-X": (0, -1), "+Y": (1, 1), "-Y": (1, -1), "+Z": (2, 1), "-Z": (2, -1)}


# --------------------------------------------------------------------------------------
# Loading
# --------------------------------------------------------------------------------------
def _find_blender() -> str | None:
    exe = shutil.which("blender")
    if exe:
        return exe
    for root in (r"C:\Program Files\Blender Foundation", r"C:\Program Files (x86)\Blender Foundation"):
        if os.path.isdir(root):
            versions = sorted(os.listdir(root), reverse=True)
            for v in versions:
                cand = os.path.join(root, v, "blender.exe")
                if os.path.isfile(cand):
                    return cand
    return None


_BLENDER_TO_GLB = r"""
import bpy, sys, os
argv = sys.argv[sys.argv.index("--") + 1:]
src, dst = argv[0], argv[1]
ext = os.path.splitext(src)[1].lower()
if ext == ".blend":
    bpy.ops.wm.open_mainfile(filepath=src)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ok = False
    for op in ("wm.fbx_import", "import_scene.fbx"):
        try:
            mod, name = op.split(".")
            getattr(getattr(bpy.ops, mod), name)(filepath=src)
            ok = True
            break
        except Exception as e:
            print("importer", op, "failed:", e)
    if not ok:
        raise SystemExit("no FBX importer worked")
# glTF keeps materials + textures; Z-up so coordinates match the source file
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_apply=True, export_yup=False,
                          use_visible=True, export_animations=False)
print("EXPORTED", dst)
"""


def _blender_to_glb(path: str) -> str:
    """Convert .blend / .fbx to a textured GLB with the local Blender install (cached in the temp dir)."""
    blender = _find_blender()
    if not blender:
        raise RuntimeError("Importing .blend / .fbx needs Blender on this machine (used headless to convert to GLB). "
                           "Install Blender or export the model as GLB / OBJ / STL.")
    cache = os.path.join(tempfile.gettempdir(), "cfdsim_models")
    os.makedirs(cache, exist_ok=True)
    stamp = int(os.path.getmtime(path))
    dst = os.path.join(cache, f"{os.path.splitext(os.path.basename(path))[0]}_{stamp}.glb")
    if os.path.isfile(dst):
        return dst
    script = os.path.join(cache, "to_glb.py")
    with open(script, "w") as fh:
        fh.write(_BLENDER_TO_GLB)
    res = subprocess.run([blender, "-b", "--python", script, "--", path, dst], capture_output=True, text=True, timeout=900)
    if not os.path.isfile(dst):
        raise RuntimeError("Blender conversion failed:\n" + res.stdout[-2000:] + res.stderr[-2000:])
    return dst


@dataclass
class Model:
    """A loaded model: named parts (raw model units) and, when available, a textured GLB for display."""
    path: str
    parts: dict                      # name -> trimesh.Trimesh (raw coordinates)
    glb_path: str | None = None
    enabled: dict = None             # name -> bool

    def __post_init__(self):
        if self.enabled is None:
            self.enabled = {k: True for k in self.parts}

    @property
    def mesh(self) -> trimesh.Trimesh:
        chosen = [m for k, m in self.parts.items() if self.enabled.get(k, True)] or list(self.parts.values())
        return trimesh.util.concatenate(chosen) if len(chosen) > 1 else chosen[0].copy()

    @property
    def extents(self) -> np.ndarray:
        return self.mesh.extents

    @property
    def n_faces(self) -> int:
        return sum(len(m.faces) for m in self.parts.values())


def load_model(path: str) -> Model:
    ext = os.path.splitext(path)[1].lower()
    glb = None
    src = path
    if ext in (".blend", ".fbx"):
        src = glb = _blender_to_glb(path)
    elif ext in (".glb", ".gltf"):
        glb = path
    loaded = trimesh.load(src, force="scene" if glb else "mesh", process=True)
    parts = {}
    if isinstance(loaded, trimesh.Scene):
        # dump applies the node transforms so parts land in world coordinates (same frame VTK's importer uses)
        for geom in loaded.dump(concatenate=False):
            if isinstance(geom, trimesh.Trimesh) and len(geom.faces):
                name = str(geom.metadata.get("node", geom.metadata.get("name", f"part{len(parts)}")))
                base, k = name, 1
                while name in parts:
                    name = f"{base}_{k}"; k += 1
                parts[name] = geom
    elif isinstance(loaded, trimesh.Trimesh) and len(loaded.faces):
        parts[os.path.splitext(os.path.basename(path))[0]] = loaded
    if not parts:
        raise RuntimeError(f"No triangle geometry found in {path}")
    for m in parts.values():
        m.remove_unreferenced_vertices()
    return Model(path=path, parts=parts, glb_path=glb)


def load_mesh(path: str) -> trimesh.Trimesh:
    """Backwards-compatible: the whole model as one mesh."""
    return load_model(path).mesh


# --------------------------------------------------------------------------------------
# Orientation + scaling
# --------------------------------------------------------------------------------------
def orientation_matrix(flow_axis: str, up_axis: str) -> np.ndarray:
    """Rotation R such that sim = R @ model. Rows: flow, up x flow, up."""
    fi, fs = AXES[flow_axis]
    ui, us = AXES[up_axis]
    if fi == ui:
        raise ValueError("Flow axis and up axis must be different")
    f = np.zeros(3); f[fi] = fs
    u = np.zeros(3); u[ui] = us
    y = np.cross(u, f)
    return np.stack([f, y, u]).astype(np.float64)


@dataclass
class SimMesh:
    """Mesh in sim coordinates, in meters, with min corner at the origin."""
    vertices: np.ndarray  # (n,3) float64, meters
    faces: np.ndarray     # (m,3) int
    extent: np.ndarray    # (3,) meters
    watertight: bool
    source: str
    matrix: np.ndarray = None   # 4x4 model -> sim (metres, before the domain offset)

    @property
    def trimesh(self) -> trimesh.Trimesh:
        return trimesh.Trimesh(self.vertices, self.faces, process=False)


def prepare_mesh(m: trimesh.Trimesh, flow_axis: str, up_axis: str, object_length_m: float | None = None,
                 source: str = "", yaw_deg: float = 0.0, scale: float | None = None, pitch_deg: float = 0.0) -> SimMesh:
    """Orient into sim axes and scale to metres. Give either `scale` (metres per model unit) or the
    physical length of the longest dimension."""
    R = orientation_matrix(flow_axis, up_axis)
    if pitch_deg:  # angle of attack: nose up = positive, rotate about the lateral (y) axis
        a = np.radians(pitch_deg); c, s = np.cos(a), np.sin(a)
        R = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]]) @ R
    if yaw_deg:  # crosswind: rotate about the vertical axis after orientation
        a = np.radians(yaw_deg); c, s = np.cos(a), np.sin(a)
        R = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]]) @ R
    v = (R @ m.vertices.T).T
    vmin = v.min(axis=0)
    v = v - vmin
    ext = v.max(axis=0)
    if scale is None:
        scale = float(object_length_m) / float(ext.max())
    v = v * scale
    sm = SimMesh(vertices=v, faces=np.asarray(m.faces), extent=v.max(axis=0),
                 watertight=bool(m.is_watertight), source=source)
    # sim = scale * (R @ model - vmin): keep the affine map so textured display geometry can follow
    M = np.eye(4); M[:3, :3] = scale * R; M[:3, 3] = -scale * vmin
    sm.matrix = M
    return sm


# --------------------------------------------------------------------------------------
# Voxelization
# --------------------------------------------------------------------------------------
def voxelize(sm: SimMesh, origin: np.ndarray, dx: float, shape: tuple[int, int, int]) -> np.ndarray:
    """Return a boolean solid mask of `shape` (nz, ny, nx) for lattice cell centres at
    origin + (i + 0.5) * dx.  Uses VTK's scanline stencil for the filled interior and a
    surface voxelization to make sure thin / open geometry still blocks flow."""
    import vtk
    from vtk.util import numpy_support as vn

    nx, ny, nz = shape
    poly = vtk.vtkPolyData()
    pts = vtk.vtkPoints()
    pts.SetData(vn.numpy_to_vtk(np.ascontiguousarray(sm.vertices, dtype=np.float64), deep=True))
    poly.SetPoints(pts)
    f = np.asarray(sm.faces, dtype=np.int64)
    cells = np.hstack([np.full((len(f), 1), 3, dtype=np.int64), f]).ravel()
    ca = vtk.vtkCellArray()
    ca.SetCells(len(f), vn.numpy_to_vtkIdTypeArray(cells, deep=True))
    poly.SetPolys(ca)

    img = vtk.vtkImageData()
    img.SetDimensions(nx, ny, nz)
    img.SetSpacing(dx, dx, dx)
    img.SetOrigin(origin[0] + 0.5 * dx, origin[1] + 0.5 * dx, origin[2] + 0.5 * dx)
    img.AllocateScalars(vtk.VTK_UNSIGNED_CHAR, 1)
    img.GetPointData().GetScalars().Fill(1)

    stencil = vtk.vtkPolyDataToImageStencil()
    stencil.SetInputData(poly)
    stencil.SetOutputOrigin(img.GetOrigin())
    stencil.SetOutputSpacing(img.GetSpacing())
    stencil.SetOutputWholeExtent(img.GetExtent())
    stencil.Update()

    fill = vtk.vtkImageStencil()
    fill.SetInputData(img)
    fill.SetStencilConnection(stencil.GetOutputPort())
    fill.ReverseStencilOff()
    fill.SetBackgroundValue(0)
    fill.Update()
    arr = vn.vtk_to_numpy(fill.GetOutput().GetPointData().GetScalars()).reshape(nz, ny, nx)
    solid = arr > 0

    # Surface shell: guarantees non-watertight meshes still present a wall to the flow.
    try:
        tm = sm.trimesh
        vox = tm.voxelized(pitch=dx)
        idx = np.round((vox.points - (origin + 0.5 * dx)) / dx).astype(np.int64)
        ok = np.all((idx >= 0) & (idx < np.array([nx, ny, nz])), axis=1)
        idx = idx[ok]
        solid[idx[:, 2], idx[:, 1], idx[:, 0]] = True
    except Exception:
        pass
    return solid

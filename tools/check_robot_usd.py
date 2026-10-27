#!/usr/bin/env python3
"""Validate a CAD Modeler robot package (robot.usda and/or robot.urdf).

    python tools/check_robot_usd.py <package folder | robot.usda> [--json]

Needs Pixar's USD Python bindings for the USD checks:  pip install usd-core
The URDF checks use only the standard library.

USD checks
  * the stage opens with no Tf errors; upAxis Z, metersPerUnit 1, kilogramsPerUnit 1, a default prim
  * rigid bodies (RigidBodyAPI + MassAPI): positive mass, positive principal inertia that satisfies the
    triangle inequality, unit principal-axes quaternion
  * meshes: index ranges, face counts, collision approximation
  * joints: body0 / body1 targets are rigid bodies (or the world), the joint frame seen from body0 and
    from body1 coincides in the exported (zero) pose, revolute limits in degrees, drives present
  * the joints form one tree with a single ArticulationRootAPI prim; every body is reachable
  * UsdPhysics' own parser (UsdPhysics.LoadUsdPhysicsFromRange) finds the same bodies, joints and articulation
URDF checks
  * valid XML; links, joints, one root, a tree; every mesh file exists and has geometry
  * forward kinematics at zero matches the USD link poses; URDF masses / inertia tensors match the USD ones
Exit code 0 when everything passes, 1 otherwise. The last line is CHECK OK or CHECK FAIL.
"""
import json
import math
import os
import sys
import xml.etree.ElementTree as ET

problems = []
report = {"usd": None, "urdf": None}


def fail(msg):
    problems.append(msg)
    print(f"  FAIL {msg}")


# ---------- tiny 4x4 math (row-major, column vectors) ----------
def mat_mul(a, b):
    return [[sum(a[r][k] * b[k][c] for k in range(4)) for c in range(4)] for r in range(4)]


def quat_to_mat(w, x, y, z, t=(0.0, 0.0, 0.0)):
    n = math.sqrt(w * w + x * x + y * y + z * z) or 1.0
    w, x, y, z = w / n, x / n, y / n, z / n
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), t[0]],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), t[1]],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), t[2]],
        [0, 0, 0, 1],
    ]


def rpy_to_mat(r, p, y, t):
    cr, sr, cp, sp, cy, sy = math.cos(r), math.sin(r), math.cos(p), math.sin(p), math.cos(y), math.sin(y)
    return [
        [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, t[0]],
        [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, t[1]],
        [-sp, cp * sr, cp * cr, t[2]],
        [0, 0, 0, 1],
    ]


def inv_rigid(m):
    r = [[m[c][rr] for c in range(3)] for rr in range(3)]
    t = [-(r[i][0] * m[0][3] + r[i][1] * m[1][3] + r[i][2] * m[2][3]) for i in range(3)]
    return [r[0] + [t[0]], r[1] + [t[1]], r[2] + [t[2]], [0, 0, 0, 1]]


def mat_diff(a, b):
    """(position difference, rotation difference as an angle in radians)"""
    dp = math.sqrt(sum((a[i][3] - b[i][3]) ** 2 for i in range(3)))
    # angle of a^T b
    tr = sum(a[k][i] * b[k][i] for i in range(3) for k in range(3))
    ang = math.acos(max(-1.0, min(1.0, (tr - 1) / 2)))
    return dp, ang


def gf_to_mat(g):
    """Gf.Matrix4d (row-vector convention) -> row-major column-vector matrix."""
    return [[g[c][r] for c in range(4)] for r in range(4)]


# ---------------- USD ----------------
def check_usd(path):
    try:
        from pxr import Gf, Tf, Usd, UsdGeom, UsdPhysics
    except ImportError:
        print("  SKIP pxr is not installed (pip install usd-core)")
        report["usd"] = {"skipped": True}
        return None
    print(f"USD  {path}")
    mark = Tf.Error.Mark()
    stage = Usd.Stage.Open(path)
    errs = [str(e.commentary) for e in mark.GetErrors()] if not mark.IsClean() else []
    if stage is None:
        fail("stage did not open")
        return None
    if errs:
        fail(f"{len(errs)} USD error(s) while opening: {errs[:3]}")
    else:
        print("  ok   stage opened with no errors")
    if UsdGeom.GetStageUpAxis(stage) != UsdGeom.Tokens.z:
        fail("upAxis is not Z")
    if abs(UsdGeom.GetStageMetersPerUnit(stage) - 1.0) > 1e-9:
        fail("metersPerUnit is not 1")
    if abs(UsdPhysics.GetStageKilogramsPerUnit(stage) - 1.0) > 1e-9:
        fail("kilogramsPerUnit is not 1")
    dp = stage.GetDefaultPrim()
    if not dp:
        fail("no defaultPrim")
    print(f"  ok   upAxis={UsdGeom.GetStageUpAxis(stage)} metersPerUnit={UsdGeom.GetStageMetersPerUnit(stage)} kilogramsPerUnit={UsdPhysics.GetStageKilogramsPerUnit(stage)} defaultPrim={dp.GetPath() if dp else None}")

    xc = UsdGeom.XformCache(Usd.TimeCode.Default())
    bodies, joints, arts, meshes = {}, [], [], 0
    tris = 0
    for prim in stage.Traverse():
        if prim.HasAPI(UsdPhysics.ArticulationRootAPI):
            arts.append(str(prim.GetPath()))
        if prim.HasAPI(UsdPhysics.RigidBodyAPI):
            m = UsdPhysics.MassAPI(prim)
            mass = m.GetMassAttr().Get() if prim.HasAPI(UsdPhysics.MassAPI) else None
            diag = m.GetDiagonalInertiaAttr().Get() if mass is not None else None
            pa = m.GetPrincipalAxesAttr().Get() if mass is not None else None
            com = m.GetCenterOfMassAttr().Get() if mass is not None else None
            world = gf_to_mat(xc.GetLocalToWorldTransform(prim))
            name = str(prim.GetPath())
            bodies[name] = {"mass": mass, "com": list(com) if com else None, "diag": list(diag) if diag else None,
                            "axes": [pa.GetReal(), *pa.GetImaginary()] if pa else None, "world": world}
            if mass is None or not mass > 0:
                fail(f"{name}: mass missing or not positive ({mass})")
            if diag is None or min(diag) <= 0:
                fail(f"{name}: diagonal inertia missing or not positive ({diag})")
            else:
                a, b, c = diag
                tol = 1e-6 * (a + b + c)
                if a + b < c - tol or a + c < b - tol or b + c < a - tol:
                    fail(f"{name}: principal moments violate the triangle inequality {tuple(diag)}")
            if pa is not None and abs(math.sqrt(pa.GetReal() ** 2 + Gf.Vec3f(pa.GetImaginary()).GetLength() ** 2) - 1) > 1e-4:
                fail(f"{name}: principalAxes is not a unit quaternion")
        if prim.IsA(UsdGeom.Mesh):
            meshes += 1
            mesh = UsdGeom.Mesh(prim)
            pts = mesh.GetPointsAttr().Get() or []
            idx = mesh.GetFaceVertexIndicesAttr().Get() or []
            cnt = mesh.GetFaceVertexCountsAttr().Get() or []
            if not len(pts) or not len(idx):
                fail(f"{prim.GetPath()}: empty mesh")
            if sum(cnt) != len(idx):
                fail(f"{prim.GetPath()}: faceVertexCounts do not add up to the index count")
            if len(idx) and (max(idx) >= len(pts) or min(idx) < 0):
                fail(f"{prim.GetPath()}: face index out of range")
            nrm = mesh.GetNormalsAttr().Get()
            if nrm is not None and len(nrm) not in (len(pts), len(idx)):
                fail(f"{prim.GetPath()}: normals count {len(nrm)} matches neither points nor face-vertices")
            tris += len(cnt)
            if prim.HasAPI(UsdPhysics.CollisionAPI) and not prim.HasAPI(UsdPhysics.MeshCollisionAPI):
                fail(f"{prim.GetPath()}: CollisionAPI without MeshCollisionAPI")
        if prim.IsA(UsdPhysics.Joint):
            joints.append(prim)
    print(f"  ok   {len(bodies)} rigid bodies, {meshes} meshes ({tris} triangles), {len(joints)} joints, articulation roots: {arts}")
    if len(arts) != 1:
        fail(f"expected exactly one ArticulationRootAPI prim, found {len(arts)}")

    print("  rigid bodies:")
    for n, b in bodies.items():
        print(f"    {n:40s} mass {b['mass']:.6g} kg  com {tuple(round(x, 5) for x in b['com'] or [])}  I {tuple(float('%.4g' % x) for x in b['diag'] or [])}")

    parent_of, children, jinfo = {}, {}, []
    world_fixed = []
    for jp in joints:
        j = UsdPhysics.Joint(jp)
        kind = jp.GetTypeName()
        b0 = [str(t) for t in j.GetBody0Rel().GetTargets()]
        b1 = [str(t) for t in j.GetBody1Rel().GetTargets()]
        b0 = b0[0] if b0 else None
        b1 = b1[0] if b1 else None
        lp0, lr0 = j.GetLocalPos0Attr().Get(), j.GetLocalRot0Attr().Get()
        lp1, lr1 = j.GetLocalPos1Attr().Get(), j.GetLocalRot1Attr().Get()
        info = {"name": jp.GetName(), "type": kind, "body0": b0, "body1": b1}
        for b in (b0, b1):
            if b is not None and b not in bodies:
                fail(f"joint {jp.GetPath()}: target {b} is not a rigid body")
        if b1 is None:
            fail(f"joint {jp.GetPath()}: no body1")
            continue
        q0 = quat_to_mat(lr0.GetReal(), *lr0.GetImaginary(), tuple(lp0))
        q1 = quat_to_mat(lr1.GetReal(), *lr1.GetImaginary(), tuple(lp1))
        w0 = mat_mul(bodies[b0]["world"], q0) if b0 else q0
        w1 = mat_mul(bodies[b1]["world"], q1)
        dpos, dang = mat_diff(w0, w1)
        info["frame_mismatch_m"], info["frame_mismatch_rad"] = dpos, dang
        if dpos > 1e-5 or dang > 1e-4:
            fail(f"joint {jp.GetName()}: frames from body0 and body1 disagree by {dpos:.3g} m / {dang:.3g} rad")
        if kind in ("PhysicsRevoluteJoint", "PhysicsPrismaticJoint"):
            ax = jp.GetAttribute("physics:axis").Get()
            lo, hi = jp.GetAttribute("physics:lowerLimit").Get(), jp.GetAttribute("physics:upperLimit").Get()
            info.update(axis=ax, lower=lo, upper=hi)
            if lo is not None and hi is not None and lo > hi:
                fail(f"joint {jp.GetName()}: lower limit > upper limit")
            drive = "angular" if kind == "PhysicsRevoluteJoint" else "linear"
            if not jp.HasAPI(UsdPhysics.DriveAPI, drive):
                fail(f"joint {jp.GetName()}: no PhysicsDriveAPI:{drive}")
            else:
                d = UsdPhysics.DriveAPI(jp, drive)
                info.update(stiffness=d.GetStiffnessAttr().Get(), damping=d.GetDampingAttr().Get())
        jinfo.append(info)
        if b0 is None:
            world_fixed.append(b1)
        else:
            if b1 in parent_of:
                fail(f"body {b1} is body1 of more than one joint")
            parent_of[b1] = b0
            children.setdefault(b0, []).append(b1)
    print("  joints:")
    for i in jinfo:
        extra = ""
        if "axis" in i:
            extra = f" axis {i['axis']} limits {i['lower']} .. {i['upper']} drive k={i.get('stiffness')} d={i.get('damping')}"
        print(f"    {i['name']:24s} {i['type']:22s} {i['body0'] or 'WORLD'} -> {i['body1']}{extra}  (frame mismatch {i.get('frame_mismatch_m', 0):.1e} m)")

    roots = [b for b in bodies if b not in parent_of]
    if len(roots) != 1:
        fail(f"expected one root body, found {roots}")
    reach, stack = set(), list(roots[:1])
    while stack:
        b = stack.pop()
        if b in reach:
            fail(f"cycle through {b}")
            break
        reach.add(b)
        stack.extend(children.get(b, []))
    missing = set(bodies) - reach
    if missing:
        fail(f"bodies not connected to the root: {sorted(missing)}")
    else:
        print(f"  ok   joint chain is a tree rooted at {roots[0] if roots else None}; base {'fixed to the world' if world_fixed else 'floating'}")

    # UsdPhysics' reference parser
    try:
        loader = getattr(UsdPhysics, "UsdPhysicsLoadStageFromPrimRange", None) or UsdPhysics.LoadUsdPhysicsFromRange
        parsed = loader(stage, ["/"])
        counts = {}
        for t, (paths, _descs) in parsed.items():
            counts[str(t).split(".")[-1]] = len(paths)
        print(f"  ok   UsdPhysics parser: {counts}")
        nb = counts.get("RigidBody", 0)
        nj = sum(v for k, v in counts.items() if k.endswith("Joint"))
        if nb != len(bodies) or nj != len(joints):
            fail(f"UsdPhysics parser found {nb} bodies / {nj} joints, expected {len(bodies)} / {len(joints)}")
        if counts.get("Articulation", 0) != 1:
            fail(f"UsdPhysics parser found {counts.get('Articulation', 0)} articulations")
        else:
            for t, (paths, descs) in parsed.items():
                if str(t).endswith("Articulation"):
                    arts_bodies = set(str(p) for p in descs[0].articulatedBodies if str(p))
                    if arts_bodies and set(bodies) - arts_bodies:
                        fail(f"articulation misses bodies {sorted(set(bodies) - arts_bodies)}")
                    else:
                        print(f"  ok   articulation covers {len(arts_bodies)} bodies")
    except Exception as e:  # older usd-core without the parser
        print(f"  SKIP UsdPhysics parser unavailable ({e})")
    report["usd"] = {"bodies": {k: {kk: vv for kk, vv in v.items() if kk != "world"} for k, v in bodies.items()},
                     "joints": jinfo, "articulationRoots": arts, "triangles": tris}
    root_prim = dp.GetPath() if dp else None
    return {"bodies": bodies, "root": str(root_prim) if root_prim else "", "fixed": bool(world_fixed)}


# ---------------- URDF ----------------
def check_urdf(path, usd):
    print(f"URDF {path}")
    try:
        tree = ET.parse(path)
    except ET.ParseError as e:
        fail(f"URDF is not valid XML: {e}")
        return
    robot = tree.getroot()
    if robot.tag != "robot" or not robot.get("name"):
        fail("root element must be <robot name=...>")
    base = os.path.dirname(os.path.abspath(path))
    links = {l.get("name"): l for l in robot.findall("link")}
    joints = robot.findall("joint")
    print(f"  ok   robot '{robot.get('name')}': {len(links)} links, {len(joints)} joints")
    nfiles = 0
    for name, l in links.items():
        inert = l.find("inertial")
        if inert is None:
            fail(f"link {name}: no <inertial>")
        else:
            m = float(inert.find("mass").get("value"))
            if not m > 0:
                fail(f"link {name}: mass {m}")
        for el in l.findall("visual") + l.findall("collision"):
            mesh = el.find("geometry/mesh")
            if mesh is None:
                continue
            fn = mesh.get("filename")
            if fn.startswith("package://") or os.path.isabs(fn):
                fail(f"link {name}: mesh path {fn} is not relative")
                continue
            fp = os.path.join(base, fn)
            if not os.path.isfile(fp):
                fail(f"link {name}: mesh file {fn} does not exist")
                continue
            nfiles += 1
            if fn.lower().endswith(".obj"):
                with open(fp, "r", encoding="utf-8") as f:
                    nv = sum(1 for line in f if line.startswith("v "))
                if nv < 3:
                    fail(f"{fn}: no vertices")
            elif os.path.getsize(fp) < 84 + 50:
                fail(f"{fn}: STL has no triangles")
    print(f"  ok   {nfiles} mesh references checked")
    parent_of, kids, jmap = {}, {}, {}
    for j in joints:
        n, t = j.get("name"), j.get("type")
        p, c = j.find("parent").get("link"), j.find("child").get("link")
        if p not in links or c not in links:
            fail(f"joint {n}: unknown link {p} or {c}")
            continue
        if t not in ("fixed", "revolute", "continuous", "prismatic"):
            fail(f"joint {n}: type {t} is not supported by Isaac Sim's URDF importer")
        if t in ("revolute", "prismatic"):
            lim = j.find("limit")
            if lim is None or lim.get("lower") is None or lim.get("upper") is None:
                fail(f"joint {n}: {t} needs <limit lower upper>")
        if c in parent_of:
            fail(f"link {c} has two parents")
        parent_of[c] = p
        kids.setdefault(p, []).append(c)
        jmap[c] = j
    roots = [l for l in links if l not in parent_of]
    if len(roots) != 1:
        fail(f"expected one root link, found {roots}")
        return
    # forward kinematics at zero
    fk = {roots[0]: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]}
    stack = [roots[0]]
    while stack:
        p = stack.pop()
        for c in kids.get(p, []):
            o = jmap[c].find("origin")
            xyz = [float(x) for x in (o.get("xyz", "0 0 0") if o is not None else "0 0 0").split()]
            rpy = [float(x) for x in (o.get("rpy", "0 0 0") if o is not None else "0 0 0").split()]
            fk[c] = mat_mul(fk[p], rpy_to_mat(*rpy, xyz))
            stack.append(c)
    if len(fk) != len(links):
        fail(f"links not reachable from {roots[0]}: {sorted(set(links) - set(fk))}")
    else:
        print(f"  ok   tree rooted at {roots[0]}")
    report["urdf"] = {"links": list(links), "joints": [j.get("name") for j in joints], "root": roots[0]}
    if not usd:
        return
    # compare with the USD: poses relative to the root link, masses, inertia tensors
    ub = usd["bodies"]
    key = lambda n: f"{usd['root']}/{n}"
    if key(roots[0]) not in ub:
        fail("URDF root link is not a USD rigid body")
        return
    root_inv = inv_rigid(ub[key(roots[0])]["world"])
    worst_p, worst_a = 0.0, 0.0
    for n, T in fk.items():
        b = ub.get(key(n))
        if b is None:
            fail(f"URDF link {n} has no USD rigid body")
            continue
        dp_, da = mat_diff(T, mat_mul(root_inv, b["world"]))
        worst_p, worst_a = max(worst_p, dp_), max(worst_a, da)
        inert = links[n].find("inertial")
        m = float(inert.find("mass").get("value"))
        if abs(m - b["mass"]) > 1e-6 * max(1.0, m):
            fail(f"link {n}: URDF mass {m} != USD mass {b['mass']}")
        I = inert.find("inertia")
        ten = [[float(I.get("ixx")), float(I.get("ixy")), float(I.get("ixz"))],
               [float(I.get("ixy")), float(I.get("iyy")), float(I.get("iyz"))],
               [float(I.get("ixz")), float(I.get("iyz")), float(I.get("izz"))]]
        w, x, y, z = b["axes"]
        Rm = quat_to_mat(w, x, y, z)
        rec = [[sum(Rm[r][k] * b["diag"][k] * Rm[c][k] for k in range(3)) for c in range(3)] for r in range(3)]
        scale = max(abs(v) for row in ten for v in row) or 1.0
        err = max(abs(ten[r][c] - rec[r][c]) for r in range(3) for c in range(3)) / scale
        if err > 1e-4:
            fail(f"link {n}: URDF inertia and USD diagonalInertia/principalAxes differ (rel {err:.2e})")
    if worst_p > 1e-5 or worst_a > 1e-4:
        fail(f"URDF forward kinematics differ from the USD link poses by {worst_p:.3g} m / {worst_a:.3g} rad")
    else:
        print(f"  ok   URDF zero-pose FK matches the USD link poses (max {worst_p:.1e} m, {worst_a:.1e} rad); masses and inertia tensors match")


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    if not args:
        print(__doc__)
        return 2
    target = args[0]
    folder = target if os.path.isdir(target) else os.path.dirname(target)
    usda = os.path.join(folder, "robot.usda") if os.path.isdir(target) else target
    urdf = os.path.join(folder, "robot.urdf")
    usd = None
    if os.path.isfile(usda):
        usd = check_usd(usda)
    else:
        print("USD  (no robot.usda)")
    if os.path.isfile(urdf):
        check_urdf(urdf, usd)
    else:
        print("URDF (no robot.urdf)")
    if "--json" in argv:
        print(json.dumps({"problems": problems, **report}, default=str))
    print("CHECK OK" if not problems else f"CHECK FAIL: {len(problems)} problem(s)")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

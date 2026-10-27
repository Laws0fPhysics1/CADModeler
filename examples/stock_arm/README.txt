stock_arm: robot package exported by CAD Modeler (2026-10-08)

Units: metres, kilograms, seconds; revolute joints in radians (URDF) / degrees (USD limits and drives); Z up.
Links: 5   Joints: 4 (2 movable)   Base: fixed to the world
The package is in the ZERO configuration (every joint value 0). Link frames sit on the joint frames.

FILES
  robot.usda   USD stage: UsdPhysics articulation, meshes embedded, Z up, metersPerUnit = 1, kilogramsPerUnit = 1
  robot.urdf   URDF with relative mesh paths (meshes/*.obj, in metres, in each link's frame)

LINKS
  Base_Plate               0.4389 kg
  Yaw_Motor                0.1927 kg
  Upper_Arm                0.08684 kg
  Forearm                  0.06755 kg
  Wrist_Servo              0.03122 kg

JOINTS
  Motor_Mount              fixed       Base_Plate -> Yaw_Motor
  Base_Yaw                 continuous  Yaw_Motor -> Upper_Arm
  Shoulder                 revolute    Upper_Arm -> Forearm  limits -2.094 .. 2.094 rad
  Wrist_Mount              fixed       Forearm -> Wrist_Servo

ISAAC SIM: OPEN THE USD
  File > Open > robot.usda (or drag it into an open stage to add it as a reference), then press Play.
  The base is held by the fixed joint /stock_arm/joints/root_joint (body0 = world).
  The default prim carries PhysicsArticulationRootAPI; there is no PhysicsScene unless you ticked that option,
  so add one (Create > Physics > Physics Scene) when you open the file on its own.

ISAAC SIM: IMPORT THE URDF
  File > Import > robot.urdf (Isaac Sim 4.5+), or Isaac Utils > Workflows > URDF Importer in older versions.
  Tick "Fix Base Link" for a fixed base: on. Leave "Merge Fixed Joints" off to keep the link names.
  URDF has no drive gains: set the joint drive stiffness / damping in the importer.
  Python (Isaac Sim 4.5: isaacsim.asset.importer.urdf; 4.0-4.2: omni.importer.urdf):
    import omni.kit.commands
    _, cfg = omni.kit.commands.execute("URDFCreateImportConfig")
    cfg.fix_base = True; cfg.merge_fixed_joints = False; cfg.make_default_prim = True
    omni.kit.commands.execute("URDFParseAndImportFile", urdf_path="/path/to/robot.urdf", import_config=cfg)

ISAAC LAB (2.x; older releases use omni.isaac.lab instead of isaaclab)
  import isaaclab.sim as sim_utils
  from isaaclab.assets import ArticulationCfg
  from isaaclab.actuators import ImplicitActuatorCfg

  STOCK_ARM_CFG = ArticulationCfg(
      prim_path="{ENV_REGEX_NS}/Robot",
      spawn=sim_utils.UsdFileCfg(
          usd_path="/path/to/robot.usda",
          articulation_props=sim_utils.ArticulationRootPropertiesCfg(enabled_self_collisions=False),
      ),
      init_state=ArticulationCfg.InitialStateCfg(pos=(0.0, 0.0, 0.0), joint_pos={"Base_Yaw": -0.3491, "Shoulder": 0.6981}),
      actuators={
          "revolute": ImplicitActuatorCfg(joint_names_expr=["Base_Yaw", "Shoulder"], stiffness=100, damping=10),
      },
  )
  joint_pos above holds the joint values the design was posed at (rad / m).
  The USD already fixes the base with root_joint. If your cloned environments drift to the world origin, delete root_joint
  and pass articulation_props=sim_utils.ArticulationRootPropertiesCfg(fix_root_link=True) instead.
  Isaac Lab actuator gains are per radian (revolute) or per metre (prismatic); the USD drive values were converted to per degree.

Isaac Sim was not available when this exporter was written; the USD was validated with Pixar's usd-core (pxr) and
UsdPhysics' own parser, and the URDF with a structural check. See docs/robot-export.md in CAD Modeler.

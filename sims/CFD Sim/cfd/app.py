"""CFD Sim desktop app: open a model, pick a scenario and quality, run on the GPU, play back."""
from __future__ import annotations

import os
import sys
import threading
import time
import traceback

import numpy as np

os.environ.setdefault("QT_API", "pyside6")
from PySide6 import QtCore, QtGui, QtWidgets
from PySide6.QtCore import Qt, Signal, QThread, QTimer

import pyvista as pv
from pyvistaqt import QtInteractor

import matplotlib
matplotlib.use("QtAgg")
from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg
from matplotlib.figure import Figure

from .geometry import load_model, prepare_mesh, SimMesh, AXES, Model
from .solver import CaseParams, plan_case, run_case, FLUIDS
from .viz import Run
from .ui_theme import (apply_theme, section, muted, hline, row, Collapsible, StatCard,
                       ACCENT, MUTED, TEXT, CARD, LINE, PANEL)
from .ui_hero import HeroScreen

pv.global_theme.allow_empty_mesh = True
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUNS = os.path.join(ROOT, "runs")

# ---------------------------------------------------------------------------------------------
# Presets
# ---------------------------------------------------------------------------------------------
PRESETS = {
    "Car / ground vehicle": dict(speed=30.0, fluid="Air (20°C)", ground=True, moving=True, gap=0.15,
                                 pads=(2.0, 4.0, 1.5, 1.5), iso=(2.0, 8.0)),
    "Aircraft / wing": dict(speed=60.0, fluid="Air (20°C)", ground=False, moving=False, gap=0.0, pads=(1.5, 3.0, 1.2, 1.2),
                            iso=(15.0, 60.0)),
    "Building / structure": dict(speed=15.0, fluid="Air (20°C)", ground=True, moving=False, gap=0.0, pads=(2.0, 5.0, 2.0, 2.0), iso=(2.0, 8.0)),
    "Drone / small object": dict(speed=12.0, fluid="Air (20°C)", ground=False, moving=False, gap=0.0, pads=(2.0, 4.0, 1.5, 1.5), iso=(4.0, 16.0)),
    "Underwater": dict(speed=3.0, fluid="Water (20°C)", ground=False, moving=False, gap=0.0, pads=(2.0, 4.0, 1.5, 1.5), iso=(2.0, 8.0)),
    "Custom": None,
}
QUALITY = {  # target cells, frames, u_lb
    "Draft  ·  ~8 M cells": (8e6, 60, 0.05),
    "Standard  ·  ~25 M cells": (25e6, 120, 0.05),
    "High  ·  ~60 M cells": (60e6, 160, 0.05),
    "Ultra  ·  ~110 M cells": (110e6, 200, 0.05),
    "Max  ·  ~150 M cells": (150e6, 200, 0.05),
    "Custom": None,
}
DURATION = {"Quick look  ·  2 flow-throughs": 2.0, "Standard  ·  3 flow-throughs": 3.0,
            "Developed  ·  4 flow-throughs": 4.0, "Long  ·  6 flow-throughs": 6.0}
LOOKS = ["Cinematic  ·  vortex surface", "Engineering  ·  slice + streamlines", "Vortex + slice",
         "Volume  ·  vorticity", "Surface pressure", "Custom"]
FIELDS = {"Speed": "speed", "Pressure": "p", "Vorticity": "vort", "Q-criterion": "Q", "u": "ux", "v": "uy", "w": "uz"}
UNITS = {"metres": 1.0, "decimetres": 0.1, "centimetres": 0.01, "millimetres": 0.001, "inches": 0.0254, "feet": 0.3048,
         "custom scale": None}
DIMS = ["Length  (along flow)", "Width  (span)", "Height"]
DIM_COLORS = ["#ff6b6b", "#7bdc7b", "#6fb4ff"]


# ---------------------------------------------------------------------------------------------
# Worker thread
# ---------------------------------------------------------------------------------------------
class SimWorker(QThread):
    progress = Signal(int, int, float, float, float, float, float)
    frame = Signal(int, str)
    log = Signal(str)
    done = Signal(str)
    failed = Signal(str)

    def __init__(self, sm: SimMesh, params: CaseParams, prefer_gpu: bool, display: dict | None = None):
        super().__init__()
        self.sm, self.params, self.prefer_gpu, self.display = sm, params, prefer_gpu, display
        self._stop = False

    def stop(self):
        self._stop = True

    def run(self):
        try:
            folder = run_case(self.sm, self.params, RUNS,
                              progress=lambda *a: self.progress.emit(*a),
                              frame_cb=lambda i, f: self.frame.emit(i, f),
                              should_stop=lambda: self._stop, prefer_gpu=self.prefer_gpu,
                              log=lambda s: self.log.emit(str(s)), display=self.display)
            self.done.emit(folder)
        except Exception:
            self.failed.emit(traceback.format_exc())


# ---------------------------------------------------------------------------------------------
# Widgets
# ---------------------------------------------------------------------------------------------
def dspin(lo, hi, val, step, dec=2, suffix=""):
    w = QtWidgets.QDoubleSpinBox(); w.setDecimals(dec); w.setRange(lo, hi); w.setValue(val); w.setSingleStep(step)
    if suffix:
        w.setSuffix(suffix)
    return w


def ispin(lo, hi, val, step=1, suffix=""):
    w = QtWidgets.QSpinBox(); w.setRange(lo, hi); w.setValue(val); w.setSingleStep(step)
    if suffix:
        w.setSuffix(suffix)
    return w


def combo(items, current=None):
    c = QtWidgets.QComboBox(); c.addItems(list(items))
    c.setSizeAdjustPolicy(QtWidgets.QComboBox.AdjustToMinimumContentsLengthWithIcon); c.setMinimumContentsLength(6)
    if current is not None:
        c.setCurrentText(current)
    return c


def toggle(text, checked=False):
    c = QtWidgets.QCheckBox(text); c.setChecked(checked); c.setCursor(Qt.PointingHandCursor)
    return c


def hline_v():
    f = QtWidgets.QFrame(); f.setFixedWidth(1); f.setStyleSheet(f"background: {LINE};")
    return f


class ForcePlot(FigureCanvasQTAgg):
    def __init__(self):
        self.fig = Figure(figsize=(4, 2.0), tight_layout=True)
        super().__init__(self.fig)
        self.fig.patch.set_facecolor(PANEL)
        self.ax = self.fig.add_subplot(111)
        self._style()
        self.setMinimumHeight(170)

    def _style(self):
        ax = self.ax
        ax.set_facecolor(PANEL)
        for s in ax.spines.values():
            s.set_color(LINE)
        ax.spines["top"].set_visible(False); ax.spines["right"].set_visible(False)
        ax.tick_params(colors=MUTED, labelsize=8, length=0)
        ax.grid(True, color=LINE, lw=0.5)

    def update_forces(self, data, t_now=None):
        ax = self.ax
        ax.clear(); self._style()
        if data is not None and data.size > 2:
            k = max(1, len(data) // 60)   # light rolling mean so turbulent chatter does not hide the trend
            sm = lambda a: np.convolve(a, np.ones(k) / k, mode="same") if k > 1 else a
            for key, col, lw in (("Cd", ACCENT, 1.3), ("Cl", "#ff8a3d", 1.1), ("Cs", "#b388ff", 0.9)):
                ax.plot(data["t"], data[key], color=col, lw=0.6, alpha=0.25)
                ax.plot(data["t"], sm(data[key]), color=col, lw=lw, label=key)
            n = max(1, len(data) // 5)
            ax.set_title(f"Cd {np.mean(data['Cd'][-n:]):.3f}    Cl {np.mean(data['Cl'][-n:]):.3f}    Cs {np.mean(data['Cs'][-n:]):.3f}",
                         color=TEXT, fontsize=9, loc="left")
            lo, hi = np.percentile(np.concatenate([data["Cd"], data["Cl"]]), [1, 99])
            pad = 0.2 * max(hi - lo, 0.1)
            ax.set_ylim(lo - pad, hi + pad)
            ax.legend(fontsize=7, loc="upper right", frameon=False, labelcolor=MUTED)
            if t_now is not None:
                ax.axvline(t_now, color=TEXT, lw=0.8, alpha=0.5)
        self.draw_idle()


# ---------------------------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------------------------
class MainWindow(QtWidgets.QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("CFD Sim")
        self.resize(1600, 960)
        self.model: Model | None = None
        self.scale = 1.0              # metres per model unit
        self.dim_axis = 0             # which bounding-box edge the dimension input refers to
        self._gltf_actors = []
        self.sm: SimMesh | None = None
        self.run: Run | None = None
        self.worker: SimWorker | None = None
        self.frame_idx = 0
        self.playing = False
        self.reset_camera_pending = False
        self._syncing = False
        self._actors = {}
        self.cad_link = None          # cadlink.GuiLink when opened from a CAD Modeler case
        self.timer = QTimer(self); self.timer.timeout.connect(self._tick)
        self._build_ui()
        self._apply_preset(); self._update_estimate()

    # ------------------------------------------------------------------ layout
    def _build_ui(self):
        root = QtWidgets.QWidget(); root.setObjectName("root"); self.setCentralWidget(root)
        h = QtWidgets.QHBoxLayout(root); h.setContentsMargins(0, 0, 0, 0); h.setSpacing(0)

        h.addWidget(self._build_sidebar())
        h.addWidget(hline_v())

        # centre: hero or viewer
        self.stack = QtWidgets.QStackedWidget()
        self.hero = HeroScreen(RUNS)
        self.hero.open_model.connect(self.load_model); self.hero.open_run.connect(self.load_run)
        self.hero.browse_run.connect(self.open_run)
        self.stack.addWidget(self.hero)

        viewer = QtWidgets.QWidget(); vv = QtWidgets.QVBoxLayout(viewer); vv.setContentsMargins(0, 0, 0, 0); vv.setSpacing(0)
        self.plotter = QtInteractor(viewer, lighting="none")
        self.plotter.set_background("#0b0d12", top="#1a2030")
        self._setup_lights()
        vv.addWidget(self.plotter.interactor, 1)
        vv.addWidget(self._build_playback_bar())
        self.stack.addWidget(viewer)
        h.addWidget(self.stack, 1)

        h.addWidget(hline_v())
        h.addWidget(self._build_view_panel())

    def _build_sidebar(self):
        side = QtWidgets.QWidget(); side.setObjectName("sidebar"); side.setFixedWidth(340)
        outer = QtWidgets.QVBoxLayout(side); outer.setContentsMargins(0, 0, 0, 0); outer.setSpacing(0)

        head = QtWidgets.QHBoxLayout(); head.setContentsMargins(18, 14, 12, 8)
        t = QtWidgets.QLabel("CFD Sim"); t.setObjectName("title"); head.addWidget(t); head.addStretch(1)
        home = QtWidgets.QPushButton("⌂"); home.setObjectName("icon"); home.setToolTip("Home"); home.clicked.connect(self.go_home)
        head.addWidget(home)
        outer.addLayout(head)

        scroll = QtWidgets.QScrollArea(); scroll.setWidgetResizable(True); scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        w = QtWidgets.QWidget(); scroll.setWidget(w); w.setMaximumWidth(340)
        lay = QtWidgets.QVBoxLayout(w); lay.setContentsMargins(18, 4, 18, 18); lay.setSpacing(8)

        # MODEL
        lay.addWidget(section("Model"))
        self.btn_load = QtWidgets.QPushButton("Open model…"); self.btn_load.setObjectName("ghost"); self.btn_load.clicked.connect(self.load_model)
        lay.addWidget(self.btn_load)
        self.lbl_mesh = muted("No model loaded"); lay.addWidget(self.lbl_mesh)
        self.cb_flow = row("Faces the flow", combo(AXES, "+X"), lay)
        self.cb_up = row("Up axis", combo(AXES, "+Z"), lay)
        self.cb_units = row("Model units", combo(UNITS, "metres"), lay)
        self.lbl_dims = muted("—"); lay.addWidget(self.lbl_dims)
        self.cb_dim = combo(DIMS, DIMS[0])
        self.sp_dim = dspin(0.001, 100000, 1.0, 0.1, 3, " m"); self.sp_dim.setKeyboardTracking(False)
        hd = QtWidgets.QHBoxLayout(); hd.setSpacing(6); hd.addWidget(self.cb_dim, 3); hd.addWidget(self.sp_dim, 2)
        lay.addLayout(hd)
        lay.addWidget(muted("Click a box edge in the view (or pick one above), type its real length, press Enter — "
                            "the other two dimensions follow."))
        self.parts_box = Collapsible("Parts"); lay.addWidget(self.parts_box)
        self.parts_box.setVisible(False); self.part_checks = {}
        self.ck_sym = toggle("Half model (mirror symmetry, 2× cheaper)"); lay.addWidget(self.ck_sym)

        # SCENARIO
        lay.addSpacing(6); lay.addWidget(section("Scenario"))
        self.cb_preset = row("Preset", combo(PRESETS, "Car / ground vehicle"), lay)
        self.sp_speed = row("Speed", dspin(0.001, 500, 30.0, 1.0, 1, " m/s"), lay)
        self.cb_fluid = row("Fluid", combo(FLUIDS, "Air (20°C)"), lay)
        self.ck_ground = toggle("Ground plane", True); lay.addWidget(self.ck_ground)
        self.sp_gap = row("Clearance", dspin(0, 100, 0.15, 0.01, 3, " m"), lay)
        self.ck_moving = toggle("Moving ground (vehicle belt)", True); lay.addWidget(self.ck_moving)
        self.sp_aoa = row("Angle of attack", dspin(-90, 90, 0.0, 1.0, 1, " °"), lay)

        # QUALITY
        lay.addSpacing(6); lay.addWidget(section("Quality"))
        self.cb_quality = row("Quality", combo(QUALITY, "Standard  ·  ~25 M cells"), lay)
        self.cb_duration = row("Duration", combo(DURATION, "Standard  ·  3 flow-throughs"), lay)
        self.stats = StatCard([("cells", "cells"), ("mem", "GPU memory"), ("eta", "est. time"),
                               ("re", "Reynolds"), ("dx", "cell size"), ("frames", "frames")])
        lay.addWidget(self.stats)

        # ADVANCED
        adv = Collapsible("Advanced"); lay.addWidget(adv); a = adv.layout_
        self.sp_res = row("Cells across", ispin(8, 2000, 80, 10), a)
        self.sp_frames = row("Frames", ispin(1, 5000, 120, 10), a)
        self.sp_ft = row("Flow-throughs", dspin(0.2, 100, 3.0, 0.5, 1), a)
        self.sp_pad_up = row("Pad upstream", dspin(0.2, 20, 2.0, 0.5, 1, " L"), a)
        self.sp_pad_down = row("Pad downstream", dspin(0.2, 40, 4.0, 0.5, 1, " L"), a)
        self.sp_pad_side = row("Pad sides", dspin(0.2, 20, 1.5, 0.5, 1, " L"), a)
        self.sp_pad_top = row("Pad top", dspin(0.2, 20, 1.5, 0.5, 1, " L"), a)
        self.sp_yaw = row("Yaw", dspin(-180, 180, 0.0, 1.0, 1, " °"), a)
        self.sp_nu = QtWidgets.QDoubleSpinBox(); self.sp_nu.setDecimals(9); self.sp_nu.setRange(1e-9, 10); self.sp_nu.setValue(1.5e-5); self.sp_nu.setSingleStep(1e-6)
        row("ν [m²/s]", self.sp_nu, a)
        self.sp_rho = row("ρ", dspin(1e-3, 1e5, 1.204, 0.1, 3, " kg/m³"), a)
        self.sp_ulb = row("Lattice speed", dspin(0.005, 0.15, 0.05, 0.01, 3), a)
        self.ck_les = toggle("Smagorinsky LES", True); a.addWidget(self.ck_les)
        self.sp_cs = row("Cs", dspin(0.0, 0.5, 0.1, 0.01, 3), a)
        self.sp_taumin = row("τ floor", dspin(0.5, 0.6, 0.502, 0.001, 4), a)
        self.sp_sponge = row("Sponge", dspin(0.0, 5, 0.5, 0.1, 2, " L"), a)
        self.sp_pb = row("Playback cells", dspin(0.1, 100, 3.0, 0.5, 1, " M"), a)
        self.ck_iso = toggle("Vortex surface output", True); a.addWidget(self.ck_iso)
        self.sp_iso_level = row("Q level (large)", dspin(0.05, 200, 2.0, 0.5, 2, " (U/L)²"), a)
        self.sp_iso_fine = row("Q level (fine)", dspin(0.0, 500, 8.0, 1.0, 2, " (U/L)²"), a)
        self.ck_refine = toggle("Adaptive grid (nested blocks around body + wake)", True); a.addWidget(self.ck_refine)
        self.cb_levels = row("Grid levels", combo(["2  ·  body block", "3  ·  + near wake", "4  ·  + far wake"], "4  ·  + far wake"), a)
        self.sp_ref_up = row("Body block up", dspin(0.05, 5, 0.15, 0.05, 2, " L"), a)
        self.sp_ref_down = row("Body block down", dspin(0.1, 10, 0.6, 0.1, 2, " L"), a)
        self.sp_ref_side = row("Body block sides", dspin(0.05, 5, 0.15, 0.05, 2, " L"), a)
        self.sp_ref_top = row("Body block top", dspin(0.05, 5, 0.2, 0.05, 2, " L"), a)
        self.sp_near_down = row("Near wake down", dspin(0.2, 10, 2.0, 0.1, 2, " L"), a)
        self.sp_near_side = row("Near wake sides", dspin(0.1, 5, 0.5, 0.1, 2, " L"), a)
        self.sp_wake_down = row("Far wake down", dspin(0.5, 20, 4.0, 0.5, 1, " L"), a)
        self.sp_wake_side = row("Far wake sides", dspin(0.2, 10, 1.0, 0.1, 2, " L"), a)
        self.ck_vort = toggle("Vorticity volume output", True); a.addWidget(self.ck_vort)
        self.ck_gpu = toggle("CUDA GPU", True); a.addWidget(self.ck_gpu)
        self.ed_name = row("Run name", QtWidgets.QLineEdit("run"), a)

        # RUN
        lay.addSpacing(10)
        self.btn_run = QtWidgets.QPushButton("Run simulation"); self.btn_run.setObjectName("primary"); self.btn_run.setCursor(Qt.PointingHandCursor)
        self.btn_run.clicked.connect(self.start_run); lay.addWidget(self.btn_run)
        self.btn_stop = QtWidgets.QPushButton("Stop after this frame"); self.btn_stop.setObjectName("danger"); self.btn_stop.clicked.connect(self.stop_run)
        self.btn_stop.setVisible(False); lay.addWidget(self.btn_stop)
        self.progress = QtWidgets.QProgressBar(); self.progress.setFixedHeight(4); self.progress.setTextVisible(False); lay.addWidget(self.progress)
        self.lbl_status = muted(""); lay.addWidget(self.lbl_status)

        logc = Collapsible("Log"); lay.addWidget(logc)
        self.log = QtWidgets.QPlainTextEdit(); self.log.setReadOnly(True); self.log.setMaximumBlockCount(500); self.log.setMinimumHeight(140)
        logc.layout_.addWidget(self.log)
        lay.addStretch(1)
        outer.addWidget(scroll, 1)

        # wiring
        self.cb_preset.currentIndexChanged.connect(self._apply_preset)
        self.cb_quality.currentIndexChanged.connect(self._apply_quality)
        self.cb_duration.currentIndexChanged.connect(self._apply_duration)
        self.cb_fluid.currentIndexChanged.connect(self._fluid_changed)
        self.ck_ground.toggled.connect(self._ground_changed)
        self.ck_sym.toggled.connect(lambda *_: (self._apply_quality(), self._update_estimate()))
        self.cb_units.currentIndexChanged.connect(self._units_changed)
        self.cb_dim.currentIndexChanged.connect(self._dim_axis_changed)
        self.sp_dim.editingFinished.connect(self._dim_entered)
        for wdg in (self.sp_speed, self.sp_nu, self.sp_rho, self.sp_res, self.sp_pad_up, self.sp_pad_down,
                    self.sp_pad_side, self.sp_pad_top, self.sp_ft, self.sp_frames, self.sp_pb, self.sp_ulb, self.sp_gap,
                    self.sp_taumin, self.sp_yaw, self.sp_aoa):
            wdg.valueChanged.connect(self._update_estimate)
        for wdg in (self.cb_flow, self.cb_up):
            wdg.currentIndexChanged.connect(self._update_estimate)
        for wdg in (self.sp_speed, self.sp_gap):
            wdg.valueChanged.connect(self._mark_custom_preset)
        for wdg in (self.ck_ground, self.ck_moving):
            wdg.toggled.connect(self._mark_custom_preset)
        self.cb_fluid.currentIndexChanged.connect(self._mark_custom_preset)
        for wdg in (self.sp_res, self.sp_frames, self.sp_ulb):
            wdg.valueChanged.connect(self._mark_custom_quality)
        self.ck_refine.toggled.connect(lambda *_: (self._apply_quality(), self._update_estimate()))
        self.cb_levels.currentIndexChanged.connect(lambda *_: (self._apply_quality(), self._update_estimate()))
        for wdg in (self.sp_ref_up, self.sp_ref_down, self.sp_ref_side, self.sp_ref_top, self.sp_wake_down, self.sp_wake_side,
                    self.sp_near_down, self.sp_near_side):
            wdg.valueChanged.connect(self._update_estimate)
        self._fluid_changed(); self._ground_changed()
        return side

    def _build_view_panel(self):
        panel = QtWidgets.QWidget(); panel.setObjectName("viewpanel"); panel.setFixedWidth(300)
        outer = QtWidgets.QVBoxLayout(panel); outer.setContentsMargins(0, 0, 0, 0); outer.setSpacing(0)
        scroll = QtWidgets.QScrollArea(); scroll.setWidgetResizable(True); scroll.setFrameShape(QtWidgets.QFrame.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        w = QtWidgets.QWidget(); scroll.setWidget(w); w.setMaximumWidth(300)
        lay = QtWidgets.QVBoxLayout(w); lay.setContentsMargins(18, 18, 18, 18); lay.setSpacing(8)

        lay.addWidget(section("View"))
        self.cb_look = row("Look", combo(LOOKS, LOOKS[0]), lay)
        self.cb_detail = row("Detail", combo(["Large structures", "Fine structures"]), lay)
        self.cb_field = row("Field", combo(FIELDS, "Speed"), lay)
        self.cb_cmap = row("Colours", combo(["turbo", "viridis", "plasma", "inferno", "coolwarm", "magma"]), lay)
        self.cb_slice_axis = row("Slice", combo(["Side (Y)", "Top (Z)", "Front (X)"]), lay)
        self.sl_slice = QtWidgets.QSlider(Qt.Horizontal); self.sl_slice.setRange(0, 1000); self.sl_slice.setValue(500)
        row("Position", self.sl_slice, lay)

        more = Collapsible("More"); lay.addWidget(more); m = more.layout_
        self.ck_slice = toggle("Slice plane"); m.addWidget(self.ck_slice)
        self.ck_slice2 = toggle("Second slice (top view)"); m.addWidget(self.ck_slice2)
        self.ck_stream = toggle("Streamlines"); m.addWidget(self.ck_stream)
        self.ck_tubes = toggle("  as tubes", True); m.addWidget(self.ck_tubes)
        self.ck_seed_slice = toggle("  seed in slice plane", True); m.addWidget(self.ck_seed_slice)
        self.sp_nstream = row("Seeds", ispin(10, 2000, 150, 10), m)
        self.ck_q = toggle("Vortex surface", True); m.addWidget(self.ck_q)
        self.cb_q_src = row("  source", combo(["Precomputed (full res)", "Playback grid"]), m)
        self.sl_q = QtWidgets.QSlider(Qt.Horizontal); self.sl_q.setRange(0, 100); self.sl_q.setValue(60)
        row("  level (grid)", self.sl_q, m)
        self.sp_q_opacity = row("  opacity", dspin(0.05, 1.0, 1.0, 0.05, 2), m)
        self.cb_q_color = row("  colour by", combo(["speed", "height", "plain"]), m)
        self.ck_vol = toggle("Vorticity volume"); m.addWidget(self.ck_vol)
        self.sp_vol_opacity = row("  density", dspin(0.05, 3.0, 0.6, 0.05, 2), m)
        self.ck_cp = toggle("Surface pressure on body"); m.addWidget(self.ck_cp)
        self.ck_wire = toggle("Domain outline"); m.addWidget(self.ck_wire)
        self.ck_full = toggle("Full-res final frame"); m.addWidget(self.ck_full)
        self.sp_speed_max = row("Speed scale", dspin(0.1, 10, 1.6, 0.1, 2, " × U"), m)
        m.addWidget(hline())
        self.ck_pbr = toggle("Physically based shading", True); m.addWidget(self.ck_pbr)
        self.ck_ssao = toggle("Ambient occlusion", True); m.addWidget(self.ck_ssao)
        self.ck_shadows = toggle("Shadows", True); m.addWidget(self.ck_shadows)
        self.ck_fxaa = toggle("Anti-aliasing", True); m.addWidget(self.ck_fxaa)
        self.sp_rough = row("Roughness", dspin(0.05, 1.0, 0.45, 0.05, 2), m)

        lay.addSpacing(4)
        cam = QtWidgets.QHBoxLayout(); cam.setSpacing(6)
        for text, tip, fn in (("⟲", "Reset camera", self.reset_camera), ("◈", "Cinematic camera", self.cinematic_camera),
                              ("📷", "Screenshot", self.screenshot), ("🎬", "Export video", self.export_video)):
            b = QtWidgets.QPushButton(text); b.setObjectName("icon"); b.setToolTip(tip); b.clicked.connect(fn); cam.addWidget(b)
        cam.addStretch(1); lay.addLayout(cam)

        lay.addSpacing(6); lay.addWidget(section("Forces"))
        self.force_plot = ForcePlot(); lay.addWidget(self.force_plot)
        lay.addStretch(1)
        outer.addWidget(scroll, 1)

        self.cb_look.currentIndexChanged.connect(self._apply_look)
        for wdg in (self.ck_slice, self.ck_slice2, self.ck_stream, self.ck_tubes, self.ck_seed_slice, self.ck_q, self.ck_vol,
                    self.ck_cp, self.ck_wire, self.ck_full, self.ck_pbr):
            wdg.toggled.connect(self._view_changed)
        for wdg in (self.cb_detail, self.cb_field, self.cb_cmap, self.cb_slice_axis, self.cb_q_src, self.cb_q_color):
            wdg.currentIndexChanged.connect(self.refresh_view)
        for wdg in (self.sl_slice, self.sl_q):
            wdg.valueChanged.connect(self.refresh_view)
        for wdg in (self.sp_nstream, self.sp_q_opacity, self.sp_vol_opacity, self.sp_speed_max, self.sp_rough):
            wdg.valueChanged.connect(self.refresh_view)
        for wdg in (self.ck_ssao, self.ck_fxaa, self.ck_shadows):
            wdg.toggled.connect(self._apply_render_quality)
        self._apply_look()
        return panel

    def _build_playback_bar(self):
        bar = QtWidgets.QWidget(); bar.setStyleSheet(f"background: {PANEL};"); bar.setFixedHeight(44)
        h = QtWidgets.QHBoxLayout(bar); h.setContentsMargins(12, 4, 12, 4); h.setSpacing(6)
        b = QtWidgets.QPushButton("⏮"); b.setObjectName("icon"); b.clicked.connect(lambda: self.goto_frame(0)); h.addWidget(b)
        self.btn_play = QtWidgets.QPushButton("▶"); self.btn_play.setObjectName("icon"); self.btn_play.clicked.connect(self.toggle_play); h.addWidget(self.btn_play)
        b = QtWidgets.QPushButton("⏭"); b.setObjectName("icon"); b.clicked.connect(lambda: self.goto_frame(10 ** 9)); h.addWidget(b)
        self.sl_frame = QtWidgets.QSlider(Qt.Horizontal); self.sl_frame.setRange(0, 0); self.sl_frame.valueChanged.connect(self._slider_moved)
        h.addWidget(self.sl_frame, 1)
        self.lbl_time = QtWidgets.QLabel("—"); self.lbl_time.setObjectName("muted"); self.lbl_time.setMinimumWidth(190); h.addWidget(self.lbl_time)
        self.cb_fps = combo(["6 fps", "12 fps", "24 fps", "30 fps"], "12 fps"); self.cb_fps.setFixedWidth(84); h.addWidget(self.cb_fps)
        self.ck_loop = toggle("Loop", True); h.addWidget(self.ck_loop)
        self.ck_live = toggle("Live", True); h.addWidget(self.ck_live)
        return bar

    # ------------------------------------------------------------------ presets / estimate
    def _apply_preset(self, *_):
        p = PRESETS.get(self.cb_preset.currentText())
        if p is None:
            return
        self._syncing = True
        self.sp_speed.setValue(p["speed"]); self.cb_fluid.setCurrentText(p["fluid"])
        self.ck_ground.setChecked(p["ground"]); self.ck_moving.setChecked(p["moving"]); self.sp_gap.setValue(p["gap"])
        for w, v in zip((self.sp_pad_up, self.sp_pad_down, self.sp_pad_side, self.sp_pad_top), p["pads"]):
            w.setValue(v)
        self.sp_iso_level.setValue(p["iso"][0]); self.sp_iso_fine.setValue(p["iso"][1])
        self._syncing = False
        self._apply_quality()
        self._update_estimate()

    def _mark_custom_preset(self, *_):
        if not self._syncing:
            self.cb_preset.blockSignals(True); self.cb_preset.setCurrentText("Custom"); self.cb_preset.blockSignals(False)

    def _mark_custom_quality(self, *_):
        if not self._syncing:
            self.cb_quality.blockSignals(True); self.cb_quality.setCurrentText("Custom"); self.cb_quality.blockSignals(False)

    def _apply_quality(self, *_):
        q = QUALITY.get(self.cb_quality.currentText())
        if q is None or self.sm is None:
            return
        target, frames, ulb = q
        base = plan_case(self.sm, self._params_with(resolution=100, max_blockage=0.0))   # widening is coarse-grid only
        res = int(round(100 * (target / base.cells_total) ** (1 / 3) / 5.0) * 5)
        self._syncing = True
        self.sp_res.setValue(int(np.clip(res, 20, 400))); self.sp_frames.setValue(frames); self.sp_ulb.setValue(ulb)
        self._syncing = False
        self._update_estimate()

    def _apply_duration(self, *_):
        self.sp_ft.setValue(DURATION[self.cb_duration.currentText()])

    def _fluid_changed(self, *_):
        custom = self.cb_fluid.currentText() == "Custom"
        self.sp_nu.setEnabled(custom); self.sp_rho.setEnabled(custom)
        if not custom:
            nu, rho = FLUIDS[self.cb_fluid.currentText()]
            self.sp_nu.setValue(nu); self.sp_rho.setValue(rho)
        self._update_estimate()

    def _ground_changed(self, *_):
        on = self.ck_ground.isChecked()
        self.sp_gap.setEnabled(on); self.ck_moving.setEnabled(on)
        self._update_estimate()

    def _params_with(self, **over) -> CaseParams:
        p = self.params()
        for k, v in over.items():
            setattr(p, k, v)
        return p

    def params(self) -> CaseParams:
        return CaseParams(
            speed=self.sp_speed.value(), fluid=self.cb_fluid.currentText(), nu=self.sp_nu.value(), rho=self.sp_rho.value(),
            resolution=self.sp_res.value(), pad_up=self.sp_pad_up.value(), pad_down=self.sp_pad_down.value(),
            pad_side=self.sp_pad_side.value(), pad_top=self.sp_pad_top.value(), ground=self.ck_ground.isChecked(),
            ground_gap=self.sp_gap.value(), moving_ground=self.ck_moving.isChecked(), u_lb=self.sp_ulb.value(),
            les=self.ck_les.isChecked(), cs=self.sp_cs.value(), flow_throughs=self.sp_ft.value(),
            n_frames=self.sp_frames.value(), playback_cells=int(self.sp_pb.value() * 1e6), sponge=self.sp_sponge.value(),
            tau_min=self.sp_taumin.value(), iso=self.ck_iso.isChecked(), iso_level=self.sp_iso_level.value(),
            iso_level_fine=self.sp_iso_fine.value(), store_vorticity=self.ck_vort.isChecked(),
            refine=self.ck_refine.isChecked(), refine_up=self.sp_ref_up.value(), refine_down=self.sp_ref_down.value(),
            refine_side=self.sp_ref_side.value(), refine_top=self.sp_ref_top.value(),
            levels=self.cb_levels.currentIndex() + 2, wake_down=self.sp_wake_down.value(), wake_side=self.sp_wake_side.value(),
            wake_top=self.sp_wake_side.value(), near_down=self.sp_near_down.value(), near_side=self.sp_near_side.value(),
            near_top=self.sp_near_side.value(), symmetry=self.ck_sym.isChecked(),
            name=self.ed_name.text().strip() or "run")

    def _prepare_sm(self):
        if self.model is None:
            return None
        return prepare_mesh(self.model.mesh, self.cb_flow.currentText(), self.cb_up.currentText(),
                            source=self.model.path, yaw_deg=self.sp_yaw.value(), scale=self.scale,
                            pitch_deg=self.sp_aoa.value())

    # ---- scale / dimension tool
    def _units_changed(self, *_):
        u = UNITS[self.cb_units.currentText()]
        if u is not None:
            self.scale = u
            self._update_estimate()

    def _dim_axis_changed(self, *_):
        self.dim_axis = self.cb_dim.currentIndex()
        if self.sm is not None:
            self.sp_dim.blockSignals(True); self.sp_dim.setValue(float(self.sm.extent[self.dim_axis])); self.sp_dim.blockSignals(False)
        self._draw_setup_preview_dims()

    def _dim_entered(self):
        """User typed a known real-world length for the selected bounding-box edge."""
        if self.sm is None:
            return
        cur = float(self.sm.extent[self.dim_axis])
        want = float(self.sp_dim.value())
        if cur <= 0 or abs(want - cur) < 1e-9:
            return
        self.scale *= want / cur
        self.cb_units.blockSignals(True); self.cb_units.setCurrentText("custom scale"); self.cb_units.blockSignals(False)
        self._update_estimate()

    def _on_pick(self, actor):
        """Mesh-pick callback in the setup preview: clicking a box edge selects that dimension."""
        try:
            name = getattr(actor, "name", "") or ""
            for i in range(3):
                if name == f"dim{i}":
                    self.cb_dim.setCurrentIndex(i)
                    self.sp_dim.setFocus(); self.sp_dim.selectAll()
                    return
        except Exception:
            pass

    def _draw_setup_preview_dims(self):
        """Bounding box with three labelled, pickable edges (L red, W green, H blue)."""
        if self.sm is None or self.run is not None:
            return
        pl = self.plotter
        info = getattr(self, "_last_info", None)
        if info is None:
            return
        o = np.asarray(info.mesh_offset, dtype=float).copy(); e = np.asarray(self.sm.extent)
        if info.symmetry:
            o[1] = -float(e[1]) / 2
        lo, hi = o, o + e
        pl.add_mesh(pv.Box(bounds=(lo[0], hi[0], lo[1], hi[1], lo[2], hi[2])), style="wireframe", color="#8b93a1",
                    line_width=1, name="bbox", pickable=False)
        L = float(e.max()); r = 0.012 * L
        labels, pts = [], []
        for i in range(3):
            a = lo.copy(); b = lo.copy(); b[i] = hi[i]
            if i == 0:  # run the length edge along the front-bottom, width along the front, height at the nose
                a[1] = b[1] = lo[1]; a[2] = b[2] = lo[2]
            elif i == 1:
                a[0] = b[0] = hi[0]; a[2] = b[2] = lo[2]
            else:
                a[0] = b[0] = hi[0]; a[1] = b[1] = lo[1]
            tube = pv.Line(a, b).tube(radius=r * (1.8 if i == self.dim_axis else 1.0))
            act = pl.add_mesh(tube, color=DIM_COLORS[i], name=f"dim{i}", pickable=True, smooth_shading=True)
            act.name = f"dim{i}"
            pts.append((a + b) / 2); labels.append(f"{['L', 'W', 'H'][i]}  {e[i]:.3g} m")
        pl.add_point_labels(np.array(pts), labels, name="dimlabels", font_size=12, text_color="#e8eaee",
                            shape_color="#12151b", shape_opacity=0.75, point_size=0, show_points=False,
                            always_visible=True, pickable=False)
        pl.render()

    def _update_estimate(self, *_):
        if self._syncing:
            return
        try:
            sm = self._prepare_sm()
        except Exception as e:
            self.stats.note.setText(f"⚠ {e}"); return
        if sm is None:
            for k in self.stats.values:
                self.stats.set(k, "—")
            self.stats.note.setText("Open a model to see the estimate."); return
        self.sm = sm
        e = sm.extent
        self.lbl_dims.setText(f"L {e[0]:.3g} m   ·   W {e[1]:.3g} m   ·   H {e[2]:.3g} m")
        if not self.sp_dim.hasFocus():
            self.sp_dim.blockSignals(True); self.sp_dim.setValue(float(e[self.dim_axis])); self.sp_dim.blockSignals(False)
        p = self.params(); info = plan_case(sm, p)
        work = info.steps * (info.cells + sum(c * 2 ** (i + 1) for i, c in enumerate(info.cells_levels)))
        eta = work / 2.0e9 + p.n_frames * (1.5 if p.iso else 0.3) * info.cells_total / 3e7
        self.stats.set("cells", f"{info.cells_total/1e6:.1f} M"); self.stats.set("mem", f"{info.memory_gb:.1f} GB")
        self.stats.set("eta", f"{eta/60:.0f} min" if eta > 90 else f"{eta:.0f} s")
        self.stats.set("re", f"{info.re:.2g}"); self.stats.set("dx", f"{(info.dx_fine if info.refine else info.dx)*1000:.1f} mm"); self.stats.set("frames", f"{p.n_frames}")
        note = f"{info.nx} × {info.ny} × {info.nz} grid  ·  {info.steps:,} steps  ·  {info.t_total:.2f} s simulated"
        if info.refine:
            lv_txt = "  +  ".join(f"L{i+1} {l.shape[0]}×{l.shape[1]}×{l.shape[2]} ({np.prod(l.shape)/1e6:.1f} M, {l.dx*1000:.0f} mm)"
                                  for i, l in enumerate(info.levels))
            note = (f"domain {info.nx} × {info.ny} × {info.nz} ({info.cells/1e6:.1f} M, {info.dx*1000:.0f} mm)  +  {lv_txt}"
                    f"{'   ·  half model' if info.symmetry else ''}" + chr(10) +
                    f"{info.steps:,} steps  ·  {info.t_total:.2f} s simulated")
        if info.memory_gb > 8.5:
            note += "\n⚠ Likely exceeds the 10 GB GPU — pick a lower quality."
        elif info.memory_gb > 6.5:
            note += "\n⚠ Large: close other GPU apps."
        self.stats.note.setText(note)
        self._draw_setup_preview(sm, p, info)

    def _draw_setup_preview(self, sm, p, info):
        if self.run is not None or (self.worker is not None and self.worker.isRunning()):
            return
        self.stack.setCurrentIndex(1)
        pl = self.plotter
        pl.clear(); self._actors = {}
        faces = np.hstack([np.full((len(sm.faces), 1), 3), sm.faces]).ravel()
        off = np.asarray(info.mesh_offset, dtype=float).copy()
        if info.symmetry:
            off[1] = -float(sm.extent[1]) / 2
        mesh = pv.PolyData(sm.vertices + off, faces)
        pl.add_mesh(mesh, name="body", **self._body_style())
        pl.add_mesh(pv.Box(bounds=(0, info.nx * info.dx, 0, info.ny * info.dx, 0, info.nz * info.dx)),
                    style="wireframe", color="#3a4454", name="domain")
        if p.ground:
            pl.add_mesh(pv.Plane(center=(info.nx * info.dx / 2, info.ny * info.dx / 2, 0), direction=(0, 0, 1),
                                 i_size=info.nx * info.dx, j_size=info.ny * info.dx), color="#1c2129", name="ground")
        for i, lv in enumerate(info.levels):
            o = np.asarray(lv.origin); e = o + np.asarray(lv.shape) * lv.dx
            pl.add_mesh(pv.Box(bounds=(o[0], e[0], o[1], e[1], o[2], e[2])), style="wireframe",
                        color=ACCENT, opacity=0.35 + 0.3 * i, name=f"level{i}", pickable=False)
        if info.symmetry:
            pl.add_mesh(pv.Plane(center=(info.nx * info.dx / 2, 0, info.nz * info.dx / 2), direction=(0, 1, 0),
                                 i_size=info.nx * info.dx, j_size=info.nz * info.dx), color=ACCENT, opacity=0.08,
                        name="symplane", pickable=False)
        L = float(sm.extent.max())
        pl.add_mesh(pv.Arrow(start=(info.mesh_offset[0] - 0.9 * L, info.ny * info.dx / 2, info.nz * info.dx / 2),
                             direction=(1, 0, 0), scale=0.6 * L), color=ACCENT, name="arrow", pickable=False)
        pl.add_text(f"setup preview  ·  flow travels +X  ·  {sm.extent[0]:.3g} × {sm.extent[1]:.3g} × {sm.extent[2]:.3g} m",
                    position="upper_left", font_size=9, color=MUTED, name="title")
        self._last_info = info
        self._draw_setup_preview_dims()
        key = (id(self.model), round(float(L), 6), tuple(np.round(info.mesh_offset, 6)))
        if getattr(self, "_preview_cam_key", None) != key:   # new model, new scale or new domain: re-frame
            c = np.asarray(info.mesh_offset) + np.asarray(sm.extent) / 2
            pl.camera.focal_point = c
            pl.camera.position = c + np.array([-1.6 * L, -2.4 * L, 1.1 * L]); pl.camera.up = (0, 0, 1)
            self._preview_cam_key = key
        pl.reset_camera_clipping_range()
        if not getattr(self, "_picking_on", False):
            try:
                pl.enable_mesh_picking(callback=self._on_pick, show=False, show_message=False, left_clicking=True,
                                       use_actor=True, style="wireframe")
                self._picking_on = True
            except Exception as e:
                self.log.appendPlainText(f"picking: {e}")
        pl.render()

    # ------------------------------------------------------------------ actions
    def go_home(self):
        self.stop_play(); self.hero.refresh_runs(); self.stack.setCurrentIndex(0)

    def load_model(self):
        path, _ = QtWidgets.QFileDialog.getOpenFileName(self, "Open model", ROOT,
                                                        "Models (*.blend *.glb *.gltf *.obj *.stl *.fbx *.ply *.off);;All files (*)")
        if not path:
            return
        self.load_model_path(path)

    def load_model_path(self, path):
        try:
            self.log.appendPlainText(f"Loading {path} …"); QtWidgets.QApplication.processEvents()
            self.model = load_model(path)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self, "Load failed", str(e)); return
        ext = self.model.extents
        self.lbl_mesh.setText(f"{os.path.basename(path)}  ·  {self.model.n_faces:,} tris  ·  "
                              f"raw {ext[0]:.4g} × {ext[1]:.4g} × {ext[2]:.4g} units"
                              f"{'  ·  textured' if self.model.glb_path else ''}")
        # parts list
        for cb in self.part_checks.values():
            cb.setParent(None); cb.deleteLater()
        self.part_checks = {}
        many = len(self.model.parts) > 1
        self.parts_box.setVisible(many)
        if many:
            for name in self.model.parts:
                cb = toggle(name, True); cb.toggled.connect(lambda v, n=name: self._part_toggled(n, v))
                self.parts_box.layout_.addWidget(cb); self.part_checks[name] = cb
        self._syncing = True
        self.cb_units.setCurrentText("metres"); self.scale = 1.0
        self.ed_name.setText(os.path.splitext(os.path.basename(path))[0])
        self._syncing = False
        self.run = None; self._preview_cam_key = None
        self.sm = self._prepare_sm()
        self._apply_quality()
        self._update_estimate()
        self._dim_axis_changed()

    def _part_toggled(self, name, on):
        self.model.enabled[name] = on
        self._update_estimate()

    def start_run(self):
        if self.sm is None:
            QtWidgets.QMessageBox.information(self, "No model", "Open a model first."); return
        p = self.params()
        display = None
        if self.model is not None and self.model.glb_path:
            display = {"glb_path": self.model.glb_path,
                       "hidden_parts": [n for n, on in self.model.enabled.items() if not on],
                       "part_bounds": {n: [float(v) for v in m.bounds.T.ravel()] for n, m in self.model.parts.items()},
                       "part_faces": {n: int(len(m.faces)) for n, m in self.model.parts.items()}}
        self.worker = SimWorker(self.sm, p, self.ck_gpu.isChecked(), display)
        self.worker.progress.connect(self._on_progress); self.worker.frame.connect(self._on_frame)
        self.worker.log.connect(self.log.appendPlainText); self.worker.done.connect(self._on_done)
        self.worker.failed.connect(self._on_failed)
        if self.cad_link is not None:
            self.cad_link.watch(self.worker, p)     # progress.json / results.json back to the CAD case
        self.btn_run.setEnabled(False); self.btn_stop.setVisible(True)
        self.progress.setValue(0); self.run = None; self.stop_play()
        self.stack.setCurrentIndex(1)
        self.worker.start()

    def stop_run(self):
        if self.worker:
            self.worker.stop(); self.lbl_status.setText("stopping after this frame…")

    def _on_progress(self, step, total, mlups, cd, cl, cs, t):
        self.progress.setMaximum(total); self.progress.setValue(step)
        self.lbl_status.setText(f"{step:,} / {total:,} steps  ·  {mlups:.0f} MLUPS  ·  t = {t:.3f} s\nCd {cd:.3f}   Cl {cl:.3f}   Cs {cs:.3f}")

    def _on_frame(self, idx, folder):
        try:
            if self.run is None or self.run.folder != folder:
                self.run = Run(folder); self.reset_camera_pending = True
            else:
                self.run.reload_meta()
            self.sl_frame.setRange(0, max(0, self.run.n_frames - 1))
            self.force_plot.update_forces(self.run.forces())
            if self.ck_live.isChecked():
                self.goto_frame(idx)
        except Exception:
            self.log.appendPlainText(traceback.format_exc())

    def _on_done(self, folder):
        self.btn_run.setEnabled(True); self.btn_stop.setVisible(False)
        self.progress.setValue(self.progress.maximum())
        self.load_run(folder)

    def _on_failed(self, tb):
        self.btn_run.setEnabled(True); self.btn_stop.setVisible(False)
        self.log.appendPlainText(tb)
        QtWidgets.QMessageBox.critical(self, "Run failed", tb[-1500:])

    def open_run(self):
        folder = QtWidgets.QFileDialog.getExistingDirectory(self, "Open run folder", RUNS)
        if folder:
            self.load_run(folder)

    def load_run(self, folder):
        try:
            self.run = Run(folder)
        except Exception as e:
            QtWidgets.QMessageBox.critical(self, "Cannot open run", str(e)); return
        self.log.appendPlainText(f"Opened {folder}: {self.run.n_frames} frames")
        self.sl_frame.setRange(0, max(0, self.run.n_frames - 1))
        self.force_plot.update_forces(self.run.forces())
        self.reset_camera_pending = True
        self.stack.setCurrentIndex(1)
        self.goto_frame(self.run.n_frames - 1)

    # ------------------------------------------------------------------ playback
    def toggle_play(self):
        if self.playing:
            self.stop_play(); return
        if self.run is None or self.run.n_frames == 0:
            return
        self.playing = True; self.btn_play.setText("❚❚"); self.ck_live.setChecked(False)
        self.timer.start(int(1000 / self._fps()))

    def _fps(self):
        return int(self.cb_fps.currentText().split()[0])

    def stop_play(self):
        self.playing = False; self.btn_play.setText("▶"); self.timer.stop()

    def _tick(self):
        if self.run is None:
            return
        self.timer.setInterval(int(1000 / self._fps()))
        nxt = self.frame_idx + 1
        if nxt >= self.run.n_frames:
            if self.ck_loop.isChecked():
                nxt = 0
            else:
                self.stop_play(); return
        self.goto_frame(nxt)

    def _slider_moved(self, v):
        if self.run is not None and v != self.frame_idx:
            self.show_frame(v)

    def goto_frame(self, idx):
        if self.run is None:
            return
        idx = int(np.clip(idx, 0, max(0, self.run.n_frames - 1)))
        self.sl_frame.blockSignals(True); self.sl_frame.setValue(idx); self.sl_frame.blockSignals(False)
        self.show_frame(idx)

    def refresh_view(self, *_):
        if self.run is not None:
            self.show_frame(self.frame_idx)

    # ------------------------------------------------------------------ looks
    def _apply_look(self, *_):
        look = self.cb_look.currentIndex()
        if look == 5:
            return
        cfg = {0: dict(slice=False, stream=False, q=True, vol=False, cp=False, wire=False),
               1: dict(slice=True, stream=True, q=False, vol=False, cp=False, wire=True),
               2: dict(slice=True, stream=False, q=True, vol=False, cp=False, wire=False),
               3: dict(slice=False, stream=False, q=False, vol=True, cp=False, wire=False),
               4: dict(slice=False, stream=False, q=False, vol=False, cp=True, wire=False)}[look]
        self._syncing = True
        for w, v in ((self.ck_slice, cfg["slice"]), (self.ck_stream, cfg["stream"]), (self.ck_q, cfg["q"]),
                     (self.ck_vol, cfg["vol"]), (self.ck_cp, cfg["cp"]), (self.ck_wire, cfg["wire"])):
            w.setChecked(v)
        self._syncing = False
        self.refresh_view()

    def _view_changed(self, *_):
        if not self._syncing:
            self.cb_look.blockSignals(True); self.cb_look.setCurrentIndex(5); self.cb_look.blockSignals(False)
            self.refresh_view()

    # ------------------------------------------------------------------ rendering
    def _setup_lights(self):
        pl = self.plotter
        pl.remove_all_lights()
        key = pv.Light(light_type="camera light", intensity=1.0); key.set_direction_angle(30, -30)
        fill = pv.Light(light_type="camera light", intensity=0.45); fill.set_direction_angle(-20, 40)
        rim = pv.Light(light_type="camera light", intensity=0.35); rim.set_direction_angle(60, 160)
        for l in (key, fill, rim):
            pl.add_light(l)

    def _apply_render_quality(self, *_):
        pl = self.plotter
        L = float(self.run.mesh_extent.max()) if self.run is not None else 1.0
        try:
            if self.ck_ssao.isChecked():
                pl.enable_ssao(radius=0.03 * L, bias=0.002 * L, kernel_size=64, blur=True)
            else:
                pl.disable_ssao()
        except Exception as e:
            self.log.appendPlainText(f"SSAO: {e}")
        try:
            if self.ck_shadows.isChecked():
                pl.enable_shadows()
            else:
                pl.disable_shadows()
        except Exception as e:
            self.log.appendPlainText(f"shadows: {e}")
        try:
            if self.ck_fxaa.isChecked():
                pl.enable_anti_aliasing("fxaa")
            else:
                pl.disable_anti_aliasing()
        except Exception as e:
            self.log.appendPlainText(f"FXAA: {e}")
        pl.render()

    def _load_textured_body(self, run):
        """Import the GLB (materials + textures) and move it into simulation coordinates."""
        pl = self.plotter
        try:
            before = set(pl.renderer.actors)
            pl.import_gltf(run.glb)
            new = [pl.renderer.actors[k] for k in pl.renderer.actors if k not in before]
            M = np.asarray(run.display["matrix"], dtype=float)
            vm = pv.vtkmatrix_from_array(M)
            hidden = set(run.display.get("hidden_parts", []))
            for a in new:
                # the importer stores each node's own transform in the user matrix: compose, do not replace
                own = a.GetUserMatrix()
                if own is not None:
                    own_np = np.array([[own.GetElement(r, c) for c in range(4)] for r in range(4)])
                    a.SetUserMatrix(pv.vtkmatrix_from_array(M @ own_np))
                else:
                    a.SetUserMatrix(vm)
                try:
                    a.prop.SetInterpolationToPBR()
                except Exception:
                    pass
            # hide parts the user excluded: actors carry no names, so match by raw bounding-box centre
            pb = run.display.get("part_bounds", {}); pf = run.display.get("part_faces", {})
            if hidden and pb:
                names = list(pb); bounds = np.array([pb[n] for n in names], dtype=float)
                scale = max(1e-9, float(np.abs(bounds).max()))
                for a in new:
                    inp = a.GetMapper().GetInput()
                    b = np.array(inp.GetBounds(), dtype=float)
                    score = np.linalg.norm(bounds - b, axis=1) / scale
                    if pf:   # gear-up / gear-down style twins share a box: triangle count separates them
                        nf = max(1, inp.GetNumberOfCells())
                        score = score + np.array([abs(np.log(nf / max(1, pf.get(n, nf)))) for n in names])
                    if names[int(np.argmin(score))] in hidden:
                        a.SetVisibility(False)
            self._gltf_actors = [a for a in new if a.GetVisibility()]
            pl.remove_actor("body")
        except Exception as e:
            self.log.appendPlainText(f"textured body: {e}")
            self._gltf_actors = []

    def _body_style(self):
        if self.ck_pbr.isChecked():
            return dict(color="#e6eaee", smooth_shading=True, pbr=True, metallic=0.05, roughness=0.3)
        return dict(color="#cfd8dc", smooth_shading=True, specular=0.4, specular_power=30)

    def show_frame(self, idx):
        run = self.run
        if run is None or run.n_frames == 0:
            return
        self.frame_idx = idx
        use_full = self.ck_full.isChecked() and run.has_full
        try:
            fields = run.load_frame(idx, full=use_full)
        except Exception:
            self.log.appendPlainText(traceback.format_exc()); return
        t0 = time.perf_counter()
        pl = self.plotter
        U = run.speed
        L = float(run.mesh_extent.max())
        rho = run.params["rho"] if run.params["fluid"] == "Custom" else FLUIDS[run.params["fluid"]][1]
        q = 0.5 * rho * U * U
        cmap = self.cb_cmap.currentText()
        grid = run.grid(fields)
        h = fields["h"]
        nz, ny, nx = fields["speed"].shape
        b = run.mesh.bounds
        cx, cy, cz = (b[0] + b[1]) / 2, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2

        if self.reset_camera_pending or "body" not in self._actors:
            try:
                pl.disable_picking(); self._picking_on = False
            except Exception:
                pass
            pl.clear(); self._actors = {}; self._gltf_actors = []
            self._actors["body"] = pl.add_mesh(run.mesh, name="body", **self._body_style())
            if run.glb and run.display:
                self._load_textured_body(run)
            if run.params["ground"]:
                gy = fields.get("y0", 0.0) + ny * h / 2
                pl.add_mesh(pv.Plane(center=(nx * h / 2, gy, 0), direction=(0, 0, 1), i_size=nx * h, j_size=ny * h),
                            color="#151920", name="ground", pbr=self.ck_pbr.isChecked(), roughness=0.95, metallic=0.0)
            self._apply_render_quality()

        y0 = fields.get("y0", 0.0)
        if self.ck_wire.isChecked():
            pl.add_mesh(pv.Box(bounds=(0, nx * h, y0, y0 + ny * h, 0, nz * h)), style="wireframe", color="#3a4454", name="domain")
        else:
            pl.remove_actor("domain")

        clims = {"speed": (0, self.sp_speed_max.value() * U), "p": (-q, q), "vort": (0, 12 * U / L),
                 "Q": (-20 * (U / L) ** 2, 20 * (U / L) ** 2), "ux": (-0.5 * U, 1.5 * U), "uy": (-0.5 * U, 0.5 * U),
                 "uz": (-0.5 * U, 0.5 * U)}
        cmaps = {"p": "coolwarm", "ux": "coolwarm", "uy": "coolwarm", "uz": "coolwarm", "Q": "coolwarm"}
        field = FIELDS[self.cb_field.currentText()]
        bar_args = dict(title=self._bar_title(field), color="#dddddd", vertical=False, position_x=0.32, position_y=0.02,
                        width=0.36, height=0.05, title_font_size=11, label_font_size=9)

        # --- slices
        if self.ck_slice.isChecked():
            axis = self.cb_slice_axis.currentIndex()  # 0 Y, 1 Z, 2 X
            frac = self.sl_slice.value() / 1000
            dims = (nx, ny, nz); ax_i = [1, 2, 0][axis]
            i = int(round(frac * (dims[ax_i] - 1)))
            voi = [0, nx - 1, 0, ny - 1, 0, nz - 1]; voi[2 * ax_i] = voi[2 * ax_i + 1] = i
            sl = grid.extract_subset(voi)
            arr = sl.point_data[field].copy(); arr[sl.point_data["solid"] > 0] = np.nan
            sl.point_data["show"] = arr
            pl.add_mesh(sl, scalars="show", cmap=cmaps.get(field, cmap), clim=clims[field], name="slice",
                        nan_color="#cfd8dc", show_scalar_bar=True, scalar_bar_args=bar_args)
            if self.ck_slice2.isChecked():
                iz = int(np.clip(round(cz / h - 0.5), 0, nz - 1))
                sl2 = grid.extract_subset([0, nx - 1, 0, ny - 1, iz, iz])
                arr = sl2.point_data[field].copy(); arr[sl2.point_data["solid"] > 0] = np.nan
                sl2.point_data["show"] = arr
                pl.add_mesh(sl2, scalars="show", cmap=cmaps.get(field, cmap), clim=clims[field], name="slice2",
                            nan_color="#cfd8dc", show_scalar_bar=False)
            else:
                pl.remove_actor("slice2")
        else:
            pl.remove_actor("slice"); pl.remove_actor("slice2")

        # --- streamlines
        if self.ck_stream.isChecked():
            n = self.sp_nstream.value(); ext = run.mesh_extent
            rng = np.random.default_rng(0)
            ys = cy + (rng.random(n) - 0.5) * ext[1] * 2
            zs = cz + (rng.random(n) - 0.5) * ext[2] * 2
            if self.ck_seed_slice.isChecked() and self.ck_slice.isChecked():
                frac = self.sl_slice.value() / 1000; axis = self.cb_slice_axis.currentIndex()
                if axis == 0:   # sit one cell on the camera side of the slice so the plane does not hide them
                    ys = np.full(n, y0 + frac * (ny - 1) * h - 0.6 * h); zs = cz + np.linspace(-1, 1, n) * ext[2]
                elif axis == 1:
                    zs = np.full(n, frac * (nz - 1) * h + 1.6 * h); ys = cy + np.linspace(-1, 1, n) * ext[1]
            zs = np.clip(zs, 0.6 * h, nz * h - h)
            xs = np.full(n, max(h, b[0] - 0.4 * L))
            seeds = pv.PolyData(np.column_stack([xs, ys, zs]))
            try:
                sls = grid.streamlines_from_source(seeds, vectors="U", max_length=nx * h * 2.0, integration_direction="forward",
                                                  max_step_length=1.0, initial_step_length=0.5, terminal_speed=0.01 * U)
                if sls.n_points:
                    if self.ck_tubes.isChecked():
                        sls = sls.tube(radius=0.004 * L)
                    pl.add_mesh(sls, scalars="speed", cmap=cmap, clim=clims["speed"], name="stream", show_scalar_bar=False,
                                pbr=self.ck_pbr.isChecked(), roughness=0.5, metallic=0.1)
                else:
                    pl.remove_actor("stream")
            except Exception as e:
                self.log.appendPlainText(f"streamlines: {e}")
        else:
            pl.remove_actor("stream")

        # --- vortex surface
        if self.ck_q.isChecked():
            try:
                fine = self.cb_detail.currentIndex() == 1
                if self.cb_q_src.currentIndex() == 0 and run.has_iso(idx, fine) and not use_full:
                    iso = run.load_iso(idx, fine)
                elif self.cb_q_src.currentIndex() == 0 and run.has_iso(idx) and not use_full:
                    iso = run.load_iso(idx)
                else:
                    lvl = (U / L) ** 2 * 10 ** ((self.sl_q.value() - 50) / 25.0)
                    iso = grid.contour([lvl], scalars="Q", method="flying_edges", compute_normals=True)
                    if iso.n_points:
                        ijk = np.clip(np.rint(iso.points / h - 0.5).astype(np.int64), 0, [nx - 1, ny - 1, nz - 1])
                        iso.point_data["speed"] = grid.point_data["speed"][ijk @ np.array([1, nx, nx * ny])]
                if iso.n_points:
                    style = dict(name="qiso", opacity=self.sp_q_opacity.value(), smooth_shading=True, show_scalar_bar=False,
                                 pbr=self.ck_pbr.isChecked(), metallic=0.15, roughness=self.sp_rough.value(),
                                 specular=0.6, specular_power=40)
                    mode = self.cb_q_color.currentIndex()
                    if mode == 0:
                        pl.add_mesh(iso, scalars="speed", cmap=cmap, clim=clims["speed"], **style)
                    elif mode == 1:
                        iso.point_data["z"] = iso.points[:, 2]
                        pl.add_mesh(iso, scalars="z", cmap=cmap, clim=(0, nz * h), **style)
                    else:
                        pl.add_mesh(iso, color="#9ccc65", **style)
                else:
                    pl.remove_actor("qiso")
            except Exception as e:
                self.log.appendPlainText(f"vortex surface: {e}")
        else:
            pl.remove_actor("qiso")

        # --- volume
        if self.ck_vol.isChecked():
            pl.remove_actor("vol")
            op = np.clip(np.linspace(0, 1, 32) ** 1.5 * self.sp_vol_opacity.value(), 0, 1)
            try:
                if run.has_vort(idx) and run.vort_scale:
                    vg = run.load_vort(idx)
                    self._actors["vol"] = pl.add_volume(vg, scalars="vort", cmap="magma", opacity=op, name="vol",
                                                        clim=(0, 255 * clims["vort"][1] / run.vort_scale), show_scalar_bar=False, shade=True)
                else:
                    self._actors["vol"] = pl.add_volume(grid, scalars="vort", cmap="magma", clim=(0, clims["vort"][1]), opacity=op,
                                                        name="vol", show_scalar_bar=False, shade=True)
            except Exception as e:
                self.log.appendPlainText(f"volume: {e}")
        else:
            pl.remove_actor("vol")

        # --- body colouring
        textured = bool(self._gltf_actors)
        for a in self._gltf_actors:
            a.SetVisibility(not self.ck_cp.isChecked())
        if self.ck_cp.isChecked():
            try:
                surf = run.mesh.compute_normals(point_normals=True, cell_normals=False, auto_orient_normals=True)
                probe = pv.PolyData(surf.points + surf.point_data["Normals"] * 1.2 * h)
                surf.point_data["Cp"] = probe.sample(grid).point_data["p"] / q
                pl.add_mesh(surf, scalars="Cp", cmap="coolwarm", clim=(-1.2, 1.0), name="body", smooth_shading=True,
                            show_scalar_bar=True, scalar_bar_args=dict(bar_args, title="Cp"))
            except Exception as e:
                self.log.appendPlainText(f"Cp: {e}")
        elif textured:
            pl.remove_actor("body")
        else:
            pl.add_mesh(run.mesh, name="body", **self._body_style())

        t = fields["t"]
        pl.add_text(f"t = {t:.4f} s   ·   {idx + 1} / {run.n_frames}{'   ·   full res' if use_full else ''}",
                    position="upper_left", font_size=9, color=MUTED, name="title")
        if self.reset_camera_pending:
            self.reset_camera_pending = False
            if self.cb_look.currentIndex() == 0:
                self.cinematic_camera()
            else:
                self.reset_camera()
        self.lbl_time.setText(f"t = {t:.4f} s   ·   {1000 * (time.perf_counter() - t0):.0f} ms")
        self.force_plot.update_forces(run.forces(), t)
        pl.render()
        self._prefetch(idx + 1 if idx + 1 < run.n_frames else 0, use_full)

    def _prefetch(self, idx, use_full):
        run = self.run
        if run is None or use_full or (getattr(self, "_prefetch_thread", None) and self._prefetch_thread.is_alive()):
            return
        want_iso = self.ck_q.isChecked() and self.cb_q_src.currentIndex() == 0
        fine = self.cb_detail.currentIndex() == 1
        want_vol = self.ck_vol.isChecked()

        def work():
            try:
                run.load_frame(idx)
                if want_iso and run.has_iso(idx, fine):
                    run.load_iso(idx, fine)
                if want_vol and run.has_vort(idx):
                    run.load_vort(idx)
            except Exception:
                pass
        self._prefetch_thread = threading.Thread(target=work, daemon=True); self._prefetch_thread.start()

    @staticmethod
    def _bar_title(field):
        return {"speed": "|U|  m/s", "p": "p  Pa", "vort": "|ω|  1/s", "Q": "Q  1/s²", "ux": "u  m/s", "uy": "v  m/s", "uz": "w  m/s"}[field]

    # ------------------------------------------------------------------ camera / export
    def reset_camera(self):
        if self.run is None:
            self.plotter.reset_camera(); return
        b = self.run.mesh.bounds; L = float(self.run.mesh_extent.max())
        c = np.array([(b[0] + b[1]) / 2 + 0.6 * L, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2])
        self.plotter.camera.focal_point = c
        self.plotter.camera.position = c + np.array([-1.8 * L, -3.6 * L, 1.6 * L])
        self.plotter.camera.up = (0, 0, 1)
        self.plotter.reset_camera_clipping_range(); self.plotter.render()

    def cinematic_camera(self):
        if self.run is None:
            return
        b = self.run.mesh.bounds; L = float(self.run.mesh_extent.max())
        c = np.array([(b[0] + b[1]) / 2 + 1.1 * L, (b[2] + b[3]) / 2, (b[4] + b[5]) / 2])
        self.plotter.camera.focal_point = c
        self.plotter.camera.position = c + np.array([-3.4 * L, -7.6 * L, 3.0 * L])
        self.plotter.camera.up = (0, 0, 1)
        self.plotter.reset_camera_clipping_range(); self.plotter.render()

    def screenshot(self):
        path, _ = QtWidgets.QFileDialog.getSaveFileName(self, "Save screenshot", os.path.join(RUNS, "screenshot.png"), "PNG (*.png)")
        if path:
            self.plotter.screenshot(path, transparent_background=False, scale=2)
            self.log.appendPlainText(f"Saved {path}")

    def export_video(self):
        if self.run is None or self.run.n_frames == 0:
            return
        path, _ = QtWidgets.QFileDialog.getSaveFileName(self, "Export video", os.path.join(self.run.folder, "playback.mp4"),
                                                        "MP4 (*.mp4);;GIF (*.gif)")
        if not path:
            return
        self.stop_play()
        try:
            if path.lower().endswith(".gif"):
                self.plotter.open_gif(path, fps=self._fps())
            else:
                self.plotter.open_movie(path, framerate=self._fps(), quality=8)
            prog = QtWidgets.QProgressDialog("Rendering frames…", "Cancel", 0, self.run.n_frames, self)
            prog.setWindowModality(Qt.WindowModal)
            for i in range(self.run.n_frames):
                if prog.wasCanceled():
                    break
                self.goto_frame(i); QtWidgets.QApplication.processEvents()
                self.plotter.write_frame(); prog.setValue(i + 1)
            self.plotter.mwriter.close()
            self.log.appendPlainText(f"Video written: {path}")
        except Exception as e:
            self.log.appendPlainText(f"video export failed: {e}")
            QtWidgets.QMessageBox.warning(self, "Export failed", f"{e}\n\nFor MP4 install: pip install imageio-ffmpeg")

    def closeEvent(self, ev):
        if self.worker and self.worker.isRunning():
            self.worker.stop(); self.worker.wait(30000)
        self.plotter.close()
        super().closeEvent(ev)


def main(open_run: str | None = None, case: str | None = None):
    app = QtWidgets.QApplication(sys.argv)
    apply_theme(app)
    os.makedirs(RUNS, exist_ok=True)
    w = MainWindow(); w.show()
    if open_run:
        w.load_run(open_run)
    if case:
        from .cadlink import attach_gui
        attach_gui(w, case)
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

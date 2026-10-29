"""Welcome screen: a procedurally drawn flow field (no image files) with the main actions on top."""
from __future__ import annotations

import math
import os
import time

import numpy as np
from PySide6 import QtCore, QtGui, QtWidgets

from .ui_theme import ACCENT, MUTED, TEXT, LINE, CARD, FONT_DISPLAY

# turbo-like colour stops (t, r, g, b)
_STOPS = [(0.0, 48, 18, 59), (0.2, 70, 110, 240), (0.4, 40, 200, 200), (0.6, 150, 230, 60), (0.8, 250, 170, 30), (1.0, 200, 40, 20)]


def _cmap(t: float) -> QtGui.QColor:
    t = min(1.0, max(0.0, t))
    for (t0, r0, g0, b0), (t1, r1, g1, b1) in zip(_STOPS[:-1], _STOPS[1:]):
        if t <= t1:
            f = (t - t0) / (t1 - t0)
            return QtGui.QColor(int(r0 + f * (r1 - r0)), int(g0 + f * (g1 - g0)), int(b0 + f * (b1 - b0)))
    return QtGui.QColor(*_STOPS[-1][1:])


def _streamlines(n=64, x0=-3.2, x1=5.5, h=0.02):
    """Potential flow past a cylinder (R = 1) with a synthetic wavy wake. Returns [(pts(N,2), speed(N))]."""
    lines = []
    ys = np.linspace(-2.3, 2.3, n)
    for k, y in enumerate(ys):
        if abs(y) < 0.04:
            continue
        p = np.array([x0, y]); pts = []; spd = []
        phase = 2.1 * k
        for _ in range(int((x1 - x0) / h) + 50):
            def vel(q):
                x, yy = q; r2 = x * x + yy * yy
                if r2 < 1.0:
                    return np.zeros(2)
                r4 = r2 * r2
                return np.array([1 - (x * x - yy * yy) / r4, -2 * x * yy / r4])
            v = vel(p)
            if np.linalg.norm(v) < 1e-6 or p[0] > x1:
                break
            pm = p + 0.5 * h * v
            p = p + h * vel(pm)
            if p[0] * p[0] + p[1] * p[1] < 1.03:
                break
            s = float(np.linalg.norm(v))
            x = p[0]
            # gentle Kármán-style waviness downstream, stronger near the centreline
            if x > 0.6:
                amp = 0.16 * min(1.0, (x - 0.6) / 2.5) * math.exp(-abs(p[1]) * 0.9)
                yy = p[1] + amp * math.sin(2.4 * x + phase)
                s *= 1 + 0.25 * math.sin(2.4 * x + phase) * math.exp(-abs(p[1]))
            else:
                yy = p[1]
            pts.append((x, yy)); spd.append(s)
        if len(pts) > 5:
            lines.append((np.array(pts), np.array(spd)))
    return lines


class FlowCanvas(QtWidgets.QWidget):
    """Paints the background flow once per size into a cached pixmap."""

    def __init__(self):
        super().__init__()
        self.lines = _streamlines()
        self.t0 = time.time()
        self._pix = None
        self.setAttribute(QtCore.Qt.WA_OpaquePaintEvent, True)

    def paintEvent(self, ev):
        if self._pix is None or self._pix.size() != self.size():
            self._pix = QtGui.QPixmap(self.size()); self._render(self._pix)
        QtGui.QPainter(self).drawPixmap(0, 0, self._pix)

    def _render(self, target):
        p = QtGui.QPainter(target); p.setRenderHint(QtGui.QPainter.Antialiasing)
        w, hgt = target.width(), target.height()
        g = QtGui.QLinearGradient(0, 0, w, hgt)
        g.setColorAt(0.0, QtGui.QColor("#0a0c11")); g.setColorAt(0.55, QtGui.QColor("#0f131a")); g.setColorAt(1.0, QtGui.QColor("#161c27"))
        p.fillRect(self.rect(), g)
        # soft accent glow behind the body
        rg = QtGui.QRadialGradient(w * 0.36, hgt * 0.5, w * 0.35)
        c = QtGui.QColor(ACCENT); c.setAlpha(26); rg.setColorAt(0, c); c2 = QtGui.QColor(ACCENT); c2.setAlpha(0); rg.setColorAt(1, c2)
        p.fillRect(self.rect(), rg)

        # map normalized coords (x -3.2..5.5, y -2.3..2.3) to pixels, fit width, vertically centred
        sx = w / 8.7; sy = sx
        ox, oy = 3.2 * sx, hgt * 0.5
        drift = 0.0
        for i, (pts, spd) in enumerate(self.lines):
            path = QtGui.QPainterPath()
            # animate: slide the wavy part slowly by shifting sampled phase along the line
            n = len(pts)
            xs = pts[:, 0] * sx + ox
            ys = pts[:, 1] * sy + oy
            k = 0.05 * math.sin(drift + i * 0.7)
            ys = ys + k * sy * np.clip(pts[:, 0] - 0.6, 0, None) * np.exp(-np.abs(pts[:, 1]) * 0.9)
            close = math.exp(-abs(pts[0, 1]) * 0.55)
            step = 10
            for j0 in range(0, n - 1, step):
                j1 = min(n - 1, j0 + step)
                seg = QtGui.QPainterPath(); seg.moveTo(xs[j0], ys[j0])
                for j in range(j0 + 1, j1 + 1):
                    seg.lineTo(xs[j], ys[j])
                s = float(np.clip((spd[j0:j1 + 1].mean() - 0.55) / 1.1, 0, 1))
                col = _cmap(s)
                glow = QtGui.QColor(col); glow.setAlpha(int(14 + 26 * close))
                p.setPen(QtGui.QPen(glow, 4.0, QtCore.Qt.SolidLine, QtCore.Qt.RoundCap)); p.drawPath(seg)
                col.setAlpha(int(60 + 130 * close))
                p.setPen(QtGui.QPen(col, 1.2, QtCore.Qt.SolidLine, QtCore.Qt.RoundCap)); p.drawPath(seg)

        # the body
        r = 1.0 * sx
        body = QtGui.QRadialGradient(ox - 0.3 * r, oy - 0.3 * r, 1.6 * r)
        body.setColorAt(0, QtGui.QColor("#2b3240")); body.setColorAt(1, QtGui.QColor("#0c0f15"))
        p.setBrush(body); p.setPen(QtGui.QPen(QtGui.QColor("#3a4454"), 1))
        p.drawEllipse(QtCore.QPointF(ox, oy), r, r)
        p.end()


class HeroScreen(QtWidgets.QWidget):
    open_model = QtCore.Signal()
    open_run = QtCore.Signal(str)
    browse_run = QtCore.Signal()

    def __init__(self, runs_dir: str):
        super().__init__()
        self.runs_dir = runs_dir
        stack = QtWidgets.QGridLayout(self); stack.setContentsMargins(0, 0, 0, 0)
        self.canvas = FlowCanvas(); stack.addWidget(self.canvas, 0, 0)

        overlay = QtWidgets.QWidget(); overlay.setAttribute(QtCore.Qt.WA_TranslucentBackground, True)
        stack.addWidget(overlay, 0, 0)
        h = QtWidgets.QHBoxLayout(overlay); h.setContentsMargins(56, 48, 56, 48)

        left = QtWidgets.QVBoxLayout(); left.addStretch(1)
        title = QtWidgets.QLabel("CFD Sim")
        title.setStyleSheet(f'font-family: "{FONT_DISPLAY}", "Segoe UI Light", "Segoe UI"; font-size: 54px; font-weight: 200; color: {TEXT}; letter-spacing: 2px; background: transparent;')
        sub = QtWidgets.QLabel("GPU lattice-Boltzmann  ·  external aerodynamics")
        sub.setStyleSheet(f"font-size: 14px; color: {MUTED}; letter-spacing: 1px; background: transparent;")
        left.addWidget(title); left.addWidget(sub); left.addSpacing(28)
        b1 = QtWidgets.QPushButton("Open model"); b1.setObjectName("primary"); b1.setFixedWidth(200); b1.setCursor(QtCore.Qt.PointingHandCursor)
        b1.clicked.connect(self.open_model.emit)
        b2 = QtWidgets.QPushButton("Open a run folder"); b2.setObjectName("ghost"); b2.setFixedWidth(200); b2.setCursor(QtCore.Qt.PointingHandCursor)
        b2.clicked.connect(self.browse_run.emit)
        left.addWidget(b1); left.addSpacing(8); left.addWidget(b2)
        hint = QtWidgets.QLabel("OBJ · STL · FBX · GLB")
        hint.setStyleSheet(f"font-size: 11px; color: {MUTED}; letter-spacing: 2px; background: transparent; padding-top: 10px;")
        left.addWidget(hint)
        h.addLayout(left, 1)

        # recent runs card
        card = QtWidgets.QFrame(); card.setObjectName("card"); card.setFixedWidth(300)
        card.setStyleSheet(f"QFrame#card {{ background: rgba(24,28,36,0.86); border: 1px solid {LINE}; border-radius: 10px; }}")
        cv = QtWidgets.QVBoxLayout(card); cv.setContentsMargins(14, 12, 14, 12)
        lb = QtWidgets.QLabel("RECENT RUNS"); lb.setStyleSheet(f"color: {MUTED}; font-size: 11px; letter-spacing: 2px; background: transparent;")
        cv.addWidget(lb)
        self.list = QtWidgets.QListWidget(); self.list.setStyleSheet("QListWidget { background: transparent; }")
        self.list.itemClicked.connect(lambda it: self.open_run.emit(it.data(QtCore.Qt.UserRole)))
        cv.addWidget(self.list, 1)
        rv = QtWidgets.QVBoxLayout(); rv.addStretch(1); rv.addWidget(card); rv.addStretch(1)
        h.addLayout(rv)
        self.refresh_runs()

    def refresh_runs(self):
        self.list.clear()
        if not os.path.isdir(self.runs_dir):
            return
        runs = []
        for name in os.listdir(self.runs_dir):
            d = os.path.join(self.runs_dir, name)
            meta = os.path.join(d, "meta.json")
            if os.path.isfile(meta):
                runs.append((os.path.getmtime(meta), name, d))
        runs.sort(reverse=True)
        for mtime, name, d in runs[:8]:
            try:
                import json
                info = json.load(open(os.path.join(d, "meta.json")))["info"]
                cells = info["nx"] * info["ny"] * info["nz"] / 1e6
                sub = f"{cells:.0f} M cells · {time.strftime('%b %d %H:%M', time.localtime(mtime))}"
            except Exception:
                sub = ""
            it = QtWidgets.QListWidgetItem(f"{name}\n{sub}")
            it.setData(QtCore.Qt.UserRole, d)
            self.list.addItem(it)
        if not runs:
            it = QtWidgets.QListWidgetItem("No runs yet — open a model to start."); it.setFlags(QtCore.Qt.NoItemFlags)
            self.list.addItem(it)

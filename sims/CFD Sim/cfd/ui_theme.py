"""Visual theme: colours, fonts and the application stylesheet."""
from PySide6 import QtGui, QtWidgets

BG = "#0d0f14"        # window ground
PANEL = "#12151b"     # side panels
CARD = "#181c24"      # cards / inputs
LINE = "#242a35"      # hairlines
TEXT = "#e8eaee"
MUTED = "#8b93a1"
ACCENT = "#5ec8ff"
ACCENT2 = "#ff8a3d"
FONT = "Segoe UI Variable Text"
FONT_DISPLAY = "Segoe UI Variable Display"

QSS = f"""
* {{ font-family: "{FONT}", "Segoe UI", sans-serif; font-size: 13px; color: {TEXT}; }}
QMainWindow, QWidget#root {{ background: {BG}; }}
QWidget#sidebar, QWidget#viewpanel {{ background: {PANEL}; }}
QScrollArea {{ border: none; background: transparent; }}
QScrollArea > QWidget > QWidget {{ background: transparent; }}
QScrollBar:vertical {{ background: transparent; width: 6px; margin: 0; }}
QScrollBar::handle:vertical {{ background: {LINE}; border-radius: 3px; min-height: 30px; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar:horizontal {{ height: 0; }}

QLabel {{ background: transparent; }}
QLabel#section {{ color: {MUTED}; font-size: 11px; font-weight: 600; letter-spacing: 2px; padding-top: 6px; }}
QLabel#muted {{ color: {MUTED}; font-size: 12px; }}
QLabel#stat {{ color: {TEXT}; font-size: 18px; font-weight: 300; font-family: "{FONT_DISPLAY}", "Segoe UI Light", "Segoe UI"; }}
QLabel#statlabel {{ color: {MUTED}; font-size: 10px; letter-spacing: 1px; }}
QLabel#warn {{ color: {ACCENT2}; font-size: 12px; }}
QLabel#title {{ color: {TEXT}; font-size: 20px; font-weight: 300; font-family: "{FONT_DISPLAY}", "Segoe UI Light", "Segoe UI"; letter-spacing: 1px; }}

QComboBox, QDoubleSpinBox, QSpinBox, QLineEdit {{
    background: {CARD}; border: 1px solid {LINE}; border-radius: 6px; padding: 5px 8px; min-height: 18px;
    selection-background-color: {ACCENT}; selection-color: #000;
}}
QComboBox:hover, QDoubleSpinBox:hover, QSpinBox:hover, QLineEdit:hover {{ border-color: #35404f; }}
QComboBox:focus, QDoubleSpinBox:focus, QSpinBox:focus, QLineEdit:focus {{ border-color: {ACCENT}; }}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox::down-arrow {{ image: url(@DOWN@); width: 10px; height: 6px; margin-right: 8px; }}
QComboBox QAbstractItemView {{ background: {CARD}; border: 1px solid {LINE}; selection-background-color: #23303f;
    selection-color: {TEXT}; outline: none; padding: 4px; }}
QDoubleSpinBox::up-button, QSpinBox::up-button, QDoubleSpinBox::down-button, QSpinBox::down-button {{
    width: 16px; border: none; background: transparent; subcontrol-origin: border; }}
QDoubleSpinBox::up-button, QSpinBox::up-button {{ subcontrol-position: top right; margin-top: 3px; }}
QDoubleSpinBox::down-button, QSpinBox::down-button {{ subcontrol-position: bottom right; margin-bottom: 3px; }}
QDoubleSpinBox::up-arrow, QSpinBox::up-arrow {{ image: url(@UP@); width: 8px; height: 5px; }}
QDoubleSpinBox::down-arrow, QSpinBox::down-arrow {{ image: url(@DOWN_S@); width: 8px; height: 5px; }}
QAbstractSpinBox:disabled, QComboBox:disabled {{ color: #5a606b; }}

QPushButton {{ background: {CARD}; border: 1px solid {LINE}; border-radius: 6px; padding: 7px 14px; }}
QPushButton:hover {{ background: #1f2430; border-color: #35404f; }}
QPushButton:pressed {{ background: #161a22; }}
QPushButton:disabled {{ color: #5a606b; }}
QPushButton#primary {{ background: {ACCENT}; color: #06121a; border: none; font-weight: 600; padding: 10px 18px; font-size: 14px; }}
QPushButton#primary:hover {{ background: #7ad3ff; }}
QPushButton#primary:disabled {{ background: #2a3a45; color: #6d7f8c; }}
QPushButton#ghost {{ background: transparent; border: 1px solid {LINE}; }}
QPushButton#ghost:hover {{ border-color: {ACCENT}; color: {ACCENT}; }}
QPushButton#flat {{ background: transparent; border: none; color: {MUTED}; padding: 4px 6px; text-align: left; }}
QPushButton#flat:hover {{ color: {TEXT}; }}
QPushButton#icon {{ background: transparent; border: none; padding: 4px 8px; font-size: 15px; color: {TEXT}; }}
QPushButton#icon:hover {{ color: {ACCENT}; }}
QPushButton#danger {{ background: transparent; border: 1px solid {LINE}; color: {MUTED}; }}
QPushButton#danger:hover {{ border-color: {ACCENT2}; color: {ACCENT2}; }}

QCheckBox {{ spacing: 8px; background: transparent; }}
QCheckBox::indicator {{ width: 30px; height: 16px; border-radius: 8px; background: #2a303b; }}
QCheckBox::indicator:checked {{ background: {ACCENT}; }}
QCheckBox::indicator:disabled {{ background: #1f232b; }}

QSlider::groove:horizontal {{ height: 3px; background: {LINE}; border-radius: 1px; }}
QSlider::handle:horizontal {{ width: 12px; height: 12px; margin: -5px 0; border-radius: 6px; background: {TEXT}; }}
QSlider::handle:horizontal:hover {{ background: {ACCENT}; }}
QSlider::sub-page:horizontal {{ background: {ACCENT}; }}

QProgressBar {{ background: {LINE}; border: none; border-radius: 2px; height: 4px; text-align: center; color: transparent; }}
QProgressBar::chunk {{ background: {ACCENT}; border-radius: 2px; }}

QPlainTextEdit {{ background: {CARD}; border: 1px solid {LINE}; border-radius: 6px; color: {MUTED};
    font-family: Consolas, monospace; font-size: 11px; }}
QListWidget {{ background: transparent; border: none; outline: none; }}
QListWidget::item {{ padding: 8px 10px; border-radius: 6px; color: {TEXT}; }}
QListWidget::item:hover {{ background: {CARD}; }}
QListWidget::item:selected {{ background: #1f2a36; color: {ACCENT}; }}
QFrame#card {{ background: {CARD}; border: 1px solid {LINE}; border-radius: 8px; }}
QFrame#hline {{ background: {LINE}; max-height: 1px; min-height: 1px; border: none; }}
QToolTip {{ background: {CARD}; color: {TEXT}; border: 1px solid {LINE}; padding: 4px; }}
QSplitter::handle {{ background: {LINE}; width: 1px; }}
QMessageBox {{ background: {PANEL}; }}
QProgressDialog {{ background: {PANEL}; }}
"""


def apply_theme(app: QtWidgets.QApplication):
    app.setStyle("Fusion")
    pal = QtGui.QPalette()
    for role, col in ((QtGui.QPalette.Window, BG), (QtGui.QPalette.WindowText, TEXT), (QtGui.QPalette.Base, CARD),
                      (QtGui.QPalette.AlternateBase, PANEL), (QtGui.QPalette.Text, TEXT), (QtGui.QPalette.Button, CARD),
                      (QtGui.QPalette.ButtonText, TEXT), (QtGui.QPalette.Highlight, ACCENT),
                      (QtGui.QPalette.HighlightedText, "#000"), (QtGui.QPalette.ToolTipBase, CARD),
                      (QtGui.QPalette.ToolTipText, TEXT), (QtGui.QPalette.PlaceholderText, MUTED)):
        pal.setColor(role, QtGui.QColor(col))
    app.setPalette(pal)
    app.setStyleSheet(QSS.replace("@DOWN@", _chevron(10, 6, False)).replace("@UP@", _chevron(8, 5, True))
                      .replace("@DOWN_S@", _chevron(8, 5, False)))
    f = QtGui.QFont(FONT, 10)
    if not QtGui.QFontInfo(f).family().startswith("Segoe UI Variable"):
        f = QtGui.QFont("Segoe UI", 10)
    app.setFont(f)


def _chevron(w: int, h: int, up: bool) -> str:
    """Render a small chevron PNG for the stylesheet (Qt cannot draw CSS triangles reliably)."""
    import os, tempfile
    path = os.path.join(tempfile.gettempdir(), f"cfdsim_chev_{w}x{h}_{'u' if up else 'd'}.png")
    if not os.path.isfile(path):
        pm = QtGui.QPixmap(w * 2, h * 2); pm.fill(QtGui.QColor(0, 0, 0, 0))
        p = QtGui.QPainter(pm); p.setRenderHint(QtGui.QPainter.Antialiasing)
        p.setPen(QtGui.QPen(QtGui.QColor(MUTED), 2.2, QtGui.Qt.SolidLine, QtGui.Qt.RoundCap, QtGui.Qt.RoundJoin))
        path_ = QtGui.QPainterPath()
        if up:
            path_.moveTo(2, h * 2 - 2); path_.lineTo(w, 2); path_.lineTo(w * 2 - 2, h * 2 - 2)
        else:
            path_.moveTo(2, 2); path_.lineTo(w, h * 2 - 2); path_.lineTo(w * 2 - 2, 2)
        p.drawPath(path_); p.end()
        pm.save(path)
    return path.replace("\\", "/")


# ---- small widget helpers -------------------------------------------------------------------
def section(text: str) -> QtWidgets.QLabel:
    lb = QtWidgets.QLabel(text.upper()); lb.setObjectName("section")
    return lb


def muted(text: str = "") -> QtWidgets.QLabel:
    lb = QtWidgets.QLabel(text); lb.setObjectName("muted"); lb.setWordWrap(True)
    return lb


def hline() -> QtWidgets.QFrame:
    f = QtWidgets.QFrame(); f.setObjectName("hline"); f.setFrameShape(QtWidgets.QFrame.NoFrame)
    return f


def row(label: str, widget: QtWidgets.QWidget, parent_layout: QtWidgets.QVBoxLayout):
    """Label on the left, control on the right — a form row without QFormLayout's chrome."""
    h = QtWidgets.QHBoxLayout(); h.setContentsMargins(0, 0, 0, 0); h.setSpacing(10)
    lb = QtWidgets.QLabel(label); lb.setObjectName("muted"); lb.setFixedWidth(100)
    h.addWidget(lb); h.addWidget(widget, 1)
    parent_layout.addLayout(h)
    return widget


class Collapsible(QtWidgets.QWidget):
    """A section that folds away behind a small header button."""

    def __init__(self, title: str, open_: bool = False):
        super().__init__()
        self._open = open_
        v = QtWidgets.QVBoxLayout(self); v.setContentsMargins(0, 0, 0, 0); v.setSpacing(4)
        self.btn = QtWidgets.QPushButton(); self.btn.setObjectName("flat"); self.btn.setCursor(QtGui.Qt.PointingHandCursor)
        self.title = title
        self.btn.clicked.connect(self.toggle)
        v.addWidget(self.btn)
        self.body = QtWidgets.QWidget(); self.layout_ = QtWidgets.QVBoxLayout(self.body)
        self.layout_.setContentsMargins(0, 2, 0, 6); self.layout_.setSpacing(8)
        v.addWidget(self.body)
        self._refresh()

    def toggle(self):
        self._open = not self._open; self._refresh()

    def _refresh(self):
        self.btn.setText(("▾  " if self._open else "▸  ") + self.title.upper())
        self.body.setVisible(self._open)


class StatCard(QtWidgets.QFrame):
    """Grid of big numbers with tiny labels — the run estimate."""

    def __init__(self, keys):
        super().__init__(); self.setObjectName("card")
        g = QtWidgets.QGridLayout(self); g.setContentsMargins(12, 10, 12, 10); g.setHorizontalSpacing(14); g.setVerticalSpacing(2)
        self.values = {}
        for i, (key, label) in enumerate(keys):
            v = QtWidgets.QLabel("—"); v.setObjectName("stat")
            l = QtWidgets.QLabel(label.upper()); l.setObjectName("statlabel")
            g.addWidget(v, (i // 3) * 2, i % 3); g.addWidget(l, (i // 3) * 2 + 1, i % 3)
            self.values[key] = v
        self.note = QtWidgets.QLabel(""); self.note.setObjectName("muted"); self.note.setWordWrap(True)
        g.addWidget(self.note, (len(keys) + 2) // 3 * 2, 0, 1, 3)

    def set(self, key, text):
        self.values[key].setText(text)

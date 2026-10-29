"""D3Q19 lattice constants and cell-type flags."""
import numpy as np

C = np.array([
    [0, 0, 0],
    [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
    [1, 1, 0], [-1, -1, 0], [1, -1, 0], [-1, 1, 0],
    [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1],
    [0, 1, 1], [0, -1, -1], [0, 1, -1], [0, -1, 1],
], dtype=np.int32)

W = np.array([1 / 3] + [1 / 18] * 6 + [1 / 36] * 12, dtype=np.float32)

OPP = np.array([0, 2, 1, 4, 3, 6, 5, 8, 7, 10, 9, 12, 11, 14, 13, 16, 15, 18, 17], dtype=np.int32)

NQ = 19

# specular reflection tables (flip the y / z component of c_q)
REFL_Y = np.array([0, 1, 2, 4, 3, 5, 6, 9, 10, 7, 8, 11, 12, 13, 14, 18, 17, 16, 15], dtype=np.int32)
REFL_Z = np.array([0, 1, 2, 3, 4, 6, 5, 7, 8, 9, 10, 13, 14, 11, 12, 17, 18, 15, 16], dtype=np.int32)

# cell flags
FLUID = 0
SOLID = 1      # bounce-back (object, ground)
INLET = 2      # fixed equilibrium at free-stream
OUTLET = 3     # open: missing populations from equilibrium at local velocity
FARFIELD = 4   # lateral boundary: free-slip (specular reflection)
GROUND = 5     # bounce-back wall that is not part of the body (no force accounting)
GHOST = 6      # fine-grid rim cell whose populations come from the coarse grid

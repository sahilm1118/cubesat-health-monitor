"""Load NASA Ames PCoE Li-ion battery aging data (B0005/6/7/18) into tidy Python structures."""
from pathlib import Path
import numpy as np
from scipy.io import loadmat

ROOT = Path(__file__).resolve().parent.parent
BATT_DIR = ROOT / "data" / "raw" / "nasa_battery" / "fy08q4"
BATTERIES = ["B0005", "B0006", "B0007", "B0018"]


def load_battery(name):
    mat = loadmat(BATT_DIR / f"{name}.mat", simplify_cells=True)
    cycles = mat[name]["cycle"]
    discharges, impedances = [], []
    for c in cycles:
        t = c["type"]
        d = c["data"]
        if t == "discharge":
            discharges.append({
                "time": np.asarray(d["Time"], float),
                "voltage": np.asarray(d["Voltage_measured"], float),
                "current": np.asarray(d["Current_measured"], float),
                "temp": np.asarray(d["Temperature_measured"], float),
                "capacity": float(np.atleast_1d(d["Capacity"])[0]),
                "ambient": float(c["ambient_temperature"]),
            })
        elif t == "impedance":
            impedances.append({
                "Re": float(np.real(np.atleast_1d(d["Re"])[0])),
                "Rct": float(np.real(np.atleast_1d(d["Rct"])[0])),
                "after_discharge": len(discharges),  # discharges completed before this measurement
            })
    return discharges, impedances


if __name__ == "__main__":
    for b in BATTERIES:
        dis, imp = load_battery(b)
        caps = [d["capacity"] for d in dis]
        first_below = next((i + 1 for i, c in enumerate(caps) if c < 1.4), None)
        print(b, "discharges:", len(dis), "impedance:", len(imp),
              "cap first/last/min: %.3f %.3f %.3f" % (caps[0], caps[-1], min(caps)),
              "first cycle <1.4Ah:", first_below)

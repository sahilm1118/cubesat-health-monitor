"""Load and clean the full NASA PCoE Li-ion battery fleet (34 cells, 4-44 deg C, 1-4 A discharge).

Cleaning per cell:
  1. drop discharge runs with non-finite or ~zero capacity
  2. drop dips: runs below 85% of the rolling median of the surrounding 7 runs (NASA notes unexplained
     very-low-capacity runs in several sets)
  3. smooth with a centred rolling median of 5
"""
from pathlib import Path
import numpy as np
import pandas as pd
from scipy.io import loadmat

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "nasa_battery"


def find_files():
    files = {p.stem: p for p in RAW.rglob("B00*.mat")}
    return dict(sorted(files.items()))


PARTIAL = ["v_at_60s", "v_at_300s", "v_at_600s", "v_at_900s", "temp_rise_300s", "temp_rise_900s",
           "v_drop_60_900", "v_mean_15min", "v_slope_300_900", "temp_start"]


def partial_features(t, v, T):
    """first 15 minutes of a discharge only - what a CubeSat sees in a partial eclipse discharge"""
    f = {}
    for s in (60, 300, 600, 900):
        f[f"v_at_{s}s"] = float(np.interp(s, t, v))
    for s in (300, 900):
        f[f"temp_rise_{s}s"] = float(np.interp(s, t, T) - T[0])
    f["v_drop_60_900"] = f["v_at_60s"] - f["v_at_900s"]
    m = t <= 900
    f["v_mean_15min"] = float(v[m].mean())
    mm = (t >= 300) & (t <= 900)
    f["v_slope_300_900"] = float(np.polyfit(t[mm], v[mm], 1)[0] * 1000) if mm.sum() > 3 else 0.0
    f["temp_start"] = float(T[0])
    return f


def load_cell(name, path):
    cyc = loadmat(path, simplify_cells=True)[name]["cycle"]
    rows = []
    for c in cyc:
        if c["type"] != "discharge":
            continue
        d = c["data"]
        cap = np.atleast_1d(d.get("Capacity", np.nan))
        I = np.asarray(d["Current_measured"], float)
        t, v, T = (np.asarray(d[k], float) for k in ("Time", "Voltage_measured", "Temperature_measured"))
        load = I[I < -0.1]
        row = {"capacity": float(cap[0]) if cap.size else np.nan, "ambient": float(c["ambient_temperature"]),
               "current": float(np.median(-load)) if load.size else np.nan, "tmax": float(np.nanmax(T)),
               "square_wave": bool(load.size and (I > -0.1).mean() > 0.3 and t[-1] > 300)}
        row.update(partial_features(t, v, T) if len(t) > 10 and t[-1] > 600 else {k: np.nan for k in PARTIAL})
        rows.append(row)
    return pd.DataFrame(rows)


def clean(df):
    df = df[np.isfinite(df.capacity) & (df.capacity > 0.2)].reset_index(drop=True)
    if len(df) < 5:
        return df.assign(cap_s=df.capacity)
    ref = df.capacity.rolling(7, center=True, min_periods=3).median()
    df = df[df.capacity >= 0.85 * ref].reset_index(drop=True)
    df["cap_s"] = df.capacity.rolling(5, center=True, min_periods=1).median()
    return df


def fleet(min_cycles=20):
    out = {}
    for name, path in find_files().items():
        try:
            df = clean(load_cell(name, path))
        except Exception:
            continue
        if len(df) < min_cycles:
            continue
        df["cycle"] = np.arange(1, len(df) + 1)
        c0 = df.cap_s.iloc[:5].median()
        df["soh"] = df.cap_s / c0
        # exclusions (documented on the site): square-wave load profile (B0025-28), and cells whose first
        # runs are far below their later capacity, which corrupts the initial-capacity baseline
        if df.square_wave.mean() > 0.5 or df.soh.max() > 1.15:
            continue
        out[name] = {"df": df, "c0": c0, "ambient": float(df.ambient.mode()[0]), "current": float(df.current.median())}
    return out


def eol_cycle(df, soh_eol):
    hit = np.where(df.soh.values < soh_eol)[0]
    return int(df.cycle.values[hit[0]]) if len(hit) else None


if __name__ == "__main__":
    F = fleet()
    print(len(F), "cells kept")
    for n, c in F.items():
        df = c["df"]
        print(f"{n}: cycles={len(df):<4} c0={c['c0']:.3f} amb={c['ambient']:<4} I={c['current']:.1f}A "
              f"soh_end={df.soh.iloc[-1]:.3f} EOL80@{eol_cycle(df, 0.8)} EOL70@{eol_cycle(df, 0.7)} below1.4Ah@{next((int(x) for x, v in zip(df.cycle, df.cap_s) if v < 1.4), None)}")

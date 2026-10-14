"""Battery prognostics on the NASA PCoE fleet.

End of life (EOL): smoothed capacity below 80% of the cell's initial capacity (industry-standard SOH-80).
SOH model: estimates state of health from the first 15 min of a discharge (+ load current, ambient temp).
RUL model: remaining cycles to EOL from the capacity history. Both leave-one-cell-out.
Uncertainty: split-conformal 90% intervals; for each held-out cell the interval width comes ONLY from the
other cells' leave-one-out residuals (scaled by predicted RUL + 10), so coverage is an honest estimate.
"""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor

import battery_fleet as BF
from battery_load import load_battery

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data"
SEED, EOL_SOH, W, ALPHA = 42, 0.80, 10, 0.10
SHOWCASE = ["B0005", "B0006", "B0007", "B0018"]
r = lambda x, n=4: float(round(float(x), n))


def downsample(a, n):
    a = np.asarray(a, float)
    return a if len(a) <= n else a[np.linspace(0, len(a) - 1, n).round().astype(int)]


def rul_rows(name, c):
    df, eol = c["df"], BF.eol_cycle(c["df"], EOL_SOH)
    s = df.soh.values
    rows = []
    for k in range(W, (eol or len(df)) ):
        h = s[:k]
        rows.append({"cell": name, "cycle": k, "soh_now": h[-5:].mean(), "soh_min": h.min(),
                     "slope10": np.polyfit(np.arange(W), h[-W:], 1)[0], "slope30": np.polyfit(np.arange(min(k, 30)), h[-min(k, 30):], 1)[0],
                     "fade_rate": (1 - h[-5:].mean()) / k, "margin": h[-5:].mean() - EOL_SOH,
                     "ambient": c["ambient"], "current": c["current"], "rul": (eol - k) if eol else np.nan})
    return pd.DataFrame(rows)


RUL_F = ["cycle", "soh_now", "soh_min", "slope10", "slope30", "fade_rate", "margin", "ambient", "current"]
SOH_F = BF.PARTIAL + ["current", "ambient"]


def run():
    fleet = BF.fleet()
    eol_cells = [n for n, c in fleet.items() if (BF.eol_cycle(c["df"], EOL_SOH) or 0) >= 20]
    print(len(fleet), "cells,", len(eol_cells), "reach SOH-80 EOL:", eol_cells)

    # ---------------- RUL, leave-one-cell-out
    R = {n: rul_rows(n, fleet[n]) for n in eol_cells}
    preds, base = {}, {}
    for test in eol_cells:
        trn = pd.concat([R[n] for n in eol_cells if n != test])
        m = RandomForestRegressor(n_estimators=500, min_samples_leaf=3, random_state=SEED, n_jobs=-1).fit(trn[RUL_F].values, trn.rul.values)
        preds[test] = m.predict(R[test][RUL_F].values)
        s = fleet[test]["df"].soh.values; b = []
        for k in R[test].cycle:
            n = min(k, 30); a, c0 = np.polyfit(np.arange(n), s[k - n:k], 1); cur = a * (n - 1) + c0
            b.append(np.clip((EOL_SOH - cur) / a, 0, 400) if a < 0 else 400)
        base[test] = np.array(b)
    # conformal: normalised nonconformity |y - yhat| / (yhat + 10), quantile from the OTHER cells only
    rul_results, rul_series, covered, total = [], {}, 0, 0
    for test in eol_cells:
        scores = np.concatenate([np.abs(R[n].rul.values - preds[n]) / (preds[n] + 10) for n in eol_cells if n != test])
        q = np.quantile(scores, min(1, (1 - ALPHA) * (1 + 1 / len(scores))))
        y, yh = R[test].rul.values, preds[test]
        lo, hi = np.maximum(0, yh - q * (yh + 10)), yh + q * (yh + 10)
        cov = ((y >= lo) & (y <= hi)).mean(); covered += ((y >= lo) & (y <= hi)).sum(); total += len(y)
        c = fleet[test]
        rul_results.append({"battery": test, "ambient": c["ambient"], "current": r(c["current"], 1), "eol_cycle": BF.eol_cycle(c["df"], EOL_SOH),
                            "ml_mae": r(np.abs(y - yh).mean(), 1), "base_mae": r(np.abs(y - base[test]).mean(), 1),
                            "coverage": r(cov, 3), "mean_width": r((hi - lo).mean(), 1)})
        rul_series[test] = {"cycle": [int(x) for x in R[test].cycle], "true": [int(x) for x in y], "pred": [r(x, 1) for x in yh],
                            "lo": [r(x, 1) for x in lo], "hi": [r(x, 1) for x in hi], "baseline": [r(x, 1) for x in base[test]]}
    print("RUL LOCO MAE", np.mean([x["ml_mae"] for x in rul_results]).round(2), "baseline", np.mean([x["base_mae"] for x in rul_results]).round(2),
          "| conformal coverage", round(covered / total, 3))

    # ---------------- SOH from partial discharge, leave-one-cell-out over all usable cells
    D = {n: c["df"].dropna(subset=BF.PARTIAL) for n, c in fleet.items()}
    D = {n: d for n, d in D.items() if len(d) >= 15}
    soh_results, soh_series = [], {}
    for test in D:
        trn = pd.concat([D[n] for n in D if n != test])
        m = GradientBoostingRegressor(n_estimators=400, max_depth=3, learning_rate=0.05, subsample=0.8, random_state=SEED)
        m.fit(trn[SOH_F].values, trn.soh.values)
        p = m.predict(D[test][SOH_F].values); y = D[test].soh.values
        soh_results.append({"battery": test, "ambient": fleet[test]["ambient"], "current": r(fleet[test]["current"], 1),
                            "mae_pct": r(np.abs(p - y).mean() * 100, 2), "n": int(len(y))})
        soh_series[test] = {"cycle": [int(x) for x in D[test].cycle], "true": [r(x * 100, 2) for x in y], "pred": [r(x * 100, 2) for x in p]}
    print("SOH LOCO MAE %", np.mean([x["mae_pct"] for x in soh_results]).round(2), "over", len(soh_results), "cells")

    # ---------------- showcase cells (digital twin): per-cycle curves from the original loader
    cells = {}
    for b in SHOWCASE:
        dis, imp = load_battery(b)
        caps = np.array([d["capacity"] for d in dis])
        imp_after = np.array([x["after_discharge"] for x in imp])
        twin = []
        for k, d in enumerate(dis):
            j = np.where(imp_after <= k + 1)[0]; z = imp[j[-1]] if len(j) else (imp[0] if imp else None)
            twin.append({"t": [r(x / 60, 1) for x in downsample(d["time"], 36)], "v": [r(x, 3) for x in downsample(d["voltage"], 36)],
                         "T": [r(x, 1) for x in downsample(d["temp"], 36)], "Tmax": r(d["temp"].max(), 1), "dur": r(d["time"][-1] / 60, 1),
                         "R": r(z["Re"] + z["Rct"], 4) if z and np.isfinite(z["Re"] + z["Rct"]) else None})
        fdf = fleet[b]["df"]
        cells[b] = {"cycles": int(len(caps)), "c0": r(fleet[b]["c0"], 4), "eol_cycle": BF.eol_cycle(fdf, EOL_SOH),
                    "capacity": [r(x, 4) for x in caps], "soh": [r(x * 100, 2) for x in fdf.soh.values], "twin": twin,
                    "curves": {str(k + 1): {"t": twin[k]["t"], "v": twin[k]["v"]} for k in sorted({0, len(dis) // 2, len(dis) - 1})}}

    fleet_list = [{"cell": n, "ambient": c["ambient"], "current": r(c["current"], 1), "cycles": int(len(c["df"])), "c0": r(c["c0"], 3),
                   "eol_cycle": BF.eol_cycle(c["df"], EOL_SOH), "soh_end": r(c["df"].soh.iloc[-1] * 100, 1),
                   "soh": [r(x * 100, 1) for x in downsample(c["df"].soh.values, 80)], "cyc": [int(x) for x in downsample(c["df"].cycle.values, 80)]}
                  for n, c in fleet.items()]
    out = {"eol_soh": EOL_SOH, "rated_capacity": 2.0, "cells": cells, "fleet": fleet_list,
           "soh": {"features": SOH_F, "results": soh_results, "series": soh_series},
           "rul": {"features": RUL_F, "window": W, "alpha": ALPHA, "coverage": r(covered / total, 3), "results": rul_results, "series": rul_series},
           "excluded": "B0025-B0028 (square-wave load), cells with corrupted first runs (initial capacity far below later runs), and cells with fewer than 20 clean cycles"}
    (OUT / "battery_health.json").write_text(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    run()

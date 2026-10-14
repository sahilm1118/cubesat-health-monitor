"""Export the model artifacts the backend serves.

backend/models/fd_model.json   - fault detector (same file the browser uses)
backend/models/sim_data.json   - telemetry stretches for the FDIR simulator
backend/models/rul.json        - battery RUL forest (all 12 end-of-life cells) + conformal width,
                                 exported as plain arrays so the server never unpickles anything
Run after train_models.py:  python export_backend.py
"""
import json
import shutil
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

import battery_fleet as BF
import pipeline_batt as PB

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "backend" / "models"
OUT.mkdir(parents=True, exist_ok=True)

for f in ("fd_model.json", "sim_data.json"):
    shutil.copy(ROOT / "site" / "data" / f, OUT / f)

fleet = BF.fleet()
cells = [n for n, c in fleet.items() if (BF.eol_cycle(c["df"], PB.EOL_SOH) or 0) >= 20]
R = {n: PB.rul_rows(n, fleet[n]) for n in cells}

# conformal width from leave-one-cell-out residuals (same nonconformity score as the website)
scores = []
for test in cells:
    trn = pd.concat([R[n] for n in cells if n != test])
    m = RandomForestRegressor(n_estimators=200, min_samples_leaf=3, random_state=PB.SEED, n_jobs=-1).fit(trn[PB.RUL_F].values, trn.rul.values)
    yh = m.predict(R[test][PB.RUL_F].values)
    scores.append(np.abs(R[test].rul.values - yh) / (yh + 10))
scores = np.concatenate(scores)
q = float(np.quantile(scores, min(1, (1 - PB.ALPHA) * (1 + 1 / len(scores)))))

allrows = pd.concat(R.values())
final = RandomForestRegressor(n_estimators=200, min_samples_leaf=3, random_state=PB.SEED, n_jobs=-1).fit(allrows[PB.RUL_F].values, allrows.rul.values)
trees = []
for est in final.estimators_:
    t = est.tree_
    leaf = t.children_left == -1
    trees.append({"f": [int(x) if not l else -1 for x, l in zip(t.feature, leaf)],
                  "t": [float(f"{x:.7g}") if not l else 0 for x, l in zip(t.threshold, leaf)],
                  "l": t.children_left.tolist(), "r": t.children_right.tolist(),
                  "v": [round(float(x), 3) if l else 0 for x, l in zip(t.value[:, 0, 0], leaf)]})
# self-check: the exported arrays reproduce scikit-learn exactly
def walk(row):
    acc = 0.0
    for T in trees:
        n = 0
        while T["l"][n] != -1:
            n = T["l"][n] if row[T["f"][n]] <= T["t"][n] else T["r"][n]
        acc += T["v"][n]
    return acc / len(trees)
X = allrows[PB.RUL_F].values[:200]
diff = np.abs(final.predict(X) - np.array([walk(x) for x in X])).max()
assert diff < 0.05, diff

(OUT / "rul.json").write_text(json.dumps({"features": PB.RUL_F, "window": PB.W, "eol_soh": PB.EOL_SOH, "alpha": PB.ALPHA,
                                          "q": q, "cells": cells, "trees": trees}, separators=(",", ":")))
print(f"exported; RUL cells={len(cells)} conformal q={q:.3f} max export diff={diff:.4f}")
for f in OUT.iterdir():
    print(f.name, f.stat().st_size)

"""improve_models.py repeated over seeds (model seed + CV split seed) -> data/exp_v2/candidates_seeds.csv"""
import sys
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import average_precision_score

import improve_models as I
import fd_features as F

rows = []
Xs = {lvl: F.build(I.ds, I.bounds, I.med, I.iqr, lvl) for lvl in "AC"}
for seed in map(int, sys.argv[1:]):
    I.SEED = seed
    cv = StratifiedKFold(5, shuffle=True, random_state=seed)
    for (lvl, name), model in I.candidates().items():
        if lvl == "B" or name.startswith("MLP 64-32") and lvl == "C":
            continue                     # keep the models shown in the paper's table
        X = Xs[lvl]
        p_cv = cross_val_predict(model, X[I.tr].values, I.y[I.tr], cv=cv, method="predict_proba", n_jobs=1)[:, 1]
        model.fit(X[I.tr].values, I.y[I.tr])
        p_te = model.predict_proba(X[I.te].values)[:, 1]
        rows.append({"seed": seed, "features": lvl, "model": name, "cv_aucpr": average_precision_score(I.y[I.tr], p_cv),
                     **{f"test_{k}": v for k, v in I.metrics(I.y[I.te], p_te).items()}})
        print(seed, lvl, name, round(rows[-1]["test_f1"], 3), flush=True)
out = I.ROOT / "data" / "exp_v2" / "candidates_seeds.csv"
pd.DataFrame(rows).to_csv(out, mode="a", header=not out.exists(), index=False)

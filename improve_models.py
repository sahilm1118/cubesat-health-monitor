"""Model-improvement experiment for OPSSAT-AD. Selection is by 5-fold CV on the TRAIN split only;
the test split is scored once at the end for every candidate and reported as-is."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.neural_network import MLPClassifier
from sklearn.ensemble import HistGradientBoostingClassifier, RandomForestClassifier, ExtraTreesClassifier, VotingClassifier
from sklearn.svm import SVC
from sklearn.metrics import average_precision_score, f1_score, matthews_corrcoef, roc_auc_score, recall_score, precision_score, accuracy_score

import fd_features as F

ROOT = Path(__file__).resolve().parent.parent
OPS = ROOT / "data" / "raw" / "opssat"
SEED = 42

ds = pd.read_csv(OPS / "dataset.csv")
seg = pd.read_csv(OPS / "segments.csv")
ts = pd.to_datetime(seg.timestamp)
seg["t"] = (ts - ts.min()).dt.total_seconds()
bounds = seg.groupby("segment").t.agg(t0="min", t1="max")
med, iqr = F.channel_stats(ds)
tr, te = ds.train == 1, ds.train == 0
y = ds.anomaly.values


def mlp(h=(64, 32), a=1e-4):
    return make_pipeline(StandardScaler(), MLPClassifier(hidden_layer_sizes=h, alpha=a, max_iter=3000, early_stopping=True,
                                                         n_iter_no_change=30, random_state=SEED))


def candidates():
    return {
        ("A", "MLP 64-32 (current)"): mlp(),
        ("B", "MLP 64-32"): mlp(),
        ("C", "MLP 64-32"): mlp(),
        ("C", "MLP 128-64"): mlp((128, 64), 1e-3),
        ("C", "Gradient boosting"): HistGradientBoostingClassifier(max_iter=500, learning_rate=0.05, random_state=SEED),
        ("C", "Random forest"): RandomForestClassifier(n_estimators=600, class_weight="balanced", random_state=SEED, n_jobs=-1),
        ("C", "Extra trees"): ExtraTreesClassifier(n_estimators=800, class_weight="balanced", random_state=SEED, n_jobs=-1),
        ("C", "Ensemble (MLP + GB + SVM)"): VotingClassifier([
            ("mlp", mlp((128, 64), 1e-3)),
            ("gb", HistGradientBoostingClassifier(max_iter=500, learning_rate=0.05, random_state=SEED)),
            ("svm", make_pipeline(StandardScaler(), SVC(C=10, probability=True, class_weight="balanced", random_state=SEED)))], voting="soft"),
    }


def metrics(yt, p, thr=0.5):
    pr = (p >= thr).astype(int)
    return {"aucpr": average_precision_score(yt, p), "aucroc": roc_auc_score(yt, p), "f1": f1_score(yt, pr),
            "mcc": matthews_corrcoef(yt, pr), "precision": precision_score(yt, pr), "recall": recall_score(yt, pr),
            "accuracy": accuracy_score(yt, pr), "missed": int(((pr == 0) & (yt == 1)).sum()), "false_alarms": int(((pr == 1) & (yt == 0)).sum())}


if __name__ == "__main__":
    Xs = {lvl: F.build(ds, bounds, med, iqr, lvl) for lvl in "ABC"}
    cv = StratifiedKFold(5, shuffle=True, random_state=SEED)
    rows = []
    for (lvl, name), model in candidates().items():
        X = Xs[lvl]
        p_cv = cross_val_predict(model, X[tr].values, y[tr], cv=cv, method="predict_proba", n_jobs=-1)[:, 1]
        model.fit(X[tr].values, y[tr])
        p_te = model.predict_proba(X[te].values)[:, 1]
        rows.append({"features": lvl, "model": name, "cv_aucpr": average_precision_score(y[tr], p_cv),
                     **{f"test_{k}": v for k, v in metrics(y[te], p_te).items()}})
        print(f"{lvl} {name:<28} CV AUC-PR {rows[-1]['cv_aucpr']:.4f} | test AUC-PR {rows[-1]['test_aucpr']:.4f} F1 {rows[-1]['test_f1']:.3f} "
              f"MCC {rows[-1]['test_mcc']:.3f} missed {rows[-1]['test_missed']} FA {rows[-1]['test_false_alarms']}")
    pd.DataFrame(rows).to_csv(ROOT / "data" / "improve_results.csv", index=False)

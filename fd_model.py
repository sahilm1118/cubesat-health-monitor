"""Deployed fault detector: compact Extra Trees on feature set C, isotonic calibration and an
alarm threshold chosen on out-of-fold TRAINING predictions. Also: occlusion explanations,
anomaly signatures, and export of the whole model to JSON for the browser."""
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import f1_score

import fd_features as F

ROOT = Path(__file__).resolve().parent.parent
OPS = ROOT / "data" / "raw" / "opssat"
SEED = 42
ET_PARAMS = dict(n_estimators=120, max_depth=16, min_samples_leaf=2, class_weight="balanced", random_state=SEED, n_jobs=-1)


def load():
    ds = pd.read_csv(OPS / "dataset.csv")
    seg = pd.read_csv(OPS / "segments.csv")
    ts = pd.to_datetime(seg.timestamp)
    seg["t"] = (ts - ts.min()).dt.total_seconds()
    bounds = seg.groupby("segment").t.agg(t0="min", t1="max")
    med, iqr = F.channel_stats(ds)
    X = F.build(ds, bounds, med, iqr, "C")
    return ds, seg, bounds, med, iqr, X


class Detector:
    def __init__(self, X, y, train_mask):
        self.cols = list(X.columns)
        Xtr, ytr = X[train_mask].values, y[train_mask]
        cv = StratifiedKFold(5, shuffle=True, random_state=SEED)
        self.oof_raw = cross_val_predict(ExtraTreesClassifier(**ET_PARAMS), Xtr, ytr, cv=cv, method="predict_proba")[:, 1]
        self.iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(self.oof_raw, ytr)
        oof_cal = self.iso.predict(self.oof_raw)
        grid = np.round(np.arange(0.1, 0.91, 0.01), 2)
        f1s = [f1_score(ytr, (oof_cal >= t).astype(int)) for t in grid]
        self.threshold = float(grid[int(np.argmax(f1s))])
        self.oof_cal, self.y_train = oof_cal, ytr
        self.model = ExtraTreesClassifier(**ET_PARAMS).fit(Xtr, ytr)
        # flat arrays for fast vectorised evaluation (the same walk the browser does)
        self._trees = []
        for est in self.model.estimators_:
            t = est.tree_
            v = t.value[:, 0, :]
            self._trees.append((t.feature.copy(), t.threshold.copy(), t.children_left.copy(), t.children_right.copy(), v[:, 1] / v.sum(axis=1)))

    def raw(self, Xv):
        Xv = np.asarray(Xv, float)
        rows = np.arange(len(Xv))
        acc = np.zeros(len(Xv))
        for f, th, L, R, p in self._trees:
            node = np.zeros(len(Xv), dtype=np.int64)
            while True:
                leaf = L[node] == -1
                if leaf.all():
                    break
                go_left = Xv[rows, np.where(leaf, 0, f[node])] <= th[node]
                node = np.where(leaf, node, np.where(go_left, L[node], R[node]))
            acc += p[node]
        return acc / len(self._trees)

    def proba(self, Xv):
        return self.iso.predict(self.raw(Xv))

    def export(self):
        trees = []
        for est in self.model.estimators_:
            t = est.tree_
            v = t.value[:, 0, :]
            p1 = v[:, 1] / v.sum(axis=1)
            leaf = t.children_left == -1
            trees.append({"f": [int(x) if not l else -1 for x, l in zip(t.feature, leaf)],
                          "t": [float(f"{x:.7g}") if not l else 0 for x, l in zip(t.threshold, leaf)],
                          "l": t.children_left.tolist(), "r": t.children_right.tolist(),
                          "p": [round(float(x), 4) if l else 0 for x, l in zip(p1, leaf)]})
        return {"cols": self.cols, "trees": trees, "threshold": self.threshold,
                "iso_x": [float(x) for x in self.iso.X_thresholds_], "iso_y": [float(y) for y in self.iso.y_thresholds_]}


# ---------------------------------------------------------------- explanations & signatures
FAMILY = {"kurtosis": "spike", "skew": "spike", "diff_var": "noise", "diff2_var": "noise", "diff_peaks": "noise",
          "diff2_peaks": "noise", "var": "amplitude", "std": "amplitude", "var_div_duration": "amplitude",
          "var_div_len": "amplitude", "mean": "offset", "gaps_squared": "data_gap", "n_peaks": "waveform",
          "smooth10_n_peaks": "waveform", "smooth20_n_peaks": "waveform", "duration": "timing", "len": "timing",
          "len_weighted": "timing", "sampling": "timing", "has_prev": "change"}


def family_of(col):
    if col.startswith("ctx_"):
        return "change"
    return FAMILY.get(col.replace("rel_", ""), "subtle")


GROUPS = ["spike", "noise", "amplitude", "offset", "data_gap", "waveform", "timing", "change"]
REP = {"spike": ["kurtosis", "skew"], "noise": ["diff_var", "diff2_var", "diff_peaks", "diff2_peaks"],
       "amplitude": ["std", "var", "var_div_len"], "offset": ["mean"], "data_gap": ["gaps_squared"],
       "waveform": ["n_peaks", "smooth10_n_peaks"], "timing": ["duration"], "change": ["std", "mean"]}


def occlusion(det, Xv, base_med):
    """Group occlusion: contribution of a measurement family = drop in the forest's raw vote share
    when ALL columns of that family are reset to the channel's nominal values (base features:
    channel nominal median; rel_/ctx_ features: 0). Families avoid redundancy hiding evidence."""
    Xv = np.asarray(Xv, float)
    n, k = Xv.shape
    G = len(GROUPS)
    big = np.repeat(Xv[None, :, :], G + 1, axis=0)
    for g, name in enumerate(GROUPS):
        for j, c in enumerate(det.cols):
            if c == "has_prev" or family_of(c) != name:
                continue
            big[g + 1, :, j] = 0.0 if (c.startswith("rel_") or c.startswith("ctx_")) else base_med[:, j]
    P = det.raw(big.reshape(-1, k)).reshape(G + 1, n)
    return det.iso.predict(P[0]), (P[0][None, :] - P[1:]).T


def signature(rel, contrib_by_family, phys):
    """Name the anomaly type. Physical rules in priority order (first match wins); if none fires,
    the measurement family the model weighed most.
    rel: rel_* z-scores (IQR units vs channel nominal); phys: max_gap, flat_frac, outlier_n, outlier_max, std_ratio."""
    z = lambda k: rel.get("rel_" + k, 0.0)
    if phys["max_gap"] >= 5:
        return "data_gap"
    if phys["flat_frac"] >= 0.3 or phys["std_ratio"] < 0.15:
        return "stuck"
    if 1 <= phys["outlier_n"] <= 9 and phys["outlier_max"] > 15:
        return "spike"
    if z("diff_var") > 3 or z("diff2_var") > 3:
        return "noise"
    if abs(z("mean")) > 3:
        return "offset"
    if z("var") > 3 or z("std") > 3:
        return "amplitude"
    if abs(z("n_peaks")) > 2 or abs(z("diff_peaks")) > 2:
        return "waveform"
    if contrib_by_family and max(contrib_by_family.values()) > 0.01:
        return max(contrib_by_family, key=contrib_by_family.get)
    return "subtle"


def nominal_medians(X, ds):
    """channel x column medians of the model inputs over NOMINAL TRAINING segments"""
    m = (ds.train == 1) & (ds.anomaly == 0)
    return X[m].groupby(ds.loc[m, "channel"].values).median()


def explain(det, Xrows, channels, raw_feats, nom_med, med):
    """probability, family contributions, signature and top reasons for each row.
    Xrows: DataFrame of model inputs; channels: channel id per row; raw_feats: list of dicts with the
    untransformed base features of each row (for display and the stuck-sensor ratio)."""
    base = nom_med.loc[list(channels)].values
    p, C = occlusion(det, Xrows.values, base)
    out = []
    for i in range(len(Xrows)):
        fam = {g: float(C[i, gi]) for gi, g in enumerate(GROUPS) if C[i, gi] > 0}
        rel = {c: float(Xrows.iloc[i][c]) for c in det.cols if c.startswith("rel_")}
        ms = med.loc[channels[i], "std"]
        rf = raw_feats[i]
        phys = {k: rf[k] for k in ("max_gap", "flat_frac", "outlier_n", "outlier_max")}
        phys["std_ratio"] = float(rf["std"] / ms) if ms else 1.0
        why = []
        for g in sorted(fam, key=fam.get, reverse=True)[:3]:
            if fam[g] < 0.01:
                continue
            cands = [f for f in REP[g] if ("rel_" + f) in rel] or REP[g]
            f = max(cands, key=lambda q: abs(rel.get("rel_" + q, 0.0)))
            why.append({"g": g, "c": round(fam[g], 3), "f": f, "z": round(rel.get("rel_" + f, 0.0), 2),
                        "val": float(f"{raw_feats[i][f]:.4g}"), "med": float(f"{med.loc[channels[i], f]:.4g}") if f in med.columns else None})
        out.append({"p": float(p[i]), "sig": signature(rel, fam, phys), "why": why})
    return out

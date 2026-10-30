"""Paper v2 experiments: multi-seed evaluation, synthetic-fault augmentation and learned fusion of
the ML detector with the limit check.

Test faults always come from fault_injection.inject (the six original types). Augmentation and the
fusion model only ever see TRAIN_TYPES below, which are generated differently, and only training-split
telemetry, so the test is not circular.

Usage:  python experiments_v2.py SEED [SEED ...]   -> data/exp_v2/seed_<s>.json
"""
import json, sys, time
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import StratifiedGroupKFold, StratifiedKFold
from sklearn.metrics import f1_score, matthews_corrcoef, precision_score, recall_score, average_precision_score, roc_auc_score

import fd_features as F
import fd_model as M
import fault_injection as FI

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "exp_v2"
TRAIN_TYPES = ["drift", "partial_step", "partial_gain", "impulsive", "partial_hold", "scatter_drop", "sine"]


# ------------------------------------------------------------------ training-only fault generator
def inject_train(kind, v, t, rng):
    v, t = np.array(v, float), np.array(t, float)
    n = len(v)
    rngv = (v.max() - v.min()) or (abs(v.mean()) + 1e-9)
    sd = v.std() or rngv / 4
    a = int(rng.integers(n // 6, n // 2))
    if kind == "drift":            # gradual ramp, not a step
        v[a:] += rng.choice([-1, 1]) * rng.uniform(0.8, 2.5) * rngv * np.linspace(0, 1, n - a)
    elif kind == "partial_step":   # level change part-way through the window
        v[a:] += rng.choice([-1, 1]) * rng.uniform(0.5, 2.0) * rngv
    elif kind == "partial_gain":   # gain change on a sub-interval only
        b = int(rng.integers(a + n // 6, n + 1)); m = v[a:b].mean()
        v[a:b] = m + (v[a:b] - m) * rng.uniform(1.5, 3.0)
    elif kind == "impulsive":      # sparse heavy-tailed noise
        k = max(2, int(n * rng.uniform(0.05, 0.15))); idx = rng.choice(n, k, replace=False)
        v[idx] += rng.laplace(0, rng.uniform(0.5, 1.5) * sd, k)
    elif kind == "partial_hold":   # value held for a chunk, then recovers
        b = min(n, a + int(n * rng.uniform(0.1, 0.3))); v[a:b] = v[a]
    elif kind == "scatter_drop":   # scattered sample loss (irregular sampling), not one gap
        keep = np.sort(rng.choice(n, int(n * rng.uniform(0.6, 0.8)), replace=False))
        keep[0], keep[-1] = 0, n - 1
        v, t = v[np.unique(keep)], t[np.unique(keep)]
    elif kind == "sine":           # periodic interference
        f = rng.uniform(2, 12) / n
        v += rng.uniform(0.3, 1.0) * sd * np.sin(2 * np.pi * f * np.arange(n) + rng.uniform(0, 6.28))
    return v, t


# ------------------------------------------------------------------ helpers
def et(seed):
    return ExtraTreesClassifier(**{**M.ET_PARAMS, "random_state": seed})


def exceedance(env, ch, v):
    lo, hi = env[ch]; w = (hi - lo) or 1e-12
    return max(0.0, (v.max() - hi) / w, (lo - v.min()) / w)


def fus_feats(p, e):
    p = np.clip(np.asarray(p, float), 1e-4, 1 - 1e-4)
    e = np.asarray(e, float)
    return np.c_[np.log(p / (1 - p)), np.log1p(100 * e), (e > 0).astype(float)]


def det_metrics(y, p, thr):
    pr = (p >= thr).astype(int)
    return {"precision": precision_score(y, pr), "recall": recall_score(y, pr), "f1": f1_score(y, pr),
            "mcc": matthews_corrcoef(y, pr), "aucpr": average_precision_score(y, p), "aucroc": roc_auc_score(y, p)}


class AugDetector:
    """Same model and calibration recipe as fd_model.Detector, trained on real training segments plus
    synthetic-fault copies of nominal training segments. Folds are grouped by source segment (no leakage);
    isotonic calibration and the threshold use REAL training rows only."""
    def __init__(self, Xr, yr, gr, Xs, gs, seed):
        X = np.r_[Xr, Xs]; y = np.r_[yr, np.ones(len(Xs), int)]; g = np.r_[gr, gs]
        real = np.r_[np.ones(len(Xr), bool), np.zeros(len(Xs), bool)]
        oof = np.zeros(len(X))
        for tr, va in StratifiedGroupKFold(5, shuffle=True, random_state=seed).split(X, y, g):
            oof[va] = et(seed).fit(X[tr], y[tr]).predict_proba(X[va])[:, 1]
        self.iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(oof[real], y[real])
        cal = self.iso.predict(oof[real]); grid = np.round(np.arange(0.1, 0.91, 0.01), 2)
        self.threshold = float(grid[int(np.argmax([f1_score(y[real], (cal >= t).astype(int)) for t in grid]))])
        self.model = et(seed).fit(X, y)

    def proba(self, X):
        return self.iso.predict(self.model.predict_proba(np.asarray(X, float))[:, 1])


# ------------------------------------------------------------------ one seed
def run(seed, n_epi=40):
    t0 = time.time()
    M.SEED = seed; M.ET_PARAMS = {**M.ET_PARAMS, "random_state": seed}
    ds, seg, bounds, med, iqr, X = M.load()
    y = ds.anomaly.values; tr, te = (ds.train == 1).values, (ds.train == 0).values
    det = M.Detector(X, y, tr)
    tel = FI.Telemetry(ds, seg)
    cols = det.cols
    stats = (med, iqr)
    check, env = FI.limit_checker(tel, [int(s) for s in ds[(ds.train == 1) & (ds.anomaly == 0)].segment])
    out = {"seed": seed, "threshold": det.threshold}
    out["detect"] = det_metrics(y[te], det.proba(X[te].values), det.threshold)

    def feat(sid, v=None, t=None, prev_feat="real"):
        ch, samp = tel.ds.loc[sid, "channel"], tel.ds.loc[sid, "sampling"]
        if v is None:
            v, t = tel.raw[sid]
        p_id, contig = tel.prev(sid)
        pf = (tel.base[p_id] if p_id is not None else None) if isinstance(prev_feat, str) else prev_feat
        f, row = FI.featurize(v, t, samp, ch, pf, contig, med, iqr, cols)
        return f, row.values[0], exceedance(env, ch, np.asarray(v, float)), check(ch, np.asarray(v, float))

    rng = np.random.default_rng(10_000 + seed)
    seg_ids = ds.segment.values
    nom_tr = [int(s) for s in ds[(ds.train == 1) & (ds.anomaly == 0)].segment]

    # ---- synthetic training faults (2 per nominal training segment)
    syn_X, syn_g, syn_e = [], [], []
    for s in nom_tr:
        for _ in range(2):
            v, t = inject_train(TRAIN_TYPES[rng.integers(len(TRAIN_TYPES))], *tel.raw[s], rng)
            _, row, e, _ = feat(s, v, t)
            syn_X.append(row); syn_g.append(s); syn_e.append(e)
    syn_X, syn_g, syn_e = np.array(syn_X), np.array(syn_g), np.array(syn_e)

    # ---- augmented detector
    Xtr = X[tr].values
    aug = AugDetector(Xtr, y[tr], seg_ids[tr], syn_X, syn_g, seed)
    out["detect_aug"] = det_metrics(y[te], aug.proba(X[te].values), aug.threshold)
    out["threshold_aug"] = aug.threshold

    # ---- fusion training data: cross-fitted ML probabilities on training-split windows
    folds = list(StratifiedKFold(5, shuffle=True, random_state=seed).split(Xtr, y[tr]))
    fold_of = {}
    for k, (_, va) in enumerate(folds):
        for i in va:
            fold_of[int(seg_ids[tr][i])] = k
    fold_models = [et(seed).fit(Xtr[a], y[tr][a]) for a, _ in folds]
    real_e = np.array([exceedance(env, tel.ds.loc[s, "channel"], tel.raw[s][0]) for s in seg_ids[tr]])
    real_raw = np.zeros(len(Xtr))
    for k, (_, va) in enumerate(folds):
        real_raw[va] = fold_models[k].predict_proba(Xtr[va])[:, 1]
    syn_raw = np.zeros(len(syn_X))
    for k in range(5):
        m = np.array([fold_of[int(g)] == k for g in syn_g])
        if m.any():
            syn_raw[m] = fold_models[k].predict_proba(syn_X[m])[:, 1]
    fp = det.iso.predict(np.r_[real_raw, syn_raw]); fe = np.r_[real_e, syn_e]
    fy = np.r_[y[tr], np.ones(len(syn_X), int)]
    fus = LogisticRegression(class_weight="balanced", C=1.0).fit(fus_feats(fp, fe), fy)
    s_tr = fus.predict_proba(fus_feats(fp, fe))[:, 1]
    clean = np.r_[y[tr] == 0, np.zeros(len(syn_X), bool)]
    ai_fa = float((fp[clean] >= det.threshold).mean())          # ML detector's training false-alarm rate
    cand = np.sort(np.unique(s_tr))
    thr_f = float(next(c for c in cand if (s_tr[clean] >= c).mean() <= ai_fa))
    out["fusion"] = {"coef": fus.coef_[0].tolist(), "intercept": float(fus.intercept_[0]), "threshold": thr_f,
                     "train_fa_budget": ai_fa}
    fprob = lambda p, e: fus.predict_proba(fus_feats(p, e))[:, 1]
    # real test-split anomalies, single window
    te_e = np.array([exceedance(env, tel.ds.loc[s, "channel"], tel.raw[s][0]) for s in seg_ids[te]])
    te_lim = np.array([check(tel.ds.loc[s, "channel"], tel.raw[s][0]) for s in seg_ids[te]], float)
    p_te = det.proba(X[te].values)
    out["detect_limit"] = det_metrics(y[te], te_lim, 0.5)
    out["detect_or"] = det_metrics(y[te], np.maximum((p_te >= det.threshold).astype(float), te_lim), 0.5)
    out["detect_fusion"] = det_metrics(y[te], fprob(p_te, te_e), thr_f)

    # ---- single-window injected test faults (original generator)
    ted = ds[te]
    clean_test = [int(s) for s, a, p in zip(ted.segment, ted.anomaly, (p_te >= det.threshold)) if a == 0 and not p]
    rng_v = np.random.default_rng(20_000 + seed)
    pick = rng_v.choice(clean_test, size=min(120, len(clean_test)), replace=False)
    inj = {k: {"ai": [], "aug": [], "lim": [], "or": [], "fus": []} for k in ["none"] + FI.TYPES}
    for s in pick:
        for kind in ["none"] + FI.TYPES:
            v, t = tel.raw[s] if kind == "none" else FI.inject(kind, *tel.raw[s], rng_v)
            _, row, e, lf = feat(s, v, t)
            p, pa = det.proba(row[None])[0], aug.proba(row[None])[0]
            d = inj[kind]
            d["ai"].append(p >= det.threshold); d["aug"].append(pa >= aug.threshold); d["lim"].append(lf)
            d["or"].append((p >= det.threshold) or lf); d["fus"].append(fprob([p], [e])[0] >= thr_f)
    out["single_window"] = {k: {w: float(np.mean(v)) for w, v in d.items()} for k, d in inj.items()}

    # ---- closed-loop FDIR episodes (original generator, test split)
    test_order = {ch: [s for s in tel.order[ch] if not tel.ds.loc[s, "train"]] for ch in tel.order}
    chans = [c for c in test_order if len(test_order[c]) >= 30]
    rng2 = np.random.default_rng(30_000 + seed)
    fdir = {}
    for kind in FI.TYPES:
        traces = []
        for _ in range(n_epi):
            ch = chans[rng2.integers(len(chans))]; ids = test_order[ch]
            k = int(rng2.integers(3, 7)); start = int(rng2.integers(8, len(ids) - k - 10))
            seq = ids[max(0, start - 8): start + k + 10]; s_idx = min(8, start)
            prev_mod, rows, es, lfs = {}, [], [], []
            for i, sid in enumerate(seq):
                v, t = tel.raw[sid]
                if s_idx <= i < s_idx + k:
                    v, t = FI.inject(kind, v, t, rng2)
                p_id, _ = tel.prev(sid)
                pf = prev_mod.get(p_id, tel.base.get(p_id)) if p_id is not None else None
                f, row, e, lf = feat(sid, v, t, prev_feat=pf)
                prev_mod[sid] = f; rows.append(row); es.append(e); lfs.append(lf)
            rows = np.array(rows); p = det.proba(rows); pa = aug.proba(rows); pf_ = fprob(p, es)
            sm = {w: FI.FDIR() for w in ["ai", "aug", "lim", "hy", "fus"]}
            trace = []
            for i, sid in enumerate(seq):
                fa, fg, fl, ff = p[i] >= det.threshold, pa[i] >= aug.threshold, lfs[i], pf_[i] >= thr_f
                w = {"label": int(tel.ds.loc[sid, "anomaly"])}
                for who, flag, pp in (("ai", fa, p[i]), ("aug", fg, pa[i]), ("lim", fl, 1.0),
                                      ("hy", fa or fl, max(p[i], 1.0 if fl else 0.0)), ("fus", ff, pf_[i])):
                    w[f"{who}_flag"] = int(flag); w[f"{who}_level"] = sm[who].step(flag, pp)
                trace.append(w)
            traces.append((trace, s_idx, k))
        fdir[kind] = {who: FI.summarize(traces, who) for who in ["ai", "aug", "lim", "hy", "fus"]}
    out["fdir"] = fdir
    out["seconds"] = round(time.time() - t0, 1)
    return out


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for s in map(int, sys.argv[1:]):
        r = run(s)
        (OUT / f"seed_{s}.json").write_text(json.dumps(r, indent=1, default=float))
        d = {w: round(np.mean([r["fdir"][k][w]["detected"] for k in FI.TYPES]), 3) for w in ["ai", "aug", "lim", "hy", "fus"]}
        fa = {w: round(np.mean([r["fdir"][k][w]["false_alarm_per_100"] for k in FI.TYPES]), 2) for w in ["ai", "aug", "lim", "hy", "fus"]}
        print(f"seed {s} ({r['seconds']}s) F1 {r['detect']['f1']:.3f} aug {r['detect_aug']['f1']:.3f} fus {r['detect_fusion']['f1']:.3f} | det {d} | FA {fa}", flush=True)

"""Fault-detection pipeline: deployed model, calibration, explanations, signature validation,
FDIR Monte Carlo, and every JSON the website needs."""
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.metrics import (accuracy_score, precision_score, recall_score, f1_score, matthews_corrcoef, roc_auc_score,
                             average_precision_score, confusion_matrix, roc_curve, precision_recall_curve, brier_score_loss)
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

import fd_features as F
import fd_model as M
import fault_injection as FI
from features import segment_features

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "site" / "data"
SEED = 42
CHANNEL_INFO = {
    "CADC0872": ("Magnetometer X", "ADCS"), "CADC0873": ("Magnetometer Y", "ADCS"), "CADC0874": ("Magnetometer Z", "ADCS"),
    "CADC0884": ("Photodiode 1", "Sun sensing"), "CADC0886": ("Photodiode 2", "Sun sensing"), "CADC0888": ("Photodiode 3", "Sun sensing"),
    "CADC0890": ("Photodiode 4", "Sun sensing"), "CADC0892": ("Photodiode 5", "Sun sensing"), "CADC0894": ("Photodiode 6", "Sun sensing"),
}
r = lambda x, n=4: float(round(float(x), n))


def downsample(a, n):
    a = np.asarray(a, float)
    return a if len(a) <= n else a[np.linspace(0, len(a) - 1, n).round().astype(int)]


def metric_row(name, kind, y, p, thr, cv=None):
    pr = (p >= thr).astype(int)
    return {"model": name, "type": kind, "cv_aucpr": r(cv) if cv is not None else None,
            "accuracy": r(accuracy_score(y, pr)), "precision": r(precision_score(y, pr)), "recall": r(recall_score(y, pr)),
            "f1": r(f1_score(y, pr)), "mcc": r(matthews_corrcoef(y, pr)), "aucroc": r(roc_auc_score(y, p)), "aucpr": r(average_precision_score(y, p))}


def reliability(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1); out = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (p >= a) & (p < b if b < 1 else p <= b)
        if m.sum():
            out.append({"bin": r((a + b) / 2, 2), "pred": r(p[m].mean(), 3), "obs": r(y[m].mean(), 3), "n": int(m.sum())})
    return out


def run():
    ds, seg, bounds, med, iqr, X = M.load()
    y = ds.anomaly.values
    tr, te = (ds.train == 1).values, (ds.train == 0).values
    det = M.Detector(X, y, tr)
    thr = det.threshold
    raw_te, p_te = det.raw(X[te].values), det.proba(X[te].values)
    nom_med = M.nominal_medians(X, ds)
    ex_fn = {"stats": (med, iqr), "fn": lambda Xr, chs, fs: M.explain(det, Xr, chs, fs, nom_med, med)}
    print(f"threshold {thr}  test AUC-PR {average_precision_score(y[te], p_te):.4f}  F1 {f1_score(y[te], (p_te >= thr).astype(int)):.3f}")

    # ---- model comparison (improve_models.py results, CV-selected) + deployed model
    imp = pd.read_csv(ROOT / "data" / "improve_results.csv")
    feat_name = {"A": "19 features", "B": "+ channel-relative", "C": "+ channel-relative + temporal context"}
    results = [metric_row("Extra Trees, 120 trees (deployed, calibrated)", "Deployed", y[te], p_te, thr, cv=average_precision_score(det.y_train, det.oof_raw))]
    for _, rw in imp.iterrows():
        results.append({"model": f"{rw.model} · {feat_name[rw.features]}", "type": "Candidate", "cv_aucpr": r(rw.cv_aucpr),
                        "accuracy": r(rw.test_accuracy), "precision": r(rw.test_precision), "recall": r(rw.test_recall), "f1": r(rw.test_f1),
                        "mcc": r(rw.test_mcc), "aucroc": r(rw.test_aucroc), "aucpr": r(rw.test_aucpr)})
    best_name = results[0]["model"]
    pred_te = (p_te >= thr).astype(int)
    cm = confusion_matrix(y[te], pred_te).tolist()
    fpr, tpr, _ = roc_curve(y[te], p_te); prec, rec, _ = precision_recall_curve(y[te], p_te)
    calib = {"brier_raw": r(brier_score_loss(y[te], raw_te)), "brier_cal": r(brier_score_loss(y[te], p_te)),
             "raw": reliability(y[te], raw_te), "cal": reliability(y[te], p_te), "threshold": thr}

    # ---- explanations for every test segment
    tel = FI.Telemetry(ds, seg)
    ted = ds[te].reset_index(drop=True)
    exps = M.explain(det, X[te].reset_index(drop=True), list(ted.channel), [tel.base[s] for s in ted.segment], nom_med, med)
    fam_imp = {}
    for e in exps:
        for w in e["why"]:
            fam_imp[w["g"]] = fam_imp.get(w["g"], 0) + w["c"]
    importance = sorted(fam_imp.items(), key=lambda t: -t[1])[:12]

    per_channel = []
    ted = ted.assign(score=p_te, pred=pred_te)
    for ch, g in ted.groupby("channel"):
        per_channel.append({"channel": ch, "name": CHANNEL_INFO[ch][0], "subsystem": CHANNEL_INFO[ch][1], "segments": int(len(g)),
                            "anomalies": int(g.anomaly.sum()), "detected": int(((g.pred == 1) & (g.anomaly == 1)).sum()),
                            "false_alarms": int(((g.pred == 1) & (g.anomaly == 0)).sum())})

    # ---- replay (downsampled) for the live monitor
    raw = {s: g for s, g in seg.sort_values(["segment", "t"]).groupby("segment")}
    ts_abs = pd.to_datetime(seg.timestamp)
    seg_start = seg.assign(ts=ts_abs).groupby("segment").ts.min()
    replay = {}
    for i, rw in ted.iterrows():
        s = raw[rw.segment]; e = exps[i]
        replay.setdefault(rw.channel, {"name": CHANNEL_INFO[rw.channel][0], "subsystem": CHANNEL_INFO[rw.channel][1], "segments": []})["segments"].append({
            "id": int(rw.segment), "start": seg_start[rw.segment].strftime("%Y-%m-%d %H:%M:%S"), "duration_s": int(rw.duration),
            "samples": int(len(s)), "label": int(rw.anomaly), "score": r(rw.score, 3), "pred": int(rw.pred), "sig": e["sig"],
            "why": e["why"],
            "v": [float(f"{v:.5g}") for v in downsample(s.value.values, 90)]})
    for ch in replay:
        replay[ch]["segments"].sort(key=lambda x: x["start"])

    # ---- signature validation + FDIR Monte Carlo on injected faults
    # fresh seeds (11, 12) that played no part in developing the signature rules (7/8 were used while developing them)
    rng = np.random.default_rng(11)
    clean_test = [int(s) for s, a, p in zip(ted.segment, ted.anomaly, ted.pred) if a == 0 and p == 0]
    pick = list(np.random.default_rng(11).choice(clean_test, size=min(120, len(clean_test)), replace=False))
    val = FI.validate_signatures(det, tel, ex_fn, pick, rng)
    inj = val[val.injected != "none"]
    sig_validation = {
        "n_segments": len(pick), "types": FI.TYPES, "type_name": FI.TYPE_NAME,
        "control_false_alarm": r(val[val.injected == "none"].flag.mean(), 3),
        "detection": {k: r(g.flag.mean(), 3) for k, g in inj.groupby("injected")},
        "sig_accuracy": {k: r((g[g.flag == 1].sig == k).mean(), 3) if g.flag.sum() else None for k, g in inj.groupby("injected")},
        "confusion": {k: g[g.flag == 1].sig.value_counts().to_dict() for k, g in inj.groupby("injected")},
    }
    print("injected detection:", sig_validation["detection"]); print("signature accuracy:", sig_validation["sig_accuracy"])

    check, envelope = FI.limit_checker(tel, [int(s) for s in ds[(ds.train == 1) & (ds.anomaly == 0)].segment])
    test_order = {ch: [s for s in tel.order[ch] if not tel.ds.loc[s, "train"]] for ch in tel.order}
    fdir = {}
    rng2 = np.random.default_rng(12)
    chans = [c for c in test_order if len(test_order[c]) >= 30]
    for kind in FI.TYPES:
        traces = []
        for _ in range(40):
            ch = chans[rng2.integers(len(chans))]; ids = test_order[ch]
            k = int(rng2.integers(3, 7)); start = int(rng2.integers(8, len(ids) - k - 10))
            tr_, s_idx = FI.run_episode(det, tel, ex_fn, check, ids, start, k, kind, rng2)
            traces.append((tr_, s_idx, k))
        fdir[kind] = {"ai": FI.summarize(traces, "ai"), "limit": FI.summarize(traces, "lim"), "hybrid": FI.summarize(traces, "hy")}
        print(kind, "AI", {k: (round(v, 2) if isinstance(v, float) else v) for k, v in fdir[kind]["ai"].items()},
              "| LIMIT", {k: (round(v, 2) if isinstance(v, float) else v) for k, v in fdir[kind]["limit"].items()},
              "| HYBRID", {k: (round(v, 2) if isinstance(v, float) else v) for k, v in fdir[kind]["hybrid"].items()})

    # ---- browser exports: model, stats, playground segments, simulator stretches
    model_js = det.export()
    model_js.update({
        "base": F.BASE, "rel": F.REL, "ctx": F.CTX,
        "med": {ch: {f: float(med.loc[ch, f]) for f in F.REL + ["std"]} for ch in med.index},
        "iqr": {ch: {f: float(iqr.loc[ch, f]) for f in F.REL} for ch in iqr.index},
        "nom": {ch: [float(x) for x in nom_med.loc[ch, det.cols].values] for ch in nom_med.index},
        "envelope": {ch: [float(a), float(b)] for ch, (a, b) in envelope.items()},
    })
    def full(sid):
        v, t = tel.raw[sid]; p_id, contig = tel.prev(sid)
        return {"id": int(sid), "channel": tel.ds.loc[sid, "channel"], "name": CHANNEL_INFO[tel.ds.loc[sid, "channel"]][0],
                "sampling": float(tel.ds.loc[sid, "sampling"]), "label": int(tel.ds.loc[sid, "anomaly"]),
                "v": [float(f"{x:.6g}") for x in v], "dt": [r(x, 2) for x in np.diff(t)],
                "prev": {k: float(tel.base[p_id][k]) for k in F.CTX} if p_id is not None else None, "contig": bool(contig)}
    play_ids = []
    for ch in CHANNEL_INFO:
        cand = [s for s in clean_test if tel.ds.loc[s, "channel"] == ch and 60 <= len(tel.raw[s][0]) <= 700]
        play_ids += cand[:2]
    playground = [full(s) for s in play_ids]
    stretches = []
    for ch in ["CADC0872", "CADC0873", "CADC0888", "CADC0892"]:
        ids = test_order[ch]
        best = max(range(8, len(ids) - 24), key=lambda i: -sum(tel.ds.loc[s, "anomaly"] for s in ids[i - 8:i + 16]))
        stretches.append({"channel": ch, "name": CHANNEL_INFO[ch][0], "windows": [full(s) for s in ids[best - 8:best + 16]]})

    # JS parity check data: python features / inputs / probability for a sample of segments
    chk_ids = list(np.random.default_rng(1).choice(list(ds.segment), 150, replace=False))
    js_check = []
    for s in chk_ids:
        fs = full(s); f = tel.base[s]
        Xrow = X[ds.segment.values == s]
        e = M.explain(det, Xrow.reset_index(drop=True), [fs["channel"]], [f], nom_med, med)[0]
        js_check.append({**fs, "py_feat": {k: float(f[k]) for k in F.BASE + ["max_gap", "flat_frac", "outlier_n", "outlier_max"]},
                         "py_x": [float(x) for x in Xrow.values[0]], "py_p": float(det.proba(Xrow.values)[0]), "py_sig": e["sig"], "py_why": e["why"]})
    (ROOT / "data" / "js_check.json").write_text(json.dumps(js_check))

    # ---- timeline + explorer (unchanged definitions)
    first_ts = seg_start
    ch_list = list(CHANNEL_INFO)
    timeline = {"channels": [{"id": c, "name": CHANNEL_INFO[c][0], "subsystem": CHANNEL_INFO[c][1]} for c in ch_list],
                "seg": [[int(rw.segment), ch_list.index(rw.channel), first_ts[rw.segment].strftime("%Y-%m-%d"), int(rw.anomaly), int(rw.train)] for rw in ds.itertuples()]}
    base_tr, base_te = X.loc[tr, F.BASE].values, X.loc[te, F.BASE].values
    sc = StandardScaler().fit(base_tr); pca = PCA(n_components=2, random_state=SEED).fit(sc.transform(base_tr))
    emb = pca.transform(sc.transform(base_te))
    explorer = {"var_explained": [r(v, 3) for v in pca.explained_variance_ratio_],
                "pts": {int(s): [r(a, 3), r(b, 3)] for s, (a, b) in zip(ted.segment, emb)}}

    overview = {"segments_total": int(len(ds)), "segments_train": int(tr.sum()), "segments_test": int(te.sum()),
                "anomalies_total": int(ds.anomaly.sum()), "raw_samples": int(len(seg)), "channels": len(CHANNEL_INFO),
                "time_start": ts_abs.min().strftime("%Y-%m-%d"), "time_end": ts_abs.max().strftime("%Y-%m-%d"),
                "n_features": len(det.cols), "n_base": len(F.BASE), "n_trees": len(det.model.estimators_)}
    out = {"overview": overview, "features": det.cols, "results": results, "best_model": best_name, "threshold": thr,
           "confusion_matrix": cm, "roc": {"fpr": [r(x) for x in downsample(fpr, 80)], "tpr": [r(x) for x in downsample(tpr, 80)]},
           "pr": {"precision": [r(x) for x in downsample(prec, 80)], "recall": [r(x) for x in downsample(rec, 80)]},
           "importance": [{"feature": f, "value": r(v / len(exps))} for f, v in importance], "per_channel": per_channel,
           "paper_baselines": [{"model": "FCNN", "f1": 0.946, "aucpr": 0.979, "mcc": 0.932}, {"model": "XGBOD", "f1": 0.918, "aucpr": 0.975, "mcc": 0.897},
                               {"model": "RF+ICCS", "f1": 0.883, "aucpr": 0.963, "mcc": 0.862}],
           "timeline": timeline, "explorer": explorer, "calibration": calib, "sig_validation": sig_validation, "fdir": fdir}
    (OUT / "fault_detection.json").write_text(json.dumps(out, separators=(",", ":")))
    (OUT / "telemetry_replay.json").write_text(json.dumps(replay, separators=(",", ":")))
    (OUT / "fd_model.json").write_text(json.dumps(model_js, separators=(",", ":")))
    (OUT / "sim_data.json").write_text(json.dumps({"playground": playground, "stretches": stretches}, separators=(",", ":")))
    print("CM", cm, "| calib", calib["brier_raw"], "->", calib["brier_cal"])


if __name__ == "__main__":
    run()

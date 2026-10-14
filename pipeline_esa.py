"""Cross-mission test on ESA Anomaly Detection Benchmark, Mission 1 (6 channels fetched by HTTP range
requests from the Zenodo archive, so the 3.8 GB zip is never downloaded in full).

Windows: 128 consecutive samples per channel. A window is positive if it overlaps a labelled Anomaly or
Rare Event; windows touching a Communication Gap are dropped. Time split per channel: first 50% = train
period, last 50% = test period.
  zero-shot  : the OPS-SAT detector, unchanged. Only each channel's nominal profile (for the
               channel-relative features) is taken from the first 30% of the mission.
  retrained  : same features and model settings, trained on the ESA train period.
  limit check: classic envelope (0.1-99.9 percentile of nominal train-period samples).
"""
import io
import json
import pickle
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.metrics import average_precision_score, f1_score, precision_score, recall_score, roc_auc_score, matthews_corrcoef

import fd_features as F
import fd_model as M
from features import segment_features

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "esa_adb" / "mission1"
OUT = ROOT / "site" / "data"
CHANNELS = ["channel_14", "channel_21", "channel_29", "channel_50", "channel_51", "channel_52"]
WIN = 128
r = lambda x, n=4: float(round(float(x), n))


class SafeUnpickler(pickle.Unpickler):
    """only pandas / numpy data classes may be reconstructed - never arbitrary callables"""
    OK_BUILTINS = {"slice", "range", "complex", "frozenset", "set", "dict", "list", "tuple", "bytearray"}

    def find_class(self, module, name):
        if module.split(".")[0] in ("pandas", "numpy") or (module == "builtins" and name in self.OK_BUILTINS) or module in ("datetime", "collections", "copyreg", "_codecs"):
            return super().find_class(module, name)
        raise pickle.UnpicklingError(f"blocked {module}.{name}")


def fetch(ch):
    p = RAW / f"{ch}.zip"
    if not p.exists():
        import remote_zip as RZ
        z = RZ.open_remote()
        p.write_bytes(RZ.fetch_member(z, f"ESA-Mission1/channels/{ch}.zip"))
    return p


def load(ch):
    with zipfile.ZipFile(fetch(ch)) as z:
        df = SafeUnpickler(io.BytesIO(z.read(ch))).load()
    s = df.iloc[:, 0].astype(float)
    return s[~s.index.duplicated()].sort_index()


def windows(ch, s, events, gaps):
    t = (s.index - s.index[0]).total_seconds().values
    v = s.values
    samp = float(np.median(np.diff(t)))
    rows = []
    for k in range(0, len(v) - WIN + 1, WIN):
        a, b = s.index[k], s.index[k + WIN - 1]
        if ((gaps.StartTime <= b) & (gaps.EndTime >= a)).any():
            continue
        lab = int(((events.StartTime <= b) & (events.EndTime >= a)).any())
        f = segment_features(v[k:k + WIN], t[k:k + WIN], samp)
        rows.append({"segment": f"{ch}:{k}", "channel": ch, "anomaly": lab, "t0": t[k], "t1": t[k + WIN - 1], "start": a, **f})
    return pd.DataFrame(rows), v, t


def metrics(y, p, thr):
    pr = (p >= thr).astype(int)
    return {"aucpr": r(average_precision_score(y, p)), "aucroc": r(roc_auc_score(y, p)), "f1": r(f1_score(y, pr)),
            "precision": r(precision_score(y, pr, zero_division=0)), "recall": r(recall_score(y, pr)), "mcc": r(matthews_corrcoef(y, pr)),
            "prevalence": r(y.mean())}


def run():
    RAW.mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(3) as ex:
        list(ex.map(fetch, CHANNELS))
    L = pd.read_csv(RAW / "labels.csv", parse_dates=["StartTime", "EndTime"])
    T = pd.read_csv(RAW / "anomaly_types.csv")
    L = L.merge(T[["ID", "Category"]], on="ID")
    frames, series = [], {}
    cache = ROOT / "data" / "esa_windows.pkl"   # our own derived file (safe to unpickle)
    cached = pd.read_pickle(cache) if cache.exists() else None
    for ch in CHANNELS:
        s = load(ch)
        s.index = s.index.tz_localize("UTC") if s.index.tz is None else s.index
        series[ch] = (s.values, None)   # raw values; windows index into them by sample offset
        if cached is not None:
            continue
        lab = L[L.Channel == ch]
        w, v, t = windows(ch, s, lab[lab.Category != "Communication Gap"], lab[lab.Category == "Communication Gap"])
        n = len(w)
        w["train"] = (np.arange(n) < n * 0.5).astype(int)
        w["baseline"] = (np.arange(n) < n * 0.3).astype(int)
        frames.append(w)
        print(ch, "samples", len(s), "windows", n, "positives", int(w.anomaly.sum()), "span", s.index[0].date(), "->", s.index[-1].date())
    ds = cached if cached is not None else pd.concat(frames, ignore_index=True)
    if cached is None:
        ds.to_pickle(cache)
    bounds = ds.set_index("segment")[["t0", "t1"]]
    ds = ds.drop(columns=["t0", "t1"])
    te = (ds.train == 0).values
    y = ds.anomaly.values

    # ---- zero-shot: OPS-SAT detector; nominal profile from the first 30% (baseline) of each ESA channel
    ops = M.load()
    det_ops = M.Detector(ops[5], ops[0].anomaly.values, (ops[0].train == 1).values)
    base_ds = ds.assign(train=ds.baseline)
    med0, iqr0 = F.channel_stats(base_ds)
    X0 = F.build(ds, bounds, med0, iqr0, "C")[det_ops.cols]
    p0 = det_ops.proba(X0[te].values)
    zero = metrics(y[te], p0, det_ops.threshold)

    # ---- retrained on the ESA train period
    med1, iqr1 = F.channel_stats(ds)
    X1 = F.build(ds, bounds, med1, iqr1, "C")
    det_esa = M.Detector(X1, y, ~te)
    p1 = det_esa.proba(X1[te].values)
    retr = metrics(y[te], p1, det_esa.threshold)

    # ---- classic limit check
    lim_flags = []
    env = {}
    for ch in CHANNELS:
        v, t = series[ch]
        w = ds[(ds.channel == ch) & (ds.train == 1) & (ds.anomaly == 0)]
        idx = np.concatenate([np.arange(int(k.split(":")[1]), int(k.split(":")[1]) + WIN) for k in w.segment])
        env[ch] = (np.quantile(v[idx], 0.001), np.quantile(v[idx], 0.999))
    for _, rw in ds[te].iterrows():
        v, _ = series[rw.channel]; k = int(rw.segment.split(":")[1]); seg = v[k:k + WIN]; lo, hi = env[rw.channel]
        lim_flags.append(float((seg < lo).any() or (seg > hi).any()))
    lim = metrics(y[te], np.array(lim_flags), 0.5)
    hyb_zero = metrics(y[te], np.maximum((p0 >= det_ops.threshold).astype(float), lim_flags), 0.5)
    hyb_retr = metrics(y[te], np.maximum((p1 >= det_esa.threshold).astype(float), lim_flags), 0.5)
    print("zero-shot", zero); print("retrained", retr); print("limit", lim); print("hybrid(retrained)", hyb_retr)

    # example windows for the site: a few test-period positives and negatives with both scores
    ted = ds[te].assign(p_zero=p0, p_retr=p1).reset_index(drop=True)
    ex = []
    rng = np.random.default_rng(3)
    for lab_val, n in ((1, 4), (0, 2)):
        pool = ted[ted.anomaly == lab_val]
        for i in rng.choice(len(pool), size=min(n, len(pool)), replace=False):
            rw = pool.iloc[i]; v, _ = series[rw.channel]; k = int(rw.segment.split(":")[1])
            ex.append({"channel": rw.channel, "start": rw.start.strftime("%Y-%m-%d %H:%M"), "label": int(lab_val),
                       "p_zero": r(rw.p_zero, 3), "p_retr": r(rw.p_retr, 3), "v": [float(f"{x:.5g}") for x in v[k:k + WIN]]})
    out = {"mission": "ESA-ADB Mission 1", "channels": CHANNELS, "window": WIN,
           "n_windows": int(len(ds)), "n_test": int(te.sum()), "test_positives": int(y[te].sum()),
           "zero_shot": zero, "retrained": retr, "limit": lim, "hybrid_zero": hyb_zero, "hybrid_retrained": hyb_retr,
           "thr_zero": det_ops.threshold, "thr_retr": det_esa.threshold,
           "span": [str(ds.start.min().date()), str(ds.start.max().date())], "examples": ex}
    (OUT / "esa.json").write_text(json.dumps(out, separators=(",", ":")))


if __name__ == "__main__":
    run()

"""Re-implementation of the 19 OPSSAT-AD segment features, so new / modified telemetry can be scored.

`python scripts/features.py` checks every formula against the values published in dataset.csv.
"""
from pathlib import Path
import numpy as np
import pandas as pd
from scipy import stats, signal

ROOT = Path(__file__).resolve().parent.parent
OPS = ROOT / "data" / "raw" / "opssat"


def n_peaks(x):
    # a peak counts when its prominence is at least 1/10 of the signal's range (verified against dataset.csv)
    x = np.asarray(x, float)
    if len(x) < 3:
        return 0
    return len(signal.find_peaks(x, prominence=(x.max() - x.min()) / 10)[0])


def smooth(x, w):
    # centred moving average, same length as x (np.convolve "same"), verified against dataset.csv
    return np.convolve(np.asarray(x, float), np.ones(w) / w, "same")


def segment_features(values, seconds, sampling):
    """values: telemetry samples; seconds: sample times in seconds (any origin); sampling: channel sampling interval."""
    x = np.asarray(values, float)
    t = np.asarray(seconds, float)
    d1, d2 = np.diff(x), np.diff(x, n=2)
    duration = t[-1] - t[0]
    var = x.var()
    return {
        "sampling": sampling, "duration": duration, "len": len(x),
        "mean": x.mean(), "var": var, "std": x.std(),
        "kurtosis": stats.kurtosis(x), "skew": stats.skew(x),
        "n_peaks": n_peaks(x),
        "smooth10_n_peaks": n_peaks(smooth(x, 10)), "smooth20_n_peaks": n_peaks(smooth(x, 20)),
        "diff_peaks": n_peaks(d1), "diff2_peaks": n_peaks(d2),
        "diff_var": d1.var(), "diff2_var": d2.var(),
        "gaps_squared": float((np.diff(t) ** 2).sum()),
        "len_weighted": len(x) * sampling,
        "var_div_duration": var / duration if duration else 0.0,
        "var_div_len": var / len(x),
        # physical descriptors used only to name the anomaly type (not model inputs)
        **descriptors(x, t, sampling),
    }


def descriptors(x, t, sampling):
    # isolated jumps: second differences far outside their own robust spread (a spike makes 1-3 of these)
    d2 = np.diff(x, n=2) if len(x) > 2 else np.zeros(1)
    m2 = np.median(d2)
    mad2 = 1.4826 * np.median(np.abs(d2 - m2)) or (d2.std() or 1e-12)
    dev = np.abs(d2 - m2) / mad2
    runs, best, cur = np.diff(x) == 0, 0, 0
    for same in runs:
        cur = cur + 1 if same else 0
        best = max(best, cur)
    return {"max_gap": float(np.diff(t).max() / sampling) if len(t) > 1 else 1.0,
            "flat_frac": (best + 1) / len(x) if len(x) else 0.0,
            "outlier_n": int((dev > 15).sum()), "outlier_max": float(dev.max())}


if __name__ == "__main__":
    ds = pd.read_csv(OPS / "dataset.csv")
    seg = pd.read_csv(OPS / "segments.csv")
    ts = pd.to_datetime(seg.timestamp)
    seg["t"] = (ts - ts.min()).dt.total_seconds()
    rows = []
    for sid, g in seg.groupby("segment"):
        g = g.sort_values("t")
        f = segment_features(g.value.values, g.t.values, g.sampling.iloc[0])
        f["segment"] = sid
        rows.append(f)
    mine = pd.DataFrame(rows).set_index("segment").loc[ds.segment]
    ref = ds.set_index("segment")
    for c in mine.columns:
        a, b = mine[c].values.astype(float), ref[c].values.astype(float)
        ok = np.isclose(a, b, rtol=1e-4, atol=1e-12)
        print(f"{c:<18} match {ok.mean() * 100:6.2f}%" + ("" if ok.all() else f"   e.g. seg {ref.index[~ok][0]}: mine {a[~ok][0]:.6g} vs ref {b[~ok][0]:.6g}"))

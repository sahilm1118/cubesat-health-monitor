"""Feature sets for OPSSAT-AD fault detection.

A  - the 19 published segment features
B  - A + channel-relative features: each feature as a robust z-score against that channel's
     NOMINAL TRAINING segments (statistics come from the training split only)
C  - B + causal temporal context: change versus the previous segment of the same channel
     (only past data, so it is available on board)
"""
import numpy as np
import pandas as pd

BASE = ["sampling", "duration", "len", "mean", "var", "std", "kurtosis", "skew", "n_peaks",
        "smooth10_n_peaks", "smooth20_n_peaks", "diff_peaks", "diff2_peaks", "diff_var", "diff2_var",
        "gaps_squared", "len_weighted", "var_div_duration", "var_div_len"]
REL = ["mean", "var", "std", "kurtosis", "skew", "n_peaks", "smooth10_n_peaks", "diff_peaks", "diff2_peaks",
       "diff_var", "diff2_var", "gaps_squared", "var_div_duration", "var_div_len", "duration"]
CTX = ["std", "mean", "kurtosis", "diff_var", "n_peaks"]


def slog(x):
    """signed log: tames the heavy-tailed variance features before scaling"""
    return np.sign(x) * np.log1p(np.abs(x) * 1e6)


def channel_stats(ds):
    nom = ds[(ds.train == 1) & (ds.anomaly == 0)]
    g = nom.groupby("channel")[REL]
    med = g.median()
    iqr = (g.quantile(0.75) - g.quantile(0.25))
    iqr = iqr.where(iqr > 0, other=med.abs() * 0.1 + 1e-12)
    return med, iqr


def add_relative(ds, med, iqr):
    out = {}
    for f in REL:
        m, s = ds.channel.map(med[f]), ds.channel.map(iqr[f])
        out[f"rel_{f}"] = np.clip((ds[f] - m) / s, -50, 50)
    return pd.DataFrame(out, index=ds.index)


def add_context(ds, seg_bounds):
    """seg_bounds: DataFrame indexed by segment with t0, t1 (seconds). Previous segment must be
    on the same channel and start within 3 sampling intervals of this one's predecessor ending."""
    d = ds.join(seg_bounds, on="segment").sort_values(["channel", "t0"])
    prev = d.groupby("channel").shift(1)
    contiguous = ((d.t0 - prev.t1) / d.sampling <= 3).fillna(False)
    out = pd.DataFrame(index=d.index)
    out["has_prev"] = contiguous.astype(float)
    for f in CTX:
        p = prev[f].where(contiguous)
        if f in ("std", "diff_var"):
            out[f"ctx_{f}"] = np.log((d[f].abs() + 1e-12) / (p.abs() + 1e-12))
        else:
            out[f"ctx_{f}"] = d[f] - p
    return out.fillna(0.0).loc[ds.index]


def build_row(feat, channel, prev_feat, contiguous, med, iqr, cols):
    """Single-segment version of build(level C) for new or modified telemetry.
    feat / prev_feat: dicts of the 19 base features (prev_feat may be None)."""
    row = {c: float(slog(np.array([feat[c]], float))[0]) for c in BASE}
    for f in REL:
        m, s = med.loc[channel, f], iqr.loc[channel, f]
        row[f"rel_{f}"] = float(np.clip((feat[f] - m) / s, -50, 50))
    ok = prev_feat is not None and contiguous
    row["has_prev"] = 1.0 if ok else 0.0
    for f in CTX:
        if not ok:
            row[f"ctx_{f}"] = 0.0
        elif f in ("std", "diff_var"):
            row[f"ctx_{f}"] = float(np.log((abs(feat[f]) + 1e-12) / (abs(prev_feat[f]) + 1e-12)))
        else:
            row[f"ctx_{f}"] = float(feat[f] - prev_feat[f])
    return pd.DataFrame([row])[cols]


def build(ds, seg_bounds, med, iqr, level="C"):
    X = ds[BASE].copy()
    X[BASE] = slog(X[BASE].values)
    if level in ("B", "C"):
        X = X.join(add_relative(ds, med, iqr))
    if level == "C":
        X = X.join(add_context(ds, seg_bounds))
    return X

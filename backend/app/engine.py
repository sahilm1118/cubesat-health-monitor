"""Inference engine: a line-for-line port of site/src/fdcore.js (which is itself checked against the
Python training pipeline). Pure NumPy - the server never unpickles anything and needs no training data."""
import json
import math
from pathlib import Path

import numpy as np

MODELS = Path(__file__).resolve().parent.parent / "models"


# ------------------------------------------------------------------ features (scripts/features.py)
def _n_peaks(x):
    """scipy.signal.find_peaks(x, prominence=(max-min)/10): plateau midpoints, prominence >= pmin"""
    n = len(x)
    if n < 3:
        return 0
    pmin = (x.max() - x.min()) / 10
    count, i, i_max = 0, 1, n - 1
    while i < i_max:
        if x[i - 1] < x[i]:
            ia = i + 1
            while ia < i_max and x[ia] == x[i]:
                ia += 1
            if x[ia] < x[i]:
                pk = (i + ia - 1) // 2
                v = x[pk]
                j, lmin = pk, v
                while j >= 0 and x[j] <= v:
                    lmin = min(lmin, x[j]); j -= 1
                j, rmin = pk, v
                while j <= n - 1 and x[j] <= v:
                    rmin = min(rmin, x[j]); j += 1
                if v - max(lmin, rmin) >= pmin:
                    count += 1
                i = ia
        i += 1
    return count


def _smooth(x, w):
    return np.convolve(x, np.ones(w) / w, "same")


def _moments(x):
    d = x - x.mean()
    m2, m3, m4 = (d ** 2).mean(), (d ** 3).mean(), (d ** 4).mean()
    return (m3 / m2 ** 1.5 if m2 else 0.0), (m4 / m2 ** 2 - 3 if m2 else 0.0)


def _descriptors(x, t, sampling):
    d2 = np.diff(x, n=2) if len(x) > 2 else np.zeros(1)
    m2 = np.median(d2)
    mad = 1.4826 * np.median(np.abs(d2 - m2)) or (d2.std() or 1e-12)
    dev = np.abs(d2 - m2) / mad
    best = cur = 0
    for same in np.diff(x) == 0:
        cur = cur + 1 if same else 0
        best = max(best, cur)
    return {"max_gap": float(np.diff(t).max() / sampling) if len(t) > 1 else 1.0, "flat_frac": (best + 1) / len(x),
            "outlier_n": int((dev > 15).sum()), "outlier_max": float(dev.max())}


def segment_features(x, t, sampling):
    x, t = np.asarray(x, float), np.asarray(t, float)
    d1, d2 = np.diff(x), np.diff(x, n=2)
    duration, var = t[-1] - t[0], x.var()
    skew, kurt = _moments(x)
    return {"sampling": sampling, "duration": duration, "len": len(x), "mean": x.mean(), "var": var, "std": math.sqrt(var),
            "kurtosis": kurt, "skew": skew, "n_peaks": _n_peaks(x), "smooth10_n_peaks": _n_peaks(_smooth(x, 10)),
            "smooth20_n_peaks": _n_peaks(_smooth(x, 20)), "diff_peaks": _n_peaks(d1), "diff2_peaks": _n_peaks(d2),
            "diff_var": d1.var(), "diff2_var": d2.var(), "gaps_squared": float((np.diff(t) ** 2).sum()),
            "len_weighted": len(x) * sampling, "var_div_duration": var / duration if duration else 0.0,
            "var_div_len": var / len(x), **_descriptors(x, t, sampling)}


def _slog(v):
    return math.copysign(math.log1p(abs(v) * 1e6), v) if v else 0.0


# ------------------------------------------------------------------ forests
class Forest:
    def __init__(self, trees, leaf_key):
        self.trees = [(np.array(T["f"]), np.array(T["t"]), np.array(T["l"]), np.array(T["r"]), np.array(T[leaf_key], float)) for T in trees]

    def predict(self, row):
        acc = 0.0
        for f, th, L, R, v in self.trees:
            n = 0
            while L[n] != -1:
                n = L[n] if row[f[n]] <= th[n] else R[n]
            acc += v[n]
        return acc / len(self.trees)

    def votes(self, row):
        out = []
        for f, th, L, R, v in self.trees:
            n = 0
            while L[n] != -1:
                n = L[n] if row[f[n]] <= th[n] else R[n]
            out.append(float(v[n]))
        return out


GROUPS = ["spike", "noise", "amplitude", "offset", "data_gap", "waveform", "timing", "change"]
FAMILY = {"kurtosis": "spike", "skew": "spike", "diff_var": "noise", "diff2_var": "noise", "diff_peaks": "noise", "diff2_peaks": "noise",
          "var": "amplitude", "std": "amplitude", "var_div_duration": "amplitude", "var_div_len": "amplitude", "mean": "offset",
          "gaps_squared": "data_gap", "n_peaks": "waveform", "smooth10_n_peaks": "waveform", "smooth20_n_peaks": "waveform",
          "duration": "timing", "len": "timing", "len_weighted": "timing", "sampling": "timing", "has_prev": "change"}
REP = {"spike": ["kurtosis", "skew"], "noise": ["diff_var", "diff2_var", "diff_peaks", "diff2_peaks"], "amplitude": ["std", "var", "var_div_len"],
       "offset": ["mean"], "data_gap": ["gaps_squared"], "waveform": ["n_peaks", "smooth10_n_peaks"], "timing": ["duration"], "change": ["std", "mean"]}
CTX_KEYS = ("std", "mean", "kurtosis", "diff_var", "n_peaks")


def _family_of(c):
    return "change" if c.startswith("ctx_") else FAMILY.get(c.replace("rel_", ""), "subtle")


class Detector:
    def __init__(self, path=MODELS / "fd_model.json"):
        M = json.loads(Path(path).read_text())
        self.M, self.cols = M, M["cols"]
        self.idx = {c: i for i, c in enumerate(self.cols)}
        self.forest = Forest(M["trees"], "p")
        self.threshold = M["threshold"]
        self.iso_x, self.iso_y = np.array(M["iso_x"]), np.array(M["iso_y"])
        self.channels = sorted(M["med"])
        self.group_cols = {g: [j for j, c in enumerate(self.cols) if c != "has_prev" and _family_of(c) == g] for g in GROUPS}

    def build_row(self, f, ch, prev, contig):
        M, row = self.M, np.zeros(len(self.cols))
        for c in M["base"]:
            row[self.idx[c]] = _slog(f[c])
        for c in M["rel"]:
            row[self.idx["rel_" + c]] = max(-50, min(50, (f[c] - M["med"][ch][c]) / M["iqr"][ch][c]))
        ok = bool(prev and contig)
        row[self.idx["has_prev"]] = 1.0 if ok else 0.0
        for c in M["ctx"]:
            v = 0.0
            if ok:
                v = math.log((abs(f[c]) + 1e-12) / (abs(prev[c]) + 1e-12)) if c in ("std", "diff_var") else f[c] - prev[c]
            row[self.idx["ctx_" + c]] = v
        return row

    def calibrate(self, p):
        return float(np.interp(p, self.iso_x, self.iso_y))

    def _signature(self, row, fam, phys):
        z = lambda k: row[self.idx["rel_" + k]] if ("rel_" + k) in self.idx else 0.0
        if phys["max_gap"] >= 5: return "data_gap"
        if phys["flat_frac"] >= 0.3 or phys["std_ratio"] < 0.15: return "stuck"
        if 1 <= phys["outlier_n"] <= 9 and phys["outlier_max"] > 15: return "spike"
        if z("diff_var") > 3 or z("diff2_var") > 3: return "noise"
        if abs(z("mean")) > 3: return "offset"
        if z("var") > 3 or z("std") > 3: return "amplitude"
        if abs(z("n_peaks")) > 2 or abs(z("diff_peaks")) > 2: return "waveform"
        if fam and max(fam.values()) > 0.01:
            return max(fam, key=fam.get)
        return "subtle"

    def analyse(self, x, t, sampling, ch, prev=None, contig=False):
        x = np.asarray(x, float)
        f = segment_features(x, t, sampling)
        row = self.build_row(f, ch, prev, contig)
        r0, nom = self.forest.predict(row), self.M["nom"][ch]
        fam = {}
        for g, cols in self.group_cols.items():
            rr = row.copy()
            for j in cols:
                c = self.cols[j]
                rr[j] = 0.0 if (c.startswith("rel_") or c.startswith("ctx_")) else nom[j]
            d = r0 - self.forest.predict(rr)
            if d > 0:
                fam[g] = d
        ms = self.M["med"][ch]["std"]
        phys = {k: f[k] for k in ("max_gap", "flat_frac", "outlier_n", "outlier_max")}
        phys["std_ratio"] = f["std"] / ms if ms else 1.0
        zrel = lambda q: row[self.idx["rel_" + q]] if ("rel_" + q) in self.idx else 0.0
        why = []
        for g in sorted(fam, key=fam.get, reverse=True)[:3]:
            if fam[g] < 0.01:
                continue
            pool = [q for q in REP[g] if ("rel_" + q) in self.idx] or REP[g]
            fq = max(pool, key=lambda q: abs(zrel(q)))
            why.append({"g": g, "c": round(fam[g], 3), "f": fq, "z": round(zrel(fq), 2), "val": float(f[fq]),
                        "med": self.M["med"][ch].get(fq)})
        p = self.calibrate(r0)
        lo, hi = self.M["envelope"][ch]
        limit = bool((x < lo).any() or (x > hi).any())
        return {"p": p, "flag": p >= self.threshold, "raw": r0, "sig": self._signature(row, fam, phys), "why": why,
                "limit": limit, "hybrid": bool(p >= self.threshold or limit),
                "features": {k: float(f[k]) for k in CTX_KEYS}}


# ------------------------------------------------------------------ FDIR + fault injection (ports of fdcore.js)
class FDIR:
    def __init__(self):
        self.level = self.streak = self.calm = 0

    def step(self, flagged, p):
        if flagged:
            self.streak += 1; self.calm = 0; self.level = max(self.level, 1)
            if self.streak >= 2: self.level = max(self.level, 2)
            if self.streak >= 4 and p >= 0.9: self.level = 3
        else:
            self.streak = 0; self.calm += 1
            if self.calm >= 3 and self.level > 0:
                self.level -= 1; self.calm = 0
        return self.level


def _mulberry32(seed):
    a = seed & 0xFFFFFFFF
    def nxt():
        nonlocal a
        a = (a + 0x6D2B79F5) & 0xFFFFFFFF
        t = a
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return nxt


def _jsround(x):
    return math.floor(x + 0.5)


def inject(kind, v0, t0, seed=1, severity=1.0, pos=0.5):
    r = _mulberry32(seed)
    v, t = np.array(v0, float), np.array(t0, float)
    n = len(v)
    rngv = (v.max() - v.min()) or abs(v.mean()) + 1e-9
    sd = v.std() or rngv / 4
    at = max(2, min(n - 3, _jsround(pos * (n - 1))))
    gauss = lambda: math.sqrt(-2 * math.log(1 - r())) * math.cos(2 * math.pi * r())
    if kind == "spike":
        k = 1 + int(r() * 2)
        for j in range(k):
            i = min(n - 3, at + j * 3)
            v[i] += (-1 if r() < 0.5 else 1) * (1.2 + r()) * severity * rngv
    elif kind == "noise":
        b = min(n, at + max(8, _jsround(n * 0.4)))
        for i in range(at, b):
            v[i] += gauss() * 0.45 * severity * sd
    elif kind == "stuck":
        v[at:] = v[at]
    elif kind == "offset":
        v = v + (-1 if r() < 0.5 else 1) * 2.2 * severity * rngv
    elif kind == "data_gap":
        k = max(3, _jsround(n * 0.35 * min(1.6, severity)))
        a = min(at, n - k - 2)
        keep = np.r_[0:a, a + k:n]
        v, t = v[keep], t[keep]
    elif kind == "amplitude":
        m = v.mean()
        v = m + (v - m) * (1 + 2.2 * severity)
    return v, t


# ------------------------------------------------------------------ battery RUL
class RUL:
    def __init__(self, path=MODELS / "rul.json"):
        R = json.loads(Path(path).read_text())
        self.R, self.forest = R, Forest(R["trees"], "v")

    def forecast(self, soh, ambient, current):
        s = np.asarray(soh, float)
        if s.max() > 2:            # accept percent or fraction
            s = s / 100
        k, W = len(s), self.R["window"]
        h = s[-5:].mean()
        feats = {"cycle": k, "soh_now": h, "soh_min": s.min(), "slope10": np.polyfit(np.arange(W), s[-W:], 1)[0],
                 "slope30": np.polyfit(np.arange(min(k, 30)), s[-min(k, 30):], 1)[0], "fade_rate": (1 - h) / k,
                 "margin": h - self.R["eol_soh"], "ambient": ambient, "current": current}
        yh = max(0.0, self.forest.predict(np.array([feats[c] for c in self.R["features"]])))
        w = self.R["q"] * (yh + 10)
        return {"rul": round(yh, 1), "lo": round(max(0.0, yh - w), 1), "hi": round(yh + w, 1), "soh_now": round(h * 100, 2),
                "past_eol": bool(h < self.R["eol_soh"]), "coverage_target": 1 - self.R["alpha"]}

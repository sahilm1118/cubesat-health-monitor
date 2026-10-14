"""Fault injection into real OPS-SAT telemetry, signature validation, and the closed-loop
fault-management (FDIR) simulation. All randomness is seeded."""
import numpy as np
import pandas as pd

from features import segment_features
import fd_features as F

TYPES = ["spike", "noise", "stuck", "offset", "data_gap", "amplitude"]
TYPE_NAME = {"spike": "Spike", "noise": "Noise burst", "stuck": "Stuck sensor", "offset": "Level shift",
             "data_gap": "Data gap", "amplitude": "Amplitude excursion"}


def inject(kind, v, t, rng, severity=1.0):
    """return modified (values, times). severity scales the fault magnitude (1 = typical)."""
    v, t = np.array(v, float), np.array(t, float)
    n = len(v)
    rngv = (v.max() - v.min()) or (abs(v.mean()) + 1e-9)
    sd = v.std() or rngv / 4
    if kind == "spike":
        for _ in range(rng.integers(1, 4)):
            i = rng.integers(2, n - 2)
            v[i] += rng.choice([-1, 1]) * rng.uniform(1.0, 2.5) * severity * rngv
    elif kind == "noise":
        a = rng.integers(0, n // 3); b = rng.integers(a + n // 3, n + 1)
        v[a:b] += rng.normal(0, rng.uniform(0.25, 0.6) * severity * sd, b - a)
    elif kind == "stuck":
        i = rng.integers(n // 8, n // 3)
        v[i:] = v[i]
    elif kind == "offset":
        v += rng.choice([-1, 1]) * rng.uniform(1.5, 3.0) * severity * rngv
    elif kind == "data_gap":
        k = int(n * rng.uniform(0.3, 0.5)); a = rng.integers(1, n - k - 1)
        keep = np.r_[0:a, a + k:n]
        v, t = v[keep], t[keep]
    elif kind == "amplitude":
        v = v.mean() + (v - v.mean()) * rng.uniform(2.5, 4.0) * severity
    return v, t


def featurize(v, t, sampling, channel, prev_feat, contiguous, med, iqr, cols):
    f = segment_features(v, t, sampling)
    return f, F.build_row(f, channel, prev_feat, contiguous, med, iqr, cols)


# --------------------------------------------------------------------------- data access
class Telemetry:
    def __init__(self, ds, seg):
        self.ds = ds.set_index("segment")
        self.raw = {s: (g.value.values, g.t.values) for s, g in seg.sort_values(["segment", "t"]).groupby("segment")}
        b = seg.groupby("segment").t.agg(t0="min", t1="max")
        d = self.ds.join(b).sort_values(["channel", "t0"])
        self.order = {ch: list(g.index) for ch, g in d.groupby("channel")}
        self.bounds = b
        self.base = {s: segment_features(*self.raw[s], self.ds.loc[s, "sampling"]) for s in self.raw}

    def prev(self, sid):
        ch = self.ds.loc[sid, "channel"]; o = self.order[ch]; i = o.index(sid)
        if i == 0:
            return None, False
        p = o[i - 1]
        gap = (self.bounds.loc[sid, "t0"] - self.bounds.loc[p, "t1"]) / self.ds.loc[sid, "sampling"]
        return p, bool(gap <= 3)


# --------------------------------------------------------------------------- signature validation
def validate_signatures(det, tel, explain_fn, test_nominal_ids, rng, per_type=None):
    rows = []
    ids = list(test_nominal_ids)
    for sid in ids:
        ch, samp = tel.ds.loc[sid, "channel"], tel.ds.loc[sid, "sampling"]
        p_id, contig = tel.prev(sid)
        prev_feat = tel.base[p_id] if p_id is not None else None
        v0, t0 = tel.raw[sid]
        for kind in ["none"] + TYPES:
            v, t = (v0, t0) if kind == "none" else inject(kind, v0, t0, rng)
            f, X = featurize(v, t, samp, ch, prev_feat, contig, *explain_fn["stats"], det.cols)
            e = explain_fn["fn"](X, [ch], [f])[0]
            rows.append({"segment": sid, "channel": ch, "injected": kind, "p": e["p"],
                         "flag": int(e["p"] >= det.threshold), "sig": e["sig"]})
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- FDIR state machine
LEVELS = ["Nominal", "Monitor", "Isolate", "Safe mode"]


class FDIR:
    """Escalation: any alarm -> Monitor; 2 consecutive alarms -> Isolate; 4 consecutive alarms with
    p >= 0.9 -> Safe mode. Recovery: 3 consecutive clear windows step the level down by one."""
    def __init__(self):
        self.level = self.streak = self.calm = 0

    def step(self, flagged, p):
        if flagged:
            self.streak += 1; self.calm = 0
            self.level = max(self.level, 1)
            if self.streak >= 2: self.level = max(self.level, 2)
            if self.streak >= 4 and p >= 0.9: self.level = 3
        else:
            self.streak = 0; self.calm += 1
            if self.calm >= 3 and self.level > 0:
                self.level -= 1; self.calm = 0
        return self.level


def limit_checker(tel, train_nominal_ids):
    """classic onboard FDIR baseline: alarm when any sample leaves the channel's nominal envelope
    (0.1-99.9 percentile of all nominal TRAINING samples on that channel)"""
    env = {}
    by_ch = {}
    for s in train_nominal_ids:
        by_ch.setdefault(tel.ds.loc[s, "channel"], []).append(tel.raw[s][0])
    for ch, arrs in by_ch.items():
        a = np.concatenate(arrs)
        env[ch] = (np.quantile(a, 0.001), np.quantile(a, 0.999))
    def check(ch, v):
        lo, hi = env[ch]
        return bool((v < lo).any() or (v > hi).any())
    return check, env


def run_episode(det, tel, explain_fn, limit_check, ch_ids, start, k, kind, rng, pre=8, post=10):
    """ch_ids: time-ordered test segment ids of one channel. Faults injected into windows [start, start+k)."""
    seq = ch_ids[max(0, start - pre): start + k + post]
    s_idx = min(pre, start)
    ai, lim, hy = FDIR(), FDIR(), FDIR()
    trace = []
    prev_mod = {}
    for i, sid in enumerate(seq):
        ch, samp = tel.ds.loc[sid, "channel"], tel.ds.loc[sid, "sampling"]
        v, t = tel.raw[sid]
        faulty = s_idx <= i < s_idx + k
        if faulty:
            v, t = inject(kind, v, t, rng)
        p_id, contig = tel.prev(sid)
        prev_feat = prev_mod.get(p_id, tel.base.get(p_id)) if p_id is not None else None
        f, X = featurize(v, t, samp, ch, prev_feat, contig, *explain_fn["stats"], det.cols)
        prev_mod[sid] = f
        e = explain_fn["fn"](X, [ch], [f])[0]
        fa, fl = e["p"] >= det.threshold, limit_check(ch, v)
        trace.append({"sid": sid, "faulty": faulty, "label": int(tel.ds.loc[sid, "anomaly"]), "p": e["p"], "sig": e["sig"],
                      "ai_flag": int(fa), "ai_level": ai.step(fa, e["p"]), "lim_flag": int(fl), "lim_level": lim.step(fl, 1.0),
                      "hy_flag": int(fa or fl), "hy_level": hy.step(fa or fl, max(e["p"], 1.0 if fl else 0.0))})
    return trace, s_idx


def summarize(traces, who):
    det_, delay, iso, safe, fa_mon, fa_iso, nom_n, rec = 0, [], 0, 0, 0, 0, 0, []
    for tr, s, k in traces:
        lv = [w[f"{who}_level"] for w in tr]; fl = [w[f"{who}_flag"] for w in tr]
        during = range(s, s + k)
        hits = [i for i in during if fl[i]]
        if hits:
            det_ += 1; delay.append(hits[0] - s)
        if any(lv[i] >= 2 for i in during): iso += 1
        if any(lv[i] >= 3 for i in range(len(tr))): safe += 1
        for i in range(s):  # fault-free windows before the episode (real telemetry, expert-labelled nominal)
            if tr[i]["label"] == 0:
                nom_n += 1; fa_mon += fl[i]; fa_iso += int(lv[i] >= 2 and (i == 0 or lv[i - 1] < 2))
        after = [i for i in range(s + k, len(tr)) if lv[i] == 0]
        rec.append((after[0] - (s + k) + 1) if after else len(tr) - (s + k))
    n = len(traces)
    return {"episodes": n, "detected": det_ / n, "mean_delay": float(np.mean(delay)) if delay else None,
            "isolated": iso / n, "safe_mode": safe / n, "false_alarm_per_100": 100 * fa_mon / max(1, nom_n),
            "false_isolation_per_100": 100 * fa_iso / max(1, nom_n), "recovery_windows": float(np.mean(rec))}

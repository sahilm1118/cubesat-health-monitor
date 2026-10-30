"""Mean ± std over seeds for every experiments_v2 result -> data/exp_v2/summary.json"""
import json
from pathlib import Path
import numpy as np

D = Path(__file__).resolve().parent.parent / "data" / "exp_v2"
runs = [json.loads(p.read_text()) for p in sorted(D.glob("seed_*.json"))]
TYPES = ["spike", "noise", "stuck", "data_gap", "offset", "amplitude"]
WHO = ["ai", "aug", "lim", "hy", "fus"]
ms = lambda xs: {"mean": float(np.mean(xs)), "std": float(np.std(xs, ddof=1)) if len(xs) > 1 else 0.0}

out = {"seeds": [r["seed"] for r in runs]}
for key in ["detect", "detect_aug", "detect_limit", "detect_or", "detect_fusion"]:
    out[key] = {m: ms([r[key][m] for r in runs]) for m in runs[0][key]}
out["fdir_type"] = {t: {w: {m: ms([r["fdir"][t][w][m] for r in runs if r["fdir"][t][w][m] is not None])
                           for m in ["detected", "false_alarm_per_100", "false_isolation_per_100", "isolated", "mean_delay"]}
                       for w in WHO} for t in TYPES}
out["fdir_mean"] = {w: {m: ms([np.mean([r["fdir"][t][w][m] for t in TYPES]) for r in runs])
                        for m in ["detected", "false_alarm_per_100", "false_isolation_per_100", "isolated"]}
                    for w in WHO}
out["fdir_min_type"] = {w: ms([min(r["fdir"][t][w]["detected"] for t in TYPES) for r in runs]) for w in WHO}
out["single_window"] = {k: {w: ms([r["single_window"][k][w] for r in runs]) for w in WHO[:2] + ["lim", "or", "fus"]}
                        for k in runs[0]["single_window"]}
out["fusion"] = {"coef": ms([r["fusion"]["coef"] for r in runs]) if False else [r["fusion"]["coef"] for r in runs],
                 "threshold": [r["fusion"]["threshold"] for r in runs]}
(D / "summary.json").write_text(json.dumps(out, indent=1))

f = lambda d: f"{d['mean']:.3f}±{d['std']:.3f}"
print("seeds", out["seeds"])
for k in ["detect", "detect_aug", "detect_limit", "detect_or", "detect_fusion"]:
    print(f"{k:<14}", " ".join(f"{m}={f(out[k][m])}" for m in ["precision", "recall", "f1", "mcc", "aucpr"]))
print("FDIR mean detected / FA per100 / false iso / min-type detected")
for w in WHO:
    print(f"  {w:<4}", f(out["fdir_mean"][w]["detected"]), f(out["fdir_mean"][w]["false_alarm_per_100"]),
          f(out["fdir_mean"][w]["false_isolation_per_100"]), f(out["fdir_min_type"][w]))
print("FDIR detected by type")
for t in TYPES:
    print(f"  {t:<10}", "  ".join(f"{w}={out['fdir_type'][t][w]['detected']['mean']:.3f}±{out['fdir_type'][t][w]['detected']['std']:.3f}" for w in WHO))
print("single window detected")
for k, d in out["single_window"].items():
    print(f"  {k:<10}", "  ".join(f"{w}={v['mean']:.3f}±{v['std']:.3f}" for w, v in d.items()))

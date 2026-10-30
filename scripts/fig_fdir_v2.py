"""FDIR detection by fault type, 5 alarm sources, mean ± std over seeds (website colour scheme)."""
import json, sys
from pathlib import Path
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent.parent
s = json.loads((ROOT / "data" / "exp_v2" / "summary.json").read_text())
out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "data" / "exp_v2" / "fig_fdir_v2.png"
plt.rcParams.update({"font.family": "DejaVu Sans Mono", "font.size": 8.5, "axes.spines.top": False, "axes.spines.right": False,
                     "axes.edgecolor": "#c9d0dd", "axes.labelcolor": "#4a556b", "xtick.color": "#4a556b", "ytick.color": "#4a556b"})
types = ["spike", "noise", "stuck", "data_gap", "offset", "amplitude"]
names = ["Spike", "Noise", "Stuck", "Data gap", "Level\nshift", "Ampl-\nitude"]
who = [("ai", "ML detector", "#2443b8"), ("lim", "Limit check", "#b06a00"), ("hy", "OR-hybrid", "#10805b"),
       ("fus", "Learned fusion", "#8a3fb3"), ("aug", "Augmented ML", "#cf3f12")]
x = np.arange(len(types)); bw = 0.16
fig, ax = plt.subplots(figsize=(4.6, 2.6), dpi=400)
ax.grid(axis="y", color="#e6e9f0", lw=0.6); ax.set_axisbelow(True)
for i, (w, lab, c) in enumerate(who):
    m = [100 * s["fdir_type"][t][w]["detected"]["mean"] for t in types]
    e = [100 * s["fdir_type"][t][w]["detected"]["std"] for t in types]
    ax.bar(x + (i - 2) * bw, m, bw * 0.92, color=c, label=lab, yerr=e, error_kw=dict(lw=0.6, capsize=1.2, ecolor="#333"))
ax.set_xticks(x); ax.set_xticklabels(names); ax.set_ylim(0, 108); ax.set_ylabel("Episodes detected (%)")
ax.legend(frameon=False, ncol=3, loc="upper center", bbox_to_anchor=(0.5, 1.28), fontsize=7.5, handlelength=1.2, columnspacing=1)
fig.tight_layout(pad=0.3); fig.savefig(out, facecolor="white"); print(out)

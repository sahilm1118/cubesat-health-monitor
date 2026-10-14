/* FDCore: browser port of the fault-detection pipeline (scripts/features.py, fd_features.py, fd_model.py).
   Parity with Python is checked by scripts/check_js.mjs. Works in the browser (window.FDCore) and in Node. */
(function (root) {
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const variance = (a) => { const m = mean(a); return a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length; };
  const median = (a) => { const s = [...a].sort((p, q) => p - q), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
  const diff = (a) => a.slice(1).map((x, i) => x - a[i]);
  function moments(a) {
    const m = mean(a); let m2 = 0, m3 = 0, m4 = 0;
    for (const x of a) { const d = x - m; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
    m2 /= a.length; m3 /= a.length; m4 /= a.length;
    return { skew: m2 ? m3 / Math.pow(m2, 1.5) : 0, kurt: m2 ? m4 / (m2 * m2) - 3 : 0 };
  }
  // scipy.signal.find_peaks(x, prominence=pmin): local maxima (plateau midpoints) with prominence >= pmin
  function nPeaks(x) {
    const n = x.length; if (n < 3) return 0;
    let lo = Infinity, hi = -Infinity; for (const v of x) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const pmin = (hi - lo) / 10; let count = 0;
    let i = 1; const iMax = n - 1;
    while (i < iMax) {
      if (x[i - 1] < x[i]) {
        let ia = i + 1;
        while (ia < iMax && x[ia] === x[i]) ia++;
        if (x[ia] < x[i]) {
          const pk = Math.floor((i + ia - 1) / 2), v = x[pk];
          let j = pk, lmin = v; while (j >= 0 && x[j] <= v) { if (x[j] < lmin) lmin = x[j]; j--; }
          j = pk; let rmin = v; while (j <= n - 1 && x[j] <= v) { if (x[j] < rmin) rmin = x[j]; j++; }
          if (v - Math.max(lmin, rmin) >= pmin) count++;
          i = ia;
        }
      }
      i++;
    }
    return count;
  }
  // np.convolve(x, ones(w)/w, "same")
  function smooth(x, w) {
    const n = x.length, L = Math.max(n, w), full = n + w - 1, start = Math.floor((full - L) / 2), out = new Array(L);
    for (let k = 0; k < L; k++) {
      const idx = k + start; let s = 0;
      for (let j = 0; j < w; j++) { const xi = idx - j; if (xi >= 0 && xi < n) s += x[xi]; }
      out[k] = s / w;
    }
    return out;
  }
  function descriptors(x, t, sampling) {
    const d2 = x.length > 2 ? diff(diff(x)) : [0];
    const m2 = median(d2); let mad = 1.4826 * median(d2.map((v) => Math.abs(v - m2)));
    if (!mad) mad = Math.sqrt(variance(d2)) || 1e-12;
    const dev = d2.map((v) => Math.abs(v - m2) / mad);
    let best = 0, cur = 0;
    for (let i = 1; i < x.length; i++) { cur = x[i] === x[i - 1] ? cur + 1 : 0; if (cur > best) best = cur; }
    const dt = diff(t);
    return { max_gap: dt.length ? Math.max(...dt) / sampling : 1, flat_frac: x.length ? (best + 1) / x.length : 0,
             outlier_n: dev.filter((v) => v > 15).length, outlier_max: Math.max(...dev) };
  }
  function segmentFeatures(x, t, sampling) {
    const d1 = diff(x), d2 = diff(d1), duration = t[t.length - 1] - t[0], v = variance(x), mo = moments(x), dt = diff(t);
    return {
      sampling, duration, len: x.length, mean: mean(x), var: v, std: Math.sqrt(v), kurtosis: mo.kurt, skew: mo.skew,
      n_peaks: nPeaks(x), smooth10_n_peaks: nPeaks(smooth(x, 10)), smooth20_n_peaks: nPeaks(smooth(x, 20)),
      diff_peaks: nPeaks(d1), diff2_peaks: nPeaks(d2), diff_var: variance(d1), diff2_var: variance(d2),
      gaps_squared: dt.reduce((s, g) => s + g * g, 0), len_weighted: x.length * sampling,
      var_div_duration: duration ? v / duration : 0, var_div_len: v / x.length, ...descriptors(x, t, sampling),
    };
  }
  const slog = (v) => Math.sign(v) * Math.log1p(Math.abs(v) * 1e6);

  // seeded fault injection (same fault families as scripts/fault_injection.py; pos in 0..1 sets where it starts)
  function rng(seed) { let a = seed >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function inject(kind, v0, t0, o = {}) {
    const r = rng(o.seed || 1), sev = o.severity ?? 1, pos = o.pos ?? 0.5;
    let v = v0.slice(), t = t0.slice(); const n = v.length;
    let lo = Infinity, hi = -Infinity; for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
    const rngv = (hi - lo) || Math.abs(mean(v)) + 1e-9, sd = Math.sqrt(variance(v)) || rngv / 4;
    const at = Math.max(2, Math.min(n - 3, Math.round(pos * (n - 1))));
    const gauss = () => { const u = 1 - r(), w = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w); };
    let region = [at, at];
    if (kind === "spike") { const k = 1 + Math.floor(r() * 2); for (let j = 0; j < k; j++) { const i = Math.min(n - 3, at + j * 3); v[i] += (r() < 0.5 ? -1 : 1) * (1.2 + r()) * sev * rngv; } region = [at, Math.min(n - 1, at + 3 * k)]; }
    else if (kind === "noise") { const b = Math.min(n, at + Math.max(8, Math.round(n * 0.4))); for (let i = at; i < b; i++) v[i] += gauss() * 0.45 * sev * sd; region = [at, b - 1]; }
    else if (kind === "stuck") { for (let i = at; i < n; i++) v[i] = v[at]; region = [at, n - 1]; }
    else if (kind === "offset") { const d = (r() < 0.5 ? -1 : 1) * 2.2 * sev * rngv; v = v.map((x) => x + d); region = [0, n - 1]; }
    else if (kind === "data_gap") { const k = Math.max(3, Math.round(n * 0.35 * Math.min(1.6, sev))); const a = Math.min(at, n - k - 2); v = v.filter((_, i) => i < a || i >= a + k); t = t.filter((_, i) => i < a || i >= a + k); region = [a, a + k - 1]; }
    else if (kind === "amplitude") { const m = mean(v), f = 1 + 2.2 * sev; v = v.map((x) => m + (x - m) * f); region = [0, n - 1]; }
    return { v, t, region };
  }

  function create(M) {
    const colIdx = Object.fromEntries(M.cols.map((c, i) => [c, i]));
    function buildRow(f, ch, prev, contig) {
      const row = new Array(M.cols.length).fill(0);
      for (const c of M.base) row[colIdx[c]] = slog(f[c]);
      for (const c of M.rel) row[colIdx["rel_" + c]] = Math.max(-50, Math.min(50, (f[c] - M.med[ch][c]) / M.iqr[ch][c]));
      const ok = !!(prev && contig);
      row[colIdx.has_prev] = ok ? 1 : 0;
      for (const c of M.ctx) {
        let v = 0;
        if (ok) v = (c === "std" || c === "diff_var") ? Math.log((Math.abs(f[c]) + 1e-12) / (Math.abs(prev[c]) + 1e-12)) : f[c] - prev[c];
        row[colIdx["ctx_" + c]] = v;
      }
      return row;
    }
    function raw(row) {
      let acc = 0;
      for (const T of M.trees) { let n = 0; while (T.l[n] !== -1) n = row[T.f[n]] <= T.t[n] ? T.l[n] : T.r[n]; acc += T.p[n]; }
      return acc / M.trees.length;
    }
    function calibrate(p) {   // sklearn IsotonicRegression.predict: linear interpolation, clipped
      const X = M.iso_x, Y = M.iso_y; if (p <= X[0]) return Y[0]; if (p >= X[X.length - 1]) return Y[Y.length - 1];
      let lo = 0, hi = X.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (X[m] <= p) lo = m; else hi = m; }
      return X[hi] === X[lo] ? Y[hi] : Y[lo] + (Y[hi] - Y[lo]) * (p - X[lo]) / (X[hi] - X[lo]);
    }
    const GROUPS = ["spike", "noise", "amplitude", "offset", "data_gap", "waveform", "timing", "change"];
    const FAMILY = { kurtosis: "spike", skew: "spike", diff_var: "noise", diff2_var: "noise", diff_peaks: "noise", diff2_peaks: "noise",
      var: "amplitude", std: "amplitude", var_div_duration: "amplitude", var_div_len: "amplitude", mean: "offset", gaps_squared: "data_gap",
      n_peaks: "waveform", smooth10_n_peaks: "waveform", smooth20_n_peaks: "waveform", duration: "timing", len: "timing", len_weighted: "timing",
      sampling: "timing", has_prev: "change" };
    const familyOf = (c) => c.startsWith("ctx_") ? "change" : (FAMILY[c.replace("rel_", "")] || "subtle");
    const REP = { spike: ["kurtosis", "skew"], noise: ["diff_var", "diff2_var", "diff_peaks", "diff2_peaks"], amplitude: ["std", "var", "var_div_len"],
      offset: ["mean"], data_gap: ["gaps_squared"], waveform: ["n_peaks", "smooth10_n_peaks"], timing: ["duration"], change: ["std", "mean"] };
    function signature(row, fam, phys) {
      const z = (k) => (colIdx["rel_" + k] !== undefined ? row[colIdx["rel_" + k]] : 0);
      if (phys.max_gap >= 5) return "data_gap";
      if (phys.flat_frac >= 0.3 || phys.std_ratio < 0.15) return "stuck";
      if (phys.outlier_n >= 1 && phys.outlier_n <= 9 && phys.outlier_max > 15) return "spike";
      if (z("diff_var") > 3 || z("diff2_var") > 3) return "noise";
      if (Math.abs(z("mean")) > 3) return "offset";
      if (z("var") > 3 || z("std") > 3) return "amplitude";
      if (Math.abs(z("n_peaks")) > 2 || Math.abs(z("diff_peaks")) > 2) return "waveform";
      const ks = Object.keys(fam); if (ks.length && Math.max(...ks.map((k) => fam[k])) > 0.01) return ks.reduce((a, b) => fam[a] >= fam[b] ? a : b);
      return "subtle";
    }
    function analyse(x, t, sampling, ch, prev, contig) {
      const f = segmentFeatures(x, t, sampling), row = buildRow(f, ch, prev, contig), r0 = raw(row), nom = M.nom[ch];
      const fam = {};
      GROUPS.forEach((g) => {
        const rr = row.slice();
        M.cols.forEach((c, j) => { if (c !== "has_prev" && familyOf(c) === g) rr[j] = (c.startsWith("rel_") || c.startsWith("ctx_")) ? 0 : nom[j]; });
        const d = r0 - raw(rr); if (d > 0) fam[g] = d;
      });
      const ms = M.med[ch].std, phys = { max_gap: f.max_gap, flat_frac: f.flat_frac, outlier_n: f.outlier_n, outlier_max: f.outlier_max, std_ratio: ms ? f.std / ms : 1 };
      const zrel = (q) => (colIdx["rel_" + q] !== undefined ? row[colIdx["rel_" + q]] : 0);
      const why = Object.keys(fam).sort((a, b) => fam[b] - fam[a]).slice(0, 3).filter((g) => fam[g] >= 0.01).map((g) => {
        const cands = REP[g].filter((q) => colIdx["rel_" + q] !== undefined); const pool = cands.length ? cands : REP[g];
        const fq = pool.reduce((a, b) => Math.abs(zrel(a)) >= Math.abs(zrel(b)) ? a : b);
        return { g, c: Math.round(fam[g] * 1000) / 1000, f: fq, z: Math.round(zrel(fq) * 100) / 100, val: f[fq], med: M.med[ch][fq] ?? null };
      });
      const p = calibrate(r0);
      const env = M.envelope[ch], limit = env ? x.some((v) => v < env[0] || v > env[1]) : false;
      return { p, flag: p >= M.threshold, raw: r0, sig: signature(row, fam, phys), why, f, row, limit };
    }
    // FDIR state machine (same rules as fault_injection.FDIR)
    function fdir() {
      const s = { level: 0, streak: 0, calm: 0 };
      s.step = (flagged, p) => {
        if (flagged) { s.streak++; s.calm = 0; s.level = Math.max(s.level, 1); if (s.streak >= 2) s.level = Math.max(s.level, 2); if (s.streak >= 4 && p >= 0.9) s.level = 3; }
        else { s.streak = 0; s.calm++; if (s.calm >= 3 && s.level > 0) { s.level--; s.calm = 0; } }
        return s.level;
      };
      return s;
    }
    function votes(row) {
      return M.trees.map((T) => { let n = 0; while (T.l[n] !== -1) n = row[T.f[n]] <= T.t[n] ? T.l[n] : T.r[n]; return T.p[n]; });
    }
    return { analyse, segmentFeatures, buildRow, raw, calibrate, fdir, votes, inject, threshold: M.threshold, cols: M.cols };
  }
  const api = { create, segmentFeatures };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.FDCore = api;
})(typeof window !== "undefined" ? window : globalThis);

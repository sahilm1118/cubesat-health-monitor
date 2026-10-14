// Parity test: browser FDCore vs Python on 150 real segments. Run: node scripts/check_js.cjs
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const FD = require(path.join(root, "site/src/fdcore.js"));
const M = JSON.parse(fs.readFileSync(path.join(root, "site/data/fd_model.json")));
const chk = JSON.parse(fs.readFileSync(path.join(root, "data/js_check.json")));
const core = FD.create(M);
const close = (a, b, rt = 1e-6) => Math.abs(a - b) <= rt * Math.max(1, Math.abs(a), Math.abs(b)) + 1e-12;
const bad = {}; let pMax = 0, sigOk = 0, flagOk = 0;
for (const s of chk) {
  const t = [0]; s.dt.forEach((d) => t.push(t[t.length - 1] + d));
  const r = core.analyse(s.v, t, s.sampling, s.channel, s.prev, s.contig);
  for (const k of Object.keys(s.py_feat)) if (!close(r.f[k], s.py_feat[k], 1e-5)) (bad[k] = bad[k] || []).push([s.id, r.f[k], s.py_feat[k]]);
  pMax = Math.max(pMax, Math.abs(r.p - s.py_p));
  if (r.sig === s.py_sig) sigOk++;
  if ((r.p >= M.threshold) === (s.py_p >= M.threshold)) flagOk++;
}
for (const [k, v] of Object.entries(bad)) console.log(`feature ${k}: ${v.length} mismatches e.g.`, v[0]);
console.log(`segments ${chk.length} | max |p_js - p_py| = ${pMax.toExponential(2)} | same alarm ${flagOk}/${chk.length} | same type ${sigOk}/${chk.length}`);

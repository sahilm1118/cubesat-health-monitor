// prints the browser engine's fault injection for fixed inputs, so the server port can be compared
const path = require("path");
const FD = require(path.resolve(__dirname, "../../site/src/fdcore.js"));
const M = require(path.resolve(__dirname, "../models/fd_model.json"));
const SIM = require(path.resolve(__dirname, "../models/sim_data.json"));
const core = FD.create(M);
const out = [];
const s = SIM.playground[0];
const t = [0]; s.dt.forEach((d) => t.push(t[t.length - 1] + d));
for (const kind of ["spike", "noise", "stuck", "offset", "data_gap", "amplitude"]) {
  for (const seed of [1, 42, 777]) {
    const r = core.inject(kind, s.v, t, { seed, severity: 1.3, pos: 0.4 });
    const a = core.analyse(r.v, r.t, s.sampling, s.channel, s.prev, s.contig);
    out.push({ kind, seed, v: r.v, t: r.t, p: a.p, sig: a.sig });
  }
}
console.log(JSON.stringify(out));

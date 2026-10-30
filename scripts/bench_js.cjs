// Latency and size of the deployed detector (browser implementation, site/src/fdcore.js).
// Run: node scripts/bench_js.cjs   (after pipeline_fd.py has written data/js_check.json)
const fs = require("fs"), path = require("path");
const root = path.resolve(__dirname, "..");
const FD = require(path.join(root, "site/src/fdcore.js"));
const M = JSON.parse(fs.readFileSync(path.join(root, "site/data/fd_model.json")));
const chk = JSON.parse(fs.readFileSync(path.join(root, "data/js_check.json")));
const core = FD.create(M);
const segs = chk.map((s) => { const t = [0]; s.dt.forEach((d) => t.push(t[t.length - 1] + d)); return { s, t }; });
const run = () => { for (const { s, t } of segs) core.analyse(s.v, t, s.sampling, s.channel, s.prev, s.contig); };
for (let i = 0; i < 5; i++) run();               // warm-up
const R = 40, times = [];
for (let r = 0; r < R; r++) { const a = process.hrtime.bigint(); run(); times.push(Number(process.hrtime.bigint() - a) / 1e6 / segs.length); }
times.sort((a, b) => a - b);
const nodes = M.trees.reduce((n, t) => n + t.l.length, 0);
const lens = segs.map(({ s }) => s.v.length).sort((a, b) => a - b);
console.log(JSON.stringify({
  windows: segs.length, median_samples: lens[lens.length >> 1], max_samples: lens[lens.length - 1],
  ms_per_window_median: +times[R >> 1].toFixed(3), ms_per_window_p95: +times[Math.floor(R * 0.95)].toFixed(3),
  trees: M.trees.length, nodes,
  // packed binary: feature id (int16) + threshold (float32) + two child indices (int16) + leaf prob (float32) = 14 B
  packed_kb: +(nodes * 14 / 1024).toFixed(1), json_kb: +(fs.statSync(path.join(root, "site/data/fd_model.json")).size / 1024).toFixed(0),
  cpu: require("os").cpus()[0].model, node: process.version,
}));

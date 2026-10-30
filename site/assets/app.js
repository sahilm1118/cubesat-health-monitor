(() => {
  // old single-page links such as index.html#dashboards keep working
  const OLD_LINKS = { monitor: "monitor", dashboards: "dashboards", playground: "playground", upload: "playground", autonomy: "autonomy", architecture: "architecture",
    detection: "detection", validation: "validation", limitations: "validation", battery: "battery", data: "data", about: "about", team: "about" };
  const pageFile = document.body.dataset.file;
  const oldTarget = OLD_LINKS[location.hash.slice(1)];
  if (pageFile === "index.html" && oldTarget) { location.replace(`${oldTarget}.html${location.hash}`); return; }

  const { fd: FD, bh: BH, rp: RP, model: MODEL, sim: SIM, esa: ESA } = window.CHM_DATA;
  // Each page holds only its own sections but shares this script. A missing element resolves to an inert
  // stand-in that absorbs reads, writes and calls, so code for other pages does nothing instead of failing.
  // Anything that needs a real element (observers, charts, animation loops) is gated with has().
  const NOTHING = new Proxy(function () {}, {
    get: (_, k) => k === "then" ? undefined : k === Symbol.toPrimitive ? () => "" : k === Symbol.iterator ? [][Symbol.iterator].bind([]) : NOTHING,
    set: () => true, apply: () => NOTHING,
  });
  const $ = (s) => document.querySelector(s) || NOTHING;
  const has = (s) => !!document.querySelector(s);
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const fmt = (x, d = 3) => Number(x).toFixed(d);
  const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- theme ---------------- */
  const root = document.documentElement;
  try { const t = localStorage.getItem("chm-theme"); if (t) root.dataset.theme = t; } catch (e) {}
  const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("#themeBtn").addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("chm-theme", root.dataset.theme); } catch (e) {}
    repaint();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => repaint());

  /* ---------------- about: copy email ---------------- */
  document.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const txt = b.dataset.copy, label = b.previousElementSibling;
    try { await navigator.clipboard.writeText(txt); b.textContent = "Copied"; }
    catch (err) { const r = document.createRange(); r.selectNodeContents(label); const s = getSelection(); s.removeAllRanges(); s.addRange(r); b.textContent = "Selected: press Ctrl+C"; }
    setTimeout(() => { b.textContent = "Copy email"; }, 2000);
  }));

  /* ---------------- headline numbers ---------------- */
  const best = FD.results.find((r) => r.model === FD.best_model);
  const ov = FD.overview;
  const core = window.FDCore ? FDCore.create(MODEL) : null;
  const THR = FD.threshold;

  /* ---------------- backend API client ----------------
     Base URL comes from <meta name="chm-api">. Every call has a timeout; if the server is unreachable the page
     keeps working with the in-browser model. Only numbers are sent - never files or personal data. */
  const API = (() => {
    const raw = (document.querySelector('meta[name="chm-api"]') || {}).content || "";
    const base = /^https?:\/\/[^\s"'<>]+$/.test(raw) ? raw.replace(/\/+$/, "") : "";
    let online = false;
    async function call(path, body, ms = 6000) {
      if (!base) throw new Error("no API configured");
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
      try {
        const r = await fetch(base + path, { method: body ? "POST" : "GET", mode: "cors", credentials: "omit", referrerPolicy: "no-referrer",
          headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error ? `${data.error}${data.details ? ": " + data.details.map((d) => d.field + " " + d.problem).join("; ") : ""}` : `HTTP ${r.status}`);
        return data;
      } finally { clearTimeout(timer); }
    }
    function setPill(on, txt) {
      online = on; const p = $("#apiPill"); p.classList.toggle("on", on); $("#apiPillTxt").textContent = txt;
      document.dispatchEvent(new CustomEvent("api-status", { detail: { online } }));
    }
    async function check() {
      if (!base) return setPill(false, "Browser mode");
      try { const h = await call("/api/health", null, 4000); setPill(true, `API online · v${h.version}`); }
      catch (e) { setPill(false, "API offline · browser mode"); }
    }
    return { call, check, get online() { return online; }, base };
  })();
  API.check();
  setInterval(() => { if (document.visibilityState === "visible") API.check(); }, 60000);
  const debounce = (fn, ms) => { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; };
  const rulMae = BH.rul.results.reduce((a, r) => a + r.ml_mae, 0) / BH.rul.results.length;
  const rulBase = BH.rul.results.reduce((a, r) => a + r.base_mae, 0) / BH.rul.results.length;
  const sohMae = BH.soh.results.reduce((a, r) => a + r.mae_pct, 0) / BH.soh.results.length;
  const hybMin = Math.min(...Object.values(FD.fdir).map((v) => v.hybrid.detected));
  $("#kpis").innerHTML = [
    [pct(best.accuracy), "of held-out OPS-SAT windows classified correctly"],
    [fmt(best.aucpr), "AUC-PR for fault detection (published best: 0.979)"],
    [Math.round(hybMin * 100) + "%+", "of every injected fault type caught by the hybrid fault-management system"],
    [BH.rul.results.length + " cells", `battery life forecast to ±${rulMae.toFixed(0)} cycles, with ${Math.round(BH.rul.coverage * 100)}% interval coverage`],
  ].map(([b, s]) => `<div class="kpi"><b>${b}</b><span>${s}</span></div>`).join("");
  $("#featTag").textContent = `${ov.n_base} features → ${ov.n_features} inputs`;

  /* ---------------- detection section ---------------- */
  const FAMILY_NAME = { spike: "Spikes & skew", noise: "Sample-to-sample noise", amplitude: "Spread & variance", offset: "Mean level",
    data_gap: "Missing samples", waveform: "Peak rhythm", timing: "Window timing", change: "Change vs previous window" };
  $("#detHeadline").textContent = `The deployed model catches ${FD.confusion_matrix[1][1]} of ${FD.confusion_matrix[1][0] + FD.confusion_matrix[1][1]} faults in flight data it never trained on`;
  $("#detLede").textContent = `Eight candidates were compared: neural networks, gradient boosting, random forests, Extra Trees and an ensemble, with three feature sets (the 19 published features, plus channel-relative z-scores, plus temporal context from the previous window). Selection used 5-fold cross-validation on the ${ov.segments_train.toLocaleString()} training segments only. The deployed model is a compact ${ov.n_trees}-tree Extra Trees forest on ${ov.n_features} inputs. Its probabilities are calibrated, and its alarm threshold (${THR.toFixed(2)}) is chosen on training data. Everything was then scored once on the ${ov.segments_test} held-out test segments.`;
  const maxF1 = Math.max(...FD.results.map((r) => r.f1), ...FD.paper_baselines.map((r) => r.f1));
  const rows = FD.results.map((r) => `<tr class="${r.model === FD.best_model ? "best" : ""}">
      <td>${r.model}${r.type === "Deployed" ? '<span class="pill">deployed</span>' : ""}</td>
      <td class="num">${r.cv_aucpr != null ? fmt(r.cv_aucpr) : "–"}</td>
      <td class="num"><span class="f1bar" style="width:${Math.round(56 * r.f1 / maxF1)}px"></span>${fmt(r.f1)}</td>
      <td class="num">${fmt(r.aucpr)}</td><td class="num">${fmt(r.mcc)}</td>
      <td class="num">${fmt(r.precision)}</td><td class="num">${fmt(r.recall)}</td><td class="num">${pct(r.accuracy)}</td></tr>`).join("")
    + FD.paper_baselines.map((r) => `<tr class="ref"><td>${r.model}<span class="pill">paper</span></td><td class="num">–</td>
      <td class="num"><span class="f1bar" style="width:${Math.round(56 * r.f1 / maxF1)}px;opacity:.35"></span>${fmt(r.f1)}</td>
      <td class="num">${fmt(r.aucpr)}</td><td class="num">${fmt(r.mcc)}</td><td class="num">–</td><td class="num">–</td><td class="num">–</td></tr>`).join("");
  $("#modelTable").innerHTML = `<thead><tr><th>Model · features</th><th>CV AUC-PR</th><th>Test F1</th><th>Test AUC-PR</th><th>Test MCC</th><th>Precision</th><th>Recall</th><th>Accuracy</th></tr></thead><tbody>${rows}</tbody>`;

  const [[tn, fp], [fn, tp]] = FD.confusion_matrix;
  $("#cmModel").textContent = best.model;
  $("#cm").innerHTML = `<div></div><div class="ax">Predicted nominal</div><div class="ax">Predicted anomaly</div>
    <div class="ax">Actual<br>nominal</div><div class="cell good"><b>${tn}</b><span>correctly passed</span></div><div class="cell bad"><b>${fp}</b><span>false alarms</span></div>
    <div class="ax">Actual<br>anomaly</div><div class="cell bad"><b>${fn}</b><span>missed</span></div><div class="cell good"><b>${tp}</b><span>caught</span></div>`;
  $("#prAuc").textContent = "AUC-PR " + fmt(best.aucpr);
  $("#rocAuc").textContent = "AUC-ROC " + fmt(best.aucroc);

  $("#chanTable").innerHTML = `<thead><tr><th>Channel</th><th>Segments</th><th>Faults</th><th>Caught</th><th>False alarms</th></tr></thead><tbody>` +
    FD.per_channel.map((c) => `<tr><td>${c.name} <span class="mono small">${c.channel}</span></td><td class="num">${c.segments}</td><td class="num">${c.anomalies}</td>
      <td class="num">${c.anomalies ? c.detected + " / " + c.anomalies : "–"}</td><td class="num">${c.false_alarms}</td></tr>`).join("") + `</tbody>`;

  /* ---------------- data section ---------------- */
  $("#opsContents").textContent = `${ov.raw_samples.toLocaleString()} raw samples from ${ov.channels} channels, cut into ${ov.segments_total.toLocaleString()} segments labelled by ESA engineers (${ov.anomalies_total} anomalous)`;
  $("#opsSpan").textContent = `${ov.time_start} → ${ov.time_end}`;
  $("#opsSplit").textContent = `${ov.segments_train.toLocaleString()} train / ${ov.segments_test} test (the dataset's official split)`;
  const cellIds = Object.keys(BH.cells);   // showcase cells (digital twin)
  const fleetIds = BH.fleet.map((c) => c.cell);
  const rulIds = BH.rul.results.map((r) => r.battery);
  $("#battContents").textContent = `${BH.fleet.length} usable cells after cleaning (of 34), ${BH.fleet.reduce((a, c) => a + c.cycles, 0).toLocaleString()} clean discharge cycles; ${rulIds.length} reach end of life`;
  $("#battLede").innerHTML = `The models are trained on the NASA Ames fleet of lithium-ion 18650 cells, the format used in many CubeSat battery packs. There are <b>${BH.fleet.length} usable cells</b> tested at 4 °C, room temperature and 43 °C under 1–4 A loads, which covers the thermal swings a satellite sees. End of life is the industry-standard point where capacity falls below <span class="mono">80%</span> of the cell's initial value. Every result is leave-one-cell-out: the model never sees the cell it is tested on.`;
  $("#battStats").innerHTML = [
    [rulMae.toFixed(1) + " cyc", `mean RUL error over ${rulIds.length} cells (straight-line baseline ${rulBase.toFixed(1)})`, "good"],
    [Math.round(BH.rul.coverage * 100) + "%", "of true RUL values fall inside the 90% prediction interval"],
    [sohMae.toFixed(1) + "%", `mean state-of-health error from a 15-minute partial discharge (${BH.soh.results.length} cells)`],
    [BH.fleet.length + " / 34", "cells usable after cleaning and exclusions"],
  ].map(([b, s, c]) => `<div class="dstat ${c || ""}"><b>${b}</b><span>${s}</span></div>`).join("");
  $("#battTableNote").textContent = "RUL error in cycles; coverage = share of cycles where the true RUL fell inside the 90% interval";
  $("#battTable").innerHTML = `<thead><tr><th>Cell</th><th>Temp.</th><th>Load</th><th>EOL cycle</th><th>RUL MAE</th><th>Baseline MAE</th><th>90% coverage</th><th>Interval width</th><th>SOH MAE</th></tr></thead><tbody>` +
    BH.rul.results.map((r) => { const s = BH.soh.results.find((x) => x.battery === r.battery);
      return `<tr><td class="mono">${r.battery}</td><td class="num">${r.ambient} °C</td><td class="num">${r.current} A</td><td class="num">${r.eol_cycle}</td>
        <td class="num">${r.ml_mae.toFixed(1)}</td><td class="num">${r.base_mae.toFixed(1)}</td>
        <td class="num ${r.coverage < 0.8 ? "outcome-bad" : ""}">${Math.round(r.coverage * 100)}%</td><td class="num">±${(r.mean_width / 2).toFixed(0)}</td><td class="num">${s ? s.mae_pct.toFixed(1) + "%" : "–"}</td></tr>`; }).join("") +
    `<tr class="best"><td>Mean</td><td></td><td></td><td></td><td class="num">${rulMae.toFixed(1)}</td><td class="num">${rulBase.toFixed(1)}</td><td class="num">${Math.round(BH.rul.coverage * 100)}%</td><td></td><td class="num">${sohMae.toFixed(1)}%</td></tr></tbody>`;

  /* ---------------- charts ---------------- */
  const charts = {};

  function baseOpts(xTitle, yTitle, extra = {}) {
    const grid = css("--grid"), muted = css("--muted");
    return Object.assign({
      responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 500 },
      interaction: { mode: "nearest", intersect: false },
      plugins: { legend: { labels: { color: muted, boxWidth: 12, boxHeight: 2, font: { family: css("--f-mono"), size: 11 } } },
        tooltip: { backgroundColor: css("--surface"), titleColor: css("--ink"), bodyColor: css("--ink"), borderColor: css("--line"), borderWidth: 1,
          titleFont: { family: css("--f-mono") }, bodyFont: { family: css("--f-mono") } } },
      scales: {
        x: { type: "linear", title: { display: !!xTitle, text: xTitle, color: muted, font: { family: css("--f-mono"), size: 11 } },
          grid: { color: grid }, border: { color: css("--line") }, ticks: { color: muted, font: { family: css("--f-mono"), size: 10 } } },
        y: { title: { display: !!yTitle, text: yTitle, color: muted, font: { family: css("--f-mono"), size: 11 } },
          grid: { color: grid }, border: { color: css("--line") }, ticks: { color: muted, font: { family: css("--f-mono"), size: 10 } } },
      },
    }, extra);
  }
  const pts = (xs, ys) => xs.map((x, i) => ({ x, y: ys[i] }));
  const line = (label, data, color, more = {}) => Object.assign({ label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: 0.15 }, more);
  function mk(id, cfg) { const cv = document.getElementById(id); if (!cv) return; if (charts[id]) charts[id].destroy(); charts[id] = new Chart(cv, cfg); }

  function drawDetectionCharts() {
    const acc = css("--accent"), muted = css("--muted");
    mk("prChart", { type: "line", data: { datasets: [
      line(best.model, pts(FD.pr.recall, FD.pr.precision), acc, { fill: true, backgroundColor: css("--accent-soft"), stepped: true, tension: 0 }),
    ] }, options: baseOpts("Recall", "Precision", {}) });
    charts.prChart.options.plugins.legend.display = false;
    Object.assign(charts.prChart.options.scales.x, { min: 0, max: 1 }); Object.assign(charts.prChart.options.scales.y, { min: 0, max: 1.02 }); charts.prChart.update("none");

    mk("rocChart", { type: "line", data: { datasets: [
      line(best.model, pts(FD.roc.fpr, FD.roc.tpr), acc, { fill: true, backgroundColor: css("--accent-soft"), stepped: true, tension: 0 }),
      line("Random guess", [{ x: 0, y: 0 }, { x: 1, y: 1 }], muted, { borderDash: [4, 4], borderWidth: 1 }),
    ] }, options: baseOpts("False positive rate", "True positive rate") });
    charts.rocChart.options.plugins.legend.display = false;
    Object.assign(charts.rocChart.options.scales.x, { min: 0, max: 1 }); Object.assign(charts.rocChart.options.scales.y, { min: 0, max: 1.02 }); charts.rocChart.update("none");

    const o = baseOpts("Average drop in vote share when the family is reset to normal", "");
    o.indexAxis = "y"; o.plugins.legend.display = false;
    o.scales.y = Object.assign(o.scales.y, { type: "category", grid: { display: false } });
    o.scales.x.min = 0;
    mk("impChart", { type: "bar", data: { labels: FD.importance.map((d) => FAMILY_NAME[d.feature] || d.feature), datasets: [{ data: FD.importance.map((d) => d.value), backgroundColor: acc, borderRadius: 3, barPercentage: 0.7 }] }, options: o });
  }

  const tempColor = (t) => t <= 10 ? css("--accent") : t >= 40 ? css("--fault") : css("--ok");
  function drawFade() {
    const ds = BH.fleet.map((c) => line(`${c.cell} · ${c.ambient} °C`, pts(c.cyc, c.soh), tempColor(c.ambient),
      { borderWidth: c.cell === selCell ? 3 : 1.2, order: c.cell === selCell ? 0 : 1, backgroundColor: tempColor(c.ambient) }));
    const maxC = Math.max(...BH.fleet.map((c) => c.cycles));
    ds.push(line("End of life (80%)", [{ x: 1, y: BH.eol_soh * 100 }, { x: maxC, y: BH.eol_soh * 100 }], css("--ink"), { borderDash: [5, 4], borderWidth: 1.2 }));
    const o = baseOpts("Clean discharge cycle", "State of health (% of initial)");
    o.plugins.legend.display = false; o.scales.y.min = 50; o.scales.y.max = 110;
    o.plugins.tooltip.callbacks = { label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` };
    mk("fadeChart", { type: "line", data: { datasets: ds }, options: o });
  }

  function drawCell() {
    const acc = css("--accent"), muted = css("--muted");
    const r = BH.rul.series[selCell], rr = BH.rul.results.find((x) => x.battery === selCell), fc = BH.fleet.find((c) => c.cell === selCell);
    $("#cellMeta").textContent = fc ? `${fc.ambient} °C · ${fc.current} A load · ${fc.cycles} clean cycles · initial ${fc.c0} Ah` : "";
    if (r) {
      const o = baseOpts("Cycle", "Remaining useful life (cycles)");
      o.scales.y.min = 0;
      mk("rulChart", { type: "line", data: { datasets: [
        line("90% interval", pts(r.cycle, r.hi), "transparent", { fill: "+1", backgroundColor: css("--accent-soft"), borderWidth: 0 }),
        line("lower", pts(r.cycle, r.lo), "transparent", { borderWidth: 0 }),
        line("Actual RUL", pts(r.cycle, r.true), css("--ink"), { borderWidth: 1.5 }),
        line("AI forecast", pts(r.cycle, r.pred), acc),
        line("Straight-line baseline", pts(r.cycle, r.baseline.map((v) => Math.min(v, 200))), css("--warn"), { borderDash: [4, 3], borderWidth: 1.2 }),
      ] }, options: o });
      charts.rulChart.options.plugins.legend.labels.filter = (it) => it.text !== "lower";
      charts.rulChart.update("none");
      $("#rulErr").textContent = `MAE ${rr.ml_mae.toFixed(1)} cycles · coverage ${Math.round(rr.coverage * 100)}%`;
    }
    const s = BH.soh.series[selCell], sr = BH.soh.results.find((x) => x.battery === selCell);
    if (s) {
      mk("sohChart", { type: "line", data: { datasets: [
        line("Measured", pts(s.cycle, s.true), muted, { borderWidth: 1.5 }),
        line("Estimated from 15 min", pts(s.cycle, s.pred), acc, { borderWidth: 0, showLine: false, pointRadius: 2 }),
      ] }, options: baseOpts("Clean discharge cycle", "State of health (%)") });
      $("#sohErr").textContent = `MAE ${sr.mae_pct.toFixed(2)} % points`;
    }
  }

  const cellSel = $("#cellSelect");
  rulIds.forEach((c) => { const r = BH.rul.results.find((x) => x.battery === c); const o = el("option", null, `${c} · ${r.ambient} °C · ${r.current} A`); o.value = c; cellSel.append(o); });
  let selCell = rulIds[0];
  cellSel.addEventListener("change", (e) => { selCell = e.target.value; drawFade(); drawCell(); });

  /* ---------------- validation section ---------------- */
  const SV = FD.sig_validation, CAL = FD.calibration;
  const TYPE_NAME = SV.type_name;
  function drawValidation() {
    const muted = css("--muted");
    const oc = baseOpts("Predicted probability", "Observed share of real faults");
    oc.scales.x.min = 0; oc.scales.x.max = 1; oc.scales.y.min = 0; oc.scales.y.max = 1;
    mk("calChart", { type: "line", data: { datasets: [
      line("Perfect calibration", [{ x: 0, y: 0 }, { x: 1, y: 1 }], muted, { borderDash: [4, 4], borderWidth: 1 }),
      line(`Raw vote share (Brier ${CAL.brier_raw.toFixed(4)})`, CAL.raw.map((b) => ({ x: b.pred, y: b.obs })), css("--warn"), { pointRadius: 3, tension: 0 }),
      line(`Calibrated (Brier ${CAL.brier_cal.toFixed(4)})`, CAL.cal.map((b) => ({ x: b.pred, y: b.obs })), css("--accent"), { pointRadius: 4, tension: 0 }),
    ] }, options: oc });
    const types = SV.types;
    const oi = baseOpts("", "Share of injected windows flagged by the AI");
    oi.scales.x = { ...oi.scales.x, type: "category", grid: { display: false } }; oi.scales.y.min = 0; oi.scales.y.max = 1;
    oi.scales.y.ticks.callback = (v) => Math.round(v * 100) + "%"; oi.plugins.legend.display = false;
    mk("injChart", { type: "bar", data: { labels: types.map((t) => TYPE_NAME[t]), datasets: [
      { label: "Flagged", data: types.map((t) => SV.detection[t]), backgroundColor: types.map((t) => SV.detection[t] >= 0.5 ? css("--accent") : css("--warn")), borderRadius: 3 },
    ] }, options: oi });
  }
  $("#injNote").textContent = `${SV.n_segments} healthy test windows × 6 fault types`;
  $("#calNote").textContent = `Brier score ${CAL.brier_raw.toFixed(4)} → ${CAL.brier_cal.toFixed(4)}`;
  $("#sigTable").innerHTML = `<thead><tr><th>Injected fault</th><th>Flagged by AI</th><th>Type named correctly</th><th>Most common other label</th></tr></thead><tbody>` +
    SV.types.map((t) => { const conf = SV.confusion[t] || {}; const others = Object.entries(conf).filter(([k]) => k !== t).sort((a, b) => b[1] - a[1]);
      const acc = SV.sig_accuracy[t];
      return `<tr><td>${TYPE_NAME[t]}</td><td class="num">${Math.round(SV.detection[t] * 100)}%</td>
        <td class="num ${acc == null ? "" : acc >= 0.8 ? "outcome-ok" : "outcome-bad"}">${acc == null ? "n/a (not flagged)" : Math.round(acc * 100) + "%"}</td>
        <td>${others.length ? `${others[0][0].replace("_", " ")} (${others[0][1]})` : "–"}</td></tr>`; }).join("") + `</tbody>`;
  $("#valStats").innerHTML = [
    [`${Math.round(SV.control_false_alarm * 100)}%`, "false alarms on the same windows with no fault injected", "good"],
    [CAL.brier_cal.toFixed(3), "Brier score after calibration (lower is better)"],
    [`${Math.round(Math.min(...["data_gap", "stuck", "noise", "spike"].map((t) => SV.sig_accuracy[t])) * 100)}–100%`, "anomaly type named correctly (spike, noise, stuck, data gap)"],
    ESA ? [(ESA.retrained.aucpr / ESA.retrained.prevalence).toFixed(0) + "× chance", `AUC-PR on a different ESA spacecraft after retraining (zero-shot transfer stays at chance)`] : ["–", "cross-mission test pending"],
  ].map(([b, s, c]) => `<div class="dstat ${c || ""}"><b>${b}</b><span>${s}</span></div>`).join("");
  if (ESA) {
    const R = (m) => `<td class="num">${fmt(m.aucpr)}</td><td class="num">${fmt(m.f1)}</td><td class="num">${fmt(m.precision)}</td><td class="num">${fmt(m.recall)}</td>`;
    $("#esaNote").textContent = `${ESA.channels.length} channels · ${ESA.n_test.toLocaleString()} test windows · ${ESA.span[0].slice(0, 4)}–${ESA.span[1].slice(0, 4)}`;
    $("#esaTable").innerHTML = `<thead><tr><th>Approach</th><th>AUC-PR</th><th>F1</th><th>Precision</th><th>Recall</th></tr></thead><tbody>
      <tr><td>Chance level</td><td class="num">${fmt(ESA.zero_shot.prevalence)}</td><td class="num">–</td><td class="num">–</td><td class="num">–</td></tr>
      <tr><td>OPS-SAT model, zero-shot</td>${R(ESA.zero_shot)}</tr>
      <tr class="best"><td>Same method, retrained on ESA</td>${R(ESA.retrained)}</tr>
      <tr><td>Classic limit check</td>${R(ESA.limit)}</tr>
      <tr><td>Hybrid (retrained + limits)</td>${R(ESA.hybrid_retrained)}</tr></tbody>`;
    $("#esaContents").textContent = `${ESA.channels.length} channels (${ESA.channels.map((c) => c.replace("channel_", "#")).join(", ")}), ${ESA.n_windows.toLocaleString()} windows of ${ESA.window} samples, ${ESA.span[0]} → ${ESA.span[1]}`;
    $("#esaText").textContent = `What this shows: the OPS-SAT model applied unchanged to another spacecraft performs at chance, so a trained model does not transfer between missions. The same method retrained on the new mission's first half reaches ${(ESA.retrained.aucpr / ESA.retrained.prevalence).toFixed(0)}× the chance AUC-PR and ${Math.round(ESA.retrained.precision * 100)}% precision on the second half, beating a classic limit check. So each mission needs its own training period. Test period = the second half of each channel's history. A window counts as a fault if it overlaps a labelled anomaly or rare event. For zero-shot, only each channel's normal profile comes from the first 30% of the mission.`;
    const exBox = $("#esaEx");
    ESA.examples.forEach((x) => { const d = el("div", "esa-card", `<canvas class="spark mini"></canvas><span class="mono">${x.channel.replace("channel_", "#")} · ${x.start.slice(0, 10)}</span><span class="badge ${x.label ? "anom" : "nom"}">${x.label ? "labelled event" : "nominal"}</span><span class="mono">p ${x.p_retr.toFixed(2)} retrained · ${x.p_zero.toFixed(2)} zero-shot</span>`); exBox.append(d); x._cv = d.querySelector("canvas"); });
  } else {
    $("#esaPanel").innerHTML = `<h3>A different spacecraft: ESA Mission 1</h3><p class="small">The cross-mission results will appear here after <span class="mono">pipeline_esa.py</span> has run.</p>`;
  }
  function drawEsaSparks() { if (ESA) ESA.examples.forEach((x) => x._cv && sparkline(x._cv, x.v, x.label ? css("--fault") : css("--accent"))); }

  function drawAllCharts() {
    if (!window.Chart) return;
    Chart.defaults.font.family = css("--f-body");
    Chart.defaults.color = css("--muted");
    if (has("#prChart")) drawDetectionCharts();
    if (has("#fadeChart")) { drawFade(); drawCell(); }
    if (has("#calChart")) { drawValidation(); drawEsaSparks(); }
    if (has("#mcChart")) drawMC();
  }

  /* ---------------- live telemetry replay ---------------- */
  const SEG_SECONDS = 2.6;      // replay time per segment at 1x
  const HOLD_SECONDS = 0.7;     // pause after a nominal verdict
  const HOLD_FAULT_SECONDS = 5; // longer pause so the diagnosis can be read
  const channels = Object.keys(RP);
  const state = { ch: "CADC0872", idx: 0, progress: 0, hold: 0, playing: !reduceMotion, speed: 1, log: [], decided: false };
  const outcomeOf = (s) => s.label && s.pred ? "tp" : s.label ? "fn" : s.pred ? "fp" : "tn";
  const segs = () => RP[state.ch].segments;

  // channel list
  const chanList = $("#chanList");
  let lastGroup = "";
  channels.forEach((ch) => {
    const info = RP[ch], pc = FD.per_channel.find((p) => p.channel === ch);
    if (info.subsystem !== lastGroup) { chanList.append(el("div", "chan-group", info.subsystem === "ADCS" ? "Attitude control · magnetometer" : "Sun sensing · photodiodes")); lastGroup = info.subsystem; }
    const b = el("button", "chan", `<span class="nm">${info.name}</span><span class="id">${ch}</span><span class="rate">${pc.anomalies ? pc.detected + "/" + pc.anomalies + " caught" : "no faults"}</span>`);
    b.type = "button"; b.dataset.ch = ch; b.setAttribute("aria-pressed", ch === state.ch);
    chanList.append(b);
  });
  chanList.addEventListener("click", (e) => { const b = e.target.closest(".chan"); if (b) selectChannel(b.dataset.ch); });

  function selectChannel(ch) {
    state.ch = ch; state.log = [];
    chanList.querySelectorAll(".chan").forEach((b) => b.setAttribute("aria-pressed", b.dataset.ch === ch));
    buildTimeline();
    // open on the channel's first caught fault, already diagnosed, so the panel shows a real example
    const first = segs().findIndex((s) => s.label && s.pred);
    if (first < 0) { jumpTo(Math.min(3, segs().length - 1)); return; }
    jumpTo(first);
    state.progress = 1; state.decided = true; state.hold = 0;
    state.log.unshift(segs()[first]);
    renderPanels(); renderLog(); draw();
  }

  function buildTimeline() {
    const tl = $("#timeline"); tl.innerHTML = "";
    segs().forEach((s, i) => {
      const b = el("button", "tl " + outcomeOf(s)); b.type = "button"; b.dataset.i = i;
      b.title = `Segment #${s.id} · ${s.start} UTC · ${outcomeOf(s).toUpperCase()}`;
      b.setAttribute("aria-label", `Segment ${s.id}, ${s.start}`);
      tl.append(b);
    });
    const ss = segs(), n = ss.length, a = ss.filter((s) => s.label).length;
    $("#tlRight").textContent = `${n} segments · ${a} faults`;
  }
  $("#timeline").addEventListener("click", (e) => { const b = e.target.closest(".tl"); if (b) jumpTo(+b.dataset.i); });

  function jumpTo(i) {
    state.idx = i; state.progress = 0; state.hold = 0; state.decided = false;
    state.log = segs().slice(0, i).filter((s) => s.label || s.pred).slice(-6).reverse();
    renderPanels(); renderLog(); draw();
  }

  function renderPanels() {
    const s = segs()[state.idx];
    document.querySelectorAll(".tl.cur").forEach((x) => x.classList.remove("cur"));
    const cell = $(`#timeline .tl[data-i="${state.idx}"]`); if (cell) cell.classList.add("cur");
    $("#scopeMeta").innerHTML = `<span>Channel <b>${RP[state.ch].name}</b></span><span>Segment <b>#${s.id}</b></span><span>Start <b>${s.start} UTC</b></span><span>Length <b>${s.duration_s} s · ${s.samples} samples</b></span>`;
    $("#replayClock").textContent = s.start.slice(0, 10);
    renderDiagnosis();
    const chip = $("#chip"), meter = $("#meter");
    if (!state.decided) {
      chip.className = "chip wait"; chip.textContent = "Analysing…";
      meter.firstElementChild.style.width = "0%"; meter.classList.remove("hot");
      $("#segKv").innerHTML = `<dt>Expert label</dt><dd>–</dd><dt>Outcome</dt><dd>–</dd>`;
      return;
    }
    chip.className = "chip " + (s.pred ? "anom" : "nom"); chip.textContent = s.pred ? "Anomaly detected" : "Nominal";
    meter.firstElementChild.style.width = (s.score * 100).toFixed(1) + "%"; meter.classList.toggle("hot", !!s.pred);
    const o = outcomeOf(s);
    const out = { tp: ["Fault caught", "outcome-ok"], tn: ["Correct", "outcome-ok"], fp: ["False alarm", "outcome-warn"], fn: ["Fault missed", "outcome-bad"] }[o];
    $("#segKv").innerHTML = `<dt>Probability</dt><dd>${s.score.toFixed(3)}</dd><dt>Expert label</dt><dd>${s.label ? "anomaly" : "nominal"}</dd><dt>Outcome</dt><dd class="${out[1]}">${out[0]}</dd>`;
  }

  function renderLog() {
    const ul = $("#log");
    ul.innerHTML = state.log.length ? "" : `<li style="grid-template-columns:1fr" class="tn">No faults flagged yet on this channel.</li>`;
    state.log.forEach((s) => {
      const o = outcomeOf(s);
      const txt = { tp: "caught", fn: "missed", fp: "false alarm" }[o] + " · " + (SIGNATURES[s.sig] || SIGNATURES.subtle).name.split(" /")[0].toLowerCase();
      ul.append(el("li", o, `<span><b>${s.start.slice(5, 16)}</b> #${s.id} p=${s.score.toFixed(2)} ${txt}</span>`));
    });
  }

  /* ---------- diagnosis: anomaly signature, AI reasoning, recommended action ---------- */
  const FEATURE_LABEL = {
    mean: "Mean level", var: "Variance", std: "Standard deviation", kurtosis: "Kurtosis (peakedness)", skew: "Skewness",
    n_peaks: "Number of peaks", smooth10_n_peaks: "Peaks after 10-pt smoothing", smooth20_n_peaks: "Peaks after 20-pt smoothing",
    diff_peaks: "Peaks in 1st derivative", diff2_peaks: "Peaks in 2nd derivative", diff_var: "Variance of 1st derivative",
    diff2_var: "Variance of 2nd derivative", gaps_squared: "Sum of squared sample gaps", len_weighted: "Length weighted by sampling",
    var_div_duration: "Variance per second", var_div_len: "Variance per sample", duration: "Window duration", len: "Samples in window",
    sampling: "Sampling interval",
  };
  const SIGNATURES = {
    spike:     { name: "Spike / transient outlier", desc: "One or a few samples jump far from the rest of the window and return. The signal's distribution becomes sharply peaked (high kurtosis).", cause: "Single-event upset from radiation, an electrical transient, or sun glint and Earth albedo on a photodiode." },
    noise:     { name: "Noise burst", desc: "Sample-to-sample changes become much larger than normal for this sensor, while the overall shape may stay similar.", cause: "Interference from magnetorquer actuation or power switching, a loose connection, or a degrading sensor." },
    stuck:     { name: "Flat-line / stuck sensor", desc: "The signal almost stops changing. Variance and derivative energy collapse far below this channel's normal range.", cause: "Frozen sensor output, a saturated ADC, or a failed read loop that repeats the last value." },
    data_gap:  { name: "Data gap", desc: "Samples are missing inside the window. The gaps between samples are much larger than this channel normally shows.", cause: "Bus errors (I²C/SPI/CAN), an overloaded onboard computer, or a sensor dropping out." },
    timing:    { name: "Timing / sampling irregularity", desc: "The window's length or sampling pattern differs from normal operation for this channel. The model leaned on these timing features.", cause: "Mode changes, logging-task delays, or sampling-rate switches." },
    offset:    { name: "Level shift / bias", desc: "The whole window sits at a different level than this channel normally reads.", cause: "Sensor bias drift, temperature effects, or a real change in attitude or illumination." },
    amplitude: { name: "Amplitude excursion", desc: "The signal swings much wider than this channel's normal range.", cause: "A real attitude disturbance or tumbling, or a gain error in the sensor chain." },
    waveform:  { name: "Waveform shape change", desc: "The number and spacing of peaks differs from normal, so the signal's rhythm has changed.", cause: "An unexpected change in spin rate or attitude, or a sensor that intermittently drops in and out." },
    change:    { name: "Abrupt change from previous window", desc: "This window differs sharply from the one just before it on the same sensor, even though each looks plausible on its own.", cause: "A sudden mode or attitude change, or the onset of a fault." },
    subtle:    { name: "Subtle pattern change", desc: "No single statistic stands out. The model reacted to a combination of small deviations.", cause: "Early-stage degradation or an unusual operating condition." },
  };
  const TIERS = ["Monitor", "Isolate", "Safe mode"];
  const BASE_TIER = { spike: 1, noise: 1, timing: 1, subtle: 1, change: 1, waveform: 2, offset: 2, amplitude: 2, data_gap: 2, stuck: 2 };
  const ACTIONS = {
    ADCS: {
      spike: ["Reject the outlier samples in the attitude estimator (innovation gate).", "Keep the current ADCS mode. No actuator change is needed.", "Log the window and queue it for the next downlink."],
      noise: ["Check whether magnetorquers were firing in this window. If so, read the magnetometer only while they are off.", "Increase the measurement-noise setting for this axis in the attitude filter.", "Declare the axis degraded if noise continues for 3 or more windows."],
      stuck: ["Mark this magnetometer axis invalid.", "Determine attitude from the other axes, sun sensors and gyro.", "Power-cycle the magnetometer at the next safe opportunity and alert the ground at the next pass."],
      data_gap: ["Read bus error counters and check the onboard computer's logging task.", "Propagate attitude with the gyro during the gap.", "Reset the sensor interface if gaps repeat."],
      timing: ["Check that the sampling schedule matches the active ADCS mode.", "Confirm the logging task is not overrunning.", "Log the window for ground review."],
      offset: ["Compare the reading with the IGRF magnetic-field model for the current orbit position.", "If a bias is confirmed, apply an in-flight calibration update.", "Queue the evidence for ground review."],
      amplitude: ["Cross-check gyro rates. A real disturbance appears on every sensor.", "If the satellite is tumbling, switch to detumble (B-dot) mode.", "If only this axis is affected, isolate it as a sensor fault."],
      waveform: ["Cross-check the other two axes and the gyro.", "If all sensors agree, treat it as a real attitude change and verify the pointing mode.", "If only this axis changed, isolate it as a sensor fault."],
      subtle: ["Raise the monitoring rate on this channel.", "Log the window and the feature values for ground review.", "Escalate if the next windows are flagged too."],
    },
    "Sun sensing": {
      spike: ["Drop the outlier samples from the sun-vector solution.", "Keep using the other photodiodes. No mode change is needed.", "Log the event. Likely causes are Earth albedo, glint or a radiation hit."],
      noise: ["Exclude this photodiode from the sun-vector solution until it settles.", "Check the panel temperature and power-bus switching at that time.", "Declare it degraded if noise continues for 3 or more windows."],
      stuck: ["Mark the photodiode failed.", "Compute the sun vector from the remaining photodiodes.", "Flag the affected face in the power-generation estimate and alert the ground."],
      data_gap: ["Read the ADC and bus error counters.", "Hold the last valid sun vector and propagate it with the gyro.", "Reset the acquisition chain if gaps repeat."],
      timing: ["Check that the photodiode sampling schedule matches the current mode.", "Confirm the logging task is not overrunning.", "Log the window for ground review."],
      offset: ["Recalibrate against the coarse sun vector from the other photodiodes.", "Check for partial shadowing by deployables.", "Queue for ground review as possible degradation."],
      amplitude: ["Check the gyro for a real attitude change.", "Check whether the satellite is entering or leaving eclipse earlier than predicted.", "Isolate the photodiode if the other sensors disagree."],
      waveform: ["Compare eclipse and illumination timing with the orbit propagator.", "If the timing is unexpected, verify the attitude mode.", "Isolate the photodiode if it alone disagrees."],
      subtle: ["Raise the monitoring rate on this channel.", "Log the window and the feature values for ground review.", "Escalate if the next windows are flagged too."],
    },
  };

  function fmtNum(x) {
    const a = Math.abs(x);
    if (a !== 0 && (a < 1e-3 || a >= 1e5)) return x.toExponential(1);
    return a >= 100 ? x.toFixed(0) : a >= 1 ? x.toFixed(2) : x.toFixed(3);
  }

  function priorFlagStreak() {
    const ss = segs(); let n = 0;
    for (let i = state.idx - 1; i >= 0 && ss[i].pred; i--) n++;
    return n;
  }

  function renderDiagnosis() {
    const s = segs()[state.idx], sub = RP[state.ch].subsystem, chName = RP[state.ch].name;
    const what = $("#diagWhat"), how = $("#diagHow"), act = $("#diagAct");
    if (!state.decided) {
      what.innerHTML = `<p class="quiet">Collecting window #${s.id} (${s.samples} samples over ${s.duration_s} s)…</p>`;
      how.innerHTML = `<ul class="trace"><li><span class="n">1</span><span>Acquire telemetry window</span><span class="r">in progress</span></li></ul>`;
      act.innerHTML = `<p class="quiet">The decision is made once the window is complete.</p>`;
      return;
    }
    const sig = SIGNATURES[s.sig] || SIGNATURES.subtle;
    const streak = priorFlagStreak();
    const steps = (flagLabel) => `<ul class="trace">
        <li><span class="n">1</span><span>Acquire window from ${chName}</span><span class="r">${s.samples} samples</span></li>
        <li><span class="n">2</span><span>Measure ${ov.n_base} features, compare with this sensor's normal profile and with the previous window</span><span class="r">${ov.n_features} inputs</span></li>
        <li><span class="n">3</span><span>${ov.n_trees} trees vote; vote share is calibrated</span><span class="r">p = ${s.score.toFixed(3)}</span></li>
        <li><span class="n">4</span><span>Compare with alarm threshold ${THR.toFixed(2)}</span><span class="r ${s.pred ? "outcome-bad" : "outcome-ok"}">${flagLabel}</span></li>
        ${s.pred ? `<li><span class="n">5</span><span>Match the anomaly signature</span><span class="r">${sig.name.split(" /")[0]}</span></li>` : ""}
      </ul>`;
    const contribs = (s.why || []).filter((w) => w.c > 0);
    const maxC = Math.max(0.01, ...contribs.map((w) => w.c));
    const contribHtml = contribs.length ? `<div class="v-label" style="margin-top:4px">Evidence that raised the probability</div><div class="contrib">` + contribs.map((w) => `
        <div class="contrib-row"><span class="lbl">${FAMILY_NAME[w.g] || w.g}<small>${FEATURE_LABEL[w.f] || w.f}: ${fmtNum(w.val)}${w.med != null ? ` vs normal ${fmtNum(w.med)}` : ""}${w.z ? ` (${w.z > 0 ? "+" : ""}${w.z.toFixed(1)} IQR)` : ""}</small></span>
        <span class="val">+${w.c.toFixed(2)}</span><span class="bar"><i style="width:${(100 * w.c / maxC).toFixed(0)}%"></i></span></div>`).join("") +
      `</div><p class="callout">Each bar is the drop in the trees' vote share when that whole family of measurements is reset to this sensor's normal values.</p>` : "";

    if (!s.pred && !s.label) {
      what.innerHTML = `<h4>No anomaly</h4><p>${chName} behaved like its normal training data in this window.</p>`;
      how.innerHTML = steps("nominal");
      act.innerHTML = `<div class="tier">${TIERS.map((t) => `<span>${t}</span>`).join("")}</div><p class="quiet">No action needed. Telemetry continues at the normal rate.</p>`;
      return;
    }
    if (!s.pred && s.label) {
      what.innerHTML = `<h4>${sig.name}</h4><div class="sig-tag"><span>${sub}</span><span>expert label: anomaly</span></div><p>${sig.desc}</p>`;
      how.innerHTML = steps("nominal") + `<p class="callout outcome-bad">Missed: ESA's experts labelled this window anomalous, but the probability stayed below the threshold.</p>`;
      act.innerHTML = `<div class="tier">${TIERS.map((t) => `<span>${t}</span>`).join("")}</div><p class="quiet">No automatic action was triggered. The system still downlinks feature summaries every pass, so the ground team can catch faults the onboard model misses.</p>`;
      return;
    }
    let tier = BASE_TIER[s.sig] || 1;
    const escalated = streak >= 2 && s.score >= 0.9 && tier < 3;
    if (escalated) tier += 1;
    const list = (ACTIONS[sub] && ACTIONS[sub][s.sig]) || ACTIONS[sub].subtle;
    const safe = tier === 3 ? ["Enter safe mode: point the solar panels at the sun, switch off non-essential loads and wait for ground contact."] : [];
    what.innerHTML = `<h4>${sig.name}</h4>
      <div class="sig-tag"><span class="hot">${sub}</span><span>${chName}</span><span>${s.label ? "confirmed by expert label" : "expert label: nominal"}</span></div>
      <p>${sig.desc}</p><p><b style="color:var(--ink);font-weight:600">Likely causes:</b> ${sig.cause}</p>
      <p class="callout">The type is named by physical rules in priority order: missing samples, flat-lines, isolated jumps, then statistics against ${chName}'s normal range. The rules are validated on injected faults (see Validation). OPSSAT-AD labels only say whether a window is anomalous.</p>`;
    how.innerHTML = steps("ANOMALY") + contribHtml;
    act.innerHTML = `<div class="tier">${TIERS.map((t, i) => `<span class="${i + 1 === tier ? "on" + tier : ""}">${t}</span>`).join("")}</div>
      <ol class="steps">${[...safe, ...list].map((x) => `<li>${x}</li>`).join("")}</ol>
      <p class="callout">${escalated ? `Raised one level because this is flagged window number ${streak + 1} in a row, with p ≥ 0.9.` : streak ? `${streak} earlier window${streak > 1 ? "s" : ""} on this channel were also flagged. Three in a row with p ≥ 0.9 raises the level.` : "Raised one level if the next windows are flagged with p ≥ 0.9."}${s.label ? "" : " ESA labelled this window nominal, so this is a false alarm. Monitor-level actions cost little, which limits the harm."} This response playbook is a proposed design. It is not flight software.</p>`;
    const d = $("#diag"); d.classList.remove("flash"); void d.offsetWidth; d.classList.add("flash");
  }

  // canvas oscilloscope
  const cvs = $("#scope"), ctx = cvs.getContext("2d");
  function fit() {
    const r = cvs.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    cvs.width = Math.round(r.width * dpr); cvs.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const hasMonitor = has("#scope");
  if (hasMonitor) new ResizeObserver(() => { fit(); draw(); }).observe(cvs);

  function fmtVal(v, span) {
    if (span < 1e-3) return (v * 1e6).toFixed(1) + "µ";
    return v.toFixed(span < 0.1 ? 3 : 2);
  }

  function draw() {
    if (!hasMonitor) return;
    const W = cvs.clientWidth, H = cvs.clientHeight; if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);
    const ss = segs(), SLOTS = W < 520 ? 3 : 4;
    const start = Math.max(0, state.idx - (SLOTS - 1));
    const vis = ss.slice(start, state.idx + 1);
    let lo = Infinity, hi = -Infinity;
    vis.forEach((s) => s.v.forEach((v) => { if (v < lo) lo = v; if (v > hi) hi = v; }));
    if (!(hi > lo)) { hi = lo + 1; }
    const pad = (hi - lo) * 0.12; lo -= pad; hi += pad;
    const L = 52, R = 10, T = 14, B = 22, pw = W - L - R, ph = H - T - B, sw = pw / SLOTS;
    const y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
    const muted = css("--muted"), grid = css("--grid"), acc = css("--accent"), fault = css("--fault"), faultSoft = css("--fault-soft"), line = css("--line");
    ctx.font = `10px ${css("--f-mono")}`; ctx.textBaseline = "middle";
    for (let k = 0; k <= 4; k++) {
      const v = lo + (hi - lo) * k / 4, yy = y(v);
      ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke();
      ctx.fillStyle = muted; ctx.textAlign = "right"; ctx.fillText(fmtVal(v, hi - lo), L - 6, yy);
    }
    vis.forEach((s, j) => {
      const x0 = L + j * sw, isCur = start + j === state.idx;
      const done = !isCur || state.decided;
      if (done && s.pred) { ctx.fillStyle = faultSoft; ctx.fillRect(x0 + 2, T, sw - 4, ph); }
      if (done && s.label) { ctx.fillStyle = fault; ctx.fillRect(x0 + 2, T - 6, sw - 4, 4); }
      if (j > 0) { ctx.strokeStyle = line; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x0, T); ctx.lineTo(x0, T + ph); ctx.stroke(); ctx.setLineDash([]); }
      ctx.fillStyle = muted; ctx.textAlign = "left"; ctx.fillText(s.start.slice(5, 16).replace(" ", " · "), x0 + 6, H - 10);
      const n = s.v.length, upto = isCur ? Math.max(1, Math.floor(state.progress * (n - 1)) + 1) : n;
      ctx.strokeStyle = acc; ctx.globalAlpha = isCur ? 1 : 0.75; ctx.lineWidth = isCur ? 1.8 : 1.4; ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < upto; i++) { const xx = x0 + 6 + (i / (n - 1 || 1)) * (sw - 12); i ? ctx.lineTo(xx, y(s.v[i])) : ctx.moveTo(xx, y(s.v[i])); }
      ctx.stroke(); ctx.globalAlpha = 1;
      if (isCur && !state.decided) {
        const xx = x0 + 6 + ((upto - 1) / (n - 1 || 1)) * (sw - 12);
        ctx.fillStyle = acc; ctx.beginPath(); ctx.arc(xx, y(s.v[upto - 1]), 3.5, 0, Math.PI * 2); ctx.fill();
      }
    });
  }

  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    if (state.playing) {
      if (!state.decided) {
        state.progress += dt * state.speed / SEG_SECONDS;
        if (state.progress >= 1) {
          state.progress = 1; state.decided = true; state.hold = 0;
          const s = segs()[state.idx];
          if (s.label || s.pred) { state.log.unshift(s); state.log = state.log.slice(0, 6); renderLog(); }
          renderPanels();
          if (s.pred && $("#pauseOnFault").checked) setPlaying(false);
        }
      } else {
        state.hold += dt * state.speed;
        const cur = segs()[state.idx];
        if (state.hold >= (cur.pred || cur.label ? HOLD_FAULT_SECONDS : HOLD_SECONDS)) {
          state.idx = (state.idx + 1) % segs().length; state.progress = 0; state.decided = false;
          if (state.idx === 0) state.log = [];
          renderPanels(); renderLog();
        }
      }
      draw();
    }
    requestAnimationFrame(tick);
  }

  const playBtn = $("#playBtn");
  function setPlaying(p) { state.playing = p; playBtn.textContent = p ? "Pause" : "Play"; $("#console").classList.toggle("paused", !p); }
  playBtn.addEventListener("click", () => setPlaying(!state.playing));
  document.querySelectorAll("[data-speed]").forEach((b) => b.addEventListener("click", () => {
    state.speed = +b.dataset.speed;
    document.querySelectorAll("[data-speed]").forEach((x) => x.setAttribute("aria-pressed", x === b));
  }));
  $("#nextAnomBtn").addEventListener("click", () => {
    const ss = segs(); let i = state.idx;
    for (let k = 1; k <= ss.length; k++) { const j = (state.idx + k) % ss.length; if (ss[j].label) { i = j; break; } }
    jumpTo(i); setPlaying(true);
  });

  $("#consoleFoot").innerHTML = `Replaying the ${ov.segments_test} held-out test segments of OPS-SAT telemetry in time order. The model never saw these during training. Each verdict comes from the deployed model (alarm threshold ${THR.toFixed(2)}) and is checked against ESA's expert label.`;
  $("#meter").style.setProperty("--thr", (THR * 100).toFixed(0) + "%"); $("#thrLbl").textContent = "alarm " + THR.toFixed(2);

  /* ---------------- rotating 3U CubeSat (three.js) ---------------- */
  function initSat() {
    if (!has("#satCanvas")) return null;
    const box = $("#satBox"), canvas = $("#satCanvas");
    if (!window.THREE) { box.hidden = true; return null; }
    const T = THREE;
    let renderer;
    try { renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
    catch (e) { box.hidden = true; return null; }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    renderer.outputEncoding = T.sRGBEncoding;
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(32, 1, 0.1, 100);
    camera.position.set(0, 0.6, 9.2);
    camera.lookAt(0, 0, 0);

    scene.add(new T.HemisphereLight(0xdfe8ff, 0x1a2030, 0.75));
    const sun = new T.DirectionalLight(0xfff4e0, 1.35); sun.position.set(5, 4, 6); scene.add(sun);
    const rim = new T.DirectionalLight(0x8ca3ff, 0.55); rim.position.set(-6, -2, -5); scene.add(rim);

    // Solar-panel texture: 3 units, two triple-junction cells per unit with cropped corners
    function solarTexture(wing) {
      const c = document.createElement("canvas"); c.width = 256; c.height = 768;
      const g = c.getContext("2d");
      g.fillStyle = wing ? "#2a3140" : "#9aa3b0"; g.fillRect(0, 0, 256, 768);
      const cw = 104, ch = 214, cut = 14;
      for (let u = 0; u < 3; u++) for (let k = 0; k < 2; k++) {
        const x = 18 + k * (cw + 12), y = 18 + u * 250;
        const grd = g.createLinearGradient(x, y, x + cw, y + ch);
        grd.addColorStop(0, "#1b2a66"); grd.addColorStop(0.55, "#24398a"); grd.addColorStop(1, "#16224f");
        g.fillStyle = grd;
        g.beginPath(); g.moveTo(x + cut, y); g.lineTo(x + cw - cut, y); g.lineTo(x + cw, y + cut); g.lineTo(x + cw, y + ch - cut);
        g.lineTo(x + cw - cut, y + ch); g.lineTo(x + cut, y + ch); g.lineTo(x, y + ch - cut); g.lineTo(x, y + cut); g.closePath(); g.fill();
        g.strokeStyle = "rgba(200,210,235,.22)"; g.lineWidth = 1;
        for (let yy = y + 10; yy < y + ch; yy += 9) { g.beginPath(); g.moveTo(x + 3, yy); g.lineTo(x + cw - 3, yy); g.stroke(); }
        g.fillStyle = "#c9ced8"; g.fillRect(x + cw / 2 - 1.5, y + 4, 3, ch - 8);
      }
      const t = new T.CanvasTexture(c); t.encoding = T.sRGBEncoding; t.anisotropy = renderer.capabilities.getMaxAnisotropy();
      return t;
    }
    const solarMat = new T.MeshStandardMaterial({ map: solarTexture(false), metalness: 0.35, roughness: 0.38 });
    const wingMat = new T.MeshStandardMaterial({ map: solarTexture(true), metalness: 0.35, roughness: 0.38 });
    const alu = new T.MeshStandardMaterial({ color: 0xb9c0cb, metalness: 0.75, roughness: 0.35 });
    const anod = new T.MeshStandardMaterial({ color: 0x2b303a, metalness: 0.6, roughness: 0.45 });
    const pcb = new T.MeshStandardMaterial({ color: 0x1f4d3a, metalness: 0.2, roughness: 0.7 });
    const gold = new T.MeshStandardMaterial({ color: 0xd4a640, metalness: 0.9, roughness: 0.3 });
    const glass = new T.MeshStandardMaterial({ color: 0x0a0d14, metalness: 0.9, roughness: 0.08 });

    const sat = new T.Group();
    const S = 0.94, L = 3.0;
    sat.add(new T.Mesh(new T.BoxGeometry(S, L, S), [solarMat, solarMat, anod, anod, solarMat, solarMat]));
    // corner rails, slightly proud of the structure as on a real CubeSat
    const railGeo = new T.BoxGeometry(0.085, L + 0.12, 0.085);
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
      const r = new T.Mesh(railGeo, alu); r.position.set(sx * S / 2, 0, sz * S / 2); sat.add(r);
    });
    // frame rings at each unit boundary
    const ringGeo = new T.BoxGeometry(S + 0.02, 0.035, S + 0.02);
    [-1.5, -0.5, 0.5, 1.5].forEach((y) => { const m = new T.Mesh(ringGeo, alu); m.position.y = y * (L / 3); m.scale.set(1, 1, 1); sat.add(m); });
    // top: payload camera; bottom: GPS patch antenna
    const lens = new T.Mesh(new T.CylinderGeometry(0.2, 0.22, 0.14, 32), anod); lens.position.y = L / 2 + 0.07; sat.add(lens);
    const lensGlass = new T.Mesh(new T.CylinderGeometry(0.15, 0.15, 0.02, 32), glass); lensGlass.position.y = L / 2 + 0.145; sat.add(lensGlass);
    const patch = new T.Mesh(new T.BoxGeometry(0.5, 0.03, 0.5), gold); patch.position.y = -L / 2 - 0.015; sat.add(patch);
    // deployed solar wings hinged on the back edges
    const wingGeo = new T.BoxGeometry(S, L - 0.1, 0.03);
    [-1, 1].forEach((sx) => {
      const w = new T.Mesh(wingGeo, [pcb, pcb, pcb, pcb, wingMat, pcb]);
      w.position.set(sx * (S + 0.06), 0, -S / 2 - 0.02); sat.add(w);
      const hinge = new T.Mesh(new T.CylinderGeometry(0.025, 0.025, L - 0.3, 8), alu);
      hinge.position.set(sx * (S / 2 + 0.03), 0, -S / 2 - 0.02); sat.add(hinge);
    });
    // UHF whip antennas
    const whipGeo = new T.CylinderGeometry(0.012, 0.012, 1.3, 6);
    [[0.6, 0.0], [-0.6, Math.PI]].forEach(([tilt, rotY]) => {
      const p = new T.Group(); p.rotation.y = rotY; p.position.y = -L / 2 + 0.1;
      const wh = new T.Mesh(whipGeo, alu); wh.position.set(0.65, -0.35, 0.3); wh.rotation.z = Math.PI / 2 + tilt; p.add(wh); sat.add(p);
    });

    const tilt = new T.Group(); tilt.rotation.set(0.32, 0, -0.38); tilt.add(sat); scene.add(tilt);

    // orbit ring and a marker riding it
    const ringPts = new T.EllipseCurve(0, 0, 2.75, 2.75).getPoints(160).map((p) => new T.Vector3(p.x, 0, p.y));
    const ringMat = new T.LineDashedMaterial({ color: 0x8ca3ff, dashSize: 0.12, gapSize: 0.1, transparent: true, opacity: 0.55 });
    const ring = new T.LineLoop(new T.BufferGeometry().setFromPoints(ringPts), ringMat); ring.computeLineDistances();
    const orbit = new T.Group(); orbit.rotation.set(1.22, 0, 0.32); orbit.add(ring); scene.add(orbit);
    const dotMat = new T.MeshBasicMaterial({ color: 0x8ca3ff });
    const dot = new T.Mesh(new T.SphereGeometry(0.07, 16, 16), dotMat); orbit.add(dot);

    // starfield: a slowly turning shell of points behind the satellite
    const starPos = [];
    for (let i = 0; i < 520; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, rr = 9 + Math.random() * 7, q = Math.sqrt(1 - u * u);
      starPos.push(rr * q * Math.cos(th), rr * u, rr * q * Math.sin(th) - 4);
    }
    const starGeo = new T.BufferGeometry(); starGeo.setAttribute("position", new T.Float32BufferAttribute(starPos, 3));
    const starMat = new T.PointsMaterial({ size: 0.055, transparent: true, opacity: 0.8, sizeAttenuation: true });
    const stars = new T.Points(starGeo, starMat); scene.add(stars);

    function recolor() { const a = new T.Color(css("--accent")); ringMat.color.copy(a); dotMat.color.copy(a); starMat.color.set(css("--muted")); }
    recolor();

    function size() {
      const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return;
      renderer.setSize(w, h, false); camera.aspect = w / h;
      camera.position.z = w / h < 0.9 ? 12.5 : 10.5; camera.updateProjectionMatrix();
    }
    new ResizeObserver(() => { size(); render(); }).observe(canvas);

    // drag to spin, with inertia
    let spin = 0.35, dragging = false, lastX = 0, angle = 0.6, phase = 0, visible = true;
    canvas.addEventListener("pointerdown", (e) => { dragging = true; lastX = e.clientX; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener("pointermove", (e) => { if (!dragging) return; const dx = e.clientX - lastX; lastX = e.clientX; angle += dx * 0.01; spin = dx * 0.6; });
    const end = () => { dragging = false; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    new IntersectionObserver((es) => { visible = es[0].isIntersecting; }).observe(canvas);

    function render() { sat.rotation.y = angle; dot.position.set(2.75 * Math.cos(phase), 0, 2.75 * Math.sin(phase)); renderer.render(scene, camera); }
    let prev = performance.now();
    function loop(now) {
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      if (visible) {
        if (!dragging) { spin += (0.35 - spin) * Math.min(1, dt * 1.5); angle += spin * dt; }
        phase += dt * 0.35; stars.rotation.y += dt * 0.012;
        sat.position.y = Math.sin(now / 1400) * 0.06;
        render();
      }
      requestAnimationFrame(loop);
    }
    size();
    if (reduceMotion) { render(); canvas.addEventListener("pointermove", () => dragging && render()); }
    else requestAnimationFrame(loop);
    return { recolor: () => { recolor(); render(); } };
  }
  const satView = initSat();

  /* =================== GRAPHICS =================== */
  // run fn(dt, now) every frame only while the element is on screen
  function visibleLoop(elm, fn) {
    let vis = false, prev = performance.now();
    new IntersectionObserver((es) => { vis = es[0].isIntersecting; }, { rootMargin: "100px" }).observe(elm);
    const loop = (now) => { const dt = Math.min(0.05, (now - prev) / 1000); prev = now; if (vis) fn(dt, now); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }
  function dragRotate(canvas, target, opts = {}) {
    let down = false, lx = 0, ly = 0;
    canvas.addEventListener("pointerdown", (e) => { down = true; lx = e.clientX; ly = e.clientY; canvas.setPointerCapture(e.pointerId); target.idle = 0; });
    canvas.addEventListener("pointermove", (e) => { if (!down) return;
      target.ry += (e.clientX - lx) * 0.008; if (opts.tilt) target.rx = Math.max(-1.1, Math.min(1.1, target.rx + (e.clientY - ly) * 0.006));
      lx = e.clientX; ly = e.clientY; target.idle = 0; });
    const up = () => { down = false; }; canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);
  }
  function makeRenderer(canvas) {
    try { const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); r.setPixelRatio(Math.min(devicePixelRatio || 1, 2)); r.outputEncoding = THREE.sRGBEncoding; return r; }
    catch (e) { return null; }
  }
  function fitRenderer(renderer, camera, canvas, cb) {
    let lastW = 0, lastH = 0;
    const f = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h || (w === lastW && h === lastH)) return; lastW = w; lastH = h; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); cb && cb(w, h); };
    new ResizeObserver(f).observe(canvas); f();
    return f;
  }

  /* ---------- 1. orbit globe with ground-station contact ---------- */
  function initOrbit() {
    if (!has("#orbitCanvas")) return null;
    const canvas = $("#orbitCanvas"); if (!window.THREE) { $("#orbitBox").hidden = true; return null; }
    const T = THREE, renderer = makeRenderer(canvas); if (!renderer) { $("#orbitBox").hidden = true; return null; }
    const RE = 6371, ALT = 515, A = RE + ALT, MU = 398600.4418, INC = 97.4 * Math.PI / 180, WE = 7.2921159e-5;
    const N_MOTION = Math.sqrt(MU / (A * A * A)), PERIOD = 2 * Math.PI / N_MOTION, MIN_EL = 10 * Math.PI / 180;
    const GS = { name: "Darmstadt, Germany", lat: 49.87 * Math.PI / 180, lon: 8.62 * Math.PI / 180 };
    const RAAN = 0.9;
    // three.js frame: y = Earth's north axis
    const ecef = (lat, lon, r = 1) => new T.Vector3(r * Math.cos(lat) * Math.cos(lon), r * Math.sin(lat), -r * Math.cos(lat) * Math.sin(lon));
    const satEci = (t, out = new T.Vector3()) => {
      const u = N_MOTION * t, cu = Math.cos(u), su = Math.sin(u), cO = Math.cos(RAAN), sO = Math.sin(RAAN), ci = Math.cos(INC), si = Math.sin(INC);
      const x = cu * cO - su * ci * sO, y = cu * sO + su * ci * cO, z = su * si;
      return out.set(x, z, -y).multiplyScalar(A / RE);
    };
    const gsLocal = ecef(GS.lat, GS.lon);
    const yAxis = new T.Vector3(0, 1, 0);
    const tmpS = new T.Vector3(), tmpG = new T.Vector3(), tmpD = new T.Vector3();
    function geometry(t) {
      satEci(t, tmpS); tmpG.copy(gsLocal).applyAxisAngle(yAxis, WE * t);
      tmpD.copy(tmpS).sub(tmpG); const range = tmpD.length();
      const el = Math.asin(tmpD.dot(tmpG) / range);
      return { el, range: range * RE };
    }
    // 24 h statistics computed from the same model
    let passes = 0, contactS = 0, inC = false, gapMax = 0, lastEnd = 0;
    for (let t = 0; t <= 86400; t += 5) {
      const c = geometry(t).el > MIN_EL;
      if (c) contactS += 5;
      if (c && !inC) { passes++; gapMax = Math.max(gapMax, t - lastEnd); }
      if (!c && inC) lastEnd = t;
      inC = c;
    }
    gapMax = Math.max(gapMax, 86400 - lastEnd);
    $("#orbSummary").innerHTML = `Over 24 hours this orbit gives <b>${passes} passes</b> over the station with <b>${Math.round(contactS / 60)} minutes</b> of contact in total, which is <b>${(contactS / 864).toFixed(1)}%</b> of the day. The longest silence is <b>${(gapMax / 3600).toFixed(1)} hours</b>. For the rest of the time the satellite is on its own.`;

    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(34, 1, 0.1, 100);
    const pivot = new T.Group(); scene.add(pivot); pivot.add(camera); camera.position.set(0, 0, 4.3);
    const view = { ry: -0.4, rx: 0.42, idle: 9 };
    fitRenderer(renderer, camera, canvas, (w, h) => { camera.position.z = w / h < 1 ? 6.6 : 4.8; });
    dragRotate(canvas, view, { tilt: true });

    const earth = new T.Group(); scene.add(earth);
    const coreMat = new T.MeshBasicMaterial();
    earth.add(new T.Mesh(new T.SphereGeometry(0.99, 64, 48), coreMat));
    const dots = [], ND = 3200, ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < ND; i++) { const y = 1 - (i / (ND - 1)) * 2, r = Math.sqrt(1 - y * y), th = ga * i; dots.push(Math.cos(th) * r, y, Math.sin(th) * r); }
    const dotGeo = new T.BufferGeometry(); dotGeo.setAttribute("position", new T.Float32BufferAttribute(dots, 3));
    const dotMat = new T.PointsMaterial({ size: 0.014, transparent: true, opacity: 0.75 });
    earth.add(new T.Points(dotGeo, dotMat));
    const gratMat = new T.LineBasicMaterial({ transparent: true, opacity: 0.35 });
    for (let lat = -60; lat <= 60; lat += 30) {
      const p = []; for (let k = 0; k <= 96; k++) p.push(ecef(lat * Math.PI / 180, k / 96 * Math.PI * 2, 1.001));
      earth.add(new T.Line(new T.BufferGeometry().setFromPoints(p), gratMat));
    }
    for (let lon = 0; lon < 180; lon += 30) {
      const p = []; for (let k = 0; k <= 96; k++) p.push(ecef(k / 96 * Math.PI * 2, lon * Math.PI / 180, 1.001));
      earth.add(new T.Line(new T.BufferGeometry().setFromPoints(p), gratMat));
    }
    // atmosphere glow
    const atmoMat = new T.ShaderMaterial({ uniforms: { uColor: { value: new T.Color() } }, side: T.BackSide, blending: T.AdditiveBlending, transparent: true, depthWrite: false,
      vertexShader: "varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: "uniform vec3 uColor; varying vec3 vN; void main(){ float i = pow(max(0.0, 0.62 - dot(vN, vec3(0.0,0.0,1.0))), 2.4); gl_FragColor = vec4(uColor, clamp(i,0.0,1.0) * 0.55); }" });
    scene.add(new T.Mesh(new T.SphereGeometry(1.1, 64, 48), atmoMat));
    // ground station and its visibility footprint
    const gsMat = new T.MeshBasicMaterial();
    const gsDot = new T.Mesh(new T.SphereGeometry(0.022, 16, 16), gsMat); gsDot.position.copy(gsLocal).multiplyScalar(1.005); earth.add(gsDot);
    const lam = Math.acos(RE / A * Math.cos(MIN_EL)) - MIN_EL;
    const e1 = new T.Vector3().crossVectors(gsLocal, yAxis).normalize(), e2 = new T.Vector3().crossVectors(gsLocal, e1).normalize();
    const fp = []; for (let k = 0; k <= 96; k++) { const ph = k / 96 * Math.PI * 2;
      fp.push(gsLocal.clone().multiplyScalar(Math.cos(lam)).add(e1.clone().multiplyScalar(Math.sin(lam) * Math.cos(ph))).add(e2.clone().multiplyScalar(Math.sin(lam) * Math.sin(ph))).multiplyScalar(1.004)); }
    const fpMat = new T.LineBasicMaterial({ transparent: true, opacity: 0.9 });
    earth.add(new T.Line(new T.BufferGeometry().setFromPoints(fp), fpMat));
    // orbit path (inertial frame)
    const op = []; for (let k = 0; k <= 200; k++) op.push(satEci(k / 200 * PERIOD));
    const orbMat = new T.LineDashedMaterial({ dashSize: 0.04, gapSize: 0.03, transparent: true, opacity: 0.6 });
    const orbLine = new T.Line(new T.BufferGeometry().setFromPoints(op), orbMat); orbLine.computeLineDistances(); scene.add(orbLine);
    // satellite marker
    const sat = new T.Group();
    const satMat = new T.MeshBasicMaterial({ color: 0xdfe6f3 }), wingM = new T.MeshBasicMaterial({ color: 0x3550b0, side: T.DoubleSide });
    sat.add(new T.Mesh(new T.BoxGeometry(0.03, 0.03, 0.08), satMat));
    [-1, 1].forEach((s) => { const w = new T.Mesh(new T.PlaneGeometry(0.07, 0.075), wingM); w.position.x = s * 0.052; sat.add(w); });
    const haloMat = new T.MeshBasicMaterial({ transparent: true, opacity: 0.25 });
    sat.add(new T.Mesh(new T.SphereGeometry(0.045, 16, 16), haloMat));
    scene.add(sat);
    const beamGeo = new T.BufferGeometry().setFromPoints([new T.Vector3(), new T.Vector3()]);
    const beamMat = new T.LineBasicMaterial({ transparent: true, opacity: 0.95 });
    const beam = new T.Line(beamGeo, beamMat); scene.add(beam);
    const coneMat = new T.MeshBasicMaterial({ transparent: true, opacity: 0.12, side: T.DoubleSide, depthWrite: false });
    const cone = new T.Mesh(new T.ConeGeometry(0.12, 1, 24, 1, true), coneMat); scene.add(cone);

    function recolor() {
      coreMat.color.set(css("--surface")); dotMat.color.set(css("--muted")); gratMat.color.set(css("--line"));
      atmoMat.uniforms.uColor.value.set(css("--accent")); gsMat.color.set(css("--ok")); fpMat.color.set(css("--ok"));
      orbMat.color.set(css("--accent")); haloMat.color.set(css("--accent")); beamMat.color.set(css("--ok")); coneMat.color.set(css("--ok"));
    }
    recolor();

    // contact history strip (last 24 h of simulated time)
    const strip = $("#orbStrip"), sctx = strip.getContext("2d");
    function drawStrip(tNow) {
      const r = strip.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
      if (strip.width !== Math.round(r.width * dpr)) { strip.width = Math.round(r.width * dpr); strip.height = Math.round(r.height * dpr); }
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0); sctx.clearRect(0, 0, r.width, r.height);
      sctx.fillStyle = css("--ok");
      const n = Math.floor(r.width);
      for (let x = 0; x < n; x++) { const t = tNow - 86400 + x / n * 86400; if (t >= 0 && geometry(t).el > MIN_EL) sctx.fillRect(x, 3, 1.2, r.height - 6); }
      sctx.fillStyle = css("--accent"); sctx.fillRect(n - 2, 0, 2, r.height);
    }

    let simT = 2.2 * 3600, speed = 300, lastStrip = -1e9, wasIn = null;
    const hhmm = (s) => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return `T+ ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`; };
    $("#orbSpeed").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; speed = +b.dataset.s;
      $("#orbSpeed").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); });
    let passEnd = simT; for (let tb = simT; tb > simT - 86400; tb -= 10) { if (geometry(tb).el > MIN_EL) { passEnd = tb; break; } }
    function frame(dt) {
      simT += dt * speed;
      earth.rotation.y = WE * simT;
      satEci(simT, sat.position); sat.lookAt(0, 0, 0);
      const g = geometry(simT), inContact = g.el > MIN_EL;
      const gsW = tmpG.clone().multiplyScalar(1.005);
      beam.visible = cone.visible = inContact;
      if (inContact) {
        beamGeo.attributes.position.setXYZ(0, sat.position.x, sat.position.y, sat.position.z);
        beamGeo.attributes.position.setXYZ(1, gsW.x, gsW.y, gsW.z); beamGeo.attributes.position.needsUpdate = true;
        const mid = sat.position.clone().add(gsW).multiplyScalar(0.5), len = sat.position.distanceTo(gsW);
        cone.position.copy(mid); cone.scale.set(1, len, 1); cone.lookAt(sat.position); cone.rotateX(-Math.PI / 2);
        beamMat.opacity = 0.6 + 0.35 * Math.sin(performance.now() / 120);
      }
      if (view.idle > 3) view.ry += dt * 0.05; view.idle += dt;
      pivot.rotation.set(0, 0, 0); pivot.rotateY(view.ry); pivot.rotateX(-view.rx);
      renderer.render(scene, camera);
      if (inContact !== wasIn) { const chip = $("#orbChip"); chip.className = "chip " + (inContact ? "nom" : "wait"); chip.textContent = inContact ? "In contact" : "Out of contact"; wasIn = inContact; }
      $("#orbClock").textContent = hhmm(simT);
      if (!inContact && passEnd === 0) passEnd = simT;
      if (inContact) passEnd = 0;
      $("#orbKv").innerHTML = `<dt>Altitude</dt><dd>${ALT} km</dd><dt>Orbital period</dt><dd>${(PERIOD / 60).toFixed(1)} min</dd>
        <dt>Ground station</dt><dd>${GS.name}</dd><dt>Elevation</dt><dd>${(g.el * 180 / Math.PI).toFixed(1)}°</dd><dt>Range</dt><dd>${Math.round(g.range).toLocaleString()} km</dd>
        <dt>${inContact ? "Link" : "Silent for"}</dt><dd>${inContact ? "downlink active" : hhmm(simT - passEnd).slice(3)}</dd>`;
      if (simT - lastStrip > 240) { drawStrip(simT); lastStrip = simT; }
    }
    if (reduceMotion) { speed = 0; frame(0); }
    visibleLoop(canvas, frame);
    return { recolor: () => { recolor(); lastStrip = -1e9; } };
  }

  /* ---------- 2. exploded CubeSat ---------- */
  function initExplode() {
    if (!has("#explodeCanvas")) return null;
    const canvas = $("#explodeCanvas"); if (!window.THREE) { root.classList.remove("arch-intro"); $("#explodeBox").hidden = true; return null; }
    const T = THREE, renderer = makeRenderer(canvas); if (!renderer) { root.classList.remove("arch-intro"); $("#explodeBox").hidden = true; return null; }
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(30, 1, 0.1, 100);
    const pivot = new T.Group(); scene.add(pivot); pivot.add(camera); camera.position.set(0, 0, 10);
    const view = { ry: 0.6, rx: 0.32, idle: 9 };
    const restingZ = (w, h) => (w / h < 0.85 ? 17 : 13.5);
    const fitCanvas = fitRenderer(renderer, camera, canvas, (w, h) => { camera.position.z = restingZ(w, h); });
    dragRotate(canvas, view, { tilt: true });
    scene.add(new T.HemisphereLight(0xe6edff, 0x202838, 0.85));
    const key = new T.DirectionalLight(0xfff2dc, 1.2); key.position.set(4, 6, 5); scene.add(key);
    const rimL = new T.DirectionalLight(0x8ca3ff, 0.6); rimL.position.set(-5, -2, -4); scene.add(rimL);

    const M = (c, m = 0.3, r = 0.55, extra = {}) => new T.MeshStandardMaterial({ color: c, metalness: m, roughness: r, ...extra });
    const pcb = M(0x1d5c40, 0.15, 0.7), chip = M(0x15181f, 0.4, 0.4), silver = M(0xc5ccd6, 0.85, 0.3), gold = M(0xd4a640, 0.9, 0.3),
      copper = M(0xb8733a, 0.8, 0.35), cellBlue = M(0x2c63c9, 0.3, 0.35), alu = M(0xb9c0cb, 0.75, 0.35), black = M(0x0b0d12, 0.6, 0.2);
    const box = (w, h, d, m) => new T.Mesh(new T.BoxGeometry(w, h, d), m);
    const cyl = (r, h, m, seg = 24) => new T.Mesh(new T.CylinderGeometry(r, r, h, seg), m);

    const MODULES = [
      { key: "payload", name: "Payload camera", d: "Earth-observation imager. The mission's science instrument.", y: 1.2 },
      { key: "comms", name: "Radio (UHF / S-band)", d: "Downlinks telemetry and fault reports during the short ground passes.", y: 0.72 },
      { key: "obc", name: "On-board computer", d: "Runs flight software, and this project's fault-detection and health models.", y: 0.24, ai: true },
      { key: "adcs", name: "Attitude control (ADCS)", d: "Magnetometer and magnetorquers. Its magnetometer channels are monitored here.", y: -0.24 },
      { key: "eps", name: "Power board (EPS)", d: "Regulates solar input and reads battery voltage, current and temperature.", y: -0.72 },
      { key: "batt", name: "Battery pack", d: "Li-ion 18650 cells. Their remaining useful life is forecast by the RUL model.", y: -1.2 },
    ];
    const boards = {};
    const sat = new T.Group(); scene.add(sat);
    MODULES.forEach((m) => {
      const g = new T.Group(); g.userData = m;
      const base = box(0.86, 0.035, 0.86, pcb.clone()); g.add(base); g.userData.base = base;
      const add = (o, x, y, z) => { o.position.set(x, y, z); g.add(o); return o; };
      if (m.key === "batt") {
        [[-0.2, -0.2], [-0.2, 0.2], [0.2, -0.2], [0.2, 0.2]].forEach(([x, z]) => {
          const c = add(cyl(0.11, 0.62, cellBlue), x, 0.13, z); c.rotation.z = Math.PI / 2; c.scale.set(1, 1, 1);
          [-1, 1].forEach((s) => { const cap = add(cyl(0.07, 0.02, silver), x + s * 0.315, 0.13, z); cap.rotation.z = Math.PI / 2; });
        });
        // pack frame
        add(box(0.82, 0.03, 0.06, alu), 0, 0.27, 0); add(box(0.06, 0.03, 0.82, alu), 0, 0.27, 0);
      } else if (m.key === "eps") {
        add(box(0.24, 0.04, 0.24, chip), -0.18, 0.04, -0.1);
        for (let i = 0; i < 4; i++) add(cyl(0.045, 0.06, M(0x4a4f5a, 0.6, 0.4)), 0.12 + (i % 2) * 0.13, 0.05, -0.2 + Math.floor(i / 2) * 0.16);
        add(box(0.5, 0.06, 0.08, M(0x2b2f38, 0.3, 0.6)), 0, 0.05, 0.3);
        for (let i = 0; i < 6; i++) add(box(0.05, 0.02, 0.03, chip), -0.28 + i * 0.1, 0.03, 0.14);
      } else if (m.key === "adcs") {
        const rx = add(cyl(0.04, 0.6, copper), -0.05, 0.08, -0.28); rx.rotation.z = Math.PI / 2;
        const rz = add(cyl(0.04, 0.6, copper), -0.3, 0.08, 0.02); rz.rotation.x = Math.PI / 2;
        add(box(0.16, 0.08, 0.16, M(0xd8dde5, 0.5, 0.35)), 0.22, 0.06, 0.2);   // magnetometer
        add(cyl(0.12, 0.12, silver), 0.2, 0.08, -0.05);                         // torquer air coil / wheel
      } else if (m.key === "obc") {
        const cpu = add(box(0.3, 0.05, 0.3, M(0x10131a, 0.5, 0.35, { emissive: 0x2443b8, emissiveIntensity: 0.0 })), 0, 0.04, 0);
        g.userData.cpu = cpu;
        [[-0.3, -0.25], [-0.3, 0.25], [0.3, -0.25], [0.3, 0.25]].forEach(([x, z]) => add(box(0.12, 0.03, 0.18, chip), x, 0.03, z));
        add(box(0.6, 0.05, 0.06, M(0x2b2f38, 0.3, 0.6)), 0, 0.04, -0.38);
      } else if (m.key === "comms") {
        add(box(0.46, 0.09, 0.36, silver), -0.08, 0.06, 0.02);
        [0.3, 0.3].forEach((x, i) => add(cyl(0.035, 0.1, gold), x, 0.06, -0.15 + i * 0.3));
        add(box(0.1, 0.03, 0.2, chip), 0.3, 0.03, 0.1);
      } else if (m.key === "payload") {
        add(box(0.42, 0.22, 0.42, M(0x2a2e37, 0.6, 0.4)), 0, 0.13, 0);
        add(cyl(0.16, 0.18, black, 32), 0, 0.33, 0);
        add(cyl(0.12, 0.012, M(0x1b2a5a, 0.9, 0.05), 32), 0, 0.425, 0);
      }
      sat.add(g); boards[m.key] = g;
    });
    // structure: rails + side solar panels
    const railGeo = new T.BoxGeometry(0.08, 3.1, 0.08), rails = [];
    [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => { const r = new T.Mesh(railGeo, alu); r.position.set(sx * 0.47, 0, sz * 0.47); r.userData.dir = [sx, sz]; sat.add(r); rails.push(r); });
    const sc = document.createElement("canvas"); sc.width = 256; sc.height = 768; const g2 = sc.getContext("2d");
    g2.fillStyle = "#9aa3b0"; g2.fillRect(0, 0, 256, 768);
    for (let u = 0; u < 3; u++) for (let k = 0; k < 2; k++) { const x = 18 + k * 116, y = 18 + u * 250; const gr = g2.createLinearGradient(x, y, x + 104, y + 214);
      gr.addColorStop(0, "#1b2a66"); gr.addColorStop(1, "#24398a"); g2.fillStyle = gr; g2.fillRect(x, y, 104, 214);
      g2.strokeStyle = "rgba(200,210,235,.2)"; for (let yy = y + 10; yy < y + 214; yy += 9) { g2.beginPath(); g2.moveTo(x + 3, yy); g2.lineTo(x + 101, yy); g2.stroke(); } }
    const stex = new T.CanvasTexture(sc); stex.encoding = T.sRGBEncoding;
    const panels = [];
    [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dz]) => {
      const mat = new T.MeshStandardMaterial({ map: stex, metalness: 0.35, roughness: 0.4, transparent: true });
      const p = new T.Mesh(new T.PlaneGeometry(0.9, 3.0), mat);
      p.position.set(dx * 0.49, 0, dz * 0.49); p.lookAt(dx * 5, 0, dz * 5); p.userData = { dx, dz, mat }; sat.add(p); panels.push(p);
    });

    // module list + labels
    const list = $("#moduleList"), labels = $("#explodeLabels"), lab = {};
    MODULES.forEach((m, i) => {
      const b = el("button", "module", `<span class="num">${i + 1}</span><b>${m.name}${m.ai ? '<span class="tagai">AI runs here</span>' : ""}</b><span class="d">${m.d}</span>`);
      b.type = "button"; b.dataset.key = m.key; list.append(b);
      const l = el("div", "xl" + (m.ai ? " ai" : ""), `<b>${i + 1}</b><span>${m.name}</span>`); labels.append(l); lab[m.key] = l;
    });
    list.append(el("p", "small", "Typical 3U CubeSat layout, shown for illustration. It is not OPS-SAT's exact internal design."));
    let hot = null;
    const setHot = (k) => { hot = k; list.querySelectorAll(".module").forEach((b) => b.classList.toggle("hot", b.dataset.key === k)); Object.entries(lab).forEach(([kk, l]) => l.classList.toggle("hot", kk === k)); };
    list.addEventListener("mouseover", (e) => { const b = e.target.closest(".module"); if (b) setHot(b.dataset.key); });
    list.addEventListener("focusin", (e) => { const b = e.target.closest(".module"); if (b) setHot(b.dataset.key); });
    list.addEventListener("mouseleave", () => setHot(null));
    list.addEventListener("click", (e) => { const b = e.target.closest(".module"); if (b) { target = 1; setHot(b.dataset.key); btn.textContent = "Assemble"; } });

    let ex = reduceMotion ? 1 : 0, target = reduceMotion ? 1 : 0, armed = false;   // explodes once, when first seen
    const btn = $("#explodeBtn");
    btn.addEventListener("click", () => { target = target ? 0 : 1; btn.textContent = target ? "Assemble" : "Explode"; });
    new IntersectionObserver((es) => { if (es[0].isIntersecting && !armed) { armed = true; target = 1; } }, { threshold: 0.35 }).observe(canvas);

    const v = new T.Vector3();
    // Arrival intro (set up by transition.js when Architecture is clicked): assembled -> apart -> zoom out into place
    const stage = $("#explodeStage"), figure = $("#explodeBox");
    const INTRO = { hold: 500, apart: 1900, zoom: 1100, closeZ: 8 };
    let intro = root.classList.contains("arch-intro"), introT0 = null;
    const introSmooth = (k) => { const c = Math.max(0, Math.min(1, k)); return c * c * (3 - 2 * c); };
    function endIntro() {
      if (!intro) return;
      intro = false;
      armed = true; target = 1; ex = 1;
      stage.removeAttribute("style");
      root.classList.remove("arch-intro", "arch-reveal");
      fitCanvas();
      camera.position.z = restingZ(canvas.clientWidth, canvas.clientHeight);
      camera.updateProjectionMatrix();
    }
    if (intro) {
      stage.addEventListener("pointerdown", endIntro);
      addEventListener("keydown", (e) => { if (e.key === "Escape") endIntro(); });
      setTimeout(endIntro, 9000);   // rAF stops in hidden tabs; never leave the page covered
      camera.position.z = INTRO.closeZ;
    }
    function introFrame(now) {
      if (introT0 === null) introT0 = now;
      const t = now - introT0;
      ex = Math.max(0, Math.min(1, (t - INTRO.hold) / INTRO.apart));
      const k = introSmooth((t - INTRO.hold - INTRO.apart) / INTRO.zoom);
      if (k > 0) {
        const r = figure.getBoundingClientRect(), vw = root.clientWidth, vh = innerHeight;
        const mix = (a, b) => Math.round(a + (b - a) * k);
        stage.style.inset = "auto";
        stage.style.left = mix(0, r.left) + "px"; stage.style.top = mix(0, r.top) + "px";
        stage.style.width = mix(vw, r.width) + "px"; stage.style.height = mix(vh, r.height) + "px";
        stage.style.borderRadius = Math.round(14 * k) + "px";
        stage.style.background = `rgba(5,8,20,${1 - k})`;
        fitCanvas();
        camera.position.z = INTRO.closeZ + (restingZ(r.width, r.height) - INTRO.closeZ) * k;
        if (k > 0.3) root.classList.add("arch-reveal");
      }
      if (t >= INTRO.hold + INTRO.apart + INTRO.zoom) endIntro();
    }
    function frame(dt, now) {
      if (intro) introFrame(now); else ex += (target - ex) * Math.min(1, dt * 2.4);
      const e = ex * ex * (3 - 2 * ex);
      MODULES.forEach((m) => {
        const g = boards[m.key]; g.position.y = m.y * (1 + 1.25 * e);
        const s = hot === m.key ? 1.06 : 1; g.scale.lerp(v.set(s, s, s), Math.min(1, dt * 8));
        g.userData.base.material.emissive = g.userData.base.material.emissive || new T.Color();
        g.userData.base.material.emissive.set(hot === m.key ? 0x2443b8 : 0x000000);
        g.userData.base.material.emissiveIntensity = hot === m.key ? 0.6 : 0;
      });
      boards.obc.userData.cpu.material.emissiveIntensity = 0.5 + 0.5 * Math.sin(now / 300);
      panels.forEach((p) => { const { dx, dz, mat } = p.userData; p.position.set(dx * (0.49 + 1.15 * e), 0, dz * (0.49 + 1.15 * e)); mat.opacity = 1 - 0.82 * e; p.visible = mat.opacity > 0.05; });
      rails.forEach((r) => { const [sx, sz] = r.userData.dir; r.position.set(sx * (0.47 + 0.45 * e), 0, sz * (0.47 + 0.45 * e)); r.scale.y = 1 + 0.75 * e; });
      if (view.idle > 3) view.ry += dt * 0.18; view.idle += dt;
      pivot.rotation.set(0, 0, 0); pivot.rotateY(view.ry); pivot.rotateX(-view.rx);
      renderer.render(scene, camera);
      // project labels to the right edge of each board
      const w = canvas.clientWidth, h = canvas.clientHeight;
      MODULES.forEach((m) => {
        const g = boards[m.key]; v.set(0, 0.06, 0).applyMatrix4(g.matrixWorld).project(camera);
        const l = lab[m.key]; l.style.left = ((v.x * 0.5 + 0.5) * w + 70) + "px"; l.style.top = ((-v.y * 0.5 + 0.5) * h) + "px";
        l.style.opacity = Math.max(0, (e - 0.55) / 0.45);
      });
    }
    visibleLoop(canvas, frame);
    return {};
  }

  /* ---------- 3. forest vote animation (real per-tree votes from the deployed model) ---------- */
  function initForest() {
    if (!has("#nnCanvas")) return;
    const cv = $("#nnCanvas"), ctx = cv.getContext("2d");
    if (!core) return;
    const KINDS = [null, "spike", null, "noise", null, "stuck", null, "data_gap"];
    let ex = 0, phase = 0, W = 0, H = 0, cur = null;
    const tvec = (s) => { const t = [0]; s.dt.forEach((d) => t.push(t[t.length - 1] + d)); return t; };
    function next() {
      const s = SIM.playground[ex % SIM.playground.length], kind = KINDS[ex % KINDS.length];
      let v = s.v, t = tvec(s);
      if (kind) { const r = core.inject(kind, v, t, { seed: ex + 7, pos: 0.45 }); v = r.v; t = r.t; }
      const a = core.analyse(v, t, s.sampling, s.channel, s.prev, s.contig);
      cur = { s, kind, a, votes: core.votes(a.row), v };
      const fam = {}; a.why.forEach((w) => { fam[w.g] = w.c; });
      cur.fam = fam;
      $("#nnInfo").textContent = `${s.name} window #${s.id}${kind ? " + injected " + SV.type_name[kind].toLowerCase() : " (healthy)"} · p = ${a.p.toFixed(3)}`;
      ex++;
    }
    function size() { const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2); W = r.width; H = r.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
    new ResizeObserver(size).observe(cv); size(); next();
    const GROUPS = ["spike", "noise", "amplitude", "offset", "data_gap", "waveform", "timing", "change"];
    function tree(x, y, s, col, alpha) {
      ctx.globalAlpha = alpha; ctx.fillStyle = col;
      ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.8, y + s * 0.55); ctx.lineTo(x - s * 0.8, y + s * 0.55); ctx.closePath(); ctx.fill();
      ctx.fillRect(x - s * 0.12, y + s * 0.55, s * 0.24, s * 0.35); ctx.globalAlpha = 1;
    }
    function draw(dt) {
      if (!cur || !W) return;
      phase += dt; if (phase > 4.2) { phase = 0; next(); }
      const fault = css("--fault"), ok = css("--ok"), muted = css("--muted"), ink = css("--ink"), acc = css("--accent"), s2 = css("--surface-2");
      ctx.clearRect(0, 0, W, H);
      const narrow = W < 640, left = narrow ? 0 : 200, right = narrow ? 0 : 170;
      // family evidence column
      ctx.font = `11px ${css("--f-mono")}`; ctx.textBaseline = "middle";
      if (!narrow) {
        ctx.fillStyle = muted; ctx.textAlign = "left"; ctx.fillText("EVIDENCE BY FAMILY", 16, 22);
        GROUPS.forEach((g, i) => {
          const y = 48 + i * ((H - 70) / GROUPS.length), c = Math.min(1, (cur.fam[g] || 0) / 0.5) * Math.min(1, phase / 0.8);
          ctx.fillStyle = c > 0 ? ink : muted; ctx.fillText(FAMILY_NAME[g], 16, y);
          ctx.fillStyle = s2; ctx.fillRect(16, y + 9, 160, 4); ctx.fillStyle = fault; ctx.fillRect(16, y + 9, 160 * c, 4);
        });
      }
      // forest grid: 120 trees, votes revealed in sequence
      const n = cur.votes.length, cols = narrow ? 12 : 15, rows = Math.ceil(n / cols);
      const gw = W - left - right - 32, gh = H - 60, cell = Math.min(gw / cols, gh / rows), x0 = left + 16 + (gw - cell * cols) / 2, y0 = 30 + (gh - cell * rows) / 2;
      const shown = Math.floor(Math.min(1, Math.max(0, (phase - 0.3) / 1.8)) * n);
      cur.votes.forEach((p, i) => {
        const x = x0 + (i % cols + 0.5) * cell, y = y0 + (Math.floor(i / cols) + 0.5) * cell;
        if (i < shown) tree(x, y, cell * 0.36, p >= 0.5 ? fault : ok, 0.35 + 0.65 * Math.abs(p - 0.5) * 2);
        else tree(x, y, cell * 0.36, muted, 0.18);
      });
      const yes = cur.votes.slice(0, shown).filter((p) => p >= 0.5).length;
      ctx.fillStyle = muted; ctx.textAlign = "center"; ctx.fillText(`${yes} of ${shown} trees vote "anomaly"`, x0 + cell * cols / 2, H - 14);
      // verdict
      const done = phase > 2.2, colr = cur.a.flag ? fault : ok;
      const cx = narrow ? W - 46 : W - right / 2 - 8, cy = narrow ? 36 : H / 2;
      ctx.lineWidth = narrow ? 5 : 8; ctx.strokeStyle = s2; ctx.beginPath(); ctx.arc(cx, cy, narrow ? 24 : 52, 0, Math.PI * 2); ctx.stroke();
      const shownP = done ? cur.a.p : cur.a.p * Math.min(1, phase / 2.2);
      ctx.strokeStyle = done ? colr : acc; ctx.beginPath(); ctx.arc(cx, cy, narrow ? 24 : 52, -Math.PI / 2, -Math.PI / 2 + shownP * Math.PI * 2); ctx.stroke();
      ctx.fillStyle = ink; ctx.font = `600 ${narrow ? 11 : 18}px ${css("--f-display")}`; ctx.fillText(shownP.toFixed(2), cx, cy);
      if (done && !narrow) {
        ctx.font = `600 13px ${css("--f-body")}`; ctx.fillStyle = colr; ctx.fillText(cur.a.flag ? "ANOMALY" : "NOMINAL", cx, cy + 80);
        if (cur.a.flag) { ctx.font = `11px ${css("--f-mono")}`; ctx.fillStyle = muted; ctx.fillText((SIGNATURES[cur.a.sig] || SIGNATURES.subtle).name.split(" /")[0], cx, cy + 100); }
      }
    }
    if (reduceMotion) { phase = 3; draw(0); return; }
    visibleLoop(cv, draw);
  }

  /* ---------- playground ---------- */
  function initPlayground() {
    if (!has("#pgCanvas")) return;
    if (!core) { $("#playground").hidden = true; return; }
    const sel = $("#pgSeg"), typeBox = $("#pgType");
    SIM.playground.forEach((s, i) => { const o = el("option", null, `${s.name} · #${s.id} · ${s.v.length} samples`); o.value = i; sel.append(o); });
    const KINDS = [["none", "No fault"], ["spike", "Spike"], ["noise", "Noise burst"], ["stuck", "Stuck sensor"], ["offset", "Level shift"], ["data_gap", "Data gap"], ["amplitude", "Amplitude"]];
    KINDS.forEach(([k, n], i) => { const b = el("button", "chipbtn", n); b.type = "button"; b.dataset.k = k; b.setAttribute("aria-pressed", i === 2); typeBox.append(b); });
    const st = { i: 0, kind: "noise", sev: 1, pos: 0.5, seed: 3 };
    const tvec = (s) => { const t = [0]; s.dt.forEach((d) => t.push(t[t.length - 1] + d)); return t; };
    const cv = $("#pgCanvas"), c2 = cv.getContext("2d"), gauge = $("#pgGauge"), g2 = gauge.getContext("2d");
    let last = null;
    function run() {
      const s = SIM.playground[st.i], t0 = tvec(s);
      const inj = st.kind === "none" ? { v: s.v, t: t0, region: null } : core.inject(st.kind, s.v, t0, { seed: st.seed, severity: st.sev, pos: st.pos });
      const a = core.analyse(inj.v, inj.t, s.sampling, s.channel, s.prev, s.contig);
      last = { s, t0, inj, a };
      render();
      $("#pgSrv").textContent = API.online ? "Checking with the server…" : "";
      serverScore();
    }
    // the same window is also scored by the backend; the page shows whether both engines agree
    const serverScore = debounce(async () => {
      if (!API.online || !last) { $("#pgSrv").textContent = ""; return; }
      const { s, inj, a } = last, dt = inj.t.slice(1).map((x, i) => x - inj.t[i]);
      try {
        const r = await API.call("/api/score", { channel: s.channel, values: inj.v, dt, sampling: s.sampling, prev: s.prev, contiguous: s.contig });
        if (last.a !== a) return;   // a newer request superseded this one
        const same = Math.abs(r.p - a.p) < 1e-6 && r.sig === a.sig;
        $("#pgSrv").innerHTML = `Server: p = ${r.p.toFixed(3)} · ${same ? '<span class="ok">matches the browser exactly</span>' : "differs from the browser"}`;
      } catch (e) { $("#pgSrv").textContent = "Server unavailable · showing the browser result"; }
    }, 300);
    document.addEventListener("api-status", () => serverScore());
    function render() {
      if (!last) return;
      const { s, t0, inj, a } = last;
      // waveform
      const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2), W = r.width, H = r.height;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); c2.setTransform(dpr, 0, 0, dpr, 0, 0); c2.clearRect(0, 0, W, H);
      const all = s.v.concat(inj.v); let lo = Math.min(...all), hi = Math.max(...all); const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
      const T = t0[t0.length - 1] || 1, X = (t) => 12 + (t / T) * (W - 24), Y = (v) => H - 14 - ((v - lo) / (hi - lo)) * (H - 28);
      c2.strokeStyle = css("--grid"); for (let k = 0; k <= 4; k++) { const y = 14 + k * (H - 28) / 4; c2.beginPath(); c2.moveTo(12, y); c2.lineTo(W - 12, y); c2.stroke(); }
      if (inj.region && st.kind !== "offset" && st.kind !== "amplitude") {
        const ta = st.kind === "data_gap" ? t0[inj.region[0]] : inj.t[Math.min(inj.region[0], inj.t.length - 1)], tb = st.kind === "data_gap" ? t0[Math.min(inj.region[1] + 1, t0.length - 1)] : inj.t[Math.min(inj.region[1], inj.t.length - 1)];
        c2.fillStyle = css("--fault-soft"); c2.fillRect(X(ta), 8, Math.max(3, X(tb) - X(ta)), H - 16);
      }
      const path = (v, t, col, w, dash) => { c2.strokeStyle = col; c2.lineWidth = w; c2.setLineDash(dash || []); c2.beginPath();
        v.forEach((y, i) => { const x = X(t[i]); const pg = i && (t[i] - t[i - 1]) > 4 * s.sampling; (i && !pg) ? c2.lineTo(x, Y(y)) : c2.moveTo(x, Y(y)); }); c2.stroke(); c2.setLineDash([]); };
      path(s.v, t0, css("--muted"), 1.2, [4, 3]);
      path(inj.v, inj.t, st.kind === "none" ? css("--accent") : css("--fault"), 1.8);
      $("#pgInfo").textContent = `${inj.v.length} samples · ${Math.round(T)} s`;
      // gauge
      const gw = 200, gh = 120, cx = 100, cy = 104, R = 80; g2.clearRect(0, 0, gw, gh);
      g2.lineWidth = 14; g2.lineCap = "round";
      g2.strokeStyle = css("--surface-2"); g2.beginPath(); g2.arc(cx, cy, R, Math.PI, 2 * Math.PI); g2.stroke();
      g2.strokeStyle = a.flag ? css("--fault") : css("--ok"); g2.beginPath(); g2.arc(cx, cy, R, Math.PI, Math.PI + Math.max(0.01, a.p) * Math.PI); g2.stroke();
      const ta = Math.PI + THR * Math.PI; g2.lineWidth = 2; g2.strokeStyle = css("--ink"); g2.beginPath(); g2.moveTo(cx + Math.cos(ta) * (R - 12), cy + Math.sin(ta) * (R - 12)); g2.lineTo(cx + Math.cos(ta) * (R + 12), cy + Math.sin(ta) * (R + 12)); g2.stroke();
      $("#pgP").textContent = a.p.toFixed(3);
      const hybrid = a.flag || a.limit;
      $("#pgDec").innerHTML = `<div class="dec ${a.flag ? "bad" : "good"}"><span>AI model</span><b>${a.flag ? "Anomaly" : "Nominal"}</b></div>
        <div class="dec ${a.limit ? "bad" : "good"}"><span>Limit check</span><b>${a.limit ? "Out of range" : "In range"}</b></div>
        <div class="dec ${hybrid ? "bad" : "good"}"><span>Hybrid alarm</span><b>${hybrid ? "ALARM" : "Clear"}</b></div>`;
      const sig = SIGNATURES[a.sig] || SIGNATURES.subtle;
      const maxC = Math.max(0.01, ...a.why.map((w) => w.c));
      $("#pgWhy").innerHTML = a.flag ? `<div class="v-label">Anomaly type</div><h4 class="pg-type">${sig.name}</h4>` +
        (a.why.length ? `<div class="contrib">${a.why.map((w) => `<div class="contrib-row"><span class="lbl">${FAMILY_NAME[w.g]}<small>${FEATURE_LABEL[w.f] || w.f}: ${fmtNum(w.val)}${w.med != null ? " vs normal " + fmtNum(w.med) : ""}</small></span><span class="val">+${w.c.toFixed(2)}</span><span class="bar"><i style="width:${(100 * w.c / maxC).toFixed(0)}%"></i></span></div>`).join("")}</div>` : "")
        : `<p class="quiet">${a.limit ? "The AI sees nothing unusual in the signal's shape, but the values leave the sensor's normal envelope, so the limit check raises the alarm. This is why the system is hybrid." : "Nothing unusual. Try a stronger fault, or another type."}</p>`;
      const sub = s.channel <= "CADC0874" ? "ADCS" : "Sun sensing";
      const steps = a.flag ? ((ACTIONS[sub] && ACTIONS[sub][a.sig]) || ACTIONS[sub].subtle) : a.limit ? ["Treat as an out-of-range reading: cross-check with redundant sensors.", "Isolate the sensor if the next windows are also out of range."] : [];
      $("#pgAct").innerHTML = steps.length ? `<div class="v-label">Recommended action</div><ol class="steps">${steps.map((x) => `<li>${x}</li>`).join("")}</ol>` : "";
    }
    typeBox.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; st.kind = b.dataset.k; typeBox.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); run(); });
    sel.addEventListener("change", () => { st.i = +sel.value; run(); });
    $("#pgSev").addEventListener("input", (e) => { st.sev = +e.target.value; $("#pgSevV").textContent = st.sev.toFixed(2) + "×"; run(); });
    $("#pgPos").addEventListener("input", (e) => { st.pos = +e.target.value / 100; $("#pgPosV").textContent = e.target.value + "%"; run(); });
    $("#pgRand").addEventListener("click", () => {
      st.seed = Math.floor(Math.random() * 1e6); st.i = Math.floor(Math.random() * SIM.playground.length); sel.value = st.i;
      const k = KINDS[1 + Math.floor(Math.random() * (KINDS.length - 1))][0]; st.kind = k;
      typeBox.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.k === k));
      st.sev = +(0.6 + Math.random() * 1.2).toFixed(2); $("#pgSev").value = st.sev; $("#pgSevV").textContent = st.sev.toFixed(2) + "×";
      st.pos = 0.15 + Math.random() * 0.6; $("#pgPos").value = Math.round(st.pos * 100); $("#pgPosV").textContent = Math.round(st.pos * 100) + "%"; run();
    });
    $("#pgReset").addEventListener("click", () => { st.kind = "none"; typeBox.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x.dataset.k === "none")); run(); });
    new ResizeObserver(() => render()).observe(cv);
    run();
    return { render };
  }

  /* ---------- upload: score your own telemetry ---------- */
  function initUpload() {
    if (!has("#upText")) return;
    if (!core) { $("#upload").hidden = true; return; }
    const names = {}; SIM.playground.forEach((s) => { names[s.channel] = s.name; });
    Object.keys(MODEL.med).sort().forEach((c) => { const o = el("option", null, `${names[c] || c} (${c})`); o.value = c; $("#upChan").append(o); });
    const err = (m) => { $("#upErr").textContent = m; };
    const setMode = () => { $("#upMode").textContent = API.online ? "Scored by the server API" : "Scored in your browser (server offline)"; };
    document.addEventListener("api-status", setMode); setMode();

    function parse(text) {
      const rows = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (rows.length > 5001) throw new Error("Too many rows: the limit is 5,000 samples.");
      const vals = [], times = [];
      rows.forEach((line, i) => {
        const cells = line.split(/[,;\t ]+/).filter(Boolean).map(Number);
        if (cells.some((x) => !Number.isFinite(x))) { if (i === 0) return; throw new Error(`Line ${i + 1} is not numeric: "${line.slice(0, 40)}"`); }
        if (cells.length >= 2) { times.push(cells[0]); vals.push(cells[1]); } else if (cells.length === 1) vals.push(cells[0]);
      });
      if (vals.length < 8) throw new Error("Need at least 8 numeric samples.");
      if (times.length && times.length !== vals.length) throw new Error("Mix of one- and two-column rows. Use either value or time,value on every line.");
      if (times.length) for (let i = 1; i < times.length; i++) if (!(times[i] > times[i - 1])) throw new Error(`Time must increase (line ${i + 1}).`);
      if (vals.some((v) => Math.abs(v) > 1e12)) throw new Error("Values are out of range.");
      return { vals, times: times.length ? times.map((x) => x - times[0]) : null };
    }
    $("#upFile").addEventListener("change", (e) => {
      const f = e.target.files[0]; err(""); if (!f) return;
      if (f.size > 1024 * 1024) { err("File is larger than 1 MB."); e.target.value = ""; return; }
      const rd = new FileReader(); rd.onload = () => { $("#upText").value = String(rd.result); }; rd.onerror = () => err("Could not read the file."); rd.readAsText(f);
    });
    $("#upSample").addEventListener("click", () => {
      const s = SIM.playground[3 % SIM.playground.length], t = [0]; s.dt.forEach((d) => t.push(t[t.length - 1] + d));
      const r = core.inject("spike", s.v, t, { seed: 5, pos: 0.6 });
      $("#upText").value = r.v.map((v, i) => `${r.t[i].toFixed(2)},${v}`).join("\n");
      $("#upChan").value = s.channel; $("#upSamp").value = s.sampling; err("");
    });
    $("#upGo").addEventListener("click", async () => {
      err("");
      let d; try { d = parse($("#upText").value); } catch (e) { err(e.message); return; }
      const ch = $("#upChan").value, samp = Number($("#upSamp").value);
      if (!(samp > 0 && samp <= 1e5)) { err("Sampling interval must be a positive number of seconds."); return; }
      const t = d.times || d.vals.map((_, i) => i * samp);
      const dt = t.slice(1).map((x, i) => x - t[i]);
      let a, by;
      $("#upGo").disabled = true;
      try {
        if (API.online) { a = await API.call("/api/score", { channel: ch, values: d.vals, dt, sampling: samp }); by = "server API"; }
      } catch (e) { err(`Server: ${e.message}. Scored in the browser instead.`); }
      finally { $("#upGo").disabled = false; }
      if (!a) { a = core.analyse(d.vals, t, samp, ch, null, false); by = "browser"; }
      const sig = SIGNATURES[a.sig] || SIGNATURES.subtle, flag = a.p >= THR, hy = flag || a.limit;
      const maxC = Math.max(0.01, ...a.why.map((w) => w.c));
      $("#upOut").innerHTML = `<canvas class="spark" id="upSpark"></canvas>
        <div class="decisions"><div class="dec ${flag ? "bad" : "good"}"><span>AI · p = ${a.p.toFixed(3)}</span><b>${flag ? "Anomaly" : "Nominal"}</b></div>
          <div class="dec ${a.limit ? "bad" : "good"}"><span>Limit check</span><b>${a.limit ? "Out of range" : "In range"}</b></div>
          <div class="dec ${hy ? "bad" : "good"}"><span>Hybrid</span><b>${hy ? "ALARM" : "Clear"}</b></div></div>
        ${flag ? `<div><div class="v-label">Anomaly type</div><h4 class="pg-type">${sig.name}</h4><p class="small">${sig.desc}</p></div>` : ""}
        ${a.why.length ? `<div class="contrib">${a.why.map((w) => `<div class="contrib-row"><span class="lbl">${FAMILY_NAME[w.g]}<small>${FEATURE_LABEL[w.f] || w.f}: ${fmtNum(w.val)}${w.med != null ? " vs normal " + fmtNum(w.med) : ""}</small></span><span class="val">+${w.c.toFixed(2)}</span><span class="bar"><i style="width:${(100 * w.c / maxC).toFixed(0)}%"></i></span></div>`).join("")}</div>` : ""}
        <p class="srv-line">${d.vals.length} samples · compared with ${names[ch] || ch} · scored by the ${by}</p>`;
      sparkline($("#upSpark"), d.vals, flag || a.limit ? css("--fault") : css("--accent"));
    });
  }

  /* ---------- autonomy (FDIR) simulator ---------- */
  function initAutonomy() {
    if (!has("#simCanvas")) return null;
    if (!core) { $("#autonomy").hidden = true; return null; }
    const STR = SIM.stretches, LEVEL = ["Nominal", "Monitor", "Isolate", "Safe mode"], WHO = [["ai", "AI only"], ["lim", "Limits only"], ["hy", "Hybrid"]];
    STR.forEach((s, i) => { const o = el("option", null, `${s.name} · ${s.windows.length} windows`); o.value = i; $("#simStretch").append(o); });
    SV.types.forEach((k) => { const o = el("option", null, SV.type_name[k]); o.value = k; $("#simType").append(o); });
    $("#simType").value = "stuck";
    $("#simLen").addEventListener("input", (e) => { $("#simLenV").textContent = e.target.value + " windows"; });
    $("#fsm").innerHTML = LEVEL.map((l, i) => `<div class="fsm-node" data-l="${i}"><span class="mono">${i}</span>${l}</div>`).join('<span class="fsm-arrow" aria-hidden="true"></span>');
    const tvec = (s) => { const t = [0]; s.dt.forEach((d) => t.push(t[t.length - 1] + d)); return t; };
    let timer = null, trace = [], step = 0;
    function compute() {
      const S = STR[+$("#simStretch").value], kind = $("#simType").value, k = +$("#simLen").value, start = 8;
      const m = { ai: core.fdir(), lim: core.fdir(), hy: core.fdir() };
      let prevF = null; trace = [];
      S.windows.forEach((w, i) => {
        const faulty = i >= start && i < start + k;
        let v = w.v, t = tvec(w);
        if (faulty) { const r = core.inject(kind, v, t, { seed: 100 + i, pos: 0.35 }); v = r.v; t = r.t; }
        const prev = i === 0 ? w.prev : prevF;
        const a = core.analyse(v, t, w.sampling, w.channel, prev, i === 0 ? w.contig : true);
        prevF = { std: a.f.std, mean: a.f.mean, kurtosis: a.f.kurtosis, diff_var: a.f.diff_var, n_peaks: a.f.n_peaks };
        const fl = { ai: a.flag, lim: a.limit, hy: a.flag || a.limit }, pp = { ai: a.p, lim: 1, hy: Math.max(a.p, a.limit ? 1 : 0) };
        const lv = {}; for (const [kk] of WHO) lv[kk] = m[kk].step(fl[kk], pp[kk]);
        trace.push({ i, faulty, label: w.label, v, p: a.p, sig: a.sig, fl, lv });
      });
    }
    function lanes(upto) {
      $("#lanes").innerHTML = `<div class="lane lane-head"><span></span><div class="cells">${trace.map((w, i) => `<i class="${w.faulty ? "inj" : ""} ${i === upto ? "cur" : ""}" title="window ${i + 1}${w.faulty ? " (fault injected)" : ""}"></i>`).join("")}</div></div>` +
        WHO.map(([k, n]) => `<div class="lane"><span>${n}</span><div class="cells">${trace.map((w, i) => i <= upto ? `<i class="lv${w.lv[k]} ${w.fl[k] ? "fl" : ""} ${i === upto ? "cur" : ""}" title="${n}: ${LEVEL[w.lv[k]]}${w.fl[k] ? " · alarm" : ""}"></i>` : `<i class="todo"></i>`).join("")}</div></div>`).join("");
    }
    function show(i) {
      const w = trace[i];
      document.querySelectorAll(".fsm-node").forEach((n) => n.classList.toggle("on", +n.dataset.l === w.lv.hy));
      lanes(i);
      const cv = $("#simCanvas"), r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2), c = cv.getContext("2d");
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); c.setTransform(dpr, 0, 0, dpr, 0, 0);
      sparkDraw(c, r.width, r.height, w.v, w.faulty ? css("--fault") : css("--accent"));
      c.fillStyle = css("--muted"); c.font = `11px ${css("--f-mono")}`; c.fillText(`window ${i + 1}/${trace.length} · p = ${w.p.toFixed(2)}${w.faulty ? " · fault injected" : ""}`, 10, 16);
      if (i > 0) {
        const p = trace[i - 1];
        WHO.forEach(([k, n]) => { if (w.lv[k] !== p.lv[k]) logLine(`W${i + 1} ${n}: ${LEVEL[p.lv[k]]} → ${LEVEL[w.lv[k]]}`, w.lv[k] > p.lv[k] ? "up" : "down"); });
      }
    }
    function sparkDraw(c, W, H, v, col) {
      const lo = Math.min(...v), hi = Math.max(...v), p = 24;
      c.clearRect(0, 0, W, H); c.strokeStyle = col; c.lineWidth = 1.6; c.beginPath();
      v.forEach((y, i) => { const x = 10 + i / (v.length - 1) * (W - 20), yy = H - 10 - ((y - lo) / ((hi - lo) || 1)) * (H - p - 10); i ? c.lineTo(x, yy) : c.moveTo(x, yy); }); c.stroke();
    }
    function logLine(txt, cls) { const li = el("li", cls === "up" ? "" : "fp", `<span>${txt}</span>`); $("#simLog").prepend(li); }
    function run() {
      clearInterval(timer); compute(); $("#simLog").innerHTML = ""; step = 0; show(0);
      if (reduceMotion) { for (let i = 1; i < trace.length; i++) show(i); return; }
      $("#simRun").textContent = "Running…";
      timer = setInterval(() => { step++; if (step >= trace.length) { clearInterval(timer); $("#simRun").textContent = "Run again"; summary(); return; } show(step); }, 420);
    }
    function summary() {
      const s = trace.findIndex((w) => w.faulty);
      WHO.forEach(([k, n]) => {
        const hit = trace.findIndex((w, i) => i >= s && w.faulty && w.fl[k]);
        const maxLv = Math.max(...trace.map((w) => w.lv[k]));
        logLine(`${n}: ${hit < 0 ? "fault never alarmed" : `alarm after ${hit - s} window${hit - s === 1 ? "" : "s"}`} · highest level ${LEVEL[maxLv]}`, "up");
      });
    }
    $("#simRun").addEventListener("click", run);
    compute(); for (let i = 0; i < trace.length; i++) lanes(trace.length - 1); show(trace.length - 1); $("#simLog").innerHTML = "";
    $("#simRun").textContent = "Run simulation";
    return {};
  }

  function drawMC() {
    const types = SV.types, F = FD.fdir;
    const o = baseOpts("", "Fault episodes caught");
    o.scales.x = { ...o.scales.x, type: "category", grid: { display: false } }; o.scales.y.min = 0; o.scales.y.max = 1;
    o.scales.y.ticks.callback = (v) => Math.round(v * 100) + "%";
    mk("mcChart", { type: "bar", data: { labels: types.map((t) => SV.type_name[t]), datasets: [
      { label: "AI only", data: types.map((t) => F[t].ai.detected), backgroundColor: css("--accent"), borderRadius: 3 },
      { label: "Limits only", data: types.map((t) => F[t].limit.detected), backgroundColor: css("--warn"), borderRadius: 3 },
      { label: "Hybrid", data: types.map((t) => F[t].hybrid.detected), backgroundColor: css("--ok"), borderRadius: 3 },
    ] }, options: o });
  }
  (function mcTable() {
    const F = FD.fdir, types = SV.types;
    const avg = (who, key) => types.reduce((a, t) => a + (F[t][who][key] ?? 0), 0) / types.length;
    const row = (n, who) => `<tr class="${who === "hybrid" ? "best" : ""}"><td>${n}</td><td class="num">${Math.round(Math.min(...types.map((t) => F[t][who].detected)) * 100)}–${Math.round(Math.max(...types.map((t) => F[t][who].detected)) * 100)}%</td>
      <td class="num">${Math.round(avg(who, "detected") * 100)}%</td><td class="num">${avg(who, "mean_delay").toFixed(2)}</td><td class="num">${avg(who, "false_alarm_per_100").toFixed(1)}</td><td class="num">${Math.round(avg(who, "isolated") * 100)}%</td></tr>`;
    $("#mcTable").innerHTML = `<thead><tr><th>Strategy</th><th>Caught (by type)</th><th>Caught (mean)</th><th>Delay (windows)</th><th>False alarms /100</th><th>Reached Isolate</th></tr></thead><tbody>${row("AI only", "ai")}${row("Limits only", "limit")}${row("Hybrid", "hybrid")}</tbody>`;
  })();
  const orbitView = initOrbit();
  initExplode();
  initForest();
  const playground = initPlayground();
  initUpload();
  initAutonomy();

  /* =================== MISSION DASHBOARDS =================== */
  const tip = el("div", "tip"); tip.hidden = true; document.body.append(tip);
  const showTip = (x, y, html) => { tip.innerHTML = html; tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - w - 8, x + 14) + "px"; tip.style.top = (y + h + 20 > innerHeight ? y - h - 10 : y + 14) + "px"; };
  const hideTip = () => { tip.hidden = true; };
  const outcomeName = { tp: "Fault caught", fn: "Fault missed", fp: "False alarm", tn: "Nominal, passed" };

  // index of every replayable (test) segment
  const testIndex = {};
  Object.entries(RP).forEach(([ch, c]) => c.segments.forEach((s, i) => { testIndex[s.id] = { ch, i, s }; }));
  const allTest = Object.values(testIndex).map((t) => t.s);

  function openInMonitor(segId) {
    if (!testIndex[segId]) return;
    const url = `monitor.html?seg=${segId}`;
    if (window.warpTo) window.warpTo(url, "Monitor"); else location.href = url;
  }

  function lineMarker() {   // vertical marker drawn at options.plugins.marker.x (data units on the x scale)
    return { id: "marker", afterDatasetsDraw(chart, _a, o) {
      if (o == null || o.x == null) return;
      const { ctx, chartArea: a, scales } = chart; const x = scales.x.getPixelForValue(o.x);
      ctx.save(); ctx.strokeStyle = o.color || css("--ink"); ctx.globalAlpha = .7; ctx.setLineDash([4, 4]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke(); ctx.restore(); } };
  }

  /* ---------- tabs ---------- */
  const TABS = ["timeline", "explorer", "threshold", "twin"];
  const drawn = {};
  let curTab = "timeline";
  const tabBtns = TABS.map((t) => $("#tab-" + t));
  function showTab(t, focus) {
    curTab = t;
    TABS.forEach((x, i) => {
      const on = x === t; tabBtns[i].setAttribute("aria-selected", on); tabBtns[i].tabIndex = on ? 0 : -1;
      $("#dash-" + x).hidden = !on;
    });
    if (focus) $("#tab-" + t).focus();
    if (!drawn[t]) { DRAW[t](); drawn[t] = true; }
    // charts created while their panel was hidden or still laying out can stay at 0x0: resize once visible
    const fitCharts = () => $("#dash-" + t).querySelectorAll("canvas").forEach((cv) => { const c = window.Chart && Chart.getChart(cv); if (c) c.resize(); });
    requestAnimationFrame(fitCharts); setTimeout(fitCharts, 400);
  }
  tabBtns.forEach((b, i) => {
    b.addEventListener("click", () => showTab(TABS[i]));
    b.addEventListener("keydown", (e) => {
      const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (d) { e.preventDefault(); showTab(TABS[(i + d + TABS.length) % TABS.length], true); }
    });
  });

  /* ---------- A: mission timeline ---------- */
  const TL = FD.timeline;
  const dayKey = (d) => d.toISOString().slice(0, 10);
  const days = [...new Set(TL.seg.map((s) => s[2]))].sort();   // only days on which telemetry was recorded
  const spanDays = Math.round((new Date(days[days.length - 1]) - new Date(days[0])) / 864e5) + 1;
  const cellMap = {};
  TL.seg.forEach(([id, c, date, a, trn]) => {
    const k = c + "|" + date; (cellMap[k] = cellMap[k] || { n: 0, a: 0, segs: [] });
    cellMap[k].n++; cellMap[k].a += a; cellMap[k].segs.push({ id, a, trn });
  });
  let tlFilter = "all", tlSel = null;
  const tlRows = () => TL.channels.map((c, i) => ({ ...c, i })).filter((c) => tlFilter === "all" || c.subsystem === tlFilter);
  const fmtDay = (k) => new Date(k + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });

  function tlStats() {
    const rows = tlRows().map((r) => r.i);
    const segsF = TL.seg.filter((s) => rows.includes(s[1]));
    const anomF = segsF.filter((s) => s[3]);
    const byDay = {}; anomF.forEach((s) => { byDay[s[2]] = (byDay[s[2]] || 0) + 1; });
    const busiest = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
    const activeDays = new Set(segsF.map((s) => s[2])).size;
    $("#tlStats").innerHTML = [
      [activeDays, `recording days across a ${spanDays}-day span`],
      [segsF.length.toLocaleString(), "segments recorded"],
      [anomF.length, "labelled anomalies", "bad"],
      [busiest ? busiest[1] : 0, busiest ? `anomalies on the busiest day, ${fmtDay(busiest[0])}` : "no anomalies"],
    ].map(([b, s, c]) => `<div class="dstat ${c || ""}"><b>${b}</b><span>${s}</span></div>`).join("");
  }

  const heat = $("#heat"), hctx = heat.getContext("2d");
  const HL = 118, HT = 26, CH = 28;
  let hgeom = null;
  function drawHeat() {
    const rows = tlRows(), box = $("#heatScroll");
    const cw = Math.max(44, Math.floor((box.clientWidth - HL - 4) / days.length));
    const W = HL + cw * days.length + 4, H = HT + rows.length * CH + 4, dpr = Math.min(devicePixelRatio || 1, 2);
    heat.style.width = W + "px"; heat.style.height = H + "px"; heat.width = W * dpr; heat.height = H * dpr;
    hctx.setTransform(dpr, 0, 0, dpr, 0, 0); hctx.clearRect(0, 0, W, H);
    hgeom = { rows, cw };
    const muted = css("--muted"), acc = css("--accent"), fault = css("--fault"), s2 = css("--surface-2"), ink = css("--ink");
    hctx.font = `11px ${css("--f-mono")}`; hctx.textBaseline = "middle";
    days.forEach((d, j) => {
      hctx.fillStyle = muted; hctx.textAlign = "center";
      hctx.fillText(new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }), HL + j * cw + cw / 2, 11);
    });
    rows.forEach((r, ri) => {
      const y = HT + ri * CH;
      hctx.fillStyle = ink; hctx.textAlign = "right"; hctx.fillText(r.name, HL - 10, y + CH / 2);
      days.forEach((d, j) => {
        const c = cellMap[r.i + "|" + d], x = HL + j * cw;
        hctx.globalAlpha = 1; hctx.fillStyle = s2; hctx.fillRect(x + .5, y + 2, cw - 1, CH - 4);
        if (!c) return;
        if (c.a) { hctx.fillStyle = fault; hctx.globalAlpha = Math.min(.95, .3 + .65 * c.a / c.n); }
        else { hctx.fillStyle = acc; hctx.globalAlpha = Math.min(.55, .18 + .015 * c.n); }
        hctx.fillRect(x + .5, y + 2, cw - 1, CH - 4);
        hctx.globalAlpha = 1;
        hctx.fillStyle = ink; hctx.textAlign = "center";
        hctx.fillText(c.a ? `${c.a}/${c.n}` : String(c.n), x + cw / 2, y + CH / 2);
        if (tlSel && tlSel.k === r.i + "|" + d) { hctx.strokeStyle = ink; hctx.lineWidth = 2; hctx.strokeRect(x, y + 1, cw, CH - 2); }
      });
    });
  }
  function heatHit(e) {
    if (!hgeom) return null;
    const r = heat.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const j = Math.floor((x - HL) / hgeom.cw), ri = Math.floor((y - HT) / CH);
    if (j < 0 || j >= days.length || ri < 0 || ri >= hgeom.rows.length) return null;
    const row = hgeom.rows[ri], k = row.i + "|" + days[j];
    return { row, day: days[j], k, c: cellMap[k] };
  }
  heat.addEventListener("mousemove", (e) => {
    const h = heatHit(e); if (!h) return hideTip();
    showTip(e.clientX, e.clientY, `<b>${fmtDay(h.day)}</b><br>${h.row.name}<br>${h.c ? `${h.c.n} segment${h.c.n > 1 ? "s" : ""} · <span style="color:var(--fault)">${h.c.a} anomal${h.c.a === 1 ? "y" : "ies"}</span>` : "no telemetry recorded"}`);
  });
  heat.addEventListener("mouseleave", hideTip);
  heat.addEventListener("click", (e) => { const h = heatHit(e); if (!h || !h.c) return; tlSel = h; drawHeat(); renderTlDetail(); });

  function renderTlDetail() {
    const h = tlSel; if (!h) { $("#tlDetail").innerHTML = ""; return; }
    $("#tlDetail").innerHTML = `<div class="panel-head"><h3>${fmtDay(h.day)} · ${h.row.name}</h3><span class="small">${h.c.n} segments · ${h.c.a} anomalous</span></div>
      <div class="seg-rows">${h.c.segs.map((s) => { const t = testIndex[s.id];
        return `<div class="seg-row"><span class="mono">#${s.id}</span><span><span class="badge ${s.a ? "anom" : "nom"}">${s.a ? "anomaly" : "nominal"}</span>
          <span class="small"> ${s.trn ? "training split" : `test split · AI p = ${t.s.score.toFixed(2)}${t.s.pred ? " · " + (SIGNATURES[t.s.sig] || SIGNATURES.subtle).name : ""}`}</span></span>
          ${t ? `<button class="btn sm" type="button" data-replay="${s.id}">Replay</button>` : `<span class="small">used to train</span>`}</div>`; }).join("")}</div>`;
  }
  $("#tlDetail").addEventListener("click", (e) => { const b = e.target.closest("[data-replay]"); if (b) openInMonitor(+b.dataset.replay); });
  $("#tlFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return; tlFilter = b.dataset.f; tlSel = null;
    $("#tlFilter").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    tlStats(); drawHeat(); renderTlDetail(); drawWeeks();
  });
  if (has("#heatScroll")) new ResizeObserver(() => { if (drawn.timeline && curTab === "timeline") drawHeat(); }).observe($("#heatScroll"));

  function drawWeeks() {
    const rows = tlRows().map((r) => r.i), wk = {};
    TL.seg.filter((s) => rows.includes(s[1])).forEach(([, , date, a]) => { (wk[date] = wk[date] || [0, 0])[a]++; });
    const keys = days;
    keys.forEach((k) => { wk[k] = wk[k] || [0, 0]; });
    const o = baseOpts("", "Segments (log scale)");
    o.scales.x = { ...o.scales.x, type: "category", grid: { display: false } };
    o.scales.y = { ...o.scales.y, type: "logarithmic", min: 0.8 };
    mk("weekChart", { type: "bar", data: { labels: keys.map((k) => new Date(k + "T00:00:00Z").toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })),
      datasets: [
        { label: "Nominal", data: keys.map((k) => wk[k][0]), backgroundColor: css("--accent"), borderRadius: 2 },
        { label: "Anomalous", data: keys.map((k) => wk[k][1]), backgroundColor: css("--fault"), borderRadius: 2 },
      ] }, options: o });
  }

  /* ---------- B: anomaly explorer ---------- */
  const EX = FD.explorer;
  let exOutcome = "all", exSub = "all", exType = "all", exSel = null;
  [...new Set(allTest.filter((s) => s.pred || s.label).map((s) => s.sig))].sort().forEach((k) => {
    const o = el("option", null, (SIGNATURES[k] || SIGNATURES.subtle).name); o.value = k; $("#exType").append(o);
  });
  $("#exVar").textContent = `PC1 ${(EX.var_explained[0] * 100).toFixed(0)}% · PC2 ${(EX.var_explained[1] * 100).toFixed(0)}% of variance`;
  const exPass = (s) => (exOutcome === "all" || outcomeOf(s) === exOutcome) && (exSub === "all" || RP[testIndex[s.id].ch].subsystem === exSub) && (exType === "all" || ((s.pred || s.label) && s.sig === exType));
  function drawExplorer() {
    const groups = { tn: [], fp: [], fn: [], tp: [] };
    allTest.forEach((s) => { if (exPass(s)) { const p = EX.pts[s.id]; groups[outcomeOf(s)].push({ x: p[0], y: p[1], id: s.id }); } });
    const fault = css("--fault");
    const ds = [
      { label: "Nominal, passed", data: groups.tn, backgroundColor: color(css("--muted"), .35), borderWidth: 0, pointRadius: 3 },
      { label: "False alarm", data: groups.fp, backgroundColor: css("--warn"), borderWidth: 0, pointRadius: 5 },
      { label: "Fault missed", data: groups.fn, backgroundColor: "transparent", borderColor: fault, borderWidth: 1.6, pointRadius: 5 },
      { label: "Fault caught", data: groups.tp, backgroundColor: fault, borderWidth: 0, pointRadius: 4.5 },
    ];
    if (exSel) { const p = EX.pts[exSel]; ds.push({ label: "Selected", data: [{ x: p[0], y: p[1], id: exSel }], backgroundColor: "transparent", borderColor: css("--ink"), borderWidth: 2, pointRadius: 10 }); }
    const o = baseOpts("Principal component 1", "Principal component 2");
    o.interaction = { mode: "nearest", intersect: true };
    o.plugins.legend.labels.filter = (it) => it.text !== "Selected";
    o.plugins.legend.labels.boxHeight = 8;
    o.plugins.tooltip.callbacks = { label: (c) => { const s = testIndex[c.raw.id].s; return `#${s.id} ${RP[testIndex[s.id].ch].name} · p=${s.score.toFixed(2)} · ${outcomeName[outcomeOf(s)]}`; } };
    o.onClick = (_e, els) => { if (els.length) { const p = els[0]; exSel = charts.exChart.data.datasets[p.datasetIndex].data[p.index].id; drawExplorer(); renderExCard(); } };
    o.onHover = (e, els) => { e.native.target.style.cursor = els.length ? "pointer" : "default"; };
    mk("exChart", { type: "scatter", data: { datasets: ds }, options: o });
  }
  function color(c, a) { const t = document.createElement("canvas").getContext("2d"); t.fillStyle = c; const h = t.fillStyle;
    if (h.startsWith("#")) { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; } return h; }

  function renderExCard() {
    const card = $("#exCard");
    if (!exSel) { card.innerHTML = `<h3>Pick a segment</h3><p class="small">Click any dot on the map to see its signal, the AI's verdict and its diagnosis. Red dots are faults the AI caught, hollow rings are faults it missed, and amber dots are false alarms.</p>`; return; }
    const t = testIndex[exSel], s = t.s, o = outcomeOf(s), sig = SIGNATURES[s.sig] || SIGNATURES.subtle, top = (s.why || [])[0];
    card.innerHTML = `<div class="panel-head"><h3>Segment #${s.id}</h3><span class="chip ${s.pred ? "anom" : "nom"}" style="font-size:.8rem">${outcomeName[o]}</span></div>
      <canvas class="spark" id="exSpark"></canvas>
      <dl class="kv"><dt>Channel</dt><dd>${RP[t.ch].name}</dd><dt>Start (UTC)</dt><dd>${s.start}</dd><dt>Length</dt><dd>${s.duration_s} s · ${s.samples} samples</dd>
        <dt>AI probability</dt><dd>${s.score.toFixed(3)}</dd><dt>Expert label</dt><dd>${s.label ? "anomaly" : "nominal"}</dd>
        ${s.pred || s.label ? `<dt>Anomaly type</dt><dd>${sig.name}</dd>` : ""}${top && s.pred ? `<dt>Main evidence</dt><dd>${FAMILY_NAME[top.g] || top.g}</dd>` : ""}</dl>
      <button class="btn primary" type="button" id="exReplay">Replay with full diagnosis</button>`;
    $("#exReplay").addEventListener("click", () => openInMonitor(s.id));
    sparkline($("#exSpark"), s.v, s.pred ? css("--fault") : css("--accent"));
  }
  function sparkline(cv, v, col) {
    const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = r.width * dpr; cv.height = r.height * dpr; const c = cv.getContext("2d"); c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const lo = Math.min(...v), hi = Math.max(...v), W = r.width, H = r.height, p = 10;
    const y = (x) => H - p - ((x - lo) / ((hi - lo) || 1)) * (H - 2 * p);
    c.beginPath(); v.forEach((x, i) => { const xx = p + i / (v.length - 1) * (W - 2 * p); i ? c.lineTo(xx, y(x)) : c.moveTo(xx, y(x)); });
    c.strokeStyle = col; c.lineWidth = 1.8; c.lineJoin = "round"; c.stroke();
    c.lineTo(W - p, H - p); c.lineTo(p, H - p); c.closePath(); c.globalAlpha = .12; c.fillStyle = col; c.fill(); c.globalAlpha = 1;
  }
  function drawTypes() {
    const flagged = allTest.filter((s) => s.pred);
    const types = [...new Set(flagged.map((s) => s.sig))].sort((a, b) => flagged.filter((s) => s.sig === b).length - flagged.filter((s) => s.sig === a).length);
    const o = baseOpts("Windows flagged", ""); o.indexAxis = "y";
    o.scales.y = { ...o.scales.y, type: "category", stacked: true, grid: { display: false } }; o.scales.x.stacked = true;
    mk("typeChart", { type: "bar", data: { labels: types.map((k) => (SIGNATURES[k] || SIGNATURES.subtle).name),
      datasets: ["ADCS", "Sun sensing"].map((sub, i) => ({ label: sub === "ADCS" ? "ADCS magnetometer" : "Sun-sensing photodiodes",
        data: types.map((k) => flagged.filter((s) => s.sig === k && RP[testIndex[s.id].ch].subsystem === sub).length),
        backgroundColor: i ? css("--warn") : css("--accent"), borderRadius: 3, barPercentage: .7 })) }, options: o });
  }
  $("#exOutcome").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; exOutcome = b.dataset.o;
    $("#exOutcome").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); drawExplorer(); });
  $("#exSub").addEventListener("change", (e) => { exSub = e.target.value; drawExplorer(); });
  $("#exType").addEventListener("change", (e) => { exType = e.target.value; drawExplorer(); });

  /* ---------- C: threshold lab ---------- */
  const testDays = new Set(allTest.map((s) => s.start.slice(0, 10))).size;
  function confusionAt(t) { let tp = 0, fp = 0, fn = 0, tn = 0;
    allTest.forEach((s) => { const p = s.score >= t; if (p && s.label) tp++; else if (p) fp++; else if (s.label) fn++; else tn++; });
    const prec = tp + fp ? tp / (tp + fp) : 1, rec = tp + fn ? tp / (tp + fn) : 0, f1 = prec + rec ? 2 * prec * rec / (prec + rec) : 0;
    return { tp, fp, fn, tn, prec, rec, f1 }; }
  const thrGrid = Array.from({ length: 97 }, (_, i) => +(0.02 + i * 0.01).toFixed(2));
  const thrCurve = thrGrid.map(confusionAt);
  let thr = THR;
  $("#thrVal").textContent = THR.toFixed(2); $("#typeNote").textContent = `Every test window with p ≥ ${THR.toFixed(2)} (the alarm threshold)`;
  $("#thr").value = THR; $("#thrPresets").querySelector('[data-t="0.5"]').dataset.t = String(THR);
  function updateThreshold() {
    const m = confusionAt(thr);
    $("#thrVal").textContent = thr.toFixed(2);
    $("#thrStats").innerHTML = [
      [`${m.tp}/${m.tp + m.fn}`, "faults caught", "good"], [m.fn, "faults missed", "bad"], [m.fp, "false alarms", "warn"],
      [(m.prec * 100).toFixed(1) + "%", "precision: alarms that were real"], [(m.rec * 100).toFixed(1) + "%", "recall: faults that raised an alarm"],
      [((m.tp + m.fp) / testDays).toFixed(1), `alarms per day of telemetry (${testDays} days)`],
    ].map(([b, s, c]) => `<div class="dstat ${c || ""}"><b>${b}</b><span>${s}</span></div>`).join("");
    $("#thrPresets").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", Math.abs(+b.dataset.t - thr) < 0.001));
    ["thrChart", "histChart"].forEach((id) => { if (charts[id]) { charts[id].options.plugins.marker.x = id === "thrChart" ? thr : thr * 10 - 0.5; charts[id].update("none"); } });
  }
  function drawThreshold() {
    const o = baseOpts("Threshold", "Score"); o.scales.x.min = 0; o.scales.x.max = 1; o.scales.y.min = 0; o.scales.y.max = 1.02;
    o.plugins.marker = { x: thr };
    mk("thrChart", { type: "line", plugins: [lineMarker()], data: { datasets: [
      line("Precision", pts(thrGrid, thrCurve.map((m) => m.prec)), css("--accent")),
      line("Recall", pts(thrGrid, thrCurve.map((m) => m.rec)), css("--fault")),
      line("F1", pts(thrGrid, thrCurve.map((m) => m.f1)), css("--ok"), { borderDash: [5, 3] }),
    ] }, options: o });
    const bins = Array.from({ length: 10 }, (_, i) => i / 10), nom = bins.map(() => 0), an = bins.map(() => 0);
    allTest.forEach((s) => { const b = Math.min(9, Math.floor(s.score * 10)); (s.label ? an : nom)[b]++; });
    const h = baseOpts("AI probability", "Windows");
    h.scales.x = { ...h.scales.x, type: "category", grid: { display: false } };
    h.scales.y = { ...h.scales.y, type: "logarithmic", min: 0.8 };
    h.plugins.marker = { x: thr * 10 - 0.5 };
    mk("histChart", { type: "bar", plugins: [lineMarker()], data: { labels: bins.map((b) => b.toFixed(1) + "–" + (b + .1).toFixed(1)), datasets: [
      { label: "Expert label: nominal", data: nom, backgroundColor: css("--accent"), borderRadius: 2 },
      { label: "Expert label: anomaly", data: an, backgroundColor: css("--fault"), borderRadius: 2 },
    ] }, options: h });
    updateThreshold();
  }
  $("#thr").addEventListener("input", (e) => { thr = +e.target.value; updateThreshold(); });
  $("#thrPresets").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; thr = +b.dataset.t; $("#thr").value = thr; updateThreshold(); });

  /* ---------- D: battery digital twin ---------- */
  let twinCell = "B0005", twinK = 0, twinTimer = null;
  const twinPick = $("#twinCell");
  cellIds.forEach((c) => { const b = el("button", null, c); b.type = "button"; b.dataset.cell = c; b.setAttribute("aria-pressed", c === twinCell); twinPick.append(b); });
  twinPick.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; twinCell = b.dataset.cell; twinK = 0; stopTwin();
    twinPick.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b)); drawTwin(); });
  const statusOf = (soh) => soh >= 90 ? ["Healthy", "nom", "--ok"] : soh >= 85 ? ["Watch", "warn", "--warn"] : soh >= 80 ? ["Degraded", "warn", "--warn"] : ["End of life", "anom", "--fault"];
  const POLICY = {
    Healthy: ["Normal operations: the full payload schedule is allowed.", "Keep eclipse depth of discharge within the mission limit.", "Log battery health once per orbit."],
    Watch: ["Schedule high-power payload work in sunlight only.", "Cap eclipse depth of discharge below the normal limit to slow ageing.", "Raise the battery telemetry rate and send the trend to the ground each pass."],
    Degraded: ["Reduce the payload duty cycle. Housekeeping and communications come first.", "Lower the charge voltage limit to reduce cell stress.", "Warn the ground with the predicted remaining useful life."],
    "End of life": ["Run power-positive operations only: loads on in sunlight, minimum loads in eclipse.", "Raise the safe-mode under-voltage threshold.", "Plan end-of-mission activities with the ground team."],
  };
  const circ = 2 * Math.PI * 56; $("#gArc").style.strokeDasharray = circ;
  function updateTwin() {
    const cell = BH.cells[twinCell], tw = cell.twin[twinK], cap = cell.capacity[twinK], soh = cell.soh[Math.min(twinK, cell.soh.length - 1)];
    const [st, chipCls, colVar] = statusOf(soh);
    $("#twinCycleVal").textContent = `${twinK + 1} / ${cell.cycles}`;
    $("#twinCycle").value = twinK + 1;
    $("#gSoh").textContent = soh.toFixed(1) + "%";
    const arc = $("#gArc"); arc.style.strokeDashoffset = circ * (1 - Math.max(0, Math.min(1, soh / 100))); arc.style.stroke = css(colVar);
    const chip = $("#twinStatus"); chip.className = "chip " + chipCls; chip.textContent = st;
    const rs = BH.rul.series[twinCell], ri = rs ? rs.cycle.indexOf(twinK + 1) : -1;
    const rulTxt = ri >= 0 ? `${Math.round(rs.pred[ri])} cyc (${Math.round(rs.lo[ri])}–${Math.round(rs.hi[ri])})` : !rs ? "no EOL in test" : twinK + 1 < BH.rul.window ? "needs 10 cycles" : "past end of life";
    $("#twinKv").innerHTML = `<dt>Capacity</dt><dd>${cap.toFixed(3)} Ah</dd>
      <dt>AI RUL forecast</dt><dd>${rulTxt}</dd><dt>Actual RUL</dt><dd>${ri >= 0 ? rs.true[ri] + " cyc" : "–"}</dd>
      <dt>Internal resistance</dt><dd>${tw.R != null ? (tw.R * 1000).toFixed(0) + " mΩ" : "–"}</dd>
      <dt>Peak temperature</dt><dd>${tw.Tmax.toFixed(1)} °C</dd><dt>Discharge time</dt><dd>${tw.dur.toFixed(1)} min</dd>`;
    $("#twinTnote").textContent = `peak ${tw.Tmax.toFixed(1)} °C`;
    $("#twinAction").innerHTML = `<span class="chip ${chipCls}">${st} · ${soh.toFixed(1)}% of initial capacity</span>
      <ol class="steps">${POLICY[st].map((x) => `<li>${x}</li>`).join("")}</ol>
      <p class="callout">Health bands (share of the cell's initial capacity): Healthy ≥ 90%, Watch ≥ 85%, Degraded ≥ 80%, End of life &lt; 80% (industry-standard SOH-80). The RUL range is the conformal 90% interval. The policy steps are a proposed design based on common small-satellite practice.</p>`;
    if (charts.twinV) { charts.twinV.data.datasets[0].data = pts(tw.t, tw.v); charts.twinV.update("none"); }
    if (charts.twinT) { charts.twinT.data.datasets[0].data = pts(tw.t, tw.T); charts.twinT.update("none"); }
    if (charts.twinLife) { charts.twinLife.options.plugins.marker.x = twinK + 1; charts.twinLife.update("none"); }
    twinServer();
  }
  // live forecast from the backend's battery model (trained on all 12 end-of-life cells, so in-sample for these cells)
  const twinServer = debounce(async () => {
    const out = $("#twinSrv"), cell = BH.cells[twinCell], k = twinK + 1;
    if (!API.online) { out.textContent = ""; return; }
    if (k < BH.rul.window) { out.textContent = "Server forecast: needs 10 cycles of history"; return; }
    const fc = BH.fleet.find((c) => c.cell === twinCell) || { ambient: 24, current: 2 };
    try {
      const r = await API.call("/api/battery/rul", { soh: cell.soh.slice(0, k), ambient: fc.ambient, current: fc.current });
      if (twinK + 1 !== k) return;
      out.textContent = r.past_eol ? "Server forecast: past end of life" : `Server forecast: ${Math.round(r.rul)} cycles (${Math.round(r.lo)}–${Math.round(r.hi)}) · all-cell model, in-sample here`;
    } catch (e) { out.textContent = "Server forecast unavailable"; }
  }, 350);
  document.addEventListener("api-status", () => { if (drawn.twin) twinServer(); });
  function drawTwin() {
    const cell = BH.cells[twinCell], first = cell.twin[0];
    $("#twinCycle").max = cell.cycles;
    const maxT = Math.max(...cell.twin.map((t) => t.t[t.t.length - 1]));
    const ov = baseOpts("Time (min)", "Voltage (V)"); ov.scales.x.min = 0; ov.scales.x.max = Math.ceil(maxT / 5) * 5; ov.scales.y.min = 2; ov.scales.y.max = 4.3;
    ov.plugins.legend.display = false; ov.animation = false;
    mk("twinV", { type: "line", data: { datasets: [ line("This cycle", [], css("--accent"), { borderWidth: 2.4 }),
      line("Cycle 1", pts(first.t, first.v), css("--muted"), { borderDash: [4, 4], borderWidth: 1.2 }) ] }, options: ov });
    const ot = baseOpts("Time (min)", "°C"); ot.scales.x.min = 0; ot.scales.x.max = ov.scales.x.max; ot.scales.y.min = 20; ot.scales.y.max = 45;
    ot.plugins.legend.display = false; ot.animation = false;
    mk("twinT", { type: "line", data: { datasets: [ line("Temperature", [], css("--warn"), { fill: true, backgroundColor: color(css("--warn"), .12) }) ] }, options: ot });
    const ol = baseOpts("Cycle", "State of health (%)"); ol.animation = false; ol.plugins.marker = { x: 1, color: css("--accent") };
    ol.scales.y2 = { position: "right", min: 0, title: { display: true, text: "RUL (cycles)", color: css("--muted"), font: { family: css("--f-mono"), size: 11 } },
      grid: { display: false }, ticks: { color: css("--muted"), font: { family: css("--f-mono"), size: 10 } } };
    const rs = BH.rul.series[twinCell];
    const life = [ line("State of health", cell.soh.map((y, k) => ({ x: k + 1, y })), css("--ink"), { borderWidth: 1.6 }),
      line("End of life (80%)", [{ x: 1, y: 80 }, { x: cell.cycles, y: 80 }], css("--fault"), { borderDash: [5, 4], borderWidth: 1 }) ];
    if (rs) life.push(line("RUL 90% range", pts(rs.cycle, rs.hi), "transparent", { yAxisID: "y2", fill: "+1", backgroundColor: css("--accent-soft"), borderWidth: 0 }),
                      line("lo", pts(rs.cycle, rs.lo), "transparent", { yAxisID: "y2", borderWidth: 0 }),
                      line("AI RUL forecast", pts(rs.cycle, rs.pred), css("--accent"), { yAxisID: "y2", borderWidth: 1.6 }),
                      line("Actual RUL", pts(rs.cycle, rs.true), css("--muted"), { yAxisID: "y2", borderDash: [3, 3], borderWidth: 1.2 }));
    ol.plugins.legend.labels.filter = (it) => it.text !== "lo";
    mk("twinLife", { type: "line", plugins: [lineMarker()], data: { datasets: life }, options: ol });
    updateTwin();
  }
  function stopTwin() { clearInterval(twinTimer); twinTimer = null; $("#twinPlay").textContent = "Play life cycle"; }
  $("#twinPlay").addEventListener("click", () => {
    if (twinTimer) return stopTwin();
    if (twinK >= BH.cells[twinCell].cycles - 1) twinK = 0;
    $("#twinPlay").textContent = "Pause";
    twinTimer = setInterval(() => { const n = BH.cells[twinCell].cycles; if (twinK >= n - 1) return stopTwin(); twinK++; updateTwin(); }, 90);
  });
  $("#twinCycle").addEventListener("input", (e) => { stopTwin(); twinK = +e.target.value - 1; updateTwin(); });

  const DRAW = {
    timeline: () => { tlStats(); drawHeat(); renderTlDetail(); drawWeeks(); },
    explorer: () => { drawExplorer(); renderExCard(); drawTypes(); },
    threshold: drawThreshold,
    twin: drawTwin,
  };

  /* ---------- page polish: nav state, progress, counters ---------- */
  const navLinks = [...document.querySelectorAll(".nav-links a")];
  // sliding section strip: mouse wheel, click-drag, touch swipe, or the ‹ › buttons
  const strip = $("#navLinks"), navL = $("#navLeft"), navR = $("#navRight");
  function updStrip() {
    const max = strip.scrollWidth - strip.clientWidth;
    const atStart = strip.scrollLeft <= 2, atEnd = strip.scrollLeft >= max - 2;
    navL.hidden = max <= 2 || atStart; navR.hidden = max <= 2 || atEnd;
    strip.style.setProperty("--fl", atStart ? "0px" : "28px");
    strip.style.setProperty("--fr", atEnd ? "0px" : "28px");
  }
  const slide = (dir) => strip.scrollBy({ left: dir * Math.max(160, strip.clientWidth * 0.6), behavior: reduceMotion ? "auto" : "smooth" });
  navL.addEventListener("click", () => slide(-1));
  navR.addEventListener("click", () => slide(1));
  strip.addEventListener("scroll", updStrip, { passive: true });
  strip.addEventListener("wheel", (e) => {
    if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    strip.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
  let drag = null;
  strip.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse" && e.button === 0) drag = { x: e.clientX, left: strip.scrollLeft, moved: false }; });
  addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) > 5) { drag.moved = true; strip.classList.add("dragging"); }
    if (drag.moved) strip.scrollLeft = drag.left - dx;
  });
  addEventListener("pointerup", () => { if (drag && drag.moved) setTimeout(() => strip.classList.remove("dragging"), 0); drag = null; });
  strip.addEventListener("click", (e) => { if (strip.classList.contains("dragging")) e.preventDefault(); }, true);
  new ResizeObserver(updStrip).observe(strip);
  updStrip();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(updStrip);
  // keep the current section's link in view
  // mark this page's link and bring it into view
  const activeLink = navLinks.find((a) => a.getAttribute("href") === pageFile);
  const showActive = () => { if (activeLink) { strip.scrollLeft = activeLink.offsetLeft - strip.offsetLeft - (strip.clientWidth - activeLink.offsetWidth) / 2; updStrip(); } };
  if (activeLink) { activeLink.classList.add("active"); activeLink.setAttribute("aria-current", "page"); }
  showActive();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(showActive);
  const bar = $("#progressBar");
  const onScroll = () => { const h = document.documentElement.scrollHeight - innerHeight; bar.style.width = (h > 0 ? scrollY / h * 100 : 0) + "%"; };
  addEventListener("scroll", onScroll, { passive: true }); onScroll();

  if (!reduceMotion) document.querySelectorAll(".kpi b").forEach((b) => {
    const txt = b.textContent, m = txt.match(/^([^\d]*)([\d,]*\.?\d+)(.*)$/); if (!m) return;
    const target = parseFloat(m[2].replace(/,/g, "")), dec = (m[2].split(".")[1] || "").length, comma = m[2].includes(","), t0 = performance.now();
    const step = (now) => { const k = Math.min(1, (now - t0) / 1400), v = target * (1 - Math.pow(1 - k, 3));
      b.textContent = m[1] + (comma ? Math.round(v).toLocaleString() : v.toFixed(dec)) + m[3]; if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });

  function repaint() {
    draw(); drawAllCharts(); if (satView) satView.recolor(); if (orbitView) orbitView.recolor(); if (playground) playground.render();
    if (has("#tab-timeline") && window.Chart) { TABS.forEach((t) => { drawn[t] = false; }); DRAW[curTab](); drawn[curTab] = true; }
  }
  if (has("#tab-timeline") && window.Chart) showTab("timeline");

  if (hasMonitor) {
    selectChannel(state.ch);
    const linked = testIndex[new URLSearchParams(location.search).get("seg")];   // "Replay" links from the dashboards
    if (linked) { selectChannel(linked.ch); jumpTo(linked.i); }
    if (reduceMotion) { state.progress = 1; state.decided = true; renderPanels(); }
    setPlaying(state.playing);
    fit(); draw();
    requestAnimationFrame(tick);
  }
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { draw(); drawAllCharts(); }); else drawAllCharts();
  if (!window.Chart) window.addEventListener("load", drawAllCharts);
})();

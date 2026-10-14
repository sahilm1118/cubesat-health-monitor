# CubeSat Health Monitor

Website and analysis code for **AI-Based Autonomous Fault Detection and Predictive Health Monitoring System for CubeSats**.
Every number, chart and interactive model on the site is computed from real data:

| Dataset | Used for |
|---|---|
| **OPSSAT-AD**: labelled telemetry from ESA's OPS-SAT CubeSat (Zenodo 15108715, CC BY 4.0) | fault detection, playground, autonomy simulation |
| **NASA Ames Li-ion Battery Aging**: 34 cells, 21 usable after cleaning | state of health, remaining useful life |
| **ESA-ADB Mission 1**: 6 channels fetched by HTTP range requests (Zenodo 15237121) | cross-mission generalisation test |

## What the system does

1. **Detects faults**: compact Extra Trees model (120 trees) on 40 inputs (19 published segment features, channel-relative
   z-scores, and change versus the previous window). Selected by 5-fold CV on the training split only; probabilities calibrated
   with isotonic regression; alarm threshold chosen on out-of-fold training predictions.
2. **Explains itself**: group-occlusion evidence per measurement family, plus physical rules that name the anomaly type
   (validated on injected faults with a fresh random seed).
3. **Acts**: a fault-management (FDIR) state machine (Monitor → Isolate → Safe mode, with recovery), tested in a Monte Carlo
   simulation against classic limit checks and a hybrid of both.
4. **Forecasts battery life**: leave-one-cell-out RUL with conformal 90% intervals and SOH from a 15-minute partial discharge.

## Layout

```
scripts/features.py        19 OPSSAT-AD features, re-implemented and verified against dataset.csv
scripts/fd_features.py     feature sets A / B / C
scripts/improve_models.py  candidate models, CV selection          -> data/improve_results.csv
scripts/fd_model.py        deployed detector, calibration, explanations, anomaly-type rules
scripts/fault_injection.py fault injection, type validation, FDIR state machine
scripts/pipeline_fd.py     everything for fault detection          -> site/data/*.json
scripts/battery_fleet.py   loads + cleans the NASA battery fleet
scripts/pipeline_batt.py   SOH / RUL + conformal intervals         -> site/data/battery_health.json
scripts/remote_zip.py      reads single files out of a remote ZIP (no 3.8 GB download)
scripts/pipeline_esa.py    ESA-ADB cross-mission test              -> site/data/esa.json
scripts/check_js.cjs       parity test: browser model vs Python on 150 real segments
site/src/template.html     page source (edit text and team names here)
site/src/fdcore.js         the detection pipeline ported to JavaScript (runs in the browser)
site/index.html            the finished website, the file to host
```

## Rebuild

```
cd scripts
python train_models.py
cd ..
python scripts/build_site.py
node scripts/check_js.cjs
```

## Backend API

`backend/` is a FastAPI server around the same model (`/api/score`, `/api/simulate`, `/api/battery/rul`).
Run it, test it and publish it as described in [DEPLOY.md](DEPLOY.md). After retraining, refresh its model files with
`python scripts/export_backend.py`.

## Host it

`site/index.html` is one self-contained file (about 2 MB). Upload it to GitHub Pages, Netlify Drop or any static host.
It loads Chart.js and three.js from public CDNs, so it needs an internet connection.

## Add your team

Edit the `#team` section in `site/src/template.html`, then run `python scripts/build_site.py`.

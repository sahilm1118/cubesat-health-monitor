"""CubeSat Health Monitor API.

Endpoints
  GET  /api/health           liveness + model info
  GET  /api/meta             channels, threshold, fault types
  POST /api/score            score one telemetry window (anomaly probability, type, evidence, hybrid alarm)
  POST /api/simulate         run the FDIR state machine over real OPS-SAT telemetry with an injected fault
  POST /api/battery/rul      remaining-useful-life forecast with a 90% conformal interval

Configuration (environment variables)
  ALLOWED_ORIGINS   comma-separated website origins allowed to call the API (CORS)
  ENABLE_DOCS       1 to expose /docs (keep 0 in production)
  TRUST_PROXY       1 when running behind a reverse proxy such as Render
  FORCE_HSTS        1 when served over HTTPS
  MAX_BODY_BYTES, RATE_DEFAULT, RATE_SIMULATE   limits (see security.py)
"""
import json
import logging
import math
import os
import time
from typing import Annotated, Literal, Optional

import numpy as np
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from . import engine
from .security import SecurityMiddleware

VERSION = "1.0.0"
log = logging.getLogger("chm")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

DET = engine.Detector()
RULM = engine.RUL()
SIM = json.loads((engine.MODELS / "sim_data.json").read_text())
STARTED = time.time()
FAULTS = ["spike", "noise", "stuck", "offset", "data_gap", "amplitude"]
CHANNEL_NAMES = {s["channel"]: s["name"] for s in SIM["playground"]}

origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "http://localhost:8765,http://127.0.0.1:8765").split(",") if o.strip()]
docs = os.getenv("ENABLE_DOCS", "0") == "1"
app = FastAPI(title="CubeSat Health Monitor API", version=VERSION,
              docs_url="/docs" if docs else None, redoc_url=None, openapi_url="/openapi.json" if docs else None)
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type"],
                   allow_credentials=False, max_age=600)
app.add_middleware(SecurityMiddleware)   # outermost: runs before CORS and routing

Finite = Annotated[float, Field(allow_inf_nan=False)]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PrevWindow(Strict):
    std: Finite
    mean: Finite
    kurtosis: Finite
    diff_var: Finite
    n_peaks: Annotated[int, Field(ge=0, le=10_000)]


class ScoreRequest(Strict):
    channel: Literal[tuple(DET.channels)]
    values: Annotated[list[Finite], Field(min_length=8, max_length=5000)]
    dt: Optional[Annotated[list[Annotated[float, Field(gt=0, le=1e6, allow_inf_nan=False)]], Field(max_length=4999)]] = None
    sampling: Annotated[float, Field(gt=0, le=1e5, allow_inf_nan=False)] = 1.0
    prev: Optional[PrevWindow] = None
    contiguous: bool = False

    @model_validator(mode="after")
    def check_dt(self):
        if self.dt is not None and len(self.dt) != len(self.values) - 1:
            raise ValueError("dt must have exactly one entry fewer than values")
        if max(abs(v) for v in self.values) > 1e12:
            raise ValueError("values out of range")
        return self


class SimRequest(Strict):
    stretch: Annotated[int, Field(ge=0, le=len(SIM["stretches"]) - 1)] = 0
    fault: Literal[tuple(FAULTS)] = "stuck"
    length: Annotated[int, Field(ge=2, le=8)] = 4
    start: Annotated[int, Field(ge=1, le=14)] = 8
    seed: Annotated[int, Field(ge=0, le=2**31 - 1)] = 100


class RulRequest(Strict):
    soh: Annotated[list[Annotated[float, Field(ge=0, le=150, allow_inf_nan=False)]], Field(min_length=10, max_length=3000)]
    ambient: Annotated[float, Field(ge=-40, le=80, allow_inf_nan=False)] = 24.0
    current: Annotated[float, Field(gt=0, le=10, allow_inf_nan=False)] = 2.0


def _times(values, dt, sampling):
    if dt is None:
        return np.arange(len(values), dtype=float) * sampling
    return np.concatenate([[0.0], np.cumsum(dt)])


def _clean(obj):
    """JSON-safe floats (no NaN/inf leaks)"""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(v) for v in obj]
    if isinstance(obj, (np.floating,)):
        return _clean(float(obj))
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    return obj


@app.exception_handler(RequestValidationError)
async def bad_request(_: Request, exc: RequestValidationError):
    errs = [{"field": ".".join(str(x) for x in e.get("loc", [])[1:]) or "body", "problem": e.get("msg", "invalid")} for e in exc.errors()[:5]]
    return JSONResponse(status_code=422, content={"error": "Invalid request", "details": errs})


@app.exception_handler(Exception)
async def server_error(_: Request, exc: Exception):
    log.exception("unhandled error")            # full detail stays in the server log, never in the response
    return JSONResponse(status_code=500, content={"error": "Internal error"})


@app.get("/api/health")
def health():
    return {"status": "ok", "version": VERSION, "model": f"extra-trees-{len(DET.forest.trees)}", "uptime_s": round(time.time() - STARTED)}


@app.get("/api/meta")
def meta():
    return {"channels": [{"id": c, "name": CHANNEL_NAMES.get(c, c)} for c in DET.channels], "threshold": DET.threshold,
            "faults": FAULTS, "stretches": [{"index": i, "name": s["name"], "windows": len(s["windows"])} for i, s in enumerate(SIM["stretches"])]}


@app.post("/api/score")
def score(req: ScoreRequest):
    t = _times(req.values, req.dt, req.sampling)
    prev = req.prev.model_dump() if req.prev else None
    a = DET.analyse(req.values, t, req.sampling, req.channel, prev, req.contiguous)
    return _clean({**a, "threshold": DET.threshold})


@app.post("/api/simulate")
def simulate(req: SimRequest):
    S = SIM["stretches"][req.stretch]
    m = {"ai": engine.FDIR(), "limit": engine.FDIR(), "hybrid": engine.FDIR()}
    trace, prev = [], None
    for i, w in enumerate(S["windows"]):
        faulty = req.start <= i < req.start + req.length
        t = np.concatenate([[0.0], np.cumsum(w["dt"])])
        v = np.array(w["v"], float)
        if faulty:
            v, t = engine.inject(req.fault, v, t, seed=req.seed + i, pos=0.35)
        a = DET.analyse(v, t, w["sampling"], w["channel"], w["prev"] if i == 0 else prev, w["contig"] if i == 0 else True)
        prev = a["features"]
        flags = {"ai": a["flag"], "limit": a["limit"], "hybrid": a["hybrid"]}
        ps = {"ai": a["p"], "limit": 1.0, "hybrid": max(a["p"], 1.0 if a["limit"] else 0.0)}
        trace.append({"window": i, "faulty": faulty, "label": w["label"], "p": round(a["p"], 4), "type": a["sig"],
                      "alarm": flags, "level": {k: m[k].step(flags[k], ps[k]) for k in m}})
    return _clean({"stretch": S["name"], "fault": req.fault, "levels": ["Nominal", "Monitor", "Isolate", "Safe mode"], "trace": trace})


@app.post("/api/battery/rul")
def battery_rul(req: RulRequest):
    return _clean(RULM.forecast(req.soh, req.ambient, req.current))

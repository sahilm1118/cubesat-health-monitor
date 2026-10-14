"""Backend tests. Run from the backend folder:  python -m tests.test_api
(also works with pytest).  Requires node for the browser-parity check."""
import json
import os
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("ALLOWED_ORIGINS", "https://example.github.io")
os.environ.setdefault("RATE_DEFAULT", "40")
os.environ.setdefault("RATE_SIMULATE", "3")

from fastapi.testclient import TestClient  # noqa: E402

from app import engine  # noqa: E402
from app.main import app  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
BACKEND = Path(__file__).resolve().parents[1]
client = TestClient(app)
GOOD_ORIGIN = {"Origin": "https://example.github.io"}
SIM = json.loads((BACKEND / "models" / "sim_data.json").read_text())


def window(i=0):
    s = SIM["playground"][i]
    return {"channel": s["channel"], "values": s["v"], "dt": s["dt"], "sampling": s["sampling"], "prev": s["prev"], "contiguous": s["contig"]}


def test_parity_with_python_pipeline():
    chk = json.loads((ROOT / "data" / "js_check.json").read_text())
    det = engine.Detector()
    worst, same_flag, same_sig = 0.0, 0, 0
    for s in chk:
        t = [0.0]
        for d in s["dt"]:
            t.append(t[-1] + d)
        a = det.analyse(s["v"], t, s["sampling"], s["channel"], s["prev"], s["contig"])
        worst = max(worst, abs(a["p"] - s["py_p"]))
        same_flag += (a["p"] >= det.threshold) == (s["py_p"] >= det.threshold)
        same_sig += a["sig"] == s["py_sig"]
    print(f"  python parity: max |dp| {worst:.3g}, same alarm {same_flag}/{len(chk)}, same type {same_sig}/{len(chk)}")
    assert same_flag == len(chk) and same_sig >= len(chk) - 1


def test_parity_with_browser_injection():
    out = json.loads(subprocess.run(["node", str(BACKEND / "tests" / "js_inject.cjs")], capture_output=True, text=True, check=True).stdout)
    det, s = engine.Detector(), SIM["playground"][0]
    t0 = [0.0]
    for d in s["dt"]:
        t0.append(t0[-1] + d)
    for r in out:
        v, t = engine.inject(r["kind"], s["v"], t0, seed=r["seed"], severity=1.3, pos=0.4)
        assert len(v) == len(r["v"]), r["kind"]
        assert max(abs(a - b) for a, b in zip(v, r["v"])) < 1e-9 * max(1, max(abs(x) for x in r["v"])), r["kind"]
        a = det.analyse(v, t, s["sampling"], s["channel"], s["prev"], s["contig"])
        assert abs(a["p"] - r["p"]) < 1e-6 and a["sig"] == r["sig"], (r["kind"], a["p"], r["p"], a["sig"], r["sig"])
    print(f"  browser parity: {len(out)} injected windows identical (values, probability, type)")


def test_health_and_headers():
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"
    for h in ("x-content-type-options", "x-frame-options", "content-security-policy", "referrer-policy", "cache-control"):
        assert h in r.headers, h


def test_docs_hidden_in_production():
    assert client.get("/docs").status_code == 404
    assert client.get("/openapi.json").status_code == 404


def test_score_ok_and_cors():
    r = client.post("/api/score", json=window(), headers=GOOD_ORIGIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert 0 <= body["p"] <= 1 and body["sig"] and "hybrid" in body
    assert r.headers.get("access-control-allow-origin") == "https://example.github.io"
    bad = client.post("/api/score", json=window(), headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in bad.headers


def test_validation_rejects_bad_input():
    w = window()
    cases = [
        {**w, "channel": "CADC9999"},                       # unknown channel
        {**w, "values": w["values"][:3], "dt": None},       # too short
        {**w, "dt": w["dt"][:-1]},                          # length mismatch
        {**w, "sampling": -1},                              # negative sampling
        {**w, "extra": "field"},                            # unexpected field
    ]
    for c in cases:
        r = client.post("/api/score", json=c)
        assert r.status_code == 422, (r.status_code, r.text)
        assert "Traceback" not in r.text
    r = client.post("/api/score", content=b'{"channel":"CADC0872","values":[NaN,1,2,3,4,5,6,7]}', headers={"Content-Type": "application/json"})
    assert r.status_code == 422


def test_body_size_limit():
    r = client.post("/api/score", content=b"x" * (300 * 1024), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_simulate_and_rul():
    r = client.post("/api/simulate", json={"stretch": 0, "fault": "data_gap", "length": 4})
    assert r.status_code == 200, r.text
    tr = r.json()["trace"]
    assert any(w["faulty"] and w["alarm"]["ai"] for w in tr)
    soh = [100 - 0.18 * k for k in range(60)]
    r = client.post("/api/battery/rul", json={"soh": soh, "ambient": 24, "current": 2})
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["lo"] <= b["rul"] <= b["hi"]
    assert client.post("/api/battery/rul", json={"soh": soh[:5]}).status_code == 422


def test_rate_limit():
    codes = [client.post("/api/simulate", json={"stretch": 1}).status_code for _ in range(6)]
    assert 429 in codes, codes
    r = client.post("/api/simulate", json={"stretch": 1})
    assert r.status_code == 429 and "retry-after" in r.headers


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items(), key=lambda kv: list(globals()).index(kv[0])) if k.startswith("test_")]
    failed = 0
    for fn in tests:
        try:
            fn(); print("PASS", fn.__name__)
        except Exception as e:  # noqa: BLE001
            failed += 1; print("FAIL", fn.__name__, "->", repr(e)[:300])
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)

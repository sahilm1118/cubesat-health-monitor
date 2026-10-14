"""Inline the model results, the browser model and its engine into the page template.

Writes:
  site/index.html     - standalone website with a strict Content-Security-Policy (host on GitHub Pages / Netlify)
  site/artifact.html  - same page without the document wrapper, for the claude.ai Artifact (browser mode, no API)

The backend address comes from the API_BASE environment variable, e.g.
  set API_BASE=https://cubesat-health-api.onrender.com   (Windows)     then   python scripts/build_site.py
Default: http://127.0.0.1:8000 for local testing.
"""
import base64
import hashlib
import os
import re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DATA = SITE / "data"

API_BASE = os.getenv("API_BASE", "http://127.0.0.1:8000").rstrip("/")
u = urlparse(API_BASE)
if u.scheme not in ("http", "https") or not u.netloc or any(c in API_BASE for c in "\"'<> "):
    raise SystemExit(f"API_BASE must be a plain http(s) origin, got {API_BASE!r}")
API_ORIGIN = f"{u.scheme}://{u.netloc}"

body = (SITE / "src" / "template.html").read_text(encoding="utf-8")
for key, name in (("__FD__", "fault_detection"), ("__BH__", "battery_health"), ("__RP__", "telemetry_replay"),
                  ("__MODEL__", "fd_model"), ("__SIM__", "sim_data"), ("__ESA__", "esa")):
    p = DATA / f"{name}.json"
    data = p.read_text(encoding="utf-8").replace("</", "<\\/") if p.exists() else "null"
    body = body.replace(key, data)
body = body.replace("__FDCORE__", (SITE / "src" / "fdcore.js").read_text(encoding="utf-8").replace("</script", "<\\/script"))


def script_hashes(html):
    """sha256 of every executable inline <script> (JSON data blocks are not executed and need no hash)"""
    out = []
    for attrs, content in re.findall(r"<script([^>]*)>(.*?)</script>", html, flags=re.S):
        if "src=" in attrs or "application/json" in attrs:
            continue
        out.append("'sha256-" + base64.b64encode(hashlib.sha256(content.encode("utf-8")).digest()).decode() + "'")
    return out


DESC = ("AI-based autonomous fault detection and predictive health monitoring for CubeSats: trained on real ESA OPS-SAT "
        "telemetry, NASA battery aging data and tested across missions on ESA-ADB.")

# ---- artifact: browser mode (the artifact host blocks calls to other servers anyway)
(SITE / "artifact.html").write_text(body.replace("__API_BASE__", ""), encoding="utf-8")

# ---- standalone site with CSP
page = body.replace("__API_BASE__", API_BASE)
csp = "; ".join([
    "default-src 'none'",
    "script-src " + " ".join(script_hashes(page) + ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"]),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    f"connect-src 'self' {API_ORIGIN}",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "upgrade-insecure-requests" if API_ORIGIN.startswith("https") else "",
])
csp = csp.rstrip("; ")
(SITE / "index.html").write_text(
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    f'<meta http-equiv="Content-Security-Policy" content="{csp}">\n'
    '<meta name="referrer" content="no-referrer">\n'
    f'<meta name="description" content="{DESC}">\n'
    '<meta property="og:type" content="website">\n'
    '<meta property="og:title" content="CubeSat Health Monitor">\n'
    f'<meta property="og:description" content="{DESC}">\n'
    '<meta name="twitter:card" content="summary">\n'
    '<meta name="twitter:title" content="CubeSat Health Monitor">\n'
    f'<meta name="twitter:description" content="{DESC}">\n'
    '<meta name="theme-color" content="#0a0f1d">\n'
    "</head>\n<body>\n" + page + "\n</body>\n</html>\n",
    encoding="utf-8",
)
print(f"built {(SITE / 'index.html').stat().st_size:,} bytes · API {API_BASE} · {len(script_hashes(page))} inline scripts hashed")

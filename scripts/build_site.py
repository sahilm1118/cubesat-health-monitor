"""Build the multi-page website from site/src/template.html.

Writes to site/:
  index.html, monitor.html, dashboards.html, ...   one page per topic, each holding only its own sections
  assets/site.css, assets/app.js, assets/fdcore.js, assets/data.js   shared by all pages (cached by the browser)

The backend address comes from the API_BASE environment variable, e.g.
  set API_BASE=https://cubesat-health-api.onrender.com   (Windows)     then   python scripts/build_site.py
Default: http://127.0.0.1:8000 for local testing.
"""
import hashlib
import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
DATA = SITE / "data"
ASSETS = SITE / "assets"
ASSETS.mkdir(exist_ok=True)

API_BASE = os.getenv("API_BASE", "http://127.0.0.1:8000").rstrip("/")
u = urlparse(API_BASE)
if u.scheme not in ("http", "https") or not u.netloc or any(c in API_BASE for c in "\"'<> "):
    raise SystemExit(f"API_BASE must be a plain http(s) origin, got {API_BASE!r}")
API_ORIGIN = f"{u.scheme}://{u.netloc}"

# file, tab title, sections on the page, libraries it needs
PAGES = [
    ("index.html", None, ["hero", "explore", "problem"], ["three"]),
    ("monitor.html", "Live Monitor", ["monitor"], []),
    ("dashboards.html", "Dashboards", ["dashboards"], ["chart"]),
    ("playground.html", "Try the AI", ["playground", "upload"], []),
    ("autonomy.html", "Autonomy", ["autonomy"], ["chart"]),
    ("architecture.html", "Architecture", ["architecture"], ["three"]),
    ("detection.html", "Fault Detection", ["detection"], ["chart"]),
    ("validation.html", "Validation", ["validation", "limitations"], ["chart"]),
    ("battery.html", "Battery Health", ["battery"], ["chart"]),
    ("data.html", "Data", ["data"], []),
    ("about.html", "About", ["about", "team"], []),
]
LIBS = {
    "chart": '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.js" integrity="sha384-dug+JxfBvklEQdJ4AYuBBAIScUz0bVN73xpy273gcAwHjb3qI0fXmuYNaNfdyYJG" crossorigin="anonymous" referrerpolicy="no-referrer"></script>',
    "three": '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js" integrity="sha384-CI3ELBVUz9XQO+97x6nwMDPosPR5XvsxW2ua7N1Xeygeh1IxtgqtCkGfQY9WWdHu" crossorigin="anonymous" referrerpolicy="no-referrer"></script>',
}
DESC = ("AI-based autonomous fault detection and predictive health monitoring for CubeSats: trained on real ESA OPS-SAT "
        "telemetry, NASA battery aging data and tested across missions on ESA-ADB.")

tpl = (SITE / "src" / "template.html").read_text(encoding="utf-8").replace("\r\n", "\n")
tpl = tpl.replace("__PHOTO__", "img/sahil.jpg").replace("__PHOTO_KAUSTUBH__", "img/kaustubh.jpg")


def between(a, b, include=False):
    s = tpl.index(a)
    e = tpl.index(b, s + len(a))
    return tpl[s:e + len(b)] if include else tpl[s + len(a):e]


def write_asset(name, text):
    """the ?v= hash makes browsers fetch new versions after a deploy"""
    (ASSETS / name).write_text(text, encoding="utf-8")
    return f"assets/{name}?v={hashlib.sha256(text.encode()).hexdigest()[:8]}"


data = {}
for key, name in (("fd", "fault_detection"), ("bh", "battery_health"), ("rp", "telemetry_replay"),
                  ("model", "fd_model"), ("sim", "sim_data"), ("esa", "esa")):
    p = DATA / f"{name}.json"
    data[key] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
css_url = write_asset("site.css", between("<style>", "</style>").strip() + "\n")
data_url = write_asset("data.js", "window.CHM_DATA=" + json.dumps(data, separators=(",", ":")) + ";\n")
core_url = write_asset("fdcore.js", (SITE / "src" / "fdcore.js").read_text(encoding="utf-8"))
app_url = write_asset("app.js", between("<script>", "</script>").strip() + "\n")

nav = between('<nav class="nav"', "</nav>", include=True)
footer = between("<footer>", "</footer>", include=True)
fonts = re.search(r'<link rel="stylesheet" href="https://fonts[^\n]*', tpl).group(0)
sections = {m.group(1): m.group(0) for m in re.finditer(r'  <section[^>]*\bid="([\w-]+)".*?</section>\n', tpl, flags=re.S)}
sections["hero"] = between('  <header class="hero">', "</header>", include=True) + "\n"

csp = "; ".join([
    "default-src 'none'",
    "script-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    f"connect-src 'self' {API_ORIGIN}",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
])
missing = set(sections) - {s for _, _, secs, _ in PAGES for s in secs}
if missing:
    raise SystemExit(f"sections not on any page: {sorted(missing)}")

for file, label, secs, libs in PAGES:
    title = f"{label} · CubeSat Health Monitor" if label else "CubeSat Health Monitor"
    body = "".join(sections[s] for s in secs)
    scripts = "\n".join(LIBS[lib] for lib in libs)
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="{csp}">
<meta name="referrer" content="no-referrer">
<title>{title}</title>
<meta name="description" content="{DESC}">
<meta property="og:type" content="website">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{DESC}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#0a0f1d">
<meta name="chm-api" content="{API_BASE}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
{fonts}
<link rel="stylesheet" href="{css_url}">
</head>
<body data-file="{file}">
{nav}

<main class="wrap" id="top">
{body}</main>

{footer}

<script src="{data_url}"></script>
<script src="{core_url}"></script>
{scripts}
<script src="{app_url}"></script>
</body>
</html>
"""
    (SITE / file).write_text(page, encoding="utf-8")
size = sum(f.stat().st_size for f in ASSETS.iterdir())
print(f"built {len(PAGES)} pages, shared assets {size:,} bytes, API {API_BASE}")

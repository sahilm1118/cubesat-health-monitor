# Running and publishing the CubeSat Health Monitor

## Architecture

```
GitHub Pages (static site/index.html)  ──HTTPS + CORS──▶  Render (FastAPI in Docker, backend/)
   in-browser model as fallback                              same model, pure NumPy, no training data
```

The website works on its own: if the API is unreachable, everything is scored in the browser and the
status pill in the navigation bar says "browser mode". With the API online, the playground cross-checks
every window against the server, the "Score your own telemetry" panel uses the server, and the battery
twin shows live server forecasts.

## Run locally

```
python -m uvicorn app.main:app --app-dir backend --port 8000
python -m http.server 8765 --directory site
```
Open http://localhost:8765. The pill should read **API online**.

Tests (from the `backend` folder): `python -m tests.test_api`. There are 9 tests: parity with the Python
pipeline and the browser, CORS, validation, body limit, rate limit, security headers, docs hidden.

## Publish (when you're ready for GitHub)

1. **GitHub.** Create a repository (for example `cubesat-health-monitor`) and upload this folder through the
   website ("Add file → Upload files") or GitHub Desktop. `.gitignore` keeps the large raw datasets out.
2. **Render (API).** Sign in at render.com → **New → Blueprint** → pick the repository. Render reads
   `render.yaml` and builds `backend/Dockerfile`. Before deploying, set **ALLOWED_ORIGINS** to
   `https://YOUR-USERNAME.github.io`. When it's live, copy the URL (for example `https://cubesat-health-api.onrender.com`).
3. **Point the site at the API.** Rebuild with that URL, then upload the new `site/index.html`:
   ```
   set API_BASE=https://cubesat-health-api.onrender.com
   python scripts/build_site.py
   ```
4. **GitHub Pages.** Repository → Settings → Pages → Deploy from a branch → `main` / `/site`.
   The site appears at `https://YOUR-USERNAME.github.io/REPO/`.

Render's free tier sleeps after inactivity, so the first request can take about a minute. The page shows
"browser mode" until the server wakes up.

## Security measures

| Layer | Measure |
|---|---|
| API access | CORS allow-list (`ALLOWED_ORIGINS`), GET/POST only, no cookies or credentials |
| Abuse | Per-client token-bucket rate limits (90/min, simulate 12/min); proxy-aware IP (right-most `X-Forwarded-For` only) |
| Input | Strict schemas: unknown fields rejected, NaN/∞ rejected, length and range limits, known channels only, 256 KB body cap |
| Output | Generic error messages (details only in server logs), no `Server` header, no stack traces |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `CSP: default-src 'none'`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, HSTS on HTTPS |
| Surface | Interactive docs off in production; models loaded from JSON (never unpickled); no file uploads (the browser parses CSVs and sends numbers only) |
| Container | Slim image, pinned dependencies, runs as an unprivileged user on a read-only code tree, health check |
| Website | Strict Content-Security-Policy (inline scripts allowed only by SHA-256 hash), Subresource Integrity on the CDN libraries, `no-referrer`, request timeouts |

There are no secrets in the repository. The API is public by design, protected by its origin allow-list
and rate limits, and it stores no data.

"""Security middleware: body-size limit, per-client rate limiting and response hardening headers.
Pure ASGI so it also guards requests that never reach a route."""
import json
import os
import time
from collections import defaultdict

MAX_BODY = int(os.getenv("MAX_BODY_BYTES", 256 * 1024))
TRUST_PROXY = os.getenv("TRUST_PROXY", "0") == "1"      # set to 1 behind Render's proxy
HTTPS = os.getenv("FORCE_HSTS", "0") == "1"

# requests per minute per client; the simulation endpoint is heavier, so it gets a tighter budget
LIMITS = {"/api/simulate": int(os.getenv("RATE_SIMULATE", 12)), "default": int(os.getenv("RATE_DEFAULT", 90))}

SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'"),
    (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), interest-cohort=()"),
    (b"cross-origin-resource-policy", b"cross-origin"),
    (b"cache-control", b"no-store"),
]


def client_ip(scope):
    """Behind a reverse proxy the real client is the right-most X-Forwarded-For entry the proxy appended;
    left-most entries are client-controlled and must not be trusted."""
    if TRUST_PROXY:
        for k, v in scope.get("headers", []):
            if k == b"x-forwarded-for":
                parts = [p.strip() for p in v.decode("latin-1").split(",") if p.strip()]
                if parts:
                    return parts[-1]
    client = scope.get("client")
    return client[0] if client else "unknown"


class BodyTooLarge(Exception):
    pass


class TokenBucket:
    def __init__(self):
        self.state = defaultdict(lambda: [0.0, 0.0])   # key -> [tokens, last_refill]

    def allow(self, key, per_minute):
        tokens, last = self.state[key]
        now = time.monotonic()
        if last == 0.0:
            tokens = per_minute
        tokens = min(per_minute, tokens + (now - last) * per_minute / 60.0) if last else tokens
        if tokens < 1:
            self.state[key] = [tokens, now]
            return False, int((1 - tokens) * 60 / per_minute) + 1
        self.state[key] = [tokens - 1, now]
        if len(self.state) > 50_000:                  # bound memory under abuse
            for k in list(self.state)[:10_000]:
                del self.state[k]
        return True, 0


async def _send_json(send, status, payload, extra=()):
    body = json.dumps(payload).encode()
    headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), *SECURITY_HEADERS, *extra]
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


class SecurityMiddleware:
    def __init__(self, app):
        self.app, self.bucket = app, TokenBucket()

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")

        # 1. rate limit (preflight OPTIONS requests are cheap and not counted)
        if scope.get("method") != "OPTIONS" and path.startswith("/api/"):
            limit = LIMITS.get(path, LIMITS["default"])
            ok, retry = self.bucket.allow((client_ip(scope), path if path in LIMITS else "*"), limit)
            if not ok:
                return await _send_json(send, 429, {"error": "Too many requests. Please slow down."}, [(b"retry-after", str(retry).encode())])

        # 2. body size: reject declared oversize bodies up front, and cut off streamed ones
        for k, v in scope.get("headers", []):
            if k == b"content-length" and v.isdigit() and int(v) > MAX_BODY:
                return await _send_json(send, 413, {"error": f"Request body too large (limit {MAX_BODY // 1024} KB)."})
        received = 0

        async def limited_receive():
            nonlocal received
            msg = await receive()
            if msg["type"] == "http.request":
                received += len(msg.get("body", b""))
                if received > MAX_BODY:
                    raise BodyTooLarge()
            return msg

        # 3. hardening headers on every response
        async def send_with_headers(msg):
            if msg["type"] == "http.response.start":
                names = {k.lower() for k, _ in msg.get("headers", [])}
                extra = [h for h in SECURITY_HEADERS if h[0] not in names]
                if HTTPS:
                    extra.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                msg["headers"] = list(msg.get("headers", [])) + extra
            await send(msg)

        try:
            await self.app(scope, limited_receive, send_with_headers)
        except BodyTooLarge:
            await _send_json(send, 413, {"error": f"Request body too large (limit {MAX_BODY // 1024} KB)."})

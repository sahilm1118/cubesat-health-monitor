FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv
COPY requirements.txt .
RUN pip install -r requirements.txt

# application code and the exported model files only (no training data, no secrets)
COPY app ./app
COPY models ./models

# run as an unprivileged user with a read-only view of the code
RUN useradd --create-home --uid 10001 api && chown -R root:root /srv && chmod -R a-w /srv
USER api

ENV PORT=8000
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\",\"8000\")}/api/health', timeout=4)"

# client IPs for rate limiting come from security.client_ip (right-most X-Forwarded-For when TRUST_PROXY=1),
# so uvicorn's own proxy-header rewriting stays off
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT} --no-proxy-headers --no-server-header --workers 1"]

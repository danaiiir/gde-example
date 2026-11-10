# ---------- Nova Assistant (Flask + Amazon Bedrock) ----------
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    # App settings (override with -e at `docker run`)
    AWS_REGION=us-east-1 \
    AWS_DEFAULT_REGION=us-east-1 \
    BEDROCK_MODEL_ID=global.anthropic.claude-opus-4-6-v1 \
    CHAT_DB_PATH=/data/chat.db \
    PORT=8000

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY app.py auth.py context.py db.py quota.py ./
COPY templates/ templates/
COPY static/ static/

# Run as an unprivileged user; /data holds the SQLite database (mount a volume here).
RUN useradd --create-home --uid 10001 appuser \
 && mkdir -p /data && chown appuser:appuser /data
USER appuser
VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/healthz', timeout=4)" || exit 1

# gthread workers keep long-lived streaming (SSE) responses from blocking each other.
CMD ["sh", "-c", "exec gunicorn app:app --bind 0.0.0.0:${PORT} --worker-class gthread --workers 2 --threads 8 --timeout 300 --access-logfile -"]

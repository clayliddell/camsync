FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app/server
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd -u 10001 -M camsync
COPY server/app.py server/wsgi.py ./
COPY index.html privacy.html update.html styles.css app.js core.js config.js sw.js manifest.webmanifest /app/
COPY icons /app/icons
ENV CAMSYNC_WEB_ROOT=/app
USER 10001:10001
EXPOSE 4180
# Do not enable access logs: OAuth callback URLs contain single-use credentials.
CMD ["gunicorn", "--bind", "0.0.0.0:4180", "--workers", "2", "--threads", "2", "--timeout", "90", "--no-control-socket", "wsgi:app"]

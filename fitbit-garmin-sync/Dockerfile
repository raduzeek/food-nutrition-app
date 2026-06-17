FROM python:3.11-slim

RUN groupadd -r appuser && useradd -r -g appuser -d /app -s /sbin/nologin appuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY sync.py scheduler.py ./

RUN mkdir -p /app/data && chown -R appuser:appuser /app

VOLUME /app/data

USER appuser

ENTRYPOINT ["python", "scheduler.py"]

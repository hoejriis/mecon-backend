# The facade and the driver of the interop run. Build context: the repository root.
FROM python:3.12-slim
WORKDIR /app
COPY reader-backend/requirements-dev.lock /tmp/requirements-dev.lock
RUN pip install --no-cache-dir --require-hashes -r /tmp/requirements-dev.lock
COPY contracts/ /app/contracts/
COPY reader-backend/src/ /app/reader-backend/src/
COPY reader-backend/tests/ /app/reader-backend/tests/
COPY reader-backend/interop/ /app/reader-backend/interop/
ENV PYTHONPATH=/app/reader-backend/src:/app/reader-backend/tests:/app/reader-backend/interop \
    PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "facade_app:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]

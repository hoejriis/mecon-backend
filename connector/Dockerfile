# syntax=docker/dockerfile:1
# Build from the repository root (the test stage also needs contracts/connector):
#   docker build -f connector/Dockerfile --target runtime -t mecon-connector .
#   docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7 ...
# Pure-Python dependencies only, so one recipe covers amd64, arm64 and a 32-bit Pi (armv7).
ARG PYTHON_IMAGE=python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df

FROM ${PYTHON_IMAGE} AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /src
COPY connector/requirements.lock ./
RUN pip install --require-hashes --no-deps --target /opt/site -r requirements.lock
COPY connector/pyproject.toml ./
COPY connector/src ./src
RUN pip install --no-deps --target /opt/site .

FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONPATH=/opt/site PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
COPY --from=build /opt/site /opt/site
# Unprivileged. The serial device is passed in with --device and a supplementary group
# that owns it (for example --group-add "$(stat -c %g /dev/ttyACM0)"); see connector/README.md.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin connector \
 && mkdir -p /etc/mecon-connector && chown root:root /etc/mecon-connector
USER 10001
EXPOSE 9464
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:9464/healthz', timeout=2).status == 200 else 1)"]
ENTRYPOINT ["python", "-m", "mecon_connector"]
CMD ["--config", "/etc/mecon-connector/config.toml"]

# Test image: the same code plus mosquitto, so the integration tests run exactly as in CI.
FROM ${PYTHON_IMAGE} AS test
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONDONTWRITEBYTECODE=1
RUN apt-get update && apt-get install -y --no-install-recommends mosquitto openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY connector/requirements-dev.lock ./
RUN pip install --require-hashes --no-deps -r requirements-dev.lock
COPY connector/pyproject.toml ./
COPY connector/src ./src
COPY connector/tests ./tests
COPY connector/scripts ./scripts
COPY connector/deploy ./deploy
COPY contracts/connector /contracts/connector
# mosquitto drops privileges when started as root and then cannot read the test directory.
RUN useradd --create-home tester
USER tester
CMD ["pytest", "-q"]

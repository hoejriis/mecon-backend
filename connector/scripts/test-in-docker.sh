#!/bin/sh
# Runs the whole connector test suite, integration tests included, in the same image shape CI uses.
# From the repository root:  sh connector/scripts/test-in-docker.sh
set -eu
docker build -f connector/Dockerfile --target test -t mecon-connector-test .
docker run --rm mecon-connector-test pytest -q -ra

#!/usr/bin/env sh
set -eu

BASE_URL="${1:-http://127.0.0.1:3000}"
SOURCE_COMMIT="$(git rev-parse --short=7 HEAD)"
export SOURCE_COMMIT

echo "Desplegando Conecta Digital CRM commit ${SOURCE_COMMIT}"
docker compose build app
docker compose up -d

node --env-file=.env scripts/production-smoke.mjs "${BASE_URL}"

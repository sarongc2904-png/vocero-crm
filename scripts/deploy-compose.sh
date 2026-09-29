#!/usr/bin/env sh
set -eu

BASE_URL="${1:-http://127.0.0.1:3000}"
SOURCE_COMMIT="$(git rev-parse --short=7 HEAD)"
export SOURCE_COMMIT

echo "Desplegando Conecta Digital CRM commit ${SOURCE_COMMIT}"
docker compose build app
docker compose up -d

if command -v node >/dev/null 2>&1; then
  node --env-file=.env scripts/production-smoke.mjs "${BASE_URL}"
else
  echo "Node no está instalado en el host; ejecutando smoke dentro del contenedor app"
  docker compose exec -T app node --input-type=module - "${BASE_URL}" < scripts/production-smoke.mjs
fi

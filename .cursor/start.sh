#!/usr/bin/env bash
# Cloud Agent start phase: per-boot service reconciliation.
# Starts Postgres + Redis, ensures the app role/database exist, and applies
# migrations. Idempotent and safe to re-run; returns once the stack is ready.
set -euo pipefail

cd "$(dirname "$0")/.."

# --- Postgres ---------------------------------------------------------------
PG_VER="$(ls /etc/postgresql 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "${PG_VER:-}" ]; then
  if ! sudo pg_lsclusters -h 2>/dev/null | awk '{print $4}' | grep -q online; then
    sudo pg_ctlcluster "$PG_VER" main start || true
  fi
  for _ in $(seq 1 30); do
    if sudo -u postgres pg_isready -q; then break; fi
    sleep 1
  done

  # App role + database (idempotent).
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='eventgate'" | grep -q 1 \
    || sudo -u postgres psql -c "CREATE ROLE eventgate LOGIN PASSWORD 'eventgate';"
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='eventgate'" | grep -q 1 \
    || sudo -u postgres createdb -O eventgate eventgate
fi

# --- Redis ------------------------------------------------------------------
if ! redis-cli ping >/dev/null 2>&1; then
  sudo redis-server /etc/redis/redis.conf --daemonize yes || true
fi

# --- App env + migrations ---------------------------------------------------
[ -f .env ] || cp .env.example .env

# Load .env so migrations use the configured DATABASE_URL.
set -a
# shellcheck disable=SC1091
. ./.env
set +a

npm run migrate

echo "[cloud-start] stack ready (postgres + redis + migrations)"

#!/usr/bin/env bash
# Cloud Agent install phase: idempotent dependency refresh.
# Runs after the repository is checked out. System packages are installed here
# only when missing (e.g. a snapshot/base image already has them).
set -euo pipefail

cd "$(dirname "$0")/.."

# System services the full dev stack expects (Postgres + Redis). The app also
# runs in a degraded seed/memory mode without them, but the documented local
# workflow (migrations, persistent sessions) needs both. Skipped when already
# present so builds that boot from a snapshot stay fast.
if ! command -v pg_ctlcluster >/dev/null 2>&1 || ! command -v redis-server >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    postgresql postgresql-contrib redis-server
fi

# Node workspace dependencies (root + client + server) from the lockfile.
npm ci

# Local environment file. Never overwrite an existing one.
if [ ! -f .env ]; then
  cp .env.example .env
fi

echo "[cloud-install] done"

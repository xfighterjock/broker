#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH="${1:-${DEPLOY_PATH:-/opt/broker}}"
echo "[event-gate] setup for $DEPLOY_PATH"

if [ ! -d "$DEPLOY_PATH" ]; then
  echo "[event-gate] $DEPLOY_PATH does not exist. Clone or copy the repo there first."
  exit 1
fi

as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

pg_exec() {
  # Run SQL as the postgres superuser when possible.
  if [ "$(id -u)" -eq 0 ] && id postgres >/dev/null 2>&1; then
    su -s /bin/bash postgres -c "psql -v ON_ERROR_STOP=1 -c \"$1\""
  elif command -v sudo >/dev/null 2>&1 && id postgres >/dev/null 2>&1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -c "$1"
  else
    psql -v ON_ERROR_STOP=1 -c "$1"
  fi
}

echo "[event-gate] creating postgres role/db eventgate (idempotent)"
if command -v psql >/dev/null 2>&1; then
  pg_exec "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eventgate') THEN CREATE ROLE eventgate LOGIN PASSWORD 'eventgate'; END IF; END $$;"
  EXISTS=$(pg_exec "SELECT 1 FROM pg_database WHERE datname = 'eventgate'" | tr -d '[:space:]' || true)
  if ! pg_exec "SELECT 1 FROM pg_database WHERE datname='eventgate'" | grep -q 1; then
    if [ "$(id -u)" -eq 0 ] && id postgres >/dev/null 2>&1; then
      su -s /bin/bash postgres -c "createdb -O eventgate eventgate"
    elif id postgres >/dev/null 2>&1; then
      sudo -u postgres createdb -O eventgate eventgate
    else
      createdb -O eventgate eventgate
    fi
  else
    echo "[event-gate] database eventgate already exists"
  fi
else
  echo "[event-gate] psql not found. Install postgresql, then create role/db eventgate."
  exit 1
fi

echo "[event-gate] checking redis"
if command -v redis-cli >/dev/null 2>&1; then
  if redis-cli ping | grep -q PONG; then
    echo "[event-gate] redis PONG"
  else
    echo "[event-gate] redis-cli present but ping failed. Start redis-server."
    exit 1
  fi
else
  echo "[event-gate] redis-cli not found. Install and start redis."
  exit 1
fi

NGINX_SRC="$DEPLOY_PATH/deploy/nginx/event-gate.conf"
if [ -f "$NGINX_SRC" ] && [ -d /etc/nginx ]; then
  echo "[event-gate] installing nginx site"
  as_root mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled
  as_root cp "$NGINX_SRC" /etc/nginx/sites-available/event-gate.conf
  as_root ln -sfn /etc/nginx/sites-available/event-gate.conf /etc/nginx/sites-enabled/event-gate.conf
  if [ -L /etc/nginx/sites-enabled/default ] || [ -f /etc/nginx/sites-enabled/default ]; then
    as_root rm -f /etc/nginx/sites-enabled/default
  fi
  if command -v nginx >/dev/null 2>&1; then
    as_root nginx -t
  fi
else
  echo "[event-gate] skip nginx copy (missing $NGINX_SRC or /etc/nginx)"
fi

UNIT_SRC="$DEPLOY_PATH/deploy/systemd/event-gate.service"
if [ -f "$UNIT_SRC" ] && [ -d /etc/systemd/system ]; then
  echo "[event-gate] installing systemd unit"
  if ! id eventgate >/dev/null 2>&1; then
    as_root useradd --system --home "$DEPLOY_PATH" --shell /usr/sbin/nologin eventgate || true
  fi
  as_root cp "$UNIT_SRC" /etc/systemd/system/event-gate.service
  as_root systemctl daemon-reload
  as_root systemctl enable event-gate.service
  echo "[event-gate] systemd enabled. Next: deploy/deploy.sh"
else
  echo "[event-gate] skip systemd (missing unit or /etc/systemd/system)"
fi

if [ ! -f "$DEPLOY_PATH/.env" ] && [ -f "$DEPLOY_PATH/.env.example" ]; then
  cp "$DEPLOY_PATH/.env.example" "$DEPLOY_PATH/.env"
  echo "[event-gate] wrote $DEPLOY_PATH/.env from .env.example — set GATE_PASSWORD and NODE_ENV=production"
fi

echo "[event-gate] setup complete"

#!/usr/bin/env bash
set -euo pipefail
DEPLOY_PATH="${DEPLOY_PATH:-/opt/broker}"
cd "$DEPLOY_PATH"
echo "[event-gate] deploying in $DEPLOY_PATH"

if [ -d .git ]; then
  if [ -n "$(git status --porcelain)" ]; then
    echo "[event-gate] working tree dirty — skipping git pull"
  else
    if git remote get-url origin >/dev/null 2>&1; then
      git pull --ff-only
    else
      echo "[event-gate] no git remote — skipping pull"
    fi
  fi
fi

npm ci
npm run build
npm run migrate

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl restart event-gate
else
  echo "[event-gate] systemctl not found — restart the node process yourself"
fi

if command -v nginx >/dev/null 2>&1; then
  sudo nginx -t
  sudo nginx -s reload
else
  echo "[event-gate] nginx not found — skip reload"
fi

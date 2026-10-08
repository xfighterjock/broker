#!/usr/bin/env bash
# Copy a built Event Gate tree to the VPS and restart systemd event-gate.
# Used by .github/workflows/deploy.yml and by the manual Mac fallback in docs/DEPLOY.md.
# Host, user, port, key, and known_hosts come from the environment. Never hardcode them.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/cash-session.sh"

file_md5() {
  local file="$1"
  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$file" | awk '{print $1}'
    return
  fi
  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$file"
    return
  fi
  echo "::error title=Missing md5::Neither md5sum nor md5 is available to hash the local server bundle." >&2
  return 1
}

if [ -z "${DEPLOY_SSH_KEY:-}" ]; then
  echo "::notice title=Deploy skipped::DEPLOY_SSH_KEY is unset. Skipping VPS deploy. CI already passed. One-time setup is docs/DEPLOY.md (deploy user, ed25519 key, GitHub Actions secrets). This job stays green until those secrets exist."
  exit 0
fi

missing=()
[ -z "${DEPLOY_HOST:-}" ] && missing+=(DEPLOY_HOST)
[ -z "${DEPLOY_USER:-}" ] && missing+=(DEPLOY_USER)
[ -z "${DEPLOY_KNOWN_HOSTS:-}" ] && missing+=(DEPLOY_KNOWN_HOSTS)
if [ "${#missing[@]}" -gt 0 ]; then
  echo "::error title=Deploy secrets incomplete::DEPLOY_SSH_KEY is set but missing: ${missing[*]}. Add them under GitHub Actions secrets. See docs/DEPLOY.md."
  exit 1
fi

case "${SKIP_RESTART:-false}" in
  true | false) ;;
  *)
    echo "::error title=Bad SKIP_RESTART::SKIP_RESTART must be true or false."
    exit 1
    ;;
esac

PORT="${DEPLOY_PORT:-22}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo "::error title=Bad DEPLOY_PORT::DEPLOY_PORT must be a TCP port. Omit the secret to use 22."
  exit 1
fi
port_num=$((10#$PORT))
if [ "$port_num" -lt 1 ] || [ "$port_num" -gt 65535 ]; then
  echo "::error title=Bad DEPLOY_PORT::DEPLOY_PORT must be between 1 and 65535."
  exit 1
fi
PORT="$port_num"

for f in dist/server.js dist/server.js.map dist/package.json client/dist/index.html; do
  if [ ! -f "$f" ]; then
    echo "::error title=Build artifact missing::${f} is not in the workspace. Build with npm run build -w @broker/server and npm run build -w @broker/client."
    exit 1
  fi
done
if ! grep -q '"type":"commonjs"' dist/package.json; then
  echo "::error title=Bad dist/package.json::The server bundle must ship dist/package.json with {\"type\":\"commonjs\"} so Node loads the CJS build under the repo type module."
  exit 1
fi

# Server rsync list is dist/server.js, dist/server.js.map, and dist/package.json.
# The standalone migrate bundle is omitted: systemd runs dist/server.js, and that
# process applies SQL from /opt/broker/db/migrations on startup. Nothing on the
# unit invokes a separate migrate program.
if ! command -v ssh >/dev/null 2>&1 || ! command -v rsync >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y rsync openssh-client
  fi
fi
for cmd in ssh rsync; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "::error title=Missing tool::${cmd} is required to copy artifacts to the VPS."
    exit 1
  fi
done

log_cash_session

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
keyfile="$tmp/id_ed25519"
known="$tmp/known_hosts"
printf '%s\n' "$DEPLOY_SSH_KEY" | tr -d '\r' > "$keyfile"
chmod 600 "$keyfile"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" | tr -d '\r' > "$known"
chmod 600 "$known"

if ! grep -q "PRIVATE KEY" "$keyfile"; then
  echo "::error title=Bad DEPLOY_SSH_KEY::DEPLOY_SSH_KEY does not contain a PRIVATE KEY header. Paste the whole key file, including the BEGIN and END lines."
  exit 1
fi

cat > "$tmp/sshwrap" << 'EOF'
#!/usr/bin/env bash
exec ssh \
  -i "$DEPLOY_KEY_FILE" \
  -p "$DEPLOY_PORT" \
  -F /dev/null \
  -o IdentitiesOnly=yes \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=yes \
  -o GlobalKnownHostsFile=/dev/null \
  -o "UserKnownHostsFile=${DEPLOY_KNOWN_HOSTS_FILE}" \
  -o ConnectTimeout=20 \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=4 \
  "$@"
EOF
chmod 700 "$tmp/sshwrap"
export DEPLOY_KEY_FILE="$keyfile"
export DEPLOY_PORT="$PORT"
export DEPLOY_KNOWN_HOSTS_FILE="$known"

remote="${DEPLOY_USER}@${DEPLOY_HOST}"

echo "Checking remote dist directories"
if ! "$tmp/sshwrap" "$remote" 'test -d /opt/broker/dist && test -w /opt/broker/dist && test -d /opt/broker/client/dist && test -w /opt/broker/client/dist'; then
  echo "::error title=Remote directories not writable::/opt/broker/dist and /opt/broker/client/dist must exist and be writable by the deploy user. See docs/DEPLOY.md."
  exit 1
fi

chmod 644 dist/server.js dist/server.js.map dist/package.json
find client/dist -type d -exec chmod 755 {} +
find client/dist -type f -exec chmod 644 {} +

# Archive mode, no delete flag. Owner and group are not preserved: the deploy
# user is not root, and preserving them makes rsync exit 23.
echo "Rsync server bundle to /opt/broker/dist/"
if ! rsync -a --no-owner --no-group -e "$tmp/sshwrap" \
  dist/server.js dist/server.js.map dist/package.json \
  "${remote}:/opt/broker/dist/"; then
  echo "::error title=Server rsync failed::Copy of the server bundle to /opt/broker/dist/ failed."
  exit 1
fi

echo "Rsync client/dist/ to /opt/broker/client/dist/"
if ! rsync -a --no-owner --no-group -e "$tmp/sshwrap" \
  client/dist/ \
  "${remote}:/opt/broker/client/dist/"; then
  echo "::error title=Client rsync failed::Copy of client/dist/ to /opt/broker/client/dist/ failed."
  exit 1
fi

if [ "${SKIP_RESTART:-false}" = "true" ]; then
  echo "::notice title=Restart skipped::skip_restart is set. Files were copied. systemctl restart event-gate was not run. The running process keeps the previous bundle until the next restart."
else
  echo "Restarting event-gate"
  "$tmp/sshwrap" "$remote" sudo -n /usr/bin/systemctl restart event-gate
  sleep 3
fi

echo "Checking systemctl is-active event-gate"
state="$("$tmp/sshwrap" "$remote" sudo -n /usr/bin/systemctl is-active event-gate || true)"
state="$(printf '%s' "$state" | tr -d '[:space:]')"
if [ "$state" != "active" ]; then
  echo "::error title=event-gate not active::sudo systemctl is-active event-gate returned: ${state:-empty}"
  "$tmp/sshwrap" "$remote" systemctl status event-gate --no-pager -l --lines=40 || true
  exit 1
fi
echo "event-gate is active"

local_md5="$(file_md5 dist/server.js)"
remote_line="$("$tmp/sshwrap" "$remote" md5sum /opt/broker/dist/server.js)"
remote_md5="$(printf '%s\n' "$remote_line" | awk '{print $1}')"
if [ -z "$local_md5" ] || [ "$local_md5" != "$remote_md5" ]; then
  echo "::error title=server.js md5 mismatch::local ${local_md5:-empty} remote ${remote_md5:-empty}"
  exit 1
fi
echo "md5 ok ${local_md5}"

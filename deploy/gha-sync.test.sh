#!/usr/bin/env bash
# Checks for the deploy script that do not open an SSH connection.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASH="$ROOT/deploy/cash-session.sh"
SYNC="$ROOT/deploy/gha-sync.sh"
WF="$ROOT/.github/workflows/deploy.yml"

fail() {
  echo "deploy check failed: $*" >&2
  exit 1
}

[ -f "$CASH" ] || fail "missing cash-session.sh"
[ -f "$SYNC" ] || fail "missing gha-sync.sh"
[ -f "$WF" ] || fail "missing workflow"

bash -n "$CASH"
bash -n "$SYNC"

fake="$(mktemp -d)"
trap 'rm -rf "$fake"' EXIT
cat > "$fake/date" << 'EOF'
#!/usr/bin/env bash
if [ -z "${FAKE_ET_STAMP:-}" ]; then
  echo "FAKE_ET_STAMP unset" >&2
  exit 1
fi
printf '%s\n' "$FAKE_ET_STAMP"
EOF
chmod 755 "$fake/date"

assert_kind() {
  local stamp="$1" expect="$2" kind
  kind="$(
    FAKE_ET_STAMP="$stamp" PATH="$fake:$PATH" bash -c '
      source "$1"
      cash_session_read
      printf "%s" "$CASH_SESSION_KIND"
    ' _ "$CASH"
  )"
  [ "$kind" = "$expect" ] || fail "stamp [$stamp] expected $expect got $kind"
}

assert_log() {
  local stamp="$1" needle="$2" out
  out="$(
    FAKE_ET_STAMP="$stamp" PATH="$fake:$PATH" bash -c '
      source "$1"
      log_cash_session
    ' _ "$CASH"
  )"
  case "$out" in
    *"$needle"*) ;;
    *) fail "log for [$stamp] missing [$needle]" ;;
  esac
}

# Weekday 09:30 inclusive, 16:00 exclusive. Weekends are outside.
assert_kind "1 0929 Monday 2026-10-12 09:29 EDT" out
assert_kind "1 0930 Monday 2026-10-12 09:30 EDT" in
assert_kind "4 1200 Thursday 2026-10-08 12:00 EDT" in
assert_kind "5 1559 Friday 2026-10-09 15:59 EDT" in
assert_kind "5 1600 Friday 2026-10-09 16:00 EDT" out
assert_kind "6 1200 Saturday 2026-10-10 12:00 EDT" out
assert_kind "7 1000 Sunday 2026-10-11 10:00 EDT" out
assert_log "4 1200 Thursday 2026-10-08 12:00 EDT" "Deploy is proceeding during the market cash session"
assert_log "6 1200 Saturday 2026-10-10 12:00 EDT" "Outside the US cash session"

run_sync() {
  (
    cd /tmp
    unset DEPLOY_SSH_KEY DEPLOY_HOST DEPLOY_USER DEPLOY_KNOWN_HOSTS DEPLOY_PORT SKIP_RESTART
    env "$@" bash "$SYNC"
  )
}

out="$(run_sync 2>&1)" || fail "unset DEPLOY_SSH_KEY should exit 0"
case "$out" in
  *"::notice title=Deploy skipped::"*"DEPLOY_SSH_KEY is unset"*) ;;
  *) fail "missing skip notice" ;;
esac

set +e
out="$(
  run_sync \
    DEPLOY_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----" \
    DEPLOY_HOST="example.invalid" \
    DEPLOY_USER="deploy" \
    DEPLOY_KNOWN_HOSTS="example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake" \
    SKIP_RESTART="maybe" \
    2>&1
)"
code=$?
set -e
[ "$code" -eq 1 ] || fail "bad SKIP_RESTART should exit 1, got $code"
case "$out" in
  *"SKIP_RESTART"*) ;;
  *) fail "bad SKIP_RESTART should be named in the error" ;;
esac

set +e
out="$(run_sync DEPLOY_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----" 2>&1)"
code=$?
set -e
[ "$code" -eq 1 ] || fail "partial secrets should exit 1, got $code"
case "$out" in
  *"DEPLOY_HOST"*) ;;
  *) fail "partial secrets should name DEPLOY_HOST" ;;
esac

set +e
out="$(
  run_sync \
    DEPLOY_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----" \
    DEPLOY_HOST="example.invalid" \
    DEPLOY_USER="deploy" \
    DEPLOY_KNOWN_HOSTS="example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake" \
    DEPLOY_PORT="nope" \
    2>&1
)"
code=$?
set -e
[ "$code" -eq 1 ] || fail "bad port should exit 1, got $code"
case "$out" in
  *"DEPLOY_PORT"*) ;;
  *) fail "bad port should mention DEPLOY_PORT" ;;
esac

set +e
out="$(
  run_sync \
    DEPLOY_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----" \
    DEPLOY_HOST="example.invalid" \
    DEPLOY_USER="deploy" \
    DEPLOY_KNOWN_HOSTS="example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake" \
    DEPLOY_PORT="22" \
    2>&1
)"
code=$?
set -e
[ "$code" -eq 1 ] || fail "missing build should exit 1, got $code"
case "$out" in
  *"Build artifact missing"*) ;;
  *) fail "missing build should name the artifact" ;;
esac
case "$out" in
  *"Rsync server bundle"*) fail "missing build must not start rsync" ;;
esac

if grep -n -- '--delete' "$SYNC" "$WF"; then
  fail "rsync must not use --delete"
fi
if grep -n 'server1.logikmancer.com' "$SYNC" "$WF" "$CASH"; then
  fail "host must not be hardcoded in the workflow or sync script"
fi
if grep -n 'migrate\.js' "$SYNC" "$WF"; then
  fail "do not rsync the standalone migrate bundle"
fi
if ! grep -q 'dist/server.js dist/server.js.map dist/package.json' "$SYNC"; then
  fail "server rsync file list drifted"
fi
if ! grep -q 'client/dist/' "$SYNC"; then
  fail "client rsync path drifted"
fi
if ! grep -q 'sudo -n /usr/bin/systemctl restart event-gate' "$SYNC"; then
  fail "restart command drifted"
fi
if ! grep -q 'sudo -n /usr/bin/systemctl is-active event-gate' "$SYNC"; then
  fail "is-active command drifted"
fi
if ! grep -q 'npm test' "$WF"; then
  fail "workflow must run npm test"
fi
if ! grep -q 'typecheck:server' "$WF" || ! grep -q 'typecheck:client' "$WF"; then
  fail "workflow must typecheck server and client"
fi
if ! grep -q 'npm run build -w @broker/server' "$WF"; then
  fail "workflow must build the server workspace"
fi
if ! grep -q 'npm run build -w @broker/client' "$WF"; then
  fail "workflow must build the client workspace"
fi
if ! grep -q 'event-gate-vps-deploy' "$WF"; then
  fail "workflow must use a concurrency group"
fi
if ! grep -q 'cancel-in-progress: false' "$WF"; then
  fail "deploys must queue, not cancel"
fi
if ! grep -q 'secrets.DEPLOY_SSH_KEY' "$WF"; then
  fail "workflow must read DEPLOY_SSH_KEY from secrets"
fi
if ! grep -q 'secrets.DEPLOY_HOST' "$WF"; then
  fail "workflow must read DEPLOY_HOST from secrets"
fi
if ! grep -q 'secrets.DEPLOY_USER' "$WF"; then
  fail "workflow must read DEPLOY_USER from secrets"
fi
if ! grep -q 'secrets.DEPLOY_KNOWN_HOSTS' "$WF"; then
  fail "workflow must read DEPLOY_KNOWN_HOSTS from secrets"
fi
if ! grep -q 'secrets.DEPLOY_PORT' "$WF"; then
  fail "workflow must read optional DEPLOY_PORT from secrets"
fi
if ! grep -q 'skip_restart' "$WF"; then
  fail "workflow_dispatch must offer skip_restart"
fi

echo "deploy checks ok"

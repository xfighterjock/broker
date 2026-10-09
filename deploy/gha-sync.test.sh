#!/usr/bin/env bash
# Checks for the deploy script. The copy exercise uses a fake ssh and rsync on PATH and does not open a connection.
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
artifact_backup=""
extra_note=""
bin=""
vps=""
cleanup() {
  rm -rf "$fake"
  if [ -n "$bin" ]; then
    rm -rf "$bin"
  fi
  if [ -n "$vps" ]; then
    rm -rf "$vps"
  fi
  if [ -n "$extra_note" ]; then
    rm -f "$extra_note"
  fi
  if [ -n "$artifact_backup" ] && [ -d "$artifact_backup" ]; then
    local rel
    if [ -f "$artifact_backup/created" ]; then
      while IFS= read -r rel; do
        rm -f "$ROOT/$rel"
      done < "$artifact_backup/created"
    fi
    if [ -f "$artifact_backup/existed" ]; then
      while IFS= read -r rel; do
        cp -a "$artifact_backup/$rel" "$ROOT/$rel"
      done < "$artifact_backup/existed"
    fi
    rmdir "$ROOT/client/dist" "$ROOT/dist" 2>/dev/null || true
    rm -rf "$artifact_backup"
    artifact_backup=""
  fi
}
trap cleanup EXIT
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
if ! grep -q 'node-version: "24"' "$WF"; then
  fail "workflow must stay on Node 24"
fi
if ! grep -q 'actions/checkout@v7' "$WF" || ! grep -q 'actions/setup-node@v7' "$WF"; then
  fail "workflow must keep the Node 24 actions"
fi
if ! grep -q 'db/migrations/\*\.sql' "$SYNC"; then
  fail "sync must copy db/migrations/*.sql"
fi
if ! grep -q '/opt/broker/db/migrations/' "$SYNC"; then
  fail "sync must target /opt/broker/db/migrations/"
fi
if ! grep -q -- '--chmod=F644,D755' "$SYNC"; then
  fail "migration rsync must set mode with --chmod=F644,D755"
fi
if ! grep -q -- '--no-owner --no-group' "$SYNC"; then
  fail "rsync must not preserve owner or group"
fi
if ! grep -q 'ls -1 /opt/broker/db/migrations' "$SYNC"; then
  fail "sync must verify migration filenames with ls"
fi
if ! grep -q 'log_cash_session' "$SYNC"; then
  fail "sync must keep the cash-session guard"
fi
if ! grep -q 'DEPLOY_SSH_KEY is unset' "$SYNC"; then
  fail "unset DEPLOY_SSH_KEY must still skip"
fi

line_of() {
  grep -n "$1" "$SYNC" | head -1 | cut -d: -f1
}
mig_rsync="$(line_of 'Rsync db/migrations')"
mig_ls="$(line_of 'ls -1 /opt/broker/db/migrations')"
restart="$(line_of 'sudo -n /usr/bin/systemctl restart event-gate')"
[ -n "$mig_rsync" ] && [ -n "$mig_ls" ] && [ -n "$restart" ] || fail "missing migration or restart markers"
[ "$mig_rsync" -lt "$mig_ls" ] || fail "ls verify must follow the migration rsync"
[ "$mig_ls" -lt "$restart" ] || fail "migration verify must finish before systemctl restart"

deploy_doc="$ROOT/docs/DEPLOY.md"
design="$ROOT/docs/DESIGN.md"
if grep -n 'does not upload' "$deploy_doc"; then
  fail "DEPLOY.md must not say migrations are not uploaded"
fi
if ! grep -q 'setfacl -R -m u:deploy:rwX /opt/broker/db/migrations' "$deploy_doc"; then
  fail "DEPLOY.md must document the migrations ACL"
fi
if ! grep -q 'setfacl -R -d -m u:deploy:rwX /opt/broker/db/migrations' "$deploy_doc"; then
  fail "DEPLOY.md must document the default migrations ACL"
fi
if ! grep -q 'chown deploy:eventgate /opt/broker/db/migrations/\*\.sql' "$deploy_doc"; then
  fail "DEPLOY.md must note that chown of existing migration files may be needed"
fi
if ! grep -q '/opt/broker/db/migrations/' "$design"; then
  fail "DESIGN.md deploy line must name the migrations destination"
fi
if grep -n 'from the VPS checkout' "$design"; then
  fail "DESIGN.md must not say boot applies migrations only from the VPS checkout"
fi

# Fake ssh/rsync: copy this repo's SQL, keep a pre-existing remote file, fail when a name is missing.
prepare_artifacts() {
  artifact_backup="$(mktemp -d)"
  local rel
  for rel in dist/server.js dist/server.js.map dist/package.json client/dist/index.html; do
    mkdir -p "$artifact_backup/$(dirname "$rel")"
    if [ -e "$ROOT/$rel" ]; then
      cp -a "$ROOT/$rel" "$artifact_backup/$rel"
      printf '%s\n' "$rel" >> "$artifact_backup/existed"
    else
      printf '%s\n' "$rel" >> "$artifact_backup/created"
    fi
  done
  mkdir -p "$ROOT/dist" "$ROOT/client/dist"
  printf 'server-bundle\n' > "$ROOT/dist/server.js"
  printf '\n' > "$ROOT/dist/server.js.map"
  printf '%s\n' '{"type":"commonjs"}' > "$ROOT/dist/package.json"
  printf '<html></html>\n' > "$ROOT/client/dist/index.html"
}

extra_note="$ROOT/db/migrations/notes.txt"
printf 'not sql\n' > "$extra_note"

bin="$(mktemp -d)"
cat > "$bin/ssh" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
host=""
cmd=()
for arg in "$@"; do
  if [ -n "$host" ]; then
    cmd+=("$arg")
    continue
  fi
  case "$arg" in
    *@*) host="$arg" ;;
  esac
done
if [ "${#cmd[@]}" -eq 0 ]; then
  echo "ssh fake: no remote command" >&2
  exit 1
fi
remote="${cmd[*]}"
printf '%s\n' "$remote" >> "$FAKE_VPS/ssh.log"
case "$remote" in
  "sudo -n /usr/bin/systemctl restart event-gate")
    exit 0
    ;;
  "sudo -n /usr/bin/systemctl is-active event-gate")
    printf 'active\n'
    exit 0
    ;;
  "systemctl status event-gate"*)
    printf 'inactive\n'
    exit 0
    ;;
esac
fake_root="$FAKE_VPS/opt/broker"
translated="${remote//\/opt\/broker/$fake_root}"
bash -c "$translated"
EOF
cat > "$bin/rsync" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do
  if [ "$arg" = "--delete" ]; then
    echo "refusing --delete" >&2
    exit 1
  fi
done
sources=()
skip_next=0
for arg in "$@"; do
  if [ "$skip_next" -eq 1 ]; then
    skip_next=0
    continue
  fi
  case "$arg" in
    -e|--rsh)
      skip_next=1
      continue
      ;;
    -*)
      continue
      ;;
  esac
  sources+=("$arg")
done
if [ "${#sources[@]}" -lt 2 ]; then
  echo "rsync fake: expected sources and dest" >&2
  exit 1
fi
last=$((${#sources[@]} - 1))
dest="${sources[$last]}"
sources=("${sources[@]:0:last}")
printf '%s\n' "$*" >> "$FAKE_VPS/rsync.log"
remote_path="${dest#*:}"
local_dest="$FAKE_VPS$remote_path"
mkdir -p "$local_dest"
if [ "${FAKE_RSYNC_DROP_SQL:-0}" = "1" ] && [[ "$remote_path" == *"/db/migrations"* ]]; then
  exit 0
fi
for src in "${sources[@]}"; do
  if [ -d "$src" ]; then
    cp -a "$src"/. "$local_dest/"
  else
    cp -a "$src" "$local_dest/"
  fi
done
find "$local_dest" -type d -exec chmod 755 {} +
find "$local_dest" -type f -exec chmod 644 {} +
EOF
chmod 755 "$bin/ssh" "$bin/rsync"

prepare_artifacts
vps="$(mktemp -d)"
mkdir -p "$vps/opt/broker/dist" "$vps/opt/broker/client/dist" "$vps/opt/broker/db/migrations"
printf 'keep\n' > "$vps/opt/broker/db/migrations/000_keep.sql"
chmod 755 "$vps/opt/broker/dist" "$vps/opt/broker/client/dist" "$vps/opt/broker/db/migrations"

run_fake() {
  (
    cd /tmp
    unset DEPLOY_SSH_KEY DEPLOY_HOST DEPLOY_USER DEPLOY_KNOWN_HOSTS DEPLOY_PORT SKIP_RESTART FAKE_RSYNC_DROP_SQL
    env PATH="$bin:$PATH" FAKE_VPS="$vps" "$@" bash "$SYNC"
  )
}

out="$(run_fake \
  DEPLOY_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----" \
  DEPLOY_HOST="example.invalid" \
  DEPLOY_USER="deploy" \
  DEPLOY_KNOWN_HOSTS="example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake" \
  DEPLOY_PORT="22" \
  2>&1)" || fail "fake deploy should exit 0"
case "$out" in
  *"migrations ok"*) ;;
  *) fail "fake deploy should report migrations ok" ;;
esac
case "$out" in
  *"event-gate is active"*) ;;
  *) fail "fake deploy should report event-gate active" ;;
esac
sql_count=0
for f in "$ROOT"/db/migrations/*.sql; do
  base="$(basename "$f")"
  [ -f "$vps/opt/broker/db/migrations/$base" ] || fail "fake VPS missing $base"
  mode="$(stat -c %a "$vps/opt/broker/db/migrations/$base")"
  [ "$mode" = "644" ] || fail "$base mode $mode, want 644"
  sql_count=$((sql_count + 1))
done
[ "$sql_count" -ge 1 ] || fail "repo has no migration sql"
[ -f "$vps/opt/broker/db/migrations/000_keep.sql" ] || fail "pre-existing SQL must stay on the VPS"
[ ! -f "$vps/opt/broker/db/migrations/notes.txt" ] || fail "non-sql must not be copied"
grep -q -- '--chmod=F644,D755' "$vps/rsync.log" || fail "migration rsync did not pass --chmod=F644,D755"
grep -q -- '--no-owner --no-group' "$vps/rsync.log" || fail "rsync did not pass --no-owner --no-group"
if grep -q -- '--delete' "$vps/rsync.log"; then
  fail "rsync log contains --delete"
fi
ls_line="$(grep -n 'ls -1 /opt/broker/db/migrations' "$vps/ssh.log" | head -1 | cut -d: -f1)"
restart_line="$(grep -n 'sudo -n /usr/bin/systemctl restart event-gate' "$vps/ssh.log" | head -1 | cut -d: -f1)"
[ -n "$ls_line" ] && [ -n "$restart_line" ] || fail "ssh log missing ls or restart"
[ "$ls_line" -lt "$restart_line" ] || fail "ssh ls must run before restart"

rm -rf "$vps"
vps="$(mktemp -d)"
mkdir -p "$vps/opt/broker/dist" "$vps/opt/broker/client/dist" "$vps/opt/broker/db/migrations"
chmod 755 "$vps/opt/broker/dist" "$vps/opt/broker/client/dist" "$vps/opt/broker/db/migrations"
set +e
out="$(run_fake \
  FAKE_RSYNC_DROP_SQL="1" \
  DEPLOY_SSH_KEY="-----BEGIN OPENSSH PRIVATE KEY-----" \
  DEPLOY_HOST="example.invalid" \
  DEPLOY_USER="deploy" \
  DEPLOY_KNOWN_HOSTS="example.invalid ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake" \
  DEPLOY_PORT="22" \
  2>&1)"
code=$?
set -e
[ "$code" -eq 1 ] || fail "missing remote SQL should exit 1, got $code"
case "$out" in
  *"Migration missing on VPS"*) ;;
  *) fail "missing remote SQL should fail loudly" ;;
esac
case "$out" in
  *"Restarting event-gate"*) fail "must not restart when a migration file is missing" ;;
esac

echo "deploy checks ok"

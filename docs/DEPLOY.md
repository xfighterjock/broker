# Event Gate deploy

GitHub Actions (GHA) is the deploy path. A push to `master` builds, runs CI, rsyncs the artifacts to the VPS, and restarts `event-gate`. `workflow_dispatch` runs the same job on the branch you pick.

The public site is `https://broker.logikmancer.com`. The SSH host is `server1.logikmancer.com`. The workflow does not contain that host, the user, the port, or the key. Those live in GitHub Actions secrets.

Paper and mock trading are unchanged. This path does not place E*TRADE or Tradovate orders.

## What a deploy does

The workflow file is `.github/workflows/deploy.yml`. Two jobs, and the second starts only after the first succeeds:

1. CI: `npm ci`, `npm run typecheck:server`, `npm run typecheck:client`, `npm test`. A failing test or typecheck does not deploy.
2. Build on Node 24: `npm ci`, `npm run build -w @broker/server`, `npm run build -w @broker/client`.
3. Rsync the server bundle to `/opt/broker/dist/` (no delete flag): `dist/server.js`, `dist/server.js.map`, and `dist/package.json`.
4. `rsync -a` of `client/dist/` to `/opt/broker/client/dist/` (no delete flag). `--no-owner --no-group` is set because the deploy user is not root; preserving owner makes rsync exit 23. Modes are 755 for directories and 644 for files so `eventgate` and nginx can read them.
5. `sudo -n /usr/bin/systemctl restart event-gate`, then a 3 second pause.
6. Fail the job unless `sudo -n /usr/bin/systemctl is-active event-gate` prints `active`, and unless `md5sum /opt/broker/dist/server.js` on the VPS matches the built file.

A second deploy waits. The concurrency group is `event-gate-vps-deploy` with `cancel-in-progress: false`, so two rsyncs never run at once.

`workflow_dispatch` has an input, **Skip systemctl restart**. Checked, the job still rsyncs and still fails unless the unit is already active and the md5 matches. The process keeps the previous bundle until a later restart. Pushes to `master` always restart.

A deploy during the market cash session (weekdays 09:30–16:00 America/New_York) still runs. The log emits a warning with the ET clock. That window is the clock only. It is not the NYSE holiday or early-close calendar. Outside that window the log says so. Neither case fails the job.

If `DEPLOY_SSH_KEY` is unset, the deploy step prints a notice and exits 0. The workflow stays green. CI still runs. Merging before the one-time setup below does not break `master`.

## What this deploy does not do

- It does not copy `dist/migrate.js`. The server build does emit that file (`server/build.mjs`). Nothing needs it on the VPS. systemd `event-gate` runs `node dist/server.js` with WorkingDirectory `/opt/broker`, and `server/src/index.ts` calls `runMigrations` on startup. Schema SQL is read from `/opt/broker/db/migrations` on the box, not from the bundle.
- It does not `git pull`, does not `npm ci` on the VPS, and does not reload nginx. Static files are read from disk. `firebase-admin` is external to the bundle (`server/build.mjs`); other installed modules stay in `/opt/broker/node_modules` from the last on-box `npm ci`. When `package.json` dependencies change, run `npm ci` on the VPS (or `deploy/deploy.sh`) before you depend on the new bundle.
- A commit that adds a SQL file under `db/migrations` does not upload that file. Pull or copy `db/migrations` onto the VPS so the restarted process can apply it. Until that directory is updated, boot applies only the SQL already on the box.
- It does not change `.env`, `.env.etrade`, the systemd unit, or nginx.

`dist/package.json` is copied. The repo root is `"type": "module"` and the bundle is CommonJS. Node loads `dist/server.js` as CommonJS only when `dist/package.json` says `"type": "commonjs"`. The server build writes that file. The rsync does not delete anything else already in `/opt/broker/dist/`.

## One-time setup

Do this once, from the Mac you already use to SSH to the VPS. Do not commit the private key, and do not paste it into chat or into the repo.

### 1. Generate an ed25519 key

On the Mac, outside the repo:

```bash
umask 077
ssh-keygen -t ed25519 -C "event-gate-gha-deploy" -f "$HOME/event-gate-gha-deploy" -N ""
```

`-N ""` leaves the key without a passphrase. Actions cannot type one. The files are `$HOME/event-gate-gha-deploy` (private) and `$HOME/event-gate-gha-deploy.pub` (public). `chmod 600` is already applied by `umask 077` and `ssh-keygen`. Keep the private key out of the checkout. The Mac fallback below uses this same file.

### 2. Create the deploy user on the VPS

SSH to the VPS as you do today and run the following as a user who can sudo. `eventgate` is the existing service account from `deploy/setup.sh`. `deploy` is a different user. It is not in group `sudo`, `eventgate`, or `www-data`.

```bash
sudo useradd --create-home --shell /bin/bash --comment "Event Gate GitHub Actions deploy" deploy
sudo passwd -l deploy
id deploy
```

If `deploy` already exists, skip `useradd`. `id` should show only the `deploy` group.

If `sshd` has `AllowUsers`, add `deploy` there and reload sshd.

Install the public key. `restrict` disables port forwarding, agent forwarding, X11 forwarding, TTY allocation, and `~/.ssh/rc`. Remote commands (rsync and systemctl) still run. Do not set `command=` — that would block rsync. GitHub-hosted runner addresses change, so there is no `from=` restriction.

```bash
sudo install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# On the Mac: cat "$HOME/event-gate-gha-deploy.pub"
# Paste that single line below, with the word restrict and a space in front of it.
sudo tee /home/deploy/.ssh/authorized_keys >/dev/null << 'EOF'
restrict ssh-ed25519 AAAA...replace-with-the-public-key... event-gate-gha-deploy
EOF
sudo chown deploy:deploy /home/deploy/.ssh/authorized_keys
sudo chmod 600 /home/deploy/.ssh/authorized_keys
```

On an sshd older than OpenSSH 7.2, which has no `restrict`, use this prefix instead:

```text
no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty,no-user-rc
```

### 3. Write access only on the two dist directories

`deploy` must walk `/opt/broker` and `/opt/broker/client` and must write only `/opt/broker/dist` and `/opt/broker/client/dist`. It must not read `.env` or `.env.etrade`.

```bash
sudo apt-get update
sudo apt-get install -y acl rsync
sudo install -d -o eventgate -g eventgate -m 755 /opt/broker/dist /opt/broker/client /opt/broker/client/dist
sudo setfacl -m u:deploy:--x /opt /opt/broker /opt/broker/client
sudo setfacl -m u:deploy:rwx /opt/broker/dist /opt/broker/client/dist
sudo chown eventgate:eventgate /opt/broker/.env
sudo chmod 600 /opt/broker/.env
if [ -f /opt/broker/.env.etrade ]; then
  sudo chown eventgate:eventgate /opt/broker/.env.etrade
  sudo chmod 600 /opt/broker/.env.etrade
fi
```

`u:deploy:--x` lets `deploy` traverse those directories without listing them and without writing. Any other secret file under `/opt/broker` (Firebase service account JSON included) stays mode 600 and owned by `eventgate`, not `deploy`.

Confirm:

```bash
sudo -u deploy test -x /opt/broker && echo "traverse ok"
sudo -u deploy test -w /opt/broker/dist && echo "server dist writable"
sudo -u deploy test -w /opt/broker/client/dist && echo "client dist writable"
sudo -u deploy test -w /opt/broker && echo "ERROR: deploy can write /opt/broker" && exit 1
sudo -u deploy test -r /opt/broker/.env && echo "ERROR: deploy can read .env" && exit 1
echo "permissions ok"
test -x /usr/bin/systemctl && echo "systemctl path ok"
```

`/usr/bin/systemctl` has to exist. The workflow calls that path so the sudoers entry can name one command. On Ubuntu `/bin/systemctl` is the same file via `/usr` merge.

### 4. sudoers

`deploy` may run only these two commands, with no password and no TTY:

```bash
sudo tee /etc/sudoers.d/event-gate-deploy >/dev/null << 'EOF'
Defaults:deploy !requiretty
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart event-gate, /usr/bin/systemctl is-active event-gate
EOF
sudo chmod 440 /etc/sudoers.d/event-gate-deploy
sudo visudo -cf /etc/sudoers.d/event-gate-deploy
```

`systemctl status` is not in sudoers. Any user can run it without root, and the workflow does that only when the active check fails.

From the Mac, using the new key:

```bash
ssh -i "$HOME/event-gate-gha-deploy" -o IdentitiesOnly=yes \
  deploy@server1.logikmancer.com \
  'sudo -n /usr/bin/systemctl is-active event-gate'
```

The reply must be `active`. A password prompt means sudoers is wrong. Fix that before adding the GitHub secret.

### 5. GitHub Actions secrets

On the Mac, capture the host key you already trust. Compare the fingerprint with the key you use for this box today before you save it.

```bash
ssh-keyscan -t ed25519 server1.logikmancer.com | tee "$HOME/event-gate-gha-known_hosts"
ssh-keygen -lf "$HOME/event-gate-gha-known_hosts"
```

If SSH is not on port 22, scan with `ssh-keyscan -p PORT -t ed25519 server1.logikmancer.com`. The line will look like `[server1.logikmancer.com]:PORT ssh-ed25519 AAAA...`. The port in that line and `DEPLOY_PORT` must match.

GitHub → this repository → Settings → Secrets and variables → Actions → Repository secrets. Create:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | `server1.logikmancer.com` |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | The entire private key file, including the `BEGIN` and `END` lines. `cat "$HOME/event-gate-gha-deploy"` |
| `DEPLOY_KNOWN_HOSTS` | The full `ssh-keyscan` output, comments included |
| `DEPLOY_PORT` | Leave this unset when the VPS uses port 22. Otherwise the port number |

Do not create these as environment variables in the repo. Do not put them in `.env`.

### 6. First test deploy

After the secrets exist:

1. GitHub → Actions → **Deploy Event Gate** → **Run workflow**.
2. Branch: the branch that should be built onto the VPS. After this change is on `master`, pick `master`. Running the workflow from another branch deploys that branch's commit to the live VPS.
3. Leave **Skip systemctl restart** unchecked for the first full test. Check it only for a copy-only pass; the job still fails if the unit is not already active or the md5 does not match.
4. Run it. The verify job must be green, then the deploy job. The log shows `event-gate is active` and `md5 ok`.

A cautious sequence is one run with restart skipped, then a second run with it unchecked.

You can merge this change before the secrets exist. The push to `master` stays green and the deploy step logs `Deploy skipped`. After the secrets are saved, either push an empty commit to `master` or use **Run workflow** on `master`.

Later pushes to `master` deploy on their own, including during the cash session (the warning is the signal, not a stop).

## Manual Mac fallback

Use this when Actions cannot run. It is the same script as the workflow. From a clean checkout on the Mac, with Node 24:

```bash
npm ci
npm run typecheck:server
npm run typecheck:client
npm test
npm run build -w @broker/server
npm run build -w @broker/client
export DEPLOY_HOST="server1.logikmancer.com"
export DEPLOY_USER="deploy"
export DEPLOY_SSH_KEY="$(cat "$HOME/event-gate-gha-deploy")"
export DEPLOY_KNOWN_HOSTS="$(cat "$HOME/event-gate-gha-known_hosts")"
# export DEPLOY_PORT="22"          # only if not 22
# export SKIP_RESTART="true"       # copy only; the active check and md5 still run
bash deploy/gha-sync.sh
```

Stock macOS `rsync` 2.6.9 is enough. The local hash uses `md5sum` when it exists and `md5 -q` otherwise. The VPS side of the hash is `md5sum` (coreutils).

`deploy/deploy.sh` is the older on-box path, not what GHA runs. On the VPS it git-pulls (unless the tree is dirty or has no remote), `npm ci`, builds, `npm run migrate`, restarts the unit, and reloads nginx. Use it when you are already on the box and need a dependency install or a migration-file update. It is broader than the rsync path and it is not least-privilege SSH.

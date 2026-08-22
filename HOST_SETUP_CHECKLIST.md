# HTML Hub Host Setup Checklist

Host OS: Pop!_OS / Ubuntu-based Linux
Goal: host HTML Hub locally in Docker, pull updates from personal GitHub, expose later through tunnel/Tailscale.

## Decisions

- App runs on the host machine in Docker.
- Database starts as SQLite on a host-mounted volume.
- Uploaded slide files live on host disk, not inside the DB.
- Categories are code-managed through `categories.json`.
- Login is name-only; no password for v0.
- Public internet access will be added through Cloudflare Tunnel or Tailscale later.

## One-time host setup

- [ ] Update system packages.

```bash
sudo apt update && sudo apt upgrade -y
```

- [ ] Install Git.

```bash
sudo apt install -y git ca-certificates curl gnupg
```

- [ ] Install Docker Engine from Docker's official apt repository.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
```

- [ ] Add Docker apt repository.

```bash
. /etc/os-release
UBUNTU_CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $UBUNTU_CODENAME stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
```

- [ ] Install Docker packages.

```bash
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

- [ ] Allow current user to run Docker without sudo.

```bash
sudo usermod -aG docker "$USER"
```

- [ ] Log out and log back in, then verify Docker.

```bash
docker --version
docker compose version
docker run hello-world
```

## App directory setup

- [ ] Create app parent directory.

```bash
mkdir -p ~/apps
cd ~/apps
```

- [ ] Clone your GitHub repo.

```bash
git clone git@github.com:<your-user>/<your-repo>.git html-hub
cd html-hub
```

Alternative HTTPS clone:

```bash
git clone https://github.com/<your-user>/<your-repo>.git html-hub
cd html-hub
```

- [ ] Create persistent host data directories.

```bash
mkdir -p data uploads
```

Expected local layout:

```text
~/apps/html-hub/
├── docker-compose.yml
├── Dockerfile
├── data/
│   └── html-hub.sqlite
└── uploads/
    └── ...uploaded slide files...
```

## First run

- [ ] Pull latest code.

```bash
git pull --ff-only
```

- [ ] Build and start app.

```bash
docker compose up -d --build
```

- [ ] Check container status.

```bash
docker compose ps
```

- [ ] Check logs.

```bash
docker compose logs -f app
```

- [ ] Open locally from host/LAN.

```text
http://localhost:4173
```

If accessing from another device on LAN:

```text
http://<host-lan-ip>:4173
```

## Update/redeploy flow

- [ ] SSH or open terminal on host.

```bash
cd ~/apps/html-hub
```

- [ ] Pull latest GitHub changes.

```bash
git pull --ff-only
```

- [ ] Rebuild and restart container.

```bash
docker compose up -d --build
```

- [ ] Confirm logs are clean.

```bash
docker compose logs --tail=100 app
```

## Optional deploy script

- [ ] Create `~/apps/html-hub/deploy.sh`.

```bash
cat > deploy.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
git pull --ff-only
docker compose up -d --build
docker compose ps
EOF
chmod +x deploy.sh
```

- [ ] Run future deploys with:

```bash
~/apps/html-hub/deploy.sh
```

## Public tunnel later

### Cloudflare Tunnel quick test

- [ ] Install `cloudflared`.
- [ ] Run temporary tunnel to app port.

```bash
cloudflared tunnel --url http://localhost:4173
```

- [ ] Use printed public URL for testing.

### Cloudflare Tunnel with custom hostname

- [ ] Add `doanvuquangphu.dpdns.org` or the supported DNS zone to Cloudflare.
- [ ] Create a named tunnel in Cloudflare Zero Trust.
- [ ] Map public hostname:

```text
html-hub.doanvuquangphu.dpdns.org -> http://localhost:4173
```

- [ ] Install the tunnel as a system service on the host.
- [ ] Confirm the domain opens the same app as `http://localhost:4173`.

No Cloudflare Access policy is required for the current no-restriction phase.

### Tailscale later

- [ ] Install Tailscale on host.
- [ ] Join your tailnet.
- [ ] Restrict access to tailnet users.
- [ ] Optionally use Tailscale Serve/Funnel.

## Backup checklist

- [ ] Stop app before manual backup, or use SQLite backup command later.

```bash
cd ~/apps/html-hub
docker compose stop app
```

- [ ] Backup DB and uploads.

```bash
tar -czf html-hub-backup-$(date +%Y%m%d).tar.gz data uploads
```

- [ ] Restart app.

```bash
docker compose up -d
```

- [ ] Copy backup to external disk, NAS, cloud drive, or S3.

## Operational checks

- [ ] App starts after reboot.
- [ ] `data/` persists after container rebuild.
- [ ] `uploads/` persists after container rebuild.
- [ ] Uploading a slide creates a DB row.
- [ ] Uploading a slide creates a file under `uploads/`.
- [ ] Category list comes from committed config.
- [ ] Name-only login creates/reuses a user row.
- [ ] Public tunnel cannot write without upload token, if token is enabled.

## Notes for implementation

- Prefer boring Docker Compose over Kubernetes/systemd for v0.
- Do not store uploaded files inside the container filesystem.
- Do not store slide binary content inside SQLite.
- Keep category creation code-only for now.
- Skip PPTX conversion until PDF/ZIP upload works end-to-end.

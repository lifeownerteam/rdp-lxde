# RDP on GitHub Actions (Tailscale)

Private workflows for ephemeral RDP runners reachable over Tailscale.

## Workflows

- **RDP Linux Desktop (LXDE)** — `.github/workflows/rdp-alpine-openbox.yml` (Ubuntu 22.04 + LXDE + xRDP in Docker)
- **RDP Windows** — `.github/workflows/rdp-windows.yml`

## Setup

1. Repository secret: `TAILSCALE_AUTH_KEY` (reusable, preauthorized Tailscale auth key).
2. Run **RDP Linux Desktop (LXDE)** or **RDP Windows** via **Actions → workflow_dispatch**.
3. Download the `tailscale-ip` artifact (Linux) or read job logs for the Tailscale IP; connect RDP to `IP:3389`.

Helper (manual key paste): `scripts/set-tailscale-github-secret.ps1 -Repo OWNER/REPO`

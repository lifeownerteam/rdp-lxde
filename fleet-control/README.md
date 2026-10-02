# Fleet Control (MVP)

Orchestrate many **RDP Linux Desktop (LXDE)** GitHub Actions runners over Tailscale: provision workflows, track Tailscale IPs from artifacts, run shell commands in parallel, control Firefox, and view a simple metrics dashboard.

## Architecture

```text
[Your PC — fleet CLI / dashboard]
        │  Tailscale (100.x)
        ▼
[GHA ubuntu-latest host :8765 → Docker rdp-lxde]
        └── fleet-agent (Python HTTP, token auth)
                 ├── /exec → shell in container
                 ├── /metrics → psutil CPU/RAM
                 └── /firefox/* → Marionette (RDP session display)
```

1. **Provision** — For each GitHub account in config, dispatch `rdp-alpine-openbox.yml` N times (default 8).
2. **Refresh** — Poll workflow runs, download `tailscale-ip` artifacts, store IPs in `fleet-state.json`.
3. **Control** — CLI or dashboard calls each live agent at `http://TAILSCALE_IP:8765` with `Authorization: Bearer <token>`.
4. **Workflow** — Minimal patch to `.github/workflows/rdp-alpine-openbox.yml`: checkout repo, publish port `8765`, copy `fleet-control/fleet-agent`, start agent if `FLEET_AGENT_TOKEN` repo secret exists.

## Quick start

1. Copy `config.example.json` → `config.json` (never commit).
2. On each target repo, set secrets (same as RDP today):
   - `TAILSCALE_AUTH_KEY`
   - `FLEET_AGENT_TOKEN` — same long random string as in your local `config.json` / env
3. Set GitHub tokens via env (recommended):

   ```powershell
   $env:GH_TOKEN_PRIMARY = "ghp_..."
   $env:FLEET_AGENT_TOKEN = "your-shared-agent-token"
   ```

4. From `fleet-control/`:

   ```powershell
   .\fleet.ps1 provision --account primary
   .\fleet.ps1 refresh
   .\fleet.ps1 status
   .\fleet.ps1 exec "uname -a"
   .\fleet.ps1 firefox open --url "https://example.com" --count 3
   npm run dashboard
   ```

   Open `http://127.0.0.1:8780/`.

## CLI reference

| Command | Description |
|---------|-------------|
| `provision [--account NAME] [--count N]` | Dispatch workflows per repo |
| `refresh` | Pull Tailscale IPs from artifacts into state |
| `status [--json]` | Health + metrics per machine |
| `exec "<cmd>"` | Parallel shell on all known IPs |
| `firefox open\|close\|status\|js` | Marionette-based tab control |

**Firefox:** Log in once via RDP so an X session exists (`DISPLAY :10`). First `firefox open` starts Marionette Firefox under user `RDP`.

## Agent API (port 8765)

| Method | Path | Auth | Body |
|--------|------|------|------|
| GET | `/health` | no | — |
| GET | `/metrics` | Bearer | — |
| POST | `/exec` | Bearer | `{ "command": "..." }` |
| GET | `/firefox/status` | Bearer | — |
| POST | `/firefox/open` | Bearer | `{ "url": "...", "count": N }` or `{ "urls": [] }` |
| POST | `/firefox/close` | Bearer | `{ "all": true, "keep": 1 }` |
| POST | `/firefox/js` | Bearer | `{ "script": "return document.title" }` |

## What to push (sparse git repo)

This workspace git repo only tracks selected paths. For **`madclipmad1-stack/rdp-lxde`** (or your RDP repo), push at minimum:

- `.github/workflows/rdp-alpine-openbox.yml` (includes fleet-agent step)
- `fleet-control/fleet-agent/**` (required at runtime via checkout)
- `fleet-control/README.md` (optional docs)
- `README-RDP-GHA.md`, `.gitignore` updates if you use the same sparse pattern

Keep **`fleet-control/config.json`**, tokens, and **`fleet-state.json`** local only.

## Next steps (full Teliko UI)

- Wire `fleet-control` APIs into existing `teliko.js` / managers panel (reuse `linux-remote.example.json` pattern with fleet proxy).
- Replace artifact IP discovery with Tailscale API hostname filter `gh-runner-*`.
- Persist run lifecycle (cancel stale runs, max concurrent per account).
- WebSocket streaming for `exec` stdout and dashboard live charts.
- Harden Firefox: detect active xRDP `DISPLAY`, optional CDP fallback, no Marionette profile drift.

---

## Περίληψη (Ελληνικά)

Το **fleet-control** είναι ένα τοπικό εργαλείο (CLI + απλό dashboard) που:

- Ξεκινά πολλαπλά workflows **RDP Linux Desktop (LXDE)** σε διάφορους λογαριασμούς GitHub (π.χ. 8 μηχανήματα ανά λογαριασμό).
- Μαζεύει τις **Tailscale IP** από artifacts και τις κρατά στο `fleet-state.json`.
- Μιλάει παράλληλα με κάθε live μηχάνημα μέσω **fleet-agent** (Python, θύρα 8765, token) για εντολές shell, μετρήσεις CPU/RAM και έλεγχο Firefox.
- Τα μυστικά (tokens) μένουν στο τοπικό `config.json` / μεταβλητές περιβάλλοντος — **ποτέ** στο git.

Για πλήρη ενσωμάτωση στο Teliko UI, χρειάζεται proxy από το frontend προς το CLI/API και οπτικοποίηση στους υπάρχοντες managers/sysmon panels.

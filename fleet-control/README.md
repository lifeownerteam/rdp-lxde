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
2. **Tailscale API (μία φορά):** αποθήκευσε το `tskey-api-…` σε `fleet-control/.tailscale-api-key` (μία γραμμή, gitignored) — μετά `..\scripts\auto-fleet-lifeownerteam.ps1 -Poll`.
3. On each target repo, set secrets (same as RDP today):
   - `TAILSCALE_AUTH_KEY`
   - `FLEET_AGENT_TOKEN` — same long random string as in your local `config.json` / env
4. Set GitHub tokens via env (recommended):

   ```powershell
   $env:GH_TOKEN_PRIMARY = "ghp_..."
   $env:FLEET_AGENT_TOKEN = "your-shared-agent-token"
   ```

5. From `fleet-control/`:

   ```powershell
   .\fleet.ps1 setup-account -Username YOUR_GITHUB_USER
   .\fleet.ps1 provision --account primary
   .\fleet.ps1 refresh
   .\fleet.ps1 status
   .\fleet.ps1 exec "uname -a"
   .\fleet.ps1 firefox open --url "https://example.com" --count 3
   npm run dashboard
   ```

   Open `http://127.0.0.1:8780/`.

### GUI (Ελληνικά κουμπιά)

Από τον φάκελο `fleet-control/`:

```powershell
npm run dashboard
# ή ισοδύναμα:
npm run gui
```

Άνοιξε **`http://127.0.0.1:8780/`** (ή `/gui`).

| Κουμπί | Λειτουργία |
|--------|------------|
| **Σύνδεση GitHub** | Ανοίγει ορατό τερματικό με `gh auth login` (browser / device code). Δεν υπάρχουν πεδία κωδικού στο UI. |
| **Έναρξη 8 μηχανών** | Τρέχει την ίδια λογική με `node cli.js provision --count 8` και δείχνει πρόοδο. |
| **Ανανέωση** | `refresh` — IPs από artifacts + πίνακας κατάστασης (όπως το dashboard). |

Το `gh` αναζητάται πρώτα στο `D:\Tools\gh\bin\gh.exe`, αλλιώς στο PATH.

### Automation τοπικά — εσύ βάζεις 2FA στο browser, όχι στο chat

Για νέο GitHub user (π.χ. `ryansims046`) **χωρίς** κωδικούς ή 2FA στο chat:

```powershell
# από fleet-control/
.\fleet.ps1 setup-account -Username ryansims046
# ή:
npm run setup-account -- -Username ryansims046
```

Το script:

1. Κάνει `gh auth switch` στον user και, αν χρειάζεται, ανοίγει **τερματικό** με `gh auth login -w` — **εσύ** ολοκληρώνεις login + 2FA στο browser.
2. Δημιουργεί `USER/rdp-lxde` αν λείπει και κάνει push το `main`.
3. Ζητά **τοπικά** (κρυφό `Read-Host`) `TAILSCALE_AUTH_KEY` και `FLEET_AGENT_TOKEN` — δεν τυπώνονται.
4. Θέτει GitHub repo secrets και γράφει τοπικό `config.json` (μόνο **primary** ενεργό, υπόλοιποι λογαριασμοί `enabled: false`).

Μετά: `npm run gui` → dropdown **ενεργών** λογαριασμών → **Έναρξη 8 μηχανών** μόνο για τον επιλεγμένο.

Placeholder repos (`OTHER_ORG`, `YOUR_*`) και `enabled: false` **δεν** χρησιμοποιούνται στην provision.

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

# Fleet Control (MVP)

Orchestrate many **RDP Linux Desktop (LXDE)** GitHub Actions runners over Tailscale: provision workflows, track Tailscale IPs from artifacts, run shell commands in parallel, control Firefox, and view a simple metrics dashboard.

## Self-service (no AI)

From the **repo root**, use one wrapper — reads `fleet-control/config.json` and `fleet-control/.tailscale-api-key` (gitignored):

```powershell
.\scripts\fleet.ps1 help
.\scripts\fleet.ps1 setup -Username YOUR_GITHUB_USER
.\scripts\fleet.ps1 secrets
.\scripts\fleet.ps1 provision 8      # dedupe: only missing runs toward 8 active
.\scripts\fleet.ps1 provision 80     # all enabled accounts toward fleet target
.\scripts\fleet.ps1 poll 8
.\scripts\fleet.ps1 status
.\scripts\fleet.ps1 clean-queue
.\scripts\fleet.ps1 gui              # same as npm run gui in fleet-control/
```

Greek quick reference: **[FLEET-QUICKSTART-EL.md](./FLEET-QUICKSTART-EL.md)** — «Χωρίς AI — τρέξε αυτά».

Legacy: `fleet-control/fleet.ps1` forwards to `scripts/fleet.ps1` (still supports `exec`, `firefox` via Node CLI).

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
2. **Tailscale API (μία φορά):** αποθήκευσε το `tskey-api-…` σε `fleet-control/.tailscale-api-key` (μία γραμμή, gitignored) — μετά `..\scripts\auto-fleet-lifeownerteam.ps1` (queue-aware dispatch) ή `-PollOnly -Poll` μόνο για IPs.
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

### Panel: Firefox & JS

Μετά το `npm run dashboard` / `npm run gui`, στο **`http://127.0.0.1:8780/`** (μόνο localhost):

- **Firefox (όλες οι μηχανές)** — URL, άνοιγμα/κλείσιμο tabs, κατάσταση Marionette σε κάθε LIVE agent.
- **JS Console** — ένα script → αποτελέσματα ανά IP (ίδιο με `node cli.js firefox js "…"`).
- **Terminal** — παράλληλο shell ανά IP (ίδιο με `cli.js exec`).

Ο server καλεί τους agents με το token από `config.json` — **όχι** στο frontend. Προεπιλογή στόχου: μόνο μηχανές **LIVE** από `/api/summary`· προαιρετικά `ips` στο JSON body των API routes.

## CLI reference

| Command | Description |
|---------|-------------|
| `provision [N\|8\|80] [--account NAME]` | Dedupe dispatch toward N active runs (≥80 → multi-account fleet) |
| `provision-fleet [--total N]` | Same as `provision 80` / `--fleet` |
| `clean-queue` | Cancel all queued/in_progress LXDE runs on enabled accounts |
| `poll [--target N] [--minutes M]` | Repeat `refresh` until N IPs or timeout |
| `refresh` | Pull Tailscale IPs from artifacts into state |
| `status [--json]` | IPs table, queue counts, `gh` login + config account check |
| `exec "<cmd>"` | Parallel shell on all known IPs |
| `firefox open\|close\|status\|js` | Marionette-based tab control |

**Firefox:** Log in once via RDP so an X session exists (`DISPLAY :10`). First `firefox open` starts Marionette Firefox under user `RDP`. Agent picks `DISPLAY` from Xorg/x11 socket; Marionette startup waits up to ~45s. If Marionette fails, `/firefox/open` falls back to desktop Firefox (`exec`).

**Hot-deploy agent (no GHA):** `node scripts/deploy-agent-live.js` writes `firefox_ctl.py` + `server.py` via `/exec`, then restarts the agent in a **second** request (never kill the agent in the same `/exec` that is serving the request). On the GHA host you can also `docker cp fleet-control/fleet-agent/. rdp-lxde:/opt/fleet-agent/` and `docker exec -d … python3 /opt/fleet-agent/server.py`. The workflow **Maintain** step runs a host-side watchdog that restarts the agent if it dies (new runs only).

**Live VMs (profile missing dialog):** existing runs do not re-run provisioning; fix all agents in one shot:

```powershell
.\fleet.ps1 exec "install -d -o RDP -g RDP -m 700 /home/RDP/.mozilla/firefox /home/RDP/.fleet-firefox-profile; su - RDP -c '/opt/firefox/firefox -CreateProfile \"fleet /home/RDP/.fleet-firefox-profile\"' 2>/dev/null || true; test -f /home/RDP/.mozilla/firefox/profiles.ini || su - RDP -c '/opt/firefox/firefox -CreateProfile \"default /home/RDP/.mozilla/firefox/default\"'; chown -R RDP:RDP /home/RDP"
```

Then close any Firefox error dialog and launch Firefox again (desktop or `firefox open` from the panel).

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

### Στόλος ~80 μηχανημάτων (5–10 λεπτά dispatch, 15–25 λεπτά IPs)

**Στόχος:** ~80 RDP runners γρήγορα, χωρίς Docker στο PC — μόνο GitHub Actions + Tailscale.

| Έννοια | Τι ισχύει |
|--------|-----------|
| **Μαθηματικά στόλου** | **10 λογαριασμοί GitHub × 8 workflows** = 80 μηχανήματα (`target_total`: 80, `machines_per_account`: 8). |
| **Concurrent cap (free GHA)** | Περίπου **~20 ταυτόχρονα jobs ανά λογαριασμό**· με 10 λογαριασμούς στέλνεις **80 dispatches** χωρίς να περιμένεις serial 8×10×12 λεπτά. |
| **Χρόνος dispatch** | Όλα τα `workflow_dispatch` μπορούν να μπουν στην ουρά σε **~5–10 λεπτά** (`scripts/provision-80.ps1` ή `node cli.js provision-fleet`). |
| **Χρόνος μέχρι IP** | Κάθε LXDE job **~8–12 λεπτά** μέχρι artifact `tailscale-ip`· τα IPs **τρέχουν σταδιακά 15–25 λεπτά** (όχι όλα μαζί στο t=0). |
| **Λεπτά χρέωσης GHA** | Χρεώνεσαι **διάρκεια job × αριθμός runners** (π.χ. 80 × ~10 min ≈ 800 runner-minutes ανά κύκλο — εξαρτάται από πλάνο/org). |

**Ροή:**

1. Αντίγραψε `config.example.json` → `config.json`· ενεργοποίησε **10** entries στο `accounts` (ή `github_accounts`) με `gh_user` + repo `USER/rdp-lxde`.
2. Μία φορά ανά repo: secrets `TAILSCALE_AUTH_KEY`, `FLEET_AGENT_TOKEN` (`setup-account.ps1` — **δεν** ξανα-γράφει Tailscale αν υπάρχει ήδη secret).
3. Γρήγορο fleet dispatch:

   ```powershell
   .\scripts\provision-80.ps1
   # ή ένα CLI για όλους τους ενεργούς (tokens / gh auth):
   cd fleet-control
   node cli.js provision-fleet --cancel-duplicates
   ```

4. IPs: `node cli.js refresh` ή `.\scripts\auto-fleet-lifeownerteam.ps1 -PollOnly -Poll`.

**`provision-fleet`** μετρά **queued / in_progress**, στέλνει μόνο το **κενό** μέχρι `target_total`, και με `--cancel-duplicates` ακυρώνει **περιττά queued** πάνω από το όριο ανά λογαριασμό.

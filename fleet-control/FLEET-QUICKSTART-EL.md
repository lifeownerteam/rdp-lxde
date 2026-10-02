# Fleet — γρήγορος οδηγός (χωρίς AI)

**Χωρίς AI — τρέξε αυτά** από τη ρίζα του repo (PowerShell):

```powershell
cd "C:\path\to\teliko ui"

# 1) Μία φορά: GitHub user + repo + τοπικό config.json
.\scripts\fleet.ps1 setup -Username Ο_ΛΟΓΑΡΙΑΣΜΟΣ_ΣΟΥ

# 2) Μία φορά: Tailscale API key σε αρχείο (gitignored)
#    fleet-control\.tailscale-api-key  → μία γραμμή tskey-api-…

# 3) Μυστικά στο GitHub (idempotent — δεν ξαναγράφει αν υπάρχουν)
.\scripts\fleet.ps1 secrets

# 4) 8 μηχανήματα (dedupe — δεν διπλασιάζει αν ήδη τρέχουν N active)
.\scripts\fleet.ps1 provision 8

# 5) IPs + έλεγχος gh
.\scripts\fleet.ps1 poll 8
.\scripts\fleet.ps1 status

# 6) GUI (όπως πάντα)
cd fleet-control
npm run gui
```

**Terminal 100%:** Στο panel (8780) πάτα **Ανανέωση**, έλεγξε τις LIVE IPs, Terminal → `echo FLEET_OK` (ή `.\scripts\fleet.ps1 exec "echo FLEET_OK"`).

## 80 μηχανήματα (10 λογαριασμοί × 8)

1. Στο `fleet-control/config.json` ενεργοποίησε τους λογαριασμούς που θες (`enabled: true`, πραγματικά `owner/rdp-lxde`).
2. Για κάθε user: `gh auth login` (ή `setup` ανά user).
3. `.\scripts\fleet.ps1 secrets`
4. `.\scripts\fleet.ps1 provision 80` (ή `.\scripts\provision-80.ps1` — gh switch ανά λογαριασμό)
5. `.\scripts\fleet.ps1 poll 80` (15–25 λεπτά συνήθως)

## Auto-reconnect (watch)

Όταν πεθαίνουν μηχανές, τρέξε **watch** στο background — κάνει `refresh`, μετρά LIVE agents και (με dedupe) ξανα-κάνει `provision` μόνο όταν `LIVE < στόχος` **και** `active runs < στόχος`. Αν ήδη τρέχουν 8 workflows αλλά λίγα LIVE, **περιμένει** (χωρίς spam dispatch). Μέγιστο **ένα burst provision ανά 10 λεπτά** (`fleet-control/.fleet-watch-cooldown.json`).

**Στον runner (GHA):** το βήμα **Maintain Connection** στο workflow `rdp-alpine-openbox.yml` έχει **agent watchdog** — κάθε ~45s ελέγχει `:8765/health` και κάνει restart τον fleet-agent μέσα στο container (νέα runs μόνο).

Προαιρετικά, αν κολλάνε όλα τα runs: έλεγξε billing/limits του org στο GitHub (`Settings → Billing`) πριν mass provision.

```powershell
# Δοκιμή μίας επανάληψης χωρίς dispatch
.\scripts\fleet.ps1 watch --target 8 --once --dry-run

# Background (PowerShell) — primary fleet 8, κάθε 2 λεπτά
Start-Process powershell -WindowStyle Hidden -ArgumentList @(
  '-NoProfile','-ExecutionPolicy','Bypass','-File',
  (Join-Path (Get-Location) 'scripts\fleet.ps1'),
  'watch','--target','8','--interval','120'
)

# Ή στο ίδιο terminal (Ctrl+C για stop)
.\scripts\fleet.ps1 watch --target 8 --interval 120
```

## 8 LIVE (αν κολλήσουν παλιά runs)

Ένα `:8765/health` OK δεν αρκεί για όλο το fleet: ακύρωσε dead `in_progress` (χωρίς agent) και **μία φορά** `.\scripts\fleet.ps1 provision 8` (workflow ≥ `6ab455e`). Recovery scripts: `fleet-control/scripts/restore-agent-docker-exec.js`, `deploy-agent-live.js`, `patch-agent-ip.js`.

## Καθάρισμα ουράς

Ακυρώνει **όλα** τα `queued` / `in_progress` για το workflow LXDE στους ενεργούς λογαριασμούς:

```powershell
.\scripts\fleet.ps1 clean-queue
```

## Git push (`origin` → madclip)

Αν αποτύχει το `git push origin main`: `gh auth switch --user madclipmad1-stack` και `gh auth setup-git`, μετά ξαναδοκίμασε push.

## Τι δεν μπαίνει ποτέ στο git

- `fleet-control/config.json`
- `fleet-control/fleet-state.json`
- `fleet-control/.tailscale-api-key`
- tokens / κωδικοί στο chat

## Cursor Automations — αυτόματη επανασύνδεση fleet

Όταν κάποια μηχανήματα πέφτουν (DOWN αντί LIVE), μπορείς να αφήσεις **Cursor Automation** να τρέχει περιοδικά recovery χωρίς chat.

**Προαπαιτούμενα (μία φορά):**

- Έχεις κάνει setup (`fleet.ps1 setup`, `secrets`, `provision 8`) όπως παραπάνω.
- Το `gh` είναι συνδεδεμένο με `lifeownerteam` στο **ίδιο PC** που τρέχει το automation.
- Το `fleet-control\.tailscale-api-key` υπάρχει τοπικά (δεν μπαίνει στο git).

**Βήματα στο Cursor:**

1. Άνοιξε **Cursor → Automations** (ή Automations από το Agents panel).
2. **Νέο automation** → όνομα π.χ. **Fleet auto-reconnect (8 LIVE)**.
3. **Trigger (Πρόγραμμα):** κάθε **20 λεπτά** (ή 15–30 λεπτά — ισοδύναμο cron `*/20 * * * *`).
4. **Repository:** αυτό το repo, κλάδος **`main`** (αν χρησιμοποιείς `origin` άλλο owner, διάλεξε το remote που έχει τα scripts).
5. **Instructions:** αντίγραψε ολόκληρο το κείμενο από `.cursor/automation/PROMPT.md` (ή import από `.cursor/automation/fleet-auto-reconnect.json` αν το UI το υποστηρίζει).
6. **Τοπική εκτέλεση:** διάλεξε **local** στο ίδιο Windows μηχάνημα όπου τρέχεις `.\scripts\fleet.ps1` — το cloud checkout **δεν** έχει `.tailscale-api-key` / `config.json`.
7. **Save** και **Enable** (ενεργοποίηση).

**Τι κάνει ο agent κάθε φορά (ίδιο με χειροκίνητα):**

```powershell
gh auth switch -u lifeownerteam
.\scripts\fleet-watch.ps1
.\scripts\fleet.ps1 status
```

Λογική: αν `active==0` ή (`LIVE<8` και `active<8`) → `provision` με dedupe, μετά `refresh`, προαιρετικό `poll`.

**Χωρίς Automation (τοπικό loop):**

```powershell
.\scripts\fleet.ps1 watch
.\scripts\fleet.ps1 watch -Poll
```

Λεπτομέρειες στα Αγγλικά: [.cursor/automation/README.md](../.cursor/automation/README.md)

## Βοήθεια

```powershell
.\scripts\fleet.ps1 help
```

Αγγλικό README: [README.md](./README.md)

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

## 80 μηχανήματα (10 λογαριασμοί × 8)

1. Στο `fleet-control/config.json` ενεργοποίησε τους λογαριασμούς που θες (`enabled: true`, πραγματικά `owner/rdp-lxde`).
2. Για κάθε user: `gh auth login` (ή `setup` ανά user).
3. `.\scripts\fleet.ps1 secrets`
4. `.\scripts\fleet.ps1 provision 80` (ή `.\scripts\provision-80.ps1` — gh switch ανά λογαριασμό)
5. `.\scripts\fleet.ps1 poll 80` (15–25 λεπτά συνήθως)

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

## Βοήθεια

```powershell
.\scripts\fleet.ps1 help
```

Αγγλικό README: [README.md](./README.md)

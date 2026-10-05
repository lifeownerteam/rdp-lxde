# Terminal Fleet — σχεδιασμός (8 μηχανήματα, χωρίς RDP)

## Τι έχουμε σήμερα

| Στοιχείο | Ρόλος |
|----------|--------|
| `.github/workflows/rdp-alpine-openbox.yml` | Ubuntu + LXDE + xRDP + Tailscale + fleet-agent `:8765` |
| `.github/workflows/terminal-fleet-alpine.yml` | **Νέο:** Alpine + OpenSSH + fleet-agent μόνο (ελαφρύ) |
| `scripts/fleet.ps1` / `fleet-control/cli.js` | dispatch, poll IPs από artifact `tailscale-ip`, parallel `exec` |
| `fleet-control/lib/agents.js` | HTTP προς κάθε μηχάνημα (`tailscale_ip:8765`) |

Το `config.json` δείχνει ποιο workflow κάνει dispatch μέσω `workflow_id` (π.χ. `terminal-fleet-alpine.yml`).

## Billing / γιατί βλέπεις άμεσο failure (~4–6s)

Πρόσφατα runs στο `lifeownerteam/rdp-lxde` **αποτυγχάνουν χωρίς logs** (`runner_id: 0`, `steps: []`).

Αυτό σχεδόν πάντα σημαίνει: **δεν δόθηκε GitHub-hosted runner** — συνήθως:

- τέλος δωρεάν λεπτών / **Spending limit** στο org/account
- ή πολύ μεγάλη ουρά concurrency (λιγότερο συχνό όταν πέφτει σε 3 δευτερόλεπτα)

**Έλεγχος:** GitHub → Settings → Billing → Actions · org `lifeownerteam` → Actions usage / payment method.

Μέχρι να λυθεί το billing, **κανένα workflow (ούτε terminal ούτε LXDE) δεν θα σηκώνει VM**.

## GitHub Actions — τι σημαίνουν «8 μηχανήματα»

- **Τρέχον μοτίβο (fleet-control):** 8× `workflow_dispatch` = 8 **ξεχωριστά** runs, το καθένα `ubuntu-latest` runner + Docker container.
- **Όχι** ένα run με `matrix: 8` (μπορεί να προστεθεί αργότερα για atomic «σκάλα» 8 nodes).
- **Όρια (ενδεικτικά):** ~20 concurrent jobs ανά repo/account στο free tier · 8 parallel dispatches είναι OK **αν** υπάρχει billing/quota.
- **Self-hosted runners:** 8 μόνιμοι runners = πιο σταθερό «cluster», αλλά δεν είναι ephemeral GHA VMs.

## «Ένα VPS» — επιλογές

| Επιλογή | Περιγραφή | Βάρος |
|---------|-----------|--------|
| **(a) Control plane VPS** | Ένα φθηνό VPS (bastion) + workers (GHA ή VPS). Το `fleet-control` τρέχει εκεί ή στο PC σου. | Ελαφρύ |
| **(b) Cluster shell** | `node cli.js cluster exec "cmd"` / `exec` — ήδη parallel σε όλους τους agents. Για SSH: `pdsh`, `mssh`, ή script που διαβάζει `fleet-state.json`. | Ελαφρύ — **προτείνεται πρώτο βήμα** |
| **(c) Nomad / K3s** | Πραγματικό cluster orchestration σε 8 nodes. | Βαρύ — overkill για terminal fleet |
| **(d) Bastion + WireGuard / CF Tunnel** | Ένα public entrypoint, private agents. | Μεσαίο — καλό substitute για Tailscale |

## Σύνδεση «από παντού» χωρίς Tailscale

Προτεραιότητα (όπως ζήτησες):

1. **Cloudflare Tunnel** σε μόνιμο bastion (ή Named Tunnel token στο secret `CF_TUNNEL_TOKEN`) → SSH `:22` και/ή agent `:8765` πίσω από HTTPS/WARP.
2. **Δημόσιο IP + SSH keys + fail2ban** — απλό, αλλά εκθέτει port (μόνο keys, όχι password).
3. **WireGuard** στο ίδιο bastion — VPN χωρίς Tailscale.

Το `terminal-fleet-alpine.yml` υποστηρίζει:

- **Tailscale** αν υπάρχει `TAILSCALE_AUTH_KEY` (συμβατό με σημερινό `poll` / `tailscale-ip` artifact).
- **Αλλιώς** Cloudflare **quick tunnel** προς `:8765` (προσωρινό URL · artifact `fleet-connect` — χρειάζεται επέκταση στο `refresh` για auto-import URL).

Μακροπρόθεσμα: ένα **Named Tunnel** στο bastion που δρομολογεί `ssh.bastion.example` → control plane, και από εκεί `cluster exec` στα 8 agents.

## Ροή verify — 8 terminal-only μηχανήματα

1. Διόρθωσε **Actions billing** στον λογαριασμό/org που κάνει dispatch.
2. Στο `fleet-control/config.json`:
   ```json
   "workflow_id": "terminal-fleet-alpine.yml",
   "workflow_name": "Terminal Fleet (Alpine SSH)"
   ```
3. Secrets στο repo: `.\scripts\fleet.ps1 setup` ή `secrets` θέτουν `TAILSCALE_AUTH_KEY`, `FLEET_AGENT_TOKEN`, `TERMINAL_SSH_PASSWORD` (default `agkalitsa` όπως RDP · ή env `TERMINAL_SSH_PASSWORD` / prompt στο setup).
4. `gh auth switch -u lifeownerteam`
5. `.\scripts\fleet.ps1 clean-queue`
6. `.\scripts\fleet.ps1 provision 8`
7. `.\scripts\fleet.ps1 poll 8`
8. `node fleet-control/cli.js cluster health`
9. `node fleet-control/cli.js cluster exec "uname -a"`

## Επόμενα βήματα (κώδικας)

- [ ] `refresh`: διάβασε artifact `fleet-connect` (Cloudflare URL) και πεδίο `connect_url` στο state (όχι μόνο `100.x`).
- [ ] Προαιρετικό `matrix` job 8× σε ένα workflow dispatch.
- [ ] `clean-queue`: φίλτρο και για `terminal-fleet-alpine.yml`.
- [ ] Bastion + Named CF Tunnel (infra εκτός repo).

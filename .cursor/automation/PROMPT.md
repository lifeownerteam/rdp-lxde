# Automation agent instructions (copy into Cursor Automations)

You maintain the 8-machine RDP fleet for this repo (GitHub Actions workflow `rdp-alpine-openbox.yml`, Tailscale, fleet-agent on port 8765).

Run on the machine where GitHub CLI is already logged in and fleet local files exist (`fleet-control/config.json` and `fleet-control/.tailscale-api-key` are gitignored — do not read, print, or commit secret values).

From the repository root, in PowerShell:

1. `gh auth switch -u lifeownerteam` (confirm success; do not print tokens)
2. `.\scripts\fleet-watch.ps1` — this reads status, provisions with dedupe when `active==0` or (`LIVE<8` and `active<8`), refreshes fleet-state, and may auto-poll if LIVE is still short
3. If fleet-watch did not poll and LIVE is still below 8, run once: `.\scripts\fleet-watch.ps1 -Poll -PollMinutes 15`
4. Run `.\scripts\fleet.ps1 status` and summarize results

Do not run `clean-queue` automatically. If `LIVE<8` but `active>=8`, say stuck runs are likely and mention manual `.\scripts\fleet.ps1 clean-queue` in the summary only.

Reply with a short report: timestamp, LIVE count, active workflow runs, provision/refresh/poll actions taken, DOWN IPs (if any), and whether manual intervention is needed.

# Cursor Automations — Fleet auto-reconnect

Committed draft for **Fleet auto-reconnect (8 LIVE)**.

| Field | Value |
|-------|--------|
| **File** | `fleet-auto-reconnect.json` |
| **Schedule** | Every 20 minutes (`*/20 * * * *`) |
| **Repo / branch** | `lifeownerteam/rdp-lxde` · `main` |

## Import in Cursor

1. Open **Cursor → Automations** (or Automations in the Agents sidebar).
2. **New automation** → use **Import** / paste draft if the editor offers it, or create a scheduled automation and copy fields from `fleet-auto-reconnect.json`.
3. Set trigger to **On a schedule** → every **20 minutes** (or 15–30 min if you prefer).
4. Set **Repository** to this repo and branch `main` (match `workflow.gitConfig` or your `origin` remote if different).
5. Paste the **Instructions** from `PROMPT.md` (same text as `workflow.prompts[0].prompt` in the JSON).
6. Prefer **local** execution on the Windows PC that has `gh auth` for `lifeownerteam` and local `fleet-control/` files (API key file is gitignored).
7. Save and **Enable** the automation.

Greek UI steps: see `fleet-control/FLEET-QUICKSTART-EL.md` § Cursor Automations.

## Manual equivalent (no AI)

```powershell
cd "C:\path\to\repo"
.\scripts\fleet.ps1 watch
# or continuous local loop:
.\scripts\fleet-watch.ps1 -Poll
```

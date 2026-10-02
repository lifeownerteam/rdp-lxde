"use strict";

const { loadState, saveState, upsertMachine } = require("./state");
const gh = require("./gh");
const { getGhTokenSync } = require("./gh-local");

function accountsFor(cfg, accountName) {
  let list = cfg.github_accounts || [];
  if (accountName) {
    list = list.filter((a) => a.name === accountName);
  }
  const ghToken = getGhTokenSync();
  list = list.map((a) => {
    if (a.token) return a;
    if (ghToken) return { ...a, token: ghToken };
    return a;
  });
  return list.filter((a) => a.token);
}

async function cmdProvision(cfg, flags, onEvent) {
  const emit = (msg) => {
    if (onEvent) onEvent({ type: "log", message: msg });
  };
  const state = loadState(cfg);
  const accts = accountsFor(cfg, flags.account);
  if (!accts.length) {
    throw new Error(
      "No GitHub account with token (set token_env env vars or gh auth login)"
    );
  }
  for (const acct of accts) {
    for (const repo of acct.repos || []) {
      const count = parseInt(flags.count || acct.machines_per_account || cfg.machines_per_account || 8, 10);
      emit(`Provisioning ${count} runs on ${repo} (${acct.name})...`);
      for (let i = 0; i < count; i++) {
        await gh.dispatchWorkflow(acct.token, repo, cfg.workflow_id);
        state.runs.push({
          account: acct.name,
          repo,
          dispatched_at: new Date().toISOString(),
        });
        emit(`Dispatched ${i + 1}/${count} — ${repo}`);
        if (onEvent) onEvent({ type: "progress", current: i + 1, total: count, repo, account: acct.name });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  saveState(cfg, state);
  emit("Done. Use Ανανέωση to pull Tailscale IPs.");
}

async function cmdRefresh(cfg, flags, onEvent) {
  const emit = (msg) => {
    if (onEvent) onEvent({ type: "log", message: msg });
  };
  const state = loadState(cfg);
  const accts = accountsFor(cfg, flags.account);
  if (!accts.length) {
    throw new Error("No GitHub account with token");
  }
  for (const acct of accts) {
    for (const repo of acct.repos || []) {
      emit(`Refreshing ${repo} (${acct.name})...`);
      const runs = await gh.listWorkflowRuns(acct.token, repo, cfg.workflow_id, 50);
      const withIp = await gh.collectIpsForRuns(acct.token, repo, runs);
      for (const row of withIp) {
        upsertMachine(state, {
          account: acct.name,
          repo,
          run_id: row.run_id,
          tailscale_ip: row.tailscale_ip,
          run_status: row.status,
          conclusion: row.conclusion,
          agent_port: cfg.agent_port || 8765,
          updated_at: new Date().toISOString(),
        });
      }
      emit(`${repo}: ${withIp.length} runs with tailscale-ip artifact`);
    }
  }
  saveState(cfg, state);
  emit("Refresh complete.");
}

module.exports = { accountsFor, cmdProvision, cmdRefresh };

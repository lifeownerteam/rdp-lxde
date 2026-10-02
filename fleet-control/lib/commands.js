"use strict";

const { loadState, saveState, upsertMachine } = require("./state");
const gh = require("./gh");
const { getGhTokenSync } = require("./gh-local");

/** Placeholder owner/repo patterns from config.example — never dispatch these. */
function isPlaceholderRepo(repo) {
  if (!repo || typeof repo !== "string") return true;
  const trimmed = repo.trim();
  if (/\bexample\.com\b/i.test(trimmed)) return true;
  const owner = (trimmed.split("/")[0] || "").trim();
  if (/^OTHER_ORG$/i.test(owner)) return true;
  if (/^YOUR_/i.test(owner)) return true;
  return false;
}

function filterRepos(repos) {
  return (repos || []).filter((r) => !isPlaceholderRepo(r));
}

function applyGhToken(acct, ghToken) {
  if (acct.token) return acct;
  if (ghToken) return { ...acct, token: ghToken };
  return acct;
}

/**
 * Accounts used for provision/refresh: enabled only, real repos, has token.
 * Default (no flags.account): primary only — never all accounts.
 */
function targetAccounts(cfg, flags = {}) {
  const ghToken = getGhTokenSync();
  let list = (cfg.github_accounts || []).filter((a) => a.enabled !== false);

  if (flags.account) {
    list = list.filter((a) => a.name === flags.account);
  } else {
    const primary = list.find((a) => a.name === "primary");
    list = primary ? [primary] : list.slice(0, 1);
  }

  return list
    .map((a) => {
      const withToken = applyGhToken(a, ghToken);
      return { ...withToken, repos: filterRepos(withToken.repos) };
    })
    .filter((a) => a.token && a.repos.length > 0);
}

function explainMissingAccount(cfg, accountName) {
  const all = cfg.github_accounts || [];
  const named = all.find((a) => a.name === accountName);
  if (!named) {
    return `Unknown GitHub account "${accountName}" in config.json`;
  }
  if (named.enabled === false) {
    return `Account "${accountName}" is disabled (enabled: false) in config.json`;
  }
  const ghToken = getGhTokenSync();
  const withToken = applyGhToken(named, ghToken);
  if (!withToken.token) {
    return `Account "${accountName}" has no token — run «Σύνδεση GitHub» / gh auth login or set ${named.token_env || "token_env"}`;
  }
  const repos = filterRepos(named.repos);
  if (!repos.length) {
    return `Account "${accountName}" has only placeholder repos (YOUR_*, OTHER_ORG, example.com) — set real owner/repo in config.json`;
  }
  return `Account "${accountName}" is not provisionable`;
}

/** Options for dashboard account dropdown */
function listAccountOptions(cfg) {
  const ghToken = getGhTokenSync();
  return (cfg.github_accounts || []).map((a) => {
    const withToken = applyGhToken(a, ghToken);
    const repos = filterRepos(withToken.repos);
    let reason = null;
    if (a.enabled === false) reason = "disabled in config";
    else if (!withToken.token) reason = "no token (gh auth or token_env)";
    else if (!repos.length) reason = "placeholder repos only";
    return {
      name: a.name,
      provisionable: !reason,
      reason,
      repos,
    };
  });
}

/** @deprecated use targetAccounts */
function accountsFor(cfg, accountName) {
  return targetAccounts(cfg, { account: accountName });
}

async function dispatchWithRepoError(acct, repo, workflowId) {
  try {
    await gh.dispatchWorkflow(acct.token, repo, workflowId);
  } catch (err) {
    const msg = String(err.message || err);
    if (/GitHub 404/i.test(msg)) {
      throw new Error(
        `GitHub 404 — repo or workflow not found: ${repo} (account: ${acct.name}). ` +
          `Check config.json repos and that workflow file exists on the default branch.`
      );
    }
    throw err;
  }
}

async function cmdProvision(cfg, flags, onEvent) {
  const emit = (msg) => {
    if (onEvent) onEvent({ type: "log", message: msg });
  };
  const state = loadState(cfg);
  const accts = targetAccounts(cfg, flags);
  if (!accts.length) {
    if (flags.account) {
      throw new Error(explainMissingAccount(cfg, flags.account));
    }
    throw new Error(
      "No provisionable GitHub account (primary needs real repos, enabled:true, and gh auth or token_env)"
    );
  }
  for (const acct of accts) {
    for (const repo of acct.repos) {
      const count = parseInt(
        flags.count || acct.machines_per_account || cfg.machines_per_account || 8,
        10
      );
      emit(`Provisioning ${count} runs on ${repo} (${acct.name})...`);
      for (let i = 0; i < count; i++) {
        await dispatchWithRepoError(acct, repo, cfg.workflow_id);
        state.runs.push({
          account: acct.name,
          repo,
          dispatched_at: new Date().toISOString(),
        });
        emit(`Dispatched ${i + 1}/${count} — ${repo}`);
        if (onEvent) {
          onEvent({ type: "progress", current: i + 1, total: count, repo, account: acct.name });
        }
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
  const accts = targetAccounts(cfg, flags);
  if (!accts.length) {
    if (flags.account) {
      throw new Error(explainMissingAccount(cfg, flags.account));
    }
    throw new Error("No GitHub account with token and real repos");
  }
  for (const acct of accts) {
    for (const repo of acct.repos) {
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

module.exports = {
  isPlaceholderRepo,
  targetAccounts,
  listAccountOptions,
  accountsFor,
  cmdProvision,
  cmdRefresh,
};

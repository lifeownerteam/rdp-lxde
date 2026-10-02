"use strict";

const { loadState } = require("./state");
const gh = require("./gh");
const { listAccountOptions, fleetTargetAccounts } = require("./commands");
const { getGitHubAuthStatus, getGhTokenSync } = require("./gh-local");
const agents = require("./agents");

async function countActiveForRepo(acct, repo, workflowId) {
  const runs = await gh.listWorkflowRuns(acct.token, repo, workflowId, 80);
  return gh.activeRuns(runs).length;
}

async function buildFleetStatus(cfg) {
  const state = loadState(cfg);
  const ghAuth = await getGitHubAuthStatus();
  const accountOptions = listAccountOptions(cfg);
  const primaryCfg = (cfg.github_accounts || []).find((a) => a.name === "primary");
  const accts = fleetTargetAccounts(cfg, {});

  const queue = [];
  for (const acct of accts) {
    for (const repo of acct.repos) {
      try {
        const active = await countActiveForRepo(acct, repo, cfg.workflow_id);
        queue.push({ account: acct.name, repo, active_runs: active });
      } catch (err) {
        queue.push({
          account: acct.name,
          repo,
          active_runs: null,
          error: String(err.message || err),
        });
      }
    }
  }

  const machineRows = await agents.healthAll(cfg, state);
  const machines = [];
  for (const row of machineRows) {
    let metrics = null;
    if (row.health && row.health.ok) {
      metrics = await agents.agentRequest(
        row.tailscale_ip,
        cfg.agent_port || 8765,
        cfg.fleet_agent_token,
        "GET",
        "/metrics"
      );
    }
    machines.push({
      ip: row.tailscale_ip,
      account: row.account,
      repo: row.repo,
      run_id: row.run_id,
      live: !!(row.health && row.health.ok),
      run_status: row.run_status,
      conclusion: row.conclusion,
      metrics: metrics && metrics.body,
    });
  }

  const withIp = machines.filter((m) => m.ip);
  const live = machines.filter((m) => m.live);

  return {
    generated_at: new Date().toISOString(),
    gh: {
      path: ghAuth.gh_path,
      logged_in: ghAuth.loggedIn,
      active_account: ghAuth.account,
      token_available: !!getGhTokenSync(),
    },
    config_accounts: accountOptions,
    primary_gh_user: primaryCfg && primaryCfg.gh_user,
    workflow_id: cfg.workflow_id,
    queue,
    summary: {
      machines_with_ip: withIp.length,
      machines_live: live.length,
      active_runs_total: queue.reduce((s, q) => s + (q.active_runs || 0), 0),
    },
    machines,
  };
}

function printHumanTable(report) {
  console.log("");
  console.log("=== GitHub (gh) ===");
  console.log(
    `  logged_in: ${report.gh.logged_in ? "yes" : "no"}  active: ${report.gh.active_account || "-"}  token: ${report.gh.token_available ? "ok" : "missing"}`
  );
  if (
    report.gh.logged_in &&
    report.primary_gh_user &&
    report.gh.active_account &&
    report.gh.active_account !== report.primary_gh_user
  ) {
    console.log(
      `  WARNING: active gh user is ${report.gh.active_account}, not ${report.primary_gh_user} — API uses gh auth token (gh auth switch -u ${report.primary_gh_user})`
    );
  }
  console.log("");
  console.log("=== Config accounts ===");
  for (const a of report.config_accounts) {
    const flag = a.provisionable ? "OK" : "SKIP";
    const repos = (a.repos || []).join(", ") || "-";
    console.log(`  [${flag}] ${a.name}  ${a.reason || repos}`);
  }
  console.log("");
  console.log("=== Queue (active workflow runs) ===");
  for (const q of report.queue) {
    if (q.error) {
      console.log(`  ${q.account}  ${q.repo}  error: ${q.error}`);
    } else {
      console.log(`  ${q.account}  ${q.repo}  active: ${q.active_runs}`);
    }
  }
  console.log("");
  console.log(
    `=== Machines (${report.summary.machines_live} live / ${report.summary.machines_with_ip} with IP) ===`
  );
  console.log("  LIVE   IP              ACCOUNT   REPO");
  for (const m of report.machines) {
    if (!m.ip) continue;
    const tag = m.live ? "LIVE" : "DOWN";
    console.log(
      `  ${tag.padEnd(5)}  ${String(m.ip).padEnd(15)}  ${(m.account || "").padEnd(8)}  ${m.repo || ""}`
    );
  }
  if (!report.machines.some((m) => m.ip)) {
    console.log("  (no IPs yet — run poll or refresh)");
  }
  console.log("");
}

module.exports = { buildFleetStatus, printHumanTable };

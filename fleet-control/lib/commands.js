"use strict";

const fs = require("fs");
const path = require("path");

const { loadState, saveState, upsertMachine, pruneMachinesToActiveRuns } = require("./state");
const gh = require("./gh");
const agents = require("./agents");
const { resolveAccountToken, switchGhUserSync } = require("./gh-local");

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

function applyGhToken(acct) {
  const token = resolveAccountToken(acct);
  if (token) return { ...acct, token };
  return acct;
}

/**
 * All enabled accounts with real repos and token (multi-account fleet).
 */
function fleetTargetAccounts(cfg, flags = {}) {
  let list = (cfg.github_accounts || []).filter((a) => a.enabled !== false);

  if (flags.account) {
    list = list.filter((a) => a.name === flags.account);
  }

  return list
    .map((a) => {
      const withToken = applyGhToken(a);
      return { ...withToken, repos: filterRepos(withToken.repos) };
    })
    .filter((a) => a.token && a.repos.length > 0);
}

/**
 * Accounts used for provision/refresh: enabled only, real repos, has token.
 * Default (no flags.account): primary only — never all accounts.
 */
function targetAccounts(cfg, flags = {}) {
  let list = (cfg.github_accounts || []).filter((a) => a.enabled !== false);

  if (flags.account) {
    list = list.filter((a) => a.name === flags.account);
  } else {
    const primary = list.find((a) => a.name === "primary");
    list = primary ? [primary] : list.slice(0, 1);
  }

  return list
    .map((a) => {
      const withToken = applyGhToken(a);
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
  const withToken = applyGhToken(named);
  if (!withToken.token) {
    const ghUser = named.gh_user ? ` (gh_user: ${named.gh_user})` : "";
    const switchHint = named.gh_user
      ? ` Run: gh auth switch -u ${named.gh_user}, or «Σύνδεση GitHub».`
      : " Run «Σύνδεση GitHub» / gh auth login or set token_env.";
    return `Account "${accountName}" has no token${ghUser}.${switchHint} Or set ${named.token_env || "token_env"}.`;
  }
  const repos = filterRepos(named.repos);
  if (!repos.length) {
    return `Account "${accountName}" has only placeholder repos (YOUR_*, OTHER_ORG, example.com) — set real owner/repo in config.json`;
  }
  return `Account "${accountName}" is not provisionable`;
}

/** Options for dashboard account dropdown */
function listAccountOptions(cfg) {
  return (cfg.github_accounts || []).map((a) => {
    const withToken = applyGhToken(a);
    const repos = filterRepos(withToken.repos);
    let reason = null;
    if (a.enabled === false) reason = "disabled in config";
    else if (!withToken.token) reason = "no token (gh auth or token_env)";
    else if (!repos.length) reason = "placeholder repos only";
    return {
      name: a.name,
      enabled: a.enabled !== false,
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

function parseProvisionTarget(cfg, flags) {
  const raw = flags.total || flags.count || flags.target;
  if (raw !== undefined && raw !== true) {
    return parseInt(String(raw), 10);
  }
  return parseInt(cfg.machines_per_account || 8, 10);
}

async function cmdProvision(cfg, flags, onEvent) {
  const target = parseProvisionTarget(cfg, flags);
  if (target >= 80 || flags.fleet || flags["multi-account"]) {
    return cmdProvisionFleet(cfg, { ...flags, total: target }, onEvent);
  }

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

  let dispatched = 0;
  for (const acct of accts) {
    if (acct.gh_user) {
      const sw = switchGhUserSync(acct.gh_user, acct.gh_host || "github.com");
      if (!sw.ok) {
        throw new Error(`gh auth switch -u ${acct.gh_user} failed: ${sw.message}`);
      }
      emit(`Using GitHub account ${acct.gh_user} (${acct.name})`);
    }
    for (const repo of acct.repos) {
      const perRepoTarget = parseInt(
        flags.count || acct.machines_per_account || cfg.machines_per_account || target,
        10
      );
      const runs = await gh.listWorkflowRuns(acct.token, repo, cfg.workflow_id, 100);
      const activeCount = gh.countActiveRuns(runs);
      const toDispatch = Math.max(0, perRepoTarget - activeCount);
      emit(
        `${repo} (${acct.name}): ${activeCount}/${perRepoTarget} active → dispatch ${toDispatch}`
      );
      if (toDispatch <= 0) continue;

      for (let i = 0; i < toDispatch; i++) {
        await dispatchWithRepoError(acct, repo, cfg.workflow_id);
        state.runs.push({
          account: acct.name,
          repo,
          dispatched_at: new Date().toISOString(),
          mode: "provision-dedupe",
        });
        dispatched += 1;
        emit(`  dispatched ${i + 1}/${toDispatch} — ${repo}`);
        if (onEvent) {
          onEvent({
            type: "progress",
            current: dispatched,
            total: toDispatch,
            repo,
            account: acct.name,
          });
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }
  saveState(cfg, state);
  if (dispatched === 0) {
    emit("Nothing to dispatch (already at target active runs).");
  } else {
    emit(`Done: ${dispatched} new run(s). Use poll or refresh for Tailscale IPs.`);
  }
}

function perAccountTarget(cfg, acct) {
  return parseInt(acct.machines_per_account || cfg.machines_per_account || 8, 10);
}

function maxConcurrentPerAccount(cfg) {
  return parseInt(cfg.max_concurrent_dispatch_per_account || cfg.machines_per_account || 8, 10);
}

/**
 * Count queued/in_progress workflow runs per repo; optionally cancel excess queued.
 */
async function reconcileAccountRuns(cfg, acct, repo, flags, emit) {
  const runs = await gh.listWorkflowRuns(acct.token, repo, cfg.workflow_id, 100);
  const active = gh.activeRuns(runs);
  const cap = Math.min(perAccountTarget(cfg, acct), maxConcurrentPerAccount(cfg));
  const queued = active.filter((r) => r.status === "queued");

  if (flags["cancel-duplicates"] && queued.length > 0) {
    const inProgress = active.length - queued.length;
    const maxQueued = Math.max(0, cap - inProgress);
    if (queued.length > maxQueued) {
      const sorted = [...queued].sort(
        (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      );
      const toCancel = sorted.slice(maxQueued);
      for (const run of toCancel) {
        emit(`Cancel extra queued run ${run.id} on ${repo} (${acct.name})`);
        await gh.cancelWorkflowRun(acct.token, repo, run.id);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
  }

  const runsAfter =
    flags["cancel-duplicates"] && queued.length > 0
      ? await gh.listWorkflowRuns(acct.token, repo, cfg.workflow_id, 100)
      : runs;
  const activeAfter = gh.activeRuns(runsAfter);
  return { activeCount: activeAfter.length, cap };
}

async function cmdProvisionFleet(cfg, flags, onEvent) {
  const emit = (msg) => {
    if (onEvent) onEvent({ type: "log", message: msg });
  };
  const state = loadState(cfg);
  const accts = fleetTargetAccounts(cfg, flags);
  if (!accts.length) {
    if (flags.account) {
      throw new Error(explainMissingAccount(cfg, flags.account));
    }
    throw new Error(
      "No provisionable GitHub accounts for fleet (enabled, real repos, gh auth or token_env)"
    );
  }

  const targetTotal = parseInt(flags.total || cfg.target_total || 80, 10);
  const plan = [];

  for (const acct of accts) {
    for (const repo of acct.repos) {
      const { activeCount, cap } = await reconcileAccountRuns(cfg, acct, repo, flags, emit);
      const accountWant = cap;
      let toDispatch = Math.max(0, accountWant - activeCount);
      plan.push({ acct, repo, activeCount, cap, toDispatch });
    }
  }

  let totalActive = plan.reduce((s, p) => s + p.activeCount, 0);
  let dispatchBudget = Math.max(0, targetTotal - totalActive);
  emit(
    `Fleet plan: ${accts.length} account(s), ${totalActive} active run(s), target ${targetTotal}, budget ${dispatchBudget} dispatch(es)`
  );

  if (dispatchBudget === 0) {
    emit("Nothing to dispatch (at or above target given active runs).");
    return;
  }

  let dispatched = 0;
  let lastGhUser = null;
  for (const row of plan) {
    if (dispatchBudget <= 0) break;
    const ghUser = row.acct.gh_user;
    if (ghUser && ghUser !== lastGhUser) {
      const sw = switchGhUserSync(ghUser, row.acct.gh_host || "github.com");
      if (!sw.ok) {
        throw new Error(`gh auth switch -u ${ghUser} failed: ${sw.message}`);
      }
      lastGhUser = ghUser;
      emit(`Using GitHub account ${ghUser} (${row.acct.name})`);
    }
    const n = Math.min(row.toDispatch, dispatchBudget);
    if (n <= 0) {
      emit(`${row.repo} (${row.acct.name}): ${row.activeCount}/${row.cap} active — skip`);
      continue;
    }
    emit(`Dispatching ${n} on ${row.repo} (${row.acct.name}), ${row.activeCount}/${row.cap} already active…`);
    for (let i = 0; i < n; i++) {
      await dispatchWithRepoError(row.acct, row.repo, cfg.workflow_id);
      state.runs.push({
        account: row.acct.name,
        repo: row.repo,
        dispatched_at: new Date().toISOString(),
        mode: "provision-fleet",
      });
      dispatched += 1;
      dispatchBudget -= 1;
      emit(`  dispatched ${i + 1}/${n} — ${row.repo}`);
      if (onEvent) {
        onEvent({
          type: "progress",
          current: dispatched,
          total: targetTotal - totalActive,
          repo: row.repo,
          account: row.acct.name,
        });
      }
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  saveState(cfg, state);
  emit(`Fleet dispatch complete: ${dispatched} new run(s). IPs will appear over ~10–20 min.`);
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
  const activeRunIds = [];
  const runsWithIpIds = [];
  for (const acct of accts) {
    if (acct.gh_user) {
      const sw = switchGhUserSync(acct.gh_user, acct.gh_host || "github.com");
      if (!sw.ok) {
        throw new Error(`gh auth switch -u ${acct.gh_user} failed: ${sw.message}`);
      }
    }
    for (const repo of acct.repos) {
      emit(`Refreshing ${repo} (${acct.name})...`);
      const runs = await gh.listWorkflowRuns(acct.token, repo, cfg.workflow_id, 50);
      for (const run of gh.activeRuns(runs)) {
        activeRunIds.push(run.id);
      }
      const withIp = await gh.collectIpsForRuns(acct.token, repo, runs);
      for (const row of withIp) {
        if (row.tailscale_ip) runsWithIpIds.push(row.run_id);
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
  const pruned = pruneMachinesToActiveRuns(state, activeRunIds, runsWithIpIds);
  if (pruned.removed > 0) {
    emit(`Pruned ${pruned.removed} stale machine row(s) (${pruned.before} → ${pruned.after}).`);
  }
  saveState(cfg, state);
  emit("Refresh complete.");
}

async function cmdCleanQueue(cfg, flags, onEvent) {
  const emit = (msg) => {
    if (onEvent) onEvent({ type: "log", message: msg });
  };
  const accts = fleetTargetAccounts(cfg, flags);
  if (!accts.length) {
    throw new Error("No enabled GitHub accounts with token and real repos in config.json");
  }

  let cancelled = 0;
  for (const acct of accts) {
    if (acct.gh_user) {
      const sw = switchGhUserSync(acct.gh_user, acct.gh_host || "github.com");
      if (!sw.ok) {
        throw new Error(`gh auth switch -u ${acct.gh_user} failed: ${sw.message}`);
      }
    }
    for (const repo of acct.repos) {
      const runs = await gh.listWorkflowRuns(acct.token, repo, cfg.workflow_id, 100);
      const active = gh.activeRuns(runs);
      emit(`${repo} (${acct.name}): cancelling ${active.length} queued/in_progress run(s)`);
      for (const run of active) {
        emit(`  cancel run ${run.id} (${run.status})`);
        await gh.cancelWorkflowRun(acct.token, repo, run.id);
        cancelled += 1;
        await new Promise((r) => setTimeout(r, 350));
      }
    }
  }
  emit(`Clean queue complete: ${cancelled} run(s) cancelled.`);
}

async function cmdPoll(cfg, flags, onEvent) {
  const emit = (msg) => {
    if (onEvent) onEvent({ type: "log", message: msg });
  };
  const minutes = parseInt(flags.minutes || cfg.poll_minutes || 20, 10);
  const targetIps = parseInt(
    flags.target || flags.count || cfg.target_total || cfg.machines_per_account || 8,
    10
  );
  const intervalSec = parseInt(flags.interval || cfg.poll_interval_seconds || 30, 10);
  const deadline = Date.now() + minutes * 60 * 1000;

  emit(`Poll: refresh every ${intervalSec}s for up to ${minutes} min (target ${targetIps} IP(s))`);
  while (Date.now() < deadline) {
    await cmdRefresh(cfg, flags, emit);
    const state = loadState(cfg);
    const ips = new Set(
      (state.machines || []).map((m) => m.tailscale_ip).filter(Boolean)
    );
    emit(`  have ${ips.size}/${targetIps} unique IP(s)`);
    if (ips.size >= targetIps) {
      emit("Poll complete: target IP count reached.");
      return;
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalSec * 1000, remaining)));
  }
  emit("Poll finished (time limit). Run status for details.");
}

function watchCooldownPath(cfg) {
  return path.join(path.dirname(cfg._statePath), ".fleet-watch-cooldown.json");
}

function readWatchCooldown(cfg) {
  const p = watchCooldownPath(cfg);
  if (!fs.existsSync(p)) return 0;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const t = Date.parse(raw.last_provision_at || "");
    return Number.isFinite(t) ? t : 0;
  } catch {
    return 0;
  }
}

function markWatchProvision(cfg) {
  const p = watchCooldownPath(cfg);
  const payload = { last_provision_at: new Date().toISOString() };
  fs.writeFileSync(p, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function countActiveForAccounts(cfg, accts) {
  let total = 0;
  for (const acct of accts) {
    if (acct.gh_user) {
      const sw = switchGhUserSync(acct.gh_user, acct.gh_host || "github.com");
      if (!sw.ok) {
        throw new Error(`gh auth switch -u ${acct.gh_user} failed: ${sw.message}`);
      }
    }
    for (const repo of acct.repos) {
      const runs = await gh.listWorkflowRuns(acct.token, repo, cfg.workflow_id, 100);
      total += gh.countActiveRuns(runs);
    }
  }
  return total;
}

async function watchMetrics(cfg, flags) {
  const accts = targetAccounts(cfg, flags);
  const accountNames = new Set(accts.map((a) => a.name));
  const repos = new Set(accts.flatMap((a) => a.repos));
  const activeTotal = await countActiveForAccounts(cfg, accts);

  const state = loadState(cfg);
  const rows = await agents.healthAll(cfg, state);
  const scoped = rows.filter(
    (m) =>
      (!m.account || accountNames.has(m.account)) && (!m.repo || repos.has(m.repo))
  );
  const withIp = scoped.filter((m) => m.tailscale_ip);
  const live = scoped.filter((m) => m.health && m.health.ok);

  return {
    activeTotal,
    liveCount: live.length,
    withIpCount: withIp.length,
    allDown: withIp.length > 0 && live.length === 0,
  };
}

/**
 * Auto-reconnect: refresh each tick; provision (dedupe) only when LIVE and active runs are below target.
 * Skips dispatch when active runs already meet target (waits for agents). Max one provision burst / 10 min.
 */
async function cmdWatch(cfg, flags, onEvent) {
  const emit = (msg) => {
    if (onEvent) onEvent({ type: "log", message: msg });
  };
  const target = parseInt(
    flags.target || flags.count || cfg.machines_per_account || 8,
    10
  );
  const intervalSec = parseInt(flags.interval || 120, 10);
  const cooldownMs = parseInt(flags["provision-cooldown-min"] || "10", 10) * 60 * 1000;
  const dryRun = !!flags["dry-run"];
  const once = !!flags.once;

  emit(
    `Watch: target ${target} LIVE, interval ${intervalSec}s, provision cooldown ${cooldownMs / 60000} min${dryRun ? " (dry-run)" : ""}`
  );

  do {
    const tickAt = new Date().toISOString();
    emit(`[${tickAt}] tick — refresh…`);
    await cmdRefresh(cfg, flags, emit);

    const m = await watchMetrics(cfg, flags);
    emit(
      `[watch] live=${m.liveCount}/${target} active_runs=${m.activeTotal} ips=${m.withIpCount}${m.allDown ? " all_DOWN" : ""}`
    );

    if (m.liveCount >= target) {
      emit(`[watch] OK — ${m.liveCount} LIVE (target ${target}).`);
    } else if (m.activeTotal >= target) {
      emit(
        `[watch] ${m.activeTotal} active run(s) ≥ target ${target} but only ${m.liveCount} LIVE — wait (no dispatch).`
      );
    } else {
      const lastProv = readWatchCooldown(cfg);
      const cooldownLeft = Math.max(0, cooldownMs - (Date.now() - lastProv));
      if (cooldownLeft > 0) {
        emit(
          `[watch] below target but provision cooldown ${Math.ceil(cooldownLeft / 1000)}s left — skip dispatch.`
        );
      } else if (m.activeTotal === 0 || m.allDown || m.activeTotal < target) {
        const reason =
          m.activeTotal === 0
            ? "no active runs"
            : m.allDown
              ? "all machines DOWN"
              : "active below target";
        if (dryRun) {
          emit(`[watch] dry-run: would provision toward ${target} (${reason}).`);
        } else {
          emit(`[watch] provision toward ${target} (${reason})…`);
          await cmdProvision(cfg, { ...flags, count: String(target) }, emit);
          markWatchProvision(cfg);
        }
      }
    }

    if (once) {
      emit("[watch] --once: exiting after one iteration.");
      return;
    }
    emit(`[watch] sleep ${intervalSec}s…`);
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  } while (true);
}

module.exports = {
  isPlaceholderRepo,
  fleetTargetAccounts,
  targetAccounts,
  listAccountOptions,
  accountsFor,
  cmdProvision,
  cmdProvisionFleet,
  cmdRefresh,
  cmdCleanQueue,
  cmdPoll,
  cmdWatch,
};

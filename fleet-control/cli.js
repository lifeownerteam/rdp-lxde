#!/usr/bin/env node
"use strict";

const { loadConfig } = require("./lib/config");
const { loadState, saveState, upsertMachine } = require("./lib/state");
const gh = require("./lib/gh");
const agents = require("./lib/agents");

function usage() {
  console.log(`Fleet control CLI

Usage:
  node cli.js provision [--account NAME] [--repo OWNER/REPO] [--count N]
  node cli.js refresh [--account NAME]
  node cli.js status [--json]
  node cli.js exec "<shell command>"
  node cli.js firefox open --url URL [--count N]
  node cli.js firefox close [--keep N]
  node cli.js firefox status
  node cli.js firefox js "<javascript>"

Copy config.example.json to config.json (gitignored). Set tokens via env vars named in config.
`);
}

function parseArgs(argv) {
  const args = [...argv];
  const flags = {};
  const positional = [];
  while (args.length) {
    const a = args[0];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[1];
      if (!next || next.startsWith("--")) {
        flags[key] = true;
        args.shift();
      } else {
        flags[key] = next;
        args.shift(2);
      }
    } else {
      positional.push(args.shift());
    }
  }
  return { flags, positional };
}

function accountsFor(cfg, accountName) {
  let list = cfg.github_accounts || [];
  if (accountName) {
    list = list.filter((a) => a.name === accountName);
  }
  return list.filter((a) => a.token);
}

async function cmdProvision(cfg, flags) {
  const state = loadState(cfg);
  const accts = accountsFor(cfg, flags.account);
  if (!accts.length) {
    throw new Error("No GitHub account with token (set token_env env vars or token in local config)");
  }
  for (const acct of accts) {
    for (const repo of acct.repos || []) {
      const count = parseInt(flags.count || acct.machines_per_account || cfg.machines_per_account || 8, 10);
      console.log(`Provisioning ${count} runs on ${repo} (${acct.name})...`);
      for (let i = 0; i < count; i++) {
        await gh.dispatchWorkflow(acct.token, repo, cfg.workflow_id);
        state.runs.push({
          account: acct.name,
          repo,
          dispatched_at: new Date().toISOString(),
        });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  saveState(cfg, state);
  console.log("Dispatched. Run: node cli.js refresh");
}

async function cmdRefresh(cfg, flags) {
  const state = loadState(cfg);
  const accts = accountsFor(cfg, flags.account);
  for (const acct of accts) {
    for (const repo of acct.repos || []) {
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
      console.log(`${repo}: ${withIp.length} runs with tailscale-ip artifact`);
    }
  }
  saveState(cfg, state);
}

async function cmdStatus(cfg, flags) {
  const state = loadState(cfg);
  const rows = await agents.healthAll(cfg, state);
  const enriched = [];
  for (const row of rows) {
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
    enriched.push({
      ip: row.tailscale_ip,
      account: row.account,
      repo: row.repo,
      run_id: row.run_id,
      live: !!(row.health && row.health.ok),
      health: row.health && row.health.body,
      metrics: metrics && metrics.body,
    });
  }
  if (flags.json) {
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }
  for (const r of enriched) {
    const m = r.metrics && r.metrics.memory ? r.metrics : null;
    const mem = m ? ` RAM ${m.memory.used_mb}/${m.memory.total_mb}MB CPU ${m.cpu_percent}%` : "";
    console.log(`${r.live ? "LIVE" : "DOWN"} ${r.tailscale_ip || "?"} ${r.account || ""}${mem}`);
  }
}

async function cmdExec(cfg, command) {
  if (!command) throw new Error("exec requires a command string");
  const state = loadState(cfg);
  const results = await agents.execAll(cfg, state, command);
  for (const r of results) {
    const ex = r.exec || {};
    console.log(`\n=== ${r.tailscale_ip} (exit ${ex.body && ex.body.exit_code}) ===`);
    if (ex.body) {
      if (ex.body.stdout) process.stdout.write(ex.body.stdout);
      if (ex.body.stderr) process.stderr.write(ex.body.stderr);
      if (ex.body.error) console.error(ex.body.error);
    }
  }
}

async function cmdFirefox(cfg, sub, flags, positional) {
  const state = loadState(cfg);
  if (sub === "open") {
    const url = flags.url || positional[0];
    const count = parseInt(flags.count || "1", 10);
    const results = await agents.firefoxAll(cfg, state, "/firefox/open", { url, count });
    printFirefoxResults(results);
    return;
  }
  if (sub === "close") {
    const keep = parseInt(flags.keep || "1", 10);
    const results = await agents.firefoxAll(cfg, state, "/firefox/close", { all: true, keep });
    printFirefoxResults(results);
    return;
  }
  if (sub === "status") {
    const live = (state.machines || []).filter((m) => m.tailscale_ip);
    for (const m of live) {
      const r = await agents.agentRequest(
        m.tailscale_ip,
        cfg.agent_port || 8765,
        cfg.fleet_agent_token,
        "GET",
        "/firefox/status"
      );
      console.log(m.tailscale_ip, JSON.stringify(r.body));
    }
    return;
  }
  if (sub === "js") {
    const script = flags.script || positional.join(" ");
    const results = await agents.firefoxAll(cfg, state, "/firefox/js", { script });
    printFirefoxResults(results);
    return;
  }
  throw new Error(`Unknown firefox subcommand: ${sub}`);
}

function printFirefoxResults(results) {
  for (const r of results) {
    console.log(r.tailscale_ip, JSON.stringify(r.firefox && r.firefox.body));
  }
}

async function main() {
  const { flags, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || flags.help) {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  const cfg = loadConfig();
  try {
    if (cmd === "provision") await cmdProvision(cfg, flags);
    else if (cmd === "refresh") await cmdRefresh(cfg, flags);
    else if (cmd === "status") await cmdStatus(cfg, flags);
    else if (cmd === "exec") await cmdExec(cfg, positional.slice(1).join(" ") || flags._);
    else if (cmd === "firefox") await cmdFirefox(cfg, positional[1], flags, positional.slice(2));
    else {
      usage();
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  }
}

main();

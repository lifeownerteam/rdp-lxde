#!/usr/bin/env node
"use strict";

const { loadConfig } = require("./lib/config");
const { loadState } = require("./lib/state");
const {
  cmdProvision,
  cmdProvisionFleet,
  cmdRefresh,
  cmdCleanQueue,
  cmdPoll,
} = require("./lib/commands");
const { buildFleetStatus, printHumanTable } = require("./lib/fleet-status");
const agents = require("./lib/agents");

function usage() {
  console.log(`Fleet control CLI

Usage:
  node cli.js provision [--account NAME] [--count N|8|80] [--fleet]
  node cli.js provision-fleet [--account NAME] [--total N] [--cancel-duplicates]
  node cli.js clean-queue [--account NAME]
  node cli.js poll [--minutes N] [--target N] [--account NAME]
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

async function runProvisionCli(cfg, flags) {
  await cmdProvision(cfg, flags, (ev) => {
    if (ev.type === "log") console.log(ev.message);
  });
}

async function runProvisionFleetCli(cfg, flags) {
  await cmdProvisionFleet(cfg, flags, (ev) => {
    if (ev.type === "log") console.log(ev.message);
  });
}

async function runRefreshCli(cfg, flags) {
  await cmdRefresh(cfg, flags, (ev) => {
    if (ev.type === "log") console.log(ev.message);
  });
}

async function cmdStatus(cfg, flags) {
  const report = await buildFleetStatus(cfg);
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printHumanTable(report);
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
    if (cmd === "provision") await runProvisionCli(cfg, flags);
    else if (cmd === "provision-fleet") await runProvisionFleetCli(cfg, flags);
    else if (cmd === "refresh") await runRefreshCli(cfg, flags);
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

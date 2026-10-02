#!/usr/bin/env node
"use strict";

/**
 * Restart fleet-agent inside rdp-lxde via GHA host docker exec (Tailscale SSH).
 * Safe: does not pkill via fleet /exec (avoids self-kill). Requires Tailscale SSH to gh-runner-*.
 *
 * Usage: node restore-agent-docker-exec.js [IP ...]
 * Env: FLEET_AGENT_TOKEN or fleet-control/config.json fleet_agent_token
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { loadConfig } = require("../lib/config");
const { loadState } = require("../lib/state");
const agents = require("../lib/agents");

const CONTAINER = "rdp-lxde";
const RDP_USER = process.env.FLEET_RDP_USER || "RDP";

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function dockerStartCmd(token) {
  const t = shellQuote(token);
  const u = shellQuote(RDP_USER);
  return [
    `docker exec ${CONTAINER} pkill -f 'python3 /opt/fleet-agent/server.py' 2>/dev/null || true`,
    "sleep 1",
    `docker exec -d -e FLEET_AGENT_TOKEN=${t} -e FLEET_RDP_USER=${u} -e FLEET_AGENT_PORT=8765 ${CONTAINER} python3 /opt/fleet-agent/server.py`,
    "sleep 2",
    `docker exec ${CONTAINER} curl -fsS http://127.0.0.1:8765/health`,
  ].join(" && ");
}

function tailscaleSsh(host, remoteCmd) {
  return spawnSync("tailscale", ["ssh", `runner@${host}`, remoteCmd], {
    encoding: "utf8",
    timeout: 120000,
    shell: false,
  });
}

async function health(ip, token) {
  const r = await agents.agentRequest(ip, 8765, token, "GET", "/health");
  return r.ok;
}

async function main() {
  const cfg = loadConfig();
  const token = cfg.fleet_agent_token;
  if (!token) throw new Error("fleet_agent_token missing");

  let ips = process.argv.slice(2).filter(Boolean);
  if (!ips.length) {
    const state = loadState(cfg);
    ips = (state.machines || [])
      .filter((m) => m.run_status === "in_progress" && m.tailscale_ip)
      .map((m) => m.tailscale_ip);
  }

  const remote = dockerStartCmd(token);
  const results = [];

  for (const ip of ips) {
    if (await health(ip, token)) {
      results.push({ ip, ok: true, method: "already-up" });
      continue;
    }
    const ssh = tailscaleSsh(ip, remote);
    await new Promise((r) => setTimeout(r, 3000));
    const up = await health(ip, token);
    results.push({
      ip,
      ok: up,
      method: "tailscale-ssh-docker",
      ssh_status: ssh.status,
      ssh_stdout: (ssh.stdout || "").trim().slice(0, 200),
      ssh_stderr: (ssh.stderr || "").trim().slice(0, 200),
    });
  }

  const ok = results.filter((r) => r.ok).length;
  console.log(JSON.stringify({ ok, total: results.length, results }, null, 2));
  process.exit(ok === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

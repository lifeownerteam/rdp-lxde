#!/usr/bin/env node
"use strict";

/**
 * Restart fleet-agent inside rdp-lxde via GHA host docker exec (Tailscale SSH).
 * Safe: does not pkill via fleet /exec (avoids self-kill). Requires Tailscale SSH to gh-runner-*.
 *
 * Usage: node restore-agent-docker-exec.js [IP ...]
 * Env: FLEET_AGENT_TOKEN or fleet-control/config.json fleet_agent_token
 */

const os = require("os");
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

function tailnetSuffixFromStatus() {
  const st = spawnSync("tailscale", ["status", "--json"], { encoding: "utf8", timeout: 15000 });
  if (st.status !== 0 || !st.stdout) return null;
  try {
    const j = JSON.parse(st.stdout);
    const selfDns = (j.Self && j.Self.DNSName) || "";
    const m = selfDns.match(/\.([a-z0-9-]+\.ts\.net)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Pre-populate OpenSSH known_hosts for gh-runner MagicDNS (tailscale ssh strict check). */
function ensureSshHostKey(runId, ip) {
  const suffix = tailnetSuffixFromStatus();
  if (!suffix || !runId) return;
  const host = `gh-runner-${runId}.${suffix}`;
  const scan = spawnSync("ssh-keyscan", ["-t", "ed25519", host], {
    encoding: "utf8",
    timeout: 20000,
    shell: false,
  });
  if (!(scan.stdout || "").includes("ssh-ed25519")) return;
  const kh = path.join(os.homedir(), ".ssh", "known_hosts");
  const existing = spawnSync("ssh-keygen", ["-F", host], { encoding: "utf8" });
  if (existing.stdout && existing.stdout.trim()) return;
  const fs = require("fs");
  fs.mkdirSync(path.dirname(kh), { recursive: true });
  fs.appendFileSync(kh, scan.stdout, "utf8");
}

function tailscaleSsh(host, remoteCmd, runId) {
  ensureSshHostKey(runId, host);
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

  const state = loadState(cfg);
  let targets = process.argv.slice(2).filter(Boolean).map((ip) => ({ ip, run_id: null }));
  if (!targets.length) {
    targets = (state.machines || [])
      .filter((m) => m.run_status === "in_progress" && m.tailscale_ip)
      .map((m) => ({ ip: m.tailscale_ip, run_id: m.run_id }));
  } else {
    targets = targets.map((ip) => {
      const row = (state.machines || []).find((m) => m.tailscale_ip === ip);
      return { ip, run_id: row && row.run_id };
    });
  }

  const remote = dockerStartCmd(token);
  const results = [];

  for (const { ip, run_id: runId } of targets) {
    if (await health(ip, token)) {
      results.push({ ip, ok: true, method: "already-up" });
      continue;
    }
    const ssh = tailscaleSsh(ip, remote, runId);
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

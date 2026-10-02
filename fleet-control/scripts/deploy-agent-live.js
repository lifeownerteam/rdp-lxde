#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../lib/config");
const { loadState } = require("../lib/state");
const agents = require("../lib/agents");

const agentDir = path.join(__dirname, "..", "fleet-agent");
const ffB64 = fs.readFileSync(path.join(agentDir, "firefox_ctl.py")).toString("base64");
const svB64 = fs.readFileSync(path.join(agentDir, "server.py")).toString("base64");

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildWriteCmd() {
  return `
python3 - <<'PY'
import base64, pathlib
pathlib.Path("/opt/fleet-agent/firefox_ctl.py").write_bytes(base64.b64decode("${ffB64}"))
pathlib.Path("/opt/fleet-agent/server.py").write_bytes(base64.b64decode("${svB64}"))
PY
echo fleet-agent files updated
`.trim();
}

function buildRestartCmd(token, rdpUser) {
  const t = shellQuote(token);
  const u = shellQuote(rdpUser || "RDP");
  // Deferred restart: return before pkill so this /exec request is not self-killed.
  return `
nohup bash -c 'sleep 1; pkill -f '"'"'python3 /opt/fleet-agent/server.py'"'"' || true; sleep 1; exec env FLEET_AGENT_TOKEN=${t} FLEET_RDP_USER=${u} FLEET_AGENT_PORT=8765 python3 /opt/fleet-agent/server.py >>/tmp/fleet-agent.log 2>&1' >/dev/null 2>&1 &
echo deferred-restart-scheduled
`.trim();
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.fleet_agent_token) {
    throw new Error("fleet_agent_token missing (set fleet_agent_token or FLEET_AGENT_TOKEN env)");
  }
  const state = loadState(cfg);
  const ips = process.argv.slice(2);

  let writeResults;
  let restartResults;
  const port = cfg.agent_port || 8765;
  const restartCmd = buildRestartCmd(cfg.fleet_agent_token, process.env.FLEET_RDP_USER || "RDP");

  if (ips.length) {
    writeResults = await Promise.all(
      ips.map(async (ip) => ({
        tailscale_ip: ip,
        exec: await agents.agentRequest(ip, port, cfg.fleet_agent_token, "POST", "/exec", {
          command: buildWriteCmd(),
        }),
      }))
    );
    await new Promise((r) => setTimeout(r, 1500));
    restartResults = await Promise.all(
      ips.map(async (ip) => ({
        tailscale_ip: ip,
        exec: await agents.agentRequest(ip, port, cfg.fleet_agent_token, "POST", "/exec", {
          command: restartCmd,
        }),
      }))
    );
  } else {
    writeResults = await agents.execAll(cfg, state, buildWriteCmd(), { liveOnly: true });
    await new Promise((r) => setTimeout(r, 1500));
    restartResults = await agents.execAll(cfg, state, restartCmd, { liveOnly: true });
  }

  const writePacked = agents.packResults(writeResults, "exec");
  const restartPacked = agents.packResults(restartResults, "exec");
  for (const r of restartPacked.results) {
    const w = writePacked.results.find((x) => x.ip === r.ip);
    console.log(
      r.ip,
      w && w.ok ? "write-ok" : "write-fail",
      r.ok ? "restart-ok" : "restart-fail",
      r.body && r.body.stdout ? r.body.stdout.trim().slice(0, 80) : r.body
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

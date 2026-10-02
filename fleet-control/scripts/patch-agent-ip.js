#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../lib/config");
const agents = require("../lib/agents");

const ip = process.argv[2];
if (!ip) {
  console.error("usage: node patch-agent-ip.js TAILSCALE_IP");
  process.exit(1);
}

const agentDir = path.join(__dirname, "..", "fleet-agent");
const ffB64 = fs.readFileSync(path.join(agentDir, "firefox_ctl.py")).toString("base64");
const svB64 = fs.readFileSync(path.join(agentDir, "server.py")).toString("base64");

async function main() {
  const cfg = loadConfig();
  const token = cfg.fleet_agent_token;
  const writeCmd = `python3 - <<'PY'
import base64, pathlib
pathlib.Path("/opt/fleet-agent/firefox_ctl.py").write_bytes(base64.b64decode("${ffB64}"))
pathlib.Path("/opt/fleet-agent/server.py").write_bytes(base64.b64decode("${svB64}"))
PY`;
  const w = await agents.agentRequest(ip, 8765, token, "POST", "/exec", { command: writeCmd });
  console.log("write", w.ok, w.body);
  const restartCmd = `
pkill -f 'python3 /opt/fleet-agent/server.py' || true
sleep 1
nohup env FLEET_AGENT_TOKEN='${token.replace(/'/g, `'\\''`)}' FLEET_RDP_USER=RDP python3 /opt/fleet-agent/server.py >>/tmp/fleet-agent.log 2>&1 &
sleep 2
curl -fsS http://127.0.0.1:8765/health
`.trim();
  const r = await agents.agentRequest(ip, 8765, token, "POST", "/exec", { command: restartCmd });
  console.log("restart", r.ok, r.body);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

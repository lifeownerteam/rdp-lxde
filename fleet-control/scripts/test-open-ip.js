#!/usr/bin/env node
"use strict";

const { loadConfig } = require("../lib/config");
const agents = require("../lib/agents");

const ip = process.argv[2];
const url = process.argv[3] || "about:blank";

async function main() {
  const cfg = loadConfig();
  const r = await agents.agentRequest(ip, 8765, cfg.fleet_agent_token, "POST", "/firefox/open", { url });
  console.log(JSON.stringify(r, null, 2));
}

main();

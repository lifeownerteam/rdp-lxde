"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function loadConfig() {
  const cfgPath =
    process.env.FLEET_CONFIG ||
    path.join(ROOT, fs.existsSync(path.join(ROOT, "config.json")) ? "config.json" : "config.example.json");
  let raw = fs.readFileSync(cfgPath, "utf8");
  if (raw.charCodeAt(0) === 0xfeff) {
    raw = raw.slice(1);
  }
  const cfg = JSON.parse(raw);

  const tokenEnv = cfg.fleet_agent_token_env || "FLEET_AGENT_TOKEN";
  if (process.env[tokenEnv]) {
    cfg.fleet_agent_token = process.env[tokenEnv];
  }

  for (const acct of cfg.github_accounts || []) {
    if (acct.token_env && process.env[acct.token_env]) {
      acct.token = process.env[acct.token_env];
    }
  }

  for (const entry of (cfg.tailscale && cfg.tailscale.api_keys) || []) {
    if (entry.key_env && process.env[entry.key_env]) {
      entry.api_key = process.env[entry.key_env];
    }
  }

  cfg._path = cfgPath;
  cfg._statePath = path.isAbsolute(cfg.state_file)
    ? cfg.state_file
    : path.join(path.dirname(cfgPath), cfg.state_file || "fleet-state.json");
  return cfg;
}

module.exports = { loadConfig, ROOT };

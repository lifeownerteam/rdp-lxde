"use strict";

const http = require("http");

function agentRequest(host, port, token, method, path, body) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: host,
        port,
        path,
        method,
        timeout: 130000,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = { raw: text };
          }
          resolve({
            host,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: json,
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ host, ok: false, status: 0, body: { error: "timeout" } });
    });
    req.on("error", (err) => {
      resolve({ host, ok: false, status: 0, body: { error: err.message } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function mapLiveMachines(cfg, state, fn) {
  const port = cfg.agent_port || 8765;
  const token = cfg.fleet_agent_token;
  const live = (state.machines || []).filter((m) => m.tailscale_ip);
  return Promise.all(
    live.map(async (m) => {
      const host = m.tailscale_ip;
      const result = await fn(host, port, token, m);
      return { ...m, ...result };
    })
  );
}

async function healthAll(cfg, state) {
  return mapLiveMachines(cfg, state, async (host, port, token) => {
    const r = await agentRequest(host, port, token, "GET", "/health");
    return { health: r };
  });
}

async function metricsAll(cfg, state) {
  return mapLiveMachines(cfg, state, async (host, port, token) => {
    const r = await agentRequest(host, port, token, "GET", "/metrics");
    return { metrics: r };
  });
}

async function execAll(cfg, state, command) {
  return mapLiveMachines(cfg, state, async (host, port, token) => {
    const r = await agentRequest(host, port, token, "POST", "/exec", { command });
    return { exec: r };
  });
}

async function firefoxAll(cfg, state, subpath, body) {
  return mapLiveMachines(cfg, state, async (host, port, token) => {
    const r = await agentRequest(host, port, token, "POST", subpath, body);
    return { firefox: r };
  });
}

module.exports = {
  agentRequest,
  healthAll,
  metricsAll,
  execAll,
  firefoxAll,
};

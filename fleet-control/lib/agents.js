"use strict";

const http = require("http");

const DEFAULT_AGENT_TIMEOUT_MS = 130000;
const SUMMARY_PROBE_TIMEOUT_MS = 5000;

function agentRequest(host, port, token, method, path, body, timeoutMs = DEFAULT_AGENT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      resolve(result);
    };
    const req = http.request(
      {
        hostname: host,
        port,
        path,
        method,
        timeout: timeoutMs,
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
          finish({
            host,
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: json,
          });
        });
      }
    );
    const hardTimer = setTimeout(() => {
      req.destroy();
      finish({ host, ok: false, status: 0, body: { error: "timeout" } });
    }, timeoutMs);
    req.on("timeout", () => {
      req.destroy();
      finish({ host, ok: false, status: 0, body: { error: "timeout" } });
    });
    req.on("error", (err) => {
      finish({ host, ok: false, status: 0, body: { error: err.message } });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

async function filterMachines(cfg, state, { ips, liveOnly = false } = {}) {
  let machines = (state.machines || []).filter((m) => m.tailscale_ip);
  if (ips && Array.isArray(ips) && ips.length) {
    const set = new Set(ips.map(String));
    machines = machines.filter((m) => set.has(m.tailscale_ip));
  }
  if (liveOnly) {
    const port = cfg.agent_port || 8765;
    const token = cfg.fleet_agent_token;
    const checked = await Promise.all(
      machines.map(async (m) => {
        const r = await agentRequest(m.tailscale_ip, port, token, "GET", "/health");
        return r.ok ? m : null;
      })
    );
    machines = checked.filter(Boolean);
  }
  return machines;
}

async function mapMachines(cfg, state, opts, fn) {
  const port = cfg.agent_port || 8765;
  const token = cfg.fleet_agent_token;
  const machines = await filterMachines(cfg, state, opts);
  return Promise.all(
    machines.map(async (m) => {
      const host = m.tailscale_ip;
      const result = await fn(host, port, token, m);
      return { ...m, ...result };
    })
  );
}

async function mapLiveMachines(cfg, state, fn, opts = {}) {
  return mapMachines(cfg, state, { liveOnly: false, ...opts }, fn);
}

async function healthAll(cfg, state, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  return mapLiveMachines(cfg, state, opts, async (host, port, token) => {
    const r = await agentRequest(host, port, token, "GET", "/health", null, timeoutMs);
    return { health: r };
  });
}

async function metricsAll(cfg, state, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  return mapLiveMachines(cfg, state, opts, async (host, port, token) => {
    const r = await agentRequest(host, port, token, "GET", "/metrics", null, timeoutMs);
    return { metrics: r };
  });
}

async function summaryAll(cfg, state) {
  const port = cfg.agent_port || 8765;
  const token = cfg.fleet_agent_token;
  const timeoutMs = SUMMARY_PROBE_TIMEOUT_MS;
  const machines = (state.machines || []).filter((m) => m.tailscale_ip);
  return Promise.all(
    machines.map(async (m) => {
      const host = m.tailscale_ip;
      const [health, metrics] = await Promise.all([
        agentRequest(host, port, token, "GET", "/health", null, timeoutMs),
        agentRequest(host, port, token, "GET", "/metrics", null, timeoutMs),
      ]);
      return { ...m, health, metrics };
    })
  );
}

async function execAll(cfg, state, command, opts = {}) {
  return mapMachines(cfg, state, opts, async (host, port, token) => {
    const r = await agentRequest(host, port, token, "POST", "/exec", { command });
    return { exec: r };
  });
}

async function firefoxAll(cfg, state, subpath, body, opts = {}) {
  const method = opts.method || "POST";
  return mapMachines(cfg, state, opts, async (host, port, token) => {
    const r = await agentRequest(host, port, token, method, subpath, method === "POST" ? body : null);
    return { firefox: r };
  });
}

function packResults(results, key) {
  return {
    targeted: results.map((r) => r.tailscale_ip),
    results: results.map((r) => {
      const block = r[key] || {};
      return {
        ip: r.tailscale_ip,
        ok: !!block.ok,
        status: block.status,
        body: block.body,
      };
    }),
  };
}

module.exports = {
  agentRequest,
  filterMachines,
  healthAll,
  metricsAll,
  summaryAll,
  execAll,
  firefoxAll,
  packResults,
  SUMMARY_PROBE_TIMEOUT_MS,
};

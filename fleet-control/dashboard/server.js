"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../lib/config");
const { loadState } = require("../lib/state");
const agents = require("../lib/agents");
const { cmdProvision, cmdRefresh, listAccountOptions } = require("../lib/commands");
const { spawnGhAuthLogin, getGitHubAuthStatus } = require("../lib/gh-local");
const jobs = require("../lib/jobs");

const cfg = loadConfig();
const bind = (cfg.dashboard && cfg.dashboard.bind) || "127.0.0.1";
const port = (cfg.dashboard && cfg.dashboard.port) || 8780;
const publicDir = path.join(__dirname, "public");

function sendJson(res, code, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(data);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

async function apiSummary() {
  const state = loadState(cfg);
  const health = await agents.healthAll(cfg, state);
  const metrics = await agents.metricsAll(cfg, state);
  const byIp = {};
  for (const h of health) {
    byIp[h.tailscale_ip] = {
      ip: h.tailscale_ip,
      account: h.account,
      repo: h.repo,
      run_id: h.run_id,
      live: !!(h.health && h.health.ok),
    };
  }
  for (const m of metrics) {
    if (!byIp[m.tailscale_ip]) continue;
    byIp[m.tailscale_ip].metrics = m.metrics && m.metrics.body;
  }
  return { machines: Object.values(byIp), updated_at: new Date().toISOString() };
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/summary" && req.method === "GET") {
    try {
      sendJson(res, 200, await apiSummary());
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/accounts" && req.method === "GET") {
    try {
      sendJson(res, 200, { accounts: listAccountOptions(cfg) });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/github/status" && req.method === "GET") {
    try {
      sendJson(res, 200, await getGitHubAuthStatus());
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/github/connect" && req.method === "POST") {
    try {
      const result = spawnGhAuthLogin();
      sendJson(res, 200, {
        ok: true,
        message: "Άνοιξε νέο παράθυρο τερματικού για σύνδεση GitHub (browser / device code).",
        ...result,
      });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/provision" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const count = body.count != null ? String(body.count) : "8";
      const flags = { count, account: body.account };
      const started = await jobs.startProvision(cfg, flags, cmdProvision);
      if (!started.started) {
        sendJson(res, 409, started);
        return;
      }
      sendJson(res, 202, { ok: true, ...started });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/provision/status" && req.method === "GET") {
    sendJson(res, 200, jobs.getProvisionJob());
    return;
  }

  if (url === "/api/refresh" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const flags = { account: body.account };
      const started = await jobs.startRefresh(cfg, flags, cmdRefresh);
      if (!started.started) {
        sendJson(res, 409, started);
        return;
      }
      sendJson(res, 202, { ok: true, ...started });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/refresh/status" && req.method === "GET") {
    sendJson(res, 200, jobs.getRefreshJob());
    return;
  }

  let file = url === "/" ? "/index.html" : url;
  if (file === "/gui" || file === "/fleet-gui.html") file = "/index.html";
  const fp = path.join(publicDir, file);
  if (!fp.startsWith(publicDir) || !fs.existsSync(fp)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(fp);
  const type = ext === ".html" ? "text/html" : ext === ".js" ? "text/javascript" : "text/plain";
  res.writeHead(200, { "Content-Type": type });
  fs.createReadStream(fp).pipe(res);
});

server.listen(port, bind, () => {
  console.log(`Fleet dashboard http://${bind}:${port}/`);
});

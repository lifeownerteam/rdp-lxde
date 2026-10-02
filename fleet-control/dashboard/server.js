"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../lib/config");
const { loadState } = require("../lib/state");
const agents = require("../lib/agents");

const cfg = loadConfig();
const bind = (cfg.dashboard && cfg.dashboard.bind) || "127.0.0.1";
const port = (cfg.dashboard && cfg.dashboard.port) || 8780;
const publicDir = path.join(__dirname, "public");

function sendJson(res, code, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(data);
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
  if (req.url === "/api/summary") {
    try {
      sendJson(res, 200, await apiSummary());
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }
  let file = req.url === "/" ? "/index.html" : req.url.split("?")[0];
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

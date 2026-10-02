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
  const rows = await agents.summaryAll(cfg, state);
  const machines = rows.map((row) => ({
    ip: row.tailscale_ip,
    account: row.account,
    repo: row.repo,
    run_id: row.run_id,
    run_status: row.run_status,
    live: !!(row.health && row.health.ok),
    metrics: row.metrics && row.metrics.ok ? row.metrics.body : null,
  }));
  return {
    machines,
    state_updated_at: state.updated_at || null,
    updated_at: new Date().toISOString(),
  };
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

  function targetOpts(body) {
    const ips = body.ips;
    if (Array.isArray(ips) && ips.length) {
      return { ips, liveOnly: false };
    }
    return { liveOnly: true };
  }

  if (url === "/api/firefox/open" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const state = loadState(cfg);
      const opts = targetOpts(body);
      const count = body.count != null ? parseInt(body.count, 10) : 1;
      const payload = { url: body.url, count: Number.isFinite(count) ? count : 1 };
      let results = await agents.firefoxAll(cfg, state, "/firefox/open", payload, opts);
      let packed = agents.packResults(results, "firefox");
      const failedIps = packed.results.filter((r) => !r.ok).map((r) => r.ip);
      if (failedIps.length && body.url && body.exec_fallback !== false) {
        const disp = body.display || ":10";
        const urlEsc = String(body.url).replace(/'/g, `'\\''`);
        const cmd = `DISPLAY=${disp} su - RDP -c '/opt/firefox/firefox -new-tab '\\''${urlEsc}'\\'' >/dev/null 2>&1 &'`;
        const fb = await agents.execAll(cfg, state, cmd, { ips: failedIps, liveOnly: false });
        const fbPacked = agents.packResults(fb, "exec");
        packed = {
          ...packed,
          exec_fallback: fbPacked.results,
          results: packed.results.map((r) => {
            if (r.ok) return r;
            const fbRow = fbPacked.results.find((x) => x.ip === r.ip);
            if (fbRow && fbRow.ok && fbRow.body && fbRow.body.exit_code === 0) {
              return { ...r, ok: true, fallback: "exec", exec: fbRow.body };
            }
            return r;
          }),
        };
      }
      sendJson(res, 200, { ok: true, ...packed });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/firefox/close" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const state = loadState(cfg);
      const opts = targetOpts(body);
      const keep = body.keep != null ? parseInt(body.keep, 10) : 1;
      const results = await agents.firefoxAll(
        cfg,
        state,
        "/firefox/close",
        { all: true, keep: Number.isFinite(keep) ? keep : 1 },
        opts
      );
      sendJson(res, 200, { ok: true, ...agents.packResults(results, "firefox") });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/firefox/status" && req.method === "GET") {
    try {
      const state = loadState(cfg);
      const results = await agents.firefoxAll(cfg, state, "/firefox/status", null, {
        liveOnly: true,
        method: "GET",
      });
      sendJson(res, 200, { ok: true, ...agents.packResults(results, "firefox") });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/firefox/js" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.script) {
        sendJson(res, 400, { error: "script required" });
        return;
      }
      const state = loadState(cfg);
      const opts = targetOpts(body);
      const results = await agents.firefoxAll(cfg, state, "/firefox/js", { script: body.script }, opts);
      sendJson(res, 200, { ok: true, ...agents.packResults(results, "firefox") });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url === "/api/exec" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      if (!body.command) {
        sendJson(res, 400, { error: "command required" });
        return;
      }
      const state = loadState(cfg);
      const opts = targetOpts(body);
      const results = await agents.execAll(cfg, state, body.command, opts);
      sendJson(res, 200, { ok: true, ...agents.packResults(results, "exec") });
    } catch (err) {
      sendJson(res, 500, { error: String(err.message || err) });
    }
    return;
  }

  if (url.startsWith("/api/")) {
    sendJson(res, 404, {
      error: `Δεν βρέθηκε το API ${req.method} ${url}`,
    });
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

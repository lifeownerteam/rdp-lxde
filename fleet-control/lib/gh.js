"use strict";

const https = require("https");

function ghRequest(token, method, urlPath, body, host = "api.github.com") {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        hostname: host,
        path: urlPath,
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "fleet-control-cli",
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
            json = text ? JSON.parse(text) : null;
          } catch {
            json = { raw: text };
          }
          if (res.statusCode >= 400) {
            const snippet = text.slice(0, 500);
            if (res.statusCode === 404) {
              reject(
                new Error(
                  `GitHub 404: repository or workflow not found — ${urlPath} — ${snippet}`
                )
              );
              return;
            }
            reject(new Error(`GitHub ${res.statusCode}: ${snippet}`));
            return;
          }
          resolve({ status: res.statusCode, json, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function dispatchWorkflow(token, repo, workflowId, ref = "main") {
  const [owner, name] = repo.split("/");
  const path = `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`;
  await ghRequest(token, "POST", path, { ref });
}

async function listWorkflowRuns(token, repo, workflowId, perPage = 30) {
  const [owner, name] = repo.split("/");
  const path = `/repos/${owner}/${name}/actions/workflows/${encodeURIComponent(workflowId)}/runs?per_page=${perPage}`;
  const { json } = await ghRequest(token, "GET", path);
  return json.workflow_runs || [];
}

async function downloadArtifactZip(token, repo, artifactId) {
  const [owner, name] = repo.split("/");
  const meta = await ghRequest(
    token,
    "GET",
    `/repos/${owner}/${name}/actions/artifacts/${artifactId}/zip`
  );
  const loc = meta.headers.location;
  if (!loc) throw new Error("No redirect for artifact zip");
  const url = new URL(loc);
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
        }
      )
      .on("error", reject);
  });
}

function extractTailscaleIpFromZip(zipBuf) {
  // MVP: artifact is tiny text file; search for IPv4 in zip binary
  const text = zipBuf.toString("latin1");
  const m = text.match(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  return m ? m[0] : null;
}

async function collectIpsForRuns(token, repo, runs) {
  const out = [];
  for (const run of runs) {
    const [owner, name] = repo.split("/");
    const { json } = await ghRequest(
      token,
      "GET",
      `/repos/${owner}/${name}/actions/runs/${run.id}/artifacts?per_page=20`
    );
    const art = (json.artifacts || []).find((a) => a.name === "tailscale-ip");
    if (!art) continue;
    const zip = await downloadArtifactZip(token, repo, art.id);
    const ip = extractTailscaleIpFromZip(zip);
    if (ip) {
      out.push({ run_id: run.id, tailscale_ip: ip, status: run.status, conclusion: run.conclusion });
    }
  }
  return out;
}

module.exports = {
  dispatchWorkflow,
  listWorkflowRuns,
  collectIpsForRuns,
};

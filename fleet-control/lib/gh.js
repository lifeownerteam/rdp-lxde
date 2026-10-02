"use strict";

const https = require("https");
const zlib = require("zlib");

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

function isActiveRun(run) {
  const s = (run && run.status) || "";
  return s === "queued" || s === "in_progress" || s === "waiting" || s === "pending";
}

function countActiveRuns(runs) {
  return (runs || []).filter(isActiveRun).length;
}

function activeRuns(runs) {
  return (runs || []).filter(isActiveRun);
}

async function cancelWorkflowRun(token, repo, runId) {
  const [owner, name] = repo.split("/");
  const path = `/repos/${owner}/${name}/actions/runs/${runId}/cancel`;
  await ghRequest(token, "POST", path);
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
  const blobHeaders =
    url.hostname === "api.github.com"
      ? { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" }
      : {};
  return new Promise((resolve, reject) => {
    https
      .get(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          headers: blobHeaders,
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
  const text = zipBuf.toString("latin1");
  let m = text.match(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  if (m) return m[0];
  const idx = zipBuf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (idx < 0) return null;
  const flags = zipBuf.readUInt16LE(idx + 6);
  const method = zipBuf.readUInt16LE(idx + 8);
  let compSize = zipBuf.readUInt32LE(idx + 18);
  const nameLen = zipBuf.readUInt16LE(idx + 26);
  const extraLen = zipBuf.readUInt16LE(idx + 28);
  const dataStart = idx + 30 + nameLen + extraLen;
  let compEnd = dataStart + compSize;
  if (compSize === 0 && (flags & 0x8)) {
    const dd = zipBuf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), dataStart);
    if (dd > dataStart) {
      compEnd = dd;
      compSize = dd - dataStart;
    }
  }
  const comp = zipBuf.slice(dataStart, compEnd);
  try {
    const raw = method === 0 ? comp : zlib.inflateRawSync(comp);
    m = raw.toString("utf8").match(/\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
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
  isActiveRun,
  countActiveRuns,
  activeRuns,
  cancelWorkflowRun,
};

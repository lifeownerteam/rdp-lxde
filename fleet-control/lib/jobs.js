"use strict";

let provisionJob = idleJob();
let refreshJob = idleJob();

function idleJob() {
  return { running: false, logs: [], error: null, progress: null };
}

function appendLog(job, message) {
  job.logs.push({ at: new Date().toISOString(), message });
  if (job.logs.length > 200) job.logs.shift();
}

function onProvisionEvent(job, ev) {
  if (ev.type === "log") appendLog(job, ev.message);
  if (ev.type === "progress") job.progress = ev;
}

function onRefreshEvent(job, ev) {
  if (ev.type === "log") appendLog(job, ev.message);
}

function getProvisionJob() {
  return { ...provisionJob, logs: [...provisionJob.logs] };
}

function getRefreshJob() {
  return { ...refreshJob, logs: [...refreshJob.logs] };
}

async function startProvision(cfg, flags, runProvision) {
  if (provisionJob.running) {
    return { started: false, reason: "provision already running" };
  }
  provisionJob = idleJob();
  provisionJob.running = true;
  appendLog(provisionJob, "Starting provision…");
  setImmediate(async () => {
    try {
      await runProvision(cfg, flags, (ev) => onProvisionEvent(provisionJob, ev));
    } catch (err) {
      provisionJob.error = String(err.message || err);
      appendLog(provisionJob, "Error: " + provisionJob.error);
    } finally {
      provisionJob.running = false;
    }
  });
  return { started: true };
}

async function startRefresh(cfg, flags, runRefresh) {
  if (refreshJob.running) {
    return { started: false, reason: "refresh already running" };
  }
  refreshJob = idleJob();
  refreshJob.running = true;
  appendLog(refreshJob, "Starting refresh…");
  setImmediate(async () => {
    try {
      await runRefresh(cfg, flags, (ev) => onRefreshEvent(refreshJob, ev));
    } catch (err) {
      refreshJob.error = String(err.message || err);
      appendLog(refreshJob, "Error: " + refreshJob.error);
    } finally {
      refreshJob.running = false;
    }
  });
  return { started: true };
}

module.exports = {
  getProvisionJob,
  getRefreshJob,
  startProvision,
  startRefresh,
};

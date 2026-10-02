"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_STATE = () => ({ machines: [], runs: [] });

function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return DEFAULT_STATE();
  }
  return {
    machines: Array.isArray(raw.machines) ? raw.machines : [],
    runs: Array.isArray(raw.runs) ? raw.runs : [],
  };
}

function loadState(cfg) {
  const p = cfg._statePath;
  if (!fs.existsSync(p)) {
    return DEFAULT_STATE();
  }
  const text = fs.readFileSync(p, "utf8").trim();
  if (!text) {
    const state = DEFAULT_STATE();
    saveState(cfg, state);
    return state;
  }
  try {
    return normalizeState(JSON.parse(text));
  } catch {
    const state = DEFAULT_STATE();
    saveState(cfg, state);
    return state;
  }
}

function saveState(cfg, state) {
  const normalized = normalizeState(state);
  const text = JSON.stringify(normalized, null, 2);
  if (!text || text.length < 2) {
    throw new Error("refusing to write empty fleet state");
  }
  fs.writeFileSync(cfg._statePath, `${text}\n`, "utf8");
}

function upsertMachine(state, machine) {
  const idx = state.machines.findIndex(
    (m) => m.tailscale_ip === machine.tailscale_ip || m.run_id === machine.run_id
  );
  if (idx >= 0) {
    state.machines[idx] = { ...state.machines[idx], ...machine };
  } else {
    state.machines.push(machine);
  }
}

/** Drop machine rows whose run_id is not active and not in the keep set (e.g. recent runs with IP). */
function pruneMachinesToActiveRuns(state, activeRunIds, alsoKeepRunIds) {
  const keep = new Set(
    [...(activeRunIds || []), ...(alsoKeepRunIds || [])].map((id) => Number(id))
  );
  const before = (state.machines || []).length;
  state.machines = (state.machines || []).filter((m) => m.run_id && keep.has(Number(m.run_id)));
  return { before, after: state.machines.length, removed: before - state.machines.length };
}

module.exports = { loadState, saveState, upsertMachine, pruneMachinesToActiveRuns };

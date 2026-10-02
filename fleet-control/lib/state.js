"use strict";

const fs = require("fs");

function loadState(cfg) {
  const p = cfg._statePath;
  if (!fs.existsSync(p)) {
    return { machines: [], runs: [] };
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveState(cfg, state) {
  fs.writeFileSync(cfg._statePath, JSON.stringify(state, null, 2), "utf8");
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

/** Drop machine rows whose run_id is not in the current active GHA run set. */
function pruneMachinesToActiveRuns(state, activeRunIds) {
  const keep = new Set((activeRunIds || []).map((id) => Number(id)));
  const before = (state.machines || []).length;
  state.machines = (state.machines || []).filter((m) => m.run_id && keep.has(Number(m.run_id)));
  return { before, after: state.machines.length, removed: before - state.machines.length };
}

module.exports = { loadState, saveState, upsertMachine, pruneMachinesToActiveRuns };

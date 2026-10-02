"use strict";

const fs = require("fs");
const { spawn, execFile, execFileSync } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const GH_CANDIDATE = "D:\\Tools\\gh\\bin\\gh.exe";

function resolveGh() {
  if (fs.existsSync(GH_CANDIDATE)) return GH_CANDIDATE;
  return "gh";
}

function spawnGhAuthLogin() {
  const gh = resolveGh();
  const args = [
    "auth",
    "login",
    "-h",
    "github.com",
    "-p",
    "https",
    "-w",
    "-s",
    "repo",
    "-s",
    "workflow",
  ];
  if (process.platform === "win32") {
    const child = spawn("cmd.exe", ["/c", "start", "Fleet GitHub Login", gh, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    return { spawned: true, gh, mode: "terminal" };
  }
  const child = spawn(gh, args, { detached: true, stdio: "inherit" });
  child.unref();
  return { spawned: true, gh, mode: "terminal" };
}

async function runGh(args, options = {}) {
  const gh = resolveGh();
  try {
    const { stdout, stderr } = await execFileAsync(gh, args, {
      encoding: "utf8",
      timeout: options.timeout || 15000,
      windowsHide: true,
      ...options,
    });
    return { ok: true, stdout: stdout || "", stderr: stderr || "", code: 0 };
  } catch (err) {
    return {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || "",
      code: err.code,
      message: err.message,
    };
  }
}

function parseAuthStatus(text) {
  const combined = text;
  const loggedIn = /Logged in to github\.com/i.test(combined);
  let account = null;
  const acctMatch = combined.match(/account\s+(\S+)\s+\(/i) || combined.match(/Active account:\s*(\S+)/i);
  if (acctMatch) account = acctMatch[1];
  const deviceMatch = combined.match(/!(?:[A-Z0-9-]+)/) || combined.match(/one-time code:\s*([A-Z0-9-]+)/i);
  const deviceCode = deviceMatch ? deviceMatch[0].replace(/^one-time code:\s*/i, "") : null;
  return { loggedIn, account, deviceCode, raw: combined.trim() };
}

async function getGitHubAuthStatus() {
  const gh = resolveGh();
  let result = await runGh(["auth", "status", "-h", "github.com"]);
  let parsed = parseAuthStatus(`${result.stdout}\n${result.stderr}`);

  if (!parsed.loggedIn && !parsed.deviceCode) {
    const refresh = await runGh(["auth", "refresh", "-h", "github.com"], { timeout: 8000 });
    const refreshText = `${refresh.stdout}\n${refresh.stderr}`;
    const fromRefresh = parseAuthStatus(refreshText);
    if (fromRefresh.deviceCode || refreshText.trim()) {
      parsed = {
        ...parsed,
        deviceCode: fromRefresh.deviceCode || parsed.deviceCode,
        refresh_hint: refreshText.trim().slice(0, 2000),
      };
    }
  }

  return {
    gh_path: gh,
    gh_exists: gh === "gh" || fs.existsSync(gh),
    ...parsed,
  };
}

function getGhTokenSync() {
  const gh = resolveGh();
  try {
    return execFileSync(gh, ["auth", "token", "-h", "github.com"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Switch active gh CLI user (required before token when multiple accounts are logged in).
 */
function switchGhUserSync(ghUser, host = "github.com") {
  if (!ghUser || typeof ghUser !== "string") {
    return { ok: true, skipped: true };
  }
  const gh = resolveGh();
  try {
    execFileSync(gh, ["auth", "switch", "-u", ghUser.trim(), "-h", host], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    return { ok: true, gh_user: ghUser.trim() };
  } catch (err) {
    const detail = [err.stderr, err.stdout, err.message].filter(Boolean).join("\n").trim();
    return { ok: false, gh_user: ghUser.trim(), message: detail || "gh auth switch failed" };
  }
}

/**
 * Token for a config account: explicit token / token_env, else gh auth switch to gh_user + active token.
 */
function resolveAccountToken(acct) {
  if (!acct) return null;
  if (acct.token) return acct.token;
  const host = acct.gh_host || "github.com";
  if (acct.gh_user) {
    const sw = switchGhUserSync(acct.gh_user, host);
    if (!sw.ok) return null;
  }
  return getGhTokenSync();
}

module.exports = {
  resolveGh,
  spawnGhAuthLogin,
  getGitHubAuthStatus,
  getGhTokenSync,
  switchGhUserSync,
  resolveAccountToken,
};

(function () {
  function snippet(val, max) {
    if (val == null) return "—";
    const s = typeof val === "string" ? val : JSON.stringify(val);
    if (s.length <= max) return s;
    return s.slice(0, max) + "…";
  }

  function bodySnippet(body) {
    if (!body || typeof body !== "object") return snippet(body, 120);
    if (body.error) return String(body.error);
    if (body.result !== undefined) return snippet(body.result, 120);
    if (body.stdout) return snippet(body.stdout, 120);
    return snippet(body, 120);
  }

  function fillResultTable(tbody, rows, key) {
    tbody.innerHTML = "";
    for (const row of rows || []) {
      const tr = document.createElement("tr");
      const ok = row.ok;
      tr.innerHTML =
        `<td>${row.ip || ""}</td>` +
        `<td class="${ok ? "live" : "down"}">${ok ? "ok" : "error"}</td>` +
        `<td class="meta">${bodySnippet(row.body)}</td>`;
      tbody.appendChild(tr);
    }
    if (!rows || !rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="meta">—</td></tr>';
    }
  }

  async function fetchWithTimeout(url, options, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } catch (e) {
      if (e.name === "AbortError") {
        throw new Error(
          "Λήξη χρόνου αναμονής — ο server αργεί. Επανεκκίνησε το dashboard ή δοκίμασε Ανανέωση."
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function parseApiJson(res) {
    const text = await res.text();
    if (!text) {
      if (!res.ok) throw new Error("Σφάλμα HTTP " + res.status);
      return {};
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const hint =
        /not found/i.test(text) && res.status === 404
          ? " Ξανακίνησε το dashboard (npm run dashboard) με τον τελευταίο κώδικα."
          : "";
      throw new Error(
        "Μη έγκυρη απάντηση από τον server (HTTP " + res.status + "):" + hint
      );
    }
    if (!res.ok) throw new Error(data.error || "Σφάλμα HTTP " + res.status);
    return data;
  }

  async function liveIpsFromSummary() {
    const res = await fetchWithTimeout("/api/summary", {}, 25000);
    const data = await parseApiJson(res);
    return (data.machines || []).filter((m) => m.live).map((m) => m.ip);
  }

  async function updateTargets(el) {
    try {
      const ips = await liveIpsFromSummary();
      el.textContent =
        ips.length ? ips.join(", ") : "Καμία LIVE μηχανή — κάνε Ανανέωση ή περίμενε provision.";
    } catch (e) {
      el.textContent = "Σφάλμα: " + e.message;
    }
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return parseApiJson(res);
  }

  function init() {
    const targetsEl = document.getElementById("fleetTargets");
    const ffUrl = document.getElementById("ffUrl");
    const ffStatus = document.getElementById("ffStatusBody");
    const jsScript = document.getElementById("jsScript");
    const jsResults = document.getElementById("jsResults");
    const execCmd = document.getElementById("execCmd");
    const execResults = document.getElementById("execResults");

    if (!targetsEl) return;

    updateTargets(targetsEl);
    setInterval(() => updateTargets(targetsEl), 10000);

    document.getElementById("btnFfOpen").addEventListener("click", async () => {
      const btn = document.getElementById("btnFfOpen");
      btn.disabled = true;
      try {
        const data = await postJson("/api/firefox/open", { url: ffUrl.value || "about:blank" });
        fillResultTable(ffStatus, data.results);
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("btnFfClose").addEventListener("click", async () => {
      const btn = document.getElementById("btnFfClose");
      btn.disabled = true;
      try {
        const data = await postJson("/api/firefox/close", {});
        fillResultTable(ffStatus, data.results);
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("btnFfStatus").addEventListener("click", async () => {
      const btn = document.getElementById("btnFfStatus");
      btn.disabled = true;
      try {
        const res = await fetch("/api/firefox/status");
        const data = await parseApiJson(res);
        fillResultTable(ffStatus, data.results);
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("btnJsRun").addEventListener("click", async () => {
      const btn = document.getElementById("btnJsRun");
      btn.disabled = true;
      try {
        const data = await postJson("/api/firefox/js", { script: jsScript.value });
        fillResultTable(jsResults, data.results);
      } catch (e) {
        alert(e.message);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("btnExecRun").addEventListener("click", async () => {
      const btn = document.getElementById("btnExecRun");
      btn.disabled = true;
      try {
        const cmd = (execCmd.value || "").trim();
        if (!cmd) {
          alert("Γράψε εντολή shell.");
          return;
        }
        const data = await postJson("/api/exec", { command: cmd });
        if (!data.results || !data.results.length) {
          alert("Καμία LIVE μηχανή — κάνε Ανανέωση ή περίμενε provision.");
          fillResultTable(execResults, []);
          return;
        }
        fillResultTable(execResults, data.results);
      } catch (e) {
        alert(e.message || String(e));
      } finally {
        btn.disabled = false;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

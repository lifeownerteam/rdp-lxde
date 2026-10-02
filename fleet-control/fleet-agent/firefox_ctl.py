"""Firefox control via Marionette (MVP). Requires a display session (RDP user logged in)."""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import time
from typing import Any

RDP_USER = os.environ.get("FLEET_RDP_USER", "RDP")
MARIONETTE_PORT = int(os.environ.get("FLEET_MARIONETTE_PORT", "2828"))
MARIONETTE_PROBE_TIMEOUT = float(os.environ.get("FLEET_MARIONETTE_PROBE_TIMEOUT", "10"))
MARIONETTE_SESSION_TIMEOUT = float(os.environ.get("FLEET_MARIONETTE_SESSION_TIMEOUT", "30"))
MARIONETTE_START_WAIT_SEC = float(os.environ.get("FLEET_MARIONETTE_START_WAIT", "45"))
FLEET_PROFILE = f"/home/{RDP_USER}/.fleet-firefox-profile"
DESKTOP_PROFILE = f"/home/{RDP_USER}/.mozilla/firefox/default"
FF_BIN = "/opt/firefox/firefox"


def _run_as_rdp(command: str, *, check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["su", "-", RDP_USER, "-c", command],
        check=check,
        capture_output=True,
        text=True,
    )


def ensure_firefox_profiles() -> None:
    """Writable Marionette + default desktop profiles under the RDP user home."""
    home = f"/home/{RDP_USER}"
    moz_dir = f"{home}/.mozilla/firefox"
    subprocess.run(
        [
            "install",
            "-d",
            "-o",
            RDP_USER,
            "-g",
            RDP_USER,
            "-m",
            "700",
            moz_dir,
            FLEET_PROFILE,
        ],
        check=True,
    )
    if not os.path.isfile(f"{FLEET_PROFILE}/times.json"):
        _run_as_rdp(f'{FF_BIN} -CreateProfile "fleet {FLEET_PROFILE}"', check=False)
    profiles_ini = f"{moz_dir}/profiles.ini"
    if not os.path.isfile(profiles_ini):
        _run_as_rdp(f'{FF_BIN} -CreateProfile "default {DESKTOP_PROFILE}"', check=False)
    elif not os.path.isdir(DESKTOP_PROFILE):
        broken = f"{moz_dir}/profiles.ini.broken-{int(time.time())}"
        os.rename(profiles_ini, broken)
        _run_as_rdp(f'{FF_BIN} -CreateProfile "default {DESKTOP_PROFILE}"', check=False)
    subprocess.run(["chown", "-R", f"{RDP_USER}:{RDP_USER}", home], check=False)


def _x11_socket_display(num: str) -> str | None:
    if os.path.exists(f"/tmp/.X11-unix/X{num}"):
        return f":{num}"
    return None


def rdp_display() -> str:
    """Best-effort active X display for the RDP desktop session."""
    try:
        proc = subprocess.run(
            ["pgrep", "-a", "Xorg"],
            capture_output=True,
            text=True,
            check=False,
        )
        for line in proc.stdout.splitlines():
            m = re.search(r"\s:(\d+(?:\.\d+)?)\s", f" {line} ")
            if not m:
                m = re.search(r":(\d+(?:\.\d+)?)", line)
            if m:
                disp = f":{m.group(1)}"
                sock = _x11_socket_display(disp.split(":")[1].split(".")[0])
                if sock:
                    return disp if "." in disp else sock
    except Exception:
        pass

    for disp in (":10", ":10.0", ":11", ":11.0", ":0", ":0.0"):
        num = disp.split(":")[1].split(".")[0]
        sock = _x11_socket_display(num)
        if sock:
            return sock

    return os.environ.get("DISPLAY", ":10")


def _marionette_probe(timeout: float = MARIONETTE_PROBE_TIMEOUT) -> bool:
    try:
        from marionette_driver.marionette import Marionette

        m = Marionette(host="127.0.0.1", port=MARIONETTE_PORT, socket_timeout=timeout)
        m.start_session()
        m.delete_session()
        return True
    except Exception:
        return False


def _kill_fleet_marionette_firefox() -> None:
    subprocess.run(
        ["pkill", "-u", RDP_USER, "-f", f"-marionette-port {MARIONETTE_PORT}"],
        check=False,
    )
    subprocess.run(
        ["pkill", "-u", RDP_USER, "-f", f"-profile {FLEET_PROFILE}"],
        check=False,
    )
    time.sleep(0.5)


def _launch_marionette_firefox(display: str) -> None:
    profile_q = shlex.quote(FLEET_PROFILE)
    cmd = (
        f"export DISPLAY={shlex.quote(display)} HOME=/home/{RDP_USER}; "
        f"nohup {FF_BIN} -no-remote -marionette -marionette-port {MARIONETTE_PORT} "
        f"-profile {profile_q} about:blank >>/tmp/fleet-firefox.log 2>&1 &"
    )
    _run_as_rdp(cmd, check=False)


def _ensure_marionette() -> None:
    ensure_firefox_profiles()
    display = rdp_display()

    if _marionette_probe():
        return

    _kill_fleet_marionette_firefox()
    _launch_marionette_firefox(display)

    deadline = time.monotonic() + MARIONETTE_START_WAIT_SEC
    while time.monotonic() < deadline:
        time.sleep(0.5)
        if _marionette_probe():
            return

    tail = ""
    try:
        with open("/tmp/fleet-firefox.log", encoding="utf-8", errors="replace") as fh:
            tail = "".join(fh.readlines()[-20:])
    except OSError:
        pass
    raise RuntimeError(
        f"Could not start Marionette Firefox (DISPLAY={display}, port={MARIONETTE_PORT}); "
        f"log in via RDP first or check /tmp/fleet-firefox.log. Log tail: {tail[:500]}"
    )


def _session():
    from marionette_driver.marionette import Marionette

    _ensure_marionette()
    m = Marionette(
        host="127.0.0.1",
        port=MARIONETTE_PORT,
        socket_timeout=MARIONETTE_SESSION_TIMEOUT,
    )
    m.start_session()
    return m


def exec_open_urls(urls: list[str]) -> dict[str, Any]:
    """Open URLs in the desktop Firefox session without Marionette (fallback)."""
    if not urls:
        return {"opened": 0, "fallback": "exec", "tabs": tab_status()}
    display = rdp_display()
    opened = 0
    for i, url in enumerate(urls):
        flag = "-new-tab" if i else "-new-window"
        cmd = (
            f"export DISPLAY={shlex.quote(display)}; "
            f"{FF_BIN} {flag} {shlex.quote(url)} >/dev/null 2>&1 &"
        )
        _run_as_rdp(cmd, check=False)
        opened += 1
    time.sleep(0.8)
    tabs = tab_status()
    return {"opened": opened, "fallback": "exec", "tabs": tabs}


def open_urls(urls: list[str], *, allow_exec_fallback: bool = True) -> dict[str, Any]:
    if not urls:
        return {"opened": 0, "tabs": tab_status()}
    try:
        m = _session()
    except Exception as exc:
        if allow_exec_fallback:
            out = exec_open_urls(urls)
            out["marionette_error"] = str(exc)
            return out
        raise
    try:
        for i, url in enumerate(urls):
            if i == 0:
                m.navigate(url)
            else:
                m.execute_script(f'window.open("{url}", "_blank");')
        time.sleep(0.5)
        return {"opened": len(urls), "tabs": tab_status()}
    finally:
        m.delete_session()


def close_tabs(all_tabs: bool = True, keep: int = 1) -> dict[str, Any]:
    m = _session()
    try:
        handles = m.window_handles
        if all_tabs and len(handles) <= 1:
            return {"closed": 0, "tabs": tab_status()}
        closed = 0
        if all_tabs:
            for h in handles[keep:]:
                m.switch_to_window(h)
                m.close()
                closed += 1
        else:
            if len(handles) > 1:
                m.close()
                closed = 1
        return {"closed": closed, "tabs": tab_status()}
    finally:
        m.delete_session()


def tab_status() -> dict[str, Any]:
    try:
        m = _session()
        try:
            handles = m.window_handles
            titles = []
            urls = []
            for h in handles:
                m.switch_to_window(h)
                titles.append(m.title)
                urls.append(m.get_url())
            return {"count": len(handles), "titles": titles, "urls": urls}
        finally:
            m.delete_session()
    except Exception as exc:
        return {"count": 0, "error": str(exc), "titles": [], "urls": []}


def run_js(script: str) -> dict[str, Any]:
    m = _session()
    try:
        results = []
        for h in m.window_handles:
            m.switch_to_window(h)
            results.append({"url": m.get_url(), "result": m.execute_script(script)})
        return {"tabs": len(results), "results": results}
    finally:
        m.delete_session()

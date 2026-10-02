"""Firefox control via Marionette (MVP). Requires a display session (RDP user logged in)."""

from __future__ import annotations

import os
import subprocess
import time
from typing import Any

RDP_USER = os.environ.get("FLEET_RDP_USER", "RDP")
MARIONETTE_PORT = int(os.environ.get("FLEET_MARIONETTE_PORT", "2828"))
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


def _rdp_display() -> str:
    for disp in (":10.0", ":10", ":11.0", ":0.0"):
        if os.path.exists(f"/tmp/.X11-unix/X{disp.split(':')[1].split('.')[0]}"):
            return disp
    return ":10.0"


def _ensure_marionette() -> None:
    ensure_firefox_profiles()
    env = os.environ.copy()
    env["DISPLAY"] = _rdp_display()
    env["HOME"] = f"/home/{RDP_USER}"
    try:
        from marionette_driver.marionette import Marionette

        m = Marionette(host="127.0.0.1", port=MARIONETTE_PORT, socket_timeout=2)
        m.start_session()
        m.delete_session()
        return
    except Exception:
        pass

    subprocess.run(
        [
            "su",
            "-",
            RDP_USER,
            "-c",
            f"DISPLAY={env['DISPLAY']} nohup {FF_BIN} "
            f"-marionette -marionette-port {MARIONETTE_PORT} "
            f"-profile {FLEET_PROFILE} "
            f"about:blank >/tmp/fleet-firefox.log 2>&1 &",
        ],
        check=False,
        env=env,
    )
    for _ in range(30):
        time.sleep(0.5)
        try:
            from marionette_driver.marionette import Marionette

            m = Marionette(host="127.0.0.1", port=MARIONETTE_PORT, socket_timeout=2)
            m.start_session()
            m.delete_session()
            return
        except Exception:
            continue
    raise RuntimeError("Could not start Marionette Firefox; log in via RDP first or check /tmp/fleet-firefox.log")


def _session():
    from marionette_driver.marionette import Marionette

    _ensure_marionette()
    m = Marionette(host="127.0.0.1", port=MARIONETTE_PORT, socket_timeout=30)
    m.start_session()
    return m


def open_urls(urls: list[str]) -> dict[str, Any]:
    if not urls:
        return {"opened": 0, "tabs": tab_status()}
    m = _session()
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

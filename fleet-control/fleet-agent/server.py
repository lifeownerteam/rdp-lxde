#!/usr/bin/env python3
"""Fleet agent HTTP API — bind 0.0.0.0:8765, Bearer token auth."""

from __future__ import annotations

import concurrent.futures
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import urlparse

try:
    import psutil
except ImportError:
    psutil = None  # type: ignore

import firefox_ctl

HOST = os.environ.get("FLEET_AGENT_HOST", "0.0.0.0")
PORT = int(os.environ.get("FLEET_AGENT_PORT", "8765"))
TOKEN = os.environ.get("FLEET_AGENT_TOKEN", "")
MAX_EXEC_SECONDS = int(os.environ.get("FLEET_EXEC_TIMEOUT", "120"))
MARIONETTE_OP_TIMEOUT = int(os.environ.get("FLEET_MARIONETTE_OP_TIMEOUT", "90"))


def _marionette_call(fn, *args, **kwargs):
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        fut = pool.submit(fn, *args, **kwargs)
        try:
            return fut.result(timeout=MARIONETTE_OP_TIMEOUT)
        except concurrent.futures.TimeoutError as exc:
            try:
                firefox_ctl._kill_fleet_marionette_firefox()
            except Exception:
                pass
            raise RuntimeError("marionette operation timed out") from exc


def _json_response(handler: BaseHTTPRequestHandler, code: int, body: dict[str, Any]) -> None:
    data = json.dumps(body).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def _auth_ok(handler: BaseHTTPRequestHandler) -> bool:
    if not TOKEN:
        return False
    auth = handler.headers.get("Authorization", "")
    if auth == f"Bearer {TOKEN}":
        return True
    return handler.headers.get("X-Fleet-Token", "") == TOKEN


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    return json.loads(raw.decode("utf-8"))


def _metrics() -> dict[str, Any]:
    if psutil is None:
        return {"error": "psutil not installed"}
    vm = psutil.virtual_memory()
    return {
        "cpu_percent": psutil.cpu_percent(interval=0.2),
        "memory": {
            "total_mb": round(vm.total / (1024 * 1024), 1),
            "used_mb": round(vm.used / (1024 * 1024), 1),
            "percent": vm.percent,
        },
        "load_avg": os.getloadavg() if hasattr(os, "getloadavg") else None,
    }


def _exec_command(command: str, shell: bool = True) -> dict[str, Any]:
    proc = subprocess.run(
        command,
        shell=shell,
        capture_output=True,
        text=True,
        timeout=MAX_EXEC_SECONDS,
    )
    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout,
        "stderr": proc.stderr,
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            _json_response(
                self,
                200,
                {"ok": True, "service": "fleet-agent", "token_configured": bool(TOKEN)},
            )
            return
        if path == "/metrics":
            if not _auth_ok(self):
                _json_response(self, 401, {"error": "unauthorized"})
                return
            _json_response(self, 200, _metrics())
            return
        if path == "/firefox/status":
            if not _auth_ok(self):
                _json_response(self, 401, {"error": "unauthorized"})
                return
            _json_response(self, 200, firefox_ctl.tab_status())
            return
        _json_response(self, 404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if not _auth_ok(self):
            _json_response(self, 401, {"error": "unauthorized"})
            return
        try:
            body = _read_json(self)
        except json.JSONDecodeError:
            _json_response(self, 400, {"error": "invalid json"})
            return

        if path == "/exec":
            cmd = body.get("command")
            if not cmd or not isinstance(cmd, str):
                _json_response(self, 400, {"error": "command required"})
                return
            try:
                _json_response(self, 200, _exec_command(cmd, shell=body.get("shell", True)))
            except subprocess.TimeoutExpired:
                _json_response(self, 408, {"error": "timeout"})
            return

        if path == "/firefox/open":
            url = body.get("url")
            count = int(body.get("count", 1))
            urls = body.get("urls")
            if urls and isinstance(urls, list):
                target = [str(u) for u in urls]
            elif url:
                target = [str(url)] * max(1, count)
            else:
                _json_response(self, 400, {"error": "url or urls required"})
                return
            allow_fb = body.get("allow_exec_fallback", True)
            try:
                _json_response(
                    self,
                    200,
                    _marionette_call(
                        firefox_ctl.open_urls,
                        target,
                        allow_exec_fallback=bool(allow_fb),
                    ),
                )
            except Exception as exc:
                if allow_fb and target:
                    try:
                        _json_response(self, 200, firefox_ctl.exec_open_urls(target))
                        return
                    except Exception:
                        pass
                _json_response(self, 500, {"error": str(exc)})
            return

        if path == "/firefox/close":
            try:
                _json_response(
                    self,
                    200,
                    _marionette_call(
                        firefox_ctl.close_tabs,
                        all_tabs=bool(body.get("all", True)),
                        keep=int(body.get("keep", 1)),
                    ),
                )
            except Exception as exc:
                _json_response(self, 500, {"error": str(exc)})
            return

        if path == "/firefox/js":
            script = body.get("script")
            if not script:
                _json_response(self, 400, {"error": "script required"})
                return
            try:
                _json_response(self, 200, _marionette_call(firefox_ctl.run_js, str(script)))
            except Exception as exc:
                _json_response(self, 500, {"error": str(exc)})
            return

        _json_response(self, 404, {"error": "not found"})


def main() -> None:
    if not TOKEN:
        sys.stderr.write("FLEET_AGENT_TOKEN is required\n")
        sys.exit(1)
    try:
        firefox_ctl.ensure_firefox_profiles()
    except Exception as exc:
        sys.stderr.write(f"firefox profile bootstrap warning: {exc}\n")
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    sys.stderr.write(f"fleet-agent listening on {HOST}:{PORT}\n")
    httpd.serve_forever()


if __name__ == "__main__":
    main()

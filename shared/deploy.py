"""Git pull + server restart for Pi / dev deployments."""

from __future__ import annotations

import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
_lock = threading.Lock()
_running = False
_last_result: dict[str, Any] | None = None


def is_git_repo() -> bool:
    return (ROOT / ".git").exists()


def git_head() -> dict[str, Any]:
    if not is_git_repo():
        return {"ok": False}
    try:
        sha = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        return {
            "ok": sha.returncode == 0,
            "sha": (sha.stdout or "").strip(),
            "branch": (branch.stdout or "").strip(),
        }
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {"ok": False}


def git_pull() -> dict[str, Any]:
    if not is_git_repo():
        return {"ok": False, "error": "Not a git repository — use git clone on the Pi, not rsync-only install"}
    try:
        # Fetch first so push-triggered deploys see remote commits reliably
        subprocess.run(
            ["git", "fetch", "--prune", "origin"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        proc = subprocess.run(
            ["git", "pull", "--ff-only"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
    except FileNotFoundError:
        return {"ok": False, "error": "git not installed"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "git pull timed out"}

    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    ok = proc.returncode == 0
    head = git_head()
    return {
        "ok": ok,
        "stdout": out,
        "stderr": err,
        "returncode": proc.returncode,
        "alreadyUpToDate": ok and "Already up to date" in out,
        "sha": head.get("sha") or "",
        "branch": head.get("branch") or "",
    }


def restart_service(schedule_restart_fn) -> dict[str, Any]:
    if sys.platform != "win32":
        try:
            active = subprocess.run(
                ["systemctl", "is-active", "family-board-api"],
                capture_output=True,
                text=True,
                check=False,
            )
            if active.stdout.strip() == "active":
                subprocess.run(
                    ["systemctl", "restart", "family-board-api"],
                    check=False,
                )
                return {"ok": True, "method": "systemctl"}
        except FileNotFoundError:
            pass

    schedule_restart_fn()
    return {"ok": True, "method": "restart_script"}


def get_last_result() -> dict[str, Any] | None:
    return _last_result


def deploy_async(schedule_restart_fn, *, restart: bool = True) -> dict[str, Any]:
    global _running, _last_result

    if _running:
        return {"ok": False, "error": "Deploy already in progress", "busy": True}

    def _run() -> None:
        global _running, _last_result
        with _lock:
            _running = True
            try:
                pull = git_pull()
                result: dict[str, Any] = {"pull": pull, "restarted": False}
                if restart and pull.get("ok"):
                    result["restart"] = restart_service(schedule_restart_fn)
                    result["restarted"] = True
                result["ok"] = bool(pull.get("ok"))
                _last_result = result
            except Exception as exc:  # noqa: BLE001
                _last_result = {"ok": False, "error": str(exc)}
            finally:
                _running = False

    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "deploying": True}


def deploy_sync(schedule_restart_fn, *, restart: bool = True) -> dict[str, Any]:
    global _last_result
    pull = git_pull()
    result: dict[str, Any] = {"pull": pull, "restarted": False}
    if restart and pull.get("ok"):
        result["restart"] = restart_service(schedule_restart_fn)
        result["restarted"] = True
    result["ok"] = bool(pull.get("ok"))
    _last_result = result
    return result

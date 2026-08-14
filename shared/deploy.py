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


def is_busy() -> bool:
    return _running


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


def _run_git(args: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _git_upstream_ref() -> str | None:
    proc = _run_git(["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], timeout=15)
    ref = (proc.stdout or "").strip()
    if proc.returncode == 0 and ref:
        return ref
    head = git_head()
    branch = head.get("branch") or "main"
    if branch and branch != "HEAD":
        return f"origin/{branch}"
    return None


def git_pull() -> dict[str, Any]:
    """Sync working tree to origin — discards local tracked edits (Pi deploy model)."""
    if not is_git_repo():
        return {"ok": False, "error": "Not a git repository — use git clone on the Pi, not rsync-only install"}
    try:
        fetch = _run_git(["git", "fetch", "--prune", "origin"], timeout=90)
        if fetch.returncode != 0:
            err = (fetch.stderr or fetch.stdout or "git fetch failed").strip()
            return {"ok": False, "error": "git fetch failed", "stderr": err}

        dirty = (_run_git(["git", "status", "--porcelain"], timeout=20).stdout or "").strip()
        before = git_head()
        upstream = _git_upstream_ref()
        if not upstream:
            return {"ok": False, "error": "No upstream branch — set tracking branch (git branch -u origin/main)"}

        reset = _run_git(["git", "reset", "--hard", upstream], timeout=60)
        if reset.returncode != 0:
            err = (reset.stderr or reset.stdout or "git reset failed").strip()
            # Last resort: ff-only pull (older clones)
            pull = _run_git(["git", "pull", "--ff-only"], timeout=120)
            out = (pull.stdout or "").strip()
            err = (pull.stderr or pull.stdout or err).strip()
            ok = pull.returncode == 0
            head = git_head()
            return {
                "ok": ok,
                "stdout": out,
                "stderr": err,
                "returncode": pull.returncode,
                "alreadyUpToDate": ok and "Already up to date" in out,
                "sha": head.get("sha") or "",
                "branch": head.get("branch") or "",
                "dirtyBeforeSync": bool(dirty),
                "syncMethod": "pull-ff-only",
            }

        head = git_head()
        return {
            "ok": True,
            "stdout": out or f"Synced to {upstream}",
            "stderr": err,
            "returncode": 0,
            "alreadyUpToDate": before.get("sha") == head.get("sha") and not dirty,
            "sha": head.get("sha") or "",
            "branch": head.get("branch") or "",
            "dirtyBeforeSync": bool(dirty),
            "syncMethod": "reset-hard",
            "upstream": upstream,
        }
    except FileNotFoundError:
        return {"ok": False, "error": "git not installed"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "git sync timed out"}


def _systemctl(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["systemctl", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _systemd_workdir() -> str | None:
    unit = Path("/etc/systemd/system/family-board-api.service")
    if not unit.is_file():
        return None
    for line in unit.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("WorkingDirectory="):
            return line.split("=", 1)[1].strip()
    return None


def restart_service(schedule_restart_fn) -> dict[str, Any]:
    if sys.platform != "win32":
        try:
            active = _systemctl("is-active", "family-board-api")
            if active.stdout.strip() == "active":
                workdir = _systemd_workdir()
                if workdir and Path(workdir).resolve() != ROOT.resolve():
                    repair = ROOT / "scripts" / "pi" / "repair-kiosk.sh"
                    if repair.is_file():
                        subprocess.run(
                            ["sudo", "bash", str(repair)],
                            cwd=ROOT,
                            check=False,
                        )
                _systemctl("restart", "family-board-api")
                kiosk = _systemctl("is-enabled", "family-board-kiosk")
                if kiosk.returncode == 0:
                    _systemctl("restart", "family-board-kiosk")
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
                if not pull.get("ok"):
                    result["error"] = pull.get("error") or pull.get("stderr") or "git sync failed"
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
    if not pull.get("ok"):
        result["error"] = pull.get("error") or pull.get("stderr") or "git sync failed"
    _last_result = result
    return result

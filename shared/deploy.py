"""Git sync + server restart for Pi / dev deployments."""

from __future__ import annotations

import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
_lock = threading.Lock()
_running = False
_last_result: dict[str, Any] | None = None
_git_head_cache: tuple[float, dict[str, Any]] | None = None
_GIT_HEAD_TTL_S = 4.0


def is_git_repo() -> bool:
    return (ROOT / ".git").exists()


def is_busy() -> bool:
    return _running


def git_head(*, fresh: bool = False) -> dict[str, Any]:
    global _git_head_cache
    now = time.monotonic()
    if not fresh:
        cached = _git_head_cache
        if cached and now - cached[0] < _GIT_HEAD_TTL_S:
            return cached[1]
    if not is_git_repo():
        return {"ok": False}
    try:
        sha = _run_git(["git", "rev-parse", "--short", "HEAD"], timeout=4)
        branch = _run_git(["git", "rev-parse", "--abbrev-ref", "HEAD"], timeout=4)
        dirty = _run_git(["git", "status", "--porcelain"], timeout=4)
        subject = _run_git(["git", "log", "-1", "--format=%s"], timeout=4)
        result = {
            "ok": sha.returncode == 0,
            "sha": (sha.stdout or "").strip(),
            "branch": (branch.stdout or "").strip(),
            "dirty": bool((dirty.stdout or "").strip()),
            "subject": (subject.stdout or "").strip(),
        }
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return {"ok": False}
    _git_head_cache = (now, result)
    return result


def _is_raspberry_pi() -> bool:
    model = Path("/proc/device-tree/model")
    if not model.is_file():
        return False
    try:
        return "raspberry" in model.read_text(errors="ignore").lower()
    except OSError:
        return False


def server_identity() -> dict[str, Any]:
    """Which machine is serving /api — laptop test vs live Pi."""
    hostname = socket.gethostname() or ""
    if sys.platform == "win32":
        role = "laptop"
        label = "Laptop"
        hint = "Local test. Push to GitHub, then pull on the Pi to update the TV and website."
    elif _is_raspberry_pi() or ((boot_status().get("api") or {}).get("active") == "active"):
        role = "pi"
        label = "Raspberry Pi"
        hint = "Live board. The TV and website use this server."
    else:
        role = "other"
        label = hostname or "Unknown host"
        hint = "Check the hostname and git SHA before treating this as the live board."
    return {
        "role": role,
        "label": label,
        "hostname": hostname,
        "platform": sys.platform,
        "hint": hint,
    }


def _run_git(args: list[str], *, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def _abort_git_operations() -> None:
    for cmd in (
        ["git", "merge", "--abort"],
        ["git", "rebase", "--abort"],
        ["git", "cherry-pick", "--abort"],
    ):
        _run_git(cmd, timeout=30)
    lock = ROOT / ".git" / "index.lock"
    if lock.exists():
        try:
            lock.unlink()
        except OSError:
            pass


def _resolve_upstream() -> str | None:
    proc = _run_git(
        ["git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        timeout=15,
    )
    ref = (proc.stdout or "").strip()
    if proc.returncode == 0 and ref:
        verify = _run_git(["git", "rev-parse", "--verify", f"{ref}^{{commit}}"], timeout=15)
        if verify.returncode == 0:
            return ref

    head = git_head()
    branch = head.get("branch") or ""
    if branch and branch != "HEAD":
        candidate = f"origin/{branch}"
        verify = _run_git(["git", "rev-parse", "--verify", f"{candidate}^{{commit}}"], timeout=15)
        if verify.returncode == 0:
            return candidate

    for candidate in ("origin/master", "origin/main"):
        verify = _run_git(["git", "rev-parse", "--verify", f"{candidate}^{{commit}}"], timeout=15)
        if verify.returncode == 0:
            return candidate
    return None


def _checkout_branch_for_upstream(upstream: str) -> None:
    local_branch = upstream.removeprefix("origin/")
    head = git_head()
    current = head.get("branch") or "HEAD"
    if current == local_branch:
        return

    has_local = _run_git(["git", "show-ref", "--verify", f"refs/heads/{local_branch}"], timeout=15)
    if has_local.returncode == 0:
        _run_git(["git", "checkout", "-f", local_branch], timeout=30)
    else:
        _run_git(["git", "checkout", "-B", local_branch, upstream], timeout=30)


def _git_sync_python() -> dict[str, Any]:
    """Python fallback — same behavior as scripts/git_sync.sh (no merge/pull)."""
    if not is_git_repo():
        return {"ok": False, "error": "Not a git repository — use git clone on the Pi, not rsync-only install"}

    dirty = (_run_git(["git", "status", "--porcelain"], timeout=20).stdout or "").strip()
    before = git_head(fresh=True)

    _abort_git_operations()

    fetch = _run_git(["git", "fetch", "--prune", "origin"], timeout=90)
    if fetch.returncode != 0:
        err = (fetch.stderr or fetch.stdout or "git fetch failed").strip()
        return {"ok": False, "error": "git fetch failed", "stderr": err}

    upstream = _resolve_upstream()
    if not upstream:
        return {
            "ok": False,
            "error": "No upstream branch — set tracking branch (git branch -u origin/main)",
        }

    _checkout_branch_for_upstream(upstream)

    reset = _run_git(["git", "reset", "--hard", upstream], timeout=60)
    out = (reset.stdout or "").strip()
    err = (reset.stderr or "").strip()
    if reset.returncode != 0:
        return {
            "ok": False,
            "error": "git reset failed",
            "stderr": err or out or "git reset --hard failed",
            "upstream": upstream,
            "syncMethod": "reset-hard",
        }

    head = git_head(fresh=True)
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


def git_pull() -> dict[str, Any]:
    """Sync working tree to origin — discards local tracked edits (Pi deploy model)."""
    return _git_sync_python()


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


def _run_sudo(args: list[str], *, timeout: int = 90) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["sudo", "-n", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def boot_status() -> dict[str, Any]:
    if sys.platform == "win32":
        return {}
    try:
        def unit(name: str) -> dict[str, str]:
            active = _systemctl("is-active", name)
            enabled = _systemctl("is-enabled", name)
            return {
                "active": (active.stdout or "").strip() or "unknown",
                "enabled": (enabled.stdout or "").strip() or "unknown",
            }

        preferred = unit("family-board-tunnel")
        official = unit("cloudflared")
        name = "family-board-tunnel"
        tunnel = preferred
        if (official.get("active") or "") == "active":
            tunnel = official
            name = "cloudflared"
        tunnel["unit"] = name
        return {
            "api": unit("family-board-api"),
            "kiosk": unit("family-board-kiosk"),
            "tunnel": tunnel,
        }
    except FileNotFoundError:
        return {}


def enable_boot_services() -> dict[str, Any]:
    """Enable API + kiosk + Cloudflare tunnel for every power-on, then start them."""
    if sys.platform == "win32":
        return {"ok": False, "error": "Windows — boot services are Pi-only"}

    wrapper = Path("/usr/local/sbin/family-board-boot")
    script = ROOT / "scripts" / "pi" / "ensure-boot.sh"
    try:
        if wrapper.is_file():
            proc = _run_sudo([str(wrapper)], timeout=90)
        elif script.is_file():
            proc = _run_sudo(["bash", str(script)], timeout=90)
        else:
            return {"ok": False, "error": "ensure-boot.sh missing"}
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": str(exc)}

    out = ((proc.stdout or "") + (proc.stderr or "")).strip()
    if proc.returncode != 0:
        return {
            "ok": False,
            "error": out or "sudo failed — Pi user needs passwordless sudo for family-board-boot",
            "returncode": proc.returncode,
        }
    return {"ok": True, "stdout": out, "services": boot_status()}


def schedule_pi_reboot(delay_s: float = 1.2) -> dict[str, Any]:
    """Reboot the Pi after the HTTP response is sent. No-op on Windows."""
    if sys.platform == "win32":
        return {"ok": False, "error": "Reboot is only available on the Raspberry Pi"}

    reboot = Path("/usr/local/sbin/family-board-reboot")

    def _run() -> None:
        time.sleep(delay_s)
        try:
            if reboot.is_file():
                proc = _run_sudo([str(reboot)], timeout=15)
            else:
                proc = _run_sudo(["systemctl", "reboot"], timeout=15)
                if proc.returncode != 0:
                    proc = _run_sudo(["/sbin/reboot"], timeout=15)
            if proc.returncode != 0:
                print(
                    "Pi reboot failed: "
                    + ((proc.stderr or proc.stdout or "sudo reboot denied").strip()),
                    flush=True,
                )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            print(f"Pi reboot failed: {exc}", flush=True)

    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "rebooting": True}


def restart_service(schedule_restart_fn) -> dict[str, Any]:
    if sys.platform != "win32":
        boot = enable_boot_services()
        if boot.get("ok"):
            return {"ok": True, "method": "ensure-boot", "boot": boot}
        try:
            active = _systemctl("is-active", "family-board-api")
            if active.stdout.strip() == "active":
                workdir = _systemd_workdir()
                if workdir and Path(workdir).resolve() != ROOT.resolve():
                    repair = ROOT / "scripts" / "pi" / "repair-kiosk.sh"
                    if repair.is_file():
                        subprocess.run(
                            ["sudo", "-n", "bash", str(repair)],
                            cwd=ROOT,
                            check=False,
                        )
                _systemctl("restart", "family-board-api")
                kiosk = _systemctl("is-enabled", "family-board-kiosk")
                if kiosk.returncode == 0:
                    _systemctl("restart", "family-board-kiosk")
                return {"ok": True, "method": "systemctl", "boot": boot}
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

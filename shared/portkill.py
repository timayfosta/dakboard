"""Find / kill whatever is listening on the Family Board port."""
from __future__ import annotations

import os
import re
import subprocess
import sys


def listening_pids(port: int) -> set[int]:
    if sys.platform == "win32":
        proc = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True,
            text=True,
            check=False,
            timeout=8,
        )
        pids: set[int] = set()
        needle = re.compile(rf":{port}\s+")
        for line in (proc.stdout or "").splitlines():
            if "LISTENING" not in line.upper():
                continue
            if not needle.search(line):
                continue
            parts = line.split()
            try:
                pids.add(int(parts[-1]))
            except (ValueError, IndexError):
                pass
        return pids

    proc = subprocess.run(
        ["fuser", f"{port}/tcp"],
        capture_output=True,
        text=True,
        check=False,
        timeout=8,
    )
    pids: set[int] = set()
    for token in (proc.stdout or "").replace(",", " ").split():
        try:
            pids.add(int(token))
        except ValueError:
            pass
    return pids


def kill_port(port: int, *, include_self: bool = False) -> list[int]:
    my_pid = os.getpid()
    pids = {pid for pid in listening_pids(port) if pid > 0}
    if not include_self:
        pids.discard(my_pid)
    killed: list[int] = []
    for pid in sorted(pids):
        if sys.platform == "win32":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                check=False,
                capture_output=True,
                timeout=8,
            )
        else:
            subprocess.run(["kill", "-TERM", str(pid)], check=False, timeout=5)
        killed.append(pid)
    return killed

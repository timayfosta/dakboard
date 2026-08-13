"""Restart Family Board API — free port 8765, then start server.py."""
from __future__ import annotations

import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PORT = 8765
SERVER = ROOT / "server.py"


def kill_port(port: int) -> None:
    if sys.platform == "win32":
        ps = (
            f"$p = Get-NetTCPConnection -LocalPort {port} -State Listen "
            f"-ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; "
            f"foreach ($id in $p) {{ if ($id -gt 0) {{ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }} }}"
        )
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=False)
    else:
        subprocess.run(["fuser", "-k", f"{port}/tcp"], check=False, capture_output=True)


def main() -> None:
    kill_port(PORT)
    time.sleep(0.4)
    os.chdir(ROOT)
    os.execv(sys.executable, [sys.executable, str(SERVER)])


if __name__ == "__main__":
    main()

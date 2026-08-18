"""Restart Family Board API — free port 8765, then start server.py."""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "shared"))
import portkill  # noqa: E402

PORT = 8765
SERVER = ROOT / "server.py"


def main() -> None:
    delayed = "--delayed" in sys.argv
    if delayed:
        time.sleep(1.0)
    print(f"Starting Family Board on port {PORT}…", flush=True)
    killed = portkill.kill_port(PORT)
    if killed:
        print(f"Stopped old server (pid {', '.join(map(str, killed))})…", flush=True)
    else:
        print(f"Port {PORT} is free", flush=True)
    time.sleep(0.4)
    os.chdir(ROOT)
    os.execv(sys.executable, [sys.executable, str(SERVER)])


if __name__ == "__main__":
    main()

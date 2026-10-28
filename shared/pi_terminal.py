"""Interactive Pi shell sessions for Admin (files-password gated)."""

from __future__ import annotations

import os
import select
import struct
import subprocess
import sys
import threading
import time
import uuid
from typing import Any

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))

_lock = threading.Lock()
_sessions: dict[str, "_Session"] = {}
_MAX_SESSIONS = 2
_IDLE_TTL_S = 30 * 60
_CHUNK_CAP = 400


class _Session:
    def __init__(self, cols: int, rows: int) -> None:
        self.id = uuid.uuid4().hex
        self.created = time.time()
        self.last_used = self.created
        self.cols = max(40, min(cols, 200))
        self.rows = max(10, min(rows, 80))
        self.chunks: list[tuple[int, str]] = []
        self.seq = 0
        self.alive = True
        self.master_fd: int | None = None
        self.proc: subprocess.Popen[bytes] | None = None

        if sys.platform == "win32":
            raise RuntimeError("Pi terminal is only available on the Raspberry Pi")

        import pty

        master, slave = pty.openpty()
        self._set_winsize(master, self.rows, self.cols)
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env.setdefault("HOME", os.path.expanduser("~"))
        shell = env.get("SHELL") or "/bin/bash"
        self.proc = subprocess.Popen(
            [shell, "-l"],
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=ROOT,
            env=env,
            preexec_fn=os.setsid,
            close_fds=True,
        )
        os.close(slave)
        self.master_fd = master
        os.set_blocking(master, False)
        threading.Thread(target=self._read_loop, daemon=True).start()

    def _set_winsize(self, fd: int, rows: int, cols: int) -> None:
        try:
            import fcntl
            import termios

            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        except (OSError, ImportError):
            pass

    def _append(self, text: str) -> None:
        if not text:
            return
        self.seq += 1
        self.chunks.append((self.seq, text))
        if len(self.chunks) > _CHUNK_CAP:
            self.chunks = self.chunks[-_CHUNK_CAP:]
        self.last_used = time.time()

    def _read_loop(self) -> None:
        assert self.master_fd is not None
        fd = self.master_fd
        while self.alive:
            try:
                ready, _, _ = select.select([fd], [], [], 0.4)
            except (OSError, ValueError):
                break
            if not ready:
                if self.proc and self.proc.poll() is not None:
                    break
                continue
            try:
                chunk = os.read(fd, 8192)
            except BlockingIOError:
                continue
            except OSError:
                break
            if not chunk:
                break
            with _lock:
                self._append(chunk.decode("utf-8", errors="replace"))
        with _lock:
            self.alive = False
        try:
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
        except OSError:
            pass

    def write(self, data: str) -> None:
        if not self.alive or self.master_fd is None or not data:
            return
        try:
            os.write(self.master_fd, data.encode("utf-8", errors="replace"))
            self.last_used = time.time()
        except OSError:
            self.alive = False

    def resize(self, cols: int, rows: int) -> None:
        self.cols = max(40, min(int(cols or self.cols), 200))
        self.rows = max(10, min(int(rows or self.rows), 80))
        if self.master_fd is not None:
            self._set_winsize(self.master_fd, self.rows, self.cols)
        self.last_used = time.time()

    def poll(self, after_seq: int = 0) -> dict[str, Any]:
        pieces = [text for seq, text in self.chunks if seq > after_seq]
        alive = self.alive and (self.proc is None or self.proc.poll() is None)
        return {
            "sessionId": self.id,
            "seq": self.seq,
            "output": "".join(pieces),
            "alive": alive,
            "cols": self.cols,
            "rows": self.rows,
        }

    def close(self) -> None:
        self.alive = False
        try:
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        except OSError:
            pass
        try:
            if self.master_fd is not None:
                os.close(self.master_fd)
        except OSError:
            pass
        self.master_fd = None


def _reap_idle() -> None:
    now = time.time()
    dead = [
        sid
        for sid, sess in _sessions.items()
        if (not sess.alive) or (now - sess.last_used > _IDLE_TTL_S)
    ]
    for sid in dead:
        sess = _sessions.pop(sid, None)
        if sess:
            sess.close()


def open_session(*, cols: int = 100, rows: int = 28) -> dict[str, Any]:
    if sys.platform == "win32":
        return {
            "ok": False,
            "error": "Pi terminal only works when Admin is talking to the Raspberry Pi",
        }
    with _lock:
        _reap_idle()
        if len(_sessions) >= _MAX_SESSIONS:
            oldest = min(_sessions.values(), key=lambda s: s.last_used)
            oldest.close()
            _sessions.pop(oldest.id, None)
        try:
            sess = _Session(cols, rows)
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}
        _sessions[sess.id] = sess
        return {"ok": True, "sessionId": sess.id, "cols": sess.cols, "rows": sess.rows}


def _get(session_id: str) -> _Session | None:
    with _lock:
        _reap_idle()
        return _sessions.get(session_id)


def write_input(session_id: str, data: str) -> dict[str, Any]:
    sess = _get(session_id)
    if not sess:
        return {"ok": False, "error": "Terminal session ended — open again"}
    sess.write((data or "")[:8000])
    return {"ok": True, "alive": sess.alive}


def poll(session_id: str, after_seq: int = 0) -> dict[str, Any]:
    sess = _get(session_id)
    if not sess:
        return {"ok": False, "alive": False, "error": "Terminal session ended — open again"}
    with _lock:
        snap = sess.poll(int(after_seq or 0))
    snap["ok"] = True
    return snap


def resize(session_id: str, cols: int, rows: int) -> dict[str, Any]:
    sess = _get(session_id)
    if not sess:
        return {"ok": False, "error": "Terminal session ended — open again"}
    sess.resize(cols, rows)
    return {"ok": True, "cols": sess.cols, "rows": sess.rows}


def close_session(session_id: str) -> dict[str, Any]:
    with _lock:
        sess = _sessions.pop(session_id, None)
    if sess:
        sess.close()
    return {"ok": True}

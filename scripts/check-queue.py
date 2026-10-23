#!/usr/bin/env python3
"""Serialize full checks across Git worktrees without changing their verdicts."""

import fcntl
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def process_start(pid):
    result = subprocess.run(
        ["ps", "-p", str(pid), "-o", "lstart="],
        capture_output=True, text=True, check=False,
    )
    return result.stdout.strip()


def has_queue_ancestor():
    pid = os.getppid()
    while pid > 1:
        row = subprocess.run(
            ["ps", "-p", str(pid), "-o", "ppid=", "-o", "args="],
            capture_output=True, text=True, check=False,
        ).stdout.strip().split(None, 2)
        if len(row) < 3:
            return False
        if Path(row[2].split()[0]).name == "check-queue.py":
            return True
        pid = int(row[0])
    return False


def wait_for_legacy_checks(common):
    path = common / "graph-check-legacy.json"
    if not path.exists():
        return
    records = json.loads(path.read_text())
    next_notice = 0
    while True:
        active = [row for row in records if process_start(row["pid"]) == row["start"]]
        if not active:
            return
        if time.monotonic() >= next_notice:
            print(f"[check queue] Waiting for {len(active)} checks started before queue installation", flush=True)
            next_notice = time.monotonic() + 30
        time.sleep(2)


def run(command, lock):
    environment = os.environ.copy()
    environment.setdefault("GOMAXPROCS", "2")
    child = subprocess.Popen(
        command, env=environment, start_new_session=True,
        pass_fds=(lock.fileno(),),
    )

    def cancel(signum, _frame):
        try:
            os.killpg(child.pid, signum)
            child.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGINT, cancel)
    signal.signal(signal.SIGTERM, cancel)
    code = child.wait()
    return code if code >= 0 else 128 - code


@contextmanager
def protect_worktree(common):
    git_dir = Path(subprocess.check_output(["git", "rev-parse", "--absolute-git-dir"], text=True).strip())
    reason = f"graph check running or queued (pid {os.getpid()})"
    marker = git_dir / "locked"
    owned = False
    if git_dir != common and not marker.exists():
        result = subprocess.run(["git", "worktree", "lock", "--reason", reason, str(Path.cwd())], capture_output=True, text=True)
        owned = result.returncode == 0
        if not owned and not marker.exists():
            raise RuntimeError(result.stderr.strip())
    try:
        yield
    finally:
        if owned and marker.exists() and marker.read_text().strip() == reason:
            subprocess.run(["git", "worktree", "unlock", str(Path.cwd())], check=True)


def main():
    def stop_waiting(signum, _frame):
        raise SystemExit(128 + signum)

    signal.signal(signal.SIGTERM, stop_waiting)
    location = subprocess.check_output(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        text=True,
    ).strip()
    common = Path(location)
    command = sys.argv[1:]
    continuation = command[:1] == ["--continue"]
    if continuation:
        command = command[1:]
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        steps = ("check:backend", "typecheck", "lint", "test:report", "check:baseline", "check:evidence")
        command = ["/bin/sh", "-c", " && ".join(f"node --run {step}" for step in steps)]
    with protect_worktree(common):
        return run_queued(common, command, continuation)


def run_queued(common, command, continuation):
    shared = Path("/tmp") / f"graph-check-{os.getuid()}"
    shared.mkdir(mode=0o700, exist_ok=True)
    lock_path = shared / "slot.lock"
    if continuation and has_queue_ancestor():
        with lock_path.open("a+") as lock:
            return run(command, lock)
    with lock_path.open("a+") as lock:
        next_notice = 0
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= next_notice:
                    print("[check queue] Another worktree is checking; waiting for its slot", flush=True)
                    next_notice = time.monotonic() + 30
                time.sleep(1)
        wait_for_legacy_checks(shared)
        print(f"[check queue] Running in {Path.cwd()}", flush=True)
        return run(command, lock)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)

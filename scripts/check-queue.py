#!/usr/bin/env python3
"""Serialize full checks across Git worktrees without changing their verdicts.

The machine-wide slot is a file lock, and a file lock cannot say who holds it:
an empty `slot.lock` looks the same held and idle. So the holder writes down who
it is - pid, process start time, work directory, and a heartbeat - and a waiter
that cannot take the lock reads that record instead of waiting blindly.

A waiter reclaims the slot only when it can name the evidence:

  owner_gone         the recorded pid is not the process that recorded it any more,
                     so the owner died and only an inherited descriptor still holds
                     the lock (a killed runner's child);
  heartbeat_stalled  the heartbeat is minutes old and the work directory has not
                     moved for longer, so nothing under it is making progress.

Anything else - an empty lock from an older version, a record that cannot be
parsed - is not evidence, and the waiter keeps waiting. Deleting the lock by hand
is never the answer, and neither is a fixed sleep long enough to guess.
"""

import fcntl
from contextlib import contextmanager
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time


# How often a holder says it is still there, and when a silent holder is suspect.
HEARTBEAT_SECONDS = 10
STALE_HEARTBEAT_SECONDS = 120
STALE_DIRECTORY_SECONDS = 600
NOTICE_SECONDS = 30
# How long a reclaim waits for the process it judged to actually be gone.
KILL_WAIT_SECONDS = 5


def process_start(pid):
    """When the process with this pid started, or None when we cannot ask.

    None is not "it is gone": a restricted sandbox refuses to spawn ps at all,
    and reading that refusal as evidence would hand a live holder's slot to the
    next waiter. The caller decides what to do without the answer.
    """
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "lstart="],
            capture_output=True, text=True, check=False,
        )
    except OSError:
        return None
    return result.stdout.strip()


def process_alive(pid):
    """Whether a pid names a live process, without asking ps.

    ESRCH is the only answer that means "no such process"; a permission error
    means one exists and belongs to somebody else.
    """
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def holder_gone(pid, start):
    """Whether the recorded process is provably not running any more."""
    if not isinstance(pid, int) or pid <= 1:
        return False
    if not process_alive(pid):
        return True
    observed = process_start(pid)
    return observed is not None and observed != start


def holder_is_that_process(pid, start):
    """Whether this pid is still the process the record names."""
    if not isinstance(pid, int) or pid <= 1:
        return False
    observed = process_start(pid)
    if observed is not None:
        return observed == start
    return process_alive(pid)


def ps_row(pid):
    """One ps row, or None when this environment does not let us ask.

    A restricted agent sandbox refuses to spawn ps at all (PermissionError), and
    that refusal used to break the whole gate: the run died before the first
    check. Not being able to look is not evidence of an ancestor, so say so and
    let the file lock below keep the runs serialized anyway.
    """
    try:
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "ppid=", "-o", "args="],
            capture_output=True, text=True, check=False,
        )
    except OSError as error:
        sys.stderr.write(f"check-queue: cannot inspect processes ({error}); assuming no queue ancestor\n")
        return None
    return result.stdout.strip().split(None, 2)


def has_queue_ancestor():
    pid = os.getppid()
    while pid > 1:
        row = ps_row(pid)
        if row is None:
            return False
        if len(row) < 3:
            return False
        if Path(row[2].split()[0]).name == "check-queue.py":
            return True
        pid = int(row[0])
    return False


def shared_directory():
    """The machine-wide slot directory.

    GRAPH_CHECK_QUEUE_DIR exists so a test or a repair can own a queue of its
    own: judging a lock by killing what holds it is not something to rehearse on
    the slot every worktree on this machine shares.
    """
    override = os.environ.get("GRAPH_CHECK_QUEUE_DIR")
    if override:
        return Path(override)
    return Path("/tmp") / f"graph-check-{os.getuid()}"


def wait_for_legacy_checks(shared):
    path = shared / "graph-check-legacy.json"
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
            next_notice = time.monotonic() + NOTICE_SECONDS
        time.sleep(2)


def read_record(lock_path):
    """The holder's record, or None when the file says nothing legible.

    A holder rewrites the record in place, so a reader can catch it mid-write.
    Retrying briefly keeps that from being read as "the holder is gone"; a record
    that never parses is not evidence either way, and the caller waits.
    """
    for attempt in range(3):
        try:
            text = lock_path.read_text()
        except OSError:
            return None
        if not text.strip():
            return None
        try:
            record = json.loads(text)
        except ValueError:
            time.sleep(0.05 * (attempt + 1))
            continue
        return record if isinstance(record, dict) else None
    return None


def write_record(lock, record):
    """Write the record in place, without replacing the locked file.

    Replacing the file would break the lock itself: the flock lives on the open
    file, and a new inode would let the next waiter take a different lock.
    """
    data = json.dumps(record, sort_keys=True).encode()
    locked = lock.fileno()
    os.pwrite(locked, data, 0)
    os.ftruncate(locked, len(data))


def clear_record(lock):
    try:
        os.ftruncate(lock.fileno(), 0)
    except OSError:
        pass


def directory_is_idle(cwd):
    """Whether the holder's work directory has stopped moving.

    A directory that is gone cannot be making progress, and one whose mtime is
    older than the stall bound has not been written to since then. This is the
    half of the judgment that does not depend on the holder talking.
    """
    if not isinstance(cwd, str) or not cwd:
        return False
    try:
        age = time.time() - os.stat(cwd).st_mtime
    except OSError:
        return True
    return age > STALE_DIRECTORY_SECONDS


def stale_reason(record):
    """Name why this slot is stale, or None when the record is not evidence."""
    if holder_gone(record.get("pid"), record.get("start")):
        return "owner_gone"
    heartbeat = record.get("heartbeatAt")
    if isinstance(heartbeat, (int, float)):
        silence = time.time() - heartbeat
        if silence > STALE_HEARTBEAT_SECONDS and directory_is_idle(record.get("cwd")):
            return "heartbeat_stalled"
    return None


def signal_holder(pid, start, signum):
    """Signal one recorded process, but only while it is provably that process.

    A pid whose start time has changed belongs to something else now, and
    killing it would be killing an innocent process that merely inherited the
    number. The group is signalled only when the target leads it and it is not
    this waiter's own group: a check is started in a session of its own, so its
    group is its tree, and a waiter must never signal itself.
    """
    if not holder_is_that_process(pid, start):
        return False
    try:
        leads_own_group = os.getpgid(pid) == pid and pid != os.getpgid(0)
    except OSError:
        leads_own_group = False
    try:
        if leads_own_group:
            os.killpg(pid, signum)
        else:
            os.kill(pid, signum)
    except OSError:
        return False
    return True


def stop_holders(record):
    """Ask the recorded processes to leave, and insist if they do not.

    The child comes first: a killed runner leaves its child holding the inherited
    lock descriptor, and that child is the one thing standing between the waiter
    and the slot.
    """
    holders = [(record.get("childPid"), record.get("childStart")), (record.get("pid"), record.get("start"))]
    signalled = [(pid, start) for pid, start in holders if signal_holder(pid, start, signal.SIGTERM)]
    deadline = time.monotonic() + KILL_WAIT_SECONDS
    remaining = list(signalled)
    while remaining and time.monotonic() < deadline:
        remaining = [(pid, start) for pid, start in remaining if holder_is_that_process(pid, start)]
        if remaining:
            time.sleep(0.05)
    for pid, start in remaining:
        signal_holder(pid, start, signal.SIGKILL)


def reclaim_stale(lock_path):
    """Give back a slot whose holder is provably not working, and say so."""
    record = read_record(lock_path)
    if record is None:
        return False
    reason = stale_reason(record)
    if reason is None:
        return False
    print(f"[check queue] Reclaimed stale slot held by pid {record.get('pid')} ({reason})", flush=True)
    stop_holders(record)
    return True


class Heartbeat:
    """Says the holder is still working, from a thread that cannot block the check."""

    def __init__(self, lock):
        self.lock = lock
        self.stopped = threading.Event()
        self.guard = threading.Lock()
        self.record = {"pid": os.getpid(), "start": process_start(os.getpid()), "cwd": str(Path.cwd()), "runId": str(os.getpid())}
        self.thread = threading.Thread(target=self.beat, daemon=True)

    def start(self):
        self.say()
        self.thread.start()

    def adopt(self, child):
        with self.guard:
            self.record["childPid"] = child.pid
            self.record["childStart"] = process_start(child.pid)
        self.say()

    def say(self):
        with self.guard:
            self.record["heartbeatAt"] = time.time()
            write_record(self.lock, self.record)

    def beat(self):
        while not self.stopped.wait(HEARTBEAT_SECONDS):
            self.say()

    def stop(self):
        self.stopped.set()
        self.thread.join(timeout=1)
        clear_record(self.lock)


def run(command, lock=None, heartbeat=None):
    environment = os.environ.copy()
    environment.setdefault("GOMAXPROCS", "2")
    child = subprocess.Popen(
        command, env=environment, start_new_session=True,
        pass_fds=(() if lock is None else (lock.fileno(),)),
    )
    if heartbeat is not None:
        heartbeat.adopt(child)

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
        # The blocking gate takes no machine-wide slot at all.
        #
        # Measured 2026-11-05: a commit waited 236s and counting for
        # "[check queue] Another worktree is checking" while the async full suite
        # ran in a worktree of its own. That slot protects daemons and scratch
        # directories shared by full runs; the blocking gate is now bounded to a
        # handful of files, and the worktree lock below already keeps two gates out
        # of the same checkout. So it runs beside the full suite instead of behind
        # it, and the suite it used to wait for is the one that no longer decides
        # whether a commit lands.
        static = (
            ("go", "-C", "backend", "run", "./cmd/graphbuild", "backend"),
            ("go", "-C", "backend", "vet", "./..."),
            ("go", "-C", "backend", "test", "-short", "./..."),
            # Go keys its test cache on files inside the package's own module, and these
            # packages read data that lives outside it - verification/ is a separate module,
            # and the rest read docs, presets or the repository root. Measured 2026-11-21: a
            # broken soft-rule witness kept passing as "(cached)" because only that data file
            # changed. So the packages that read outside their module run fresh every time;
            # the rest of ./... stays cached. scripts/test_data_freshness.py fails when a
            # package starts reading outside backend/ without being listed here, and when this
            # list names a package that does not.
            ("go", "-C", "backend", "test", "-short", "-count=1",
             "./cmd/graphcheck", "./internal/gate", "./internal/graph",
             "./internal/graph/embedded", "./internal/appinstall", "./internal/harness"),
            ("go", "-C", "app", "vet", "./..."),
            ("go", "-C", "app", "test", "-short", "./..."),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "comments"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "ownership"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "api"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "machines"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "tokens", "--changed"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "harness"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "evidence"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "prose"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "prose", "--staged"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "softrules"),
            ("go", "-C", "backend", "run", "./cmd/graphcheck", "scriptfiles"),
            # Contract tests over the gate itself. They live in scripts/, so nothing in ./...
            # runs them: a rule nothing executes is the same prose this repository is deleting.
            ("python3", "-m", "unittest", "scripts.test_data_freshness"),
        )
        with protect_worktree(common):
            for step in static:
                code = run(list(step))
                if code:
                    return code
            return 0
    with protect_worktree(common):
        return run_queued(common, command, continuation)


def run_queued(common, command, continuation):
    shared = shared_directory()
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
                if reclaim_stale(lock_path):
                    # The holder was judged and asked to leave; give the kernel a
                    # moment to close its descriptor before asking for the lock.
                    time.sleep(0.2)
                    continue
                if time.monotonic() >= next_notice:
                    print("[check queue] Another worktree is checking; waiting for its slot", flush=True)
                    next_notice = time.monotonic() + NOTICE_SECONDS
                time.sleep(1)
        wait_for_legacy_checks(shared)
        print(f"[check queue] Running in {Path.cwd()}", flush=True)
        heartbeat = Heartbeat(lock)
        heartbeat.start()
        try:
            return run(command, lock, heartbeat)
        finally:
            heartbeat.stop()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)

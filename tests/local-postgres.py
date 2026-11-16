"""Hold a local Homebrew PostgreSQL instance for the lifetime of one test runner."""
from fcntl import LOCK_EX, LOCK_NB, LOCK_SH, LOCK_UN, flock
from pathlib import Path
import os
import subprocess
import sys


def postmaster(data):
    path = data / "postmaster.pid"
    try:
        # The PID and the server's start time distinguish a later manual restart.
        return "\n".join(path.read_text().splitlines()[:3])
    except FileNotFoundError:
        return ""


def stop_if_idle(control, leases, ctl, bin_dir, data, connection):
    control.seek(0)
    current = postmaster(data)
    if not current or control.read() != current:
        return  # A database started outside the test suite has its own owner.
    try:
        flock(leases, LOCK_EX | LOCK_NB)
    except BlockingIOError:
        return

    # A local development process can attach while tests are running.
    # Stop only when the test suite owns the instance and there are no clients.
    clients = subprocess.run(
        [str(bin_dir / "psql"), *connection, "-XwAtc",
         "SELECT count(*) FROM pg_stat_activity "
         "WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()"],
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True,
        env=os.environ | {"PGCONNECT_TIMEOUT": "3"},
    )
    if clients.returncode == 0 and clients.stdout.strip() == "0":
        subprocess.run([*ctl, "-w", "-m", "smart", "stop"],
                       stdin=subprocess.DEVNULL, stdout=sys.stderr, check=True)
        control.seek(0)
        control.truncate()
    else:
        print("PostgreSQL remains available to other local clients.", file=sys.stderr)


def use_server(bin_dir, data, host):
    os.umask(0o077)
    state = Path.home() / "Library/Caches/aihot-test-postgres"
    state.mkdir(parents=True, exist_ok=True)
    ctl = [str(bin_dir / "pg_ctl"), "-D", str(data)]
    connection = ["-h", host, "-p", "5432", "-d", "postgres"]

    # The control lock serializes start and stop. Each live test holds a shared
    # lock on the second file, including while it creates and removes test copies.
    with (state / "owner").open("a+") as control, (state / "leases").open("a") as leases:
        flock(control, LOCK_EX)
        flock(leases, LOCK_SH)
        try:
            ready = subprocess.run([str(bin_dir / "pg_isready"), *connection, "-q", "-t", "1"],
                                   stdin=subprocess.DEVNULL)
            if ready.returncode == 2:
                log = state / "postgres.log"
                log.write_text("")
                subprocess.run([*ctl, "-w", "-l", str(log), "start"],
                               stdin=subprocess.DEVNULL, stdout=sys.stderr, check=True)
                control.seek(0)
                control.truncate()
                control.write(postmaster(data))
                control.flush()
        finally:
            flock(control, LOCK_UN)

        try:
            print("ready", flush=True)
            # The runner closes this pipe after teardown. The OS also closes it
            # if the runner exits before reaching teardown.
            sys.stdin.buffer.read()
        finally:
            flock(control, LOCK_EX)
            flock(leases, LOCK_UN)
            stop_if_idle(control, leases, ctl, bin_dir, data, connection)


if __name__ == "__main__":
    bin_path, data_path, target = sys.argv[1:]
    use_server(Path(bin_path), Path(data_path), target)

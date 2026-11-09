#!/usr/bin/env python3
"""
Shelf opener: lets Shelf running in Docker start programs on YOUR desktop.

A container can't launch windows on the host, so this tiny program runs on the host as you and listens
on a private unix socket (mode 600, a folder only you can enter). Shelf sends it "run this program with
these arguments"; the program is always one of the commands you saved under Settings > Programs.
Nothing listens on the network. No shell is involved: the arguments are passed as-is.

Started and stopped for you by ./shelf.sh. Standard library only (Python 3.6+).
"""
import json
import os
import signal
import socketserver
import subprocess
import sys
import tempfile
import threading

WAIT = 1.5  # seconds we watch a new program for an immediate failure


def run(argv, cwd):
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv) or "\0" in "".join(argv):
        return {"error": "bad request"}
    argv = [os.path.expanduser(a) if a == "~" or a.startswith("~/") else a for a in argv]
    cwd = cwd if isinstance(cwd, str) and os.path.isdir(cwd) else os.path.expanduser("~")
    log = tempfile.TemporaryFile()
    try:
        p = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
    except FileNotFoundError:
        return {"error": "command not found: %s" % argv[0]}
    except PermissionError:
        return {"error": "not allowed to run: %s" % argv[0]}
    except OSError as e:
        return {"error": str(e)}
    try:
        code = p.wait(timeout=WAIT)
    except subprocess.TimeoutExpired:
        return {"ok": True}  # still running: assume it opened
    if code == 0:
        return {"ok": True}
    log.seek(0)
    tail = log.read().decode("utf-8", "replace").strip()[-300:]
    msg = "%s exited with %s" % (os.path.basename(argv[0]), code)
    return {"error": msg + (": " + tail if tail else "")}


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            req = json.loads(self.rfile.readline(1 << 20).decode("utf-8"))
            out = run(req.get("argv"), req.get("cwd"))
        except Exception as e:  # never let a bad request kill the helper
            out = {"error": "bad request (%s)" % e}
        self.wfile.write((json.dumps(out) + "\n").encode("utf-8"))


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: shelf-opener.py SOCKET_PATH")
    path = sys.argv[1]
    folder = os.path.dirname(path)
    os.makedirs(folder, mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    old = os.umask(0o177)
    srv = Server(path, Handler)
    os.umask(old)
    os.chmod(path, 0o600)
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))  # runs the cleanup below
    print("shelf-opener listening on %s (DISPLAY=%s)" % (path, os.environ.get("DISPLAY", "unset")), flush=True)
    try:
        srv.serve_forever()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


if __name__ == "__main__":
    threading.current_thread().name = "main"
    main()

"""Kernel ownership and platform-specific settlement for a private mirror fetch.

The lock inode is permanent. Never unlink it: another opener may already hold it.
The single-threaded guardian never reaps a child between enumerating and signaling
it, so a child PID cannot be recycled in that interval.
"""
import ctypes
import fcntl
import json
import os
import shutil
import signal
import select
import subprocess
import sys
import time


def run():
    request = sys.stdin.buffer.read()
    mirror = json.loads(request)['mirror']
    attempt = mirror + '.fetch-lock'
    fd = os.open(mirror + '.fetch-mutex', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise RuntimeError('mirror fetch already in progress (kernel lock held)')
    expected = json.dumps({'version': 1, 'mirror': mirror}).encode()
    receipt_path = mirror + '.fetch-owner.json'
    try:
        with open(receipt_path, 'rb') as source:
            receipt = source.read(4096)
    except FileNotFoundError:
        receipt = None
    if receipt is None and not os.path.exists(attempt):
        # Publish atomically before creating any disposable state. An interrupted
        # publication has no attempt to clean; the next owner can repeat it.
        with open(receipt_path + '.new', 'wb') as target:
            os.chmod(target.fileno(), 0o600)
            target.write(expected)
            target.flush()
            os.fsync(target.fileno())
        os.replace(receipt_path + '.new', receipt_path)
        parent_fd = os.open(os.path.dirname(mirror), os.O_RDONLY | os.O_DIRECTORY)
        os.fsync(parent_fd)
        os.close(parent_fd)
    elif receipt != expected:
        raise RuntimeError('mirror fetch ownership receipt missing or corrupt; private attempt left untouched')
    # Acquiring flock proves all previous cooperating owners have closed it.
    # Set subreaper BEFORE spawning: orphan Git descendants become our children.
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'linux' and libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(ctypes.get_errno(), 'cannot establish mirror fetch subreaper')
    # The live anchor and actual Git stderr descriptors retain this separate
    # barrier even if both the guardian and Node die. Never clean a live writer.
    settle(mirror, nonblocking=True)
    if os.path.exists(attempt):
        shutil.rmtree(attempt)
    child = subprocess.Popen([sys.argv[1], sys.argv[2], '--owned-fetch', str(fd)],
                             stdin=subprocess.PIPE, pass_fds=(fd,),
                             start_new_session=sys.platform == 'darwin')
    child.stdin.write(request)
    child.stdin.close()
    if sys.platform == 'darwin':
        # NOTE_EXIT observes without waitpid/reaping. Our unreaped direct child
        # pins the PGID until the final signal, including synchronous Git calls.
        queue = select.kqueue()
        event = select.kevent(child.pid, filter=select.KQ_FILTER_PROC,
                              flags=select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                              fflags=select.KQ_NOTE_EXIT)
        queue.control([event], 1, None)
        queue.close()
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            # Darwin returns EPERM for an all-zombie group. This signal is
            # best effort; inherited flock descriptions remain the cleanup
            # authority even if a member cannot be signaled.
            pass
    code = child.wait()
    settle(mirror)
    # Node may have been SIGKILLed with detached Git grandchildren still writing.
    # Keep flock until every descendant is reaped, including orphan grandchildren.
    deadline = time.monotonic() + 5
    warned = False
    while sys.platform == 'linux':
        try:
            while os.waitpid(-1, os.WNOHANG)[0]:
                pass
        except ChildProcessError:
            break
        children = open(f'/proc/self/task/{os.getpid()}/children').read().split()
        for pid in children:
            os.kill(int(pid), signal.SIGKILL)
        if time.monotonic() > deadline and not warned:
            print('mirror fetch children still settling; kernel lock remains held', file=sys.stderr)
            warned = True
        time.sleep(.01)
    os.close(fd)
    return code if code >= 0 else 1


def settle(mirror, nonblocking=False):
    fd = os.open(mirror + '.fetch-writers', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | (fcntl.LOCK_NB if nonblocking else 0))
    except BlockingIOError:
        raise RuntimeError('mirror fetch already in progress (writers still settling)')
    finally:
        os.close(fd)


def anchor():
    """One fetch group on either supported OS, anchored until its final group-wide SIGKILL.

    Only Node retains the control pipe's write end; Git receives /dev/null.
    The anchor survives loss of Node and its guardian and detects pipe EOF.
    Git's stderr IS the writer lock's open description, not a PID receipt.
    """
    mirror, timeout, inherited = sys.argv[2:5]
    fd = os.open(mirror + '.fetch-writers', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX)
    os.ftruncate(fd, 0)
    child = None
    try:
        child = subprocess.Popen(sys.argv[5:], stdin=subprocess.DEVNULL,
                                 stdout=subprocess.DEVNULL, stderr=fd,
                                 pass_fds=(int(inherited), fd))
        deadline = time.monotonic() + float(timeout) / 1000
        timed_out = False
        while child.poll() is None:
            if select.select([0], [], [], .02)[0] and not os.read(0, 1):
                return
            if time.monotonic() >= deadline:
                timed_out = True
                break
        # Output is a result, not settlement authority. The caller must acquire
        # the independent writer barrier after this anchor has killed its group.
        os.lseek(fd, max(0, os.lseek(fd, 0, os.SEEK_END) - 8192), os.SEEK_SET)
        print(json.dumps({'code': child.returncode, 'timedOut': timed_out,
                          'stderr': os.read(fd, 8192).decode(errors='replace')}), flush=True)
    finally:
        # Our live PID pins the group identity. Do not reap/exit this anchor and
        # later signal a recorded PGID, which could have been reused.
        os.killpg(os.getpid(), signal.SIGKILL)


try:
    if sys.platform not in ('linux', 'darwin'):
        raise RuntimeError('mirror fetch requires Linux or macOS')
    if sys.argv[1] == '--check':
        if sys.version_info < (3, 8):
            raise RuntimeError('Python 3.8 or newer required')
        sys.exit(0)
    if sys.argv[1] == '--settle':
        settle(sys.argv[2])
        sys.exit(0)
    if sys.argv[1] == '--anchor':
        anchor()
    else:
        sys.exit(run())
except Exception as error:
    print(str(error), file=sys.stderr)
    sys.exit(1)

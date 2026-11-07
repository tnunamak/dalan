import json
import os
import signal
import sys


def process_fields(pid):
    with open(f'/proc/{pid}/stat', encoding='utf-8') as stream:
        text = stream.read()
    fields = text[text.rfind(')') + 2:].split()
    return fields[0], int(fields[2]), int(fields[19])


def in_scope(pid, start, group, scope):
    init = scope.get('init') or {}
    if pid == init.get('pid') and start == init.get('start'):
        return True
    sandbox_start = scope.get('sandboxStart')
    if sandbox_start is not None and start < sandbox_start:
        return False
    namespace = scope.get('nsInode')
    in_namespace = False
    if namespace is not None:
        try:
            in_namespace = os.readlink(f'/proc/{pid}/ns/pid') == f'pid:[{namespace}]'
        except OSError:
            pass
    return in_namespace or scope.get('pgid') is not None and group == scope['pgid']


def main():
    request = json.load(sys.stdin)
    signalled = []
    for candidate in request['processes']:
        pid = candidate['pid']
        if pid == os.getpid():
            continue
        try:
            fd = os.pidfd_open(pid, 0)
        except (AttributeError, ProcessLookupError, PermissionError):
            continue
        try:
            state, group, start = process_fields(pid)
            if state in ('Z', 'X') or start != candidate['start'] or not in_scope(pid, start, group, request['scope']):
                continue
            signal.pidfd_send_signal(fd, signal.SIGKILL)
            signalled.append(pid)
        except (AttributeError, FileNotFoundError, ProcessLookupError, PermissionError):
            pass
        finally:
            os.close(fd)
    json.dump(signalled, sys.stdout)


if __name__ == '__main__':
    main()

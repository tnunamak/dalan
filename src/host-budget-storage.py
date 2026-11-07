#!/usr/bin/env python3
"""Trusted source producer and namespace-init supervisor for one resource envelope."""
import ctypes
import hashlib
import base64
import json
import os
import selectors
import signal
import subprocess
import sys
import tarfile
import threading
import time


def send(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


if sys.argv[1] != '--inside':
    if sys.version_info < (3, 12):
        raise RuntimeError('Python 3.12+ with safe tar extraction required')
    config = json.loads(sys.argv[1])
    node = config['node']
    npm = os.path.abspath(os.path.join(os.path.dirname(node), '../lib/node_modules/npm'))
    read_fd, write_fd = os.pipe()
    config_fd=os.memfd_create('dot-host-config')
    guest_config = dict(config)
    if config['dependencies']:
        guest_config['dependencies'] = {key: value for key, value in config['dependencies'].items() if key != 'treePath'}
    os.write(config_fd,json.dumps(guest_config).encode())
    os.lseek(config_fd,0,0)
    extra_fds=[config_fd]
    # No source tree is bound into the guest: masked originals cannot be reached
    # via an alternate /input path. Archive data is streamed, never buffered whole.
    binds = [part for name in ['/usr', '/lib', '/lib64', '/etc/alternatives'] if os.path.exists(name) for part in ['--ro-bind', name, name]]
    command = ['/usr/bin/bwrap', '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts', '--unshare-cgroup',
               '--disable-userns', '--as-pid-1', '--die-with-parent', '--new-session', *binds,
               '--symlink', 'usr/bin', '/bin', '--ro-bind', node, '/runtime/node',
               '--ro-bind', os.path.abspath(__file__), '/supervisor.py', '--ro-bind-data', str(config_fd), '/config.json',
               '--ro-bind', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'host-budget-seccomp.py'), '/host-budget-seccomp.py',
               '--ro-bind', sys.argv[2], '/cgroup', '--size', str(config['budgets']['disk_write_bytes']), '--tmpfs', '/budget',
               '--dir', '/budget/workspace', '--dir', '/budget/tmp', '--dir', '/budget/home/.tmp', '--dir', '/budget/cache', '--dir', '/budget/bin',
               '--symlink', '/budget/workspace', '/workspace', '--symlink', '/budget/tmp', '/tmp', '--symlink', '/budget/cache', '/cache',
               '--dir', '/home', '--symlink', '/budget/home', '/home/worker']
    if os.path.isdir(npm):
        command += ['--ro-bind', npm, '/runtime/npm']
    if config['dependencies']:
        command += ['--ro-bind', config['dependencies']['treePath'], '/budget/workspace/node_modules']
    # Empty sensitive files and host-approved source overlays stay read-only.
    for name in config['maskPaths']:
        empty=os.memfd_create('dot-host-mask')
        extra_fds.append(empty)
        command += ['--ro-bind-data', str(empty), '/budget/workspace/' + name]
    # The namespace has only `lo`, but the NAME localhost needs files too. Bridge-generated, host-data-free and read-only:
    # public names still fail at once because there is no resolver and no route.
    for target, body in (('/etc/hosts', b'127.0.0.1 localhost\n::1 localhost\n'), ('/etc/nsswitch.conf', b'hosts: files\n')):
        name_fd=os.memfd_create('dot-host-name')
        os.write(name_fd,body)
        os.lseek(name_fd,0,0)
        extra_fds.append(name_fd)
        command += ['--ro-bind-data', str(name_fd), target]
    for entry in config['sourceExemptions']:
        command += ['--ro-bind', entry['hostPath'], '/budget/workspace/' + entry['path']]
    # No devpts allocator: checks are non-interactive and must not consume the
    # host's global PTY pool. Shared-memory files use the same bounded tmpfs.
    command += ['--dir', '/dev']
    for device in ['null', 'zero', 'full', 'random', 'urandom']:
        command += ['--dev-bind', '/dev/' + device, '/dev/' + device]
    command += ['--symlink', '/proc/self/fd', '/dev/fd', '--symlink', '/proc/self/fd/0', '/dev/stdin',
                '--symlink', '/proc/self/fd/1', '/dev/stdout', '--symlink', '/proc/self/fd/2', '/dev/stderr',
                '--symlink', '/budget/tmp', '/dev/shm',
                '--proc', '/proc', '--remount-ro', '/proc', '--remount-ro', '/', '--clearenv',
                '--setenv', 'PATH', '/budget/bin:/runtime:/usr/bin:/bin', '--setenv', 'HOME', '/home/worker', '--setenv', 'TMPDIR', '/tmp',
                '--setenv', 'XDG_CACHE_HOME', '/cache/xdg', '--setenv', 'npm_config_cache', '/cache/npm', '--setenv', 'UV_CACHE_DIR', '/cache/uv',
                '--setenv', 'CARGO_HOME', '/cache/cargo', '--setenv', 'GOPATH', '/cache/go', '--setenv', 'GOMODCACHE', '/cache/go/pkg/mod',
                '--', '/usr/bin/python3', '/supervisor.py', '--inside', str(read_fd)]
    child = subprocess.Popen(command, pass_fds=[read_fd,*extra_fds], stdin=sys.stdin)
    os.close(read_fd)
    for descriptor in extra_fds:
        os.close(descriptor)
    excluded = set(config['maskPaths']) | {e['path'] for e in config['sourceExemptions']}

    def include(info):
        name = info.name.removeprefix('./').rstrip('/')
        if '.git' in name.split('/') or 'node_modules' in name.split('/') or name in excluded:
            return None
        if not (info.isfile() or info.isdir() or info.issym()):
            raise ValueError('unsupported source file type: ' + name)
        return info

    def produce():
        try:
            with os.fdopen(write_fd, 'wb') as output:
                with tarfile.open(fileobj=output, mode='w|', dereference=False) as archive:
                    archive.add(config['dir'], arcname='.', filter=include)
        except (BrokenPipeError, OSError):
            pass  # The guest may already have hit memory/storage/time admission.

    producer = threading.Thread(target=produce, daemon=True)
    producer.start()
    sys.exit(child.wait())

# Namespace PID 1 cannot be signalled by descendants without installed handlers.
# Non-dumpable state also denies /proc/1/fd access and ptrace of the receipt pipe.
if os.getpid() != 1 or ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) != 0:
    raise RuntimeError('protected namespace-init supervisor required')
with open('/config.json', encoding='utf-8') as stream:
    config = json.load(stream)
budgets = config['budgets']
started = time.monotonic()
error = None
output_total = 0
results = []
cancelled = False


def fields(name):
    with open('/cgroup/' + name, encoding='utf-8') as stream:
        return {parts[0]: int(parts[1]) for line in stream if len(parts := line.split()) == 2}


def usage():
    capacity = os.statvfs('/budget')
    return {'cpu_ms': fields('cpu.stat')['usage_usec'] / 1000,
            'memory_bytes': int(open('/cgroup/memory.peak').read()),
            'processes': int(open('/cgroup/pids.peak').read()),
            'disk_write_bytes': (capacity.f_blocks - capacity.f_bfree) * capacity.f_frsize,
            'output_bytes': output_total}


def inspect():
    global error
    used = usage()
    which = ('disk_write' if used['disk_write_bytes'] >= budgets['disk_write_bytes'] else
             'memory' if fields('memory.events').get('max', 0) else
             'processes' if fields('pids.events').get('max', 0) else
             'cpu' if used['cpu_ms'] >= budgets['cpu_ms'] else None)
    if which and error is None:
        error = 'budget exceeded: ' + which
    return used


def stop_descendants():
    # /proc is this new PID namespace, whose only trusted member is PID 1.
    # Signal only these job PIDs, never a host process group or shared service.
    for entry in os.listdir('/proc'):
        if entry.isdecimal() and int(entry) != 1:
            try:
                os.kill(int(entry), signal.SIGKILL)
            except ProcessLookupError:
                pass
    while True:
        try:
            os.waitpid(-1, 0)
        except ChildProcessError:
            return


try:
    with os.fdopen(int(sys.argv[2]), 'rb') as source:
        with tarfile.open(fileobj=source, mode='r|') as archive:
            archive.extractall('/workspace', filter='data')
    dependencies = config['dependencies']
    if dependencies:
        for name, key in [('package-lock.json', 'lock_sha256'), ('package.json', 'manifest_sha256')]:
            with open('/workspace/' + name, 'rb') as stream:
                if hashlib.sha256(stream.read()).hexdigest() != dependencies[key]:
                    raise ValueError('dependencies_invalid: copied dependency inputs changed')
    elif os.path.lexists('/workspace/package-lock.json'):
        raise ValueError('dependencies_invalid: copied lock appeared after admission')
    for name in ['npm', 'npx']:
        file = '/budget/bin/' + name
        with open(file, 'w') as stream:
            stream.write('#!/bin/sh\nexec /runtime/node /runtime/npm/bin/' + name + '-cli.js "$@"\n')
        os.chmod(file, 0o755)
    with open('/budget/bin/systemctl', 'w') as stream:
        stream.write('#!/bin/sh\n[ "$1" = "--user" ] && [ "$2" = "list-units" ]\n')
    os.chmod('/budget/bin/systemctl', 0o755)
    import importlib.util
    seccomp_spec = importlib.util.spec_from_file_location('host_budget_seccomp', '/host-budget-seccomp.py')
    seccomp = importlib.util.module_from_spec(seccomp_spec)
    seccomp_spec.loader.exec_module(seccomp)
    seccomp.install()
    for phase in config['phases']:
        inspect()
        if error:
            break
        begin = time.monotonic()
        chunks = bytearray()
        pending = bytearray()
        last_report = time.monotonic()
        child = subprocess.Popen(phase['argv'], cwd='/workspace', stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
        send({'event': 'started', 'phase': phase['name']})
        announced = False
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ, 'output')
        selector.register(child.stderr, selectors.EVENT_READ, 'output')
        selector.register(sys.stdin, selectors.EVENT_READ, 'control')
        while child.poll() is None:
            inspect()
            for key, _ in selector.select(0.01):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if key.data == 'control':
                    cancelled = bool(chunk)
                    error = error or ('cancelled' if chunk else 'supervisor interrupted')
                    selector.unregister(key.fileobj)
                elif not chunk:
                    selector.unregister(key.fileobj)
                else:
                    if not announced:
                        send({'event': 'output_started', 'phase': phase['name']})
                        announced = True
                    room = max(0, budgets['output_bytes'] - output_total)
                    chunks.extend(chunk[:room])
                    pending.extend(chunk[:room])
                    output_total += len(chunk)
                    if output_total > budgets['output_bytes']:
                        error = error or 'budget exceeded: output'
            now = time.monotonic()
            if now - last_report >= 0.1:
                send({'event': 'partial', 'phase': phase['name'], 'output': base64.b64encode(pending).decode(), 'usage': usage()})
                pending.clear()
                last_report = now
            if error:
                break
        # Kill/reap daemonized children before the next phase or final receipt.
        code = child.poll()
        stop_descendants()
        for stream in [child.stdout, child.stderr]:
            tail = stream.read(65536)
            room = max(0, budgets['output_bytes'] - output_total)
            chunks.extend(tail[:room])
            pending.extend(tail[:room])
            output_total += len(tail)
            stream.close()
        if output_total > budgets['output_bytes']:
            error = error or 'budget exceeded: output'
        if code is not None and code != 0:
            note = b'\nHost check restriction: file watching is unavailable; seccomp denies inotify_init and inotify_init1 (EPERM).\n'
            chunks.extend(note[:max(0, budgets['output_bytes'] - output_total)])
            pending.extend(note[:max(0, budgets['output_bytes'] - output_total)])
        selector.close()
        inspect()
        send({'event': 'partial', 'phase': phase['name'], 'output': base64.b64encode(pending).decode(), 'usage': usage()})
        results.append({'name': phase['name'], 'exit': {'code': code if code is not None and code >= 0 else 125},
                        'output': base64.b64encode(chunks).decode(), 'duration_ms': round((time.monotonic() - begin) * 1000)})
        if error or code != 0:
            break
except OSError as problem:
    error = 'budget exceeded: disk_write' if problem.errno == 28 else 'host preparation failed: ' + str(problem)
except Exception as problem:
    error = 'host preparation failed: ' + str(problem)
stop_descendants()
used = inspect()
send({'event': 'result', 'result': {'error': error, 'cancelled': cancelled, 'exit': results[-1]['exit'] if results else {'code': 125},
                                  'phases': results, 'usage': used, 'duration_ms': round((time.monotonic() - started) * 1000)}})
sys.exit(125 if error else 0)

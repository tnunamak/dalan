"""Deny guest allocations charged to shared per-user kernel quotas."""
import ctypes
import errno


def install(prctl=None):
    libc = ctypes.CDLL(None, use_errno=True)
    prctl = prctl or libc.prctl
    if prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise RuntimeError('seccomp unavailable: no_new_privs failed')
    try:
        sec = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    except OSError as error:
        raise RuntimeError('seccomp unavailable: libseccomp missing') from error
    sec.seccomp_init.argtypes = [ctypes.c_uint32]
    sec.seccomp_init.restype = ctypes.c_void_p
    sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    sec.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    sec.seccomp_load.argtypes = [ctypes.c_void_p]
    sec.seccomp_release.argtypes = [ctypes.c_void_p]
    context = sec.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not context:
        raise RuntimeError('seccomp unavailable: initialization failed')
    try:
        for name in (b'inotify_init', b'inotify_init1', b'fanotify_init', b'mq_open',
                     b'add_key', b'request_key', b'keyctl'):
            number = sec.seccomp_syscall_resolve_name(name)
            if number < 0 or sec.seccomp_rule_add(context, 0x00050000 | errno.EPERM, number, 0) != 0:
                raise RuntimeError('seccomp unavailable: cannot deny ' + name.decode())
        if sec.seccomp_load(context) != 0:
            raise RuntimeError('seccomp unavailable: filter installation failed')
    finally:
        sec.seccomp_release(context)

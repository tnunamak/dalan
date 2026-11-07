// The bridge's admin socket lives in the bridge home. A Unix socket path has a fixed size limit (108 bytes on Linux and
// 104 on macOS, including the terminating NUL), so a long bridge home cannot hold it. The server and every client check
// the path first and say so, in place of the system's bare EINVAL.
export const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 103 : 107; // usable bytes, excluding the terminating NUL

// Null when the path fits; otherwise the error to report.
export function adminSocketPathError(socket) {
  const bytes = Buffer.byteLength(socket);
  if (bytes <= SOCKET_PATH_LIMIT) return null;
  return Object.assign(
    new Error(`the bridge home path is too long for the admin socket: ${socket} is ${bytes} bytes, and the limit on this system is ${SOCKET_PATH_LIMIT}`),
    { code: 'ADMIN_SOCKET_PATH_TOO_LONG', fix: ['use a bridge home with a shorter path (DALAN_HOME)'] },
  );
}

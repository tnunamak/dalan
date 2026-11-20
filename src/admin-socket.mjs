// The bridge's admin socket normally lives in the bridge home: <home>/.local/share/dalan/admin.sock. A Unix socket path
// has a fixed size limit (108 bytes on Linux and 104 on macOS, including the terminating NUL), so a long bridge home
// cannot hold it. The path is short by construction: when the standard path does not fit, the socket moves to a private
// per-user directory under /tmp, named by a hash of the data directory, so every home gets its own short path and the
// server and every client compute the same one. The server alone creates that directory.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const socketPathLimit = platform => platform === 'darwin' ? 103 : 107; // usable bytes, excluding the terminating NUL
export const SOCKET_PATH_LIMIT = socketPathLimit(process.platform);

const currentUid = () => process.getuid?.() ?? 0;
export const shortSocketDir = (uid = currentUid()) => `/tmp/dalan-${uid}`;

// The admin socket path for a data directory. The standard path when it fits, otherwise the short one.
export function adminSocketPath(dataDir, { platform = process.platform, uid = currentUid(), dir = shortSocketDir(uid) } = {}) {
  const standard = path.join(dataDir, 'admin.sock');
  if (Buffer.byteLength(standard) <= socketPathLimit(platform)) return standard;
  const name = crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 16);
  return path.join(dir, `${name}.sock`);
}

// Server side: make the short socket directory if it is the one in use. It must be a real directory that only this user
// can use; a link or a directory that belongs to someone else is refused.
export function ensureAdminSocketDir(socket, { uid = currentUid(), dir = shortSocketDir(uid) } = {}) {
  if (path.dirname(socket) !== dir) return;
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw Object.assign(new Error(`the admin socket directory ${dir} is not a private directory owned by this user`),
      { code: 'ADMIN_SOCKET_DIR_UNSAFE', fix: [`remove or fix ${dir}, or use a bridge home with a shorter path (DALAN_HOME)`] });
  }
}

// Null when the path fits; otherwise the error to report.
export function adminSocketPathError(socket) {
  const bytes = Buffer.byteLength(socket);
  if (bytes <= SOCKET_PATH_LIMIT) return null;
  return Object.assign(
    new Error(`the bridge home path is too long for the admin socket: ${socket} is ${bytes} bytes, and the limit on this system is ${SOCKET_PATH_LIMIT}`),
    { code: 'ADMIN_SOCKET_PATH_TOO_LONG', fix: ['use a bridge home with a shorter path (DALAN_HOME)'] },
  );
}

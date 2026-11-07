const fdTypes = new Set(['file', 'socket', 'dir', 'fifo', 'chr', 'other']);

export function validateFdProbeRun({ job, row, results }) {
  if (job?.status !== 'completed' || job.error !== null) return { ok: false, reason: `check job was ${job?.status ?? 'missing'} (${job?.error ?? 'no error field'})` };
  if (row?.phase !== 'check' || row.exit_code !== 0) return { ok: false, reason: `check row was ${row?.phase ?? 'missing'} with exit ${row?.exit_code ?? 'missing'}` };
  if (!Array.isArray(results) || results.length !== 1) return { ok: false, reason: `expected one payload result, received ${Array.isArray(results) ? results.length : 'no array'}` };
  const payload = results[0];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.fds) || payload.fds.length === 0) {
    return { ok: false, reason: 'payload result has no nonempty fds array' };
  }
  const seen = new Set();
  for (const fd of payload.fds) {
    if (!fd || typeof fd !== 'object' || !Number.isInteger(fd.fd) || fd.fd < 3 || !fdTypes.has(fd.type) || (fd.link !== null && typeof fd.link !== 'string') || seen.has(fd.fd)) {
      return { ok: false, reason: 'payload result has a malformed or duplicate fd entry' };
    }
    seen.add(fd.fd);
  }
  return { ok: true, fds: payload.fds };
}

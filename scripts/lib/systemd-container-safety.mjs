const DOCKER_ID = /^[a-f0-9]{64}$/;
const REQUIRED_TMPFS = new Map([
  ['/run', 'rw,nosuid,nodev,mode=755'],
  ['/run/lock', 'rw,nosuid,nodev,noexec,mode=755'],
  ['/sys/fs/cgroup', 'rw,nosuid,nodev,noexec,mode=755'],
]);

export class SystemdContainerSafetyError extends Error {
  constructor(message) {
    super(`refusing unsafe systemd test container: ${message}`);
    this.name = 'SystemdContainerSafetyError';
  }
}

function reject(message) {
  throw new SystemdContainerSafetyError(message);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emptyOptionalArray(value, label) {
  if (value !== null && (!Array.isArray(value) || value.length !== 0)) {
    reject(`${label} must be null or empty`);
  }
}

function emptyOptionalRecord(value, label) {
  if (value !== null && (!record(value) || Object.keys(value).length !== 0)) {
    reject(`${label} must be null or empty`);
  }
}

function noPublishedPorts(value) {
  if (value === null) return;
  if (!record(value)) reject('NetworkSettings.Ports is malformed');
  for (const [port, bindings] of Object.entries(value)) {
    if (bindings !== null && (!Array.isArray(bindings) || bindings.length !== 0)) {
      reject(`host port bindings are not allowed (${port})`);
    }
  }
}

function validatePrivateTmpfs(host, inspection) {
  const tmpfs = requireProperty(host, 'Tmpfs', 'HostConfig');
  if (!record(tmpfs) || Object.keys(tmpfs).length !== REQUIRED_TMPFS.size ||
      Object.entries(tmpfs).some(([destination, options]) => REQUIRED_TMPFS.get(destination) !== options)) {
    reject('HostConfig.Tmpfs must contain only /run, /run/lock, and /sys/fs/cgroup');
  }

  const mounts = requireProperty(inspection, 'Mounts', 'inspect');
  // Docker can leave Mounts empty until start; HostConfig.Tmpfs above is the
  // authoritative create-time declaration. Validate any reported entries too.
  if (!Array.isArray(mounts)) {
    reject('inspect Mounts must be an array');
  }
  const seen = new Set();
  for (const mount of mounts) {
    if (!record(mount) || mount.Type !== 'tmpfs' || mount.Source !== 'tmpfs' ||
        !REQUIRED_TMPFS.has(mount.Destination) || mount.RW !== true || seen.has(mount.Destination)) {
      reject('inspect Mounts contains a non-private or unexpected mount');
    }
    seen.add(mount.Destination);
  }
}

function requireProperty(object, property, label) {
  if (!Object.hasOwn(object, property)) reject(`${label}.${property} is missing`);
  return object[property];
}

function validateInspection(containerId, inspection) {
  if (!DOCKER_ID.test(containerId)) reject('docker create did not return a full container ID');
  if (!record(inspection)) reject('docker inspect returned a malformed value');
  if (inspection.Id !== containerId) reject('docker inspect returned a different container ID');

  const config = inspection.Config;
  const host = inspection.HostConfig;
  if (!record(config) || !record(host)) reject('docker inspect omitted Config or HostConfig');

  if (config.Tty !== false || config.OpenStdin !== false || config.AttachStdin !== false) {
    reject('TTY and interactive stdin must be disabled');
  }
  if (host.Privileged !== false) reject('Privileged must be false');
  if (host.CgroupnsMode !== 'private') reject('CgroupnsMode must be private');

  const addedCapabilities = requireProperty(host, 'CapAdd', 'HostConfig');
  if (!Array.isArray(addedCapabilities) || addedCapabilities.length !== 1) {
    reject('CapAdd must contain only SYS_ADMIN');
  }
  const capability = String(addedCapabilities[0]).toUpperCase().replace(/^CAP_/, '');
  if (capability !== 'SYS_ADMIN') reject('CapAdd must contain only SYS_ADMIN');

  for (const property of ['Devices', 'DeviceRequests', 'DeviceCgroupRules', 'Binds', 'VolumesFrom', 'SecurityOpt']) {
    const value = requireProperty(host, property, 'HostConfig');
    emptyOptionalArray(value, `HostConfig.${property}`);
  }
  // Docker omits Mounts when no structured --mount option was supplied.
  if (Object.hasOwn(host, 'Mounts')) emptyOptionalArray(host.Mounts, 'HostConfig.Mounts');
  emptyOptionalRecord(requireProperty(host, 'PortBindings', 'HostConfig'), 'HostConfig.PortBindings');
  if (host.NetworkMode !== 'bridge') reject('NetworkMode must be bridge');
  for (const [property, allowed] of [
    ['PidMode', ['']],
    ['IpcMode', ['', 'private']],
    ['UTSMode', ['']],
  ]) {
    if (!allowed.includes(requireProperty(host, property, 'HostConfig'))) {
      reject(`HostConfig.${property} must use an isolated default namespace`);
    }
  }

  validatePrivateTmpfs(host, inspection);
  const declaredVolumes = requireProperty(config, 'Volumes', 'Config');
  emptyOptionalRecord(declaredVolumes, 'Config.Volumes');

  const network = inspection.NetworkSettings;
  if (!record(network) || !Object.hasOwn(network, 'Ports')) reject('docker inspect omitted NetworkSettings.Ports');
  noPublishedPorts(network.Ports);
}

async function removeOwnedContainer(removeContainer, containerId, cause) {
  try {
    await removeContainer(containerId);
  } catch (cleanupError) {
    throw new AggregateError([cause, cleanupError], `safety refusal and cleanup failed for container ${containerId}`);
  }
}

/** Create, inspect, guard, then start only the exact Docker ID returned by create. */
export async function createInspectGuardStart({
  createContainer,
  inspectContainer,
  startContainer,
  removeContainer,
}) {
  for (const [name, fn] of Object.entries({ createContainer, inspectContainer, startContainer, removeContainer })) {
    if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  }

  const containerId = await createContainer();
  if (typeof containerId !== 'string' || !DOCKER_ID.test(containerId)) {
    throw new SystemdContainerSafetyError('docker create did not return a full container ID');
  }

  try {
    const inspection = await inspectContainer(containerId);
    validateInspection(containerId, inspection);
  } catch (error) {
    await removeOwnedContainer(removeContainer, containerId, error);
    throw error;
  }

  try {
    await startContainer(containerId);
  } catch (error) {
    await removeOwnedContainer(removeContainer, containerId, error);
    throw error;
  }

  return containerId;
}

/** Fixed, nonprivileged Docker create policy for the offline Linux systemd audit. */
export const SYSTEMD_AUDIT_CONTAINER = 'golden-live-linux-1029-manager-safe';

export async function launchSystemdAuditContainer({ docker, imageId }) {
  if (typeof docker !== 'function') throw new TypeError('docker must be a function');
  if (typeof imageId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(imageId)) {
    reject('a full immutable image ID from the reviewed audit Dockerfile build is required');
  }

  return createInspectGuardStart({
    createContainer: async () => String(await docker([
        'create',
        '--name', SYSTEMD_AUDIT_CONTAINER,
        '--cgroupns=private',
        '--cap-add=SYS_ADMIN',
        '--network=bridge',
        '--tmpfs', '/run:rw,nosuid,nodev,mode=755',
        '--tmpfs', '/run/lock:rw,nosuid,nodev,noexec,mode=755',
        '--tmpfs', '/sys/fs/cgroup:rw,nosuid,nodev,noexec,mode=755',
        imageId,
      ])).trim(),
    inspectContainer: async containerId => {
      const output = await docker(['inspect', containerId]);
      let inspected;
      try { inspected = JSON.parse(output); }
      catch { reject('docker inspect did not return JSON'); }
      if (!Array.isArray(inspected) || inspected.length !== 1) reject('docker inspect must return exactly one container');
      if (inspected[0]?.Image !== imageId) reject('created container image differs from the reviewed image ID');
      return inspected[0];
    },
    startContainer: containerId => docker(['start', containerId]),
    removeContainer: containerId => docker(['rm', '--force', containerId]),
  });
}

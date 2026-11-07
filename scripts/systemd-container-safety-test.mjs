import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createInspectGuardStart, launchSystemdAuditContainer, SystemdContainerSafetyError } from './lib/systemd-container-safety.mjs';

const ID = 'a'.repeat(64);
const IMAGE_ID = 'sha256:' + 'c'.repeat(64);

function safeInspection(id = ID) {
  return {
    Id: id,
    Image: IMAGE_ID,
    Config: {
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      Volumes: null,
    },
    HostConfig: {
      Privileged: false,
      CgroupnsMode: 'private',
      CapAdd: ['SYS_ADMIN'],
      Devices: null,
      DeviceRequests: null,
      DeviceCgroupRules: null,
      Binds: null,
      VolumesFrom: null,
      SecurityOpt: null,
      Tmpfs: {
        '/run': 'rw,nosuid,nodev,mode=755',
        '/run/lock': 'rw,nosuid,nodev,noexec,mode=755',
        '/sys/fs/cgroup': 'rw,nosuid,nodev,noexec,mode=755',
      },
      PortBindings: null,
      NetworkMode: 'bridge',
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
    },
    Mounts: [],
    NetworkSettings: { Ports: null },
  };
}

function dockerDouble(inspection = safeInspection()) {
  const calls = [];
  return {
    calls,
    createContainer: async () => { calls.push('create'); return ID; },
    inspectContainer: async id => { calls.push(`inspect:${id}`); return inspection; },
    startContainer: async id => { calls.push(`start:${id}`); },
    removeContainer: async id => { calls.push(`remove:${id}`); },
  };
}

async function assertRejectedBeforeStart(inspection, expectedMessage) {
  const docker = dockerDouble(inspection);
  await assert.rejects(
    createInspectGuardStart(docker),
    error => error instanceof SystemdContainerSafetyError && error.message.includes(expectedMessage),
  );
  assert.deepEqual(docker.calls, ['create', `inspect:${ID}`, `remove:${ID}`]);
  assert.equal(docker.calls.some(call => call.startsWith('start:')), false);
}

test('safe configuration is inspected by its created ID before that same ID starts', async () => {
  const docker = dockerDouble();
  assert.equal(await createInspectGuardStart(docker), ID);
  assert.deepEqual(docker.calls, ['create', `inspect:${ID}`, `start:${ID}`]);
});

test('the audit launcher creates, inspects, then starts using only the fixed nonprivileged flags', async () => {
  const calls = [];
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'create') return ID;
    if (args[0] === 'inspect') return JSON.stringify([safeInspection(args[1])]);
    if (args[0] === 'start') return args[1];
    throw new Error(`unexpected Docker command: ${args[0]}`);
  };

  assert.equal(await launchSystemdAuditContainer({ docker, imageId: IMAGE_ID }), ID);
  assert.deepEqual(calls.map(args => args[0]), ['create', 'inspect', 'start']);
  assert.deepEqual(calls[1], ['inspect', ID]);
  assert.deepEqual(calls[2], ['start', ID]);
  assert.ok(calls[0].includes('--cgroupns=private'));
  assert.ok(calls[0].includes('--cap-add=SYS_ADMIN'));
  assert.ok(calls[0].includes('--network=bridge'));
  for (const unsafe of ['run', '--privileged', '--device', '--mount', '-v', '-p']) {
    assert.equal(calls[0].includes(unsafe), false, `create arguments include ${unsafe}`);
  }
});

test('audit launcher removes an unsafe created ID without starting it', async () => {
  const calls = [];
  const inspection = safeInspection();
  inspection.HostConfig.Privileged = true;
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'create') return ID;
    if (args[0] === 'inspect') return JSON.stringify([inspection]);
    if (args[0] === 'rm') return ID;
    throw new Error(`unexpected Docker command: ${args[0]}`);
  };

  await assert.rejects(launchSystemdAuditContainer({ docker, imageId: IMAGE_ID }), /Privileged must be false/);
  assert.deepEqual(calls.map(args => args[0]), ['create', 'inspect', 'rm']);
  assert.deepEqual(calls.at(-1), ['rm', '--force', ID]);
});

test('privileged configuration is removed without starting', async () => {
  const inspection = safeInspection();
  inspection.HostConfig.Privileged = true;
  await assertRejectedBeforeStart(inspection, 'Privileged must be false');
});

test('a /dev/tty1 device mapping is rejected without starting', async () => {
  const inspection = safeInspection();
  inspection.HostConfig.Devices = [{ PathOnHost: '/dev/tty1', PathInContainer: '/dev/tty1', CgroupPermissions: 'rwm' }];
  await assertRejectedBeforeStart(inspection, 'HostConfig.Devices must be null or empty');
});

test('device aliases targeting /dev/console are rejected without starting', async () => {
  const inspection = safeInspection();
  inspection.HostConfig.Devices = [{ PathOnHost: '/dev/tty1', PathInContainer: '/dev/console', CgroupPermissions: 'rw' }];
  await assertRejectedBeforeStart(inspection, 'HostConfig.Devices must be null or empty');
});

test('a TTY bind mount is rejected without starting', async () => {
  const inspection = safeInspection();
  inspection.HostConfig.Binds = ['/dev/tty1:/dev/tty1'];
  inspection.Mounts = [{ Type: 'bind', Source: '/dev/tty1', Destination: '/dev/tty1' }];
  await assertRejectedBeforeStart(inspection, 'HostConfig.Binds must be null or empty');
});

test('a writable cgroup bind is rejected without starting', async () => {
  const inspection = safeInspection();
  inspection.HostConfig.Binds = ['/sys/fs/cgroup:/sys/fs/cgroup:rw'];
  inspection.Mounts = [{ Type: 'bind', Source: '/sys/fs/cgroup', Destination: '/sys/fs/cgroup', RW: true }];
  await assertRejectedBeforeStart(inspection, 'HostConfig.Binds must be null or empty');
});

test('an unexpected mount destination is rejected without starting', async () => {
  const inspection = safeInspection();
  inspection.HostConfig.Tmpfs['/dev/console'] = 'rw';
  inspection.Mounts.push({ Type: 'tmpfs', Source: 'tmpfs', Destination: '/dev/console', RW: true });
  await assertRejectedBeforeStart(inspection, 'HostConfig.Tmpfs must contain only');
});

test('TTY mode and host cgroup namespace are rejected without starting', async t => {
  await t.test('TTY mode', async () => {
    const inspection = safeInspection();
    inspection.Config.Tty = true;
    await assertRejectedBeforeStart(inspection, 'TTY and interactive stdin must be disabled');
  });
  await t.test('host cgroup namespace', async () => {
    const inspection = safeInspection();
    inspection.HostConfig.CgroupnsMode = 'host';
    await assertRejectedBeforeStart(inspection, 'CgroupnsMode must be private');
  });
});

test('malformed or unknown inspect output is removed without starting', async t => {
  await t.test('null inspect value', async () => assertRejectedBeforeStart(null, 'malformed value'));
  await t.test('missing HostConfig', async () => {
    const inspection = safeInspection();
    delete inspection.HostConfig;
    await assertRejectedBeforeStart(inspection, 'omitted Config or HostConfig');
  });
  await t.test('unknown capability list', async () => {
    const inspection = safeInspection();
    delete inspection.HostConfig.CapAdd;
    await assertRejectedBeforeStart(inspection, 'HostConfig.CapAdd is missing');
  });
  await t.test('inspect ID mismatch removes only the created ID', async () => {
    const inspection = safeInspection('b'.repeat(64));
    const docker = dockerDouble(inspection);
    await assert.rejects(createInspectGuardStart(docker), /different container ID/);
    assert.deepEqual(docker.calls, ['create', `inspect:${ID}`, `remove:${ID}`]);
  });
});

test('the audit launcher removes malformed inspect JSON without starting', async () => {
  const calls = [];
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'create') return ID;
    if (args[0] === 'inspect') return '{not-json';
    if (args[0] === 'rm') return ID;
    throw new Error(`unexpected Docker command: ${args[0]}`);
  };

  await assert.rejects(launchSystemdAuditContainer({ docker, imageId: IMAGE_ID }), /did not return JSON/);
  assert.deepEqual(calls.map(args => args[0]), ['create', 'inspect', 'rm']);
  assert.deepEqual(calls.at(-1), ['rm', '--force', ID]);
});

test('audit launcher removes only its created ID if start acknowledgement fails', async () => {
  const calls = [];
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'create') return ID;
    if (args[0] === 'inspect') return JSON.stringify([safeInspection()]);
    if (args[0] === 'start') throw new Error('start acknowledgement lost');
    if (args[0] === 'rm') return ID;
    throw new Error('unexpected Docker command');
  };
  await assert.rejects(launchSystemdAuditContainer({ docker, imageId: IMAGE_ID }), /start acknowledgement lost/);
  assert.deepEqual(calls.map(args => args[0]), ['create', 'inspect', 'start', 'rm']);
  assert.deepEqual(calls.at(-1), ['rm', '--force', ID]);
});

test('reported mount entries cannot hide a device bind absent from HostConfig.Binds', async () => {
  const inspection = safeInspection();
  inspection.Mounts = [{ Type: 'bind', Source: '/dev/tty1', Destination: '/dev/console', RW: true }];
  await assertRejectedBeforeStart(inspection, 'non-private or unexpected mount');
});

test('shared or malformed namespace modes are refused before start', async t => {
  for (const [property, value] of [
    ['PidMode', 'container:another-container'],
    ['IpcMode', 'container:another-container'],
    ['UTSMode', null],
  ]) {
    await t.test(property, async () => {
      const inspection = safeInspection();
      inspection.HostConfig[property] = value;
      await assertRejectedBeforeStart(inspection, `HostConfig.${property} must use an isolated default namespace`);
    });
  }
});

test('start failure removes the created container', async () => {
  const docker = dockerDouble();
  docker.startContainer = async id => { docker.calls.push(`start:${id}`); throw new Error('start failed'); };
  await assert.rejects(createInspectGuardStart(docker), /start failed/);
  assert.deepEqual(docker.calls, ['create', `inspect:${ID}`, `start:${ID}`, `remove:${ID}`]);
});

test('malformed ID from create is never inspected, started, or removed by guessed name', async () => {
  const docker = dockerDouble();
  docker.createContainer = async () => { docker.calls.push('create'); return 'unsafe-name'; };
  await assert.rejects(createInspectGuardStart(docker), /full container ID/);
  assert.deepEqual(docker.calls, ['create']);
});


test('the audit image masks console units before systemd can start', () => {
  const dockerfile = readFileSync(new URL('./fixtures/systemd-audit.Dockerfile', import.meta.url), 'utf8');
  const mask = dockerfile.match(/systemctl --root=\/ mask ([^\n]+)/)?.[1] ?? '';
  for (const unit of ['getty.target', 'console-getty.service', 'getty@tty1.service', 'serial-getty@.service']) {
    assert.ok(mask.split(/\s+/).includes(unit), `missing console mask: ${unit}`);
  }
});


test('the launcher refuses a mutable or missing image reference before creating anything', async () => {
  for (const imageId of [undefined, 'audit:latest', 'sha256:short']) {
    let calls = 0;
    await assert.rejects(launchSystemdAuditContainer({ docker: async () => { calls++; }, imageId }), /immutable image ID/);
    assert.equal(calls, 0);
  }
});

test('an image mismatch removes only the created ID without starting', async () => {
  const calls = [];
  const inspection = safeInspection();
  inspection.Image = 'sha256:' + 'd'.repeat(64);
  const docker = async args => {
    calls.push(args);
    if (args[0] === 'create') { assert.equal(args.at(-1), IMAGE_ID); return ID; }
    if (args[0] === 'inspect') return JSON.stringify([inspection]);
    if (args[0] === 'rm') return ID;
    throw new Error('unexpected Docker command');
  };
  await assert.rejects(launchSystemdAuditContainer({ docker, imageId: IMAGE_ID }), /image differs/);
  assert.deepEqual(calls.map(args => args[0]), ['create', 'inspect', 'rm']);
  assert.deepEqual(calls.at(-1), ['rm', '--force', ID]);
});


test('an explicitly empty optional structured-mount declaration is accepted', async () => {
  const inspection = safeInspection();
  inspection.HostConfig.Mounts = [];
  const docker = dockerDouble(inspection);
  assert.equal(await createInspectGuardStart(docker), ID);
  assert.deepEqual(docker.calls, ['create', `inspect:${ID}`, `start:${ID}`]);
});

test('a structured device mount is refused even when reported Mounts is empty', async () => {
  const inspection = safeInspection();
  inspection.HostConfig.Mounts = [{ Type: 'bind', Source: '/dev/tty1', Target: '/dev/console' }];
  await assertRejectedBeforeStart(inspection, 'HostConfig.Mounts must be null or empty');
});

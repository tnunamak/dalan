// Source archives of releases from before Dalan was public. They are not in the repository: maintainers keep them
// elsewhere and point DALAN_PREPUBLIC_FIXTURES at a directory that holds them at these relative paths. Tests that need
// them skip with PREPUBLIC_SKIP_REASON when the variable is unset or a file is missing, and verify each digest otherwise.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PREPUBLIC_SKIP_REASON = 'pre-public release fixtures not present';

const DIGESTS = {
  'src/test-support/worker-history/v0.2.0.tgz': '81582234af812c770a5777a601926118b82c1cf66b9e79011fbd6563f2beab63',
  'src/test-support/worker-history/a727609.tgz': '0cb7efeddd1204072f19844269b72d18f8b60f8a7cfd4f91e0993707b1e341c4',
  'src/test-support/worker-history/27a0a2d.tgz': '6085a946336f5820ab84d28b517e42718c5a43e5b7078de772ce1478345937b6',
  'test-fixtures/dalan-v0.3.0-release.tgz': 'c11880e2c02f43a14a4d22a428bd69545fd71e3a78fef16327444128b410d011',
};

function known(name) {
  if (!Object.hasOwn(DIGESTS, name)) throw new Error(`unknown pre-public fixture ${name}`);
  return name;
}

// The absolute path of a pre-public fixture, or null when it is not present.
export function prepublicFixturePath(name) {
  const dir = process.env.DALAN_PREPUBLIC_FIXTURES;
  const file = dir ? path.resolve(dir, known(name)) : null;
  return file && fs.existsSync(file) ? file : null;
}

// The skip reason for a test that needs these fixtures, or false when all of them are present.
export function prepublicSkip(...names) {
  return names.every(name => prepublicFixturePath(name)) ? false : PREPUBLIC_SKIP_REASON;
}

// The fixture bytes after a digest check. Throws when the fixture is absent or changed; check prepublicSkip first.
export function readPrepublicFixture(name) {
  const file = prepublicFixturePath(name);
  if (!file) throw new Error(`${PREPUBLIC_SKIP_REASON}: ${name}`);
  const bytes = fs.readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== DIGESTS[name]) throw new Error(`pre-public fixture ${name} has sha256 ${digest}, expected ${DIGESTS[name]}`);
  return bytes;
}

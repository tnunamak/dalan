import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

test('package metadata permits publication and identifies its repository',()=>{
  const root=path.resolve(new URL('..',import.meta.url).pathname);
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
  assert.notEqual(pkg.private,true);
  assert.equal(pkg.repository.url,'git+https://github.com/tnunamak/dalan.git');
});

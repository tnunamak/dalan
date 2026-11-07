import { DatabaseSync } from 'node:sqlite';
import { Store } from '../store.mjs';

// A database created before the fix-loop source was renamed lists the earlier spelling in the CHECK constraint on
// assignments.source. Open a store whose stored schema reads that way, so tests can exercise the compatibility path.
export function openWithLegacyFixSchema(file, options = {}) {
  new Store(file, options).db.close();
  const raw = new DatabaseSync(file, { defensive: false });
  raw.exec("PRAGMA writable_schema=ON; UPDATE sqlite_master SET sql=replace(sql,'''fix-loop''','''dot-fix''') WHERE type='table' AND name='assignments'; PRAGMA writable_schema=OFF;");
  raw.close();
  return new Store(file, options);
}

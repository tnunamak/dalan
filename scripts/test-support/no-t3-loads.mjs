import fs from 'node:fs';

const isOptionalT3Module = url => {
  if (!url.startsWith('file:')) return false;
  const pathname = new URL(url).pathname;
  return /\/src\/t3(?:-[^/]+)?\.mjs$/.test(pathname) || /\/src\/destinations\/t3\.mjs$/.test(pathname);
};

export async function load(url, context, nextLoad) {
  const guardDisabled = process.env.DALAN_TEST_T3_GUARD_DISABLED && fs.existsSync(process.env.DALAN_TEST_T3_GUARD_DISABLED);
  if (!guardDisabled && isOptionalT3Module(url)) {
    const record = process.env.DALAN_TEST_T3_LOADS;
    if (record) fs.appendFileSync(record, `${url}\n`);
    throw new Error(`default-start loader guard blocked optional T3 module: ${url}`);
  }
  return nextLoad(url, context);
}

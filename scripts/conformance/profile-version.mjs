import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';

export const FIXTURE_PROFILE_VERSION = 0;
export const NATIVE_CONTRACT_VERSION = 6;
export const ADAPTER_CONTRACT_VERSION = 1;
export const PROFILE_SOURCE_SHA256 = 'e912cd9caea2283c98900b2577e3bbf3bb547ab760cd2af90ade45cfd165c3d0';
export const EXPECTED_TRACE_IDS = Array.from({ length: 42 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
export const EXPECTED_NATIVE_MUST_CASE_IDS = ['A1-revoked-holder-no-effect', 'A2-destination-approval-required', 'A3-replacement-cannot-replay-grant'];
export const EXPECTED_TRACE_SHA256 = {
  T01: '1cd2f9b403eef761a63811aba029e9e819da2a711abc2d5c2330c27ffd5afe51',
  T02: '6d94dd76fe2dd7a3b85a40490e40681cf391710acd59a8ec8693ddee4826f2c0',
  T03: '91c25704b6f4626c6d9da721bbecb763e89dba24d3137c041ec52f8835bcab65',
  T04: '997cd1130ada9b925640f8d58e9b93115ae35b1a83b6c73a3a5e1d4aeb8f000a',
  T05: 'ffa35d27a1218bc2d421f38572b697cec1f8580247ec4359dc7c9c4b6305e0ff',
  T06: '0211fa35fc3d211218546ccef405fb56b6cdba3c73937ccc698f089939f28cb7',
  T07: '6490f65f0313cd654b9fbca0326107882003f9a022dffd8d5c610c580529703e',
  T08: '2d99c720bfdb8d75f6b2820488d05dbd51abeb023b6fc9bc3899010d40300864',
  T09: '62d8a62b9f3c6d6bc9cb81ca6e7c44297aec17219df11ed67abeaee7bc9e159b',
  T10: '06733131b1d1ddbd7ab483c8739f39d6d2a304dd460b3948e0da7a16181e48bd',
  T11: 'f7fa05304589f171d75ff5936ea896904a275fc3c0f9c29465d56c90c340d25a',
  T12: 'da3ed5971023a99c3fe84caedd5a6925a2eb9bd5a248561f5803e927f583c846',
  T13: '5ab7dd35ce3079dbef7496f86357d7380c82e0ecf358b43b84951d717bf876af',
  T14: '16c66784206c7c0d923eef92cfe3d59829330a95ea62defa0c4f93bcb47a6ef4',
  T15: 'c1de10f73c619376a9ea4b2b0250be92bf2de936cd58c674c25a1fbec67fdf4d',
  T16: '1dde2e8c7ad09d790ad4570a725ed11fbb51d08dff4bed62610c62ca81c88c28',
  T17: '1ab336bd12df1e3de09388375a290ac64374134a8ecb03094183d1a15cc04dbe',
  T18: '79553e96b293da7938ed94df26ea8ed86d74a82376e296a1ad9ed713ca8082fc',
  T19: '101c161f59dc53f6dec02d26689aa31afa8eea5b7122f6e01d1bb055788e8830',
  T20: 'e920b0aa579dc0ad2e62b7b37d0c773786efe96ab8ab19d32cc2c8da86c9f816',
  T21: '69989de02e36859c90f5ac0910b08be379ec3bbde194059b46b8aecace45ae30',
  T22: 'c0a884cfcc377358d8f266735e233300dd51e530c79db0a201c7e76e158c2bdb',
  T23: 'e6f1301635f6657b1d23e480e7da1ef4be785406a29f358d3461d33531ffca02',
  T24: '3f9e52c14f2af7f0373a6d2758e2282afe90927b23d461f99eb2dbbbcf9a0032',
  T25: '16f7101ca4cf0d266bbeb9d188c3144789484bf71d5f4f65fdef002b6178e94a',
  T26: '659d91bcce0b1b386976b6cbd69cc16375c5e12727ee502c56b919c477f51202',
  T27: 'c7af59da8721a10ef1d1630e86732d2f2c14cb60863fd999777ff51a593c0856',
  T28: '5a55b57957529f07aaee1134b709a4878907d5a3af2c098ca37e02a903430371',
  T29: '1567b706545d81f33f1726ce9ce25b7c7ea945286c7d2a4675da55acbbf9b921',
  T30: '345cfc04ec351e56b33362b6a989f38a3a88d5ece1bbc8d0aede5d92a8a3de6d',
  T31: 'afb1dc12fe14812c3d5fd66db592d765d2ea2f77a63aa8b29a16eebd20bc81c4',
  T32: '1542a88d8a8daf83f1061338b8a50a7d84e72825f8ae2b2bbe29c36bf4d10e13',
  T33: 'c4b67638a4a83d221974d439de6b86c4b48c1e6900ac695f225e5af88fced23a',
  T34: 'a86cf17ab58495a8574f443e7166fcddaac997bfa40f11b5924a16456c15706c',
  T35: 'b2f9ff3c4134e4018559e99099c6c9879520c691f408737f79e901ad3c7b78ba',
  T36: 'ac82a6d5d32d79651b80bd141264b7c311ee70501fadfebd4bad0fb49776ff6e',
  T37: '8d6f10429814364d979b2ed7401922fda9249142c5fca2b23801530f68e05cec',
  T38: '39654545fd93b5971d79ed5c3f63c3c36f94571d5f81f53e88137f427cca772e',
  T39: '5b1b6df12b74031529e06552f9653949fae69964f85a349f2100c05ad3e75f7e',
  T40: '8ce84fdc941be91903e63e49afbf19bf58f0052da48b672bf5851778b8bfc22d',
  T41: '9e3b10b3075c055625700cd648b801085db32b818f4d79f7dded7f34d94cc28e',
  T42: 'ef70446baf673eab4980bef4bb5d3c8307665362bb9e9990caca42a55246f370',
};
export const INTENTIONAL_INVALID_COMMANDS = ['T42:4'];
export const EXPECTED_SCHEMA_SHA256 = {
  command: 'bce9535adf7f3d02ad1b53873d74323c4db77f4a32f0b17e53eeaac9c79feb6a',
  event: '7a6b9019d72365a7c3d68d28c6d43179ff6e5a3a17f0c693bc584850c6687e44',
  reply: '64479251e4116543ec46143f1673e0ee8b8354d20cc2586ee5a1af35b6757733',
};

const digest = value => createHash('sha256').update(value).digest('hex');
const expectedVersion = schema => {
  if (schema.oneOf) return schema.oneOf.length > 0 && schema.oneOf.every(expectedVersion);
  if (schema.properties?.v) return schema.properties.v.const === FIXTURE_PROFILE_VERSION;
  return true;
};

export function validateProfileCorpus({ manifest, schemaText, traces }) {
  const errors = [];
  if (manifest.profileVersion !== FIXTURE_PROFILE_VERSION) errors.push(`unsupported fixture profile version: ${manifest.profileVersion}`);
  if (manifest.doc !== 'conformance-input.md' || manifest.docPath !== 'conformance-input.md' || manifest.docSha256 !== PROFILE_SOURCE_SHA256) errors.push('fixture source identity or hash does not match the implemented profile');
  if (manifest.traces !== EXPECTED_TRACE_IDS.length || manifest.traces === 0) errors.push(`manifest trace count must be ${EXPECTED_TRACE_IDS.length}`);
  if (manifest.nativeMustCases !== EXPECTED_NATIVE_MUST_CASE_IDS.length || JSON.stringify(manifest.nativeMustCaseIds) !== JSON.stringify(EXPECTED_NATIVE_MUST_CASE_IDS)) errors.push(`native MUST case count and IDs must match the pinned set of ${EXPECTED_NATIVE_MUST_CASE_IDS.length}`);
  const ids = traces.map(trace => trace.id);
  if (JSON.stringify(ids) !== JSON.stringify(EXPECTED_TRACE_IDS) || JSON.stringify(manifest.traceIds) !== JSON.stringify(EXPECTED_TRACE_IDS)) errors.push('fixture IDs do not match the pinned profile corpus');
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  for (const trace of traces) {
    const traceDigest = digest(JSON.stringify(canonical(trace)));
    if (traceDigest !== EXPECTED_TRACE_SHA256[trace.id] || manifest.traceSha256?.[trace.id] !== traceDigest) errors.push(`${trace.id} trace content does not match the implemented profile`);
    if (!Array.isArray(trace.steps) || trace.steps.length === 0) errors.push(`${trace.id} has no steps`);
    for (const [index, step] of (trace.steps ?? []).entries()) {
      if (step.control) {
        const c = step.control;
        const valid = c.op === 'restart' ? Object.keys(c).length === 1 && step.expect?.recovered === true : c.op === 'advance' && Object.keys(c).sort().join(',') === 'op,to' && Number.isFinite(c.to) && step.expect?.now === c.to;
        if (!valid) errors.push(`${trace.id} step ${index} has an invalid control`);
      } else if (!step.input || !step.expect) errors.push(`${trace.id} step ${index} is incomplete`);
    }
  }
  if (JSON.stringify(manifest.intentionalInvalidCommands) !== JSON.stringify(INTENTIONAL_INVALID_COMMANDS)) errors.push('intentional invalid fixture command list changed');

  const schemas = {};
  for (const name of ['command', 'event', 'reply']) {
    const text = schemaText[name];
    if (typeof text !== 'string') { errors.push(`missing ${name} schema`); continue; }
    const hash = digest(text);
    if (manifest.schemaSha256?.[name] !== hash || EXPECTED_SCHEMA_SHA256[name] !== hash) errors.push(`${name} schema hash does not match the implemented profile`);
    try { schemas[name] = JSON.parse(text); }
    catch { errors.push(`${name} schema is not valid JSON`); }
  }
  if (schemas.command && !expectedVersion(schemas.command)) errors.push('command schema does not pin profile version 0');
  if (schemas.event && !expectedVersion(schemas.event)) errors.push('event schema does not pin profile version 0');

  if (errors.length || !schemas.command || !schemas.event || !schemas.reply) return errors;
  try {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const validateCommand = ajv.compile(schemas.command);
    const validateEvent = ajv.compile(schemas.event);
    const validateReply = ajv.compile(schemas.reply);
    for (const trace of traces) {
      if (!Array.isArray(trace.steps) || trace.steps.length === 0) { errors.push(`${trace.id} has no steps`); continue; }
      for (const [index, step] of trace.steps.entries()) {
        if (step.control) continue;
        if (!validateCommand(step.input?.command) && !(INTENTIONAL_INVALID_COMMANDS.includes(`${trace.id}:${index}`) && step.expect?.reply?.code === 'INVALID')) errors.push(`${trace.id} step ${index} command does not match profile schema`);
        if (!validateReply(step.expect?.reply)) errors.push(`${trace.id} step ${index} reply does not match profile schema`);
        for (const event of step.expect?.events ?? []) if (!validateEvent(event)) errors.push(`${trace.id} step ${index} event does not match profile schema`);
      }
    }
  } catch (error) { errors.push(`profile schemas cannot be compiled: ${error.message}`); }
  return errors;
}

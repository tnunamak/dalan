// Frozen clock and runner stay unchanged. Only trusted inert dependencies are
// substituted; all command authorization, transactions and replies are native.
import os from 'node:os';
import {createInertProtocolFixtures} from '../../src/test-support/protocol-service-fixtures.mjs';
import {main} from '../../src/server.mjs';
const fixtures=createInertProtocolFixtures(os.homedir());
await main({loopbackOnly:true,protocolServiceAdapters:process.env.DOT_BRIDGE_CATALOG_PROFILE==='protocol-v0'?{transport:fixtures.transport,resolveStopEvidence:fixtures.resolveStopEvidence}:undefined});

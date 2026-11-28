import assert from 'node:assert/strict';
import test from 'node:test';
import { cliError } from './mcp-stdio.mjs';

test('MCP CLI errors distinguish a signalled process from an empty response', () => {
  assert.deepEqual(cliError({ code: null, signal: 'SIGTERM', stdout: '', stderr: '' }, 'status'),
    { isError: true, message: 'status failed (signal SIGTERM): no output' });
  assert.deepEqual(cliError({ code: 7, signal: null, stdout: '', stderr: '' }, 'status'),
    { isError: true, message: 'status failed (exit 7): no output' });
});

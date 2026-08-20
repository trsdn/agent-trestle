import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { createTrestleMcpServer, TRESTLE_STATE_TOOLS } from '../../src/state/mcp-server.mjs';
import { createTrestleStateStore } from '../../src/state/store.mjs';

const artifactRoot = resolve('test/.artifacts/mcp');

after(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

function createStore() {
  return createTrestleStateStore({
    projectStateRoot: resolve(artifactRoot, 'project'),
    workstreamStateRoot: resolve(artifactRoot, 'workstream'),
    configRoot: resolve(artifactRoot, 'config'),
    schemas: {
      values: { type: 'object', required: ['value'] },
      decisions: { type: 'object', required: ['choice'] },
    },
    idGenerator: () => 'mcp-id',
  });
}

test('advertises exactly the renamed trestle state and decision operations', () => {
  assert.deepEqual(TRESTLE_STATE_TOOLS.map(({ name }) => name), [
    'trestle_state_read',
    'trestle_state_write',
    'trestle_state_append',
    'trestle_state_delete',
    'trestle_state_list',
    'trestle_state_health',
    'trestle_state_lock_status',
    'trestle_state_unlock',
    'trestle_decide',
  ]);
});

test('handles MCP initialize, tools/list, tools/call, and direct JSON-RPC methods', async () => {
  const server = createTrestleMcpServer({ store: createStore() });
  const initialized = await server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05' },
  }));
  assert.equal(initialized.result.serverInfo.name, 'agent-trestle-state');

  const listed = await server.handleLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');
  assert.equal(listed.result.tools.length, 9);

  const written = await server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'trestle_state_write',
      arguments: { namespace: 'values', key: 'one', value: { value: 1 } },
    },
  }));
  assert.equal(written.result.structuredContent.value.value, 1);

  const read = await server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'trestle_state_read',
    params: { namespace: 'values', key: 'one' },
  }));
  assert.deepEqual(read.result, { value: 1 });
});

test('surfaces lock status and explicit stale unlock over MCP', async () => {
  const store = createStore();
  const stateRoot = resolve(artifactRoot, 'workstream', 'namespaces', 'values');
  await rm(artifactRoot, { recursive: true, force: true });
  await store.health();
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    resolve(stateRoot, 'one.json.lock'),
    JSON.stringify({
      token: 'stale-token',
      pid: 424242,
      host: 'remote-host',
      epoch: Date.now() - 60_000,
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
    }),
  );

  const server = createTrestleMcpServer({ store });
  const status = await server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'trestle_state_lock_status',
      arguments: { namespace: 'values', key: 'one' },
    },
  }));
  assert.equal(status.result.structuredContent.lock.status, 'operator-recovery-required');

  const unlocked = await server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'trestle_state_unlock',
      arguments: {
        namespace: 'values',
        key: 'one',
        expectedToken: 'stale-token',
        expectedInode: status.result.structuredContent.lock.ino,
      },
    },
  }));
  assert.equal(unlocked.result.structuredContent.unlocked, true);
});

test('recovers a malformed tokenless lock over MCP using the exact emitted hint arguments', async () => {
  const store = createStore();
  const stateRoot = resolve(artifactRoot, 'workstream', 'namespaces', 'values');
  await rm(artifactRoot, { recursive: true, force: true });
  await store.health();
  await mkdir(stateRoot, { recursive: true });
  // Zero-length file left by a crash between lock creation and the identity write.
  await writeFile(resolve(stateRoot, 'one.json.lock'), '');

  const server = createTrestleMcpServer({ store });
  const status = await server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: { name: 'trestle_state_lock_status', arguments: { namespace: 'values', key: 'one' } },
  }));
  const lockStatus = status.result.structuredContent;
  assert.equal(lockStatus.lock.status, 'operator-recovery-required');
  assert.equal(lockStatus.lock.malformed, true);
  assert.equal(lockStatus.unlock.authorization, 'expected-identity');
  assert.equal(lockStatus.unlock.arguments.expectedToken, undefined);
  assert.equal(lockStatus.unlock.arguments.expectedInode, lockStatus.lock.ino);
  assert.equal(lockStatus.unlock.arguments.expectedDevice, lockStatus.lock.dev);

  const unlocked = await server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'trestle_state_unlock', arguments: lockStatus.unlock.arguments },
  }));
  assert.equal(unlocked.result.structuredContent.unlocked, true);

  // A subsequent write acquires a fresh lock and succeeds.
  const written = await server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 12,
    method: 'tools/call',
    params: { name: 'trestle_state_write', arguments: { namespace: 'values', key: 'one', value: { value: 3 } } },
  }));
  assert.equal(written.result.structuredContent.value.value, 3);
});

test('advertises the token-or-identity unlock contract in the tool input schema', () => {
  const unlock = TRESTLE_STATE_TOOLS.find(({ name }) => name === 'trestle_state_unlock');
  assert.equal(unlock.inputSchema.additionalProperties, false);
  assert.deepEqual(unlock.inputSchema.required, ['namespace', 'key']);
  for (const property of ['expectedToken', 'expectedInode', 'expectedDevice', 'scope', 'namespace', 'key']) {
    assert.ok(unlock.inputSchema.properties[property], `unlock schema documents ${property}`);
  }
  assert.match(unlock.description, /expectedInode AND expectedDevice/);
});

test('speaks newline-delimited JSON-RPC over stdio and keeps errors on the protocol', async () => {
  await rm(artifactRoot, { recursive: true, force: true });
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding('utf8');
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const server = createTrestleMcpServer({ store: createStore(), input, output });
  server.start();

  input.write('not-json\n');
  input.write('{"jsonrpc":"2.0","id":8,"method":"missing"}\n');
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 30));
  server.close();

  const messages = text.trim().split('\n').map(JSON.parse);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].error.message, 'parse error');
  assert.equal(messages[1].error.code, -32601);
});

test('rejects malformed MCP input and never replies to valid notifications', async () => {
  const server = createTrestleMcpServer({ store: createStore() });
  for (const input of [
    'null',
    '[]',
    '{"jsonrpc":"1.0","id":1,"method":"tools/list"}',
    '{"jsonrpc":"2.0","id":2}',
  ]) {
    const result = await server.handleLine(input);
    assert.equal(result.error.message, 'invalid JSON-RPC 2.0 request');
  }

  const malformedCall = await server.handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'trestle_state_write', arguments: null },
  });
  assert.equal(malformedCall.error.data.trestleCode, 'SCHEMA_REQUIRED');

  assert.equal(await server.handleRequest({
    jsonrpc: '2.0',
    method: 'trestle_state_read',
    params: { namespace: 'values', key: 'missing' },
  }), undefined);
});

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const pending = new Map();
let id = 0;
createInterface({ input: output }).on('line', (line) => {
  const response = JSON.parse(line);
  pending.get(response.id)?.(response);
  pending.delete(response.id);
});
function requestHandle(method, params) {
  const requestId = ++id;
  const reply = new Promise((resolve) => pending.set(requestId, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  return { requestId, reply };
}
const request = (method, params) => requestHandle(method, params).reply;
const call = (name, arguments_) => request('tools/call', { name, arguments: arguments_ });
let releaseFirst;
let enteredFirst;
const entered = new Promise((resolve) => { enteredFirst = resolve; });
const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
const visits = [];
const running = startMcp({ input, output, port: 0, deviceAdapter: {
  tap: async (args) => {
    visits.push(`${args.deviceId}:${args.x}`);
    if (args.deviceId === 'A' && args.x === 1) { enteredFirst(); await firstBlocked; }
    if (args.deviceId === 'A' && args.x === 4) throw new Error('input failed');
    return args;
  },
  capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('fallback') })
} });
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'device-lock-races', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const first = call('tap', { deviceId: 'A', x: 1, y: 1 });
  await entered;
  const cancelled = requestHandle('tools/call', { name: 'tap', arguments: { deviceId: 'A', x: 2, y: 1 } });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelled.requestId } }) + '\n');
  assert.equal((await cancelled.reply).error?.code, -32800, 'queued input must remain cancellable');
  const third = call('tap', { deviceId: 'A', x: 3, y: 1 });
  const other = await call('tap', { deviceId: 'B', x: 3, y: 1 });
  assert.equal(other.result.isError, undefined, 'a different device must not be blocked');
  await delay(100);
  assert.deepEqual(visits.filter((value) => value.startsWith('A:')), ['A:1'], 'canceling a waiter must not let a later action bypass active input');
  releaseFirst();
  assert.equal((await first).result.isError, undefined);
  assert.equal((await third).result.isError, undefined);
  assert.deepEqual(visits.filter((value) => value.startsWith('A:')), ['A:1', 'A:3']);
  assert.equal((await call('tap', { deviceId: 'A', x: 4, y: 1 })).result.isError, true);
  assert.equal((await call('tap', { deviceId: 'A', x: 5, y: 1 })).result.isError, undefined, 'input failure must not poison later operations');
  console.log('device lock races: ok');
} finally {
  releaseFirst?.();
  input.end();
  await running;
}

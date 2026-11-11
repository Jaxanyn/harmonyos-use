import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const pending = new Map();
let nextId = 0;
createInterface({ input: output }).on('line', (line) => {
  const reply = JSON.parse(line);
  pending.get(reply.id)?.(reply);
  pending.delete(reply.id);
});
function request(method, params) {
  const id = ++nextId;
  const result = new Promise((resolve) => pending.set(id, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return { id, result };
}
const call = (name, args = {}) => request('tools/call', { name, arguments: args });
let unblockCapture;
let captureEntered;
const entered = new Promise((resolve) => { captureEntered = resolve; });
const gate = new Promise((resolve) => { unblockCapture = resolve; });
const running = startMcp({ input, output, port: 0, frameLeaseMs: 1000, subscriptionLeaseMs: 400, deviceAdapter: {
  listTargets: async () => ['A', 'B'],
  capture: async ({ deviceId }) => {
    if (deviceId === 'B') { captureEntered(); await gate; }
    return { mimeType: 'image/jpeg', data: Buffer.from('frame'), width: 100, height: 200, deviceWidth: 100, deviceHeight: 200 };
  },
  keyEvent: async (args) => args,
} });

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'subscription-test', version: '1' } }).result;
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const a = call('preview_start', { deviceId: 'A', subscriber: true });
  const b = call('preview_start', { deviceId: 'A', subscriber: true });
  const [one, two] = (await Promise.all([a.result, b.result])).map((reply) => reply.result.structuredContent);
  assert.equal(one.sessionId, two.sessionId, 'simultaneous starts must share one settled session');
  assert.notEqual(one.subscriberId, two.subscriberId);
  assert.equal((await call('preview_start', { deviceId: 'B', subscriber: true }).result).result.structuredContent.errorCode, 'PREVIEW_IN_USE');
  assert.equal((await call('preview_stop', { sessionId: one.sessionId, subscriberId: one.subscriberId }).result).result.structuredContent.running, true);
  const frame = (await call('preview_frame', { afterSeq: 0, sessionId: two.sessionId, subscriberId: two.subscriberId }).result).result.structuredContent;
  const rejectedAction = (await call('preview_action', { action: 'home', deviceId: 'A', sessionId: one.sessionId, subscriberId: one.subscriberId, seq: frame.seq, frameId: frame.frame.frameId }).result).result;
  assert.equal(rejectedAction.isError, true, 'a released subscription cannot send a device action');
  const action = (await call('preview_action', { action: 'home', deviceId: 'A', sessionId: two.sessionId, subscriberId: two.subscriberId, seq: frame.seq, frameId: frame.frame.frameId }).result).result;
  assert.notEqual(action.isError, true, 'the remaining panel can use the shared session');
  assert.equal((await call('preview_stop', { sessionId: one.sessionId, subscriberId: one.subscriberId }).result).result.isError, true);
  assert.equal((await call('preview_stop', { sessionId: 'wrong', subscriberId: two.subscriberId }).result).result.isError, true);
  assert.equal((await call('preview_stop', { sessionId: two.sessionId, subscriberId: two.subscriberId }).result).result.structuredContent.running, false);

  const owner = (await call('preview_start', { deviceId: 'A' }).result).result.structuredContent;
  const panel = (await call('preview_start', { deviceId: 'A', subscriber: true }).result).result.structuredContent;
  assert.notEqual(owner.sessionId, one.sessionId);
  assert.equal((await call('preview_stop', { sessionId: one.sessionId, subscriberId: one.subscriberId }).result).result.isError, true, 'an old panel cannot stop a new session');
  assert.equal((await call('preview_start', { deviceId: 'B', subscriber: true }).result).result.structuredContent.errorCode, 'PREVIEW_IN_USE', 'a panel cannot replace a public owner');
  assert.equal((await call('preview_stop', { sessionId: panel.sessionId, subscriberId: panel.subscriberId }).result).result.structuredContent.running, true, 'a public owner survives panel close');
  await call('preview_stop', { sessionId: owner.sessionId }).result;

  const expiring = (await call('preview_start', { deviceId: 'A', subscriber: true }).result).result.structuredContent;
  await delay(600);
  assert.equal((await call('preview_info').result).result.structuredContent.running, false, 'abandoned subscriptions expire and stop their session');
  assert.equal((await call('preview_frame', { sessionId: expiring.sessionId, subscriberId: expiring.subscriberId }).result).result.isError, true);
  const active = (await call('preview_start', { deviceId: 'A', subscriber: true }).result).result.structuredContent;
  for (let i = 0; i < 3; i++) {
    await delay(180);
    assert.notEqual((await call('preview_frame', { sessionId: active.sessionId, subscriberId: active.subscriberId }).result).result.isError, true);
  }
  assert.equal((await call('preview_info').result).result.structuredContent.running, true, 'active frame reads renew the subscription');
  await call('preview_stop', { sessionId: active.sessionId, subscriberId: active.subscriberId }).result;

  const starting = call('preview_start', { deviceId: 'B', subscriber: true });
  await entered;
  const queued = call('preview_start', { deviceId: 'B', subscriber: true });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: queued.id } }) + '\n');
  assert.equal((await queued.result).error?.code, -32800, 'queued starts remain cancellable');
  unblockCapture();
  const last = (await starting.result).result.structuredContent;
  assert.equal((await call('preview_stop', { sessionId: last.sessionId, subscriberId: last.subscriberId }).result).result.structuredContent.running, false);
  console.log('preview subscribers: ok');
} finally {
  unblockCapture();
  input.end();
  await running;
}

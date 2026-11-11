import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
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
function request(method, params) {
  const requestId = ++id;
  const result = new Promise((resolve) => pending.set(requestId, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  return result;
}
const call = (name, arguments_) => request('tools/call', { name, arguments: arguments_ });
let count = 0;
let keyEvents = 0;
let gate;
let releaseGate;
const running = startMcp({ input, output, port: 0, deviceAdapter: {
  listTargets: async () => ['A'],
  capture: async () => {
    if (gate) { gate.entered(); await gate.blocked; }
    return { mimeType: 'image/jpeg', data: Buffer.from(`frame-${++count}`) };
  },
  keyEvent: async () => { keyEvents++; return {}; }
} });
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'subscriber-race-test', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const one = (await call('preview_start', { deviceId: 'A', subscriber: true })).result.structuredContent;
  const two = (await call('preview_start', { deviceId: 'A', subscriber: true })).result.structuredContent;
  const frame = (await call('preview_frame', { sessionId: one.sessionId, subscriberId: one.subscriberId })).result.structuredContent;
  const waiting = call('preview_frame', { sessionId: one.sessionId, subscriberId: one.subscriberId, afterSeq: frame.seq, waitMs: 2000 });
  await call('preview_stop', { sessionId: one.sessionId, subscriberId: one.subscriberId });
  const result = await waiting;
  assert.ok(result.error || result.result.isError, 'a released subscriber must not receive a frame after its outstanding wait');
  const last = (await call('preview_frame', { sessionId: two.sessionId, subscriberId: two.subscriberId })).result.structuredContent;
  assert.ok(last.frame);
  const three = (await call('preview_start', { deviceId: 'A', subscriber: true })).result.structuredContent;
  const action = call('preview_action', { action: 'home', deviceId: 'A', sessionId: two.sessionId, subscriberId: two.subscriberId, seq: last.seq, frameId: last.frame.frameId });
  await call('preview_stop', { sessionId: two.sessionId, subscriberId: two.subscriberId });
  const actionResult = await action;
  assert.ok(actionResult.error || actionResult.result.isError, 'a subscription released before input cannot send an action');
  assert.equal(keyEvents, 0, 'releasing a subscriber while its action waits must prevent device input');
  await call('preview_stop', { sessionId: three.sessionId, subscriberId: three.subscriberId });

  const four = (await call('preview_start', { deviceId: 'A', subscriber: true })).result.structuredContent;
  const five = (await call('preview_start', { deviceId: 'A', subscriber: true })).result.structuredContent;
  const current = (await call('preview_frame', { sessionId: four.sessionId, subscriberId: four.subscriberId })).result.structuredContent;
  let entered;
  const captureEntered = new Promise((resolve) => { entered = resolve; });
  gate = { entered, blocked: new Promise((resolve) => { releaseGate = resolve; }) };
  const forced = call('preview_frame', { forceRefresh: true, deviceId: 'A', sessionId: four.sessionId, subscriberId: four.subscriberId, afterSeq: current.seq, waitMs: 2000 });
  await captureEntered;
  await call('preview_stop', { sessionId: four.sessionId, subscriberId: four.subscriberId });
  releaseGate();
  gate = undefined;
  const forcedResult = await forced;
  assert.ok(forcedResult.error || forcedResult.result.isError, 'a released subscriber must not receive the forced frame');
  await call('preview_stop', { sessionId: five.sessionId, subscriberId: five.subscriberId });
  console.log('preview subscriber races: ok');
} finally {
  releaseGate?.();
  input.end();
  await running;
}

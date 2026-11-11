import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const pending = new Map();
createInterface({ input: output }).on('line', (line) => {
  const reply = JSON.parse(line);
  pending.get(reply.id)?.(reply);
  pending.delete(reply.id);
});
let id = 0;
function request(method, params) {
  const requestId = ++id;
  const result = new Promise((resolve) => pending.set(requestId, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  return { id: requestId, result };
}
const call = (name, args) => request('tools/call', { name, arguments: args });
let captures = 0;
let gate;
let entered;
const captureEntered = () => new Promise((resolve) => { entered = resolve; });
const running = startMcp({ input, output, port: 0, deviceAdapter: {
  listTargets: async () => ['A', 'B'],
  capture: async ({ deviceId }) => {
    captures += 1;
    if (gate) { entered(); await gate; }
    return { mimeType: 'image/jpeg', data: Buffer.from('unchanged'), frameId: `${deviceId}-${captures}` };
  }
} });
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'recovery-test', version: '1' } }).result;
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const sessionId = (await call('preview_start', { deviceId: 'A' }).result).result.structuredContent.sessionId;
  const first = (await call('preview_frame', { afterSeq: 0 }).result).result.structuredContent;
  const bound = { forceRefresh: true, afterSeq: 0, waitMs: 1000, deviceId: 'A', sessionId };
  for (const args of [{ ...bound, sessionId: undefined }, { ...bound, deviceId: undefined }, { ...bound, sessionId: 'old' }, { ...bound, deviceId: 'B' }]) {
    const rejected = await call('preview_frame', args).result;
    assert.ok(rejected.error || rejected.result.isError, 'refresh requires the current device and session');
  }
  const refreshed = (await call('preview_frame', bound).result).result.structuredContent;
  assert.ok(refreshed.seq > first.seq, 'a forced refresh must not return a cached frame even when afterSeq is zero');
  assert.ok(refreshed.frame);

  let release;
  gate = new Promise((resolve) => { release = resolve; });
  const waitingForCapture = captureEntered();
  await waitingForCapture;
  const beforeRefresh = captures;
  const refresh = call('preview_frame', { ...bound, afterSeq: refreshed.seq });
  await delay(30);
  release();
  gate = undefined;
  const next = (await refresh.result).result.structuredContent;
  assert.ok(next.frame && next.seq > refreshed.seq);
  assert.ok(captures > beforeRefresh, 'a capture already in flight cannot satisfy refresh');

  let releaseTimeout;
  gate = new Promise((resolve) => { releaseTimeout = resolve; });
  const timeoutReady = captureEntered();
  const timed = call('preview_frame', { ...bound, afterSeq: next.seq, waitMs: 30 });
  await timeoutReady;
  const timeout = (await timed.result).result.structuredContent;
  assert.equal(timeout.frame, null, 'timeout must not return an old cached frame');
  const cancelled = call('preview_frame', { ...bound, afterSeq: next.seq, waitMs: 1000 });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: cancelled.id } }) + '\n');
  assert.equal((await cancelled.result).error?.code, -32800);
  releaseTimeout();
  gate = undefined;
  let releaseSwitch;
  gate = new Promise((resolve) => { releaseSwitch = resolve; });
  const switchReady = captureEntered();
  await switchReady;
  const switched = call('preview_frame', { ...bound, waitMs: 1000 });
  const newSession = call('preview_start', { deviceId: 'B' });
  await delay(30);
  releaseSwitch();
  gate = undefined;
  await newSession.result;
  const oldResult = await switched.result;
  assert.ok(oldResult.error || oldResult.result.isError || !oldResult.result.structuredContent.frame,
    'an old session refresh cannot return the new device frame');
  console.log('preview recovery: ok');
} finally {
  input.end();
  await running;
}

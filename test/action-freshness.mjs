import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output })[Symbol.asyncIterator]();
let requestId = 0;
let actionActive = false;
let releaseAction;
let captureDuringAction = false;
let captures = 0;
let preparations = 0;
let fallbackCaptures = 0;
const running = startMcp({ input, output, port: 0, frameLeaseMs: 5000, deviceAdapter: {
  listTargets: async () => ['device'],
  preparePreviewTap: async () => { preparations += 1; return true; },
  capture: async (_options, callOptions) => {
    if (callOptions?.timeoutMs === 3000) fallbackCaptures += 1;
    if (actionActive) captureDuringAction = true;
    captures += 1;
    return { mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, captures]), width: 100, height: 200, deviceWidth: 100, deviceHeight: 200 };
  },
  tap: async () => { throw new Error('portrait preview must use the fast action'); },
  previewTap: async (args) => {
    actionActive = true;
    await new Promise((resolve) => { releaseAction = resolve; });
    actionActive = false;
    return args;
  },
  keyEvent: async (args) => {
    actionActive = true;
    await new Promise((resolve) => { releaseAction = resolve; });
    actionActive = false;
    return args;
  }
} });

async function request(method, params) {
  const id = ++requestId;
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const reply = JSON.parse((await responses.next()).value);
  assert.equal(reply.id, id);
  return reply;
}

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'freshness-test', version: '1' } });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const started = (await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'device' } })).result.structuredContent;
  assert.equal(preparations, 1, 'preview startup prewarms fast-tap capability');
  const first = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } })).result.structuredContent;
  assert.ok(first.frame);
  const rejected = (await request('tools/call', { name: 'preview_action', arguments: {
    action: 'tap', deviceId: 'device', sessionId: started.sessionId, seq: first.seq - 1, x: 1, y: 1
  } })).result;
  assert.equal(rejected.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  assert.equal(rejected.structuredContent.stage, 'preview_action');
  assert.equal(fallbackCaptures, 0, 'a pre-input stale panel action must not wait for a fallback screenshot');
  const action = request('tools/call', { name: 'preview_action', arguments: { action: 'tap', deviceId: 'device', sessionId: started.sessionId, seq: first.seq, x: 1, y: 1 } });
  while (!releaseAction) await delay(5);
  await delay(180);
  assert.equal(captureDuringAction, false, 'a frame must not be sampled while the action is unfinished');
  releaseAction();
  const result = (await action).result.structuredContent;
  assert.ok(result.metrics.actionPrepareMs >= 0, 'action preparation timing must be reported');
  assert.ok(result.metrics.actionInputMs >= 160, 'device input timing must include the actual action');
  assert.ok(result.metrics.actionMs >= result.metrics.actionInputMs, 'total action timing must include device input');
  const barrier = result.metrics.nextFrameAfterSeq;
  let next = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: barrier, waitMs: 1000 } })).result.structuredContent;
  assert.ok(next.frame && next.seq > barrier, 'the frame after the barrier must be sampled after the action');
  for (const [navigation, key] of [['back', 'Back'], ['home', 'Home']]) {
    releaseAction = undefined;
    captureDuringAction = false;
    const keyAction = request('tools/call', { name: 'preview_action', arguments: {
      action: navigation, deviceId: 'device', seq: next.seq, frameId: next.frame.frameId, sessionId: started.sessionId
    } });
    while (!releaseAction) await delay(5);
    await delay(40);
    assert.equal(captureDuringAction, false, `${key} must finish before the next frame is sampled`);
    releaseAction();
    const keyResult = (await keyAction).result.structuredContent;
    assert.equal(keyResult.key, key);
    assert.equal(keyResult.metrics.action, navigation);
    next = (await request('tools/call', { name: 'preview_frame', arguments: {
      afterSeq: keyResult.metrics.nextFrameAfterSeq, waitMs: 1000
    } })).result.structuredContent;
    assert.ok(next.frame && next.seq > keyResult.metrics.nextFrameAfterSeq, `${key} must expose a post-action frame`);
  }
  await request('tools/call', { name: 'preview_stop', arguments: {} });
  console.log('action freshness: ok');
} finally {
  releaseAction?.();
  input.end();
  await running;
}

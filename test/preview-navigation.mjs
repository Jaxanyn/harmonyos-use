import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../src/mcp.mjs';
import { tagError } from '../src/diagnostics.mjs';

const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output });
const pending = new Map();
responses.on('line', (line) => {
  const reply = JSON.parse(line);
  pending.get(reply.id)?.(reply);
  pending.delete(reply.id);
});
let requestId = 0;
let connected = true;
let failure;
let screen = 0;
let deferKey = false;
let releaseKey;
const keys = [];
const pointerActions = [];
const running = startMcp({ input, output, port: 0, deviceAdapter: {
  listTargets: async () => connected ? ['device'] : [],
  capture: async () => {
    if (!connected) throw tagError(new Error('device disconnected'), 'DEVICE_OFFLINE', 'capture');
    return { mimeType: 'image/jpeg', data: Buffer.from(`frame-${screen}`), frameId: 'reused-frame' };
  },
  tap: async (args) => { pointerActions.push(args); return args; },
  swipe: async (args) => { pointerActions.push(args); return args; },
  keyEvent: async (args) => {
    keys.push(args);
    if (failure) throw failure;
    if (deferKey) {
      deferKey = false;
      await new Promise((resolve) => { releaseKey = resolve; });
    }
    screen += 1;
    return args;
  }
} });

function request(method, params) {
  const id = ++requestId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
const call = (name, arguments_) => request('tools/call', { name, arguments: arguments_ });

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'navigation-test', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = await request('tools/list');
  assert.deepEqual(listed.result.tools.find((tool) => tool.name === 'preview_action').inputSchema.properties.action.enum,
    ['tap', 'swipe', 'back', 'home']);
  const session = (await call('preview_start', { deviceId: 'device' })).result.structuredContent.sessionId;
  let frame = (await call('preview_frame', { afterSeq: 0 })).result.structuredContent;
  assert.ok(frame.frame);
  const bound = { deviceId: 'device', sessionId: session };

  for (const action of ['tap', 'swipe']) {
    for (const invalidBinding of [{}, { deviceId: 'device' }, { sessionId: session },
      { deviceId: 'other-device', sessionId: session }, { deviceId: 'device', sessionId: 'old-session' }]) {
      const rejected = (await call('preview_action', { action, seq: frame.seq, frameId: frame.frame.frameId,
        x: 1, y: 1, toX: 2, toY: 2, ...invalidBinding })).result;
      assert.equal(rejected.isError, true, `${action} must reject an invalid session or device`);
      assert.equal(rejected.structuredContent.errorCode, 'PREVIEW_UNAVAILABLE');
      assert.equal(pointerActions.length, 0, `${action} must not reach the device`);
    }
  }

  for (const incomplete of [{}, { deviceId: 'device' }, { sessionId: session }, { ...bound, deviceId: 'other-device' }, { ...bound, sessionId: 'old-session' }]) {
    const rejected = (await call('preview_action', { action: 'back', seq: frame.seq, ...incomplete })).result;
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structuredContent.errorCode, 'PREVIEW_UNAVAILABLE');
    assert.equal(keys.length, 0, 'navigation requires the active device and session');
  }

  for (const [action, key] of [['back', 'Back'], ['home', 'Home']]) {
    const previousKeys = keys.length;
    const stale = await call('preview_action', { action, ...bound, frameId: frame.frame.frameId, seq: frame.seq - 1 });
    assert.equal(stale.result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
    const wrongFrame = await call('preview_action', { action, ...bound, frameId: 'wrong-frame', seq: frame.seq });
    assert.equal(wrongFrame.result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
    assert.equal(keys.length, previousKeys, 'stale navigation actions must never reach the device');

    const result = (await call('preview_action', { action, ...bound, frameId: frame.frame.frameId, seq: frame.seq })).result;
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.content, []);
    assert.deepEqual(keys.at(-1), { deviceId: 'device', key }, 'navigation needs no coordinates');
    assert.equal(keys.length, previousKeys + 1, 'each navigation action sends exactly one input');
    assert.equal(result.structuredContent.metrics.action, action);
    const barrier = result.structuredContent.metrics.nextFrameAfterSeq;
    frame = (await call('preview_frame', { afterSeq: barrier, waitMs: 1000 })).result.structuredContent;
    assert.ok(frame.frame && frame.seq > barrier, 'navigation waits for a post-action frame');
  }

  const invalid = await call('preview_action', { action: 'power', seq: frame.seq });
  assert.equal(invalid.error.code, -32602, 'the panel cannot send Power');
  assert.equal(keys.length, 2);

  failure = tagError(new Error('key input failed'), 'ACTION_FAILED', 'key_event');
  const failed = (await call('preview_action', { action: 'back', ...bound, frameId: frame.frame.frameId, seq: frame.seq })).result;
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.errorCode, 'ACTION_FAILED');
  assert.equal(keys.length, 3, 'an uncertain key failure must not be repeated');
  failure = undefined;

  connected = false;
  let info;
  for (let i = 0; i < 10; i += 1) {
    await delay(200);
    info = (await call('preview_info', {})).result.structuredContent;
    if (!info.connected) break;
  }
  assert.equal(info.connected, false);
  const disconnected = (await call('preview_action', { action: 'home', ...bound, seq: frame.seq })).result;
  assert.equal(disconnected.isError, true);
  assert.equal(disconnected.structuredContent.errorCode, 'PREVIEW_UNAVAILABLE');
  assert.equal(keys.length, 3, 'disconnect must not dispatch a key');
  await call('preview_stop', {});

  // A queued action from one session cannot act on a later session, even if sequences coincide.
  connected = true;
  const firstSession = (await call('preview_start', { deviceId: 'device' })).result.structuredContent.sessionId;
  const firstFrame = (await call('preview_frame', { afterSeq: 0 })).result.structuredContent;
  const firstArgs = { action: 'back', deviceId: 'device', sessionId: firstSession, seq: firstFrame.seq, frameId: firstFrame.frame.frameId };
  deferKey = true;
  const firstAction = call('preview_action', firstArgs);
  while (!releaseKey) await delay(5);
  const queuedAction = call('preview_action', firstArgs);
  const nextSession = (await call('preview_start', { deviceId: 'device-2' })).result.structuredContent.sessionId;
  const nextFrame = (await call('preview_frame', { afterSeq: 0 })).result.structuredContent;
  assert.equal(nextFrame.seq, firstFrame.seq, 'both sessions should begin with the same sequence');
  assert.notEqual(nextSession, firstSession);
  const keysBeforeRelease = keys.length;
  releaseKey();
  assert.equal((await firstAction).result.isError, undefined);
  const queuedResult = (await queuedAction).result;
  assert.equal(queuedResult.isError, true);
  assert.equal(queuedResult.structuredContent.errorCode, 'PREVIEW_UNAVAILABLE');
  assert.equal(keys.length, keysBeforeRelease, 'queued navigation must not reach a new session or device');
  const staleSession = (await call('preview_action', { ...firstArgs, deviceId: 'device-2', seq: nextFrame.seq, frameId: nextFrame.frame.frameId })).result;
  assert.equal(staleSession.structuredContent.errorCode, 'PREVIEW_UNAVAILABLE');
  assert.equal(keys.length, keysBeforeRelease);
  await call('preview_stop', {});

  // Even a reused frame ID and sequence cannot transfer a pointer action to a new session on the same device.
  const oldSession = (await call('preview_start', { deviceId: 'device' })).result.structuredContent.sessionId;
  const oldFrame = await call('preview_frame', { afterSeq: 0 });
  await call('preview_stop', { sessionId: oldSession });
  const newSession = (await call('preview_start', { deviceId: 'device' })).result.structuredContent.sessionId;
  const newFrame = (await call('preview_frame', { afterSeq: 0 })).result.structuredContent;
  assert.equal(newFrame.seq, oldFrame.result.structuredContent.seq);
  assert.equal(newFrame.frame.frameId, oldFrame.result.structuredContent.frame.frameId);
  const args = { action: 'tap', deviceId: 'device', sessionId: oldSession, frameId: newFrame.frame.frameId, seq: newFrame.seq, x: 1, y: 1 };
  const rejectedOldSession = (await call('preview_action', args)).result;
  assert.equal(rejectedOldSession.structuredContent.errorCode, 'PREVIEW_UNAVAILABLE');
  assert.equal(pointerActions.length, 0);
  assert.equal((await call('preview_action', { ...args, sessionId: newSession })).result.isError, undefined);
  assert.equal(pointerActions.length, 1, 'the active session must still accept a valid action');
  await call('preview_stop', { sessionId: newSession });
  console.log('preview navigation: ok');
} finally {
  input.end();
  await running;
}

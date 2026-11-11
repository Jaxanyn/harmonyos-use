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
function requestHandle(method, params) {
  const requestId = ++id;
  const reply = new Promise((resolve) => pending.set(requestId, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  return { requestId, reply };
}
const request = (method, params) => requestHandle(method, params).reply;
const call = (name, arguments_) => request('tools/call', { name, arguments: arguments_ });
let inputs = 0;
let blockFrames = false;
let releaseFrames;
let signalInput;
let releaseInput;
let failInput = false;
let abortInput = false;
let fallbackCaptures = 0;
const inputAction = async (args, { signal } = {}) => {
  inputs++;
  signalInput?.();
  if (abortInput) await new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  if (releaseInput) await new Promise((resolve) => { releaseInput = resolve; });
  if (failInput) throw new Error('input outcome unknown');
  return args;
};
const running = startMcp({ input, output, port: 0, deviceAdapter: {
  listTargets: async () => ['device'],
  capture: async (_args, options) => {
    if (options?.timeoutMs === 3000) fallbackCaptures++;
    if (blockFrames && options?.timeoutMs !== 3000) await new Promise((resolve) => { releaseFrames = resolve; });
    return { mimeType: 'image/jpeg', data: Buffer.from('constant frame'), width: 100, height: 200, deviceWidth: 100, deviceHeight: 200 };
  },
  tap: inputAction,
  swipe: inputAction,
  keyEvent: inputAction
} });
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'action-races', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const firstPanel = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  const secondPanel = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  const current = (await call('preview_frame', { sessionId: firstPanel.sessionId, subscriberId: firstPanel.subscriberId })).result.structuredContent;
  const binding = { action: 'tap', deviceId: 'device', sessionId: firstPanel.sessionId, seq: current.seq, frameId: current.frame.frameId };

  blockFrames = true;
  const invalid = (await call('preview_action', { ...binding, subscriberId: firstPanel.subscriberId, coordinateSpace: 'frame', x: 100, y: 20 })).result;
  assert.equal(invalid.structuredContent.errorCode, 'FRAME_COORDINATE_OUT_OF_BOUNDS');
  assert.equal(inputs, 0, 'rejected coordinates must not enter input or invalidate the frame');

  let entered;
  const inputEntered = new Promise((resolve) => { entered = resolve; });
  signalInput = entered;
  releaseInput = () => {};
  const first = call('preview_action', { ...binding, subscriberId: firstPanel.subscriberId, x: 20, y: 20 });
  await inputEntered;
  const second = call('preview_action', { ...binding, subscriberId: secondPanel.subscriberId, x: 30, y: 20 });
  releaseInput();
  releaseInput = undefined;
  const firstResult = (await first).result;
  const secondResult = (await second).result;
  assert.equal(firstResult.isError, undefined);
  assert.equal(secondResult.structuredContent.errorCode, 'STALE_PREVIEW_FRAME', 'a queued action from the old frame must be rejected');
  assert.equal(inputs, 1, 'a second panel must not send the same pre-action frame');
  assert.equal(fallbackCaptures, 0, 'a known pre-input rejection must not require a fallback screenshot');

  blockFrames = false;
  releaseFrames?.();
  const fresh = (await call('preview_frame', { sessionId: secondPanel.sessionId, subscriberId: secondPanel.subscriberId, afterSeq: current.seq, waitMs: 2000 })).result.structuredContent;
  assert.ok(fresh.frame && fresh.seq > current.seq, 'a post-input frame must make the session usable again');
  signalInput = undefined;
  failInput = true;
  blockFrames = true;
  const uncertain = (await call('preview_action', { ...binding, subscriberId: firstPanel.subscriberId, seq: fresh.seq, frameId: fresh.frame.frameId, x: 20, y: 20 })).result;
  assert.equal(uncertain.isError, true);
  const afterFailure = (await call('preview_action', { ...binding, subscriberId: secondPanel.subscriberId, seq: fresh.seq, frameId: fresh.frame.frameId, x: 30, y: 20 })).result;
  assert.equal(afterFailure.structuredContent.errorCode, 'STALE_PREVIEW_FRAME', 'an uncertain input must invalidate its old frame');
  assert.equal(inputs, 2, 'an uncertain input must not be followed by another action on its old frame');
  assert.equal(fallbackCaptures, 1, 'only the uncertain input retains screenshot fallback');

  blockFrames = false;
  releaseFrames?.();
  let next = (await call('preview_frame', { sessionId: firstPanel.sessionId, subscriberId: firstPanel.subscriberId, afterSeq: fresh.seq, waitMs: 2000 })).result.structuredContent;
  assert.ok(next.frame && next.seq > fresh.seq, 'fresh frame must recover after an uncertain input');
  failInput = false;
  for (const [action, coordinates] of [['home', {}], ['swipe', { x: 20, y: 20, toX: 30, toY: 30 }]]) {
    const before = inputs;
    const args = { ...binding, ...coordinates, action, seq: next.seq, frameId: next.frame.frameId };
    blockFrames = true;
    const sent = (await call('preview_action', { ...args, subscriberId: firstPanel.subscriberId })).result;
    assert.equal(sent.isError, undefined, `${action} must accept a fresh frame`);
    const duplicate = (await call('preview_action', { ...args, subscriberId: secondPanel.subscriberId })).result;
    assert.equal(duplicate.structuredContent.errorCode, 'STALE_PREVIEW_FRAME', `${action} must invalidate its old frame`);
    assert.equal(inputs, before + 1, `${action} duplicate must not reach device`);
    blockFrames = false;
    releaseFrames?.();
    const newer = (await call('preview_frame', { sessionId: firstPanel.sessionId, subscriberId: firstPanel.subscriberId, afterSeq: next.seq, waitMs: 2000 })).result.structuredContent;
    assert.ok(newer.frame && newer.seq > next.seq, `${action} must recover on a fresh frame`);
    next = newer;
  }

  let enteredCancelledInput;
  const cancelledInputEntered = new Promise((resolve) => { enteredCancelledInput = resolve; });
  signalInput = enteredCancelledInput;
  abortInput = true;
  blockFrames = true;
  const cancelledArgs = { ...binding, subscriberId: firstPanel.subscriberId, seq: next.seq, frameId: next.frame.frameId, x: 20, y: 20 };
  const cancelled = requestHandle('tools/call', { name: 'preview_action', arguments: cancelledArgs });
  await cancelledInputEntered;
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelled.requestId } }) + '\n');
  assert.equal((await cancelled.reply).error?.code, -32800, 'an in-progress input must respond to MCP cancellation');
  const beforeRetry = inputs;
  const staleAfterCancel = (await call('preview_action', { ...cancelledArgs, subscriberId: secondPanel.subscriberId })).result;
  assert.equal(staleAfterCancel.structuredContent.errorCode, 'STALE_PREVIEW_FRAME', 'cancelled input must invalidate its old frame');
  assert.equal(inputs, beforeRetry, 'old frame after cancellation must not reach device');
  blockFrames = false;
  releaseFrames?.();
  const afterCancel = (await call('preview_frame', { sessionId: firstPanel.sessionId, subscriberId: firstPanel.subscriberId, afterSeq: next.seq, waitMs: 2000 })).result.structuredContent;
  assert.ok(afterCancel.frame && afterCancel.seq > next.seq, 'a new frame must arrive after cancellation');
  blockFrames = true;
  abortInput = false;
  signalInput = undefined;
  const recovered = (await call('preview_action', { ...cancelledArgs, seq: afterCancel.seq, frameId: afterCancel.frame.frameId })).result;
  assert.equal(recovered.isError, undefined, `a confirmed new frame must restore input after cancellation: ${JSON.stringify(recovered.structuredContent)}`);

  blockFrames = false;
  releaseFrames?.();
  const beforeRestart = (await call('preview_frame', { sessionId: firstPanel.sessionId, subscriberId: firstPanel.subscriberId, afterSeq: afterCancel.seq, waitMs: 2000 })).result.structuredContent;
  assert.ok(beforeRestart.frame, 'a frame is needed to start the old session input');
  blockFrames = true;
  let enteredOldInput;
  const oldInputEntered = new Promise((resolve) => { enteredOldInput = resolve; });
  signalInput = enteredOldInput;
  releaseInput = () => {};
  const oldAction = call('preview_action', { ...binding, subscriberId: firstPanel.subscriberId, seq: beforeRestart.seq, frameId: beforeRestart.frame.frameId, x: 20, y: 20 });
  await Promise.race([oldInputEntered, oldAction.then((response) => { throw new Error(`old input did not start: ${JSON.stringify(response)}`); })]);
  const stopped = (await call('preview_stop', { sessionId: firstPanel.sessionId })).result;
  assert.equal(stopped.isError, undefined, 'stopping a preview must not wait for device input');
  blockFrames = false;
  releaseFrames?.();
  const replacement = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  assert.notEqual(replacement.sessionId, firstPanel.sessionId);
  const replacementFrame = (await call('preview_frame', { sessionId: replacement.sessionId, subscriberId: replacement.subscriberId })).result.structuredContent;
  assert.ok(replacementFrame.frame, 'the replacement must have obtained a frame before input completed');
  blockFrames = true;
  const replacementArgs = { ...binding, sessionId: replacement.sessionId, subscriberId: replacement.subscriberId,
    seq: replacementFrame.seq, frameId: replacementFrame.frame.frameId, x: 20, y: 20 };
  const queuedOnReplacement = call('preview_action', replacementArgs);
  const beforeReplacement = inputs;
  releaseInput();
  releaseInput = undefined;
  assert.equal((await oldAction).result.isError, undefined);
  const staleReplacement = (await queuedOnReplacement).result;
  assert.equal(staleReplacement.structuredContent.errorCode, 'STALE_PREVIEW_FRAME', 'a replacement session must reject frames captured during the old input');
  assert.equal(inputs, beforeReplacement, 'replacement stale input must not reach the device');
  blockFrames = false;
  releaseFrames?.();
  const afterReplacement = (await call('preview_frame', { sessionId: replacement.sessionId, subscriberId: replacement.subscriberId, afterSeq: replacementFrame.seq, waitMs: 2000 })).result.structuredContent;
  assert.ok(afterReplacement.frame && afterReplacement.seq > replacementFrame.seq, 'replacement must refresh after the old input completes');
  signalInput = undefined;
  const replacementRecovered = (await call('preview_action', { ...replacementArgs, seq: afterReplacement.seq, frameId: afterReplacement.frame.frameId })).result;
  assert.equal(replacementRecovered.isError, undefined, 'replacement must accept a confirmed post-input frame');

  const beforeCancelledRestart = (await call('preview_frame', { sessionId: replacement.sessionId, subscriberId: replacement.subscriberId, afterSeq: afterReplacement.seq, waitMs: 2000 })).result.structuredContent;
  assert.ok(beforeCancelledRestart.frame);
  blockFrames = true;
  let enteredCancelledOldInput;
  const cancelledOldInputEntered = new Promise((resolve) => { enteredCancelledOldInput = resolve; });
  signalInput = enteredCancelledOldInput;
  abortInput = true;
  const cancelledOldAction = requestHandle('tools/call', { name: 'preview_action', arguments: { ...replacementArgs,
    seq: beforeCancelledRestart.seq, frameId: beforeCancelledRestart.frame.frameId } });
  await Promise.race([cancelledOldInputEntered, cancelledOldAction.reply.then((response) => { throw new Error(`cancelled old input did not start: ${JSON.stringify(response)}`); })]);
  assert.equal((await call('preview_stop', { sessionId: replacement.sessionId })).result.isError, undefined);
  blockFrames = false;
  releaseFrames?.();
  const afterCancelledRestart = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  const duringCancelledInput = (await call('preview_frame', { sessionId: afterCancelledRestart.sessionId, subscriberId: afterCancelledRestart.subscriberId })).result.structuredContent;
  blockFrames = true;
  const afterCancelledArgs = { ...replacementArgs, sessionId: afterCancelledRestart.sessionId, subscriberId: afterCancelledRestart.subscriberId,
    seq: duringCancelledInput.seq, frameId: duringCancelledInput.frame.frameId };
  const queuedAfterCancel = call('preview_action', afterCancelledArgs);
  const beforeCancelRetry = inputs;
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: cancelledOldAction.requestId } }) + '\n');
  assert.equal((await cancelledOldAction.reply).error?.code, -32800);
  assert.equal((await queuedAfterCancel).result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME', 'a cancelled input must also invalidate the replacement frame');
  assert.equal(inputs, beforeCancelRetry);
  blockFrames = false;
  releaseFrames?.();
  const afterCancelledFrame = (await call('preview_frame', { sessionId: afterCancelledRestart.sessionId, subscriberId: afterCancelledRestart.subscriberId, afterSeq: duringCancelledInput.seq, waitMs: 2000 })).result.structuredContent;
  assert.ok(afterCancelledFrame.frame && afterCancelledFrame.seq > duringCancelledInput.seq);
  abortInput = false;
  signalInput = undefined;
  assert.equal((await call('preview_action', { ...afterCancelledArgs, seq: afterCancelledFrame.seq, frameId: afterCancelledFrame.frame.frameId })).result.isError, undefined);

  console.log('preview action races: ok');
} finally {
  blockFrames = false;
  releaseFrames?.();
  releaseInput?.();
  input.end();
  await running;
}

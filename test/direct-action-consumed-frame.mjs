import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const pending = new Map();
let nextId = 0;
createInterface({ input: output }).on('line', (line) => {
  const response = JSON.parse(line);
  pending.get(response.id)?.(response);
  pending.delete(response.id);
});
function request(method, params) {
  const id = ++nextId;
  const reply = new Promise((resolve) => pending.set(id, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return reply;
}
const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
let blockFrames = false;
let releaseFrame;
let inputs = 0;
let failInput = false;
let frameVersion = 0;
let holdInput = false;
let inputEntered;
let releaseInput;
const deviceAdapter = {
  listTargets: async () => ['device'],
  capture: async (_args, options) => {
    if (blockFrames && options?.timeoutMs !== 3000) {
      await new Promise((resolve) => { releaseFrame = resolve; });
    }
    return { mimeType: 'image/jpeg', data: Buffer.from(`frame ${frameVersion}`), width: 100, height: 200, deviceWidth: 100, deviceHeight: 200 };
  },
  tap: async () => {
    inputs++;
    if (holdInput) await new Promise((resolve) => {
      releaseInput = resolve;
      inputEntered?.();
    });
    if (failInput) throw new Error('uncertain input outcome');
    return { ok: true };
  }
};
const running = startMcp({ input, output, port: 0, previewUrl: null, autoStartPreview: false, deviceAdapter });
const failures = [];
function expect(condition, message) {
  if (!condition) failures.push(message);
}

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'direct-action-consumed-frame', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const panel = (await call('preview_start', { deviceId: 'device', subscriber: true })).structuredContent;
  let frame = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId })).structuredContent;
  const previewArgs = () => ({ action: 'tap', deviceId: 'device', sessionId: panel.sessionId,
    subscriberId: panel.subscriberId, seq: frame.seq, frameId: frame.frame.frameId, x: 20, y: 20 });
  const directArgs = () => ({ deviceId: 'device', x: 20, y: 20 });
  async function nextFrame() {
    blockFrames = false;
    releaseFrame?.();
    const fresh = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId,
      afterSeq: frame.seq, waitMs: 2000 })).structuredContent;
    assert.ok(fresh.frame && fresh.seq > frame.seq, 'expected a newly captured frame');
    frame = fresh;
    blockFrames = true;
  }

  blockFrames = true;
  const invalid = await call('tap', { ...directArgs(), frameId: frame.frame.frameId, seq: frame.seq,
    coordinateSpace: 'frame', x: 100 });
  expect(invalid.structuredContent?.errorCode === 'FRAME_COORDINATE_OUT_OF_BOUNDS', 'invalid coordinates must be rejected');
  expect(inputs === 0, 'invalid coordinates must not reach device input');
  const valid = await call('preview_action', previewArgs());
  expect(!valid.isError, 'invalid direct coordinates must not consume the current frame');

  const afterPreview = inputs;
  const frameIdOnly = await call('tap', { ...directArgs(), frameId: frame.frame.frameId });
  expect(frameIdOnly.structuredContent?.errorCode === 'STALE_PREVIEW_FRAME', 'a direct action bound by frameId must reject a frame consumed by preview_action');
  const seqOnly = await call('tap', { ...directArgs(), seq: frame.seq });
  expect(seqOnly.structuredContent?.errorCode === 'STALE_PREVIEW_FRAME', 'a direct action bound by seq must reject a frame consumed by preview_action');
  expect(inputs === afterPreview, 'consumed-frame direct actions must not reach the device');

  await nextFrame();
  const direct = await call('tap', { ...directArgs(), frameId: frame.frame.frameId, seq: frame.seq });
  expect(!direct.isError, 'fresh frame-bound direct action must succeed');
  const afterDirect = inputs;
  const previewAfterDirect = await call('preview_action', previewArgs());
  expect(previewAfterDirect.structuredContent?.errorCode === 'STALE_PREVIEW_FRAME', 'preview_action must reject a frame consumed by direct action');
  expect(inputs === afterDirect, 'preview_action on a consumed frame must not reach the device');

  await nextFrame();
  const unbound = await call('tap', directArgs());
  expect(!unbound.isError, 'an unbound direct action must remain available');
  const afterUnbound = inputs;
  const previewAfterUnbound = await call('preview_action', previewArgs());
  expect(previewAfterUnbound.structuredContent?.errorCode === 'STALE_PREVIEW_FRAME', 'an unbound direct action must also consume the displayed frame');
  expect(inputs === afterUnbound, 'preview action after unbound direct input must not reach the device');

  await nextFrame();
  failInput = true;
  const failed = await call('tap', { ...directArgs(), frameId: frame.frame.frameId, seq: frame.seq });
  expect(failed.isError === true, 'adapter failure must be reported');
  failInput = false;
  const afterFailure = inputs;
  const previewAfterFailure = await call('preview_action', previewArgs());
  expect(previewAfterFailure.structuredContent?.errorCode === 'STALE_PREVIEW_FRAME', 'an uncertain direct input must consume its frame');
  expect(inputs === afterFailure, 'an uncertain direct input must not be repeated on its old frame');

  await nextFrame();
  const recovered = await call('preview_action', previewArgs());
  expect(!recovered.isError, 'a newly captured frame must restore preview input');

  // An ordinary input holds the device lock while preview capture continues.
  // The second panel can observe a frame during that input and queue an action.
  await nextFrame();
  holdInput = true;
  const entered = new Promise((resolve) => { inputEntered = resolve; });
  const activeDirect = call('tap', directArgs());
  await entered;
  frameVersion++;
  blockFrames = false;
  releaseFrame?.();
  const during = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId,
    afterSeq: frame.seq, waitMs: 2000 })).structuredContent;
  assert.ok(during.frame && during.seq > frame.seq, 'a frame must arrive while ordinary input is in progress');
  blockFrames = true;
  const queuedPreview = call('preview_action', { ...previewArgs(), seq: during.seq, frameId: during.frame.frameId });
  await new Promise((resolve) => setImmediate(resolve));
  holdInput = false;
  releaseInput();
  const directResult = await activeDirect;
  expect(!directResult.isError, 'in-flight ordinary input must finish successfully');
  const inputCountAfterDirect = inputs;
  const duringResult = await queuedPreview;
  expect(duringResult.structuredContent?.errorCode === 'STALE_PREVIEW_FRAME', 'preview action must reject a frame captured during ordinary input');
  expect(inputs === inputCountAfterDirect, 'a queued action on a frame captured during ordinary input must not reach the device');
  frame = during;
  await nextFrame();
  const recoveredAfterInFlight = await call('preview_action', previewArgs());
  expect(!recoveredAfterInFlight.isError, 'post-input capture must restore preview input');

  // The preview can also begin while an ordinary action was already in flight.
  blockFrames = false;
  releaseFrame?.();
  await call('preview_stop', { sessionId: panel.sessionId, subscriberId: panel.subscriberId });
  holdInput = true;
  const enteredWithoutPreview = new Promise((resolve) => { inputEntered = resolve; });
  const directWithoutPreview = call('tap', directArgs());
  await enteredWithoutPreview;
  const newPanel = (await call('preview_start', { deviceId: 'device', subscriber: true })).structuredContent;
  const newFrame = (await call('preview_frame', { sessionId: newPanel.sessionId, subscriberId: newPanel.subscriberId })).structuredContent;
  assert.ok(newFrame.frame, 'a newly started preview must expose its first frame while input is in progress');
  blockFrames = true;
  const newPreviewArgs = { action: 'tap', deviceId: 'device', sessionId: newPanel.sessionId,
    subscriberId: newPanel.subscriberId, seq: newFrame.seq, frameId: newFrame.frame.frameId, x: 20, y: 20 };
  const queuedNewPreview = call('preview_action', newPreviewArgs);
  await new Promise((resolve) => setImmediate(resolve));
  holdInput = false;
  releaseInput();
  expect(!(await directWithoutPreview).isError, 'ordinary input without an initial preview must succeed');
  const countBeforeNewPreview = inputs;
  const newPreviewResult = await queuedNewPreview;
  expect(newPreviewResult.structuredContent?.errorCode === 'STALE_PREVIEW_FRAME', 'a preview started during ordinary input must invalidate its pre-completion frame');
  expect(inputs === countBeforeNewPreview, 'a newly started preview must not act on its pre-completion frame');
  blockFrames = false;
  releaseFrame?.();
  const newFresh = (await call('preview_frame', { sessionId: newPanel.sessionId, subscriberId: newPanel.subscriberId,
    afterSeq: newFrame.seq, waitMs: 2000 })).structuredContent;
  assert.ok(newFresh.frame && newFresh.seq > newFrame.seq, 'newly started preview must recover with a post-input frame');
  const newRecovered = await call('preview_action', { ...newPreviewArgs, seq: newFresh.seq, frameId: newFresh.frame.frameId });
  expect(!newRecovered.isError, 'newly started preview must accept a post-input frame');
  assert.deepEqual(failures, [], failures.join('\n'));
  console.log('direct action consumed frame: ok');
} finally {
  blockFrames = false;
  releaseFrame?.();
  releaseInput?.();
  input.end();
  await running;
}

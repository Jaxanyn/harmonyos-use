import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output })[Symbol.asyncIterator]();
let id = 0;
let captures = 0;
let taps = 0;
const running = startMcp({
  input, output, port: 0, projectPath: '', frameLeaseMs: 50,
  deviceAdapter: {
    listTargets: async () => ['test-device'],
    capture: async () => { captures += 1; return { mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, captures]) }; },
    tap: async (args) => { taps += 1; return args; },
    swipe: async (args) => args,
    observe: async () => ({ nodes: [], totalNodes: 0, truncated: false }),
    find: async () => ({ matches: [], totalMatches: 0, truncated: false }),
    waitFor: async () => ({ status: 'matched', attempts: 1, elapsedMs: 1, lastObservation: null }),
    longPress: async (args) => args,
    keyEvent: async (args) => args,
    inputText: async (args) => args,
  }
});

async function request(method, params) {
  input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  const line = await responses.next();
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  return reply;
}

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'preview-frame-test', version: '1' } });
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const started = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  const session = JSON.parse(started.result.content[0].text);
  const first = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } });
  const firstData = first.result.structuredContent;
  assert.equal(first.result.content.length, 0);
  assert.equal(firstData.connected, true);
  assert.ok(firstData.frame);
  assert.equal(firstData.frameSource, 'jpeg');
  assert.equal(firstData.metrics.source, 'jpeg');
  assert.equal(firstData.metrics.frameBytes, 3);
  const duplicate = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: firstData.seq } });
  assert.equal(duplicate.result.structuredContent.frame, null);
  const waitedAt = performance.now();
  const waited = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: firstData.seq, waitMs: 600 } });
  assert.ok(waited.result.structuredContent.frame, 'waitMs should resolve on the next live frame');
  assert.ok(waited.result.structuredContent.seq > firstData.seq);
  assert.ok(performance.now() - waitedAt < 650, 'frame wait should resolve within its bound');
  const latestSeq = waited.result.structuredContent.seq;
  const stale = await request('tools/call', { name: 'preview_action', arguments: { action: 'tap', deviceId: 'test-device', sessionId: session.sessionId, seq: 0, x: 1, y: 1 } });
  assert.equal(stale.result.isError, true);
  assert.equal(stale.result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  assert.equal(taps, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const paused = (await request('tools/call', { name: 'preview_info' })).result.structuredContent;
  assert.equal(paused.paused, true);
  assert.equal(paused.sessionId, session.sessionId);
  let resumed;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const next = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: latestSeq, waitMs: 600 } });
    resumed = next.result.structuredContent;
    if (resumed.frame) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(resumed.frame, 'frame lease should resume on demand');
  assert.equal(resumed.connected, true);
  assert.equal(resumed.sessionId, session.sessionId);
  assert.ok(resumed.seq > firstData.seq);
  await request('tools/call', { name: 'preview_stop', arguments: { sessionId: session.sessionId } });
} finally {
  input.end();
  await running;
}

// Incoming dynamic frames must not renew a lease that the panel stopped using.
const dynamicInput = new PassThrough();
const dynamicOutput = new PassThrough();
const dynamicResponses = createInterface({ input: dynamicOutput })[Symbol.asyncIterator]();
let dynamicId = 0;
let dynamicCaptures = 0;
const dynamicRunning = startMcp({ input: dynamicInput, output: dynamicOutput, port: 0, projectPath: '', frameLeaseMs: 800,
  deviceAdapter: {
    listTargets: async () => ['dynamic-device'],
    capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from(`frame-${++dynamicCaptures}`) })
  }
});
const dynamicRequest = async (name, args = {}) => {
  const requestId = ++dynamicId;
  dynamicInput.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: name, params: args }) + '\n');
  const reply = JSON.parse((await dynamicResponses.next()).value);
  assert.equal(reply.id, requestId);
  return reply;
};
try {
  await dynamicRequest('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dynamic-lease-test', version: '1' } });
  dynamicInput.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const session = (await dynamicRequest('tools/call', { name: 'preview_start', arguments: { deviceId: 'dynamic-device' } })).result.structuredContent;
  await new Promise((resolve) => setTimeout(resolve, 1300));
  const paused = (await dynamicRequest('tools/call', { name: 'preview_info' })).result.structuredContent;
  assert.ok(dynamicCaptures >= 2, 'the source must produce changing frames before the lease expires');
  assert.equal(paused.paused, true, 'new frames must not renew the panel consumption lease');
  const pausedCaptures = dynamicCaptures;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(dynamicCaptures, pausedCaptures, 'background dynamic sampling must stop after the lease expires');
  const resumed = (await dynamicRequest('tools/call', { name: 'preview_frame', arguments: { afterSeq: pausedCaptures, waitMs: 1000 } })).result.structuredContent;
  assert.ok(resumed.frame, 'a frame request must resume dynamic sampling');
  assert.equal(resumed.sessionId, session.sessionId);
  assert.ok(resumed.seq > pausedCaptures);
} finally {
  dynamicInput.end();
  await dynamicRunning;
}

// Frame-relative points must be inside the bound image before scaling/rotation.
async function testFrameCoordinateBounds(rotation) {
  const boundInput = new PassThrough();
  const boundOutput = new PassThrough();
  const boundReplies = createInterface({ input: boundOutput })[Symbol.asyncIterator]();
  let requestId = 0;
  const actions = [];
  const record = (name) => async (args) => { actions.push({ name, args }); return args; };
  const boundRunning = startMcp({ input: boundInput, output: boundOutput, port: 0, projectPath: '', deviceAdapter: {
    listTargets: async () => ['bound-device'],
    capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]),
      width: 100, height: 200, deviceWidth: 200, deviceHeight: 400, ...(rotation === undefined ? {} : { rotation }) }),
    tap: record('tap'), swipe: record('swipe'), longPress: record('long_press'), inputText: record('input_text')
  } });
  const call = async (method, params) => {
    const id = ++requestId;
    boundInput.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    for (;;) { const next = await boundReplies.next(); assert.equal(next.done, false); const reply = JSON.parse(next.value); if (reply.id === id) return reply; }
  };
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'frame-bounds-test', version: '1' } });
    boundInput.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const session = (await call('tools/call', { name: 'preview_start', arguments: { deviceId: 'bound-device' } })).result.structuredContent;
    const frame = async () => (await call('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } })).result.structuredContent;
    const cases = [
      ['preview_action', { action: 'tap', x: 100, y: 50, sessionId: session.sessionId }],
      ['preview_action', { action: 'swipe', x: 100, y: 50, toX: 10, toY: 10, sessionId: session.sessionId }],
      ['preview_action', { action: 'swipe', x: 10, y: 10, toX: 10, toY: 200, sessionId: session.sessionId }],
      ['tap', { x: 100, y: 50 }], ['tap', { x: 0, y: 200 }], ['tap', { x: 1000000, y: 50 }],
      ['swipe', { fromX: 100, fromY: 10, toX: 10, toY: 10 }],
      ['swipe', { fromX: 10, fromY: 10, toX: 10, toY: 200 }],
      ['long_press', { x: 100, y: 50 }], ['input_text', { text: 'test', x: 100, y: 50 }]
    ];
    for (const [name, coordinates] of cases) {
      const current = await frame();
      const before = actions.length;
      const response = (await call('tools/call', { name, arguments: { deviceId: 'bound-device', coordinateSpace: 'frame',
        frameId: current.frame.frameId, seq: current.seq, ...coordinates } })).result;
      assert.equal(response.isError, true, `${name} must reject a point outside the frame at rotation ${rotation ?? 0}`);
      assert.equal(response.structuredContent.errorCode, 'FRAME_COORDINATE_OUT_OF_BOUNDS');
      assert.equal(response.structuredContent.stage, 'action_frame');
      assert.equal(actions.length, before, `${name} must not dispatch an out-of-frame point`);
      if (name === 'preview_action') assert.ok(!response.content.some((item) => item.type === 'image'), 'a pre-input rejection must not request a fallback screenshot');
      if (name === 'preview_action') await call('tools/call', { name: 'preview_frame', arguments: { afterSeq: current.seq, waitMs: 1000 } });
    }
    const originFrame = await frame();
    const origin = (await call('tools/call', { name: 'tap', arguments: { deviceId: 'bound-device', coordinateSpace: 'frame',
      frameId: originFrame.frame.frameId, seq: originFrame.seq, x: 0, y: 0 } })).result;
    assert.equal(origin.isError, undefined, 'the upper-left boundary must remain valid');
    await call('tools/call', { name: 'preview_frame', arguments: { afterSeq: originFrame.seq, waitMs: 1000 } });
    const current = await frame();
    const valid = (await call('tools/call', { name: 'tap', arguments: { deviceId: 'bound-device', coordinateSpace: 'frame',
      frameId: current.frame.frameId, seq: current.seq, x: 99.9, y: 199.9 } })).result;
    assert.equal(valid.isError, undefined, 'a point just inside the lower-right boundary must remain valid');
    assert.equal(actions.length, 2);
    for (const action of actions) assert.ok(action.args.x >= 0 && action.args.x < 200 && action.args.y >= 0 && action.args.y < 400);
    await call('tools/call', { name: 'preview_frame', arguments: { afterSeq: current.seq, waitMs: 1000 } });
    const calibrated = await frame();
    const mapped = (await call('tools/call', { name: 'tap', arguments: { deviceId: 'bound-device', coordinateSpace: 'frame',
      frameId: calibrated.frame.frameId, seq: calibrated.seq, x: 20, y: 50 } })).result;
    assert.equal(mapped.isError, undefined);
    const expected = { 0: [40, 100], 90: [50, 320], 180: [160, 300], 270: [150, 80] }[rotation ?? 0];
    assert.deepEqual([actions.at(-1).args.x, actions.at(-1).args.y], expected, `frame-to-device mapping at ${rotation ?? 0}°`);
  } finally { boundInput.end(); await boundRunning; }
}
for (const rotation of [undefined, 90, 180, 270]) await testFrameCoordinateBounds(rotation);

console.log('preview frame: ok');

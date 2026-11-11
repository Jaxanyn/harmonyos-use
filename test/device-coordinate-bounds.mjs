import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { startMcp } from '../src/mcp.mjs';

async function run(metadata, verify) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = createInterface({ input: output })[Symbol.asyncIterator]();
  const actions = [];
  const record = (name) => async (args) => { actions.push({ name, args }); return args; };
  const running = startMcp({ input, output, port: 0, projectPath: '', deviceAdapter: {
    listTargets: async () => ['device'],
    capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from([0xff, 0xd8, 0xff]), width: 100, height: 200, ...metadata }),
    tap: record('tap'), swipe: record('swipe'), longPress: record('long_press'), inputText: record('input_text')
  } });
  let id = 0;
  async function call(method, params) {
    const requestId = ++id;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    for (;;) {
      const next = await replies.next();
      assert.equal(next.done, false);
      const reply = JSON.parse(next.value);
      if (reply.id === requestId) return reply;
    }
  }
  try {
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'device-coordinate-bounds-test', version: '1' } });
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const session = (await call('tools/call', { name: 'preview_start', arguments: { deviceId: 'device' } })).result.structuredContent;
    const frame = async () => (await call('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } })).result.structuredContent;
    await verify({ call, frame, session, actions });
  } finally {
    input.end();
    await running;
  }
}

await run({ deviceWidth: 200, deviceHeight: 400 }, async ({ call, frame, session, actions }) => {
  const cases = [
    ['preview_action', { action: 'tap', x: 200, y: 50, sessionId: session.sessionId }],
    ['preview_action', { action: 'swipe', x: 200, y: 10, toX: 10, toY: 10, sessionId: session.sessionId }],
    ['preview_action', { action: 'swipe', x: 10, y: 10, toX: 10, toY: 400, sessionId: session.sessionId }],
    ['tap', { x: 200, y: 50 }], ['tap', { x: 199.5, y: 50 }], ['tap', { x: 10, y: 399.5 }],
    ['swipe', { fromX: 200, fromY: 10, toX: 10, toY: 10 }],
    ['swipe', { fromX: 10, fromY: 10, toX: 10, toY: 400 }],
    ['long_press', { x: 200, y: 50 }], ['input_text', { text: 'probe', x: 200, y: 50 }]
  ];
  for (const [name, coords] of cases) {
    const current = await frame();
    const previous = actions.length;
    const response = (await call('tools/call', { name, arguments: { deviceId: 'device', coordinateSpace: 'device',
      frameId: current.frame.frameId, seq: current.seq, ...coords } })).result;
    assert.equal(response.isError, true, `${name} must reject device coordinates outside known geometry`);
    assert.equal(response.structuredContent.errorCode, 'DEVICE_COORDINATE_OUT_OF_BOUNDS');
    assert.equal(response.structuredContent.stage, 'action_frame');
    assert.equal(actions.length, previous, `${name} must not send invalid input`);
    if (name === 'preview_action') await call('tools/call', { name: 'preview_frame', arguments: { afterSeq: current.seq, waitMs: 1000 } });
  }
  for (const [x, y] of [[0, 0], [199.49, 399.49]]) {
    const current = await frame();
    const response = (await call('tools/call', { name: 'tap', arguments: { deviceId: 'device', coordinateSpace: 'device',
      frameId: current.frame.frameId, seq: current.seq, x, y } })).result;
    assert.equal(response.isError, undefined, 'rounded points inside bounds remain valid');
    await call('tools/call', { name: 'preview_frame', arguments: { afterSeq: current.seq, waitMs: 1000 } });
  }
  assert.equal(actions.length, 2);
  const focusedFrame = await frame();
  const focused = (await call('tools/call', { name: 'input_text', arguments: { deviceId: 'device', coordinateSpace: 'device',
    frameId: focusedFrame.frame.frameId, seq: focusedFrame.seq, text: 'probe' } })).result;
  assert.equal(focused.isError, undefined, 'bound device-space text input may target existing focus');
  assert.equal(actions.length, 3);
  const unbound = (await call('tools/call', { name: 'tap', arguments: { deviceId: 'device', x: 200, y: 1 } })).result;
  assert.equal(unbound.isError, undefined, 'legacy unbound device coordinates remain unchanged');
});

for (const metadata of [{}, { deviceWidth: 200, deviceHeight: 400, rotation: 90 },
  { deviceWidth: 200, deviceHeight: 400, orientationChanged: true }]) {
  await run(metadata, async ({ call, frame, actions }) => {
    const current = await frame();
    const response = (await call('tools/call', { name: 'tap', arguments: { deviceId: 'device', coordinateSpace: 'device',
      frameId: current.frame.frameId, seq: current.seq, x: 200, y: 1 } })).result;
    assert.equal(response.isError, undefined, 'do not enforce uncalibrated device geometry');
    assert.equal(actions.length, 1);
  });
}

for (const rotation of [0, 90, 180, 270]) {
  await run({ deviceWidth: 10, deviceHeight: 20, rotation }, async ({ call, frame, session, actions }) => {
    for (const [coordinateSpace, coordinates] of [
      ['frame', { x: 10, y: 20, toX: 11, toY: 20 }],
      ['device', { x: 1.1, y: 2.1, toX: 1.4, toY: 2.4 }],
    ]) {
      const current = await frame();
      const response = (await call('tools/call', { name: 'preview_action', arguments: { deviceId: 'device',
        sessionId: session.sessionId, frameId: current.frame.frameId, seq: current.seq, action: 'swipe',
        coordinateSpace, ...coordinates } })).result;
      assert.equal(response.isError, true, `${coordinateSpace}, rotation ${rotation} must reject a collapsed swipe`);
      assert.equal(response.structuredContent.errorCode, 'SWIPE_SAME_DEVICE_POINT');
      assert.equal(response.structuredContent.stage, 'action_frame');
      assert.equal(actions.length, 0, 'a collapsed swipe must not reach device input');
      await call('tools/call', { name: 'preview_frame', arguments: { afterSeq: current.seq, waitMs: 1000 } });
    }
    const current = await frame();
    const valid = (await call('tools/call', { name: 'preview_action', arguments: { deviceId: 'device',
      sessionId: session.sessionId, frameId: current.frame.frameId, seq: current.seq, action: 'swipe',
      coordinateSpace: 'frame', x: 10, y: 20, toX: 30, toY: 60 } })).result;
    assert.equal(valid.isError, undefined, `rotation ${rotation} must preserve valid swipes`);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].name, 'swipe');
    assert.ok(Math.round(actions[0].args.fromX) !== Math.round(actions[0].args.toX) ||
      Math.round(actions[0].args.fromY) !== Math.round(actions[0].args.toY));
  });
}

console.log('device coordinate bounds: ok');

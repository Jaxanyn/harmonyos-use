import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';
import { startMcp } from '../src/mcp.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmony-stale-reasons-'));
const server = createServer();
const sockets = new WebSocketServer({ server });
let raceNextPause = false;
let sendFrame;
sockets.on('connection', (socket) => {
  let seq = 0;
  const frame = () => {
    socket.send(JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId: `frame-${++seq}`,
      width: 100, height: 200, deviceWidth: 100, deviceHeight: 200, mimeType: 'image/jpeg' }));
    socket.send(Buffer.from('frame'));
  };
  sendFrame = frame;
  socket.on('message', (message) => {
    const event = JSON.parse(message.toString());
    if (event.type === 'preview-start') {
      socket.send(JSON.stringify({ type: 'preview-status', running: true }));
      frame();
    } else if (event.type === 'preview-action-start') {
      if (raceNextPause) { raceNextPause = false; frame(); }
      socket.send(JSON.stringify({ type: 'preview-action-ready', actionId: event.actionId }));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const input = new PassThrough();
const output = new PassThrough();
const replies = new Map();
let id = 0;
createInterface({ input: output }).on('line', (line) => {
  const response = JSON.parse(line);
  replies.get(response.id)?.(response);
  replies.delete(response.id);
});
const request = (method, params) => {
  const requestId = ++id;
  const reply = new Promise((resolve) => replies.set(requestId, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  return reply;
};
const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
let inputs = 0;
let failureCode;
const running = startMcp({ input, output, previewUrl: `http://127.0.0.1:${server.address().port}/`,
  previewStatePath: join(directory, 'state.json'), deviceAdapter: {
    listTargets: async () => ['device'],
    tap: async () => {
      inputs++;
      if (failureCode) throw Object.assign(new Error('simulated error after input'), {
        errorCode: failureCode, stage: 'preview_action', previewPreInput: true
      });
      return {};
    },
    capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('fallback') })
  } });
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stale-reasons', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const panel = (await call('preview_start', { deviceId: 'device', subscriber: true })).structuredContent;
  let frame = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId })).structuredContent;
  const args = () => ({ action: 'tap', deviceId: 'device', sessionId: panel.sessionId, subscriberId: panel.subscriberId,
    seq: frame.seq, frameId: frame.frame.frameId, x: 20, y: 20 });
  const check = (result, reason, phase) => {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
    assert.equal(result.structuredContent.inputNotSent, true);
    assert.equal(result.structuredContent.staleReason, reason);
    assert.equal(result.structuredContent.stalePhase, phase);
  };
  check(await call('preview_action', { ...args(), seq: frame.seq + 1 }), 'sequence_changed', 'before_pause');
  check(await call('preview_action', { ...args(), frameId: 'other-frame' }), 'frame_changed', 'before_pause');
  const invalidPoint = await call('preview_action', { ...args(), coordinateSpace: 'frame', x: 100 });
  assert.equal(invalidPoint.structuredContent.errorCode, 'FRAME_COORDINATE_OUT_OF_BOUNDS');
  assert.equal(invalidPoint.structuredContent.inputNotSent, true);
  const collapsed = await call('preview_action', { ...args(), action: 'swipe', x: 20, y: 20, toX: 20, toY: 20 });
  assert.equal(collapsed.structuredContent.errorCode, 'SWIPE_SAME_DEVICE_POINT');
  assert.equal(collapsed.structuredContent.inputNotSent, true);
  raceNextPause = true;
  check(await call('preview_action', args()), 'sequence_changed', 'after_pause');
  assert.equal(inputs, 0, 'no rejected action may reach the device');
  frame = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId })).structuredContent;
  assert.equal((await call('preview_action', args())).isError, undefined);
  check(await call('preview_action', args()), 'consumed', 'before_pause');
  assert.equal(inputs, 1, 'a consumed frame must not send the same input twice');
  for (const code of ['STALE_PREVIEW_FRAME', 'FRAME_COORDINATE_OUT_OF_BOUNDS', 'DEVICE_COORDINATE_OUT_OF_BOUNDS', 'SWIPE_SAME_DEVICE_POINT']) {
    sendFrame();
    frame = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId,
      afterSeq: frame.seq, waitMs: 2000 })).structuredContent;
    failureCode = code;
    const failed = await call('preview_action', args());
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.errorCode, code);
    assert.equal(failed.structuredContent.inputNotSent, undefined, `${code} from an input adapter cannot prove no input was sent`);
  }
  assert.equal(inputs, 5, 'adapter errors must happen only after the input adapter was invoked');
  console.log('preview stale reasons: ok');
} finally {
  input.end();
  await running;
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

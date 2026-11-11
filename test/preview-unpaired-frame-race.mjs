import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { startMcp } from '../src/mcp.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmony-unpaired-frame-'));
const server = createServer();
const sockets = new WebSocketServer({ server });
let sendUnpaired, sendMeta, sendBinary, sendWrongDevice, sendOrphan, sendInvalid, sendInterrupted, sendInvalidThenValid;
let pendingOnPause = false;
sockets.on('connection', (socket) => {
  const metadata = (frameId) => JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId,
    width: 100, height: 200, deviceWidth: 100, deviceHeight: 200, mimeType: 'image/jpeg' });
  sendMeta = () => {
    socket.send(metadata('pending-frame'));
    socket.send(JSON.stringify({ type: 'preview-status', running: true, pollMs: 123 }));
  };
  sendBinary = () => socket.send(Buffer.from('pending-frame'));
  sendWrongDevice = () => socket.send(JSON.stringify({ type: 'frame-meta', deviceId: 'other', frameId: 'wrong-device' }));
  sendOrphan = () => socket.send(Buffer.from('orphan-frame'));
  sendInvalid = (message) => socket.send(message);
  sendInvalidThenValid = () => {
    socket.send('not-json');
    socket.send(metadata('late-valid-frame'));
    socket.send(Buffer.from('late-valid-frame'));
    socket.send(JSON.stringify({ type: 'preview-status', running: true }));
  };
  sendInterrupted = (paused) => {
    socket.send(metadata('before-interruption'));
    socket.send(JSON.stringify({ type: 'preview-status', running: paused, paused }));
    socket.send(JSON.stringify({ type: 'preview-status', running: true, paused: false }));
    socket.send(metadata('after-interruption'));
    socket.send(Buffer.from('delayed-old-binary'));
    socket.send(Buffer.from('new-binary'));
  };
  sendUnpaired = () => {
    socket.send(metadata('unpaired-one'));
    socket.send(metadata('unpaired-two'));
    socket.send(Buffer.from('unpaired-frame-one'));
    socket.send(Buffer.from('unpaired-frame-two'));
  };
  socket.on('message', (message) => {
    const event = JSON.parse(message.toString());
    if (event.type === 'preview-start') {
      socket.send(JSON.stringify({ type: 'preview-status', running: true }));
      socket.send(metadata('initial-frame'));
      socket.send(Buffer.from('initial-frame'));
    } else if (event.type === 'preview-action-start') {
      if (pendingOnPause) { pendingOnPause = false; socket.send(metadata('during-pause')); }
      socket.send(JSON.stringify({ type: 'preview-action-ready', actionId: event.actionId }));
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const input = new PassThrough(), output = new PassThrough(), pending = new Map();
let id = 0, inputs = 0;
createInterface({ input: output }).on('line', (line) => {
  const response = JSON.parse(line);
  pending.get(response.id)?.(response);
  pending.delete(response.id);
});
const request = (method, params) => {
  const requestId = ++id;
  const reply = new Promise((resolve) => pending.set(requestId, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  return reply;
};
const call = async (name, arguments_) => (await request('tools/call', { name, arguments: arguments_ })).result;
const running = startMcp({ input, output, previewUrl: `http://127.0.0.1:${server.address().port}/`,
  previewStatePath: join(directory, 'preview.json'), autoStartPreview: false, deviceAdapter: {
    listTargets: async () => ['device'], tap: async () => { inputs++; return {}; },
    capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('fallback') })
  } });
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'unpaired-frame-race', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const start = async () => {
    const panel = (await call('preview_start', { deviceId: 'device', subscriber: true })).structuredContent;
    const current = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId })).structuredContent;
    assert.ok(current.frame?.frameId);
    return { panel, current };
  };
  const args = ({ panel, current }) => ({ action: 'tap', deviceId: 'device', sessionId: panel.sessionId,
    subscriberId: panel.subscriberId, seq: current.seq, frameId: current.frame.frameId, x: 20, y: 20 });
  const waitInfo = async (predicate) => {
    const deadline = Date.now() + 2000;
    while (!predicate((await call('preview_info', {})).structuredContent)) {
      assert.ok(Date.now() < deadline, 'expected preview status change');
      await delay(5);
    }
  };
  let active = await start();
  sendMeta();
  await waitInfo((info) => info.pollMs === 123);
  let result = await call('preview_action', args(active));
  assert.equal(result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  assert.equal(result.structuredContent.inputNotSent, true);
  assert.equal(result.structuredContent.staleReason, 'frame_pair_pending');
  assert.equal(result.structuredContent.stalePhase, 'before_pause');
  result = await call('tap', { deviceId: 'device', seq: active.current.seq, frameId: active.current.frame.frameId, x: 20, y: 20 });
  assert.equal(result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME', 'ordinary bound input cannot use an incomplete frame');
  assert.equal(inputs, 0);
  sendBinary();
  const fresh = (await call('preview_frame', { sessionId: active.panel.sessionId, subscriberId: active.panel.subscriberId,
    afterSeq: active.current.seq, waitMs: 2000 })).structuredContent;
  assert.ok(fresh.frame && fresh.seq > active.current.seq, 'a normal completed pair restores interaction');
  active.current = fresh;
  assert.equal((await call('preview_action', args(active))).isError, undefined);
  assert.equal(inputs, 1);
  await call('preview_stop', { sessionId: active.panel.sessionId });
  active = await start();
  pendingOnPause = true;
  result = await call('preview_action', args(active));
  assert.equal(result.structuredContent.inputNotSent, true);
  assert.equal(result.structuredContent.staleReason, 'frame_pair_pending');
  assert.equal(result.structuredContent.stalePhase, 'after_pause');
  assert.equal(inputs, 1, 'an incomplete pair at the pause acknowledgment cannot reach the device');
  await waitInfo((info) => !info.connected);
  for (const makeAmbiguous of [() => sendUnpaired(), () => sendOrphan(), () => sendWrongDevice(),
    () => sendInvalid('not-json'), () => sendInvalid('null'), () => sendInvalid('[]'), () => sendInvalid('{}'),
    () => sendInterrupted(false), () => sendInterrupted(true), () => sendInvalidThenValid()]) {
    active = await start();
    makeAmbiguous();
    await waitInfo((info) => !info.connected);
    result = await call('preview_action', args(active));
    assert.equal(result.isError, true, 'ambiguous frame ordering must close the old session');
    assert.equal(inputs, 1, 'an ambiguous frame cannot reach device input');
  }
  active = await start();
  assert.equal((await call('preview_action', args(active))).isError, undefined, 'starting a new session must recover');
  assert.equal(inputs, 2);
  console.log('preview unpaired frame race: ok');
} finally {
  input.end();
  await running;
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';
import { startMcp } from '../src/mcp.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmony-preview-ack-'));
const server = createServer();
const sockets = new WebSocketServer({ server });
let connections = 0;
let silentConnection = 2;
let reachedReplacement;
let replacementPause = new Promise((resolve) => { reachedReplacement = resolve; });
sockets.on('connection', (socket) => {
  const connection = ++connections;
  let sequence = 0;
  const frame = () => {
    socket.send(JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId: `${connection}-${++sequence}`,
      width: 100, height: 200, deviceWidth: 100, deviceHeight: 200, mimeType: 'image/jpeg' }));
    socket.send(Buffer.from('frame'));
  };
  socket.on('message', (data) => {
    const event = JSON.parse(data.toString());
    if (event.type === 'preview-start') {
      socket.send(JSON.stringify({ type: 'preview-status', running: true }));
      frame();
    } else if (event.type === 'preview-action-start') {
      if (connection === silentConnection) reachedReplacement();
      else socket.send(JSON.stringify({ type: 'preview-action-ready', actionId: event.actionId }));
    } else if (event.type === 'preview-refresh') frame();
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
const call = (name, args) => request('tools/call', { name, arguments: args });
let inputs = 0;
let started;
const inputStarted = new Promise((resolve) => { started = resolve; });
let release;
let blockedInput = new Promise((resolve) => { release = resolve; });
const running = startMcp({ input, output, previewUrl: `http://127.0.0.1:${server.address().port}/`,
  previewStatePath: join(directory, 'state.json'), deviceAdapter: {
    listTargets: async () => ['device'],
    capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('fallback') }),
    tap: async () => { inputs++; if (blockedInput) { started(); await blockedInput; } return {}; }
  } });
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'replacement-ack', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const first = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  const frame = (await call('preview_frame', { sessionId: first.sessionId, subscriberId: first.subscriberId })).result.structuredContent;
  const action = call('preview_action', { action: 'tap', deviceId: 'device', sessionId: first.sessionId,
    subscriberId: first.subscriberId, seq: frame.seq, frameId: frame.frame.frameId, x: 20, y: 20 });
  await inputStarted;
  await call('preview_stop', { sessionId: first.sessionId });
  const second = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  const oldFrame = (await call('preview_frame', { sessionId: second.sessionId, subscriberId: second.subscriberId })).result.structuredContent;
  const queued = call('preview_action', { action: 'tap', deviceId: 'device', sessionId: second.sessionId,
    subscriberId: second.subscriberId, seq: oldFrame.seq, frameId: oldFrame.frame.frameId, x: 20, y: 20 });
  release();
  blockedInput = undefined;
  await replacementPause;
  assert.equal((await action).result.isError, undefined, 'the completed input remains successful when the replacement does not acknowledge');
  assert.equal((await queued).result.isError, true, 'an unacknowledged replacement session must reject its frame');
  assert.equal(inputs, 1, 'a replacement without pause acknowledgment must not accept an input');
  const third = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  assert.notEqual(third.sessionId, second.sessionId, 'the unacknowledged session must be discarded');
  const fresh = (await call('preview_frame', { sessionId: third.sessionId, subscriberId: third.subscriberId })).result.structuredContent;
  assert.equal((await call('preview_action', { action: 'tap', deviceId: 'device', sessionId: third.sessionId,
    subscriberId: third.subscriberId, seq: fresh.seq, frameId: fresh.frame.frameId, x: 20, y: 20 })).result.isError, undefined);
  assert.equal(inputs, 2, 'a new session must recover after the unacknowledged one is closed');

  const beforeNext = (await call('preview_frame', { sessionId: third.sessionId, subscriberId: third.subscriberId,
    afterSeq: fresh.seq, waitMs: 2000 })).result.structuredContent;
  assert.ok(beforeNext.frame);
  let nextInputEntered;
  const nextInputStarted = new Promise((resolve) => { nextInputEntered = resolve; });
  started = nextInputEntered;
  blockedInput = new Promise((resolve) => { release = resolve; });
  const nextAction = call('preview_action', { action: 'tap', deviceId: 'device', sessionId: third.sessionId,
    subscriberId: third.subscriberId, seq: beforeNext.seq, frameId: beforeNext.frame.frameId, x: 20, y: 20 });
  await nextInputStarted;
  await call('preview_stop', { sessionId: third.sessionId });
  silentConnection = 4;
  replacementPause = new Promise((resolve) => { reachedReplacement = resolve; });
  const fourth = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  const fourthFrame = (await call('preview_frame', { sessionId: fourth.sessionId, subscriberId: fourth.subscriberId })).result.structuredContent;
  release();
  blockedInput = undefined;
  await replacementPause;
  const fourthAction = call('preview_action', { action: 'tap', deviceId: 'device', sessionId: fourth.sessionId,
    subscriberId: fourth.subscriberId, seq: fourthFrame.seq, frameId: fourthFrame.frame.frameId, x: 20, y: 20 });
  assert.equal((await call('preview_stop', { sessionId: fourth.sessionId })).result.isError, undefined,
    'stopping the replacement must remain responsive while its acknowledgment is pending');
  const fifth = (await call('preview_start', { deviceId: 'device', subscriber: true })).result.structuredContent;
  assert.equal((await nextAction).result.isError, undefined);
  assert.equal((await fourthAction).result.isError, true, 'the stopped replacement must reject queued input');
  const fifthFrame = (await call('preview_frame', { sessionId: fifth.sessionId, subscriberId: fifth.subscriberId })).result.structuredContent;
  assert.equal((await call('preview_action', { action: 'tap', deviceId: 'device', sessionId: fifth.sessionId,
    subscriberId: fifth.subscriberId, seq: fifthFrame.seq, frameId: fifthFrame.frame.frameId, x: 20, y: 20 })).result.isError, undefined);
  assert.equal(inputs, 4, 'the replacement after a pending stop must remain usable');
  console.log('preview replacement acknowledgment: ok');
} finally {
  release();
  input.end();
  await running;
  for (const socket of sockets.clients) socket.terminate();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

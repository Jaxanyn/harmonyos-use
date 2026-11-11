import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { startMcp } from '../src/mcp.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmony-frame-pair-'));
const server = createServer();
const sockets = new WebSocketServer({ server });
let peer;
sockets.on('connection', (socket) => {
  peer = socket;
  socket.on('message', (message) => {
    if (JSON.parse(message).type !== 'preview-start') return;
    socket.send(JSON.stringify({ type: 'preview-status', running: true, deviceId: 'device' }));
    socket.send(JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId: 'A', mimeType: 'image/jpeg', width: 10, height: 20, capturedAt: 'time-A' }));
    socket.send(Buffer.from('image-A'));
    socket.send(JSON.stringify({ type: 'preview-tick', changed: true, metrics: { capturedAt: 'time-A', captureMs: 100 } }));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const input = new PassThrough();
const output = new PassThrough();
const replies = createInterface({ input: output })[Symbol.asyncIterator]();
let requestId = 0;
const running = startMcp({ input, output, previewUrl: `http://127.0.0.1:${server.address().port}/`,
  previewStatePath: join(directory, 'state.json'), deviceAdapter: { listTargets: async () => ['device'] } });
async function request(method, params) {
  const id = ++requestId;
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const reply = JSON.parse((await replies.next()).value);
  assert.equal(reply.id, id);
  return reply;
}
const call = (name, args) => request('tools/call', { name, arguments: args });
const readFrame = async (afterSeq = 0, waitMs = 0) => (await call('preview_frame', { afterSeq, waitMs })).result.structuredContent;
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'frame-pair-test', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await call('preview_start', { deviceId: 'device' });
  const initial = await readFrame();
  assert.equal(initial.frame.frameId, 'A');

  peer.send(JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId: 'B', mimeType: 'image/jpeg', width: 99, height: 199,
    capturedAt: 'time-B', metrics: { capturedAt: 'time-B', captureMs: 200 } }));
  await delay(50);
  const during = await readFrame();
  assert.equal(during.frame.frameId, 'A', 'pending metadata must not be paired with the previous image');
  assert.equal(Buffer.from(during.frame.data, 'base64').toString(), 'image-A');
  assert.equal(during.frame.width, 10);
  assert.equal(during.metrics?.capturedAt, 'time-A');
  assert.equal(during.metrics?.captureMs, 100, 'legacy tick metrics are used when their capture time matches');

  peer.send(Buffer.from('image-B'));
  const next = await readFrame(initial.seq, 1000);
  assert.equal(next.frame.frameId, 'B');
  assert.equal(Buffer.from(next.frame.data, 'base64').toString(), 'image-B');
  assert.equal(next.frame.width, 99);
  assert.equal(next.metrics?.capturedAt, 'time-B', 'metrics must be available atomically with their frame');
  assert.equal(next.metrics?.captureMs, 200);

  peer.send(JSON.stringify({ type: 'preview-tick', changed: true, metrics: { capturedAt: 'time-A', captureMs: 100 } }));
  await delay(50);
  assert.equal((await readFrame()).metrics?.captureMs, 200, 'late metrics must not replace the current frame metrics');

  peer.send(JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId: 'E', mimeType: 'image/jpeg',
    capturedAt: 'time-E', width: 20, height: 10, deviceWidth: 200, deviceHeight: 100, rotation: 90, orientationChanged: true }));
  peer.send(Buffer.from('image-E'));
  const rotated = await readFrame(next.seq, 1000);
  assert.equal(rotated.frame.frameId, 'E');
  assert.equal(rotated.metrics.rotation, 90, 'legacy frame metadata must preserve rotation without a metrics tick');
  assert.equal(rotated.metrics.orientationChanged, true);
  assert.equal(rotated.metrics.deviceWidth, 200);

  peer.send(JSON.stringify({ type: 'preview-tick', changed: true, metrics: { capturedAt: 'time-E', rotation: 0, deviceWidth: 100 } }));
  await delay(50);
  const authoritative = await readFrame();
  assert.equal(authoritative.metrics.rotation, 90, 'frame geometry must override inconsistent tick metrics');
  assert.equal(authoritative.metrics.deviceWidth, 200);

  const waitClosed = async () => {
    const deadline = Date.now() + 2000;
    while (peer.readyState === 1 || (await call('preview_info', {})).result.structuredContent.connected) {
      assert.ok(Date.now() < deadline, 'ambiguous frame ordering must close the preview');
      await delay(5);
    }
    const frame = await readFrame();
    assert.equal(frame.connected, false);
    assert.equal(frame.frame, null, 'an ambiguous image must not remain available for input');
  };
  const restart = async () => {
    const restarted = (await call('preview_start', { deviceId: 'device' })).result.structuredContent;
    assert.equal(restarted.connected, true);
    assert.equal((await readFrame()).frame.frameId, 'A', 'a new session must recover on a valid frame pair');
  };
  peer.send(Buffer.from('orphan-image'));
  await waitClosed();
  await restart();

  peer.send(JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId: 'C', capturedAt: 'time-C' }));
  peer.send(JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId: 'D', capturedAt: 'time-D' }));
  peer.send(Buffer.from('image-C'));
  await waitClosed();
  await restart();

  peer.send(JSON.stringify({ type: 'frame-meta', deviceId: 'device', frameId: 'F', capturedAt: 'time-F' }));
  peer.send(JSON.stringify({ type: 'preview-status', running: false, deviceId: 'device' }));
  peer.send(Buffer.from('image-F'));
  await waitClosed();
  await restart();
  console.log('preview frame pair: ok');
} finally {
  input.end();
  await running;
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await rm(join(directory, 'state.json'), { force: true });
  await rmdir(directory);
}

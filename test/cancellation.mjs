import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceAdapter, runCommand } from '../src/device.mjs';
import { startMcp } from '../src/mcp.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-cancel-'));
try {
  const calls = [];
  const adapter = createDeviceAdapter({ directory, timeoutMs: 5000, runtime: async (_command, args, options) => {
    calls.push({ args, options });
    if (args.includes('snapshot_display')) {
      return new Promise(() => {});
    }
    return { code: 0, stdout: '', stderr: '' };
  } });
  const controller = new AbortController();
  const capture = adapter.capture({ deviceId: 'test-device' }, { signal: controller.signal });
  while (!calls.some(({ args }) => args.includes('snapshot_display'))) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(capture, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  assert.equal(calls[0].options.signal, controller.signal, 'HDC receives the request cancellation signal');

  const childController = new AbortController();
  const child = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 10000, signal: childController.signal });
  setTimeout(() => childController.abort(), 25);
  await assert.rejects(child, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');

  const input = new PassThrough();
  const output = new PassThrough();
  const responses = createInterface({ input: output })[Symbol.asyncIterator]();
  let waitStarted;
  const waitReady = new Promise((resolve) => { waitStarted = resolve; });
  let tapCount = 0;
  let tapStarted;
  const tapReady = new Promise((resolve) => { tapStarted = resolve; });
  let releaseTap;
  const mcp = startMcp({ input, output, port: 0, projectPath: '', deviceAdapter: {
    capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('unchanged-preview') }),
    waitFor: async (_args, { signal } = {}) => new Promise((resolve, reject) => {
      waitStarted();
      const onAbort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      signal?.aborted && onAbort();
    }),
    tap: async (args) => {
      tapCount += 1;
      if (tapCount === 1) { tapStarted(); await new Promise((resolve) => { releaseTap = resolve; }); }
      return args;
    }
  } });
  let id = 0;
  const send = (method, params) => {
    const requestId = ++id;
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    return requestId;
  };
  const sendNotification = (method, params) => input.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const receive = async () => JSON.parse((await responses.next()).value);
  try {
    assert.equal((await (send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }), receive())).id, 1);
    sendNotification('notifications/initialized');
    const waitId = send('tools/call', { name: 'wait_for', arguments: { deviceId: 'test-device', selector: { id: 'loading' }, timeoutMs: 30000 } });
    await waitReady;
    const pingId = send('ping');
    assert.equal((await receive()).id, pingId, 'a short request completes while wait_for is running');
    sendNotification('$/cancelRequest', { requestId: waitId });
    const cancelled = await receive();
    assert.equal(cancelled.id, waitId);
    assert.equal(cancelled.error.code, -32800);
    const firstTapId = send('tools/call', { name: 'tap', arguments: { deviceId: 'test-device', x: 1, y: 2 } });
    await tapReady;
    const secondTapId = send('tools/call', { name: 'tap', arguments: { deviceId: 'test-device', x: 3, y: 4 } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tapCount, 1, 'mutating calls for one device are queued');
    releaseTap();
    assert.equal((await receive()).id, firstTapId);
    assert.equal((await receive()).id, secondTapId);
    assert.equal(tapCount, 2);
    const previewStartId = send('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
    assert.equal((await receive()).id, previewStartId);
    send('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } });
    const frame = (await receive()).result.structuredContent;
    const frameWaitId = send('tools/call', { name: 'preview_frame', arguments: { afterSeq: frame.seq, waitMs: 800 } });
    const framePingId = send('ping');
    assert.equal((await receive()).id, framePingId, 'frame waiting must not block other requests');
    sendNotification('$/cancelRequest', { requestId: frameWaitId });
    const cancelledFrame = await receive();
    assert.equal(cancelledFrame.id, frameWaitId);
    assert.equal(cancelledFrame.error?.code, -32800, 'ordinary frame waiting must honor request cancellation');
    const closingFrameId = send('tools/call', { name: 'preview_frame', arguments: { afterSeq: frame.seq, waitMs: 5000 } });
    const closingPingId = send('ping');
    assert.equal((await receive()).id, closingPingId);
    input.end();
    const closingFrame = await receive();
    assert.equal(closingFrame.id, closingFrameId);
    assert.equal(closingFrame.error?.code, -32800, 'closing the MCP connection must cancel and clean up frame waiting');
  } finally {
    input.end();
    await mcp;
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('cancellation: ok');

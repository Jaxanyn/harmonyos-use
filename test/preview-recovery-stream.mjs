import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { startMcp } from '../src/mcp.mjs';

for (const hasSnapshot of [true, false]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const pending = new Map();
  createInterface({ input: output }).on('line', (line) => {
    const reply = JSON.parse(line);
    pending.get(reply.id)?.(reply);
    pending.delete(reply.id);
  });
  let id = 0;
  function request(method, params) {
    const requestId = ++id;
    const result = new Promise((resolve) => pending.set(requestId, resolve));
    input.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
    return result;
  }
  const call = (name, args) => request('tools/call', { name, arguments: args });
  let snapshots = 0;
  let streamReads = 0;
  const adapter = {
    listTargets: async () => ['device'],
    openFrameStream: async () => ({
      nextFrame: async () => { streamReads++; return { mimeType: 'image/jpeg', data: Buffer.from('buffered-old-frame') }; }
    }),
    ...(hasSnapshot ? { capture: async () => { snapshots++; return { mimeType: 'image/jpeg', data: Buffer.from('fresh-snapshot') }; } } : {})
  };
  const running = startMcp({ input, output, port: 0, deviceAdapter: adapter });
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stream-recovery-test', version: '1' } });
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const sessionId = (await call('preview_start', { deviceId: 'device' })).result.structuredContent.sessionId;
    const first = (await call('preview_frame', { afterSeq: 0 })).result.structuredContent;
    assert.equal(Buffer.from(first.frame.data, 'base64').toString(), 'buffered-old-frame');
    assert.equal(snapshots, 0, 'ordinary streaming must not switch to snapshots');
    const recovered = await call('preview_frame', { forceRefresh: true, afterSeq: first.seq, waitMs: 1000, deviceId: 'device', sessionId });
    if (hasSnapshot) {
      assert.equal(Buffer.from(recovered.result.structuredContent.frame.data, 'base64').toString(), 'fresh-snapshot');
      assert.equal(snapshots, 1, 'a forced refresh must make a new snapshot');
    } else {
      assert.ok(recovered.error || recovered.result.isError || !recovered.result.structuredContent.frame,
        'a stream-only adapter cannot use a buffered frame as a fresh snapshot');
    }
    assert.ok(streamReads > 0);
  } finally {
    input.end();
    await running;
  }
}
console.log('preview recovery stream: ok');

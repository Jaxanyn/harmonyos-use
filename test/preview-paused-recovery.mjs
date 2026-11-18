import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { startMcp } from '../src/mcp.mjs';

const input = new PassThrough();
const output = new PassThrough();
const pending = new Map();
let nextId = 0;
let captures = 0;
let inputs = 0;
createInterface({ input: output }).on('line', (line) => {
  const reply = JSON.parse(line);
  pending.get(reply.id)?.(reply);
  pending.delete(reply.id);
});
function request(method, params) {
  const id = ++nextId;
  const result = new Promise((resolve) => pending.set(id, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return result;
}
const call = (name, args = {}) => request('tools/call', { name, arguments: args });
const running = startMcp({ input, output, port: 0, projectPath: '', frameLeaseMs: 150, subscriptionLeaseMs: 10000,
  deviceAdapter: {
    listTargets: async () => ['test-device'],
    capture: async () => {
      await delay(250);
      return { mimeType: 'image/jpeg', data: Buffer.from(`frame-${++captures}`),
        frameId: `frame-${captures}`, width: 100, height: 200, deviceWidth: 100, deviceHeight: 200 };
    },
    tap: async () => { inputs += 1; },
    swipe: async () => { inputs += 1; },
    keyEvent: async () => { inputs += 1; },
  }
});

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'paused-recovery-test', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const started = (await call('preview_start', { deviceId: 'test-device', subscriber: true })).result.structuredContent;
  const bound = { deviceId: 'test-device', sessionId: started.sessionId, subscriberId: started.subscriberId };
  const first = (await call('preview_frame', { ...bound, afterSeq: 0 })).result.structuredContent;
  assert.ok(first.frame);

  // A short lease models the default five-second idle pause without making the test slow.
  await delay(350);
  assert.equal((await call('preview_info')).result.structuredContent.paused, true);
  const failed = (await call('preview_frame', { ...bound, forceRefresh: true, afterSeq: first.seq, waitMs: 1000 })).result;
  assert.equal(failed.isError, true, 'a forced refresh cannot resume a paused capture');
  assert.equal(failed.structuredContent.errorCode, 'PREVIEW_UNAVAILABLE');
  assert.equal(failed.structuredContent.stage, 'preview_frame');

  const resumed = (await call('preview_frame', { ...bound, afterSeq: first.seq, waitMs: 1000 })).result.structuredContent;
  assert.equal(resumed.sessionId, started.sessionId);
  assert.equal(resumed.deviceId, 'test-device');
  assert.ok(resumed.frame && resumed.seq > first.seq, 'ordinary reading resumes capture on the same subscription');

  const fresh = (await call('preview_frame', { ...bound, forceRefresh: true, afterSeq: resumed.seq, waitMs: 1000 })).result.structuredContent;
  assert.equal(fresh.sessionId, started.sessionId);
  assert.equal(fresh.deviceId, 'test-device');
  assert.ok(fresh.frame && fresh.seq > resumed.seq, 'recovery must establish a new frame after resuming');
  assert.equal(inputs, 0, 'recovery must not send device input');
  await call('preview_stop', { sessionId: started.sessionId, subscriberId: started.subscriberId });
  console.log('paused preview recovery: ok');
} finally {
  input.end();
  await running;
}

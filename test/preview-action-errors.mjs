import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { startMcp } from '../src/mcp.mjs';
import { tagError } from '../src/diagnostics.mjs';

const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output })[Symbol.asyncIterator]();
let requestId = 0;
let fallbackCaptures = 0;
let keyInputs = 0;
const running = startMcp({ input, output, port: 0, deviceAdapter: {
  listTargets: async () => ['device'],
  capture: async (_options, callOptions) => {
    if (callOptions?.timeoutMs === 3000) fallbackCaptures += 1;
    return { mimeType: 'image/jpeg', data: Buffer.from('frame') };
  },
  keyEvent: async () => {
    keyInputs += 1;
    throw tagError(new Error('input result unknown'), 'ACTION_FAILED', 'key_event');
  },
  tap: async () => { throw tagError(new Error('tap result unknown'), 'ACTION_FAILED', 'tap'); }
} });

async function request(method, params) {
  const id = ++requestId;
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  const response = JSON.parse((await responses.next()).value);
  assert.equal(response.id, id);
  return response;
}
const call = (name, args) => request('tools/call', { name, arguments: args });

try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'preview-action-errors', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const session = (await call('preview_start', { deviceId: 'device' })).result.structuredContent.sessionId;
  const frame = (await call('preview_frame', { afterSeq: 0 })).result.structuredContent;
  const binding = { action: 'back', deviceId: 'device', sessionId: session, frameId: frame.frame.frameId };

  const stale = (await call('preview_action', { ...binding, seq: frame.seq - 1 })).result;
  assert.equal(stale.isError, true);
  assert.equal(stale.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  assert.equal(keyInputs, 0, 'a preflight rejection must not send input');
  assert.equal(fallbackCaptures, 0, 'an app-only preflight rejection must not wait for a new screenshot');

  const unknown = (await call('preview_action', { ...binding, seq: frame.seq })).result;
  assert.equal(unknown.isError, true);
  assert.equal(unknown.structuredContent.errorCode, 'ACTION_FAILED');
  assert.equal(keyInputs, 1, 'an uncertain input must not be retried');
  assert.equal(fallbackCaptures, 1, 'an uncertain input must retain screenshot fallback');
  assert.equal(unknown.structuredContent.screenshotFallback, true);

  const modelTap = (await call('tap', { deviceId: 'device', x: 1, y: 1 })).result;
  assert.equal(modelTap.isError, true);
  assert.equal(fallbackCaptures, 2, 'model-facing action failures must retain screenshot fallback');
  assert.equal(modelTap.structuredContent.screenshotFallback, true);
  console.log('preview action errors: ok');
} finally {
  input.end();
  await running;
}

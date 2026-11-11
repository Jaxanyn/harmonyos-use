import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const project = await mkdtemp(join(tmpdir(), 'harmony-server-input-'));
await mkdir(join(project, 'AppScope'));
await mkdir(join(project, 'entry', 'src', 'main'), { recursive: true });
await mkdir(join(project, 'entry', 'build'), { recursive: true });
await writeFile(join(project, 'AppScope', 'app.json5'), '{"app":{"bundleName":"com.example.test"}}');
await writeFile(join(project, 'entry', 'src', 'main', 'module.json5'), '{"module":{"mainElement":"EntryAbility"}}');
await writeFile(join(project, 'entry', 'build', 'test.hap'), 'mock artifact');
await writeFile(join(project, 'build-local.ps1'), 'exit 0');
process.env.HARMONY_PROJECT = project;
const { startMcp } = await import('../src/mcp.mjs');

const input = new PassThrough();
const output = new PassThrough();
const pending = new Map();
let nextId = 0;
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
const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
let blockFrames = false;
const waitingFrames = new Set();
let captureId = 0;
let inputs = [];
let nextBlock;
function blockNextInput({ fail = false } = {}) {
  let started, release;
  const entered = new Promise((resolve) => { started = resolve; });
  const resume = new Promise((resolve) => { release = resolve; });
  nextBlock = { started, resume, fail };
  return { entered, release };
}
function unblockFrames() {
  blockFrames = false;
  for (const release of waitingFrames) release();
  waitingFrames.clear();
}
const runInput = (kind) => async (args) => {
  inputs.push(kind);
  const blocked = nextBlock;
  if (blocked) {
    nextBlock = undefined;
    blocked.started();
    await blocked.resume;
    if (blocked.fail) throw new Error('simulated input result unknown');
  }
  return { deviceId: args.deviceId };
};
const running = startMcp({ input, output, port: 0, previewUrl: '', autoStartPreview: false, deviceAdapter: {
  listTargets: async () => ['device'],
  capture: async (_args, options) => {
    if (blockFrames && options?.timeoutMs !== 3000) await new Promise((resolve) => waitingFrames.add(resolve));
    return { mimeType: 'image/jpeg', data: Buffer.from(`frame-${++captureId}`), width: 100, height: 200, deviceWidth: 100, deviceHeight: 200 };
  },
  tap: runInput('tap'), swipe: runInput('swipe'), install: async () => ({}), launch: runInput('launch')
} });
let socket;
try {
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'server-mcp-input-races', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const panel = (await call('preview_start', { deviceId: 'device', subscriber: true })).structuredContent;
  const info = (await call('preview_info', {})).structuredContent;
  const serverUrl = info.serverUrl;
  assert.match(serverUrl, /^http:\/\/127\.0\.0\.1:/);
  socket = new WebSocket(serverUrl.replace('http:', 'ws:') + 'preview');
  await once(socket, 'open');
  function socketReply(actionId) {
    return new Promise((resolve, reject) => {
      const onMessage = (bytes, binary) => {
        if (binary) return;
        const msg = JSON.parse(bytes.toString());
        if (msg.actionId !== actionId) return;
        socket.off('message', onMessage);
        resolve(msg);
      };
      socket.on('message', onMessage);
      socket.once('error', reject);
    });
  }
  async function currentFrame(afterSeq = 0) {
    const result = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId,
      afterSeq, ...(afterSeq ? { waitMs: 2000 } : {}) })).structuredContent;
    assert.ok(result.frame && (!afterSeq || result.seq > afterSeq), 'a current preview frame must be available');
    return result;
  }
  let frame = await currentFrame();
  const previewTap = (sample) => call('preview_action', { action: 'tap', deviceId: 'device',
    sessionId: panel.sessionId, subscriberId: panel.subscriberId, seq: sample.seq,
    frameId: sample.frame.frameId, x: 20, y: 20 });
  async function scenario(kind, fail = false) {
    blockFrames = true;
    const blocked = blockNextInput({ fail });
    let serverResult;
    if (kind === 'http') {
      serverResult = fetch(serverUrl + 'api/tap', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device', x: 20, y: 20 }) });
    } else {
      serverResult = socketReply('blocked-swipe');
      socket.send(JSON.stringify({ type: 'swipe', actionId: 'blocked-swipe', deviceId: 'device',
        fromX: 10, fromY: 20, toX: 30, toY: 20, velocity: 600 }));
    }
    await blocked.entered;
    frame = await currentFrame();
    const before = inputs.length;
    const queued = previewTap(frame);
    await delay(25);
    assert.equal(inputs.length, before, 'the MCP input must wait for the external input to finish');
    blocked.release();
    const response = await serverResult;
    if (kind === 'http') assert.equal(response.status, fail ? 400 : 200);
    else assert.equal(response.type, fail ? 'error' : 'swipe-ack');
    const rejected = await queued;
    assert.equal(rejected.isError, true, 'the old frame must not be accepted after the external input');
    assert.equal(rejected.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
    assert.equal(inputs.length, before, 'the stale queued action must never reach the device');
    unblockFrames();
    const fresh = await currentFrame(frame.seq);
    const accepted = await previewTap(fresh);
    assert.equal(accepted.isError, undefined, 'a post-input frame must restore preview actions');
    frame = await currentFrame(fresh.seq);
  }
  await scenario('http');
  await scenario('http', true);
  await scenario('ws');
  await scenario('ws', true);

  // The reverse arrival order must also serialize, without losing the
  // external action or allowing its old frame to be used afterward.
  blockFrames = true;
  const blockedPreview = blockNextInput();
  const previewFirst = previewTap(frame);
  await blockedPreview.entered;
  const beforeExternal = inputs.length;
  const externalSecond = fetch(serverUrl + 'api/tap', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device', x: 20, y: 20 }) });
  await delay(25);
  assert.equal(inputs.length, beforeExternal, 'external input must wait for an in-progress MCP input');
  blockedPreview.release();
  assert.equal((await previewFirst).isError, undefined);
  assert.equal((await externalSecond).status, 200, 'queued external input must eventually be executed');
  assert.equal(inputs.length, beforeExternal + 1, 'only the queued external input should execute');
  const afterBoth = await previewTap(frame);
  assert.equal(afterBoth.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  unblockFrames();
  const recovered = await currentFrame(frame.seq);
  assert.equal((await previewTap(recovered)).isError, undefined, 'a new frame must recover after both inputs');
  frame = await currentFrame(recovered.seq);

  blockFrames = true;
  const blockedForWs = blockNextInput();
  const previewBeforeWs = previewTap(frame);
  await blockedForWs.entered;
  const beforeWs = inputs.length;
  const wsAfter = socketReply('queued-swipe');
  socket.send(JSON.stringify({ type: 'swipe', actionId: 'queued-swipe', deviceId: 'device',
    fromX: 10, fromY: 20, toX: 30, toY: 20, velocity: 600 }));
  await delay(25);
  assert.equal(inputs.length, beforeWs, 'WS input must wait for an in-progress MCP input');
  blockedForWs.release();
  assert.equal((await previewBeforeWs).isError, undefined);
  assert.equal((await wsAfter).type, 'swipe-ack');
  assert.equal(inputs.length, beforeWs + 1);
  assert.equal((await previewTap(frame)).structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  unblockFrames();
  frame = await currentFrame(frame.seq);

  const blockedForOtherDevice = blockNextInput();
  const previewBeforeOther = previewTap(frame);
  await blockedForOtherDevice.entered;
  const otherDevice = fetch(serverUrl + 'api/tap', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'other', x: 20, y: 20 }) });
  try {
    const otherResponse = await Promise.race([otherDevice, delay(2000).then(() => { throw new Error('other device was blocked'); })]);
    assert.equal(otherResponse.status, 200, 'other devices must not be serialized behind the first device');
  } finally { blockedForOtherDevice.release(); }
  assert.equal((await previewBeforeOther).isError, undefined);
  frame = await currentFrame(frame.seq);

  // Installation can change the device even if the later launch fails.
  blockFrames = true;
  const blockedLaunch = blockNextInput({ fail: true });
  const buildFailure = new Promise((resolve) => {
    const onMessage = (bytes, binary) => {
      if (binary) return;
      const msg = JSON.parse(bytes.toString());
      if (msg.type !== 'error' || msg.stage !== 'launch') return;
      socket.off('message', onMessage);
      resolve(msg);
    };
    socket.on('message', onMessage);
  });
  socket.send(JSON.stringify({ type: 'build-run', deviceId: 'device' }));
  await blockedLaunch.entered;
  const duringBuild = await currentFrame();
  const beforeBuildTap = inputs.length;
  const queuedDuringBuild = previewTap(duringBuild);
  await delay(25);
  assert.equal(inputs.length, beforeBuildTap, 'MCP input must wait for WS build and launch');
  blockedLaunch.release();
  assert.equal((await buildFailure).stage, 'launch');
  assert.equal((await queuedDuringBuild).structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  assert.equal(inputs.length, beforeBuildTap, 'failed launch must not allow old-frame input');
  unblockFrames();
  const freshAfterBuild = await currentFrame(duringBuild.seq);
  assert.equal((await previewTap(freshAfterBuild)).isError, undefined, 'a post-launch frame must recover');

  frame = await currentFrame(freshAfterBuild.seq);
  const blockedForClosedHttp = blockNextInput();
  const previewBeforeClosedHttp = previewTap(frame);
  await blockedForClosedHttp.entered;
  const beforeClosedHttp = inputs.length;
  const httpAbort = new AbortController();
  const closingHttp = fetch(serverUrl + 'api/tap', { method: 'POST', signal: httpAbort.signal,
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'device', x: 20, y: 20 }) }).catch((error) => error);
  try {
    await delay(100); // Allow the local server to enqueue the request behind the held device lock.
    httpAbort.abort();
    await closingHttp;
    await delay(50);
  } finally { blockedForClosedHttp.release(); }
  assert.equal((await previewBeforeClosedHttp).isError, undefined);
  await delay(100);
  assert.equal(inputs.length, beforeClosedHttp, 'a disconnected queued HTTP request must not later send input');
  frame = await currentFrame(frame.seq);

  const blockedForClosedWs = blockNextInput();
  const previewBeforeClosedWs = previewTap(frame);
  await blockedForClosedWs.entered;
  const beforeClosedWs = inputs.length;
  const leaving = new WebSocket(serverUrl.replace('http:', 'ws:') + 'preview');
  await once(leaving, 'open');
  const listReply = new Promise((resolve) => {
    const onMessage = (bytes, binary) => {
      if (binary) return;
      const msg = JSON.parse(bytes.toString());
      if (msg.type !== 'devices') return;
      leaving.off('message', onMessage);
      resolve();
    };
    leaving.on('message', onMessage);
  });
  try {
    leaving.send(JSON.stringify({ type: 'swipe', actionId: 'closed-swipe', deviceId: 'device',
      fromX: 10, fromY: 20, toX: 30, toY: 20, velocity: 600 }));
    leaving.send(JSON.stringify({ type: 'device-list' }));
    await listReply; // Ordered messages prove the swipe reached the server while the lock was held.
    leaving.close();
    await once(leaving, 'close');
    await delay(25);
  } finally { leaving.terminate(); blockedForClosedWs.release(); }
  assert.equal((await previewBeforeClosedWs).isError, undefined);
  await delay(100);
  assert.equal(inputs.length, beforeClosedWs, 'a disconnected queued WS request must not later send input');
  console.log('server MCP input races: ok');
} finally {
  unblockFrames();
  socket?.terminate();
  input.end();
  await running;
  await rm(project, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

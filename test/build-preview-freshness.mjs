import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { startMcp } from '../src/mcp.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-build-frame-'));
let running;
const input = new PassThrough();
const output = new PassThrough();
const pending = new Map();
let nextId = 0;
createInterface({ input: output }).on('line', (line) => {
  const response = JSON.parse(line);
  pending.get(response.id)?.(response);
  pending.delete(response.id);
});
function request(method, params) {
  const id = ++nextId;
  const reply = new Promise((resolve) => pending.set(id, resolve));
  input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return reply;
}
const call = async (name, args) => (await request('tools/call', { name, arguments: args })).result;
let blockFrames = false;
let releaseFrame;
let releaseLaunch;
let launchEntered;
let failLaunch = false;
let taps = 0;
let installs = 0;
let launches = 0;

try {
  await mkdir(join(directory, 'AppScope'));
  await mkdir(join(directory, 'entry', 'src', 'main'), { recursive: true });
  await mkdir(join(directory, 'entry', 'build'), { recursive: true });
  await writeFile(join(directory, 'AppScope', 'app.json5'), '{"app":{"bundleName":"com.example.test"}}');
  await writeFile(join(directory, 'entry', 'src', 'main', 'module.json5'), '{"module":{"mainElement":"EntryAbility"}}');
  await writeFile(join(directory, 'entry', 'build', 'test.hap'), 'test artifact');
  await writeFile(join(directory, 'build-local.ps1'), 'exit 0');
  running = startMcp({ input, output, port: 0, previewUrl: null, autoStartPreview: false, projectPath: directory, deviceAdapter: {
    listTargets: async () => ['device'],
    capture: async (_args, options) => {
      if (blockFrames && options?.timeoutMs !== 3000) await new Promise((resolve) => { releaseFrame = resolve; });
      return { mimeType: 'image/jpeg', data: Buffer.from('constant frame'), width: 100, height: 200, deviceWidth: 100, deviceHeight: 200 };
    },
    tap: async () => { taps++; return { ok: true }; },
    install: async () => { installs++; },
    launch: async () => {
      launches++;
      await new Promise((resolve) => { releaseLaunch = resolve; launchEntered(); });
      if (failLaunch) throw new Error('launch result unknown');
    }
  } });
  await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'build-preview-freshness', version: '1' } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const panel = (await call('preview_start', { deviceId: 'device', subscriber: true })).structuredContent;
  let current = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId })).structuredContent;
  for (const shouldFail of [false, true]) {
    failLaunch = shouldFail;
    blockFrames = true;
    const entered = new Promise((resolve) => { launchEntered = resolve; });
    const build = call('build_run', { deviceId: 'device' });
    await entered;
    const action = { action: 'tap', deviceId: 'device', sessionId: panel.sessionId,
      subscriberId: panel.subscriberId, seq: current.seq, frameId: current.frame.frameId, x: 20, y: 20 };
    const queued = call('preview_action', action);
    await new Promise((resolve) => setImmediate(resolve));
    releaseLaunch();
    const buildResult = await build;
    assert.equal(buildResult.isError === true, shouldFail, `launch ${shouldFail ? 'failure' : 'success'} result`);
    const beforeAction = taps;
    const stale = await queued;
    assert.equal(stale.structuredContent?.errorCode, 'STALE_PREVIEW_FRAME', 'build launch must invalidate a pre-launch preview frame');
    assert.equal(taps, beforeAction, 'stale action must not reach the device');
    blockFrames = false;
    releaseFrame?.();
    const fresh = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId,
      afterSeq: current.seq, waitMs: 2000 })).structuredContent;
    assert.ok(fresh.frame && fresh.seq > current.seq, 'post-launch frame must become available');
    const recovered = await call('preview_action', { ...action, seq: fresh.seq, frameId: fresh.frame.frameId });
    assert.equal(recovered.isError, undefined, 'post-launch frame must restore preview input');
    blockFrames = false;
    releaseFrame?.();
    const next = (await call('preview_frame', { sessionId: panel.sessionId, subscriberId: panel.subscriberId,
      afterSeq: fresh.seq, waitMs: 2000 })).structuredContent;
    assert.ok(next.frame && next.seq > fresh.seq, 'subsequent test must start with an unused frame');
    current = next;
  }
  assert.equal(installs, 2);
  assert.equal(launches, 2);
  console.log('build preview freshness: ok');
} finally {
  blockFrames = false;
  releaseFrame?.();
  releaseLaunch?.();
  input.end();
  await running;
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

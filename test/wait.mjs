import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeviceAdapter } from '../src/device.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-wait-'));
const node = (id, text = '', children = []) => ({ attributes: { id, text, type: 'Text', bounds: '[0,0][100,40]' }, children });
const page = (children = []) => node('root', '', children);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let fixtureId = 0;

function mockDevice({ layouts = [page()], failDumpAt, dumpDelayMs = 0, recvDelayMs = 0, recvTimeout = false, targetListed = true } = {}) {
  const calls = [];
  const outputDirectory = join(directory, String(fixtureId++));
  let attempts = 0;
  let currentLayout;
  const adapter = createDeviceAdapter({
    directory: outputDirectory,
    runtime: async (_command, args, options) => {
      calls.push({ args, options });
      if (args[0] === 'list') return { code: 0, stdout: targetListed ? 'test-device\n' : '[Empty]\n', stderr: '' };
      if (args.includes('dumpLayout')) {
        attempts += 1;
        currentLayout = layouts[Math.min(attempts - 1, layouts.length - 1)];
        if (failDumpAt === attempts) return { code: 1, stdout: '', stderr: 'device disconnected' };
      }
      if (recvTimeout && args.includes('recv')) return { code: 124, stdout: '', stderr: 'command timed out' };
      const delayMs = args.includes('dumpLayout') ? dumpDelayMs : args.includes('recv') ? recvDelayMs : 0;
      if (delayMs) {
        await pause(Math.min(delayMs, options.timeoutMs));
        if (delayMs >= options.timeoutMs) return { code: 124, stdout: '', stderr: 'command timed out' };
      }
      if (args.includes('recv')) await writeFile(args.at(-1), JSON.stringify(currentLayout));
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  return { adapter, calls, outputDirectory };
}

function assertResult(result, status) {
  assert.equal(result.status, status);
  assert.ok(Number.isInteger(result.attempts) && result.attempts >= 1);
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0);
  assert.ok(Array.isArray(result.warnings) && result.warnings.length > 0);
  if (status !== 'matched') {
    assert.equal(typeof result.error, 'string');
    assert.equal(typeof result.errorCode, 'string');
    assert.equal(typeof result.stage, 'string');
    assert.equal(typeof result.cause.message, 'string');
    assert.equal(result.deviceId, 'test-device');
  }
}

try {
  const appeared = mockDevice({ layouts: [page(), page([node('ready', '已完成')])] });
  const appearedResult = await appeared.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'ready' }, timeoutMs: 1000, intervalMs: 100 });
  assertResult(appearedResult, 'matched');
  assert.equal(appearedResult.attempts, 2);
  assert.equal(appearedResult.lastObservation.totalMatches, 1);
  assert.equal(appearedResult.lastObservation.matches[0].text, '已完成');
  assert.deepEqual(await readdir(appeared.outputDirectory), []);

  const disappeared = mockDevice({ layouts: [page([node('loading', '加载中')]), page([node('content', '内容')])] });
  const disappearedResult = await disappeared.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'loading' }, state: 'absent', timeoutMs: 1000, intervalMs: 100 });
  assertResult(disappearedResult, 'matched');
  assert.equal(disappearedResult.attempts, 2);
  assert.equal(disappearedResult.lastObservation.totalMatches, 0);
  assert.ok(disappearedResult.lastObservation.totalNodes > 0);

  const changedText = mockDevice({ layouts: [page([node('status', '处理中')]), page([node('status', '完成')])] });
  const changedTextResult = await changedText.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'status', text: '完成' }, timeoutMs: 1000, intervalMs: 100 });
  assertResult(changedTextResult, 'matched');
  assert.equal(changedTextResult.attempts, 2);
  assert.equal(changedTextResult.lastObservation.matches[0].id, 'status');

  const deepNodes = Array.from({ length: 1100 }, (_, index) => node(`item-${index}`, `项目${index}`));
  const fullTree = mockDevice({ layouts: [page(deepNodes)] });
  const fullTreeResult = await fullTree.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'item-1099' } });
  assertResult(fullTreeResult, 'matched');
  assert.equal(fullTreeResult.lastObservation.totalNodes, 1101);
  assert.equal(fullTreeResult.lastObservation.nodes.length, 200);
  assert.equal(fullTreeResult.lastObservation.truncated, true);
  assert.equal(fullTreeResult.lastObservation.matches[0].id, 'item-1099', 'match beyond the public observation limit must still be found');
  const fullTreeAbsentResult = await fullTree.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'item-1099' }, state: 'absent', timeoutMs: 25, intervalMs: 100 });
  assertResult(fullTreeAbsentResult, 'timeout');
  assert.equal(fullTreeAbsentResult.lastObservation.truncated, true);
  assert.equal(fullTreeAbsentResult.lastObservation.totalMatches, 1, 'absence must check nodes beyond the first 1000');

  const duplicateLabels = mockDevice({ layouts: [page(Array.from({ length: 25 }, (_, index) => node(`duplicate-${index}`, '确认')))] });
  const duplicateResult = await duplicateLabels.adapter.waitFor({ deviceId: 'test-device', selector: { text: '确认' } });
  assertResult(duplicateResult, 'matched');
  assert.equal(duplicateResult.lastObservation.totalMatches, 25);
  assert.equal(duplicateResult.lastObservation.matches.length, 20);
  assert.equal(duplicateResult.lastObservation.matchesTruncated, true);

  const emptyTree = mockDevice({ layouts: [{ children: [] }] });
  const emptyResult = await emptyTree.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'missing' }, state: 'absent', timeoutMs: 25, intervalMs: 100 });
  assertResult(emptyResult, 'timeout');
  assert.equal(emptyResult.errorCode, 'WAIT_TIMEOUT');
  assert.equal(emptyResult.stage, 'wait_for');
  assert.equal(emptyResult.cause.code, 'WAIT_TIMEOUT');
  assert.equal(emptyResult.lastObservation.totalNodes, 0, 'empty hierarchy cannot establish absence');

  const disconnected = mockDevice({ layouts: [page([node('status', '等待')])], failDumpAt: 2, targetListed: false });
  const disconnectedResult = await disconnected.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'ready' }, timeoutMs: 1000, intervalMs: 100 });
  assertResult(disconnectedResult, 'observation_failed');
  assert.equal(disconnectedResult.attempts, 2);
  assert.match(disconnectedResult.error, /disconnected/);
  assert.equal(disconnectedResult.errorCode, 'DEVICE_OFFLINE');
  assert.equal(disconnectedResult.stage, 'layout_dump');
  assert.equal(disconnectedResult.cause.exitCode, 1);
  const offlineProbe = disconnected.calls.find(({ args }) => args[0] === 'list');
  assert.ok(offlineProbe.options.timeoutMs > 0 && offlineProbe.options.timeoutMs < 1000, 'offline probe must use only the remaining original wait budget');
  assert.equal(disconnectedResult.lastObservation.nodes[1].text, '等待', 'failure must preserve the last successful observation');
  assert.deepEqual(await readdir(disconnected.outputDirectory), []);

  const initialFailure = mockDevice({ failDumpAt: 1 });
  const initialFailureResult = await initialFailure.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'ready' } });
  assertResult(initialFailureResult, 'observation_failed');
  assert.equal(initialFailureResult.errorCode, 'LAYOUT_UNAVAILABLE', 'failure text alone must not classify a listed device as offline');
  assert.equal(initialFailureResult.lastObservation, null);

  const slowDump = mockDevice({ dumpDelayMs: 80 });
  const slowDumpResult = await slowDump.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'ready' }, timeoutMs: 20 });
  assertResult(slowDumpResult, 'timeout');
  assert.equal(slowDumpResult.errorCode, 'WAIT_TIMEOUT');
  assert.equal(slowDumpResult.stage, 'wait_for');
  assert.equal(slowDumpResult.cause.exitCode, 124, 'wait timeout must retain the underlying HDC timeout');
  const dumpCall = slowDump.calls.find(({ args }) => args.includes('dumpLayout'));
  assert.ok(dumpCall.options.timeoutMs > 0 && dumpCall.options.timeoutMs <= 20, 'dump must inherit the remaining wait budget');
  assert.ok(!slowDump.calls.some(({ args }) => args.includes('recv')), 'expired dump must not start a transfer');

  const slowRecv = mockDevice({ dumpDelayMs: 15, recvTimeout: true });
  const slowRecvResult = await slowRecv.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'ready' }, timeoutMs: 1000 });
  assertResult(slowRecvResult, 'timeout');
  const recvCall = slowRecv.calls.find(({ args }) => args.includes('recv'));
  const recvDumpCall = slowRecv.calls.find(({ args }) => args.includes('dumpLayout'));
  assert.ok(recvCall, 'transfer must start before its simulated timeout');
  assert.ok(recvCall.options.timeoutMs > 0 && recvCall.options.timeoutMs < recvDumpCall.options.timeoutMs, 'transfer must use the budget left after dumping');
  assert.deepEqual(await readdir(slowRecv.outputDirectory), []);
  for (const fixture of [slowDump, slowRecv]) {
    assert.ok(fixture.calls.at(-1).args.includes('rm'));
    assert.ok(fixture.calls.at(-1).options.timeoutMs > 0 && fixture.calls.at(-1).options.timeoutMs <= 2000, 'cleanup must have its own bounded budget');
  }

  const invalid = mockDevice();
  for (const options of [
    { selector: {} }, { selector: { unsupported: 'value' } }, { state: 'changed' },
    { timeoutMs: 0 }, { timeoutMs: 30001 }, { timeoutMs: 1.5 },
    { intervalMs: 99 }, { intervalMs: 5001 }, { intervalMs: 100.5 },
    { bundleName: 'com.example;echo' }, { deviceId: '' }
  ]) {
    await assert.rejects(invalid.adapter.waitFor({ deviceId: 'test-device', selector: { id: 'ready' }, ...options }), undefined, `invalid input must reject: ${JSON.stringify(options)}`);
  }
  assert.equal(invalid.calls.length, 0, 'invalid input must not reach HDC');

  for (const [label, snapshotDelayMs, recvDelayMs] of [['snapshot', 80, 0], ['transfer', 15, 80]]) {
    const budgetDirectory = join(directory, `capture-${label}`);
    const captureCalls = [];
    const budgetAdapter = createDeviceAdapter({
      directory: budgetDirectory,
      runtime: async (_command, args, options) => {
        captureCalls.push({ args, options });
        if (args.includes('recv')) await writeFile(args.at(-1), 'partial frame');
        const delayMs = args.includes('snapshot_display') ? snapshotDelayMs : args.includes('recv') ? recvDelayMs : 0;
        if (delayMs) {
          await pause(Math.min(delayMs, options.timeoutMs));
          if (delayMs >= options.timeoutMs) return { code: 124, stdout: '', stderr: 'command timed out' };
        }
        return { code: 0, stdout: '', stderr: '' };
      }
    });
    await assert.rejects(budgetAdapter.capture({ deviceId: 'budget-device' }, { timeoutMs: 40 }), (error) => {
      assert.match(error.message, /timed out|timeout|deadline/i);
      assert.equal(error.errorCode, 'HDC_TIMEOUT');
      assert.equal(error.stage, label === 'snapshot' ? 'capture' : 'capture_transfer');
      assert.equal(error.code, 'WAIT_TIMEOUT');
      assert.equal(error.exitCode, 124);
      return true;
    });
    const snapshotCall = captureCalls.find(({ args }) => args.includes('snapshot_display'));
    assert.ok(snapshotCall.options.timeoutMs > 0 && snapshotCall.options.timeoutMs <= 40, 'active snapshot must receive the capture budget');
    const transferCall = captureCalls.find(({ args }) => args.includes('recv'));
    if (label === 'snapshot') assert.equal(transferCall, undefined, 'expired snapshot must not start a screenshot transfer');
    else assert.ok(transferCall.options.timeoutMs > 0 && transferCall.options.timeoutMs < snapshotCall.options.timeoutMs, 'screenshot transfer must inherit the budget left after snapshot');
    assert.ok(captureCalls.at(-1).args.includes('rm'), 'active capture timeouts must clean the generated remote path');
    assert.ok(captureCalls.at(-1).options.timeoutMs > 0 && captureCalls.at(-1).options.timeoutMs <= 2000);
    assert.deepEqual(await readdir(budgetDirectory), [], 'active capture timeouts must remove partial local files');
  }

  let releaseCapture;
  const heldCapture = new Promise((resolve) => { releaseCapture = resolve; });
  const captureDevices = [];
  const queuedAdapter = createDeviceAdapter({
    directory: join(directory, 'queued'),
    runtime: async (_command, args) => {
      if (args.includes('snapshot_display')) {
        captureDevices.push(args[1]);
        if (args[1] === 'held-device') await heldCapture;
      }
      if (args.includes('recv')) await writeFile(args.at(-1), 'frame');
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  const firstCapture = queuedAdapter.capture({ deviceId: 'held-device' });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(queuedAdapter.capture({ deviceId: 'expired-device' }, { timeoutMs: 15 }), (error) => {
      assert.match(error.message, /timed out|timeout|deadline/i);
      assert.equal(error.errorCode, 'CAPTURE_FAILED');
      assert.equal(error.stage, 'capture_queue');
      assert.equal(error.code, 'WAIT_TIMEOUT');
      assert.equal(error.deviceId, 'expired-device');
      return true;
    });
  } finally {
    releaseCapture();
    await firstCapture;
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captureDevices, ['held-device'], 'a capture whose queue budget expired must never collect a late screenshot');
  assert.deepEqual(await readdir(join(directory, 'queued')), []);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('wait: ok');

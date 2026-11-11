import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeviceAdapter, runCommand } from '../src/device.mjs';

const timeout = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { timeoutMs: 50 });
assert.equal(timeout.code, 124);
assert.match(timeout.stderr, /command timed out after 50ms/);

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-capture-'));
const calls = [];
const adapter = createDeviceAdapter({
  directory,
  timeoutMs: 1000,
  runtime: async (_command, args, options) => {
    calls.push({ args, options });
    if (args.includes('snapshot_display')) return { code: 0, stdout: '', stderr: '' };
    if (args.includes('file') && args.includes('recv')) {
      await writeFile(args.at(-1), Buffer.from('frame'));
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  }
});

try {
  const sentinel = join(directory, 'keep.txt');
  await writeFile(sentinel, 'keep');
  const frame = await adapter.capture({ deviceId: 'test-device', directory: dirname(directory), fileName: 'keep.txt' });
  assert.deepEqual(frame, { mimeType: 'image/jpeg', data: Buffer.from('frame') });
  assert.ok(['snapshotMs', 'transferMs', 'readMs'].every((key) => Number.isFinite(frame.captureTiming?.[key]) && frame.captureTiming[key] >= 0));
  assert.ok(!calls.some(({ args }) => args[0] === 'list'), 'normal capture must not add a device probe');
  assert.ok(calls.some(({ args }) => args.includes('rm') && args.includes('-f')), 'remote screenshot must be cleaned up');
  assert.ok(calls.every(({ options }) => Number.isFinite(options?.timeoutMs) && options.timeoutMs > 0), 'HDC calls must receive a timeout');
  assert.equal(await readFile(sentinel, 'utf8'), 'keep', 'caller must not override screenshot paths');
  assert.ok(calls.filter(({ args }) => args.includes('recv')).every(({ args }) => dirname(args.at(-1)) === directory));
  calls.length = 0;
  await adapter.capture({ deviceId: 'test-device', width: 100, height: 200 });
  assert.ok(calls.some(({ args }) => args.includes('snapshot_display') && args.includes('-w') && args.includes('100') && args.includes('-h') && args.includes('200')),
    'preview dimensions must reach snapshot_display');
  assert.deepEqual(await readdir(directory), ['keep.txt'], 'only generated screenshot files must be cleaned up');
  await adapter.capture({ deviceId: 'test-device', directory, fileName: 'keep.txt' });
  assert.equal(await readFile(sentinel, 'utf8'), 'keep', 'caller filename must never overwrite or delete an existing file');

  for (const failure of ['snapshot_display', 'recv']) {
    const failedCalls = [];
    const failingAdapter = createDeviceAdapter({
      directory,
      runtime: async (_command, args) => {
        failedCalls.push(args);
        if (args[0] === 'list') return { code: 0, stdout: 'test-device\n', stderr: '' };
        if (args.includes('recv')) await writeFile(args.at(-1), 'partial frame');
        return { code: args.includes(failure) ? 1 : 0, stdout: '', stderr: args.includes(failure) ? 'capture failed' : '' };
      }
    });
    await assert.rejects(failingAdapter.capture({ deviceId: 'test-device', directory, fileName: 'keep.txt' }), (error) => {
      assert.match(error.message, /capture failed/);
      assert.equal(error.errorCode, 'CAPTURE_FAILED');
      assert.equal(error.stage, failure === 'snapshot_display' ? 'capture' : 'capture_transfer');
      assert.equal(error.exitCode, 1);
      return true;
    });
    assert.ok(failedCalls.at(-1).includes('rm'), 'failed screenshots must clean their generated remote path');
    assert.deepEqual(await readdir(directory), ['keep.txt'], 'failed screenshots must clean only their generated local path');
    assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  }

  const missingCalls = [];
  const missingHdc = createDeviceAdapter({ runtime: async (_command, args) => {
    missingCalls.push(args);
    throw Object.assign(new Error('HDC executable is missing'), { code: 'ENOENT' });
  } });
  await assert.rejects(missingHdc.tap({ deviceId: 'test-device', x: 1, y: 2 }), (error) => {
    assert.equal(error.errorCode, 'HDC_UNAVAILABLE');
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.stage, 'tap');
    assert.equal(error.deviceId, 'test-device');
    return true;
  });
  assert.equal(missingCalls.length, 1, 'an unavailable HDC executable must not trigger another HDC probe');

  for (const [listed, probeCode, expected] of [['test-device\n', 0, 'ACTION_FAILED'], ['[Empty]\n', 0, 'DEVICE_OFFLINE'], ['', 1, 'ACTION_FAILED']]) {
    const probeCalls = [];
    const failingAction = createDeviceAdapter({ runtime: async (_command, args, options) => {
      probeCalls.push({ args, options });
      if (args[0] === 'list') return { code: probeCode, stdout: listed, stderr: 'probe unavailable' };
      return { code: 1, stdout: '', stderr: 'device disconnected' };
    } });
    await assert.rejects(failingAction.tap({ deviceId: 'test-device', x: 1, y: 2 }), (error) => {
      assert.equal(error.errorCode, expected, 'offline classification requires successful evidence, not error text');
      assert.equal(error.stage, 'tap');
      assert.equal(error.exitCode, 1);
      assert.match(error.message, /device disconnected/);
      return true;
    });
    assert.equal(probeCalls.length, 2);
    assert.ok(probeCalls[1].options.timeoutMs > 0 && probeCalls[1].options.timeoutMs <= 1000);
  }

  const timedAction = createDeviceAdapter({ runtime: async () => ({ code: 124, stdout: '', stderr: 'command timed out' }) });
  await assert.rejects(timedAction.tap({ deviceId: 'test-device', x: 1, y: 2 }), (error) => {
    assert.equal(error.errorCode, 'HDC_TIMEOUT');
    assert.equal(error.stage, 'tap');
    assert.equal(error.exitCode, 124);
    return true;
  });

  const marker = '[Fail]Not match target founded, check connect-key please\r\r\n[Fail]ExecuteCommand need connect-key?';
  const markerCaptureCalls = [];
  const markerCapture = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    markerCaptureCalls.push(args);
    if (args[0] === 'list') return { code: 0, stdout: '[Empty]\n', stderr: '' };
    if (args.includes('snapshot_display')) return { code: 0, stdout: marker, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  } });
  await assert.rejects(markerCapture.capture({ deviceId: 'missing-device-01' }), (error) => {
    assert.equal(error.errorCode, 'DEVICE_OFFLINE');
    assert.equal(error.stage, 'capture');
    assert.equal(error.exitCode, 0, 'HDC failure markers must retain the actual zero exit code');
    return true;
  });
  assert.ok(!markerCaptureCalls.some((args) => args.includes('recv')), 'failed snapshots must not download a missing frame');

  for (const probeStdout of ['test-device\n', marker]) {
    const markerAction = createDeviceAdapter({ runtime: async (_command, args) => args[0] === 'list'
      ? { code: 0, stdout: probeStdout, stderr: '' }
      : { code: 0, stdout: '', stderr: '  [Fail]Input rejected' } });
    await assert.rejects(markerAction.tap({ deviceId: 'test-device', x: 1, y: 2 }), (error) => {
      assert.equal(error.errorCode, 'ACTION_FAILED', 'listed targets or a failed probe must preserve the action failure');
      assert.equal(error.stage, 'tap');
      assert.equal(error.exitCode, 0);
      assert.match(error.message, /Input rejected/);
      return true;
    });
  }

  const markerList = createDeviceAdapter({ runtime: async () => ({ code: 0, stdout: marker, stderr: '' }) });
  await assert.rejects(markerList.listTargets(), (error) => {
    assert.equal(error.errorCode, 'HDC_FAILED');
    assert.equal(error.stage, 'device_list');
    assert.equal(error.exitCode, 0);
    return true;
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('phase1: ok');

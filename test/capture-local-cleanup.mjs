import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceAdapter, runCommand } from '../src/device.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmony-capture-cleanup-'));
const ok = { code: 0, stdout: '', stderr: '' };
try {
  for (const fail of [false, true]) {
    let release;
    let started;
    let finished;
    const transferStarted = new Promise((resolve) => { started = resolve; });
    const transferFinished = new Promise((resolve) => { finished = resolve; });
    const adapter = createDeviceAdapter({ directory, runtime: async (_command, args) => {
      if (!args.includes('recv')) return ok;
      started();
      await new Promise((resolve) => { release = resolve; });
      await writeFile(args.at(-1), 'simulated late transfer');
      finished();
      if (fail) throw new Error('transfer failed after writing');
      return ok;
    } });
    const controller = new AbortController();
    const capture = adapter.capture({ deviceId: 'device' }, { signal: controller.signal });
    await transferStarted;
    controller.abort();
    await assert.rejects(capture, (error) => error.name === 'AbortError');
    assert.deepEqual(await readdir(directory), [], 'cancellation does not wait for the transfer');
    release();
    await transferFinished;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(await readdir(directory), [], 'a late-created file is removed when its transfer settles');
  }

  let rejectTransfer;
  let closeTransfer;
  let localPath;
  let signalStarted;
  const started = new Promise((resolve) => { signalStarted = resolve; });
  const pendingTransfer = new Promise((_resolve, reject) => { rejectTransfer = reject; });
  pendingTransfer.closed = new Promise((resolve) => { closeTransfer = resolve; });
  const closingAdapter = createDeviceAdapter({ directory, runtime: (_command, args) => {
    if (!args.includes('recv')) return Promise.resolve(ok);
    localPath = args.at(-1);
    signalStarted();
    return pendingTransfer;
  } });
  const abortDuringClose = new AbortController();
  const closingCapture = closingAdapter.capture({ deviceId: 'device' }, { signal: abortDuringClose.signal });
  await started;
  abortDuringClose.abort();
  await assert.rejects(closingCapture, (error) => error.name === 'AbortError');
  rejectTransfer(new Error('child emitted error before close'));
  await writeFile(localPath, 'created before close');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await readdir(directory)).length, 1, 'an error is not proof that the process closed');
  closeTransfer();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await readdir(directory), [], 'cleanup follows process close even after an early error');

  const frame = Buffer.from('mock image');
  const successful = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    if (args.includes('recv')) await writeFile(args.at(-1), frame);
    return ok;
  } });
  assert.deepEqual((await successful.capture({ deviceId: 'device' })).data, frame, 'successful transfer must be read before cleanup');
  assert.deepEqual(await readdir(directory), []);

  const controller = new AbortController();
  const command = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { signal: controller.signal });
  assert.ok(command.closed instanceof Promise, 'the default runtime exposes actual process close separately');
  controller.abort();
  await assert.rejects(command, (error) => error.name === 'AbortError');
  await command.closed;
  const missing = runCommand(join(directory, 'missing-executable'), []);
  await assert.rejects(missing, (error) => error.code === 'ENOENT');
  await missing.closed;
  const timedOut = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutMs: 50 });
  assert.equal((await timedOut).code, 124, 'timed-out command must preserve its timeout result');
  await timedOut.closed;
  const outputLimited = runCommand(process.execPath,
    ['-e', 'process.stdout.write("A".repeat(100000)); setTimeout(() => {}, 5000)'], { maxOutputBytes: 1024 });
  await assert.rejects(outputLimited, (error) => error.code === 'OUTPUT_LIMIT');
  await outputLimited.closed;
  console.log('capture local cleanup: ok');
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

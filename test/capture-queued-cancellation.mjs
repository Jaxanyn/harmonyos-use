import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceAdapter } from '../src/device.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmony-queued-cancel-'));
const jpeg = Buffer.from('ffd8ffc0000b080010001001011100ffda0008010100003f0055ffd9', 'hex');
let releaseFirst;
let signalStarted;
let calls = 0;
const firstStarted = new Promise((resolve) => { signalStarted = resolve; });
const release = new Promise((resolve) => { releaseFirst = resolve; });
const adapter = createDeviceAdapter({ directory, runtime: async (_command, args) => {
  assert.equal(args[2], 'shell');
  const marker = args[3].match(/(HARMONY_PREVIEW_[a-f0-9]+)_BEGIN/)[1];
  calls += 1;
  if (calls === 1) { signalStarted(); await release; }
  return { code: 0, stdout: `${marker}_BEGIN\n${jpeg.toString('base64')}\n${marker}_END\n`, stderr: '' };
} });
const options = { deviceId: 'device', width: 640, height: 1024 };
let first;
let queued;
let releaseActive;
try {
  first = adapter.capture(options);
  await firstStarted;
  const controller = new AbortController();
  const second = adapter.capture(options, { signal: controller.signal });
  const rejected = second.then(() => 'resolved', (error) => error.name);
  const queuedController = new AbortController();
  queued = adapter.capture(options, { signal: queuedController.signal });
  controller.abort();
  const immediate = await Promise.race([rejected, new Promise((resolve) => setTimeout(() => resolve('pending'), 150))]);
  assert.equal(immediate, 'AbortError', 'queued capture must reject promptly when canceled without a timeout');
  assert.equal(calls, 1, 'queued captures must not bypass an active capture');
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0, 'abort listener is removed after cancellation');

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const preCanceled = adapter.capture(options, { signal: alreadyAborted.signal }).then(() => 'resolved', (error) => error.name);
  assert.equal(await Promise.race([preCanceled, new Promise((resolve) => setTimeout(() => resolve('pending'), 150))]), 'AbortError',
    'a signal canceled before queuing must also reject promptly');

  const timeoutController = new AbortController();
  const expired = adapter.capture(options, { timeoutMs: 25, signal: timeoutController.signal }).then(() => 'resolved', (error) => error.code);
  const expiredWithoutSignal = adapter.capture(options, { timeoutMs: 25 }).then(() => 'resolved', (error) => error.code);
  assert.equal(await expired, 'WAIT_TIMEOUT', 'queue timeout must still expire while another capture is active');
  assert.equal(await expiredWithoutSignal, 'WAIT_TIMEOUT', 'queue timeout must expire even without a signal');
  assert.equal(getEventListeners(timeoutController.signal, 'abort').length, 0, 'a timeout immediately removes its abort listener');
  releaseFirst();
  assert.deepEqual((await first).data, jpeg);
  assert.deepEqual((await queued).data, jpeg);
  assert.equal(getEventListeners(queuedController.signal, 'abort').length, 0, 'a successful capture removes its abort listener');
  assert.equal(calls, 2, 'canceled and expired captures must not start the device operation');

  let markActive;
  let activeCalls = 0;
  const activeStarted = new Promise((resolve) => { markActive = resolve; });
  const activeRelease = new Promise((resolve) => { releaseActive = resolve; });
  const activeAdapter = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    if (!args[3]?.includes('HARMONY_PREVIEW_')) return { code: 0, stdout: '', stderr: '' };
    const marker = args[3].match(/(HARMONY_PREVIEW_[a-f0-9]+)_BEGIN/)[1];
    activeCalls += 1;
    if (activeCalls === 1) { markActive(); await activeRelease; }
    return { code: 0, stdout: `${marker}_BEGIN\n${jpeg.toString('base64')}\n${marker}_END\n`, stderr: '' };
  } });
  const activeController = new AbortController();
  const activeCapture = activeAdapter.capture(options, { signal: activeController.signal });
  await activeStarted;
  activeController.abort();
  await assert.rejects(activeCapture, (error) => error.name === 'AbortError');
  const afterAbort = await Promise.race([
    activeAdapter.capture(options),
    new Promise((_, reject) => setTimeout(() => reject(new Error('capture queue did not recover')), 1000))
  ]);
  assert.deepEqual(afterAbort.data, jpeg, 'a new capture must proceed after an active capture is canceled');
  assert.equal(activeCalls, 2);
  releaseActive();
  console.log('capture queued cancellation: ok');
} finally {
  releaseFirst();
  releaseActive?.();
  await Promise.allSettled([first, queued].filter(Boolean));
  await rm(directory, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { createFrameSource } from '../src/frame-source.mjs';

let now = 100;
let captureOptions;
let captureArgs;
const jpeg = (width, height) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08,
  height >> 8, height & 0xff, width >> 8, width & 0xff, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00]);
const source = createFrameSource({
  deviceAdapter: {
    capture: async ({ deviceId, width, height }, options) => {
      captureArgs = { deviceId, ...(width === undefined ? {} : { width, height }) };
      captureOptions = options;
      const frame = { deviceId, mimeType: 'image/jpeg', data: jpeg(width ?? 10, height ?? 20) };
      Object.defineProperty(frame, 'captureTiming', { value: { snapshotMs: 4, transferMs: 7, readMs: 1 }, enumerable: false });
      return frame;
    }
  },
  previewScale: 0.4,
  clock: () => now += 17,
  now: () => '2026-10-29T00:00:00.000Z'
});

assert.equal(source.name, 'jpeg');
assert.equal(source.supportsStreaming, false);
assert.deepEqual(await source.getCapabilities({ deviceId: 'test-device' }), {
  selected: 'jpeg', streaming: false, available: ['jpeg'], fallback: 'jpeg', deviceId: 'test-device',
  formats: {
    jpeg: { available: true, mode: 'snapshot_display' },
    mjpeg: { available: false, reason: 'device adapter exposes snapshot_display only' },
    h264: { available: false, reason: 'device adapter exposes snapshot_display only' }
  }
});
const signal = new AbortController().signal;
const sample = await source.capture({ deviceId: 'test-device', signal });
assert.equal(captureOptions.signal, signal);
assert.deepEqual(captureArgs, { deviceId: 'test-device' });
assert.deepEqual(sample.frame, { deviceId: 'test-device', mimeType: 'image/jpeg', data: jpeg(10, 20) });
assert.deepEqual(sample.metrics, {
  source: 'jpeg', mimeType: 'image/jpeg', frameBytes: 21, width: 10, height: 20, deviceWidth: 10, deviceHeight: 20,
  scale: 1, scaled: false, captureStages: { snapshotMs: 4, transferMs: 7, readMs: 1 }, captureMs: 17, capturedAt: '2026-10-29T00:00:00.000Z'
});
const scaled = await source.capture({ deviceId: 'test-device' });
assert.deepEqual(captureArgs, { deviceId: 'test-device', width: 4, height: 8 });
assert.equal(scaled.metrics.scaled, true);
assert.equal(scaled.metrics.scale, 0.4);
assert.equal(scaled.metrics.requestedWidth, 4);
assert.equal(scaled.metrics.requestedHeight, 8);
assert.equal(scaled.metrics.deviceWidth, 10);
assert.equal(scaled.metrics.deviceHeight, 20);

// A previous session's scaled capture must not calibrate a new session after reset.
let releaseOld;
const oldReady = new Promise((resolve) => { releaseOld = resolve; });
let startOld;
const oldStarted = new Promise((resolve) => { startOld = resolve; });
const racingSource = createFrameSource({
  previewScale: 0.75,
  deviceAdapter: { capture: async ({ width, height }) => {
    if (width !== undefined) { startOld(); await oldReady; }
    return { mimeType: 'image/jpeg', data: jpeg(width ?? 1600, height ?? 2560) };
  } }
});
await racingSource.capture({ deviceId: 'race-device' });
const oldCapture = racingSource.capture({ deviceId: 'race-device' });
await oldStarted;
racingSource.reset({ deviceId: 'race-device' });
releaseOld();
await assert.rejects(oldCapture, { name: 'AbortError' });
const newCapture = await racingSource.capture({ deviceId: 'race-device' });
assert.equal(newCapture.metrics.deviceWidth, 1600);
assert.equal(newCapture.metrics.deviceHeight, 2560);

let releaseFirst;
const firstReady = new Promise((resolve) => { releaseFirst = resolve; });
let firstStarted;
const firstPending = new Promise((resolve) => { firstStarted = resolve; });
let delayedFirst = true;
const initialRaceSource = createFrameSource({ deviceAdapter: { capture: async () => {
  if (delayedFirst) { delayedFirst = false; firstStarted(); await firstReady; }
  return { mimeType: 'image/jpeg', data: jpeg(1600, 2560) };
} } });
const staleFirst = initialRaceSource.capture({ deviceId: 'first-device' });
await firstPending;
initialRaceSource.reset();
releaseFirst();
await assert.rejects(staleFirst, { name: 'AbortError' });
assert.equal((await initialRaceSource.capture({ deviceId: 'first-device' })).metrics.deviceWidth, 1600);

let releaseLate;
const lateReady = new Promise((resolve) => { releaseLate = resolve; });
let lateStarted;
const latePending = new Promise((resolve) => { lateStarted = resolve; });
let delayLate = true;
const lateSource = createFrameSource({ deviceAdapter: { capture: async () => {
  if (delayLate) { delayLate = false; lateStarted(); await lateReady; }
  return { mimeType: 'image/jpeg', data: jpeg(1600, 2560) };
} } });
const lateCapture = lateSource.capture({ deviceId: 'late-device' });
await latePending;
lateSource.reset({ deviceId: 'late-device' });
assert.equal((await lateSource.capture({ deviceId: 'late-device' })).metrics.deviceWidth, 1600);
releaseLate();
await assert.rejects(lateCapture, { name: 'AbortError' });
assert.equal((await lateSource.capture({ deviceId: 'late-device' })).metrics.deviceWidth, 1600);

let releaseStream;
const streamReady = new Promise((resolve) => { releaseStream = resolve; });
let streamOpening;
const streamStarted = new Promise((resolve) => { streamOpening = resolve; });
let staleStreamClosed = false;
const openingSource = createFrameSource({ deviceAdapter: { openFrameStream: async () => {
  streamOpening(); await streamReady;
  return { nextFrame: async () => ({ mimeType: 'image/jpeg', data: jpeg(1600, 2560) }),
    close: () => { staleStreamClosed = true; } };
} } });
const staleStream = openingSource.capture({ deviceId: 'stream-race-device' });
await streamStarted;
openingSource.reset({ deviceId: 'stream-race-device' });
releaseStream();
await assert.rejects(staleStream, { name: 'AbortError' });
assert.equal(staleStreamClosed, true);

let rejectFrame;
let frameStarted;
const waitingFrame = new Promise((resolve) => { frameStarted = resolve; });
const closingSource = createFrameSource({ deviceAdapter: { openFrameStream: async () => ({
  nextFrame: () => new Promise((_, reject) => { rejectFrame = reject; frameStarted(); }),
  close: () => rejectFrame(new Error('stream closed'))
}) } });
const closedCapture = closingSource.capture({ deviceId: 'closing-device' });
await waitingFrame;
closingSource.reset({ deviceId: 'closing-device' });
await assert.rejects(closedCapture, { name: 'AbortError', code: 'FRAME_SOURCE_RESET' });
const failingSource = createFrameSource({ deviceAdapter: { capture: async () => { throw new Error('capture failed'); } } });
await assert.rejects(failingSource.capture({ deviceId: 'failing-device' }), /capture failed/);

// Default quality is higher while explicit scaling remains available.
const previousScale = process.env.HARMONY_PREVIEW_SCALE;
try {
  const createQualitySource = () => createFrameSource({
    deviceAdapter: { capture: async ({ width = 1600, height = 2560 }) => ({ mimeType: 'image/jpeg', data: jpeg(width, height) }) }
  });
  for (const [configured, expectedScale, expectedWidth, expectedHeight] of [
    [undefined, 0.75, 1200, 1920],
    ['invalid', 0.75, 1200, 1920],
    ['0.4', 0.4, 640, 1024],
    ['1', 1, 1600, 2560]
  ]) {
    if (configured === undefined) delete process.env.HARMONY_PREVIEW_SCALE;
    else process.env.HARMONY_PREVIEW_SCALE = configured;
    const qualitySource = createQualitySource();
    const first = await qualitySource.capture({ deviceId: 'quality-device' });
    assert.equal(first.metrics.width, 1600, 'First frame retains the original device width');
    assert.equal(first.metrics.height, 2560, 'First frame retains the original device height');
    const next = await qualitySource.capture({ deviceId: 'quality-device' });
    assert.equal(next.metrics.scale, expectedScale);
    assert.equal(next.metrics.width, expectedWidth);
    assert.equal(next.metrics.height, expectedHeight);
  }
} finally {
  if (previousScale === undefined) delete process.env.HARMONY_PREVIEW_SCALE;
  else process.env.HARMONY_PREVIEW_SCALE = previousScale;
}

let rotatingCapture = 0;
const rotatingSource = createFrameSource({
  deviceAdapter: {
    capture: async ({ width, height }) => {
      rotatingCapture += 1;
      const actual = rotatingCapture === 1 ? [10, 20] : [8, 4];
      return { mimeType: 'image/jpeg', data: jpeg(actual[0], actual[1]), width, height };
    }
  },
  previewScale: 0.4
});
await rotatingSource.capture({ deviceId: 'rotating-device' });
const rotated = await rotatingSource.capture({ deviceId: 'rotating-device' });
assert.equal(rotated.metrics.orientationChanged, true);
rotatingCapture = 0;
const heldRotation = await rotatingSource.capture({ deviceId: 'rotating-device' });
assert.equal(heldRotation.metrics.orientationChanged, true);
rotatingSource.reset({ deviceId: 'rotating-device' });
rotatingCapture = 0;
const recalibrated = await rotatingSource.capture({ deviceId: 'rotating-device' });
assert.equal(recalibrated.metrics.orientationChanged, undefined);

let streamClosed = false;
let streamFrames = 0;
const streamSource = createFrameSource({
  deviceAdapter: {
    openFrameStream: async () => ({
      source: 'mjpeg',
      nextFrame: async () => {
        streamFrames += 1;
        return { mimeType: 'image/jpeg', data: jpeg(10, 20), capturedAt: '2026-11-05T00:00:00.000Z' };
      },
      close: () => { streamClosed = true; }
    })
  }
});
const streamCapabilities = await streamSource.getCapabilities({ deviceId: 'stream-device' });
assert.equal(streamCapabilities.selected, 'mjpeg');
assert.equal(streamCapabilities.streaming, true);
const streamed = await streamSource.capture({ deviceId: 'stream-device' });
assert.equal(streamed.metrics.source, 'mjpeg');
assert.equal(streamFrames, 1);
streamSource.reset({ deviceId: 'stream-device' });
assert.equal(streamClosed, true);
console.log('frame source: ok');

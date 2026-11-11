import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setImmediate as nextTurn } from 'node:timers/promises';
import WebSocket from 'ws';
import { createPreviewServer } from '../src/server.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const captures = [];
const lists = [];
const keyEvents = [];
const pointerEvents = [];
let ignoreCaptureAbort = false;
const adapter = {
  capture: (options, { signal } = {}) => {
    const pending = deferred();
    if (!ignoreCaptureAbort) signal?.addEventListener('abort', () => pending.reject(Object.assign(new Error('capture aborted'), { name: 'AbortError', code: 'ABORT_ERR' })), { once: true });
    captures.push({ ...pending, options, signal });
    return pending.promise;
  },
  listTargets: () => {
    const pending = deferred();
    lists.push(pending);
    return pending.promise;
  },
  tap: async ({ deviceId, x, y }) => {
    pointerEvents.push({ deviceId, x, y });
    if (x === -1) throw new Error('pointer input failed');
    return { deviceId, x, y };
  },
  keyEvent: async ({ deviceId, key }) => {
    keyEvents.push({ deviceId, key });
    if (key === 'Power') throw new Error('device input failed');
    return { deviceId, key };
  }
};
const frameSource = {
  name: 'test-source',
  supportsStreaming: true,
  capture: async ({ deviceId, signal }) => {
    const frame = await adapter.capture({ deviceId }, { signal });
    return { frame, metrics: { source: 'test-source', captureMs: 7, frameBytes: frame.data.byteLength, capturedAt: '2026-10-29T00:00:00.000Z' } };
  }
};
const server = createPreviewServer({ deviceAdapter: adapter, frameSource });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
let socket;
const events = [];

async function waitFor(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for server event');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function drain() {
  await nextTurn();
  await new Promise((resolve) => { socket.once('pong', resolve); socket.ping(); });
}
const send = (action) => socket.send(JSON.stringify(action));
const frame = (text) => ({ mimeType: 'image/jpeg', data: Buffer.from(text), frameId: text, width: 1440, height: 3120, capturedAt: 123 });
const stopped = async () => {
  const count = events.filter((event) => event.type === 'preview-status' && !event.running && !event.deviceId).length;
  send({ type: 'preview-stop' });
  await waitFor(() => events.filter((event) => event.type === 'preview-status' && !event.running && !event.deviceId).length > count);
};

try {
  for (const body of [
    { deviceId: 'A', directory: '../outside' },
    { deviceId: 'A', fileName: '../important.txt' },
    { deviceId: 'A', surprise: true }, null, [], { deviceId: '' }
  ]) {
    const response = await fetch(`${address}/api/capture`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /capture|deviceId/);
  }
  assert.equal(captures.length, 0, 'invalid HTTP screenshot parameters must not reach the adapter');

  socket = new WebSocket(address.replace('http:', 'ws:') + '/preview');
  socket.on('message', (message, isBinary) => events.push(isBinary ? { binary: message.toString() } : JSON.parse(message.toString())));
  await waitFor(() => events.length === 3);
  for (const option of ['directory', 'fileName', 'surprise']) {
    const previous = events.length;
    send({ type: 'screenshot', deviceId: 'A', [option]: '../outside' });
    await waitFor(() => events.length > previous);
    assert.match(events.at(-1).error, /unsupported capture parameter/);
  }
  assert.equal(captures.length, 0, 'invalid WebSocket screenshot parameters must not reach the adapter');

  for (const actionId of [null, '', '  ', 1, {}, 'x'.repeat(129)]) {
    const previous = events.length;
    send({ type: 'key-event', deviceId: 'A', key: 'Back', actionId });
    await waitFor(() => events.length > previous);
    assert.match(events.at(-1).error, /actionId/);
  }
  assert.equal(keyEvents.length, 0, 'invalid action IDs must not send device input');
  send({ type: 'key-event', deviceId: 'A', key: 'Back' });
  await waitFor(() => events.some((event) => event.type === 'key-event-ack'));
  assert.deepEqual(events.findLast((event) => event.type === 'key-event-ack'), { type: 'key-event-ack', deviceId: 'A', key: 'Back' }, 'legacy clients receive the original response');
  send({ type: 'key-event', deviceId: 'A', key: 'Home', actionId: 'action-42' });
  await waitFor(() => events.some((event) => event.type === 'key-event-ack' && event.actionId === 'action-42'));
  assert.deepEqual(keyEvents, [{ deviceId: 'A', key: 'Back' }, { deviceId: 'A', key: 'Home' }]);
  send({ type: 'key-event', deviceId: 'A', key: 'Power', actionId: 'action-failed' });
  await waitFor(() => events.some((event) => event.type === 'error' && event.actionId === 'action-failed'));
  assert.equal(events.findLast((event) => event.actionId === 'action-failed').actionType, 'key-event');
  const previousFailure = events.length;
  send({ type: 'key-event', deviceId: 'A', key: 'Power' });
  await waitFor(() => events.length > previousFailure);
  assert.equal(events.at(-1).type, 'error');
  assert.equal(events.at(-1).actionId, undefined, 'legacy failures remain uncorrelated');

  send({ type: 'tap', deviceId: 'A', x: 1, y: 2 });
  await waitFor(() => events.some((event) => event.type === 'tap-ack'));
  assert.deepEqual(events.findLast((event) => event.type === 'tap-ack'), { type: 'tap-ack', deviceId: 'A', x: 1, y: 2 }, 'legacy pointer clients receive the original response');
  send({ type: 'tap', deviceId: 'A', x: 3, y: 4, actionId: 'pointer-1' });
  await waitFor(() => events.some((event) => event.type === 'tap-ack' && event.actionId === 'pointer-1'));
  send({ type: 'tap', deviceId: 'A', x: -1, y: 2, actionId: 'pointer-failed' });
  await waitFor(() => events.some((event) => event.type === 'error' && event.actionId === 'pointer-failed'));
  assert.equal(events.findLast((event) => event.actionId === 'pointer-failed').actionType, 'tap');
  const previousPointerCount = pointerEvents.length;
  const previousPointerFailure = events.length;
  send({ type: 'tap', deviceId: 'A', x: 5, y: 6, actionId: null });
  await waitFor(() => events.length > previousPointerFailure);
  assert.match(events.at(-1).error, /actionId/);
  assert.equal(pointerEvents.length, previousPointerCount, 'invalid pointer action IDs must not send device input');

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 1);
  await waitFor(() => events.some((event) => event.type === 'preview-status' && event.running && event.deviceId === 'A'));
  assert.equal(events.findLast((event) => event.type === 'preview-status' && event.running).frameSource, 'test-source');
  assert.deepEqual(captures[0].options, { deviceId: 'A' });
  await stopped();
  let boundary = events.length;
  captures[0].resolve(frame('stopped-A'));
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'a stopped polling capture must emit neither frame nor tick');

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 2);
  send({ type: 'preview-start', deviceId: 'B' });
  await waitFor(() => captures.length === 3);
  captures[2].resolve(frame('current-B'));
  await waitFor(() => events.some((event) => event.binary === 'current-B'));
  await waitFor(() => events.some((event) => event.type === 'preview-tick' && event.metrics?.source === 'test-source'));
  assert.equal(events.findLast((event) => event.type === 'preview-tick').metrics.source, 'test-source');
  assert.deepEqual(events.find((event) => event.type === 'frame-meta' && event.deviceId === 'B'), {
    type: 'frame-meta', mimeType: 'image/jpeg', deviceId: 'B', source: 'preview', frameId: 'current-B', capturedAt: 123, width: 1440, height: 3120,
    metrics: { source: 'test-source', captureMs: 7, frameBytes: 9, capturedAt: '2026-10-29T00:00:00.000Z' }
  });
  boundary = events.length;
  captures[1].resolve(frame('old-A'));
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'switching devices must suppress the old capture and tick');
  await stopped();

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 4);
  await stopped();
  boundary = events.length;
  captures[3].reject(new Error('late capture failure'));
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'a late capture error must not report disconnection after stop');
  assert.equal(lists.length, 0, 'a stopped capture must not begin device discovery');

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 5);
  captures[4].reject(new Error('disconnected'));
  await waitFor(() => lists.length === 1);
  await waitFor(() => events.some((event) => event.type === 'preview-status' && event.diagnostic));
  const failedCapture = events.findLast((event) => event.type === 'preview-status' && event.diagnostic);
  assert.equal(failedCapture.reason, 'capture-failed', 'an error string alone must not establish that the device is offline');
  assert.equal(failedCapture.diagnostic.errorCode, 'CAPTURE_FAILED');
  assert.equal(failedCapture.diagnostic.deviceId, 'A');
  await stopped();
  boundary = events.length;
  lists[0].resolve(['A']);
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'discovery that completes after stop must not report stale devices');

  send({ type: 'screenshot', deviceId: 'A' });
  await waitFor(() => captures.length === 6);
  await stopped();
  boundary = events.length;
  captures[5].resolve(frame('old-manual-capture'));
  await drain();
  assert.deepEqual(events.slice(boundary), [], 'stop must invalidate an in-flight manual screenshot too');

  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === 7);
  await new Promise((resolve) => setTimeout(resolve, 600));
  captures[6].resolve(frame('same-reconnected-frame'));
  await waitFor(() => events.some((event) => event.binary === 'same-reconnected-frame'));
  // A slow capture must not add another full poll period after it completes.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(captures.length, 8, 'the next preview capture starts as soon as the prior capture completes');
  await waitFor(() => captures.length === 8);
  captures[7].reject(new Error('disconnected again'));
  await waitFor(() => lists.length === 2);
  boundary = events.length;
  lists[1].resolve(['A']);
  await waitFor(() => captures.length === 9);
  captures[8].resolve(frame('same-reconnected-frame'));
  await waitFor(() => events.filter((event) => event.binary === 'same-reconnected-frame').length === 2);
  const recoveryEvents = events.slice(boundary);
  const recovered = recoveryEvents.findIndex((event) => event.type === 'preview-status' && event.running && event.reconnecting === false);
  const recoveredFrame = recoveryEvents.findIndex((event) => event.type === 'frame-meta');
  assert.ok(recovered >= 0 && recovered < recoveredFrame, 'successful sampling must announce recovery before sending the fresh frame');
  await stopped();

  // An action-triggered refresh must publish a new sequence even when pixels are unchanged.
  const refreshCaptureCount = captures.length;
  const refreshFrameCount = events.filter((event) => event.binary === 'refresh-same').length;
  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === refreshCaptureCount + 1);
  captures.at(-1).resolve(frame('refresh-same'));
  await waitFor(() => events.filter((event) => event.binary === 'refresh-same').length === refreshFrameCount + 1);
  send({ type: 'preview-refresh', deviceId: 'A' });
  await waitFor(() => captures.length === refreshCaptureCount + 2);
  captures.at(-1).resolve(frame('refresh-same'));
  await waitFor(() => events.filter((event) => event.binary === 'refresh-same').length === refreshFrameCount + 2);
  await stopped();

  // An action pauses and aborts an in-flight JPEG capture before the device input.
  const actionCaptureCount = captures.length;
  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === actionCaptureCount + 1);
  send({ type: 'preview-action-start', deviceId: 'A', actionId: 'action-1' });
  await waitFor(() => events.some((event) => event.type === 'preview-action-ready' && event.actionId === 'action-1'));
  await waitFor(() => captures[actionCaptureCount].signal?.aborted === true);
  send({ type: 'preview-refresh', deviceId: 'A' });
  await waitFor(() => captures.length === actionCaptureCount + 2);
  captures.at(-1).resolve(frame('action-refresh'));
  await waitFor(() => events.some((event) => event.binary === 'action-refresh'));
  await stopped();

  // A source that ignores cancellation must not publish its pre-action frame.
  ignoreCaptureAbort = true;
  const ignoredAbortCount = captures.length;
  send({ type: 'preview-start', deviceId: 'A' });
  await waitFor(() => captures.length === ignoredAbortCount + 1);
  send({ type: 'preview-action-start', deviceId: 'A', actionId: 'action-2' });
  await waitFor(() => events.some((event) => event.type === 'preview-action-ready' && event.actionId === 'action-2'));
  send({ type: 'preview-refresh', deviceId: 'A' });
  captures[ignoredAbortCount].resolve(frame('cancelled-before-action'));
  await waitFor(() => captures.length === ignoredAbortCount + 2);
  assert.ok(!events.some((event) => event.binary === 'cancelled-before-action'));
  captures.at(-1).resolve(frame('captured-after-action'));
  await waitFor(() => events.some((event) => event.binary === 'captured-after-action'));
  await stopped();
  ignoreCaptureAbort = false;

  const page = await (await fetch(address)).text();
  verifyBrowserFrameLifecycle(page);
} finally {
  socket?.terminate();
  await server.shutdown();
}

// Starting a second socket must not let an older scaled capture poison the
// shared device calibration or lose a forced refresh requested by the first.
{
  const requests = [];
  let discoveryCount = 0;
  const raceAdapter = {
    capture: (options) => {
      const pending = deferred();
      requests.push({ options, ...pending });
      return pending.promise;
    },
    listTargets: async () => { discoveryCount += 1; return ['race-device']; }
  };
  const raceServer = createPreviewServer({ deviceAdapter: raceAdapter });
  await new Promise((resolve) => raceServer.listen(0, '127.0.0.1', resolve));
  const raceAddress = `ws://127.0.0.1:${raceServer.address().port}/preview`;
  const eventsA = [], eventsB = [];
  const jpeg = (width, height, tag) => ({ mimeType: 'image/jpeg', data: Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, height >> 8, height & 255,
    width >> 8, width & 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, tag
  ]) });
  const connect = (sink) => {
    const client = new WebSocket(raceAddress);
    client.on('message', (data, binary) => sink.push(binary ? { binary: Buffer.from(data) } : JSON.parse(data.toString())));
    return client;
  };
  const first = connect(eventsA);
  let second;
  try {
    await new Promise((resolve, reject) => { first.once('open', resolve); first.once('error', reject); });
    first.send(JSON.stringify({ type: 'preview-start', deviceId: 'race-device' }));
    await waitFor(() => requests.length >= 1);
    requests[0].resolve(jpeg(1600, 2560, 1));
    await waitFor(() => eventsA.some((event) => event.type === 'frame-meta' && event.deviceId === 'race-device'));
    first.send(JSON.stringify({ type: 'preview-refresh', deviceId: 'race-device', requestId: 'forced-refresh' }));
    await waitFor(() => requests.length >= 2);
    assert.equal(requests[1].options.width, 1200);
    assert.equal(requests[1].options.height, 1920);

    second = connect(eventsB);
    await new Promise((resolve, reject) => { second.once('open', resolve); second.once('error', reject); });
    second.send(JSON.stringify({ type: 'preview-start', deviceId: 'race-device' }));
    await waitFor(() => requests.length >= 3);
    assert.equal(requests[2].options.width, undefined, 'new session must recalibrate from an original frame');
    const stale = jpeg(1200, 1920, 2);
    requests[1].resolve(stale);
    await waitFor(() => requests.length >= 4);
    requests[3].resolve(jpeg(1600, 2560, 3));
    await waitFor(() => eventsA.some((event) => (event.type === 'frame-meta' && event.refreshIds?.includes('forced-refresh')) ||
      (event.type === 'preview-status' && event.running === false)));
    assert.ok(!eventsA.some((event) => event.type === 'preview-status' && event.running === false),
      'an internal reset must not report device disconnection');
    requests[2].resolve(jpeg(1600, 2560, 4));
    await waitFor(() => eventsB.some((event) => event.type === 'frame-meta' && event.deviceId === 'race-device'));

    const refreshed = eventsA.findLast((event) => event.type === 'frame-meta' && event.refreshIds?.includes('forced-refresh'));
    const other = eventsB.findLast((event) => event.type === 'frame-meta' && event.deviceId === 'race-device');
    for (const event of [refreshed, other]) {
      assert.equal(event.width, 1600);
      assert.equal(event.height, 2560);
      assert.equal(event.deviceWidth, 1600);
      assert.equal(event.deviceHeight, 2560);
    }
    assert.ok(!eventsA.some((event) => event.binary?.equals(stale.data)), 'old scaled frame must never reach the first client');
    assert.ok(!eventsA.some((event) => event.type === 'preview-status' && event.running === false), 'an internal reset must not report device disconnection');
    assert.equal(discoveryCount, 0, 'an internal reset must not trigger device discovery');
  } finally {
    first.terminate();
    second?.terminate();
    await raceServer.shutdown();
  }
}

function verifyBrowserFrameLifecycle(page) {
  const elements = Object.fromEntries(['stage', 'status', 'devices', 'refresh', 'build', 'shot', 'start', 'stop', 'back', 'home']
    .map((id) => [id, { style: {}, src: '', value: '', textContent: '', replaceChildren() {}, removeAttribute(name) { this[name] = ''; } }]));
  const stage = elements.stage;
  stage.naturalWidth = 1440;
  stage.naturalHeight = 3120;
  const displayBox = { left: 0, top: 0, width: 360, height: 780 };
  stage.getBoundingClientRect = () => ({ ...displayBox });
  const images = [], sent = [], timers = new Map(), revoked = [];
  let client, urlId = 0, timerId = 0;
  class BrowserSocket {
    static OPEN = 1;
    readyState = 1;
    constructor() { client = this; }
    send(value) { sent.push(JSON.parse(value)); }
  }
  runInNewContext(page.match(/<script>([\s\S]*?)<\/script>/)[1], {
    document: { querySelector: (selector) => elements[selector.slice(1)] },
    location: { search: '?deviceId=A', protocol: 'http:', host: '127.0.0.1:4100' },
    URLSearchParams, Blob, WebSocket: BrowserSocket,
    URL: { createObjectURL: () => `blob:${++urlId}`, revokeObjectURL: (url) => revoked.push(url) },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    Image: class { constructor() { images.push(this); } },
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id)
  });
  const receive = (message) => client.onmessage({ data: JSON.stringify(message) });
  const queueImage = (deviceId, source = 'capture') => {
    receive({ type: 'frame-meta', mimeType: 'image/jpeg', deviceId, source });
    client.onmessage({ data: Buffer.from('image') });
    return images.at(-1);
  };
  const paint = (deviceId) => { queueImage(deviceId).onload(); stage.onload(); };
  const pointer = { clientX: 100, clientY: 200, pointerId: 1 };
  const tap = () => { stage.onpointerdown(pointer); stage.onpointerup(pointer); };
  const assertDisabled = (keepVisible = false) => {
    const previous = sent.length;
    tap();
    elements.back.onclick();
    elements.home.onclick();
    assert.equal(sent.length, previous, 'an invalid frame must not send a gesture');
    assert.equal(elements.back.disabled, true, 'Back must be disabled without an interactive frame');
    assert.equal(elements.home.disabled, true, 'Home must be disabled without an interactive frame');
    assert.equal(stage.style.pointerEvents, 'none');
    assert.equal(stage.hidden, !keepVisible, 'only an action in progress may retain the previous image');
  };

  client.onopen();
  receive({ type: 'devices', devices: ['A', 'B'] });
  assert.equal(sent.at(-1).type, 'preview-start');
  paint('A');
  assert.equal(stage.hidden, false, 'only a successfully loaded current image becomes visible');
  assert.equal(elements.back.disabled, false);
  assert.equal(elements.home.disabled, false);
  for (const [button, key] of [['back', 'Back'], ['home', 'Home']]) {
    const previousFrame = stage.src;
    elements[button].onclick();
    const request = sent.at(-1);
    assert.equal(request.type, 'key-event');
    assert.equal(request.deviceId, 'A');
    assert.equal(request.key, key);
    assert.ok(request.actionId, 'navigation must use an action ID');
    assertDisabled(true);
    assert.equal(stage.src, previousFrame, 'navigation must keep the previous image while the command is pending');
    assert.ok(!revoked.includes(previousFrame), 'the visible image must remain valid until its replacement is ready');
    receive({ type: 'key-event-ack', deviceId: 'A', actionId: request.actionId });
    assert.deepEqual(sent.at(-1), { type: 'screenshot', deviceId: 'A' }, 'navigation must request an action-after screenshot');
    assertDisabled(true);
    const replacement = queueImage('A');
    assert.equal(stage.src, previousFrame, 'navigation must retain the old image while the new frame decodes');
    replacement.onload();
    stage.onload();
    assert.notEqual(stage.src, previousFrame);
    assert.equal(elements[button].disabled, false);
  }
  elements.back.onclick();
  const stoppedAction = sent.at(-1);
  assertDisabled(true);
  elements.stop.onclick();
  assertDisabled();
  const beforeLateAck = sent.length;
  receive({ type: 'key-event-ack', deviceId: 'A', actionId: stoppedAction.actionId });
  assert.equal(sent.length, beforeLateAck, 'a late navigation acknowledgement after stop must not request a frame');
  elements.start.onclick();
  paint('A');
  elements.home.onclick();
  assertDisabled(true);
  receive({ type: 'preview-status', running: false, deviceId: 'A', reason: 'device-disconnected', reconnecting: true });
  assertDisabled();
  assert.equal(stage.src, '', 'disconnect must clear a retained navigation image');
  elements.start.onclick();
  paint('A');
  elements.back.onclick();
  const decodedAction = sent.at(-1);
  receive({ type: 'key-event-ack', deviceId: 'A', actionId: decodedAction.actionId });
  const pendingNavigationFrame = queueImage('A');
  elements.devices.value = 'B';
  elements.devices.onchange();
  pendingNavigationFrame.onload();
  assert.equal(stage.src, '', 'switching devices must clear the retained image and ignore the late navigation frame');
  assertDisabled();
  elements.devices.value = 'A';
  elements.devices.onchange();
  elements.start.onclick();
  paint('A');
  elements.back.onclick();
  const oldAction = sent.at(-1);
  elements.devices.value = 'B';
  elements.devices.onchange();
  elements.devices.value = 'A';
  elements.devices.onchange();
  elements.start.onclick();
  paint('A');
  elements.home.onclick();
  const currentAction = sent.at(-1);
  assert.notEqual(currentAction.actionId, oldAction.actionId);
  const beforeStaleAck = sent.length;
  const currentVisible = stage.src;
  receive({ type: 'error', error: 'old key failed', actionType: 'key-event', deviceId: 'A', actionId: oldAction.actionId });
  receive({ type: 'key-event-ack', deviceId: 'A', actionId: oldAction.actionId });
  receive({ type: 'key-event-ack', deviceId: 'A' });
  receive({ type: 'tap-ack', deviceId: 'A', actionId: currentAction.actionId });
  assert.equal(sent.length, beforeStaleAck, 'stale or unrelated acknowledgements must not complete the current navigation');
  assertDisabled(true);
  assert.equal(stage.src, currentVisible, 'a stale key failure must not clear the current image');
  receive({ type: 'key-event-ack', deviceId: 'A', actionId: currentAction.actionId });
  assert.deepEqual(sent.at(-1), { type: 'screenshot', deviceId: 'A' });
  paint('A');
  elements.home.onclick();
  const failedAction = sent.at(-1);
  receive({ type: 'error', error: 'key failed', actionType: 'key-event', deviceId: 'A', actionId: failedAction.actionId });
  assert.equal(elements.status.textContent, 'key failed', 'the current navigation failure must remain visible');
  assertDisabled();
  elements.start.onclick();
  paint('A');
  for (const type of ['tap', 'swipe', 'long-press']) {
    const previousFrame = stage.src;
    const beforeAction = sent.length;
    stage.onpointerdown(pointer);
    if (type === 'long-press') {
      const [timer, callback] = [...timers.entries()].at(-1);
      timers.delete(timer);
      callback();
      stage.onpointerup(pointer);
    } else {
      stage.onpointerup(type === 'swipe' ? { ...pointer, clientX: 200 } : pointer);
    }
    const action = sent.at(-1);
    assert.equal(sent.length, beforeAction + 1, `${type} must send exactly one input`);
    assert.equal(action.type, type);
    assert.ok(action.actionId, `${type} must use an action ID`);
    assertDisabled(true);
    assert.equal(stage.src, previousFrame, `${type} must keep the old image while input is pending`);
    assert.ok(!revoked.includes(previousFrame), `${type} must keep the visible image URL alive`);
    receive({ type: `${type}-ack`, deviceId: 'A', actionId: 'old-action' });
    receive({ type: 'key-event-ack', deviceId: 'A', actionId: action.actionId });
    assert.equal(sent.length, beforeAction + 1, `${type} must ignore stale and unrelated acknowledgements`);
    receive({ type: `${type}-ack`, deviceId: 'A', actionId: action.actionId });
    assert.deepEqual(sent.at(-1), { type: 'screenshot', deviceId: 'A' });
    assertDisabled(true);
    const replacement = queueImage('A');
    assert.equal(stage.src, previousFrame, `${type} must keep the old image until the new one decodes`);
    replacement.onload();
    stage.onload();
    assert.notEqual(stage.src, previousFrame);
    assert.equal(stage.style.pointerEvents, 'auto');
  }

  // An old action of the same type cannot complete or clear a newer one after A→B→A.
  tap();
  const oldTap = sent.at(-1);
  elements.devices.value = 'B';
  elements.devices.onchange();
  elements.devices.value = 'A';
  elements.devices.onchange();
  elements.start.onclick();
  paint('A');
  tap();
  const currentTap = sent.at(-1);
  const currentFrame = stage.src;
  const beforeLateTap = sent.length;
  receive({ type: 'tap-ack', deviceId: 'A', actionId: oldTap.actionId });
  receive({ type: 'error', error: 'old tap failed', actionType: 'tap', deviceId: 'A', actionId: oldTap.actionId });
  receive({ type: 'swipe-ack', deviceId: 'A', actionId: currentTap.actionId });
  assert.equal(sent.length, beforeLateTap, 'late acknowledgements must not complete the current pointer action');
  assertDisabled(true);
  assert.equal(stage.src, currentFrame, 'an old action failure must not clear the retained image');
  receive({ type: 'tap-ack', deviceId: 'A', actionId: currentTap.actionId });
  paint('A');

  const previousFrame = stage.src;
  tap();
  const tapAction = sent.at(-1);
  assert.deepEqual({ ...tapAction, actionId: undefined }, { type: 'tap', deviceId: 'A', x: 400, y: 800, actionId: undefined }, 'coordinates must use actual screenshot dimensions');
  assertDisabled(true);
  assert.equal(stage.src, previousFrame);
  receive({ type: 'tap-ack', deviceId: 'A', actionId: tapAction.actionId });
  assert.deepEqual(sent.at(-1), { type: 'screenshot', deviceId: 'A' }, 'an acknowledged action must request a verification screenshot');

  let imageCount = images.length;
  queueImage('A', 'preview');
  assert.equal(images.length, imageCount, 'a preview captured before the action must not satisfy its verification screenshot');
  assertDisabled(true);
  const verifiedImage = queueImage('A', 'capture');
  imageCount = images.length;
  queueImage('A', 'preview');
  assert.equal(images.length, imageCount, 'preview frames must not replace a manual screenshot while it is still decoding');
  verifiedImage.onload();
  stage.onload();
  assert.equal(stage.hidden, false);
  queueImage('A', 'preview').onload();
  stage.onload();
  assert.equal(stage.style.pointerEvents, 'auto', 'live preview must resume after the verification screenshot is loaded');

  paint('A');
  receive({ type: 'preview-status', running: false, deviceId: 'A', reason: 'device-disconnected', reconnecting: true });
  assertDisabled();
  receive({ type: 'devices', devices: [] });
  imageCount = images.length;
  queueImage('A');
  assert.equal(images.length, imageCount, 'a frame alone must not restore interaction before recovery is confirmed');
  receive({ type: 'preview-status', running: true, deviceId: 'A', reconnecting: false });
  paint('A');
  assert.equal(stage.style.pointerEvents, 'auto', 'a fresh frame must restore the selected device after reconnect');

  elements.shot.onclick();
  const pendingImage = queueImage('A');
  elements.devices.value = 'B';
  elements.devices.onchange();
  pendingImage.onload();
  assert.equal(stage.src, '', 'an old image load must not restore the previous device frame');
  assertDisabled();

  elements.shot.onclick();
  paint('B');
  const staleLoad = stage.onload;
  elements.stop.onclick();
  staleLoad();
  assertDisabled();
  imageCount = images.length;
  queueImage('B');
  assert.equal(images.length, imageCount, 'stopped preview must discard incoming frames');

  elements.start.onclick();
  paint('B');
  receive({ type: 'error', error: 'capture failed' });
  assertDisabled();
  imageCount = images.length;
  queueImage('B');
  receive({ type: 'preview-status', running: true, deviceId: 'B', reconnecting: false });
  queueImage('B');
  assert.equal(images.length, imageCount, 'generic errors must require a new capture or preview request instead of accepting late frames or recovery status');

  for (const phase of ['pointerup', 'long-press']) {
    elements.shot.onclick();
    paint('B');
    stage.onpointerdown(pointer);
    const beforeRotation = sent.length;
    stage.naturalWidth = 3120;
    stage.naturalHeight = 1440;
    if (phase === 'pointerup') stage.onpointerup(pointer);
    else [...timers.values()].forEach((callback) => callback());
    assert.equal(sent.length, beforeRotation, `${phase} must not combine coordinates across a screen rotation`);
    assertDisabled();
    stage.naturalWidth = 1440;
    stage.naturalHeight = 3120;
  }
  elements.shot.onclick();
  paint('B');
  stage.onpointerdown(pointer);
  const beforeResize = sent.length;
  displayBox.width = 400;
  stage.onpointerup(pointer);
  assert.equal(sent.length, beforeResize, 'resizing the displayed image must invalidate a gesture in progress');
  assertDisabled();
  displayBox.width = 360;

  elements.shot.onclick();
  paint('B');
  stage.onpointerdown(pointer);
  assert.equal(timers.size, 1);
  client.readyState = 3;
  client.onclose();
  assert.equal(timers.size, 0, 'disconnect must cancel an in-progress long press');
  assertDisabled();
  assert.ok(revoked.length > 0, 'discarded screenshot URLs must be released');
}

console.log('server races: ok');

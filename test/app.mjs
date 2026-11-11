import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/app/main.mjs', import.meta.url), 'utf8');
const html = await readFile(new URL('../src/app/index.html', import.meta.url), 'utf8');
const pollIntervalMs = 125;
assert.match(html, /<img\b(?=[^>]*\bid="stage")(?=[^>]*\bdraggable="false")[^>]*>/i, 'Initial preview image must not start a native drag');
const flush = async () => { for (let turn = 0; turn < 12; turn += 1) await Promise.resolve(); };
const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
let nextFrameSeq = 0;
const imageResult = (deviceId, width = 1260, height = 2720, deviceScale = 1, rotation) => ({
  content: [],
  structuredContent: { deviceId, connected: true, sessionId: 'test-session', seq: ++nextFrameSeq,
    metrics: { source: 'jpeg', captureMs: 42, frameBytes: 1234, capturedAt: new Date().toISOString(),
      deviceWidth: width * deviceScale, deviceHeight: height * deviceScale,
      ...(rotation === undefined ? {} : { rotation }) },
    frame: { mimeType: 'image/png', data: `${width}x${height}`, frameId: `frame-${nextFrameSeq}`, capturedAt: new Date().toISOString(), width, height } },
});

function createPanel({ autoPreflight = true, hostSubscriptionProtocol = 1, pixelByteOffset = 0, pixelTailPadding = 0, failWordViews = false, distinctPadding = false, mixedSignedPixels = false, pixelTruncateBytes = 0, failDiagnosticScan = false } = {}) {
  class Element {
    listeners = new Map();
    value = '';
    _src = '';
    naturalWidth = 0;
    naturalHeight = 0;
    textContent = '';
    className = '';
    dataset = {};
    style = {};
    disabled = false;
    hidden = true;
    clientWidth = 315;
    clientHeight = 680;
    scrollLeft = 0;
    scrollTop = 0;
    clientLeft = 0;
    clientTop = 0;
    box = { left: 10, top: 20, width: 315, height: 680 };
    get src() { return this._src; }
    set src(value) {
      this._src = value;
      if (value.startsWith('data:')) [this.naturalWidth, this.naturalHeight] = value.split(',').at(-1).split('x').map(Number);
    }
    get offsetWidth() { return this._offsetWidth ?? this.clientWidth + 2 * this.clientLeft; }
    set offsetWidth(value) { this._offsetWidth = value; }
    get offsetHeight() { return this._offsetHeight ?? this.clientHeight + 2 * this.clientTop; }
    set offsetHeight(value) { this._offsetHeight = value; }
    addEventListener(name, listener) { this.listeners.set(name, listener); }
    dispatch(name, event = {}) {
      if (name.startsWith('pointer')) event = { button: 0, isPrimary: true, ...event };
      this.listeners.get(name)?.(event);
      if (this === elements.stage && name.startsWith('pointer')) elements['frame-shell'].dispatch(name, { ...event, target: this });
    }
    replaceChildren(...children) { this.children = children; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
    setAttribute(name, value) { this[name] = String(value); }
    getBoundingClientRect() { return this.box; }
    replaceWith(next) { next.box = this.box; elements.stage = next; }
    setPointerCapture(pointerId) { this.capturedPointerId = pointerId; }
    requestFullscreen() { return Promise.resolve(); }
    async decode() {
      const source = this.src;
      if (this.decodeGate) await this.decodeGate;
      const dimensions = source.split(',').at(-1).split('x').map(Number);
      this.naturalWidth = dimensions[0];
      this.naturalHeight = dimensions[1];
    }
  }
  const elements = Object.fromEntries(['status', 'devices', 'stage', 'frame-shell', 'stage-overlay', 'overlay-text', 'gesture-marker', 'metrics', 'action-metrics', 'action-summary', 'action-cancellations', 'retry-frame', 'stale-notice',
    'refresh', 'build', 'start', 'stop', 'nav-back', 'nav-home', 'fit', 'zoom-out', 'zoom-in', 'fullscreen', 'exit-fullscreen', 'fullscreen-status',
    'precise-start-x', 'precise-start-y', 'precise-end-x', 'precise-end-y', 'precise-bind', 'precise-tap', 'precise-swipe'].map((id) => [id, new Element()]));
  const sent = [];
  const timers = new Map();
  const pixelFrames = new Map();
  const pixelViews = [];
  const wordViews = [];
  let wordViewAttempts = 0;
  let canvasUnavailable = false;
  const resizeObservers = [];
  const hostStyles = new Map();
  class TestResizeObserver {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  let timerId = 0;
  let time = 0;
  let activeSession = '';
  const windowListeners = new Map();
  const documentListeners = new Map();
  const parent = { postMessage(message) {
    if (message.params?.name === 'preview_info') {
      Promise.resolve().then(() => windowListeners.get('message')({ source: parent, data: {
        jsonrpc: '2.0', id: message.id, result: textResult({ previewSubscriptionProtocol: hostSubscriptionProtocol })
      } }));
      return;
    }
    if (autoPreflight && message.params?.name === 'preview_frame' && message.params.arguments.waitMs === undefined &&
        (elements.status.textContent.startsWith('Sending ') || elements.status.textContent.startsWith('Previous action'))) {
      Promise.resolve().then(() => windowListeners.get('message')({ source: parent, data: {
        jsonrpc: '2.0', id: message.id, result: { structuredContent: {
          deviceId: elements.devices.value, sessionId: activeSession, connected: true, seq: message.params.arguments.afterSeq, frame: null
        } }
      } }));
      return;
    }
    sent.push(message);
  } };
  const context = vm.createContext({
    window: { parent, ResizeObserver: TestResizeObserver, addEventListener(name, listener) { windowListeners.set(name, listener); } },
    ResizeObserver: TestResizeObserver,
    document: {
      querySelector: (selector) => elements[selector.slice(1)],
      querySelectorAll: () => ['refresh', 'build', 'start', 'stop', 'retry-frame', 'nav-back', 'nav-home', 'fit', 'zoom-out', 'zoom-in', 'fullscreen'].map((id) => elements[id]),
      addEventListener(name, listener) { documentListeners.set(name, listener); },
      createElement: (name) => {
        assert.equal(name, 'canvas');
        const canvas = { width: 0, height: 0 };
        let source = '';
        canvas.getContext = () => canvasUnavailable ? null : ({
          drawImage(image) { source = image.src.split(',').at(-1); },
          clearRect() {},
          getImageData() {
            const length = canvas.width * canvas.height * 4 - pixelTruncateBytes;
            const buffer = new ArrayBuffer(pixelByteOffset + length + pixelTailPadding);
            const data = mixedSignedPixels && !source.startsWith('0') ? new Int8Array(buffer, pixelByteOffset, length) : new Uint8Array(buffer, pixelByteOffset, length);
            pixelViews.push(data);
            if (distinctPadding && source.startsWith('0')) {
              const backing = new Uint8Array(buffer);
              if (pixelByteOffset) backing[0] = 1;
              if (pixelTailPadding) backing[backing.length - 1] = 1;
            }
            const points = pixelFrames.get(source);
            if (points) for (const [x, y, channel = 0] of points) data[(y * canvas.width + x) * 4 + channel] = 1;
            else if (source.startsWith('0')) data.fill(1);
            if (mixedSignedPixels) data[(8 * canvas.width + 9) * 4] = 255;
            return { data };
          }
        });
        return canvas;
      },
      documentElement: { style: { setProperty(name, value) { hostStyles.set(name, value); }, removeProperty(name) { hostStyles.delete(name); } } },
      fullscreenElement: null,
    },
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    Uint32Array: class extends Uint32Array {
      constructor(buffer, offset, length) {
        wordViewAttempts += 1;
        if (failWordViews === true || failWordViews === wordViewAttempts) throw new RangeError('Injected word view failure');
        super(buffer, offset, length);
        wordViews.push(this);
      }
    },
    Set: class extends Set {
      constructor(...args) { if (failDiagnosticScan) throw new Error('Injected diagnostic failure'); super(...args); }
    },
    Image: class extends Element { constructor() { super(); this.decodeGate = elements.stage.decodeGate; } },
    performance: { now: () => time },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context, { filename: 'src/app/main.mjs' });
  const take = (name) => {
    const index = sent.findIndex((message) => name.startsWith('ui/') ? message.method === name : message.method === 'tools/call' && message.params.name === name);
    assert.notEqual(index, -1, `Missing request: ${name}`);
    return sent.splice(index, 1)[0];
  };
  const reply = async (request, result) => {
    if (request.params?.name === 'preview_start' && !result.isError) {
      const info = { previewRecoveryProtocol: 1, previewSubscriptionProtocol: 1,
        subscriberId: `subscriber-${result.structuredContent?.sessionId}`, ...result.structuredContent };
      result = textResult(info);
      activeSession = info.sessionId ?? '';
    }
    if (request.params?.name === 'preview_frame' && result.structuredContent &&
        (result.structuredContent.sessionId === undefined || result.structuredContent.sessionId === 'test-session')) {
      result = { ...result, structuredContent: { ...result.structuredContent, sessionId: activeSession } };
    }
    windowListeners.get('message')({ source: parent, data: { jsonrpc: '2.0', id: request.id, result } });
    await flush();
  };
  const runPoll = async () => {
    const timer = [...timers].find(([, value]) => value.ms === pollIntervalMs);
    assert.ok(timer, 'A completed preview frame should schedule the next poll');
    timers.delete(timer[0]);
    timer[1].callback();
    await flush();
  };
  const runTimer = async (ms) => {
    const timer = [...timers].find(([, value]) => value.ms === ms);
    assert.ok(timer, `A ${ms}ms timer should be scheduled`);
    timers.delete(timer[0]);
    timer[1].callback();
    await flush();
  };
  const clickImage = (x, y) => {
    elements.stage.dispatch('pointerdown', { clientX: x, clientY: y, pointerId: 1 });
    elements.stage.dispatch('pointerup', { clientX: x, clientY: y, pointerId: 1 });
  };
  const resize = (target) => {
    for (const observer of resizeObservers) if (observer.targets.has(target)) {
      observer.callback([{ target, contentRect: { width: target.clientWidth, height: target.clientHeight } }], observer);
    }
  };
  return { elements, sent, timers, windowListeners, documentListeners, document: context.document, parent, hostStyles, pixelFrames, pixelViews, wordViews, take, reply, runPoll, runTimer, clickImage, resize,
    recordAction(...args) { context.recordAction(...args); },
    scanTargetMargin(...args) { return context.scanTargetMargin(...args); },
    getWordViewAttempts() { return wordViewAttempts; }, disableCanvas() { canvasUnavailable = true; }, advance(ms) { time += ms; } };
}

// Host height and safe areas are honored without losing values on partial context updates.
{
  const panel = createPanel();
  await panel.reply(panel.take('ui/initialize'), { hostContext: { containerDimensions: { maxHeight: 420, width: 320 },
    safeAreaInsets: { top: 4, right: 0, bottom: 24, left: 0 } } });
  assert.equal(panel.hostStyles.get('--preview-host-max-height'), '420px');
  assert.equal(panel.hostStyles.get('--preview-safe-bottom'), '24px');
  panel.windowListeners.get('message')({ source: panel.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
    params: { safeAreaInsets: { bottom: 12 } } } });
  assert.equal(panel.hostStyles.get('--preview-safe-top'), '4px');
  assert.equal(panel.hostStyles.get('--preview-safe-bottom'), '12px');
  assert.equal(panel.hostStyles.get('--preview-host-max-height'), '420px');
  panel.windowListeners.get('message')({ source: panel.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
    params: { containerDimensions: { height: 260, width: 320 }, safeAreaInsets: { bottom: -1 } } } });
  assert.equal(panel.hostStyles.get('--preview-host-max-height'), '260px');
  assert.equal(panel.hostStyles.get('--preview-safe-bottom'), '12px', 'Invalid safe area data must not replace a valid value');
  panel.windowListeners.get('message')({ source: panel.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
    params: { containerDimensions: { width: 320 } } } });
  assert.equal(panel.hostStyles.get('--preview-host-max-height'), '260px', 'Width-only updates must retain the host height');
  panel.windowListeners.get('message')({ source: panel.parent, data: { jsonrpc: '2.0', method: 'ui/notifications/host-context-changed',
    params: { containerDimensions: { maxHeight: undefined } } } });
  assert.equal(panel.hostStyles.has('--preview-host-max-height'), false, 'Explicitly removing the host height must restore viewport sizing');
}

// A rotated frame must stay in frame coordinates so the MCP layer can apply
// the same rotation transform that protects direct model actions.
{
  const panel = await readyPanel();
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'session-rotated', deviceId: 'A', pollMs: 500 }));
  await panel.reply(panel.take('preview_frame'), imageResult('A', 720, 1280, 1, 90));
  panel.clickImage(167.5, 360);
  await flush();
  const rotatedTap = panel.take('preview_action').params.arguments;
  assert.equal(rotatedTap.coordinateSpace, 'frame');
  assert.equal(rotatedTap.x, 360);
  assert.equal(rotatedTap.y, 640);
}

// A half-resolution preview must map pointer coordinates back to device pixels.
{
  const panel = await readyPanel();
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'session-scaled', deviceId: 'A', pollMs: 500 }));
  await panel.reply(panel.take('preview_frame'), imageResult('A', 1260, 2720, 2));
  panel.clickImage(167.5, 360);
  await flush();
  const scaledTap = panel.take('preview_action').params.arguments;
  assert.equal(scaledTap.action, 'tap');
  assert.equal(scaledTap.deviceId, 'A');
  assert.equal(scaledTap.sessionId, 'session-scaled');
  assert.equal(scaledTap.seq, nextFrameSeq);
  assert.equal(scaledTap.frameId, `frame-${nextFrameSeq}`);
  assert.equal(scaledTap.x, 2520 / 2, 'Scaled preview x must use device pixels');
  assert.equal(scaledTap.y, 5440 / 2, 'Scaled preview y must use device pixels');
}

async function readyPanel(options) {
  const panel = createPanel(options);
  await panel.reply(panel.take('ui/initialize'), { hostContext: {} });
  await panel.reply(panel.take('list_devices'), textResult({ devices: ['A', 'B'] }));
  assert.equal(panel.elements.devices.value, 'A');
  assert.equal(panel.elements.stage.hidden, true, 'Hide the image until the first valid frame');
  return panel;
}

async function start(panel, id = 'A', width = 1260, height = 2720) {
  panel.elements.start.dispatch('click');
  const startRequest = panel.take('preview_start');
  assert.equal(startRequest.params.arguments.subscriber, true, 'Each panel must own an independent subscription');
  await panel.reply(startRequest, textResult({ sessionId: `session-${id}`, deviceId: id, pollMs: 500 }));
  const firstFrame = panel.take('preview_frame');
  assert.equal(firstFrame.params.arguments.sessionId, `session-${id}`);
  assert.equal(firstFrame.params.arguments.subscriberId, `subscriber-session-${id}`);
  await panel.reply(firstFrame, imageResult(id, width, height));
  assert.equal(panel.elements.stage.hidden, false, 'Show the decoded frame');
  assert.equal(panel.elements.stage.draggable, false, 'Decoded preview frames must not start a native drag');
  assert.equal(panel.elements['stage-overlay'].hidden, true, 'Hide the overlay after the first frame');
  assert.match(panel.elements.metrics.textContent, new RegExp(`${width}×${height}`));
  assert.match(panel.elements.metrics.textContent, /42ms · jpeg/);
  assert.match(panel.elements.metrics.textContent, /render \d+ms/);
}

// Legacy hosts cannot safely isolate panels and must not receive start or stop requests.
{
  const panel = await readyPanel({ hostSubscriptionProtocol: 0 });
  assert.equal(panel.elements.start.disabled, true);
  assert.match(panel.elements.status.textContent, /outdated.*reconnect/i);
  panel.elements.start.dispatch('click');
  panel.windowListeners.get('pagehide')();
  await flush();
  assert.ok(!panel.sent.some((message) => ['preview_start', 'preview_stop'].includes(message.params?.name)));
}

// An incomplete subscription cannot be used or stopped without a panel token.
{
  const panel = await readyPanel();
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'shared-session', deviceId: 'A', subscriberId: null }));
  assert.match(panel.elements.status.textContent, /outdated.*reconnect/i);
  assert.equal(panel.elements.stage.hidden, true);
  assert.ok(!panel.sent.some((message) => ['preview_stop', 'preview_frame'].includes(message.params?.name)));
}

// A late start for an abandoned panel releases only its own subscription.
{
  const panel = await readyPanel();
  panel.elements.start.dispatch('click');
  const oldStart = panel.take('preview_start');
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  await panel.reply(oldStart, textResult({ sessionId: 'shared-session', deviceId: 'A', subscriberId: 'old-panel' }));
  const release = panel.take('preview_stop');
  assert.deepEqual({ ...release.params.arguments }, { sessionId: 'shared-session', subscriberId: 'old-panel' });
  assert.equal(panel.elements.devices.value, 'B');
}

// An expired subscription must reset the panel instead of polling or retrying with a dead token.
for (const phase of ['poll', 'action', 'recovery']) {
  const panel = await readyPanel();
  await start(panel);
  if (phase === 'action') {
    panel.clickImage(100, 100);
    await flush();
  } else {
    await panel.runPoll();
    if (phase === 'recovery') {
      await panel.reply(panel.take('preview_frame'), { isError: true, content: [{ type: 'text', text: 'temporary failure' }] });
      await flush();
    }
  }
  const request = panel.take(phase === 'action' ? 'preview_action' : 'preview_frame');
  await panel.reply(request, { ...textResult({ errorCode: 'PREVIEW_UNAVAILABLE', stage: 'preview_subscription' }), isError: true });
  assert.match(panel.elements.status.textContent, /subscription expired or changed/i);
  assert.equal(panel.elements.stage.hidden, true);
  assert.equal(panel.elements.start.disabled, false);
  assert.equal(panel.elements['retry-frame'].hidden, true);
  const release = panel.take('preview_stop');
  assert.deepEqual({ ...release.params.arguments }, { sessionId: 'session-A', subscriberId: 'subscriber-session-A' });
}

// Screen queries poll promptly without asking the device to take another screenshot.
{
  const panel = await readyPanel();
  await start(panel);
  const firstImage = panel.elements.stage;
  const previousSeq = nextFrameSeq;
  await panel.runTimer(125);
  const poll = panel.take('preview_frame');
  assert.equal(poll.params.arguments.afterSeq, previousSeq);
  assert.equal(poll.params.arguments.waitMs, undefined, 'Routine reads must not block the input queue');
  assert.equal(panel.sent.filter((message) => message.params?.name === 'preview_frame').length, 0, 'Only one read may be in flight');
  await panel.reply(poll, imageResult('A'));
  assert.notEqual(panel.elements.stage, firstImage, 'A newly available frame must be displayed on the next short poll');
  assert.ok([...panel.timers.values()].some(({ ms }) => ms === 125));
  panel.clickImage(100, 100);
  await flush();
  const action = panel.take('preview_action');
  assert.equal(action.params.arguments.action, 'tap', 'A completed short poll must not delay an action');
  await panel.reply(action, textResult({}));
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  panel.elements.stop.dispatch('click');
  await flush();
  assert.ok(![...panel.timers.values()].some(({ ms }) => ms === 125), 'Stopping preview cancels the next read');
}

// An in-flight routine read is nonblocking and the following preflight remains nonblocking.
{
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel);
  await panel.runTimer(125);
  const poll = panel.take('preview_frame');
  assert.equal(poll.params.arguments.waitMs, undefined);
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Wait for the in-flight read before acting');
  const noNewFrame = { structuredContent: { deviceId: 'A', sessionId: 'session-A', connected: true,
    seq: poll.params.arguments.afterSeq, frame: null } };
  await panel.reply(poll, noNewFrame);
  const preflight = panel.take('preview_frame');
  assert.equal(preflight.params.arguments.waitMs, undefined, 'Preflight must also avoid a long poll');
  await panel.reply(preflight, noNewFrame);
  assert.equal(panel.take('preview_action').params.arguments.action, 'tap');
}

// Gesture type depends on visible pointer movement, not source resolution or zoom.
for (const [width, boxWidth] of [[1260, 315], [720, 315], [1260, 630]]) {
  for (const [distance, expected] of [[4, 'tap'], [20, 'swipe']]) {
    const panel = await readyPanel();
    await start(panel, 'A', width, width * 2);
    panel.elements.stage.box.width = boxWidth;
    panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
    panel.elements.stage.dispatch('pointerup', { clientX: 100 + distance, clientY: 100, pointerId: 1 });
    await flush();
    assert.equal(panel.take('preview_action').params.arguments.action, expected,
      `${distance}px movement must be ${expected} for ${width}px frame at ${boxWidth}px display`);
  }
}

// Right, middle and non-primary pointers must never inject a device action.
for (const event of [{ button: 2 }, { button: 1 }, { isPrimary: false }]) {
  const panel = await readyPanel();
  await start(panel);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1, ...event });
  panel.elements.stage.dispatch('pointerup', { clientX: 100, clientY: 100, pointerId: 1, ...event });
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  assert.equal(panel.elements['frame-shell'].capturedPointerId, undefined);
}
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  panel.elements.stage.dispatch('pointerup', { clientX: 100, clientY: 100, pointerId: 1, button: 2 });
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// Frame and action timings distinguish local waiting from device input.
{
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel);
  assert.match(panel.elements.metrics.title, /decode 0ms.*hold 0ms.*commit 0ms/);
  const seq = nextFrameSeq;
  panel.clickImage(100, 100);
  await flush();
  const preflight = panel.take('preview_frame');
  panel.advance(7);
  await panel.reply(preflight, { structuredContent: { deviceId: 'A', sessionId: 'session-A', connected: true, seq, frame: null } });
  const action = panel.take('preview_action');
  panel.advance(10);
  await panel.reply(action, textResult({ metrics: { actionMs: 10, actionPrepareMs: 2, actionInputMs: 8, inputMethod: 'uinput', nextFrameAfterSeq: seq } }));
  const postFrame = panel.take('preview_frame');
  panel.advance(15);
  const captured = imageResult('A');
  captured.structuredContent.metrics.captureStages = { combinedMs: 12 };
  await panel.reply(postFrame, captured);
  assert.match(panel.elements.metrics.title, /queue 0ms.*preflight 7ms.*compare 0ms.*input 8ms.*post-frame 15ms.*total 32ms/);
  assert.match(panel.elements.metrics.title, /method uinput/);
  assert.match(panel.elements['action-metrics'].textContent, /Last tap: new frame decoded; business result unconfirmed.*input 8ms \(uinput\).*decoded frame capture combined 12ms.*pointer release to frame commit 32ms/);
  assert.match(panel.elements['action-summary'].textContent, /tap: n=1, total n=1 p50 32ms p95 32ms.*input n=1 p50 8ms p95 8ms.*canceled 0, failed\/unknown 0.*swipe: n=0, total n=0 p50 unavailable/);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  panel.elements['frame-shell'].dispatch('pointercancel', { pointerId: 8 });
  assert.match(panel.elements['action-metrics'].textContent, /canceled.*pointercancel.*input not sent/);
  assert.match(panel.elements['action-summary'].textContent, /unclassified canceled 1/);
  assert.match(panel.elements['action-cancellations'].textContent, /gesture: pointercancel.*gesture: pointercancel ×1/);
  assert.doesNotMatch(panel.elements.metrics.title, /method uinput/, 'A canceled gesture must not show the previous action timings');
}

// Capture path describes the decoded action frame, including missing stage values.
for (const [stages, expected] of [
  [{ snapshotMs: 31, transferMs: 7, readMs: 2 }, /decoded frame capture file transfer \(direct or fallback\): snapshot 31ms, transfer 7ms, read 2ms/],
  [{ snapshotMs: 31 }, /decoded frame capture file transfer \(direct or fallback\): snapshot 31ms, transfer unavailable, read unavailable/],
  [undefined, /decoded frame capture unavailable/],
]) {
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), textResult({ metrics: { nextFrameAfterSeq: nextFrameSeq } }));
  const captured = imageResult('A');
  if (stages) captured.structuredContent.metrics.captureStages = stages;
  await panel.reply(panel.take('preview_frame'), captured);
  assert.match(panel.elements['action-metrics'].textContent, expected);
}

// Refresh while the pointer is held clears the previous action's hover timings.
{
  const panel = await readyPanel();
  await start(panel);
  const seq = nextFrameSeq;
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), textResult({ metrics: { inputMethod: 'uinput', nextFrameAfterSeq: seq } }));
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.match(panel.elements.metrics.title, /method uinput/);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), { isError: true, content: [{ type: 'text', text: 'temporary failure' }] });
  assert.doesNotMatch(panel.elements.metrics.title, /method uinput/);
  assert.match(panel.elements['action-metrics'].textContent, /canceled.*preview refreshing/);
}

// Session statistics cap each action's samples and do not count canceled gestures as frame samples.
{
  const panel = await readyPanel();
  await start(panel);
  for (let duration = 1; duration <= 31; duration += 1) {
    panel.clickImage(100, 100);
    await flush();
    const action = panel.take('preview_action');
    panel.advance(duration);
    await panel.reply(action, textResult({ metrics: { nextFrameAfterSeq: nextFrameSeq } }));
    await panel.reply(panel.take('preview_frame'), imageResult('A'));
  }
  assert.match(panel.elements['action-summary'].textContent, /tap: n=30, total n=30 p50 16ms p95 30ms/);
  assert.match(panel.elements['action-metrics'].textContent, /input unavailable \(unavailable\)/);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  panel.elements.stage.dispatch('pointerup', { clientX: 160, clientY: 180, pointerId: 1 });
  await flush();
  const swipe = panel.take('preview_action');
  panel.advance(40);
  await panel.reply(swipe, textResult({ metrics: { nextFrameAfterSeq: nextFrameSeq } }));
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.match(panel.elements['action-summary'].textContent, /swipe: n=1, total n=1 p50 40ms p95 40ms/);
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), textResult({ metrics: {} }));
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.match(panel.elements['action-metrics'].textContent, /action-to-frame order unconfirmed/);
  assert.match(panel.elements['action-summary'].textContent, /tap: n=30, total n=30.*failed\/unknown 1/);
  assert.equal(panel.elements['action-cancellations'].textContent, 'Recent cancellations: none.', 'An uncertain action is not a canceled gesture');
  panel.elements.stop.dispatch('click');
  assert.equal(panel.elements['action-summary'].textContent, 'Session samples: none.');
  assert.equal(panel.elements['action-metrics'].textContent, 'No action measured yet.');
  assert.equal(panel.elements['action-cancellations'].textContent, 'Recent cancellations: none.');
}

// Recent cancellation reasons survive subsequent actions, stay bounded, and reset with the session.
{
  const panel = await readyPanel();
  await start(panel);
  for (let index = 0; index < 11; index += 1) {
    panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: index });
    panel.elements['frame-shell'].dispatch('pointercancel', { pointerId: index });
  }
  assert.match(panel.elements['action-cancellations'].textContent, /gesture: pointercancel ×10/);
  panel.clickImage(100, 100);
  await flush();
  const action = panel.take('preview_action');
  await panel.reply(action, textResult({ metrics: { nextFrameAfterSeq: nextFrameSeq } }));
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.match(panel.elements['action-metrics'].textContent, /Last tap: new frame decoded/);
  assert.match(panel.elements['action-cancellations'].textContent, /gesture: pointercancel ×10/);
  assert.doesNotMatch(panel.elements['action-cancellations'].textContent, /100/);
  panel.elements.stop.dispatch('click');
  assert.equal(panel.elements['action-cancellations'].textContent, 'Recent cancellations: none.');
  assert.equal(panel.elements.status.dataset.lastCancellation, '', 'Last cancellation must be cleared when the preview session ends');
}

// Retained diagnostics never copy new location or image fields from intermediate details.
{
  const panel = createPanel();
  panel.elements.status.dataset.gestureDiagnostic = JSON.stringify({ reason: 'pixel_extent' });
  panel.elements.status.dataset.gesturePixelDiagnostic = JSON.stringify({ changedPixels: 2, widthRatio: 0.1, heightRatio: 0.2,
    fullScan: { complete: true, changedPixels: 2, grid4x4: [1, 1], pathMarginIntersection: false },
    regionSummary: { regions: [{ pixels: 2, width: 3, height: 4, x: 123, y: 456, image: 'sensitive' }],
      truncated: false, position: 'sensitive' } });
  panel.recordAction('tap', 'canceled', '', undefined, 'pixel_extent');
  const retained = JSON.parse(panel.elements.status.dataset.lastCancellation);
  assert.deepEqual(retained.pixels.regionSummary, { regions: [{ pixels: 2, width: 3, height: 4 }], truncated: false });
  assert.doesNotMatch(JSON.stringify(retained), /grid4x4|sensitive|"x"|"y"|position/);
  panel.elements.status.dataset.gesturePixelDiagnostic = JSON.stringify({ fullScan: { complete: false, stopReason: 'sensitive' } });
  panel.recordAction('tap', 'canceled', '', undefined, 'pixel_extent');
  assert.equal(JSON.parse(panel.elements.status.dataset.lastCancellation).pixels.fullScanStopReason, undefined);
  assert.doesNotMatch(panel.elements.status.dataset.lastCancellation, /sensitive/);
  panel.elements.status.dataset.gesturePixelDiagnostic = JSON.stringify({ fullScan: { complete: false, stopReason: 'limit_exceeded', targetMarginChanged: 'sensitive' } });
  panel.recordAction('tap', 'canceled', '', undefined, 'pixel_extent');
  assert.equal(JSON.parse(panel.elements.status.dataset.lastCancellation).pixels.targetMarginChanged, null);
  assert.doesNotMatch(panel.elements.status.dataset.lastCancellation, /sensitive/);
  panel.elements.status.dataset.gesturePixelDiagnostic = JSON.stringify({ fullScan: { complete: false, stopReason: 'limit_exceeded', targetMarginChanged: true } });
  panel.recordAction('swipe', 'canceled', '', undefined, 'pixel_extent');
  assert.equal(JSON.parse(panel.elements.status.dataset.lastCancellation).pixels.targetMarginChanged, undefined, 'tap-only diagnostic must not leak into a swipe');
}

// Host display modes are requested only when advertised; partial updates retain capabilities.
{
  const panel = await readyPanel();
  await start(panel);
  const hostChange = (params) => panel.windowListeners.get('message')({ source: panel.parent, data: {
    jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params
  } });
  hostChange({ displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] });
  hostChange({ theme: 'dark' });
  assert.equal(panel.elements.fullscreen.dataset.hostDisplayModes, 'inline,fullscreen');
  panel.elements.fullscreen.dispatch('click');
  const enter = panel.take('ui/request-display-mode');
  assert.equal(enter.params.mode, 'fullscreen');
  hostChange({ displayMode: 'inline', theme: 'dark' });
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'No device action during host mode change');
  await panel.reply(enter, { mode: 'fullscreen' });
  assert.equal(panel.elements.fullscreen.dataset.hostDisplayMode, 'fullscreen');
  assert.equal(panel.elements.fullscreen['aria-label'], 'Collapse preview');
  assert.equal(panel.elements.fullscreen.title, 'Collapse preview');
  panel.elements.fullscreen.dispatch('click');
  const deniedExit = panel.take('ui/request-display-mode');
  panel.windowListeners.get('message')({ source: panel.parent, data: { jsonrpc: '2.0', id: deniedExit.id, error: { message: 'denied' } } });
  await flush();
  assert.match(panel.elements.status.textContent, /unable to collapse preview/i);
  assert.equal(panel.elements.fullscreen['aria-label'], 'Collapse preview');
  panel.elements.fullscreen.dispatch('click');
  const exit = panel.take('ui/request-display-mode');
  assert.equal(exit.params.mode, 'inline');
  await panel.reply(exit, { mode: 'inline' });
  assert.equal(panel.elements.fullscreen['aria-label'], 'Fullscreen');

  // A later notification has authority over an older pending response.
  panel.elements.fullscreen.dispatch('click');
  const stale = panel.take('ui/request-display-mode');
  hostChange({ displayMode: 'fullscreen' });
  hostChange({ displayMode: 'inline' });
  await panel.reply(stale, { mode: 'fullscreen' });
  assert.equal(panel.elements.fullscreen.dataset.hostDisplayMode, 'inline');
  assert.match(panel.elements.status.textContent, /display mode unconfirmed/i);
  assert.equal(panel.elements['nav-home'].disabled, true);
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Conflicting host evidence must block device input');
  hostChange({ displayMode: 'inline' });
  assert.equal(panel.elements['nav-home'].disabled, false, 'A fresh host notification resolves uncertainty');

  panel.elements.fullscreen.dispatch('click');
  const enterConflict = panel.take('ui/request-display-mode');
  hostChange({ displayMode: 'fullscreen' });
  await panel.reply(enterConflict, { mode: 'inline' });
  assert.equal(panel.elements.fullscreen.dataset.hostDisplayMode, 'fullscreen', 'Do not overwrite the latest notification');
  assert.match(panel.elements.status.textContent, /display mode unconfirmed/i);
  assert.equal(panel.elements['nav-home'].disabled, true);
  hostChange({ displayMode: 'fullscreen' });
  assert.equal(panel.elements['nav-home'].disabled, false);

  panel.elements.fullscreen.dispatch('click');
  const exitConflict = panel.take('ui/request-display-mode');
  assert.equal(exitConflict.params.mode, 'inline');
  hostChange({ displayMode: 'inline' });
  await panel.reply(exitConflict, { mode: 'fullscreen' });
  assert.equal(panel.elements.fullscreen.dataset.hostDisplayMode, 'inline', 'Do not overwrite the latest notification on exit');
  assert.match(panel.elements.status.textContent, /display mode unconfirmed/i);
  assert.equal(panel.elements['nav-home'].disabled, true);
  hostChange({ displayMode: 'inline' });
  assert.equal(panel.elements['nav-home'].disabled, false);

  panel.elements.fullscreen.dispatch('click');
  const denied = panel.take('ui/request-display-mode');
  panel.windowListeners.get('message')({ source: panel.parent, data: { jsonrpc: '2.0', id: denied.id, error: { message: 'denied' } } });
  await flush();
  assert.equal(panel.elements.fullscreen.dataset.hostDisplayMode, 'inline');
  assert.match(panel.elements.status.textContent, /fullscreen.*unavailable/i);
  panel.elements.fullscreen.dispatch('click');
  const other = panel.take('ui/request-display-mode');
  await panel.reply(other, { mode: 'inline' });
  assert.equal(panel.elements.fullscreen.dataset.hostDisplayMode, 'inline');
  assert.match(panel.elements.status.textContent, /fullscreen.*unavailable/i);

  // An external host mode change, including host-driven Escape, cancels a held gesture.
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 4 });
  hostChange({ displayMode: 'fullscreen' });
  panel.elements.stage.dispatch('pointerup', { clientX: 100, clientY: 100, pointerId: 4 });
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  hostChange({ displayMode: 'inline' });
  assert.equal(panel.elements.fullscreen['aria-label'], 'Fullscreen');
}

// Fullscreen controls follow browser state, including Escape, and never inject device input.
{
  const panel = await readyPanel();
  await start(panel);
  const shell = panel.elements['frame-shell'];
  const exit = panel.elements['exit-fullscreen'];
  shell.requestFullscreen = async () => { panel.document.fullscreenElement = shell; panel.documentListeners.get('fullscreenchange')(); };
  panel.document.exitFullscreen = async () => { panel.document.fullscreenElement = null; panel.documentListeners.get('fullscreenchange')(); };
  panel.elements.fullscreen.dispatch('click');
  await flush();
  assert.equal(exit.hidden, false);
  assert.equal(panel.elements.fullscreen['aria-label'], 'Exit fullscreen');
  assert.equal(panel.elements.fullscreen.title, 'Exit fullscreen');
  exit.box = { left: 200, top: 30, width: 80, height: 40 };
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  panel.elements['frame-shell'].dispatch('pointerup', { clientX: 220, clientY: 50, pointerId: 8, target: shell });
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  assert.match(panel.elements.status.textContent, /fullscreen control/i);
  assert.equal(panel.elements['fullscreen-status'].hidden, false);
  assert.match(panel.elements['fullscreen-status'].textContent, /fullscreen control/i);
  let stopped = false;
  exit.dispatch('click', { stopPropagation() { stopped = true; } });
  await flush();
  assert.equal(stopped, true);
  assert.equal(exit.hidden, true);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  panel.elements.fullscreen.dispatch('click');
  await flush();
  panel.document.fullscreenElement = null;
  panel.documentListeners.get('fullscreenchange')();
  assert.equal(exit.hidden, true, 'Escape updates exit visibility');
  assert.equal(panel.elements.fullscreen['aria-label'], 'Fullscreen');
}

// Rejected fullscreen APIs produce an accessible status rather than an unhandled rejection.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements['frame-shell'].requestFullscreen = async () => { throw new Error('denied'); };
  panel.elements.fullscreen.dispatch('click');
  await flush();
  assert.match(panel.elements.status.textContent, /fullscreen.*unavailable/i);
  assert.equal(panel.elements.status.title, panel.elements.status.textContent);
  const shell = panel.elements['frame-shell'];
  panel.document.fullscreenElement = shell;
  panel.documentListeners.get('fullscreenchange')();
  panel.document.exitFullscreen = async () => { throw new Error('denied'); };
  panel.elements['exit-fullscreen'].dispatch('click', { stopPropagation() {} });
  await flush();
  assert.match(panel.elements['exit-fullscreen'].textContent, /press Esc/i);
}

// A fresh polling frame must not immediately erase a fullscreen gesture rejection.
{
  const panel = await readyPanel();
  await start(panel);
  panel.document.fullscreenElement = panel.elements['frame-shell'];
  panel.documentListeners.get('fullscreenchange')();
  panel.elements['exit-fullscreen'].box = { left: 260, top: 30, width: 40, height: 30 };
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  panel.elements.stage.box = { ...panel.elements.stage.box, left: 11 };
  panel.elements.stage.dispatch('pointerup', { clientX: 101, clientY: 101, pointerId: 1 });
  await flush();
  assert.match(panel.elements['fullscreen-status'].textContent, /Preview changed/);
  assert.equal(panel.elements['fullscreen-status'].hidden, false);
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.match(panel.elements.status.textContent, /Preview changed/);
  assert.equal(panel.elements['fullscreen-status'].hidden, false);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// A decoded frame without a post-action barrier remains visibly unconfirmed in fullscreen.
{
  const panel = await readyPanel();
  await start(panel);
  panel.document.fullscreenElement = panel.elements['frame-shell'];
  panel.documentListeners.get('fullscreenchange')();
  panel.elements['exit-fullscreen'].box = { left: 260, top: 30, width: 40, height: 30 };
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), textResult({ metrics: { actionMs: 1 } }));
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.match(panel.elements['fullscreen-status'].textContent, /result unknown/i);
  assert.equal(panel.elements['fullscreen-status'].hidden, false);
}

// A navigation request while the pointer is held does not silently discard the gesture.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  panel.elements['nav-home'].dispatch('click');
  panel.elements.stage.dispatch('pointerup', { clientX: 100, clientY: 100, pointerId: 1 });
  await flush();
  assert.match(panel.elements['action-cancellations'].textContent, /tap: another_action_pending/);
  assert.match(panel.elements.status.textContent, /still processing/i);
  assert.equal(panel.sent.filter((message) => message.params?.name === 'preview_action' && message.params.arguments.action === 'tap').length, 0);
}

// A scaled frame without device dimensions must not dispatch a coordinate action.
{
  const panel = await readyPanel();
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'session-A', deviceId: 'A', pollMs: 500 }));
  const scaled = imageResult('A');
  delete scaled.structuredContent.metrics.deviceWidth;
  delete scaled.structuredContent.metrics.deviceHeight;
  scaled.structuredContent.metrics.scaled = true;
  await panel.reply(panel.take('preview_frame'), scaled);
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  assert.match(panel.elements.status.textContent, /dimensions|calibrat/i);
}

// Two compact, separated changes may be ignored only for a swipe, and only
// when both are safely away from the entire gesture path.
for (const scenario of ['swipe', 'alpha', 'unaligned-alpha', 'unaligned-alpha-path', 'transparent-overlay-visual', 'precise-swipe', 'precise-tap', 'tap', 'back', 'home', 'line',
  'noise', 'third', 'pixel-over', 'area-over', 'path', 'endpoint', 'margin-edge', 'vertical-path', 'diagonal-path',
  'later-unsafe', 'no-canvas', 'rotation', 'session']) {
  const panel = await readyPanel({ autoPreflight: false, ...(scenario.startsWith('unaligned-') ? { pixelByteOffset: 1, pixelTailPadding: 3 } : {}) });
  await start(panel, 'A', 1200, 1920);
  const points = [];
  const blob = (left, top, width, height, count, channel = 0) => {
    let skipped = width * height - count;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (skipped && x > 0 && x < width - 1 && y > 0 && y < height - 1 && (x + y) % 2 === 0) {
        skipped--;
      } else points.push([left + x, top + y, channel]);
    }
    assert.equal(skipped, 0);
  };
  const channel = scenario.includes('alpha') ? 3 : 0;
  if (scenario === 'line') {
    for (let x = 40; x < 1040; x++) points.push([x, 40]);
  } else if (scenario === 'noise') {
    for (let x = 40; x < 1040; x += 10) points.push([x, 40]);
  } else if (scenario === 'pixel-over') {
    blob(40, 40, 60, 58, 3480);
  } else if (scenario === 'area-over') {
    blob(40, 40, 60, 57, 3320);
  } else {
    blob(40, 40, 16, 16, 199, channel);
  }
  if (scenario === 'path') blob(400, 1536, 8, 8, 57, channel);
  else if (scenario === 'endpoint') blob(193, 1500, 8, 8, 57, channel);
  else if (scenario === 'margin-edge') blob(400, 1472, 8, 8, 57, channel);
  else if (scenario === 'vertical-path') blob(600, 900, 8, 8, 57, channel);
  else if (scenario === 'diagonal-path') blob(500, 800, 8, 8, 57, channel);
  else blob(1100, 272, 8, 8, 57, channel);
  if (scenario === 'third') blob(600, 400, 8, 8, 57);
  if (scenario === 'unaligned-alpha-path') points.push([400, 1539, 3]);
  panel.pixelFrames.set('1200x1920', []);
  panel.pixelFrames.set('01200x1920', points);
  if (scenario.startsWith('precise-')) {
    for (const [key, value] of [['start-x', '16'], ['start-y', '80'], ['end-x', '76'], ['end-y', '80']]) {
      panel.elements[`precise-${key}`].value = value;
    }
    panel.elements['precise-bind'].dispatch('click');
    panel.elements[scenario].dispatch('click');
  } else if (scenario === 'tap') panel.clickImage(100, 100);
  else if (scenario === 'back' || scenario === 'home') panel.elements[`nav-${scenario}`].dispatch('click');
  else if (scenario === 'later-unsafe') {
    panel.elements.stage.dispatch('pointerdown', { clientX: 60, clientY: 565, pointerId: 1 });
    await panel.runPoll();
    const intermediate = imageResult('A', 1200, 1920);
    intermediate.structuredContent.frame.data = '01200x1920';
    await panel.reply(panel.take('preview_frame'), intermediate);
    panel.pixelFrames.set('001200x1920', [...points, [400, 1539]]);
    panel.elements.stage.dispatch('pointerup', { clientX: 250, clientY: 565, pointerId: 1 });
  }
  else {
    const from = scenario === 'vertical-path' ? [167.5, 200] : scenario === 'diagonal-path' ? [60, 100] : [60, 565];
    const to = scenario === 'vertical-path' ? [167.5, 580] : scenario === 'diagonal-path' ? [250, 580] : [250, 565];
    panel.elements.stage.dispatch('pointerdown', { clientX: from[0], clientY: from[1], pointerId: 1 });
    panel.elements.stage.dispatch('pointerup', { clientX: to[0], clientY: to[1], pointerId: 1 });
  }
  await flush();
  const preflight = panel.take('preview_frame');
  const newer = imageResult('A', 1200, 1920);
  newer.structuredContent.frame.data = scenario === 'later-unsafe' ? '001200x1920' : '01200x1920';
  if (scenario === 'rotation') newer.structuredContent.metrics.rotation = 90;
  if (scenario === 'session') newer.structuredContent.sessionId = 'other-session';
  if (scenario === 'no-canvas') panel.disableCanvas();
  await panel.reply(preflight, newer);
  // A transparent input overlay can produce the same pixels: this case documents
  // the authorized limitation of a guard based only on image differences.
  if (['swipe', 'alpha', 'unaligned-alpha', 'transparent-overlay-visual', 'precise-swipe'].includes(scenario)) {
    assert.equal(panel.take('preview_action').params.arguments.action, 'swipe', `${scenario} should be actionable`);
  } else {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), `${scenario} must cancel`);
  }
  if (scenario.startsWith('unaligned-')) assert.equal(panel.getWordViewAttempts(), 0, 'Unaligned pixel views must use exact byte comparison');
}

// Small localized changes far from the gesture must not prevent a tap, while
// changes near its target or spanning the display still block it.
for (const scenario of ['identical-pixels', 'small-far', 'target', 'alpha-target', 'guard-edge', 'guard-outside',
  'area-edge', 'area-over', 'width-edge', 'width-over', 'height-edge', 'height-over', 'wide-line', 'large', 'large-target', 'large-guard-edge', 'large-guard-outside', 'large-unaligned', 'count-limit',
  'dispersed', 'region-diagonal', 'region-many', 'no-canvas', 'scan-error', 'swipe-path', 'rotation', 'session', 'clock-far', 'status-dual', 'status-notification', 'status-map-distributed']) {
  const panel = await readyPanel({ autoPreflight: false, failDiagnosticScan: scenario === 'scan-error', ...(scenario === 'large-unaligned' ? { pixelByteOffset: 1 } : {}) });
  const testHeight = 1920;
  await start(panel, 'A', 1200, testHeight);
  const points = [];
  const fill = (left, top, right, bottom) => {
    for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) points.push([x, y]);
  };
  if (['small-far', 'swipe-path', 'rotation', 'session'].includes(scenario)) fill(687, 463, 728, 513);
  if (scenario === 'target') fill(342, 225, 347, 230);
  if (scenario === 'alpha-target') points.push([343, 226, 3]);
  if (scenario === 'guard-edge') points.push([403, 226]);
  if (scenario === 'guard-outside') points.push([404, 226]);
  if (scenario === 'area-edge') fill(700, 1000, 760, 1057);
  if (scenario === 'area-over') fill(700, 1000, 760, 1058);
  if (scenario === 'width-edge') fill(700, 1000, 760, 1001);
  if (scenario === 'width-over' || scenario === 'scan-error') fill(700, 1000, 761, 1001);
  if (scenario === 'height-edge') fill(700, 1000, 701, 1096);
  if (scenario === 'height-over') fill(700, 1000, 701, 1097);
  if (scenario === 'wide-line') fill(100, 1400, 1100, 1401);
  if (scenario.startsWith('large')) fill(700, 900, 850, 1050);
  if (scenario === 'large-target') points.push([343, 226]);
  if (scenario === 'large-guard-edge') points.push([403, 226]);
  if (scenario === 'large-guard-outside') points.push([404, 226]);
  if (scenario === 'count-limit') { fill(700, 900, 748, 972); points.push([748, 971]); }
  if (scenario === 'dispersed') points.push([700, 463], [780, 513]);
  if (scenario === 'region-diagonal') points.push([700, 1000], [701, 1001], [780, 1000]);
  if (scenario === 'region-many') for (let i = 0; i < 9; i++) points.push([700 + i * 10, 1000]);
  if (scenario === 'clock-far') {
    for (const x of [30, 43, 56, 69, 82]) fill(x, 20, x + 10, 44);
  }
  if (scenario.startsWith('status-')) {
    if (scenario === 'status-map-distributed') {
      fill(20, 20, 50, 40); fill(1100, 20, 1140, 40);
    } else { fill(20, 20, 70, 40); fill(1100, 20, 1140, 40); }
    if (scenario === 'status-map-distributed') fill(20, 272, 50, 273);
    if (scenario === 'status-notification') fill(50, 60, 1150, 100);
  }
  panel.pixelFrames.set(`1200x${testHeight}`, []);
  panel.pixelFrames.set(`01200x${testHeight}`, points);
  if (scenario === 'swipe-path') {
    panel.elements.stage.dispatch('pointerdown', { clientX: 50, clientY: 200, pointerId: 1 });
    panel.elements.stage.dispatch('pointerup', { clientX: 250, clientY: 200, pointerId: 1 });
  } else if (scenario === 'clock-far') {
    panel.elements.stage.dispatch('pointerdown', { clientX: 20, clientY: 560, pointerId: 1 });
    panel.elements.stage.dispatch('pointerup', { clientX: 150, clientY: 560, pointerId: 1 });
  }
  else panel.clickImage(100, 100);
  await flush();
  const preflight = panel.take('preview_frame');
  const newer = imageResult('A', 1200, testHeight);
  newer.structuredContent.frame.data = `01200x${testHeight}`;
  if (scenario === 'rotation') newer.structuredContent.metrics.rotation = 90;
  if (scenario === 'session') newer.structuredContent.sessionId = 'other-session';
  if (scenario === 'no-canvas') panel.disableCanvas();
  await panel.reply(preflight, newer);
  if (['identical-pixels', 'small-far', 'guard-outside', 'area-edge', 'width-edge', 'height-edge'].includes(scenario)) {
    const action = panel.take('preview_action').params.arguments;
    assert.equal(action.action, 'tap', `${scenario} should be actionable`);
    assert.equal(action.frameId, newer.structuredContent.frame.frameId);
  } else {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), `${scenario} must not send an action`);
    if (scenario === 'width-over') {
      assert.equal(JSON.parse(panel.elements.status.dataset.gestureDiagnostic).reason, 'pixel_extent');
      const pixelDiagnostic = JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic);
      assert.equal(pixelDiagnostic.changedPixels, 61);
      assert.equal(pixelDiagnostic.widthRatio, 61 / 1200);
      assert.equal(pixelDiagnostic.heightRatio, 1 / 1920);
      assert.deepEqual(pixelDiagnostic.regionSummary, { regions: [{ pixels: 61, width: 61, height: 1 }], truncated: false });
      assert.deepEqual(pixelDiagnostic.fullScan, { complete: true, changedPixels: 61, grid4x4: [0,0,0,0,0,0,0,0,0,0,61,0,0,0,0,0], pathMarginIntersection: false });
      const saved = JSON.parse(panel.elements.status.dataset.lastCancellation);
      assert.deepEqual(saved, { action: 'tap', reason: 'pixel_extent', pixels: { changedPixels: 61,
        widthRatio: 61 / 1200, heightRatio: 1 / 1920, fullScanComplete: true, totalChangedPixels: 61,
        pathMarginIntersection: false, regionSummary: { regions: [{ pixels: 61, width: 61, height: 1 }], truncated: false } } });
      panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
      assert.equal(panel.elements.status.dataset.gesturePixelDiagnostic, '', 'A new gesture clears the previous aggregate');
      assert.deepEqual(JSON.parse(panel.elements.status.dataset.lastCancellation), saved, 'The anonymous last cancellation must survive a new gesture');
      panel.elements['frame-shell'].dispatch('pointercancel', { pointerId: 8 });
    }
    if (scenario === 'no-canvas') {
      assert.equal(JSON.parse(panel.elements.status.dataset.gestureDiagnostic).reason, 'canvas_unavailable');
      assert.equal(JSON.parse(panel.elements.status.dataset.lastCancellation).pixels.fullScanStopReason, 'data_unavailable');
      assert.deepEqual(JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic), { changedPixels: null, widthRatio: null, heightRatio: null, fullScan: { complete: false, stopReason: 'data_unavailable' } });
      panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
      assert.equal(panel.elements.status.dataset.gestureDiagnostic, '', 'A new gesture must clear the previous rejection before release');
      panel.elements['frame-shell'].dispatch('pointercancel', { pointerId: 8 });
      assert.equal(panel.elements.status.dataset.gestureDiagnostic, '', 'A canceled gesture must not report the previous rejection');
    }
    if (scenario === 'target') assert.equal(JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic).fullScan.pathMarginIntersection, true);
    if (scenario === 'swipe-path') assert.equal(JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic).fullScan.pathMarginIntersection, true);
    if (scenario.startsWith('large')) {
      const saved = JSON.parse(panel.elements.status.dataset.lastCancellation);
      assert.equal(saved.pixels.fullScanStopReason, 'limit_exceeded');
      assert.equal(saved.pixels.targetMarginChanged, ['large-target', 'large-guard-edge'].includes(scenario));
      assert.doesNotMatch(JSON.stringify(saved), /"x"|"y"|image|position/);
    }
    if (scenario === 'count-limit') {
      const saved = JSON.parse(panel.elements.status.dataset.lastCancellation);
      assert.equal(saved.reason, 'pixel_count');
      assert.equal(saved.pixels.fullScanStopReason, 'limit_exceeded');
      assert.equal(saved.pixels.targetMarginChanged, false);
    }
    if (scenario === 'scan-error') {
      assert.equal(JSON.parse(panel.elements.status.dataset.lastCancellation).pixels.fullScanStopReason, 'scan_error');
    }
    if (scenario === 'dispersed') {
      const diagnostic = JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic);
      const scan = diagnostic.fullScan;
      assert.equal(scan.changedPixels, 2);
      assert.equal(scan.grid4x4.reduce((sum, count) => sum + count, 0), 2);
      assert.equal(scan.pathMarginIntersection, false);
      assert.deepEqual(diagnostic.regionSummary, { regions: [{ pixels: 1, width: 1, height: 1 }, { pixels: 1, width: 1, height: 1 }], truncated: false });
    }
    if (scenario === 'region-many') {
      const diagnostic = JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic);
      assert.equal(diagnostic.regionSummary.regions.length, 8);
      assert.equal(diagnostic.regionSummary.truncated, true);
      assert.deepEqual(Object.keys(diagnostic.regionSummary.regions[0]).sort(), ['height', 'pixels', 'width']);
    }
    if (scenario === 'region-diagonal') {
      const diagnostic = JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic);
      assert.deepEqual(diagnostic.regionSummary, { regions: [{ pixels: 2, width: 2, height: 2 }, { pixels: 1, width: 1, height: 1 }], truncated: false });
    }
    if (scenario === 'area-over') assert.equal(JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic).regionSummary, undefined);
  }
}

// Target-area diagnostics are bounded, exact at the image edge, and fail closed.
{
  const panel = createPanel();
  const before = new Uint8Array(100 * 100 * 4), after = new Uint8Array(before.length);
  assert.equal(panel.scanTargetMargin(before, after, 100, 100, { x: 0, y: 0 }), false);
  after[(5 * 100 + 5) * 4 + 3] = 1;
  assert.equal(panel.scanTargetMargin(before, after, 100, 100, { x: 0, y: 0 }), true, 'inclusive margin and alpha changes must be observed');
  after.fill(0);
  after[6 * 4] = 1;
  assert.equal(panel.scanTargetMargin(before, after, 100, 100, { x: 0, y: 0 }), false, 'pixels outside the margin do not count');
  assert.equal(panel.scanTargetMargin(before, after.subarray(0, -1), 100, 100, { x: 0, y: 0 }), null);
  assert.equal(panel.scanTargetMargin(before, after, 100, 100, { x: -1, y: 0 }), null);
  assert.equal(panel.scanTargetMargin(new Uint16Array(before.length), after, 100, 100, { x: 0, y: 0 }), null);
  assert.equal(panel.scanTargetMargin(new Int8Array(before.length), after, 100, 100, { x: 0, y: 0 }), null);
  const detached = new Uint8Array(before.length);
  structuredClone(detached.buffer, { transfer: [detached.buffer] });
  assert.equal(panel.scanTargetMargin(detached, after, 100, 100, { x: 0, y: 0 }), null, 'detached buffers must not produce a trusted result');
  after.fill(0);
  after[(99 * 100 + 99) * 4] = 1;
  assert.equal(panel.scanTargetMargin(before, after, 100, 100, { x: 99, y: 99 }), true, 'image-end target must be clamped');
  const broken = new Proxy({ length: before.length }, { get(target, key) { if (key === 'length') return target.length; throw new Error('private detail'); } });
  assert.equal(panel.scanTargetMargin(broken, after, 100, 100, { x: 0, y: 0 }), null);
  let reads = 0;
  const oversized = new Proxy({ length: 5000 * 5000 * 4 }, { get(target, key) { if (key === 'length') return target.length; reads++; return 0; } });
  assert.equal(panel.scanTargetMargin(oversized, oversized, 5000, 5000, { x: 2500, y: 2500 }), null);
  assert.equal(reads, 0, 'over-budget target regions must not read pixel data');
}

// Pixel comparison must use only the exact image view and preserve alpha and fallback behavior.
for (const scenario of ['aligned-alpha', 'unaligned-alpha', 'failed-word-view', 'failed-second-word-view', 'truncated-alpha', 'mixed-signed', 'aligned-padding']) {
  const options = scenario === 'aligned-alpha' ? { pixelByteOffset: 4, pixelTailPadding: 8 }
    : scenario === 'unaligned-alpha' ? { pixelByteOffset: 1, pixelTailPadding: 3 }
      : scenario === 'failed-word-view' ? { failWordViews: true }
        : scenario === 'failed-second-word-view' ? { failWordViews: 2 }
          : scenario === 'truncated-alpha' ? { pixelTruncateBytes: 1 }
            : scenario === 'mixed-signed' ? { mixedSignedPixels: true }
        : { pixelByteOffset: 4, pixelTailPadding: 8, distinctPadding: true };
  const panel = await readyPanel({ autoPreflight: false, ...options });
  await start(panel, 'A', 32, 64);
  panel.pixelFrames.set('32x64', []);
  panel.pixelFrames.set('032x64', ['aligned-padding', 'mixed-signed'].includes(scenario) ? [] : [[9, 8, 3]]);
  panel.clickImage(100, 100);
  await flush();
  const preflight = panel.take('preview_frame');
  const newer = imageResult('A', 32, 64);
  newer.structuredContent.frame.data = '032x64';
  await panel.reply(preflight, newer);
  if (scenario === 'aligned-padding') {
    assert.equal(panel.take('preview_action').params.arguments.action, 'tap', 'Bytes outside the image view must not affect comparisons');
  } else {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), `${scenario}: alpha change near target must cancel`);
    const scan = JSON.parse(panel.elements.status.dataset.gesturePixelDiagnostic).fullScan;
    if (scenario === 'truncated-alpha') {
      assert.equal(scan.complete, false);
      assert.equal(JSON.parse(panel.elements.status.dataset.lastCancellation).pixels.fullScanStopReason, 'data_unavailable');
    }
    else assert.equal(scan.changedPixels, 1);
  }
  if (['unaligned-alpha', 'truncated-alpha', 'mixed-signed'].includes(scenario)) assert.equal(panel.getWordViewAttempts(), 0, `${scenario}: incompatible data must use byte comparison`);
  else {
    assert.ok(panel.getWordViewAttempts() > 0, `${scenario}: aligned data must try the word view`);
    if (!scenario.startsWith('failed-')) {
      assert.ok(panel.wordViews.length >= 2);
      for (const view of panel.wordViews) assert.ok(panel.pixelViews.some((pixels) => view.buffer === pixels.buffer && view.byteOffset === pixels.byteOffset && view.byteLength === pixels.byteLength), 'Word views must be zero-copy and bounded to the image');
    }
  }
}

// Two status-bar changes must never relax the stricter Back/Home policy.
for (const action of ['back', 'home']) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel, 'A', 1200, 1920);
  const points = [];
  for (let y = 20; y < 40; y++) {
    for (let x = 20; x < 70; x++) points.push([x, y]);
    for (let x = 1100; x < 1140; x++) points.push([x, y]);
  }
  panel.pixelFrames.set('1200x1920', []);
  panel.pixelFrames.set('01200x1920', points);
  panel.elements[`nav-${action}`].dispatch('click');
  await flush();
  const newer = imageResult('A', 1200, 1920);
  newer.structuredContent.frame.data = '01200x1920';
  await panel.reply(panel.take('preview_frame'), newer);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), `${action} must cancel on status-bar change`);
}

// Navigation still requires identical pixels; swipes may tolerate a small remote change.
for (const action of ['swipe', 'back', 'home']) for (const changed of [false, true]) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel, 'A', 1200, 1920);
  panel.pixelFrames.set('1200x1920', []);
  panel.pixelFrames.set('01200x1920', changed ? [[700, 1000]] : []);
  if (action === 'swipe') {
    panel.elements.stage.dispatch('pointerdown', { clientX: 50, clientY: 200, pointerId: 1 });
    panel.elements.stage.dispatch('pointerup', { clientX: 250, clientY: 200, pointerId: 1 });
  } else panel.elements[`nav-${action}`].dispatch('click');
  await flush();
  const newer = imageResult('A', 1200, 1920);
  newer.structuredContent.frame.data = '01200x1920';
  await panel.reply(panel.take('preview_frame'), newer);
  if (changed && action !== 'swipe') assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  else assert.equal(panel.take('preview_action').params.arguments.action, action);
}

// A swipe accepts only a small change away from every point on its path.
for (const scenario of ['far', 'path-middle', 'path-margin', 'near-start', 'near-end', 'large', 'rotation', 'dimensions']) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel, 'A', 1200, 1920);
  panel.pixelFrames.set('1200x1920', []);
  const points = scenario === 'far' || scenario === 'rotation' || scenario === 'dimensions' ? [[700, 1000]]
    : scenario === 'path-middle' ? [[500, 508]] : scenario === 'path-margin' ? [[500, 568]]
    : scenario === 'near-start' ? [[152, 508]] : scenario === 'near-end' ? [[914, 508]] : [[600, 1000], [800, 1000]];
  panel.pixelFrames.set('01200x1920', points);
  panel.elements.stage.dispatch('pointerdown', { clientX: 50, clientY: 200, pointerId: 1 });
  panel.elements.stage.dispatch('pointerup', { clientX: 250, clientY: 200, pointerId: 1 });
  await flush();
  const newer = imageResult('A', 1200, 1920);
  newer.structuredContent.frame.data = '01200x1920';
  if (scenario === 'rotation') newer.structuredContent.metrics.rotation = 90;
  if (scenario === 'dimensions') newer.structuredContent.metrics.deviceWidth = 2400;
  await panel.reply(panel.take('preview_frame'), newer);
  if (scenario === 'far') {
    const action = panel.take('preview_action').params.arguments;
    assert.equal(action.action, 'swipe');
    assert.equal(action.frameId, newer.structuredContent.frame.frameId);
  } else {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), `${scenario} must cancel`);
    assert.match(panel.elements['action-metrics'].textContent, /Last swipe: canceled.*input not sent/);
    assert.match(panel.elements['action-summary'].textContent, /swipe: n=0, total n=0 p50 unavailable.*canceled 1/);
  }
}

// For diagonal swipes, protect the actual line, not its entire bounding box.
for (const [point, allowed] of [[[530, 508], false], [[250, 700], true]]) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel, 'A', 1200, 1920);
  panel.pixelFrames.set('1200x1920', []);
  panel.pixelFrames.set('01200x1920', [point]);
  panel.elements.stage.dispatch('pointerdown', { clientX: 50, clientY: 100, pointerId: 1 });
  panel.elements.stage.dispatch('pointerup', { clientX: 250, clientY: 300, pointerId: 1 });
  await flush();
  const newer = imageResult('A', 1200, 1920);
  newer.structuredContent.frame.data = '01200x1920';
  await panel.reply(panel.take('preview_frame'), newer);
  if (allowed) assert.equal(panel.take('preview_action').params.arguments.action, 'swipe');
  else assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// The same small-change rules apply when the next frame arrives while a
// pointer gesture is held; the hold must not strand the preflight queue.
{
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel, 'A', 1200, 1920);
  panel.pixelFrames.set('1200x1920', []);
  const points = [];
  for (let y = 463; y < 513; y += 1) for (let x = 687; x < 728; x += 1) points.push([x, y]);
  panel.pixelFrames.set('01200x1920', points);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  await panel.runPoll();
  const newer = imageResult('A', 1200, 1920);
  newer.structuredContent.frame.data = '01200x1920';
  await panel.reply(panel.take('preview_frame'), newer);
  panel.elements['frame-shell'].dispatch('pointerup', { clientX: 100, clientY: 100, pointerId: 8 });
  await flush();
  await panel.reply(panel.take('preview_frame'), { structuredContent: {
    connected: true, deviceId: 'A', sessionId: 'session-A', seq: newer.structuredContent.seq, frame: null
  } });
  assert.equal(panel.take('preview_action').params.arguments.frameId, newer.structuredContent.frame.frameId);
}

// Actions synchronize the currently displayed frame before sending device input.
for (const action of ['tap', 'back', 'home']) {
  for (const changed of ['none', 'pixels', 'rotation']) {
    const panel = await readyPanel({ autoPreflight: false });
    await start(panel);
    const visibleSeq = nextFrameSeq;
    if (action === 'tap') panel.clickImage(100, 100);
    else panel.elements[`nav-${action}`].dispatch('click');
    await flush();
    const preflight = panel.take('preview_frame');
    assert.equal(preflight.params.arguments.afterSeq, visibleSeq);
    assert.equal(preflight.params.arguments.waitMs, undefined, 'Preflight must not long-poll');
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
    const newer = imageResult('A');
    if (changed === 'pixels') newer.structuredContent.frame.data = '01260x2720';
    if (changed === 'rotation') newer.structuredContent.metrics.rotation = 90;
    await panel.reply(preflight, newer);
    if (changed === 'none') {
      const sent = panel.take('preview_action').params.arguments;
      assert.equal(sent.action, action);
      assert.equal(sent.seq, newer.structuredContent.seq);
      assert.equal(sent.frameId, newer.structuredContent.frame.frameId);
    } else {
      assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
      assert.match(panel.elements.status.textContent, /changed.*try again/i);
    }
  }
}

// A device change during preflight must never dispatch the old device's action.
for (const action of ['tap', 'back', 'home']) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel);
  if (action === 'tap') panel.clickImage(100, 100);
  else panel.elements[`nav-${action}`].dispatch('click');
  await flush();
  const preflight = panel.take('preview_frame');
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  await panel.reply(preflight, imageResult('A'));
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// No new frame is safe only when its sequence has not advanced and the device is connected.
for (const response of ['unchanged', 'advanced', 'disconnected']) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel);
  const visibleSeq = nextFrameSeq;
  panel.clickImage(100, 100);
  await flush();
  const preflight = panel.take('preview_frame');
  await panel.reply(preflight, { structuredContent: { deviceId: 'A', connected: response !== 'disconnected',
    seq: visibleSeq + (response === 'advanced' ? 1 : 0), frame: null } });
  if (response === 'unchanged') {
    const action = panel.take('preview_action').params.arguments;
    assert.equal(action.seq, visibleSeq);
    assert.equal(action.frameId, `frame-${visibleSeq}`);
  } else {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
    assert.equal(panel.elements.stage.hidden, response === 'disconnected');
    if (response === 'disconnected') assert.match(panel.elements.status.textContent, /disconnect/i);
    else {
      const refresh = panel.take('preview_frame');
      assert.equal(refresh.params.arguments.forceRefresh, true);
      await panel.reply(refresh, imageResult('A'));
    }
  }
}

// A new session on the same device must never inherit the old session's click.
for (const action of ['tap', 'back', 'home']) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel);
  if (action === 'tap') panel.clickImage(100, 100);
  else panel.elements[`nav-${action}`].dispatch('click');
  await flush();
  const preflight = panel.take('preview_frame');
  const otherSession = imageResult('A');
  otherSession.structuredContent.sessionId = 'replacement-session';
  await panel.reply(preflight, otherSession);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  assert.match(panel.elements.status.textContent, /session/i);
  assert.equal(panel.elements.start.disabled, false, 'A replaced session must allow starting preview again');
}

// Only decoded image dimensions determine tap coordinates, including rotated screens and edge clamping.
{
  const panel = await readyPanel();
  panel.clickImage(167.5, 360);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'No gestures before the first frame');
  await start(panel);
  panel.clickImage(167.5, 360);
  await flush();
  assert.equal(panel.elements['gesture-marker'].hidden, false, 'Show a marker for a tap gesture');
  const tap = panel.take('preview_action');
  assert.equal(tap.params.arguments.x, 630);
  assert.equal(tap.params.arguments.y, 1360);
  panel.clickImage(167.5, 360);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Do not repeat an in-flight gesture');
  await panel.reply(tap, textResult({}));
  await panel.reply(panel.take('preview_frame'), imageResult('A', 2720, 1260));
  panel.elements.stage.box = { left: 10, top: 20, width: 680, height: 315 };
  panel.elements['frame-shell'].box = { left: 10, top: 20, width: 680, height: 315 };
  panel.elements['frame-shell'].clientWidth = 680;
  panel.elements['frame-shell'].clientHeight = 315;
  panel.clickImage(350, 177.5);
  await flush();
  const rotated = panel.take('preview_action');
  assert.equal(rotated.params.arguments.x, 1360);
  assert.equal(rotated.params.arguments.y, 630);
  await panel.reply(rotated, textResult({}));
  await panel.reply(panel.take('preview_frame'), imageResult('A', 2720, 1260));
  panel.clickImage(689.999, 334.999);
  await flush();
  const edge = panel.take('preview_action');
  assert.equal(edge.params.arguments.x, 2719);
  assert.equal(edge.params.arguments.y, 1259);
  await panel.reply(edge, textResult({}));
  await panel.reply(panel.take('preview_frame'), imageResult('A', 2720, 1260));
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  panel.elements.stage.dispatch('pointercancel');
  panel.elements.stage.dispatch('pointerup', { clientX: 100, clientY: 100, pointerId: 1 });
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Cancelled pointers must not act');
}

// Releasing a short press outside the visible image must not tap the clamped edge.
for (const captured of [true, false]) for (const [name, from, end] of [
  ['left', [11, 100], [9, 100]], ['right', [324, 100], [325, 100]],
  ['top', [100, 21], [100, 19]], ['bottom', [100, 699], [100, 700]],
]) {
  const panel = await readyPanel();
  await start(panel);
  if (!captured) panel.elements['frame-shell'].setPointerCapture = () => { throw new Error('capture unavailable'); };
  panel.elements.stage.dispatch('pointerdown', { clientX: from[0], clientY: from[1], pointerId: 21 });
  panel.elements.stage.dispatch('pointerup', { clientX: end[0], clientY: end[1], pointerId: 21 });
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), `${name}, captured=${captured} must not send a tap`);
}

// A release on the inner edge remains a click; a captured drag beyond it keeps clamping.
for (const action of ['tap', 'swipe']) {
  const panel = await readyPanel();
  await start(panel);
  panel.elements.stage.dispatch('pointerdown', { clientX: action === 'tap' ? 324 : 300, clientY: 100, pointerId: 22 });
  panel.elements.stage.dispatch('pointerup', { clientX: action === 'tap' ? 324.999 : 400, clientY: 100, pointerId: 22 });
  await flush();
  const sent = panel.take('preview_action').params.arguments;
  assert.equal(sent.action, action);
  assert.equal(action === 'tap' ? sent.x : sent.toX, 1259);
}

// A zoomed image can extend beyond the scrollable viewport even while its own rectangle contains the pointer.
for (const outside of [true, false]) {
  const panel = await readyPanel();
  await start(panel);
  const shell = panel.elements['frame-shell'];
  shell.box = { left: 20, top: 30, width: 290, height: 660 };
  shell.clientLeft = 2; shell.clientTop = 3; shell.clientWidth = 286; shell.clientHeight = 654;
  panel.elements.stage.dispatch('pointerdown', { clientX: 23, clientY: 100, pointerId: 23 });
  panel.elements.stage.dispatch('pointerup', { clientX: outside ? 21 : 22, clientY: 100, pointerId: 23 });
  await flush();
  if (outside) assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'A clipped-out press must not send');
  else assert.equal(panel.take('preview_action').params.arguments.action, 'tap');
}

// Polling has one in-flight capture; device switches reject old responses and require a new device frame.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const oldCapture = panel.take('preview_frame');
  assert.equal([...panel.timers.values()].filter(({ ms }) => ms === pollIntervalMs).length, 0, 'No next poll while capture is pending');
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  assert.equal(panel.elements.stage.src, '');
  assert.equal(panel.elements.stage.hidden, true, 'Hide the image while switching devices');
  const oldStop = panel.take('preview_stop');
  assert.equal(oldStop.params.arguments.sessionId, 'session-A');
  panel.clickImage(100, 100);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'session-B', deviceId: 'B', pollMs: 500 }));
  await panel.reply(oldCapture, imageResult('A'));
  assert.equal(panel.elements.stage.src, '', 'Late frame from A must not render for B');
  const newCapture = panel.take('preview_frame');
  assert.equal(newCapture.params.arguments.afterSeq, 0);
  await panel.reply(newCapture, imageResult('B', 1600, 2560));
  await panel.reply(oldStop, textResult({ running: false }));
  panel.clickImage(167.5, 360);
  await flush();
  assert.equal(panel.take('preview_action').params.arguments.action, 'tap');
}

// After an action, wait for the first newer live frame instead of polling a stale seq.
{
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(167.5, 360);
  await flush();
  const action = panel.take('preview_action');
  await panel.reply(action, textResult({}));
  const fresh = panel.take('preview_frame');
  assert.equal(fresh.params.arguments.waitMs, 2500, 'Action refresh should wait for a newer frame');
  await panel.reply(fresh, imageResult('A', 1260, 2720));
  assert.equal(panel.elements.stage.hidden, false, 'Render the first frame available after an action');
}

// Keep the previous image visible while a poll or post-action frame decodes.
for (const afterAction of [false, true]) {
  const panel = await readyPanel();
  await start(panel);
  const previousElement = panel.elements.stage;
  const previous = panel.elements.stage.src;
  let releaseDecode;
  panel.elements.stage.decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
  if (afterAction) {
    panel.clickImage(100, 100);
    await flush();
    await panel.reply(panel.take('preview_action'), textResult({}));
  } else await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A', 1600, 2560));
  assert.equal(panel.elements.stage, previousElement, 'Keep the decoded element in place until its replacement is ready');
  assert.equal(panel.elements.stage.src, previous, 'Do not replace the visible image before decode finishes');
  assert.equal(panel.elements.stage.hidden, false);
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Old pixels must not accept gestures');
  releaseDecode();
  await flush();
  assert.notEqual(panel.elements.stage, previousElement, 'Display the same image element that was decoded');
  assert.match(panel.elements.stage.src, /1600x2560$/);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Changed pixels or geometry must not receive the queued gesture');
}

// A click during decoding is dispatched after an identical frame is committed, using its new identity.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  let releaseDecode;
  panel.elements.stage.decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
  const newer = imageResult('A');
  await panel.reply(panel.take('preview_frame'), newer);
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  releaseDecode();
  await flush();
  const action = panel.take('preview_action').params.arguments;
  assert.equal(action.seq, newer.structuredContent.seq);
  assert.equal(action.frameId, newer.structuredContent.frame.frameId);
}

// A failed decode invalidates the old display and cannot enable a gesture on it.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  let rejectDecode;
  panel.elements.stage.decodeGate = new Promise((_, reject) => { rejectDecode = reject; });
  await panel.reply(panel.take('preview_frame'), imageResult('A', 1600, 2560));
  rejectDecode(new Error('decode failed'));
  await flush();
  assert.equal(panel.elements.stage.hidden, false);
  assert.match(panel.elements.status.textContent, /refresh/i);
  panel.clickImage(100, 100);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  const refresh = panel.take('preview_frame');
  assert.equal(refresh.params.arguments.forceRefresh, true);
  panel.elements.stage.decodeGate = undefined;
  await panel.reply(refresh, imageResult('A'));
  assert.equal(panel.elements['nav-back'].disabled, false);
  assert.match(panel.elements.status.textContent, /refreshed.*ready/i);
}

// A transient frame request error keeps the old pixels inert until forced recovery succeeds.
{
  const panel = await readyPanel();
  await start(panel);
  const original = panel.elements.stage;
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), { isError: true, content: [{ type: 'text', text: 'temporary transport failure' }] });
  assert.equal(panel.elements.stage, original);
  assert.equal(original.hidden, false);
  assert.equal(panel.elements['nav-back'].disabled, true);
  const refresh = panel.take('preview_frame');
  assert.equal(refresh.params.arguments.forceRefresh, true);
  await panel.reply(refresh, imageResult('A'));
  assert.equal(panel.elements['nav-back'].disabled, false);
  assert.match(panel.elements.status.textContent, /refreshed.*ready/i);
}

// A decoded frame cannot replace the image beneath an active pointer gesture.
for (const changed of [false, true]) {
  const panel = await readyPanel();
  await start(panel);
  const displayed = panel.elements.stage;
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  await panel.runPoll();
  const newer = imageResult('A');
  if (changed) newer.structuredContent.frame.data = '01260x2720';
  await panel.reply(panel.take('preview_frame'), newer);
  assert.equal(panel.elements.stage, displayed, 'Do not replace the frame during the gesture');
  panel.elements['frame-shell'].dispatch('pointerup', { clientX: 110, clientY: 110, pointerId: 8 });
  await flush();
  if (changed) {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
    assert.match(panel.elements.status.textContent, /changed.*try again/i);
  } else {
    const action = panel.take('preview_action').params.arguments;
    assert.equal(action.frameId, newer.structuredContent.frame.frameId);
  }
}

// Canceled, lost and timed-out gestures release a waiting frame without input.
for (const reason of ['pointercancel', 'lostpointercapture', 'blur', 'timeout']) {
  const panel = await readyPanel();
  await start(panel);
  const displayed = panel.elements.stage;
  displayed.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  panel.elements.status.dataset.gestureDiagnostic = JSON.stringify({ reason: 'old_rejection' });
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.equal(panel.elements.stage, displayed);
  if (reason === 'timeout') await panel.runTimer(10000);
  else if (reason === 'blur') panel.windowListeners.get('blur')();
  else panel.elements['frame-shell'].dispatch(reason, { pointerId: 8 });
  await flush();
  assert.notEqual(panel.elements.stage, displayed, `${reason} must release frame rendering`);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  assert.match(panel.elements.status.textContent, /gesture (canceled|timed out).*try again/i, `${reason} must explain why input was not sent`);
  assert.equal(panel.elements.status.dataset.gestureDiagnostic, '', `${reason} must clear the previous rejection`);
}

// An unrelated cancellation or a capture released after pointerup must not change status.
{
  const panel = await readyPanel();
  await start(panel);
  const status = panel.elements.status.textContent;
  panel.elements['frame-shell'].dispatch('lostpointercapture', { pointerId: 8 });
  panel.windowListeners.get('blur')();
  assert.equal(panel.elements.status.textContent, status);
}

// Changing device during a held gesture releases but cannot render the old device frame.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  await flush();
  assert.equal(panel.elements.stage.src, '');
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// A disconnect while the pointer is held cancels it and cannot send an input.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), { structuredContent: { connected: false } });
  panel.elements['frame-shell'].dispatch('pointerup', { clientX: 110, clientY: 110, pointerId: 8 });
  await flush();
  assert.equal(panel.elements.stage.hidden, true);
  assert.match(panel.elements.status.textContent, /disconnect/i);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  assert.match(panel.elements['action-metrics'].textContent, /gesture: canceled.*preview frame unavailable.*input not sent/);
  assert.match(panel.elements['action-summary'].textContent, /unclassified canceled 1/);
}

// A drag that returns to its starting point must not become a tap.
for (const scenario of ['returned', 'returned-without-capture', 'coalesced-return', 'coalesced-other-pointer', 'coalesced-throws', 'below-threshold', 'exact-threshold', 'other-pointer', 'invalid-move', 'up-only-swipe', 'canceled-then-tap']) {
  const panel = await readyPanel();
  await start(panel);
  const stage = panel.elements.stage;
  const shell = panel.elements['frame-shell'];
  if (scenario === 'returned-without-capture') shell.setPointerCapture = () => { throw new Error('capture unavailable'); };
  stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  if (scenario !== 'up-only-swipe') {
    const distance = scenario === 'below-threshold' ? 11 : scenario === 'exact-threshold' ? 12 : 50;
    shell.dispatch('pointermove', { clientX: scenario === 'invalid-move' ? Infinity : scenario.startsWith('coalesced-') ? 100 : 100 + distance, clientY: 100,
      pointerId: scenario === 'other-pointer' ? 9 : 8,
      ...(scenario === 'coalesced-throws' ? { getCoalescedEvents() { throw new Error('unavailable'); } }
        : scenario.startsWith('coalesced-') ? { getCoalescedEvents: () => [{ pointerId: scenario === 'coalesced-other-pointer' ? 9 : 8, clientX: 150, clientY: 100 }] } : {}) });
  }
  if (scenario === 'canceled-then-tap') {
    shell.dispatch('pointercancel', { pointerId: 8 });
    stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  }
  stage.dispatch('pointerup', { clientX: scenario === 'up-only-swipe' ? 150 : 100, clientY: 100, pointerId: 8 });
  await flush();
  const motion = JSON.parse(panel.elements.status.dataset.gestureMotionDiagnostic);
  assert.deepEqual(motion, {
    moveObserved: !['other-pointer', 'invalid-move', 'up-only-swipe', 'canceled-then-tap'].includes(scenario),
    thresholdExceeded: ['returned', 'returned-without-capture', 'coalesced-return'].includes(scenario),
    endWithinThreshold: scenario !== 'up-only-swipe',
    endDistancePx: scenario === 'up-only-swipe' ? 50 : 0,
  }, scenario);
  if (scenario.startsWith('returned') || scenario === 'coalesced-return') {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), `${scenario} must not send a tap`);
    assert.match(panel.elements['action-metrics'].textContent, /swipe: canceled.*input not sent/);
  } else {
    assert.equal(panel.take('preview_action').params.arguments.action, scenario === 'up-only-swipe' ? 'swipe' : 'tap', scenario);
  }
}

// A trusted mouse returning to its screen origin must not become a swipe if the host moved.
for (const scenario of ['host-moved', 'coalesced-screen', 'coalesced-screen-untrusted', 'coalesced-screen-other-pointer', 'untrusted', 'constant-screen', 'missing-screen', 'zero-screen', 'screen-end-far']) {
  const panel = await readyPanel();
  await start(panel);
  const stage = panel.elements.stage;
  const shell = panel.elements['frame-shell'];
  const trusted = scenario !== 'untrusted';
  const downScreen = scenario === 'missing-screen' ? {} : scenario === 'zero-screen' ? { screenX: 0, screenY: 0 } : { screenX: 500, screenY: 500 };
  const moveScreen = scenario === 'constant-screen' || scenario.startsWith('coalesced-screen') ? { screenX: 500, screenY: 500 } : scenario === 'zero-screen' ? { screenX: 40, screenY: 0 } : { screenX: 540, screenY: 500 };
  const upScreen = scenario === 'missing-screen' ? {} : scenario === 'zero-screen' ? { screenX: 0, screenY: 0 } : { screenX: scenario === 'screen-end-far' ? 540 : 500, screenY: 500 };
  stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8, isTrusted: trusted, ...downScreen });
  shell.dispatch('pointermove', { clientX: 140, clientY: 100, pointerId: 8, isTrusted: trusted, ...moveScreen,
    ...(scenario.startsWith('coalesced-screen') ? { getCoalescedEvents: () => [{ pointerId: scenario === 'coalesced-screen-other-pointer' ? 9 : 8,
      isTrusted: scenario !== 'coalesced-screen-untrusted', screenX: 540, screenY: 500, clientX: 140, clientY: 100 }] } : {}) });
  stage.dispatch('pointerup', { clientX: 150, clientY: 100, pointerId: 8, isTrusted: trusted, ...upScreen });
  await flush();
  if (scenario === 'host-moved' || scenario === 'coalesced-screen') {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'host movement must not send a device action');
    assert.match(panel.elements['action-metrics'].textContent, /canceled.*screen.*input not sent/);
  } else assert.equal(panel.take('preview_action').params.arguments.action, 'swipe', scenario);
}

// A failed pointer capture can still complete a click released on the image.
{
  const panel = await readyPanel();
  await start(panel);
  const displayed = panel.elements.stage;
  panel.elements['frame-shell'].setPointerCapture = () => { throw new Error('capture failed'); };
  displayed.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.equal(panel.elements.stage, displayed);
  displayed.dispatch('pointerup', { clientX: 100, clientY: 100, pointerId: 8 });
  await flush();
  assert.equal(panel.take('preview_action').params.arguments.action, 'tap');
}

// Without pointer capture, leaving the image or releasing elsewhere cancels.
for (const reason of ['pointerleave', 'outside', 'blur']) {
  const panel = await readyPanel();
  await start(panel);
  const displayed = panel.elements.stage;
  const shell = panel.elements['frame-shell'];
  shell.setPointerCapture = () => { throw new Error('capture failed'); };
  displayed.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 8 });
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.equal(panel.elements.stage, displayed);
  if (reason === 'pointerleave') shell.dispatch('pointerleave', { pointerId: 8 });
  else if (reason === 'blur') panel.windowListeners.get('blur')();
  else shell.dispatch('pointerup', { clientX: -1, clientY: -1, pointerId: 8, target: shell });
  await flush();
  assert.notEqual(panel.elements.stage, displayed);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// Rotation between pointer down/up, or while waiting for a capture, must cancel old-geometry gestures.
for (const rotateBeforeRelease of [true, false]) {
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const capture = panel.take('preview_frame');
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  if (rotateBeforeRelease) await panel.reply(capture, imageResult('A', 2720, 1260));
  panel.elements.stage.dispatch('pointerup', { clientX: 101, clientY: 101, pointerId: 1 });
  if (!rotateBeforeRelease) await panel.reply(capture, imageResult('A', 2720, 1260));
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'A geometry change must cancel the gesture');
  assert.match(panel.elements.status.textContent, /changed.*try again/i, 'A canceled gesture must not fail silently');
}

// A click made during a poll can use the newer frame only when its visible pixels and geometry are unchanged.
for (const changed of ['none', 'pixels', 'rotation']) {
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const capture = panel.take('preview_frame');
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  const newer = imageResult('A');
  if (changed === 'pixels') newer.structuredContent.frame.data = '01260x2720';
  if (changed === 'rotation') newer.structuredContent.metrics.rotation = 90;
  await panel.reply(capture, newer);
  await flush();
  if (changed !== 'none') {
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Changed pixels or rotation must cancel the click');
    assert.match(panel.elements.status.textContent, /changed.*try again/i);
  } else {
    const action = panel.take('preview_action').params.arguments;
    assert.equal(action.seq, newer.structuredContent.seq);
    assert.equal(action.frameId, newer.structuredContent.frame.frameId);
  }
}

// Replacing a decoded frame during a drag preserves capture on the stable shell and still sends a swipe.
{
  const panel = await readyPanel();
  await start(panel);
  const shell = panel.elements['frame-shell'];
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 9 });
  assert.equal(shell.capturedPointerId, 9);
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  shell.dispatch('pointerup', { clientX: 180, clientY: 200, pointerId: 9, target: shell });
  await flush();
  const swipe = panel.take('preview_action').params.arguments;
  assert.equal(swipe.action, 'swipe');
  assert.equal(swipe.deviceId, 'A');
  assert.equal(swipe.sessionId, 'session-A');
  assert.ok(swipe.toX > swipe.x && swipe.toY > swipe.y);
}

// Pointer events on the shell outside the image cannot trigger a device action.
{
  const panel = await readyPanel();
  await start(panel);
  const shell = panel.elements['frame-shell'];
  shell.dispatch('pointerdown', { clientX: 0, clientY: 0, pointerId: 10, target: shell });
  shell.dispatch('pointerup', { clientX: 0, clientY: 0, pointerId: 10, target: shell });
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// A late image decode from the old generation must neither enable interaction nor overwrite the new frame.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  let releaseDecode;
  panel.elements.stage.decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
  await panel.reply(panel.take('preview_frame'), imageResult('A', 900, 1800));
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'session-B', deviceId: 'B', pollMs: 500 }));
  panel.elements.stage.decodeGate = undefined;
  releaseDecode();
  await flush();
  assert.equal(panel.elements.stage.src, '', 'Old decoded image must remain invalid after switching devices');
  await panel.reply(panel.take('preview_frame'), imageResult('B', 1600, 2560));
  assert.match(panel.elements.stage.src, /1600x2560$/);
  panel.clickImage(167.5, 360);
  await flush();
  const tap = panel.take('preview_action');
  assert.equal(tap.params.arguments.action, 'tap');
  assert.equal(tap.params.arguments.x, 800);
  assert.equal(tap.params.arguments.y, 1280);
}

// Offline and mismatched frames clear interaction; polling recovers only after a valid decoded frame.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), { isError: true, content: [{ type: 'text', text: 'device disconnected' }] });
  assert.equal(panel.elements.stage.src, '');
  assert.equal(panel.elements.stage.hidden, true, 'Hide disconnected image instead of showing a broken-image placeholder');
  assert.match(panel.elements['overlay-text'].textContent, /disconnected/i);
  assert.match(panel.elements.status.textContent, /disconnected/);
  panel.clickImage(100, 100);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('B'));
  assert.equal(panel.elements.stage.src, '', 'Wrong device metadata must not render');
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.ok(panel.elements.stage.src.startsWith('data:'));
  assert.equal(panel.elements.stage.hidden, false, 'Show the image after a valid recovery frame');
  panel.clickImage(100, 100);
  await flush();
  assert.equal(panel.take('preview_action').params.arguments.action, 'tap');
}

// Stopping or removing the active device invalidates in-flight frame responses.
for (const action of ['stop', 'remove']) {
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const lateCapture = panel.take('preview_frame');
  if (action === 'stop') panel.elements.stop.dispatch('click');
  else {
    panel.elements.refresh.dispatch('click');
    await panel.reply(panel.take('list_devices'), textResult({ devices: [] }));
    assert.equal(panel.elements.devices.value, '');
  }
  await panel.reply(lateCapture, imageResult('A'));
  assert.equal(panel.elements.stage.src, '');
  assert.equal(panel.elements.stage.hidden, true, 'Hide stopped or removed device images');
  assert.equal([...panel.timers.values()].filter(({ ms }) => ms === pollIntervalMs).length, 0);
  panel.clickImage(100, 100);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// Host teardown stops the known session, clears timers and acknowledges the lifecycle request.
{
  const panel = await readyPanel();
  await start(panel);
  panel.windowListeners.get('message')({ source: panel.parent, data: { jsonrpc: '2.0', id: 'teardown', method: 'ui/resource-teardown' } });
  await flush();
  assert.equal(panel.take('preview_stop').params.arguments.sessionId, 'session-A');
  assert.equal(panel.elements.stage.src, '');
  assert.equal(panel.timers.size, 0);
  assert.ok(panel.sent.some((message) => message.id === 'teardown' && message.result));
}

// Fit and zoom use actual available space, preserving the decoded image ratio.
{
  const panel = await readyPanel();
  await start(panel);
  assert.equal(panel.elements.stage.style.width, '315px');
  assert.equal(panel.elements.stage.style.height, '680px');
  panel.elements['zoom-in'].dispatch('click');
  assert.equal(panel.elements.stage.style.width, '393px');
  assert.equal(panel.elements.stage.style.height, '850px');
  assert.match(panel.elements.metrics.textContent, /125%/);
  panel.elements.fit.dispatch('click');
  assert.equal(panel.elements.stage.style.width, '315px');
  assert.equal(panel.elements.stage.style.height, '680px');
  assert.match(panel.elements.metrics.textContent, /100%/);
  assert.equal(panel.elements.stage.naturalWidth, 1260);
  assert.equal(panel.elements.stage.naturalHeight, 2720);
}

// Resizing the containing panel refits both portrait and landscape frames.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements['frame-shell'].clientWidth = 600;
  panel.elements['frame-shell'].clientHeight = 300;
  panel.resize(panel.elements['frame-shell']);
  assert.equal(panel.elements.stage.style.width, '138px');
  assert.equal(panel.elements.stage.style.height, '300px');
  panel.elements['zoom-in'].dispatch('click');
  assert.equal(panel.elements.stage.style.width, '173px');
  assert.equal(panel.elements.stage.style.height, '375px');
  panel.elements.fit.dispatch('click');
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A', 2720, 1260));
  assert.equal(panel.elements.stage.style.width, '600px');
  assert.equal(panel.elements.stage.style.height, '277px');
}

// Scrollbars must not shrink the fit baseline used to calculate zoom.
{
  const panel = await readyPanel();
  const shell = panel.elements['frame-shell'];
  shell.clientLeft = 2;
  shell.clientTop = 3;
  shell.offsetWidth = 319;
  shell.offsetHeight = 686;
  await start(panel);
  assert.equal(panel.elements.stage.style.width, '315px');
  assert.equal(panel.elements.stage.style.height, '680px');
  assert.equal(shell.style.overflow, 'hidden', 'Fit must not display overflow scrollbars');
  panel.elements['zoom-in'].dispatch('click');
  assert.equal(shell.style.overflow, 'auto', 'Zooming in must make overflow scrollable');
  panel.elements['zoom-in'].dispatch('click');
  shell.clientWidth = 300;
  shell.clientHeight = 665;
  panel.resize(shell);
  assert.equal(panel.elements.stage.style.width, '472px');
  assert.equal(panel.elements.stage.style.height, '1020px');
  assert.match(panel.elements.metrics.textContent, /150%/);
  panel.elements.fit.dispatch('click');
  assert.equal(panel.elements.stage.style.width, '315px');
  assert.equal(panel.elements.stage.style.height, '680px');
  assert.equal(shell.style.overflow, 'hidden', 'Returning to Fit must remove overflow scrollbars');
  panel.elements['zoom-out'].dispatch('click');
  assert.equal(shell.style.overflow, 'hidden', 'Zooming below Fit must not display overflow scrollbars');
}

// A frame first received while its panel is hidden is sized when it becomes visible.
{
  const panel = await readyPanel();
  panel.elements['frame-shell'].clientWidth = 0;
  panel.elements['frame-shell'].clientHeight = 0;
  await start(panel);
  assert.equal(panel.elements.stage.style.width, undefined);
  assert.equal(panel.elements.stage.style.height, undefined);
  panel.elements['frame-shell'].clientWidth = 315;
  panel.elements['frame-shell'].clientHeight = 680;
  panel.resize(panel.elements['frame-shell']);
  assert.equal(panel.elements.stage.style.width, '315px');
  assert.equal(panel.elements.stage.style.height, '680px');
}

// A short viewport keeps the whole portrait frame and maps its bottom edge correctly.
{
  const panel = await readyPanel();
  await start(panel, 'A', 640, 1024);
  const shell = panel.elements['frame-shell'];
  shell.clientWidth = 300;
  shell.clientHeight = 120;
  panel.resize(shell);
  assert.equal(panel.elements.stage.style.width, '75px');
  assert.equal(panel.elements.stage.style.height, '120px');
  panel.elements.stage.box = { left: 122.5, top: 20, width: 75, height: 120 };
  panel.clickImage(160, 139.9);
  await flush();
  const tap = panel.take('preview_action').params.arguments;
  assert.equal(tap.x, 320);
  assert.equal(tap.y, 1023);
}

// A viewport resize or scroll between pointer events cannot redirect a gesture.
for (const changedBox of [
  { left: 10, top: 20, width: 300, height: 650 },
  { left: -30, top: -55, width: 315, height: 680 },
]) {
  const panel = await readyPanel();
  await start(panel);
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  panel.elements.stage.box = changedBox;
  panel.elements.stage.dispatch('pointerup', { clientX: 101, clientY: 101, pointerId: 1 });
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Changes to the displayed image rectangle must cancel the gesture');
}

// A resize while a gesture waits for an in-flight frame also cancels the action.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const capture = panel.take('preview_frame');
  panel.elements.stage.dispatch('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 });
  panel.elements.stage.dispatch('pointerup', { clientX: 101, clientY: 101, pointerId: 1 });
  panel.elements.stage.box = { left: 10, top: 20, width: 300, height: 650 };
  await panel.reply(capture, imageResult('A'));
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'A resize during the capture queue must cancel the gesture');
  assert.match(panel.elements.status.textContent, /changed.*try again/i, 'A cancelled gesture should explain why it was not sent');
}

// A feedback marker stays under the pointer when its container is scrolled.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements['frame-shell'].scrollLeft = 40;
  panel.elements['frame-shell'].scrollTop = 75;
  panel.elements['frame-shell'].clientLeft = 2;
  panel.elements['frame-shell'].clientTop = 3;
  panel.elements.stage.box = { left: -30, top: -55, width: 315, height: 680 };
  panel.clickImage(100, 100);
  await flush();
  assert.equal(parseFloat(panel.elements['gesture-marker'].style.left), 128);
  assert.equal(parseFloat(panel.elements['gesture-marker'].style.top), 152);
}

// Controls track initialization, preview startup, failure, stop and device removal.
{
  const panel = createPanel();
  assert.equal(panel.elements.start.disabled, true);
  assert.equal(panel.elements.stop.disabled, true);
  assert.equal(panel.elements.build.disabled, true);
  await panel.reply(panel.take('ui/initialize'), { hostContext: {} });
  await panel.reply(panel.take('list_devices'), textResult({ devices: ['A'] }));
  assert.equal(panel.elements.start.disabled, false);
  assert.equal(panel.elements.stop.disabled, true);
  assert.equal(panel.elements.fit.disabled, true);
  panel.elements.start.dispatch('click');
  assert.equal(panel.elements.start.disabled, true);
  assert.equal(panel.elements.stop.disabled, false);
  assert.match(panel.elements.status.textContent, /Starting preview/);
  await panel.reply(panel.take('preview_start'), { isError: true, content: [{ type: 'text', text: 'start failed' }] });
  assert.equal(panel.elements.start.disabled, false);
  assert.equal(panel.elements.stop.disabled, true);
  assert.match(panel.elements.status.textContent, /start failed/);
  await start(panel);
  assert.equal(panel.elements.start.disabled, true);
  assert.equal(panel.elements.stop.disabled, false);
  assert.equal(panel.elements.fit.disabled, false);
  panel.elements.stop.dispatch('click');
  assert.equal(panel.elements.start.disabled, true, 'Do not start while stop is pending');
  await panel.reply(panel.take('preview_stop'), textResult({ running: false }));
  assert.equal(panel.elements.start.disabled, false);
  assert.equal(panel.elements.stop.disabled, true);
  assert.equal(panel.elements.fit.disabled, true);
  assert.equal(panel.elements.status.className, 'neutral', 'Stopped is not a success state');
  panel.elements.refresh.dispatch('click');
  await panel.reply(panel.take('list_devices'), textResult({ devices: [] }));
  assert.equal(panel.elements.start.disabled, true);
  assert.equal(panel.elements.devices.disabled, true);
  assert.equal(panel.elements.devices.children[0].label, 'No device connected');
}

// A build owns its target and progress status until success or failure.
for (const fails of [false, true]) {
  const panel = await readyPanel();
  await start(panel);
  panel.elements.build.dispatch('click');
  const build = panel.take('build_run');
  assert.equal(build.params.arguments.deviceId, 'A');
  assert.equal(panel.elements.devices.disabled, true);
  assert.equal(panel.elements.stop.disabled, true);
  assert.match(panel.elements.status.textContent, /Building, installing and launching on A/);
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  assert.equal(panel.elements.devices.value, 'A');
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.match(panel.elements.status.textContent, /Building, installing and launching on A/, 'Polling must not overwrite build progress');
  await panel.reply(build, fails ? { isError: true, content: [{ type: 'text', text: 'build failed' }] } : textResult({}));
  assert.equal(panel.elements.devices.disabled, false);
  assert.equal(panel.elements.start.disabled, true);
  assert.equal(panel.elements.stop.disabled, false);
  assert.match(panel.elements.status.textContent, fails ? /build failed/ : /completed: A/);
  if (fails) {
    panel.advance(5000);
    await panel.runPoll();
    await panel.reply(panel.take('preview_frame'), imageResult('A'));
    assert.match(panel.elements.status.textContent, /build failed/, 'Keep errors visible after ordinary frames');
  }
}

// A sent action is not treated as a verified business result, and wait failures are distinct.
{
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), textResult({}));
  let rejectDecode;
  panel.elements.stage.decodeGate = new Promise((_, reject) => { rejectDecode = reject; });
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  rejectDecode(new Error('decode failed'));
  await flush();
  assert.equal(panel.elements['retry-frame'].hidden, false);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_frame'), 'Do not automatically refresh an unknown action result');
  panel.elements['retry-frame'].dispatch('click');
  await flush();
  const refresh = panel.take('preview_frame');
  panel.elements.stage.decodeGate = undefined;
  await panel.reply(refresh, imageResult('A'));
  assert.match(panel.elements.status.textContent, /result unknown/i);
  assert.match(panel.elements.status.textContent, /refreshed.*ready/i);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// A sent action is not treated as a verified business result, and wait failures are distinct.
for (const frameOutcome of ['frame', 'timeout', 'disconnect']) {
  const panel = await readyPanel();
  await start(panel);
  const seq = nextFrameSeq;
  panel.clickImage(100, 100);
  assert.match(panel.elements.status.textContent, /Sending tap/);
  assert.equal(panel.elements.build.disabled, true);
  await flush();
  await panel.reply(panel.take('preview_action'), textResult({ metrics: { nextFrameAfterSeq: seq } }));
  assert.match(panel.elements.status.textContent, /Tap sent.*waiting for a new frame/);
  const next = panel.take('preview_frame');
  if (frameOutcome === 'frame') await panel.reply(next, imageResult('A'));
  else if (frameOutcome === 'timeout') await panel.reply(next, { structuredContent: { deviceId: 'A', connected: true, frame: null } });
  else await panel.reply(next, { isError: true, content: [{ type: 'text', text: 'device disconnected' }] });
  assert.match(panel.elements.status.textContent, frameOutcome === 'frame' ? /Tap sent; new frame decoded.*total \d+ms/ : frameOutcome === 'timeout' ? /Action sent; no new frame yet. Result unknown/ : /Action sent; new frame unavailable: device disconnected/);
  assert.equal(panel.elements.build.disabled, frameOutcome === 'timeout');
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Never retry an action automatically');
  if (frameOutcome === 'frame') {
    await panel.runPoll();
    await panel.reply(panel.take('preview_frame'), imageResult('A'));
    assert.match(panel.elements.status.textContent, /new frame decoded/, 'Leave feedback visible across the next poll');
  } else if (frameOutcome === 'disconnect') {
    panel.advance(5000);
    await panel.runPoll();
    await panel.reply(panel.take('preview_frame'), imageResult('A'));
    assert.match(panel.elements.status.textContent, /Action sent;/, 'Keep uncertain results visible until the next user action');
  } else {
    assert.equal(panel.elements['retry-frame'].hidden, false);
    assert.ok(![...panel.timers.values()].some(({ ms }) => ms === pollIntervalMs), 'Unknown result must not auto-poll');
  }
}

// A later precise or navigation action must not retain an earlier cancellation diagnostic.
for (const next of ['precise-tap', 'precise-swipe', 'nav-back', 'nav-home', 'pointer']) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel);
  for (const [key, value] of [['start-x', '25'], ['start-y', '50'], ['end-x', '75'], ['end-y', '50']]) {
    panel.elements[`precise-${key}`].value = value;
  }
  panel.elements['precise-bind'].dispatch('click');
  panel.elements.stage.box.left += 1;
  panel.elements['precise-tap'].dispatch('click');
  await flush();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.deepEqual(JSON.parse(panel.elements.status.dataset.gestureDiagnostic),
    { reason: 'frame_or_display_geometry', failedChecks: ['display_box'] });
  const previousCancellation = { action: 'tap', reason: 'frame_or_display_geometry', failedChecks: ['display_box'] };
  assert.deepEqual(JSON.parse(panel.elements.status.dataset.lastCancellation), previousCancellation);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'First action must remain canceled');

  if (next.startsWith('precise-')) {
    panel.elements['precise-bind'].dispatch('click');
    panel.elements[next].dispatch('click');
  } else if (next.startsWith('nav-')) panel.elements[next].dispatch('click');
  else panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  const request = panel.take('preview_action');
  assert.equal(panel.elements.status.dataset.gestureDiagnostic, '', `${next} must clear the previous cancellation`);
  await panel.reply(request, textResult({ metrics: { nextFrameAfterSeq: request.params.arguments.seq } }));
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.equal(panel.elements.status.dataset.gestureDiagnostic, '', `${next} must keep its successful outcome free of stale diagnostics`);
  assert.deepEqual(JSON.parse(panel.elements.status.dataset.lastCancellation), previousCancellation, `${next} must retain the explicitly labeled last cancellation`);
  assert.match(panel.elements['action-metrics'].textContent, /new frame decoded/);
}

// Precise geometry diagnostics expose failed categories, never device values.
for (const scenario of ['frame_geometry', 'device_metadata', 'device_dimensions']) {
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel);
  panel.elements['precise-start-x'].value = '25';
  panel.elements['precise-start-y'].value = '50';
  panel.elements['precise-bind'].dispatch('click');
  panel.elements['precise-tap'].dispatch('click');
  await flush();
  const frame = scenario === 'frame_geometry' ? imageResult('A', 720, 1280)
    : scenario === 'device_metadata' ? imageResult('A', 1260, 2720, 1, 90) : imageResult('A');
  if (scenario === 'device_dimensions') frame.structuredContent.metrics.deviceWidth = 0;
  await panel.reply(panel.take('preview_frame'), frame);
  const diagnostic = JSON.parse(panel.elements.status.dataset.gestureDiagnostic);
  assert.equal(diagnostic.reason, 'frame_or_display_geometry');
  assert.ok(diagnostic.failedChecks.includes(scenario), `${scenario} must identify the failed category`);
  assert.ok(diagnostic.failedChecks.every((name) => typeof name === 'string'));
  assert.deepEqual(Object.keys(diagnostic).sort(), ['failedChecks', 'reason']);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// A stale preflight rejection keeps the last image visible but blocks input until a fresh frame arrives.
for (const [action, staleReason, stalePhase, stage] of [
  ['tap', 'sequence_changed', 'after_pause', 'action_frame'],
  ['back', 'consumed', 'before_pause', 'preview_action'],
  ['tap', 'frame_pair_pending', 'before_pause', 'preview_action'],
  ['tap', 'frame_pair_pending', 'after_pause', 'preview_action']
]) {
  const panel = await readyPanel();
  await start(panel);
  const image = panel.elements.stage.src;
  if (action === 'tap') panel.clickImage(100, 100);
  else panel.elements['nav-back'].dispatch('click');
  await flush();
  const request = panel.take('preview_action');
  const diagnostic = { errorCode: 'STALE_PREVIEW_FRAME', stage, inputNotSent: true, staleReason, stalePhase };
  await panel.reply(request, { ...textResult(diagnostic), isError: true });
  const lastCancellation = { action, reason: 'stale_preview', staleReason: diagnostic.staleReason, stalePhase: diagnostic.stalePhase };
  assert.deepEqual(JSON.parse(panel.elements.status.dataset.lastCancellation), lastCancellation, 'Keep the anonymous stale classification');
  assert.equal(panel.elements.stage.hidden, false, 'A preflight rejection must not blank the last image');
  assert.equal(panel.elements['stale-notice'].hidden, false, 'Old frames must be visibly marked');
  assert.equal(panel.elements['retry-frame'].hidden, true, 'Do not offer retry while recovery is running');
  assert.equal(panel.elements.stage.src, image);
  assert.equal(panel.elements['nav-back'].disabled, true);
  assert.equal(panel.elements['nav-home'].disabled, true);
  assert.match(panel.elements.status.textContent, /not sent.*refresh/i);
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Do not retry or use the stale image');
  const refresh = panel.take('preview_frame');
  assert.deepEqual({ ...refresh.params.arguments }, { forceRefresh: true, afterSeq: request.params.arguments.seq, waitMs: 2500, deviceId: 'A', sessionId: 'session-A', subscriberId: 'subscriber-session-A' });
  assert.ok(![...panel.timers.values()].some((timer) => timer.ms === pollIntervalMs), 'Normal polls stay paused during recovery');
  await panel.reply(refresh, imageResult('A'));
  assert.deepEqual(JSON.parse(panel.elements.status.dataset.lastCancellation), lastCancellation, 'Keep stale classification after the recovery frame');
  assert.equal(panel.elements['stale-notice'].hidden, true);
  assert.equal(panel.elements['nav-back'].disabled, false, 'Re-enable interaction after a fresh frame');
  assert.match(panel.elements.status.textContent, /not sent/i, 'Keep the rejection visible after refresh');
  assert.match(panel.elements.status.textContent, /refreshed.*ready/i, 'Make the completed refresh explicit');
}

// Only the known classifications may enter the anonymous cancellation record.
{
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(100, 100);
  await flush();
  const request = panel.take('preview_action');
  await panel.reply(request, { ...textResult({ errorCode: 'STALE_PREVIEW_FRAME', stage: 'preview_action', inputNotSent: true,
    staleReason: 'device-or-frame-identifier', stalePhase: 'image-or-coordinates' }), isError: true });
  assert.deepEqual(JSON.parse(panel.elements.status.dataset.lastCancellation), { action: 'tap', reason: 'stale_preview' });
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
}

// Coordinate rejection before input is a cancellation; the action must never be retried.
for (const errorCode of ['FRAME_COORDINATE_OUT_OF_BOUNDS', 'DEVICE_COORDINATE_OUT_OF_BOUNDS']) {
  const panel = await readyPanel();
  await start(panel);
  const image = panel.elements.stage.src;
  panel.clickImage(100, 100);
  await flush();
  const action = panel.take('preview_action');
  await panel.reply(action, { ...textResult({ errorCode, stage: 'action_frame', inputNotSent: true }), isError: true });
  assert.equal(panel.elements.stage.hidden, false, 'Keep the last image after a pre-input bounds rejection');
  assert.equal(panel.elements.stage.src, image);
  assert.equal(panel.elements['stale-notice'].hidden, false, 'Block interaction until a fresh frame is confirmed');
  assert.match(panel.elements.status.textContent, /coordinates.*outside.*not sent.*refresh/i);
  assert.match(panel.elements['action-summary'].textContent, /tap: n=0,.*canceled 1, failed\/unknown 0/);
  assert.ok(panel.elements['action-cancellations'].textContent.includes(`tap: ${errorCode.toLowerCase()}`));
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Never repeat a rejected input');
  const refresh = panel.take('preview_frame');
  assert.equal(refresh.params.arguments.forceRefresh, true);
  await panel.reply(refresh, imageResult('A'));
  assert.equal(panel.elements['stale-notice'].hidden, true);
  assert.match(panel.elements.status.textContent, /not sent/i);
}

// The same codes from an input-stage failure are ambiguous; do not claim they were canceled.
for (const errorCode of ['FRAME_COORDINATE_OUT_OF_BOUNDS', 'DEVICE_COORDINATE_OUT_OF_BOUNDS']) {
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(100, 100);
  await flush();
  const diagnostic = { errorCode, stage: 'device_input' };
  await panel.reply(panel.take('preview_action'), { ...textResult(diagnostic), isError: true });
  assert.match(panel.elements.status.textContent, /Action result unknown/);
  assert.match(panel.elements['action-summary'].textContent, /tap: n=0,.*canceled 0, failed\/unknown 1/);
  assert.equal(panel.elements['retry-frame'].hidden, false);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Unknown results are not retried');
}

// The same apparent preflight stage from an old host or post-input error is
// still ambiguous without the server's explicit inputNotSent marker.
for (const [errorCode, stage] of [['STALE_PREVIEW_FRAME', 'preview_action'], ['STALE_PREVIEW_FRAME', 'action_frame'],
  ['FRAME_COORDINATE_OUT_OF_BOUNDS', 'action_frame'], ['DEVICE_COORDINATE_OUT_OF_BOUNDS', 'action_frame'], ['SWIPE_SAME_DEVICE_POINT', 'action_frame']]) {
  for (const marker of [undefined, false, 'true']) {
    const panel = await readyPanel();
    await start(panel);
    panel.clickImage(100, 100);
    await flush();
    await panel.reply(panel.take('preview_action'), { ...textResult({ errorCode, stage, inputNotSent: marker }), isError: true });
    assert.match(panel.elements.status.textContent, /Action result unknown/, `${errorCode} without true marker is uncertain`);
    assert.match(panel.elements['action-summary'].textContent, /tap: n=0,.*canceled 0, failed\/unknown 1/);
    assert.equal(panel.elements['retry-frame'].hidden, false, 'Uncertain result requires manual recovery');
    assert.ok(!panel.sent.some((message) => ['preview_action', 'preview_frame'].includes(message.params?.name)), 'Uncertain input must not be retried');
  }
}

// A swipe that maps to one device pixel is definitely unsent only when the
// server rejected it before entering the device input stage.
for (const stage of ['action_frame', 'device_input']) {
  const panel = await readyPanel();
  await start(panel);
  panel.elements.stage.dispatch('pointerdown', { clientX: 60, clientY: 200, pointerId: 1 });
  panel.elements.stage.dispatch('pointerup', { clientX: 250, clientY: 200, pointerId: 1 });
  await flush();
  const diagnostic = { errorCode: 'SWIPE_SAME_DEVICE_POINT', stage, ...(stage === 'action_frame' ? { inputNotSent: true } : {}) };
  await panel.reply(panel.take('preview_action'), { ...textResult(diagnostic), isError: true });
  if (stage === 'action_frame') {
    assert.match(panel.elements['action-summary'].textContent, /swipe: n=0,.*canceled 1, failed\/unknown 0/);
    assert.ok(panel.elements['action-cancellations'].textContent.includes('swipe: swipe_same_device_point'));
  } else {
    assert.match(panel.elements.status.textContent, /Action result unknown/);
    assert.match(panel.elements['action-summary'].textContent, /swipe: n=0,.*canceled 0, failed\/unknown 1/);
    assert.equal(panel.elements['retry-frame'].hidden, false);
  }
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Never repeat the swipe automatically');
}

// A stale-looking error without a known preflight stage remains ambiguous.
for (const outcome of ['error', 'empty', 'old', 'wrong-device', 'disconnect', 'wrong-session', 'switch-during-decode']) {
  const panel = await readyPanel();
  await start(panel);
  const original = panel.elements.stage;
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), { ...textResult({ errorCode: 'STALE_PREVIEW_FRAME', stage: 'preview_action', inputNotSent: true }), isError: true });
  const refresh = panel.take('preview_frame');
  let response = imageResult('A');
  if (outcome === 'error') response = { isError: true, content: [{ type: 'text', text: 'refresh failed' }] };
  if (outcome === 'empty') response.structuredContent.frame = null;
  if (outcome === 'old') response.structuredContent.seq = refresh.params.arguments.afterSeq;
  if (outcome === 'wrong-device') response.structuredContent.deviceId = 'B';
  if (outcome === 'disconnect') response.structuredContent.connected = false;
  if (outcome === 'wrong-session') response.structuredContent.sessionId = 'other-session';
  let releaseDecode;
  if (outcome === 'switch-during-decode') original.decodeGate = new Promise((resolve) => { releaseDecode = resolve; });
  await panel.reply(refresh, response);
  if (outcome === 'switch-during-decode') {
    panel.elements.devices.value = 'B';
    panel.elements.devices.dispatch('change');
    releaseDecode();
    await flush();
  }
  if (['disconnect', 'wrong-session', 'switch-during-decode'].includes(outcome)) {
    assert.equal(panel.elements.stage.hidden, true, `${outcome} must clear the old image`);
  } else {
    assert.equal(panel.elements.stage, original, `${outcome} must preserve the old image`);
    assert.equal(panel.elements.stage.hidden, false);
    assert.equal(panel.elements['stale-notice'].hidden, false);
    assert.equal(panel.elements['retry-frame'].hidden, false);
    assert.match(panel.elements.status.textContent, /refresh failed/i);
    assert.ok(![...panel.timers.values()].some((timer) => timer.ms === pollIntervalMs), 'Failed recovery must not poll or retry');
  }
  assert.equal(panel.elements['nav-back'].disabled, true);
  panel.clickImage(100, 100);
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Recovery must never repeat the original action');
}

// A user-requested retry refreshes only the frame, at most once per attempt.
{
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), { ...textResult({ errorCode: 'STALE_PREVIEW_FRAME', stage: 'preview_action', inputNotSent: true }), isError: true });
  await panel.reply(panel.take('preview_frame'), { isError: true, content: [{ type: 'text', text: 'failed' }] });
  panel.elements['retry-frame'].dispatch('click');
  panel.elements['retry-frame'].dispatch('click');
  await flush();
  assert.equal(panel.elements['retry-frame'].hidden, true);
  const retry = panel.take('preview_frame');
  assert.equal(retry.params.arguments.forceRefresh, true);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_frame' || message.params?.name === 'preview_action'));
  await panel.reply(retry, imageResult('A'));
  assert.equal(panel.elements['stale-notice'].hidden, true);
  assert.equal(panel.elements['nav-back'].disabled, false);
}

// Switching devices while a manual retry is in flight cannot restore the old frame.
{
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), { ...textResult({ errorCode: 'STALE_PREVIEW_FRAME', stage: 'preview_action', inputNotSent: true }), isError: true });
  await panel.reply(panel.take('preview_frame'), { isError: true, content: [{ type: 'text', text: 'failed' }] });
  panel.elements['retry-frame'].dispatch('click');
  await flush();
  const retry = panel.take('preview_frame');
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  await panel.reply(retry, imageResult('A'));
  assert.equal(panel.elements.stage.hidden, true);
  assert.equal(panel.elements['stale-notice'].hidden, true);
  assert.equal(panel.elements['retry-frame'].hidden, true);
  assert.match(panel.elements.status.textContent, /Device ready: B/);
}

// Old hosts cannot promise a fresh capture and must never receive a force refresh.
{
  const panel = await readyPanel();
  panel.elements.start.dispatch('click');
  await panel.reply(panel.take('preview_start'), textResult({ sessionId: 'session-A', deviceId: 'A', previewRecoveryProtocol: 0 }));
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.match(panel.elements.status.textContent, /outdated.*reconnect/i);
  panel.clickImage(100, 100);
  await flush();
  await panel.reply(panel.take('preview_action'), { ...textResult({ errorCode: 'STALE_PREVIEW_FRAME', stage: 'preview_action', inputNotSent: true }), isError: true });
  assert.equal(panel.elements['stale-notice'].hidden, false);
  assert.equal(panel.elements['retry-frame'].hidden, true);
  assert.equal(panel.elements['nav-back'].disabled, true);
  assert.match(panel.elements.status.textContent, /outdated.*reconnect/i);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_frame' && message.params.arguments.forceRefresh));
}

// A stale-looking error without a known preflight stage remains ambiguous.
{
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(100, 100);
  await flush();
  const diagnostic = { errorCode: 'STALE_PREVIEW_FRAME', stage: 'device_input' };
  await panel.reply(panel.take('preview_action'), { ...textResult(diagnostic), isError: true });
  assert.equal(panel.elements.stage.hidden, false);
  assert.equal(panel.elements['stale-notice'].hidden, false);
  assert.equal(panel.elements['retry-frame'].hidden, false);
  assert.match(panel.elements.status.textContent, /Action result unknown/);
}

// An action transport error is ambiguous, while a late result must not overwrite a new device.
for (const changeDevice of [false, true]) {
  const panel = await readyPanel();
  await start(panel);
  panel.clickImage(100, 100);
  await flush();
  const action = panel.take('preview_action');
  if (changeDevice) {
    panel.elements.devices.value = 'B';
    panel.elements.devices.dispatch('change');
  }
  await panel.reply(action, { isError: true, content: [{ type: 'text', text: 'action timed out' }] });
  assert.match(panel.elements.status.textContent, changeDevice ? /Device ready: B/ : /Action result unknown: action timed out/);
  assert.equal(panel.elements.stage.hidden, changeDevice, 'Keep the old image only on the same device');
  if (!changeDevice) {
    assert.equal(panel.elements['stale-notice'].hidden, false);
    assert.equal(panel.elements['retry-frame'].hidden, false);
    assert.equal(panel.elements['nav-back'].disabled, true);
    assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_frame'), 'Unknown outcomes require a user retry');
  }
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// Back and Home bind to the live device, session and frame and wait for a post-action frame.
for (const action of ['back', 'home']) {
  const panel = await readyPanel();
  assert.equal(panel.elements[`nav-${action}`].disabled, true);
  await start(panel);
  assert.equal(panel.elements[`nav-${action}`].disabled, false);
  const seq = nextFrameSeq;
  panel.elements[`nav-${action}`].dispatch('click');
  assert.match(panel.elements.status.textContent, new RegExp(`Sending ${action}`));
  assert.equal(panel.elements['nav-back'].disabled, true);
  assert.equal(panel.elements['nav-home'].disabled, true);
  panel.elements['nav-home'].dispatch('click');
  panel.clickImage(100, 100);
  await flush();
  const request = panel.take('preview_action');
  assert.deepEqual(JSON.parse(JSON.stringify(request.params.arguments)), {
    action, deviceId: 'A', sessionId: 'session-A', subscriberId: 'subscriber-session-A', seq, frameId: `frame-${seq}`
  });
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'), 'Do not overlap navigation and gestures');
  await panel.reply(request, textResult({ metrics: { actionMs: 80, nextFrameAfterSeq: seq } }));
  assert.match(panel.elements.status.textContent, /sent.*waiting for a new frame/);
  const next = panel.take('preview_frame');
  assert.equal(next.params.arguments.afterSeq, seq);
  await panel.reply(next, imageResult('A'));
  assert.match(panel.elements.status.textContent, /sent; new frame decoded/);
  assert.equal(panel.elements['nav-back'].disabled, false);
  assert.equal(panel.elements['nav-home'].disabled, false);
}

// A canceled navigation action is not counted as an unclassified pointer gesture.
{
  const panel = await readyPanel({ autoPreflight: false });
  await start(panel, 'A', 1200, 1920);
  panel.elements['nav-home'].dispatch('click');
  await flush();
  const changed = imageResult('A', 1200, 1920);
  changed.structuredContent.frame.data = '01200x1920';
  await panel.reply(panel.take('preview_frame'), changed);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  assert.match(panel.elements['action-metrics'].textContent, /Last home: canceled/);
  assert.match(panel.elements['action-summary'].textContent, /unclassified canceled 0/);
}

// A normal disconnected response clears the old frame and disables navigation until recovery.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), { structuredContent: { deviceId: 'A', connected: false, frame: null } });
  assert.equal(panel.elements.stage.hidden, true);
  assert.equal(panel.elements['nav-back'].disabled, true);
  assert.equal(panel.elements['nav-home'].disabled, true);
  panel.elements['nav-back'].dispatch('click');
  await flush();
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
  await panel.runPoll();
  await panel.reply(panel.take('preview_frame'), imageResult('A'));
  assert.equal(panel.elements['nav-back'].disabled, false);
}

// Navigation waits for an outstanding capture and uses the new frame identity.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const capture = panel.take('preview_frame');
  panel.elements['nav-back'].dispatch('click');
  await panel.reply(capture, imageResult('A'));
  const seq = nextFrameSeq;
  const action = panel.take('preview_action');
  assert.equal(action.params.arguments.seq, seq);
  assert.equal(action.params.arguments.frameId, `frame-${seq}`);
}

// An old session's late result must not overwrite the new device or its frame sequence.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements['nav-back'].dispatch('click');
  await flush();
  const oldAction = panel.take('preview_action');
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  await start(panel, 'B');
  const newSeq = nextFrameSeq;
  await panel.reply(oldAction, textResult({ metrics: { nextFrameAfterSeq: newSeq + 10000 } }));
  assert.match(panel.elements.status.textContent, /Preview running: B/);
  await panel.runPoll();
  assert.equal(panel.take('preview_frame').params.arguments.afterSeq, newSeq);
}

// Switching devices while navigation waits for a frame must not send a command to either device.
{
  const panel = await readyPanel();
  await start(panel);
  await panel.runPoll();
  const capture = panel.take('preview_frame');
  panel.elements['nav-home'].dispatch('click');
  panel.elements.devices.value = 'B';
  panel.elements.devices.dispatch('change');
  await panel.reply(capture, imageResult('A'));
  assert.match(panel.elements.status.textContent, /Device ready: B/);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// Closing the panel while navigation is in flight ignores the late result.
{
  const panel = await readyPanel();
  await start(panel);
  panel.elements['nav-home'].dispatch('click');
  await flush();
  const action = panel.take('preview_action');
  panel.windowListeners.get('pagehide')();
  await panel.reply(action, textResult({ metrics: { nextFrameAfterSeq: nextFrameSeq + 10000 } }));
  assert.match(panel.elements.status.textContent, /Preview stopped/);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_frame'));
}

// Missing barriers and failed actions remain visibly uncertain and are never retried.
for (const failure of ['missing-barrier', 'error']) {
  const panel = await readyPanel();
  await start(panel);
  panel.elements['nav-home'].dispatch('click');
  await flush();
  const action = panel.take('preview_action');
  await panel.reply(action, failure === 'error' ? { isError: true, content: [{ type: 'text', text: 'timeout' }] } : textResult({}));
  assert.match(panel.elements.status.textContent, /Result unknown|result unknown/);
  assert.equal(panel.elements.stage.hidden, false);
  assert.equal(panel.elements['retry-frame'].hidden, false);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_frame'));
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

// A sent navigation action with no fresh frame stays uncertain until the user acts again.
{
  const panel = await readyPanel();
  await start(panel);
  const seq = nextFrameSeq;
  panel.elements['nav-back'].dispatch('click');
  await flush();
  await panel.reply(panel.take('preview_action'), textResult({ metrics: { nextFrameAfterSeq: seq } }));
  await panel.reply(panel.take('preview_frame'), { structuredContent: { deviceId: 'A', connected: true, frame: null } });
  assert.match(panel.elements.status.textContent, /Action sent; no new frame yet. Result unknown/);
  assert.equal(panel.elements['nav-back'].disabled, true);
  assert.equal(panel.elements['retry-frame'].hidden, false);
  assert.ok(![...panel.timers.values()].some(({ ms }) => ms === pollIntervalMs), 'Do not silently reuse ordinary frames');
  panel.elements['retry-frame'].dispatch('click');
  await flush();
  const refresh = panel.take('preview_frame');
  assert.equal(refresh.params.arguments.forceRefresh, true);
  await panel.reply(refresh, imageResult('A'));
  assert.equal(panel.elements['nav-back'].disabled, false);
  assert.match(panel.elements.status.textContent, /Action sent; no new frame yet/);
  assert.ok(!panel.sent.some((message) => message.params?.name === 'preview_action'));
}

console.log('app: ok');

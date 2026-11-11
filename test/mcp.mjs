import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startMcp } from '../src/mcp.mjs';
import { serverVersion, diagnosticsVersion, tagError, toDiagnostic } from '../src/diagnostics.mjs';

process.env.HARMONY_PREVIEW_FAST_TAP = 'test-device';
const input = new PassThrough();
const output = new PassThrough();
const responses = createInterface({ input: output })[Symbol.asyncIterator]();
let taps = 0;
let previewTaps = 0;
let previewSwipes = 0;
let offline = false;
let captured = 0;
let frameData = Buffer.from([0xff, 0xd8, 0xff]);
let layoutError = false;
let layoutEmpty = false;
let layoutTruncated = false;
let layoutCalls = 0;
let waitStatus = 'matched';
let waitCalls = 0;
let captureOptions;
let deviceChecks = 0;
let discoveryError;
let tapError;
let lastTapArgs;
let lastSwipeArgs;
let lastInputArgs;
let tapElementError;
let tapElementCalls = 0;
let frameRotation = null;
const node = { id: 'search', text: '搜索', type: 'Button', clickable: true, enabled: true,
  bounds: { left: 0, top: 0, right: 100, bottom: 50 }, center: { x: 50, y: 25 } };
const running = startMcp({ input, output, port: 0, projectPath: '', previewTimeoutMs: 200, deviceAdapter: {
  listTargets: async () => { deviceChecks += 1; if (discoveryError) throw discoveryError; return offline ? [] : ['test-device']; },
  capture: async ({ deviceId }, options) => {
    captured += 1;
    captureOptions = options;
    if (offline || deviceId === 'disconnected') throw tagError(new Error('device disconnected'), 'DEVICE_OFFLINE', 'capture');
    if (deviceId === 'png-device') return { mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
    if (deviceId === 'landscape-device') return { mimeType: 'image/jpeg', data: frameData, width: 200, height: 100, deviceWidth: 400, deviceHeight: 200 };
    if (deviceId === 'changed-device') return { mimeType: 'image/jpeg', data: frameData, width: 100, height: 200, deviceWidth: 200, deviceHeight: 400, orientationChanged: true };
    return { mimeType: 'image/jpeg', data: frameData, width: 100, height: 200, deviceWidth: 200, deviceHeight: 400,
      ...(frameRotation === null ? {} : { rotation: frameRotation }) };
  },
  observe: async (args) => {
    layoutCalls += 1;
    if (layoutError) throw new Error('UITest layout unavailable');
    return { ...args, nodes: layoutEmpty ? [] : [node], totalNodes: layoutEmpty ? 0 : 1, truncated: layoutTruncated };
  },
  find: async (args) => {
    layoutCalls += 1;
    if (layoutError) throw new Error('UITest layout unavailable');
    return { deviceId: args.deviceId, matches: layoutEmpty ? [] : [node], totalMatches: layoutEmpty ? 0 : 1, truncated: false };
  },
  waitFor: async (args) => {
    waitCalls += 1;
    return { ...args, status: waitStatus, attempts: 2, elapsedMs: 100,
      lastObservation: { observedAt: Date.now(), nodes: [node], totalNodes: 1, truncated: false,
        matches: waitStatus === 'matched' ? [node] : [], totalMatches: waitStatus === 'matched' ? 1 : 0, matchesTruncated: false },
      warnings: [], ...(waitStatus === 'matched' ? {} : { error: waitStatus === 'timeout' ? 'Timed out waiting' : 'device disconnected' }) };
  },
  tap: async (args) => { if (tapError) throw tapError; taps += 1; lastTapArgs = args; frameData = Buffer.from('after-tap'); return args; },
  previewTap: async (args) => { previewTaps += 1; taps += 1; lastTapArgs = args; frameData = Buffer.from('after-tap'); return args; },
  tapElement: async (args) => {
    tapElementCalls += 1;
    if (tapElementError) throw tapElementError;
    return { ...args, observedAt: Date.now(), target: node, action: 'tap', verified: false };
  },
  swipe: async (args) => { lastSwipeArgs = args; return args; },
  previewSwipe: async (args) => { previewSwipes += 1; lastSwipeArgs = args; frameData = Buffer.from('after-preview-swipe'); return { ...args, metrics: { inputMethod: 'uinput' } }; },
  longPress: async (args) => args,
  keyEvent: async (args) => args,
  inputText: async (args) => { lastInputArgs = args; return args; }
} });
let id = 0;
async function request(method, params) {
  input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n');
  const line = await responses.next();
  const reply = JSON.parse(line.value);
  assert.equal(reply.id, id);
  return reply;
}

let previewUrl;
let socket;
try {
  assert.equal((await request('tools/list')).error.code, -32600);
  const initialized = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.deepEqual(initialized.result.capabilities, { tools: {}, resources: { read: true } });
  input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const listed = await request('tools/list');
  assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['list_devices', 'capture', 'observe', 'find', 'wait_for', 'tap', 'tap_element', 'swipe', 'long_press', 'key_event', 'input_text', 'preview_frame', 'preview_action', 'preview_start', 'preview_stop', 'build_run', 'preview_info', 'preview_open', 'preview_panel']);
  const buildTool = listed.result.tools.find((tool) => tool.name === 'build_run');
  assert.equal(buildTool.inputSchema.properties.moduleName.pattern, '^[A-Za-z0-9_-]+$');
  assert.equal(buildTool.inputSchema.properties.artifactName.pattern, '^[A-Za-z0-9._-]+\\.hap$');
  const entrypoint = listed.result.tools.find((tool) => tool.name === 'preview_open');
  assert.deepEqual(entrypoint._meta, {
    ui: { resourceUri: 'ui://harmonyos-preview/app', visibility: ['app'] },
    'openai/ui': { entrypoints: [{ type: 'global' }] }
  });
  const resource = await request('resources/read', { uri: 'ui://harmonyos-preview/app' });
  assert.equal(resource.result.contents[0].mimeType, 'text/html;profile=mcp-app');
  assert.ok(resource.result.contents[0].text.length < 128 * 1024, 'MCP App resource should stay small enough for host loading');
  assert.match(resource.result.contents[0].text, /HarmonyOS Preview/);
  assert.match(resource.result.contents[0].text, /ui\/initialize/);
  assert.deepEqual(resource.result.contents[0]._meta, { 'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen', 'inline'] } });
  assert.deepEqual((await request('tools/call', { name: 'preview_open', arguments: {} })).result.structuredContent, { app: 'harmonyos-preview' });
  const panel = listed.result.tools.find((tool) => tool.name === 'preview_panel');
  assert.equal(panel.title, '鸿蒙真机预览');
  assert.deepEqual(panel._meta, {
    ui: { resourceUri: 'ui://harmonyos-preview/app', visibility: ['model', 'app'] },
    'openai/ui': { entrypoints: [{ type: 'thread' }] }
  });
  assert.deepEqual((await request('tools/call', { name: 'preview_panel', arguments: {} })).result.structuredContent, { app: 'harmonyos-preview' });
  const previewFrameTool = listed.result.tools.find((tool) => tool.name === 'preview_frame');
  assert.deepEqual(previewFrameTool._meta, { ui: { visibility: ['app'] } });
  assert.equal(previewFrameTool.inputSchema.properties.waitMs.maximum, 5000);
  const previewActionTool = listed.result.tools.find((tool) => tool.name === 'preview_action');
  assert.deepEqual(previewActionTool._meta, { ui: { visibility: ['app'] } });
  assert.equal(previewActionTool.inputSchema.properties.frameId.type, 'string');
  assert.deepEqual(previewActionTool.inputSchema.properties.coordinateSpace.enum, ['device', 'frame']);
  for (const name of ['tap', 'swipe', 'long_press', 'input_text']) {
    const schema = listed.result.tools.find((tool) => tool.name === name).inputSchema.properties;
    assert.equal(schema.frameId.type, 'string');
    assert.equal(schema.seq.type, 'integer');
    assert.deepEqual(schema.coordinateSpace.enum, ['device', 'frame']);
  }
  const verifySchema = listed.result.tools.find((tool) => tool.name === 'tap_element').inputSchema.properties.verify;
  assert.equal(verifySchema.type, 'object');
  assert.deepEqual(verifySchema.required, ['selector']);
  assert.deepEqual((await request('ping')).result, {});
  const noProbe = (await request('tools/call', { name: 'preview_info' })).result.structuredContent;
  assert.equal(noProbe.previewRecoveryProtocol, 1, 'the panel must be able to identify the force-refresh protocol');
  assert.equal(noProbe.fastTapConfiguredForDevice, null, 'configuration match requires an explicitly requested device');
  assert.equal(noProbe.deviceCheck.status, 'not_checked');
  assert.equal(deviceChecks, 0, 'session status must not silently probe HDC');
  assert.equal(noProbe.runtime.serverVersion, serverVersion);
  assert.equal(noProbe.runtime.diagnosticsVersion, diagnosticsVersion);
  assert.ok(Number.isFinite(Date.parse(noProbe.runtime.startedAt)));
  assert.match(noProbe.runtime.instanceId, /^[\da-f-]{36}$/);
  const connectedInfo = (await request('tools/call', { name: 'preview_info', arguments: { deviceId: 'test-device' } })).result.structuredContent;
  assert.equal(connectedInfo.fastTapConfiguredForDevice, true, 'matching the configured device does not imply capability or action success');
  assert.equal(connectedInfo.connected, false, 'an online device does not imply a live preview frame');
  assert.equal(connectedInfo.deviceCheck.status, 'connected');
  assert.deepEqual(connectedInfo.runtime, noProbe.runtime, 'runtime identity must remain stable within the MCP instance');
  const missingInfo = (await request('tools/call', { name: 'preview_info', arguments: { deviceId: 'missing-device' } })).result;
  assert.equal(missingInfo.structuredContent.fastTapConfiguredForDevice, false);
  assert.equal(missingInfo.isError, undefined, 'device checks are embedded in the status report');
  assert.equal(missingInfo.structuredContent.deviceCheck.status, 'disconnected');
  assert.equal(missingInfo.structuredContent.deviceCheck.errorCode, 'DEVICE_OFFLINE');
  assert.equal(missingInfo.structuredContent.deviceCheck.deviceId, 'missing-device');
  process.env.HARMONY_PREVIEW_FAST_TAP = 'other-device';
  assert.equal((await request('tools/call', { name: 'preview_info', arguments: { deviceId: 'test-device' } })).result.structuredContent.fastTapConfiguredForDevice, true,
    'the diagnostic reflects the process startup configuration');
  discoveryError = tagError(Object.assign(new Error('hdc executable unavailable'), { code: 'ENOENT' }), 'HDC_UNAVAILABLE', 'device_list');
  const brokenHdc = (await request('tools/call', { name: 'preview_info', arguments: { deviceId: 'test-device' } })).result.structuredContent;
  assert.equal(brokenHdc.deviceCheck.status, 'error');
  assert.equal(brokenHdc.deviceCheck.errorCode, 'HDC_UNAVAILABLE');
  assert.equal(brokenHdc.deviceCheck.cause.code, 'ENOENT');
  const failedDiscovery = (await request('tools/call', { name: 'list_devices' })).result;
  assert.equal(failedDiscovery.isError, true);
  assert.equal(failedDiscovery.structuredContent.errorCode, 'HDC_UNAVAILABLE');
  assert.equal(failedDiscovery.structuredContent.deviceId, null);
  discoveryError = null;
  const devices = await request('tools/call', { name: 'list_devices' });
  assert.deepEqual(JSON.parse(devices.result.content[0].text), { devices: ['test-device'] });
  const image = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(image.result.content[0], { type: 'image', mimeType: 'image/jpeg', data: '/9j/' });
  assertFreshImage(image.result, 'test-device');
  const observed = await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device', maxNodes: 20 } });
  assert.deepEqual(observed.result.structuredContent.nodes, [node]);
  assert.equal(observed.result.structuredContent.treeQuality, 'full');
  assert.equal(observed.result.structuredContent.fallback, 'none');
  assert.equal(observed.result.structuredContent.customRendered, false);
  const found = await request('tools/call', { name: 'find', arguments: { deviceId: 'test-device', selector: { text: '搜索', clickable: true }, limit: 3 } });
  assert.deepEqual(found.result.structuredContent.matches, [node]);
  for (const arguments_ of [
    { deviceId: 'test-device', selector: {} },
    { deviceId: 'test-device', selector: { unknown: 'value' } },
    { deviceId: 'test-device', selector: { id: 'search' }, x: 12, y: 24 },
    { deviceId: 'test-device', selector: { id: 'search' }, limit: 1 },
    { deviceId: 'test-device', selector: { id: 'search' }, bundleName: 'bad;bundle' }
  ]) {
    assert.equal((await request('tools/call', { name: 'tap_element', arguments: arguments_ })).error.code, -32602);
  }
  assert.equal(tapElementCalls, 0, 'invalid element arguments must never reach the adapter');
  const elementTap = (await request('tools/call', { name: 'tap_element', arguments: { deviceId: 'test-device', selector: { id: 'search' } } })).result;
  assert.equal(elementTap.isError, undefined);
  assert.equal(elementTap.structuredContent.action, 'tap');
  assert.equal(elementTap.structuredContent.verified, false);
  assert.deepEqual(elementTap.structuredContent.target, node);
  assert.equal(tapElementCalls, 1);
  const verifiedElementTap = (await request('tools/call', { name: 'tap_element', arguments: {
    deviceId: 'test-device', selector: { id: 'search' },
    verify: { selector: { id: 'search' }, state: 'present', timeoutMs: 100, intervalMs: 100 }
  } })).result;
  assert.equal(verifiedElementTap.isError, undefined);
  assert.equal(verifiedElementTap.structuredContent.verified, true);
  assert.equal(verifiedElementTap.structuredContent.verification.status, 'matched');
  waitStatus = 'timeout';
  const timedVerification = (await request('tools/call', { name: 'tap_element', arguments: {
    deviceId: 'test-device', selector: { id: 'search' },
    verify: { selector: { text: '完成' }, state: 'present', timeoutMs: 100, intervalMs: 100 }
  } })).result;
  assert.equal(timedVerification.isError, undefined);
  assert.equal(timedVerification.structuredContent.verified, false);
  assert.equal(timedVerification.structuredContent.verification.status, 'timeout');
  waitStatus = 'matched';
  for (const errorCode of ['ELEMENT_NOT_FOUND', 'ELEMENT_AMBIGUOUS', 'ELEMENT_NOT_ACTIONABLE', 'STALE_OBSERVATION']) {
    tapElementError = tagError(new Error('element precondition rejected'), errorCode, 'tap_element');
    const before = tapElementCalls;
    const refused = (await request('tools/call', { name: 'tap_element', arguments: { deviceId: 'test-device', selector: { id: 'search' } } })).result;
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent.errorCode, errorCode);
    assert.equal(refused.structuredContent.stage, 'tap_element');
    assert.equal(refused.structuredContent.deviceId, 'test-device');
    assert.equal(refused.content[1].type, 'image');
    assert.equal(refused.structuredContent.screenshot.live, false);
    assert.equal(tapElementCalls, before + 1, 'rejected element taps must not be retried');
  }
  tapElementError = null;
  const capturesBeforeWait = captured;
  const waited = await request('tools/call', { name: 'wait_for', arguments: { deviceId: 'test-device', selector: { id: 'search', text: '搜索' } } });
  assert.equal(waited.result.structuredContent.status, 'matched');
  assert.equal(waited.result.isError, undefined);
  assert.equal(captured, capturesBeforeWait, 'a successful wait needs no fallback screenshot');
  const waitCallsBeforeInvalid = waitCalls;
  for (const arguments_ of [
    { deviceId: 'test-device', selector: {} },
    { deviceId: 'test-device', selector: { path: 'outside' } },
    { deviceId: 'test-device', selector: { id: 'search' }, state: 'gone' },
    { deviceId: 'test-device', selector: { id: 'search' }, timeoutMs: 0 },
    { deviceId: 'test-device', selector: { id: 'search' }, timeoutMs: 30001 },
    { deviceId: 'test-device', selector: { id: 'search' }, timeoutMs: 1.5 },
    { deviceId: 'test-device', selector: { id: 'search' }, intervalMs: 99 },
    { deviceId: 'test-device', selector: { id: 'search' }, intervalMs: 5001 },
    { deviceId: 'test-device', selector: { id: 'search' }, bundleName: 'com..bad' },
    { deviceId: 'test-device', selector: { id: 'search' }, directory: 'outside' }
  ]) {
    assert.equal((await request('tools/call', { name: 'wait_for', arguments: arguments_ })).error.code, -32602);
  }
  assert.equal(waitCalls, waitCallsBeforeInvalid, 'invalid wait arguments must not reach the adapter');
  waitStatus = 'timeout';
  const waitTimeout = await request('tools/call', { name: 'wait_for', arguments: { deviceId: 'test-device', selector: { id: 'missing' }, state: 'present', timeoutMs: 50 } });
  assert.equal(waitTimeout.result.isError, true);
  assert.equal(waitTimeout.result.structuredContent.status, 'timeout');
  assert.equal(waitTimeout.result.structuredContent.errorCode, 'WAIT_TIMEOUT');
  assert.equal(waitTimeout.result.structuredContent.stage, 'wait_for');
  assert.equal(waitTimeout.result.structuredContent.attempts, 2);
  assert.equal(waitTimeout.result.structuredContent.lastObservation.totalNodes, 1);
  assert.equal(waitTimeout.result.content[1].type, 'image');
  assert.equal(waitTimeout.result.structuredContent.screenshot.live, false);
  assert.deepEqual(captureOptions, { timeoutMs: 3000 }, 'failure evidence must have a bounded capture budget');
  waitStatus = 'observation_failed';
  offline = true;
  const waitOffline = await request('tools/call', { name: 'wait_for', arguments: { deviceId: 'test-device', selector: { id: 'search' }, state: 'absent' } });
  assert.equal(waitOffline.result.isError, true);
  assert.equal(waitOffline.result.structuredContent.status, 'observation_failed');
  assert.match(waitOffline.result.structuredContent.error, /disconnected/);
  assert.match(waitOffline.result.structuredContent.screenshotError, /disconnected/);
  assert.equal(waitOffline.result.structuredContent.errorCode, 'LAYOUT_UNAVAILABLE', 'an untagged layout error must not be guessed to be device offline');
  assert.equal(waitOffline.result.structuredContent.screenshotDiagnostic.errorCode, 'DEVICE_OFFLINE');
  assert.equal(waitOffline.result.structuredContent.screenshotDiagnostic.stage, 'capture');
  assert.deepEqual((await request('ping')).result, {}, 'a failed wait must leave the MCP responsive');
  offline = false;
  waitStatus = 'matched';
  const callsBeforeInvalid = layoutCalls;
  for (const arguments_ of [
    { deviceId: 'test-device', selector: {} },
    { deviceId: 'test-device', selector: { text: '搜索', directory: 'outside' } },
    { deviceId: 'test-device', selector: { clickable: 'true' } },
    { deviceId: 'test-device', selector: { text: '搜索' }, limit: 1.5 }
  ]) {
    assert.equal((await request('tools/call', { name: 'find', arguments: arguments_ })).error.code, -32602);
  }
  assert.equal((await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device', maxNodes: 0 } })).error.code, -32602);
  for (const bundleName of ['com.example; invalid', '123', 'com..x', 'com.' + 'x'.repeat(252)]) {
    assert.equal((await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device', bundleName } })).error.code, -32602);
  }
  assert.equal(layoutCalls, callsBeforeInvalid, 'invalid selectors must not reach the adapter');
  layoutEmpty = true;
  for (const name of ['observe', 'find']) {
    const fallback = await request('tools/call', { name, arguments: { deviceId: 'test-device', ...(name === 'find' ? { selector: { text: 'missing' } } : {}) } });
    assert.equal(fallback.result.structuredContent.screenshotFallback, true);
    assert.equal(fallback.result.structuredContent.fallback, 'screenshot');
    assert.equal(fallback.result.structuredContent.customRendered, true);
    if (name === 'observe') assert.equal(fallback.result.structuredContent.treeQuality, 'empty');
    assert.equal(fallback.result.content[1].type, 'image');
    assert.equal(fallback.result.isError, undefined, 'empty matches are an observation, not a tool failure');
  }
  layoutEmpty = false;
  layoutTruncated = true;
  const truncatedLayout = await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device', maxNodes: 1 } });
  assert.equal(truncatedLayout.result.structuredContent.truncated, true);
  assert.equal(truncatedLayout.result.structuredContent.treeQuality, 'partial');
  assert.equal(truncatedLayout.result.structuredContent.fallback, 'screenshot');
  assert.equal(truncatedLayout.result.structuredContent.customRendered, true);
  assert.equal(truncatedLayout.result.content[1].type, 'image', 'truncated layouts should retain visual context');
  layoutTruncated = false;
  layoutError = true;
  const failedLayout = await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device' } });
  assert.equal(failedLayout.result.isError, true);
  assert.equal(failedLayout.result.structuredContent.errorCode, 'LAYOUT_UNAVAILABLE');
  assert.equal(failedLayout.result.structuredContent.stage, 'observe');
  assert.equal(failedLayout.result.structuredContent.cause.message, 'UITest layout unavailable');
  assert.ok(failedLayout.result.structuredContent.elapsedMs >= 0);
  assert.equal(failedLayout.result.content[1].type, 'image', 'layout failures must still supply screenshot evidence');
  offline = true;
  const failedBoth = await request('tools/call', { name: 'observe', arguments: { deviceId: 'test-device' } });
  assert.equal(failedBoth.result.isError, true);
  assert.match(failedBoth.result.structuredContent.screenshotError, /disconnected/);
  offline = false;
  layoutError = false;
  tapError = tagError(Object.assign(new Error('uiInput failed'), { exitCode: 1 }), 'ACTION_FAILED', 'tap');
  const failedTap = (await request('tools/call', { name: 'tap', arguments: { deviceId: 'test-device', x: 12, y: 24 } })).result;
  assert.equal(failedTap.isError, true);
  assert.equal(failedTap.structuredContent.errorCode, 'ACTION_FAILED');
  assert.equal(failedTap.structuredContent.stage, 'tap');
  assert.equal(failedTap.structuredContent.cause.exitCode, 1);
  assert.equal(failedTap.content[1].type, 'image');
  assert.equal(taps, 0, 'failed actions must not be retried');
  tapError = null;
  const previewStarted = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  const session = JSON.parse(previewStarted.result.content[0].text);
  assert.equal(session.deviceId, 'test-device');
  assert.equal(session.running, true);
  assert.equal(session.connected, true);
  assert.equal(session.pollMs, 500);
  assert.match(session.sessionId, /^[\da-f-]{36}$/);
  assert.equal(session.wsUrl, session.serverUrl.replace('http:', 'ws:') + 'preview');
  assert.equal(new URL(session.previewUrl).searchParams.get('deviceId'), 'test-device');
  const previewFrame = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } });
  assert.deepEqual(previewFrame.result.content, [], 'App-only frames must not enter model content');
  assert.equal(previewFrame.result.structuredContent.deviceId, 'test-device');
  assert.equal(previewFrame.result.structuredContent.connected, true);
  assert.ok(previewFrame.result.structuredContent.seq >= 1);
  assert.equal(previewFrame.result.structuredContent.frame.mimeType, 'image/jpeg');
  const sameFrame = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: previewFrame.result.structuredContent.seq } });
  assert.equal(sameFrame.result.content.length, 0);
  assert.equal(sameFrame.result.structuredContent.frame, null, 'afterSeq must suppress duplicate frames');
  const boundFrame = previewFrame.result.structuredContent.frame;
  assert.match(boundFrame.frameId, /^[\da-f-]{36}$/);
  assert.equal(boundFrame.width, 100);
  assert.equal(boundFrame.height, 200);
  const boundSeq = previewFrame.result.structuredContent.seq;
  const boundTap = await request('tools/call', { name: 'tap', arguments: {
    deviceId: 'test-device', x: 50, y: 100, frameId: boundFrame.frameId, seq: boundSeq, coordinateSpace: 'frame'
  } });
  assert.equal(boundTap.result.isError, undefined);
  assert.equal(lastTapArgs.x, 100);
  assert.equal(lastTapArgs.y, 200);
  assert.equal(lastTapArgs.coordinateSpace, 'device');
  assert.equal(lastTapArgs.frameId, boundFrame.frameId);
  const staleBoundTap = await request('tools/call', { name: 'tap', arguments: {
    deviceId: 'test-device', x: 50, y: 100, frameId: boundFrame.frameId, seq: boundSeq - 1, coordinateSpace: 'frame'
  } });
  assert.equal(staleBoundTap.result.isError, true);
  assert.equal(staleBoundTap.result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  assert.equal(taps, 1, 'stale frame-bound actions must not reach the adapter');
  const wrongIdentityTap = await request('tools/call', { name: 'tap', arguments: {
    deviceId: 'test-device', x: 50, y: 100, frameId: '00000000-0000-0000-0000-000000000000', seq: boundSeq, coordinateSpace: 'frame'
  } });
  assert.equal(wrongIdentityTap.result.isError, true);
  assert.equal(wrongIdentityTap.result.structuredContent.errorCode, 'STALE_PREVIEW_FRAME');
  assert.equal(taps, 1, 'wrong frame identities must not reach the adapter');
  const refreshedFrame = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: boundSeq, waitMs: 600 } });
  assert.ok(refreshedFrame.result.structuredContent.frame, 'a bound action should expose a newer frame');
  const refreshedMeta = refreshedFrame.result.structuredContent;
  const refreshedId = refreshedMeta.frame.frameId;
  const refreshedSeq = refreshedMeta.seq;
  await request('tools/call', { name: 'swipe', arguments: {
    deviceId: 'test-device', fromX: 10, fromY: 20, toX: 90, toY: 180,
    frameId: refreshedId, seq: refreshedSeq, coordinateSpace: 'frame'
  } });
  assert.deepEqual({ fromX: lastSwipeArgs.fromX, fromY: lastSwipeArgs.fromY, toX: lastSwipeArgs.toX, toY: lastSwipeArgs.toY },
    { fromX: 20, fromY: 40, toX: 180, toY: 360 });
  assert.equal(lastSwipeArgs.velocity, undefined, 'public swipe must retain the device adapter default velocity');
  const afterSwipe = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: refreshedSeq, waitMs: 600 } });
  const inputFrame = afterSwipe.result.structuredContent.frame ? afterSwipe.result.structuredContent : refreshedMeta;
  const inputId = inputFrame.frame.frameId;
  const inputSeq = inputFrame.seq;
  await request('tools/call', { name: 'input_text', arguments: {
    deviceId: 'test-device', text: 'bound', x: 25, y: 50,
    frameId: inputId, seq: inputSeq, coordinateSpace: 'frame'
  } });
  assert.deepEqual({ x: lastInputArgs.x, y: lastInputArgs.y }, { x: 50, y: 100 });
  const afterInput = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: inputSeq, waitMs: 600 } });
  const actionSeq = afterInput.result.structuredContent.frame ? afterInput.result.structuredContent.seq : inputSeq;
  const actionFrameId = afterInput.result.structuredContent.frame?.frameId ?? inputId;
  const previewAction = await request('tools/call', { name: 'preview_action', arguments: { action: 'tap', deviceId: 'test-device', sessionId: session.sessionId, frameId: actionFrameId, seq: actionSeq, x: 10, y: 20 } });
  assert.deepEqual(previewAction.result.content, [], 'App-only actions must not enter model content');
  assert.equal(previewAction.result.structuredContent.x, 10);
  assert.equal(previewAction.result.structuredContent.metrics.action, 'tap');
  assert.ok(Number.isFinite(previewAction.result.structuredContent.metrics.actionMs));
  assert.ok(Number.isInteger(previewAction.result.structuredContent.metrics.nextFrameAfterSeq));
  assert.equal(taps, 2);
  assert.equal(previewTaps, 1, 'portrait preview tap may use the fast path');
  const portraitSwipeFrame = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: actionSeq, waitMs: 600 } })).result.structuredContent;
  assert.ok(portraitSwipeFrame.frame, 'portrait swipe needs a current frame');
  const portraitSwipe = (await request('tools/call', { name: 'preview_action', arguments: {
    action: 'swipe', deviceId: 'test-device', sessionId: session.sessionId, x: 10, y: 20, toX: 90, toY: 180,
    frameId: portraitSwipeFrame.frame.frameId, seq: portraitSwipeFrame.seq, coordinateSpace: 'frame'
  } })).result;
  assert.equal(portraitSwipe.isError, undefined);
  assert.equal(previewSwipes, 1, 'portrait panel swipe may use the opt-in adapter path');
  assert.equal(portraitSwipe.structuredContent.metrics.inputMethod, 'uinput');
  assert.ok(Number.isInteger(portraitSwipe.structuredContent.metrics.nextFrameAfterSeq), 'fast gestures retain the post-action frame barrier');
  frameRotation = 90;
  frameData = Buffer.from('after-preview-swipe-rotated');
  const rotatedPreview = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: portraitSwipe.structuredContent.metrics.nextFrameAfterSeq, waitMs: 2000 } });
  assert.ok(rotatedPreview.result.structuredContent.frame, 'rotation metadata must arrive with a fresh frame');
  const rotationTap = await request('tools/call', { name: 'tap', arguments: {
    deviceId: 'test-device', x: 10, y: 20,
    frameId: rotatedPreview.result.structuredContent.frame.frameId,
    seq: rotatedPreview.result.structuredContent.seq, coordinateSpace: 'frame'
  } });
  assert.equal(rotationTap.result.isError, undefined);
  assert.deepEqual({ x: lastTapArgs.x, y: lastTapArgs.y }, { x: 20, y: 360 }, '90-degree frame coordinates must map into device coordinates');
  assert.equal(taps, 3, 'supported rotation-bound actions must reach the adapter');
  const panelFrame = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: rotatedPreview.result.structuredContent.seq, waitMs: 600 } });
  const panelTap = await request('tools/call', { name: 'preview_action', arguments: {
    action: 'tap', deviceId: 'test-device', sessionId: session.sessionId, x: 10, y: 20, frameId: panelFrame.result.structuredContent.frame.frameId,
    seq: panelFrame.result.structuredContent.seq, coordinateSpace: 'frame'
  } });
  assert.equal(panelTap.result.isError, undefined);
  assert.equal(panelTap.result.structuredContent.metrics.inputMethod, 'uitest', 'rotation fallback must report the actual input path');
  assert.deepEqual({ x: lastTapArgs.x, y: lastTapArgs.y }, { x: 20, y: 360 }, 'panel tap must use the same rotation transform');
  assert.equal(previewTaps, 1, 'rotated preview taps must use the standard path');
  const swipeFrame = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: panelFrame.result.structuredContent.seq, waitMs: 600 } });
  const panelSwipe = await request('tools/call', { name: 'preview_action', arguments: {
    action: 'swipe', deviceId: 'test-device', sessionId: session.sessionId, x: 10, y: 20, toX: 90, toY: 180, frameId: swipeFrame.result.structuredContent.frame.frameId,
    seq: swipeFrame.result.structuredContent.seq, coordinateSpace: 'frame'
  } });
  assert.equal(panelSwipe.result.isError, undefined);
  assert.equal(lastSwipeArgs.velocity, 1200, 'panel swipe must use the dedicated preview gesture velocity');
  assert.equal(previewSwipes, 1, 'rotated panel swipes use the standard path');
  assert.deepEqual({ fromX: lastSwipeArgs.fromX, fromY: lastSwipeArgs.fromY, toX: lastSwipeArgs.toX, toY: lastSwipeArgs.toY },
    { fromX: 20, fromY: 360, toX: 180, toY: 40 }, 'panel swipe must transform both endpoints');
  frameRotation = 45;
  const unsupportedPreview = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: swipeFrame.result.structuredContent.seq, waitMs: 600 } });
  const unsupportedRotation = await request('tools/call', { name: 'tap', arguments: {
    deviceId: 'test-device', x: 10, y: 20,
    frameId: unsupportedPreview.result.structuredContent.frame.frameId,
    seq: unsupportedPreview.result.structuredContent.seq, coordinateSpace: 'frame'
  } });
  assert.equal(unsupportedRotation.result.isError, true);
  assert.equal(unsupportedRotation.result.structuredContent.errorCode, 'FRAME_TRANSFORM_UNAVAILABLE');
  assert.equal(taps, 4, 'unsupported rotation must not reach the adapter');
  const unsupportedPanelTap = await request('tools/call', { name: 'preview_action', arguments: {
    action: 'tap', deviceId: 'test-device', sessionId: session.sessionId, x: 10, y: 20, frameId: unsupportedPreview.result.structuredContent.frame.frameId,
    seq: unsupportedPreview.result.structuredContent.seq, coordinateSpace: 'frame'
  } });
  assert.equal(unsupportedPanelTap.result.isError, true);
  assert.equal(unsupportedPanelTap.result.structuredContent.errorCode, 'FRAME_TRANSFORM_UNAVAILABLE');
  assert.equal(taps, 4, 'unsupported panel rotation must not reach the adapter');
  frameRotation = null;
  frameData = Buffer.from([0xff, 0xd8, 0xff]);
  const previewPage = await (await fetch(session.previewUrl)).text();
  assert.match(previewPage, /requestedDeviceId/);
  assert.ok(session.capabilities.includes('tap'));
  const repeated = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(JSON.parse(repeated.result.content[0].text), session, 'repeated start must reuse the same session');
  assert.equal((await request('tools/call', { name: 'preview_stop', arguments: { sessionId: 'stale-session' } })).result.isError, true);
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).sessionId, session.sessionId);
  const liveImage = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.deepEqual(liveImage.result.content[0], { type: 'image', mimeType: 'image/jpeg', data: '/9j/' });
  assertFreshImage(liveImage.result, 'test-device');
  offline = true;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).connected, false);
  assert.equal((await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } })).result.isError, true, 'offline capture must not return a stale cached image');
  offline = false;
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text).connected, true);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'swipe', arguments: { deviceId: 'test-device', fromX: 1, fromY: 2, toX: 3, toY: 4 } })).result.content[0].text).toX, 3);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'long_press', arguments: { deviceId: 'test-device', x: 1, y: 2 } })).result.content[0].text).x, 1);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'key_event', arguments: { deviceId: 'test-device', key: 'Back' } })).result.content[0].text).key, 'Back');
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'input_text', arguments: { deviceId: 'test-device', text: 'hello' } })).result.content[0].text).text, 'hello');
  const previewRefreshBeforeTap = captured;
  await request('tools/call', { name: 'tap', arguments: { deviceId: 'test-device', x: 12, y: 24 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(captured > previewRefreshBeforeTap, 'model actions must refresh the active live preview immediately');
  assert.equal(taps, 5);
  const capturesBefore = captured;
  const afterTap = await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device' } });
  assert.ok(captured > capturesBefore, 'capture must sample the device even when a live preview exists');
  assert.equal(Buffer.from(afterTap.result.content[0].data, 'base64').toString(), 'after-tap', 'capture after tap must return the updated device frame');
  assert.notEqual(afterTap.result.structuredContent.frameId, liveImage.result.structuredContent.frameId);
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'preview_stop', arguments: { sessionId: session.sessionId } })).result.content[0].text), { running: false, deviceId: 'test-device', sessionId: session.sessionId });
  assert.deepEqual(JSON.parse((await request('tools/call', { name: 'preview_stop' })).result.content[0].text), { running: false });
  const firstPanel = (await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device', subscriber: true } })).result.structuredContent;
  const secondPanel = (await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device', subscriber: true } })).result.structuredContent;
  assert.equal(firstPanel.sessionId, secondPanel.sessionId, 'panels for the same device share the capture session');
  assert.ok(firstPanel.subscriberId && secondPanel.subscriberId && firstPanel.subscriberId !== secondPanel.subscriberId, 'each panel has a distinct subscription');
  const deviceConflict = (await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'png-device', subscriber: true } })).result;
  assert.equal(deviceConflict.isError, true, 'another panel cannot silently switch the active device');
  assert.equal(deviceConflict.structuredContent.errorCode, 'PREVIEW_IN_USE');
  const released = (await request('tools/call', { name: 'preview_stop', arguments: { sessionId: firstPanel.sessionId, subscriberId: firstPanel.subscriberId } })).result.structuredContent;
  assert.equal(released.running, true, 'releasing one panel must keep another panel connected');
  const remainingFrame = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0, sessionId: secondPanel.sessionId, subscriberId: secondPanel.subscriberId } })).result.structuredContent;
  assert.ok(remainingFrame.frame, 'the other panel must still read the current frame');
  const remainingAction = (await request('tools/call', { name: 'preview_action', arguments: { action: 'home', deviceId: 'test-device', sessionId: secondPanel.sessionId, subscriberId: secondPanel.subscriberId, frameId: remainingFrame.frame.frameId, seq: remainingFrame.seq } })).result;
  assert.notEqual(remainingAction.isError, true, 'the other panel must still be able to act');
  const staleRelease = (await request('tools/call', { name: 'preview_stop', arguments: { sessionId: firstPanel.sessionId, subscriberId: firstPanel.subscriberId } })).result;
  assert.equal(staleRelease.isError, true, 'a released subscription cannot stop another panel');
  const finalRelease = (await request('tools/call', { name: 'preview_stop', arguments: { sessionId: secondPanel.sessionId, subscriberId: secondPanel.subscriberId } })).result.structuredContent;
  assert.equal(finalRelease.running, false, 'the last panel releases the capture session');
  const pngStarted = JSON.parse((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'png-device' } })).result.content[0].text);
  assert.notEqual(pngStarted.sessionId, session.sessionId);
  const pngFrame = await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } });
  const pngBoundTap = await request('tools/call', { name: 'tap', arguments: {
    deviceId: 'png-device', x: 1, y: 1, frameId: pngFrame.result.structuredContent.frame.frameId,
    seq: pngFrame.result.structuredContent.seq, coordinateSpace: 'frame'
  } });
  assert.equal(pngBoundTap.result.isError, true);
  assert.equal(pngBoundTap.result.structuredContent.errorCode, 'FRAME_TRANSFORM_UNAVAILABLE');
  const pngPanelTap = await request('tools/call', { name: 'preview_action', arguments: {
    action: 'tap', deviceId: 'png-device', sessionId: pngStarted.sessionId, x: 1, y: 1, frameId: pngFrame.result.structuredContent.frame.frameId, seq: pngFrame.result.structuredContent.seq
  } });
  assert.equal(pngPanelTap.result.isError, undefined);
  assert.equal(pngPanelTap.result.structuredContent.metrics.inputMethod, 'uitest', 'missing dimensions must report the standard input path');
  assert.equal(previewTaps, 1, 'missing dimensions must use the standard path');
  const pngSwipeFrame = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: pngPanelTap.result.structuredContent.metrics.nextFrameAfterSeq, waitMs: 2000 } })).result.structuredContent;
  const pngSwipe = (await request('tools/call', { name: 'preview_action', arguments: {
    action: 'swipe', deviceId: 'png-device', sessionId: pngStarted.sessionId, x: 1, y: 1, toX: 2, toY: 2,
    frameId: pngSwipeFrame.frame.frameId, seq: pngSwipeFrame.seq
  } })).result;
  assert.equal(pngSwipe.isError, undefined, JSON.stringify(pngSwipe.structuredContent));
  assert.equal(previewSwipes, 1, 'missing frame dimensions must not use the preview swipe path');
  const pngCapture = await request('tools/call', { name: 'capture', arguments: { deviceId: 'png-device' } });
  assert.deepEqual(pngCapture.result.content[0], { type: 'image', mimeType: 'image/png', data: 'iVBORw==' });
  assertFreshImage(pngCapture.result, 'png-device');
  for (const deviceId of ['landscape-device', 'changed-device']) {
    await request('tools/call', { name: 'preview_start', arguments: { deviceId } });
    const frame = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } })).result.structuredContent;
    const action = await request('tools/call', { name: 'preview_action', arguments: {
      action: 'tap', deviceId, sessionId: frame.sessionId, x: 1, y: 1, frameId: frame.frame.frameId, seq: frame.seq
    } });
    assert.equal(action.result.isError, undefined);
    assert.equal(previewTaps, 1, `${deviceId} must use the standard path`);
    const swipeFrame = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: action.result.structuredContent.metrics.nextFrameAfterSeq, waitMs: 2000 } })).result.structuredContent;
    const swipe = (await request('tools/call', { name: 'preview_action', arguments: {
      action: 'swipe', deviceId, sessionId: swipeFrame.sessionId, x: 1, y: 1, toX: 2, toY: 2,
      frameId: swipeFrame.frame.frameId, seq: swipeFrame.seq
    } })).result;
    assert.equal(swipe.isError, undefined);
    assert.equal(previewSwipes, 1, `${deviceId} must not use the preview swipe path`);
  }
  const replaced = JSON.parse((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } })).result.content[0].text);
  assert.notEqual(replaced.sessionId, pngStarted.sessionId, 'switching device must replace the session');
  const timedOut = await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'disconnected' } });
  assert.equal(timedOut.result.isError, true);
  assert.match(timedOut.result.content[0].text, /Timed out/);
  const stoppedInfo = JSON.parse((await request('tools/call', { name: 'preview_info' })).result.content[0].text);
  assert.equal(stoppedInfo.running, false);
  assert.equal(stoppedInfo.sessionId, null);
  for (const args of [{ deviceId: 'test-device', x: -1, y: 24 }, { deviceId: 'test-device', x: '12', y: 24 }, null]) {
    assert.equal((await request('tools/call', { name: 'tap', arguments: args })).error.code, -32602);
  }
  assert.equal(taps, 8, 'invalid arguments must not reach the device');
  assert.equal((await request('tools/call', { name: 'capture', arguments: { deviceId: 'test-device', directory: 'outside' } })).error.code, -32602);
  assert.equal((await request('tools/call', { name: 'unknown' })).error.code, -32602);
  assert.equal((await request('unknown')).error.code, -32601);
  const disconnected = await request('tools/call', { name: 'capture', arguments: { deviceId: 'disconnected' } });
  assert.equal(disconnected.result.isError, true);
  assert.match(disconnected.result.content[0].text, /disconnected/);
  const build = await request('tools/call', { name: 'build_run', arguments: { deviceId: 'test-device' } });
  assert.equal(build.result.isError, true);
  assert.match(build.result.content[0].text, /HARMONY_PROJECT/);
  input.write('invalid json\n');
  assert.equal(JSON.parse((await responses.next()).value).error.code, -32700);
  const info = await request('tools/call', { name: 'preview_info' });
  previewUrl = JSON.parse(info.result.content[0].text).previewUrl;
  assert.equal((await fetch(previewUrl + 'health')).status, 200);
  socket = new WebSocket(previewUrl.replace('http:', 'ws:') + 'preview');
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  assert.equal((await request('tools/call', { name: 'preview_start', arguments: { deviceId: 'test-device' } })).result.isError, undefined, 'leave a live session for EOF cleanup');
} finally {
  input.end();
  await running;
  socket?.terminate();
  output.end();
}
await assert.rejects(fetch(previewUrl + 'health'), /fetch failed/);

// Exercise the actual CLI over stdio, including a working directory outside the repository.
const child = spawn(process.execPath, [fileURLToPath(new URL('../bin/harmonyos-preview.mjs', import.meta.url)), '--mcp'], {
  cwd: process.env.TEMP, env: { ...process.env, HARMONY_PREVIEW_PORT: '0' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });
const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
const cliReplies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' }
} }) + '\n');
assert.equal(JSON.parse((await cliReplies.next()).value).result.serverInfo.name, 'harmonyos-preview');
child.stdin.end();
assert.equal(await exited, 0, stderr);
assert.equal((await cliReplies.next()).done, true, 'stdout must contain only MCP responses');
console.log('mcp: ok');

const nestedCause = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
const nestedDiagnostic = toDiagnostic(new Error('state save failed', { cause: nestedCause }), { elapsedMs: NaN });
assert.deepEqual(nestedDiagnostic.cause, { message: 'disk full', code: 'ENOSPC' });
assert.equal(nestedDiagnostic.elapsedMs, 0);

function assertFreshImage(result, deviceId) {
  assert.equal(result.structuredContent.deviceId, deviceId);
  assert.equal(result.structuredContent.live, false);
  assert.equal(result.structuredContent.sessionId, null);
  assert.match(result.structuredContent.frameId, /^[\da-f-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(result.structuredContent.capturedAt)));
}

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { OpenAIUiResourceMetadataSchema, OpenAIUiToolMetadataSchema } from '@openai/mcp-extensions/server';
import { createDeviceAdapter } from './device.mjs';
import { createPreviewServer } from './server.mjs';
import { buildAndRun } from './build.mjs';
import { describeLayout } from './layout.mjs';
import { serverVersion, diagnosticsVersion, tagError, toDiagnostic } from './diagnostics.mjs';

const device = { type: 'string', minLength: 1, description: 'Device ID from list_devices' };
const previewPreInput = Symbol('previewPreInput');
const selector = {
  type: 'object', minProperties: 1, additionalProperties: false,
  properties: {
    text: { type: 'string', minLength: 1 }, textContains: { type: 'string', minLength: 1 },
    id: { type: 'string', minLength: 1 }, type: { type: 'string', minLength: 1 },
    clickable: { type: 'boolean' }, enabled: { type: 'boolean' }
  }, required: []
};
const bundleName = { type: 'string', minLength: 1, maxLength: 255, pattern: '^[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+$', description: 'Optional target application bundle name.' };
const buildModuleName = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$', description: 'Optional HarmonyOS module directory. Defaults to entry.' };
const buildArtifactName = { type: 'string', minLength: 5, maxLength: 255, pattern: '^[A-Za-z0-9._-]+\\.hap$', description: 'Optional HAP file name when a module produces multiple artifacts.' };
const frameId = { type: 'string', minLength: 1, maxLength: 128, description: 'Frame identity returned by preview_frame.' };
const frameSeq = { type: 'integer', minimum: 0, description: 'Live preview sequence returned by preview_frame.' };
const coordinateSpace = { type: 'string', enum: ['device', 'frame'], description: 'device uses HDC coordinates; frame scales coordinates from the bound preview frame.' };
const verification = {
  type: 'object', additionalProperties: false, required: ['selector'],
  properties: {
    selector,
    state: { type: 'string', enum: ['present', 'absent'] },
    timeoutMs: { type: 'integer', minimum: 1, maximum: 30000 },
    intervalMs: { type: 'integer', minimum: 100, maximum: 5000 }
  },
  description: 'Optional post-tap selector check.'
};
const appResourceUri = 'ui://harmonyos-preview/app';
const appResourcePath = fileURLToPath(new URL('./app/resource.html', import.meta.url));
const appToolUiMetadata = { entrypoints: [{ type: 'global' }] };
const panelToolUiMetadata = { entrypoints: [{ type: 'thread' }] };
const appResourceUiMetadata = { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['fullscreen', 'inline'] };
const configuredActionPrepareTimeoutMs = Number(process.env.HARMONY_PREVIEW_ACTION_PREPARE_TIMEOUT_MS ?? 1000);
const actionPrepareTimeoutMs = Number.isFinite(configuredActionPrepareTimeoutMs)
  ? Math.min(5000, Math.max(5, Math.floor(configuredActionPrepareTimeoutMs))) : 1000;
OpenAIUiToolMetadataSchema.parse(appToolUiMetadata);
OpenAIUiToolMetadataSchema.parse(panelToolUiMetadata);
OpenAIUiResourceMetadataSchema.parse(appResourceUiMetadata);
const tools = [
  { name: 'list_devices', description: 'List connected HarmonyOS devices and emulators.', properties: {}, required: [] },
  { name: 'capture', description: 'Capture a fresh device image. Never returns a cached preview frame; asynchronous page transitions may still require another observation.', properties: { deviceId: device }, required: ['deviceId'] },
  { name: 'observe', description: 'Read the current UITest component tree. Exposed nodes may omit custom-rendered content; truncated or empty trees do not prove absence. Falls back to a fresh screenshot on empty or unavailable layout.', properties: { deviceId: device, bundleName, maxNodes: { type: 'integer', minimum: 1, maximum: 1000 } }, required: ['deviceId'] },
  { name: 'find', description: 'Find current components by exact text, ID, type or textContains and optional state filters (AND). Returns all candidates up to limit without clicking. No matches triggers a fresh screenshot; do not infer absence from an incomplete tree.', properties: { deviceId: device, bundleName, selector, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['deviceId', 'selector'] },
  { name: 'wait_for', description: 'Wait for a selector to be present or absent in the exposed UI hierarchy; use id and text together to wait for expected text. Absence requires a nonempty full hierarchy and does not prove business success. Returns matched, timeout or observation_failed with the last observation. Failures try a fresh screenshot with a 3s budget; HDC cleanup can add up to 2s each for the final observation and screenshot.', properties: { deviceId: device, bundleName, selector, state: { type: 'string', enum: ['present', 'absent'] }, timeoutMs: { type: 'integer', minimum: 1, maximum: 30000, description: 'Polling budget in milliseconds; default 5000.' }, intervalMs: { type: 'integer', minimum: 100, maximum: 5000, description: 'Delay between completed observations in milliseconds; default 500.' } }, required: ['deviceId', 'selector'] },
  { name: 'tap', description: 'Click the device at coordinates. Bind frameId and seq to reject stale frames; coordinateSpace=frame safely scales preview pixels to device pixels. Changes device UI state.', properties: { deviceId: device, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, frameId, seq: frameSeq, coordinateSpace }, required: ['deviceId', 'x', 'y'] },
  { name: 'tap_element', description: 'Find and tap exactly one current control using the same AND selector as find. Requires a clickable control that is not explicitly disabled or hidden, valid bounds/center, and an observation no older than 1s. Refuses missing, ambiguous, invalid or stale targets without tapping. Executes at most one tap, with no retries. Changes device UI state and requires user authorization. Pass verify.selector to wait for the expected post-tap state; verified is true only when that check matches. UI changes can still race the tap; never repeat a failed action automatically.', properties: { deviceId: device, bundleName, selector, verify: verification }, required: ['deviceId', 'selector'] },
  { name: 'swipe', description: 'Swipe between two coordinates. Bind frameId and seq to reject stale frames; coordinateSpace=frame safely scales preview pixels to device pixels. Changes device UI state.', properties: { deviceId: device, fromX: { type: 'number', minimum: 0 }, fromY: { type: 'number', minimum: 0 }, toX: { type: 'number', minimum: 0 }, toY: { type: 'number', minimum: 0 }, velocity: { type: 'number', minimum: 200, maximum: 40000 }, frameId, seq: frameSeq, coordinateSpace }, required: ['deviceId', 'fromX', 'fromY', 'toX', 'toY'] },
  { name: 'long_press', description: 'Long press a coordinate. Bind frameId and seq to reject stale frames; coordinateSpace=frame safely scales preview pixels to device pixels. Changes device UI state.', properties: { deviceId: device, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, frameId, seq: frameSeq, coordinateSpace }, required: ['deviceId', 'x', 'y'] },
  { name: 'key_event', description: 'Send Back, Home or Power to the device. Changes device UI state.', properties: { deviceId: device, key: { type: 'string', enum: ['Back', 'Home', 'Power'] } }, required: ['deviceId'] },
  { name: 'input_text', description: 'Input text at the focused field or a coordinate. Bind frameId and seq when coordinates come from a preview frame; coordinateSpace=frame scales them safely. Changes device UI state.', properties: { deviceId: device, text: { type: 'string', minLength: 1 }, x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 }, frameId, seq: frameSeq, coordinateSpace }, required: ['deviceId', 'text'] },
  {
    name: 'preview_frame',
    description: 'Return the newest in-memory live preview frame for the MCP App. App-only; use afterSeq to avoid rendering the same frame twice. Optionally wait for the next frame after an interaction.',
    properties: {
      afterSeq: { type: 'integer', minimum: 0 },
      waitMs: { type: 'integer', minimum: 0, maximum: 5000, description: 'Optional wait for a frame newer than afterSeq.' },
      forceRefresh: { type: 'boolean', description: 'Request a newly sampled frame for the current session.' },
      deviceId: device,
      sessionId: { type: 'string', minLength: 1 },
      subscriberId: { type: 'string', minLength: 1, maxLength: 128 }
    }, required: [],
    _meta: { ui: { visibility: ['app'] } }
  },
  {
    name: 'preview_action',
    description: 'Execute one pointer or Back/Home action from the MCP App against the current live preview frame. Requires the active deviceId and sessionId; stale frames are rejected.',
    properties: {
      action: { type: 'string', enum: ['tap', 'swipe', 'back', 'home'] },
      deviceId: device,
      frameId,
      sessionId: { type: 'string', minLength: 1 },
      subscriberId: { type: 'string', minLength: 1, maxLength: 128 },
      seq: { type: 'integer', minimum: 0 },
      coordinateSpace,
      x: { type: 'number', minimum: 0 }, y: { type: 'number', minimum: 0 },
      toX: { type: 'number', minimum: 0 }, toY: { type: 'number', minimum: 0 }
    }, required: ['action', 'seq'],
    _meta: { ui: { visibility: ['app'] } }
  },
  { name: 'preview_start', description: 'Start live screenshot polling and return the preview URL. Apps may request their own subscription.', properties: { deviceId: device, subscriber: { type: 'boolean' } }, required: ['deviceId'] },
  { name: 'preview_stop', description: 'Stop live screenshot polling. Apps may release their own subscription without stopping other panels.', properties: { sessionId: { type: 'string', minLength: 1 }, subscriberId: { type: 'string', minLength: 1, maxLength: 128 } }, required: [] },
  { name: 'build_run', description: 'Build the configured project, install one selected module HAP and launch it. Defaults to entry; specify artifactName when the module produces multiple HAP artifacts. Changes device state; requires user authorization.', properties: { deviceId: device, moduleName: buildModuleName, artifactName: buildArtifactName }, required: ['deviceId'] },
  { name: 'preview_info', description: 'Return preview status, loaded capabilities and runtime identity. Optional deviceId checks HDC availability without starting preview. connected describes live preview frames, not device connectivity; this service cannot verify or refresh the host tool cache.', properties: { deviceId: device }, required: [] },
  {
    name: 'preview_open', title: 'HarmonyOS Preview',
    description: 'Open the HarmonyOS Preview app. The app can select a device and control its live preview.',
    properties: {}, required: [],
    _meta: {
      ui: { resourceUri: appResourceUri, visibility: ['app'] },
      'openai/ui': appToolUiMetadata
    }
  },
  {
    name: 'preview_panel', title: '鸿蒙真机预览',
    description: 'Open the HarmonyOS live device preview beside the current conversation in its right side panel.',
    properties: {}, required: [],
    _meta: {
      ui: { resourceUri: appResourceUri, visibility: ['model', 'app'] },
      'openai/ui': panelToolUiMetadata
    }
  }
].map(({ properties, required, ...tool }) => ({ ...tool, inputSchema: { type: 'object', properties, required, additionalProperties: false } }));

const textResult = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const defaultPreviewStatePath = fileURLToPath(new URL('../.runtime/preview-session.json', import.meta.url));

export async function startMcp({ input = process.stdin, output = process.stdout, deviceAdapter = createDeviceAdapter(),
  projectPath = process.env.HARMONY_PROJECT, port = Number(process.env.HARMONY_PREVIEW_PORT ?? 0), previewTimeoutMs = 10000,
  previewUrl = process.env.HARMONY_PREVIEW_URL, previewStatePath = process.env.HARMONY_PREVIEW_STATE ?? defaultPreviewStatePath,
  previewStateTtlMs = Number(process.env.HARMONY_PREVIEW_STATE_TTL_MS ?? 86400000),
  frameLeaseMs = 5000, subscriptionLeaseMs = 60000, autoStartPreview = process.env.HARMONY_PREVIEW_AUTOSTART === '1' } = {}) {
  const configuredPreviewUrl = previewUrl ? normalizePreviewUrl(previewUrl) : null;
  const fastTapConfiguredDevice = process.env.HARMONY_PREVIEW_FAST_TAP ?? '';
  const runtime = { serverVersion, diagnosticsVersion, startedAt: new Date().toISOString(), instanceId: randomUUID() };
  const ownsPreviewServer = !configuredPreviewUrl;
  let livePreview;
  const deviceTails = new Map();
  const server = ownsPreviewServer ? createPreviewServer({ deviceAdapter, runDeviceAction: runServerDeviceAction }) : null;
  if (server) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const serverUrl = configuredPreviewUrl ?? `http://127.0.0.1:${server.address().port}/`;
  const wsUrl = serverUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') + 'preview';
  frameLeaseMs = Number.isFinite(frameLeaseMs) && frameLeaseMs > 0 ? frameLeaseMs : 5000;
  subscriptionLeaseMs = Number.isFinite(subscriptionLeaseMs) && subscriptionLeaseMs > 0 ? subscriptionLeaseMs : 60000;
  let previewLifecycle = Promise.resolve();
  await ensurePreviewService();
  let persistedPreview = ownsPreviewServer ? null : await readPreviewState(previewStatePath, previewStateTtlMs);
  const lines = createInterface({ input, crlfDelay: Infinity });
  let state = 'new';
  const inFlight = new Map();
  const pending = new Set();
  let writes = Promise.resolve();
  try {
    for await (const line of lines) {
      let request;
      let response;
      try {
        if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('Message too large');
        request = JSON.parse(line);
      } catch { response = rpcError(null, -32700, 'Parse error or message too large'); }
      if (!response) {
        const valid = request && !Array.isArray(request) && request.jsonrpc === '2.0' && typeof request.method === 'string'
          && (!Object.hasOwn(request, 'id') || typeof request.id === 'string' || Number.isInteger(request.id));
        if (!valid) response = rpcError(null, -32600, 'Invalid Request');
        else if (!Object.hasOwn(request, 'id')) {
          if (request.method === 'notifications/cancelled' || request.method === '$/cancelRequest') {
            const requestId = request.params?.requestId ?? request.params?.id;
            const controller = inFlight.get(requestId);
            controller?.abort(new Error(request.params?.reason || 'Request cancelled'));
            continue;
          }
          if (request.method === 'notifications/initialized' && state === 'initializing') state = 'ready';
          continue;
        } else {
          const controller = new AbortController();
          inFlight.set(request.id, controller);
          const task = (async () => {
            let result;
            try {
              result = { jsonrpc: '2.0', id: request.id, result: await dispatch(request, { signal: controller.signal }) };
            } catch (error) {
              result = controller.signal.aborted || error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
                ? rpcError(request.id, -32800, 'Request cancelled')
                : rpcError(request.id, error.rpcCode ?? -32603, error.message);
            } finally {
              if (inFlight.get(request.id) === controller) inFlight.delete(request.id);
            }
            writes = writes.then(() => writeResponse(result));
            await writes;
          })();
          pending.add(task);
          task.finally(() => pending.delete(task)).catch(() => {});
          continue;
        }
      }
      writes = writes.then(() => writeResponse(response));
      await writes;
    }
  } finally {
    lines.close();
    for (const controller of inFlight.values()) controller.abort(new Error('MCP connection closed'));
    await Promise.allSettled([...pending]);
    await writes;
    await stopLivePreview(undefined, { clearPersisted: false });
    if (server) await server.shutdown();
  }

  async function writeResponse(response) {
    if (output.writableEnded || output.destroyed) return;
    await new Promise((resolve, reject) => output.write(JSON.stringify(response) + '\n', (error) => error ? reject(error) : resolve()));
  }

  async function withDeviceLock(deviceId, signal, operation) {
    if (!deviceId) return operation();
    const previous = deviceTails.get(deviceId) ?? Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    const tail = previous.catch(() => {}).then(() => turn);
    deviceTails.set(deviceId, tail);
    try {
      await waitForTurn(previous, signal);
      if (signal?.aborted) throw cancellationError();
      return await operation();
    } finally {
      release();
      tail.finally(() => {
        if (deviceTails.get(deviceId) === tail) deviceTails.delete(deviceId);
      }).catch(() => {});
    }
  }

  async function runServerDeviceAction(deviceId, operation, isLive = () => true) {
    if (typeof deviceId !== 'string' || !deviceId.trim()) throw new Error('deviceId is required');
    return withDeviceLock(deviceId, undefined, async () => {
      if (!isLive()) throw new Error('Input request disconnected before execution');
      const active = livePreview?.deviceId === deviceId ? livePreview : null;
      if (active) active.inputAfterSeq = active.seq;
      try { return await operation(); }
      finally { await invalidatePreviewAfterInput(deviceId); }
    });
  }

  async function withPreviewLifecycle(signal, operation) {
    const previous = previewLifecycle;
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    previewLifecycle = previous.catch(() => {}).then(() => turn);
    try {
      await waitForTurn(previous, signal);
      if (signal?.aborted) throw cancellationError();
      return await operation();
    } finally { release(); }
  }

  function waitForTurn(previous, signal) {
    if (signal?.aborted) return Promise.reject(cancellationError());
    if (!signal) return previous;
    return Promise.race([previous, new Promise((_, reject) => {
      const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(cancellationError()); };
      signal.addEventListener('abort', onAbort, { once: true });
      previous.finally(() => signal.removeEventListener('abort', onAbort)).catch(() => {});
    })]);
  }

  async function dispatch({ method, params }, { signal } = {}) {
    if (signal?.aborted) throw cancellationError();
    if (method === 'ping') return {};
    if (method === 'initialize') {
      if (state !== 'new') throw Object.assign(new Error('Already initialized'), { rpcCode: -32600 });
      if (!params || typeof params.protocolVersion !== 'string' || !params.clientInfo || !params.capabilities) {
        throw Object.assign(new Error('Invalid initialize params'), { rpcCode: -32602 });
      }
      state = 'initializing';
      const versions = ['2024-11-05', '2025-03-26', '2025-06-18'];
      return { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions.at(-1),
        capabilities: { tools: {}, resources: { read: true } }, serverInfo: { name: 'harmonyos-preview', version: serverVersion } };
    }
    if (state !== 'ready') throw Object.assign(new Error('Initialize the session first'), { rpcCode: -32600 });
    if (method === 'tools/list') return { tools };
    if (method === 'resources/read') {
      if (params?.uri !== appResourceUri) throw Object.assign(new Error('Unknown resource'), { rpcCode: -32602 });
      return {
        contents: [{
          uri: appResourceUri,
          mimeType: 'text/html;profile=mcp-app',
          text: await readFile(appResourcePath, 'utf8'),
          _meta: { 'openai/ui': appResourceUiMetadata }
        }]
      };
    }
    if (method !== 'tools/call') throw Object.assign(new Error('Method not found'), { rpcCode: -32601 });
    const tool = tools.find((item) => item.name === params?.name);
    if (!tool) throw Object.assign(new Error('Unknown tool'), { rpcCode: -32602 });
    const args = params.arguments ?? {};
    validateArguments(tool.inputSchema, args);
    const startedAt = performance.now();
    try {
      if (tool.name === 'preview_open' || tool.name === 'preview_panel') return { content: [], structuredContent: { app: 'harmonyos-preview' } };
      if (tool.name === 'list_devices') return textResult({ devices: await deviceAdapter.listTargets({ signal }) });
      if (tool.name === 'preview_info') {
        const info = { ...previewInfo(), projectPath: projectPath ?? null,
          fastTapConfiguredForDevice: args.deviceId ? args.deviceId === fastTapConfiguredDevice : null };
        try { await ensurePreviewService(); }
        catch (error) {
          if (signal?.aborted) throw cancellationError();
          info.serviceDiagnostic = toDiagnostic(error,
            { errorCode: 'PREVIEW_UNAVAILABLE', stage: 'preview_service', deviceId: args.deviceId, elapsedMs: performance.now() - startedAt });
        }
        if (args.deviceId) {
          const checkedAt = new Date().toISOString();
          try {
            const devices = await deviceAdapter.listTargets({ signal });
            info.deviceCheck = devices.includes(args.deviceId)
              ? { status: 'connected', deviceId: args.deviceId, devices, checkedAt, elapsedMs: Math.round(performance.now() - startedAt) }
              : { status: 'disconnected', devices, checkedAt, ...toDiagnostic(new Error('Device is not connected: ' + args.deviceId),
                { errorCode: 'DEVICE_OFFLINE', stage: 'device_check', deviceId: args.deviceId, elapsedMs: performance.now() - startedAt }) };
          } catch (error) {
            if (signal?.aborted) throw cancellationError();
            info.deviceCheck = { status: 'error', checkedAt, ...toDiagnostic(error,
              { errorCode: 'HDC_FAILED', stage: 'device_check', deviceId: args.deviceId, elapsedMs: performance.now() - startedAt }) };
          }
        }
        if (signal?.aborted) throw cancellationError();
        return textResult(info);
      }
      if (tool.name === 'wait_for') {
        const waited = await deviceAdapter.waitFor(args, { signal });
        return waited.status === 'matched' ? textResult(waited) : observationFallback({ ...waited, ...toDiagnostic(waited,
          { errorCode: waited.status === 'timeout' ? 'WAIT_TIMEOUT' : 'LAYOUT_UNAVAILABLE', stage: 'wait_for', deviceId: args.deviceId, elapsedMs: waited.elapsedMs }) }, args.deviceId, true, { timeoutMs: 3000 });
      }
      if (tool.name === 'observe' || tool.name === 'find') {
        try {
          const rawObserved = await deviceAdapter[tool.name](args, { signal });
          const observed = tool.name === 'observe' ? enrichObservation(rawObserved) : rawObserved;
          if (tool.name === 'find' ? observed.totalMatches === 0 : observed.totalNodes === 0 || observed.truncated) {
            return observationFallback(observed, args.deviceId, false, { timeoutMs: 3000, signal });
          }
          return textResult(observed);
        } catch (error) {
          return observationFallback({ ...toDiagnostic(error,
            { errorCode: 'LAYOUT_UNAVAILABLE', stage: tool.name, deviceId: args.deviceId, elapsedMs: performance.now() - startedAt }),
            warnings: ['UITest layout is unavailable. Inspect the screenshot; no device action was executed.'] }, args.deviceId, true, { timeoutMs: 3000, signal });
        }
      }
      if (['tap', 'tap_element', 'swipe', 'long_press', 'key_event', 'input_text'].includes(tool.name)) {
        const result = await withDeviceLock(args.deviceId, signal, async () => {
          const actionArgs = tool.name === 'tap_element' ? args : resolveCoordinateAction(tool.name, args);
          const active = livePreview?.deviceId === args.deviceId ? livePreview : null;
          if (active) active.inputAfterSeq = active.seq;
          try {
            if (tool.name === 'tap_element' && args.verify) {
              const { verify, ...tapArgs } = args;
              const tapped = await deviceAdapter.tapElement(tapArgs, { signal });
              const verificationResult = await deviceAdapter.waitFor({ deviceId: args.deviceId, bundleName: args.bundleName, ...verify }, { signal });
              return { ...tapped, verified: verificationResult.status === 'matched', verification: verificationResult };
            }
            return await deviceAdapter[tool.name === 'tap_element' ? 'tapElement' : tool.name === 'long_press' ? 'longPress' : tool.name === 'key_event' ? 'keyEvent' : tool.name === 'input_text' ? 'inputText' : tool.name](actionArgs, { signal });
          } finally {
            await invalidatePreviewAfterInput(args.deviceId);
          }
        });
        return textResult(result);
      }
      if (tool.name === 'build_run') return textResult(await withDeviceLock(args.deviceId, signal, async () => {
        const active = livePreview?.deviceId === args.deviceId ? livePreview : null;
        if (active) active.inputAfterSeq = active.seq;
        try {
          return await buildAndRun(deviceAdapter, {
            projectPath, deviceId: args.deviceId, moduleName: args.moduleName, artifactName: args.artifactName, signal
          });
        } finally {
          await invalidatePreviewAfterInput(args.deviceId);
        }
      }));
      if (tool.name === 'preview_frame') {
        const validate = args.subscriberId ? () => touchSubscription(args.sessionId, args.subscriberId) : undefined;
        validate?.();
        if (args.forceRefresh) {
          const result = await withDeviceLock(args.deviceId, signal, () => {
            validate?.();
            return refreshLiveFrame(args, signal);
          });
          validate?.();
          return result;
        }
        return await liveFrameResult(args.afterSeq ?? 0, args.waitMs ?? 0, signal, validate);
      }
      if (tool.name === 'preview_action') return await withDeviceLock(args.deviceId, signal, () => {
        if (args.subscriberId) touchSubscription(args.sessionId, args.subscriberId);
        return previewAction(args, { signal });
      });
      if (tool.name === 'preview_start') return textResult(await withPreviewLifecycle(signal, () => startPreviewSubscription(args, { signal })));
      if (tool.name === 'preview_stop') return textResult(await withPreviewLifecycle(signal, () => stopPreviewSubscription(args)));
      const captureStartedAt = performance.now();
      const frame = await deviceAdapter.capture({ deviceId: args.deviceId }, { signal });
      const captureMs = Math.max(0, Math.round(performance.now() - captureStartedAt));
      const captureStages = Object.fromEntries(['combinedMs', 'snapshotMs', 'transferMs', 'readMs']
        .filter((key) => Number.isFinite(frame.captureTiming?.[key]) && frame.captureTiming[key] >= 0)
        .map((key) => [key, frame.captureTiming[key]]));
      return imageResult(frame.data, frame.mimeType, { ...frameMetadata(frame, args.deviceId),
        metrics: { captureMs, ...(Object.keys(captureStages).length ? { captureStages } : {}) } });
    } catch (error) {
      if (signal?.aborted) throw cancellationError();
      const errorCode = tool.name === 'capture' ? 'CAPTURE_FAILED' : tool.name === 'list_devices' ? 'HDC_FAILED'
        : tool.name === 'build_run' ? 'BUILD_FAILED' : tool.name.startsWith('preview_') ? 'PREVIEW_UNAVAILABLE' : 'ACTION_FAILED';
      const diagnostic = toDiagnostic(error, { errorCode, stage: tool.name, deviceId: args.deviceId ?? livePreview?.deviceId, elapsedMs: performance.now() - startedAt });
      if (diagnostic.stage === 'preview_subscription') return { ...textResult(diagnostic), isError: true };
      if (tool.name === 'preview_action' && error?.[previewPreInput] === true &&
        ['STALE_PREVIEW_FRAME', 'FRAME_COORDINATE_OUT_OF_BOUNDS', 'DEVICE_COORDINATE_OUT_OF_BOUNDS', 'SWIPE_SAME_DEVICE_POINT'].includes(diagnostic.errorCode)) {
        diagnostic.inputNotSent = true;
        if (diagnostic.errorCode === 'STALE_PREVIEW_FRAME' && ['consumed', 'sequence_changed', 'frame_changed', 'frame_pair_pending'].includes(error.staleReason) &&
            ['before_pause', 'after_pause'].includes(error.stalePhase)) {
          diagnostic.staleReason = error.staleReason;
          diagnostic.stalePhase = error.stalePhase;
        }
        return { ...textResult(diagnostic), isError: true };
      }
      if (args.deviceId && tool.name !== 'capture') return observationFallback(diagnostic, args.deviceId, true, { timeoutMs: 3000, signal });
      return { ...textResult(diagnostic), isError: true };
    }
  }

  function resolveCoordinateAction(toolName, args) {
    const space = args.coordinateSpace ?? 'device';
    const hasBinding = args.frameId !== undefined || args.seq !== undefined || space === 'frame';
    if (!hasBinding) return args;
    const state = livePreview;
    const stale = (message) => { throw tagError(new Error(message), 'STALE_PREVIEW_FRAME', 'action_frame'); };
    if (!state || state.deviceId !== args.deviceId || !state.connected) stale('Preview is not connected for the requested device');
    if (state.pendingFrameMeta || state.discardFrame) stale('A preview frame is incomplete; request a complete frame before acting');
    if (state.inputAfterSeq !== undefined && state.seq <= state.inputAfterSeq) stale('Preview frame was consumed by an input; request a new frame before acting');
    if (args.seq !== undefined && state.seq !== args.seq) stale('Preview frame sequence is stale; request a new frame before acting');
    if (args.frameId !== undefined && state.frameMeta?.frameId !== args.frameId) stale('Preview frame identity is stale; request a new frame before acting');
    if (space === 'device') {
      const meta = state.frameMeta ?? {};
      const calibrated = [meta.deviceWidth, meta.deviceHeight].every((value) => Number.isSafeInteger(value) && value > 0) &&
        meta.orientationChanged !== true && normalizeRotation(meta.rotation) === 0;
      const points = [[args.x ?? args.fromX, args.y ?? args.fromY]];
      if (toolName === 'swipe') points.push([args.toX, args.toY]);
      const focusedText = toolName === 'input_text' && args.x === undefined && args.y === undefined;
      if (calibrated && !focusedText && points.some(([x, y]) => Number.isFinite(x) && Number.isFinite(y) &&
        (Math.round(x) >= meta.deviceWidth || Math.round(y) >= meta.deviceHeight))) {
        throw tagError(new Error('device coordinates must be inside the calibrated device image'), 'DEVICE_COORDINATE_OUT_OF_BOUNDS', 'action_frame');
      }
      return args;
    }
    if (args.frameId === undefined || args.seq === undefined) {
      throw tagError(new Error('frame coordinates require frameId and seq'), 'FRAME_BINDING_REQUIRED', 'action_frame');
    }
    const frameMeta = state.frameMeta ?? {};
    const dimensions = [frameMeta.width, frameMeta.height, frameMeta.deviceWidth, frameMeta.deviceHeight];
    if (!dimensions.every((value) => Number.isFinite(value) && value > 0)) {
      throw tagError(new Error('frame coordinates require preview and device dimensions'), 'FRAME_TRANSFORM_UNAVAILABLE', 'action_frame');
    }
    const rotation = normalizeRotation(frameMeta.rotation);
    if (frameMeta.orientationChanged === true && (frameMeta.rotation == null || rotation === undefined)) {
      throw tagError(new Error('frame coordinates require a fresh orientation calibration'), 'FRAME_TRANSFORM_UNAVAILABLE', 'action_frame');
    }
    if (frameMeta.rotation !== undefined && rotation === undefined) {
      throw tagError(new Error('unsupported frame rotation'), 'FRAME_TRANSFORM_UNAVAILABLE', 'action_frame');
    }
    if (toolName === 'input_text' && (args.x === undefined || args.y === undefined)) {
      throw tagError(new Error('frame coordinates require x and y'), 'FRAME_BINDING_REQUIRED', 'action_frame');
    }
    const points = [[args.x ?? args.fromX, args.y ?? args.fromY]];
    if (toolName === 'swipe') points.push([args.toX, args.toY]);
    if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) ||
      x < 0 || y < 0 || x >= frameMeta.width || y >= frameMeta.height)) {
      throw tagError(new Error('frame coordinates must be inside the preview image'), 'FRAME_COORDINATE_OUT_OF_BOUNDS', 'action_frame');
    }
    const scale = (value, sourceSize, deviceSize) => value * deviceSize / sourceSize;
    const transformPoint = (x, y) => {
      const sourceX = scale(x, frameMeta.width, frameMeta.deviceWidth);
      const sourceY = scale(y, frameMeta.height, frameMeta.deviceHeight);
      if (!rotation) return { x: sourceX, y: sourceY };
      if (rotation === 90) return { x: scale(y, frameMeta.height, frameMeta.deviceWidth), y: frameMeta.deviceHeight - scale(x, frameMeta.width, frameMeta.deviceHeight) };
      if (rotation === 180) return { x: frameMeta.deviceWidth - sourceX, y: frameMeta.deviceHeight - sourceY };
      return { x: frameMeta.deviceWidth - scale(y, frameMeta.height, frameMeta.deviceWidth), y: scale(x, frameMeta.width, frameMeta.deviceHeight) };
    };
    const clamp = (value, size) => Math.min(size - 1, Math.max(0, Math.round(value)));
    const transformed = { ...args, coordinateSpace: 'device' };
    const first = transformPoint(args.x ?? args.fromX, args.y ?? args.fromY);
    if (toolName === 'swipe') {
      const second = transformPoint(args.toX, args.toY);
      transformed.fromX = clamp(first.x, frameMeta.deviceWidth);
      transformed.fromY = clamp(first.y, frameMeta.deviceHeight);
      transformed.toX = clamp(second.x, frameMeta.deviceWidth);
      transformed.toY = clamp(second.y, frameMeta.deviceHeight);
    } else {
      transformed.x = clamp(first.x, frameMeta.deviceWidth);
      transformed.y = clamp(first.y, frameMeta.deviceHeight);
    }
    return transformed;
  }

  function normalizeRotation(value) {
    if (value === undefined || value === null || value === 0) return 0;
    if (!Number.isFinite(value)) return undefined;
    const normalized = ((Math.round(value) % 360) + 360) % 360;
    return [90, 180, 270].includes(normalized) ? normalized : undefined;
  }

  async function observationFallback(observed, deviceId, isError = false, captureOptions = { timeoutMs: 3000 }) {
    if (captureOptions.signal?.aborted) throw cancellationError();
    const result = textResult({ ...observed, fallback: 'screenshot', customRendered: true, screenshotFallback: true });
    if (isError) result.isError = true;
    const startedAt = performance.now();
    try {
      const frame = await deviceAdapter.capture({ deviceId }, captureOptions);
      result.content.push(...imageResult(frame.data, frame.mimeType, {}).content);
      result.structuredContent.screenshot = frameMetadata(frame, deviceId);
    } catch (error) {
      if (captureOptions.signal?.aborted) throw cancellationError();
      result.structuredContent.screenshotError = error.message;
      result.structuredContent.screenshotDiagnostic = toDiagnostic(error,
        { errorCode: 'CAPTURE_FAILED', stage: 'capture', deviceId, elapsedMs: performance.now() - startedAt });
    }
    result.content[0].text = JSON.stringify(result.structuredContent);
    return result;
  }

  function enrichObservation(observed) {
    if (!observed || typeof observed !== 'object' || !Number.isInteger(observed.totalNodes)) return observed;
    const quality = describeLayout(observed);
    return {
      ...observed,
      ...quality,
      warnings: [...new Set([...(observed.warnings ?? []), ...quality.warnings])]
    };
  }

  function touchSubscription(sessionId, subscriberId) {
    const state = livePreview;
    if (!state || !sessionId || sessionId !== state.sessionId || !state.subscribers.has(subscriberId)) {
      throw tagError(new Error('Preview subscription is no longer active; start preview again'), 'PREVIEW_UNAVAILABLE', 'preview_subscription');
    }
    if (state.subscribers.get(subscriberId) <= Date.now()) {
      state.subscribers.delete(subscriberId);
      throw tagError(new Error('Preview subscription expired; start preview again'), 'PREVIEW_UNAVAILABLE', 'preview_subscription');
    }
    state.subscribers.set(subscriberId, Date.now() + subscriptionLeaseMs);
    scheduleSubscriptionExpiry(state);
  }

  function scheduleSubscriptionExpiry(state) {
    if (state.subscriptionTimer || !state.subscribers.size) return;
    const nextExpiry = Math.min(...state.subscribers.values());
    state.subscriptionTimer = setTimeout(() => {
      state.subscriptionTimer = null;
      withPreviewLifecycle(undefined, async () => {
        if (livePreview !== state) return;
        for (const [id, expiry] of state.subscribers) if (expiry <= Date.now()) state.subscribers.delete(id);
        if (!state.publicOwner && !state.subscribers.size) await stopLivePreview(state.sessionId);
        else scheduleSubscriptionExpiry(state);
      }).catch(() => {});
    }, Math.max(1, nextExpiry - Date.now()));
    state.subscriptionTimer.unref?.();
  }

  async function startPreviewSubscription(args, { signal } = {}) {
    const current = livePreview;
    if (args.subscriber && current && current.deviceId !== args.deviceId && (current.publicOwner || current.subscribers.size)) {
      throw tagError(new Error('Another preview is using a different device; stop it before switching devices'), 'PREVIEW_IN_USE', 'preview_subscription');
    }
    const info = await startLivePreview(args.deviceId, { signal });
    const state = livePreview;
    if (!state || state.sessionId !== info.sessionId) throw new Error('Preview session changed during start');
    if (!args.subscriber) {
      state.publicOwner = true;
      return info;
    }
    const subscriberId = randomUUID();
    state.subscribers.set(subscriberId, Date.now() + subscriptionLeaseMs);
    scheduleSubscriptionExpiry(state);
    return { ...info, subscriberId };
  }

  async function stopPreviewSubscription({ sessionId, subscriberId } = {}) {
    if (!subscriberId) return stopLivePreview(sessionId);
    const state = livePreview;
    if (!state || !sessionId || sessionId !== state.sessionId || !state.subscribers.delete(subscriberId)) {
      throw tagError(new Error('Preview subscription does not match the active session'), 'PREVIEW_UNAVAILABLE', 'preview_subscription');
    }
    if (!state.publicOwner && !state.subscribers.size) return stopLivePreview(sessionId);
    return { running: true, deviceId: state.deviceId, sessionId: state.sessionId, released: true };
  }

  async function startLivePreview(deviceId, { signal } = {}) {
    if (signal?.aborted) throw cancellationError();
    if (deviceAdapter.preparePreviewTap) Promise.resolve().then(() => deviceAdapter.preparePreviewTap({ deviceId })).catch(() => {});
    if (deviceAdapter.preparePreviewSwipe) Promise.resolve().then(() => deviceAdapter.preparePreviewSwipe({ deviceId })).catch(() => {});
    if (livePreview?.deviceId === deviceId && livePreview.paused && livePreview.socket?.readyState === WebSocket.OPEN) {
      livePreview.paused = false;
      livePreview.lastFrameAccessAt = Date.now();
      livePreview.socket.send(JSON.stringify({ type: 'preview-resume', deviceId }));
      touchFrameLease(livePreview);
      return previewInfo();
    }
    if (livePreview?.deviceId === deviceId && livePreview.settled && livePreview.socket?.readyState === WebSocket.OPEN) return previewInfo();
    await ensurePreviewService();
    await stopLivePreview();
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);
      const state = { socket, sessionId: randomUUID(), deviceId, frame: null, frameMeta: null, pendingFrameMeta: null, discardFrame: false, seq: 0, receivedAt: null,
        lastFrameAccessAt: Date.now(), leaseTimer: null, paused: false, mimeType: 'image/jpeg', started: false,
        connected: false, settled: false, saving: false, pollMs: null, frameSource: null, lastMetrics: null,
        frameWaiters: new Set(), refreshWaiters: new Set(), actionWaiters: new Map(), subscribers: new Map(), publicOwner: false, subscriptionTimer: null };
      livePreview = state;
      const timer = setTimeout(() => fail(Object.assign(new Error('Timed out waiting for the first preview frame; check device connection'),
        state.lastDiagnostic ? { errorCode: state.lastDiagnostic.errorCode, stage: state.lastDiagnostic.stage, cause: state.lastDiagnostic.cause } : {})), previewTimeoutMs);
      const fail = (error) => {
        if (state.settled) return;
        state.settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (livePreview === state) livePreview = undefined;
        socket.terminate();
        reject(tagError(error, 'PREVIEW_UNAVAILABLE', 'preview_start'));
      };
      const onAbort = () => fail(cancellationError());
      signal?.addEventListener('abort', onAbort, { once: true });
      socket.on('open', () => socket.send(JSON.stringify({ type: 'preview-start', deviceId })));
      socket.on('error', fail);
      socket.on('close', () => {
        fail(new Error('Preview connection closed before the first frame'));
        clearTimeout(state.subscriptionTimer);
        if (livePreview === state) livePreview = undefined;
        cancelFrameWaiters(state);
        cancelActionWaiters(state);
      });
      socket.on('message', async (message, isBinary) => {
        if (state.frameProtocolBroken) return;
        if (!isBinary) {
          let event;
          try { event = JSON.parse(message.toString()); } catch {
            if (state.started && livePreview === state) invalidateFrameProtocol(state);
            return;
          }
          if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
            if (state.started && livePreview === state) invalidateFrameProtocol(state);
            return;
          }
          if (event.type === 'frame-meta') {
            if (state.started && (state.pendingFrameMeta || state.discardFrame || (event.deviceId != null && event.deviceId !== state.deviceId))) {
              invalidateFrameProtocol(state);
              return;
            }
            if (state.pendingFrameMeta || state.discardFrame) {
              state.pendingFrameMeta = null;
              state.discardFrame = true;
            } else state.pendingFrameMeta = { deviceId: event.deviceId ?? state.deviceId, frameId: event.frameId, source: event.source,
              capturedAt: event.capturedAt, width: event.width, height: event.height, deviceWidth: event.deviceWidth,
              deviceHeight: event.deviceHeight, scaled: event.scaled, requestedWidth: event.requestedWidth,
              requestedHeight: event.requestedHeight, orientationChanged: event.orientationChanged,
              rotation: event.rotation, mimeType: event.mimeType || state.mimeType, metrics: event.metrics ?? null,
              refreshIds: Array.isArray(event.refreshIds) ? event.refreshIds : [] };
          }
          if (event.type === 'preview-status') {
            if (state.started && (state.pendingFrameMeta || state.discardFrame) && (!event.running || event.paused === true)) {
              invalidateFrameProtocol(state);
              return;
            }
            if (event.running) state.started = true;
            if (!event.running) {
              state.connected = false;
              state.pendingFrameMeta = null;
              state.discardFrame = false;
              for (const waiter of state.refreshWaiters) waiter.finish(false);
            }
            if (event.paused !== undefined) state.paused = event.paused === true;
            if (event.diagnostic) state.lastDiagnostic = event.diagnostic;
            if (event.pollMs) state.pollMs = event.pollMs;
            if (event.frameSource) state.frameSource = event.frameSource;
          }
          if (event.type === 'preview-tick' && event.metrics) {
            if (event.metrics.capturedAt && event.metrics.capturedAt === state.frameMeta?.capturedAt) {
              state.lastMetrics = event.metrics;
            }
          }
          if (event.type === 'preview-action-ready' && event.actionId) {
            const waiter = state.actionWaiters.get(event.actionId);
            if (waiter) {
              clearTimeout(waiter.timer);
              state.actionWaiters.delete(event.actionId);
              waiter.resolve(true);
            }
          }
          if (event.type === 'error') fail(Object.assign(new Error(event.error),
            { ...(event.errorCode ? { errorCode: event.errorCode } : {}), ...(event.stage ? { stage: event.stage } : {}),
              ...(event.cause ? { cause: event.cause } : {}) }));
          return;
        }
        const pendingFrameMeta = state.pendingFrameMeta;
        state.pendingFrameMeta = null;
        const discardFrame = state.discardFrame;
        state.discardFrame = false;
        if (state.started && livePreview === state && (discardFrame || !pendingFrameMeta || pendingFrameMeta.deviceId !== state.deviceId)) {
          invalidateFrameProtocol(state);
          return;
        }
        if (!state.started || livePreview !== state || discardFrame || !pendingFrameMeta || pendingFrameMeta.deviceId !== state.deviceId) return;
        state.frame = Buffer.from(message);
        state.frameMeta = pendingFrameMeta;
        state.mimeType = pendingFrameMeta.mimeType;
        state.lastMetrics = pendingFrameMeta.metrics;
        state.seq += 1;
        state.receivedAt = Date.now();
        state.connected = true;
        state.paused = false;
        resolveFrameWaiters(state);
        for (const waiter of state.refreshWaiters) {
          if (state.seq > waiter.afterSeq && pendingFrameMeta.refreshIds.includes(waiter.id)) waiter.finish(true);
        }
        state.lastDiagnostic = null;
        if (!state.settled && !state.saving) {
          touchFrameLease(state);
          state.saving = true;
          try {
            await savePreviewState(state);
            if (state.settled) return;
            state.settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            resolve(previewInfo());
          } catch (error) { fail(error); }
        }
      });
    });
  }

  function liveFrameResult(afterSeq = 0, waitMs = 0, signal, validate) {
    if (signal?.aborted) throw cancellationError();
    validate?.();
    const state = livePreview;
    if (!state) return { content: [], structuredContent: { running: false, connected: false, sessionId: null, deviceId: null, seq: 0, frame: null } };
    state.lastFrameAccessAt = Date.now();
    const resumedFromPause = state.paused;
    if (state.paused && state.socket?.readyState === WebSocket.OPEN) {
      state.paused = false;
      state.socket.send(JSON.stringify({ type: 'preview-resume', deviceId: state.deviceId }));
    }
    touchFrameLease(state, waitMs > 0 ? Math.max(frameLeaseMs, waitMs) : frameLeaseMs);
    if (waitMs > 0 && (state.connected || resumedFromPause) && !(state.frame && state.seq > afterSeq)) {
      return waitForFrame(state, afterSeq, waitMs, signal).then(() => liveFrameResult(afterSeq, 0, signal, validate));
    }
    const frameMeta = state.frameMeta ?? {};
    const hasNewFrame = Boolean(state.frame && state.seq > afterSeq);
    const metrics = state.frameMeta ? {
      ...(state.lastMetrics ?? {}),
      source: state.lastMetrics?.source ?? frameMeta.source ?? state.frameSource,
      ...Object.fromEntries(['width', 'height', 'deviceWidth', 'deviceHeight', 'scaled', 'requestedWidth', 'requestedHeight',
        'orientationChanged', 'rotation', 'capturedAt'].filter((key) => frameMeta[key] !== undefined).map((key) => [key, frameMeta[key]]))
    } : null;
    return {
      content: [],
      structuredContent: {
        running: true,
        connected: state.connected,
        sessionId: state.sessionId,
        deviceId: state.deviceId,
        seq: state.seq,
        frameAgeMs: state.receivedAt ? Math.max(0, Date.now() - state.receivedAt) : null,
        frameSource: state.frameSource,
        metrics,
        frame: hasNewFrame ? {
          mimeType: frameMeta.mimeType || state.mimeType,
          data: state.frame.toString('base64'),
          frameId: frameMeta.frameId ?? null,
          seq: state.seq,
          capturedAt: frameMeta.capturedAt ?? null,
          width: frameMeta.width ?? null,
          height: frameMeta.height ?? null
        } : null
      }
    };
  }

  function waitForFrame(state, afterSeq, waitMs, signal) {
    if (signal?.aborted) throw cancellationError();
    if (state.frame && state.seq > afterSeq) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = { afterSeq, finish: (error) => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', onAbort);
        state.frameWaiters.delete(waiter);
        if (error) reject(error);
        else resolve();
      } };
      const onAbort = () => waiter.finish(cancellationError());
      waiter.timer = setTimeout(() => waiter.finish(), waitMs);
      state.frameWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function refreshLiveFrame(args, signal) {
    const state = livePreview;
    if (!state || !args.deviceId || args.deviceId !== state.deviceId || !args.sessionId || args.sessionId !== state.sessionId ||
        !state.connected || state.paused || state.socket?.readyState !== WebSocket.OPEN) {
      throw tagError(new Error('Preview session or device is unavailable for refresh'), 'PREVIEW_UNAVAILABLE', 'preview_frame');
    }
    if (signal?.aborted) throw cancellationError();
    const afterSeq = Math.max(args.afterSeq ?? 0, state.seq);
    const waitMs = args.waitMs ?? 2500;
    const id = randomUUID();
    state.lastFrameAccessAt = Date.now();
    touchFrameLease(state, Math.max(frameLeaseMs, waitMs));
    const matched = await new Promise((resolve) => {
      const waiter = { id, afterSeq, finish: (value) => {
        clearTimeout(waiter.timer);
        signal?.removeEventListener('abort', onAbort);
        state.refreshWaiters.delete(waiter);
        resolve(value);
      } };
      const onAbort = () => waiter.finish(false);
      waiter.timer = setTimeout(() => waiter.finish(false), waitMs);
      state.refreshWaiters.add(waiter);
      signal?.addEventListener('abort', onAbort, { once: true });
      try { state.socket.send(JSON.stringify({ type: 'preview-refresh', deviceId: state.deviceId, requestId: id })); }
      catch { waiter.finish(false); }
    });
    if (signal?.aborted) throw cancellationError();
    if (livePreview !== state || !state.connected) {
      throw tagError(new Error('Preview session changed during refresh'), 'PREVIEW_UNAVAILABLE', 'preview_frame');
    }
    return liveFrameResult(matched ? afterSeq : state.seq);
  }

  function resolveFrameWaiters(state) {
    for (const waiter of state.frameWaiters ?? []) {
      if (state.seq <= waiter.afterSeq) continue;
      waiter.finish();
    }
  }

  function cancelFrameWaiters(state) {
    for (const waiter of state.frameWaiters ?? []) {
      waiter.finish();
    }
    state.frameWaiters?.clear();
    for (const waiter of state.refreshWaiters ?? []) waiter.finish(false);
  }

  function cancelActionWaiters(state) {
    for (const [actionId, waiter] of state.actionWaiters ?? []) {
      clearTimeout(waiter.timer);
      state.actionWaiters.delete(actionId);
      waiter.resolve(false);
    }
  }

  function invalidateFrameProtocol(state) {
    state.frameProtocolBroken = true;
    state.connected = false;
    state.pendingFrameMeta = null;
    state.discardFrame = false;
    cancelFrameWaiters(state);
    cancelActionWaiters(state);
    if (state.socket && state.socket.readyState !== WebSocket.CLOSED) state.socket.terminate();
  }

  function pausePreviewForAction(state) {
    if (state.socket?.readyState !== WebSocket.OPEN) return Promise.resolve(false);
    const actionId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        state.actionWaiters.delete(actionId);
        resolve(false);
      }, actionPrepareTimeoutMs);
      state.actionWaiters.set(actionId, { resolve, timer });
      state.socket.send(JSON.stringify({ type: 'preview-action-start', actionId, deviceId: state.deviceId }));
    });
  }

  function refreshPreviewAfterAction(state) {
    if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'preview-refresh', deviceId: state.deviceId }));
  }

  async function invalidatePreviewAfterInput(deviceId, exceptState) {
    for (;;) {
      const replacement = livePreview;
      if (!replacement || replacement === exceptState || replacement.deviceId !== deviceId ||
          replacement.socket?.readyState !== WebSocket.OPEN) return;
      let paused = false;
      try { paused = await pausePreviewForAction(replacement); } catch { /* The replacement is no longer usable. */ }
      if (livePreview !== replacement) continue;
      if (!paused) {
        // A capture may have started before the previous input finished. If the
        // host cannot stop it, discard the session rather than trust its frame.
        replacement.connected = false;
        replacement.socket.terminate();
        return;
      }
      replacement.inputAfterSeq = replacement.seq;
      refreshPreviewAfterAction(replacement);
      return;
    }
  }

  async function previewAction(args, { signal } = {}) {
    if (signal?.aborted) throw cancellationError();
    const state = livePreview;
    if (!state) throw tagError(new Error('No active preview session'), 'PREVIEW_UNAVAILABLE', 'preview_action');
    if (state.paused || !state.connected) throw tagError(new Error('Preview is not connected'), 'PREVIEW_UNAVAILABLE', 'preview_action');
    if (!args.sessionId || args.sessionId !== state.sessionId || !args.deviceId || args.deviceId !== state.deviceId) {
      throw tagError(new Error('Preview session does not match the action'), 'PREVIEW_UNAVAILABLE', 'preview_action');
    }
    const staleFrameError = (reason, phase) => Object.assign(tagError(new Error('Preview frame identity or sequence is stale; request a new frame before acting'),
      'STALE_PREVIEW_FRAME', 'preview_action'), { [previewPreInput]: true, staleReason: reason, stalePhase: phase });
    const rejectStale = (phase) => {
      const reason = state.pendingFrameMeta || state.discardFrame ? 'frame_pair_pending'
        : state.inputAfterSeq !== undefined && args.seq <= state.inputAfterSeq ? 'consumed'
        : state.seq !== args.seq ? 'sequence_changed'
        : args.frameId !== undefined && state.frameMeta?.frameId !== args.frameId ? 'frame_changed' : null;
      if (reason) throw staleFrameError(reason, phase);
    };
    rejectStale('before_pause');
    const startedAt = performance.now();
    const paused = await pausePreviewForAction(state);
    const preparedAt = performance.now();
    let inputStarted = false;
    try {
      if (!paused) {
        if (state.frameProtocolBroken) throw staleFrameError('frame_pair_pending', 'after_pause');
        throw tagError(new Error('Preview did not acknowledge capture pause'), 'PREVIEW_UNAVAILABLE', 'preview_action');
      }
      if (signal?.aborted) throw cancellationError();
      if (livePreview !== state || state.paused || !state.connected) {
        throw tagError(new Error('Preview is not connected'), 'PREVIEW_UNAVAILABLE', 'preview_action');
      }
      if (args.subscriberId) touchSubscription(args.sessionId, args.subscriberId);
      if (state.pendingFrameMeta || state.discardFrame) {
        invalidateFrameProtocol(state);
        throw staleFrameError('frame_pair_pending', 'after_pause');
      }
      rejectStale('after_pause');
      const nextFrameAfterSeq = state.seq;
      const actionMetrics = (result, inputStartedAt) => {
        const finishedAt = performance.now();
        return { ...result, metrics: { ...(result?.metrics ?? {}), action: args.action,
          actionMs: Math.max(0, Math.round(finishedAt - startedAt)),
          actionPrepareMs: Math.max(0, Math.round(preparedAt - startedAt)),
          actionInputMs: Math.max(0, Math.round(finishedAt - inputStartedAt)), frameSeq: args.seq, nextFrameAfterSeq } };
      };
      if (args.action === 'back' || args.action === 'home') {
        const inputStartedAt = performance.now();
        state.inputAfterSeq = state.seq;
        inputStarted = true;
        const result = await deviceAdapter.keyEvent({ deviceId: state.deviceId, key: args.action === 'back' ? 'Back' : 'Home' }, { signal });
        return { content: [], structuredContent: actionMetrics(result, inputStartedAt) };
      }
      if (args.action === 'tap') {
        if (![args.x, args.y].every((value) => Number.isFinite(value))) throw Object.assign(new Error('tap requires x and y'), { rpcCode: -32602 });
        let point;
        try { point = resolveCoordinateAction('tap', { ...args, deviceId: state.deviceId }); }
        catch (error) { error[previewPreInput] = true; throw error; }
        const inputStartedAt = performance.now();
        const meta = state.frameMeta ?? {};
        const portrait = [meta.width, meta.height, meta.deviceWidth, meta.deviceHeight].every((value) => Number.isFinite(value) && value > 0)
          && meta.width < meta.height && meta.deviceWidth < meta.deviceHeight
          && (meta.rotation === undefined || meta.rotation === 0) && meta.orientationChanged !== true;
        const usePreviewTap = Boolean(portrait && deviceAdapter.previewTap);
        state.inputAfterSeq = state.seq;
        inputStarted = true;
        const result = await (usePreviewTap ? deviceAdapter.previewTap : deviceAdapter.tap).call(deviceAdapter,
          { deviceId: state.deviceId, x: point.x, y: point.y }, { signal });
        return { content: [], structuredContent: actionMetrics(usePreviewTap ? result : { ...result, metrics: { ...result?.metrics, inputMethod: 'uitest' } }, inputStartedAt) };
      }
      if (![args.x, args.y, args.toX, args.toY].every((value) => Number.isFinite(value))) throw Object.assign(new Error('swipe requires x, y, toX and toY'), { rpcCode: -32602 });
      let points;
      try { points = resolveCoordinateAction('swipe', { ...args, deviceId: state.deviceId, fromX: args.x, fromY: args.y }); }
      catch (error) { error[previewPreInput] = true; throw error; }
      if (Math.round(points.fromX) === Math.round(points.toX) && Math.round(points.fromY) === Math.round(points.toY)) {
        throw Object.assign(tagError(new Error('swipe endpoints map to the same device pixel'), 'SWIPE_SAME_DEVICE_POINT', 'action_frame'), { [previewPreInput]: true });
      }
      const inputStartedAt = performance.now();
      const meta = state.frameMeta ?? {};
      const portrait = [meta.width, meta.height, meta.deviceWidth, meta.deviceHeight].every((value) => Number.isFinite(value) && value > 0)
        && meta.width < meta.height && meta.deviceWidth < meta.deviceHeight
        && (meta.rotation === undefined || meta.rotation === 0) && meta.orientationChanged !== true;
      const input = portrait && deviceAdapter.previewSwipe ? deviceAdapter.previewSwipe : deviceAdapter.swipe;
      state.inputAfterSeq = state.seq;
      inputStarted = true;
      const result = await input.call(deviceAdapter, { deviceId: state.deviceId,
        fromX: points.fromX, fromY: points.fromY, toX: points.toX, toY: points.toY, velocity: 1200 }, { signal });
      return { content: [], structuredContent: actionMetrics(result, inputStartedAt) };
    } finally {
      try { refreshPreviewAfterAction(state); }
      finally { if (inputStarted) await invalidatePreviewAfterInput(state.deviceId, state); }
    }
  }

  async function stopLivePreview(sessionId, { clearPersisted = true } = {}) {
    const state = livePreview;
    const current = state ?? persistedPreview;
    if (sessionId && current && sessionId !== current.sessionId) throw new Error('Preview sessionId does not match the active session');
    livePreview = undefined;
    if (state) {
      cancelFrameWaiters(state);
      cancelActionWaiters(state);
    }
    if (state?.leaseTimer) clearTimeout(state.leaseTimer);
    if (state?.subscriptionTimer) clearTimeout(state.subscriptionTimer);
    if (state?.socket && state.socket.readyState !== WebSocket.CLOSED) {
      const closed = new Promise((resolve) => state.socket.once('close', resolve));
      state.socket.terminate();
      await closed;
    }
    if (clearPersisted && !ownsPreviewServer) {
      persistedPreview = null;
      await clearPreviewState(previewStatePath);
    }
    return current ? { running: false, deviceId: current.deviceId, sessionId: current.sessionId } : { running: false };
  }

  function previewInfo() {
    const saved = !livePreview && !ownsPreviewServer ? persistedPreview : null;
    const active = livePreview ?? saved;
    const previewUrl = `${serverUrl}${active?.deviceId ? `?deviceId=${encodeURIComponent(active.deviceId)}` : ''}`;
    return { previewUrl, serverUrl, wsUrl, running: Boolean(active), connected: livePreview?.connected ?? false,
      paused: livePreview?.paused ?? false,
      restored: Boolean(saved), sessionId: active?.sessionId ?? null, deviceId: active?.deviceId ?? null, pollMs: livePreview?.pollMs ?? active?.pollMs ?? null,
      frameSource: livePreview?.frameSource ?? active?.frameSource ?? null, previewRecoveryProtocol: 1, previewSubscriptionProtocol: 1,
      capabilities: tools.map((tool) => tool.name), runtime, deviceCheck: { status: 'not_checked' } };
  }

  function touchFrameLease(state, requestedLeaseMs = frameLeaseMs) {
    if (!state || livePreview !== state) return;
    const leaseMs = Math.max(frameLeaseMs, requestedLeaseMs);
    state.lastFrameAccessAt = Date.now();
    if (state.leaseTimer) clearTimeout(state.leaseTimer);
    state.leaseTimer = setTimeout(() => {
      if (livePreview !== state || state.paused) return;
      if (Date.now() - state.lastFrameAccessAt < leaseMs) {
        touchFrameLease(state, leaseMs);
        return;
      }
      state.paused = true;
      state.connected = false;
      if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'preview-pause', deviceId: state.deviceId }));
    }, leaseMs + 25);
  }

  async function savePreviewState(state) {
    if (ownsPreviewServer) return;
    const saved = { sessionId: state.sessionId, deviceId: state.deviceId, serverUrl, wsUrl, pollMs: state.pollMs, lastSeen: Date.now() };
    try { await writePreviewState(previewStatePath, saved); }
    catch (error) { throw tagError(error, 'STATE_WRITE_FAILED', 'state_save'); }
    if (livePreview === state && !state.settled) persistedPreview = saved;
  }

  async function ensurePreviewService() {
    if (ownsPreviewServer || !autoStartPreview || await previewHealthy()) return;
    if (!projectPath) throw new Error('HARMONY_PROJECT is required to restart the preview service');
    const preview = new URL(serverUrl);
    const entry = fileURLToPath(new URL('../bin/harmonyos-preview.mjs', import.meta.url));
    const child = spawn(process.execPath, [entry, '--project', projectPath], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, HARMONY_PROJECT: projectPath, HARMONY_PREVIEW_PORT: preview.port || '4100' }
    });
    child.unref();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await previewHealthy()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Preview service did not start at ${serverUrl}`);
  }

  async function previewHealthy() {
    try { return (await fetch(`${serverUrl}health`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  }
}

function cancellationError() {
  return Object.assign(new Error('Request cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

async function readPreviewState(path, ttlMs) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (Number.isFinite(ttlMs) && ttlMs >= 0 && Number.isFinite(value.lastSeen) && Date.now() - value.lastSeen > ttlMs) {
      await clearPreviewState(path);
      return null;
    }
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function writePreviewState(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  let failure;
  try {
    await writeFile(temporary, JSON.stringify(value) + '\n', 'utf8');
    await rename(temporary, path);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT' && !failure) throw error; }
  }
}

async function clearPreviewState(path) {
  try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw tagError(error, 'STATE_WRITE_FAILED', 'state_clear'); }
}

function normalizePreviewUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('HARMONY_PREVIEW_URL must point to a local HTTP service');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function imageResult(data, mimeType, structuredContent) {
  return { content: [{ type: 'image', mimeType, data: data.toString('base64') }], structuredContent };
}

function frameMetadata(frame, deviceId) {
  return { deviceId, live: false, sessionId: null, frameId: frame.frameId ?? randomUUID(),
    capturedAt: frame.capturedAt ?? new Date().toISOString(),
    ...(frame.width && frame.height ? { width: frame.width, height: frame.height } : {}) };
}

function validateArguments(schema, args) {
  const fail = () => { throw Object.assign(new Error('Invalid tool arguments'), { rpcCode: -32602 }); };
  if (!args || typeof args !== 'object' || Array.isArray(args)) fail();
  if ((schema.required ?? []).some((key) => !Object.hasOwn(args, key))) fail();
  if (Object.keys(args).length < (schema.minProperties ?? 0)) fail();
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (!property) fail();
    if (property.type === 'integer' ? !Number.isInteger(value) : typeof value !== property.type) fail();
    if (property.type === 'object') { validateArguments(property, value); continue; }
    if (property.type === 'string' && (!value.trim() || value.length < (property.minLength ?? 0) || value.length > (property.maxLength ?? Infinity) || property.enum && !property.enum.includes(value))) fail();
    if (property.pattern && !new RegExp(property.pattern).test(value)) fail();
    if (['number', 'integer'].includes(property.type) && (!Number.isFinite(value) || value < property.minimum || value > (property.maximum ?? Infinity))) fail();
  }
}

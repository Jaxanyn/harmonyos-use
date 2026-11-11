const parentWindow = window.parent;
const pending = new Map();
let nextRequestId = 0;

const status = document.querySelector('#status');
const devices = document.querySelector('#devices');
let stage = document.querySelector('#stage');
const frameShell = document.querySelector('#frame-shell');
const overlay = document.querySelector('#stage-overlay');
const overlayText = document.querySelector('#overlay-text');
const gestureMarker = document.querySelector('#gesture-marker');
const metrics = document.querySelector('#metrics');
const actionMetrics = document.querySelector('#action-metrics');
const actionSummary = document.querySelector('#action-summary');
const actionCancellations = document.querySelector('#action-cancellations');
const buttons = [...document.querySelectorAll('button')];
const fitButton = document.querySelector('#fit');
const zoomOutButton = document.querySelector('#zoom-out');
const zoomInButton = document.querySelector('#zoom-in');
const fullscreenButton = document.querySelector('#fullscreen');
const exitFullscreenButton = document.querySelector('#exit-fullscreen');
const fullscreenStatus = document.querySelector('#fullscreen-status');
const startButton = document.querySelector('#start');
const stopButton = document.querySelector('#stop');
const retryFrameButton = document.querySelector('#retry-frame');
const staleNotice = document.querySelector('#stale-notice');
const buildButton = document.querySelector('#build');
const backButton = document.querySelector('#nav-back');
const homeButton = document.querySelector('#nav-home');
const preciseInputs = ['precise-start-x', 'precise-start-y', 'precise-end-x', 'precise-end-y'].map((id) => document.querySelector(`#${id}`));
const preciseBind = document.querySelector('#precise-bind');
const preciseTap = document.querySelector('#precise-tap');
const preciseSwipe = document.querySelector('#precise-swipe');
let preciseBinding;
let deviceId = '';
let sessionId = '';
let subscriberId = '';
let subscriptionProtocol = 0;
let generation = 0;
let previewRunning = false;
let starting = false;
let stopping = false;
let building = false;
let disposed = false;
let frame;
let frameSeq = 0;
// Read available frames more often than the device captures them; this does not request a new capture.
const pollIntervalMs = 125;
const gestureThresholdPx = 12;
let pollTimer;
let gestureStart;
let gestureFrameHold;
let releaseGestureFrame;
let gestureTimeout;
let gesturePending = false;
let captureQueue = Promise.resolve();
let recovery;
let recoveryProtocol = 0;
let zoom = 1;
let markerTimer;
let fullscreenStatusTimer;
let hostDisplayMode;
let hostDisplayModes;
let hostDisplayRevision = 0;
let displayModePending = false;
let hostDisplayUncertain = false;
let frameResizeObserver;
let feedbackUntil = 0;
let importantNotice = '';
let lastActionTimings;
let gestureRejection = '';
let actionStats = { tap: { samples: [], canceled: 0, uncertain: 0 }, swipe: { samples: [], canceled: 0, uncertain: 0 }, unclassified: 0 };
let recentCancellations = [];
const now = () => globalThis.performance?.now?.() ?? Date.now();
const elapsed = (start) => Math.max(0, Math.round(now() - start));

function captureStagesText(stages) {
  if (Number.isFinite(stages?.combinedMs)) return `combined ${stages.combinedMs}ms`;
  if (['snapshotMs', 'transferMs', 'readMs'].some((key) => Number.isFinite(stages?.[key]))) {
    const value = (key) => Number.isFinite(stages[key]) ? `${stages[key]}ms` : 'unavailable';
    return `file transfer (direct or fallback): snapshot ${value('snapshotMs')}, transfer ${value('transferMs')}, read ${value('readMs')}`;
  }
  return 'unavailable';
}

function updateActionSummary() {
  const summary = (label, stats) => {
    const stages = [['total', 'totalMs'], ['queue', 'queueMs'], ['preflight', 'preflightMs'], ['compare', 'compareMs'], ['input', 'inputMs'], ['post-frame', 'postFrameMs']];
    const timings = stages.map(([name, key]) => {
      const sorted = stats.samples.map((sample) => sample[key]).filter(Number.isFinite).sort((a, b) => a - b);
      const percentile = (value) => sorted.length ? `${sorted[Math.ceil(sorted.length * value) - 1]}ms` : 'unavailable';
      return `${name} n=${sorted.length} p50 ${percentile(0.5)} p95 ${percentile(0.95)}`;
    }).join(', ');
    return `${label}: n=${stats.samples.length}, ${timings}, canceled ${stats.canceled}, failed/unknown ${stats.uncertain}`;
  };
  actionSummary.textContent = `Session (last 30 confirmed timings per action; counts since start; compare may overlap): ${summary('tap', actionStats.tap)} · ${summary('swipe', actionStats.swipe)} · unclassified canceled ${actionStats.unclassified}`;
}

function recordAction(label, outcome, message, timings, reason) {
  const stats = actionStats[label?.toLowerCase()];
  if (stats) {
    if (outcome === 'frame' && Number.isFinite(timings?.totalMs)) {
      stats.samples.push(timings);
      if (stats.samples.length > 30) stats.samples.shift();
    } else if (outcome === 'canceled') stats.canceled += 1;
    else if (outcome === 'uncertain') stats.uncertain += 1;
  } else if (!label && outcome === 'canceled') actionStats.unclassified += 1;
  if (outcome === 'canceled') {
    const action = ['tap', 'swipe', 'back', 'home'].includes(label?.toLowerCase()) ? label.toLowerCase() : 'gesture';
    const safeReason = /^[a-z][a-z _-]{0,63}$/i.test(reason ?? '') ? reason : 'unknown';
    const diagnostic = { action, reason: safeReason };
    try {
      const current = JSON.parse(status.dataset.gestureDiagnostic || '{}');
      if (current.reason === safeReason && Array.isArray(current.failedChecks)) {
        diagnostic.failedChecks = current.failedChecks.filter((name) => ['identity', 'frame_geometry', 'display_box', 'device_metadata', 'device_dimensions'].includes(name));
      }
      if (current.reason === 'stale_preview' && safeReason === 'stale_preview') {
        if (['consumed', 'sequence_changed', 'frame_changed', 'frame_pair_pending'].includes(current.staleReason)) diagnostic.staleReason = current.staleReason;
        if (['before_pause', 'after_pause'].includes(current.stalePhase)) diagnostic.stalePhase = current.stalePhase;
      }
      if (current.reason === safeReason && ['image_dimensions', 'canvas_unavailable', 'pixels_changed', 'pixel_count', 'pixel_extent', 'gesture_path_changed', 'pixel_comparison_failed'].includes(safeReason)) {
        const pixels = JSON.parse(status.dataset.gesturePixelDiagnostic || '{}');
        const number = (value) => Number.isFinite(value) ? value : null;
        const intersection = pixels.fullScan?.pathMarginIntersection;
        diagnostic.pixels = { changedPixels: number(pixels.changedPixels), widthRatio: number(pixels.widthRatio),
          heightRatio: number(pixels.heightRatio), fullScanComplete: pixels.fullScan?.complete === true,
          totalChangedPixels: number(pixels.fullScan?.changedPixels), pathMarginIntersection: typeof intersection === 'boolean' ? intersection : null };
        if (pixels.fullScan?.complete === false && ['limit_exceeded', 'data_unavailable', 'scan_error'].includes(pixels.fullScan.stopReason)) {
          diagnostic.pixels.fullScanStopReason = pixels.fullScan.stopReason;
          if (action === 'tap' && ['pixel_extent', 'pixel_count'].includes(safeReason)) {
            diagnostic.pixels.targetMarginChanged = typeof pixels.fullScan.targetMarginChanged === 'boolean' ? pixels.fullScan.targetMarginChanged : null;
          }
        }
        const regions = pixels.regionSummary?.regions;
        if (Array.isArray(regions)) diagnostic.pixels.regionSummary = {
          regions: regions.slice(0, 8).filter((region) => region && [region.pixels, region.width, region.height].every(Number.isFinite))
            .map(({ pixels: count, width, height }) => ({ pixels: count, width, height })),
          truncated: pixels.regionSummary.truncated === true || regions.length > 8
        };
      }
    } catch { /* Diagnostics must not affect input handling. */ }
    status.dataset.lastCancellation = JSON.stringify(diagnostic);
    recentCancellations.push(`${action}: ${safeReason}`);
    if (recentCancellations.length > 10) recentCancellations.shift();
    const counts = new Map();
    for (const item of recentCancellations) counts.set(item, (counts.get(item) ?? 0) + 1);
    actionCancellations.textContent = `Recent cancellations (last 10, oldest first): ${recentCancellations.join(' · ')}. Counts in these entries: ${[...counts].map(([item, count]) => `${item} ×${count}`).join(' · ')}`;
  }
  actionMetrics.textContent = message;
  updateActionSummary();
}

function setStatus(message, error = false, buildStatus = false, neutral = false) {
  if (building && !buildStatus) return;
  status.textContent = message;
  status.title = message;
  status.scrollTop = 0;
  status.className = error ? 'error' : neutral ? 'neutral' : 'status';
  clearTimeout(fullscreenStatusTimer);
  const showInFullscreen = document.fullscreenElement === frameShell && (error || /Previous action|Gesture|Preview changed|Device dimensions|result unknown/i.test(message));
  fullscreenStatus.hidden = !showInFullscreen;
  if (showInFullscreen) {
    fullscreenStatus.textContent = message;
    fullscreenStatusTimer = setTimeout(() => { fullscreenStatus.hidden = true; }, 3000);
  }
}

function overFullscreenControl(x, y) {
  return [exitFullscreenButton, fullscreenStatus].some((control) => {
    if (control.hidden) return false;
    const box = control.getBoundingClientRect();
    return x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;
  });
}

function setOverlay(message, visible = true) {
  overlayText.textContent = message;
  overlay.hidden = !visible;
}

function setMetrics(nextFrame) {
  if (!nextFrame) {
    metrics.textContent = 'No frame yet';
    metrics.title = '';
    return;
  }
  const time = nextFrame.capturedAt ? new Date(nextFrame.capturedAt).toLocaleTimeString() : 'unknown time';
  const capture = Number.isFinite(nextFrame.metrics?.captureMs) ? ` · ${nextFrame.metrics.captureMs}ms` : '';
  const source = nextFrame.metrics?.source ? ` · ${nextFrame.metrics.source}` : '';
  const render = Number.isFinite(nextFrame.metrics?.renderMs) ? ` · render ${nextFrame.metrics.renderMs}ms` : '';
  metrics.textContent = `${nextFrame.width}×${nextFrame.height} · ${time}${capture}${source}${render} · ${Math.round(zoom * 100)}%`;
  const timing = nextFrame.metrics ?? {};
  const frameTiming = `decode ${timing.decodeMs ?? 0}ms · hold ${timing.gestureHoldMs ?? 0}ms · commit ${timing.commitMs ?? 0}ms`;
  const actionTiming = lastActionTimings ? ` · queue ${lastActionTimings.queueMs}ms · preflight ${lastActionTimings.preflightMs}ms · compare ${lastActionTimings.compareMs}ms · input ${lastActionTimings.inputMs ?? 'unavailable'}ms · post-frame ${lastActionTimings.postFrameMs}ms · total ${lastActionTimings.totalMs}ms · method ${lastActionTimings.inputMethod ?? 'unavailable'}` : '';
  metrics.title = frameTiming + actionTiming;
}

function setZoom(nextZoom) {
  zoom = Math.min(1.5, Math.max(0.75, nextZoom));
  frameShell.style.overflow = zoom > 1 ? 'auto' : 'hidden';
  sizeFrame();
  if (frame) setMetrics(frame);
}

function sizeFrame() {
  if (!frame) return;
  const width = frameShell.offsetWidth - 2 * frameShell.clientLeft;
  const height = frameShell.offsetHeight - 2 * frameShell.clientTop;
  if (width <= 0 || height <= 0) return;
  const scale = Math.min(width / frame.width, height / frame.height) * zoom;
  stage.style.width = `${Math.max(1, Math.floor(frame.width * scale))}px`;
  stage.style.height = `${Math.max(1, Math.floor(frame.height * scale))}px`;
}

function hideGestureMarker() {
  clearTimeout(markerTimer);
  markerTimer = undefined;
  gestureMarker.hidden = true;
}

function showGestureMarker(point) {
  if (!frame) return;
  const stageBox = stage.getBoundingClientRect();
  const shellBox = frameShell.getBoundingClientRect();
  if (!stageBox.width || !stageBox.height || !shellBox.width || !shellBox.height) return;
  gestureMarker.style.left = `${stageBox.left - shellBox.left - (frameShell.clientLeft || 0) + (frameShell.scrollLeft || 0) + point.x * stageBox.width / frame.width}px`;
  gestureMarker.style.top = `${stageBox.top - shellBox.top - (frameShell.clientTop || 0) + (frameShell.scrollTop || 0) + point.y * stageBox.height / frame.height}px`;
  gestureMarker.hidden = false;
  clearTimeout(markerTimer);
  markerTimer = setTimeout(() => { gestureMarker.hidden = true; }, 400);
}

function updateControls() {
  buttons.forEach((button) => { button.disabled = building; });
  devices.disabled = building || !deviceId;
  buildButton.disabled = building || !deviceId || starting || stopping || gesturePending || displayModePending || hostDisplayUncertain || Boolean(recovery);
  startButton.disabled = building || !deviceId || !subscriptionProtocol || previewRunning || starting || stopping;
  stopButton.disabled = building || !previewRunning;
  for (const button of [backButton, homeButton]) {
    button.disabled = building || starting || stopping || !previewRunning || gesturePending || displayModePending || hostDisplayUncertain || !sessionId || !frame?.frameId || frameSeq < 1;
  }
  for (const button of [fitButton, zoomOutButton, zoomInButton, fullscreenButton]) {
    button.disabled = building || !frame;
  }
  fullscreenButton.disabled ||= displayModePending || hostDisplayUncertain;
  const preciseReady = !building && !starting && !stopping && !gesturePending && !gestureStart && !displayModePending && !hostDisplayUncertain && !recovery && previewRunning && sessionId && subscriberId && frame?.frameId && frameSeq > 0 && !stage.hidden;
  preciseBind.disabled = !preciseReady;
  preciseTap.disabled = !preciseReady || !preciseBinding?.start;
  preciseSwipe.disabled = !preciseReady || !preciseBinding?.start || !preciseBinding?.end || preciseBinding.samePixel;
}

function updateFullscreenLabel() {
  const label = document.fullscreenElement === frameShell ? 'Exit fullscreen'
    : hostDisplayMode === 'fullscreen' ? 'Collapse preview' : 'Fullscreen';
  fullscreenButton.setAttribute('aria-label', label);
  fullscreenButton.title = label;
}

function applyHostContext(context) {
  if (['inline', 'fullscreen', 'pip'].includes(context?.displayMode)) {
    const wasUncertain = hostDisplayUncertain;
    hostDisplayUncertain = false;
    const changed = hostDisplayMode !== context.displayMode;
    if (changed && gestureStart) {
      cancelGesture();
      showGestureCanceled('Display changed; gesture canceled. Please try again.', 'display mode changed');
    }
    hostDisplayMode = context.displayMode;
    if (changed) hostDisplayRevision += 1;
    if (wasUncertain) {
      updateControls();
      if (!importantNotice) setStatus('Display mode confirmed; preview ready.');
    }
  }
  if (Array.isArray(context?.availableDisplayModes)) {
    hostDisplayModes = context.availableDisplayModes.filter((mode) => ['inline', 'fullscreen', 'pip'].includes(mode));
  }
  fullscreenButton.dataset.hostDisplayMode = hostDisplayMode ?? 'unknown';
  fullscreenButton.dataset.hostDisplayModes = hostDisplayModes?.join(',') ?? 'unknown';
  updateFullscreenLabel();
  if (context?.theme) document.documentElement.style.colorScheme = context.theme;
  const variables = context?.styles?.variables;
  if (variables && typeof variables === 'object') {
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === 'string') document.documentElement.style.setProperty(name, value);
    }
  }
  if (context?.containerDimensions && (Object.hasOwn(context.containerDimensions, 'height') || Object.hasOwn(context.containerDimensions, 'maxHeight'))) {
    const height = context.containerDimensions.height ?? context.containerDimensions.maxHeight;
    if (Number.isFinite(height) && height > 0) document.documentElement.style.setProperty('--preview-host-max-height', `${height}px`);
    else document.documentElement.style.removeProperty('--preview-host-max-height');
  }
  if (context?.safeAreaInsets) {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const inset = context.safeAreaInsets[side];
      if (Number.isFinite(inset) && inset >= 0) document.documentElement.style.setProperty(`--preview-safe-${side}`, `${inset}px`);
    }
  }
}

window.addEventListener('message', (event) => {
  if (event.source !== parentWindow) return;
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'ui/notifications/host-context-changed') {
    applyHostContext(message.params);
    return;
  }
  if (message.method === 'ui/resource-teardown') {
    teardown();
    if (Object.hasOwn(message, 'id')) parentWindow.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
    return;
  }
  if (!Object.hasOwn(message, 'id')) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message || 'Host request failed'));
  else request.resolve(message.result);
});

function request(method, params = {}) {
  if (disposed) return Promise.reject(new Error('Preview panel closed'));
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const timeoutMs = params.name === 'build_run' ? 330000 : method === 'ui/request-display-mode' ? 5000 : 30000;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${params.name || method} timed out`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    parentWindow.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
  });
}

function notify(method, params = {}) {
  parentWindow.postMessage({ jsonrpc: '2.0', method, params }, '*');
}

async function connect() {
  const context = await request('ui/initialize', {
    appCapabilities: {},
    appInfo: { name: 'harmonyos-preview', version: '0.1.0' },
    protocolVersion: '2026-01-26',
  });
  applyHostContext(context?.hostContext);
  notify('ui/notifications/initialized');
}

function parseText(result) {
  const text = result?.content?.find((item) => item.type === 'text')?.text;
  return text ? JSON.parse(text) : result?.structuredContent ?? {};
}

async function callServerTool(name, arguments_ = {}) {
  const result = await request('tools/call', { name, arguments: arguments_ });
  if (result?.isError) {
    const error = new Error(result.content?.[0]?.text ?? `${name} failed`);
    error.errorCode = result.structuredContent?.errorCode;
    error.stage = result.structuredContent?.stage;
    error.inputNotSent = result.structuredContent?.inputNotSent === true;
    if (['consumed', 'sequence_changed', 'frame_changed', 'frame_pair_pending'].includes(result.structuredContent?.staleReason)) error.staleReason = result.structuredContent.staleReason;
    if (['before_pause', 'after_pause'].includes(result.structuredContent?.stalePhase)) error.stalePhase = result.structuredContent.stalePhase;
    throw error;
  }
  return result;
}

async function refreshDevices() {
  const requestedGeneration = generation;
  const result = parseText(await callServerTool('list_devices'));
  if (disposed || requestedGeneration !== generation || building) return;
  const available = Array.isArray(result.devices) ? result.devices : [];
  const previous = deviceId;
  devices.replaceChildren(...(available.length ? available.map((id) => new Option(id, id)) : [new Option('No device connected', '')]));
  const selected = available.includes(previous) ? previous : (available[0] ?? '');
  if (selected !== previous) selectDevice(selected);
  devices.value = deviceId;
  if (!previewRunning) setStatus(!subscriptionProtocol ? 'Preview host is outdated; reconnect Codex to enable safe panel subscriptions.'
    : deviceId ? `Device ready: ${deviceId}` : 'No device connected', !subscriptionProtocol || !deviceId);
  updateControls();
}

function isCurrent(requestedGeneration, requestedDevice) {
  return !disposed && previewRunning && generation === requestedGeneration && deviceId === requestedDevice;
}

function clearFrame(message = 'Waiting for first frame', showOverlay = true) {
  frame = undefined;
  preciseBinding = undefined;
  lastActionTimings = undefined;
  if (gestureStart && previewRunning) recordAction(undefined, 'canceled', 'Last gesture: canceled · preview frame unavailable · input not sent', undefined, 'preview_frame_unavailable');
  cancelGesture();
  hideGestureMarker();
  setZoom(1);
  setMetrics(undefined);
  setOverlay(message, showOverlay);
  stage.hidden = true;
  staleNotice.hidden = true;
  retryFrameButton.hidden = true;
  stage.style.cursor = '';
  stage.removeAttribute('src');
  updateControls();
}

function resetPreview() {
  generation += 1;
  previewRunning = false;
  actionStats = { tap: { samples: [], canceled: 0, uncertain: 0 }, swipe: { samples: [], canceled: 0, uncertain: 0 }, unclassified: 0 };
  recentCancellations = [];
  status.dataset.lastCancellation = '';
  actionCancellations.textContent = 'Recent cancellations: none.';
  actionMetrics.textContent = 'No action measured yet.';
  actionSummary.textContent = 'Session samples: none.';
  feedbackUntil = 0;
  importantNotice = '';
  clearTimeout(pollTimer);
  pollTimer = undefined;
  recovery = undefined;
  recoveryProtocol = 0;
  clearFrame();
  frameSeq = 0;
  const previousSession = { sessionId, subscriberId };
  sessionId = '';
  subscriberId = '';
  return previousSession;
}

async function stopSession(subscription) {
  if (subscription?.sessionId && subscription?.subscriberId) await callServerTool('preview_stop', subscription);
}

function selectDevice(selected) {
  const previousSession = resetPreview();
  deviceId = selected;
  devices.value = selected;
  stopSession(previousSession).catch(() => {});
  setStatus(selected ? `Device ready: ${selected}` : 'No device connected', !selected);
  updateControls();
}

function subscriptionUnavailable() {
  const previousSession = resetPreview();
  stopSession(previousSession).catch(() => {});
  const message = 'Preview subscription expired or changed. Start preview again.';
  setOverlay(message);
  setStatus(message, true);
  updateControls();
}

async function renderImage(result, requestedGeneration, requestedDevice, canCommit = () => !recovery) {
  const structured = result?.structuredContent ?? {};
  const liveFrame = result?.structuredContent?.frame;
  const image = liveFrame ?? result?.content?.find((item) => item.type === 'image');
  if (!image || structured.deviceId !== requestedDevice) throw new Error('Screenshot does not match the selected device');
  if (!isCurrent(requestedGeneration, requestedDevice) || !canCommit()) return false;
  const renderStartedAt = now();
  const nextImage = new Image();
  nextImage.draggable = false;
  nextImage.src = `data:${image.mimeType};base64,${image.data}`;
  await nextImage.decode();
  const decodedAt = now();
  if (gestureFrameHold) await gestureFrameHold;
  const holdEndedAt = now();
  if (!isCurrent(requestedGeneration, requestedDevice) || !canCommit()) return false;
  if (!nextImage.naturalWidth || !nextImage.naturalHeight) throw new Error('Screenshot has no decoded dimensions');
  nextImage.id = 'stage';
  nextImage.alt = stage.alt;
  nextImage.style.width = stage.style.width;
  nextImage.style.height = stage.style.height;
  stage.replaceWith(nextImage);
  stage = nextImage;
  frame = {
    deviceId: requestedDevice,
    width: nextImage.naturalWidth,
    height: nextImage.naturalHeight,
    frameId: image.frameId,
    capturedAt: image.capturedAt,
    metrics: { ...structured.metrics },
  };
  stage.hidden = false;
  sizeFrame();
  setOverlay('', false);
  frame.metrics.decodeMs = Math.max(0, Math.round(decodedAt - renderStartedAt));
  frame.metrics.gestureHoldMs = Math.max(0, Math.round(holdEndedAt - decodedAt));
  frame.metrics.commitMs = elapsed(holdEndedAt);
  frame.metrics.renderMs = elapsed(renderStartedAt);
  setMetrics(frame);
  updateControls();
  return true;
}

function requestFrame(requestedGeneration, requestedDevice, waitMs = 0, manualRecovery = false) {
  const captureTask = captureQueue.then(async () => {
    if (!isCurrent(requestedGeneration, requestedDevice) || recovery) return false;
    try {
      const arguments_ = { sessionId, subscriberId, afterSeq: frameSeq, ...(waitMs > 0 ? { waitMs } : {}) };
      const result = await callServerTool('preview_frame', arguments_);
      if (!isCurrent(requestedGeneration, requestedDevice)) return false;
      const structured = result.structuredContent ?? {};
      if (structured.connected === false) {
        clearFrame('Device disconnected. Waiting for reconnection.');
        setStatus(`Preview disconnected: ${requestedDevice}`, true);
        return false;
      }
      if (!sessionId || structured.sessionId !== sessionId) {
        resetPreview();
        setOverlay('Preview session changed. Start preview again.');
        setStatus('Preview session changed. Start preview again.', true);
        return false;
      }
      if (!structured.frame) {
        if (Number.isInteger(structured.seq) && structured.seq > frameSeq) {
          throw new Error('Preview sequence advanced without a frame');
        }
        return false;
      }
      const rendered = await renderImage(result, requestedGeneration, requestedDevice);
      if (rendered && Number.isInteger(structured.seq)) frameSeq = Math.max(frameSeq, structured.seq);
      if (rendered && !gesturePending && now() >= feedbackUntil) setStatus(importantNotice || `Preview running: ${requestedDevice}`, Boolean(importantNotice));
      return rendered;
    } catch (error) {
      if (isCurrent(requestedGeneration, requestedDevice)) {
        if (error.errorCode === 'PREVIEW_UNAVAILABLE' && error.stage === 'preview_subscription') {
          subscriptionUnavailable();
          return false;
        }
        if (!stage.hidden && stage.src && !/disconnect|offline|session changed/i.test(error.message)) {
          beginRecovery('Preview update failed; refreshing before interaction.', { manual: manualRecovery });
          return false;
        }
        const message = /disconnect|offline/i.test(error.message)
          ? 'Device disconnected. Waiting for reconnection.'
          : 'Preview unavailable. Waiting for a new frame.';
        clearFrame(message);
        setStatus(error.message, true);
      }
      return false;
    }
  });
  captureQueue = captureTask;
  return captureTask;
}

async function requestFreshFrame(requestedGeneration, requestedDevice) {
  return requestFrame(requestedGeneration, requestedDevice, 2500, true);
}

function beginRecovery(message, { manual = false } = {}) {
  if (recovery || !sessionId || !previewRunning) return;
  preciseBinding = undefined;
  const attempt = { generation, deviceId, sessionId, subscriberId, afterSeq: frameSeq };
  recovery = attempt;
  if (gestureStart) {
    lastActionTimings = undefined;
    if (frame) setMetrics(frame);
    recordAction(undefined, 'canceled', 'Last gesture: canceled · preview refreshing · input not sent', undefined, 'preview_refreshing');
  }
  frame = undefined;
  staleNotice.hidden = false;
  retryFrameButton.hidden = true;
  stage.style.cursor = 'not-allowed';
  cancelGesture();
  hideGestureMarker();
  clearTimeout(pollTimer);
  pollTimer = undefined;
  setStatus(message, true);
  updateControls();
  if (recoveryProtocol !== 1) {
    setStatus('Preview host is outdated; reconnect Codex to enable safe recovery.', true);
    return;
  }
  if (manual) {
    attempt.failed = true;
    retryFrameButton.hidden = false;
    return;
  }
  const current = () => recovery === attempt && isCurrent(attempt.generation, attempt.deviceId) && sessionId === attempt.sessionId && subscriberId === attempt.subscriberId;
  const task = captureQueue.then(async () => {
    if (!current()) return;
    try {
      const result = await callServerTool('preview_frame', { forceRefresh: true, afterSeq: attempt.afterSeq, waitMs: 2500,
        deviceId: attempt.deviceId, sessionId: attempt.sessionId, subscriberId: attempt.subscriberId });
      if (!current()) return;
      const value = result.structuredContent ?? {};
      if (value.connected === false) {
        recovery = undefined;
        clearFrame('Device disconnected. Waiting for reconnection.');
        setStatus(`Preview disconnected: ${attempt.deviceId}`, true);
        return;
      }
      if (value.sessionId !== attempt.sessionId) {
        resetPreview();
        setOverlay('Preview session changed. Start preview again.');
        setStatus('Preview session changed. Start preview again.', true);
        return;
      }
      if (value.deviceId !== attempt.deviceId || !Number.isInteger(value.seq) || value.seq <= attempt.afterSeq || !value.frame?.frameId) {
        throw new Error('No confirmed fresh frame');
      }
      if (!await renderImage(result, attempt.generation, attempt.deviceId, current) || !current()) return;
      frameSeq = value.seq;
      recovery = undefined;
      staleNotice.hidden = true;
      retryFrameButton.hidden = true;
      stage.style.cursor = '';
      setStatus(`${importantNotice ? `${importantNotice} ` : ''}Preview refreshed; ready for interaction.`, Boolean(importantNotice));
      updateControls();
      scheduleCapture(attempt.generation, attempt.deviceId);
    } catch (error) {
      if (!current()) return;
      if (error.errorCode === 'PREVIEW_UNAVAILABLE' && error.stage === 'preview_subscription') {
        subscriptionUnavailable();
        return;
      }
      attempt.failed = true;
      retryFrameButton.hidden = false;
      setStatus('Preview refresh failed; retry the frame or stop and start preview.', true);
    }
  });
  captureQueue = task;
}

function scheduleCapture(requestedGeneration, requestedDevice) {
  if (!isCurrent(requestedGeneration, requestedDevice) || !sessionId || gesturePending || recovery) return;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await requestFrame(requestedGeneration, requestedDevice);
    scheduleCapture(requestedGeneration, requestedDevice);
  }, pollIntervalMs);
}

async function startPreview() {
  if (!deviceId) throw new Error('Select a device first');
  if (subscriptionProtocol !== 1) return;
  if (previewRunning || disposed || starting || stopping || building) return;
  importantNotice = '';
  const requestedDevice = deviceId;
  const requestedGeneration = ++generation;
  previewRunning = true;
  starting = true;
  clearFrame('Connecting to the device…');
  setStatus(`Starting preview: ${requestedDevice}`);
  try {
    const info = parseText(await callServerTool('preview_start', { deviceId: requestedDevice, subscriber: true }));
    const subscription = { sessionId: info.sessionId, subscriberId: info.subscriberId };
    if (!isCurrent(requestedGeneration, requestedDevice)) {
      await stopSession(subscription).catch(() => {});
      return;
    }
    if (info.previewSubscriptionProtocol !== 1 || !subscription.sessionId || !subscription.subscriberId) {
      await stopSession(subscription).catch(() => {});
      throw new Error('Preview host is outdated; reconnect Codex to enable safe panel subscriptions.');
    }
    sessionId = subscription.sessionId;
    subscriberId = subscription.subscriberId;
    recoveryProtocol = info.previewRecoveryProtocol === 1 ? 1 : 0;
    if (!recoveryProtocol) importantNotice = 'Preview host is outdated; reconnect Codex to enable safe recovery.';
    await requestFrame(requestedGeneration, requestedDevice);
    scheduleCapture(requestedGeneration, requestedDevice);
  } catch (error) {
    if (isCurrent(requestedGeneration, requestedDevice)) {
      if (error.errorCode === 'PREVIEW_UNAVAILABLE' && error.stage === 'preview_subscription') {
        subscriptionUnavailable();
        return;
      }
      resetPreview();
      setOverlay('Preview failed. Check the device connection.');
      setStatus(error.message, true);
    }
  } finally {
    starting = false;
    if (isCurrent(requestedGeneration, requestedDevice) && frame && status.textContent === `Starting preview: ${requestedDevice}`) {
      setStatus(`Preview running: ${requestedDevice}`);
    }
    updateControls();
  }
}

async function stopPreview(force = false) {
  if (stopping || (building && !force)) return;
  stopping = true;
  const previousSession = resetPreview();
  const stoppedGeneration = generation;
  setOverlay('Preview stopped. Start again to view the device.');
  setStatus('Preview stopped', false, false, true);
  try { await stopSession(previousSession); }
  catch (error) { if (!disposed && generation === stoppedGeneration) setStatus(error.message, true); }
  finally { stopping = false; updateControls(); }
}

async function buildRun() {
  if (!deviceId) throw new Error('Select a device first');
  if (building || starting || stopping || gesturePending || disposed || recovery) return;
  importantNotice = '';
  const requestedDevice = deviceId;
  const requestedGeneration = generation;
  building = true;
  updateControls();
  setStatus(`Building, installing and launching on ${requestedDevice}…`, false, true);
  try {
    await callServerTool('build_run', { deviceId: requestedDevice });
    if (!disposed && generation === requestedGeneration) {
      setStatus(`Build, install and launch completed: ${requestedDevice}`, false, true);
      feedbackUntil = now() + 1500;
    }
  } catch (error) {
    if (!disposed && generation === requestedGeneration) {
      importantNotice = `Build failed: ${error.message}`;
      setStatus(importantNotice, true, true);
    }
  } finally {
    building = false;
    updateControls();
  }
}

function imagePoint(event) {
  if (!frame || frame.deviceId !== deviceId) return;
  const box = stage.getBoundingClientRect();
  if (!box.width || !box.height) return;
  return {
    x: Math.min(frame.width - 1, Math.max(0, Math.round((event.clientX - box.left) * frame.width / box.width))),
    y: Math.min(frame.height - 1, Math.max(0, Math.round((event.clientY - box.top) * frame.height / box.height))),
  };
}

function devicePoint(point, currentFrame) {
  const deviceWidth = currentFrame.metrics?.deviceWidth;
  const deviceHeight = currentFrame.metrics?.deviceHeight;
  if (![deviceWidth, deviceHeight].every((value) => Number.isFinite(value) && value > 0)) return;
  return {
    x: Math.min(deviceWidth - 1, Math.max(0, Math.round(point.x * deviceWidth / currentFrame.width))),
    y: Math.min(deviceHeight - 1, Math.max(0, Math.round(point.y * deviceHeight / currentFrame.height))),
  };
}

function summarizeChangedRegions(changes, width, height) {
  const regions = [];
  while (changes.size && regions.length < 8) {
    const first = changes.values().next().value;
    changes.delete(first);
    const queue = [first];
    let left = width, right = -1, top = height, bottom = -1;
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i] % width, y = Math.floor(queue[i] / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < width && ny >= 0 && ny < height && changes.delete(ny * width + nx)) queue.push(ny * width + nx);
      }
    }
    regions.push({ pixels: queue.length, width: right - left + 1, height: bottom - top + 1 });
  }
  regions.sort((a, b) => b.pixels - a.pixels || b.width - a.width || b.height - a.height);
  return { regions, truncated: changes.size > 0 };
}

// shortcut: pixel comparison cannot detect invisible input overlays; use semantic UI state when available.
function allowsTwoSmallRegions(changes, width, height, from, target) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      ![from?.x, from?.y, target?.x, target?.y].every(Number.isFinite) ||
      [from, target].some((point) => point.x < 0 || point.x >= width || point.y < 0 || point.y >= height)) return false;
  const limit = Math.floor(width * height * 0.0015);
  const margin = Math.min(width, height) * 0.05;
  let regions = 0, totalArea = 0;
  while (changes.size) {
    if (++regions > 2) return false;
    const first = changes.values().next().value;
    changes.delete(first);
    const queue = [first];
    let count = 0, left = width, right = -1, top = height, bottom = -1;
    for (let q = 0; q < queue.length; q++) {
      const pixel = queue[q], x = pixel % width, y = Math.floor(pixel / width);
      count++;
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const neighbor = ny * width + nx;
        if (changes.delete(neighbor)) queue.push(neighbor);
      }
    }
    const w = right - left + 1, h = bottom - top + 1;
    totalArea += w * h;
    if (count < 32 || w < 4 || h < 4 || w > width * 0.05 || h > height * 0.05 ||
        Math.max(w, h) > Math.min(w, h) * 2 || count * 4 < w * h * 3 || totalArea > limit) return false;
    let enter = 0, exit = 1;
    for (const [start, end, min, max] of [[from.x, target.x, left - margin, right + margin],
      [from.y, target.y, top - margin, bottom + margin]]) {
      const delta = end - start;
      if (!delta) {
        if (start < min || start > max) { enter = 1; exit = 0; break; }
      } else {
        const a = (min - start) / delta, b = (max - start) / delta;
        enter = Math.max(enter, Math.min(a, b));
        exit = Math.min(exit, Math.max(a, b));
        if (enter > exit) break;
      }
    }
    if (enter <= exit) return false;
  }
  return regions === 2;
}

function scanTargetMargin(before, after, width, height, target, beforeWords, afterWords) {
  try {
    if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0) ||
        ![target?.x, target?.y].every(Number.isFinite) || target.x < 0 || target.x >= width || target.y < 0 || target.y >= height) return null;
    const margin = Math.min(width, height) * 0.05;
    const left = Math.max(0, Math.ceil(target.x - margin)), right = Math.min(width - 1, Math.floor(target.x + margin));
    const top = Math.max(0, Math.ceil(target.y - margin)), bottom = Math.min(height - 1, Math.floor(target.y + margin));
    if ((right - left + 1) * (bottom - top + 1) > 250000) return null;
    const bytes = width * height * 4;
    const valid = (data) => ArrayBuffer.isView(data) && data.length === bytes && data.byteLength === bytes &&
      ['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(Object.prototype.toString.call(data));
    if (!Number.isSafeInteger(bytes) || !valid(before) || !valid(after)) return null;
    const words = beforeWords && afterWords && beforeWords.length === width * height && afterWords.length === beforeWords.length;
    for (let y = top; y <= bottom; y++) for (let x = left; x <= right; x++) {
      const pixel = y * width + x, i = pixel * 4;
      if (words ? beforeWords[pixel] !== afterWords[pixel] :
        before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2] || before[i + 3] !== after[i + 3]) return true;
    }
    return false;
  } catch { return null; }
}

function compatiblePixels(previous, current, target, from = target, action = '') {
  gestureRejection = '';
  let changed = null, left, top, right = -1, bottom = -1;
  let before, after, beforeWords, afterWords;
  const reject = (reason) => {
    gestureRejection = reason;
    let fullScan = { complete: false, stopReason: 'data_unavailable' }, regionSummary;
    try {
      if (before?.length === width * height * 4 && after?.length === before.length) {
        let total = 0;
        const grid4x4 = Array(16).fill(0);
        let pathMarginIntersection = target && from ? false : null;
        const margin = Math.min(width, height) * 0.05;
        const scanLimit = Math.floor(width * height * 0.0015);
        const candidate = reason === 'pixel_extent' && ['swipe', 'tap'].includes(action) ? new Set() : null;
        let exceeded = false;
        for (let i = 0; i < before.length; i += 4) {
          if (beforeWords ? beforeWords[i / 4] === afterWords[i / 4]
            : before[i] === after[i] && before[i + 1] === after[i + 1] && before[i + 2] === after[i + 2] && before[i + 3] === after[i + 3]) continue;
          if (++total > scanLimit) { exceeded = true; break; }
          const pixel = i / 4, x = pixel % width, y = Math.floor(pixel / width);
          candidate?.add(pixel);
          grid4x4[Math.floor(y * 4 / height) * 4 + Math.floor(x * 4 / width)]++;
          if (pathMarginIntersection !== false) continue;
          let enter = 0, exit = 1;
          for (const [start, end, min, max] of [[from.x, target.x, x - margin, x + margin], [from.y, target.y, y - margin, y + margin]]) {
            const delta = end - start;
            if (!delta) {
              if (start < min || start > max) { enter = 1; exit = 0; break; }
            } else {
              const a = (min - start) / delta, b = (max - start) / delta;
              enter = Math.max(enter, Math.min(a, b));
              exit = Math.min(exit, Math.max(a, b));
              if (enter > exit) break;
            }
          }
          if (enter <= exit) pathMarginIntersection = true;
        }
        if (exceeded) fullScan = { complete: false, stopReason: 'limit_exceeded',
          ...(action === 'tap' && ['pixel_extent', 'pixel_count'].includes(reason)
            ? { targetMarginChanged: scanTargetMargin(before, after, width, height, target, beforeWords, afterWords) } : {}) };
        else {
          fullScan = { complete: true, changedPixels: total, grid4x4, pathMarginIntersection };
          if (action === 'swipe' && candidate && pathMarginIntersection === false && allowsTwoSmallRegions(candidate, width, height, from, target)) {
            status.dataset.gesturePixelDiagnostic = JSON.stringify({ accepted: 'two_small_regions', fullScan });
            gestureRejection = '';
            return true;
          }
          if (action === 'tap' && candidate) regionSummary = summarizeChangedRegions(candidate, width, height);
        }
      }
    } catch { if (!fullScan.complete) fullScan = { complete: false, stopReason: 'scan_error' }; }
    status.dataset.gesturePixelDiagnostic = JSON.stringify({ changedPixels: changed,
      widthRatio: right >= left ? (right - left + 1) / width : null,
      heightRatio: bottom >= top ? (bottom - top + 1) / height : null, fullScan,
      ...(regionSummary ? { regionSummary } : {}) });
    return false;
  };
  if (previous.src === current.src) return true;
  const width = previous.naturalWidth;
  const height = previous.naturalHeight;
  if (!width || !height || width !== current.naturalWidth || height !== current.naturalHeight) return reject('image_dimensions');
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return reject('canvas_unavailable');
    context.drawImage(previous, 0, 0);
    before = context.getImageData(0, 0, width, height).data;
    context.clearRect(0, 0, width, height);
    context.drawImage(current, 0, 0);
    after = context.getImageData(0, 0, width, height).data;
    try {
      if ([before, after].every((data) => ArrayBuffer.isView(data) &&
          ['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(Object.prototype.toString.call(data)) &&
          data.length === width * height * 4 && data.byteLength === data.length && data.byteOffset % 4 === 0)) {
        beforeWords = new Uint32Array(before.buffer, before.byteOffset, before.byteLength / 4);
        afterWords = new Uint32Array(after.buffer, after.byteOffset, after.byteLength / 4);
      }
    } catch { beforeWords = afterWords = undefined; }
    const limit = Math.floor(width * height * 0.0015);
    changed = 0;
    left = width; top = height;
    for (let i = 0; i < before.length; i += 4) {
      if (beforeWords ? beforeWords[i / 4] === afterWords[i / 4]
        : before[i] === after[i] && before[i + 1] === after[i + 1] && before[i + 2] === after[i + 2] && before[i + 3] === after[i + 3]) continue;
      changed++;
      const pixel = i / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      left = Math.min(left, x); right = Math.max(right, x);
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      if (!target) return reject('pixels_changed');
      if (changed > limit) return reject('pixel_count');
      if (right - left + 1 > width * 0.05 || bottom - top + 1 > height * 0.05 ||
          (right - left + 1) * (bottom - top + 1) > limit) return reject('pixel_extent');
    }
    if (!changed) return true;
    const margin = Math.min(width, height) * 0.05;
    let enter = 0, exit = 1;
    for (const [start, end, min, max] of [[from.x, target.x, left - margin, right + margin],
      [from.y, target.y, top - margin, bottom + margin]]) {
      const delta = end - start;
      if (!delta) {
        if (start < min || start > max) return true;
        continue;
      }
      const a = (min - start) / delta, b = (max - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) return true;
    }
    return reject('gesture_path_changed');
  } catch {
    return reject('pixel_comparison_failed');
  }
}

async function sendGesture(event, start) {
  const timing = { startedAt: now(), compareMs: 0 };
  status.dataset.gestureDiagnostic = '';
  status.dataset.gesturePixelDiagnostic = '';
  if (!previewRunning || building || !start || start.generation !== generation || start.deviceId !== deviceId) return;
  if (gesturePending) {
    const action = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY) > gestureThresholdPx ? 'swipe' : 'tap';
    recordAction(action, 'canceled', `Last ${action}: canceled · another action pending · input not sent`, undefined, 'another_action_pending');
    feedbackUntil = now() + 1500;
    setStatus('Previous action is still processing; please wait.');
    return;
  }
  lastActionTimings = undefined;
  if (frame) setMetrics(frame);
  const moved = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
  const action = moved > gestureThresholdPx ? 'swipe' : 'tap';
  if (start.dragged && action === 'tap') {
    recordAction('swipe', 'canceled', 'Last swipe: canceled · drag returned near start · input not sent', undefined, 'drag returned near start');
    feedbackUntil = now() + 1500;
    setStatus('Drag returned near its start; no input was sent.');
    return;
  }
  if (!frame || start.width !== frame.width || start.height !== frame.height) {
    status.dataset.gestureDiagnostic = JSON.stringify({ reason: 'frame_geometry' });
    recordAction(action, 'canceled', `Last ${action}: canceled · frame geometry changed · input not sent`, undefined, 'frame_geometry');
    feedbackUntil = now() + 1500;
    setStatus('Preview changed; please try again.');
    return;
  }
  const sameDisplayBox = () => {
    const box = stage.getBoundingClientRect();
    const same = ['left', 'top', 'width', 'height'].every((key) => box[key] === start.displayBox[key]);
    if (!same) gestureRejection = 'display_geometry';
    return same;
  };
  if (![frame.metrics?.deviceWidth, frame.metrics?.deviceHeight].every((value) => Number.isFinite(value) && value > 0)) {
    recordAction(action, 'canceled', `Last ${action}: canceled · device dimensions unavailable · input not sent`, undefined, 'device_dimensions_unavailable');
    setStatus('Device dimensions unavailable; refresh preview before tapping.', true);
    return;
  }
  const box = stage.getBoundingClientRect();
  const shellBox = frameShell.getBoundingClientRect();
  const shellLeft = shellBox.left + frameShell.clientLeft, shellTop = shellBox.top + frameShell.clientTop;
  if (action === 'tap' && (event.clientX < box.left || event.clientX >= box.left + box.width ||
      event.clientY < box.top || event.clientY >= box.top + box.height ||
      event.clientX < shellLeft || event.clientX >= shellLeft + frameShell.clientWidth ||
      event.clientY < shellTop || event.clientY >= shellTop + frameShell.clientHeight)) {
    recordAction(action, 'canceled', 'Last tap: canceled · pointer outside image · input not sent', undefined, 'pointer_outside_image');
    feedbackUntil = now() + 1500;
    setStatus('Gesture ended outside the image; please try again.');
    return;
  }
  const end = imagePoint(event);
  if (overFullscreenControl(event.clientX, event.clientY)) {
    recordAction(action, 'canceled', `Last ${action}: canceled · fullscreen control · input not sent`, undefined, 'fullscreen_control');
    feedbackUntil = now() + 1500;
    setStatus('Gesture canceled over fullscreen control; please try again.');
    return;
  }
  if (!end) {
    recordAction(action, 'canceled', `Last ${action}: canceled · pointer outside image · input not sent`, undefined, 'pointer_outside_image');
    feedbackUntil = now() + 1500;
    setStatus('Gesture ended outside the image; please try again.');
    return;
  }
  const sameFrame = () => {
    const startedAt = now();
    try {
      const geometryMatches = frame && start.width === frame.width && start.height === frame.height &&
        ['deviceWidth', 'deviceHeight', 'rotation', 'orientationChanged'].every((key) => frame.metrics?.[key] === start.metrics?.[key]);
      if (!geometryMatches) { gestureRejection = 'frame_geometry'; return false; }
      return compatiblePixels(start.image, stage, end, action === 'swipe' ? start : end, action);
    } finally { timing.compareMs += elapsed(startedAt); }
  };
  if (!sameDisplayBox() || !sameFrame()) {
    status.dataset.gestureDiagnostic = JSON.stringify({ reason: gestureRejection });
    recordAction(action, 'canceled', `Last ${action}: canceled · ${gestureRejection || 'preview changed'} · input not sent`, undefined, gestureRejection || 'preview_changed');
    feedbackUntil = now() + 1500;
    setStatus('Preview changed; please try again.');
    return;
  }
  if (action === 'tap') showGestureMarker(end);
  return performAction(action === 'tap' ? 'Tap' : 'Swipe', () => {
    if (!sameFrame() || !sameDisplayBox()) return;
    const frameCoordinates = frame.metrics?.rotation !== undefined || frame.metrics?.orientationChanged === true;
    const startPoint = frameCoordinates ? start : devicePoint(start, frame);
    const endPoint = frameCoordinates ? end : devicePoint(end, frame);
    const frameBinding = frame.frameId ? { frameId: frame.frameId } : {};
    const coordinateBinding = frameCoordinates ? { coordinateSpace: 'frame' } : {};
    return action === 'tap'
      ? { action, deviceId, sessionId, subscriberId, seq: frameSeq, ...frameBinding, ...coordinateBinding, x: endPoint.x, y: endPoint.y }
      : { action, deviceId, sessionId, subscriberId, seq: frameSeq, ...frameBinding, ...coordinateBinding, x: startPoint.x, y: startPoint.y, toX: endPoint.x, toY: endPoint.y };
  }, false, timing);
}

async function performAction(label, getArguments, requireBarrier = false, timing = { startedAt: now(), compareMs: 0 }) {
  if (!previewRunning || gesturePending || displayModePending || hostDisplayUncertain || building || !frame) return;
  const requestedGeneration = generation;
  const requestedDevice = deviceId;
  lastActionTimings = undefined;
  setMetrics(frame);
  actionMetrics.textContent = `Last ${label.toLowerCase()}: in progress`;
  importantNotice = '';
  setStatus(`Sending ${label.toLowerCase()}…`);
  gesturePending = true;
  feedbackUntil = 0;
  const actionStartedAt = timing.startedAt;
  updateControls();
  clearTimeout(pollTimer);
  try {
    let startedAt = now();
    await captureQueue;
    timing.queueMs = elapsed(startedAt);
    if (!isCurrent(requestedGeneration, requestedDevice)) return;
    startedAt = now();
    await requestFrame(requestedGeneration, requestedDevice);
    timing.preflightMs = elapsed(startedAt);
    if (!isCurrent(requestedGeneration, requestedDevice)) return;
    if (!frame) {
      recordAction(label, 'canceled', `Last ${label.toLowerCase()}: canceled · preflight frame unavailable · input not sent`, undefined, 'preflight_frame_unavailable');
      return;
    }
    const arguments_ = getArguments();
    if (!arguments_) {
      hideGestureMarker();
      status.dataset.gestureDiagnostic ||= JSON.stringify({ reason: gestureRejection || 'preflight_changed' });
      recordAction(label, 'canceled', `Last ${label.toLowerCase()}: canceled · ${gestureRejection || 'preflight_changed'} · input not sent`, undefined, gestureRejection || 'preflight_changed');
      feedbackUntil = now() + 1500;
      setStatus('Preview changed; please try again.');
      return;
    }
    frame = undefined;
    updateControls();
    const actionResult = await callServerTool('preview_action', arguments_);
    const actionMs = actionResult?.structuredContent?.metrics?.actionMs;
    const nextFrameAfterSeq = actionResult?.structuredContent?.metrics?.nextFrameAfterSeq;
    if (!isCurrent(requestedGeneration, requestedDevice)) return;
    if (requireBarrier && (!Number.isInteger(nextFrameAfterSeq) || nextFrameAfterSeq < arguments_.seq)) {
      importantNotice = 'Action sent; new frame cannot be confirmed. Result unknown.';
      beginRecovery(importantNotice, { manual: true });
      setStatus(importantNotice, true);
      recordAction(label, 'uncertain', `Last ${label.toLowerCase()}: sent · new frame unconfirmed · business result unknown`);
      return;
    }
    if (Number.isInteger(nextFrameAfterSeq)) frameSeq = Math.max(frameSeq, nextFrameAfterSeq);
    setStatus(`${label} sent${Number.isFinite(actionMs) ? ` in ${actionMs}ms` : ''}; waiting for a new frame…`);
    startedAt = now();
    const rendered = await requestFreshFrame(requestedGeneration, requestedDevice);
    if (isCurrent(requestedGeneration, requestedDevice)) {
      if (rendered) {
        lastActionTimings = { queueMs: timing.queueMs, preflightMs: timing.preflightMs, compareMs: timing.compareMs,
          inputMs: actionResult?.structuredContent?.metrics?.actionInputMs, inputMethod: actionResult?.structuredContent?.metrics?.inputMethod,
          postFrameMs: elapsed(startedAt), totalMs: elapsed(actionStartedAt) };
        setMetrics(frame);
        const display = (value) => Number.isFinite(value) ? `${value}ms` : 'unavailable';
        const confirmed = Number.isInteger(nextFrameAfterSeq) && nextFrameAfterSeq >= arguments_.seq && frameSeq > nextFrameAfterSeq;
        recordAction(label, confirmed ? 'frame' : 'uncertain', `Last ${label.toLowerCase()}: ${confirmed ? 'new frame decoded; business result unconfirmed' : 'frame decoded; action-to-frame order unconfirmed'} · queue ${display(lastActionTimings.queueMs)} · preflight ${display(lastActionTimings.preflightMs)} · compare ${display(lastActionTimings.compareMs)} (may overlap) · input ${display(lastActionTimings.inputMs)} (${lastActionTimings.inputMethod ?? 'unavailable'}) · post-frame ${display(lastActionTimings.postFrameMs)} · decoded frame capture ${captureStagesText(frame?.metrics?.captureStages)} · ${timing.origin ?? (['Tap', 'Swipe'].includes(label) ? 'pointer release' : 'request')} to frame commit ${display(lastActionTimings.totalMs)}`, lastActionTimings);
        setStatus(confirmed ? `${label} sent; new frame decoded; total ${elapsed(actionStartedAt)}ms` : `${label} sent; frame order unconfirmed; result unknown.`);
      }
      else {
        importantNotice = recovery ? 'Action sent; result unknown.' : status.className === 'error'
          ? `Action sent; new frame unavailable: ${status.textContent}` : 'Action sent; no new frame yet. Result unknown.';
        if (!recovery && !stage.hidden && stage.src) beginRecovery(importantNotice, { manual: true });
        setStatus(importantNotice, true);
        recordAction(label, 'uncertain', `Last ${label.toLowerCase()}: sent · new frame unavailable · business result unknown`);
      }
      feedbackUntil = now() + 1500;
    }
  } catch (error) {
    if (isCurrent(requestedGeneration, requestedDevice)) {
      if (error.errorCode === 'PREVIEW_UNAVAILABLE' && error.stage === 'preview_subscription') {
        subscriptionUnavailable();
        return;
      }
      const stalePreflight = error.inputNotSent && error.errorCode === 'STALE_PREVIEW_FRAME' && ['preview_action', 'action_frame'].includes(error.stage);
      const boundsPreflight = error.inputNotSent && ['FRAME_COORDINATE_OUT_OF_BOUNDS', 'DEVICE_COORDINATE_OUT_OF_BOUNDS'].includes(error.errorCode) && error.stage === 'action_frame';
      const samePointPreflight = error.inputNotSent && error.errorCode === 'SWIPE_SAME_DEVICE_POINT' && error.stage === 'action_frame';
      const rejectedBeforeInput = stalePreflight || boundsPreflight || samePointPreflight;
      if (rejectedBeforeInput) {
        hideGestureMarker();
        importantNotice = boundsPreflight
          ? 'Coordinates outside preview; action was not sent. Please try again after refresh.'
          : samePointPreflight ? 'Swipe is too short on the device; action was not sent. Please try again after refresh.'
          : 'Preview changed; action was not sent. Please try again after refresh.';
        beginRecovery(importantNotice);
      } else {
        importantNotice = `Action result unknown: ${error.message}`;
        if (!stage.hidden && stage.src) beginRecovery(importantNotice, { manual: true });
        else clearFrame('Action result unknown. Check the device before trying again.');
      }
      if (!rejectedBeforeInput || recoveryProtocol === 1) setStatus(importantNotice, true);
      if (stalePreflight) status.dataset.gestureDiagnostic = JSON.stringify({ reason: 'stale_preview',
        ...(error.staleReason ? { staleReason: error.staleReason } : {}), ...(error.stalePhase ? { stalePhase: error.stalePhase } : {}) });
      recordAction(label, rejectedBeforeInput ? 'canceled' : 'uncertain', rejectedBeforeInput
        ? `Last ${label.toLowerCase()}: canceled · ${boundsPreflight ? 'coordinates outside preview' : samePointPreflight ? 'swipe too short' : 'stale preview'} · input not sent`
        : `Last ${label.toLowerCase()}: failed or result unknown · check device before retrying`, undefined,
        boundsPreflight || samePointPreflight ? error.errorCode.toLowerCase() : stalePreflight ? 'stale_preview' : undefined);
    }
  } finally {
    gesturePending = false;
    updateControls();
    scheduleCapture(generation, deviceId);
  }
}

function sendNavigation(action) {
  if (starting || stopping || !sessionId || !frame?.frameId || frameSeq < 1) return Promise.resolve();
  gestureRejection = '';
  status.dataset.gestureDiagnostic = '';
  status.dataset.gesturePixelDiagnostic = '';
  status.dataset.gestureMotionDiagnostic = '';
  const visible = frame;
  const image = stage;
  const timing = { startedAt: now(), compareMs: 0 };
  return performAction(action === 'back' ? 'Back' : 'Home', () => {
    const startedAt = now();
    try {
      return frame?.frameId && sessionId && compatiblePixels(image, stage, null) &&
        frame.width === visible.width && frame.height === visible.height &&
        ['deviceWidth', 'deviceHeight', 'rotation', 'orientationChanged'].every((key) => frame.metrics?.[key] === visible.metrics?.[key]) && ({
        action, deviceId, sessionId, subscriberId, seq: frameSeq, frameId: frame.frameId
      });
    } finally { timing.compareMs += elapsed(startedAt); }
  }, true, timing);
}

function bindPreciseFrame() {
  if (preciseBind.disabled) return;
  const values = preciseInputs.map((input) => input.value.trim() === '' ? NaN : Number(input.value));
  const point = (x, y) => [x, y].every((n) => Number.isFinite(n) && n >= 0 && n < 100)
    ? { x: Math.floor(frame.width * x / 100), y: Math.floor(frame.height * y / 100) } : undefined;
  const box = stage.getBoundingClientRect();
  if (!box.width || !box.height) { setStatus('Preview is not visible; show it before binding.', true); return; }
  const start = point(values[0], values[1]), end = point(values[2], values[3]);
  const frameCoordinates = frame.metrics?.rotation !== undefined || frame.metrics?.orientationChanged === true;
  const dimensionsKnown = [frame.metrics?.deviceWidth, frame.metrics?.deviceHeight].every((value) => Number.isFinite(value) && value > 0);
  const mappedStart = start && (frameCoordinates ? start : dimensionsKnown && devicePoint(start, frame));
  const mappedEnd = end && (frameCoordinates ? end : dimensionsKnown && devicePoint(end, frame));
  const samePixel = Boolean(mappedStart && mappedEnd && mappedStart.x === mappedEnd.x && mappedStart.y === mappedEnd.y);
  preciseBinding = { start, end, samePixel, visible: frame, image: stage,
    generation, deviceId, sessionId, subscriberId, displayBox: { left: box.left, top: box.top, width: box.width, height: box.height } };
  updateControls();
  if (!preciseBinding.start) setStatus('Enter start coordinates from 0 up to, but not including, 100%.', true);
  else if (samePixel) setStatus('Swipe start and end map to the same pixel; input was not sent.', true);
}

function sendPrecise(action) {
  const bound = preciseBinding;
  if (!bound || gestureStart || recovery || starting || stopping || (action === 'tap' ? preciseTap.disabled : preciseSwipe.disabled)) return;
  preciseBinding = undefined;
  gestureRejection = '';
  status.dataset.gestureDiagnostic = '';
  status.dataset.gesturePixelDiagnostic = '';
  status.dataset.gestureMotionDiagnostic = '';
  const timing = { startedAt: now(), compareMs: 0, origin: 'request' };
  return performAction(action === 'tap' ? 'Tap' : 'Swipe', () => {
    const startedAt = now();
    try {
      const box = stage.getBoundingClientRect();
      const checks = [
        ['identity', bound.generation === generation && bound.deviceId === deviceId && bound.sessionId === sessionId && bound.subscriberId === subscriberId],
        ['frame_geometry', Boolean(frame?.frameId && frame.width === bound.visible.width && frame.height === bound.visible.height)],
        ['display_box', ['left', 'top', 'width', 'height'].every((key) => box[key] === bound.displayBox[key])],
        ['device_metadata', ['deviceWidth', 'deviceHeight', 'rotation', 'orientationChanged'].every((key) => frame?.metrics?.[key] === bound.visible.metrics?.[key])],
        ['device_dimensions', [frame?.metrics?.deviceWidth, frame?.metrics?.deviceHeight].every((value) => Number.isFinite(value) && value > 0)],
      ];
      const failedChecks = checks.filter(([, ok]) => !ok).map(([name]) => name);
      if (failedChecks.length) {
        gestureRejection = 'frame_or_display_geometry';
        status.dataset.gestureDiagnostic = JSON.stringify({ reason: gestureRejection, failedChecks });
        return;
      }
      if (!compatiblePixels(bound.image, stage, action === 'tap' ? bound.start : bound.end, bound.start, action)) return;
      const frameCoordinates = frame.metrics?.rotation !== undefined || frame.metrics?.orientationChanged === true;
      const start = frameCoordinates ? bound.start : devicePoint(bound.start, frame);
      const end = action === 'swipe' ? (frameCoordinates ? bound.end : devicePoint(bound.end, frame)) : undefined;
      if (action === 'swipe' && start.x === end.x && start.y === end.y) { gestureRejection = 'swipe_same_pixel'; return; }
      const base = { action, deviceId, sessionId, subscriberId, seq: frameSeq, frameId: frame.frameId,
        ...(frameCoordinates ? { coordinateSpace: 'frame' } : {}) };
      return action === 'tap' ? { ...base, x: start.x, y: start.y }
        : { ...base, x: start.x, y: start.y, toX: end.x, toY: end.y };
    } finally { timing.compareMs += elapsed(startedAt); }
  }, true, timing);
}

function teardown() {
  if (disposed) return;
  stopPreview(true).catch(() => {});
  disposed = true;
  frameResizeObserver?.disconnect();
  for (const { reject, timer } of pending.values()) {
    clearTimeout(timer);
    reject(new Error('Preview panel closed'));
  }
  pending.clear();
}

devices.addEventListener('change', () => { if (building) devices.value = deviceId; else selectDevice(devices.value); });
document.querySelector('#refresh').addEventListener('click', () => { importantNotice = ''; refreshDevices().catch((error) => setStatus(error.message, true)); });
document.querySelector('#build').addEventListener('click', () => buildRun().catch((error) => setStatus(error.message, true)));
document.querySelector('#start').addEventListener('click', () => startPreview().catch((error) => setStatus(error.message, true)));
document.querySelector('#stop').addEventListener('click', () => stopPreview().catch((error) => setStatus(error.message, true)));
retryFrameButton.addEventListener('click', () => {
  if (!recovery?.failed || !isCurrent(recovery.generation, recovery.deviceId) || sessionId !== recovery.sessionId || subscriberId !== recovery.subscriberId) return;
  recovery = undefined;
  beginRecovery('Refreshing preview; interaction unavailable.');
});
backButton.addEventListener('click', () => sendNavigation('back').catch((error) => setStatus(error.message, true)));
homeButton.addEventListener('click', () => sendNavigation('home').catch((error) => setStatus(error.message, true)));
for (const input of preciseInputs) input.addEventListener('input', () => { preciseBinding = undefined; updateControls(); });
preciseBind.addEventListener('click', bindPreciseFrame);
preciseTap.addEventListener('click', () => sendPrecise('tap')?.catch((error) => setStatus(error.message, true)));
preciseSwipe.addEventListener('click', () => sendPrecise('swipe')?.catch((error) => setStatus(error.message, true)));
fitButton.addEventListener('click', () => setZoom(1));
zoomOutButton.addEventListener('click', () => setZoom(zoom - 0.25));
zoomInButton.addEventListener('click', () => setZoom(zoom + 0.25));
async function toggleFullscreen() {
  if (displayModePending || hostDisplayUncertain) return;
  if (gesturePending) {
    feedbackUntil = now() + 1500;
    setStatus('Previous action is still processing; please wait.');
    return;
  }
  if (gestureStart) {
    cancelGesture();
    showGestureCanceled('Display changed; gesture canceled. Please try again.', 'display mode changed');
  }
  const exitingBrowser = document.fullscreenElement === frameShell;
  const exitingHost = !exitingBrowser && hostDisplayMode === 'fullscreen';
  try {
    if (document.fullscreenElement === frameShell) {
      if (typeof document.exitFullscreen !== 'function') throw new Error('unavailable');
      await document.exitFullscreen();
    } else if (hostDisplayModes?.includes(hostDisplayMode === 'fullscreen' ? 'inline' : 'fullscreen')) {
      const mode = hostDisplayMode === 'fullscreen' ? 'inline' : 'fullscreen';
      const revision = hostDisplayRevision;
      displayModePending = true;
      updateControls();
      const result = await request('ui/request-display-mode', { mode });
      if (!['inline', 'fullscreen', 'pip'].includes(result?.mode)) throw new Error('invalid display mode');
      if (hostDisplayRevision !== revision && result.mode !== hostDisplayMode) {
        hostDisplayUncertain = true;
        throw new Error('conflicting display modes');
      }
      if (hostDisplayRevision === revision) applyHostContext({ displayMode: result.mode });
      if (hostDisplayMode !== mode) throw new Error('mode not applied');
    } else if (hostDisplayMode === 'fullscreen') {
      throw new Error('host cannot exit fullscreen');
    } else {
      if (document.fullscreenElement || typeof frameShell.requestFullscreen !== 'function') throw new Error('unavailable');
      await frameShell.requestFullscreen();
    }
  } catch {
    feedbackUntil = now() + 3000;
    setStatus(hostDisplayUncertain ? 'Display mode unconfirmed; wait for host update or reopen preview.' : exitingHost ? 'Unable to collapse preview in the host.' : exitingBrowser ? 'Unable to exit fullscreen.' : 'Fullscreen is unavailable; please use the regular preview.', true);
    if (document.fullscreenElement === frameShell) exitFullscreenButton.textContent = 'Exit failed; press Esc';
  } finally {
    displayModePending = false;
    updateControls();
  }
}
fullscreenButton.addEventListener('click', toggleFullscreen);
exitFullscreenButton.addEventListener('click', (event) => {
  event.stopPropagation();
  if (document.fullscreenElement === frameShell) toggleFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  exitFullscreenButton.hidden = document.fullscreenElement !== frameShell;
  exitFullscreenButton.textContent = 'Exit fullscreen';
  updateFullscreenLabel();
  clearTimeout(fullscreenStatusTimer);
  fullscreenStatus.hidden = true;
});
function releaseGesture() {
  clearTimeout(gestureTimeout);
  gestureTimeout = undefined;
  const release = releaseGestureFrame;
  releaseGestureFrame = undefined;
  gestureFrameHold = undefined;
  release?.();
}

function cancelGesture() {
  status.dataset.gestureDiagnostic = '';
  gestureRejection = '';
  gestureStart = undefined;
  releaseGesture();
}

function showGestureCanceled(message = 'Gesture canceled; please try again.', reason = 'pointer canceled') {
  feedbackUntil = now() + 1500;
  lastActionTimings = undefined;
  if (frame) setMetrics(frame);
  recordAction(undefined, 'canceled', `Last gesture: canceled · ${reason} · input not sent`, undefined, reason);
  setStatus(message);
}

function trustedScreenPoint(event) {
  return event.isTrusted === true && Number.isFinite(event.screenX) && Number.isFinite(event.screenY) &&
    (event.screenX !== 0 || event.screenY !== 0) ? { x: event.screenX, y: event.screenY } : undefined;
}

frameShell.addEventListener('pointerdown', (event) => {
  if (event.target !== stage || !event.isPrimary || event.button !== 0 ||
      !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) ||
      !previewRunning || gestureStart || building) return;
  if (displayModePending || hostDisplayUncertain) {
    feedbackUntil = now() + 1500;
    setStatus(hostDisplayUncertain ? 'Display mode unconfirmed; wait for host update or reopen preview.' : 'Display change is still processing; please wait.');
    return;
  }
  if (gesturePending) {
    feedbackUntil = now() + 1500;
    setStatus('Previous action is still processing; please wait.');
    return;
  }
  if (overFullscreenControl(event.clientX, event.clientY)) return;
  const point = imagePoint(event);
  if (!point) return;
  status.dataset.gestureDiagnostic = '';
  status.dataset.gesturePixelDiagnostic = '';
  status.dataset.gestureMotionDiagnostic = '';
  gestureRejection = '';
  const { left, top, width, height } = stage.getBoundingClientRect();
  gestureStart = { ...point, generation, deviceId, width: frame.width, height: frame.height,
    pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
    screen: trustedScreenPoint(event), image: stage, metrics: frame.metrics, displayBox: { left, top, width, height } };
  gestureFrameHold = new Promise((resolve) => { releaseGestureFrame = resolve; });
  gestureTimeout = setTimeout(() => {
    cancelGesture();
    showGestureCanceled('Gesture timed out; please try again.', 'pointer timed out');
  }, 10000);
  try {
    if (frameShell.setPointerCapture) {
      frameShell.setPointerCapture(event.pointerId);
      gestureStart.captured = true;
    }
  } catch {
    // Without capture, only a release on the original image is actionable.
  }
});
frameShell.addEventListener('pointermove', (event) => {
  if (gestureStart?.pointerId !== event.pointerId) return;
  if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) gestureStart.moveObserved = true;
  if (gestureStart.screen && !gestureStart.screenMoved && event.isTrusted === true) {
    const movedOnScreen = (sample) => {
      const screen = sample.pointerId === gestureStart.pointerId && trustedScreenPoint(sample);
      return screen && Math.hypot(screen.x - gestureStart.screen.x, screen.y - gestureStart.screen.y) > gestureThresholdPx;
    };
    if (movedOnScreen(event)) gestureStart.screenMoved = true;
    else {
      try { gestureStart.screenMoved = event.getCoalescedEvents?.().some(movedOnScreen) ?? false; }
      catch { /* Use the pointer event when coalesced samples are unavailable. */ }
    }
  }
  if (gestureStart.dragged) return;
  const dragged = (sample) => sample.pointerId === gestureStart.pointerId && Number.isFinite(sample.clientX) && Number.isFinite(sample.clientY) &&
    Math.hypot(sample.clientX - gestureStart.clientX, sample.clientY - gestureStart.clientY) > gestureThresholdPx;
  if (dragged(event)) gestureStart.dragged = true;
  else {
    try { gestureStart.dragged = event.getCoalescedEvents?.().some(dragged) ?? false; }
    catch { /* Use the pointer event when coalesced samples are unavailable. */ }
  }
});
frameShell.addEventListener('pointerup', (event) => {
  if (!gestureStart || gestureStart.pointerId !== event.pointerId) return;
  const start = gestureStart;
  if (!event.isPrimary || event.button !== 0 || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) {
    cancelGesture();
    showGestureCanceled(undefined, 'invalid pointer release');
    return;
  }
  if (!start.captured) {
    const box = stage.getBoundingClientRect();
    if (event.target !== stage || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY) ||
        event.clientX < box.left || event.clientX >= box.left + box.width ||
        event.clientY < box.top || event.clientY >= box.top + box.height) {
      cancelGesture();
      showGestureCanceled(undefined, 'pointer released outside image');
      return;
    }
  }
  const endDistance = Math.hypot(event.clientX - start.clientX, event.clientY - start.clientY);
  status.dataset.gestureMotionDiagnostic = JSON.stringify({ moveObserved: start.moveObserved === true,
    thresholdExceeded: start.dragged === true, endWithinThreshold: endDistance <= gestureThresholdPx,
    endDistancePx: Math.round(endDistance) });
  const screen = start.screenMoved && trustedScreenPoint(event);
  if (screen && endDistance > gestureThresholdPx && Math.hypot(screen.x - start.screen.x, screen.y - start.screen.y) <= 3) {
    cancelGesture();
    showGestureCanceled('Preview position changed during the gesture; no input was sent.', 'screen return with preview change');
    return;
  }
  gestureStart = undefined;
  releaseGesture();
  sendGesture(event, start).catch((error) => setStatus(error.message, true));
});
for (const name of ['pointercancel', 'lostpointercapture']) {
  frameShell.addEventListener(name, (event) => {
    if (gestureStart?.pointerId !== event.pointerId) return;
    cancelGesture();
    showGestureCanceled(undefined, name);
  });
}
frameShell.addEventListener('pointerleave', (event) => {
  if (gestureStart?.pointerId === event.pointerId && !gestureStart.captured) {
    cancelGesture();
    showGestureCanceled(undefined, 'pointer left image');
  }
});
window.addEventListener('blur', () => {
  if (!gestureStart) return;
  cancelGesture();
  showGestureCanceled(undefined, 'window lost focus');
});
window.addEventListener('pagehide', teardown);
if (typeof ResizeObserver === 'function') {
  frameResizeObserver = new ResizeObserver(sizeFrame);
  frameResizeObserver.observe(frameShell);
} else {
  window.addEventListener('resize', sizeFrame);
}

async function initialize() {
  try {
    await connect();
    setStatus('HarmonyOS Preview connected');
    const info = parseText(await callServerTool('preview_info'));
    subscriptionProtocol = info.previewSubscriptionProtocol === 1 ? 1 : 0;
    await refreshDevices();
  } catch (error) {
    setStatus(`Cannot connect to Codex: ${error.message}`, true);
  }
}

updateControls();
initialize();

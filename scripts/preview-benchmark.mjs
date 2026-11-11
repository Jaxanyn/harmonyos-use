import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcp } from '../src/mcp.mjs';

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node scripts/preview-benchmark.mjs --device <id> [--action tap|swipe] [--actions 3] [--warmup 1] [--x 1] [--y 1] [--to-x n --to-y n] [--max-action-p95 ms] [--max-capture-p95 ms]');
    return;
  }
  if (!options.device) throw new Error('--device is required');

  const input = new PassThrough();
  const output = new PassThrough();
  const responses = createInterface({ input: output })[Symbol.asyncIterator]();
  let requestId = 0;

  async function request(method, params) {
    const id = ++requestId;
    input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    while (true) {
      const next = await responses.next();
      if (next.done) throw new Error('MCP output closed');
      const response = JSON.parse(next.value);
      if (response.id === id) return response;
    }
  }

  const running = startMcp({ input, output, port: 0, projectPath: '' });
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'harmonyos-preview-benchmark', version: '1' } });
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const started = await request('tools/call', { name: 'preview_start', arguments: { deviceId: options.device } });
    if (started.result?.isError) throw new Error(started.result.content?.[0]?.text ?? 'preview_start failed');
    let frame = (await request('tools/call', { name: 'preview_frame', arguments: { afterSeq: 0 } })).result.structuredContent;
    const warmup = [];
    for (let index = 0; index < options.warmup; index += 1) {
      const startedAt = performance.now();
      const action = await runAction(frame);
      const next = action.next;
      warmup.push(sample(startedAt, action.result, next, index + 1));
      frame = next;
    }
    const samples = [];
    for (let index = 0; index < options.actions; index += 1) {
      const startedAt = performance.now();
      const action = await runAction(frame);
      samples.push(sample(startedAt, action.result, action.next, index + 1));
      frame = action.next;
    }
    const report = createBenchmarkReport(options, warmup, samples);
    console.log(JSON.stringify(report, null, 2));
    enforceThreshold(report.summary.actionRoundTripMs, options.maxActionP95, 'actionRoundTripMs p95');
    enforceThreshold(report.summary.captureMs, options.maxCaptureP95, 'captureMs p95');
  } finally {
    input.end();
    await running;
  }

  async function runAction(frame) {
    const { seq } = frame;
    const action = await request('tools/call', { name: 'preview_action', arguments: buildActionArguments(options, frame) });
    if (action.result?.isError) throw new Error(action.result.content?.[0]?.text ?? 'preview_action failed');
    const afterSeq = action.result.structuredContent?.metrics?.nextFrameAfterSeq;
    if (!Number.isInteger(afterSeq) || afterSeq < seq) throw new Error('preview_action returned an invalid frame barrier');
    const next = (await request('tools/call', { name: 'preview_frame', arguments: {
      afterSeq, waitMs: 2500
    } })).result.structuredContent;
    if (!next.frame || next.seq <= afterSeq) throw new Error('preview_frame returned no frame after action');
    return { result: action.result, next };
  }
}

export function buildActionArguments(options, { seq, sessionId, deviceId }) {
  const action = options.action ?? 'tap';
  return { action, seq, sessionId, deviceId, x: options.x, y: options.y,
    ...(action === 'swipe' ? { toX: options.toX, toY: options.toY } : {}) };
}

export function createBenchmarkReport(options, warmup, samples) {
  return {
    deviceId: options.device,
    scale: samples.at(-1)?.scale ?? warmup.at(-1)?.scale ?? null,
    x: options.x,
    y: options.y,
    ...(options.action === 'swipe' ? { toX: options.toX, toY: options.toY } : {}),
    sampleCount: samples.length,
    warmupCount: warmup.length,
    measurementScope: {
      connection: 'isolated_process',
      action: options.action ?? 'tap',
      startsAt: 'preview_action_request',
      endsAt: 'post_action_frame_received_by_mcp',
      panelRenderingIncluded: false,
      businessOutcomeVerified: false,
      otherCaptureSessions: 'not_checked',
      percentileMethod: 'nearest_rank'
    },
    warnings: samples.length < 100
      ? [`Only ${samples.length} action samples; p95 describes this run and does not establish stable tail latency. Compare repeated runs with more samples.`]
      : [],
    warmup,
    samples,
    summary: summarize(samples),
    thresholds: { maxActionP95: options.maxActionP95, maxCaptureP95: options.maxCaptureP95 }
  };
}

function sample(startedAt, actionResult, next, index) {
  const actionMs = actionResult.structuredContent?.metrics?.actionMs ?? null;
  const actionRoundTripMs = Math.round(performance.now() - startedAt);
  return {
    index,
    actionRoundTripMs,
    actionMs,
    actionPrepareMs: actionResult.structuredContent?.metrics?.actionPrepareMs ?? null,
    actionInputMs: actionResult.structuredContent?.metrics?.actionInputMs ?? null,
    inputMethod: actionResult.structuredContent?.metrics?.inputMethod ?? null,
    frameWaitMs: actionMs === null ? null : Math.max(0, actionRoundTripMs - actionMs),
    captureMs: next.metrics?.captureMs ?? null,
    frameAgeMs: next.frameAgeMs ?? null,
    scale: next.metrics?.scale ?? null,
    frameBytes: next.metrics?.frameBytes ?? null,
    combinedMs: next.metrics?.captureStages?.combinedMs ?? null,
    snapshotMs: next.metrics?.captureStages?.snapshotMs ?? null,
    transferMs: next.metrics?.captureStages?.transferMs ?? null,
    readMs: next.metrics?.captureStages?.readMs ?? null,
    width: next.frame.width ?? null,
    height: next.frame.height ?? null,
    frameSource: next.frameSource ?? null,
    seq: next.seq
  };
}

function summarize(samples) {
  const fields = ['actionRoundTripMs', 'actionMs', 'actionPrepareMs', 'actionInputMs', 'frameWaitMs', 'captureMs', 'combinedMs', 'snapshotMs', 'transferMs', 'readMs', 'frameAgeMs'];
  const summary = { count: samples.length };
  for (const field of fields) {
    const values = samples.map((sample) => sample[field]).filter((value) => Number.isFinite(value));
    if (values.length === 0) { summary[field] = null; continue; }
    summary[field] = {
      count: values.length,
      min: Math.min(...values),
      p50: percentile(values, 0.5),
      p95: percentile(values, 0.95),
      max: Math.max(...values),
      avg: Math.round(values.reduce((total, value) => total + value, 0) / values.length)
    };
  }
  return summary;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

export function parseArguments(args) {
  const result = { action: 'tap', actions: 3, warmup: 1, x: 1, y: 1, maxActionP95: null, maxCaptureP95: null, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') { result.help = true; continue; }
    if (!['--device', '--action', '--actions', '--warmup', '--x', '--y', '--to-x', '--to-y', '--max-action-p95', '--max-capture-p95'].includes(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = args[++index];
    if (value === undefined) throw new Error(`${arg} requires a value`);
    if (arg === '--device') result.device = value;
    else if (arg === '--action') {
      if (!['tap', 'swipe'].includes(value)) throw new Error('--action must be tap or swipe');
      result.action = value;
    }
    else if (arg === '--actions') result.actions = positiveInteger(value, arg);
    else if (arg === '--warmup') result.warmup = nonNegativeInteger(value, arg);
    else if (arg === '--x') result.x = nonNegativeNumber(value, arg);
    else if (arg === '--y') result.y = nonNegativeNumber(value, arg);
    else if (arg === '--to-x') result.toX = nonNegativeNumber(value, arg);
    else if (arg === '--to-y') result.toY = nonNegativeNumber(value, arg);
    else if (arg === '--max-action-p95') result.maxActionP95 = positiveNumber(value, arg);
    else if (arg === '--max-capture-p95') result.maxCaptureP95 = positiveNumber(value, arg);
  }
  if (!result.help && result.action === 'swipe' && (!args.includes('--x') || !args.includes('--y') || result.toX === undefined || result.toY === undefined)) {
    throw new Error('--action swipe requires explicit --x, --y, --to-x and --to-y');
  }
  if (!result.help && result.action === 'swipe' && Math.round(result.x) === Math.round(result.toX) && Math.round(result.y) === Math.round(result.toY)) {
    throw new Error('--action swipe requires different start and end coordinates after rounding');
  }
  if (!result.help && result.action === 'tap' && (result.toX !== undefined || result.toY !== undefined)) {
    throw new Error('--to-x and --to-y require --action swipe');
  }
  return result;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) throw new Error(`${name} must be an integer from 1 to 100`);
  return parsed;
}

function nonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) throw new Error(`${name} must be an integer from 0 to 100`);
  return parsed;
}

function nonNegativeNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

function enforceThreshold(metric, threshold, label) {
  if (threshold === null) return;
  if (metric === null || metric === undefined) throw new Error(`${label} is unavailable`);
  if (metric.p95 > threshold) throw new Error(`${label} ${metric.p95} exceeded threshold ${threshold}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

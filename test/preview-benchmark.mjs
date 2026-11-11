import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildActionArguments, createBenchmarkReport, parseArguments } from '../scripts/preview-benchmark.mjs';

const options = { device: 'test-device', x: 1, y: 2, maxActionP95: 500, maxCaptureP95: null };
const warmup = [{ actionRoundTripMs: 9999, captureMs: 9999, scale: 1 }];
const samples = [100, 200, 300].map((actionRoundTripMs, index) => ({
  actionRoundTripMs, captureMs: index === 0 ? null : actionRoundTripMs / 2, scale: 0.75
}));
const report = createBenchmarkReport(options, warmup, samples);
assert.equal(report.sampleCount, 3);
assert.equal(report.warmupCount, 1);
assert.equal(report.summary.count, 3, 'warmup must not enter the measured statistics');
assert.deepEqual(report.summary.actionRoundTripMs, { count: 3, min: 100, p50: 200, p95: 300, max: 300, avg: 200 });
assert.equal(report.summary.captureMs.count, 2, 'each metric must report its actual finite sample count');
assert.equal(report.summary.captureMs.p95, 150);
assert.equal(report.summary.actionPrepareMs, null);
assert.equal(report.scale, 0.75);
assert.equal(report.measurementScope.connection, 'isolated_process');
assert.equal(report.measurementScope.action, 'tap');
assert.equal(report.measurementScope.startsAt, 'preview_action_request');
assert.equal(report.measurementScope.endsAt, 'post_action_frame_received_by_mcp');
assert.equal(report.measurementScope.panelRenderingIncluded, false);
assert.equal(report.measurementScope.businessOutcomeVerified, false);
assert.equal(report.measurementScope.otherCaptureSessions, 'not_checked', 'an isolated MCP process does not establish exclusive device access');
assert.equal(report.measurementScope.percentileMethod, 'nearest_rank');
assert.match(report.warnings.join(' '), /Only 3 action samples.*does not establish stable tail latency/);
assert.deepEqual(report.thresholds, { maxActionP95: 500, maxCaptureP95: null });

const larger = createBenchmarkReport(options, [], Array.from({ length: 100 }, (_, index) => ({ actionRoundTripMs: index + 1 })));
assert.equal(larger.sampleCount, 100);
assert.equal(larger.summary.actionRoundTripMs.p95, 95);
assert.deepEqual(larger.warnings, []);
assert.equal(larger.measurementScope.businessOutcomeVerified, false, 'more timing samples cannot prove business success');

const swipeOptions = parseArguments(['--device', 'test-device', '--action', 'swipe', '--x', '40', '--y', '80', '--to-x', '40', '--to-y', '10']);
const frame = { seq: 3, sessionId: 'session', deviceId: 'test-device' };
assert.deepEqual(buildActionArguments(swipeOptions, frame), { action: 'swipe', ...frame, x: 40, y: 80, toX: 40, toY: 10 });
assert.deepEqual(buildActionArguments(options, frame), { action: 'tap', ...frame, x: 1, y: 2 });
const swipeReport = createBenchmarkReport(swipeOptions, [], samples);
assert.equal(swipeReport.measurementScope.action, 'swipe');
assert.equal(swipeReport.measurementScope.businessOutcomeVerified, false);
assert.deepEqual([swipeReport.x, swipeReport.y, swipeReport.toX, swipeReport.toY], [40, 80, 40, 10]);
assert.throws(() => parseArguments(['--action', 'swipe', '--to-x', '40', '--to-y', '10']), /requires explicit/);
assert.throws(() => parseArguments(['--action', 'swipe', '--x', '1', '--y', '2', '--to-x', '1', '--to-y', '2']), /different start and end/);
assert.throws(() => parseArguments(['--action', 'swipe', '--x', '1.1', '--y', '2.1', '--to-x', '1.2', '--to-y', '2.2']), /different start and end.*rounding/);
assert.doesNotThrow(() => parseArguments(['--action', 'swipe', '--x', '1.1', '--y', '2.1', '--to-x', '1.6', '--to-y', '2.2']));
assert.throws(() => parseArguments(['--action', 'tap', '--to-x', '4']), /require --action swipe/);
assert.throws(() => parseArguments(['--action', 'drag']), /must be tap or swipe/);

const help = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/preview-benchmark.mjs', import.meta.url)), '--help'], { encoding: 'utf8', windowsHide: true });
assert.equal(help.status, 0, help.stderr);
assert.match(help.stdout, /Usage:.*--actions/);
console.log('preview benchmark: ok');

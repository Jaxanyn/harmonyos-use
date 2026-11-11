import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDeviceAdapter } from '../src/device.mjs';
import { describeLayout, flattenLayout, matchesSelector, requireTapTarget, validateSelector } from '../src/layout.mjs';

const layout = { attributes: { id: 'root', type: 'Column', bounds: '[0,0][1080,1920]' }, children: [
  { attributes: { id: 'confirm-a', text: '确认', type: 'Button', bounds: '[10, 20][110, 80]', clickable: 'true', enabled: 'true', focused: 'false', visible: true } },
  { attributes: { id: 'group', type: 'Row', bounds: { left: 0, top: 0, right: 0, bottom: 0 } }, children: [
    { attributes: { id: 'confirm-b', text: '确认', type: 'Button', bounds: '[120,20][220,80]', clickable: true, enabled: false } },
    { attributes: { id: 'search', text: '搜索鸿蒙应用', type: 'Text', bounds: 'invalid', enabled: 'true' } }
  ] }
] };
const nodes = flattenLayout(layout);
assert.equal(nodes.length, 5);
assert.deepEqual(nodes[1].center, { x: 60, y: 50 });
assert.equal(nodes[1].clickable, true);
assert.equal(nodes[1].focused, false);
assert.equal(nodes[1].visible, true);
assert.equal(nodes[2].center, undefined, 'empty bounds must not supply a click target');
assert.equal(nodes[4].bounds, null);
assert.equal(nodes[4].center, undefined);
assert.equal(matchesSelector(nodes[1], { text: '确认', type: 'Button', enabled: true }), true);
assert.equal(matchesSelector(nodes[3], { text: '确认', enabled: true }), false);
assert.equal(matchesSelector(nodes[4], { textContains: '鸿蒙' }), true);
assert.deepEqual(describeLayout({ totalNodes: 5, truncated: false }), { treeQuality: 'full', fallback: 'none', customRendered: false, warnings: [] });
assert.equal(describeLayout({ totalNodes: 5, truncated: true }).treeQuality, 'partial');
assert.equal(describeLayout({ totalNodes: 0, truncated: false }).treeQuality, 'empty');
assert.deepEqual(flattenLayout({ children: [] }), []);
assert.equal(flattenLayout([layout]).length, 5);
assert.equal(flattenLayout({ windows: [layout] }).length, 5);
assert.equal(flattenLayout({ attributes: { bounds: '[-1,0][10,10]' } })[0].bounds, null);
assert.equal(flattenLayout({ attributes: { bounds: '[20,0][10,10]' } })[0].bounds, null);
assert.throws(() => flattenLayout(null), /JSON object/);
for (const selector of [{}, [], null, { unknown: 'value' }, { clickable: 'true' }, { text: '' }]) assert.throws(() => validateSelector(selector));
validateSelector({ text: '确认', clickable: true });

const semanticMarker = flattenLayout({ attributes: {
  id: 'map-stop-stop_123',
  type: 'Button',
  bounds: '[900,280][1000,380]',
  clickable: 'true',
  enabled: 'true',
  visible: 'true'
} })[0];
assert.equal(matchesSelector(semanticMarker, { id: 'map-stop-stop_123', type: 'Button', clickable: true, enabled: true }), true,
  'semantic map markers must be discoverable by stable stop ID');
assert.equal(requireTapTarget({ totalMatches: 1, matches: [semanticMarker], observedAt: Date.now() }), semanticMarker,
  'semantic map markers must be valid tap targets');

const tapFound = { totalMatches: 1, matches: [nodes[1]], observedAt: Date.now() };
assert.equal(requireTapTarget(tapFound), nodes[1], 'the helper must return the original unique node');
for (const [found, errorCode] of [
  [{ ...tapFound, totalMatches: 0, matches: [] }, 'ELEMENT_NOT_FOUND'],
  [{ ...tapFound, totalMatches: 2 }, 'ELEMENT_AMBIGUOUS'],
  [{ ...tapFound, matches: [nodes[1], nodes[1]] }, 'ELEMENT_AMBIGUOUS'],
  [{ ...tapFound, matches: [] }, 'ELEMENT_AMBIGUOUS'],
  ...[
    { clickable: false }, { enabled: false }, { visible: false }, { bounds: null },
    { bounds: { left: -1, top: 0, right: 10, bottom: 10 } },
    { bounds: { left: 10, top: 0, right: 10, bottom: 10 } },
    { bounds: { left: 0, top: 0, right: Infinity, bottom: 10 } },
    { center: null }, { center: { x: NaN, y: 30 } }, { center: { x: 110, y: 30 } }, { center: { x: 10, y: 80 } }
  ].map((changes) => [{ ...tapFound, matches: [{ ...nodes[1], ...changes }] }, 'ELEMENT_NOT_ACTIONABLE']),
  [{ ...tapFound, observedAt: NaN }, 'STALE_OBSERVATION'],
  [{ ...tapFound, observedAt: String(tapFound.observedAt) }, 'STALE_OBSERVATION']
]) {
  assert.throws(() => requireTapTarget(found), (error) => {
    assert.equal(error.errorCode, errorCode);
    assert.equal(error.stage, 'tap_element');
    return true;
  });
}
const originalNow = Date.now;
try {
  Date.now = () => tapFound.observedAt + 1000;
  assert.equal(requireTapTarget(tapFound), nodes[1], 'a 1000ms observation is still accepted');
  Date.now = () => tapFound.observedAt + 1001;
  assert.throws(() => requireTapTarget(tapFound), (error) => error.errorCode === 'STALE_OBSERVATION');
  Date.now = () => tapFound.observedAt - 1;
  assert.throws(() => requireTapTarget(tapFound), (error) => error.errorCode === 'STALE_OBSERVATION');
} finally {
  Date.now = originalNow;
}

const directory = await mkdtemp(join(tmpdir(), 'harmonyos-preview-layout-'));
const calls = [];
let failure;
let malformed = false;
const adapter = createDeviceAdapter({
  directory,
  timeoutMs: 250,
  runtime: async (_command, args, options) => {
    calls.push({ args, options });
    if (args[0] === 'list') return { code: 0, stdout: 'test-device\n', stderr: '' };
    if (args.includes('dumpLayout') && failure === 'dump') return { code: 124, stdout: '', stderr: 'layout timed out' };
    if (args.includes('recv')) {
      if (failure === 'recv') return { code: 1, stdout: '', stderr: 'download failed' };
      await writeFile(args.at(-1), malformed ? '{invalid' : JSON.stringify(layout));
    }
    return { code: 0, stdout: '', stderr: '' };
  }
});

try {
  const observed = await adapter.observe({ deviceId: 'test-device', bundleName: 'com.example.app', maxNodes: 2 });
  assert.equal(observed.nodes.length, 2);
  assert.equal(observed.totalNodes, 5);
  assert.equal(observed.truncated, true);
  assert.equal(observed.deviceId, 'test-device');
  assert.equal(typeof observed.observedAt, 'number');
  assert.ok(observed.warnings.length);
  const dump = calls.find(({ args }) => args.includes('dumpLayout'));
  assert.ok(dump.args.includes('-b') && dump.args.includes('com.example.app'));
  assert.equal(dump.options.timeoutMs, 250);
  assert.ok(calls.filter(({ args }) => args.includes('recv')).every(({ args }) => dirname(args.at(-1)) === directory));
  assert.deepEqual(await readdir(directory), [], 'successful layout reads must clean temporary files');

  const found = await adapter.find({ deviceId: 'test-device', selector: { text: '确认' } });
  assert.equal(found.totalMatches, 2, 'duplicate labels must all be returned without clicking');
  assert.equal(found.matches.length, 2);
  assert.equal(found.truncated, false);
  assert.equal((await adapter.find({ deviceId: 'test-device', selector: { text: '确认' }, limit: 1 })).truncated, true);
  assert.equal((await adapter.find({ deviceId: 'test-device', selector: { text: '确认', enabled: true } })).totalMatches, 1);
  assert.equal((await adapter.find({ deviceId: 'test-device', selector: { textContains: '鸿蒙' } })).matches[0].id, 'search');
  assert.equal((await adapter.find({ deviceId: 'test-device', selector: { id: 'missing' } })).totalMatches, 0);
  assert.ok(!calls.some(({ args }) => args.includes('uiInput')), 'observe/find must not perform UI actions');

  const callsBeforeInvalid = calls.length;
  for (const options of [{ maxNodes: 0 }, { maxNodes: 1001 }, { bundleName: 'com.app;echo' }]) await assert.rejects(adapter.observe({ deviceId: 'test-device', ...options }));
  for (const options of [{ selector: {} }, { selector: { type: 'Button' }, limit: 101 }]) await assert.rejects(adapter.find({ deviceId: 'test-device', ...options }));
  assert.equal(calls.length, callsBeforeInvalid, 'invalid requests must not reach HDC');

  malformed = true;
  await assert.rejects(adapter.observe({ deviceId: 'test-device' }), (error) => {
    assert.match(error.message, /valid JSON/);
    assert.equal(error.errorCode, 'LAYOUT_UNAVAILABLE');
    assert.equal(error.stage, 'layout_parse');
    assert.equal(typeof error.cause.message, 'string');
    return true;
  });
  malformed = false;
  failure = 'recv';
  await assert.rejects(adapter.observe({ deviceId: 'test-device' }), (error) => {
    assert.match(error.message, /download failed/);
    assert.equal(error.errorCode, 'LAYOUT_UNAVAILABLE');
    assert.equal(error.stage, 'layout_transfer');
    assert.equal(error.exitCode, 1);
    assert.equal(error.deviceId, 'test-device');
    return true;
  });
  failure = 'dump';
  await assert.rejects(adapter.observe({ deviceId: 'test-device' }), (error) => {
    assert.match(error.message, /timed out/);
    assert.equal(error.errorCode, 'HDC_TIMEOUT');
    assert.equal(error.stage, 'layout_dump');
    assert.equal(error.exitCode, 124);
    return true;
  });
  assert.deepEqual(await readdir(directory), [], 'all layout failures must clean generated local files');
  assert.ok(calls.at(-1).args.includes('rm'), 'failed dumps must still clean the generated remote path');
  assert.ok(calls.filter(({ args }) => args.includes('rm')).every(({ options }) => options.timeoutMs <= 2000));

  const cleanupCalls = [];
  const cleanupFailure = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    cleanupCalls.push(args);
    if (args.includes('recv')) await writeFile(args.at(-1), JSON.stringify(layout));
    return { code: args.includes('rm') ? 1 : 0, stdout: '', stderr: args.includes('rm') ? 'cleanup failed' : '' };
  } });
  assert.equal((await cleanupFailure.observe({ deviceId: 'test-device' })).totalNodes, 5);
  assert.ok(!cleanupCalls.some((args) => args[0] === 'list'), 'cleanup failures must not probe devices or replace a successful observation');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('layout: ok');

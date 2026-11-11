import assert from 'node:assert/strict';
import { createDeviceAdapter } from '../src/device.mjs';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const help = `Usage: uinput
-S --stylus
-m <x1> <y1> <x2> <y2>
-T --touch
-m <dx1> <dy1> <dx2> <dy2> [-k keep time] [smooth time]
-k --knuckle`;
const options = { deviceId: 'device', fromX: 100, fromY: 200, toX: 500, toY: 200, velocity: 1200 };
const success = (script) => `${script.match(/HARMONY_SWIPE_[a-f0-9]+_OK/)[0]}\nNo Error`;
process.env.HARMONY_PREVIEW_FAST_SWIPE = 'device';

// Only a specifically configured device may attempt the fast method.
{
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_cmd, args) => { calls.push(args); return ok(); } });
  assert.equal((await adapter.previewSwipe({ ...options, deviceId: 'other' })).metrics.inputMethod, 'uitest');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('uitest'));
  delete process.env.HARMONY_PREVIEW_FAST_SWIPE;
  const defaultAdapter = createDeviceAdapter({ runtime: async (_cmd, args) => { calls.push(args); return ok(); } });
  assert.equal((await defaultAdapter.previewSwipe(options)).metrics.inputMethod, 'uitest');
  process.env.HARMONY_PREVIEW_FAST_SWIPE = 'device';
}

// Probe once, then send a single gesture with the same endpoints and nominal speed.
{
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_cmd, args) => {
    calls.push(args);
    return ok(args[3]?.includes('uinput --help') ? help : success(args[3]));
  } });
  assert.deepEqual(await Promise.all([adapter.preparePreviewSwipe(options), adapter.preparePreviewSwipe(options)]), [true, true]);
  const result = await adapter.previewSwipe(options);
  assert.equal(result.metrics.inputMethod, 'uinput');
  assert.ok(calls.some((args) => args[3]?.includes('uinput -T -m 100 200 500 200 333')));
  await adapter.previewSwipe({ ...options, fromX: 500, fromY: 500, toX: 200, toY: 100 });
  assert.ok(calls.some((args) => args[3]?.includes('uinput -T -m 500 500 200 100 417')));
  assert.equal(calls.filter((args) => args[3]?.includes('uinput --help')).length, 1);
  assert.ok(!calls.some((args) => args.includes('uitest')));
}

// Missing touch movement support or impossible nominal durations fall back before dispatch.
for (const probe of [ok('-T --touch\n-c <x> <y>'), ok('-S --stylus\n-m <x1> <y1> <x2> <y2>'), { code: 1, stdout: '', stderr: 'no help' }]) {
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_cmd, args) => { calls.push(args); return args[3]?.includes('uinput --help') ? probe : ok(); } });
  assert.equal((await adapter.previewSwipe(options)).metrics.inputMethod, 'uitest');
  assert.ok(calls.some((args) => args.includes('uitest')));
  assert.ok(!calls.some((args) => args[3]?.includes('uinput -T -m')));
}
{
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_cmd, args) => { calls.push(args); return ok(); } });
  assert.equal((await adapter.previewSwipe({ ...options, toX: 100.1 })).metrics.inputMethod, 'uitest');
  assert.equal((await adapter.previewSwipe({ ...options, toX: 40000, velocity: 200 })).metrics.inputMethod, 'uitest');
  assert.ok(!calls.some((args) => args[3]?.includes('uinput -T -m')));
}

// Once a fast gesture is attempted, missing markers, errors and timeout never cause a second input.
{
  const calls = [];
  const adapter = createDeviceAdapter({ timeoutMs: 2500, runtime: async (_cmd, args) => {
    calls.push(args);
    return ok(args[3]?.includes('uinput --help') ? help : args[3]?.includes('uinput -T -m') ? success(args[3]) : '');
  } });
  assert.equal((await adapter.previewSwipe({ ...options, toX: 700 })).metrics.inputMethod, 'uinput', '500ms fits with 2s transport reserve');
  assert.equal((await adapter.previewSwipe({ ...options, toX: 701 })).metrics.inputMethod, 'uitest', '501ms exceeds the configured time budget');
}

// Once a fast gesture is attempted, missing markers, errors and timeout never cause a second input.
for (const reply of [ok('permission denied'), ok('unexpected output'), { code: 1, stdout: '', stderr: 'input failed' }, { code: 124, stdout: '', stderr: 'timed out' }]) {
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_cmd, args) => { calls.push(args); return args[3]?.includes('uinput --help') ? ok(help) : reply; } });
  await assert.rejects(adapter.previewSwipe(options), /result unknown/i);
  assert.equal(calls.filter((args) => args[3]?.includes('uinput -T -m')).length, 1);
  assert.ok(!calls.some((args) => args.includes('uitest')));
  assert.ok(!calls.some((args) => args[3]?.includes('uinput -T -u')));
}

// Abort before a capability probe completes or after dispatch must not cause fallback.
for (const abortDuring of ['probe', 'gesture']) {
  const calls = [];
  const controller = new AbortController();
  let pending = false;
  const adapter = createDeviceAdapter({ runtime: async (_cmd, args) => {
    calls.push(args);
    const isProbe = args[3]?.includes('uinput --help');
    if ((abortDuring === 'probe') === isProbe) { pending = true; return new Promise(() => {}); }
    return ok(help);
  } });
  const action = adapter.previewSwipe(options, { signal: controller.signal });
  while (!pending) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(action);
  assert.equal(calls.filter((args) => args[3]?.includes('uinput -T -m')).length, abortDuring === 'gesture' ? 1 : 0);
  assert.ok(!calls.some((args) => args.includes('uitest')));
}

console.log('preview fast swipe: ok');

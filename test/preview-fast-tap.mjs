import assert from 'node:assert/strict';
import { createDeviceAdapter } from '../src/device.mjs';

process.env.HARMONY_PREVIEW_FAST_TAP = 'device';
const help = `Usage: uinput <option> <command> <arg>...
-S  --stylus
-c <dx1> <dy1> [click interval] -stylus click
-T  --touch
-d <dx1> <dy1> -press
-c <dx1> <dy1> [click interval] -touch screen click
-k --knuckle`;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const success = (script) => `${script.match(/HARMONY_TAP_[a-f0-9]+_OK/)[0]}\nclick coordinate: (12, 34)\nclick interval time: 20ms`;
const options = { deviceId: 'device', x: 12.2, y: 33.7 };

// Fast input is opt-in for exactly one configured device.
{
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_command, args) => { calls.push(args); return ok('No Error'); } });
  assert.equal((await adapter.previewTap({ ...options, deviceId: 'other-device' })).metrics?.inputMethod, 'uitest');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('uitest'));
  const previous = process.env.HARMONY_PREVIEW_FAST_TAP;
  delete process.env.HARMONY_PREVIEW_FAST_TAP;
  const defaultAdapter = createDeviceAdapter({ runtime: async (_command, args) => { calls.push(args); return ok('No Error'); } });
  assert.equal((await defaultAdapter.previewTap(options)).metrics?.inputMethod, 'uitest');
  process.env.HARMONY_PREVIEW_FAST_TAP = previous;
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('uitest'));
}

// A supported device probes once and sends one fast tap per action.
{
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_command, args) => {
    calls.push(args);
    return ok(args[3]?.includes('uinput --help') ? help : `${success(args[3])}\nNo Error\npermission granted`);
  } });
  assert.deepEqual(await Promise.all([adapter.preparePreviewTap(options), adapter.preparePreviewTap(options)]), [true, true]);
  assert.deepEqual(await adapter.previewTap(options), { deviceId: 'device', x: 12, y: 34, metrics: { inputMethod: 'uinput' } });
  await adapter.previewTap(options);
  assert.equal(calls.filter((args) => args[3]?.includes('uinput --help')).length, 1);
  assert.equal(calls.filter((args) => args[3]?.includes('uinput -T -c 12 34 20')).length, 2);
  assert.ok(!calls.some((args) => args.includes('uitest')));
}

// Unsupported or failed capability checks fall back before any input is sent.
for (const probe of [ok('Usage: uinput\n-S --stylus\n-c <x> <y>'), { code: 1, stdout: '', stderr: 'probe failed' }, ok('-T --touch\n-d <x> <y>')]) {
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_command, args) => {
    calls.push(args);
    return args[3]?.includes('uinput --help') ? probe : ok('No Error');
  } });
  assert.equal((await adapter.previewTap(options)).metrics?.inputMethod, 'uitest');
  await adapter.previewTap(options);
  assert.equal(calls.filter((args) => args[3]?.includes('uinput --help')).length, 1);
  assert.equal(calls.filter((args) => args.includes('uitest')).length, 2);
  assert.ok(!calls.some((args) => args[3]?.includes('uinput -T -c')));
}

// Once a fast action has been attempted, failures must never repeat the click.
for (const reply of [ok('permission denied'), ok('unexpected output'), { code: 1, stdout: '', stderr: 'input failed' }]) {
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_command, args) => {
    calls.push(args);
    return args[3]?.includes('uinput --help') ? ok(help) : reply;
  } });
  await assert.rejects(adapter.previewTap(options), (error) => error.errorCode === 'ACTION_FAILED');
  assert.equal(calls.filter((args) => args[3]?.includes('uinput -T -c')).length, 1);
  assert.ok(!calls.some((args) => args.includes('uitest')));
}

// Invalid coordinates and cancellation cannot dispatch an input command.
{
  const calls = [];
  let finishProbe;
  const adapter = createDeviceAdapter({ runtime: async (_command, args) => {
    calls.push(args);
    if (args[3]?.includes('uinput --help')) return new Promise((resolve) => { finishProbe = resolve; });
    throw new Error('input must not be sent');
  } });
  await assert.rejects(adapter.previewTap({ ...options, x: -1 }), /non-negative/);
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  const action = adapter.previewTap(options, { signal: controller.signal });
  while (!finishProbe) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(action, (error) => error.name === 'AbortError');
  finishProbe(ok(help));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
}

// Cancellation during an attempted fast input is also never retried.
{
  const calls = [];
  const adapter = createDeviceAdapter({ runtime: async (_command, args) => {
    calls.push(args);
    if (args[3]?.includes('uinput --help')) return ok(help);
    return new Promise(() => {});
  } });
  const controller = new AbortController();
  const action = adapter.previewTap(options, { signal: controller.signal });
  while (!calls.some((args) => args[3]?.includes('uinput -T -c'))) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(action, (error) => error.name === 'AbortError');
  assert.ok(!calls.some((args) => args.includes('uitest')));
}

console.log('preview fast tap: ok');

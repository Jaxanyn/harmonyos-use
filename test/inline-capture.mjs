import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceAdapter, runCommand } from '../src/device.mjs';

const directory = await mkdtemp(join(tmpdir(), 'harmony-inline-capture-'));
const jpeg = Buffer.from('ffd8ffc0000b080010001001011100ffda0008010100003f0055ffd9', 'hex');
const fastCommand = (args) => args[2] === 'shell' && args[3]?.includes('HARMONY_PREVIEW_');
const markerOf = (script) => script.match(/(HARMONY_PREVIEW_[a-f0-9]+)_BEGIN/)[1];
const success = (script, data = jpeg) => {
  const marker = markerOf(script);
  const encoded = data.toString('base64');
  return `${marker}_BEGIN\r\n${encoded.slice(0, 12)}\r\n${encoded.slice(12)}\r\n${marker}_END\r\n`;
};
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const frameOptions = { deviceId: 'device', width: 640, height: 1024 };

try {
  const calls = [];
  const adapter = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    calls.push(args);
    return ok(fastCommand(args) ? success(args[3]) : '');
  } });
  const frame = await adapter.capture(frameOptions);
  assert.deepEqual(frame.data, jpeg);
  assert.equal(calls.length, 1, 'successful combined capture uses one HDC command');
  assert.match(calls[0][3], /trap 'rm -f .*?-inline\.jpeg >\/dev\/null 2>&1' EXIT/);
  assert.match(calls[0][3], /snapshot_display -w 640 -h 1024 -f [^ ]+-inline\.jpeg /);
  assert.match(calls[0][3], /snapshot_display -w 640 -h 1024/);
  assert.ok(Number.isFinite(frame.captureTiming.combinedMs));
  assert.equal(frame.captureTiming.snapshotMs, undefined, 'combined timing must not claim a snapshot-only duration');
  assert.deepEqual(await readdir(directory), []);

  for (const invalid of ['missing-end', 'bad-base64', 'truncated-jpeg', 'trailing-output']) {
    const fallbackCalls = [];
    const fallback = createDeviceAdapter({ directory, runtime: async (_command, args) => {
      fallbackCalls.push(args);
      if (fastCommand(args)) {
        const output = success(args[3], invalid === 'truncated-jpeg' ? jpeg.subarray(0, -2) : jpeg);
        if (invalid === 'missing-end') return ok(output.split(/HARMONY_PREVIEW_.*_END/)[0]);
        if (invalid === 'bad-base64') return ok(output.replace(jpeg.toString('base64').slice(0, 12), '!!!!'));
        if (invalid === 'trailing-output') return ok(output + 'unexpected data');
        return ok(output);
      }
      if (args.includes('recv')) await writeFile(args.at(-1), jpeg);
      return ok();
    } });
    assert.deepEqual((await fallback.capture(frameOptions)).data, jpeg, `${invalid} must fall back`);
    assert.ok(fallbackCalls.some((args) => args.includes('recv')), 'fallback receives a file');
    assert.ok(fallbackCalls.some((args) => args.includes('rm') && args.at(-1).endsWith('-inline.jpeg')), 'failed combined capture is cleaned');
    await fallback.capture(frameOptions);
    assert.equal(fallbackCalls.filter(fastCommand).length, 2, 'invalid output must not permanently disable inline capture');
  }

  const unsupportedCalls = [];
  const unsupported = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    unsupportedCalls.push(args);
    if (fastCommand(args)) return ok(`${markerOf(args[3])}_UNSUPPORTED\n`);
    if (args.includes('recv')) await writeFile(args.at(-1), jpeg);
    return ok();
  } });
  await unsupported.capture(frameOptions);
  await unsupported.capture(frameOptions);
  assert.equal(unsupportedCalls.filter(fastCommand).length, 1, 'explicitly unsupported base64 is cached');

  const bigCalls = [];
  const bigAdapter = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    bigCalls.push(args);
    if (args.includes('recv')) await writeFile(args.at(-1), jpeg);
    return ok();
  } });
  await bigAdapter.capture({ deviceId: 'device', width: 4096, height: 2048 });
  assert.ok(!bigCalls.some(fastCommand), 'large frames use the file transport');
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("A".repeat(100000))'], { timeoutMs: 5000, maxOutputBytes: 1024 }),
    (error) => error.code === 'OUTPUT_LIMIT');
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stderr.write("A".repeat(100000))'], { timeoutMs: 5000, maxOutputBytes: 1024 }),
    (error) => error.code === 'OUTPUT_LIMIT');
  await assert.rejects(runCommand(process.execPath, ['-e', 'process.stdout.write("A".repeat(800)); process.stderr.write("B".repeat(800))'], { timeoutMs: 5000, maxOutputBytes: 1024 }),
    (error) => error.code === 'OUTPUT_LIMIT');

  const abortCalls = [];
  const abortAdapter = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    abortCalls.push(args);
    if (fastCommand(args)) return new Promise(() => {});
    return ok();
  } });
  const controller = new AbortController();
  const pending = abortAdapter.capture(frameOptions, { signal: controller.signal });
  while (!abortCalls.some(fastCommand)) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(abortCalls.some((args) => args.includes('rm') && args.at(-1).endsWith('-inline.jpeg')), 'cancelled combined capture is cleaned');
  assert.ok(!abortCalls.some((args) => args.includes('recv')), 'cancellation never falls back');

  const secretOutput = 'SCREEN_BASE64_MUST_NOT_BE_REPORTED';
  const failing = createDeviceAdapter({ directory, runtime: async (_command, args) => {
    if (fastCommand(args)) return { code: 1, stdout: secretOutput, stderr: 'inline unavailable' };
    if (args.includes('snapshot_display')) return { code: 1, stdout: '', stderr: 'legacy capture failed' };
    return ok();
  } });
  await assert.rejects(failing.capture(frameOptions), (error) => {
    assert.match(error.message, /legacy capture failed/);
    assert.ok(!JSON.stringify(error).includes(secretOutput));
    assert.ok(!error.message.includes(secretOutput));
    return true;
  });
  assert.deepEqual(await readdir(directory), []);
  console.log('inline capture: ok');
} finally {
  await rm(directory, { recursive: true, force: true });
}

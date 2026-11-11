import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createPreviewServer } from '../src/server.mjs';

const coordinated = [];
const executed = [];
let releaseHold;
let reportHold;
const holdStarted = new Promise((resolve) => { reportHold = resolve; });
let dropEntered, dropReleased, dropFinished;
function prepareDrop() {
  let enter, finish;
  const entered = new Promise((resolve) => { enter = resolve; });
  const finished = new Promise((resolve) => { finish = resolve; });
  dropEntered = enter;
  dropFinished = finish;
  return { entered, finished };
}
async function waitForClosed(isLive) {
  for (let i = 0; i < 100 && isLive(); i++) await delay(20);
  assert.equal(isLive(), false, 'the coordinator must observe the disconnected client');
}
const adapter = {
  listTargets: async () => ['device'],
  capture: async () => ({ mimeType: 'image/jpeg', data: Buffer.from('frame') }),
  ...Object.fromEntries(['tap', 'swipe', 'longPress', 'keyEvent', 'inputText'].map((name) => [name, async (args) => {
    executed.push({ name, deviceId: args.deviceId });
    return { ok: true };
  }]))
};
const server = createPreviewServer({ deviceAdapter: adapter, runDeviceAction: async (deviceId, operation, isLive) => {
  coordinated.push(deviceId);
  if (deviceId === 'hold') { reportHold(); await new Promise((resolve) => { releaseHold = resolve; }); }
  if (deviceId === 'drop') {
    dropEntered(isLive);
    await new Promise((resolve) => { dropReleased = resolve; });
    const live = isLive();
    dropFinished();
    if (!live) throw new Error('client disconnected before input');
  }
  if (deviceId === 'deny') throw new Error('coordinator rejected action');
  if (deviceId === 'build') return { bundleName: 'mock.bundle' };
  return operation();
} });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const socket = new WebSocket(`${base.replace('http:', 'ws:')}/preview`);
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
function messageOf(type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off('message', onMessage); reject(new Error(`timed out: ${type}`)); }, 3000);
    const onMessage = (data, binary) => {
      if (binary) return;
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(message);
    };
    socket.on('message', onMessage);
  });
}
const post = (path, body) => fetch(`${base}${path}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
});
try {
  const capture = await post('/api/capture', { deviceId: 'device' });
  assert.equal(capture.status, 200);
  assert.deepEqual(coordinated, [], 'read-only captures must not enter the input coordinator');

  const held = post('/api/tap', { deviceId: 'hold', x: 2, y: 2 });
  await holdStarted;
  assert.deepEqual(executed, [], 'the HTTP adapter call must wait inside the coordinator');
  releaseHold();
  assert.equal((await held).status, 200);
  assert.deepEqual(executed, [{ name: 'tap', deviceId: 'hold' }]);
  assert.equal((await post('/api/tap', { deviceId: 'deny', x: 2, y: 2 })).ok, false);
  assert.equal(executed.length, 1, 'coordinator rejection must not reach the adapter');

  for (const [type, method] of [['tap', 'tap'], ['swipe', 'swipe'], ['long-press', 'longPress'],
    ['key-event', 'keyEvent'], ['input-text', 'inputText']]) {
    const reply = messageOf(`${type}-ack`);
    socket.send(JSON.stringify({ type, deviceId: 'device', actionId: type, x: 2, y: 2 }));
    assert.equal((await reply).actionId, type);
    assert.deepEqual(executed.at(-1), { name: method, deviceId: 'device' }, `${type} must run through the coordinator`);
  }
  const build = messageOf('run-status');
  socket.send(JSON.stringify({ type: 'build-run', deviceId: 'build' }));
  assert.equal((await build).text, 'Running', 'the entire build-run operation must be passed to the coordinator');
  assert.deepEqual(coordinated, ['hold', 'deny', 'device', 'device', 'device', 'device', 'device', 'build']);

  let drop = prepareDrop();
  const abort = new AbortController();
  const droppedHttp = fetch(`${base}/api/tap`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'drop', x: 2, y: 2 }), signal: abort.signal }).catch((error) => error);
  let isLive = await drop.entered;
  abort.abort();
  await droppedHttp;
  await waitForClosed(isLive);
  dropReleased();
  await drop.finished;
  assert.ok(!executed.some(({ deviceId }) => deviceId === 'drop'), 'disconnected HTTP input must not run after the coordinator releases it');

  drop = prepareDrop();
  const droppedSocket = new WebSocket(`${base.replace('http:', 'ws:')}/preview`);
  await once(droppedSocket, 'open');
  droppedSocket.send(JSON.stringify({ type: 'swipe', deviceId: 'drop', actionId: 'drop-ws' }));
  isLive = await drop.entered;
  droppedSocket.terminate();
  await waitForClosed(isLive);
  dropReleased();
  await drop.finished;
  assert.ok(!executed.some(({ deviceId }) => deviceId === 'drop'), 'disconnected WebSocket input must not run after the coordinator releases it');
  console.log('server device action: ok');
} finally {
  releaseHold?.();
  socket.terminate();
  await server.shutdown();
}

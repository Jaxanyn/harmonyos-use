import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright-core';

// An isolated browser and synthetic device only: this test never starts MCP or HDC.
const appResource = await readFile(new URL('../src/app/resource.html', import.meta.url), 'utf8');
const host = `<!doctype html><html><head><style>html,body,iframe{margin:0;border:0;width:100%;height:100%;overflow:hidden}</style></head><body>
<iframe name="preview" id="app" src="/app" title="Mock preview host" allow="fullscreen"></iframe><script>
const app = document.getElementById('app');
const deviceId = 'browser-test-device', sessionId = 'browser-test-session', subscriberId = 'browser-test-subscriber';
const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 800;
function image(color) { const c = canvas.getContext('2d'); c.fillStyle = color; c.fillRect(0,0,400,800); return canvas.toDataURL('image/png').split(',')[1]; }
const normalImage = image('#55aacc'), recoveredImage = image('#ccaa55'), blackImage = image('#000000');
const fixture = window.fixture = { calls: [], seq: 1, data: normalImage, failNextFrame: false, refresh: null, changeOnPreflight: false };
fixture.showBlack = () => { fixture.seq++; fixture.data = blackImage; };
fixture.showRecovered = () => { fixture.seq++; fixture.data = recoveredImage; };
function result(value) { return { content: [{ type:'text', text:JSON.stringify(value) }], structuredContent:value }; }
function reply(id, value) { app.contentWindow.postMessage({ jsonrpc:'2.0', id, result:value }, location.origin); }
function frame(afterSeq) { return result({ deviceId,sessionId,connected:true,seq:fixture.seq,
  metrics:{source:'jpeg',captureMs:1,deviceWidth:800,deviceHeight:1600},
  frame:fixture.seq > afterSeq ? {mimeType:'image/png',data:fixture.data,width:400,height:800,frameId:'frame-'+fixture.seq,capturedAt:new Date().toISOString()} : null }); }
fixture.finishRefresh = (fail = false) => {
  if (!fixture.refresh) throw new Error('No refresh is waiting');
  const id = fixture.refresh.id; fixture.refresh = null;
  if (fail) reply(id, {isError:true,...result({errorCode:'PREVIEW_UNAVAILABLE',stage:'preview_frame',error:'Injected refresh failure'})});
  else { fixture.seq++; fixture.data = recoveredImage; reply(id, frame(-1)); }
};
window.addEventListener('message', event => {
  if (event.source !== app.contentWindow || event.origin !== location.origin) return;
  const m = event.data;
  if (!m || m.jsonrpc !== '2.0' || !Object.hasOwn(m,'id')) return;
  if (m.method === 'ui/initialize') { reply(m.id,{hostContext:{}}); return; }
  if (m.method !== 'tools/call') throw new Error('Unexpected host request: '+m.method);
  const {name,arguments:a} = m.params; fixture.calls.push({name,args:a});
  if (name === 'list_devices') reply(m.id,result({devices:[deviceId]}));
  else if (name === 'preview_info') reply(m.id,result({previewRecoveryProtocol:1,previewSubscriptionProtocol:1}));
  else if (name === 'preview_start') {
    if (a.deviceId !== deviceId || a.subscriber !== true) throw new Error('Preview must request a subscriber');
    reply(m.id,result({deviceId,sessionId,subscriberId,pollMs:500,previewRecoveryProtocol:1,previewSubscriptionProtocol:1}));
  }
  else if (name === 'preview_stop') {
    if (a.sessionId !== sessionId || a.subscriberId !== subscriberId) throw new Error('Preview must release its own subscription');
    reply(m.id,result({stopped:true}));
  }
  else if (name === 'preview_action') {
    if (a.sessionId !== sessionId || a.subscriberId !== subscriberId) throw new Error('Action must belong to the subscription');
    const nextFrameAfterSeq = fixture.seq; fixture.seq++;
    reply(m.id,result({metrics:{actionMs:1,actionInputMs:1,nextFrameAfterSeq}}));
  } else if (name === 'preview_frame') {
    if (a.sessionId !== sessionId || a.subscriberId !== subscriberId) throw new Error('Frame must belong to the subscription');
    if (a.forceRefresh) { if (fixture.refresh) throw new Error('Concurrent forced refresh'); fixture.refresh={id:m.id,args:a}; }
    else if (fixture.changeOnPreflight && app.contentDocument.getElementById('status').textContent.startsWith('Sending ')) {
      fixture.changeOnPreflight=false; fixture.seq++; fixture.data = fixture.data === normalImage ? recoveredImage : normalImage; reply(m.id,frame(a.afterSeq ?? 0));
    }
    else if (fixture.failNextFrame) {
      fixture.failNextFrame=false;
      reply(m.id,{isError:true,...result({errorCode:'PREVIEW_UNAVAILABLE',stage:'preview_frame',error:'Injected transient frame failure'})});
    } else reply(m.id,frame(a.afterSeq ?? 0));
  } else throw new Error('Unexpected tool: '+name);
});
</script></body></html>`;
const server = createServer((request, response) => {
  if (!['/', '/app'].includes(request.url)) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(request.url === '/app' ? appResource : host);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const app = page.frame({ name: 'preview' });
  assert.ok(app, 'mock host must contain the real built app');
  await app.waitForFunction(() => !document.getElementById('start').disabled);
  await app.locator('#start').click();
  await app.waitForFunction(() => !document.getElementById('nav-home').disabled);
  assert.equal(await app.locator('#stage').evaluate((image) => image.draggable), false);

  // Host transforms must not invalidate pointer coordinates unnoticed.  Exercise
  // separate pages so these checks cannot change the main fixture's action count.
  async function transformedHostGesture(mode) {
    const transformedPage = await context.newPage();
    transformedPage.setDefaultTimeout(10000);
    try {
      await transformedPage.goto(`http://127.0.0.1:${server.address().port}/`);
      const child = transformedPage.frame({ name: 'preview' });
      assert.ok(child);
      await child.waitForFunction(() => !document.getElementById('start').disabled);
      await child.locator('#start').click();
      await child.waitForFunction(() => !document.getElementById('nav-home').disabled);
      if (mode === 'fixed-scale') {
        await transformedPage.locator('#app').evaluate((node) => {
          node.style.transformOrigin = '0 0'; node.style.transform = 'scale(1.25)';
        });
      }
      const innerBefore = await child.locator('#stage').evaluate((node) => {
        const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
      const box = await child.locator('#stage').boundingBox();
      assert.ok(box && box.width > 0 && box.height > 0);
      const start = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.6 };
      await transformedPage.mouse.move(start.x, start.y);
      await transformedPage.mouse.down();
      await transformedPage.mouse.move(start.x + 80, start.y, { steps: 5 });
      if (mode === 'host-move') {
        await transformedPage.locator('#app').evaluate((node) => { node.style.transform = 'translateX(80px)'; });
        const innerAfter = await child.locator('#stage').evaluate((node) => {
          const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
        });
        assert.deepEqual(innerAfter, innerBefore, 'parent movement must not change the child stage rectangle');
        await transformedPage.mouse.move(start.x, start.y, { steps: 5 });
      }
      await transformedPage.mouse.up();
      await transformedPage.waitForFunction(() => fixture.calls.some((call) => call.name === 'preview_action') ||
        document.getElementById('app').contentDocument.getElementById('action-metrics').textContent.includes('canceled'));
      const calls = await transformedPage.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action'));
      if (mode === 'host-move') {
        assert.equal(calls.length, 0, 'host movement during a gesture must cancel before sending input');
        assert.match(await child.locator('#action-metrics').textContent(), /canceled.*input not sent/);
      } else {
        assert.equal(calls.length, 1, 'fixed host scaling must preserve normal swipe input');
        assert.equal(calls[0].args.action, 'swipe');
      }
    } finally { await transformedPage.close(); }
  }
  await transformedHostGesture('fixed-scale');
  await transformedHostGesture('host-move');

  // When zoom clips the image, releasing outside the shell must not tap the hidden portion.
  await app.locator('#zoom-in').click();
  await app.locator('#zoom-in').click();
  const zoomedImage = await app.locator('#stage').boundingBox();
  const shell = await app.locator('#frame-shell').boundingBox();
  const shellClient = await app.locator('#frame-shell').evaluate((node) => ({
    left: node.clientLeft, top: node.clientTop, width: node.clientWidth, height: node.clientHeight
  }));
  assert.ok(zoomedImage && shell);
  const viewportBottom = shell.y + shellClient.top + shellClient.height;
  const clippedX = shell.x + shellClient.left + shellClient.width / 2;
  assert.ok(zoomedImage.y + zoomedImage.height > viewportBottom + 2, 'zoom must clip the bottom of the image');
  assert.ok(clippedX >= zoomedImage.x && clippedX < zoomedImage.x + zoomedImage.width);
  await page.mouse.move(clippedX, viewportBottom - 1);
  await page.mouse.down();
  await page.mouse.move(clippedX, viewportBottom + 1);
  await page.mouse.up();
  await app.waitForFunction(() => document.getElementById('action-metrics').textContent.includes('pointer outside image'));
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 0,
    'a short press released in clipped image content must not send device input');
  await app.locator('#fit').click();

  // Listen without changing the app's gesture handlers. Mouse input below is native.
  await app.evaluate(() => {
    const probe = window.probe = { dragstarts: 0, cancels: 0, trustedUps: 0, samples: 0, gaps: 0, sampling: true };
    document.addEventListener('dragstart', () => probe.dragstarts++);
    document.addEventListener('pointercancel', () => probe.cancels++);
    document.addEventListener('pointerup', (event) => { if (event.isTrusted) probe.trustedUps++; });
    function inspect() {
      if (probe.sampling) {
        const image = document.getElementById('stage');
        const box = image.getBoundingClientRect();
        const style = getComputedStyle(image);
        probe.samples++;
        if (image.hidden || !image.src || !image.complete || !image.naturalWidth || box.width <= 0 || box.height <= 0 || style.display === 'none' || style.visibility === 'hidden') probe.gaps++;
      }
      requestAnimationFrame(inspect);
    }
    requestAnimationFrame(inspect);
  });
  const box = await app.locator('#stage').boundingBox();
  assert.ok(box && box.width > 0 && box.height > 0);
  const point = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y });
  async function assertCompositePixel(label, expected) {
    const image = await page.screenshot({ clip: { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.floor(box.width), height: Math.floor(box.height) } });
    const pixels = await page.evaluate((data) => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
        resolve([[0.15, 0.35], [0.5, 0.35], [0.85, 0.35], [0.15, 0.75], [0.85, 0.75]].map(([x, y]) =>
          [...context.getImageData(Math.floor(x * image.width), Math.floor(y * image.height), 1, 1).data].slice(0, 3)));
      };
      image.onerror = reject; image.src = `data:image/png;base64,${data}`;
    }), image.toString('base64'));
    for (const rgb of pixels) assert.ok(expected.some((color) => color.every((value, index) => Math.abs(value - rgb[index]) <= 2)), `${label}: unexpected composited pixel ${rgb}`);
  }
  const blue = [85, 170, 204], gold = [204, 170, 85];
  await assertCompositePixel('initial frame', [blue]);
  // Calibrate against an obscured compositor output, without changing the source image.
  await app.evaluate(() => {
    const cover = document.createElement('div'); cover.id = 'test-black-cover';
    Object.assign(cover.style, { position: 'absolute', inset: '0', background: '#000', zIndex: '100' });
    document.getElementById('frame-shell').append(cover);
  });
  await assert.rejects(assertCompositePixel('injected black cover', [blue]), /unexpected composited pixel/);
  await app.evaluate(() => document.getElementById('test-black-cover').remove());
  await assertCompositePixel('frame after cover', [blue]);

  // A short press released outside the image must not tap its clamped edge.
  await page.mouse.move(box.x + 1, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x - 2, box.y + box.height * 0.5);
  await page.mouse.up();
  await app.waitForFunction(() => document.getElementById('action-metrics').textContent.includes('pointer outside image'));
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 0,
    'a short press released outside the image must not send device input');

  // A real mouse drag that returns to its origin must not turn into a device tap.
  const returnStart = point(0.25, 0.75), returnFar = point(0.75, 0.75);
  await page.mouse.move(returnStart.x, returnStart.y);
  await page.mouse.down();
  await page.mouse.move(returnFar.x, returnFar.y, { steps: 6 });
  await page.mouse.move(returnStart.x, returnStart.y, { steps: 6 });
  await page.mouse.up();
  await app.waitForFunction(() => document.getElementById('action-metrics').textContent.includes('drag returned near start'));
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 0,
    'returning to the origin must not send a device action');

  const click = point(0.5, 0.5);
  await page.mouse.click(click.x, click.y);
  await page.waitForFunction(() => fixture.calls.filter((call) => call.name === 'preview_action').length === 1);
  await app.waitForFunction(() => !document.getElementById('nav-home').disabled);
  let actions = await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action'));
  assert.equal(actions[0].args.action, 'tap');
  assert.equal(actions[0].args.x, 400);
  assert.equal(actions[0].args.y, 800);
  await assertCompositePixel('after click', [blue]);

  const from = point(0.25, 0.75), to = point(0.75, 0.75);
  async function drag() {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await assertCompositePixel('drag held', [blue]);
    await page.mouse.move(to.x, to.y, { steps: 12 });
    await assertCompositePixel('drag moved', [blue]);
    await page.mouse.up();
  }
  await drag();
  await page.waitForFunction(() => fixture.calls.filter((call) => call.name === 'preview_action').length === 2);
  await app.waitForFunction(() => !document.getElementById('nav-home').disabled);
  actions = await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action'));
  assert.equal(actions[1].args.action, 'swipe');
  assert.equal(actions[1].args.x, 200);
  assert.equal(actions[1].args.toX, 600);
  await assertCompositePixel('after drag', [blue]);
  const events = await app.evaluate(() => ({ ...probe }));
  assert.equal(events.dragstarts, 0, 'preview image must not start a native browser drag');
  assert.equal(events.cancels, 0, 'native image drag must not cancel the gesture');
  assert.ok(events.trustedUps >= 3, 'the test must exercise trusted browser pointer events');

  // A transient frame error keeps the old image until a confirmed fresh frame.
  const oldSource = await app.locator('#stage').getAttribute('src');
  await page.evaluate(() => { fixture.failNextFrame = true; });
  await page.waitForFunction(() => fixture.refresh !== null);
  await app.locator('#stale-notice').waitFor({ state: 'visible' });
  assert.equal(await app.locator('#stage').getAttribute('src'), oldSource);
  assert.equal(await app.locator('#stage').isVisible(), true);
  await assertCompositePixel('recovery pending', [blue]);
  assert.equal(await app.locator('#nav-home').isEnabled(), false);
  assert.equal(await app.locator('#build').isEnabled(), false);
  assert.equal(await app.locator('#retry-frame').isVisible(), false);
  const refresh = await page.evaluate(() => fixture.refresh.args);
  assert.equal(refresh.forceRefresh, true);
  assert.equal(refresh.deviceId, 'browser-test-device');
  assert.equal(refresh.sessionId, 'browser-test-session');
  assert.equal(refresh.subscriberId, 'browser-test-subscriber');
  assert.ok(Number.isInteger(refresh.afterSeq) && refresh.afterSeq > 0);
  await page.mouse.click(click.x, click.y);
  await drag();
  await app.waitForFunction(() => probe.samples >= 4);
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 2, 'stale image cannot send another action');

  await page.evaluate(() => fixture.finishRefresh(true));
  await app.locator('#retry-frame').waitFor({ state: 'visible' });
  assert.equal(await app.locator('#stage').getAttribute('src'), oldSource);
  await assertCompositePixel('recovery failed', [blue]);
  assert.equal(await app.locator('#nav-home').isEnabled(), false);
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_frame' && call.args.forceRefresh).length), 1, 'failed recovery must not retry automatically');
  await app.locator('#retry-frame').click();
  await page.waitForFunction(() => fixture.refresh !== null);
  await page.evaluate(() => fixture.finishRefresh());
  await app.waitForFunction(() => !document.getElementById('nav-home').disabled);
  assert.notEqual(await app.locator('#stage').getAttribute('src'), oldSource);
  assert.equal(await app.locator('#stage').evaluate((image) => image.draggable), false);
  assert.equal(await app.locator('#stale-notice').isVisible(), false);
  await assertCompositePixel('recovery completed', [gold]);
  const visibility = await app.evaluate(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    probe.sampling = false;
    return { samples: probe.samples, gaps: probe.gaps };
  });
  assert.ok(visibility.samples >= 4);
  assert.equal(visibility.gaps, 0, 'rendered animation frames must retain a decoded visible image during recovery');
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 2, 'recovery must not replay actions');
  // A black device frame is legitimate content, not a missing decoded image.
  const recoveredSource = await app.locator('#stage').getAttribute('src');
  await page.evaluate(() => fixture.showBlack());
  await app.waitForFunction((previous) => document.getElementById('stage').src !== previous, recoveredSource);
  assert.equal(await app.locator('#stage').isVisible(), true, 'a legitimate black frame remains visible');
  await assertCompositePixel('legitimate black frame', [[0, 0, 0]]);
  const blackSource = await app.locator('#stage').getAttribute('src');
  await page.evaluate(() => fixture.showRecovered());
  await app.waitForFunction((previous) => document.getElementById('stage').src !== previous, blackSource);
  await assertCompositePixel('after legitimate black frame', [gold]);
  // Fullscreen exit remains reachable while a zoomed image is scrolled and must not send input.
  await app.locator('#zoom-in').click();
  await app.locator('#zoom-in').click();
  await app.locator('#fullscreen').click();
  await app.waitForFunction(() => document.fullscreenElement === document.getElementById('frame-shell'));
  const exit = app.locator('#exit-fullscreen');
  await exit.waitFor({ state: 'visible' });
  assert.equal(await exit.isVisible(), true);
  const exitBefore = await exit.boundingBox();
  const scrolled = await app.locator('#frame-shell').evaluate((node) => { node.scrollTop = node.scrollHeight; return node.scrollTop; });
  assert.ok(scrolled > 0, 'zoomed fullscreen image must actually scroll');
  assert.deepEqual(await exit.boundingBox(), exitBefore, 'fullscreen exit must stay visible while scrolling');
  await exit.click();
  await app.waitForFunction(() => !document.fullscreenElement);
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 2, 'fullscreen exit must not send a device action');
  await app.locator('#fit').click();
  // Hidden diagnostics must not occupy space or move the image in a narrow panel.
  await page.setViewportSize({ width: 390, height: 500 });
  assert.equal(await app.locator('.metrics').isVisible(), false, 'bottom metrics and diagnostics must stay hidden');
  await app.locator('#stage').scrollIntoViewIfNeeded();
  const narrowBefore = await app.locator('#stage').boundingBox();
  assert.ok(narrowBefore && narrowBefore.width > 0 && narrowBefore.height > 0);
  await page.mouse.click(narrowBefore.x + narrowBefore.width / 2, narrowBefore.y + narrowBefore.height / 2);
  await page.waitForFunction(() => fixture.calls.filter((call) => call.name === 'preview_action').length === 3);
  await app.waitForFunction(() => !document.getElementById('nav-home').disabled);
  const narrowAfter = await app.locator('#stage').boundingBox();
  assert.deepEqual(narrowAfter, narrowBefore, 'diagnostic updates must not shift the target image');
  assert.match(await app.locator('#action-summary').textContent(), /tap: n=2/);
  for (const viewport of [{ width: 320, height: 400 }, { width: 390, height: 500 }, { width: 480, height: 580 }, { width: 900, height: 900 }]) {
    await page.setViewportSize(viewport);
    await app.locator('#stage').scrollIntoViewIfNeeded();
    const before = await app.locator('#stage').boundingBox();
    const longStatus = 'Preview unavailable: '.repeat(20);
    const status = await app.locator('#status').evaluate((node, message) => {
      node.textContent = message;
      return { text: node.textContent, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, tabIndex: node.tabIndex };
    }, longStatus);
    assert.equal(status.text, longStatus, 'long status remains available to assistive technology');
    assert.equal(status.tabIndex, 0, 'long status is keyboard reachable');
    assert.ok(status.scrollHeight > status.clientHeight, 'long status remains scrollable');
    assert.deepEqual(await app.locator('#stage').boundingBox(), before, 'status changes must not move the device image');
    await app.locator('#status').focus();
    await page.keyboard.press('End');
    await app.waitForFunction((expected) => {
      const status = document.getElementById('status');
      return status.textContent === expected && status.scrollTop > 0;
    }, longStatus);
    assert.ok(await app.locator('#status').evaluate((node) => node.scrollTop > 0), 'keyboard can scroll the full status');
    assert.equal(await app.locator('#status').textContent(), longStatus, 'status text must not be replaced while checking keyboard access');
    assert.equal(await app.locator('.metrics').isVisible(), false, 'bottom metrics remain hidden at every viewport');
    for (const id of ['devices', 'refresh', 'build', 'start', 'stop', 'nav-back', 'nav-home', 'fit', 'zoom-out', 'zoom-in', 'fullscreen']) {
      const control = app.locator(`#${id}`);
      assert.equal(await control.isVisible(), true, `${id} must remain available at ${viewport.width}px`);
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, `${id} must fit horizontally at ${viewport.width}px`);
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height, `${id} must be reachable vertically at ${viewport.height}px`);
    }
  }
  // Explicit coordinates provide a semantic alternative; they are not mouse input.
  await app.locator('#precise-control > summary').click();
  const startX = app.getByLabel('Start X (%)'), startY = app.getByLabel('Start Y (%)');
  const endX = app.getByLabel('End X (%)'), endY = app.getByLabel('End Y (%)');
  const bind = app.getByRole('button', { name: 'Bind displayed frame' });
  const tap = app.getByRole('button', { name: 'Send precise tap' });
  const swipe = app.getByRole('button', { name: 'Send precise swipe' });
  await startX.fill('25'); await startY.fill('75');
  await endX.fill('75'); await endY.fill('75');
  await bind.click(); await tap.click();
  await page.waitForFunction(() => fixture.calls.filter((call) => call.name === 'preview_action').length === 4);
  await app.waitForFunction(() => !document.getElementById('nav-home').disabled);
  actions = await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action'));
  assert.deepEqual([actions[3].args.action, actions[3].args.x, actions[3].args.y], ['tap', 200, 1200]);
  assert.match(await app.locator('#action-metrics').textContent(), /request to frame commit/);
  assert.equal(await tap.isEnabled(), false, 'each action requires a fresh frame binding');
  await bind.click(); await swipe.click();
  await page.waitForFunction(() => fixture.calls.filter((call) => call.name === 'preview_action').length === 5);
  await app.waitForFunction(() => !document.getElementById('nav-home').disabled);
  actions = await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action'));
  assert.deepEqual([actions[4].args.action, actions[4].args.x, actions[4].args.y, actions[4].args.toX, actions[4].args.toY], ['swipe', 200, 1200, 600, 1200]);
  await endX.fill('25'); await bind.click();
  assert.equal(await swipe.isEnabled(), false, 'identical coordinates cannot send a swipe');
  assert.match(await app.locator('#status').textContent(), /same pixel/);
  await endX.fill('25.01'); await bind.click();
  assert.equal(await swipe.isEnabled(), false, 'different percentages mapping to the same pixel cannot send a swipe');
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 5);
  await endX.fill('75');
  await startX.fill('100'); await bind.click();
  assert.equal(await tap.isEnabled(), false, '100% is outside the half-open image bounds');
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 5);
  await startX.fill('25'); await bind.click();
  await page.evaluate(() => { fixture.changeOnPreflight = true; });
  await tap.click();
  await app.waitForFunction(() => document.getElementById('status').textContent.includes('Preview changed'));
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 5, 'changed frame must prevent sending');
  await bind.click();
  await page.setViewportSize({ width: 800, height: 800 });
  await tap.click();
  await app.waitForFunction(() => document.getElementById('status').textContent.includes('Preview changed'));
  assert.equal(JSON.parse(await app.locator('#status').getAttribute('data-gesture-diagnostic')).reason, 'frame_or_display_geometry');
  const lastCancellation = JSON.parse(await app.locator('#status').getAttribute('data-last-cancellation'));
  assert.deepEqual(lastCancellation, { action: 'tap', reason: 'frame_or_display_geometry', failedChecks: ['display_box'] });
  assert.equal(await page.evaluate(() => fixture.calls.filter((call) => call.name === 'preview_action').length), 5, 'changed display geometry must prevent sending');
  await bind.click();
  await page.evaluate(() => { fixture.failNextFrame = true; });
  await page.waitForFunction(() => fixture.refresh !== null);
  await page.evaluate(() => fixture.finishRefresh());
  await app.waitForFunction(() => !document.getElementById('nav-home').disabled);
  assert.equal(await tap.isEnabled(), false, 'recovery must invalidate the previous binding');
  await bind.click();
  await app.locator('#stop').click();
  assert.equal(await app.locator('#status').getAttribute('data-last-cancellation'), '', 'stopping the session clears retained diagnostics');
  assert.equal(await tap.isEnabled(), false, 'stopped preview cannot send');
  assert.equal(await swipe.isEnabled(), false, 'stopped preview cannot send');
  assert.deepEqual(errors, [], 'built resource must run without browser errors');
  console.log(`app browser: ok (Edge; ${visibility.samples} visible-frame checks; synthetic device only)`);
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

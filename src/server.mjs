import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { WebSocketServer } from 'ws';
import { createDeviceAdapter } from './device.mjs';
import { createFrameSource } from './frame-source.mjs';
import { buildAndRun } from './build.mjs';
import { toDiagnostic } from './diagnostics.mjs';

const host = process.env.HARMONY_PREVIEW_HOST ?? '127.0.0.1';
const port = Number(process.env.HARMONY_PREVIEW_PORT ?? 4100);

const previewPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HarmonyOS Preview</title>
<style>
  :root{color-scheme:dark;font:14px system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;height:100vh;height:100dvh;min-height:0;background:#0c0f14;color:#f4f6fa;display:flex;flex-direction:column}
  aside{flex:none;display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px 18px;background:#151a22;border-bottom:1px solid #2a303b;box-shadow:0 4px 18px #0003}h1{font-size:18px;margin:0}.brand{display:flex;align-items:center;gap:12px;margin-right:8px}.brand p{margin:0}p{color:#aeb8c8;line-height:1.5}#status{color:#75e0aa}.device{display:flex;align-items:center;gap:8px;color:#aeb8c8}.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}select,button{min-height:32px;border:1px solid #3b4554;border-radius:6px;background:#202733;color:#f4f6fa;padding:6px 10px}button{cursor:pointer}button:hover:not(:disabled){background:#2b3544}button:disabled{opacity:.55;cursor:default}
  main{flex:1;display:flex;min-width:0;min-height:0;padding:12px;overflow:auto;background:#171d26}#stage{display:block;flex:none;max-width:100%;max-height:100%;width:auto;height:auto;margin:auto;background:#000;cursor:crosshair}#stage[hidden]{display:none}
  @media (max-width:720px){aside{align-items:flex-start;gap:10px;padding:12px}.brand{width:100%;justify-content:space-between}.device{flex:1}.actions{width:100%}main{padding:8px}}
</style></head><body><aside><div class="brand"><h1>HarmonyOS Preview</h1><p id="status">Connecting…</p></div><label class="device">设备 / 型号<select id="devices"><option value="">No device selected</option></select></label><div class="actions"><button id="refresh">Refresh devices</button><button id="build">Build · Install · Run</button><button id="shot">Capture screenshot</button><button id="start">Start preview</button><button id="stop">Stop preview</button><button id="back" type="button" title="Back" aria-label="Back" disabled>返回</button><button id="home" type="button" title="Home" aria-label="Home" disabled>主页</button></div></aside><main><img id="stage" alt="HarmonyOS preview frame" hidden></main>
<script>
const stage=document.querySelector('#stage');
const status=document.querySelector('#status');
const devices=document.querySelector('#devices');
const backButton=document.querySelector('#back'),homeButton=document.querySelector('#home');
const requestedDeviceId=new URLSearchParams(location.search).get('deviceId')||'';
let deviceId=requestedDeviceId,frameDeviceId='',nextFrameMeta=null,autoStart=Boolean(requestedDeviceId);
let generation=0,imageSequence=0,nextActionId=0,acceptFrames=false,recovering=false,awaitingCapture=false,pendingGesture=null,gestureStart=null,longTimer=null,longFired=false;
const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/preview');
socket.binaryType='blob';

function cancelGesture(){clearTimeout(longTimer);longTimer=null;gestureStart=null;longFired=false;}
function invalidateFrame(keepVisible=false){
  generation++;imageSequence++;frameDeviceId='';nextFrameMeta=null;pendingGesture=null;cancelGesture();
  stage.onload=null;stage.onerror=null;stage.style.pointerEvents='none';updateNavigation();
  if(!keepVisible){
    stage.hidden=true;
    const old=stage.src;stage.removeAttribute('src');
    if(old.startsWith('blob:'))URL.revokeObjectURL(old);
  }
}
function send(type,data={}){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type,...data}));}
function requestFrame(type='screenshot',keepVisible=false){
  invalidateFrame(keepVisible);recovering=false;awaitingCapture=type==='screenshot';acceptFrames=Boolean(deviceId)&&socket.readyState===WebSocket.OPEN;
  if(acceptFrames)send(type,{deviceId});
}
function canInteract(){return acceptFrames&&deviceId&&frameDeviceId===deviceId&&!pendingGesture&&socket.readyState===WebSocket.OPEN&&stage.naturalWidth>0&&stage.naturalHeight>0;}
function updateNavigation(){backButton.disabled=homeButton.disabled=!canInteract();}
invalidateFrame();
socket.onopen=()=>{status.textContent='Connected';send('device-list');};
socket.onclose=()=>{acceptFrames=false;recovering=false;invalidateFrame();status.textContent='Disconnected';};
socket.onerror=()=>{acceptFrames=false;recovering=false;invalidateFrame();status.textContent='Connection error';};
socket.onmessage=event=>{
  if(typeof event.data==='string'){
    const message=JSON.parse(event.data);
    if(message.type==='status'||message.type==='run-status')status.textContent=message.text;
    if(message.type==='frame-meta')nextFrameMeta=message;
    if(message.type==='devices'){
      const previous=deviceId;
      const keepSelection=previous&&(acceptFrames||recovering||pendingGesture);
      const options=message.devices.map(id=>new Option(id,id));
      if(keepSelection&&!message.devices.includes(previous))options.push(new Option(previous+' (disconnected)',previous));
      devices.replaceChildren(...options);
      deviceId=keepSelection?previous:(message.devices.includes(previous)?previous:(message.devices.includes(requestedDeviceId)?requestedDeviceId:(message.devices[0]??'')));
      devices.value=deviceId;
      if(deviceId!==previous){acceptFrames=false;recovering=false;invalidateFrame();}
      if(!deviceId)status.textContent='No device connected';
      else if(autoStart){autoStart=false;requestFrame('preview-start');}
    }
    if(['tap-ack','swipe-ack','long-press-ack','key-event-ack','input-text-ack'].includes(message.type)){
      if(pendingGesture&&message.type===pendingGesture.type+'-ack'&&message.actionId===pendingGesture.actionId&&pendingGesture.deviceId===deviceId&&pendingGesture.generation===generation&&message.deviceId===deviceId){
        const keepVisible=pendingGesture.keepVisible;
        status.textContent=keepVisible?'Action sent; updating preview…':message.type.replace('-ack','')+' complete';requestFrame('screenshot',keepVisible);
      }
    }
    if(message.type==='preview-status'&&(!message.deviceId||message.deviceId===deviceId)){
      if(!message.running||message.reconnecting){
        recovering=Boolean(message.reconnecting&&(acceptFrames||recovering));acceptFrames=false;invalidateFrame();
      }else if(message.reconnecting===false&&recovering){recovering=false;acceptFrames=true;}
      status.textContent=message.running?(message.reconnecting?'Reconnecting':'Preview running'):(message.reconnecting?(message.reason==='device-disconnected'?'Device disconnected; retrying':'Capture failed; retrying'):'Preview stopped');
    }
    if(message.type==='error'){
      if(message.actionId!==undefined&&(!pendingGesture||pendingGesture.type!==message.actionType||pendingGesture.actionId!==message.actionId||message.deviceId!==deviceId))return;
      acceptFrames=false;recovering=false;invalidateFrame();status.textContent=message.error;
    }
    return;
  }
  const meta=nextFrameMeta;nextFrameMeta=null;
  if(!acceptFrames||!meta||meta.deviceId!==deviceId||(awaitingCapture&&meta.source!=='capture'))return;
  const expectedGeneration=generation,sequence=++imageSequence;
  const source=URL.createObjectURL(new Blob([event.data],{type:meta.mimeType}));
  const image=new Image();
  const current=()=>acceptFrames&&generation===expectedGeneration&&sequence===imageSequence&&meta.deviceId===deviceId&&socket.readyState===WebSocket.OPEN;
  image.onload=()=>{
    if(!current()){URL.revokeObjectURL(source);return;}
    const old=stage.src;
    stage.onload=()=>{if(current()&&stage.src===source){frameDeviceId=meta.deviceId;awaitingCapture=false;stage.style.pointerEvents='auto';stage.hidden=false;updateNavigation();}};
    stage.onerror=()=>{if(current()){acceptFrames=false;recovering=false;invalidateFrame();status.textContent='Preview image could not be loaded';}};
    stage.src=source;
    if(old.startsWith('blob:'))URL.revokeObjectURL(old);
  };
  image.onerror=()=>{URL.revokeObjectURL(source);if(current()){acceptFrames=false;recovering=false;invalidateFrame();status.textContent='Preview image could not be loaded';}};
  image.src=source;
};
document.querySelector('#refresh').onclick=()=>send('device-list');
document.querySelector('#build').onclick=()=>{if(deviceId){invalidateFrame();send('build-run',{deviceId});}};
document.querySelector('#shot').onclick=()=>requestFrame();
document.querySelector('#start').onclick=()=>requestFrame('preview-start');
document.querySelector('#stop').onclick=()=>{acceptFrames=false;recovering=false;invalidateFrame();send('preview-stop');};
devices.onchange=()=>{deviceId=devices.value;autoStart=false;acceptFrames=false;recovering=false;invalidateFrame();send('preview-stop');};
const point=event=>{const box=stage.getBoundingClientRect();return {x:Math.min(stage.naturalWidth-1,Math.max(0,Math.round((event.clientX-box.left)*stage.naturalWidth/box.width))),y:Math.min(stage.naturalHeight-1,Math.max(0,Math.round((event.clientY-box.top)*stage.naturalHeight/box.height)))}};
function unchangedGestureGeometry(){
  if(!gestureStart)return false;
  const box=stage.getBoundingClientRect(),geometry=gestureStart.geometry;
  if(stage.naturalWidth===geometry.width&&stage.naturalHeight===geometry.height&&box.width===geometry.displayWidth&&box.height===geometry.displayHeight&&box.left===geometry.left&&box.top===geometry.top)return true;
  acceptFrames=false;recovering=false;invalidateFrame();status.textContent='Screen geometry changed; capture a new screenshot';return false;
}
const sendGesture=(type,data)=>{
  if(!canInteract()){status.textContent='Capture or start preview for the selected device first';return;}
  const actionId=String(++nextActionId);
  invalidateFrame(true);acceptFrames=false;pendingGesture={deviceId,generation,keepVisible:true,type,actionId};
  status.textContent='Sending '+(data.key||type)+'…';
  send(type,{deviceId,...data,actionId});
};
backButton.onclick=()=>sendGesture('key-event',{key:'Back'});
homeButton.onclick=()=>sendGesture('key-event',{key:'Home'});
stage.onpointerdown=event=>{
  if(!canInteract())return;
  const box=stage.getBoundingClientRect();
  gestureStart={...point(event),geometry:{width:stage.naturalWidth,height:stage.naturalHeight,displayWidth:box.width,displayHeight:box.height,left:box.left,top:box.top}};longFired=false;
  longTimer=setTimeout(()=>{if(!gestureStart||!canInteract()||!unchangedGestureGeometry())return;const {x,y}=gestureStart;longFired=true;status.textContent='Long pressing '+x+','+y;sendGesture('long-press',{x,y});},600);
  stage.setPointerCapture?.(event.pointerId);
};
stage.onpointerup=event=>{
  clearTimeout(longTimer);
  if(!gestureStart||longFired||!canInteract()||!unchangedGestureGeometry()){gestureStart=null;return;}
  const start=gestureStart,end=point(event);gestureStart=null;
  const moved=Math.hypot(end.x-start.x,end.y-start.y);
  if(moved>12)sendGesture('swipe',{fromX:start.x,fromY:start.y,toX:end.x,toY:end.y});else sendGesture('tap',end);
};
stage.onpointercancel=cancelGesture;
</script></body></html>`;

const staticFrame = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920"><rect width="1080" height="1920" fill="#10151c"/><rect x="48" y="70" width="984" height="1780" rx="42" fill="#1b2430"/><text x="540" y="850" text-anchor="middle" fill="#f4f6fa" font-size="56" font-family="system-ui">HarmonyOS Preview</text><text x="540" y="940" text-anchor="middle" fill="#9eabbc" font-size="34" font-family="system-ui">Static frame</text><circle cx="540" cy="1070" r="54" fill="#4f7cff"/></svg>`);
const configuredPollMs = Number(process.env.HARMONY_PREVIEW_POLL_MS ?? 500);
const pollMs = Number.isFinite(configuredPollMs) ? Math.max(100, Math.floor(configuredPollMs)) : 500;
const configuredBackoffMaxMs = Number(process.env.HARMONY_PREVIEW_BACKOFF_MAX_MS ?? 10000);
const backoffMaxMs = Number.isFinite(configuredBackoffMaxMs) ? Math.max(pollMs, Math.floor(configuredBackoffMaxMs)) : Math.max(pollMs, 10000);
const maxBodyBytes = 1024 * 1024;
const projectPath = process.env.HARMONY_PROJECT;

export function createPreviewServer({ deviceAdapter = createDeviceAdapter(), frameSource = createFrameSource({ deviceAdapter }),
  runDeviceAction = (_deviceId, operation, isLive) => {
    if (!isLive()) throw new Error('Client disconnected before device input');
    return operation();
  } } = {}) {
  const server = createServer((request, response) => {
    if (!isAllowedOrigin(request.headers.origin, server.address()?.port ?? port)) {
      response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'origin_not_allowed' }));
      return;
    }
    if ((request.url ?? '/').split('?', 1)[0] === '/') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(previewPage);
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ name: 'harmonyos-preview', status: 'ok' }));
      return;
    }
    if (request.url === '/api/devices') {
      const startedAt = performance.now();
      deviceAdapter.listTargets().then((devices) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ devices }));
      }).catch((error) => {
        response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(toDiagnostic(error, { errorCode: 'HDC_FAILED', stage: 'list_devices', elapsedMs: performance.now() - startedAt })));
      });
      return;
    }
    if (request.url === '/api/capabilities') {
      Promise.resolve(typeof frameSource.getCapabilities === 'function'
        ? frameSource.getCapabilities({})
        : frameSource.capabilities ?? { selected: frameSource.name, streaming: Boolean(frameSource.supportsStreaming) })
        .then((frameSources) => {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({
            name: 'harmonyos-preview',
            version: 1,
            frameSources,
            http: ['GET /api/devices', 'POST /api/capture', 'POST /api/tap'],
            websocket: 'ws://127.0.0.1:' + (server.address()?.port ?? port) + '/preview',
            messages: ['device-list', 'screenshot', 'tap', 'swipe', 'long-press', 'key-event', 'input-text', 'preview-start', 'preview-stop', 'build-run']
          }));
        }).catch((error) => {
          response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify(toDiagnostic(error, { errorCode: 'FRAME_SOURCE_FAILED', stage: 'capabilities' })));
        });
      return;
    }
    if (request.url === '/api/capture' || request.url === '/api/tap') {
      if (request.method !== 'POST') {
        response.writeHead(405, { allow: 'POST' });
        response.end();
        return;
      }
      const startedAt = performance.now();
      let deviceId = null;
      readJson(request).then(async (body) => {
        deviceId = typeof body?.deviceId === 'string' ? body.deviceId : null;
        const result = request.url === '/api/capture'
          ? await deviceAdapter.capture(captureOptions(body))
          : await runDeviceAction(body?.deviceId, () => deviceAdapter.tap(body),
            () => !request.aborted && !response.destroyed && !response.writableEnded);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify(request.url === '/api/capture'
          ? { mimeType: result.mimeType, data: result.data.toString('base64') }
          : result));
      }).catch((error) => sendJsonError(response, error, { deviceId, stage: request.url === '/api/capture' ? 'capture' : 'tap',
        errorCode: request.url === '/api/capture' ? 'CAPTURE_FAILED' : 'ACTION_FAILED', elapsedMs: performance.now() - startedAt }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  const sockets = new WebSocketServer({
    server,
    path: '/preview',
    verifyClient: ({ origin }) => isAllowedOrigin(origin, server.address()?.port ?? port)
  });
  const sessions = new Map();
  sockets.on('connection', (socket) => {
    const state = { generation: 0, deviceId: null };
    socket.send(JSON.stringify({ type: 'status', text: 'Preview connected' }));
    socket.send(JSON.stringify({ type: 'frame-meta', mimeType: 'image/svg+xml', width: 1080, height: 1920 }));
    socket.send(staticFrame);
    socket.on('message', (message) => {
      const startedAt = performance.now();
      const context = { stage: 'websocket', deviceId: state.deviceId };
      handleSocketMessage(socket, deviceAdapter, frameSource, sessions, state, message, context, runDeviceAction).catch((error) => {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'error', ...toDiagnostic(error,
          { errorCode: 'REQUEST_FAILED', ...context, elapsedMs: performance.now() - startedAt }),
          ...(context.actionId === undefined ? {} : { actionType: context.actionType, actionId: context.actionId }) }));
      });
    });
    socket.on('close', () => stopPolling(socket, sessions, state));
  });
  server.shutdown = () => {
    for (const socket of sockets.clients) { stopPolling(socket, sessions); socket.terminate(); }
    server.closeAllConnections();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return server;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        request.resume();
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        return;
      }
      body += chunk;
    });
    request.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('invalid_json')); }
    });
    request.on('error', reject);
  });
}

function sendJsonError(response, error, context) {
  if (response.headersSent) return;
  response.writeHead(error.statusCode ?? 400, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(toDiagnostic(error, context)));
}

function isAllowedOrigin(origin, actualPort) {
  if (!origin) return true;
  const configured = process.env.HARMONY_PREVIEW_ORIGIN;
  if (configured) return origin === configured;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      Number(parsed.port || 80) === actualPort;
  } catch {
    return false;
  }
}

function captureOptions(value, allowedKeys = ['deviceId']) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('capture requires an object');
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unexpected.length) throw new Error(`unsupported capture parameter: ${unexpected.join(', ')}`);
  if (typeof value.deviceId !== 'string' || !value.deviceId.trim()) throw new Error('deviceId is required');
  return { deviceId: value.deviceId };
}

async function handleSocketMessage(socket, deviceAdapter, frameSource, sessions, state, message, context, runDeviceAction) {
  let action;
  try { action = JSON.parse(message.toString()); } catch { throw new Error('invalid_message'); }
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('invalid_message');
  context.stage = typeof action.type === 'string' ? action.type : 'websocket';
  context.deviceId = typeof action.deviceId === 'string' ? action.deviceId : state.deviceId;
  if (['tap', 'swipe', 'long-press', 'key-event', 'input-text'].includes(action.type) && action.actionId !== undefined) {
    if (typeof action.actionId !== 'string' || !action.actionId.trim() || action.actionId.length > 128) throw new Error('actionId must be a non-empty string of at most 128 characters');
    context.actionId = action.actionId;
    context.actionType = action.type;
  }
  const actionId = action.actionId === undefined ? {} : { actionId: action.actionId };
  const runInput = (operation) => runDeviceAction(action.deviceId, operation, () => socket.readyState === 1);
  if (action.type === 'build-run') {
    const result = await runInput(() => buildAndRun(deviceAdapter, { projectPath, deviceId: action.deviceId },
      (text) => { if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'run-status', text })); }));
    if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'run-status', text: 'Running', ...result }));
    return;
  }
  if (action.type === 'tap') {
    if (!action.deviceId) throw new Error('deviceId is required');
    socket.send(JSON.stringify({ type: 'tap-ack', ...(await runInput(() => deviceAdapter.tap(action))), ...actionId }));
    return;
  }
  if (action.type === 'swipe') {
    socket.send(JSON.stringify({ type: 'swipe-ack', ...(await runInput(() => deviceAdapter.swipe(action))), ...actionId }));
    return;
  }
  if (action.type === 'long-press') {
    socket.send(JSON.stringify({ type: 'long-press-ack', ...(await runInput(() => deviceAdapter.longPress(action))), ...actionId }));
    return;
  }
  if (action.type === 'key-event') {
    socket.send(JSON.stringify({ type: 'key-event-ack', ...(await runInput(() => deviceAdapter.keyEvent(action))), ...actionId }));
    return;
  }
  if (action.type === 'input-text') {
    socket.send(JSON.stringify({ type: 'input-text-ack', ...(await runInput(() => deviceAdapter.inputText(action))), ...actionId }));
    return;
  }
  if (action.type === 'device-list') {
    socket.send(JSON.stringify({ type: 'devices', devices: await deviceAdapter.listTargets() }));
    return;
  }
  if (action.type === 'screenshot') {
    const options = captureOptions(action, ['type', 'deviceId']);
    if (state.deviceId !== options.deviceId) {
      stopPolling(socket, sessions, state);
      state.deviceId = options.deviceId;
    }
    const generation = state.generation;
    try {
      const frame = await deviceAdapter.capture(options);
      if (state.generation === generation) sendFrame(socket, frame, options.deviceId);
    } catch (error) {
      if (state.generation === generation) throw error;
    }
    return;
  }
  if (action.type === 'preview-start') {
    const { deviceId } = captureOptions(action, ['type', 'deviceId']);
    startPolling(socket, deviceAdapter, frameSource, sessions, state, deviceId);
    socket.send(JSON.stringify({ type: 'preview-status', running: true, deviceId: action.deviceId, pollMs, frameSource: frameSource.name }));
    return;
  }
  if (action.type === 'preview-stop') {
    stopPolling(socket, sessions, state);
    socket.send(JSON.stringify({ type: 'preview-status', running: false }));
    return;
  }
  if (action.type === 'preview-pause') {
    pausePolling(socket, sessions, state);
    socket.send(JSON.stringify({ type: 'preview-status', running: false, paused: true, deviceId: state.deviceId }));
    return;
  }
  if (action.type === 'preview-resume') {
    const { deviceId } = captureOptions(action, ['type', 'deviceId']);
    startPolling(socket, deviceAdapter, frameSource, sessions, state, deviceId);
    socket.send(JSON.stringify({ type: 'preview-status', running: true, paused: false, deviceId, pollMs, frameSource: frameSource.name }));
    return;
  }
  if (action.type === 'preview-refresh') {
    const session = sessions.get(socket);
    if (!session || session.deviceId !== action.deviceId) throw new Error('Preview is not running for this device');
    session.actionPaused = false;
    session.requestNow?.(action.requestId);
    return;
  }
  if (action.type === 'preview-action-start') {
    const session = sessions.get(socket);
    if (!session || session.deviceId !== action.deviceId) throw new Error('Preview is not running for this device');
    session.actionPaused = true;
    session.captureController?.abort();
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    socket.send(JSON.stringify({ type: 'preview-action-ready', actionId: action.actionId }));
  }
}

function sendFrame(socket, frame, deviceId, session, source = 'capture', force = false, metrics = null, refreshIds = []) {
  if (socket.readyState !== 1) return;
  const hash = createHash('sha1').update(frame.data).digest('hex');
  if (session?.lastHash === hash && !force) return false;
  if (session) session.lastHash = hash;
  const metadata = Object.fromEntries(['width', 'height', 'deviceWidth', 'deviceHeight', 'scaled', 'requestedWidth', 'requestedHeight', 'orientationChanged', 'rotation']
    .filter((key) => frame[key] !== undefined || metrics?.[key] !== undefined)
    .map((key) => [key, frame[key] ?? metrics?.[key]]));
  metadata.frameId = frame.frameId ?? metrics?.frameId ?? randomUUID();
  metadata.capturedAt = frame.capturedAt ?? metrics?.capturedAt ?? new Date().toISOString();
  socket.send(JSON.stringify({ type: 'frame-meta', mimeType: frame.mimeType, deviceId, source, ...metadata, ...(metrics ? { metrics } : {}), ...(refreshIds.length ? { refreshIds } : {}) }));
  socket.send(frame.data);
  return true;
}

function startPolling(socket, deviceAdapter, frameSource, sessions, state, deviceId) {
  stopPolling(socket, sessions, state);
  frameSource.reset?.({ deviceId });
  state.deviceId = deviceId;
  const session = { stopped: false, timer: null, connected: true, lastHash: null, failures: 0,
    deviceId, inFlight: false, refreshRequested: false, forceNext: false, requestNow: null, lastMetrics: null,
    captureController: null, actionPaused: false, refreshIds: new Set() };
  sessions.set(socket, session);
  const current = () => !session.stopped && sessions.get(socket) === session && socket.readyState === 1;
  const poll = async () => {
    if (!current()) return;
    if (session.inFlight) {
      session.refreshRequested = true;
      return;
    }
    session.inFlight = true;
    const force = session.forceNext;
    const refreshIds = [...session.refreshIds];
    session.forceNext = false;
    session.refreshIds.clear();
    const startedAt = performance.now();
    let nextDelay = pollMs;
    const captureController = new AbortController();
    session.captureController = captureController;
    try {
      const freshSnapshot = refreshIds.length > 0 && frameSource.supportsFreshCapture === true;
      const sample = await frameSource.capture({ deviceId, signal: captureController.signal, ...(freshSnapshot ? { freshSnapshot: true } : {}) });
      if (!current()) return;
      if (captureController.signal.aborted) throw new Error('Preview capture cancelled');
      const { frame, metrics } = sample;
      session.failures = 0;
      if (!session.connected) {
        session.connected = true;
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'preview-status', running: true, deviceId, reconnecting: false }));
      }
      const changed = sendFrame(socket, frame, deviceId, session, 'preview', force, metrics, freshSnapshot ? refreshIds : []);
      session.lastMetrics = metrics;
      if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'preview-tick', at: Date.now(), changed, metrics }));
      // Keep the configured poll period as a start-to-start interval. A device
      // capture is often slower than pollMs; waiting another full period after
      // it completes makes the preview unnecessarily stale after a tap.
      nextDelay = Math.max(0, pollMs - (performance.now() - startedAt));
    } catch (error) {
      if (!current()) return;
      if (captureController.signal.aborted || error.code === 'FRAME_SOURCE_RESET') {
        if (error.code === 'FRAME_SOURCE_RESET') {
          session.forceNext ||= force;
          for (const id of refreshIds) session.refreshIds.add(id);
        }
        session.failures = 0;
        nextDelay = 0;
      } else {
        nextDelay = Math.min(pollMs * (2 ** session.failures), backoffMaxMs);
        session.failures = Math.min(session.failures + 1, 30);
        session.lastHash = null;
        if (session.connected) {
          session.connected = false;
          socket.send(JSON.stringify({ type: 'preview-status', running: false, deviceId,
            reason: error.errorCode === 'DEVICE_OFFLINE' ? 'device-disconnected' : 'capture-failed', reconnecting: true,
            diagnostic: toDiagnostic(error, { errorCode: 'CAPTURE_FAILED', stage: 'capture', deviceId, elapsedMs: performance.now() - startedAt }) }));
        }
        const devices = await deviceAdapter.listTargets().catch(() => []);
        if (!current()) return;
        socket.send(JSON.stringify({ type: 'devices', devices }));
      }
    } finally {
      if (session.captureController === captureController) session.captureController = null;
    }
    session.inFlight = false;
    if (!current()) return;
    if (session.actionPaused) return;
    if (session.refreshRequested) {
      session.refreshRequested = false;
      queueMicrotask(poll);
    } else {
      session.timer = setTimeout(poll, nextDelay);
    }
  };
  session.requestNow = (requestId) => {
    if (!current()) return;
    session.forceNext = true;
    if (typeof requestId === 'string' && requestId.length <= 128) session.refreshIds.add(requestId);
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (session.inFlight) session.refreshRequested = true;
    else queueMicrotask(poll);
  };
  poll();
}

function stopPolling(socket, sessions, state) {
  if (state) { state.generation += 1; state.deviceId = null; }
  const session = sessions.get(socket);
  if (!session) return;
  session.stopped = true;
  session.captureController?.abort();
  if (session.timer) clearTimeout(session.timer);
  sessions.delete(socket);
}

function pausePolling(socket, sessions, state) {
  if (state) state.generation += 1;
  const session = sessions.get(socket);
  if (!session) return;
  session.stopped = true;
  session.captureController?.abort();
  if (session.timer) clearTimeout(session.timer);
  sessions.delete(socket);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(port, host, () => {
    console.log(`HarmonyOS Preview listening at http://${host}:${port}`);
  });
}

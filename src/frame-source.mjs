/**
 * The preview server consumes this small contract so a future MJPEG/H.264
 * source can replace the JPEG sampler without changing session handling.
 */
export function createFrameSource({ deviceAdapter, clock = () => performance.now(), now = () => new Date().toISOString(), previewScale: previewScaleOverride } = {}) {
  const previewSizes = new Map();
  const deviceSizes = new Map();
  const streams = new Map();
  const generations = new Map();
  const orientationInvalid = new Set();
  const rotations = new Map();
  const defaultScale = 0.75;
  const configuredScale = Number(previewScaleOverride ?? process.env.HARMONY_PREVIEW_SCALE ?? defaultScale);
  const previewScale = Number.isFinite(configuredScale) ? Math.min(1, Math.max(0.25, configuredScale)) : defaultScale;
  const fallbackCapabilities = {
    selected: 'jpeg',
    streaming: false,
    available: ['jpeg'],
    formats: {
      jpeg: { available: true, mode: 'snapshot_display' },
      mjpeg: { available: false, reason: 'device adapter exposes snapshot_display only' },
      h264: { available: false, reason: 'device adapter exposes snapshot_display only' }
    },
    fallback: 'jpeg'
  };
  return {
    name: typeof deviceAdapter?.openFrameStream === 'function' ? 'mjpeg' : 'jpeg',
    supportsStreaming: typeof deviceAdapter?.openFrameStream === 'function',
    supportsFreshCapture: typeof deviceAdapter?.capture === 'function',
    capabilities: fallbackCapabilities,
    async getCapabilities({ deviceId } = {}) {
      // Adapters may provide an explicit probe when a device transport gains a
      // long lived stream. Until then, report the known screenshot contract.
      if (typeof deviceAdapter?.getFrameSourceCapabilities !== 'function') {
        const streaming = typeof deviceAdapter?.openFrameStream === 'function';
        return {
          ...fallbackCapabilities,
          deviceId,
          selected: streaming ? 'mjpeg' : fallbackCapabilities.selected,
          streaming,
          available: streaming ? ['mjpeg', 'jpeg'] : fallbackCapabilities.available,
          formats: streaming ? { ...fallbackCapabilities.formats, mjpeg: { available: true, mode: 'device_stream' } } : fallbackCapabilities.formats
        };
      }
      const detected = await deviceAdapter.getFrameSourceCapabilities({ deviceId });
      if (!detected || typeof detected !== 'object') return { ...fallbackCapabilities, deviceId };
      return {
        ...fallbackCapabilities,
        ...detected,
        deviceId,
        available: Array.isArray(detected.available) ? detected.available : fallbackCapabilities.available,
        formats: { ...fallbackCapabilities.formats, ...(detected.formats ?? {}) },
        streaming: Boolean(detected.streaming || typeof deviceAdapter?.openFrameStream === 'function'),
        selected: detected.selected ?? (typeof deviceAdapter?.openFrameStream === 'function' ? 'mjpeg' : fallbackCapabilities.selected)
      };
    },
    async capture({ deviceId, signal, freshSnapshot = false } = {}) {
      if (!deviceAdapter || (typeof deviceAdapter.capture !== 'function' && typeof deviceAdapter.openFrameStream !== 'function')) {
        throw new TypeError('deviceAdapter.capture or deviceAdapter.openFrameStream is required');
      }
      if (freshSnapshot && typeof deviceAdapter.capture !== 'function') throw new Error('Fresh snapshots are unavailable');
      if (!generations.has(deviceId)) generations.set(deviceId, 0);
      const generation = generations.get(deviceId);
      const ensureCurrent = () => {
        if (generations.get(deviceId) !== generation) {
          throw Object.assign(new Error('Preview capture was reset'), { name: 'AbortError', code: 'FRAME_SOURCE_RESET' });
        }
      };
      const startedAt = clock();
      const size = previewSizes.get(deviceId);
      let frame;
      let source = 'jpeg';
      try {
        if (!freshSnapshot && typeof deviceAdapter.openFrameStream === 'function') {
          let stream = streams.get(deviceId);
          if (!stream) {
            stream = await deviceAdapter.openFrameStream({ deviceId, signal });
            if (generations.get(deviceId) !== generation) {
              stream?.close?.();
              ensureCurrent();
            }
            if (!stream || typeof stream.nextFrame !== 'function') throw new TypeError('openFrameStream must return nextFrame()');
            streams.set(deviceId, stream);
          }
          frame = await stream.nextFrame({ deviceId, signal });
          source = stream.source ?? 'mjpeg';
        } else {
          frame = await deviceAdapter.capture({ deviceId, ...(size ?? {}) }, { signal });
        }
      } catch (error) {
        ensureCurrent();
        throw error;
      }
      ensureCurrent();
      if (!frame || !frame.data) throw new Error(`${source} frame source returned no frame`);
      const dimensions = readJpegSize(frame.data);
      if (!deviceSizes.has(deviceId) && dimensions) deviceSizes.set(deviceId, dimensions);
      const orientationChanged = Boolean(size && dimensions &&
        (dimensions.width !== size.width || dimensions.height !== size.height));
      if (orientationChanged) orientationInvalid.add(deviceId);
      if (Number.isFinite(frame.rotation)) {
        if (frame.rotation === 0) rotations.delete(deviceId);
        else {
          orientationInvalid.add(deviceId);
          rotations.set(deviceId, frame.rotation);
        }
      }
      if (!size && dimensions) previewSizes.set(deviceId, {
        width: Math.max(1, Math.round(dimensions.width * previewScale)),
        height: Math.max(1, Math.round(dimensions.height * previewScale))
      });
      const deviceSize = deviceSizes.get(deviceId) ?? dimensions;
      return {
        frame,
        metrics: {
          source,
          mimeType: frame.mimeType,
          frameBytes: Buffer.isBuffer(frame.data) ? frame.data.byteLength : 0,
          ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {}),
          ...(deviceSize ? { deviceWidth: deviceSize.width, deviceHeight: deviceSize.height } : {}),
          scale: size ? previewScale : 1,
          ...(size ? { scaled: true, requestedWidth: size.width, requestedHeight: size.height } : { scaled: false }),
          ...(orientationInvalid.has(deviceId) ? { orientationChanged: true } : {}),
          ...(rotations.has(deviceId) ? { rotation: rotations.get(deviceId) } : {}),
          ...(frame.captureTiming ? { captureStages: { ...frame.captureTiming } } : {}),
          captureMs: Math.max(0, Math.round(clock() - startedAt)),
          capturedAt: frame.capturedAt ?? now()
        }
      };
    },
    reset({ deviceId } = {}) {
      const close = (key) => {
        const stream = streams.get(key);
        streams.delete(key);
        if (typeof stream?.close === 'function') stream.close();
      };
      const clear = (key) => {
        generations.set(key, (generations.get(key) ?? 0) + 1);
        close(key);
        previewSizes.delete(key);
        deviceSizes.delete(key);
        orientationInvalid.delete(key);
        rotations.delete(key);
      };
      if (deviceId) clear(deviceId);
      else for (const key of new Set([...generations.keys(), ...streams.keys(), ...previewSizes.keys(), ...deviceSizes.keys(), ...orientationInvalid.keys(), ...rotations.keys()])) clear(key);
    }
  };
}

function readJpegSize(data) {
  if (!Buffer.isBuffer(data) || data.length < 10 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  for (let offset = 2; offset + 9 < data.length;) {
    if (data[offset] !== 0xff) { offset += 1; continue; }
    const marker = data[offset + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
    if (offset + 4 > data.length) return null;
    const length = data.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > data.length) return null;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { width: data.readUInt16BE(offset + 7), height: data.readUInt16BE(offset + 5) };
    }
    offset += 2 + length;
  }
  return null;
}

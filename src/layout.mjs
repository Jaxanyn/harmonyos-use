import { tagError } from './diagnostics.mjs';

export const layoutWarnings = ['Only controls exposed by the device UI hierarchy are included; this does not prove that the full page or business workflow is available.'];

export function describeLayout({ totalNodes = 0, truncated = false } = {}) {
  const treeQuality = totalNodes === 0 ? 'empty' : truncated ? 'partial' : 'full';
  const customRendered = treeQuality !== 'full';
  const warnings = treeQuality === 'empty'
    ? ['No UITest nodes were exposed; custom-rendered or protected content may still be visible in the screenshot.']
    : treeQuality === 'partial'
      ? ['The UITest hierarchy was truncated; omitted or custom-rendered content may still be visible in the screenshot.']
      : [];
  return { treeQuality, fallback: 'none', customRendered, warnings };
}

export function flattenLayout(layout) {
  if (!layout || typeof layout !== 'object') throw new Error('device layout must be a JSON object or array');
  const stack = Array.isArray(layout) ? [...layout].reverse() : [layout];
  const nodes = [];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (node.attributes && typeof node.attributes === 'object' && !Array.isArray(node.attributes)) {
      const attributes = node.attributes;
      const bounds = parseBounds(attributes.bounds);
      const normalized = {
        id: String(attributes.id ?? ''),
        text: String(attributes.text ?? ''),
        type: String(attributes.type ?? ''),
        bounds
      };
      for (const field of ['clickable', 'enabled', 'focused', 'visible']) {
        const value = attributes[field] ?? (field === 'visible' ? attributes.visibleToUser : undefined);
        if (value === true || value === 'true') normalized[field] = true;
        if (value === false || value === 'false') normalized[field] = false;
      }
      if (bounds && bounds.right > bounds.left && bounds.bottom > bounds.top) {
        normalized.center = { x: Math.floor((bounds.left + bounds.right) / 2), y: Math.floor((bounds.top + bounds.bottom) / 2) };
      }
      nodes.push(normalized);
    }
    const children = Array.isArray(node.children) ? node.children : Array.isArray(node.windows) ? node.windows : [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
  }
  return nodes;
}

function parseBounds(value) {
  let points;
  if (typeof value === 'string') {
    const match = value.match(/^\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*$/);
    if (match) points = match.slice(1).map(Number);
  } else if (value && typeof value === 'object') {
    points = [value.left, value.top, value.right, value.bottom];
  }
  if (!points || !points.every(Number.isFinite)) return null;
  const [left, top, right, bottom] = points;
  if (left < 0 || top < 0 || right < left || bottom < top) return null;
  return { left, top, right, bottom };
}

export function validateSelector(selector) {
  const fields = ['text', 'textContains', 'id', 'type', 'clickable', 'enabled'];
  if (!selector || typeof selector !== 'object' || Array.isArray(selector) || !Object.keys(selector).length) {
    throw new Error('selector must contain at least one supported field');
  }
  for (const [field, value] of Object.entries(selector)) {
    if (!fields.includes(field)) throw new Error(`unsupported selector field: ${field}`);
    if (['clickable', 'enabled'].includes(field)) {
      if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
    } else if (typeof value !== 'string' || !value) throw new Error(`${field} must be a non-empty string`);
  }
}

export function matchesSelector(node, selector) {
  return Object.entries(selector).every(([field, value]) => field === 'textContains' ? node.text.includes(value) : node[field] === value);
}

export function requireTapTarget(found) {
  if (found?.totalMatches === 0) throw tagError(new Error('Tap selector has no exposed matching control'), 'ELEMENT_NOT_FOUND', 'tap_element');
  if (found?.totalMatches !== 1 || found.matches?.length !== 1) throw tagError(new Error('Tap selector must match exactly one current control'), 'ELEMENT_AMBIGUOUS', 'tap_element');
  const target = found.matches[0];
  if (target?.clickable !== true || target.enabled === false || target.visible === false) {
    throw tagError(new Error('Tap target is not an enabled, visible, clickable control'), 'ELEMENT_NOT_ACTIONABLE', 'tap_element');
  }
  const bounds = target.bounds;
  const center = target.center;
  if (!bounds || ![bounds.left, bounds.top, bounds.right, bounds.bottom].every(Number.isFinite) || bounds.left < 0 || bounds.top < 0 || bounds.right <= bounds.left || bounds.bottom <= bounds.top ||
      !center || ![center.x, center.y].every(Number.isFinite) || center.x < bounds.left || center.x >= bounds.right || center.y < bounds.top || center.y >= bounds.bottom) {
    throw tagError(new Error('Tap target has no valid bounds and center'), 'ELEMENT_NOT_ACTIONABLE', 'tap_element');
  }
  const ageMs = Date.now() - found.observedAt;
  if (!Number.isFinite(found.observedAt) || ageMs < 0 || ageMs > 1000) throw tagError(new Error('Tap target observation is stale; no action executed'), 'STALE_OBSERVATION', 'tap_element');
  return target;
}

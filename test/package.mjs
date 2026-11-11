import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { Script } from 'node:vm';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
assert.deepEqual(packageJson.files, ['README.md', 'bin', 'src', 'docs', 'skills', 'scripts']);
assert.equal(packageJson.bin['harmonyos-preview'], 'bin/harmonyos-preview.mjs');

const appResource = readFileSync(new URL('../src/app/resource.html', import.meta.url), 'utf8');
const appScript = appResource.match(/<script>([\s\S]*?)<\/script>/);
assert.ok(appScript, 'built app resource must contain its script');
assert.doesNotMatch(appScript[1], /<!-- APP_SCRIPT -->/, 'template marker must not be inserted into the bundled script');
assert.doesNotThrow(() => new Script(appScript[1]), 'built app script must be valid JavaScript');

const files = [
  'README.md',
  'bin/harmonyos-preview.mjs',
  'package.json',
  'src/build.mjs',
  'src/device.mjs',
  'src/diagnostics.mjs',
  'src/frame-source.mjs',
  'src/layout.mjs',
  'src/mcp.mjs',
  'src/project.mjs',
  'src/server.mjs',
  'docs/codex-usage.md',
  'skills/harmonyos-preview-codex/SKILL.md',
  'scripts/install-codex.ps1',
  'scripts/check-codex.mjs'
];
for (const file of files) assert.ok(existsSync(new URL('../' + file, import.meta.url)), file);
assert.ok(!files.some((file) => file.startsWith('test/') || file.startsWith('.runtime/')));
const workflow = readFileSync(new URL('../skills/harmonyos-preview-codex/SKILL.md', import.meta.url), 'utf8');
for (const tool of ['list_devices', 'build_run', 'preview_start', 'preview_info', 'capture', 'observe', 'find', 'wait_for', 'tap', 'tap_element', 'preview_stop', 'open_in_codex', 'right']) {
  assert.match(workflow, new RegExp(`\\b${tool}\\b`));
}
console.log('package: ok');

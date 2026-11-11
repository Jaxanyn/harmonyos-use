import { readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const templatePath = fileURLToPath(new URL('../src/app/index.html', import.meta.url));
const outputPath = fileURLToPath(new URL('../src/app/resource.html', import.meta.url));
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/app/main.mjs', import.meta.url))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  write: false,
  absWorkingDir: root,
});
const template = await readFile(templatePath, 'utf8');
const script = new TextDecoder().decode(bundle.outputFiles[0].contents);
if (!template.includes('<!-- APP_SCRIPT -->')) throw new Error('App template marker is missing');
await writeFile(outputPath, template.replace('<!-- APP_SCRIPT -->', () => `<script>${script}</script>`), 'utf8');
console.log(`app: built ${outputPath}`);

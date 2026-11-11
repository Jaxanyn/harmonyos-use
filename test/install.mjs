import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

if (process.platform !== 'win32') {
  console.log('install: skipped (Windows PowerShell installer)');
} else {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const script = join(root, 'scripts', 'install-codex.ps1');
  const project = join(root, 'test');
  const runInstaller = (args, env = process.env) => new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-ProjectPath', project, ...args], { windowsHide: true, env });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  const result = await runInstaller(['-CheckOnly', '-SkipDeviceCheck']);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Check complete/);
  const directory = await mkdtemp(join(tmpdir(), 'harmony install '));
  try {
    const hdc = join(directory, 'custom hdc.cmd');
    const codex = join(directory, 'fake codex.cmd');
    const recorder = join(directory, 'record.mjs');
    const log = join(directory, 'arguments.json');
    await writeFile(hdc, '@echo off\r\necho install-test-device\r\n');
    await writeFile(codex, `@echo off\r\nif "%1 %2"=="mcp get" exit /b 1\r\n"${process.execPath}" "${recorder}" %*\r\n`);
    await writeFile(recorder, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.HARMONY_INSTALL_TEST_LOG, JSON.stringify(process.argv.slice(2)));");
    for (const skipDeviceCheck of [false, true]) {
      const installed = await runInstaller(['-HdcCommand', hdc, '-CodexCommand', codex,
        ...(skipDeviceCheck ? ['-SkipDeviceCheck'] : ['-RequireDevice'])], { ...process.env, HARMONY_INSTALL_TEST_LOG: log });
      assert.equal(installed.code, 0, installed.stderr || installed.stdout);
      const args = JSON.parse(await readFile(log, 'utf8'));
      const envValues = args.filter((_, index) => args[index - 1] === '--env');
      assert.ok(envValues.includes(`HDC=${hdc}`), 'the checked custom HDC executable must reach the registered MCP process, including paths with spaces');
      assert.ok(envValues.includes(`HARMONY_PROJECT=${project}`));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  console.log('install: ok');
}

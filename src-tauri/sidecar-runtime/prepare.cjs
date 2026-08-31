const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const runtimeRoot = __dirname;
const lockPath = join(runtimeRoot, 'package-lock.json');
const nodeModulesPath = join(runtimeRoot, 'node_modules');
const stampPath = join(nodeModulesPath, '.streamee-package-lock.sha256');

if (!existsSync(lockPath)) {
  throw new Error(`Sidecar runtime lockfile is missing: ${lockPath}`);
}

const lockHash = createHash('sha256').update(readFileSync(lockPath)).digest('hex');
const installedLockHash = existsSync(stampPath)
  ? readFileSync(stampPath, 'utf8').trim()
  : '';

if (installedLockHash === lockHash) {
  console.log('Production-only stream sidecar dependencies are current.');
  process.exit(0);
}

console.log('Installing production-only stream sidecar dependencies.');
const npmCliPath = process.env.npm_execpath;
if (!npmCliPath) {
  throw new Error('npm_execpath is unavailable; run this preparation through npm.');
}
const install = spawnSync(
  process.execPath,
  [npmCliPath, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
  { cwd: runtimeRoot, stdio: 'inherit' },
);

if (install.error) {
  throw install.error;
}
if (install.status !== 0) {
  throw new Error(`Sidecar runtime npm ci failed with exit code ${install.status}.`);
}

writeFileSync(stampPath, `${lockHash}\n`);

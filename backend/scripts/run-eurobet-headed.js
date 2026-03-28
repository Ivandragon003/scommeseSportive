const path = require('node:path');
const { spawn } = require('node:child_process');

const env = { ...process.env };

env.EUROBET_PERSISTENT_PROFILE_ENABLED = env.EUROBET_PERSISTENT_PROFILE_ENABLED || 'true';
env.EUROBET_BROWSER_HEADLESS = env.EUROBET_BROWSER_HEADLESS || 'false';
env.EUROBET_BROWSER_CHANNEL = env.EUROBET_BROWSER_CHANNEL || 'chrome';
env.EUROBET_BROWSER_SLOW_MO = env.EUROBET_BROWSER_SLOW_MO || '150';
env.EUROBET_EVENT_CONCURRENCY = env.EUROBET_EVENT_CONCURRENCY || '1';
env.EUROBET_PROFILE_DIR = env.EUROBET_PROFILE_DIR || path.resolve(process.cwd(), '.playwright', 'eurobet-profile-host');

const tsNodeDevBin = require.resolve('ts-node-dev/lib/bin');
const child = spawn(
  process.execPath,
  [tsNodeDevBin, '--respawn', '--transpile-only', 'src/index.ts'],
  {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
  }
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

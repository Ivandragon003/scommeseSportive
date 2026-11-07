const { rmSync } = require('node:fs');
const { resolve, dirname } = require('node:path');

// tsc leaves removed/renamed modules behind. Those files would change the
// calibration fingerprint compared with a fresh CI or container build.
const backendRoot = resolve(__dirname, '..');
const target = resolve(backendRoot, 'dist');
if (dirname(target) !== backendRoot) throw new Error('Invalid build directory');
rmSync(target, { recursive: true, force: true });

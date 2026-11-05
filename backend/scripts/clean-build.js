const { rmSync, cpSync, readdirSync, readFileSync } = require('node:fs');
const { resolve, dirname, join, relative } = require('node:path');
const { createHash } = require('node:crypto');

// tsc leaves removed/renamed modules behind. Those files would change the
// calibration fingerprint compared with a fresh CI or container build.
const backendRoot = resolve(__dirname, '..');
const target = resolve(backendRoot, 'dist');
if (dirname(target) !== backendRoot) throw new Error('Invalid build directory');
const frozen = resolve(backendRoot, 'src/research/frozen/a-80cb25df');
const expected = JSON.parse(readFileSync(join(frozen, 'integrity.json'), 'utf8'));
function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(file) : entry.isFile() && entry.name.endsWith('.js') ? [file] : [];
  });
}
const actual = javascriptFiles(frozen).map(file => relative(frozen, file).replace(/\\/g, '/')).sort();
if (JSON.stringify(actual) !== JSON.stringify(Object.keys(expected).sort())) throw new Error('Frozen baseline file list changed');
for (const file of actual) {
  const hash = createHash('sha256').update(readFileSync(join(frozen, file))).digest('hex');
  if (hash !== expected[file]) throw new Error(`Frozen baseline integrity failure: ${file}`);
}
rmSync(target, { recursive: true, force: true });
// The frozen research baseline consists of release JS bytes, not TS output.
cpSync(resolve(backendRoot, 'src/research/frozen'), resolve(target, 'research/frozen'), { recursive: true });

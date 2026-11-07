const test = require('node:test');
const assert = require('node:assert/strict');
const { HOST, targetFor, argumentsOf } = require('../scripts/reset-challenger-production');

test('reset pins the canonical production host and rejects credentials or URL options', () => {
  for (const suffix of ['', '/']) {
    const result = targetFor({ '--expected-host': HOST }, { TURSO_DATABASE_URL: `libsql://${HOST}${suffix}`, TURSO_AUTH_TOKEN: 'test' });
    assert.deepEqual(result.identity, { kind: 'production', host: HOST });
  }
  for (const url of [`libsql://other.turso.io`, `libsql://${HOST}/other`, `libsql://${HOST}?a=1`, `https://user:pass@${HOST}/`, `http://${HOST}/`]) {
    assert.throws(() => targetFor({ '--expected-host': HOST }, { TURSO_DATABASE_URL: url }), /unexpected_production_target/);
  }
  assert.throws(() => targetFor({}, { TURSO_DATABASE_URL: `libsql://${HOST}` }), /unexpected_production_target/);
});

test('reset requires exactly one explicit mode and rejects unknown or duplicate options', () => {
  assert.deepEqual(argumentsOf(['--plan', 'new.json']), { '--plan': 'new.json' });
  for (const args of [[], ['--plan', 'a', '--apply', 'b'], ['--plan', 'a', '--plan', 'b'], ['--plan'], ['--yes', 'true']]) {
    assert.throws(() => argumentsOf(args));
  }
});
